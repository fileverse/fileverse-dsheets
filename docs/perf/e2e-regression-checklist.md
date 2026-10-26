# P1 Stabilise: end-to-end regression checklist

Written 2026-10-26 for branch `maitra/stabilize-package` (changes since `main`: A1–A5, B1–B6, C1–C8 incl. the C8 warm-up). Purpose: confirm existing behaviour still works after the refactor. Format: **do X → expect Y**. The tag in brackets names the change the case guards (see `docs/perf/dsheet-stabilize-spec.md`).

## Setup

- **Owner only:** the demo (`npm --prefix demo run dev`, port 5000) in a normal Chrome window. Use a fresh `?sheet=<name>` per run so IndexedDB is clean, and a second run on a sheet that already has data (reload test).
- **Owner and collaborator:** owner clicks "Start collaboration" and copies the invite link; the collaborator opens it in a second window (a different Chrome profile is best: separate local storage, separate IndexedDB). Real Chrome supports `prompt()` for the user name; the built-in browser does not.
- Use a 100-row sheet for functional checks and one large sheet (about 10,000 rows × 60 columns, or paste 10,000 rows) for the "feels fast" checks. Keep the console open; any new red error not listed in `docs/perf/KNOWN-ISSUES.md` (K28) is a failure.
- A case passes only if the result is the same after a page reload (it was saved) unless it says otherwise.

Cases marked **KNOWN** fail today for a reason already recorded in `docs/perf/KNOWN-ISSUES.md`; they are listed so a failure is not mistaken for a new regression.

---

## 1. Owner only

### 1.1 Typing and cell values [A1, B2, B1]

1. Type `hello` in A1, press Enter → A1 shows `hello`; reload → still there.
2. Type `5` in A2, press Tab → A2 is 5 and right-aligned (number); selection moves right.
3. Type text, then press Escape instead of Enter → the cell keeps its old value.
4. Type in a cell, then click another cell without pressing Enter → the typed value is committed (B2: typed commits are written at commit time); reload keeps it.
5. Type a value and immediately reload (within 1 s) → the value is still there (A1 flush on `pagehide`/unmount).
6. Clear a cell with Delete → empty; reload → still empty (delete-only change must persist; this is the A1 fingerprint case).
7. Clear a range with Delete, reload → whole range still empty.
8. Undo (Ctrl+Z) a typed value, then redo → value goes and comes back; reload keeps the final state.
9. Type a very long text with line breaks (Alt+Enter) → row height grows; reload keeps it.
10. Edit the same cell 20 times quickly → last value wins, no console error.

### 1.2 Formulas [C8, C3, C8 warm-up, A4]

1. A1 `=1+1` → shows 2.
2. A1 `5`, B1 `=A1*2` → B1 shows 10; change A1 to 7 → B1 updates to 14.
3. Chain: `C1 =B1+1`; change A1 → both B1 and C1 update.
4. Edit a cell no formula uses (Z50) on a sheet with many formulas → the edit is instant and no other value changes. [C8]
5. `=SUM(A1:A100)` over a range; edit A57 → the sum updates.
6. Wide range: `=SUM(A1:Z20000)` (more than 10,000 cells); edit a cell inside it → the sum updates, and a formula that refers to that sum also updates. [C8 wide-range path]
7. Defined name `Sales` covering B2:B10 and `=SUM(Sales)`; edit B5 → the sum updates. [C8 named-range path]
8. Open a sheet that has many formulas, wait 3 s idle, then edit a precedent cell → dependents update (the warm-up does not change results). Do it right after open too (within 1 s) → dependents still update. [C8 warm-up]
9. A formula that has never been shown (type `=A1*2` in a cell, do not select anything else), then edit A1 immediately → the formula updates. [July narrowing bug, **KNOWN risk**: may fail on sheets with a sparse tab; record the result]
10. Dynamic array (e.g. `=SORT(A1:A10)` or `=UNIQUE(...)`) → spills; edit a source cell → the spill updates; delete the formula → the spilled cells clear. [C3, F4 not changed; check nothing broke]
11. Delete a formula cell, then edit what it referred to → no ghost value, no error.
12. Copy a formula cell (Ctrl+C, Ctrl+V) to another cell → relative references shift; value is right.
13. Fill down a formula with the drag handle across 50 rows → each row refers to its own row.
14. Volatile functions (`=NOW()`, `=RAND()`) → still recalculate on edit/recalculate; no stale value.
15. Error values: `=1/0` → `#DIV/0!`; fix the divisor → error clears.
16. Async or live functions (a crypto-price or fetch-style function if enabled) → value loads once and does not flicker on every edit.

