/**
 * C8 warm-up: a dependency-only pass after a sheet opens.
 *
 * C8 lets a commit to a cell nothing depends on skip the formula pass, but
 * only once `formulaCache.depGraphComplete` is true, and opening a sheet runs
 * no full pass. This walks the calc chain in small idle-time slices and runs
 * each formula through `execfunction` only so that it records its
 * dependencies, then marks the graph complete. Results are discarded.
 *
 * Nothing outside `formulaCache`'s dependency indexes changes: no setContext,
 * no Immer update, no Yjs write, no cell value or error marker, no calc-chain
 * edit. See `runSlice` for how each side effect of `execfunction` is kept out.
 */
import * as formulajs from '@fileverse-dev/formulajs';
import { Context } from '../context';
import { Sheet } from '../types';
import { getcellFormula } from './cell';
import {
  execfunction,
  finishFullFormulaPass,
  FormulaCache,
  getAllFunctionGroup,
} from './formula';
import { isFormulaEvalPending } from './formula-async-eval';
import { invalidateSheetsRequiredDenseCache } from '../api/sheet-flowdata-lifecycle';

export const FORMULA_WARMUP_BUDGET_MS = 8;
export const FORMULA_WARMUP_DEBOUNCE_MS = 2000;
export const FORMULA_WARMUP_IDLE_TIMEOUT_MS = 1000;

export type FormulaWarmupResult = 'complete' | 'aborted';

export type FormulaWarmupOptions = {
  /** Longest a slice keeps evaluating before it yields (default 8). */
  budgetMs: number;
  /** Runs the next slice later (idle callback in the app). */
  schedule: (cb: () => void) => void;
  isCancelled?: () => boolean;
};

/**
 * `currentSheetId` of the context `execfunction` sees. No sheet has this id,
 * so `setCellError` and `clearCellError` (which write to the current sheet's
 * grid) find no grid and return.
 */
const NO_SHEET_ID = '__formula_warmup_no_sheet__';

/** What a network formula returns instead of being called: a promise, like the real one. */
const UNCALLED_ASYNC_RESULT = new Promise<never>(() => {});

let asyncFunctionNames: Set<string> | null = null;

/**
 * Formula functions that are `async` (they fetch over the network, e.g.
 * ETHERSCAN, EOA). The warm-up records their arguments but never calls them.
 */
export function isAsyncFormulaFunction(name: string): boolean {
  if (!asyncFunctionNames) {
    asyncFunctionNames = new Set();
    Object.entries(formulajs as Record<string, unknown>).forEach(([key, fn]) => {
      if (
        typeof fn === 'function' &&
        fn.constructor?.name === 'AsyncFunction'
      ) {
        asyncFunctionNames!.add(key.toUpperCase());
      }
    });
  }
  return asyncFunctionNames.has(String(name).toUpperCase());
}

/** Same condition as a forced pass (C8): every tab holding formulas is dense. */
const formulaTabsDense = (ctx: Context) =>
  ctx.luckysheetfile.every((file) => !file.calcChain?.length || file.data);

/**
 * A sparse tab as the warm-up's parser sees it. Reading its grid would
 * hydrate it (`ensureSheetFlowdata`); instead the formula reading it is put
 * on every commit's run list, as a reference to a missing sheet is (C8), and
 * the read fails.
 */
const sparseTabGuard = (file: Sheet, formulaCache: FormulaCache): Sheet => {
  const guarded = Object.create(file);
  Object.defineProperty(guarded, 'data', {
    get() {
      if (formulaCache.activeDepCollection) {
        formulaCache.activeDepCollection.hasWideRangeDep = true;
      }
      throw new Error('formula warm-up: sparse tab');
    },
  });
  return guarded;
};

type ChainEntry = { r: number; c: number; id: string; key: string };

/**
 * Dependency indexes the warm-up records into. The real ones in
 * `formulaCache` are untouched until the walk completes: the commit-path
 * narrowing trusts any recorded edge, so a partial graph would leave the
 * formulas not yet recorded stale.
 */
type ShadowIndexes = {
  depsByCell: Map<string, Set<string>>;
  revDepsByCell: Map<string, Set<string>>;
  formulasWithWideRangeDeps: Set<string>;
  /** The text each shadow entry was evaluated from, by entry key. */
  evaluatedFormula: Map<string, { f: string; entry: ChainEntry }>;
};

/**
 * Copy the shadow's entries into the real indexes. A formula whose real entry
 * changed since the warm-up started (a commit re-evaluated or removed it)
 * keeps the real one.
 */
