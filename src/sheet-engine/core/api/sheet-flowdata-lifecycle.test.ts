import { describe, expect, it } from 'vitest';
import { collectSheetIdsFromFormulaText } from './sheet-flowdata-lifecycle';

// PR 466 review (#7): the unquoted sheet-name branch allowed `=` and operators,
// so `=A!B5` was read as a reference to a sheet called `=A`.

const ctx: any = {
  luckysheetfile: [
    { id: 'a', name: 'A' },
    { id: 'q', name: 'Q1-2026' },
    { id: 's', name: 'My Sheet' },
  ],
};
const ids = (f: string) => [...collectSheetIdsFromFormulaText(ctx, f)];

describe('collectSheetIdsFromFormulaText', () => {
  it.each([
    ['=A!B5', ['a']],
    ['=2*A!B5', ['a']],
    ['=1+A!B5', ['a']],
    ['=-A!B5', ['a']],
    ['=B1/A!B5', ['a']],
    ['=B1>A!B5', ['a']],
    ['=SUM(A!B5)', ['a']],
    ['=SUM(B1,A!B5)', ['a']],
    ["='A'!B5", ['a']],
    ["='My Sheet'!B5", ['s']],
    ['=Q1-2026!A1', ['q']],
    ['=SUM(A1:A!B3)', ['a']],
    ['=B5', []],
  ])('%s', (formula, expected) => {
    expect(ids(formula)).toEqual(expected);
  });
});
