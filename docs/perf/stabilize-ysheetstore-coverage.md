# Perf analysis vs tickets: P1 Stabilize Package and P2 YSheetStore

Date: 2026-10-23

Maps the issues in our two analyses ([PERFORMANCE_AUDIT.md](PERFORMANCE_AUDIT.md), [large-sheet-main-thread-perf.md](large-sheet-main-thread-perf.md)) and the fingerprint work from this week onto the two tickets.

**How each issue was found** uses these labels:

- **Code:** read in the source at the cited line.
- **Browser:** measured in the demo app (dev build, Chromium 152, 9,900×60 sheet, 198k cells), from PERFORMANCE_AUDIT.md.
- **Node:** measured in Node 20 with the repo's yjs 13.6.30 (our scratch benchmarks).
- **In-app:** observed with a temporary console logger in the running demo.
- **Ticket:** a number the ticket author measured; not reproduced by us.

Line numbers come from our docs (`main` @ `aa87284`) unless the ticket gives its own (`9411d95`).

---

## Ticket 1: P1 Stabilize Package

### 1.1 Whole document encoded on every edit

- **Root cause:** `flushPortalUpdate` calls `handleOnChange.flush()`, which cancels the 1 s throttle (`editor-context.tsx:443-448`). Every Yjs write then runs `Y.encodeStateAsUpdate(ydoc)`, base64 and `ySheetArrayToPlain` over all sheets (`:411-433`). Microtask coalescing only merges writes in the same task.
- **How we found it:**
  - Code: the call chain `updateYdocSheetData` → `handleOnChangePortalUpdate` → `.flush()`.
  - Browser: about 775 ms of an 820 ms commit at 198k cells (encode 636–672 ms, base64 73 ms, conversion 45–128 ms). A 28.7 MB string went to `onChange`. 4 edits 50 ms apart caused 4 full encodes (5.2 s in total).
  - Code: formula recalc chunks hit the same path, one encode per chunk.
- **Proposed fix (A1, D0):**
  - New `onContentChange({ hasContent, userEdited, fingerprint })`, computed without encoding.
  - Trailing-only 1 s throttle, flushed only on unload.
  - Legacy `onChange` deprecated; dsheets.new switches to the new signal.
- **Not covered:**
  - Hosts still on legacy `onChange` still get one full encode per second.
  - The package still builds the plain `currentDataRef` copy internally on remount.

### 1.2 Whole document encoded on every received remote update

- **Root cause:** `SyncManager.applyRemoteYjsUpdate` calls `onLocalUpdate(fromUint8Array(Y.encodeStateAsUpdate(this.ydoc)), …)` after every `Y.applyUpdate` (`SyncManager.ts:1676-1682`, `:1726-1731`).
- **How we found it:** Code (perf doc §8.1). Ticket: 131 ms per update in Node. Not measured by us.
- **Proposed fix (A2):** `onRemoteApplied(update)` receives only the delta and feeds the A1 notifier.
- **Not covered:**
  - A remote batch over 50 cells, or any structural remote change, still remounts the whole workbook on every peer (non-goal; moves to P2).

### 1.3 Per-feature Yjs hooks convert the whole workbook to read one field

- **Root cause:**
  - `getSheetYdocSyncContext` runs `ySheetArrayToPlain` over every sheet (`sheet-ydoc-sync-utils.ts:20-46`).
  - `getSheet()` rebuilds `celldata` from the dense grid (`core/api/common.ts:79-85`).
  - Both fire from `Workbook` effects whenever `calcChain`, `config`, `hyperlink`, data validation, CF or filter changes reference.
- **How we found it:** Code (perf doc §3.2, §3.3). Ticket: about 50 ms per firing, about 8 at once on mount.
- **Proposed fix (A3):** `readYdocSheetField` reads one field from Yjs; the engine side reads `luckysheetfile[i][field]` directly.
- **Not covered:**
  - Other `getSheet()` callers: `formula-ui-sync.ts:98`, `formula-ui-sync.ts:277` (`getCellClone`, which reads one cell) and `editor-workbook-sync.ts:138` (`getCurrentSheetSafe`).

