/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { execfunction } from './formula';
import { collectFormulaTextDeps } from './formula-dep-text';

const ROWS = 60;
const COLS = 30;

const makeCtx = (extraSheets: { id: string; name: string }[] = []) => {
  const ctx: any = defaultContext({
    globalCache: { undoList: [], redoList: [] },
    cellInput: { current: null },
    fxInput: { current: null },
    canvas: { current: null },
    cellArea: { current: null },
    workbookContainer: { current: null },
  } as any);
  const grid = () =>
    Array.from({ length: ROWS }, (_, r) =>
      Array.from({ length: COLS }, (_, c) => ({ v: r + c, m: String(r + c) })),
    );
  ctx.luckysheetfile = [
    { id: 's1', name: 'Sheet1', order: 0, status: 1, data: grid(), config: {}, calcChain: [] },
    { id: 's2', name: 'Sheet2', order: 1, status: 0, data: grid(), config: {}, calcChain: [] },
    { id: 's3', name: 'Sheet 3', order: 2, status: 0, data: grid(), config: {}, calcChain: [] },
    ...extraSheets.map((s, i) => ({
      ...s,
      order: 3 + i,
      status: 0,
      data: grid(),
      config: {},
      calcChain: [],
    })),
  ];
  ctx.currentSheetId = 's1';
  ctx.config = ctx.luckysheetfile[0].config;
  ctx.hooks = {};
  ctx.definedNames = [
    {
      id: 'n1',
      name: 'Rng',
      sheetId: 's2',
      scope: 'workbook',
      range: { row: [1, 3], column: [1, 2] },
    },
  ];
  return ctx;
};

/** What execfunction records for `f` written in s1 (r, c). */
const recorded = (ctx: any, f: string, r: number, c: number) => {
  execfunction(ctx, f, r, c, 's1', undefined, false, true);
  const key = `s1:${r}:${c}`;
  return {
    deps: [...(ctx.formulaCache.depsByCell.get(key) ?? [])].sort(),
    wide: ctx.formulaCache.formulasWithWideRangeDeps.has(key),
  };
};

const fromText = (ctx: any, f: string, r: number, c: number) => {
  const { deps, wide } = collectFormulaTextDeps(ctx, f, 's1', r, c);
  return { deps: [...deps].sort(), wide };
};

beforeAll(() => loadLocale('en'));

