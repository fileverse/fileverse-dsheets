import _ from "lodash";
import { Cell } from "../types";

export const CELL_FORMAT_ATTRS = [
  "tb",
  "ht",
  "vt",
  "tr",
  "fs",
  "ff",
  "fc",
  "bl",
  "it",
  "un",
  "cl",
  "bg",
  "ct",
] as const;

export type CellFormatAttr = (typeof CELL_FORMAT_ATTRS)[number];

export function hasCellMeaningfulContent(
  cell: Cell | string | number | boolean | null | undefined,
): boolean {
  if (cell == null) return false;
  if (typeof cell !== "object") {
    return cell !== "";
  }

  const innerV = cell.v;
  if (innerV != null && innerV !== "") return true;
  if (typeof cell.f === "string" && cell.f.length > 0) return true;
  // Merge anchors and shadow refs must stay in celldata so peers/reload
  // keep merge hit-testing. config.merge alone is not enough for canvas.
  if (cell.mc != null) return true;
  if (cell.hl != null) return true;
  // Do not persist `ps`. Fileverse comments live in the host store and are
  // remapped by cell key; treating marker-only cells as data is what made
  // viewers diverge from the owner after row/column drag.
  if (typeof cell.m === "string" && cell.m.length > 0) return true;

  const inline = cell.ct?.s;
  if (Array.isArray(inline) && inline.length > 0) {
    return inline.some((part) => {
      const text = part?.v;
      return text != null && String(text).length > 0;
    });
  }

  return false;
}

export function isFormatOnlyEmptyCell(
  cell: Cell | string | number | boolean | null | undefined,
): boolean {
  if (cell == null || typeof cell !== "object") return false;
  if (hasCellMeaningfulContent(cell)) return false;
  return CELL_FORMAT_ATTRS.some((key) => {
    if (key === "ct") return cell.ct != null;
    return (cell as Record<string, unknown>)[key] != null;
  });
}

/** Pull only present format attrs from a format-only empty cell (cheap, no clone). */
export function extractCellFormatAttrs(
  cell: Cell | string | number | boolean | null | undefined,
): Partial<Record<CellFormatAttr, unknown>> | null {
  if (!isFormatOnlyEmptyCell(cell)) return null;
  const source = cell as Record<string, unknown>;
  const attrs: Partial<Record<CellFormatAttr, unknown>> = {};
  let any = false;
  for (let i = 0; i < CELL_FORMAT_ATTRS.length; i += 1) {
    const key = CELL_FORMAT_ATTRS[i];
    const value = source[key];
    if (value != null) {
      attrs[key] = value;
      any = true;
    }
  }
  return any ? attrs : null;
}

export function shouldPersistCelldataCell(
  cell: Cell | string | number | boolean | null | undefined,
): boolean {
  if (cell == null) return false;
  if (typeof cell !== "object") return true;
  return hasCellMeaningfulContent(cell);
}

// Cell format attrs that getStyleByCell (modules/cell.ts) emits as CSS and
// buildCellFromTd (paste-table-helpers.ts) parses back. Kept in sync with those
// two functions: emitting a new attr as CSS on the copy side AND parsing it on
// the paste side means adding the attr here. `ct` (number format) and `tr`
// (rotation) are intentionally excluded — the emitted <td> CSS has no channel
// for them, so a cell carrying them must keep its `data-fortune-cell` blob.
export const CSS_SAFE_CLIPBOARD_ATTRS = [
  "bg",
  "ht",
  "tb",
  "ff",
  "vt",
  "fs",
  "fc",
  "bl",
  "it",
  "un",
  "cl",
] as const;

const CSS_SAFE_CLIPBOARD_ATTR_SET = new Set<string>(CSS_SAFE_CLIPBOARD_ATTRS);

/**
 * True when a cell's `data-fortune-cell` clipboard blob is redundant: the cell
 * has no persistable content and its only format attrs are ones the emitted
 * `<td>` CSS already carries, so cross-document paste reconstructs it losslessly
 * from CSS alone. Cells with content, or with a non-CSS format channel
 * (`ct` / `tr`), return false and keep their blob.
 */
export function isClipboardMetadataRedundant(
  cell: Cell | string | number | boolean | null | undefined,
): boolean {
  if (shouldPersistCelldataCell(cell)) return false;
  const attrs = extractCellFormatAttrs(cell);
  if (attrs == null) return true;
  return Object.keys(attrs).every((key) =>
    CSS_SAFE_CLIPBOARD_ATTR_SET.has(key),
  );
}

export function celldataEntryEqual(existing: unknown, next: unknown): boolean {
  if (existing === next) return true;
  if (existing == null || next == null) return false;

  const existingEntry = existing as { r?: number; c?: number; v?: unknown };
  const nextEntry = next as { r?: number; c?: number; v?: unknown };

  // This comparator is only valid for sparse celldata entries. Without this
  // guard, arbitrary objects/arrays that lack r/c (e.g. cellFormatRanges)
  // compare as equal because both coordinates are undefined, causing their
  // Yjs write to be skipped.
  if (
    typeof existingEntry.r !== "number" ||
    typeof existingEntry.c !== "number" ||
    typeof nextEntry.r !== "number" ||
    typeof nextEntry.c !== "number"
  ) {
    return false;
  }

  return (
    existingEntry.r === nextEntry.r &&
    existingEntry.c === nextEntry.c &&
    _.isEqual(existingEntry.v, nextEntry.v)
  );
}
