# P1 Stabilise: issues found and not worked on

Written 2026-10-26, updated after G6 (K42 to K44 added from Task 8) (K4 and K5 fixed by Tasks 17 and 16; K40 and K41 added from Tasks 6 and 7; see the results doc). Everything here was seen while doing the P1 Stabilise tasks (G1–G4) and is **not** fixed and **not** assigned to a task, unless the Task column says so. Plan: `docs/superpowers/plans/2026-10-26-p1-stabilise-remaining.md`. Handoff: `docs/perf/NEXT.md`.

Evidence labels: **Observed** = seen running (browser or test run). **Code-read** = read in code or reported by a reviewer, not run. **[Inference]** = reasoning, not confirmed. **[Unverified]** = no check done.

"Impact" is my reading, not measured, unless stated.

## 1. Possible correctness bugs (look at these first)

| ID | Issue | Evidence | Where | Impact | Next step |
|---|---|---|---|---|---|
| K1 | **Rewritten formula text does not reach a second client. Deferred by decision (2026-10-26): to be tackled after G5 or later, as its own task; needs a spec ruling on whether peers receive the rewritten text or recompute it.** After a row insert on tab A, the inserting tab had `=B7`, `=A!B7`; the peer tab in the same room kept `=B5`, `=A!B5`. Rows and values arrived. | Observed (two demo tabs, built-in browser) | Remote apply of a row/column insert; formula rewrite happens in `rowcol.ts` on the inserting client only [Inference] | Peer formulas point at the wrong cells until recalculated; likely data-correctness bug. Not checked on `main`. | Failing test: apply an insert through Yjs to a second doc, compare formula text. Candidate item F5 in `dsheet-stabilize-followups-spec.md`. **After G4: reproduced at the Yjs level on this branch and on `main`** (two Y.Docs, `updateYdocSheetData`; Observed; probe in `.superpowers/.../k3-k1-report.md`). Mechanism [Code-read]: `insertRowCol` rewrites every tab in memory but emits to Yjs only the edited tab's rows from the insert row down (`rowcol.ts` ~1646–1676), so formulas above the insert row and on other tabs stay stale for every peer. Rendering not checked. |
| K2 | **Peer row count differs after an insert.** Peer had 84 rows, inserting tab 86, after the same insert. | Observed | Same path as K1 | Unknown; may be lazy sizing, may be lost rows | Check after K1; compare Yjs row counts. |
| K3 | **Cross-tab formula kept a stale value.** Tab A `=C!B5` and tab B `=C!B5` showed `0` after `C!B5` was set to 9 later (set order A, B, then C). Values stayed 0 in the dump. | Observed (once, in the demo; setup used `setCellValue` after `activateSheet`) | Commit path, cross-tab dependency | A cross-tab formula not updating when its precedent on another tab is edited. [Inference] may be the July narrowing bug (Task 16) or a missing cross-tab edge. | Re-run after Task 16; if it persists, failing test with two tabs. **After Task 16: does not reproduce at engine level** (3-tab probe, 4 variants, Observed); not run against pre-Task-16 code, and the React Workbook path was not tried. [Inference] likely the old narrowing bug or demo state. |
| K6 | **Rows/columns insert and delete skip some sheets when rewriting cross-tab formulas**: sheets with no `calcChain` (`rowcol.ts` about 484, 1934) and sheets whose data is not hydrated (`rowcol.ts` about 229, `if (!sheetData) return`). | Code-read (opus reviewer), pre-existing | `rowcol.ts` | Formulas on those sheets that point into the edited tab stay stale | Test with a hydrated and an unhydrated tab; decide whether to rewrite from `celldata`. |
| K7 | **`#REF!` marking differs by branch.** Current-sheet branches mark an error with `includes('#REF!')`; other-sheet branches only when the whole formula is exactly `=#REF!`. After B5, `=SUM(A!B3,1)` on tab B becomes `SUM(#REF!,1)` after deleting row 3 on `A`, but the cell is not marked as an error. | Code-read | `rowcol.ts` about 1992 and 2038 | Error not flagged on other tabs | Make both branches use the same test. |
| K8 | **A local commit during a deferred remount writes at pre-change coordinates.** B3 no longer holds the guard during the deferral, so a commit made then is written using the tab's old row/column positions. In the browser check, `hello` typed at D10 stayed at D10 on both tabs although a row had been inserted above. | Observed (position), consequence [Inference] | `scheduleStructuralRemount`, `use-editor-data.tsx` | Edit lands on a different logical cell | Decide the intended behaviour (shift the edit with the insert, or accept); needs a design choice, not just a fix. |
| K9 | **`use-celldata-compaction.ts` (lines about 105, 114) skips while `remoteUpdateRef` is true.** B3 no longer holds that flag during the deferral, so compaction may now run inside the deferred window. | Code-read, untraced | `use-celldata-compaction.ts` | Reviewer judged low risk; not traced | Trace it; add a test if it can run on stale structure. |
| K10 | **`editor-workbook.tsx` (about 289–297) sets `remoteUpdateRef.current = false` directly**, overriding the depth-derived value. Pre-existing. | Code-read | `editor-workbook.tsx` | Makes the guard unreliable if it fires while a guard depth is held | Route it through the guard helpers. |
| K11 | **Warm-up stale check cannot see value-dependent edges.** `INDIRECT` and `OFFSET` edges depend on values, so the Task 15 stale check cannot know about them. | Code-read (Task 15 reviewer) | `formula-warmup.ts` | A formula using them can be left out of a narrowed commit | Treat such formulas like wide-range ones (always include); add a test. |
| K12 | **Warm-up: orphan entry for a removed cell on the per-key path; chain removal without an epoch bump.** | Code-read | `formula-warmup.ts` | Extra evaluation, or a missed invalidation; unclear which | Trace both; add tests. |

