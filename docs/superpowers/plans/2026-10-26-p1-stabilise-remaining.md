# P1 Stabilise (TEC-3277): remaining package items

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish the package side of P1 Stabilize on `maitra/stabilize-package`. Already done on this branch: A1–A5, B1, B2, B4, B6, C1, C2, C3, C6, C7. Remaining: C8, C4, C5, B3, B5, D3 and D5 package APIs, F, E1–E6.

**Spec:** `docs/perf/dsheet-stabilize-spec.md` (section 4 has each item's root cause and fix). Fingerprint: `docs/perf/content-fingerprint-spec.md`.

## Global Constraints

- **Never commit, stage or stash.** Leave changes in the working tree. The user commits after each group.
- **Before and after numbers for every change**, measured the same way.
  - Performance items: add a scenario to the existing harness `docs/perf/bench/stabilize-bench.ts` (scenarios S1–S8 exist; new ones start at S9). Run `npx vite-node docs/perf/bench/stabilize-bench.ts -- before-<item>` **before** changing package code, then `-- after-<item>` after. Results land in `docs/perf/bench/results/<label>.json`.
  - Correctness items: the repro test's failing run (before) and passing run (after), with the output quoted.
  - Add a section per item to `docs/perf/stabilize-bench-results.md`, in the style of the existing sections (table of Before/After, "What changed", "Tests", "Not covered").
- Follow this branch's existing patterns: tests sit next to the code (e.g. `src/sheet-engine/core/modules/engine-hot-spots.test.ts` builds an engine context with `defaultContext(...)`); caches are bypassed inside Immer drafts, as C2/C6/C7 do.
- No Yjs schema change. `SURGICAL_CELL_LIMIT` stays `50`. No new dependencies. vitest runs in Node (no jsdom).
- Unit tests: `npm run test:unit`; one file with `npx vitest run <path>`. Type check: `npx tsc --noEmit -p .` (no new errors in touched files).
- Line numbers in the spec refer to 9411d95; locate code by function name.

## Groups (the controller stops after each group for the user to check and commit)

1. **G1:** Task 1 (C8)
2. **G2:** Task 2 (C4), Task 3 (C5)
3. **G3:** Task 4 (B3), Task 5 (B5)
4. **G4:** Task 6 (D3 `rebuildLocalStore`), Task 7 (D5 `appendDsheetUpdate`)
5. **G5:** Task 8 (F format gate)
6. **G6:** Tasks 9–14 (E1–E6)

---

### Task 1: No formula pass for a cell nothing depends on (C8)

**Files:** Modify `src/sheet-engine/core/modules/formula.ts` (`FormulaCache`; the narrowing block in `execFunctionGroup`; the end of a full pass; every place the dependency indexes are reset, including the A4 path in `src/sheet-engine/core/api/cell.ts` / `Workbook/api.ts` `setSheetCalcChain`). Test: `src/sheet-engine/core/modules/formula.dep-graph.test.ts`. Bench: S9 in `docs/perf/bench/stabilize-bench.ts`.

**Interfaces:** Produces `FormulaCache.depGraphComplete: boolean` (default `false`) and `resetFormulaDependencyIndexes(ctx: Context): void`. That function clears `depsByCell`, `revDepsByCell` and `formulasWithWideRangeDeps`, calls `invalidateSheetsRequiredDenseCache()` and sets the flag `false`. Reuse an existing reset helper if A4 already added one; don't duplicate it.

- [ ] **Precondition:** read how INDIRECT, OFFSET and INDEX resolve references at run time (special handling in `formula.ts`; the spec cites `:1046-1048` and `:2604-2607`). Record whether those references reach `depsByCell`. If not, add those formulas' keys to `formulasWithWideRangeDeps` when evaluated, so they always run.
- [ ] **Before:** add S9 to the harness (4000×25 values, 500 `=SUM(A{r}:T{r})` formulas, graph warm after one full pass; measure one commit to an unreferenced cell through the engine's real commit path, and record the number of formulas processed). Run `-- before-c8`.
- [ ] **Failing tests** (fixture: 20 rows of A–T values, 500 `SUM` row formulas plus one each of INDIRECT, OFFSET, INDEX, a named range and a whole-column range):
  - after one forced full pass the flag is `true`;
  - a commit to an unreferenced cell processes zero formulas;
  - a commit to a referenced cell gives a grid deep-equal to a forced full pass;
  - a commit to a cell read only through INDIRECT/OFFSET/INDEX, or a named range, still updates that formula;
  - `resetFormulaDependencyIndexes` (and `setSheetCalcChain`) set the flag `false`, and the next commit takes the full pass.
- [ ] **Implement:**
  - set the flag at the end of a full pass;
  - clear it on index reset, after structural changes, and when a formula enters the chain without being evaluated (paste, remote cell batch);
  - skip the pass when the flag is `true` and the dependents set, after the wide-range and named-range additions, is empty.
- [ ] Tests pass; `npm run test:unit`; type check.
- [ ] **After:** `-- after-c8`; write the C8 results section (formulas processed and time, before vs after).

### Task 15: C8 warm-up, a dependency-only pass after open (added 2026-10-26 at the user's request)

**Why:** C8 only skips when `depGraphComplete` is true, and today that flag is set only by forced full passes: `recalculateAllFormulas` after XLSX import, and row/column drag. Opening a sheet runs none, so in a normal session C8 rarely applies. The normal commit path can't fill the graph, because it evaluates only text-matched formulas.

**Files:** create `src/sheet-engine/core/modules/formula-warmup.ts`; wire it in `src/sheet-engine/react/components/Workbook/index.tsx`. Test: `formula-warmup.test.ts`. Bench: S14 in `docs/perf/bench/stabilize-bench.ts`.

**Interfaces:**
- `warmFormulaDependencyGraph(ctx: Context, opts: { budgetMs: number; schedule: (cb: () => void) => void; isCancelled?: () => boolean }): Promise<'complete' | 'aborted'>`
  - Walks the calc chain in chunks of at most `budgetMs` (default `8`) per scheduled slice.
  - Evaluates each formula only so that `execfunction` records its dependencies (`depsByCell`, `revDepsByCell`, `formulasWithWideRangeDeps`, the unresolved-sheet flag), and discards the result.
  - Captures `depGraphEpoch` at the start and calls the existing `finishFullFormulaPass(ctx, epoch)` at the end, so a graph cleared mid-warm-up never counts.
- `scheduleFormulaWarmup(getCtx: () => Context): { trigger(): void; dispose(): void }`
  - Runs after the workbook's data is ready on mount.
  - Runs again, debounced `2000` ms, after each `markDepGraphIncomplete()`.
  - Runs only while `document.visibilityState === 'visible'`.
  - Uses `requestIdleCallback` with a `setTimeout` fallback.

**Hard requirements (from the spec's non-goals):**
- No Yjs writes and no `updateCellYdoc` / `groupValuesRefresh` pushes: computed values in Yjs don't change.
- No `setContext` or Immer update, so no re-render per chunk and no undo entries.
- Grid cell values are unchanged, including volatile formulas (`NOW`, `RAND`).
- The A1 signal stays quiet: `userEdited` stays false and `onContentChange` doesn't fire because of the warm-up.
- The calc chain isn't changed (no `insertUpdateFunctionGroup` side effects).
- If `execfunction` writes scratch fields on the frozen context, run against a shallow mutable copy for those fields, as needed.
- How the graph is built is unchanged: reuse `execfunction`'s existing recording.
- The C8 guard that every tab holding formulas must be dense stays as it is. Sheets whose formulas sit on inactive (sparse) tabs keep the flag false, and this limitation is documented.

- [ ] **Audit first:** list every side effect of `execfunction` and its callees when called for a chain entry (state writes, chain edits, error markers, hooks), and say in the report how warm-up suppresses each one.
- [ ] **Before:** S14 on a 4000×25 sheet with 500 `SUM` row formulas:
  - open the engine context (as S9 does) without a forced pass, commit to an unreferenced cell, and record formulas read (expected 500 today);
  - repeat with 5,000 formulas;
  - run `-- before-c8-warmup`.
- [ ] **Failing tests:**
  - after `warmFormulaDependencyGraph` the flag is `true` and an unreferenced commit reads 0 formulas;
  - during warm-up: `updateCellYdoc` is never called, `luckysheetfile` keeps its identity, the undo list is unchanged, every cell `v`/`m` is unchanged (including a `NOW()` cell), and `calcChain` keeps its identity;
  - `markDepGraphIncomplete()` mid-warm-up gives `'aborted'` (or the flag stays false) and a re-warm is scheduled;
  - each slice respects `budgetMs` (stub clock);
  - after warm-up, a commit to a referenced cell gives a grid equal to a forced full pass.
- [ ] Implement and wire; `npm run test:unit`; type check.
- [ ] **After:** S14 again:
  - formulas read after warm-up (expected 0);
  - total warm-up time and longest slice for 500 and 5,000 formulas;
  - Yjs updates emitted during warm-up (expected 0).

  Run `-- after-c8-warmup`. Then a browser check in the demo (dev build): open a sheet with formulas, confirm no Yjs `update` event and no `onContentChange` during warm-up, then that a commit to an unreferenced cell skips the pass. Add the results to the C8 section.

### Task 2: Crypto-banner scan on data change, idle (C4)

**Files:**
- Create `src/sheet-engine/react/components/Workbook/denomination-scan.ts`.
- Modify `src/sheet-engine/react/components/Workbook/index.tsx`, the effect that scans for BTC/ETH/SOL on every `luckysheet_select_save` change. It becomes an effect on data identity that schedules the scan in `requestIdleCallback` with a `setTimeout` fallback. The selection hook call stays on selection changes. No DOM writes inside `setContext` updaters.

Test: `denomination-scan.test.ts`. Bench: S10.

**Interfaces:** `hasDenominatedCell(data: (Cell | null)[][]): boolean`, which stops at the first hit.

- [ ] **Before:** S10 = today's per-selection-change work on 9,900 × 60 (`dataToCelldata` + `some`), `-- before-c4`.
- [ ] **Failing test:** `true` when any `v.m` contains BTC, ETH or SOL; `false` otherwise; stops at the first hit (a grid whose later rows throw on access).
- [ ] Implement and wire; tests; type check.
- [ ] **After:** S10 measures the selection-change path, expected 0 scans, plus one idle scan per data change; `-- after-c4`; results section.

### Task 3: Paste auto-fit without per-cell layout (C5)

**Files:** Modify `src/sheet-engine/core/paste-helpers/calculate-range-cell-size.tsx`. Test: `calculate-range-cell-size.test.ts`. Bench: S11.

**Interfaces:**
- `measureSingleLine(font: string, text: string, ctx2d: { measureText(t: string): { width: number }; font: string }): number`, cached by `(font, text)`.
- The font string comes from the same builder the grid uses to draw cells. Find the function the canvas uses and reuse it; this fixes the wrong-font bug the spec notes (`ff` used as a family name, `fs` used as pixels).
- Wrapped cells keep DOM measurement, batched so that all writes happen before the first read.

- [ ] **Before:** S11 = 10,000 single-line cells through today's path with a stub element counting `scrollWidth`/`scrollHeight` reads (forced layouts), `-- before-c5`.
- [ ] **Failing tests:**
  - a repeat `measureSingleLine` doesn't call `measureText`;
  - for `ff: 1, fs: 12` the font equals the grid's draw font;
  - for wrapped cells, all `textContent` writes happen before the first `scrollHeight` read.
- [ ] Implement; tests; type check.
- [ ] **After:** S11, expected 0 layout reads for single-line cells; `-- after-c5`; results section. Also record a browser 10k-cell plain-text paste time before and after in the demo (dev build, built-in browser), as the existing B2/B6 browser checks did.

### Task 4: Structural remote change during a cell edit is deferred, not dropped (B3)

**Files:** Modify `src/editor/hooks/use-editor-data.tsx` (`scheduleStructuralRemount` timer path); extract a pure scheduler if needed (`src/editor/utils/structural-remount-scheduler.ts`) so it can be tested. Test next to it.

- [ ] **Before:** a test against today's logic (copied into the test as `legacyScheduler` if extraction is needed). With editing active when the timer fires, the remount is skipped and the pending flag cleared. That is the failure: record the failing run.
- [ ] **Behaviour:** while editing, re-arm the timer (`250` ms) and keep the pending flag and guard depth. Remount once the edit ends; depth returns to 0. Keep B1's single begin per pending remount.
- [ ] Tests pass (fake timers); `npm run test:unit`; type check.
- [ ] **After:** passing run quoted. Browser check in the demo with two tabs in one room (as the A4/B2 checks did): start editing a cell on tab B, insert a row on tab A, finish the edit on tab B, and confirm tab B shows the inserted row and the edit is saved. Results section.

### Task 5: Row insert/delete shifts only references to that tab (B5)

**Files:** Modify `src/sheet-engine/core/modules/formula.ts` (`functionStrChange`, `functionStrChange_range`) and every `functionStrChange(` call site in `src/sheet-engine/core/modules/rowcol.ts`. Test: `formula.str-change.test.ts`.

**Interfaces:** `functionStrChange(txt, type, rc, orient, stindex, step, tabs: { editedTab: string; formulaTab: string })`, with the new argument last.

- [ ] **Failing tests:** insert one row at index 2 on tab `A`:
  - on tab A, `=B5` → `=B6`;
  - on tab A, `=C!B5` unchanged;
  - on tab B, `=B5` unchanged and `=A!B5` → `=A!B6`;
  - on tab B, `='a'!B5` → `='a'!B6` (case-insensitive);
  - for tab `Bob's Sheet`, `='Bob''s Sheet'!B5` → `='Bob''s Sheet'!B6`;
  - `='Q1 2026'!B2:B9` shifts both ends.

  Save the failing run.
- [ ] **Implement:**
  - unquote the prefix (strip outer `'`, collapse `''` to `'`);
  - compare case-insensitively;
  - a reference with no prefix belongs to `formulaTab`.
- [ ] Tests; type check. **After:** passing run, plus a demo check (three tabs with cross-tab formulas, insert a row on one tab, confirm the other tabs' formulas are unchanged). Results section.

### Task 6: `rebuildLocalStore` (D3, package side)

**Files:** Create `src/editor/utils/rebuild-indexeddb-store.ts`. Modify `src/editor/hooks/use-editor-sync.tsx`, `src/editor/types.ts` and `src/editor/utils/editor-handle.ts`. Test: `rebuild-indexeddb-store.test.ts` (`fake-indexeddb/auto`).

**Interfaces:**
- `rebuildIndexedDbStore(dsheetId: string, doc: Y.Doc, current: IndexeddbPersistence | null): Promise<IndexeddbPersistence>`
- `DSheetEditorHandle.rebuildLocalStore(): Promise<void>`. It destroys the provider, deletes the database, attaches a new provider to the same live `Y.Doc` and awaits `whenSynced`.

- [ ] **Before:** a test of today's heal behaviour (delete the database, reopen a fresh doc). Edits not yet in another store are gone: record it.
- [ ] **Failing test:** after 50 edits and `rebuildIndexedDbStore`, a fresh doc opened on the same name has the live doc's fingerprint, and the live doc object is unchanged.
- [ ] Implement and expose on the handle; tests; type check.
- [ ] **After:** passing run; record the rebuild time on the S4 old sheet. Results section.

### Task 7: `appendDsheetUpdate` (D5, package side)

**Files:** Modify `src/persistence.ts`; export from `src/index.ts`. Test: `src/persistence.append.test.ts`. Bench: S12.

**Interfaces:** `appendDsheetUpdate(dsheetId: string, update: Uint8Array): Promise<void>`. It adds exactly one row to the y-indexeddb `updates` store and never writes a full copy.

- [ ] **Before:** S12 = today's `mergeDsheetContent` on the S4 old sheet with a small remote change (time and bytes written), `-- before-d5`.
- [ ] **Failing test:** with `delta = Y.diffUpdate(remote, localSV)`, `appendDsheetUpdate` adds one row, and replaying all rows gives the same content as `mergeDsheetContent`.
- [ ] Implement with the same database and store names `persistence.ts` uses; tests; type check.
- [ ] **After:** S12 with `appendDsheetUpdate`, `-- after-d5`; expected bytes written equal to the delta size. Results section.

### Task 8: Format gate on `meta.format` (F)

**Files:** Create `src/editor/utils/format-gate.ts`. Modify `src/editor/contexts/editor-context.tsx` (start after bootstrap; on lock, set read-only and show the prompt with the existing toast or banner) and `src/editor/utils/update-ydoc.ts` (write helpers return early while locked). Test: `format-gate.test.ts`. Bench: S13.

**Interfaces:**
- `SUPPORTED_FORMAT = 1`
- `readFormatVersion(doc, dsheetId): number` (missing map or key means 1)
- `watchFormatGate(doc, dsheetId, onLocked: (format: number) => void): () => void`
- `isFormatLocked(doc): boolean`
- Map name `` `${dsheetId}/meta` ``, key `format`. Prompt copy exactly `This sheet was updated. Reload to continue.`

- [ ] **Before:** S13 = open cost (apply the 4000×25 body into a fresh doc with today's listeners), `-- before-f`.
- [ ] **Failing tests:**
  - no meta map reads 1 and is not locked;
  - setting `format: 2` while watched calls `onLocked(2)` once, after which `updateYdocSheetData` writes nothing (state vector unchanged);
  - a doc that receives `meta.format = 2` through `Y.applyUpdate` from another doc also locks.
- [ ] Implement; tests; type check.
- [ ] **After:** S13 with the gate, `-- after-f`, within noise of Before; a demo check that setting `format` to 2 from a second tab locks the first tab. Results section.

### Tasks 9–14: Fewer whole-UI re-renders (E1–E6)

Measured with render counts in the demo (dev build, built-in browser) for one scroll frame, a mouse move within a cell and across a cell boundary, an ArrowDown, a keystroke in the cell editor, and an Enter commit, on a 100-row sheet with dropdowns, borders, fills and 2 CF rules.

- Use a demo-only render counter gated behind a URL flag (`?perfRender=1`) so normal demo use has no overhead.
- Record Before for all interactions before Task 9 starts.

| Task | Item | Files | Test | Before / After |
|---|---|---|---|---|
| 9 | **E1** hover only on change | new `SheetOverlay/hover-tracker.ts`; `SheetOverlay/index.tsx` | `hover-tracker.test.ts`: 3 moves within a cell trigger 1 change; a cross-cell move triggers another; every move triggers one while interacting; `getRect` is called once per frame | renders per within-cell move (expected 0 after) |
| 10 | **E2** selector store + `React.memo` for Toolbar, SheetTab (+ items), ContextMenu, FilterMenu, SheetTabContextMenu, FunctionList; `React.memo` only for SVGDefines | new `react/context/workbook-store.ts` (`createWorkbookStore`, `useWorkbookSelector` on `useSyncExternalStore`) | store notify / unsubscribe / `selectChanged` tests; each component's selector lists every `context.` field it reads (grep, pasted in the report) | which components render per interaction (expected: none of these on scroll, hover, or a commit outside the selection) |
| 11 | **E3** stable handle | `Workbook/api.ts` `generateAPIs(contextRef, …)`; `Workbook/index.tsx` `useImperativeHandle` without `context`; update existing tests that call `generateAPIs` | built once, it reads the latest context | host ref-callback calls over 20 scroll frames (expected 0) |
| 12 | **E4** paste listener bound once; narrow memos | `Workbook/index.tsx` `onPaste` via ref; `Toolbar` `getToolbarItem` deps; `FunctionListButton` memo deps | glue (no unit test) | paste listener re-binds and memo recomputes over 20 scroll frames (temporary counters, removed after) |
| 13 | **E5** one context update per commit | `NotationBoxes/index.tsx`; `shownCommentsKey(data)` | same key for an unchanged shown set | context updates per commit (expected 1) |
| 14 | **E6** no forced layout on render | `SheetOverlay/index.tsx`: the two `innerText` reads only while editing | glue | forced layouts from `SheetOverlay` in a 90-frame scroll recording (expected 0) |
