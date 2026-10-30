# DSheet Performance Audit

**Date:** 2026-10-19 · **Repo state:** `main` @ `aa87284` (package `@fileverse-dev/dsheet` 4.1.20) · **Scope:** investigation only — no application logic was changed.

**How to read the evidence labels**

| Label | Meaning |
|---|---|
| **Measured** | Timed in a running browser in this audit (environment in §7). |
| **Code-confirmed** | Behaviour read directly in the source at the cited line; not timed. |
| **Hypothesis** | Plausible from the code but not verified by measurement or a full trace. |

All "expected impact" statements are **[Inference]** unless a measurement is cited. No optimization was implemented, so no speed-up is claimed as measured.

---

## 1. Executive Summary

Ranked by measured or code-confirmed impact on large sheets.

1. **Every cell commit serializes the whole document on the main thread — Critical, Measured.**
   `handleOnChange` in `src/editor/contexts/editor-context.tsx:411-433` runs `Y.encodeStateAsUpdate(ydoc)`, base64-encodes the result and runs `ySheetArrayToPlain` over every sheet. `handleOnChangePortalUpdate` (`:450-457`) calls `flushPortalUpdate` (`:443-448`), which calls the throttled function and then `.flush()`. The `.flush()` call removes the 1 s throttle.
   - On a 9,900×60 sheet with 198k populated cells, one commit took **~820 ms** from commit to paint. The same commit took ~48 ms on a sparse sheet with the same dimensions.
   - The host `onChange` was called with a **28.7 MB** string 776 ms after the commit, before the frame painted.
   - Four edits 50 ms apart caused **four** full serializations, 5.2 s in total.
   - This only happens when the host passes `onChange`. The demo does.

2. **Plain-text and internal paste run a per-cell DOM auto-fit that forces layout on every cell — Critical, Measured.**
   `calculateRangeCellSize` (`src/sheet-engine/core/paste-helpers/calculate-range-cell-size.tsx:87-140`) writes `textContent` into a hidden div and reads `scrollWidth` once per cell (and `scrollHeight` per wrapped cell). Each read forces a synchronous layout.
   - It is called from `resizePastedCellsToContent` (`paste/paste-internals.ts:2220`). That function runs for plain-text paste (`paste/clipboard-entry.ts:189`), dsheet→dsheet internal paste (`:49`) and paste inside the cell editor (`:204`).
   - Pasting 10,000 cells as plain text took **~3.0 s**, and the measurer alone took **2.8 s** (≈93%).
   - The same 10,000 cells pasted as an HTML table, which skips the measurer, took **~250 ms**.

3. **Conditional formatting is recomputed over its entire rule range on every repaint — High, Measured.**
   `Canvas.drawMain` calls `getComputeMap(this.sheetCtx)` (`core/canvas.ts:801`). `compute()` (`core/modules/ConditionFormat.ts:809`) loops over every cell of every rule's `cellrange`, not only the viewport, on every scroll frame.
   - One `greaterThan` rule over 100k cells cost **~28 ms per repaint**.
   - With that rule, scroll p95 frame time rose from 30 ms to **65 ms**, with 30 long tasks totalling 1.7 s over 60 frames.
   - The `formula` condition type runs `functionCopy` + `execfunction` per cell per repaint (`:1816-1840`). It also **crashes** the render (`Cannot assign to read only property 'calculateSheetId'`) because it mutates frozen state from inside a React effect. No UI or import path that creates this rule type was found by grep, so this is latent.

4. **Paste and recalculation fall back to rebuilding the whole formula graph — High, Code-confirmed + partially Measured.**
   `execFunctionGroup` (`core/modules/formula.ts:2465-2519`) narrows to dependents only when `origin_r/origin_c` are set **and** `dependents.size > 0`. Otherwise it tokenizes every formula in `calcChain` and `arrayMatch` walks every cell of every referenced range (`:2547-2587`, `:2797-2819`).
   - `jfrefreshgrid` → `runExecFunction` (`core/modules/refresh.ts:6-27`) always passes `null` origins, so **every paste rebuilds the full graph**.
   - Editing a cell that no formula references also takes the full path. With 500 formulas this measured 11 ms vs 2 ms for a referenced cell. Cost scales with formula count × referenced range sizes.

5. **Opening and paste-growing a large sheet allocates dense matrices and several full copies — High, Measured (heap) + Code-confirmed (copies).**
   - Opening the 198k-cell document took **~3.4 s** to data-ready, with JS heap at **339 MB**.
   - A 198k-cell HTML paste blocked for **~6.1 s** (one 4.65 s long task) and raised the heap by 251 MB at peak.
   - Copies held at the same time:
     - Yjs doc
     - `currentDataRef` plain array (`ySheetArrayToPlain`)
     - `detachWorkbookData` `cloneDeep` (`src/editor/utils/detach-workbook-data.ts:10`)
     - immer-frozen `luckysheetfile` with a dense `R×C` `data` matrix built by `initSheetData` (`Workbook/index.tsx:312-314`)

6. **Every context change re-renders the whole workbook React tree — Medium–High, Code-confirmed.**
   - Scroll position, hover, selection and editor state all live in one immer `Context` that is passed through `WorkbookContext` (`Workbook/index.tsx:901-918`).
   - 51 components call `useContext(WorkbookContext)` and none use `React.memo`.
   - Each wheel frame runs `ScrollBar.onScroll` → `setContextWithProduce` → `produceWithPatches` → a full re-render of Toolbar, FxEditor, SheetOverlay, SheetTab and the rest.
   - Each document `mousemove` does the same, plus `getBoundingClientRect()` inside the state updater (`SheetOverlay/index.tsx:418-456`).

7. **Each edit triggers a second full pass that recomputes row/column offsets in O(rows + cols) — Medium, Code-confirmed.**
   `Sheet/index.tsx:53-64` re-runs `updateContextWithSheetData` whenever `data` changes identity, which happens on every immer edit. `calcRowColSize` (`core/context.ts:628-713`) rebuilds `visibledatarow` (R entries) and `visibledatacolumn`. The new array identities then re-trigger `initFreeze` and a full repaint.

