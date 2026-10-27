import type { Patch } from 'immer';
import type { Context } from '../context';
import { delFunctionGroup, insertUpdateFunctionGroup } from './formula';

/**
 * Undo and redo apply Immer patches that address `calcChain` by array index.
 * After a collaborator's formula list has replaced the sheet's chain (A4),
 * those indexes point into a different array, so replaying them can truncate
 * it and drop the collaborator's formulas; the calcChain hook would then
 * delete those entries from Yjs for everyone.
 *
 * So history never restores `calcChain` from patches. The cells it restores
 * are re-registered from their own `f` instead (`reregisterRestoredFormulas`).
 */

export type RestoredCell = { sheetIndex: number; r: number; c: number | null };

const isCalcChainPatch = (p: Patch) =>
  p.path[0] === 'luckysheetfile' &&
  typeof p.path[1] === 'number' &&
  p.path[2] === 'calcChain';

/** Patches that replace a whole sheet or a whole grid: cells can't be listed. */
const isCoarsePatch = (p: Patch) =>
  p.path[0] === 'luckysheetfile' &&
  (p.path.length <= 2 || (p.path[2] === 'data' && p.path.length <= 3));

/**
 * `patches` without the calcChain ones, and the cells whose formulas must be
 * re-registered afterwards. When a patch replaces a whole sheet or grid the
 * cells can't be listed, so history is left as it was (`restored` is null).
 */
export function planHistoryPatches(patches: Patch[]): {
  patches: Patch[];
  restored: RestoredCell[] | null;
} {
  if (!patches.some(isCalcChainPatch)) return { patches, restored: [] };
  if (patches.some(isCoarsePatch)) return { patches, restored: null };

  const restored = new Map<string, RestoredCell>();
  patches.forEach((p) => {
    if (p.path[0] !== 'luckysheetfile' || p.path[2] !== 'data') return;
    const [, sheetIndex, , r, c] = p.path;
    if (typeof sheetIndex !== 'number' || typeof r !== 'number') return;
    const cell = { sheetIndex, r, c: typeof c === 'number' ? c : null };
    restored.set(`${sheetIndex}_${r}_${cell.c}`, cell);
  });
  return {
    patches: patches.filter((p) => !isCalcChainPatch(p)),
    restored: [...restored.values()],
  };
}

/**
 * Register the restored cells that hold a formula and drop the ones that no
 * longer do. Run on a draft after the patches were applied. The graph is left
 * incomplete: restored formulas are not evaluated.
 */
export function reregisterRestoredFormulas(
  ctx: Context,
  restored: RestoredCell[],
) {
  restored.forEach(({ sheetIndex, r, c }) => {
    const sheet = ctx.luckysheetfile[sheetIndex];
    const id = sheet?.id;
    const row = sheet?.data?.[r];
    if (!id || !row) return;
    const columns = c == null ? row.map((_cell, i) => i) : [c];
    columns.forEach((col) => {
      if (row[col]?.f != null) insertUpdateFunctionGroup(ctx, r, col, id);
      else delFunctionGroup(ctx, r, col, id);
    });
  });
}
