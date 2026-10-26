import _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import { dataToCelldata, getSheet } from './common';
import { applyMergeConfigToData } from '../utils/merge-hydrate';
import { applyCellFormatRangesToData, getCellFormatRangeGridBounds } from '../utils/range-format';
import { Context } from '../context';
import { CellMatrix, CellWithRowAndCol, Sheet } from '../types';
import { getSheetIndex } from '../utils';
import {
  api,
  changeSheet,
  execfunction,
  getFlowdata,
  insertUpdateFunctionGroup,
  locale,
  spillSortResult,
} from '..';

function isCellReferenced(formulaString: string, cell: string): boolean {
  type Cell = { col: number; row: number };

  // Convert column letters to number (A -> 1, Z -> 26, AA -> 27)
  function colToNumber(col: string): number {
    let num = 0;
    for (let i = 0; i < col.length; i += 1) {
      num = num * 26 + (col.charCodeAt(i) - 64);
    }
    return num;
  }

  // Parse "A12" → { col, row }
  function parseCell(cellRef: string): Cell | null {
    const match = cellRef.match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    return {
      col: colToNumber(match[1]),
      row: Number(match[2]),
    };
  }

  const target = parseCell(cell.toUpperCase());
  if (!target) return false;

  const formula = formulaString.toUpperCase();

  // 1️⃣ Check ranges (A1:B5)
  const rangeRegex = /([A-Z]+\d+):([A-Z]+\d+)/g;
  let match: RegExpExecArray | null;

  while ((match = rangeRegex.exec(formula)) !== null) {
    const start = parseCell(match[1])!;
    const end = parseCell(match[2])!;

    if (
      target.col >= Math.min(start.col, end.col) &&
      target.col <= Math.max(start.col, end.col) &&
      target.row >= Math.min(start.row, end.row) &&
      target.row <= Math.max(start.row, end.row)
    ) {
      return true;
    }
  }

  // 2️⃣ Check individual cells (A1, B2, etc.)
  const cleanedFormula = formula.replace(rangeRegex, '');
  const cellRegex = /([A-Z]+\d+)/g;

  while ((match = cellRegex.exec(cleanedFormula)) !== null) {
    if (match[1] === cell.toUpperCase()) {
      return true;
    }
  }

  return false;
}

export function getAllSheets(ctx: Context) {
  return ctx.luckysheetfile;
}

export { getSheet };

export function initSheetData(
  draftCtx: Context,
  index: number,
  newData: Sheet,
): CellMatrix | null {
  const { celldata, row, column } = newData;
  const lastRow = _.maxBy<CellWithRowAndCol>(celldata, 'r');
  const lastCol = _.maxBy(celldata, 'c');
  let lastRowNum = (lastRow?.r ?? 0) + 1;
  let lastColNum = (lastCol?.c ?? 0) + 1;
  if (row != null && column != null && row > 0 && column > 0) {
    lastRowNum = Math.max(lastRowNum, row);
    lastColNum = Math.max(lastColNum, column);
  } else {
    lastRowNum = Math.max(lastRowNum, draftCtx.defaultrowNum);
    lastColNum = Math.max(lastColNum, draftCtx.defaultcolumnNum);
  }
  const rangeBounds = getCellFormatRangeGridBounds(newData.config?.cellFormatRanges);
  if (rangeBounds) {
    lastRowNum = Math.max(lastRowNum, rangeBounds.maxRow + 1);
    lastColNum = Math.max(lastColNum, rangeBounds.maxCol + 1);
  }
  if (lastRowNum && lastColNum) {
    const expandedData: Sheet['data'] = _.times(lastRowNum, () =>
      _.times(lastColNum, () => null),
    );
    celldata?.forEach((d) => {
      expandedData[d.r][d.c] = d.v;
    });
    applyCellFormatRangesToData(expandedData, newData.config?.cellFormatRanges);
    applyMergeConfigToData(expandedData, newData.config?.merge);
    if (draftCtx.luckysheetfile[index] == null) {
      newData.data = expandedData;
      delete newData.celldata;
      draftCtx.luckysheetfile.push(newData);
    } else {
      draftCtx.luckysheetfile[index].data = expandedData;
      delete draftCtx.luckysheetfile[index].celldata;
    }
    return expandedData;
  }
  return null;
}

