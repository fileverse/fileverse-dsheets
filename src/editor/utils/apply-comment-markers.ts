import { CELL_COMMENT_DEFAULT_VALUE } from '../constants/shared-constants';

type CommentData = object | null | undefined;

/**
 * Resolves a comment for a cell using the three historical key formats.
 *
 * Comment keys are built as `${sheet.id | order | index}_${row}_${col}` in the
 * host app. `id` (UUID) is the modern, reorder-safe primary key; `order` and the
 * array `index` are kept as fallbacks for legacy keys.
 */
const resolveComment = (
  commentData: CommentData,
  sheetKey: string,
  sheetOrder: number,
  index: number,
  row: number,
  col: number,
): unknown =>
  // Primary: UUID-based key (new, immutable)
  (commentData as any)?.[`${sheetKey}_${row}_${col}`] ??
  // Legacy: order-based key (old, breaks on reorder)
  (commentData as any)?.[`${sheetOrder}_${row}_${col}`] ??
  // Very-old: array-index fallback
  (commentData as any)?.[`${index}_${row}_${col}`];

/**
 * Stamps the in-cell comment marker (`cell.ps`) onto sheet data, derived from
 * the consumer-provided `commentData`.
 *
 * `ps` is a per-client, permission-gated *view overlay* — it is NOT persisted in
 * ydoc (`shouldPersistCelldataCell` ignores marker-only cells). Empty cells are
 * `null`, so a tiny `{ ps }` object is created in the live view only so the
 * triangle can render. Row/column drag still owns real cell data.
 *
 * Mutates in place and returns the same array.
 */
export const applyCommentMarkers = <T>(
  sheets: T | null | undefined,
  commentData: CommentData,
  allowComments: boolean | undefined,
): T | null | undefined => {
  if (!Array.isArray(sheets)) return sheets;
  const commentCount =
    commentData && typeof commentData === 'object'
      ? Object.keys(commentData as object).length
      : 0;
  // Empty commentData is "not loaded yet". Do not walk cells and clear `ps`.
  if (!commentCount) return sheets;

  (sheets as any[]).forEach((sheet, index) => {
    if (!sheet) return;
    const sheetKey = (sheet.id as any)?.toString?.() ?? String(index);
    const sheetOrder = typeof sheet.order === 'number' ? sheet.order : index;

    const markerFor = (row: number, col: number) => {
      const comment = resolveComment(
        commentData,
        sheetKey,
        sheetOrder,
        index,
        row,
        col,
      );
      // Fresh object per cell: `ps` is mutated by the library on interaction
      // (isShow/left/top/…), so cells must not share one reference.
      return comment && allowComments
        ? { ...CELL_COMMENT_DEFAULT_VALUE }
        : undefined;
    };

    const commentedCells: Array<[number, number]> = [];
    if (commentData && allowComments) {
      const prefixes = new Set([sheetKey, String(sheetOrder), String(index)]);
      Object.keys(commentData as Record<string, unknown>).forEach((key) => {
        const parts = key.split('_');
        if (parts.length !== 3) return;
        const [prefix, rowStr, colStr] = parts;
        if (!prefixes.has(prefix)) return;
        const row = Number(rowStr);
        const col = Number(colStr);
        if (Number.isNaN(row) || Number.isNaN(col)) return;
        commentedCells.push([row, col]);
      });
    }

    // Active sheet: dense data grid.
    if (Array.isArray(sheet.data)) {
      sheet.data.forEach((rowArr: any[], row: number) => {
        rowArr?.forEach((cell: any, col: number) => {
          if (!cell) return;
          try {
            cell.ps = markerFor(row, col);
          } catch {
            // Frozen snapshot — do not clone or replace sheet data.
          }
        });
      });
      // Empty cells are `null`, so the loop above skipped them. Place a
      // view-only marker object so the triangle shows. These are not written
      // to ydoc.
      commentedCells.forEach(([row, col]) => {
        const rowArr = (sheet.data as any[])[row];
        if (!rowArr) return;
        if (rowArr[col]) return;
        try {
          rowArr[col] = { ps: { ...CELL_COMMENT_DEFAULT_VALUE } };
        } catch {
          // Frozen row — skip rather than cloning the grid.
        }
      });
      return;
    }

    // Inactive sheets / plain snapshots: sparse celldata.
    if (Array.isArray(sheet.celldata)) {
      sheet.celldata.forEach((entry: any) => {
        if (!entry?.v) return;
        try {
          entry.v.ps = markerFor(entry.r, entry.c);
        } catch {
          // Frozen snapshot — do not clone or replace sheet data.
        }
      });
      const present = new Set(
        (sheet.celldata as any[]).map((e) => `${e?.r}_${e?.c}`),
      );
      commentedCells.forEach(([row, col]) => {
        if (present.has(`${row}_${col}`)) return;
        try {
          (sheet.celldata as any[]).push({
            r: row,
            c: col,
            v: { ps: { ...CELL_COMMENT_DEFAULT_VALUE } },
          });
        } catch {
          // Frozen celldata — skip rather than cloning the grid.
        }
      });
    }
  });

  return sheets;
};
