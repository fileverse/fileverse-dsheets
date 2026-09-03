// @ts-ignore
import { Parser, ERROR_REF } from '@sheet-engine/formula-parser';
import _ from 'lodash';
import type { Cell, CellMatrix, Rect, Selection } from '../types';
import { Context, getFlowdata } from '../context';
import {
  columnCharToIndex,
  escapeScriptTag,
  getSheetIndex,
  indexToColumnChar,
  getSheetIdByName,
  escapeHTMLTag,
  isLetterNumberPattern,
  removeLastSpan,
} from '../utils';
import {
  getcellFormula,
  getRangetxt,
  mergeMoveMain,
  setCellValue,
} from './cell';
import { error, detectErrorFromValue, isNumericCellType } from './validation';
import { locale } from '../locale';
import { colors } from './color';
import { colLocation, mousePosition, rowLocation } from './location';
import {
  cancelFunctionrangeSelected,
  clearCellError,
  seletedHighlistByindex,
  setCellError,
  spillSortResult,
} from '.';
import {
  FORMULA_ASYNC_CHUNK_SIZE,
  FORMULA_ASYNC_EVAL_THRESHOLD,
  type FormulaAsyncEvalJob,
} from './formula-async-eval';
import { ensureSheetFlowdata } from '../api/sheet';
import { invalidateSheetsRequiredDenseCache } from '../api/sheet-flowdata-lifecycle';
import { changeSheet } from './sheet';
import { shouldPersistCelldataCell } from '../utils/cell-persist-utils';
import {
  beginRangeValuePassCache,
  clearRangeValuePassCache,
  collectGlobalDataKeysInRange,
  makeRangePassCacheKey,
  sliceRangeFragmentForOrigin,
  type RangePassCacheEntry,
} from './formula-range-cache';
import { collectTransitiveFormulaDependents } from './formula-transitive-deps';
import type { SnapshotEvalOutput } from './formula-snapshot-eval';
import { resolveDefinedNameForFormula } from './namedRanges';

let functionHTMLIndex = 0;
let formulaAsyncEvalJobId = 0;
let rangeIndexes: number[] = [];
const operatorPriority: any = {
  '^': 0,
  '%': 1,
  '*': 1,
  '/': 1,
  '+': 2,
  '-': 2,
};
const operatorArr = '==|!=|<>|<=|>=|=|+|-|>|<|/|*|%|&|^'.split('|');
const operatorjson: Record<string, number> = {};
for (let i = 0; i < operatorArr.length; i += 1) {
  operatorjson[operatorArr[i].toString()] = 1;
}
const ZWSP = '\u200b';
const normalizeFormulaBoundaryText = (s: string) =>
  (s || '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '');

/** Significant char immediately left of caret (trailing spaces ignored). */
function getSignificantCharBeforeCaret(
  fullText: string,
  caretOffset: number,
): string {
  return fullText.slice(0, caretOffset).trimEnd().slice(-1);
}

function formulaDebugPreview(value: any) {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      rows: value.length,
      cols: Array.isArray(value[0]) ? value[0].length : undefined,
    };
  }
  if (value instanceof Date) {
    return { type: 'date', value: value.toISOString() };
  }
  if (value && typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value).slice(0, 8) };
  }
  return { type: typeof value, value };
}

function formulaDebugStable(value: any) {
  const preview = formulaDebugPreview(value);
  if (preview.type === 'object' || preview.type === 'array') {
    try {
      return { ...preview, json: JSON.stringify(value) };
    } catch (e) {
      return { ...preview, json: '[unserializable]' };
    }
  }
  return preview;
}
const simpleSheetName = '[A-Za-z0-9_\u00C0-\u02AF]+';
const quotedSheetName = "'(?:(?!').|'')*'";
const sheetNameRegexp = `(${simpleSheetName}|${quotedSheetName})!`;
// Used for sheet-qualified refs like `'Sheet 1'!A1`, `'Sheet'!A:A`, `'Sheet'!1:1`.
const a1CellRegexp = `[$]?[A-Za-z]+[$]?[0-9]+`;
const fullColumnRegexp = `[$]?[A-Za-z]+`;
const fullRowRegexp = `[$]?[0-9]+`;
const rowColumnRegexp = `(?:${a1CellRegexp}|${fullColumnRegexp}|${fullRowRegexp})`;
const rowColumnWithSheetName = `(?:${sheetNameRegexp})?(${rowColumnRegexp})`;
const LABEL_EXTRACT_REGEXP = new RegExp(
  `^${rowColumnWithSheetName}(?:[:]${rowColumnWithSheetName})?$`,
);

function normalizeDateArithmeticForParser(expr: string): string {
  if (!expr) return expr;
  // Formula parser treats JS Date with "+" as string coercion in some paths.
  // Normalize ONLY date-arithmetic cases to numeric serial arithmetic.
  const base1904 = new Date(1900, 2, 1, 0, 0, 0);
  const toExcelSerial = (date: Date) => {
    let epoch = Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
    );
    const dnthreshUtc = Date.UTC(1899, 11, 31, 0, 0, 0);
    if (date >= base1904) epoch += 24 * 60 * 60 * 1000;
    return (epoch - dnthreshUtc) / (24 * 60 * 60 * 1000);
  };
  const now = new Date();
  const todaySerial = toExcelSerial(
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0),
  );
  const nowSerial = toExcelSerial(now);

  return expr
    .replace(
      /\b(TODAY|NOW)\(\)\s*([+\-])\s*(\d+(?:\.\d+)?)/gi,
      (_m, fn, op, num) =>
        `${String(fn).toUpperCase() === 'NOW' ? nowSerial : todaySerial} ${op} ${num}`,
    )
    .replace(
      /(\d+(?:\.\d+)?)\s*([+\-])\s*\b(TODAY|NOW)\(\)/gi,
      (_m, num, op, fn) =>
        `${num} ${op} ${String(fn).toUpperCase() === 'NOW' ? nowSerial : todaySerial}`,
    );
}

/** True when the formula is only numeric ops on TODAY()/NOW() (incl. unary +/−); used to display serials as dates. */
export function isTodayNowPureArithmeticDateResult(
  formula: string,
  value: number,
): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return false;
  }
  // Generous cap for serial range; still avoids labelling large sums as dates.
  if (value > 1e7) {
    return false;
  }
  const body = formula.replace(/^\s*=\s*/i, '').toUpperCase();
  if (!/\bTODAY\s*\(/.test(body) && !/\bNOW\s*\(/.test(body)) {
    return false;
  }
  let s = body
    .replace(/\bTODAY\s*\(\s*\)/g, 'X')
    .replace(/\bNOW\s*\(\s*\)/g, 'X')
    .replace(/\d+\.?\d*/g, '0');
  s = s.replace(/\s+/g, '');
  if (!s.includes('X') || !/^[0X+\-*/().]+$/.test(s)) {
    return false;
  }
  return true;
}

const CIRCULAR_REF_ERROR = '#CIRC!';
const CIRCULAR_REF_TITLE = 'Circular Dependency';

function findCycleNodesFrom(
  startKey: string,
  depsByCell: Map<string, Set<string>>,
): Set<string> {
  const cycleNodes = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen, 1=visiting, 2=done
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const dfs = (key: string) => {
    const st = state.get(key) ?? 0;
    if (st === 1) {
      const idx = stackIndex.get(key);
      if (idx != null) {
        for (let i = idx; i < stack.length; i += 1) {
          cycleNodes.add(stack[i]);
        }
        cycleNodes.add(key);
      } else {
        cycleNodes.add(key);
      }
      return;
    }
    if (st === 2) return;

    state.set(key, 1);
    stackIndex.set(key, stack.length);
    stack.push(key);

    const deps = depsByCell.get(key);
    if (deps) {
      deps.forEach((depKey) => {
        dfs(depKey);
      });
    }

    stack.pop();
    stackIndex.delete(key);
    state.set(key, 2);
  };

  dfs(startKey);
  return cycleNodes;
}

function collectImpactedFromCycles(
  cycleNodes: Set<string>,
  revDepsByCell: Map<string, Set<string>>,
): Set<string> {
  const impacted = new Set<string>(cycleNodes);
  const queue: string[] = Array.from(cycleNodes);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const dependents = revDepsByCell.get(cur);
    if (!dependents) continue;
    dependents.forEach((dep) => {
      if (impacted.has(dep)) return;
      impacted.add(dep);
      queue.push(dep);
    });
  }
  return impacted;
}

function parseCellKey(
  key: string,
): { sheetId: string; r: number; c: number } | null {
  const first = key.indexOf(':');
  const second = key.indexOf(':', first + 1);
  if (first === -1 || second === -1) return null;
  const sheetId = key.slice(0, first);
  const r = Number(key.slice(first + 1, second));
  const c = Number(key.slice(second + 1));
  if (!sheetId || Number.isNaN(r) || Number.isNaN(c)) return null;
  return { sheetId, r, c };
}

/** In-pass formula value cache; must be a plain object while a recalc pass runs. */
function ensureExecFunctionGlobalData(ctx: Context) {
  if (ctx.formulaCache.execFunctionGlobalData == null) {
    ctx.formulaCache.execFunctionGlobalData = {};
  }
}

function writeExecFunctionGlobalDataCell(
  ctx: Context,
  r: number,
  c: number,
  sheetId: string,
  value: { v: unknown; f: unknown },
) {
  if (ctx.formulaCache.execFunctionGlobalData == null) {
    ensureExecFunctionGlobalData(ctx);
  }
  ctx.formulaCache.execFunctionGlobalData[`${r}_${c}_${sheetId}`] = value;
}

// FormulaCache is defined as class to avoid being frozen by immer
export class FormulaCache {
  parser: any;

  func_selectedrange?: Selection;

  data_parm_index: number;

  cellTextToIndexList: any;

  rangechangeindex?: number;

  selectingRangeIndex: number;

  rangeResizeObj?: any;

  rangeResize?: any;

  rangeResizeIndex?: number;

  rangeResizexy?: any;

  rangeResizeWinH?: any;

  rangeResizeWinW?: any;

  rangeResizeTo?: any;

  rangeSetValueTo?: any;

  rangeIndex?: number;

  rangestart?: boolean;

  rangetosheet?: string;

  rangedrag_column_start?: boolean;

  rangedrag_row_start?: boolean;

  // Tracks whether the currently inserted formula range token(s) were
  // created via keyboard/mouse range selection and are still "clean".
  // - null: not tracking / default
  // - true: last range insertion was via keyboard/mouse
  // - false: user manually modified the inserted range token(s)
  rangeSelectionActive?: boolean | null;

  // Keyboard-only gate: when opening an existing formula cell, block keyboard
  // range navigation until the formula text is manually edited.
  keyboardRangeSelectionLock?: boolean;

  /** True after arrow/Shift+arrow moved `func_selectedrange` without updating yellow selection. */
  formulaKeyboardRefSync?: boolean;

  // Persistent owner of the current formula edit session. Unlike
  // document.activeElement, this survives canvas clicks during range picking.
  formulaEditorOwner?: 'cell' | 'fx' | null;

  /**
   * Set when switching sheets while a formula edit stays open so InputBox/Fx
   * can restore focus/caret for continued keyboard ref picking.
   */
  refocusFormulaEditorAfterSheetSwitch?: boolean;

  functionRangeIndex?: number[];

  // Global logical character offset of caret in formula text (treats <br> as 1 char).
  // Resilient to span-boundary changes between pre-render and post-render DOM.
  functionRangeGlobalOffset?: number | null;

  functionlistMap: any;

  execFunctionExist?: any[];

  execFunctionGlobalData: any;

  /** Formula dependency graph: cell -> referenced cells. Key format: `${sheetId}:${r}:${c}` */
  depsByCell: Map<string, Set<string>>;

  /** Reverse dependency graph: referenced cell -> dependent formula cells. */
  revDepsByCell: Map<string, Set<string>>;

  /**
   * Formulas that referenced a range too large to fully expand into `revDepsByCell`.
   * These must be included on incremental recalcs because a single-cell edit may
   * affect them even when no precise reverse edge exists.
   */
  formulasWithWideRangeDeps: Set<string>;

  /**
   * Dependency collection state for the currently-parsed formula, set by `execfunction`.
   * When null, dependency recording is disabled.
   */
  activeDepCollection: null | {
    originKey: string;
    deps: Set<string>;
    hasWideRangeDep: boolean;
  };

  /** Step 2: per execFunctionGroup pass cache for materialized range reads. */
  rangeValuePassCache?: Map<string, RangePassCacheEntry>;

  rangeValuePassCacheStats?: { hits: number; misses: number };

  constructor() {
    const that = this;
    const toCellKey = (sheetId: string, r: number, c: number) =>
      `${sheetId}:${r}:${c}`;
    const recordDep = (key: string) => {
      if (!that.activeDepCollection) return;
      that.activeDepCollection.deps.add(key);
    };

    this.data_parm_index = 0;
    this.selectingRangeIndex = -1;
    this.rangeSelectionActive = null;
    this.formulaEditorOwner = null;
    this.functionlistMap = {};
    this.execFunctionGlobalData = {};
    this.cellTextToIndexList = {};
    this.depsByCell = new Map();
    this.revDepsByCell = new Map();
    this.formulasWithWideRangeDeps = new Set();
    this.activeDepCollection = null;
    this.parser = new Parser();
    this.parser.on(
      'callCellValue',
      (cellCoord: any, options: any, done: any) => {
        const context = that.parser.context as Context;
        const id =
          cellCoord.sheetName == null
            ? options.sheetId
            : getSheetIdByName(context, cellCoord.sheetName);
        if (id == null) throw Error(ERROR_REF);
        recordDep(toCellKey(id, cellCoord.row.index, cellCoord.column.index));
        // Inactive tabs may be demoted to sparse celldata; hydrate on demand.
        // Cheap no-op when already dense (`sheet.data?.length`).
        const flowdata = ensureSheetFlowdata(context, { id });
        const cacheKey = `${cellCoord.row.index}_${cellCoord.column.index}_${id}`;
        const cell =
          context?.formulaCache.execFunctionGlobalData?.[cacheKey] ||
          flowdata?.[cellCoord.row.index]?.[cellCoord.column.index];
        const v = that.tryGetCellAsNumber(cell);
        done(v);
      },
    );

    this.parser.on(
      'callRangeValue',
      (startCellCoord: any, endCellCoord: any, options: any, done: any) => {
        const context = that.parser.context as Context;
        const id =
          startCellCoord.sheetName == null
            ? options.sheetId
            : getSheetIdByName(context, startCellCoord.sheetName);
        if (id == null) throw Error(ERROR_REF);
        // Same as callCellValue: demoted cross-sheet targets must rehydrate.
        const flowdata = ensureSheetFlowdata(context, { id });
        let startRow = startCellCoord.row.index;
        let endRow = endCellCoord.row.index;
        let startCol = startCellCoord.column.index;
        let endCol = endCellCoord.column.index;
        const emptyRow = startRow === -1 || endRow === -1;
        const emptyCol = startCol === -1 || endCol === -1;
        if (emptyRow) {
          startRow = 0;
          endRow = flowdata?.length ?? 0;
        }
        if (emptyCol) {
          startCol = 0;
          endCol = flowdata?.[0].length ?? 0;
        }
        if (emptyRow && emptyCol) throw Error(ERROR_REF);

        // Record dependencies for cycle detection.
        // dependency recording must include the origin cell when it lies within the referenced range.
        if (that.activeDepCollection) {
          const originRow = typeof options === 'object' ? options.row : null;
          const originCol = typeof options === 'object' ? options.column : null;
          const originInRange =
            originRow != null &&
            originCol != null &&
            originRow >= startRow &&
            originRow <= endRow &&
            originCol >= startCol &&
            originCol <= endCol;

          // Avoid blowing up for whole-row/whole-column refs by capping expansion.
          const rowCount = endRow - startRow + 1;
          const colCount = endCol - startCol + 1;
          const MAX_RANGE_DEPS = 10_000;
          const approxSize = rowCount * colCount;
          if (approxSize <= MAX_RANGE_DEPS) {
            for (let row = startRow; row <= endRow; row += 1) {
              for (let col = startCol; col <= endCol; col += 1) {
                recordDep(toCellKey(id, row, col));
              }
            }
          } else {
            that.activeDepCollection.hasWideRangeDep = true;
            if (originInRange) {
              // Still record self-in-range to detect circular refs.
              recordDep(toCellKey(id, originRow, originCol));
            }
          }
        }

        const originRow = typeof options === 'object' ? options.row : null;
        const originCol = typeof options === 'object' ? options.column : null;
        const skippedOrigin =
          originRow != null &&
          originCol != null &&
          originRow >= startRow &&
          originRow <= endRow &&
          originCol >= startCol &&
          originCol <= endCol;

        let fragment: any[][] | null = null;
        let cryptoDenomination = '';
        let cryptoDecimal = 0;

        if (that.rangeValuePassCache) {
          const cacheKey = makeRangePassCacheKey(
            id,
            startRow,
            endRow,
            startCol,
            endCol,
          );
          const fingerprint = collectGlobalDataKeysInRange(
            context.formulaCache.execFunctionGlobalData ?? {},
            id,
            startRow,
            endRow,
            startCol,
            endCol,
          );
          const cached = that.rangeValuePassCache.get(cacheKey);
          if (cached && cached.globalDataKeysFingerprint === fingerprint) {
            that.rangeValuePassCacheStats!.hits += 1;
            fragment = sliceRangeFragmentForOrigin(
              cached.fragment,
              startRow,
              startCol,
              skippedOrigin ? originRow : null,
              skippedOrigin ? originCol : null,
            );
            cryptoDenomination = cached.cryptoDenomination;
            cryptoDecimal = cached.cryptoDecimal;
          } else {
            that.rangeValuePassCacheStats!.misses += 1;
            const built = that.materializeFullRangeFragment(
              context,
              id,
              flowdata,
              startRow,
              endRow,
              startCol,
              endCol,
            );
            that.rangeValuePassCache.set(cacheKey, {
              fragment: built.fragment,
              cryptoDenomination: built.cryptoDenomination,
              cryptoDecimal: built.cryptoDecimal,
              globalDataKeysFingerprint: fingerprint,
            });
            fragment = sliceRangeFragmentForOrigin(
              built.fragment,
              startRow,
              startCol,
              skippedOrigin ? originRow : null,
              skippedOrigin ? originCol : null,
            );
            cryptoDenomination = built.cryptoDenomination;
            cryptoDecimal = built.cryptoDecimal;
          }
        } else {
          const built = that.materializeFullRangeFragment(
            context,
            id,
            flowdata,
            startRow,
            endRow,
            startCol,
            endCol,
          );
          fragment = sliceRangeFragmentForOrigin(
            built.fragment,
            startRow,
            startCol,
            skippedOrigin ? originRow : null,
            skippedOrigin ? originCol : null,
          );
          cryptoDenomination = built.cryptoDenomination;
          cryptoDecimal = built.cryptoDecimal;
        }

        if (cryptoDenomination === 'Error') {
          cryptoDenomination = '';
          cryptoDecimal = 0;
        }

        if (fragment) {
          done(fragment, cryptoDenomination, cryptoDecimal);
        }
      },
    );

    // Named ranges: `=Custom` / `=SUM(Custom)` parse as VARIABLE → callVariable.
    this.parser.on('callVariable', (name: string, done: (value: any) => void) => {
      const context = that.parser.context as Context;
      const options = that.parser.options || {};
      const dn = resolveDefinedNameForFormula(
        context?.definedNames,
        name,
        options.sheetId,
      );
      if (!dn) return;

      const id = dn.sheetId;
      const startRow = dn.range.row[0];
      const endRow = dn.range.row[1];
      const startCol = dn.range.column[0];
      const endCol = dn.range.column[1];
      // Named ranges can point at demoted sheets — hydrate before materialize.
      const flowdata = ensureSheetFlowdata(context, { id });

      if (that.activeDepCollection) {
        const originRow = typeof options === 'object' ? options.row : null;
        const originCol = typeof options === 'object' ? options.column : null;
        const originInRange =
          originRow != null &&
          originCol != null &&
          originRow >= startRow &&
          originRow <= endRow &&
          originCol >= startCol &&
          originCol <= endCol;

        const rowCount = endRow - startRow + 1;
        const colCount = endCol - startCol + 1;
        const MAX_RANGE_DEPS = 10_000;
        const approxSize = rowCount * colCount;
        if (approxSize <= MAX_RANGE_DEPS) {
          for (let row = startRow; row <= endRow; row += 1) {
            for (let col = startCol; col <= endCol; col += 1) {
              recordDep(toCellKey(id, row, col));
            }
          }
        } else {
          that.activeDepCollection.hasWideRangeDep = true;
          if (originInRange) {
            recordDep(toCellKey(id, originRow, originCol));
          }
        }
      }

      const isSingle = startRow === endRow && startCol === endCol;
      if (isSingle) {
        const cacheKey = `${startRow}_${startCol}_${id}`;
        const cell =
          context?.formulaCache.execFunctionGlobalData?.[cacheKey] ||
          flowdata?.[startRow]?.[startCol];
        done(that.tryGetCellAsNumber(cell));
        return;
      }

      const originRow = typeof options === 'object' ? options.row : null;
      const originCol = typeof options === 'object' ? options.column : null;
      const skippedOrigin =
        originRow != null &&
        originCol != null &&
        originRow >= startRow &&
        originRow <= endRow &&
        originCol >= startCol &&
        originCol <= endCol;

      const built = that.materializeFullRangeFragment(
        context,
        id,
        flowdata,
        startRow,
        endRow,
        startCol,
        endCol,
      );
      const fragment = sliceRangeFragmentForOrigin(
        built.fragment,
        startRow,
        startCol,
        skippedOrigin ? originRow : null,
        skippedOrigin ? originCol : null,
      );
      if (
        built.cryptoDenomination &&
        built.cryptoDenomination !== 'Error'
      ) {
        that.parser.cryptoDenomination = built.cryptoDenomination;
        that.parser.cryptoDecimals = built.cryptoDecimal;
      }
      done(fragment);
    });
  }

  materializeFullRangeFragment(
    context: Context,
    sheetId: string,
    flowdata: CellMatrix | null | undefined,
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number,
  ): {
    fragment: any[][];
    cryptoDenomination: string;
    cryptoDecimal: number;
  } {
    const fragment: any[][] = [];
    let cryptoDenomination = '';
    let cryptoDecimal = 0;

    for (let row = startRow; row <= endRow; row += 1) {
      const colFragment: any[] = [];
      for (let col = startCol; col <= endCol; col += 1) {
        const cell =
          context?.formulaCache.execFunctionGlobalData?.[
          `${row}_${col}_${sheetId}`
          ] || flowdata?.[row]?.[col];
        const v = this.tryGetCellAsNumber(cell);
        if (
          (cell?.m?.includes('ETH') ||
            cell?.m?.includes('SOL') ||
            cell?.m?.includes('BTC')) &&
          cryptoDenomination !== 'Error'
        ) {
          const visualString = cell?.m.split(' ');
          if (
            cryptoDenomination !== '' &&
            cryptoDenomination !== visualString[1]
          ) {
            cryptoDenomination = 'Error';
          } else {
            cryptoDenomination = visualString[1];
          }
          cryptoDecimal = visualString[0].includes('.')
            ? visualString[0].split('.')[1]?.length
            : 0;
        }
        colFragment.push(v);
      }
      fragment.push(colFragment);
    }

    if (cryptoDenomination === 'Error') {
      cryptoDenomination = '';
      cryptoDecimal = 0;
    }

    return { fragment, cryptoDenomination, cryptoDecimal };
  }

  tryGetCellAsNumber(cell: Cell) {
    // Inline rich-text cells (e.g. hyperlinked text) keep their display text in
    // `ct.s` segments; `v` is not reliably a plain string. Return the joined
    // segment text so text predicates like ISTEXT see a real string.
    if (cell?.ct?.t === 'inlineStr' && Array.isArray(cell.ct.s)) {
      return (cell.ct.s as { v?: string }[]).map((s) => s?.v ?? '').join('');
    }

    const rawV = cell?.v;
    const normalizedV =
      typeof rawV === 'string' ? rawV.trim().replace(/,/g, '') : rawV;
    const isLongIntegerString =
      typeof normalizedV === 'string' && /^-?\d{16,}$/.test(normalizedV);
    const isDecimalString =
      typeof normalizedV === 'string' && /^-?\d+\.\d+$/.test(normalizedV);
    // Keep 16+ digit integer literals as strings to avoid IEEE-754 rounding
    // when formulas like XLOOKUP/VLOOKUP return source values.
    if (isLongIntegerString) {
      return normalizedV;
    }
    // Decimal literals are treated as numbers for formula math.
    if (isDecimalString) {
      return Number(normalizedV);
    }

    // FLV crypto denomination --START--
    const isCryptoDeno =
      typeof cell?.m === 'string'
        ? cell?.m?.includes('ETH') ||
        cell?.m?.includes('SOL') ||
        cell?.m?.includes('BTC')
        : false;
    if (isCryptoDeno && typeof cell?.m === 'string') {
      const splitedNumberString = cell.m.split(' ')[0];
      return Number(splitedNumberString);
    }
    // FLV crypto denomination --END--
    if (isNumericCellType(cell) && !String(cell?.m).includes('%')) {
      const n = Number(cell?.v);
      return Number.isNaN(n) ? cell.v : n;
    }
    return String(cell?.m).includes('%') ? cell?.m : cell?.v;
  }
}

function parseElement(eleString: string) {
  return new DOMParser().parseFromString(eleString, 'text/html').body
    .childNodes[0];
}

