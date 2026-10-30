/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyPatches,
  enablePatches,
  produce as immerProduce,
  produceWithPatches,
} from 'immer';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { dataToCelldata } from '../api/common';
import { ensureSheetFlowdata } from '../api/sheet';
import { deleteRowCol, insertRowCol } from './rowcol';
import {
  loadTabsReadingSheet,
  unloadedTabsRewrittenBy,
} from './structural-edit-prep';

const produce = immerProduce as (base: any, recipe: (d: any) => void) => any;

enablePatches();
beforeAll(() => loadLocale('en'));

// PR 466 N1 (second review): an unloaded tab that reads the edited tab is
// loaded before the edit, so the rewrite is recorded as `data` cell patches.
// Undo and redo then touch only those cells, whether the tab is unloaded,
// loaded, or unloaded again by the time they run.

const INSERT_OP = {
  type: 'row' as const,
  index: 2,
  count: 2,
  direction: 'lefttop' as const,
  id: 's1',
};
const DELETE_OP = { type: 'row' as const, start: 2, end: 3, id: 's1' };

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
      row: 12,
      column: 6,
      celldata: [
        { r: 0, c: 0, v: { v: 1, f: '=A!B5' } },
        { r: 1, c: 1, v: { v: 1, f: '=B1*3' } },
        { r: 3, c: 3, v: { v: 1, f: '=C!A1' } },
      ],
    },
  ];
  ctx.currentSheetId = 's1';
  ctx.hooks = {};
  return ctx;
};

/** What Workbook does for a user insert: load, then record the edit. */
const insertWithPrep = (base: any) => {
  const prepared = loadTabsReadingSheet(base, { insertRowColOp: INSERT_OP });
  const [after, patches, inverse] = (produceWithPatches as any)(
    prepared,
    (d: any) => {
      insertRowCol(
        d,
        { type: 'row', index: 2, count: 2, direction: 'lefttop', id: 's1' },
        false,
      );
    },
  );
  return { prepared, after, patches, inverse };
};

/** What handleUndo/handleRedo do before applying data patches. */
const replay = (ctx: any, patches: any[]) => {
  const loaded = produce(ctx, (d: any) => {
    const seen = new Set<number>();
    patches.forEach((p) => {
      const idx = p.path[1];
      if (p.path[0] !== 'luckysheetfile' || p.path[2] !== 'data') return;
      if (seen.has(idx)) return;
      seen.add(idx);
      if (!d.luckysheetfile[idx].data?.length) {
        ensureSheetFlowdata(d, { index: idx });
      }
    });
  });
  return applyPatches(loaded, patches);
};

const unload = (ctx: any, index: number) =>
  produce(ctx, (d: any) => {
    const sheet = d.luckysheetfile[index];
    sheet.celldata = dataToCelldata(sheet.data);
    delete sheet.data;
  });

const f = (ctx: any, r: number, c: number) => {
  const sheet = ctx.luckysheetfile[1];
  if (sheet.data) return sheet.data[r]?.[c]?.f;
  return sheet.celldata.find((e: any) => e.r === r && e.c === c)?.v?.f;
};

const setCell = (ctx: any, r: number, c: number, v: any) =>
  produce(ctx, (d: any) => {
    const sheet = d.luckysheetfile[1];
    if (sheet.data) {
      while (sheet.data.length <= r) sheet.data.push(Array(6).fill(null));
      sheet.data[r][c] = v;
      return;
    }
    const at = sheet.celldata.findIndex((e: any) => e.r === r && e.c === c);
    if (v == null) {
      if (at >= 0) sheet.celldata.splice(at, 1);
    } else if (at >= 0) sheet.celldata[at].v = v;
    else sheet.celldata.push({ r, c, v });
  });

