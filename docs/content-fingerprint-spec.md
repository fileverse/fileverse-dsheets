# Spec: content fingerprint (state vector + deleted count)

Status: draft for review. Amends Stabilize A1, D0 and D5.
Date: 2026-10-22

## 1. Problem

Stabilize uses `Y.encodeStateVector(ydoc)` as the "did the document change" signal
(A1 `stateVector`, D0 persist dedupe, D5 publish dirty check). A state vector only
records inserted items per client. A delete creates no item, so a transaction that
only deletes leaves it byte-identical.

Confirmed in the app (debug `[sv]` logger, 2026-10-22): the state vector does not
change for

- removing a filter
- deleting data validation
- deleting conditional formatting
- deleting a sheet tab
- undo after typing into an empty cell
- deleting a named range

With A1/D0/D5 as written, these edits would be treated as "no change": not
persisted by the host and never published.

## 2. Options considered

| Option | Correct for deletes | Cost per check | Why not / why |
|---|---|---|---|
| State vector only | No | O(clients) | Misses deletes (section 1). |
| `Y.encodeSnapshot(Y.snapshot(doc))` | Yes | O(all items ever written) | `createDeleteSetFromStructStore` walks every struct. 3.1 ms at 142k items, 15.7 ms at 706k items (Node). Grows with every edit, never shrinks. |
| Local transaction counter | Yes | O(1) | Not derived from the document: needs an ignored-origin list and new persisted state; differs per device. |
| **State vector + running deleted count** | **Yes** | **O(clients)**; tracking O(size of change) | Chosen. Derived from document state, no origin rules, no scan. |

## 3. Definition

```
fingerprint = base64(Y.encodeStateVector(doc)) + ":" + deletedCount
```

- `deletedCount`: total length of all deleted ranges in the document
  (the sum of `DeleteItem.len` over `createDeleteSetFromStructStore(doc.store)`).
- Covers every root type in the doc (sheets, defined names, comments, …), not only
  the sheet array, because the persisted and published body is the whole doc.

### Properties

1. **Changes on every real change.** An insert advances the state vector; a delete
   increases `deletedCount`; an overwrite (`map.set` on an existing key) does both.
2. **Stable when nothing changed.** A transaction with no inserts and no deletes
   (empty `transact`, deleting a missing key) leaves it unchanged.
3. **Monotonic on one device.** Neither part can go down. Yjs never deletes the same
   item twice, and duplicate or re-applied updates add nothing.
4. **Deterministic.** Two documents with the same content produce the same
   fingerprint, including after reload and after peers converge.
5. **Equality only.** Compare with `===`. Never parse or order fingerprints.

### Known limit

[Inference] Two replicas that diverged could have the same state vector and the
same deleted count with different deletes (A deleted item X, B deleted item Y, both
from the same base). On one device this cannot cause a missed change (property 3).
It means the fingerprint is not a content hash: D5's on-chain IPFS-hash check stays
as specified.

## 4. Design

### 4.1 Tracker (package)

New module `src/editor/utils/content-fingerprint.ts`:

```ts
export type ContentFingerprintTracker = {
  getFingerprint(): string;
  getDeletedCount(): number;
  dispose(): void;
};

export function attachContentFingerprint(doc: Y.Doc): ContentFingerprintTracker;
export function fingerprintFromUpdate(update: Uint8Array): string;
```

`attachContentFingerprint`:

- Initial `deletedCount`: `0` if the doc is empty (`doc.store.clients.size === 0`),
  otherwise one full scan of `createDeleteSetFromStructStore(doc.store)`. The scan is
  a fallback only; the normal path attaches before any content is loaded (4.2).
- Registers `doc.on('afterTransaction', tr => …)` that adds the sum of
  `tr.deleteSet` range lengths to `deletedCount`. No origin filtering.
- `getFingerprint()` builds the string on demand (state vector encode + base64).
  Do not compute it inside the listener.
- `dispose()` removes the listener. Called from the same cleanup that destroys the doc.

`fingerprintFromUpdate(update)` gives the same value for an encoded full-state
update without building a document, for bodies read from IndexedDB:

- state vector: `Y.encodeStateVectorFromUpdate(update)`
- deleted count: sum of range lengths in `Y.decodeUpdate(update).ds`

Verified (T9, Node): this equals the live-doc fingerprint for bodies produced by
`Y.mergeUpdates` over IndexedDB-style rows, including overlapping full-copy rows,
exact duplicate rows, rows from two peers with concurrent deletes, and `gc: false`.
`Y.mergeUpdates` merges overlapping delete ranges, so nothing is counted twice.

### 4.2 Wiring

- `use-editor-sync.tsx:30`: create the doc and attach the tracker in the same
  `useState` initializer, before `IndexeddbPersistence` (`:107`),
  `mergePublishedContentIntoYdoc` (`:150`) and `SyncManager` can write to it:

  ```ts
  const [{ ydoc, fingerprint }] = useState(() => {
    const doc = new Y.Doc();
    return { ydoc: doc, fingerprint: attachContentFingerprint(doc) };
  });
  ```

  IndexedDB replay, published-state merge, migration and remote updates then all
  pass through `afterTransaction`, so the count is built without a scan
  (verified for a full-state `applyUpdate`, gc on and off, and for real
  `y-indexeddb` 9.0.12 replay across reloads, including its trim to one
  full-state row — T10).
