# dSheet Stabilize

Status: accepted by the team, 2026-10-23. Revised 2026-10-26 (teammate update: A1 fingerprint rules, A4 undo, B5 case rule, B6 text-paste, C1/C2/C7 cache keys, C8 index rebuilt from formula text, D5/D6 fingerprint sources and upgrade rule, E3 active-sheet keeper, E2 SVGDefines). Part 1 of 2; ships first. Part 2 is YSheetStore.

## Implementation status (updated 2026-10-26, branch `maitra/stabilize-package`)

| Item | State | Commit | Notes |
|---|---|---|---|
| A1, A2 | done | 490c082 | |
| A3 | done | 28db6fd | |
| A4, A5 | done | b056601, ab23c16 | |
| B1 | done | cf58246 | |
| B2, B4, B6 | done | b3e38a9 | |
| **B3** | done | 1587101 | Deviation from the Fix text below: the guard is not held while the remount is deferred; it begins once right before the remount (see B3). Browser-checked. |
| **B5** | done | 8b18a94; case rule fixed in Task 17 (782aacd) | Shipped case-insensitive; Task 17 made the comparison exact and case-sensitive, as this spec says. |
| C1, C3 | done | 7a1a19e | |
| C2, C6, C7 | done | 03fc133, 4ef4fd4, 9290e13 | |
| **C8** | done | fb80dfc, a324b38 | Plus a warm-up pass after open so the flag turns true; shadow indexes merged at completion. |
| **C4, C5** | done | 29843e6 | C5 browser timing: 10k single-line cells 1,827 ms to 49 ms median. |
| July narrowing bug (commit 1611aee, not a spec item) | done (Task 16, 627aeda) | | Commit-path narrowing waits for a complete graph; flag-false sheets run the full list per commit (S15: 0.21 ms to 3.9 ms at 500 formulas). |
| D3 (package side) | done, committed `4d181b5` (Task 6) | | `rebuildLocalStore()` on the editor handle; results doc "D3 (package side)". App side (call it instead of delete-and-remount, `onIndexedDbError`) is in dsheets.new. |
| D5 step 3 (package side) | done, committed `4603bd9` (Task 7) | | `appendDsheetUpdate` in `./persistence` (not `src/index.ts`); S12: 113 ms and 1.09 MB written to 0.24 ms and 1,580 B (Node, fake-indexeddb). Other D5 steps are app side. |
| F | done, committed `71d758d` (Task 8) | | `format-gate.ts`; S13: gate costs 0.9 microseconds per open, paired medians within 1 ms; results doc "F". Every writer reachable without the toolbar is guarded. |
| E1–E6 | not started | | Plan Tasks 9–14. |
| D0–D2, D4, D6 (app side, dsheets.new) | not in this repo | | See NEXT.md. |

Open finding, not yet an item: formula text rewritten by a row insert is not carried to a second client in the same room (observed in the demo with two tabs; not checked on `main`). It bears on B5 and on part 2's removal of the rewrite. Details in `docs/perf/NEXT.md`.

Line numbers refer to fileverse-dsheet origin/main 9411d95 (package 4.1.21), dsheets.new origin/staging db44e94 and ddocs.new origin/staging 62723dca, except where a line is marked `origin/main` for ddocs.new.

## 1. Goal

Make sheets responsive and stop the known silent data-loss paths, inside today's architecture and storage format, in changes that are small and do not fight the YSheetStore direction. Two kinds of sheet are in scope:

- **Large:** one 100k-cell tab, about 10 concurrent editors.
- **Small but heavily used:** sheets of about 100 rows with dropdowns, formatting and fill colours have been reported as lagging. Most of today's costs scale with the size of the Yjs document, not the visible cells. Every overwritten value stays in the document, so a small sheet edited for months costs about as much per edit as a large one (section 2). Some costs don't depend on size at all: whole-UI re-renders and per-draw feature work.

**Rule for inclusion:** a change is in scope if it fixes a measured cost or a confirmed data-loss path, is local to a few functions, and needs no Yjs schema change. Anything structural moves to part 2.

**Exception:** D5 (publish passes) and E2 (subscribing the heavy UI components) are larger than the rest. They were added on purpose so small sheets are covered.

## 2. Baseline and targets

Measured in Node with the package's own yjs 13.6.30, immer 9.0.21 and lodash, on one 4,000 x 25 tab with realistic cell objects. Browser numbers are from the teammate audit on origin/maitra/perf-improvements (dev build, 198k cells).

| Cost today | Value | Target after Stabilize |
|---|---|---|
| Package work per local edit (whole-doc encode + whole-workbook conversion) | 175 ms (1 tab), 560 ms (3 tabs of 100k) | under 10 ms, independent of sheet size |
| Work per received remote update (whole-doc encode on the socket path) | 131 ms | no whole-doc encode |
| One per-feature Yjs hook firing (whole-workbook conversion + grid scan) | about 50 ms, about 8 at once on mount and tab switch | proportional to the one field it syncs |
| Peer commits a formula | full grid rebuild on every other peer | no rebuild |
| Commit to paint, 198k cells (browser) | 819 ms | measured again in the browser after A1-A5 and C8, reported |
| Commit to a cell no formula refers to | every formula re-tokenized and its ranges walked (11 ms vs 2 ms at 500 `SUM(A:T)` formulas, teammate audit) | no formula pass (C8) |
| Session that only clears cells or removes a dropdown, conditional format or filter | never published | published (D6) |
| Ctrl+Enter fill; insert or delete cells with shift; a formula pasted as text into one cell | never saved, never sent to collaborators | saved and sent (B6) |
| Scroll p95 with one conditional-format rule (browser) | 65 ms (30 ms without the rule) | within 1 ms of the no-rule number |
| Owner typed edits after two structural remote changes within 50 ms | never saved for the rest of the session | always saved |

**Small sheet with history.** Simulated in Node: a 100-row x 10-column tab in today's format. Each "session" inserts a row near the top, fills 3 columns with colour, re-saves a dropdown column, saves one conditional format and types in 30 cells. Those are the write patterns the deep dive found. After 100 sessions the document holds 145,005 entries, 143,899 of them deleted. That is about the hidden history of the TEC-2932 sheet (190K deleted entries against 20 for a fresh copy).

| Cost today, old 100-row sheet | Value (Node) | Target after Stabilize |
|---|---|---|
| Package full encode per edit | 36 ms (fresh copy: 1.3 ms) | none per edit (A1) |
| App full decodes per edit (2 to 3 per persist drain) | 173 ms each (fresh copy: 3.2 ms) | none per edit (D0) |
| Publish cycle every 20 s while editing (about 10 whole-document passes, IPFS download) | about 1.7 to 2 s | one body read, gzip and encrypt; no download when the on-chain body is unchanged (D5) |
| Whole-UI re-render | on every scroll event, mouse move, keystroke in the cell editor, selection change, and twice per commit | the always-mounted toolbar, tab bar, menus and SVG definitions don't render on scroll, hover or commits that don't change their inputs; one context update per commit (E) |
| Borders, per draw | every border entry re-expanded, with a scan of all merges per row | cached; recomputed when borders, merges, hidden rows or columns, or the visible window change (C6) |
| Dropdown cells, per draw | each visible dropdown cell re-splits and de-duplicates its option list, O(L²) | parsed once per rule (C7) |

Stabilize does not remove history already in a document. The v2 upgrade in part 2 does, once the old copy is cleared at the end of its migration window (measured: 145,005 entries back to 1,003).

## 3. Non-goals

