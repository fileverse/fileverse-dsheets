import numeral from 'numeral';
import _ from 'lodash';
// import { execfunction, functionCopy, update } from ".";
import {
  Cell,
  CellMatrix,
  Context,
  diff,
  getFlowdata,
  getSheetIndex,
  isdatetime,
  isRealNull,
  isRealNum,
  remapFormulaReferencesByMap,
  setCellValue,
} from '..';
import { jfrefreshgrid } from './refresh';

export function orderbydata(
  isAsc: boolean,
  index: number,
  data: (Cell | null)[][],
) {
  if (isAsc == null) {
    isAsc = true;
  }
  const a = (x: any, y: any) => {
    let x1 = x[index];
    let y1 = y[index];
    if (x[index] != null) {
      x1 = x[index].v;
    }
    if (y[index] != null) {
      y1 = y[index].v;
    }
    if (isRealNull(x1)) {
      return isAsc ? 1 : -1;
    }

    if (isRealNull(y1)) {
      return isAsc ? -1 : 1;
    }
    if (isdatetime(x1) && isdatetime(y1)) {
      return diff(x1, y1);
    }
    if (isRealNum(x1) && isRealNum(y1)) {
      const y1Value = numeral(y1).value();
      const x1Value = numeral(x1).value();
      if (y1Value == null || x1Value == null) return null;
      return x1Value - y1Value;
    }
    if (!isRealNum(x1) && !isRealNum(y1)) {
      return x1.localeCompare(y1, 'zh');
    }
    if (!isRealNum(x1)) {
      return 1;
    }
    if (!isRealNum(y1)) {
      return -1;
    }
    return 0;
  };
  const d = (x: any, y: any) => a(y, x);
  const sortedWithIndex = data.map((row, i) => ({
    row,
    originalIndex: i,
  }));
  sortedWithIndex.sort((x, y) => (isAsc ? a(x.row, y.row) : d(x.row, y.row)));

  const sortedData = sortedWithIndex.map((item) => item.row);
  const rowMap: Record<number, number> = {};
  sortedWithIndex.forEach((item, newIndex) => {
    rowMap[item.originalIndex] = newIndex;
  });

  return { sortedData, rowMap };
}

export function sortDataRange(
  ctx: Context,
  sheetData: CellMatrix,
  dataRange: CellMatrix,
  index: number,
  isAsc: boolean,
  str: number,
  edr: number,
  stc: number,
  edc: number,
) {
  const { sortedData, rowMap } = orderbydata(isAsc, index, dataRange);

  for (let r = str; r <= edr; r += 1) {
    for (let c = stc; c <= edc; c += 1) {
      const cell = sortedData[r - str][c - stc];
      // if (cell?.f) {
      //   const moveOffset = rowOffsets[r - str];
      //   let func = cell?.f!;
      //   if (moveOffset > 0) {
      //     func = `=${functionCopy(ctx, func, "down", moveOffset)}`;
      //   } else if (moveOffset < 0) {
      //     func = `=${functionCopy(ctx, func, "up", -moveOffset)}`;
      //   }
      //   const funcV = execfunction(ctx, func, r, c, undefined, undefined, true);
      //   [, cell!.v, cell!.f] = funcV;
      //   cell.m = update(cell.ct?.fa || "General", cell.v);
      // }
      sheetData[r][c] = cell;
    }
  }

  // Sort is a row permutation. Remap references to moved rows for formulas
  // on the current sheet so they keep pointing to the same logical rows.
  const absoluteRowMap: Record<number, number> = {};
  Object.keys(rowMap).forEach((k) => {
    const oldLocal = parseInt(k, 10);
    absoluteRowMap[str + oldLocal] = str + rowMap[oldLocal];
  });

  const sheetIdx = getSheetIndex(ctx, ctx.currentSheetId);
  const sheet = sheetIdx == null ? null : ctx.luckysheetfile[sheetIdx];
  const sheetName = sheet?.name || '';
  if (sheetData && sheetName) {
    for (let r = 0; r < sheetData.length; r += 1) {
      const row = sheetData[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c += 1) {
        const cell = row[c];
        if (!cell?.f) continue;
        cell.f = remapFormulaReferencesByMap(cell.f, sheetName, sheetName, {
          rowMap: absoluteRowMap,
        });
      }
    }
  }

  // Keep formula dependency locations aligned with row permutation.
  sheet?.calcChain?.forEach((item: any) => {
    const mapped = absoluteRowMap[item.r];
    if (!_.isNil(mapped)) {
      item.r = mapped;
    }
  });

  // let allParam = {};
  // if (ctx.config.rowlen != null) {
  //   let cfg = _.assign({}, ctx.config);
  //   cfg = rowlenByRange(d, str, edr, cfg);

  //   allParam = {
  //     cfg,
  //     RowlChange: true,
  //   };
  // }
  jfrefreshgrid(ctx, sheetData, [{ row: [str, edr], column: [stc, edc] }]);

  // Sync sorted values to Yjs (sorting rewrites many cells without setCellValue()).
  if (ctx?.hooks?.updateCellYdoc) {
    const changes: {
      sheetId: string;
      path: string[];
      key?: string;
      value: any;
      type?: 'update' | 'delete';
    }[] = [];
    for (let r = str; r <= edr; r += 1) {
      const row = sheetData[r] || [];
      for (let c = stc; c <= edc; c += 1) {
        changes.push({
          sheetId: ctx.currentSheetId,
          path: ['celldata'],
          value: { r, c, v: row?.[c] ?? null },
          key: `${r}_${c}`,
          type: 'update',
        });
      }
    }
    if (changes.length > 0) ctx.hooks.updateCellYdoc(changes);
  }
}

