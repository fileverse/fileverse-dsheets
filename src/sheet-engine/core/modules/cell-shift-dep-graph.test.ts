/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { deleteCellsShift, insertCellsShift } from './cell-shift';
import { updateCell } from './cell';
import { groupValuesRefresh, runFormulaEvalChunk } from './formula';

beforeAll(() => loadLocale('en'));

// PR 466 round 7 (K62): inserting or deleting cells and shifting moves
// formulas without evaluating them, like a row or column insert. Their edges in
// the dependency index stayed keyed by the cells they left, and the cycle
// check followed them: a formula could show #CIRC! with no cycle.

const makeCtx = () => {
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
      data: Array.from({ length: 8 }, () => Array(10).fill(null)),
      config: {},
      calcChain: [],
      row: 8,
      column: 10,
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
const formula = (ctx: any, r: number, c: number) =>
  ctx.luckysheetfile[0].data[r]?.[c]?.f;

describe('insert and delete cells with shift keep no stale dependency edges', () => {
  it('insert, shift right: a formula moved right does not look like a cycle', () => {
    // B1 5, C1 =E1. C1 moves to D1 (text unchanged), then E1 sums B1:C1.
    const ctx = makeCtx();
    commit(ctx, 0, 1, 5);
    commit(ctx, 0, 2, '=E1');

    insertCellsShift(ctx, 'right', { row: [0, 0], column: [2, 2] });
    expect(formula(ctx, 0, 3)).toBe('=E1');
    commit(ctx, 0, 4, '=SUM(B1:C1)');

    expect(shown(ctx, 0, 4)).toBe(5);
    // Not asserted: the moved D1 itself. Cell shift does not move its calc
    // chain entry, so D1 is not recalculated when E1 changes (K63).
  });

  it('insert, shift down: a formula moved down does not look like a cycle', () => {
    // B1 5, B2 =B4. B2 moves to B3, then B4 sums B1:B2.
    const ctx = makeCtx();
    commit(ctx, 0, 1, 5);
    commit(ctx, 1, 1, '=B4');

    insertCellsShift(ctx, 'down', { row: [1, 1], column: [1, 1] });
    expect(formula(ctx, 2, 1)).toBe('=B4');
    commit(ctx, 3, 1, '=SUM(B1:B2)');

    expect(shown(ctx, 3, 1)).toBe(5);
    // Not asserted: the moved B3 itself (calc chain not moved, K63).
  });

  it('delete, shift left: a formula moved left does not look like a cycle', () => {
    // C1 is deleted, D1 =G1 moves to C1, then G1 sums D1:E1.
    const ctx = makeCtx();
    commit(ctx, 0, 3, '=G1');

    deleteCellsShift(ctx, 'left', { row: [0, 0], column: [2, 2] });
    expect(formula(ctx, 0, 2)).toBe('=G1');
    commit(ctx, 0, 6, '=SUM(D1:E1)');

    expect(shown(ctx, 0, 6)).toBe(0);
    expect(shown(ctx, 0, 2)).toBe(0);
  });

  it('delete, shift up: a formula moved up does not look like a cycle', () => {
    // B2 is deleted, B3 =B6 moves to B2, then B6 sums B3:B4.
    const ctx = makeCtx();
    commit(ctx, 2, 1, '=B6');

    deleteCellsShift(ctx, 'up', { row: [1, 1], column: [1, 1] });
    expect(formula(ctx, 1, 1)).toBe('=B6');
    commit(ctx, 5, 1, '=SUM(B3:B4)');

    expect(shown(ctx, 5, 1)).toBe(0);
    expect(shown(ctx, 1, 1)).toBe(0);
  });

  it('drops the index and clears the flag, so the next pass rebuilds it', () => {
    const ctx = makeCtx();
    commit(ctx, 0, 1, 5);
    commit(ctx, 0, 2, '=E1');
    expect(ctx.formulaCache.depsByCell.size).toBeGreaterThan(0);

    insertCellsShift(ctx, 'right', { row: [0, 0], column: [2, 2] });

    expect(ctx.formulaCache.depsByCell.size).toBe(0);
    expect(ctx.formulaCache.revDepsByCell.size).toBe(0);
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
  });
});
