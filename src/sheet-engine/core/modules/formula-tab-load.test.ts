/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { ensureSheetFlowdata } from '../api/sheet';
import { updateCell } from './cell';
import { runFormulaEvalChunk, groupValuesRefresh } from './formula';

// PR 466 K60: the warm-up completes with tab 2 unloaded and sizes only tab 1.
// Loading tab 2 does not change its structure, so the flag stays on and a
// commit to a cell nothing reads takes the narrow path (no formula pass).

const makeCtx = () => {
  const ctx: any = defaultContext({
    globalCache: { undoList: [], redoList: [] },
    cellInput: { current: null },
    fxInput: { current: null },
    canvas: { current: null },
    cellArea: { current: null },
    workbookContainer: { current: null },
  } as any);
  const grid = () => Array.from({ length: 8 }, () => Array(6).fill(null));
  const data1 = grid();
  data1[0][0] = { v: 1, m: '1' };
  data1[0][1] = { v: 2, m: '2', f: '=A1+1' };
  ctx.luckysheetfile = [
    {
      id: 's1',
      name: 'Sheet1',
      order: 0,
      status: 1,
      data: data1,
      config: {},
      row: 8,
      column: 6,
      calcChain: [{ r: 0, c: 1, id: 's1' }],
    },
    {
      id: 's2',
      name: 'Sheet2',
      order: 1,
      status: 0,
      config: {},
      row: 8,
      column: 6,
      celldata: [
        { r: 0, c: 0, v: { v: 5, m: '5' } },
        { r: 0, c: 1, v: { v: 6, m: '6', f: '=A1+1' } },
      ],
      calcChain: [{ r: 0, c: 1, id: 's2' }],
    },
  ];
  ctx.currentSheetId = 's1';
  ctx.config = ctx.luckysheetfile[0].config;
  ctx.hooks = {};
  // State the warm-up leaves: complete, only the loaded tab sized.
  ctx.formulaCache.depGraphComplete = true;
  ctx.formulaCache.depGraphSheetSizes = new Map([['s1', '8x6']]);
  return ctx;
};

const settle = (ctx: any) => {
  while (ctx.formulaAsyncEval) {
    if (runFormulaEvalChunk(ctx, ctx.formulaAsyncEval, 50)) {
      ctx.formulaAsyncEval = null;
      ctx.isFormulaCalculating = false;
    }
  }
  groupValuesRefresh(ctx);
};

beforeAll(() => loadLocale('en'));

describe('a tab loaded after the warm-up (K60)', () => {
  const switchTo = (ctx: any) => {
    ensureSheetFlowdata(ctx, { id: 's2' });
    ctx.currentSheetId = 's2';
    ctx.config = ctx.luckysheetfile[1].config;
  };

  it('records its size when the flag is on', () => {
    const ctx = makeCtx();
    switchTo(ctx);
    expect(ctx.formulaCache.depGraphSheetSizes.get('s2')).toBe('8x6');
  });

  it('records nothing while the flag is off', () => {
    const ctx = makeCtx();
    ctx.formulaCache.markDepGraphIncomplete();
    switchTo(ctx);
    expect(ctx.formulaCache.depGraphSheetSizes.has('s2')).toBe(false);
  });

  it('keeps the flag on for a commit to a cell nothing reads', () => {
    const ctx = makeCtx();
    switchTo(ctx);
    updateCell(ctx, 5, 5, null, 'typed');
    settle(ctx);
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
  });

  it('does not overwrite the size of a tab that already has one', () => {
    const ctx = makeCtx();
    ctx.formulaCache.depGraphSheetSizes.set('s2', '3x3');
    switchTo(ctx);
    expect(ctx.formulaCache.depGraphSheetSizes.get('s2')).toBe('3x3');
  });
});
