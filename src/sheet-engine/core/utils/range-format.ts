import _ from "lodash";
import { Cell, CellMatrix, CellWithRowAndCol, Sheet } from "../types";
import {
  extractCellFormatAttrs,
  hasCellMeaningfulContent,
} from "./cell-persist-utils";

export type CellFormatRange = {
  row: [number, number];
  column: [number, number];
  tb?: string;
  ht?: number | string;
  vt?: number | string;
  tr?: string;
  fs?: number;
  ff?: number | string;
  fc?: string;
  bl?: number;
  it?: number;
  un?: number;
  cl?: number;
  bg?: string;
  ct?: Cell["ct"];
};

const RANGE_FORMAT_KEYS: Array<keyof Omit<CellFormatRange, "row" | "column">> =
  ["tb", "ht", "vt", "tr", "fs", "ff", "fc", "bl", "it", "un", "cl", "bg"];

const CELL_FORMAT_RANGE_ATTR_KEYS = [...RANGE_FORMAT_KEYS, "ct"] as const;

function rangeAttrsKey(range: CellFormatRange): string {
  return JSON.stringify(_.omit(range, ["row", "column"]));
}

function isValidRange(range: CellFormatRange): boolean {
  const [r1, r2] = range.row;
  const [c1, c2] = range.column;
  return r1 <= r2 && c1 <= c2;
}

function rangesEqual(
  a: CellFormatRange[] | undefined,
  b: CellFormatRange[] | undefined,
): boolean {
  return _.isEqual(a ?? [], b ?? []);
}

function mergeAttrsIntoCell(cell: Cell, attrs: Partial<CellFormatRange>) {
  for (const key of RANGE_FORMAT_KEYS) {
    const value = attrs[key];
    if (value != null) {
      (cell as Record<string, unknown>)[key] = value;
    }
  }
  if (attrs.ct) {
    cell.ct = { ...(cell.ct ?? {}), ...attrs.ct };
  }
}

function createFormatOnlyCell(attrs: Partial<CellFormatRange>): Cell {
  const cell: Cell = {};
  mergeAttrsIntoCell(cell, attrs);
  return cell;
}

function canMergeRanges(a: CellFormatRange, b: CellFormatRange): boolean {
  const [ar1, ar2] = a.row;
  const [ac1, ac2] = a.column;
  const [br1, br2] = b.row;
  const [bc1, bc2] = b.column;

  const intersectionRows = Math.max(
    0,
    Math.min(ar2, br2) - Math.max(ar1, br1) + 1,
  );
  const intersectionColumns = Math.max(
    0,
    Math.min(ac2, bc2) - Math.max(ac1, bc1) + 1,
  );
  const unionArea =
    (ar2 - ar1 + 1) * (ac2 - ac1 + 1) +
    (br2 - br1 + 1) * (bc2 - bc1 + 1) -
    intersectionRows * intersectionColumns;
  const boundingArea =
    (Math.max(ar2, br2) - Math.min(ar1, br1) + 1) *
    (Math.max(ac2, bc2) - Math.min(ac1, bc1) + 1);

  // Never merge an L-shaped union: its bounding rectangle includes cells that
  // were not formatted by either range.
  return unionArea === boundingArea;
}

function mergeBounds(a: CellFormatRange, b: CellFormatRange): CellFormatRange {
  return {
    ...a,
    row: [Math.min(a.row[0], b.row[0]), Math.max(a.row[1], b.row[1])],
    column: [
      Math.min(a.column[0], b.column[0]),
      Math.max(a.column[1], b.column[1]),
    ],
  };
}

