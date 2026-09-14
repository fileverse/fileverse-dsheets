import _ from 'lodash';
import { hideCRCount, removeActiveImage, cutActiveImage } from '..';
import { Context, getFlowdata } from '../context';
import { getImageClipboard, getImageCutSourceId, pasteImageItem } from '../modules/image';
import { updateCell, cancelNormalSelected } from '../modules/cell';
import {
  handleFormulaInput,
  isLegacyFormulaRangeMode,
  isFormulaReferenceInputMode,
  isCaretAtValidFormulaRangeInsertionPoint,
  seedFormulaFuncSelectedRangeFromLastSelection,
  israngeseleciton,
  markRangeSelectionDirty,
  maybeRecoverDirtyRangeSelection,
  setFormulaEditorOwner,
  getFormulaEditorOwner,
  suppressFormulaRangeSelectionForInitialEdit,
  ensureFormulaRangeToSheet,
  returnToFormulaOriginSheet,
  toggleFormulaAbsoluteReferenceAtCaret,
  getFormulaRangeIndexAtCaret,
  isBareCellOrRangeOnlyFormula,
} from '../modules/formula';
import { isInlineStringCell } from '../modules/inline-string';
import {
  copy,
  deleteSelectedCellText,
  deleteSelectedCellFormat,
  textFormat,
  fillDate,
  fillTime,
  fillDateTime,
  fillRightData,
  fillDownData,
  moveHighlightCell,
  moveHighlightRange,
  selectAll,
  selectionCache,
  advancePrimaryCellInLastMultiSelection,
  normalizeSelection,
} from '../modules/selection';
import {
  cancelPaintModel,
  handleBold,
  handleItalic,
  handleUnderline,
  handleLink,
} from '../modules/toolbar';
import { hasPartMC } from '../modules/validation';
import { CellMatrix, GlobalCache, Selection } from '../types';
import {
  getNowDateTime,
  getSheetIndex,
  isAllowEdit,
  isAllowEditReadOnly,
} from '../utils';
import { handleCopy } from './copy';
import { handleShortcutsV2 } from './shortcuts-v2';
import {
  isBrowserZoomShortcut,
  isFindReplaceShortcut,
  isFindShortcut,
  isInsertDateShortcut,
  isInsertDateTimeShortcut,
  isInsertTimeShortcut,
  isRedoShortcut,
  isSelectAllShortcut,
  isUndoShortcut,
  isUsInsertDateTimeQuoteShortcut,
} from './keyboard-shortcut-utils';
import { jfrefreshgrid } from '../modules/refresh';
import { moveToEnd } from '../modules/cursor';

function clearTypeOverPending(cache: GlobalCache) {
  delete cache.pendingTypeOverCell;
}

function getActiveFormulaEditorForKeyboardGuard(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  if (
    active?.id === 'luckysheet-rich-text-editor' ||
    active?.id === 'luckysheet-functionbox-cell'
  ) {
    return active;
  }
  return (
    (document.getElementById(
      'luckysheet-rich-text-editor',
    ) as HTMLElement | null) ||
    (document.getElementById(
      'luckysheet-functionbox-cell',
    ) as HTMLElement | null)
  );
}

/**
 * While editing a formula, keyboard range navigation must be blocked unless the
 * caret is currently at a syntactically valid insertion slot.
 */
function shouldBlockFormulaRangeKeyboardNavigation(ctx: Context): boolean {
  if (ctx.luckysheetCellUpdate.length === 0) return false;
  const editor = getActiveFormulaEditorForKeyboardGuard();
  if (!editor) return false;
  const t = (editor.innerText || '').trim();
  if (!t.startsWith('=')) return false;
  // When a range was just inserted via keyboard/mouse and the caret remains on
  // that managed range span, allow continued arrow navigation to extend/move it
  // (e.g. `=A2` → arrow → `=A3` / `=A2:A3`). Mirrors main's behavior where
  // `rangeSelectionActive === true` short-circuited bare-cell-only checks.
  if (
    ctx.formulaCache.rangeSelectionActive === true &&
    getFormulaRangeIndexAtCaret(editor as HTMLDivElement) !== null
  ) {
    return false;
  }
  // Bare `=A1` / `=Sheet2!A1` after a clean insert: keep driving that single
  // managed ref even if focus left the span (common after switching sheets —
  // first arrow inserts, then caret is no longer inside the span).
  if (
    ctx.formulaCache.rangeSelectionActive === true &&
    isBareCellOrRangeOnlyFormula(t)
  ) {
    return false;
  }
  return !isCaretAtValidFormulaRangeInsertionPoint(editor);
}

/** Immer tracks this; `FormulaCache` mutations alone do not re-render React. */
function bumpFormulaKeyboardRangeSync(
  ctx: Context,
  navType: 'rangeOfFormula' | 'rangeOfSelect',
) {
  if (navType === 'rangeOfFormula') {
    ctx.formulaCache.formulaKeyboardRefSync = true;
    ctx.formulaRangeNavRevision = (ctx.formulaRangeNavRevision ?? 0) + 1;
  }
}

/**
 * Formula reference keyboard path: seed `func_selectedrange`, use it for moves/jump-to-edge
 * while keeping yellow `luckysheet_select_save` on the edited cell.
 */
function getFormulaKeyboardNavState(ctx: Context): {
  navType: 'rangeOfFormula' | 'rangeOfSelect';
  navSelection: Selection | undefined;
} {
  const useFormulaRangeOnly =
    ctx.luckysheetCellUpdate.length > 0 && isFormulaReferenceInputMode(ctx);
  if (useFormulaRangeOnly) {
    seedFormulaFuncSelectedRangeFromLastSelection(ctx);
  }
  const navType =
    useFormulaRangeOnly && ctx.formulaCache.func_selectedrange
      ? 'rangeOfFormula'
      : 'rangeOfSelect';
  const navSelection =
    navType === 'rangeOfFormula' && ctx.formulaCache.func_selectedrange
      ? ctx.formulaCache.func_selectedrange
      : ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
  return { navType, navSelection };
}

/** Content to place in the editor when opening via a keypress; `""` = clear. `undefined` = let IME / default handle. */
function getTypeOverInitialContent(e: KeyboardEvent): string | undefined {
  if (e.keyCode === 229) return undefined;
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  if (e.key === 'Backspace' || e.key === 'Delete') return '';
  if (e.key.length === 1) return e.key;
  return undefined;
}

