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
  it('replaces the chain and resets dependency indexes to a fresh mount', () => {
    const ctx = makeCtx();
    ctx.formulaCache.depsByCell.set('s1:0:1', new Set(['s1:0:0']));
    ctx.formulaCache.revDepsByCell.set('s1:0:0', new Set(['s1:0:1']));
    ctx.formulaCache.formulasWithWideRangeDeps.add('s1:3:3');
    const chain = [{ r: 0, c: 1, id: 's1' }];
    const next = produce<any>(ctx, (d: any) =>
      setSheetCalcChain(d, chain, { id: 's1' }),
    );
    expect(next.luckysheetfile[0].calcChain).toEqual(chain);
    expect(next.formulaCache.depsByCell.size).toBe(0);
    expect(next.formulaCache.revDepsByCell.size).toBe(0);
    expect(next.formulaCache.formulasWithWideRangeDeps.size).toBe(0);
  });

  it('treats a missing chain as empty', () => {
    const next = produce<any>(makeCtx(), (d: any) =>
      setSheetCalcChain(d, undefined, { id: 's1' }),
    );
    expect(next.luckysheetfile[0].calcChain).toEqual([]);
  });
});