describe('loading the tabs a structural edit rewrites', () => {
  it('finds only unloaded tabs that name the edited tab', () => {
    const base = makeCtx();
    expect(unloadedTabsRewrittenBy(base, { insertRowColOp: INSERT_OP })).toEqual([1]);
    const other = produce(base, (d: any) => {
      d.luckysheetfile[1].celldata = [{ r: 0, c: 0, v: { f: '=B2*2' } }];
    });
    expect(unloadedTabsRewrittenBy(other, { insertRowColOp: INSERT_OP })).toEqual([]);
  });

  it('returns the same state when nothing needs loading', () => {
    const base = produce(makeCtx(), (d: any) => {
      d.luckysheetfile[1].celldata = [{ r: 0, c: 0, v: { f: '=B2*2' } }];
    });
    expect(loadTabsReadingSheet(base, { insertRowColOp: INSERT_OP })).toBe(base);
    expect(loadTabsReadingSheet(base, {})).toBe(base);
  });

  it('keeps the load out of the recorded patches', () => {
    const { patches } = insertWithPrep(makeCtx());
    const onB = patches.filter((p: any) => p.path[1] === 1);
    expect(onB.length).toBeGreaterThan(0);
    // Cell patches only: no whole-grid `data` replacement, no celldata delete.
    expect(onB.every((p: any) => p.path[2] === 'data' && p.path.length > 3)).toBe(
      true,
    );
  });

  it('rewrites the loaded tab', () => {
    const { after } = insertWithPrep(makeCtx());
    expect(f(after, 0, 0)).toBe('=A!B7');
    expect(f(after, 1, 1)).toBe('=B1*3');
    expect(f(after, 3, 3)).toBe('=C!A1');
  });
});

describe.each([
  ['tab B stays loaded', (c: any) => c],
  ['tab B is unloaded again at undo time', (c: any) => unload(c, 1)],
])('undo and redo, %s', (_name, between) => {
  it('undo restores the formula, redo rewrites it again', () => {
    const { after, patches, inverse } = insertWithPrep(makeCtx());
    const undone = replay(between(after), inverse);
    expect(f(undone, 0, 0)).toBe('=A!B5');
    const redone = replay(between(undone), patches);
    expect(f(redone, 0, 0)).toBe('=A!B7');
  });

  it('a peer-added cross-tab formula survives undo and redo', () => {
    const { after, patches, inverse } = insertWithPrep(makeCtx());
    const peer = setCell(between(after), 2, 2, { v: 1, f: '=A!B9' });
    const undone = replay(peer, inverse);
    expect(f(undone, 2, 2)).toBe('=A!B9');
    expect(f(undone, 0, 0)).toBe('=A!B5');
    const redone = replay(undone, patches);
    expect(f(redone, 2, 2)).toBe('=A!B9');
    expect(f(redone, 0, 0)).toBe('=A!B7');
  });

  it('a peer change to another cross-tab formula is not written back', () => {
    const { after, inverse } = insertWithPrep(makeCtx());
    const peer = setCell(between(after), 3, 3, { v: 1, f: '=C!A2' });
    expect(f(replay(peer, inverse), 3, 3)).toBe('=C!A2');
  });

  it('a peer value edit is neither reverted nor lost', () => {
    const { after, patches, inverse } = insertWithPrep(makeCtx());
    const peer = setCell(between(after), 4, 4, { v: 42 });
    const undone = replay(peer, inverse);
    expect(undone.luckysheetfile[1].data[4][4].v).toBe(42);
    expect(replay(undone, patches).luckysheetfile[1].data[4][4].v).toBe(42);
  });

  it('a peer edit of the rewritten cell itself is replaced like on a loaded tab', () => {
    const { after, inverse } = insertWithPrep(makeCtx());
    const peer = setCell(between(after), 0, 0, { v: 1, f: '=A!C7*5' });
    expect(f(replay(peer, inverse), 0, 0)).toBe('=A!B5');
  });
});

