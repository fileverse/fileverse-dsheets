/**
 * Trim two selection index arrays down to the bounding box of "meaningful" cells.
 *
 * `rowIndexArr`/`colIndexArr` are sheet row/column indices in selection order.
 * `isMeaningful(r, c)` decides whether a cell contributes content (data, border, or
 * conditional format). Returns the sub-arrays spanning the first→last meaningful
 * position in each axis. If no cell is meaningful (e.g. select-all of an empty sheet),
 * the selection collapses to a single top-left cell so we never serialise a whole grid
 * of blank cells.
 *
 * This is what stops a select-all of a mostly-empty (or fully-empty) sheet from
 * serialising thousands of blank `<td>`s. Dropped rows/cols hold no data and no CSS, so
 * the trim is lossless — it matches Google Sheets' used-range clamp.
 */
export function clampIndicesToUsedBounds(
  rowIndexArr: number[],
  colIndexArr: number[],
  isMeaningful: (r: number, c: number) => boolean,
): { rows: number[]; cols: number[] } {
  let minRowPos = Infinity;
  let maxRowPos = -Infinity;
  let minColPos = Infinity;
  let maxColPos = -Infinity;

  for (let i = 0; i < rowIndexArr.length; i += 1) {
    for (let j = 0; j < colIndexArr.length; j += 1) {
      if (isMeaningful(rowIndexArr[i], colIndexArr[j])) {
        if (i < minRowPos) minRowPos = i;
        if (i > maxRowPos) maxRowPos = i;
        if (j < minColPos) minColPos = j;
        if (j > maxColPos) maxColPos = j;
      }
    }
  }

  if (maxRowPos === -Infinity) {
    // No meaningful cell in the selection — collapse to a single top-left cell so a
    // select-all of an empty sheet does not serialise the entire blank grid.
    return {
      rows: rowIndexArr.length ? [rowIndexArr[0]] : [],
      cols: colIndexArr.length ? [colIndexArr[0]] : [],
    };
  }

  return {
    rows: rowIndexArr.slice(minRowPos, maxRowPos + 1),
    cols: colIndexArr.slice(minColPos, maxColPos + 1),
  };
}