export function handleGlobalEnter(
  ctx: Context,
  cellInput: HTMLDivElement,
  e: KeyboardEvent,
  cache: GlobalCache,
  canvas?: CanvasRenderingContext2D,
) {
  // const flowdata = getFlowdata(ctx);
  if ((e.altKey || e.metaKey) && ctx.luckysheetCellUpdate.length > 0) {
    const last =
      ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
    if (last && !_.isNil(last.row_focus) && !_.isNil(last.column_focus)) {
      // const row_index = last.row_focus;
      // const col_index = last.column_focus;
      // enterKeyControll(flowdata?.[row_index]?.[col_index]);
    }
    e.preventDefault();
  } else if (ctx.luckysheetCellUpdate.length > 0) {
    // if (
    //   $("#luckysheet-formula-search-c").is(":visible") &&
    //   formula.searchFunctionCell != null
    // ) {
    //   formula.searchFunctionEnter(
    //     $("#luckysheet-formula-search-c").find(
    //       ".luckysheet-formula-search-item-active"
    //     )
    //   );
    // } else {
    const lastCellUpdate = _.clone(ctx.luckysheetCellUpdate);
    const selSnapshot =
      ctx.luckysheet_select_save != null
        ? _.cloneDeep(ctx.luckysheet_select_save)
        : undefined;
    const lastBefore = selSnapshot?.[selSnapshot.length - 1];
    const wasMulti =
      !!lastBefore &&
      (lastBefore.row[0] !== lastBefore.row[1] ||
        lastBefore.column[0] !== lastBefore.column[1]);

    updateCell(
      ctx,
      ctx.luckysheetCellUpdate[0],
      ctx.luckysheetCellUpdate[1],
      cellInput,
      undefined,
      canvas,
    );
    cache.enteredEditByTyping = false;
    clearTypeOverPending(cache);

    // Do not gate on `isLegacyFormulaRangeMode`: after keyboard formula range picks,
    // rangestart / rangeSelectionActive / israngeseleciton can still be true before
    // commit; skipping the multi path collapsed the sheet selection to one cell.
    if (wasMulti && selSnapshot) {
      ctx.luckysheet_select_save = _.cloneDeep(selSnapshot);
      const lastSel =
        ctx.luckysheet_select_save[ctx.luckysheet_select_save.length - 1];
      lastSel.row_focus = lastCellUpdate[0];
      lastSel.column_focus = lastCellUpdate[1];
      normalizeSelection(ctx, ctx.luckysheet_select_save);
      advancePrimaryCellInLastMultiSelection(ctx, !e.shiftKey);
      // Leave edit mode closed (`updateCell` → `cancelNormalSelected`); only move
      // the range primary, same as Enter when not editing.
    } else {
      ctx.luckysheet_select_save = [
        {
          row: [lastCellUpdate[0], lastCellUpdate[0]],
          column: [lastCellUpdate[1], lastCellUpdate[1]],
          row_focus: lastCellUpdate[0],
          column_focus: lastCellUpdate[1],
        },
      ];
      const rowStep = e.shiftKey
        ? -hideCRCount(ctx, 'ArrowUp')
        : hideCRCount(ctx, 'ArrowDown');
      moveHighlightCell(ctx, 'down', rowStep, 'rangeOfSelect');
    }
    // }

    // // 若有参数弹出框，隐藏
    // if ($("#luckysheet-search-formula-parm").is(":visible")) {
    //   $("#luckysheet-search-formula-parm").hide();
    // }
    // // 若有参数选取范围弹出框，隐藏
    // if ($("#luckysheet-search-formula-parm-select").is(":visible")) {
    //   $("#luckysheet-search-formula-parm-select").hide();
    // }
    e.preventDefault();
  } else {
    // if (
    //   $(event.target).hasClass("formulaInputFocus") ||
    //   $("#luckysheet-conditionformat-dialog").is(":visible")
    // ) {
    //   return;
    // }
    if ((ctx.luckysheet_select_save?.length ?? 0) > 0) {
      const last =
        ctx.luckysheet_select_save![ctx.luckysheet_select_save!.length - 1];

      const isMultiRange =
        last.row[0] !== last.row[1] || last.column[0] !== last.column[1];
      if (isMultiRange && !isLegacyFormulaRangeMode(ctx)) {
        if (advancePrimaryCellInLastMultiSelection(ctx, !e.shiftKey)) {
          e.preventDefault();
          return;
        }
      }

      const row_index = last.row_focus;
      const col_index = last.column_focus;

      if (!_.isNil(row_index) && !_.isNil(col_index)) {
        const flowdata = getFlowdata(ctx);
        const cellAt = flowdata?.[row_index]?.[col_index] as
          | { f?: string }
          | null
          | undefined;
        if (cellAt?.f != null && String(cellAt.f).trim() !== '') {
          suppressFormulaRangeSelectionForInitialEdit(ctx);
        }
      }

      ctx.luckysheetCellUpdate = [row_index, col_index];
      cache.enteredEditByTyping = false;
      clearTypeOverPending(cache);
      // luckysheetupdateCell(row_index, col_index, ctx.flowdata);
      e.preventDefault();
    }
  }
}

/** Non-empty for Ctrl/Cmd+Arrow "jump to edge" scans (includes inlineStr / formulas). */
function cellCountsForDataEdge(cell: any): boolean {
  if (cell == null) return false;
  if (!_.isPlainObject(cell)) return !_.isNil(cell);
  if (cell.f != null && String(cell.f) !== '') return true;
  if (!_.isNil(cell.v)) return true;
  if (isInlineStringCell(cell)) {
    return (cell.ct?.s ?? []).some(
      (seg: { v?: string }) => seg?.v != null && String(seg.v).length > 0,
    );
  }
  return false;
}

function moveToEdge(
  sheetData: CellMatrix,
  key: string,
  curr: number,
  rowDelta: 0 | 1 | -1,
  colDelta: 0 | 1 | -1,
  startR: number,
  endR: number,
  startC: number,
  endC: number,
  maxRow: number,
  maxCol: number,
) {
  let selectedLimit = -1;
  if (key === 'ArrowUp') selectedLimit = startR - 1;
  else if (key === 'ArrowDown') selectedLimit = endR + 1;
  else if (key === 'ArrowLeft') selectedLimit = startC - 1;
  else if (key === 'ArrowRight') selectedLimit = endC + 1;

  const maxRowCol = colDelta === 0 ? maxRow : maxCol;
  let r = colDelta === 0 ? selectedLimit : curr;
  let c = colDelta === 0 ? curr : selectedLimit;

  while (r >= 0 && c >= 0 && (colDelta === 0 ? r : c) < maxRowCol - 1) {
    const here = sheetData?.[r]?.[c];
    const behind = sheetData?.[r - rowDelta]?.[c - colDelta];
    const ahead = sheetData?.[r + rowDelta]?.[c + colDelta];
    if (
      cellCountsForDataEdge(here) &&
      (!cellCountsForDataEdge(behind) || !cellCountsForDataEdge(ahead))
    ) {
      break;
    } else {
      r += 1 * rowDelta;
      c += 1 * colDelta;
    }
  }
  return colDelta === 0 ? r : c;
}

