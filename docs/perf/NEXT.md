# P1 Stabilise: where we are and what to do next

Written 2026-10-26, updated 2026-10-29 (after the C8 spec changes and PR 466 round 4). Branch `maitra/stabilize-package`. Plan: `docs/superpowers/plans/2026-10-26-p1-stabilise-remaining.md` (Status and Next sections at the top). Spec: `docs/perf/dsheet-stabilize-spec.md` (Implementation status table near the top). Numbers: `docs/perf/stabilize-bench-results.md`. Triage of open findings and what is left: `docs/perf/final-review.md`.

## State

Done and committed: A1–A5, B1–B6, C1–C8 (with the C8 warm-up). Done and committed: G4 = Task 17 (`782aacd`, B5 case-sensitive) and Task 16 (`627aeda`, narrow only when `depGraphComplete`). Last commits before G4: `1587101` B3, `8b18a94` B5, `f2f0972` results doc. At G3 the unit suite had 39 files and 318 tests passing and `tsc` showed no errors in touched files. [Not re-run after the docs edits; they touch only `.md` files.]

Done and committed: G5 = Task 6 (`4d181b5`, `rebuildLocalStore`, D3 package side) and Task 7 (`4603bd9`, `appendDsheetUpdate`, D5 package side, S12); docs `0c55ba4`. Unit suite 43 files, 334 tests; `tsc` clean.

Done and committed: G6 = Task 8 (`71d758d`, format gate F, S13); docs `4122b95`. Unit suite 44 files, 346 tests; `tsc` clean.

Audit fixes (2026-10-27, committed in `750bb33`): snapshot `fingerprint`, A4 undo/redo calcChain guard, C8 wide-range seed walk, C8 paste/cut flag clears, C2 date key, `onContentUpdate` flush. Details: `docs/perf/stabilize-spec-audit.md`, results doc "Audit fixes". Unit suite 49 files, 359 tests; `tsc` clean.

`fingerprintFromUpdate` fix (2026-10-27, committed in `d96a8bd`): builds a temporary document like the spec; test T9b; 360 tests, `tsc` clean. Remaining audit deviations are listed in `stabilize-spec-audit.md` section 2 (pre-warm commit path, B2 `cloneDeep`, extra `userEdited` origins). Since 2026-10-28 (committed in `f0c7334`) the C8 warm-up builds the index from formula text and B3 holds the guard while the remount is deferred, both as the ticket text says.

K1 and K2 fix (2026-10-27, committed in `037248b`): formula text and grid size now reach a second client after a row or column insert or delete; test `structural-edit-formula-sync.test.ts` (8, failed before). 368 tests, `tsc` clean. Browser check done 2026-10-27 with a BroadcastChannel relay (collaboration server unreachable): same-tab formulas and row count reach the peer; cross-tab formula on an inactive tab does not (K6).