/** Merge overlapping/adjacent ranges that carry identical format attrs. */
export function normalizeCellFormatRanges(
  ranges: CellFormatRange[] | undefined,
): CellFormatRange[] {
  if (!ranges?.length) return [];

  const valid = ranges.filter(isValidRange);
  const groups = new Map<string, CellFormatRange[]>();

  valid.forEach((range) => {
    const key = rangeAttrsKey(range);
    const bucket = groups.get(key) ?? [];
    bucket.push(range);
    groups.set(key, bucket);
  });

  const merged: CellFormatRange[] = [];

  groups.forEach((bucket) => {
    let pending = [...bucket];
    while (pending.length > 0) {
      let current = pending.shift()!;
      let changed = true;
      while (changed) {
        changed = false;
        pending = pending.filter((candidate) => {
          if (!canMergeRanges(current, candidate)) return true;
          current = mergeBounds(current, candidate);
          changed = true;
          return false;
        });
      }
      merged.push(current);
    }
  });

  return merged;
}

function getIntersection(
  a: CellFormatRange,
  b: CellFormatRange,
): Pick<CellFormatRange, "row" | "column"> | null {
  const row: [number, number] = [
    Math.max(a.row[0], b.row[0]),
    Math.min(a.row[1], b.row[1]),
  ];
  const column: [number, number] = [
    Math.max(a.column[0], b.column[0]),
    Math.min(a.column[1], b.column[1]),
  ];

  return row[0] <= row[1] && column[0] <= column[1] ? { row, column } : null;
}

function splitRangeOutsideIntersection(
  range: CellFormatRange,
  intersection: Pick<CellFormatRange, "row" | "column">,
): CellFormatRange[] {
  const [rowStart, rowEnd] = range.row;
  const [columnStart, columnEnd] = range.column;
  const [
    [intersectionRowStart, intersectionRowEnd],
    [intersectionColumnStart, intersectionColumnEnd],
  ] = [intersection.row, intersection.column];
  const pieces: CellFormatRange[] = [];

  if (rowStart < intersectionRowStart) {
    pieces.push({ ...range, row: [rowStart, intersectionRowStart - 1] });
  }
  if (intersectionRowEnd < rowEnd) {
    pieces.push({ ...range, row: [intersectionRowEnd + 1, rowEnd] });
  }
  if (columnStart < intersectionColumnStart) {
    pieces.push({
      ...range,
      row: [intersectionRowStart, intersectionRowEnd],
      column: [columnStart, intersectionColumnStart - 1],
    });
  }
  if (intersectionColumnEnd < columnEnd) {
    pieces.push({
      ...range,
      row: [intersectionRowStart, intersectionRowEnd],
      column: [intersectionColumnEnd + 1, columnEnd],
    });
  }

  return pieces;
}

function removeRectangleFromRanges(
  ranges: CellFormatRange[] | undefined,
  rectangle: Pick<CellFormatRange, "row" | "column">,
): CellFormatRange[] {
  const target: CellFormatRange = { ...rectangle };
  const next: CellFormatRange[] = [];

  (ranges ?? []).forEach((range) => {
    const intersection = getIntersection(range, target);
    if (!intersection) {
      next.push(range);
      return;
    }
    next.push(...splitRangeOutsideIntersection(range, intersection));
  });

  return next;
}

function compressIndices(indices: number[]): Array<[number, number]> {
  if (!indices.length) return [];
  const sorted = [...indices].sort((a, b) => a - b);
  const segments: Array<[number, number]> = [];
  let start = sorted[0];
  let previous = sorted[0];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    if (current === previous || current === previous + 1) {
      previous = current;
      continue;
    }
    segments.push([start, previous]);
    start = current;
    previous = current;
  }
  segments.push([start, previous]);
  return segments;
}

/**
 * Remap format ranges after a row or column permutation, such as header
 * drag-and-drop. A contiguous source range can become multiple rectangles
 * when the moved indices are no longer contiguous.
 */
