# Stabilize (TEC-3277): before and after numbers

Every change gets numbers measured the same way before and after.

**Method.** `npx vite-node docs/perf/bench/stabilize-bench.ts -- <label>`. It writes `docs/perf/bench/results/<label>.json`.

- Node v20.19.0, yjs 13.6.30, macOS (Darwin 23.6.0), same machine for every run.
- Cells are written through the package's own `updateYdocSheetData`.
- Each figure is the median (and p95) over 10 to 50 runs, after 2 warmup runs.
- Base: branch `maitra/perf-improvements` at `b4f4590`.

**Simulated small sheet (S4).** 100 rows × 10 columns, 100 sessions. Each session opens as a new client, inserts a row near the top, fills 3 columns with colour, re-saves a 100-cell dropdown column, saves one conditional format, and types in 30 cells.

- Result: 113,913 structs, 112,810 deleted units, 1.08 MB body. A fresh copy is 1,105 structs and 88 KB.
- This is not the ticket's simulation. The ticket's run gave 145,005 entries with 36 ms encode and 173 ms decode, so the absolute S4 numbers differ from the ticket's.

## Baseline (`before.json`, before any change)

| Scenario | Median | p95 |
|---|---|---|
| S1 1 tab 4000×25: Yjs write only | 0.025 ms | 0.14 ms |
| S1 1 tab: write + today's `handleOnChange` body | **143 ms** | 163 ms |
| S1 1 tab: `encodeStateAsUpdate` + base64 | 133 ms | 145 ms |
| S1 1 tab: `ySheetArrayToPlain` | 28 ms | 41 ms |
| S1 3 tabs: write + `handleOnChange` body | **510 ms** | 517 ms |
| S2 remote one-cell delta: apply + full encode (SyncManager path) | **111 ms** | 242 ms |
| S2 remote one-cell delta: apply only | 0.014 ms | 0.1 ms |
| S3 one hook firing, Yjs side (`ySheetArrayToPlain`) | 28 ms | 30 ms |
| S4 old sheet: full encode | 8.7 ms | 12.6 ms |
| S4 fresh copy: full encode | 1.0 ms | 2.6 ms |
| S4 old sheet: full decode (new doc + apply) | 64 ms | 182 ms |
| S4 fresh copy: full decode | 2.6 ms | 5.7 ms |
| S4 old sheet: write + `handleOnChange` body | 9.1 ms | 10.8 ms |
| S5 old sheet: `encodeStateVector` + base64 | 0.033 ms | 0.08 ms |
| S5 old sheet: `Y.snapshot` + `encodeSnapshot` (rejected option) | 0.30 ms | 0.39 ms |

[Inference] Snapshot cost here (0.3 ms) is lower than the ticket's 3.1 ms at 142k entries. This simulation's deleted structs merge into long runs, so the delete-set scan is short. It still grows with history.

## B1: balanced remote-apply guard

**Repro** (`src/editor/utils/remote-apply-guard.test.ts`). The scheduler was first extracted with today's behaviour and the tests were run against it:

| Case | Before | After |
|---|---|---|
| 1 structural event in one window: guard depth after remount | 0 | 0 |
| 2 events in one window | **1 (guard stuck on)** | 0 |
| 5 events in one window | **4 (guard stuck on)** | 0 |
| 2 events 10 ms apart, then an owner commit: `remoteUpdateRef` | **true (commit blocked)** | false |
| Observer teardown with a remount pending: depth | **2 (leaked)** | 0 |

Before: 4 failed, 4 passed. After: 8 passed.

The teardown case is extra to the ticket. The observer effect re-subscribes when its dependencies change (for example a new `commentsForMarkers`). Its cleanup cleared the timer but never ended the guard the pending remount had begun.

## A1: content fingerprint tracker

**Correctness** (`src/editor/utils/content-fingerprint.test.ts`, 16 tests). These cover T1–T10 from the fingerprint spec, a reopen after a deleted 20-cell map, and a randomized check that runs at least 400 times. The randomized check uses two editors, nested maps, gc on and off, a reopen from one body, rows replayed in order and reversed, and merged rows.

