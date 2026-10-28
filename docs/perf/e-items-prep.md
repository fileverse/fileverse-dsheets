# E1–E6 prep (Tasks 9–14): whole-UI re-renders

**Status (2026-10-28): all six are implemented and committed** (`8b639d1` E1, E5, E6; `756e442` E3; `e081c39` E2; `96d9ab0` E4). This note is the scouting done before the work; where it differs from what was built, the results doc is right: E2 used an ignore list instead of per-component selectors, E3 kept `generateAPIs` and uses a delegating handle with a host effect for the keeper, E4 left `getToolbarItem` unchanged.

Written 2026-10-28 on `maitra/stabilize-package` at `1b838d6` (tree clean, `npm run test:unit` 54 files / 439 tests, `tsc` clean). Spec: `dsheet-stabilize-spec.md` section 4 E. Plan rows: `docs/superpowers/plans/2026-10-26-p1-stabilise-remaining.md` Tasks 9–14. Nothing here is implemented yet. Line numbers are from this commit and drift; locate by name.

Paths below are under `src/sheet-engine/react/components/` unless stated.

## Where the code differs from the spec text

The spec's line numbers were taken from `origin/main` 9411d95 and several moved or changed.

| Spec says | Code now |
|---|---|
| `SVGDefines.tsx:19` takes a `currency` prop | `SVGDefines.tsx` (a file, not a folder), `React.FC<{ currency: string }>`, plain arrow component, default export at the end. Matches. |
| `FunctionList/FunctionListButton.tsx:260-298` | `Toolbar/FunctionList/FunctionListButton.tsx`. Memo deps are `[context]` (`groupedFunctions` `useMemo`) and `[context, refs.cellInput, refs.fxInput, refs.globalCache, setContext]` (a `useCallback`). |
| Hover state in context only | `SheetOverlay/index.tsx` already has `const [hoveredCell, setHoveredCell] = useState(...)` (about :124), set at about :451 inside the `setContext` recipe of `onMouseMove`. So the hovered cell is local state, but the `setContext` call still runs on every move, which is what E1 removes. |
| 51 components read the context | `grep -rl "useContext(WorkbookContext)"` finds 51 files. |
| Provider value changes on every update | `providerValue = useMemo(..., [context, handleRedo, handleUndo, mergedSettings, refs, setContextWithProduce])` in `Workbook/index.tsx` (about :915). Confirmed. |
| `useImperativeHandle` depends on `context` | Confirmed (about :2037). Deps: `context, setContextWithProduce, handleUndo, handleRedo, mergedSettings, globalCache`. |
| Paste listener re-bound on each context change | Confirmed: `onPaste` is a `useCallback` with deps `[context, setContextWithProduce]` (about :1657), bound in an effect on `[onPaste]` (about :1800). |
| NotationBoxes scans the grid and runs a second update | Confirmed: effect on `[flowdata, setContext]` scans every cell for `ps?.isShow` and always calls `setContext(showComments)`. `showComments` (`core/modules/comment.ts`) always assigns a new `ctx.commentBoxes` array. |
| SheetOverlay reads `innerText` on every render | Confirmed (about :253-254): `refs.cellInput.current?.innerText` and `refs.fxInput.current?.innerText`, read every render, before the `editingSheetCell` result is used. `editingSheetCell` is computed one line above, so the reads can be guarded by it. |

## Missing prerequisites

1. ~~Render counter does not exist.~~ Done, see above. (Original note:) The plan says to add a demo-only counter behind `?perfRender=1` (grep for `perfRender` in `src` and `demo/src` finds nothing). Nothing is measurable until it is added. It must be removed or stay gated, with no overhead when the flag is off.
2. **No React renderer in vitest** (Node, no jsdom; K42). Component wiring cannot be unit tested. Pure pieces (hover tracker, store, `shownCommentsKey`) can.
3. **Before numbers** for every interaction must be recorded before Task 9 changes anything (plan line "Record Before for all interactions before Task 9 starts").

## Baseline recorded (2026-10-28)

Counter and Before numbers are done: see `stabilize-bench-results.md` section "E1–E6 Before". Tools: `demo/src/perf-render.ts` (demo only, `?perfRender=1`, no package change) and `docs/perf/bench/e-baseline-setup.js`. Findings that change the plan: a same-cell mouse move already costs 0 renders (E1 must be judged by recipe time, not render count; not yet timed), a cell-editor keystroke costs 0 renders, and an Enter commit is 2 context updates (E5 target 1). Per scroll tick: 798 renders, 1 paste-listener rebind, 1 handle rebuild, 9 `innerText` reads.

