/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { clearMeasureTextCache, getMeasureText } from './text';
import { getComputeMap } from './ConditionFormat';
import { delFunctionGroup } from './formula';

const makeCtx = (rows = 20, cols = 8) => {
  const ctx: any = defaultContext({
    globalCache: { undoList: [], redoList: [] },
    cellInput: { current: null },
    fxInput: { current: null },
    canvas: { current: null },
    cellArea: { current: null },
    workbookContainer: { current: null },
  } as any);
  const data = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (__, c) => ({
      v: r * cols + c,
      m: `${r * cols + c}`,
    })),
  );
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
  ];
  ctx.currentSheetId = 's1';
  ctx.config = ctx.luckysheetfile[0].config;
  ctx.zoomRatio = 1;
  return ctx;
};

beforeAll(() => loadLocale('en'));

describe('C1 text-measure cache', () => {
  const renderCtx = () => {
    const r: any = {
      font: '14px Arial',
      textBaseline: 'top',
      calls: 0,
      measureText: (t: string) => {
        r.calls += 1;
        return {
          width: t.length,
          actualBoundingBoxAscent: 1,
          actualBoundingBoxDescent: 2,
        };
      },
    };
    return r;
  };

  it('hits for the same text, font, zoom and baseline', () => {
    clearMeasureTextCache();
    const ctx = makeCtx();
    const r = renderCtx();
    const a = getMeasureText('hello', r, ctx);
    const b = getMeasureText('hello', r, ctx);
    expect(r.calls).toBe(1);
    expect(b).toBe(a);
  });

  it('misses for a different zoom, baseline or font', () => {
    clearMeasureTextCache();
    const ctx = makeCtx();
    const r = renderCtx();
    getMeasureText('hello', r, ctx);
    ctx.zoomRatio = 2;
    const zoomed = getMeasureText('hello', r, ctx);
    expect(zoomed.width).toBe(10);
    r.textBaseline = 'middle';
    getMeasureText('hello', r, ctx);
    getMeasureText('hello', r, ctx, '20px Arial');
    expect(r.calls).toBe(4);
  });
});

describe('C2 conditional-format compute cache', () => {
  const withRule = () => {
    const ctx = makeCtx();
    ctx.luckysheetfile[0].luckysheet_conditionformat_save = [
      {
        type: 'default',
        cellrange: [{ row: [0, 19], column: [0, 7] }],
        format: { textColor: '#000', cellColor: '#ff0' },
        conditionName: 'greaterThan',
        conditionRange: [],
        conditionValue: ['100'],
      },
    ];
    return ctx;
  };

  it('returns the same map while nothing keyed changes', () => {
    const ctx = withRule();
    const first = getComputeMap(ctx);
    expect(first && Object.keys(first).length).toBeGreaterThan(0);
    ctx.scrollTop = 500;
    expect(getComputeMap(ctx)).toBe(first);
  });

  it('recomputes when data, rules or the workbook change, with the right result', () => {
    const ctx = withRule();
    const first = getComputeMap(ctx) as any;
    expect(first['0_0']).toBeUndefined();
    const next = produce<any>(ctx, (d: any) => {
      d.luckysheetfile[0].data[0][0] = { v: 999, m: '999' };
    });
    const second = getComputeMap(next) as any;
    expect(second).not.toBe(first);
    expect(second['0_0']).toBeTruthy();
    const rulesChanged = produce<any>(next, (d: any) => {
      d.luckysheetfile[0].luckysheet_conditionformat_save[0].conditionValue = [
        '1000',
      ];
    });
    expect((getComputeMap(rulesChanged) as any)['0_0']).toBeUndefined();
  });

  it('never caches inside an Immer draft', () => {
    const ctx = withRule();
    produce<any>(ctx, (d: any) => {
      const a = getComputeMap(d) as any;
      d.luckysheetfile[0].data[0][0] = { v: 999, m: '999' };
      const b = getComputeMap(d) as any;
      expect(a['0_0']).toBeUndefined();
      expect(b['0_0']).toBeTruthy();
    });
  });
});

describe('C3 delFunctionGroup copies only when needed', () => {
  it('leaves both lists untouched for a cell that is not a formula', () => {
    const ctx = makeCtx();
    const chain = [{ r: 1, c: 1, id: 's1' }];
    const dyn = [{ r: 2, c: 2, f: '=A1', data: [[1]] }];
    ctx.luckysheetfile[0].calcChain = chain;
    ctx.luckysheetfile[0].dynamicArray = dyn;
    delFunctionGroup(ctx, 5, 5, 's1');
    expect(ctx.luckysheetfile[0].calcChain).toBe(chain);
    expect(ctx.luckysheetfile[0].dynamicArray).toBe(dyn);
  });

  it('removes the matching entries', () => {
    const ctx = makeCtx();
    ctx.luckysheetfile[0].calcChain = [
      { r: 1, c: 1, id: 's1' },
      { r: 1, c: 1, id: 'other' },
      { r: 3, c: 3, id: 's1' },
    ];
    ctx.luckysheetfile[0].dynamicArray = [
      { r: 1, c: 1, f: '=A1', data: [[1]] },
      { r: 4, c: 4, f: '=A1', data: [[1]] },
    ];
    delFunctionGroup(ctx, 1, 1, 's1');
    expect(ctx.luckysheetfile[0].calcChain).toEqual([
      { r: 1, c: 1, id: 'other' },
      { r: 3, c: 3, id: 's1' },
    ]);
    expect(ctx.luckysheetfile[0].dynamicArray).toEqual([
      { r: 4, c: 4, f: '=A1', data: [[1]] },
    ]);
  });
});