| Implementation | Result |
|---|---|
| Counting `tr.deleteSet` only (the fingerprint spec as first written) | 14 passed, **2 failed**: after reopening a deleted 20-cell map the count was 1 against a full scan of 21; the randomized check gave 2 against 8 |
| `tr.deleteSet` below `beforeState`, plus deleted structs integrated in `[beforeState, afterState)` | 16 passed |

**Cost on the old 100-row sheet** (`after.json`, S5):

| Operation | Median | p95 |
|---|---|---|
| `getFingerprint()` | **0.020 ms** | 0.032 ms |
| One cell write with tracker attached | 0.026 ms | 0.049 ms |
| One cell write without tracker | 0.021 ms | 0.045 ms |
| Open (apply body) with tracker | 64.6 ms | 261 ms (one outlier) |
| Open (apply body) without tracker | 61.8 ms | 64.4 ms |
| `fingerprintFromUpdate(body)` | **34.9 ms** | 40.4 ms |

Budgets in the fingerprint spec:

- Tracking under 0.01 ms per transaction: met, about 0.005 ms.
- `getFingerprint()` under 1 ms: met.

Open costs about 3 ms more on a 114k-struct body.

**Finding for D5.** `fingerprintFromUpdate` decodes every struct (`Y.decodeUpdate`), which takes 35 ms on this body. Running it every 20 s cycle for background sheets is not cheap. A reader that skips struct contents and reads only the delete set is a candidate before D5 adopts it.

