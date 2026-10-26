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

- Workbooks whose formulas sit on inactive (sparse) tabs keep the flag false: the C8 dense-tab guard is unchanged, and the warm-up does not hydrate tabs. Switching tabs does not re-trigger the warm-up.
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
