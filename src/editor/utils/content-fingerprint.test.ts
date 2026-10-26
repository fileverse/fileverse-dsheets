/* eslint-disable @typescript-eslint/no-explicit-any */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { fromUint8Array } from 'js-base64';
import {
  attachContentFingerprint,
  fingerprintFromUpdate,
} from './content-fingerprint';
import { compactDsheetPersistence } from '../../persistence-compaction';

const ROOT = 'sheet-root';

/** Ground truth: total deleted length from a full store scan. */
const fullScanDeleted = (doc: Y.Doc) => {
  let total = 0;
  Y.createDeleteSetFromStructStore(doc.store).clients.forEach((items) =>
    items.forEach((item) => {
      total += item.len;
    }),
  );
  return total;
};

const expectedFingerprint = (doc: Y.Doc) =>
  `${fromUint8Array(Y.encodeStateVector(doc))}:${fullScanDeleted(doc)}`;

const tracked = (opts?: { gc?: boolean }) => {
  const doc = new Y.Doc(opts);
  const tracker = attachContentFingerprint(doc);
  return { doc, tracker };
};

/** A sheet in today's shape: array of sheet maps with nested celldata/config maps. */
const seedSheet = (doc: Y.Doc, cells = 20) => {
  const arr = doc.getArray<Y.Map<any>>(ROOT);
  doc.transact(() => {
    const sheet = new Y.Map<any>();
    arr.push([sheet]);
    sheet.set('id', 's1');
    const celldata = new Y.Map<any>();
    sheet.set('celldata', celldata);
    for (let i = 0; i < cells; i += 1) {
      celldata.set(`${i}_0`, { r: i, c: 0, v: { v: i } });
    }
    const config = new Y.Map<any>();
    sheet.set('config', config);
    config.set('merge', {});
    const filter = new Y.Map<any>();
    sheet.set('filter', filter);
    filter.set('0', { caljs: {} });
    const dv = new Y.Map<any>();
    sheet.set('dataVerification', dv);
    dv.set('1_1', { type: 'dropdown', value1: 'a,b' });
    const cf = new Y.Array<any>();
    sheet.set('luckysheet_conditionformat_save', cf);
    cf.push([{ type: 'default' }]);
  });
  doc.getMap('definedNames').set('Total', { ref: 'A1:A3' });
  return arr.get(0);
};

const sync = (from: Y.Doc, to: Y.Doc) =>
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));

