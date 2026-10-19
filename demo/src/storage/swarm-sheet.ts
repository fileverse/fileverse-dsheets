import { useCallback, useEffect, useRef, useState } from 'react';
import { SwarmDocumentStorage } from '../../../src/swarm/swarm-document-storage';
import { createSwarmSaveQueue, type SwarmSaveState } from './swarm-save-queue';

export type { SwarmSaveState } from './swarm-save-queue';

/**
 * Sheet persistence over a `SwarmDocumentStorage`: restore-with-retry on
 * open, debounced save on change.
 *
 * The saved payload is the editor's base64-encoded Y.Doc state — the same
 * string `onChange` hands the host — so restoring is a CRDT merge
 * (`editorStateRef.mergeContent`), never an overwrite: whatever IndexedDB
 * already has locally and whatever Swarm has converge to the same sheet.
 *
 * Saves are held, not failed, while Swarm cannot be written (node down,
 * no postage, offline): the newest snapshot waits in the save queue
 * (`swarm-save-queue.ts`) and goes out on the next change of write
 * capability. Local persistence continues regardless, so nothing is lost
 * meanwhile.
 */

// A node that has just started answers requests before it can serve
// anything — and a Swarm-aware browser typically opens the page in exactly
// that window. Field-measured (Freedom, 2026-08-18): its embedded ant node
// refused a SOC lookup ~10s after start and served the same chunk fine
// once warm — the warm-up is tens of seconds, so the budget must span
// minutes, not seconds.
export const MAX_RESTORE_ATTEMPTS = 8;
const restoreRetryDelayMs = (attempt: number) =>
  [2_000, 4_000, 8_000, 12_000, 16_000, 24_000, 30_000][attempt - 1] ??
  30_000;
const SAVE_DEBOUNCE_MS = 2_000;
/**
 * How long a restored version waits before it is saved. The editor that
 * mounts on the restored copy may first record its one-time compaction in
 * the sheet (a version saved before compaction ran lacks the marker, which
 * the editor's SETTLE_MS of 4 s after sync then writes); waiting lets that
 * edit join the restore's save instead of adding a version of its own.
 */
const RESTORE_SAVE_DELAY_MS = 10_000;

export type SwarmRestoreState =
  | { phase: 'idle' }
  | { phase: 'loading'; attempt: number }
  | { phase: 'done'; snapshot: string | null }
  | { phase: 'failed'; error: string };

const READ_ONLY_MARKER = 'belongs to another identity';

export const useSwarmSheet = ({
  documentId,
  docStorage,
  canWrite,
  expectContent = false,
  onReadOnlySave,
}: {
  documentId: string;
  docStorage: SwarmDocumentStorage | null;
  canWrite: boolean;
  /**
   * True for a sheet that arrived by link: it exists on Swarm by
   * definition, so a "feed not found" is a retrieval failure to retry and
   * explain — NOT an empty new sheet. Rendering a blank grid for it reads
   * as data loss (Freedom field test, 2026-08-18: a cold ultra-light node
   * answered not-found for chunks the network provably held).
   */
  expectContent?: boolean;
  /** A save was refused because another identity owns the feed. */
  onReadOnlySave: () => void;
}) => {
  const [restore, setRestore] = useState<SwarmRestoreState>({ phase: 'idle' });
  const [saveState, setSaveState] = useState<SwarmSaveState>('idle');
  // The sheet's newest version on Swarm (its feed index), once known: from
  // the restore, then from each save. Null for a sheet not on Swarm yet.
  const [version, setVersion] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  // Retry/skip controls bump this to re-run the restore effect.
  const [restoreRun, setRestoreRun] = useState(0);
  const skippedRef = useRef(false);

  // The queue outlives renders, so it reads the current storage, write
  // access and callback through refs.
  const docStorageRef = useRef(docStorage);
  docStorageRef.current = docStorage;
  const documentIdRef = useRef(documentId);
  documentIdRef.current = documentId;
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  const onReadOnlySaveRef = useRef(onReadOnlySave);
  onReadOnlySaveRef.current = onReadOnlySave;
  const [queue] = useState(() =>
    createSwarmSaveQueue({
      save: (state) =>
        docStorageRef.current!.saveDocument(documentIdRef.current, state),
      isReady: () => docStorageRef.current !== null,
      canWrite: () => canWriteRef.current,
      isReadOnlyError: (error) => error.message.includes(READ_ONLY_MARKER),
      onState: setSaveState,
      onSaved: (index) => {
        setVersion(index);
        setLastError(null);
      },
      onError: setLastError,
      onReadOnly: () => onReadOnlySaveRef.current(),
      debounceMs: SAVE_DEBOUNCE_MS,
      restoreDelayMs: RESTORE_SAVE_DELAY_MS,
    }),
  );

  const retryRestore = useCallback(() => {
    skippedRef.current = false;
    setRestoreRun((n) => n + 1);
  }, []);
  const skipRestore = useCallback(() => {
    skippedRef.current = true;
    setRestore({ phase: 'done', snapshot: null });
  }, []);

  useEffect(() => {
    if (!docStorage || skippedRef.current) return;
    let cancelled = false;
    (async () => {
      for (let attempt = 1; attempt <= MAX_RESTORE_ATTEMPTS; attempt++) {
        if (cancelled) return;
        setRestore({ phase: 'loading', attempt });
        try {
          const snapshot = await docStorage.loadDocument(documentId);
          if (cancelled) return;
          if (!snapshot && expectContent) {
            throw new Error(
              'This sheet exists on Swarm (its keys came with the link), ' +
                'but its feed could not be found from here yet. A node ' +
                'that has just started may need a minute to reach the ' +
                'chunks — retrying usually fixes it.',
            );
          }
          setRestore({ phase: 'done', snapshot: snapshot?.text ?? null });
          setVersion(snapshot ? snapshot.feedIndex : null);
          // What Swarm holds as the newest version: a remount of the editor
          // (after a version preview, say) reports it again, unchanged.
          queue.setLatest(snapshot?.text ?? null);
          setLastError(null);
          return;
        } catch (error) {
          if (cancelled) return;
          const message = (error as Error).message;
          if (attempt === MAX_RESTORE_ATTEMPTS) {
            setRestore({ phase: 'failed', error: message });
            setLastError(message);
            return;
          }
          await new Promise((r) => setTimeout(r, restoreRetryDelayMs(attempt)));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docStorage, documentId, expectContent, restoreRun, queue]);

  const queueSave = useCallback(
    (encodedState: string) => queue.queue(encodedState),
    [queue],
  );
  /**
   * Save a restored version as the newest one. Shown as saving at once; an
   * edit made meanwhile replaces it, as with any pending save.
   */
  const queueRestoreSave = useCallback(
    (encodedState: string) => queue.queueRestore(encodedState),
    [queue],
  );

  // Held edits go out as soon as storage and writing are possible again.
  useEffect(() => {
    queue.writable();
  }, [canWrite, docStorage, queue]);

  useEffect(() => () => queue.dispose(), [queue]);

  return {
    restore,
    retryRestore,
    skipRestore,
    queueSave,
    queueRestoreSave,
    saveState,
    version,
    lastError,
  };
};
