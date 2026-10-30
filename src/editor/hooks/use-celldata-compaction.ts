import { useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import * as Y from 'yjs';
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
import { shouldSkipEchoWrite } from '../utils/remote-apply-guard';

/** Wait for editor + IDB sync, then a quiet window before scanning. */
const SETTLE_MS = 4_000;
/** Wait before a refused or stopped run is tried again. */
export const COMPACTION_RETRY_MS = 30_000;
/** Tries after the first run; the compaction is also retried on a later open. */
export const COMPACTION_MAX_RETRIES = 10;
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
  /** True while a structural remote change waits to remount the Workbook. */
  structuralRemountPendingRef?: MutableRefObject<boolean>;
  collabSyncing: boolean;
};

/**
 * False while a remote apply is running, while a structural remount is pending
 * (the engine still has the old grid and the Yjs document has the new one) or
 * while collaboration is still syncing.
 */
export function canRunCompaction(
  refs: {
    remoteUpdateRef: MutableRefObject<boolean>;
    structuralRemountPendingRef?: MutableRefObject<boolean>;
  },
  collabSyncing: boolean,
): boolean {
  return !shouldSkipEchoWrite(refs) && !collabSyncing;
}

/**
 * Runs `attempt` and, when it asks for a retry (the gate was closed, or a run
 * stopped because the document changed), calls `retry` after `delayMs`, up to
 * `maxRetries` times. Without it a refused run waited for the next open, so
 * compaction made one chunk of progress per open (PR 466 N10).
 */
export function createCompactionRetrier({
  attempt,
  retry,
  delayMs = COMPACTION_RETRY_MS,
  maxRetries = COMPACTION_MAX_RETRIES,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: {
  attempt: () => Promise<'done' | 'retry'>;
  retry: () => void;
  delayMs?: number;
  maxRetries?: number;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}) {
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    async run() {
      const outcome = await attempt();
      if (outcome === 'retry' && retries < maxRetries) {
        retries += 1;
        timer = setTimer(() => {
          timer = null;
          retry();
        }, delayMs);
      }
    },
    cancel() {
      if (timer != null) clearTimer(timer);
      timer = null;
    },
  };
}

const sameVector = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Applies the plan chunk by chunk, yielding between chunks. The plan was made
 * from the document as it was, and one change in it, the whole-value
 * borderInfo write, would overwrite a newer value. So the run stops, leaving
 * the compaction unfinished (it is retried on a later open), as soon as the
 * document differs from what the previous chunk left. Returns true when every
 * chunk was applied.
 */
export async function applyCompactionChangesInChunks(
  ydoc: Y.Doc,
  dsheetId: string,
  changes: ReturnType<typeof planYdocCompaction>['changes'],
  handleOnChangePortalUpdate: () => void,
  isCancelled: () => boolean,
  sheetEditorRef: RefObject<WorkbookInstance | null>,
  chunkSize: number = DELETE_CHUNK_SIZE,
): Promise<boolean> {
  let expected = Y.encodeStateVector(ydoc);
  for (let i = 0; i < changes.length; i += chunkSize) {
    if (isCancelled()) return false;
    if (!sameVector(Y.encodeStateVector(ydoc), expected)) return false;
    const chunk = changes.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= changes.length;
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
    expected = Y.encodeStateVector(ydoc);
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
  return true;
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
  structuralRemountPendingRef,
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

    const attempt = async (): Promise<'done' | 'retry'> => {
      if (cancelled || runningRef.current) return 'done';
      if (
        !canRunCompaction(
          { remoteUpdateRef, structuralRemountPendingRef },
          collabSyncing,
        )
      ) {
        return 'retry';
      }

      const liveYdoc = ydocRef.current;
      if (!liveYdoc || hasSheetCompactionCompleted(liveYdoc, dsheetId)) {
        return 'done';
      }

      runningRef.current = true;
      try {
        if (
          isCancelled() ||
          !canRunCompaction(
            { remoteUpdateRef, structuralRemountPendingRef },
            collabSyncing,
          )
        ) {
          return isCancelled() ? 'done' : 'retry';
        }

        const plan = planYdocCompaction(liveYdoc, dsheetId);
        const revChange = buildCompactionRevChange(liveYdoc, dsheetId);
        const changes = revChange
          ? [...plan.changes, revChange]
          : plan.changes;

        if (changes.length === 0) return 'done';

        compactInMemorySheets(currentDataRef.current);

        const finished = await applyCompactionChangesInChunks(
          liveYdoc,
          dsheetId,
          changes,
          handleOnChangePortalUpdate,
          isCancelled,
          sheetEditorRef,
        );

        // Cancelled, or the document changed under a multi-chunk run: the
        // compaction is not complete and is tried again later.
        if (isCancelled()) return 'done';
        if (!finished) return 'retry';

        markCompactionRevInMemory(currentDataRef.current);
        const workbook = sheetEditorRef.current?.getWorkbookContext?.()
          ?.luckysheetfile;
        if (workbook) {
          compactInMemorySheets(workbook);
          markCompactionRevInMemory(workbook);
        }
        return 'done';
      } catch (err) {
        console.warn('[DSheet] Compaction failed:', err);
        return 'done';
      } finally {
        runningRef.current = false;
      }
    };

    const retrier = createCompactionRetrier({
      attempt,
      retry: () => scheduleAfterIdle(),
    });
    const runCompaction = () => {
      void retrier.run();
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
      retrier.cancel();
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
    structuralRemountPendingRef,
    collabSyncing,
  ]);
}