- No storage format change. Position keys (`"r_c"`), whole-value config keys and the stored calcChain stay as they are; old and new clients interoperate.
- Full grid rebuilds for remote batches over 50 cells and for structural remote changes (insert, delete, sort, paste) stay. `SURGICAL_CELL_LIMIT` stays 50.
- No change to how the formula engine builds its dependency graph (C8 only reads it), to computed values stored in Yjs, or to undo semantics beyond keeping remote edits off the local undo stack.
- The publish pipeline keeps its 20-second cadence, its order of steps, its gating and its on-chain transaction. D5 removes repeated whole-document passes and the download when nothing changed remotely; nothing else.
- No change to the collab wire protocol or connect-time downloads.
- No split of the engine's shared state. E keeps one Context and makes the heavy always-mounted components subscribe to the fields they use. Moving scroll position out of React state is left for later, because every overlay is positioned from it.
- No workers. Stabilize removes whole-document work instead of moving it. Where work should run off the main thread is a part 2 decision.
- No cleanup of `ps` keys already persisted into existing documents by the comment-marker bug that B4 fixes.

**Still open after Stabilize.** Stabilize closes the session-wide stall (B1), the dropped typed commits (B2), the never-saved actions (B6), unpublished clears (D6) and the publish and local-copy loss paths (D1-D4). These remain, and need part 2:

- Whole values, last writer wins: `cellFormatRanges`, the filter, the conditional-format list, the validation map and each whole cell. A format change can still overwrite a value a collaborator just typed.
- Insert or delete a row while a collaborator edits a cell below it: one of the two changes is lost.
- Structural edits stay expensive: inserting one row near the top of a 100k tab takes 309 ms, sends 6.4 MB, adds 0.94 MB to the document for good, and every peer rebuilds its grid.
- No recalculation after a collaborator's change: formulas a collaborator commits are not added to the local dependency graph, and a collaborator's edit triggers no local recalculation. The values shown are the ones the collaborator's client wrote.
- Open time: the Yjs load (333 ms at 100k) and the deep clone (183 ms) stay. A3 removes most of the per-hook conversion.

## 4. Design

### A. Stop whole-document work on every change

#### A1. Cheap change signal for hosts

New editor prop:

```ts
type DSheetContentChange = {
  hasContent: boolean;          // same meaning as dsheets.new isEmptySheet(...) === false
  userEdited: boolean;          // a local user edit has happened since this editor mounted
  fingerprint: string | null;   // base64 state vector + ":" + deleted count; changes on every change, deletes included; null until y-indexeddb is attached and synced
};
onContentChange?: (change: DSheetContentChange) => void;
```

Computed from the live Y.Doc without encoding the document:

- **hasContent:** false when the sheet array is empty; true when it has more than one sheet; otherwise true when sheet 0's config Y.Map has any key or its celldata Y.Map size is above 0. This mirrors `isEmptySheet` in dsheets.new `components/dsheet-editor/editor-utils.ts:30-62`. Cost is O(1) per sheet.
- **userEdited:** set by the first Yjs transaction whose origin is not `'self'`, `'remote'`, the IndexedDB provider, or the new `'init'` origin. The default-workbook seed in `editor/dsheet-editor.tsx:449` is tagged `'init'`.
- **fingerprint:** `base64(Y.encodeStateVector(doc)) + ":" + deletedCount`, where `deletedCount` is the total length of all deleted ranges in the document.
  - A tracker attached when the Y.Doc is created (`use-editor-sync.tsx:30`, before IndexedDB, the published-state merge and SyncManager can write to it) adds, in `afterTransaction` and with no origin filtering, the lengths in `tr.deleteSet` plus the lengths of GC structs the transaction newly integrated (store structs between `tr.beforeState` and `tr.afterState`, per client).
  - The string is built on demand, O(number of clients). Tracking costs about 0.0002 ms per ordinary edit at any history size, the walk over the structs it added included. On open the walk covers the whole body once: about 1 to 2 ms at 100k cells and about 1.2 ms on the 145,005-entry 100-row sheet (Node).
  - Compare with `===` only.
  - This started from Maitra's spec in this ticket's comments; where the two differ (GC structs, `fingerprintFromUpdate`, the `null` value, the upgrade rule in D6), this section is the one to build.

**Why not the state vector alone:** in Yjs a delete adds no new item, so `Y.encodeStateVector` does not change when a cell is cleared; a filter, dropdown, conditional format, named range or sub-sheet is removed; a config key is deleted; or a typed value is undone. Today's sheets write all of those as deletes (`editor/utils/update-ydoc.ts:308, 357, 371, 396-466, 481, 507, 526`). The publish check in dsheets.new (`utils/dsheet-body.ts:117`) compares vectors, so such a session is never published (D6). An encoded `Y.snapshot` would be correct, but it walks every entry ever written: 3.1 ms at 142k entries and 15.7 ms at 706k in Maitra's measurement, growing with every edit.

**Why the GC structs:** when a type with content is deleted (a sub-sheet, or a celldata map replaced whole), its children are stored as GC structs once compacted. A document loaded from such a body (IndexedDB compaction on open, a published body, a merged collab update) receives those children already deleted, so they never pass through `tr.deleteSet`. Counting `tr.deleteSet` alone then disagrees with `fingerprintFromUpdate` of the same content: 2 against 22 after deleting a 20-cell map.

**Verified in Node:** the count equals a full scan of the delete set (`Y.createDeleteSetFromStructStore`) in 400 randomized checks: two editors creating, replacing and deleting nested maps; garbage collection on and off; the live documents, a reopen from one compacted body, row replay in order and reversed, and merged rows. Counting `tr.deleteSet` alone was wrong in 171 of them. Two documents with the same content have the same fingerprint.

**`fingerprintFromUpdate(update)`** gives the same value for a stored body. It builds a temporary document, as today's `getDsheetStateVector` does (package `persistence.ts:23-38`), and adds one scan of its delete set (`Y.createDeleteSetFromStructStore`, under 1 ms at 100k cells). It therefore costs what that call costs today: about 235 ms at 100k cells and 90 ms on the 145,005-entry sheet (Node).

- **Not used:** reading it from the update without a document (`Y.encodeStateVectorFromUpdate` plus the delete ranges of `Y.decodeUpdate`). It is wrong for a merge of raw IndexedDB rows: a row written when the document received a compacted body carries that body's GC structs with no delete range, so the merge counts 1 deleted entry against 22 (Node test). At 100k cells it is also slower (380 ms).
- **Body reads:** they already build a document from every IndexedDB row (`readDsheetContent`, package `persistence.ts:104-120`; `mergeDsheetContent`, `:184-213`). Their snapshot (`snapshotDsheetDocument`, `persistence-utils.ts:92-103`) gets a `fingerprint` field computed from that document, one delete-set scan of under 1.5 ms. Checking a stored body then costs what today's vector check costs.
- **`DSheetEditorHandle.getContentFingerprint()`** returns the live value, or `null` until y-indexeddb is attached to the document and has synced. Before that the live document can be empty while IndexedDB holds the sheet: dsheets.new opens an existing sheet with IndexedDB sync off until its content arrives (`components/dsheet-editor/dsheet-editor.tsx:449-459`), and some of those states are READY. Callers then use the body read's fingerprint.

**Coalescing:** at most one call per 1,000 ms per editor (throttle with `leading: false, trailing: true`), flushed on `pagehide`, `beforeunload` and unmount. Local and remote changes share one throttle.

