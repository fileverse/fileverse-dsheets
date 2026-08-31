import { describe, expect, it } from 'vitest';
import { clampIndicesToUsedBounds } from './copy-range-bounds';

/**
 * Model a sparse sheet: a Set of "r_c" keys that count as meaningful.
 * Mirrors the real predicate (data OR border OR conditional format).
 */
const meaningfulFrom = (keys: string[]) => {
  const set = new Set(keys);
  return (r: number, c: number) => set.has(`${r}_${c}`);
};

describe('clampIndicesToUsedBounds', () => {
  it('trims trailing empty rows and columns to the data bounding box', () => {
    const rows = [0, 1, 2, 3, 4, 5];
    const cols = [0, 1, 2, 3, 4, 5];
    const isMeaningful = meaningfulFrom(['0_0', '2_2', '1_1']);

    const { rows: r, cols: c } = clampIndicesToUsedBounds(
      rows,
      cols,
      isMeaningful,
    );

    expect(r).toEqual([0, 1, 2]);
    expect(c).toEqual([0, 1, 2]);
  });

  it('trims leading empties too (offset data block)', () => {
    const rows = [0, 1, 2, 3, 4];
    const cols = [0, 1, 2, 3, 4];
    const isMeaningful = meaningfulFrom(['2_1', '3_2']);

    const { rows: r, cols: c } = clampIndicesToUsedBounds(
      rows,
      cols,
      isMeaningful,
    );

    expect(r).toEqual([2, 3]);
    expect(c).toEqual([1, 2]);
  });

  it('models the select-all-of-a-mostly-empty-sheet case', () => {
    const rows = Array.from({ length: 240 }, (_, i) => i);
    const cols = Array.from({ length: 240 }, (_, i) => i);
    const keys: string[] = [];
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 4; c += 1) keys.push(`${r}_${c}`);
    }
    const isMeaningful = meaningfulFrom(keys);

    const { rows: r, cols: c } = clampIndicesToUsedBounds(
      rows,
      cols,
      isMeaningful,
    );

    expect(r).toEqual([0, 1, 2]);
    expect(c).toEqual([0, 1, 2, 3]);
  });

  it('keeps a border-only / CF-only cell that sits outside the data block', () => {
    const rows = [0, 1, 2, 3];
    const cols = [0, 1, 2, 3];
    const isMeaningful = meaningfulFrom(['0_0', '3_3']);

    const { rows: r, cols: c } = clampIndicesToUsedBounds(
      rows,
      cols,
      isMeaningful,
    );

    expect(r).toEqual([0, 1, 2, 3]);
    expect(c).toEqual([0, 1, 2, 3]);
  });

  it('collapses a fully-empty selection to a single top-left cell', () => {
    // select-all of an empty sheet must NOT serialise the whole blank grid.
    const rows = [4, 5, 6];
    const cols = [7, 8, 9];
    const isMeaningful = () => false;

    const { rows: r, cols: c } = clampIndicesToUsedBounds(
      rows,
      cols,
      isMeaningful,
    );

    expect(r).toEqual([4]);
    expect(c).toEqual([7]);
  });

  it('returns empty arrays when given empty input', () => {
    const { rows: r, cols: c } = clampIndicesToUsedBounds([], [], () => false);
    expect(r).toEqual([]);
    expect(c).toEqual([]);
  });

  it('no-ops when every cell is meaningful', () => {
    const rows = [0, 1];
    const cols = [0, 1];
    const isMeaningful = () => true;

    const { rows: r, cols: c } = clampIndicesToUsedBounds(
      rows,
      cols,
      isMeaningful,
    );

    expect(r).toEqual([0, 1]);
    expect(c).toEqual([0, 1]);
  });

  it('preserves non-contiguous selection indices within the kept box', () => {
    const rows = [0, 2, 4, 6];
    const cols = [1, 3, 5];
    const isMeaningful = meaningfulFrom(['2_3', '4_5']);

    const { rows: r, cols: c } = clampIndicesToUsedBounds(
      rows,
      cols,
      isMeaningful,
    );

    expect(r).toEqual([2, 4]);
    expect(c).toEqual([3, 5]);
  });
});
