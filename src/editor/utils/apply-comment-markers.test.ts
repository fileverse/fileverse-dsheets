/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// shared-constants pulls in @fileverse/ui, which vitest cannot transform.
vi.mock('../constants/shared-constants', () => ({
  CELL_COMMENT_DEFAULT_VALUE: {
    height: null,
    isShow: false,
    left: null,
    top: null,
    value: '',
    width: null,
  },
}));
import { applyCommentMarkers } from './apply-comment-markers';
import { ySheetArrayToPlain } from './update-ydoc';

const ID = 'dsheet-b4';

const seed = (extraCells: Record<string, any> = {}) => {
  const doc = new Y.Doc();
  doc.transact(() => {
    const sheet = new Y.Map<any>();
    doc.getArray<Y.Map<any>>(ID).push([sheet]);
    sheet.set('id', 'sheet-1');
    sheet.set('order', 0);
    const celldata = new Y.Map<any>();
    sheet.set('celldata', celldata);
    celldata.set('0_0', { r: 0, c: 0, v: { v: 1, m: '1' } });
    celldata.set('1_0', { r: 1, c: 0, v: { v: 2, m: '2' } });
    celldata.set('2_0', { r: 2, c: 0, v: { v: 3, m: '3' } });
    Object.entries(extraCells).forEach(([k, v]) => celldata.set(k, v));
  });
  return doc;
};

const plainOf = (doc: Y.Doc) =>
  ySheetArrayToPlain(doc.getArray(ID) as any) as any[];
const cell = (sheets: any[], r: number, c: number) =>
  sheets[0].celldata.find((e: any) => e.r === r && e.c === c);

describe('applyCommentMarkers (B4)', () => {
  it('leaves the Y.Doc byte-identical', () => {
    const doc = seed();
    const before = Y.encodeStateAsUpdate(doc);
    const plain = plainOf(doc);
    applyCommentMarkers(plain, { 'sheet-1_1_0': { text: 'hi' } }, true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    // The live Yjs object for an uncommented cell gained no `ps` key.
    const live = (
      doc.getArray<Y.Map<any>>(ID).get(0).get('celldata') as Y.Map<any>
    ).get('0_0');
    expect('ps' in live.v).toBe(false);
  });

  it('marks commented cells, including empty ones, in the returned snapshot', () => {
    const doc = seed();
    const plain = plainOf(doc);
    applyCommentMarkers(
      plain,
      { 'sheet-1_1_0': { text: 'a' }, 'sheet-1_5_5': { text: 'b' } },
      true,
    );
    expect(cell(plain, 1, 0).v.ps).toBeTruthy();
    expect(cell(plain, 1, 0).v.v).toBe(2);
    expect(cell(plain, 5, 5).v.ps).toBeTruthy();
    expect('ps' in cell(plain, 0, 0).v).toBe(false);
  });

  it('gives each commented cell its own marker object', () => {
    const plain = plainOf(seed());
    applyCommentMarkers(plain, { 'sheet-1_0_0': {}, 'sheet-1_1_0': {} }, true);
    expect(cell(plain, 0, 0).v.ps).not.toBe(cell(plain, 1, 0).v.ps);
  });

  it('hides a stale persisted marker on a cell without a comment, without writing Yjs', () => {
    const doc = seed({
      '3_0': { r: 3, c: 0, v: { v: 4, ps: { value: 'old' } } },
    });
    const before = Y.encodeStateAsUpdate(doc);
    const plain = plainOf(doc);
    applyCommentMarkers(plain, { 'sheet-1_1_0': {} }, true);
    expect(cell(plain, 3, 0).v.ps).toBeUndefined();
    expect(cell(plain, 3, 0).v.v).toBe(4);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('shows no markers when comments are not allowed', () => {
    const doc = seed();
    const before = Y.encodeStateAsUpdate(doc);
    const plain = plainOf(doc);
    applyCommentMarkers(plain, { 'sheet-1_1_0': {} }, false);
    expect(cell(plain, 1, 0).v.ps).toBeUndefined();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});
