# Stabilize spec vs branch `maitra/stabilize-package`: audit

Written 2026-10-27. Compared the pasted spec (A1–F, sections 2, 5, 6) against the code diff `main...HEAD` (38 commits), `docs/perf/*`, the plan and NEXT/KNOWN-ISSUES.

How checked: read the diffs and code for each item; ran `npm run test:unit` (44 files, 346 tests pass) and `npx tsc --noEmit -p .` (clean). I did **not** run the benchmarks, the demo app or any browser check. Items I only skimmed are listed at the end.

## Status update (2026-10-27, same day)

Missing items 1, 3, 4, 5, 6 and 7 below are now fixed and committed (`750bb33`), with tests; see "Audit fixes" in `stabilize-bench-results.md`. Section 2 item 3 (`fingerprintFromUpdate`) is also fixed (temporary document, test T9b). Still open: item 2 (E1–E6), item 8 (browser measurements), item 9 (app side). Deviations in section 2 are unchanged. Unit suite 359 tests, `tsc` clean.

## 1. Missing (spec requires, branch does not have it)

| # | Item | Evidence | Why it matters |
|---|---|---|---|
| 1 (FIXED) | **`DSheetContentSnapshot.fingerprint`** (A1, D5 step 4, section 5 table) | `src/persistence-utils.ts:14-20` has no `fingerprint`; `snapshotDsheetDocument` / `readDsheetContent` / `mergeDsheetContent` never compute one. Only the `fingerprintFromUpdate` export exists. NEXT.md and the plan do not list it as pending. | dsheets.new's D5 step 1 (background sheets) and D6 (publish stores the body read's fingerprint) are built on `snap.fingerprint`. Without it the app must call `fingerprintFromUpdate` on the encoded body (D5 says ~380 ms at 100k cells) or cannot ship D5/D6 as written. Highest priority. |
| 2 | **E1–E6** (whole-UI re-renders) | No `hover-tracker`, no `workbook-store`/`useWorkbookSelector`, no `React.memo` wrappers, no stable handle. Documented as "not started" (Tasks 9–14). | Small-sheet lag target in section 2 is unmet. Known. |
| 3 (FIXED) | **A4 undo/redo rule** | `calc-chain-ydoc-update.ts` only changed to read one field. No change to undo/redo (`Workbook/index.tsx` ~700-790), no "never delete a chain key whose cell still holds a formula" guard, no test "commit formula, receive collaborator's formula, undo". | Spec says undo of a local formula commit after a remote chain replace can truncate the new array and delete a collaborator's formula from Yjs for everyone. Data-loss path left open. |
| 4 (FIXED) | **C8: very-large-range and named-range seeds walk** | `formula.ts:2584-2590`: transitive walk runs first, then `formulasWithWideRangeDeps` are added. Spec says one walk seeded with the edited cell *and* those formulas. No test. | `B1 = SUM(A1:Z1000)`, `C1 = B1*2`: edit A5 recalculates B1, leaves C1 stale. Spec says C8 must fix it; it is still there. |
| 5 (FIXED) | **C8: HTML-table paste and cut-paste turn the flag off** | No `markDepGraphIncomplete` anywhere under `core/paste/`. `moveCells.ts:411` covers drag-move only. `pasteHandlerOfCutPaste` moves formula cells without touching the chain. | With flag true, a cut-pasted formula is not on the run list when its precedent changes (stale value). Spec lists both cases explicitly. |
| 6 (FIXED) | **C2: date-rule key** | `ConditionFormat.ts` cache key has no "today". Spec: with a date rule the key includes today's date; test "a new day misses". | Sheet left open past midnight keeps yesterday's highlight. Small. |
| 7 (FIXED) | **Legacy `onContentUpdate` per-edit flush** (A1) | `editor-context.tsx` `flushPortalUpdate` now calls `handleContentUpdateNotification()` with no `.flush()`. Spec: "keeps its per-edit flush: it encodes nothing, and ddocs.new saves its draft row from it". Before: flushed each edit. | ddocs.new draft-row save is now delayed up to 1 s and coalesced. Regression against an explicit spec sentence. |
| 8 | **Section 6 browser/profiler verification** | Results doc has Node numbers plus B2/B3/B5/C5 browser checks. No 198k commit-to-paint, no scroll p95 with/without CF rule, no 100-row React Profiler pass, no 10k paste event. | Section 2's targets "commit to paint", "scroll p95 within 1 ms" are unverified. |
| 9 | **App side D0–D2, D4, D6, D5 steps 1,2,4** | dsheets.new, outside this repo. | Expected. Not auditable here. |

