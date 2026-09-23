/**
 * Helpers for sheet-qualified references in formulas (`Sheet1!A1`,
 * `'Finance - 1'!A1`, `'It''s'!A1`).
 *
 * Like Google Sheets / Excel, a sheet name can only appear bare when it is a
 * plain identifier. Anything else (spaces, `-`, punctuation, a leading digit,
 * a name that looks like a cell such as `A1`, non-Latin scripts) must be
 * wrapped in single quotes, with embedded `'` doubled.
 */

// Mirrors `simpleSheetName` in the formula-parser lexer, minus a leading digit.
const BARE_SHEET_NAME = /^[A-Za-z_\u00C0-\u02AF][A-Za-z0-9_\u00C0-\u02AF]*$/;
// Bare names the parser would read as something else.
const LOOKS_LIKE_CELL = /^[A-Za-z]{1,3}[0-9]+$/;
const LOOKS_LIKE_R1C1 = /^[Rr][0-9]*[Cc][0-9]*$/;
const RESERVED = /^(TRUE|FALSE)$/i;

export function sheetNameNeedsQuotes(name: string): boolean {
  return (
    !BARE_SHEET_NAME.test(name) ||
    LOOKS_LIKE_CELL.test(name) ||
    LOOKS_LIKE_R1C1.test(name) ||
    RESERVED.test(name)
  );
}

/** `Sheet1` -> `Sheet1`, `Finance - 1` -> `'Finance - 1'`, `It's` -> `'It''s'`. */
export function formatSheetNameForFormula(name: string): string {
  if (!sheetNameNeedsQuotes(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

// A sheet name directly after one of these characters is the start of a
// reference, not the tail of another token.
const IDENT_CHAR = /[A-Za-z0-9_.$\u00C0-\u02AF]/;

/**
 * Wraps bare references to existing sheets whose names need quoting, e.g.
 * `=SUM(Sheet-4!H6,B2:C2)` -> `=SUM('Sheet-4'!H6,B2:C2)`.
 *
 * Only exact (case-insensitive) matches of an existing sheet name immediately
 * followed by `!` are rewritten; text inside "strings" and already-quoted
 * '...' names is left untouched.
 */
export function quoteSheetNamesInFormula(
  formula: string,
  sheetNames: string[],
): string {
  if (!formula || !formula.startsWith('=') || formula.indexOf('!') === -1) {
    return formula;
  }
  const candidates = sheetNames
    .filter((n) => !!n && sheetNameNeedsQuotes(n))
    .sort((a, b) => b.length - a.length)
    .map((n) => ({ name: n, lower: `${n.toLowerCase()}!` }));
  if (candidates.length === 0) return formula;

  const lowerFormula = formula.toLowerCase();
  let out = '';
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    // Skip "string literals" ("" is an escaped quote).
    if (ch === '"') {
      let j = i + 1;
      while (j < formula.length) {
        if (formula[j] === '"') {
          if (formula[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // Skip already-quoted 'sheet names' ('' is an escaped quote).
    if (ch === "'") {
      let j = i + 1;
      while (j < formula.length) {
        if (formula[j] === "'") {
          if (formula[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const prev = i > 0 ? formula[i - 1] : '';
    if (i > 0 && !IDENT_CHAR.test(prev)) {
      const hit = candidates.find((cand) =>
        lowerFormula.startsWith(cand.lower, i),
      );
      if (hit) {
        out += `${formatSheetNameForFormula(hit.name)}!`;
        i += hit.lower.length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}
