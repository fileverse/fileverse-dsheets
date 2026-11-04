/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { defaultContext } from '../../sheet-engine/core/context';
import { loadLocale } from '../../sheet-engine/core/locale';
import {
  deleteRowCol,
  insertRowCol,
} from '../../sheet-engine/core/modules/rowcol';
import { updateYdocSheetData, ySheetArrayToPlain } from './update-ydoc';

// K6 and K7: a row or column insert or delete must rewrite formulas on every
// other tab that points into the edited tab, whether that tab has a
// calcChain, whether its grid is hydrated, and the cell must be flagged when
// the rewrite leaves a #REF! inside the formula.

const ID = 'dsheet-k6';
const ROWS = 12;
const COLS = 6;

const grid = (cells: Record<string, any>) => {
  const data: any[][] = Array.from({ length: ROWS }, () =>
    Array(COLS).fill(null),
  );
  Object.entries(cells).forEach(([k, cell]) => {
    const [r, c] = k.split('_').map(Number);
    data[r][c] = structuredClone(cell);
  });
  return data;
};

const chainOf = (cells: Record<string, any>, id: string) =>
  Object.entries(cells)
    .filter(([, cell]) => cell.f)
    .map(([k]) => {
      const [r, c] = k.split('_').map(Number);
      return { r, c, id };
    });

const celldataOf = (cells: Record<string, any>) =>
  Object.entries(cells).map(([k, v]) => {
    const [r, c] = k.split('_').map(Number);
    return { r, c, v: structuredClone(v) };
  });

const cellsA = { '4_1': { v: 7, m: '7' } };

type BKind = 'hydrated' | 'no-calcchain' | 'unhydrated';

const setup = (kind: BKind, cellsB: Record<string, any>) => {
  const doc1 = new Y.Doc();
  doc1.transact(() => {
    const arr = doc1.getArray<any>(ID);
    [
      ['a', cellsA],
      ['b', cellsB],
    ].forEach(([id, cells]: any) => {
      const m = new Y.Map<any>();
      arr.push([m]);
      m.set('id', id);
      m.set('name', id === 'a' ? 'A' : 'B');
      const cd = new Y.Map<any>();
      Object.entries(cells).forEach(([k, v]) => {
        const [r, c] = k.split('_').map(Number);
        cd.set(k, { r, c, v: structuredClone(v) });
      });
      m.set('celldata', cd);
      m.set('calcChain', new Y.Map());
      m.set('config', new Y.Map());
    });
  });
  const doc2 = new Y.Doc();
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
  doc1.on('update', (u: Uint8Array) => Y.applyUpdate(doc2, u));

  const ctx: any = defaultContext({
    globalCache: { undoList: [], redoList: [] },
    cellInput: { current: null },
    fxInput: { current: null },
    canvas: { current: null },
    cellArea: { current: null },
    workbookContainer: { current: null },
  } as any);
  const sheetA: any = {
    id: 'a',
    name: 'A',
    order: 0,
    status: 1,
    data: grid(cellsA),
    config: {},
    calcChain: [],
    row: ROWS,
    column: COLS,
  };
  const sheetB: any = {
    id: 'b',
    name: 'B',
    order: 1,
    status: 0,
    config: {},
    row: ROWS,
    column: COLS,
  };
  if (kind === 'unhydrated') {
    sheetB.celldata = celldataOf(cellsB);
    sheetB.calcChain = chainOf(cellsB, 'b');
  } else {
    sheetB.data = grid(cellsB);
    if (kind === 'hydrated') sheetB.calcChain = chainOf(cellsB, 'b');
  }
  ctx.luckysheetfile = [sheetA, sheetB];
  ctx.currentSheetId = 'a';
  ctx.config = sheetA.config;
  ctx.hooks = {
    updateCellYdoc: (changes: any) =>
      updateYdocSheetData(doc1, ID, changes, () => {}),
  };
  return { ctx, doc2 };
};

const formulaInEngine = (ctx: any, key: string): string | undefined => {
  const [r, c] = key.split('_').map(Number);
  const sheet = ctx.luckysheetfile[1];
  if (sheet.data) return sheet.data[r]?.[c]?.f;
  return sheet.celldata?.find((e: any) => e.r === r && e.c === c)?.v?.f;
};

