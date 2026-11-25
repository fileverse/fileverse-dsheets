import { beforeAll, describe, expect, it } from 'vitest';
import { enablePatches, produceWithPatches } from 'immer';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { insertRowCol } from './rowcol';
import { gridSizeChangesFromPatches } from './history-grid-size';

enablePatches();
beforeAll(() => loadLocale('en'));

// PR 466 review (#9): undo/redo must carry the restored row/column count.

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
      data: Array.from({ length: 12 }, () => Array(6).fill(null)),
      config: {},
      calcChain: [],
      row: 12,
      column: 6,
    },
  ];
  ctx.currentSheetId = 's1';
  ctx.hooks = {};
  return ctx;
};

const insert = (type: 'row' | 'column', count: number) => {
  const base = makeCtx();
  const [after, patches, inverse] = (produceWithPatches as any)(
    base,
    (d: any) => {
      insertRowCol(
        d,
        { type, index: 1, count, direction: 'lefttop', id: 's1' },
        false,
      );
    },
  );
  return { base, after, patches, inverse };
};

describe('gridSizeChangesFromPatches', () => {
  it('reports the restored row count when a row insert is undone', () => {
    const { base, inverse } = insert('row', 2);
    // `base` is the state after undo: the inverse patches restore it.
    expect(gridSizeChangesFromPatches(base, inverse)).toEqual([
      { sheetId: 's1', path: ['row'], value: 12, type: 'update' },
    ]);
  });

  it('reports the grown row count when the insert is redone', () => {
    const { after, patches } = insert('row', 2);
    expect(gridSizeChangesFromPatches(after, patches)).toEqual([
      { sheetId: 's1', path: ['row'], value: 14, type: 'update' },
    ]);
  });

  it('reports the column count for a column insert', () => {
    const { base, inverse } = insert('column', 3);
    expect(gridSizeChangesFromPatches(base, inverse)).toEqual([
      { sheetId: 's1', path: ['column'], value: 6, type: 'update' },
    ]);
  });

  it('reports nothing for patches that do not change the size', () => {
    const base = makeCtx();
    expect(
      gridSizeChangesFromPatches(base, [
        { op: 'replace', path: ['luckysheetfile', 0, 'data', 1, 1], value: 1 },
      ]),
    ).toEqual([]);
  });
});
