import { describe, expect, it } from 'vitest';
import type { Context } from '../context';
import { createFilterOptions } from './filter';

function sheetContext() {
  return {
    currentSheetId: 'sheet-1',
    luckysheetfile: [
      { id: 'sheet-1', celldata: [{ r: 0, c: 0, v: { v: 'Name' } }] },
    ],
    visibledatarow: [20, 40, 60],
    visibledatacolumn: [60, 120],
  } as Context;
}

describe('createFilterOptions', () => {
  const valid = { row: [0, 2], column: [0, 1] };

  it.each([
    { row: [0, 2] },
    { column: [0, 1] },
    { row: [0], column: [0, 1] },
    { row: [2, 0], column: [0, 1] },
  ])(
    'skips an invalid saved filter (%j) without changing the sheet',
    (filter) => {
      const ctx = sheetContext();
      const before = structuredClone(ctx.luckysheetfile);
      createFilterOptions(ctx, valid, undefined);
      createFilterOptions(
        ctx,
        filter as typeof valid,
        undefined,
        undefined,
        true,
      );
      expect(ctx.filterOptions).toBeUndefined();
      expect(ctx.luckysheetfile).toEqual(before);
    },
  );

  it('keeps valid filters working', () => {
    const ctx = sheetContext();
    createFilterOptions(ctx, valid, undefined, undefined, true);
    expect(ctx.filterOptions).toMatchObject({
      startRow: 0,
      endRow: 2,
      startCol: 0,
      endCol: 1,
    });
    expect(ctx.filterOptions?.items.map(({ col }) => col)).toEqual([0, 1]);
    expect(ctx.luckysheetfile[0].filter_select).toEqual(valid);
  });
});
