# P1 Stabilise: final review and triage

Written 2026-10-28 on `maitra/stabilize-package` (185 files, about 20,000 lines changed against `main`). All of G1 to G7 (E1 to E6) are implemented. Unit suite 63 files, 522 tests, `tsc` clean at the time of writing (the K6, K7, K9 changes in the working tree included).

**What this is, and is not.** A triage of the open findings in `KNOWN-ISSUES.md` and the deferred minors in `NEXT.md`, with a recommendation for each. The recommendations are my reading of those entries, not new verification: I did not re-run the repros and I did not read the whole branch diff. A whole-diff review (for example `/code-review` on the branch) has not been done and is still open.

## 1. Recommended before merge (status updated 2026-10-28, same day, after analysis)

**K6, K7, K9 are fixed or hardened with tests (committed in `9f614a5`), K11 is closed as not a bug, K8 is accepted for P1 as a documented limitation (owner's decision, 2026-10-28).** See the results doc section "K6, K7, K9, K11, K8". The table below is the original list.

Chosen for silent wrong values or lost edits, not for performance.

| ID | Why | Size | First step and outcome |
|---|---|---|---|
| K9 | A trace, no code: can compaction run inside the deferred-remount window on stale structure? If yes it can write wrong coordinates. | small | Read `use-celldata-compaction.ts` against `shouldSkipEchoWrite`; add a test if it can run. Outcome: traced; can run in the window, plan reads Yjs so coordinates are safe, one whole-value borderInfo write could overwrite a peer's newer value across chunks. Hardened: gate on the pending flag, stop on a changed document. 7 tests. |
| K8 | A local commit during a deferred remount is written at pre-change coordinates (two cells affected). Partly mitigated by `shouldSkipEchoWrite`; position problem remains. | medium | Remap the commit's coordinates through the pending structural change, or hold the commit's Yjs write until the remount. Outcome: accepted for P1 (owner's decision); the spec's part 2 case, options in the results doc. |
| K6 (remaining parts) | Formulas on sheets with no `calcChain` or not hydrated are not rewritten after a row or column insert or delete, so they point at the wrong cell. | medium | Rewrite from `celldata` when `data` is absent; test with a hydrated and an unhydrated tab. Outcome: fixed for tabs with no calcChain and unhydrated tabs, in memory and in Yjs. 12 tests (18 in the file with K7). |
| K11 | `INDIRECT` and `OFFSET` edges depend on values, so a narrowed commit can leave such a formula stale. | small | Treat them like wide-range formulas (always include) and test. Outcome: not a bug; both already on the run list, 2 tests pin it. |
| K7 | `#REF!` is flagged on the current sheet but not on other tabs. | small | Use one test in both branches. Outcome: fixed (includes check in both other-tab branches), 4 tests. |

## 2. Recommended soon, not blocking

| ID | Note |
|---|---|
| K17 | **Fixed 2026-10-29 in `7847262`.** A collaborator's formula keeps the graph complete (its cell's edges are replaced from its text) and a remote calcChain update is diffed instead of resetting the indexes. Not run in a room with two clients. |
| K18 | The completeness flag is cleared by format-only operations and undo. Narrow the conditions. |
| K12 | Warm-up orphan entry and a chain removal without an epoch bump: trace both. |
| K10 | `remoteUpdateRef.current = false` set directly in `editor-workbook.tsx`, overriding the depth-derived guard (pre-existing). Route through the guard helpers. |
| K29 | `setCellValue(..., { id })` did not reach the named sheet in the demo. Reproduce in a unit test of the api. |
| K28 | Uncaught `matching sheet not found` errors in `editor-workbook-sync.ts` when sheets are added and renamed. Check whether a colour or hide change is lost. |

## 3. Defer or accept

- Over-evaluation only, no wrong result: K13, K14, K19, K20, K21.
- Measure first: K15, K23, K24 (a real paste was never timed).
- Display, small: K22, K25, K26, K27.
- Parser edge cases on invalid or unusual formulas: K31, K32, K33; add the missing tests (K34, K35) when touching that code.
- Do not change: K30 (case-sensitive tab names are what the spec relies on). K3 did not reproduce after Task 16; leave open until it does or the test is written.
- Test gaps that need a React renderer or a browser (K36 to K38, K40, K42): record in the QA checklist, add a renderer test only if the repo gets one.
- Manual QA before release, not code: K39 and K43 (two-tab checks, different users, slow network, format gate across tabs).

## 4. From the E tasks, for the reviewer

| Item | Status |
|---|---|
| E1 predicate | `isHoverInteractionActive` lists the states `handleOverlayMouseMove` reads. Error popover, link card, comment and image drag, search dialog drag and cell drag-move were not browser-checked (checklist 1.22 cases 2 to 4). Frozen panes not checked (case 5). |
| E2 ignore list | `scrollLeft`, `scrollTop`, `visibledatarow`, `visibledatacolumn`. Chosen by diffing the context across interactions and grepping the converted components; not every function reachable from them was read. A stale control would show as a toolbar not following the selection (case 7). The Toolbar still renders on every commit (spec target "commit outside the selection" not met). |
| E3 handle | The package's editor takes no `hooks` prop, so no host can replace the `afterActivateSheet` hook this repo sets (checked in `src/editor/types.ts`; a host that renders `Workbook` directly, outside `DSheetEditor`, was not checked). The keeper is not re-triggered if a Workbook sets `currentSheetId` before its sheets exist. |
| E4 | `getToolbarItem` deps left as they were; the function picker is covered by a unit test only. |
| E5 | The "one context update per commit" target is blocked by the `Sheet` offsets effect (G1 in the follow-ups spec, out of scope). E5 still removes the `commentBoxes` churn. |
| E6 | `InputBox`, `CellDatePicker` and `FxEditor` still read `innerText` on every render (5 reads per scroll tick). |

## 5. Not measured anywhere (spec section 6, audit item 8)

Browser targets of spec section 2 that no run has produced: commit-to-paint on 198k cells, scroll p95 with and without a conditional-format rule, a React Profiler pass at 4x CPU throttle, a real 10k-cell paste event, handling time for a received remote update on a 100k sheet. The E work was measured with render counts and call timings only.

## 6. Housekeeping done with this review

- `e2e-regression-checklist.md` gets section 1.22 for E1 to E6.
- `KNOWN-ISSUES.md`: the K6 line said "not committed"; it is in `a5dcd88`.
- 2026-10-28, after the K6 to K11 work: statuses in section 1 updated; `NEXT.md`, the plan, the spec status table, the audit doc, `e-items-prep.md` and the results doc brought in line.


## Update 2026-10-28 (committed in `f0c7334`)

Two spec deviations from the audit are closed: C8 now builds its index from formula text (`formula-dep-text.ts`, no evaluation), and B3 holds the remote-apply guard while a remount is deferred. K16 is closed; K8 stays accepted. Unit suite 64 files, 554 tests; `tsc` clean. Not browser-checked after these two changes.

## Update 2026-10-29

- **C8 spec changes** (committed in `7847262`): a wide formula (range over 10,000 cells) joins a commit's walk only when its range holds the edited cell or a formula cell the walk reaches (it keeps its ranges in `wideRangesByFormula`; one whose ranges cannot be read from its text joins every walk). A collaborator's formula keeps `depGraphComplete`, and `setSheetCalcChain` diffs the chain. K17 is closed. Node figures: commit outside 5 wide ranges 21.8 ms to 0.13 ms; commit after a remote formula, 500 formulas 4.19 ms to 0.024 ms and 2,000 formulas 15.6 ms to 0.031 ms (the second "before" is an emulation).
- **PR 466 round 4** (ten new comments N1 to N10 on `f0c7334`): all fixed. `b046b97` (N2 warm-up reads unloaded tabs from celldata, N4 digit-only tab names, N5 backslash in strings, N8 accented tab names), `5f0cb23` (N1 unloaded-tab rewrite replayable by undo and redo, N9 refused edit keeps the graph, N6 cut-paste pass), `24fabfc` (N3 hover predicate for drag states, N7 comment key follows the box, N10 compaction retry). Details: `pr-466-review.md` sections 12 to 16.
- Unit suite 66 files, 618 tests; `tsc` clean.

## Update 2026-10-30

- **PR 466 round 5** (reviewer's re-check at `ed0adf4`, not committed): the two blocking N1 comments and K60 are fixed (`pr-466-review.md` section 17). Two non-blocking comments go to follow-up tickets, not this PR: the warm-up text reader re-indexes `celldata` per slice (`formula-warmup.ts`), and the wide-formula walk cost (`formula-transitive-deps.ts`). K56 narrowed to the host API path; K60 closed.
- Unit suite 68 files, 638 tests; `tsc` clean.
- **Section 2 now:** K18, K12, K10, K29, K28 (K17 done). New limits from this work are K56 to K61 in `KNOWN-ISSUES.md`.
- **Still not done:** the whole-branch diff review, the browser targets of spec section 6, two-window QA (K39, K43, K57, K60, K61), and the app side (dsheets.new).
