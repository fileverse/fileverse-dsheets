# P1 Stabilise: where we are and what to do next

Written 2026-10-26. Branch `maitra/stabilize-package`. Plan: `docs/superpowers/plans/2026-10-26-p1-stabilise-remaining.md` (Status and Next sections at the top). Spec: `docs/perf/dsheet-stabilize-spec.md` (Implementation status table near the top). Numbers: `docs/perf/stabilize-bench-results.md`.

## State

Done and committed: A1–A5, B1–B6, C1–C8 (with the C8 warm-up). Done and committed: G4 = Task 17 (`782aacd`, B5 case-sensitive) and Task 16 (`627aeda`, narrow only when `depGraphComplete`). Last commits before G4: `1587101` B3, `8b18a94` B5, `f2f0972` results doc. At G3 the unit suite had 39 files and 318 tests passing and `tsc` showed no errors in touched files. [Not re-run after the docs edits; they touch only `.md` files.]

Done and committed: G5 = Task 6 (`4d181b5`, `rebuildLocalStore`, D3 package side) and Task 7 (`4603bd9`, `appendDsheetUpdate`, D5 package side, S12); docs `0c55ba4`. Unit suite 43 files, 334 tests; `tsc` clean.

Done and committed: G6 = Task 8 (`71d758d`, format gate F, S13); docs `4122b95`. Unit suite 44 files, 346 tests; `tsc` clean.

Audit fixes (2026-10-27, in the working tree, not committed): snapshot `fingerprint`, A4 undo/redo calcChain guard, C8 wide-range seed walk, C8 paste/cut flag clears, C2 date key, `onContentUpdate` flush. Details: `docs/perf/stabilize-spec-audit.md`, results doc "Audit fixes". Unit suite 49 files, 359 tests; `tsc` clean.

`fingerprintFromUpdate` fix (2026-10-27, uncommitted): builds a temporary document like the spec; test T9b; 360 tests, `tsc` clean. Remaining audit deviations are listed in `stabilize-spec-audit.md` section 2 (C8 warm-up evaluates formulas, pre-warm commit path, B3 guard, B2 `cloneDeep`).

K1 and K2 fix (2026-10-27, uncommitted): formula text and grid size now reach a second client after a row or column insert or delete; test `structural-edit-formula-sync.test.ts` (8, failed before). 368 tests, `tsc` clean. Browser check done 2026-10-27 with a BroadcastChannel relay (collaboration server unreachable): same-tab formulas and row count reach the peer; cross-tab formula on an inactive tab does not (K6).

Not done: 6 tasks (9–14), then a final review.

| Order | Group | Task | What | Reviewer |
|---|---|---|---|---|
| done | G4 | 17 | B5 compares tab prefixes exactly and case-sensitively (spec says so; the shipped code is case-insensitive) | opus |
| done | G4 | 16 | Commit-path narrowing only when `depGraphComplete` is true (July bug, commit 1611aee) | opus |
| done | G5 | 6 | `rebuildLocalStore` (D3, package side) | sonnet |
| done | G5 | 7 | `appendDsheetUpdate` (D5, package side), bench S12 | sonnet |
| done | G6 | 8 | Format gate on `meta.format` (F), bench S13 | sonnet |
| 5 | G7 | 9–14 | E1–E6 fewer whole-UI re-renders (demo render counters) | sonnet |
| 6 | end | | Final whole-branch review on the most capable model; triage the minors below | |

Each task has a full brief in the plan. S9–S15 are all used.

## How to resume

Paste this into a new session:

```text
Resume P1 Stabilise. Plan: docs/superpowers/plans/2026-10-26-p1-stabilise-remaining.md (Status and Next at the top), branch maitra/stabilize-package. Read docs/perf/NEXT.md first. Use superpowers:subagent-driven-development. Sonnet implementers; opus reviewer for formula work; batch small same-shape tasks. Do G7 now: Tasks 9–14. Never commit, stage or stash. Stop after G7 for my check with commit messages, descriptions and numbered test cases per commit.
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

The complete list, 39 items with evidence labels, locations and next steps, is `docs/perf/KNOWN-ISSUES.md`. The summary below is the short version.

1. **K1 and K2 fixed in the working tree (2026-10-27)**; see the results doc. Browser-checked 2026-10-27 (relay rig): same-tab formulas and row count (86, 87) reach the peer. The cross-tab formula on an inactive tab does not: that tab has no `data` grid and the rewrite skips it (K6). Values of rewritten formulas on the peer were not checked.
3. Paste: `docs/paste-sizing-issues.md` and `docs/copy-mechanism-findings.md` (named in the user's notes) are not in this repository tree, so they were not updated. C5 changed paste auto-fit sizing (fonts via the grid's font builder, cached text measurement, batched layout for wrapped cells); the 10k-cell figure and its limits are in the results doc. Whether C5 closes sizing Issues 2 and 3 there has not been verified, and the row-height-from-`fs` minor below suggests part of Issue 3 remains. Not measured: a full paste event (clipboard parse, Yjs write, render).
4. Deferred minors (final review to triage):
   - Banner shows the previous sheet's cached result for up to about 1 s after a sheet switch, and a cache hit can be served while fonts are loading.
   - Single-line row height uses `fs` as pixels with `DEFAULT_FONT_SIZE` instead of points.
   - `getMeasureContext2d` makes a new canvas per call; no test for the `!measure2d` fallback.
   - A removed-cell stale key stays in `formulasWithWideRangeDeps` for the session.
   - No mounted-React test for the Workbook banner effect.
   - C8: worker path never removes a resolved formula from `formulasWithWideRangeDeps`; warm-up slice budget is checked only between formulas, so one heavy formula can exceed 8 ms; `isAsyncFormulaFunction` checks only top-level AsyncFunction exports; no >10,000-cell range test.
   - B3: a local commit made while the remount is deferred is written at pre-change coordinates; `use-celldata-compaction.ts` may run in that window; no test for a surgical event in the post-fire, pre-paint hold; the "commit not suppressed" test is near-tautological.
   - B5: sheets with no calcChain or not yet hydrated are skipped when cross-tab formulas are rewritten (`rowcol.ts`); `#REF!` marking differs between the current-sheet and other-sheet branches; tests lack an apostrophe-in-double-quoted-string case, an unbalanced-quote case and a call-site test; `rangetxt: any`.

## App-side work (outside this repo)

D0–D2, D4 and D6 live in dsheets.new and are not part of this plan. Tasks 6 and 7 only add the package APIs (`rebuildLocalStore`, `appendDsheetUpdate`) that D3 and D5 call.

## Regression test list

End-to-end checklist for the changes on this branch (owner only, and owner and collaborator): `docs/perf/e2e-regression-checklist.md`.
