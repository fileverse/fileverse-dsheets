/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { applyRemoteCells, setSheetCalcChain } from '../api/cell';
import { setSheetName } from '../api/workbook';
import { updateCell } from './cell';
import { expandRowsAndColumns } from './sheet';
import { evalFormulasInSnapshot } from './formula-snapshot-eval';
import {
  applyWorkerFormulaChunkResults,
  execFunctionGroup,
  groupValuesRefresh,
  resetFormulaDependencyIndexes,
  runFormulaEvalChunk,
} from './formula';

// Fixture: rows 0-19 x columns A-T hold values; 500 =SUM(A{n}:T{n}) row
// formulas sit in column Y (rows 0-499). Column V feeds the INDIRECT, OFFSET
// and INDEX formulas only, W1:W3 is the named range "Rates", column X is read
// only by a whole-column SUM. Column AC (28) is referenced by nothing.
const ROWS = 500;
const COLS = 30;
const SUM_COL = 24; // Y
const SPECIAL_COL = 26; // AA
const UNREFERENCED: [number, number] = [10, 28];

const SPECIALS = {
  indirect: { r: 0, f: '=INDIRECT("V1")' },
  offset: { r: 1, f: '=OFFSET(V1,1,0)' },
  index: { r: 2, f: '=INDEX(V1:V5,3)' },
  named: { r: 3, f: '=SUM(Rates)' },
  wholeColumn: { r: 4, f: '=SUM(X:X)' },
};

type Fixture = {
  ctx: any;
  /** Formula cells whose text a pass loaded, as "r_c". */
  reads: Set<string>;
  evaluations: () => number;
  resetCounters: () => void;
};

const formulaCell = (reads: Set<string>, r: number, c: number, f: string) => {
  let text = f;
  const cell: any = { v: 0, m: '0' };
  Object.defineProperty(cell, 'f', {
    enumerable: true,
    configurable: true,
    get: () => {
      reads.add(`${r}_${c}`);
      return text;
    },
    set: (next) => {
      text = next;
    },
  });
  return cell;
};

const makeFixture = ({ runtimeRefs = true } = {}): Fixture => {
  const reads = new Set<string>();
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
  for (let r = 0; r < 20; r += 1) {
    for (let c = 0; c < 20; c += 1) {
      data[r][c] = { v: r * 20 + c, m: String(r * 20 + c) };
    }
  }
  for (let r = 0; r < 5; r += 1) data[r][21] = { v: 10 * (r + 1), m: '' }; // V
  for (let r = 0; r < 3; r += 1) data[r][22] = { v: r + 1, m: '' }; // W
  for (let r = 0; r < 30; r += 1) data[r][23] = { v: 1, m: '1' }; // X
  const calcChain: any[] = [];
  for (let r = 0; r < 500; r += 1) {
    const row = (r % 20) + 1;
    data[r][SUM_COL] = formulaCell(reads, r, SUM_COL, `=SUM(A${row}:T${row})`);
    calcChain.push({ r, c: SUM_COL, id: 's1' });
  }
  Object.entries(SPECIALS).forEach(([name, { r, f }]) => {
    if (!runtimeRefs && (name === 'indirect' || name === 'offset')) return;
    data[r][SPECIAL_COL] = formulaCell(reads, r, SPECIAL_COL, f);
    calcChain.push({ r, c: SPECIAL_COL, id: 's1' });
  });
  ctx.luckysheetfile = [
    {
      id: 's1',
      name: 'Sheet1',
      order: 0,
      status: 1,
      data,
      config: {},
      calcChain,
    },
  ];
  ctx.currentSheetId = 's1';
  ctx.config = ctx.luckysheetfile[0].config;
  ctx.hooks = {};
  ctx.definedNames = [
    {
      id: 'dn1',
      name: 'Rates',
      sheetId: 's1',
      range: { row: [0, 2], column: [22, 22] },
      scope: 'workbook',
    },
  ];
  let evaluations = 0;
  const { parser } = ctx.formulaCache;
  const parse = parser.parse.bind(parser);
  parser.parse = (...args: any[]) => {
    evaluations += 1;
    return parse(...args);
  };
  return {
    ctx,
    reads,
    evaluations: () => evaluations,
    resetCounters: () => {
      reads.clear();
      evaluations = 0;
    },
  };
};

/** Drain a deferred (chunked) pass the way the Workbook does, then apply it. */
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

const values = (ctx: any) =>
  ctx.luckysheetfile[0].data.map((row: any[]) =>
    row.map((cell) => (cell == null ? null : cell.v)),
  );

