/**
 * Pure (DOM-free, ctx-free) logic that decides what an arrow key does while a
 * formula is being edited. See docs/formula-arrow-key-spec.md.
 *
 * GRID             - not editing: arrows move the grid selection
 * TEXT_EDIT        - arrows move the text caret
 * REFERENCE_READY  - next arrow inserts a new cell reference at the caret
 * REFERENCE_ACTIVE - arrows move/extend the reference that was just inserted
 */

export type FormulaArrowMode =
  | 'GRID'
  | 'TEXT_EDIT'
  | 'REFERENCE_READY'
  | 'REFERENCE_ACTIVE';

/** Sticky, user-controlled (F2). `null` = automatic behavior. */
export type FormulaArrowOverride = null | 'TEXT_EDIT' | 'REFERENCE';

export type TokenKind =
  | 'EQ'
  | 'SPACE'
  | 'STRING'
  | 'REF'
  | 'NAME'
  | 'NUMBER'
  | 'FUNC_NAME'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'OPERATOR'
  | 'POSTFIX'
  | 'UNKNOWN';

export type Token = {
  kind: TokenKind;
  start: number;
  end: number;
  text: string;
  /** STRING / quoted sheet name: closing quote present. */
  terminated?: boolean;
  /** REF that is not (yet) a complete reference, e.g. `A1:A`, `A1:`. */
  partial?: boolean;
};

const TWO_CHAR_OPERATORS = ['>=', '<=', '<>', '==', '!='];
const ONE_CHAR_OPERATORS = '+-*/^&=<>';
const RUN_CHAR = /[\p{L}\p{N}_$.:!]/u;

const SHEET_PREFIX = '(?:[\\p{L}\\p{N}_.]+!)?';
const CELL = '\\$?[A-Za-z]{1,3}\\$?\\d+';
const COL = '\\$?[A-Za-z]{1,3}';
const ROW = '\\$?\\d+';
const REF_BODY = `(?:${CELL}(?::${CELL})?|${COL}:${COL}|${ROW}:${ROW})`;
const REF_RE = new RegExp(`^${SHEET_PREFIX}${REF_BODY}$`, 'u');
const REF_BODY_RE = new RegExp(`^${REF_BODY}$`, 'u');
const NUMBER_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const FUNC_NAME_RE = /^[\p{L}_][\p{L}\p{N}_.]*$/u;

function scanQuoted(
  text: string,
  start: number,
  quote: string,
): { end: number; terminated: boolean } {
  let j = start + 1;
  while (j < text.length) {
    if (text[j] === quote) {
      if (text[j + 1] === quote) {
        j += 2;
        continue;
      }
      return { end: j + 1, terminated: true };
    }
    j += 1;
  }
  return { end: text.length, terminated: false };
}

