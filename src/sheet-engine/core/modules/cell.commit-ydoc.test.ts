/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { updateCell } from './cell';

const makeCtx = (sheets: string[] = ['s1']) => {
  const ctx = defaultContext({
    globalCache: { undoList: [], redoList: [] } as any,
    cellInput: { current: null },
    fxInput: { current: null },
    canvas: { current: null },
    cellArea: { current: null },
    workbookContainer: { current: null },
  } as any);
  ctx.luckysheetfile = sheets.map((id, order) => ({
    id,
    name: id,
    order,
    status: order === 0 ? 1 : 0,
    data: Array.from({ length: 5 }, () => Array(5).fill(null)),
    config: {},
    calcChain: [],
  })) as any;
  ctx.currentSheetId = sheets[0];
  return ctx;
};

describe('updateCell writes the committed cell to Yjs inside the commit (B2)', () => {
  beforeAll(() => loadLocale('en'));

  it('emits updateCellYdoc synchronously for a typed value, on the commit sheet', () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const updateCellYdoc = vi.fn();
    const afterUpdateCell = vi.fn();
    ctx.hooks = { updateCellYdoc, afterUpdateCell } as any;

    updateCell(ctx, 1, 2, null, 'typed');

    expect(updateCellYdoc).toHaveBeenCalledTimes(1);
    const [changes] = updateCellYdoc.mock.calls[0];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      sheetId: 's1',
      path: ['celldata'],
      key: '1_2',
      value: { r: 1, c: 2 },
    });
    expect(changes[0].value.v.v).toBe('typed');

    // afterUpdateCell still runs later, with the commit sheet as 5th argument.
    ctx.currentSheetId = 's2';
    vi.runAllTimers();
    expect(afterUpdateCell).toHaveBeenCalledTimes(1);
    expect(afterUpdateCell.mock.calls[0][4]).toBe('s1');
    vi.useRealTimers();
  });

  it('two commits in one tick emit two writes', () => {
    const ctx = makeCtx();
    const updateCellYdoc = vi.fn();
    ctx.hooks = { updateCellYdoc } as any;
    updateCell(ctx, 0, 0, null, 'a');
    updateCell(ctx, 1, 0, null, 'b');
    const keys = updateCellYdoc.mock.calls.map(([ch]) => ch[0].key);
    expect(keys).toEqual(['0_0', '1_0']);
  });
});