## 2. Implemented differently from the spec

| # | Item | Spec | Branch | Assessment |
|---|---|---|---|---|
| 1 (FIXED 2026-10-28) | **C8 index** | Built from formula text in idle time, "without evaluating anything", with its own tokenizer; tests for INDEX, spaces, `Q1-2026!A1`, edges equal to `execfunction`'s. | `formula-warmup.ts` runs each formula through `execfunction` and discards the result (side effects suppressed; network functions skipped via top-level `AsyncFunction` check). No own tokenizer. | Edges match by construction. But volatile and time-based formulas are still evaluated, spec's "rejected" argument applies in part; K16 (async detection incomplete), K11 (INDIRECT/OFFSET) are open; the spec test "index built without evaluating any formula" cannot pass. Documented as a ruling, but it contradicts the pasted spec. |
| 2 | **Pre-warm commit path** | "Until it finishes, commits take today's path" (narrow if graph has entries). | Task 16: narrow only when `depGraphComplete`; otherwise full list. | More correct (fixes July bug), but slower (S15: 0.21 → 3.9 ms at 500 formulas) and **permanent** for sheets where the flag never turns true (sparse tabs). Not in the spec. |
| 3 (FIXED 2026-10-27) | **`fingerprintFromUpdate`** | Temporary Y.Doc + `createDeleteSetFromStructStore` scan. Spec explicitly: "Not used: `encodeStateVectorFromUpdate` plus `decodeUpdate` delete ranges", wrong for merged raw rows (1 vs 22). | `content-fingerprint.ts` uses exactly `encodeStateVectorFromUpdate` + `decodeUpdate(update).ds`. | Fine for one full-state body; wrong for a merge of raw IndexedDB rows with a compacted body. Cheaper than spec's version, but it is the rejected approach. I did not check whether a test covers merged rows. |
| 4 (FIXED 2026-10-28) | **B3 guard depth** | "Re-arm the timer and keep the pending flag and guard depth." | Guard not held while deferred; begins once right before the remount. Repo spec was edited to match. | Reasoned (holding it would drop the commit). Side effects K8 (commit during deferral written at pre-change coordinates) and K9 (compaction may run in the window). Deviation from the pasted text. |
| 5 | **`userEdited` origins** | self, remote, IndexedDB provider, `init`. | Also `compaction` and `dsheet-package-ingress`. | Reasonable, documented. Needs a consumer check that no real user edit uses these origins. |
| 6 | **B2 value copy** | `current()` of the Immer draft. | `_.cloneDeep(...)`. | Equivalent result; slower on large cells. `handleFormulaStringPaste` passes `d[r][c]` straight to `updateCellYdoc` without a copy. [Unverified] whether that can hand a draft proxy to Yjs. |
| 7 | **C2 key** | `luckysheetfile` identity only when the sheet has a formula rule. | Always includes it. | Safe, slightly over-invalidates (edit on another tab). |

## 3. Matches the spec (by reading the diff; tests pass)

A1 hasContent / userEdited / fingerprint tracker (GC-struct counting, attached at Y.Doc creation, `null` until synced), throttle fix and `@deprecated`; A2 (`onRemoteApplied(update)`, no whole-doc encode); A3 (`readYdocSheetField`, per-field hooks); A4 apply-in-place and index reset; A5 (`applyRemoteCells`, one quiet update, `patchPlainCelldata` map); B1; B2 (engine commit-time write, `sheetId` fifth arg, write moved before the data-block gate, paste/autofill batch writes); B4; B5 (9 call sites pass tabs; exact, case-sensitive after Task 17); B6 (fill, shift insert/delete via `cell-shift.ts`, text-paste formula); C1 (one key incl. zoom and baseline); C6 (per-pane entries, merge row index); C7 (Set membership, memoized split); D3 package (`rebuildLocalStore`); D5 step 3 package (`appendDsheetUpdate`); F (`meta.format` read and observed, write helpers guarded, prompt text exact).

## 4. Open correctness issues the docs already record (not spec items, but they affect it)