describe('collectFormulaTextDeps (C8)', () => {
  // The same edges execfunction records for the same text.
  it.each([
    '=A1+B2',
    '=SUM(A1:B3)',
    '=SUM($A$1:B$3)',
    '=SUM(B3:A1)',
    '=SUM(A:A)',
    '=SUM(2:3)',
    '=Sheet2!A1*2',
    "='Sheet 3'!B2",
    "=SUM('Sheet 3'!A1:B2)",
    '=SUM(Rng)',
    '=A1&"B2"',
    '=LOG10(A1)',
    '=SUM(A1:A3)+COUNT(C1:C2)',
    '=SUM(A1:Z1000)',
    '=Missing!A1',
    '=sheet2!A1',
    '=IF(A1>2,B1,C1)',
    '=A1+1.5',
    '=SUM(A1,B1)',
    '=A1 + B1',
    '=INDEX(A1:A40,5)',
    '=SUM(A1:B2, D1:D2)',
  ])('gives the edges execfunction records for %s', (f) => {
    const ctx = makeCtx();
    expect(fromText(ctx, f, 50, 20)).toEqual(recorded(ctx, f, 50, 20));
  });

  // C8 spec change (2026-10-29): a wide formula keeps its ranges.
  it('returns the ranges of a wide formula, as execfunction records them', () => {
    const ctx = makeCtx();
    const f = '=SUM(A1:Z1000)+B1';
    const text = collectFormulaTextDeps(ctx, f, 's1', 50, 20);
    expect(text.wide).toBe(true);
    expect(text.wideRanges).toEqual([
      { sheetId: 's1', startRow: 0, endRow: 999, startCol: 0, endCol: 25 },
    ]);
    execfunction(ctx, f, 50, 20, 's1', undefined, false, true);
    expect(ctx.formulaCache.wideRangesByFormula.get('s1:50:20')).toEqual(
      text.wideRanges,
    );
  });

  it('gives no ranges for a wide formula whose ranges cannot be read from its text', () => {
    const ctx = makeCtx();
    expect(collectFormulaTextDeps(ctx, '=Missing!A1', 's1', 9, 9).wideRanges).toBeNull();
    expect(collectFormulaTextDeps(ctx, '=OFFSET(A1,1,0)', 's1', 9, 9).wideRanges).toBeNull();
    expect(
      collectFormulaTextDeps(ctx, '=SUM(A1:Z1000)+Missing!A1', 's1', 9, 9).wideRanges,
    ).toBeNull();
    execfunction(ctx, '=Missing!A1', 9, 9, 's1', undefined, false, true);
    expect(ctx.formulaCache.formulasWithWideRangeDeps.has('s1:9:9')).toBe(true);
    expect(ctx.formulaCache.wideRangesByFormula.has('s1:9:9')).toBe(false);
  });

  it('gives an empty list for a formula that is not wide', () => {
    const ctx = makeCtx();
    expect(collectFormulaTextDeps(ctx, '=A1+B1', 's1', 9, 9).wideRanges).toEqual([]);
  });

  it('records the origin itself for a very large range that holds it', () => {
    const ctx = makeCtx();
    const f = '=SUM(A1:Z1000)';
    expect(fromText(ctx, f, 0, 1)).toEqual(recorded(ctx, f, 0, 1));
    expect(fromText(ctx, f, 0, 1).wide).toBe(true);
    expect(fromText(ctx, f, 0, 1).deps).toContain('s1:0:1');
  });

  it('keeps a reference next to a space and a reference inside INDEX(', () => {
    const ctx = makeCtx();
    expect(fromText(ctx, '=SUM(A1, B1)', 9, 9).deps).toEqual(['s1:0:0', 's1:0:1']);
    expect(fromText(ctx, '=A1 + B1', 9, 9).deps).toEqual(['s1:0:0', 's1:0:1']);
    const index = fromText(ctx, '=INDEX(A1:A100,5)', 9, 9);
    expect(index.deps).toHaveLength(100);
    expect(index.deps).toContain('s1:99:0');
  });

  it('resolves an unquoted tab name that contains a split character', () => {
    const ctx = makeCtx([{ id: 's4', name: 'Q1-2026' }]);
    expect(fromText(ctx, '=Q1-2026!A1', 9, 9)).toEqual({
      deps: ['s4:0:0'],
      wide: false,
    });
    expect(fromText(ctx, '=SUM(Q1-2026!A1:A2)+B1', 9, 9).deps).toEqual([
      's1:0:1',
      's4:0:0',
      's4:1:0',
    ]);
  });

  it('matches tab names exactly, case-sensitive', () => {
    const ctx = makeCtx();
    expect(fromText(ctx, '=sheet2!A1', 9, 9)).toEqual({ deps: [], wide: true });
    expect(fromText(ctx, '=Sheet2!A1', 9, 9)).toEqual({
      deps: ['s2:0:0'],
      wide: false,
    });
  });

  it('ignores references inside string literals', () => {
    const ctx = makeCtx();
    expect(fromText(ctx, '=IF(A1="B2","C3 D4",\'E5\')', 9, 9).deps).toEqual([
      's1:0:0',
    ]);
  });

  it('marks INDIRECT and OFFSET wide', () => {
    const ctx = makeCtx();
    expect(fromText(ctx, '=OFFSET(A1,1,0)', 9, 9).wide).toBe(true);
    expect(fromText(ctx, '=INDIRECT("A1")', 9, 9).wide).toBe(true);
  });

  it('reads no cell and calls no function', () => {
    const ctx = makeCtx();
    let parses = 0;
    const { parser } = ctx.formulaCache;
    const parse = parser.parse.bind(parser);
    parser.parse = (...a: any[]) => {
      parses += 1;
      return parse(...a);
    };
    const sheet = ctx.luckysheetfile[1];
    ctx.luckysheetfile[1] = {
      ...sheet,
      data: new Proxy(sheet.data, {
        get(target, prop) {
          if (prop === 'length') return target.length;
          throw new Error(`grid read: ${String(prop)}`);
        },
      }),
    };
    collectFormulaTextDeps(ctx, '=SUM(Sheet2!A1:B2)+NOW()+RAND()', 's1', 9, 9);
    expect(parses).toBe(0);
  });
});

describe('parity check is not vacuous', () => {
  it('execfunction records real edges for the fixtures', () => {
    const ctx = makeCtx();
    expect(recorded(ctx, '=SUM(A1, B1)', 50, 20).deps).toEqual(['s1:0:0', 's1:0:1']);
    expect(recorded(ctx, '=INDEX(A1:A40,5)', 50, 21).deps).toHaveLength(40);
    expect(recorded(ctx, '=SUM(Rng)', 50, 22).deps).toHaveLength(6);
  });
});
