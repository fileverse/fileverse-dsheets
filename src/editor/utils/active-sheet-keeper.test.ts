import { describe, expect, it, vi } from 'vitest';
import { createActiveSheetKeeper } from './active-sheet-keeper';

vi.mock('./activate-sheet-for-link', () => ({
  activateSheetForLink: (draft: { currentSheetId: string }, id: string) => {
    draft.currentSheetId = id;
  },
}));

const makeWorkbook = (sheetIds: string[], currentSheetId: string | undefined) => {
  const ctx = {
    currentSheetId,
    luckysheetfile: sheetIds.map((id) => ({ id, hide: 0 })),
  };
  const setContext = vi.fn((recipe: (d: typeof ctx) => void) => recipe(ctx));
  return {
    ctx,
    setContext,
    workbook: {
      getWorkbookContext: () => ctx,
      getWorkbookSetContext: () => setContext,
    } as never,
  };
};

describe('createActiveSheetKeeper', () => {
  it('does nothing for a null workbook', () => {
    const keeper = createActiveSheetKeeper();
    expect(() => keeper.onAttach(null, 'm1')).not.toThrow();
  });

  it('records the active sheet and restores it once after a remount', () => {
    const keeper = createActiveSheetKeeper();
    const first = makeWorkbook(['a', 'b'], 'a');
    keeper.onAttach(first.workbook, 'm1');
    first.ctx.currentSheetId = 'b';
    keeper.onAttach(first.workbook, 'm1');

    const remounted = makeWorkbook(['a', 'b'], 'a');
    keeper.onAttach(remounted.workbook, 'm2');
    expect(remounted.setContext).toHaveBeenCalledTimes(1);
    expect(remounted.ctx.currentSheetId).toBe('b');

    keeper.onAttach(remounted.workbook, 'm2');
    expect(remounted.setContext).toHaveBeenCalledTimes(1);
  });

  it('waits for sheets: an attach with no sheets neither restores nor marks the mount handled', () => {
    const keeper = createActiveSheetKeeper();
    const first = makeWorkbook(['a', 'b'], 'b');
    keeper.onAttach(first.workbook, 'm1');

    const loading = makeWorkbook([], undefined);
    keeper.onAttach(loading.workbook, 'm2');
    expect(loading.setContext).not.toHaveBeenCalled();

    const loaded = makeWorkbook(['a', 'b'], 'a');
    keeper.onAttach(loaded.workbook, 'm2');
    expect(loaded.ctx.currentSheetId).toBe('b');
  });

  it('does not restore a sheet that is gone or hidden', () => {
    const keeper = createActiveSheetKeeper();
    keeper.onAttach(makeWorkbook(['a', 'b'], 'b').workbook, 'm1');
    const remounted = makeWorkbook(['a'], 'a');
    keeper.onAttach(remounted.workbook, 'm2');
    expect(remounted.setContext).not.toHaveBeenCalled();
  });
});
