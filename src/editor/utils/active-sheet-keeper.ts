import type { WorkbookInstance } from '@sheet-engine/react';
import { activateSheetForLink } from './activate-sheet-for-link';

export type ActiveSheetKeeper = {
  /**
   * Call on every Workbook ref attach. `mountKey` must change whenever the
   * Workbook is remounted (i.e. mirror the Workbook's React `key`).
   */
  onAttach: (workbook: WorkbookInstance | null, mountKey: unknown) => void;
};

/**
 * Fortune remounts the Workbook whenever the editor bumps its render key
 * (collab rehydration, template apply, imports), and a fresh mount resets the
 * active sheet to the first visible one. Remember the active sheet across
 * attaches and restore it once per mount, as soon as the new mount has sheets.
 *
 * The restore runs synchronously inside the ref callback (React commit phase).
 * That only enqueues a Workbook state update (same as setState in
 * useLayoutEffect), and it goes through the same setContext path as clicking a
 * sheet tab.
 */
export function createActiveSheetKeeper(): ActiveSheetKeeper {
  let lastActiveSheetId: string | null = null;
  let restoredForMountKey: unknown = undefined;
  let hasRestoreState = false;

  return {
    onAttach(workbook, mountKey) {
      if (!workbook) return;
      const ctx = workbook.getWorkbookContext?.();
      const sheets = ctx?.luckysheetfile ?? [];
      // New mount still initialising: don't overwrite the remembered sheet and
      // don't mark this mount as handled yet.
      if (!ctx || sheets.length === 0 || !ctx.currentSheetId) return;

      if (!hasRestoreState || restoredForMountKey !== mountKey) {
        hasRestoreState = true;
        restoredForMountKey = mountKey;
        const target = lastActiveSheetId;
        const canRestore =
          !!target &&
          target !== ctx.currentSheetId &&
          sheets.some((s) => s?.id === target && s.hide !== 1);
        if (target && canRestore) {
          try {
            workbook.getWorkbookSetContext?.()?.((draft) =>
              activateSheetForLink(draft, target),
            );
            // The next attach (after the restore renders) records the sheet.
            return;
          } catch {
            // Fall through and track whatever sheet is active.
          }
        }
      }

      lastActiveSheetId = ctx.currentSheetId;
    },
  };
}
