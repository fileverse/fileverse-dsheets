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
  onCollabUpdate?: (fullState: string, updateChunk: string) => void,
  onIndexedDbError?: (error: Error) => void,
) => {
  // Match dDoc: one Y.Doc is owned by this provider for its entire lifetime.
  // A dsheetId change remounts EditorProvider at the component boundary.
  const [ydoc] = useState(() => new Y.Doc());
  const ydocRef = useRef<Y.Doc | null>(ydoc);
  const persistenceRef = useRef<IndexeddbPersistence | null>(null);
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

  // Stable ref so SyncManager closure never captures a stale onCollabUpdate identity
  const onCollabUpdateRef = useRef(onCollabUpdate);
  useEffect(() => {
    onCollabUpdateRef.current = onCollabUpdate;
  }, [onCollabUpdate]);

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
    onLocalUpdate: (fullState, chunk) => {
      onCollabUpdateRef.current?.(fullState, chunk);
    },
    ignoredOrigins: [persistenceRef],
  });

  const initialiseEditorIndexedDB = useCallback(async () => {
    const generation = ++bootstrapGenerationRef.current;
    setSyncStatus('syncing');
    setIsContentBootstrapReady(false);

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
      // dDoc parity: host/published state is present in the one Y.Doc before
      // IndexedDB replay and before SyncManager is allowed to connect.
      mergePublishedContentIntoYdoc(ydoc, portalContent);

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
        } catch (error) {
          const indexedDbError =
            error instanceof Error ? error : new Error(String(error));
          console.error(
            '[DSheet] IndexedDB initialization failed:',
            indexedDbError,
          );
          const failedPersistence = persistenceRef.current;
          persistenceRef.current = null;
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

      // IndexedDB may contain a legacy plain-object sheet array. Persist its
      // migration before connection so local-only diff seeding sends the same
      // structure Fortune will render.
      migrateSheetArrayIfNeeded(ydoc, ydoc.getArray(dsheetId));

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
        ydoc.destroy();
        ydocRef.current = null;
      }
    };
  }, [ydoc]);

  // Content bootstrap effect: published state → IndexedDB replay → migration.
  // Never replaces the Y.Doc — SyncManager, persistence, and Fortune share it.
  useEffect(() => {
    void initialiseEditorIndexedDB();

    return () => {
      bootstrapGenerationRef.current += 1;
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
    getContentSnapshot,
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
