/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { applyPatches, enablePatches, produceWithPatches } from 'immer';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { setSheetCalcChain } from '../api/cell';
import { insertUpdateFunctionGroup } from './formula';
import { insertRowCol } from './rowcol';
import {
  planHistoryPatches,
  reregisterRestoredFormulas,
} from './history-calc-chain';

enablePatches();

const produceP = produceWithPatches as unknown as (
  base: any,
  recipe: (d: any) => void,
) => [any, any[], any[]];

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
      data: Array.from({ length: 8 }, () => Array(8).fill(null)),
      config: {},
      calcChain: [],
    },
  ];
  ctx.currentSheetId = 's1';
  ctx.hooks = {};
  return ctx;
};

beforeAll(() => loadLocale('en'));

describe('undo keeps a collaborator formula (A4)', () => {
  it('replaying the patches drops it; the planned history keeps it', () => {
    const base = makeCtx();
    // Local commit of a formula at A1: cell plus a chain entry.
    const [afterLocal, , inverse] = produceP(base, (d: any) => {
      d.luckysheetfile[0].data[0][0] = { v: 1, f: '=1' };
      insertUpdateFunctionGroup(d, 0, 0, 's1');
    });
    // A collaborator's formula arrives: chain replaced in place, cell applied.
    const [afterRemote] = produceP(afterLocal, (d: any) => {
      d.luckysheetfile[0].data[5][5] = { v: 7, f: '=7' };
      setSheetCalcChain(
        d,
        [
          { r: 5, c: 5, id: 's1' },
          { r: 0, c: 0, id: 's1' },
        ],
        {},
      );
    });

    // Old behaviour: the index-addressed patches truncate the new chain.
    const naive: any = applyPatches(afterRemote, inverse);
    expect(naive.luckysheetfile[0].calcChain.some((c: any) => c.r === 5)).toBe(
      false,
    );

    const plan = planHistoryPatches(inverse);
    expect(plan.restored).not.toBeNull();
    let restored: any = applyPatches(afterRemote, plan.patches);
    restored = produceP(restored, (d: any) => {
      reregisterRestoredFormulas(d, plan.restored!);
    })[0];
    const chain = restored.luckysheetfile[0].calcChain;
    expect(chain.some((c: any) => c.r === 5 && c.c === 5)).toBe(true);
    expect(chain.some((c: any) => c.r === 0 && c.c === 0)).toBe(false);
    expect(restored.luckysheetfile[0].data[0][0]).toBeNull();
  });

  it('leaves patches alone when a whole grid or sheet is replaced', () => {
    const patches: any[] = [
      { op: 'replace', path: ['luckysheetfile', 0, 'calcChain'], value: [] },
      { op: 'replace', path: ['luckysheetfile', 0, 'data'], value: [] },
    ];
    const plan = planHistoryPatches(patches);
    expect(plan.patches).toBe(patches);
    expect(plan.restored).toBeNull();
  });

  it('passes patches without calcChain through unchanged', () => {
    const patches: any[] = [
      { op: 'replace', path: ['luckysheetfile', 0, 'data', 1, 1], value: null },
    ];
    expect(planHistoryPatches(patches).patches).toBe(patches);
  });
});

// PR 466 review (#2): undoing a row insert lists every cell of every row below
// the edit point. Re-registering each one scanned the whole chain.
describe('undo of a row insert re-registers in one pass', () => {
  const grid = (rows: number, cols: number, formulaRows: number) => {
    const base = makeCtx();
    const sheet = base.luckysheetfile[0];
    sheet.data = Array.from({ length: rows }, () => Array(cols).fill(null));
    sheet.row = rows;
    sheet.column = cols;
    for (let r = 0; r < formulaRows; r += 1) {
      sheet.data[r][0] = { v: 1, f: '=1' };
      sheet.calcChain.push({ r, c: 0, id: 's1' });
    }
    return base;
  };

  const undoInsertAtTop = (base: any) => {
    const [after, , inverse] = produceP(base, (d: any) => {
      insertRowCol(
        d,
        { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 's1' },
        false,
      );
    });
    const plan = planHistoryPatches(inverse);
    let restored: any = applyPatches(after, plan.patches);
    restored = produceP(restored, (d: any) => {
      reregisterRestoredFormulas(d, plan.restored!);
    })[0];
    return { plan, restored };
  };

  it('puts the chain back where the formulas are', () => {
    const { restored } = undoInsertAtTop(grid(12, 4, 3));
    const keys = restored.luckysheetfile[0].calcChain
      .map((c: any) => `${c.r}_${c.c}`)
      .sort();
    // Rows 0-2 hold the formulas again. The shifted entry for the removed
    // last row is a separate gap (row-count patch), not covered here.
    expect(keys).toEqual(expect.arrayContaining(['0_0', '1_0', '2_0']));
    expect(
      restored.luckysheetfile[0].data.map((row: any[]) => row[0]?.f ?? null),
    ).toEqual([
      '=1',
      '=1',
      '=1',
      ...Array(9).fill(null),
    ]);
  });

  it('removes only the entries whose cell lost its formula, with their edges', () => {
    const base = grid(6, 3, 0);
    base.luckysheetfile[0].data[2][1] = { v: 5, f: '=5' };
    insertUpdateFunctionGroup(base, 2, 1, 's1');
    base.formulaCache.depsByCell.set('s1:2:1', new Set(['s1:0:0']));
    base.formulaCache.revDepsByCell.set('s1:0:0', new Set(['s1:2:1']));
    // A patch lists row 2 again, but its formula is gone.
    base.luckysheetfile[0].data[2][1] = { v: 5 };
    const draft = produceP(base, (d: any) => {
      reregisterRestoredFormulas(d, [{ sheetIndex: 0, r: 2, c: null }]);
    })[0];
    expect(draft.luckysheetfile[0].calcChain).toEqual([]);
    expect(draft.formulaCache.depsByCell.has('s1:2:1')).toBe(false);
    expect(draft.formulaCache.revDepsByCell.has('s1:0:0')).toBe(false);
  });

  it('does not add a formula twice when a row and a cell are both listed', () => {
    const base = grid(4, 3, 2);
    base.luckysheetfile[0].calcChain = [];
    const draft = produceP(base, (d: any) => {
      reregisterRestoredFormulas(d, [
        { sheetIndex: 0, r: 1, c: null },
        { sheetIndex: 0, r: 1, c: 0 },
      ]);
    })[0];
    expect(
      draft.luckysheetfile[0].calcChain.filter(
        (c: any) => c.r === 1 && c.c === 0,
      ),
    ).toHaveLength(1);
  });

  it('1,000 formulas on 1,000 rows undo well under the old 6.3 s', () => {
    const start = performance.now();
    const { plan } = undoInsertAtTop(grid(1000, 26, 1000));
    const ms = performance.now() - start;
    expect(plan.restored!.length).toBeGreaterThan(900);
    expect(ms).toBeLessThan(1500);
  }, 30000);
});
