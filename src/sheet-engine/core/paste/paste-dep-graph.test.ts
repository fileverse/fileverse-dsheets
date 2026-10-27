/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { pasteHandler, pasteHandlerOfCutPaste } from './paste-internals';

const makeCtx = () => {
  const ctx: any = defaultContext({
    globalCache: { undoList: [], redoList: [] },
    cellInput: { current: null },
    fxInput: { current: null },
    canvas: { current: null },
    cellArea: { current: null },
    workbookContainer: { current: null },
  } as any);
  ctx.luckysheetfile = [
    {
      id: 's1',
      name: 'Sheet1',
      order: 0,
      status: 1,
      data: Array.from({ length: 6 }, () => Array(4).fill(null)),
      config: {},
      calcChain: [],
    },
  ];
  ctx.currentSheetId = 's1';
  ctx.config = ctx.luckysheetfile[0].config;
  ctx.hooks = {};
  ctx.luckysheet_select_save = [
    { row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 },
  ];
  ctx.formulaCache.depGraphComplete = true;
  return ctx;
};

describe('C8 flag after pastes that skip the calc chain', () => {
  beforeAll(() => loadLocale('en'));

  it('an HTML-table paste turns the flag off', () => {
    const ctx = makeCtx();
    try {
      pasteHandler(ctx, [[{ v: 1, m: '1', f: '=1+1' }]]);
    } catch {
      // Only the flag is under test; the paste body needs a full workbook.
    }
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
  });

  it('a cut-paste turns the flag off', () => {
    const ctx = makeCtx();
    try {
      pasteHandlerOfCutPaste(ctx, {
        copyRange: [{ row: [0, 0], column: [0, 0] }],
        dataSheetId: 's1',
        HasMC: false,
        RowlChange: false,
      } as any);
    } catch {
      // Only the flag is under test; the paste body needs a full workbook.
    }
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
  });
});
