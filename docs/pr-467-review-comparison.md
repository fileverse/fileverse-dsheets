# PR 467 — requested changes vs. code

PR: https://github.com/fileverse/fileverse-dsheets/pull/467 — `feat(formula): explicit arrow-key mode for formula editing`
Branch: `maitra/arrow-key` → `main`. Review: `nadeem-fileverse`, state CHANGES_REQUESTED (2 must, 3 should, 5 low; 10 inline comments).

How this was checked: review text fetched from the public GitHub API; each claim compared with the PR head files at commit `c141b39b` (downloaded, not checked out; the working tree is on another branch). Line numbers below refer to that head commit. I did not run the Vercel preview, so the runtime repros are the reviewer's, confirmed here only by reading the code path.

## Summary

| # | Sev | File:line (head) | Request | Verdict |
|---|-----|------------------|---------|---------|
| 1 | must | formula-arrow-mode.ts:267 | Unary `+`/`-` to the right of the caret counts as an empty slot (TEC-3303 caret trap) | Confirmed by code |
| 2 | must | formula-arrow-mode.ts:308 | F2 override: caret at the *start* of a ref is "touching", arrow inserts instead of replacing → `=SUM(D6A1)` | Confirmed (cause in resolver; insert path not traced) |
| 3 | should | formula-arrow-mode.ts:319, keyboard.ts:1239 | F2 toggles from derived mode, so it can't be turned off at a non-slot caret | Confirmed; suggested fix has a gap (see below) |
| 4 | should/question | keyboard.ts:112, formula.ts:3192 | Touched-ref READY seeds from the edited cell, not the ref | Confirmed; not intended per my own spec |
| 5 | should | formula.ts:4369, FxEditor/index.tsx:378 | `arrowAutoAllowed` is never released in-session; bar focus re-suppresses; several exits skip the reset | Confirmed |
| 6 | low | formula-arrow-mode.ts:3, keyboard.ts:96 | Spec doc is referenced but not in the PR; `parenDepth` unused | Confirmed |
| 7 | low | formula.ts:5332 | Backward selection: `endContainer` is not the caret | Confirmed |
| 8 | low | formula.ts:4593 | Third, disagreeing key list; numpad 0 leaves the blue overlay on | Confirmed |
| 9 | low | formula-arrow-mode.ts:57 | Scientific notation (`1E+`) tokenized as NAME | Confirmed |
| 10 | low | keyboard.ts:104 | Redundant guard; mode recomputed 3–5× per key press | Confirmed |

All ten hold up. None are disputed.

## Details

### 1. [must] Unary sign counted as an empty slot
- **Code:** `isOperandSlot` (formula-arrow-mode.ts:~267) rejects a slot only if `nextSig.kind` is in `OPERAND_LIKE` (REF, NAME, NUMBER, STRING, FUNC_NAME, LPAREN). A `+`/`-` token is kind `OPERATOR`, so it is not blocking.
- **Walk-through of the reported formula:** `=if(D11<>"", if(F11<>"", D11/-F11,""),"")`, caret at `D11/│-F11`. `prevSig` is `/` (OPERATOR, expects operand). `nextSig` is `-` (OPERATOR, not operand-like). Result: slot, so READY. Next Left inserts a reference and rewrites the formula to `D11/A14-F11`.
- **Other cases the reviewer lists:** `=IF(A1>0,│-1,1)`, `=A1*│-1`, `=SUM(│-A1)` all resolve the same way.
- **Fix:** in `isOperandSlot`, if `nextSig` is an OPERATOR whose text is `+` or `-` and `prevSig` expects an operand, treat the sign as unary and return false.
- **Side effect to accept or reject:** `=│+B1` (leading unary plus after `=`) becomes caret-only. Today my unit test, my manual-test doc and my earlier case list all say it is a slot. Decide before changing; the reviewer's rule is internally consistent, so I would follow it.
- **Tests to add:** the reporter's formula verbatim with the caret at `D11/│-F11`; the three reviewer cases; `=A1+│-B1` (binary plus then unary minus, expect caret-only under the rule); update the `'=|+B1'` slot case to a non-slot.

