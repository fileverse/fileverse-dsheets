import type { Sheet } from '../types';

function isValidRange(range: unknown): range is [number, number] {
  return (
    Array.isArray(range) &&
    range.length === 2 &&
    Number.isSafeInteger(range[0]) &&
    Number.isSafeInteger(range[1]) &&
    range[0] >= 0 &&
    range[1] >= range[0]
  );
}

export function isValidFilterSelection(
  selection: unknown,
): selection is NonNullable<Sheet['filter_select']> {
  if (!selection || typeof selection !== 'object') return false;
  const { row, column } = selection as { row?: unknown; column?: unknown };
  return isValidRange(row) && isValidRange(column);
}
