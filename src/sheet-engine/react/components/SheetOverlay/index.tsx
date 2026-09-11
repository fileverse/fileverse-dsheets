import React, {
  useContext,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import './index.css';
import {
  locale,
  drawArrow,
  handleCellAreaDoubleClick,
  handleCellAreaMouseDown,
  handleContextMenu,
  handleOverlayMouseMove,
  handleOverlayMouseUp,
  selectAll,
  handleOverlayTouchEnd,
  handleOverlayTouchStart,
  createDropCellRange,
  getCellRowColumn,
  getCellHyperlink,
  showLinkCard,
  isAllowEdit,
  israngeseleciton,
  Context,
  GlobalCache,
  onCellsMoveStart,
  insertRowCol,
  deleteRowCol,
  getSheetIndex,
  getFlowdata,
  fixRowStyleOverflowInFreeze,
  fixColumnStyleOverflowInFreeze,
  isLegacyFormulaRangeMode,
  isFormulaReferenceInputMode,
  expandCellRectForMerge,
  seletedHighlistByindex,
  selectionIsExactlyOneMergeBlock,
  rowLocation,
  colLocation,
  fixPositionOnFrozenCells,
} from '@sheet-engine/core';
import _ from 'lodash';
import WorkbookContext, { SetContextOptions } from '../../context';
import ColumnHeader from './ColumnHeader';
import RowHeader from './RowHeader';
import InputBox from './InputBox';
import ScrollBar from './ScrollBar';
import SearchReplace from '../SearchReplace';
import LinkEditCard from '../LinkEidtCard';
import FilterOptions from '../FilterOption';
import { useAlert } from '../../hooks/useAlert';
import ImgBoxs from '../ImgBoxs';
import NotationBoxes from '../NotationBoxes';
import RangeDialog from '../DataVerification/RangeDialog';
import { useDialog } from '../../hooks/useDialog';
// import SVGIcon from "../SVGIcon";
import DropDownList from '../DataVerification/DropdownList';
import IframeBoxs from '../IFrameBoxs/iFrameBoxs';
import ErrorBoxes from '../ErrorState';
import ensLogo from '../../../../editor/assets/ens.svg';
import verifiedMark from '../../../../editor/assets/verified-mark.png';

/**
 * Cell to outline as "primary" for multi-cell ranges: `context.primaryCellActive`, else
 * focus cell, else top-left. Skips merged blocks (one logical cell — no primary pill).
 */
function getPrimaryCellHighlightRc(
  ctx: Context,
): { r: number; c: number } | null {
  if (ctx.primaryCellActive != null) {
    return ctx.primaryCellActive;
  }
  const sel = ctx.luckysheet_select_save;
  if (!sel?.length) return null;
  const last = sel[sel.length - 1];
  if (last.row[0] === last.row[1] && last.column[0] === last.column[1]) {
    return null;
  }
  if (selectionIsExactlyOneMergeBlock(ctx, last)) {
    return null;
  }
  if (last.row_focus != null && last.column_focus != null) {
    return { r: last.row_focus, c: last.column_focus };
  }
  const rLo = Math.min(last.row[0], last.row[1]);
  const cLo = Math.min(last.column[0], last.column[1]);
  return { r: rLo, c: cLo };
}

/** Subtle fill + dotted border for formula range overlay (`#rrggbb` from core `colors`). */
function formulaRangeHighlightHcStyle(hex: string) {
  const h = hex.replace('#', '');
  if (h.length !== 6) {
    return { backgroundColor: hex, borderColor: hex } as const;
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return {
    backgroundColor: `rgba(${r},${g},${b},0.08)`,
    borderColor: hex,
  } as const;
}

/** CF rule list hover overlay only (darker green; not the default CF cell color). */
const CF_RULE_HOVER_FILL_HEX = '#1a8026';

function cfRuleHoverHighlightHcStyle(hex: string) {
  const base = formulaRangeHighlightHcStyle(hex);
  return {
    ...base,
    borderStyle: 'solid' as const,
    borderWidth: 2,
  };
}

const SheetOverlay: React.FC = () => {
  const { context, setContext, settings, refs } = useContext(WorkbookContext);
  const { info, rightclick } = locale(context);
  const [hoveredCell, setHoveredCell] = useState<{ row: number; col: number } | null>(null);

  const flowdataForQuickSearchDeps = getFlowdata(context);

  const quickSearchOverlayRects = useMemo(() => {
    if (!context.showQuickSearch) return [];
    const hl = context.quickSearchHighlight;
    if (!hl || hl.matches.length === 0) return [];
    const { matches, activeIndex } = hl;
    const active = matches[activeIndex] ?? matches[0]!;
    const activeB = expandCellRectForMerge(context, active.r, active.c);
    const activeKey = `${activeB.r1}_${activeB.r2}_${activeB.c1}_${activeB.c2}`;
    const uniq = new Map<
      string,
      { r1: number; r2: number; c1: number; c2: number; active: boolean }
    >();
    matches.forEach(({ r, c }) => {
      const b = expandCellRectForMerge(context, r, c);
      const key = `${b.r1}_${b.r2}_${b.c1}_${b.c2}`;
      const isActive = key === activeKey;
      const prev = uniq.get(key);
      if (!prev) uniq.set(key, { ...b, active: isActive });
      else if (isActive) prev.active = true;
    });
    return Array.from(uniq.entries())
      .map(([key, box]) => {
        const rect = seletedHighlistByindex(
          context,
          box.r1,
          box.r2,
          box.c1,
          box.c2,
        );
        return rect ? { key, box, rect } : null;
      })
      .filter((v): v is NonNullable<typeof v> => v != null);
    // Granular deps + flowdata ref refresh highlights without deep cell equality
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    context.showQuickSearch,
    context.quickSearchHighlight,
    context.visibledatarow,
    context.visibledatacolumn,
    context.config.merge,
    context.config.rowhidden,
    context.config.colhidden,
    context.currentSheetId,
    context.luckysheetCellUpdate.length,
    refs.globalCache.undoList.length,
    refs.globalCache.redoList.length,
    flowdataForQuickSearchDeps,
  ]);
  // Rect for the "Specific range" scope border in Find & Replace
  const searchRangeScopeRect = useMemo(() => {
    const hl = context.searchRangeScopeHighlight;
    const findReplaceActive =
      context.showSearch ||
      context.showReplace ||
      context.findReplaceHiddenDuringRangePick;
    if (!findReplaceActive || !hl || !hl.row || !hl.column) return null;
    const rect = seletedHighlistByindex(
      context,
      hl.row[0]!,
      hl.row[1]!,
      hl.column[0]!,
      hl.column[1]!,
    );
    return rect ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    context.showSearch,
    context.showReplace,
    context.findReplaceHiddenDuringRangePick,
    context.searchRangeScopeHighlight,
    context.visibledatarow,
    context.visibledatacolumn,
    context.currentSheetId,
  ]);

  const conditionalFormatHoverOverlayRects = useMemo(() => {
    const ranges = context.conditionalFormatRuleHoverRanges;
    if (!ranges?.length) return [];
    return ranges
      .map((box, i) => {
        const r0 = box.row[0];
        const r1 = box.row[1];
        const c0 = box.column[0];
        const c1 = box.column[1];
        if (
          r0 == null ||
          r1 == null ||
          c0 == null ||
          c1 == null ||
          r0 > r1 ||
          c0 > c1
        ) {
          return null;
        }
        const rect = seletedHighlistByindex(context, r0, r1, c0, c1);
        return rect
          ? { key: `cf-hover-${i}-${r0}_${r1}_${c0}_${c1}`, rect }
          : null;
      })
      .filter((v): v is NonNullable<typeof v> => v != null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    context.conditionalFormatRuleHoverRanges,
    context.visibledatarow,
    context.visibledatacolumn,
    context.config.merge,
    context.config.rowhidden,
    context.config.colhidden,
    context.currentSheetId,
    context.scrollLeft,
    context.scrollTop,
    context.zoomRatio,
    refs.globalCache.undoList.length,
    refs.globalCache.redoList.length,
    flowdataForQuickSearchDeps,
  ]);

  const { showDialog } = useDialog();
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomAddRowInputRef = useRef<HTMLInputElement>(null);
  const dataVerificationHintBoxRef = useRef<HTMLDivElement>(null);
  const { showAlert } = useAlert();
  // Hide `#fortune-selection-copy` while formula refs are active (avoids double outline
  // with `formulaRangeHighlight` / `formulaRangeSelect`; lone `=A2` may have empty highlights).
  const editingSheetCell = (context.luckysheetCellUpdate?.length ?? 0) > 0;
  const cellInputText = refs.cellInput.current?.innerText?.trim() ?? '';
  const fxInputText = refs.fxInput.current?.innerText?.trim() ?? '';
  const editingAsFormula =
    editingSheetCell &&
    (cellInputText.startsWith('=') || fxInputText.startsWith('='));
  const suppressFortuneSelectionCopyOverlay =
    context.formulaRangeSelect != null ||
    editingAsFormula ||
    isLegacyFormulaRangeMode(context) ||
    isFormulaReferenceInputMode(context) ||
    ((context.formulaRangeHighlight?.length ?? 0) > 0 && editingSheetCell);

  // const isMobile = browser.mobilecheck();
  const cellAreaMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      const { nativeEvent } = e;
      if (e.button !== 2) {
        // onContextMenu event will not call onMouseDown
        setContext((draftCtx) => {
          handleCellAreaMouseDown(
            draftCtx,
            refs.globalCache,
            nativeEvent,
            refs.cellInput.current!,
            refs.cellArea.current!,
            refs.fxInput.current!,
            refs.canvas.current!.getContext('2d')!,
          );

          // After picking a cell reference from the formula bar, do not move
          // focus to the in-cell editor — that breaks the next reference click
          // (rangeSetValue / caret logic assume the active formula editor).
          const keepFormulaBarFocused =
            draftCtx.luckysheetCellUpdate.length > 0 &&
            draftCtx.formulaCache.formulaEditorOwner === 'fx' &&
            (draftCtx.formulaCache.rangestart ||
              draftCtx.formulaCache.rangedrag_column_start ||
              draftCtx.formulaCache.rangedrag_row_start ||
              israngeseleciton(draftCtx));

          if (
            !_.isEmpty(draftCtx.luckysheet_select_save?.[0]) &&
            refs.cellInput.current
          ) {
            if (!isAllowEdit(draftCtx)) {
              // In read-only mode, focus the workbook container directly so
              // keyboard events (e.g. Ctrl/Cmd+C) reach the onKeyDown handler.
              setTimeout(() => {
                refs.workbookContainer.current?.focus({ preventScroll: true });
              });
            } else {
              setTimeout(() => {
                if (keepFormulaBarFocused && refs.fxInput.current) {
                  refs.fxInput.current.focus({ preventScroll: true });
                } else {
                  refs.cellInput.current?.focus();
                }
              });
            }
          }
        });
      }
    },
    [
      setContext,
      refs.globalCache,
      refs.cellInput,
      refs.cellArea,
      refs.fxInput,
      refs.canvas,
      refs.workbookContainer,
    ],
  );

  const cellAreaContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      const { nativeEvent } = e;
      setContext((draftCtx) => {
        handleContextMenu(
          draftCtx,
          settings,
          nativeEvent,
          refs.workbookContainer.current!,
          refs.cellArea.current!,
          'cell',
        );
      });
    },
    [refs.workbookContainer, setContext, settings, refs.cellArea],
  );

  const cellAreaDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      const { nativeEvent } = e;
      setContext((draftCtx) => {
        handleCellAreaDoubleClick(
          draftCtx,
          refs.globalCache,
          settings,
          nativeEvent,
          refs.cellArea.current!,
        );
      });
    },
    [refs.cellArea, refs.globalCache, setContext, settings],
  );

  const onLeftTopClick = useCallback(() => {
    setContext((draftCtx) => {
      selectAll(draftCtx);
    });
  }, [setContext]);

  // Note: this debounce only ever fires the "hide" branch of showLinkCard (link == null
  // clears ctx.linkCard) — when hovering an actual link, showLinkCard is called
  // synchronously below and this debounced call is invoked with skip=true just to cancel
  // any pending hide from a previous non-link hover. So this wait controls how long the
  // hover-preview card lingers after the mouse leaves the linked cell; keep it short so the
  // card disappears quickly, while still bridging the small gap the pointer crosses when
  // moving from the cell down into the card itself.
  const LINK_CARD_HIDE_DELAY_MS = 100;

  const debouncedShowLinkCard = useMemo(
    () =>
      _.debounce(
        (
          globalCache: GlobalCache,
          r: number,
          c: number,
          isEditing: boolean,
          skip = false,
        ) => {
          if (skip || globalCache.linkCard?.mouseEnter) return;
          setContext((draftCtx) => {
            showLinkCard(draftCtx, r, c, undefined, isEditing);
          });
        },
        LINK_CARD_HIDE_DELAY_MS,
      ),
    [setContext],
  );

  const overShowLinkCard = useCallback(
    (
      ctx: Context,
      globalCache: GlobalCache,
      e: MouseEvent,
      container: HTMLDivElement,
      scrollX: HTMLDivElement,
      scrollY: HTMLDivElement,
    ) => {
      const rc = getCellRowColumn(ctx, e, container, scrollX, scrollY);
      if (rc == null) return;
      const link = getCellHyperlink(ctx, rc.r, rc.c);
      if (link == null) {
        debouncedShowLinkCard(globalCache, rc.r, rc.c, false);
      } else {
        if (globalCache.linkCard?.mouseEnter) return;
        showLinkCard(ctx, rc.r, rc.c, undefined, false);
        debouncedShowLinkCard(globalCache, rc.r, rc.c, false, true);
      }
    },
    [debouncedShowLinkCard],
  );

  const onMouseMove = useCallback(
    (nativeEvent: MouseEvent) => {
      setContext((draftCtx) => {
        overShowLinkCard(
          draftCtx,
          refs.globalCache,
          nativeEvent,
          containerRef.current!,
          refs.scrollbarX.current!,
          refs.scrollbarY.current!,
        );
        handleOverlayMouseMove(
          draftCtx,
          refs.globalCache,
          nativeEvent,
          refs.cellInput.current!,
          refs.scrollbarX.current!,
          refs.scrollbarY.current!,
          containerRef.current!,
          refs.fxInput.current,
        );

        const containerMain = document.getElementsByClassName('fortune-cell-area')[0] as HTMLDivElement;
        const rect = containerMain?.getBoundingClientRect();
        if (rect) {
          const mouseX = nativeEvent.pageX - rect.left - window.scrollX;
          const mouseY = nativeEvent.pageY - rect.top - window.scrollY;
          const _x = mouseX + draftCtx.scrollLeft;
          const _y = mouseY + draftCtx.scrollTop;
          const freeze = refs.globalCache.freezen?.[draftCtx.currentSheetId];
          const { x, y } = fixPositionOnFrozenCells(freeze, _x, _y, mouseX, mouseY);
          const row = rowLocation(y, draftCtx.visibledatarow)[2];
          const col = colLocation(x, draftCtx.visibledatacolumn)[2];
          setHoveredCell((prev) =>
            prev?.row === row && prev?.col === col ? prev : { row, col },
          );
        }
      });
    },
    [
      overShowLinkCard,
      refs.cellInput,
      refs.fxInput,
      refs.globalCache,
      refs.scrollbarX,
      refs.scrollbarY,
      setContext,
    ],
  );

  const onMouseUp = useCallback(
    (nativeEvent: MouseEvent) => {
      setContext((draftCtx) => {
        try {
          handleOverlayMouseUp(
            draftCtx,
            refs.globalCache,
            settings,
            nativeEvent,
            refs.scrollbarX.current!,
            refs.scrollbarY.current!,
            containerRef.current!,
            refs.cellInput.current,
            refs.fxInput.current,
          );
        } catch (e: any) {
          showAlert(e.message);
        }
      });
    },
    [
      refs.cellInput,
      refs.fxInput,
      refs.globalCache,
      refs.scrollbarX,
      refs.scrollbarY,
      setContext,
      settings,
      showAlert,
    ],
  );

  const onKeyDownForZoom = useCallback(
    (ev: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const isWinLike = !isMac;
      const isInsertByPlusShortcut =
        ((isMac && ev.metaKey && ev.altKey) ||
          (isWinLike && ev.ctrlKey && ev.altKey)) &&
        (ev.code === 'Equal' ||
          ev.code === 'NumpadAdd' ||
          ev.key === '+' ||
          ev.key === '=');

      if (isInsertByPlusShortcut) {
        const selection = context.luckysheet_select_save?.[0];
        if (selection?.column_select || selection?.row_select) {
          const selectedCount = selection.column_select
            ? selection.column[1] - selection.column[0] + 1
            : selection.row[1] - selection.row[0] + 1;
          const insertRowColOp: SetContextOptions['insertRowColOp'] =
            selection.column_select
              ? {
                  type: 'column',
                  index: selection!.column[0],
                  count: selectedCount,
                  direction: 'lefttop',
                  id: context.currentSheetId,
                }
              : {
                  type: 'row',
                  index: selection!.row[1],
                  count: selectedCount,
                  direction: 'rightbottom',
                  id: context.currentSheetId,
                };

          setContext(
            (draftCtx) => {
              insertRowCol(draftCtx, insertRowColOp, false);
            },
            { insertRowColOp },
          );
        } else if (selection) {
          const workbookRect =
            refs.workbookContainer.current?.getBoundingClientRect();
          const baseX = selection.left_move ?? selection.left ?? 0;
          const selectionWidth = selection.width_move ?? selection.width ?? 0;
          // Open shortcut menu after the selected range (multi-cell aware),
          // instead of anchoring near the first selected cell.
          const menuX = Math.max(0, baseX + selectionWidth + 55);
          const menuY = (selection.top_move ?? selection.top ?? 0) + 22;

          setContext((draftCtx) => {
            draftCtx.contextMenu = {
              x: menuX,
              y: menuY,
              pageX: (workbookRect?.left ?? 0) + menuX,
              pageY: (workbookRect?.top ?? 0) + menuY,
              headerMenu: undefined,
              // @ts-ignore custom menu variant for shortcut insert actions
              menuType: 'insert-shortcut',
            };
          });
        }
        ev.preventDefault();
        return;
      }

      const isDeleteByMinusShortcut =
        ((isMac && ev.metaKey && ev.altKey) ||
          (isWinLike && ev.ctrlKey && ev.altKey)) &&
        (ev.code === 'Minus' || ev.key === '-');
      if (isDeleteByMinusShortcut) {
        const selection = context.luckysheet_select_save?.[0];
        if (selection?.column_select || selection?.row_select) {
          setContext((draftCtx) => {
            const sheetIndex = getSheetIndex(draftCtx, draftCtx.currentSheetId);
            const sheet =
              sheetIndex != null ? draftCtx.luckysheetfile[sheetIndex] : null;
            if (!sheet?.data?.length || !sheet.data[0]?.length) return;

            if (selection.column_select) {
              const deleteStart = selection.column[0];
              const deleteEnd = selection.column[1];
              deleteRowCol(draftCtx, {
                type: 'column',
                start: deleteStart,
                end: deleteEnd,
                id: context.currentSheetId,
              });
              const currentColCount = sheet.data[0]?.length ?? 0;
              if (currentColCount > 0) {
                const targetCol = Math.min(deleteStart, currentColCount - 1);
                draftCtx.luckysheet_select_save = [
                  {
                    row: [0, sheet.data.length - 1],
                    column: [targetCol, targetCol],
                    row_focus: 0,
                    column_focus: targetCol,
                    row_select: false,
                    column_select: true,
                  },
                ];
              }
            } else {
              const deleteStart = selection.row[0];
              const deleteEnd = selection.row[1];
              deleteRowCol(draftCtx, {
                type: 'row',
                start: deleteStart,
                end: deleteEnd,
                id: context.currentSheetId,
              });
              const currentRowCount = sheet.data.length;
              if (currentRowCount > 0) {
                const targetRow = Math.min(deleteStart, currentRowCount - 1);
                draftCtx.luckysheet_select_save = [
                  {
                    row: [targetRow, targetRow],
                    column: [0, sheet.data[0].length - 1],
                    row_focus: targetRow,
                    column_focus: 0,
                    row_select: true,
                    column_select: false,
                  },
                ];
              }
            }
          });
        } else if (selection) {
          const workbookRect =
            refs.workbookContainer.current?.getBoundingClientRect();
          const baseX = selection.left_move ?? selection.left ?? 0;
          const selectionWidth = selection.width_move ?? selection.width ?? 0;
          // Open shortcut menu after the selected range (multi-cell aware),
          // instead of anchoring near the first selected cell.
          const menuX = Math.max(0, baseX + selectionWidth + 55);
          const menuY = (selection.top_move ?? selection.top ?? 0) + 22;

          setContext((draftCtx) => {
            draftCtx.contextMenu = {
              x: menuX,
              y: menuY,
              pageX: (workbookRect?.left ?? 0) + menuX,
              pageY: (workbookRect?.top ?? 0) + menuY,
              headerMenu: undefined,
              // @ts-ignore custom menu variant for shortcut delete actions
              menuType: 'delete-shortcut',
            };
          });
        }
        ev.preventDefault();
        return;
      }
    },
    [
      context.currentSheetId,
      context.luckysheet_select_save,
      setContext,
    ],
  );

  const onTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const { nativeEvent } = e;
      setContext((draftContext) => {
        handleOverlayTouchStart(draftContext, nativeEvent, refs.globalCache);
      });
      e.stopPropagation();
    },
    [refs.globalCache, setContext],
  );

  const onTouchEnd = useCallback(() => {
    handleOverlayTouchEnd(refs.globalCache);
  }, [refs.globalCache]);

  const handleBottomAddRow = useCallback(() => {
    const valueStr =
      bottomAddRowInputRef.current?.value || context.addDefaultRows.toString();
    const value = parseInt(valueStr, 10);
    if (Number.isNaN(value)) {
      return;
    }
    if (value < 1) {
      return;
    }
    const insertRowColOp: SetContextOptions['insertRowColOp'] = {
      type: 'row',
      index:
        context.luckysheetfile[
          getSheetIndex(context, context!.currentSheetId! as string) as number
        ].data!.length - 1,
      count: value,
      direction: 'rightbottom',
      id: context.currentSheetId,
    };
    setContext(
      (draftCtx) => {
        try {
          insertRowCol(draftCtx, insertRowColOp, false);
        } catch (err: any) {
          if (err.message === 'maxExceeded') showAlert(rightclick.rowOverLimit);
        }
      },
      { insertRowColOp },
    );
  }, [context, rightclick.rowOverLimit, setContext, showAlert]);

  // 提醒弹窗
  useEffect(() => {
    if (context.warnDialog) {
      setTimeout(() => {
        showDialog(context.warnDialog, 'yesno', 'Invalid data', 'Retry');
        setContext((ctx) => {
          ctx.warnDialog = undefined;
        });
      }, 240);
    }
  }, [context.warnDialog, setContext, showDialog]);

  useEffect(() => {
    refs.cellArea.current!.scrollLeft = context.scrollLeft;
    refs.cellArea.current!.scrollTop = context.scrollTop;
  }, [
    context.scrollLeft,
    context.scrollTop,
    refs.cellArea,
    refs.cellArea.current?.scrollLeft,
    refs.cellArea.current?.scrollTop,
  ]);

  // useEffect(() => {
  //   // ensure cell input is always focused to accept first key stroke on cell
  //   if (!context.editingCommentBox) {
  //     refs.cellInput.current?.focus({ preventScroll: true });
  //   }
  // }, [
  //   context.editingCommentBox,
  //   context.luckysheet_select_save,
  //   refs.cellInput,
  // ]);

  useLayoutEffect(() => {
    if (
      context.commentBoxes ||
      context.hoveredCommentBox ||
      context.editingCommentBox
    ) {
      _.concat(
        context.commentBoxes?.filter(
          (v) => v.rc !== context.editingCommentBox?.rc,
        ),
        [context.hoveredCommentBox, context.editingCommentBox],
      ).forEach((box) => {
        if (box) {
          drawArrow(box.rc, box.size);
        }
      });
    }
  }, [
    context.commentBoxes,
    context.hoveredCommentBox,
    context.editingCommentBox,
  ]);

  useEffect(() => {
    document.addEventListener('mousemove', onMouseMove);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
    };
  }, [onMouseMove]);

  useEffect(() => {
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseUp]);

  useEffect(() => {
    document.addEventListener('keydown', onKeyDownForZoom);
    return () => {
      document.removeEventListener('keydown', onKeyDownForZoom);
    };
  }, [onKeyDownForZoom]);

  return (
    <div
      className="fortune-sheet-overlay"
      ref={containerRef}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      tabIndex={-1}
      style={{
        width: context.luckysheetTableContentHW[0],
        height: context.luckysheetTableContentHW[1],
      }}
    >
      <div className="fortune-col-header-wrap">
        <div
          className="fortune-left-top"
          onClick={onLeftTopClick}
          tabIndex={0}
          style={{
            width: context.rowHeaderWidth - 1.5,
            height: context.columnHeaderHeight - 1.5,
          }}
        />
        <ColumnHeader />
      </div>
      {(context.showSearch ||
        context.showReplace ||
        context.findReplaceHiddenDuringRangePick) && (
        <SearchReplace getContainer={() => containerRef.current!} />
      )}
      <div className="fortune-row-body">
        <RowHeader />
        <ScrollBar axis="x" />
        <ScrollBar axis="y" />
        <div
          ref={refs.cellArea}
          className={`fortune-cell-area ${
            context.luckysheetPaintModelOn ? 'cursor-paint' : ''
          }`}
          onMouseDown={cellAreaMouseDown}
          onDoubleClick={cellAreaDoubleClick}
          onContextMenu={cellAreaContextMenu}
          style={{
            width: context.cellmainWidth,
            height: context.cellmainHeight,
            cursor: context.luckysheet_cell_selected_extend ? 'crosshair' : '',
          }}
        >
          <div id="fortune-formula-functionrange" />
          {context.formulaRangeSelect && (
            <div
              className="fortune-selection-copy fortune-formula-functionrange-select"
              style={_.omit(context.formulaRangeSelect, 'rangeIndex')}
            >
              <div
                className="fortune-selection-copy-hc"
                style={formulaRangeHighlightHcStyle('#12a5ff')}
              />
            </div>
          )}
          {context.formulaRangeHighlight.map((v) => {
            const { rangeIndex, backgroundColor } = v;
            return (
              <div
                key={rangeIndex}
                id="fortune-formula-functionrange-highlight"
                className="fortune-selection-highlight fortune-formula-functionrange-highlight"
                style={_.omit(v, 'backgroundColor')}
              >
                <div
                  className="fortune-selection-copy-hc"
                  style={formulaRangeHighlightHcStyle(backgroundColor)}
                />
              </div>
            );
          })}
          {conditionalFormatHoverOverlayRects.map(({ key, rect }) => (
            <div
              key={key}
              className="fortune-selection-highlight fortune-cf-rule-hover-highlight"
              style={{
                ..._.pick(rect, ['left', 'top', 'height']),
                width: (rect.width ?? 0) + 4,
                pointerEvents: 'none',
              }}
            >
              <div
                className="fortune-selection-copy-hc"
                style={cfRuleHoverHighlightHcStyle(CF_RULE_HOVER_FILL_HEX)}
              />
            </div>
          ))}
          {quickSearchOverlayRects.map(({ key, box, rect }) => (
            <div
              key={`fortune-quick-search-hl-${key}`}
              className={`fortune-quick-search-highlight${
                box.active ? ' fortune-quick-search-highlight--active' : ''
              }`}
              style={{
                position: 'absolute',
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                pointerEvents: 'none',
                zIndex: 13,
              }}
            />
          ))}
          {searchRangeScopeRect && (
            <div
              className={`fortune-search-range-highlight${
                context.searchRangeScopeEmphasis
                  ? ' fortune-search-range-highlight--active'
                  : ''
              }`}
              style={{
                position: 'absolute',
                left: searchRangeScopeRect.left,
                top: searchRangeScopeRect.top,
                width: searchRangeScopeRect.width,
                height: searchRangeScopeRect.height,
                pointerEvents: 'none',
                zIndex: 12,
              }}
            />
          )}
          <div
            className="luckysheet-row-count-show luckysheet-count-show"
            id="luckysheet-row-count-show"
          />
          <div
            className="luckysheet-column-count-show luckysheet-count-show"
            id="luckysheet-column-count-show"
          />
          <div
            className="fortune-change-size-line"
            hidden={
              !context.luckysheet_cols_change_size &&
              !context.luckysheet_rows_change_size &&
              !context.luckysheet_cols_freeze_drag &&
              !context.luckysheet_rows_freeze_drag
            }
          />
          <div
            className="fortune-freeze-drag-line"
            hidden={
              !context.luckysheet_cols_freeze_drag &&
              !context.luckysheet_rows_freeze_drag
            }
          />
          <div
            className="luckysheet-cell-selected-focus"
            style={
              (context.luckysheet_select_save?.length ?? 0) > 0
                ? (() => {
                    const selection = _.last(context.luckysheet_select_save)!;
                    return _.assign(
                      {
                        left: selection.left,
                        top: selection.top,
                        width: selection.width
                          ? selection.width - 1.8
                          : selection.width,
                        height: selection.height
                          ? selection.height - 1.8
                          : selection.height,
                        display: 'block',
                      },
                      fixRowStyleOverflowInFreeze(
                        context,
                        selection.row_focus || 0,
                        selection.row_focus || 0,
                        refs.globalCache.freezen?.[context.currentSheetId],
                      ),
                      fixColumnStyleOverflowInFreeze(
                        context,
                        selection.column_focus || 0,
                        selection.column_focus || 0,
                        refs.globalCache.freezen?.[context.currentSheetId],
                      ),
                    );
                  })()
                : {}
            }
            onMouseDown={(e) => e.preventDefault()}
          />
          {(context.luckysheet_selection_range?.length ?? 0) > 0 && (
            <div id="fortune-selection-copy">
              {context.luckysheet_selection_range!.map((range) => {
                const r1 = range.row[0];
                const r2 = range.row[1];
                const c1 = range.column[0];
                const c2 = range.column[1];

                const row = context.visibledatarow[r2];
                const row_pre =
                  r1 - 1 === -1 ? 0 : context.visibledatarow[r1 - 1];
                const col = context.visibledatacolumn[c2];
                const col_pre =
                  c1 - 1 === -1 ? 0 : context.visibledatacolumn[c1 - 1];

                return (
                  <div
                    className="fortune-selection-copy"
                    key={`${r1}-${r2}-${c1}-${c2}`}
                    style={{
                      left: col_pre,
                      width: col - col_pre - 1,
                      top: row_pre,
                      height: row - row_pre - 1,
                    }}
                  >
                    <div className="fortune-selection-copy-hc" />
                  </div>
                );
              })}
            </div>
          )}
          <div id="luckysheet-chart-rangeShow" />
          <div className="fortune-cell-selected-extend" />
          <div
            className="fortune-cell-selected-move"
            id="fortune-cell-selected-move"
            onMouseDown={(e) => e.preventDefault()}
          />
          {(context.luckysheet_select_save?.length ?? 0) > 0 && (
            <div id="luckysheet-cell-selected-boxs">
              {context.luckysheet_select_save!.map((selection, index) => {
                const isEditing =
                  (context.luckysheetCellUpdate?.length ?? 0) > 0;
                const hideSelectionBecauseSearchScope =
                  (context.showSearch || context.showReplace) &&
                  !!context.searchRangeScopeHighlight &&
                  selection.row[0] ===
                    context.searchRangeScopeHighlight.row[0] &&
                  selection.row[1] ===
                    context.searchRangeScopeHighlight.row[1] &&
                  selection.column[0] ===
                    context.searchRangeScopeHighlight.column[0] &&
                  selection.column[1] ===
                    context.searchRangeScopeHighlight.column[1];
                const isFormulaRangeSelecting =
                  context.formulaCache.rangestart ||
                  context.formulaCache.rangedrag_column_start ||
                  context.formulaCache.rangedrag_row_start ||
                  israngeseleciton(context);
                const spansMultipleGridCells =
                  selection.row[0] !== selection.row[1] ||
                  selection.column[0] !== selection.column[1];
                const isMultiCell =
                  spansMultipleGridCells &&
                  !selectionIsExactlyOneMergeBlock(context, selection);
                // Single-cell edit: hide the duplicate chrome (input covers the cell).
                // Multi-cell: keep the range visible while typing into the active cell.
                const hideSelectionWhileEditing = isEditing && !isMultiCell;
                const hideFillHandle = isEditing || isFormulaRangeSelecting;
                return (
                  <div
                    key={index}
                    id="luckysheet-cell-selected"
                    className={`luckysheet-cell-selected${
                      isEditing ? ' luckysheet-cell-selected-edit-mode' : ''
                    }`}
                    style={_.assign(
                      {
                        left: selection.left_move,
                        top: selection.top_move,
                        width: selection.width_move
                          ? selection.width_move - (isMultiCell ? 0.6 : 1.8)
                          : selection.width_move,
                        height: selection.height_move
                          ? selection.height_move - (isMultiCell ? 0.6 : 1.8)
                          : selection.height_move,
                        borderWidth: isMultiCell ? 1 : 2,
                        display:
                          hideSelectionWhileEditing ||
                          hideSelectionBecauseSearchScope
                            ? 'none'
                            : 'block',
                      },
                      fixRowStyleOverflowInFreeze(
                        context,
                        selection.row[0],
                        selection.row[1],
                        refs.globalCache.freezen?.[context.currentSheetId],
                      ),
                      fixColumnStyleOverflowInFreeze(
                        context,
                        selection.column[0],
                        selection.column[1],
                        refs.globalCache.freezen?.[context.currentSheetId],
                      ),
                    )}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      const { nativeEvent } = e;
                      setContext((draftCtx) => {
                        onCellsMoveStart(
                          draftCtx,
                          refs.globalCache,
                          nativeEvent,
                          refs.scrollbarX.current!,
                          refs.scrollbarY.current!,
                          containerRef.current!,
                        );
                      });
                    }}
                  >
                    <div className="luckysheet-cs-inner-border" />
                    {!hideFillHandle && (
                      <div
                        className="luckysheet-cs-fillhandle"
                        onMouseDown={(e) => {
                          const { nativeEvent } = e;
                          setContext((draftContext) => {
                            createDropCellRange(
                              draftContext,
                              nativeEvent,
                              containerRef.current!,
                            );
                          });
                          e.stopPropagation();
                        }}
                      />
                    )}
                    <div className="luckysheet-cs-inner-border" />
                    <div
                      className="luckysheet-cs-draghandle-top luckysheet-cs-draghandle"
                      onMouseDown={(e) => e.preventDefault()}
                    />
                    <div
                      className="luckysheet-cs-draghandle-bottom luckysheet-cs-draghandle"
                      onMouseDown={(e) => e.preventDefault()}
                    />
                    <div
                      className="luckysheet-cs-draghandle-left luckysheet-cs-draghandle"
                      onMouseDown={(e) => e.preventDefault()}
                    />
                    <div
                      className="luckysheet-cs-draghandle-right luckysheet-cs-draghandle"
                      onMouseDown={(e) => e.preventDefault()}
                    />
                    <div className="luckysheet-cs-touchhandle luckysheet-cs-touchhandle-lt">
                      <div className="luckysheet-cs-touchhandle-btn" />
                    </div>
                    <div className="luckysheet-cs-touchhandle luckysheet-cs-touchhandle-rb">
                      <div className="luckysheet-cs-touchhandle-btn" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {(() => {
            const editing = (context.luckysheetCellUpdate?.length ?? 0) > 0;
            if (editing) return null;
            const primary = getPrimaryCellHighlightRc(context);
            if (primary == null) return null;
            const { r: r1, c: c1 } = primary;
            const row = context.visibledatarow[r1];
            const col = context.visibledatacolumn[c1];
            if (row == null || col == null) return null;
            const row_pre = r1 - 1 === -1 ? 0 : context.visibledatarow[r1 - 1];
            const col_pre =
              c1 - 1 === -1 ? 0 : context.visibledatacolumn[c1 - 1];
            const rawW = col - col_pre - 1;
            const rawH = row - row_pre - 1;
            return (
              <div
                className="luckysheet-primary-cell-active"
                aria-hidden
                style={_.assign(
                  {
                    left: col_pre,
                    top: row_pre,
                    width: rawW ? rawW - 1.8 : rawW,
                    height: rawH ? rawH - 1.8 : rawH,
                    display: 'block',
                  },
                  fixRowStyleOverflowInFreeze(
                    context,
                    r1,
                    r1,
                    refs.globalCache.freezen?.[context.currentSheetId],
                  ),
                  fixColumnStyleOverflowInFreeze(
                    context,
                    c1,
                    c1,
                    refs.globalCache.freezen?.[context.currentSheetId],
                  ),
                )}
              />
            );
          })()}
          {(context.presences?.length ?? 0) > 0 &&
            context.presences!.map((presence, index) => {
              if (presence.sheetId !== context.currentSheetId) {
                return null;
              }
              const {
                selection: { r, c },
                color,
              } = presence;
              const row_pre = r - 1 === -1 ? 0 : context.visibledatarow[r - 1];
              const col_pre =
                c - 1 === -1 ? 0 : context.visibledatacolumn[c - 1];
              const row = context.visibledatarow[r];
              const col = context.visibledatacolumn[c];
              const width = col - col_pre;
              const height = row - row_pre;
              const usernameStyle: React.CSSProperties = presence.isEns
                ? {
                    backgroundColor: 'hsl(var(--color-bg-default))',
                    color,
                    border: `2px solid ${color}`,
                    left: width - 2,
                    bottom: height - 2,
                  }
                : {
                    backgroundColor: color,
                    left: width - 2,
                    bottom: height - 2,
                  };

              return (
                <div
                  key={presence?.userId || index}
                  className="fortune-presence-selection"
                  style={{
                    left: col_pre,
                    top: row_pre,
                    width,
                    height,
                    borderColor: color,
                    borderWidth: 2,
                  }}
                >
                  <div
                    className={`fortune-presence-username${presence.isEns ? ' fortune-presence-username--ens' : ''}`}
                    style={{
                      ...usernameStyle,
                      opacity: hoveredCell?.row === r && hoveredCell?.col === c ? 1 : 0,
                    }}
                  >
                    {presence.isEns ? (
                      <>
                        <img
                          src={ensLogo}
                          className="fortune-presence-ens-logo"
                          alt=""
                        />
                        <span className="fortune-presence-ens-name">
                          {presence.username}
                        </span>
                        <img
                          src={verifiedMark}
                          className="fortune-presence-ens-tick"
                          alt=""
                        />
                      </>
                    ) : (
                      presence.username
                    )}
                  </div>
                </div>
              );
            })}
          {context.linkCard?.sheetId === context.currentSheetId && (
            <LinkEditCard {...context.linkCard} />
          )}
          {context.rangeDialog?.show && <RangeDialog />}
          <FilterOptions getContainer={() => containerRef.current!} />
          <InputBox />
          <NotationBoxes />
          <ErrorBoxes />
          <div id="luckysheet-multipleRange-show" />
          <div id="luckysheet-dynamicArray-hightShow" />
          <ImgBoxs />
          <IframeBoxs />
          <div
            id="luckysheet-dataVerification-dropdown-btn"
            onClick={() => {
              setContext((ctx) => {
                ctx.dataVerificationDropDownList = true;
                dataVerificationHintBoxRef.current!.style.display = 'none';
              });
            }}
            tabIndex={0}
            style={{ display: 'none' }}
          >
            {/* <SVGIcon name="caret-down-fill" width={16} height={16} /> */}
          </div>
          {context.dataVerificationDropDownList &&
            (context.dataVerification!.dataRegulation!.value1 !== '' ||
              context.dataVerification!.dataRegulation!.value2 !== '') && (
              <DropDownList />
            )}
          {/* <div
            id="luckysheet-dataVerification-dropdown-List"
            className="luckysheet-mousedown-cancel"
          /> */}
          <div
            id="luckysheet-dataVerification-showHintBox"
            ref={dataVerificationHintBoxRef}
          />
          <div className="luckysheet-cell-copy" />
          <div className="luckysheet-grdblkflowpush" />
          <div
            id="luckysheet-cell-flow_0"
            className="luckysheet-cell-flow luckysheetsheetchange"
          >
            <div className="luckysheet-cell-flow-clip">
              <div className="luckysheet-grdblkpush" />
              <div
                id="luckysheetcoltable_0"
                className="luckysheet-cell-flow-col"
              >
                <div
                  id="luckysheet-sheettable_0"
                  className="luckysheet-cell-sheettable"
                  style={{
                    height: context.rh_height,
                    width: context.ch_width,
                  }}
                />
                <div
                  id="luckysheet-bottom-controll-row"
                  className="luckysheet-bottom-controll-row"
                  onMouseDown={(e) => e.stopPropagation()}
                  onMouseUp={(e) => e.stopPropagation()}
                  // onMouseMove={(e) => {
                  //   e.stopPropagation();
                  //   e.preventDefault();
                  // }}
                  onKeyDown={(e) => e.stopPropagation()}
                  onKeyUp={(e) => e.stopPropagation()}
                  onKeyPress={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  tabIndex={0}
                  style={{
                    left: context.scrollLeft,
                    display: context.allowEdit ? 'block' : 'none',
                  }}
                >
                  <div
                    className="fortune-add-row-button"
                    onClick={() => {
                      handleBottomAddRow();
                    }}
                    tabIndex={0}
                  >
                    {info.add}
                  </div>
                  <input
                    ref={bottomAddRowInputRef}
                    type="text"
                    style={{ width: 50 }}
                    placeholder={context.addDefaultRows.toString()}
                  />{' '}
                  <span style={{ fontSize: 14 }}>{info.row}</span>{' '}
                  <span style={{ fontSize: 14, color: 'hsl(var(--color-text-secondary))' }}>
                    ({info.addLast})
                  </span>
                  <span
                    className="fortune-add-row-button"
                    onClick={() => {
                      setContext((ctx) => {
                        ctx.scrollTop = 0;
                      });
                    }}
                    tabIndex={0}
                  >
                    {info.backTop}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SheetOverlay;
