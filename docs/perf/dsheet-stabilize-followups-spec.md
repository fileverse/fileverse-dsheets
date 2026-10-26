# dSheet Stabilize Follow-ups

Draft for team review. A companion to P1 Stabilize: it covers hot paths and loss paths from the perf audit that P1 does not mention. Ships after P1 or alongside it; independent of P2 YSheetStore.

Line numbers refer to fileverse-dsheet `maitra/perf-improvements` at the time of writing (package 4.1.20, after `edc4182`). Each one was re-read in the source for this ticket.

Evidence labels:

- **Measured (browser):** PERFORMANCE_AUDIT.md (dev build, 9,900×60 sheet, 198k cells).
- **Code-confirmed:** read at the cited line; not timed.
- **[Inference]:** reasoning from the code, to be confirmed.

**Scope and priority order** (highest impact first):

1. P3. Clipboard HTML parsed once, in an inert document
2. P1. Formula re-evaluation limited to the pasted range
3. G1. Row/column offsets only when layout changes
4. G4. Selection stats off the drag path
5. P2. Paste recalculates only what depends on the pasted cells
6. G2. Text-overflow map cached per row across frames
7. F1. Range writes recalculate once
8. G3. Text-measure cache survives scrolling
9. F4. Every dynamic array is included in the function group (bug)

Item IDs are kept stable for cross-reference with the review notes.

## 1. Goal

Remove the remaining per-edit, per-frame and per-paste work that scales with sheet size and that P1 does not touch, inside today's architecture and storage format. It keeps P1's rule for inclusion: local to a few functions, no Yjs schema change, and nothing that fights the YSheetStore direction. Same two kinds of sheet:

- **Large:** one 100k-cell tab, about 10 concurrent editors.
- **Small but heavily used:** about 100 rows with dropdowns, formatting and fills.

**Rule for inclusion:** a change is in scope if it fixes a measured cost, a code-confirmed cost that scales with sheet size, a security issue or a correctness bug, and is local to a few functions.

## 2. Baseline and targets

| Cost today | Value | Target |
|---|---|---|
| HTML paste parsing (P3) | parsed twice; 169 ms for a 5.3 MB payload (measured); first parse runs in the live document | one inert parse |
| Text paste containing `=` anywhere (P1) | every cell of the sheet scanned, and every cell whose raw value starts with `=` re-evaluated and rewritten to Yjs, inside or outside the pasted range (code-confirmed) | pasted range only |
| Row/column offsets per local edit (G1) | O(rows + columns) rebuild, a second context update, `initFreeze` and a full repaint on every edit, including edits off screen (code-confirmed) | none unless rows, columns, sizes, hidden state, zoom or merges change |
| Selection stats in the tab bar (G4) | 132 ms long task on select-all at 9,900×60, repeated on every drag step (measured) | no work during a drag; one deferred pass after it |
| Paste on a sheet with formulas (P2) | full formula pass over every formula and every referenced range (code-confirmed) | the pasted cells' dependents only, once the graph is complete |
| Text-overflow map per draw (G2) | every column of every visible row scanned; rows with no overflow never cached; cache dropped on every repaint (code-confirmed) | each row scanned once per change to that row or to column layout |
| Data-block result write of N formulas (F1) | one full `updateCell` and formula pass per formula; 2.2 ms each for the first 100, 3.9 ms for the next 400 (measured, superlinear) | one formula pass per range write |
| Text-measure cache (G3) | cleared 100 ms after every draw, although it is already capped at 5,000 entries (code-confirmed) | survives scrolling; cleared only on font, zoom or pixel-ratio change |
| Dynamic arrays in recalculation (F4) | only the first dynamic array of each sheet is included, repeated; the others are skipped (code-confirmed bug) | every dynamic array included |

## 3. Non-goals

- Everything P1 lists as a non-goal still applies: no storage format change, no change to `SURGICAL_CELL_LIMIT`, no split of the engine's Context, scroll stays in React state, no workers.
- No change to how the formula engine builds its dependency graph. P2 here reads `revDepsByCell` the way P1 C8 does. The per-cell range expansion in `arrayMatch` (`formula.ts:2547-2587`) is a graph-construction change and is left out.
- Code that YSheetStore deletes is not optimised here: `updateAllCell` (`editor-workbook-sync.ts:506-579`), the remote `cellFormatRanges` path that rebuilds the plain snapshot (`use-editor-data.tsx:1103-1105`), the per-feature hooks.
- Nothing outside the nine items listed at the top.
- Review comments on P1 itself (the D6 upgrade edge case, D6 when IndexedDB is off) go on the P1 ticket, not here.

## 4. Design

### P3. Clipboard HTML parsed once, in an inert document

**Root cause.**