/** Build dense `data` from sparse `celldata` when a sheet is activated or referenced. */
export function ensureSheetFlowdata(
  ctx: Context,
  options: { index?: number; id?: string } = {},
): CellMatrix | null {
  const index =
    options.index ?? getSheetIndex(ctx, options.id ?? ctx.currentSheetId);
  if (index == null) return null;
  const sheet = ctx.luckysheetfile[index];
  if (!sheet) return null;
  if (sheet.data?.length) {
    return sheet.data;
  }
  return initSheetData(ctx, index, sheet);
}

export function hideSheet(ctx: Context, sheetId: string) {
  const index = getSheetIndex(ctx, sheetId) as number;
  ctx.luckysheetfile[index].hide = 1;
  ctx.luckysheetfile[index].status = 0;
  const shownSheets = ctx.luckysheetfile.filter(
    (sheet) => _.isUndefined(sheet.hide) || sheet?.hide !== 1,
  );
  ctx.currentSheetId = shownSheets[0].id as string;
}

export function showSheet(ctx: Context, sheetId: string) {
  const index = getSheetIndex(ctx, sheetId) as number;
  ctx.luckysheetfile[index].hide = undefined;
}

function generateCopySheetName(ctx: Context, sheetId: string) {
  const { info } = locale(ctx);
  const copyWord = `(${info.copy}`;
  const SheetIndex = getSheetIndex(ctx, sheetId) as number;
  let sheetName = ctx.luckysheetfile[SheetIndex].name;
  const copy_i = sheetName.indexOf(copyWord);
  let index: number = 0;

  if (copy_i !== -1) {
    sheetName = sheetName.toString().substring(0, copy_i);
  }

  const nameCopy = sheetName + copyWord;
  const sheetNames = [];

  for (let i = 0; i < ctx.luckysheetfile.length; i += 1) {
    const fileName = ctx.luckysheetfile[i].name;
    sheetNames.push(fileName);
    const st_i = fileName.indexOf(nameCopy);

    if (st_i === 0) {
      index = index || 2;
      const ed_i = fileName.indexOf(')', st_i + nameCopy.length);
      const num = fileName.substring(st_i + nameCopy.length, ed_i);

      if (_.isNumber(num)) {
        if (Number.parseInt(num, 10) >= index) {
          index = Number.parseInt(num, 10) + 1;
        }
      }
    }
  }

  let sheetCopyName;

  do {
    const postfix = `${copyWord + (index || '')})`;
    const lengthLimit = 31 - postfix.length;
    sheetCopyName = sheetName;
    if (sheetCopyName.length > lengthLimit) {
      sheetCopyName = `${sheetCopyName.slice(0, lengthLimit - 1)}…`;
    }
    sheetCopyName += postfix;
    index = (index || 1) + 1;
  } while (sheetNames.indexOf(sheetCopyName) !== -1);

  return sheetCopyName;
}

