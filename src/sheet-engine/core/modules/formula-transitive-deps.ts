/** Cell / formula key format used in depsByCell and revDepsByCell. */
export function toFormulaDepCellKey(
  sheetId: string,
  r: number,
  c: number,
): string {
  return `${sheetId}:${r}:${c}`;
}

/** A range a wide formula reads (more cells than get individual edges). */
export type WideRange = {
  sheetId: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
};

/**
 * Wide formulas (ranges over MAX_RANGE_DEPS cells record no cell edges).
 * `ranges` holds the ranges of those whose ranges could be read; a key in
 * `keys` without an entry in `ranges` can't be bounded, so it joins every walk.
 */
export type WideFormulaIndex = {
  keys: Iterable<string>;
  ranges: Map<string, WideRange[]>;
};

const rangeHoldsCell = (cellKey: string, ranges: WideRange[]): boolean => {
  const c = cellKey.lastIndexOf(':');
  const r = cellKey.lastIndexOf(':', c - 1);
  if (r < 0) return false;
  const sheetId = cellKey.slice(0, r);
  const row = Number(cellKey.slice(r + 1, c));
  const col = Number(cellKey.slice(c + 1));
  return ranges.some(
    (range) =>
      range.sheetId === sheetId &&
      row >= range.startRow &&
      row <= range.endRow &&
      col >= range.startCol &&
      col <= range.endCol,
  );
};

/**
 * Walk revDepsByCell from a changed cell to collect every formula cell that
 * must recalculate (direct + transitive dependents).
 *
 * `extraFormulaSeeds` are formulas that run on every commit whatever the
 * graph says (named ranges covering the edited cell). They join the same
 * walk, so formulas that read their results are reached too.
 *
 * A wide formula joins the walk only when one of its ranges holds the edited
 * cell or a formula cell the walk reaches; one whose ranges can't be read
 * joins every walk. It then seeds the walk like any other formula.
 */
export function collectTransitiveFormulaDependents(
  originCellKey: string,
  revDepsByCell: Map<string, Set<string>>,
  extraFormulaSeeds: Iterable<string> = [],
  wide?: WideFormulaIndex,
): Set<string> {
  const formulaKeys = new Set<string>();
  const queue: string[] = [originCellKey];
  const visitedCells = new Set<string>([originCellKey]);
  const join = (formulaKey: string) => {
    formulaKeys.add(formulaKey);
    if (!visitedCells.has(formulaKey)) {
      visitedCells.add(formulaKey);
      queue.push(formulaKey);
    }
  };
  for (const seed of extraFormulaSeeds) join(seed);
  const pending: [string, WideRange[]][] = [];
  if (wide) {
    for (const key of wide.keys) {
      const ranges = wide.ranges.get(key);
      if (ranges) pending.push([key, ranges]);
      else join(key);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const cellKey = queue[head];
    head += 1;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const [formulaKey, ranges] = pending[i];
      if (rangeHoldsCell(cellKey, ranges)) {
        pending.splice(i, 1);
        if (!formulaKeys.has(formulaKey)) join(formulaKey);
      }
    }
    const dependents = revDepsByCell.get(cellKey);
    if (!dependents) continue;

    dependents.forEach((formulaKey) => {
      if (formulaKeys.has(formulaKey)) return;
      join(formulaKey);
    });
  }

  return formulaKeys;
}