### 1.3 Cross-tab formulas and sheets [B5, C8]

Create tabs `A`, `B`, `C` with a value in B5 of each.

1. On `B`: `=A!B5`; edit `A!B5` → the formula on `B` updates.
2. Insert a row at index 2 on `A`:
   - `A` formulas that point at its own B5 → B6.
   - `A`'s `=C!B5` → unchanged.
   - on `B`, `=A!B5` → `=A!B6`; `=B5` → unchanged; `=C!B5` → unchanged.
   - on `C`, `=A!B5` → `=A!B6`.
3. Delete a row on `A` that holds a referenced cell → references to it show `#REF!` on every tab; others shift up.
4. Tab with a quote in its name (`Bob's Sheet`): `='Bob''s Sheet'!B5` shifts correctly when a row is inserted on that tab.
5. Tab name with spaces and a digit (`Q1 2026`): `='Q1 2026'!B2:B9` shifts correctly (note: at insert index 2 only the end moves).
6. Rename tab `A` → formulas that pointed at it keep working (or are updated, as today; compare with `main`).
7. Delete a tab other tabs refer to → `#REF!`, no crash.
8. Add, reorder, hide and unhide tabs → no console error; order survives reload.
9. **KNOWN (K4):** a reference with the wrong tab-name case (`='a'!B5` when the tab is `A`) is currently shifted by an insert on `A`; the spec says it must not be. Expect this to fail until Task 17.

### 1.4 Rows and columns [B5, C6, C3]

1. Insert a row above and below a selection → empty row appears; data below shifts; formulas on the same tab adjust.
2. Insert 3 rows at once; insert a column left and right → same checks.
3. Delete a row/column that contains data and formulas → data gone; ranges that spanned it shrink (`SUM(B2:B9)` → `SUM(B2:B8)`).
4. Delete the only row a formula refers to → `#REF!`.
5. Resize a row and a column, then insert a row above → the sizes stay with their rows.
6. Hide and show rows/columns; freeze rows/columns → frozen panes stay frozen after insert/delete.
7. Undo and redo an insert and a delete → formulas return to their previous text exactly.
8. Insert a row on a sheet with merges and borders → merges and borders stay with their cells.

### 1.5 Data validation and dropdowns [C7]

1. Add a list dropdown with options `Yes, No, Maybe` on a column → the dropdown arrow shows; choose each option; the value is saved.
2. Dropdown with 200 options, 100 cells using it → the sheet scrolls smoothly; the options are the same as before (no duplicates dropped or added).
3. Options with duplicates and spaces (`a, a, b`) → shows each unique option once, as on `main`.
4. Dropdown from a range reference → options follow the range; edit the range → options update.
5. Number validation (between 1 and 10): type 11 → rejected with the message; type 5 → accepted.
6. Checkbox validation → toggle works; reload keeps it.
7. Remove the validation → the arrow and the rule are gone; reload keeps that (delete-only change).
8. Copy a dropdown cell and paste elsewhere → the dropdown comes along.

### 1.6 Conditional formatting [C2]

1. Rule: highlight cells greater than 5 → matching cells are coloured; edit a value across the threshold → the colour appears and disappears immediately.
2. Rule types: text contains, duplicate values, top/bottom N, data bars, colour scale, icon sets → each still renders.
3. Two rules on overlapping ranges → priority order is as before.
4. Edit a cell inside a rule range → only that cell's format changes; no flicker elsewhere.
5. Add a rule, delete it → highlight gone; reload keeps it gone.
6. Insert a row inside a rule's range → the rule range grows.
7. Switch sheets and back → rules render on each sheet and are not shared between sheets.
8. Large sheet with 2 rules → scrolling stays smooth.

