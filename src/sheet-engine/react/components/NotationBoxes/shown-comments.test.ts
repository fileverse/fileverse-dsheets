import { describe, expect, it } from 'vitest';
import { collectShownCommentCells, shownCommentsKey } from './shown-comments';

const grid = (shown: [number, number][], other: [number, number][] = []) => {
  const data: any[][] = Array.from({ length: 5 }, () => Array(5).fill(null));
  shown.forEach(([r, c]) => {
    data[r][c] = { v: 1, ps: { isShow: true, value: 'x' } };
  });
  other.forEach(([r, c]) => {
    data[r][c] = { v: 1, ps: { isShow: false, value: 'x' } };
  });
  return data;
};

describe('collectShownCommentCells', () => {
  it('lists only cells whose comment is shown, row by row', () => {
    const cells = collectShownCommentCells(
      grid(
        [
          [3, 1],
          [0, 2],
        ],
        [[1, 1]],
      ),
    );
    expect(cells.map(({ r, c }) => ({ r, c }))).toEqual([
      { r: 0, c: 2 },
      { r: 3, c: 1 },
    ]);
  });
});

describe('shownCommentsKey', () => {
  it('is the same for an unchanged shown set, even when other cells change', () => {
    const a = shownCommentsKey('s1', collectShownCommentCells(grid([[0, 2]])));
    const b = shownCommentsKey(
      's1',
      collectShownCommentCells(grid([[0, 2]], [[4, 4]])),
    );
    expect(b).toBe(a);
  });

  it('differs when a comment is shown or hidden', () => {
    const none = shownCommentsKey('s1', collectShownCommentCells(grid([])));
    const one = shownCommentsKey(
      's1',
      collectShownCommentCells(grid([[0, 2]])),
    );
    const two = shownCommentsKey(
      's1',
      collectShownCommentCells(
        grid([
          [0, 2],
          [1, 1],
        ]),
      ),
    );
    expect(new Set([none, one, two]).size).toBe(3);
  });

  it('differs when the same cells are shown on another sheet', () => {
    const cells = collectShownCommentCells(grid([]));
    expect(shownCommentsKey('s1', cells)).not.toBe(
      shownCommentsKey('s2', cells),
    );
  });
});

// PR 466 round 4 (N7): a pinned comment that is moved or resized writes `ps`
// but not `commentBoxes`; the key must change so showComments runs again.
describe('shownCommentsKey follows the comment box', () => {
  const withPs = (ps: Record<string, unknown>) => {
    const data: any[][] = Array.from({ length: 3 }, () => Array(3).fill(null));
    data[1][1] = { v: 1, ps: { isShow: true, value: 'x', left: 10, top: 20, width: 100, height: 50, ...ps } };
    return shownCommentsKey('s1', collectShownCommentCells(data));
  };

  it.each([
    ['moved right', { left: 40 }],
    ['moved down', { top: 60 }],
    ['resized wider', { width: 160 }],
    ['resized taller', { height: 90 }],
    ['text changed by a peer', { value: 'edited' }],
  ])('changes when the box is %s', (_name, change) => {
    expect(withPs(change)).not.toBe(withPs({}));
  });

  it('is the same for an unchanged box', () => {
    expect(withPs({})).toBe(withPs({}));
  });
});
