import type { Context, GlobalCache } from '@sheet-engine/core';

export type HoverCell = { row: number; col: number } | null;

type Rect = { left: number; top: number; width: number; height: number };

type HoverTrackerOptions = {
  /** Position of the cell area; read at most once per animation frame. */
  getRect: () => Rect | undefined;
  /** Cell under a page position, or null outside the cell area. */
  locate: (pageX: number, pageY: number, rect: Rect | undefined) => HoverCell;
  /** True while a drag, resize or popup needs every mouse move. */
  isInteracting: () => boolean;
  requestFrame: (cb: () => void) => void;
};

/**
 * Decides whether a mouse move needs the full `setContext` pass. A move that
 * stays in the same cell, with nothing being dragged or hovered, changes
 * nothing, so it is skipped (E1).
 */
export function createHoverTracker({
  getRect,
  locate,
  isInteracting,
  requestFrame,
}: HoverTrackerOptions) {
  let lastCell: HoverCell | undefined;
  let frameRect: Rect | undefined;
  let frameRectValid = false;

  const rectForThisFrame = () => {
    if (!frameRectValid) {
      frameRect = getRect();
      frameRectValid = true;
      requestFrame(() => {
        frameRectValid = false;
      });
    }
    return frameRect;
  };

  const sameCell = (a: HoverCell | undefined, b: HoverCell) =>
    a !== undefined &&
    (a === null || b === null ? a === b : a.row === b.row && a.col === b.col);

  return {
    shouldProcess(e: { pageX: number; pageY: number }): boolean {
      if (isInteracting()) {
        lastCell = undefined;
        return true;
      }
      const cell = locate(e.pageX, e.pageY, rectForThisFrame());
      if (sameCell(lastCell, cell)) return false;
      lastCell = cell;
      return true;
    },
    reset() {
      lastCell = undefined;
    },
  };
}

/**
 * True when `handleOverlayMouseMove` or `overShowLinkCard` do something that
 * depends on more than the hovered cell: a comment box, image, cell or dialog
 * drag, or a popup that must see the pointer leave it.
 */
export function isHoverInteractionActive(
  ctx: Context,
  globalCache: GlobalCache,
): boolean {
  const commentBox = globalCache?.commentBox;
  return !!(
    commentBox?.resizingId ||
    commentBox?.movingId ||
    globalCache?.image ||
    globalCache?.searchDialog?.moveProps ||
    globalCache?.linkCard?.rangeSelectionModal ||
    ctx.luckysheet_cell_selected_move ||
    ctx.hoveredCommentBox ||
    ctx.editingCommentBox ||
    ctx.hoverErrorBox ||
    ctx.linkCard
  );
}
