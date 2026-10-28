# P1 Stabilise: end-to-end regression checklist

Written 2026-10-26 for branch `maitra/stabilize-package` (changes since `main`: A1–A5, B1–B6, C1–C8 incl. the C8 warm-up; sections 1.15–1.21 and 2.11–2.13 added later for the July narrowing fix (Task 16), B5 case rule (Task 17), D3/D5 package APIs (Tasks 6, 7), the format gate F (Task 8), and gaps found in a review of the first list; E1–E6 are not implemented yet and have no cases). Purpose: confirm existing behaviour still works after the refactor. Format: **do X → expect Y**. The tag in brackets names the change the case guards (see `docs/perf/dsheet-stabilize-spec.md`).

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
9. A formula that has never been shown (type `=A1*2` in a cell, do not select anything else), then edit A1 immediately → the formula updates. [July narrowing bug, fixed by Task 16 (627aeda); must pass now. Also try it on a sheet with a sparse tab: the flag may stay false there, so commits are slower but still correct]
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
9. A reference with the wrong tab-name case (`='a'!B5` when the tab is `A`) → shows `#ERROR` (K30, engine is case-sensitive) and is **not** shifted by an insert on `A`. [Task 17, 782aacd; must pass now]

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

1. Run sections 1.1–1.13 and 1.15–1.21 with the console open → no new uncaught errors beyond K28 in `KNOWN-ISSUES.md`.
2. Leave the sheet open 10 minutes idle → no growing memory, no repeating console output.

### 1.15 Actions that must reach Yjs [B6, B2]

Each case: do it, wait 2 s, reload → the result is still there. With a collaborator, the same result shows in C (see 2.11).

1. Select a range, type a value, press Ctrl+Enter → every selected cell gets the value; reload keeps all of them.
2. Select a range, Ctrl+Enter with a formula `=A1*2` → cells get the formula; reload keeps formulas and values.
3. Right-click a range → Insert cells, shift right → cells move; reload keeps the new positions. Repeat with shift down.
4. Right-click a range → Delete cells, shift left → cells move; reload keeps it. Repeat with shift up.
5. Copy the text `=1+1` from a text editor and paste it into one cell → cell shows 2 with formula `=1+1`; reload keeps the formula (before this work it was lost).
6. Paste a text formula that refers to another cell (`=A1+1`), then change A1 → the pasted cell updates.
7. Drag-fill (autofill) a formula cell in each direction (down, up, right, left) → formulas fill; reload keeps all of them. [B2 `dropCell`]
8. Type a value in A1, switch to another tab within 100 ms (before the commit timer fires), switch back → the value is on the **original** tab, not on the tab you switched to. [B2 sheetId argument]
9. Type values in two cells in the same tick (Enter, Enter quickly) → both are saved after reload.
10. Typed formula (`=A1+1`) → reload keeps the formula (not only its value).

### 1.16 Formula dependency index and warm-up edge cases [C8, Task 16]

Open each sheet fresh (reload), then edit a precedent within 1 s and again after 5 s. Expected: dependents update both times.

1. `=SUM(A1, B1)` (space after the comma); edit B1 → sum updates. (Old normal pass missed this.)
2. `=A1 + B1` (spaces around the operator); edit A1 and B1 → both update the result.
3. Tab named `Q1-2026` (dash): `='Q1-2026'!A1` on another tab; edit `Q1-2026!A1` → dependent updates.
4. `=INDEX(A1:A100,5)`; edit A5 and A50 → the result follows A5 only when it is the fifth row; no stale value.
5. Chain with a very wide range: `B1 =SUM(A1:Z1000)`, `C1 =B1*2`; edit A5 → both B1 and C1 update. (Old code left C1 stale.)
6. A named range used by `=SUM(Sales)`, then a second formula that uses that sum; edit a cell in `Sales` → both update.
7. `=INDIRECT("A1")` and `=OFFSET(A1,1,0)` → show `#NAME?` as on `main`; editing A1 changes nothing and shows no new error. [K11]
8. Time or network formulas (`=NOW()`, a price or data-block function): open the sheet → they do **not** re-run and write results on open (no doc growth, no network call from the warm-up). Check the document size or `ydoc` structs before and after open: flat.
9. A sheet whose only formula is on a sparse tab (few cells far apart): edit its precedent → dependent updates (flag stays false, full pass runs; may be slower, never stale).
10. After a **cut and paste** of formula cells: edit a precedent of a moved formula → the moved formula updates (flag turns false, full pass runs).
11. After an **HTML-table paste** that contains formulas: edit a precedent → dependents update.
12. After a **remote cell batch** (see 2.3.10): edit a precedent of a formula the peer entered → it updates locally.
13. Copy-paste of formula cells (not cut) → pasted formulas evaluate and update when precedents change; editing an unrelated cell stays instant (flag stays true).
14. A formula on tab B refers to `A!B5`, tab A not opened yet in this session (lazy): edit `A!B5` after visiting A → B's formula updates.

