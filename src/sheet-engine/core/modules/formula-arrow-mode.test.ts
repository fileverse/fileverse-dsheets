import { describe, expect, it } from 'vitest';
import {
  FormulaArrowMode,
  FormulaArrowOverride,
  getCaretContext,
  isOperandSlot,
  isTextChangingKeyCode,
  overrideAfterF2,
  resolveArrowMode,
  tokenizeFormula,
} from './formula-arrow-mode';

/** `|` marks the caret in the fixture string. */
function resolveAt(
  fixture: string,
  opts: {
    override?: FormulaArrowOverride;
    autoAllowed?: boolean;
    refActive?: boolean;
    editing?: boolean;
  } = {},
): FormulaArrowMode {
  const caretOffset = fixture.indexOf('|');
  const text = fixture.replace('|', '');
  return resolveArrowMode({
    editing: opts.editing ?? true,
    text,
    caretOffset,
    override: opts.override ?? null,
    autoAllowed: opts.autoAllowed ?? true,
    refActive: opts.refActive ?? false,
  });
}

function kinds(text: string) {
  return tokenizeFormula(text)
    .filter((t) => t.kind !== 'SPACE')
    .map((t) => `${t.kind}:${t.text}`);
}

describe('tokenizeFormula', () => {
  it('splits a function call', () => {
    expect(kinds('=SUM(A1:A5,B2)')).toEqual([
      'EQ:=',
      'FUNC_NAME:SUM',
      'LPAREN:(',
      'REF:A1:A5',
      'COMMA:,',
      'REF:B2',
      'RPAREN:)',
    ]);
  });

  it('keeps two-char comparison operators whole', () => {
    expect(kinds('=A1>=5')).toEqual([
      'EQ:=',
      'REF:A1',
      'OPERATOR:>=',
      'NUMBER:5',
    ]);
    expect(kinds('=A1<>B1')).toEqual([
      'EQ:=',
      'REF:A1',
      'OPERATOR:<>',
      'REF:B1',
    ]);
  });

  it('treats strings as one token, with "" escapes', () => {
    expect(kinds('="a,(b"')).toEqual(['EQ:=', 'STRING:"a,(b"']);
    expect(kinds('="say ""hi"""')).toEqual(['EQ:=', 'STRING:"say ""hi"""']);
  });

  it('marks an unterminated string', () => {
    const [, str] = tokenizeFormula('="abc');
    expect(str.kind).toBe('STRING');
    expect(str.terminated).toBe(false);
  });

  it('reads sheet-qualified and quoted-sheet references as one REF', () => {
    expect(kinds('=Sheet2!A1')).toEqual(['EQ:=', 'REF:Sheet2!A1']);
    expect(kinds("='My Sheet'!A1:B2")).toEqual([
      'EQ:=',
      "REF:'My Sheet'!A1:B2",
    ]);
    expect(kinds("='It''s Q1'!A1")).toEqual(['EQ:=', "REF:'It''s Q1'!A1"]);
  });

  it('reads whole-column, whole-row and absolute references', () => {
    expect(kinds('=A:A')).toEqual(['EQ:=', 'REF:A:A']);
    expect(kinds('=1:1')).toEqual(['EQ:=', 'REF:1:1']);
    expect(kinds('=$A$1')).toEqual(['EQ:=', 'REF:$A$1']);
  });

  it('flags incomplete ranges as partial refs', () => {
    const [, a] = tokenizeFormula('=A1:A');
    const [, b] = tokenizeFormula('=A1:');
    expect(a).toMatchObject({ kind: 'REF', partial: true });
    expect(b).toMatchObject({ kind: 'REF', partial: true });
  });

  it('classifies postfix percent, numbers and bare names', () => {
    expect(kinds('=50%')).toEqual(['EQ:=', 'NUMBER:50', 'POSTFIX:%']);
    expect(kinds('=1.5')).toEqual(['EQ:=', 'NUMBER:1.5']);
    expect(kinds('=TRUE')).toEqual(['EQ:=', 'NAME:TRUE']);
  });

  it('never throws on junk and covers every char', () => {
    const junk = '=SUM((("x, \'y A1:: !! {}] @#';
    const toks = tokenizeFormula(junk);
    expect(toks.map((t) => t.text).join('')).toBe(junk);
  });

  it('handles empty input', () => {
    expect(tokenizeFormula('')).toEqual([]);
    expect(kinds('=')).toEqual(['EQ:=']);
  });
});

