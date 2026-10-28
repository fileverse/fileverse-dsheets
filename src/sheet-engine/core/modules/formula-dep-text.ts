/**
 * C8: read a formula's references from its text, without evaluating it.
 *
 * The result is what `execfunction` records for the same formula (same cell
 * keys, same 10,000-cell cut-off, same "run on every commit" marker for wide
 * and unresolved references), plus the references the normal commit pass's
 * parse misses: those next to a space, in a formula using INDEX(, and behind
 * an unquoted tab name that contains a split character (`Q1-2026!A1`).
 *
 * It never reads another tab's cells, so it hydrates nothing: a whole-row or
 * whole-column reference into a tab that has no grid yet is marked wide.
 */
import { Context } from '../context';
import { getSheetIdByName } from '../utils';
import { resolveDefinedNameForFormula } from './namedRanges';
import { RUNTIME_REFERENCE_RE } from './formula';

/** Same cap as `execfunction` (MAX_RANGE_DEPS in formula.ts). */
export const MAX_TEXT_RANGE_DEPS = 10_000;

export type FormulaTextDeps = {
  /** `${sheetId}:${r}:${c}` of every cell the formula reads. */
  deps: Set<string>;
  /** Too wide or unresolvable to list: the formula runs on every commit. */
  wide: boolean;
};

const SIMPLE_PREFIX = /^[A-Za-z0-9_À-ʯ]+!/;
const QUOTED_PREFIX = /^'(?:[^']|'')*'!/;
const REF_PART = /^(\$?)([A-Za-z]*)(\$?)([0-9]*)/;
const FUNCTION_NAME = /^[A-Za-z][A-Za-z_0-9.]*(?=\()/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z_0-9]*/;
const NUMBER = /^[0-9]*\.?[0-9]+/;
const ERROR_TOKEN = /^#[A-Z0-9/]+(?:!|\?)?/;
const SIMPLE_NAME_CHARS = /^[A-Za-z0-9_À-ʯ]+$/;

const columnIndex = (letters: string): number => {
  let result = 0;
  const upper = letters.toUpperCase();
  for (let i = 0; i < upper.length; i += 1) {
    result = result * 26 + (upper.charCodeAt(i) - 64);
  }
  return result - 1;
};

const rowIndex = (digits: string): number => {
  const n = parseInt(digits, 10);
  return Number.isNaN(n) ? -1 : Math.max(n - 1, -1);
};

type Ref = {
  sheet: string | null; // tab name as written, unquoted
  letters: string;
  digits: string;
  end: number;
};

const isBoundary = (s: string, i: number) =>
  i === 0 || !/[A-Za-z0-9_$.]/.test(s[i - 1]);

/** The tab name and length of a `name!` prefix at `i`, or null. */
function matchPrefix(
  s: string,
  i: number,
  oddNames: string[],
): { name: string; length: number } | null {
  const rest = s.slice(i, i + 256);
  const quoted = QUOTED_PREFIX.exec(rest);
  if (quoted) {
    return {
      name: quoted[0].slice(1, -2).replace(/''/g, "'"),
      length: quoted[0].length,
    };
  }
  // Unquoted names with a split character, matched against real tab names.
  for (let k = 0; k < oddNames.length; k += 1) {
    const name = oddNames[k];
    if (s.startsWith(`${name}!`, i)) {
      return { name, length: name.length + 1 };
    }
  }
  const simple = SIMPLE_PREFIX.exec(rest);
  if (simple) {
    return { name: simple[0].slice(0, -1), length: simple[0].length };
  }
  return null;
}

function matchRef(s: string, i: number, oddNames: string[]): Ref | null {
  let sheet: string | null = null;
  let j = i;
  const prefix = matchPrefix(s, i, oddNames);
  if (prefix) {
    sheet = prefix.name;
    j += prefix.length;
  }
  const m = REF_PART.exec(s.slice(j, j + 64));
  if (!m || (m[2] === '' && m[4] === '')) return null;
  return { sheet, letters: m[2], digits: m[4], end: j + m[0].length };
}

/**
 * Collect the references of formula text `f` (with its leading `=`) written
 * in cell (`r`, `c`) of tab `sheetId`.
 */