- Dispose in the doc-lifecycle cleanup (`use-editor-sync.tsx:191-198`).
- Expose `getContentFingerprint()` on `DSheetEditorHandle`, next to
  `getContentSnapshot()` (`use-editor-sync.tsx:170-180`).

### 4.3 Changes to the Stabilize ticket

**A1.** Replace `stateVector` in `DSheetContentChange`:

```ts
type DSheetContentChange = {
  hasContent: boolean;
  userEdited: boolean;
  fingerprint: string; // state vector + deleted count, see this spec
};
```

Coalescing, firing points and `userEdited` rules are unchanged.

**D0.** `change.stateVector === lastPersistedStateVector` becomes
`change.fingerprint === lastPersistedFingerprint`.

**D5.**

- Store `lastPublishedFingerprint` instead of the state vector in
  `lastPublishedSnapshot`.
- Open sheet: dirty when `latestChange.fingerprint !== lastPublishedFingerprint`
  (or the sheet was never published, or the title changed — unchanged rules).
- Background sheet: dirty when `fingerprintFromUpdate(body) !== lastPublishedFingerprint`.
- At cycle start capture `fingerprintAtStart`; after a confirmed publish store that
  value, never the current one, so edits made during upload stay dirty.
- D4 unchanged in spirit: on `already_confirmed`, do not store a fingerprint.

**Migration.** Existing stored values are bare state vectors (no `:`). They never
equal a new fingerprint, so each sheet publishes once more after upgrade. No data
migration needed. Do not try to compare old and new formats.

## 5. Performance budget

Measured in Node 20, yjs 13.6.30, simulated 100×10 sheet using the ticket's
session pattern, median of 30 runs.

| Items in doc | Build fingerprint | Track a transaction | Snapshot (rejected) |
|---|---|---|---|
| 1k | 0.004 ms | 0.0002 ms | 0.03 ms |
| 142k | 0.03 ms | 0.0002 ms | 3.1 ms |
| 706k | 0.17 ms | 0.0002 ms | 15.7 ms |
| 100k cells, fresh | 0.002 ms | 0.0002 ms | 2.1 ms |

Budget for implementation (to be re-measured in the browser, 4× CPU throttle):

- tracking: under 0.01 ms per transaction, independent of history size;
- `getFingerprint()`: under 1 ms on the 142k-item reference sheet;
- no full-document scan on open when the tracker is attached at doc creation.

The remaining cost is the state vector, which grows with the number of clients
that ever edited the doc (one per reopen). This is the same cost A1 already accepts.

## 6. Tests (vitest, written before the change)

All ten checks pass in scratch Node scripts (`delcount-bench.cjs`,
`attach-early.cjs`, `t9-t10.cjs`; yjs 13.6.30, y-indexeddb 9.0.12,
fake-indexeddb). Port them to `content-fingerprint.test.ts`.

| # | Case | Expect |
|---|---|---|
| T1 | Pure delete: filter key, data-validation key, CF array clear, cell key, sheet in the sheet array, defined name | State vector unchanged; fingerprint changed |
| T2 | Empty `transact`; delete of a missing key | Fingerprint unchanged |
| T3 | Two peers exchanging 20 sessions of edits | Each running count equals a full scan; both fingerprints equal |
| T4 | Same delta applied twice, then full state applied again | No double count |
| T5 | Both peers delete the same key concurrently, then exchange | Counted once each side; fingerprints equal |
| T6 | Delete delivered before its insert | Count changes only once the insert arrives; equals source doc |
| T7 | `Y.UndoManager` undo of a typed value | Fingerprint changed |
| T8 | Reopen from `encodeStateAsUpdate` | Same fingerprint as before reload |
| T9 | `fingerprintFromUpdate(Y.mergeUpdates(rows))` for: one row per update; legacy full-copy rows overlapping incremental rows plus exact duplicates; rows from two peers with concurrent deletes of the same key; `gc: false`; full-state encode after 200 sessions | Equals the live-doc fingerprint |
| T10 | Tracker attached at doc creation, then real `IndexeddbPersistence` replay (fake-indexeddb): (a) 5 reloads, no trim (461 rows); (b) 4 reloads with >500 updates per session, so y-indexeddb trims the store to 1 full-state row | After each replay and after edits: count equals a full scan; fingerprint unchanged across reload; `fingerprintFromUpdate` of the stored rows equals the last live fingerprint |

Not covered: the package's own `compactDsheetPersistence` pass
(`use-editor-sync.tsx:123`) and the dsheets.new `readSheetBody` read path. Add
both to T10 when porting.

App-side (dsheets.new), with D0/D5 tests: remove a filter on a published sheet,
wait for a cycle, expect a publish.

## 7. Non-goals

- Not a content hash; does not replace D5's on-chain hash comparison.
- No change to the Yjs schema or to what is persisted or published.
- Does not reduce the existing history (part 2).

## 8. Open questions

1. dsheets.new `readSheetBody`: does it merge the IndexedDB rows with
   `Y.mergeUpdates` (T9 covers that) or by another route? It already decodes the
   body; can it return
   `fingerprintFromUpdate` from that pass instead of decoding twice?
2. ddocs.new: does its sheet publish path also compare state vectors? Not traced.
3. Should the debug `[sv]` logger in `editor-workbook.tsx` be kept behind a flag
   for QA, or removed before this lands?
