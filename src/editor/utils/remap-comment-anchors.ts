import type { CommentAnchorMove } from '../../sheet-engine/core/settings';
import { parseCellKey } from './comment-key-utils';

const matchesSheet = (
  parsedSheetId: string | undefined,
  move: CommentAnchorMove,
): boolean => {
  if (parsedSheetId == null) return false;
  if (move.sheetKeys?.length) {
    return move.sheetKeys.includes(parsedSheetId);
  }
  return parsedSheetId === move.sheetId;
};

const inRange = (
  row: number,
  col: number,
  range: { row: [number, number]; column: [number, number] },
): boolean =>
  row >= range.row[0] &&
  row <= range.row[1] &&
  col >= range.column[0] &&
  col <= range.column[1];

const cellKey = (sheetId: string, row: number, col: number) =>
  `${sheetId}_${row}_${col}`;

const withKey = <T extends { key?: string }>(comment: T, newKey: string): T =>
  newKey === comment.key ? comment : { ...comment, key: newKey };

/**
 * old cell-key → new cell-key, matched by comment id. Used when writing
 * ydoc aliases so indexer keys still resolve after a remap.
 */
export function commentKeyMovesById<T extends { id?: string; key?: string }>(
  before: Record<string, T>,
  after: Record<string, T>,
): Record<string, string> {
  const nextById = new Map<string, string>();
  for (const comment of Object.values(after)) {
    if (comment?.id && comment.key) nextById.set(comment.id, comment.key);
  }
  const keyMoves: Record<string, string> = {};
  for (const [oldKey, comment] of Object.entries(before)) {
    if (!comment?.id) continue;
    const newKey = nextById.get(comment.id);
    if (newKey && newKey !== oldKey) keyMoves[oldKey] = newKey;
  }
  return keyMoves;
}

type NextCoord = (
  row: number,
  col: number,
) => { row: number; col: number } | 'detach';

function remapByPosition<T extends { key?: string; id?: string }>(
  commentsData: Record<string, T>,
  move: CommentAnchorMove,
  nextCoord: NextCoord,
  detachPrefix: string,
): Record<string, T> {
  const next: Record<string, T> = {};
  let changed = false;
  const displaced: T[] = [];
  for (const [key, comment] of Object.entries(commentsData)) {
    const parsed = parseCellKey(key);
    if (!parsed || !matchesSheet(parsed.sheetId, move)) {
      next[key] = comment;
      continue;
    }
    const mapped = nextCoord(parsed.row, parsed.col);
    if (mapped === 'detach') {
      changed = true;
      displaced.push(comment);
      continue;
    }
    const newKey = cellKey(
      parsed.sheetId ?? move.sheetId,
      mapped.row,
      mapped.col,
    );
    if (newKey !== key) changed = true;
    next[newKey] = withKey(comment, newKey);
  }
  displaced.forEach((comment, i) => {
    const withoutKey = `WITHOUT_CELL_${comment.id || `${detachPrefix}_${i}`}`;
    next[withoutKey] = { ...comment, key: withoutKey };
  });
  return changed ? next : commentsData;
}

/**
 * Remap in-memory comment keys after a row/column drag, cell-range move,
 * or insert/delete of rows/columns.
 *
 * - Row/column drag: apply the full permutation `indexMap` (no collisions).
 * - Cells: comments in the source rectangle follow the offset; comments that
 *   only lived in the destination are detached to `WITHOUT_CELL_<id>` so they
 *   remain in the sidebar instead of colliding with the incoming thread.
 * - Insert: comments at/after the insertion point shift by `count`.
 * - Delete: comments on removed rows/cols are detached; later ones shift up/left.
 */
export function remapCommentAnchors<T extends { key?: string; id?: string }>(
  commentsData: Record<string, T>,
  move: CommentAnchorMove,
): Record<string, T> {
  if (Object.keys(commentsData).length === 0) return commentsData;

  if (move.type === 'insert') {
    if (move.count <= 0) return commentsData;
    const shiftStart =
      move.direction === 'lefttop' ? move.index : move.index + 1;
    return remapByPosition(
      commentsData,
      move,
      (row, col) => ({
        row:
          move.axis === 'row' && row >= shiftStart ? row + move.count : row,
        col:
          move.axis === 'column' && col >= shiftStart
            ? col + move.count
            : col,
      }),
      'deleted',
    );
  }

  if (move.type === 'delete') {
    const slen = move.end - move.start + 1;
    if (slen <= 0) return commentsData;
    return remapByPosition(
      commentsData,
      move,
      (row, col) => {
        const idx = move.axis === 'row' ? row : col;
        if (idx >= move.start && idx <= move.end) return 'detach';
        return {
          row: move.axis === 'row' && row > move.end ? row - slen : row,
          col: move.axis === 'column' && col > move.end ? col - slen : col,
        };
      },
      'deleted',
    );
  }

  if (move.type !== 'cells') {
    return remapByPosition(
      commentsData,
      move,
      (row, col) => ({
        row: move.type === 'row' ? (move.indexMap[row] ?? row) : row,
        col: move.type === 'column' ? (move.indexMap[col] ?? col) : col,
      }),
      'deleted',
    );
  }

  const rowOffset = move.target.row[0] - move.source.row[0];
  const colOffset = move.target.column[0] - move.source.column[0];
  if (rowOffset === 0 && colOffset === 0) return commentsData;

  return remapByPosition(
    commentsData,
    move,
    (row, col) => {
      if (inRange(row, col, move.source)) {
        return { row: row + rowOffset, col: col + colOffset };
      }
      if (inRange(row, col, move.target)) return 'detach';
      return { row, col };
    },
    'displaced',
  );
}

export type { CommentAnchorMove };
