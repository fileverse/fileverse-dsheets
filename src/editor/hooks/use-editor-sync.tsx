import { useRef, useEffect, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { useSyncManager } from '../../sync-local/useSyncManager';
import type { CollaborationProps } from '../../sync-local/types';
import { presenceColor } from '../../constants';
import {
  mergeDsheetContentIntoDocument,
  snapshotDsheetDocument,
  unavailableDsheetContentSnapshot,
} from '../../persistence-utils';
import { migrateSheetArrayIfNeeded } from '../utils/migrate-new-yjs';
import { isFormatLocked } from '../utils/format-gate';
import { rebuildIndexedDbStore } from '../utils/rebuild-indexeddb-store';
import { compactDsheetPersistence } from '../../persistence-compaction';
import { attachContentFingerprint } from '../utils/content-fingerprint';
import {
  attachUserEditTracker,
  computeHasContent,
  type DSheetContentChange,
} from '../utils/content-change';
import {
  createCollaborationConnectionController,
  mergePublishedContentIntoYdoc,
} from './collaboration-lifecycle';

export const useEditorSync = (
  dsheetId: string,
  enableIndexeddbSync = true,
  isReadOnly = false,
  portalContent = '',
  collaboration?: CollaborationProps,
  onRemoteApplied?: (update: Uint8Array) => void,
  onIndexedDbError?: (error: Error) => void,
) => {
  // Match dDoc: one Y.Doc is owned by this provider for its entire lifetime.
  // A dsheetId change remounts EditorProvider at the component boundary.
  // The fingerprint tracker attaches here, before IndexedDB replay, the
  // published-state merge or SyncManager can write, so it never needs a scan.
  const persistenceRef = useRef<IndexeddbPersistence | null>(null);
  const [{ ydoc, fingerprint, userEdits }] = useState(() => {
    const doc = new Y.Doc();
    return {
      ydoc: doc,
      fingerprint: attachContentFingerprint(doc),
      userEdits: attachUserEditTracker(doc, () => persistenceRef.current),
    };
  });
  const ydocRef = useRef<Y.Doc | null>(ydoc);
  // True once y-indexeddb is attached and has replayed. Until then the live
  // doc can be empty while IndexedDB holds the sheet.
  const indexeddbSyncedRef = useRef(false);
  const [syncStatus, setSyncStatus] = useState<
    'initializing' | 'syncing' | 'synced' | 'error'
  >('initializing');
  const [isContentBootstrapReady, setIsContentBootstrapReady] = useState(false);
  const bootstrapGenerationRef = useRef(0);

  const activeCollab =
    collaboration?.enabled === true ? collaboration : undefined;
  const collabEnabled = activeCollab != null;
  const collabServices = activeCollab?.services;
  const collabCallbacks = activeCollab?.on;

  // Stable ref so SyncManager closure never captures a stale onRemoteApplied identity
  const onRemoteAppliedRef = useRef(onRemoteApplied);
  useEffect(() => {
    onRemoteAppliedRef.current = onRemoteApplied;
  }, [onRemoteApplied]);

  // IndexedDB owns the bootstrap lifecycle, so changing an error callback must
  // not destroy and recreate the persistence provider.
  const onIndexedDbErrorRef = useRef(onIndexedDbError);
  useEffect(() => {
    onIndexedDbErrorRef.current = onIndexedDbError;
  }, [onIndexedDbError]);

  const {
    connect,
    disconnect,
    isReady: isCollabReady,
    isSyncing: isCollabSyncing,
    terminateSession,
    updateTitle,
    awareness,
    hasCollabContentInitialised,
    state: collabState,
  } = useSyncManager({
    ydoc,
    services: collabServices,
    callbacks: collabCallbacks,
    onRemoteApplied: (update) => {
      onRemoteAppliedRef.current?.(update);
    },
    ignoredOrigins: [persistenceRef],
  });

  // Latest bootstrap run, and the rebuild (D3) in flight. A rebuild never
  // bumps bootstrapGenerationRef: it waits for the bootstrap, and a bootstrap
  // that starts during a rebuild waits for the rebuild.
  const bootstrapPromiseRef = useRef<Promise<void> | null>(null);
  const rebuildInFlightRef = useRef<Promise<void> | null>(null);
  // True once a rebuild has finished waiting for bootstrap and is touching the
  // store. A bootstrap only waits for it then (waiting earlier would deadlock).
  const rebuildWritingRef = useRef(false);
  // True between the bootstrap effect's cleanup and its next mount. A rebuild
  // must not create a provider on a doc whose lifecycle has ended.
  const unmountedRef = useRef(false);

  const bootstrapEditorIndexedDB = useCallback(async () => {
    const generation = ++bootstrapGenerationRef.current;
    indexeddbSyncedRef.current = false;
    setSyncStatus('syncing');
    setIsContentBootstrapReady(false);

    if (rebuildWritingRef.current && rebuildInFlightRef.current) {
      // The rebuild sees the generation change, destroys its provider and
      // rejects; we only need it to be finished before touching persistenceRef.
      await rebuildInFlightRef.current.catch(() => {});
      if (generation !== bootstrapGenerationRef.current) return;
    }

    if (persistenceRef.current) {
      try {
        await persistenceRef.current.destroy();
      } catch (error) {
        const indexedDbError =
          error instanceof Error ? error : new Error(String(error));
        console.error(
          '[DSheet] IndexedDB persistence cleanup failed:',
          indexedDbError,
        );
        onIndexedDbErrorRef.current?.(indexedDbError);
      }
      if (generation !== bootstrapGenerationRef.current) return;
      persistenceRef.current = null;
    }

    try {
      // Attach IndexedDB to the doc BEFORE merging the published state.
      // y-indexeddb stores a full copy of whatever the doc holds when it
      // attaches, so attaching to a pre-filled doc appended the whole sheet on
      // every open. Merging afterwards stores only the parts IndexedDB did not
      // already have. Yjs merges commute, so the resulting doc is the same.
      if (!isReadOnly && enableIndexeddbSync && dsheetId) {
        try {
          const persistence = new IndexeddbPersistence(dsheetId, ydoc);
          // Capture before replay so SyncManager can identify this origin.
          persistenceRef.current = persistence;
          persistence.on('error', (error: unknown) => {
            const indexedDbError =
              error instanceof Error ? error : new Error(String(error));
            console.error(
              '[DSheet] IndexedDB persistence error:',
              indexedDbError,
            );
            onIndexedDbErrorRef.current?.(indexedDbError);
          });
          await persistence.whenSynced;
          if (generation !== bootstrapGenerationRef.current) return;
          indexeddbSyncedRef.current = true;
          // Collapse rows that were already replayed into the doc (legacy full
          // copies, previous sessions' edits) into one, in the background.
          void compactDsheetPersistence(persistence).catch((error: unknown) => {
            console.warn('[DSheet] IndexedDB compaction failed:', error);
          });
        } catch (error) {
          const indexedDbError =
            error instanceof Error ? error : new Error(String(error));
          console.error(
            '[DSheet] IndexedDB initialization failed:',
            indexedDbError,
          );
          const failedPersistence = persistenceRef.current;
          persistenceRef.current = null;
          indexeddbSyncedRef.current = false;
          if (failedPersistence) {
            try {
              await failedPersistence.destroy();
            } catch {
              // The provider is already unusable; local persistence is optional.
            }
          }
          if (generation !== bootstrapGenerationRef.current) return;
          onIndexedDbErrorRef.current?.(indexedDbError);
          // Match dDoc: keep the merged Y.Doc and continue without IndexedDB.
        }
      }

      // dDoc parity: host/published state is present in the one Y.Doc before
      // SyncManager is allowed to connect.
      if (!isFormatLocked(ydoc, dsheetId)) {
        mergePublishedContentIntoYdoc(ydoc, portalContent);
      }

      // IndexedDB may contain a legacy plain-object sheet array. Persist its
      // migration before connection so local-only diff seeding sends the same
      // structure Fortune will render.
      if (!isFormatLocked(ydoc, dsheetId)) {
        migrateSheetArrayIfNeeded(ydoc, ydoc.getArray(dsheetId));
      }

      if (generation !== bootstrapGenerationRef.current) return;
      setSyncStatus('synced');
      setIsContentBootstrapReady(true);
    } catch (error) {
      if (generation !== bootstrapGenerationRef.current) return;
      console.error('[DSheet] Error bootstrapping editor content:', error);
      setSyncStatus('error');
      // Preserve the best state already merged into the Y.Doc for read-only
      // fallback, but do not connect a room from an incomplete bootstrap.
      setIsContentBootstrapReady(true);
    }
  }, [dsheetId, enableIndexeddbSync, isReadOnly, portalContent, ydoc]);

  const initialiseEditorIndexedDB = useCallback((): Promise<void> => {
    const run = bootstrapEditorIndexedDB();
    bootstrapPromiseRef.current = run;
    return run;
  }, [bootstrapEditorIndexedDB]);

  /**
   * D3: delete the IndexedDB database and rewrite it from the live Y.Doc.
   * Resolves as a no-op when read-only, sync is disabled or there is no id.
   * Concurrent calls share the in-flight promise. Never bumps the bootstrap
   * generation: it waits for any running bootstrap first. If a bootstrap is
   * requested or the hook unmounts during the rebuild, the new provider is
   * destroyed and the call rejects.
   */
  const rebuildLocalStore = useCallback((): Promise<void> => {
    if (isReadOnly || !enableIndexeddbSync || !dsheetId) {
      return Promise.resolve();
    }
    if (unmountedRef.current) {
      return Promise.reject(new Error('[DSheet] IndexedDB rebuild after unmount'));
    }
    if (rebuildInFlightRef.current) return rebuildInFlightRef.current;
    const reportError = (error: unknown) => {
      const indexedDbError =
        error instanceof Error ? error : new Error(String(error));
      console.error('[DSheet] IndexedDB persistence error:', indexedDbError);
      onIndexedDbErrorRef.current?.(indexedDbError);
    };
    const run = async () => {
      // Let the latest bootstrap finish (it may be superseded meanwhile).
      let waited: Promise<void> | null = null;
      while (
        bootstrapPromiseRef.current &&
        bootstrapPromiseRef.current !== waited
      ) {
        waited = bootstrapPromiseRef.current;
        await waited.catch(() => {});
      }
      if (unmountedRef.current) {
        throw new Error('[DSheet] IndexedDB rebuild after unmount');
      }
      const generation = bootstrapGenerationRef.current;
      rebuildWritingRef.current = true;
      indexeddbSyncedRef.current = false;
      let next: IndexeddbPersistence | null = null;
      try {
        next = await rebuildIndexedDbStore(
          dsheetId,
          ydoc,
          persistenceRef.current,
          (created) => {
            persistenceRef.current = created;
            created.on('error', reportError);
          },
        );
      } catch (error) {
        persistenceRef.current = null;
        indexeddbSyncedRef.current = false;
        if (generation === bootstrapGenerationRef.current) {
          reportError(error);
        }
        throw error;
      }
      if (generation !== bootstrapGenerationRef.current) {
        // Superseded by a refresh or unmount: that path owns the provider.
        if (persistenceRef.current === next) persistenceRef.current = null;
        await next.destroy().catch(() => {});
        throw new Error('[DSheet] IndexedDB rebuild superseded');
      }
      indexeddbSyncedRef.current = true;
    };
    const promise = run().finally(() => {
      rebuildWritingRef.current = false;
      rebuildInFlightRef.current = null;
    });
    rebuildInFlightRef.current = promise;
    return promise;
  }, [dsheetId, enableIndexeddbSync, isReadOnly, ydoc]);

  const getContentSnapshot = useCallback(
    () =>
      ydocRef.current
        ? snapshotDsheetDocument(dsheetId, ydocRef.current)
        : unavailableDsheetContentSnapshot(
          dsheetId,
          'unavailable',
          new Error('dSheet document is not ready'),
        ),
    [dsheetId],
  );

  /**
   * Live content fingerprint (A1), or null until y-indexeddb is attached to
   * the doc and has synced. Callers fall back to fingerprintFromUpdate of the
   * IndexedDB body while it is null.
   */
  const getContentFingerprint = useCallback(
    (): string | null =>
      ydocRef.current && persistenceRef.current && indexeddbSyncedRef.current
        ? fingerprint.getFingerprint()
        : null,
    [fingerprint],
  );

  /** A1 change signal, built on demand from the live doc (no encode). */
  const getContentChange = useCallback(
    (): DSheetContentChange => ({
      hasContent: computeHasContent(ydoc, dsheetId),
      userEdited: userEdits.userEdited(),
      fingerprint: getContentFingerprint(),
    }),
    [ydoc, dsheetId, userEdits, getContentFingerprint],
  );

  const mergeContent = useCallback(
    (encodedState: string) =>
      mergeDsheetContentIntoDocument(dsheetId, encodedState, ydocRef.current),
    [dsheetId],
  );

  // Doc-lifecycle effect: this exact document is also owned by SyncManager.
  // The EditorProvider key handles document-id changes by remounting the whole
  // lifecycle rather than rebinding only part of the editor.
  useEffect(() => {
    return () => {
      if (ydocRef.current === ydoc) {
        fingerprint.dispose();
        userEdits.dispose();
        ydoc.destroy();
        ydocRef.current = null;
      }
    };
  }, [ydoc, fingerprint, userEdits]);

  // Content bootstrap effect: IndexedDB replay → published state → migration.
  // Never replaces the Y.Doc — SyncManager, persistence, and Fortune share it.
  useEffect(() => {
    unmountedRef.current = false;
    void initialiseEditorIndexedDB();

    return () => {
      unmountedRef.current = true;
      bootstrapGenerationRef.current += 1;
      indexeddbSyncedRef.current = false;
      if (persistenceRef.current) {
        void persistenceRef.current.destroy();
        persistenceRef.current = null;
      }
    };
  }, [initialiseEditorIndexedDB]);

  const isSocketConnectedRef = useRef(false);

  // dDoc's hybrid controller: persistent while livePresence/connectOnOpen is
  // set; otherwise connect on the first local edit and idle-disconnect after
  // the exact same warm period. Ordinary lifecycle cleanup never terminates a
  // durable room — explicit owner termination stays on DSheetEditorHandle.
  useEffect(() => {
    if (!activeCollab || !isContentBootstrapReady || syncStatus !== 'synced') {
      return;
    }

    const { connection } = activeCollab;
    const ydoc = ydocRef.current;
    const controller = createCollaborationConnectionController({
      connection,
      isSocketConnectedRef,
      getIndexeddbOrigin: () => persistenceRef.current,
      isBootstrapReady: isContentBootstrapReady,
      connect,
      disconnect,
    });
    ydoc?.on('update', controller.onYdocUpdate);

    return () => {
      ydoc?.off('update', controller.onYdocUpdate);
      controller.dispose();
    };
  }, [
    activeCollab?.connection.roomKey,
    activeCollab?.connection.roomId,
    activeCollab?.connection.wsUrl,
    activeCollab?.connection.livePresence,
    activeCollab?.connection.connectOnOpen,
    connect,
    disconnect,
    isContentBootstrapReady,
    syncStatus,
  ]);

  // Set local awareness user state once awareness is initialised
  useEffect(() => {
    if (!awareness || !collabEnabled || !collaboration?.enabled) return;
    const session = (
      collaboration as Extract<CollaborationProps, { enabled: true }>
    ).session;
    awareness.setLocalStateField('user', {
      name: session.username,
      color:
        awareness.getLocalState()?.user?.color ??
        presenceColor(session.isEns, session.color),
      isEns: session.isEns ?? false,
    });
  }, [awareness, collabEnabled]);

  const isEnsSession =
    collabEnabled && collaboration?.enabled
      ? (collaboration as Extract<CollaborationProps, { enabled: true }>)
        .session.isEns
      : undefined;

  const prevCollabStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevCollabStatusRef.current;
    prevCollabStatusRef.current = collabState?.status;

    if (collabState?.status === 'ready' && prev === 'syncing' && awareness) {
      const localState = awareness.getLocalState();
      if (localState?.user) {
        awareness.setLocalStateField('user', localState.user);
      }
    }
  }, [collabState?.status, awareness]);

  // Re-publish awareness when ENS status resolves asynchronously
  useEffect(() => {
    if (!awareness || !collabEnabled || !collaboration?.enabled) return;
    const session = (
      collaboration as Extract<CollaborationProps, { enabled: true }>
    ).session;
    if (!session.isEns) return;
    const localState = awareness.getLocalState();
    awareness.setLocalStateField('user', {
      ...(localState?.user ?? {}),
      color:
        localState?.user?.color ?? presenceColor(session.isEns),
      isEns: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awareness, collabEnabled, isEnsSession]);

  return {
    ydocRef,
    persistenceRef,
    syncStatus,
    isContentBootstrapReady,
    refreshIndexedDB: initialiseEditorIndexedDB,
    rebuildLocalStore,
    getContentSnapshot,
    getContentFingerprint,
    getContentChange,
    mergeContent,
    // collab
    collabState,
    isCollabReady,
    isCollabSyncing,
    terminateSession,
    updateTitle,
    awareness,
    hasCollabContentInitialised,
  };
};