export function copySheet(ctx: Context, sheetId: string) {
  const index = getSheetIndex(ctx, sheetId) as number;
  const order = ctx.luckysheetfile[index].order! + 1;
  const sheetName = generateCopySheetName(ctx, sheetId);
  const sheetData = _.cloneDeep(ctx.luckysheetfile[index]);
  // The copy's formulas enter the chain without being evaluated (C8).
  ctx.formulaCache.markDepGraphIncomplete();
  delete sheetData.id;
  delete sheetData.status;
  sheetData.celldata = dataToCelldata(sheetData.data);
  delete sheetData.data;
  api.addSheet(
    ctx,
    undefined,
    uuidv4(),
    ctx.luckysheetfile[index].isPivotTable,
    sheetName,
    sheetData,
  );
  // Fix formula references: cloned calcChain (and dynamic arrays) still had the original sheet id.
  // Formula execution and groupValuesRefresh use entry.id to target the sheet; wrong id writes to the wrong sheet.
  const newSheetIndex = ctx.luckysheetfile.length - 1;
  const newSheet = ctx.luckysheetfile[newSheetIndex];
  const newSheetId = newSheet.id as string;
  if (newSheet.calcChain?.length) {
    newSheet.calcChain = newSheet.calcChain
      .filter(
        (entry: { r?: number; c?: number; id?: string } | null | undefined) =>
          entry != null &&
          typeof entry.r === 'number' &&
          typeof entry.c === 'number',
      )
      .map((entry: { r: number; c: number; id?: string }) => ({
        ...entry,
        id: newSheetId,
      }));
  }
  if (newSheet.dynamicArray?.length) {
    newSheet.dynamicArray = newSheet.dynamicArray.map(
      (entry: { id?: string; [k: string]: any }) =>
        entry && typeof entry === 'object' && 'id' in entry
          ? { ...entry, id: newSheetId }
          : entry,
    );
  }
  if (newSheet.dynamicArray_compute?.length) {
    newSheet.dynamicArray_compute = newSheet.dynamicArray_compute.map(
      (entry: { id?: string; [k: string]: any }) =>
        entry && typeof entry === 'object' && 'id' in entry
          ? { ...entry, id: newSheetId }
          : entry,
    );
  }
  const sheetOrderList: Record<string, number> = {};
  sheetOrderList[newSheetId] = order;
  api.setSheetOrder(ctx, sheetOrderList);

  // Make the duplicated sheet active before doing any full-sheet external sync.
  // Some integrations derive the active sheet from ctx.currentSheetId.
  changeSheet(ctx, newSheetId, undefined, true, true);

  // Duplicating a sheet bypasses per-cell update flows; ensure external sync (e.g. Yjs) gets a full snapshot.
  // Prefer updateAllCell for performance; otherwise emit celldata updates for the new sheet.
  if (ctx?.hooks?.updateAllCell) {
    ctx.hooks.updateAllCell(newSheetId, 'duplicateSheet');
  } else if (ctx?.hooks?.updateCellYdoc) {
    const changes: any[] = [];
    const celldata = newSheet.celldata || dataToCelldata(newSheet.data);
    if (Array.isArray(celldata)) {
      celldata.forEach((d: any) => {
        if (d == null) return;
        const { r } = d;
        const { c } = d;
        if (!_.isNumber(r) || !_.isNumber(c)) return;
        changes.push({
          sheetId: newSheetId,
          path: ['celldata'],
          key: `${r}_${c}`,
          value: { r, c, v: d.v ?? null },
          type: d.v == null ? 'delete' : 'update',
        });
      });
    }
    if (changes.length > 0) ctx.hooks.updateCellYdoc(changes);
  }
}

export function calculateSheetFromula(ctx: Context, id: string) {
  const index = getSheetIndex(ctx, id) as number;
  if (!ctx.luckysheetfile[index].data) return;
  for (let r = 0; r < ctx.luckysheetfile[index].data!.length; r += 1) {
    for (let c = 0; c < ctx.luckysheetfile[index].data![r].length; c += 1) {
      if (
        !ctx.luckysheetfile[index].data![r][c]?.f ||
        ctx.luckysheetfile[index].data![r][c]?.isDataBlockFormula
      ) {
        continue;
      }
      const result = execfunction(
        ctx,
        ctx.luckysheetfile[index].data![r][c]?.f!,
        r,
        c,
        id,
      );
      const isValueArray = Array.isArray(result[1]);
      if (isValueArray) {
        const value = { f: result[2], v: result[1] };
        spillSortResult(ctx, r, c, value, getFlowdata(ctx)!);
      } else {
        api.setCellValue(ctx, r, c, result[1], null);
      }
      insertUpdateFunctionGroup(ctx, r, c, id);
    }
  }
}

export function calculateReferencedCellSheetFromula(
  ctx: Context,
  id: string,
  refCell?: string[],
) {
  const index = getSheetIndex(ctx, id) as number;
  if (!ctx.luckysheetfile[index].data) return;
  for (let r = 0; r < ctx.luckysheetfile[index].data!.length; r += 1) {
    for (let c = 0; c < ctx.luckysheetfile[index].data![r].length; c += 1) {
      let isRef = false;
      if (
        refCell &&
        ctx.luckysheetfile[index].data![r][c]?.f &&
        !ctx.luckysheetfile[index].data![r][c]?.isDataBlockFormula
      ) {
        isRef = refCell.some((cell) => {
          return isCellReferenced(
            ctx.luckysheetfile[index].data![r][c]?.f!,
            cell,
          );
        });
      }
      if (
        !isRef ||
        !ctx.luckysheetfile[index].data![r][c]?.f ||
        ctx.luckysheetfile[index].data![r][c]?.isDataBlockFormula
      ) {
        continue;
      }
      const result = execfunction(
        ctx,
        ctx.luckysheetfile[index].data![r][c]?.f!,
        r,
        c,
        id,
      );
      const isValueArray = Array.isArray(result[1]);
      if (isValueArray) {
        const value = { f: result[2], v: result[1] };
        spillSortResult(ctx, r, c, value, getFlowdata(ctx)!);
      } else {
        api.setCellValue(ctx, r, c, result[1], null);
      }
      insertUpdateFunctionGroup(ctx, r, c, id);
    }
  }
}
