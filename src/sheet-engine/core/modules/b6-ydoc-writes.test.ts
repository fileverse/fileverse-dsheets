/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { fillSelectionWithActiveValue } from './selection';
import { deleteCellsShift, insertCellsShift } from './cell-shift';
import { handleFormulaStringPaste } from '../paste/paste-internals';
import { updateYdocSheetData } from '../../../editor/utils/update-ydoc';

const ID = 'dsheet-b6';
const ROWS = 6;
const COLS = 4;

/**
 * Engine context and Y.Doc start with the same cells; every updateCellYdoc
 * call is applied to the doc, as the editor's hook does. After an action the
 * doc must equal the grid, which is what a reload or a second client sees.
 */
const setup = (cells: Record<string, string>) => {
  const doc = new Y.Doc();
  doc.transact(() => {
    const sheet = new Y.Map<any>();
    doc.getArray<Y.Map<any>>(ID).push([sheet]);
    sheet.set('id', 's1');
    sheet.set('celldata', new Y.Map());
    sheet.set('config', new Y.Map());
  });
  const data: any[][] = Array.from({ length: ROWS }, () =>
    Array(COLS).fill(null),
  );
  const seedChanges: any[] = [];
  Object.entries(cells).forEach(([key, text]) => {
    const [r, c] = key.split('_').map(Number);
    data[r][c] = { v: text, m: text, ct: { fa: 'General', t: 'g' } };
    seedChanges.push({
      sheetId: 's1',
      path: ['celldata'],
      key,
      value: { r, c, v: data[r][c] },
    });
  });
  updateYdocSheetData(doc, ID, seedChanges, undefined);

  const ctx = defaultContext({
    globalCache: { undoList: [], redoList: [] } as any,
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
      data,
      config: {},
      calcChain: [],
    },
  ] as any;
  ctx.currentSheetId = 's1';
  ctx.hooks = {
    updateCellYdoc: (changes: any[]) =>
      updateYdocSheetData(doc, ID, changes, undefined),
  } as any;
  return { ctx, doc, data };
};

const gridText = (data: any[][]) => {
  const out: Record<string, unknown> = {};
  data.forEach((row, r) =>
    row?.forEach((cell, c) => {
      if (cell?.v != null && cell.v !== '') out[`${r}_${c}`] = cell.v;
    }),
  );
  return out;
};

const docText = (doc: Y.Doc) => {
  const cells = (
    doc.getArray<Y.Map<any>>(ID).get(0).get('celldata') as Y.Map<any>
  ).toJSON();
  return Object.fromEntries(
    Object.entries(cells).map(([k, e]: [string, any]) => [k, e.v?.v]),
  );
};

describe('actions that never reached Yjs (B6)', () => {
  beforeAll(() => loadLocale('en'));

  it('Ctrl+Enter fill writes the filled range', () => {
    const { ctx, doc, data } = setup({ '0_0': 'src' });
    ctx.luckysheet_select_save = [
      { row: [0, 2], column: [0, 1], row_focus: 0, column_focus: 0 },
    ] as any;
    expect(fillSelectionWithActiveValue(ctx, null as any)).toBe(true);
    expect(Object.keys(gridText(data))).toHaveLength(6);
    expect(docText(doc)).toEqual(gridText(data));
  });

  it.each([
    ['insert, shift down', () => insertCellsShift, 'down'],
    ['insert, shift right', () => insertCellsShift, 'right'],
    ['delete, shift up', () => deleteCellsShift, 'up'],
    ['delete, shift left', () => deleteCellsShift, 'left'],
  ] as const)('%s writes the moved block', (_label, fn, direction) => {
    const { ctx, doc, data } = setup({
      '0_0': 'a',
      '1_0': 'b',
      '2_0': 'c',
      '1_1': 'd',
      '1_2': 'e',
      '4_1': 'f',
    });
    const before = docText(doc);
    (fn() as any)(ctx, direction, { row: [1, 1], column: [0, 1] });
    expect(gridText(data)).not.toEqual(before);
    expect(docText(doc)).toEqual(gridText(data));
  });

  it('a formula pasted as text into one cell is written', () => {
    const { ctx, doc, data } = setup({});
    ctx.luckysheet_select_save = [{ row: [2, 2], column: [1, 1] }] as any;
    handleFormulaStringPaste(ctx, '=1+1');
    expect(data[2][1]?.f).toBe('=1+1');
    const stored = (
      doc.getArray<Y.Map<any>>(ID).get(0).get('celldata') as Y.Map<any>
    ).get('2_1');
    expect(stored?.v?.f).toBe('=1+1');
    expect(stored?.v?.v).toEqual(data[2][1].v);
  });
});
