import type { Cell } from '../../../core/types';

export type ShownCommentCell = { r: number; c: number };

/** Cells whose comment popup is pinned open (`ps.isShow`), in row-major order. */
export function collectShownCommentCells(
  data: (Cell | null)[][],
): ShownCommentCell[] {
  const cells: ShownCommentCell[] = [];
  for (let r = 0; r < data.length; r += 1) {
    const row = data[r];
    if (row) {
      for (let c = 0; c < row.length; c += 1) {
        if (row[c]?.ps?.isShow) cells.push({ r, c });
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
 * boxes.
 */
export function shownCommentsKey(
  sheetId: string | undefined,
  cells: ShownCommentCell[],
): string {
  return `${sheetId ?? ''}|${cells.map(({ r, c }) => `${r}_${c}`).join(',')}`;
}