- `Workbook.onPaste` sets `innerHTML` of a `div` created with `document.createElement` (`react/components/Workbook/index.tsx:1665-1671`), only to count `table tr` and decide how many rows to insert.
- `handlePastedTable` then parses the same HTML again (`core/paste/paste-internals.ts:2255`). That's 169 ms for a 5.3 MB payload (measured).
- [Inference, to confirm with a repro] An element created by the live document starts loading `<img>` sources when its `innerHTML` is set, even when detached, and runs inline handlers such as `onerror`. HTML on the clipboard comes from whatever page the user copied from, so it could run script in the app's origin. The same pattern is at `fortune-internal-paste.ts:15`.

**Fix.**

- Parse once with `new DOMParser().parseFromString(html, 'text/html')`. That document is inert: no image loads, no handlers.
- Count rows from it, and pass the parsed document to `handlePastedTable` instead of the string.
- Switch `paste-internals.ts:2255` and `fortune-internal-paste.ts:15` to the same parser.
- The cell editor's own `innerHTML` writes (`Workbook/api.ts:183, 806, 823`) write formula text the app produced. Check them during implementation; they are not in scope unless they take clipboard input.

### P1. Formula re-evaluation limited to the pasted range

**Root cause.**

- In both paste branches (`core/paste/paste-internals.ts:608-611` and `:931-934`), `jfrefreshgrid` is followed by `if (data.includes('=')) handleFormulaOnPaste(ctx, d)`.
- `data` is the clipboard text, so any `=` triggers it, including one in a URL query string.
- `handleFormulaOnPaste` (`:328-369`) receives `d`, the **whole sheet**. It loops over every row and column and runs `execfunction` on every cell whose raw value starts with `=`, anywhere in the sheet. It then sends all of those cells to `updateCellYdoc`, so cells outside the pasted range get rewritten in Yjs.
- In the object branch `data` is an array of rows, so `Array.prototype.includes('=')` is effectively never true there.

**Fix.**

- Pass the pasted range (the target rectangle `pasteHandler` already computes) to `handleFormulaOnPaste` and loop over that range only.
- Replace `data.includes('=')` with the per-cell `startsWith('=')` check, which is already in the loop. The extra string scan of the clipboard text goes away.
- The Yjs changes then cover only pasted cells.

### G1. Row/column offsets only when layout changes

**Root cause.**

- The effect at `react/components/Sheet/index.tsx:53-64` depends on `data`. Immer gives `data` a new identity on every cell write.
- Each edit therefore runs `updateContextWithSheetData` → `calcRowColSize` (`core/context.ts:628-713`) inside a second `setContext`. It rebuilds `visibledatarow` (one entry per row) and `visibledatacolumn` as new arrays.
- The new identities re-trigger `initFreeze` (`Sheet/index.tsx:89-98`), the repaint effect and the `SheetOverlay` memos keyed on them. Every edit pays a second render and a full repaint, even when the edited cell is off screen.
- `calcRowColSize` reads `flowdata[0][c]`, but that branch never changes the width: `firstcolumnlen` is still `defaultcollen` there, so the `!== defaultcollen` write never runs. The data dependency has no effect on the result.

**Fix.**

- Change the effect's dependencies from `data` to `data.length`, `data[0]?.length`, `context.config.merge` (for `normalizeSelection`), and the existing `rowlen`, `columnlen`, `rowhidden`, `colhidden` and `zoomRatio`.
- In `updateContextWithSheetData`, compute the two arrays into locals. Assign them to the draft only when their length or any entry differs, so an unchanged layout keeps the old identities and triggers nothing downstream.
- Delete the dead `flowdata[0][c]` branch, or leave it with a comment that it doesn't depend on data. Either way, no data dependency remains.

### G4. Selection stats off the drag path

**Root cause.**

- The effect at `react/components/SheetTab/index.tsx:88-96` runs `calcSelectionInfo` (`core/modules/selection.ts:3634-3688`) on every `luckysheet_select_save` change.
- It visits every cell of every selected range, with `parseFloat` and a regex replace per cell.
- Select-all on 9,900×60 measured a 132 ms long task, and a drag selection repeats it on every intermediate step.
- P1 E2 converts SheetTab to a selector, but the selection is one of its inputs, so this work still runs.

**Fix.**

- While a drag selection is in progress (the `globalCache` flag `handleOverlayMouseMove` already reads), do nothing. Compute once when the drag ends.
- Otherwise, run it in `requestIdleCallback` (with a `setTimeout` fallback), cancelling a pending run when the selection changes again.
- Fast path: a single-cell selection reads one cell directly.
- When E2 converts SheetTab, its selector includes `luckysheet_select_save` and the sheet's `data` identity, so stats update after an edit inside the selection.

