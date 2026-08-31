# Fix: empty-cell copy produces huge clipboard payloads

**Status:** Implemented.

**Scope:** the empty-cell contribution to clipboard bloat — the case where copying a
mostly-empty sheet (e.g. select-all) serializes tens of thousands of blank cells and
produces up to ~83 MB of HTML. This is the highest-impact, lowest-risk slice of the
broader copy-efficiency work in [`copy-mechanism-findings.md`](./copy-mechanism-findings.md).

**Deliberately out of scope (do not touch):** the per-element `--tw-*` Tailwind
properties added by `execCommand('copy')`. We are **keeping Tailwind** — the clipboard
write path (`clipboard.writeHtml`) is unchanged. This fix does not shrink each cell; it
only stops us from emitting a huge *number* of empty cells. The rich-text `<span>`
explosion (Issue 7) is also separate and untouched here.

---

## Problem

`rangeValueToHtml` ([selection.ts](../src/sheet-engine/core/modules/selection.ts))
serializes **every row × column in the selected range**, including trailing rows and
columns that contain no data. Select-all
([`selectAll`, selection.ts:3459](../src/sheet-engine/core/modules/selection.ts)) sets
the range to the full allocated grid:

```ts
row:    [0, flowdata.length - 1],
column: [0, flowdata[0].length - 1],
```

On a sheet with ~700 KB of real data sitting in a large allocated grid, that is
~57 k mostly-empty cells. Each empty cell still emits a `<td>` (and, after the browser
inlines Tailwind vars, ~1.4 KB each) → **~83 MB** on the clipboard.

Google Sheets copies the same content in a few KB because it clamps the copied region
to the **used range** — the bounding box of cells that actually contain something.

## Fix

Clamp the serialized range to the **bounding box of meaningful cells** before emitting
HTML, inside `rangeValueToHtml`. A cell is "meaningful" if any of:

- it holds data (`sheet.data[r][c] != null`), or
- it has a border (`borderInfoCompute["r_c"]` present), or
- a conditional-format rule styles it (`checkCF(r, c, cf_compute)`).

Rows/columns outside that box carry no data and no CSS, so dropping them is lossless.
If **no** cell in the selection is meaningful (e.g. select-all of an empty sheet), the
range collapses to a single top-left cell — so we never serialise a whole grid of blank
cells. Internal same-session paste still uses the untrimmed in-memory copy range, so any
"copy blanks to clear a target" behaviour inside dsheet is unaffected.

This matches Google's used-range clamp and preserves the bounding box's internal
geometry (relative cell positions, per-column widths, per-row heights, merges) exactly.

### Why it's lossless

- Trimmed cells are `null`, unbordered, and unstyled by CF → nothing to serialize.
- The kept box is emitted identically to before (same styles, same
  `data-fortune-cell` metadata, same `<colgroup>`/height/merge handling).
- Internal same-session paste is driven by the in-memory `luckysheet_copy_save`
  range, which is **not** trimmed — so internal paste behaviour is unchanged.

### Edge cases

- **Empty selection** (no meaningful cell): collapses to a single top-left cell (the
  empty-sheet select-all case).
- **Border-only / CF-only cells** outside the data box: kept (included in the
  bounding box via the border/CF predicates).
- **Custom width/height on an empty trailing column/row** far outside the data box:
  dropped — same as Google. Acceptable; these carry no content.
- **Multi-range selection**: the union's bounding box is used (multi-range copy is
  already shape-restricted upstream in `handleCopy`).

## Implementation

1. Import `checkCF` alongside `getComputeMap` in `selection.ts`.
2. New pure, exported helper `clampIndicesToUsedBounds(rowIndexArr, colIndexArr,
   isMeaningful)` — trims the two index arrays to the bounding box of positions where
   `isMeaningful(r, c)` is true; returns them unchanged if none match. Pure and
   unit-tested in isolation (no `Context` needed).
3. `rangeValueToHtml` calls it after `rowIndexArr`/`colIndexArr` and `borderInfoCompute`
   are built, with the meaningful-cell predicate above.

## Verification

- **Unit** — `clampIndicesToUsedBounds` tests: trims trailing/leading empties, keeps
  the data box, keeps border/CF cells, no-ops on fully-empty and fully-full selections.
- **Manual round-trip** — select-all a mostly-empty sheet → clipboard drops from tens
  of MB to the data box size; paste into a fresh sheet → identical data, styles,
  widths, heights, merges. Paste into Google Sheets/Excel → same visual result.

## Scope note

By decision, **Tailwind is kept** and the clipboard write mechanism
(`clipboard.writeHtml`) is left as-is (`execCommand`-based). So each emitted cell still
carries the `--tw-*` block. This fix's whole job is to reduce how many cells are emitted:
- **Empty sheet select-all:** whole grid → 1 cell.
- **Any selection:** trimmed to the data bounding box (trailing/leading empty rows & cols
  dropped; interior cells kept to preserve grid shape).

Not addressed here (and not planned unless asked): per-cell `--tw-*` size, and the
rich-text `<span>` run explosion (Issue 7).
