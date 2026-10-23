import { describe, expect, it } from 'vitest';
import {
  patchPlainCelldata,
  type CelldataPatch,
  type PlainCelldataEntry,
} from './patch-plain-celldata';

/** The pre-A5 algorithm: one findIndex per changed key. */
const reference = (
  celldata: PlainCelldataEntry[],
  patches: CelldataPatch[],
) => {
  for (const { key, action, v } of patches) {
    const sep = key.lastIndexOf('_');
    const r = parseInt(key.slice(0, sep), 10);
    const c = parseInt(key.slice(sep + 1), 10);
    const idx = celldata.findIndex((cell) => cell.r === r && cell.c === c);
    if (action === 'delete') {
      if (idx >= 0) celldata.splice(idx, 1);
      continue;
    }
    const entry = { r, c, v: v ?? null };
    if (idx >= 0) celldata[idx] = entry;
    else celldata.push(entry);
  }
};

const sortKey = (e: PlainCelldataEntry) => e.r * 1000 + e.c;
const sorted = (arr: PlainCelldataEntry[]) =>
  [...arr].sort((a, b) => sortKey(a) - sortKey(b));

describe('patchPlainCelldata (A5)', () => {
  it('matches the findIndex algorithm on randomized batches', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 200; round += 1) {
      const base: PlainCelldataEntry[] = [];
      for (let i = 0; i < 60; i += 1) {
        if (rand() < 0.5) base.push({ r: Math.floor(i / 6), c: i % 6, v: i });
      }
      // Keys are unique within one batch, as in a Yjs map event.
      const keys = new Set<string>();
      while (keys.size < 15) {
        keys.add(`${Math.floor(rand() * 12)}_${Math.floor(rand() * 6)}`);
      }
      const patches: CelldataPatch[] = [...keys].map((key) =>
        rand() < 0.4
          ? { key, action: 'delete' }
          : { key, action: 'update', v: { v: `n${round}` } },
      );
      const a = base.map((e) => ({ ...e }));
      const b = base.map((e) => ({ ...e }));
      reference(a, patches);
      patchPlainCelldata(b, patches);
      expect(sorted(b)).toEqual(sorted(a));
    }
  });

  it('keeps untouched entries in their order', () => {
    const celldata: PlainCelldataEntry[] = [
      { r: 0, c: 0, v: 'a' },
      { r: 1, c: 0, v: 'b' },
      { r: 2, c: 0, v: 'c' },
    ];
    patchPlainCelldata(celldata, [
      { key: '1_0', action: 'delete' },
      { key: '0_0', action: 'update', v: 'A' },
      { key: '5_5', action: 'update', v: 'new' },
    ]);
    expect(celldata).toEqual([
      { r: 0, c: 0, v: 'A' },
      { r: 2, c: 0, v: 'c' },
      { r: 5, c: 5, v: 'new' },
    ]);
  });
});