describe('getCaretContext', () => {
  const ctxAt = (fixture: string) => {
    const caret = fixture.indexOf('|');
    return getCaretContext(tokenizeFormula(fixture.replace('|', '')), caret);
  };

  it('detects the caret inside a string, but not at its edges', () => {
    expect(ctxAt('="He|llo"').inString).toBe(true);
    expect(ctxAt('="|Hello"').inString).toBe(true);
    expect(ctxAt('=|"Hello"').inString).toBe(false);
    expect(ctxAt('="Hello"|').inString).toBe(false);
  });

  it('treats the end of an unterminated string as inside it', () => {
    expect(ctxAt('="Hel|').inString).toBe(true);
  });

  it('detects the caret strictly inside a token', () => {
    expect(ctxAt('=SUM(A|1)').insideToken?.text).toBe('A1');
    expect(ctxAt('=SU|M(A1)').insideToken?.text).toBe('SUM');
    expect(ctxAt('=SUM(|A1)').insideToken).toBeNull();
    expect(ctxAt('=SUM(A1|)').insideToken).toBeNull();
  });

  it('reports the reference the caret touches', () => {
    expect(ctxAt('=SUM(A1|)').touchingRef?.text).toBe('A1');
    expect(ctxAt('=SUM(|A1)').touchingRef?.text).toBe('A1');
    expect(ctxAt('=SUM(A|1)').touchingRef?.text).toBe('A1');
    expect(ctxAt('=SUM(|)').touchingRef).toBeNull();
  });

  it('computes paren depth before the caret', () => {
    expect(ctxAt('=|').parenDepth).toBe(0);
    expect(ctxAt('=SUM(|').parenDepth).toBe(1);
    expect(ctxAt('=SUM((A1+|').parenDepth).toBe(2);
    expect(ctxAt('=SUM((A1+B1)|').parenDepth).toBe(1);
    expect(ctxAt('=SUM(A1)|)').parenDepth).toBe(0);
  });

  it('skips spaces when finding neighbours', () => {
    const ctx = ctxAt('=A1 + | B1');
    expect(ctx.prevSig?.text).toBe('+');
    expect(ctx.nextSig?.text).toBe('B1');
  });
});

describe('isOperandSlot', () => {
  const slot = (fixture: string) => {
    const caret = fixture.indexOf('|');
    return isOperandSlot(
      getCaretContext(tokenizeFormula(fixture.replace('|', '')), caret),
    );
  };

  it.each([
    '=|',
    '=SUM(|',
    '=A1+|',
    '=A1-|',
    '=A1*|',
    '=A1/|',
    '=IF(A1>5,|',
    '=SUM(A1,|',
    '=SUM(A1)+|',
    '=IF(SUM(A1),|',
    '=A1>=|',
    '=A1&|',
    '=SUM(|)',
    '=SUM(|,B1)',
    '=|+B1',
    '=SUM((|',
    '=SUM((A1+|',
  ])('slot: %s', (f) => expect(slot(f)).toBe(true));

  it.each([
    '=SUM(A1:A5)|',
    '=A1|+B1',
    '=SUM(A|1)',
    '="Hello|"',
    '="a,|"',
    '="a(|"',
    '="a+|"',
    '=SUM|',
    '=50%|',
    "='My Sheet'!A1|",
    '=A1:|',
    '=SUM(|A1)',
    '=A1+|B1',
    '=SUM((A1+B1)|)',
    '=SUM(A1)|+B1',
    '=SUM(A1|)',
    '=A1|',
  ])('not a slot: %s', (f) => expect(slot(f)).toBe(false));
});

describe('resolveArrowMode priority', () => {
  it('1: not editing -> GRID', () => {
    expect(resolveAt('=|', { editing: false })).toBe('GRID');
    expect(
      resolveAt('=|', {
        editing: false,
        override: 'REFERENCE',
        refActive: true,
      }),
    ).toBe('GRID');
  });

  it('2: non-formula value -> TEXT_EDIT even with override/active', () => {
    expect(resolveAt('hello|')).toBe('TEXT_EDIT');
    expect(resolveAt('12+|')).toBe('TEXT_EDIT');
    expect(resolveAt('hel|', { override: 'REFERENCE', refActive: true })).toBe(
      'TEXT_EDIT',
    );
  });

  it('3: explicit TEXT_EDIT beats an active reference and a slot', () => {
    expect(resolveAt('=|', { override: 'TEXT_EDIT' })).toBe('TEXT_EDIT');
    expect(resolveAt('=A1|', { override: 'TEXT_EDIT', refActive: true })).toBe(
      'TEXT_EDIT',
    );
  });

  it('4: active reference beats everything below it', () => {
    expect(resolveAt('=A1|', { refActive: true })).toBe('REFERENCE_ACTIVE');
    expect(resolveAt('=A1|', { refActive: true, autoAllowed: false })).toBe(
      'REFERENCE_ACTIVE',
    );
    expect(resolveAt('=A1|', { refActive: true, override: 'REFERENCE' })).toBe(
      'REFERENCE_ACTIVE',
    );
  });

  it('5: explicit reference mode', () => {
    expect(resolveAt('=|', { override: 'REFERENCE', autoAllowed: false })).toBe(
      'REFERENCE_READY',
    );
    // on an existing reference: arrows may replace it
    expect(
      resolveAt('=SUM(A1|)', { override: 'REFERENCE', autoAllowed: false }),
    ).toBe('REFERENCE_READY');
    // nowhere sensible: fall back to caret
    expect(
      resolveAt('=SUM(A1)|', { override: 'REFERENCE', autoAllowed: false }),
    ).toBe('TEXT_EDIT');
    // strings always keep the caret
    expect(
      resolveAt('="a,|"', { override: 'REFERENCE', autoAllowed: false }),
    ).toBe('TEXT_EDIT');
  });

  it('6: automatic selection needs autoAllowed', () => {
    expect(resolveAt('=SUM(|')).toBe('REFERENCE_READY');
    expect(resolveAt('=SUM(|', { autoAllowed: false })).toBe('TEXT_EDIT');
  });

  it('7: default is TEXT_EDIT', () => {
    expect(resolveAt('=SUM(A1:A5)|')).toBe('TEXT_EDIT');
  });

  it('returns TEXT_EDIT when the caret is not in the editor', () => {
    expect(
      resolveArrowMode({
        editing: true,
        text: '=SUM(',
        caretOffset: null,
        override: null,
        autoAllowed: true,
        refActive: false,
      }),
    ).toBe('TEXT_EDIT');
  });
});

