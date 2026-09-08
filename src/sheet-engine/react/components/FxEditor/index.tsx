import {
  getFlowdata,
  cancelNormalSelected,
  getCellValue,
  updateCell,
  getInlineStringNoStyle,
  isInlineStringCell,
  escapeScriptTag,
  moveHighlightCell,
  handleFormulaInput,
  getFormulaRangeIndexAtCaret,
  isCaretAtValidFormulaRangeInsertionPoint,
  markRangeSelectionDirty,
  rangeHightlightselected,
  getFormulaEditorOwner,
  setFormulaEditorOwner,
  createRangeHightlight,
  valueShowEs,
  isShowHidenCR,
  escapeHTMLTag,
  functionHTMLGenerate,
  isAllowEdit,
  suppressFormulaRangeSelectionForInitialEdit,
  ensureFormulaRangeToSheet,
  returnToFormulaOriginSheet,
  normalizeSelection,
  snapSheetSelectionFocusToCellPreserveMultiRange,
  advancePrimaryCellInLastMultiSelection,
  isLegacyFormulaRangeMode,
  isFormulaReferenceInputMode,
} from '@sheet-engine/core';
import React, {
  useContext,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
} from 'react';
import './index.css';
import _ from 'lodash';
import { Tooltip } from '@fileverse/ui';
import WorkbookContext from '../../context';
import ContentEditable from '../SheetOverlay/ContentEditable';
import NameBox from './NameBox';
import FormulaSearch from '../SheetOverlay/FormulaSearch';
import FormulaHint from '../SheetOverlay/FormulaHint';
import CellDatePicker from '../SheetOverlay/CellDatePicker';
import usePrevious from '../../hooks/usePrevious';
import { useFormulaEditorHistory } from '../../hooks/useFormulaEditorHistory';
import { useRerenderOnFormulaCaret } from '../../hooks/useRerenderOnFormulaCaret';
import { LucideIcon } from '../SheetOverlay/LucideIcon';

import {
  countCommasBeforeCursor,
  getCursorPosition,
  getFunctionNameFromFormulaCaretSpans,
  isEditorUndoRedoKeyEvent,
  isLetterNumberPattern,
  setCursorPosition,
  buildFormulaSuggestionText,
  shouldShowFormulaFunctionList,
  isStrictFormulaEditorText,
  isFormulaCompleteAtCaret,
} from '../SheetOverlay/helper';
import { isFormulaSegmentBoundaryKey } from '../SheetOverlay/formula-segment-boundary';