### 1.4 Remote ≤50-cell batches: one Immer pass per cell, linear search per cell

- **Root cause:**
  - `applyRemoteCellValue` is one `setContext` per cell, and it lands on the local undo stack.
  - `patchPlainCelldata` runs a `findIndex` over the sheet's celldata for each changed key (`use-editor-data.tsx:1008-1052`).
- **How we found it:** Code (perf doc §8.3). Ticket: 45 ms for 50 cells at 100k.
- **Proposed fix (A5):** `applyRemoteCells` in one `noHistory` update; one `"r_c"` → index map per batch.
- **Not covered:** batches over 50 cells still remount (non-goal).

### 1.5 Delete-only edits are never published (state-vector fingerprint)

- **Root cause:**
  - `Y.encodeStateVector` records only inserted items per client. A delete creates no item; it is recorded in a separate delete set.
  - Today's sheets write many actions as deletes only (`update-ydoc.ts:308, 357, 371, 396-466, 481, 507, 526`; `editor-workbook-sync.ts:320-322`; `defined-names-ydoc.ts:135`).
  - The dsheets.new publish check compares state vectors (`utils/dsheet-body.ts:117`).
- **How we found it:**
  - Node: a vector is byte-identical after `map.delete`, while the encoded doc changes.
  - In-app: confirmed for removing a filter, deleting data validation, deleting conditional formatting, deleting a sheet tab, undo after typing, and deleting a named range. Clearing a plain cell did advance the vector, because that path also writes a new entry.
  - Node: rejected `Y.snapshot`, which walks every entry ever written (3.1 ms at 142k entries, 15.7 ms at 706k, growing with every edit).
  - Node: the running deleted count passed T1–T10: deletes, no-ops, remote updates, duplicate and out-of-order updates, concurrent deletes, undo, reload, merged IndexedDB rows, and real y-indexeddb replay including its trim.
- **Proposed fix (A1, D0, D5, D6):**
  - Fingerprint = `base64(stateVector) + ":" + deletedCount`. A tracker attached at `Y.Doc` creation adds up `tr.deleteSet`; about 0.0002 ms per transaction at any history size.
  - `fingerprintFromUpdate(body)` for stored bodies.
  - `lastPublishedSnapshot` stores the fingerprint; the publish takes it before its body read.
- **Not covered:**
  - **D6 upgrade:** an old stored vector that matches the body is converted to a fingerprint without publishing. A delete-only change that was already pending before the upgrade gets marked clean.
  - **D6 write ordering** assumes IndexedDB is on. With `enableIndexeddbSync` false, or after an IndexedDB init failure, the body read may not hold what the fingerprint covers.
  - **Background-sheet `fingerprintFromUpdate`** decodes the whole body every cycle. The ticket itself says to measure it; not measured yet.
  - **[Inference] Diverged replicas:** two copies could have the same vector and count with different deletes. It's not a content hash; D5's hash check stays.

### 1.6 Conditional formatting recomputed over its full range on every draw

- **Root cause:** `drawMain` calls `getComputeMap` (`canvas.ts:801`), which loops every cell of every rule's `cellrange` with no cache (`ConditionFormat.ts:809`). It runs up to 4× per repaint with frozen panes.
- **How we found it:** Browser: +28 ms per repaint for one `greaterThan` rule over 100k cells; scroll p95 went from 30 to 65 ms, with 30 long tasks.
- **Proposed fix (C2):** cache the compute map per sheet, keyed by the identities of data and rules (plus draft state).
- **Not covered:**
  - [Inference] The cache is keyed on `data` identity, which changes on every edit, so each edit still pays one full-range recompute on the next draw.
  - The `formula` CF rule type crashes the render (`Cannot assign to read only property 'calculateSheetId'`).

