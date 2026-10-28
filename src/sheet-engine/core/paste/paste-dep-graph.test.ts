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

  // PR 466 review (#15): only a paste that writes formulas raw clears the flag.
  it('a plain-text paste keeps the flag on', () => {
    const ctx = makeCtx();
    try {
      pasteHandler(ctx, 'hello');
    } catch {
      // The paste body needs a full workbook; only the flag is under test.
    }
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
  });

  it('a paste that is not allowed keeps the flag on', () => {
    const ctx = makeCtx();
    ctx.isFlvReadOnly = true;
    try {
      pasteHandler(ctx, [[{ v: 1, m: '1', f: '=1+1' }]]);
    } catch {
      // As above.
    }
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
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

// PR 466 review (#11): a cut formula keeps its place in the calc chain.
describe('cut-paste moves the calc chain entry', () => {
  const cutPaste = (from: [number, number], to: [number, number]) => {
    const ctx = makeCtx();
    const data = ctx.luckysheetfile[0].data;
    data[0][0] = { v: 5, m: '5' };
    data[from[0]][from[1]] = { v: 10, m: '10', f: '=A1*2' };
    ctx.luckysheetfile[0].calcChain = [{ r: from[0], c: from[1], id: 's1' }];
    ctx.luckysheet_select_save = [
      {
        row: [to[0], to[0]],
        column: [to[1], to[1]],
        row_focus: to[0],
        column_focus: to[1],
      },
    ];
    pasteHandlerOfCutPaste(ctx, {
      copyRange: [{ row: [from[0], from[0]], column: [from[1], from[1]] }],
      dataSheetId: 's1',
      HasMC: false,
      RowlChange: false,
    } as any);
    return ctx;
  };
  const chainKeys = (ctx: any) =>
    ctx.luckysheetfile[0].calcChain.map((c: any) => `${c.r}_${c.c}`);

  beforeAll(() => loadLocale('en'));

  it('the old place leaves the chain and the new place joins it', () => {
    const ctx = cutPaste([0, 1], [3, 3]);
    expect(ctx.luckysheetfile[0].data[3][3]?.f).toBe('=A1*2');
    expect(ctx.luckysheetfile[0].data[0][1]).toBeNull();
    expect(chainKeys(ctx)).toEqual(['3_3']);
  });

  it('a paste onto the cut cell itself keeps its entry once', () => {
    const ctx = cutPaste([0, 1], [0, 1]);
    expect(chainKeys(ctx)).toEqual(['0_1']);
  });
});
