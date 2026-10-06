import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { compactDsheetPersistence } from './persistence-compaction';

let dbCounter = 0;
const nextName = () => `compaction-test-${++dbCounter}`;

const open = async (name: string, doc = new Y.Doc()) => {
  const persistence = new IndexeddbPersistence(name, doc);
  await persistence.whenSynced;
  return persistence;
};

const readRows = (name: string) =>
  new Promise<Uint8Array[]>((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const getAll = db
        .transaction('updates', 'readonly')
        .objectStore('updates')
        .getAll();
      getAll.onsuccess = () => {
        db.close();
        resolve(getAll.result as Uint8Array[]);
      };
      getAll.onerror = () => reject(getAll.error);
    };
  });

const bytes = (rows: Uint8Array[]) =>
  rows.reduce((total, row) => total + row.byteLength, 0);

const loadFromStore = async (name: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.mergeUpdates(await readRows(name)));
  return doc;
};

// Reproduces the legacy store: each open merged the published state into the
// doc BEFORE attaching, so y-indexeddb stored a full copy per open. Cells are
// rewritten between opens, so old copies carry content that is now deleted.
const buildLegacyStore = async (name: string, copies = 8, cells = 300) => {
  const source = new Y.Doc();
  for (let copy = 0; copy < copies; copy++) {
    source.transact(() => {
      for (let i = 0; i < cells; i++) {
        source
          .getMap('cells')
          .set(`c${i}`, `value-${copy}-${i}-${'x'.repeat(20)}`);
      }
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
    const persistence = await open(name, doc);
    await persistence.destroy();
  }
  return source;
};

const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()?.();
});

describe('compactDsheetPersistence', () => {
  it('collapses a legacy store to one row the size of the live doc', async () => {
    const name = nextName();
    const source = await buildLegacyStore(name);
    const before = await readRows(name);

    const persistence = await open(name);
    const replaced = await compactDsheetPersistence(persistence);
    const after = await readRows(name);
    const docBytes = Y.encodeStateAsUpdate(persistence.doc).byteLength;
    await persistence.destroy();

    // 8 legacy copies + this open's attach row.
    expect(replaced).toBe(before.length + 1);
    expect(after).toHaveLength(1);
    expect(bytes(after)).toBe(docBytes);
    expect(bytes(after) * 4).toBeLessThan(bytes(before));
    expect((await loadFromStore(name)).getMap('cells').toJSON()).toEqual(
      source.getMap('cells').toJSON(),
    );
  });

  it('leaves a normal open alone', async () => {
    const name = nextName();
    await buildLegacyStore(name, 3, 20);
    const first = await open(name);
    await compactDsheetPersistence(first);
    await first.destroy();

    // Previous compacted row + this open's small attach row.
    const second = await open(name);
    expect(await compactDsheetPersistence(second)).toBe(0);
    await second.destroy();
    expect(await readRows(name)).toHaveLength(2);
  });

  it('compacts again after a session of edits and stays at doc size', async () => {
    const name = nextName();
    await buildLegacyStore(name, 3, 50);
    const first = await open(name);
    await compactDsheetPersistence(first);
    for (let i = 0; i < 50; i++) {
      first.doc.getMap('cells').set(`c${i}`, `edited-${i}-${'y'.repeat(20)}`);
    }
    const expected = first.doc.getMap('cells').toJSON();
    await first.destroy();

    const second = await open(name);
    expect(await compactDsheetPersistence(second)).toBeGreaterThan(0);
    const docBytes = Y.encodeStateAsUpdate(second.doc).byteLength;
    await second.destroy();

    const rows = await readRows(name);
    expect(rows).toHaveLength(1);
    expect(bytes(rows)).toBe(docBytes);
    expect((await loadFromStore(name)).getMap('cells').toJSON()).toEqual(
      expected,
    );
  });

  it('keeps rows another tab writes after this provider synced', async () => {
    const name = nextName();
    await buildLegacyStore(name, 3, 20);
    const tabA = await open(name);
    const tabB = await open(name);
    tabB.doc.getMap('cells').set('fromOtherTab', 'kept');

    await compactDsheetPersistence(tabA);
    await tabA.destroy();
    await tabB.destroy();

    expect(
      (await loadFromStore(name)).getMap('cells').get('fromOtherTab'),
    ).toBe('kept');
  });

  it('keeps _dbsize equal to the real row count, edits included', async () => {
    const name = nextName();
    await buildLegacyStore(name, 4, 20);
    const persistence = await open(name);
    // y-indexeddb sets _dbref/_dbsize after emitting 'synced'; a read
    // transaction queues behind its sync transaction.
    await readRows(name);
    expect(persistence._dbsize).toBe(5);

    const compaction = compactDsheetPersistence(persistence);
    persistence.doc.getMap('cells').set('duringCompaction', 'edit');
    expect(await compaction).toBe(5);

    const rows = await readRows(name);
    expect(rows).toHaveLength(2);
    expect(persistence._dbsize).toBe(rows.length);
    await persistence.destroy();
  });

  it('rolls back and rejects with the original error', async () => {
    const name = nextName();
    await buildLegacyStore(name, 3, 20);
    const persistence = await open(name);
    const before = await readRows(name);

    const originalDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function () {
      throw new Error('boom');
    };
    restore.push(() => {
      IDBObjectStore.prototype.delete = originalDelete;
    });

    await expect(compactDsheetPersistence(persistence)).rejects.toThrow('boom');
    restore.pop()?.();
    await persistence.destroy();

    const after = await readRows(name);
    expect(after).toHaveLength(before.length);
    expect(bytes(after)).toBe(bytes(before));
  });

  it('clamps minRows so a tiny store is never rewritten', async () => {
    const name = nextName();
    const persistence = await open(name);
    await expect(compactDsheetPersistence(persistence, 0)).resolves.toBe(0);
    await persistence.destroy();
    expect(await readRows(name)).toHaveLength(1);
  });

  it('does nothing once the provider is destroyed', async () => {
    const name = nextName();
    await buildLegacyStore(name, 3, 20);
    const persistence = await open(name);
    await persistence.destroy();
    expect(await compactDsheetPersistence(persistence)).toBe(0);
  });
});
