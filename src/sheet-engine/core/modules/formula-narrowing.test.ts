/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { updateCell } from './cell';
import {
  execFunctionGroup,
  groupValuesRefresh,
  runFormulaEvalChunk,
} from './formula';

// Task 16: a commit narrows its run list only while the dependency graph is
// complete. Layout (one tab, 'Sheet1'):
//   A1 = 5, A2 = 1, A3 = 7                  values
//   B1 = A1+1, B2 = A2+1, E1 = A3+1         evaluated by the forced pass, so
//                                           the graph holds their edges
//   C1 = A1*2                               in the calc chain only, never
//                                           evaluated, so it has no edge
// (B1 gives A1 a dependent, which keeps the old code on the narrowed branch;
// E1 is unrelated to A1 and A2.)
const makeCtx = () => {
  const ctx: any = defaultContext({
    globalCache: { undoList: [], redoList: [] },
    cellInput: { current: null },
    fxInput: { current: null },
    canvas: { current: null },
    cellArea: { current: null },
    workbookContainer: { current: null },
  } as any);
  const data: any[][] = Array.from({ length: 6 }, () => Array(6).fill(null));
  data[0][0] = { v: 5, m: '5' };
  data[1][0] = { v: 1, m: '1' };
  data[2][0] = { v: 7, m: '7' };
  data[1][1] = { v: 0, m: '0', f: '=A2+1' };
  data[0][4] = { v: 0, m: '0', f: '=A3+1' };
  data[0][1] = { v: 0, m: '0', f: '=A1+1' };
  ctx.luckysheetfile = [
    {
      id: 's1',
      name: 'Sheet1',
      order: 0,
      status: 1,
      data,
      config: {},
      calcChain: [
        { r: 1, c: 1, id: 's1' },
        { r: 0, c: 4, id: 's1' },
        { r: 0, c: 1, id: 's1' },
      ],
    },
  ];
  ctx.currentSheetId = 's1';
  ctx.config = ctx.luckysheetfile[0].config;
  ctx.hooks = {};
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

const forceFullPass = (ctx: any) => {
  execFunctionGroup(ctx, null as any, null as any, null, undefined, undefined, true);
  settle(ctx);
};

const commit = (ctx: any, r: number, c: number, value: unknown) => {
  updateCell(ctx, r, c, null, value);
  settle(ctx);
};

const countEvaluations = (ctx: any) => {
  const counter = { n: 0 };
  const { parser } = ctx.formulaCache;
  const parse = parser.parse.bind(parser);
  parser.parse = (...args: any[]) => {
    counter.n += 1;
    return parse(...args);
  };
  return counter;
};

beforeAll(() => loadLocale('en'));

describe('commit narrowing needs a complete dependency graph (Task 16)', () => {
  it('a never-evaluated formula updates when its precedent is edited, flag false, graph non-empty', () => {
    const ctx = makeCtx();
    forceFullPass(ctx); // evaluates B2 and E1: edges exist
    // C1 joins the calc chain without being evaluated (as a remote or loaded
    // formula does), and the flag goes false (as every such path does).
    ctx.luckysheetfile[0].data[0][2] = { v: 10, m: '10', f: '=A1*2' };
    ctx.luckysheetfile[0].calcChain.push({ r: 0, c: 2, id: 's1' });
    ctx.formulaCache.markDepGraphIncomplete();
    expect(ctx.formulaCache.revDepsByCell.size).toBeGreaterThan(0);
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
    commit(ctx, 0, 0, 50); // A1
    expect(ctx.luckysheetfile[0].data[0][2].v).toBe(100);
  });

  it('with the flag true, a commit to an unreferenced cell processes no formula', () => {
    const ctx = makeCtx();
    forceFullPass(ctx);
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
    const evals = countEvaluations(ctx);
    commit(ctx, 4, 4, 'typed'); // E5, read by nothing
    expect(evals.n).toBe(0);
  });

  it('with the flag true, a commit evaluates only the dependents of the edited cell', () => {
    const ctx = makeCtx();
    forceFullPass(ctx);
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
    const evals = countEvaluations(ctx);
    commit(ctx, 1, 0, 20); // A2: only B2 reads it, E1 (=A3+1) is not evaluated
    expect(ctx.luckysheetfile[0].data[1][1].v).toBe(21);
    expect(evals.n).toBe(1);
  });
});
