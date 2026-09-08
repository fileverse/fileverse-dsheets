import {
  colLocation,
  colLocationByIndex,
  selectTitlesMap,
  selectTitlesRange,
  handleColSizeHandleMouseDown,
  handleColSizeHandleDoubleClick,
  handleColumnHeaderMouseDown,
  // handleContextMenu,
  isAllowEdit,
  getFlowdata,
  fixColumnStyleOverflowInFreeze,
  handleColFreezeHandleMouseDown,
  getSheetIndex,
  fixPositionOnFrozenCells,
  showSelected,
  api,
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
import SVGIcon from '../SVGIcon';
import { useColumnDragAndDrop } from './drag_and_drop/column-helpers';
import { getActiveTheme } from '@sheet-engine/core/theme';

// Dark-surface themes: on these the light selection tint must `screen` (lighten)
// instead of `multiply` (darken), so the canvas header letter keeps ~its default
// color instead of being darkened into the highlight. The entire-selection case
// uses the constant brand yellow, which always `multiply`s to stay readable.
const DARK_THEMES = ['dark', 'theme-green'];

const ColumnHeader: React.FC = () => {
  const { context, setContext, refs } = useContext(WorkbookContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const colChangeSizeRef = useRef<HTMLDivElement>(null);
  const [hoverLocation, setHoverLocation] = useState({
    col: -1,
    col_pre: -1,
    col_index: -1,
  });
  const [hoverInFreeze, setHoverInFreeze] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<
    { col: number; col_pre: number; c1: number; c2: number }[]
  >([]);
  const allowEditRef = useRef<boolean>(true);
  const sheetIndex = getSheetIndex(context, context.currentSheetId);
  const sheet = sheetIndex == null ? null : context.luckysheetfile[sheetIndex];

  // `column_select` is the reliable signal for "entire column(s)" selection.
  // Cmd/Ctrl+A sets both `row_select` and `column_select` to true.
  const isEntireColumnSelection = !!context.luckysheet_select_save?.some(
    (sel) => !!sel?.column_select,
  );

  const freezeHandleLeft = useMemo(() => {
    if (
      sheet?.frozen?.type === 'column' ||
      sheet?.frozen?.type === 'rangeColumn' ||
      sheet?.frozen?.type === 'rangeBoth' ||
      sheet?.frozen?.type === 'both'
    ) {
      return (
        colLocationByIndex(
          sheet?.frozen?.range?.column_focus || 0,
          context.visibledatacolumn,
        )[1] -
        2 +
        context.scrollLeft
      );
    }
    return context.scrollLeft;
  }, [context.visibledatacolumn, sheet?.frozen, context.scrollLeft]);

  const selectedLocationRef = useRef(selectedLocation);
  useEffect(() => {
    selectedLocationRef.current = selectedLocation;
  }, [selectedLocation]);

  const { initiateDrag, getColIndexClicked, isColDoubleClicked, mouseDown } =
    useColumnDragAndDrop(containerRef, selectedLocationRef);

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      if (context.luckysheet_cols_change_size) {
        return;
      }
      const mouseX =
        e.pageX -
        containerRef.current!.getBoundingClientRect().left -
        window.scrollX;
      const _x = mouseX + containerRef.current!.scrollLeft;
      const freeze = refs.globalCache.freezen?.[context.currentSheetId];
      const { x, inVerticalFreeze } = fixPositionOnFrozenCells(
        freeze,
        _x,
        0,
        mouseX,
        0,
      );
      const col_location = colLocation(x, context.visibledatacolumn);
      const [col_pre, col, col_index] = col_location;
      if (col_index !== hoverLocation.col_index) {
        setHoverLocation({ col_pre, col, col_index });
        setHoverInFreeze(inVerticalFreeze);
      }
      const flowdata = getFlowdata(context);
      if (!_.isNil(flowdata))
        allowEditRef.current =
          isAllowEdit(context) &&
          isAllowEdit(context, [
            {
              row: [0, flowdata.length - 1],
              column: col_location,
            },
          ]);
    },
    [context, hoverLocation.col_index, refs.globalCache.freezen],
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      // @ts-expect-error
      if ((e.button === 0 && e.target.tagName === 'use') || e.button === 2) {
        const { nativeEvent } = e;
        setContext((draft) => {
          handleColumnHeaderMouseDown(
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
        targetEl.closest('.fortune-cols-change-size') ||
        targetEl.closest('.fortune-cols-freeze-handle') ||
        targetEl.closest('.header-arrow')
      )
        return;

      const headerEl = containerRef.current;
      if (!headerEl) return;

      const clickedColIndex = getColIndexClicked(e.pageX, headerEl);
      if (clickedColIndex < 0) return;

      const sel = context.luckysheet_select_save;
      const lastSelectedRow = sel?.[0]?.row?.[1];
      let data = getFlowdata(context);
      if (!data) data = [];

      const allColSel = lastSelectedRow === data?.length - 1;
      if (allColSel) {
        setContext((draft) => {
          draft.luckysheet_scroll_status = true;
        });
      }
      if (
        e.shiftKey ||
        !allColSel ||
        (allColSel && sel && clickedColIndex < sel?.[0].column?.[0]) ||
        // @ts-ignore
        clickedColIndex > sel?.[0]?.column?.[1]
      ) {
        const { nativeEvent } = e;
        setContext((draft) => {
          handleColumnHeaderMouseDown(
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
          handleColumnHeaderMouseDown(
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
      initiateDrag(clickedColIndex, e.pageX);
    },
    [
      refs.globalCache,
      refs.cellInput,
      refs.fxInput,
      context.luckysheet_select_save,
      context.isFlvReadOnly,
      setContext,
      getColIndexClicked,
      isColDoubleClicked,
      initiateDrag,
    ],
  );

  const onMouseLeave = useCallback(() => {
    if (context.luckysheet_cols_change_size) {
      return;
    }
    setHoverLocation({ col: -1, col_pre: -1, col_index: -1 });
  }, [context.luckysheet_cols_change_size]);

  const onColSizeHandleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      const { nativeEvent } = e;
      setContext((draftCtx) => {
        handleColSizeHandleMouseDown(
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

  const onColSizeHandleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      const { nativeEvent } = e;
      setContext((draftCtx) => {
        handleColSizeHandleDoubleClick(
          draftCtx,
          refs.globalCache,
          nativeEvent,
          containerRef.current!,
        );
      });
      e.stopPropagation();
    },
    [refs.globalCache, setContext],
  );

  const onColFreezeHandleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      const { nativeEvent } = e;
      setContext((draftCtx) => {
        handleColFreezeHandleMouseDown(
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

  // const onContextMenu = useCallback(
  //   (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
  //     const { nativeEvent } = e;
  //     setContext((draftCtx) => {
  //       handleContextMenu(
  //         draftCtx,
  //         settings,
  //         nativeEvent,
  //         refs.workbookContainer.current!,
  //         refs.cellArea.current!,
  //         "columnHeader"
  //       );
  //     });
  //   },
  //   [refs.workbookContainer, setContext, settings, refs.cellArea]
  // );

  useEffect(() => {
    const s = context.luckysheet_select_save;
    if (_.isNil(s)) return;
    setSelectedLocation([]);

    const allRowOnly = s.every(
      (sel) => !!sel?.row_select && !sel?.column_select,
    );
    if (allRowOnly) return;

    const relevant = s.filter(
      (sel) => !(!!sel?.row_select && !sel?.column_select),
    );

    let columnTitleMap = {};
    for (let i = 0; i < relevant.length; i += 1) {
      const c1 = relevant[i].column[0];
      const c2 = relevant[i].column[1];
      columnTitleMap = selectTitlesMap(columnTitleMap, c1, c2);
    }
    const columnTitleRange = selectTitlesRange(columnTitleMap);
    const selects: { col: number; col_pre: number; c1: number; c2: number }[] =
      [];
    for (let j = 0; j < columnTitleRange.length; j += 1) {
      const c1 = columnTitleRange[j][0];
      const c2 = columnTitleRange[j][columnTitleRange[j].length - 1];
      const col = colLocationByIndex(c2, context.visibledatacolumn)[1];
      const col_pre = colLocationByIndex(c1, context.visibledatacolumn)[0];
      if (_.isNumber(col) && _.isNumber(col_pre)) {
        selects.push({ col, col_pre, c1, c2 });
      }
    }
    setSelectedLocation(selects);
  }, [context.luckysheet_select_save, context.visibledatacolumn]);

  type HiddenPointer = { col: number; left: number };
  const [hiddenPointers, setHiddenPointers] = useState<HiddenPointer[]>([]);

  useEffect(() => {
    if (sheetIndex == null) return;

    const tempPointers: HiddenPointer[] = [];
    const colhidden = context.luckysheetfile[sheetIndex]?.config?.colhidden;

    if (colhidden) {
      Object.keys(colhidden).forEach((key) => {
        const item: HiddenPointer = {
          col: Number(key),
          left: context.visibledatacolumn[Number(key) - 1],
        };
        tempPointers.push(item);
      });
      setHiddenPointers(tempPointers);
    } else {
      setHiddenPointers([]);
    }
  }, [context.visibledatacolumn, context.luckysheetfile, sheetIndex]);

  const showColumn = (
    e: React.MouseEvent<HTMLDivElement, MouseEvent>,
    item: HiddenPointer,
  ) => {
    if (sheetIndex == null) return;

    let startCol = item.col;
    let endCol = item.col;
    const startPoint = item.col;

    const colhiddenData = context.luckysheetfile[sheetIndex]?.config?.colhidden;
    let cod = true;
    let tempStartPoint = startPoint;

    while (cod) {
      tempStartPoint = Number(tempStartPoint) - 1;
      // eslint-disable-next-line no-prototype-builtins
      if (colhiddenData?.hasOwnProperty(String(tempStartPoint))) {
        startCol = tempStartPoint;
      } else {
        cod = false;
      }
    }

    cod = true;
    tempStartPoint = startPoint;

    while (cod) {
      tempStartPoint = Number(tempStartPoint) + 1;
      // eslint-disable-next-line no-prototype-builtins
      if (colhiddenData?.hasOwnProperty(String(tempStartPoint))) {
        endCol = tempStartPoint;
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
            row: [0, context.visibledatarow?.length],
            column: [Number(startCol) - 1, Number(endCol) + 1],
          },
        ],
        {
          id: context.currentSheetId,
        },
      );
    });
    setContext((ctx) => {
      showSelected(ctx, 'column');
    });

    setContext((ctx) => {
      api.setSelection(
        ctx,
        [
          {
            row: [0, context.visibledatarow?.length],
            column: [Number(startCol), Number(endCol)],
          },
        ],
        {
          id: context.currentSheetId,
        },
      );
    });
  };

  useEffect(() => {
    containerRef.current!.scrollLeft = context.scrollLeft;
  }, [context.scrollLeft]);

  const getCursor = (colIndex: number) => {
    if (mouseDown) return 'grabbing';
    const sel = api.getSelection(context);
    const lastSelectedRow = sel?.[0].row?.[1];
    let data = getFlowdata(context);
    if (!data) data = [];

    const allColSel = lastSelectedRow === data?.length - 1;
    if (
      allColSel &&
      sel &&
      colIndex >= sel?.[0].column[0] &&
      colIndex <= sel?.[0].column[1]
    ) {
      return 'grab';
    }
    return 'default';
  };

  return (
    <div
      ref={containerRef}
      className="fortune-col-header"
      style={{
        height: context.columnHeaderHeight - 1.5,
      }}
      onMouseMove={onMouseMove}
      onMouseDown={onMouseDown}
      onMouseLeave={onMouseLeave}
      onContextMenu={(e) => {
        e.preventDefault();
        setContext((ctx) => {
          ctx.contextMenu = {
            x: e.pageX,
            y: 90,
            headerMenu: true,
          };
        });
      }}
    >
      {hiddenPointers.map((item) => {
        return (
          <div
            className="flex gap-4 cursor-pointer hide-btn align-center jusify-between"
            style={{
              height: context.columnHeaderHeight - 12,
              left: `${item.left - 15}px`,
            }}
            onClick={(e) => showColumn(e, item)}
          >
            <div className="color-text-default">
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
            <div className="color-text-default">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="5"
                height="8"
                viewBox="0 0 5 8"
                fill="none"
              >
                <path
                  d="M4.68811 4.35359L1.81188 7.22982C1.4969 7.5448 0.958328 7.32172 0.958328 6.87627L0.958328 1.12381C0.958328 0.678362 1.4969 0.455279 1.81188 0.770261L4.68811 3.64649C4.88337 3.84175 4.88337 4.15833 4.68811 4.35359Z"
                  fill="currentColor"
                />
              </svg>
            </div>
          </div>
        );
      })}
      <div
        className="fortune-cols-freeze-handle"
        onMouseDown={onColFreezeHandleMouseDown}
        style={{
          left: freezeHandleLeft,
        }}
      />
      <div
        className="fortune-cols-change-size"
        ref={colChangeSizeRef}
        id="fortune-cols-change-size"
        onMouseDown={onColSizeHandleMouseDown}
        onDoubleClick={onColSizeHandleDoubleClick}
        style={{
          left:
            hoverLocation.col - 5 + (hoverInFreeze ? context.scrollLeft : 0),
          opacity: context.luckysheet_cols_change_size ? 1 : 0,
        }}
      />
      {!context.luckysheet_cols_change_size && hoverLocation.col_index >= 0 ? (
        <div
          className="fortune-col-header-hover"
          style={_.assign(
            {
              left: hoverLocation.col_pre,
              width: hoverLocation.col - hoverLocation.col_pre - 1,
              display: 'block',
              cursor: getCursor(hoverLocation.col_index),
            },
            fixColumnStyleOverflowInFreeze(
              context,
              hoverLocation.col_index,
              hoverLocation.col_index,
              refs.globalCache.freezen?.[context.currentSheetId],
            ),
          )}
        >
          {allowEditRef.current && (
            <span
              className="header-arrow mr-2"
              onClick={(e) => {
                setContext((ctx) => {
                  ctx.contextMenu = {
                    x: e.pageX,
                    y: 90,
                    headerMenu: true,
                  };
                });
              }}
              tabIndex={0}
            >
              <SVGIcon
                name="headDownArrow"
                width={12}
                style={{ marginBottom: '3px' }}
              />
            </span>
          )}
        </div>
      ) : null}
      {selectedLocation.map(({ col, col_pre, c1, c2 }, i) => {
        const overlayBlend: React.CSSProperties['mixBlendMode'] =
          isEntireColumnSelection
            ? 'multiply'
            : DARK_THEMES.includes(getActiveTheme())
              ? 'screen'
              : 'multiply';
        return (
          <div
            className={`fortune-col-header-selected ${isEntireColumnSelection ? 'color-bg-brand' : 'color-bg-tertiary'}`}
            key={i}
            style={_.assign(
              {
                left: col_pre,
                width: col - col_pre - 1,
                display: 'block',
                // backgroundColor: "#EFC703",
                mixBlendMode: overlayBlend,
              },
              fixColumnStyleOverflowInFreeze(
                context,
                c1,
                c2,
                refs.globalCache.freezen?.[context.currentSheetId],
              ),
            )}
          />
        );
      })}
      {/* placeholder to overflow the container, making the container scrollable */}
      <div
        className="luckysheet-cols-h-cells luckysheetsheetchange"
        id="luckysheet-cols-h-cells_0"
        style={{ width: context.ch_width, height: 1 }}
      >
        <div className="luckysheet-cols-h-cells-c">
          <div className="luckysheet-grdblkpush" />
        </div>
      </div>
    </div>
  );
};

export default ColumnHeader;
