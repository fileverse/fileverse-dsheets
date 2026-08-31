# Copy mechanism — findings across all scenarios

**Status:** Investigation complete; root cause confirmed in code. Fixes proposed, not
yet applied.

**Goal:** shrink the clipboard payload dsheet produces on copy so a mostly-empty or
modestly-sized sheet does not emit tens of MB, **while losing zero data and zero
visible CSS** (internal dsheet→dsheet paste and external dsheet→Google/Excel paste must
both stay pixel- and data-identical).

This doc consolidates the copy-side findings. The paste-side sizing bugs (auto-fit
measurer, row-height restore, `<colgroup>`/`<col>` mismatch) live in
[`paste-sizing-issues.md`](./paste-sizing-issues.md) (Issues 1–7). Issues 5 and 7 there
overlap this doc and are cross-referenced.

---

## 1. Executive summary

dsheet copies **20–35× more clipboard HTML than Google Sheets for identical content**,
and up to ~83 MB for a select-all of a mostly-empty sheet.

The overhead is **not** dsheet's data or styles. dsheet already builds a clean, correct,
compact HTML string on copy. The bloat is added **after** that, at the clipboard-write
step: dsheet mounts the string as live DOM inside its Tailwind-styled app and lets the
browser copy the on-screen selection. The browser then inlines ~40 dead `--tw-*` CSS
variables (plus other framework defaults) onto **every** element. None of it is
meaningful — it carries no data and changes no rendering — but it dominates the payload.

**One-line root cause:** dsheet copies by letting the browser serialize a live DOM
subtree mounted inside its Tailwind app, so the clipboard captures ~40 dead framework
CSS vars per element instead of the lean HTML string dsheet already generated.

**Primary fix:** write the already-generated string straight to the clipboard, skipping
the live-DOM round-trip. Removes ~90% of the payload in every scenario, with zero data
or CSS loss.

---

## 2. How copy works today

```
handleCopy (src/sheet-engine/core/events/copy.ts)
  → copy(ctx)                          (src/sheet-engine/core/modules/selection.ts)
      → rangeValueToHtml(...)          builds the CLEAN html string
        (or getInlineStringHTML for rich text — cell.ts)
      → CLIPBOARD_HTML_SAFE_BYTES guard (selection.ts:2553)  strips only metadata
      → clipboard.writeHtml(cpdata)    (src/sheet-engine/core/modules/clipboard.ts)
          innerHTML = cpdata           into a contentEditable div…
          .fortune-container.append()  …mounted INSIDE the Tailwind app
          execCommand('selectAll')
          execCommand('copy')          browser re-serializes LIVE DOM → adds bloat
```

The clean string produced by `rangeValueToHtml` / `getInlineStringHTML` is correct and
reasonably compact. **The inflation happens only at the `execCommand('copy')` step**,
which ignores that string's text and instead serializes the mounted DOM's computed
style.

---

## 3. Scenarios tested & measurements

Four clipboard captures were compared byte-for-byte against Google Sheets copying the
same content.

| # | Scenario | Selection | Google | dsheet | Ratio |
|---|---|---|---|---|---|
| 1 | Empty cells | 3×6 | ~2.5 KB | ~62 KB | **~25×** |
| 2 | Empty cells + background color | 3×6 | ~2.9 KB | ~62 KB | **~21×** |
| 3 | Real data (multi-line text, colors, one merged cell) | 1×~9 | ~4–5 KB | ~140–160 KB | **~35×** |
| 4 | Whole-sheet select-all (mostly empty) | full grid | n/a | **~83 MB** | — |

Scenarios 1–2 byte-measured. Scenario 3 estimated from element counts
([Inference], not byte-measured). Scenario 4 reported from the field and confirmed
against a captured whole-sheet clipboard.

### Per-element cost

| Emitted element | Google | dsheet | Why dsheet bigger |
|---|---|---|---|
| empty `<td>` | 115 B | ~3,700 B | ~1.4 KB dead `--tw-*` block inlined |
| styled `<td>` | ~180 B | ~3,900 B | tw block + duplicated real style |
| each text run (one line) | 0 (plain text node) | ~1,450 B | wrapped in `<span>` + tw block |
| each newline | `<br>` (~5 B) | ~1,450 B | `<span style><br></span>` + tw block |
| `<colgroup>` / `<tr>` | width / height attr only | ~1,450 B each | tw block on every one |

---

## 4. Root cause

### 4.1 Primary — clipboard write re-serializes live DOM inside a Tailwind container