/** Never throws. Offsets index into `text` as given. */
export function tokenizeFormula(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  let seenFirstSignificant = false;

  const push = (t: Token) => {
    tokens.push(t);
    if (t.kind !== 'SPACE') seenFirstSignificant = true;
  };

  while (i < n) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j += 1;
      push({ kind: 'SPACE', start: i, end: j, text: text.slice(i, j) });
      i = j;
    } else if (ch === '"') {
      const { end, terminated } = scanQuoted(text, i, '"');
      push({
        kind: 'STRING',
        start: i,
        end,
        text: text.slice(i, end),
        terminated,
      });
      i = end;
    } else if (ch === "'") {
      const { end, terminated } = scanQuoted(text, i, "'");
      let tokEnd = end;
      let kind: TokenKind = 'NAME';
      let partial = false;
      if (terminated && text[end] === '!') {
        let k = end + 1;
        while (k < n && /[A-Za-z0-9$:]/.test(text[k])) k += 1;
        tokEnd = k;
        kind = 'REF';
        partial = !REF_BODY_RE.test(text.slice(end + 1, k));
      }
      push({
        kind,
        start: i,
        end: tokEnd,
        text: text.slice(i, tokEnd),
        terminated,
        ...(kind === 'REF' ? { partial } : {}),
      });
      i = tokEnd;
    } else if (ch === '(') {
      push({ kind: 'LPAREN', start: i, end: i + 1, text: ch });
      i += 1;
    } else if (ch === ')') {
      push({ kind: 'RPAREN', start: i, end: i + 1, text: ch });
      i += 1;
    } else if (ch === ',' || ch === ';') {
      push({ kind: 'COMMA', start: i, end: i + 1, text: ch });
      i += 1;
    } else if (ch === '%') {
      push({ kind: 'POSTFIX', start: i, end: i + 1, text: ch });
      i += 1;
    } else if (
      ch === '=' &&
      !seenFirstSignificant &&
      !TWO_CHAR_OPERATORS.includes(text.slice(i, i + 2))
    ) {
      push({ kind: 'EQ', start: i, end: i + 1, text: ch });
      i += 1;
    } else if (TWO_CHAR_OPERATORS.includes(text.slice(i, i + 2))) {
      push({
        kind: 'OPERATOR',
        start: i,
        end: i + 2,
        text: text.slice(i, i + 2),
      });
      i += 2;
    } else if (ONE_CHAR_OPERATORS.includes(ch)) {
      push({ kind: 'OPERATOR', start: i, end: i + 1, text: ch });
      i += 1;
    } else if (RUN_CHAR.test(ch)) {
      let j = i + 1;
      while (j < n && RUN_CHAR.test(text[j])) j += 1;
      const run = text.slice(i, j);
      let kind: TokenKind;
      let partial: boolean | undefined;
      if (text[j] === '(' && FUNC_NAME_RE.test(run)) {
        kind = 'FUNC_NAME';
      } else if (REF_RE.test(run)) {
        kind = 'REF';
        partial = false;
      } else if (NUMBER_RE.test(run)) {
        kind = 'NUMBER';
      } else if (run.includes(':') || run.includes('!')) {
        kind = 'REF';
        partial = true;
      } else {
        kind = 'NAME';
      }
      push({
        kind,
        start: i,
        end: j,
        text: run,
        ...(partial === undefined ? {} : { partial }),
      });
      i = j;
    } else {
      push({ kind: 'UNKNOWN', start: i, end: i + 1, text: ch });
      i += 1;
    }
  }
  return tokens;
}

export type CaretContext = {
  inString: boolean;
  /** Caret strictly inside a non-string token (e.g. `A|1`, `SU|M(`). */
  insideToken: Token | null;
  /** REF token the caret is inside or right after (start < caret <= end). */
  touchingRef: Token | null;
  prevSig: Token | null;
  nextSig: Token | null;
  parenDepth: number;
};

export function getCaretContext(tokens: Token[], caret: number): CaretContext {
  let inString = false;
  let insideToken: Token | null = null;
  let touchingRef: Token | null = null;
  let prevSig: Token | null = null;
  let nextSig: Token | null = null;
  let parenDepth = 0;

  tokens.forEach((t) => {
    if (t.kind === 'STRING') {
      const strictlyInside = t.start < caret && caret < t.end;
      const atOpenEnd = caret === t.end && t.terminated === false;
      if (strictlyInside || atOpenEnd) inString = true;
    } else if (
      t.kind !== 'SPACE' &&
      t.kind !== 'LPAREN' &&
      t.kind !== 'RPAREN' &&
      t.kind !== 'COMMA' &&
      t.kind !== 'OPERATOR' &&
      t.start < caret &&
      caret < t.end
    ) {
      insideToken = t;
    }
    // `start < caret`: a caret at the very start of a reference is *before* it.
    // Treating it as touching made the arrow insert next to the reference
    // instead of replacing it (`=SUM(│A1)` -> `=SUM(D6A1)`).
    if (t.kind === 'REF' && t.start < caret && caret <= t.end) {
      touchingRef = t;
    }
    if (t.kind === 'SPACE') return;
    if (t.end <= caret) {
      prevSig = t;
      if (t.kind === 'LPAREN') parenDepth += 1;
      if (t.kind === 'RPAREN') parenDepth = Math.max(0, parenDepth - 1);
    } else if (t.start >= caret && nextSig === null) {
      nextSig = t;
    }
  });

  return { inString, insideToken, touchingRef, prevSig, nextSig, parenDepth };
}

