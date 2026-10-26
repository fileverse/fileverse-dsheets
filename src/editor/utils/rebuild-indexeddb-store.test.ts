import 'fake-indexeddb/auto';
import * as Y from 'yjs';
import { IndexeddbPersistence, clearDocument } from 'y-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  attachContentFingerprint,
  fingerprintFromUpdate,
} from './content-fingerprint';
import { rebuildIndexedDbStore } from './rebuild-indexeddb-store';

const edit = (doc: Y.Doc, n: number) => {
  const arr = doc.getArray<string>('sheet');
  for (let i = 0; i < n; i += 1) {
    doc.transact(() => {
      arr.push([`row-${i}`]);
      if (i % 10 === 9) arr.delete(0, 1);
    });
  }
};

const openFresh = async (name: string) => {
  const doc = new Y.Doc();
  const p = new IndexeddbPersistence(name, doc);
  await p.whenSynced;
  const fp = fingerprintFromUpdate(Y.encodeStateAsUpdate(doc));
  await p.destroy();
  return { doc, fp };
};

const readRows = (name: string): Promise<Uint8Array[]> =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = db
        .transaction('updates', 'readonly')
        .objectStore('updates')
        .getAll();
      req.onsuccess = () => {
        db.close();
        resolve(req.result as Uint8Array[]);
      };
      req.onerror = () => reject(req.error);
    };
  });

const plantRow = (name: string, update: Uint8Array): Promise<void> =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('updates', 'readwrite');
      tx.objectStore('updates').add(update);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });

describe('D3 rebuild of the local IndexedDB store', () => {
  it('BEFORE: heal today (delete db, reopen fresh doc) loses the 50 edits', async () => {
    const name = 'before-heal';
    const live = new Y.Doc();
    const tracker = attachContentFingerprint(live);
    const p = new IndexeddbPersistence(name, live);
    await p.whenSynced;
    edit(live, 50);
    await p.destroy();
    await clearDocument(name);
    const { doc, fp } = await openFresh(name);
    expect(doc.getArray('sheet').length).toBe(0);
    expect(fp).not.toBe(tracker.getFingerprint());
  });

  it('rebuild keeps the live doc and re-persists it', async () => {
    const name = 'rebuild';
    const live = new Y.Doc();
    const tracker = attachContentFingerprint(live);
    const p = new IndexeddbPersistence(name, live);
    await p.whenSynced;
    edit(live, 50);
    const before = live.getArray('sheet').toJSON();

    const next = await rebuildIndexedDbStore(name, live, p);

    expect(next).not.toBe(p);
    expect(next.doc).toBe(live);
    expect(live.getArray('sheet').toJSON()).toEqual(before);
    await next.destroy();
    // Read before reopening: a reopen may append its own row.
    expect(await readRows(name)).toHaveLength(1);
    const { fp } = await openFresh(name);
    expect(fp).toBe(tracker.getFingerprint());
  });

  it('drops a stale row that is not in the live doc', async () => {
    const name = 'rebuild-stale';
    const live = new Y.Doc();
    const tracker = attachContentFingerprint(live);
    const p = new IndexeddbPersistence(name, live);
    await p.whenSynced;
    edit(live, 20);
    const other = new Y.Doc();
    other.getArray<string>('sheet').push(['stale-from-other-doc']);
    await plantRow(name, Y.encodeStateAsUpdate(other));
    const planted = await readRows(name);
    expect(planted.length).toBeGreaterThan(20);

    const next = await rebuildIndexedDbStore(name, live, p);
    await next.destroy();

    const rows = await readRows(name);
    expect(rows).toHaveLength(1);
    const { doc, fp } = await openFresh(name);
    expect(doc.getArray('sheet').toJSON()).not.toContain('stale-from-other-doc');
    expect(fp).toBe(tracker.getFingerprint());
  });

  it('calls onCreated with the new provider before resolving', async () => {
    const live = new Y.Doc();
    edit(live, 3);
    const order: string[] = [];
    let created: IndexeddbPersistence | undefined;
    const next = await rebuildIndexedDbStore('rebuild-cb', live, null, (c) => {
      order.push('created');
      created = c;
    });
    order.push('resolved');
    expect(order).toEqual(['created', 'resolved']);
    expect(created).toBe(next);
    await next.destroy();
  });

  it('works with no current provider', async () => {
    const live = new Y.Doc();
    edit(live, 5);
    const next = await rebuildIndexedDbStore('rebuild-null', live, null);
    await next.destroy();
    const { doc } = await openFresh('rebuild-null');
    expect(doc.getArray('sheet').length).toBe(live.getArray('sheet').length);
  });
});