### P2. Paste recalculates only what depends on the pasted cells

**Root cause.**

- Every native paste path calls `jfrefreshgrid(ctx, null, undefined)` (`paste-internals.ts:608, 931`, and `:2155, :2162`).
- That calls `runExecFunction` (`core/modules/refresh.ts:6-26`), which pushes every selected cell into `execFunctionExist` and calls `execFunctionGroup(ctx, null, null, …)`.
- With null origins, `execFunctionGroup` skips dependent filtering. It re-tokenizes every formula in the chain and walks every referenced range (`formula.ts:2466-2519`), on every paste, whatever was pasted.

**Fix.**

- Add `execFunctionGroupForRange(ctx, sheetId, rect)`, used by the paste paths instead of the null-origin call. It builds the set to recalculate from data the engine already keeps:
  - each pasted cell's entry in `revDepsByCell`;
  - `formulasWithWideRangeDeps`;
  - formulas that reference a defined name covering any part of the rectangle (same rule as `:2482-2512`);
  - the pasted formula cells themselves.
- Then runs the existing ordering and evaluation on that set.
- Requires P1 C8's `depGraphComplete`. When the flag is false, fall back to today's full pass. After the flag turns true (P1 C8 now builds the index from formula text in idle time after open, instead of waiting for a full pass), later pastes take the narrow path.
- Pasted formulas enter the chain evaluated, so they keep the graph complete. That changes P1 C8's rule "a paste turns the flag false" to "a paste turns it false only when it takes the fallback".

Reads the graph, doesn't change how it is built (section 3).

### G2. Text-overflow map cached per row across frames

**Root cause.**

- `getCellOverflowMap` (`core/canvas.ts:1463-1624`) loops over every column of each visible row (`:1489`), not just the visible ones. For each cell with overflow mode (`tb === '1'`) it runs `getCellTextInfo`, a text measurement.
- Its cache has three holes:
  - it lives on the `Canvas` instance, and `Sheet` creates a new instance on every repaint (`Sheet/index.tsx:112`);
  - it is cleared by the 100 ms timer (`canvas.ts:1456-1459`);
  - it stores a row only when that row has an overflowing cell (`:1618-1620`), so rows without overflow are rescanned on every draw.
- Cost per draw is visible rows × total columns. Wide sheets pay most when scrolling vertically.

**Fix.**

- Replace `cellOverflowMapCache` with a module-level `WeakMap` keyed by the row array (`data[r]`).
  - Immer keeps an untouched row's array identity, so an edit invalidates only its own row.
  - Each entry stores its result (possibly empty) plus the identities of `visibledatacolumn` and `config.colhidden` and the `zoomRatio` it was computed with. A mismatch on any of them is a miss.
- Store empty results too, so rows without overflow are not rescanned.
- Leave the full-row scan in place for misses. A cell far to the left can overflow into the visible columns, so clamping the scan would change what is drawn.
- Remove the `cellOverflowMapCache = {}` reset from the timer (G3).

### F1. Range writes recalculate once

**Root cause.**

- `setCellValuesByRange` (`core/api/range.ts:95-160`) calls `setCellValue` per cell.
- Any formula or `<span` value goes through a full `updateCell` per cell (`core/api/cell.ts:132`, `:174`), each with its own `execFunctionGroup`.
- Callers include data-block and formula UI writes (`editor/utils/formula-ui-sync.ts:53`, `:267`, `:375`; `editor/utils/after-update-cell.tsx:490`).
- Measured at 2.2 ms per formula for the first 100 and 3.9 ms per formula for the next 400: superlinear, because each pass sees a longer chain.

**Fix.**

- `setCellValuesByRange` writes all values first, with recalculation deferred: a flag on `updateCell` that skips its `execFunctionGroup`.
- Then it runs one `execFunctionGroupForRange` over the written rectangle (P2).
- One Yjs batch, as today.

### G3. Text-measure cache survives scrolling

**Root cause.**

- `drawMain` arms a 100 ms timer after every draw that calls `clearMeasureTextCache()` (`canvas.ts:1456-1459`).
- The cache is already bounded: `MEASURE_TEXT_CACHE_MAX = 5000` (`core/modules/text.ts:25`).
- So every pause of more than 100 ms in scrolling throws away all measurements, and the next frame re-measures every visible cell.
- P1 C1 fixes the cache's key mismatch. After C1 this timer is what limits the cache.

**Fix.**

- Remove the timer.
- Clear the cache only when what it depends on changes: webfont load (already cleared at `Workbook/index.tsx:947`), `zoomRatio`, and `devicePixelRatio`.
- Keep the 5,000-entry cap.

Depends on P1 C1 landing first, so the first cache that survives is also a correct one.

### F4. Every dynamic array is included in the function group (bug)

