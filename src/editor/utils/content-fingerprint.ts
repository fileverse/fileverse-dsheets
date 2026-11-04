import * as Y from 'yjs';
import { fromUint8Array } from 'js-base64';

/**
 * Cheap "did the document change" signal (Stabilize A1 / D6).
 *
 * fingerprint = base64(state vector) + ":" + deletedCount
 *
 * A state vector alone misses delete-only transactions (clearing a filter,
 * dropdown, conditional format, sub-sheet or named range; undo of a typed
 * value), because a Yjs delete adds no item. deletedCount is the total length
 * of all deleted ranges in the document, kept as a running count so no full
 * scan is needed per check. Compare fingerprints with === only.
 */
export type ContentFingerprintTracker = {
  getFingerprint(): string;
  getDeletedCount(): number;
  dispose(): void;
};

// yjs does not export the DeleteSet class type.
type DeleteSet = ReturnType<typeof Y.createDeleteSetFromStructStore>;

const sumDeleteSet = (ds: DeleteSet) => {
  let total = 0;
  ds.clients.forEach((items) => {
    for (let i = 0; i < items.length; i += 1) total += items[i].len;
  });
  return total;
};

/**
 * Deleted units a transaction added to the document:
 * - items that existed before it and were deleted by it (tr.deleteSet entries
 *   below the client's beforeState clock), and
 * - deleted structs it integrated (clocks in [beforeState, afterState)). This
 *   covers items created and deleted in the same transaction, and GC structs
 *   arriving in a loaded body or merged update, which never enter
 *   tr.deleteSet.
 */
const deletedUnitsAdded = (tr: Y.Transaction) => {
  let added = 0;
  tr.deleteSet.clients.forEach((items, client) => {
    const before = tr.beforeState.get(client) ?? 0;
    for (let i = 0; i < items.length; i += 1) {
      const { clock, len } = items[i];
      if (clock < before) added += Math.min(clock + len, before) - clock;
    }
  });
  tr.afterState.forEach((after, client) => {
    const before = tr.beforeState.get(client) ?? 0;
    if (after <= before) return;
    const structs = tr.doc.store.clients.get(client);
    if (!structs) return;
    for (
      let i = Y.findIndexSS(structs, before);
      i < structs.length && structs[i].id.clock < after;
      i += 1
    ) {
      const struct = structs[i];
      if (!struct.deleted) continue;
      const start = Math.max(struct.id.clock, before);
      const end = Math.min(struct.id.clock + struct.length, after);
      added += end - start;
    }
  });
  return added;
};

/**
 * Attach when the Y.Doc is created, before any provider writes to it, so the
 * count is built from transactions. Attaching later costs one full scan.
 */
export function attachContentFingerprint(
  doc: Y.Doc,
): ContentFingerprintTracker {
  let deletedCount =
    doc.store.clients.size === 0
      ? 0
      : sumDeleteSet(Y.createDeleteSetFromStructStore(doc.store));
  const onAfterTransaction = (tr: Y.Transaction) => {
    deletedCount += deletedUnitsAdded(tr);
  };
  doc.on('afterTransaction', onAfterTransaction);
  return {
    getFingerprint: () =>
      `${fromUint8Array(Y.encodeStateVector(doc))}:${deletedCount}`,
    getDeletedCount: () => deletedCount,
    dispose: () => doc.off('afterTransaction', onAfterTransaction),
  };
}

/**
 * Same value as a live tracker, for a stored body or a merge of raw rows.
 * Builds a temporary document and scans its delete set, as getDsheetStateVector
 * builds one. Reading the delete ranges from the encoded update instead
 * (Y.decodeUpdate) misses GC structs that arrive without a delete range, e.g.
 * a row written when the document received a compacted body.
 */
export function fingerprintFromUpdate(update: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return fingerprintFromDocument(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Same value as a live tracker, computed from a document by one scan of its
 * delete set (under 1.5 ms at 100k cells). Used by the body reads, which
 * already build a document from every IndexedDB row, so GC structs that
 * arrived without a delete range are counted.
 */
export function fingerprintFromDocument(doc: Y.Doc): string {
  const count =
    doc.store.clients.size === 0
      ? 0
      : sumDeleteSet(Y.createDeleteSetFromStructStore(doc.store));
  return `${fromUint8Array(Y.encodeStateVector(doc))}:${count}`;
}
