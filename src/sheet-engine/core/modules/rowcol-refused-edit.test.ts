/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { deleteRowCol, insertRowCol } from './rowcol';

beforeAll(() => loadLocale('en'));

// PR 466 round 4 (N9): a refused structural edit changes nothing, so it must
// not clear depGraphComplete or restart the warm-up.

const makeCtx = (rows = 8, config: any = {}) => {
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
      data: Array.from({ length: rows }, () => Array(4).fill(null)),
      config,
      calcChain: [],
      row: rows,
      column: 4,
    },
  ];
  ctx.currentSheetId = 's1';
  ctx.hooks = {};
  ctx.formulaCache.depGraphComplete = true;
  return ctx;
};

const insertOp = { type: 'row' as const, index: 2, count: 1, direction: 'lefttop' as const, id: 's1' };

describe('a refused insert or delete keeps depGraphComplete', () => {
  it('insert into a read-only row', () => {
    const ctx = makeCtx(8, { rowReadOnly: { 2: true } });
    expect(() => insertRowCol(ctx, insertOp)).toThrow('readOnly');
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
  });

  it('insert past the row limit', () => {
    const ctx = makeCtx(9_999);
    expect(() => insertRowCol(ctx, insertOp)).toThrow('maxExceeded');
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
  });

  it('insert into a tab that does not exist', () => {
    const ctx = makeCtx();
    insertRowCol(ctx, { ...insertOp, id: 'missing' });
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
  });

  it('delete of a read-only row', () => {
    const ctx = makeCtx(8, { rowReadOnly: { 2: true } });
    expect(() => deleteRowCol(ctx, { type: 'row', start: 2, end: 2, id: 's1' })).toThrow('readOnly');
    expect(ctx.formulaCache.depGraphComplete).toBe(true);
  });

  it('an insert that goes through still clears it', () => {
    const ctx = makeCtx();
    insertRowCol(ctx, insertOp);
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
  });

  it('a delete that goes through still clears it', () => {
    const ctx = makeCtx();
    deleteRowCol(ctx, { type: 'row', start: 2, end: 2, id: 's1' });
    expect(ctx.formulaCache.depGraphComplete).toBe(false);
  });
});
