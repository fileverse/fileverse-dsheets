/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { updateCell } from './cell';
import { execFunctionGroup, groupValuesRefresh, runFormulaEvalChunk } from './formula';
import {
  scheduleFormulaWarmup,
  warmFormulaDependencyGraph,
} from './formula-warmup';

// Fixture: rows 0-19 x columns A-T hold values; 100 =SUM(A{n}:T{n}) row
// formulas sit in column Y (rows 0-99). Column AA holds optional special
// formulas. Column AC (28) is referenced by nothing.
const ROWS = 100;
const COLS = 30;
const SUM_COL = 24; // Y
const SPECIAL_COL = 26; // AA
const UNREFERENCED: [number, number] = [10, 28];
const FORMULAS = 100;

// Counts reads of a formula's text (the warm-up reads each once) and lets a
// test charge a cost per read.
let onFormulaRead: () => void = () => {};
let formulaReads = 0;

type Special = { r: number; f: string; cell?: Record<string, unknown> };

const formulaCell = (
  reads: Set<string>,
  r: number,
  c: number,
  f: string,
  extra: Record<string, unknown> = {},
) => {
  let text = f;
  const cell: any = { v: 0, m: '0', ...extra };
  Object.defineProperty(cell, 'f', {
    enumerable: true,
    configurable: true,
    get: () => {
      reads.add(`${r}_${c}`);
      formulaReads += 1;
      onFormulaRead();
      return text;
    },
    set: (next) => {
      text = next;
    },
  });
  return cell;
};

