import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { fromUint8Array } from 'js-base64';
import { mergeDsheetContent, readDsheetContent } from './persistence';
import {
  attachContentFingerprint,
  fingerprintFromDocument,
  fingerprintFromUpdate,
} from './editor/utils/content-fingerprint';

let counter = 0;
const nextName = () => `fingerprint-test-${++counter}`;

/** A document with a deleted nested map, so the body carries GC structs. */
const makeBody = () => {
  const doc = new Y.Doc();
  const sheets = doc.getArray<Y.Map<unknown>>('s');
  const sheet = new Y.Map<unknown>();
  sheets.push([sheet]);
  const cells = new Y.Map<unknown>();
  sheet.set('celldata', cells);
  for (let i = 0; i < 20; i += 1) cells.set(`${i}_0`, { v: i });
  sheet.set('celldata', new Y.Map<unknown>());
  return Y.encodeStateAsUpdate(doc);
};

describe('DSheetContentSnapshot.fingerprint (A1)', () => {
  it('is null when the content is unavailable', async () => {
    const snap = await readDsheetContent(nextName());
    expect(snap.fingerprint).toBeNull();
  });

  it('equals the live fingerprint of a document reopened from a compacted body', async () => {
    const name = nextName();
    const body = makeBody();

    // Live doc receives the compacted body, then edits; y-indexeddb stores it.
    const live = new Y.Doc();
    const tracker = attachContentFingerprint(live);
    const provider = new IndexeddbPersistence(name, live);
    await provider.whenSynced;
    Y.applyUpdate(live, body);
    live.getMap('m').set('x', 1);
    live.getMap('m').delete('x');
    await new Promise((r) => setTimeout(r, 20));
    const liveFingerprint = tracker.getFingerprint();
    await provider.destroy();

    const snap = await readDsheetContent(name);
    expect(snap.status).toBe('available');
    expect(snap.fingerprint).toBe(liveFingerprint);
    expect(snap.fingerprint).toBe(
      fingerprintFromUpdate(Y.encodeStateAsUpdate(live)),
    );
  });

  it('changes on a delete-only change and matches fingerprintFromDocument', async () => {
    const name = nextName();
    const doc = new Y.Doc();
    doc.getMap('m').set('a', 1);
    const before = await mergeDsheetContent(
      name,
      fromUint8Array(Y.encodeStateAsUpdate(doc)),
    );
    doc.getMap('m').delete('a');
    const after = await mergeDsheetContent(
      name,
      fromUint8Array(Y.encodeStateAsUpdate(doc)),
    );
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.fingerprint).toBe(fingerprintFromDocument(doc));
  });
});
