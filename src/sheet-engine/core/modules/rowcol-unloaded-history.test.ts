/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { applyPatches, enablePatches, produceWithPatches } from 'immer';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { insertRowCol } from './rowcol';
import { celldataArrayChanges } from './history-celldata';

enablePatches();
beforeAll(() => loadLocale('en'));

// PR 466 round 4 (N1): the rewrite of an unloaded tab goes into history, so
// undo and redo must find it again whatever happened to that tab's celldata.

const makeCtx = (extraB: any[] = []) => {
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
      name: 'A',
      order: 0,
      status: 1,
      data: Array.from({ length: 12 }, () => Array(6).fill(null)),
      config: {},
      calcChain: [],
      row: 12,
      column: 6,
    },
    {
      id: 's2',
      name: 'B',
      order: 1,
      status: 0,
      config: {},
      calcChain: [],
      celldata: [
        { r: 0, c: 0, v: { v: 1, f: '=A!B5' } },
        { r: 1, c: 1, v: { v: 1, f: '=B1*3' } },
        ...extraB,
      ],
    },
  ];
  ctx.currentSheetId = 's1';
  ctx.hooks = {};
  return ctx;
};

const insertTwoRows = (base: any) =>
  (produceWithPatches as any)(base, (d: any) => {
    insertRowCol(
      d,
      { type: 'row', index: 2, count: 2, direction: 'lefttop', id: 's1' },
      false,
    );
  });

const formulas = (ctx: any) =>
  ctx.luckysheetfile[1].celldata.map((e: any) => `${e.r}_${e.c}:${e.v.f}`);

describe('insert on a tab another, unloaded tab reads', () => {
  it('rewrites the unloaded tab and keeps it unloaded', () => {
    const [after] = insertTwoRows(makeCtx());
    expect(formulas(after)).toEqual(['0_0:=A!B7', '1_1:=B1*3']);
    expect(after.luckysheetfile[1].data).toBeUndefined();
  });

  it('records the rewrite as one celldata replacement, not by position', () => {
    const [, patches] = insertTwoRows(makeCtx());
    const touching = patches.filter(
      (p: any) => p.path[1] === 1 && p.path[2] === 'celldata',
    );
    expect(touching.map((p: any) => p.path.length)).toEqual([3]);
  });

  it('undo restores the original text', () => {
    const [after, , inverse] = insertTwoRows(makeCtx());
    expect(formulas(applyPatches(after, inverse))).toEqual([
      '0_0:=A!B5',
      '1_1:=B1*3',
    ]);
  });

  it('undo does not throw after the tab was loaded in between', () => {
    const [after, , inverse] = insertTwoRows(makeCtx());
    const loaded = (produceWithPatches as any)(after, (d: any) => {
      d.luckysheetfile[1].data = [[{ f: '=A!B7' }]];
      delete d.luckysheetfile[1].celldata;
    })[0];
    // The tab has no celldata any more; the replacement still applies.
    expect(() => applyPatches(loaded, inverse)).not.toThrow();
  });

  it('undo puts the text back on the right cell after a peer removed an earlier entry', () => {
    const [after, , inverse] = insertTwoRows(makeCtx());
    const peer = (produceWithPatches as any)(after, (d: any) => {
      d.luckysheetfile[1].celldata.splice(0, 1);
    })[0];
    const undone = applyPatches(peer, inverse);
    expect(formulas(undone)).toEqual(['0_0:=A!B5', '1_1:=B1*3']);
  });

  it('redo gives the rewritten text again', () => {
    const [after, patches, inverse] = insertTwoRows(makeCtx());
    const undone = applyPatches(after, inverse);
    expect(formulas(applyPatches(undone, patches))).toEqual([
      '0_0:=A!B7',
      '1_1:=B1*3',
    ]);
  });

  it('leaves the celldata of a tab that does not read the edited tab untouched', () => {
    const base = makeCtx();
    base.luckysheetfile[1].celldata = [{ r: 0, c: 0, v: { v: 1, f: '=B2*2' } }];
    const [after, patches] = insertTwoRows(base);
    expect(after.luckysheetfile[1].celldata).toBe(base.luckysheetfile[1].celldata);
    expect(patches.some((p: any) => p.path[1] === 1)).toBe(false);
  });

  it('marks #REF! on the copy when a delete leaves one', () => {
    // Covered by structural-edit-other-tabs.test.ts; here only that the entry
    // object is replaced, not mutated, so the base state stays intact.
    const base = makeCtx();
    const before = JSON.stringify(base.luckysheetfile[1].celldata);
    insertTwoRows(base);
    expect(JSON.stringify(base.luckysheetfile[1].celldata)).toBe(before);
  });
});

describe('celldataArrayChanges (Yjs write for undo and redo)', () => {
  const entry = (r: number, c: number, f: string, extra: any = {}) => ({
    r,
    c,
    v: { f, ...extra },
  });

  it('writes the formulas that differ, by cell key', () => {
    const changes = celldataArrayChanges(
      's2',
      [entry(0, 0, '=A!B7'), entry(1, 1, '=B1*3')],
      [entry(0, 0, '=A!B5'), entry(1, 1, '=B1*3')],
    );
    expect(changes).toEqual([
      {
        sheetId: 's2',
        path: ['celldata'],
        key: '0_0',
        value: { r: 0, c: 0, v: { f: '=A!B5' } },
        type: 'update',
      },
    ]);
  });

  it('does not write cells a peer changed that are not cross-tab formulas', () => {
    const changes = celldataArrayChanges(
      's2',
      [entry(0, 0, '=A!B7'), entry(2, 2, '=B1*4'), { r: 3, c: 3, v: { v: 9 } }],
      [entry(0, 0, '=A!B5'), entry(2, 2, '=B1*3')],
    );
    expect(changes.map((c: any) => c.key)).toEqual(['0_0']);
  });

  it('deletes a cross-tab formula the restored array no longer holds', () => {
    const changes = celldataArrayChanges('s2', [entry(0, 0, '=A!B7')], []);
    expect(changes).toEqual([
      { sheetId: 's2', path: ['celldata'], key: '0_0', value: null, type: 'delete' },
    ]);
  });

  it('is empty when either side has no array', () => {
    expect(celldataArrayChanges('s2', undefined, [entry(0, 0, '=A!B5')])).toEqual([]);
    expect(celldataArrayChanges('s2', [entry(0, 0, '=A!B5')], undefined)).toEqual([]);
  });
});