## 2. Performance and robustness items

| ID | Issue | Evidence | Where | Next step |
|---|---|---|---|---|
| K13 | **A removed cell's key stays in `formulasWithWideRangeDeps` for the whole session.** | Code-read | `formula.ts` | Skip the add when `getcellFormula` is null. Cost: extra evaluation only. |
| K14 | **Worker path never removes a resolved formula from `formulasWithWideRangeDeps`.** | Code-read | worker eval path | Extra evaluation only. |
| K15 | **Warm-up slice budget is checked only between formulas.** One heavy formula can exceed the 8 ms budget, and the 1000 ms idle timeout can force a slice onto a busy thread. Bench: longest slice 8.7–14.8 ms. | Observed (bench), Code-read | `formula-warmup.ts` | Measure with a heavy formula; consider a smaller time check inside a formula only if it matters. |
| K16 | **`isAsyncFormulaFunction` checks only top-level `AsyncFunction` exports.** An async function reached some other way would not be detected. | Code-read | `formula-warmup.ts` | Test with a wrapped async function. |
| K17 | **Collaboration re-warm churn.** In a room, each reset of the dependency graph restarts the warm-up (noted in the results doc). With about 10 editors the graph can reset close to continuously, so commits keep taking the full pass. | Code-read; spec already notes it | spec C8 follow-up | Update only changed edges, per the spec's follow-up paragraph. |
| K18 | **Flag cleared more than needed:** format-only `applyOp` or undo clears `depGraphComplete`; sparse tabs never record a size. | Code-read | C8 flag handling | Narrow the clearing conditions. |
| K19 | **`finishFullFormulaPass` is called twice for Workbook worker jobs.** | Code-read | Workbook worker path | Harmless today [Inference]; remove one call. |
| K20 | **`calculateFormula` API does not set the completeness flag.** | Code-read | public API | Decide whether API-driven full passes should count. |
| K21 | **`RUNTIME_REFERENCE_RE` matches inside string literals.** | Code-read | C8 | Harmless over-evaluation only. |
| K22 | **`getMeasureContext2d` makes a new canvas per call.** | Code-read | `calculate-range-cell-size.tsx` | Reuse one canvas. |
| K23 | **First two timing runs of the old paste-sizing path took about 11 s against about 1.8 s later.** Cause not found (cold layout or font loading is a guess). | Observed | browser timing | Re-run before quoting the 1,827 ms median in anything external. |
| K24 | **Paste: a full paste event was never timed** (clipboard parse, Yjs write, render), only the sizing function. | Not measured | | Time a real paste in the browser. |

## 3. UI / display issues

| ID | Issue | Evidence | Where | Next step |
|---|---|---|---|---|
| K25 | **Banner shows the previous sheet's cached result for up to about 1 s after a sheet switch.** | Code-read | `Workbook/index.tsx` banner effect | Key the cache by sheet or clear on switch. |
| K26 | **Width cache hit served while web fonts are loading.** | Code-read | `calculate-range-cell-size.tsx` | Skip the cache until `document.fonts.ready`, or key by loaded state. |
| K27 | **Single-line row height uses `fs` as pixels with `DEFAULT_FONT_SIZE`**, but font size is stored in points. Relates to paste sizing Issue 3 in the user's notes (that doc is not in this repo). | Code-read | `calculate-range-cell-size.tsx` | Convert points to pixels. |
| K28 | **Console errors on the demo during normal use** (built-in browser): `[WorkbookSync] afterColorChanges: matching sheet not found` and `afterHideChanges: matching sheet not found`, thrown as uncaught errors when sheets are added and renamed; React warnings (`fill-rule`/`clip-rule` DOM property, `<button>` nested in `<button>`, missing `key` in `Toolbar`). Not caused by P1 work as far as I know. | Observed | `editor-workbook-sync.ts`, `@fileverse/ui` toolbar | Check whether the sync errors lose a colour or hide change; the React warnings are cosmetic. |
| K29 | **`setCellValue(r, c, v, { id })` did not route to the named sheet** when that sheet was not active. In one run writes meant for other tabs landed on the active tab. `getCellValue` with a similar `{ id, type }` threw `sheet not found` once. Workaround in `NEXT.md`: activate the sheet first. | Observed (demo API) | `Workbook/api.ts` | Reproduce in a unit test of the api; may be lazily hydrated sheet data. [Unverified] |
| K30 | **The formula engine resolves tab names case-sensitively and `='a'!B5` gives `#ERROR`.** This is existing behaviour and what the spec relies on (see K4). Listed so nobody "fixes" the evaluator by accident. | Observed | evaluator | None unless the spec changes. |

