import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useEffect,
  useMemo,
  useCallback,
} from 'react';
import throttle from 'lodash/throttle';
import { LiveQueryData, Sheet } from '@sheet-engine/react';
import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { fromUint8Array } from 'js-base64';

import { ySheetArrayToPlain } from '../utils/update-ydoc';
import { useEditorSync } from '../hooks/use-editor-sync';
import { useCelldataCompaction } from '../hooks/use-celldata-compaction';
import { useEditorData } from '../hooks/use-editor-data';
import {
  updateRowIndices,
  updateColumnIndices,
} from '../utils/update-index-after-drag';
import { SheetUpdateData, DataBlockEvent } from '../types';
import type { CommentsConfig } from '../types/comments';
import { ApiKeyStorage, defaultApiKeyStorage } from '../utils/api-key-storage';
import type { OpenApiKeyModalFn } from '../utils/data-block-error-handler';
import type { SmartContractConfig } from '../types/smart-contract';
import {
  useSmartContract,
  type UseSmartContractReturn,
} from '../hooks/use-smart-contract';
import { SidebarProvider } from '../components/sidebar/sidebar-context';
import { SidebarPortalRegistryProvider } from '../components/sidebar/sidebar-portal-registry';
import type {
  CollaborationProps,
  CollabState,
  CollabUser,
} from '../../sync-local/types';
import type { Awareness } from 'y-protocols/awareness';
import type { DSheetContentSnapshot } from '../../persistence';
// Define the shape of the context
export interface EditorContextType {
  setIsDataLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  handleOnChangePortalUpdate: () => void;
  setSelectedTemplate?: React.Dispatch<React.SetStateAction<string>>;
  setShowSmartContractModal?: React.Dispatch<React.SetStateAction<boolean>>;
  getDocumentTitle?: (dsheetId: string) => Promise<string>;
  updateDocumentTitle?: (title: string) => void;
  isAuthorized: boolean;
  dataBlockCalcFunction: { [key: string]: { [key: string]: any } };
  setDataBlockCalcFunction: React.Dispatch<
    React.SetStateAction<{ [key: string]: { [key: string]: any } }>
  >;
  refreshIndexedDB: () => Promise<void>;
  // Core refs
  sheetEditorRef: React.MutableRefObject<WorkbookInstance | null>;
  ydocRef: React.MutableRefObject<Y.Doc | null>;
  persistenceRef: React.MutableRefObject<IndexeddbPersistence | null>;

  // Sheet data
  sheetData: Sheet[];
  setSheetData: React.Dispatch<React.SetStateAction<Sheet[]>>;
  currentDataRef: React.MutableRefObject<Sheet[]>;
  remoteUpdateRef: React.MutableRefObject<boolean>;
  handleChange: (data: Sheet[]) => void;
  initialiseLiveQueryData: (data: Sheet[]) => void;

  // UI states
  loading: boolean;
  forceSheetRender: number;
  setForceSheetRender: React.Dispatch<React.SetStateAction<number>>;

  // Sync status
  syncStatus: 'initializing' | 'syncing' | 'synced' | 'error';

  // Socket.IO collaboration
  collabEnabled?: boolean;
  collabIsOwner?: boolean;
  collabState?: CollabState;
  isCollabReady?: boolean;
  isCollabSyncing?: boolean;
  hasCollabContentInitialised?: boolean;
  awareness?: Awareness | null;
  terminateSession?: () => void;
  onCollaboratorsChange?: (collaborators: CollabUser[]) => void;

  handleLiveQuery: (subsheetIndex: number, data: LiveQueryData) => void;

  apiKeyStorage: ApiKeyStorage;
  onDataBlockEvent?: (event: DataBlockEvent) => void;
  openApiKeyModal: OpenApiKeyModalFn;
  apiKeyModalState: {
    open: boolean;
    apiKeyName: string;
    onSave: (key: string) => void;
    onClose: () => void;
  } | null;
  smartContract: UseSmartContractReturn;
}

// Create the context with a default value
const EditorContext = createContext<EditorContextType | undefined>(undefined);

