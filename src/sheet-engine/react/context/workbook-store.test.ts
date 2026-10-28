import { describe, expect, it, vi } from 'vitest';
import {
  contextEqualIgnoringScroll,
  createSelection,
  createWorkbookStore,
  onlyIgnoredKeysChanged,
} from './workbook-store';

describe('createWorkbookStore', () => {
  it('returns the latest state and notifies subscribers when it changes', () => {
    const store = createWorkbookStore({ a: 1 });
    const listener = vi.fn();
    store.subscribe(listener);
    const next = { a: 2 };
    store.setState(next);
    expect(store.getState()).toBe(next);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when the same state is set again', () => {
    const initial = { a: 1 };
    const store = createWorkbookStore(initial);
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState(initial);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const store = createWorkbookStore({ a: 1 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.setState({ a: 2 });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createSelection', () => {
  const select = (s: { a: number; b: number }) => ({ a: s.a });
  const sameA = (x: { a: number }, y: { a: number }) => x.a === y.a;

  it('keeps the same snapshot while the selected value is equal', () => {
    const store = createWorkbookStore({ a: 1, b: 1 });
    const sel = createSelection(store, select, sameA);
    const first = sel.getSnapshot();
    store.setState({ a: 1, b: 2 });
    expect(sel.getSnapshot()).toBe(first);
  });

  it('returns a new snapshot when the selected value changes', () => {
    const store = createWorkbookStore({ a: 1, b: 1 });
    const sel = createSelection(store, select, sameA);
    const first = sel.getSnapshot();
    store.setState({ a: 2, b: 1 });
    expect(sel.getSnapshot()).not.toBe(first);
    expect(sel.getSnapshot().a).toBe(2);
  });

  it('runs the selector once per state, however often it is read', () => {
    const store = createWorkbookStore({ a: 1, b: 1 });
    const selector = vi.fn(select);
    const sel = createSelection(store, selector, sameA);
    sel.getSnapshot();
    sel.getSnapshot();
    sel.getSnapshot();
    expect(selector).toHaveBeenCalledTimes(1);
  });

  it('compares against the last snapshot it handed out, not the previous state', () => {
    const store = createWorkbookStore({ a: 1, b: 1 });
    const sel = createSelection(store, select, sameA);
    const first = sel.getSnapshot();
    store.setState({ a: 1, b: 2 });
    sel.getSnapshot();
    store.setState({ a: 5, b: 2 });
    expect(sel.getSnapshot()).not.toBe(first);
  });
});

describe('onlyIgnoredKeysChanged', () => {
  const same = onlyIgnoredKeysChanged(['scrollTop', 'scrollLeft']);

  it('is true when only ignored keys differ', () => {
    expect(same({ x: 1, scrollTop: 0 }, { x: 1, scrollTop: 50 })).toBe(true);
  });

  it('is false when any other key differs', () => {
    expect(same({ x: 1, scrollTop: 0 }, { x: 2, scrollTop: 0 })).toBe(false);
  });

  it('is false when a key appears or disappears', () => {
    expect(same({ x: 1 }, { x: 1, y: 2 })).toBe(false);
    expect(same({ x: 1, y: 2 }, { x: 1 })).toBe(false);
  });

  it('is true for the same object', () => {
    const a = { x: 1 };
    expect(same(a, a)).toBe(true);
  });
});

describe('contextEqualIgnoringScroll', () => {
  const base = {
    currentSheetId: 's1',
    luckysheet_select_save: [{ row: [0, 0], column: [0, 0] }],
    scrollTop: 0,
    scrollLeft: 0,
    visibledatarow: [20, 40],
    visibledatacolumn: [100, 200],
  };

  it('treats a scroll position change as no change', () => {
    expect(
      contextEqualIgnoringScroll(
        base as never,
        { ...base, scrollTop: 300 } as never,
      ),
    ).toBe(true);
    expect(
      contextEqualIgnoringScroll(
        base as never,
        { ...base, scrollLeft: 40 } as never,
      ),
    ).toBe(true);
  });

  it('treats rebuilt row and column offsets as no change', () => {
    expect(
      contextEqualIgnoringScroll(
        base as never,
        {
          ...base,
          visibledatarow: [20, 40],
          visibledatacolumn: [100, 200],
        } as never,
      ),
    ).toBe(true);
  });

  it('still sees a selection or sheet change', () => {
    expect(
      contextEqualIgnoringScroll(
        base as never,
        {
          ...base,
          luckysheet_select_save: [{ row: [1, 1], column: [0, 0] }],
        } as never,
      ),
    ).toBe(false);
    expect(
      contextEqualIgnoringScroll(
        base as never,
        { ...base, currentSheetId: 's2' } as never,
      ),
    ).toBe(false);
  });
});
