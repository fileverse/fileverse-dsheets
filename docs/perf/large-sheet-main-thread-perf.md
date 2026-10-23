# Large-sheet performance: what blocks the main thread

Status: analysis only — no code changed, nothing profiled.
Date: 2026-10-19

> **How to read this.** Every finding below was verified by reading the code at the
> referenced file and line. The *cost* of each finding (how slow it is, how it ranks
> against the others) was **not measured** — those statements are marked
> **[Inference]**. Treat the ranking as a hypothesis to confirm with a Chrome
> Performance profile (see [§9 Verification plan](#9-verification-plan)).

---

## Contents

1. [Summary](#1-summary)
2. [Data model and data flow](#2-data-model-and-data-flow)
3. [Per local edit: whole-sheet / whole-doc passes](#3-per-local-edit-whole-sheet--whole-doc-passes)
4. [Selection, mouse and global React cost](#4-selection-mouse-and-global-react-cost)
5. [Rendering: scroll and repaint](#5-rendering-scroll-and-repaint)
6. [Formula calculation](#6-formula-calculation)
7. [Load, remount and hydration](#7-load-remount-and-hydration)
8. [Collaboration (remote updates)](#8-collaboration-remote-updates)
9. [Verification plan](#9-verification-plan)
10. [Fix candidates, by likely impact](#10-fix-candidates-by-likely-impact)
11. [Appendix: complexity cheat sheet](#appendix-complexity-cheat-sheet)

---

## 1. Summary

The app lags on large sheets mainly because **a single small action triggers
several passes over the entire sheet and the entire Yjs document, all synchronously
on the main thread**. Their cost scales with the size of the sheet, not with the size
of the change. On top of that, formula dependency resolution and canvas painting
(conditional formatting, text overflow) also do full-range work on the main thread.

Only two things run off the main thread today:

- XLSX parsing (`src/worker/dsheet-worker.ts`, via Comlink).
- Formula *evaluation* for jobs of ≥100 formulas (`formula-worker-bridge.ts`), and
  even then the snapshot serialization and result application happen on the main
  thread.

Notation used below: **R** = rows, **C** = columns, **N** = non-empty cells,
**D** = number of sheets/whole doc, **F** = formulas in the calc chain,
**K** = cells changed in one operation, **G** = `cellFormatRanges` entries.

---

## 2. Data model and data flow

Three representations of the same cells exist at once:

| Layer | Shape | Where |
|---|---|---|
| Yjs doc | `Y.Array<Y.Map>` per workbook; each sheet's `celldata` is a sparse `Y.Map` keyed `"r_c"` | `src/editor/utils/update-ydoc.ts` |
| Plain snapshot (`currentDataRef`) | `Sheet[]` with `celldata: {r,c,v}[]` | `src/editor/hooks/use-editor-data.tsx` |
| Engine state | Immer-managed `Context`; active sheet holds a **dense** `data[R][C]` matrix | `src/sheet-engine/react/components/Workbook/index.tsx` |

### Local edit flow

```
user action
  → setContextWithProduce(recipe)              Workbook/index.tsx:592
      → produceWithPatches(whole Context)       (Immer)
      → triggerGroupValuesRefresh → groupValuesRefresh → hooks.updateCellYdoc
  → React re-render of every WorkbookContext consumer
  → useEffect hooks watching currentSheet.<field> fire  Workbook/index.tsx:975-1111
      → *YdocUpdate helpers → getSheet() + ySheetArrayToPlain()   (§3.2, §3.3)
  → updateYdocSheetData (Y transaction)          update-ydoc.ts:182
      → handleOnChangePortalUpdate (microtask)
          → flushPortalUpdate → encodeStateAsUpdate(whole doc) + ySheetArrayToPlain  (§3.1)
  → Sheet effects: calcRowColSize, initFreeze, new Canvas + drawMain   (§3.5, §5)
```

### Remote edit flow

```
socket message
  → SyncManager.applyRemoteYjsUpdate            SyncManager.ts:1650
      → Y.applyUpdate
      → onLocalUpdate(encodeStateAsUpdate(whole doc))           (§8.1)
  → sheetArray.observeDeep callback              use-editor-data.tsx:299
      → ≤50 cells: surgical applyRemoteCellValue + patchPlainCelldata  (§8.3)
      → >50 cells or structural: full remount (§7)
```

---

## 3. Per local edit: whole-sheet / whole-doc passes

These run on (nearly) every cell edit, paste, format change or formula result.

### 3.1 The 1s throttle on `onChange` is bypassed — full doc encode + full doc → plain per write

`src/editor/contexts/editor-context.tsx:409-457`

```ts
const handleOnChange = useMemo(() => throttle(() => {
  const encodedUpdate = fromUint8Array(Y.encodeStateAsUpdate(ydocRef.current));
  ...
  plain = ySheetArrayToPlain(sheetArray);
  currentDataRef.current = plain;
  onChange({ data: plain }, encodedUpdate);
}, 1000), [onChange, dsheetId]);

const flushPortalUpdate = useCallback(() => {
  handleOnChange();
  handleOnChange.flush();          // ← runs the pending call immediately
  handleContentUpdateNotification();
  handleContentUpdateNotification.flush();
}, ...);

const handleOnChangePortalUpdate = useCallback(() => {
  if (portalUpdateScheduledRef.current) return;
  portalUpdateScheduledRef.current = true;
  queueMicrotask(() => { portalUpdateScheduledRef.current = false; flushPortalUpdate(); });
}, [flushPortalUpdate]);
```

- `handleOnChangePortalUpdate` is passed as `handleContentPortal` to
  `updateYdocSheetData` and to almost every `*YdocUpdate` helper, so it fires on
  essentially every Yjs write.
- Microtask coalescing only merges writes in the **same task**. Across tasks
  (each keystroke-commit, each formula chunk, each hook effect), every write runs
  the full body because `.flush()` cancels the throttle window.
- Body cost: `Y.encodeStateAsUpdate` is O(D) and allocates a buffer the size of the
  doc; `fromUint8Array` base64-encodes it (another O(D) string);
  `ySheetArrayToPlain` calls `toJSON()` on every sheet's `celldata` map and
  `Object.values` on it — O(N across all sheets).
- Only active when the host passes `onChange`.
- **[Inference]** For a sheet with hundreds of thousands of cells, this is likely
  the single largest per-edit cost, and it repeats per formula chunk (§6.3).

### 3.2 `getSheetYdocSyncContext` converts the whole doc to plain just to diff one field

`src/editor/utils/sheet-ydoc-sync-utils.ts:20-46`

```ts
const oldSheets = ydocRef.current.getArray(dsheetId);
const plainOldSheets = ySheetArrayToPlain(oldSheets);   // every sheet, every cell
const oldSheet = plainOldSheets.find((s) => s.id === currentSheetId) || {};
```

Called from: `calcChainYdocUpdate`, `configYdocUpdate`, `hyperlinkYdocUpdate`,
`dataVerificationYdocUpdate`, `conditionFormatYdocUpdate`, `filterYdocUpdate`,
`filterSelectYdocUpdate`, `liveQueryListYdocUpdate` (all in `src/editor/utils/`).

These run from `useEffect` hooks in `Workbook/index.tsx:975-1111` that fire whenever
the current sheet's `calcChain`, `config`, `hyperlink`, `dataVerification`, … object
reference changes. Any Immer write to those fields creates a new reference, so for
example:

- entering a formula → new `calcChain` → `calcChainChange`,
- resizing a column, applying a format → new `config` → `afterConfigChanges`.

Each converts *all sheets'* celldata to plain arrays only to read one field of one
sheet (e.g. `calcChain`). Cost O(N_all).

### 3.3 `getSheet()` rebuilds `celldata` from the dense matrix on every call

`src/sheet-engine/core/api/common.ts:79-85`, exposed as `WorkbookInstance.getSheet`
in `src/sheet-engine/react/components/Workbook/api.ts:440`

```ts
export function getSheetWithLatestCelldata(ctx, options = {}) {
  const sheet = getSheet(ctx, options);
  return { ...sheet, celldata: dataToCelldata(sheet.data) };   // full R×C scan
}
```

`dataToCelldata` walks R×C and allocates one `{r,c,v}` object per non-null cell.
Callers that only need a small piece of the sheet:

| Caller | Needs |
|---|---|
| `calc-chain-ydoc-update.ts:34` | `.calcChain` |
| `config-ydoc-update.ts:93` | `.config` |
| `hyperlink-ydoc-update.ts:30`, `data-verification-ydoc-update.ts:30`, `filter-ydoc-update.ts:32`, `filter-select-ydoc-update.ts:32`, `condition-format-ydoc-update.ts:33`, `live-query-list-ydoc-update.ts:30` | one map field |
| `formula-ui-sync.ts:98` | `.data.length`, `.data[0].length` |
| `formula-ui-sync.ts:277` (`getCellClone`) | **one cell** |
| `editor-workbook-sync.ts:138` (`getCurrentSheetSafe`, used by `syncCurrentSheetField`, `afterColRowChanges`, `updateAllCell`) | one field |

Combined with §3.2, a single formula entry can cost
O(R×C) (getSheet) + O(N_all) (ySheetArrayToPlain) inside one effect, before §3.1
adds another O(D) + O(N_all).

### 3.4 `updateYdocSheetData`: per-cell clones, deep-equals and range scans

`src/editor/utils/update-ydoc.ts:153-175, 309-342`

For every changed cell:

1. `setMapValueSafe` → `normalizeForYjs` → `structuredClone(value)`.
2. `celldataEntryEqual(existing, normalized)` and then `_.isEqual(existing, normalized)`.
3. `normalizeForYjs(value)` **again** (second `structuredClone`) to read `r/c/v`.
4. `punchHoleInCellFormatRanges(working, r, c)` + `cellFormatRangesEqual(...)` —
   linear in G.

Paste/fill of K cells therefore costs O(K × G) plus 2K structured clones and K deep
equals, inside one `ydoc.transact`. **[Inference]** On sheets with many format
ranges this grows faster than paste size.

Also at the end of every call (`update-ydoc.ts:585-591`), `status` is re-set on every
sheet (cheap, but adds Yjs ops when it changes).

### 3.5 `calcRowColSize` rebuilds row/col offset arrays on every data change

`src/sheet-engine/react/components/Sheet/index.tsx:53-64` →
`updateContextWithSheetData` → `src/sheet-engine/core/context.ts:629-718`

The effect depends on `data`. Immer produces a new `data` reference on any cell
write, so every edit:

- rebuilds `visibledatarow` (R entries) and `visibledatacolumn` (C entries) in a
  `setContext` (another full `produceWithPatches`),
- assigns new arrays to the draft → new references → re-triggers
  `initFreeze` (`Sheet/index.tsx:89`) and the repaint effect (§5).

O(R + C) per edit — modest on its own, but it also forces a full repaint even when
the edit was in a cell that is not visible.

### 3.6 Hook `updateAllCell` rewrites every cell

`src/editor/components/editor-workbook-sync.ts:506-579`, invoked via
`hooks.updateAllCell` (scheduled with `setTimeout(…, 500)` at
`editor-workbook.tsx:660`) from `src/sheet-engine/core/api/sheet.ts` /
`settings.ts`.

Walks the full dense matrix and emits an update for **every** persistable cell, which
then goes through §3.4 per cell and §3.1 once. O(R×C) + O(N × G). The function logs
`[Yjs] updateAllCell caller=… cells=…` when it runs — useful to spot it in traces.

---

## 4. Selection, mouse and global React cost

### 4.1 Every selection change scans the whole grid for "BTC/ETH/SOL"

`src/sheet-engine/react/components/Workbook/index.tsx:841-899`

```ts
useEffect(() => {
  setContext((ctx) => {
    const gridData = getFlowdata(ctx);
    const cellData = api.dataToCelldata(gridData);       // R×C scan + allocation
    const denominatedUsed = cellData.some((cell) => {
      const value = cell?.v?.m?.toString();
      return value?.includes('BTC') || value?.includes('ETH') || value?.includes('SOL');
    });
    ... // toggles #denomination-warning DOM
    return ctx;
  });
  ...
}, [context.currentSheetId, context.luckysheet_select_save, mergedSettings.hooks]);
```

Dependency on `luckysheet_select_save` means this runs on **every click, arrow key,
shift-extend and drag-select step**. It is a full O(R×C) scan plus N allocations,
purely to toggle a banner. **[Inference]** Likely the main cause of "clicking around
feels slow" on big sheets, independent of editing.

### 4.2 Every `setContext` is `produceWithPatches` over the whole Context

`Workbook/index.tsx:592-670`

Unless `{ noHistory: true }` is passed, every update runs `produceWithPatches`, then
`filterPatch` on both patch lists, pushes to `undoList` and calls `emitOp →
patchToOp`. Immer itself is copy-on-write, so untouched subtrees are cheap, but:

- **[Inference]** Immer's auto-freeze is on (no `setAutoFreeze` call anywhere in
  `src/`). When a recipe assigns a **new large non-draft object** (a new matrix, a
  new `visibledatarow` array, pasted rows), Immer walks it during finalize to look
  for nested drafts and deep-freezes it — O(size of the new object).
- Every non-noop update produces a new `context` → new `providerValue`
  (`Workbook/index.tsx:901`) → every `WorkbookContext` consumer re-renders
  (Toolbar ~2.3k lines, SheetOverlay, InputBox ~3k lines, FxEditor, headers, …).

### 4.3 Document-level `mousemove` → `setContext` on every move

`src/sheet-engine/react/components/SheetOverlay/index.tsx:418-770`

Every mouse move anywhere in the document runs `setContext` with
`overShowLinkCard` + `handleOverlayMouseMove`. When nothing changes the result is the
same reference and React bails out, but the Immer pass still runs each event. During
drag-select it does change state → full re-render + §4.1 per step.

### 4.4 `mergedSettings` deep-clones defaults when props change

`Workbook/index.tsx:268-273` — `_.cloneDeep(defaultSettings)` keyed on
`_.values(props)`. `editor-workbook.tsx` passes many inline objects (`hooks={{…}}`,
`customToolbarItems`, …), so whenever the `useMemo` that builds the element
re-evaluates, `mergedSettings.hooks` changes, which is a dependency of the init effect
(`Workbook/index.tsx:1254-1276`) and the selection effect (§4.1). Low cost by itself;
relevant as a trigger.

---

## 5. Rendering: scroll and repaint

`src/sheet-engine/react/components/Sheet/index.tsx:106-279`,
`src/sheet-engine/core/canvas.ts`

### 5.1 New `Canvas` instance per repaint → caches discarded

```ts
useEffect(() => {
  if (context.groupValuesRefreshData.length > 0) return;
  const tableCanvas = new Canvas(refs.canvas.current!, context);
  const repaint = () => { ... tableCanvas.drawMain(...) ... };
  repaint();
  ...
}, [context.scrollLeft, context.scrollTop, context.visibledatarow, context.visibledatacolumn,
    context.config, context.luckysheetfile, ...]);
```

The effect runs on every scroll step and every `luckysheetfile` change.
`Canvas` holds `cellOverflowMapCache` (`canvas.ts:130-138`), which starts empty for
each new instance, so the per-row overflow cache never survives between frames.

### 5.2 Text-overflow map walks every column of each visible row

`canvas.ts:1463-1620` (`getCellOverflowMap`)

```ts
for (let r = rowStart; r <= rowEnd; r += 1) {
  if (this.cellOverflowMapCache[r]) { ...; continue; }   // never hits (5.1)
  for (let c = 0; c < data[r].length; c += 1) {          // ALL columns, not visible ones
    ... getCellTextInfo(cell, canvas, ...)               // text measurement
```

Cost per frame: visibleRows × C, with text measurement for cells that may overflow.
**[Inference]** Wide sheets (hundreds of columns) suffer most when scrolling
vertically.

### 5.3 Conditional formatting recomputed on every `drawMain`, no cache

`canvas.ts:801` → `getComputeMap` (`modules/ConditionFormat.ts:1926`) →
`compute` (`ConditionFormat.ts:809`)

`compute` iterates every cell of every rule's `cellrange` (and for data bars, twice:
once for min/max, once to assign). It is not memoized — no cache exists in
`ConditionFormat.ts`. A rule on a whole column of 100k rows costs ≥100k iterations
per `drawMain`.

### 5.4 Frozen panes multiply the cost

`Sheet/index.tsx:116-250`: with horizontal and vertical freezes, `repaint` calls
`drawMain` up to **4 times** (one per pane) plus headers. Each call recomputes §5.3
and §5.2 for its region. Worst case per scroll frame:
4 × (CF full-range compute) + overflow scans.

### 5.5 Theme and font repaints

`Workbook/index.tsx:929-967`: theme change and webfont load each run
`jfrefreshgrid` in a `setContext`. Font load also clears the measure-text cache, so
the next paint re-measures everything visible. One-off, but it lands right after
initial load, when the thread is already busy (§7).

---

## 6. Formula calculation

`src/sheet-engine/core/modules/formula.ts`,
`formula-async-eval.ts`, `formula-worker-bridge.ts`

Thresholds (`formula-async-eval.ts`):

| Constant | Value | Meaning |
|---|---|---|
| `FORMULA_ASYNC_EVAL_THRESHOLD` | 15 | run list ≥15 → deferred/chunked eval |
| `FORMULA_ASYNC_CHUNK_SIZE` | 50 | main-thread chunk size |
| `FORMULA_WORKER_THRESHOLD` | 100 | job ≥100 → try worker |
| `FORMULA_WORKER_CHUNK_SIZE` | 300 | worker chunk size |

### 6.1 Dependency-graph build is synchronous and expands ranges cell by cell

`execFunctionGroup` (`formula.ts:2408-2957`) does all of this **before** deciding to
defer:

1. `getAllFunctionGroup` (`formula.ts:1419`) — concatenates every sheet's
   `calcChain` (O(F)). (Also note a latent bug at `formula.ts:1452`: it reads
   `dynamicArray_compute[0]` inside a loop over `j`, so it pushes the first entry
   repeatedly.)
2. Filters to dependents via `revDepsByCell` when warm (good), but when the edited
   cell sits inside a defined name it scans all F formulas and **builds a new
   `RegExp` per formula per name** (`formula.ts:2493-2512`).
3. For each formula to process: `getcellFormula` + a hand-written tokenizer over the
   formula string (`formula.ts:2591-2791`).
4. **`arrayMatch`** (`formula.ts:2547-2587`) — for every formula, for every
   referenced range, loops over **every cell** in the range and builds a key string
   `r${r}c${c}i${sheetId}`:

   ```ts
   for (let r = range.row[0]; r <= range.row[1]; r += 1)
     for (let c = range.column[0]; c <= range.column[1]; c += 1) {
       const key = `r${r}c${c}i${range.sheetId}`;
       func(key, r, c, range.sheetId);
       ...
   ```

   `=SUM(A1:A100000)` → 100k string allocations for that one formula. A column of
   1,000 such formulas → 100M iterations, unless they share an identical range
   (the `arrayMatchCache` only matches identical range keys).
5. Topological ordering via a stack that uses `stack = stack.concat(cacheStack)`
   (`formula.ts:2893`) — allocates a new array per visited node with parents.

**[Inference]** For sheets with many range formulas over large ranges, step 4
dominates and it all happens in the edit's `setContext`, blocking input.

### 6.2 Synchronous evaluation below threshold

Run lists <15 formulas are evaluated inline (`formula.ts:2941-2951`) inside the
user's `setContext`. Each `execfunction` can itself read large ranges (e.g.
`VLOOKUP` over a big table). Cost depends on formula, not on count.

### 6.3 Chunked/worker evaluation still pays main-thread costs per chunk

Drain loop: `Workbook/index.tsx:1775-…`

- **Main-thread chunks** (jobs <100 or unsafe formulas): 50 formulas per
  `setContextWithProduce`, one per animation frame / macrotask.
- **Worker path**:
  - `initFormulaWorkerSnapshot` (`formula-worker-bridge.ts:150-183`) runs a
    `produce` that hydrates the needed sheets via `ensureSheetFlowdata`, then
    `postMessage` with the **dense `data` matrices** of those sheets. Structured
    clone of the message happens synchronously on the sender (main) thread — O(R×C)
    per needed sheet. It is redone whenever the snapshot key changes (each new job;
    `invalidateFormulaWorkerSnapshot` on sheet switch).
  - Per chunk, `buildWorkerEvalInput` copies `execFunctionGlobalData` (grows with
    the pass).
  - Results applied via `applyWorkerFormulaChunkResults` inside
    `setContextWithProduce` → `groupValuesRefresh` → `hooks.updateCellYdoc`.
- **Every chunk** therefore ends with: Immer pass + React re-render + Yjs write
  (§3.4) + `handleOnChangePortalUpdate` → **§3.1 full doc encode + full doc → plain**.
  A 10,000-formula recalc in 300-formula chunks → ~34 full-doc encodes.
  **[Inference]**
- While `groupValuesRefreshData.length > 0` the repaint effect returns early
  (`Sheet/index.tsx:108`), so the canvas may visibly lag behind during recalc.

### 6.4 `mergeFormulaDeps` invalidates a global cache per formula

`formula.ts:2228-2251` calls `invalidateSheetsRequiredDenseCache()` for every applied
worker result. If that cache is expensive to rebuild, it is rebuilt after every
chunk. (Not traced further.)

---

## 7. Load, remount and hydration

A "remount" is a change of `forceSheetRender`, which changes the `Workbook` `key`
(`editor-workbook.tsx:433`) and rebuilds the whole engine. It happens on:

- initial bootstrap (`use-editor-data.tsx:139-181`),
- collab sync completion (`rehydrateWorkbookFromYdoc`, `use-editor-data.tsx:1189`),
- **any remote batch touching >50 cells** or any structural remote change
  (`use-editor-data.tsx:239, 771-776`),
- CSV/XLSX import, template apply, etc. (`csv-import.tsx:156-160`).

Pipeline, all synchronous on the main thread:

| Step | Where | Cost |
|---|---|---|
| `ySheetArrayToPlain` | `update-ydoc.ts:608` | `toJSON` every Y.Map/Y.Array of every sheet, `Object.values`, filter calcChain, `expandSheetDataVerification` — O(N_all) |
| `applyCommentMarkers` | `apply-comment-markers` | over all sheets |
| `detachWorkbookData` = `lodash.cloneDeep` | `editor-workbook.tsx:426`, `detach-workbook-data.ts:10` | full deep clone of the workbook — O(N_all) |
| `produce(originalData, ensureSheetIndex)` + assign to `luckysheetfile` | `Workbook/index.tsx:1129-1132` | **[Inference]** Immer finalize walks/freezes the whole new workbook |
| `syncAndDemoteInactiveFlowdata` | `sheet-flowdata-lifecycle.ts:430` | converts inactive sheets' dense data back to celldata |
| `initSheetData` | `Workbook/index.tsx:286-348` | two `_.maxBy` over celldata; `_.times(R, () => _.times(C, () => null))` dense matrix; per-cell date formatting (`update(ct.fa, v)`) for date cells without `m`; `applyCellFormatRangesToData`; `applyMergeConfigToData`; nested `produce` |
| `updateContextWithSheetData` | `context.ts:764` | `calcRowColSize` O(R+C) |
| Sheet effects | `Sheet/index.tsx` | another `calcRowColSize`, `updateContextWithCanvas`, `initFreeze`, first `drawMain` (§5) |
| BTC/ETH scan | `Workbook/index.tsx:841` | §4.1 runs on mount |
| Font load repaint | `Workbook/index.tsx:947` | §5.5 |

Memory: the dense matrix holds R×C slots even for empty cells. **[Inference]** A
100k × 26 sheet is 2.6M slots for the active tab, before Immer freezing.
Undo history holds Immer patches; large pastes keep their values alive in
`undoList`.

Switching tabs re-runs the init effect (deps include `context.currentSheetId`), which
demotes the previous tab and hydrates the new one via `initSheetData` — same dense
build cost for the newly active sheet.

---

## 8. Collaboration (remote updates)

### 8.1 Full doc encode on every remote message

`src/sync-local/SyncManager.ts:1650-1685` (`applyRemoteYjsUpdate`) and
`:1715-1730` (queued contents):

```ts
Y.applyUpdate(this.ydoc, update, 'remote');
...
this.onLocalUpdate(
  fromUint8Array(Y.encodeStateAsUpdate(this.ydoc)),   // whole doc, base64
  fromUint8Array(update),
);
```

Every incoming keystroke from a collaborator → O(D) encode + O(D) base64 string.
`authorMirror` (`SyncManager.ts:888`) also encodes the full doc, but only after an
idle timer.

### 8.2 Large remote batches force a full remount

`use-editor-data.tsx:239` — `SURGICAL_CELL_LIMIT = 50`. A collaborator pasting 51
cells, filling down, or a recalculation that writes >50 results makes every peer run
the full §7 pipeline (debounced 50 ms). Peers also lose transient UI state.

### 8.3 Surgical path is O(K × N)

`use-editor-data.tsx:1008-1052` (`patchPlainCelldata`):

```ts
changedKeys.forEach(({ action }, key) => {
  const idx = celldata.findIndex((cell) => cell.r === r && cell.c === c);   // linear
  ...
```

Each changed key does a linear search over the sheet's plain celldata array. For
mixed cell + `cellFormatRanges` transactions it instead calls `syncPlainSnapshot` →
full `ySheetArrayToPlain` (`use-editor-data.tsx:1153`).

Per remote cell, `applyRemoteCellValue` is a separate `setContext` (via
WorkbookInstance) → K Immer passes and potentially K re-renders.

### 8.4 Metadata-only remote changes can also rebuild the snapshot

`use-editor-data.tsx:1103-1105`: any remote `cellFormatRanges` change runs
`syncPlainSnapshot` (full doc → plain) even with zero cell changes. Remote `config`
whole-key replacement marks *every* config key as changed
(`use-editor-data.tsx:631-642`).

### 8.5 IndexedDB persistence

`y-indexeddb` stores each update and periodically compacts by writing a full
`encodeStateAsUpdate`. **[Unverified]** The trim threshold and exact behaviour depend
on the installed y-indexeddb version; `persistence-compaction.ts` adds a compaction
pass on open. Not traced in detail.

---

## 9. Verification plan

None of the costs above were measured. To confirm and rank them:

1. **Fixture**: create sheets of increasing size, e.g. 10k×20, 50k×20, 100k×26,
   plus variants with (a) 1,000 `=SUM(A:A)`-style formulas, (b) a whole-column CF
   rule, (c) frozen row + column, (d) 200 columns wide.
2. **Chrome DevTools → Performance**, CPU 4× throttle, record each scenario:
   - single cell edit (type + Enter),
   - click 10 different cells (selection only),
   - scroll 2 screens vertically,
   - paste 5k cells,
   - edit a cell that 1,000 formulas depend on,
   - collaborator edits 1 cell / pastes 100 cells (two browser profiles).
3. In the flame chart, look for these function names to attribute time:
   `encodeStateAsUpdate`, `ySheetArrayToPlain`, `toJSON`, `dataToCelldata`,
   `getSheetWithLatestCelldata`, `cloneDeep`, `calcRowColSize`, `compute`
   (ConditionFormat), `getCellOverflowMap`, `arrayMatch` (inside
   `execFunctionGroup`), `produceWithPatches`/`finalize`/`freeze` (Immer),
   `structuredClone`, `punchHoleInCellFormatRanges`, `postMessage`.
4. Add temporary `performance.mark/measure` around §3.1, §3.2, §4.1, §5.3, §6.1 to
   get numbers without the profiler overhead.
5. Check `[Yjs] updateAllCell caller=…` console logs to see whether §3.6 fires during
   normal use.

---

## 10. Fix candidates, by likely impact

Ordered by **[Inference]** expected impact ÷ effort. Each needs the profile in §9 to
confirm before investing.

| # | Fix | Addresses | Notes |
|---|---|---|---|
| 1 | Remove the immediate `.flush()` from `flushPortalUpdate` for normal edits (keep flush for `beforeunload`); throttle/debounce the full encode + plain rebuild | §3.1, §6.3 | Check the comment at `editor-context.tsx:305-308` — same-turn writes must encode together; microtask batching can stay, the flush-every-time is the problem |
| 2 | Replace `getSheet()` in sync helpers with a field-only accessor (no `dataToCelldata`); read old values directly from the sheet's `Y.Map` instead of `ySheetArrayToPlain` | §3.2, §3.3 | Mechanical; many call sites |
| 3 | Remove the per-selection BTC/ETH/SOL scan; compute the flag incrementally on cell write, or on load/remote apply only | §4.1 | Small, isolated change |
| 4 | Memoize the CF compute map keyed on (`data` ref, rules ref, selection only when draft preview is active); keep one `Canvas` instance (or hoist the overflow cache) across repaints; limit overflow scan to visible columns ± overflow reach | §5.1–§5.4 | Large scroll win if CF is used |
| 5 | Raise `SURGICAL_CELL_LIMIT` and batch remote cell applies into one `setContext`; use a `Map<"r_c", idx>` in `patchPlainCelldata` | §8.2, §8.3 | Reduces remounts for peers |
| 6 | Stop re-encoding the full doc in `applyRemoteYjsUpdate` unless the host needs it; pass the delta only | §8.1 | Check what `onLocalUpdate` consumers use |
| 7 | Avoid per-cell range expansion in `arrayMatch`: index formulas by position and test range containment instead of enumerating range cells | §6.1 | Algorithmic change in core formula engine; needs tests |
| 8 | Only rerun `calcRowColSize` when row/col count, `rowlen`/`columnlen`/hidden or zoom change, not on every `data` ref change | §3.5 | Track dimensions instead of `data` |
| 9 | In `updateYdocSheetData`, clone once per cell, skip `_.isEqual` after `celldataEntryEqual`, and batch range punching per transaction | §3.4 | |
| 10 | Make `detachWorkbookData` cheaper (structural clone of only what Immer will freeze, or `setAutoFreeze(false)` in the engine and keep Yjs-derived data separate) | §7, §4.2 | Needs care: the comment in `detach-workbook-data.ts` explains why the clone exists |
| 11 | Send the worker snapshot sparse (celldata) or as transferable buffers instead of dense matrices | §6.3 | |

---

## Appendix: complexity cheat sheet

| Trigger | Work on main thread | Section |
|---|---|---|
| Any Yjs write (local edit, formula chunk, hook sync) | O(D) encode + O(D) base64 + O(N_all) doc→plain | §3.1 |
| Formula entered / config changed / hyperlink, DV, CF, filter changed | O(N_all) doc→plain + O(R×C) `getSheet` per hook | §3.2, §3.3 |
| Paste / fill K cells | 2K `structuredClone` + K deep-equal + O(K×G) range punching | §3.4 |
| Any cell edit | O(R+C) `calcRowColSize` + full repaint | §3.5 |
| Selection change | O(R×C) scan + N allocations | §4.1 |
| Any `setContext` | Immer pass over Context; re-render of all context consumers | §4.2 |
| Scroll frame | new Canvas; CF compute over all rule ranges (×4 with freeze); visibleRows × C overflow scan | §5 |
| Edit with dependent formulas | O(Σ range sizes) `arrayMatch` + tokenizing F formulas | §6.1 |
| Formula job ≥100 | O(R×C) structured clone to worker per job; per chunk §3.1 | §6.3 |
| Load / tab switch / remote >50 cells / import | O(N_all) doc→plain + O(N_all) cloneDeep + O(R×C) dense build + Immer freeze | §7, §8.2 |
| Every remote message | O(D) encode + base64 | §8.1 |
| Remote ≤50 cells | O(K×N) `findIndex` + K `setContext` | §8.3 |