// Props for the provider component
interface EditorProviderProps {
  setSelectedTemplate?: React.Dispatch<React.SetStateAction<string>>;
  getDocumentTitle?: (dsheetId: string) => Promise<string>;
  updateDocumentTitle?: (title: string) => void;
  isAuthorized: boolean;
  children: React.ReactNode;
  dsheetId: string;
  username?: string;
  portalContent?: string;
  enableIndexeddbSync?: boolean;
  isReadOnly?: boolean;
  onContentUpdate?: () => void;
  onChange?: (data: SheetUpdateData, encodedUpdate?: string) => void;
  collaboration?: CollaborationProps;
  externalEditorRef?: React.MutableRefObject<WorkbookInstance | null>;
  commentsConfig?: CommentsConfig;
  editorStateRef?: React.MutableRefObject<{
    refreshIndexedDB: () => Promise<void>;
    getContentSnapshot: () => DSheetContentSnapshot;
    mergeContent: (encodedState: string) => DSheetContentSnapshot;
    terminateSession?: () => void;
    updateCollaboratorName?: (name: string) => void;
    rehydrateAfterCollabSync?: (reason?: string) => boolean;
  } | null>;
  enableLiveQuery?: boolean;
  liveQueryRefreshRate?: number;
  apiKeyStorage?: ApiKeyStorage;
  onDataBlockEvent?: (event: DataBlockEvent) => void;
  smartContracts?: SmartContractConfig;
  onContentSyncStatusChange?: (
    status: 'initializing' | 'syncing' | 'synced' | 'error',
  ) => void;
}