### 1.17 Rows and columns on other tabs, parser edges [B5, Task 17]

1. Insert a **column** on `A` → on `B`, `=A!B5` becomes `=A!C5`; `=B5` and `=C!B5` unchanged. Same checks for delete column (`#REF!` for a deleted precedent, others shift left).
2. Absolute references `=A!$B$5` and ranges that span the insert (`=SUM(A!B2:B9)` with an insert at row 5) → absolute row moves, range end moves; same-tab `$B$5` still correct.
3. A tab whose data is not yet loaded (open the sheet, do not visit tab C), insert a row on `A`, then visit `C` → C's `=A!B5` reads `=A!B6`, on the owner and on the collaborator. [K6, fixed 2026-10-28]
4. A tab with no calcChain (formulas typed but never evaluated on it) pointing at `A`: insert a row on `A` → it shifts. [K6, fixed 2026-10-28]
5. `=SUM(A!B3,1)` on `B`, delete row 3 on `A` → text is `SUM(#REF!,1)` and the cell shows an error. [K7, fixed 2026-10-28]
6. **KNOWN (K31):** `=SUM(B5,'oops)+B6` is an invalid formula; inserting a row must not crash.
7. **KNOWN (K32):** `='A'!B5:'A'!B9` (prefix on both ends) is not shifted; record.
8. A string containing an apostrophe: `="it's"&B5` → inserting a row shifts only B5; the string is unchanged. [K34]
9. Tab name containing `!` or `,` if the app allows it → shift is correct or the rename is refused; no crash.
10. Insert a row on `A`, undo, redo → formulas on `B` and `C` that pointed at `A` return to their previous text exactly each time.
11. Two tabs with the same name differing only by case (`A` and `a`) if the app allows it → inserting on `A` shifts only references that use `A` exactly.
12. Insert a row on a tab, then rename that tab, then insert again → still shifts correctly.

### 1.18 Conditional formatting, borders, dropdowns: extra cases [C2, C6, C7, C1]

1. CF rule of type **formula** (custom formula) → still renders (the audit found it crashes with `Cannot assign to read only property 'calculateSheetId'`; record the result on this branch and on `main`).
2. CF formula rule that refers to another tab → change a cell on the other tab → colours update. [C2 key includes `luckysheetfile`]
3. CF **date** rule (today, yesterday, next 7 days) → correct; leave the sheet open past midnight, or change the system date and reload → colours move with the date. [C2 key includes today]
4. CF with live preview open (rule dialog, change the colour) → preview updates, closing without saving restores. [C2 draft state]
5. Frozen rows and columns plus borders and CF → every pane (top-left, top, left, main) shows borders; scroll across panes → no missing lines. [C6 four panes]
6. Hide a row inside a bordered or merged area, then show it → borders return. [C6 key includes `rowhidden`]
7. Dropdown whose options come from a range on another tab → edit the source tab → options update. [C7 key includes source data]
8. Dropdown cells with coloured pills (multi-select) → pill colours stay by position after choosing, removing and re-adding options.
9. Vertical alignment top, middle and bottom with zoom 50 % and 150 % → text does not shift or clip (the text-measure key includes the baseline). [C1]
10. Rich or wrapped text with a font change, then reload → widths and row heights are the same.

### 1.19 Paste sizing and clipboard, extra cases [C5, K24, K27]

