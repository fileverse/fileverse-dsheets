/**
 * Replace one formula cell's dependency edges from its text, without
 * evaluating it (C8). A collaborator's formula arrives with its computed value,
 * so the engine registers it unevaluated; reading its references from the text
 * keeps `depGraphComplete` true instead of sending commits back to the full
 * formula pass until the next warm-up.
 */
import type { Context } from '../context';
import { collectFormulaTextDeps } from './formula-dep-text';
import { dropDependencyEdges, mergeFormulaDeps } from './formula';

/**
 * Set the edges of the formula `f` written in (`r`, `c`) of tab `sheetId`, or
 * drop them when `f` is null (the value is no longer a formula).
 */
export function setFormulaEdgesFromText(
  ctx: Context,
  r: number,
  c: number,
  sheetId: string,
  f: string | null,
) {
  if (f == null) {
    dropDependencyEdges(ctx, r, c, sheetId);
    return;
  }
  const { formulaCache } = ctx;
  const key = `${sheetId}:${r}:${c}`;
  const { deps, wide, wideRanges } = collectFormulaTextDeps(
    ctx,
    f,
    sheetId,
    r,
    c,
  );
  mergeFormulaDeps(ctx, key, deps);
  if (wide) {
    formulaCache.formulasWithWideRangeDeps.add(key);
    if (wideRanges) formulaCache.wideRangesByFormula.set(key, wideRanges);
    else formulaCache.wideRangesByFormula.delete(key);
  } else {
    formulaCache.formulasWithWideRangeDeps.delete(key);
    formulaCache.wideRangesByFormula.delete(key);
  }
}

/**
 * A chain entry whose cell isn't here yet (a peer's chain can arrive before
 * its cells): it can't be read, so it runs on every commit until the cell
 * arrives and replaces this.
 */
export function markFormulaEdgesUnknown(
  ctx: Context,
  r: number,
  c: number,
  sheetId: string,
) {
  const key = `${sheetId}:${r}:${c}`;
  ctx.formulaCache.formulasWithWideRangeDeps.add(key);
  ctx.formulaCache.wideRangesByFormula.delete(key);
}