### 1.7 Borders, merges, formatting, fonts [C6, C1]

1. Apply borders (all, outer, only left, thick, dashed) to a range → each looks as before.
2. Apply borders to many separate ranges (20+) then scroll → no lag, no missing borders.
3. Merge cells, then add borders → borders go around the merged block only.
4. Unmerge → borders and values behave as before.
5. Bold, italic, underline, strike, font size, font family, text colour, fill colour, alignment, wrap, number formats (currency, percent, date) → each applies and persists.
6. Zoom 50 %, 100 %, 150 % → text stays crisp and positioned right (text-measure cache is keyed by zoom). [C1]
7. Change font size of a cell → column text re-measures correctly (overflow into the next empty cell as before).
8. Change a font family to a web font, wait for load, scroll → text widths correct.

### 1.8 Paste, copy, import [C5, B6]

1. Copy a range, paste elsewhere inside the sheet → values, formats and formulas as before.
2. Paste 10,000 rows of plain text from a text editor → completes quickly; columns auto-fit to the text; undo removes all of it.
3. Paste an HTML table from a web page → values land; widths sensible; wrapped cells get a row height that fits.
4. Paste from Google Sheets → values and formats land (known gaps in `docs/paste-sizing-issues.md`, which is not in this repo, are unchanged).
5. Paste text with multiple lines in one cell → row grows to fit.
6. Paste over a range with merges and borders → as before.
7. Paste into a sheet with CF/DV rules → rules stay.
8. Import an `.xlsx` with formulas → values are right; edit a precedent afterwards → dependents update. [C8 forced pass]
9. Export (if available) and re-import → same content.
10. Cut and paste a range with formulas → formulas keep working.

### 1.9 Crypto banner [C4]

1. Type `BTC` in a cell, select another cell → the denomination/price banner appears within about 1 s.
2. Select cells without BTC/ETH/SOL → banner stays hidden.
3. Delete the BTC cell → banner disappears within about 1 s.
4. Change selection quickly across a 10,000-row sheet → no lag from the banner.
5. Switch to another sheet that has no crypto text → banner hides (a stale banner for up to about 1 s is **KNOWN**, K25).
6. Type `ETH` and `SOL` variants → banner shows for each.

### 1.10 Comments [B4]

1. Add a comment to a cell → a marker appears; open it and read the text.
2. Reload → the marker and the text are still there.
3. Edit and delete a comment → the marker updates and goes away.
4. Comments on a sheet with 1,000+ cells → open time not worse than before; uncommented cells show no marker.
5. Add a comment, then edit the cell value → comment stays.
6. Check document size does not grow on open/close (open and close the sheet 5 times; the stored body size stays flat). [B4]

### 1.11 Filters, sort, named ranges, hyperlinks, freeze, sub-sheets [A3]

1. Apply a filter on a column → rows hide; clear it → rows return; reload keeps the state.
2. Sort A→Z and Z→A over a range with formulas → values and formulas follow the rows.
3. Add, rename and delete a named range → formulas using it keep working; deleting it gives `#NAME?`.
4. Add a hyperlink to a cell → click works; remove it → gone; reload keeps it.
5. Freeze 2 rows and 1 column → stays frozen after reload.
6. Data blocks / live-query lists (if used) → add one, reload, it is still there; delete it, reload, still gone. [A3 `data-block-list` hook]
7. Add a second sheet, add data, switch back and forth 10 times → each sheet shows its own data, no mixing.

### 1.12 Undo and redo [A4, B2]

1. Type, format, insert a row, then Ctrl+Z three times → each step reverses in order.
2. Redo three times → returns to the final state.
3. Undo after a formula edit → the old formula returns and dependents update.
4. Undo after reload → either does nothing or behaves as on `main` (compare).

### 1.13 Persistence, reload, large sheet [A1, A2, fingerprint]

