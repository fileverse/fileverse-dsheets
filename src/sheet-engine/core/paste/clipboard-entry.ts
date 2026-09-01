/**
 * Clipboard wire-up: Fortune internal paste is decided first (`fortune-internal-paste`),
 * then HTML table / plain / in-cell edit fallbacks re-use `paste-internals` handlers.
 */
import { handlePastedTable } from '../paste-table-helpers';
import type { Context } from '../context';
import { isAllowEdit } from '../utils';
import { selectionCache } from '../modules/selection';
import {
  sanitizeDuneUrl,
  pasteImageItem,
  getImageClipboard,
  getImageCutSourceId,
} from '../modules';
import clipboard from '../modules/clipboard';
import { computeFortuneInternalPasteDecision } from './fortune-internal-paste';
import {
  convertAnyHtmlToTable,
  handleFormulaStringPaste,
  parseAsLinkIfUrl,
  pasteHandler,
  pasteHandlerOfCopyPaste,
  pasteHandlerOfCutPaste,
  resizePastedCellsToContent,
  shouldHandleNonTableHtml,
} from './paste-internals';

function hasPendingCellCopy(ctx: Context): boolean {
  return (
    ctx.luckysheet_copy_save?.copyRange != null &&
    ctx.luckysheet_copy_save.copyRange.length > 0
  );
}

/** Excel-style cell cut/copy using in-memory `luckysheet_copy_save`. */
function tryPasteFromInternalCellClipboard(
  ctx: Context,
  pasteValuesOnly = false,
): boolean {
  if (!hasPendingCellCopy(ctx)) return false;

  if (ctx.luckysheet_paste_iscut) {
    ctx.luckysheet_paste_iscut = false;
    pasteHandlerOfCutPaste(ctx, ctx.luckysheet_copy_save);
    ctx.luckysheet_selection_range = [];
  } else {
    pasteHandlerOfCopyPaste(ctx, ctx.luckysheet_copy_save, pasteValuesOnly);
  }
  resizePastedCellsToContent(ctx);
  return true;
}

function tryPasteImage(ctx: Context, html?: string): boolean {
  if (getImageCutSourceId() || getImageClipboard()) {
    return pasteImageItem(ctx, html);
  }
  if (html && html.indexOf('fortune-copy-action-image') > -1) {
    return pasteImageItem(ctx, html);
  }
  return false;
}