8. **A remote change of more than 50 cells remounts the whole workbook on every peer — Medium–High, Code-confirmed.**
   - `SURGICAL_CELL_LIMIT = 50` (`src/editor/hooks/use-editor-data.tsx:239`). Above it, `scheduleStructuralRemount` (`:737-768`) runs `ySheetArrayToPlain` and bumps `forceSheetRender`, which changes the Workbook `key` (`editor-workbook.tsx:433`).
   - That forces a full re-initialization (finding 5) on every collaborator.
   - Separately, `SyncManager` re-encodes the **full** document after every incoming remote update (`src/sync-local/SyncManager.ts:1676-1680`, `:1726-1731`).

9. **Selection change scans the entire sheet — Medium, Code-confirmed + Measured (small at tested size).**
   - The effect at `Workbook/index.tsx:841-899` runs `api.dataToCelldata(getFlowdata(ctx))` (R×C) on every `luckysheet_select_save` change, only to toggle a crypto-denomination banner. It also writes DOM styles from inside a `setContext` updater.
   - Measured ~8 ms for a 594k-slot scan, so arrow navigation stayed at ~2 frames at 9.9k rows. This is linear and grows with sheet size.

10. **Undo history is unbounded and holds immer patches — Medium, Code-confirmed.**
    `globalCache.current.undoList.push(...)` (`Workbook/index.tsx:653`) has no cap. A 10k-cell paste stores at least 10k patches with cell values. Memory retained grows with session length.

---

## 2. Architecture Overview

**Engine.** The engine is not upstream Luckysheet or a `luckysheet` npm package. It is a **vendored fork of FortuneSheet** (a React + immer rewrite of Luckysheet) in `src/sheet-engine/`:
- `core/`: model, canvas, events, formula, paste
- `react/`: Workbook, Sheet, overlays
- `formula-parser/`
- Formula functions come from `@fileverse-dev/formulajs` 4.4.55.

The application wrapper is `src/editor/` (DSheetEditor, editor context, sync hooks). Collaboration is in `src/sync-local/`.

**State.** One large immer object, `Context` (`core/context.ts`), held in `useState` in `Workbook` (`react/components/Workbook/index.tsx:243`). It contains:
- workbook data: `luckysheetfile[]`, each sheet with a dense `data: (Cell|null)[][]` for the active sheet, while inactive sheets stay sparse `celldata` (`api/sheet-flowdata-lifecycle.ts`)
- layout: `visibledatarow`, `visibledatacolumn` (cumulative pixel offsets, length R and C)
- view state: `scrollTop`, `scrollLeft`
- selection, editor state, hover and all other UI state

All mutations go through `setContextWithProduce` (`Workbook/index.tsx:592-670`), which uses `produceWithPatches` unless `noHistory` is set. `filterPatch` keeps the `luckysheetfile` patches for undo and `emitOp`.

**Rendering.**
- `Sheet` (`react/components/Sheet/index.tsx:106-288`) creates a `new Canvas(...)` and repaints whenever any of ~20 context fields change, including `scrollTop`, `scrollLeft` and `luckysheetfile`. Every repaint is a full clear and redraw of the visible viewport.
- `drawMain` (`core/canvas.ts:523-1460`) is properly viewport-bounded for cells: it uses `_.sortedIndex` on the offset arrays (`:615-657`), and borders use the range-clamped `getBorderInfoComputeRange` (`:1317`).
- Two parts of each repaint are not viewport-bounded: the conditional-format compute (`:801`) and the overflow scan, which walks every column of each visible row (`:1489`).

**Persistence and sync (verified present):**
- **Yjs**: peer dependency `yjs` 13.6.30, document per `dsheetId`. Cells live in a `Y.Map` keyed `r_c`.
- **IndexedDB**: `y-indexeddb` `IndexeddbPersistence` (`src/editor/hooks/use-editor-sync.tsx:107`), which stores incremental updates, plus a compaction pass (`:123`).
- **Local edits** reach Yjs through `ctx.hooks.updateCellYdoc` → `updateYdocSheetData` (`src/editor/utils/update-ydoc.ts:182-606`), one `ydoc.transact` per batch. This path is incremental.
- **Host notification** goes through `handleOnChangePortalUpdate` → full-state `encodeStateAsUpdate` + base64 + `ySheetArrayToPlain` (finding 1). This path is **not** incremental.
- **Collaboration**: Socket.IO plus encrypted Yjs deltas (`SyncManager.ts`). Outgoing updates are batched with a flush timer (`:620-692`), which is good. Incoming updates trigger a full-state encode (`:1676-1680`).
- **Formula worker**: `core/modules/formula-worker-bridge.ts` and `formula-eval.worker.ts` handle async evaluation when the run list is at least `FORMULA_ASYNC_EVAL_THRESHOLD = 15` (`formula-async-eval.ts:2`). Graph construction (finding 4) still runs on the main thread.

**Flows traced**

