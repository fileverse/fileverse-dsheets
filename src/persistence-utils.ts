import { fromUint8Array, toUint8Array } from 'js-base64';
import * as Y from 'yjs';

export const DEFAULT_DSHEET_PERSISTENCE_TIMEOUT_MS = 8_000;

export type DSheetContentStatus =
  | 'available'
  | 'empty'
  | 'missing'
  | 'corrupt'
  | 'timed-out'
  | 'unavailable';

export type DSheetContentSnapshot = {
  dsheetId: string;
  status: DSheetContentStatus;
  encodedState: string | null;
  stateVector: string | null;
  error?: Error;
};

export type DSheetContentReadOptions = {
  timeoutMs?: number;
};

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

/**
 * Apply a full dSheet artifact without rebuilding its shared types. Keeping the
 * original Yjs structs is required for independently bootstrapped peers to
 * converge instead of inserting duplicate workbook data.
 */
export const mergeDsheetEncodedContent = (
  doc: Y.Doc,
  encodedState: string,
  origin: unknown = 'dsheet-package-ingress',
): boolean => {
  const update = toUint8Array(encodedState);
  const validationDoc = new Y.Doc();
  try {
    Y.applyUpdate(validationDoc, update);
  } finally {
    validationDoc.destroy();
  }

  let changed = false;
  const onUpdate = () => {
    changed = true;
  };
  doc.on('update', onUpdate);
  try {
    Y.applyUpdate(doc, update, origin);
    return changed;
  } finally {
    doc.off('update', onUpdate);
  }
};

export const withDsheetPersistenceTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('dSheet IndexedDB operation timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const unavailableDsheetContentSnapshot = (
  dsheetId: string,
  status: Exclude<DSheetContentStatus, 'available' | 'empty'>,
  error?: unknown,
): DSheetContentSnapshot => ({
  dsheetId,
  status,
  encodedState: null,
  stateVector: null,
  ...(error ? { error: toError(error) } : {}),
});

export const snapshotDsheetDocument = (
  dsheetId: string,
  doc: Y.Doc,
): DSheetContentSnapshot => {
  const state = Y.encodeStateAsUpdate(doc);
  return {
    dsheetId,
    status: state.length <= 2 ? 'empty' : 'available',
    encodedState: fromUint8Array(state),
    stateVector: fromUint8Array(Y.encodeStateVector(doc)),
  };
};

export const mergeDsheetContentIntoDocument = (
  dsheetId: string,
  encodedState: string,
  doc: Y.Doc | null,
): DSheetContentSnapshot => {
  if (!doc) {
    return unavailableDsheetContentSnapshot(
      dsheetId,
      'unavailable',
      new Error('dSheet document is not ready'),
    );
  }

  try {
    mergeDsheetEncodedContent(doc, encodedState, 'dsheet-package-ingress');
    return snapshotDsheetDocument(dsheetId, doc);
  } catch (error) {
    return unavailableDsheetContentSnapshot(dsheetId, 'corrupt', error);
  }
};
