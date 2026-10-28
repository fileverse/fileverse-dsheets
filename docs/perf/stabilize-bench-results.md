# Stabilize (TEC-3277): before and after numbers

Every change gets numbers measured the same way before and after.

**Status index (2026-10-26).** Sections below, in file order: baseline; A1, A2; B4, B2, B6; A3; A5; A4; C1, C2, C3, C6, C7; C8 and the C8 warm-up; C4; C5 (and C5 browser timing); B3 (and B3 browser check); B5 (and B5 browser check). Task 16 (July narrowing bug, scenario S15) and Task 17 (B5 exact tab names) are done and have sections at the end. Still to add: D3, D5 (S12), F (S13), E1–E6. Scenarios used so far: S1–S11, S14 and S15; next free are S12 and S13 (reserved by the plan for D5 and F).

B5 case rule: resolved by Task 17 (782aacd); see the Task 17 subsection at the end of the B5 section.

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
| `fingerprintFromUpdate(body)` (`Y.decodeUpdate` version, replaced 2026-10-27; now 60.8 ms) | **34.9 ms** | 40.4 ms |

Budgets in the fingerprint spec:

- Tracking under 0.01 ms per transaction: met, about 0.005 ms.
- `getFingerprint()` under 1 ms: met.

Open costs about 3 ms more on a 114k-struct body.