| Flow | Call chain |
|---|---|
| Open | `EditorWorkbook` `workbookData` = `detachWorkbookData(currentDataRef)` (`editor-workbook.tsx:418-427`) → `Workbook` init effect (`Workbook/index.tsx:1113-1276`) → `initSheetData` builds a dense `_.times(R, () => _.times(C, null))` matrix (`:312`) → `updateContextWithSheetData` → `calcRowColSize` O(R+C) → `Sheet` effects → `updateContextWithCanvas` → `drawMain`. |
| Scroll | wheel → `use-smooth-scroll.tsx:58-86` (rAF-coalesced, good) → sets `scrollbarY.scrollTop` → `ScrollBar` `onScroll` (`SheetOverlay/ScrollBar/index.tsx`) → `setContext(scrollTop)` (`produceWithPatches`) → full Workbook re-render → `Sheet` repaint effect → `drawMain` + headers. |
| Arrow key | `Workbook.onKeyDown` → `handleGlobalKeyDown` (`core/events/keyboard.ts`) → `moveHighlightCell` (`core/modules/selection.ts:1142`) → `normalizeSelection` + `scrollToHighlightCell` → re-render, plus selection effect (`Workbook:841`, full scan) and `SheetTab` `calcSelectionInfo` over the selection (`SheetTab/index.tsx:88-96`). No canvas repaint unless the view scrolls (the repaint deps intentionally omit selection). |
| Edit and commit | `InputBox.onChange` per keystroke (`SheetOverlay/InputBox.tsx:2207`) → 1–2 `setContext` calls and several local `useState`s. Enter → `updateCell` (`core/modules/cell.ts:1287-2032`) → `execFunctionGroup` / `execfunction` → `setCellValue` → `setTimeout(afterUpdateCell)` → editor `afterUpdateCell` → `updateCellYdoc` → `handleOnChangePortalUpdate` → microtask → full serialize (finding 1). The `Sheet` data-change effect then re-runs `calcRowColSize` (finding 7). |
| Paste | `document` `paste` → `Workbook.onPaste` (`Workbook/index.tsx:1619-1757`) parses the HTML into a DOM just to count `<tr>` (`:1668-1671`) and may `insertRowCol`. Inside one `setContextWithProduce` → `handlePaste` (`paste/clipboard-entry.ts:63`) → one of: HTML `handlePastedTable` (`paste-table-helpers.ts:550`) → `pasteHandler`; internal `pasteHandlerOfCopyPaste` (`paste-internals.ts:1524`); or plain text `pasteHandler` (`:371`). Then a single batched `updateCellYdoc(changes)` (`:599`, `:915`), `jfrefreshgrid` (full formula graph, finding 4) and, for text/internal paste, `resizePastedCellsToContent` (finding 2). |

The native paste path is **batched** (one immer transaction, one Yjs transaction). The programmatic API `setCellValuesByRange` (`core/api/range.ts:95-160`) loops `setCellValue` per cell, and any formula or `<span` string value goes through a full `updateCell` per cell (`core/api/cell.ts:170-176`), each with its own `execFunctionGroup`. Inserting formulas cell by cell was measured as superlinear: 2.2 ms/formula for the first 100 and 3.9 ms/formula for the next 400.

---

## 3. Scrolling and Navigation Findings

### S1. Per-frame full React re-render driven by `scrollTop` in shared context — High, Code-confirmed
- **Where:** `SheetOverlay/ScrollBar/index.tsx` `onScroll` → `setContext`; `Workbook/index.tsx:901-918` (`providerValue` changes on every context change); 51 `useContext(WorkbookContext)` consumers; 0 `React.memo`.
- **Why it scales:** the per-frame cost is the whole UI tree, not the sheet size. Some consumers do size-dependent work during render. `SheetOverlay` (`index.tsx:126`) recomputes memos keyed on `visibledatarow` and `flowdata`.
- **Measured context:** sparse 9,900×60 scroll stayed at ~16.6 ms median / 17.2 ms p95 (60 Hz), with 3 of 90 frames over budget. So on this machine the re-render cost fits inside a frame in dev mode for a sparse sheet. It is a fixed tax that adds to S2 and S3.
- **Suggestion:** keep scroll position out of React state. Repaint directly from the scroll handler in rAF, or put scroll in a separate store/ref that only `Sheet` and the overlays subscribe to. Split `WorkbookContext` (static refs and settings vs. volatile UI state) and memoize heavy children (Toolbar, SheetTab, FxEditor).
- **Complexity:** Medium–High. **Risk:** overlays positioned from `context.scrollTop` must still update; this needs careful selector design.

### S2. Repaint cost scales with populated visible cells — Medium, Measured
- On the same 9,900×60 dimensions: sparse p95 17.2 ms (3/90 frames late) vs populated p95 ~33–38 ms (44–45/90 late), with no long tasks over 50 ms in either.
- **Where:** `drawMain` → `cellRender` per visible cell: text info, `getMeasureText`, `checkCF`, and `getCellOverflowMap`, which loops every column of each visible row (`canvas.ts:1489`, O(visibleRows × totalCols)).
- `this.cellOverflowMapCache` lives on a `Canvas` instance that `Sheet` re-creates on every repaint (`Sheet/index.tsx:112`), and the measure-text cache is cleared 100 ms after each draw (`canvas.ts:1456-1459`). Both caches are effectively per-frame. **[Hypothesis]** reusing them across frames would reduce repeated text measurement.
- **Suggestion:** keep one `Canvas` instance per sheet. Invalidate the overflow and measure caches on data or format change instead of a timer. Limit the overflow scan to `[colStart - k, colEnd + k]`. Consider blitting the already-drawn region (`drawImage` shift) and drawing only the newly exposed rows. **Complexity:** Medium.

### S3. Conditional format computed over full rule ranges each repaint — High, Measured
- See summary item 3. `getComputeMap` → `compute` iterates the whole `cellrange` (`ConditionFormat.ts:809`, `:1152-1180`), plus the top-10, average and duplicate branches, which aggregate the whole range by nature.
- Measured +28 ms/repaint for 100k cells, and scroll p95 30 → 65 ms.
- **Suggestion:** cache the compute map keyed on (rules, data version). Recompute only on data or rule change, not on scroll. For per-cell predicate rules, evaluate lazily for visible cells only. **Complexity:** Medium. **Risk:** range-aggregate rules (top-N, above average, data bars, color scales) need range statistics cached separately.

### S4. Mouse move = full-context produce + forced layout — Medium, Code-confirmed
- `SheetOverlay/index.tsx:418-456`: a document-level `mousemove` listener (`:766`) calls `setContext` → `produceWithPatches` and, inside the updater, `getElementsByClassName(...)[0].getBoundingClientRect()` and `setHoveredCell`. Every pointer move re-renders the workbook.
- `use-smooth-scroll.tsx` auto-scroll during drag calls `setContext(mouseRender)` every rAF (`:159-183`).
- **Suggestion:** hit-test from a cached container rect, and only `setContext` when the hovered cell or link-card state actually changes. Never call `setState` or read layout inside an updater. **Complexity:** Low–Medium.

