import { isArray2D } from "./../helper/array";
import { ERROR_NOT_AVAILABLE, ERROR_VALUE } from "./../error";

/**
 * FILTER(range, condition1, [condition2, ...])
 *
 * Returns the subset of `range` whose rows (or columns) satisfy every condition.
 * Each condition must be a single column (rowCount x 1) to filter rows, or a
 * single row (1 x colCount) to filter columns — matching Excel/Sheets semantics.
 * Conditions are combined with logical AND.
 */
function FILTER(range, ...conditions) {
  if (!isArray2D(range) || conditions.length === 0) {
    throw new Error(ERROR_VALUE);
  }

  const rowCount = range.length;
  const colCount = range[0].length;

  const isColumnCondition = (cond) =>
    isArray2D(cond) && cond.length === rowCount && cond[0].length === 1;
  const isRowCondition = (cond) =>
    isArray2D(cond) && cond.length === 1 && cond[0].length === colCount;

  if (conditions.every(isColumnCondition)) {
    const filteredRows = range.filter((_row, r) =>
      conditions.every((cond) => Boolean(cond[r][0])),
    );

    if (!filteredRows.length) {
      throw new Error(ERROR_NOT_AVAILABLE);
    }

    return filteredRows;
  }

  if (conditions.every(isRowCondition)) {
    const keptCols = [];
    for (let c = 0; c < colCount; c += 1) {
      if (conditions.every((cond) => Boolean(cond[0][c]))) {
        keptCols.push(c);
      }
    }

    if (!keptCols.length) {
      throw new Error(ERROR_NOT_AVAILABLE);
    }

    return range.map((row) => keptCols.map((c) => row[c]));
  }

  throw new Error(ERROR_VALUE);
}

const CUSTOM_FORMULAS = {
  FILTER,
};

export default CUSTOM_FORMULAS;