1. Make 20 edits of different kinds (value, delete, format, DV removal, CF removal, filter removal, named-range removal), reload → all of them persisted, including the deletions.
2. Close the tab right after an edit, reopen → the edit is there.
3. Open the same sheet in two tabs of the same browser → both load the same content.
4. Large sheet (10,000 × 60): open time, type in a cell, scroll fast for 5 s, select a big range → no freeze longer than before (compare with `main` if in doubt). Console stays clean.
5. Large sheet: edit a cell no formula uses → instant. Edit one that feeds a long chain → dependents update, UI stays usable.
6. Host callback check (if you embed the editor): `onContentChange` fires about once per second while typing, not once per keystroke, and once on close.

### 1.14 Console and stability

1. Run sections 1.1–1.13 with the console open → no new uncaught errors beyond K28 in `KNOWN-ISSUES.md`.
2. Leave the sheet open 10 minutes idle → no growing memory, no repeating console output.

---

## 2. Owner ↔ Collaborator

Notation: **O** = owner window, **C** = collaborator window. After each case wait 2 s, then compare both windows; where it matters, reload C and compare again.

### 2.1 Joining and presence

1. O starts collaboration; C joins from the invite link → C sees O's content, both show each other in presence.
2. O has 5,000 cells before C joins → C gets all of them, correct values and formats.
3. C reloads → C rejoins and sees the current content.
4. O reloads → O keeps the content; C's edits made meanwhile are present.
5. Both close and reopen later → the content is the last state.

### 2.2 Values and formats syncing [A2, A5, A1]

1. O types `hello` in A1 → C shows `hello` within about 2 s.
2. C types in B1 → O shows it.
3. O pastes 500 cells (more than the 50-cell surgical limit) → C gets all cells in one go and the grid does not flicker or reset the selection. [A5]
4. O types in 10 different cells quickly → C ends with all 10.
5. O clears a range (Delete) → C's range clears; reload C → still empty (delete sync + fingerprint).
6. O applies bold, fill and borders to a range → C shows them.
7. O changes a number format → C shows the new format.
8. Both type in different cells at the same time → both values end up in both windows.
9. Both type in the same cell at the same time → both windows converge to the same value (either one; they must agree).
10. C selects a cell and scrolls while O edits elsewhere → C's selection and scroll position do not jump. [A4/A5 apply in place]

### 2.3 Formulas syncing [A4, C8, C3]

1. O enters `=A1*2` in B1 → C shows the formula and its value.
2. C changes A1 → both windows show the new B1 value.
3. O adds 20 formulas → C's grid does not rebuild (selection and scroll stay). [A4]
4. O deletes a formula → C's cell clears.
5. C edits a precedent of a long formula chain that O created → both windows converge on the same values.
6. O edits a cell no formula uses → no change on C besides that cell.
7. Cross-tab formula `=Sheet2!A1` created by O → C shows the formula and value; C edits `Sheet2!A1` → both update.
8. **KNOWN (K3):** a cross-tab formula whose precedent on another tab is set later may keep an old value; note the result.
9. Dynamic array by O → C shows the spill; O edits the source → the spill updates on C.

### 2.4 Rows and columns, structural changes [B1, B3, B5, A4]

1. O inserts a row → C shows the inserted row and its data shifted; C's selection stays valid.
2. O deletes a row → C shows the same.
3. O inserts a column / deletes a column → same.
4. O inserts a row while C is **editing a cell** (typed text, not committed) → C's editor keeps the typed text and does not close; after C presses Enter the inserted row appears on C and C's value is saved and visible on O. [B3]
5. As 2.4.4, but C presses Escape → C's edit is cancelled, the inserted row still appears.
6. As 2.4.4, but O inserts three rows in a row while C is editing → one refresh after the edit ends, all three rows present.
7. O inserts a row while C does nothing, then C types immediately → no value lost, no value on the wrong row (watch for the K8 edge: a typed value lands at its old coordinates; record where it lands).
8. Remote structural change while C has a dropdown open, a context menu open, or a comment open → no crash; the UI closes or stays sensibly.
9. O inserts 50 rows quickly → C ends with exactly 50 more rows; reload C → same count (watch K2: row counts can differ).
10. **KNOWN (K1):** after O inserts a row on tab A, C's formulas that referred to A's cells (`=B5`, `=A!B5`) may keep the old text while O's show the shifted text. Record what C shows for same-tab and cross-tab references, and whether values are right after a reload of C.
11. O and C both insert a row at the same time → both windows end with both rows, in the same order.
12. O deletes a row C is editing → C's edit is not written to a wrong row; no crash.