describe('Rule 6: existing references are not changed accidentally', () => {
  const formula = '=SUM(A1:A10)+B5';

  it('F2/dblclick session stays TEXT_EDIT at every caret position', () => {
    for (let caret = 0; caret <= formula.length; caret += 1) {
      const mode = resolveArrowMode({
        editing: true,
        text: formula,
        caretOffset: caret,
        override: null,
        autoAllowed: false,
        refActive: false,
      });
      expect(mode, `caret ${caret}`).toBe('TEXT_EDIT');
    }
  });

  it('even right after the existing reference, caret stays text', () => {
    expect(resolveAt('=SUM(A1:A10)+B5|', { autoAllowed: false })).toBe(
      'TEXT_EDIT',
    );
    expect(resolveAt('=SUM(A1:A10)+|B5', { autoAllowed: false })).toBe(
      'TEXT_EDIT',
    );
  });

  it('a reference is only selectable after explicit activation', () => {
    expect(
      resolveAt('=SUM(A1:A10)+B5|', {
        autoAllowed: false,
        override: 'REFERENCE',
      }),
    ).toBe('REFERENCE_READY');
  });
});

describe('F2 toggle', () => {
  it('caret -> reference, reference -> caret', () => {
    expect(overrideAfterF2('TEXT_EDIT')).toBe('REFERENCE');
    expect(overrideAfterF2('REFERENCE_READY')).toBe('TEXT_EDIT');
    expect(overrideAfterF2('REFERENCE_ACTIVE')).toBe('TEXT_EDIT');
  });

  it('does nothing outside editing', () => {
    expect(overrideAfterF2('GRID')).toBeNull();
  });

  it('is sticky across caret moves until toggled again', () => {
    const first = overrideAfterF2('TEXT_EDIT');
    expect(resolveAt('=SUM(|', { override: first, autoAllowed: false })).toBe(
      'REFERENCE_READY',
    );
    expect(resolveAt('=SUM(1,|', { override: first, autoAllowed: false })).toBe(
      'REFERENCE_READY',
    );
    const second = overrideAfterF2('REFERENCE_READY');
    expect(resolveAt('=SUM(1,|', { override: second })).toBe('TEXT_EDIT');
  });
});

describe('Rule 4 transitions derive from caret position', () => {
  it('operator or comma after a reference -> READY', () => {
    expect(resolveAt('=B4+|')).toBe('REFERENCE_READY');
    expect(resolveAt('=SUM(B4,|')).toBe('REFERENCE_READY');
  });

  it('closing paren after a reference -> TEXT_EDIT', () => {
    expect(resolveAt('=SUM(B4)|')).toBe('TEXT_EDIT');
  });

  it('plain text after a reference -> TEXT_EDIT', () => {
    expect(resolveAt('=B4x|')).toBe('TEXT_EDIT');
  });
});

describe('isTextChangingKeyCode', () => {
  it.each([8, 32, 46, 48, 57, 65, 90, 106, 107, 109, 111, 187, 188, 189, 191])(
    'key %i changes text',
    (k) => expect(isTextChangingKeyCode(k)).toBe(true),
  );
  it.each([13, 16, 17, 27, 37, 38, 39, 40, 112, 113])(
    'key %i does not change text',
    (k) => expect(isTextChangingKeyCode(k)).toBe(false),
  );
});
