import type { CommentAnchorMove } from '../settings';

/**
 * Build oldIndex → newIndex for a contiguous block move (row or column drag).
 * `targetIndex` is the insertion index *after* the block has been removed,
 * matching the splice used on the sheet data.
 */
export function buildBlockMoveIndexMap(
  length: number,
  sourceStart: number,
  moveCount: number,
  targetIndex: number,
): Record<number, number> {
  if (length <= 0 || moveCount <= 0) return {};
  const order = Array.from({ length }, (_, i) => i);
  const moved = order.splice(sourceStart, moveCount);
  let insertAt = targetIndex;
  if (insertAt < 0) insertAt = 0;
  if (insertAt > order.length) insertAt = order.length;
  order.splice(insertAt, 0, ...moved);
  const map: Record<number, number> = {};
  order.forEach((oldIdx, newIdx) => {
    map[oldIdx] = newIdx;
  });
  return map;
}

export function getSheetCommentKeyPrefixes(
  sheet: { id?: string; order?: number } | null | undefined,
  sheetIndex: number,
): string[] {
  const keys = new Set<string>();
  if (sheet?.id != null && String(sheet.id).length > 0) {
    keys.add(String(sheet.id));
  }
  if (typeof sheet?.order === 'number') {
    keys.add(String(sheet.order));
  }
  if (Number.isFinite(sheetIndex)) {
    keys.add(String(sheetIndex));
  }
  return [...keys];
}

export function notifyCommentAnchorMove(
  ctx: { hooks?: { afterCommentAnchorMove?: (move: CommentAnchorMove) => void } },
  move: CommentAnchorMove,
): void {
  const fn = ctx.hooks?.afterCommentAnchorMove;
  if (!fn) return;
  // Must run in the same turn as the row/column splice. A microtask lets
  // ydoc cell persist encode *before* remapped anchors are written, so
  // viewers load new cells with stale comment positions.
  try {
    fn(move);
  } catch (err) {
    console.error('[comments] afterCommentAnchorMove failed', err);
  }
}
