/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  getSheetYdocSyncContext,
  readYdocSheetField,
  SYNCED_SHEET_FIELDS,
} from './sheet-ydoc-sync-utils';
import { ySheetArrayToPlain } from './update-ydoc';

const ID = 'dsheet-a3';

const yMapOf = (obj: Record<string, unknown>) => {
  const m = new Y.Map<any>();
  Object.entries(obj).forEach(([k, v]) => m.set(k, v));
  return m;
};

const seed = () => {
  const doc = new Y.Doc();
  doc.transact(() => {
    const arr = doc.getArray<any>(ID);
    const full = new Y.Map<any>();
    arr.push([full]);
    full.set('id', 'full');
    full.set('celldata', yMapOf({ '0_0': { r: 0, c: 0, v: { v: 1 } } }));
    full.set(
      'calcChain',
      yMapOf({
        '0_1': { r: 0, c: 1, id: 'full' },
        bad: { r: 'x' },
        '2_2': { r: 2, c: 2, id: 'full' },
      }),
    );
    full.set('config', yMapOf({ merge: { '0_0': { r: 0, c: 0 } }, rowlen: { 0: 30 } }));
    full.set('dataVerification', yMapOf({ '1_1': 0, '2_1': { type: 'checkbox' } }));
    full.set('dataVerificationDefs', [{ type: 'dropdown', value1: 'a,b' }]);
    full.set('hyperlink', yMapOf({ '0_0': { linkType: 'webpage', linkAddress: 'x' } }));
    full.set('filter_select', yMapOf({ row: [0, 5], column: [0, 2] }));
    full.set('filter', yMapOf({ '0': { caljs: {} } }));
    full.set('liveQueryList', yMapOf({ q1: { url: 'u' } }));
    full.set('dataBlockCalcFunction', yMapOf({ '0_0': { f: 'x' } }));
    const cf = new Y.Array<any>();
    full.set('luckysheet_conditionformat_save', cf);
    cf.push([{ type: 'default', cellrange: [] }]);

    // Empty containers: the plain snapshot drops them.
    const empty = new Y.Map<any>();
    arr.push([empty]);
    empty.set('id', 'empty');
    empty.set('celldata', new Y.Map());
    empty.set('calcChain', new Y.Map());
    empty.set('config', new Y.Map());
    empty.set('dataVerification', new Y.Map());
    empty.set('luckysheet_conditionformat_save', new Y.Array());
    empty.set('filter', new Y.Map());
  });
  // Legacy plain-object sheet (pre-migration).
  doc.getArray<any>(ID).push([
    {
      id: 'legacy',
      celldata: [],
      config: { rowlen: { 1: 20 } },
      calcChain: [{ r: 1, c: 1 }],
      hyperlink: { '1_1': { linkType: 'webpage' } },
    },
  ]);
  return doc;
};

describe('readYdocSheetField (A3)', () => {
  it('equals the whole-workbook conversion for every synced field and sheet', () => {
    const doc = seed();
    const plain = ySheetArrayToPlain(doc.getArray(ID) as any) as any[];
    for (const sheet of plain) {
      for (const field of SYNCED_SHEET_FIELDS) {
        expect(readYdocSheetField(doc, ID, sheet.id, field), `${sheet.id}.${field}`).toEqual(
          sheet[field],
        );
      }
    }
  });

  it('returns undefined for a missing sheet', () => {
    expect(readYdocSheetField(seed(), ID, 'nope', 'config')).toBeUndefined();
  });
});

describe('getSheetYdocSyncContext (A3)', () => {
  const editorOn = (luckysheetfile: any[], currentSheetId: string) => ({
    current: {
      getWorkbookContext: () => ({ currentSheetId, luckysheetfile }),
      getSheet: () => {
        throw new Error('getSheet rebuilds celldata; must not be called');
      },
    } as any,
  });

  it('reads the old value from Yjs and the new value from the engine sheet', () => {
    const doc = seed();
    const engineConfig = { rowlen: { 0: 99 } };
    const ctx = getSheetYdocSyncContext({
      sheetEditorRef: editorOn([{ id: 'full', config: engineConfig }], 'full'),
      ydocRef: { current: doc },
      dsheetId: ID,
      field: 'config',
    });
    expect(ctx?.currentSheetId).toBe('full');
    expect(ctx?.oldSheet.config).toEqual({
      merge: { '0_0': { r: 0, c: 0 } },
      rowlen: { 0: 30 },
    });
    expect(ctx?.newValue).toBe(engineConfig);
  });
});