**Root cause.** `getAllFunctionGroup` loops `j` over `dynamicArray_compute` but reads `dynamicArray_compute[0]` every time (`formula.ts:1451-1457`). So only the first dynamic array of each sheet is included, repeated once per entry. The others are left out of recalculation.

**Fix.** Read `[j]`. Add a test with two dynamic arrays on one sheet.

## 5. Interfaces changed

| Package export | Change | Compatibility |
|---|---|---|
| `setCellValuesByRange` | one formula pass per call instead of one per formula cell (F1) | same results; fewer recalculation passes |
| `updateCell` | new option to defer recalculation (F1) | additive, internal |
| `execFunctionGroupForRange` | new, internal (P2, F1) | internal |

No Yjs data change. Mixed-version sessions behave as today.

## 6. Verification

**Benchmarks, before and after, reported in the PR** (demo app, same harness as PERFORMANCE_AUDIT.md section 7, plus a production build with 4× CPU throttling):

- HTML paste of 5.3 MB: parse time (P3); the 198k-cell HTML paste from the audit, re-measured (P2, P3 combined);
- text paste of 1k cells containing a URL with `=`, on a sheet with 500 formulas (P1, P2);
- commit-to-paint for one off-screen cell edit on 9,900×60 (G1);
- select-all and a 50-step drag selection: long tasks (G4);
- scroll p95 and frames over budget on a 9,900×200 sheet with overflow text in 5% of cells (G2, G3);
- 500 formula writes through `setCellValuesByRange` (F1).

**Unit tests (vitest), written before the fixes:**

- **P3:** pasted HTML containing `<img src=x onerror=...>` runs no handler and requests no image; parsed rows and cells are the same as today on Excel, Google Sheets and dsheet clipboard fixtures.
- **P1:** a paste whose text contains `=` only inside a URL evaluates nothing; formula cells outside the pasted range are not passed to `updateCellYdoc`.
- **G1:** an edit to a cell with no size change leaves `visibledatarow` and `visibledatacolumn` at the same identities; inserting a row, a resize, hide/unhide, zoom and a merge each produce new ones.
- **G4:** no `calcSelectionInfo` calls during a simulated drag; one after it ends; a stale pending run is cancelled.
- **P2:** with a complete graph, the grid after a paste equals the grid after a forced full pass, on fixtures with direct references, whole-column ranges, named ranges, very large ranges, and formulas inside the pasted block.
- **G2:** a repeat draw with unchanged rows is all cache hits; editing one row misses only that row; a column resize misses every row; rows with no overflow are cached.
- **F1:** writing N formulas gives the same grid as N single `setCellValue` calls, with one formula pass.
- **G3:** the cache survives a 200 ms pause in drawing; a zoom change, a pixel-ratio change and a font load each clear it.
- **F4:** two dynamic arrays on one sheet both recalculate.

**Manual QA:** paste from Excel, Google Sheets and a web page (including one with images); paste inside dsheet; drag-select large ranges and read the status bar; scroll a wide sheet with long text; edit cells off screen and check nothing moves.

## 7. Risks

- **P3:** `DOMParser` can parse some clipboard HTML differently from `innerHTML` on a `div` (for example fragments without `<table>`). Mitigation: the clipboard fixture tests compare parsed cells with today's.
- **P1:** a paste that relied on the whole-sheet pass to re-evaluate formulas outside the pasted range stops doing that. [Inference] Nothing should rely on it: those cells were not pasted, and their formulas already have values. The P1 test pins the new scope.
- **G1:** something that relied on the offsets being rebuilt after any edit would stop updating. Mitigation: the dependency list covers every input `calcRowColSize` and `normalizeSelection` read, and the G1 test pins each one.
- **G4:** the status-bar stats lag the selection by one idle callback. That's the intended trade.
- **P2:** a missing dependency leaves a stale formula value until the next full pass. Same risk as P1 C8: the index must hold every edge `execfunction` records. P1 C8 has its own tokenizer for INDEX/INDIRECT/OFFSET, references next to spaces and tab names containing `-`; the forced-full-pass equality test covers it.
- **G2:** the cache is keyed by row identity. A write that mutates a row array outside Immer would serve a stale overflow map. Mitigation: all engine writes go through Immer drafts; the test pins edit → miss.
- **F1:** deferring recalculation inside `setCellValuesByRange` changes when intermediate values exist. Only the final grid is observable; the F1 test pins it.
- **G3:** a font change not seen by the three triggers would keep stale widths until the cap evicts them. Mitigation: route every font-affecting change (theme, webfont, zoom, pixel ratio) through one invalidation function.
- **F4:** dynamic arrays after the first now recalculate, so values that were stale until now change on the next pass. That's the bug being fixed; release notes should mention it.
