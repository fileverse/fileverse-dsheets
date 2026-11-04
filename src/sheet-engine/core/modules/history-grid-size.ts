import type { Patch } from 'immer';
import type { Context } from '../context';

export type GridSizeChange = {
  sheetId: string;
  path: ['row'] | ['column'];
  value: number;
  type: 'update';
};

/**
 * Undo and redo of a row/column insert or delete change a sheet's `row` /
 * `column`. The forward edit writes them to Yjs (`emitGridSizeToYdoc`); history
 * wrote the restored cells only, so a peer kept the grown grid until a later
 * effect fixed it, and only for the current sheet.
 */
export function gridSizeChangesFromPatches(
  ctxAfter: Context,
  patches: Patch[],
): GridSizeChange[] {
  const out = new Map<string, GridSizeChange>();
  patches.forEach((p) => {
    const [root, sheetIndex, field] = p.path;
    if (root !== 'luckysheetfile' || typeof sheetIndex !== 'number') return;
    if (field !== 'row' && field !== 'column') return;
    const sheet = ctxAfter.luckysheetfile?.[sheetIndex];
    const value = sheet?.[field];
    if (!sheet?.id || typeof value !== 'number') return;
    out.set(`${sheet.id}:${field}`, {
      sheetId: String(sheet.id),
      path: [field],
      value,
      type: 'update',
    });
  });
  return [...out.values()];
}
