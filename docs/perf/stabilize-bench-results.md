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
| `fingerprintFromUpdate(body)` | **34.9 ms** | 40.4 ms |

Budgets in the fingerprint spec:

- Tracking under 0.01 ms per transaction: met, about 0.005 ms.
- `getFingerprint()` under 1 ms: met.

Open costs about 3 ms more on a 114k-struct body.

**Finding for D5 (superseded 2026-10-26: the ticket now builds `fingerprintFromUpdate` from a temporary document plus a delete-set scan, and the dirty check uses the body read's fingerprint; re-measure the new implementation, this number is for the `Y.decodeUpdate` version).** `fingerprintFromUpdate` decodes every struct (`Y.decodeUpdate`), which takes 35 ms on this body. Running it every 20 s cycle for background sheets is not cheap. A reader that skips struct contents and reads only the delete set is a candidate before D5 adopts it.

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

## D3 (package side): `rebuildLocalStore` (Task 6, 2026-10-26, uncommitted)

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

## D5 (package side): `appendDsheetUpdate` (Task 7, S12, 2026-10-26, uncommitted)

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