### S5. Navigation: selection effects scan the sheet and the selection — Medium, Code-confirmed / Measured
- `Workbook/index.tsx:841-899`: `dataToCelldata` over all R×C on every selection change (measured ~8 ms at 594k slots), plus DOM style writes from inside the updater.
- `SheetTab/index.tsx:88-96`: `calcSelectionInfo` (`selection.ts:3634`) over every selected cell. Select-all of 9,900×60 measured a 132 ms long task. This runs on every intermediate drag-selection change.
- Arrow navigation measured ~33 ms key→paint (2 rAFs) with no long tasks on both small and 9.9k-row sheets. Not currently the bottleneck at these sizes.
- **Suggestion:** compute "denomination used" incrementally (on cell write) or once per sheet load. Debounce `calcSelectionInfo` and skip it during active drag. **Complexity:** Low.

### S6. Minor scroll/navigation items — Low, Code-confirmed
- `Workbook.onPaste` is a `useCallback` with `[context]` deps (`:1756`), and its effect (`:1763`) removes and re-adds the document `paste` listener on **every** context change, including each scroll frame.
- `useSmoothScroll` re-binds all wheel, pointer and mouse listeners whenever `context.luckysheetCellUpdate` changes (`use-smooth-scroll.tsx:629`).
- `devicePixelRatio` = 2 doubles canvas backing size (`context.ts:787-792`). **[Inference]** This raises fill and text cost by ~4× pixels. Measured frames still met budget on sparse sheets.

---

## 4. Editing and Typing Findings

### E1. Full document serialization per commit (throttle bypassed) — Critical, Measured
- **Where:** `src/editor/contexts/editor-context.tsx:411-433` (`handleOnChange`), `:443-448` (`flushPortalUpdate` → `.flush()`), `:450-457` (`handleOnChangePortalUpdate`). It is called from `updateYdocSheetData` (`update-ydoc.ts:603-605`) and from every `*YdocUpdate` helper.
- **Measured breakdown** (198k cells, 21.5 MB Yjs update):

  | Step | Time per call |
  |---|---|
  | `encodeStateAsUpdate` | 636–672 ms |
  | base64 | ~73 ms |
  | `ySheetArrayToPlain` | 45–128 ms |
  | **Total** | **≈775 ms** |

  This matches the 820 ms commit→paint. A stack captured on the host `onChange` call showed `lodash throttle leadingEdge → editor-context`.
- **Growth:** O(total document size) per edit, not O(changed cells).
- **Demo-specific:** `demo/src/App.tsx:49-57` writes the 28.7 MB string to `localStorage`, which throws `QuotaExceededError` at this size, so the demo silently stops saving.
- **Suggestion:** remove the `.flush()` (or debounce trailing-only, e.g. idle callback), and send hosts incremental updates (`Y.encodeStateAsUpdate(ydoc, lastSV)` or `ydoc.on('update')` deltas) instead of full state. Build the plain snapshot lazily, only when a host actually reads it. **Complexity:** Low for the throttle; Medium for the API change. **Risk:** host contract — consumers may rely on receiving full state; needs a versioned option. A comment (`editor-context.tsx:305-308`) explains same-turn coalescing intent (celldata + comment anchors); a microtask/idle debounce can keep that.

### E2. Second render pass per edit to rebuild row/col offsets — Medium, Code-confirmed
- `Sheet/index.tsx:53-64` → `updateContextWithSheetData` → `calcRowColSize` (`context.ts:628-713`) → O(R+C) plus new array identities → `initFreeze` (`Sheet:89-98`) + repaint + `SheetOverlay` memo recompute.
- **Suggestion:** depend on row/col config and dimensions (`data.length`, `data[0].length`), not on `data` identity. **Complexity:** Low. **Risk:** must still refresh when rows or columns are inserted.

### E3. Formula graph rebuilt when the edited cell has no recorded dependents — High (formula-heavy sheets), Code-confirmed + Measured
- `formula.ts:2466-2519`: `calcChainsToProcess = calcChains` unless `dependents.size > 0`. Then every formula is re-tokenized (`:2591-2791`) and every referenced range cell is visited (`arrayMatch`, `:2547-2587`).
- Measured 11 ms (unreferenced) vs 2 ms (referenced) with 500 `SUM(A:T)` row formulas. **[Inference]** It grows linearly with formulas × range size; a sheet with 10k `SUM` over 1k-row ranges implies ~10M inner iterations per edit.
- **Suggestion:** when the reverse-dependency graph is warm and has no entry for the origin, skip recalculation (plus wide-range and named-range formulas). Persist the parsed `formulaArray` per formula instead of re-tokenizing. **Complexity:** Medium. **Risk:** cold-graph and INDIRECT/OFFSET correctness. The existing `formulasWithWideRangeDeps` and named-range handling must stay.

### E4. Typing: multiple context updates and re-renders per keystroke — Medium, Code-confirmed / Hypothesis on cost
- `InputBox.onChange` (`InputBox.tsx:2207+`) issues up to two `setContext` calls (`noHistory`) and 3+ local `setState`s per keystroke. `InputBox` is ~3,000 lines, and each context change re-renders the full tree (S1).
- Two rAF polling loops exist only during column/row resize while editing (`:387-450`), which is acceptable.
- Typing latency was **not** measured (synthetic `input` events do not exercise contenteditable faithfully). **[Hypothesis]** Per-keystroke cost is dominated by the whole-tree re-render, not the sheet size.

### E5. `afterUpdateCell` hook object churn — Medium, Code-confirmed
- `editor-workbook.tsx:517-710` builds a fresh `hooks` object whenever the `workbookElement` memo recomputes. Deps include `syncStatus`, `dataBlockCalcFunction` and `isLiveCollabSession` (`:715-740`).
- `Workbook` then recomputes `mergedSettings` (`:268-273`) and re-runs the **init effect** (`:1113-1276`, deps include `mergedSettings.hooks`), which calls `updateContextWithSheetData` again. So a sync-status flip triggers a re-init pass.
- **Suggestion:** pass hooks through a stable ref-backed object. **Complexity:** Low.

### E6. Undo/redo history growth — Medium, Code-confirmed
- Unbounded `undoList` (`Workbook/index.tsx:653`), storing immer patches including whole-row values. Delete-sheet stores a `cloneDeep` of the sheet (`:633`).
- **Suggestion:** cap entries and/or total patch count. **Complexity:** Low.