**Finding for D5 (superseded 2026-10-26, re-measured 2026-10-27 at 60.8 ms for the temporary-document version, see the end of this file: the ticket now builds `fingerprintFromUpdate` from a temporary document plus a delete-set scan, and the dirty check uses the body read's fingerprint; re-measure the new implementation, this number is for the `Y.decodeUpdate` version).** `fingerprintFromUpdate` decodes every struct (`Y.decodeUpdate`), which takes 35 ms on this body. Running it every 20 s cycle for background sheets is not cheap. A reader that skips struct contents and reads only the delete set is a candidate before D5 adopts it.

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

## A5: remote cell batches apply in one quiet update

What changed:

- New `WorkbookInstance.applyRemoteCells(cells, { id }, onSkip)`, backed by `api.applyRemoteCells`. The observer uses it for each sheet's remote cell batch instead of one `applyRemoteCellValue` (one `setContext`) per cell.
- The batch runs in one Immer `produce` with `noHistory`, so a collaborator's cells never land on the local undo stack. A cell that fails is reported through `onSkip`, and the rest still apply.
- The history path also calls `emitOp` → `settings.onOp`. The editor never sets `onOp`, so skipping history drops nothing.
- `patchPlainCelldata` moved to `editor/utils/patch-plain-celldata.ts`. It now finds every patched cell in one pass, with a row → column number lookup.

The first rewrite built an `"r_c"` string map over all entries. Building that map cost about as much as the 50 scans it replaced (14.6 → 12.0 ms), so it was replaced with the lookup pass.

Tests:

- `patch-plain-celldata.test.ts`: equal to the old `findIndex` algorithm on 200 randomized batches; untouched entries keep their order.
- `core/api/remote-apply.test.ts`: `applyRemoteCells` gives the same data and `calcChain` as one update per cell; a failing cell is reported and the rest apply.

Same harness, 4000×25 (100k cells), a remote batch of 50 cells (`before-a5.json` → `after-a5.json`):

| Step | Before | After |
|---|---|---|
| Plain snapshot patch (`patchPlainCelldata`) | 14.6 ms | 1.36 ms |
| Engine apply: one `produceWithPatches` per cell (today's path, minus the undo push) vs one `produce` for the batch | 73.5 ms | 2.25 ms |

The engine rows replay the engine's real `applyRemoteCellValue` with immer in Node. They don't include the React re-render that each per-cell `setContext` also caused. Off-the-undo-stack is code-confirmed (`noHistory` skips `undoList.push`), not tested in the browser.

## A4: remote formula-list changes apply in place

What changed:

- The observer used to treat a `[sheetIndex, 'calcChain']` event, or a whole `calcChain` key replacement, as structural, which meant a full grid rebuild on every peer.
- It now collects those sheets and calls the new `WorkbookInstance.setSheetCalcChain(chain, { id })` (`noHistory`) after remote cells are applied. That call sets the sheet's chain from Yjs (read with `readYdocSheetField`, same conversion as the rebuild) and resets `formulaCache` dependency indexes plus the dense-sheet cache, which is a fresh mount's state.
- The plain snapshot's chain is updated too, for later remounts.

Tests (`core/api/remote-apply.test.ts`):

- The chain is replaced, and the dependency indexes are emptied.
- A missing chain becomes `[]`.

Browser (demo app, two tabs in one collab room on the dev server). Rebuilds were counted with a `MutationObserver` that notices when the grid canvas element is replaced:

| Collaborator commits a formula (`=A1*n`) | Before | After |
|---|---|---|
| Remounts on the other tab | 1 | 0 |
| Value shown on the other tab | 10 (=5*2) | 20 (=5*4) |

Then the other tab changed A1 locally. Its B1 (`=A1*2`) and B2 (`=A1*3`) recalculated from the chain A4 had applied: 112 and 168.

Found during this check (not caused by A4 or A5):

1. **After a reconnect, the tab whose edit triggered it shows a stale grid.**
   - The edit is in Yjs and reaches the other tab, but its own grid doesn't show it until reload.
   - In one case the formula's `calcChain` entry was not written either: B3 `=A1*4` is in celldata but not in the stored chain, so peers don't recalculate it.
   - Seen 3 times in this check. It matches the "first edit in a freshly opened collab tab" note above, which predates B2.
   - [Inference] A remount during the connect/hydrate path builds the engine from a copy that lacks the edit, and the calcChain sync hook then diffs against that copy.
   - Not traced yet.
2. **`[DSheet] Compaction failed: TypeError: Cannot assign to read only property 'config'`** at `compact-committed-celldata.ts:67` (`markCompactionRevInMemory`). The file is not changed on this branch; whether the base commit logs it too was not checked.

## C1, C2, C3, C6, C7: engine hot spots

Same Node harness, 4000×25 sheet (`before-c.json` → `after-c.json`, scenario S8). It calls the engine's real functions.

| Item | Scenario | Before | After |
|---|---|---|---|
| **C1** text-measure cache | 1,000 visible texts, second frame | 1,000 of 1,000 re-measured (cache never hit) | 0 re-measured |
| **C2** conditional-format compute | `getComputeMap` per draw, 1 rule over 100k cells | 83.6 ms | 0.002 ms |
| **C3** `delFunctionGroup` | plain-value commit, 500-entry chain, 50 dynamic arrays | 0.271 ms | 0.004 ms |
| **C6** border compute | per draw, 300 border entries, 200 merges, 50×20 window | 3.13 ms | 0.001 ms |
| **C7** dropdown validation | 400 dropdown cells, 200 options each | 31.7 ms | 0.044 ms |

What changed:

- **C1:** one key builder for read and write: value, zoom, text baseline, and the font in use (`fontset` or the context's font). Callers only read the cached object.
- **C2:** last compute map per sheet. Keyed by the identities of `luckysheetfile`, the sheet's rules and `conditionRules`, the live-preview draft flag, and the draft selection while a preview is active.
  - `luckysheetfile` is used rather than the sheet's data alone, because formula rules can read other sheets.
  - The cache is bypassed inside Immer drafts: a draft keeps its identity while it changes.
- **C3:** find the entry first, then copy and splice only when found, for both `calcChain` and `dynamicArray`. Before, both lists were deep-cloned on every call.
- **C6:** two parts.
  - A per-row index of merges, built once per `config.merge` object, replaces the four scans over all merges done for every bordered row.
  - The canvas calls a new `getBorderInfoComputeRangeCached`. Up to four windows per sheet (one per frozen pane), keyed by the identities of `borderInfo`, `merge`, `rowhidden` and `colhidden`, the grid size and the drawn bounds. Bypassed inside drafts. Other callers keep the uncached function.
- **C7:** new `getDropdownOptions(ctx, txt)`: a parsed list plus a `Set`, cached per option text. For range-based options it is cached per source sheet `data` identity, and bypassed inside drafts.
  - `validateCellData` checks membership with the `Set`.
  - The canvas pill colours use a memoized `value1.split(',')`, keeping the raw split because colours are picked by position.
  - The first version still ran the range regex before the cache lookup (17.3 ms); literal lists are now looked up first.

Tests (`core/modules/engine-hot-spots.test.ts`, 12 tests):

- **C1:** a hit on a repeat; a miss on a different zoom, baseline or font.
- **C2:** a hit while unchanged; a miss with the correct new result after a data change and after a rule change; no caching inside a draft.
- **C3:** both lists keep their identity when the cell is not a formula; matching entries are removed.
- **C6:**
  - the cached result equals the uncached one and hits on a repeat;
  - each keyed change (`borderInfo`, `merge`, `rowhidden`, `colhidden`, bounds) misses and equals the uncached result;
  - all four pane windows hit on a repeat.
- **C7:** same result as the previous validation on a table of inputs (literal, duplicates and empties, multi-select, range-based, numbers, null); range options re-read after the source sheet changes.

C6 merge-index equivalence: HEAD's `getBorderInfoComputeRange` and the new one agreed on 300 randomized layouts (5,929 border entries; every border type, cell borders, merges, hidden rows and columns). This was a one-off script against a temporary copy of HEAD's file, which was removed afterwards; it is not a committed test.

Not covered:

- [Inference] C2 is still a full recompute on the first draw after any edit, because the cache is keyed on `luckysheetfile`, which changes on every edit.
- An `occurrenceDate` (today/yesterday) rule keeps its result across midnight until something on the sheet changes.

Browser: the demo grid loads and scrolls with no type errors. Conditional formats, borders and dropdowns were not checked visually.

## C8: no formula pass for a cell nothing depends on

Same Node harness (`before-c8.json` → `after-c8.json`, scenario S9, run alone with `--only=S9`). 4000×25 values, 500 `=SUM(A{r}:T{r})` formulas in column Y, graph warm after one forced full pass (drained in 50-formula chunks, as the Workbook does). One typed commit to V1001…V3000 through `updateCell`.

| Commit to an unreferenced cell | Before | After |
|---|---|---|
| Formulas whose text the pass read (each is tokenized and its ranges walked) | 500 | 0 |
| Formulas evaluated | 0 | 0 |
| `updateCell` time, median (p95), 50 runs | 3.93 ms (4.90 ms) | 0.108 ms (0.60 ms) |

"Read" is counted with a getter on each formula cell's `f`; "evaluated" by wrapping the parser's `parse`.

What changed:

- `FormulaCache.depGraphComplete` (default `false`) and `depGraphEpoch`. `markDepGraphIncomplete()` sets the flag false and bumps the epoch. `resetDependencyIndexes()` calls it.
- New `resetFormulaDependencyIndexes(ctx)`: clears `depsByCell`, `revDepsByCell` and `formulasWithWideRangeDeps`, calls `invalidateSheetsRequiredDenseCache()`, sets the flag false. `setSheetCalcChain` (A4) and the row and column drag helpers now use it (the drag helpers cleared two of the three indexes by hand).
- **Set:** at the end of a forced pass (`execFunctionGroup(..., isForce = true)`), but only when every tab holding formulas is dense: the pass skips formulas on sparse tabs. A pass of 15 or more formulas is deferred. It records the epoch on the job, and the last chunk sets the flag only if the epoch is unchanged: `runFormulaEvalChunk` on the main thread, `finishJobIfComplete` in the Workbook for worker chunks.
- **Skip:** in the narrowing block of `execFunctionGroup`. When the flag is true and the dependents set is empty, the pass returns before reading any formula. Wide-range formulas and formulas naming a defined name that covers the cell are added to that set first. The block now also runs when the flag is true and `revDepsByCell` is empty.
- **Grid-size guard:** whole-row and whole-column reads are recorded at the grid size of the pass. Completing the graph stores each dense tab's `rows x cols`. A commit to a tab whose size has changed since (for example a paste that grew the grid) clears the flag and takes the full pass. Today's full pass does not see grown rows through `X:X` either (`getcellrange` uses the configured size), so this only keeps C8 from being worse than today.
- **Cleared:**
  - index resets: mount, A4 and the drag helpers;
  - a remote formula registered without evaluation: `applyRemoteCellValue`, so A5's `applyRemoteCells` too;
  - remote ops (`applyOp`);
  - undo and redo (patches restore formulas without evaluating them);
  - `insertRowCol` and `deleteRowCol`;
  - insert or delete cells with shift;
  - cell move (`onCellsMoveEnd`);
  - `sortDataRange`;
  - `copySheet`;
  - `updateSheet`.
- **INDIRECT, OFFSET, INDEX (precondition):** formulajs implements neither INDIRECT nor OFFSET, so both evaluate to `#ERROR` whatever their arguments. Their target references never reach `depsByCell`; `=INDIRECT("A2")+B1` records nothing, because the parse stops at INDIRECT. `execfunction` now adds any formula using them to `formulasWithWideRangeDeps`, so it runs on every commit. INDEX reads its range through `callRangeValue`, so its cells are recorded; no special handling is needed.
- **Formulas naming a missing sheet:** a reference like `=Foo!A1` to a sheet that doesn't exist throws `#REF` before any edge is recorded. A later add or rename of "Foo" would then leave it stale while the flag is true. Both evaluators now flag such a formula (`callCellValue` and `callRangeValue` in `FormulaCache`; `unresolvedSheetRef` in the worker's `evalFormulasInSnapshot`, applied in `applyWorkerFormulaChunkResults`). Such formulas go into `formulasWithWideRangeDeps` and run on every commit. This covers every way a sheet can appear or be renamed: `addSheet`, `editSheetName`, `api.setSheetName`, remote ops and copies. No per-site clear is needed.
- **Paste:** no clear. Every paste path that keeps a formula evaluates it through `execfunction`, which records its dependencies. When adjusting the formula fails, the paste writes an error and does not add the cell to the chain.

Tests (`core/modules/formula.dep-graph.test.ts`, 15 tests). Fixture: 20 rows of A–T values; 500 row `SUM`s; one each of INDIRECT, OFFSET, INDEX, a named range and a whole-column `SUM`.

- The flag is false on mount and true after one forced full pass.
- INDEX, named-range and whole-column reads are in the graph; INDIRECT and OFFSET are in the wide set.
- An unreferenced commit reads and evaluates 0 formulas. With INDIRECT and OFFSET present it runs exactly those two.
- A commit to a referenced cell gives the same grid as a forced full pass afterwards.
- Cells read through INDEX, a named range or a whole column update their formula. Cells read through INDIRECT or OFFSET re-run theirs.
- A remote formula (`applyRemoteCells`) clears the flag, and a later commit to its input updates it (42, not the stale 0).
- If the graph is cleared while a deferred full pass runs, the flag stays false. A sparse tab holding formulas keeps the flag false.
- After the grid grows, the next commit clears the flag and reads all 503 formulas.
- A formula naming a missing sheet (`=Foo!A1*2`) gives 100 after a sheet is renamed to Foo and Foo!A1 is set to 50. The worker path marks the same formula always-run.
- `resetFormulaDependencyIndexes` and `setSheetCalcChain` clear the flag; the next commit reads all 503 formulas.

Not covered:

- [Inference] In the app the flag is rarely true. The only forced full passes are `recalculateAllFormulas` (after an XLSX import) and the row or column drag helpers. Opening a sheet evaluates nothing, so until one of those runs, every commit still takes today's path. Making C8 count after open needs a full pass after mount, or graph completeness tracked per formula; that is a design decision this item does not make.
- Checked only by reading the code, not by tests: find and replace and autofill call `execfunction`; Ctrl+Enter fill goes through `updateCell`. Data-block results go through `api.setCellValue` with `f` and `v`, which removes the cell from the chain.
- Sheet rename and delete do not clear the flag. Dependencies are keyed by sheet id, so a rename does not change resolved edges; formulas whose sheet name didn't resolve always run (above).
- Not checked in the browser.

### C8 warm-up: a dependency-only pass after open

Addresses the first "Not covered" point above for workbooks whose formulas all sit on the active tab (or on tabs kept dense). In a workbook with formulas on more than one tab, inactive tabs are sparse, so the warm-up never completes and C8 stays off there (see "Not covered" below). Same Node harness, scenario S14, run alone (`before-c8-warmup.json` → `after-c8-warmup.json`, `--only=S14`). 4000×25 values; 500, then 5,000 `=SUM(A{r}:T{r})` formulas (column Y, then column X). The context is opened as S9 builds it, but with no forced pass. One typed commit to V1001…V3000 through `updateCell`. In the after run, the warm-up runs first with an 8 ms budget, drained by a synchronous scheduler that times each slice. Yjs writes are counted on the `updateCellYdoc` hook, the engine's only cell-value path into Yjs.

| Commit to an unreferenced cell, after open | 500 before | 500 after | 5,000 before | 5,000 after |
|---|---|---|---|---|
| Formulas read by the commit | 500 | 0 | 5,000 | 0 |
| Formulas evaluated by the commit | 0 | 0 | 0 | 0 |
| `updateCell` median (p95), 20 runs | 5.30 ms (10.0 ms) | 0.138 ms (2.14 ms) | 37.5 ms (72.9 ms) | 0.125 ms (1.33 ms) |
| `depGraphComplete` at the commit | false | true | false | true |

| Warm-up (after run only) | 500 formulas | 5,000 formulas |
|---|---|---|
| Total time | 27.0 ms | 139.1 ms |
| Slices | 4 | 18 |
| Longest slice (includes the final merge) | 8.1 ms | 8.4 ms |
| Formulas evaluated | 500 | 5,000 |
| Yjs writes (`updateCellYdoc` calls) | 0 | 0 |

The slice budget is checked before each formula, so a slice can run past 8 ms by one formula. Numbers are from the run after fix round 1 (shadow indexes). Before that round: 26.2 / 133.4 ms total, longest slice 10.7 / 8.9 ms. A first shadow version that merged edge by edge into empty indexes had a 33 ms final slice at 5,000 formulas; adopting the shadow when the real indexes are empty removed it.

Re-warm (probe, not in S14): 5,000 formulas with the real graph already full, then `markDepGraphIncomplete()` and a second warm-up. The last slice, which includes the per-formula merge, took 8.5 ms, and the longest slice 8.8 ms.

What changed:

- New `core/modules/formula-warmup.ts`:
  - `warmFormulaDependencyGraph(ctx | getCtx, { budgetMs, schedule, isCancelled })` walks the calc chain in budgeted slices. It runs each formula through `execfunction` (no refresh, no calc-chain insert) and discards the result.
  - Dependencies are recorded into **shadow** indexes (`depsByCell`, `revDepsByCell` and the wide-range set, which also takes the unresolved-sheet and sparse-tab marks): the real ones are swapped out for each synchronous slice.
  - At completion, under the epoch check, the shadow is merged into `formulaCache`, then `finishFullFormulaPass(startCtx, epoch)` runs. If the real indexes are empty, the shadow is adopted whole. An aborted or superseded warm-up drops its shadow, so the real indexes stay exactly as they were.
  - Why shadow indexes: the commit-path narrowing in `execFunctionGroup` trusts any recorded edge, even while `depGraphComplete` is false. A partial graph published slice by slice made the formulas not yet recorded stale for a commit made during the warm-up (fix round 1).
  - `scheduleFormulaWarmup(getCtx)` runs it on `trigger()` and 2000 ms (debounced) after each `markDepGraphIncomplete()`. Slices run in `requestIdleCallback` (1000 ms timeout), or `setTimeout` without it, and only while `document.visibilityState === 'visible'`.
- `FormulaCache.onDepGraphIncomplete(listener)`: `markDepGraphIncomplete()` now notifies listeners.
- Workbook: creates the scheduler on mount (reads `contextRef`, never calls `setContext`) and triggers it once the active sheet's data is ready.
- Kept out of the warm-up:
  - error markers: `execfunction` runs on a shallow copy of the context whose `currentSheetId` matches no sheet, so `setCellError` and `clearCellError` find no grid;
  - pass caches and parser state (`execFunctionGlobalData`, range pass cache, `parser.context`, crypto denomination): saved and restored around each slice;
  - network formulas (`async` formulajs functions such as ETHERSCAN, EOA): their arguments are evaluated and recorded, but the function is not called;
  - sparse tabs: a read of one marks that formula always-run and fails, instead of hydrating the tab.
- Stale-graph guards:
  - a formula re-evaluated or removed since the warm-up started (a commit, a deferred pass) keeps its real entry: it is skipped while walking, and at merge if it changed after it was recorded;
  - a cleared graph (epoch bump) stops the warm-up at the next slice;
  - a tab holding formulas that is sparse keeps the flag false, as for a forced pass;
  - sheet sizes come from the context the walk started on, so a grid that grew meanwhile trips the C8 size guard.

Tests (`core/modules/formula-warmup.test.ts`, 18 tests):

- A commit between two warm-up slices sees the real indexes unchanged and gives the forced-pass grid (before fix round 1: 190 instead of 1190).
- An aborted warm-up leaves the real indexes byte-for-byte unchanged.
- A commit made after the shadow recorded a formula keeps its own dependencies at merge.
- `dispose()` cancels the pending idle callback (`cancelIdleCallback`), the `setTimeout` fallback and the debounce timer.

- After the warm-up the flag is true and an unreferenced commit reads and evaluates 0 formulas.
- On a deep-frozen sheet state, with `NOW()`, `RAND()`, `1/0`, a self-reference and a stale error marker: no hook is touched (including `updateCellYdoc`), `luckysheetfile`, the sheet and `calcChain` keep their identity, the undo list and every cell's `v`/`m` are unchanged, and the pass caches are restored.
- `markDepGraphIncomplete()` mid-warm-up gives `'aborted'`, evaluates nothing more, and leaves the flag false. The scheduler re-warms 2000 ms later.
- With a stub clock (3 ms per formula, 8 ms budget) every slice evaluates at most 3 formulas.
- After the warm-up, commits to referenced cells give the grid a forced full pass gives.
- A commit that rewrote a formula mid-warm-up keeps its dependencies even when the warm-up reads an older context.
- A sparse tab read by a formula is not hydrated; the formula runs on every commit and gives the right value. A sparse tab holding formulas gives `'aborted'`.
- `=FLVURL(V1)` records V1 without calling FLVURL.
- Scheduler: idle callback with timeout; `setTimeout` fallback; waits while hidden; debounced re-warm; nothing after `dispose()`.

Browser check (demo, dev build, built-in browser, 2026-10-26). A sheet with 22 formulas (`=A{n}*2`, `=SUM(A1:A20)`, `=NOW()`):

- After a reload, the flag was true with no forced pass (epoch 0, 20 reverse-dependency entries).
- Positive control: an edit through `setCellValue(..., true)` gave 1 Yjs `update` and 1 `onChange` save, so the counters were live.
- Re-warm, triggered by calling `markDepGraphIncomplete()` from the console:
  - the flag was true about 3.0 s later (2 s debounce, then idle slices);
  - 22 formulas were evaluated;
  - there were 0 Yjs `update` events and 0 `onChange` saves;
  - the context object kept its identity, so there was no state update;
  - the A1 content fingerprint and the `NOW()` value were unchanged.
- `updateCell` commit to an unreferenced cell, run through the Workbook's `setContext`:
  - with the warm graph: 0 formulas scanned and 0 evaluated, and the flag stayed true;
  - control, right after a clear: all 22 formulas scanned.
- Commit to A2: 2 formulas re-ran; B2 and C1 had the expected values.

The demo has no `onContentChange` consumer, so the A1 signal was checked through its inputs: no Yjs update and an unchanged fingerprint.

Not covered:

- Workbooks whose formulas sit on inactive (sparse) tabs keep the flag false: the C8 dense-tab guard is unchanged, and the warm-up does not hydrate tabs. Switching tabs does not re-trigger the warm-up. Since Task 16, such workbooks take the full formula pass on every commit (the 1611aee narrowing on a partial graph is gone; see the Task 16 section).
- [Inference] Re-warm churn during active collaboration: each remote formula snapshot calls `markDepGraphIncomplete`, so every quiet 2 s re-walks the whole chain (about 140 ms of idle-time work for 5,000 formulas).
- [Inference] The Workbook's `contextRef` can lag one update behind a state update that React has computed but not rendered. The re-evaluated-formula guard covers formula edits made in that window. A sheet deleted in that window could leave edges from an older context. That is the same class as "sheet delete does not clear the flag" above.

## C4: crypto-banner scan on data change, in idle time

Same Node harness (`before-c4.json` → `after-c4.json`, scenario S10, `--only=S10`). 9,900×60 grid, no BTC/ETH/SOL anywhere (the scan's worst case).

| | Before | After |
|---|---|---|
| Scans per selection change | 1 (`dataToCelldata` + `some`, inside a `setContext` updater) | 0 |
| Cost of one scan, median (p95), 15 runs | 36.0 ms (55.9 ms) | 18.3 ms (18.8 ms) |
| Scan when the first cell is a hit | n/a (always builds the full cell list first) | 0 ms |
| Scans per data change | 1 | 1, in `requestIdleCallback` |

The "0 scans per selection change" row follows from the effect's dependency list; the harness runs in Node and does not mount React. The times are the cost of one scan.

What changed:

- New `Workbook/denomination-scan.ts`: `hasDenominatedCell(data)` walks the grid and returns at the first cell whose `m` contains BTC, ETH or SOL. No intermediate cell list.
- `Workbook/index.tsx`: the banner effect depends on the flow data identity (and the current sheet id), and runs the scan and the DOM writes in `requestIdleCallback` (`setTimeout` fallback), cancelled on cleanup. The `afterSelectionChange` hook call moved to its own effect on selection changes. The DOM writes no longer run inside a `setContext` updater (the old updater returned the context unchanged).

Tests (`Workbook/denomination-scan.test.ts`, 6 tests): true for each of BTC, ETH and SOL in `m`; false when none (including BTC in `v` only); null, empty and missing rows; stops at the first hit (a later row is a Proxy that throws on access). The failing run before the module existed was an import error ("no tests").

Not covered:

- [Inference] The effect relies on the flow data array changing identity on edits, which holds when the context is updated through Immer. A mutation in place that keeps the array identity would not rerun the scan until the next identity change or sheet switch.
- The effect itself (idle scheduling, DOM writes) is not unit tested: vitest here runs in Node without a DOM. Not checked in the browser.

## C5: paste auto-fit without per-cell layout

Same Node harness (`before-c5.json` → `after-c5.json`, scenario S11, `--only=S11`). 2,000 rows × 5 columns of single-line text (2,000 distinct strings, mixed font sizes and families) through `calculateRangeCellSize`, with a stub DOM that counts `scrollWidth`/`scrollHeight` reads (each a forced layout in a browser) and canvas `measureText` calls.

| | Before | After |
|---|---|---|
| Forced layouts (`scrollWidth`/`scrollHeight` reads) | 10,000 | 0 |
| Canvas `measureText` calls | 0 | 2,000 (the other 8,000 hit the `(font, text)` cache) |
| Node time over the stub, median (p95), 10 runs | 1.73 ms (2.63 ms) | 6.28 ms (9.55 ms) |

The time row is not a browser number: the stub makes a layout read free, so it only shows the added JS cost (font string, cache lookup). The layout count is the result.

What changed:

- `measureSingleLine(font, text, ctx2d)`: canvas `measureText`, cached by `(font, text)` (cleared at 50,000 entries).
- Single-line cells take their font from `getFontSet(cell, ctx.defaultFontSize, ctx)`, the function `canvas.ts` uses to draw. This fixes the old measurer, which used `ff` as a family name and `fs` as pixels. The font string is memoized per `ff|fs|bl|it` within a call.
- Wrapped cells (`tb = 2`, inline strings, newlines) keep DOM measurement, in two batches (widths, then heights): one absolutely positioned element per cell, every write first, then every read. The wrapped DOM font also comes from `getFontSet`.
- The single-line row height formula is unchanged (`fs * 1.3 + 6`).

Tests (`calculate-range-cell-size.test.ts`, 4 tests, stub DOM): a repeat `measureSingleLine` does not call `measureText`, and a different text or font does; the font is set before measuring; for `ff: 1, fs: 12` the canvas font equals `getFontSet({ ff: 1, fs: 12 }, ...)` and there are 0 layout reads; for wrapped cells the event log is write batch, read batch, write batch, read batch. All four failed before the change.

Not covered:

- Browser 10k-cell paste time before and after was not done.
- `getColumnAutoFitWidth` (double-click column border) still uses DOM measurement; it is outside this item.
- Canvas widths can differ from DOM `scrollWidth` by a fraction of a pixel; widths are rounded up and padded by 12 as before.


### C5 browser timing (demo app, dev build, built-in browser, 2026-10-26)

`calculateRangeCellSize` called directly on 2,000 rows x 5 columns of plain single-line text (10,000 cells), real browser layout, a copy of the context so the demo sheet was not touched. Old = the file at a324b38, new = current. Five runs each, interleaved.

| Version | Runs (ms) | Median |
|---|---|---|
| Before (a324b38) | 11,817 / 11,298 / 1,816 / 1,827 / 1,834 | 1,827 |
| After, cache cleared each run | 317 / 56 / 49 / 46 / 45 | 49 |
| After, cache warm (repeat paste of same text) | 5.5 / 5.3 / 11.4 | 5.5 |

The two slow first runs of the old path (about 11 s) were not explained (cold layout or font loading is a guess). Not measured: the full paste (clipboard parse, Yjs write, render); only the sizing function.

## B3: a structural remote change during a cell edit is deferred, not dropped

**Repro** (`src/editor/utils/remote-apply-guard.test.ts`, fake timers). `legacyScheduler` in the test file is a copy of the old scheduler plus the hook's in-callback skip (edit open at fire time: no render, pending flag cleared). The same scenario (edit open for 1,000 ms, then ends) runs against it and against the new scheduler, asserting one render:

```
 × legacy: the remount is dropped when the edit was open at fire time
     → expected +0 to be 1 // Object.is equality
```

(In the committed test the legacy case asserts the buggy outcome, 0 renders and pending cleared, so the file stays green.) After: the new scheduler renders once, depth 0, pending cleared. 16 tests pass; full `npm run test:unit`: 38 files, 304 tests; `tsc --noEmit`: no errors in touched files.

What changed:

- `scheduleStructuralRemount(refs, run, delayMs, isEditing?)`: if `isEditing()` is true when the timer fires, it re-arms at 250 ms and keeps the pending flag; once the edit ends, `run` fires once. A throwing `isEditing` counts as not editing.
- **The guard is not held while pending or deferred.** `remoteUpdateRef` makes `handleChange`, `guardRemoteEcho` and `afterUpdateCell` return early. Holding depth 1 across an edit (the first version of this fix) would drop the owner's commit when the edit ends, up to 250 ms before the retry tick, and the remount would then rebuild from Yjs without it. The guard is now begun once right before `run` and ended after paint: one begin per remount (B1 holds), depth 0 afterwards. Consequence for B1: the guard is also no longer held during the 50 ms debounce wait; surgical remote applies take their own `runUnderRemoteApply`.
- `cancelStructuralRemount` only clears the timer and pending flag (nothing to release).
- `use-editor-data.tsx`: the editing check moved from inside `run` to the scheduler; `run` always re-renders.

New tests that failed against the first version (guard held while deferred): depth/flag 0 while editing (1 vs 0), commit not suppressed during deferral (true vs false), extra event adds no begin (1 vs 0), throwing `isEditing` (threw). Passing now: echo suppression is true inside `run` and until paint, then false.

Behaviour to know about:

- `needsStructuralRemount` includes the pending flag, so while a remount is deferred by a long edit, every remote surgical event on that tab is folded into the pending remount. The editing tab shows no remote changes until the edit ends, then one remount shows everything. Before, remote surgical events kept applying during the edit and the structural one was lost. Kept deliberately: a surgical apply on top of stale structure is what the remount replaces.
- The `currentDataRef` refresh also waits for the edit to end.

Not covered:

- A guard window remains: a local commit made while the remount is deferred is written at the coordinates the tab had before the structural change (see the browser check: the edit stayed at D10 on both tabs).

### B3 browser check (demo app, dev build, built-in browser, 2026-10-26)

Two tabs in one room (tab A creates the room, tab B reloads and joins it from the stored config). Sheet `A`, 84 rows on tab B.

1. Tab B: double-click D10, type `hello`, do not commit. Editor shows `hello`.
2. Tab A: insert one row at index 2 on sheet `A`. Tab A now has 86 rows.
3. Tab B, 1.5 s later, still editing: editor still shows `hello`, data still 84 rows (remount deferred, edit not interrupted).
4. Tab B: press Enter. 2.5 s later: the inserted row has arrived (the value that was at B6 is at B7), and `hello` is saved at D10. Tab A also has `hello` at D10.

Observations, not fixed here: tab B reached 84 rows against 86 on tab A (not investigated); the edit landed at D10 although the row inserted above it on tab A would put it at D11 in a coordinate-shifting model.


## B5: row/column insert and delete shift only references to the edited tab

**Before** (`src/sheet-engine/core/modules/formula.str-change.test.ts`, the new argument is ignored by the old code):

```
 Test Files  1 failed (1)
      Tests  11 failed | 3 passed (14)
 e.g. expected 'B4' to be 'B5'   (delete row on tab A, formula on tab B: `=B5` was shifted)
      expected 'D5' to be 'C5'   (insert column on tab A, formula on tab B)
      expected '4:6' to be '3:5'
```

Old behaviour: every reference was shifted whatever its prefix, so `=C!B5` on tab A and unprefixed refs in formulas on other tabs moved when a row was inserted or deleted on an unrelated tab.

**After:** `Tests  14 passed (14)`. Full `npm run test:unit`: 39 files, 318 tests pass; `tsc --noEmit`: no errors.

What changed:

- `functionStrChange(..., tabs: { editedTab, formulaTab })` (tabs last). A reference moves only when its tab is the edited tab. The prefix is unquoted (outer `'` stripped, `''` collapsed) and compared exactly, case-sensitively (Task 17; originally shipped case-insensitive); no prefix means `formulaTab`.
- `rowcol.ts`: all call sites in `insertRowCol` / `deleteRowCol` pass `editedTab = file.name` (the tab the edit happens on) and `formulaTab = ctx.luckysheetfile[SheetIndex].name` (the tab being scanned). `rewriteFormulasByScanningSheet` takes `editedTab` and uses `sheet.name`. Formula cells on other tabs were already visited by the loops; they used to be shifted unconditionally.
- The tokenizer now keeps a single-quoted tab name in one token, so `='A-B, 1'!B5` is not split at `-` or `,`. Prefix and range are split at the last `!`.

Tests (14): the six brief cases, plus nested functions, quoted names containing an operator or comma, `$`-absolute refs, delete (shift and `#REF!`), columns, whole-row and whole-column ranges. Note: for the `'Q1 2026'!B2:B9` case the insert index is 1 (0-based) so both ends are at or after it; at index 2 only the end moves, and both are asserted.

Not covered:

- Formula text rewritten by an insert is not carried to a second client (see the browser check).
- Defined names, structured/INDIRECT text refs, and formulas inside other features (conditional formatting, data validation) are not touched by this change.
- Sheet renames do not rewrite formulas here; a formula pointing at an old name is not shifted.

### B5 browser check (demo app, dev build, built-in browser, 2026-10-26)

Three tabs `A`, `B`, `C`, each with B5 filled (5, 7, 9). Formulas: A1 `=B5`, A2 `=C!B5`; B1 `=A!B5`, B2 `=B5`, B3 `=C!B5`, B4 `='a'!B5`; C1 `=A!B5`. Insert one row at index 2 on `A` through `insertRowOrColumn('row', 2, 1)`.

| Cell | Before | After | Expected |
|---|---|---|---|
| A!A1 | `=B5` | `=B6` | shifts (own tab) |
| A!A2 | `=C!B5` | `=C!B5` | unchanged |
| B!A1 | `=A!B5` | `=A!B6` | shifts |
| B!A2 | `=B5` | `=B5` | unchanged |
| B!A3 | `=C!B5` | `=C!B5` | unchanged |
| B!A4 | `='a'!B5` | `='a'!B5` | unchanged (tab `a` is not tab `A`; case-sensitive after Task 17) (derived from unit test, not re-run in browser) |
| C!A1 | `=A!B5` | `=A!B6` | shifts |

All seven match under the case-sensitive rule. The run above was done with the shipped case-insensitive rule, where B!A4 shifted to `='a'!B6`; the row shown is the Task 17 result, derived from the unit test, not re-run in the browser. The evaluator returned `#ERROR` for `='a'!B5` (lower-case tab name); that is a separate, existing evaluator behaviour. Under the case-sensitive rule the formula text is no longer shifted for that row (see the table).

Not fixed here: on a second client in the same room, the inserted row arrives but the rewritten formula text does not (tab B kept `=B5` and `=A!B5` after tab A had `=B7` and `=A!B7`). Not checked whether this predates this change.

### Task 17: B5 compares tab names exactly (2026-10-26, 782aacd)

`sameTabName` in `src/sheet-engine/core/modules/formula.ts` now uses `===` after unquoting (the `''` collapse is unchanged). The test "compares the tab name case-insensitively" became "compares the tab name exactly, case-sensitively": `addRow("='a'!B5", 'A', 'B')` stays `'a'!B5`, and `addRow('=A!B5', 'A', 'B')` gives `A!B6`.

**Before** (test changed, code not yet): `npx vitest run src/sheet-engine/core/modules/formula.str-change.test.ts`

```
The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

 RUN  v3.2.4 /Users/maitrakhatri/Developer/fileverse-dsheet

 ❯ src/sheet-engine/core/modules/formula.str-change.test.ts (14 tests | 1 failed) 8ms
   ✓ functionStrChange only shifts references to the edited tab (B5) > shifts an unprefixed ref on the edited tab 2ms
   ✓ functionStrChange only shifts references to the edited tab (B5) > leaves a ref to another tab unchanged 0ms
   ✓ functionStrChange only shifts references to the edited tab (B5) > leaves an unprefixed ref on a different tab unchanged 0ms
   ✓ functionStrChange only shifts references to the edited tab (B5) > shifts a ref prefixed with the edited tab, from another tab 0ms
   × functionStrChange only shifts references to the edited tab (B5) > compares the tab name exactly, case-sensitively 3ms
     → expected '\'a\'!B6' to be '\'a\'!B5' // Object.is equality
   ✓ functionStrChange only shifts references to the edited tab (B5) > unquotes ''-escaped names 0ms
   ✓ functionStrChange only shifts references to the edited tab (B5) > shifts both ends of a quoted-prefix range 0ms
   ✓ functionStrChange only shifts references to the edited tab (B5) > handles a prefixed ref inside a function with mixed refs 0ms
   ✓ functionStrChange only shifts references to the edited tab (B5) > does not split a quoted tab name containing an operator or comma 0ms
   ✓ functionStrChange only shifts references to the edited tab (B5) > keeps $-absolute markers 0ms
   ✓ functionStrChange only shifts references to the edited tab (B5) > delete: shifts refs below the deleted row on the edited tab only 0ms
   ✓ functionStrChange only shifts references to the edited tab (B5) > delete: a ref to the deleted row becomes #REF! only for the edited tab 0ms
   ✓ functionStrChange only shifts references to the edited tab (B5) > columns: insert shifts only refs to the edited tab 0ms
   ✓ functionStrChange only shifts references to the edited tab (B5) > whole-row and whole-column ranges respect the tab 0ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/sheet-engine/core/modules/formula.str-change.test.ts > functionStrChange only shifts references to the edited tab (B5) > compares the tab name exactly, case-sensitively
AssertionError: expected '\'a\'!B6' to be '\'a\'!B5' // Object.is equality

Expected: "'a'!B5"
Received: "'a'!B6"

 ❯ src/sheet-engine/core/modules/formula.str-change.test.ts:44:41
     42|   it('compares the tab name exactly, case-sensitively', () => {
     43|     // Tab `a` is not tab `A` (the engine resolves names case-sensitiv…
     44|     expect(addRow("='a'!B5", 'A', 'B')).toBe("'a'!B5");
       |                                         ^
     45|     expect(addRow('=A!B5', 'A', 'B')).toBe('A!B6');
     46|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 13 passed (14)
   Start at  19:33:22
   Duration  1.29s (transform 679ms, setup 0ms, collect 919ms, tests 8ms, environment 0ms, prepare 31ms)
```

**After** (same command):

```
The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

 RUN  v3.2.4 /Users/maitrakhatri/Developer/fileverse-dsheet

 ✓ src/sheet-engine/core/modules/formula.str-change.test.ts (14 tests) 4ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Start at  19:33:30
   Duration  1.14s (transform 679ms, setup 0ms, collect 905ms, tests 4ms, environment 0ms, prepare 34ms)
```

Full `npm run test:unit`: 39 files, 318 tests pass. `npx tsc --noEmit -p .`: no errors. Browser check not re-run.


## Task 16: commit narrowing only when the dependency graph is complete (S15, 2026-10-26, 627aeda)

Commit 1611aee (July) narrowed a commit's run list to the edited cell's dependents as soon as `revDepsByCell` held any entry, even with `depGraphComplete` false. A formula that was never evaluated has no recorded edges, so it was left off the list and kept a stale value. The warm-up closes most cases after open but not sheets where the flag never turns true (a sparse tab holding a formula keeps the forced pass from completing it).

**Before / after** (`npx vite-node docs/perf/bench/stabilize-bench.ts -- before-narrow --only=S15`, then `-- after-narrow`). 4000x25 values, 500 `=SUM(A:T)` formulas, one forced full pass, then a typed commit through `updateCell` to a cell exactly one formula reads. Median of 30 runs, 3 warm-ups. Flag-false: the workbook also holds a sparse tab with a formula.

| S15 | Before | After |
|---|---|---|
| flag-false sheet: formulas read per commit | 1 | 500 |
| flag-false sheet: commit median (p95) | 0.211 ms (0.718) | 3.897 ms (4.963) |
| flag-true sheet: formulas read per commit | 1 | 1 |
| flag-true sheet: commit median (p95) | 0.155 ms (0.212) | 0.158 ms (0.239) |

Plainly: every commit made while `depGraphComplete` is false now pays a full formula pass (about 3.7 ms more at 500 formulas; it grows with formulas times range size, as before 1611aee). That is slower and correct. The flag is false not only on sheets where it never turns true (a sparse tab holding a formula), but also (a) after open until the warm-up finishes, and (b) after every `markDepGraphIncomplete()` until the re-warm (about 2 s debounce plus idle slices) completes: remote formula snapshots (`Workbook/index.tsx:709`, `:782`), row/column edits, sort, move. In a collaborative room, where remote formula snapshots keep clearing the flag, the full pass is the common case. Flag-true sheets are unchanged. The old flag-false number was fast because it skipped formulas it did not know about.

What changed:

- `execFunctionGroup` (`formula.ts`): the commit narrows only when `depGraphComplete` is true. The old `revDepsByCell.size > 0 ||` condition is gone, and with it the `else if (depGraphComplete)` after `dependents.size > 0`, which is now the plain `else if`. The defined-name and wide-range additions stay inside the narrowed branch. When the flag is false the full list runs, as before 1611aee.
- Task 15's shadow-index merge and every `markDepGraphIncomplete` path are untouched.

Tests (`formula-narrowing.test.ts`, 3 tests):

1. A never-evaluated `C1 = A1*2` joins the chain after a full pass, the flag goes false with a non-empty graph, `A1` is edited through `updateCell`; `C1` must be 100.
2. Flag true: a commit to an unreferenced cell evaluates no formula.
3. Flag true: a commit to `A2` evaluates only its one dependent (`B2`), not the unrelated `E1`.

Before (today's code, test 1 fails; the first draft of the fixture had no dependent on `A1`, which falls back to the full list and hid the bug):

```
 RUN  v3.2.4 /Users/maitrakhatri/Developer/fileverse-dsheet

 ❯ src/sheet-engine/core/modules/formula-narrowing.test.ts (3 tests | 1 failed) 17ms
   × commit narrowing needs a complete dependency graph (Task 16) > a never-evaluated formula updates when its precedent is edited, flag false, graph non-empty 11ms
     → expected 10 to be 100 // Object.is equality
   ✓ commit narrowing needs a complete dependency graph (Task 16) > with the flag true, a commit to an unreferenced cell processes no formula 4ms
   ✓ commit narrowing needs a complete dependency graph (Task 16) > with the flag true, a commit evaluates only the dependents of the edited cell 1ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/sheet-engine/core/modules/formula-narrowing.test.ts > commit narrowing needs a complete dependency graph (Task 16) > a never-evaluated formula updates when its precedent is edited, flag false, graph non-empty
AssertionError: expected 10 to be 100 // Object.is equality

- Expected
+ Received

- 100
+ 10
```

After:

```
 RUN  v3.2.4 /Users/maitrakhatri/Developer/fileverse-dsheet

 ✓ src/sheet-engine/core/modules/formula-narrowing.test.ts (3 tests) 14ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  19:42:46
```

Full `npm run test:unit`: 40 files, 321 tests pass (318 plus these 3; the C8 and warm-up tests that assume narrowing after completion pass). `tsc --noEmit -p .`: no errors.

Not covered:

- The window where the flag is false (before the warm-up finishes, and after each clear until the re-warm completes) was not timed in S15; S15 measures the steady state of a never-true flag and of a true flag. Re-warm churn in collaboration (K17) makes the full pass more frequent in rooms.
- The cost is measured at one size (500 formulas, 1 dependent). Larger sheets with a never-true flag will pay proportionally more per commit; a fix is to make the flag true (hydrate or index sparse tabs in the warm-up), not done here.
- No browser check.

## D3 (package side): `rebuildLocalStore` (Task 6, 2026-10-26, commit 4d181b5)

Today the app's heal deletes the sheet's y-indexeddb database and remounts, so edits that exist only in the live document are lost. The package now offers `DSheetEditorHandle.rebuildLocalStore()`: destroy the provider, delete the database, attach a new provider to the same live `Y.Doc`, wait for `whenSynced`. The document is never replaced. The app side (calling it instead of delete-and-remount, passing `onIndexedDbError`) is in dsheets.new and is not part of this repo.

**Correctness (repro test, `src/editor/utils/rebuild-indexeddb-store.test.ts`, `fake-indexeddb/auto`).** 50 local edits are persisted, then the store is healed.

| Case | Before (delete, reopen fresh doc) | After (`rebuildIndexedDbStore`) |
|---|---|---|
| Fingerprint of a fresh doc opened on the same database name | `AA==:0` (all 50 edits lost; live doc was `AY3/48QDMg==:5`) | equals the live doc's fingerprint |
| Rows in the `updates` store after the call | n/a | exactly 1; a stale row planted before the call is gone |
| Live `Y.Doc` | n/a | same instance, content intact |

Failing run (the module did not exist yet; `task-6-failing.txt`):

```
FAIL  src/editor/utils/rebuild-indexeddb-store.test.ts
Error: Cannot find module './rebuild-indexeddb-store' imported from '.../rebuild-indexeddb-store.test.ts'
Test Files  1 failed (1)   Tests  no tests
```

Passing run (`task-6-passing.txt`): `rebuild-indexeddb-store.failure.test.ts (1 test)`, `rebuild-indexeddb-store.test.ts (5 tests)`, 6 passed.

**Time on the S4 old sheet** (100x10, 100 sessions; fake-indexeddb in Node, **not browser timing**; 10 runs; `docs/perf/bench/results/d3.json`): before (destroy, delete, reopen) median 0.5 ms (p95 12.4), cheap only because it drops the data; after (`rebuildIndexedDbStore`, rewrites the full state) median 9.44 ms (p95 11.7).

What changed:

- `rebuild-indexeddb-store.ts`: `rebuildIndexedDbStore(dsheetId, doc, current, onCreated?)`. A delete that is blocked by another tab resolves (as the app's heal util does); the new open then waits for that tab. If `whenSynced` rejects, the new provider is destroyed and the error is rethrown.
- `use-editor-sync.tsx`: `rebuildLocalStore` is a no-op when read-only, sync is off or there is no id. Concurrent calls share one promise. It never bumps the bootstrap generation: it waits for the running bootstrap; a bootstrap or refresh that starts during the write waits for the rebuild; an unmount or a new bootstrap during the write destroys the new provider and rejects. The new provider and its `'error'` listener (to `onIndexedDbError`) are set before `whenSynced`, as in the bootstrap. A failed rebuild leaves `persistenceRef` null and reports the error.
- Wired into the handle (`types.ts`, `editor-handle.ts`, `editor-context.tsx`).

Ruling: the first version bumped the bootstrap generation, which would have left a bootstrap in flight with `syncStatus` stuck on "syncing" (reviewer, Critical). Fixed as above (two fix rounds).

Tests: 6 in 2 files plus a handle-forwarding case in `editor-handle.test.ts`. Unit suite 42 files, 327 tests at Task 6; `tsc` clean.

Not covered: the hook's ordering logic (in-flight bootstrap, refresh during a rebuild, unmount during the wait) has no automated test because vitest here has no React renderer; it is covered by code review only. A blocked delete has no timeout on the new `whenSynced`. A rebuild that waits on a bootstrap started by a changed `dsheetId` or `ydoc` uses the old closure values. Not run in the browser.

## D5 (package side): `appendDsheetUpdate` (Task 7, S12, 2026-10-26, commit 4603bd9)

`appendDsheetUpdate(dsheetId, update)` in `src/persistence.ts` (shipped through the `./persistence` entry, like `mergeDsheetContent`; it is not exported from `src/index.ts`, which exports none of the persistence helpers). It adds exactly one row to the y-indexeddb `updates` store: no document is built and no full copy is written. If the database does not exist it is created with y-indexeddb's schema. The app (dsheets.new) calls it with `Y.diffUpdate(remote, localStateVector)`.

**S12** (`npx vite-node docs/perf/bench/stabilize-bench.ts -- before-d5 --only=S4`, then `-- after-d5 --only=S4`). S4 old sheet (1.08 MB body), one-cell remote change, fake-indexeddb in Node (**not browser timing**), 12 runs after a warm-up, bytes counted at `IDBObjectStore.add/put`. Both arms use the same harness (`runArm`); the before arm ran before the function existed.

| S12 | Before: `mergeDsheetContent` | After: `appendDsheetUpdate` |
|---|---|---|
| Median (p95) | 113.5 ms (155.1) in `before-d5`; 110.0 ms (162.5) in `after-d5` | 0.235 ms (3.9) |
| Bytes written to `updates` | 1,088,509 / 1,083,447 (the remote body, a full copy) | 1,580 (equal to the delta size) |
| Rows written | 1 | 1 |

The two runs differ by a few bytes because the bench uses random client ids. The time ratio is large mostly because the after arm builds no document; read the milliseconds as relative cost, the bytes as exact.

Failing run (`task-7-failing.txt`): `TypeError: appendDsheetUpdate is not a function` in 5 of 5 tests. Passing: `src/persistence.append.test.ts`, 7 tests (one row added; row bytes equal the delta; replaying all rows gives the same content, state vector and fingerprint as `mergeDsheetContent`; the live doc untouched; creates the schema on a new database; rejects a non-`Uint8Array`; rejects when `indexedDB` is missing; rejects a database without an `updates` store; a timed-out open that succeeds late closes the connection and writes nothing).

Rulings: the plan said "export from `src/index.ts`"; persistence helpers ship through `./persistence`, so this one does too (cost if wrong: none for the app, which already imports `mergeDsheetContent` from there). Reviewer Important findings fixed in one round: a late open success after a timeout wrote the row and leaked the connection; `onblocked` rejected a request that can still succeed; no `onversionchange` close.

Tests: unit suite 43 files, 334 tests; `tsc` clean.

Not covered: a delta not diffed against the true local state vector is not detected (Yjs would keep it pending). Each call adds a row, so the row count grows until the next compaction. Another tab with the database attached sees the row only on its next attach. A timeout during an in-flight add can still commit the row (a retry is safe, Yjs applies duplicates idempotently). The D5 steps in the app (hash skip, one body read, `mergeUpdates` upload body) are not part of this repo.

## F: format gate on `meta.format` (Task 8, S13, 2026-10-26, commit 71d758d)

New `src/editor/utils/format-gate.ts`: `SUPPORTED_FORMAT = 1`, `readFormatVersion(doc, dsheetId)` (missing map, key or a non-number means 1; the read does not create the map), `isFormatLocked(doc, dsheetId?)` and `watchFormatGate(doc, dsheetId, onLocked)`. The editor reads `${dsheetId}/meta` key `format` after bootstrap and observes it while open. Above 1 it locks that sheet on that doc: the grid turns read-only (`isReadOnly` the prop OR the lock; `useEditorSync` still gets the raw prop, because the combined value is in the bootstrap dependency lists and would re-bootstrap IndexedDB on lock), the write helpers return early, and the alert `This sheet was updated. Reload to continue.` shows. The lock is per doc and sheet id, and `onLocked` runs once per watcher, so an effect re-run re-locks the UI.

**Guarded writers:** `updateYdocSheetData` (and so every `*YdocUpdate`), `writeCommentAnchorsToYdoc`, `syncDefinedNamesToYdoc`, the sheet add and delete handler in `editor-workbook-sync.ts`, template apply, CSV import, XLSX import, the default-workbook init, both `migrateSheetArrayIfNeeded` calls in `use-editor-data.tsx`, and the pre-watch merge and migrate in `use-editor-sync.tsx`. Not guarded: `spreadsheet-import.ts` (writes a fresh unwatched doc; its CSV and XLSX writers are guarded).

**S13** (`npx vite-node docs/perf/bench/stabilize-bench.ts -- before-f --only=S13`, then `-- after-f --only=S13`): open cost, applying a 4000x25 body into a fresh doc with the `update` and `observeDeep` listeners, plus the gate (one map read and one observer, then unsubscribe) when the module exists. Node, not browser.

| S13 | Before (no gate) | After (gate) |
|---|---|---|
| `before-f` / `after-f` single runs, median of 25 | 379.5, 395.4, 385.8 ms | 384 to 437 ms over 8 runs |
| Paired, interleaved in one process, 40 opens per arm, 3 runs | 378.8, 378.4, 385.6 ms | 379.3, 377.4, 385.9 ms |

The same code varied between about 369 and 437 ms across separate runs on this machine, so the separate-run rows cannot show a difference. The paired rows hit both arms with the same drift: medians within 1.0 ms of each other in all three runs. The gate alone costs about 0.9 microseconds per open (2,000 fresh docs).

Failing run: no module (`Failed to load url ./format-gate`), then with the module and no guards `Tests 2 failed | 7 passed (9)` (the write helpers still wrote: state vector advanced). Passing: `src/editor/utils/format-gate.test.ts`, 12 tests (no meta map reads 1; format 2 locks once and the helpers write nothing, state vector unchanged; a doc that receives `format: 2` through `Y.applyUpdate` locks; format 1 and non-numbers do not; unsubscribe stops it; reading does not create the map or change the state vector; comment-anchor and defined-names writers write nothing when locked; lock on sheet A does not lock sheet B; re-watch of a locked sheet notifies the new watcher).

**Demo check** (built-in browser, one tab; `window.ydocRef` is the doc): a UI edit before the lock grew the doc from 15 to 16 structs; setting `meta.format` to 2 on the doc showed the alert and a read-only toolbar (17 structs, the meta write itself); typing and Enter in a cell afterwards left it at 17. Not done: the second-tab version of the check. Rig note: in the demo, edits made through the UI or `setCellValue` do not survive a reload even without the lock (control run), so persistence was not used as evidence.

Rulings: the spec says "the Yjs write helpers return without writing", so every writer reachable without the toolbar is guarded (reviewer Important: host-driven import and template paths, and pre-watch merge and migrate). Cost if wrong: a few extra one-line guards.

Tests: unit suite 44 files, 346 tests; `tsc` clean.

Not covered: no mounted-React test of the editor-context wiring (vitest has no React renderer). The permission chip still shows the prop's state and the comment toolbar item still shows while locked (its anchor write is guarded). A template apply that returns early leaves `selectedTemplate` set. `watchFormatGate` creates the empty `meta` root type. Format 2 edits already merged before this client opened are not detected until the watch starts, except where the read-only pre-watch check is used (merge, migrate).


## Audit fixes (2026-10-27, committed in 750bb33)

Found by comparing the branch with the spec (`docs/perf/stabilize-spec-audit.md`). Each has a test; the C8 walk test was run against the old behaviour first.

| Item | Change | Test | Before | After |
|---|---|---|---|---|
| A1 / D5 step 4: `DSheetContentSnapshot.fingerprint` | `snapshotDsheetDocument` adds `fingerprint` from `fingerprintFromDocument(doc)` (state vector + one delete-set scan); `null` when unavailable. Reaches `readDsheetContent`, `mergeDsheetContent` and `getContentSnapshot`. | `persistence.fingerprint.test.ts` (3): null when unavailable; equals the live tracker and `fingerprintFromUpdate` after a reopen from a compacted body (GC structs); changes on a delete-only change. | field absent | present |
| A4: undo/redo keep a collaborator's formulas | `planHistoryPatches` drops `calcChain` patches (index-addressed) and `reregisterRestoredFormulas` re-registers the restored cells from their `f`; patches that replace a whole sheet or grid are applied as before. `calcChainYdocUpdate` skips deleting a chain key whose cell still holds a formula. | `history-calc-chain.test.ts` (3), `calc-chain-ydoc-update.test.ts` (2). The first asserts that replaying the raw inverse patches drops the collaborator's entry and the planned history keeps it. | undo dropped the entry (asserted in the test) | kept |
| C8: very-large-range / named-range seeds | `collectTransitiveFormulaDependents(origin, rev, extraSeeds)`; both call sites in `formula.ts` pass the always-run formulas as seeds of the one walk instead of adding them after it. | `formula.wide-seed.test.ts` (2): `B1=SUM(A1:A20000)`, `C1=B1*2`, edit A5. | C1 stayed 40,000 (failing run) | C1 = 40,198 |
| C8: flag after HTML-table paste and cut-paste | `pasteHandler` and `pasteHandlerOfCutPaste` call `markDepGraphIncomplete()`. Copy-paste is unchanged. | `paste-dep-graph.test.ts` (2) | flag stayed true | false |
| C2: new day misses | Cache key includes `getLocalTodaySerial()` for every sheet (simpler than detecting date rules; costs one date computation per draw). | `engine-hot-spots.test.ts`: same day hits, next day misses | stale after midnight | recomputed |
| A1: legacy `onContentUpdate` | `flushPortalUpdate` flushes it per edit again. Only the whole-doc encode in `onChange` stays throttled. | none (no React renderer) | up to 1 s late | per edit |

Unit suite: 49 files, 359 tests pass; `tsc` clean. No benchmark was run for these; none is a performance change except the C2 key (one date computation per draw, not measured).

Not done from the audit: E1–E6, the browser measurements (section 6 of the spec) and the app side.


## `fingerprintFromUpdate` builds a temporary document (2026-10-27, committed in d96a8bd)

The spec (A1) rejects reading the delete ranges from the update with `Y.decodeUpdate`: a raw IndexedDB row written when the document received a compacted body carries that body's GC structs with no delete range. Audit item "implemented differently" 3 found the branch still used that approach.

**Correctness.** New test T9b (`content-fingerprint.test.ts`): a source doc replaces a 20-cell `celldata` map, the receiver applies the compacted body, then the raw `update` rows are merged with `Y.mergeUpdates`, gc on and off.

| Implementation | T9b |
|---|---|
| `Y.encodeStateVectorFromUpdate` + `Y.decodeUpdate(update).ds` | **failed**: `:2` against `:22` |
| temporary `Y.Doc`, `Y.applyUpdate`, `fingerprintFromDocument` (state vector + one delete-set scan) | passes |

**Cost** (`after-fp-doc.json`, S5 `fingerprintFromUpdate(body)`, old 100-row sheet, same harness as `after.json`):

| Implementation | Median | p95 |
|---|---|---|
| decode version (`after.json`, earlier run) | 34.9 ms | 40.4 ms |
| temporary document (`after-fp-doc.json`) | **60.8 ms** | 131 ms |

The two figures come from different runs, not interleaved; the same harness's "open (apply body) without tracker" read 61.8 ms then and 58.7 ms now, so the machine state looks comparable [Inference]. The spec's own figure for this sheet is about 90 ms. The extra cost is one `applyUpdate`, which the body read pays today. The dirty check uses the body read's fingerprint (`snap.fingerprint`), not this function; this function is for the open-time load, the legacy fallback, the backfill and the post-merge publish.

Unit suite: 49 files, 360 tests pass; `tsc` clean.


## K1 and K2: structural edits reach a second client (2026-10-27, committed in 037248b)

**Cause (K1).** `insertRowCol` and `deleteRowCol` rewrite formula text on every tab in memory, but write to Yjs only the edited tab's rows from the edit point down (`emitCellRangeToYdoc`). A formula above the edit point, or on any other tab (`=A!B5`), changed on the editing client only, and every peer kept the old text. Reproduced earlier at the Yjs level on this branch and on `main` (`.superpowers/.../k3-k1-report.md`); not a regression from this branch.

**Change.** `snapshotFormulaTexts` (before the rewrite) and `emitRewrittenFormulasToYdoc` (after) in `ydoc-celldata-changes.ts`: cells whose formula text changed are written to Yjs, on all hydrated tabs, skipping the range the existing diff already writes. `emitGridSizeToYdoc` in `rowcol.ts` writes the new `row` and `column` count in the same call path as the cells. Used by `insertRowCol` and `deleteRowCol`. No Yjs schema change.

**Cause (K2), [Inference].** The row count reached Yjs only from the `afterColRowChanges` effect, after the cells, and the peer does not read `row` on a live update (`use-editor-data.tsx` reads only `calcChain` per field). A peer that remounted between the two writes kept the old size: 84 on the peer against 86 on the editor is the pre-insert size. Not confirmed in a browser. The fix puts the size in the same synchronous path as the cells, so the window is gone, but whether this was the whole of K2 is [Unverified] until the two-tab check below is repeated.

**Tests.** `structural-edit-formula-sync.test.ts` (8): two Y.Docs, the second fed from the first's `update` events, engine with tabs A and B; a formula above the edit point and one on tab B; row insert, column insert, row delete, column delete.

| Test | Before | After |
|---|---|---|
| K1 row insert / column insert / row delete / column delete (peer formulas equal the editing client's) | 4 failed (peer kept `=B5` and `=A!B5`) | 4 pass |
| K2 row insert / column insert / row delete / column delete (peer `row` / `column` equals the editor's) | 4 failed (field not written) | 4 pass |

Unit suite: 50 files, 368 tests pass; `tsc` clean. No benchmark was run. Cost added per structural edit: one scan of every hydrated tab's grid before the rewrite (the rewrite already scans each tab once) and a write per changed formula cell; not measured.

**Not covered.**
- Values of rewritten formulas: only the formula text and the cell object are written; whether a peer recalculates them was not checked.
- Tabs that are not hydrated (K6) are skipped, so their formulas stay stale on peers as before.

### K1 and K2 browser check (demo app, dev build, built-in browser, 2026-10-27)

**Rig change.** The dev collaboration server (`wss://dev-collaboration-server-ff60826701cd.herokuapp.com`) was unreachable from the browser: a `WebSocket` to it errored and a plain `fetch` to its HTTPS address failed. The two tabs therefore did not share a room. Instead, both tabs ran the same dev build, and I relayed Yjs updates between them through a `BroadcastChannel` (`window.ydocRef` is the app's `Y.Doc`; `Y.applyUpdate` from the app's own Vite `yjs` module). This tests what reaches the Yjs doc and what the peer does with it. It does not test the collaboration server or the provider. The collaboration config key was removed from `localStorage` afterwards.

Setup: tab `A` with `A!B5 = 7`, `A!A1 = =B5`, `A!A10 = =B5`; tab `B` with `B!A1 = =A!B5`. Tab 1 inserted rows on `A` with `insertRowOrColumn('row', 1, n, 'lefttop')` while `A` was the active tab. Peer values are read from the peer's workbook context and from its Yjs doc.

| Check | Before insert (peer) | After insert 1: 2 rows (peer) | After insert 2: 1 row (peer) |
|---|---|---|---|
| `A!A1` formula, row above the insert point | `=B5` | `=B7` | `=B8` |
| `A!A10`, row below | `=B5` | `=B7` at row 12 | `=B8` at row 13 |
| `A` row count, peer workbook and Yjs `row` | 84 | **86** | **87** |
| `B!A1`, other tab | `=A!B5` | `=A!B5` (**not rewritten**) | `=A!B5` (**not rewritten**) |

So the same-tab part of K1 (the row above the insert point) and K2 (row count) are confirmed on a second client. Not confirmed: the cross-tab formula. I did not run this against the old code in the browser, so there is no browser "before" for the same-tab rows; the unit tests carry the before and after.

**Why the cross-tab formula did not move.** In the inserting tab, tab `B` had no `data` grid: its entry in the workbook context held `celldata` and `calcChain` only (`hasData: false`). It had a grid (`hasData: true`, `=A!B5` readable) only while it was the active tab, and lost it again after switching back to `A`. `rowcol.ts` skips a tab with no `data` when it rewrites cross-tab formulas (`if (!sheetData) return`), so nothing was rewritten, in memory or in Yjs. That is K6, and in this app it covers every inactive tab, not only unusual cases [Inference from one run: only tabs `A` and `B` were tried]. My `snapshotFormulaTexts` also skips tabs without `data`. The unit test for the cross-tab case passes because its tab `B` has a `data` grid.

Not checked: whether values on the peer were recalculated; the same insert with `B` active; delete and column cases; different users in the two tabs.

## PR 466 review fixes (2026-10-28, committed in a7abbed)

Six must-fix comments from the review of PR 466 (`docs/perf/pr-466-review.md`). Unit suite: 52 files, 397 tests pass (50 files, 368 tests before); `tsc` clean. Nothing was run in a browser.

| # | Item | Test | Before | After |
|---|---|---|---|---|
| 1 | Debug `afterTransaction` logger removed | none | logged and encoded the state vector on every transaction | removed |
| 6 | K1 diff: formula cells are copied into the snapshot | `structural-edit-formula-sync.test.ts`, 4 cases | merged cell above the edit: peer kept `=B5`, `=SUM(B1:B10)` (engine `=B6`, `=SUM(B1:B11)`); 5 of 6 repeated `=$B$5` stayed (engine `=$B$6`); 3 of 4 cases failed | peer equals engine in all 4 |
| 5 | Legacy `onChange` read through a ref; throttle built once per `dsheetId` | `legacy-on-change.test.ts`, 4 | a new host `onChange` rebuilt the throttle and cancelled the pending call | the latest handler is called once |
| 2 | `reregisterRestoredFormulas` in one pass (chain read into a set, batch delete) | `history-calc-chain.test.ts`, 4 new | undo of a top-row insert, 1,000 x 26 with 1,000 formulas: **6,321 ms** | **24 ms** |
| 3 | `shouldSkipEchoWrite` holds echo hooks while a structural remount is pending; `afterUpdateCell` writes the chain entry of a formula committed then | `remote-apply-guard.test.ts` 5, `after-update-cell.test.ts` 3 | echo hooks could write the engine's old chain over the peer's | held back; chain entry written with the cell |
| 4 | `waitForPersistenceSynced` (15 s, generation check) in the bootstrap and `rebuildIndexedDbStore`; a rebuild abandons a bootstrap after 3 s | `wait-for-sync.test.ts` 7, `rebuild-indexeddb-store.test.ts` 2 new | `await whenSynced` could wait forever (library source read; the hang was not run) | rejects on timeout or when superseded |

**Method for #2.** One run per row, Node, a temporary Vitest file (deleted), `insertRowCol` on a draft, then `planHistoryPatches`, `applyPatches` and `reregisterRestoredFormulas`; the same harness gave the before figure on `037248b` and the after figures here. Other sheets after the fix: 1,000 x 26 with 100 formulas 17 ms, 9,000 x 26 without formulas 138 ms. The reviewer's figures for the same cases on `037248b` were 0.43 s and 0.85 s (not re-measured here).

**Not measured / not covered.**
- The cost of copying formula cells into the snapshot (#6) on a very large sheet.
- The end-to-end repro of #3 (deferred remount, then a local formula commit), and the hook wiring of #3, #4 and #5: vitest has no React renderer.
- #5 has no failing run against the old throttle (the test file is new). #4's two new rebuild tests were not run against the old unbounded wait.
- Behaviour changes: a first IndexedDB read slower than 15 s now continues without IndexedDB and calls `onIndexedDbError`; metadata echoes are not written during a pending remount; a restored non-formula cell that is not in the chain no longer has its dependency edges dropped.

## PR 466 review fixes, second round: #7 to #14 (2026-10-28, committed in a5dcd88)

Unit suite: 54 files, 429 tests pass (52 and 397 before); `tsc` clean. Nothing was run in a browser and no benchmark was run for this round.

| # | Item | Test | Before | After |
|---|---|---|---|---|
| 7 | Unquoted sheet name stops at operators | `sheet-flowdata-lifecycle.test.ts`, 13 cases | `=A!B5` read as sheet `=A`, `=2*A!B5` as `2*A` (regex run, earlier) | `A` |
| 8 | Chain entries outside the shrunk grid are dropped on undo | `history-calc-chain.test.ts`, 2 | row insert then undo left `4_3, 1_0, 3_3` (earlier run) | `1_0, 3_3` for row and column |
| 9 | Undo/redo writes `row` / `column` | `history-grid-size.test.ts`, 4 | peer kept the grown count (review: 14 vs 12) | patches give the restored count |
| 10 | Remote formula with the same text keeps `depGraphComplete` | `remote-apply.test.ts`, 4 | flag cleared on every remote formula cell | kept; cleared for a new or changed formula |
| 11 | Cut-paste moves the chain entry | `paste-dep-graph.test.ts`, 2 | chain kept `0_1`, new place absent (review repro) | chain is `3_3` |
| 12 | Paste and fill do not persist the pre-format cell | `after-update-cell.test.ts`, 2 | two Yjs writes per formula cell (reading) | batch write only |
| 13 | WeakMap caches; `definedNames` in the CF key | `engine-hot-spots.test.ts`, 1 | cache hit after only a defined name changed (reading) | miss |
| 14 | Grid read-only in the tick the lock is seen | `format-gate.test.ts`, 4 | read-only only after the workbook data changed identity (reading) | set in the watcher callback |

**Not measured / not covered.**
- #10 timings (the reviewer's 500 / 2,000 / 5,000-formula table) were not re-measured.
- #12: the call sites in `dropCell.ts` and `paste-internals.ts` are not tested; the double write was not counted.
- #13: no GC-based test of the memory release.
- #14: the browser behaviour of a commit between the lock and the remount was not run.

## PR 466 review fixes, third round: #15 to #18 (2026-10-28, committed in 291c398)

Unit suite: 54 files, 439 tests pass (429 before); `tsc` clean. Nothing was run in a browser and no benchmark was run for this round.

| # | Item | Test | Before | After |
|---|---|---|---|---|
| 18 | Guard ended when `rehydrateWorkbookFromYdoc` throws | `remote-apply-guard.test.ts`, 3 | a throw left the depth above zero (reading) | depth 0, error rethrown |
| 15 | Paste flag only for object pastes | `paste-dep-graph.test.ts`, 2 new | plain-text and blocked pastes cleared `depGraphComplete` | flag stays on |
| 17 | Copies of calcChain entries | `remote-apply.test.ts`, 1 | Immer could freeze objects Yjs holds (`toJSON` returns them by reference, reading) | caller's entry unfrozen |
| 16 | One Yjs update per structural edit | `structural-edit-formula-sync.test.ts`, 4 | 2 `update` events on an insert in the test setup (the reviewer counted 4 and 5 with all emits present) | 1 for row/column insert and delete |

**Not measured / not covered.**
- The hook wiring of #18 and #17 (no React renderer).
- #16: the 4 / 5 counts of the review were not reproduced (the test setup has no format ranges and no beyond-grid deletes on an insert); the cost of the batch was not measured.
- #15 against the old code: the plain-text test fails on the old top-of-function call by construction; it was not run against the old file.

## E1–E6 Before: render baseline (2026-10-28, nothing changed yet)

Measured before any E change, at `1b838d6` plus the demo-only counter. Method: demo dev build (`npm --prefix demo run dev`, port 5000), built-in browser, 1024x768, URL `http://localhost:5000/?perfRender=1`. The counter is `demo/src/perf-render.ts`, imported first in `demo/src/main.tsx`; it installs a DevTools-style hook (`__REACT_DEVTOOLS_GLOBAL_HOOK__`) before react-dom loads and counts, per root commit, the fibers that re-rendered (`PerformedWork`, descending only where the `child` pointer changed, as DevTools does). `window.__perfRender.reset()` / `.snapshot()`. No package source is touched. Reference sheet: `docs/perf/bench/e-baseline-setup.js` (100 rows x 10 columns, two fill colours, bold column, a 100-cell dropdown column, 2 conditional-format rules, a `borderInfo` config). Interactions are real browser events (click, wheel, mouse move, key), each followed by a 1 s wait. Dev build, so `React.StrictMode` double rendering is not in play (the demo does not use it). Counts are component renders per interaction, `commits` are React root commits.

| Interaction | Root commits | Component renders | Sheet | SheetOverlay | Toolbar | SheetTab | SheetItem | ContextMenu | FilterMenu | SheetTabContextMenu | SVGDefines | NotationBoxes | FxEditor | InputBox | ScrollBar |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 scroll tick down | 2 | 798 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 2 |
| 1 scroll tick up | 2 | 798 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 2 |
| 10 scroll ticks (5 down, 5 up) | 20 | 7,980 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 20 |
| Mouse move inside one cell (1st) | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Mouse move inside one cell (2nd) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Mouse move to the next cell | 1 | 13 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 2 |
| ArrowDown (two runs, identical) | 3 | 824 | 1 | 1 | 1 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 2 |
| One keystroke in the cell editor | 1, then 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Enter commit of a typed value (two runs, identical) | 6 | 1,625 | 2 | 2 | 2 | 3 | 3 | 2 | 2 | 2 | 2 | 2 | 2 | 3 | 4 |

Counters over 10 scroll ticks, same run: the document `paste` listener was added 10 times and removed 10 times (E4: one rebind per context update); `window.__dsheetRef.current` took 11 distinct values (E3: the handle was rebuilt about once per tick, the original plus 10); `HTMLElement.innerText` was read 90 times (E6: 9 reads per tick, from `SheetOverlay` and elsewhere; the patch counts every read on the page, not only `SheetOverlay`'s two, so the E6 After number must be compared the same way).

**What this says about the plan** (read from the numbers; the cause for each row is [Inference] until the change is made):
- Scroll, arrow keys and commits re-render Toolbar, SheetTab, ContextMenu, FilterMenu, SheetTabContextMenu and SVGDefines once per context update, as the spec says. 798 component renders per scroll tick is mostly the Toolbar's UI-library subtree (the 14 most-rendered names in a first, inflated run were Radix tooltip and popper components).
- A mouse move inside one cell already costs 0 component renders (the context update produces no change, so React bails out). E1's saving is therefore not in render counts but in the work inside the `setContext` recipe (`overShowLinkCard`, `handleOverlayMouseMove`, `getElementsByClassName` plus `getBoundingClientRect` on each move). That was not timed here. A per-move time (a long-task or `performance.now()` bracket around the recipe) is needed as the E1 Before/After number. Moving to a new cell costs 13 renders.
- A keystroke in the cell editor costs 0 renders: typing goes to the contenteditable and does not touch the context in this build. The spec's "keystroke in the cell editor" row is not borne out here; leave it out of the targets, or find the path that does re-render (for example formula-bar mirroring).
- An Enter commit runs 2 context updates (Sheet rendered 2 times). E5's target is 1.

**Not measured, and why:** render time (React Profiler at 4x CPU) because the built-in browser does not expose a CPU throttle here (not checked further); forced layouts from `SheetOverlay` in a 90-frame recording (E6 uses the `innerText` read count above instead, a proxy: `getBoundingClientRect` and layout-triggering reads are not counted); borders were set through `config.borderInfo` and were not confirmed visually in the grid.

**Rig notes:** the demo does not persist edits across a reload, so the sheet is rebuilt by pasting `e-baseline-setup.js` after each load. `getWorkbookContext()` reads right after a write return the old grid for about a second (a remount follows the Yjs echo); wait 3 s before reading. Writing past the grid (100 rows into the 84-row default) throws in `setCellValue` and unmounts the Workbook; insert rows first.

### E1 Before: cost of one mouse move (2026-10-28)

Same rig and sheet as above. Synthetic `mousemove` events dispatched on `document` (the listener is `document.addEventListener('mousemove', onMouseMove)` in `SheetOverlay`), 200 moves per run, 3 runs per case after a 30-move warm-up, one `setTimeout(0)` yield between moves. "Sync" is the time `dispatchEvent` takes (the handler, including the `setContext` recipe that React runs eagerly). Points: same-cell alternates two points 4 px apart in the middle of a cell; cross-cell alternates two points 150 px apart (a different column each time). Dev build, no CPU throttle, 100-row reference sheet.

| Case | Sync per move, median (3 runs) | Commits per 200 moves | Component renders per 200 moves |
|---|---|---|---|
| Move inside one cell | 4.2, 4.2, 4.2 ms | 0 to 2 | 0 to 13 |
| Move to a different cell each time | 4.0, 4.0, 3.7 ms | 199 | 2,587 (13 per move) |
| Empty `setContext` recipe (for comparison) | 0.3 ms | 200 | 0 |

Split of the same-cell cost, measured by wrapping the calls during 200 moves: `getBoundingClientRect` 4.0 calls and 0.005 ms per move, `getElementsByClassName` 2.1 calls and 0.001 ms per move. So with a clean layout the forced-layout reads are negligible; about 3.9 ms of the 4.2 ms is inside the recipe's `overShowLinkCard` and `handleOverlayMouseMove` bodies (not profiled further, [Inference] from subtraction: 4.2 minus 0.3 empty-recipe overhead minus 0.005).

Consequence for E1: moving the rectangle read out of the recipe saves almost nothing here. The saving comes only from not entering the recipe at all on a same-cell move (skip `overShowLinkCard` and `handleOverlayMouseMove` when no drag, resize or selection is in progress and the hovered cell is unchanged), which is the spec's second bullet. The After number to beat: about 4.2 ms per same-cell move. A same-cell move costs 0 renders today, so render counts cannot show E1. Layout reads were measured with a clean layout; if the page is dirty (a pending style change) each `getBoundingClientRect` would force layout and cost more; not measured.

Caveats: synthetic events skip browser hit-testing and cursor updates; times are one machine, one run of the dev server. The Workbook-level `produceWithPatches` cost with an empty recipe (0.3 ms) stays after E1 on moves that do call `setContext`.

## E5 and E6 (Tasks 13 and 14, 2026-10-28, not committed)

### E5: shown comments applied only when the set changes

**What changed.** `NotationBoxes/index.tsx` keeps the key of the last applied shown-comment set in a ref and calls `setContext(showComments)` only when the key differs. New pure helpers in `NotationBoxes/shown-comments.ts`: `collectShownCommentCells(data)` and `shownCommentsKey(sheetId, cells)`. The sheet id is part of the key so a sheet switch to an equal set still replaces the previous sheet's boxes. The grid scan itself is unchanged (still O(cells) per data change).

**Tests** (`shown-comments.test.ts`, 4): shown cells listed row by row; same key when the shown set is unchanged even if other cells change; different key when a comment is shown or hidden; different key on another sheet. Red run: `Failed to load url ./shown-comments` (module missing); green: 4 passed.

**Before and after, same method** (reference sheet, Enter commit of a typed value, `commentBoxes` read through `getWorkbookContext()` before and after the commit; Before measured by temporarily restoring the old file):

| | Before (old file) | After |
|---|---|---|
| `ctx.commentBoxes` replaced by a commit | yes (new array each commit) | no (same identity) |
| Root commits per Enter commit | 6 | 6 |
| Component renders per Enter commit | 1,625 | 1,625 |
| `Sheet` renders per Enter commit | 2 | 2 |

**The render counts did not move.** The spec expects the second context update per commit to go away. In this build the skipped `showComments` update was replaced by another update in the same slot, so the pass still happens. [Inference] The likely source is the Sheet effect that rebuilds row and column offsets after every data change (`dsheet-stabilize-followups-spec.md` G1, out of scope here); not verified. So E5 as shipped removes the immer produce and the `commentBoxes` churn, not a render pass. The spec's "one context update per commit" target is not met until the other update is found.

**Not covered:** pinned comments shown or hidden by a user in the browser (the key logic is unit tested, the toggle path was not exercised); a shown comment whose cell moves because of a row height change with no data change (the old effect did not recompute on that either).

### E6: no `innerText` reads in SheetOverlay unless a cell is being edited

**What changed.** New `SheetOverlay/editing-as-formula.ts`: `isEditingAsFormula(editing, readCellInputText, readFxInputText)` reads neither input unless `editing` is true, and reads the formula bar only if the cell input did not already answer. `SheetOverlay/index.tsx` uses it, and `isFormulaReferenceInputMode(context)` is now behind `editingSheetCell &&`, as `core/events/keyboard.ts` already does. The second guard goes beyond the two reads the spec names: `isFormulaReferenceInputMode` reads `innerText` too and ran on every render.

**Tests** (`editing-as-formula.test.ts`, 5): no reads while not editing; true for `=` in the cell input; true for `=` only in the formula bar; false for plain text and trimmed before checking; the formula bar is not read when the cell input decides. Red run: `Failed to load url ./editing-as-formula`; green: 5 passed. The second guard (`editingSheetCell && isFormulaReferenceInputMode`) is inline in the component and has no unit test (no React renderer in vitest).

**Before and after** (10 scroll ticks, 5 down and 5 up, same sheet and counter as the Before baseline; every `HTMLElement.innerText` read on the page, with the calling site):

| | Before | After |
|---|---|---|
| `innerText` reads over 10 ticks | 90 | 50 |
| Of those, from `SheetOverlay` (direct reads and `isFormulaReferenceInputMode`) | 40 (4 per tick) | 0 |
| Remaining: `InputBox.tsx` | 20 | 20 |
| Remaining: `CellDatePicker.tsx` | 20 | 20 |
| Remaining: `FxEditor/index.tsx` | 10 | 10 |

The Before split by site is from the first (inflated-stack) run of the After rig (65 reads, 11 updates, with `isFormulaReferenceInputMode` called from SheetOverlay 11 times, `InputBox` 21, `CellDatePicker` 22, `FxEditor` 11); the Before total of 90 is from the baseline run. The 40 reads attributed to SheetOverlay is 90 minus 50, not a measured per-site count for the Before run.

Not removed: the other three components still read `innerText` on every render (5 per tick). They are outside E6's stated scope; a follow-up could apply the same guard.

**Browser check:** typing `=SUM(B1:B3` into a cell and pressing Escape worked and left the page without new console errors. The formula-range outline suppression was not checked visually. Layout cost in milliseconds was not measured; the read count is a proxy.

**Totals after Tasks 13 and 14:** unit suite 56 files, 448 tests pass (439 before, plus 4 and 5); `tsc --noEmit` clean.

### E5 follow-up: where the second update per commit comes from (2026-10-28)

**Method.** A temporary logger in `setContextWithProduce` (`Workbook/index.tsx`, removed afterwards; `git diff` of that file is empty) recorded, for every call during one Enter commit on the demo sheet: the call-site stack, how many Immer patches the recipe produced, and which top-level context keys changed. Same rig as above (demo dev build, built-in browser, `?perfRender=1`); this run used the default 84-row demo sheet rather than the 100-row reference sheet. The render counter showed 6 root commits and 2 `Sheet` renders, the same as the reference sheet.

**Result.** Six `setContext` calls per commit, two of which change anything:

| # | Call site | Patches | Context keys changed |
|---|---|---|---|
| 1 | `SheetOverlay/InputBox.tsx` (`setFormulaEditorOwner`) | 0 | none |
| 2 | `Workbook/index.tsx` key handler (`handleGlobalKeyDown`, the commit itself) | 5 | `luckysheetfile`, `luckysheet_select_save`, `luckysheet_selection_range`, `formulaRangeHighlight`, `luckysheetCellUpdate` |
| 3 | `InputBox.tsx` effect (selection recipe) | 0 | none |
| 4 | **`Sheet/index.tsx:59` effect, `updateContextWithSheetData(draftCtx, data)`** | 3 | `visibledatarow`, `visibledatacolumn`, `luckysheet_select_save` |
| 5 | `InputBox.tsx` effect | 0 | none |
| 6 | `InputBox.tsx` effect (selection recipe) | 0 | none |

So the second real update is the `Sheet` effect that rebuilds the row and column offset arrays whenever `data` changes identity, which is item G1 in `dsheet-stabilize-followups-spec.md` (out of scope for P1). The `NotationBoxes` update no longer appears in the log, which confirms the E5 skip works. Calls with 0 patches return the same state and cause no render.

**Why E5's render counts did not move.** [Inference] Before E5, the `NotationBoxes` `showComments` update and the `Sheet` effect's update both ran in the same passive-effect flush and were batched into one render pass; removing the first leaves the second, so the pass count is unchanged. The spec's target "one context update per commit" therefore cannot be reached by E5 alone: it also needs G1 (guard the `Sheet` effect so unchanged offsets keep their identity). That was not tried here.

**Consequence for the plan.** E5 is worth keeping for the `commentBoxes` identity and the skipped immer produce, but its render-count target depends on G1. Either pull G1 into P1 or drop the "one update per commit" claim from the E5 target.

## E1: a mouse move inside one cell no longer runs the context update (Task 9, 2026-10-28, not committed)

**What changed.** New `SheetOverlay/hover-tracker.ts`:
- `createHoverTracker({ getRect, locate, isInteracting, requestFrame })` with `shouldProcess(event)` and `reset()`. A move that stays in the cell of the previous processed move, with nothing in progress, returns false and `SheetOverlay`'s `onMouseMove` returns before `setContext`. The cell-area rect is read at most once per animation frame (cached, invalidated by `requestAnimationFrame`); it is not read at all while interacting.
- `isHoverInteractionActive(ctx, globalCache)` is the "run every move" predicate: a comment box resizing or moving, an image in progress, the search dialog or range-selection modal moving, cells being dragged (`luckysheet_cell_selected_move`), and any open popup that must see the pointer leave it (`hoveredCommentBox`, `editingCommentBox`, `hoverErrorBox`, `linkCard`). These are the states `handleOverlayMouseMove`, `overShowLinkCard` and the hover-popup code read. When any is set, every move takes the old path.
- `SheetOverlay/index.tsx`: the tracker is built once (`useMemo`) and reads the latest context through a ref, so the document `mousemove` listener keeps its identity. `reset()` runs when the sheet's grid (`getFlowdata`) changes identity, so a comment added or a sheet switch is seen by the next move in the same cell.

**Tests** (`hover-tracker.test.ts`, 19; the module did not exist for the red run: `Failed to load url ./hover-tracker`; green: 19 passed). They cover: three moves in one cell give one change; a cross-cell move gives another; every move while interacting; the first move after an interaction ends is processed even in the same cell; the rect is read once per frame and again after a frame, and never while interacting; leaving the cell area is one change and later outside moves are ignored; `reset()`; and each of the ten conditions in `isHoverInteractionActive`, plus the idle case. Full suite: 57 files, 467 tests pass; `tsc --noEmit` clean.

**Before and after, same method** (the E1 Before method: synthetic `mousemove` on `document`, 200 moves per run, 3 runs, 30-move warm-up, one `setTimeout(0)` yield between moves, 100-row reference sheet, dev build). "Sync" is the `dispatchEvent` time.

| Case | Before: sync median | After: sync median | Before: commits / renders per 200 moves | After: commits / renders per 200 moves |
|---|---|---|---|---|
| Move inside one cell | 4.2, 4.2, 4.2 ms | **0.0, 0.0, 0.0 ms** (mean 0.25, 0.18, 0.18; p95 2.6, 1.5, 1.5) | 0 to 2 / 0 to 13 | 0 to 1 / 0 to 13 |
| Move to a different cell each time | 4.0, 4.0, 3.7 ms | 3.6, 3.7, 3.7 ms | 199 / 2,587 | 199 / 2,587 |

A same-cell move now costs about nothing on the main thread. A cross-cell move is unchanged (it still takes the full pass, 13 renders per move). The residual mean of 0.2 ms and the 1.5 to 2.6 ms p95 are, [Inference], the once-per-frame rect read after a frame boundary.

**Browser checks** (real mouse events, built-in browser):
- Hover comment popup: set a comment on one cell; entering the cell showed `comment-box-5_2` (`hoveredCommentBox` `5_2`); a move inside the cell kept it; leaving the cell removed it; re-entering showed it again. This is the case that needed the "popup open runs every move" rule.
- Drag selection from one cell to another still selected the right range (rows 2 to 5, columns 1 to 3).

**Not checked in the browser:** error hover popup, link card show and hide, comment box or image drag and resize, search dialog drag, cell drag-move (these are covered only by the predicate's unit test and by the rule that any of them sets the "run every move" path); cursor changes at resize handles; touch and pen input; frozen panes (`locate` uses the same `fixPositionOnFrozenCells` as the existing code but was not exercised with a freeze).

**Known limitation.** Moves inside one cell skip `overShowLinkCard` and `handleOverlayMouseMove` entirely. Anything that depends on the pointer position within a cell, as opposed to which cell it is in, and is not in the predicate, would stop updating. None was found in the code read (`overShowError` and the hover popup work per cell), but this was read, not exhaustively tested.

## E3: a stable editor handle (Task 11, 2026-10-28, not committed)

**What changed.**
- `Workbook/stable-handle.ts`: `createStableHandle(getLatest)` returns an object with the keys of the api, whose identity never changes. Each function member calls the function of the same name on the latest api; any other member is a getter on the latest api.
- `Workbook/index.tsx`: `generateAPIs(...)` is still called with the current context and arguments after every render, in a `useLayoutEffect` without a dependency list (the same timing the old `useImperativeHandle` ran at), and stored in `latestApiRef`. `useImperativeHandle(ref, ..., [])` now builds the stable handle once per mount. `workbookInstanceRef` points at the stable handle.
- Keeper trigger (host side): the host's ref callback, which called `activeSheetKeeper.onAttach` on every attach, now runs once per mount, often before the sheets load. `editor-context.tsx` gets `notifyActiveSheetChange()` (calls `onAttach` with the current workbook and mount key); `editor-workbook.tsx` passes it as the Workbook's `afterActivateSheet` hook, which the Workbook already calls on mount and whenever `currentSheetId` changes.

**Deviation from the spec text.** The spec says `generateAPIs` should read the context through a ref so it is built once. This keeps `generateAPIs` unchanged (it is rebuilt per render, as before) and gives the host a handle that delegates to the latest one. The observable result the spec asks for (the host's ref callback does not re-run per update, the handle is stable) is the same. The cost of building the api object per render (about 80 closures) is unchanged from before, and was not measured. Building it once, as the spec describes, needs about 100 call sites in `api.ts` changed; not done.

**Tests.**
- `stable-handle.test.ts` (5): same keys and stable identity; calls the latest api after it is replaced; forwards arguments and the return value; non-function members read the latest value; a host can assign extra methods onto the handle. Red run: `Failed to load url ./stable-handle`; green: 5 passed.
- `active-sheet-keeper.test.ts` (4, new): characterization tests of the keeper as it is today, which had none: records and restores once per mount key; waits when the new mount has no sheets and does not mark the mount handled; does not restore a sheet that is gone. These passed before any change (they pin the contract E3 depends on, they were not red-first).
- The `afterActivateSheet` wiring and the layout effect have no unit test (no React renderer in vitest).
- Full suite: 59 files, 476 tests pass; `tsc --noEmit` clean.

**Before and after, same method** (demo dev build, 10 wheel scroll ticks, `window.__dsheetRef.current` sampled every animation frame, distinct values seen):

| | Before | After |
|---|---|---|
| Distinct editor handles over 10 scroll ticks | 11 (the original plus one per tick) | **1** |

Each new handle is a ref-callback call on the host (`setSheetEditorRef`, which also re-runs `attachDSheetEditorHandle` and the keeper), so the host callback runs about once per mount now instead of once per update; the callback was not counted directly.

**Browser checks.**
- The handle exposes 80 members including the host methods `refreshIndexedDB` and `rebuildLocalStore`; `setCellValue` followed by `getCellValue` returned the new value (the handle reads the latest context); a typed edit committed with Enter reached the grid (`e3ok` in the expected cell); no new `TypeError` in the console.
- Keeper, remount case: added a second sheet and made it active, then forced a remount by bumping the host's `forceSheetRender` state through the React fiber (a test rig, not a product path). With the new trigger the second sheet was still active after the remount (`3beaae`). Control with the trigger temporarily disabled: the active sheet reset to the first sheet (`79b918`), so the trigger is what restores it. The control edit was reverted (`grep TEMP-DISABLED` finds nothing).

**Not covered.** A remount while collaborating with a peer; the host in dsheets.new and ddocs.new (they pass their own `hooks` and may pass `afterActivateSheet`, which would replace the keeper's trigger: this repo's `editor-workbook.tsx` does not merge host hooks, not checked for the packaged component); a Workbook whose `currentSheetId` is set before its sheets exist (the keeper would not be re-triggered); the time cost of rebuilding the api per render; hosts that hold a method from the handle across a remount (they now get a method that keeps working on the old handle until the host re-reads the ref).

## E2: heavy UI no longer renders on scroll (Task 10, 2026-10-28, not committed)

**What changed.**
- `react/context/workbook-store.ts` (pure): `createWorkbookStore` (one value, `getState`, `setState`, `subscribe`), `createSelection(store, selector, isEqual)` (the snapshot logic: returns the last handed-out value while `isEqual` says the new one is the same), `onlyIgnoredKeysChanged(keys)`, and `contextEqualIgnoringScroll`, which ignores `scrollLeft`, `scrollTop`, `visibledatarow` and `visibledatacolumn`.
- `react/context/use-workbook-store.ts`: `useWorkbookSelector(selector, isEqual)` on `useSyncExternalStore`, and `useWorkbookContextIgnoringScroll()`, a drop-in for `useContext(WorkbookContext)` that returns the same shape (`context`, `setContext`, `settings`, `refs`, `handleUndo`, `handleRedo`), but with the latest context from the store, and re-renders the component only when a key outside the ignored four changed.
- `react/context/index.ts`: new `WorkbookStableContext` (store, `setContext`, `settings`, `refs`, undo and redo), whose value only changes when those change.
- `Workbook/index.tsx`: creates the store once, sets it to the latest `context` in a layout effect after each commit, and provides `WorkbookStableContext`.
- Converted to `useWorkbookContextIgnoringScroll`: `Toolbar` (both consumers), `CustomBorder`, `FunctionListButton`, `SheetTab`, `SheetItem`, `ContextMenu`, `FilterMenu`, `SheetTabContextMenu`, and `useRemoveDuplicatesDialog` (a hook the Toolbar calls; it kept the Toolbar subscribed to the full context until it was converted). `React.memo` on `Toolbar`, `SheetTab`, `ContextMenu`, `FilterMenu`, `SheetTabContextMenu` and `SVGDefines`.

**Deviation from the spec.** The spec has each component list the fields it reads. Reading is not enough for a 2,352-line Toolbar that also passes `context` to helpers, so this uses an ignore list instead: a component renders on any change except the four keys below. The default is therefore "render", and a missed read cannot leave a stale toolbar. The four keys were chosen from measurement: comparing the top-level context keys before and after each interaction in the demo, a scroll tick changes only `scrollTop`; a cross-cell mouse move changes none; ArrowDown changes only `luckysheet_select_save`; an Enter commit changes `luckysheetfile`, `visibledatarow`, `visibledatacolumn`, `luckysheet_select_save`, `luckysheet_selection_range`, `formulaRangeHighlight` and `luckysheetCellUpdate`. `grep` found no read of those four keys in `Toolbar`, `SheetTab` or `ContextMenu` (including the filter and sheet-tab menus), and the helpers called with the context (`updateCellsDecimalFormat`, `convertCellsToCrypto`, `isHyperlinkCreationBlocked`, `captureLinkEditorOpenSnapshot`) read only `luckysheet_select_save`, `luckysheetCellUpdate` and `currentSheetId`. Not every function reachable from those components was read.

**Tests** (`workbook-store.test.ts`, 14; the module did not exist for the red run, and the `contextEqualIgnoringScroll` tests failed with "not a function" before it was added): store notifies on change, not on the same state, not after unsubscribe; the selection keeps its snapshot while the selected value is equal, changes when it changes, runs the selector once per state, compares against the last handed-out snapshot; `onlyIgnoredKeysChanged` cases; scroll position and rebuilt offsets are no change, selection and sheet changes are. The hooks, the layout effect and the component conversions have no unit test (no React renderer in vitest). Full suite: 60 files, 490 tests pass; `tsc --noEmit` clean.

**Before and after, same method** (reference sheet, demo dev build, render counter; "After" run with all of the above in place):

| Interaction | Before: commits / renders | After: commits / renders |
|---|---|---|
| 1 scroll tick | 2 / 798 | 2 / **54** |
| 10 scroll ticks | 20 / 7,980 | 20 / **540** |
| ArrowDown | 3 / 824 | 4 / 834 |
| Enter commit of a typed value | 6 / 1,625 | 7 / 1,658 |

Per scroll tick, `Toolbar`, `SheetTab`, `SheetItem`, `ContextMenu`, `FilterMenu`, `SheetTabContextMenu` and `SVGDefines` went from 1 render each to 0; what still renders is `Sheet`, `SheetOverlay`, `NotationBoxes`, `FxEditor`, `InputBox` and `ScrollBar`. Mouse moves cost 0 renders in the Toolbar family before and after.

**Costs and what is not met.**
- Selection changes and commits cost one more root commit (3 to 4 and 6 to 7) and about 10 to 33 more renders: the converted components now update in a second pass, from the store notification after the Workbook's commit, instead of in the same pass.
- The spec's "a commit outside the selection does not render these" is not met: a commit changes `luckysheetfile`, which the Toolbar reads through the selected cell's format, so it still renders. Only scroll, hover and offset rebuilds are skipped.
- The `FunctionList`, `FxEditor`, `InputBox`, `SheetOverlay` and the other 40-odd `useContext(WorkbookContext)` consumers are unchanged.
- A first attempt only converted the Toolbar's two direct consumers and did not reduce Toolbar renders: `useRemoveDuplicatesDialog` still read the full context. Found by reading the Toolbar fiber's context dependencies in the browser.

**Browser checks.** Selecting a bold cell turns the Toolbar's bold button yellow (computed `background-color` `rgb(255, 223, 10)`) and selecting a non-bold cell clears it, so the Toolbar still follows the selection; the selection stat shows `Sum: 51` for B2:B4 (51 expected); adding a sheet shows the new tab and activates it; right-click opens the cell context menu. Not checked: the filter menu, the sheet-tab context menu, the function list, the border popover, undo and redo from the toolbar, popovers opened while scrolling, formula editing with the Toolbar, and a second client.

**Known gaps.** Indentation of the Workbook JSX inside the new `WorkbookStableContext.Provider` was not re-formatted (it would re-indent about 280 lines); `eslint` reports it as prettier errors in that file, like the other pre-existing ones.

## E4: paste listener bound once, function list memo narrowed (Task 12, 2026-10-28, not committed)

**What changed.**
- `Workbook/index.tsx`: the document `paste` listener is added once; it calls the latest `onPaste` through a ref. `onPaste` is still rebuilt on every context update (it depends on `context`); it is just no longer removed and added each time.
- `Toolbar/FunctionList/group-functions.ts` (new, pure): `groupFunctions(functionlist)` holds the category constants and grouping that were inline in `FunctionListButton.tsx`. The component now reads `locale(context).functionlist` each render and memoizes `groupFunctions` on that list's identity instead of on the whole `context`. The locale object is read each render, not only when the language changes, because its data can finish loading after the language is set.

**Not done: `getToolbarItem` memo deps.** Its `useCallback` lists `context` and many individual fields (`Toolbar/index.tsx`, about 30 entries). The body reads `context` in about 25 places and passes it to helpers (`getFlowdata`, `mergeSelectionHasValues`, `updateCellsDecimalFormat`, and others). Removing `context` from the list would leave those reads stale; narrowing it safely means rewriting the body to read the fields it needs. After E2 the Toolbar renders only on a selection, sheet or data change, so the callback recomputes only when its inputs really changed anyway. Left as is.

**Tests.** `group-functions.test.ts` (5): functions land in their category with sorted names; parser functions go to Parser regardless of type and type 11 to Operator; unknown types go to Other and unnamed entries are skipped; All is first and only categories with functions are listed; empty list. Red run: `Failed to load url ./group-functions`; green: 5 passed. These pin the grouping as it was moved, they are not a new behavior. The listener change is glue and has no unit test. Full suite: 61 files, 495 tests pass; `tsc --noEmit` clean.

**Before and after, same method** (demo dev build; `document.addEventListener` and `removeEventListener` wrapped to count `paste`; 10 wheel scroll ticks; then one ArrowDown and one Enter commit):

| | Before | After |
|---|---|---|
| `paste` listener added and removed over 10 scroll ticks | 10 added, 10 removed | **0, 0** |
| After one ArrowDown and one commit | not measured separately (one rebind per context update) | 0, 0 |

**Browser checks.** A synthetic `paste` event on `document` reached `onPaste` through the once-bound listener (the handler read the clipboard data: `getData` was called twice). The pasted value did not appear in the cell: the text path needs state set by a real copy and paste (`selectionCache.isPasteAction`), which a synthetic event does not set, so the end-to-end paste result was not verified. The function list could not be opened in the demo: the Sigma button is not in the demo's toolbar at this width, so the grouping change is covered by the unit test only. The paste listener count was taken before any paste.

**Not covered.** A real clipboard paste; the function picker in the UI; a host that moves the Workbook between documents (the listener is bound for the Workbook's lifetime).