export function sortSelection(
  ctx: Context,
  isAsc: boolean,
  colIndex: number = 0,
) {
  // if (!checkProtectionAuthorityNormal(ctx.currentSheetIndex, "sort")) {
  //   return;
  // }
  if (ctx.allowEdit === false) return;
  if (ctx.luckysheet_select_save == null) return;
  if (ctx.luckysheet_select_save.length > 1) {
    // if (isEditMode()) {
    //   alert("不能对多重选择区域执行此操作，请选择单个区域，然后再试");
    // } else {
    //   tooltip.info(
    //     "不能对多重选择区域执行此操作，请选择单个区域，然后再试",
    //     ""
    //   );
    // }

    return;
  }

  if (isAsc == null) {
    isAsc = true;
  }
  // const d = editor.deepCopyFlowData(Store.flowdata);
  const flowdata = getFlowdata(ctx);
  const d = flowdata;
  if (d == null) return;

  const r1 = ctx.luckysheet_select_save[0].row[0];
  const r2 = ctx.luckysheet_select_save[0].row[1];
  const c1 = ctx.luckysheet_select_save[0].column[0];
  const c2 = ctx.luckysheet_select_save[0].column[1];

  let str: number | null = null;
  let edr;

  for (let r = r1; r <= r2; r += 1) {
    if (d[r] != null && d[r][c1] != null) {
      const cell = d[r][c1];
      if (cell == null) return; //
      if (cell.mc != null || isRealNull(cell.v)) {
        continue;
      }
      if (str == null && /[\u4e00-\u9fa5]+/g.test(`${cell.v}`)) {
        str = r + 1;
        edr = r + 1;
        continue;
      }

      if (str == null) {
        str = r;
      }

      edr = r;
    }
  }

  if (str == null || str > r2) {
    return;
  }

  let hasMc = false; // 排序选区是否有合并单元格
  const data: CellMatrix = [];
  if (edr == null) return;
  for (let r = str; r <= edr; r += 1) {
    const data_row = [];
    for (let c = c1; c <= c2; c += 1) {
      if (d[r][c] != null && d[r][c]?.mc != null) {
        hasMc = true;
        break;
      }

      data_row.push(d[r][c]);
    }

    data.push(data_row);
  }

  if (hasMc) {
    // if (isEditMode()) {
    //   alert("选区有合并单元格，无法执行此操作！");
    // } else {
    //   tooltip.info("选区有合并单元格，无法执行此操作！", "");
    // }

    return;
  }

  sortDataRange(ctx, d, data, colIndex, isAsc, str, edr, c1, c2);
}

export function sortSheetBySelectedColumn(ctx: Context, isAsc: boolean) {
  if (ctx.allowEdit === false) return;
  const flowdata = getFlowdata(ctx);
  if (!flowdata || flowdata.length === 0) return;

  const selection = ctx.luckysheet_select_save?.[0];
  const selectedColumn = selection?.column_focus ?? selection?.column?.[0] ?? 0;

  let str: number | null = null;
  let edr: number | null = null;
  let stc: number | null = null;
  let edc: number | null = null;

  for (let r = 0; r < flowdata.length; r += 1) {
    const row = flowdata[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c];
      if (cell == null) continue;
      const hasContent =
        !isRealNull(cell?.v) ||
        !isRealNull(cell?.m) ||
        !isRealNull(cell?.f) ||
        cell?.mc != null;
      if (!hasContent) continue;
      if (str == null || r < str) str = r;
      if (edr == null || r > edr) edr = r;
      if (stc == null || c < stc) stc = c;
      if (edc == null || c > edc) edc = c;
    }
  }

  if (str == null || edr == null || stc == null || edc == null) return;
  if (selectedColumn < stc || selectedColumn > edc) return;

  let hasMc = false;
  const data: CellMatrix = [];
  for (let r = str; r <= edr; r += 1) {
    const rowData: (Cell | null)[] = [];
    for (let c = stc; c <= edc; c += 1) {
      const cell = flowdata?.[r]?.[c] ?? null;
      if (cell?.mc != null) {
        hasMc = true;
        break;
      }
      rowData.push(cell);
    }
    if (hasMc) break;
    data.push(rowData);
  }

  if (hasMc) return;

  sortDataRange(
    ctx,
    flowdata,
    data,
    selectedColumn - stc,
    isAsc,
    str,
    edr,
    stc,
    edc,
  );
}

