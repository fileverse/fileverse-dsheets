import type * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { waitForPersistenceSynced } from './wait-for-sync';

/**
 * Delete an IndexedDB database. Resolves when deleted, and also when the
 * delete is blocked by another open connection (another tab): the delete then
 * completes once that connection closes, and waiting would hang the caller.
 */
const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      resolve();
      return;
    }
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB delete failed'));
    request.onblocked = () => resolve();
  });

/**
 * D3: rebuild the local IndexedDB store from the live document.
 *
 * Destroys `current`, deletes the database, then attaches a new provider to
 * the SAME live Y.Doc, so y-indexeddb writes the full current state as one
 * fresh row. `onCreated` runs right after the new provider is constructed,
 * before it has synced, so the caller can track it and attach listeners. The Y.Doc is never replaced or cleared. Unlike delete-and-reopen
 * (heal), edits that exist only in the live doc are kept.
 *
 * The wait for the new provider is bounded: `whenSynced` never rejects, and a
 * provider destroyed before its first read (a bootstrap restarting meanwhile)
 * never syncs. It rejects on `timeoutMs` or once `isCurrent()` is false.
 */
export async function rebuildIndexedDbStore(
  dsheetId: string,
  doc: Y.Doc,
  current: IndexeddbPersistence | null,
  onCreated?: (provider: IndexeddbPersistence) => void,
  syncOptions?: { timeoutMs?: number; isCurrent?: () => boolean },
): Promise<IndexeddbPersistence> {
  if (current) {
    try {
      await current.destroy();
    } catch {
      // The old provider is being discarded; a failed close must not block.
    }
  }
  await deleteDatabase(dsheetId);
  const next = new IndexeddbPersistence(dsheetId, doc);
  onCreated?.(next);
  try {
    await waitForPersistenceSynced(next, syncOptions);
  } catch (error) {
    await next.destroy().catch(() => {});
    throw error;
  }
  return next;
}