### 1.7 Paste auto-fit forces a browser layout per cell

- **Root cause:** `calculateRangeCellSize` writes `textContent` into a hidden div and reads `scrollWidth`/`scrollHeight` per cell (`calculate-range-cell-size.tsx:87-140`). It runs for plain-text paste, internal paste and paste inside the cell editor.
- **How we found it:** Browser: a 10k-cell text paste took 3.0 s, of which 2.8 s was the measurer. The same data as an HTML table took 0.25 s.
- **Proposed fix (C5):** canvas `measureText` with a `(font, text)` cache for single-line cells; batched DOM measurement for wrapped cells; the font bug fixed.
- **Not covered:** the rest of the paste cost (see 1.12).

### 1.8 Full-sheet crypto-banner scan on every selection change

- **Root cause:** the effect at `Workbook/index.tsx:841-899` runs `dataToCelldata` over R×C on every `luckysheet_select_save` change, to look for BTC/ETH/SOL.
- **How we found it:** Code; Browser: about 8 ms at 594k slots, linear in sheet size.
- **Proposed fix (C4):** run on data identity changes only, deferred to idle time.
- **Not covered:** `calcSelectionInfo` over every selected cell (`SheetTab/index.tsx:88-96`): a 132 ms long task on select-all (Browser), rerun on every drag step.

### 1.9 Formula pass for a cell nothing depends on

- **Root cause:** `execFunctionGroup` narrows to dependents only when the graph has entries and the dependents set is non-empty (`formula.ts:2466-2518`). Otherwise it re-tokenizes every formula, and `arrayMatch` walks every cell of every referenced range.
- **How we found it:** Code; Browser: 11 ms vs 2 ms with 500 `SUM(A:T)` formulas.
- **Proposed fix (C8):** a `depGraphComplete` flag; skip the pass when the graph is complete and the cell has no dependents.
- **Not covered:**
  - Paste still rebuilds the full graph (`jfrefreshgrid` → `runExecFunction` with null origins).
  - `arrayMatch` still builds a key string per range cell for edits to referenced cells.
  - A `RegExp` built per formula per defined name (`formula.ts:2493-2512`).
  - `stack.concat` per visited node in topological sort (`:2893`).
  - `setCellValuesByRange` runs a full `updateCell` per formula: 2.2 → 3.9 ms per formula (Browser).
  - The INDIRECT/OFFSET/INDEX precondition is still to be confirmed (the ticket says so).

### 1.10 Whole React tree re-renders on every context change

- **Root cause:** all UI state lives in one immer `Context`. The provider value changes on every update (`Workbook/index.tsx:901-918`), and 51 consumers have no `React.memo`. Scroll, `mousemove` (with `getBoundingClientRect` inside the updater) and selection all update it.
- **How we found it:** Code; Browser: sparse scroll at a 16.6 ms median (inside a frame, but with no margin).
- **Proposed fix (E1–E6):**
  - Hover updates only on change.
  - `useWorkbookSelector` + `React.memo` for Toolbar, SheetTab, menus and FunctionList.
  - A stable handle; the paste listener bound once; `NotationBoxes` updates once per commit; no `innerText` reads on render.
- **Not covered:**
  - Scroll stays in context (deferred).
  - FxEditor and the overlays are not converted.
  - `useSmoothScroll` rebinds all listeners on each `luckysheetCellUpdate` change.
  - The second render per edit from `calcRowColSize` (see 1.12).

### 1.11 Repaint caches discarded every frame

- **Root cause:**
  - The measure-text cache reads and writes different keys (found by the ticket author).
  - Separately, the cache is cleared 100 ms after each draw (`canvas.ts:1456-1459`).
  - `Sheet` creates a new `Canvas` per repaint, dropping `cellOverflowMapCache`.
