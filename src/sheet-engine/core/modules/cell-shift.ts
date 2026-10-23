import _ from 'lodash';
import type { Context } from '../context';
import type { Cell } from '../types';
import { getSheetIndex } from '../utils';
import {
  emitCelldataRangeDiffToYdoc,
  snapshotPersistedCelldataInRange,
} from '../utils/ydoc-celldata-changes';
import { jfrefreshgrid } from './refresh';

/** A selection rectangle: `row` and `column` are [start, end]. */
export type CellShiftRange = {
  row: number[];
  column: number[];
};

type Rect = { r1: number; r2: number; c1: number; c2: number };
type Grid = (Cell | null)[][];

/**
 * Shift cells of the current sheet and write the moved block to Yjs (B6).
 * Formula references to shifted cells are not rewritten (unchanged behaviour).
 */
const shiftCells = (
  ctx: Context,
  affected: (totalRows: number, totalCols: number) => Rect,
  mutate: (data: Grid, totalRows: number, totalCols: number) => void,
) => {
  const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
  if (_.isNil(sheetIndex)) return;
  const sheet = ctx.luckysheetfile[sheetIndex];
  const data = sheet?.data as Grid | undefined;
  if (!data?.length || !data[0]?.length) return;
  const totalRows = sheet.row ?? data.length;
  const totalCols = sheet.column ?? data[0].length;

  const rect = affected(totalRows, totalCols);
  const before = snapshotPersistedCelldataInRange(
    data,
    rect.r1,
    rect.r2,
    rect.c1,
    rect.c2,
  );
  mutate(data, totalRows, totalCols);
  emitCelldataRangeDiffToYdoc(
    ctx,
    ctx.currentSheetId,
    data,
    rect.r1,
    rect.r2,
    rect.c1,
    rect.c2,
    before,
  );
  jfrefreshgrid(ctx, null, undefined);
};

/** Delete the selected cells and shift the rest left or up. */
export function deleteCellsShift(
  ctx: Context,
  direction: 'left' | 'up',
  range: CellShiftRange,
) {
  const [rowStart, rowEnd] = range.row;
  const [colStart, colEnd] = range.column;
  const rowCount = rowEnd - rowStart + 1;
  const colCount = colEnd - colStart + 1;

  shiftCells(
    ctx,
    (totalRows, totalCols) =>
      direction === 'left'
        ? { r1: rowStart, r2: rowEnd, c1: colStart, c2: totalCols - 1 }
        : { r1: rowStart, r2: totalRows - 1, c1: colStart, c2: colEnd },
    (data, totalRows, totalCols) => {
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
    },
  );
}

/** Insert empty cells at the selection and shift the rest right or down. */
export function insertCellsShift(
  ctx: Context,
  direction: 'right' | 'down',
  range: CellShiftRange,
) {
  const [rowStart, rowEnd] = range.row;
  const [colStart, colEnd] = range.column;
  const rowCount = rowEnd - rowStart + 1;
  const colCount = colEnd - colStart + 1;

  shiftCells(
    ctx,
    (totalRows, totalCols) =>
      direction === 'right'
        ? { r1: rowStart, r2: rowEnd, c1: colStart, c2: totalCols - 1 }
        : { r1: rowStart, r2: totalRows - 1, c1: colStart, c2: colEnd },
    (data, totalRows, totalCols) => {
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
    },
  );
}