## 4. Parser and edge cases (B5 and formulas)

| ID | Issue | Evidence | Next step |
|---|---|---|---|
| K31 | **An unbalanced `'` outside a string swallows the rest of the formula** into one token (`=SUM(B5,'oops)+B6` leaves `+B6` unshifted). Invalid formula anyway. | Code-read (reviewer ran it) | Optional guard. |
| K32 | **`='A'!B5:'A'!B9` (prefix on both ends) is never shifted**, before or after B5. | Code-read | Handle or leave. |
| K33 | **Duplicate or missing tab names are not handled.** If only the edited tab's name is missing, nothing shifts; if both are missing, unprefixed references shift. | Code-read | Names are effectively unique; add a guard if imports can produce blanks. |
| K34 | **B5 test gaps:** no apostrophe-inside-a-double-quoted-string case (`="it's"&B5`), no unbalanced-quote case, no test that each `rowcol.ts` call site passes the right tabs, `rewriteFormulasByScanningSheet` untested. `rangetxt: any` could be `string`. | Code-read | Add the cases (the reviewer checked the first by hand and found it correct). |
| K35 | **C8: no test with a range over 10,000 cells; test 12 does not assert `formulasWithWideRangeDeps` is cleared.** | Code-read | Add both. |

## 5. Test and evidence gaps

| ID | Gap | Next step |
|---|---|---|
| K36 | **B3 tests:** no test for a surgical event arriving in the post-fire, pre-paint hold; the "commit not suppressed" test only asserts a flag is false; the legacy "before" test is a copy of the old logic, not the old code. | Add a hold-window test; strengthen the commit test. |
| K37 | **Task 15 stale-formula assertions** have no failing-before-fix run; the reviewer reasoned about them. | Revert the guard temporarily in a scratch copy and record the failing run. |
| K38 | **No mounted-React test for the Workbook banner effect** (C4); vitest runs in Node. Also no test for the `!measure2d` fallback, and the S10 "scans per selection" row is a constant, not a measurement. | Needs a DOM test environment or a browser check. |
| K39 | **B3 two-tab check was run once, with the same user name in both tabs and the demo's dev collaboration server.** Not repeated with different users or with a slow network. | Repeat before release. |
| K40 | **`rebuildLocalStore` ordering logic has no automated test** (in-flight bootstrap, refresh during a rebuild, unmount during the wait): vitest has no React renderer. Also: a blocked delete (another tab holds the database) leaves the new `whenSynced` waiting with no timeout; a rebuild waiting on a bootstrap started by a changed `dsheetId`/`ydoc` uses the old closure values. Task 6. | Browser check with two tabs; renderer test if one is added; consider a timeout. |
| K41 | **`appendDsheetUpdate` cannot tell a wrong delta** (not diffed against the true local state vector; Yjs keeps it pending), grows the row count until the next compaction, and a timeout during an in-flight add can still commit the row. Task 7. | The app must diff against the real local vector (D5 step 3); retry is safe. |
| K42 | **Format gate (F): UI wiring has no automated test** (vitest has no React renderer). The permission chip still shows the prop's state while locked; the comment toolbar item still shows (its anchor write is guarded); a template apply that returns early leaves `selectedTemplate` set; `watchFormatGate` creates the empty `meta` root type. Task 8. | Browser check with two tabs; renderer test if one is added. |
| K43 | **Format gate (F): second-tab demo check not run.** Only a single-tab check (format set on the doc locally) was done. Also, in the demo, edits do not survive a reload even without the lock, so the rig cannot show persistence. Task 8. | Repeat with two tabs in one room, and on dsheets.new. |
| K44 | **Format gate (F): writes made before the watch starts** (bootstrap) are not blocked except merge and migrate, which have a read-only pre-check. Task 8. | Accept, or pre-check earlier. |

## How to use this list

- Items K4 and K5 are already tasks (17 and 16). Everything else waits for the final whole-branch review to triage, or for the user to promote it.
- Suggested promotion order: K1 and K2 (confirm on `main` first), K3 (after Task 16), K6, K8, K11, then the rest.
- When an item is fixed, move it to the results doc and delete its row here.