export function iscelldata(txt: string) {
  // 判断是否为单元格格式
  const val = txt.split('!');
  let rangetxt: string;

  if (val.length > 1) {
    [, rangetxt] = val;
  } else {
    [rangetxt] = val;
  }

  // Allow:
  // - A1:A2 (cell-to-cell)
  // - A:A (column-to-column)
  // - 1:1 (row-to-row)
  const realRangeRegex =
    /^(\$?[A-Za-z]+\$?\d+|\$?[A-Za-z]+|\$?\d+):(\$?[A-Za-z]+\$?\d+|\$?[A-Za-z]+|\$?\d+)$/;
  if (rangetxt.includes(':') && !realRangeRegex.test(rangetxt)) {
    return false;
  }

  const reg_cell = /^(([a-zA-Z]+)|([$][a-zA-Z]+))(([0-9]+)|([$][0-9]+))$/g; // 增加正则判断单元格为字母+数字的格式：如 A1:B3
  let reg_cellRange =
    /^(((([a-zA-Z]+)|([$][a-zA-Z]+))(([0-9]+)|([$][0-9]+)))|((([a-zA-Z]+)|([$][a-zA-Z]+))))$/g; // 增加正则判断单元格为字母+数字或字母的格式：如 A1:B3，A:A

  if (rangetxt.indexOf(':') === -1) {
    const row = parseInt(rangetxt.replace(/[^0-9]/g, ''), 10) - 1;
    const col = columnCharToIndex(rangetxt.replace(/[^A-Za-z]/g, ''));

    if (
      !Number.isNaN(row) &&
      !Number.isNaN(col) &&
      rangetxt.toString().match(reg_cell)
    ) {
      return true;
    }
    if (!Number.isNaN(row)) {
      return false;
    }
    if (!Number.isNaN(col)) {
      return false;
    }

    return false;
  }

  // Accept A1, $A$1, A, $A, 1, $1 for each side of a range.
  reg_cellRange = /^((\$?[A-Za-z]+\$?\d+)|(\$?[A-Za-z]+)|(\$?\d+))$/g;

  const rangetxtArr = rangetxt.split(':');

  const row = [];
  const col = [];
  row[0] = parseInt(rangetxtArr[0].replace(/[^0-9]/g, ''), 10) - 1;
  row[1] = parseInt(rangetxtArr[1].replace(/[^0-9]/g, ''), 10) - 1;
  if (row[0] > row[1]) {
    return false;
  }

  col[0] = columnCharToIndex(rangetxtArr[0].replace(/[^A-Za-z]/g, ''));
  col[1] = columnCharToIndex(rangetxtArr[1].replace(/[^A-Za-z]/g, ''));
  if (col[0] > col[1]) {
    return false;
  }

  if (
    rangetxtArr[0].toString().match(reg_cellRange) &&
    rangetxtArr[1].toString().match(reg_cellRange)
  ) {
    return true;
  }

  return false;
}