function mergeShadowIndexes(
  ctx: Context,
  formulaCache: FormulaCache,
  shadow: ShadowIndexes,
  depsAtStart: Map<string, Set<string> | undefined>,
) {
  // An entry whose cell no longer holds the text it was evaluated from (an
  // undo or a collaborator's write that did not re-evaluate it) is dropped,
  // and the formula goes into formulasWithWideRangeDeps so it runs on every
  // commit: its new text's edges are unknown, and the completed graph would
  // otherwise never find it as a dependent.
  const stale = new Set<string>();
  shadow.evaluatedFormula.forEach(({ f, entry }, key) => {
    if (getcellFormula(ctx, entry.r, entry.c, entry.id) !== f) stale.add(key);
  });
  const { depsByCell, revDepsByCell, formulasWithWideRangeDeps } = formulaCache;
  if (
    depsByCell.size === 0 &&
    revDepsByCell.size === 0 &&
    formulasWithWideRangeDeps.size === 0
  ) {
    // Nothing recorded yet (the usual case after open): adopt the shadow.
    stale.forEach((key) => {
      shadow.depsByCell.get(key)?.forEach((depKey) => {
        const rev = shadow.revDepsByCell.get(depKey);
        if (!rev) return;
        rev.delete(key);
        if (rev.size === 0) shadow.revDepsByCell.delete(depKey);
      });
      shadow.depsByCell.delete(key);
      shadow.formulasWithWideRangeDeps.add(key);
    });
    formulaCache.depsByCell = shadow.depsByCell;
    formulaCache.revDepsByCell = shadow.revDepsByCell;
    formulaCache.formulasWithWideRangeDeps = shadow.formulasWithWideRangeDeps;
    invalidateSheetsRequiredDenseCache();
    return;
  }
  shadow.depsByCell.forEach((deps, key) => {
    if (depsByCell.get(key) !== depsAtStart.get(key)) return;
    if (stale.has(key)) return; // handled below
    const prev = depsByCell.get(key) ?? new Set<string>();
    depsByCell.set(key, deps);
    prev.forEach((depKey) => {
      if (deps.has(depKey)) return;
      const rev = revDepsByCell.get(depKey);
      if (!rev) return;
      rev.delete(key);
      if (rev.size === 0) revDepsByCell.delete(depKey);
    });
    deps.forEach((depKey) => {
      if (prev.has(depKey)) return;
      const rev = revDepsByCell.get(depKey) ?? new Set<string>();
      rev.add(key);
      revDepsByCell.set(depKey, rev);
    });
    if (shadow.formulasWithWideRangeDeps.has(key)) {
      formulasWithWideRangeDeps.add(key);
    } else {
      formulasWithWideRangeDeps.delete(key);
    }
  });
  stale.forEach((key) => {
    // A commit that re-evaluated it since the start recorded its own edges.
    if (depsByCell.get(key) === depsAtStart.get(key)) {
      formulasWithWideRangeDeps.add(key);
    }
  });
  invalidateSheetsRequiredDenseCache();
}

/**
 * Evaluate formulas from `entries[start]` until `budgetMs` has passed.
 * Returns the index of the next formula.
 */
