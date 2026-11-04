import _ from 'lodash';

import type { Context } from '../context';
import type { Cell, CellWithRowAndCol } from '../types';
import { shouldPersistCelldataCell } from './cell-persist-utils';

/** Receives changes instead of the updateCellYdoc hook (see createYdocBatch). */
export type YdocChangeSink = (changes: any[]) => void;

/**
 * Collect the Yjs changes of one structural edit and send them in a single
 * updateCellYdoc call, so the edit is one transaction and one update for peers
 * (an insert used to send four and a delete five).
 */
export function createYdocBatch(ctx: Context): {
  sink: YdocChangeSink;
  flush: () => void;
} {
  const pending: any[] = [];
  return {
    sink: (changes) => {
      pending.push(...changes);
    },
    flush: () => {
      if (pending.length > 0 && ctx?.hooks?.updateCellYdoc) {
        ctx.hooks.updateCellYdoc(pending.splice(0));
      }
    },
  };
}

export type CelldataYdocChange = {
  sheetId: string;
  path: string[];
  key?: string;
  value: any;
  type?: 'update' | 'delete';
};

/** Cheap equality before deep compare — hot path for structural diffs. */
export function cellsEqualForYdocPersist(
  before: unknown,
  after: unknown,
): boolean {
  if (before === after) return true;
  if (before == null || after == null) return false;
  if (typeof before !== 'object' || typeof after !== 'object') {
    return before === after;
  }
  const a = before as Cell;
  const b = after as Cell;
  if (a.v !== b.v || a.f !== b.f || a.m !== b.m) return false;
  return _.isEqual(before, after);
}

function normalizeRange(
  data: unknown[][] | null | undefined,
  r1: number,
  r2: number,
  c1: number,
  c2: number,
) {
  if (!data?.length) return null;
  const rowEnd = Math.min(r2, data.length - 1);
  const colEnd = Math.min(c2, (data[0]?.length ?? 0) - 1);
  const rowStart = Math.max(0, r1);
  const colStart = Math.max(0, c1);
  if (rowStart > rowEnd || colStart > colEnd) return null;
  return { rowStart, rowEnd, colStart, colEnd };
}

/**
 * A formula cell is copied into a snapshot: a row/column insert or delete
 * rewrites `f` (and may set `v`/`m` to #REF!) on the live object, so a snapshot
 * that kept the object would compare the rewritten cell with itself and the
 * diff would write nothing. Other cells are not rewritten, so they are kept by
 * reference.
 */
function snapshotCell<T>(cell: T): T {
  return cell != null && typeof cell === 'object' && (cell as Cell).f != null
    ? ({ ...(cell as object) } as T)
    : cell;
}

/**
 * Snapshot persisted cells in a range.
 * Prefer sparse `celldata` when provided — O(populated cells), not O(range area).
 */
export function snapshotPersistedCelldataInRange(
  data: unknown[][] | null | undefined,
  r1: number,
  r2: number,
  c1: number,
  c2: number,
  celldata?: CellWithRowAndCol[] | null,
): Map<string, Cell | string | number | boolean> {
  const map = new Map<string, Cell | string | number | boolean>();
  const bounds = normalizeRange(data, r1, r2, c1, c2);
  if (!bounds) return map;
  const { rowStart, rowEnd, colStart, colEnd } = bounds;

  if (celldata?.length) {
    for (const entry of celldata) {
      if (
        entry.r < rowStart ||
        entry.r > rowEnd ||
        entry.c < colStart ||
        entry.c > colEnd
      ) {
        continue;
      }
      if (shouldPersistCelldataCell(entry.v)) {
        map.set(
          `${entry.r}_${entry.c}`,
          snapshotCell(entry.v) as Cell | string | number | boolean,
        );
      }
    }
    return map;
  }

  for (let r = rowStart; r <= rowEnd; r += 1) {
    const row = data![r];
    if (!row) continue;
    for (let c = colStart; c <= colEnd; c += 1) {
      const cell = row[c];
      if (cell == null) continue;
      if (shouldPersistCelldataCell(cell)) {
        map.set(
          `${r}_${c}`,
          snapshotCell(cell) as Cell | string | number | boolean,
        );
      }
    }
  }
  return map;
}