---

## 5. Pasting Findings

### Measured paste costs (dev build, into an empty 84×60 sheet unless noted; 3 runs each)

| Cells | Path | Time to idle (long-task total) | Notes |
|---|---|---|---|
| 100 | plain text (TSV) | 53–56 ms | |
| 1,000 | plain text | 317–326 ms | |
| 10,000 | plain text | 2,845–3,092 ms | single long task |
| 100 | HTML table | 63–92 ms | |
| 1,000 | HTML table | 78–85 ms | |
| 10,000 | HTML table | 237–273 ms | |
| 198,000 (9,900×20, grows sheet to 9,900 rows) | HTML table | 6,109 ms (max task 4,654 ms) | heap +251 MB peak |
| `calculateRangeCellSize` alone, 100 / 1,000 / 10,000 cells | — | 27–42 / 278–279 / 2,800–2,810 ms | |
| `updateYdocSheetData` alone, 100 / 1,000 / 10,000 changes | — | 1 / 9 / 37 ms | |
| Raw immer write of 10k cells via `setContextWithProduce` | — | 24 ms sync, 49 ms to paint | |

### P1. Per-cell forced layout in auto-fit — Critical, Measured
`calculate-range-cell-size.tsx:87-140`; callers `clipboard-entry.ts:49`, `:189`, `:204`.
- **Growth:** O(cells) forced layouts, ~0.28 ms each here. **[Inference]** The per-layout cost also grows with DOM size.
- **Suggestion:** measure with `CanvasRenderingContext2D.measureText`, as `core/utils` `getMeasureText` already does for rendering. Group by font and cache per (font, text). Skip numeric-only cells, or cap measurement to a sample per column. Only measure wrapped cells for height. **Complexity:** Low–Medium. **Risk:** row heights for wrapped text need a line-breaking algorithm. Today's DOM measurement handles that implicitly, so wrapped cells may need to keep DOM measurement, batched as all writes then all reads.

### P2. Paste always rebuilds the full formula graph — High, Code-confirmed
- `pasteHandler` → `jfrefreshgrid` (`paste-internals.ts:608`, `:931`, `:2155`, `:2162`) → `runExecFunction` (`refresh.ts:6-27`) pushes every pasted cell into `execFunctionExist`, then calls `execFunctionGroup(ctx, null, null, …)`, which bypasses dependent filtering (E3). Only negligible on formula-free sheets.
- **Suggestion:** compute dependents of the pasted rectangle from `revDepsByCell`. **Complexity:** Medium.

### P3. `data.includes('=')` triggers a whole-sheet formula scan on text paste — Medium, Code-confirmed
- `paste-internals.ts:932-934`: any `=` anywhere in the clipboard text (for example a URL query string) → `handleFormulaOnPaste(ctx, d)` (`:328-366`), which walks **all** R×C cells of the sheet, not the pasted range.
- In the object branch (`:609`), `data` is an array of rows, so `Array.prototype.includes('=')` is effectively never true.
- **Suggestion:** restrict to the pasted rectangle and to cells whose pasted value starts with `=`. **Complexity:** Low.

### P4. Clipboard HTML parsed twice — Low–Medium, Code-confirmed
`Workbook.onPaste` sets `ele.innerHTML = txtdata` only to count `tr` (`:1668-1671`), then `handlePastedTable` parses it again (`paste-table-helpers.ts:557-558`). Measured `tSync` 169 ms for a 5.3 MB payload. **Suggestion:** count rows with a regex, or reuse the parsed container. **Complexity:** Low.

### P5. Internal (dsheet→dsheet) paste does whole-sheet work — Medium, Code-confirmed
- `pasteHandlerOfCopyPaste`:
  - `getBorderInfoCompute(ctx, copySheetIndex)` computes borders for the **entire source sheet** (`paste-internals.ts:1722`; `border.ts:1521-1546` uses `0..data.length`)
  - `_.cloneDeep` of the whole source `dataVerification` (`:1723-1726`)
  - `_.cloneDeep` of the copied matrix (`:1601`)
  - `JSON.parse(JSON.stringify(...))` per data-verification and hyperlink entry (`:1801`, `:2086`)
  - plus P1 auto-fit
- Not timed (synthetic copy could not drive `execCommand('copy')`).
- **Suggestion:** clamp the border compute to the copy range, and clone only the entries inside the copy range. **Complexity:** Low–Medium.

### P6. Row-count cap — note
`insertRowCol` throws `maxExceeded` when rows would reach 10,000 or columns 1,000 (`core/modules/rowcol.ts:352-357`). The paste that tried to grow past this failed with only a `console.error` (`Workbook/index.tsx:1711-1713`), so the user sees nothing happen. This bounds "large" sheets created through paste. `expandRowsAndColumns` and import paths are not subject to this check — **[Unverified]** whether imports can exceed it.

### P7. What is already good
- The native paste path is one immer transaction and **one** batched `updateCellYdoc` call (`paste-internals.ts:599`, `:915`).
- `updateYdocSheetData` uses one `ydoc.transact` and per-key `Y.Map` writes.
- Large pastes (>500 KB) yield two frames for a toast (`Workbook/index.tsx:1724-1745`), but the work itself is still one long task.

---

## 6. Memory and Data Structure Findings