export function handlePaste(ctx: Context, e: ClipboardEvent) {
  const allowEdit = isAllowEdit(ctx);
  if (!allowEdit || ctx.isFlvReadOnly) return;

  if (!selectionCache.isPasteAction) {
    return;
  }

  if (selectionCache.isPasteAction) {
    ctx.luckysheetCellUpdate = [];
    selectionCache.isPasteAction = false;
    const pasteValuesOnly = selectionCache.isPasteValuesOnly;
    selectionCache.isPasteValuesOnly = false;

    let { clipboardData } = e;
    if (!clipboardData) {
      // @ts-ignore
      clipboardData = window.clipboardData;
    }

    if (!clipboardData) return;
    const text = clipboardData.getData('text/plain');
    if (text) {
      parseAsLinkIfUrl(text, ctx);
    }

    let txtdata =
      clipboardData.getData('text/html') || clipboardData.getData('text/plain');

    if (
      pasteValuesOnly &&
      txtdata.indexOf('fortune-copy-action-table') === -1 &&
      txtdata.indexOf('fortune-copy-action-span') === -1
    ) {
      txtdata = clipboardData.getData('text/plain');
    }

    if (
      ctx.hooks.beforePaste?.(ctx.luckysheet_select_save, txtdata) === false
    ) {
      return;
    }

    // 1) Floating-image cut/copy (in-memory flag — do not require system HTML)
    if (tryPasteImage(ctx, txtdata)) {
      e.preventDefault();
      return;
    }

    // 2) Cell cut: always clear source from luckysheet_copy_save when iscut,
    // even if system clipboard HTML was stripped / doesn't match the grid.
    if (ctx.luckysheet_paste_iscut && hasPendingCellCopy(ctx)) {
      e.preventDefault();
      tryPasteFromInternalCellClipboard(ctx, pasteValuesOnly);
      return;
    }

    const fortunePaste = computeFortuneInternalPasteDecision(ctx, txtdata);
    if (fortunePaste.abortPaste) {
      return;
    }
    const { internalFortunePaste } = fortunePaste;

    const useInternal =
      (txtdata.indexOf('fortune-copy-action-table') > -1 ||
        txtdata.indexOf('fortune-copy-action-span') > -1) &&
      hasPendingCellCopy(ctx) &&
      internalFortunePaste;

    if (useInternal) {
      tryPasteFromInternalCellClipboard(ctx, pasteValuesOnly);
    } else {
      const shouldHandleAsHtml =
        /<table[\s/>]/i.test(txtdata) || shouldHandleNonTableHtml(txtdata);

      if (shouldHandleAsHtml) {
        const hasNativeTable = /<table[\s/>]/i.test(txtdata);
        const converted = hasNativeTable
          ? txtdata
          : convertAnyHtmlToTable(txtdata);
        handlePastedTable(ctx, converted, pasteHandler);
        // Previously the content auto-fit ran here for dsheet→dsheet (fortune) pastes.
        // That OVERRODE the source geometry: measuring the whole pasted range (e.g. an
        // entire sheet) inflated each column to its widest cell anywhere in the column
        // and then collapsed tall wrapped rows measured at the inflated width. Now that
        // handlePastedTable restores geometry exactly — column widths from <colgroup>,
        // row heights from the first cell's inline style — the auto-fit is unnecessary
        // and harmful for fortune pastes, so it is not run here. (External HTML pastes
        // already did not resize here; that behaviour is unchanged.)
      } else if (
        clipboardData.files.length === 1 &&
        clipboardData.files[0].type.indexOf('image') > -1
      ) {
        // Image files are async — handled in Workbook onPaste before this path.
      } else {
        txtdata = clipboardData.getData('text/plain');
        const isExcelFormula = txtdata.startsWith('=');

        if (isExcelFormula) {
          handleFormulaStringPaste(ctx, txtdata);
        } else {
          pasteHandler(ctx, txtdata);

          const _txtdata =
            clipboardData.getData('text/html') ||
            clipboardData.getData('text/plain');
          const embedUrl = sanitizeDuneUrl(_txtdata);
          if (embedUrl) {
            const last =
              ctx.luckysheet_select_save?.[
                ctx.luckysheet_select_save.length - 1
              ];
            if (last) {
              const rowIndex = last.row_focus ?? last.row?.[0] ?? 0;
              const colIndex = last.column_focus ?? last.column?.[0] ?? 0;

              const left =
                colIndex === 0 ? 0 : ctx.visibledatacolumn[colIndex - 1];
              const top = rowIndex === 0 ? 0 : ctx.visibledatarow[rowIndex + 5];
              ctx.showDunePreview = {
                url: txtdata,
                position: { left, top },
              };
            }
          }
        }
        resizePastedCellsToContent(ctx);
      }
    }
  } else if (ctx.luckysheetCellUpdate.length > 0) {
    e.preventDefault();

    let { clipboardData } = e;
    if (!clipboardData) {
      // @ts-ignore
      clipboardData = window.clipboardData;
    }
    const text = clipboardData?.getData('text/plain');
    if (text) {
      document.execCommand('insertText', false, text);
      parseAsLinkIfUrl(text, ctx);
      resizePastedCellsToContent(ctx);
    }
  }
}

export function handlePasteByClick(
  ctx: Context,
  clipboardData: string,
  triggerType?: string,
) {
  const allowEdit = isAllowEdit(ctx);
  if (!allowEdit || ctx.isFlvReadOnly) return;

  // 1) In-app image cut/copy
  const existing = document.querySelector('#fortune-copy-content');
  const existingHtml = existing?.innerHTML || '';
  if (tryPasteImage(ctx, existingHtml)) {
    return;
  }

  // 2) In-app cell cut/copy (do not depend on navigator.clipboard.readText)
  if (hasPendingCellCopy(ctx)) {
    if (ctx.hooks.beforePaste?.(ctx.luckysheet_select_save, '') === false) {
      return;
    }
    tryPasteFromInternalCellClipboard(ctx);
    return;
  }

  if (clipboardData) {
    const htmlWithPreservedNewlines = `<pre style="white-space: pre-wrap;">${clipboardData}</pre>`;
    clipboard.writeHtml(htmlWithPreservedNewlines);
  }

  const textarea = document.querySelector('#fortune-copy-content');
  const data = textarea?.innerHTML || textarea?.textContent;
  if (!data) return;

  if (ctx.hooks.beforePaste?.(ctx.luckysheet_select_save, data) === false) {
    return;
  }

  const fortunePaste = computeFortuneInternalPasteDecision(ctx, data);
  if (fortunePaste.abortPaste) {
    return;
  }
  const { internalFortunePaste } = fortunePaste;

  if (
    (data.indexOf('fortune-copy-action-table') > -1 ||
      data.indexOf('fortune-copy-action-span') > -1) &&
    hasPendingCellCopy(ctx) &&
    internalFortunePaste
  ) {
    tryPasteFromInternalCellClipboard(ctx);
  } else if (data.indexOf('fortune-copy-action-image') > -1) {
    pasteImageItem(ctx, data);
  } else if (triggerType !== 'btn') {
    const isExcelFormula = clipboardData.startsWith('=');

    if (isExcelFormula) {
      handleFormulaStringPaste(ctx, clipboardData);
    } else {
      pasteHandler(ctx, clipboardData);
    }
  }
}