**Fired from:** every `handleContentPortal` call (today's `handleOnChangePortalUpdate`, `editor/contexts/editor-context.tsx:450`) and every remote apply in SyncManager (A2).

Full state stays available on demand through the existing `editorStateRef.getContentSnapshot()` (`editor/hooks/use-editor-sync.tsx:170-180`).

**Legacy `onChange(data, encodedUpdate)`** keeps working for hosts that pass it, with its throttle fixed:

- `flushPortalUpdate` (`editor-context.tsx:443-448`) stops calling `handleOnChange.flush()`. That throttle becomes trailing-only at 1,000 ms; its `flush()` runs only on `beforeunload`/`pagehide`/unmount. The other throttle it flushes, `onContentUpdate` (`:446-447`), keeps its per-edit flush: it encodes nothing, and ddocs.new saves its draft row from it (`components/dsheet/dsheet-page-content.tsx:1121-1125`).
- `onChange` is marked deprecated in the types. Both apps stop using it (dsheets.new in D0; ddocs.new already uses `onContentUpdate`).

#### A2. No whole-document encode per received update

SyncManager stops calling `Y.encodeStateAsUpdate(this.ydoc)` in the remote-apply paths (`sync-local/SyncManager.ts:1676-1682` and `:1726-1731`). The `onLocalUpdate` callback changes to `onRemoteApplied(update: Uint8Array)`; it receives the applied delta only.

`use-editor-sync.tsx:72-74` routes `onRemoteApplied` into the A1 notifier. If a host still passes legacy `onChange`, the full state is encoded once per coalescing window, not once per update.

#### A3. Per-feature Yjs hooks read one field

`getSheetYdocSyncContext` (`editor/utils/sheet-ydoc-sync-utils.ts:20-46`) stops calling `ySheetArrayToPlain`. New helper `readYdocSheetField(ydoc, dsheetId, sheetId, field)`: finds the sheet Y.Map by id and returns `toJSON()` of that one field (array/map) or the raw value.

The engine side reads `getWorkbookContext().luckysheetfile[i][field]` (or `config`) directly instead of `getSheet()`, which rebuilds the whole celldata array (`core/api/common.ts:79-85`).

Applies to every user of `getSheetYdocSyncContext`: `calc-chain-`, `config-`, `data-verification-`, `condition-format-`, `hyperlink-`, `filter-`, `filter-select-`, `live-query-list-`, `data-block-list-ydoc-update.ts`. Diff logic and written entries are unchanged.

#### A4. Remote formula-list changes apply in place

The observer (`editor/hooks/use-editor-data.tsx:396-693`) currently sends any `[sheetIndex, 'calcChain']` event to the final `hasStructural = true` branch (`:690-692`), so every formula a peer commits rebuilds the whole grid on every other peer.

New batch type for that path. It is applied through a new `WorkbookInstance.setSheetCalcChain(chain, { id })`, which:

- replaces that sheet's engine calcChain with the Yjs value, `noHistory`;
- resets the formula dependency indexes (`formulaCache.depsByCell`, `revDepsByCell`, `formulasWithWideRangeDeps`, plus `invalidateSheetsRequiredDenseCache()`) to the state a fresh mount has.

The result matches what the rebuild produced, without the rebuild.

**Undo history.** The rebuild also cleared the local undo stack (`globalCache`, `Workbook/index.tsx:219`); the in-place replace keeps it. Undo applies Immer patches (`:705`, `:776`) that address `calcChain` by index, so after a replace, undoing a local formula commit can truncate the new array (`calcChain.length = 2`) and drop a collaborator's formula. The calcChain hook then deletes that entry from Yjs for everyone (`editor/utils/calc-chain-ydoc-update.ts:56-66`). So:

- undo and redo never restore `calcChain` from patches: they re-register the restored cells from their `f`;
- the hook never deletes a chain key whose cell still holds a formula;
- test: commit a formula, receive a collaborator's formula, undo; the engine and the Yjs chain both keep the collaborator's entry.

**Follow-up, if measurements call for it:** with about 10 editors committing formulas, resets come close to continuously, and after each one the next local commit takes the full formula pass (C8 needs a complete graph). Then update only the graph edges of the chain entries that changed, since the change is already diffed to detect it, and reset only when that diff can't be computed.

#### A5. Remote cell batches apply in one quiet update

New `WorkbookInstance.applyRemoteCells(cells: { r, c, v }[], { id })`: one `setContext` with `noHistory: true`, calling `api.applyRemoteCellValue` per cell inside one draft. It replaces the per-cell `applyRemoteCellValue` loop (`use-editor-data.tsx:1114-1144`).

Today each remote cell is its own Immer produce and lands on the local user's undo stack (`Workbook/api.ts:272-280` uses `setContextWithProduce` without `noHistory`). After this change, local Ctrl+Z never undoes a collaborator's edit.

`patchPlainCelldata` (`use-editor-data.tsx:1008-1052`) builds one `"r_c" -> index` map per batch instead of a `findIndex` per changed key (45 ms for 50 cells at 100k today).

### B. Stop silent data loss

#### B1. Balanced remote-apply guard

`scheduleStructuralRemount` (`use-editor-data.tsx:737-769`) calls `beginRemoteApply` on every call but the debounced timer ends once. Two structural events within 50 ms leave `remoteUpdateRef` true for the session; the owner's typed commits are then never written.

**Fix:** call `beginRemoteApply` only when no remount is pending (`structuralRemountPendingRef.current === false`), so each pending remount owns exactly one begin and one end.

#### B2. Typed commits are written at commit time

`updateCell` (`core/modules/cell.ts:1901-1910`, `:2014-2023`) currently has no Yjs write of its own; it schedules `afterUpdateCell` with `setTimeout`, and `afterUpdateCell` returns before writing whenever `shouldExecuteDataBlocks` is false (`editor/utils/after-update-cell.tsx:517-523`).

**Fix, engine side:** `updateCell` emits the committed cell through `ctx.hooks.updateCellYdoc` inside the commit, for the sheet that holds the edited cell at commit time. This is the same hook every other engine write path uses. The value is converted from the Immer draft with `current()` before handing it over.

**Fix, editor side:** `afterUpdateCell` moves its `updateYdocSheetData` call ahead of the data-block gate. It uses a `sheetId` passed by the engine as a new fifth hook argument instead of reading `currentSheetId` when the timer fires. The write is idempotent (`skipIfEqual`), so the double path is harmless, and paths that only reach Yjs through `afterUpdateCell` (`api.setCellValue` with `callAfterUpdate`) keep working.

Paste and autofill stop delegating formula cells to `afterUpdateCell` for persistence. They include them in their own batch write (`core/paste/paste-internals.ts:1901-1910, 1953`; `core/modules/dropCell.ts:2380-2388, 2508-2516, 2632-2640, 2746-2754`, one per fill direction).

Data-block gating (`shouldExecuteDataBlocks`, `localUserEditRef`) is unchanged and now gates only data-block work.

#### B3. Structural remote change during a cell edit is deferred, not dropped

Today, when the remount timer fires while the local user is editing a cell, the remount is skipped and the pending flag cleared (`use-editor-data.tsx:744-766`); the engine keeps stale data until some later remount.

**Fix:** while editing, re-arm the timer (250 ms) and keep the pending flag; remount once the edit ends. Do **not** hold the remote-apply guard while the remount is deferred. The guard makes `handleChange`, `guardRemoteEcho` and `afterUpdateCell` return early, so holding it across the edit drops the commit's `onChange` and the remount then rebuilds from Yjs without the user's edit. B1's single begin is kept: the guard begins once right before the remount runs and ends after paint.

Consequences, accepted: while the remount is deferred, every remote surgical event on that tab is folded into the pending remount (the editing tab shows no remote change until the edit ends), and a local commit made in that window is written at the coordinates the tab had before the structural change.

**Implemented in 1587101.** Browser check: the editor kept the typed text while a row was inserted from another tab; after Enter the row arrived and the edit was saved on both tabs.

#### B4. Comment markers never write into Yjs objects

`ySheetArrayToPlain` (`editor/utils/update-ydoc.ts:608-725`) returns cell objects that are the Yjs content itself (`Y.Map.toJSON` returns stored references). `applyCommentMarkers` (`editor/utils/apply-comment-markers.ts:116-124`) writes `entry.v.ps` into them, including `ps = undefined` on every uncommented cell. That leaks into every later full-state encode while no update reaches peers.

**Fix:** `applyCommentMarkers` touches only cells that have a comment, and replaces the array entry with a copy (`celldata[i] = { ...entry, v: { ...entry.v, ps } }`) instead of mutating it. `ySheetArrayToPlain` is documented in its signature type as returning shared, read-only objects.

#### B5. Inserting or deleting rows shifts only references to that tab

`functionStrChange(txt, type, rc, orient, stindex, step)` (`core/modules/formula.ts:5404`) has no tab parameter. `functionStrChange_range` (`:4821`) splits off a `Sheet!` prefix but never compares it with anything.

`rowcol.ts` applies it to every formula on every tab (`:493` for the edited tab, the other-tab branch at `:518`). So inserting a row on tab A also shifts, on tab B, references to B's own cells and to a third tab C, and, on tab A, references to other tabs. Those formulas then point one row off.

**Fix:**

- Callers pass the edited tab's name and the formula's own tab name (`rowcol.ts:244, 493, 518, 533, 558, 1925, 1947, 1963, 1985`).
- A reference shifts only when it points at the edited tab: its prefix names that tab, or it has no prefix and the formula is on that tab.
- Prefixes are compared unquoted (`'My Sheet'!A1` names My Sheet) and exactly, as the engine resolves tab names: case-sensitive (`getSheetIdByName`, `core/utils/index.ts:131-138`).

**Implemented (8b18a94); case rule fixed in Task 17 (782aacd):** `functionStrChange` takes `tabs: { editedTab, formulaTab }` as its last argument and the tokenizer keeps a quoted tab name in one token. The comparison was first shipped case-insensitive; Task 17 (782aacd) made it exact and case-sensitive, matching this section.

Part 2 removes this rewrite altogether (formulas store row IDs).

#### B6. Actions that never reach Yjs

- **Ctrl+Enter fill:** `fillSelectionWithActiveValue` (`core/modules/selection.ts:3715`, called from `core/events/shortcuts-v2.ts:263`) writes the engine grid only.
- **Insert cells and shift right or down, delete cells and shift left or up:** `applyInsertCellsShift` and `applyDeleteCellsShift` (`react/components/ContextMenu/index.tsx:67-165`) move cells in the engine grid and call `jfrefreshgrid`, which writes nothing to Yjs.
- **A formula pasted as text into one cell:** clipboard text that starts with `=` goes to `handleFormulaStringPaste` (`core/paste/paste-internals.ts:2169-2197`, from `clipboard-entry.ts:162`, `:265`). It writes the engine grid and calls `afterUpdateCell` only for a data-block result, so an ordinary formula is never written to Yjs.

**Effect:** collaborators never see these changes, and a reload or the next grid rebuild from Yjs drops them.

**Fix:** after changing the grid, each writes the changed range through the range-diff writer that row insert already uses (`emitCellRangeToYdoc`, `rowcol.ts:169`), in the same update. Formula references to the shifted cells are not rewritten, as today. The single-cell formula paste writes its cell through `ctx.hooks.updateCellYdoc`.

### C. Engine hot spots

**C1. Text-measure cache.** `getMeasureText` reads `${value}_${font}` (`core/modules/text.ts:202`) but writes `${value}_${zoomRatio}_${font}` (`:298`), so it never hits. Use one key builder for both, including zoom and `renderCtx.textBaseline`: the cached ascent and descent depend on the baseline (`text.ts:245-259`), and the canvas measures under top, middle, bottom and alphabetic.

**C2. Conditional-format result cache.** `getComputeMap` (`core/modules/ConditionFormat.ts:1926-1964`) recomputes every rule over its full range on every draw (`core/canvas.ts:801`), four times per repaint with frozen panes.

- Cache the result per sheet, keyed by the identities of `data`, `luckysheet_conditionformat_save` and `conditionRules`, plus `conditionFormatDraftActive` and the draft selection when a live preview is active.
- Two kinds of rule read more than that:
  - A formula rule runs `execfunction` per cell (`ConditionFormat.ts:1816-1841`) and can reference other tabs, so when a sheet has one, the key also includes the identity of `luckysheetfile`, which changes whenever any tab's data does.
  - A date rule compares with today (`getLocalTodaySerial`, `:292-294`), so when a sheet has one, the key also includes today's date.
- Immer gives new identities on any change, so the cache is exact. Scrolling no longer recomputes.

**C3. Formula-list copy only when needed.** `delFunctionGroup` (`core/modules/formula.ts:1494`, `:1516`) deep-clones `calcChain` and `dynamicArray` on every call, including every plain-value commit and every remote cell. Find the index first; splice the draft only when found.

**C4. Crypto-banner scan.** The effect at `react/components/Workbook/index.tsx:841-899` rebuilds the whole celldata array on every selection change to look for BTC/ETH/SOL. Run it on data identity changes only, deferred to idle time; the selection hook call stays on selection changes.

**C5. Paste auto-fit without per-cell layout.** `calculateRangeCellSize` (`core/paste-helpers/calculate-range-cell-size.tsx:87-140`) forces one browser layout per pasted cell.

- Single-line cells: measure with canvas `measureText` and a (font, text) cache, using the font the grid draws with.
- Wrapped cells: keep DOM measurement, batched as all writes then one read pass.

Note: today's code measures with the wrong font (`ff` index used as a family name, `fs` points used as pixels, `:36-37`), so some auto-fit widths change slightly. They now match what the grid draws.

**C6. Borders per draw.** `getBorderInfoComputeRange` (`core/modules/border.ts:7-1519`) re-expands every `borderInfo` entry on every draw. Inside the per-row loops it runs `Object.keys(cfg.merge).forEach` (`:124-135, :177-188, :227-238, :281-292`), so the cost is entries x rows x merges per frame. `borderInfo` only grows (`toolbar.ts:1902-1910`), so this cost grows with every border click.

- Build a merge lookup (cell key to merge rectangle) once per `config.merge` identity; the per-row check becomes a map lookup.
- Cache the computed border map per sheet, keyed by the identities of `borderInfo`, `merge`, `rowhidden` and `colhidden` plus the drawn row and column bounds.
- Keep one entry per pane: up to four with frozen panes, since each pane is drawn with its own bounds.
- Redraws for selection moves, edits and remote cells reuse the entries.

`borderInfo` growth itself is unchanged here; part 2 stores borders as entries with IDs.

**C7. Dropdown cells per draw.** For every visible cell with validation, the canvas calls `validateCellData` (`core/canvas.ts:2088-2091`), which calls `getDropdownList` (`core/modules/dataVerification.ts:70-114`). That re-splits the option text and de-duplicates with `list.includes`, O(L²) per cell per frame; dropdown cells also `split(',')` again at `canvas.ts:2004`.

- Cache the parsed list and a Set of its values per option text. When the options come from a cell range, the cache key also includes the identity of the source sheet's data.
- `validateCellData` checks membership with the Set. The canvas keeps its own `split(',')` for pill colours, because colours are picked by position, and memoizes it per option text.

**C8. No formula pass for a cell nothing depends on.**

**Implemented (fb80dfc, a324b38).** The skip runs only when `depGraphComplete` is true. Because only forced passes complete the graph, a dependency-only warm-up (`formula-warmup.ts`) runs in idle slices after open and publishes its edges into shadow indexes that are merged only when the whole warm-up finishes, so a partial graph never narrows a commit. Task 16 (627aeda): the narrowing added at commit 1611aee (July) used to apply on `revDepsByCell.size > 0` while the flag was false, which could leave a never-evaluated formula stale. It now narrows only when `depGraphComplete` is true. Sheets where the flag never turns true (for example a sparse tab holding a formula) run the full list on every commit: slower, correct (S15, 500 formulas: 0.211 ms to 3.897 ms; flag-true sheets 0.155 ms to 0.158 ms).

Today the commit-time pass (`core/modules/formula.ts:2466-2518`) narrows the formula list to the edited cell's dependents only when the graph has entries and the dependents set is not empty. Otherwise it processes every formula: a commit to a cell no formula refers to re-tokenizes every formula and walks every referenced range. The teammate audit measured 11 ms against 2 ms at 500 `SUM(A:T)` formulas; it grows with formulas times range size.

The graph is filled only as formulas are evaluated, so right after open it is empty and every commit takes the full pass.

Only a forced pass (`isForce`) evaluates every formula: `recalculateAllFormulas` after an import, and the row and column drag rebuild. A normal pass evaluates only the formulas whose references hit the changed cells, plus their dependents (`:2810-2818`). Nothing runs a forced pass on open, so a flag that waits for one would stay false for the whole session.

**Change:** a `depGraphComplete` flag in `formulaCache`, set once the reverse index covers every formula in the chain. After open, in idle time, the index is built from the formula text, without evaluating anything. Ranges up to 10,000 cells add edges and wider ones go to `formulasWithWideRangeDeps`, as `execfunction` records them. Until it finishes, commits take today's path.

**The index needs its own reference tokenizer.** The parse the normal pass runs for every formula (`:2591-2819`) is not the one `execfunction` records from (`recordDep`, `:395-399`, called from `callCellValue`, `callRangeValue` and `callVariable`, `:414-640`), and it misses references:

- every reference in a formula containing `INDEX(`, `INDIRECT(` or `OFFSET(`. Those go to `isFunctionRange` (`:2604-2623`), which reports only quoted references, so `=INDEX(A1:A100,5)` gives no edges;
- a reference next to a space. Tokens are split on operators and checked untrimmed (`:2710-2740`), so `=SUM(A1, B1)` loses B1 and `=A1 + B1` loses both;
- a reference whose unquoted tab name contains a split character, such as `Q1-2026!A1`.

The same misses are an existing bug. Right after open, while the graph is empty, the normal pass evaluates only the formulas whose parsed references hit the changed cell (`:2796-2849`), so editing B1 leaves `=SUM(A1, B1)` stale (read from the code). The new index fixes it.

- The builder must not load other tabs' data: `getcellrange` hydrates every demoted tab a formula references (`:925-927`).
- Checked against what `execfunction` records: same-tab cells and ranges, quoted tab names and named ranges give the same edges. Tab names match exactly, case-sensitive.
- **Rejected:** a forced pass on open. It would re-run network and time-dependent formulas (data blocks, prices, `NOW`) on every open and write their results.

**When the flag turns false.** Whenever the indexes are reset (mount, A4, structural changes) and whenever a formula enters the chain without going through `execfunction`:

- a remote cell batch (`api/cell.ts:248-329` only registers it);
- an HTML-table paste (formula cells are written raw and never added to the chain, `paste-internals.ts:519`);
- a cut-paste, which moves formula cells without updating the chain or evaluating them (an existing bug).

Copy-paste and the text pastes evaluate their formulas (`execfunction` at `:1859`, `handleFormulaOnPaste`, `handleFormulaStringPaste`) and leave the flag as it is. While it is true and the edited cell has no dependents, the pass is skipped.

- A formula committed locally records its own dependencies when it is evaluated (`execfunction`, `formula.ts:1805-1852`), so local formula edits keep the graph complete.
- **Very large ranges and named ranges.** Formulas over very large ranges (over 10,000 cells, `MAX_RANGE_DEPS`, `:478`, `:628`) record no edges on the main thread and are added to every commit's dependents (`:2478-2480`); so are formulas using a named range that covers the edited cell (`:2481-2513`). Both are added after the transitive walk (`collectTransitiveFormulaDependents`, `:2474`), so once the graph has entries their own dependents are never reached. With `B1 = SUM(A1:Z1000)` and `C1 = B1*2`, editing A5 recalculates B1 and leaves C1 stale (read from the code; an existing bug). C8 fixes it: one walk, seeded with the edited cell and those formulas. Formulas evaluated in the formula worker record an edge per cell instead, with no cap (`formula-snapshot-eval.ts:172-181`); the index follows the main-thread rule.
- **References resolved while a formula runs.** INDIRECT and OFFSET aren't in the engine's function library (`@fileverse-dev/formulajs` 4.4.55), so they give `#NAME?` and record nothing. INDEX's range argument is recorded whole. So the graph misses nothing today; the C8 tests pin it, and adding INDIRECT or OFFSET later means recording what they resolve to.

### D. App save and publish (dsheets.new)

#### D0. Adopt the change signal (A1)

`components/dsheet-editor/dsheet-editor.tsx:538` switches from `onChange` to `onContentChange`. `persistDocumentChanges` (`hooks/use-dsheet-editor.tsx:969-1111`) maps its guards:

| Today (decodes the whole document) | After |
|---|---|
| `content === lastPersistedEncodedRef.current` | `change.fingerprint === lastPersistedFingerprint` (a state vector alone would miss clear-only changes, A1) |
| `isEmptySheet(rawContent) && shouldBlockPublishForEmptyContent(content)` | `!change.hasContent` |
| temp / title-only guard: `hasEncodedDeltaFromMount`, `shouldBlockTempSheetBodyPersist` with base64-length bands | `change.userEdited` |
| `isSheetEmptyWithFallback(dsheetId, existingDoc.content)` per drain (only feeds the title-only guard) | removed; `change.userEdited` covers the title-only case |
| `shouldBlockPublishForEmptyContent(content)` after success | `!change.hasContent` |

`handleChanges` (`:1115-1145`) and the temp-baseline refs that exist only for the base64-length heuristics are removed.

`rtc-provider.tsx:683-747`: the "already enabled for this room key" early return moves ahead of the `isSheetBodyEmpty` read (`:715`), so a `lastUpdated` bump no longer triggers a full body read. That return then also skips the branch that turns collab off when there is no local body (`:718-729`), which is harmless: while collab is on for that room key, a local body exists.

#### D1. Publish waits when the remote merge fails

`fetchAndMergeRemoteSheetContent` (`utils/sheet-pre-publish-merge.ts:63-121`) returns `null` both when there is no remote body and when fetching or merging threw; the caller (`components/providers/onchain-sync-provider.tsx:255-258`) ignores it and publishes the local body.

**Fix:** return `{ status: 'none' | 'merged' | 'failed' }`. On `'failed'` the cycle skips the publish through the existing `skipGatedPublish` and backoff path.

#### D2. A body read timeout is "unknown", not "clean"

`hasUnpublishedSheetChanges` (`utils/dsheet-body.ts:99-118`) returns false when the body read is not `'ready'`, so a sheet whose read keeps timing out is never published and nothing is logged.

**Fix:** return `'dirty' | 'clean' | 'unknown'`. `'unknown'` keeps the sheet in the retry/backoff cycle. After 3 consecutive unknowns, send one Sentry message per sheet per session with the body status.

After D6 the open sheet's dirty check reads no body. This rule then covers background sheets (D5 step 1) and the publish's own body read.

#### D3. IndexedDB heal never deletes the live document's only local copy

`components/dsheet-editor/dsheet-editor.tsx:248-259` listens to every `unhandledrejection`. On a matching message it deletes the sheet's y-indexeddb database (resolving on `onblocked`, `utils/yjs-indexeddb-heal.ts:20-30`) and remounts, losing local edits that were never published.

**Fix:**

- New package handle method `rebuildLocalStore()`: destroy the provider, delete the database, attach a new provider to the same live Y.Doc. The new provider stores the full live state, so nothing in memory is lost.
- The app's handler calls it instead of deleting and remounting.
- The app also passes `onIndexedDbError` (today unset, so failures are only console.errored in `use-editor-sync.tsx:110-118`) and reports to Sentry.

#### D4. "Already confirmed" does not mark unpublished edits as published

When an earlier transaction confirms late, `submitOnChainTransaction` returns `already_confirmed` without uploading (`utils/file-utils.ts:510-523`). The provider still stores the current body's state vector as `lastPublishedSnapshot` (`onchain-sync-provider.tsx:375-407`), so later checks see no change.

**Fix:** on `already_confirmed`, do not write `lastPublishedSnapshot`. The next cycle sees the body as dirty and publishes it.

#### D5. Publish without repeated whole-document passes

Today, each 20-second cycle (`components/providers/onchain-sync-provider.tsx:242-336`) does about 10 to 12 whole-document passes:

- a dirty-check read (`hasUnpublishedSheetChanges`, `utils/dsheet-body.ts:99-118`);
- in `fetchAndMergeRemoteSheetContent` (`utils/sheet-pre-publish-merge.ts:63-121`):
  - the full IPFS download;
  - a local read and an empty check;
  - a merge in two temporary documents (`:17-39`);
  - `mergeRemoteIntoSheetBody`, which writes a full-copy IndexedDB row (package `persistence.ts:184-213`);
- a second body read (`onchain-sync-provider.tsx:264`);
- `stateVectorOf(body)`, a decode and apply just to get a vector (`:293-294`);
- another empty check inside `preparePublishFileCallData` (`utils/file-utils.ts:809`).

On an old 100-row sheet that is about 1.7 to 2 s of main-thread work every 20 s while editing (section 2).

Changes, keeping the cycle's steps, order and gates:

1. **Dirty check from fingerprints (D6).**
   - The sheet open in the editor: its live fingerprint against `lastPublishedFingerprint`. No body read. While `getContentFingerprint()` is `null` (y-indexeddb not attached and synced yet), the open sheet is checked like a background sheet.
   - Sheets not open in an editor (background sync): the body read's fingerprint (A1) against `lastPublishedFingerprint`. Today's check already rebuilds the document from IndexedDB to get its vector: about 340 ms at 100k cells and 100 ms on the 145,005-entry sheet (Node). The fingerprint adds under 1.5 ms to that read. Computed from the encoded body instead, it would add about 380 ms at 100k cells.
   - A title change still counts as dirty, and a sheet never published is still dirty.
   - The state vector alone stays only where it is right: the remote merge in steps 2 and 3.
2. **No download when the on-chain body is unchanged.**
   - The on-chain read returns `contractFileData.metadataIPFSHash` before any IPFS download (`utils/decryption-utils/decrypted-dsheet-content.ts:165-205`).
   - The Dexie row records that hash after each successful merge, including the merge when the sheet opens (`loadOnChainContent`, `components/dsheet-editor/hooks/use-dsheet-editor.tsx:466-648`). It also records the hash a publish uploaded, once that publish is confirmed.
   - When the current on-chain hash equals the recorded one, the cycle skips the download and the merge. `fetchAndMergeRemoteSheetContent` returns a new status, `'unchanged'` (added to D1's statuses).
   - A different or missing hash takes today's path.
3. **When the remote did change, merge only what is missing.**
   - `Y.diffUpdate(remote, localStateVector)` works on the encoded updates without building documents.
   - The result is stored as one IndexedDB row by a new package helper, `appendDsheetUpdate(dsheetId, update)`. This replaces `mergeYjsSheetContent`'s two temporary documents and `mergeDsheetContent`'s full-copy row.
   - The upload body becomes `Y.mergeUpdates([localBody, delta])`, so no second read is needed.
4. **One body read per cycle.**
   - A single `readSheetBody` supplies the body, its state vector (`snap.stateVector`, already returned), its fingerprint (`snap.fingerprint`, new in A1) and its emptiness (`snap.status`).
   - `stateVectorOf(body)` is dropped. What a publish stores follows D6, which builds a document only in cycles where the remote changed. `preparePublishFileCallData` gets a flag saying the body was already checked as non-empty, and skips its own decode.

**Result:** when the sheet has changes and the on-chain body is unchanged, a publish costs one IndexedDB read, gzip and encryption. When the remote changed, it adds the download and one diff.

ddocs.new: its sheet publish path was not traced in the deep dive and is not changed here. Checking it for the same repeated passes is a separate item.

#### D6. Clear-only sessions are published

Today `hasUnpublishedSheetChanges` (`utils/dsheet-body.ts:117`) calls a sheet dirty when the body's state vector differs from the one last published. A delete does not change a Yjs state vector (A1), so a session that only clears cells, removes a filter, dropdown, conditional format, named range or sub-sheet, or undoes a typed value is never published. The change stays local until some later edit adds content.

**Fix:** `lastPublishedSnapshot` stores the A1 fingerprint instead of the state vector (`lastPublishedFingerprint`).

- Dirty = never published, or the title changed, or the current fingerprint differs from `lastPublishedFingerprint`. D5 step 1 says where the current one comes from.
- **What a publish stores.**
  - A publish of the sheet open in the editor takes the fingerprint (`getContentFingerprint()`) before its body read, and stores that value when the publish confirms, never a later one. Edits made after it keep the sheet dirty.
  - A publish of a sheet not open in an editor, or open while `getContentFingerprint()` is still `null`, stores the fingerprint of the body it uploaded: the body read's own, or, when D5 step 3 merged a remote delta into the upload, `fingerprintFromUpdate` of the merged body. Today every publish builds a document for that vector (`onchain-sync-provider.tsx:292-294`); after this, only cycles where the remote changed do.
- **Fresh read.** The body read must be an IndexedDB read opened after the fingerprint was taken, so it can't reuse a read already in flight. `readDsheetContent` hands back a pending read for the same sheet (package `persistence.ts:166-181`), and the edit-time persist, RTC resume and Ctrl+S read the body too; the publish uses a fresh read. y-indexeddb starts each update's write as soon as the update happens (`y-indexeddb.js:107-110`), and IndexedDB runs overlapping transactions in order, so the body then holds everything the fingerprint covers.
- Collaborators' changes count, deletes included, as today's vector check does for their additions. A reload needs no extra state: the fingerprint is rebuilt from the document as it loads.
- **Every writer stores fingerprints.** Besides the publish paths, the open-time load stores the on-chain body's state vector on every open (`components/dsheet-editor/hooks/use-dsheet-editor.tsx:576-583, :616-622`); it stores `fingerprintFromUpdate` of that body instead, at the cost of today's `stateVectorOf`. It also stores the local title as the published title, which marks an unpublished rename as published on open; it stores the on-chain title instead.
- The other places that write or derive a published vector follow the same rules:
  - `publishSheet` (`utils/dsheet-utils.ts:100-270`, body read at `:125`) and the folder publish (`components/folders/folder-publish-queue.ts:262-350`) follow the publish rules above;
  - the legacy backfill (`utils/dsheet-snapshot-backfill.ts:68-81`) and the dirty check's legacy fallback (`utils/dsheet-body.ts:106-110`) use `fingerprintFromUpdate(lastPublishedContent.content)`.
- **Upgrade.** Values stored by older versions are bare state vectors. A bare vector is compared with the body's vector, as today, until the open-time load replaces it with the on-chain body's fingerprint. No sheet publishes again only because of the upgrade. Until a sheet is opened once, a clear-only change made before the upgrade stays unpublished, as it would today.
  - **Rejected:** replacing a matching bare vector with the local body's fingerprint, which marks such a clear as published.
- D4's `already_confirmed` case stores nothing.
- **Not covered:** ddocs.new has its own vector-only checks (`components/dsheet/dsheet-page-content.tsx:832-836`, `utils/workspace-file-publish-adapter.ts:628-633`) and edits some sheets with no y-indexeddb at all (viewer-edit invitees), where only the live fingerprint works. A separate item.

**Rejected:** a change counter kept in Dexie. It isn't derived from the document, needs a list of origins to ignore, and loses a change whose counter write doesn't land before the page closes.

### E. Fewer whole-UI re-renders

The engine keeps all UI state in one Context. The provider value changes on every update (`react/components/Workbook/index.tsx:901-918`), and 51 components read it with `useContext`, none wrapped in `React.memo`. This cost doesn't depend on sheet size, so small sheets pay it in full on every interaction:

- **Scroll:** every scroll event updates the context (`SheetOverlay/ScrollBar/index.tsx:33-43`).
- **Mouse movement:** every move over the grid runs a context update, and inside it `getElementsByClassName` plus `getBoundingClientRect`, which forces a layout (`SheetOverlay/index.tsx:418-456`).
- Selection changes and typing in the cell editor.
- **Commits, twice:** after each commit, NotationBoxes scans the whole grid for shown comments and runs a second context update (`NotationBoxes/index.tsx:16-32`).

The teammate audit measured scroll at a 16.6 ms median on a sparse sheet: inside a 60 Hz frame on a fast machine, but with no margin. Nothing has been measured on slower devices yet.

Changes:

**E1. Hover updates only when something changes.**

- Compute the hovered cell from the mouse event outside the state update, reading the cell area's position once per animation frame.
- Call `setContext` only when a drag, resize or selection is in progress (the `globalCache` flags `handleOverlayMouseMove` already reads), or when the hovered cell or link card actually changes.

**E2. Heavy chrome subscribes to the fields it uses.**

- A new `useWorkbookSelector(selector, isEqual)` hook reads from a small store that Workbook updates after each context change (`useSyncExternalStore`).
- Converted and wrapped in `React.memo`: Toolbar, SheetTab (and its items), ContextMenu, FilterMenu, SheetTabContextMenu, FunctionList. SVGDefines gets `React.memo` only; it reads no context, only a `currency` prop (`SVGDefines.tsx:19`).
- The other consumers stay on `useContext` for now.

**E3. A stable editor handle.**

- `useImperativeHandle` (`Workbook/index.tsx:1997-2020`) depends on `context`, so the whole instance (`generateAPIs`, about 100 functions) is rebuilt on every change, and the host's ref callback (`editor/contexts/editor-context.tsx:393-409`) re-runs each time.
- `generateAPIs` (`Workbook/api.ts`) reads the context through a ref instead, so the handle is built once and doesn't need `context` in its dependencies.
- **One caller relies on the ref callback re-running.** Since the baseline, the package calls `activeSheetKeeper.onAttach` from it on every attach (package fileverse/ddocs.new#452; `editor-context.tsx:423` at origin/main, `editor/utils/active-sheet-keeper.ts`) to remember the active tab and restore it after a remount. With a stable handle it would run once per mount, often before the sheets load, and stop working. E3 calls it instead when the active sheet changes and once a new mount has sheets.

**E4. Listeners and memos that rebuild on every change.**

- The document paste listener (`onPaste`, `Workbook/index.tsx:1619-1756`, bound at `:1763-1768`) is removed and re-added on every context change, because `context` is in its dependencies; bind it once and read state through a ref.
- Narrow the memo dependencies of `getToolbarItem` (`Toolbar/index.tsx:2145-2182`) and the function list (`FunctionList/FunctionListButton.tsx:260-298`) to the fields they use.

**E5. One context update per commit.** NotationBoxes calls `showComments` only when the set of shown-comment cells differs from the last one it applied.

**E6. No forced layout on render.** SheetOverlay reads `innerText` of two editable elements on every render (`SheetOverlay/index.tsx:253-254`); it reads them only while a cell is being edited.

Scroll still updates the context and re-renders the overlays that position themselves from it. That is the remaining fixed cost, left for later (section 3).

### F. Format gate for the part 2 upgrade

Decided by Nadeem on 2026-10-23 (YSheetStore open question 7).

Part 2 (Decision 7) needs every running client to respect a format version before any sheet is upgraded. Shipping the check here makes it live in both apps long before that, which shortens the window in which old clients can still edit upgraded sheets.

The editor reads key `format` (a number) of the top-level Y.Map `` `${rootKey}/meta` ``, where `rootKey` is the name the package passes to `getArray` today (`dsheetId`). It reads it on open and observes it while the sheet is open. Today's sheets have no such map, which means version 1. Part 2 (Decision 1) is bound to this exact name.

If `format` is above the highest version the client supports, the editor:

- stops writing to the sheet: the grid turns read-only and the Yjs write helpers return without writing;
- shows "This sheet was updated. Reload to continue."

Observing matters as much as the check on open: a collaborator can upgrade the sheet while this client has it open. Edits this client made before the change reached it are ordinary v1 writes; part 2's v1 inbox handles them.

Cost: one map read on open and one observer. No data changes, so today's sheets are unaffected.

ddocs.new gets it with the package version bump.

## 5. Interfaces changed

| Package export | Change | Compatibility |
|---|---|---|
| `DsheetProps.onContentChange` | new | additive |
| `DsheetProps.onChange` | throttle now trailing 1 s, flushed only on unload; deprecated | behavior change for hosts that relied on per-edit calls (none in our apps after D0) |
| `afterUpdateCell` hook | new fifth argument `sheetId` | additive |
| `WorkbookInstance.applyRemoteCells`, `setSheetCalcChain` | new | additive |
| `DSheetEditorHandle.rebuildLocalStore` | new | additive |
| `appendDsheetUpdate(dsheetId, update)` (persistence entry) | new | additive |
| `WorkbookInstance` identity | built once per mount instead of on every change (E3) | hosts that relied on getting a new handle per change stop getting one; the package's own active-sheet keeper is one (E3); both apps to be checked during implementation |
| SyncManager constructor option `onLocalUpdate(fullState, chunk)` | replaced by `onRemoteApplied(update)` | internal to the package |
| `lastPublishedSnapshot` in the Dexie sheet row (dsheets.new) | stores the fingerprint instead of the state vector (D6) | older bare vectors are compared as today until the open-time load replaces them |
| `DSheetEditorHandle.getContentFingerprint()`, `fingerprintFromUpdate(update)` | new; the live value is `null` until y-indexeddb is attached and synced | additive |
| `DSheetContentSnapshot.fingerprint` (from `readDsheetContent` and `mergeDsheetContent`) | new (A1) | additive |
| Format gate on `meta.format` | new (F) | no effect on today's sheets |

**Release:** package minor version. Then dsheets.new adopts it with D0-D6. ddocs.new bumps the version with no code change (A2-A5, B, C and F apply automatically). No Yjs data change, so mixed-version sessions work; clients still on the old version keep the data-loss bugs that B1 and B2 fix until they update.

## 6. Verification

**Benchmarks, before and after, reported in the PR:**

- The Node benchmark harness, extended with the A1 summary and A3 single-field reads.
- A demo-app script on a 100k-cell sheet: commit-to-paint for one cell, handling time for one received remote update, scroll p95 with and without one conditional-format rule, a 10k-cell paste.
- The small-sheet benchmark: per-edit and per-publish whole-document work on the old 100-row sheet.
- A 100-row reference sheet with dropdown columns, borders, fills and conditional formats, in the demo app with React Profiler, on a mid-range laptop with 4x CPU throttling:
  - render count and time per scroll frame, mouse move, arrow key, keystroke and commit;
  - which components rendered.
- One or more of the sheets users reported as lagging, profiled before and after, if the owners can share them.

**Unit tests (vitest), written before the fixes, for the pure pieces:**

- **B1:** begin/end stay balanced for 1, 2 and 5 structural events inside one debounce window; depth returns to 0.
- **A1:** `hasContent` matches the app's `isEmptySheet` on fixtures (empty, one cell, config only, two sheets); `userEdited` ignores `'self'`, `'remote'`, provider and `'init'` origins.
- **B4:** after `applyCommentMarkers` on the output of `ySheetArrayToPlain`, the Y.Doc's encoded state is byte-identical to before.
- **C1:** the second measure of the same text and font is a cache hit; a different zoom or baseline is a miss. **C2:** a cache hit when identities are unchanged, a miss when any keyed identity changes; with a formula rule, a change on another tab misses; with a date rule, a new day misses.
- **D1/D2/D4:** result mapping (`'failed'` and `'unknown'` skip the publish; `already_confirmed` writes no snapshot).
- **D5:**
  - an unchanged on-chain hash skips the download; a different or missing hash downloads;
  - the delta row plus the local rows replay to the same document as today's full merge;
  - `mergeUpdates([localBody, delta])` decodes to the same content as today's re-read body.
- **C6/C7:** cache hit when the keyed identities and window are unchanged, miss when any changes; with frozen panes, all four panes hit on a repeat draw; dropdown validation gives the same result as today on a table of inputs, including multi-select and range-based options.
- **E1/E5:** no context update for a mouse move within the same cell with no drag in progress; no `showComments` update when the shown set is unchanged.
- **A1/D6:**
  - the fingerprint changes on a delete-only transaction and on a remote one, and not on an empty transaction or a delete of a missing key;
  - after a reload, including a reopen from a compacted body after a sub-sheet delete, it equals `fingerprintFromUpdate` of the stored body, the body read's fingerprint, and `fingerprintFromUpdate` of a merge of raw IndexedDB rows, one of which received such a body;
  - with y-indexeddb not attached, `getContentFingerprint()` is `null` and the check uses the body;
  - a clear-only session is dirty; an edit during a publish keeps the sheet dirty after it confirms, even when another body read was in flight; a collaborator's clear makes the owner's sheet dirty; a background publish after a remote merge leaves the sheet clean;
  - a sheet with a bare stored vector is not republished by the upgrade, and the open-time load replaces the vector with the on-chain fingerprint and title.
- **C8:** after open the index is built without evaluating any formula and the flag turns on; then a commit to an unreferenced cell processes no formula, and the grid equals a forced full pass, on fixtures with INDEX, references next to spaces, unquoted tab names with `-`, named ranges, very large ranges and a formula that depends on a very-large-range formula. On the same fixtures the index holds every edge `execfunction` records. A remote batch and an HTML-table paste turn the flag off; a copy-paste doesn't.
- **B5:** inserting a row on tab A shifts references to A on every tab, and leaves references to B's own cells and to a third tab alone, including quoted tab names; a reference whose tab name differs only in case is left alone, as the engine doesn't resolve it to that tab.
- **F:** a client with the sheet open stops writing and shows the prompt when `meta.format` becomes 2.

**Repro tests that fail before and pass after:**

- **B1:** two structural remote transactions 10 ms apart, then an owner commit; the cell is in Yjs.
- **B2:** two joiner commits in one tick both reach Yjs; a tab switch between commit and timer writes to the original sheet.
- **B6:** Ctrl+Enter fill, insert cells with shift, delete cells with shift, and `=1+1` pasted as text into one cell; after a reload and on a second client, the cells match.

**Manual QA plan** (for non-developers, written with the implementation plan): owner and collaborator in two browsers; typing during a peer's paste and insert; formula entry by both; reload and compare; publish with the network cut mid-merge; on a 100-row sheet with dropdowns, borders and fills, scrolling, hovering, typing and choosing dropdown values, then publishing and reopening on another device.

Integration glue (prop wiring, hook plumbing) gets no new unit tests of its own.

## 7. Risks

- **B2** changes when the first Yjs write happens for a typed cell, from a later timer to inside the commit. The write runs inside the engine's state updater, as every other engine write path already does. Covered by the B2 repro tests and the manual plan.
- **A1/D0** replaces the app's emptiness heuristics. These guard against persisting or publishing an empty body over real content. The fixture tests pin the new signal to the old `isEmptySheet` meaning; the base64-length bands go away because `userEdited` answers the question they approximated.
- **A4** resets the formula dependency indexes on each remote formula-list change. That matches the state after the rebuild it replaces. It costs one full formula pass on the next local edit, as after any mount today. With many editors committing formulas this happens often; the follow-up in A4 removes it.
- **C8** skips work on a precondition. The index built from formula text must hold the edges `execfunction` would record; a missing edge leaves a dependent formula stale until the next full pass. The normal pass's parse is known to miss references (C8), so the index has its own tokenizer. Mitigation: test its edges against `execfunction`'s and the grid against a forced full pass.
- **D6** counts collaborators' changes, so an owner's device publishes after receiving them, as today's vector check already does. Content another device already published can be published once more; that costs a transaction, not data.
- **The fingerprint tracker** must be attached when the Y.Doc is created. Attached later, it needs one full scan of the delete set to start (under 1 ms at 145,005 entries and 2 to 4 ms at 706,605, in Node).
- **E** can leave part of the UI stale. A memoised component whose selector misses a field it reads stops updating, for example a toolbar button that no longer reflects the selection. Mitigation: each converted component's selector lists every context field the component reads today, checked by grep during review. The manual QA plan exercises toolbar state, the tab bar and menus.
- **D5** skips the download on a hash match. This is safe only if the local body already contains everything behind that hash: the hash is recorded only after a merge completed or a publish was confirmed. Any doubt (missing or different hash) takes today's full path.
- **C6** caches by identity. Immer gives `borderInfo`, `merge` and the hidden maps a new identity on every change, so a stale hit needs an in-place mutation outside Immer. The unit tests pin that each keyed change misses.
