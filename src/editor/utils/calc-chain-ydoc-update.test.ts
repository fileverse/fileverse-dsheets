/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { calcChainYdocUpdate } from './calc-chain-ydoc-update';

const ID = 'dsheet-chain';

const seed = () => {
  const doc = new Y.Doc();
  doc.transact(() => {
    const sheet = new Y.Map<any>();
    doc.getArray<any>(ID).push([sheet]);
    sheet.set('id', 's1');
    const chain = new Y.Map<any>();
    chain.set('0_0', { r: 0, c: 0, id: 's1' });
    chain.set('1_1', { r: 1, c: 1, id: 's1' });
    sheet.set('calcChain', chain);
  });
  return doc;
};

const run = (doc: Y.Doc, engineChain: any[], data: any[][]) =>
  calcChainYdocUpdate({
    sheetEditorRef: {
      current: {
        getWorkbookContext: () => ({
          currentSheetId: 's1',
          luckysheetfile: [{ id: 's1', calcChain: engineChain, data }],
        }),
      },
    } as any,
    ydocRef: { current: doc },
    dsheetId: ID,
  });

const chainKeys = (doc: Y.Doc) =>
  Object.keys(
    (doc.getArray<any>(ID).get(0).get('calcChain') as Y.Map<any>).toJSON(),
  ).sort();

describe('calcChain hook (A4)', () => {
  it('deletes a chain key whose cell no longer holds a formula', () => {
    const doc = seed();
    // Engine chain lost both entries; (1,1) is now a plain value.
    run(doc, [], [
      [{ v: 1, f: '=1' }, null],
      [null, { v: 2 }],
    ]);
    expect(chainKeys(doc)).toEqual(['0_0']);
  });

  it('keeps a chain key whose cell still holds a formula', () => {
    const doc = seed();
    run(doc, [], [
      [{ v: 1, f: '=1' }, null],
      [null, { v: 2, f: '=2' }],
    ]);
    expect(chainKeys(doc)).toEqual(['0_0', '1_1']);
  });
});
