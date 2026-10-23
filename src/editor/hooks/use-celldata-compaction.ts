import { useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type * as Y from 'yjs';
import type { WorkbookInstance, Sheet } from '@sheet-engine/react';
import {
  buildCompactionRevChange,
  compactInMemorySheets,
  hasSheetCompactionCompleted,
  markCompactionRevInMemory,
  planYdocCompaction,
} from '../utils/compact-committed-celldata';
import { updateYdocSheetData } from '../utils/update-ydoc';
import { COMPACTION_ORIGIN } from '../utils/content-change';
import { applyCellFormatRangesCommits } from '../../sheet-engine/core/utils/mirror-cell-format-ranges';

/** Wait for editor + IDB sync, then a quiet window before scanning. */
const SETTLE_MS = 4_000;
/** Max deletes per Yjs transaction — yield between chunks on huge sheets. */
const DELETE_CHUNK_SIZE = 2_000;

type UseCelldataCompactionArgs = {
  dsheetId: string;
  ydocRef: RefObject<Y.Doc | null>;
  sheetEditorRef: RefObject<WorkbookInstance | null>;
  currentDataRef: MutableRefObject<Sheet[]>;
  handleOnChangePortalUpdate: () => void;
  syncStatus: 'initializing' | 'syncing' | 'synced' | 'error';
  isDataLoaded: boolean;
  isReadOnly: boolean;
  remoteUpdateRef: MutableRefObject<boolean>;
  collabSyncing: boolean;
};

async function applyCompactionChangesInChunks(
  ydoc: Y.Doc,
  dsheetId: string,
  changes: ReturnType<typeof planYdocCompaction>['changes'],
  handleOnChangePortalUpdate: () => void,
  isCancelled: () => boolean,
  sheetEditorRef: RefObject<WorkbookInstance | null>,
): Promise<void> {
  for (let i = 0; i < changes.length; i += DELETE_CHUNK_SIZE) {
    if (isCancelled()) return;
    const chunk = changes.slice(i, i + DELETE_CHUNK_SIZE);
    const isLast = i + DELETE_CHUNK_SIZE >= changes.length;
    updateYdocSheetData(
      ydoc,
      dsheetId,
      chunk,
      isLast ? handleOnChangePortalUpdate : undefined,
      (commits) => {
        applyCellFormatRangesCommits(
          commits,
          sheetEditorRef.current?.getWorkbookSetContext?.() ?? null,
        );
      },
      COMPACTION_ORIGIN,
    );
    if (!isLast) {
      await new Promise<void>((resolve) => {
        if (typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(() => resolve(), { timeout: 2_000 });
        } else {
          window.setTimeout(resolve, 0);
        }
      });
    }
  }
}

/**
 * One-shot background compaction (celldata + borderInfo). Completion is stored
 * on the anchor sheet's config in Yjs so it syncs across devices.
 */
export function useCelldataCompaction({
  dsheetId,
  ydocRef,
  sheetEditorRef,
  currentDataRef,
  handleOnChangePortalUpdate,
  syncStatus,
  isDataLoaded,
  isReadOnly,
  remoteUpdateRef,
  collabSyncing,
}: UseCelldataCompactionArgs): void {
  const runningRef = useRef(false);

  useEffect(() => {
    if (!dsheetId || isReadOnly) return;
    if (syncStatus !== 'synced' || !isDataLoaded) return;

    const ydoc = ydocRef.current;
    if (!ydoc || hasSheetCompactionCompleted(ydoc, dsheetId)) return;
    if (runningRef.current) return;

    let cancelled = false;
    let settleTimer: number | null = null;
    let idleId: number | null = null;

    const isCancelled = () => cancelled;

    const runCompaction = () => {
      if (cancelled || runningRef.current) return;
      if (remoteUpdateRef.current || collabSyncing) return;

      const liveYdoc = ydocRef.current;
      if (!liveYdoc || hasSheetCompactionCompleted(liveYdoc, dsheetId)) return;

      runningRef.current = true;

      void (async () => {
        try {
          if (isCancelled() || remoteUpdateRef.current) return;

          const plan = planYdocCompaction(liveYdoc, dsheetId);
          const revChange = buildCompactionRevChange(liveYdoc, dsheetId);
          const changes = revChange
            ? [...plan.changes, revChange]
            : plan.changes;

          if (changes.length === 0) return;

          compactInMemorySheets(currentDataRef.current);

          await applyCompactionChangesInChunks(
            liveYdoc,
            dsheetId,
            changes,
            handleOnChangePortalUpdate,
            isCancelled,
            sheetEditorRef,
          );

          if (isCancelled()) return;

          markCompactionRevInMemory(currentDataRef.current);
          const workbook = sheetEditorRef.current?.getWorkbookContext?.()
            ?.luckysheetfile;
          if (workbook) {
            compactInMemorySheets(workbook);
            markCompactionRevInMemory(workbook);
          }
        } catch (err) {
          console.warn('[DSheet] Compaction failed:', err);
        } finally {
          runningRef.current = false;
        }
      })();
    };

    const scheduleAfterIdle = () => {
      if (cancelled) return;
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(
          (deadline) => {
            idleId = null;
            if (cancelled) return;
            if (deadline.timeRemaining() > 8 || deadline.didTimeout) {
              runCompaction();
            } else {
              idleId = window.requestIdleCallback(() => {
                idleId = null;
                if (!cancelled) runCompaction();
              });
            }
          },
          { timeout: 8_000 },
        );
      } else {
        runCompaction();
      }
    };

    settleTimer = window.setTimeout(scheduleAfterIdle, SETTLE_MS);

    return () => {
      cancelled = true;
      if (settleTimer != null) window.clearTimeout(settleTimer);
      if (idleId != null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [
    dsheetId,
    ydocRef,
    sheetEditorRef,
    currentDataRef,
    handleOnChangePortalUpdate,
    syncStatus,
    isDataLoaded,
    isReadOnly,
    remoteUpdateRef,
    collabSyncing,
  ]);
}
