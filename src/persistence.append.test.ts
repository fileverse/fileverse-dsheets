import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { fromUint8Array } from 'js-base64';
import { IndexeddbPersistence } from 'y-indexeddb';
import {
  appendDsheetUpdate,
  mergeDsheetContent,
  readDsheetContent,
} from './persistence';
import { fingerprintFromUpdate } from './editor/utils/content-fingerprint';

let counter = 0;
const nextName = () => `append-test-${++counter}`;

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

const seedLocal = async (name: string, from?: Y.Doc) => {
  const local = from ?? new Y.Doc();
  if (!from) local.getMap('m').set('a', 1);
  const p = new IndexeddbPersistence(name, local);
  await p.whenSynced;
  await p.destroy();
  return local;
};

const makeRemote = (local: Y.Doc) => {
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.getMap('m').set('b', 'remote');
  return Y.encodeStateAsUpdate(remote);
};

const replay = (rows: Uint8Array[]) => {
  const d = new Y.Doc();
  rows.forEach((r) => Y.applyUpdate(d, r));
  return d;
};

describe('appendDsheetUpdate', () => {
  it('adds exactly one row equal to the delta and replays to the merge result', async () => {
    const name = nextName();
    const local = await seedLocal(name);
    const remoteBody = makeRemote(local);
    const delta = Y.diffUpdate(remoteBody, Y.encodeStateVector(local));
    const before = await readRows(name);
    const liveBefore = Y.encodeStateAsUpdate(local);

    await appendDsheetUpdate(name, delta);

    const rows = await readRows(name);
    expect(rows.length).toBe(before.length + 1);
    expect(rows[rows.length - 1]).toEqual(delta);
    expect(Y.encodeStateAsUpdate(local)).toEqual(liveBefore);

    const mergedName = nextName();
    await seedLocal(mergedName, local);
    await mergeDsheetContent(mergedName, fromUint8Array(remoteBody));
    const viaMerge = replay(await readRows(mergedName));
    const viaAppend = replay(rows);
    expect(fingerprintFromUpdate(Y.encodeStateAsUpdate(viaAppend))).toBe(
      fingerprintFromUpdate(Y.encodeStateAsUpdate(viaMerge)),
    );
    expect(viaAppend.getMap('m').toJSON()).toEqual({ a: 1, b: 'remote' });
    expect(Y.encodeStateVector(viaAppend)).toEqual(
      Y.encodeStateVector(viaMerge),
    );
  });

  it('writes a row that readDsheetContent and a later IndexeddbPersistence read', async () => {
    const name = nextName();
    const local = await seedLocal(name);
    const delta = Y.diffUpdate(makeRemote(local), Y.encodeStateVector(local));
    await appendDsheetUpdate(name, delta);

    const snap = await readDsheetContent(name);
    expect(snap.status).toBe('available');

    const doc = new Y.Doc();
    const p = new IndexeddbPersistence(name, doc);
    await p.whenSynced;
    expect(doc.getMap('m').toJSON()).toEqual({ a: 1, b: 'remote' });
    await p.destroy();
  });

  it('rejects a non-Uint8Array update and writes nothing', async () => {
    const name = nextName();
    await seedLocal(name);
    const before = await readRows(name);
    await expect(
      appendDsheetUpdate(name, 'abc' as unknown as Uint8Array),
    ).rejects.toThrow(/Uint8Array/);
    await expect(
      appendDsheetUpdate(name, [1, 2] as unknown as Uint8Array),
    ).rejects.toThrow(/Uint8Array/);
    expect((await readRows(name)).length).toBe(before.length);
  });

  it('on a database that does not exist yet, creates the y-indexeddb schema with one row', async () => {
    const name = nextName();
    const doc = new Y.Doc();
    doc.getMap('m').set('x', 1);
    const update = Y.encodeStateAsUpdate(doc);
    await appendDsheetUpdate(name, update);

    const rows = await readRows(name);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual(update);
    const snap = await readDsheetContent(name);
    expect(snap.status).toBe('available');
  });

  it('rejects with a clear error when indexedDB is unavailable', async () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error simulate a missing IndexedDB
    delete globalThis.indexedDB;
    try {
      await expect(
        appendDsheetUpdate(nextName(), new Uint8Array([0, 0])),
      ).rejects.toThrow(/IndexedDB is unavailable/);
    } finally {
      globalThis.indexedDB = original;
    }
  });

  it('rejects on a pre-existing database without the updates store', async () => {
    const name = nextName();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onupgradeneeded = () => req.result.createObjectStore('other');
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    await expect(
      appendDsheetUpdate(name, new Uint8Array([0, 0])),
    ).rejects.toThrow(/schema is invalid/);
  });

  it('after a timeout, a late open writes no row and closes the connection', async () => {
    const name = nextName();
    await seedLocal(name);
    const rowsBefore = (await readRows(name)).length;

    const realOpen = indexedDB.open.bind(indexedDB);
    let lateRequest: IDBOpenDBRequest | null = null;
    const closeSpy = vi.fn();
    const spy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      // Defer the real open's success handler until after the timeout.
      const real = realOpen(name);
      const fake: any = {};
      lateRequest = fake;
      real.onsuccess = () => {
        const db = real.result;
        const origClose = db.close.bind(db);
        db.close = () => {
          closeSpy();
          origClose();
        };
        fake.result = db;
        fake.__fire = () => fake.onsuccess?.();
      };
      return fake as IDBOpenDBRequest;
    });
    await expect(
      appendDsheetUpdate(name, new Uint8Array([0, 0]), { timeoutMs: 5 }),
    ).rejects.toThrow(/timed out/);
    spy.mockRestore();

    await new Promise((r) => setTimeout(r, 20));
    (lateRequest as any).__fire();
    await new Promise((r) => setTimeout(r, 20));

    expect(closeSpy).toHaveBeenCalled();
    expect((await readRows(name)).length).toBe(rowsBefore);
  });
});