### 2. [must] F2 override at the start of a reference
- **Code:** `getCaretContext` sets `touchingRef` when `t.start <= caret && caret <= t.end` for a REF token, and `resolveArrowMode` (step 5) returns READY for `isOperandSlot || touchingRef`.
- **Why the start edge breaks:** at `=SUM(│A1)` the caret is at the ref's start, so READY. The editor's replace logic uses `getFormulaRangeIndexAtCaret` (caret inside the managed span), which at the start boundary resolves to the text node before the span, so the insert path inserts instead of replacing → `=SUM(D6A1)`. [Inference] I did not trace the insert path; the reviewer's repro matches this reading.
- **Fix (option A, smaller):** use `t.start < caret && caret <= t.end` for `touchingRef`. Then `=SUM(│A1)` is caret-only under the override, matching the O5 decision that a token to the right keeps the caret.
- **Fix (option B):** make the insert path replace the touched ref. More work, and it has to cover the inside-token case too (`=SUM(A│1)`, which also counts as touching today).
- **Open point:** `touchingRef` also matches a caret strictly inside a ref (`A│1`). It is unverified that arrows replace correctly there; add it to the test pass.
- **Tests to add:** `=SUM(│A1)` with override REFERENCE → TEXT_EDIT; `=SUM(A1│)` → READY; and the caret-context test that currently asserts `touchingRef` for `=SUM(|A1)` must flip to null.

### 3. [should] F2 toggles from the derived mode
- **Code:** keyboard.ts:1239 computes `overrideAfterF2(getFormulaArrowMode(ctx))`.
- **Why it can't be turned off:** at `=SUM(A1)│` the derived mode is TEXT_EDIT, so F2 sets REFERENCE. Derived mode is still TEXT_EDIT (REFERENCE finds no slot and no touched ref), so the next F2 sets REFERENCE again. Walking the caret onto `A1│` then activates READY and the next arrow rewrites `A1` (reviewer got `=SUM(C5)`).
- **Reviewer's fix:** toggle on the stored override: `null`/`TEXT_EDIT` → `REFERENCE` → `TEXT_EDIT`.
- **Gap in that fix:** with `override === null` and an auto READY caret (e.g. `=SUM(│`), F2 would set `REFERENCE`, which changes nothing visible; the user pressed F2 expecting text mode. Better: if `override !== null`, flip the stored value; if `null`, flip from the derived mode (READY/ACTIVE → TEXT_EDIT, TEXT_EDIT → REFERENCE). This changes `overrideAfterF2`'s signature to take the stored override too.
- **Tests to add:** F2 twice at a non-slot caret returns to `null` or TEXT_EDIT, not REFERENCE twice; F2 at an auto slot goes to TEXT_EDIT. The existing "F2 toggle" unit tests call `overrideAfterF2(mode)` and need updating with the new signature.

### 4. [should, question] Touched-ref READY seeds from the edited cell
- **Code:** `getFormulaKeyboardNavState` (keyboard.ts:137) calls `seedFormulaFuncSelectedRangeFromLastSelection` (formula.ts:3192). That function copies `ctx.luckysheet_select_save` last entry (the edited cell) and returns early if `func_selectedrange` is already set. Nothing seeds from the touched token.
- **Result:** editing D5 at `=SUM(A1│)` with F2 on, Right gives `=SUM(E5)`, not `=SUM(B1)`.
- **Is it intended?** No. My spec §5.3 says the first arrow enters ACTIVE with the anchor set to the token's current cell. The implementation did not do that, and my manual-test cases 6.5 and 6.6 wrongly encode the relative-to-D5 behaviour. Product rule 3 says "relative to the starting grid selection" but the edge-case list also says an explicit reference activation "can replace that highlighted reference", which reads more naturally as moving that reference from where it is. [Unverified] Google Sheets/Excel point mode behaves that way.
- **Fix:** when READY comes from `touchingRef`, seed `func_selectedrange` from the touched reference's range (parse the token with the existing range helpers) instead of the edited cell; clear any stale `func_selectedrange` first, because the seed function does not overwrite it.
- **Doc to fix:** correct manual cases 6.5 and 6.6 once this is decided.