export function remapCellFormatRanges(
  ranges: CellFormatRange[] | undefined,
  axis: "row" | "column",
  indexMap: Record<number, number>,
): CellFormatRange[] {
  if (!ranges?.length) return [];

  const remapped: CellFormatRange[] = [];
  ranges.forEach((range) => {
    const [start, end] = axis === "row" ? range.row : range.column;
    const mappedIndices: number[] = [];
    for (let index = start; index <= end; index += 1) {
      mappedIndices.push(indexMap[index] ?? index);
    }

    compressIndices(mappedIndices).forEach(([segmentStart, segmentEnd]) => {
      remapped.push(
        axis === "row"
          ? { ...range, row: [segmentStart, segmentEnd] }
          : { ...range, column: [segmentStart, segmentEnd] },
      );
    });
  });

  return normalizeCellFormatRanges(remapped);
}

/**
 * Move format ranges with a cut-and-paste cell block move. Formatting in both
 * the old source and the overwritten destination is cleared; only the source
 * intersection is translated to the target rectangle.
 */
export function moveCellFormatRanges(
  ranges: CellFormatRange[] | undefined,
  source: Pick<CellFormatRange, "row" | "column">,
  target: Pick<CellFormatRange, "row" | "column">,
): CellFormatRange[] {
  if (!ranges?.length) return [];

  const sourceRange: CellFormatRange = { ...source };
  const rowOffset = target.row[0] - source.row[0];
  const columnOffset = target.column[0] - source.column[0];
  const moved: CellFormatRange[] = [];

  ranges.forEach((range) => {
    const intersection = getIntersection(range, sourceRange);
    if (!intersection) return;
    moved.push({
      ...range,
      row: [intersection.row[0] + rowOffset, intersection.row[1] + rowOffset],
      column: [
        intersection.column[0] + columnOffset,
        intersection.column[1] + columnOffset,
      ],
    });
  });

  const withoutSource = removeRectangleFromRanges(ranges, source);
  const withoutSourceOrTarget = removeRectangleFromRanges(
    withoutSource,
    target,
  );
  return normalizeCellFormatRanges([...withoutSourceOrTarget, ...moved]);
}

function rangeWithoutAttrs(
  range: CellFormatRange,
  attrs: Partial<CellFormatRange>,
  row: [number, number],
  column: [number, number],
): CellFormatRange | null {
  const next: CellFormatRange = { ...range, row, column };
  CELL_FORMAT_RANGE_ATTR_KEYS.forEach((key) => {
    if (attrs[key] != null) delete next[key];
  });

  return CELL_FORMAT_RANGE_ATTR_KEYS.some((key) => next[key] != null)
    ? next
    : null;
}

/**
 * Applies format attributes with "newest write wins" semantics. Existing
 * ranges retain unrelated attributes, but are split around the new selection
 * so an old value for the same attribute can never overlap the new value.
 */
function replaceOverlappingRangeAttrs(
  ranges: CellFormatRange[] | undefined,
  rowSt: number,
  rowEd: number,
  colSt: number,
  colEd: number,
  attrs: Partial<CellFormatRange>,
): CellFormatRange[] {
  const target: CellFormatRange = {
    row: [rowSt, rowEd],
    column: [colSt, colEd],
    ...attrs,
  };
  const next: CellFormatRange[] = [];

  (ranges ?? []).forEach((range) => {
    const intersection = getIntersection(range, target);
    if (!intersection) {
      next.push(range);
      return;
    }

    next.push(...splitRangeOutsideIntersection(range, intersection));

    const retainedAttrs = rangeWithoutAttrs(
      range,
      attrs,
      intersection.row,
      intersection.column,
    );
    if (retainedAttrs) next.push(retainedAttrs);
  });

  next.push(target);
  return normalizeCellFormatRanges(next);
}

