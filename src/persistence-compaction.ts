import * as Y from 'yjs';
import type { IndexeddbPersistence } from 'y-indexeddb';

const UPDATES_STORE = 'updates';

/**
 * Merges the live doc state with the rows already in the store.
 *
 * Order matters: when two inputs cover the same struct, Y.mergeUpdates keeps
 * the FIRST one. The live doc already holds deleted cells as GC'd structs,
 * while old rows still carry their full content. Putting the doc state first
 * lets the GC'd version win, so bloated stores actually shrink. Rows only add
 * what this doc has never seen (e.g. writes from another tab).
 */
export const mergeStoredRows = (
  docState: Uint8Array,
  rows: Uint8Array[],
): Uint8Array => Y.mergeUpdates([docState, ...rows]);

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
  // Uses the public `whenSynced`/`db` where possible. `_destroyed` and
  // `_dbsize` are y-indexeddb internals (typed in its d.ts, pinned with ~ in
  // package.json); both are read defensively so a rename degrades to "no
  // compaction" or "trim a bit late", never to data loss.
  if (persistence._destroyed) return 0;
  await persistence.whenSynced;
  const db = persistence.db;
  if (!db || !db.objectStoreNames.contains(UPDATES_STORE)) return 0;

  const removed = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction(UPDATES_STORE, 'readwrite');
    const store = tx.objectStore(UPDATES_STORE);
    let result = 0;
    let rowCount = -1;

    const keysReq = store.getAllKeys();
    keysReq.onsuccess = () => {
      const keys = keysReq.result;
      if (keys.length < minRows) return;
      const rowsReq = store.getAll();
      rowsReq.onsuccess = () => {
        const rows = (rowsReq.result as unknown[]).filter(
          (row): row is Uint8Array => row instanceof Uint8Array,
        );
        // The range delete below removes every key up to lastKey, so a row we
        // could not merge would be lost. Skip compaction instead.
        if (rows.length !== keys.length) return;
        const merged = mergeStoredRows(
          Y.encodeStateAsUpdate(persistence.doc),
          rows,
        );
        const lastKey = keys[keys.length - 1];
        // Delete the old rows first, then write the merged one. Both happen
        // in this transaction, so a failure rolls back to the original rows.
        store.delete(IDBKeyRange.upperBound(lastKey));
        store.add(merged);
        result = keys.length;
        // Count inside this transaction, like y-indexeddb does after its own
        // trim, so rows another writer added before us are included.
        const countReq = store.count();
        countReq.onsuccess = () => {
          rowCount = countReq.result;
        };
      };
    };

    tx.oncomplete = () => {
      // Set synchronously on complete: any later write by this provider runs
      // in a later transaction and increments _dbsize on top of this value.
      if (rowCount >= 0 && typeof persistence._dbsize === 'number') {
        persistence._dbsize = rowCount;
      }
      resolve(result);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('compaction aborted'));
  });

  return removed;
};