describe('content fingerprint (A1)', () => {
  it('T1: pure deletes change the fingerprint but not the state vector', () => {
    const deletes: Array<(sheet: Y.Map<any>, doc: Y.Doc) => void> = [
      (s) => (s.get('filter') as Y.Map<any>).delete('0'),
      (s) => (s.get('dataVerification') as Y.Map<any>).delete('1_1'),
      (s) => {
        const cf = s.get('luckysheet_conditionformat_save') as Y.Array<any>;
        cf.delete(0, cf.length);
      },
      (s) => (s.get('celldata') as Y.Map<any>).delete('3_0'),
      (_s, d) => d.getArray(ROOT).delete(0, 1),
      (_s, d) => d.getMap('definedNames').delete('Total'),
    ];
    for (const del of deletes) {
      const { doc, tracker } = tracked();
      const sheet = seedSheet(doc);
      const sv = fromUint8Array(Y.encodeStateVector(doc));
      const before = tracker.getFingerprint();
      del(sheet, doc);
      expect(fromUint8Array(Y.encodeStateVector(doc))).toBe(sv);
      expect(tracker.getFingerprint()).not.toBe(before);
      expect(tracker.getFingerprint()).toBe(expectedFingerprint(doc));
    }
  });

  it('T2: an empty transaction or deleting a missing key changes nothing', () => {
    const { doc, tracker } = tracked();
    seedSheet(doc);
    const before = tracker.getFingerprint();
    doc.transact(() => {});
    doc.getMap('definedNames').delete('missing');
    expect(tracker.getFingerprint()).toBe(before);
  });

  it('T3: two peers exchanging 20 sessions agree with a full scan', () => {
    const a = tracked();
    const b = tracked();
    seedSheet(a.doc);
    sync(a.doc, b.doc);
    for (let s = 0; s < 20; s += 1) {
      const editor = s % 2 === 0 ? a.doc : b.doc;
      const cells = editor.getArray<Y.Map<any>>(ROOT).get(0).get('celldata');
      editor.transact(() => {
        for (let i = 0; i < 5; i += 1) {
          cells.set(`${(s + i) % 20}_0`, { r: i, c: 0, v: { v: s } });
        }
        cells.delete(`${(s * 3) % 20}_0`);
      });
      sync(a.doc, b.doc);
      sync(b.doc, a.doc);
      expect(a.tracker.getDeletedCount()).toBe(fullScanDeleted(a.doc));
      expect(b.tracker.getDeletedCount()).toBe(fullScanDeleted(b.doc));
    }
    expect(a.tracker.getFingerprint()).toBe(b.tracker.getFingerprint());
  });

  it('T4: re-applied deltas and full state do not double count', () => {
    const src = new Y.Doc();
    const updates: Uint8Array[] = [];
    src.on('update', (u: Uint8Array) => updates.push(u));
    const sheet = seedSheet(src);
    (sheet.get('celldata') as Y.Map<any>).delete('2_0');
    const { doc, tracker } = tracked();
    updates.forEach((u) => Y.applyUpdate(doc, u));
    const once = tracker.getFingerprint();
    updates.forEach((u) => Y.applyUpdate(doc, u));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(src));
    expect(tracker.getFingerprint()).toBe(once);
    expect(once).toBe(expectedFingerprint(src));
  });

  it('T5: a key deleted concurrently on both peers is counted once', () => {
    const a = tracked();
    const b = tracked();
    seedSheet(a.doc);
    sync(a.doc, b.doc);
    a.doc.getMap('definedNames').delete('Total');
    b.doc.getMap('definedNames').delete('Total');
    sync(a.doc, b.doc);
    sync(b.doc, a.doc);
    expect(a.tracker.getDeletedCount()).toBe(fullScanDeleted(a.doc));
    expect(a.tracker.getFingerprint()).toBe(b.tracker.getFingerprint());
  });

  it('T6: a delete delivered before its insert counts once the insert arrives', () => {
    const src = new Y.Doc();
    const updates: Uint8Array[] = [];
    src.on('update', (u: Uint8Array) => updates.push(u));
    src.getMap('m').set('k', 1);
    src.getMap('m').delete('k');
    const { doc, tracker } = tracked();
    Y.applyUpdate(doc, updates[1]);
    expect(tracker.getDeletedCount()).toBe(0);
    Y.applyUpdate(doc, updates[0]);
    expect(tracker.getFingerprint()).toBe(expectedFingerprint(src));
  });

  it('T7: undo of a typed value changes the fingerprint', () => {
    const { doc, tracker } = tracked();
    const cells = seedSheet(doc).get('celldata') as Y.Map<any>;
    const undo = new Y.UndoManager(cells);
    cells.set('50_0', { r: 50, c: 0, v: { v: 'typed' } });
    undo.stopCapturing();
    const before = tracker.getFingerprint();
    undo.undo();
    expect(tracker.getFingerprint()).not.toBe(before);
    expect(tracker.getFingerprint()).toBe(expectedFingerprint(doc));
  });

  it('T8: reopening from a full-state encode gives the same fingerprint', () => {
    const { doc, tracker } = tracked();
    const sheet = seedSheet(doc);
    (sheet.get('celldata') as Y.Map<any>).delete('1_0');
    const reopened = tracked();
    Y.applyUpdate(reopened.doc, Y.encodeStateAsUpdate(doc));
    expect(reopened.tracker.getFingerprint()).toBe(tracker.getFingerprint());
  });

  it('T9: fingerprintFromUpdate of merged rows equals the live fingerprint', () => {
    for (const gc of [true, false]) {
      const a = tracked({ gc });
      const b = tracked({ gc });
      const rows: Uint8Array[] = [];
      a.doc.on('update', (u: Uint8Array) => rows.push(u));
      b.doc.on('update', (u: Uint8Array) => rows.push(u));
      seedSheet(a.doc);
      sync(a.doc, b.doc);
      // Legacy full-copy row overlapping the incremental rows, plus a duplicate.
      rows.push(Y.encodeStateAsUpdate(a.doc));
      rows.push(rows[0]);
      a.doc.getMap('definedNames').delete('Total');
      b.doc.getMap('definedNames').delete('Total');
      for (let s = 0; s < 200; s += 1) {
        a.doc
          .getArray<Y.Map<any>>(ROOT)
          .get(0)
          .get('celldata')
          .set(`${s % 20}_0`, { r: s % 20, c: 0, v: { v: s } });
      }
      sync(a.doc, b.doc);
      sync(b.doc, a.doc);
      expect(fingerprintFromUpdate(Y.mergeUpdates(rows))).toBe(
        a.tracker.getFingerprint(),
      );
      expect(fingerprintFromUpdate(Y.encodeStateAsUpdate(a.doc))).toBe(
        a.tracker.getFingerprint(),
      );
    }
  });

  it('GC structs from a loaded body are counted (deleted map with 20 cells)', () => {
    const { doc, tracker } = tracked();
    const sheet = seedSheet(doc, 20);
    // Replace celldata whole: the old map and its 20 children are deleted.
    sheet.set('celldata', new Y.Map());
    expect(tracker.getFingerprint()).toBe(expectedFingerprint(doc));
    const body = Y.encodeStateAsUpdate(doc);
    const reopened = tracked();
    Y.applyUpdate(reopened.doc, body);
    expect(reopened.tracker.getDeletedCount()).toBe(
      fullScanDeleted(reopened.doc),
    );
    expect(reopened.tracker.getFingerprint()).toBe(fingerprintFromUpdate(body));
    expect(reopened.tracker.getFingerprint()).toBe(tracker.getFingerprint());
  });

  it('attaching to a non-empty doc starts from a full scan', () => {
    const doc = new Y.Doc();
    const sheet = seedSheet(doc);
    (sheet.get('celldata') as Y.Map<any>).delete('0_0');
    const tracker = attachContentFingerprint(doc);
    expect(tracker.getFingerprint()).toBe(expectedFingerprint(doc));
  });

  it('dispose stops tracking', () => {
    const { doc, tracker } = tracked();
    seedSheet(doc);
    const count = tracker.getDeletedCount();
    tracker.dispose();
    doc.getMap('definedNames').delete('Total');
    expect(tracker.getDeletedCount()).toBe(count);
  });

  it('randomized: running count equals a full scan (400 checks)', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let checks = 0;
    for (let round = 0; round < 20; round += 1) {
      const gc = round % 2 === 0;
      const a = tracked({ gc });
      const b = tracked({ gc });
      const rows: Uint8Array[] = [];
      a.doc.on('update', (u: Uint8Array) => rows.push(u));
      b.doc.on('update', (u: Uint8Array) => rows.push(u));
      for (let step = 0; step < 5; step += 1) {
        for (const peer of [a, b]) {
          const root = peer.doc.getMap<any>('root');
          peer.doc.transact(() => {
            const key = `k${Math.floor(rand() * 4)}`;
            const op = rand();
            if (op < 0.4) {
              const child = new Y.Map<any>();
              root.set(key, child);
              const n = 1 + Math.floor(rand() * 6);
              for (let i = 0; i < n; i += 1) child.set(`c${i}`, i);
            } else if (op < 0.7) {
              const child = root.get(key);
              if (child instanceof Y.Map) {
                child.set(`c${Math.floor(rand() * 6)}`, rand());
                child.delete(`c${Math.floor(rand() * 6)}`);
              }
            } else {
              root.delete(key);
            }
          });
        }
        sync(a.doc, b.doc);
        sync(b.doc, a.doc);
        for (const peer of [a, b]) {
          expect(peer.tracker.getDeletedCount()).toBe(
            fullScanDeleted(peer.doc),
          );
          checks += 1;
        }
        // Reopen from one compacted body, row replay in order and reversed,
        // and merged rows.
        const body = Y.encodeStateAsUpdate(a.doc);
        const reopen = tracked({ gc });
        Y.applyUpdate(reopen.doc, body);
        const inOrder = tracked({ gc });
        rows.forEach((u) => Y.applyUpdate(inOrder.doc, u));
        const reversed = tracked({ gc });
        [...rows].reverse().forEach((u) => Y.applyUpdate(reversed.doc, u));
        const merged = tracked({ gc });
        Y.applyUpdate(merged.doc, Y.mergeUpdates(rows));
        for (const d of [reopen, inOrder, reversed, merged]) {
          expect(d.tracker.getDeletedCount()).toBe(fullScanDeleted(d.doc));
          expect(d.tracker.getFingerprint()).toBe(a.tracker.getFingerprint());
          checks += 1;
        }
        expect(fingerprintFromUpdate(body)).toBe(a.tracker.getFingerprint());
        checks += 1;
      }
    }
    expect(checks).toBeGreaterThanOrEqual(400);
  });
});

