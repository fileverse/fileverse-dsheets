import {
  getCellValue,
  getDropdownList,
  getFlowdata,
  getSheetIndex,
  mergeBorder,
  setDropdownValue,
  api,
} from '@sheet-engine/core';
import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button, IconButton } from '@fileverse/ui';
import WorkbookContext from '../../context';
import { useOutsideClick } from '../../hooks/useOutsideClick';
import SVGIcon from '../SVGIcon';

import './index.css';

const DropDownList: React.FC = () => {
  const { context, setContext } = useContext(WorkbookContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const [list, setList] = useState<any[]>([]);
  const [isMul, setIsMul] = useState<boolean>(false);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const [selected, setSelected] = useState<any[]>([]);
  const [rbgColor, setRbgColor] = useState<string[]>([]);
  // The cell this list was opened for. Option clicks write here, not to the
  // current selection, which can move (keyboard nav) while the list is open.
  const anchorRef = useRef<{
    sheetId: string;
    row: number;
    column: number;
  } | null>(null);

  const closeList = useCallback(() => {
    setContext((ctx) => {
      ctx.dataVerificationDropDownList = false;
    });
  }, [setContext]);

  const close = useCallback(() => {
    setContext((ctx) => {
      const last =
        ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
      const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
      const verification = ctx.luckysheetfile[index]?.dataVerification;
      if (!last || !verification?.[`${last.row_focus}_${last.column_focus}`]) {
        ctx.dataVerificationDropDownList = false;
      }
    });
  }, [setContext]);

  useOutsideClick(containerRef, close, [close]);

  // 初始化
  useEffect(() => {
    if (!context.luckysheet_select_save?.length) {
      closeList();
      return;
    }
    const last =
      context.luckysheet_select_save[context.luckysheet_select_save.length - 1];
    const rowIndex = last.row_focus;
    const colIndex = last.column_focus;
    if (rowIndex == null || colIndex == null) {
      closeList();
      return;
    }
    let row = context.visibledatarow[rowIndex];
    let col_pre = colIndex === 0 ? 0 : context.visibledatacolumn[colIndex - 1];
    const d = getFlowdata(context);
    if (!d) return;
    const margeSet = mergeBorder(context, d, rowIndex, colIndex);
    if (margeSet) {
      [, row] = margeSet.row;
      [col_pre, ,] = margeSet.column;
    }
    const index = getSheetIndex(context, context.currentSheetId) as number;
    const item =
      context.luckysheetfile[index]?.dataVerification?.[
        `${rowIndex}_${colIndex}`
      ];
    if (!item) {
      // Selection moved to a cell without a rule: the list would be stale.
      closeList();
      return;
    }
    anchorRef.current = {
      sheetId: context.currentSheetId,
      row: rowIndex,
      column: colIndex,
    };
    const dropdownList = getDropdownList(context, item.value1);
    // 初始化多选的下拉列表
    const cellValue = getCellValue(rowIndex, colIndex, d);

    // Reset when re-anchoring to another cell so checks don't carry over.
    setSelected(cellValue ? cellValue.toString().split(',') : []);

    const { color } = item;
    // const color = context.dataVerification!.dataRegulation!.color.split(",")
    const colorValues: string[] =
      color?.split(',').map((v: any) => v.trim()) ?? [];
    // Group every 3 values into RGB arrays
    const rbgColorArr = [];
    for (let i = 0; i < colorValues.length; i += 3) {
      rbgColorArr.push(colorValues.slice(i, i + 3).join(', '));
    }
    setRbgColor(rbgColorArr);

    setList(dropdownList);
    setPosition({
      left: col_pre,
      top: row,
    });
    setIsMul(item.type2 === 'true');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.luckysheet_select_save]);

  // 设置下拉列表的值
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const { row: rowIndex, column: colIndex } = anchor;
    const index = getSheetIndex(context, anchor.sheetId) as number;
    const item =
      context.luckysheetfile[index]?.dataVerification?.[
        `${rowIndex}_${colIndex}`
      ];
    if (!item) {
      // Rule removed (undo, collaborator) while the list was open.
      closeList();
      return;
    }
    if (item.type2 !== 'true') return;
    const d = getFlowdata(context);
    if (!d) return;
    const cellValue = getCellValue(rowIndex, colIndex, d);
    if (cellValue) {
      setSelected(cellValue.toString().split(','));
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.luckysheetfile]);

  return (
    <div
      id="luckysheet-dataVerification-dropdown-List"
      style={position}
      ref={containerRef}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      tabIndex={0}
    >
      {list.map((v, i) => {
        return (
          <div
            className="dropdown-List-item mb-1"
            style={{ backgroundColor: `rgb(${rbgColor[i]})` || 'red' }}
            key={i}
            onClick={() => {
              const anchor = anchorRef.current;
              setContext((ctx) => {
                if (!anchor || anchor.sheetId !== ctx.currentSheetId) {
                  ctx.dataVerificationDropDownList = false;
                  return;
                }
                const arr = selected;
                const index = arr.indexOf(v);
                if (index < 0) {
                  arr.push(v);
                } else {
                  arr.splice(index, 1);
                }
                setSelected(arr);
                setDropdownValue(ctx, v, arr, anchor);
              });
            }}
            tabIndex={0}
          >
            <SVGIcon
              name="check"
              width={12}
              style={{
                verticalAlign: 'middle',
                display: isMul && selected.indexOf(v) >= 0 ? 'inline' : 'none',
              }}
            />
            {v}
          </div>
        );
      })}
      <hr
        style={{
          border: 'none',
          height: '1px',
          background: 'hsl(var(--color-bg-default-hover))',
          marginBottom: '4px',
        }}
      />

      <div
        className="w-full flex align-center edit-dropdown"
        style={{ height: '28px' }}
        onClick={() => {
          const selectedCells = api.getSelection(context);
          // @ts-ignore
          window?.dataVerificationClick?.(selectedCells);
          setContext((ctx) => {
            ctx.dataVerificationDropDownList = false;
          });
        }}
      >
        <IconButton
          icon="Pencil"
          size="sm"
          variant="ghost"
          className="color-picker-icon color-picker edit-dropdown"
          style={{ paddingTop: '0px !important' }}
        />
        <Button
          size="md"
          variant="ghost"
          className="color-picker-reset color-picker edit-dropdown"
          // style={{paddingTop: "0px !important"}}
        >
          Edit
        </Button>
      </div>
    </div>
  );
};
export default DropDownList;
