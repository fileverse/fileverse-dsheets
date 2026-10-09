import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { fromUint8Array } from 'js-base64';
import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  persistenceNames: [] as string[],
  migrate: vi.fn(),
}));

vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class MockIndexeddbPersistence {
    whenSynced = Promise.resolve();

    constructor(name: string) {
      harness.persistenceNames.push(name);
    }

    on() {}

    destroy() {
      return Promise.resolve();
    }
  },
}));

vi.mock('../../sync-local/useSyncManager', () => ({
  useSyncManager: () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    isReady: false,
    isSyncing: false,
    terminateSession: vi.fn(),
    updateTitle: vi.fn(),
    awareness: null,
    hasCollabContentInitialised: false,
    state: { status: 'idle' },
  }),
}));

vi.mock('../utils/migrate-new-yjs', () => ({
  migrateSheetArrayIfNeeded: harness.migrate,
}));

vi.mock('../../constants', () => ({
  presenceColor: () => '#5298FF',
}));

import { useEditorSync } from './use-editor-sync';

type EditorSync = ReturnType<typeof useEditorSync>;

// The package has no DOM test renderer; a server render runs the hook body,
// which is where the callbacks under test are created. Effects do not run, so
// tests call refreshIndexedDB (the bootstrap) themselves.
const renderEditorSync = (
  dsheetId: string,
  localStoreId?: string,
): EditorSync => {
  const holder: { current: EditorSync | null } = { current: null };
  const Probe = () => {
    holder.current = useEditorSync(
      dsheetId,
      true,
      false,
      '',
      undefined,
      undefined,
      undefined,
      localStoreId,
    );
    return null;
  };
  renderToString(createElement(Probe));
  if (!holder.current) throw new Error('useEditorSync did not render');
  return holder.current;
};

const encodeSheetWithOneTab = (rootKey: string) => {
  const doc = new Y.Doc();
  const tab = new Y.Map<unknown>();
  tab.set('id', 'tab-1');
  doc.getArray<Y.Map<unknown>>(rootKey).push([tab]);
  const encoded = fromUint8Array(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return encoded;
};

describe('dSheet editor local store id', () => {
  beforeEach(() => {
    harness.persistenceNames.length = 0;
    harness.migrate.mockReset();
  });

  it('opens the local database under localStoreId and keeps the root key on dsheetId', async () => {
    const sync = renderEditorSync('sheet', 'dsheet-db-1');

    await sync.refreshIndexedDB();

    const ydoc = sync.ydocRef.current;
    if (!ydoc) throw new Error('editor Y.Doc missing');
    expect(harness.persistenceNames).toEqual(['dsheet-db-1']);
    expect(harness.migrate).toHaveBeenCalledOnce();
    expect(harness.migrate.mock.calls[0][0]).toBe(ydoc);
    expect(harness.migrate.mock.calls[0][1]).toBe(ydoc.share.get('sheet'));
    expect(ydoc.share.has('dsheet-db-1')).toBe(false);
  });

  it('labels content snapshots and merges with localStoreId', () => {
    const sync = renderEditorSync('sheet', 'dsheet-db-1');

    const merged = sync.mergeContent(encodeSheetWithOneTab('sheet'));

    expect(merged.dsheetId).toBe('dsheet-db-1');
    expect(merged.status).toBe('available');
    expect(sync.ydocRef.current?.getArray('sheet').length).toBe(1);
    expect(sync.getContentSnapshot().dsheetId).toBe('dsheet-db-1');
  });

  it('keeps one id for the database, the root and the label without localStoreId', async () => {
    const sync = renderEditorSync('legacy-sheet-id');

    await sync.refreshIndexedDB();

    const ydoc = sync.ydocRef.current;
    if (!ydoc) throw new Error('editor Y.Doc missing');
    expect(harness.persistenceNames).toEqual(['legacy-sheet-id']);
    expect(harness.migrate.mock.calls[0][1]).toBe(
      ydoc.share.get('legacy-sheet-id'),
    );
    expect(sync.getContentSnapshot().dsheetId).toBe('legacy-sheet-id');
    expect(
      sync.mergeContent(encodeSheetWithOneTab('legacy-sheet-id')).dsheetId,
    ).toBe('legacy-sheet-id');
  });

  it('never opens a database for an empty localStoreId', async () => {
    const sync = renderEditorSync('sheet', '');

    await sync.refreshIndexedDB();

    expect(harness.persistenceNames).toEqual([]);
    expect(sync.getContentSnapshot().dsheetId).toBe('');
  });
});