/** Remove saved fills from the selected visible rows, then merge once. */
export function clearCellFormatRangeFill(
  ranges: CellFormatRange[] | undefined,
  selection: Pick<CellFormatRange, "row" | "column">,
  hiddenRows: Record<string, number> | undefined,
): { ranges: CellFormatRange[]; changed: boolean } {
  if (!ranges?.length) return { ranges: [], changed: false };
  const hiddenSpans = compressIndices(
    Object.keys(hiddenRows ?? {})
      .map(Number)
      .filter(
        (row) =>
          row >= selection.row[0] &&
          row <= selection.row[1] &&
          hiddenRows?.[row] != null,
      ),
  );
  const next: CellFormatRange[] = [];
  let changed = false;

  for (const range of ranges) {
    const overlap = range.bg != null && getIntersection(range, selection);
    if (!overlap) {
      next.push(range);
      continue;
    }

    const [start, end] = overlap.row;
    const hidden = hiddenSpans.filter(
      ([first, last]) => first <= end && last >= start,
    );
    if (hidden.length === 1 && hidden[0][0] <= start && hidden[0][1] >= end) {
      next.push(range);
      continue;
    }
    changed = true;
    next.push(...splitRangeOutsideIntersection(range, overlap));

    const cleared = { ...range, column: overlap.column };
    delete cleared.bg;
    const hasOtherFormat = CELL_FORMAT_RANGE_ATTR_KEYS.some(
      (key) => cleared[key] != null,
    );

    let row = start;
    for (const [first, last] of hidden) {
      const hiddenStart = Math.max(first, start);
      const hiddenEnd = Math.min(last, end);
      if (hasOtherFormat && row < hiddenStart) {
        next.push({ ...cleared, row: [row, hiddenStart - 1] });
      }
      next.push({
        ...range,
        column: overlap.column,
        row: [hiddenStart, hiddenEnd],
      });
      row = hiddenEnd + 1;
    }
    if (hasOtherFormat && row <= end) next.push({ ...cleared, row: [row, end] });
  }

  return { ranges: changed ? normalizeCellFormatRanges(next) : ranges, changed };
}

export function getCellFormatRangeGridBounds(
  ranges: CellFormatRange[] | undefined,
): { maxRow: number; maxCol: number } | null {
  if (!ranges?.length) return null;
  let maxRow = 0;
  let maxCol = 0;
  ranges.forEach((range) => {
    maxRow = Math.max(maxRow, range.row[1]);
    maxCol = Math.max(maxCol, range.column[1]);
  });
  return { maxRow, maxCol };
}

export function upsertCellFormatRange(
  ranges: CellFormatRange[] | undefined,
  rowSt: number,
  rowEd: number,
  colSt: number,
  colEd: number,
  attrs: Partial<CellFormatRange>,
): { ranges: CellFormatRange[]; changed: boolean } {
  const next = replaceOverlappingRangeAttrs(
    ranges,
    rowSt,
    rowEd,
    colSt,
    colEd,
    attrs,
  );
  return { ranges: next, changed: !rangesEqual(ranges, next) };
}

/**
 * When a cell loses meaningful content but keeps style, put that style back
 * into cellFormatRanges as a 1x1 (normalize merges with neighbours).
 */
export function migrateFormatOnlyCellIntoRanges(
  ranges: CellFormatRange[] | undefined,
  r: number,
  c: number,
  cell: Cell | string | number | boolean | null | undefined,
): { ranges: CellFormatRange[]; changed: boolean } {
  const attrs = extractCellFormatAttrs(cell);
  if (!attrs) {
    return { ranges: ranges ?? [], changed: false };
  }
  return upsertCellFormatRange(
    ranges,
    r,
    r,
    c,
    c,
    attrs as Partial<CellFormatRange>,
  );
}

/**
 * Scan a dense-data rectangle and move any format-only cells into
 * cellFormatRanges. Adjacent identical styles merge via normalize.
 */
