/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { produce } from 'immer';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import {
  applyRemoteCellValue,
  applyRemoteCells,
  setSheetCalcChain,
} from './cell';

const makeCtx = () => {
  const ctx: any = defaultContext({
    globalCache: { undoList: [], redoList: [] },
    cellInput: { current: null },
    fxInput: { current: null },
    canvas: { current: null },
    cellArea: { current: null },
    workbookContainer: { current: null },
  } as any);
  const data = Array.from({ length: 6 }, (_, r) =>
    Array.from({ length: 4 }, (__, c) =>
      (r + c) % 3 === 0 ? { v: `${r}${c}`, m: `${r}${c}` } : null,
    ),
  );
  ctx.luckysheetfile = [
    {
      id: 's1',
      name: 'Sheet1',
      order: 0,
      status: 1,
      data,
      config: {},
      calcChain: [],
    },
  ];
  ctx.currentSheetId = 's1';
  return ctx;
};

const cells = [
  { r: 0, c: 0, v: null },
  { r: 1, c: 1, v: { v: 'remote', m: 'remote' } },
  { r: 5, c: 3, v: { v: 7, m: '7', ct: { fa: 'General', t: 'n' } } },
  { r: 2, c: 2, v: { f: '=1+1', v: 2, m: '2' } },
];

describe('applyRemoteCells (A5)', () => {
  beforeAll(() => loadLocale('en'));

  it('gives the same sheet as one applyRemoteCellValue update per cell', () => {
    let perCell = makeCtx();
    for (const { r, c, v } of cells) {
      perCell = produce<any>(perCell, (d: any) =>
        applyRemoteCellValue(d, r, c, v, { id: 's1' }),
      );
    }
    const batched = produce<any>(makeCtx(), (d: any) =>
      applyRemoteCells(d, cells, { id: 's1' }),
    );
    expect(batched.luckysheetfile[0].data).toEqual(
      perCell.luckysheetfile[0].data,
    );
    expect(batched.luckysheetfile[0].calcChain).toEqual(
      perCell.luckysheetfile[0].calcChain,
    );
  });

  it('reports a failing cell and still applies the rest', () => {
    const onSkip = vi.fn();
    const next = produce<any>(makeCtx(), (d: any) =>
      applyRemoteCells(
        d,
        [{ r: Number.NaN as any, c: 0, v: 1 }, ...cells.slice(1, 2)],
        { id: 's1' },
        onSkip,
      ),
    );
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(next.luckysheetfile[0].data[1][1]?.v).toBe('remote');
  });
});

describe('setSheetCalcChain (A4)', () => {
  it('resets the dependency indexes when the chain diff cannot be computed', () => {
    const ctx = makeCtx();
    ctx.formulaCache.depsByCell.set('s1:0:1', new Set(['s1:0:0']));
    ctx.formulaCache.revDepsByCell.set('s1:0:0', new Set(['s1:0:1']));
    ctx.formulaCache.formulasWithWideRangeDeps.add('s1:3:3');
    const chain = [{ r: 0, c: 1, id: 's1' }, null] as any;
    const next = produce<any>(ctx, (d: any) =>
      setSheetCalcChain(d, chain, { id: 's1' }),
    );
    expect(next.luckysheetfile[0].calcChain).toEqual(chain);
    expect(next.formulaCache.depsByCell.size).toBe(0);
    expect(next.formulaCache.revDepsByCell.size).toBe(0);
    expect(next.formulaCache.formulasWithWideRangeDeps.size).toBe(0);
    expect(next.formulaCache.depGraphComplete).toBe(false);
  });

  // C8 spec change (2026-10-29): only the entries that changed are updated.
  describe('chain diff', () => {
    const base = () => {
      const ctx = makeCtx();
      const data = ctx.luckysheetfile[0].data;
      data[3][0] = { f: '=A1+B1', v: 1, m: '1' };
      data[4][0] = { f: '=C1', v: 1, m: '1' };
      ctx.luckysheetfile[0].calcChain = [{ r: 3, c: 0, id: 's1' }];
      // Edges recorded for the existing entry.
      ctx.formulaCache.depsByCell.set('s1:3:0', new Set(['s1:0:0', 's1:0:1']));
      ctx.formulaCache.revDepsByCell.set('s1:0:0', new Set(['s1:3:0']));
      ctx.formulaCache.revDepsByCell.set('s1:0:1', new Set(['s1:3:0']));
      ctx.formulaCache.depGraphComplete = true;
      return ctx;
    };
    const set = (ctx: any, chain: any[]) =>
      produce<any>(ctx, (d: any) => setSheetCalcChain(d, chain, { id: 's1' }));

    it('adds the edges of an added entry and keeps the others and the flag', () => {
      const next = set(base(), [
        { r: 3, c: 0, id: 's1' },
        { r: 4, c: 0, id: 's1' },
      ]);
      expect([...next.formulaCache.revDepsByCell.get('s1:0:2')]).toEqual(['s1:4:0']);
      expect([...next.formulaCache.revDepsByCell.get('s1:0:0')]).toEqual(['s1:3:0']);
      expect(next.formulaCache.depGraphComplete).toBe(true);
    });

    it('drops the edges of a removed entry', () => {
      const next = set(base(), []);
      expect(next.formulaCache.depsByCell.has('s1:3:0')).toBe(false);
      expect(next.formulaCache.revDepsByCell.size).toBe(0);
      expect(next.formulaCache.depGraphComplete).toBe(true);
    });

    it('treats an added entry whose cell is not here yet as always-run', () => {
      const next = set(base(), [
        { r: 3, c: 0, id: 's1' },
        { r: 5, c: 3, id: 's1' },
      ]);
      expect(next.formulaCache.formulasWithWideRangeDeps.has('s1:5:3')).toBe(true);
      expect(next.formulaCache.wideRangesByFormula.has('s1:5:3')).toBe(false);
      expect(next.formulaCache.depGraphComplete).toBe(true);
    });
  });

  // PR 466 review (#17): Yjs hands out the objects it stores; Immer must not
  // freeze them.
  it('gives the engine copies, so the caller\'s objects stay unfrozen', () => {
    const entry = { r: 0, c: 1, id: 's1' };
    const chain = [entry];
    const next = produce<any>(makeCtx(), (d: any) =>
      setSheetCalcChain(d, chain, { id: 's1' }),
    );
    expect(next.luckysheetfile[0].calcChain).toEqual([entry]);
    expect(next.luckysheetfile[0].calcChain[0]).not.toBe(entry);
    expect(Object.isFrozen(entry)).toBe(false);
    expect(Object.isFrozen(next.luckysheetfile[0].calcChain[0])).toBe(true);
  });

  it('treats a missing chain as empty', () => {
    const next = produce<any>(makeCtx(), (d: any) =>
      setSheetCalcChain(d, undefined, { id: 's1' }),
    );
    expect(next.luckysheetfile[0].calcChain).toEqual([]);
  });
});

