import { describe, expect, it } from 'vitest';
import { functionStrChange } from './formula';

const addRow = (
  txt: string,
  editedTab: string,
  formulaTab: string,
  index = 2,
  step = 1,
) =>
  functionStrChange(txt, 'add', 'row', 'lefttop', index, step, {
    editedTab,
    formulaTab,
  });

const delRow = (txt: string, editedTab: string, formulaTab: string) =>
  functionStrChange(txt, 'del', 'row', null, 2, 1, { editedTab, formulaTab });

const addCol = (txt: string, editedTab: string, formulaTab: string) =>
  functionStrChange(txt, 'add', 'col', 'lefttop', 1, 1, {
    editedTab,
    formulaTab,
  });

describe('functionStrChange only shifts references to the edited tab (B5)', () => {
  it('shifts an unprefixed ref on the edited tab', () => {
    expect(addRow('=B5', 'A', 'A')).toBe('B6');
  });

  it('leaves a ref to another tab unchanged', () => {
    expect(addRow('=C!B5', 'A', 'A')).toBe('C!B5');
  });

  it('leaves an unprefixed ref on a different tab unchanged', () => {
    expect(addRow('=B5', 'A', 'B')).toBe('B5');
  });

  it('shifts a ref prefixed with the edited tab, from another tab', () => {
    expect(addRow('=A!B5', 'A', 'B')).toBe('A!B6');
  });

  it('compares the tab name exactly, case-sensitively', () => {
    // Tab `a` is not tab `A` (the engine resolves names case-sensitively).
    expect(addRow("='a'!B5", 'A', 'B')).toBe("'a'!B5");
    expect(addRow('=A!B5', 'A', 'B')).toBe('A!B6');
  });

  it("unquotes ''-escaped names", () => {
    expect(addRow("='Bob''s Sheet'!B5", "Bob's Sheet", 'B')).toBe(
      "'Bob''s Sheet'!B6",
    );
    expect(addRow("='Bob''s Sheet'!B5", 'A', 'B')).toBe("'Bob''s Sheet'!B5");
  });

  it('shifts both ends of a quoted-prefix range', () => {
    // Index 1 (0-based) so that row 2 and row 9 are both at or after it.
    expect(addRow("='Q1 2026'!B2:B9", 'Q1 2026', 'B', 1)).toBe(
      "'Q1 2026'!B3:B10",
    );
    expect(addRow("='Q1 2026'!B2:B9", 'Other', 'B', 1)).toBe(
      "'Q1 2026'!B2:B9",
    );
    // Index 2: only the end moves (row 2 sits above the insert).
    expect(addRow("='Q1 2026'!B2:B9", 'Q1 2026', 'B')).toBe("'Q1 2026'!B2:B10");
  });

  it('handles a prefixed ref inside a function with mixed refs', () => {
    expect(addRow('=SUM(A!B5,B5)+C!B5', 'A', 'B')).toBe('SUM(A!B6,B5)+C!B5');
    expect(addRow('=SUM(A!B5,B5)+C!B5', 'A', 'A')).toBe('SUM(A!B6,B6)+C!B5');
  });

  it('does not split a quoted tab name containing an operator or comma', () => {
    expect(addRow("=SUM('A-B, 1'!B5)", 'A-B, 1', 'X')).toBe(
      "SUM('A-B, 1'!B6)",
    );
    expect(addRow("='A-B'!B5+B5", 'A-B', 'X')).toBe("'A-B'!B6+B5");
  });

  it('keeps $-absolute markers', () => {
    expect(addRow('=$B$5', 'A', 'A')).toBe('$B$6');
    expect(addRow('=A!$B$5', 'A', 'B')).toBe('A!$B$6');
    expect(addRow('=$B$5', 'A', 'B')).toBe('$B$5');
  });

  it('delete: shifts refs below the deleted row on the edited tab only', () => {
    expect(delRow('=B5', 'A', 'A')).toBe('B4');
    expect(delRow('=B5', 'A', 'B')).toBe('B5');
    expect(delRow('=A!B5', 'A', 'B')).toBe('A!B4');
    expect(delRow('=C!B5', 'A', 'A')).toBe('C!B5');
  });

  it('delete: a ref to the deleted row becomes #REF! only for the edited tab', () => {
    expect(delRow('=B3', 'A', 'A')).toBe('#REF!');
    expect(delRow('=B3', 'A', 'B')).toBe('B3');
    expect(delRow('=C!B3', 'A', 'A')).toBe('C!B3');
  });

  it('columns: insert shifts only refs to the edited tab', () => {
    expect(addCol('=C5', 'A', 'A')).toBe('D5');
    expect(addCol('=C5', 'A', 'B')).toBe('C5');
    expect(addCol('=A!C5', 'A', 'B')).toBe('A!D5');
    expect(addCol('=C!C5', 'A', 'A')).toBe('C!C5');
  });

  it('whole-row and whole-column ranges respect the tab', () => {
    expect(addRow('=A!3:5', 'A', 'B')).toBe('A!4:6');
    expect(addRow('=3:5', 'A', 'B')).toBe('3:5');
    expect(addCol('=A!B:D', 'A', 'B')).toBe('A!C:E');
    expect(addCol('=B:D', 'A', 'B')).toBe('B:D');
  });
});
