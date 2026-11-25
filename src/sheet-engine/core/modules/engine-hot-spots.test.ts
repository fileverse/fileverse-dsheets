/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { produce } from 'immer';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { clearMeasureTextCache, getMeasureText } from './text';
import { getComputeMap } from './ConditionFormat';
import { delFunctionGroup } from './formula';
import {
  getBorderInfoComputeRange,
  getBorderInfoComputeRangeCached,
} from './border';
import {
  getDropdownList,
  getDropdownOptions,
  validateCellData,
} from './dataVerification';

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

  it('misses on a new day, hits within the same day', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 27, 9, 0, 0));
      const ctx = withRule();
      const first = getComputeMap(ctx);
      vi.setSystemTime(new Date(2026, 9, 27, 23, 0, 0));
      expect(getComputeMap(ctx)).toBe(first);
      vi.setSystemTime(new Date(2026, 9, 28, 0, 5, 0));
      expect(getComputeMap(ctx)).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  // PR 466 review (#13): a defined name lives on ctx, outside luckysheetfile.
  it('misses when a defined name changes', () => {
    const ctx = withRule();
    ctx.definedNames = [{ name: 'lim', formula: '=A3' }];
    const first = getComputeMap(ctx);
    const next = produce<any>(ctx, (d: any) => {
      d.definedNames = [{ name: 'lim', formula: '=A2' }];
    });
    expect(next.luckysheetfile).toBe(ctx.luckysheetfile);
    expect(getComputeMap(next)).not.toBe(first);
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

describe('C6 border compute cache', () => {
  const withBorders = () => {
    const ctx = makeCtx(30, 10);
    const types = [
      'border-all',
      'border-left',
      'border-right',
      'border-top',
      'border-bottom',
      'border-outside',
      'border-inside',
    ];
    ctx.config.borderInfo = types.map((borderType, i) => ({
      rangeType: 'range',
      borderType,
      color: '#000',
      style: '1',
      range: [{ row: [i * 3, i * 3 + 4], column: [i % 5, (i % 5) + 3] }],
    }));
    ctx.config.merge = {
      '2_1': { r: 2, c: 1, rs: 3, cs: 2 },
      '10_4': { r: 10, c: 4, rs: 2, cs: 3 },
    };
    ctx.luckysheetfile[0].data[2][1] = { mc: { r: 2, c: 1, rs: 3, cs: 2 } };
    ctx.luckysheetfile[0].data[10][4] = { mc: { r: 10, c: 4, rs: 2, cs: 3 } };
    return ctx;
  };

  it('equals the uncached compute and hits on a repeat', () => {
    const ctx = withBorders();
    const cached = getBorderInfoComputeRangeCached(ctx, 0, 29, 0, 9);
    expect(cached).toEqual(getBorderInfoComputeRange(ctx, 0, 29, 0, 9));
    expect(getBorderInfoComputeRangeCached(ctx, 0, 29, 0, 9)).toBe(cached);
  });

  it('misses when a keyed input changes', () => {
    const ctx = withBorders();
    const first = getBorderInfoComputeRangeCached(ctx, 0, 29, 0, 9);
    for (const change of [
      (c: any) => (c.config.borderInfo = [...c.config.borderInfo]),
      (c: any) => (c.config.merge = { ...c.config.merge }),
      (c: any) => (c.config.rowhidden = { 3: 0 }),
      (c: any) => (c.config.colhidden = { 2: 0 }),
    ]) {
      change(ctx);
      const next = getBorderInfoComputeRangeCached(ctx, 0, 29, 0, 9);
      expect(next).not.toBe(first);
      expect(next).toEqual(getBorderInfoComputeRange(ctx, 0, 29, 0, 9));
    }
    expect(getBorderInfoComputeRangeCached(ctx, 0, 14, 0, 9)).not.toBe(
      getBorderInfoComputeRangeCached(ctx, 0, 29, 0, 9),
    );
  });

  it('keeps all four frozen-pane windows', () => {
    const ctx = withBorders();
    const panes: Array<[number, number, number, number]> = [
      [0, 3, 0, 2],
      [0, 3, 3, 9],
      [4, 29, 0, 2],
      [4, 29, 3, 9],
    ];
    const first = panes.map((p) => getBorderInfoComputeRangeCached(ctx, ...p));
    const second = panes.map((p) => getBorderInfoComputeRangeCached(ctx, ...p));
    second.forEach((result, i) => expect(result).toBe(first[i]));
  });
});

describe('C7 dropdown options cache', () => {
  /** Pre-C7 validateCellData dropdown branch. */
  const reference = (ctx: any, item: any, cellValue: any) => {
    const list = getDropdownList(ctx, item.value1);
    if (item.type2 && cellValue) {
      return cellValue
        .toString()
        .split(',')
        .every((i: any) => list.indexOf(i) !== -1);
    }
    return list.some((v) => v === cellValue);
  };

  it('matches the previous validation on a table of inputs', () => {
    const ctx = makeCtx();
    ctx.luckysheetfile[0].data[0][0] = { v: 'Red', m: 'Red' };
    ctx.luckysheetfile[0].data[1][0] = { v: 'Blue', m: 'Blue' };
    ctx.luckysheetfile[0].data[2][0] = { v: 'Red', m: 'Red' };
    const items = [
      { type: 'dropdown', value1: 'Open,Done,,Blocked,Done' },
      { type: 'dropdown', value1: 'Open,Done,Blocked', type2: 'true' },
      { type: 'dropdown', value1: 'A1:A3' },
      { type: 'dropdown', value1: 'A1:A3', type2: 'true' },
    ];
    const values = [
      'Open',
      'Done',
      'Blocked',
      'open',
      '',
      'Open,Done',
      'Open,Nope',
      'Red',
      'Blue',
      'Red,Blue',
      1,
      null,
      undefined,
    ];
    for (const item of items) {
      for (const value of values) {
        expect(
          validateCellData(ctx, item, value),
          `${item.value1} / ${value}`,
        ).toBe(reference(ctx, item, value));
      }
    }
  });

  it('re-reads range options after the source sheet changes', () => {
    const ctx = makeCtx();
    ctx.luckysheetfile[0].data[0][0] = { v: 'Red', m: 'Red' };
    const before = getDropdownOptions(ctx, 'A1:A1');
    expect(getDropdownOptions(ctx, 'A1:A1')).toBe(before);
    const next = produce<any>(ctx, (d: any) => {
      d.luckysheetfile[0].data[0][0] = { v: 'Green', m: 'Green' };
    });
    expect(getDropdownOptions(next, 'A1:A1').list).toEqual(['Green']);
  });
});
