/* eslint-disable @typescript-eslint/no-non-null-asserted-optional-chain */
import {
  locale,
  handleCopy,
  handlePasteByClick,
  deleteRowCol,
  insertRowCol,
  removeActiveImage,
  cutActiveImage,
  deleteSelectedCellText,
  sortSelection,
  createFilter,
  showImgChooser,
  handleLink,
  hideSelected,
  showSelected,
  getSheetIndex,
  api,
  isAllowEdit,
  jfrefreshgrid,
  newComment,
  getFreezeState,
  toggleFreeze,
  clearFilter,
  clearSelectedCellFormat,
  clearColumnsCellsFormat,
  clearRowsCellsFormat,
  indexToColumnChar,
} from '@sheet-engine/core';
import _ from 'lodash';
import React, {
  useContext,
  useRef,
  useCallback,
  useLayoutEffect,
  useState,
} from 'react';
import regeneratorRuntime from 'regenerator-runtime';
import Tippy from '@tippyjs/react';
import { LucideIcon } from '@fileverse/ui';
import { SplitColumn } from '../SplitColumn';
import { ResetColumnWidth } from '../ResetColumnWidth';
import { ResetRowHeight } from '../ResetRowHeight';
// import DataVerification from "../DataVerification";
import WorkbookContext, { SetContextOptions } from '../../context';
import { useAlert } from '../../hooks/useAlert';
import { useDialog } from '../../hooks/useDialog';
import Divider from './Divider';
import './index.css';
import Menu from './Menu';
// import CustomSort from "../CustomSort";
import 'tippy.js/dist/tippy.css';
// import ConditionalFormat from "../ConditionFormat";
import SVGIcon from '../SVGIcon';
import { LucideIcon as LocalLucidIcon } from '../SheetOverlay/LucideIcon';

