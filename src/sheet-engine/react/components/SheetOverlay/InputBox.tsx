/* eslint-disable @typescript-eslint/no-non-null-asserted-optional-chain */
import {
  cancelNormalSelected,
  getCellValue,
  getInlineStringHTML,
  getStyleByCell,
  isInlineStringCell,
  moveToEnd,
  getFlowdata,
  handleFormulaInput,
  moveHighlightCell,
  escapeScriptTag,
  valueShowEs,
  createRangeHightlight,
  isShowHidenCR,
  israngeseleciton,
  escapeHTMLTag,
  isAllowEdit,
  indexToColumnChar,
  functionHTMLGenerate,
  handleBold,
  handleItalic,
  handleUnderline,
  handleStrikeThrough,
  getRangeRectsByCharacterOffset,
  rangeSetValue,
  getFormulaRangeIndexForKeyboardSync,
  getFormulaRangeIndexAtCaret,
  getFormulaEditorOwner,
  createFormulaRangeSelect,
  seletedHighlistByindex,
  isFormulaReferenceInputMode,
  isCaretAtValidFormulaRangeInsertionPoint,
  markRangeSelectionDirty,
  rangeHightlightselected,
  setFormulaEditorOwner,
  ensureFormulaRangeToSheet,
  returnToFormulaOriginSheet,
  getRangetxt,
  normalizeSelection,
  snapSheetSelectionFocusToCellPreserveMultiRange,
  captureLinkEditorOpenSnapshot,
  showLinkCard,
  getHyperlinkAtCaretInContentEditable,
  getUniformLinkFromWindowSelectionInEditor,
  applyLinkToSelection,
  getCellHyperlink,
} from '@sheet-engine/core';
import type { Context, GlobalCache } from '@sheet-engine/core';
import React, {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useLayoutEffect,
  useState,
} from 'react';
import _ from 'lodash';
import { Tooltip } from '@fileverse/ui';
import WorkbookContext from '../../context';
import ContentEditable from './ContentEditable';
import FormulaSearch from './FormulaSearch';
import FormulaHint from './FormulaHint';
import CellDatePicker from './CellDatePicker';
import usePrevious from '../../hooks/usePrevious';
import { useFormulaEditorHistory } from '../../hooks/useFormulaEditorHistory';
import { useRerenderOnFormulaCaret } from '../../hooks/useRerenderOnFormulaCaret';
import { useLastFormulaCaretOffset } from '../../hooks/useLastFormulaCaretOffset';
import {
  moveCursorToEnd,
  getCursorPosition,
  setCursorPosition,
  buildFormulaSuggestionText,
  getFunctionNameFromFormulaCaretSpans,
  isLetterNumberPattern,
  countCommasBeforeCursor,
  shouldShowFormulaFunctionList,
  isStrictFormulaEditorText,
  isFormulaCompleteAtCaret,
  isEditorUndoRedoKeyEvent,
} from './helper';
import { matchUndoRedoShortcut } from '@sheet-engine/core/events/keyboard-shortcut-utils';
import { isFormulaSegmentBoundaryKey } from './formula-segment-boundary';
import { LucideIcon } from './LucideIcon';

/** Extra right padding when content (+ this) is wider than the cell (see .luckysheet-input-box-inner base horizontal padding 2px). */
const CELL_EDIT_INPUT_EXTRA_RIGHT_PX = 10;

function measureCellEditorContentWidth(el: HTMLElement | null): number {
  if (!el) return 0;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const w = range.getBoundingClientRect().width;
    range.detach?.();
    return w;
  } catch {
    return el.scrollWidth;
  }
}

function findLastLinkSpanInEditor(editor: HTMLElement): HTMLElement | null {
  const spans = editor.querySelectorAll('span');
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const el = spans[i] as HTMLElement;
    if (el?.dataset?.linkType && el?.dataset?.linkAddress) return el;
  }
  return null;
}

/** True if a non-linked typing span already sits immediately after this link (avoids duplicate NBSP anchors). */
function hasPlainTypingSpanAfterLink(linkSpan: HTMLElement): boolean {
  const next = linkSpan.nextElementSibling;
  return (
    next instanceof HTMLElement &&
    next.tagName === 'SPAN' &&
    !next.dataset?.linkType &&
    !next.dataset?.linkAddress
  );
}

function ensureTrailingPlainSpanAfterLinkedTail(
  editor: HTMLDivElement | null,
): boolean {
  if (!editor) return false;
  const lastLink = findLastLinkSpanInEditor(editor);
  if (!lastLink) return false;
  if (hasPlainTypingSpanAfterLink(lastLink)) return false;
  const anchor = document.createElement('span');
  anchor.className = 'luckysheet-input-span';
  anchor.setAttribute('data-no-link-anchor', '1');
  anchor.textContent = '\u00A0';
  lastLink.insertAdjacentElement('afterend', anchor);
  return true;
}

function moveCaretToTrailingPlainSpan(editor: HTMLDivElement | null): boolean {
  if (!editor) return false;
  const lastLink = findLastLinkSpanInEditor(editor);
  if (!lastLink) return false;
  const next = lastLink.nextElementSibling;
  if (
    !(next instanceof HTMLElement) ||
    next.tagName !== 'SPAN' ||
    next.dataset?.linkType ||
    next.dataset?.linkAddress
  ) {
    return false;
  }
  let textNode = next.firstChild as Text | null;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    textNode = document.createTextNode('\u00A0');
    next.textContent = '';
    next.appendChild(textNode);
  }
  const sel = window.getSelection();
  if (!sel) return false;
  const range = document.createRange();
  range.setStart(textNode, textNode.textContent?.length || 0);
  range.collapse(true);
  editor.focus({ preventScroll: true });
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

function buildSingleLinkEditorHtml(
  text: string,
  link: { linkType: string; linkAddress: string },
): string {
  const escaped = escapeHTMLTag(escapeScriptTag(text))
    .replace(/\r\n/g, '<br>')
    .replace(/\r/g, '<br>')
    .replace(/\n/g, '<br>');
  const safeType = String(link.linkType).replace(/"/g, '&quot;');
  const safeAddress = String(link.linkAddress).replace(/"/g, '&quot;');
  return `<span class="luckysheet-input-span" style="color: rgb(0, 0, 255); border-bottom: 1px solid rgb(0, 0, 255);" data-link-type="${safeType}" data-link-address="${safeAddress}">${escaped}</span>`;
}

function getCaretCharacterOffsetInEditor(
  element: HTMLDivElement,
): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const focusNode = sel.focusNode;
  if (!focusNode || !element.contains(focusNode)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(element);
  pre.setEnd(focusNode, sel.focusOffset);
  return pre.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n').length;
}

function setSelectionByCharacterOffsetInEditor(
  element: HTMLDivElement,
  start: number,
  end: number,
): boolean {
  const normalizeForSelection = (s: string) =>
    s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const normInner = normalizeForSelection(
    element.innerText ?? element.textContent ?? '',
  );
  // Whole-cell selection from toolbar / Cmd+K: DOM may use <br> for line breaks;
  // walking only text nodes under-counts. selectNodeContents matches innerText.
  if (
    start === 0 &&
    end === normInner.length &&
    normInner.length > 0 &&
    element.childNodes.length > 0
  ) {
    const sel = window.getSelection();
    if (!sel) return false;
    const r = document.createRange();
    r.selectNodeContents(element);
    element.focus({ preventScroll: true });
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  }
  const rawOffsetFromNormalized = (raw: string, normalizedOffset: number) => {
    if (normalizedOffset <= 0) return 0;
    let rawIdx = 0;
    let normIdx = 0;
    while (rawIdx < raw.length && normIdx < normalizedOffset) {
      const ch = raw[rawIdx];
      if (ch === '\r') {
        if (rawIdx + 1 < raw.length && raw[rawIdx + 1] === '\n') {
          rawIdx += 2;
        } else {
          rawIdx += 1;
        }
        normIdx += 1;
        continue;
      }
      rawIdx += 1;
      normIdx += 1;
    }
    return rawIdx;
  };
  const sel = window.getSelection();
  if (!sel) return false;
  let charIndex = 0;
  let startNode: Node | null = null;
  let startOffset = 0;
  let endNode: Node | null = null;
  let endOffset = 0;

  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const rawText = node.textContent || '';
      const normalizedText = normalizeForSelection(rawText);
      const len = normalizedText.length;
      if (startNode == null && charIndex + len > start) {
        startNode = node;
        startOffset = rawOffsetFromNormalized(rawText, start - charIndex);
      }
      if (endNode == null && charIndex + len >= end) {
        endNode = node;
        endOffset = rawOffsetFromNormalized(rawText, end - charIndex);
        return true;
      }
      charIndex += len;
      return false;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.tagName === 'BR') {
        const brLen = 1;
        const parent = el.parentNode;
        if (parent) {
          const idx = Array.prototype.indexOf.call(parent.childNodes, el);
          if (startNode == null && charIndex + brLen > start) {
            startNode = parent;
            startOffset = start <= charIndex ? idx : idx + 1;
          }
          if (endNode == null && charIndex + brLen >= end) {
            endNode = parent;
            endOffset = end <= charIndex ? idx : idx + 1;
            charIndex += brLen;
            return true;
          }
        }
        charIndex += brLen;
        return false;
      }
    }
    const children = node.childNodes;
    for (let i = 0; i < children.length; i += 1) {
      if (walk(children[i])) return true;
    }
    return false;
  };

  walk(element);
  // End-boundary caret case: offsets can point to text end where `walk` never
  // enters `charIndex + len > start` branch. Fall back to editor end.
  if (!startNode) {
    startNode = element;
    startOffset = element.childNodes.length;
  }
  if (!endNode) {
    endNode = element;
    endOffset = element.childNodes.length;
  }
  const r = document.createRange();
  r.setStart(startNode, Math.max(0, startOffset));
  r.setEnd(endNode, Math.max(0, endOffset));
  element.focus({ preventScroll: true });
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
}

type EditSelectionLike = {
  row?: number[];
  column?: number[];
  row_focus?: number;
  column_focus?: number;
  width?: number;
  height?: number;
};

function focusColWidthFromVisible(
  visibledatacolumn: number[],
  focusCol: number,
): number {
  const col_f = visibledatacolumn[focusCol];
  const col_pre = focusCol <= 0 ? 0 : visibledatacolumn[focusCol - 1];
  if (col_f == null) return 0;
  return Math.max(0, col_f - col_pre - 1);
}

function focusColWidthFromLiveRight(
  visibledatacolumn: number[],
  focusCol: number,
  liveRightPx: number,
): number {
  const col_pre = focusCol <= 0 ? 0 : visibledatacolumn[focusCol - 1];
  return Math.max(0, liveRightPx - col_pre - 1);
}

function focusRowHeightFromLiveBottom(
  visibledatarow: number[],
  focusRow: number,
  liveBottomPx: number,
): number {
  const row_pre = focusRow <= 0 ? 0 : visibledatarow[focusRow - 1];
  return Math.max(0, liveBottomPx - row_pre - 1);
}

