import {
  rowLocation,
  rowLocationByIndex,
  selectTitlesMap,
  selectTitlesRange,
  handleContextMenu,
  handleRowHeaderMouseDown,
  handleRowSizeHandleMouseDown,
  fixRowStyleOverflowInFreeze,
  handleRowFreezeHandleMouseDown,
  getSheetIndex,
  showSelected,
  fixPositionOnFrozenCells,
  getFlowdata,
  api,
  getFilterHiddenRowsUnion,
} from '@sheet-engine/core';
import _ from 'lodash';
import React, {
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from 'react';
import WorkbookContext from '../../context';
import { useRowDragAndDrop } from './drag_and_drop/row-helpers';
import { getActiveTheme } from '@sheet-engine/core/theme';

const DARK_THEMES = ['dark', 'theme-green'];

type HoverLoc = { row: number; row_pre: number; row_index: number };
type SelectedLoc = { row: number; row_pre: number; r1: number; r2: number };
type HiddenPointer = { row: string; top: number };

const RowHeader: React.FC = () => {
  const { context, setContext, settings, refs } = useContext(WorkbookContext);
  const rowChangeSizeRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [hoverLocation, setHoverLocation] = useState<HoverLoc>({
    row: -1,
    row_pre: -1,
    row_index: -1,
  });
  const [hoverInFreeze, setHoverInFreeze] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<SelectedLoc[]>([]);

  const sheetIndex = getSheetIndex(context, context.currentSheetId);
  const sheet = sheetIndex == null ? null : context.luckysheetfile[sheetIndex];

  // `row_select` is the reliable signal for "entire row(s)" selection.
  // Cmd/Ctrl+A sets both `row_select` and `column_select` to true.
  const isEntireRowSelection = !!context.luckysheet_select_save?.some(
    (sel) => !!sel?.row_select,
  );

  // Manual-hidden rows only: do not show "unhide" pointers for filter-hidden rows.
  const manualRowHidden = useMemo(() => {
    if (sheetIndex == null) return null;
    const cfg = context.luckysheetfile[sheetIndex]?.config || context.config;
    if (cfg?.rowhidden_manual != null) return cfg.rowhidden_manual;
    const union = (cfg?.rowhidden || {}) as Record<string, number>;
    const filterActive =
      !_.isNil(context.luckysheet_filter_save) && !_.isEmpty(context.filter);
    if (!filterActive) return union;
    const filterUnion = getFilterHiddenRowsUnion(context);
    return _.omit(union, _.keys(filterUnion));
  }, [
    sheetIndex,
    context.currentSheetId,
    context.config,
    context.luckysheetfile,
    context.luckysheet_filter_save,
    context.filter,
  ]);

  const freezeHandleTop = useMemo(() => {
    if (
      sheet?.frozen?.type === 'row' ||
      sheet?.frozen?.type === 'rangeRow' ||
      sheet?.frozen?.type === 'rangeBoth' ||
      sheet?.frozen?.type === 'both'
    ) {
      return (
        rowLocationByIndex(
          sheet?.frozen?.range?.row_focus || 0,
          context.visibledatarow,
        )[1] + context.scrollTop
      );
    }
    return context.scrollTop;
  }, [context.visibledatarow, sheet?.frozen, context.scrollTop]);

  const selectedLocationRef = useRef(selectedLocation);
  useEffect(() => {
    selectedLocationRef.current = selectedLocation;
  }, [selectedLocation]);

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      if (context.luckysheet_rows_change_size) return;

      const container = containerRef.current;
      if (!container) return;

      const mouseY =
        e.pageY - container.getBoundingClientRect().top - window.scrollY;
      const _y = mouseY + container.scrollTop;
      const freeze = refs.globalCache.freezen?.[context.currentSheetId];
      const { y, inHorizontalFreeze } = fixPositionOnFrozenCells(
        freeze,
        0,
        _y,
        0,
        mouseY,
      );
      const [row_pre, row, row_index] = rowLocation(y, context.visibledatarow);
      if (row_pre !== hoverLocation.row_pre || row !== hoverLocation.row) {
        setHoverLocation({ row_pre, row, row_index });
        setHoverInFreeze(inHorizontalFreeze);
      }
    },
    [
      context.luckysheet_rows_change_size,
      context.visibledatarow,
      hoverLocation.row,
      hoverLocation.row_pre,
      refs.globalCache.freezen,
      context.currentSheetId,
    ],
  );

  const { initiateDrag, getRowIndexClicked, isRowDoubleClicked, mouseDown } =
    useRowDragAndDrop(containerRef, selectedLocationRef);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      // @ts-expect-error: `e.target` is not strongly typed as an SVGElement here.
      if ((e.button === 0 && e.target.tagName === 'use') || e.button === 2) {
        const { nativeEvent } = e;
        setContext((draft) => {
          handleRowHeaderMouseDown(
            draft,
            refs.globalCache,
            nativeEvent,
            containerRef.current!,
            refs.cellInput.current!,
            refs.fxInput.current!,
          );
        });
      }
      if (e.button !== 0) return; // left button only
      const targetEl = e.target as HTMLElement;
      if (
        targetEl.closest('.fortune-rows-change-size') ||
        targetEl.closest('.fortune-rows-freeze-handle')
      )
        return;

      const headerEl = containerRef.current;
      if (!headerEl) return;

      const clickedRowIndex = getRowIndexClicked(e.pageY, headerEl);
      if (clickedRowIndex < 0) return;

      const sel = context.luckysheet_select_save;
      const lastSelectedCol = sel?.[0]?.column?.[1];
      let data = getFlowdata(context);
      if (!data) data = [];

      const allRowSel = lastSelectedCol === data?.[0]?.length - 1;

      if (allRowSel) {
        setContext((draft) => {
          draft.luckysheet_scroll_status = true;
        });
      }
      if (
        e.shiftKey ||
        !allRowSel ||
        (allRowSel && sel && clickedRowIndex < sel?.[0].row[0]) ||
        // @ts-expect-error: `sel?.[0].row` may be missing in some selection shapes.
        clickedRowIndex > sel?.[0].row[1]
      ) {
        const { nativeEvent } = e;
        setContext((draft) => {
          handleRowHeaderMouseDown(
            draft,
            refs.globalCache,
            nativeEvent,
            containerRef.current!,
            refs.cellInput.current!,
            refs.fxInput.current!,
          );
        });
        return;
      }

      if (context.isFlvReadOnly) {
        const { nativeEvent } = e;
        setContext((draft) => {
          handleRowHeaderMouseDown(
            draft,
            refs.globalCache,
            nativeEvent,
            containerRef.current!,
            refs.cellInput.current!,
            refs.fxInput.current!,
          );
        });
        return;
      }

      // handle drag and drop
      e.preventDefault();
      e.stopPropagation();
      initiateDrag(clickedRowIndex, e.pageY);
    },
    [
      refs.globalCache,
      context.visibledatarow,
      context.currentSheetId,
      context.luckysheet_select_save,
      context.isFlvReadOnly,
      setContext,
      getRowIndexClicked,
      isRowDoubleClicked,
      initiateDrag,
    ],
  );

  const onMouseLeave = useCallback(() => {
    if (context.luckysheet_rows_change_size) return;
    setHoverLocation({ row: -1, row_pre: -1, row_index: -1 });
  }, [context.luckysheet_rows_change_size]);

  const onRowSizeHandleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      const { nativeEvent } = e;
      setContext((draftCtx) => {
        handleRowSizeHandleMouseDown(
          draftCtx,
          refs.globalCache,
          nativeEvent,
          containerRef.current!,
          refs.workbookContainer.current!,
          refs.cellArea.current!,
        );
      });
      e.stopPropagation();
    },
    [refs.cellArea, refs.globalCache, refs.workbookContainer, setContext],
  );

  const onRowFreezeHandleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      const { nativeEvent } = e;
      setContext((draftCtx) => {
        handleRowFreezeHandleMouseDown(
          draftCtx,
          refs.globalCache,
          nativeEvent,
          containerRef.current!,
          refs.workbookContainer.current!,
          refs.cellArea.current!,
        );
      });
      e.stopPropagation();
    },
    [refs.cellArea, refs.globalCache, refs.workbookContainer, setContext],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      const { nativeEvent } = e;
      setContext((draftCtx) => {
        handleContextMenu(
          draftCtx,
          settings,
          nativeEvent,
          refs.workbookContainer.current!,
          refs.cellArea.current!,
          'rowHeader',
        );
      });
    },
    [refs.workbookContainer, setContext, settings, refs.cellArea],
  );

  useEffect(() => {
    const s = context.luckysheet_select_save || [];
    if (_.isNil(s)) return;
    setSelectedLocation([]);

    const allColOnly = s.every(
      (sel) => !!sel?.column_select && !sel?.row_select,
    );
    if (allColOnly) return;

    const relevant = s.filter(
      (sel) => !(!!sel?.column_select && !sel?.row_select),
    );

    let rowTitleMap = {};
    for (let i = 0; i < relevant.length; i += 1) {
      const r1 = relevant[i].row[0];
      const r2 = relevant[i].row[1];
      rowTitleMap = selectTitlesMap(rowTitleMap, r1, r2);
    }
    const rowTitleRange = selectTitlesRange(rowTitleMap);
    const selects = [];
    for (let i = 0; i < rowTitleRange.length; i += 1) {
      const r1 = rowTitleRange[i][0];
      const r2 = rowTitleRange[i][rowTitleRange[i].length - 1];
      const row = rowLocationByIndex(r2, context.visibledatarow)[1];
      const row_pre = rowLocationByIndex(r1, context.visibledatarow)[0];
      if (_.isNumber(row_pre) && _.isNumber(row)) {
        selects.push({ row, row_pre, r1, r2 });
      }
    }
    setSelectedLocation(selects);
  }, [context.luckysheet_select_save, context.visibledatarow]);

  const [hiddenPointers, setHiddenPointers] = useState<HiddenPointer[]>([]);

  useEffect(() => {
    if (sheetIndex == null) return;

    const tempPointers: HiddenPointer[] = [];
    const rowhidden = manualRowHidden;

    if (rowhidden) {
      Object.keys(rowhidden).forEach((key) => {
        const item = { row: key, top: context.visibledatarow[Number(key) - 1] };
        tempPointers.push(item);
      });
      setHiddenPointers(tempPointers);
    } else {
      setHiddenPointers([]);
    }
  }, [context.visibledatarow, sheetIndex, manualRowHidden]);

  const showRow = (
    e: React.MouseEvent<HTMLDivElement, MouseEvent>,
    item: HiddenPointer,
  ) => {
    if (sheetIndex == null) return;

    let startRow = Number(item.row);
    let endRow = Number(item.row);
    const startPoint = Number(item.row);

    const rowhiddenData = manualRowHidden;
    let cod = true;
    let tempStartPoint = startPoint;

    while (cod) {
      tempStartPoint = Number(tempStartPoint) - 1;
      // eslint-disable-next-line no-prototype-builtins
      if (rowhiddenData?.hasOwnProperty(String(tempStartPoint))) {
        startRow = tempStartPoint;
      } else {
        cod = false;
      }
    }

    cod = true;
    tempStartPoint = startPoint;

    while (cod) {
      tempStartPoint = Number(tempStartPoint) + 1;
      // eslint-disable-next-line no-prototype-builtins
      if (rowhiddenData?.hasOwnProperty(String(tempStartPoint))) {
        endRow = tempStartPoint;
      } else {
        cod = false;
      }
    }

    if (context.isFlvReadOnly) return;
    e.stopPropagation();
    setContext((ctx) => {
      api.setSelection(
        ctx,
        [
          {
            row: [Number(startRow) - 1, Number(endRow) + 1],
            column: [0, context.visibledatacolumn?.length],
          },
        ],
        {
          id: context.currentSheetId,
        },
      );
    });
    setContext((ctx) => {
      showSelected(ctx, 'row');
    });

    setContext((ctx) => {
      api.setSelection(
        ctx,
        [
          {
            row: [Number(startRow), Number(endRow)],
            column: [0, context.visibledatacolumn?.length],
          },
        ],
        {
          id: context.currentSheetId,
        },
      );
    });
  };

  useEffect(() => {
    containerRef.current!.scrollTop = context.scrollTop;
  }, [context.scrollTop]);

  const getCursor = (rowIndex: number) => {
    if (mouseDown) return 'grabbing';
    const sel = api.getSelection(context);
    const lastSelectedCol = sel?.[0].column?.[1];
    let data = getFlowdata(context);
    if (!data) data = [];

    const allColSel = lastSelectedCol === data?.[0]?.length - 1;
    if (
      allColSel &&
      sel &&
      rowIndex >= sel?.[0].row?.[0] &&
      rowIndex <= sel?.[0].row?.[1]
    ) {
      return 'grab';
    }
    return 'default';
  };

  return (
    <div
      ref={containerRef}
      className="fortune-row-header"
      style={{
        width: context.rowHeaderWidth - 1.5,
        height: context.cellmainHeight,
      }}
      onMouseMove={onMouseMove}
      onMouseDown={onMouseDown}
      onMouseLeave={onMouseLeave}
      onContextMenu={onContextMenu}
    >
      {hiddenPointers.map((item) => {
        return (
          <div
            key={item.row}
            className="flex flex-col gap-4 cursor-pointer align-center hide-btn-row"
            style={{
              top: `${item.top - 15}px`,
              zIndex: 100,
            }}
            onClick={(e) => showRow(e, item)}
          >
            <div className="rotate-row-icon color-text-default">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="5"
                height="8"
                viewBox="0 0 5 8"
                fill="none"
              >
                <path
                  d="M0.164574 4.20629L3.54376 7.58548C3.7275 7.76922 4.04167 7.63909 4.04167 7.37924L4.04167 0.620865C4.04167 0.361018 3.7275 0.230885 3.54376 0.414625L0.164575 3.79381C0.0506717 3.90772 0.0506715 4.09239 0.164574 4.20629Z"
                  fill="currentColor"
                />
              </svg>
            </div>
            <div className="rotate-90 color-text-default">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="5"
                height="8"
                viewBox="0 0 5 8"
                fill="none"
              >
                <path
                  d="M0.164574 4.20629L3.54376 7.58548C3.7275 7.76922 4.04167 7.63909 4.04167 7.37924L4.04167 0.620865C4.04167 0.361018 3.7275 0.230885 3.54376 0.414625L0.164575 3.79381C0.0506717 3.90772 0.0506715 4.09239 0.164574 4.20629Z"
                  fill="currentColor"
                />
              </svg>
            </div>
          </div>
        );
      })}
      <div
        className="fortune-rows-freeze-handle"
        onMouseDown={onRowFreezeHandleMouseDown}
        style={{ top: freezeHandleTop }}
      />
      <div
        className="fortune-rows-change-size"
        ref={rowChangeSizeRef}
        onMouseDown={onRowSizeHandleMouseDown}
        style={{
          top: hoverLocation.row - 3 + (hoverInFreeze ? context.scrollTop : 0),
          opacity: context.luckysheet_rows_change_size ? 1 : 0,
        }}
      />
      {!context.luckysheet_rows_change_size && hoverLocation.row_index >= 0 ? (
        <div
          className="fortune-row-header-hover"
          style={_.assign(
            {
              top: hoverLocation.row_pre,
              height: hoverLocation.row - hoverLocation.row_pre - 1,
              display: 'block',
              cursor: getCursor(hoverLocation.row_index),
            },
            fixRowStyleOverflowInFreeze(
              context,
              hoverLocation.row_index,
              hoverLocation.row_index,
              refs.globalCache.freezen?.[context.currentSheetId],
            ),
          )}
        />
      ) : null}
      {selectedLocation.map(({ row, row_pre, r1, r2 }, i) => {
        const overlayBlend: React.CSSProperties['mixBlendMode'] =
          isEntireRowSelection
            ? 'multiply'
            : DARK_THEMES.includes(getActiveTheme())
              ? 'screen'
              : 'multiply';
        return (
          <div
            className={`fortune-row-header-selected ${isEntireRowSelection ? 'color-bg-brand' : 'color-bg-tertiary'}`}
            key={i}
            style={_.assign(
              {
                top: row_pre,
                height: row - row_pre - 1,
                display: 'block',
                mixBlendMode: overlayBlend,
              },
              fixRowStyleOverflowInFreeze(
                context,
                r1,
                r2,
                refs.globalCache.freezen?.[context.currentSheetId],
              ),
            )}
          />
        );
      })}
      {/* placeholder to overflow the container, making the container scrollable */}
      <div
        style={{ height: context.rh_height, width: 1 }}
        id="luckysheetrowHeader_0"
        className="luckysheetsheetchange"
      />
    </div>
  );
};

export default RowHeader;