`clipboard.writeHtml` ([clipboard.ts:2](../src/sheet-engine/core/modules/clipboard.ts))
does not put the generated string on the clipboard. It:

1. sets the string as `innerHTML` of a contentEditable `<div id="fortune-copy-content">`,
2. appends that div to `.fortune-container` (the Tailwind app root),
3. runs `execCommand('selectAll')` + `execCommand('copy')`.

`execCommand('copy')` serializes the **live selection's computed style**. Mounted inside
`.fortune-container`, every element inherits the Tailwind base layer, so the browser
inlines onto **every** `<table>/<colgroup>/<tr>/<td>/<span>/<br>`:

- ~40 `--tw-*` custom properties (~1.4 KB), all empty/default
  (`--tw-pan-x: ;`, `--tw-ring-shadow: 0 0 #0000;`, `--tw-scale-x: 1;` …),
- plus `-webkit-font-smoothing`, `text-rendering: optimizelegibility`,
  `scrollbar-width`/`scrollbar-color`, `box-sizing`, `border-image: none`, and zeroed
  `padding`/`margin`.

None of this is meaningful style. It carries no data and does not change how dsheet,
Google Sheets, or Excel render a paste. It is pure serialization scaffolding, repeated
on every element.

### 4.2 Amplifiers (multiply the per-element cost above)

1. **Per-run / per-line `<span>` explosion.**
   `buildClipboardCompatibleInlineRuns`
   ([cell.ts:2523](../src/sheet-engine/core/modules/cell.ts)) wraps each text line in
   `<span style>…</span>` and each newline in `<span style><br></span>`:
   ```ts
   const segments = normalizedText.split('\n');
   // per segment:   <span style='${styleAttr}'>${segment}</span>
   // between:       <span style='${styleAttr}'><br></span>   // full style just for a <br>
   ```
   An N-line cell emits **2N−1 styled spans**, each then also receives the ~1.4 KB tw
   block. Bloat scales with **line count**, not just cell count. This is why Scenario 3
   is the worst case.

2. **Style triplication.** The same cell style is written three times: in the
   `data-fortune-cell` JSON, in the `<td>` inline style, and again in every child
   `<span>` style. `getInlineStringHTML`
   ([cell.ts:2565](../src/sheet-engine/core/modules/cell.ts)) even re-forces
   `fontWeight/fontStyle/fontSize/fontFamily` defaults onto each run.

3. **Empty cells fully styled.** `rangeValueToHtml`'s `cell == null` branch
   ([selection.ts:2305](../src/sheet-engine/core/modules/selection.ts)) still calls
   `getStyleByCell` and emits a styled `<td>` for every empty cell.

4. **Select-all spans the full allocated grid.** `selectAll`
   ([selection.ts:3459](../src/sheet-engine/core/modules/selection.ts)) uses
   `row: [0, flowdata.length-1], column: [0, flowdata[0].length-1]` — every allocated
   row × column, ~99% empty — instead of the used range. This is the ~83 MB case
   (Scenario 4): tens of thousands of empty cells, each styled and tw-inflated.

### 4.3 Why the existing guard doesn't help

`CLIPBOARD_HTML_SAFE_BYTES`
([selection.ts:2553](../src/sheet-engine/core/modules/selection.ts)) only strips
`data-fortune-cell` metadata, only when `includeCellMetadata` is true, and it measures
the **pre-execCommand** string. It never sees the inflated output that actually lands on
the clipboard, so it cannot bound it.

---

## 5. Per-scenario detail

### Scenario 1 — empty cells (3×6)
Pure structural overhead, no content. Every difference between 2.5 KB and 62 KB is the
`--tw-*` block: ~115 B/cell (Google) vs ~3,700 B/cell (dsheet). Confirms the bloat is
independent of content.

### Scenario 2 — empty cells + background color (3×6)
Adding a fill changed the ratio negligibly (~20 B/cell Google, ~15 B/cell dsheet). Two
notes:
- **Border comes from the computed render, not the data model.** With a black fill,
  dsheet's copied border flipped to `0.5pt solid rgb(0,0,0)` where the plain-empty cell
  had `0px solid rgb(233,236,237)`. Google always emits the semantic gridline
  `1px solid rgb(204,204,204)`. dsheet is capturing whatever the browser rendered, not
  what the cell stores — another consequence of copying live DOM. Direct-string
  generation would emit the cell's actual border, stable regardless of fill.
- dsheet uses the `background` shorthand; Google uses `background-color`. Both
  round-trip, but note it if any import path regex-matches `background-color`.