const formulaInDoc = (doc: Y.Doc, key: string): string | undefined => {
  const sheet: any = ySheetArrayToPlain(doc.getArray(ID) as any).find(
    (s: any) => s.id === 'b',
  );
  const [r, c] = key.split('_').map(Number);
  return sheet.celldata?.find((e: any) => e.r === r && e.c === c)?.v?.f;
};

beforeAll(() => loadLocale('en'));

const cellsB = { '0_0': { v: 7, m: '7', f: '=A!B5' } };

describe.each<BKind>(['hydrated', 'no-calcchain', 'unhydrated'])(
  'K6: tab B is %s',
  (kind) => {
    it('row insert on A shifts =A!B5 on B, in memory and in Yjs', () => {
      const { ctx, doc2 } = setup(kind, cellsB);
      insertRowCol(
        ctx,
        { type: 'row', index: 1, count: 2, direction: 'lefttop', id: 'a' },
        false,
      );
      expect(formulaInEngine(ctx, '0_0')).toBe('=A!B7');
      expect(formulaInDoc(doc2, '0_0')).toBe('=A!B7');
    });

    it('column insert on A shifts =A!B5 on B', () => {
      const { ctx, doc2 } = setup(kind, cellsB);
      insertRowCol(
        ctx,
        { type: 'column', index: 0, count: 1, direction: 'lefttop', id: 'a' },
        false,
      );
      expect(formulaInEngine(ctx, '0_0')).toBe('=A!C5');
      expect(formulaInDoc(doc2, '0_0')).toBe('=A!C5');
    });

    it('row delete on A shifts =A!B5 on B', () => {
      const { ctx, doc2 } = setup(kind, cellsB);
      deleteRowCol(ctx, { type: 'row', start: 1, end: 1, id: 'a' });
      expect(formulaInEngine(ctx, '0_0')).toBe('=A!B4');
      expect(formulaInDoc(doc2, '0_0')).toBe('=A!B4');
    });

    it('column delete on A shifts =A!C5 on B', () => {
      const { ctx, doc2 } = setup(kind, {
        '0_0': { v: 7, m: '7', f: '=A!C5' },
      });
      deleteRowCol(ctx, { type: 'column', start: 0, end: 0, id: 'a' });
      expect(formulaInEngine(ctx, '0_0')).toBe('=A!B5');
      expect(formulaInDoc(doc2, '0_0')).toBe('=A!B5');
    });
  },
);

describe('K6: a formula that does not point into the edited tab is left alone', () => {
  it.each<BKind>(['no-calcchain', 'unhydrated'])('tab B is %s', (kind) => {
    const { ctx, doc2 } = setup(kind, {
      '0_0': { v: 1, m: '1', f: '=B5' }, // B's own cell
      '1_0': { v: 1, m: '1', f: '=C!B5' }, // a third tab
    });
    insertRowCol(
      ctx,
      { type: 'row', index: 1, count: 1, direction: 'lefttop', id: 'a' },
      false,
    );
    expect(formulaInEngine(ctx, '0_0')).toBe('=B5');
    expect(formulaInEngine(ctx, '1_0')).toBe('=C!B5');
    expect(formulaInDoc(doc2, '0_0')).toBe('=B5');
  });
});

describe('K7: a #REF! inside a formula on another tab flags the cell', () => {
  it.each<BKind>(['hydrated', 'no-calcchain', 'unhydrated'])(
    'row delete, tab B is %s',
    (kind) => {
      const { ctx } = setup(kind, {
        '0_0': { v: 7, m: '7', f: '=SUM(A!B3,1)' },
      });
      deleteRowCol(ctx, { type: 'row', start: 2, end: 2, id: 'a' });
      expect(formulaInEngine(ctx, '0_0')).toBe('=SUM(#REF!,1)');
      const sheet = ctx.luckysheetfile[1];
      const cell = sheet.data
        ? sheet.data[0][0]
        : sheet.celldata.find((e: any) => e.r === 0 && e.c === 0).v;
      expect(cell.v).toBe('#REF!');
      expect(cell.error).toBeTruthy();
    },
  );

  it('column delete, tab B is hydrated', () => {
    const { ctx } = setup('hydrated', {
      '0_0': { v: 7, m: '7', f: '=SUM(A!B1,1)' },
    });
    deleteRowCol(ctx, { type: 'column', start: 1, end: 1, id: 'a' });
    expect(formulaInEngine(ctx, '0_0')).toBe('=SUM(#REF!,1)');
    expect(ctx.luckysheetfile[1].data[0][0].error).toBeTruthy();
  });
});