### 5. [should] `arrowAutoAllowed` is never released within a session
Three separate problems:

1. **No in-session release.** `suppressFormulaRangeSelectionForInitialEdit` (formula.ts:4366) sets `arrowAutoAllowed = false`. The old `keyboardRangeSelectionLock` was cleared on the next keystroke in `handleFormulaInput`. The new field is only reset at keyboard.ts:1448 (type-over) and cell.ts:1255 (`cancelNormalSelected` area). This was a deliberate O1 decision (text-first until F2), so the in-session part is by design; the problems below are not.
2. **Formula-bar focus re-suppresses.** `FxEditor` `onFocus` (FxEditor/index.tsx:~366-372) calls the suppress function *before* the `alreadyEditingSameCell` check (line ~378). Sequence: type `=` over a cell that already holds a formula (type-over resets both fields), then click into the formula bar. Focus runs suppress because the stored cell still has `f`, which turns automatic picking off for the rest of the edit and wipes any F2 choice.
   - **Fix:** compute `alreadyEditingSameCell` first and skip the suppress call when it is true.
3. **Exits that skip the reset.** Confirmed in mouse.ts at lines ~388, ~5639 and ~5695: each sets `ctx.luckysheetCellUpdate = []` directly and never reaches the reset in cell.ts. The reviewer also names clipboard-entry.ts:72 and LinkEditCard; I did not fetch those files, so [Unverified] on those two.
   - **Consequence:** `arrowAutoAllowed = false` / a stale override survives into the next edit. Opening a non-formula cell with F2 or double-click then typing `=` gets no automatic READY, because nothing re-enables it (only the type-over path resets).
   - **Fix:** reset both fields when a session *opens* (where `luckysheetCellUpdate` is set to a non-empty value for a fresh edit, plus the F2/double-click/formula-bar open paths), in addition to the close reset. Better still, one helper that every open path calls so formula vs non-formula cells are decided once.
- **Tests:** unit-test the open-path helper; manual: formula cell type-over → click bar → arrows still auto-pick; mouse-click-away exit → next edit on a non-formula cell → `=` then arrow picks.

### 6. [low] Missing spec doc; unused `parenDepth`
- Doc references are at formula-arrow-mode.ts:3 and keyboard.ts:96. The PR's five files do not include `docs/formula-arrow-key-spec.md` (it exists only as a local file on my side). Either add the spec (and the manual-test doc) to the PR or drop the references.
- `parenDepth` is computed (formula-arrow-mode.ts:203-243) and only read by unit tests. Remove it, or use it. A natural use is the `,` handling when depth is 0, which the spec lists but the code does not implement.

### 7. [low] Backward selection caret
- `getCaretOffsetInEditor` (formula.ts:5325-5334) ends the pre-range at `getRangeAt(0).endContainer/endOffset`. After Shift+Left the selection is backward and the caret is the focus, which is the range *start*. Use `sel.focusNode` / `sel.focusOffset` instead (and check `editor.contains(sel.focusNode)`).
- **Test:** unit-testing needs a DOM; cover it in the manual list (select backward with Shift+Left, then F2 / arrow).