// Provider component that wraps the app
export const EditorProvider: React.FC<EditorProviderProps> = ({
  setSelectedTemplate,
  getDocumentTitle,
  updateDocumentTitle,
  children,
  dsheetId,
  username = 'Anonymous',
  portalContent = '',
  enableIndexeddbSync = true,
  isReadOnly = false,
  onContentUpdate,
  onChange,
  externalEditorRef,
  collaboration,
  commentsConfig,
  isAuthorized,
  editorStateRef,
  enableLiveQuery,
  liveQueryRefreshRate,
  apiKeyStorage: apiKeyStorageProp,
  onDataBlockEvent,
  smartContracts,
  onContentSyncStatusChange,
}) => {
  // Comments are driven entirely by commentsConfig (the legacy
  // commentData/allowComments props were removed).
  const resolvedCommentData = commentsConfig?.commentsData;
  const resolvedAllowComments = !!commentsConfig;

  const [forceSheetRender, setForceSheetRender] = useState<number>(1);
  const internalEditorRef = useRef<WorkbookInstance | null>(null);
  const sheetEditorRef = externalEditorRef || internalEditorRef;
  const [dataBlockCalcFunction, setDataBlockCalcFunction] = useState<{
    [key: string]: { [key: string]: any };
  }>({});

  const apiKeyStorage = useMemo(
    () => apiKeyStorageProp ?? defaultApiKeyStorage,
    [apiKeyStorageProp],
  );

  const smartContract = useSmartContract(smartContracts);

  const [apiKeyModalState, setApiKeyModalState] = useState<{
    open: boolean;
    apiKeyName: string;
    onSave: (key: string) => void;
    onClose: () => void;
  } | null>(null);

  const openApiKeyModal = useCallback<OpenApiKeyModalFn>(
    (apiKeyName, callbacks) => {
      setApiKeyModalState({
        open: true,
        apiKeyName,
        onSave: (key: string) => {
          setApiKeyModalState(null);
          callbacks.onSave(key);
        },
        onClose: () => {
          setApiKeyModalState(null);
          callbacks.onClose();
        },
      });
    },
    [],
  );

  const updateDataBlockCalcFunctionAfterRowDrag = useCallback(
    (
      selectedSourceIndex: number[],
      selectedTargetIndex: number[],
      type: string,
      sheetId: string,
      sourceIndex: number,
      targetIndex: number,
    ) => {
      setDataBlockCalcFunction((prev) => {
        const cloneDataBlockCalcFunction = { ...prev };
        const sheetData = cloneDataBlockCalcFunction?.[sheetId];

        let result;
        if (type === 'row') {
          result = updateRowIndices(
            sheetData,
            selectedSourceIndex,
            selectedTargetIndex,
            sourceIndex,
            targetIndex,
          );
        } else {
          result = updateColumnIndices(
            sheetData,
            selectedSourceIndex,
            selectedTargetIndex,
            sourceIndex,
            targetIndex,
          );
        }

        if (result !== sheetData) {
          cloneDataBlockCalcFunction[sheetId] = result;
        }

        if (
          JSON.stringify(cloneDataBlockCalcFunction) !== JSON.stringify(prev)
        ) {
          return cloneDataBlockCalcFunction;
        }

        return prev;
      });
    },
    [],
  );

  useEffect(() => {
    // @ts-expect-error exposed for FortuneSheet drag hook
    window.updateDataBlockCalcFunctionAfterRowDrag =
      updateDataBlockCalcFunctionAfterRowDrag;
    return () => {
      // @ts-expect-error exposed for FortuneSheet drag hook
      delete window.updateDataBlockCalcFunctionAfterRowDrag;
    };
  }, [updateDataBlockCalcFunctionAfterRowDrag]);

  // Stable pointer to the latest sheet data — populated by useEditorData below.
  // Declared here so onCollabUpdate (which feeds into useEditorSync) can reference it
  // without causing a TDZ issue or stale closure.
  const currentDataForCollabRef = useRef<Sheet[]>([]);

  const onCollabUpdateRef = useRef(onChange);
  useEffect(() => {
    onCollabUpdateRef.current = onChange;
  }, [onChange]);

  const handleContentUpdateNotification = useMemo(
    () => throttle(() => onContentUpdate?.(), 1000),
    [onContentUpdate],
  );

  // Same-turn ydoc writes (celldata emit, then comment anchors) must encode
  // together. A leading persist in the middle of that stack publishes new
  // cells with old comment positions — viewers then show data that moved and
  // triangles that did not.
  const portalUpdateScheduledRef = useRef(false);

  const rehydrateAfterCollabSyncRef = useRef<(reason: string) => boolean>(
    () => false,
  );

  // onCollabUpdate: called by SyncManager when a remote update arrives.
  const onCollabUpdate = useCallback(
    (fullState: string) => {
      if (!onCollabUpdateRef.current) return;
      onCollabUpdateRef.current(
        { data: currentDataForCollabRef.current },
        fullState,
      );
      handleContentUpdateNotification();
    },
    [handleContentUpdateNotification],
  );

  // Initialize YJS document, persistence, and optional Socket.IO collab transport
  const {
    ydocRef,
    persistenceRef,
    syncStatus,
    isSyncedRef,
    refreshIndexedDB,
    getContentSnapshot,
    mergeContent,
    collabState,
    isCollabReady,
    isCollabSyncing,
    hasCollabContentInitialised,
    awareness,
    terminateSession,
  } = useEditorSync(
    dsheetId,
    enableIndexeddbSync,
    isReadOnly,
    collaboration,
    onCollabUpdate,
  );

  // Let host apps gate collab start/resume on real sync completion.
  useEffect(() => {
    onContentSyncStatusChange?.(syncStatus);
  }, [syncStatus, onContentSyncStatusChange]);

  // Imperatively update the local collaborator's display name in awareness and
  // re-broadcast so peers see the new name (mirrors ddoc's
  // editorRef.current.updateCollaboratorName). Preserves color/isEns/cell.
  const updateCollaboratorName = useCallback(
    (name: string) => {
      if (!awareness) return;
      const local = awareness.getLocalState();
      const prevUser = (local?.user as Record<string, unknown>) || {};
      awareness.setLocalStateField('user', {
        ...prevUser,
        name,
      });
    },
    [awareness],
  );

  // Always-fresh refs for our collab methods so the .current setter below
  // captures the latest closures without re-running.
  const terminateSessionRef = useRef(terminateSession);
  terminateSessionRef.current = terminateSession;
  const updateCollaboratorNameRef = useRef(updateCollaboratorName);
  updateCollaboratorNameRef.current = updateCollaboratorName;

  // Intercept the externalEditorRef's `.current` setter so EVERY write made by
  // Workbook's useImperativeHandle (which regenerates the WorkbookInstance
  // object on each render) re-attaches our collab methods. This way:
  //   - typing/cursor behavior is untouched (we pass sheetEditorRef directly
  //     to <Workbook ref=...> as before — no callback ref).
  //   - sheetEditorRef.current always has .terminateSession + .updateCollaboratorName.
  useEffect(() => {
    if (!externalEditorRef) return;
    let _current = externalEditorRef.current;
    // Attach methods to the value already present on first install too.
    if (_current) {
      (_current as any).terminateSession = terminateSessionRef.current;
      (_current as any).updateCollaboratorName =
        updateCollaboratorNameRef.current;
    }
    try {
      Object.defineProperty(externalEditorRef, 'current', {
        configurable: true,
        get() {
          return _current;
        },
        set(v) {
          if (v) {
            (v as any).terminateSession = terminateSessionRef.current;
            (v as any).updateCollaboratorName =
              updateCollaboratorNameRef.current;
          }
          _current = v;
        },
      });
    } catch {
      // Some hosts may pass a frozen ref — fall back to one-shot attach above.
    }
    return () => {
      // Restore plain property on unmount so we don't trap a stale closure.
      try {
        Object.defineProperty(externalEditorRef, 'current', {
          configurable: true,
          writable: true,
          value: _current,
        });
      } catch {
        // ignore
      }
    };
  }, [externalEditorRef]);

  const handleOnChange = useMemo(
    () =>
      throttle(() => {
        if (!onChange || !ydocRef.current) return;

        const encodedUpdate = fromUint8Array(
          Y.encodeStateAsUpdate(ydocRef.current),
        );
        // Local cell edits update Yjs celldata but do not refresh currentDataRef.
        // Build the legacy plain snapshot from Yjs only for hosts that still
        // request onChange.
        let plain = currentDataRef.current;
        try {
          const sheetArray = ydocRef.current.getArray(dsheetId);
          plain = ySheetArrayToPlain(sheetArray as Y.Array<Y.Map<any>>);
          currentDataRef.current = plain;
        } catch {
          // Fall back to ref if Yjs → plain conversion fails.
        }
        onChange({ data: plain }, encodedUpdate);
      }, 1000),
    [onChange, dsheetId],
  );

  useEffect(
    () => () => {
      handleContentUpdateNotification.cancel();
      handleOnChange.cancel();
    },
    [handleOnChange, handleContentUpdateNotification],
  );

  const flushPortalUpdate = useCallback(() => {
    handleOnChange();
    handleOnChange.flush();
    handleContentUpdateNotification();
    handleContentUpdateNotification.flush();
  }, [handleOnChange, handleContentUpdateNotification]);

  const handleOnChangePortalUpdate = useCallback(() => {
    if (portalUpdateScheduledRef.current) return;
    portalUpdateScheduledRef.current = true;
    queueMicrotask(() => {
      portalUpdateScheduledRef.current = false;
      flushPortalUpdate();
    });
  }, [flushPortalUpdate]);

  useEffect(() => {
    if (!onChange) return;

    const handleBeforeUnload = () => {
      flushPortalUpdate();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [onChange, flushPortalUpdate]);

  // Initialize sheet data
  const {
    sheetData,
    setSheetData,
    currentDataRef,
    remoteUpdateRef,
    isDataLoaded,
    handleChange,
    handleLiveQuery,
    initialiseLiveQueryData,
    setIsDataLoaded,
    rehydrateWorkbookFromYdoc,
  } = useEditorData(
    ydocRef,
    dsheetId,
    sheetEditorRef,
    setForceSheetRender,
    portalContent,
    isReadOnly,
    handleOnChangePortalUpdate,
    syncStatus,
    resolvedCommentData,
    dataBlockCalcFunction,
    setDataBlockCalcFunction,
    enableLiveQuery,
    liveQueryRefreshRate,
    apiKeyStorage,
    openApiKeyModal,
    onDataBlockEvent,
    resolvedAllowComments,
    hasCollabContentInitialised,
    collaboration?.enabled === true,
  );

  useCelldataCompaction({
    dsheetId,
    ydocRef,
    sheetEditorRef,
    currentDataRef,
    handleOnChangePortalUpdate,
    syncStatus,
    isDataLoaded,
    isReadOnly,
    remoteUpdateRef,
    collabSyncing: isCollabSyncing,
  });

  // Keep the stable collab ref in sync with the live currentDataRef
  currentDataForCollabRef.current = currentDataRef.current;

  rehydrateAfterCollabSyncRef.current = rehydrateWorkbookFromYdoc;

  // Expose rehydrate on host-owned editorStateRef for RTC ready callbacks.
  useEffect(() => {
    if (!editorStateRef) return;
    editorStateRef.current = {
      ...editorStateRef.current,
      refreshIndexedDB,
      getContentSnapshot,
      mergeContent,
      rehydrateAfterCollabSync: (reason = 'host') =>
        rehydrateAfterCollabSyncRef.current(reason),
    };
  }, [editorStateRef, getContentSnapshot, mergeContent, refreshIndexedDB]);

  // Force re-render when data changes
  useEffect(() => {
    // If data is loaded from persistence but the sheet isn't rendered yet
    if (isDataLoaded && syncStatus === 'synced' && isSyncedRef.current) {
      setForceSheetRender((prev) => prev + 1);
    }
  }, [isDataLoaded, syncStatus]);

  // Loading state is based on data loading, sync status, and data availability in read-only mode
  const loading =
    !isDataLoaded ||
    syncStatus === 'initializing' ||
    syncStatus === 'syncing' ||
    // In read-only mode, continue showing the loading state if we have no data yet
    (isReadOnly &&
      (!currentDataRef.current || currentDataRef.current.length === 0));

  const collabIsOwner = useMemo(() => {
    if (collaboration?.enabled !== true) return true;
    return collaboration.connection.isOwner;
  }, [collaboration]);

  // Create the context value
  const contextValue: EditorContextType = useMemo(() => {
    return {
      setSelectedTemplate,
      setShowSmartContractModal: smartContract.setShowSmartContractModal,
      getDocumentTitle,
      updateDocumentTitle,
      dataBlockCalcFunction,
      setDataBlockCalcFunction,
      sheetEditorRef,
      ydocRef,
      persistenceRef,
      sheetData,
      setSheetData,
      currentDataRef,
      remoteUpdateRef,
      handleChange,
      loading,
      setIsDataLoaded,
      forceSheetRender,
      setForceSheetRender,
      syncStatus,
      isAuthorized,
      refreshIndexedDB,
      handleLiveQuery,
      initialiseLiveQueryData,
      isReadOnly,
      handleOnChangePortalUpdate,
      // Socket.IO collab
      collabEnabled: collaboration?.enabled === true,
      collabIsOwner,
      collabState,
      isCollabReady,
      isCollabSyncing,
      hasCollabContentInitialised,
      awareness,
      terminateSession,
      onCollaboratorsChange:
        collaboration?.enabled === true
          ? collaboration.on?.onCollaboratorsChange
          : undefined,
      apiKeyStorage,
      onDataBlockEvent,
      openApiKeyModal,
      apiKeyModalState,
      smartContract,
    };
  }, [
    setIsDataLoaded,
    smartContract,
    getDocumentTitle,
    updateDocumentTitle,
    dataBlockCalcFunction,
    setDataBlockCalcFunction,
    sheetEditorRef,
    ydocRef,
    persistenceRef,
    sheetData,
    setSheetData,
    currentDataRef,
    remoteUpdateRef,
    handleChange,
    loading,
    forceSheetRender,
    setForceSheetRender,
    syncStatus,
    isAuthorized,
    handleLiveQuery,
    initialiseLiveQueryData,
    isReadOnly,
    collaboration?.enabled,
    collabIsOwner,
    collabState,
    isCollabReady,
    isCollabSyncing,
    hasCollabContentInitialised,
    awareness,
    terminateSession,
    collaboration,
    apiKeyStorage,
    onDataBlockEvent,
    openApiKeyModal,
    apiKeyModalState,
  ]);

  return (
    <EditorContext.Provider value={contextValue}>
      <SidebarPortalRegistryProvider>
        <SidebarProvider isReadMode={isReadOnly}>{children}</SidebarProvider>
      </SidebarPortalRegistryProvider>
    </EditorContext.Provider>
  );
};

// Custom hook to use the editor context
export const useEditor = (): EditorContextType => {
  const context = useContext(EditorContext);
  if (context === undefined) {
    throw new Error('useEditor must be used within an EditorProvider');
  }
  return context;
};