const OPERAND_EXPECTING: ReadonlySet<TokenKind> = new Set([
  'EQ',
  'LPAREN',
  'COMMA',
  'OPERATOR',
]);

const OPERAND_LIKE: ReadonlySet<TokenKind> = new Set([
  'REF',
  'NAME',
  'NUMBER',
  'STRING',
  'FUNC_NAME',
  'LPAREN',
]);

/**
 * True when a new operand (cell reference) can be entered at the caret:
 * the previous significant token wants an operand, the caret is not inside a
 * string or token, and no operand sits immediately to the right.
 */
export function isOperandSlot(ctx: CaretContext): boolean {
  if (ctx.inString || ctx.insideToken) return false;
  if (!ctx.prevSig || !OPERAND_EXPECTING.has(ctx.prevSig.kind)) return false;
  if (ctx.nextSig && OPERAND_LIKE.has(ctx.nextSig.kind)) return false;
  // A `+` / `-` right of the caret after a token that wants an operand is a
  // unary sign (`D11/│-F11`, `=│-A1`): it already occupies the operand slot,
  // so inserting a reference there would silently rewrite the formula.
  if (
    ctx.nextSig &&
    ctx.nextSig.kind === 'OPERATOR' &&
    (ctx.nextSig.text === '+' || ctx.nextSig.text === '-')
  ) {
    return false;
  }
  return true;
}

export type ArrowModeInput = {
  editing: boolean;
  /** Full editor text (offsets of `caretOffset` index into it). */
  text: string;
  /** null when the caret is not inside the editor. */
  caretOffset: number | null;
  override: FormulaArrowOverride;
  /** false for sessions opened on an existing formula (F2 / dblclick / bar). */
  autoAllowed: boolean;
  /**
   * The engine is driving a reference right now (mouse drag, or a reference the
   * keyboard just inserted and the caret is still on).
   */
  refActive: boolean;
};

/** Decision priority from the product spec, evaluated in this exact order. */
export function resolveArrowMode(input: ArrowModeInput): FormulaArrowMode {
  // 1
  if (!input.editing) return 'GRID';
  // 2
  if (!input.text.trim().startsWith('=')) return 'TEXT_EDIT';
  // 3
  if (input.override === 'TEXT_EDIT') return 'TEXT_EDIT';
  // 4
  if (input.refActive) return 'REFERENCE_ACTIVE';

  if (input.caretOffset === null) return 'TEXT_EDIT';
  const ctx = getCaretContext(tokenizeFormula(input.text), input.caretOffset);
  // Strings are never a reference slot, even under an explicit override.
  if (ctx.inString) return 'TEXT_EDIT';

  // 5
  if (input.override === 'REFERENCE') {
    return isOperandSlot(ctx) || ctx.touchingRef
      ? 'REFERENCE_READY'
      : 'TEXT_EDIT';
  }
  // 6
  if (input.autoAllowed && isOperandSlot(ctx)) return 'REFERENCE_READY';
  // 7
  return 'TEXT_EDIT';
}

/** F2 while editing a formula: flip between caret and reference selection. */
export function overrideAfterF2(mode: FormulaArrowMode): FormulaArrowOverride {
  if (mode === 'TEXT_EDIT') return 'REFERENCE';
  if (mode === 'REFERENCE_READY' || mode === 'REFERENCE_ACTIVE') {
    return 'TEXT_EDIT';
  }
  return null;
}

/**
 * Rule 4: keys typed while a reference is active end the arrow-driven
 * reference. The next mode is then derived from the caret position
 * (operator or `,` -> READY, `)` or anything else -> TEXT_EDIT).
 * keyCode based because it is called from keyup/keydown handlers.
 */
export function isTextChangingKeyCode(kcode: number): boolean {
  return (
    kcode === 8 ||
    kcode === 32 ||
    kcode === 46 ||
    (kcode >= 48 && kcode <= 57) ||
    (kcode >= 65 && kcode <= 90) ||
    (kcode >= 96 && kcode <= 111) ||
    (kcode >= 186 && kcode <= 222)
  );
}