/** Width/height for the in-cell editor; tracks layout and live column resize without cloning selection. */
function useEditCellBoxDimensions(
  context: Context,
  firstSelection: EditSelectionLike | undefined,
  globalCache: GlobalCache,
): { width: number; height: number } | null {
  const editing = (context.luckysheetCellUpdate?.length ?? 0) > 0;
  const focusCol = firstSelection?.column_focus ?? firstSelection?.column?.[0];
  const focusRow = firstSelection?.row_focus ?? firstSelection?.row?.[0];

  const layoutWidth = useMemo(() => {
    if (!editing || typeof focusCol !== 'number') return null;
    return focusColWidthFromVisible(context.visibledatacolumn, focusCol);
  }, [editing, focusCol, context.visibledatacolumn]);

  const layoutHeight = useMemo(() => {
    if (!editing || typeof focusRow !== 'number') return null;
    const row_f = context.visibledatarow[focusRow];
    const row_pre = focusRow <= 0 ? 0 : context.visibledatarow[focusRow - 1];
    if (row_f == null) return firstSelection?.height ?? 0;
    return Math.max(0, row_f - row_pre - 1);
  }, [editing, focusRow, context.visibledatarow, firstSelection?.height]);

  const resizingCol = context.luckysheet_cols_change_size_start?.[1];
  const colResizeActive =
    editing &&
    !!context.luckysheet_cols_change_size &&
    typeof resizingCol === 'number' &&
    typeof focusCol === 'number' &&
    resizingCol === focusCol;

  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const visColsRef = useRef(context.visibledatacolumn);
  visColsRef.current = context.visibledatacolumn;

  useEffect(() => {
    if (!colResizeActive) {
      setLiveWidth(null);
      return;
    }
    let raf = 0;
    let last = -1;
    const tick = () => {
      const liveRight = globalCache.colResizeLiveRightPx;
      if (typeof liveRight === 'number' && typeof focusCol === 'number') {
        const w = focusColWidthFromLiveRight(
          visColsRef.current,
          focusCol,
          liveRight,
        );
        if (w !== last) {
          last = w;
          setLiveWidth(w);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setLiveWidth(null);
    };
  }, [colResizeActive, focusCol, globalCache]);

  const resizingRow = context.luckysheet_rows_change_size_start?.[1];
  const rowResizeActive =
    editing &&
    !!context.luckysheet_rows_change_size &&
    typeof resizingRow === 'number' &&
    typeof focusRow === 'number' &&
    resizingRow === focusRow;

  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const visRowsRef = useRef(context.visibledatarow);
  visRowsRef.current = context.visibledatarow;

  useEffect(() => {
    if (!rowResizeActive) {
      setLiveHeight(null);
      return;
    }
    let raf = 0;
    let last = -1;
    const tick = () => {
      const liveBottom = globalCache.rowResizeLiveBottomPx;
      if (typeof liveBottom === 'number' && typeof focusRow === 'number') {
        const h = focusRowHeightFromLiveBottom(
          visRowsRef.current,
          focusRow,
          liveBottom,
        );
        if (h !== last) {
          last = h;
          setLiveHeight(h);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setLiveHeight(null);
    };
  }, [rowResizeActive, focusRow, globalCache]);

  return useMemo(() => {
    if (!editing || !firstSelection) return null;
    const width =
      colResizeActive && liveWidth != null
        ? liveWidth
        : (layoutWidth ?? firstSelection.width ?? 0);
    const height =
      rowResizeActive && liveHeight != null
        ? liveHeight
        : (layoutHeight ?? firstSelection.height ?? 0);
    return { width, height };
  }, [
    editing,
    firstSelection,
    colResizeActive,
    liveWidth,
    layoutWidth,
    rowResizeActive,
    liveHeight,
    layoutHeight,
  ]);
}

const InputBox: React.FC = () => {
  const { context, setContext, refs } = useContext(WorkbookContext);
  const inputRef = useRef<HTMLDivElement | null>(null);
  const lastKeyDownEventRef = useRef<KeyboardEvent | null>(null);
  const prevCellUpdate = usePrevious<any[]>(context.luckysheetCellUpdate);
  const prevSheetId = usePrevious<string>(context.currentSheetId);
  const [isHidenRC, setIsHidenRC] = useState<boolean>(false);
  const [isInputBoxActive, setIsInputBoxActive] = useState(false);
  const [activeCell, setActiveCell] = useState<string>('');
  const [activeRefCell, setActiveRefCell] = useState<string>('');
  /** Shown only after the sheet scrolls during this edit; hidden again when edit ends. */
  const [showAddressIndicator, setShowAddressIndicator] = useState(false);
  const scrollAtEditSessionStartRef = useRef<{
    left: number;
    top: number;
  } | null>(null);
  const [frozenPosition, setFrozenPosition] = useState({ left: 0, top: 0 });
  const firstSelection = context.luckysheet_select_save?.[0];
  const [firstSelectionActiveCell, setFirstSelectionActiveCell] = useState<any>(
    {},
  );
  const [commaCount, setCommaCount] = useState(0);
  /** When true, in-cell editor shows left alignment for formulas (=...) even if the cell style is center/right. */
  const [cellEditorIsFormula, setCellEditorIsFormula] = useState(false);
  const hideFormulaHintLocal = localStorage.getItem('formulaMore') === 'true';
  const [showFormulaHint, setShowFormulaHint] = useState(!hideFormulaHintLocal);
  const [showSearchHint, setShowSearchHint] = useState(false);
  const formulaSearchTopLockRef = useRef<{
    cellKey: string;
    top: number;
  } | null>(null);
  /** Bumped on editor input so layout can re-check content vs cell width. */
  const [editorLayoutTick, setEditorLayoutTick] = useState(0);
  /** When true, add CELL_EDIT_INPUT_EXTRA_RIGHT_PX to the right padding (only if content+extra exceeds cell width). */
  const [cellEditorExtendRight, setCellEditorExtendRight] = useState(false);
  const row_index = firstSelection?.row_focus!;
  const col_index = firstSelection?.column_focus!;
  const editCellBoxSize = useEditCellBoxDimensions(
    context,
    firstSelection,
    refs.globalCache,
  );
  const formulaSearchActiveCellKey =
    !_.isEmpty(context.luckysheetCellUpdate) &&
    context.luckysheetCellUpdate.length === 2
      ? `${
          context.formulaCache.rangetosheet || context.currentSheetId
        }:${context.luckysheetCellUpdate[0]}:${context.luckysheetCellUpdate[1]}`
      : null;
  const lockedFormulaSearchTop =
    formulaSearchActiveCellKey &&
    formulaSearchTopLockRef.current?.cellKey === formulaSearchActiveCellKey
      ? formulaSearchTopLockRef.current.top
      : null;
  const isComposingRef = useRef(false);
  const formulaAnchorCellRef = useRef<[number, number] | null>(null);
  const suppressAnchorSelectionSyncRef = useRef<[number, number] | null>(null);
  const {
    preTextRef,
    resetFormulaHistory,
    handleFormulaHistoryUndoRedo,
    capturePreEditorHistoryState,
    appendEditorHistoryFromPrimaryEditor,
  } = useFormulaEditorHistory(
    inputRef,
    refs.cellInput,
    refs.fxInput,
    setContext,
    'cell',
  );

  const ZWSP = '\u200B';
  const inputBoxInnerRef = useRef<HTMLDivElement>(null);
  const lastAppliedLinkSelectionKeyRef = useRef<string | null>(null);
  const autoLinkUrlsInEditorRef = useRef<
    (
      mode?: 'space' | 'commit',
      options?: { preserveCaret?: boolean; deferCaretRestore?: boolean },
    ) => void
  >(() => {});
  const [linkSelectionHighlightRects, setLinkSelectionHighlightRects] =
    useState<{ left: number; top: number; width: number; height: number }[]>(
      [],
    );
  const normalizeFormulaGateText = useCallback(
    (s: string) => s.replace(/\u00a0/g, ' ').replace(/\u200b/g, ''),
    [],
  );
  const startsWithFormula = useCallback(
    (s: string) => normalizeFormulaGateText(s).trimStart().startsWith('='),
    [normalizeFormulaGateText],
  );

  const ensureNotEmpty = () => {
    const el = inputRef.current;
    if (!el) return;

    const text = el.textContent;

    // Treat empty OR only-ZWSP as empty
    if (!text || text === ZWSP) {
      el.innerHTML = ZWSP;
      moveCursorToEnd(el);
    }
  };

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
      const prev = formulaSearchTopLockRef.current;
      if (
        prev?.cellKey === formulaSearchActiveCellKey &&
        Math.abs(prev.top - computedTop) < 1
      ) {
        return;
      }
      formulaSearchTopLockRef.current = {
        cellKey: formulaSearchActiveCellKey,
        top: computedTop,
      };
    },
    [formulaSearchActiveCellKey],
  );

  const getLastInputSpanText = () => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(
      `<div>${inputRef?.current?.innerHTML}</div>`,
      'text/html',
    );
    const spans = doc.querySelectorAll('span');
    const lastSpan = spans[spans.length - 1];
    return lastSpan?.innerText;
  };

  const inputBoxStyle = useMemo(() => {
    if (firstSelectionActiveCell && context.luckysheetCellUpdate.length > 0) {
      const flowdata = getFlowdata(context);
      if (!flowdata) return {};
      let style = getStyleByCell(
        context,
        flowdata,
        firstSelectionActiveCell.row_focus!,
        firstSelectionActiveCell.column_focus!,
      );
      const activeCell =
        flowdata?.[firstSelectionActiveCell.row_focus!]?.[
          firstSelectionActiveCell.column_focus!
        ];
      // Hyperlink cells can carry blue/underline as cell-level style (especially after import).
      // In edit mode that decorates the entire input box; keep decoration on link spans only.
      const activeHyperlink = getCellHyperlink(
        context,
        firstSelectionActiveCell.row_focus!,
        firstSelectionActiveCell.column_focus!,
      );
      if (activeHyperlink?.linkAddress) {
        style = {
          ...style,
          color: undefined,
          borderBottom: undefined,
          textDecoration: undefined,
        };
      }
      // Date cells are right-aligned by default in grid rendering. In edit mode,
      // ensure we keep that alignment when no explicit alignment style exists.
      if (
        activeCell?.ct?.t === 'd' &&
        (style as any)?.textAlign == null &&
        !cellEditorIsFormula
      ) {
        style = { ...style, textAlign: 'right' };
      }
      if (cellEditorIsFormula) {
        style = { ...style, textAlign: 'left' };
      }
      return style;
    }
    return {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    context.luckysheetfile,
    context.currentSheetId,
    context.luckysheetCellUpdate,
    context?.luckysheetCellUpdate?.length,
    firstSelectionActiveCell,
    cellEditorIsFormula,
  ]);

  useLayoutEffect(() => {
    if (!context.allowEdit) {
      setContext((ctx) => {
        const flowdata = getFlowdata(ctx);
        if (!_.isNil(flowdata) && ctx.forceFormulaRef) {
          const value = getCellValue(row_index, col_index, flowdata, 'f');
          createRangeHightlight(ctx, value);
        }
      });
    }
    if (firstSelection && context.luckysheetCellUpdate.length > 0) {
      if (refs.globalCache.doNotUpdateCell) {
        return;
      }
      // Same cell as last applied layout pass: never re-hydrate from sheet or move
      // the caret (avoids jump-to-end on every luckysheetfile/selection-driven rerun).
      if (
        _.isEqual(prevCellUpdate, context.luckysheetCellUpdate) &&
        prevSheetId === context.currentSheetId
      ) {
        return;
      }

      // Cross-sheet formula pick: keep the in-progress editor DOM when the sheet
      // changes; never re-hydrate from the foreign (or restored origin) sheet cell.
      if (
        prevSheetId !== context.currentSheetId &&
        context.luckysheetCellUpdate.length > 0
      ) {
        return;
      }

      const [ur, uc] = context.luckysheetCellUpdate;
      const pending = refs.globalCache.pendingTypeOverCell;
      // One-shot: skip hydrating from stored cell only for the first layout after
      // type-to-edit opened the editor; clear pending so later effect runs exit above.
      if (pending && pending[0] === ur && pending[1] === uc) {
        refs.globalCache.overwriteCell = false;
        if (inputRef.current) {
          setCellEditorIsFormula(
            inputRef.current.innerText.trim().startsWith('='),
          );
        }
        // Do not move the caret here. Type-to-edit already ran handleFormulaInput in
        // keyboard.ts (caret + first character). moveToEnd on every layout rerun was
        // jumping the caret to the end when editing mid-formula after luckysheetfile
        // or selection updates.
        delete refs.globalCache.doNotFocus;
        // Do not clear pendingTypeOverCell here: React 18 Strict Mode runs this layout
        // effect twice; clearing early lets the second pass hydrate from the sheet and
        // wipe the keystroke from keyboard.ts. Cleared in useEffect after commit.
        return;
      }
      const flowdata = getFlowdata(context);
      const cell = flowdata?.[row_index]?.[col_index];
      // `ct.s` is persisted multiline text for storage/export; editor chrome uses
      // `_formulaEditHtml` (span classes) or canonical `f` + escape + range highlight.
      const formulaEditHtml =
        cell?.f && typeof cell?._formulaEditHtml === 'string'
          ? cell._formulaEditHtml
          : '';
      const mirrorSegV = cell?.ct?.s?.[0]?.v;
      const ctMirrorMultiline =
        !!cell?.f &&
        typeof mirrorSegV === 'string' &&
        /[\r\n]/.test(mirrorSegV);
      const formulaEditHtmlMissingBr =
        typeof formulaEditHtml === 'string' &&
        formulaEditHtml.length > 0 &&
        !/<br\s*\/?>/i.test(formulaEditHtml);
      const preferFormulaHtmlFromMirror =
        ctMirrorMultiline && formulaEditHtmlMissingBr;
      const inlineCellHasLinkRuns =
        cell?.ct?.t === 'inlineStr' &&
        Array.isArray(cell.ct.s) &&
        cell.ct.s.some(
          (seg: any) => !!seg?.link?.linkType && !!seg?.link?.linkAddress,
        );
      const cellHyperlink = getCellHyperlink(context, row_index, col_index);
      const overwrite = refs.globalCache.overwriteCell;
      let value = '';
      if (cell && !overwrite) {
        if (isInlineStringCell(cell)) {
          value = getInlineStringHTML(row_index, col_index, flowdata);
        } else if (cell.f) {
          value = getCellValue(row_index, col_index, flowdata!, 'f');
          setContext((ctx) => {
            createRangeHightlight(ctx, value);
          });
        } else if (cell.ct?.t === 'd') {
          value = getCellValue(row_index, col_index, flowdata, 'f');
        } else {
          value = valueShowEs(row_index, col_index, flowdata);
          if (Number(cell.qp) === 1) {
            value = value ? `${value}` : value;
          }
        }
      }
      refs.globalCache.overwriteCell = false;
      let wroteEditorFromStoredCell = false;
      let wroteSingleHydratedLinkSpan = false;
      if (
        !refs.globalCache.ignoreWriteCell &&
        inputRef.current &&
        formulaEditHtml &&
        !preferFormulaHtmlFromMirror
      ) {
        inputRef.current.innerHTML = formulaEditHtml;
        wroteEditorFromStoredCell = true;
      } else if (
        !refs.globalCache.ignoreWriteCell &&
        inputRef.current &&
        value
      ) {
        if (
          cellHyperlink?.linkType &&
          cellHyperlink?.linkAddress &&
          !isInlineStringCell(cell as any) &&
          !inlineCellHasLinkRuns &&
          String(value).trim().length > 0
        ) {
          inputRef.current!.innerHTML = buildSingleLinkEditorHtml(
            String(value),
            cellHyperlink,
          );
          wroteSingleHydratedLinkSpan = true;
        } else {
          inputRef.current!.innerHTML = escapeHTMLTag(escapeScriptTag(value));
        }
        wroteEditorFromStoredCell = true;
      } else if (
        !refs.globalCache.ignoreWriteCell &&
        inputRef.current &&
        !value &&
        !overwrite
      ) {
        // @ts-ignore
        const valueD = getCellValue(row_index, col_index, flowdata!, 'f');
        inputRef.current.innerText = valueD;
        wroteEditorFromStoredCell = true;
      }
      refs.globalCache.ignoreWriteCell = false;
      if (
        (isInlineStringCell(cell as any) && inlineCellHasLinkRuns) ||
        wroteSingleHydratedLinkSpan
      ) {
        ensureTrailingPlainSpanAfterLinkedTail(inputRef.current);
      }
      if (inputRef.current) {
        setCellEditorIsFormula(
          inputRef.current.innerText.trim().startsWith('='),
        );
      }
      if (wroteEditorFromStoredCell && !refs.globalCache.doNotFocus) {
        setTimeout(() => {
          if (
            (wroteSingleHydratedLinkSpan || inlineCellHasLinkRuns) &&
            moveCaretToTrailingPlainSpan(inputRef.current)
          ) {
            return;
          }
          moveToEnd(inputRef.current!);
        });
      }
      delete refs.globalCache.doNotFocus;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    context.luckysheetCellUpdate,
    context.luckysheetfile,
    context.currentSheetId,
    firstSelection,
  ]);

  useEffect(() => {
    if (_.isEmpty(context.luckysheetCellUpdate)) {
      if (inputRef.current) {
        inputRef.current.innerHTML = '';
      }
      lastKeyDownEventRef.current = null;
      delete refs.globalCache.pendingTypeOverCell;
      delete refs.globalCache.linkEditorOpenSnapshot;
      setCellEditorIsFormula(false);
      resetFormulaHistory();
    }
  }, [context.luckysheetCellUpdate, resetFormulaHistory, refs.globalCache]);

  useEffect(() => {
    delete refs.globalCache.doNotUpdateCell;
  }, [context.luckysheetCellUpdate, refs.globalCache]);

  // Keep link insert offsets accurate when toolbar/modals steal focus: refresh snapshot on caret moves.
  const contextRefForLinkSnapshot = useRef(context);
  contextRefForLinkSnapshot.current = context;
  const lastCaretViewLinkKeyRef = useRef<string | null>(null);
  const caretLinkCardRafRef = useRef<number>(0);
  useEffect(() => {
    if (_.isEmpty(context.luckysheetCellUpdate) || !refs.cellInput.current) {
      return;
    }
    lastCaretViewLinkKeyRef.current = null;
    const el = refs.cellInput.current;
    const flushCaretViewLinkCard = () => {
      caretLinkCardRafRef.current = 0;
      const ctx = contextRefForLinkSnapshot.current;
      const editor = refs.cellInput.current;
      if (!editor || _.isEmpty(ctx.luckysheetCellUpdate)) return;
      const [r, c] = ctx.luckysheetCellUpdate;
      const text = editor.innerText ?? '';
      if (text.trimStart().startsWith('=')) {
        lastCaretViewLinkKeyRef.current = null;
        setContext((draftCtx) => {
          if (draftCtx.linkCard?.isEditing) return;
          if (
            draftCtx.linkCard &&
            draftCtx.linkCard.r === r &&
            draftCtx.linkCard.c === c
          ) {
            draftCtx.linkCard = undefined;
          }
        });
        return;
      }
      const sel = window.getSelection();
      if (!sel?.focusNode || !editor.contains(sel.focusNode)) {
        lastCaretViewLinkKeyRef.current = null;
        setContext((draftCtx) => {
          if (draftCtx.linkCard?.isEditing) return;
          if (
            draftCtx.linkCard &&
            draftCtx.linkCard.r === r &&
            draftCtx.linkCard.c === c
          ) {
            draftCtx.linkCard = undefined;
          }
        });
        return;
      }
      if (ctx.linkCard?.isEditing) return;
      const caretLink = getHyperlinkAtCaretInContentEditable(editor);
      const key = caretLink
        ? `${caretLink.linkType}\u0001${caretLink.linkAddress}`
        : '';
      if (key === lastCaretViewLinkKeyRef.current) return;
      lastCaretViewLinkKeyRef.current = key;
      setContext((draftCtx) => {
        if (draftCtx.linkCard?.isEditing) return;
        if (caretLink) {
          showLinkCard(
            draftCtx,
            r,
            c,
            { caretViewLink: caretLink },
            false,
            false,
          );
        } else if (
          draftCtx.linkCard &&
          draftCtx.linkCard.r === r &&
          draftCtx.linkCard.c === c
        ) {
          draftCtx.linkCard = undefined;
        }
      });
    };
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (sel?.focusNode && el.contains(sel.focusNode)) {
        captureLinkEditorOpenSnapshot(
          contextRefForLinkSnapshot.current,
          el,
          refs.globalCache,
        );
      }
      if (caretLinkCardRafRef.current) {
        cancelAnimationFrame(caretLinkCardRafRef.current);
      }
      caretLinkCardRafRef.current = requestAnimationFrame(
        flushCaretViewLinkCard,
      );
    };
    document.addEventListener('selectionchange', onSelectionChange);
    onSelectionChange();
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      if (caretLinkCardRafRef.current) {
        cancelAnimationFrame(caretLinkCardRafRef.current);
        caretLinkCardRafRef.current = 0;
      }
    };
  }, [
    context.luckysheetCellUpdate,
    refs.cellInput,
    refs.globalCache,
    setContext,
  ]);

  // Clear type-to-edit flag after all useLayoutEffect runs in this commit (including
  // React Strict Mode's second layout pass). Clearing inside layout let the second
  // pass re-hydrate from the sheet and wipe the first keystroke.
  useEffect(() => {
    if (_.isEmpty(context.luckysheetCellUpdate)) return;
    delete refs.globalCache.pendingTypeOverCell;
  }, [context.luckysheetCellUpdate, refs.globalCache]);

  // Reset cached formula anchor when formula edit session ends.
  useEffect(() => {
    if (_.isEmpty(context.luckysheetCellUpdate) || !refs.cellInput.current) {
      formulaAnchorCellRef.current = null;
      suppressAnchorSelectionSyncRef.current = null;
      return;
    }

    const inputText = refs.cellInput.current.innerText ?? '';
    if (!startsWithFormula(inputText)) {
      formulaAnchorCellRef.current = null;
      suppressAnchorSelectionSyncRef.current = null;
    }
  }, [context.luckysheetCellUpdate, refs.cellInput, startsWithFormula]);

  // Clear stale formula range visuals/state when editing target cell changes.
  // This prevents previous formula range highlights from leaking into a new
  // input session on a different cell.
  useEffect(() => {
    if (
      _.isEmpty(context.luckysheetCellUpdate) ||
      _.isEmpty(prevCellUpdate) ||
      _.isEqual(prevCellUpdate, context.luckysheetCellUpdate)
    ) {
      return;
    }

    setContext((ctx) => {
      ctx.formulaRangeHighlight = [];
      ctx.formulaRangeSelect = undefined;
      ctx.formulaCache.selectingRangeIndex = -1;
      ctx.formulaCache.func_selectedrange = undefined;
      ctx.formulaCache.rangestart = false;
      ctx.formulaCache.rangedrag_column_start = false;
      ctx.formulaCache.rangedrag_row_start = false;
      ctx.formulaCache.rangechangeindex = undefined;
    });
  }, [context.luckysheetCellUpdate, prevCellUpdate, setContext]);

  // 当选中行列是处于隐藏状态的话则不允许编辑
  useEffect(() => {
    setIsHidenRC(isShowHidenCR(context));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.luckysheet_select_save]);

  // Reset active state when edit ends or a blocking dialog opens.
  // Do not tear down an in-progress formula session just because the foreign
  // sheet has no selection yet after a tab switch.
  useEffect(() => {
    if (
      context.rangeDialog?.show ||
      _.isEmpty(context.luckysheetCellUpdate)
    ) {
      setIsInputBoxActive(false);
    }
  }, [context.rangeDialog?.show, context.luckysheetCellUpdate]);

  const lastCellCaretOffsetRef = useLastFormulaCaretOffset(
    refs.cellInput,
    context.luckysheetCellUpdate.length > 0,
  );

  // After keeping formula edit open across a sheet switch, restore focus/caret so
  // bare `=` keyboard ref picking continues (tabs steal focus from contenteditable).
  useEffect(() => {
    if (!context.formulaCache.refocusFormulaEditorAfterSheetSwitch) return;
    if (context.luckysheetCellUpdate.length === 0) return;
    if (getFormulaEditorOwner(context) === 'fx') return;

    const editor = refs.cellInput.current;
    if (!editor) return;

    setContext((ctx) => {
      ctx.formulaCache.refocusFormulaEditorAfterSheetSwitch = false;
    });

    requestAnimationFrame(() => {
      editor.focus({ preventScroll: true });
      // Put the caret back where the user left it (e.g. after the `,` in
      // `=SUM('Sheet - 2'!B2,`). Only fall back to "after the first ref" when
      // we never saw a caret in the editor.
      const savedOffset = lastCellCaretOffsetRef.current;
      if (savedOffset != null) {
        setCursorPosition(
          editor,
          Math.min(savedOffset, editor.textContent?.length ?? 0),
        );
        return;
      }
      const managed = editor.querySelector(
        'span.fortune-formula-functionrange-cell',
      ) as HTMLElement | null;
      if (managed) {
        const sel = window.getSelection();
        const textNode =
          managed.firstChild && managed.firstChild.nodeType === Node.TEXT_NODE
            ? managed.firstChild
            : null;
        if (sel && textNode) {
          const range = document.createRange();
          range.setStart(
            textNode,
            textNode.textContent?.length ?? 0,
          );
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
      }
      moveCursorToEnd(editor);
    });
  }, [
    context.formulaCache.refocusFormulaEditorAfterSheetSwitch,
    context.currentSheetId,
    context.luckysheetCellUpdate.length,
    context,
    refs.cellInput,
    setContext,
    lastCellCaretOffsetRef,
  ]);

  // Cleanup: if input box is no longer active, remove any lingering
  // blue dotted formula-range overlays from the canvas.
  useEffect(() => {
    if (isInputBoxActive) return;
    setContext((ctx) => {
      if (
        _.isEmpty(ctx.formulaRangeHighlight) &&
        !ctx.formulaRangeSelect &&
        ctx.formulaCache.selectingRangeIndex === -1 &&
        !ctx.formulaCache.func_selectedrange
      ) {
        return;
      }
      ctx.formulaRangeHighlight = [];
      ctx.formulaRangeSelect = undefined;
      ctx.formulaCache.selectingRangeIndex = -1;
      ctx.formulaCache.func_selectedrange = undefined;
      ctx.formulaCache.rangestart = false;
      ctx.formulaCache.rangedrag_column_start = false;
      ctx.formulaCache.rangedrag_row_start = false;
      ctx.formulaCache.rangechangeindex = undefined;
      ctx.formulaCache.rangeSelectionActive = null;
      ctx.formulaCache.formulaKeyboardRefSync = false;
    });
  }, [isInputBoxActive, setContext]);

  const getActiveFormula = useCallback(
    () => document.querySelector('.luckysheet-formula-search-item-active'),
    [],
  );

  const insertSelectedFormula = useCallback(
    (formulaName: string) => {
      const textEditor = inputRef.current;
      if (!textEditor) return;

      const fxEditor = document.getElementById(
        'luckysheet-functionbox-cell',
      ) as HTMLDivElement | null;
      const { text, caretOffset } = buildFormulaSuggestionText(
        textEditor,
        formulaName,
      );
      const safeText = escapeScriptTag(text);
      const normalizedSafeText = normalizeFormulaGateText(safeText);
      const html = startsWithFormula(normalizedSafeText)
        ? functionHTMLGenerate(normalizedSafeText)
        : escapeHTMLTag(normalizedSafeText);

      textEditor.innerHTML = html;
      if (fxEditor) {
        fxEditor.innerHTML = html;
      }
      setCursorPosition(textEditor, caretOffset);

      // Programmatic innerHTML does not fire contenteditable `input`; sync list
      // visibility so FormulaHint is not stuck hidden behind stale `showSearchHint`.
      setShowSearchHint(shouldShowFormulaFunctionList(textEditor));

      // Clear formula UI state
      setContext((draftCtx) => {
        draftCtx.functionCandidates = [];
        draftCtx.defaultCandidates = [];
        draftCtx.functionHint = (formulaName || '').toUpperCase();
      });
    },
    [normalizeFormulaGateText, setContext, startsWithFormula],
  );

  const clearSearchItemActiveClass = useCallback(() => {
    const activeFormula = getActiveFormula();
    if (activeFormula) {
      activeFormula.classList.remove('luckysheet-formula-search-item-active');
    }
  }, [getActiveFormula]);

  const selectActiveFormula = useCallback(
    (e: React.KeyboardEvent) => {
      const formulaName = getActiveFormula()?.querySelector(
        '.luckysheet-formula-search-func',
      )?.textContent;

      const lastSpanText = getLastInputSpanText();

      if (formulaName && !isLetterNumberPattern(lastSpanText)) {
        insertSelectedFormula(formulaName);
        // User selects datablock
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [getActiveFormula, insertSelectedFormula],
  );

  const selectActiveFormulaOnClick = useCallback(
    (e: React.MouseEvent) => {
      if (isComposingRef.current || !inputRef.current) return;
      // @ts-expect-error later
      if (e.target.className.includes('sign-fortune')) return;
      preTextRef.current = inputRef.current!.innerText;
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

  const stopPropagation = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
  };

  /** Re-run formula reference sync when only `func_selectedrange` moves (keyboard formula nav). */
  const formulaFuncRangeSyncSig = useMemo(() => {
    const r = context.formulaCache.func_selectedrange;
    const kb = context.formulaCache.formulaKeyboardRefSync === true;
    if (!r) return kb ? 'kb' : '';
    return [
      kb ? '1' : '0',
      r.row?.[0],
      r.row?.[1],
      r.column?.[0],
      r.column?.[1],
      r.left_move,
      r.top_move,
    ].join(':');
  }, [
    context.formulaCache.func_selectedrange,
    context.formulaCache.formulaKeyboardRefSync,
  ]);

  useEffect(() => {
    const cellInputEl = refs.cellInput.current;
    if (!context.luckysheet_select_save?.[0] || !cellInputEl) return;
    setContext((ctx) => {
      const currentSelection =
        ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
      if (!currentSelection) return;

      // When the Fx editor owns the active formula session, core mouse handling
      // already updates both editors. Running InputBox sync here would insert the
      // same reference a second time (e.g. `=A1A1`).
      if (getFormulaEditorOwner(ctx) === 'fx') {
        return;
      }

      // Formula mouse drag updates the formula via `rangeSetValue` in formula.ts;
      // `luckysheet_select_save` is not resized during that drag (yellow stays put).
      // const isMouseFormulaRangeDrag =
      //   !!ctx.formulaCache.func_selectedrange &&
      //   (ctx.formulaCache.rangestart ||
      //     ctx.formulaCache.rangedrag_column_start ||
      //     ctx.formulaCache.rangedrag_row_start);
      // if (isMouseFormulaRangeDrag) {
      //   return;
      // }

      // Sets formulaCache.rangeSetValueTo for APPEND insertion point.
      israngeseleciton(ctx);
      const keyboardSyncRangeIndex =
        getFormulaRangeIndexForKeyboardSync(cellInputEl);

      if (suppressAnchorSelectionSyncRef.current) {
        // Segment boundary (`,`, `+`, …) snaps yellow to the anchor and sets this
        // ref to skip one stray sync. Keyboard formula nav intentionally keeps
        // yellow on that same anchor while `func_selectedrange` moves — if we
        // always bail when selection === anchor, we never run `rangeSetValue`
        // after the first reference in a multi-arg formula.
        if (ctx.formulaCache.formulaKeyboardRefSync === true) {
          suppressAnchorSelectionSyncRef.current = null;
        } else {
          const [anchorRow, anchorCol] = suppressAnchorSelectionSyncRef.current;
          const isAnchorSelection =
            currentSelection.row_focus === anchorRow &&
            currentSelection.column_focus === anchorCol;
          if (isAnchorSelection) {
            return;
          }
          suppressAnchorSelectionSyncRef.current = null;
        }
      }

      const isFormulaMode = isFormulaReferenceInputMode(ctx);

      // Selection changes should update references only in formula mode.
      if (!isFormulaMode) return;

      const fsr = ctx.formulaCache.func_selectedrange;
      const fsrOk = fsr?.row?.length === 2 && fsr?.column?.length === 2;
      // Do not drive `rangeSetValue` from `luckysheet_select_save` when the formula
      // range lives in `func_selectedrange` (keyboard nav, or active mouse range drag).
      const preferFuncRange =
        fsrOk &&
        (ctx.formulaCache.formulaKeyboardRefSync === true ||
          !!ctx.formulaCache.rangestart ||
          !!ctx.formulaCache.rangedrag_column_start ||
          !!ctx.formulaCache.rangedrag_row_start);

      // Intentional pick only. Idle selection changes (type-over race, sheet-tab
      // restore of another sheet's A1, etc.) must not insert a ref — otherwise
      // `=SUM(` + switch to Sheet2 becomes `=SUM(Sheet2!A1` with no nav/drag.
      if (!preferFuncRange) {
        return;
      }

      const refRange = { row: fsr!.row, column: fsr!.column };

      // Point rangechangeindex at the ref under/near the caret — not always the
      // last span (e.g. `=,A4` with caret between `=` and `,` must not replace A4).
      if (keyboardSyncRangeIndex !== null) {
        ctx.formulaCache.rangechangeindex = keyboardSyncRangeIndex;
        ctx.formulaCache.rangestart = true;
        ctx.formulaCache.rangedrag_column_start = false;
        ctx.formulaCache.rangedrag_row_start = false;
      } else {
        ctx.formulaCache.rangechangeindex = undefined;
        ctx.formulaCache.rangestart = false;
      }

      // Mark that range/reference content was inserted by keyboard range selection.
      ctx.formulaCache.rangeSelectionActive = true;

      rangeSetValue?.(
        ctx,
        cellInputEl,
        {
          row: refRange.row,
          column: refRange.column,
        },
        refs.fxInput.current!,
      );

      rangeHightlightselected(ctx, cellInputEl);

      // Mirror mouse behavior: show blue dotted formula-range selection
      // for keyboard-driven reference selection as well.
      if (!_.isNil(ctx.formulaCache.rangechangeindex)) {
        ctx.formulaCache.selectingRangeIndex =
          ctx.formulaCache.rangechangeindex;
        createRangeHightlight(
          ctx,
          cellInputEl.innerHTML,
          ctx.formulaCache.rangechangeindex,
        );

        const rectFromSelection = seletedHighlistByindex(
          ctx,
          refRange.row[0],
          refRange.row[1],
          refRange.column[0],
          refRange.column[1],
        );

        if (rectFromSelection) {
          createFormulaRangeSelect(ctx, {
            rangeIndex: ctx.formulaCache.rangechangeindex || 0,
            left: rectFromSelection.left,
            top: rectFromSelection.top,
            width: rectFromSelection.width,
            height: rectFromSelection.height,
          });
        }
      }
    });
    // Same deps as main (`luckysheet_select_save` + dialog) so typing `=` does not
    // re-fire this effect (main did not depend on rangestart / cellUpdate). Keyboard
    // formula moves still run via `formulaRangeNavRevision` + `formulaFuncRangeSyncSig`.
  }, [
    context.luckysheet_select_save,
    context.rangeDialog?.show,
    context.formulaRangeNavRevision,
    formulaFuncRangeSyncSig,
    // isInputBoxActive,
  ]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const moveCaretOutsideTrailingLinkSpan = () => {
        const editor = inputRef.current;
        if (!editor) return false;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (!range.collapsed || !editor.contains(range.startContainer))
          return false;

        const placeCaretInFreshPlainSpanAfter = (anchorSpan: HTMLElement) => {
          const typingSpan = document.createElement('span');
          typingSpan.className = 'luckysheet-input-span';
          const textNode = document.createTextNode('');
          typingSpan.appendChild(textNode);
          anchorSpan.insertAdjacentElement('afterend', typingSpan);

          const out = document.createRange();
          out.setStart(textNode, 0);
          out.collapse(true);
          sel.removeAllRanges();
          sel.addRange(out);
        };

        // Boundary case: caret can be positioned on the editor/root element with
        // offset after a linked span (not inside the text node itself).
        if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
          const node = range.startContainer as HTMLElement;
          const idx = range.startOffset - 1;
          const prev = idx >= 0 ? node.childNodes[idx] : null;
          if (
            prev instanceof HTMLElement &&
            prev.tagName === 'SPAN' &&
            prev.dataset?.linkType &&
            prev.dataset?.linkAddress
          ) {
            placeCaretInFreshPlainSpanAfter(prev);
            return true;
          }
        }

        let span: HTMLElement | null =
          range.startContainer instanceof HTMLElement
            ? range.startContainer
            : range.startContainer.parentElement;
        while (span && span !== editor && span.tagName !== 'SPAN') {
          span = span.parentElement;
        }
        if (!span || span === editor || span.tagName !== 'SPAN') return false;
        if (!span.dataset?.linkType || !span.dataset?.linkAddress) return false;

        const pre = document.createRange();
        pre.selectNodeContents(span);
        pre.setEnd(range.startContainer, range.startOffset);
        const caretOffsetInSpan = pre.toString().length;
        if (caretOffsetInSpan !== (span.textContent ?? '').length) return false;

        // Create an explicit non-link typing container so browser doesn't keep
        // extending the linked span with new characters.
        placeCaretInFreshPlainSpanAfter(span);
        return true;
      };

      const insertPlainLineBreakAtCaret = () => {
        const editor = inputRef.current;
        if (!editor) return false;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (!editor.contains(range.startContainer)) return false;

        const br = document.createElement('br');
        const typingSpan = document.createElement('span');
        typingSpan.className = 'luckysheet-input-span';
        typingSpan.setAttribute('data-no-link-anchor', '1');
        // Use ZWSP as a caret placeholder for the new line typing span.
        // Serialization strips it so it never persists to cell value.
        const textNode = document.createTextNode('\u200B');
        typingSpan.appendChild(textNode);

        const startEl =
          range.startContainer instanceof HTMLElement
            ? range.startContainer
            : range.startContainer.parentElement;
        let hostSpan: HTMLElement | null = startEl;
        while (hostSpan && hostSpan !== editor && hostSpan.tagName !== 'SPAN') {
          hostSpan = hostSpan.parentElement;
        }

        // Root-cause fix for duplicate text:
        // if we insert <br> + typing span at a text-node caret inside an existing span,
        // the new typing span can become nested. Commit serialization then reads both
        // outer+inner spans and duplicates typed text (e.g. "reallyreally").
        // Insert as top-level siblings when caret is in a plain/no-link typing span.
        if (
          hostSpan &&
          hostSpan !== editor &&
          hostSpan.tagName === 'SPAN' &&
          !hostSpan.dataset?.linkType &&
          !hostSpan.dataset?.linkAddress
        ) {
          hostSpan.insertAdjacentElement('afterend', br);
          br.insertAdjacentElement('afterend', typingSpan);
        } else {
          range.deleteContents();
          const frag = document.createDocumentFragment();
          frag.appendChild(br);
          frag.appendChild(typingSpan);
          range.insertNode(frag);
        }

        const out = document.createRange();
        out.setStart(textNode, 1);
        out.collapse(true);
        sel.removeAllRanges();
        sel.addRange(out);
        return true;
      };

      const isTextInsertKey =
        !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1;
      if (isTextInsertKey) {
        // Move caret out of a trailing link span before native text insertion.
        // Let the browser perform the actual insertion once to avoid double-write paths.
        moveCaretOutsideTrailingLinkSpan();
      }

      setContext((draftCtx) => {
        setFormulaEditorOwner(draftCtx, 'cell');
      });
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
        // Some first-character paths can miss contenteditable onChange/onInput.
        // Snapshot from keydown as a fallback; duplicate HTML is ignored in hook.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (getFormulaEditorOwner(context) !== 'cell') return;
            appendEditorHistoryFromPrimaryEditor(() =>
              getCursorPosition(inputRef.current!),
            );
          });
        });
      }
      const currentInputText = inputRef.current?.innerText || '';
      const currentInputIsFormula = startsWithFormula(currentInputText);

      if (
        (e.key === '=' || currentInputIsFormula) &&
        context.luckysheetCellUpdate.length === 2 &&
        formulaAnchorCellRef.current == null
      ) {
        // Starting a new formula flow; clear range-selection dirtiness so
        // the user can start referencing again. Also drop any stale keyboard
        // ref-sync state so a re-fired selection effect cannot insert the
        // edit cell (e.g. `=` → `=A1`).
        const [anchorRow, anchorCol] = context.luckysheetCellUpdate;
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
        formulaAnchorCellRef.current = [anchorRow, anchorCol];
        if (e.key === '=') {
          suppressAnchorSelectionSyncRef.current = [anchorRow, anchorCol];
        }
      }

      if (e.key === '(' && currentInputIsFormula) {
        // When the user types "(" we are at/near a reference insertion point.
        // Clear dirtiness so keyboard/mouse referencing can continue.
        setContext((draftCtx) => {
          draftCtx.formulaCache.rangeSelectionActive = null;
        });
      }

      if (
        isFormulaSegmentBoundaryKey(e.key) &&
        context.luckysheetCellUpdate.length > 0 &&
        currentInputIsFormula &&
        formulaAnchorCellRef.current
      ) {
        // Comma / operators: segment done; clear range overlay and return to anchor.
        setContext((draftCtx) => {
          draftCtx.formulaCache.rangeSelectionActive = null;
        });
        const [anchorRow, anchorCol] = formulaAnchorCellRef.current;
        const onForeignSheet =
          !!context.formulaCache.rangetosheet &&
          context.formulaCache.rangetosheet !== context.currentSheetId;
        suppressAnchorSelectionSyncRef.current = [anchorRow, anchorCol];
        setTimeout(() => {
          setContext((draftCtx) => {
            draftCtx.luckysheetCellUpdate = [anchorRow, anchorCol];
            // On a foreign sheet, keep the pick selection — do not snap yellow to
            // the origin cell's row/col (that would select the wrong sheet's cell).
            if (!onForeignSheet) {
              snapSheetSelectionFocusToCellPreserveMultiRange(
                draftCtx,
                anchorRow,
                anchorCol,
              );
            }
            // Reference before delimiter is complete; clear the active range-select
            // overlay, but keep completed referenced-cell highlights visible.
            // Clear keyboard-ref sync so the rangeSetValue effect does not take the
            // "formulaKeyboardRefSync" suppress branch, skip the anchor early-return,
            // and insert the anchor address (e.g. `=A2:A4,A1` after `,`).
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
              refs.cellInput.current?.innerHTML ||
                refs.fxInput.current?.innerHTML ||
                '',
            );
            if (!onForeignSheet) {
              moveHighlightCell(draftCtx, 'down', 0, 'rangeOfSelect');
            }
          });
        }, 0);
      }
      // if (
      //   $("#luckysheet-modal-dialog-mask").is(":visible") ||
      //   $(event.target).hasClass("luckysheet-mousedown-cancel") ||
      //   $(event.target).hasClass("formulaInputFocus")
      // ) {
      //   return;
      // }

      if ((e.metaKey || e.ctrlKey) && context.luckysheetCellUpdate.length > 0) {
        const undoRedo = matchUndoRedoShortcut(e as unknown as KeyboardEvent);
        if (undoRedo) {
          const isRedo = undoRedo === 'redo';

          // Always intercept undo/redo in-editor to prevent native
          // contenteditable history from fighting our snapshot stack.
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
        if (e.code === 'KeyB') {
          const beforeHtml = inputRef.current?.innerHTML ?? '';
          handleBold(context, inputRef.current!);
          const pushFormattingSnapshot = (triesLeft: number) => {
            requestAnimationFrame(() => {
              const afterHtml = inputRef.current?.innerHTML ?? '';
              if (afterHtml !== beforeHtml || triesLeft <= 0) {
                appendEditorHistoryFromPrimaryEditor(() =>
                  getCursorPosition(inputRef.current!),
                );
                return;
              }
              pushFormattingSnapshot(triesLeft - 1);
            });
          };
          pushFormattingSnapshot(2);
          stopPropagation(e);
        } else if (e.code === 'KeyI') {
          const beforeHtml = inputRef.current?.innerHTML ?? '';
          handleItalic(context, inputRef.current!);
          const pushFormattingSnapshot = (triesLeft: number) => {
            requestAnimationFrame(() => {
              const afterHtml = inputRef.current?.innerHTML ?? '';
              if (afterHtml !== beforeHtml || triesLeft <= 0) {
                appendEditorHistoryFromPrimaryEditor(() =>
                  getCursorPosition(inputRef.current!),
                );
                return;
              }
              pushFormattingSnapshot(triesLeft - 1);
            });
          };
          pushFormattingSnapshot(2);
          stopPropagation(e);
        } else if (e.code === 'KeyU') {
          const beforeHtml = inputRef.current?.innerHTML ?? '';
          handleUnderline(context, inputRef.current!);
          const pushFormattingSnapshot = (triesLeft: number) => {
            requestAnimationFrame(() => {
              const afterHtml = inputRef.current?.innerHTML ?? '';
              if (afterHtml !== beforeHtml || triesLeft <= 0) {
                appendEditorHistoryFromPrimaryEditor(() =>
                  getCursorPosition(inputRef.current!),
                );
                return;
              }
              pushFormattingSnapshot(triesLeft - 1);
            });
          };
          pushFormattingSnapshot(2);
          stopPropagation(e);
        } else if (e.code === 'KeyS') {
          const beforeHtml = inputRef.current?.innerHTML ?? '';
          handleStrikeThrough(context, inputRef.current!);
          const pushFormattingSnapshot = (triesLeft: number) => {
            requestAnimationFrame(() => {
              const afterHtml = inputRef.current?.innerHTML ?? '';
              if (afterHtml !== beforeHtml || triesLeft <= 0) {
                appendEditorHistoryFromPrimaryEditor(() =>
                  getCursorPosition(inputRef.current!),
                );
                return;
              }
              pushFormattingSnapshot(triesLeft - 1);
            });
          };
          pushFormattingSnapshot(2);
          stopPropagation(e);
        }
      }

      if (!isComposingRef.current) {
        const currentCommaCount = countCommasBeforeCursor(inputRef?.current!);
        setCommaCount(currentCommaCount);
      }

      /* Arrow navigation for cell reference starts here */
      let allowListNavigation = true;
      const isArrowKey =
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight';
      const isInPlaceEditMode = refs.globalCache?.enteredEditByTyping !== true;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const anchor = formulaAnchorCellRef.current;
        if (anchor != null) {
          const [anchorRow, anchorCol] = anchor;
          const onForeignSheet =
            !!context.formulaCache.rangetosheet &&
            context.formulaCache.rangetosheet !== context.currentSheetId;
          suppressAnchorSelectionSyncRef.current = [anchorRow, anchorCol];
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
              // Same as segment boundary: avoid rangeSetValue effect inserting the
              // anchor (e.g. `=A2` → delete `2` → `=A1`) when selection snaps to anchor.
              draftCtx.formulaCache.formulaKeyboardRefSync = false;
              if (!onForeignSheet) {
                // Recompute selection box immediately so UI snaps back to anchor cell.
                moveHighlightCell(draftCtx, 'down', 0, 'rangeOfSelect');
              }
              markRangeSelectionDirty(draftCtx);
              // markRangeSelectionDirty clears formulaRangeHighlight; rebuild from the
              // live editor so argument highlights return after handleFormulaInput ran.
              const el = refs.cellInput.current;
              if (el && startsWithFormula(el.innerText ?? '')) {
                createRangeHightlight(draftCtx, el.innerHTML);
                rangeHightlightselected(draftCtx, el);
              }
            });
          }, 0);
        }
        if (isComposingRef.current) requestAnimationFrame(ensureNotEmpty);
        if (
          getCursorPosition(inputRef?.current!) ===
          inputRef?.current!.innerText.length
        ) {
          setTimeout(() => {
            moveCursorToEnd(inputRef?.current!);
          }, 5);
        }
      }

      if (isArrowKey && isFormulaReferenceInputMode(context)) {
        // Let global keyboard handlers move selected cells while formula range
        // updates are performed via `rangeSetValue` in the selection effect.
        allowListNavigation = false;
        if (e.shiftKey) {
          // Avoid native Shift+Arrow extending the contenteditable selection; the
          // workbook handler moves the formula reference range instead.
          e.preventDefault();
        }
      }
      /* Arrow navigation for cell reference ends here */

      if (e.key === 'Escape' && context.luckysheetCellUpdate.length > 0) {
        setContext((draftCtx) => {
          returnToFormulaOriginSheet(draftCtx);
          cancelNormalSelected(draftCtx);
          moveHighlightCell(draftCtx, 'down', 0, 'rangeOfSelect');
        });
        e.preventDefault();
      } else if (e.key === 'Enter' && context.luckysheetCellUpdate.length > 0) {
        if (e.altKey) {
          // In-cell line break: Alt+Enter (Win) / Ctrl+Option+Return (Mac).
          // Cmd/Ctrl+Enter (fill range) must bubble to the workbook handler.
          e.preventDefault();
          // Match Space behavior in multiline mode too: link the token before caret first.
          autoLinkUrlsInEditorRef.current('commit', {
            preserveCaret: true,
            deferCaretRestore: false,
          });
          // If caret is at the end of a hyperlink span, move to a plain typing span first.
          // Otherwise Cmd/Alt+Enter inserts <br> inside the linked span, and next-line text
          // keeps inheriting link metadata/style.
          moveCaretOutsideTrailingLinkSpan();
          // Use explicit newline insertion with a plain typing span so the new line never
          // inherits hyperlink blue/underline from the previous linked run.
          if (!insertPlainLineBreakAtCaret()) {
            // Fallback to legacy execCommand behavior if selection shape is unexpected.
            document.execCommand('insertHTML', false, '\n ');
            document.execCommand('delete', false);
          }
          e.stopPropagation();
        } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
          // Fill range (Ctrl/Cmd+Enter): let handleShortcutsV2 handle it.
          return;
        } else {
          // Single-line Enter commit should also auto-link like Space.
          autoLinkUrlsInEditorRef.current('commit');
          selectActiveFormula(e);
          // Let Enter bubble to Workbook `handleGlobalEnter` (commit / multi-range
          // advance). Block contenteditable newline if formula list did not consume it.
          if (!e.defaultPrevented) {
            e.preventDefault();
          }
        }
      } else if (e.key === 'Tab' && context.luckysheetCellUpdate.length > 0) {
        selectActiveFormula(e);
        e.preventDefault();
      } else if (e.key === 'F4' && context.luckysheetCellUpdate.length > 0) {
        // formula.setfreezonFuc(event);
        e.preventDefault();
      } else if (
        !(e.metaKey || e.ctrlKey) &&
        e.key === 'ArrowUp' &&
        context.luckysheetCellUpdate.length > 0 &&
        allowListNavigation &&
        !(e.shiftKey && isInPlaceEditMode)
      ) {
        const formulaSearchContainer = document.getElementById(
          'luckysheet-formula-search-c',
        );
        if (formulaSearchContainer) {
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
          e.preventDefault();
        } else if (isInPlaceEditMode && !isFormulaReferenceInputMode(context)) {
          // In double-click/F2 edit mode, keep native caret movement for Up/Down.
          // Do not prevent default so contenteditable can move the caret vertically.
          return;
        }
      } else if (
        !(e.metaKey || e.ctrlKey) &&
        e.key === 'ArrowDown' &&
        context.luckysheetCellUpdate.length > 0 &&
        allowListNavigation &&
        !(e.shiftKey && isInPlaceEditMode)
      ) {
        const formulaSearchContainer = document.getElementById(
          'luckysheet-formula-search-c',
        );
        if (formulaSearchContainer) {
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
          e.preventDefault();
        } else if (isInPlaceEditMode && !isFormulaReferenceInputMode(context)) {
          // In double-click/F2 edit mode, keep native caret movement for Up/Down.
          return;
        }
      }
      // else if (
      //   e.key === "ArrowLeft" &&
      //   draftCtx.luckysheetCellUpdate.length > 0
      // ) {
      //   formulaMoveEvent("left", ctrlKey, shiftKey, event);
      // } else if (
      //   e.key === "ArrowRight" &&
      //   draftCtx.luckysheetCellUpdate.length > 0
      // ) {
      //   formulaMoveEvent("right", ctrlKey, shiftKey, event);
      // }
    },
    [
      capturePreEditorHistoryState,
      clearSearchItemActiveClass,
      context.luckysheetCellUpdate.length,
      handleFormulaHistoryUndoRedo,
      selectActiveFormula,
      setContext,
      firstSelection,
      refs.cellInput,
    ],
  );

  const onBeforeInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    const ie = e.nativeEvent as InputEvent;
    if (ie?.isComposing) return;
    if (!ie || ie.inputType !== 'insertText' || !ie.data) return;
    const editor = inputRef.current;
    if (!editor) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || !editor.contains(range.startContainer)) return;

    const placeCaretInFreshPlainSpanAfter = (anchorSpan: HTMLElement) => {
      const typingSpan = document.createElement('span');
      typingSpan.className = 'luckysheet-input-span';
      const textNode = document.createTextNode('');
      typingSpan.appendChild(textNode);
      anchorSpan.insertAdjacentElement('afterend', typingSpan);

      const out = document.createRange();
      out.setStart(textNode, 0);
      out.collapse(true);
      sel.removeAllRanges();
      sel.addRange(out);
    };

    const tryMoveOutOfLinkedTail = () => {
      if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
        const node = range.startContainer as HTMLElement;
        const idx = range.startOffset - 1;
        const prev = idx >= 0 ? node.childNodes[idx] : null;
        if (
          prev instanceof HTMLElement &&
          prev.tagName === 'SPAN' &&
          prev.dataset?.linkType &&
          prev.dataset?.linkAddress
        ) {
          placeCaretInFreshPlainSpanAfter(prev);
          return true;
        }
      }
      let span: HTMLElement | null =
        range.startContainer instanceof HTMLElement
          ? range.startContainer
          : range.startContainer.parentElement;
      while (span && span !== editor && span.tagName !== 'SPAN') {
        span = span.parentElement;
      }
      if (!span || span === editor || span.tagName !== 'SPAN') return false;
      if (!span.dataset?.linkType || !span.dataset?.linkAddress) return false;

      const pre = document.createRange();
      pre.selectNodeContents(span);
      pre.setEnd(range.startContainer, range.startOffset);
      const caretOffsetInSpan = pre.toString().length;
      if (caretOffsetInSpan !== (span.textContent ?? '').length) return false;

      placeCaretInFreshPlainSpanAfter(span);
      return true;
    };

    if (!tryMoveOutOfLinkedTail()) return;
    // Only relocate caret out of the linked tail; let native beforeinput/input
    // perform the text insertion once. Manual execCommand insertion here can
    // double-apply text in some multiline selection states after Cmd/Alt+Enter.
  }, []);

  const handleHideShowHint = () => {
    const searchElFx = document.getElementsByClassName('fx-search')?.[0];
    const searchElCell = document.getElementsByClassName('cell-search')?.[0];
    if (searchElFx) {
      // @ts-ignore
      searchElFx.style.display = 'none';
    }
    if (searchElCell) {
      // @ts-ignore
      searchElCell.style.display = 'block';
    }

    const el = document.getElementsByClassName('fx-hint')?.[0];
    const elCell = document.getElementsByClassName('cell-hint')?.[0];
    if (el) {
      // @ts-ignore
      el.style.display = 'none';
    }
    if (elCell) {
      // @ts-ignore
      elCell.style.display = 'block';
    }
  };

  const maybeAutoLinkUrlsInEditor = useCallback(
    (
      mode: 'space' | 'commit' = 'space',
      options?: { preserveCaret?: boolean; deferCaretRestore?: boolean },
    ) => {
      const editor = inputRef.current;
      if (!editor) return;
      const plain = editor.innerText ?? '';
      if (plain.trimStart().startsWith('=')) return;
      const normalized = plain.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const shouldRestoreCaret = options?.preserveCaret !== false;
      const shouldDeferRestore = options?.deferCaretRestore !== false;
      const found: Array<{ start: number; end: number; url: string }> = [];
      // Primary path for typing+Space: only convert the just-finished token before caret.
      const sel = window.getSelection();
      if (sel?.rangeCount && sel.focusNode && editor.contains(sel.focusNode)) {
        const current = sel.getRangeAt(0);
        if (current.collapsed) {
          const pre = document.createRange();
          pre.selectNodeContents(editor);
          pre.setEnd(current.startContainer, current.startOffset);
          const beforeCaret = pre
            .toString()
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n');
          const lineStart = beforeCaret.lastIndexOf('\n') + 1;
          const lineBeforeCaret = beforeCaret.slice(lineStart);
          const m = lineBeforeCaret.match(
            mode === 'space'
              ? /(?:^|[\s(])((?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s]*)?)\s$/i
              : /(?:^|[\s(])((?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s]*)?)$/i,
          );
          if (m) {
            const token = m[1];
            const trailingAdjust = mode === 'space' ? 1 : 0;
            const tokenStart =
              lineStart +
              (lineBeforeCaret.length - trailingAdjust - token.length);
            let tokenEnd = tokenStart + token.length;
            while (
              tokenEnd > tokenStart &&
              /[),.!?:;"']/.test(beforeCaret[tokenEnd - 1])
            ) {
              tokenEnd -= 1;
            }
            if (tokenEnd > tokenStart) {
              found.push({
                start: tokenStart,
                end: tokenEnd,
                url: beforeCaret.slice(tokenStart, tokenEnd),
              });
            }
          }
        }
      }
      // Important for multiline stability: do NOT run full-editor fallback scans here.
      // Space auto-link should only touch the just-finished token around caret.
      if (found.length === 0) return;

      let appliedLinkViaApplyLink = false;
      const caretBefore = getCaretCharacterOffsetInEditor(editor);
      for (const item of found) {
        if (
          !setSelectionByCharacterOffsetInEditor(editor, item.start, item.end)
        )
          continue;
        const selNow = window.getSelection();
        if (!selNow || selNow.rangeCount === 0) continue;
        const rangeNow = selNow.getRangeAt(0);
        const selectedNow = (selNow.toString() ?? '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n');
        const normalizedSelected = selectedNow
          .replace(/\u00a0/g, ' ')
          .replace(/\u200b/g, '')
          .trim();
        const normalizedUrl = item.url
          .replace(/\u00a0/g, ' ')
          .replace(/\u200b/g, '')
          .trim();
        // Guard against element-node ranges (e.g. editor DIV boundary ranges), which can
        // make applyLinkToSelection slice HTML by node offsets and corrupt editor content.
        // Special-case commit when the entire editor equals the URL token (e.g. `test.com` + Enter).
        if (
          rangeNow.startContainer === editor ||
          rangeNow.endContainer === editor ||
          !editor.contains(rangeNow.startContainer) ||
          !editor.contains(rangeNow.endContainer)
        ) {
          if (mode === 'commit') {
            const editorPlain = (editor.innerText ?? editor.textContent ?? '')
              .replace(/\r\n/g, '\n')
              .replace(/\r/g, '\n')
              .replace(/\u00a0/g, ' ')
              .replace(/\u200b/g, '')
              .trim();
            if (
              editorPlain === normalizedUrl &&
              normalizedSelected === normalizedUrl
            ) {
              editor.innerHTML = buildSingleLinkEditorHtml(editorPlain, {
                linkType: 'webpage',
                linkAddress: item.url,
              });
              continue;
            }
          }
          continue;
        }
        if (mode === 'space') {
          if (normalizedSelected !== normalizedUrl) continue;
        } else if (!normalizedSelected.includes(normalizedUrl)) {
          // Commit path can see small selection shape differences at Enter time.
          // Require token inclusion, not exact equality.
          continue;
        }
        const existing = getUniformLinkFromWindowSelectionInEditor(editor);
        if (
          existing?.linkType === 'webpage' &&
          (existing.linkAddress || '').trim() === item.url.trim()
        ) {
          continue;
        }
        applyLinkToSelection(editor, 'webpage', item.url);
        appliedLinkViaApplyLink = true;
      }
      ensureTrailingPlainSpanAfterLinkedTail(editor);
      if (!shouldRestoreCaret) return;
      // applyLinkToSelection already moves the caret into a plain span after the new link.
      // Restoring caretBefore remaps badly after DOM changes (NBSP / split spans, multiline +
      // <br>): caret can jump to the wrong line — e.g. Cmd+Enter inserts a break but selection
      // stays on the previous line. Skip restore whenever we actually applied a link (Space or
      // commit paths, including Cmd/Alt+Enter pre-newline auto-link).
      if (appliedLinkViaApplyLink) {
        return;
      }
      const restoreOffset = caretBefore ?? normalized.length;
      const restoreCaret = () =>
        setSelectionByCharacterOffsetInEditor(
          editor,
          restoreOffset,
          restoreOffset,
        );
      restoreCaret();
      if (shouldDeferRestore) {
        requestAnimationFrame(restoreCaret);
      }
    },
    [],
  );
  autoLinkUrlsInEditorRef.current = maybeAutoLinkUrlsInEditor;

  const onChange = useCallback(
    (__: any, isBlur?: boolean) => {
      if (context.isFlvReadOnly) return;
      handleHideShowHint();

      const editorText = inputRef.current?.innerText?.trim() ?? '';
      const isStrictFormula = isStrictFormulaEditorText(inputRef.current);
      setCellEditorIsFormula(isStrictFormula);

      setShowSearchHint(
        shouldShowFormulaFunctionList(inputRef?.current ?? null),
      );

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

      if (!isComposingRef.current) {
        const currentCommaCount = countCommasBeforeCursor(inputRef?.current!);
        setCommaCount(currentCommaCount);
      }

      // setInputHTML(html);
      // console.log("onChange", __);
      const e = lastKeyDownEventRef.current;
      if (!e) {
        if (isBlur) {
          autoLinkUrlsInEditorRef.current('commit');
        }
        const cellEl = refs.cellInput.current;
        if (
          cellEl &&
          startsWithFormula(cellEl.innerText ?? cellEl.textContent ?? '')
        ) {
          setContext(
            (draftCtx) => {
              if (!isAllowEdit(draftCtx, draftCtx.luckysheet_select_save))
                return;
              rangeHightlightselected(draftCtx, cellEl);
            },
            { noHistory: true },
          );
        }
        return;
      }
      // Mac: Cmd+Z sets metaKey, not ctrlKey — without this, onChange runs
      // handleFormulaInput(90) and corrupts DOM / history (redo + extra char).
      if (isEditorUndoRedoKeyEvent(e)) {
        return;
      }
      const kcode = e.keyCode;
      if (!kcode) return;

      if (
        !(
          (
            (kcode >= 112 && kcode <= 123) ||
            kcode <= 46 ||
            kcode === 144 ||
            kcode === 108 ||
            e.ctrlKey ||
            e.altKey ||
            (e.shiftKey &&
              (kcode === 37 || kcode === 38 || kcode === 39 || kcode === 40))
          )
          // kcode === keycode.WIN ||
          // kcode === keycode.WIN_R ||
          // kcode === keycode.MENU))
        ) ||
        kcode === 8 ||
        kcode === 32 ||
        kcode === 46 ||
        (e.ctrlKey && kcode === 86)
      ) {
        setContext(
          (draftCtx) => {
            if (
              (draftCtx.formulaCache.rangestart ||
                draftCtx.formulaCache.rangedrag_column_start ||
                draftCtx.formulaCache.rangedrag_row_start ||
                israngeseleciton(draftCtx)) &&
              isBlur
            )
              return;
            if (!isAllowEdit(draftCtx, draftCtx.luckysheet_select_save)) {
              return;
            }
            // if(event.target.id!="luckysheet-input-box" && event.target.id!="luckysheet-rich-text-editor"){
            handleFormulaInput(
              draftCtx,
              refs.fxInput.current,
              refs.cellInput.current!,
              kcode,
              preTextRef.current,
            );
            const cellEl = refs.cellInput.current;
            if (
              cellEl &&
              startsWithFormula(cellEl.innerText ?? cellEl.textContent ?? '')
            ) {
              rangeHightlightselected(draftCtx, cellEl);
            }
            // clearSearchItemActiveClass();
            // formula.functionInputHanddler(
            //   $("#luckysheet-functionbox-cell"),
            //   $("#luckysheet-rich-text-editor"),
            //   kcode
            // );
            // setCenterInputPosition(
            //   draftCtx.luckysheetCellUpdate[0],
            //   draftCtx.luckysheetCellUpdate[1],
            //   draftCtx.flowdata
            // );
            // }
          },
          { noHistory: true },
        );
      }
      if (kcode === 32) {
        maybeAutoLinkUrlsInEditor('space');
      }
      // Snapshot current editor HTML/caret after all DOM rewrites caused by
      // this keystroke (plain text, rich text formatting, and formula tokens).
      requestAnimationFrame(() => {
        if (getFormulaEditorOwner(context) !== 'cell') return;
        appendEditorHistoryFromPrimaryEditor(() =>
          getCursorPosition(inputRef.current!),
        );
      });
    },
    [
      refs.cellInput,
      refs.fxInput,
      setContext,
      appendEditorHistoryFromPrimaryEditor,
      maybeAutoLinkUrlsInEditor,
    ],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const plainText = e.clipboardData.getData('text/plain');

      e.preventDefault();

      if (_.isEmpty(context.luckysheetCellUpdate)) {
        return;
      }

      document.execCommand('insertText', false, plainText);
    },
    [context.luckysheetCellUpdate],
  );

  const onCopy = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (_.isEmpty(context.luckysheetCellUpdate)) return;
      // In cell edit mode: suppress browser HTML copy, write plain text only
      e.preventDefault();
      const sel = window.getSelection();
      const text =
        sel && !sel.isCollapsed ? sel.toString() : e.currentTarget.innerText;
      navigator.clipboard?.writeText(text).catch(() => {});
    },
    [context.luckysheetCellUpdate],
  );

  const cfg = context.config || {};
  const rowReadOnly: Record<number, number> = cfg.rowReadOnly || {};
  const colReadOnly: Record<number, number> = cfg.colReadOnly || {};

  const edit = !(
    (colReadOnly[col_index] || rowReadOnly[row_index]) &&
    context.allowEdit === true
  );

  /** Padding on `.luckysheet-input-box-inner` is outside the contenteditable; forward clicks into the editor. */
  const onInputBoxInnerMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (context.linkCard) {
        setContext((draftCtx) => {
          draftCtx.linkCard = undefined;
        });
      }
      if (!edit || isHidenRC || context.luckysheetCellUpdate.length === 0) {
        return;
      }
      const editor = refs.cellInput.current;
      if (!editor) return;
      if (editor.contains(e.target as Node)) return;
      e.preventDefault();
      editor.focus({ preventScroll: true });
      moveCursorToEnd(editor);
      setContext((draftCtx) => {
        setFormulaEditorOwner(draftCtx, 'cell');
      });
    },
    [
      edit,
      isHidenRC,
      context.linkCard,
      context.luckysheetCellUpdate.length,
      refs.cellInput,
      setContext,
    ],
  );

  // Calculate input box position relative to viewport (screen) instead of canvas
  const getInputBoxPosition = useCallback(() => {
    if (!firstSelection || context.rangeDialog?.show) {
      return { left: -10000, top: -10000, display: 'block' };
    }

    // Get the canvas container to calculate viewport-relative position
    const canvasContainer = refs.cellArea.current;

    if (!canvasContainer) {
      return {
        left: firstSelection.left || 0,
        top: firstSelection.top || 0,
        display: 'block',
      };
    }

    if (isInputBoxActive) {
      // If InputBox is active, use the frozen position (ignore scroll)
      return {
        left: frozenPosition.left,
        top: frozenPosition.top,
        // Keep the editor below formula search/hint popups.
        zIndex: _.isEmpty(context.luckysheetCellUpdate) ? -1 : 14,
        display: 'block',
      };
    }
    // If not active, calculate the initial position (do not set state here)
    const containerRect = canvasContainer.getBoundingClientRect();
    const initialLeft =
      containerRect.left + (firstSelection.left || 0) - context.scrollLeft;
    const initialTop =
      containerRect.top + (firstSelection.top || 0) - context.scrollTop;
    return {
      left: initialLeft,
      top: initialTop,
      // Keep the editor below formula search/hint popups.
      zIndex: _.isEmpty(context.luckysheetCellUpdate) ? -1 : 14,
      display: 'block',
    };
  }, [
    firstSelection,
    context.rangeDialog?.show,
    context.luckysheetCellUpdate,
    refs.cellArea,
    isInputBoxActive,
    frozenPosition,
    context.scrollLeft,
    context.scrollTop,
  ]);

  // Effect to freeze the position when input box becomes visible and not yet active
  useEffect(() => {
    if (
      firstSelection &&
      !context.rangeDialog?.show &&
      !isInputBoxActive &&
      !_.isEmpty(context.luckysheetCellUpdate)
    ) {
      const canvasContainer = refs.cellArea.current;
      if (canvasContainer) {
        const containerRect = canvasContainer.getBoundingClientRect();
        const initialLeft =
          containerRect.left + (firstSelection.left || 0) - context.scrollLeft;
        const initialTop =
          containerRect.top + (firstSelection.top || 0) - context.scrollTop;
        setFrozenPosition({ left: initialLeft, top: initialTop });
        setIsInputBoxActive(true);
      }
    }
  }, [
    firstSelection,
    context.rangeDialog?.show,
    context.luckysheetCellUpdate,
    isInputBoxActive,
    context.scrollLeft,
    context.scrollTop,
    refs.cellArea,
  ]);

  // Calculate cell address indicator position
  const getAddressIndicatorPosition = useCallback(() => {
    if (context.rangeDialog?.show) {
      return { display: 'none' };
    }

    // Always show above the input box
    return { top: '-18px', left: '0', display: 'block' };
  }, [context.rangeDialog?.show]);

  // Generate cell address string for the cell being edited (origin sheet).
  const getEditCellAddress = useCallback(() => {
    if (context.luckysheetCellUpdate.length !== 2) {
      if (!firstSelection) return '';
      const rowIndex = firstSelection.row_focus || 0;
      const colIndex = firstSelection.column_focus || 0;
      return `${indexToColumnChar(colIndex)}${rowIndex + 1}`;
    }
    const [rowIndex, colIndex] = context.luckysheetCellUpdate;
    const local = `${indexToColumnChar(colIndex)}${rowIndex + 1}`;
    const origin = context.formulaCache.rangetosheet;
    if (origin && origin !== context.currentSheetId) {
      return (
        getRangetxt(
          context,
          origin,
          { row: [rowIndex, rowIndex], column: [colIndex, colIndex] },
          context.currentSheetId,
        ) || local
      );
    }
    return local;
  }, [
    context,
    context.luckysheetCellUpdate,
    context.formulaCache.rangetosheet,
    context.currentSheetId,
    firstSelection,
  ]);

  const showCrossSheetAddressIndicator =
    !!context.formulaCache.rangetosheet &&
    context.formulaCache.rangetosheet !== context.currentSheetId &&
    context.luckysheetCellUpdate.length > 0;

  useEffect(() => {
    if (isInputBoxActive) {
      setActiveCell(getEditCellAddress());
      setFirstSelectionActiveCell(context.luckysheet_select_save?.[0]);
    }
  }, [isInputBoxActive, getEditCellAddress]);

  useLayoutEffect(() => {
    const editing = context.luckysheetCellUpdate.length > 0;
    if (!editing) {
      scrollAtEditSessionStartRef.current = null;
      setShowAddressIndicator(false);
      return;
    }

    if (showCrossSheetAddressIndicator) {
      setShowAddressIndicator(true);
      return;
    }

    const prevLen = prevCellUpdate?.length ?? 0;
    const startedThisCommit = prevLen === 0;

    if (startedThisCommit || scrollAtEditSessionStartRef.current == null) {
      scrollAtEditSessionStartRef.current = {
        left: context.scrollLeft,
        top: context.scrollTop,
      };
      setShowAddressIndicator(false);
      return;
    }

    const b = scrollAtEditSessionStartRef.current;
    if (context.scrollLeft !== b.left || context.scrollTop !== b.top) {
      setShowAddressIndicator(true);
    }
  }, [
    context.luckysheetCellUpdate,
    context.scrollLeft,
    context.scrollTop,
    prevCellUpdate,
    showCrossSheetAddressIndicator,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F10') {
        event.preventDefault(); // stop default browser behavior if any
        handleShowFormulaHint();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showFormulaHint]);

  // Keep selection highlight visible in input box when link modal is open (focus moved to modal)
  useLayoutEffect(() => {
    const lc = context.linkCard;
    const isSameCell =
      context.luckysheetCellUpdate?.length === 2 &&
      lc &&
      context.luckysheetCellUpdate[0] === lc.r &&
      context.luckysheetCellUpdate[1] === lc.c;
    if (
      !lc?.applyToSelection ||
      !lc?.selectionOffsets ||
      !isSameCell ||
      !inputRef.current ||
      !inputBoxInnerRef.current
    ) {
      setLinkSelectionHighlightRects([]);
      return;
    }
    const { start, end } = lc.selectionOffsets;
    const rects = getRangeRectsByCharacterOffset(inputRef.current, start, end);
    const containerRect = inputBoxInnerRef.current.getBoundingClientRect();
    const relative = rects.map((r) => ({
      left: r.left - containerRect.left,
      top: r.top - containerRect.top,
      width: r.width,
      height: r.height,
    }));
    setLinkSelectionHighlightRects(relative);
  }, [
    context.linkCard?.applyToSelection,
    context.linkCard?.selectionOffsets,
    context.linkCard?.r,
    context.linkCard?.c,
    context.luckysheetCellUpdate,
  ]);

  // When **starting** edit on a cell, clear a passive view-only card for that cell so
  // it does not sit over the editor. Must not run on every `linkCard` change during edit
  // (caret-driven view) — that cleared the card immediately and caused a blink.
  useEffect(() => {
    const startedEdit =
      (prevCellUpdate?.length ?? 0) === 0 &&
      context.luckysheetCellUpdate.length === 2;
    if (!startedEdit) return;
    const [er, ec] = context.luckysheetCellUpdate;
    const lc = context.linkCard;
    if (!lc || lc.isEditing) return;
    if (lc.r !== er || lc.c !== ec) return;
    setContext((draftCtx) => {
      if (draftCtx.linkCard && !draftCtx.linkCard.isEditing) {
        draftCtx.linkCard = undefined;
      }
    });
  }, [
    context.luckysheetCellUpdate,
    context.linkCard,
    prevCellUpdate,
    setContext,
  ]);

  // In edit mode, also apply real DOM selection so typed edits target that link text.
  useLayoutEffect(() => {
    const lc = context.linkCard;
    const isSameCell =
      context.luckysheetCellUpdate?.length === 2 &&
      lc &&
      context.luckysheetCellUpdate[0] === lc.r &&
      context.luckysheetCellUpdate[1] === lc.c;
    if (
      !lc?.isEditing ||
      !lc?.applyToSelection ||
      !lc?.selectionOffsets ||
      !isSameCell ||
      !inputRef.current
    ) {
      lastAppliedLinkSelectionKeyRef.current = null;
      return;
    }
    const { start, end } = lc.selectionOffsets;
    const selectionKey = [
      lc.r,
      lc.c,
      start,
      end,
      lc.editingLinkIndex ?? '',
    ].join(':');
    if (lastAppliedLinkSelectionKeyRef.current === selectionKey) {
      return;
    }
    const el = inputRef.current;
    const trySelect = () =>
      setSelectionByCharacterOffsetInEditor(el, start, end);
    if (trySelect()) {
      lastAppliedLinkSelectionKeyRef.current = selectionKey;
      return;
    }
    requestAnimationFrame(() => {
      if (lastAppliedLinkSelectionKeyRef.current === selectionKey) return;
      const box = inputRef.current;
      if (!box) return;
      if (setSelectionByCharacterOffsetInEditor(box, start, end)) {
        lastAppliedLinkSelectionKeyRef.current = selectionKey;
      }
    });
  }, [
    context.linkCard?.isEditing,
    context.linkCard?.applyToSelection,
    context.linkCard?.selectionOffsets,
    context.linkCard?.r,
    context.linkCard?.c,
    context.linkCard?.editingLinkIndex,
    context.luckysheetCellUpdate,
  ]);

  useLayoutEffect(() => {
    if (context.luckysheetCellUpdate.length === 0) {
      setCellEditorExtendRight(false);
      return;
    }
    const cellW = editCellBoxSize?.width;
    if (cellW == null || !inputRef.current) {
      setCellEditorExtendRight(false);
      return;
    }
    const contentW = measureCellEditorContentWidth(inputRef.current);
    setCellEditorExtendRight(contentW + CELL_EDIT_INPUT_EXTRA_RIGHT_PX > cellW);
  }, [
    editorLayoutTick,
    context.luckysheetCellUpdate.length,
    editCellBoxSize?.width,
    context.zoomRatio,
  ]);

  const wraperGetCell = () => {
    const cell = getEditCellAddress();
    if (activeRefCell !== cell) {
      setActiveRefCell(cell);
    }
    // Prefer live address when picking on another sheet so the badge shows
    // `SheetName!A1` instead of the frozen same-sheet label from edit start.
    if (showCrossSheetAddressIndicator) {
      return cell;
    }
    return activeCell || cell;
  };

  const refreshCellFormulaRangeHighlights = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    setContext((draftCtx) => {
      if (draftCtx.luckysheetCellUpdate.length === 0) return;
      if (getFormulaEditorOwner(draftCtx) !== 'cell') return;
      if (!isAllowEdit(draftCtx, draftCtx.luckysheet_select_save)) return;
      const t = el.innerText ?? '';
      if (!startsWithFormula(t)) return;
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
    });
  }, [setContext]);

  useRerenderOnFormulaCaret(
    inputRef,
    context.luckysheetCellUpdate.length > 0,
    refreshCellFormulaRangeHighlights,
  );

  // Helper function to extract function name from input text
  const getFunctionNameFromInput = useCallback(() => {
    const inputText = normalizeFormulaGateText(
      inputRef?.current?.innerText || '',
    );
    const formulaText = inputText.trimStart();
    if (!startsWithFormula(formulaText)) return null;

    // Try to find function name pattern: =FUNCTIONNAME(
    const functionMatch = formulaText.match(/^=([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (functionMatch) {
      return functionMatch[1].toUpperCase();
    }

    // Also check if there's a function with class luckysheet-formula-text-func in the HTML
    if (inputRef?.current) {
      const funcSpan = inputRef.current.querySelector(
        '.luckysheet-formula-text-func',
      );
      if (funcSpan) {
        return funcSpan.textContent?.toUpperCase() || null;
      }
    }

    return null;
  }, []);

  // Prefer caret-on-span detection for nested calls (e.g. SUM(MIN( → MIN)), then core hint, then text parse.
  const functionName =
    getFunctionNameFromFormulaCaretSpans(inputRef.current) ??
    context.functionHint ??
    getFunctionNameFromInput();

  // Get function object using the detected function name
  const fn = functionName
    ? context.formulaCache.functionlistMap[functionName]
    : null;

  const showCellFormulaChrome =
    context.luckysheetCellUpdate.length > 0 &&
    getFormulaEditorOwner(context) === 'cell';

  useEffect(() => {
    if (!showCellFormulaChrome) return;
    const text = (inputRef.current?.innerText || '').replace(/\u200b/g, '');
    if (!/=|\(|[A-Za-z]/.test(text)) return;
  }, [
    showCellFormulaChrome,
    showSearchHint,
    functionName,
    fn,
    context.functionHint,
    context,
  ]);

  return (
    <div
      className="luckysheet-input-box"
      id="luckysheet-input-box"
      style={getInputBoxPosition()}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (!context.linkCard) return;
        setContext((draftCtx) => {
          draftCtx.linkCard = undefined;
        });
      }}
      onMouseUp={(e) => e.stopPropagation()}
    >
      {(!context.rangeDialog?.show && showAddressIndicator) && (
        <div
          className="luckysheet-cell-address-indicator"
          style={getAddressIndicatorPosition()}
        >
          {wraperGetCell()}
        </div>
      )}
      <div
        ref={inputBoxInnerRef}
        className="luckysheet-input-box-inner"
        onMouseDown={onInputBoxInnerMouseDown}
        style={
          editCellBoxSize
            ? {
                position: 'relative',
                minWidth: editCellBoxSize.width,
                minHeight: editCellBoxSize.height,
                ...inputBoxStyle,
                ...(cellEditorExtendRight
                  ? { paddingRight: 2 + CELL_EDIT_INPUT_EXTRA_RIGHT_PX }
                  : {}),
              }
            : { position: 'relative' }
        }
      >
        <ContentEditable
          onMouseDown={() => {
            // Mirror Fx editor behavior: preserve first click caret when switching
            // from Fx → cell by preventing immediate hydration from wiping selection.
            if (context.luckysheetCellUpdate.length === 0) {
              refs.globalCache.doNotUpdateCell = true;
            }
            const editor = inputRef.current;
            editor?.focus({ preventScroll: true });
            setContext((draftCtx) => {
              setFormulaEditorOwner(draftCtx, 'cell');
            });
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionUpdate={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={(e: React.CompositionEvent<HTMLInputElement>) => {
            if (e.data === '' && e.currentTarget.value === '') {
              isComposingRef.current = true;
              return;
            }
            ensureNotEmpty();
            isComposingRef.current = false;
            setEditorLayoutTick((t) => t + 1);
          }}
          onMouseUp={() => {
            handleHideShowHint();
            setContext((draftCtx) => {
              setFormulaEditorOwner(draftCtx, 'cell');
            });
            setShowSearchHint(
              shouldShowFormulaFunctionList(inputRef?.current ?? null),
            );
            if (!isComposingRef.current) {
              const currentCommaCount = countCommasBeforeCursor(
                inputRef?.current!,
              );
              setCommaCount(currentCommaCount);
            }

            const editor = inputRef.current;
            if (!editor) return;

            setContext((draftCtx) => {
              if (draftCtx.formulaCache.rangeSelectionActive !== true) return;

              const clickedInsideManagedRange =
                getFormulaRangeIndexAtCaret(editor) !== null;
              const atValidInsertionPoint =
                isCaretAtValidFormulaRangeInsertionPoint(editor);

              if (clickedInsideManagedRange || !atValidInsertionPoint) {
                markRangeSelectionDirty(draftCtx);
                // markRangeSelectionDirty clears overlays; rebuild so caret clicks
                // do not leave highlights blank until a second click (mouseup runs
                // after selectionchange and was wiping a just-refreshed highlight).
                if (editor.innerText?.trim().startsWith('=')) {
                  createRangeHightlight(draftCtx, editor.innerHTML);
                  rangeHightlightselected(draftCtx, editor);
                }
              }
            });
          }}
          innerRef={(e) => {
            inputRef.current = e;
            refs.cellInput.current = e;
          }}
          className="luckysheet-cell-input cell-input"
          id="luckysheet-rich-text-editor"
          style={{
            transform: `scale(${context.zoomRatio})`,
            transformOrigin: 'left top',
            width: `${100 / context.zoomRatio}%`,
            height: `${100 / context.zoomRatio}%`,
            color: 'inherit',
          }}
          aria-autocomplete="list"
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCopy={onCopy}
          onContextMenu={(e) => e.stopPropagation()}
          allowEdit={(edit ? !isHidenRC : edit) && !context.isFlvReadOnly}
        />
        {linkSelectionHighlightRects.length > 0 && (
          <div
            className="luckysheet-input-box-link-selection-highlight"
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
              pointerEvents: 'none',
            }}
          >
            {linkSelectionHighlightRects.map((r, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: r.left,
                  top: r.top,
                  width: r.width,
                  height: r.height,
                  backgroundColor: 'rgba(0, 123, 255, 0.25)',
                }}
              />
            ))}
          </div>
        )}
      </div>

      {!showSearchHint && <CellDatePicker />}

      {(context.functionCandidates.length > 0 ||
        context.functionHint ||
        context.defaultCandidates.length > 0 ||
        fn) &&
        showCellFormulaChrome && (
          <>
            {showSearchHint && (
              <FormulaSearch
                lockedTop={lockedFormulaSearchTop}
                onTopComputed={handleFormulaSearchTopComputed}
                onMouseMove={(e) => {
                  if (document.getElementById('luckysheet-formula-search-c')) {
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
            <div className="cell-hint">
              {showFormulaHint &&
                fn &&
                !showSearchHint &&
                !isFormulaCompleteAtCaret(inputRef.current) && (
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
                      fill="black"
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
    </div>
  );
};

export default InputBox;
