import { fromUint8Array, toUint8Array } from 'js-base64';
import * as Y from 'yjs';
import { clearDocument, IndexeddbPersistence } from 'y-indexeddb';

import {
  DEFAULT_DSHEET_PERSISTENCE_TIMEOUT_MS,
  snapshotDsheetDocument,
  unavailableDsheetContentSnapshot,
  withDsheetPersistenceTimeout,
  type DSheetContentReadOptions,
  type DSheetContentSnapshot,
  type DSheetContentStatus,
} from './persistence-utils';

export type {
  DSheetContentReadOptions,
  DSheetContentSnapshot,
  DSheetContentStatus,
} from './persistence-utils';

const pendingReads = new Map<string, Promise<DSheetContentSnapshot>>();

export const getDsheetStateVector = (
  encodedState: string | Uint8Array,
): string => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(
      doc,
      typeof encodedState === 'string'
        ? toUint8Array(encodedState)
        : encodedState,
    );
    return fromUint8Array(Y.encodeStateVector(doc));
  } finally {
    doc.destroy();
  }
};

const readDatabase = (
  dsheetId: string,
  timeoutMs: number,
): Promise<DSheetContentSnapshot> =>
  new Promise((resolve) => {
    const doc = new Y.Doc();
    let database: IDBDatabase | null = null;
    let transaction: IDBTransaction | null = null;
    let settled = false;
    let createdByRead = false;

    const finish = (snapshot: DSheetContentSnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      database?.close();
      doc.destroy();
      resolve(snapshot);
    };

    const fail = (
      status: Exclude<DSheetContentStatus, 'available' | 'empty'>,
      error?: unknown,
    ) => finish(unavailableDsheetContentSnapshot(dsheetId, status, error));

    const timeout = setTimeout(() => {
      try {
        transaction?.abort();
      } catch {
        // The transaction may already be complete.
      }
      fail('timed-out', new Error('dSheet IndexedDB read timed out'));
    }, timeoutMs);

    let openRequest: IDBOpenDBRequest;
    try {
      openRequest = indexedDB.open(dsheetId);
    } catch (error) {
      fail('unavailable', error);
      return;
    }

    openRequest.onupgradeneeded = () => {
      createdByRead = true;
      openRequest.transaction?.abort();
    };
    openRequest.onerror = () => {
      if (createdByRead) {
        finish(unavailableDsheetContentSnapshot(dsheetId, 'missing'));
      } else {
        fail('unavailable', openRequest.error);
      }
    };
    openRequest.onsuccess = () => {
      database = openRequest.result;
      if (
        !database.objectStoreNames.contains('updates') ||
        !database.objectStoreNames.contains('custom')
      ) {
        fail('corrupt', new Error('dSheet IndexedDB schema is invalid'));
        return;
      }

      try {
        transaction = database.transaction('updates', 'readonly');
        const request = transaction.objectStore('updates').getAll();
        request.onerror = () => fail('unavailable', request.error);
        request.onsuccess = () => {
          try {
            for (const update of request.result ?? []) {
              if (!(update instanceof Uint8Array)) {
                throw new Error('dSheet IndexedDB contains a non-Yjs update');
              }
              Y.applyUpdate(doc, update);
            }
          } catch (error) {
            fail('corrupt', error);
          }
        };
        transaction.oncomplete = () =>
          finish(snapshotDsheetDocument(dsheetId, doc));
        transaction.onabort = () => {
          if (!settled) fail('unavailable', transaction?.error);
        };
        transaction.onerror = () => {
          if (!settled) fail('unavailable', transaction?.error);
        };
      } catch (error) {
        fail('unavailable', error);
      }
    };
  });

const readFreshSnapshot = async (
  dsheetId: string,
  timeoutMs: number,
): Promise<DSheetContentSnapshot> => {
  if (typeof indexedDB === 'undefined') {
    return unavailableDsheetContentSnapshot(
      dsheetId,
      'unavailable',
      new Error('IndexedDB is unavailable'),
    );
  }

  const factory = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };
  if (factory.databases) {
    try {
      const databases = await factory.databases();
      if (!databases.some((database) => database.name === dsheetId)) {
        return unavailableDsheetContentSnapshot(dsheetId, 'missing');
      }
    } catch {
      // Safari does not consistently support indexedDB.databases().
    }
  }

  return readDatabase(dsheetId, timeoutMs);
};

/**
 * Read the package-owned Y-IndexedDB database without attaching another
 * persistence writer. Completed reads are never cached.
 */
export const readDsheetContent = (
  dsheetId: string,
  options: DSheetContentReadOptions = {},
): Promise<DSheetContentSnapshot> => {
  const inFlight = pendingReads.get(dsheetId);
  if (inFlight) return inFlight;

  const pending = readFreshSnapshot(
    dsheetId,
    options.timeoutMs ?? DEFAULT_DSHEET_PERSISTENCE_TIMEOUT_MS,
  ).finally(() => {
    if (pendingReads.get(dsheetId) === pending) pendingReads.delete(dsheetId);
  });
  pendingReads.set(dsheetId, pending);
  return pending;
};

/** Merge content into the package-owned Y-IndexedDB document. */
export const mergeDsheetContent = async (
  dsheetId: string,
  encodedState: string,
  options: DSheetContentReadOptions = {},
): Promise<DSheetContentSnapshot> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DSHEET_PERSISTENCE_TIMEOUT_MS;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, toUint8Array(encodedState), 'dsheet-package-ingress');
  } catch (error) {
    doc.destroy();
    return unavailableDsheetContentSnapshot(dsheetId, 'corrupt', error);
  }

  let persistence: IndexeddbPersistence | null = null;
  try {
    persistence = new IndexeddbPersistence(dsheetId, doc);
    await withDsheetPersistenceTimeout(persistence.whenSynced, timeoutMs);
    return snapshotDsheetDocument(dsheetId, doc);
  } catch (error) {
    return unavailableDsheetContentSnapshot(
      dsheetId,
      /timed out/i.test(String(error)) ? 'timed-out' : 'unavailable',
      error,
    );
  } finally {
    await persistence?.destroy().catch(() => {});
    doc.destroy();
  }
};

export const deleteDsheetContent = async (dsheetId: string): Promise<void> => {
  pendingReads.delete(dsheetId);
  if (typeof indexedDB !== 'undefined') await clearDocument(dsheetId);
};