function addToCellIndexList(ctx: Context, txt: string, infoObj: any) {
  if (_.isNil(txt) || txt.length === 0 || _.isNil(infoObj)) {
    return;
  }
  if (_.isNil(ctx.formulaCache.cellTextToIndexList)) {
    ctx.formulaCache.cellTextToIndexList = {};
  }

  if (txt.indexOf('!') > -1) {
    txt = txt.replace(/\\'/g, "'").replace(/''/g, "'");
    ctx.formulaCache.cellTextToIndexList[txt] = infoObj;
  } else {
    ctx.formulaCache.cellTextToIndexList[`${txt}_${infoObj.sheetId}`] = infoObj;
  }
}

export function getcellrange(ctx: Context, txt: string, formulaId?: string) {
  if (_.isNil(txt) || txt.length === 0) {
    return null;
  }
  const flowdata = getFlowdata(ctx, formulaId);

  let sheettxt = '';
  let rangetxt = '';
  let sheetId = null;
  let sheetdata = null;

  const { luckysheetfile } = ctx;

  if (txt.indexOf('!') > -1) {
    if (txt in ctx.formulaCache.cellTextToIndexList) {
      return ctx.formulaCache.cellTextToIndexList[txt];
    }

    const matchRes = txt.match(LABEL_EXTRACT_REGEXP);
    if (matchRes == null) {
      return null;
    }
    const [, sheettxt1, starttxt1, sheettxt2, starttxt2] = matchRes;
    if (sheettxt2 != null && sheettxt1 !== sheettxt2) {
      return null;
    }
    rangetxt = starttxt2 ? `${starttxt1}:${starttxt2}` : starttxt1;
    sheettxt = sheettxt1
      .replace(/^'|'$/g, '')
      .replace(/\\'/g, "'")
      .replace(/''/g, "'");

    _.forEach(luckysheetfile, (f) => {
      if (sheettxt === f.name) {
        sheetId = f.id;
        sheetdata = f.data ?? null;
        return false;
      }
      return true;
    });
    if (sheetId != null && _.isNil(sheetdata)) {
      sheetdata = ensureSheetFlowdata(ctx, { id: sheetId });
    }
  } else {
    let i = formulaId;
    if (_.isNil(i)) {
      i = ctx.currentSheetId;
    }
    if (`${txt}_${i}` in ctx.formulaCache.cellTextToIndexList) {
      return ctx.formulaCache.cellTextToIndexList[`${txt}_${i}`];
    }
    const index = getSheetIndex(ctx, i);
    if (_.isNil(index)) {
      return null;
    }
    sheettxt = luckysheetfile[index].name;
    sheetId = luckysheetfile[index].id;
    sheetdata = flowdata;
    rangetxt = txt;
  }

  if (_.isNil(sheetdata)) {
    return null;
  }

  if (rangetxt.indexOf(':') === -1) {
    const row = parseInt(rangetxt.replace(/[^0-9]/g, ''), 10) - 1;
    const col = columnCharToIndex(rangetxt.replace(/[^A-Za-z]/g, ''));

    if (!Number.isNaN(row) && !Number.isNaN(col)) {
      const item = {
        row: [row, row],
        column: [col, col],
        sheetId,
      };
      addToCellIndexList(ctx, txt, item);
      return item;
    }
    return null;
  }
  const rangetxtArr = rangetxt.split(':');
  const row = [];
  const col = [];
  row[0] = parseInt(rangetxtArr[0].replace(/[^0-9]/g, ''), 10) - 1;
  row[1] = parseInt(rangetxtArr[1].replace(/[^0-9]/g, ''), 10) - 1;
  if (Number.isNaN(row[0])) {
    row[0] = 0;
  }
  if (Number.isNaN(row[1])) {
    row[1] = sheetdata.length - 1;
  }
  if (row[0] > row[1]) {
    return null;
  }
  col[0] = columnCharToIndex(rangetxtArr[0].replace(/[^A-Za-z]/g, ''));
  col[1] = columnCharToIndex(rangetxtArr[1].replace(/[^A-Za-z]/g, ''));
  if (Number.isNaN(col[0])) {
    col[0] = 0;
  }
  if (Number.isNaN(col[1])) {
    col[1] = sheetdata[0].length - 1;
  }
  if (col[0] > col[1]) {
    return null;
  }

  const item = {
    row,
    column: col,
    sheetId,
  };
  addToCellIndexList(ctx, txt, item);
  return item;
}

function calPostfixExpression(cal: any[]) {
  if (cal.length === 0) {
    return '';
  }
  const stack: string[] = [];
  for (let i = cal.length - 1; i >= 0; i -= 1) {
    const c = cal[i];
    if (c in operatorjson) {
      const s2 = stack.pop();
      const s1 = stack.pop();
      const str = `luckysheet_compareWith(${s1},'${c}', ${s2})`;
      stack.push(str);
    } else {
      stack.push(c);
    }
  }

  if (stack.length > 0) {
    return stack[0];
  }

  return '';
}

function checkSpecialFunctionRange(
  ctx: Context,
  function_str: string,
  r: number | null,
  c: number | null,
  id: string,
  dynamicArray_compute?: any,
  cellRangeFunction?: any,
) {
  if (
    function_str.substring(0, 30) === 'luckysheet_getSpecialReference' ||
    function_str.substring(0, 20) === 'luckysheet_function.'
  ) {
    if (function_str.substring(0, 20) === 'luckysheet_function.') {
      let funcName = function_str.split('.')[1];
      if (!_.isNil(funcName)) {
        funcName = funcName.toUpperCase();
        if (
          funcName !== 'INDIRECT' &&
          funcName !== 'OFFSET' &&
          funcName !== 'INDEX'
        ) {
          return;
        }
      }
    }
    try {
      ctx.calculateSheetId = id;
      const str = function_str
        .split(',')
      [function_str.split(',').length - 1].split("'")[1]
        .split("'")[0];

      const str_nb = _.trim(str);
      // console.log(function_str, tempFunc,str, this.iscelldata(str_nb),this.isFunctionRangeSave,r,c);
      if (iscelldata(str_nb)) {
        if (typeof cellRangeFunction === 'function') {
          cellRangeFunction(str_nb);
        }
        // this.isFunctionRangeSaveChange(str, r, c, index, dynamicArray_compute);
        // console.log(function_str, str, this.isFunctionRangeSave,r,c);
      }
    } catch { }
  }
}

function isFunctionRange(
  ctx: Context,
  txt: string,
  r: number | null,
  c: number | null,
  id: string,
  dynamicArray_compute: any,
  cellRangeFunction: any,
) {
  if (txt.substring(0, 1) === '=') {
    txt = txt.substring(1);
  }

  const funcstack = txt.split('');
  let i = 0;
  let str = '';
  let function_str = '';

  const matchConfig = {
    bracket: 0,
    comma: 0,
    squote: 0,
    dquote: 0,
    compare: 0,
    braces: 0,
  };

  // let luckysheetfile = getluckysheetfile();
  // let dynamicArray_compute = luckysheetfile[getSheetIndex(Store.currentSheetId)_.isNil(]["dynamicArray_compute"]) ? {} : luckysheetfile[getSheetIndex(Store.currentSheetId)]["dynamicArray_compute"];

  // bracket 0为运算符括号、1为函数括号
  const cal1: any[] = [];
  const cal2: any[] = [];
  const bracket: any[] = [];
  let firstSQ = -1;
  while (i < funcstack.length) {
    const s = funcstack[i];

    if (
      s === '(' &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0 &&
      matchConfig.braces === 0
    ) {
      if (str.length > 0 && bracket.length === 0) {
        str = str.toUpperCase();
        if (str.indexOf(':') > -1) {
          const funcArray = str.split(':');
          function_str += `luckysheet_getSpecialReference(true,'${_.trim(
            funcArray[0],
          ).replace(/'/g, "\\'")}', luckysheet_function.${funcArray[1]
            }.f(#lucky#`;
        } else {
          function_str += `luckysheet_function.${str}.f(`;
        }
        bracket.push(1);
        str = '';
      } else if (bracket.length === 0) {
        function_str += '(';
        bracket.push(0);
        str = '';
      } else {
        bracket.push(0);
        str += s;
      }
    } else if (
      s === ')' &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0 &&
      matchConfig.braces === 0
    ) {
      bracket.pop();

      if (bracket.length === 0) {
        // function_str += _this.isFunctionRange(str,r,c, index,dynamicArray_compute,cellRangeFunction) + ")";
        // str = "";

        let functionS = isFunctionRange(
          ctx,
          str,
          r,
          c,
          id,
          dynamicArray_compute,
          cellRangeFunction,
        );
        if (functionS.indexOf('#lucky#') > -1) {
          functionS = `${functionS.replace(/#lucky#/g, '')})`;
        }
        function_str += `${functionS})`;
        str = '';
      } else {
        str += s;
      }
    } else if (
      s === '{' &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0
    ) {
      str += '{';
      matchConfig.braces += 1;
    } else if (
      s === '}' &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0
    ) {
      str += '}';
      matchConfig.braces -= 1;
    } else if (s === '"' && matchConfig.squote === 0) {
      if (matchConfig.dquote > 0) {
        // 如果是""代表着输出"
        if (i < funcstack.length - 1 && funcstack[i + 1] === '"') {
          i += 1;
          str += '\x7F'; // 用DEL替换一下""
        } else {
          matchConfig.dquote -= 1;
          str += '"';
        }
      } else {
        matchConfig.dquote += 1;
        str += '"';
      }
    } else if (s === "'" && matchConfig.dquote === 0) {
      str += "'";

      if (matchConfig.squote > 0) {
        // if (firstSQ === i - 1)//配对的单引号后第一个字符不能是单引号
        // {
        //    代码到了此处应该是公式错误
        // }
        // 如果是''代表着输出'
        if (i < funcstack.length - 1 && funcstack[i + 1] === "'") {
          i += 1;
          str += "'";
        } else {
          // 如果下一个字符不是'代表单引号结束
          // if (funcstack[i - 1] === "'") {//配对的单引号后最后一个字符不能是单引号
          //    代码到了此处应该是公式错误
          // } else {
          matchConfig.squote -= 1;
          // }
        }
      } else {
        matchConfig.squote += 1;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        firstSQ = i;
      }
    } else if (
      s === ',' &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0 &&
      matchConfig.braces === 0
    ) {
      if (bracket.length <= 1) {
        // function_str += _this.isFunctionRange(str, r, c, index,dynamicArray_compute,cellRangeFunction) + ",";
        // str = "";

        let functionS = isFunctionRange(
          ctx,
          str,
          r,
          c,
          id,
          dynamicArray_compute,
          cellRangeFunction,
        );
        if (functionS.indexOf('#lucky#') > -1) {
          functionS = `${functionS.replace(/#lucky#/g, '')})`;
        }
        function_str += `${functionS},`;
        str = '';
      } else {
        str += ',';
      }
    } else if (
      s in operatorjson &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0 &&
      matchConfig.braces === 0
    ) {
      let s_next = '';
      const op = operatorPriority;

      if (i + 1 < funcstack.length) {
        s_next = funcstack[i + 1];
      }

      if (s + s_next in operatorjson) {
        if (bracket.length === 0) {
          if (_.trim(str).length > 0) {
            cal2.unshift(
              isFunctionRange(
                ctx,
                _.trim(str),
                r,
                c,
                id,
                dynamicArray_compute,
                cellRangeFunction,
              ),
            );
          } else if (_.trim(function_str).length > 0) {
            cal2.unshift(_.trim(function_str));
          }

          if (cal1[0] in operatorjson) {
            let stackCeilPri = op[cal1[0]];

            while (cal1.length > 0 && !_.isNil(stackCeilPri)) {
              cal2.unshift(cal1.shift());
              stackCeilPri = op[cal1[0]];
            }
          }

          cal1.unshift(s + s_next);

          function_str = '';
          str = '';
        } else {
          str += s + s_next;
        }

        i += 1;
      } else {
        if (bracket.length === 0) {
          if (_.trim(str).length > 0) {
            cal2.unshift(
              isFunctionRange(
                ctx,
                _.trim(str),
                r,
                c,
                id,
                dynamicArray_compute,
                cellRangeFunction,
              ),
            );
          } else if (_.trim(function_str).length > 0) {
            cal2.unshift(_.trim(function_str));
          }

          if (cal1[0] in operatorjson) {
            let stackCeilPri = op[cal1[0]];
            stackCeilPri = _.isNil(stackCeilPri) ? 1000 : stackCeilPri;

            let sPri = op[s];
            sPri = _.isNil(sPri) ? 1000 : sPri;

            while (cal1.length > 0 && sPri >= stackCeilPri) {
              cal2.unshift(cal1.shift());

              stackCeilPri = op[cal1[0]];
              stackCeilPri = _.isNil(stackCeilPri) ? 1000 : stackCeilPri;
            }
          }

          cal1.unshift(s);

          function_str = '';
          str = '';
        } else {
          str += s;
        }
      }
    } else {
      if (matchConfig.dquote === 0 && matchConfig.squote === 0) {
        str += _.trim(s);
      } else {
        str += s;
      }
    }

    if (i === funcstack.length - 1) {
      let endstr = '';
      let str_nb = _.trim(str).replace(/'/g, "\\'");
      if (iscelldata(str_nb) && str_nb.substring(0, 1) !== ':') {
        // endstr = "luckysheet_getcelldata('" + _.trim(str) + "')";
        endstr = `luckysheet_getcelldata('${str_nb}')`;
      } else if (str_nb.substring(0, 1) === ':') {
        str_nb = str_nb.substring(1);
        if (iscelldata(str_nb)) {
          endstr = `luckysheet_getSpecialReference(false,${function_str},'${str_nb}')`;
        }
      } else {
        str = _.trim(str);

        const regx = /{.*?}/;
        if (
          regx.test(str) &&
          str.substring(0, 1) !== '"' &&
          str.substring(str.length - 1, 1) !== '"'
        ) {
          const arraytxt = regx.exec(str)?.[0];
          const arraystart = str.search(regx);

          if (arraystart > 0) {
            endstr += str.substring(0, arraystart);
          }

          endstr += `luckysheet_getarraydata('${arraytxt}')`;

          if (arraystart + arraytxt!.length < str.length) {
            endstr += str.substring(arraystart + arraytxt!.length, str.length);
          }
        } else {
          endstr = str;
        }
      }

      if (endstr.length > 0) {
        cal2.unshift(endstr);
      }

      if (cal1.length > 0) {
        if (function_str.length > 0) {
          cal2.unshift(function_str);
          function_str = '';
        }

        while (cal1.length > 0) {
          cal2.unshift(cal1.shift());
        }
      }

      if (cal2.length > 0) {
        function_str = calPostfixExpression(cal2);
      } else {
        function_str += endstr;
      }
    }

    i += 1;
  }
  checkSpecialFunctionRange(
    ctx,
    function_str,
    r,
    c,
    id,
    dynamicArray_compute,
    cellRangeFunction,
  );
  return function_str;
}

export function getAllFunctionGroup(ctx: Context) {
  const { luckysheetfile } = ctx;
  let ret: any[] = [];
  for (let i = 0; i < luckysheetfile.length; i += 1) {
    const file = luckysheetfile[i];
    let { calcChain } = file;

    /* 备注：再次加载表格获取的数据可能是JSON字符串格式(需要进行发序列化处理) */
    // if (calcChain) {
    //   const tempCalcChain: any[] = [];
    //   calcChain.forEach((item) => {
    //     if (typeof item === "string") {
    //       tempCalcChain.push(JSON.parse(item));
    //     } else {
    //       tempCalcChain.push(item);
    //     }
    //   });
    //   calcChain = tempCalcChain;
    //   file.calcChain = tempCalcChain;
    // }

    let { dynamicArray_compute } = file;
    if (_.isNil(calcChain)) {
      calcChain = [];
    }

    if (_.isNil(dynamicArray_compute)) {
      dynamicArray_compute = [];
    }

    ret = ret.concat(calcChain);

    for (let j = 0; j < dynamicArray_compute.length; j += 1) {
      const d = dynamicArray_compute[0];
      ret.push({
        r: d.r,
        c: d.c,
        id: d.id,
      });
    }
  }

  return ret;
}

export function delFunctionGroup(
  ctx: Context,
  r: number,
  c: number,
  id?: string,
) {
  if (_.isNil(id)) {
    id = ctx.currentSheetId;
  }

  // Remove dependency edges for this cell (it is no longer a formula).
  const originKey = `${id}:${r}:${c}`;
  ctx.formulaCache.formulasWithWideRangeDeps.delete(originKey);
  const prevDeps = ctx.formulaCache?.depsByCell?.get(originKey);
  if (prevDeps) {
    prevDeps.forEach((depKey) => {
      const rev = ctx.formulaCache.revDepsByCell.get(depKey);
      if (!rev) return;
      rev.delete(originKey);
      if (rev.size === 0) ctx.formulaCache.revDepsByCell.delete(depKey);
    });
    ctx.formulaCache.depsByCell.delete(originKey);
    invalidateSheetsRequiredDenseCache();
  }

  const file = ctx.luckysheetfile[getSheetIndex(ctx, id)!];

  const { calcChain } = file;
  if (!_.isNil(calcChain)) {
    let modified = false;
    const calcChainClone = _.cloneDeep(calcChain);
    for (let i = 0; i < calcChainClone.length; i += 1) {
      const calc = calcChainClone[i];
      if (calc.r === r && calc.c === c && calc.id === id) {
        calcChainClone.splice(i, 1);
        modified = true;
        // server.saveParam("fc", index, calc, {
        //   op: "del",
        //   pos: i,
        // });
        break;
      }
    }
    if (modified) {
      file.calcChain = calcChainClone;
      invalidateSheetsRequiredDenseCache();
    }
  }

  const { dynamicArray } = file;
  if (!_.isNil(dynamicArray)) {
    let modified = false;
    const dynamicArrayClone = _.cloneDeep(dynamicArray);
    for (let i = 0; i < dynamicArrayClone.length; i += 1) {
      const calc = dynamicArrayClone[i];
      if (
        calc.r === r &&
        calc.c === c &&
        (_.isNil(calc.id) || calc.id === id)
      ) {
        dynamicArrayClone.splice(i, 1);
        modified = true;
        // server.saveParam("ac", index, null, {
        //   op: "del",
        //   pos: i,
        // });
        break;
      }
    }
    if (modified) {
      file.dynamicArray = dynamicArrayClone;
    }
  }
}

function checkBracketNum(fp: string) {
  const bra_l = fp.match(/\(/g);
  const bra_r = fp.match(/\)/g);
  const bra_tl_txt = fp.match(/(['"])(?:(?!\1).)*?\1/g);
  const bra_tr_txt = fp.match(/(['"])(?:(?!\1).)*?\1/g);

  let bra_l_len = 0;
  let bra_r_len = 0;
  if (!_.isNil(bra_l)) {
    bra_l_len += bra_l.length;
  }
  if (!_.isNil(bra_r)) {
    bra_r_len += bra_r.length;
  }

  let bra_tl_len = 0;
  let bra_tr_len = 0;
  if (!_.isNil(bra_tl_txt)) {
    for (let i = 0; i < bra_tl_txt.length; i += 1) {
      const bra_tl = bra_tl_txt[i].match(/\(/g);
      if (!_.isNil(bra_tl)) {
        bra_tl_len += bra_tl.length;
      }
    }
  }

  if (!_.isNil(bra_tr_txt)) {
    for (let i = 0; i < bra_tr_txt.length; i += 1) {
      const bra_tr = bra_tr_txt[i].match(/\)/g);
      if (!_.isNil(bra_tr)) {
        bra_tr_len += bra_tr.length;
      }
    }
  }

  bra_l_len -= bra_tl_len;
  bra_r_len -= bra_tr_len;

  if (bra_l_len !== bra_r_len) {
    return false;
  }

  return true;
}

export function insertUpdateFunctionGroup(
  ctx: Context,
  r: number,
  c: number,
  id?: string,
  calcChainSet?: Set<string>,
) {
  if (_.isNil(id)) {
    id = ctx.currentSheetId;
  }

  // let func = getcellFormula(r, c, index);
  // if (_.isNil(func) || func.length==0) {
  //     this.delFunctionGroup(r, c, index);
  //     return;
  // }

  const { luckysheetfile } = ctx;
  const idx = getSheetIndex(ctx, id);
  if (_.isNil(idx)) {
    return;
  }
  const file = luckysheetfile[idx];

  let { calcChain } = file;
  if (_.isNil(calcChain)) {
    calcChain = [];
  }

  if (calcChainSet) {
    if (calcChainSet.has(`${r}_${c}_${id}`)) return;
  } else {
    for (let i = 0; i < calcChain.length; i += 1) {
      const calc = calcChain[i];
      if (calc.r === r && calc.c === c && calc.id === id) {
        // server.saveParam("fc", index, calc, {
        //   op: "update",
        //   pos: i,
        // });
        return;
      }
    }
  }

  const cc = {
    r,
    c,
    id,
  };
  calcChain.push(cc);
  file.calcChain = calcChain;

  // server.saveParam("fc", index, cc, {
  //   op: "add",
  //   pos: file.calcChain.length - 1,
  // });
  ctx.luckysheetfile = luckysheetfile;
  // New calcChain entry can add unevaluated cross-sheet refs that must stay dense.
  invalidateSheetsRequiredDenseCache();
}

function replaceDotsInFunctionName(str: string) {
  if (!str.startsWith('=')) return str;
  const openParenIndex = str.indexOf('(');
  if (openParenIndex === -1) return str; // no "(" → leave unchanged
  const fnName = str.substring(1, openParenIndex);
  const fixedFnName = fnName.replace(/\./g, '_');
  return `=${fixedFnName}${str.substring(openParenIndex)}`;
}

export function execfunction(
  ctx: Context,
  txt: string,
  r: number,
  c: number,
  id?: string,
  calcChainSet?: Set<string>,
  isrefresh?: boolean,
  notInsertFunc?: boolean,
) {
  const originalTxt = txt;
  if (_.isNil(id)) {
    id = ctx.currentSheetId;
  }
  if (
    txt?.toUpperCase().includes('NETWORKDAYS.INTL') ||
    txt?.toUpperCase().includes('WORKDAY.INTL')
  ) {
    txt = replaceDotsInFunctionName(txt);
  }
  if (txt.indexOf(error.r) > -1) {
    return [false, error.r, txt];
  }

  if (!checkBracketNum(txt)) {
    txt += ')';
  }

  ctx.calculateSheetId = id;

  /*
  const fp = _.trim(functionParserExe(txt));
  if (
    fp.substring(0, 20) === "luckysheet_function." ||
    fp.substring(0, 22) === "luckysheet_compareWith"
  ) {
    functionHTMLIndex = 0;
  }

  if (!testFunction(txt) || fp === "") {
    // TODO tooltip.info("", locale_formulaMore.execfunctionError);
    return [false, error.n, txt];
  }

  let result = null;
  window.luckysheetCurrentRow = r;
  window.luckysheetCurrentColumn = c;
  window.luckysheetCurrentIndex = index;
  window.luckysheetCurrentFunction = txt;

  let sparklines = null;

  try {
    if (fp.indexOf("luckysheet_getcelldata") > -1) {
      const funcg = fp.split("luckysheet_getcelldata('");

      for (let i = 1; i < funcg.length; i += 1) {
        const funcgStr = funcg[i].split("')")[0];
        const funcgRange = getcellrange(ctx, funcgStr);

        if (funcgRange.row[0] < 0 || funcgRange.column[0] < 0) {
          return [true, error.r, txt];
        }

        if (
          funcgRange.sheetId === ctx.calculateSheetId &&
          r >= funcgRange.row[0] &&
          r <= funcgRange.row[1] &&
          c >= funcgRange.column[0] &&
          c <= funcgRange.column[1]
        ) {
          // TODO if (isEditMode()) {
          //   alert(locale_formulaMore.execfunctionSelfError);
          // } else {
          //   tooltip.info("", locale_formulaMore.execfunctionSelfErrorResult);
          // }

          return [false, 0, txt];
        }
      }
    }

    result = new Function(`return ${fp}`)();
    if (typeof result === "string") {
      // 把之前的非打印控制字符DEL替换回一个双引号。
      result = result.replace(/\x7F/g, '"');
    }

    // 加入sparklines的参数项目
    if (fp.indexOf("SPLINES") > -1) {
      sparklines = result;
      result = "";
    }
  } catch (e) {
    const err = e;
    // err错误提示处理
    result = [error.n, err];
  }

  // 公式结果是对象，则表示只是选区。如果是单个单元格，则返回其值；如果是多个单元格，则返回 #VALUE!。
  if (_.isPlainObject(result) && !_.isNil(result.startCell)) {
    if (_.isArray(result.data)) {
      result = error.v;
    } else {
      if (_.isPlainObject(result.data) && !_.isEmpty(result.data.v)) {
        result = result.data.v;
      } else if (!_.isEmpty(result.data)) {
        // 只有data长或宽大于1才可能是选区
        if (result.cell > 1 || result.rowl > 1) {
          result = result.data;
        } // 否则就是单个不为null的没有值v的单元格
        else {
          result = 0;
        }
      } else {
        result = 0;
      }
    }
  }

  // 公式结果是数组，分错误值 和 动态数组 两种情况
  let dynamicArrayItem = null;

  if (_.isArray(result)) {
    let isErr = false;

    if (!_.isArray(result[0]) && result.length === 2) {
      isErr = valueIsError(result[0]);
    }

    if (!isErr) {
      if (
        _.isArray(result[0]) &&
        result.length === 1 &&
        result[0].length === 1
      ) {
        result = result[0][0];
      } else {
        dynamicArrayItem = { r, c, f: txt, id, data: result };
        result = "";
      }
    } else {
      result = result[0];
    }
  }

  window.luckysheetCurrentRow = null;
  window.luckysheetCurrentColumn = null;
  window.luckysheetCurrentIndex = null;
  window.luckysheetCurrentFunction = null;
  */
  const sheetId = id || ctx.currentSheetId;
  const originKey = `${sheetId}:${r}:${c}`;
  const deps = new Set<string>();
  ctx.formulaCache.formulasWithWideRangeDeps.delete(originKey);
  ctx.formulaCache.activeDepCollection = {
    originKey,
    deps,
    hasWideRangeDep: false,
  };

  ctx.formulaCache.parser.context = ctx;
  const parserExpression = normalizeDateArithmeticForParser(txt.substring(1));
  let parsedResponse: { error: any; result: any };
  let hasWideRangeDep = false;
  try {
    parsedResponse = ctx.formulaCache.parser.parse(parserExpression, {
      sheetId,
      row: r,
      column: c,
    });
  } finally {
    hasWideRangeDep =
      ctx.formulaCache.activeDepCollection?.hasWideRangeDep ?? false;
    ctx.formulaCache.activeDepCollection = null;
  }
  if (hasWideRangeDep) {
    ctx.formulaCache.formulasWithWideRangeDeps.add(originKey);
  }

  // Update dependency graph for this formula cell.
  const prevDeps =
    ctx.formulaCache.depsByCell.get(originKey) ?? new Set<string>();
  ctx.formulaCache.depsByCell.set(originKey, deps);
  // Remove reverse edges for dependencies no longer referenced.
  prevDeps.forEach((depKey) => {
    if (deps.has(depKey)) return;
    const rev = ctx.formulaCache.revDepsByCell.get(depKey);
    if (!rev) return;
    rev.delete(originKey);
    if (rev.size === 0) ctx.formulaCache.revDepsByCell.delete(depKey);
  });
  // Add reverse edges for newly referenced deps.
  deps.forEach((depKey) => {
    if (prevDeps.has(depKey)) return;
    const rev = ctx.formulaCache.revDepsByCell.get(depKey) ?? new Set<string>();
    rev.add(originKey);
    ctx.formulaCache.revDepsByCell.set(depKey, rev);
  });
  // Dense-sheet set depends on which tabs formulas reference.
  invalidateSheetsRequiredDenseCache();

  // Non-iterative circular dependency semantics.
  const cycleNodes = findCycleNodesFrom(originKey, ctx.formulaCache.depsByCell);
  if (cycleNodes.has(originKey)) {
    // Override any parser result/error; a cycle is always an error.
    parsedResponse.error = CIRCULAR_REF_ERROR;
    parsedResponse.result = CIRCULAR_REF_ERROR;
    setCellError(ctx, r, c, {
      row_column: `${r}_${c}`,
      title: CIRCULAR_REF_TITLE,
      message: 'Circular dependency.',
    });
  } else {
    clearCellError(ctx, r, c);
  }

  // Propagate upstream circular dependency errors to dependents.
  // If any referenced cell is circular, this formula is circular-by-propagation regardless
  // of what the parser/evaluator produced.
  if (deps.size > 0 && parsedResponse.error !== CIRCULAR_REF_ERROR) {
    for (const depKey of deps) {
      if (depKey === originKey) continue;
      const parsedKey = parseCellKey(depKey);
      if (!parsedKey) continue;
      // Use current-pass computed cache only. Falling back to flowdata here can
      // re-propagate stale "#CIRC!" from prior states during structural recalcs.
      const cell =
        ctx?.formulaCache.execFunctionGlobalData?.[
        `${parsedKey.r}_${parsedKey.c}_${parsedKey.sheetId}`
        ];
      if (_.isNil(cell)) continue;
      const raw = cell?.v ?? cell?.m;
      if (raw === CIRCULAR_REF_ERROR) {
        parsedResponse.error = CIRCULAR_REF_ERROR;
        parsedResponse.result = CIRCULAR_REF_ERROR;
        break;
      }
    }
  }

  const { error: formulaError } = parsedResponse;
  let { result } = parsedResponse;

  // https://stackoverflow.com/a/643827/8200626
  // https://github.com/ruilisi/fortune-sheet/issues/551
  if (
    Object.prototype.toString.call(result) === '[object Date]' &&
    !_.isNil(result)
  ) {
    result = result.toString();
  }

  if (!_.isNil(r) && !_.isNil(c)) {
    if (isrefresh) {
      let finalResult = result;
      if (
        ctx.formulaCache.parser.cryptoDenomination &&
        ctx.formulaCache.parser.cryptoDenomination !== '' &&
        (typeof result === 'number' || typeof result === 'string')
      ) {
        const resultStr = Number(result).toFixed(
          ctx.formulaCache.parser.cryptoDecimals,
        );
        finalResult = `${resultStr} ${ctx.formulaCache.parser.cryptoDenomination}`;
      }

      execFunctionGroup(
        ctx,
        r,
        c,
        _.isNil(formulaError) ? finalResult : formulaError,
        id,
      );
    }

    if (!notInsertFunc) {
      insertUpdateFunctionGroup(ctx, r, c, id, calcChainSet);
    }
  }

  /*
  if (sparklines) {
    return [true, result, txt, { type: "sparklines", data: sparklines }];
  }

  if (dynamicArrayItem) {
    return [
      true,
      result,
      txt,
      { type: "dynamicArrayItem", data: dynamicArrayItem },
    ];
  }
  */

  // FLV crypto denomination --START--
  let finalResult = result;
  if (
    ctx.formulaCache.parser.cryptoDenomination &&
    ctx.formulaCache.parser.cryptoDenomination !== '' &&
    (typeof result === 'number' || typeof result === 'string')
  ) {
    const resultStr = Number(result).toFixed(
      ctx.formulaCache.parser.cryptoDecimals,
    );
    finalResult = `${resultStr} ${ctx.formulaCache.parser.cryptoDenomination}`;
  }
  const isError = !_.isNil(formulaError);
  const detectedErrorFromValue = detectErrorFromValue(finalResult?.toString());
  if (isError || detectedErrorFromValue) {
    setCellError(ctx, r, c, {
      row_column: `${r}_${c}`,
      title: formulaError === CIRCULAR_REF_ERROR ? CIRCULAR_REF_TITLE : 'Error',
      message:
        formulaError?.toString() || detectedErrorFromValue || 'Unknown Error',
    });
  } else {
    clearCellError(ctx, r, c);
  }
  const outputValue = !isError
    ? finalResult
    : formulaError === CIRCULAR_REF_ERROR
      ? CIRCULAR_REF_ERROR
      : '#ERROR';
  return [
    true,
    outputValue,
    originalTxt,
    isError && {
      row_column: `${r}_${c}`,
      title: formulaError === CIRCULAR_REF_ERROR ? CIRCULAR_REF_TITLE : 'Error',
      message:
        formulaError?.toString() || detectedErrorFromValue || 'Unknown Error',
    },
  ];
}

function insertUpdateDynamicArray(ctx: Context, dynamicArrayItem: any) {
  const { r, c } = dynamicArrayItem;
  let { id } = dynamicArrayItem;
  if (_.isNil(id)) {
    id = ctx.currentSheetId;
  }

  const { luckysheetfile } = ctx;
  const idx = getSheetIndex(ctx, id);
  if (idx == null) return [];

  const file = luckysheetfile[idx];

  let { dynamicArray } = file;
  if (_.isNil(dynamicArray)) {
    dynamicArray = [];
  }

  for (let i = 0; i < dynamicArray.length; i += 1) {
    const calc = dynamicArray[i];
    if (calc.r === r && calc.c === c && calc.id === id) {
      calc.data = dynamicArrayItem.data;
      calc.f = dynamicArrayItem.f;
      return dynamicArray;
    }
  }

  dynamicArray.push(dynamicArrayItem);
  return dynamicArray;
}

export function groupValuesRefresh(ctx: Context) {
  const { luckysheetfile } = ctx;
  if (ctx.groupValuesRefreshData.length > 0) {
    const ydocChangeMap = new Map<
      string,
      {
        sheetId: string;
        path: string[];
        key?: string;
        value: any;
        type?: 'update' | 'delete';
      }
    >();

    for (let i = 0; i < ctx.groupValuesRefreshData.length; i += 1) {
      const item = ctx.groupValuesRefreshData[i];

      // if(item.i !== ctx.currentSheetId){
      //     continue;
      // }

      const idx = getSheetIndex(ctx, item.id);
      if (idx == null) continue;

      const file = luckysheetfile[idx];
      let { data } = file;
      if (_.isNil(data)) {
        data = ensureSheetFlowdata(ctx, { id: item.id }) ?? undefined;
      }
      if (_.isNil(data)) {
        continue;
      }

      const updateValue: any = {};
      if (!_.isNil(item.spe)) {
        if (item.spe.type === 'sparklines') {
          updateValue.spl = item.spe.data;
        } else if (item.spe.type === 'dynamicArrayItem') {
          file.dynamicArray = insertUpdateDynamicArray(ctx, item.spe.data);
        }
      }
      updateValue.v = item.v;
      updateValue.f = item.f;
      setCellValue(ctx, item.r, item.c, data, updateValue);

      const cellValue = data?.[item.r]?.[item.c] ?? null;
      const mapKey = `${item.r}_${item.c}`;
      if (shouldPersistCelldataCell(cellValue)) {
        ydocChangeMap.set(`${item.id}:${mapKey}`, {
          sheetId: item.id,
          path: ['celldata'],
          value: { r: item.r, c: item.c, v: cellValue },
          key: mapKey,
          type: 'update',
        });
      } else {
        ydocChangeMap.set(`${item.id}:${mapKey}`, {
          sheetId: item.id,
          path: ['celldata'],
          key: mapKey,
          value: null,
          type: 'delete',
        });
      }
      // server.saveParam("v", item.id, data[item.r][item.c], {
      //     "r": item.r,
      //     "c": item.c
      // });
    }

    const ydocChanges = Array.from(ydocChangeMap.values());
    if (ydocChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
      ctx.hooks.updateCellYdoc(ydocChanges);
    }

    // editor.webWorkerFlowDataCache(Store.flowdata); // worker存数据
    ctx.groupValuesRefreshData = [];
  }
}

type FormulaRunListCell = {
  r: number;
  c: number;
  id: string;
  calc_funcStr: string;
  level?: number;
};

function evalFormulaCellInGroup(
  ctx: Context,
  formulaCell: FormulaRunListCell,
  calcChainSet: Set<string>,
  data: CellMatrix | null | undefined,
  impactedByCircular: Set<string>,
  cycleNodes: Set<string>,
) {
  ensureExecFunctionGlobalData(ctx);
  if ((formulaCell as { level?: unknown }).level === (Math as any).max) {
    return;
  }

  const { calc_funcStr } = formulaCell;

  const formulaCellKey = `${formulaCell.id}:${formulaCell.r}:${formulaCell.c}`;
  if (impactedByCircular.has(formulaCellKey)) {
    const isInCycle = cycleNodes.has(formulaCellKey);
    const message = isInCycle
      ? 'Circular dependency.'
      : 'Circular dependency (upstream).';
    setCellError(ctx, formulaCell.r, formulaCell.c, {
      row_column: `${formulaCell.r}_${formulaCell.c}`,
      title: CIRCULAR_REF_TITLE,
      message,
    });

    ctx.groupValuesRefreshData.push({
      r: formulaCell.r,
      c: formulaCell.c,
      v: CIRCULAR_REF_ERROR,
      f: calc_funcStr,
      id: formulaCell.id,
    });

    writeExecFunctionGlobalDataCell(
      ctx,
      formulaCell.r,
      formulaCell.c,
      formulaCell.id,
      {
        v: CIRCULAR_REF_ERROR,
        f: calc_funcStr,
      },
    );

    return;
  }

  const v = execfunction(
    ctx,
    calc_funcStr,
    formulaCell.r,
    formulaCell.c,
    formulaCell.id,
    calcChainSet,
  );

  const valueData = v?.[1];
  const valueFunction = v?.[2];

  if (Array.isArray(valueData)) {
    const spilled = spillSortResult(
      ctx,
      formulaCell.r,
      formulaCell.c,
      { v: valueData, f: valueFunction },
      data ?? undefined,
    );

    if (spilled) {
      const matrixTopLeftValue = Array.isArray(valueData[0])
        ? valueData[0][0]
        : valueData[0];

      ctx.groupValuesRefreshData.push({
        r: formulaCell.r,
        c: formulaCell.c,
        v: matrixTopLeftValue,
        f: valueFunction,
        spe: v[3],
        id: formulaCell.id,
      });

      writeExecFunctionGlobalDataCell(
        ctx,
        formulaCell.r,
        formulaCell.c,
        formulaCell.id,
        { v: matrixTopLeftValue, f: valueFunction },
      );

      return;
    }
  }

  ctx.groupValuesRefreshData.push({
    r: formulaCell.r,
    c: formulaCell.c,
    v: v[1],
    f: v[2],
    spe: v[3],
    id: formulaCell.id,
  });

  writeExecFunctionGlobalDataCell(
    ctx,
    formulaCell.r,
    formulaCell.c,
    formulaCell.id,
    {
      v: v[1],
      f: v[2],
    },
  );
}

function mergeFormulaDeps(
  ctx: Context,
  originKey: string,
  deps: Iterable<string>,
) {
  const depSet = new Set(deps);
  const prevDeps =
    ctx.formulaCache.depsByCell.get(originKey) ?? new Set<string>();
  ctx.formulaCache.depsByCell.set(originKey, depSet);
  prevDeps.forEach((depKey) => {
    if (depSet.has(depKey)) return;
    const rev = ctx.formulaCache.revDepsByCell.get(depKey);
    if (!rev) return;
    rev.delete(originKey);
    if (rev.size === 0) ctx.formulaCache.revDepsByCell.delete(depKey);
  });
  depSet.forEach((depKey) => {
    if (prevDeps.has(depKey)) return;
    const rev = ctx.formulaCache.revDepsByCell.get(depKey) ?? new Set<string>();
    rev.add(originKey);
    ctx.formulaCache.revDepsByCell.set(depKey, rev);
  });
  invalidateSheetsRequiredDenseCache();
}

/** Apply worker chunk output onto the live context (main thread only). */
export function applyWorkerFormulaChunkResults(
  ctx: Context,
  output: SnapshotEvalOutput,
  impactedByCircular: Set<string>,
  cycleNodes: Set<string>,
  calcChainKeys: string[] = [],
  data?: CellMatrix | null,
) {
  ensureExecFunctionGlobalData(ctx);
  const calcChainSet = new Set(calcChainKeys);

  for (const result of output.results) {
    const formulaCellKey = `${result.id}:${result.r}:${result.c}`;

    if (impactedByCircular.has(formulaCellKey)) {
      const isInCycle = cycleNodes.has(formulaCellKey);
      const message = isInCycle
        ? 'Circular dependency.'
        : 'Circular dependency (upstream).';
      setCellError(ctx, result.r, result.c, {
        row_column: `${result.r}_${result.c}`,
        title: CIRCULAR_REF_TITLE,
        message,
      });
      ctx.groupValuesRefreshData.push({
        r: result.r,
        c: result.c,
        v: CIRCULAR_REF_ERROR,
        f: result.f,
        id: result.id,
      });
      writeExecFunctionGlobalDataCell(ctx, result.r, result.c, result.id, {
        v: CIRCULAR_REF_ERROR,
        f: result.f,
      });
      continue;
    }

    if (Array.isArray(result.v)) {
      evalFormulaCellInGroup(
        ctx,
        {
          r: result.r,
          c: result.c,
          id: result.id,
          calc_funcStr: result.f,
        },
        calcChainSet,
        data,
        impactedByCircular,
        cycleNodes,
      );
      continue;
    }

    mergeFormulaDeps(ctx, formulaCellKey, result.deps);

    if (result.isError) {
      setCellError(ctx, result.r, result.c, {
        row_column: `${result.r}_${result.c}`,
        title: 'Error',
        message: String(result.v ?? 'Unknown Error'),
      });
    } else {
      clearCellError(ctx, result.r, result.c);
    }

    ctx.groupValuesRefreshData.push({
      r: result.r,
      c: result.c,
      v: result.v,
      f: result.f,
      id: result.id,
    });
    writeExecFunctionGlobalDataCell(ctx, result.r, result.c, result.id, {
      v: result.v,
      f: result.f,
    });
  }
}

/** Run up to `chunkSize` formulas from an async job. Returns true when job is complete. */
export function runFormulaEvalChunk(
  ctx: Context,
  job: FormulaAsyncEvalJob,
  chunkSize = FORMULA_ASYNC_CHUNK_SIZE,
): boolean {
  ensureExecFunctionGlobalData(ctx);
  const calcChainSet = new Set(job.calcChainKeys);
  const impactedByCircular = new Set(job.impactedByCircular);
  const cycleNodes = new Set(job.cycleNodes);
  const data = getFlowdata(ctx);
  const end = Math.min(job.nextIndex + chunkSize, job.formulaRunList.length);

  for (let i = job.nextIndex; i < end; i += 1) {
    const formulaCell = job.formulaRunList[i];
    evalFormulaCellInGroup(
      ctx,
      formulaCell,
      calcChainSet,
      data,
      impactedByCircular,
      cycleNodes,
    );
  }

  job.nextIndex = end;
  const complete = end >= job.formulaRunList.length;
  if (complete) {
    ctx.formulaCache.execFunctionExist = undefined;
    clearRangeValuePassCache(ctx.formulaCache);
    ctx.formulaCache.execFunctionGlobalData = null;
  }
  return complete;
}

/**
 * Re-evaluate formula cells that reference the given defined names
 * (e.g. after a named range was edited, shifted, or deleted).
 */
export function refreshFormulasUsingDefinedNames(
  ctx: Context,
  names: string[],
) {
  if (!names.length) return;
  const patterns = names
    .map((n) => n.trim())
    .filter(Boolean)
    .map(
      (n) =>
        new RegExp(
          `(^|[^A-Za-z0-9_.])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_.])`,
          'i',
        ),
    );
  if (!patterns.length) return;

  const calcChains = getAllFunctionGroup(ctx);
  const touched: { r: number; c: number; i: string }[] = [];
  for (let i = 0; i < calcChains.length; i += 1) {
    const cell = calcChains[i];
    const f = getcellFormula(ctx, cell.r, cell.c, cell.id);
    if (!f) continue;
    if (!patterns.some((re) => re.test(f))) continue;
    touched.push({ r: cell.r, c: cell.c, i: cell.id! });
  }
  if (!touched.length) return;

  ctx.formulaCache.execFunctionExist = touched;
  // @ts-expect-error: full named-range refresh passes null for origin
  execFunctionGroup(ctx, null, null, null, null, getFlowdata(ctx));
  ctx.formulaCache.execFunctionExist = undefined;
}

export function execFunctionGroup(
  ctx: Context,
  origin_r: number,
  origin_c: number,
  value: any,
  id?: string,
  data?: any,
  isForce = false,
) {
  if (_.isNil(data)) {
    data = getFlowdata(ctx);
  }

  if (_.isNil(id)) {
    id = ctx.currentSheetId;
  }

  // if (!window.luckysheet_compareWith) {
  //   window.luckysheet_compareWith = luckysheet_compareWith;
  //   window.luckysheet_getarraydata = luckysheet_getarraydata;
  //   window.luckysheet_getcelldata = luckysheet_getcelldata;
  //   window.luckysheet_parseData = luckysheet_parseData;
  //   window.luckysheet_getValue = luckysheet_getValue;
  //   window.luckysheet_indirect_check = luckysheet_indirect_check;
  //   window.luckysheet_indirect_check_return = luckysheet_indirect_check_return;
  //   window.luckysheet_offset_check = luckysheet_offset_check;
  //   window.luckysheet_calcADPMM = luckysheet_calcADPMM;
  //   window.luckysheet_getSpecialReference = luckysheet_getSpecialReference;
  // }

  // Start each group execution with a fresh pass-local cache so circular
  // propagation only reads values produced in the current recalculation pass.
  ctx.formulaCache.execFunctionGlobalData = {};
  beginRangeValuePassCache(ctx.formulaCache);
  // let luckysheetfile = getluckysheetfile();

  const originKey = `${id}:${origin_r}:${origin_c}`;
  const cycleNodes = findCycleNodesFrom(originKey, ctx.formulaCache.depsByCell);
  const impactedByCircular = cycleNodes.size
    ? collectImpactedFromCycles(cycleNodes, ctx.formulaCache.revDepsByCell)
    : new Set<string>();

  if (!_.isNil(value)) {
    // 此处setcellvalue 中this.execFunctionGroupData会保存想要更新的值，本函数结尾不要设为null,以备后续函数使用
    // setcellvalue(origin_r, origin_c, _this.execFunctionGroupData, value);
    const cellCache: Cell[][] = [[{ v: undefined }]];
    setCellValue(ctx, 0, 0, cellCache, value);
    [
      [
        ctx.formulaCache.execFunctionGlobalData[
        `${origin_r}_${origin_c}_${id}`
        ],
      ],
    ] = cellCache;
  }

  // { "r": r, "c": c, "id": id, "func": func}
  const calcChains = getAllFunctionGroup(ctx);
  let calcChainsToProcess = calcChains;
  if (
    !isForce &&
    !_.isNil(origin_r) &&
    !_.isNil(origin_c) &&
    !_.isNil(id) &&
    ctx.formulaCache.revDepsByCell.size > 0
  ) {
    const dependents = collectTransitiveFormulaDependents(
      originKey,
      ctx.formulaCache.revDepsByCell,
    );
    ctx.formulaCache.formulasWithWideRangeDeps.forEach((formulaKey) => {
      dependents.add(formulaKey);
    });
    // Cold dep graph / named-range-only formulas: if the edited cell sits inside
    // a defined name, include calc-chain formulas that mention that name.
    const coveringNames = (ctx.definedNames || []).filter(
      (dn) =>
        dn.sheetId === id &&
        origin_r >= dn.range.row[0] &&
        origin_r <= dn.range.row[1] &&
        origin_c >= dn.range.column[0] &&
        origin_c <= dn.range.column[1],
    );
    if (coveringNames.length > 0) {
      const nameKeys = coveringNames.map((dn) => dn.name.toLowerCase());
      for (let i = 0; i < calcChains.length; i += 1) {
        const cell = calcChains[i];
        const formulaKey = `${cell.id}:${cell.r}:${cell.c}`;
        if (dependents.has(formulaKey)) continue;
        const f = getcellFormula(ctx, cell.r, cell.c, cell.id);
        if (!f) continue;
        const upper = f.toUpperCase();
        for (let n = 0; n < nameKeys.length; n += 1) {
          const name = nameKeys[n];
          // Case-insensitive whole-token match (avoid matching prefixes).
          const re = new RegExp(
            `(^|[^A-Z0-9_.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Z0-9_.])`,
            'i',
          );
          if (re.test(upper)) {
            dependents.add(formulaKey);
            break;
          }
        }
      }
    }
    if (dependents.size > 0) {
      calcChainsToProcess = calcChains.filter((cell) =>
        dependents.has(`${cell.id}:${cell.r}:${cell.c}`),
      );
    }
  }
  const formulaObjects: any = {};

  const sheets = ctx.luckysheetfile;
  const sheetData: any = {};
  for (let i = 0; i < sheets.length; i += 1) {
    const sheet = sheets[i];
    sheetData[sheet.id!] = sheet.data;
  }

  // 把修改涉及的单元格存储为对象
  const updateValueOjects: any = {};
  const updateValueArray: any = [];
  if (_.isNil(ctx.formulaCache.execFunctionExist)) {
    const key = `r${origin_r}c${origin_c}i${id}`;
    updateValueOjects[key] = 1;
  } else {
    for (let x = 0; x < ctx.formulaCache.execFunctionExist.length; x += 1) {
      const cell = ctx.formulaCache.execFunctionExist[x] as any;
      const key = `r${cell.r}c${cell.c}i${cell.i}`;
      updateValueOjects[key] = 1;
    }
  }

  const arrayMatchCache: Record<
    string,
    { key: string; r: number; c: number; sheetId: string }[]
  > = {};
  const arrayMatch = (
    formulaArray: any,
    _formulaObjects: any,
    _updateValueOjects: any,
    func: any,
  ) => {
    for (let a = 0; a < formulaArray.length; a += 1) {
      const range = formulaArray[a];
      const cacheKey = `r${range.row[0]}${range.row[1]}c${range.column[0]}${range.column[1]}id${range.sheetId}`;
      if (cacheKey in arrayMatchCache) {
        const amc = arrayMatchCache[cacheKey];
        // console.log(amc);
        amc.forEach((item) => {
          func(item.key, item.r, item.c, item.sheetId);
        });
      } else {
        const functionArr = [];
        for (let r = range.row[0]; r <= range.row[1]; r += 1) {
          for (let c = range.column[0]; c <= range.column[1]; c += 1) {
            const key = `r${r}c${c}i${range.sheetId}`;
            func(key, r, c, range.sheetId);
            if (
              (_formulaObjects && key in _formulaObjects) ||
              (_updateValueOjects && key in _updateValueOjects)
            ) {
              functionArr.push({
                key,
                r,
                c,
                sheetId: range.sheetId,
              });
            }
          }
        }

        if (_formulaObjects || _updateValueOjects) {
          arrayMatchCache[cacheKey] = functionArr;
        }
      }
    }
  };

  // 创建公式缓存及其范围的缓存
  // console.time("1");
  for (let i = 0; i < calcChainsToProcess.length; i += 1) {
    const formulaCell = calcChainsToProcess[i];
    const key = `r${formulaCell.r}c${formulaCell.c}i${formulaCell.id}`;
    const calc_funcStr = getcellFormula(
      ctx,
      formulaCell.r,
      formulaCell.c,
      formulaCell.id,
    );
    if (_.isNil(calc_funcStr)) {
      continue;
    }
    const txt1 = calc_funcStr.toUpperCase();
    const isOffsetFunc =
      txt1.indexOf('INDIRECT(') > -1 ||
      txt1.indexOf('OFFSET(') > -1 ||
      txt1.indexOf('INDEX(') > -1;
    const formulaArray = [];

    if (isOffsetFunc) {
      isFunctionRange(
        ctx,
        calc_funcStr,
        null,
        null,
        formulaCell.id,
        null,
        (str_nb: string) => {
          const range = getcellrange(ctx, _.trim(str_nb), formulaCell.id);
          if (!_.isNil(range)) {
            formulaArray.push(range);
          }
        },
      );
    } else if (
      !(
        calc_funcStr.substring(0, 2) === '="' &&
        calc_funcStr.substring(calc_funcStr.length - 1, 1) === '"'
      )
    ) {
      // let formulaTextArray = calc_funcStr.split(/==|!=|<>|<=|>=|[,()=+-\/*%&^><]/g);//无法正确分割单引号或双引号之间有==、!=、-等运算符的情况。导致如='1-2'!A1公式中表名1-2的A1单元格内容更新后，公式的值不更新的bug
      // 解决='1-2'!A1+5会被calc_funcStr.split(/==|!=|<>|<=|>=|[,()=+-\/*%&^><]/g)分割成["","'1","2'!A1",5]的错误情况
      let point = 0; // 指针
      let squote = -1; // 双引号
      let dquote = -1; // 单引号
      const formulaTextArray = [];
      const sq_end_array = []; // 保存了配对的单引号在formulaTextArray的index索引。
      const calc_funcStr_length = calc_funcStr.length;
      for (let j = 0; j < calc_funcStr_length; j += 1) {
        const char = calc_funcStr.charAt(j);
        if (char === "'" && dquote === -1) {
          // 如果是单引号开始
          if (squote === -1) {
            if (point !== j) {
              formulaTextArray.push(
                ...calc_funcStr
                  .substring(point, j)
                  .split(/==|!=|<>|<=|>=|[,()=+-/*%&^><]/),
              );
            }
            squote = j;
            point = j;
          } // 单引号结束
          else {
            // if (squote === i - 1)//配对的单引号后第一个字符不能是单引号
            // {
            //    ;//到此处说明公式错误
            // }
            // 如果是''代表着输出'
            if (
              j < calc_funcStr_length - 1 &&
              calc_funcStr.charAt(j + 1) === "'"
            ) {
              j += 1;
            } else {
              // 如果下一个字符不是'代表单引号结束
              // if (calc_funcStr.charAt(i - 1) === "'") {//配对的单引号后最后一个字符不能是单引号
              //    ;//到此处说明公式错误
              point = j + 1;
              formulaTextArray.push(calc_funcStr.substring(squote, point));
              sq_end_array.push(formulaTextArray.length - 1);
              squote = -1;
              // } else {
              //    point = i + 1;
              //    formulaTextArray.push(calc_funcStr.substring(squote, point));
              //    sq_end_array.push(formulaTextArray.length - 1);
              //    squote = -1;
              // }
            }
          }
        }
        if (char === '"' && squote === -1) {
          // 如果是双引号开始
          if (dquote === -1) {
            if (point !== j) {
              formulaTextArray.push(
                ...calc_funcStr
                  .substring(point, j)
                  .split(/==|!=|<>|<=|>=|[,()=+-/*%&^><]/),
              );
            }
            dquote = j;
            point = j;
          } else {
            // 如果是""代表着输出"
            if (
              j < calc_funcStr_length - 1 &&
              calc_funcStr.charAt(j + 1) === '"'
            ) {
              j += 1;
            } else {
              // 双引号结束
              point = j + 1;
              formulaTextArray.push(calc_funcStr.substring(dquote, point));
              dquote = -1;
            }
          }
        }
      }
      if (point !== calc_funcStr_length) {
        formulaTextArray.push(
          ...calc_funcStr
            .substring(point, calc_funcStr_length)
            .split(/==|!=|<>|<=|>=|[,()=+-/*%&^><]/),
        );
      }
      // 拼接所有配对单引号及之后一个单元格内容，例如["'1-2'","!A1"]拼接为["'1-2'!A1"]
      for (let j = sq_end_array.length - 1; j >= 0; j -= 1) {
        if (sq_end_array[j] !== formulaTextArray.length - 1) {
          formulaTextArray[sq_end_array[j]] +=
            formulaTextArray[sq_end_array[j] + 1];
          formulaTextArray.splice(sq_end_array[j] + 1, 1);
        }
      }
      // 至此=SUM('1-2'!A1:A2&"'1-2'!A2")由原来的["","SUM","'1","2'!A1:A2","",""'1","2'!A2""]更正为["","SUM","","'1-2'!A1:A2","","",""'1-2'!A2""]

      for (let j = 0; j < formulaTextArray.length; j += 1) {
        const t = formulaTextArray[j];
        if (t.length <= 1) {
          continue;
        }

        if (
          t.substring(0, 1) === '"' &&
          t.substring(t.length - 1, 1) === '"'
        ) {
          continue;
        }

        if (!iscelldata(t)) {
          // Named ranges are not A1 tokens; resolve so dependents still recalculate.
          const dn = resolveDefinedNameForFormula(
            ctx.definedNames,
            _.trim(t),
            formulaCell.id,
          );
          if (dn) {
            formulaArray.push({
              row: [dn.range.row[0], dn.range.row[1]],
              column: [dn.range.column[0], dn.range.column[1]],
              sheetId: dn.sheetId,
            });
          }
          continue;
        }

        const range = getcellrange(ctx, _.trim(t), formulaCell.id);

        if (_.isNil(range)) {
          continue;
        }

        formulaArray.push(range);
      }
    }

    const item = {
      formulaArray,
      calc_funcStr,
      key,
      r: formulaCell.r,
      c: formulaCell.c,
      id: formulaCell.id,
      parents: {},
      chidren: {},
      color: 'w',
    };

    formulaObjects[key] = item;

    // if(isForce){
    //     updateValueArray.push(item);
    // }
    // else{
    //     arrayMatch(formulaArray, null, function(key){
    //         if(key in updateValueOjects){
    //             updateValueArray.push(item);
    //         }
    //     });
    // }
  }

  // console.timeEnd("1");

  // console.time("2");
  // 形成一个公式之间引用的图结构
  Object.keys(formulaObjects).forEach((key) => {
    const formulaObject = formulaObjects[key];
    arrayMatch(
      formulaObject.formulaArray,
      formulaObjects,
      updateValueOjects,
      (childKey: string) => {
        if (childKey in formulaObjects) {
          const childFormulaObject = formulaObjects[childKey];
          formulaObject.chidren[childKey] = 1;
          childFormulaObject.parents[key] = 1;
        }
        // console.log(childKey,formulaObject.formulaArray);
        if (!isForce && childKey in updateValueOjects) {
          updateValueArray.push(formulaObject);
        }
      },
    );

    if (isForce) {
      updateValueArray.push(formulaObject);
    }
  });

  // Named ranges (and other non-A1 refs) never appear in formulaArray, so the
  // text-scan above misses them. Seed the run list from the reverse dep graph
  // recorded during execfunction / callVariable.
  if (
    !isForce &&
    !_.isNil(origin_r) &&
    !_.isNil(origin_c) &&
    !_.isNil(id) &&
    ctx.formulaCache.revDepsByCell.size > 0
  ) {
    const depDependents = collectTransitiveFormulaDependents(
      originKey,
      ctx.formulaCache.revDepsByCell,
    );
    ctx.formulaCache.formulasWithWideRangeDeps.forEach((formulaKey) => {
      depDependents.add(formulaKey);
    });
    if (depDependents.size > 0) {
      const alreadyQueued = new Set(
        updateValueArray.map((fo: { key: string }) => fo.key),
      );
      Object.keys(formulaObjects).forEach((key) => {
        if (alreadyQueued.has(key)) return;
        const fo = formulaObjects[key];
        if (depDependents.has(`${fo.id}:${fo.r}:${fo.c}`)) {
          updateValueArray.push(fo);
        }
      });
    }
  }

  // console.log(formulaObjects)
  // console.timeEnd("2");

  // console.time("3");
  const formulaRunList = [];
  // 计算，采用深度优先遍历公式形成的图结构

  // updateValueArray.forEach((key)=>{
  //     let formulaObject = formulaObjects[key];

  // });

  let stack = updateValueArray;
  const existsFormulaRunList: any = {};
  while (stack.length > 0) {
    const formulaObject = stack.pop();

    if (_.isNil(formulaObject) || formulaObject.key in existsFormulaRunList) {
      continue;
    }

    if (formulaObject.color === 'b') {
      formulaRunList.push(formulaObject);
      existsFormulaRunList[formulaObject.key] = 1;
      continue;
    }

    const cacheStack: any = [];
    Object.keys(formulaObject.parents).forEach((parentKey) => {
      const parentFormulaObject = formulaObjects[parentKey];
      if (!_.isNil(parentFormulaObject)) {
        cacheStack.push(parentFormulaObject);
      }
    });

    if (cacheStack.length === 0) {
      formulaRunList.push(formulaObject);
      existsFormulaRunList[formulaObject.key] = 1;
    } else {
      formulaObject.color = 'b';
      stack.push(formulaObject);
      stack = stack.concat(cacheStack);
    }
  }

  formulaRunList.reverse();

  const calcChainSet = new Set<string>();
  calcChains.forEach((item) => {
    calcChainSet.add(`${item.r}_${item.c}_${item.id}`);
  });

  // console.log(formulaObjects, ii)
  // console.timeEnd("3");

  // console.time("4");
  if (formulaRunList.length >= FORMULA_ASYNC_EVAL_THRESHOLD) {
    ctx.formulaAsyncEval = {
      formulaRunList: formulaRunList.map((f: any) => ({
        r: f.r,
        c: f.c,
        id: f.id,
        calc_funcStr: f.calc_funcStr,
        level: f.level,
      })),
      calcChainKeys: Array.from(calcChainSet),
      impactedByCircular: Array.from(impactedByCircular),
      cycleNodes: Array.from(cycleNodes),
      workerSnapshotKey: `formula-job-${(formulaAsyncEvalJobId += 1)}`,
      nextIndex: 0,
      total: formulaRunList.length,
      debug: {
        mode: 'main-thread',
        lastChunkMs: 0,
        lastChunkSize: 0,
        completedChunks: 0,
        fallbackChunks: 0,
        workerAvailable: false,
        unsafeFormulaCount: 0,
        workerFormulaCount: 0,
        totalWorkerFormulas: 0,
        totalMainThreadFormulas: 0,
        lastError: null,
      },
    };
    ctx.isFormulaCalculating = true;
    return;
  }

  for (let i = 0; i < formulaRunList.length; i += 1) {
    const formulaCell = formulaRunList[i];
    evalFormulaCellInGroup(
      ctx,
      formulaCell,
      calcChainSet,
      data,
      impactedByCircular,
      cycleNodes,
    );
  }
  // console.log(formulaRunList);
  // console.timeEnd("4");

  ctx.formulaCache.execFunctionExist = undefined;
  clearRangeValuePassCache(ctx.formulaCache);
}

function findrangeindex(ctx: Context, v: string, vp: string) {
  const re = /<span.*?>/g;
  const v_a = v.replace(re, '').split('</span>');
  const vp_a = vp.replace(re, '').split('</span>');
  v_a.pop();
  if (vp_a[vp_a.length - 1] === '') vp_a.pop();

  let pfri = ctx.formulaCache.functionRangeIndex;
  if (pfri == null) return [];

  const vplen = vp_a.length;
  const vlen = v_a.length;
  // 不增加元素输入
  if (vplen === vlen) {
    const i = pfri[0];
    const p = vp_a[i];
    const n = v_a[i];

    if (_.isNil(p)) {
      if (vp_a.length <= i) {
        pfri = [vp_a.length - 1, vp_a.length - 1];
      } else if (v_a.length <= i) {
        pfri = [v_a.length - 1, v_a.length - 1];
      }

      return pfri;
    }
    if (p.length === n.length) {
      if (
        !_.isNil(vp_a[i + 1]) &&
        !_.isNil(v_a[i + 1]) &&
        vp_a[i + 1].length < v_a[i + 1].length
      ) {
        pfri[0] += 1;
        pfri[1] = 1;
      }

      return pfri;
    }
    if (p.length > n.length) {
      if (
        !_.isNil(p) &&
        !_.isNil(v_a[i + 1]) &&
        v_a[i + 1].substring(0, 1) === '"' &&
        (p.indexOf('{') > -1 || p.indexOf('}') > -1)
      ) {
        pfri[0] += 1;
        pfri[1] = 1;
      }

      return pfri;
    }
    if (p.length < n.length) {
      if (pfri[1] > n.length) {
        pfri[1] = n.length;
      }

      return pfri;
    }
  }
  // 减少元素输入
  else if (vplen > vlen) {
    const i = pfri[0];
    const p = vp_a[i];
    const n = v_a[i];

    if (_.isNil(n)) {
      if (v_a[i - 1].indexOf('{') > -1) {
        pfri[0] -= 1;
        const start = v_a[i - 1].search('{');
        pfri[1] += start;
      } else {
        pfri[0] = 0;
        pfri[1] = 0;
      }
    } else if (p.length === n.length) {
      if (
        !_.isNil(v_a[i + 1]) &&
        (v_a[i + 1].substring(0, 1) === '"' ||
          v_a[i + 1].substring(0, 1) === '{' ||
          v_a[i + 1].substring(0, 1) === '}')
      ) {
        pfri[0] += 1;
        pfri[1] = 1;
      } else if (
        !_.isNil(p) &&
        p.length > 2 &&
        p.substring(0, 1) === '"' &&
        p.substring(p.length - 1, 1) === '"'
      ) {
        // pfri[1] = n.length-1;
      } else if (!_.isNil(v_a[i]) && v_a[i] === '")') {
        pfri[1] = 1;
      } else if (!_.isNil(v_a[i]) && v_a[i] === '"}') {
        pfri[1] = 1;
      } else if (!_.isNil(v_a[i]) && v_a[i] === '{)') {
        pfri[1] = 1;
      } else {
        pfri[1] = n.length;
      }

      return pfri;
    } else if (p.length > n.length) {
      if (
        !_.isNil(v_a[i + 1]) &&
        (v_a[i + 1].substring(0, 1) === '"' ||
          v_a[i + 1].substring(0, 1) === '{' ||
          v_a[i + 1].substring(0, 1) === '}')
      ) {
        pfri[0] += 1;
        pfri[1] = 1;
      }

      return pfri;
    } else if (p.length < n.length) {
      return pfri;
    }

    return pfri;
  }
  // 增加元素输入
  else if (vplen < vlen) {
    const i = pfri[0];
    const p = vp_a[i];
    const n = v_a[i];

    if (_.isNil(p)) {
      pfri[0] = v_a.length - 1;

      if (!_.isNil(n)) {
        pfri[1] = n.length;
      } else {
        pfri[1] = 1;
      }
    } else if (p.length === n.length) {
      if (
        vp_a[i + 1] != null &&
        (vp_a[i + 1].substring(0, 1) === '"' ||
          vp_a[i + 1].substring(0, 1) === '{' ||
          vp_a[i + 1].substring(0, 1) === '}')
      ) {
        pfri[1] = n.length;
      } else if (
        !_.isNil(v_a[i + 1]) &&
        v_a[i + 1].substring(0, 1) === '"' &&
        (v_a[i + 1].substring(0, 1) === '{' ||
          v_a[i + 1].substring(0, 1) === '}')
      ) {
        pfri[0] += 1;
        pfri[1] = 1;
      } else if (
        !_.isNil(n) &&
        n.substring(0, 1) === '"' &&
        n.substring(n.length - 1, 1) === '"' &&
        p.substring(0, 1) === '"' &&
        p.substring(p.length - 1, 1) === ')'
      ) {
        pfri[1] = n.length;
      } else if (
        !_.isNil(n) &&
        n.substring(0, 1) === '{' &&
        n.substring(n.length - 1, 1) === '}' &&
        p.substring(0, 1) === '{' &&
        p.substring(p.length - 1, 1) === ')'
      ) {
        pfri[1] = n.length;
      } else {
        pfri[0] = pfri[0] + vlen - vplen;
        if (v_a.length > vp_a.length) {
          pfri[1] = v_a[i + 1].length;
        } else {
          pfri[1] = 1;
        }
      }

      return pfri;
    } else if (p.length > n.length) {
      if (!_.isNil(p) && p.substring(0, 1) === '"') {
        pfri[1] = n.length;
      } else if (_.isNil(v_a[i + 1]) && /{.*?}/.test(v_a[i + 1])) {
        pfri[0] += 1;
        pfri[1] = v_a[i + 1].length;
      } else if (
        !_.isNil(p) &&
        v_a[i + 1].substring(0, 1) === '"' &&
        (p.indexOf('{') > -1 || p.indexOf('}') > -1)
      ) {
        pfri[0] += 1;
        pfri[1] = 1;
      } else if (!_.isNil(p) && (p.indexOf('{') > -1 || p.indexOf('}') > -1)) {
      } else if (
        !_.isNil(p) &&
        !_.startsWith(p[0], '=') &&
        _.startsWith(n, '=')
      ) {
        return [vlen - 1, v_a[vlen - 1].length];
      } else {
        pfri[0] = pfri[0] + vlen - vplen - 1;
        pfri[1] = v_a[(i || 1) - 1].length;
      }

      return pfri;
    } else if (p.length < n.length) {
      return pfri;
    }

    return pfri;
  }

  return null;
}

/**
 * Before the first `moveHighlightCell/Range(..., "rangeOfFormula")` while editing
 * a formula, copy the current yellow selection into `func_selectedrange` so
 * keyboard navigation updates only the blue formula overlay (like mouse drag),
 * without resizing `luckysheet_select_save`.
 */
export function seedFormulaFuncSelectedRangeFromLastSelection(
  ctx: Context,
): boolean {
  if (ctx.formulaCache.func_selectedrange) return true;
  const sel = ctx.luckysheet_select_save;
  if (!sel?.length) return false;
  const last = sel[sel.length - 1];
  if (!last?.row?.length || !last?.column?.length) return false;
  ctx.formulaCache.func_selectedrange = {
    left: last.left,
    width: last.width,
    top: last.top,
    height: last.height,
    left_move: last.left_move,
    width_move: last.width_move,
    top_move: last.top_move,
    height_move: last.height_move,
    row: [...last.row],
    column: [...last.column],
    row_focus: last.row_focus,
    column_focus: last.column_focus,
    moveXY: last.moveXY,
  };
  return true;
}

export function createFormulaRangeSelect(
  ctx: Context,
  select: { rangeIndex: number } & Rect,
) {
  ctx.formulaRangeSelect = select;
}

export function createRangeHightlight(
  ctx: Context,
  inputInnerHtmlStr: string,
  ignoreRangeIndex = -1,
) {
  const $span = parseElement(`<div>${inputInnerHtmlStr}</div>`) as HTMLElement;
  const formulaRanges: {
    rangeIndex: number;
    left: number;
    top: number;
    width: number;
    height: number;
    backgroundColor: string;
  }[] = [];
  $span
    .querySelectorAll('span.fortune-formula-functionrange-cell')
    .forEach((ele) => {
      const rangeIndex = parseInt(ele.getAttribute('rangeindex') || '0', 10);
      if (rangeIndex === ignoreRangeIndex) return;
      const cellrange = getcellrange(ctx, ele.textContent || '');
      if (
        rangeIndex === ctx.formulaCache.selectingRangeIndex ||
        cellrange == null
      )
        return;
      if (
        cellrange.sheetId === ctx.currentSheetId ||
        (cellrange.sheetId === -1 &&
          ctx.formulaCache.rangetosheet === ctx.currentSheetId)
      ) {
        const rect = seletedHighlistByindex(
          ctx,
          cellrange.row[0],
          cellrange.row[1],
          cellrange.column[0],
          cellrange.column[1],
        );
        if (rect) {
          formulaRanges.push({
            rangeIndex,
            ...rect,
            backgroundColor: colors[rangeIndex],
          });
        }
      }
    });
  ctx.formulaRangeHighlight = formulaRanges;
}

export function moveCursorToEnd(
  editableDiv: HTMLDivElement | null | undefined,
) {
  if (!editableDiv) return;
  if (!(editableDiv instanceof Node)) return;
  editableDiv.focus(); // Ensure the element is focused

  const range = document.createRange();
  const selection = window.getSelection();

  // Set range to cover the entire content
  range.selectNodeContents(editableDiv);
  range.collapse(false); // Collapse to the end

  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function getLogicalNodeLength(node: Node | null | undefined): number {
  if (!node) return 0;
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.length || 0;
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  const el = node as HTMLElement;
  if (el.tagName.toLowerCase() === 'br') return 1;
  let len = 0;
  el.childNodes.forEach((child) => {
    len += getLogicalNodeLength(child);
  });
  return len;
}

export function setCaretPosition(
  ctx: Context,
  textDom: HTMLElement,
  children: number,
  pos: number,
  parentTextDom?: HTMLElement,
) {
  try {
    const el = textDom;
    const range = document.createRange();
    const sel = window.getSelection();

    const mainSpan = document.querySelector('.luckysheet-formula-text-string');
    let textContent = mainSpan?.firstChild?.nodeValue?.trim() || '';
    const innerSpan = mainSpan?.querySelector(
      '.fortune-formula-functionrange-cell',
    );
    if (innerSpan && mainSpan) {
      textContent += innerSpan.textContent;
      el.innerHTML = textContent;
    }

    const child = el.childNodes[children];
    if (!child) {
      range.setStart(el, Math.min(pos, el.childNodes.length));
    } else if (
      child.nodeType === Node.ELEMENT_NODE &&
      (child as Element).nodeName.toLowerCase() === 'br'
    ) {
      // `pos` is logical char offset in span text, but <span><br>TEXT</span>
      // has two child nodes where element offsets are node-index based.
      // Map logical offsets explicitly:
      // - 0: before <br>
      // - 1: right after <br> (start of second line)
      // - >=2: inside following text node at offset (pos - 1)
      const textAfterBr = el.childNodes[children + 1];
      if (pos <= 0) {
        range.setStart(el, 0);
      } else if (textAfterBr && textAfterBr.nodeType === Node.TEXT_NODE) {
        if (pos === 1) {
          range.setStart(el, 1);
        } else {
          const textLen = textAfterBr.nodeValue?.length || 0;
          range.setStart(textAfterBr, Math.min(Math.max(pos - 1, 0), textLen));
        }
      } else {
        // When span is only `<br>` (empty second line), browser may render
        // caret at previous-line end for element offsets. Insert a transient
        // zero-width text anchor so caret visually stays on the empty line.
        let trailingTextNode: Node | null = null;
        if (
          el.childNodes.length === 1 &&
          el.firstChild &&
          el.firstChild.nodeType === Node.ELEMENT_NODE &&
          (el.firstChild as HTMLElement).tagName.toLowerCase() === 'br'
        ) {
          trailingTextNode = document.createTextNode('\u200b');
          el.appendChild(trailingTextNode);
        }
        if (trailingTextNode && trailingTextNode.nodeType === Node.TEXT_NODE) {
          range.setStart(trailingTextNode, 0);
        } else {
          range.setStart(el, Math.min(1, el.childNodes.length));
        }
      }
    } else {
      if (child.nodeType === Node.TEXT_NODE) {
        const textLen = child.nodeValue?.length || 0;
        range.setStart(child, Math.min(Math.max(pos, 0), textLen));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        range.setStart(
          child,
          Math.min(Math.max(pos, 0), child.childNodes.length),
        );
      } else {
        range.setStart(el, Math.min(Math.max(pos, 0), el.childNodes.length));
      }
    }
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    el.focus();
  } catch {
    // Avoid crashing on invalid fallback element; best-effort caret placement.
    if (parentTextDom && parentTextDom instanceof HTMLElement) {
      moveCursorToEnd(parentTextDom as HTMLDivElement);
    }
  }
}

function functionRange(
  ctx: Context,
  obj: HTMLDivElement,
  v: string,
  vp: string,
) {
  if (window.getSelection) {
    // ie11 10 9 ff safari
    const currSelection = window.getSelection();
    if (!currSelection) return;
    const spans = obj.querySelectorAll('span');
    const globalOffset = ctx.formulaCache.functionRangeGlobalOffset;
    let fri: [number, number] | null = null;
    if (
      typeof globalOffset === 'number' &&
      Number.isFinite(globalOffset) &&
      spans.length > 0
    ) {
      // Walk post-render top-level children, decrementing the global char offset.
      // Lands in the span containing the caret regardless of span re-splits.
      let remaining = Math.max(0, globalOffset);
      let spanIdx = 0;
      for (let i = 0; i < obj.childNodes.length; i += 1) {
        const n = obj.childNodes[i];
        const len = getLogicalNodeLength(n);
        const isSpan =
          n.nodeType === Node.ELEMENT_NODE &&
          (n as HTMLElement).tagName.toLowerCase() === 'span';
        if (isSpan) {
          if (remaining <= len) {
            fri = [spanIdx, remaining];
            break;
          }
          spanIdx += 1;
        } else if (remaining <= len && spanIdx < spans.length) {
          // Caret falls within an inter-span node (e.g. top-level <br> or text);
          // anchor it at the start of the next span.
          fri = [spanIdx, 0];
          break;
        }
        remaining -= len;
      }
      if (!fri) {
        const lastIdx = spans.length - 1;
        fri = [lastIdx, getLogicalNodeLength(spans[lastIdx])];
      }
    } else {
      // Legacy diff-based fallback (no global offset captured).
      const computed = findrangeindex(ctx, v, vp);
      fri = _.isNil(computed) ? null : (computed as [number, number]);
    }
    if (_.isNil(fri)) {
      currSelection.selectAllChildren(obj);
      currSelection.collapseToEnd();
    } else {
      setCaretPosition(
        ctx,
        obj.querySelectorAll('span')[fri[0]],
        0,
        fri[1],
        obj,
      );
    }
    // @ts-ignore
  } else if (document.selection) {
    // ie10 9 8 7 6 5
    // @ts-ignore
    ctx.formulaCache.functionRangeIndex.moveToElementText(obj); // range定位到obj
    // @ts-ignore
    ctx.formulaCache.functionRangeIndex.collapse(false); // 光标移至最后
    // @ts-ignore
    ctx.formulaCache.functionRangeIndex.select();
  }
}

function searchFunction(ctx: Context, searchtxt: string) {
  const { functionlist } = locale(ctx);

  // // 这里的逻辑在原项目上做了修改
  // if (_.isNil($editer)) {
  //   return;
  // }
  // const inputContent = $editer.innerText.toUpperCase();
  // const reg = /^=([a-zA-Z_]+)\(?/;
  // const match = inputContent.match(reg);
  // if (!match) {
  //   ctx.functionCandidates = [];
  //   return;
  // }

  // const searchtxt = match[1];

  const f: typeof functionlist = [];
  const s: typeof functionlist = [];
  const t: typeof functionlist = [];
  let result_i = 0;

  for (let i = 0; i < functionlist.length; i += 1) {
    const item = functionlist[i];
    const { n } = item;

    if (n === searchtxt) {
      f.unshift(item);
      result_i += 1;
    } else if (_.startsWith(n, searchtxt)) {
      s.unshift(item);
      result_i += 1;
    } else if (n.indexOf(searchtxt) > -1) {
      t.unshift(item);
      result_i += 1;
    }

    if (result_i >= 10) {
      break;
    }
  }

  const list = [...f, ...s, ...t];
  if (list.length <= 0) {
    return;
  }

  ctx.functionCandidates = list;

  // const listHTML = _this.searchFunctionHTML(list);
  // $("#luckysheet-formula-search-c").html(listHTML).show();
  // $("#luckysheet-formula-help-c").hide();

  // const $c = $editer.parent();
  // const offset = $c.offset();
  // _this.searchFunctionPosition(
  //   $("#luckysheet-formula-search-c"),
  //   $c,
  //   offset.left,
  //   offset.top
  // );
}

export function getrangeseleciton() {
  const currSelection = window.getSelection();
  if (!currSelection) return null;
  const { anchorNode, anchorOffset } = currSelection;

  if (!anchorNode) return null;

  if (
    anchorNode.parentNode?.nodeName?.toLowerCase() === 'span' &&
    anchorOffset !== 0
  ) {
    let txt = _.trim(anchorNode.textContent || '');
    if (txt.length === 0 && anchorNode.parentNode.previousSibling) {
      const ahr = anchorNode.parentNode.previousSibling;
      txt = _.trim(ahr.textContent || '');
      return ahr;
    }
    return anchorNode.parentNode;
  }
  const anchorElement = anchorNode as HTMLElement;
  if (
    anchorElement.id === 'luckysheet-rich-text-editor' ||
    anchorElement.id === 'luckysheet-functionbox-cell'
  ) {
    let txt = _.trim(_.last(anchorElement.querySelectorAll('span'))?.innerText);

    if (txt.length === 0 && anchorElement.querySelectorAll('span').length > 1) {
      const ahr = anchorElement.querySelectorAll('span');
      txt = _.trim(ahr[ahr.length - 2].innerText);
      return ahr?.[0];
    }
    return _.last(anchorElement.querySelectorAll('span'));
  }
  if (
    anchorNode?.parentElement?.id === 'luckysheet-rich-text-editor' ||
    anchorNode?.parentElement?.id === 'luckysheet-functionbox-cell' ||
    anchorOffset === 0
  ) {
    const newAnchorNode =
      anchorOffset === 0 ? anchorNode?.parentNode : anchorNode;

    if (newAnchorNode?.previousSibling) {
      return newAnchorNode?.previousSibling;
    }
  }

  return null;
}

function helpFunctionExe(
  $editer: HTMLDivElement,
  currSelection: Node,
  ctx: Context,
) {
  const { functionlist } = locale(ctx);
  // let _locale = locale();
  // let locale_formulaMore = _locale.formulaMore;
  // if ($("#luckysheet-formula-help-c").length === 0) {
  //   $("body").after(
  //     replaceHtml(_this.helpHTML, {
  //       helpClose: locale_formulaMore.helpClose,
  //       helpCollapse: locale_formulaMore.helpCollapse,
  //       helpExample: locale_formulaMore.helpExample,
  //       helpAbstract: locale_formulaMore.helpAbstract,
  //     })
  //   );
  //   $("#luckysheet-formula-help-c .luckysheet-formula-help-close").click(
  //     function () {
  //       $("#luckysheet-formula-help-c").hide();
  //     }
  //   );
  //   $("#luckysheet-formula-help-c .luckysheet-formula-help-collapse").click(
  //     function () {
  //       let $content = $(
  //         "#luckysheet-formula-help-c .luckysheet-formula-help-content"
  //       );
  //       $content.slideToggle(100, function () {
  //         let $c = _this.rangeResizeTo.parent(),
  //           offset = $c.offset();
  //         _this.searchFunctionPosition(
  //           $("#luckysheet-formula-help-c"),
  //           $c,
  //           offset.left,
  //           offset.top,
  //           true
  //         );
  //       });

  //       if ($content.is(":hidden")) {
  //         $(this).html('<i class="fa fa-angle-up" aria-hidden="true"></i>');
  //       } else {
  //         $(this).html('<i class="fa fa-angle-down" aria-hidden="true"></i>');
  //       }
  //     }
  //   );

  //   for (let i = 0; i < functionlist.length; i++) {
  //     functionlistPosition[functionlist[i].n] = i;
  //   }
  // }
  if (_.isEmpty(ctx.formulaCache.functionlistMap)) {
    for (let i = 0; i < functionlist.length; i += 1) {
      ctx.formulaCache.functionlistMap[functionlist[i].n] = functionlist[i];
    }
  }
  if (!currSelection) {
    return null;
  }

  const $prev = currSelection;
  const $span = Array.from($editer.querySelectorAll('span'));
  const selectionSpan =
    currSelection.nodeType === Node.ELEMENT_NODE
      ? (currSelection as Element).closest('span')
      : currSelection.parentElement?.closest('span');
  const currentIndex = selectionSpan ? $span.indexOf(selectionSpan) : -1;
  let i = currentIndex;

  if ($prev == null || currentIndex < 0 || !$span[currentIndex]) {
    return null;
  }

  let funcName = null;
  let paramindex = null;

  if ($span[i]?.classList?.contains('luckysheet-formula-text-func')) {
    funcName = $span[i].textContent;
  } else {
    let $cur = null;
    let exceptIndex = [-1, -1];

    while (--i > 0) {
      $cur = $span[i];

      if (
        $cur?.classList?.contains('luckysheet-formula-text-func') ||
        _.trim($cur.textContent || '').toUpperCase() in
        ctx.formulaCache.functionlistMap
      ) {
        funcName = $cur.textContent;
        paramindex = null;
        let endstate = true;

        for (let a = i; a <= currentIndex; a += 1) {
          if (!paramindex) {
            paramindex = 0;
          }

          if (a >= exceptIndex[0] && a <= exceptIndex[1]) {
            continue;
          }

          $cur = $span[a];
          if ($cur?.classList?.contains('luckysheet-formula-text-rpar')) {
            exceptIndex = [i, a];
            funcName = null;
            endstate = false;
            break;
          }

          if ($cur?.classList?.contains('luckysheet-formula-text-comma')) {
            paramindex += 1;
          }
        }

        if (endstate) {
          break;
        }
      }
    }
  }

  return funcName;
}

export function rangeHightlightselected(ctx: Context, $editor: HTMLDivElement) {
  const currSelection = getrangeseleciton();
  // $("#luckysheet-formula-search-c, #luckysheet-formula-help-c").hide();
  // $(
  //   "#fortune-formula-functionrange .fortune-formula-functionrange-highlight .fortune-selection-copy-hc"
  // ).css("opacity", "0.03");
  // $("#luckysheet-formula-search-c, #luckysheet-formula-help-c").hide();

  // if (
  //   $(currSelection).closest(".fortune-formula-functionrange-cell").length ==
  //   0
  // ) {
  if (!currSelection) return;

  const currText = _.trim(
    (currSelection.textContent || '').replace(/\u200b/g, ''),
  );

  if (currText === '=') {
    const { functionlist } = locale(ctx);
    ctx.defaultCandidates = (functionlist as any[])
      .filter((d: any) => d.t === 20)
      .slice(0, 11);
    const funcName = helpFunctionExe($editor, currSelection, ctx);
    ctx.functionHint = funcName?.toUpperCase();
    return;
  }
  if (currText?.match(/^[a-zA-Z_]+$/)) {
    ctx.defaultCandidates = [];
    searchFunction(ctx, currText.toUpperCase());
    ctx.functionHint = null;
  } else {
    const funcName = helpFunctionExe($editor, currSelection, ctx);
    ctx.functionHint = funcName?.toUpperCase();
    ctx.functionCandidates = [];
    ctx.defaultCandidates = [];
  }
  // return;
  // }

  // const $anchorOffset = $(currSelection).closest(
  //   ".fortune-formula-functionrange-cell"
  // );
  // const rangeindex = $anchorOffset.attr("rangeindex");
  // const rangeid = `fortune-formula-functionrange-highlight-${rangeindex}`;

  // $(`#${rangeid}`).find(".fortune-selection-copy-hc").css({
  //   opacity: "0.13",
  // });
}

function functionHTML(txt: string) {
  if (txt.substr(0, 1) === '=') {
    txt = txt.substr(1);
  }

  const funcstack = txt.split('');
  let i = 0;
  let str = '';
  let function_str = '';
  const matchConfig = {
    bracket: 0,
    comma: 0,
    squote: 0,
    dquote: 0,
    braces: 0,
  };

  const appendStrTail = (acc: string, dquote: number) => {
    if (acc.length === 0) {
      return;
    }
    // Keep whitespace (including \n which becomes <br>) OUTSIDE the wrapping
    // span. Otherwise <br> ends up inside a span as its first child, and
    // setCaretPosition's br-handling places the caret one char into the
    // following text (e.g. between "F" and "3" of F3:I3, or before "P" on a
    // new line). Strings (dquote) preserve content as-is.
    let leadingWS = '';
    let trailingWS = '';
    if (dquote === 0) {
      leadingWS = acc.match(/^\s+/)?.[0] || '';
      trailingWS = acc.match(/\s+$/)?.[0] || '';
      acc = acc.slice(leadingWS.length, acc.length - trailingWS.length);
      if (acc.length === 0) {
        // The whole tail was only whitespace (often a lone `\n` from the
        // contenteditable tree). Do not emit it: `functionHTMLGenerate` turns
        // `\n` into `<br>`, which looks like typing `,` inserted a new line.
        return;
      }
      function_str += leadingWS;
    }
    if (iscelldata(_.trim(acc))) {
      const rangeIndex =
        rangeIndexes.length > functionHTMLIndex
          ? rangeIndexes[functionHTMLIndex]
          : functionHTMLIndex;
      function_str += `<span class="fortune-formula-functionrange-cell" rangeindex="${rangeIndex}" dir="auto" style="color:${colors[rangeIndex]};">${acc}</span>`;
      functionHTMLIndex += 1;
    } else if (dquote > 0) {
      function_str += `${acc}</span>`;
    } else if (acc.indexOf('</span>') === -1 && acc.length > 0) {
      const regx = /{.*?}/;

      if (regx.test(_.trim(acc))) {
        const arraytxt = regx.exec(acc)![0];
        const arraystart = acc.search(regx);
        let alltxt = '';

        if (arraystart > 0) {
          alltxt += `<span dir="auto" class="luckysheet-formula-text-color">${acc.substr(
            0,
            arraystart,
          )}</span>`;
        }

        alltxt += `<span dir="auto" style="color:#959a05" class="luckysheet-formula-text-array">${arraytxt}</span>`;

        if (arraystart + arraytxt.length < acc.length) {
          alltxt += `<span dir="auto" class="luckysheet-formula-text-color">${acc.substr(
            arraystart + arraytxt.length,
            acc.length,
          )}</span>`;
        }

        function_str += alltxt;
      } else {
        function_str += `<span dir="auto" class="luckysheet-formula-text-color">${acc}</span>`;
      }
    }
    if (trailingWS) function_str += trailingWS;
  };

  while (i < funcstack.length) {
    const s = funcstack[i];

    if (
      s === '(' &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0 &&
      matchConfig.braces === 0
    ) {
      matchConfig.bracket += 1;

      if (str.length > 0) {
        function_str += `<span dir="auto" class="luckysheet-formula-text-func">${str}</span><span dir="auto" class="luckysheet-formula-text-lpar">(</span>`;
      } else {
        function_str +=
          '<span dir="auto" class="luckysheet-formula-text-lpar">(</span>';
      }

      str = '';
    } else if (
      s === ')' &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0 &&
      matchConfig.braces === 0
    ) {
      matchConfig.bracket -= 1;
      function_str += `${functionHTML(
        str,
      )}<span dir="auto" class="luckysheet-formula-text-rpar">)</span>`;
      str = '';
    } else if (
      s === '{' &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0
    ) {
      str += '{';
      matchConfig.braces += 1;
    } else if (
      s === '}' &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0
    ) {
      str += '}';
      matchConfig.braces -= 1;
    } else if (s === '"' && matchConfig.squote === 0) {
      if (matchConfig.dquote > 0) {
        if (str.length > 0) {
          function_str += `${str}"</span>`;
        } else {
          function_str += '"</span>';
        }

        matchConfig.dquote -= 1;
        str = '';
      } else {
        matchConfig.dquote += 1;

        if (str.length > 0) {
          function_str += `${functionHTML(
            str,
          )}<span dir="auto" class="luckysheet-formula-text-string">"`;
        } else {
          function_str +=
            '<span dir="auto" class="luckysheet-formula-text-string">"';
        }

        str = '';
      }
    }
    // 修正例如输入公式='1-2'!A1时，只有2'!A1是fortune-formula-functionrange-cell色，'1-是黑色的问题。
    else if (s === "'" && matchConfig.dquote === 0) {
      str += "'";
      matchConfig.squote = matchConfig.squote === 0 ? 1 : 0;
    } else if (
      s === ',' &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0 &&
      matchConfig.braces === 0
    ) {
      // matchConfig.comma += 1;
      function_str += `${functionHTML(
        str,
      )}<span dir="auto" class="luckysheet-formula-text-comma">,</span>`;
      str = '';
    } else if (
      s === '&' &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0 &&
      matchConfig.braces === 0
    ) {
      if (str.length > 0) {
        function_str +=
          `${functionHTML(
            str,
          )}<span dir="auto" class="luckysheet-formula-text-calc">` +
          `&` +
          `</span>`;
        str = '';
      } else {
        function_str +=
          '<span dir="auto" class="luckysheet-formula-text-calc">' +
          '&' +
          '</span>';
      }
    } else if (
      s in operatorjson &&
      matchConfig.squote === 0 &&
      matchConfig.dquote === 0 &&
      matchConfig.braces === 0
    ) {
      let s_next = '';
      if (i + 1 < funcstack.length) {
        s_next = funcstack[i + 1];
      }

      let p = i - 1;
      let s_pre = null;
      if (p >= 0) {
        do {
          s_pre = funcstack[p];
          p -= 1;
        } while (p >= 0 && s_pre === ' ');
      }

      if (s + s_next in operatorjson) {
        if (str.length > 0) {
          function_str += `${functionHTML(
            str,
          )}<span dir="auto" class="luckysheet-formula-text-calc">${s}${s_next}</span>`;
          str = '';
        } else {
          function_str += `<span dir="auto" class="luckysheet-formula-text-calc">${s}${s_next}</span>`;
        }

        i += 1;
      } else if (
        !/[^0-9]/.test(s_next) &&
        s === '-' &&
        (s_pre === '(' ||
          _.isNil(s_pre) ||
          s_pre === ',' ||
          s_pre === ' ' ||
          s_pre in operatorjson)
      ) {
        str += s;
      } else {
        if (str.length > 0) {
          function_str += `${functionHTML(
            str,
          )}<span dir="auto" class="luckysheet-formula-text-calc">${s}</span>`;
          str = '';
        } else {
          function_str += `<span dir="auto" class="luckysheet-formula-text-calc">${s}</span>`;
        }
      }
    } else {
      str += s;
    }

    if (i === funcstack.length - 1) {
      appendStrTail(str, matchConfig.dquote);
    }

    i += 1;
  }

  return function_str;
}

export function functionHTMLGenerate(txt: string) {
  if (txt.length === 0 || txt.substring(0, 1) !== '=') {
    return txt;
  }

  // Normalize newlines so functionHTML sees \n; mirror storage may use \r\n.
  txt = txt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  functionHTMLIndex = 0;

  const inner = functionHTML(txt);
  let html = `<span dir="auto" class="luckysheet-formula-text-color">=</span>${inner}`;
  if (html.includes('\n')) {
    html = html.replace(/\n/g, '<br>');
  }
  return html;
}

function getRangeIndexes($editor: HTMLDivElement) {
  const res: number[] = [];
  $editor
    .querySelectorAll('span.fortune-formula-functionrange-cell')
    .forEach((ele) => {
      const indexStr = ele.getAttribute('rangeindex');
      if (indexStr) {
        const rangeIndex = parseInt(indexStr, 10);
        res.push(rangeIndex);
      }
    });
  return res;
}

// Compute the caret's global logical character offset within the formula editor,
// counting `<br>` as 1 char. Resilient to span re-splits between pre/post-render.
function getEditorGlobalCaretOffset(
  editor: HTMLDivElement,
  selection: globalThis.Selection,
): number | null {
  if (!selection.anchorNode || selection.rangeCount === 0) return null;
  if (!editor.contains(selection.anchorNode)) return null;

  let offset = 0;
  let found = false;
  const visit = (node: Node): boolean => {
    if (node === selection.anchorNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += selection.anchorOffset;
      } else {
        const childIdx = Math.min(
          selection.anchorOffset,
          node.childNodes.length,
        );
        for (let i = 0; i < childIdx; i += 1) {
          offset += getLogicalNodeLength(node.childNodes[i]);
        }
      }
      found = true;
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.nodeValue?.length || 0;
      return false;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.tagName.toLowerCase() === 'br') {
        offset += 1;
        return false;
      }
      for (let i = 0; i < el.childNodes.length; i += 1) {
        if (visit(el.childNodes[i])) return true;
      }
    }
    return false;
  };
  visit(editor);
  return found ? offset : null;
}

export function getLastFormulaRangeIndex(
  $editor: HTMLDivElement,
): number | null {
  const spans = Array.from($editor.querySelectorAll('span')).filter(
    (span) => span.textContent?.trim().length,
  ) as HTMLSpanElement[];

  const lastSpan = spans[spans.length - 1];
  if (!lastSpan) return null;
  if (!lastSpan.classList.contains('fortune-formula-functionrange-cell')) {
    return null;
  }

  const indexStr = lastSpan.getAttribute('rangeindex');
  if (!indexStr) return null;

  const rangeIndex = parseInt(indexStr, 10);
  return Number.isNaN(rangeIndex) ? null : rangeIndex;
}

/** Range cell that contains the caret, if any (inside #luckysheet-rich-text-editor tree). */
export function getFormulaRangeIndexAtCaret(
  $editor: HTMLDivElement,
): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const { anchorNode } = sel;
  if (!anchorNode) return null;
  const el =
    anchorNode.nodeType === Node.ELEMENT_NODE
      ? (anchorNode as Element)
      : anchorNode.parentElement;
  if (!el) return null;
  const cell = el.closest('.fortune-formula-functionrange-cell');
  if (!cell || !$editor.contains(cell)) return null;
  const ri = cell.getAttribute('rangeindex');
  if (!ri) return null;
  const n = parseInt(ri, 10);
  return Number.isNaN(n) ? null : n;
}

export function setFormulaEditorOwner(
  ctx: Context,
  owner: 'cell' | 'fx' | null,
) {
  ctx.formulaCache.formulaEditorOwner = owner;
}

export function getFormulaEditorOwner(ctx: Context): 'cell' | 'fx' | null {
  const cachedOwner = ctx.formulaCache.formulaEditorOwner;
  if (cachedOwner === 'cell' || cachedOwner === 'fx') {
    return cachedOwner;
  }

  if (document.activeElement?.id === 'luckysheet-functionbox-cell') {
    return 'fx';
  }

  if (document.activeElement?.id === 'luckysheet-rich-text-editor') {
    return 'cell';
  }

  return null;
}

/**
 * Record the sheet where the formula edit started so cross-sheet picks can emit
 * `SheetName!A1` via `rangeSetValue` / `getRangetxt`.
 */
export function ensureFormulaRangeToSheet(ctx: Context) {
  if (!ctx.formulaCache.rangetosheet) {
    ctx.formulaCache.rangetosheet = ctx.currentSheetId;
  }
}

/** True while an in-cell / fx formula edit should survive sheet-tab switches. */
export function shouldPreserveFormulaEditOnSheetSwitch(ctx: Context): boolean {
  if (ctx.luckysheetCellUpdate.length === 0) return false;
  if (ctx.formulaCache.rangetosheet) return true;
  const editor = getActiveFormulaEditorElement(ctx);
  return (editor?.innerText || '').trim().startsWith('=');
}

function saveCurrentSheetViewState(ctx: Context) {
  ctx.sheetScrollRecord[ctx.currentSheetId] = {
    scrollLeft: ctx.scrollLeft,
    scrollTop: ctx.scrollTop,
    luckysheet_select_status: ctx.luckysheet_select_status,
    luckysheet_select_save: ctx.luckysheet_select_save,
    luckysheet_selection_range: ctx.luckysheet_selection_range,
  };
}

function clearFormulaPickStateOnSheetSwitch(ctx: Context) {
  ctx.formulaCache.formulaKeyboardRefSync = false;
  ctx.formulaCache.func_selectedrange = undefined;
  ctx.formulaCache.rangestart = false;
  ctx.formulaCache.rangedrag_column_start = false;
  ctx.formulaCache.rangedrag_row_start = false;
  ctx.formulaCache.rangechangeindex = undefined;
  ctx.formulaRangeSelect = undefined;
  ctx.formulaCache.refocusFormulaEditorAfterSheetSwitch = true;
}

/**
 * Activate another sheet from tab click or Alt/Option+Arrow navigation.
 * Returns whether the sheet changed and whether formula edit was preserved.
 */
export function activateSheetForNavigation(
  ctx: Context,
  targetSheetId: string,
): 'preserved-formula' | 'cancel-edit' | false {
  if (!targetSheetId || targetSheetId === ctx.currentSheetId) return false;

  const preserveFormula = shouldPreserveFormulaEditOnSheetSwitch(ctx);
  if (preserveFormula) {
    // Capture origin sheet before `currentSheetId` changes.
    ensureFormulaRangeToSheet(ctx);
  }

  saveCurrentSheetViewState(ctx);
  ctx.dataVerificationDropDownList = false;

  const targetIdx = getSheetIndex(ctx, targetSheetId);
  const targetFile = targetIdx != null ? ctx.luckysheetfile[targetIdx] : undefined;

  changeSheet(ctx, targetSheetId);

  if (targetFile?.zoomRatio != null) {
    ctx.zoomRatio = targetFile.zoomRatio || 1;
  }

  if (preserveFormula) {
    clearFormulaPickStateOnSheetSwitch(ctx);
    return 'preserved-formula';
  }
  return 'cancel-edit';
}

/**
 * Switch back to the formula's origin sheet (and restore its scroll/selection)
 * before commit or cancel. Returns true when a switch happened.
 */
export function returnToFormulaOriginSheet(ctx: Context): boolean {
  const origin = ctx.formulaCache.rangetosheet;
  if (!origin || origin === ctx.currentSheetId) return false;

  ctx.sheetScrollRecord[ctx.currentSheetId] = {
    scrollLeft: ctx.scrollLeft,
    scrollTop: ctx.scrollTop,
    luckysheet_select_status: ctx.luckysheet_select_status,
    luckysheet_select_save: ctx.luckysheet_select_save,
    luckysheet_selection_range: ctx.luckysheet_selection_range,
  };

  changeSheet(ctx, origin);

  // Ensure origin is dense before commit paths read/write flowdata.
  ensureSheetFlowdata(ctx, { id: origin });

  const saved = ctx.sheetScrollRecord[origin];
  if (saved) {
    ctx.scrollLeft = saved.scrollLeft ?? 0;
    ctx.scrollTop = saved.scrollTop ?? 0;
    ctx.luckysheet_select_status = saved.luckysheet_select_status ?? false;
    if (saved.luckysheet_select_save) {
      ctx.luckysheet_select_save = saved.luckysheet_select_save;
    }
  }

  const file = ctx.luckysheetfile[getSheetIndex(ctx, origin)!];
  if (file?.zoomRatio != null) {
    ctx.zoomRatio = file.zoomRatio || 1;
  }

  return true;
}

function getActiveFormulaEditorElement(ctx: Context): HTMLDivElement | null {
  const cellEditor = document.getElementById(
    'luckysheet-rich-text-editor',
  ) as HTMLDivElement | null;
  const fxEditor = document.getElementById(
    'luckysheet-functionbox-cell',
  ) as HTMLDivElement | null;
  const owner = getFormulaEditorOwner(ctx);

  if (owner === 'fx') return fxEditor ?? cellEditor;
  if (owner === 'cell') return cellEditor ?? fxEditor;

  const activeId = document.activeElement?.id;
  if (activeId === 'luckysheet-functionbox-cell') return fxEditor ?? cellEditor;
  if (activeId === 'luckysheet-rich-text-editor') return cellEditor ?? fxEditor;

  return cellEditor ?? fxEditor;
}

function getCurrentFormulaSlotTextBeforeCaret(
  editor: HTMLElement,
  caretOffset: number,
) {
  // Use textContent (no `\n` for <br>) to match `caretOffset` which is computed
  // from `Range.toString().length`. innerText injects `\n` per <br> and would
  // shift indices in multi-line formulas. Also strip `\u200b` (caret-render
  // helper on empty multi-line rows) so it doesn't pollute slot detection.
  const textBefore = normalizeFormulaBoundaryText(
    editor.textContent || '',
  ).slice(0, caretOffset);
  const parts = textBefore.split(/[=,(+\-*/&<>]/);
  return _.trim(parts[parts.length - 1] || '');
}

/**
 * True when the formula text looks like a truncated A1-style range: LHS has a row
 * number but RHS after ":" is only column letters (e.g. =A1:A after deleting the
 * row digit from A2). Those states should not allow range recovery / keyboard ref nav.
 */
export function hasIncompleteTruncatedCellRangeSyntax(
  formulaText: string,
): boolean {
  const t = formulaText.replace(/\s/g, '');
  if (!t.startsWith('=')) return false;
  if (/[A-Za-z]+\d+:[A-Za-z]+$/i.test(t)) return true;
  if (/[A-Za-z]+\d+:\s*$/i.test(t)) return true;
  return false;
}

function isIncompleteTruncatedRangeToken(token: string): boolean {
  const t = token.replace(/\s/g, '');
  if (!t) return false;
  // Covers A1:A and A1:
  if (/[A-Za-z]+\d+:[A-Za-z]*$/i.test(t)) {
    return !/[A-Za-z]+\d+:[A-Za-z]+\d+$/i.test(t);
  }
  return false;
}

function isCaretInsideIncompleteTruncatedRangeSyntax(
  editor: HTMLElement,
  caretOffset: number,
): boolean {
  // textContent matches `caretOffset` space (Range.toString length, no <br>=>\n).
  // Strip `\u200b` so the empty-line caret-render helper doesn't shift indices.
  const tc = normalizeFormulaBoundaryText(editor.textContent || '');
  const textBefore = tc.slice(0, caretOffset);
  const textAfter = tc.slice(caretOffset);
  const tokenSplit = /[=,()+\-*/&<>%^]/;
  const leftToken = (textBefore.split(tokenSplit).pop() || '').trim();
  const rightToken = (textAfter.split(tokenSplit)[0] || '').trim();
  const tokenAtCaret = `${leftToken}${rightToken}`;
  return isIncompleteTruncatedRangeToken(tokenAtCaret);
}

/**
 * True when the formula is only "=" plus a single cell or range token (no parentheses,
 * so no function call). Same UX as =A1: do not use arrow keys to drive sheet refs until
 * the user changes the formula shape (e.g. adds a function).
 */
export function isBareCellOrRangeOnlyFormula(formulaText: string): boolean {
  const t = formulaText.trim();
  if (!t.startsWith('=')) return false;
  const body = t.slice(1).trim();
  if (!body) return false;
  if (body.includes('(') || body.includes(')')) return false;
  return iscelldata(body);
}

/**
 * When opening in-cell / FX edit on a cell that already stores a formula (`cell.f`),
 * disable sheet-driven range selection until the caret reaches a fresh insertion slot
 * (comma, open paren, operator, etc.) or the user starts an active range drag.
 */
export function suppressFormulaRangeSelectionForInitialEdit(ctx: Context) {
  ctx.formulaCache.rangeSelectionActive = false;
  ctx.formulaCache.keyboardRangeSelectionLock = true;
  ctx.formulaCache.rangestart = false;
  ctx.formulaCache.rangedrag_column_start = false;
  ctx.formulaCache.rangedrag_row_start = false;
}

export function isCaretAtValidFormulaRangeInsertionPoint(
  editor: HTMLElement | null,
): boolean {
  const currSelection = window.getSelection();
  if (!editor || !currSelection || currSelection.rangeCount === 0) {
    return false;
  }

  const { anchorNode } = currSelection;
  if (anchorNode && !editor.contains(anchorNode)) {
    return false;
  }

  const inputText = normalizeFormulaBoundaryText(editor.innerText).trim();
  if (!inputText.startsWith('=')) {
    return false;
  }

  if (/^=\s*[A-Za-z_][A-Za-z0-9_]*$/.test(inputText)) {
    return false;
  }

  if (isBareCellOrRangeOnlyFormula(inputText)) {
    return false;
  }

  const caretRange = currSelection.getRangeAt(0).cloneRange();
  const preCaretRange = document.createRange();
  preCaretRange.selectNodeContents(editor);
  preCaretRange.setEnd(caretRange.endContainer, caretRange.endOffset);
  // Normalize so `\u200b` (empty-line caret-render helper) is not counted as
  // a real character; keeps `caretOffset` aligned with the normalized text
  // used for slicing below.
  const caretOffset = normalizeFormulaBoundaryText(
    preCaretRange.toString(),
  ).length;
  // Use textContent (matches `caretOffset` from Range.toString().length).
  // innerText would shift these indices by 1 per <br> in multi-line formulas.
  const fullText = normalizeFormulaBoundaryText(editor.textContent || '');

  // `)` closes a group/call — never a ref insertion point, whether at EOF or
  // mid-formula (e.g. `=SUM(A1)|+B1`). Previously only the EOF branch checked
  // this; the mid-formula path only inspected the char *after* the caret.
  if (getSignificantCharBeforeCaret(fullText, caretOffset) === ')') {
    return false;
  }

  const slotTextBeforeCaret = getCurrentFormulaSlotTextBeforeCaret(
    editor,
    caretOffset,
  );

  // Block only when caret is within the broken token itself (e.g. `=A2:A|`),
  // not when formula contains another incomplete token elsewhere (e.g.
  // `=SUM(|,B1:B)` where `|` is caret).
  if (isCaretInsideIncompleteTruncatedRangeSyntax(editor, caretOffset)) {
    return false;
  }

  if (slotTextBeforeCaret.length > 0 && !iscelldata(slotTextBeforeCaret)) {
    return false;
  }

  const textAfter = fullText.slice(caretOffset);
  const remaining = textAfter.replace(/^\s+/, '');
  if (remaining.length === 0) {
    const atCaret = getFormulaRangeIndexAtCaret(editor as HTMLDivElement);
    if (atCaret !== null) {
      return true;
    }
    const lastCh = getSignificantCharBeforeCaret(fullText, caretOffset);
    if (!lastCh) {
      return false;
    }
    // At end-of-formula: only after `=`, `,`, `(`, or an infix operator is it valid to start
    // or extend refs via keyboard/mouse — same idea as blocking bare `=A1` / `=A1:A2`.
    // (`)` already rejected above.)
    if (/^[=,(+\-*/&%^<>]$/.test(lastCh)) {
      return true;
    }
    return false;
  }

  const first = remaining[0];
  const result =
    first === ',' || first === ')' || first === '&' || first in operatorjson;
  return result;
}

function hasCommaOrAnotherRefAfterRangeCell(cell: HTMLElement): boolean {
  let n: Node | null = cell.nextSibling;
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const e = n as HTMLElement;
      if (e.classList?.contains('luckysheet-formula-text-comma')) return true;
      if (e.classList?.contains('fortune-formula-functionrange-cell'))
        return true;
    }
    n = n.nextSibling;
  }
  return false;
}

export function markRangeSelectionDirty(ctx: Context) {
  ctx.formulaCache.rangeSelectionActive = false;

  // Clear formula-range UI/state immediately when the inserted range token
  // was manually edited, so stale blue overlays don't linger.
  ctx.formulaRangeHighlight = [];
  ctx.formulaRangeSelect = undefined;
  ctx.formulaCache.selectingRangeIndex = -1;
  ctx.formulaCache.func_selectedrange = undefined;
  ctx.formulaCache.rangestart = false;
  ctx.formulaCache.rangedrag_column_start = false;
  ctx.formulaCache.rangedrag_row_start = false;
  ctx.formulaCache.rangechangeindex = undefined;
}

/**
 * Which `rangeindex` keyboard selection sync should update: caret's cell if any;
 * else the last range cell when the caret is editing that ref — not when the caret
 * is before it (`=,A4` between `=` and `,`) or **past** it into a following comma /
 * next argument (`=SUM(A1,` after the comma must not replace `A1`).
 */
export function getFormulaRangeIndexForKeyboardSync(
  $editor: HTMLDivElement,
): number | null {
  const atCaret = getFormulaRangeIndexAtCaret($editor);
  if (atCaret !== null) return atCaret;

  const lastIdx = getLastFormulaRangeIndex($editor);
  if (lastIdx === null) return null;

  const cell = $editor.querySelector(
    `span.fortune-formula-functionrange-cell[rangeindex="${lastIdx}"]`,
  ) as HTMLElement | null;
  if (!cell) return null;

  const sel = window.getSelection();
  // Focus often leaves the formula editor after a sheet-tab switch. Without a
  // caret inside the editor, still update the sole/last managed ref (needed for
  // bare `=Sheet2!A1` continued keyboard nav).
  if (!sel?.anchorNode || !$editor.contains(sel.anchorNode)) {
    return lastIdx;
  }

  const caretRange = document.createRange();
  try {
    caretRange.setStart(sel.anchorNode, sel.anchorOffset);
    caretRange.collapse(true);
  } catch {
    return lastIdx;
  }

  const cellRange = document.createRange();
  try {
    cellRange.selectNodeContents(cell);
  } catch {
    return lastIdx;
  }

  try {
    if (caretRange.compareBoundaryPoints(Range.START_TO_START, cellRange) < 0) {
      return null;
    }
  } catch {
    return lastIdx;
  }

  const afterCell = document.createRange();
  try {
    afterCell.setStartAfter(cell);
    afterCell.collapse(true);
  } catch {
    return lastIdx;
  }

  try {
    if (caretRange.compareBoundaryPoints(Range.START_TO_START, afterCell) >= 0) {
      if (hasCommaOrAnotherRefAfterRangeCell(cell)) {
        return null;
      }
      return lastIdx;
    }
  } catch {
    return lastIdx;
  }

  return lastIdx;
}

export function handleFormulaInput(
  ctx: Context,
  $copyTo: HTMLDivElement | null | undefined,
  $editor: HTMLDivElement,
  kcode: number,
  preText?: string,
  refreshRangeSelect = true,
) {
  if (!$editor) return;
  try {
    if (ctx.formulaCache.keyboardRangeSelectionLock === true) {
      ctx.formulaCache.keyboardRangeSelectionLock = false;
    }

    const isBackspaceOrDelete = kcode === 8 || kcode === 46;
    const isAlphaNumeric =
      (kcode >= 48 && kcode <= 57) || // 0-9
      (kcode >= 65 && kcode <= 90) || // A-Z
      (kcode >= 97 && kcode <= 122); // a-z

    // If a keyboard/mouse-inserted range token is currently being edited
    // and the user types characters (or backspace/delete), mark it as
    // manually modified so we can block further range navigation.
    if (ctx.formulaCache.rangeSelectionActive === true) {
      if (isBackspaceOrDelete || isAlphaNumeric) {
        markRangeSelectionDirty(ctx);
      }
    }

    // if (isEditMode()) {
    //   // 此模式下禁用公式栏
    //   return;
    // }
    let value1: string;
    const readEditorText = (root: HTMLElement): string => {
      const readNode = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) {
          return (node.nodeValue || '').replace(/\u200b/g, '');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const el = node as HTMLElement;
        if (el.tagName.toLowerCase() === 'br') return '\n';
        let out = '';
        el.childNodes.forEach((child) => {
          out += readNode(child);
        });
        return out;
      };
      let text = '';
      root.childNodes.forEach((node) => {
        text += readNode(node);
      });
      return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    };
    const value1txt = preText ?? readEditorText($editor);
    let value = readEditorText($editor);
    if (kcode === 8 || kcode === 46) {
      // contenteditable can materialize an extra trailing line-break placeholder
      // (<br><br>) when deleting the last visible char on the last line.
      value = value.replace(/\n{2,}$/, '\n');
    }
    value = escapeScriptTag(value);
    if (
      value.length > 0 &&
      value.substring(0, 1) === '=' &&
      (kcode !== 229 || value.length === 1)
    ) {
      ensureFormulaRangeToSheet(ctx);
      if (!refreshRangeSelect) rangeIndexes = getRangeIndexes($editor);
      value = functionHTMLGenerate(value);
      if (!refreshRangeSelect && functionHTMLIndex < rangeIndexes.length)
        refreshRangeSelect = true;
      value1 = functionHTMLGenerate(value1txt);

      rangeIndexes = [];

      if (window.getSelection) {
        // all browsers, except IE before version 9
        const currSelection = window.getSelection();
        if (!currSelection) return;
        if (currSelection.anchorNode?.nodeName.toLowerCase() === 'div') {
          const editorlen = $editor.querySelectorAll('span').length;
          if (editorlen > 0)
            ctx.formulaCache.functionRangeIndex = [
              editorlen - 1,
              $editor.querySelectorAll('span').item(editorlen - 1).textContent
                ?.length!,
            ];
        } else {
          ctx.formulaCache.functionRangeIndex = [
            _.indexOf(
              currSelection.anchorNode?.parentNode?.parentNode?.childNodes,
              // @ts-ignore
              currSelection.anchorNode?.parentNode,
            ),
            currSelection.anchorOffset,
          ];
        }
        // Robust to span re-splits across re-renders: track caret as a
        // global logical char offset, restored against post-render DOM.
        ctx.formulaCache.functionRangeGlobalOffset = getEditorGlobalCaretOffset(
          $editor,
          currSelection,
        );
      } else {
        // Internet Explorer before version 9
        // @ts-ignore
        const textRange = document.selection.createRange();
        ctx.formulaCache.functionRangeIndex = textRange;
        ctx.formulaCache.functionRangeGlobalOffset = null;
      }

      $editor.innerHTML = value;
      if ($copyTo) $copyTo.innerHTML = value;

      // the cursor will be set to the beginning of input box after set innerHTML,
      // restoring it to the correct position
      functionRange(ctx, $editor, value, value1);

      if (refreshRangeSelect) {
        cancelFunctionrangeSelected(ctx);

        // Always refresh range overlays from the current formula HTML. Skipping on
        // Delete left highlights empty after markRangeSelectionDirty() clears them.
        createRangeHightlight(ctx, value);

        ctx.formulaCache.rangestart = false;
        ctx.formulaCache.rangedrag_column_start = false;
        ctx.formulaCache.rangedrag_row_start = false;

        rangeHightlightselected(ctx, $editor);
      }
    } else if (_.startsWith(value1txt, '=') && !_.startsWith(value, '=')) {
      if ($copyTo) $copyTo.innerHTML = value;
      $editor.innerHTML = escapeHTMLTag(value);
    } else if (!_.startsWith(value1txt, '=')) {
      if (!$copyTo) return;
      if ($copyTo.id === 'luckysheet-rich-text-editor') {
        // if (!_.startsWith($copyTo.innerHTML, "<span") || true) {
        $copyTo.innerHTML = escapeHTMLTag(value);
        // }
      } else {
        $copyTo.innerHTML = escapeHTMLTag(value);
      }
    }
  } catch (_error) {
    // no-op
  }
}

function isfreezonFuc(txt: string) {
  const row = txt.replace(/[^0-9]/g, '');
  const col = txt.replace(/[^A-Za-z]/g, '');
  const row$ = txt.substr(txt.indexOf(row) - 1, 1);
  const col$ = txt.substr(txt.indexOf(col) - 1, 1);
  const ret = [false, false];

  if (row$ === '$') {
    ret[0] = true;
  }
  if (col$ === '$') {
    ret[1] = true;
  }

  return ret;
}

function cycleSingleA1RefLock(ref: string): string | null {
  const m = ref.match(
    /^((?:'(?:[^']|'')*'|[^!]+)!)?(\$?)([A-Za-z]+)(\$?)(\d+)$/,
  );
  if (!m) return null;
  const [, sheetPrefix = '', colAbsRaw, col, rowAbsRaw, row] = m;
  const colAbs = colAbsRaw === '$';
  const rowAbs = rowAbsRaw === '$';
  // Cycle order:
  // A1 -> $A$1 -> A$1 -> $A1 -> A1
  let nextColAbs = false;
  let nextRowAbs = false;
  if (!colAbs && !rowAbs) {
    nextColAbs = true;
    nextRowAbs = true;
  } else if (colAbs && rowAbs) {
    nextColAbs = false;
    nextRowAbs = true;
  } else if (!colAbs && rowAbs) {
    nextColAbs = true;
    nextRowAbs = false;
  } else {
    nextColAbs = false;
    nextRowAbs = false;
  }
  return `${sheetPrefix}${nextColAbs ? '$' : ''}${col.toUpperCase()}${nextRowAbs ? '$' : ''
    }${row}`;
}

function cycleReferenceLockToken(refText: string): string | null {
  const txt = refText.trim();
  if (txt.length === 0) return null;
  if (txt.includes(':')) {
    const [left, right, ...rest] = txt.split(':');
    if (rest.length > 0 || !left || !right) return null;
    const leftNext = cycleSingleA1RefLock(left);
    const rightNext = cycleSingleA1RefLock(right);
    if (!leftNext || !rightNext) return null;
    return `${leftNext}:${rightNext}`;
  }
  return cycleSingleA1RefLock(txt);
}

export function toggleFormulaAbsoluteReferenceAtCaret(
  ctx: Context,
  $copyTo: HTMLDivElement | null | undefined,
  $editor: HTMLDivElement | null | undefined,
): boolean {
  if (!$editor) return false;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return false;
  if (!$editor.contains(sel.anchorNode)) return false;

  const anchorEl =
    sel.anchorNode.nodeType === Node.ELEMENT_NODE
      ? (sel.anchorNode as HTMLElement)
      : sel.anchorNode.parentElement;
  if (!anchorEl) return false;

  const toRangeSpan = (n: Node | null | undefined): HTMLSpanElement | null => {
    if (!n || n.nodeType !== Node.ELEMENT_NODE) return null;
    const el = n as HTMLElement;
    return el.matches('span.fortune-formula-functionrange-cell')
      ? (el as HTMLSpanElement)
      : null;
  };

  let targetSpan = anchorEl.closest(
    'span.fortune-formula-functionrange-cell',
  ) as HTMLSpanElement | null;

  // Boundary caret support: if caret is between siblings at editor level,
  // resolve to adjacent range span (typically previous sibling).
  if (!targetSpan && sel.anchorNode === $editor) {
    const offset = Math.min(sel.anchorOffset, $editor.childNodes.length);
    const prev = offset > 0 ? $editor.childNodes[offset - 1] : null;
    const next =
      offset < $editor.childNodes.length ? $editor.childNodes[offset] : null;
    targetSpan = toRangeSpan(prev) || toRangeSpan(next);
  }

  // Another boundary form: text node directly under editor between spans.
  if (!targetSpan && sel.anchorNode.nodeType === Node.TEXT_NODE) {
    const tn = sel.anchorNode as Text;
    if (tn.parentElement === $editor) {
      targetSpan =
        toRangeSpan(tn.previousSibling) || toRangeSpan(tn.nextSibling);
    }
  }

  if (!targetSpan || !$editor.contains(targetSpan)) return false;

  const oldText = targetSpan.textContent || '';
  const cycled = cycleReferenceLockToken(oldText);
  if (!cycled || cycled === oldText) return false;

  const offsetInToken = cycled.length;

  targetSpan.textContent = cycled;
  setCaretPosition(ctx, targetSpan, 0, offsetInToken, $editor);
  handleFormulaInput(ctx, $copyTo, $editor, 115);
  return true;
}

function functionStrChange_range(
  txt: string,
  type: string,
  rc: 'row' | 'col',
  orient: string | null,
  stindex: number,
  step: number,
) {
  const val = txt.split('!');
  let rangetxt;
  let prefix = '';

  if (val.length > 1) {
    [, rangetxt] = val;
    prefix = `${val[0]}!`;
  } else {
    [rangetxt] = val;
  }

  let r1;
  let r2;
  let c1;
  let c2;
  let $row0;
  let $row1;
  let $col0;
  let $col1;

  if (rangetxt.indexOf(':') === -1) {
    r1 = parseInt(rangetxt.replace(/[^0-9]/g, ''), 10) - 1;
    r2 = r1;
    c1 = columnCharToIndex(rangetxt.replace(/[^A-Za-z]/g, ''));
    c2 = c1;

    const freezonFuc = isfreezonFuc(rangetxt);

    $row0 = freezonFuc[0] ? '$' : '';
    $row1 = $row0;
    $col0 = freezonFuc[1] ? '$' : '';
    $col1 = $col0;
  } else {
    rangetxt = rangetxt.split(':');

    r1 = parseInt(rangetxt[0].replace(/[^0-9]/g, ''), 10) - 1;
    r2 = parseInt(rangetxt[1].replace(/[^0-9]/g, ''), 10) - 1;
    if (r1 > r2) {
      return txt;
    }

    c1 = columnCharToIndex(rangetxt[0].replace(/[^A-Za-z]/g, ''));
    c2 = columnCharToIndex(rangetxt[1].replace(/[^A-Za-z]/g, ''));
    if (c1 > c2) {
      return txt;
    }

    const freezonFuc0 = isfreezonFuc(rangetxt[0]);
    $row0 = freezonFuc0[0] ? '$' : '';
    $col0 = freezonFuc0[1] ? '$' : '';

    const freezonFuc1 = isfreezonFuc(rangetxt[1]);
    $row1 = freezonFuc1[0] ? '$' : '';
    $col1 = freezonFuc1[1] ? '$' : '';
  }

  if (type === 'del') {
    if (rc === 'row') {
      if (r1 >= stindex && r2 <= stindex + step - 1) {
        return error.r;
      }

      if (r1 > stindex + step - 1) {
        r1 -= step;
      } else if (r1 >= stindex) {
        r1 = stindex;
      }

      if (r2 > stindex + step - 1) {
        r2 -= step;
      } else if (r2 >= stindex) {
        r2 = stindex - 1;
      }

      if (r1 < 0) {
        r1 = 0;
      }

      if (r2 < r1) {
        r2 = r1;
      }
    } else if (rc === 'col') {
      if (c1 >= stindex && c2 <= stindex + step - 1) {
        return error.r;
      }

      if (c1 > stindex + step - 1) {
        c1 -= step;
      } else if (c1 >= stindex) {
        c1 = stindex;
      }

      if (c2 > stindex + step - 1) {
        c2 -= step;
      } else if (c2 >= stindex) {
        c2 = stindex - 1;
      }

      if (c1 < 0) {
        c1 = 0;
      }

      if (c2 < c1) {
        c2 = c1;
      }
    }

    if (r1 === r2 && c1 === c2) {
      if (!Number.isNaN(r1) && !Number.isNaN(c1)) {
        return prefix + $col0 + indexToColumnChar(c1) + $row0 + (r1 + 1);
      }
      if (!Number.isNaN(r1)) {
        return prefix + $row0 + (r1 + 1);
      }
      if (!Number.isNaN(c1)) {
        return prefix + $col0 + indexToColumnChar(c1);
      }
      return txt;
    }
    if (Number.isNaN(c1) && Number.isNaN(c2)) {
      return `${prefix + $row0 + (r1 + 1)}:${$row1}${r2 + 1}`;
    }
    if (Number.isNaN(r1) && Number.isNaN(r2)) {
      return `${prefix + $col0 + indexToColumnChar(c1)
        }:${$col1}${indexToColumnChar(c2)}`;
    }
    return `${prefix + $col0 + indexToColumnChar(c1) + $row0 + (r1 + 1)
      }:${$col1}${indexToColumnChar(c2)}${$row1}${r2 + 1}`;
  }
  if (type === 'add') {
    if (rc === 'row') {
      if (orient === 'lefttop') {
        if (r1 >= stindex) {
          r1 += step;
        }

        if (r2 >= stindex) {
          r2 += step;
        }
      } else if (orient === 'rightbottom') {
        if (r1 > stindex) {
          r1 += step;
        }

        if (r2 > stindex) {
          r2 += step;
        }
      }
    } else if (rc === 'col') {
      if (orient === 'lefttop') {
        if (c1 >= stindex) {
          c1 += step;
        }

        if (c2 >= stindex) {
          c2 += step;
        }
      } else if (orient === 'rightbottom') {
        if (c1 > stindex) {
          c1 += step;
        }

        if (c2 > stindex) {
          c2 += step;
        }
      }
    }

    if (r1 === r2 && c1 === c2) {
      if (!Number.isNaN(r1) && !Number.isNaN(c1)) {
        return prefix + $col0 + indexToColumnChar(c1) + $row0 + (r1 + 1);
      }
      if (!Number.isNaN(r1)) {
        return prefix + $row0 + (r1 + 1);
      }
      if (!Number.isNaN(c1)) {
        return prefix + $col0 + indexToColumnChar(c1);
      }
      return txt;
    }
    if (Number.isNaN(c1) && Number.isNaN(c2)) {
      return `${prefix + $row0 + (r1 + 1)}:${$row1}${r2 + 1}`;
    }
    if (Number.isNaN(r1) && Number.isNaN(r2)) {
      return `${prefix + $col0 + indexToColumnChar(c1)
        }:${$col1}${indexToColumnChar(c2)}`;
    }
    return `${prefix + $col0 + indexToColumnChar(c1) + $row0 + (r1 + 1)
      }:${$col1}${indexToColumnChar(c2)}${$row1}${r2 + 1}`;
  }
  return '';
}

/**
 * Sets `formulaCache.rangeSetValueTo` to the DOM node after which `rangeSetValue`
 * should insert the next ref (`insertBefore(newEle, ref.nextSibling)`).
 * Used when delimiter heuristics fail but keyboard range flow is active.
 */
function setRangeSetValueToFromCaretPosition(
  ctx: Context,
  editor: HTMLElement,
  sel: globalThis.Selection,
): boolean {
  if (sel.rangeCount === 0 || !sel.anchorNode) return false;
  if (!editor.contains(sel.anchorNode)) return false;

  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const { startContainer, startOffset } = range;

  if (startContainer.nodeType === Node.TEXT_NODE) {
    if (startOffset === 0) {
      const textParent = (startContainer as Text).parentElement;
      // Caret in an empty text node between span siblings (e.g. between `=` and `,`).
      if (textParent === editor) {
        const prev = startContainer.previousSibling;
        if (prev) {
          ctx.formulaCache.rangeSetValueTo = prev;
          return true;
        }
        return false;
      }
      let el: HTMLElement | null = textParent;
      while (el && el !== editor) {
        if (el.previousSibling) {
          ctx.formulaCache.rangeSetValueTo = el.previousSibling;
          return true;
        }
        el = el.parentElement;
      }
      return false;
    }
    const p = (startContainer as Text).parentElement;
    if (p && editor.contains(p)) {
      ctx.formulaCache.rangeSetValueTo = p;
      return true;
    }
    return false;
  }

  if (
    startContainer.nodeType === Node.ELEMENT_NODE &&
    startContainer === editor
  ) {
    if (startOffset > 0) {
      const prev = startContainer.childNodes[startOffset - 1];
      if (prev) {
        ctx.formulaCache.rangeSetValueTo = prev;
        return true;
      }
    }
    return false;
  }

  if (startContainer.nodeType === Node.ELEMENT_NODE) {
    if (startOffset > 0) {
      const prev = startContainer.childNodes[startOffset - 1];
      if (prev) {
        ctx.formulaCache.rangeSetValueTo = prev;
        return true;
      }
    }
    let el: HTMLElement | null = startContainer as HTMLElement;
    while (el && el !== editor) {
      if (el.previousSibling) {
        ctx.formulaCache.rangeSetValueTo = el.previousSibling;
        return true;
      }
      el = el.parentElement;
    }
  }

  return false;
}

/** True while picking a range for a formula (sheet selection drives references). */
export function isLegacyFormulaRangeMode(ctx: Context): boolean {
  return (
    !!ctx.formulaCache.rangestart ||
    !!ctx.formulaCache.rangedrag_column_start ||
    !!ctx.formulaCache.rangedrag_row_start ||
    ctx.formulaCache.rangeSelectionActive === true ||
    israngeseleciton(ctx)
  );
}

export function israngeseleciton(ctx: Context, istooltip?: boolean) {
  if (istooltip == null) {
    istooltip = false;
  }

  const currSelection = window.getSelection();
  if (currSelection == null) {
    return false;
  }
  let anchor = currSelection.anchorNode;
  if (!anchor) {
    return false;
  }
  // Do not require non-empty text: caret may sit in an empty text node between
  // `(` and `,` (first empty argument).
  const { anchorOffset } = currSelection;
  const anchorElement = anchor as HTMLElement;
  const parentElement = anchor.parentNode as HTMLElement;

  const allowRangeInsertionAtCaret = () => {
    const editor =
      (anchorElement.closest?.(
        '#luckysheet-rich-text-editor, #luckysheet-functionbox-cell',
      ) as HTMLElement | null) ||
      (parentElement.closest?.(
        '#luckysheet-rich-text-editor, #luckysheet-functionbox-cell',
      ) as HTMLElement | null) ||
      (document.getElementById(
        'luckysheet-rich-text-editor',
      ) as HTMLElement | null);

    // Active range flow may continue updating a managed ref under the caret,
    // but must not bypass caret validation when the caret has moved to an
    // invalid slot (e.g. just after `)` → `=SUM(A1)|+B1`).
    if (
      editor &&
      (ctx.formulaCache.rangestart ||
        ctx.formulaCache.rangedrag_column_start ||
        ctx.formulaCache.rangedrag_row_start ||
        ctx.formulaCache.rangeSelectionActive === true) &&
      getFormulaRangeIndexAtCaret(editor as HTMLDivElement) !== null
    ) {
      return true;
    }

    return isCaretAtValidFormulaRangeInsertionPoint(editor);
  };
  if (
    anchor?.parentNode?.nodeName.toLowerCase() === 'span' &&
    anchorOffset !== 0
  ) {
    let txt = _.trim(normalizeFormulaBoundaryText(anchor.textContent ?? ''));
    let lasttxt = '';

    if (txt.length === 0 && anchor.parentNode.previousSibling) {
      // Walk past any `<br>` (or other empty) siblings — common on empty
      // multi-line continuation rows where the caret span only holds `\u200b`.
      let ahr: Node | null = anchor.parentNode.previousSibling;
      while (
        ahr &&
        _.trim(normalizeFormulaBoundaryText(ahr.textContent || '')).length === 0
      ) {
        ahr = ahr.previousSibling;
      }
      txt = _.trim(normalizeFormulaBoundaryText(ahr?.textContent || ''));
      lasttxt = txt.slice(-1);
    } else {
      lasttxt = anchorOffset > 0 ? txt.charAt(anchorOffset - 1) : '';
    }
    if (
      (istooltip && (lasttxt === '(' || lasttxt === ',')) ||
      (!istooltip &&
        (lasttxt === '(' ||
          lasttxt === ',' ||
          lasttxt === '=' ||
          lasttxt in operatorjson ||
          lasttxt === '&' ||
          lasttxt === ZWSP))
    ) {
      ctx.formulaCache.rangeSetValueTo = anchor.parentNode;
      return allowRangeInsertionAtCaret();
    }
  } else if (
    anchorElement.id === 'luckysheet-rich-text-editor' ||
    anchorElement.id === 'luckysheet-functionbox-cell'
  ) {
    const editorEl = anchorElement as HTMLElement;
    // Caret on the editor element (between span children): resolve from offset first.
    // Do not assign rangeSetValueTo from _.last(span) unless legacy heuristic matches,
    // or a stale A3-style ref causes `=,C4A3` inserts after the comma.
    if (
      currSelection.rangeCount > 0 &&
      setRangeSetValueToFromCaretPosition(ctx, editorEl, currSelection) &&
      allowRangeInsertionAtCaret()
    ) {
      return true;
    }

    const spans = editorEl.querySelectorAll('span');
    let txt = _.trim(
      normalizeFormulaBoundaryText(_.last(spans)?.innerText || ''),
    );
    let refSpan: Element | undefined = _.last(spans);

    if (txt.length === 0 && spans.length > 1) {
      txt = _.trim(
        normalizeFormulaBoundaryText(spans[spans.length - 2].innerText),
      );
      refSpan = spans[spans.length - 2];
    }

    const lasttxt = txt.slice(-1);

    if (
      (istooltip && (lasttxt === '(' || lasttxt === ',')) ||
      (!istooltip &&
        (lasttxt === '(' ||
          lasttxt === ',' ||
          lasttxt === '=' ||
          lasttxt in operatorjson ||
          lasttxt === '&' ||
          lasttxt === ZWSP))
    ) {
      ctx.formulaCache.rangeSetValueTo = refSpan;
      return allowRangeInsertionAtCaret();
    }
  } else if (
    parentElement.id === 'luckysheet-rich-text-editor' ||
    parentElement.id === 'luckysheet-functionbox-cell' ||
    anchorOffset === 0
  ) {
    if (anchorOffset === 0) {
      anchor = anchor.parentNode;
    }
    if (!anchor) {
      return false;
    }
    if (anchor.previousSibling?.textContent == null) {
      return false;
    }
    if (anchor.previousSibling) {
      const txt = _.trim(
        normalizeFormulaBoundaryText(anchor.previousSibling.textContent || ''),
      );
      const lasttxt = txt.slice(-1);

      if (
        (istooltip && (lasttxt === '(' || lasttxt === ',')) ||
        (!istooltip &&
          (lasttxt === '(' ||
            lasttxt === ',' ||
            lasttxt === '=' ||
            lasttxt in operatorjson ||
            lasttxt === '&' ||
            lasttxt === ZWSP))
      ) {
        ctx.formulaCache.rangeSetValueTo = anchor.previousSibling;
        return allowRangeInsertionAtCaret();
      }
    }
  }

  if (
    !istooltip &&
    (ctx.formulaCache.rangestart ||
      ctx.formulaCache.rangedrag_column_start ||
      ctx.formulaCache.rangedrag_row_start ||
      ctx.formulaCache.rangeSelectionActive === true)
  ) {
    const editor =
      (document.getElementById(
        'luckysheet-rich-text-editor',
      ) as HTMLElement | null) ||
      (document.getElementById(
        'luckysheet-functionbox-cell',
      ) as HTMLElement | null);
    if (
      editor &&
      currSelection.rangeCount > 0 &&
      setRangeSetValueToFromCaretPosition(ctx, editor, currSelection) &&
      allowRangeInsertionAtCaret()
    ) {
      return true;
    }
  }
  return false;
}

// Single source of truth for whether the caret is currently in a
// "formula reference selection" flow (i.e., where range tokens should be
// inserted/updated by keyboard/mouse navigation).
export function isFormulaReferenceInputMode(ctx: Context): boolean {
  const editor = getActiveFormulaEditorElement(ctx);
  const inputText = (editor?.innerText || '').trim();
  const hasActiveRangeDrag =
    !!ctx.formulaCache.rangestart ||
    !!ctx.formulaCache.rangedrag_column_start ||
    !!ctx.formulaCache.rangedrag_row_start;
  const caretAtValidInsertionPoint =
    !!editor && isCaretAtValidFormulaRangeInsertionPoint(editor);

  const refFlowActive =
    hasActiveRangeDrag || ctx.formulaCache.rangeSelectionActive === true;

  if (!inputText.startsWith('=')) {
    return false;
  }

  // If a range was just inserted (kbd/mouse) and the caret is still on that
  // managed range span, keep ref-input mode so arrow keys keep extending the
  // range (e.g. `=A2` → arrow → `=A3`). This mirrors main's `refFlowActive`
  // short-circuit and bypasses the bare-cell pattern check below for actively
  // managed tokens. Dirty edits clear `rangeSelectionActive`, so this does not
  // re-enable navigation after the user manually edited a token.
  if (
    ctx.formulaCache.rangeSelectionActive === true &&
    editor &&
    getFormulaRangeIndexAtCaret(editor as HTMLDivElement) !== null
  ) {
    return true;
  }

  // Same for bare `=A1` / `=Sheet2!A1` when the insert is still clean but the
  // caret is no longer inside the span (e.g. after a sheet-tab switch).
  if (
    ctx.formulaCache.rangeSelectionActive === true &&
    isBareCellOrRangeOnlyFormula(inputText)
  ) {
    return true;
  }

  // While user is still typing a function/identifier right after "="
  // (e.g. "=SUM" or "=kjnskfv"), do not treat it as range-reference mode.
  // Range-reference mode should start at insertion points such as "(" or ",".
  if (/^=\s*[A-Za-z_][A-Za-z0-9_]*$/.test(inputText)) {
    return false;
  }

  // Dirty/manual-edit mode is sticky for the current edit session: do not
  // auto-recover range mode just because caret reaches a syntactically valid slot.
  if (ctx.formulaCache.rangeSelectionActive === false) {
    return false;
  }

  // During active mouse drag/resize keep range mode on; for non-drag keyboard
  // states, still require caret to be at a valid insertion point.
  if (refFlowActive) {
    if (hasActiveRangeDrag) return true;
    return caretAtValidInsertionPoint;
  }

  // Priority: valid caret entry point should reopen reference mode first.
  if (caretAtValidInsertionPoint) {
    return true;
  }

  return israngeseleciton(ctx);
}

export function maybeRecoverDirtyRangeSelection(ctx: Context): boolean {
  if (ctx.formulaCache.rangeSelectionActive !== false) {
    return false;
  }

  const editor = getActiveFormulaEditorElement(ctx);
  if (!editor) {
    return false;
  }

  const inputText = (editor.innerText || '').trim();

  const atCaretRangeIndex = getFormulaRangeIndexAtCaret(editor);
  const validInsertion = isCaretAtValidFormulaRangeInsertionPoint(editor);
  const israngesel = israngeseleciton(ctx);
  const startsEq = inputText.startsWith('=');

  // Recover when the caret is back in a fresh, syntactically valid insertion
  // slot (e.g. `=`, between `=,`, after `,`, or after `(`), even if other
  // clean range tokens still exist elsewhere in the formula.
  // Do NOT recover while the caret is still inside a dirty managed range token
  // (e.g. `=A2:A` after deleting the trailing `5` from `=A2:A5`).
  if (startsEq && atCaretRangeIndex === null && validInsertion && israngesel) {
    ctx.formulaCache.rangeSelectionActive = null;
    return true;
  }

  return false;
}

export function functionStrChange(
  txt: string,
  type: string,
  rc: 'row' | 'col',
  orient: string | null,
  stindex: number,
  step: number,
) {
  if (!txt) {
    return '';
  }
  if (txt.substring(0, 1) === '=') {
    txt = txt.substring(1);
  }

  const funcstack = txt.split('');
  let i = 0;
  let str = '';
  let function_str = '';

  const matchConfig = {
    bracket: 0, // 括号
    comma: 0, // 逗号
    squote: 0, // 单引号
    dquote: 0, // 双引号
  };

  while (i < funcstack.length) {
    const s = funcstack[i];

    if (s === '(' && matchConfig.dquote === 0) {
      matchConfig.bracket += 1;

      if (str.length > 0) {
        function_str += `${str}(`;
      } else {
        function_str += '(';
      }

      str = '';
    } else if (s === ')' && matchConfig.dquote === 0) {
      matchConfig.bracket -= 1;
      function_str += `${functionStrChange(
        str,
        type,
        rc,
        orient,
        stindex,
        step,
      )})`;
      str = '';
    } else if (s === '"' && matchConfig.squote === 0) {
      if (matchConfig.dquote > 0) {
        function_str += `${str}"`;
        matchConfig.dquote -= 1;
        str = '';
      } else {
        matchConfig.dquote += 1;
        str += '"';
      }
    } else if (s === ',' && matchConfig.dquote === 0) {
      function_str += `${functionStrChange(
        str,
        type,
        rc,
        orient,
        stindex,
        step,
      )},`;
      str = '';
    } else if (s === '&' && matchConfig.dquote === 0) {
      if (str.length > 0) {
        function_str += `${functionStrChange(
          str,
          type,
          rc,
          orient,
          stindex,
          step,
        )}&`;
        str = '';
      } else {
        function_str += '&';
      }
    } else if (s in operatorjson && matchConfig.dquote === 0) {
      let s_next = '';

      if (i + 1 < funcstack.length) {
        s_next = funcstack[i + 1];
      }

      let p = i - 1;
      let s_pre = null;

      if (p >= 0) {
        do {
          s_pre = funcstack[(p -= 1)];
        } while (p >= 0 && s_pre === ' ');
      }

      if (s + s_next in operatorjson) {
        if (str.length > 0) {
          function_str +=
            functionStrChange(str, type, rc, orient, stindex, step) +
            s +
            s_next;
          str = '';
        } else {
          function_str += s + s_next;
        }

        i += 1;
      } else if (
        !/[^0-9]/.test(s_next) &&
        s === '-' &&
        (s_pre === '(' ||
          s_pre == null ||
          s_pre === ',' ||
          s_pre === ' ' ||
          s_pre in operatorjson)
      ) {
        str += s;
      } else {
        if (str.length > 0) {
          function_str +=
            functionStrChange(str, type, rc, orient, stindex, step) + s;
          str = '';
        } else {
          function_str += s;
        }
      }
    } else {
      str += s;
    }

    if (i === funcstack.length - 1) {
      if (iscelldata(_.trim(str))) {
        function_str += functionStrChange_range(
          _.trim(str),
          type,
          rc,
          orient,
          stindex,
          step,
        );
      } else {
        function_str += _.trim(str);
      }
    }

    i += 1;
  }

  return function_str;
}

export function rangeSetValue(
  ctx: Context,
  cellInput: HTMLDivElement,
  selected: any,
  fxInput?: HTMLDivElement | null,
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<div>${cellInput.innerHTML}</div>`,
    'text/html',
  );
  const spans = doc.querySelectorAll('span');
  const lastSpan = spans[spans.length - 1] as HTMLElement | undefined;
  // Only strip a trailing plain "A1"-style token. Do NOT strip
  // fortune-formula-functionrange-cell — that removes the live reference we are
  // updating during drag (→ hasSpanToReplace false, broken APPEND, rangeindex leak).
  const isManagedRangeSpan =
    lastSpan?.classList?.contains('fortune-formula-functionrange-cell') ??
    false;

  if (
    lastSpan &&
    isLetterNumberPattern(lastSpan?.innerText) &&
    !isManagedRangeSpan
  ) {
    const htmlR = removeLastSpan(cellInput.innerHTML);
    cellInput!.innerHTML = `${htmlR}`;
    cellInput.focus();
    // Replacing innerHTML drops all nodes and usually breaks getSelection().
    // israngeseleciton() here often pointed rangeSetValueTo one slot too far
    // (e.g. after `,`). Multi-cell text like A1:A4 never matches
    // isLetterNumberPattern, so only plain single-cell tails hit this path.
    const kids = cellInput.childNodes;
    ctx.formulaCache.rangeSetValueTo =
      kids.length > 0 ? kids[kids.length - 1] : undefined;
  }

  let $editor = cellInput;
  let $copyTo = fxInput;
  if (getFormulaEditorOwner(ctx) === 'fx') {
    $editor = fxInput!;
    $copyTo = cellInput;
  }
  let range = '';
  const rf = selected.row[0];
  const cf = selected.column[0];
  if (ctx.config.merge != null && `${rf}_${cf}` in ctx.config.merge) {
    range = getRangetxt(
      ctx,
      ctx.currentSheetId,
      {
        column: [cf, cf],
        row: [rf, rf],
      },
      ctx.formulaCache.rangetosheet,
    );
  } else {
    range = getRangetxt(
      ctx,
      ctx.currentSheetId,
      selected,
      ctx.formulaCache.rangetosheet,
    );
  }
  // let $editor;

  const activeRangeFlow =
    ctx.formulaCache.rangestart ||
    ctx.formulaCache.rangedrag_column_start ||
    ctx.formulaCache.rangedrag_row_start ||
    ctx.formulaCache.rangeSelectionActive === true;
  const spanToReplace = !_.isNil(ctx.formulaCache.rangechangeindex)
    ? ($editor.querySelector(
      `span[rangeindex='${ctx.formulaCache.rangechangeindex}']`,
    ) as HTMLSpanElement | null)
    : null;

  if (activeRangeFlow && spanToReplace) {
    //   if (
    //     $("#luckysheet-search-formula-parm").is(":visible") ||
    //     $("#luckysheet-search-formula-parm-select").is(":visible")
    //   ) {
    //     // 公式参数框选取范围
    //     $editor = $("#luckysheet-rich-text-editor");
    //     $("#luckysheet-search-formula-parm-select-input").val(range);
    //     $("#luckysheet-search-formula-parm .parmBox")
    //       .eq(formulaCache.data_parm_index)
    //       .find(".txt input")
    //       .val(range);

    //     // 参数对应值显示
    //     const txtdata = luckysheet_getcelldata(range).data;
    //     if (txtdata instanceof Array) {
    //       // 参数为多个单元格选区
    //       const txtArr = [];

    //       for (let i = 0; i < txtdata.length; i += 1) {
    //         for (let j = 0; j < txtdata[i].length; j += 1) {
    //           if (txtdata[i][j] == null) {
    //             txtArr.push(null);
    //           } else {
    //             txtArr.push(txtdata[i][j].v);
    //           }
    //         }
    //       }

    //       $("#luckysheet-search-formula-parm .parmBox")
    //         .eq(formulaCache.data_parm_index)
    //         .find(".val")
    //         .text(` = {${txtArr.join(",")}}`);
    //     } else {
    //       // 参数为单个单元格选区
    //       $("#luckysheet-search-formula-parm .parmBox")
    //         .eq(formulaCache.data_parm_index)
    //         .find(".val")
    //         .text(` = {${txtdata.v}}`);
    //     }

    //     // 计算结果显示
    //     let isVal = true; // 参数不为空
    //     const parmValArr = []; // 参数值集合
    //     let lvi = -1; // 最后一个有值的参数索引
    //     $("#luckysheet-search-formula-parm .parmBox").each(function (i, e) {
    //       const parmtxt = $(e).find(".txt input").val();
    //       if (
    //         parmtxt === "" &&
    //         $(e).find(".txt input").attr("data_parm_require") === "m"
    //       ) {
    //         isVal = false;
    //       }
    //       if (parmtxt !== "") {
    //         lvi = i;
    //       }
    //     });

    // 单元格显示
    //     let functionHtmlTxt;
    //     if (lvi === -1) {
    //       functionHtmlTxt = `=${$(
    //         "#luckysheet-search-formula-parm .luckysheet-modal-dialog-title-text"
    //       ).text()}()`;
    //     } else if (lvi === 0) {
    //       functionHtmlTxt = `=${$(
    //         "#luckysheet-search-formula-parm .luckysheet-modal-dialog-title-text"
    //       ).text()}(${$("#luckysheet-search-formula-parm .parmBox")
    //         .eq(0)
    //         .find(".txt input")
    //         .val()})`;
    //     } else {
    //       for (let j = 0; j <= lvi; j += 1) {
    //         parmValArr.push(
    //           $("#luckysheet-search-formula-parm .parmBox")
    //             .eq(j)
    //             .find(".txt input")
    //             .val()
    //         );
    //       }
    //       functionHtmlTxt = `=${$(
    //         "#luckysheet-search-formula-parm .luckysheet-modal-dialog-title-text"
    //       ).text()}(${parmValArr.join(",")})`;
    //     }

    //     const function_str = functionHTMLGenerate(functionHtmlTxt);
    //     $("#luckysheet-rich-text-editor").html(function_str);
    //     $("#luckysheet-functionbox-cell").html(
    //       $("#luckysheet-rich-text-editor").html()
    //     );

    //     if (isVal) {
    //       // 公式计算
    //       const fp = _.trim(
    //         functionParserExe($("#luckysheet-rich-text-editor").text())
    //       );
    //       const result = new Function(`return ${fp}`)();
    //       $("#luckysheet-search-formula-parm .result span").text(result);
    //     }
    //   } else {
    // const currSelection = window.getSelection();
    // const anchorOffset = currSelection!.anchorNode;
    // $editor = $(anchorOffset).closest("div");

    // const $span = $editor
    //   .find(`span[rangeindex='${formulaCache.rangechangeindex}']`)
    //   .html(range);
    spanToReplace.innerHTML = range;
    setCaretPosition(ctx, spanToReplace, 0, range.length, $editor);
    //   }
  } else {
    const existingRangeIndexes = getRangeIndexes($editor);
    const nextRangeIndex =
      existingRangeIndexes.length > 0
        ? Math.max(...existingRangeIndexes) + 1
        : functionHTMLIndex;
    const function_str = `<span class="fortune-formula-functionrange-cell" rangeindex="${nextRangeIndex}" dir="auto" style="color:${colors[nextRangeIndex]};">${range}</span>`;
    const newEle = parseElement(function_str) as HTMLSpanElement;
    let refEle = ctx.formulaCache.rangeSetValueTo;
    if (refEle && !refEle.parentNode) {
      israngeseleciton(ctx);
      refEle = ctx.formulaCache.rangeSetValueTo;
    }
    if (refEle && refEle.parentNode) {
      const leftPar = document.getElementsByClassName(
        'luckysheet-formula-text-lpar',
      )?.[0];

      // handle case when user autocompletes the formula
      if (
        leftPar?.parentElement?.classList.contains(
          'luckysheet-formula-text-color',
        )
      ) {
        document
          .getElementsByClassName('luckysheet-formula-text-lpar')?.[0]
          .parentNode?.appendChild(newEle);
      } else {
        refEle.parentNode.insertBefore(newEle, refEle.nextSibling);
      }
    } else {
      $editor.appendChild(newEle);
    }
    ctx.formulaCache.rangechangeindex = nextRangeIndex;
    functionHTMLIndex = Math.max(functionHTMLIndex, nextRangeIndex + 1);
    const span = newEle?.parentNode ? newEle : null;
    if (span) {
      setCaretPosition(ctx, span, 0, range.length, $editor);
    } else {
      // Best-effort: avoid crashing on unexpected DOM; keep editor content updated.
      moveCursorToEnd($editor);
    }
  }

  if ($copyTo) $copyTo.innerHTML = $editor.innerHTML;
}

export function onFormulaRangeDragEnd(ctx: Context) {
  if (ctx.formulaCache.func_selectedrange) {
    const {
      left_move: left,
      top_move: top,
      width_move: width,
      height_move: height,
    } = ctx.formulaCache.func_selectedrange;
    if (
      left != null &&
      top != null &&
      width != null &&
      height != null &&
      (ctx.formulaCache.rangestart ||
        ctx.formulaCache.rangedrag_column_start ||
        ctx.formulaCache.rangedrag_row_start)
    )
      ctx.formulaRangeSelect = {
        rangeIndex: ctx.formulaCache.rangeIndex || 0,
        left,
        top,
        width,
        height,
      };
  }
  ctx.formulaCache.selectingRangeIndex = -1;
}

function setRangeSelect(
  container: HTMLDivElement,
  left: number,
  top: number,
  height: number,
  width: number,
) {
  const rangeElement = container.querySelector(
    '.fortune-formula-functionrange-select',
  ) as HTMLDivElement;
  if (rangeElement == null) return;
  rangeElement.style.left = `${left}px`;
  rangeElement.style.top = `${top}px`;
  rangeElement.style.height = `${height}px`;
  rangeElement.style.width = `${width}px`;
}

export function rangeDrag(
  ctx: Context,
  e: MouseEvent,
  cellInput: HTMLDivElement,
  scrollLeft: number,
  scrollTop: number,
  container: HTMLDivElement,
  fxInput?: HTMLDivElement | null,
) {
  // Mouse drag is a programmatic range selection.
  ctx.formulaCache.rangeSelectionActive = true;

  const { func_selectedrange } = ctx.formulaCache;
  if (
    !func_selectedrange ||
    func_selectedrange.left == null ||
    func_selectedrange.height == null ||
    func_selectedrange.top == null ||
    func_selectedrange.width == null
  )
    return;
  const rect = container.getBoundingClientRect();
  const x = e.pageX - rect.left - ctx.rowHeaderWidth + scrollLeft;
  const y = e.pageY - rect.top - ctx.columnHeaderHeight + scrollTop;

  const [row_pre, row, row_index] = rowLocation(y, ctx.visibledatarow);

  const [col_pre, col, col_index] = colLocation(x, ctx.visibledatacolumn);

  let top = 0;
  let height = 0;
  let rowseleted = [];

  if (func_selectedrange.top > row_pre) {
    top = row_pre;
    height = func_selectedrange.top + func_selectedrange.height - row_pre;
    rowseleted = [row_index, func_selectedrange.row[1]];
  } else if (func_selectedrange.top === row_pre) {
    top = row_pre;
    height = func_selectedrange.top + func_selectedrange.height - row_pre;
    rowseleted = [row_index, func_selectedrange.row[0]];
  } else {
    top = func_selectedrange.top;
    height = row - func_selectedrange.top - 1;
    rowseleted = [func_selectedrange.row[0], row_index];
  }

  let left = 0;
  let width = 0;
  let columnseleted = [];

  if (func_selectedrange.left > col_pre) {
    left = col_pre;
    width = func_selectedrange.left + func_selectedrange.width - col_pre;
    columnseleted = [col_index, func_selectedrange.column[1]];
  } else if (func_selectedrange.left === col_pre) {
    left = col_pre;
    width = func_selectedrange.left + func_selectedrange.width - col_pre;
    columnseleted = [col_index, func_selectedrange.column[0]];
  } else {
    left = func_selectedrange.left;
    width = col - func_selectedrange.left - 1;
    columnseleted = [func_selectedrange.column[0], col_index];
  }

  // rowseleted[0] = luckysheetFreezen.changeFreezenIndex(rowseleted[0], "h");
  // rowseleted[1] = luckysheetFreezen.changeFreezenIndex(rowseleted[1], "h");
  // columnseleted[0] = luckysheetFreezen.changeFreezenIndex(
  //   columnseleted[0],
  //   "v"
  // );
  // columnseleted[1] = luckysheetFreezen.changeFreezenIndex(
  //   columnseleted[1],
  //   "v"
  // );

  const changeparam = mergeMoveMain(
    ctx,
    columnseleted,
    rowseleted,
    func_selectedrange,
    top,
    height,
    left,
    width,
  );
  if (changeparam != null) {
    // @ts-ignore
    [columnseleted, rowseleted, top, height, left, width] = changeparam;
  }

  func_selectedrange.row = rowseleted;
  func_selectedrange.column = columnseleted;

  func_selectedrange.left_move = left;
  func_selectedrange.width_move = width;
  func_selectedrange.top_move = top;
  func_selectedrange.height_move = height;

  // Do not update `luckysheet_select_save` here — that draws the yellow sheet
  // selection. Formula picking should show only the blue overlay + spans; yellow
  // stays on the pre-drag sheet selection (e.g. the cell being edited).

  // luckysheet_count_show(left, top, width, height, rowseleted, columnseleted);

  // if ($("#luckysheet-ifFormulaGenerator-multiRange-dialog").is(":visible")) {
  //   // if公式生成器 选择范围
  //   const range = getRangetxt(
  //     ctx,
  //     ctx.currentSheetId,
  //     { row: rowseleted, column: columnseleted },
  //     ctx.currentSheetId
  //   );
  //   $("#luckysheet-ifFormulaGenerator-multiRange-dialog input").val(range);
  // } else {
  rangeSetValue(
    ctx,
    cellInput,
    {
      row: rowseleted,
      column: columnseleted,
    },
    fxInput,
  );

  setRangeSelect(container, left, top, height, width);
  // }

  // luckysheetFreezen.scrollFreezen(rowseleted, columnseleted);
  e.preventDefault();
}

export function rangeDragColumn(
  ctx: Context,
  e: MouseEvent,
  cellInput: HTMLDivElement,
  scrollLeft: number,
  scrollTop: number,
  container: HTMLDivElement,
  fxInput?: HTMLDivElement | null,
) {
  // Mouse drag is a programmatic range selection.
  ctx.formulaCache.rangeSelectionActive = true;

  const { func_selectedrange } = ctx.formulaCache;
  if (
    !func_selectedrange ||
    func_selectedrange.left == null ||
    func_selectedrange.height == null ||
    func_selectedrange.top == null ||
    func_selectedrange.width == null
  )
    return;
  const mouse = mousePosition(e.pageX, e.pageY, ctx);
  const x = mouse[0] + scrollLeft;

  const { visibledatarow } = ctx;
  const row_index = visibledatarow.length - 1;
  const row = visibledatarow[row_index];
  const row_pre = 0;

  const [col_pre, col, col_index] = colLocation(x, ctx.visibledatacolumn);

  let left = 0;
  let width = 0;
  let columnseleted = [];

  if (func_selectedrange.left > col_pre) {
    left = col_pre;
    width = func_selectedrange.left + func_selectedrange.width - col_pre;
    columnseleted = [col_index, func_selectedrange.column[1]];
  } else if (func_selectedrange.left === col_pre) {
    left = col_pre;
    width = func_selectedrange.left + func_selectedrange.width - col_pre;
    columnseleted = [col_index, func_selectedrange.column[0]];
  } else {
    left = func_selectedrange.left;
    width = col - func_selectedrange.left - 1;
    columnseleted = [func_selectedrange.column[0], col_index];
  }

  // // rowseleted[0] = luckysheetFreezen.changeFreezenIndex(rowseleted[0], "h");
  // // rowseleted[1] = luckysheetFreezen.changeFreezenIndex(rowseleted[1], "h");
  // columnseleted[0] = luckysheetFreezen.changeFreezenIndex(
  //   columnseleted[0],
  //   "v"
  // );
  // columnseleted[1] = luckysheetFreezen.changeFreezenIndex(
  //   columnseleted[1],
  //   "v"
  // );

  const changeparam = mergeMoveMain(
    ctx,
    columnseleted,
    [0, row_index],
    func_selectedrange,
    row_pre,
    row - row_pre - 1,
    left,
    width,
  );
  if (changeparam != null) {
    // @ts-ignore
    [columnseleted, , , , left, width] = changeparam;
    // rowseleted= changeparam[1];
    // top = changeparam[2];
    // height = changeparam[3];
    // left = changeparam[4];
    // width = changeparam[5];
  }

  func_selectedrange.column = columnseleted;
  func_selectedrange.left_move = left;
  func_selectedrange.width_move = width;

  // See `rangeDrag`: do not resize yellow `luckysheet_select_save` during formula drag.

  // luckysheet_count_show(
  //   left,
  //   row_pre,
  //   width,
  //   row - row_pre - 1,
  //   [0, row_index],
  //   columnseleted
  // );

  rangeSetValue(
    ctx,
    cellInput,
    {
      row: [null, null],
      column: columnseleted,
    },
    fxInput,
  );

  setRangeSelect(container, left, row_pre, row - row_pre - 1, width);

  // luckysheetFreezen.scrollFreezen([0, row_index], columnseleted);
}

export function rangeDragRow(
  ctx: Context,
  e: MouseEvent,
  cellInput: HTMLDivElement,
  scrollLeft: number,
  scrollTop: number,
  container: HTMLDivElement,
  fxInput?: HTMLDivElement | null,
) {
  // Mouse drag is a programmatic range selection.
  ctx.formulaCache.rangeSelectionActive = true;

  const { func_selectedrange } = ctx.formulaCache;
  if (
    !func_selectedrange ||
    func_selectedrange.left == null ||
    func_selectedrange.height == null ||
    func_selectedrange.top == null ||
    func_selectedrange.width == null
  )
    return;

  const mouse = mousePosition(e.pageX, e.pageY, ctx);
  const y = mouse[1] + scrollTop;

  const [row_pre, row, row_index] = rowLocation(y, ctx.visibledatarow);

  const { visibledatacolumn } = ctx;
  const col_index = visibledatacolumn.length - 1;
  const col = visibledatacolumn[col_index];
  const col_pre = 0;

  let top = 0;
  let height = 0;
  let rowseleted = [];

  if (func_selectedrange.top > row_pre) {
    top = row_pre;
    height = func_selectedrange.top + func_selectedrange.height - row_pre;
    rowseleted = [row_index, func_selectedrange.row[1]];
  } else if (func_selectedrange.top === row_pre) {
    top = row_pre;
    height = func_selectedrange.top + func_selectedrange.height - row_pre;
    rowseleted = [row_index, func_selectedrange.row[0]];
  } else {
    top = func_selectedrange.top;
    height = row - func_selectedrange.top - 1;
    rowseleted = [func_selectedrange.row[0], row_index];
  }

  // rowseleted[0] = luckysheetFreezen.changeFreezenIndex(rowseleted[0], "h");
  // rowseleted[1] = luckysheetFreezen.changeFreezenIndex(rowseleted[1], "h");
  // // columnseleted[0] = luckysheetFreezen.changeFreezenIndex(columnseleted[0], "v");
  // // columnseleted[1] = luckysheetFreezen.changeFreezenIndex(columnseleted[1], "v");

  const changeparam = mergeMoveMain(
    ctx,
    [0, col_index],
    rowseleted,
    func_selectedrange,
    top,
    height,
    col_pre,
    col - col_pre - 1,
  );
  if (changeparam != null) {
    // @ts-ignore
    [, rowseleted, top, height] = changeparam;
  }

  func_selectedrange.row = rowseleted;
  func_selectedrange.top_move = top;
  func_selectedrange.height_move = height;

  // See `rangeDrag`: do not resize yellow `luckysheet_select_save` during formula drag.

  // luckysheet_count_show(col_pre, top, col - col_pre - 1, height, rowseleted, [
  //   0,
  //   col_index,
  // ]);

  rangeSetValue(
    ctx,
    cellInput,
    {
      row: rowseleted,
      column: [null, null],
    },
    fxInput,
  );
  setRangeSelect(container, col_pre, top, height, col - col_pre - 1);

  // luckysheetFreezen.scrollFreezen(rowseleted, [0, col_index]);
}

function updateparam(orient: string, txt: string, step: number) {
  const val = txt.split('!');
  let rangetxt;
  let prefix = '';

  if (val.length > 1) {
    [, rangetxt] = val;
    prefix = `${val[0]}!`;
  } else {
    [rangetxt] = val;
  }

  if (rangetxt.indexOf(':') === -1) {
    let row = parseInt(rangetxt.replace(/[^0-9]/g, ''), 10);
    let col = columnCharToIndex(rangetxt.replace(/[^A-Za-z]/g, ''));
    const freezonFuc = isfreezonFuc(rangetxt);
    const $row = freezonFuc[0] ? '$' : '';
    const $col = freezonFuc[1] ? '$' : '';

    if (orient === 'u' && !freezonFuc[0]) {
      row -= step;
    } else if (orient === 'r' && !freezonFuc[1]) {
      col += step;
    } else if (orient === 'l' && !freezonFuc[1]) {
      col -= step;
    } else if (orient === 'd' && !freezonFuc[0]) {
      row += step;
    }

    if (!Number.isNaN(row) && !Number.isNaN(col)) {
      return prefix + $col + indexToColumnChar(col) + $row + row;
    }
    if (!Number.isNaN(row)) {
      return prefix + $row + row;
    }
    if (!Number.isNaN(col)) {
      return prefix + $col + indexToColumnChar(col);
    }
    return txt;
  }
  rangetxt = rangetxt.split(':');
  const row = [];
  const col = [];

  row[0] = parseInt(rangetxt[0].replace(/[^0-9]/g, ''), 10);
  row[1] = parseInt(rangetxt[1].replace(/[^0-9]/g, ''), 10);
  if (row[0] > row[1]) {
    return txt;
  }

  col[0] = columnCharToIndex(rangetxt[0].replace(/[^A-Za-z]/g, ''));
  col[1] = columnCharToIndex(rangetxt[1].replace(/[^A-Za-z]/g, ''));
  if (col[0] > col[1]) {
    return txt;
  }

  const freezonFuc0 = isfreezonFuc(rangetxt[0]);
  const freezonFuc1 = isfreezonFuc(rangetxt[1]);
  const $row0 = freezonFuc0[0] ? '$' : '';
  const $col0 = freezonFuc0[1] ? '$' : '';
  const $row1 = freezonFuc1[0] ? '$' : '';
  const $col1 = freezonFuc1[1] ? '$' : '';

  if (orient === 'u') {
    if (!freezonFuc0[0]) {
      row[0] -= step;
    }

    if (!freezonFuc1[0]) {
      row[1] -= step;
    }
  } else if (orient === 'r') {
    if (!freezonFuc0[1]) {
      col[0] += step;
    }

    if (!freezonFuc1[1]) {
      col[1] += step;
    }
  } else if (orient === 'l') {
    if (!freezonFuc0[1]) {
      col[0] -= step;
    }

    if (!freezonFuc1[1]) {
      col[1] -= step;
    }
  } else if (orient === 'd') {
    if (!freezonFuc0[0]) {
      row[0] += step;
    }

    if (!freezonFuc1[0]) {
      row[1] += step;
    }
  }

  if (row[0] < 0 || col[0] < 0) {
    return error.r;
  }

  if (Number.isNaN(col[0]) && Number.isNaN(col[1])) {
    return `${prefix + $row0 + row[0]}:${$row1}${row[1]}`;
  }
  if (Number.isNaN(row[0]) && Number.isNaN(row[1])) {
    return `${prefix + $col0 + indexToColumnChar(col[0])
      }:${$col1}${indexToColumnChar(col[1])}`;
  }
  return `${prefix + $col0 + indexToColumnChar(col[0]) + $row0 + row[0]
    }:${$col1}${indexToColumnChar(col[1])}${$row1}${row[1]}`;
}

function downparam(txt: string, step: number) {
  return updateparam('d', txt, step);
}

function upparam(txt: string, step: number) {
  return updateparam('u', txt, step);
}

function leftparam(txt: string, step: number) {
  return updateparam('l', txt, step);
}

function rightparam(txt: string, step: number) {
  return updateparam('r', txt, step);
}

export function functionCopy(
  ctx: Context,
  txt: string,
  mode: string,
  step: number,
) {
  if (mode == null) {
    mode = 'down';
  }

  if (step == null) {
    step = 1;
  }

  if (txt.substring(0, 1) === '=') {
    txt = txt.substring(1);
  }

  const funcstack = txt.split('');
  let i = 0;
  let str = '';
  let function_str = '';

  const matchConfig = {
    bracket: 0,
    comma: 0,
    squote: 0,
    dquote: 0,
  };

  while (i < funcstack.length) {
    const s = funcstack[i];

    if (s === '(' && matchConfig.dquote === 0) {
      matchConfig.bracket += 1;

      if (str.length > 0) {
        function_str += `${str}(`;
      } else {
        function_str += '(';
      }

      str = '';
    } else if (s === ')' && matchConfig.dquote === 0) {
      matchConfig.bracket -= 1;
      function_str += `${functionCopy(ctx, str, mode, step)})`;
      str = '';
    } else if (s === '"' && matchConfig.squote === 0) {
      if (matchConfig.dquote > 0) {
        function_str += `${str}"`;
        matchConfig.dquote -= 1;
        str = '';
      } else {
        matchConfig.dquote += 1;
        str += '"';
      }
    } else if (s === ',' && matchConfig.dquote === 0) {
      function_str += `${functionCopy(ctx, str, mode, step)},`;
      str = '';
    } else if (s === '&' && matchConfig.dquote === 0) {
      if (str.length > 0) {
        function_str += `${functionCopy(ctx, str, mode, step)}&`;
        str = '';
      } else {
        function_str += '&';
      }
    } else if (s in operatorjson && matchConfig.dquote === 0) {
      let s_next = '';

      if (i + 1 < funcstack.length) {
        s_next = funcstack[i + 1];
      }

      let p = i - 1;
      let s_pre = null;

      if (p >= 0) {
        do {
          s_pre = funcstack[p];
          p -= 1;
        } while (p >= 0 && s_pre === ' ');
      }

      if (s + s_next in operatorjson) {
        if (str.length > 0) {
          function_str += functionCopy(ctx, str, mode, step) + s + s_next;
          str = '';
        } else {
          function_str += s + s_next;
        }

        i += 1;
      } else if (
        !/[^0-9]/.test(s_next) &&
        s === '-' &&
        (s_pre === '(' ||
          s_pre == null ||
          s_pre === ',' ||
          s_pre === ' ' ||
          s_pre in operatorjson)
      ) {
        str += s;
      } else {
        if (str.length > 0) {
          function_str += functionCopy(ctx, str, mode, step) + s;
          str = '';
        } else {
          function_str += s;
        }
      }
    } else {
      str += s;
    }

    if (i === funcstack.length - 1) {
      if (iscelldata(_.trim(str))) {
        if (mode === 'down') {
          function_str += downparam(_.trim(str), step);
        } else if (mode === 'up') {
          function_str += upparam(_.trim(str), step);
        } else if (mode === 'left') {
          function_str += leftparam(_.trim(str), step);
        } else if (mode === 'right') {
          function_str += rightparam(_.trim(str), step);
        }
      } else {
        function_str += _.trim(str);
      }
    }

    i += 1;
  }

  function_str = function_str.replace(/NaN/g, '');

  return function_str;
}

type MoveReferenceRect = {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
};

function normalizeSheetName(ref: string) {
  const unquoted =
    ref.startsWith("'") && ref.endsWith("'")
      ? ref.slice(1, -1).replace(/''/g, "'")
      : ref;
  return unquoted;
}

const MAP_REMAP_REF_REGEX =
  /((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?)([A-Za-z]+)(\$?)(\d+)(?::(\$?)([A-Za-z]+)(\$?)(\d+))?/g;

export function remapFormulaReferencesByMap(
  formula: string,
  formulaSheetName: string,
  movedSheetName: string,
  maps: {
    rowMap?: Record<number, number>;
    colMap?: Record<number, number>;
  },
) {
  const { rowMap, colMap } = maps;
  if (!formula) return formula;
  return formula.replace(
    MAP_REMAP_REF_REGEX,
    (
      token,
      sheetPrefix,
      colAbs0,
      col0,
      rowAbs0,
      row0,
      colAbs1,
      col1,
      rowAbs1,
      row1,
    ) => {
      const refSheetName = sheetPrefix
        ? normalizeSheetName((sheetPrefix as string).slice(0, -1))
        : formulaSheetName;
      if (refSheetName !== movedSheetName) return token;

      const remapOne = (colText: string, rowText: string) => {
        const colIndex = columnCharToIndex(colText);
        const rowIndex = parseInt(rowText, 10) - 1;

        const nextCol =
          !Number.isNaN(colIndex) && !_.isNil(colMap?.[colIndex])
            ? indexToColumnChar(colMap![colIndex]!)
            : colText;
        const nextRow =
          !Number.isNaN(rowIndex) && !_.isNil(rowMap?.[rowIndex])
            ? String(rowMap![rowIndex]! + 1)
            : rowText;
        return { nextCol, nextRow };
      };

      const head = remapOne(col0, row0);
      if (_.isNil(col1) || _.isNil(row1)) {
        return `${sheetPrefix || ''}${colAbs0}${head.nextCol}${rowAbs0}${head.nextRow
          }`;
      }
      const tail = remapOne(col1, row1);
      return `${sheetPrefix || ''}${colAbs0}${head.nextCol}${rowAbs0}${head.nextRow
        }:${colAbs1}${tail.nextCol}${rowAbs1}${tail.nextRow}`;
    },
  );
}

function parseRefToken(token: string) {
  const m = token.match(/^(\$?)([A-Za-z]+)(\$?)(\d+)$/);
  if (!m) return null;
  const colAbs = m[1] === '$';
  const col = columnCharToIndex(m[2]);
  const rowAbs = m[3] === '$';
  const row = parseInt(m[4], 10) - 1;
  if (Number.isNaN(row) || Number.isNaN(col)) return null;
  return { colAbs, rowAbs, col, row };
}

function formatRefToken(parts: {
  colAbs: boolean;
  rowAbs: boolean;
  col: number;
  row: number;
}) {
  return `${parts.colAbs ? '$' : ''}${indexToColumnChar(parts.col)}${parts.rowAbs ? '$' : ''
    }${parts.row + 1}`;
}

function moveSingleRefToken(
  token: string,
  sourceRect: MoveReferenceRect,
  targetRowStart: number,
  targetColStart: number,
) {
  const parsed = parseRefToken(token);
  if (!parsed) return token;
  const inSourceRect =
    parsed.row >= sourceRect.rowStart &&
    parsed.row <= sourceRect.rowEnd &&
    parsed.col >= sourceRect.colStart &&
    parsed.col <= sourceRect.colEnd;

  if (!inSourceRect) return token;

  return formatRefToken({
    ...parsed,
    row: targetRowStart + (parsed.row - sourceRect.rowStart),
    col: targetColStart + (parsed.col - sourceRect.colStart),
  });
}

function moveRangeRefToken(
  token: string,
  sourceRect: MoveReferenceRect,
  targetRowStart: number,
  targetColStart: number,
) {
  const parts = token.split(':');
  if (parts.length === 1) {
    return moveSingleRefToken(
      token,
      sourceRect,
      targetRowStart,
      targetColStart,
    );
  }
  if (parts.length !== 2) return token;

  const left = moveSingleRefToken(
    parts[0],
    sourceRect,
    targetRowStart,
    targetColStart,
  );
  const right = moveSingleRefToken(
    parts[1],
    sourceRect,
    targetRowStart,
    targetColStart,
  );
  return `${left}:${right}`;
}

function moveFormulaReferenceToken(
  token: string,
  formulaSheetName: string,
  movedSheetName: string,
  sourceRect: MoveReferenceRect,
  targetRowStart: number,
  targetColStart: number,
) {
  const exclamation = token.lastIndexOf('!');
  let sheetPrefix = '';
  let rangeToken = token;
  let refSheetName = formulaSheetName;

  if (exclamation > -1) {
    sheetPrefix = token.slice(0, exclamation + 1);
    rangeToken = token.slice(exclamation + 1);
    refSheetName = normalizeSheetName(sheetPrefix.slice(0, -1));
  }

  if (refSheetName !== movedSheetName) return token;

  const moved = moveRangeRefToken(
    rangeToken,
    sourceRect,
    targetRowStart,
    targetColStart,
  );
  return `${sheetPrefix}${moved}`;
}

export function functionMoveReference(
  txt: string,
  formulaSheetName: string,
  movedSheetName: string,
  sourceRect: MoveReferenceRect,
  targetRowStart: number,
  targetColStart: number,
) {
  if (!txt) {
    return '';
  }
  if (txt.substring(0, 1) === '=') {
    txt = txt.substring(1);
  }

  const funcstack = txt.split('');
  let i = 0;
  let str = '';
  let function_str = '';

  const matchConfig = {
    bracket: 0,
    comma: 0,
    squote: 0,
    dquote: 0,
  };

  while (i < funcstack.length) {
    const s = funcstack[i];

    if (s === '(' && matchConfig.dquote === 0) {
      matchConfig.bracket += 1;
      function_str += str.length > 0 ? `${str}(` : '(';
      str = '';
    } else if (s === ')' && matchConfig.dquote === 0) {
      matchConfig.bracket -= 1;
      function_str += `${functionMoveReference(
        str,
        formulaSheetName,
        movedSheetName,
        sourceRect,
        targetRowStart,
        targetColStart,
      )})`;
      str = '';
    } else if (s === '"' && matchConfig.squote === 0) {
      if (matchConfig.dquote > 0) {
        function_str += `${str}"`;
        matchConfig.dquote -= 1;
        str = '';
      } else {
        matchConfig.dquote += 1;
        str += '"';
      }
    } else if (s === ',' && matchConfig.dquote === 0) {
      function_str += `${functionMoveReference(
        str,
        formulaSheetName,
        movedSheetName,
        sourceRect,
        targetRowStart,
        targetColStart,
      )},`;
      str = '';
    } else if (s === '&' && matchConfig.dquote === 0) {
      if (str.length > 0) {
        function_str += `${functionMoveReference(
          str,
          formulaSheetName,
          movedSheetName,
          sourceRect,
          targetRowStart,
          targetColStart,
        )}&`;
        str = '';
      } else {
        function_str += '&';
      }
    } else if (s in operatorjson && matchConfig.dquote === 0) {
      let s_next = '';
      if (i + 1 < funcstack.length) {
        s_next = funcstack[i + 1];
      }

      let p = i - 1;
      let s_pre = null;
      if (p >= 0) {
        do {
          s_pre = funcstack[p];
          p -= 1;
        } while (p >= 0 && s_pre === ' ');
      }

      if (s + s_next in operatorjson) {
        if (str.length > 0) {
          function_str +=
            functionMoveReference(
              str,
              formulaSheetName,
              movedSheetName,
              sourceRect,
              targetRowStart,
              targetColStart,
            ) +
            s +
            s_next;
          str = '';
        } else {
          function_str += s + s_next;
        }
        i += 1;
      } else if (
        !/[^0-9]/.test(s_next) &&
        s === '-' &&
        (s_pre === '(' ||
          s_pre == null ||
          s_pre === ',' ||
          s_pre === ' ' ||
          s_pre in operatorjson)
      ) {
        str += s;
      } else {
        if (str.length > 0) {
          function_str +=
            functionMoveReference(
              str,
              formulaSheetName,
              movedSheetName,
              sourceRect,
              targetRowStart,
              targetColStart,
            ) + s;
          str = '';
        } else {
          function_str += s;
        }
      }
    } else {
      str += s;
    }

    if (i === funcstack.length - 1) {
      const t = _.trim(str);
      if (iscelldata(t)) {
        function_str += moveFormulaReferenceToken(
          t,
          formulaSheetName,
          movedSheetName,
          sourceRect,
          targetRowStart,
          targetColStart,
        );
      } else {
        function_str += t;
      }
    }

    i += 1;
  }

  return function_str;
}
