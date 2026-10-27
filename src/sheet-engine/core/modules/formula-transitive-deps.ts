/** Cell / formula key format used in depsByCell and revDepsByCell. */
export function toFormulaDepCellKey(
  sheetId: string,
  r: number,
  c: number,
): string {
  return `${sheetId}:${r}:${c}`;
}

/**
 * Walk revDepsByCell from a changed cell to collect every formula cell that
 * must recalculate (direct + transitive dependents).
 *
 * `extraFormulaSeeds` are formulas that run on every commit whatever the
 * graph says (very large ranges, named ranges covering the edited cell). They
 * join the same walk, so formulas that read their results are reached too.
 */
export function collectTransitiveFormulaDependents(
  originCellKey: string,
  revDepsByCell: Map<string, Set<string>>,
  extraFormulaSeeds: Iterable<string> = [],
): Set<string> {
  const formulaKeys = new Set<string>();
  const queue: string[] = [originCellKey];
  const visitedCells = new Set<string>([originCellKey]);
  for (const seed of extraFormulaSeeds) {
    formulaKeys.add(seed);
    if (!visitedCells.has(seed)) {
      visitedCells.add(seed);
      queue.push(seed);
    }
  }

  while (queue.length > 0) {
    const cellKey = queue.shift()!;
    const dependents = revDepsByCell.get(cellKey);
    if (!dependents) continue;

    dependents.forEach((formulaKey) => {
      if (formulaKeys.has(formulaKey)) return;
      formulaKeys.add(formulaKey);
      if (!visitedCells.has(formulaKey)) {
        visitedCells.add(formulaKey);
        queue.push(formulaKey);
      }
    });
  }

  return formulaKeys;
}
