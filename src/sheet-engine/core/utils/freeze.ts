import { getSheetIndex } from '.';
import { Context } from '../context';

export const getFreezeState = (ctx: Context) => {
  const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
  if (sheetIndex == null) return { isRowFrozen: false, isColFrozen: false };

  const frozen = ctx.luckysheetfile[sheetIndex]?.frozen;
  const selection = ctx.luckysheet_select_save?.[0];
  if (!selection) return { isRowFrozen: false, isColFrozen: false };

  const frozenRow = frozen?.range?.row_focus;
  const frozenCol = frozen?.range?.column_focus;

  const isRowFrozen =
    typeof frozenRow === 'number' && frozenRow === selection.row_focus;

  const isColFrozen =
    typeof frozenCol === 'number' && frozenCol === selection.column_focus;

  return {
    isRowFrozen,
    isColFrozen,
  };
};

/**
 * Pixel size (in the same zoomed screen-pixel space as visibledatarow /
 * visibledatacolumn) of the frozen strip currently pinned to the top-left
 * of the viewport. Zero on an axis that isn't frozen.
 *
 * Frozen rows/columns are only ever redrawn at a fixed on-screen position
 * by the canvas itself -- there's no separate DOM layer for them -- so any
 * DOM overlay positioned in document space (e.g. inserted images) needs
 * this boundary to know when it has scrolled into the area the frozen
 * pane owns and should stay hidden behind it.
 */
export const getFrozenPixelBounds = (
  ctx: Context,
): { widthPx: number; heightPx: number } => {
  const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
  const frozen =
    sheetIndex == null ? undefined : ctx.luckysheetfile[sheetIndex]?.frozen;
  if (!frozen) return { widthPx: 0, heightPx: 0 };

  const { row_focus, column_focus } = frozen.range ?? {
    row_focus: -1,
    column_focus: -1,
  };

  const hasRowFreeze =
    frozen.type === 'row' ||
    frozen.type === 'both' ||
    frozen.type === 'rangeRow' ||
    frozen.type === 'rangeBoth';
  const hasColFreeze =
    frozen.type === 'column' ||
    frozen.type === 'both' ||
    frozen.type === 'rangeColumn' ||
    frozen.type === 'rangeBoth';

  const heightPx =
    hasRowFreeze && typeof row_focus === 'number' && row_focus >= 0
      ? (ctx.visibledatarow[row_focus] ?? 0)
      : 0;

  const widthPx =
    hasColFreeze && typeof column_focus === 'number' && column_focus >= 0
      ? (ctx.visibledatacolumn[column_focus] ?? 0)
      : 0;

  return { widthPx, heightPx };
};

export type FreezeType =
  | 'row'
  | 'column'
  | 'both'
  | 'unfreeze-row'
  | 'unfreeze-column'
  | 'unfreeze-all';

export const toggleFreeze = (ctx: Context, type: FreezeType) => {
  const selection = ctx.luckysheet_select_save?.[0];
  if (!selection) return;

  const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId)!;
  const sheet = ctx.luckysheetfile[sheetIndex];
  const frozen = sheet.frozen ?? {
    range: { row_focus: -1, column_focus: -1 },
  };

  let { row_focus, column_focus } = frozen.range ?? {
    row_focus: -1,
    column_focus: -1,
  };

  switch (type) {
    case 'row':
      row_focus = selection.row_focus ?? -1;
      break;
    case 'column':
      column_focus = selection.column_focus ?? -1;
      break;
    case 'both':
      row_focus = selection.row_focus ?? -1;
      column_focus = selection.column_focus ?? -1;
      break;
    case 'unfreeze-row':
      row_focus = -1;
      break;
    case 'unfreeze-column':
      column_focus = -1;
      break;
    case 'unfreeze-all':
      delete sheet.frozen;
      return;
    default:
      break;
  }

  const hasRow = row_focus >= 0;
  const hasCol = column_focus >= 0;

  if (!hasRow && !hasCol) {
    delete sheet.frozen;
    return;
  }
  let newType: 'row' | 'column' | 'both';

  if (hasRow && hasCol) {
    newType = 'both';
  } else if (hasRow) {
    newType = 'row';
  } else {
    newType = 'column';
  }

  sheet.frozen = {
    type: newType,
    range: {
      row_focus,
      column_focus,
    },
  };
};
