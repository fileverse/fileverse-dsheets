import * as Y from 'yjs';
import type { IndexeddbPersistence } from 'y-indexeddb';

const UPDATES_STORE = 'updates';

/**
 * y-indexeddb appends a FULL copy of the doc every time a provider is attached
 * to a Y.Doc that already holds content, and only trims after 500 rows. dSheet
 * attaches to pre-filled docs on every open (published content, remote merges),
 * so the store grows by one full copy per open and every load replays them all.
 *
 * This collapses the store into a single row. It runs in ONE readwrite
 * transaction and merges every stored row (not just this provider's doc), so
 * rows written by another tab/provider in the meantime are never lost.
 *
 * Returns the number of rows removed (0 when nothing needed compacting).
 */
export const compactDsheetPersistence = async (
  persistence: IndexeddbPersistence,
  minRows = 2,
): Promise<number> => {
  if (persistence._destroyed) return 0;
  const db = await persistence._db;
  if (!db.objectStoreNames.contains(UPDATES_STORE)) return 0;

  const removed = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction(UPDATES_STORE, 'readwrite');
    const store = tx.objectStore(UPDATES_STORE);
    let result = 0;

    const keysReq = store.getAllKeys();
    keysReq.onsuccess = () => {
      const keys = keysReq.result;
      if (keys.length < minRows) return;
      const rowsReq = store.getAll();
      rowsReq.onsuccess = () => {
        const rows = (rowsReq.result as unknown[]).filter(
          (row): row is Uint8Array => row instanceof Uint8Array,
        );
        const merged = Y.mergeUpdates([
          ...rows,
          Y.encodeStateAsUpdate(persistence.doc),
        ]);
        const lastKey = keys[keys.length - 1];
        // Delete the old rows first, then write the merged one. Both happen
        // in this transaction, so a failure rolls back to the original rows.
        store.delete(IDBKeyRange.upperBound(lastKey));
        store.add(merged);
        result = keys.length;
      };
    };

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('compaction aborted'));
  });

  if (removed > 0) persistence._dbsize = 1;
  return removed;
};
