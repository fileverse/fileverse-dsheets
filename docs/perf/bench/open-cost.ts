/**
 * Open cost with and without the fingerprint tracker, runs interleaved so
 * order and GC do not favour either side.
 *   npx vite-node docs/perf/bench/open-cost.ts
 */
import * as Y from 'yjs';
import { attachContentFingerprint } from '../../../src/editor/utils/content-fingerprint';

// Body: 100 sessions of map overwrites from distinct clients (deleted history).
let doc = new Y.Doc();
for (let s = 0; s < 100; s += 1) {
  const next = new Y.Doc();
  Y.applyUpdate(next, Y.encodeStateAsUpdate(doc));
  doc = next;
  const m = doc.getMap('cells');
  doc.transact(() => {
    for (let i = 0; i < 1000; i += 1) m.set(`${i}`, { v: s, i });
  });
}
const body = Y.encodeStateAsUpdate(doc);
const a: number[] = [];
const b: number[] = [];
for (let r = 0; r < 40; r += 1) {
  const order = r % 2 === 0;
  for (const withTracker of order ? [true, false] : [false, true]) {
    const d = new Y.Doc();
    if (withTracker) attachContentFingerprint(d);
    const t0 = performance.now();
    Y.applyUpdate(d, body);
    const dt = performance.now() - t0;
    (withTracker ? a : b).push(dt);
  }
}
const med = (x: number[]) => x.sort((p, q) => p - q)[Math.floor(x.length / 2)].toFixed(2);
console.log({ structsInBodyDoc: [...doc.store.clients.values()].reduce((n, l) => n + l.length, 0), withTracker: med(a), without: med(b) });
// Isolate the tracker's own work.
const d = new Y.Doc();
const tracker = attachContentFingerprint(d);
const t0 = performance.now();
Y.applyUpdate(d, body);
const tracked = performance.now() - t0;
console.log({ singleOpenWithTracker: tracked.toFixed(2), deleted: tracker.getDeletedCount() });
