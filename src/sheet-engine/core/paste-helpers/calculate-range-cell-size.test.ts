/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultContext } from '../context';
import { loadLocale } from '../locale';
import { getFontSet } from '../modules/text';
import {
  calculateRangeCellSize,
  clearSingleLineCache,
  measureSingleLine,
} from './calculate-range-cell-size';

const makeCtx = (data: any[][]) => {
  const ctx: any = defaultContext({
    globalCache: { undoList: [], redoList: [] },
    cellInput: { current: null },
    fxInput: { current: null },
    canvas: { current: null },
    cellArea: { current: null },
    workbookContainer: { current: null },
  } as any);
  ctx.luckysheetfile = [
    { id: 's1', name: 'Sheet1', order: 0, status: 1, data, config: {} },
  ];
  ctx.currentSheetId = 's1';
  return ctx;
};

// Stub DOM: logs textContent writes and scrollWidth/scrollHeight reads in order.
const installDom = () => {
  const events: string[] = [];
  const fonts: string[] = [];
  let measureCalls = 0;
  const mkEl = (): any => {
    const el: any = {
      style: {},
      _text: '',
      appendChild: (c: any) => c,
      remove() {},
      get textContent() {
        return el._text;
      },
      set textContent(v: string) {
        events.push('write');
        el._text = v;
      },
      get scrollWidth() {
        events.push('read');
        return el._text.length * 7;
      },
      get scrollHeight() {
        events.push('read');
        return 20;
      },
    };
    return el;
  };
  const measurer = mkEl();
  vi.stubGlobal('document', {
    body: { appendChild() {} },
    getElementById: () => measurer,
    createElement: (tag: string) =>
      tag === 'canvas'
        ? {
            getContext: () => {
              let font = '';
              return {
                get font() {
                  return font;
                },
                set font(v: string) {
                  font = v;
                },
                measureText: (t: string) => {
                  measureCalls += 1;
                  fonts.push(font);
                  return { width: t.length * 7 };
                },
              };
            },
          }
        : mkEl(),
  });
  return { events, fonts, calls: () => measureCalls };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('measureSingleLine', () => {
  it('caches by (font, text): a repeat does not call measureText', () => {
    let calls = 0;
    const ctx2d = {
      font: '',
      measureText: (t: string) => {
        calls += 1;
        return { width: t.length * 5 };
      },
    };
    const f = '12pt "cache-test-font"';
    expect(measureSingleLine(f, 'hello', ctx2d)).toBe(25);
    expect(measureSingleLine(f, 'hello', ctx2d)).toBe(25);
    expect(calls).toBe(1);
    measureSingleLine(f, 'hello!', ctx2d);
    measureSingleLine('13pt "cache-test-font"', 'hello', ctx2d);
    expect(calls).toBe(3);
  });

  it('sets the font on the context before measuring', () => {
    const ctx2d = {
      font: '',
      measureText() {
        return { width: ctx2d.font === 'bold 9pt X' ? 42 : 1 };
      },
    };
    expect(measureSingleLine('bold 9pt X', 'zzz-font-set', ctx2d)).toBe(42);
  });
});

describe('measureSingleLine invalidation', () => {
  const mk = () => {
    let calls = 0;
    return {
      calls: () => calls,
      ctx2d: {
        font: '',
        measureText: (t: string) => {
          calls += 1;
          return { width: t.length };
        },
      },
    };
  };

  it('re-measures after the cache is cleared (fonts loaded)', () => {
    const { ctx2d, calls } = mk();
    measureSingleLine('f-inval', 'abc', ctx2d);
    clearSingleLineCache();
    measureSingleLine('f-inval', 'abc', ctx2d);
    expect(calls()).toBe(2);
  });

  it('clears on document.fonts loadingdone and skips caching while loading', async () => {
    vi.resetModules();
    const listeners: Record<string, () => void> = {};
    const fonts: any = {
      status: 'loading',
      addEventListener: (e: string, fn: () => void) => {
        listeners[e] = fn;
      },
    };
    vi.stubGlobal('document', { fonts });
    const mod = await import('./calculate-range-cell-size');
    const { ctx2d, calls } = mk();
    mod.measureSingleLine('f-load', 'abc', ctx2d);
    mod.measureSingleLine('f-load', 'abc', ctx2d);
    expect(calls()).toBe(2); // not cached while loading
    fonts.status = 'loaded';
    mod.measureSingleLine('f-load', 'abc', ctx2d);
    mod.measureSingleLine('f-load', 'abc', ctx2d);
    expect(calls()).toBe(3);
    listeners.loadingdone();
    mod.measureSingleLine('f-load', 'abc', ctx2d);
    expect(calls()).toBe(4);
  });

  it('does not cache long texts', () => {
    const { ctx2d, calls } = mk();
    const long = 'x'.repeat(201);
    measureSingleLine('f-long', long, ctx2d);
    measureSingleLine('f-long', long, ctx2d);
    expect(calls()).toBe(2);
  });
});

describe('calculateRangeCellSize', () => {
  beforeAll(async () => {
    await loadLocale('en');
  });

  it('measures single-line cells with the grid draw font and no layout reads', () => {
    const dom = installDom();
    const data = [[{ v: 'abc', m: 'abc', ff: 1, fs: 12 }]];
    const ctx = makeCtx(data);
    const out = calculateRangeCellSize(ctx, 's1', 0, 0, 0, 0);
    expect(dom.fonts).toEqual([
      getFontSet({ ff: 1, fs: 12 }, ctx.defaultFontSize, ctx),
    ]);
    expect(dom.events.filter((e) => e === 'read')).toHaveLength(0);
    expect(out.colMax[0]).toBeGreaterThanOrEqual(3 * 7 + 12);
  });

  it('writes every wrapped cell before the first scrollHeight read', () => {
    const dom = installDom();
    const data = [
      [{ v: 'a\nb', m: 'a\nb' }, { v: 'long', m: 'long', tb: 2 }],
      [{ v: 'c\nd', m: 'c\nd' }, { v: 'x', m: 'x', tb: 2 }],
    ];
    const ctx = makeCtx(data);
    calculateRangeCellSize(ctx, 's1', 0, 1, 0, 1);
    const firstRead = dom.events.indexOf('read');
    expect(firstRead).toBeGreaterThan(0);
    // Two batches (widths, then heights): within each, no write follows a read
    // until the batch ends. So the sequence is W+R+ W+R+ at most.
    const collapsed = dom.events
      .join(',')
      .replace(/write(,write)*/g, 'W')
      .replace(/read(,read)*/g, 'R');
    expect(collapsed).toBe('W,R,W,R');
    expect(dom.events.filter((e) => e === 'write').length).toBeGreaterThanOrEqual(
      8,
    );
  });
});
