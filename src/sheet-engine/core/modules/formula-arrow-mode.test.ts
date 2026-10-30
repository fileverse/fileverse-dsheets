import { describe, expect, it } from 'vitest';
import {
  FormulaArrowMode,
  FormulaArrowOverride,
  getCaretContext,
  isOperandSlot,
  isReferenceDirtyingKeyCode,
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
    // start edge is *before* the reference, not on it
    expect(ctxAt('=SUM(|A1)').touchingRef).toBeNull();
    expect(ctxAt('=SUM(A|1)').touchingRef?.text).toBe('A1');
    expect(ctxAt('=SUM(|)').touchingRef).toBeNull();
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
    // unary sign already occupies the operand slot
    '=|+B1',
    '=|-A1',
    '=SUM(|-A1)',
    '=A1*|-1',
    '=IF(A1>0,|-1,1)',
    '=A1+|-B1',
    '=A1-|+B1',
    '=if(D11<>"", if(F11<>"", D11/|-F11,""),"")',
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

describe('F2 toggles the stored override', () => {
  it('a second press always undoes the first, even where the mode cannot change', () => {
    const caretText = '=SUM(A1)|';
    const shown1 = resolveAt(caretText);
    expect(shown1).toBe('TEXT_EDIT');
    const first = overrideAfterF2(shown1, null);
    expect(first).toBe('REFERENCE');

    // reference override has no effect after `)`: still TEXT_EDIT on screen
    const shown2 = resolveAt(caretText, { override: first });
    expect(shown2).toBe('TEXT_EDIT');
    const second = overrideAfterF2(shown2, first);
    expect(second).toBe('TEXT_EDIT');

    // walking the caret onto A1 must not capture the arrow
    expect(resolveAt('=SUM(A1|)', { override: second })).toBe('TEXT_EDIT');
  });

  it('with no stored override it flips what the user is looking at', () => {
    expect(overrideAfterF2('REFERENCE_READY', null)).toBe('TEXT_EDIT');
    expect(overrideAfterF2('REFERENCE_ACTIVE', null)).toBe('TEXT_EDIT');
    expect(overrideAfterF2('TEXT_EDIT', null)).toBe('REFERENCE');
  });

  it('with a stored override it flips the stored value', () => {
    // auto READY on screen, but a stored REFERENCE must still toggle off
    expect(overrideAfterF2('REFERENCE_READY', 'REFERENCE')).toBe('TEXT_EDIT');
    expect(overrideAfterF2('TEXT_EDIT', 'TEXT_EDIT')).toBe('REFERENCE');
  });

  it('is ignored outside editing', () => {
    expect(overrideAfterF2('GRID', 'REFERENCE')).toBeNull();
  });
});

describe('scientific notation', () => {
  it('reads the exponent sign and digits as part of the number', () => {
    expect(kinds('=1E+5')).toEqual(['EQ:=', 'NUMBER:1E+5']);
    expect(kinds('=2.5e-3*A1')).toEqual([
      'EQ:=',
      'NUMBER:2.5e-3',
      'OPERATOR:*',
      'REF:A1',
    ]);
    expect(kinds('=1E5')).toEqual(['EQ:=', 'NUMBER:1E5']);
  });

  it('keeps an unfinished exponent as one number token', () => {
    expect(kinds('=1E+')).toEqual(['EQ:=', 'NUMBER:1E+']);
    expect(kinds('=A1*1E-')).toEqual([
      'EQ:=',
      'REF:A1',
      'OPERATOR:*',
      'NUMBER:1E-',
    ]);
  });

  it('does not offer a reference slot inside an unfinished exponent', () => {
    expect(resolveAt('=1E+|')).toBe('TEXT_EDIT');
    expect(resolveAt('=A1*1E-|')).toBe('TEXT_EDIT');
    expect(resolveAt('=1.5E+3|')).toBe('TEXT_EDIT');
    expect(resolveAt('=1E5|')).toBe('TEXT_EDIT');
  });

  it('a real operator after the number is still a slot', () => {
    expect(resolveAt('=1E5+|')).toBe('REFERENCE_READY');
    expect(resolveAt('=1E+5-|')).toBe('REFERENCE_READY');
  });

  it('does not swallow a sign after an ordinary name or reference', () => {
    expect(kinds('=A1E+1')).toEqual([
      'EQ:=',
      'NAME:A1E',
      'OPERATOR:+',
      'NUMBER:1',
    ]);
    expect(kinds('=B1+2')).toEqual([
      'EQ:=',
      'REF:B1',
      'OPERATOR:+',
      'NUMBER:2',
    ]);
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

describe('unary sign to the right of the caret (TEC-3303)', () => {
  const reporterFormula = '=if(D11<>"", if(F11<>"", D11/-F11,""),"")';

  it('keeps the caret in the reporter formula at every position', () => {
    // position of the caret right after `/` and before `-`
    const caret = reporterFormula.indexOf('/-') + 1;
    const mode = resolveArrowMode({
      editing: true,
      text: reporterFormula,
      caretOffset: caret,
      override: null,
      autoAllowed: true,
      refActive: false,
    });
    expect(mode).toBe('TEXT_EDIT');
  });

  it('is caret-only under the explicit reference override too', () => {
    expect(
      resolveAt('=A1*|-1', { override: 'REFERENCE', autoAllowed: false }),
    ).toBe('TEXT_EDIT');
  });

  it('still picks a reference after the sign has been passed', () => {
    expect(resolveAt('=A1*-|')).toBe('REFERENCE_READY');
    expect(resolveAt('=D11/-|F11')).toBe('TEXT_EDIT');
  });

  it('binary plus/minus before the caret is unaffected', () => {
    expect(resolveAt('=A1-|')).toBe('REFERENCE_READY');
    expect(resolveAt('=A1+|,')).toBe('REFERENCE_READY');
  });

  it('only +/- are treated as unary; other operators keep their slot', () => {
    expect(resolveAt('=SUM(|*2)')).toBe('REFERENCE_READY');
  });
});

describe('F2 override at the edges of a reference', () => {
  const ref = { override: 'REFERENCE' as const, autoAllowed: false };

  it('caret at the start of a reference stays text (no insert next to it)', () => {
    expect(resolveAt('=SUM(|A1)', ref)).toBe('TEXT_EDIT');
    expect(resolveAt('=SUM(|A1:B2)', ref)).toBe('TEXT_EDIT');
    expect(resolveAt("=SUM(|'My Sheet'!A1)", ref)).toBe('TEXT_EDIT');
  });

  it('caret at the end of or inside a reference can replace it', () => {
    expect(resolveAt('=SUM(A1|)', ref)).toBe('REFERENCE_READY');
    expect(resolveAt('=SUM(A1:B2|)', ref)).toBe('REFERENCE_READY');
    expect(resolveAt('=SUM(A|1)', ref)).toBe('REFERENCE_READY');
  });

  it('a slot before a reference does not reopen via the start edge', () => {
    expect(resolveAt('=SUM(A1,|B1)', ref)).toBe('TEXT_EDIT');
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

describe('key classification', () => {
  it('dirtying keys edit characters inside a token', () => {
    [8, 46, 48, 57, 65, 90, 96, 97, 105].forEach((k) =>
      expect(isReferenceDirtyingKeyCode(k), `key ${k}`).toBe(true),
    );
  });

  it('numpad 0 dirties like every other digit', () => {
    expect(isReferenceDirtyingKeyCode(96)).toBe(true);
  });

  it('operators, comma, space, arrows and F-keys do not dirty', () => {
    [
      32, 37, 38, 106, 107, 109, 111, 112, 113, 115, 122, 187, 188, 189, 191,
    ].forEach((k) =>
      expect(isReferenceDirtyingKeyCode(k), `key ${k}`).toBe(false),
    );
  });

  it('every dirtying key also counts as text-changing', () => {
    for (let k = 0; k < 256; k += 1) {
      if (isReferenceDirtyingKeyCode(k)) {
        expect(isTextChangingKeyCode(k), `key ${k}`).toBe(true);
      }
    }
  });
});
