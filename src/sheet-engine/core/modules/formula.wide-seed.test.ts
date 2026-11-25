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

// C8 spec change (2026-10-29): a wide formula joins the walk only when its
// range contains the edited cell or a formula cell the walk reaches.
describe('wide formulas join the walk only when affected', () => {
  const range = (
    sheetId: string,
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number,
  ) => ({ sheetId, startRow, endRow, startCol, endCol });

  it('collectTransitiveFormulaDependents joins a wide formula whose range holds the edited cell', () => {
    const rev = new Map<string, Set<string>>();
    const wide = {
      keys: new Set(['s1:0:1']),
      ranges: new Map([['s1:0:1', [range('s1', 0, 19_999, 0, 0)]]]),
    };
    expect(
      [...collectTransitiveFormulaDependents('s1:4:0', rev, [], wide)],
    ).toEqual(['s1:0:1']);
    expect(collectTransitiveFormulaDependents('s1:4:3', rev, [], wide).size).toBe(0);
  });

  it('joins through a formula cell the walk reaches (edit Z1, reach B1 through A5)', () => {
    const rev = new Map<string, Set<string>>([['s1:0:25', new Set(['s1:4:0'])]]);
    const wide = {
      keys: new Set(['s1:0:1']),
      ranges: new Map([['s1:0:1', [range('s1', 0, 19_999, 0, 0)]]]),
    };
    expect(
      [...collectTransitiveFormulaDependents('s1:0:25', rev, [], wide)].sort(),
    ).toEqual(['s1:0:1', 's1:4:0']);
  });

  it('a wide formula with no readable range joins every walk', () => {
    const wide = { keys: new Set(['s1:0:1']), ranges: new Map() };
    expect(
      [...collectTransitiveFormulaDependents('s1:9:9', new Map(), [], wide)],
    ).toEqual(['s1:0:1']);
  });

  const wideFixture = (extra: (data: any[][]) => void, chain: any[]) => {
    const ctx: any = defaultContext({
      globalCache: { undoList: [], redoList: [] },
      cellInput: { current: null },
      fxInput: { current: null },
      canvas: { current: null },
      cellArea: { current: null },
      workbookContainer: { current: null },
    } as any);
    const data: any[][] = Array.from({ length: ROWS }, () => Array(30).fill(null));
    for (let r = 0; r < 20_000; r += 1) data[r][0] = { v: 1, m: '1' };
    extra(data);
    ctx.luckysheetfile = [
      { id: 's1', name: 'Sheet1', order: 0, status: 1, data, config: {}, calcChain: chain },
    ];
    ctx.currentSheetId = 's1';
    ctx.config = ctx.luckysheetfile[0].config;
    ctx.hooks = {};
    execFunctionGroup(ctx, null as any, null as any, null, undefined, undefined, true);
    settle(ctx);
    return ctx;
  };

  it('editing Z1 reaches B1 through A5 and C1 through B1', () => {
    const ctx = wideFixture(
      (data) => {
        data[0][1] = { v: 0, m: '0', f: '=SUM(A1:A20000)' };
        data[4][0] = { v: 0, m: '0', f: '=Z1*2' };
        data[0][2] = { v: 0, m: '0', f: '=B1*2' };
      },
      [
        { r: 0, c: 1, id: 's1' },
        { r: 4, c: 0, id: 's1' },
        { r: 0, c: 2, id: 's1' },
      ],
    );
    expect(ctx.luckysheetfile[0].data[0][2].v).toBe(2 * (19_999 + 0));
    updateCell(ctx, 0, 25, null, 5);
    settle(ctx);
    const data = ctx.luckysheetfile[0].data;
    expect(data[4][0].v).toBe(10);
    expect(data[0][1].v).toBe(19_999 + 10);
    expect(data[0][2].v).toBe(2 * (19_999 + 10));
  });

  // The cost of a wide formula on every commit is the walk over its range
  // (the commit pass expands the range to find the edited cell), not its
  // evaluation. 5 formulas over 104k cells cost about 21 ms per commit outside their ranges before.
  it('a commit outside every wide range does not pay for the wide formulas', () => {
    const ctx = wideFixture(
      (data) => {
        for (let r = 0; r < 4000; r += 1) {
          for (let c = 1; c < 26; c += 1) data[r][c] = { v: r + c, m: String(r + c) };
        }
        for (let k = 0; k < 5; k += 1) {
          data[k][27] = { v: 0, m: '0', f: '=SUM(A1:Z4000)' };
        }
      },
      Array.from({ length: 5 }, (_, k) => ({ r: k, c: 27, id: 's1' })),
    );
    expect(ctx.formulaCache.formulasWithWideRangeDeps.size).toBe(5);
    updateCell(ctx, 10, 29, null, 1); // warm any lazy state
    settle(ctx);
    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      updateCell(ctx, 11 + i, 29, null, i + 2);
      times.push(performance.now() - t0);
      settle(ctx);
    }
    times.sort((x, y) => x - y);
    expect(times[2]).toBeLessThan(8);
  });
});
