/**
 * C8 warm-up: build the formula dependency index after a sheet opens.
 *
 * C8 lets a commit to a cell nothing depends on skip the formula pass, but
 * only once `formulaCache.depGraphComplete` is true, and opening a sheet runs
 * no full pass. This walks the calc chain in small idle-time slices and reads
 * each formula's references from its text (`collectFormulaTextDeps`), without
 * evaluating anything, then marks the graph complete.
 *
 * Nothing outside `formulaCache`'s dependency indexes changes: no setContext,
 * no Immer update, no Yjs write, no cell value or error marker, no calc-chain
 * edit, no parser call, and no other tab's grid is loaded.
 */
import { Context } from '../context';
import { getcellFormula } from './cell';
import { collectFormulaTextDeps } from './formula-dep-text';
import type { WideRange } from './formula-transitive-deps';
import {
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
  /** Longest a slice keeps reading formulas before it yields (default 8). */
  budgetMs: number;
  /** Runs the next slice later (idle callback in the app). */
  schedule: (cb: () => void) => void;
  isCancelled?: () => boolean;
};

/** Same condition as a forced pass (C8): every tab holding formulas is dense. */
const formulaTabsDense = (ctx: Context) =>
  ctx.luckysheetfile.every((file) => !file.calcChain?.length || file.data);

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
  wideRangesByFormula: Map<string, WideRange[]>;
  /** The text each shadow entry was read from, by entry key. */
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
      shadow.wideRangesByFormula.delete(key);
    });
    formulaCache.depsByCell = shadow.depsByCell;
    formulaCache.revDepsByCell = shadow.revDepsByCell;
    formulaCache.formulasWithWideRangeDeps = shadow.formulasWithWideRangeDeps;
    formulaCache.wideRangesByFormula = shadow.wideRangesByFormula;
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
      const ranges = shadow.wideRangesByFormula.get(key);
      if (ranges) formulaCache.wideRangesByFormula.set(key, ranges);
      else formulaCache.wideRangesByFormula.delete(key);
    } else {
      formulasWithWideRangeDeps.delete(key);
      formulaCache.wideRangesByFormula.delete(key);
    }
  });
  stale.forEach((key) => {
    // A commit that re-evaluated it since the start recorded its own edges.
    if (depsByCell.get(key) === depsAtStart.get(key)) {
      formulasWithWideRangeDeps.add(key);
      formulaCache.wideRangesByFormula.delete(key);
    }
  });
  invalidateSheetsRequiredDenseCache();
}

/**
 * Read the references of formulas from `entries[start]` until `budgetMs` has
 * passed. Returns the index of the next formula.
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
  const realDeps = ctx.formulaCache.depsByCell;
  let i = start;
  let read = 0;
  while (i < entries.length) {
    if (read > 0 && performance.now() - t0 >= budgetMs) break;
    const entry = entries[i];
    i += 1;
    // Re-evaluated since the warm-up started (a commit, a deferred pass):
    // its dependencies come from text at least as new as this context's.
    if (realDeps.get(entry.key) !== depsAtStart.get(entry.key)) continue;
    const f = getcellFormula(ctx, entry.r, entry.c, entry.id);
    if (f == null) continue;
    read += 1;
    shadow.evaluatedFormula.set(entry.key, { f, entry });
    const { deps, wide, wideRanges } = collectFormulaTextDeps(
      ctx,
      f,
      entry.id,
      entry.r,
      entry.c,
    );
    shadow.depsByCell.set(entry.key, deps);
    deps.forEach((depKey) => {
      const rev = shadow.revDepsByCell.get(depKey) ?? new Set<string>();
      rev.add(entry.key);
      shadow.revDepsByCell.set(depKey, rev);
    });
    if (wide) {
      shadow.formulasWithWideRangeDeps.add(entry.key);
      if (wideRanges) shadow.wideRangesByFormula.set(entry.key, wideRanges);
    }
  }
  return i;
}

/**
 * Walk the calc chain in slices and read every formula's references, then
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
  const budgetMs = opts.budgetMs > 0 ? opts.budgetMs : FORMULA_WARMUP_BUDGET_MS;
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
      wideRangesByFormula: new Map(),
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
