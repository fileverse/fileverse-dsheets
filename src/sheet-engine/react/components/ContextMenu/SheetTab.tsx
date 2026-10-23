import { locale, deleteSheet, api } from '@sheet-engine/core';
import _ from 'lodash';
import React, {
  useContext,
  useRef,
  useState,
  useLayoutEffect,
  useCallback,
} from 'react';
import { LucideIcon } from '@fileverse/ui';
import WorkbookContext from '../../context';
import { useAlert } from '../../hooks/useAlert';
import { useOutsideClick } from '../../hooks/useOutsideClick';
import { ChangeColor } from '../ChangeColor';
import Divider from './Divider';
import './index.css';
import Menu from './Menu';
import {
  COPY_SHEET_LINK_ITEM,
  getVisibleSheetTabMenuItems,
  isSheetTabReadOnly,
} from './sheet-tab-menu-items';

const SheetTabContextMenu: React.FC = () => {
  const { context, setContext, settings } = useContext(WorkbookContext);
  const { x, y, sheet, onRename } = context.sheetTabContextMenu;
  const { sheetconfig } = locale(context);
  const [position, setPosition] = useState({ x: -1, y: -1 });
  const [isShowChangeColor, setIsShowChangeColor] = useState<boolean>(false);
  const [isShowInputColor, setIsShowInputColor] = useState<boolean>(false);
  const { showAlert, hideAlert } = useAlert();
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setContext((ctx) => {
      ctx.sheetTabContextMenu = {};
    });
  }, [setContext]);

  useLayoutEffect(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect && x != null && y != null) {
      setPosition({ x, y: y - rect.height });
    }
  }, [x, y]);

  useOutsideClick(containerRef, close, [close]);

  const moveSheet = useCallback(
    (delta: number) => {
      if (context.allowEdit === false) return;
      if (!sheet) return;
      setContext((ctx) => {
        let currentOrder = -1;
        _.sortBy(ctx.luckysheetfile, ['order']).forEach((_sheet, i) => {
          _sheet.order = i;
          if (_sheet.id === sheet.id) {
            currentOrder = i;
          }
        });
        api.setSheetOrder(ctx, { [sheet.id!]: currentOrder + delta });
      });
    },
    [context.allowEdit, setContext, sheet],
  );

  const hideSheet = useCallback(() => {
    if (context.allowEdit === false) return;
    if (!sheet) return;
    setContext((ctx) => {
      const shownSheets = ctx.luckysheetfile.filter(
        (oneSheet) => _.isUndefined(oneSheet.hide) || oneSheet?.hide !== 1,
      );
      if (shownSheets.length > 1) {
        api.hideSheet(ctx, sheet.id as string);
      } else {
        showAlert(sheetconfig.noMoreSheet, 'ok');
      }
    });
  }, [context.allowEdit, setContext, sheet, showAlert, sheetconfig]);

  const copySheet = useCallback(() => {
    if (context.allowEdit === false) return;
    if (!sheet?.id) return;
    setContext(
      (ctx) => {
        api.copySheet(ctx, sheet.id!);
      },
      { addSheetOp: true },
    );
  }, [context.allowEdit, setContext, sheet?.id]);
  const updateShowInputColor = useCallback((state: boolean) => {
    setIsShowInputColor(state);
  }, []);

  const focusSheet = useCallback(() => {
    if (context.allowEdit === false) return;
    if (!sheet?.id) return;
    setContext((ctx) => {
      _.forEach(ctx.luckysheetfile, (sheetfile) => {
        sheetfile.status = sheet.id === sheetfile.id ? 1 : 0;
      });
    });
  }, [context.allowEdit, setContext, sheet?.id]);

  const onCopySheetLink = context.hooks.onCopySheetLink;
  const visibleItems = getVisibleSheetTabMenuItems(
    settings.sheetTabContextMenu ?? [],
    {
      readOnly: isSheetTabReadOnly(context),
      hasCopyLink: typeof onCopySheetLink === 'function',
    },
  );

  if (!sheet || x == null || y == null || visibleItems.length === 0) {
    return null;
  }

  return (
    <div
      className="fortune-context-menu luckysheet-cols-menu"
      onContextMenu={(e) => e.stopPropagation()}
      style={{ left: position.x, top: position.y, overflow: 'visible' }}
      ref={containerRef}
    >
      {visibleItems.map((name, i) => {
        if (name === COPY_SHEET_LINK_ITEM) {
          return (
            <Menu
              key={name}
              onClick={() => {
                if (sheet.id) {
                  onCopySheetLink?.({
                    sheetId: sheet.id,
                    sheetName: sheet.name,
                  });
                }
                close();
              }}
            >
              {sheetconfig.copyLink}
            </Menu>
          );
        }
        if (name === 'delete') {
          return (
            <Menu
              key={name}
              onClick={() => {
                const shownSheets = context.luckysheetfile.filter(
                  (singleSheet) =>
                    _.isUndefined(singleSheet.hide) || singleSheet.hide !== 1,
                );
                if (
                  context.luckysheetfile.length > 1 &&
                  shownSheets.length > 1
                ) {
                  showAlert(sheetconfig.confirmDelete, 'yesno', () => {
                    setContext(
                      (ctx) => {
                        deleteSheet(ctx, sheet.id!);
                      },
                      {
                        deleteSheetOp: {
                          id: sheet.id!,
                        },
                      },
                    );
                    hideAlert();
                  });
                } else {
                  showAlert(sheetconfig.noMoreSheet, 'ok');
                }
                close();
              }}
            >
              {sheetconfig.delete}
            </Menu>
          );
        }
        if (name === 'rename') {
          return (
            <Menu
              key={name}
              onClick={() => {
                onRename?.();
                close();
              }}
            >
              {sheetconfig.rename}
            </Menu>
          );
        }
        if (name === 'move') {
          return (
            <React.Fragment key={name}>
              <Menu
                onClick={() => {
                  moveSheet(-1.5);
                  close();
                }}
              >
                {sheetconfig.moveLeft}
              </Menu>
              <Menu
                onClick={() => {
                  moveSheet(1.5);
                  close();
                }}
              >
                {sheetconfig.moveRight}
              </Menu>
            </React.Fragment>
          );
        }
        if (name === 'hide') {
          return (
            <Menu
              key={name}
              onClick={() => {
                hideSheet();
                close();
              }}
            >
              {sheetconfig.hide}
            </Menu>
          );
        }
        if (name === 'copy') {
          return (
            <Menu
              key={name}
              onClick={() => {
                copySheet();
                close();
              }}
            >
              {sheetconfig.copy}
            </Menu>
          );
        }
        if (name === 'color') {
          return (
            <Menu
              key={name}
              onMouseEnter={() => {
                setIsShowChangeColor(true);
              }}
              onMouseLeave={() => {
                if (!isShowInputColor) {
                  setIsShowChangeColor(false);
                }
              }}
            >
              <div className="flex items-center justify-between w-full">
                {sheetconfig.changeColor}
                <LucideIcon name="ChevronRight" size="sm" />
                {isShowChangeColor && context.allowEdit && (
                  <ChangeColor triggerParentUpdate={updateShowInputColor} />
                )}
              </div>
            </Menu>
          );
        }
        if (name === 'focus') {
          return (
            <Menu
              key={name}
              onClick={() => {
                focusSheet();
                close();
              }}
            >
              {sheetconfig.focus}
            </Menu>
          );
        }
        if (name === '|') {
          return <Divider key={`divide-${i}`} />;
        }
        return null;
      })}
    </div>
  );
};

export default SheetTabContextMenu;
