/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  SUPPORTED_FORMAT,
  isFormatLocked,
  lockWorkbookReadOnly,
  readFormatVersion,
  watchFormatGate,
} from './format-gate';
import { updateYdocSheetData } from './update-ydoc';
import { writeCommentAnchorsToYdoc } from './comment-anchors-ydoc';
import { syncDefinedNamesToYdoc } from './defined-names-ydoc';

const ID = 'dsheet-f';
const noop = () => {};

const seed = () => {
  const doc = new Y.Doc();
  doc.transact(() => {
    const sheet = new Y.Map<any>();
    doc.getArray<any>(ID).push([sheet]);
    sheet.set('id', 's0');
    sheet.set('celldata', new Y.Map());
    sheet.set('config', new Y.Map());
  });
  return doc;
};

const cellChange = () => [
  {
    sheetId: 's0',
    path: ['celldata'],
    key: '0_0',
    value: { r: 0, c: 0, v: { v: 1 } },
  },
];

const sv = (doc: Y.Doc) => Array.from(Y.encodeStateVector(doc));

describe('format gate', () => {
  it('reads 1 and is not locked when there is no meta map', () => {
    const doc = seed();
    const before = sv(doc);
    expect(readFormatVersion(doc, ID)).toBe(1);
    expect(SUPPORTED_FORMAT).toBe(1);
    const off = watchFormatGate(doc, ID, noop);
    expect(isFormatLocked(doc)).toBe(false);
    expect(sv(doc)).toEqual(before);
    off();
  });

  it('locks once on format 2 and then the write helper writes nothing', () => {
    const doc = seed();
    const onLocked = vi.fn();
    watchFormatGate(doc, ID, onLocked);
    doc.getMap(`${ID}/meta`).set('format', 2);
    doc.getMap(`${ID}/meta`).set('format', 3);
    expect(onLocked).toHaveBeenCalledTimes(1);
    expect(onLocked).toHaveBeenCalledWith(2);
    expect(isFormatLocked(doc)).toBe(true);

    const before = sv(doc);
    updateYdocSheetData(doc, ID, cellChange(), noop);
    expect(sv(doc)).toEqual(before);
  });

  it('locks when meta.format = 2 arrives through Y.applyUpdate', () => {
    const doc = seed();
    const onLocked = vi.fn();
    watchFormatGate(doc, ID, onLocked);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    other.getMap(`${ID}/meta`).set('format', 2);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    expect(onLocked).toHaveBeenCalledWith(2);
    expect(isFormatLocked(doc)).toBe(true);
  });

  it('locks on open when the doc already has format 2', () => {
    const doc = seed();
    doc.getMap(`${ID}/meta`).set('format', 2);
    const onLocked = vi.fn();
    watchFormatGate(doc, ID, onLocked);
    expect(onLocked).toHaveBeenCalledTimes(1);
    expect(isFormatLocked(doc)).toBe(true);
  });

  it('does not lock on format 1', () => {
    const doc = seed();
    const onLocked = vi.fn();
    watchFormatGate(doc, ID, onLocked);
    doc.getMap(`${ID}/meta`).set('format', 1);
    expect(onLocked).not.toHaveBeenCalled();
    expect(isFormatLocked(doc)).toBe(false);
  });

  it('stops watching after unsubscribe', () => {
    const doc = seed();
    const onLocked = vi.fn();
    const off = watchFormatGate(doc, ID, onLocked);
    off();
    doc.getMap(`${ID}/meta`).set('format', 2);
    expect(onLocked).not.toHaveBeenCalled();
    expect(isFormatLocked(doc)).toBe(false);
  });

  it('ignores a format that is not a number', () => {
    const doc = seed();
    const onLocked = vi.fn();
    watchFormatGate(doc, ID, onLocked);
    doc.getMap(`${ID}/meta`).set('format', '2');
    expect(readFormatVersion(doc, ID)).toBe(1);
    expect(onLocked).not.toHaveBeenCalled();
    expect(isFormatLocked(doc)).toBe(false);
  });

  it('reading does not change the state vector', () => {
    const doc = seed();
    const before = sv(doc);
    readFormatVersion(doc, ID);
    expect(sv(doc)).toEqual(before);
  });

  it('comment anchors and defined names writers return without writing while locked', () => {
    const doc = seed();
    watchFormatGate(doc, ID, noop);
    doc.getMap(`${ID}/meta`).set('format', 2);
    const before = sv(doc);
    writeCommentAnchorsToYdoc({
      ydoc: doc,
      dsheetId: ID,
      commentsData: { c1: { id: 'c1', key: '0_0' } },
    });
    syncDefinedNamesToYdoc({
      ydoc: doc,
      dsheetId: ID,
      definedNames: [{ id: 'n1', name: 'N', formula: '=A1' } as any],
    });
    expect(sv(doc)).toEqual(before);
  });

  it('a lock on sheet A does not lock sheet B on the same doc', () => {
    const doc = seed();
    doc.getMap('other/meta').set('format', 2);
    watchFormatGate(doc, 'other', noop);
    expect(isFormatLocked(doc, 'other')).toBe(true);
    expect(isFormatLocked(doc, ID)).toBe(false);
    expect(isFormatLocked(doc)).toBe(true);
    const before = sv(doc);
    updateYdocSheetData(doc, ID, cellChange(), noop);
    expect(sv(doc)).not.toEqual(before);
  });

  it('isFormatLocked with a dsheetId also reads the doc before any watch', () => {
    const doc = seed();
    doc.getMap(`${ID}/meta`).set('format', 2);
    expect(isFormatLocked(doc)).toBe(false);
    expect(isFormatLocked(doc, ID)).toBe(true);
  });

  it('a new watcher on an already locked sheet is told once', () => {
    const doc = seed();
    const first = vi.fn();
    const off = watchFormatGate(doc, ID, first);
    doc.getMap(`${ID}/meta`).set('format', 2);
    expect(first).toHaveBeenCalledTimes(1);
    off();

    const second = vi.fn();
    watchFormatGate(doc, ID, second);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(2);
    doc.getMap(`${ID}/meta`).set('format', 3);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(isFormatLocked(doc, ID)).toBe(true);
  });
});

