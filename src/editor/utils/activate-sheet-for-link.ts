import {
  activateSheetForNavigation,
  cancelNormalSelected,
  type Context,
} from '@sheet-engine/core';

export function activateSheetForLink(draft: Context, sheetId: string): void {
  const outcome = activateSheetForNavigation(draft, sheetId);
  if (outcome === 'cancel-edit') {
    cancelNormalSelected(draft);
  }
}