const special = (ctx: any, name: keyof typeof SPECIALS) =>
  ctx.luckysheetfile[0].data[SPECIALS[name].r][SPECIAL_COL]?.v;

beforeAll(() => loadLocale('en'));

describe('C8 dependency-graph completeness flag', () => {
  it('is false on a fresh engine and true after one forced full pass', () => {
    const { ctx } = makeFixture();
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
    forceFullPass(ctx);
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
  });

  it('records INDEX, named-range and whole-column reads in the graph', () => {
    const { ctx } = makeFixture();
    forceFullPass(ctx);
    const { depsByCell, formulasWithWideRangeDeps } = ctx.formulaCache;
    const key = (r: number) => `s1:${r}:${SPECIAL_COL}`;
    expect(depsByCell.get(key(SPECIALS.index.r)).has('s1:2:21')).toBe(true);
    expect(depsByCell.get(key(SPECIALS.named.r)).has('s1:1:22')).toBe(true);
    expect(depsByCell.get(key(SPECIALS.wholeColumn.r)).has('s1:20:23')).toBe(
      true,
    );
    // INDIRECT and OFFSET resolve nothing through the graph, so they always run.
    expect(formulasWithWideRangeDeps.has(key(SPECIALS.indirect.r))).toBe(true);
    expect(formulasWithWideRangeDeps.has(key(SPECIALS.offset.r))).toBe(true);
  });

  it('a commit to an unreferenced cell processes no formula', () => {
    const { ctx, reads, evaluations, resetCounters } = makeFixture({
      runtimeRefs: false,
    });
    forceFullPass(ctx);
    resetCounters();
    commit(ctx, UNREFERENCED[0], UNREFERENCED[1], 'typed');
    expect(reads.size).toBe(0);
    expect(evaluations()).toBe(0);
  });

  it('with INDIRECT/OFFSET present, an unreferenced commit runs only those two', () => {
    const { ctx, reads, evaluations, resetCounters } = makeFixture();
    forceFullPass(ctx);
    resetCounters();
    commit(ctx, UNREFERENCED[0], UNREFERENCED[1], 'typed');
    expect([...reads].sort()).toEqual(
      [`0_${SPECIAL_COL}`, `1_${SPECIAL_COL}`].sort(),
    );
    expect(evaluations()).toBe(2);
  });

  it('a commit to a referenced cell gives the grid a forced full pass gives', () => {
    const { ctx } = makeFixture();
    forceFullPass(ctx);
    commit(ctx, 2, 0, 1000); // A3: 25 SUM formulas read it
    const afterCommit = values(ctx);
    expect(afterCommit[2][SUM_COL]).not.toBe(0);
    forceFullPass(ctx);
    expect(afterCommit).toEqual(values(ctx));
  });

  it('cells read through INDEX, a named range or a whole column still update their formula', () => {
    const { ctx } = makeFixture();
    forceFullPass(ctx);
    expect(special(ctx, 'index')).toBe(30);
    expect(special(ctx, 'named')).toBe(6);
    expect(special(ctx, 'wholeColumn')).toBe(30);

    commit(ctx, 2, 21, 7); // V3, read only by INDEX(V1:V5,3)
    expect(special(ctx, 'index')).toBe(7);
    commit(ctx, 1, 22, 20); // W2, inside Rates
    expect(special(ctx, 'named')).toBe(24);
    commit(ctx, 40, 23, 5); // X41, read only by SUM(X:X)
    expect(special(ctx, 'wholeColumn')).toBe(35);
  });

  it('after the grid grows, a commit takes the full pass again', () => {
    // Whole-column reads were recorded at the old size.
    const { ctx, reads, resetCounters } = makeFixture({ runtimeRefs: false });
    forceFullPass(ctx);
    expandRowsAndColumns(ctx.luckysheetfile[0].data, 10, 0); // as paste does
    resetCounters();
    commit(ctx, ROWS + 5, 23, 4); // X in a new row
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
    expect(reads.size).toBe(503);
  });

  it('cells read only through INDIRECT or OFFSET still re-run that formula', () => {
    const { ctx, reads, resetCounters } = makeFixture();
    forceFullPass(ctx);
    resetCounters();
    commit(ctx, 0, 21, 99); // V1
    expect(reads.has(`${SPECIALS.indirect.r}_${SPECIAL_COL}`)).toBe(true);
    resetCounters();
    commit(ctx, 1, 21, 98); // V2
    expect(reads.has(`${SPECIALS.offset.r}_${SPECIAL_COL}`)).toBe(true);
  });

  it('a remote formula batch keeps the flag, and a commit still updates that formula', () => {
    const { ctx } = makeFixture({ runtimeRefs: false });
    forceFullPass(ctx);
    // Arrives with the peer's value and is registered without being evaluated.
    applyRemoteCells(ctx, [{ r: 5, c: 29, v: { f: '=AC1*2', v: 0, m: '0' } }], {
      id: 's1',
    });
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
    commit(ctx, 0, 28, 21); // AC1
    expect(ctx.luckysheetfile[0].data[5][29].v).toBe(42);
  });

  it('a deferred full pass does not set the flag if the graph was cleared while it ran', () => {
    const { ctx } = makeFixture();
    execFunctionGroup(ctx, null as any, null as any, null, undefined, undefined, true);
    expect(ctx.formulaAsyncEval).toBeTruthy();
    runFormulaEvalChunk(ctx, ctx.formulaAsyncEval, 50);
    ctx.formulaCache.markDepGraphIncomplete();
    settle(ctx);
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
  });

  it('a forced pass leaves the flag false while a tab with formulas is sparse', () => {
    const { ctx } = makeFixture();
    ctx.luckysheetfile.push({
      id: 's2',
      name: 'Sheet2',
      order: 1,
      status: 0,
      celldata: [{ r: 0, c: 0, v: { f: '=Sheet1!AC1', v: 0, m: '0' } }],
      config: {},
      calcChain: [{ r: 0, c: 0, id: 's2' }],
    });
    forceFullPass(ctx);
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
  });

  it('a formula naming a missing sheet updates once that sheet exists', () => {
    const { ctx, reads } = makeFixture({ runtimeRefs: false });
    ctx.luckysheetfile.push({
      id: 's2',
      name: 'Bar',
      order: 1,
      status: 0,
      data: Array.from({ length: 5 }, () => Array(5).fill(null)),
      config: {},
      calcChain: [],
    });
    ctx.luckysheetfile[0].data[6][29] = formulaCell(reads, 6, 29, '=Foo!A1*2');
    ctx.luckysheetfile[0].calcChain.push({ r: 6, c: 29, id: 's1' });
    forceFullPass(ctx);
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
    expect(String(ctx.luckysheetfile[0].data[6][29].v)).toMatch(/^#/);
    setSheetName(ctx, 'Foo', { id: 's2' }); // rename; adding a sheet is the same case
    ctx.currentSheetId = 's2';
    commit(ctx, 0, 0, 50); // Foo!A1
    expect(ctx.luckysheetfile[0].data[6][29].v).toBe(100);
  });

  it('a worker-evaluated formula naming a missing sheet is kept on every run list', () => {
    const { ctx } = makeFixture({ runtimeRefs: false });
    const output = evalFormulasInSnapshot({
      sheets: [{ id: 's1', name: 'Sheet1', data: ctx.luckysheetfile[0].data }],
      execFunctionGlobalData: {},
      formulas: [{ r: 6, c: 29, id: 's1', calc_funcStr: '=Foo!A1*2' }],
    } as any);
    expect(output.results[0].unresolvedSheetRef).toBe(true);
    applyWorkerFormulaChunkResults(ctx, output, new Set(), new Set());
    expect(ctx.formulaCache.formulasWithWideRangeDeps.has('s1:6:29')).toBe(true);
  });

  it('resetFormulaDependencyIndexes clears the flag; the next commit takes the full pass', () => {
    const { ctx, reads, resetCounters } = makeFixture({ runtimeRefs: false });
    forceFullPass(ctx);
    resetFormulaDependencyIndexes(ctx);
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
    expect(ctx.formulaCache.depsByCell.size).toBe(0);
    expect(ctx.formulaCache.revDepsByCell.size).toBe(0);
    resetCounters();
    commit(ctx, UNREFERENCED[0], UNREFERENCED[1], 'typed');
    expect(reads.size).toBe(503);
  });

  it('setSheetCalcChain with an unchanged chain keeps the flag; the next commit takes the narrow path', () => {
    const { ctx, reads, resetCounters } = makeFixture({ runtimeRefs: false });
    forceFullPass(ctx);
    setSheetCalcChain(ctx, ctx.luckysheetfile[0].calcChain.slice(), {
      id: 's1',
    });
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
    resetCounters();
    commit(ctx, UNREFERENCED[0], UNREFERENCED[1], 'typed');
    expect(reads.size).toBe(0);
  });
});