/** In-cell / FX edit of non-formula text: let the browser handle Cmd/Ctrl (+Shift) + Arrow (line/paragraph caret), not sheet jump-to-edge. */
function isPlainTextCellOrFxEdit(
  ctx: Context,
  cellInput: HTMLDivElement,
  fxInput: HTMLDivElement | null | undefined,
): boolean {
  if (ctx.luckysheetCellUpdate.length === 0) return false;
  const cellT = (cellInput?.innerText ?? '').trim();
  const fxT = (fxInput?.innerText ?? '').trim();
  const owner = getFormulaEditorOwner(ctx);
  if (owner === 'fx' && fxInput) {
    return !fxT.startsWith('=');
  }
  if (owner === 'cell') {
    return !cellT.startsWith('=');
  }
  const aid = document.activeElement?.id;
  if (aid === 'luckysheet-functionbox-cell' && fxInput) {
    return !fxT.startsWith('=');
  }
  if (aid === 'luckysheet-rich-text-editor') {
    return !cellT.startsWith('=');
  }
  if (cellT.startsWith('=') || fxT.startsWith('=')) return false;
  return true;
}

/** Type-to-edit on a non-formula cell (or formula bar plain text); not F2 / double-click. */
function isDirectPlainTextCellEdit(
  ctx: Context,
  cache: GlobalCache | undefined,
  cellInput: HTMLDivElement,
  fxInput: HTMLDivElement | null | undefined,
): boolean {
  return (
    cache?.enteredEditByTyping === true &&
    ctx.luckysheetCellUpdate.length > 0 &&
    isPlainTextCellOrFxEdit(ctx, cellInput, fxInput)
  );
}

function commitDirectPlainCellEdit(
  ctx: Context,
  cache: GlobalCache | undefined,
  cellInput: HTMLDivElement,
  canvas?: CanvasRenderingContext2D,
) {
  if (ctx.luckysheetCellUpdate.length === 0) return;
  updateCell(
    ctx,
    ctx.luckysheetCellUpdate[0],
    ctx.luckysheetCellUpdate[1],
    cellInput,
    undefined,
    canvas,
  );
  if (cache) {
    cache.enteredEditByTyping = false;
    clearTypeOverPending(cache);
  }
}

function handleControlPlusArrowKey(
  ctx: Context,
  e: KeyboardEvent,
  shiftPressed: boolean,
) {
  if (shouldBlockFormulaRangeKeyboardNavigation(ctx)) {
    return;
  }

  // If the user dirtied a managed range token but the caret is back at a
  // valid insertion slot, un-sticky so jump-to-edge keeps working.
  if (ctx.formulaCache.rangeSelectionActive === false) {
    maybeRecoverDirtyRangeSelection(ctx);
  }

  // Do not gate jump-to-edge on formula range "dirty" state — that flag is for
  // plain Arrow/Shift+Arrow while editing range tokens, and it was blocking
  // Cmd/Ctrl+Arrow and Cmd/Ctrl+Shift+Arrow entirely.
  const isFormulaRefMode = isLegacyFormulaRangeMode(ctx);
  if (isFormulaRefMode) {
    ctx.formulaCache.rangeSelectionActive = true;
  }
  if (
    ctx.luckysheetCellUpdate.length > 0 &&
    !isFormulaRefMode &&
    !isFormulaReferenceInputMode(ctx)
  ) {
    return;
  }

  const { navType, navSelection: last } = getFormulaKeyboardNavState(ctx);
  if (!last) return;

  const idx = getSheetIndex(ctx, ctx.currentSheetId);
  if (_.isNil(idx)) return;

  const file = ctx.luckysheetfile[idx];
  if (!file || _.isNil(file.row) || _.isNil(file.column)) return;
  const maxRow = file.row;
  const maxCol = file.column;

  const currR = last.row_focus;
  const currC = last.column_focus;
  if (_.isNil(currR) || _.isNil(currC)) return;

  const startR = last.row[0];
  const endR = last.row[1];
  const startC = last.column[0];
  const endC = last.column[1];

  const horizontalOffset = currC - endC !== 0 ? currC - endC : currC - startC;
  const verticalOffset = currR - endR !== 0 ? currR - endR : currR - startR;

  const sheetData = file.data;
  if (!sheetData) return;
  let selectedLimit: number;

  switch (e.key) {
    case 'ArrowUp':
      selectedLimit = moveToEdge(
        sheetData,
        e.key,
        currC,
        -1,
        0,
        startR,
        endR,
        startC,
        endC,
        maxRow,
        maxCol,
      );
      if (shiftPressed) {
        moveHighlightRange(ctx, 'down', verticalOffset, navType);
        moveHighlightRange(ctx, 'down', selectedLimit - currR, navType);
      } else {
        moveHighlightCell(ctx, 'down', selectedLimit - currR, navType);
      }
      break;
    case 'ArrowDown':
      selectedLimit = moveToEdge(
        sheetData,
        e.key,
        currC,
        1,
        0,
        startR,
        endR,
        startC,
        endC,
        maxRow,
        maxCol,
      );
      if (shiftPressed) {
        moveHighlightRange(ctx, 'down', verticalOffset, navType);
        moveHighlightRange(ctx, 'down', selectedLimit - currR, navType);
      } else {
        moveHighlightCell(ctx, 'down', selectedLimit - currR, navType);
      }
      break;
    case 'ArrowLeft':
      selectedLimit = moveToEdge(
        sheetData,
        e.key,
        currR,
        0,
        -1,
        startR,
        endR,
        startC,
        endC,
        maxRow,
        maxCol,
      );
      if (shiftPressed) {
        moveHighlightRange(ctx, 'right', horizontalOffset, navType);
        moveHighlightRange(ctx, 'right', selectedLimit - currC, navType);
      } else {
        moveHighlightCell(ctx, 'right', selectedLimit - currC, navType);
      }
      break;
    case 'ArrowRight':
      selectedLimit = moveToEdge(
        sheetData,
        e.key,
        currR,
        0,
        1,
        startR,
        endR,
        startC,
        endC,
        maxRow,
        maxCol,
      );
      if (shiftPressed) {
        moveHighlightRange(ctx, 'right', horizontalOffset, navType);
        moveHighlightRange(ctx, 'right', selectedLimit - currC, navType);
      } else {
        moveHighlightCell(ctx, 'right', selectedLimit - currC, navType);
      }
      break;
    default:
      return;
  }

  bumpFormulaKeyboardRangeSync(ctx, navType);
}

