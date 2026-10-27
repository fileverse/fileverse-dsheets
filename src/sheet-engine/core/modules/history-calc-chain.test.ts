/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { applyPatches, enablePatches, produceWithPatches } from 'immer';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { setSheetCalcChain } from '../api/cell';
import { insertUpdateFunctionGroup } from './formula';
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