export function migrateFormatOnlyCellsFromData(
  ranges: CellFormatRange[] | undefined,
  data: CellMatrix | null | undefined,
  r1: number,
  r2: number,
  c1: number,
  c2: number,
): { ranges: CellFormatRange[]; changed: boolean } {
  if (!data?.length) return { ranges: ranges ?? [], changed: false };

  let next = ranges ?? [];
  let changed = false;
  const rowStart = Math.max(0, r1);
  const rowEnd = Math.min(r2, data.length - 1);
  if (rowStart > rowEnd) return { ranges: next, changed: false };

  for (let r = rowStart; r <= rowEnd; r += 1) {
    const row = data[r];
    if (!row) continue;
    const colStart = Math.max(0, c1);
    const colEnd = Math.min(c2, row.length - 1);
    if (colStart > colEnd) continue;
    for (let c = colStart; c <= colEnd; c += 1) {
      const result = migrateFormatOnlyCellIntoRanges(next, r, c, row[c]);
      if (result.changed) {
        next = result.ranges;
        changed = true;
      }
    }
  }

  return { ranges: next, changed };
}

export function punchHoleInCellFormatRanges(
  ranges: CellFormatRange[] | undefined,
  r: number,
  c: number,
): CellFormatRange[] {
  if (!ranges?.length) return [];
  const out: CellFormatRange[] = [];

  ranges.forEach((range) => {
    const [r1, r2] = range.row;
    const [c1, c2] = range.column;
    if (r < r1 || r > r2 || c < c1 || c > c2) {
      out.push(range);
      return;
    }

    if (r > r1) out.push({ ...range, row: [r1, r - 1] });
    if (r < r2) out.push({ ...range, row: [r + 1, r2] });
    if (c > c1) out.push({ ...range, row: [r, r], column: [c1, c - 1] });
    if (c < c2) out.push({ ...range, row: [r, r], column: [c + 1, c2] });
  });

  return normalizeCellFormatRanges(out);
}

/**
 * Remove format coverage for a whole rectangle in O(ranges), not O(area × ranges).
 * Prefer this over punching cell-by-cell (select-all clear must stay cheap).
 */
export function removeCellFormatRangesInRect(
  ranges: CellFormatRange[] | undefined,
  row: [number, number],
  column: [number, number],
): CellFormatRange[] {
  if (!ranges?.length) return [];
  return normalizeCellFormatRanges(
    removeRectangleFromRanges(ranges, { row, column }),
  );
}

export function punchRectHoleInCellFormatRanges(
  ranges: CellFormatRange[] | undefined,
  rowSt: number,
  rowEd: number,
  colSt: number,
  colEd: number,
): CellFormatRange[] {
  return removeCellFormatRangesInRect(ranges, [rowSt, rowEd], [colSt, colEd]);
}

export function shiftCellFormatRangesOnInsert(
  ranges: CellFormatRange[] | undefined,
  type: "row" | "column",
  index: number,
  count: number,
  direction: "lefttop" | "rightbottom",
): CellFormatRange[] {
  if (!ranges?.length) return [];

  const shifted = ranges
    .map((range) => {
      let [r1, r2] = range.row;
      let [c1, c2] = range.column;

      if (type === "row") {
        if (direction === "lefttop") {
          if (index <= r1) {
            r1 += count;
            r2 += count;
          } else if (index <= r2) {
            r2 += count;
          }
        } else if (index < r1) {
          r1 += count;
          r2 += count;
        } else if (index < r2) {
          r2 += count;
        }
      } else if (direction === "lefttop") {
        if (index <= c1) {
          c1 += count;
          c2 += count;
        } else if (index <= c2) {
          c2 += count;
        }
      } else if (index < c1) {
        c1 += count;
        c2 += count;
      } else if (index < c2) {
        c2 += count;
      }

      if (r2 < r1 || c2 < c1) return null;
      return { ...range, row: [r1, r2], column: [c1, c2] };
    })
    .filter((range): range is CellFormatRange => range != null);

  return normalizeCellFormatRanges(shifted);
}

