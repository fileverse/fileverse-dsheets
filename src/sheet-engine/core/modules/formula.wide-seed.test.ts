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
import { collectTransitiveFormulaDependents } from './formula-transitive-deps';

const ROWS = 20_010;
const COLS = 6;

const makeCtx = () => {
  const ctx: any = defaultContext({
    globalCache: { undoList: [], redoList: [] },
    cellInput: { current: null },
    fxInput: { current: null },
    canvas: { current: null },
    cellArea: { current: null },
    workbookContainer: { current: null },
  } as any);
  const data: any[][] = Array.from({ length: ROWS }, () =>
    Array(COLS).fill(null),
  );
  for (let r = 0; r < 20_000; r += 1) data[r][0] = { v: 1, m: '1' };
  // B1 reads a range over 10,000 cells (no graph edges); C1 reads B1.
  data[0][1] = { v: 0, m: '0', f: '=SUM(A1:A20000)' };
  data[0][2] = { v: 0, m: '0', f: '=B1*2' };
  ctx.luckysheetfile = [
    {
      id: 's1',
      name: 'Sheet1',
      order: 0,
      status: 1,
      data,
      config: {},
      calcChain: [
        { r: 0, c: 1, id: 's1' },
        { r: 0, c: 2, id: 's1' },
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

beforeAll(() => loadLocale('en'));

describe('C8 walk seeded with always-run formulas', () => {
  it('collectTransitiveFormulaDependents reaches readers of a seed formula', () => {
    const rev = new Map<string, Set<string>>([['s1:0:1', new Set(['s1:0:2'])]]);
    expect(
      [...collectTransitiveFormulaDependents('s1:9:9', rev, ['s1:0:1'])].sort(),
    ).toEqual(['s1:0:1', 's1:0:2']);
    expect(collectTransitiveFormulaDependents('s1:9:9', rev).size).toBe(0);
  });

  it('a formula reading a very-large-range formula recalculates with it', () => {
    const ctx = makeCtx();
    execFunctionGroup(
      ctx,
      null as any,
      null as any,
      null,
      undefined,
      undefined,
      true,
    );
    settle(ctx);
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
    expect(ctx.formulaCache.formulasWithWideRangeDeps.has('s1:0:1')).toBe(true);
    const data = ctx.luckysheetfile[0].data;
    expect(data[0][1].v).toBe(20_000);
    expect(data[0][2].v).toBe(40_000);

    updateCell(ctx, 4, 0, null, 100);
    settle(ctx);
    expect(ctx.luckysheetfile[0].data[0][1].v).toBe(20_099);
    expect(ctx.luckysheetfile[0].data[0][2].v).toBe(40_198);
  });
});
