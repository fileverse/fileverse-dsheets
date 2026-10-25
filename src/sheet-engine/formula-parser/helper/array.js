/**
 * True when value is a 2D array (row of rows), the shape returned by `rangeValue`.
 *
 * @param {*} value
 * @returns {Boolean}
 */
export function isArray2D(value) {
  return Array.isArray(value) && Array.isArray(value[0]);
}

/**
 * Apply a scalar comparator across operands, broadcasting element-wise when either
 * side is a range (2D array) so relational operators work the same way they do in
 * Excel/Sheets array formulas (eg. `$B:$B=D$1`).
 *
 * @param {*} exp1
 * @param {*} exp2
 * @param {Function} compare Scalar comparator, eg. `(a, b) => a === b`.
 * @returns {Boolean|Array} Boolean for scalar/scalar, otherwise a 2D array matching
 *   the shape of whichever operand is a range.
 */
export function broadcastCompare(exp1, exp2, compare) {
  const arr1 = isArray2D(exp1);
  const arr2 = isArray2D(exp2);

  if (!arr1 && !arr2) {
    return compare(exp1, exp2);
  }

  if (arr1 && arr2) {
    return exp1.map((row, r) =>
      row.map((cell, c) => compare(cell, exp2[r]?.[c])),
    );
  }

  return arr1
    ? exp1.map((row) => row.map((cell) => compare(cell, exp2)))
    : exp2.map((row) => row.map((cell) => compare(exp1, cell)));
}