S1–S4 are unchanged in `after.json`. Nothing that removes them (A1's `onContentChange` prop and throttle, A2, A3) has landed yet.

**Open cost, re-measured** (`docs/perf/bench/open-cost.ts`). Runs alternate with and without the tracker, so run order and GC don't favour either side. The body has 100k structs, 99k of them deleted.

| Run | With tracker | Without |
|---|---|---|
| 1 | 51.4 ms | 50.1 ms |
| 2 | 52.5 ms | 52.0 ms |

That is +0.5 to +1.3 ms. In the main bench, the "with" case always runs first, and one run showed +14 ms. That gap comes from run order, not from the tracker.

## A1: `onContentChange` prop and throttle fix; A2: delta only on remote apply

**What changed**

- New prop `onContentChange({ hasContent, userEdited, fingerprint })`. It fires at most once per second (trailing only) and is flushed on `pagehide`, `beforeunload` and unmount. Local writes and remote applies share one throttle.
- The legacy `onChange` throttle is now trailing-only, with no `.flush()` per write. `onChange` is marked `@deprecated`.
- `userEdited` ignores these origins: `'self'`, `'remote'`, `'init'` (default-workbook seed and legacy migration), `'compaction'` (idle celldata compaction), `'dsheet-package-ingress'`, and the IndexedDB provider.
  - The ticket names only self, remote, init and the provider.
  - Compaction and ingress are added because both are automatic writes. Counting them would mark an untouched sheet as edited on open.
- A2: `SyncManager` calls `onRemoteApplied(update)` with the applied delta. It no longer calls `Y.encodeStateAsUpdate` on the remote paths.

**Correctness tests**

- `content-change.test.ts`, 25 tests:
  - `hasContent` on fixtures: empty, one cell, cleared cell, config only, two sheets, legacy plain sheets.
  - `userEdited` origin filtering, empty transactions and undo.
  - Throttle coalescing and flush.
- `SyncManager.remote-apply.test.ts`, 3 tests: the delta is passed for a live update, the merged delta once for queued contents, and nothing when decrypt fails.

**Numbers**

Same harness. "Before" is `before.json`; "After" is `after-a1-a2.json`.

| Scenario | Before | After |
|---|---|---|
| Package work per local edit, 1 tab 4000×25 | **143 ms** (write + whole-doc encode + workbook conversion) | **0.026 ms** (write + A1 change built) |
| Package work per local edit, 3 tabs | **510 ms** | **0.021 ms** |
| Per received remote update | **111 ms** (apply + whole-doc encode; noisy, 99–242 ms) | **0.009 ms** (apply only; the notifier call is a throttle tick) |
| Legacy `onChange` whole-doc encodes, 4 edits 50 ms apart | 4 | 1 |
| Legacy `onChange` whole-doc encodes, 10 edits 50 ms apart | 10 | 1 |

How to read the "after" column:

- The A1 change is built only when the throttle fires (at most once per second). The 0.026 ms "after" figure assumes it is built on every edit, so it is an upper bound.
- The legacy-throttle rows (S6) replay `editor-context`'s throttle settings with lodash in Node; they don't render the React provider. A host that still passes `onChange` pays one whole-doc encode (about 130 ms at 100k cells) per second while editing, instead of one per edit.

**A problem found and fixed while measuring.** The first A1 run gave 4.6 ms per change on a single 100k-cell tab. `Y.Map#size` walks every entry, so checking "does sheet 0 have any cell" cost O(cells). `hasContent` now stops at the first live key (`keys().next()`), which brings it to 0.026 ms. On 3 tabs the old version was already fast (0.021 ms), because more than one sheet answers the question without opening any of them.

**Browser check (demo app, dev build, built-in browser, 2026-10-23)**

Setup:

- The demo passes both `onChange` (which writes to localStorage) and a new `onContentChange` logger.
- `Storage.setItem` and `console.log` were wrapped in the page to timestamp every call.

| Case | Result |
|---|---|
| 5 commits within 205 ms | 1 `onChange` save and 1 `onContentChange`, both at 1,050 ms (trailing). The saved body holds all 5 cells. Before this change, `flushPortalUpdate` flushed on every write: one whole-doc encode per commit. |
| 5 commits over 1.4 s | 1 save at 1,425 ms. |
| Clear one cell | Fingerprint `…EGg==:1` → `…EGw==:2`; the saved body no longer has the cell. |
| Delete a tab | Deleted count 2 → 23 (the tab map and its children); 1 save. |
| Edit, then reload 150 ms later | The cell is in the saved body after reload. The `pagehide`/`beforeunload` flush ran before the 1 s throttle would have. |
| Two tabs in one collab room (dev server); owner edits H1:H2 | The receiving tab rendered them and fired 1 `onContentChange` (`userEdited: true` from its own earlier edit; fingerprint now covers 3 clients) and 1 save holding the remote cells. Both tabs and the saved body agree. |

Not explained:

- In the owner tab, H1 ended up "remote2" instead of "remote1". The receiving tab and the stored body match the owner, so the remote path carried what the owner had.
- This happened while the owner tab reconnected after its idle disconnect. It may be a remount during typing (the B3 area). The cause is not confirmed, and it was not reproduced on the base commit.

Console errors that are not from these changes:

- `[WorkbookSync] afterColorChanges/afterHideChanges: matching sheet not found` after deleting a tab. That code is untouched; whether the base commit logs it too was not checked.
- "Yjs was already imported" came from the test's own dynamic import of yjs.

**Still per edit, not yet removed**

- S3, the per-feature hook conversion, is still 28 ms (A3).
- The app side (D0) still decodes the body until dsheets.new switches from `onChange` to `onContentChange`.

## B4, B2, B6: data-loss fixes

These are correctness fixes, so "before/after" here means repro tests that fail on the pre-fix code and pass after.

How "before" was run:

- For B2 (editor side) and B6, the test file was run against HEAD's version of the source file.
- For the cell-shift cases, it was run against `cell-shift.ts` with its Yjs write removed. HEAD's `ContextMenu` shift code had no Yjs write at all.

| Fix | Test | Before | After |
|---|---|---|---|
| **B4** comment markers never write into Yjs objects | `apply-comment-markers.test.ts`: encoded doc byte-identical after markers; markers on commented cells only; stale persisted `ps` hidden without writing; comments off | 4 of 5 failed (the encoded doc grew by up to 55 bytes) | 5 passed |
| **B2** engine: `updateCell` writes the committed cell inside the commit, on the commit sheet, and passes `sheetId` to `afterUpdateCell` | `cell.commit-ydoc.test.ts` | 2 of 2 failed (no write at commit) | 2 passed |
| **B2** editor: `afterUpdateCell` writes before the data-block gate, to the passed `sheetId` | `after-update-cell.test.ts`: two joiner commits in one tick; stuck remote-apply guard; tab switch between commit and timer | 3 of 3 failed (no cell written) | 3 passed |
| **B6** Ctrl+Enter fill; insert cells shift down/right; delete cells shift up/left; `=1+1` pasted as text | `b6-ydoc-writes.test.ts`: engine writes applied to a real Y.Doc; the doc must equal the grid | 6 of 6 failed | 6 passed |

Also changed:

- Paste and autofill (four fill directions) now always put formula cells in their own batch write. Before, they left those cells to `afterUpdateCell`, which skips the write whenever the data-block gate is closed. This has no dedicated test: building a paste or fill `Context` in Node is heavy.

Not verified in the browser yet: B2, B4, B6.

Full suite: 30 files, 224 tests pass; `tsc --noEmit` is clean.

### B2/B4/B6 browser check (demo app, dev build, built-in browser, 2026-10-23)

Fresh sheet. After each action, the grid was compared with the cells decoded from the sheet's y-indexeddb rows.

| Action | Grid | IndexedDB |
|---|---|---|
| A1 = "fill", select A1:B3, Ctrl+Enter | A1:B3 = fill | same 6 cells |
| Insert cells, shift down at A2 | A2 empty, A3:A4 fill, A5 a4 | matches |
| Delete cells, shift left at B2 | B2 = c2, C2 empty | matches |
| Delete cells, shift up at A2 | column A moves up | matches |
| Insert cells, shift right at A1 | A1 empty, B1/C1 fill | matches |
| `=1+1` pasted as text into D1 | D1 = 2 | `=1+1` → 2 |
| Typed commits by a collaborator tab (B2) | "peer2" reached the owner tab | stored |
| Comment on B1, then a structural remote change (row insert from a second tab) remounts the owner with the comment loaded (B4 path) | marker on B1 | owner's next full save: 12 cells; only B1 has `ps` (set by the engine, see below); no `ps: undefined` on the other 11 |
| Reload | matches the saved cells | identical to before reload |

The paste used a synthetic `ClipboardEvent`, after a synthetic Ctrl+V keydown on the cell input. The browser denied clipboard write permission, so a real paste wasn't possible.

Found during the check; neither is caused by these changes, and neither is confirmed:

1. **The engine's comment code persists `ps` into Yjs.**
   - `newComment` writes the cell with `ps` through `updateCellYdoc` (`core/modules/comment.ts:317`). That file is unchanged on this branch.
   - So the marker is in the document, survives reload and reaches collaborators, even when the host has no comment for the cell.
   - This is outside B4, which covers `applyCommentMarkers`. The ticket's non-goal covers only cleaning up `ps` already persisted by the marker bug.
2. **The first edit in a freshly opened collab tab did not land** (seen twice: G1 "peer" in the first run, I1 "peer" in this one). The second edit landed.
   - [Inference] It may be focus in the automated browser, or a remount when the tab connects on its first edit.
   - Not reproduced by hand, and not checked on the base commit.

## A3: per-feature Yjs hooks read one field

- `getSheetYdocSyncContext` takes a `field`. It reads the old value with the new `readYdocSheetField`, which shares its conversion code with `ySheetArrayToPlain`.
- It reads the new value from `luckysheetfile[current][field]` instead of `getSheet()`, which rebuilt celldata from the dense grid.
- All 9 hooks are switched over.
- Parity test (`sheet-ydoc-sync-utils.test.ts`): every synced field of a full sheet, an empty sheet and a legacy plain-object sheet equals the whole-workbook conversion, including compacted dataVerification defs.

Same harness, 1 tab of 4000×25. The real hook runs with an editor ref backed by the engine's own `getSheetWithLatestCelldata`.

| Hook firing | Before (`before-a3.json`) | After (`after-a3.json`) |
|---|---|---|
| `calcChainYdocUpdate` | 33.9 ms | 0.005 ms |
| `dataVerificationYdocUpdate` | 33.3 ms | 0.004 ms |
| `configYdocUpdate` | 35.0 ms | 0.003 ms |

Not checked in the browser yet. A5 and A4 not started.