1. Paste 10,000 single-line text cells and time it with the console (`performance.now()` around a real paste event) → record the full paste time (parse, write, render). K24: this was never measured.
2. Paste text into cells whose font size is 20 pt → the row height fits the text (K27: single-line height uses `fs` as pixels; record the result).
3. Paste a cell whose font is not loaded yet, then load it → widths correct after the font loads (K26).
4. Paste wrapped cells (long text, wrap on) at zoom 150 % → row heights fit.
5. Paste an HTML table that contains `<img src=x onerror=alert(1)>` → no alert and no image request (P3 is **not** done on this branch; expect this to fail and record the result; see `dsheet-stabilize-followups-spec.md`).
6. Paste a text block whose URL contains `=` (`https://a.com/?x=1`) → pasted as text; nothing else in the sheet is re-evaluated or rewritten (P1 follow-up not done; record how long it takes on a sheet with 500 formulas).

### 1.20 Format gate [F, Task 8]

Use the demo console: `window.ydocRef` is the Y.Doc. A sheet's meta map is `ydocRef.getMap(sheetId + '/meta')`; set `format` to 2 to simulate an upgraded sheet. Use a fresh `?sheet=` name.

1. Open a normal sheet (no meta map) → works as before; type, format, insert row; no lock message; no console error.
2. Set `meta.format = 1` and a non-number (`'2'`, `null`) → no lock.
3. Set `meta.format = 2` while the sheet is open → within about 1 s the message "This sheet was updated. Reload to continue." shows and the grid and toolbar turn read-only.
4. After the lock, type in a cell, Enter → nothing is written (compare `ydocRef.store` struct count or `Y.encodeStateVector` before and after).
5. After the lock, try each of: Delete, paste, Ctrl+Enter, drag-fill, insert/delete row, add and delete sheet, rename sheet, apply a template, import CSV, import XLSX, add comment, add a named range → none of them write to the doc and none crashes.
6. Reload after the lock (the doc still has `format: 2` in IndexedDB) → the sheet opens locked at once, nothing is written during open (no merge, no migrate, no default-workbook seed).
7. **KNOWN (K42):** the permission chip still shows the prop's state, and the comment toolbar item still shows while locked; a template apply that returns early leaves the template selected. Record what you see.
8. Two sheets (`sheetA`, `sheetB`) in one doc: lock `sheetA` only → `sheetB` stays writable.
9. Set `format` back to 1 after the lock → record whether the sheet unlocks (the code never unlocks; expected: stays locked until reload).
10. Edits made before the lock are kept after reload (they were ordinary v1 writes).
11. Open an already-upgraded body (a sheet whose IndexedDB already has `format: 2`) and a published-state merge runs → no merge write happens. [K44: writes made before the watch starts are not blocked except merge and migrate]
12. Open time on a large sheet is not worse than before (gate cost is about 1 microsecond; check there is no visible delay).

### 1.21 Content-change signal and fingerprint (host API) [A1, A2, fingerprint]

Use the demo's `onContentChange` log or add a temporary `console.log` in the demo; `editorRef.getContentFingerprint()` if the demo exposes the handle. Mark with [Unverified] anything the demo does not expose.

1. Open a new empty sheet → `hasContent` is false, `userEdited` is false; the default-workbook seed does not set `userEdited`.
2. Type one value → within about 1 s one call with `hasContent` true and `userEdited` true; not one call per keystroke.
3. Fingerprint changes after: a typed value, a delete (Delete key), removing a filter, removing a dropdown, removing a CF rule, deleting a named range, deleting a tab, undoing a typed value. Each must give a **different** fingerprint than before it.
4. Fingerprint does **not** change after: a click, a selection change, scrolling, and a Delete on an already empty cell.
5. `getContentFingerprint()` is `null` right after mount and becomes a string once IndexedDB has synced.
6. Reload → the fingerprint equals the value before the reload.
7. Two windows in one room that have converged → both show the same fingerprint.
8. A remote edit (peer types) → `onContentChange` fires on the receiving side with `userEdited` still false on a window that never typed.
9. A host that passes the legacy `onChange` → called about once per second while typing, and once on close; no whole-document encode per keystroke (devtools Performance: no 100 ms+ task per edit on the large sheet).
10. Close the tab right after an edit (pagehide) → the final `onContentChange` is flushed (check with a persisted log, for example `localStorage`).

