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
    expect(cells).toEqual([
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