const ContextMenu: React.FC = () => {
  const { showDialog } = useDialog();
  const containerRef = useRef<HTMLDivElement>(null);
  const { context, setContext, settings, refs } = useContext(WorkbookContext);
  const { contextMenu } = context;
  const { showAlert } = useAlert();
  const { rightclick, drag, generalDialog, info, splitText } = locale(context);

  const [activeMenu, setActiveMenu] = useState('');

  const applyDeleteCellsShift = useCallback(
    (direction: 'left' | 'up') => {
      const selection = context.luckysheet_select_save?.[0];
      if (!selection) return;
      const [rowStart, rowEnd] = selection.row;
      const [colStart, colEnd] = selection.column;
      const rowCount = rowEnd - rowStart + 1;
      const colCount = colEnd - colStart + 1;

      setContext((draftCtx) => {
        const sheetIndex = getSheetIndex(draftCtx, draftCtx.currentSheetId);
        if (_.isNil(sheetIndex)) {
          draftCtx.contextMenu = {};
          return;
        }
        const sheet = draftCtx.luckysheetfile[sheetIndex];
        const data = sheet?.data;
        if (!data?.length || !data[0]?.length) {
          draftCtx.contextMenu = {};
          return;
        }
        const totalRows = sheet.row ?? data.length;
        const totalCols = sheet.column ?? data[0].length;

        if (direction === 'left') {
          for (let r = rowStart; r <= rowEnd; r += 1) {
            const row = data[r];
            if (!row) continue;
            row.splice(colStart, colCount);
            while (row.length < totalCols) {
              row.push(null);
            }
          }
        } else {
          for (let c = colStart; c <= colEnd; c += 1) {
            for (let r = rowStart; r <= totalRows - rowCount - 1; r += 1) {
              data[r][c] = data[r + rowCount]?.[c] ?? null;
            }
            for (let r = totalRows - rowCount; r < totalRows; r += 1) {
              data[r][c] = null;
            }
          }
        }

        draftCtx.contextMenu = {};
        jfrefreshgrid(draftCtx, null, undefined);
      });
    },
    [context.luckysheet_select_save, setContext],
  );

  const applyInsertCellsShift = useCallback(
    (direction: 'right' | 'down') => {
      const selection = context.luckysheet_select_save?.[0];
      if (!selection) return;
      const [rowStart, rowEnd] = selection.row;
      const [colStart, colEnd] = selection.column;
      const rowCount = rowEnd - rowStart + 1;
      const colCount = colEnd - colStart + 1;

      setContext((draftCtx) => {
        const sheetIndex = getSheetIndex(draftCtx, draftCtx.currentSheetId);
        if (_.isNil(sheetIndex)) {
          draftCtx.contextMenu = {};
          return;
        }
        const sheet = draftCtx.luckysheetfile[sheetIndex];
        const data = sheet?.data;
        if (!data?.length || !data[0]?.length) {
          draftCtx.contextMenu = {};
          return;
        }
        const totalRows = sheet.row ?? data.length;
        const totalCols = sheet.column ?? data[0].length;

        if (direction === 'right') {
          for (let r = rowStart; r <= rowEnd; r += 1) {
            const row = data[r];
            if (!row) continue;
            row.splice(colStart, 0, ...new Array(colCount).fill(null));
            row.length = totalCols;
          }
        } else {
          for (let c = colStart; c <= colEnd; c += 1) {
            for (let r = totalRows - 1; r >= rowStart + rowCount; r -= 1) {
              data[r][c] = data[r - rowCount]?.[c] ?? null;
            }
            for (let r = rowStart; r < rowStart + rowCount; r += 1) {
              data[r][c] = null;
            }
          }
        }

        draftCtx.contextMenu = {};
        jfrefreshgrid(draftCtx, null, undefined);
      });
    },
    [context.luckysheet_select_save, setContext],
  );

  const deleteSelectedRowRange = useCallback(() => {
    const selection = context.luckysheet_select_save?.[0];
    if (!selection) return;
    const [stIndex, edIndex] = selection.row;

    const deleteRowColOp: SetContextOptions['deleteRowColOp'] = {
      type: 'row',
      start: stIndex,
      end: edIndex,
      id: context.currentSheetId,
    };

    setContext(
      (draftCtx) => {
        const index = getSheetIndex(
          draftCtx,
          draftCtx.currentSheetId,
        ) as number;
        const slen = edIndex - stIndex + 1;
        if (draftCtx.luckysheetfile[index].data?.length! <= slen) {
          showAlert(rightclick.cannotDeleteAllRow, 'ok');
          draftCtx.contextMenu = {};
          return;
        }
        try {
          deleteRowCol(draftCtx, deleteRowColOp);
        } catch (e: any) {
          if (e.message === 'readOnly') {
            showAlert(rightclick.cannotDeleteRowReadOnly, 'ok');
          }
        }
        draftCtx.contextMenu = {};
      },
      { deleteRowColOp },
    );
  }, [
    context.currentSheetId,
    context.luckysheet_select_save,
    setContext,
    showAlert,
    rightclick.cannotDeleteAllRow,
    rightclick.cannotDeleteRowReadOnly,
  ]);

  const deleteSelectedColumnRange = useCallback(() => {
    const selection = context.luckysheet_select_save?.[0];
    if (!selection) return;
    const [stIndex, edIndex] = selection.column;

    const deleteRowColOp: SetContextOptions['deleteRowColOp'] = {
      type: 'column',
      start: stIndex,
      end: edIndex,
      id: context.currentSheetId,
    };

    setContext(
      (draftCtx) => {
        const index = getSheetIndex(
          draftCtx,
          draftCtx.currentSheetId,
        ) as number;
        const slen = edIndex - stIndex + 1;
        if (draftCtx.luckysheetfile[index].data?.[0]?.length! <= slen) {
          showAlert(rightclick.cannotDeleteAllColumn, 'ok');
          draftCtx.contextMenu = {};
          return;
        }
        try {
          deleteRowCol(draftCtx, deleteRowColOp);
        } catch (e: any) {
          if (e.message === 'readOnly') {
            showAlert(rightclick.cannotDeleteColumnReadOnly, 'ok');
          }
        }
        draftCtx.contextMenu = {};
      },
      { deleteRowColOp },
    );
  }, [
    context.currentSheetId,
    context.luckysheet_select_save,
    setContext,
    showAlert,
    rightclick.cannotDeleteAllColumn,
    rightclick.cannotDeleteColumnReadOnly,
  ]);

  const insertSelectedRowRange = useCallback(() => {
    const selection = context.luckysheet_select_save?.[0];
    if (!selection) return;
    const rowCount = selection.row[1] - selection.row[0] + 1;
    const insertRowColOp: SetContextOptions['insertRowColOp'] = {
      type: 'row',
      index: selection.row[1],
      count: rowCount,
      direction: 'rightbottom',
      id: context.currentSheetId,
    };

    setContext(
      (draftCtx) => {
        try {
          insertRowCol(draftCtx, insertRowColOp);
        } catch (err: any) {
          if (err.message === 'maxExceeded') {
            showAlert(rightclick.rowOverLimit, 'ok');
          } else if (err.message === 'readOnly') {
            showAlert(rightclick.cannotInsertOnRowReadOnly, 'ok');
          }
        }
        draftCtx.contextMenu = {};
      },
      { insertRowColOp },
    );
  }, [
    context.currentSheetId,
    context.luckysheet_select_save,
    setContext,
    showAlert,
    rightclick.rowOverLimit,
    rightclick.cannotInsertOnRowReadOnly,
  ]);

  const insertSelectedColumnRange = useCallback(() => {
    const selection = context.luckysheet_select_save?.[0];
    if (!selection) return;
    const colCount = selection.column[1] - selection.column[0] + 1;
    const insertRowColOp: SetContextOptions['insertRowColOp'] = {
      type: 'column',
      index: selection.column[0],
      count: colCount,
      direction: 'lefttop',
      id: context.currentSheetId,
    };

    setContext(
      (draftCtx) => {
        try {
          insertRowCol(draftCtx, insertRowColOp);
        } catch (err: any) {
          if (err.message === 'maxExceeded') {
            showAlert(rightclick.columnOverLimit, 'ok');
          } else if (err.message === 'readOnly') {
            showAlert(rightclick.cannotInsertOnColumnReadOnly, 'ok');
          }
        }
        draftCtx.contextMenu = {};
      },
      { insertRowColOp },
    );
  }, [
    context.currentSheetId,
    context.luckysheet_select_save,
    setContext,
    showAlert,
    rightclick.columnOverLimit,
    rightclick.cannotInsertOnColumnReadOnly,
  ]);

  const addRowColRightAvobe = (
    type: 'row' | 'column',
    direction: 'lefttop' | 'rightbottom',
  ) => {
    if (context.allowEdit === false) return;
    if ((context.luckysheet_select_save?.length ?? 0) > 1) {
      showAlert(rightclick.noMulti, 'ok');
      setContext((draftCtx) => {
        draftCtx.contextMenu = {};
      });
      return;
    }
    const selection = context.luckysheet_select_save?.[0];
    if (!selection) return;

    const insertRowColOp: SetContextOptions['insertRowColOp'] = {
      type,
      direction,
      id: context.currentSheetId,
      index: 0,
      count: 0,
    };

    if (type === 'row') {
      const [rowStart, rowEnd] = selection.row;
      insertRowColOp.count = rowEnd - rowStart + 1;
      insertRowColOp.index = direction === 'lefttop' ? rowStart : rowEnd;
      insertRowColOp.templateSourceRows = _.range(rowStart, rowEnd + 1);
    } else {
      const [colStart, colEnd] = selection.column;
      insertRowColOp.count = colEnd - colStart + 1;
      insertRowColOp.index = direction === 'lefttop' ? colStart : colEnd;
      insertRowColOp.templateSourceColumns = _.range(colStart, colEnd + 1);
    }

    if (insertRowColOp.count < 1) return;

    setContext(
      (draftCtx) => {
        try {
          insertRowCol(draftCtx, insertRowColOp);
          draftCtx.contextMenu = {};
        } catch (err: any) {
          if (err.message === 'maxExceeded') {
            showAlert(
              insertRowColOp.type === 'row'
                ? rightclick.rowOverLimit
                : rightclick.columnOverLimit,
              'ok',
            );
          } else if (err.message === 'readOnly') {
            showAlert(
              insertRowColOp.type === 'row'
                ? rightclick.cannotInsertOnRowReadOnly
                : rightclick.cannotInsertOnColumnReadOnly,
              'ok',
            );
          }
          draftCtx.contextMenu = {};
        }
      },
      {
        insertRowColOp,
      },
    );
  };

  const getMenuElement = useCallback(
    (name: string, i: number) => {
      const selection = context.luckysheet_select_save?.[0];
      if (name === '|') {
        return <Divider key={`divider-${i}`} />;
      }
      if (name === 'split-text') {
        return (
          <Menu
            key="split-text"
            onClick={() => {
              if (context.allowEdit === false) return;
              if (_.isUndefined(context.luckysheet_select_save)) {
                showDialog(splitText.tipNoSelect, 'ok');
              } else {
                const currentColumn =
                  context.luckysheet_select_save[
                    context.luckysheet_select_save.length - 1
                  ].column;
                if (context.luckysheet_select_save.length > 1) {
                  showDialog(splitText.tipNoMulti, 'ok');
                } else if (currentColumn[0] !== currentColumn[1]) {
                  showDialog(splitText.tipNoMultiColumn, 'ok');
                } else {
                  showDialog(
                    <SplitColumn />,
                    undefined,
                    'Split text to columns',
                  );
                }
              }
              setContext((draftCtx) => {
                draftCtx.contextMenu = {};
              });
            }}
          >
            <div className="context-item">
              <SVGIcon name="split-flv" width={18} height={18} />
              Split text to columns
            </div>
          </Menu>
        );
      }
      if (name === 'freeze-row') {
        const freezeState = getFreezeState(context);
        const isFrozen = freezeState.isRowFrozen;
        const isEntireRowSelected = selection?.row_select === true;

        if (!isEntireRowSelected) return null;

        return (
          <Menu
            key="freeze-row"
            onClick={() => {
              setContext((draftCtx) => {
                if (isFrozen) {
                  toggleFreeze(draftCtx, 'unfreeze-row');
                } else {
                  toggleFreeze(draftCtx, 'row');
                }
                draftCtx.contextMenu = {};
              });
            }}
          >
            <div className="context-item">
              <LucideIcon name="Snowflake" />
              <p>{isFrozen ? 'Unfreeze row' : 'Freeze upto current row'}</p>
            </div>
          </Menu>
        );
      }

      if (name === 'freeze-column') {
        const freezeState = getFreezeState(context);
        const isFrozen = freezeState.isColFrozen;
        const isEntireColumnSelected = selection?.column_select === true;

        if (!isEntireColumnSelected) return null;

        return (
          <Menu
            key="freeze-column"
            onClick={() => {
              setContext((draftCtx) => {
                if (isFrozen) {
                  toggleFreeze(draftCtx, 'unfreeze-column');
                } else {
                  toggleFreeze(draftCtx, 'column');
                  // Force a refresh of the grid after freezing
                  jfrefreshgrid(draftCtx, null, undefined, false);
                }
                draftCtx.contextMenu = {};
              });
            }}
          >
            <div className="context-item">
              <LucideIcon name="Snowflake" />
              <p>
                {isFrozen ? 'Unfreeze column' : 'Freeze upto current column'}
              </p>
            </div>
          </Menu>
        );
      }
      if (name === 'comment') {
        return (
          <Menu
            key={name}
            onClick={() => {
              setContext((draftCtx) => {
                newComment(
                  draftCtx,
                  refs.globalCache,
                  selection?.row_focus!,
                  selection?.column_focus!,
                );
                draftCtx.contextMenu = {};
              });
            }}
          >
            <div className="context-item">
              <LucideIcon name="MessageSquarePlus" />
              <p>Comment</p>
            </div>
          </Menu>
        );
      }
      if (name === 'dataVerification') {
        return (
          <Menu
            key={name}
            onClick={() => {
              if (context.allowEdit === false) return;
              setContext((draftCtx) => {
                draftCtx.contextMenu = {};
              });
              // @ts-ignore
              window.dataVerificationClick(context.luckysheet_select_save);
            }}
          >
            <div className="context-item">
              <LucideIcon name="ShieldCheck" />
              <p>Dropdown</p>
            </div>
          </Menu>
        );
      }
      if (name === 'searchReplace') {
        return (
          <Menu
            key={name}
            onClick={() => {
              if (context.allowEdit === false) return;
              setContext((draftCtx) => {
                draftCtx.showSearch = true;
                draftCtx.showReplace = true;
                draftCtx.contextMenu = {};
              });
            }}
          >
            <div className="context-item">
              <LucideIcon name="Search" />
              <p>Find and Replace</p>
            </div>
          </Menu>
        );
      }
      if (name === 'copy') {
        return (
          <Menu
            key={name}
            onClick={() => {
              setContext((draftCtx) => {
                if (draftCtx.luckysheet_select_save?.length! > 1) {
                  showAlert(rightclick.noMulti, 'ok');
                  draftCtx.contextMenu = {};
                  return;
                }
                handleCopy(draftCtx);
                draftCtx.contextMenu = {};
              });
            }}
          >
            <div className="context-item">
              <LucideIcon name="Copy" />
              <p>{rightclick.copy}</p>
            </div>
          </Menu>
        );
      }
      if (name === 'cut') {
        return (
          <Menu
            key={name}
            onClick={() => {
              setContext((draftCtx) => {
                if (draftCtx.luckysheet_select_save?.length! > 1) {
                  showAlert(rightclick.noMulti, 'ok');
                  draftCtx.contextMenu = {};
                  return;
                }
                if (draftCtx.activeImg != null) {
                  // Keep image visible until paste (Excel-style cut)
                  cutActiveImage(draftCtx);
                } else {
                  // Same as Ctrl/Cmd+X: copy + mark cut; clear source on paste
                  handleCopy(draftCtx);
                  draftCtx.luckysheet_paste_iscut = true;
                }
                jfrefreshgrid(draftCtx, null, undefined);

                draftCtx.contextMenu = {};
              });
            }}
          >
            <div className="context-item">
              <LucideIcon name="Scissors" />
              <p>Cut</p>
            </div>
          </Menu>
        );
      }
      if (name === 'paste' && regeneratorRuntime) {
        return (
          <Menu
            key={name}
            onClick={async () => {
              const clipboardText = await navigator.clipboard.readText();
              setContext((draftCtx) => {
                handlePasteByClick(draftCtx, clipboardText);
                draftCtx.contextMenu = {};
              });
            }}
          >
            <div className="context-item">
              <LucideIcon name="Clipboard" />
              <p>{rightclick.paste}</p>
            </div>
          </Menu>
        );
      }
      if (name === 'insert-column') {
        if (selection?.row_select) return null;
        const colSpan =
          selection != null ? selection.column[1] - selection.column[0] + 1 : 1;
        const colLeftLabel = rightclick.insertColumnsLeftN.replace(
          '{n}',
          String(colSpan),
        );
        return ['left'].map((dir) => (
          <Menu
            key={`add-col-${dir}`}
            onClick={() => {
              addRowColRightAvobe('column', 'lefttop');
            }}
          >
            <div className="context-item color-text-default">
              <LocalLucidIcon
                name="AddColLeft"
                className="color-text-default"
              />
              <div>{colLeftLabel}</div>
            </div>
          </Menu>
        ));
      }
      if (name === 'insert-column-right') {
        if (!context.contextMenu.headerMenu) return null;
        if (selection?.row_select) return null;
        const colSpan =
          selection != null ? selection.column[1] - selection.column[0] + 1 : 1;
        const colRightLabel = rightclick.insertColumnsRightN.replace(
          '{n}',
          String(colSpan),
        );
        return ['left'].map((dir) => (
          <Menu
            key={`add-col-right-${dir}`}
            onClick={() => {
              addRowColRightAvobe('column', 'rightbottom');
            }}
          >
            <div className="context-item color-text-default">
              <LocalLucidIcon
                name="AddColRight"
                className="color-text-default"
              />
              <div>{colRightLabel}</div>
            </div>
          </Menu>
        ));
      }
      if (name === 'insert-row-above') {
        if (selection?.column_select) return null;
        const rowSpan =
          selection != null ? selection.row[1] - selection.row[0] + 1 : 1;
        const rowAboveLabel = rightclick.insertRowsAboveN.replace(
          '{n}',
          String(rowSpan),
        );
        return ['left'].map((dir) => (
          <Menu
            key={`add-row-above-${dir}`}
            onClick={() => {
              addRowColRightAvobe('row', 'lefttop');
            }}
          >
            <div className="context-item color-text-default">
              <LocalLucidIcon
                name="AddRowAboveLocal"
                className="color-text-default"
              />
              <div>{rowAboveLabel}</div>
            </div>
          </Menu>
        ));
      }
      if (name === 'insert-row') {
        if (!context.contextMenu.headerMenu) return null;
        if (selection?.column_select) return null;
        const rowSpan =
          selection != null ? selection.row[1] - selection.row[0] + 1 : 1;
        const rowBelowLabel = rightclick.insertRowsBelowN.replace(
          '{n}',
          String(rowSpan),
        );
        return ['left'].map((dir) => (
          <Menu
            key={`add-row-below-${dir}`}
            onClick={() => {
              addRowColRightAvobe('row', 'rightbottom');
            }}
          >
            <div className="context-item color-text-default">
              <LocalLucidIcon
                name="AddRowBelowLocal"
                className="color-text-default"
              />
              <div>{rowBelowLabel}</div>
            </div>
          </Menu>
        ));
      }
      if (name === 'insert-cells') {
        if (selection?.row_select || selection?.column_select) return null;
        return (
          <Tippy
            key={name}
            placement="right-start"
            interactive
            interactiveBorder={50}
            offset={[0, 0]}
            arrow={false}
            zIndex={3000}
            appendTo={document.body}
            trigger="mouseenter focus"
            hideOnClick={false}
            onShow={() => {
              setActiveMenu('insert-cells');
            }}
            onHide={() => {
              if (activeMenu === 'insert-cells') setActiveMenu('');
            }}
            content={
              <div
                className="fortune-toolbar-select"
                style={{ minWidth: '14rem' }}
              >
                <div className="flex flex-col color-text-default text-body-sm">
                  <Menu
                    onClick={() => {
                      applyInsertCellsShift('right');
                    }}
                  >
                    <div
                      className="context-item p-2 w-full"
                      style={{ height: '36px' }}
                    >
                      <p>Insert cells and shift right</p>
                    </div>
                  </Menu>
                  <Menu
                    onClick={() => {
                      applyInsertCellsShift('down');
                    }}
                  >
                    <div
                      className="context-item p-2 w-full"
                      style={{ height: '36px' }}
                    >
                      <p>Insert cells and shift down</p>
                    </div>
                  </Menu>
                </div>
              </div>
            }
          >
            <div>
              <Menu isActive={activeMenu === 'insert-cells'}>
                <div className="flex items-center justify-between w-full">
                  <div className="context-item">
                    <LucideIcon name="Plus" />
                    <p>Insert cells</p>
                  </div>
                  <LucideIcon name="ChevronRight" width={16} height={16} />
                </div>
              </Menu>
            </div>
          </Tippy>
        );
      }
      if (name === 'delete-cells') {
        if (selection?.row_select || selection?.column_select) return null;
        return (
          <Tippy
            key={name}
            placement="right-start"
            interactive
            interactiveBorder={50}
            offset={[0, 0]}
            arrow={false}
            zIndex={3000}
            appendTo={document.body}
            trigger="mouseenter focus"
            hideOnClick={false}
            onShow={() => {
              setActiveMenu('delete-cells');
            }}
            onHide={() => {
              if (activeMenu === 'delete-cells') setActiveMenu('');
            }}
            content={
              <div
                className="fortune-toolbar-select"
                style={{ minWidth: '14rem' }}
              >
                <div className="flex flex-col color-text-default text-body-sm">
                  <Menu
                    onClick={() => {
                      applyDeleteCellsShift('left');
                    }}
                  >
                    <div
                      className="context-item p-2 w-full"
                      style={{ height: '36px' }}
                    >
                      <p>Delete cells and shift left</p>
                    </div>
                  </Menu>
                  <Menu
                    onClick={() => {
                      applyDeleteCellsShift('up');
                    }}
                  >
                    <div
                      className="context-item p-2 w-full"
                      style={{ height: '36px' }}
                    >
                      <p>Delete cells and shift up</p>
                    </div>
                  </Menu>
                </div>
              </div>
            }
          >
            <div>
              <Menu isActive={activeMenu === 'delete-cells'}>
                <div className="flex items-center justify-between w-full">
                  <div className="context-item">
                    <LucideIcon name="Trash2" />
                    <p>Delete cells</p>
                  </div>
                  <LucideIcon name="ChevronRight" width={16} height={16} />
                </div>
              </Menu>
            </div>
          </Tippy>
        );
      }
      if (name === 'delete-column') {
        return (
          selection?.column_select && (
            <Menu
              key="delete-col"
              onClick={() => {
                if (!selection) return;
                const [st_index, ed_index] = selection.column;
                const deleteRowColOp: SetContextOptions['deleteRowColOp'] = {
                  type: 'column',
                  start: st_index,
                  end: ed_index,
                  id: context.currentSheetId,
                };
                setContext(
                  (draftCtx) => {
                    if (draftCtx.luckysheet_select_save?.length! > 1) {
                      showAlert(rightclick.noMulti, 'ok');
                      draftCtx.contextMenu = {};
                      draftCtx.dataVerificationDropDownList = false;
                      return;
                    }
                    const slen = ed_index - st_index + 1;
                    const index = getSheetIndex(
                      draftCtx,
                      context.currentSheetId,
                    ) as number;
                    if (
                      draftCtx.luckysheetfile[index].data?.[0]?.length! <= slen
                    ) {
                      showAlert(rightclick.cannotDeleteAllColumn, 'ok');
                      draftCtx.contextMenu = {};
                      return;
                    }
                    try {
                      deleteRowCol(draftCtx, deleteRowColOp);
                    } catch (e: any) {
                      if (e.message === 'readOnly') {
                        showAlert(rightclick.cannotDeleteColumnReadOnly, 'ok');
                      }
                    }
                    draftCtx.contextMenu = {};
                  },
                  { deleteRowColOp },
                );
              }}
            >
              <div className="context-item">
                <LucideIcon name="Trash2" />
                <div>
                  {rightclick.deleteSelected}
                  {rightclick.column}
                </div>
              </div>
            </Menu>
          )
        );
      }
      if (name === 'cell-delete-column') {
        return (
          !selection?.row_select && (
            <Menu
              key="cell-delete-col"
              onClick={() => {
                if (!selection) return;
                const [st_index, ed_index] = selection.column;
                const deleteRowColOp: SetContextOptions['deleteRowColOp'] = {
                  type: 'column',
                  start: st_index,
                  end: ed_index,
                  id: context.currentSheetId,
                };
                setContext(
                  (draftCtx) => {
                    if (draftCtx.luckysheet_select_save?.length! > 1) {
                      showAlert(rightclick.noMulti, 'ok');
                      draftCtx.contextMenu = {};
                      draftCtx.dataVerificationDropDownList = false;
                      return;
                    }
                    const slen = ed_index - st_index + 1;
                    const index = getSheetIndex(
                      draftCtx,
                      context.currentSheetId,
                    ) as number;
                    if (
                      draftCtx.luckysheetfile[index].data?.[0]?.length! <= slen
                    ) {
                      showAlert(rightclick.cannotDeleteAllColumn, 'ok');
                      draftCtx.contextMenu = {};
                      return;
                    }
                    try {
                      deleteRowCol(draftCtx, deleteRowColOp);
                    } catch (e: any) {
                      if (e.message === 'readOnly') {
                        showAlert(rightclick.cannotDeleteColumnReadOnly, 'ok');
                      }
                    }
                    draftCtx.contextMenu = {};
                  },
                  { deleteRowColOp },
                );
              }}
            >
              <div className="context-item">
                <LucideIcon name="Trash2" />
                <div>
                  {rightclick.deleteSelected}
                  {rightclick.column}
                </div>
              </div>
            </Menu>
          )
        );
      }
      if (name === 'delete-row') {
        return (
          selection?.row_select && (
            <Menu
              key="delete-row"
              onClick={() => {
                if (!selection) return;
                const [st_index, ed_index] = selection.row;
                const deleteRowColOp: SetContextOptions['deleteRowColOp'] = {
                  type: 'row',
                  start: st_index,
                  end: ed_index,
                  id: context.currentSheetId,
                };
                setContext(
                  (draftCtx) => {
                    if (draftCtx.luckysheet_select_save?.length! > 1) {
                      showAlert(rightclick.noMulti, 'ok');
                      draftCtx.contextMenu = {};
                      return;
                    }
                    const slen = ed_index - st_index + 1;
                    const index = getSheetIndex(
                      draftCtx,
                      context.currentSheetId,
                    ) as number;
                    if (draftCtx.luckysheetfile[index].data?.length! <= slen) {
                      showAlert(rightclick.cannotDeleteAllRow, 'ok');
                      draftCtx.contextMenu = {};
                      return;
                    }
                    try {
                      deleteRowCol(draftCtx, deleteRowColOp);
                    } catch (e: any) {
                      if (e.message === 'readOnly') {
                        showAlert(rightclick.cannotDeleteRowReadOnly, 'ok');
                      }
                    }
                    draftCtx.contextMenu = {};
                  },
                  { deleteRowColOp },
                );
              }}
            >
              <div className="context-item">
                <LucideIcon name="Trash2" />
                <div>
                  {rightclick.deleteSelected}
                  {rightclick.row}
                </div>
              </div>
            </Menu>
          )
        );
      }
      if (name === 'cell-delete-row') {
        return (
          !selection?.column_select && (
            <Menu
              key="cell-delete-row"
              onClick={() => {
                if (!selection) return;
                const [st_index, ed_index] = selection.row;
                const deleteRowColOp: SetContextOptions['deleteRowColOp'] = {
                  type: 'row',
                  start: st_index,
                  end: ed_index,
                  id: context.currentSheetId,
                };
                setContext(
                  (draftCtx) => {
                    if (draftCtx.luckysheet_select_save?.length! > 1) {
                      showAlert(rightclick.noMulti, 'ok');
                      draftCtx.contextMenu = {};
                      return;
                    }
                    const slen = ed_index - st_index + 1;
                    const index = getSheetIndex(
                      draftCtx,
                      context.currentSheetId,
                    ) as number;
                    if (draftCtx.luckysheetfile[index].data?.length! <= slen) {
                      showAlert(rightclick.cannotDeleteAllRow, 'ok');
                      draftCtx.contextMenu = {};
                      return;
                    }
                    try {
                      deleteRowCol(draftCtx, deleteRowColOp);
                    } catch (e: any) {
                      if (e.message === 'readOnly') {
                        showAlert(rightclick.cannotDeleteRowReadOnly, 'ok');
                      }
                    }
                    draftCtx.contextMenu = {};
                  },
                  { deleteRowColOp },
                );
              }}
            >
              <div className="context-item">
                <LucideIcon name="Trash2" />
                <div>
                  {rightclick.deleteSelected}
                  {rightclick.row}
                </div>
              </div>
            </Menu>
          )
        );
      }
      if (name === 'hide-row') {
        return (
          selection?.row_select &&
          ['hideSelected'].map((item) => (
            <Menu
              key={item}
              onClick={() => {
                setContext((draftCtx) => {
                  let msg = '';
                  if (item === 'hideSelected') {
                    msg = hideSelected(draftCtx, 'row');
                  } else if (item === 'showHide') {
                    showSelected(draftCtx, 'row');
                  }
                  if (msg === 'noMulti') {
                    showDialog(drag.noMulti);
                  }
                  draftCtx.contextMenu = {};
                });
              }}
            >
              <div className="context-item">
                <LucideIcon name="EyeOff" />
                <div>{(rightclick as any)[item] + rightclick.row}</div>
              </div>
            </Menu>
          ))
        );
      }
      if (name === 'hide-column') {
        return (
          selection?.column_select === true &&
          ['hideSelected'].map((item) => (
            <Menu
              key={item}
              onClick={() => {
                setContext((draftCtx) => {
                  let msg = '';
                  if (item === 'hideSelected') {
                    msg = hideSelected(draftCtx, 'column');
                  } else if (item === 'showHide') {
                    showSelected(draftCtx, 'column');
                  }
                  if (msg === 'noMulti') {
                    showDialog(drag.noMulti);
                  }
                  draftCtx.contextMenu = {};
                });
              }}
            >
              <div className="context-item">
                <LucideIcon name="EyeOff" />
                <div>{(rightclick as any)[item] + rightclick.column}</div>
              </div>
            </Menu>
          ))
        );
      }
      if (name === 'set-row-height') {
        return context.luckysheet_select_save?.some(
          (section) => section.row_select,
        ) ? (
          <Menu
            key="set-row-height"
            onClick={() => {
              showDialog(<ResetRowHeight />, undefined, 'Resize row');
              setContext((draftCtx) => {
                draftCtx.contextMenu = {};
              });
            }}
          >
            <div className="context-item">
              <SVGIcon name="resize-flv" width={16} height={16} />
              <div>Resize row height</div>
            </div>
          </Menu>
        ) : null;
      }
      if (name === 'set-column-width') {
        // const colWidth = selection?.width || context.defaultcollen;
        // const shownColWidth = context.luckysheet_select_save?.some(
        //   (section) =>
        //     section.width_move !==
        //     (colWidth + 1) * (section.column[1] - section.column[0] + 1) - 1
        // )
        //   ? ""
        //   : colWidth;
        return context.luckysheet_select_save?.some(
          (section) => section.column_select,
        ) ? (
          <Menu
            key="set-column-width"
            onClick={() => {
              showDialog(<ResetColumnWidth />, undefined, 'Resize column');
              setContext((draftCtx) => {
                draftCtx.contextMenu = {};
              });
            }}
          >
            <div className="context-item">
              <SVGIcon name="resize-flv" width={16} height={16} />
              <div>Resize column width</div>
            </div>
          </Menu>
        ) : null;
      }
      if (name === 'clear') {
        const headerMenu = context.contextMenu.headerMenu as any;
        const isRowHeaderMenu = headerMenu === 'row';
        const isColumnHeaderMenu = headerMenu === true;
        const isRowSelectionInCellMenu = selection?.row_select === true;
        const isColumnSelectionInCellMenu = selection?.column_select === true;
        const shouldShowRowClear = isRowHeaderMenu || isRowSelectionInCellMenu;
        const shouldShowColumnClear =
          isColumnHeaderMenu || isColumnSelectionInCellMenu;

        if (!shouldShowRowClear && !shouldShowColumnClear) {
          return null;
        }

        const clearLabel = shouldShowRowClear
          ? `Clear ${rightclick.row.toLowerCase()}`
          : `Clear ${rightclick.column.toLowerCase()}`;
        return (
          <Menu
            key={name}
            onClick={() => {
              setContext((draftCtx) => {
                const allowEdit = isAllowEdit(draftCtx);
                if (!allowEdit) return;

                if (draftCtx.activeImg != null) {
                  removeActiveImage(draftCtx);
                } else {
                  const msg = deleteSelectedCellText(draftCtx);
                  if (msg === 'partMC') {
                    showDialog(generalDialog.partiallyError, 'ok');
                  } else if (msg === 'allowEdit') {
                    showDialog(generalDialog.readOnlyError, 'ok');
                  } else if (msg === 'dataNullError') {
                    showDialog(generalDialog.dataNullError, 'ok');
                  }
                }
                draftCtx.contextMenu = {};
                jfrefreshgrid(draftCtx, null, undefined);
              });
            }}
          >
            <div className="context-item">
              <LucideIcon name="Eraser" />
              <p>{clearLabel}</p>
            </div>
          </Menu>
        );
      }
      if (name === 'ascSort') {
        return (
          <Menu
            key={name}
            onClick={() => {
              if (context.allowEdit === false) return;
              setContext((draftCtx) => {
                sortSelection(draftCtx, true);
                draftCtx.contextMenu = {};
                draftCtx.contextMenu = {};
              });
              // showDialog(
              //   <DataVerification />,
              //   undefined,
              //   toolbar.dataVerification
              // );
            }}
          >
            <div className="context-item">
              <LucideIcon name="ArrowDown01" />
              <p>Ascending sort</p>
            </div>
          </Menu>
        );
      }
      if (name === 'desSort') {
        return (
          <Menu
            key={name}
            onClick={() => {
              if (context.allowEdit === false) return;
              setContext((draftCtx) => {
                sortSelection(draftCtx, false);
                draftCtx.contextMenu = {};
                draftCtx.contextMenu = {};
              });
              // showDialog(
              //   <DataVerification />,
              //   undefined,
              //   toolbar.dataVerification
              // );
            }}
          >
            <div className="context-item">
              <LucideIcon name="ArrowDown10" />
              <p>Descending sort</p>
            </div>
          </Menu>
        );
      }
      if (name === 'sort') {
        const { sort } = locale(context);
        return (
          <Tippy
            key={name}
            placement="right-start"
            interactive
            interactiveBorder={50}
            offset={[0, 0]}
            arrow={false}
            zIndex={3000}
            appendTo={document.body}
            onShow={() => {
              setActiveMenu('sort');
            }}
            onHide={() => {
              if (activeMenu === 'sort') setActiveMenu('');
            }}
            content={
              <div
                className="fortune-toolbar-select"
                style={{ minWidth: '11.25rem' }}
              >
                <div className="flex flex-col color-text-default text-body-sm">
                  <Menu
                    onClick={() => {
                      setContext((draftCtx) => {
                        sortSelection(draftCtx, true);
                        draftCtx.contextMenu = {};
                      });
                    }}
                  >
                    <div
                      className="context-item p-2 w-full"
                      style={{ height: '40px' }}
                    >
                      <LucideIcon name="ArrowUp" />
                      <p>{sort.asc}</p>
                    </div>
                  </Menu>
                  <Menu
                    onClick={() => {
                      setContext((draftCtx) => {
                        sortSelection(draftCtx, false);
                        draftCtx.contextMenu = {};
                      });
                    }}
                  >
                    <div
                      className="context-item p-2 w-full"
                      style={{ height: '40px' }}
                    >
                      <LucideIcon name="ArrowDown" />
                      <p>{sort.desc}</p>
                    </div>
                  </Menu>
                  {/* <Menu
                    onClick={() => {
                      setContext((draftCtx) => {
                        showDialog(<CustomSort />);
                        draftCtx.contextMenu = {};
                      });
                    }}
                  >
                    <div
                      className="context-item p-2 w-full"
                      style={{ height: "40px" }}
                    >
                      <SVGIcon
                        name="sort"
                        width={22}
                        style={{ marginRight: "4px" }}
                      />
                      <p>{sort.custom}</p>
                    </div>
                  </Menu> */}
                </div>
              </div>
            }
            trigger="mouseenter focus"
            hideOnClick={false}
          >
            <div>
              <Menu isActive={activeMenu === 'sort'}>
                <div className="flex items-center justify-between w-full">
                  <div className="context-item">
                    <LucideIcon name="ArrowDownUp" />
                    <p>{rightclick.sortSelection}</p>
                  </div>
                  <LucideIcon name="ChevronRight" width={16} height={16} />
                </div>
              </Menu>
            </div>
          </Tippy>
        );
      }
      if (name === 'filter') {
        const { filter } = locale(context);
        return (
          <Tippy
            key={name}
            placement="right-start"
            interactive
            interactiveBorder={50}
            offset={[0, 0]}
            arrow={false}
            zIndex={3000}
            appendTo={document.body}
            content={
              <div
                className="fortune-toolbar-select"
                style={{ minWidth: '11.25rem' }}
              >
                <div className="flex flex-col color-text-default text-body-sm">
                  <Menu
                    onClick={() => {
                      setContext((draftCtx) => {
                        createFilter(draftCtx);
                        draftCtx.contextMenu = {};
                      });
                    }}
                  >
                    <div
                      className="context-item p-2 w-full"
                      style={{ height: '32px' }}
                    >
                      <LucideIcon name="Filter" className="w-4 h-4" />
                      <p>{filter.filter}</p>
                    </div>
                  </Menu>
                  <Menu
                    onClick={() => {
                      setContext((draftCtx) => {
                        clearFilter(draftCtx);
                        draftCtx.contextMenu = {};
                      });
                    }}
                  >
                    <div
                      className="context-item p-2 w-full"
                      style={{ height: '32px' }}
                    >
                      <LucideIcon name="Eraser" />
                      <p>{filter.clearFilter}</p>
                    </div>
                  </Menu>
                </div>
              </div>
            }
            trigger="mouseenter focus"
            hideOnClick={false}
            onShow={() => {
              setActiveMenu('filter');
            }}
            onHide={() => {
              if (activeMenu === 'filter') setActiveMenu('');
            }}
          >
            <div>
              <Menu isActive={activeMenu === 'filter'}>
                <div className="flex items-center justify-between w-full">
                  <div className="context-item">
                    <LucideIcon name="Filter" />
                    <p>{rightclick.filterSelection}</p>
                  </div>
                  <LucideIcon
                    name="ChevronRight"
                    width={16}
                    height={16}
                    className="w-4 h-4 color-text-secondary"
                  />
                </div>
              </Menu>
            </div>
          </Tippy>
        );
      }
      if (name === 'image') {
        return (
          <Menu
            key={name}
            onClick={() => {
              setContext((draftCtx) => {
                showImgChooser();
                draftCtx.contextMenu = {};
              });
            }}
          >
            {rightclick.image}
          </Menu>
        );
      }
      if (name === 'link') {
        return (
          <Menu
            key={name}
            onClick={() => {
              setContext((draftCtx) => {
                handleLink(
                  draftCtx,
                  refs.cellInput.current ?? undefined,
                  refs.globalCache,
                );
                draftCtx.contextMenu = {};
              });
            }}
          >
            <div className="context-item">
              <LucideIcon name="Link" />
              <p>{rightclick.link}</p>
            </div>
          </Menu>
        );
      }
      if (name === 'conditionFormat') {
        return (
          <Menu
            key={name}
            onClick={() => {
              if (context.allowEdit === false) return;
              setContext((draftCtx) => {
                draftCtx.contextMenu = {};
              });
              // @ts-ignore
              window.conditionalFormatClick(context.luckysheet_select_save);
            }}
          >
            <div className="context-item">
              <LucideIcon name="PaintbrushVertical" />
              <p>Conditional formatting</p>
            </div>
          </Menu>
        );
      }
      if (name === 'clear-format') {
        return (
          <Menu
            key={name}
            onClick={() => {
              if (context.allowEdit === false) return;
              setContext((draftCtx) => {
                draftCtx.contextMenu = {};
                // @ts-ignore
                if (draftCtx.contextMenu.headerMenu === 'row') {
                  clearRowsCellsFormat(draftCtx);
                } else if (draftCtx.contextMenu.headerMenu === true) {
                  clearColumnsCellsFormat(draftCtx);
                } else if (!draftCtx.contextMenu.headerMenu) {
                  clearSelectedCellFormat(draftCtx);
                }
              });
            }}
          >
            <div className="context-item">
              <LucideIcon name="RemoveFormatting" />
              <p>Clear formatting</p>
            </div>
          </Menu>
        );
      }
      return null;
    },
    [
      context,
      setContext,
      refs.globalCache,
      rightclick,
      showAlert,
      showDialog,
      drag.noMulti,
      info.tipRowHeightLimit,
      info.tipColumnWidthLimit,
      generalDialog.partiallyError,
      generalDialog.readOnlyError,
      generalDialog.dataNullError,
      activeMenu,
    ],
  );

  useLayoutEffect(() => {
    // re-position the context menu if it overflows the window
    if (!containerRef.current) {
      return;
    }
    const winH = window.innerHeight;
    const winW = window.innerWidth;
    const rect = containerRef.current.getBoundingClientRect();
    const workbookRect =
      refs.workbookContainer.current?.getBoundingClientRect();
    if (!workbookRect) {
      return;
    }
    const menuW = rect.width;
    const menuH = rect.height;
    let top = contextMenu.y || 0;
    let left = contextMenu.x || 0;

    let hasOverflow = false;
    if (workbookRect.left + left + menuW > winW) {
      left -= menuW;
      hasOverflow = true;
    }
    if (workbookRect.top + top + menuH > winH) {
      top -= menuH;
      hasOverflow = true;
    }
    if (top < 0) {
      top = 0;
      hasOverflow = true;
    }
    if (hasOverflow) {
      setContext((draftCtx) => {
        draftCtx.contextMenu.x = left;
        draftCtx.contextMenu.y = top;
      });
    }
  }, [contextMenu.x, contextMenu.y, refs.workbookContainer, setContext]);

  if (_.isEmpty(context.contextMenu)) return null;

  const selection = context.luckysheet_select_save?.[0];
  const rowSpan = selection ? selection.row[1] - selection.row[0] + 1 : 1;
  const colSpan = selection ? selection.column[1] - selection.column[0] + 1 : 1;
  const insertRowLabel =
    rowSpan === 1 ? 'Insert row' : `Insert ${rowSpan} rows`;
  const insertColumnLabel =
    colSpan === 1 ? 'Insert column' : `Insert ${colSpan} columns`;
  const deleteRowTargetLabel =
    selection == null
      ? `${rowSpan} rows`
      : rowSpan === 1
        ? `row ${selection.row[0] + 1}`
        : `row ${selection.row[0] + 1} - ${selection.row[1] + 1}`;
  const deleteColumnTargetLabel =
    selection == null
      ? `${colSpan} columns`
      : colSpan === 1
        ? `column ${indexToColumnChar(selection.column[0])}`
        : `column ${indexToColumnChar(selection.column[0])} - ${indexToColumnChar(selection.column[1])}`;
  const isDeleteShortcutMenu =
    (context.contextMenu as any).menuType === 'delete-shortcut';
  const isInsertShortcutMenu =
    (context.contextMenu as any).menuType === 'insert-shortcut';
  type ShortcutActionItem = {
    key: string;
    label: React.ReactNode;
    onClick: () => void;
  };
  const shortcutPrimaryItems: ShortcutActionItem[] = isDeleteShortcutMenu
    ? [
        {
          key: 'delete-cells-shift-left',
          label: (
            <>
              Delete cells and shift <strong>left</strong>
            </>
          ),
          onClick: () => applyDeleteCellsShift('left'),
        },
        {
          key: 'delete-cells-shift-up',
          label: (
            <>
              Delete cells and shift <strong>up</strong>
            </>
          ),
          onClick: () => applyDeleteCellsShift('up'),
        },
      ]
    : [
        {
          key: 'insert-cells-shift-right',
          label: (
            <>
              Insert cells and shift <strong>right</strong>
            </>
          ),
          onClick: () => applyInsertCellsShift('right'),
        },
        {
          key: 'insert-cells-shift-down',
          label: (
            <>
              Insert cells and shift <strong>down</strong>
            </>
          ),
          onClick: () => applyInsertCellsShift('down'),
        },
      ];
  const shortcutSecondaryItems: ShortcutActionItem[] = isDeleteShortcutMenu
    ? [
        {
          key: 'delete-row-range',
          label: (
            <>
              Delete <strong>{deleteRowTargetLabel}</strong>
            </>
          ),
          onClick: deleteSelectedRowRange,
        },
        {
          key: 'delete-column-range',
          label: (
            <>
              Delete <strong>{deleteColumnTargetLabel}</strong>
            </>
          ),
          onClick: deleteSelectedColumnRange,
        },
      ]
    : [
        {
          key: 'insert-row-range',
          label: insertRowLabel,
          onClick: insertSelectedRowRange,
        },
        {
          key: 'insert-column-range',
          label: insertColumnLabel,
          onClick: insertSelectedColumnRange,
        },
      ];
  const renderShortcutMenuItems = () => (
    <>
      {shortcutPrimaryItems.map((item) => (
        <Menu key={item.key} onClick={item.onClick}>
          <div className="context-item">
            <p>{item.label}</p>
          </div>
        </Menu>
      ))}
      <Divider
        key={
          isDeleteShortcutMenu
            ? 'delete-shortcut-divider'
            : 'insert-shortcut-divider'
        }
      />
      {shortcutSecondaryItems.map((item) => (
        <Menu key={item.key} onClick={item.onClick}>
          <div className="context-item">
            <p>{item.label}</p>
          </div>
        </Menu>
      ))}
    </>
  );

  return (
    <div
      className="fortune-context-menu luckysheet-cols-menu"
      ref={containerRef}
      onContextMenu={(e) => e.stopPropagation()}
      style={{
        left: Math.max(0, contextMenu.x ?? 0),
        top: contextMenu.y,
      }}
    >
      {isDeleteShortcutMenu || isInsertShortcutMenu
        ? renderShortcutMenuItems()
        : context.contextMenu.headerMenu === true ||
            /* @ts-ignore */
            context.contextMenu.headerMenu === 'row'
          ? settings.headerContextMenu.map((menu, i) => {
              return getMenuElement(menu, i);
            })
          : settings.cellContextMenu.map((menu, i) => getMenuElement(menu, i))}
    </div>
  );
};

export default ContextMenu;