### 1.22 Fewer whole-UI re-renders [E1 to E6, Tasks 9 to 14]

Use a sheet of about 100 rows with a dropdown column, fills and a comment on one cell.

1. Hover a cell with a pinned-off comment, move inside the cell, then leave it → the comment popup appears on entering, stays while moving inside, and disappears on leaving. [E1]
2. Hover a cell with an error value (for example `=1/0`), move inside it, leave → the error popover shows and hides in the same way. [E1]
3. Hover a cell with a hyperlink, move inside it, leave → the link card shows and hides (about 100 ms after leaving). [E1]
4. Drag a comment box, an image, and a cell range (move cells), and resize a comment box and an image → each follows the pointer. Open Find and replace and drag its dialog → it follows the pointer. [E1]
5. Drag-select from one cell to another, and select a whole column by its header → the selection range matches. With frozen rows or columns, repeat → the selection and the hovered cell are right in all four panes. [E1]
6. Scroll the grid with the wheel and with the scrollbar, vertically and horizontally → rows and columns move, headers follow, and the toolbar, sheet tabs and menus do not flicker or lose their state (for example an open dropdown menu stays open). [E2]
7. Select a bold cell, then a plain cell, then a cell with a fill colour → the Bold, font size and colour controls follow the selection each time; the status bar shows the right Sum for a numeric range. [E2]
8. Right-click a cell, a row header and a column header, then open the filter menu and the sheet-tab menu → each opens with the right items. Scroll while one is open → it stays usable. [E2]
9. Undo and redo from the toolbar and with the keyboard after a format change → the toolbar state follows. [E2]
10. Add a second sheet, make it active, then make the editor remount (import a CSV, or a peer makes a structural change) → the second sheet is still active afterwards. [E3]
11. Copy a range and paste it with Ctrl+V into another cell, and paste text from another app → the paste works as before, once (not twice). Paste an HTML table from another page. [E4]
12. Pin a comment open on a cell (show comment), edit another cell → the pinned comment stays; hide it → it goes away; switch to another sheet and back → the pinned state is right on each sheet. [E5]
13. Type `=SUM(A1:A3` in a cell → the formula editor works, the range highlights show, and the selection outline is not doubled. Press Escape. [E6]
14. Open the function picker (Sigma button; widen the window if it is hidden) → categories and function names are listed as before. [E4]
15. Collaborator window: with a peer typing, scroll and hover on the owner's window → no lag and no console errors. [E1 to E4]

Report any case where a control shows a stale state (for example Bold not following the selection), which would point at a context key the E2 ignore list should not skip.

---

## 2. Owner ↔ Collaborator

Notation: **Owner** = owner window, **Collaborator** = collaborator window. After each case wait 2 s, then compare both windows; where it matters, reload the collaborator and compare again.

### 2.1 Joining and presence

1. Owner starts collaboration; the collaborator joins from the invite link → the collaborator sees the owner's content, both show each other in presence.
2. Owner has 5,000 cells before the collaborator joins → the collaborator gets all of them, correct values and formats.
3. Collaborator reloads → the collaborator rejoins and sees the current content.
4. Owner reloads → the owner keeps the content; the collaborator's edits made meanwhile are present.
5. Both close and reopen later → the content is the last state.

### 2.2 Values and formats syncing [A2, A5, A1]

1. Owner types `hello` in A1 → the collaborator shows `hello` within about 2 s.
2. Collaborator types in B1 → the owner shows it.
3. Owner pastes 500 cells (more than the 50-cell surgical limit) → the collaborator gets all cells in one go and the grid does not flicker or reset the selection. [A5]
4. Owner types in 10 different cells quickly → the collaborator ends with all 10.
5. Owner clears a range (Delete) → the collaborator's range clears; reload the collaborator → still empty (delete sync + fingerprint).
6. Owner applies bold, fill and borders to a range → the collaborator shows them.
7. Owner changes a number format → the collaborator shows the new format.
8. Both type in different cells at the same time → both values end up in both windows.
9. Both type in the same cell at the same time → both windows converge to the same value (either one; they must agree).
10. Collaborator selects a cell and scrolls while the owner edits elsewhere → the collaborator's selection and scroll position do not jump. [A4/A5 apply in place]