export function handleWithCtrlOrMetaKey(
  ctx: Context,
  cache: GlobalCache,
  e: KeyboardEvent,
  cellInput: HTMLDivElement,
  fxInput: HTMLDivElement | null | undefined,
  handleUndo: () => void,
  handleRedo: () => void,
  canvas?: CanvasRenderingContext2D,
) {
  const flowdata = getFlowdata(ctx);
  if (!flowdata) return;

  if (isFindShortcut(e)) {
    ctx.showSearch = false;
    ctx.showReplace = false;
    if (ctx.showQuickSearch) {
      ctx.quickSearchFocusNonce = (ctx.quickSearchFocusNonce ?? 0) + 1;
    } else {
      ctx.showQuickSearch = true;
    }
    return;
  }

  if (isFindReplaceShortcut(e)) {
    ctx.showSearch = true;
    ctx.showReplace = true;
    return;
  }

  if (
    (e.ctrlKey || e.metaKey) &&
    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) &&
    isPlainTextCellOrFxEdit(ctx, cellInput, fxInput)
  ) {
    if (isDirectPlainTextCellEdit(ctx, cache, cellInput, fxInput)) {
      commitDirectPlainCellEdit(ctx, cache, cellInput, canvas);
      // Fall through: run jump-to-edge / extend-selection on the grid.
    } else {
      // F2 / double-click plain text: keep native contenteditable caret behavior.
      return;
    }
  }

  if (e.shiftKey) {
    ctx.luckysheet_shiftpositon = _.cloneDeep(
      ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1],
    );
    ctx.luckysheet_shiftkeydown = true;

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      // Ctrl + Shift + 方向键  调整选区
      handleControlPlusArrowKey(ctx, e, true);
    } else if (_.includes(['"', ':', "'"], e.key)) {
      const last =
        ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
      if (!last) return;

      const row_index = last.row_focus!;
      const col_index = last.column_focus!;
      updateCell(ctx, row_index, col_index, cellInput);
      ctx.luckysheetCellUpdate = [row_index, col_index];
      cache.enteredEditByTyping = false;
      clearTypeOverPending(cache);

      cache.ignoreWriteCell = true;
      const value = getNowDateTime(2);
      cellInput.innerText = value;
      // $("#luckysheet-rich-text-editor").html(value);
      // luckysheetRangeLast($("#luckysheet-rich-text-editor")[0]);
      handleFormulaInput(ctx, fxInput, cellInput, e.keyCode);
    } else if (isRedoShortcut(e)) {
      // Ctrl + shift + z 重做 (layout-aware: AZERTY types "z" on KeyW)
      handleRedo();
      e.stopPropagation();
      return;
    } else if (e.code === 'KeyV') {
      // Ctrl + Shift + V  粘贴仅值
      if ((ctx.luckysheet_select_save?.length ?? 0) > 1) {
        return;
      }
      selectionCache.isPasteAction = true;
      selectionCache.isPasteValuesOnly = true;
      e.stopPropagation();
      return;
    }
  } else if (
    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)
  ) {
    handleControlPlusArrowKey(ctx, e, false);
  } else if (e.code === 'KeyB') {
    // Ctrl + B  加粗
    handleBold(ctx, cellInput);
    // $("#luckysheet-icon-bold").click();
  } else if (e.code === 'KeyI') {
    // Ctrl + B  加粗
    handleItalic(ctx, cellInput);
    // $("#luckysheet-icon-bold").click();
  } else if (e.code === 'KeyU') {
    // Ctrl + B  加粗
    handleUnderline(ctx, cellInput);
    // $("#luckysheet-icon-bold").click();
  } else if (e.code === 'Backslash') {
    // Ctrl + B  加粗
    deleteSelectedCellFormat(ctx);
    // $("#luckysheet-icon-bold").click();
  } else if (e.code === 'KeyC') {
    if (ctx.activeImg != null) {
      handleCopy(ctx);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (ctx.luckysheetCellUpdate.length > 0) {
      // In-cell edit mode: write plain text only, no HTML
      e.preventDefault();
      const sel = window.getSelection();
      const text =
        sel && !sel.isCollapsed ? sel.toString() : cellInput.innerText;
      navigator.clipboard?.writeText(text).catch(() => {});
    } else {
      // Normal copy: write styled HTML
      handleCopy(ctx);
    }
    e.stopPropagation();
    return;
  } else if (e.code === 'KeyV') {
    // Prefer in-app floating-image clipboard (Ctrl/Cmd+C on an image). System
    // clipboard HTML is unreliable after image copy during the keydown gesture.
    if ((getImageClipboard() || getImageCutSourceId()) && pasteImageItem(ctx)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Ctrl + V  粘贴
    // if (isEditMode()) {
    //   // 此模式下禁用粘贴
    //   return;
    // }

    // if ($(event.target).hasClass("formulaInputFocus")) {
    //   return;
    // }

    if ((ctx.luckysheet_select_save?.length ?? 0) > 1) {
      // if (isEditMode()) {
      //   alert(locale_drag.noPaste);
      // } else {
      //   tooltip.info(locale_drag.noPaste, "");
      // }
      return;
    }

    selectionCache.isPasteAction = true;
    // luckysheetactiveCell();
    e.stopPropagation();
    return;
  } else if (e.code === 'KeyX') {
    // Ctrl + X  剪切
    // Floating image selected — cut it instead of the cell range
    if (ctx.activeImg != null) {
      cutActiveImage(ctx);
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // 复制时存在格式刷状态，取消格式刷
    if (ctx.luckysheetPaintModelOn) {
      cancelPaintModel(ctx);
    }

    const selection = ctx.luckysheet_select_save;
    if (!selection || _.isEmpty(selection)) {
      return;
    }

    // 复制范围内包含部分合并单元格，提示
    if (ctx.config.merge != null) {
      let has_PartMC = false;

      for (let s = 0; s < selection.length; s += 1) {
        const r1 = selection[s].row[0];
        const r2 = selection[s].row[1];
        const c1 = selection[s].column[0];
        const c2 = selection[s].column[1];

        has_PartMC = hasPartMC(ctx, ctx.config, r1, r2, c1, c2);

        if (has_PartMC) {
          break;
        }
      }

      if (has_PartMC) {
        // if (luckysheetConfigsetting.editMode) {
        //   alert(_locale_drag.noMerge);
        // } else {
        //   tooltip.info(_locale_drag.noMerge, "");
        // }
        return;
      }
    }

    // 多重选区时 提示
    if (selection.length > 1) {
      // if (isEditMode()) {
      //   alert(locale_drag.noMulti);
      // } else {
      //   tooltip.info(locale_drag.noMulti, "");
      // }
      return;
    }

    copy(ctx);

    ctx.luckysheet_paste_iscut = true;
    // luckysheetactiveCell();

    e.stopPropagation();
    return;
  } else if (isUndoShortcut(e)) {
    // Ctrl + Z  撤销 (layout-aware: AZERTY types "z" on KeyW)
    handleUndo();
    e.stopPropagation();
    return;
  } /* else if (e.key === "ArrowUp") {
    // Ctrl + up  调整单元格
    if (
      parseInt($inputbox.css("top")) > 0 ||
      $("#luckysheet-singleRange-dialog").is(":visible") ||
      $("#luckysheet-multiRange-dialog").is(":visible")
    ) {
      return;
    }

    luckysheetMoveHighlightCell2("up", "rangeOfSelect");
  } else if (e.key === "ArrowDown") {
    // Ctrl + down  调整单元格
    if (
      parseInt($inputbox.css("top")) > 0 ||
      $("#luckysheet-singleRange-dialog").is(":visible") ||
      $("#luckysheet-multiRange-dialog").is(":visible")
    ) {
      return;
    }

    luckysheetMoveHighlightCell2("down", "rangeOfSelect");
  } else if (e.key === "ArrowLeft") {
    // Ctrl + top  调整单元格
    if (
      parseInt($inputbox.css("top")) > 0 ||
      $("#luckysheet-singleRange-dialog").is(":visible") ||
      $("#luckysheet-multiRange-dialog").is(":visible")
    ) {
      return;
    }

    luckysheetMoveHighlightCell2("left", "rangeOfSelect");
  } else if (e.key === "ArrowRight") {
    // Ctrl + right  调整单元格
    if (
      parseInt($inputbox.css("top")) > 0 ||
      $("#luckysheet-singleRange-dialog").is(":visible") ||
      $("#luckysheet-multiRange-dialog").is(":visible")
    ) {
      return;
    }

    luckysheetMoveHighlightCell2("right", "rangeOfSelect");
  } else if (e.keyCode === 186) {
    // Ctrl + ; 填充系统日期
    const last =
      ctx.luckysheet_select_save[ctx.luckysheet_select_save.length - 1];
    const row_index = last.row_focus;
    const col_index = last.column_focus;
    luckysheetupdateCell(row_index, col_index, ctx.flowdata, true);

    const value = getNowDateTime(1);
    $("#luckysheet-rich-text-editor").html(value);
    luckysheetRangeLast($("#luckysheet-rich-text-editor")[0]);
    formula.functionInputHanddler(
      $("#luckysheet-functionbox-cell"),
      $("#luckysheet-rich-text-editor"),
      e.keyCode
    );
  } else if (e.keyCode === 222) {
    // Ctrl + ' 填充系统时间
    const last =
      ctx.luckysheet_select_save[ctx.luckysheet_select_save.length - 1];
    const row_index = last.row_focus;
    const col_index = last.column_focus;
    luckysheetupdateCell(row_index, col_index, ctx.flowdata, true);

    const value = getNowDateTime(2);
    $("#luckysheet-rich-text-editor").html(value);
    luckysheetRangeLast($("#luckysheet-rich-text-editor")[0]);
    formula.functionInputHanddler(
      $("#luckysheet-functionbox-cell"),
      $("#luckysheet-rich-text-editor"),
      e.keyCode
    );
  } */ else if (isSelectAllShortcut(e)) {
    // Ctrl/Cmd + A  全选
    selectAll(ctx);
  }

  e.preventDefault();
}

function handleShiftWithArrowKey(ctx: Context, e: KeyboardEvent) {
  if (shouldBlockFormulaRangeKeyboardNavigation(ctx)) {
    return;
  }

  // For pre-existing formulas on first open, block keyboard range navigation
  // until the user manually edits formula text.
  if (ctx.formulaCache.keyboardRangeSelectionLock === true) {
    return;
  }

  // If the user manually modified a keyboard/mouse-inserted range token,
  // try to recover when the caret is now at a valid insertion slot.
  if (ctx.formulaCache.rangeSelectionActive === false) {
    if (!maybeRecoverDirtyRangeSelection(ctx)) return;
  }

  const isFormulaMode = isLegacyFormulaRangeMode(ctx);

  if (isFormulaMode) {
    // Mark the range selection flow as "keyboard-driven" so any immediate
    // manual typing/delete invalidates it.
    ctx.formulaCache.rangeSelectionActive = true;
  }

  if (
    ctx.luckysheetCellUpdate.length > 0 &&
    !isFormulaMode &&
    !isFormulaReferenceInputMode(ctx)
    // || $(event.target).hasClass("formulaInputFocus")
  ) {
    return;
  }

  const { navType: shiftNavType } = getFormulaKeyboardNavState(ctx);

  ctx.luckysheet_shiftpositon = _.cloneDeep(
    ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1],
  );
  ctx.luckysheet_shiftkeydown = true;
  /*
  if (
    $("#luckysheet-singleRange-dialog").is(":visible") ||
    $("#luckysheet-multiRange-dialog").is(":visible")
  ) {
    return;
  }
  */

  // shift + 方向键 调整选区
  switch (e.key) {
    case 'ArrowUp':
      moveHighlightRange(ctx, 'down', -1, shiftNavType);
      break;
    case 'ArrowDown':
      moveHighlightRange(ctx, 'down', 1, shiftNavType);
      break;
    case 'ArrowLeft':
      moveHighlightRange(ctx, 'right', -1, shiftNavType);
      break;
    case 'ArrowRight':
      moveHighlightRange(ctx, 'right', 1, shiftNavType);
      break;
    default:
      break;
  }

  bumpFormulaKeyboardRangeSync(ctx, shiftNavType);

  e.preventDefault();
}

export function handleArrowKey(ctx: Context, e: KeyboardEvent) {
  if (shouldBlockFormulaRangeKeyboardNavigation(ctx)) {
    return;
  }

  // For pre-existing formulas on first open, block keyboard range navigation
  // until the user manually edits formula text.
  if (ctx.formulaCache.keyboardRangeSelectionLock === true) {
    return;
  }

  // If the user dirtied the range token but the caret is back at a clean,
  // valid insertion slot, un-sticky the dirty flag so navigation can resume.
  if (ctx.formulaCache.rangeSelectionActive === false) {
    const recovered = maybeRecoverDirtyRangeSelection(ctx);
    if (!recovered) return;
  }
  const isFormulaRefMode = isLegacyFormulaRangeMode(ctx);
  if (isFormulaRefMode) ctx.formulaCache.rangeSelectionActive = true;
  // If editor is active but caret is not in formula-reference mode, keep
  // native caret behavior and do not move selected grid cell/range.
  if (
    ctx.luckysheetCellUpdate.length > 0 &&
    !isFormulaRefMode &&
    !isFormulaReferenceInputMode(ctx)
  ) {
    return;
  }

  if (
    ctx.luckysheetCellUpdate.length > 0 ||
    ctx.luckysheet_cell_selected_move ||
    ctx.luckysheet_cell_selected_extend
    // || $(event.target).hasClass("formulaInputFocus") ||
    // $("#luckysheet-singleRange-dialog").is(":visible") ||
    // $("#luckysheet-multiRange-dialog").is(":visible")
  ) {
    // Legacy guard intentionally disabled; formula-mode gating now happens via
    // `isLegacyFormulaRangeMode` / `israngeseleciton`.
  }

  const { navType } = getFormulaKeyboardNavState(ctx);

  const moveCount = hideCRCount(ctx, e.key);
  switch (e.key) {
    case 'ArrowUp':
      moveHighlightCell(ctx, 'down', -moveCount, navType);
      break;
    case 'ArrowDown':
      moveHighlightCell(ctx, 'down', moveCount, navType);
      break;
    case 'ArrowLeft':
      moveHighlightCell(ctx, 'right', -moveCount, navType);
      break;
    case 'ArrowRight':
      moveHighlightCell(ctx, 'right', moveCount, navType);
      break;
    default:
      break;
  }

  bumpFormulaKeyboardRangeSync(ctx, navType);

  // Keep the formula caret anchored while arrow keys drive sheet selection.
  // Also re-focus the editor after sheet-tab focus theft so bare `=Sheet!A1`
  // continued navigation can see the caret on the managed span.
  if (navType === 'rangeOfFormula') {
    const editor = getActiveFormulaEditorForKeyboardGuard();
    if (editor && document.activeElement !== editor) {
      editor.focus({ preventScroll: true });
    }
  }
  e.preventDefault();
}

export async function handleGlobalKeyDown(
  ctx: Context,
  cellInput: HTMLDivElement,
  fxInput: HTMLDivElement | null | undefined,
  e: KeyboardEvent,
  cache: GlobalCache,
  handleUndo: () => void,
  handleRedo: () => void,
  canvas?: CanvasRenderingContext2D,
) {
  if (isBrowserZoomShortcut(e)) return;

  /* FLV */
  if (e.shiftKey && e.code === 'Space') {
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  let handledFlvShortcut = false;
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyE') {
    textFormat(ctx, 'center');
    handledFlvShortcut = true;
  } else if (
    (e.ctrlKey || e.metaKey) &&
    e.shiftKey &&
    !e.altKey &&
    e.code === 'KeyL' &&
    ctx.luckysheetCellUpdate.length > 0
  ) {
    textFormat(ctx, 'left');
    handledFlvShortcut = true;
  } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyR') {
    textFormat(ctx, 'right');
    handledFlvShortcut = true;
  }
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') {
    handleLink(ctx, cellInput, cache);
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (
    isInsertDateTimeShortcut(e) ||
    isUsInsertDateTimeQuoteShortcut(e)
  ) {
    fillDateTime(ctx);
    handledFlvShortcut = true;
  } else if (isInsertTimeShortcut(e)) {
    fillTime(ctx);
    handledFlvShortcut = true;
  } else if (isInsertDateShortcut(e)) {
    fillDate(ctx);
    handledFlvShortcut = true;
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.code === 'KeyR') {
    fillRightData(ctx);
    handledFlvShortcut = true;
  }
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyD') {
    fillDownData(ctx);
    handledFlvShortcut = true;
  }
  if (handledFlvShortcut) {
    jfrefreshgrid(ctx, null, undefined);
    e.stopPropagation();
    e.preventDefault();
    return;
  }

  if (handleShortcutsV2(ctx, cellInput, e, cache, canvas)) {
    e.stopPropagation();
    e.preventDefault();
    return;
  }

  if (
    isSelectAllShortcut(e) &&
    ctx.luckysheetCellUpdate.length === 0 &&
    _.isEmpty(ctx.contextMenu) &&
    !ctx.filterContextMenu
  ) {
    selectAll(ctx);
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  /* FLV */

  ctx.luckysheet_select_status = false;
  const kcode = e.keyCode;
  const kstr = e.key;
  if (!_.isEmpty(ctx.contextMenu) || ctx.filterContextMenu) {
    return;
  }

  if (kstr === 'Escape' && !!ctx.luckysheet_selection_range) {
    ctx.luckysheet_selection_range = [];
  }

  if (kstr === 'Escape' && ctx.showQuickSearch) {
    ctx.showQuickSearch = false;
    ctx.quickSearchHighlight = null;
    ctx.quickSearchLoading = false;
    e.preventDefault();
    return;
  }

  // Quick Search should only "own" keyboard when it's actually focused.
  // When it's merely visible (open) but the user has clicked back into the grid,
  // type-to-edit should work normally.
  const quickSearchOwnsKeys = (() => {
    if (!ctx.showQuickSearch) return false;
    const target = e.target as HTMLElement | null | undefined;
    if (target?.closest?.('.fortune-quick-search')) return true;
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest?.('.fortune-quick-search')) return true;
    return false;
  })();

  // If Quick Search owns the keyboard, let its local handlers run without
  // triggering grid type-to-edit.
  if (quickSearchOwnsKeys) {
    e.stopPropagation();
    return;
  }

  const allowEdit = isAllowEdit(ctx);

  // @ts-ignore // eslint-disable-next-line no-restricted-globals
  const isFxInput = e?.target?.classList?.contains('fortune-fx-input');

  // Fx bar normally ignores only Left/Right so local handlers can run; Up/Down hit
  // this early `return` and never reach `handleArrowKey` / `handleShiftWithArrowKey`.
  // In formula reference mode, sheet arrows must reach those handlers (same as in-cell).
  const fxPassArrowsToSheet =
    isFxInput &&
    ctx.luckysheetCellUpdate.length > 0 &&
    isFormulaReferenceInputMode(ctx);

  const ignoredKeys = new Set(
    isFxInput
      ? fxPassArrowsToSheet
        ? [
            'Enter',
            'Tab',
            'ArrowUp',
            'ArrowDown',
            'ArrowLeft',
            'ArrowRight',
            'F4',
          ]
        : ['Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'F4']
      : [
          'Enter',
          'Tab',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'F4',
        ],
  );
  const restCod = !ignoredKeys.has(kstr);
  const isF4Key = kstr === 'F4' || e.code === 'F4' || kcode === 115;

  const passFindReplaceThroughEdit =
    (e.ctrlKey || e.metaKey) &&
    (e.code === 'KeyF' ||
      (e.code === 'KeyH' &&
        ((e.ctrlKey && !e.metaKey && !e.shiftKey) ||
          (e.metaKey && e.shiftKey && !e.ctrlKey))));

  if (
    // $("#luckysheet-modal-dialog-mask").is(":visible") ||
    // $(event.target).hasClass("luckysheet-mousedown-cancel") ||
    // $(event.target).hasClass("sp-input") ||
    ctx.luckysheetCellUpdate.length > 0 &&
    restCod &&
    !passFindReplaceThroughEdit &&
    // Prefer floating-image shortcuts over in-cell edit when an image is selected
    ctx.activeImg == null
  ) {
    // const anchor = $(window.getSelection().anchorNode);

    // if (
    //   anchor.parent().is("#luckysheet-helpbox-cell") ||
    //   anchor.is("#luckysheet-helpbox-cell")
    // ) {
    //   if (kcode === keycode.ENTER) {
    //     const helpboxValue = $("#luckysheet-helpbox-cell").text();

    //     if (formula.iscelldata(helpboxValue)) {
    //       const cellrange = formula.getcellrange(helpboxValue);

    //       ctx.luckysheet_select_save = [
    //         {
    //           row: cellrange.row,
    //           column: cellrange.column,
    //           row_focus: cellrange.row[0],
    //           column_focus: cellrange.column[0],
    //         },
    //       ];
    //       selectHightlightShow();

    //       $("#luckysheet-helpbox-cell").blur();

    //       const scrollLeft = $("#luckysheet-cell-main").scrollLeft();
    //       const scrollTop = $("#luckysheet-cell-main").scrollTop();
    //       const winH = $("#luckysheet-cell-main").height();
    //       const winW = $("#luckysheet-cell-main").width();

    //       const row = ctx.visibledatarow[cellrange.row[1]];
    //       const row_pre =
    //         cellrange.row[0] - 1 === -1
    //           ? 0
    //           : ctx.visibledatarow[cellrange.row[0] - 1];
    //       const col = ctx.visibledatacolumn[cellrange.column[1]];
    //       const col_pre =
    //         cellrange.column[0] - 1 === -1
    //           ? 0
    //           : ctx.visibledatacolumn[cellrange.column[0] - 1];

    //       if (col - scrollLeft - winW + 20 > 0) {
    //         $("#luckysheet-scrollbar-x").scrollLeft(col - winW + 20);
    //       } else if (col_pre - scrollLeft - 20 < 0) {
    //         $("#luckysheet-scrollbar-x").scrollLeft(col_pre - 20);
    //       }

    //       if (row - scrollTop - winH + 20 > 0) {
    //         $("#luckysheet-scrollbar-y").scrollTop(row - winH + 20);
    //       } else if (row_pre - scrollTop - 20 < 0) {
    //         $("#luckysheet-scrollbar-y").scrollTop(row_pre - 20);
    //       }
    //     }
    //   }
    // }

    return;
  }

  // if (
  //   $("#luckysheet-modal-dialog-mask").is(":visible") ||
  //   $(event.target).hasClass("luckysheet-mousedown-cancel") ||
  //   $(event.target).hasClass("formulaInputFocus")
  // ) {
  //   return;
  // }

  if (kstr === 'Enter') {
    if (!allowEdit) return;
    handleGlobalEnter(ctx, cellInput, e, cache, canvas);
  } else if (kstr === 'Tab') {
    if (ctx.luckysheetCellUpdate.length > 0) {
      updateCell(
        ctx,
        ctx.luckysheetCellUpdate[0],
        ctx.luckysheetCellUpdate[1],
        cellInput,
        undefined,
        canvas,
      );
      cache.enteredEditByTyping = false;
      clearTypeOverPending(cache);
    }
    if (e.shiftKey) {
      moveHighlightCell(
        ctx,
        'right',
        -hideCRCount(ctx, 'ArrowLeft'),
        'rangeOfSelect',
      );
    } else {
      moveHighlightCell(
        ctx,
        'right',
        hideCRCount(ctx, 'ArrowRight'),
        'rangeOfSelect',
      );
    }
    e.preventDefault();
  } else if (kstr === 'F2') {
    // In FLV read-only, allow opening the editor for selection/copy only.
    const canOpenEditor = allowEdit || isAllowEditReadOnly(ctx);
    if (!canOpenEditor) return;
    if (ctx.luckysheetCellUpdate.length > 0) {
      return;
    }

    const last =
      ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
    if (!last) return;

    const row_index = last.row_focus;
    const col_index = last.column_focus;

    if (!_.isNil(row_index) && !_.isNil(col_index)) {
      const flowdataF2 = getFlowdata(ctx);
      const cellF2 = flowdataF2?.[row_index]?.[col_index] as
        | { f?: string }
        | null
        | undefined;
      if (cellF2?.f != null && String(cellF2.f).trim() !== '') {
        suppressFormulaRangeSelectionForInitialEdit(ctx);
      }
    }

    cache.enteredEditByTyping = false;
    clearTypeOverPending(cache);
    ctx.luckysheetCellUpdate = [row_index, col_index];
    e.preventDefault();
  } else if (isF4Key && ctx.luckysheetCellUpdate.length > 0) {
    const owner = getFormulaEditorOwner(ctx);
    const editor = owner === 'fx' && fxInput ? fxInput : cellInput;
    const copyTo = owner === 'fx' ? cellInput : fxInput;
    toggleFormulaAbsoluteReferenceAtCaret(ctx, copyTo, editor);
    e.preventDefault();
  } else if (kstr === 'Escape' && ctx.luckysheetCellUpdate.length > 0) {
    cache.enteredEditByTyping = false;
    clearTypeOverPending(cache);
    returnToFormulaOriginSheet(ctx);
    cancelNormalSelected(ctx);
    moveHighlightCell(ctx, 'down', 0, 'rangeOfSelect');
    e.preventDefault();
  } else {
    if (e.ctrlKey || e.metaKey) {
      handleWithCtrlOrMetaKey(
        ctx,
        cache,
        e,
        cellInput,
        fxInput,
        handleUndo,
        handleRedo,
        canvas,
      );
      return;
    }
    if (
      e.shiftKey &&
      (kstr === 'ArrowUp' ||
        kstr === 'ArrowDown' ||
        kstr === 'ArrowLeft' ||
        kstr === 'ArrowRight')
    ) {
      if (isDirectPlainTextCellEdit(ctx, cache, cellInput, fxInput)) {
        commitDirectPlainCellEdit(ctx, cache, cellInput, canvas);
      }
      handleShiftWithArrowKey(ctx, e);
    } else if (kstr === 'Escape') {
      ctx.contextMenu = {};
      // if (menuButton.luckysheetPaintModelOn) {
      //   menuButton.cancelPaintModel();
      // } else {
      //   cleargridelement(event);
      //   e.preventDefault();
      // }

      // selectHightlightShow();
    } else if (kstr === 'Delete' || kstr === 'Backspace') {
      if (!allowEdit) return;
      if (ctx.activeImg != null) {
        removeActiveImage(ctx);
      } else {
        // Manual modification inside formula editing should invalidate
        // keyboard/mouse-inserted range references.
        if (ctx.formulaCache.rangeSelectionActive === true) {
          markRangeSelectionDirty(ctx);
        }
        deleteSelectedCellText(ctx);
      }

      jfrefreshgrid(ctx, null, undefined);
      e.preventDefault();
      // } else if (kstr === "Backspace" && imageCtrl.currentImgId != null) {
      //   imageCtrl.removeImgItem();
      //   e.preventDefault();
    } else if (
      kstr === 'ArrowUp' ||
      kstr === 'ArrowDown' ||
      kstr === 'ArrowLeft' ||
      kstr === 'ArrowRight'
    ) {
      const isEditing = ctx.luckysheetCellUpdate.length > 0;
      const inlineText = cellInput?.innerText ?? '';
      const fxText = fxInput?.innerText ?? '';
      const isFormulaEdit =
        isEditing &&
        (inlineText.trim().startsWith('=') || fxText.trim().startsWith('='));
      const enteredByTyping = cache.enteredEditByTyping === true;

      if (isEditing && !isFormulaEdit && enteredByTyping && !e.shiftKey) {
        updateCell(
          ctx,
          ctx.luckysheetCellUpdate[0],
          ctx.luckysheetCellUpdate[1],
          cellInput,
          undefined,
          canvas,
        );
        cache.enteredEditByTyping = false;
        clearTypeOverPending(cache);
        handleArrowKey(ctx, e);
        e.preventDefault();
      } else {
        handleArrowKey(ctx, e);
      }
    } else if (
      !(
        (kcode >= 112 && kcode <= 123) ||
        kcode <= 46 ||
        kcode === 144 ||
        kcode === 108 ||
        e.ctrlKey ||
        e.altKey ||
        (e.shiftKey &&
          (kcode === 37 || kcode === 38 || kcode === 39 || kcode === 40))
      ) ||
      kcode === 8 ||
      kcode === 32 ||
      kcode === 46 ||
      kcode === 0 ||
      (e.ctrlKey && kcode === 86)
    ) {
      if (!quickSearchOwnsKeys) {
        if (!allowEdit) return;
        if (
          String.fromCharCode(kcode) != null &&
          !_.isEmpty(ctx.luckysheet_select_save) && // $("#luckysheet-cell-selected").is(":visible") &&
          kstr !== 'CapsLock' &&
          kstr !== 'Win' &&
          kcode !== 18
        ) {
          // 激活输入框，并将按键输入到输入框
          const last =
            ctx.luckysheet_select_save![ctx.luckysheet_select_save!.length - 1];

          const row_index = last.row_focus;
          const col_index = last.column_focus;
          if (_.isNil(row_index) || _.isNil(col_index)) return;

          const flowdata = getFlowdata(ctx);
          const cellAt = flowdata?.[row_index]?.[col_index] as
            | { f?: string }
            | null
            | undefined;
          const existingFormula =
            cellAt?.f != null && String(cellAt.f).trim() !== ''
              ? String(cellAt.f).replace(/[\r\n]/g, '')
              : null;
          const isPercentFormattedCell =
            !!cellAt &&
            typeof (cellAt as any)?.ct?.fa === 'string' &&
            String((cellAt as any).ct.fa).includes('%');
          const isEmptyPercentFormattedCell =
            isPercentFormattedCell &&
            _.isNil((cellAt as any).v) &&
            _.isNil((cellAt as any).m) &&
            _.isNil((cellAt as any).f);

          if (existingFormula != null) {
            suppressFormulaRangeSelectionForInitialEdit(ctx);
          }

          ctx.luckysheetCellUpdate = [row_index, col_index];
          cache.overwriteCell = true;
          cache.pendingTypeOverCell = [row_index, col_index];
          setFormulaEditorOwner(ctx, 'cell');

          // First key replaces the cell content (type-over), same as Excel/Sheets — including
          // when the cell currently holds a formula. Use F2 / double-click to edit in place.
          cache.enteredEditByTyping = true;

          // Fresh type-over must not inherit prior formula range-nav flags; otherwise
          // seeding `=` can race with the InputBox selection-sync effect and become
          // a self-ref (`=A1`) before the user navigates or clicks a range.
          // Type-over replaces cell content, so also drop the "opened existing formula"
          // lock from suppressFormulaRangeSelectionForInitialEdit above.
          ctx.formulaCache.formulaKeyboardRefSync = false;
          ctx.formulaCache.func_selectedrange = undefined;
          ctx.formulaCache.rangestart = false;
          ctx.formulaCache.rangedrag_column_start = false;
          ctx.formulaCache.rangedrag_row_start = false;
          ctx.formulaCache.rangeSelectionActive = null;
          ctx.formulaCache.keyboardRangeSelectionLock = false;

          cellInput.focus();
          const initial = getTypeOverInitialContent(e);
          if (initial === '=') {
            ensureFormulaRangeToSheet(ctx);
          }
          if (initial !== undefined) {
            const shouldSeedPercentSuffix =
              isPercentFormattedCell && /^([0-9]|[.+-])$/.test(initial);
            const seededText = shouldSeedPercentSuffix
              ? `${initial}%`
              : initial;
            cellInput.textContent = seededText;
            if (fxInput) fxInput.textContent = seededText;
            handleFormulaInput(ctx, fxInput, cellInput, kcode);
            e.preventDefault();
          } else {
            cellInput.textContent = '';
            if (fxInput) fxInput.textContent = '';
            handleFormulaInput(ctx, fxInput, cellInput, kcode);
          }

          // After focus + handleFormulaInput, caret can sit before the first character.
          // Only adjust the in-cell editor: moveToEnd() calls focus() and would steal
          // focus to the formula bar if applied to fxInput.
          queueMicrotask(() => {
            const shouldSeedPercentSuffix =
              initial !== undefined &&
              isPercentFormattedCell &&
              /^([0-9]|[.+-])$/.test(initial);
            if (shouldSeedPercentSuffix) {
              const textNode = cellInput.firstChild;
              const caretOffset = Math.max(
                0,
                (cellInput.textContent || '').length - 1,
              );
              const sel = window.getSelection();
              if (textNode && sel) {
                const range = document.createRange();
                range.setStart(
                  textNode,
                  Math.min(caretOffset, textNode.textContent?.length || 0),
                );
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
                return;
              }
            }
            moveToEnd(cellInput);
          });

          // if (kstr === "Backspace") {
          //   $("#luckysheet-rich-text-editor").html("<br/>");
          // }
          // formula.functionInputHanddler(
          //   $("#luckysheet-functionbox-cell"),
          //   $("#luckysheet-rich-text-editor"),
          //   kcode
          // );
        }
      }
    }

    if (!quickSearchOwnsKeys && cellInput !== document.activeElement) {
      cellInput?.focus();
    }

    e.stopPropagation();
  }
}
