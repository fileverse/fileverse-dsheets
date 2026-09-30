import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { mergeStoredRows } from './persistence-compaction';

// Simulates the legacy y-indexeddb store: one full copy of the doc per open,
// with cell rewrites in between (the overwritten values are deleted content).
const buildLegacyStore = (copies = 8, cellsPerCopy = 500) => {
  const doc = new Y.Doc();
  const cells = doc.getMap('cells');
  const rows: Uint8Array[] = [];
  for (let copy = 0; copy < copies; copy++) {
    doc.transact(() => {
      for (let i = 0; i < cellsPerCopy; i++) {
        cells.set(`c${i}`, `value-${copy}-${i}-${'x'.repeat(20)}`);
      }
    });
    rows.push(Y.encodeStateAsUpdate(doc));
  }
  return { doc, rows };
};

const load = (update: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
};

describe('mergeStoredRows', () => {
  it('shrinks a bloated store to the size of the live doc', () => {
    const { doc, rows } = buildLegacyStore();
    const state = Y.encodeStateAsUpdate(doc);
    const merged = mergeStoredRows(state, rows);

    expect(merged.byteLength).toBe(state.byteLength);
    // Rows-first (the old order) would keep the deleted content.
    expect(Y.mergeUpdates([...rows, state]).byteLength).toBeGreaterThan(
      state.byteLength * 2,
    );
  });

  it('stays the same size on later opens', () => {
    const { doc, rows } = buildLegacyStore();
    const state = Y.encodeStateAsUpdate(doc);
    const first = mergeStoredRows(state, rows);
    const second = mergeStoredRows(state, [first]);
    expect(second.byteLength).toBe(first.byteLength);
  });

  it('loads to identical content with no pending structs', () => {
    const { doc, rows } = buildLegacyStore();
    const loaded = load(mergeStoredRows(Y.encodeStateAsUpdate(doc), rows));
    expect(loaded.getMap('cells').toJSON()).toEqual(
      doc.getMap('cells').toJSON(),
    );
    expect(loaded.store.pendingStructs).toBeNull();
    expect(loaded.store.pendingDs).toBeNull();
  });

  it('keeps rows from another tab this doc never saw', () => {
    const { doc, rows } = buildLegacyStore(3, 50);
    const other = load(Y.encodeStateAsUpdate(doc));
    other.getMap('cells').set('fromOtherTab', 'kept');
    const otherRow = Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc));

    const loaded = load(
      mergeStoredRows(Y.encodeStateAsUpdate(doc), [...rows, otherRow]),
    );
    expect(loaded.getMap('cells').get('fromOtherTab')).toBe('kept');
  });
});
