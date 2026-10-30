import { produce } from 'immer';
import { Context } from '../context';
import { ensureSheetFlowdata } from '../api/sheet';
import { collectSheetIdsFromFormulaText } from '../api/sheet-flowdata-lifecycle';
import { getSheetIndex } from '../utils';
import { celldataFormulaWouldChange } from './rowcol';

export type StructuralEditOp = {
  insertRowColOp?: {
    type: 'row' | 'column';
    id: string;
    index: number;
    count: number;
    direction: 'lefttop' | 'rightbottom';
  };
  deleteRowColOp?: {
    type: 'row' | 'column';
    id: string;
    start: number;
    end: number;
  };
};

/**
 * Indexes of the tabs that are not loaded (no dense `data`) and that the edit
 * rewrites (K6). A tab counts when the rewrite itself would change one of its
 * formulas, or when one names the edited tab. The first is the test the
 * rewrite uses, so the two cannot disagree: the sheet-name regex reads
 * `=C1-A!B5` as a tab called `C1-A` and finds no tab A (PR 466 N1).
 */
export function unloadedTabsRewrittenBy(
  ctx: Context,
  op: StructuralEditOp,
): number[] {
  const editedSheetId = op.insertRowColOp?.id ?? op.deleteRowColOp?.id;
  const editedIndex =
    editedSheetId != null ? getSheetIndex(ctx, editedSheetId) : null;
  const edited = editedIndex != null ? ctx.luckysheetfile[editedIndex] : null;
  if (!editedSheetId || !edited) return [];
  const insert = op.insertRowColOp;
  const del = op.deleteRowColOp;
  const indexes: number[] = [];
  ctx.luckysheetfile.forEach((sheet, index) => {
    if (!sheet || sheet.id === editedSheetId) return;
    if (sheet.data?.length || !Array.isArray(sheet.celldata)) return;
    const wouldChange = insert
      ? celldataFormulaWouldChange(
          sheet,
          'add',
          insert.type === 'row' ? 'row' : 'col',
          insert.direction,
          insert.index,
          insert.count,
          edited.name,
        )
      : del
      ? celldataFormulaWouldChange(
          sheet,
          'del',
          del.type === 'row' ? 'row' : 'col',
          null,
          del.start,
          del.end - del.start + 1,
          edited.name,
        )
      : false;
    const namesEdited =
      wouldChange ||
      sheet.celldata.some((entry: any) => {
        const f = entry?.v?.f;
        if (typeof f !== 'string' || !f.includes('!')) return false;
        return collectSheetIdsFromFormulaText(ctx, f).has(editedSheetId);
      });
    if (namesEdited) indexes.push(index);
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
  op: StructuralEditOp,
): Context {
  const indexes = unloadedTabsRewrittenBy(ctx, op);
  if (indexes.length === 0) return ctx;
  return produce(ctx, (draft: Context) => {
    indexes.forEach((index) => ensureSheetFlowdata(draft, { index }));
  });
}