function createRowsOrColumnsForSpilledValues(
  ctx: Context,
  startRow: number,
  startColumn: number,
  spillRows: number,
  spillCols: number,
) {
  const flowdata = getFlowdata(ctx);
  if (!flowdata) return;
  const cellChanges: {
    sheetId: string;
    path: string[];
    key?: string;
    value: any;
    type?: 'update' | 'delete';
  }[] = [];

  // update luckysheetfile metadata if needed
  try {
    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const sheet = ctx.luckysheetfile[sheetIndex];

    const requiredRowCount = startRow + spillRows;
    const requiredColCount = startColumn + spillCols;

    if (sheet.row && sheet.row < requiredRowCount) {
      sheet.row = requiredRowCount;
    }
    if (sheet.column && sheet.column < requiredColCount) {
      sheet.column = requiredColCount;
    }
  } catch (error) {
    console.error('Failed to update sheet metadata for spill operation', error);
  }

  const requiredRowCount = startRow + spillRows;
  const requiredColCount = startColumn + spillCols;

  // make sure the matrix has at least `startRow + spillRows` rows.
  while (flowdata.length < requiredRowCount) {
    flowdata.push([]); // push empty row
  }
  // For each row that will be touched by the spill:
  for (let rowIndex = startRow; rowIndex < requiredRowCount; rowIndex++) {
    if (!Array.isArray(flowdata[rowIndex])) {
      flowdata[rowIndex] = [];
    }

    // Ensure the row has at least `startColumn + spillCols` columns.
    const prevLen = flowdata[rowIndex].length;
    while (flowdata[rowIndex].length < requiredColCount) {
      flowdata[rowIndex].push(null);
    }
    for (let c = Math.max(prevLen, startColumn); c < requiredColCount; c += 1) {
      cellChanges.push({
        sheetId: ctx.currentSheetId,
        path: ['celldata'],
        value: { r: rowIndex, c, v: flowdata[rowIndex][c] ?? null },
        key: `${rowIndex}_${c}`,
        type: 'update',
      });
    }
  }

  if (cellChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
    ctx.hooks.updateCellYdoc(cellChanges);
  }
}

export function spillSortResult(
  ctx: Context,
  startRow: number,
  startCol: number,
  formulaResult: any, // expects { f: string, v: any[][] }
  flowdata?: CellMatrix,
): boolean {
  const formulaString = formulaResult?.f;
  const formulaValue = formulaResult?.v;

  // make sure it is a formula result from a function that spills an array
  if (
    typeof formulaString !== 'string' ||
    !(
      /= *SORT\s*\(/i.test(formulaString) ||
      /= *XLOOKUP\s*\(/i.test(formulaString) ||
      /= *SEQUENCE\s*\(/i.test(formulaString) ||
      /= *FILTER\s*\(/i.test(formulaString)
    )
  )
    return false;
  if (!Array.isArray(formulaValue)) return false;

  // make sure result is a 2D array
  const valueMatrix: any[][] = Array.isArray(formulaValue[0])
    ? formulaValue
    : formulaValue.map((x) => [x]);

  const rowCount = valueMatrix.length;
  const colCount =
    rowCount && Array.isArray(valueMatrix[0]) ? valueMatrix[0].length : 0;
  if (!rowCount || !colCount) return false;

  // make sure the sheet has enough rows/cols for spilling the result
  createRowsOrColumnsForSpilledValues(
    ctx,
    startRow,
    startCol,
    rowCount,
    colCount,
  );

  const sheetData = flowdata || getFlowdata(ctx);
  if (!sheetData) return false;

  // write the first cell with the formula reference
  setCellValue(ctx, startRow, startCol, sheetData, {
    ...formulaResult,
    v: valueMatrix[0][0],
    tb: '1',
  });

  // spill the rest of the result to the grid
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      if (r === 0 && c === 0) continue; // already handled above
      const cellValue = valueMatrix[r][c];
      setCellValue(ctx, startRow + r, startCol + c, sheetData, {
        v: cellValue,
        ct: { fa: 'General', t: typeof cellValue === 'number' ? 'n' : 'g' },
        tb: '1',
      });
    }
  }

  if (ctx?.hooks?.updateCellYdoc) {
    const cellChanges: {
      sheetId: string;
      path: string[];
      key?: string;
      value: any;
      type?: 'update' | 'delete';
    }[] = [];
    for (let r = 0; r < rowCount; r += 1) {
      const rr = startRow + r;
      const row = sheetData?.[rr] || [];
      for (let c = 0; c < colCount; c += 1) {
        const cc = startCol + c;
        cellChanges.push({
          sheetId: ctx.currentSheetId,
          path: ['celldata'],
          value: { r: rr, c: cc, v: row?.[cc] ?? null },
          key: `${rr}_${cc}`,
          type: 'update',
        });
      }
    }
    if (cellChanges.length > 0) ctx.hooks.updateCellYdoc(cellChanges);
  }

  return true;
}