- **K1/K2** (fixed 2026-10-27, committed `037248b`; browser-checked for the same tab; cross-tab on inactive tabs blocked by K6): after a row insert, rewritten formula text did not reach a second client; peer row count differed (84 vs 86). Reproduced at Yjs level on `main` too. See the results doc.
- A4 browser check found: after a reconnect the editing tab shows a stale grid and a calcChain entry was not written (not traced).
- K3 cross-tab stale value (not reproduced after Task 16), K10, K12 (see `KNOWN-ISSUES.md`). K6 and K7 were fixed and K11 closed on 2026-10-28 (results doc section "K6, K7, K9, K11, K8"); K9 is hardened and K8 accepted for P1.

## 5. Not verified by me

C3, C4, C5, C6 internals; `rebuildLocalStore` ordering; format-gate UI wiring (no React renderer in vitest, K42); whether every spec section-6 unit test exists (I checked A4-undo, C2-date, C8 flag-off tests: absent; A1 compacted-body reopen test: not checked); whole-text diff of the pasted spec against `docs/perf/dsheet-stabilize-spec.md` (only B3, C8 and status table compared).

## Status update (2026-10-28, PR 466 review)

The review of PR 466 (`docs/perf/pr-466-review.md`) found six must-fix problems in the branch; all six are fixed (committed `a7abbed`; the other 12 comments in `a5dcd88` and `291c398`). One touches this audit's items: section 2 item 4 (B3 guard depth). The review showed the stated reason for not holding the guard is only partly right: `afterUpdateCell` writes the cell before it checks `remoteUpdateRef`, so holding the guard would not drop a typed commit. What must not run while a remount is pending is the engine to Yjs echo hooks, which now check `shouldSkipEchoWrite`. The guard is still not held (the data-block work and `handleChange` do drop work under it), and K8 (position of a commit during the deferral) is still open.

## Status update (2026-10-28, after G7 and the K6 to K11 work)

Section 1 item 2 (E1–E6) is done and committed (`8b639d1`, `756e442`, `e081c39`, `96d9ab0`); E2 and E5 only partly meet their targets (results doc). Item 8 (browser measurements) is still open. Section 2 deviations are unchanged (superseded for C8 and B3 by the 2026-10-28 update at the end): C8 still evaluates formulas in its warm-up instead of building the index from text, which the updated TEC-3277 description now asks for; that is the largest open difference from the spec. Unit suite 63 files, 522 tests; `tsc` clean.



## Update 2026-10-28

C8 and B3 now follow the ticket text. C8: the warm-up builds the index from formula text (`formula-dep-text.ts`), with its own tokenizer, no `execfunction` call and no other tab loaded; tests pin edge parity with `execfunction` and the INDEX, space, `Q1-2026!A1` and named-range cases. B3: the remote-apply guard begins when a remount becomes pending, is held while it is deferred, and ends after paint. Section 2 items 1 and 4 are closed. Not yet browser-checked after this change. Unit suite 64 files, 554 tests; `tsc` clean.


## Update 2026-10-29

- **Spec text added the same day, now implemented** (committed in `7847262`): (1) a wide formula joins the walk only when its range, read from its text, holds the edited cell or any formula cell the walk reaches, a named-range formula when its name covers either, and one whose ranges cannot be read joins every walk; (2) a collaborator's formula keeps `depGraphComplete` (the cell's edges are replaced from its text, a value that is no longer a formula drops them) and `setSheetCalcChain` diffs the chain instead of resetting the indexes, resetting only when the diff cannot be computed. Deviation that remains: named-range formulas join through the edited cell by the existing text scan, not through a reached formula cell, unless the name's range is wide or has cell edges (`KNOWN-ISSUES.md` K59).
- **Section 2 now:** items 1 (C8 index) and 4 (B3 guard) are closed (2026-10-28, `f0c7334`). Items 2, 5, 6 and 7 are unchanged. Item 3 is closed since 2026-10-27.
- **Section 1** items 8 and 9 are unchanged: no 198k commit-to-paint, scroll p95, Profiler pass or real 10,000-cell paste event was measured; the app side is outside this repo.
- **PR 466 round 4** found gaps in the code that implements this spec's C8 and K6 rewrite: the warm-up aborted with a tab that has no grid (N2), the text reader differed from `execfunction` on digit-only tab names, backslashes and accented tab names (N4, N5, N8), and history could not replay the rewrite of an unloaded tab (N1). All fixed in `b046b97` and `5f0cb23`; see `pr-466-review.md` sections 12 to 16.
- Unit suite 66 files, 618 tests; `tsc` clean. Not browser-checked.

