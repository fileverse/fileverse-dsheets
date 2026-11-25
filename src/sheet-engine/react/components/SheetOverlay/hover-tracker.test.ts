import { describe, expect, it, vi } from 'vitest';
import { createHoverTracker, isHoverInteractionActive } from './hover-tracker';

const RECT = { left: 0, top: 0, width: 1000, height: 600 };

// 100 x 20 px cells; points beyond the rect are "outside".
const locate = (x: number, y: number) =>
  x < 0 || y < 0 || x >= RECT.width || y >= RECT.height
    ? null
    : { row: Math.floor(y / 20), col: Math.floor(x / 100) };

const setup = (interacting = false) => {
  const frames: (() => void)[] = [];
  const getRect = vi.fn(() => RECT);
  let busy = interacting;
  const tracker = createHoverTracker({
    getRect,
    locate: (x, y) => locate(x, y),
    isInteracting: () => busy,
    requestFrame: (cb) => {
      frames.push(cb);
    },
  });
  const nextFrame = () => frames.splice(0).forEach((cb) => cb());
  return {
    tracker,
    getRect,
    nextFrame,
    setBusy: (v: boolean) => {
      busy = v;
    },
  };
};

const move = (x: number, y: number) => ({ pageX: x, pageY: y });

describe('hover tracker', () => {
  it('reports one change for three moves inside one cell', () => {
    const { tracker } = setup();
    expect(tracker.shouldProcess(move(110, 5))).toBe(true);
    expect(tracker.shouldProcess(move(120, 8))).toBe(false);
    expect(tracker.shouldProcess(move(150, 12))).toBe(false);
  });

  it('reports another change when the pointer crosses into a new cell', () => {
    const { tracker } = setup();
    tracker.shouldProcess(move(110, 5));
    expect(tracker.shouldProcess(move(210, 5))).toBe(true);
    expect(tracker.shouldProcess(move(110, 45))).toBe(true);
  });

  it('reports every move while a drag, resize or popup is active', () => {
    const { tracker } = setup(true);
    expect(tracker.shouldProcess(move(110, 5))).toBe(true);
    expect(tracker.shouldProcess(move(111, 5))).toBe(true);
    expect(tracker.shouldProcess(move(112, 5))).toBe(true);
  });

  it('processes the first move after an interaction ends, even in the same cell', () => {
    const { tracker, setBusy } = setup();
    tracker.shouldProcess(move(110, 5));
    setBusy(true);
    tracker.shouldProcess(move(111, 5));
    setBusy(false);
    expect(tracker.shouldProcess(move(112, 5))).toBe(true);
    expect(tracker.shouldProcess(move(113, 5))).toBe(false);
  });

  it('reads the cell-area rect once per animation frame', () => {
    const { tracker, getRect, nextFrame } = setup();
    tracker.shouldProcess(move(110, 5));
    tracker.shouldProcess(move(210, 5));
    tracker.shouldProcess(move(310, 5));
    expect(getRect).toHaveBeenCalledTimes(1);
    nextFrame();
    tracker.shouldProcess(move(410, 5));
    expect(getRect).toHaveBeenCalledTimes(2);
  });

  it('does not read the rect at all while interacting', () => {
    const { tracker, getRect } = setup(true);
    tracker.shouldProcess(move(110, 5));
    expect(getRect).not.toHaveBeenCalled();
  });

  it('treats leaving the cell area as one change, then ignores moves outside it', () => {
    const { tracker } = setup();
    tracker.shouldProcess(move(110, 5));
    expect(tracker.shouldProcess(move(1500, 5))).toBe(true);
    expect(tracker.shouldProcess(move(1600, 9))).toBe(false);
  });

  it('processes the next move after reset()', () => {
    const { tracker } = setup();
    tracker.shouldProcess(move(110, 5));
    tracker.reset();
    expect(tracker.shouldProcess(move(112, 6))).toBe(true);
  });
});

describe('isHoverInteractionActive', () => {
  const idle = { ctx: {} as any, globalCache: {} as any };

  it('is false with nothing in progress', () => {
    expect(isHoverInteractionActive(idle.ctx, idle.globalCache)).toBe(false);
  });

  it.each([
    [
      'comment box resizing',
      {},
      { commentBox: { resizingId: 'c', resizingSide: 'l' } },
    ],
    ['comment box moving', {}, { commentBox: { movingId: 'c' } }],
    ['image in progress', {}, { image: {} }],
    ['search dialog moving', {}, { searchDialog: { moveProps: {} } }],
    ['range selection modal', {}, { linkCard: { rangeSelectionModal: {} } }],
    ['cells being dragged', { luckysheet_cell_selected_move: true }, {}],
    ['hover comment popup open', { hoveredCommentBox: { rc: '1_1' } }, {}],
    ['editing comment popup open', { editingCommentBox: { rc: '1_1' } }, {}],
    ['hover error popup open', { hoverErrorBox: { row_column: '1_1' } }, {}],
    ['link card shown', { linkCard: { r: 1, c: 1 } }, {}],
    // PR 466 round 4 (N3): handleOverlayMouseMove runs mouseRender on every
    // move in these states (mouse.ts, the chain after the commented block).
    ['a drag in progress (scroll status)', { luckysheet_scroll_status: true }, {}],
    ['drag-select', { luckysheet_select_status: true }, {}],
    ['row header drag', { luckysheet_rows_selected_status: true }, {}],
    ['column header drag', { luckysheet_cols_selected_status: true }, {}],
    ['fill handle drag', { luckysheet_cell_selected_extend: true }, {}],
    ['column resize', { luckysheet_cols_change_size: true }, {}],
    ['row resize', { luckysheet_rows_change_size: true }, {}],
    ['column freeze line drag', { luckysheet_cols_freeze_drag: true }, {}],
    ['row freeze line drag', { luckysheet_rows_freeze_drag: true }, {}],
  ])('is true for %s', (_name, ctx, globalCache) => {
    expect(isHoverInteractionActive(ctx as any, globalCache as any)).toBe(true);
  });
});

describe('moves outside the grid during a drag (N3)', () => {
  it('processes every move below the grid while drag-selecting', () => {
    const frames: (() => void)[] = [];
    const ctx: any = { luckysheet_select_status: true, luckysheet_scroll_status: true };
    const tracker = createHoverTracker({
      getRect: () => RECT,
      locate: (x, y) => locate(x, y),
      isInteracting: () => isHoverInteractionActive(ctx, {} as any),
      requestFrame: (cb) => {
        frames.push(cb);
      },
    });
    const results = [0, 1, 2, 3, 4].map((i) =>
      tracker.shouldProcess(move(300, 700 + i * 10)),
    );
    expect(results).toEqual([true, true, true, true, true]);
  });
});