const FxEditor: React.FC = () => {
  const hideFormulaHintLocal = localStorage.getItem('formulaMore') === 'true';
  const [showSearchHint, setShowSearchHint] = useState(false);
  const [showFormulaHint, setShowFormulaHint] = useState(!hideFormulaHintLocal);
  const [commaCount, setCommaCount] = useState(0);
  const { context, setContext, refs } = useContext(WorkbookContext);
  const lastKeyDownEventRef = useRef<KeyboardEvent | null>(null);
  const {
    preTextRef,
    resetFormulaHistory,
    handleFormulaHistoryUndoRedo,
    capturePreEditorHistoryState,
    appendEditorHistoryFromPrimaryEditor,
  } = useFormulaEditorHistory(
    refs.fxInput,
    refs.cellInput,
    refs.fxInput,
    setContext,
    'fx',
  );
  const inputContainerRef = useRef<HTMLDivElement | null>(null);
  const [isHidenRC, setIsHidenRC] = useState<boolean>(false);
  const firstSelection = context.luckysheet_select_save?.[0];
  const formulaSearchTopLockRef = useRef<{
    cellKey: string;
    top: number;
  } | null>(null);
  const formulaSearchActiveCellKey =
    !_.isEmpty(context.luckysheetCellUpdate) && firstSelection
      ? `${context.currentSheetId}:${firstSelection.row_focus}:${firstSelection.column_focus}`
      : null;
  const lockedFormulaSearchTop =
    formulaSearchActiveCellKey &&
      formulaSearchTopLockRef.current?.cellKey === formulaSearchActiveCellKey
      ? formulaSearchTopLockRef.current.top
      : null;
  const prevCellUpdate = usePrevious<any[]>(context.luckysheetCellUpdate);
  const prevSheetId = usePrevious(context.currentSheetId);
  const recentText = useRef('');
  const formulaAnchorCellRef = useRef<[number, number] | null>(null);

  const handleShowFormulaHint = () => {
    localStorage.setItem('formulaMore', String(showFormulaHint));
    setShowFormulaHint(!showFormulaHint);
  };

  useEffect(() => {
    // Unlock formula search popup top when leaving edit mode or changing cell.
    if (!formulaSearchActiveCellKey) {
      formulaSearchTopLockRef.current = null;
      return;
    }
    if (
      formulaSearchTopLockRef.current?.cellKey !== formulaSearchActiveCellKey
    ) {
      formulaSearchTopLockRef.current = null;
    }
  }, [formulaSearchActiveCellKey]);

  const handleFormulaSearchTopComputed = useCallback(
    (computedTop: number) => {
      if (!formulaSearchActiveCellKey) return;
      if (
        formulaSearchTopLockRef.current?.cellKey === formulaSearchActiveCellKey
      )
        return;
      formulaSearchTopLockRef.current = {
        cellKey: formulaSearchActiveCellKey,
        top: computedTop,
      };
    },
    [formulaSearchActiveCellKey],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F10') {
        event.preventDefault();
        handleShowFormulaHint();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showFormulaHint]);

  useEffect(() => {
    // 当选中行列是处于隐藏状态的话则不允许编辑
    setIsHidenRC(isShowHidenCR(context));
    if (context.luckysheetCellUpdate.length > 0) {
      return;
    }
    const d = getFlowdata(context);
    let value = '';
    if (firstSelection) {
      const r = firstSelection.row_focus;
      const c = firstSelection.column_focus;
      if (_.isNil(r) || _.isNil(c)) return;

      const cell = d?.[r]?.[c];
      if (cell) {
        if (isInlineStringCell(cell)) {
          value = getInlineStringNoStyle(r, c, d);
        } else if (cell.f) {
          value = getCellValue(r, c, d, 'f');
        } else if (cell.ct?.t === 'd') {
          value = getCellValue(r, c, d, 'f');
        } else {
          value = valueShowEs(r, c, d);
        }
      }
      refs.fxInput.current!.innerHTML = escapeHTMLTag(escapeScriptTag(value));
    } else {
      refs.fxInput.current!.innerHTML = '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    context.luckysheetfile,
    context.currentSheetId,
    context.luckysheet_select_save,
    context.luckysheetCellUpdate.length,
  ]);

  useLayoutEffect(() => {
    const fxInput = refs.fxInput.current;
    if (context.luckysheetCellUpdate.length === 0 || !fxInput) {
      return;
    }

    if (refs.globalCache.doNotUpdateCell) {
      delete refs.globalCache.doNotUpdateCell;
      return;
    }

    if (
      _.isEqual(prevCellUpdate, context.luckysheetCellUpdate) &&
      prevSheetId === context.currentSheetId
    ) {
      return;
    }

    const [rowIndex, colIndex] = context.luckysheetCellUpdate;
    if (_.isNil(rowIndex) || _.isNil(colIndex)) {
      return;
    }

    const pending = refs.globalCache.pendingTypeOverCell;
    if (pending && pending[0] === rowIndex && pending[1] === colIndex) {
      refs.globalCache.overwriteCell = false;
      refs.globalCache.ignoreWriteCell = false;
      // pendingTypeOverCell cleared in InputBox useEffect after commit (Strict Mode safe).
      return;
    }

    const flowdata = getFlowdata(context);
    if (!flowdata) {
      return;
    }
    const cell = flowdata?.[rowIndex]?.[colIndex];
    const formulaEditHtml =
      cell?.f && typeof cell?._formulaEditHtml === 'string'
        ? cell._formulaEditHtml
        : '';
    const mirrorSegV = cell?.ct?.s?.[0]?.v;
    const ctMirrorMultiline =
      !!cell?.f && typeof mirrorSegV === 'string' && /[\r\n]/.test(mirrorSegV);
    const formulaEditHtmlMissingBr =
      typeof formulaEditHtml === 'string' &&
      formulaEditHtml.length > 0 &&
      !/<br\s*\/?>/i.test(formulaEditHtml);
    const preferFormulaHtmlFromMirror =
      ctMirrorMultiline && formulaEditHtmlMissingBr;
    let value = '';
    const overwrite = refs.globalCache.overwriteCell;

    if (cell && !overwrite) {
      if (isInlineStringCell(cell)) {
        value = getInlineStringNoStyle(rowIndex, colIndex, flowdata);
      } else if (cell.f) {
        value = getCellValue(rowIndex, colIndex, flowdata, 'f');
      } else if (cell.ct?.t === 'd') {
        value = getCellValue(rowIndex, colIndex, flowdata, 'f');
      } else {
        value = valueShowEs(rowIndex, colIndex, flowdata);
      }
    }

    refs.globalCache.overwriteCell = false;
    if (
      !refs.globalCache.ignoreWriteCell &&
      formulaEditHtml &&
      !preferFormulaHtmlFromMirror
    ) {
      fxInput.innerHTML = formulaEditHtml;
    } else if (!refs.globalCache.ignoreWriteCell && value) {
      fxInput.innerHTML = escapeHTMLTag(escapeScriptTag(value));
    } else if (!refs.globalCache.ignoreWriteCell && !overwrite) {
      const valueD = getCellValue(rowIndex, colIndex, flowdata, 'f');
      fxInput.innerText = valueD;
    }
    refs.globalCache.ignoreWriteCell = false;
  }, [
    context.luckysheetCellUpdate,
    context.luckysheetfile,
    context.currentSheetId,
    prevCellUpdate,
    prevSheetId,
    refs.fxInput,
    refs.globalCache,
  ]);

  useEffect(() => {
    if (_.isEmpty(context.luckysheetCellUpdate)) {
      delete refs.globalCache.pendingTypeOverCell;
      resetFormulaHistory();
    }
  }, [context.luckysheetCellUpdate, resetFormulaHistory, refs.globalCache]);

  useEffect(() => {
    if (_.isEmpty(context.luckysheetCellUpdate) || !refs.fxInput.current) {
      formulaAnchorCellRef.current = null;
      return;
    }
    const inputText = refs.fxInput.current.innerText?.trim() || '';
    if (!inputText.startsWith('=')) {
      formulaAnchorCellRef.current = null;
    }
  }, [context.luckysheetCellUpdate, refs.fxInput]);

  useEffect(() => {
    if (!context.formulaCache.refocusFormulaEditorAfterSheetSwitch) return;
    if (context.luckysheetCellUpdate.length === 0) return;
    if (getFormulaEditorOwner(context) !== 'fx') return;

    const editor = refs.fxInput.current;
    if (!editor) return;

    setContext((ctx) => {
      ctx.formulaCache.refocusFormulaEditorAfterSheetSwitch = false;
    });

    requestAnimationFrame(() => {
      editor.focus({ preventScroll: true });
      const managed = editor.querySelector(
        'span.fortune-formula-functionrange-cell',
      ) as HTMLElement | null;
      if (managed?.firstChild?.nodeType === Node.TEXT_NODE) {
        const sel = window.getSelection();
        const textNode = managed.firstChild;
        if (sel && textNode) {
          const range = document.createRange();
          range.setStart(textNode, textNode.textContent?.length ?? 0);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    });
  }, [
    context.formulaCache.refocusFormulaEditorAfterSheetSwitch,
    context.currentSheetId,
    context.luckysheetCellUpdate.length,
    context,
    refs.fxInput,
    setContext,
  ]);

  const onFocus = useCallback(() => {
    if (context.allowEdit === false) {
      return;
    }
    if (
      (context.luckysheet_select_save?.length ?? 0) > 0 &&
      !context.luckysheet_cell_selected_move &&
      isAllowEdit(context, context.luckysheet_select_save)
    ) {
      setContext((draftCtx) => {
        setFormulaEditorOwner(draftCtx, 'fx');
        const last =
          draftCtx.luckysheet_select_save![
          draftCtx.luckysheet_select_save!.length - 1
          ];

        const row_index = last.row_focus;
        const col_index = last.column_focus;

        if (!_.isNil(row_index) && !_.isNil(col_index)) {
          const flowdata = getFlowdata(draftCtx);
          const cellAt = flowdata?.[row_index]?.[col_index] as
            | { f?: string }
            | null
            | undefined;
          if (cellAt?.f != null && String(cellAt.f).trim() !== '') {
            suppressFormulaRangeSelectionForInitialEdit(draftCtx);
          }
        }

        // draftCtx.luckysheetCellUpdate = [row_index, col_index];
        // refs.globalCache.doNotFocus = true;
        const currentUpdate = draftCtx.luckysheetCellUpdate || [];
        const alreadyEditingSameCell =
          currentUpdate.length === 2 &&
          currentUpdate[0] === row_index &&
          currentUpdate[1] === col_index;

        if (!alreadyEditingSameCell) {
          // Preserve mouse-placed caret on first FX focus-open. Without this,
          // the follow-up FX sync effect can rewrite innerHTML and clear the
          // click position (especially for formula text starting with "=").
          refs.globalCache.doNotUpdateCell = true;
          draftCtx.luckysheetCellUpdate = [row_index, col_index];
          refs.globalCache.doNotFocus = true;
        }
        // formula.rangeResizeTo = $("#luckysheet-functionbox-cell");
      });
    }
    setContext((draftCtx) => {
      setFormulaEditorOwner(draftCtx, 'fx');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    context.config,
    context.luckysheet_select_save,
    context.luckysheetfile,
    context.currentSheetId,
    refs.globalCache,
    setContext,
  ]);

  const getActiveFormula = useCallback(
    () => document.querySelector('.luckysheet-formula-search-item-active'),
    [],
  );
  const insertSelectedFormula = useCallback(
    (formulaName: string) => {
      const fxEditor = refs.fxInput.current;
      if (!fxEditor) return;

      const cellEditor = document.getElementById(
        'luckysheet-rich-text-editor',
      ) as HTMLDivElement | null;
      const { text, caretOffset } = buildFormulaSuggestionText(
        fxEditor,
        formulaName,
      );
      const safeText = escapeScriptTag(text);
      const html = safeText.startsWith('=')
        ? functionHTMLGenerate(safeText)
        : escapeHTMLTag(safeText);

      fxEditor.innerHTML = html;
      if (cellEditor) {
        cellEditor.innerHTML = html;
      }
      setCursorPosition(fxEditor, caretOffset);
      setShowSearchHint(shouldShowFormulaFunctionList(fxEditor));
      setContext((draftCtx) => {
        draftCtx.functionCandidates = [];
        draftCtx.defaultCandidates = [];
        draftCtx.functionHint = (formulaName || '').toUpperCase();
      });
    },
    [refs.fxInput, setContext],
  );

  const clearSearchItemActiveClass = useCallback(() => {
    const activeFormula = getActiveFormula();
    if (activeFormula) {
      activeFormula.classList.remove('luckysheet-formula-search-item-active');
    }
  }, [getActiveFormula]);

  const getLastInputSpanText = () => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(
      `<div>${refs.fxInput?.current?.innerHTML}</div>`,
      'text/html',
    );
    const spans = doc.querySelectorAll('span');
    const lastSpan = spans[spans.length - 1];
    return lastSpan?.innerText;
  };

  const selectActiveFormulaOnClick = useCallback(
    (e: React.MouseEvent) => {
      // @ts-expect-error later
      if (e.target.className.includes('sign-fortune')) return;
      preTextRef.current = refs.fxInput?.current!.innerText;
      recentText.current = refs.fxInput?.current!.innerText;
      const formulaName = getActiveFormula()?.querySelector(
        '.luckysheet-formula-search-func',
      )?.textContent;
      const lastSpanText = getLastInputSpanText();

      if (formulaName && !isLetterNumberPattern(lastSpanText)) {
        insertSelectedFormula(formulaName);
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [getActiveFormula, insertSelectedFormula],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const anchor = formulaAnchorCellRef.current;
        if (anchor != null) {
          const [anchorRow, anchorCol] = anchor;
          const onForeignSheet =
            !!context.formulaCache.rangetosheet &&
            context.formulaCache.rangetosheet !== context.currentSheetId;
          // skipNextAnchorSelectionSyncRef.current = true;
          setTimeout(() => {
            setContext((draftCtx) => {
              draftCtx.luckysheetCellUpdate = [anchorRow, anchorCol];
              if (!onForeignSheet) {
                snapSheetSelectionFocusToCellPreserveMultiRange(
                  draftCtx,
                  anchorRow,
                  anchorCol,
                );
                // Recompute selection box immediately so UI snaps back to anchor cell.
                moveHighlightCell(draftCtx, 'down', 0, 'rangeOfSelect');
              }
              draftCtx.formulaCache.formulaKeyboardRefSync = false;
              markRangeSelectionDirty(draftCtx);
              // Keep completed referenced-cell highlights persistent in Fx editor
              // after delete/backspace, same behavior as in-cell editor.
              const el = refs.fxInput.current;
              if (el && el.innerText.trim().startsWith('=')) {
                createRangeHightlight(draftCtx, el.innerHTML);
                rangeHightlightselected(draftCtx, el);
              }
            });
          }, 0);
        }
      }
      if (context.allowEdit === false) {
        return;
      }
      setContext((draftCtx) => {
        setFormulaEditorOwner(draftCtx, 'fx');
      });
      const currentCommaCount = countCommasBeforeCursor(refs.fxInput?.current!);
      setCommaCount(currentCommaCount);
      lastKeyDownEventRef.current = new KeyboardEvent(e.type, e.nativeEvent);
      if (!isEditorUndoRedoKeyEvent(e.nativeEvent)) {
        capturePreEditorHistoryState();
      }
      const isPotentialContentKey =
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key.length === 1 ||
          e.key === 'Backspace' ||
          e.key === 'Delete' ||
          e.key === 'Enter' ||
          e.key === 'Tab');
      if (isPotentialContentKey) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (getFormulaEditorOwner(context) !== 'fx') return;
            appendEditorHistoryFromPrimaryEditor(() =>
              getCursorPosition(refs.fxInput.current!),
            );
          });
        });
      }
      recentText.current = refs.fxInput.current!.innerText;
      const { key } = e;
      const currentInputText = refs.fxInput.current?.innerText?.trim() || '';

      if (
        (key === '=' || currentInputText.startsWith('=')) &&
        context.luckysheetCellUpdate.length === 2 &&
        formulaAnchorCellRef.current == null
      ) {
        // Starting a new formula flow — clear stale keyboard/mouse range state so
        // idle selection on the edit cell cannot become a self-ref (`=` → `=A1`).
        setContext((draftCtx) => {
          ensureFormulaRangeToSheet(draftCtx);
          draftCtx.formulaCache.rangeSelectionActive = null;
          draftCtx.formulaCache.formulaKeyboardRefSync = false;
          draftCtx.formulaCache.func_selectedrange = undefined;
          draftCtx.formulaCache.rangestart = false;
          draftCtx.formulaCache.rangedrag_column_start = false;
          draftCtx.formulaCache.rangedrag_row_start = false;
          draftCtx.formulaRangeSelect = undefined;
        });
        formulaAnchorCellRef.current = [
          context.luckysheetCellUpdate[0],
          context.luckysheetCellUpdate[1],
        ];
      }

      if (key === '(' && currentInputText.startsWith('=')) {
        setContext((draftCtx) => {
          draftCtx.formulaCache.rangeSelectionActive = null;
        });
      }

      if (
        isFormulaSegmentBoundaryKey(key) &&
        context.luckysheetCellUpdate.length > 0 &&
        currentInputText.startsWith('=') &&
        formulaAnchorCellRef.current
      ) {
        setContext((draftCtx) => {
          draftCtx.formulaCache.rangeSelectionActive = null;
        });
        const [anchorRow, anchorCol] = formulaAnchorCellRef.current;
        const onForeignSheet =
          !!context.formulaCache.rangetosheet &&
          context.formulaCache.rangetosheet !== context.currentSheetId;
        setTimeout(() => {
          setContext((draftCtx) => {
            draftCtx.luckysheetCellUpdate = [anchorRow, anchorCol];
            if (!onForeignSheet) {
              snapSheetSelectionFocusToCellPreserveMultiRange(
                draftCtx,
                anchorRow,
                anchorCol,
              );
            }
            draftCtx.formulaCache.formulaKeyboardRefSync = false;
            draftCtx.formulaRangeSelect = undefined;
            draftCtx.formulaCache.selectingRangeIndex = -1;
            draftCtx.formulaCache.func_selectedrange = undefined;
            draftCtx.formulaCache.rangechangeindex = undefined;
            draftCtx.formulaCache.rangestart = false;
            draftCtx.formulaCache.rangedrag_column_start = false;
            draftCtx.formulaCache.rangedrag_row_start = false;
            createRangeHightlight(
              draftCtx,
              refs.fxInput.current?.innerHTML ||
              refs.cellInput.current?.innerHTML ||
              '',
            );
            if (!onForeignSheet) {
              moveHighlightCell(draftCtx, 'down', 0, 'rangeOfSelect');
            }
          });
        }, 0);
      }

      // Block bubbling so in-editor Left/Right still run `rangeHightlightselected`
      // below — except for type-to-edit plain text, where core must see
      // Shift/Cmd/Ctrl + Arrow (including Cmd+Shift+Arrow) to commit and move the grid.
      const isArrowKey =
        key === 'ArrowUp' ||
        key === 'ArrowDown' ||
        key === 'ArrowLeft' ||
        key === 'ArrowRight';
      const isDirectPlainTypeEdit =
        context.luckysheetCellUpdate.length > 0 &&
        refs.globalCache?.enteredEditByTyping === true &&
        !currentInputText.startsWith('=');
      const sheetArrowShortcut =
        isArrowKey && (e.metaKey || e.ctrlKey || e.shiftKey);
      const formulaRefSheetArrow =
        context.luckysheetCellUpdate.length > 0 &&
        currentInputText.startsWith('=') &&
        isFormulaReferenceInputMode(context);
      // Let `handleGlobalKeyDown` run `handleArrowKey` / `handleShiftWithArrowKey` /
      // Ctrl+Arrow — same as in-cell; stopPropagation would leave Shift+Arrow to
      // native contenteditable selection and skip the blue formula range path.
      if (formulaRefSheetArrow && sheetArrowShortcut) {
        e.preventDefault();
      }
      if (
        (key === 'ArrowLeft' || key === 'ArrowRight') &&
        !(isDirectPlainTypeEdit && sheetArrowShortcut) &&
        !formulaRefSheetArrow
      ) {
        e.stopPropagation();
      }

      if ((e.metaKey || e.ctrlKey) && context.luckysheetCellUpdate.length > 0) {
        if (e.code === 'KeyZ' || e.code === 'KeyY') {
          const isRedo =
            e.code === 'KeyY' || (e.code === 'KeyZ' && (e as any).shiftKey);
          // Always intercept undo/redo in-editor to avoid native browser
          // history fighting our snapshot stack.
          e.preventDefault();
          e.stopPropagation();

          const attempt = (triesLeft: number) => {
            const handled = handleFormulaHistoryUndoRedo(isRedo);
            if (handled) return;
            if (triesLeft <= 0) return;
            requestAnimationFrame(() => {
              requestAnimationFrame(() => attempt(triesLeft - 1));
            });
          };

          attempt(2);
          return;
        }
      }

      if (
        (e.key === 'Enter' || e.key === 'Tab') &&
        context.luckysheetCellUpdate.length > 0
      ) {
        if (e.altKey || e.metaKey) {
          // originally `enterKeyControll`
          document.execCommand('insertHTML', false, '\n '); // 换行符后面的空白符是为了强制让他换行，在下一步的delete中会删掉
          document.execCommand('delete', false);
          e.stopPropagation();
        } else {
          const event = e as unknown;
          selectActiveFormulaOnClick(event as React.MouseEvent);
        }
        return;
      }

      if (
        !(e.metaKey || e.ctrlKey) &&
        e.key === 'ArrowUp' &&
        context.luckysheetCellUpdate.length > 0
      ) {
        if (document.getElementById('luckysheet-formula-search-c')) {
          const formulaSearchContainer = document.getElementById(
            'luckysheet-formula-search-c',
          );
          const activeItem = formulaSearchContainer?.querySelector(
            '.luckysheet-formula-search-item-active',
          );
          let previousItem = activeItem
            ? activeItem.previousElementSibling
            : null;
          while (
            previousItem &&
            !previousItem.classList.contains('luckysheet-formula-search-item')
          ) {
            previousItem = previousItem.previousElementSibling;
          }
          if (!previousItem) {
            const items = formulaSearchContainer?.querySelectorAll(
              '.luckysheet-formula-search-item',
            );
            const lastItem = items?.[items.length - 1];
            previousItem = lastItem || null;
          }
          clearSearchItemActiveClass();
          if (previousItem) {
            previousItem.classList.add('luckysheet-formula-search-item-active');
          }
        }
        e.preventDefault();
      } else if (
        !(e.metaKey || e.ctrlKey) &&
        e.key === 'ArrowDown' &&
        context.luckysheetCellUpdate.length > 0
      ) {
        if (document.getElementById('luckysheet-formula-search-c')) {
          const formulaSearchContainer = document.getElementById(
            'luckysheet-formula-search-c',
          );
          const activeItem = formulaSearchContainer?.querySelector(
            '.luckysheet-formula-search-item-active',
          );
          let nextItem = activeItem ? activeItem.nextElementSibling : null;
          while (
            nextItem &&
            !nextItem.classList.contains('luckysheet-formula-search-item')
          ) {
            nextItem = nextItem.nextElementSibling;
          }
          if (!nextItem) {
            nextItem =
              formulaSearchContainer?.querySelector(
                '.luckysheet-formula-search-item',
              ) || null;
          }
          clearSearchItemActiveClass();
          if (nextItem) {
            nextItem.classList.add('luckysheet-formula-search-item-active');
          }
        }
        e.preventDefault();
      }

      setContext((draftCtx) => {
        if (context.luckysheetCellUpdate.length > 0) {
          switch (key) {
            case 'Enter': {
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
              const lastCellUpdate = _.clone(draftCtx.luckysheetCellUpdate);
              const legacyFormulaRange = isLegacyFormulaRangeMode(draftCtx);
              const selSnapshot =
                draftCtx.luckysheet_select_save != null
                  ? _.cloneDeep(draftCtx.luckysheet_select_save)
                  : undefined;
              const lastBefore = selSnapshot?.[selSnapshot.length - 1];
              const wasMulti =
                !!lastBefore &&
                (lastBefore.row[0] !== lastBefore.row[1] ||
                  lastBefore.column[0] !== lastBefore.column[1]);

              updateCell(
                draftCtx,
                draftCtx.luckysheetCellUpdate[0],
                draftCtx.luckysheetCellUpdate[1],
                refs.fxInput.current!,
              );

              if (wasMulti && !legacyFormulaRange && selSnapshot) {
                draftCtx.luckysheet_select_save = _.cloneDeep(selSnapshot);
                const lastSel =
                  draftCtx.luckysheet_select_save[
                  draftCtx.luckysheet_select_save.length - 1
                  ];
                lastSel.row_focus = lastCellUpdate[0];
                lastSel.column_focus = lastCellUpdate[1];
                normalizeSelection(draftCtx, draftCtx.luckysheet_select_save);
                advancePrimaryCellInLastMultiSelection(draftCtx, !e.shiftKey);
                // Stay out of edit mode after commit (same as in-cell Enter path).
              } else {
                draftCtx.luckysheet_select_save = [
                  {
                    row: [lastCellUpdate[0], lastCellUpdate[0]],
                    column: [lastCellUpdate[1], lastCellUpdate[1]],
                    row_focus: lastCellUpdate[0],
                    column_focus: lastCellUpdate[1],
                  },
                ];
                normalizeSelection(draftCtx, draftCtx.luckysheet_select_save);
                moveHighlightCell(draftCtx, 'down', 1, 'rangeOfSelect');
              }
              // $("#luckysheet-rich-text-editor").focus();
              // }
              e.preventDefault();
              e.stopPropagation();
              break;
            }
            case 'Escape': {
              returnToFormulaOriginSheet(draftCtx);
              cancelNormalSelected(draftCtx);
              moveHighlightCell(draftCtx, 'down', 0, 'rangeOfSelect');
              // $("#luckysheet-functionbox-cell").blur();
              // $("#luckysheet-rich-text-editor").focus();
              e.preventDefault();
              e.stopPropagation();
              break;
            }
            /*
              case "F4": {
                formula.setfreezonFuc(event);
                e.preventDefault();
                e.stopPropagation();
                break;
              }
              case "ArrowUp": {
                if ($("#luckysheet-formula-search-c").is(":visible")) {
                  let $up = $("#luckysheet-formula-search-c")
                    .find(".luckysheet-formula-search-item-active")
                    .prev();
                  if ($up.length === 0) {
                    $up = $("#luckysheet-formula-search-c")
                      .find(".luckysheet-formula-search-item")
                      .last();
                  }
                  $("#luckysheet-formula-search-c")
                    .find(".luckysheet-formula-search-item")
                    .removeClass("luckysheet-formula-search-item-active");
                  $up.addClass("luckysheet-formula-search-item-active");
                }
                e.preventDefault();
                e.stopPropagation();
                break;
              }
              case "ArrowDown": {
                if ($("#luckysheet-formula-search-c").is(":visible")) {
                  let $up = $("#luckysheet-formula-search-c")
                    .find(".luckysheet-formula-search-item-active")
                    .next();
                  if ($up.length === 0) {
                    $up = $("#luckysheet-formula-search-c")
                      .find(".luckysheet-formula-search-item")
                      .first();
                  }
                  $("#luckysheet-formula-search-c")
                    .find(".luckysheet-formula-search-item")
                    .removeClass("luckysheet-formula-search-item-active");
                  $up.addClass("luckysheet-formula-search-item-active");
                }
                e.preventDefault();
                e.stopPropagation();
                break;
              }
              */
            case 'ArrowLeft': {
              rangeHightlightselected(draftCtx, refs.fxInput.current!);
              break;
            }
            case 'ArrowRight': {
              rangeHightlightselected(draftCtx, refs.fxInput.current!);
              break;
            }
            default:
              break;
          }
        }
      });
    },
    [
      capturePreEditorHistoryState,
      context.allowEdit,
      context.luckysheetCellUpdate,
      handleFormulaHistoryUndoRedo,
      refs.cellInput,
      refs.fxInput,
      setContext,
    ],
  );

  const handleHideShowHint = () => {
    const el = document.getElementsByClassName('cell-hint')?.[0];
    const fxHint = document.getElementsByClassName('fx-hint')?.[0];
    const searchElFx = document.getElementsByClassName('fx-search')?.[0];
    const searchElCell = document.getElementsByClassName('cell-search')?.[0];
    if (searchElFx) {
      // @ts-ignore
      searchElFx.style.display = 'block';
    }
    if (searchElCell) {
      // @ts-ignore
      searchElCell.style.display = 'none';
    }
    if (el) {
      // @ts-ignore
      el.style.display = 'none';
    }
    if (fxHint) {
      // @ts-ignore
      fxHint.style.display = 'block';
    }
  };

  const onChange = useCallback(() => {
    if (context.isFlvReadOnly) return;
    const fxEl = refs.fxInput.current;
    if (
      fxEl &&
      context.luckysheetCellUpdate.length === 2 &&
      formulaAnchorCellRef.current == null
    ) {
      const t = fxEl.innerText?.trim() || '';
      if (t.startsWith('=')) {
        formulaAnchorCellRef.current = [
          context.luckysheetCellUpdate[0],
          context.luckysheetCellUpdate[1],
        ];
      }
    }
    handleHideShowHint();
    setShowSearchHint(
      shouldShowFormulaFunctionList(refs.fxInput?.current ?? null),
    );

    const isStrictFormula = isStrictFormulaEditorText(refs.fxInput.current);
    if (!isStrictFormula) {
      setContext(
        (draftCtx) => {
          if (draftCtx.functionCandidates.length > 0) {
            draftCtx.functionCandidates = [];
          }
          if (draftCtx.defaultCandidates.length > 0) {
            draftCtx.defaultCandidates = [];
          }
          if (draftCtx.functionHint) {
            draftCtx.functionHint = '';
          }
        },
        { noHistory: true },
      );
    }

    const currentCommaCount = countCommasBeforeCursor(refs.fxInput?.current!);
    setCommaCount(currentCommaCount);
    const e = lastKeyDownEventRef.current;
    if (!e) {
      const fx = refs.fxInput.current;
      const cell = refs.cellInput.current;
      const isFormula = (el: HTMLDivElement | null) =>
        !!(
          el?.innerText?.trim().startsWith('=') ||
          el?.textContent?.trim().startsWith('=')
        );
      const sel = window.getSelection();
      let editor: HTMLDivElement | null = null;
      if (sel?.rangeCount) {
        const node = sel.getRangeAt(0).startContainer;
        if (fx?.contains(node) && isFormula(fx)) editor = fx;
        else if (cell?.contains(node) && isFormula(cell)) editor = cell;
      }
      if (!editor && isFormula(fx)) editor = fx;
      else if (!editor && isFormula(cell)) editor = cell;
      if (editor) {
        setContext(
          (draftCtx) => {
            if (!isAllowEdit(draftCtx, draftCtx.luckysheet_select_save)) return;
            if (getFormulaEditorOwner(draftCtx) !== 'fx') return;
            if (
              draftCtx.formulaCache.rangestart ||
              draftCtx.formulaCache.rangedrag_column_start ||
              draftCtx.formulaCache.rangedrag_row_start
            ) {
              rangeHightlightselected(draftCtx, editor!);
              return;
            }
            draftCtx.formulaCache.selectingRangeIndex = -1;
            createRangeHightlight(draftCtx, editor!.innerHTML);
            rangeHightlightselected(draftCtx, editor!);
          },
          { noHistory: true },
        );
      }
      return;
    }
    if (isEditorUndoRedoKeyEvent(e)) {
      return;
    }
    const kcode = e.keyCode;
    if (!kcode) return;

    if (
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
      (e.ctrlKey && kcode === 86)
    ) {
      setContext(
        (draftCtx) => {
          handleFormulaInput(
            draftCtx,
            refs.cellInput.current!,
            refs.fxInput.current!,
            kcode,
            recentText.current,
          );
        },
        { noHistory: true },
      );
    }
    requestAnimationFrame(() => {
      if (getFormulaEditorOwner(context) !== 'fx') return;
      appendEditorHistoryFromPrimaryEditor(() =>
        getCursorPosition(refs.fxInput.current!),
      );
    });
  }, [
    appendEditorHistoryFromPrimaryEditor,
    context.isFlvReadOnly,
    context.luckysheetCellUpdate,
    refs.cellInput,
    refs.fxInput,
    setContext,
  ]);

  const refreshFxFormulaRangeHighlights = useCallback(() => {
    const el = refs.fxInput.current;
    if (!el) return;
    setContext(
      (draftCtx) => {
        if (draftCtx.luckysheetCellUpdate.length === 0) return;
        if (getFormulaEditorOwner(draftCtx) !== 'fx') return;
        if (!isAllowEdit(draftCtx, draftCtx.luckysheet_select_save)) return;
        const t = el.innerText?.trim() ?? '';
        if (!t.startsWith('=')) return;
        if (
          draftCtx.formulaCache.rangestart ||
          draftCtx.formulaCache.rangedrag_column_start ||
          draftCtx.formulaCache.rangedrag_row_start
        ) {
          rangeHightlightselected(draftCtx, el);
          return;
        }
        draftCtx.formulaCache.selectingRangeIndex = -1;
        createRangeHightlight(draftCtx, el.innerHTML);
        rangeHightlightselected(draftCtx, el);
      },
      { noHistory: true },
    );
  }, [refs.fxInput, setContext]);

  useRerenderOnFormulaCaret(
    refs.fxInput,
    context.luckysheetCellUpdate.length > 0,
    refreshFxFormulaRangeHighlights,
  );

  // Helper function to extract function name from input text
  const getFunctionNameFromInput = useCallback(() => {
    const inputText = (refs.fxInput?.current?.innerText || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u200b/g, '');
    const formulaText = inputText.trimStart();
    if (!formulaText.startsWith('=')) return null;

    // Try to find function name pattern: =FUNCTIONNAME(
    const functionMatch = formulaText.match(/^=([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (functionMatch) {
      return functionMatch[1].toUpperCase();
    }

    // Also check if there's a function with class luckysheet-formula-text-func in the HTML
    if (refs.fxInput?.current) {
      const funcSpan = refs.fxInput.current.querySelector(
        '.luckysheet-formula-text-func',
      );
      if (funcSpan) {
        return funcSpan.textContent?.toUpperCase() || null;
      }
    }

    return null;
  }, []);

  const functionName =
    getFunctionNameFromFormulaCaretSpans(refs.fxInput.current) ??
    context.functionHint ??
    getFunctionNameFromInput();

  // Get function object using the detected function name
  const fn = functionName
    ? context.formulaCache.functionlistMap[functionName]
    : null;

  const showFxFormulaChrome =
    context.luckysheetCellUpdate.length > 0 &&
    getFormulaEditorOwner(context) === 'fx';

  const allowEdit = useMemo(() => {
    if (context.allowEdit === false) {
      return false;
    }
    if (isHidenRC) {
      return false;
    }
    if (!isAllowEdit(context, context.luckysheet_select_save)) {
      return false;
    }
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    context.config,
    context.luckysheet_select_save,
    context.luckysheetfile,
    context.currentSheetId,
    isHidenRC,
  ]);

  const divRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const startY = e.clientY;
    const startHeight = divRef.current!.offsetHeight;

    const onMouseMove = (ev: MouseEvent) => {
      const newHeight = startHeight + (ev.clientY - startY);
      divRef.current!.style.height = `${Math.max(newHeight, 20)}px`; // min height = 100
    };

    const onMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div>
      <div
        className={
          showFxFormulaChrome
            ? 'fortune-fx-editor fortune-fx-editor--formula-owner'
            : 'fortune-fx-editor'
        }
        ref={divRef}
      >
        <NameBox />
        <div
          className="fortune-fx-icon"
          style={{ cursor: 'pointer' }}
          onClick={() => {
            document.getElementById('function-button')?.click();
          }}
        >
          {/* <SVGIcon name="fx" width={18} height={18} /> */}
          <LucideIcon
            name="DSheetOnlyText"
            fill="hsl(var(--color-text-default))"
            style={{
              width: '14px',
              height: '14px',
              margin: 'auto',
              marginTop: '1px',
            }}
          />
        </div>
        <div ref={inputContainerRef} className="fortune-fx-input-container">
          <ContentEditable
            onMouseDown={() => {
              // Ensure first click both opens edit mode and preserves the mouse caret.
              if (context.luckysheetCellUpdate.length === 0) {
                refs.globalCache.doNotUpdateCell = true;
              }
              setContext((draftCtx) => {
                setFormulaEditorOwner(draftCtx, 'fx');
              });
            }}
            onMouseUp={() => {
              handleHideShowHint();
              setContext((draftCtx) => {
                setFormulaEditorOwner(draftCtx, 'fx');
              });
              const editor = refs.fxInput?.current!;
              setShowSearchHint(shouldShowFormulaFunctionList(editor));
              const currentCommaCount = countCommasBeforeCursor(editor);
              setCommaCount(currentCommaCount);

              setContext((draftCtx) => {
                if (draftCtx.formulaCache.rangeSelectionActive !== true) return;

                const clickedInsideManagedRange =
                  getFormulaRangeIndexAtCaret(editor) !== null;
                const atValidInsertionPoint =
                  isCaretAtValidFormulaRangeInsertionPoint(editor);

                if (clickedInsideManagedRange || !atValidInsertionPoint) {
                  markRangeSelectionDirty(draftCtx);
                  if (editor.innerText?.trim().startsWith('=')) {
                    createRangeHightlight(draftCtx, editor.innerHTML);
                    rangeHightlightselected(draftCtx, editor);
                  }
                }
              });
            }}
            innerRef={(e) => {
              refs.fxInput.current = e;
            }}
            className="fortune-fx-input"
            id="luckysheet-functionbox-cell"
            aria-autocomplete="list"
            onFocus={onFocus}
            onKeyDown={onKeyDown}
            onChange={onChange}
            onContextMenu={(e) => e.stopPropagation()}
            // onBlur={() => setFocused(false)}
            tabIndex={0}
            allowEdit={allowEdit && !context.isFlvReadOnly}
          />
          {!showSearchHint && <CellDatePicker variant="fx" />}
          {(context.functionCandidates.length > 0 ||
            context.functionHint ||
            context.defaultCandidates.length > 0 ||
            fn) &&
            showFxFormulaChrome && (
              <>
                {showSearchHint && (
                  <FormulaSearch
                    // @ts-ignore
                    from="fx"
                    lockedTop={lockedFormulaSearchTop}
                    onTopComputed={handleFormulaSearchTopComputed}
                    onMouseMove={(e) => {
                      if (
                        document.getElementById('luckysheet-formula-search-c')
                      ) {
                        // apply hovered state on the function item
                        const hoveredItem = (e.target as HTMLElement).closest(
                          '.luckysheet-formula-search-item',
                        ) as HTMLElement | null;
                        if (!hoveredItem) return;

                        clearSearchItemActiveClass();
                        hoveredItem.classList.add(
                          'luckysheet-formula-search-item-active',
                        );
                      }
                      e.preventDefault();
                    }}
                    onMouseDown={(e) => {
                      selectActiveFormulaOnClick(e);
                    }}
                  />
                )}

                <div className="fx-hint">
                  {showFormulaHint &&
                    fn &&
                    !showSearchHint &&
                    !isFormulaCompleteAtCaret(refs.fxInput.current) && (
                      <FormulaHint
                        handleShowFormulaHint={handleShowFormulaHint}
                        showFormulaHint={showFormulaHint}
                        commaCount={commaCount}
                        functionName={functionName}
                      />
                    )}
                  {!showFormulaHint && fn && !showSearchHint && (
                    <Tooltip
                      text="Turn on formula suggestions (F10)"
                      position="top"
                      style={{
                        position: 'absolute',
                        top: '-50px',
                        left: '-130px',
                        width: '210px',
                      }}
                    >
                      <div
                        className="luckysheet-hin absolute show-more-btn"
                        onClick={() => {
                          handleShowFormulaHint();
                        }}
                      >
                        <LucideIcon
                          name="DSheetTextDisabled"
                          fill="hsl(var(--color-text-default))"
                          style={{
                            width: '14px',
                            height: '14px',
                            margin: 'auto',
                            marginTop: '1px',
                          }}
                        />
                      </div>
                    </Tooltip>
                  )}
                </div>
              </>
            )}

          {/* {focused && (
          <>
            <FormulaSearch
              style={{
                top: inputContainerRef.current!.clientHeight,
              }}
            />
            <FormulaHint
              style={{
                top: inputContainerRef.current!.clientHeight,
              }}
            />
          </>
        )} */}
        </div>
      </div>
      <div
        className="resize-handle"
        onMouseDown={startResize}
        style={{
          cursor: isResizing ? 'grabbing' : 'ns-resize',
          height: '1px',
        }}
      />
    </div>
  );
};

export default FxEditor;