| # | Pattern | Location | Complexity [theoretical] | Evidence |
|---|---|---|---|---|
| M1 | Dense active-sheet matrix `(Cell\|null)[][]` | `initSheetData` `Workbook/index.tsx:312-314`; `expandRowsAndColumns` | O(R×C) memory regardless of population | Code-confirmed |
| M2 | Multiple full copies of workbook data | Yjs doc; `currentDataRef` (`ySheetArrayToPlain`); `detachWorkbookData` `cloneDeep` (`detach-workbook-data.ts:10`); `luckysheetfile` (frozen by immer) | ~4× populated data at once | Code-confirmed; heap 339 MB after opening 198k cells (Measured) |
| M3 | Full-state encode + base64 + plain snapshot per edit | `editor-context.tsx:416-426` | O(doc) allocation per edit (28.7 MB string measured) | Measured |
| M4 | Paste transient | 198k-cell paste: +251 MB heap delta | O(pasted cells) with high constant | Measured |
| M5 | Unbounded undo patches | `Workbook/index.tsx:653` | O(total edited cells in session) | Code-confirmed |
| M6 | Per-cell `structuredClone` twice when writing to Yjs | `update-ydoc.ts:145-151` (`normalizeForYjs`) via `setMapValueSafe` and again at `:321` | O(cells) allocations; measured cheap (37 ms/10k) | Measured |
| M7 | `_.cloneDeep` of old **and** new cell on each `updateCell` | `cell.ts:1408`, `:2014` | O(1) per edit | Code-confirmed, low impact |
| M8 | `visibledatarow` rebuilt (new R-length array) per edit | `context.ts:629-651` | O(R) garbage per edit | Code-confirmed |
| M9 | Per-repaint allocations: `cellupdate`, `borderOffset` object keyed by string `${r}_${c}`, CF `computeMap` | `canvas.ts:675-785`, `:801` | O(visible cells) per frame; O(CF range) per frame | Code-confirmed. **[Hypothesis]** contributes GC pressure while scrolling; GC frequency not measured. |
| M10 | `getSheetIndex` linear scan, called inside hot paths (`getFlowdata` per call) | `core/utils/index.ts:122-129`, `context.ts:619-626` | O(sheets) per lookup | Code-confirmed, low impact with few sheets |
| M11 | Listener churn | `onPaste` listener re-registered per context change (`Workbook:1756-1764`); `useSmoothScroll` re-bind per edit start | — | Code-confirmed; no leak found (cleanups present) |

**Sparse vs populated (same 9,900×60 dimensions, Measured):**

| Metric | Sparse (100 cells) | Populated (198k cells) |
|---|---|---|
| Scroll p95 frame time | 17.2 ms | 33–38 ms |
| Commit → paint | 48 ms | 820 ms |
| JS heap | 78 MB | 188 MB (after paste session) / 339 MB (fresh open) |

Cost tracks **populated-cell count** for persistence and memory, and **visible populated cells** for scroll. Row count alone mostly affects `calcRowColSize` (O(R)) and dense-matrix allocation.

---

## 7. Profiling Results

**Environment**
- macOS (Darwin 23.6.0), Intel Mac UA string, 8 logical cores, `navigator.deviceMemory` 16 GB
- Claude desktop built-in Chromium **152.0.7977.149**
- Viewport emulated at 1440×900, DPR 2, display at 60 Hz (idle rAF median 16.6 ms)
- The app was the repo's `demo/` (Vite **dev server**, unminified React development build), importing `src/` directly, with `enableIndexeddbSync` on, the demo `onChange` on (writes to `localStorage`) and no collaboration session.
- A dev launch config was added at `.claude/launch.json` (`npm --prefix demo run dev`, port 5000). No dependencies were installed.

**Method**
- A harness was injected via DevTools-style page JS (not committed). It reached the live Workbook context through the React fiber tree and imported engine modules through Vite's `/@fs/` URLs (same module instances).
- Timing used `performance.now()`, a `PerformanceObserver('longtask')` and two `requestAnimationFrame` hops as the "painted" marker.
- **Paste:** a synthetic `ClipboardEvent('paste')` with a `DataTransfer` on the real `document` listener, after setting `selectionCache.isPasteAction` (what Ctrl/Cmd+V keydown does).
- **Scroll:** one synthetic `WheelEvent` (deltaY 120) per frame on `.fortune-sheet-container` for 60–90 frames, exercising the real `use-smooth-scroll` handler.
- **Navigation:** synthetic `ArrowDown` keydown on the cell input, 20 presses.
- **Commit:** `setContext(d => updateCell(d, r, c, …))`, the same function Enter calls, so InputBox keystroke handling is **not** included.
- Datasets were created by paste into fresh documents: `dsheet-perf-populated-20k` (9,900×20 values in a 60-column sheet), `dsheet-perf-sparse-10k` (9,900 rows, 100 cells, later 20k cells + 500 formulas), `dsheet-perf-cf-10k` (5,000×20 + one CF rule). These IndexedDB docs remain in the browser pane's storage.

**Results**

| Scenario | Metric | Small 500×60 | Sparse 9,900×60 | Populated 9,900×60 (198k) |
|---|---|---|---|---|
| Scroll (90 frames) | median / p95 / max frame (ms) | 19.6 / 25.6 / 66.4 | 16.6 / 17.2 / 21.6 | 16.6–17.9 / 33.4–37.9 / 50–55.9 |
| | frames > 17.5 ms | 46/90 | 3/90 | 44–45/90 |
| Arrow navigation (20) | key→paint median / p95 (ms) | 33.3 / 44 | 33.3 / 38.6 | 33.7 / 63.4 |
| Cell commit (5) | commit→paint median (ms) | 101 | 48 | **819** |
| | long tasks | 4 (total 224) | 0 | 5 (total 3,919; max 811) |
| 4 rapid edits 50 ms apart | full-state `onChange` calls | — | — | 4 (at 764, 1,662, 2,612, 3,522 ms) |
| Select-all | long task | — | — | 132 ms |
| Open document | data-ready since navigation | — | — | 3,421 ms; heap 339 MB |

| Formula / CF scenario | Result |
|---|---|
| Insert 100 formulas `=SUM(Ar:Tr)` via `updateCell` in one transaction | 219 ms (2.2 ms each) |
| Insert next 400 | 1,539 ms (3.9 ms each) |
| `execFunctionGroup`, 500 formulas, origin unreferenced vs referenced | 11 ms vs 2 ms |
| Commit with 500 formulas + 20k cells: unreferenced vs referenced cell | 122–154 ms vs 208–213 ms (dominated by serialization) |
| CF `greaterThan` over 100k cells: `getComputeMap` | 27–56 ms per call |
| Scroll 60 frames, no CF vs CF | p95 29.6 → 64.8 ms; long tasks 0 → 30 (1,689 ms) |