### 2.3 Formulas syncing [A4, C8, C3]

1. Owner enters `=A1*2` in B1 → the collaborator shows the formula and its value.
2. Collaborator changes A1 → both windows show the new B1 value.
3. Owner adds 20 formulas → the collaborator's grid does not rebuild (selection and scroll stay). [A4]
4. Owner deletes a formula → the collaborator's cell clears.
5. Collaborator edits a precedent of a long formula chain that the owner created → both windows converge on the same values.
6. Owner edits a cell no formula uses → no change on the collaborator besides that cell.
7. Cross-tab formula `=Sheet2!A1` created by the owner → the collaborator shows the formula and value; the collaborator edits `Sheet2!A1` → both update.
8. **KNOWN (K3):** a cross-tab formula whose precedent on another tab is set later may keep an old value; note the result.
9. Dynamic array by the owner → the collaborator shows the spill; the owner edits the source → the spill updates on the collaborator.
10. Owner enters `=A1*2` in B1 (a remote cell batch for the collaborator); the collaborator then edits A1 → B1 updates on the collaborator and on the owner. (C8: a remote batch turns the dependency flag off, so the collaborator takes the full pass.)

### 2.4 Rows and columns, structural changes [B1, B3, B5, A4]

1. Owner inserts a row → the collaborator shows the inserted row and its data shifted; the collaborator's selection stays valid.
2. Owner deletes a row → the collaborator shows the same.
3. Owner inserts a column / deletes a column → same.
4. Owner inserts a row while the collaborator is **editing a cell** (typed text, not committed) → the collaborator's editor keeps the typed text and does not close; after the collaborator presses Enter the inserted row appears on the collaborator and the collaborator's value is saved and visible on the owner. [B3]
5. As 2.4.4, but the collaborator presses Escape → the collaborator's edit is cancelled, the inserted row still appears.
6. As 2.4.4, but the owner inserts three rows in a row while the collaborator is editing → one refresh after the edit ends, all three rows present.
7. Owner inserts a row while the collaborator does nothing, then the collaborator types immediately → no value lost, no value on the wrong row (watch for the K8 edge: a typed value lands at its old coordinates; record where it lands).
8. Remote structural change while the collaborator has a dropdown open, a context menu open, or a comment open → no crash; the UI closes or stays sensibly.
9. Owner inserts 50 rows quickly → the collaborator ends with exactly 50 more rows; reload the collaborator → same count (K2 was fixed 2026-10-27 and browser-checked once with a relay rig: record both counts).
10. [K1, fixed 2026-10-27 for the same tab; the cross-tab case on an inactive tab is K6 and is expected to stay stale] After the owner inserts a row on tab A, the collaborator's formulas that referred to A's cells (`=B5` above the insert row, `=A!B5` on another tab) show the shifted text, same as the owner. Record the text for same-tab and cross-tab references, and whether values are right after a reload of the collaborator.
11. Owner and the collaborator both insert a row at the same time → both windows end with both rows, in the same order.
12. Owner deletes a row the collaborator is editing → the collaborator's edit is not written to a wrong row; no crash.

### 2.5 Sheets (tabs) [A3]

1. Owner adds a sheet → the collaborator shows the tab.
2. Owner renames, reorders, hides and deletes a sheet → the collaborator follows each change.
3. Collaborator switches tabs while the owner edits another tab → the collaborator stays on its tab; the owner's edit appears when the collaborator opens that tab.
4. Owner deletes the tab the collaborator is viewing → the collaborator moves to another tab without an error.
5. Both add a sheet at the same time → both sheets exist in both windows.

### 2.6 Data validation, conditional formatting, filters, named ranges, hyperlinks [A3]

