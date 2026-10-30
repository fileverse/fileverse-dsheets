import { produce } from 'immer';
import { Context } from '../context';
import { ensureSheetFlowdata } from '../api/sheet';
import { collectSheetIdsFromFormulaText } from '../api/sheet-flowdata-lifecycle';

/**
 * Indexes of the tabs that are not loaded (no dense `data`) and hold a formula
 * naming the edited tab. A structural edit rewrites those formulas (K6).
 */
export function unloadedTabsReadingSheet(
  ctx: Context,
  editedSheetId: string,
): number[] {
  const indexes: number[] = [];
  ctx.luckysheetfile.forEach((sheet, index) => {
    if (!sheet || sheet.id === editedSheetId) return;
    if (sheet.data?.length || !Array.isArray(sheet.celldata)) return;
    const readsEdited = sheet.celldata.some((entry: any) => {
      const f = entry?.v?.f;
      if (typeof f !== 'string' || !f.includes('!')) return false;
      return collectSheetIdsFromFormulaText(ctx, f).has(editedSheetId);
    });
    if (readsEdited) indexes.push(index);
  });
  return indexes;
}

/**
 * Load the tabs a structural edit will rewrite, before the edit and outside
 * the change that history records (PR 466 N1, second review). The rewrite is
 * then recorded as cell patches on `data`, which undo and redo replay for just
 * the cells it touched: a peer's edits to the same tab are left alone, and the
 * tab can be loaded or unloaded again at undo time (`handleUndo` loads it for
 * `data` patches).
 *
 * Returns the same state object when nothing needs loading.
 */
export function loadTabsReadingSheet(
  ctx: Context,
  editedSheetId: string | undefined,
): Context {
  if (!editedSheetId) return ctx;
  const indexes = unloadedTabsReadingSheet(ctx, editedSheetId);
  if (indexes.length === 0) return ctx;
  return produce(ctx, (draft: Context) => {
    indexes.forEach((index) => ensureSheetFlowdata(draft, { index }));
  });
}