export function appendCelldataDiffChange(
  changes: CelldataYdocChange[],
  sheetId: string,
  r: number,
  c: number,
  cell: unknown,
  beforePersisted?: Map<string, Cell | string | number | boolean>,
): void {
  const mapKey = `${r}_${c}`;
  const beforeCell = beforePersisted?.get(mapKey);
  const hadBefore = beforePersisted?.has(mapKey) ?? false;
  const afterPersist = shouldPersistCelldataCell(
    cell as Cell | string | number | boolean | null,
  );

  if (afterPersist) {
    if (hadBefore && cellsEqualForYdocPersist(beforeCell, cell)) return;
    changes.push({
      sheetId,
      path: ['celldata'],
      value: { r, c, v: cell },
      key: mapKey,
      type: 'update',
    });
    return;
  }

  if (hadBefore) {
    changes.push({
      sheetId,
      path: ['celldata'],
      key: mapKey,
      value: null,
      type: 'delete',
    });
  }
}

export function buildCelldataChangesForRange(
  sheetId: string,
  data: unknown[][],
  r1: number,
  r2: number,
  c1: number,
  c2: number,
  beforePersisted?: Map<string, Cell | string | number | boolean>,
): CelldataYdocChange[] {
  const bounds = normalizeRange(data, r1, r2, c1, c2);
  if (!bounds) return [];

  const { rowStart, rowEnd, colStart, colEnd } = bounds;
  const changes: CelldataYdocChange[] = [];

  for (let r = rowStart; r <= rowEnd; r += 1) {
    const row = data[r];
    if (!row && !beforePersisted?.size) continue;
    for (let c = colStart; c <= colEnd; c += 1) {
      const cell = row?.[c] ?? null;
      const mapKey = `${r}_${c}`;
      if (
        cell == null &&
        !beforePersisted?.has(mapKey) &&
        !shouldPersistCelldataCell(cell)
      ) {
        continue;
      }
      appendCelldataDiffChange(
        changes,
        sheetId,
        r,
        c,
        cell,
        beforePersisted,
      );
    }
  }
  return changes;
}

export function emitCelldataRangeDiffToYdoc(
  ctx: Context,
  sheetId: string,
  data: unknown[][],
  r1: number,
  r2: number,
  c1: number,
  c2: number,
  beforePersisted?: Map<string, Cell | string | number | boolean>,
  sink?: YdocChangeSink,
): void {
  if (!ctx?.hooks?.updateCellYdoc) return;
  const changes = buildCelldataChangesForRange(
    sheetId,
    data,
    r1,
    r2,
    c1,
    c2,
    beforePersisted,
  );
  if (changes.length > 0) {
    (sink ?? ctx.hooks.updateCellYdoc)(changes);
  }
}

/** Formula text per tab and cell key, taken before a structural edit rewrites it. */
export type FormulaTextSnapshot = Map<string, Map<string, string>>;

/**
 * Snapshot formula text on every hydrated tab. A row/column insert or delete
 * rewrites formulas on all tabs, but only the edited tab's shifted range is
 * diffed to Yjs, so the rest has to be found by comparing against this.
 */
export function snapshotFormulaTexts(ctx: Context): FormulaTextSnapshot {
  const out: FormulaTextSnapshot = new Map();
  (ctx.luckysheetfile ?? []).forEach((sheet: any) => {
    const { data } = sheet;
    if (sheet.id == null) return;
    if (!data) {
      // A tab that is not hydrated keeps its cells in celldata (K6).
      if (!Array.isArray(sheet.celldata)) return;
      const celldataTexts = new Map<string, string>();
      sheet.celldata.forEach((entry: any) => {
        if (entry?.v?.f) celldataTexts.set(`${entry.r}_${entry.c}`, entry.v.f);
      });
      if (celldataTexts.size > 0) out.set(String(sheet.id), celldataTexts);
      return;
    }
    const texts = new Map<string, string>();
    for (let r = 0; r < data.length; r += 1) {
      const row = data[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c += 1) {
        const f = row[c]?.f;
        if (f) texts.set(`${r}_${c}`, f);
      }
    }
    if (texts.size > 0) out.set(String(sheet.id), texts);
  });
  return out;
}

/**
 * Emit cells whose formula text changed since `before`, so peers see the
 * rewrite. On the edited tab, cells at or past (`editedFromR`, `editedFromC`)
 * are skipped: the range diff already writes them. `before` keys are
 * pre-edit coordinates, which equal post-edit ones for every cell outside
 * that range.
 */
