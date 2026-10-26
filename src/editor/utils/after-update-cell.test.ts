/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// shared-constants pulls in @fileverse/ui, which vitest cannot transform.
vi.mock('@fileverse/ui', () => ({ toast: vi.fn() }));

import { afterUpdateCell } from './after-update-cell';

const ID = 'dsheet-b2';

const seed = () => {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const id of ['A', 'B']) {
      const sheet = new Y.Map<any>();
      doc.getArray<Y.Map<any>>(ID).push([sheet]);
      sheet.set('id', id);
      sheet.set('celldata', new Y.Map());
      sheet.set('config', new Y.Map());
    }
  });
  return doc;
};

const cellsOf = (doc: Y.Doc, sheetId: string) => {
  const sheet = doc
    .getArray<Y.Map<any>>(ID)
    .toArray()
    .find((s) => s.get('id') === sheetId)!;
  return (sheet.get('celldata') as Y.Map<any>).toJSON();
};

const editorOn = (currentSheetId: string) => ({
  current: {
    getWorkbookContext: () => ({
      currentSheetId,
      luckysheetfile: [{ id: 'A' }, { id: 'B' }],
    }),
  } as any,
});

const base = (doc: Y.Doc, overrides: Record<string, unknown>) =>
  ({
    dsheetId: ID,
    ydocRef: { current: doc },
    oldValue: null,
    handleContentPortal: vi.fn(),
    sheetEditorRef: editorOn('A'),
    ...overrides,
  }) as any;

describe('afterUpdateCell persistence (B2)', () => {
  it('writes both of two joiner commits in one tick', async () => {
    const doc = seed();
    // Joiner: data blocks run only while localUserEditRef is true. The first
    // timer resets it, so the second commit's call sees it false.
    const localUserEditRef = { current: false };
    const common = {
      collabEnabled: true,
      collabIsOwner: false,
      localUserEditRef,
    };
    await afterUpdateCell(
      base(doc, {
        ...common,
        row: 0,
        column: 0,
        newValue: { v: 'one', m: 'one' },
      }),
    );
    await afterUpdateCell(
      base(doc, {
        ...common,
        row: 1,
        column: 0,
        newValue: { v: 'two', m: 'two' },
      }),
    );
    expect(Object.keys(cellsOf(doc, 'A')).sort()).toEqual(['0_0', '1_0']);
  });

  it('writes when a stuck remote-apply guard gates data blocks off', async () => {
    const doc = seed();
    await afterUpdateCell(
      base(doc, {
        collabEnabled: true,
        collabIsOwner: true,
        remoteUpdateRef: { current: true },
        row: 2,
        column: 1,
        newValue: { v: 'owner', m: 'owner' },
      }),
    );
    expect(cellsOf(doc, 'A')['2_1']?.v?.v).toBe('owner');
  });

  it('writes to the commit sheet after a tab switch', async () => {
    const doc = seed();
    await afterUpdateCell(
      base(doc, {
        // Gate data blocks off: only the write is under test.
        collabEnabled: true,
        collabIsOwner: false,
        localUserEditRef: { current: false },
        sheetEditorRef: editorOn('B'),
        sheetId: 'A',
        row: 0,
        column: 0,
        newValue: { v: 'mine', m: 'mine' },
      }),
    );
    expect(cellsOf(doc, 'A')['0_0']?.v?.v).toBe('mine');
    expect(cellsOf(doc, 'B')).toEqual({});
  });
});
