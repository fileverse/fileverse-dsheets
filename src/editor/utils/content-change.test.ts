/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  COMPACTION_ORIGIN,
  INIT_ORIGIN,
  attachUserEditTracker,
  computeHasContent,
  createContentChangeNotifier,
} from './content-change';

const ID = 'dsheet-1';

const addSheet = (doc: Y.Doc, fill?: (sheet: Y.Map<any>) => void) => {
  doc.transact(() => {
    const sheet = new Y.Map<any>();
    doc.getArray<Y.Map<any>>(ID).push([sheet]);
    sheet.set('id', crypto.randomUUID());
    sheet.set('name', 'Sheet1');
    sheet.set('celldata', new Y.Map());
    sheet.set('config', new Y.Map());
    fill?.(sheet);
  }, INIT_ORIGIN);
};

describe('computeHasContent (A1, mirrors dsheets.new isEmptySheet)', () => {
  it('is false for a doc with no sheets', () => {
    expect(computeHasContent(new Y.Doc(), ID)).toBe(false);
  });

  it('is false for one sheet with empty celldata and config', () => {
    const doc = new Y.Doc();
    addSheet(doc);
    expect(computeHasContent(doc, ID)).toBe(false);
  });

  it('is true for one cell', () => {
    const doc = new Y.Doc();
    addSheet(doc, (s) =>
      s.get('celldata').set('0_0', { r: 0, c: 0, v: { v: 1 } }),
    );
    expect(computeHasContent(doc, ID)).toBe(true);
  });

  it('is false again after the only cell is cleared', () => {
    const doc = new Y.Doc();
    addSheet(doc, (s) =>
      s.get('celldata').set('0_0', { r: 0, c: 0, v: { v: 1 } }),
    );
    const cells = doc.getArray<Y.Map<any>>(ID).get(0).get('celldata');
    cells.delete('0_0');
    expect(computeHasContent(doc, ID)).toBe(false);
  });

  it('is true for config only', () => {
    const doc = new Y.Doc();
    addSheet(doc, (s) => s.get('config').set('columnlen', { 0: 120 }));
    expect(computeHasContent(doc, ID)).toBe(true);
  });

  it('is true for two sheets', () => {
    const doc = new Y.Doc();
    addSheet(doc);
    addSheet(doc);
    expect(computeHasContent(doc, ID)).toBe(true);
  });

  it('reads legacy plain-object sheets', () => {
    const empty = new Y.Doc();
    empty.getArray<any>(ID).push([{ id: 'a', celldata: [], config: {} }]);
    expect(computeHasContent(empty, ID)).toBe(false);
    const filled = new Y.Doc();
    filled
      .getArray<any>(ID)
      .push([{ id: 'a', celldata: [{ r: 0, c: 0, v: 1 }], config: {} }]);
    expect(computeHasContent(filled, ID)).toBe(true);
  });

  it('reads a plain-object config inside a Y.Map sheet', () => {
    const doc = new Y.Doc();
    addSheet(doc, (s) => s.set('config', { merge: { '0_0': {} } }));
    expect(computeHasContent(doc, ID)).toBe(true);
  });
});

describe('attachUserEditTracker (A1 userEdited)', () => {
  const provider = { name: 'y-indexeddb' };

  it.each([
    ['self', 'self'],
    ['remote', 'remote'],
    ['init', INIT_ORIGIN],
    ['compaction', COMPACTION_ORIGIN],
    ['package ingress', 'dsheet-package-ingress'],
    ['IndexedDB provider', provider],
  ])('ignores the %s origin', (_label, origin) => {
    const doc = new Y.Doc();
    const tracker = attachUserEditTracker(doc, () => provider);
    doc.transact(() => doc.getMap('m').set('k', 1), origin);
    expect(tracker.userEdited()).toBe(false);
  });

  it('ignores remote updates applied with Y.applyUpdate', () => {
    const src = new Y.Doc();
    src.getMap('m').set('k', 1);
    const doc = new Y.Doc();
    const tracker = attachUserEditTracker(doc, () => null);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(src), 'remote');
    expect(tracker.userEdited()).toBe(false);
  });

  it('ignores an empty transaction', () => {
    const doc = new Y.Doc();
    const tracker = attachUserEditTracker(doc, () => null);
    doc.transact(() => {});
    doc.getMap('m').delete('missing');
    expect(tracker.userEdited()).toBe(false);
  });

  it('turns on for a local write with no origin and stays on', () => {
    const doc = new Y.Doc();
    const tracker = attachUserEditTracker(doc, () => null);
    doc.getMap('m').set('k', 1);
    expect(tracker.userEdited()).toBe(true);
    doc.transact(() => doc.getMap('m').set('k', 2), 'remote');
    expect(tracker.userEdited()).toBe(true);
  });

  it('turns on for a local delete-only write', () => {
    const doc = new Y.Doc();
    doc.transact(() => doc.getMap('m').set('k', 1), INIT_ORIGIN);
    const tracker = attachUserEditTracker(doc, () => null);
    doc.getMap('m').delete('k');
    expect(tracker.userEdited()).toBe(true);
  });

  it('counts an undo as a user edit', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('m');
    const undo = new Y.UndoManager(map);
    map.set('typed', 1);
    // Attach after the typed write, so only the undo can turn it on.
    const tracker = attachUserEditTracker(doc, () => null);
    expect(tracker.userEdited()).toBe(false);
    undo.undo();
    expect(tracker.userEdited()).toBe(true);
  });

  it('dispose stops tracking', () => {
    const doc = new Y.Doc();
    const tracker = attachUserEditTracker(doc, () => null);
    tracker.dispose();
    doc.getMap('m').set('k', 1);
    expect(tracker.userEdited()).toBe(false);
  });
});

describe('createContentChangeNotifier (A1 coalescing)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    let n = 0;
    const getChange = vi.fn(() => ({
      hasContent: true,
      userEdited: true,
      fingerprint: `fp-${++n}`,
    }));
    const onChange = vi.fn();
    const notifier = createContentChangeNotifier(getChange, () => onChange);
    return { getChange, onChange, notifier };
  };

  it('does not fire on the leading edge', () => {
    const { onChange, notifier } = setup();
    notifier.notify();
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('coalesces local and remote changes into at most one call per second', () => {
    const { getChange, onChange, notifier } = setup();
    for (let i = 0; i < 50; i += 1) {
      notifier.notify();
      vi.advanceTimersByTime(50);
    }
    vi.runAllTimers();
    // 2.5 s of changes -> 3 trailing calls, change built only when firing.
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(3);
    expect(getChange).toHaveBeenCalledTimes(onChange.mock.calls.length);
  });

  it('flush sends a pending change immediately, and only once', () => {
    const { onChange, notifier } = setup();
    notifier.notify();
    notifier.flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('flush with nothing pending sends nothing', () => {
    const { onChange, notifier } = setup();
    notifier.flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reads the latest host callback when firing', () => {
    const first = vi.fn();
    const second = vi.fn();
    let current = first;
    const notifier = createContentChangeNotifier(
      () => ({ hasContent: false, userEdited: false, fingerprint: null }),
      () => current,
    );
    notifier.notify();
    current = second;
    vi.runAllTimers();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({
      hasContent: false,
      userEdited: false,
      fingerprint: null,
    });
  });
});
