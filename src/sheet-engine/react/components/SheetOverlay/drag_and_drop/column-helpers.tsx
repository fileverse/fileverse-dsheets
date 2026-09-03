import { RefObject, useContext, useRef } from 'react';
import {
  fixPositionOnFrozenCells,
  getSheetIndex,
  getFlowdata,
  colLocation,
  colLocationByIndex,
  updateContextWithSheetData,
  api,
  indexToColumnChar,
  execFunctionGroup,
  groupValuesRefresh,
  remapFormulaReferencesByMap,
  type HyperlinkEntry,
} from '@sheet-engine/core';
import WorkbookContext from '../../../context';
import {
  emitCelldataRangeDiffToYdoc,
  snapshotPersistedCelldataInRange,
} from '../../../../core/utils/ydoc-celldata-changes';
import {
  rangesEqual,
  remapCellFormatRanges,
} from '../../../../core/utils/range-format';
import { remapBorderInfo } from '../../../../core/utils/border-config-utils';
import {
  buildBlockMoveIndexMap,
  getSheetCommentKeyPrefixes,
  notifyCommentAnchorMove,
} from '../../../../core/utils/comment-anchor-move';

export function numberToColumnName(num: number): string {
  return indexToColumnChar(num);
}

export const useColumnDragAndDrop = (
  containerRef: RefObject<HTMLDivElement | null>,
  selectedLocationRef: RefObject<any[]>,
) => {
  const DOUBLE_CLICK_MS = 300;
  const START_DRAG_THRESHOLD_PX = 6;
  const INSERTION_LINE_WIDTH_PX = 2;
  /** Inset for column ghost/indicator vs. cell area height (kept in sync). */
  const GHOST_CELL_AREA_HEIGHT_INSET_PX = 11;
  const clickRef = useRef({ lastTime: 0, lastCol: -1 });
  const { context, setContext, refs } = useContext(WorkbookContext);
  const selectedColWidth = useRef(0);
  const selectedSourceColRef = useRef<number[]>([]);
  const selectedTargetColRef = useRef<number[]>([]);

  const dragRef = useRef({
    mouseDown: false,
    startX: 0,
    source: -1,
    active: false,
    lineEl: null as HTMLDivElement | null,
    ghostEl: null as HTMLDivElement | null,
    onDocMove: null as null | ((ev: MouseEvent) => void),
    onDocUp: null as null | ((ev: MouseEvent) => void),
    prevUserSelect: '' as string,
    prevWebkitUserSelect: '' as string,
    lastNativeEvent: null as MouseEvent | null,
    ghostWidthPx: 60,
    ghostCursorOffsetX: 0,
  });

  const removeDragLine = () => {
    const { lineEl, ghostEl } = dragRef.current;
    try {
      if (lineEl?.parentElement) lineEl.parentElement.removeChild(lineEl);
    } catch {}
    try {
      if (ghostEl?.parentElement) ghostEl.parentElement.removeChild(ghostEl);
    } catch {}
    dragRef.current.lineEl = null;
    dragRef.current.ghostEl = null;
    dragRef.current.active = false;
  };

  const getColIndexClicked = (pageX: number, headerEl: HTMLDivElement) => {
    const rect = headerEl.getBoundingClientRect();
    const mouseXInHeader = pageX - rect.left - window.scrollX;
    const localXInHeader = mouseXInHeader + headerEl.scrollLeft;
    const freeze = refs.globalCache.freezen?.[context.currentSheetId];
    const { x: adjustedX } = fixPositionOnFrozenCells(
      freeze,
      localXInHeader,
      0,
      mouseXInHeader,
      0,
    );
    const [, , colIndex] = colLocation(adjustedX, context.visibledatacolumn);
    return colIndex;
  };

  const isColDoubleClicked = (clickedColIndex: number) => {
    const now = performance.now();
    const isDoubleClicked =
      now - clickRef.current.lastTime < DOUBLE_CLICK_MS &&
      clickRef.current.lastCol === clickedColIndex;
    clickRef.current.lastTime = now;
    clickRef.current.lastCol = clickedColIndex;
    return isDoubleClicked;
  };

  const computeInsertionFromPageX = (pageX: number) => {
    const workbookEl = containerRef.current;
    if (!workbookEl)
      return { insertionIndex: -1, lineLeftPx: 0, mouseXInWorkbook: 0 };

    const wbRect = workbookEl.getBoundingClientRect();
    const mouseXInWorkbook = pageX - wbRect.left - window.scrollX;
    const localXInWorkbook =
      mouseXInWorkbook +
      (containerRef?.current?.scrollLeft ?? context.scrollLeft);

    const freeze = refs.globalCache.freezen?.[context.currentSheetId];
    const { x: xWorkbook } = fixPositionOnFrozenCells(
      freeze,
      localXInWorkbook,
      0,
      mouseXInWorkbook,
      0,
    );

    const [colLeftPx, colRightPx, hoveredColIndex] = colLocation(
      xWorkbook,
      context.visibledatacolumn,
    );

    const colMidPx = (colLeftPx + colRightPx) / 2;
    let insertionIndex = hoveredColIndex + (xWorkbook > colMidPx ? 1 : 0);

    const sheetIdx = getSheetIndex(context, context.currentSheetId);
    const sheetLocal =
      sheetIdx == null ? null : context.luckysheetfile[sheetIdx];
    const maxCols =
      sheetLocal?.data?.[0]?.length ?? context.visibledatacolumn.length;
    insertionIndex = Math.max(0, Math.min(maxCols, insertionIndex));

    const lineLeftPx = xWorkbook > colMidPx ? colRightPx : colLeftPx;
    return { insertionIndex, lineLeftPx, mouseXInWorkbook };
  };

  const getHoveredColIndexFromPageX = (pageX: number) => {
    const workbookEl = containerRef.current;
    if (!workbookEl) return -1;
    const wbRect = workbookEl.getBoundingClientRect();
    const mouseXInWorkbook = pageX - wbRect.left - window.scrollX;
    const localXInWorkbook =
      mouseXInWorkbook +
      (containerRef?.current?.scrollLeft ?? context.scrollLeft);
    const freeze = refs.globalCache.freezen?.[context.currentSheetId];
    const { x: xWorkbook } = fixPositionOnFrozenCells(
      freeze,
      localXInWorkbook,
      0,
      mouseXInWorkbook,
      0,
    );
    const [, , hoveredColIndex] = colLocation(
      xWorkbook,
      context.visibledatacolumn,
    );
    return hoveredColIndex;
  };

  const isCursorInsideSelectedColumns = (pageX: number) => {
    const hoveredColIndex = getHoveredColIndexFromPageX(pageX);
    const selectedColRange = context.luckysheet_select_save?.[0]?.column;
    const start = selectedColRange?.[0];
    const end = selectedColRange?.[1];
    if (hoveredColIndex < 0 || start == null || end == null) {
      return false;
    }
    return hoveredColIndex >= start && hoveredColIndex <= end;
  };

  const getSelectedLeftBorderPx = () => {
    const selectedColRange = context.luckysheet_select_save?.[0]?.column;
    const start = selectedColRange?.[0];
    if (start == null || start < 0) return 0;
    const [leftPx] = colLocationByIndex(start, context.visibledatacolumn);
    return leftPx;
  };

  /** Renders in `document.body`+`fixed` so the bar matches ghost height over the grid. */
  const createInsertionLine = () => {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.width = `${INSERTION_LINE_WIDTH_PX}px`;
    el.style.height = '0px';
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.background = 'hsl(var(--color-text-secondary))';
    el.style.zIndex = '9999';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
    return el;
  };

  const layoutInsertionLineInViewport = (
    line: HTMLDivElement,
    lineLeftPx: number,
    host: HTMLElement,
  ) => {
    const hr = host.getBoundingClientRect();
    const sc = host.scrollLeft ?? 0;
    const lineV = hr.left + (lineLeftPx - sc);
    if (line.parentNode !== document.body) {
      document.body.appendChild(line);
    }
    line.style.position = 'fixed';
    line.style.width = `${INSERTION_LINE_WIDTH_PX}px`;
    line.style.bottom = 'auto';
    line.style.right = 'auto';
    const cellArea = refs.cellArea?.current;
    if (cellArea) {
      const r = cellArea.getBoundingClientRect();
      const h = Math.max(0, r.height - GHOST_CELL_AREA_HEIGHT_INSET_PX);
      line.style.left = `${lineV}px`;
      line.style.top = `${hr.top}px`;
      line.style.height = `${h}px`;
    } else {
      line.style.left = `${lineV}px`;
      line.style.top = `${hr.top}px`;
      line.style.height = `${Math.max(0, window.innerHeight - GHOST_CELL_AREA_HEIGHT_INSET_PX)}px`;
    }
  };

  /** Full-height column ghost: must be under `body`+`fixed` — if it stays in the
   *  column header, `fortune-cell-area` (canvas) paints on top and hides overflow. */
  const createGhost = () => {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.boxSizing = 'border-box';
    el.style.padding = '6px 8px';
    el.style.background = 'hsl(var(--color-text-secondary) / 0.18)';
    el.style.zIndex = '20000';
    el.style.pointerEvents = 'none';
    el.style.display = 'flex';
    el.style.alignItems = 'start';
    el.style.justifyContent = 'center';
    el.style.fontSize = '12px';
    el.style.fontWeight = '500';

    let ghostWidthPx = 60;
    let ghostLabel = `Col ${String.fromCharCode(65 + dragRef.current.source)}`;

    const selectedBlock = selectedLocationRef?.current?.find(
      (s) => s.c1 <= dragRef.current.source && dragRef.current.source <= s.c2,
    );

    if (selectedBlock) {
      ghostWidthPx = Math.max(
        60,
        selectedBlock.col - selectedBlock.col_pre - 1,
      );
      selectedColWidth.current = ghostWidthPx;
      const count = selectedBlock.c2 - selectedBlock.c1 + 1;
      ghostLabel =
        count > 1
          ? `${count} cols`
          : `Col ${String.fromCharCode(65 + selectedBlock.c1)}`;
    } else {
      const [pre, end] = colLocationByIndex(
        dragRef.current.source,
        context.visibledatacolumn,
      );
      const sourceColWidth = end - pre - 1;
      ghostWidthPx = Math.max(60, sourceColWidth);
      selectedColWidth.current = ghostWidthPx;
    }

    el.style.width = `${ghostWidthPx}px`;
    el.textContent = ghostLabel;
    document.body.appendChild(el);
    return { el, ghostWidthPx };
  };

  const layoutGhostInViewport = (ghost: HTMLDivElement, ghostLeftV: number) => {
    const cellArea = refs.cellArea?.current;
    if (cellArea) {
      const r = cellArea.getBoundingClientRect();
      const h = Math.max(0, r.height - GHOST_CELL_AREA_HEIGHT_INSET_PX);
      ghost.style.top = `${r.top}px`;
      ghost.style.height = `${h}px`;
    } else {
      ghost.style.top = '0px';
      ghost.style.height = `${Math.max(0, window.innerHeight - GHOST_CELL_AREA_HEIGHT_INSET_PX)}px`;
    }
    ghost.style.left = `${ghostLeftV}px`;
  };

  const isDragActivated = (host: HTMLElement, pixelDeltaX: number) => {
    if (dragRef.current.active) return true;
    if (pixelDeltaX < START_DRAG_THRESHOLD_PX) return false;

    dragRef.current.active = true;

    // disable text selection
    dragRef.current.prevUserSelect = document.body.style.userSelect;
    dragRef.current.prevWebkitUserSelect = (
      document.body.style as any
    ).webkitUserSelect;
    document.body.style.userSelect = 'none';
    (document.body.style as any).webkitUserSelect = 'none';

    // visuals
    dragRef.current.lineEl = createInsertionLine();
    const { el, ghostWidthPx } = createGhost();
    dragRef.current.ghostEl = el;
    dragRef.current.ghostWidthPx = ghostWidthPx;
    const selectedLeftPx = getSelectedLeftBorderPx();
    const hr = host.getBoundingClientRect();
    const sc = host.scrollLeft ?? 0;
    const selectedLeftV = hr.left + (selectedLeftPx - sc);
    const startCursorV = dragRef.current.startX - window.scrollX;
    dragRef.current.ghostCursorOffsetX = startCursorV - selectedLeftV;
    if (dragRef.current.lineEl) {
      const { lineLeftPx } = computeInsertionFromPageX(dragRef.current.startX);
      layoutInsertionLineInViewport(dragRef.current.lineEl, lineLeftPx, host);
    }

    return true;
  };

  const handleColumnDrag = (ev: MouseEvent) => {
    if (!dragRef.current.mouseDown) return;
    dragRef.current.lastNativeEvent = ev;

    const host = containerRef.current;
    if (!host) return;

    const dragOffset = Math.abs(ev.pageX - dragRef.current.startX);
    if (!isDragActivated(host, dragOffset)) return;

    const { lineLeftPx } = computeInsertionFromPageX(ev.pageX);
    const cursorInsideSelection = isCursorInsideSelectedColumns(ev.pageX);

    if (dragRef.current.lineEl) {
      const indicatorLeftPx = cursorInsideSelection
        ? getSelectedLeftBorderPx()
        : lineLeftPx;
      layoutInsertionLineInViewport(
        dragRef.current.lineEl,
        indicatorLeftPx,
        host,
      );
    }

    if (dragRef.current.ghostEl) {
      const cursorV = ev.pageX - window.scrollX;
      const ghostLeftV = cursorV - dragRef.current.ghostCursorOffsetX;
      layoutGhostInViewport(dragRef.current.ghostEl, ghostLeftV);
    }
  };

  const handleColumnDragEnd = (ev: MouseEvent) => {
    if (!dragRef.current.mouseDown) return;
    dragRef.current.mouseDown = false;

    // restore selection
    try {
      document.body.style.userSelect = dragRef.current.prevUserSelect || '';
      (document.body.style as any).webkitUserSelect =
        dragRef.current.prevWebkitUserSelect || '';
    } catch {}

    const cursorInsideSelection = isCursorInsideSelectedColumns(ev.pageX);
    if (dragRef.current.active && !cursorInsideSelection) {
      const { insertionIndex: finalInsertionIndex } = computeInsertionFromPageX(
        ev.pageX,
      );

      const sourceIndex = context.luckysheet_select_save?.[0]?.column?.[0] || 0;
      const sheetIdx = getSheetIndex(context, context.currentSheetId);

      if (
        sheetIdx != null &&
        sourceIndex >= 0 &&
        Number.isFinite(finalInsertionIndex) &&
        finalInsertionIndex >= 0
      ) {
        setContext((draft) => {
          const _sheet = draft.luckysheetfile[sheetIdx];
          if (!_sheet?.data) return;
          const rows = _sheet.data;
          if (rows.length === 0) return;

          const numCols = rows[0]?.length ?? 0;
          if (sourceIndex < 0 || sourceIndex >= numCols) return;

          const selectedColRange =
            context.luckysheet_select_save?.[0]?.column || [];
          const selectedStart = selectedColRange?.[0];
          const selectedEnd = selectedColRange?.[1];
          if (
            selectedStart == null ||
            selectedEnd == null ||
            selectedStart < 0 ||
            selectedEnd < selectedStart
          ) {
            return;
          }
          const moveCount = selectedEnd - selectedStart + 1;
          const selectedSourceCol: number[] = Array.from(
            { length: moveCount },
            (_, i) => selectedStart + i,
          );

          // Compute insertion point after removing selected block.
          let targetIndex = finalInsertionIndex;
          if (targetIndex > selectedEnd + 1) {
            targetIndex -= moveCount;
          }
          if (targetIndex < 0) targetIndex = 0;
          if (targetIndex > numCols - moveCount)
            targetIndex = numCols - moveCount;

          const selectedTargetCol: number[] = Array.from(
            { length: moveCount },
            (_, i) => targetIndex + i,
          );
          const affectedColStart = Math.min(selectedStart, targetIndex);
          const affectedColEnd =
            Math.max(selectedStart, targetIndex) + moveCount - 1;

          selectedSourceColRef.current = selectedSourceCol;
          selectedTargetColRef.current = selectedTargetCol;

          const numRowsBeforeMove = rows.length;
          const ydocBeforePersisted = snapshotPersistedCelldataInRange(
            rows,
            0,
            Math.max(0, numRowsBeforeMove - 1),
            affectedColStart,
            affectedColEnd,
          );

          // Move selected column block in each row, preserving relative order.
          for (let j = 0; j < rows.length; j += 1) {
            const row = rows[j];
            if (!row || selectedStart >= row.length) continue;
            const moved = row.splice(selectedStart, moveCount);
            row.splice(targetIndex, 0, ...moved);
          }

          _sheet.data = rows;
          updateContextWithSheetData(draft, _sheet.data);

          // update formula
          const d = getFlowdata(draft);
          const colMap = buildBlockMoveIndexMap(
            rows[0]?.length ?? 0,
            selectedStart,
            moveCount,
            targetIndex,
          );

          const previousFormatRanges = _sheet.config?.cellFormatRanges;
          const nextFormatRanges = remapCellFormatRanges(
            previousFormatRanges,
            'column',
            colMap,
          );
          const previousBorderInfo = _sheet.config?.borderInfo;
          const nextBorderInfo = previousBorderInfo?.length
            ? remapBorderInfo(previousBorderInfo, 'column', colMap)
            : previousBorderInfo;

          const ydocConfigChanges: {
            sheetId: string;
            path: string[];
            value: unknown;
            type: 'update';
          }[] = [];

          if (!rangesEqual(previousFormatRanges, nextFormatRanges)) {
            _sheet.config ||= {};
            _sheet.config.cellFormatRanges = nextFormatRanges;
            ydocConfigChanges.push({
              sheetId: draft.currentSheetId,
              path: ['config', 'cellFormatRanges'],
              value: nextFormatRanges,
              type: 'update',
            });
          }

          if (previousBorderInfo?.length) {
            _sheet.config ||= {};
            _sheet.config.borderInfo = nextBorderInfo;
            draft.config.borderInfo = nextBorderInfo;
            ydocConfigChanges.push({
              sheetId: draft.currentSheetId,
              path: ['config', 'borderInfo'],
              value: nextBorderInfo ?? [],
              type: 'update',
            });
          }

          if (ydocConfigChanges.length > 0) {
            draft.hooks?.updateCellYdoc?.(ydocConfigChanges);
          }

          // Keep column width metadata in sync with moved column data.
          if (_sheet.config) {
            const remapIndexMap = <T,>(
              mapObj?: Record<string, T> | Record<number, T>,
            ) => {
              if (!mapObj) return mapObj;
              const next: Record<number, T> = {};
              Object.keys(mapObj).forEach((k) => {
                const oldIdx = parseInt(k, 10);
                if (!Number.isFinite(oldIdx)) return;
                const newIdx = colMap[oldIdx] != null ? colMap[oldIdx] : oldIdx;
                next[newIdx] = (mapObj as any)[k];
              });
              return next;
            };
            _sheet.config.columnlen = remapIndexMap(_sheet.config.columnlen);
            _sheet.config.customWidth = remapIndexMap(
              _sheet.config.customWidth,
            );
            // calcRowColSize reads from ctx.config; keep it in sync with sheet config.
            draft.config.columnlen = _sheet.config.columnlen;
            draft.config.customWidth = _sheet.config.customWidth;
          }

          // Keep conditional formatting ranges aligned with moved columns.
          if (Array.isArray(_sheet.luckysheet_conditionformat_save)) {
            const remapConditionalFormatByColMap = (rules: any[]): any[] => {
              const toNumberRange = (v: any): [number, number] | null => {
                if (!Array.isArray(v) || v.length !== 2) return null;
                const a = Number(v[0]);
                const b = Number(v[1]);
                if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
                return a <= b ? [a, b] : [b, a];
              };
              const compressSorted = (arr: number[]) => {
                const segments: Array<[number, number]> = [];
                if (arr.length === 0) return segments;
                let start = arr[0];
                let prev = arr[0];
                for (let i = 1; i < arr.length; i += 1) {
                  const cur = arr[i];
                  if (cur === prev || cur === prev + 1) {
                    prev = cur;
                    continue;
                  }
                  segments.push([start, prev]);
                  start = cur;
                  prev = cur;
                }
                segments.push([start, prev]);
                return segments;
              };

              return rules.map((rule) => {
                const ranges = Array.isArray(rule?.cellrange)
                  ? rule.cellrange
                  : [];
                const remappedRanges: any[] = [];
                ranges.forEach((range: any) => {
                  const rowR = toNumberRange(range?.row);
                  const colR = toNumberRange(range?.column);
                  if (!rowR || !colR) return;
                  const [r1, r2] = rowR;
                  const [c1, c2] = colR;
                  if (c2 < affectedColStart || c1 > affectedColEnd) {
                    remappedRanges.push({ row: [r1, r2], column: [c1, c2] });
                    return;
                  }
                  const mappedCols: number[] = [];
                  for (let c = c1; c <= c2; c += 1) {
                    mappedCols.push(colMap[c] != null ? colMap[c] : c);
                  }
                  mappedCols.sort((a, b) => a - b);
                  const segments = compressSorted(mappedCols);
                  segments.forEach(([s, e]) => {
                    remappedRanges.push({
                      row: [r1, r2],
                      column: [s, e],
                    });
                  });
                });
                return {
                  ...rule,
                  cellrange: remappedRanges,
                };
              });
            };
            _sheet.luckysheet_conditionformat_save =
              remapConditionalFormatByColMap(
                _sheet.luckysheet_conditionformat_save,
              );
          }

          // Keep alternate-format ranges aligned with moved columns.
          if (Array.isArray(_sheet.luckysheet_alternateformat_save)) {
            const remapAlternateFormatByColMap = (rules: any[]): any[] => {
              const toNumberRange = (v: any): [number, number] | null => {
                if (!Array.isArray(v) || v.length !== 2) return null;
                const a = Number(v[0]);
                const b = Number(v[1]);
                if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
                return a <= b ? [a, b] : [b, a];
              };
              const compressSorted = (arr: number[]) => {
                const segments: Array<[number, number]> = [];
                if (arr.length === 0) return segments;
                let start = arr[0];
                let prev = arr[0];
                for (let i = 1; i < arr.length; i += 1) {
                  const cur = arr[i];
                  if (cur === prev || cur === prev + 1) {
                    prev = cur;
                    continue;
                  }
                  segments.push([start, prev]);
                  start = cur;
                  prev = cur;
                }
                segments.push([start, prev]);
                return segments;
              };

              const remappedRules: any[] = [];
              rules.forEach((rule) => {
                const rowR = toNumberRange(rule?.cellrange?.row);
                const colR = toNumberRange(rule?.cellrange?.column);
                if (!rowR || !colR) {
                  remappedRules.push(rule);
                  return;
                }
                const [r1, r2] = rowR;
                const [c1, c2] = colR;
                if (c2 < affectedColStart || c1 > affectedColEnd) {
                  remappedRules.push(rule);
                  return;
                }
                const mappedCols: number[] = [];
                for (let c = c1; c <= c2; c += 1) {
                  mappedCols.push(colMap[c] != null ? colMap[c] : c);
                }
                mappedCols.sort((a, b) => a - b);
                const segments = compressSorted(mappedCols);
                segments.forEach(([s, e]) => {
                  remappedRules.push({
                    ...rule,
                    cellrange: {
                      ...(rule.cellrange || {}),
                      row: [r1, r2],
                      column: [s, e],
                    },
                  });
                });
              });
              return remappedRules;
            };
            _sheet.luckysheet_alternateformat_save =
              remapAlternateFormatByColMap(
                _sheet.luckysheet_alternateformat_save,
              );
          }

          d?.forEach((row) => {
            row.forEach((cell) => {
              if (cell) {
                if (cell.f) {
                  const sheetName = _sheet.name || '';
                  cell.f = remapFormulaReferencesByMap(
                    cell.f,
                    sheetName,
                    sheetName,
                    { colMap },
                  );
                }
              }
            });
          });

          // update dataVerification
          if (_sheet.dataVerification) {
            const newDataVerification: any = {};
            const maybeRemapDvText = (text: any) => {
              if (typeof text !== 'string') return text;
              // Fast path: skip strings that can't contain A1 refs.
              if (!/[A-Za-z]+\d/.test(text)) return text;
              return remapFormulaReferencesByMap(
                text,
                _sheet.name || '',
                _sheet.name || '',
                { colMap },
              );
            };
            Object.keys(_sheet.dataVerification).forEach((item) => {
              const itemData = _sheet.dataVerification?.[item];
              const colRow = item.split('_');
              if (colRow.length !== 2) return;
              const presentcol = parseInt(colRow[1], 10);
              const updatedCol =
                colMap[presentcol] != null ? colMap[presentcol] : presentcol;
              const nextItem = itemData ? { ...itemData } : itemData;
              if (nextItem) {
                nextItem.value1 = maybeRemapDvText(nextItem.value1);
                nextItem.value2 = maybeRemapDvText(nextItem.value2);
                nextItem.rangeTxt = maybeRemapDvText(nextItem.rangeTxt);
              }
              newDataVerification[`${colRow[0]}_${updatedCol}`] = nextItem;
            });
            _sheet.dataVerification = newDataVerification;
          }

          if (_sheet.hyperlink) {
            const newHyperlink: Record<
              string,
              HyperlinkEntry | HyperlinkEntry[]
            > = {};
            Object.keys(_sheet.hyperlink).forEach((key) => {
              const itemData = _sheet.hyperlink?.[key];
              if (!itemData) return;
              const parts = key.split('_');
              if (parts.length !== 2) return;
              const row = parts[0];
              const presentCol = parseInt(parts[1], 10);
              const updatedCol =
                colMap[presentCol] != null ? colMap[presentCol] : presentCol;
              newHyperlink[`${row}_${updatedCol}`] = itemData;
            });
            _sheet.hyperlink = newHyperlink;
          }

          // Keep per-cell hyperlink marker metadata aligned with remapped hyperlink keys.
          const numColsAfterMove = rows[0]?.length ?? 0;
          for (let r = 0; r < rows.length; r += 1) {
            const row = rows[r];
            if (!row) continue;
            for (
              let c = affectedColStart;
              c <= affectedColEnd && c < numColsAfterMove;
              c += 1
            ) {
              const cell = row[c];
              if (!cell) continue;
              const hasHyperlink = !!_sheet.hyperlink?.[`${r}_${c}`];
              if (hasHyperlink) {
                cell.hl = { r, c, id: context.currentSheetId };
              } else if (cell.hl) {
                delete cell.hl;
              }
            }
          }

          // Host-owned comment keys (`${sheetId}_${row}_${col}`) do not move
          // with the splice. Notify after celldata is written to ydoc so the
          // portal persist is not a half-update (old cells + new anchors).
          draft.commentBoxes = [];
          draft.hoveredCommentBox = undefined;
          draft.editingCommentBox = undefined;

          // Rebuild calc chain from actual formula cells so recalc always
          // includes every formula after structural drag.
          const rebuiltCalcChain: { r: number; c: number; id: string }[] = [];
          for (let r = 0; r < rows.length; r += 1) {
            const row = rows[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c += 1) {
              if (row[c]?.f) {
                rebuiltCalcChain.push({ r, c, id: context.currentSheetId });
              }
            }
          }
          _sheet.calcChain = rebuiltCalcChain as any;

          // Structural drag rewrites many formula refs; refresh dependency graph
          // to avoid stale edges causing false circular-dependency errors.
          const touchedFormulaCells: { r: number; c: number; i: string }[] = [];
          for (let r = 0; r < rows.length; r += 1) {
            const row = rows[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c += 1) {
              if (row[c]?.f) {
                touchedFormulaCells.push({ r, c, i: context.currentSheetId });
              }
            }
          }
          if (touchedFormulaCells.length > 0) {
            draft.formulaCache.depsByCell = new Map();
            draft.formulaCache.revDepsByCell = new Map();
            draft.formulaCache.execFunctionExist = touchedFormulaCells as any;
            (execFunctionGroup as any)(
              draft,
              null,
              null,
              null,
              null,
              getFlowdata(draft),
              true,
            );
            groupValuesRefresh(draft);
            draft.formulaCache.execFunctionExist = undefined;
          }

          // update data block
          // @ts-expect-error
          window?.updateDataBlockCalcFunctionAfterRowDrag?.(
            selectedSourceCol,
            selectedTargetCol,
            'column',
            context.currentSheetId,
            selectedStart,
            targetIndex,
          );

          // Sync sparse celldata for disturbed columns only (skip unchanged empty cells).
          emitCelldataRangeDiffToYdoc(
            draft,
            draft.currentSheetId,
            rows,
            0,
            Math.max(0, rows.length - 1),
            affectedColStart,
            affectedColEnd,
            ydocBeforePersisted,
          );
          notifyCommentAnchorMove(draft, {
            type: 'column',
            sheetId: String(_sheet.id ?? draft.currentSheetId),
            sheetKeys: getSheetCommentKeyPrefixes(_sheet, sheetIdx),
            indexMap: colMap,
          });
          const rowLen = d?.length || 0;
          const rowEnd = Math.max(0, rowLen - 1);
          api.setSelection(
            draft,
            [
              {
                row: [0, rowEnd],
                column: [
                  selectedTargetCol?.[0],
                  selectedTargetCol?.[selectedTargetCol.length - 1],
                ],
              },
            ],
            {
              id: context.currentSheetId,
            },
          );
        });
      }
    }

    // cleanup
    removeDragLine();
    dragRef.current.active = false;
    dragRef.current.source = -1;

    if (dragRef.current.onDocMove)
      document.removeEventListener('mousemove', dragRef.current.onDocMove);
    if (dragRef.current.onDocUp)
      document.removeEventListener('mouseup', dragRef.current.onDocUp);
    dragRef.current.onDocMove = null;
    dragRef.current.onDocUp = null;
  };

  const initiateDrag = (clickedColIndex: number, startX: number) => {
    dragRef.current.mouseDown = true;
    dragRef.current.startX = startX;
    dragRef.current.source = clickedColIndex;
    dragRef.current.active = false;

    dragRef.current.onDocMove = handleColumnDrag;
    dragRef.current.onDocUp = handleColumnDragEnd;
    document.addEventListener('mousemove', handleColumnDrag);
    document.addEventListener('mouseup', handleColumnDragEnd);
  };

  return {
    initiateDrag,
    getColIndexClicked,
    isColDoubleClicked,
    mouseDown: dragRef.current.mouseDown,
  };
};