### 2.5 Sheets (tabs) [A3]

1. O adds a sheet → C shows the tab.
2. O renames, reorders, hides and deletes a sheet → C follows each change.
3. C switches tabs while O edits another tab → C stays on its tab; O's edit appears when C opens that tab.
4. O deletes the tab C is viewing → C moves to another tab without an error.
5. Both add a sheet at the same time → both sheets exist in both windows.

### 2.6 Data validation, conditional formatting, filters, named ranges, hyperlinks [A3]

1. O adds a dropdown → C sees the arrow and can choose from it; C's choice reaches O.
2. O removes the dropdown → C's cell loses the arrow; reload C → still gone.
3. O adds a CF rule → C's cells colour; O edits the rule → C updates; O deletes the rule → C's colours go away.
4. O filters a column → C sees the filter state (as before on `main`: filters are shared state; compare); O clears it → C clears it.
5. O adds and deletes a named range → C's formulas that use it follow.
6. O adds and removes a hyperlink → C follows.
7. O freezes rows → C sees frozen rows.
8. Run 2.6.1–2.6.7 with C making the changes and O observing → same results.

### 2.7 Comments [B4]

1. O adds a comment → C sees the marker; C opens and reads it.
2. C replies/edits → O sees the update.
3. O deletes a comment → the marker goes on C.
4. Open and close the sheet on both sides 5 times → the stored size does not grow; no stray markers on uncommented cells.

### 2.8 Undo and redo across users [A4]

1. O types a value; C types a different value in another cell; O presses Ctrl+Z → only O's value is undone; C's value stays.
2. C undoes its own change → O sees it undone; O's own values stay.
3. O undoes a row insert while C has typed in the new row → no crash; compare with how `main` behaves.
4. O redoes → O's change returns; C's changes unaffected.

### 2.9 Offline, reconnect and persistence [A1, A2, fingerprint]

1. C goes offline (devtools → Network → Offline), edits 5 cells, goes online → O receives all 5 within a few seconds.
2. O edits while C is offline, C reconnects → C receives O's edits.
3. Both edit the same cell while C is offline, then C reconnects → both converge on one value.
4. O closes the tab, C keeps editing, O reopens → O sees C's edits.
5. A delete-only session (O clears a range and does nothing else), then reload O and C → both stay empty; the host sees a content change and publishes (check `onContentChange` fired; this is the fingerprint rule).
6. Reload both windows at the same time → content converges, no duplication, no empty sheet.
7. Collaboration lasting 10+ minutes with edits every few seconds → memory and CPU stay flat; no repeated console errors.

### 2.10 Performance feel with two users [A2, A5, C8 warm-up]

1. Large sheet; C types continuously for 30 s → O stays responsive; no whole-grid rebuild flashes on O.
2. O pastes 10,000 cells → C updates once; C's UI is not frozen for more than a moment.
3. Both type formulas continuously → no runaway CPU after they stop (the warm-up re-run is bounded).
4. Compare the same flow on `main` for any case that feels slower; report numbers, not impressions.

---

## 3. What to report

For each failure give: section and case number, what you did, what each window showed, console output, and whether it also fails on `main`. A case that fails on `main` too is not a regression of this work; add it to `docs/perf/KNOWN-ISSUES.md`.

Cases that should currently fail (so they are not a surprise): 1.2.9 (possible), 1.3.9 (K4, Task 17), 1.9.5 (K25), 2.3.8 (K3, possible), 2.4.7 (K8), 2.4.9 and 2.4.10 (K1, K2).
