/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { updateCell } from './cell';
import { groupValuesRefresh, runFormulaEvalChunk } from './formula';
import { warmFormulaDependencyGraph } from './formula-warmup';
import { deleteRowCol, insertRowCol } from './rowcol';

beforeAll(() => loadLocale('en'));

// PR 466 round 7: insert and delete move formulas without evaluating them, but
// the dependency edges stayed keyed by the cells the formulas left. The cycle
// check walks those edges, so a formula could show #CIRC! with no cycle, and
// the wrong value was written to Yjs for everyone.

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
      data: Array.from({ length: 6 }, () => Array(10).fill(null)),
      config: {},
      calcChain: [],
      row: 6,
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

// Formula values are written by deferred chunks; run them to completion.
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

const cell = (ctx: any, r: number, c: number) =>
  ctx.luckysheetfile[0].data[r]?.[c];
const shown = (ctx: any, r: number, c: number) => cell(ctx, r, c)?.v;
const formula = (ctx: any, r: number, c: number) => cell(ctx, r, c)?.f;

const runWarmup = async (ctx: any) => {
  const result = await warmFormulaDependencyGraph(ctx, {
    budgetMs: 8,
    schedule: (cb) => cb(),
  });
  expect(result).toBe('complete');
};

describe.each([
  ['without the warm-up', false],
  ['after the warm-up', true],
])('a column insert or delete, %s', (_label, warmUp) => {
  it('insert: a formula moved by the insert does not look like a cycle', async () => {
    // B1 5, C1 =E1, D1 =SUM(B1:C3)
    const ctx = makeCtx();
    commit(ctx, 0, 1, 5);
    commit(ctx, 0, 2, '=E1');
    commit(ctx, 0, 3, '=SUM(B1:C3)');
    expect(shown(ctx, 0, 3)).toBe(5);

    // One column to the left of C: C1 =E1 becomes D1 =F1, D1 =SUM(B1:C3)
    // becomes E1 =SUM(B1:D3).
    insertRowCol(ctx, {
      type: 'column',
      index: 2,
      count: 1,
      direction: 'lefttop',
      id: 's1',
    });
    expect(formula(ctx, 0, 3)).toBe('=F1');
    expect(formula(ctx, 0, 4)).toBe('=SUM(B1:D3)');
    if (warmUp) await runWarmup(ctx);

    commit(ctx, 0, 1, 7);

    expect(shown(ctx, 0, 4)).toBe(7);
    expect(shown(ctx, 0, 3)).toBe(0);
  });

  it('delete: a formula moved by the delete does not look like a cycle', async () => {
    // B1 5, D1 =F1, E1 =SUM(B1:D3)
    const ctx = makeCtx();
    commit(ctx, 0, 1, 5);
    commit(ctx, 0, 3, '=F1');
    commit(ctx, 0, 4, '=SUM(B1:D3)');
    expect(shown(ctx, 0, 4)).toBe(5);

    // Delete column C: D1 =F1 becomes C1 =E1, E1 =SUM(B1:D3) becomes
    // D1 =SUM(B1:C3).
    deleteRowCol(ctx, { type: 'column', start: 2, end: 2, id: 's1' });
    expect(formula(ctx, 0, 2)).toBe('=E1');
    expect(formula(ctx, 0, 3)).toBe('=SUM(B1:C3)');
    if (warmUp) await runWarmup(ctx);

    commit(ctx, 0, 1, 7);

    expect(shown(ctx, 0, 3)).toBe(7);
    expect(shown(ctx, 0, 2)).toBe(0);
  });

  it('insert a row: the same leftover edges are gone', async () => {
    // B1 5, B2 =B4, B3 =SUM(B1:B2)
    const ctx = makeCtx();
    commit(ctx, 0, 1, 5);
    commit(ctx, 1, 1, '=B4');
    commit(ctx, 2, 1, '=SUM(B1:B2)');
    expect(shown(ctx, 2, 1)).toBe(5);

    // One row above row 2: B2 =B4 becomes B3 =B5, B3 =SUM(B1:B2) becomes
    // B4 =SUM(B1:B3).
    insertRowCol(ctx, {
      type: 'row',
      index: 1,
      count: 1,
      direction: 'lefttop',
      id: 's1',
    });
    expect(formula(ctx, 2, 1)).toBe('=B5');
    expect(formula(ctx, 3, 1)).toBe('=SUM(B1:B3)');
    if (warmUp) await runWarmup(ctx);

    commit(ctx, 0, 1, 7);

    expect(shown(ctx, 3, 1)).toBe(7);
    expect(shown(ctx, 2, 1)).toBe(0);
  });
});

describe('the dependency index after a structural edit', () => {
  const build = () => {
    const ctx = makeCtx();
    commit(ctx, 0, 1, 5);
    commit(ctx, 0, 2, '=E1');
    commit(ctx, 0, 3, '=SUM(B1:C3)');
    return ctx;
  };
  const insertColumn = (ctx: any) =>
    insertRowCol(ctx, {
      type: 'column',
      index: 2,
      count: 1,
      direction: 'lefttop',
      id: 's1',
    });

  it('holds no edge keyed by a cell the formula left, and the flag is off', () => {
    const ctx = build();
    expect(ctx.formulaCache.depsByCell.size).toBeGreaterThan(0);

    insertColumn(ctx);

    expect(ctx.formulaCache.depsByCell.size).toBe(0);
    expect(ctx.formulaCache.revDepsByCell.size).toBe(0);
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
  });

  it('a refused edit still leaves the index and the flag alone', () => {
    const ctx = build();
    ctx.luckysheetfile[0].config.colReadOnly = { 2: true };
    ctx.formulaCache.depGraphComplete = true;
    const edgesBefore = ctx.formulaCache.depsByCell.size;

    expect(() => insertColumn(ctx)).toThrow('readOnly');

    expect(ctx.formulaCache.depsByCell.size).toBe(edgesBefore);
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
  });
});