## Measurement protocol (same method before and after)

Demo dev build (`npm --prefix demo run dev`, port 5000, recipe in `NEXT.md`), built-in browser. Reference sheet: 100 rows, dropdown columns, borders, fills, 2 conditional-format rules. Per interaction, record render count per component name and total commits:

- one scroll frame;
- mouse move inside one cell, then across a cell boundary;
- ArrowDown;
- one keystroke in the cell editor;
- Enter commit.

The spec also asks for React Profiler on 4x CPU throttling (render time, not only counts). Counts first; time if the Profiler is available in the built-in browser.

## Items

### Task 9: E1 hover (`SheetOverlay/index.tsx`, new `SheetOverlay/hover-tracker.ts`)

- **Before (measured 2026-10-28):** about 4.2 ms per same-cell mouse move (sync handler time), 0 renders; forced-layout reads are 0.005 ms of that. The cost is in `overShowLinkCard` and `handleOverlayMouseMove`, so the early-out (skip `setContext` entirely) is what saves time; moving the rect read alone does not. See the results doc, "E1 Before".

- Today every `mousemove` runs `setContext(...)` which calls `overShowLinkCard`, `handleOverlayMouseMove`, then `getElementsByClassName('fortune-cell-area')` and `getBoundingClientRect()` inside the recipe.
- Change: compute the hovered cell outside `setContext`, reading the cell-area rect once per animation frame. Call `setContext` only when a drag, resize or selection is in progress (`globalCache` flags that `handleOverlayMouseMove` reads) or when the hovered cell or link-card state changes.
- Test (`hover-tracker.test.ts`): 3 moves within a cell give 1 change; a cross-cell move gives another; every move gives one while interacting; `getRect` called once per frame.
- Risk: `handleOverlayMouseMove` does more than hover (cursor, resize handles, drag extension). Read it first and list every `globalCache` flag it branches on; the "interacting" predicate must cover all of them or cursor/resizing breaks silently.
- Risk: `overShowLinkCard` shows the link card on hover. It must still run when entering a linked cell.

### Task 10: E2 selector store (`react/context/workbook-store.ts`, new)

- `createWorkbookStore`, `useWorkbookSelector(selector, isEqual)` on `useSyncExternalStore`. Workbook updates the store after each context change.
- Convert and `React.memo`: Toolbar (`Toolbar/index.tsx`; two `useContext` sites, :173 and :484), SheetTab (`SheetTab/index.tsx` :45) and `SheetItem.tsx` (:34), ContextMenu (`ContextMenu/index.tsx` :62), FilterMenu (`ContextMenu/FilterMenu.tsx` :159), SheetTabContextMenu (`ContextMenu/SheetTab.tsx` :25), FunctionList (`Toolbar/FunctionList/FunctionListButton.tsx`). SVGDefines: `React.memo` only.
- Hardest part: each selector must list every `context.` field the component reads, including fields read inside callbacks and effects. A missed field means a stale toolbar state. Plan requires the grep of each component's `context.` reads pasted in the report.
- SheetTab calls `calcSelectionInfo` on `luckysheet_select_save` change. The selector must include `luckysheet_select_save` and the sheet's `data` identity (followups spec G4 note), so stats update after an edit inside the selection.
- Toolbar is 2,352 lines; expect the most reads there. Consider converting in two steps (store plus one small component first, then the rest) so a regression is bisectable.
- Setters (`setContext`, `refs`, `settings`, `handleUndo`) are stable and can stay on `useContext`, or move to a second stable context, so `React.memo` is not defeated by the changing provider value. A component that still calls `useContext(WorkbookContext)` re-renders on every context change regardless of memo.

### Task 11: E3 stable handle (`Workbook/api.ts`, `Workbook/index.tsx`)

