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

// K1: a row/column insert or delete rewrites formula text on every tab in
// memory. A second client only sees what reaches Yjs, so the rewritten text
// must be written for cells outside the shifted range and on other tabs too.

const ID = 'dsheet-k1';
const ROWS = 12;
const COLS = 6;

const mkSheet = (
  id: string,
  name: string,
  order: number,
  cells: Record<string, any>,
) => {
  const data: any[][] = Array.from({ length: ROWS }, () =>
    Array(COLS).fill(null),
  );
  const calcChain: any[] = [];
  Object.entries(cells).forEach(([k, cell]) => {
    const [r, c] = k.split('_').map(Number);
    data[r][c] = structuredClone(cell);
    if (cell.f) calcChain.push({ r, c, id });
  });
  return {
    id,
    name,
    order,
    status: order === 0 ? 1 : 0,
    data,
    config: {},
    calcChain,
    row: ROWS,
    column: COLS,
  };
};

const cellsA = {
  '4_1': { v: 7, m: '7' },
  '0_0': { v: 7, m: '7', f: '=B5' }, // above the insert row
  '0_3': { v: 7, m: '7', f: '=B5' }, // above, right of the insert column
  '9_0': { v: 7, m: '7', f: '=B5' }, // below
  '9_2': { v: 7, m: '7', f: '=SUM(B1:B5)' },
};
const cellsB = {
  '0_0': { v: 7, m: '7', f: '=A!B5' }, // other tab
};

const seedDoc = () => {
  const doc = new Y.Doc();
  doc.transact(() => {
    const arr = doc.getArray<any>(ID);
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
  return doc;
};

const formulasInDoc = (doc: Y.Doc, sheetId: string) => {
  const sheet: any = ySheetArrayToPlain(doc.getArray(ID) as any).find(
    (s: any) => s.id === sheetId,
  );
  const out: Record<string, string> = {};
  (sheet.celldata ?? []).forEach((e: any) => {
    if (e?.v?.f) out[`${e.r}_${e.c}`] = e.v.f;
  });
  return out;
};

const formulasInEngine = (ctx: any, idx: number) => {
  const out: Record<string, string> = {};
  ctx.luckysheetfile[idx].data.forEach((row: any[], r: number) =>
    row.forEach((c, ci) => {
      if (c?.f) out[`${r}_${ci}`] = c.f;
    }),
  );
  return out;
};

const setup = () => {
  const doc1 = seedDoc();
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
  ctx.luckysheetfile = [
    mkSheet('a', 'A', 0, cellsA),
    mkSheet('b', 'B', 1, cellsB),
  ];
  ctx.currentSheetId = 'a';
  ctx.config = ctx.luckysheetfile[0].config;
  ctx.hooks = {
    updateCellYdoc: (changes: any) =>
      updateYdocSheetData(doc1, ID, changes, () => {}),
  };
  return { ctx, doc1, doc2 };
};

const expectPeerMatchesEngine = (ctx: any, doc2: Y.Doc) => {
  expect(formulasInDoc(doc2, 'a')).toEqual(formulasInEngine(ctx, 0));
  expect(formulasInDoc(doc2, 'b')).toEqual(formulasInEngine(ctx, 1));
};

const sizeInDoc = (doc: Y.Doc, sheetId: string) => {
  const sheet: any = ySheetArrayToPlain(doc.getArray(ID) as any).find(
    (s: any) => s.id === sheetId,
  );
  return { row: sheet.row, column: sheet.column };
};

beforeAll(() => loadLocale('en'));

describe('K1: structural edits reach a second Yjs doc with rewritten formulas', () => {
  it('row insert (lefttop)', () => {
    const { ctx, doc2 } = setup();
    insertRowCol(
      ctx,
      { type: 'row', index: 1, count: 2, direction: 'lefttop', id: 'a' },
      false,
    );
    expect(formulasInEngine(ctx, 0)['0_0']).toBe('=B7');
    expectPeerMatchesEngine(ctx, doc2);
  });

  it('column insert (lefttop)', () => {
    const { ctx, doc2 } = setup();
    insertRowCol(
      ctx,
      { type: 'column', index: 1, count: 1, direction: 'lefttop', id: 'a' },
      false,
    );
    expect(formulasInEngine(ctx, 1)['0_0']).toBe('=A!C5');
    expectPeerMatchesEngine(ctx, doc2);
  });

  it('row delete', () => {
    const { ctx, doc2 } = setup();
    deleteRowCol(ctx, { type: 'row', start: 1, end: 1, id: 'a' });
    expect(formulasInEngine(ctx, 1)['0_0']).toBe('=A!B4');
    expectPeerMatchesEngine(ctx, doc2);
  });

  it('column delete', () => {
    const { ctx, doc2 } = setup();
    deleteRowCol(ctx, { type: 'column', start: 0, end: 0, id: 'a' });
    expectPeerMatchesEngine(ctx, doc2);
  });
});

// K2: the grid size must travel with the structural edit itself, not from a
// later React effect, or a peer that remounts in between keeps the old size.
describe('K2: structural edits write the new row/column count to Yjs', () => {
  it('row insert', () => {
    const { ctx, doc2 } = setup();
    insertRowCol(
      ctx,
      { type: 'row', index: 1, count: 2, direction: 'lefttop', id: 'a' },
      false,
    );
    expect(ctx.luckysheetfile[0].row).toBe(ROWS + 2);
    expect(sizeInDoc(doc2, 'a').row).toBe(ROWS + 2);
  });

  it('column insert', () => {
    const { ctx, doc2 } = setup();
    insertRowCol(
      ctx,
      { type: 'column', index: 1, count: 2, direction: 'lefttop', id: 'a' },
      false,
    );
    expect(sizeInDoc(doc2, 'a').column).toBe(COLS + 2);
  });

  it('row delete', () => {
    const { ctx, doc2 } = setup();
    deleteRowCol(ctx, { type: 'row', start: 1, end: 2, id: 'a' });
    expect(ctx.luckysheetfile[0].row).toBe(ROWS - 2);
    expect(sizeInDoc(doc2, 'a').row).toBe(ROWS - 2);
  });

  it('column delete', () => {
    const { ctx, doc2 } = setup();
    deleteRowCol(ctx, { type: 'column', start: 1, end: 1, id: 'a' });
    expect(sizeInDoc(doc2, 'a').column).toBe(COLS - 1);
  });
});