const makeFixture = (specials: Special[] = []) => {
  const reads = new Set<string>();
  formulaReads = 0;
  onFormulaRead = () => {};
  const globalCache = { undoList: [] as any[], redoList: [] as any[] };
  const ctx: any = defaultContext({
    globalCache,
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
  const calcChain: any[] = [];
  for (let r = 0; r < FORMULAS; r += 1) {
    const row = (r % 20) + 1;
    // Opened with the values a previous session computed.
    const sum = 400 * (row - 1) + 190;
    data[r][SUM_COL] = formulaCell(reads, r, SUM_COL, `=SUM(A${row}:T${row})`, {
      v: sum,
      m: String(sum),
    });
    calcChain.push({ r, c: SUM_COL, id: 's1' });
  }
  specials.forEach(({ r, f, cell }) => {
    data[r][SPECIAL_COL] = formulaCell(reads, r, SPECIAL_COL, f, cell);
    calcChain.push({ r, c: SPECIAL_COL, id: 's1' });
  });
  ctx.luckysheetfile = [
    { id: 's1', name: 'Sheet1', order: 0, status: 1, data, config: {}, calcChain },
  ];
  ctx.currentSheetId = 's1';
  ctx.config = ctx.luckysheetfile[0].config;
  ctx.hooks = {};
  let evaluations = 0;
  let onEvaluate = () => {};
  const { parser } = ctx.formulaCache;
  const parse = parser.parse.bind(parser);
  parser.parse = (...args: any[]) => {
    evaluations += 1;
    onEvaluate();
    return parse(...args);
  };
  return {
    ctx,
    reads,
    globalCache,
    evaluations: () => evaluations,
    setOnEvaluate: (fn: () => void) => {
      onEvaluate = fn;
    },
    setOnRead: (fn: () => void) => {
      onFormulaRead = fn;
    },
    formulaReads: () => formulaReads,
    resetCounters: () => {
      reads.clear();
      evaluations = 0;
    },
  };
};

/** Run a warm-up with a scheduler the test drives one slice at a time. */
const startWarmup = (ctxOrGetter: any, budgetMs = 8) => {
  const queue: Array<() => void> = [];
  const result = warmFormulaDependencyGraph(ctxOrGetter, {
    budgetMs,
    schedule: (cb) => queue.push(cb),
  });
  return {
    result,
    pending: () => queue.length,
    step: () => queue.shift()?.(),
    drain: async () => {
      while (queue.length) queue.shift()!();
      return result;
    },
  };
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

const forceFullPass = (ctx: any) => {
  execFunctionGroup(ctx, null as any, null as any, null, undefined, undefined, true);
  settle(ctx);
};

const values = (ctx: any) =>
  ctx.luckysheetfile[0].data.map((row: any[]) =>
    row.map((cell) => (cell == null ? null : cell.v)),
  );

const deepFreeze = (value: any, seen = new Set<any>()) => {
  if (value == null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.getOwnPropertyNames(value).forEach((key) => {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc && 'value' in desc) deepFreeze(desc.value, seen);
  });
  return Object.freeze(value);
};

/** The real dependency indexes, in a comparable form. */
const realIndexes = (ctx: any) => {
  const { depsByCell, revDepsByCell, formulasWithWideRangeDeps } =
    ctx.formulaCache;
  const map = (m: Map<string, Set<string>>) =>
    [...m].map(([k, s]) => [k, [...s].sort()]).sort();
  return JSON.stringify({
    deps: map(depsByCell),
    rev: map(revDepsByCell),
    wide: [...formulasWithWideRangeDeps].sort(),
  });
};

beforeAll(() => loadLocale('en'));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('warmFormulaDependencyGraph (C8 warm-up)', () => {
  it('a commit between two slices sees an untouched graph and gives the forced-pass grid', async () => {
    const { ctx } = makeFixture();
    const before = realIndexes(ctx);
    const run = startWarmup(ctx, 0.000001); // one formula per slice
    run.step(); // records row 0's SUM(A1:T1)
    expect(realIndexes(ctx)).toBe(before);
    // A1 is read by rows 0, 20, 40, 60 and 80.
    commit(ctx, 0, 0, 1000);
    const afterCommit = values(ctx);
    expect(afterCommit[20][SUM_COL]).toBe(1190); // 1000 + B1..T1 (1..19)
    await run.drain();
    expect(values(ctx)).toEqual(afterCommit); // the warm-up wrote no value
    forceFullPass(ctx);
    expect(afterCommit).toEqual(values(ctx));
  });

  it('an aborted warm-up leaves the real indexes exactly as they were', async () => {
    const { ctx } = makeFixture([{ r: 0, f: '=V1*2', cell: { v: 20, m: '20' } }]);
    commit(ctx, 1, SPECIAL_COL, '=V2*3'); // some real edges before the warm-up
    const before = realIndexes(ctx);
    expect(JSON.parse(before).deps.length).toBeGreaterThan(0);
    const run = startWarmup(ctx, 0.000001);
    for (let i = 0; i < 10; i += 1) run.step();
    ctx.formulaCache.markDepGraphIncomplete();
    expect(await run.drain()).toBe('aborted');
    expect(realIndexes(ctx)).toBe(before);
  });

  it('completes the graph, so a commit to an unreferenced cell reads no formula', async () => {
    const { ctx, reads, evaluations, resetCounters } = makeFixture();
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
    const status = await startWarmup(ctx).drain();
    expect(status).toBe('complete');
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
    resetCounters();
    commit(ctx, UNREFERENCED[0], UNREFERENCED[1], 'typed');
    expect(reads.size).toBe(0);
    expect(evaluations()).toBe(0);
  });

  it('writes nothing: no Yjs push, no hook, no state, values and calcChain untouched', async () => {
    const { ctx, globalCache } = makeFixture([
      { r: 0, f: '=NOW()', cell: { v: 45000.25, m: '2023-03-15 06:00' } },
      { r: 1, f: '=1/0', cell: { v: '#DIV/0!', m: '#DIV/0!', error: { title: 'Error' } } },
      { r: 2, f: '=AA3+1', cell: { v: '#CIRC!', m: '#CIRC!' } }, // refers to itself
      { r: 3, f: '=V1*2', cell: { v: 999, m: '999', error: { title: 'stale' } } },
      { r: 4, f: '=RAND()', cell: { v: 0.5, m: '0.5' } },
    ]);
    const hookAccess: string[] = [];
    ctx.hooks = new Proxy(
      {},
      {
        get: (_t, prop) => {
          hookAccess.push(String(prop));
          return undefined;
        },
      },
    );
    const files = ctx.luckysheetfile;
    const sheet = files[0];
    const { calcChain } = sheet;
    const before = JSON.stringify(sheet.data);
    deepFreeze(files); // any write to the sheet state throws
    const undoBefore = globalCache.undoList.length;
    const parserContextBefore = ctx.formulaCache.parser.context;

    const status = await startWarmup(ctx).drain();

    expect(status).toBe('complete');
    expect(hookAccess).toEqual([]); // updateCellYdoc and every other hook unused
    expect(ctx.groupValuesRefreshData).toEqual([]);
    expect(ctx.luckysheetfile).toBe(files);
    expect(ctx.luckysheetfile[0]).toBe(sheet);
    expect(ctx.luckysheetfile[0].calcChain).toBe(calcChain);
    expect(globalCache.undoList.length).toBe(undoBefore);
    expect(JSON.stringify(ctx.luckysheetfile[0].data)).toBe(before);
    expect(sheet.data[0][SPECIAL_COL].v).toBe(45000.25);
    expect(sheet.data[0][SPECIAL_COL].m).toBe('2023-03-15 06:00');
    // Pass-local scratch is left as it was.
    expect(ctx.formulaCache.execFunctionGlobalData).toEqual({});
    expect(ctx.formulaCache.rangeValuePassCache).toBeUndefined();
    expect(ctx.formulaCache.parser.context).toBe(parserContextBefore);
  });

  it('returns aborted and leaves the flag false if the graph is cleared mid-warm-up', async () => {
    const { ctx, evaluations } = makeFixture();
    const run = startWarmup(ctx, 0.000001); // one formula per slice
    run.step();
    run.step();
    expect(run.pending()).toBe(1);
    ctx.formulaCache.markDepGraphIncomplete();
    const evaluatedBefore = evaluations();
    expect(await run.drain()).toBe('aborted');
    expect(evaluations()).toBe(evaluatedBefore); // stops at the next slice
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
  });

  it('keeps each slice within budgetMs (stub clock)', async () => {
    const { ctx, setOnRead, formulaReads: readCount } = makeFixture();
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    setOnRead(() => {
      clock += 3; // each formula costs 3 ms
    });
    const run = startWarmup(ctx, 8);
    const perSlice: number[] = [];
    const elapsed: number[] = [];
    while (run.pending()) {
      const e0 = readCount();
      const c0 = clock;
      run.step();
      perSlice.push(readCount() - e0);
      elapsed.push(clock - c0);
    }
    expect(await run.result).toBe('complete');
    // 8 ms budget, 3 ms per formula: a slice stops once 8 ms have passed.
    // (The last slice also re-reads every formula once to check its text.)
    expect(Math.max(...perSlice.slice(0, -1))).toBe(3);
    expect(perSlice.slice(0, -1).every((n) => n === 3)).toBe(true);
    expect(perSlice.length).toBeGreaterThan(10);
    // No formula starts after the budget is spent: elapsed <= budget + one formula.
    expect(Math.max(...elapsed.slice(0, -1))).toBeLessThanOrEqual(8 + 3);
  });

  it('after warm-up, a commit to a referenced cell gives the grid a forced full pass gives', async () => {
    const { ctx } = makeFixture([
      { r: 0, f: '=V1*2', cell: { v: 20, m: '20' } },
    ]);
    await startWarmup(ctx).drain();
    commit(ctx, 2, 0, 1000); // A3: 5 SUM formulas read it
    commit(ctx, 0, 21, 7); // V1
    const afterCommit = values(ctx);
    expect(afterCommit[2][SUM_COL]).toBe(1950); // 1000 + B3..T3 (41..59)
    expect(afterCommit[0][SPECIAL_COL]).toBe(14);
    forceFullPass(ctx);
    expect(afterCommit).toEqual(values(ctx));
  });

  it('does not overwrite dependencies a commit recorded from newer formula text', async () => {
    // The Workbook reads the context through a ref that can lag one update.
    const { ctx } = makeFixture();
    const sheet = ctx.luckysheetfile[0];
    const stale = {
      ...ctx,
      luckysheetfile: [
        {
          ...sheet,
          data: sheet.data.map((row: any[]) =>
            row.map((cell) => (cell == null ? cell : { ...cell })),
          ),
        },
      ],
    };
    const run = startWarmup(() => stale, 0.000001);
    run.step();
    // Row 50's formula now reads AC6 instead of A11:T11.
    commit(ctx, 50, SUM_COL, '=AC6*2');
    expect(await run.drain()).toBe('complete');
    const deps = ctx.formulaCache.depsByCell.get(`s1:50:${SUM_COL}`);
    expect([...deps]).toEqual(['s1:5:28']);
    commit(ctx, 5, 28, 21);
    expect(ctx.luckysheetfile[0].data[50][SUM_COL].v).toBe(42);
  });

  it('keeps a commit\'s dependencies over the shadow entry recorded before it', async () => {
    const { ctx } = makeFixture();
    const run = startWarmup(ctx, 0.000001);
    for (let i = 0; i < 60; i += 1) run.step(); // row 50 is in the shadow now
    commit(ctx, 50, SUM_COL, '=AC6*2');
    expect(await run.drain()).toBe('complete');
    expect([...ctx.formulaCache.depsByCell.get(`s1:50:${SUM_COL}`)]).toEqual([
      's1:5:28',
    ]);
    expect(ctx.formulaCache.revDepsByCell.get('s1:10:0')?.has(`s1:50:${SUM_COL}`)).toBeFalsy();
    commit(ctx, 5, 28, 21);
    expect(ctx.luckysheetfile[0].data[50][SUM_COL].v).toBe(42);
  });

  it('does not merge the shadow entry of a formula whose text changed after it was evaluated', async () => {
    const { ctx } = makeFixture();
    const run = startWarmup(ctx, 0.000001);
    for (let i = 0; i < 60; i += 1) run.step(); // row 50 is evaluated
    // Edited without a re-evaluation (an undo, a collaborator's write).
    ctx.luckysheetfile[0].data[50][SUM_COL].f = '=AC6*2';
    // Removed outright.
    ctx.luckysheetfile[0].data[51][SUM_COL] = null;
    expect(await run.drain()).toBe('complete');
    const { depsByCell, revDepsByCell } = ctx.formulaCache;
    expect(depsByCell.has(`s1:50:${SUM_COL}`)).toBe(false);
    expect(depsByCell.has(`s1:51:${SUM_COL}`)).toBe(false);
    expect(revDepsByCell.get('s1:10:0')?.has(`s1:50:${SUM_COL}`)).toBeFalsy();
    expect(revDepsByCell.get('s1:10:0')?.has(`s1:51:${SUM_COL}`)).toBeFalsy();
    expect(depsByCell.has(`s1:52:${SUM_COL}`)).toBe(true); // untouched rows kept
    // A commit to a cell the new text reads still recalculates it.
    commit(ctx, 5, 28, 21);
    expect(ctx.luckysheetfile[0].data[50][SUM_COL].v).toBe(42);
  });

  it('skips a stale shadow entry on the per-key merge path too', async () => {
    const { ctx } = makeFixture([{ r: 0, f: '=V1*2', cell: { v: 20, m: '20' } }]);
    commit(ctx, 1, SPECIAL_COL, '=V2*3'); // real edges exist: no whole adoption
    const run = startWarmup(ctx, 0.000001);
    for (let i = 0; i < 60; i += 1) run.step();
    ctx.luckysheetfile[0].data[50][SUM_COL].f = '=AC6*2';
    expect(await run.drain()).toBe('complete');
    const { depsByCell, revDepsByCell } = ctx.formulaCache;
    expect(depsByCell.has(`s1:50:${SUM_COL}`)).toBe(false);
    expect(revDepsByCell.get('s1:10:0')?.has(`s1:50:${SUM_COL}`)).toBeFalsy();
    expect(depsByCell.has(`s1:52:${SUM_COL}`)).toBe(true);
    commit(ctx, 5, 28, 21);
    expect(ctx.luckysheetfile[0].data[50][SUM_COL].v).toBe(42);
  });

  it('evaluates nothing: no parser call, no pass-local scratch, no function called', async () => {
    const { ctx, evaluations } = makeFixture([
      { r: 0, f: '=NOW()' },
      { r: 1, f: '=INDEX(A1:A100,5)' },
    ]);
    const { formulaCache } = ctx;
    const globalData = formulaCache.execFunctionGlobalData;
    expect(await startWarmup(ctx).drain()).toBe('complete');
    expect(evaluations()).toBe(0);
    expect(formulaCache.execFunctionGlobalData).toBe(globalData);
    expect(formulaCache.rangeValuePassCache).toBeUndefined();
  });

  // K11: INDIRECT and OFFSET read cells the dependency graph cannot see. The
  // warm-up must leave them on every commit's run list, whatever edges it
  // recorded for them.
  it('keeps INDIRECT and OFFSET formulas on the run list of every commit', async () => {
    const { ctx, reads, evaluations, resetCounters } = makeFixture([
      { r: 0, f: '=INDIRECT("V1")' },
      { r: 1, f: '=OFFSET(V1,1,0)' },
    ]);
    expect(await startWarmup(ctx).drain()).toBe('complete');
    const wide = ctx.formulaCache.formulasWithWideRangeDeps;
    expect(wide.has(`s1:0:${SPECIAL_COL}`)).toBe(true);
    expect(wide.has(`s1:1:${SPECIAL_COL}`)).toBe(true);
    resetCounters();
    commit(ctx, UNREFERENCED[0], UNREFERENCED[1], 'typed');
    expect([...reads].sort()).toEqual(
      [`0_${SPECIAL_COL}`, `1_${SPECIAL_COL}`].sort(),
    );
    expect(evaluations()).toBe(2);
  });

  it('keeps them on the list when the formula text changes after the warm-up evaluated it', async () => {
    const { ctx } = makeFixture([{ r: 0, f: '=INDIRECT("V1")' }]);
    const run = startWarmup(ctx);
    run.step();
    // A commit rewrites the formula text between two slices.
    commit(ctx, 0, SPECIAL_COL, { f: '=OFFSET(V1,1,0)', v: 0, m: '0' });
    await run.drain();
    expect(
      ctx.formulaCache.formulasWithWideRangeDeps.has(`s1:0:${SPECIAL_COL}`),
    ).toBe(true);
  });

  it('a formula with a space between references is recalculated when either changes (index built from text)', async () => {
    const { ctx } = makeFixture([
      { r: 0, f: '=SUM(V1, V2)', cell: { v: 30, m: '30' } },
      { r: 1, f: '=V1 + V2', cell: { v: 30, m: '30' } },
      { r: 2, f: '=INDEX(V1:V5,2)', cell: { v: 20, m: '20' } },
    ]);
    expect(await startWarmup(ctx).drain()).toBe('complete');
    commit(ctx, 1, 21, 100); // V2
    const grid = values(ctx);
    expect(grid[0][SPECIAL_COL]).toBe(110);
    expect(grid[1][SPECIAL_COL]).toBe(110);
    expect(grid[2][SPECIAL_COL]).toBe(100);
    forceFullPass(ctx);
    expect(values(ctx)).toEqual(grid);
  });

  it('does not hydrate a sparse tab a formula reads, and records its edge', async () => {
    const { ctx } = makeFixture([{ r: 0, f: '=Sheet2!A1*2' }]);
    ctx.luckysheetfile.push({
      id: 's2',
      name: 'Sheet2',
      order: 1,
      status: 0,
      celldata: [{ r: 0, c: 0, v: { v: 21, m: '21' } }],
      config: {},
      calcChain: [],
    });
    expect(await startWarmup(ctx).drain()).toBe('complete');
    expect(ctx.luckysheetfile[1].data).toBeUndefined();
    expect(
      ctx.formulaCache.formulasWithWideRangeDeps.has(`s1:0:${SPECIAL_COL}`),
    ).toBe(false);
    expect(
      ctx.formulaCache.revDepsByCell.get('s2:0:0')?.has(`s1:0:${SPECIAL_COL}`),
    ).toBe(true);
  });

  it('marks a whole-column reference into a sparse tab wide, without hydrating it', async () => {
    const { ctx } = makeFixture([{ r: 0, f: '=SUM(Sheet2!A:A)' }]);
    ctx.luckysheetfile.push({
      id: 's2',
      name: 'Sheet2',
      order: 1,
      status: 0,
      celldata: [{ r: 0, c: 0, v: { v: 21, m: '21' } }],
      config: {},
      calcChain: [],
    });
    expect(await startWarmup(ctx).drain()).toBe('complete');
    expect(ctx.luckysheetfile[1].data).toBeUndefined();
    expect(
      ctx.formulaCache.formulasWithWideRangeDeps.has(`s1:0:${SPECIAL_COL}`),
    ).toBe(true);
  });

  it('leaves the flag false while a tab holding formulas is sparse', async () => {
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
    expect(await startWarmup(ctx).drain()).toBe('aborted');
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
    expect(ctx.luckysheetfile[1].data).toBeUndefined();
  });

  it('records the arguments of a network function without calling it', async () => {
    vi.useFakeTimers();
    // FLVURL is async and starts a 10 s timer when it is called.
    const { ctx } = makeFixture([{ r: 0, f: '=FLVURL(V1)' }]);
    expect(await startWarmup(ctx).drain()).toBe('complete');
    expect(vi.getTimerCount()).toBe(0);
    const deps = ctx.formulaCache.depsByCell.get(`s1:0:${SPECIAL_COL}`);
    expect(deps.has('s1:0:21')).toBe(true);
  });
});

describe('scheduleFormulaWarmup', () => {
  const stubDocument = (state: 'visible' | 'hidden') => {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: state,
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'visibilitychange') listeners.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        if (type === 'visibilitychange') listeners.delete(fn);
      },
      setVisibility(next: 'visible' | 'hidden') {
        doc.visibilityState = next;
        listeners.forEach((fn) => fn());
      },
    };
    vi.stubGlobal('document', doc);
    return doc;
  };

  const stubIdle = () => {
    const idle = vi.fn((cb: () => void) => setTimeout(cb, 1));
    vi.stubGlobal('requestIdleCallback', idle);
    vi.stubGlobal(
      'cancelIdleCallback',
      vi.fn((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle)),
    );
    return idle;
  };

  it('runs on trigger through requestIdleCallback while the page is visible', () => {
    vi.useFakeTimers();
    stubDocument('visible');
    const idle = stubIdle();
    const { ctx } = makeFixture();
    const warmup = scheduleFormulaWarmup(() => ctx);
    warmup.trigger();
    vi.advanceTimersByTime(1000);
    expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 1000 });
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
    warmup.dispose();
  });

  it('falls back to setTimeout without requestIdleCallback', () => {
    vi.useFakeTimers();
    stubDocument('visible');
    vi.stubGlobal('requestIdleCallback', undefined);
    const { ctx } = makeFixture();
    const warmup = scheduleFormulaWarmup(() => ctx);
    warmup.trigger();
    vi.advanceTimersByTime(1000);
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
    warmup.dispose();
  });

  it('waits while the page is hidden', () => {
    vi.useFakeTimers();
    const doc = stubDocument('hidden');
    stubIdle();
    const { ctx, evaluations } = makeFixture();
    const warmup = scheduleFormulaWarmup(() => ctx);
    warmup.trigger();
    vi.advanceTimersByTime(10_000);
    expect(evaluations()).toBe(0);
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
    doc.setVisibility('visible');
    vi.advanceTimersByTime(1000);
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
    warmup.dispose();
  });

  it('re-warms 2000 ms after markDepGraphIncomplete, including one that aborted a warm-up', () => {
    vi.useFakeTimers();
    stubDocument('visible');
    stubIdle();
    const { ctx, setOnRead } = makeFixture();
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    setOnRead(() => {
      clock += 3; // 3 formulas per 8 ms slice, one slice per idle callback
    });
    const warmup = scheduleFormulaWarmup(() => ctx);
    warmup.trigger();
    vi.advanceTimersByTime(5); // a few slices in
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
    ctx.formulaCache.markDepGraphIncomplete(); // aborts the running warm-up
    vi.advanceTimersByTime(1999);
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
    vi.advanceTimersByTime(1 + 100);
    expect(ctx.formulaCache.depGraphComplete).toBe(true);

    // A later clear (an undo, a remote calcChain) schedules one more warm-up.
    ctx.formulaCache.markDepGraphIncomplete();
    ctx.formulaCache.markDepGraphIncomplete(); // debounced: one run
    vi.advanceTimersByTime(1999);
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
    vi.advanceTimersByTime(1 + 100);
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
    warmup.dispose();
  });

  it('cancels its pending idle callback and debounce timer on dispose', () => {
    vi.useFakeTimers();
    stubDocument('visible');
    stubIdle();
    const { ctx, evaluations } = makeFixture();
    const warmup = scheduleFormulaWarmup(() => ctx);
    warmup.trigger(); // a slice is now queued in an idle callback
    expect(vi.getTimerCount()).toBe(1);
    warmup.dispose();
    expect(cancelIdleCallback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(evaluations()).toBe(0);

    const second = scheduleFormulaWarmup(() => ctx);
    ctx.formulaCache.markDepGraphIncomplete(); // 2000 ms debounce timer
    expect(vi.getTimerCount()).toBe(1);
    second.dispose();
    expect(vi.getTimerCount()).toBe(0);

    vi.stubGlobal('requestIdleCallback', undefined); // setTimeout fallback
    const third = scheduleFormulaWarmup(() => ctx);
    third.trigger();
    expect(vi.getTimerCount()).toBe(1);
    third.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(evaluations()).toBe(0);
  });

  it('does nothing after dispose', () => {
    vi.useFakeTimers();
    stubDocument('visible');
    stubIdle();
    const { ctx, evaluations } = makeFixture();
    const warmup = scheduleFormulaWarmup(() => ctx);
    warmup.dispose();
    warmup.trigger();
    ctx.formulaCache.markDepGraphIncomplete();
    vi.advanceTimersByTime(5000);
    expect(evaluations()).toBe(0);
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
  });
});