// PR 466 review (#14): the grid must turn read-only in the same tick the lock
// is seen, not after the workbook data changes identity.
describe('lockWorkbookReadOnly', () => {
  it('sets isFlvReadOnly on the engine context, without history', () => {
    const ctx: any = { isFlvReadOnly: false };
    const setContext = vi.fn((recipe: (d: any) => void, _options?: any) =>
      recipe(ctx),
    );
    expect(lockWorkbookReadOnly({ getWorkbookSetContext: () => setContext })).toBe(
      true,
    );
    expect(ctx.isFlvReadOnly).toBe(true);
    expect(setContext.mock.calls[0][1]).toEqual({ noHistory: true });
  });

  it('does nothing when there is no workbook yet', () => {
    expect(lockWorkbookReadOnly(null)).toBe(false);
    expect(lockWorkbookReadOnly({})).toBe(false);
  });

  it('survives a workbook that is not ready', () => {
    expect(
      lockWorkbookReadOnly({
        getWorkbookSetContext: () => () => {
          throw new Error('not ready');
        },
      }),
    ).toBe(false);
  });

  it('runs inside the watcher callback, before the state update', () => {
    const doc = seed();
    const order: string[] = [];
    const ctx: any = {};
    const workbook = {
      getWorkbookSetContext: () => (recipe: (d: any) => void) => {
        recipe(ctx);
        order.push('read-only');
      },
    };
    const unwatch = watchFormatGate(doc, ID, () => {
      lockWorkbookReadOnly(workbook);
      order.push('state');
    });
    doc.transact(() => {
      doc.getMap(`${ID}/meta`).set('format', 2);
    });
    unwatch();
    expect(order).toEqual(['read-only', 'state']);
    expect(ctx.isFlvReadOnly).toBe(true);
  });
});
