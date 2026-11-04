import type { Patch } from 'immer';
import type { Context } from '../context';
import { delFunctionGroupBatch, insertUpdateFunctionGroup } from './formula';

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
 *
 * A row-level patch lists every cell of the row, so most restored cells are
 * unchanged. The chain is read once into a set; only a formula missing from it
 * is added and only an entry whose cell lost its formula is removed (in one
 * batch). Calling insertUpdateFunctionGroup / delFunctionGroup per cell
 * scanned the chain each time: 6.8 s for 1,000 formulas on 1,000 rows.
 */
export function reregisterRestoredFormulas(
  ctx: Context,
  restored: RestoredCell[],
) {
  const bySheet = new Map<number, RestoredCell[]>();
  restored.forEach((cell) => {
    const list = bySheet.get(cell.sheetIndex);
    if (list) list.push(cell);
    else bySheet.set(cell.sheetIndex, [cell]);
  });

  bySheet.forEach((cells, sheetIndex) => {
    const sheet = ctx.luckysheetfile[sheetIndex];
    const id = sheet?.id;
    if (!id || !sheet.data) return;

    const inChain = new Set<string>();
    (sheet.calcChain ?? []).forEach((calc) => {
      if (calc.id === id) inChain.add(`${calc.r}_${calc.c}_${id}`);
    });

    const toDelete: { r: number; c: number }[] = [];
    cells.forEach(({ r, c }) => {
      const row = sheet.data?.[r];
      if (!row) return;
      const columns = c == null ? row.map((_cell, i) => i) : [c];
      columns.forEach((col) => {
        const key = `${r}_${col}_${id}`;
        if (row[col]?.f != null) {
          if (inChain.has(key)) return;
          insertUpdateFunctionGroup(ctx, r, col, id, inChain);
          inChain.add(key);
        } else if (inChain.has(key)) {
          toDelete.push({ r, c: col });
          inChain.delete(key);
        }
      });
    });
    // The grid shrank (undo of an insert): an entry that shifted into a removed
    // row or column is outside it, and no restored cell names it.
    const rows = sheet.data.length;
    const columns = sheet.data[0]?.length ?? 0;
    (sheet.calcChain ?? []).forEach((calc) => {
      if (calc.id !== id) return;
      if (calc.r >= rows || calc.c >= columns) {
        toDelete.push({ r: calc.r, c: calc.c });
      }
    });
    delFunctionGroupBatch(ctx, id, toDelete);
  });
}