- `generateAPIs(context, setContext, handleUndo, handleRedo, settings, cellInput, scrollbarX, scrollbarY, globalCache, refs)` takes the context snapshot as the first argument (23 reads of `context` in `api.ts`). Change to a `contextRef` (read `.current` at call time) and drop `context` from the `useImperativeHandle` deps.
- `handleUndo`, `handleRedo`, `mergedSettings`, `setContextWithProduce` are also deps. Check whether each is stable; if not, route them through refs as well, or the handle is still rebuilt.
- `generateAPIs` is only used in `Workbook/index.tsx`. No test calls it today (`grep -rln generateAPIs src` finds only `Workbook/api.ts` and `Workbook/index.tsx`), so the plan's "update existing tests that call `generateAPIs`" has nothing to update; add the new test instead (built once, reads latest context).
- Host side, the one coupling: `src/editor/contexts/editor-context.tsx` (about :448) calls `activeSheetKeeper.onAttach(workbook, \`${dsheetId}-${forceSheetRender}\`)` from the ref callback on every attach. `src/editor/utils/active-sheet-keeper.ts` records `ctx.currentSheetId` on each attach and restores it once per mount key when the new mount has sheets. With a stable handle the callback runs once per mount, often before sheets load (`onAttach` returns early when `luckysheetfile` is empty and does not mark the mount handled), so restore would never happen and the remembered sheet would never update. Needed: call `onAttach` (or a new `keeper.update`) when the active sheet changes and once the new mount has sheets. Decide the trigger before coding: a Workbook-side callback, or a host effect watching `getWorkbookContext().currentSheetId`.
- `active-sheet-keeper.ts` has no test file (only the source is in `src/editor/utils`). Add one before changing its contract.
- Package consumers outside this repo (dsheets.new, ddocs.new) may hold the handle across renders and call methods that used the captured `context`. With a ref these now see newer state, which is the intended change, but note it in the PR.

### Task 12: E4 paste listener and memos (`Workbook/index.tsx`, `Toolbar/index.tsx`, `Toolbar/FunctionList/FunctionListButton.tsx`)

- `onPaste`: read `context` and `setContextWithProduce` through refs, bind `document.addEventListener('paste', ...)` once.
- `getToolbarItem` (`Toolbar/index.tsx` about :782) has a long dependency list that includes `context`; narrow to the fields it uses. This overlaps E2 (Toolbar selector), so do E2's Toolbar conversion first or the dependency list will be redone.
- `FunctionListButton`: `groupedFunctions` depends on `[context]` but reads `locale(context).functionlist`; depend on the locale only. The insert callback depends on `[context, ...]`; narrow to the selection field it reads.
- Measure with temporary counters (rebinds and recomputes over 20 scroll frames), removed afterwards.
- Do E4 after E2 and E3.

### Task 13: E5 one context update per commit (`NotationBoxes/index.tsx`)

- Add `shownCommentsKey(data)` (pure, testable): the shown-comment cell list as a string key. Keep the last applied key in a ref; call `setContext(showComments)` only when it differs.
- The grid scan itself stays (it is O(cells) per data change). Spec only asks to drop the second update; a cheaper scan is out of scope (the `TODO use patch` comment in the file).
- Edge: first mount with no shown comments should still set `commentBoxes` once if it was non-empty, or clear stale boxes on a sheet switch. The key must include the sheet id or be reset on sheet change, or switching to a sheet with an equal (e.g. empty) set would keep the previous sheet's `commentBoxes`.

### Task 14: E6 no forced layout (`SheetOverlay/index.tsx`)

- Read `cellInput.innerText` and `fxInput.innerText` only when `editingSheetCell` is true. Today `editingAsFormula` uses both texts only behind `editingSheetCell &&`, but the reads are done unconditionally above it.
- Smallest task. Verification: forced layouts from `SheetOverlay` in a 90-frame scroll recording (expected 0).

## Order

Counter and Before numbers, then Task 14 and Task 13 (small, independent), Task 9, Task 11 (needs the keeper decision), Task 10 (largest, most risk), Task 12 last (depends on 10 and 11). The plan lists them 9 to 14; the order above is a suggestion, not a ruling. [Inference] Task 10 should go last of the big ones because every other task is easier to verify before the Toolbar/SheetTab conversion changes what renders.

## Open questions for the owner

1. E3 keeper trigger: Workbook-side callback or host effect on the active sheet id? The first changes the package API surface slightly; the second keeps the package unchanged but needs a host change in this repo's `editor-context.tsx`.
2. E2 scope: are components that stay on `useContext` (the other ~44) acceptable to still re-render on every update? The spec says yes ("for now").
3. Is a React Profiler run with 4x CPU throttling required for the PR, or are render counts enough? Spec section 6 asks for both.
4. Counter flag: OK to ship `?perfRender=1` in the demo only, or must it live outside the package source?

## Working rules (unchanged)

Never commit, stage or stash; give commit message, description and numbered test cases per commit after the group. Before and after numbers measured the same way. No Yjs schema change, `SURGICAL_CELL_LIMIT` stays 50, no new dependencies, vitest runs in Node.