describe('undo after the tab was opened (the reviewer\'s repro)', () => {
  const open = (ctx: any) =>
    produce(ctx, (d: any) => {
      if (!d.luckysheetfile[1].data?.length) ensureSheetFlowdata(d, { index: 1 });
    });

  it('B!A1 goes back to =A!B5 when B is opened between the edit and the undo', () => {
    const { after, patches, inverse } = insertWithPrep(makeCtx());
    const undone = replay(open(after), inverse);
    expect(f(undone, 0, 0)).toBe('=A!B5');
    expect(f(replay(open(undone), patches), 0, 0)).toBe('=A!B7');
  });

  it('also after a peer edit on B and a second undo/redo round', () => {
    const { after, patches, inverse } = insertWithPrep(makeCtx());
    const peer = setCell(open(after), 5, 5, { v: 7 });
    const undone = replay(peer, inverse);
    const redone = replay(undone, patches);
    const undoneAgain = replay(redone, inverse);
    expect(f(undoneAgain, 0, 0)).toBe('=A!B5');
    expect(undoneAgain.luckysheetfile[1].data[5][5].v).toBe(7);
  });
});

// PR 466 N1 (third review): the check that picks the tabs to load must be the
// test the rewrite uses. FORMULA_SHEET_REF_RE lets `-` continue an unquoted
// name, so it reads `=C1-A!B5` as a tab called `C1-A`.
describe.each([
  '=C1-A!B5',
  '=B2-A!B5',
  '=C1+A!B5',
  "=C1-'A'!B5",
])('formula %s on an unloaded tab', (text) => {
  const withFormula = () =>
    produce(makeCtx(), (d: any) => {
      d.luckysheetfile[1].celldata = [{ r: 1, c: 1, v: { v: 1, f: text } }];
    });

  it('is found by the check', () => {
    expect(
      unloadedTabsRewrittenBy(withFormula(), { insertRowColOp: INSERT_OP }),
    ).toEqual([1]);
  });

  it('is rewritten, and undo keeps a peer-added formula', () => {
    const { after, patches, inverse } = insertWithPrep(withFormula());
    expect(after.luckysheetfile[1].data[1][1].f).toBe(
      text.replace('B5', 'B7'),
    );
    const peer = setCell(after, 2, 2, { v: 1, f: '=A!B9' });
    const undone = replay(peer, inverse);
    expect(undone.luckysheetfile[1].data[1][1].f).toBe(text);
    expect(undone.luckysheetfile[1].data[2][2].f).toBe('=A!B9');
    expect(replay(undone, patches).luckysheetfile[1].data[2][2].f).toBe(
      '=A!B9',
    );
  });
});

describe('delete rows on A while B is unloaded', () => {
  const del = (base: any) => {
    const prepared = loadTabsReadingSheet(base, { deleteRowColOp: DELETE_OP });
    return {
      prepared,
      ...(() => {
        const [after, patches, inverse] = (produceWithPatches as any)(
          prepared,
          (d: any) => {
            deleteRowCol(d, DELETE_OP);
          },
        );
        return { after, patches, inverse };
      })(),
    };
  };
  const base = () =>
    produce(makeCtx(), (d: any) => {
      d.luckysheetfile[1].celldata = [
        { r: 0, c: 0, v: { v: 1, f: '=A!B9' } },
        { r: 1, c: 1, v: { v: 1, f: '=C1-A!B9' } },
      ];
    });

  it('finds the tab for a delete op, with either spelling', () => {
    expect(
      unloadedTabsRewrittenBy(base(), { deleteRowColOp: DELETE_OP }),
    ).toEqual([1]);
  });

  it('records cell patches, and undo keeps a peer-added formula', () => {
    const { after, patches, inverse } = del(base());
    expect(after.luckysheetfile[1].data[0][0].f).toBe('=A!B7');
    expect(after.luckysheetfile[1].data[1][1].f).toBe('=C1-A!B7');
    expect(
      patches
        .filter((p: any) => p.path[1] === 1)
        .every((p: any) => p.path[2] === 'data' && p.path.length > 3),
    ).toBe(true);
    const peer = setCell(after, 2, 2, { v: 1, f: '=A!B9' });
    const undone = replay(peer, inverse);
    expect(undone.luckysheetfile[1].data[0][0].f).toBe('=A!B9');
    expect(undone.luckysheetfile[1].data[2][2].f).toBe('=A!B9');
  });
});