1. Owner adds a dropdown → the collaborator sees the arrow and can choose from it; the collaborator's choice reaches the owner.
2. Owner removes the dropdown → the collaborator's cell loses the arrow; reload the collaborator → still gone.
3. Owner adds a CF rule → the collaborator's cells colour; the owner edits the rule → the collaborator updates; the owner deletes the rule → the collaborator's colours go away.
4. Owner filters a column → the collaborator sees the filter state (as before on `main`: filters are shared state; compare); the owner clears it → the collaborator clears it.
5. Owner adds and deletes a named range → the collaborator's formulas that use it follow.
6. Owner adds and removes a hyperlink → the collaborator follows.
7. Owner freezes rows → the collaborator sees frozen rows.
8. Run 2.6.1–2.6.7 with the collaborator making the changes and the owner observing → same results.

### 2.7 Comments [B4]

1. Owner adds a comment → the collaborator sees the marker; the collaborator opens and reads it.
2. Collaborator replies/edits → the owner sees the update.
3. Owner deletes a comment → the marker goes on the collaborator.
4. Open and close the sheet on both sides 5 times → the stored size does not grow; no stray markers on uncommented cells.

### 2.8 Undo and redo across users [A4]

1. Owner types a value; the collaborator types a different value in another cell; the owner presses Ctrl+Z → only the owner's value is undone; the collaborator's value stays.
2. Collaborator undoes its own change → the owner sees it undone; the owner's own values stay.
3. Owner undoes a row insert while the collaborator has typed in the new row → no crash; compare with how `main` behaves.
4. Owner redoes → the owner's change returns; the collaborator's changes unaffected.

### 2.9 Offline, reconnect and persistence [A1, A2, fingerprint]

1. Collaborator goes offline (devtools → Network → Offline), edits 5 cells, goes online → the owner receives all 5 within a few seconds.
2. Owner edits while the collaborator is offline, the collaborator reconnects → the collaborator receives the owner's edits.
3. Both edit the same cell while the collaborator is offline, then the collaborator reconnects → both converge on one value.
4. Owner closes the tab, the collaborator keeps editing, the owner reopens → the owner sees the collaborator's edits.
5. A delete-only session (the owner clears a range and does nothing else), then reload the owner and the collaborator → both stay empty; the host sees a content change and publishes (check `onContentChange` fired; this is the fingerprint rule).
6. Reload both windows at the same time → content converges, no duplication, no empty sheet.
7. Collaboration lasting 10+ minutes with edits every few seconds → memory and CPU stay flat; no repeated console errors.

### 2.10 Performance feel with two users [A2, A5, C8 warm-up]

1. Large sheet; the collaborator types continuously for 30 s → the owner stays responsive; no whole-grid rebuild flashes on the owner.
2. Owner pastes 10,000 cells → the collaborator updates once; the collaborator's UI is not frozen for more than a moment.
3. Both type formulas continuously → no runaway CPU after they stop (the warm-up re-run is bounded).
4. Compare the same flow on `main` for any case that feels slower; report numbers, not impressions.

### 2.11 B6 actions and B1 guard, with a the collaborator [B6, B1, B2]

1. Owner presses Ctrl+Enter over a range → the collaborator shows the values; reload the collaborator → still there.
2. Owner inserts cells with shift right, then deletes cells with shift up → the collaborator shows the same positions; reload the collaborator → same.
3. Owner pastes the text `=1+1` into one cell → the collaborator shows 2 and the formula `=1+1`.
4. Owner drag-fills a formula in each direction → the collaborator shows all filled cells.
5. Owner inserts a row, and 20 ms later a second row (two structural events inside one 50 ms window on the collaborator), then **the collaborator** types a value and presses Enter → the collaborator's value is saved (reload the collaborator, and check the owner). [B1: the guard must not stay stuck]
6. Repeat 2.11.5 with five inserts in a row, then the collaborator types 10 values → all 10 are saved on both sides, even after a reload.
7. Owner undoes a Ctrl+Enter fill → the collaborator's cells clear too.

### 2.12 Format gate with two clients [F, Task 8]

