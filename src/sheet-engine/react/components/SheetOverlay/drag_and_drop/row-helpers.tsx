import { RefObject, useContext, useRef } from 'react';
import {
  fixPositionOnFrozenCells,
  getSheetIndex,
  rowLocation,
  getFlowdata,
  rowLocationByIndex,
  updateContextWithSheetData,
  api,
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

export const useRowDragAndDrop = (
  containerRef: RefObject<HTMLDivElement | null>,
  selectedLocationRef: RefObject<any[]>,
) => {
  const DOUBLE_MS = 300;
  const START_DRAG_THRESHOLD_PX = 6;
  const INSERTION_LINE_HEIGHT_PX = 2;
  /** Inset for row ghost/indicator vs. cell area width (kept in sync). */
  const GHOST_CELL_AREA_WIDTH_INSET_PX = 1;
  const clickRef = useRef({ lastTime: 0, lastRow: -1 });
  const { context, setContext, refs } = useContext(WorkbookContext);
  const selectedRowHeight = useRef(0);
  const selectedSourceRowRef = useRef<number[]>([]);
  const selectedTargetRowRef = useRef<number[]>([]);

  const dragRef = useRef({
    mouseDown: false,
    startY: 0,
    source: -1,
    active: false,
    lineEl: null as HTMLDivElement | null,
    ghostEl: null as HTMLDivElement | null,
    onDocMove: null as null | ((ev: MouseEvent) => void),
    onDocUp: null as null | ((ev: MouseEvent) => void),
    prevUserSelect: '' as string,
    prevWebkitUserSelect: '' as string,
    lastNativeEvent: null as MouseEvent | null,
    ghostHeightPx: 24,
    ghostCursorOffsetY: 0,
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
  const getRowIndexClicked = (pageY: number, headerEl: HTMLDivElement) => {
    const rect = headerEl.getBoundingClientRect();
    const mouseYInHeader = pageY - rect.top - window.scrollY;
    const localYInHeader = mouseYInHeader + headerEl.scrollTop;
    const freeze = refs.globalCache.freezen?.[context.currentSheetId];
    const { y: adjustedY } = fixPositionOnFrozenCells(
      freeze,
      0,
      localYInHeader,
      0,
      mouseYInHeader,
    );
    const [, , rowIndex] = rowLocation(adjustedY, context.visibledatarow);
    return rowIndex;
  };

  const isRowDoubleClicked = (clickedRowIndex: number) => {
    const now = performance.now();
    const isDoubleClicked =
      now - clickRef.current.lastTime < DOUBLE_MS &&
      clickRef.current.lastRow === clickedRowIndex;
    clickRef.current.lastTime = now;
    clickRef.current.lastRow = clickedRowIndex;
    return isDoubleClicked;
  };

  const computeInsertionFromPageY = (pageY: number) => {
    const workbookEl = containerRef.current;
    if (!workbookEl)
      return { insertionIndex: -1, lineTopPx: 0, mouseYInWorkbook: 0 };

    const wbRect = workbookEl.getBoundingClientRect();
    const mouseYInWorkbook = pageY - wbRect.top - window.scrollY;
    const localYInWorkbook =
      mouseYInWorkbook +
      (containerRef?.current?.scrollTop ?? context.scrollTop);

    const freeze = refs.globalCache.freezen?.[context.currentSheetId];
    const { y: yWorkbook } = fixPositionOnFrozenCells(
      freeze,
      0,
      localYInWorkbook,
      0,
      mouseYInWorkbook,
    );

    const [rowTopPx, rowBottomPx, hoveredRowIndex] = rowLocation(
      yWorkbook,
      context.visibledatarow,
    );

    const rowMidPx = (rowTopPx + rowBottomPx) / 2;
    let insertionIndex = hoveredRowIndex + (yWorkbook > rowMidPx ? 1 : 0);

    const sheetIdx = getSheetIndex(context, context.currentSheetId);
    const sheetLocal =
      sheetIdx == null ? null : context.luckysheetfile[sheetIdx];
    const maxRows = sheetLocal?.data?.length ?? context.visibledatarow.length;
    insertionIndex = Math.max(0, Math.min(maxRows, insertionIndex));

    const lineTopPx = yWorkbook > rowMidPx ? rowBottomPx : rowTopPx;
    return { insertionIndex, lineTopPx, mouseYInWorkbook };
  };

  const getHoveredRowIndexFromPageY = (pageY: number) => {
    const workbookEl = containerRef.current;
    if (!workbookEl) return -1;
    const wbRect = workbookEl.getBoundingClientRect();
    const mouseYInWorkbook = pageY - wbRect.top - window.scrollY;
    const localYInWorkbook =
      mouseYInWorkbook +
      (containerRef?.current?.scrollTop ?? context.scrollTop);
    const freeze = refs.globalCache.freezen?.[context.currentSheetId];
    const { y: yWorkbook } = fixPositionOnFrozenCells(
      freeze,
      0,
      localYInWorkbook,
      0,
      mouseYInWorkbook,
    );
    const [, , hoveredRowIndex] = rowLocation(
      yWorkbook,
      context.visibledatarow,
    );
    return hoveredRowIndex;
  };

  const isCursorInsideSelectedRows = (pageY: number) => {
    const hoveredRowIndex = getHoveredRowIndexFromPageY(pageY);
    const selectedRowRange = context.luckysheet_select_save?.[0]?.row;
    const start = selectedRowRange?.[0];
    const end = selectedRowRange?.[1];
    if (hoveredRowIndex < 0 || start == null || end == null) {
      return false;
    }
    return hoveredRowIndex >= start && hoveredRowIndex <= end;
  };

  const getSelectedTopBorderPx = () => {
    const selectedRowRange = context.luckysheet_select_save?.[0]?.row;
    const start = selectedRowRange?.[0];
    if (start == null || start < 0) return 0;
    const [topPx] = rowLocationByIndex(start, context.visibledatarow);
    return topPx;
  };
  /** Renders in `document.body`+`fixed` so the bar matches ghost width over the grid. */
  const createInsertionLine = () => {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.height = `${INSERTION_LINE_HEIGHT_PX}px`;
    el.style.width = '0px';
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
    lineTopPx: number,
    host: HTMLElement,
  ) => {
    const hr = host.getBoundingClientRect();
    const st = host.scrollTop ?? 0;
    const lineT = hr.top + (lineTopPx - st);
    if (line.parentNode !== document.body) {
      document.body.appendChild(line);
    }
    line.style.position = 'fixed';
    line.style.height = `${INSERTION_LINE_HEIGHT_PX}px`;
    line.style.right = 'auto';
    line.style.bottom = 'auto';
    const cellArea = refs.cellArea?.current;
    if (cellArea) {
      const r = cellArea.getBoundingClientRect();
      // Keep indicator aligned to the original row-header start X, not ghost start X.
      const w = Math.max(0, r.right - hr.left - GHOST_CELL_AREA_WIDTH_INSET_PX);
      line.style.top = `${lineT}px`;
      line.style.left = `${hr.left}px`;
      line.style.width = `${w}px`;
    } else {
      line.style.top = `${lineT}px`;
      line.style.left = `${hr.left}px`;
      line.style.width = `${Math.max(
        0,
        window.innerWidth - hr.left - GHOST_CELL_AREA_WIDTH_INSET_PX,
      )}px`;
    }
  };

  /** Row ghost must use `body`+`fixed`+cell-area bounds — row header is a sibling
   *  of the canvas, so a wide ghost in the header is painted under the grid. */
  const createGhost = () => {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.boxSizing = 'border-box';
    el.style.padding = '6px 8px';
    el.style.background = 'hsl(var(--color-text-secondary) / 0.18)';
    el.style.zIndex = '20000';
    el.style.pointerEvents = 'none';
    el.style.display = 'flex';
    el.style.flexDirection = 'row';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'flex-start';
    el.style.fontSize = '12px';
    el.style.fontWeight = '500';

    let ghostHeightPx = 24;
    let ghostLabel = `${dragRef.current.source + 1} row`;

    const selectedBlock = selectedLocationRef?.current?.find(
      (s) => s.r1 <= dragRef.current.source && dragRef.current.source <= s.r2,
    );

    if (selectedBlock) {
      ghostHeightPx = Math.max(
        24,
        selectedBlock.row - selectedBlock.row_pre - 1,
      );
      selectedRowHeight.current = ghostHeightPx;
      const count = selectedBlock.r2 - selectedBlock.r1 + 1;
      ghostLabel = count > 1 ? `${count} rows` : `${selectedBlock.r1 + 1} row`;
    } else {
      const [pre, end] = rowLocationByIndex(
        dragRef.current.source,
        context.visibledatarow,
      );
      const sourceRowHeight = end - pre - 1;
      ghostHeightPx = Math.max(24, sourceRowHeight);
      selectedRowHeight.current = ghostHeightPx;
    }

    el.style.height = `${ghostHeightPx}px`;
    el.textContent = ghostLabel;
    document.body.appendChild(el);
    return { el, ghostHeightPx };
  };

  const layoutGhostInViewport = (ghost: HTMLDivElement, ghostTopV: number) => {
    const cellArea = refs.cellArea?.current;
    if (cellArea) {
      const r = cellArea.getBoundingClientRect();
      const w = Math.max(0, r.width - GHOST_CELL_AREA_WIDTH_INSET_PX);
      ghost.style.left = `${r.left}px`;
      ghost.style.width = `${w}px`;
    } else {
      ghost.style.left = '0px';
      ghost.style.width = `${Math.max(0, window.innerWidth - GHOST_CELL_AREA_WIDTH_INSET_PX)}px`;
    }
    ghost.style.top = `${ghostTopV}px`;
  };

  const isDragActivated = (host: HTMLElement, pixelDeltaY: number) => {
    if (dragRef.current.active) return true;
    if (pixelDeltaY < START_DRAG_THRESHOLD_PX) return false;

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
    const { el, ghostHeightPx } = createGhost();
    dragRef.current.ghostEl = el;
    dragRef.current.ghostHeightPx = ghostHeightPx;
    const selectedTopPx = getSelectedTopBorderPx();
    const hr = host.getBoundingClientRect();
    const st = host.scrollTop ?? 0;
    const selectedTopV = hr.top + (selectedTopPx - st);
    const startCursorV = dragRef.current.startY - window.scrollY;
    dragRef.current.ghostCursorOffsetY = startCursorV - selectedTopV;
    if (dragRef.current.lineEl) {
      const { lineTopPx } = computeInsertionFromPageY(dragRef.current.startY);
      layoutInsertionLineInViewport(dragRef.current.lineEl, lineTopPx, host);
    }

    return true;
  };

  const handleRowDrag = (ev: MouseEvent) => {
    if (!dragRef.current.mouseDown) return;
    dragRef.current.lastNativeEvent = ev;

    const host = containerRef.current;
    if (!host) return;

    const dragOffset = Math.abs(ev.pageY - dragRef.current.startY);
    if (!isDragActivated(host, dragOffset)) return;

    const { lineTopPx } = computeInsertionFromPageY(ev.pageY);
    const cursorInsideSelection = isCursorInsideSelectedRows(ev.pageY);

    if (dragRef.current.lineEl) {
      const indicatorTopPx = cursorInsideSelection
        ? getSelectedTopBorderPx()
        : lineTopPx;
      layoutInsertionLineInViewport(
        dragRef.current.lineEl,
        indicatorTopPx,
        host,
      );
    }

    if (dragRef.current.ghostEl) {
      const cursorV = ev.pageY - window.scrollY;
      const ghostTopV = cursorV - dragRef.current.ghostCursorOffsetY;
      layoutGhostInViewport(dragRef.current.ghostEl, ghostTopV);
    }
  };

  const handleRowDragEnd = (ev: MouseEvent) => {
    if (!dragRef.current.mouseDown) return;
    dragRef.current.mouseDown = false;

    // restore selection
    try {
      document.body.style.userSelect = dragRef.current.prevUserSelect || '';
      (document.body.style as any).webkitUserSelect =
        dragRef.current.prevWebkitUserSelect || '';
    } catch {}

    const cursorInsideSelection = isCursorInsideSelectedRows(ev.pageY);
    if (dragRef.current.active && !cursorInsideSelection) {
      const { insertionIndex: finalInsertionIndex } = computeInsertionFromPageY(
        ev.pageY,
      );

      const sourceIndex = context.luckysheet_select_save?.[0]?.row?.[0] || 0;
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
          if (sourceIndex < 0 || sourceIndex >= rows.length) return;

          const selectedRowRange =
            context.luckysheet_select_save?.[0]?.row || [];
          const selectedStart = selectedRowRange?.[0];
          const selectedEnd = selectedRowRange?.[1];
          if (
            selectedStart == null ||
            selectedEnd == null ||
            selectedStart < 0 ||
            selectedEnd < selectedStart
          ) {
            return;
          }
          const moveCount = selectedEnd - selectedStart + 1;
          const selectedSourceRow: number[] = Array.from(
            { length: moveCount },
            (_, i) => selectedStart + i,
          );

          // Compute insertion point after removing selected block.
          let targetIndex = finalInsertionIndex;
          if (targetIndex > selectedEnd + 1) {
            targetIndex -= moveCount;
          }
          if (targetIndex < 0) targetIndex = 0;
          if (targetIndex > rows.length - moveCount)
            targetIndex = rows.length - moveCount;

          const selectedTargetRow: number[] = Array.from(
            { length: moveCount },
            (_, i) => targetIndex + i,
          );
          const affectedRowStart = Math.min(selectedStart, targetIndex);
          const affectedRowEnd =
            Math.max(selectedStart, targetIndex) + moveCount - 1;

          selectedSourceRowRef.current = selectedSourceRow;
          selectedTargetRowRef.current = selectedTargetRow;

          const numColsBeforeMove = rows[0]?.length ?? 0;
          const ydocBeforePersisted = snapshotPersistedCelldataInRange(
            rows,
            affectedRowStart,
            affectedRowEnd,
            0,
            Math.max(0, numColsBeforeMove - 1),
          );

          // Move selected row block in one splice pair, preserving relative order.
          const movedRows = rows.splice(selectedStart, moveCount);
          rows.splice(targetIndex, 0, ...movedRows);

          _sheet.data = rows;
          updateContextWithSheetData(draft, _sheet.data);

          const d = getFlowdata(draft);
          const rowMap = buildBlockMoveIndexMap(
            rows.length,
            selectedStart,
            moveCount,
            targetIndex,
          );

          const previousFormatRanges = _sheet.config?.cellFormatRanges;
          const nextFormatRanges = remapCellFormatRanges(
            previousFormatRanges,
            'row',
            rowMap,
          );
          const previousBorderInfo = _sheet.config?.borderInfo;
          const nextBorderInfo = previousBorderInfo?.length
            ? remapBorderInfo(previousBorderInfo, 'row', rowMap)
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

          // Keep row height metadata in sync with moved row data.
          if (_sheet.config) {
            const remapIndexMap = <T,>(
              mapObj?: Record<string, T> | Record<number, T>,
            ) => {
              if (!mapObj) return mapObj;
              const next: Record<number, T> = {};
              Object.keys(mapObj).forEach((k) => {
                const oldIdx = parseInt(k, 10);
                if (!Number.isFinite(oldIdx)) return;
                const newIdx = rowMap[oldIdx] != null ? rowMap[oldIdx] : oldIdx;
                next[newIdx] = (mapObj as any)[k];
              });
              return next;
            };
            _sheet.config.rowlen = remapIndexMap(_sheet.config.rowlen);
            _sheet.config.customHeight = remapIndexMap(
              _sheet.config.customHeight,
            );
            // calcRowColSize reads from ctx.config; keep it in sync with sheet config.
            draft.config.rowlen = _sheet.config.rowlen;
            draft.config.customHeight = _sheet.config.customHeight;
          }

          // Keep conditional formatting ranges aligned with moved rows.
          if (Array.isArray(_sheet.luckysheet_conditionformat_save)) {
            const remapConditionalFormatByRowMap = (rules: any[]): any[] => {
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
                  if (r2 < affectedRowStart || r1 > affectedRowEnd) {
                    remappedRanges.push({ row: [r1, r2], column: [c1, c2] });
                    return;
                  }
                  const mappedRows: number[] = [];
                  for (let r = r1; r <= r2; r += 1) {
                    mappedRows.push(rowMap[r] != null ? rowMap[r] : r);
                  }
                  mappedRows.sort((a, b) => a - b);
                  const segments = compressSorted(mappedRows);
                  segments.forEach(([s, e]) => {
                    remappedRanges.push({
                      row: [s, e],
                      column: [c1, c2],
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
              remapConditionalFormatByRowMap(
                _sheet.luckysheet_conditionformat_save,
              );
          }

          // Keep alternate-format ranges aligned with moved rows.
          if (Array.isArray(_sheet.luckysheet_alternateformat_save)) {
            const remapAlternateFormatByRowMap = (rules: any[]): any[] => {
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
                if (r2 < affectedRowStart || r1 > affectedRowEnd) {
                  remappedRules.push(rule);
                  return;
                }
                const mappedRows: number[] = [];
                for (let r = r1; r <= r2; r += 1) {
                  mappedRows.push(rowMap[r] != null ? rowMap[r] : r);
                }
                mappedRows.sort((a, b) => a - b);
                const segments = compressSorted(mappedRows);
                segments.forEach(([s, e]) => {
                  remappedRules.push({
                    ...rule,
                    cellrange: {
                      ...(rule.cellrange || {}),
                      row: [s, e],
                      column: [c1, c2],
                    },
                  });
                });
              });
              return remappedRules;
            };
            _sheet.luckysheet_alternateformat_save =
              remapAlternateFormatByRowMap(
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
                    { rowMap },
                  );
                }
              }
            });
          });

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
                { rowMap },
              );
            };
            Object.keys(_sheet.dataVerification).forEach((item) => {
              const itemData = _sheet.dataVerification?.[item];
              const colRow = item.split('_');
              if (colRow.length !== 2) return;
              const presentRow = parseInt(colRow[0], 10);
              const updatedRow =
                rowMap[presentRow] != null ? rowMap[presentRow] : presentRow;
              const nextItem = itemData ? { ...itemData } : itemData;
              if (nextItem) {
                nextItem.value1 = maybeRemapDvText(nextItem.value1);
                nextItem.value2 = maybeRemapDvText(nextItem.value2);
                nextItem.rangeTxt = maybeRemapDvText(nextItem.rangeTxt);
              }
              newDataVerification[`${updatedRow}_${colRow[1]}`] = nextItem;
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
              const presentRow = parseInt(parts[0], 10);
              const col = parts[1];
              const updatedRow =
                rowMap[presentRow] != null ? rowMap[presentRow] : presentRow;
              newHyperlink[`${updatedRow}_${col}`] = itemData;
            });
            _sheet.hyperlink = newHyperlink;
          }

          // Keep per-cell hyperlink marker metadata aligned with remapped hyperlink keys.
          const numColsAfterMove = rows[0]?.length ?? 0;
          for (
            let r = affectedRowStart;
            r <= affectedRowEnd && r < rows.length;
            r += 1
          ) {
            const row = rows[r];
            if (!row) continue;
            for (let c = 0; c < numColsAfterMove; c += 1) {
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

          // @ts-expect-error
          window?.updateDataBlockCalcFunctionAfterRowDrag?.(
            selectedStart,
            targetIndex,
            'row',
            context.currentSheetId,
          );

          // Sync sparse celldata for disturbed rows only (skip unchanged empty cells).
          emitCelldataRangeDiffToYdoc(
            draft,
            draft.currentSheetId,
            rows,
            affectedRowStart,
            affectedRowEnd,
            0,
            Math.max(0, (rows[0]?.length ?? 1) - 1),
            ydocBeforePersisted,
          );
          notifyCommentAnchorMove(draft, {
            type: 'row',
            sheetId: String(_sheet.id ?? draft.currentSheetId),
            sheetKeys: getSheetCommentKeyPrefixes(_sheet, sheetIdx),
            indexMap: rowMap,
          });
          const colLen = d?.[0]?.length || 0;
          const colEnd = Math.max(0, colLen - 1);
          api.setSelection(
            draft,
            [
              {
                row: [
                  selectedTargetRow[0],
                  selectedTargetRow[selectedTargetRow.length - 1],
                ],
                column: [0, colEnd],
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

  const initiateDrag = (clickedRowIndex: number, startY: number) => {
    dragRef.current.mouseDown = true;
    dragRef.current.startY = startY;
    dragRef.current.source = clickedRowIndex;
    dragRef.current.active = false;

    dragRef.current.onDocMove = handleRowDrag;
    dragRef.current.onDocUp = handleRowDragEnd;
    document.addEventListener('mousemove', handleRowDrag);
    document.addEventListener('mouseup', handleRowDragEnd);
  };

  return {
    initiateDrag,
    getRowIndexClicked,
    isRowDoubleClicked,
    mouseDown: dragRef.current.mouseDown,
  };
};