export function collectFormulaTextDeps(
  ctx: Context,
  f: string,
  sheetId: string,
  r: number,
  c: number,
): FormulaTextDeps {
  const deps = new Set<string>();
  let wide = RUNTIME_REFERENCE_RE.test(f);
  const originKey = `${sheetId}:${r}:${c}`;
  const s = (f.startsWith('=') ? f.slice(1) : f)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  const oddNames = (ctx.luckysheetfile || [])
    .map((file) => file.name)
    .filter(
      (name): name is string =>
        typeof name === 'string' && !!name && !SIMPLE_NAME_CHARS.test(name),
    )
    .sort((a, b) => b.length - a.length);

  const resolveSheet = (name: string | null): string | null => {
    if (name == null) return sheetId;
    const id = getSheetIdByName(ctx, name) ?? null;
    if (id == null) wide = true; // a later add or rename can resolve it
    return id;
  };

  const addRange = (
    id: string,
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number,
  ) => {
    const originInRange =
      id === sheetId &&
      r >= startRow &&
      r <= endRow &&
      c >= startCol &&
      c <= endCol;
    const size = (endRow - startRow + 1) * (endCol - startCol + 1);
    if (size <= MAX_TEXT_RANGE_DEPS) {
      for (let row = startRow; row <= endRow; row += 1) {
        for (let col = startCol; col <= endCol; col += 1) {
          deps.add(`${id}:${row}:${col}`);
        }
      }
    } else {
      wide = true;
      if (originInRange) deps.add(originKey);
    }
  };

  const addCellRange = (a: Ref, b: Ref) => {
    if (a.sheet != null && b.sheet != null && a.sheet !== b.sheet) return;
    const id = resolveSheet(a.sheet);
    if (id == null) return;
    const r1 = rowIndex(a.digits);
    const r2 = rowIndex(b.digits);
    const c1 = a.letters ? columnIndex(a.letters) : -1;
    const c2 = b.letters ? columnIndex(b.letters) : -1;
    let startRow = Math.min(r1, r2);
    let endRow = Math.max(r1, r2);
    let startCol = Math.min(c1, c2);
    let endCol = Math.max(c1, c2);
    const emptyRow = startRow === -1 || endRow === -1;
    const emptyCol = startCol === -1 || endCol === -1;
    if (emptyRow && emptyCol) return;
    if (emptyRow || emptyCol) {
      // Whole row or column: sized by the target tab's grid, as execfunction
      // does. A tab with no grid yet is not hydrated for this.
      const data = ctx.luckysheetfile.find((file) => file.id === id)?.data;
      if (!data?.length || (emptyCol && !data[0])) {
        wide = true;
        return;
      }
      if (emptyRow) {
        startRow = 0;
        endRow = data.length;
      }
      if (emptyCol) {
        startCol = 0;
        endCol = data[0].length;
      }
    }
    addRange(id, startRow, endRow, startCol, endCol);
  };

  const addName = (name: string) => {
    const dn = resolveDefinedNameForFormula(ctx.definedNames, name, sheetId);
    if (!dn) return;
    addRange(
      dn.sheetId,
      dn.range.row[0],
      dn.range.row[1],
      dn.range.column[0],
      dn.range.column[1],
    );
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      i += 1;
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '#') {
      const e = ERROR_TOKEN.exec(s.slice(i, i + 32));
      i += e ? e[0].length : 1;
      continue;
    }
    if (ch === '[') {
      const close = s.lastIndexOf(']');
      i = close > i ? close + 1 : i + 1;
      continue;
    }
    const startsToken =
      /[A-Za-z0-9_$.']/.test(ch) && (ch === "'" || isBoundary(s, i));
    if (!startsToken) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      // A number, unless it is the row part of `1:3`.
      const numRef = matchRef(s, i, oddNames);
      const isRowRange =
        numRef != null &&
        !numRef.letters &&
        /^\s*:/.test(s.slice(numRef.end, numRef.end + 8));
      if (!isRowRange) {
        const n = NUMBER.exec(s.slice(i, i + 40));
        i += n ? n[0].length : 1;
        continue;
      }
    }
    const prefix = matchPrefix(s, i, oddNames);
    if (!prefix && ch === "'") {
      // A single-quoted string, not a tab name.
      const close = s.indexOf("'", i + 1);
      i = close === -1 ? s.length : close + 1;
      continue;
    }
    if (!prefix) {
      const fn = FUNCTION_NAME.exec(s.slice(i, i + 64));
      if (fn) {
        i += fn[0].length;
        continue;
      }
      const ident = IDENTIFIER.exec(s.slice(i, i + 64));
      if (ident && !/^[A-Za-z]+[0-9]*$/.test(ident[0])) {
        // Letters, digits and underscores that are not a cell: a name.
        addName(ident[0]);
        i += ident[0].length;
        continue;
      }
    }
    const ref = matchRef(s, i, oddNames);
    if (!ref) {
      i += 1;
      continue;
    }
    const after = /^\s*:\s*/.exec(s.slice(ref.end, ref.end + 64));
    if (after) {
      const second = matchRef(s, ref.end + after[0].length, oddNames);
      if (second) {
        addCellRange(ref, second);
        i = second.end;
        continue;
      }
    }
    if (ref.letters && ref.digits) {
      const row = rowIndex(ref.digits);
      if (row === -1) {
        addName(`${ref.letters}${ref.digits}`);
      } else {
        const id = resolveSheet(ref.sheet);
        if (id != null) deps.add(`${id}:${row}:${columnIndex(ref.letters)}`);
      }
    } else if (ref.letters) {
      addName(ref.letters);
    }
    i = ref.end;
  }
  return { deps, wide };
}