- **How we found it:** Code; Browser: populated scroll p95 33–38 ms vs 17.2 ms sparse at the same dimensions.
- **Proposed fix (C1):** one key builder for read and write.
- **Not covered:** the 100 ms clear timer, the new `Canvas` per repaint, and the overflow scan over every column of each visible row (`canvas.ts:1489`).

### 1.12 In our analysis, not in P1 at all

| Issue | Root cause | How we found it |
|---|---|---|
| Row/column offsets rebuilt on every edit | `Sheet/index.tsx:53-64` depends on `data` identity, so `calcRowColSize` runs O(R+C) plus a repaint per edit | Code |
| Overflow scan over all columns | `getCellOverflowMap` loops `0..data[r].length` for each visible row | Code; part of the populated-scroll p95 |
| Per-cell Yjs write overhead | 2× `structuredClone`, `_.isEqual`, `punchHoleInCellFormatRanges` O(K×G) per cell (`update-ydoc.ts:153-175, 309-342`) | Code; 37 ms per 10k cells (Browser) |
| Remote format-range change converts the whole doc | `syncPlainSnapshot` on any remote `cellFormatRanges` change (`use-editor-data.tsx:1103-1105`) | Code |
| Paste: whole-sheet formula scan | `handleFormulaOnPaste` walks R×C whenever the pasted text contains `=` (`paste-internals.ts:328-366, 932`) | Code |
| Paste: internal paste does whole-sheet work | `getBorderInfoCompute` over the source sheet, `cloneDeep` of all data validation (`paste-internals.ts:1601, 1722-1726`) | Code |
| Paste: HTML parsed twice | `innerHTML` only to count `<tr>` (`Workbook/index.tsx:1668-1671`) | Browser: 169 ms for 5.3 MB |
| Paste: large HTML paste | `insertRowCol`, the Immer pass and freezing of big new objects | Browser: 198k cells, 6.1 s, +251 MB |
| Undo history unbounded | `undoList.push` with no cap (`Workbook/index.tsx:653`) | Code |
| Hooks object churn reruns Workbook init | `mergedSettings.hooks` is in the init effect's dependencies | Code |
| `updateAllCell` rewrites every cell | `editor-workbook-sync.ts:506-579` | Code |
| 10k-row cap fails silently | only `console.error` (`Workbook/index.tsx:1711-1713`) | Browser |
| Latent bug | `formula.ts:1452` reads `dynamicArray_compute[0]` inside a loop over `j` | Code |
| Theme or font load triggers a full refresh | `jfrefreshgrid` and a measure-cache clear right after open | Code |

**P1 items found by the ticket author, not in our analysis:** B1–B6 (data-loss paths), C3, C6, C7, D1–D5 and F.

---

## Ticket 2: P2 YSheetStore

### 2.1 Structural edits rewrite every shifted cell; remote >50 cells remounts peers

- **Root cause:**
  - Cells are keyed by position (`"r_c"`), so an insert, delete, sort or move rewrites every shifted cell (`rowcol.ts:1621`).
  - The remote classifier treats any batch over `SURGICAL_CELL_LIMIT = 50`, or any structural change, as a full remount (`use-editor-data.tsx:239, 737-768`).
- **How we found it:** Code (perf doc §7, §8.2; audit finding 8). Ticket: 309 ms, 6.4 MB sent and +0.94 MB of document for one row insert at 100k cells.
- **Proposed fix:**
  - Permanent row and column IDs, with order arrays per tab.
  - Structural commands (`insertRows`, `sortRows`, …) write IDs only.
  - Remote structural changes are applied in place through the engine's own functions.
- **Not covered:**
  - The engine's dense grid and the 10k-row cap stay (non-goal), and the silent cap failure isn't addressed.
  - A tab switch still rebuilds the dense grid (`initSheetData`).

### 2.2 Several copies of the data, dense grid, slow open