describe('content fingerprint with y-indexeddb (T10)', () => {
  let dbCounter = 0;
  const nextName = () => `fingerprint-test-${++dbCounter}`;

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

  const openSession = async (name: string) => {
    const { doc, tracker } = tracked();
    const persistence = new IndexeddbPersistence(name, doc);
    await persistence.whenSynced;
    return { doc, tracker, persistence };
  };

  const editSession = (doc: Y.Doc, session: number, edits: number) => {
    const map = doc.getMap<any>('cells');
    for (let i = 0; i < edits; i += 1) {
      map.set(`k${i % 30}`, { session, i });
      if (i % 7 === 0) map.delete(`k${(i + 3) % 30}`);
    }
  };

  it.each([
    ['5 reloads without trim', 5, 40],
    ['4 reloads with a trim to one row', 4, 520],
  ])('%s', async (_label, reloads, editsPerSession) => {
    const name = nextName();
    let last: string | null = null;
    for (let s = 0; s < reloads; s += 1) {
      const { doc, tracker, persistence } = await openSession(name);
      expect(tracker.getDeletedCount()).toBe(fullScanDeleted(doc));
      if (last !== null) expect(tracker.getFingerprint()).toBe(last);
      editSession(doc, s, editsPerSession);
      expect(tracker.getDeletedCount()).toBe(fullScanDeleted(doc));
      last = tracker.getFingerprint();
      await persistence.destroy();
      doc.destroy();
      expect(fingerprintFromUpdate(Y.mergeUpdates(await readRows(name)))).toBe(
        last,
      );
    }
  });

  it('survives compactDsheetPersistence', async () => {
    const name = nextName();
    const first = await openSession(name);
    editSession(first.doc, 0, 60);
    const fp = first.tracker.getFingerprint();
    await first.persistence.destroy();
    first.doc.destroy();
    const second = await openSession(name);
    await compactDsheetPersistence(second.persistence);
    expect(second.tracker.getFingerprint()).toBe(fp);
    await second.persistence.destroy();
    expect(fingerprintFromUpdate(Y.mergeUpdates(await readRows(name)))).toBe(
      fp,
    );
  });
});