// PR 466 review (#10) and the C8 spec change (2026-10-29): a collaborator's
// formula keeps depGraphComplete; its cell's edges are replaced from its text.
describe('remote formula cells and depGraphComplete (C8)', () => {
  const withFormula = () => {
    const ctx = makeCtx();
    ctx.luckysheetfile[0].data[2][2] = { f: '=A1+B1', v: 2, m: '2' };
    ctx.luckysheetfile[0].calcChain = [{ r: 2, c: 2, id: 's1' }];
    ctx.formulaCache.depsByCell.set('s1:2:2', new Set(['s1:0:0', 's1:0:1']));
    ctx.formulaCache.revDepsByCell.set('s1:0:0', new Set(['s1:2:2']));
    ctx.formulaCache.revDepsByCell.set('s1:0:1', new Set(['s1:2:2']));
    ctx.formulaCache.depGraphComplete = true;
    return ctx;
  };
  const apply = (ctx: any, v: any, r = 2, c = 2) =>
    produce<any>(ctx, (d: any) => {
      applyRemoteCellValue(d, r, c, v, { id: 's1' });
    });

  it('keeps the flag when only the value of the same formula changes', () => {
    const next = apply(withFormula(), { f: '=A1+B1', v: 3, m: '3' });
    expect(next.luckysheetfile[0].data[2][2].v).toBe(3);
    expect(next.formulaCache.depGraphComplete).toBe(true);
  });

  it('keeps the flag and replaces the cell\'s edges when the formula text changes', () => {
    const next = apply(withFormula(), { f: '=C1+D1', v: 4, m: '4' });
    expect(next.formulaCache.depGraphComplete).toBe(true);
    expect([...next.formulaCache.depsByCell.get('s1:2:2')].sort()).toEqual([
      's1:0:2',
      's1:0:3',
    ]);
    expect(next.formulaCache.revDepsByCell.has('s1:0:0')).toBe(false);
    expect([...next.formulaCache.revDepsByCell.get('s1:0:2')]).toEqual(['s1:2:2']);
  });

  it('keeps the flag and records the edges of a formula the cell did not hold', () => {
    const next = apply(withFormula(), { f: '=A1*2', v: 5, m: '5' }, 3, 3);
    expect(next.formulaCache.depGraphComplete).toBe(true);
    expect([...next.formulaCache.revDepsByCell.get('s1:0:0')].sort()).toEqual([
      's1:2:2',
      's1:3:3',
    ]);
  });

  it('keeps the flag and registers a formula that was not in the chain', () => {
    const ctx = withFormula();
    ctx.luckysheetfile[0].calcChain = [];
    const next = apply(ctx, { f: '=A1+B1', v: 3, m: '3' });
    expect(next.formulaCache.depGraphComplete).toBe(true);
    expect(next.luckysheetfile[0].calcChain).toHaveLength(1);
  });

  it('drops the edges when the value is no longer a formula', () => {
    const next = apply(withFormula(), { v: 9, m: '9' });
    expect(next.formulaCache.depGraphComplete).toBe(true);
    expect(next.formulaCache.depsByCell.has('s1:2:2')).toBe(false);
    expect(next.formulaCache.revDepsByCell.size).toBe(0);
  });

  it('records a wide formula with its range', () => {
    const next = apply(withFormula(), { f: '=SUM(A1:A20000)', v: 0, m: '0' }, 4, 4);
    expect(next.formulaCache.formulasWithWideRangeDeps.has('s1:4:4')).toBe(true);
    expect(next.formulaCache.wideRangesByFormula.get('s1:4:4')).toEqual([
      { sheetId: 's1', startRow: 0, endRow: 19_999, startCol: 0, endCol: 0 },
    ]);
  });
});
