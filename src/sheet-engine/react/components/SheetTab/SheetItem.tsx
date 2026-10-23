import {
  Sheet,
  editSheetName,
  cancelNormalSelected,
  cancelActiveImgItem,
  getSheetIndex,
  defaultLuckysheetSelectRanges,
  activateSheetForNavigation,
} from '@sheet-engine/core';
import _ from 'lodash';
import React, {
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import WorkbookContext from '../../context';
import { useAlert } from '../../hooks/useAlert';
import SVGIcon from '../SVGIcon';
import { canOpenSheetTabMenu } from '../ContextMenu/sheet-tab-menu-items';

type Props = {
  sheet: Sheet;
  isDropPlaceholder?: boolean;
};

const toCssId = (s: string) =>
  String(s)
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-');

const SheetItem: React.FC<Props> = ({ sheet, isDropPlaceholder }) => {
  const { context, setContext, refs, settings } = useContext(WorkbookContext);
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const editable = useRef<HTMLSpanElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const { showAlert } = useAlert();
  const sheetIdClass =
    sheet.id != null ? toCssId(String(sheet.id)) : 'placeholder';
  const sheetNameClass = sheet.name ? toCssId(sheet.name) : '';

  useEffect(() => {
    setContext((draftCtx) => {
      const r = context.sheetScrollRecord[draftCtx?.currentSheetId];
      if (r) {
        draftCtx.scrollLeft = r.scrollLeft ?? 0;
        draftCtx.scrollTop = r.scrollTop ?? 0;
        draftCtx.luckysheet_select_status = r.luckysheet_select_status ?? false;
        draftCtx.luckysheet_select_save = r.luckysheet_select_save
          ? _.cloneDeep(r.luckysheet_select_save)
          : undefined;
      } else {
        draftCtx.scrollLeft = 0;
        draftCtx.scrollTop = 0;
        draftCtx.luckysheet_select_status = false;
        if (settings.suppressInitialCellSelection) {
          draftCtx.luckysheet_select_save = undefined;
        } else {
          const sheetIdx = getSheetIndex(draftCtx, draftCtx.currentSheetId);
          const sh =
            sheetIdx != null ? draftCtx.luckysheetfile[sheetIdx] : undefined;
          if (sh) {
            if (!_.isEmpty(sh.luckysheet_select_save)) {
              draftCtx.luckysheet_select_save = _.cloneDeep(
                sh.luckysheet_select_save,
              );
            } else {
              draftCtx.luckysheet_select_save = defaultLuckysheetSelectRanges(
                sh.data,
              );
            }
          } else {
            draftCtx.luckysheet_select_save = undefined;
          }
        }
      }
      draftCtx.luckysheet_selection_range = [];
    });
  }, [
    context.currentSheetId,
    context.sheetScrollRecord,
    setContext,
    settings.suppressInitialCellSelection,
  ]);

  useEffect(() => {
    if (!editable.current) return;
    if (editing) {
      // select all when enter editing mode
      if (window.getSelection) {
        const range = document.createRange();
        range.selectNodeContents(editable.current);
        if (
          range.startContainer &&
          document.body.contains(range.startContainer)
        ) {
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        // @ts-ignore
      } else if (document.selection) {
        // @ts-ignore
        const range = document.body.createTextRange();
        range.moveToElementText(editable.current);
        range.select();
      }
    }

    // store the current text
    editable.current.dataset.oldText = editable.current.innerText;
  }, [editing]);

  const onBlur = useCallback(() => {
    setContext((draftCtx) => {
      try {
        editSheetName(draftCtx, editable.current!);
      } catch (e: any) {
        showAlert(e.message);
      }
    });
    setEditing(false);
  }, [setContext, showAlert]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === 'Enter') {
      editable.current?.blur();
    }
    e.stopPropagation();
  }, []);

  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (context.allowEdit === true && !context.isFlvReadOnly)
        e.dataTransfer.setData('sheetId', `${sheet.id}`);
      e.stopPropagation();
    },
    [context.allowEdit, sheet.id],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (context.allowEdit === false) return;
      const draggingId = e.dataTransfer.getData('sheetId');
      setContext((draftCtx) => {
        const droppingId = sheet.id;
        let draggingSheet: Sheet | undefined;
        let droppingSheet: Sheet | undefined;
        _.sortBy(draftCtx.luckysheetfile, ['order']).forEach((f, i) => {
          f.order = i;
          if (f.id === draggingId) {
            draggingSheet = f;
          } else if (f.id === droppingId) {
            droppingSheet = f;
          }
        });
        if (draggingSheet && droppingSheet) {
          draggingSheet.order = droppingSheet.order! - 0.1;
          // re-order all sheets
          _.sortBy(draftCtx.luckysheetfile, ['order']).forEach((f, i) => {
            f.order = i;
          });
        } else if (draggingSheet && isDropPlaceholder) {
          draggingSheet.order = draftCtx.luckysheetfile.length;
        }
      });
      setDragOver(false);
      e.stopPropagation();
    },
    [context.allowEdit, isDropPlaceholder, setContext, sheet.id],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragEnter={(e) => {
        setDragOver(true);
        e.stopPropagation();
      }}
      onDragLeave={(e) => {
        setDragOver(false);
        e.stopPropagation();
      }}
      onDragEnd={(e) => {
        setDragOver(false);
        e.stopPropagation();
      }}
      onDrop={onDrop}
      onDragStart={onDragStart}
      draggable={context.allowEdit && !editing}
      key={sheet.id}
      ref={containerRef}
      className={
        isDropPlaceholder
          ? 'fortune-sheettab-item fortune-sheettab-placeholder'
          : `fortune-sheettab-item fortune-sheettab-item--${sheetIdClass}${
              sheetNameClass
                ? ` fortune-sheettab-item--name-${sheetNameClass}`
                : ''
            } luckysheet-sheets-item${
              context.currentSheetId === sheet.id
                ? ' luckysheet-sheets-item-active'
                : ''
            }`
      }
      data-sheet-id={sheet.id != null ? String(sheet.id) : undefined}
      data-sheet-name={sheet.name || undefined}
      data-testid={`sheettab-item-${sheet.id ?? 'placeholder'}`}
      onClick={() => {
        if (isDropPlaceholder) return;
        setContext((draftCtx) => {
          cancelActiveImgItem(draftCtx, refs.globalCache);
          const outcome = activateSheetForNavigation(draftCtx, sheet.id!);
          if (outcome === 'cancel-edit') {
            cancelNormalSelected(draftCtx);
          }
        });
      }}
      tabIndex={0}
      onContextMenu={(e) => {
        if (!canOpenSheetTabMenu(context, context.hooks)) return;
        if (isDropPlaceholder) return;
        const rect = refs.workbookContainer.current!.getBoundingClientRect();
        const { pageX, pageY } = e;
        setContext((ctx) => {
          // 右击的时候先进行跳转
          ctx.dataVerificationDropDownList = false;
          ctx.currentSheetId = sheet.id!;
          ctx.zoomRatio = sheet.zoomRatio || 1;
          ctx.sheetTabContextMenu = {
            x: pageX - rect.left - window.scrollX,
            y: pageY - rect.top - window.scrollY,
            sheet,
            onRename: () => setEditing(true),
          };
        });
      }}
      style={{
        borderLeft: dragOver ? '2px solid #0188fb' : '',
        display: sheet.hide === 1 ? 'none' : '',
      }}
    >
      {editing === false && (
        <p
          className="fortune-sheettab-item__para luckysheet-sheets-item-name"
          onDoubleClick={() => {
            if (context.isFlvReadOnly) return;
            setEditing(true);
          }}
          data-testid={`sheettab-item-para-${sheet.id ?? 'placeholder'}`}
        >
          {sheet.name}
        </p>
      )}
      {editing && (
        <span
          className="fortune-sheettab-item__para luckysheet-sheets-item-name"
          spellCheck="false"
          suppressContentEditableWarning
          contentEditable={isDropPlaceholder ? false : editing}
          onDoubleClick={() => {
            if (context.isFlvReadOnly) return;
            setEditing(true);
          }}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          ref={editable}
          style={dragOver ? { pointerEvents: 'none' } : {}}
          data-testid={`sheettab-item-para-editable-${
            sheet.id ?? 'placeholder'
          }`}
        >
          {sheet.name}
        </span>
      )}
      <span
        className="fortune-sheettab-item__icon fortune-sheettab-item__action fortune-sheettab-item__icon--menu luckysheet-sheets-item-function"
        style={{
          marginRight: '4px',
          marginLeft: '4px',
        }}
        data-sheet-id={sheet.id != null ? String(sheet.id) : undefined}
        data-testid={`sheettab-item-icon-menu-${sheet.id ?? 'placeholder'}`}
        onClick={(e) => {
          if (isDropPlaceholder) return;
          if (!canOpenSheetTabMenu(context, context.hooks)) return;
          const rect = refs.workbookContainer.current!.getBoundingClientRect();
          const { pageX, pageY } = e;
          setContext((ctx) => {
            // 右击的时候先进行跳转
            ctx.currentSheetId = sheet.id!;
            ctx.sheetTabContextMenu = {
              x: pageX - rect.left - window.scrollX,
              y: pageY - rect.top - window.scrollY,
              sheet,
              onRename: () => setEditing(true),
            };
          });
        }}
        tabIndex={0}
      >
        <SVGIcon
          name="downArrow"
          width={12}
          style={{ fill: 'hsl(var(--color-text-default))' }}
        />
      </span>
      {!!sheet.color && (
        <div
          className="luckysheet-sheets-item-color"
          style={{ background: sheet.color }}
        />
      )}
    </div>
  );
};

export default SheetItem;
