import type { Cell } from '../../../core/types';

export type ShownCommentCell = {
  r: number;
  c: number;
  /** Position, size and text of the pinned box (see `shownCommentsKey`). */
  sig: string;
};

/** Cells whose comment popup is pinned open (`ps.isShow`), in row-major order. */
export function collectShownCommentCells(
  data: (Cell | null)[][],
): ShownCommentCell[] {
  const cells: ShownCommentCell[] = [];
  for (let r = 0; r < data.length; r += 1) {
    const row = data[r];
    if (row) {
      for (let c = 0; c < row.length; c += 1) {
        const ps = row[c]?.ps;
        if (ps?.isShow) {
          cells.push({
            r,
            c,
            sig: `${ps.left}:${ps.top}:${ps.width}:${ps.height}:${ps.value}`,
          });
        }
      }
    }
  }
  return cells;
}

/**
 * Identity of a shown-comment set. NotationBoxes applies `showComments` only
 * when this changes, so an edit that leaves the set alone costs no second
 * context update. The sheet id is part of the key so that switching to a sheet
 * with an equal (for example empty) set still replaces the previous sheet's
 * boxes. Moving or resizing a pinned box, or a peer editing its text, writes
 * `ps` but not `commentBoxes`, so each shown cell's `ps` position, size and
 * text are part of the key too.
 */
export function shownCommentsKey(
  sheetId: string | undefined,
  cells: ShownCommentCell[],
): string {
  return `${sheetId ?? ''}|${cells.map(({ r, c, sig }) => `${r}_${c}@${sig}`).join(',')}`;
}