1. Owner and the collaborator in one room; the collaborator sets `meta.format = 2` (console) → the owner shows the "Reload to continue" message within about 2 s and goes read-only.
2. After 2.12.1, the owner types in a cell → nothing is written (state vector of the owner's doc unchanged); the collaborator does not receive it.
3. After 2.12.1, the collaborator keeps editing (the collaborator is not locked by its own write only if it is the upgrader; record whether the collaborator locks itself) → record the result.
4. Edits the owner made **before** the change reached it are ordinary v1 writes and are present on the collaborator after the sync.
5. Owner reloads after being locked → opens locked at once.
6. Collaborator joins the room after the format is already 2 → the collaborator opens locked.
7. A sheet with a different id in the same doc is not locked on either side.
8. Owner is mid-edit in a cell when the format flips → the typed value is not written; the editor does not crash; the message shows.
9. Both clients locked, then the collaborator sets `format = 1` back → record whether they unlock (expected: stay locked until reload).
10. **KNOWN (K42, K43):** permission chip and comment toolbar still show; second-tab check was not run on the branch before this list. Record the result.

### 2.13 Undo, formulas and the local store [A4, A5, D3, D5]

1. Owner commits a formula (`B1 =A1*2`); the collaborator commits another (`B2 =A2*2`); the owner presses Ctrl+Z → only the owner's formula is undone; the collaborator's formula `B2` stays on the owner and in Yjs (reload both: `B2` still has its formula). [A4 `calcChain` rule]
2. Owner undoes and redoes a formula edit three times → the collaborator's calcChain entries are never removed.
3. Rebuild the local store while collaborating: from the demo console call `rebuildLocalStore()` on the editor handle (**[Unverified]** the demo may not expose it; add a temporary button) → the sheet keeps all content including edits that were never persisted; reload → same content; no flicker on the collaborator.
4. Call `rebuildLocalStore()` twice at once → one rebuild runs; both calls resolve; content intact.
5. Call it while another tab of the same browser has the same sheet open (blocked delete) → it does not hang forever [K40: the wait for the new provider is now bounded at 15 s; record the time to finish]; close the other tab → it completes.
6. Call it right after mount (during bootstrap) and right before unmount → no console error, no stuck "syncing" status. [K40]
7. Count rows of the `updates` store in IndexedDB after the call → 1.
8. Read-only editor or sync off → `rebuildLocalStore()` does nothing and does not throw.
9. `appendDsheetUpdate(dsheetId, delta)` from the console with a delta from a peer (`Y.diffUpdate(remoteBody, localStateVector)`) → reload shows the merged content; the `updates` store gains exactly one row; the live doc is untouched until reload. **[Unverified]** the demo does not expose `./persistence`; use the browser console with an import of the built module.
10. `appendDsheetUpdate` on a sheet that has no database → creates the store; with IndexedDB disabled (private window) → rejects with an error; no crash.

### 2.14 PR 466 review fixes [review #1 to #6]

1. Open the console in either window while editing → no `[sv]` log lines on any edit. [#1]
2. Merge A1:D1; type `A2 =B5` and `C2 =SUM(B1:B10)`; owner inserts a row at 3 → the collaborator shows `=B6` and `=SUM(B1:B11)`; reload the collaborator: still the same. Repeat with a row delete at 3 → `=B4`. [#6]
3. In A11:A16 enter `=$B$5` in each; owner inserts a row at 4 → the collaborator shows `=$B$6` in all six cells. [#6]
4. Owner inserts 1 row at the top of a sheet with about 1,000 formulas, then presses Ctrl+Z → undo finishes with no visible pause (engine measurement: 24 ms); Ctrl+Shift+Z likewise; the collaborator's formulas recalculate afterwards. [#2]
5. Owner types in a cell and, before pressing Enter, the collaborator inserts a row above a formula at B4 (so it moves to B5); owner commits a formula in another cell, then the remount runs → after it, the collaborator's formula at B5 still recalculates when its inputs change (it kept its calcChain entry), and the owner's new formula also recalculates. Both windows reloaded show the same. [#3] **[Unverified]** that this reproduces the review's sequence in the browser; the unit tests cover the pieces.
6. During step 5, change nothing else; then, still mid-edit, hide a column on the owner → the hide may not reach the collaborator while the remount is pending (known trade-off). Repeat after the edit ends → it reaches the collaborator. [#3]
7. Host app with an inline `onChange` that changes identity on every render: edit a cell, then within 1 s open a panel or add a comment → the host's `onChange` still fires once, about 1 s after the edit. [#5]
8. Make the local store unreadable (for example corrupt a row in the `updates` object store, or use a browser where the first read fails) and open the sheet → within about 15 s the editor leaves "syncing" and works without IndexedDB; `onIndexedDbError` fires. [#4]
9. In that state call `rebuildLocalStore()` → it settles within about 3 s plus the rebuild; the editor shows the published content merged with the local content; the status is "synced". [#4]
10. Open the sheet and change `isReadOnly` or the published content right after mount, then call `rebuildLocalStore()` → it settles (resolves or rejects) and the status never stays "syncing". [#4]

### 2.15 PR 466 review fixes, second round [review #7 to #14]

1. Tab A and tab B; on B enter `=A!B5` and `=2*A!B5`; on A insert a row above row 5 → on B the formulas become `=A!B6` and `=2*A!B6`, on the owner and the collaborator, and after a reload. [#7]
2. A 4 x 4 sheet with formulas in B2 and D4; insert a row at the top, press Ctrl+Z → the collaborator's calcChain (or a recalculation of D4 after changing its input) shows no entry outside the 4 x 4 grid; repeat with a column insert. [#8]
3. Insert 2 rows, then Ctrl+Z → the collaborator's row count goes back at once (not only after switching tabs); Ctrl+Shift+Z → it grows again. Do it on a tab that is not the current one for the collaborator. [#9]
4. Collaborator edits an input of a formula the owner also holds, several times → the owner's formulas still recalculate fast on every commit (no growing lag with 2,000 formulas). [#10]
5. `A1=5`, `B1 =A1*2`; cut B1, paste into D4, set A1 to 7 → D4 shows 14 on both windows. [#11]
6. Fill a formula down 50 rows; look at the Yjs update count (or the network panel) → one write per cell, not two. [#12]
7. Define a name `lim` on A3 (value 5) and a conditional format with the formula `=lim>7`; move the name to A2 (value 10) → the highlight appears without another edit. [#13]
8. Open and close several sheets in a long session → memory does not grow with every sheet opened (heap snapshot; **[Unverified]** the size of the effect). [#13]
9. Collaborator upgrades the sheet to a newer format while the owner is typing in a cell → the owner's grid turns read-only at once; a cell committed right after is not shown as saved and is not silently lost on reload (it is rejected). [#14]

### 2.16 PR 466 review fixes, third round [review #15 to #18]

1. Paste plain text (no `=`) into a sheet with 2,000 formulas, then edit an input of a formula → the recalculation stays fast right after the paste (no switch to the slow path). [#15]
2. Paste an HTML table that contains formulas → the formulas recalculate when their inputs change. [#15]
3. Insert a row on the owner → the collaborator receives it as one change: the rows, the shifted formulas and the new row count appear together (no frame with the new cells and the old count). Same for column insert, row delete, column delete. [#16]
4. Make `rehydrateWorkbookFromYdoc` fail (for example by throwing from a comment-marker callback in a debug build) → the console shows the error once, and a cell typed afterwards still reaches the collaborator. [#18] **[Unverified]** that this can be provoked without a debug build.
5. A collaborator changes a formula list; the owner reloads → no console warning about a frozen object or "Cannot assign to read only property" from the chain. [#17]

---

## 3. What to report

For each failure give: section and case number, what you did, what each window showed, console output, and whether it also fails on `main`. A case that fails on `main` too is not a regression of this work; add it to `docs/perf/KNOWN-ISSUES.md`.

Cases that should currently fail (so they are not a surprise): 1.9.5 (K25), 2.3.8 (K3, possible; did not reproduce at engine level after Task 16), 2.4.7 (K8), 1.17.6 and 1.17.7 (K31, K32), 1.18.1 (CF formula rule crash, from the audit), 1.19.2 (K27), 1.19.5 and 1.19.6 (P3 and P1 follow-ups are not done), 1.20.7 (K42), 2.12.10 (K42, K43). 1.2.9 and 1.3.9 were on this list before Tasks 16 and 17; they must pass now.
