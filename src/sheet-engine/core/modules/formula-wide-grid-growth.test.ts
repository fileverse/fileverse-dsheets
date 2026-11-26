/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { pasteHandler } from '../paste/paste-internals';
import { updateCell } from './cell';
import { groupValuesRefresh, runFormulaEvalChunk } from './formula';
import { warmFormulaDependencyGraph } from './formula-warmup';
import { insertRowCol } from './rowcol';

beforeAll(() => loadLocale('en'));

// A whole-row or whole-column reference covers the grid as it is now. Rows or
// columns added at the end must still reach a wide formula that reads it, both
// after an insert (the index is reset and not rebuilt yet) and after a paste
// that grows the grid (the index stays complete).

const makeCtx = (rows: number, cols: number) => {
  const ctx: any = defaultContext({
    globalCache: { undoList: [], redoList: [] },
    cellInput: { current: null },
    fxInput: { current: null },
    canvas: { current: null },
    cellArea: { current: null },
    workbookContainer: { current: null },
  } as any);
  ctx.luckysheetfile = [
    {
      id: 's1',
      name: 'Sheet1',
      order: 0,
      status: 1,
      data: Array.from({ length: rows }, () => Array(cols).fill(null)),
      config: {},
      calcChain: [],
      row: rows,
      column: cols,
    },
  ];
  ctx.currentSheetId = 's1';
  ctx.config = ctx.luckysheetfile[0].config;
  ctx.hooks = {};
  ctx.luckysheet_select_save = [
    { row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 },
  ];
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

const commit = (ctx: any, r: number, c: number, value: unknown) => {
  updateCell(ctx, r, c, null, value);
  settle(ctx);
};

const shown = (ctx: any, r: number, c: number) =>
  ctx.luckysheetfile[0].data[r]?.[c]?.v;

const runWarmup = async (ctx: any) => {
  const result = await warmFormulaDependencyGraph(ctx, {
    budgetMs: 1000,
    schedule: (cb) => cb(),
  });
  expect(result).toBe('complete');
};

// 4,000 rows: A:C is 12,000 cells, so D1 is a wide formula.
const ROWS = 4000;

const wideColumnSheet = async () => {
  const ctx = makeCtx(ROWS, 8);
  commit(ctx, 0, 0, 1);
  commit(ctx, 0, 3, '=SUM(A:C)');
  commit(ctx, 0, 7, '=B2');
  await runWarmup(ctx);
  expect(ctx.formulaCache.formulasWithWideRangeDeps.has('s1:0:3')).toBe(true);
  return ctx;
};

describe('wide whole-row and whole-column formulas after the grid grows', () => {
  it('rows inserted at the bottom, edit in a new row before the warm-up', async () => {
    const ctx = await wideColumnSheet();
    insertRowCol(
      ctx,
      {
        type: 'row',
        index: ROWS - 1,
        count: 10,
        direction: 'rightbottom',
        id: 's1',
      },
      false,
    );
    commit(ctx, ROWS + 5, 0, 100);
    expect(shown(ctx, 0, 3)).toBe(101);
  });

  it('rows inserted at the bottom, edit in a new row after the warm-up', async () => {
    const ctx = await wideColumnSheet();
    insertRowCol(
      ctx,
      {
        type: 'row',
        index: ROWS - 1,
        count: 10,
        direction: 'rightbottom',
        id: 's1',
      },
      false,
    );
    await runWarmup(ctx);
    commit(ctx, ROWS + 5, 0, 100);
    expect(shown(ctx, 0, 3)).toBe(101);
  });

  it('a text paste grows the grid, edit in a new row', async () => {
    const ctx = await wideColumnSheet();
    ctx.luckysheet_select_save = [
      {
        row: [ROWS - 1, ROWS - 1],
        column: [5, 5],
        row_focus: ROWS - 1,
        column_focus: 5,
      },
    ];
    pasteHandler(ctx, Array(10).fill('0').join('\n'));
    expect(ctx.luckysheetfile[0].data.length).toBe(ROWS + 9);
    commit(ctx, ROWS + 5, 0, 100);
    expect(shown(ctx, 0, 3)).toBe(101);
  });

  // With another wide or runtime-reference formula on the sheet the walk
  // never falls back to the full pass, so D1's recorded range decides alone.
  it.each([
    ['a second wide formula', '=SUM(A1:C9000)'],
    ['an INDIRECT formula', '=INDIRECT("B2")'],
  ])('a text paste grows the grid with %s on the sheet', async (_l, other) => {
    const ctx = makeCtx(ROWS, 8);
    commit(ctx, 0, 0, 1);
    commit(ctx, 0, 3, '=SUM(A:C)');
    commit(ctx, 0, 7, '=B2');
    commit(ctx, 0, 6, other);
    await runWarmup(ctx);
    ctx.luckysheet_select_save = [
      {
        row: [ROWS - 1, ROWS - 1],
        column: [5, 5],
        row_focus: ROWS - 1,
        column_focus: 5,
      },
    ];
    pasteHandler(ctx, Array(10).fill('0').join('\n'));
    commit(ctx, ROWS + 5, 0, 100);
    expect(shown(ctx, 0, 3)).toBe(101);
  });

  it('columns inserted at the right, edit in a new column before the warm-up', async () => {
    // 12 rows x 990 columns: 1:12 is 11,880 cells, so A14 is a wide formula.
    const COLS = 990;
    const ctx = makeCtx(14, COLS);
    commit(ctx, 0, 0, 1);
    commit(ctx, 13, 0, '=SUM(1:12)');
    commit(ctx, 13, 1, '=B2');
    await runWarmup(ctx);
    insertRowCol(
      ctx,
      {
        type: 'column',
        index: COLS - 1,
        count: 5,
        direction: 'rightbottom',
        id: 's1',
      },
      false,
    );
    commit(ctx, 1, COLS + 3, 100);
    expect(shown(ctx, 13, 0)).toBe(101);
  });
});