- **Root cause:**
  - The same data lives in the Yjs doc, a plain `currentDataRef`, a `detachWorkbookData` `cloneDeep` and the frozen `luckysheetfile`.
  - The active tab is a dense `R×C` grid.
  - About 8 hooks convert the whole workbook on mount.
- **How we found it:** Browser: 3.4 s to open and 339 MB of heap at 198k cells. Code: the copy chain (`editor-workbook.tsx:418-427`, `detach-workbook-data.ts:10`, `Workbook/index.tsx:312-314`).
- **Proposed fix:** the store is the only owner; conversion, deep clone and hooks go. Main-thread open goes from about 960 ms to about 342 ms at 100k (ticket); the worker later moves the Yjs load off the main thread.
- **Not covered:**
  - Dense grid memory (non-goal until phase 3).
  - Per-cell date formatting in `initSheetData`.
  - During the v1 window the doc is about twice the size (704 ms load vs 333 ms; ticket).

### 2.3 Per-cell overhead and whole-value writes in the Yjs layer

- **Root cause:**
  - `updateYdocSheetData` clones twice and deep-compares per cell, and punches format ranges at O(K×G).
  - Format ranges, filters, CF lists, validation and each whole cell are stored as one value, so last writer wins.
- **How we found it:** Code (perf doc §3.4); Browser: 37 ms per 10k cells.
- **Proposed fix:** format v2 with one key per concern, one entry per rule or range, and a per-tab format index for range commands.
- **Not covered:**
  - [Unverified] the per-cell cost inside the store; no benchmark row in the ticket.
  - Number format (`ct`) and value still overwrite each other on purpose (Decision 1).

### 2.4 Per-feature hooks, remote classifier, `updateAllCell`

- **Root cause:** about 80 hand-written seams (about 63 `updateCellYdoc` call sites, about 20 hooks, and the classifier with its echo guards). `updateAllCell` rewrites every cell. A remote format-range change converts the whole doc.
- **How we found it:** Code (perf doc §3.2, §3.6, §8.4).
- **Proposed fix:** a binding at `setContextWithProduce` replaces all of them; an idle self-check repairs mismatches and reports them to Sentry.
- **Not covered:**
  - [Unverified] whether the remaining `hooks` prop still reruns the Workbook init effect (`mergedSettings.hooks` dependency).

### 2.5 Undo

- **Root cause:** engine undo stores Immer patches with no cap (`Workbook/index.tsx:653`), and remote cells land on the local stack.
- **How we found it:** Code (audit E6, M5).
- **Proposed fix (Decision 6):** `Y.UndoManager`, local origin only, one step per user action.
- **Not covered:**
  - No cap on the `Y.UndoManager` stack either; [Inference] memory still grows for the whole session.
  - **Compaction vs undo:** compaction removes cells of rows in `deleted` with an origin undo ignores. Undoing a row delete after compaction restores the row ID with empty cells.

### 2.6 Computed values and the formula chain stored in Yjs

- **Root cause:**
  - Every recalculating client writes whole cell objects with results (`groupValuesRefresh`, `formula.ts:2066-2096`).
  - `calcChain` is stored by position.
  - A remote formula is not registered in the local dependency graph.
- **How we found it:** Code (perf doc §6.3; audit finding 4).
- **Proposed fix (Decision 3):**
  - The chain is derived, not stored.
  - Results go in a separate `results` map.
  - Every client recalculates after a remote change and repairs differing results after a random delay, with a 1e-12 tolerance.
- **Not covered:**
  - [Inference] Results churn adds Yjs history: up to 10 clients overwriting `results` entries.
  - The cost of every client recalculating after every remote edit is not estimated or benchmarked; it needs a complete graph on each client.
  - Precondition: the worker and main thread must use one evaluator.

### 2.7 History bloat on old sheets