**Limitations**
- Dev build. **[Inference]** A production build would lower absolute numbers, especially React render costs, but not the ratios driven by Yjs encode, DOM layout or O(N) loops.
- Single machine, single run of 60–90 frames per scroll scenario (2 runs on the populated sheet). Paste was repeated 3×. Edits were 5 per scenario.
- Variability: paste 10k text 2,845–3,092 ms; populated scroll p95 33.4–37.9 ms.
- Not measured: real keyboard typing latency, internal copy→paste, collaboration (remote apply, remount), the IndexedDB write cost, GC counts and the canvas-only draw time per frame (the JS Self-Profiling API needs a `Document-Policy` header that was not added), and sheets beyond 10k rows (the paste path caps at 10,000 rows).
- Sheets of 20k–50k rows could not be created through paste because of the row cap (P6) and were not created through import.
- The `formula` CF rule type crashed the render during testing (§1 item 3), so its per-frame cost was not measured.

---

## 8. Prioritized Optimization Plan

| Priority | Problem | Source File / Function | Evidence | Suggested Fix | Expected Impact | Complexity |
|---|---|---|---|---|---|---|
| P0 | Full-doc encode + base64 + toPlain on every edit; throttle bypassed by `.flush()` | `src/editor/contexts/editor-context.tsx` `handleOnChange` (411), `flushPortalUpdate` (443), `handleOnChangePortalUpdate` (450) | Measured: ~775 ms of 820 ms commit at 198k cells; 4 calls for 4 rapid edits | Drop `.flush()`, trailing/idle debounce; offer incremental updates to hosts; build plain snapshot lazily | High on large docs — removes O(doc) work from each edit path [Inference] | Low (throttle) / Medium (API) |
| P0 | Per-cell forced-layout auto-fit after paste | `core/paste-helpers/calculate-range-cell-size.tsx` `calculateRangeCellSize` (87-140) | Measured: 2.8 s of ~3.0 s for 10k-cell text paste | Canvas `measureText` with font/text cache; batch DOM reads only for wrapped cells | High for text/internal paste [Inference]; HTML path shows ~12× lower total today | Low–Medium |
| P1 | CF compute over full rule range each repaint | `core/canvas.ts` `drawMain` (801) → `core/modules/ConditionFormat.ts` `getComputeMap`/`compute` | Measured: +28 ms/repaint, scroll p95 30→65 ms | Cache compute map by data/rule version; viewport-lazy predicate rules | High for CF-heavy sheets [Inference] | Medium |
| P1 | Formula graph rebuilt on paste and on edits with no recorded dependents | `core/modules/formula.ts` `execFunctionGroup` (2465-2519); `core/modules/refresh.ts` `runExecFunction` | Code-confirmed; Measured 11 vs 2 ms at 500 formulas | Use rev-dep graph for range origins; skip when warm graph has no dependents; cache parsed ranges | High for formula-heavy sheets [Inference] | Medium |
| P1 | Remote change >50 cells remounts the workbook on peers; full encode per remote update | `src/editor/hooks/use-editor-data.tsx` (239, 737-768); `src/sync-local/SyncManager.ts` (1676-1680, 1726-1731) | Code-confirmed | Raise/remove the limit by applying batched cell changes; pass only the delta to `onLocalUpdate` | High in collaboration [Hypothesis — not measured] | Medium |
| P2 | Whole-tree re-render on scroll/hover/selection | `Workbook/index.tsx` (901-918), `ScrollBar`, `SheetOverlay` `onMouseMove` (418-456) | Code-confirmed; populated scroll p95 ~35 ms | Move scroll/hover out of React state or into a subscribable store; memoize heavy children; no layout reads in updaters | Medium [Inference] | Medium–High |
| P2 | Second render + O(R+C) offsets per edit | `Sheet/index.tsx` (53-64), `core/context.ts` `calcRowColSize` | Code-confirmed | Depend on dimensions and row/col config, not `data` identity | Medium [Inference] | Low |
| P2 | Dense matrix + ~4 data copies | `Workbook` `initSheetData`, `detachWorkbookData`, `currentDataRef` | Measured heap 339 MB @198k cells | Avoid `cloneDeep` detach (freeze-safe structural sharing); drop the redundant plain copy | Medium (memory, open time) [Inference] | Medium |
| P2 | `dataToCelldata` full scan on every selection change | `Workbook/index.tsx` (841-887) | Code-confirmed; ~8 ms @594k slots | Track denomination usage incrementally | Low–Medium | Low |
| P3 | `handleFormulaOnPaste` whole-sheet scan on any `=` | `paste/paste-internals.ts` (328-366, 932) | Code-confirmed | Restrict to pasted rect | Low–Medium | Low |
| P3 | Internal paste: whole-sheet border compute + cloneDeep | `paste-internals.ts` (1601, 1722-1726) | Code-confirmed | Clamp to copy range | Medium for internal paste [Inference] | Low |
| P3 | Unbounded undo history | `Workbook/index.tsx` (653) | Code-confirmed | Cap by entries/patch count | Memory over long sessions | Low |
| P3 | Hooks object churn re-runs Workbook init | `editor-workbook.tsx` (517-740) | Code-confirmed | Stable ref-backed hooks | Low–Medium | Low |
| P3 | Canvas instance + caches re-created per repaint | `Sheet/index.tsx` (112); `canvas.ts` (1456-1459) | Code-confirmed | Persist instance; event-based invalidation | Low–Medium [Hypothesis] | Low–Medium |
| P4 | Paste HTML parsed twice; paste listener re-registered per render | `Workbook/index.tsx` (1668-1671, 1756-1764) | Measured 169 ms parse for 5.3 MB | Regex row count; ref-based handler | Low | Low |

---

## 9. Quick Wins

Low-risk, localized changes. Expected effects are **[Inference]** until re-measured with §11.