function runSlice(
  ctx: Context,
  entries: ChainEntry[],
  start: number,
  depsAtStart: Map<string, Set<string> | undefined>,
  shadow: ShadowIndexes,
  budgetMs: number,
): number {
  const t0 = performance.now();
  const { formulaCache } = ctx;
  const { parser } = formulaCache;
  const yy = parser.parser.yy;

  // Scratch state execfunction or its callees touch, restored afterwards.
  // Captured before the try; everything that mutates shared state happens
  // inside it, so the finally restores even if the setup throws.
  const saved = {
    globalData: formulaCache.execFunctionGlobalData,
    rangeCache: formulaCache.rangeValuePassCache,
    rangeStats: formulaCache.rangeValuePassCacheStats,
    parserContext: parser.context,
    cryptoDenomination: parser.cryptoDenomination,
    cryptoDecimals: parser.cryptoDecimals,
    callFunction: yy.callFunction,
    depsByCell: formulaCache.depsByCell,
    revDepsByCell: formulaCache.revDepsByCell,
    wide: formulaCache.formulasWithWideRangeDeps,
  };
  const realDeps = saved.depsByCell;

  let i = start;
  let evaluated = 0;
  let warmCtx: Context;
  try {
    // execfunction records into whatever indexes formulaCache holds; for this
    // synchronous slice those are the shadow ones.
    formulaCache.depsByCell = shadow.depsByCell;
    formulaCache.revDepsByCell = shadow.revDepsByCell;
    formulaCache.formulasWithWideRangeDeps = shadow.formulasWithWideRangeDeps;
    // Read committed grid values, not a previous pass's leftovers, and keep
    // this slice's range reads out of any pass cache.
    formulaCache.execFunctionGlobalData = null;
    formulaCache.rangeValuePassCache = undefined;
    formulaCache.rangeValuePassCacheStats = undefined;
    // Arguments are evaluated (and recorded) before the function is called.
    yy.callFunction = (name: string, params: unknown[], ...rest: unknown[]) =>
      isAsyncFormulaFunction(name)
        ? UNCALLED_ASYNC_RESULT
        : saved.callFunction(name, params, ...rest);
    // execfunction writes `calculateSheetId` and error markers; the context in
    // state is frozen. A shallow copy takes the scratch field, and its
    // `currentSheetId` matches no sheet so error markers are not written.
    warmCtx = {
      ...ctx,
      currentSheetId: NO_SHEET_ID,
      luckysheetfile: ctx.luckysheetfile.map((file) =>
        file.data?.length ? file : sparseTabGuard(file, formulaCache),
      ),
    };
    while (i < entries.length) {
      if (evaluated > 0 && performance.now() - t0 >= budgetMs) break;
      const entry = entries[i];
      i += 1;
      // Re-evaluated since the warm-up started (a commit, a deferred pass):
      // its dependencies come from text at least as new as this context's.
      if (realDeps.get(entry.key) !== depsAtStart.get(entry.key)) {
        continue;
      }
      const f = getcellFormula(ctx, entry.r, entry.c, entry.id);
      if (f == null) continue;
      evaluated += 1;
      shadow.evaluatedFormula.set(entry.key, { f, entry });
      // isrefresh false: no execFunctionGroup. notInsertFunc true: no calc-chain edit.
      execfunction(warmCtx, f, entry.r, entry.c, entry.id, undefined, false, true);
    }
  } finally {
    formulaCache.depsByCell = saved.depsByCell;
    formulaCache.revDepsByCell = saved.revDepsByCell;
    formulaCache.formulasWithWideRangeDeps = saved.wide;
    formulaCache.execFunctionGlobalData = saved.globalData;
    formulaCache.rangeValuePassCache = saved.rangeCache;
    formulaCache.rangeValuePassCacheStats = saved.rangeStats;
    formulaCache.activeDepCollection = null;
    parser.context = saved.parserContext;
    parser.cryptoDenomination = saved.cryptoDenomination;
    parser.cryptoDecimals = saved.cryptoDecimals;
    yy.callFunction = saved.callFunction;
  }
  return i;
}

/**
 * Walk the calc chain in slices and record every formula's dependencies, then
 * mark the graph complete (C8). Resolves 'aborted' if the graph is cleared
 * while it runs, a tab holding formulas is sparse, or `isCancelled` says so.
 *
 * Pass a getter to read the latest context in each slice (the Workbook does);
 * a plain context is used as is.
 */
