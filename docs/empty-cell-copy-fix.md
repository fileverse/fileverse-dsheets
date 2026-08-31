# Fix: empty-cell copy produces huge clipboard payloads

**Status:** Implemented.

**Scope:** the empty-cell contribution to clipboard bloat — the case where copying a
mostly-empty sheet (e.g. select-all) serializes tens of thousands of blank cells and
produces up to ~83 MB of HTML. This is the highest-impact, lowest-risk slice of the
broader copy-efficiency work in [`copy-mechanism-findings.md`](./copy-mechanism-findings.md).

Out of scope here (tracked separately): the per-element `--tw-*` bloat added by
`execCommand('copy')` (Phase 1 in the findings doc) and the rich-text `<span>`
explosion (Issue 7). Those shrink each *real* cell; this fix stops us from emitting a
huge number of *empty* cells in the first place.

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
If **no** cell in the selection is meaningful (a deliberately-empty selection), the
range is left unchanged — preserving the "copy blanks to clear a target" behaviour.

This matches Google's used-range clamp and preserves the bounding box's internal
geometry (relative cell positions, per-column widths, per-row heights, merges) exactly.

### Why it's lossless

- Trimmed cells are `null`, unbordered, and unstyled by CF → nothing to serialize.
- The kept box is emitted identically to before (same styles, same
  `data-fortune-cell` metadata, same `<colgroup>`/height/merge handling).
- Internal same-session paste is driven by the in-memory `luckysheet_copy_save`
  range, which is **not** trimmed — so internal paste behaviour is unchanged.

### Edge cases

- **Empty selection** (no meaningful cell): range unchanged (no trim to nothing).
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

## Follow-ups (separate work)

- Phase 1: direct clipboard write (`clipboardData.setData` / `navigator.clipboard.write`)
  to remove the `--tw-*` per-element bloat — the remaining ~90% on the *kept* cells.
- Issue 7: collapse rich-text `<span>` runs.