### 8. [low] Key lists disagree
- formula.ts:4582-4585: `isAlphaNumeric` uses `97..122` for a–z. Those are numpad codes (97–105 numpad 1–9, 106–111 numpad operators) and F-keys (112–122), not letters (letters are 65–90 on keydown/keyup).
- Numpad 0 is 96. It is outside `isAlphaNumeric` but inside `isTextChangingKeyCode` (96–111), so it takes the `rangeSelectionActive = null` branch, which skips `markRangeSelectionDirty`'s overlay cleanup. Typing numpad 0 after an arrow-inserted `=A1` gives `=A10` with the overlay still on A1.
- `isFormulaSegmentBoundaryKey` is the third list; it lives in `SheetOverlay/formula-segment-boundary.ts` and is keyed on `e.key` rather than keyCode.
- **Related, unverified:** because `97..122` includes F-keys (112–122), any F-key (e.g. F4 for absolute toggle) handled by `handleFormulaInput` while a reference is active would also take the dirty path. [Unverified] depends on whether that handler runs for F-keys; this is old behaviour, not new in the PR.
- **Fix:** one shared classifier (letters/digits including numpad digits, Backspace/Delete → dirty with overlay cleanup; operators, comma, space → end-active only) and delete the ad-hoc ranges. Add a table-driven unit test over key codes incl. 96–105.

### 9. [low] Scientific notation
- `NUMBER_RE` (formula-arrow-mode.ts:57) is `^(?:\d+(?:\.\d+)?|\.\d+)$`. `1E` and `1E5` fall to NAME, then `+`/`-` are OPERATOR, so `=1E+│` and `=A1*1E-│` resolve to READY.
- **Fix:** read a numeric run with an exponent as NUMBER, including the incomplete form `1E`, `1E+`, `1E-` (treated as a NUMBER prefix so a following sign is part of the token). Note the run character class currently stops at `+`/`-`, so the sign must be consumed in the scanner, not in the regex alone.
- **Tests:** `=1E+│`, `=A1*1E-│`, `=1.5E+3│`, `=1E5+│` (slot, ends with a real operator), `=1E│` (not a slot).

### 10. [low] Redundant guard and repeated work
- Per arrow press the mode is computed in `shouldBlockFormulaRangeKeyboardNavigation` (keyboard.ts:104, via `isFormulaReferenceInputMode`), `enterSheetArrowNavigation` (:114), `getFormulaKeyboardNavState` (:142), plus the Fx pass-through check (:1084) and FxEditor (:648) and InputBox, depending on the editor. Each recomputes the tokens and DOM caret offset.
- `shouldBlockFormulaRangeKeyboardNavigation` is redundant with `enterSheetArrowNavigation`: for a formula in TEXT_EDIT both return "don't navigate", and for non-formula edit `enterSheetArrowNavigation` also returns false.
- **Fix:** delete the guard; pass the computed mode into `getFormulaKeyboardNavState`; compute once per key event in `handleGlobalKeyDown` (or memoize on text + caret + flags for the duration of one event). Formulas are short, so this is clarity and DOM-read cost more than throughput. [Unverified] I did not measure; the performance-rule before/after numbers would need a measurement if you claim a speed-up.

## Tests and docs in my own work that encode the contested behaviour
- `formula-arrow-mode.test.ts`: slot case `'=|+B1'` (item 1); `touchingRef` assertion on `=SUM(|A1)` (item 2); the F2-toggle block (item 3).
- `docs/formula-arrow-key-spec.md` §5.3 describes seeding from the token (item 4) and §3 the F2 rule; `docs/formula-arrow-key-manual-tests.md` cases 6.5 and 6.6 disagree with §5.3.

## Suggested order
1. Item 1 (unary) and item 2 (touching start): both must-fix, both small, both inside `formula-arrow-mode.ts` with unit tests.
2. Item 3 (F2 toggle) together with item 5 (open/close resets, FxEditor focus): same state fields, one pass.
3. Item 4 after the product answer on seeding.
4. Items 6–10 as a cleanup commit: shared key classifier, focus-based caret, exponent numbers, remove redundant guard, doc decision.

## Not verified
- Runtime behaviour on the preview (reviewer repros not re-run).
- clipboard-entry.ts:72 and `LinkEditCard` reset-skipping exits (files not fetched).
- Whether `handleFormulaInput` runs for F-key presses (item 8 side note).
- The insert-versus-replace logic that produces `=SUM(D6A1)` (item 2); only the resolver half was read.