export function warmFormulaDependencyGraph(
  ctxOrGetter: Context | (() => Context),
  opts: FormulaWarmupOptions,
): Promise<FormulaWarmupResult> {
  const getCtx =
    typeof ctxOrGetter === 'function' ? ctxOrGetter : () => ctxOrGetter;
  const budgetMs =
    opts.budgetMs > 0 ? opts.budgetMs : FORMULA_WARMUP_BUDGET_MS;
  const startCtx = getCtx();
  const { formulaCache } = startCtx;
  const epoch = formulaCache.depGraphEpoch;

  return new Promise((resolve, reject) => {
    // No sheets yet: the data that arrives later is not an evaluated formula.
    if (!startCtx.luckysheetfile?.length || !formulaTabsDense(startCtx)) {
      resolve('aborted');
      return;
    }
    const seen = new Set<string>();
    const entries: ChainEntry[] = [];
    getAllFunctionGroup(startCtx).forEach((cell: any) => {
      const id = cell.id ?? startCtx.currentSheetId;
      const key = `${id}:${cell.r}:${cell.c}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ r: cell.r, c: cell.c, id, key });
    });
    const depsAtStart = new Map(
      entries.map((e) => [e.key, formulaCache.depsByCell.get(e.key)]),
    );
    const shadow: ShadowIndexes = {
      depsByCell: new Map(),
      revDepsByCell: new Map(),
      formulasWithWideRangeDeps: new Set(),
      evaluatedFormula: new Map(),
    };
    let next = 0;

    const slice = () => {
      try {
        const ctx = getCtx();
        if (
          opts.isCancelled?.() ||
          ctx.formulaCache !== formulaCache ||
          formulaCache.depGraphEpoch !== epoch ||
          !formulaTabsDense(ctx)
        ) {
          resolve('aborted');
          return;
        }
        // A deferred formula pass owns the pass-local caches; wait for it.
        if (isFormulaEvalPending(ctx)) {
          opts.schedule(slice);
          return;
        }
        next = runSlice(ctx, entries, next, depsAtStart, shadow, budgetMs);
        if (next < entries.length) {
          opts.schedule(slice);
          return;
        }
        // Publish the shadow only now, under the same epoch check (checked
        // above in this slice). An aborted walk just drops it.
        mergeShadowIndexes(ctx, formulaCache, shadow, depsAtStart);
        // Sheet sizes come from the context the walk started on: if a tab
        // grew since, a commit to it takes the full pass (C8 size guard).
        finishFullFormulaPass(startCtx, epoch);
        resolve(formulaCache.depGraphComplete ? 'complete' : 'aborted');
      } catch (e) {
        reject(e);
      }
    };
    opts.schedule(slice);
  });
}

/**
 * Run the warm-up in the app: on `trigger()` (data ready after mount) and
 * again `FORMULA_WARMUP_DEBOUNCE_MS` after each `markDepGraphIncomplete()`.
 * Slices run in idle callbacks (setTimeout without requestIdleCallback) and
 * only while the page is visible.
 */
export function scheduleFormulaWarmup(getCtx: () => Context): {
  trigger(): void;
  dispose(): void;
} {
  let disposed = false;
  let runId = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let waitingForVisible: Array<() => void> = [];
  const hasDocument = typeof document !== 'undefined';

  const isVisible = () =>
    !hasDocument || document.visibilityState === 'visible';

  // Pending idle or timer handles, cancelled on dispose; each maps to its callback.
  const pending = new Map<() => void, () => void>();

  const runWhenIdle = (cb: () => void) => {
    const run = () => {
      pending.delete(cb);
      cb();
    };
    if (typeof requestIdleCallback === 'function') {
      // The timeout keeps a page that is never idle (or a backgrounded
      // embed) from starving the warm-up; each slice is still budgeted.
      const handle = requestIdleCallback(run, {
        timeout: FORMULA_WARMUP_IDLE_TIMEOUT_MS,
      });
      pending.set(cb, () => cancelIdleCallback(handle));
    } else {
      const handle = setTimeout(run, 0);
      pending.set(cb, () => clearTimeout(handle));
    }
  };

  const schedule = (cb: () => void) => {
    if (disposed) {
      cb(); // the slice sees the cancellation and resolves
      return;
    }
    const whenVisible = () => {
      if (isVisible() || disposed) cb();
      else waitingForVisible.push(whenVisible);
    };
    runWhenIdle(whenVisible);
  };

  const onVisibilityChange = () => {
    if (!isVisible()) return;
    const waiting = waitingForVisible;
    waitingForVisible = [];
    waiting.forEach((cb) => runWhenIdle(cb));
  };

  const start = () => {
    if (disposed) return;
    const ctx = getCtx();
    if (ctx.formulaCache.depGraphComplete) return;
    runId += 1;
    const id = runId;
    warmFormulaDependencyGraph(getCtx, {
      budgetMs: FORMULA_WARMUP_BUDGET_MS,
      schedule,
      isCancelled: () => disposed || id !== runId,
    }).catch((e) => {
      console.error('formula dependency warm-up failed', e);
    });
  };

  const clearDebounce = () => {
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const unsubscribe = getCtx().formulaCache.onDepGraphIncomplete(() => {
    if (disposed) return;
    runId += 1; // a running warm-up stops at its next slice
    clearDebounce();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      start();
    }, FORMULA_WARMUP_DEBOUNCE_MS);
  });

  if (hasDocument) {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return {
    trigger() {
      clearDebounce();
      start();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      runId += 1;
      clearDebounce();
      unsubscribe();
      if (hasDocument) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      // Cancel queued slices, then run each once so its warm-up sees the
      // cancellation and resolves without evaluating anything.
      const queued = [...pending.keys(), ...waitingForVisible];
      pending.forEach((cancel) => cancel());
      pending.clear();
      waitingForVisible = [];
      queued.forEach((cb) => cb());
    },
  };
}