function splitRangeOnDelete(
  range: CellFormatRange,
  axis: "row" | "column",
  start: number,
  end: number,
  slen: number,
): CellFormatRange[] {
  const [a1, a2] = axis === "row" ? range.row : range.column;

  if (a2 < start) return [range];
  if (a1 > end) {
    const shifted: [number, number] = [a1 - slen, a2 - slen];
    return [
      axis === "row"
        ? { ...range, row: shifted }
        : { ...range, column: shifted },
    ];
  }
  if (a1 >= start && a2 <= end) return [];

  const pieces: CellFormatRange[] = [];
  if (a1 < start) {
    pieces.push(
      axis === "row"
        ? { ...range, row: [a1, start - 1] }
        : { ...range, column: [a1, start - 1] },
    );
  }
  if (a2 > end) {
    pieces.push(
      axis === "row"
        ? { ...range, row: [start, a2 - slen] }
        : { ...range, column: [start, a2 - slen] },
    );
  }
  return pieces.filter(isValidRange);
}

export function shiftCellFormatRangesOnDelete(
  ranges: CellFormatRange[] | undefined,
  type: "row" | "column",
  start: number,
  end: number,
): CellFormatRange[] {
  if (!ranges?.length) return [];
  const slen = end - start + 1;
  const out: CellFormatRange[] = [];

  ranges.forEach((range) => {
    out.push(...splitRangeOnDelete(range, type, start, end, slen));
  });

  return normalizeCellFormatRanges(out);
}

export function applyCellFormatRangesToData(
  data: CellMatrix | null | undefined,
  ranges: CellFormatRange[] | undefined,
) {
  if (!data?.length || !ranges?.length) return;

  for (const range of ranges) {
    const [rowSt, rowEd] = range.row;
    const [colSt, colEd] = range.column;

    for (let r = rowSt; r <= rowEd; r += 1) {
      const row = data[r];
      if (!row) continue;

      for (let c = colSt; c <= colEd; c += 1) {
        const existing = row[c];

        if (existing != null && typeof existing === "object") {
          if (hasCellMeaningfulContent(existing)) {
            mergeAttrsIntoCell(existing, range);
          } else {
            row[c] = createFormatOnlyCell({
              ...(existing as Cell),
              ...range,
            });
          }
        } else if (existing == null) {
          row[c] = createFormatOnlyCell(range);
        } else {
          const cell = createFormatOnlyCell(range);
          cell.v = existing as string | number | boolean;
          row[c] = cell;
        }
      }
    }
  }
}

export function buildSheetDataMatrixForExport(sheet: {
  data?: CellMatrix | null;
  celldata?: CellWithRowAndCol[];
  row?: number;
  column?: number;
  config?: Sheet["config"];
}): CellMatrix {
  if (Array.isArray(sheet.data) && sheet.data.length > 0) {
    return sheet.data;
  }

  const celldata = sheet.celldata ?? [];
  const ranges = sheet.config?.cellFormatRanges;
  const rangeBounds = getCellFormatRangeGridBounds(ranges);

  const lastRow = _.maxBy(celldata, "r");
  const lastCol = _.maxBy(celldata, "c");
  let lastRowNum = (lastRow?.r ?? 0) + 1;
  let lastColNum = (lastCol?.c ?? 0) + 1;

  if (
    sheet.row != null &&
    sheet.column != null &&
    sheet.row > 0 &&
    sheet.column > 0
  ) {
    lastRowNum = Math.max(lastRowNum, sheet.row);
    lastColNum = Math.max(lastColNum, sheet.column);
  }
  if (rangeBounds) {
    lastRowNum = Math.max(lastRowNum, rangeBounds.maxRow + 1);
    lastColNum = Math.max(lastColNum, rangeBounds.maxCol + 1);
  }

  if (!lastRowNum || !lastColNum) return [];

  const expandedData: CellMatrix = _.times(lastRowNum, () =>
    _.times(lastColNum, () => null),
  );
  celldata.forEach((entry) => {
    expandedData[entry.r][entry.c] = entry.v;
  });
  applyCellFormatRangesToData(expandedData, ranges);
  return expandedData;
}

export { rangesEqual };