### Scenario 3 — real data, multi-line, colors, merge (1×~9)
dsheet's worst case; drives Issue 7 in the paste doc.
- A 4-line title cell ≈ 7 styled spans ≈ 15–25 KB in dsheet vs ~250 B in Google.
- Style stated 3× per cell (JSON + `<td>` + every `<span>`).
- Merge handled correctly by both: Google `<td rowspan="2">` + an empty
  `<tr style="height:21px">`; dsheet the same plus `mc:{r,c,rs,cs}` in JSON.
- Data-model inconsistencies observed in one copy (worth a cleanup):
  `tb` sometimes int (`2`) sometimes string (`"2"`); newlines `\r\n` everywhere except
  the `LUNCH\nBREAK` cell; `ff` here is the string `"PT Sans"` — so the `ff:0` numeric
  index (Issue 2 in the paste doc) is **sheet-specific**, not universal, and any
  consumer must handle both a numeric index and a string.

### Scenario 4 — whole-sheet select-all (~83 MB)
The three amplifiers compound: full-grid select-all × styled empty cells × tw inflation.
~57 k empty cells × ~1.4 KB each ≈ ~83 MB.

---

## 6. The "no loss" contract

Any fix must preserve both paste paths:

- **Internal (dsheet→dsheet)** is driven entirely by the `data-fortune-cell` JSON →
  **keep it verbatim.** Full fidelity as long as the JSON is intact.
- **External (dsheet→Google/Excel)** is driven by inline CSS → keep the **meaningful**
  properties only:
  `background`, `color`, `font-family`, `font-size`, `font-weight`, `font-style`,
  `text-decoration`, `text-align`, `vertical-align`, `border`, `<col width>`,
  `<tr>/<td>` height, and merges (`rowspan`/`colspan`).
- **Safe to drop** (external apps ignore them, render is unchanged): every `--tw-*`,
  `-webkit-font-smoothing`, `text-rendering`, `scrollbar-width`/`scrollbar-color`,
  `box-sizing`, `border-image: none`, and zeroed `padding`/`margin`.

---

## 7. Fix plan (phased)

**Phase 1 — stop the DOM re-serialization (≈90% of the win, safest).**
Write the string dsheet already built, without the contentEditable round-trip. Inside
the copy event:
```ts
e.clipboardData.setData('text/html', cpdata);
e.clipboardData.setData('text/plain', plain);
e.preventDefault();
```
or, if no native copy event is in scope,
`navigator.clipboard.write([new ClipboardItem({ 'text/html': …, 'text/plain': … })])`.
Same bytes dsheet generated → zero data/CSS loss; the browser never inlines anything.
*Open question before coding: confirm whether `handleCopy` runs inside a real `copy`
event (allows `clipboardData.setData`) or is called imperatively (requires
`navigator.clipboard.write`).*

**Phase 2 — don't over-emit empty cells.**
Emit style only for **non-default** properties. A truly-empty cell (no value, no
bg/border) → bare `<td></td>`. A bg-only empty cell (Scenario 2) still keeps its
`background`. Nothing lost.

**Phase 3 — clamp select-all to the used range.**
Compute the last row/col that actually holds data; copy only that. Trailing empty
rows/cols carry no data and no style → dropping them loses nothing. Kills Scenario 4.

**Phase 4 — collapse rich-text spans.**
Emit a `<span style>` only when a run's format **differs** from the cell default;
uniform cells → text + bare `<br>` in the `<td>`, zero spans. Drop the
`<span><br></span>` wrapper. Uniform runs inherit the `<td>` style → identical render.

---

## 8. How we prove nothing was lost

1. **Diff gate.** Parse old vs new clipboard HTML; assert every non-junk property
   present in the old output is present in the new one — only the
   tw/webkit/scrollbar/box-sizing set disappears.
2. **Internal round-trip.** dsheet copy → paste → assert the pasted cell data-model is
   deep-equal to the source.
3. **External visual.** Paste into Google Sheets and Excel; compare background, font,
   border, column width, row height, and merges.

---

## 9. Impact summary

| Fix | Removes | Loss risk |
|---|---|---|
| Phase 1 — direct write | ~90% (all `--tw-*` + framework defaults on every element) | none (junk only) |
| Phase 2 — empty-cell skip | styled empty `<td>`s | none (cells are empty) |
| Phase 3 — used-range clamp | the ~83 MB whole-sheet tail | none (trailing cells empty) |
| Phase 4 — span collapse | 2N−1 spans/cell + triplicated style | none (uniform runs inherit td) |

**Recommended order:** Phase 1 first — biggest payoff, smallest surface, and the diff
gate makes the "no loss" guarantee mechanical.