PR 466 review fixes (2026-10-28, committed: must-fix #1–6 `a7abbed`, #7–14 `a5dcd88`, #15–18 `291c398`; version bump `1b838d6`): the six must-fix comments of nadeem-fileverse are fixed: debug logger removed (#1); K1 diff misses merged cells and repeated formulas (#6); legacy `onChange` no longer cancelled by a host re-render (#5); undo of a row insert re-registers in one pass, 6,321 ms to 24 ms on 1,000 formulas (#2); echo hooks held back while a structural remount is pending, and a formula committed then gets its calcChain entry (#3); `rebuildLocalStore` and the bootstrap no longer wait forever for y-indexeddb (#4). Unit suite 52 files, 397 tests; `tsc` clean. Not browser-checked; the hook wiring for #3, #4 and #5 has no test. Details: `docs/perf/pr-466-review.md` section 9, results doc "PR 466 review fixes". Second round, same day, committed in `a5dcd88`: review #7 (sheet-name regex), #8 (stale chain after undo), #9 (grid size on undo/redo), #10 (remote formula keeps `depGraphComplete`), #11 (cut-paste moves the chain entry), #12 (no double write on paste/fill), #13 (WeakMap caches, `definedNames` in the CF key) and #14 (grid read-only in the tick the format lock is seen) are fixed; unit suite 54 files, 429 tests, `tsc` clean (`pr-466-review.md` section 10). Third round, same day, committed in `291c398`: #15 (paste flag only in the object branch), #16 (one Yjs update per structural edit), #17 (copies of calcChain entries) and #18 (guard ended when `rehydrateWorkbookFromYdoc` throws) are fixed; unit suite 54 files, 439 tests, `tsc` clean (`pr-466-review.md` section 11). **All 18 review comments are fixed.**

G7 (E1–E6, Tasks 9–14) is done and committed: demo render counter, `e-items-prep.md` and the Before baseline `453c02c`; E1, E5, E6 `8b639d1`; E3 `756e442`; E2 `e081c39`; E4 `96d9ab0`. The demo-only counter is `demo/src/perf-render.ts` (imported first in `demo/src/main.tsx`), the sheet setup is `docs/perf/bench/e-baseline-setup.js`, the prep note is `docs/perf/e-items-prep.md`. Numbers are in `stabilize-bench-results.md` (sections "E1–E6 Before", E1, E5 and E6, E3, E2, E4). Targets not fully met: E2 (the Toolbar still renders on a commit; scroll renders per tick 798 to 54) and E5 (the second context update per commit comes from the `Sheet` offsets effect, G1 in the follow-ups spec, out of scope).

K6, K7, K9 fixes (2026-10-28, committed in `9f614a5`): formulas on tabs with no `calcChain` and on tabs not hydrated are now rewritten after a row or column insert or delete, in memory and in Yjs (K6); `#REF!` is flagged on other tabs for a partial formula (K7); compaction waits for a pending remount and stops a multi-chunk run when the document changed (K9). K11 is not a bug (tests added). K8 is accepted for P1 (the spec's part 2 case). Unit suite 63 files, 522 tests; `tsc` clean. Details: results doc section "K6, K7, K9, K11, K8". Not done: the whole-branch diff review, the browser targets of spec section 6, two-window QA (K39, K43), and the app side (dsheets.new).

C8 spec changes (2026-10-29, committed in `7847262`): a wide formula joins a commit's walk only when its range (kept in `formulaCache.wideRangesByFormula`, read from the text) holds the edited cell or a formula cell the walk reaches; one with no readable range joins every walk. A collaborator's formula keeps `depGraphComplete` (the cell's edges are replaced from its text, `formula-edge-update.ts`) and `setSheetCalcChain` diffs the chain, resetting the indexes only when the diff cannot be computed. K17 is closed. Numbers in the results doc section "C8 spec changes". Not run in a room with two clients (K61).

PR 466 round 4 (2026-10-29, ten new comments N1 to N10 on `f0c7334`, all fixed): `b046b97` N2 (warm-up reads unloaded tabs' formulas from celldata, so `depGraphComplete` turns on with formulas on two tabs), N4 (digit-only tab names), N5 (backslash in strings), N8 (accented tab names); `5f0cb23` N1 (an unloaded tab's `celldata` is replaced as a whole array, so undo and redo replay it, plus the Yjs write), N9 (a refused insert or delete keeps the graph), N6 (cut-paste runs its pass); `24fabfc` N3 (hover predicate covers the drag states), N7 (pinned comment key follows position, size and text), N10 (compaction retries). Unit suite 66 files, 618 tests; `tsc` clean. Not browser-checked. Details: `docs/perf/pr-466-review.md` sections 12 to 16; limits K56 to K61 in `KNOWN-ISSUES.md`.

PR 466 round 5 (2026-10-30, reviewer's re-check at `ed0adf4`, not committed): two blocking N1 comments and K60 fixed. Unloaded tabs that name the edited tab are loaded before a user-driven row/column edit (`structural-edit-prep.ts`, called in `setContextWithProduce`), so undo and redo replay the rewrite cell by cell and leave a collaborator's edits alone; K60: `recordLoadedSheetSize` in `initSheetData`. Unit suite 68 files, 638 tests; `tsc` clean. Browser-checked in one window with a simulated peer (see section 17); no two-window run. The warm-up reader and wide-walk comments are follow-up tickets, not in this PR. Details: `pr-466-review.md` section 17.

| Order | Group | Task | What | Reviewer |
|---|---|---|---|---|
| done | G4 | 17 | B5 compares tab prefixes exactly and case-sensitively (spec says so; the shipped code is case-insensitive) | opus |
| done | G4 | 16 | Commit-path narrowing only when `depGraphComplete` is true (July bug, commit 1611aee) | opus |
| done | G5 | 6 | `rebuildLocalStore` (D3, package side) | sonnet |
| done | G5 | 7 | `appendDsheetUpdate` (D5, package side), bench S12 | sonnet |
| done | G6 | 8 | Format gate on `meta.format` (F), bench S13 | sonnet |
| done | G7 | 9–14 | E1–E6 fewer whole-UI re-renders (demo render counters); `8b639d1`, `756e442`, `e081c39`, `96d9ab0` | sonnet |
| partly done | end | | Final review: triage written (`final-review.md`) and K6, K7, K9, K11 resolved, K8 accepted; the whole-branch diff review has not been done | |

Each task has a full brief in the plan. S9–S15 are all used.

## How to resume

Paste this into a new session:

```text
Resume P1 Stabilise. Branch maitra/stabilize-package. Read docs/perf/NEXT.md and docs/perf/final-review.md first. G1 to G7 are done. Next: review the whole branch diff (main...HEAD) on the most capable model, then work through final-review.md section 2 (K18, K12, K10, K29, K28), then the browser targets of spec section 6 and the two-window QA. Never commit, stage or stash; after each group give the commit message, description and numbered test cases.
```

The ledger `.superpowers/sdd/2026-10-26-p1-stabilise-remaining/progress.md` is git-ignored, so it exists only on this machine. If it is gone, rebuild state from the plan's Status table and `git log`.

## Working rules (from the user)

- Never commit, stage or stash. After each group, give the user the commit message and description, plus test cases per commit (numbered, "do X → expect Y").
- Review diffs through snapshot trees (`snap.sh`, `pkg.sh` in the ledger directory), run from the repo root.
- Every change needs before and after numbers measured the same way. Correctness items need the repro test's failing run and passing run. Performance items use `docs/perf/bench/stabilize-bench.ts`.
- No Yjs schema change, `SURGICAL_CELL_LIMIT` stays 50, no new dependencies, vitest runs in Node.

## Browser check recipe (demo dev build, built-in browser)

1. Add `.claude/launch.json` with a config named `demo`: `npm --prefix demo run dev`, port 5000. Delete it afterwards (it is untracked and not part of any commit).
2. The demo exposes `window.__dsheetRef.current` (`addSheet`, `setSheetName`, `activateSheet`, `setCellValue`, `insertRowOrColumn`, `getAllSheets`, `getWorkbookContext`).
3. `setCellValue(r, c, v, { id })` did not route reliably to non-active sheets in the checks. Call `activateSheet({ id })`, wait about 500 ms, then `setCellValue` without `id`.
4. The built-in browser has no `prompt()`. For two tabs in one room: on tab 1 override `window.prompt = () => 'tabA'` and click "Start collaboration"; open tab 2 at the same origin with `?sheet=<same>` (it restores the room from `localStorage['dsheet-collabConfig']`). Remove that key afterwards so no later run reconnects to the dev collaboration server.
5. Timing a function without a paste event: import the module through Vite (`import('/@fs/.../file.tsx')`); for a "before" figure, write the old version from `git show <hash>:<path>` to a temporary file next to it and delete it afterwards.

## Open findings (promote to tasks or triage at the final review)

The complete list with evidence labels, locations and next steps is `docs/perf/KNOWN-ISSUES.md`; the triage (what to do first) is `docs/perf/final-review.md`. K7 and K11 were removed from the list on 2026-10-28. The summary below is the short version.

1. **K1 and K2 fixed (committed `037248b`)**; the merged-cell and repeated-formula gaps in that fix were closed on 2026-10-28 (PR 466 #6, committed `a7abbed`); see the results doc. Browser-checked 2026-10-27 (relay rig): same-tab formulas and row count (86, 87) reach the peer. The cross-tab formula on an inactive tab did not reach the peer then: that tab has no `data` grid and the rewrite skipped it (K6); fixed 2026-10-28 (committed in `9f614a5`) and covered by unit tests, not re-run in the browser. Values of rewritten formulas on the peer were not checked.
3. Paste: `docs/paste-sizing-issues.md` and `docs/copy-mechanism-findings.md` (named in the user's notes) are not in this repository tree, so they were not updated. C5 changed paste auto-fit sizing (fonts via the grid's font builder, cached text measurement, batched layout for wrapped cells); the 10k-cell figure and its limits are in the results doc. Whether C5 closes sizing Issues 2 and 3 there has not been verified, and the row-height-from-`fs` minor below suggests part of Issue 3 remains. Not measured: a full paste event (clipboard parse, Yjs write, render).
4. Deferred minors (final review to triage):
   - Banner shows the previous sheet's cached result for up to about 1 s after a sheet switch, and a cache hit can be served while fonts are loading.
   - Single-line row height uses `fs` as pixels with `DEFAULT_FONT_SIZE` instead of points.
   - `getMeasureContext2d` makes a new canvas per call; no test for the `!measure2d` fallback.
   - A removed-cell stale key stays in `formulasWithWideRangeDeps` for the session.
   - No mounted-React test for the Workbook banner effect.
   - C8: worker path never removes a resolved formula from `formulasWithWideRangeDeps`; warm-up slice budget is checked only between formulas. (`isAsyncFormulaFunction` is gone: the warm-up no longer calls any function. The >10,000-cell range case is covered by `formula-dep-text.test.ts`.)
   - B3: a local commit made while the remount is deferred is written at pre-change coordinates (K8, accepted for P1: the spec's part 2 case); compaction in that window is guarded (K9, fixed 2026-10-28, committed in `9f614a5`); no test for a surgical event in the post-fire, pre-paint hold. The guard is now held while the remount is deferred (ticket text, 2026-10-28, committed in `f0c7334`); the old "commit not suppressed" test was replaced by one that checks the depth returns to 0 after the edit.
   - B5: tests lack an apostrophe-in-double-quoted-string case, an unbalanced-quote case and a call-site test; `rangetxt: any`. Fixed 2026-10-28 (committed in `9f614a5`): sheets with no calcChain or not hydrated are now rewritten (K6), and `#REF!` marking is the same in both branches (K7).

## App-side work (outside this repo)

D0–D2, D4 and D6 live in dsheets.new and are not part of this plan. Tasks 6 and 7 only add the package APIs (`rebuildLocalStore`, `appendDsheetUpdate`) that D3 and D5 call.

## Regression test list

End-to-end checklist for the changes on this branch (owner only, and owner and collaborator): `docs/perf/e2e-regression-checklist.md`.