- **Root cause:** every overwritten value stays in the doc as an entry; position-key rewrites multiply this.
- **How we found it:** Node: the snapshot benchmark showed entries growing linearly with sessions (142k at 100, 706k at 500), even with GC. Ticket: 145,005 entries, 143,899 deleted, after 100 sessions.
- **Proposed fix:** v2 writes small entries; the v1 copy is cleared after the migration window (145,005 → 1,003 entries).
- **Not covered:**
  - [Inference] v2's own history keeps growing: sorts (4,000 new order entries each), moves, per-property style keys and `results` rewrites.
  - The goal "a 100-row sheet must stay as fast as a fresh one" needs a periodic doc rewrite or a narrower claim.

### 2.8 Publish and connect

- **Root cause:** about 10 whole-document passes per 20 s publish cycle. The collab floor starts at 0 on every mount, so each open downloads the full server snapshot.
- **How we found it:** Ticket (D5 list; `SyncManager.ts:1280-1333, :1805`). Our docs flagged IndexedDB compaction (perf doc §8.5) but did not trace publish.
- **Proposed fix (Decision 8):** `store.snapshot()` (one encode + gzip, later in the worker); changes-only IndexedDB; a saved collab floor; a shared collab engine with ddoc.
- **Not covered:**
  - **Decision 8 contradicts Stabilize D6.** It says the dirty check uses "A1's `changeSeq`", but D6 uses the fingerprint and rejects a counter.
  - Once the doc moves to the worker (milestone 6), the fingerprint tracker must move with it, and `getContentFingerprint()` becomes async. D6's "fingerprint before body read" then needs ordering across threads.
  - `hasContent` has no v2 definition.

### 2.9 Formula worker gets a dense snapshot per job

- **Root cause:** `initFormulaWorkerSnapshot` posts dense matrices of every needed sheet; the structured clone runs on the main thread (`formula-worker-bridge.ts:150-183`).
- **How we found it:** Code (perf doc §6.3).
- **Proposed fix:** deferred to phase 3 (formulas evaluated next to the store in the worker).
- **Not covered:** everything until phase 3.

### 2.10 New issues in P2's own design

| Issue | Why |
|---|---|
| v1 inbox shift detection may not see the old values it needs | It relies on per-transaction old values and the writer's client ID. These are only available for v1 updates a v2 client observes live. Updates merged into a server snapshot, a y-indexeddb trim or a saved collab floor lose the transaction grouping and old values. |
| Deleted range end vs concurrent formula | The range-end fix runs inside the delete command. A formula a collaborator commits at the same moment arrives afterwards and shows `#REF!` instead of shrinking. |
| Per-cell format beats any range | A per-cell key from an offline client beats a newer range format applied after it. Deterministic but surprising. |

---

## In our analysis, covered by neither ticket

1. `calcRowColSize` on every edit (O(R+C) plus a second render).
2. Overflow scan over all columns; new `Canvas` per repaint; measure cache cleared after 100 ms.
3. Paste rebuilds the full formula graph (`jfrefreshgrid` with null origins).
4. `calcSelectionInfo` over every selected cell (132 ms on select-all), rerun on every drag step.
5. `handleFormulaOnPaste` scans the whole sheet whenever the paste contains `=`.
6. Internal paste does whole-sheet border compute and `cloneDeep`.
7. HTML paste parsed twice; the cost of a large HTML paste (6.1 s, +251 MB).
8. `setCellValuesByRange` gets slower per formula.
9. Formula internals: a `RegExp` per defined name, `stack.concat`, cache invalidation per worker result.
10. Latent bugs: `formula.ts:1452`; the CF `formula` rule type crashes the render.
11. 10k-row cap fails silently.
12. `useSmoothScroll` rebinds its listeners; theme or font load triggers a full refresh.
13. No cap on undo history (engine today, `Y.UndoManager` in P2).

Items 1, 2, 5 and 4 are local changes with no schema impact. [Inference] They fit P1's own inclusion rule, so they should either be added to P1 or listed as non-goals.
