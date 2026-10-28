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

Sections 1 to 8 describe the review as validated on 2026-10-28 before any fix. The six must-fix items were fixed afterwards in the working tree (not committed); see section 9. Fix designs in the sections above are the proposals that were made; they are labeled [Inference] where they rest on reasoning rather than a run.

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
- `docs/perf/NEXT.md`: still lists the audit fixes, `fingerprintFromUpdate` and K1/K2 as uncommitted; they are in `d96a8bd`, `750bb33` and `037248b`.
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

These are proposals; none have been written.

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

## 9. Fix status (2026-10-28, working tree, not committed)

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
