# PR #466 review: comments, validation and fix plan

PR: https://github.com/fileverse/fileverse-dsheets/pull/466 ("Stabilize Package", `maitra/stabilize-package` into `main`, 38 commits).
Reviewer: nadeem-fileverse. Review state: "Requested changes".
Reviewed commit: `037248b` (the current HEAD of the branch).
Written 2026-10-28.

## 1. How this was checked

- The 18 inline comments were read through the GitHub REST API from the built-in browser (`/pulls/466/comments`). The summary comment was pasted by the user.
- Each comment was checked against the code at HEAD by reading it.
- Four claims were also run in a temporary Vitest file, which was deleted afterwards. The working tree now differs from `main`-based HEAD only by the earlier `package.json` and `package-lock.json` edits.

Evidence labels used below:

- **Run**: reproduced by a test run in this session.
- **Read**: confirmed by reading the code only; not executed.
- **Not checked**: not verified in this session.
- **Reviewer figure**: a number taken from the review comment, not re-measured here.

Sections 1 to 8 describe the review as validated on 2026-10-28 before any fix. All 18 comments were fixed afterwards in three rounds (must-fix #1 to #6, should-fix #7 to #14, low #15 to #18); see sections 9 to 11. A fourth round of ten comments (N1 to N10, on `f0c7334`, 2026-10-29) was validated in section 12 and fixed in sections 13 to 15; the commits are listed at the end of this file. Fix designs in the sections above are the proposals that were made; they are labeled [Inference] where they rest on reasoning rather than a run.

## 2. Verdict summary

| #   | Severity       | File:line                                                | Topic                                                              | Verdict                                        | Evidence                        |
| --- | -------------- | -------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------- |
| 1   | Must fix       | `editor/components/editor-workbook.tsx:377`              | Debug `afterTransaction` logger                                    | Valid                                          | Read                            |
| 2   | Must fix       | `sheet-engine/core/modules/history-calc-chain.ts:68`     | Undo of a row insert is slow                                       | Valid                                          | Run (6.3 s)                     |
| 3   | Must fix       | `editor/utils/remote-apply-guard.ts:103`                 | B3: formula committed during a deferred remount corrupts the chain | Valid (mechanism read, end-to-end not run)     | Read                            |
| 4   | Must fix       | `editor/hooks/use-editor-sync.tsx:245`                   | `rebuildLocalStore` can hang                                       | Valid                                          | Read + library source           |
| 5   | Must fix       | `editor/contexts/editor-context.tsx:452`                 | Host re-render cancels pending `onChange`                          | Valid                                          | Read                            |
| 6   | Must fix       | `sheet-engine/core/utils/ydoc-celldata-changes.ts:253`   | K1 fix misses merged cells and repeated formulas                   | Valid                                          | Run (both cases)                |
| 7   | Should fix     | `docs/perf/KNOWN-ISSUES.md:14`                           | Cause of K6 is the sheet-name regex                                | Valid                                          | Run (regex)                     |
| 8   | Should fix     | `history-calc-chain.ts:44`                               | Stale chain entry after undoing an insert                          | Valid                                          | Run                             |
| 9   | Should fix     | `sheet-engine/react/components/Workbook/index.tsx:735`   | Undo/redo does not write grid size                                 | Valid                                          | Read                            |
| 10  | Should fix     | `sheet-engine/core/api/cell.ts:261`                      | Every remote formula clears `depGraphComplete`                     | Valid                                          | Read (timings: reviewer figure) |
| 11  | Should fix     | `sheet-engine/core/paste/paste-internals.ts:991`         | Cut-paste never moves the chain entry                              | Valid                                          | Read                            |
| 12  | Should fix     | `sheet-engine/core/modules/dropCell.ts:2383`             | Paste and fill write each formula twice                            | Valid                                          | Read                            |
| 13  | Should fix     | `sheet-engine/core/modules/ConditionFormat.ts:1946`      | Module caches leak and ignore `definedNames`                       | Leak valid; `definedNames` staleness plausible | Read                            |
| 14  | Should fix     | `editor/contexts/editor-context.tsx:370`                 | Gap between format lock and read-only grid                         | Valid                                          | Read                            |
| 15  | Low            | `paste-internals.ts:380`                                 | Plain-text paste clears `depGraphComplete`                         | Valid                                          | Read                            |
| 16  | Low            | `sheet-engine/core/modules/rowcol.ts:1701` (and `:2799`) | 4 or 5 separate Yjs transactions per structural edit               | Valid                                          | Read                            |
| 17  | Low            | `sheet-engine/core/api/cell.ts:359`                      | Immer freezes objects Yjs holds                                    | Plausible                                      | Not traced                      |
| 18  | Low (existing) | `editor/hooks/use-editor-data.tsx:1253`                  | Guard not ended in the `catch`                                     | Valid; worse than "Low"                        | Read                            |

Summary-comment notes:

| Note                                                                                                                                                      | Verdict                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `KNOWN-ISSUES.md` K8 understates the bug (a third cell is lost)                                                                                           | Consistent with the code. The overwrite was not reproduced here.                  |
| The B3 code comment's reason for not holding the guard needs updating                                                                                     | Valid. See #3.                                                                    |
| y-indexeddb 9.0.12 never emits `'error'`; listeners at `use-editor-sync.tsx:150`/`:268` never run; the rebuild failure test mocks an impossible rejection | Valid for the library (no `'error'` emit in its source). The test was not opened. |
| `rebuildLocalStore` drops rows the live doc never loaded                                                                                                  | Not checked. The reviewer says today's heal does the same.                        |

## 3. Must-fix items in detail

### #1 Debug logger

Comment: a `DEBUG (remove)` `afterTransaction` logger is still in `editor-workbook.tsx`. It encodes the state vector and logs on every Yjs transaction, in production builds too.

Code (`editor-workbook.tsx:377-400`): a `useEffect` registers `ydoc.on('afterTransaction', onTx)`. `onTx` calls `Y.encodeStateVector(tr.doc)`, `fromUint8Array`, and `console.log('[sv]', {...})`. The comment above it says it exists "to check if delete-only edits leave the fingerprint unchanged".

Verdict: valid. `grep "DEBUG (remove)"` finds only this one place.

Fix: delete the effect. Check whether `fromUint8Array` (and `Y`) are still used elsewhere in the file before removing imports.

### #2 Undo of a row insert re-registers every cell below the edit point

Comment: undoing a row insert or delete restores every row below the edit point as a row-level patch. The loop calls `insertUpdateFunctionGroup` or `delFunctionGroup` for every column of every such row, and each call scans the chain. Reviewer figures (Node, one run each, undo on main vs this PR):

| Sheet                      | main  | this PR (undo) | this PR (redo) |
| -------------------------- | ----- | -------------- | -------------- |
| 9,000 x 26, no formulas    | 66 ms | 0.85 s         | 0.97 s         |
| 1,000 x 26, 100 formulas   | 7 ms  | 0.43 s         | 0.38 s         |
| 1,000 x 26, 1,000 formulas | 10 ms | 6.8 s          | 3.0 s          |

Code:

- `planHistoryPatches` returns every cell touched by a `data` patch. A row-level patch (`path = [luckysheetfile, i, 'data', r]`) gives `c: null`.
- `reregisterRestoredFormulas` expands `c == null` to every column of the row: `row.map((_cell, i) => i)`. For each column it calls `insertUpdateFunctionGroup` (if `f` exists) or `delFunctionGroup`.
- `delFunctionGroup` (`formula.ts:1530`) runs `calcChain.findIndex(...)` and, on a hit, copies the whole array. `insertUpdateFunctionGroup` (`formula.ts:1631`) loops over the chain unless it is given a `calcChainSet`.
- Cost is therefore (restored cells) x (chain length), through Immer drafts.

Run: a temporary test inserted a row at the top of a 1,000 x 26 sheet with 1,000 formulas, then planned and applied the inverse patches and re-registered. Result: 6,321 ms, 1,000 restored cells listed. This matches the reviewer's 6.8 s. The row-level patch also explains why the sheet with no formulas pays: the insert writes an empty `calcChain` and the rows are still walked.

Fix design [Inference]:

- Only touch cells whose `f` appeared or disappeared (compare the cell before and after the patches).
- Build a `Set` of chain keys once (`insertUpdateFunctionGroup` already takes a `calcChainSet` argument) and apply removals and additions in one pass, or rebuild the chain in one pass from the restored cells.
- Add a timing guard test on a 1,000 x 26 sheet.

### #3 B3: a formula committed while a remount is deferred rewrites the chain in Yjs from the old engine

Comment: the guard is now taken only when the remount runs, not while it is deferred. The reviewer says holding it would not drop the commit, because since B2 the typed cell reaches Yjs through `emitCommittedCell` and `afterUpdateCell`, and neither checks the guard. What the guard blocks is the `guardRemoteEcho` hooks (`editor-workbook.tsx:273`), which is the problem here.

Repro given:

1. A peer inserts a row above formulas at B4 and B6, so Yjs has them at B5 and B7.
2. The local user, mid-edit when that arrives, commits a formula. The remount is still deferred.
3. `calcChainChange` (`editor-workbook.tsx:616`) diffs the old engine chain against Yjs. It deletes `4_1` and `6_1` from Yjs and adds `3_1` and `5_1`, for every client.
4. The delete guard in `calc-chain-ydoc-update.ts` reads the old engine's cells, so it does not catch this.
5. After the remount those two formulas are missing from the chain and stop recalculating.

Code checked:

- `afterUpdateCell` (`editor/utils/after-update-cell.tsx:516`) calls `updateYdocSheetData` first. Its `remoteUpdateRef` check sits inside `shouldExecuteDataBlocks`, which runs after the write. So the reviewer is right that `afterUpdateCell` does not drop the commit under the guard.
- `calcChainChange` is `guardRemoteEcho(() => calcChainYdocUpdate(...))`. `guardRemoteEcho` returns early only when `remoteUpdateRef.current` is true.
- `calcChainYdocUpdate` diffs `syncContext.oldSheet.calcChain` (Yjs) against the engine value and writes both `added` and `removed`. Its delete guard is `syncContext.engineSheet?.data?.[item.r]?.[item.c]?.f != null`, which reads the engine grid. During the deferral the engine grid is at pre-peer-insert coordinates, so the Yjs-only keys `4_1`/`6_1` have no formula there and are not protected.
- `scheduleStructuralRemount` begins the guard only right before `run` (`beginRemoteApply` inside `armStructuralRemount`). Its doc comment says holding the guard "would drop the user's commit" because `afterUpdateCell` and others drop local writes. That reason is inaccurate for `afterUpdateCell` (above) and should be reworded.

Not run: the full sequence. The mechanism is traced; the end-to-end repro (a deferred remount plus a local formula commit) was not executed. Note the effect also depends on `emitCommittedCell` not checking the guard; that was not opened.

Fix design [Inference] (matches the reviewer's two points):

1. While a structural remount is pending, make the echo hooks (at least `calcChainChange`) not write from the engine.
2. After the remount, re-register the formula committed in that window from its `f`, the way undo does now (`reregisterRestoredFormulas`).
3. Update the `remote-apply-guard.ts` comment and `KNOWN-ISSUES.md` K8 (below).

### #4 `rebuildLocalStore` can hang

Comment: `rebuildLocalStore` waits for the current bootstrap first. The host calls it to heal unreadable rows, which y-indexeddb hits during its first read. In y-indexeddb 9.0.12 `whenSynced` only resolves on `'synced'` and has no reject path, so the bootstrap waits at `:159` forever and the rebuild waits for the bootstrap. A second, narrower hang: the bootstrap effect re-runs (its deps include `portalContent` and `isReadOnly`) between the new provider's construction and its first read; the cleanup destroys the unsynced provider; the rebuild checks the generation only after `whenSynced`, and the new bootstrap waits for the rebuild.

Checked:

- `node_modules/y-indexeddb` is 9.0.12. Its source has `this.whenSynced = promise.create(resolve => this.on('synced', () => resolve(this)))` and a single `this.emit('synced', ...)`. There is no `'error'` emit and no reject path. So the `persistence.on('error', ...)` listeners (bootstrap and `rebuildLocalStore`) can never fire, and the bootstrap's `await persistence.whenSynced` can wait forever.
- `rebuildLocalStore`'s `run()` loops `await bootstrapPromiseRef.current` with no timeout. `rebuildIndexedDbStore` awaits `next.whenSynced` with no timeout and no generation check while waiting (the generation is compared only after it returns).
- `bootstrapEditorIndexedDB` is a `useCallback` with deps `[dsheetId, enableIndexeddbSync, isReadOnly, portalContent, ydoc]`, so the bootstrap effect re-runs when `portalContent` or `isReadOnly` changes.
- The doc comment on `rebuildLocalStore` says it "never bumps the bootstrap generation", which is why it cannot abandon a stuck bootstrap.

Not run: no hang was reproduced; both hang paths are from reading. Impact today: the reviewer notes dsheets.new does not call `rebuildLocalStore` yet, so nothing regresses today. This has to be fixed before the host switches its heal to it.

Fix design [Inference]:

- Add a timeout to `whenSynced` (bootstrap and rebuild), or race it against a generation check.
- Let the rebuild abandon a stuck bootstrap by starting a new generation (the delete-and-remount heal does this today, which is why that path recovers).
- Remove or replace the dead `'error'` listeners, and rewrite the rebuild failure test so it fails by timeout, not by a rejection the library cannot produce.

### #5 A host re-render cancels the pending legacy `onChange`

Comment: with `onChange` trailing-only, the pending call is cancelled whenever the host passes a new `onChange`. `useMemo([onChange, dsheetId])` rebuilds the throttle and the cleanup (`:497`) cancels the old one. dsheets.new passes an inline `onChange` from a `useMemo` with about 20 deps, so an edit followed within 1 s by a panel open or a new comment never reaches the host's save: no `lastUpdated` bump and no local record for a new sheet.

Code (`editor-context.tsx`):

- `handleOnChange = useMemo(() => throttle(..., 1000, { leading: false, trailing: true }), [onChange, dsheetId])`.
- `useEffect(() => () => { handleContentUpdateNotification.cancel(); handleOnChange.cancel(); contentChangeNotifier.cancel(); }, [handleOnChange, handleContentUpdateNotification, contentChangeNotifier])` cancels the previous throttle whenever `handleOnChange` changes identity.
- `onContentChange` is already held in `onContentChangeRef` and its notifier is created once.

Verdict: valid. A new `onChange` identity creates a new throttle and cancels the pending trailing call of the old one, and nothing re-fires it.

Fix: keep `onChange` in a ref (as `onContentChangeRef` does) and create the throttle once per `dsheetId`. The reviewer's host-side repro was not run.

### #6 K1 fix misses sheets with a merged cell above the edit point, and repeated formulas

Comment: `emitRewrittenFormulasToYdoc` skips the range the range diff covers, assuming the diff writes it. But `snapshotPersistedCelldataInRange` keeps the live cell objects, and the rewrite then changes them in place (`rowcol.ts:270`, `:535`). The diff compares rewritten cells with objects the rewrite already changed, so it writes nothing for them. Two cases reach the peer with the old text: a merged cell above the edit point (`startR` drops to the merge's row, so the skip covers the whole tab), and neighbouring cells with the same text in the shifted range (the second case also exists on `main`).

Code:

- `snapshotPersistedCelldataInRange` (`ydoc-celldata-changes.ts`) stores `cell` itself in the map (`map.set(key, cell as Cell | ...)`), not a copy.
- `appendCelldataDiffChange` returns without a write when `cellsEqualForYdocPersist(beforeCell, cell)`. When both are the same mutated object, they are equal.
- `rowcol.ts` (insert): `startR = Math.min(baseStart, mergeBounds.minR)` when a merge exists. `emitRewrittenFormulasToYdoc` is then called with the same minimum as `editedFromR`, and skips every cell with `r >= editedFromR`. A merge at row 0 therefore skips the whole tab.

Run (temporary test, then deleted), using the same Yjs two-doc harness as `structural-edit-formula-sync.test.ts`:

- Merged cell: merge A1:D1, `A2 =B5`, `C2 =SUM(B1:B10)`, insert one row at index 2. Engine: `=B6`, `=SUM(B1:B11)`. Peer: `=B5`, `=SUM(B1:B10)`. Fails as reported.
- Repeated formula: A11:A16 all `=$B$5`, insert a row at index 3. Engine: `=$B$6` in all six. Peer: `=$B$5` in the first five, `=$B$6` only in the last. Fails as reported.

Fix design [Inference]: copy `f` (or the cell) into the snapshot, so the diff compares the pre-edit text against the rewritten text. Add one test per case to `structural-edit-formula-sync.test.ts`; its `mkSheet` has no merges and no repeated formulas, which is why it passed.

## 4. Should-fix and low items in detail

### #7 K6: the cause is the sheet-name regex

`FORMULA_SHEET_REF_RE` in `sheet-engine/core/api/sheet-flowdata-lifecycle.ts:9` is `/(?:'((?:[^']|'')*)'|([^'!\s()&+,{}]+))!/g`. The unquoted branch excludes `& + , ( ) { }` and whitespace, but allows `=`, `*`, `-`, `/`, `<`, `>`, `^`.

Run (Node, same regex):

| Formula      | Captured name |
| ------------ | ------------- |
| `=A!B5`      | `=A`          |
| `=2*A!B5`    | `=2*A`        |
| `=SUM(A!B5)` | `A`           |
| `='A'!B5`    | `A`           |

`getSheetIdByName` finds no sheet called `=A`, so `scanSheetsReferencingActive` misses the reference. The current K6 row in `KNOWN-ISSUES.md` attributes the miss to "no data grid" on inactive tabs. Note: the reviewer's end-to-end claim (tab B demoted, an insert on A rewriting nothing on B, in memory or Yjs, and wrong after reload) follows from this but was not run. The same regex is on `main`.

Fix: restrict the unquoted branch to sheet-name characters; update K6 text; add test cases for `=A!B5` and `=2*A!B5`.

### #8 Stale chain entry after undoing a row insert

`planHistoryPatches` only collects `data` patches whose row index is a number. The `data.length` patch (its `r` is the string `'length'`) is skipped, so a formula that shifted into the removed last row keeps its chain entry. Column insert likely has the same gap (reviewer's inference; re-registration visits only the columns still in the row; not run).

Run: 4 x 4 grid, formulas at (1,0) and (3,3), insert a row at 0, undo.

- Chain after the insert: `2_0, 4_3`; 5 rows.
- Chain after undo: `4_3, 1_0, 3_3`; 4 rows.
- Expected: `1_0, 3_3`. The stale `4_3` points outside the grid, and it reaches Yjs for every peer.

Fix: after re-registering, drop chain entries that are outside the grid or whose cell has no `f`. Add this as a test in `history-calc-chain.test.ts`, with a column-insert variant.

### #9 Undo/redo does not write `row`/`column`

`emitYjsFromPatches` (`Workbook/index.tsx:392`) writes restored formula text and cells but not `row` or `column`. After undoing a 2-row insert, the peer keeps 14 rows while the engine has 12; the `afterColRowChanges` effect fixes it later, and only for the current sheet (reviewer). Code check: `emitYjsFromPatches` only upserts cell and map-field changes; `emitGridSizeToYdoc` exists only on the forward path in `rowcol.ts`. Not run. Fix: write the size here as the forward path does.

### #10 Every remote formula cell clears `depGraphComplete`

`registerUnevaluatedFormula` (`api/cell.ts:253-261`) calls `insertUpdateFunctionGroup` and then `markDepGraphIncomplete()` for every remote formula cell, including a peer's recomputed value with the same `f`. Task 16 makes the commit path take the full formula list whenever the flag is off, and the warm-up restarts `FORMULA_WARMUP_DEBOUNCE_MS = 2000` ms after each clear.

Reviewer figures (median ms per commit to a referenced cell, 4000 x 25 sheet), not re-measured here:

| Formulas | main | PR, flag off | PR, flag on |
| -------- | ---- | ------------ | ----------- |
| 500      | 0.58 | 4.7          | 0.20        |
| 2,000    | 1.22 | 18.3         | 0.43        |
| 5,000    | 2.91 | 39.8         | 1.17        |

Consequence [Inference]: with an active collaborator the flag may never turn on. Fix options from the review: clear the flag only when `f` differs from the local cell's `f`, or register just that formula's edges.

### #11 Cut-paste never moves the chain entry

`pasteHandlerOfCutPaste` (`paste-internals.ts:~975`) marks the graph incomplete but has no calcChain handling (no match for `calcChain`/`FunctionGroup` in the function body). `moveCells.ts:395-409` does move chain entries (`movedCalc.r = calcR + rowOffset`). The reviewer's repro (A1=5, B1 `=A1*2`, cut B1, paste at D4, set A1=7, D4 stays 10, chain still holds `0_1`) was not run. Clearing the flag does not help because the entry never moves. Pre-existing bug. Fix: move the entries as `moveCells.ts` does.

### #12 Paste and fill write each formula twice

`dropCell.ts` calls `afterUpdateCell(j, i, null, {...cell, v, m: v[1]})` at `:2379`, `:2504`, `:2625`, `:2736` (and `paste-internals.ts:~1910`) before the cell is reformatted (`cell.m = ...genarate...`). Since B2 `afterUpdateCell` writes to Yjs first. The same fill also pushes the final `d[j][i]` into the batch `cellChanges`. The first value (pre-format `m`) and the final value differ, so `skipIfEqual` (in `update-ydoc.ts:158`) never matches. Result: two transactions per formula cell, with extra ops kept in history. Not run. Fix options from the review: skip the write in `afterUpdateCell` for these callers, or call it after `d[j][i] = cell`.

### #13 Module caches (CF and border)

- `ConditionFormat.ts`: `computeMapCache = new Map<string, ComputeMapCacheEntry>()` keyed by sheet id, never cleared. Each entry holds `luckysheetfile` (the whole file) and the result, so every sheet opened in a session stays in memory after its editor unmounts.
- `border.ts`: `borderComputeCache = new Map<string, BorderComputeCacheEntry[]>()`, same keying and no clearing. Entries hold identities of `borderInfo`, `merge`, `rowhidden`, `colhidden` plus the result.
- The CF key has `luckysheetfile`, `rules`, `conditionRules`, draft state, selection and `today`. It has no `ctx.definedNames` (grep for `definedNames` in `ConditionFormat.ts` finds nothing). A formula rule such as `=lim>7` that depends on a defined name could stay stale when only the name moves. This is a reading of the code; not run. `definedNames` lives on `ctx`, not on `luckysheetfile`.
- Optional (reviewer): key on `sheet.data` and add `luckysheetfile` only when the sheet has a formula rule, so commits on other tabs do not recompute this tab's map. Note the code comment says `luckysheetfile` is used because formula rules can read other sheets.

Fix: a `WeakMap` keyed on the sheet object, or a clear on unmount; add `definedNames` identity to the CF key.

### #14 Format lock: gap before the grid becomes read-only

In `editor-context.tsx` `watchFormatGate(...)` calls `setFormatLocked(true)`. The Yjs writers stop at once (`isFormatLocked` in `update-ydoc.ts:194`, `format-gate`, `defined-names-ydoc`, `comment-anchors-ydoc` and others). The grid goes read-only only when `workbookData` (`editor-workbook.tsx:~463`, a `useMemo` on `[dsheetId, forceSheetRender, isReadOnly]`) changes and the Workbook init effect re-runs. A commit in between shows in the grid, never reaches Yjs, and is lost on reload. Not run. Fix: make the editor read-only in the same tick the lock is seen (for example read-only via a ref/handle, not a re-created workbook).

### #15 Plain-text paste clears `depGraphComplete`

`pasteHandler` calls `ctx.formulaCache.markDepGraphIncomplete()` at `paste-internals.ts:380`, before the read-only/allow-edit checks and before the `typeof data === 'object'` branch (`:408`). So a blocked paste or a plain-text paste also clears the flag and restarts the warm-up. Fix: move the call into the object branch (after the checks).

### #16 4 or 5 Yjs transactions per structural edit

`insertRowCol` ends with `emitCellFormatRangesToYdoc` (when present), `emitCellRangeToYdoc`, `emitRewrittenFormulasToYdoc`, `emitGridSizeToYdoc`; `deleteRowCol` adds `emitCelldataDeletesBeyondGrid`. Each ends in `ctx.hooks.updateCellYdoc`, and `updateYdocSheetData` wraps each call in its own `ydoc.transact` (`update-ydoc.ts:199`). The PR added the rewritten-formula and grid-size calls. Peers can see intermediate states. Fix: one `updateCellYdoc` call or one transaction.

### #17 Immer freezes objects Yjs holds

`setSheetCalcChain` (`api/cell.ts:353-358`) assigns `sheet.calcChain = calcChain ?? []`. The caller (`use-editor-data.tsx:~1034`) passes the array from `readYdocSheetField` and also stores it in `currentDataRef`. The reviewer says Immer deep-freezes it including objects Yjs holds. Not traced: whether `readSheetKey`/`finishPlainSheet` returns live Yjs-held objects or fresh copies. Until that is checked this is plausible, not confirmed. Fix: shallow-clone each entry.

### #18 `rehydrateWorkbookFromYdoc` never ends the guard on error

`beginRemoteApply(remoteApplyGuardRefs)` is called (`use-editor-data.tsx:~1255`), then `applyCommentMarkers`, `syncDataBlockCalcFromPlain`, `initialiseLiveQueryData` run. The `catch` logs and returns `false` without calling `endRemoteApply`. If one of them throws, the depth stays above zero and `handleChange` (which returns early while `remoteUpdateRef.current` is true) drops local writes until reload. The reviewer rates this Low (existing); the consequence is worse than the label. Fix: `try/finally`.

## 5. Documentation and test follow-ups from the review

- `KNOWN-ISSUES.md` K8: the reviewer says a commit at the old coordinates overwrites the cell that moved there, so a third cell is lost, not only the edit landing in the wrong row. Update the row and its "Next step".
- `KNOWN-ISSUES.md` K6: change the cause to the regex (#7).
- `remote-apply-guard.ts` doc comment on `scheduleStructuralRemount`: replace the "would drop the user's commit" reason with the real one (#3).
- `docs/perf/NEXT.md`: listed the audit fixes, `fingerprintFromUpdate` and K1/K2 as uncommitted; they are in `d96a8bd`, `750bb33` and `037248b`. Corrected 2026-10-28.
- Test for `rebuildLocalStore` failure: it mocks a `whenSynced` rejection that y-indexeddb 9.0.12 cannot produce (#4).
- `rebuildLocalStore` drops rows the live doc never loaded (another tab's, or an appended row). The reviewer notes today's heal does the same, so this is a note. Not checked here.

## 6. Suggested order

1. #6 and #3: both can leave peers with wrong formula text or a missing chain entry for everyone. #6 has failing repros ready to turn into tests.
2. #8, #2 and #9: all in the undo/redo path; fix them together and keep `history-calc-chain.test.ts` as the home for tests.
3. #5: small, high impact for the host's saves.
4. #1: delete the logger (trivial).
5. #4: before the host adopts `rebuildLocalStore`.
6. #10, #11, #12, #7, #14, #13, then the Low items (#15 to #18).

## 7. Proposed test cases (do X, expect Y)

These were proposals when section 12 was written; the tests that came from them are listed per fix in sections 13 to 15.

1. Merge A1:D1, `A2 =B5`, `C2 =SUM(B1:B10)`, insert a row at index 2. Peer Yjs doc formulas equal the engine's (`=B6`, `=SUM(B1:B11)`). Failing before the fix (Run).
2. A11:A16 all `=$B$5`, insert a row at index 3. Peer shows `=$B$6` in all six. Failing before the fix (Run).
3. Delete column B with `E1 =B2`. Peer's `E1` matches the engine's rewritten text.
4. 4 x 4 grid, formulas at (1,0) and (3,3), insert row 0, undo. Chain is `1_0, 3_3` only. Failing before the fix (Run). Add a column-insert variant.
5. 1,000 x 26 sheet with 1,000 formulas, insert at top, undo and redo. Each finishes in a time budget well under the current 6.3 s.
6. Undo a 2-row insert. The peer's `row` equals the engine's.
7. Two Y.Docs: local commit of a formula while a structural remount is deferred. After the remount, the chain in Yjs holds the peer's shifted entries and the new formula.
8. A bootstrap whose `whenSynced` never resolves, then `rebuildLocalStore`. The rebuild settles (resolves or rejects) within a timeout.
9. The bootstrap effect re-runs between provider construction and first read. The rebuild settles.
10. Host passes a new `onChange` 500 ms after an edit. The host still receives the call once.
11. `=A!B5` and `=2*A!B5` on tab B, insert a row on tab A. Tab B's formulas are rewritten in memory and in Yjs.
12. A remote formula cell with the same `f` as the local one does not clear `depGraphComplete`.
13. Cut B1 (`=A1*2`), paste at D4, set A1=7. D4 shows 14 and the chain holds `3_3` (zero-based D4) not `0_1`.
14. Fill down a formula range. Exactly one Yjs write per cell.
15. Plain-text paste does not clear `depGraphComplete`; a formula-object paste does.
16. A throw inside `rehydrateWorkbookFromYdoc`. A later local edit still reaches Yjs.

## 8. What was not verified

- #3 end to end, #9, #10 timings, #11 repro, #12 double write, #13 `definedNames` staleness, #14 gap, #17 freezing, #18 consequence: read only.
- #4 hangs: library source and code read; no hang reproduced.
- The reviewer's host-side behaviour for #5 (dsheets.new passing an inline `onChange`): taken from the comment; dsheets.new is not in this repo.
- `rebuildLocalStore` dropping rows the live doc never loaded.
- The reviewer's statement that the 17 structural variants, 26 randomized fingerprint runs and 19 B5 edge cases pass: not re-run in this session (the 368-test unit result is from the commit message of `037248b`, not re-run).

## 9. Fix status (2026-10-28, committed in a7abbed)

Unit suite after the fixes: 52 files, 397 tests pass (50 files, 368 tests before); `tsc --noEmit` clean. No browser check was run.

| # | Status | Change | Tests |
|---|---|---|---|
| 1 | Fixed | Debug `afterTransaction` effect and its `Y` / `fromUint8Array` imports removed from `editor-workbook.tsx`. | none (deleted code) |
| 6 | Fixed | `snapshotCell` in `ydoc-celldata-changes.ts` copies formula cells into the snapshot, so the in-place rewrite cannot change what the diff compares against. | 4 new cases in `structural-edit-formula-sync.test.ts`; 3 failed before the change (merge row insert, merge row delete, repeated formula row insert), all pass now. The repeated-formula column-delete case passed before and after. |
| 5 | Fixed | `onChange` is read through a ref when the throttle fires; the throttle is built once per `dsheetId` (`legacy-on-change.ts`). | `legacy-on-change.test.ts` (4). New file, so no failing run against the old throttle. |
| 2 | Fixed | `reregisterRestoredFormulas` reads the chain into a set once, adds only missing formulas and removes lost ones in one batch (`delFunctionGroupBatch` in `formula.ts`). | 4 new tests in `history-calc-chain.test.ts`. Undo of a top-row insert on 1,000 x 26 with 1,000 formulas: 6,321 ms before, 24 ms after (same harness). |
| 3 | Fixed (mechanism); position problem K8 still open | `shouldSkipEchoWrite`: `guardRemoteEcho` also skips while a structural remount is pending. `afterUpdateCell` writes the calcChain entry of a formula committed in that window, at the coordinates the cell is written at. Guard comment and K8 corrected. | 5 tests in `remote-apply-guard.test.ts`, 3 in `after-update-cell.test.ts`. The end-to-end repro (deferred remount plus local formula) was not run. |
| 4 | Fixed | `wait-for-sync.ts`: `waitForPersistenceSynced` (timeout 15 s plus a generation check) replaces `await whenSynced` in the bootstrap and in `rebuildIndexedDbStore`. `rebuildLocalStore` waits 3 s for a bootstrap, then abandons it with a new generation and finishes the merge itself (`completeBootstrapContent`). The bootstrap's catch no longer clears a `persistenceRef` that a rebuild replaced. | `wait-for-sync.test.ts` (7), 2 new tests in `rebuild-indexeddb-store.test.ts`. The hook wiring has no test (no React renderer). The old unbounded wait was not run to show the hang. |

Side effects to know about:

- #4: a first IndexedDB read slower than 15 s now ends the bootstrap without IndexedDB and calls `onIndexedDbError`. It used to wait without limit.
- #3: while a remount is pending (50 ms, or longer while a cell edit defers it), metadata echoes (conditional formats, hidden rows, filters and the like) are not written to Yjs.
- #2: a restored non-formula cell that is not in the chain no longer has its dependency edges or dynamic-array entry dropped.
- #6: formula cells in the snapshot are copied; the cost on a very large sheet was not measured.

Not fixed (listed in `KNOWN-ISSUES.md` as K45 to K55): #7 to #18. #8 (stale chain entry after undoing an insert) shares `history-calc-chain.ts` with #2 and is the natural next fix.

## 10. Fix status, second round: #7 to #14 (2026-10-28, committed in a5dcd88)

Unit suite after this round: 54 files, 429 tests pass (52 and 397 before); `tsc --noEmit` clean. No browser check was run.

| # | Status | Change | Tests |
|---|---|---|---|
| 7 | Fixed | `FORMULA_SHEET_REF_RE`: an unquoted sheet name stops at `= * / < > ^ % ; :` and cannot start with `-`. `collectSheetIdsFromFormulaText` is exported for the test. | `sheet-flowdata-lifecycle.test.ts`, 13 cases (`=A!B5`, `=2*A!B5`, `=-A!B5`, quoted names, `Q1-2026!A1`, ranges). Not run against the old regex; the old capture (`=A`, `=2*A`) was seen in the earlier regex run. |
| 8 | Fixed | After re-registering, `reregisterRestoredFormulas` drops chain entries that lie outside the shrunk grid (rows past the last row, columns past the first row's width), through the same batch delete. Entries inside the grid without `f` are left alone (a collaborator's entry can arrive before its cell). | 2 tests in `history-calc-chain.test.ts`: row and column insert then undo leave `1_0, 3_3`. The row case failed before (seen in the earlier run: `4_3` stayed). |
| 9 | Fixed | `gridSizeChangesFromPatches` (`history-grid-size.ts`) turns `row` / `column` patches into Yjs changes; `emitYjsFromPatches` upserts them. | `history-grid-size.test.ts`, 4 tests, built from real `insertRowCol` patches (undo gives 12, redo gives 14, column gives 6). |
| 10 | Fixed | `applyRemoteCellValue` keeps `depGraphComplete` when the cell already held the same formula text and was already in the chain. A new or changed formula, or the same formula missing from the chain, still clears it. | 4 tests in `remote-apply.test.ts`. The reviewer's commit-time figures were not re-measured. |
| 11 | Fixed | `moveCalcChainForCutPaste` removes the chain entries of the cleared source cells (same sheet) and registers the pasted formulas, through one set and one batch delete. | 2 tests in `paste-dep-graph.test.ts` (cut B1 to D4: chain is `3_3`; paste onto itself: `0_1` once). The reviewer's full repro (set A1=7, D4 recalculates) was not run. |
| 12 | Fixed | The hook `afterUpdateCell` takes `options.skipPersist`. The four fill sites in `dropCell.ts` and the formula-object paste in `paste-internals.ts` pass it, because they write the final cell in their own batch. The Yjs write and the chain write in `afterUpdateCell` are skipped when it is set; data-block work is unchanged. | 2 tests in `after-update-cell.test.ts`. The call sites are not tested (they need a full workbook); the double write itself was not counted in a run. |
| 13 | Fixed | The CF compute-map cache and the border cache are `WeakMap`s (keyed by the sheet object and by the config object), so a sheet no longer stays in memory after its editor goes. The CF key includes `ctx.definedNames`. | 1 new test in `engine-hot-spots.test.ts` (a changed defined name misses; `luckysheetfile` identity unchanged). No test shows the memory being freed (needs a GC run). The optional re-keying on `sheet.data` was not done. |
| 14 | Fixed | `lockWorkbookReadOnly` sets `isFlvReadOnly` on the engine context (no history) inside the format-gate watcher, before `setFormatLocked(true)`. | 4 tests in `format-gate.test.ts`. Not run in a browser; only `isFlvReadOnly` is set, so any check of `allowEdit` alone is not covered. |

Side effects to know about:

- #12: a host whose `afterUpdateCell` wrapper does not pass `options` through would still persist twice. The package wrapper in `editor-workbook.tsx` passes it.
- #13: the border cache is keyed by the config object, so a config change (for example a column width) now misses where it hit before when only `borderInfo` and `merge` mattered.
- #10: the check for "already in the chain" scans the chain once more per remote formula cell, as `insertUpdateFunctionGroup` already does.

Still open: #15 to #18 (K52 to K55 in `KNOWN-ISSUES.md`).

## 11. Fix status, third round: #15 to #18 (2026-10-28, committed in 291c398)

Unit suite after this round: 54 files, 439 tests pass (429 before); `tsc --noEmit` clean. No browser check was run.

| # | Status | Change | Tests |
|---|---|---|---|
| 18 | Fixed | `runRemoteApplyUntilPaint` (`remote-apply-guard.ts`): begins the guard, runs the body, ends it after paint, and ends it at once and rethrows if the body throws. `rehydrateWorkbookFromYdoc` uses it, so a throw no longer leaves the depth above zero. | 3 tests in `remote-apply-guard.test.ts`. The hook itself has no test (no React renderer). |
| 15 | Fixed | `pasteHandler` calls `markDepGraphIncomplete()` only in the object branch, after the `data.length === 0` check. A plain-text paste and a blocked paste leave the flag on. | 2 new tests in `paste-dep-graph.test.ts` (plain text, read-only). A text paste that contains a formula still clears the flag: the engine's `execFunctionGroup` does it when `handleFormulaOnPaste` runs (seen in a stack trace), so I did not add a second clear. |
| 17 | Fixed | `setSheetCalcChain` assigns copies of the entries; `use-editor-data.tsx` gives the plain snapshot its own copies too. Cause found: the entries come from `Y.Map.toJSON()`, which returns the stored plain objects by reference, so Immer's deep freeze reached objects Yjs holds. | 1 test in `remote-apply.test.ts`: the caller's entry stays unfrozen, the engine's copy is frozen. |
| 16 | Fixed | `createYdocBatch` (`ydoc-celldata-changes.ts`) collects the changes of one insert or delete; the emit helpers take an optional sink; `insertRowCol` and `deleteRowCol` flush once, so a peer receives one Yjs update. Before: 2 updates on an insert in the test setup (the format-ranges write and the cell/size write); the reviewer counted 4 (insert) and 5 (delete) when cell-format ranges, rewritten formulas and the beyond-grid deletes are all present. | 4 tests in `structural-edit-formula-sync.test.ts` count the `update` events of the first doc: 1 each for row/column insert and delete. The two insert tests failed before this change on the first run of the new code (2 instead of 1) and led to moving the batch to the top of `insertRowCol`. |

Side effects to know about:

- #16: the changes of one edit are applied in the order they were emitted, in one transaction. The two format-range writes that happen inside `insertRowCol` (row and column branches) are now part of the batch, so they are sent with the cells instead of before them.
- #15: unchanged behaviour for HTML-table and object pastes.
- #17: one extra shallow copy per chain entry on each remote chain apply.

All 18 inline review comments are now fixed. Still open and outside the review: K8 (position of a commit during a deferred remount), the remaining parts of K6 (sheets with no calcChain, unhydrated sheets), the dead y-indexeddb `'error'` listeners, and `rebuildLocalStore` dropping rows the live doc never loaded.

## 12. Fourth round: ten new comments on `f0c7334` (validated 2026-10-29; fixed, see sections 13 to 15)

Reviewer: nadeem-fileverse, posted 2026-10-29 on `f0c7334`. Read through the GitHub REST API (`/pulls/466/comments`). Each comment was checked against the code at HEAD; the claims that could be run were run in temporary Vitest files, which were deleted afterwards (working tree unchanged except this doc). Evidence labels as in section 1. This section records the state before any fix; the fixes and their evidence are in sections 13 to 15.

| # | Severity | File:line | Topic | Verdict | Evidence |
|---|---|---|---|---|---|
| N1 | Must fix | `rowcol.ts:266` | Rewrite on an unloaded tab is history-addressed by `celldata` position | Valid | Run |
| N2 | Must fix | `formula-warmup.ts:40` | Warm-up aborts on a tab with no grid and is never restarted | Valid | Run (abort); Read (no restart) |
| N3 | Must fix | `hover-tracker.ts:76` | Hover predicate misses eight drag states | Valid | Read |
| N4 | Should fix | `formula-dep-text.ts:233` | Digit-only tab name read as a number | Valid | Run |
| N5 | Should fix | `formula-dep-text.ts:213` | `\` treated as a string escape | Valid | Run |
| N6 | Should fix (existing) | `paste-internals.ts:1315` | Leftover `execFunctionExist` after cut-paste | Valid for the first commit; second-commit claim not reproduced | Run |
| N7 | Low | `shown-comments.ts:32` | Key ignores `ps` | Valid | Read |
| N8 | Low | `formula-dep-text.ts:227` | Token start is ASCII only | Valid | Run |
| N9 | Low | `rowcol.ts:339` | Refused insert clears `depGraphComplete` | Valid | Read |
| N10 | Low | `use-celldata-compaction.ts:140` | No reschedule after a stop | Valid (mostly) | Read |

### Details

- **N1.** Fixture: tab A (grid), tab B unloaded (`celldata` `[A1 =A!B5, B2 =B1*3]`), insert 2 rows at row 2 on A.
  - Run: forward patch is `luckysheetfile/1/celldata/0/v/f` (by position). `planHistoryPatches` passes it through untouched (no calcChain patch in this case). B becomes `=A!B7`.
  - Run: undo with B still unloaded gives `=A!B5` in the engine. Undo after the `celldata` array changed (a peer removed entry 0) gives `["=A!B5"]`, i.e. the text lands on the wrong entry and one is lost. Undo after B was loaded (`data` set, `celldata` emptied) throws `[Immer] Cannot apply patch, path doesn't resolve: luckysheetfile/1/celldata/0/v/f`. The comment's three failure modes are therefore real.
  - Read: `emitYjsFromPatches` handles `mapFields` only when `path[3]` is a string (`Workbook/index.tsx` ~503-513). A `celldata` patch has a number there, so nothing reaches Yjs and peers keep `=A!B7`.
  - Run (cost): insert at the top of a 9,990-row tab with 5,000 non-cross-tab formulas on an unloaded tab: 266 ms here. The reviewer's 455 ms is for a different machine/fixture; not re-measured. Read: `rewriteFormulasInCelldata` calls `functionStrChange` for every formula with no `!` pre-filter.
  - Not run: the `handleUndo` pop-before-`setContext` claim and the "peer adds `=A!B5` to B while you are on A" way to reach the state.
- **N2.** Run: tab B has a calcChain and no `data`; `warmFormulaDependencyGraph` resolves `'aborted'`, `depGraphComplete` stays false, and loading the tab afterwards leaves nothing scheduled. Read: `formulaTabsDense` is checked at the start and in every slice, and the only restarts are `trigger()` and `onDepGraphIncomplete`. The reviewer's per-commit table (6.7 / 18.9 / 46.2 ms flag off; 0.29 / 0.46 / 1.2 ms flag on) is a reviewer figure, not re-measured. The comment is right that the dense check is no longer needed for the text reader: `collectFormulaTextDeps` already treats a tab with no grid as wide for whole-row/column refs.
- **N3.** Read: `mouse.ts:3821-3850` runs `mouseRender` for `luckysheet_scroll_status`, `select_status`, `rows_selected_status`, `cols_selected_status`, `cell_selected_move`, `cell_selected_extend`, `cols_change_size`, `rows_change_size`; `isHoverInteractionActive` lists only `luckysheet_cell_selected_move`. The reviewer's counts (2 of 8 moves; `[true,false,false,false,false]` below the grid) were not re-run. The freeze-line and formula range drag states named in the comment were not traced.
- **N4.** Run, tabs `Sheet1`, `2025`, `2026`, formula `=2025!A1+2026!A1` in Sheet1 B6-ish cell: the text reader records `s1:0:0` only; `execfunction` records `s2:0:0` and `s3:0:0`. Cause (Read): the loop treats a leading digit as a number before trying a tab prefix, except for the `1:3` row-range case.
- **N5.** Run: `=A1&"\"&B1` text reader `{A1}`, engine `{A1,B1}`. `=IF(A1="x\",B1,C1)` text reader `{A1}`, engine `{A1,B1,C1}`. Cause (Read, `formula-dep-text.ts:213`): `i += s[i] === '\\' ? 2 : 1`. The engine escapes only `""`.
- **N6.** Read: `postPasteCut` fills `execFunctionExist` with source and target cells (`paste-internals.ts:144-165`), its `execFunctionGroup` call is commented out (`:274`), and `execFunctionGroup` builds its edited-cell set from that list when it is set (`formula.ts:2698-2704`). Run: A1=5, A6=5, B1 `=A1*2`, B6 `=A6*2`, cut B1 to D4, then `updateCell(A6, 50)`: B6 stays 10 (want 100). The first commit is consumed by the leftover list, as the comment says. Not reproduced then: a following `updateCell(A1, 7)` also left D4 at 10 in this harness (the comment says the second commit works). Explained later (section 15): the harness had no `settle` step for the deferred formula chunks, so it was the harness, not a second bug.
- **N7.** Read: `shownCommentsKey` joins `sheetId` and `r_c` of each shown cell only, so a move or resize that changes only `ps` leaves the key equal. The effect that applies `showComments` is gated on this key (E5). Not run in a mounted component.
- **N8.** Run, tabs `Sheet1`, `Étude`, formula `=Étude!A1*2`: text reader records no dependency and marks the formula wide; `execfunction` records `s2:0:0`, not wide. Cause (Read): the token-start test is `/[A-Za-z0-9_$.']/`.
- **N9.** Read: `insertRowCol` calls `markDepGraphIncomplete()` at `:339`; the `readOnly` throws are at `:395-413` and `maxExceeded` at `:417-423`, and `if (!d) return` is at `:362`. The same pattern is in `deleteRowCol` (`:1821` before the throws at `:1850-1865`). Not run.
- **N10.** Read: `runCompaction` returns when `canRunCompaction` is false or when `applyCompactionChangesInChunks` returns not-finished, and nothing reschedules. The effect re-runs when one of its dependencies changes (for example `collabSyncing`), so "one chunk per open" is the worst case, not always. Not run.

### Reading across the ten

- N1, N2, N4, N5, N8 sit in code added by K6 (`rewriteFormulasInCelldata`) and C8 (`formula-dep-text.ts`, warm-up). N3 is E1, N7 is E5. N6 and N9 are follow-ups to round 1 (#11, #15): the chain entry moves and the plain-text paste is fixed, but the list left by `postPasteCut` and the early flag clear in `insertRowCol` remain.
- N2 reduces the C8 win: with two formula tabs and any demotion the headline commit figures (0.1 ms) do not apply. Section 6 of `before-after-summary.md` should say so until N2 is fixed.

### Suggested order

1. N2 (drop the dense check, treat a gridless tab as wide, restart on tab load or just run regardless), then N4, N5, N8 together in `formula-dep-text.ts`.
2. N1 (the lighter option: filter on `!` and load via `ensureSheetFlowdata`, or address `celldata` by `r`/`c` in history and Yjs).
3. N3 (extend `isHoverInteractionActive`).
4. N6, N7, then N9, N10.

### Proposed tests (written in sections 13 to 15)

1. N1: unloaded tab B, insert on A, undo then redo: engine and Yjs agree, no throw, also after B is loaded and after a peer edit to B.
2. N2: two formula tabs, one without a grid: warm-up completes, `depGraphComplete` true, commit to an unreferenced cell takes the narrow path.
3. N3: each of the eight drag flags makes `isHoverInteractionActive` true.
4. N4: `=2025!A1+2026!A1` edges equal `execfunction`'s. N5: both backslash formulas. N8: `=Étude!A1*2`.
5. N6: cut B1 to D4, set A6, B6 recalculates on the first commit; also set A1, D4 recalculates.
6. N7: moving a shown comment changes the key.
7. N9: a refused insert (read-only row, max rows) leaves `depGraphComplete` true.
8. N10: a stopped run is retried.

## 13. Fourth round, first fixes: N2, N4, N5, N8 (2026-10-29, committed in `b046b97`)

Unit suite after this group: 64 files, 576 tests pass (567 before); `tsc --noEmit` clean. No browser check.

| # | Status | Change | Tests |
|---|---|---|---|
| N2 | Fixed | The warm-up no longer needs every formula tab to have a grid. A tab without one is read from its `celldata` (`createFormulaTextReader` in `formula-warmup.ts`, indexed once per slice and once at merge). A formula whose cell is not in `celldata` yet is recorded as always-run, and the merge check uses the same reader, so a cell that changed since it was read is marked always-run too. Nothing is loaded. | 3 in `formula-warmup.test.ts` (the old "leaves the flag false while a tab is sparse" test was rewritten); all 3 failed against the unchanged source. |
| N4 | Fixed | A leading digit run followed by `name!` is a tab prefix, not a number (`2026!A1`). Plain numbers and the `2:3` row range are unchanged. | `=2025!A1+2026!A1` and `=SUM(2025!A1:A2)` compared with `execfunction`'s edges; both failed before. |
| N5 | Fixed | A backslash inside a string is a plain character; only the closing quote ends the string (a doubled quote closes and reopens, so it needs no case). | `=A1&"\"&B1` and `=IF(A1="x\",B1,C1)` compared with `execfunction`; both failed before. |
| N8 | Fixed | The token start and the boundary test accept `À-ʯ`, the same range bare tab names allow in `sheet-name-ref.ts`. | `=Étude!A1*2` and `=SUM(Étude!A1:A2)+B1` compared with `execfunction`; both failed before. |

Numbers (Node, 4000 x 25 tab, N formulas `SUM(A:T)` on Sheet1, one formula on a demoted Sheet2 that reads Sheet1; median of 15 commits to an unreferenced cell; before = the unchanged `formula-warmup.ts`, after = the fix, same file and fixture):

| Formulas | Before | After |
|---|---|---|
| 500 | warm-up `aborted`, flag false, 4.45 ms | `complete`, flag true, 0.069 ms |
| 2,000 | `aborted`, flag false, 15.45 ms | `complete`, flag true, 0.054 ms |

Limits:

- The reviewer's figures (6.7 / 18.9 / 46.2 ms flag off) are for their own sheet and were not re-measured.
- `getAllFunctionGroup` returns chain entries of tabs with no grid; the commit path then skips evaluating them, as before. A tab that is loaded later has no size recorded in `depGraphSheetSizes`, so a commit to it with no dependents takes the full pass once and restarts the warm-up. Not run in a browser.
- The N4 fix reads `2026!A1` as a tab reference even if no such tab exists; the reference then resolves to nothing and the formula is marked always-run, as for any unresolved tab.

All ten round-4 comments are fixed once section 15 is read; nothing from round 4 is open.

## 14. Fourth round, second group: N3 and N1 (2026-10-29, N1 committed in `5f0cb23`, N3 in `24fabfc`)

Unit suite after this group: 65 files, 598 tests pass (576 before); `tsc --noEmit` clean. No browser check.

| # | Status | Change | Tests |
|---|---|---|---|
| N3 | Fixed | `isHoverInteractionActive` also returns true for `luckysheet_scroll_status`, `select_status`, `rows_selected_status`, `cols_selected_status`, `cell_selected_extend`, `cols_change_size`, `rows_change_size` (the eight states `handleOverlayMouseMove` runs `mouseRender` for, with the one already listed) and for `luckysheet_cols_freeze_drag` / `rows_freeze_drag`, which `mouseRender` handles. The formula range resize/move drags the comment names sit in a commented-out block of `mouse.ts` (`rangeResize` / `rangeMove`), so they are not live and are not in the list. | 10 in `hover-tracker.test.ts`, all failed before: nine flags, and five moves below the grid during a drag-select all processed (the comment's `[true, false, false, false, false]`). |
| N1 | Fixed (engine and Yjs write); the user-facing undo path is not run | `rewriteFormulasInCelldata` (`rowcol.ts`) replaces a not-loaded tab's `celldata` as a whole array, and only when a formula changed, instead of editing `v.f` in place. History therefore records one replacement (`luckysheetfile/<i>/celldata`), which undo and redo replay whatever happened to the array meanwhile. Only formulas that contain `!` are visited. `emitYjsFromPatches` (`Workbook/index.tsx`) handles that patch: `celldataArrayChanges` (`history-celldata.ts`) writes the cross-tab formulas that differ between the two arrays, by cell key. | 8 engine tests in `rowcol-unloaded-history.test.ts` (3 failed before: patch addressed by position, throw after the tab loaded, text on the wrong cell after a peer removed an earlier entry) and 4 for `celldataArrayChanges`. |

Limits and side effects.

- Chosen over the comment's two options: loading the tab first would put the hydration into the history entry (a whole-grid `data` patch, which `planHistoryPatches` treats as coarse and which the Yjs write skips on undo), and keying history by `r`/`c` would need a second patch format.
- Undo or redo replaces the unloaded tab's whole `celldata` in memory. A cell a peer changed on that tab since the edit is reverted locally until the next sync. It is not written to Yjs, unless it is itself a cross-tab formula (it contains `!`), in which case the old text is written back over the peer's.
- The `emitYjsFromPatches` branch has no test (it lives in the Workbook component; vitest has no React renderer). Only `celldataArrayChanges` and the engine behaviour are tested. Not run in a browser or with two clients.
- The comment's cost figures (455 ms for 5,000 formulas, 778 ms with three unloaded tabs) were not reproduced as a gain from this change. Same fixture before and after (insert at the top of a 9,990 x 26 tab, tabs with 5,000 formulas that do not contain `!`, median of 5): 1 tab 213 ms to 220 ms, 3 tabs 268 ms to 251 ms. The time is mostly the edited tab's own work; the `!` filter is not shown to matter here, so no speed-up is claimed.
- The `handleUndo` pop-before-`setContext` claim in the comment was not run.

Round 4 is complete after section 15.

## 15. Fourth round, last group: N6, N7, N9, N10 (2026-10-29, N6 and N9 committed in `5f0cb23`, N7 and N10 in `24fabfc`)

Unit suite after this group: 66 files, 618 tests pass (598 before); `tsc --noEmit` clean. No browser check. All ten round-4 comments are now fixed.

| # | Status | Change | Tests |
|---|---|---|---|
| N6 | Fixed | `postPasteCut` (`paste-internals.ts`) runs the `execFunctionGroup` pass it had commented out, right after building the source and target list, so formulas that read the source or the target recalculate and the pass clears the list. Left set, the next commit anywhere used the list as its edited cells and skipped its own dependents. Mirrors `jfrefresh`'s `runExecFunction`. | 4 in `paste-dep-graph.test.ts`; all 4 failed against the unchanged `paste-internals.ts`: list left behind, B6 stays 10 after A6 is set to 50, D4 stays 10 after A1 is set to 7, C1 (`=B1+1`, reads the cut cell) stays 11. |
| N7 | Fixed | `collectShownCommentCells` adds a `sig` (`left:top:width:height:text` of `ps`) to each shown cell and `shownCommentsKey` includes it, so moving or resizing a pinned box, or a peer editing its text, changes the key and `showComments` runs. | 6 in `shown-comments.test.ts` (5 failed before: moved right, down, wider, taller, text changed; one for an unchanged box). The existing collect test was adjusted for the extra field. |
| N9 | Fixed | `insertRowCol` clears `depGraphComplete` only after the `readOnly` and `maxExceeded` checks; `deleteRowCol` after its `readOnly` checks and the missing-grid return. A refused edit no longer restarts the warm-up. | 6 in `rowcol-refused-edit.test.ts` (4 failed before: read-only insert, past the row limit, unknown tab, read-only delete; two guard that a successful insert and delete still clear the flag). |
| N10 | Fixed | `createCompactionRetrier` (`use-celldata-compaction.ts`): a run that was refused by the gate or stopped because the document changed asks for another run after `COMPACTION_RETRY_MS` (30 s), up to `COMPACTION_MAX_RETRIES` (10). The hook's run is now an `attempt()` returning `done` or `retry`; the retry goes back through the idle scheduler, and the effect cleanup cancels the timer. | 4 in `use-celldata-compaction.test.ts` (all failed before: the function did not exist). The hook wiring has no test (no React renderer). |

Notes.

- The N6 comment says the second commit after a cut-paste works; I first saw a second commit leave D4 at 10 and called it unexplained (section 12). The cause was my harness: formula values are written by deferred chunks and the test had no `settle` step. With `settle`, the first commit fails without the fix and passes with it. A second commit was not tested separately.
- N6 runs a formula pass at every cut-paste; its cost was not measured (pass over the chain with the source and target cells as edited cells).
- N10: a retry every 30 s for up to five minutes while collaboration is syncing or a remote apply is running; after that the compaction waits for the next open as before.
- N7: the key now holds the comment text of every shown box; with many pinned comments the string grows, one entry each.

## 16. Commits for the fixes

| Round | Items | Commit |
|---|---|---|
| 1 | #1 to #6 | `a7abbed` |
| 2 | #7 to #14 | `a5dcd88` |
| 3 | #15 to #18 | `291c398` |
| C8 spec changes (wide formulas join the walk only when affected; a collaborator's formula keeps `depGraphComplete`; chain diff in `setSheetCalcChain`) | spec change of 2026-10-29, closes K17 | `7847262` |
| 4 | N2, N4, N5, N8 | `b046b97` |
| 4 | N1, N9, N6 | `5f0cb23` |
| 4 | N3, N7, N10 | `24fabfc` |
| 5 | N1 (two comments), K60 | not committed (section 17) |

Unit suite at the end: 66 files, 618 tests pass; `tsc --noEmit` clean. No browser check and no two-client check of any round-4 change or of the C8 spec changes.

## 17. Fifth round: reviewer's re-check at `ed0adf4` (2026-10-30)

The reviewer verified N2 to N10 and the C8 spec changes, and left five comments. Two block merge (both N1), K60 is welcome in the same push, and two are follow-up tickets (not done here, per the reviewer: add nothing else to this PR).

| Comment | Status | Change | Tests |
|---|---|---|---|
| N1a (`rowcol.ts:281`): undo after the unloaded tab was opened leaves the shifted reference, in the engine and in Yjs | Fixed | `loadTabsReadingSheet` (`structural-edit-prep.ts`) loads the unloaded tabs whose formulas name the edited tab, in a separate `produce` before the recorded one. `setContextWithProduce` calls it for any edit that carries `insertRowColOp` or `deleteRowColOp`. The rewrite is then recorded as `data` cell patches, and `handleUndo`/`handleRedo` already load a tab for `data` patches. | `structural-edit-prep.test.ts`, 16 tests; 9 failed with the load step removed, all pass with it. |
| N1b (`history-celldata.ts:52`): undo while the tab is unloaded removes or reverts a collaborator's edits | Fixed by the same change | Undo and redo now replay only the cells the rewrite touched, so a peer's added formula, changed formula and value edit survive, with B loaded, or unloaded again at undo time. | Same file: peer-added `=A!B9`, peer `=C!A1` to `=C!A2`, peer value 42, peer edit of the rewritten cell, each after undo and redo, loaded and unloaded again. |
| K60 (`formula.ts:1826`): first commit after a tab switch takes the full pass and clears the flag | Fixed | `initSheetData` calls `recordLoadedSheetSize` when it loads an existing tab while `depGraphComplete` is on and no size is recorded. | `formula-tab-load.test.ts`, 4 tests; 2 failed without the call. |
| `formula-warmup.ts:296`: reader re-indexes `celldata` per slice | Open, follow-up ticket | One reader per run, rebuilt when a tab's `celldata` array changes. | none |
| `formula-transitive-deps.ts:88`: walk cost grows with wide formulas times reached cells | Open, follow-up ticket | Parse each reached cell once; group pending ranges by tab and column. | none |

Unit suite 68 files, 638 tests; `tsc --noEmit` clean.

Browser check (2026-10-30, demo dev build, one window, built-in browser; temporary instrumentation exposing the Y.Doc, removed afterwards). Setup: tabs `A` and `B`, B holds `A1 =A!B5` and `D4 =A!B1+1`, B demoted to `celldata` with no calcChain, then "Insert 1 rows above" on row 3 of A through the row-header context menu. Results, engine and Yjs both read: insert gives `=A!B6` (B was loaded first); undo gives `=A!B5`; redo gives `=A!B6`; a second undo gives `=A!B5` again. Peer-style writes straight into the Yjs doc on B (`C3 =A!B9`, `E5` 42, `D4` changed to `=A!B2+1`) survived undo and redo, with B loaded and with B demoted again right before the undo (B was loaded by the undo). K60: `depGraphComplete` stayed true across tab switches and commits, but B stayed loaded in that run (it reads A), so the unloaded-tab case of K60 is covered by unit tests only. Not run: two windows in one room (no collaboration server; the peer was simulated by writing to the Y.Doc), the undo with the real Ctrl+Z key, and the old code for a before-comparison.

Limits.

- Only edits that carry `insertRowColOp` or `deleteRowColOp` load the tabs first (context menu, row/column header insert, paste-insert, Workbook handlers). `insertRowOrColumn` / `deleteRowOrColumn` on the host API pass no op, and remote ops are `noHistory`, so those still take the whole-array `celldata` path of N1 (`rewriteFormulasInCelldata`), with the limits in K56.
- A structural edit now leaves the tabs that read the edited tab loaded (until demote-on-switch). The scan for such tabs reads the `celldata` formulas of every unloaded tab once per edit; its cost was not measured.
- The Yjs write for undo/redo goes through the existing `data` cell branch of `emitYjsFromPatches`; it has no test (no React renderer). The tests check the engine state after replaying the patches.
- K60: the size is recorded at load from the dense grid built from `celldata`; a remote structural change that arrived while the tab was unloaded clears the flag as before.

Commit for this round: not committed yet.