1. **Remove `.flush()` calls in `flushPortalUpdate`** (`editor-context.tsx:443-448`) except for `beforeunload`, so the existing 1 s throttle actually coalesces. This keeps the microtask coalescing that the comment at `:305-308` relies on.
2. **Replace DOM measurement with `measureText`** for single-line cells in `calculateRangeCellSize`, with a `(font, text)` cache. Keep the DOM path for wrapped cells, batched as all writes then one read pass.
3. **Narrow `handleFormulaOnPaste`** to the pasted rectangle (`paste-internals.ts:328`).
4. **Clamp `getBorderInfoCompute`** in internal paste to the copy range (`paste-internals.ts:1722`).
5. **Change the `Sheet` data effect deps** (`Sheet/index.tsx:53-64`) from `data` to `data.length` / `data[0]?.length`, keeping the config deps.
6. **Move the denomination banner check** out of the per-selection effect (`Workbook/index.tsx:841-887`), and stop writing DOM inside `setContext` updaters.
7. **Make `onPaste` read `contextRef.current`** instead of closing over `context`, so the listener is registered once.
8. **Cap `undoList` length** (e.g. 100 entries).
9. **Debounce `calcSelectionInfo`** in `SheetTab` while a drag selection is in progress.
10. **Stabilize the `hooks` prop** passed from `EditorWorkbook` through a ref.

---

## 10. Architectural Improvements

1. **Incremental host persistence API.** Emit Yjs deltas (`ydoc.on('update')`, or `encodeStateAsUpdate(doc, stateVector)`) to hosts. Create full snapshots only on idle or explicit save, ideally in a Worker (`encodeStateAsUpdate` on a Worker-side doc replica).
2. **Split volatile view state from document state.** Keep `scrollTop`/`scrollLeft`, hover and drag state in refs or a tiny external store (`useSyncExternalStore`) that only the canvas and overlays subscribe to. Repaint the canvas directly from the rAF scroll handler.
3. **Cached render model.** Keep a persistent `Canvas` per sheet with:
   - a per-row overflow cache invalidated by edits
   - a font/text measurement cache
   - a CF compute cache keyed on a data version counter
   - optionally scroll-blitting (copy the already-drawn region and draw only the newly exposed strip)
4. **Formula dependency graph as the only recalc driver.** Maintain `revDepsByCell` incrementally (already partly present). Paste and range writes compute dependents of the changed rectangle. Store parsed reference ranges per formula and move graph construction for large recalcs to the existing formula worker.
5. **Sparse cell storage for the active sheet.** Replace dense `data[R][C]` with row-sparse storage (`Map<row, Cell[]>` or chunked rows), with row/column offsets in a Fenwick/prefix-sum structure for O(log R) updates when a row height changes, instead of O(R) `calcRowColSize`. This touches most of `core/`, so it is the largest change and highest risk.
6. **Surgical remote apply for large batches.** Apply remote cell batches through the same batched `setContext` path used by paste instead of remounting above 50 cells.
7. **Single source of truth for workbook data.** Derive the plain `currentDataRef` lazily from Yjs and remove the `cloneDeep` detach copy by giving immer data that is not shared with Yjs objects.

---

## 11. Benchmark and Validation Plan

**Harness.** Promote the in-page approach from §7 into a repeatable script (Playwright against `vite preview` of a production build, or the dev server for A/B). Steps:
1. Create documents by synthetic `ClipboardEvent('paste')` with generated TSV or HTML. Use the import path once the 10k-row cap (P6) is addressed, for 20k–50k-row datasets.
2. Datasets:
   - small 1,000×20
   - medium 10,000×20
   - sparse (same dimensions, ~100 cells)
   - formatting-heavy (fonts, bg, borders on 50% of cells, wrapped text)
   - formula-heavy (1k–10k `SUM`/`VLOOKUP` over ranges)
   - CF-heavy (2–5 rules over full columns)
3. Metrics per scenario, ≥3 runs, report median and spread:
   - **Scroll:** 120 wheel frames → frame-interval median/p95/max, frames >16.7 ms, long-task count and total (`PerformanceObserver('longtask')`), and with the Self-Profiling API (add `Document-Policy: js-profiling` to the preview server) the time in `drawMain`/`getComputeMap`.
   - **Navigation:** 50 ArrowDown/ArrowRight presses → key→paint median/p95.
   - **Commit:** 10 commits through `updateCell` and through real keyboard input (Playwright `keyboard.type` + Enter) → commit→paint, long tasks, count and size of `onChange` invocations.
   - **Typing:** Playwright `keyboard.type` of 50 chars in the cell editor → `event.timeStamp` to next rAF (INP-style).
   - **Paste:** 100 / 1k / 10k cells × {TSV, HTML table, internal} → time to idle, longest task, heap delta (`performance.memory` or `measureUserAgentSpecificMemory`), Yjs update size.
   - **Open:** navigation → data-ready and first canvas paint, plus heap.
   - **Collaboration:** two pages in one room; apply a 1k-cell paste on A and measure B's time to repaint and whether it remounted (`forceSheetRender` increments).

**Regression and correctness checks** to run alongside each change:
- **Formulas:** recalc results equal before and after for chains, circular references, named ranges, cross-sheet refs, INDIRECT/OFFSET, spill results. The repo has `vitest` (`npm run test:unit`). Add graph-dependency unit tests around `execFunctionGroup` before changing E3/P2.
- **Styling:** paste keeps column widths and row heights (the existing `docs` copy/paste sizing issues), wrap behaviour, borders, merges and `cellFormatRanges`. Compare auto-fit sizes from the canvas-measure path vs the current DOM path on a fixture (tolerance ±2 px).
- **Undo/redo:** paste, insert/delete row, CF rule edit and border edit undo/redo round-trip. The undo cap must not break the delete-sheet restore.
- **Clipboard:** internal copy→paste (values-only and full), Excel/Google Sheets HTML, plain TSV, CSV-quoted multiline, URL autolink, the formula-string paste path.
- **Synchronization:** Yjs celldata equals the workbook after edit/paste/undo (`ySheetArrayToPlain` vs `getFlowdata`). An IndexedDB reload restores identical data. Collaborative peers converge. Hosts that consume `onChange` still receive what they need (contract test for both full-state and any new delta API).
- **Rendering:** screenshot diffs of a fixed viewport (borders, CF colors, overflow text, frozen panes) before and after the renderer and caching changes.