export function emitRewrittenFormulasToYdoc(
  ctx: Context,
  before: FormulaTextSnapshot,
  editedSheetId: string,
  editedFromR: number,
  editedFromC: number,
  sink?: YdocChangeSink,
): void {
  if (!ctx?.hooks?.updateCellYdoc || before.size === 0) return;
  const changes: CelldataYdocChange[] = [];
  (ctx.luckysheetfile ?? []).forEach((sheet: any) => {
    const texts = before.get(String(sheet.id));
    if (!texts || (!sheet.data && !Array.isArray(sheet.celldata))) return;
    const isEdited = String(sheet.id) === String(editedSheetId);
    const celldataByKey = sheet.data
      ? null
      : new Map<string, any>(
          sheet.celldata.map((entry: any) => [`${entry?.r}_${entry?.c}`, entry]),
        );
    texts.forEach((oldF, key) => {
      const sep = key.indexOf('_');
      const r = Number(key.slice(0, sep));
      const c = Number(key.slice(sep + 1));
      if (isEdited && (r >= editedFromR || c >= editedFromC)) return;
      const cell = sheet.data
        ? sheet.data[r]?.[c]
        : celldataByKey!.get(key)?.v;
      if (!cell?.f || cell.f === oldF) return;
      changes.push({
        sheetId: String(sheet.id),
        path: ['celldata'],
        value: { r, c, v: cell },
        key,
        type: 'update',
      });
    });
  });
  if (changes.length > 0) {
    (sink ?? ctx.hooks.updateCellYdoc)(changes);
  }
}

/**
 * After delete row/col, emit deletes for persisted keys that now sit past the
 * shrunken grid. Range diffs only visit coordinates still inside `data`, so
 * tail keys would otherwise resurrect on peers/reload.
 */
export function emitCelldataDeletesBeyondGrid(
  ctx: Context,
  sheetId: string,
  beforePersisted: Map<string, Cell | string | number | boolean> | undefined,
  rowCount: number,
  colCount: number,
  sink?: YdocChangeSink,
): void {
  if (!ctx?.hooks?.updateCellYdoc || !beforePersisted?.size) return;
  if (rowCount < 0 || colCount < 0) return;

  const changes: CelldataYdocChange[] = [];
  for (const key of beforePersisted.keys()) {
    const sep = key.lastIndexOf('_');
    if (sep <= 0) continue;
    const r = Number(key.slice(0, sep));
    const c = Number(key.slice(sep + 1));
    if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
    if (r >= rowCount || c >= colCount) {
      changes.push({
        sheetId,
        path: ['celldata'],
        key,
        value: null,
        type: 'delete',
      });
    }
  }
  if (changes.length > 0) {
    (sink ?? ctx.hooks.updateCellYdoc)(changes);
  }
}

export type MergeBounds = {
  minR: number;
  minC: number;
  maxR: number;
  maxC: number;
};

/** Disturbed range for insert row/col — snapshot only rows/cols that may shift. */
export function getInsertRowColSnapshotBounds(
  type: 'row' | 'column',
  index: number,
  direction: 'lefttop' | 'rightbottom',
  rowCount: number,
  colCount: number,
  mergeBounds: MergeBounds | null,
): { r1: number; r2: number; c1: number; c2: number } {
  const r2 = Math.max(0, rowCount - 1);
  const c2 = Math.max(0, colCount - 1);
  if (type === 'row') {
    const baseStart = direction === 'lefttop' ? index : index + 1;
    const r1 = mergeBounds ? Math.min(baseStart, mergeBounds.minR) : baseStart;
    return { r1: Math.max(0, r1), r2, c1: 0, c2 };
  }
  const baseStart = direction === 'lefttop' ? index : index + 1;
  const c1 = mergeBounds ? Math.min(baseStart, mergeBounds.minC) : baseStart;
  return { r1: 0, r2, c1: Math.max(0, c1), c2 };
}

/** Disturbed range for delete row/col — from deletion point to sheet edge. */
export function getDeleteRowColSnapshotBounds(
  type: 'row' | 'column',
  start: number,
  rowCount: number,
  colCount: number,
  mergeBounds: MergeBounds | null,
): { r1: number; r2: number; c1: number; c2: number } {
  const r2 = Math.max(0, rowCount - 1);
  const c2 = Math.max(0, colCount - 1);
  if (type === 'row') {
    const r1 = mergeBounds ? Math.min(start, mergeBounds.minR) : start;
    return { r1: Math.max(0, r1), r2, c1: 0, c2 };
  }
  const c1 = mergeBounds ? Math.min(start, mergeBounds.minC) : start;
  return { r1: 0, r2, c1: Math.max(0, c1), c2 };
}
