/* eslint-disable @typescript-eslint/ban-ts-comment */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Workbook } from '@sheet-engine/react';
import type {
  SidebarPortalRegistryHandle,
  SidebarPortalRenderer,
} from '@sheet-engine/react';
import type { ThemeKey } from '@sheet-engine/core/theme';
import { Cell } from '@sheet-engine/react';
import {
  TOOL_BAR_ITEMS,
  CELL_CONTEXT_MENU_ITEMS,
  HEADER_CONTEXT_MENU_ITEMS,
  DEFAULT_SHEET_DATA,
} from '../constants/shared-constants';
import {
  getCustomToolbarItems,
  getReadOnlyCustomToolbarItems,
} from '../utils/custom-toolbar-item';
import { useEditor } from '../contexts/editor-context';
import { useCollabAwareness } from '../hooks/use-collab-awareness';
import { afterUpdateCell } from '../utils/after-update-cell';
import { dataVerificationYdocUpdate } from '../utils/data-verification-ydoc-update';
import { liveQueryListYdocUpdate } from '../utils/live-query-list-ydoc-update';
import { calcChainYdocUpdate } from '../utils/calc-chain-ydoc-update';
import { conditionFormatYdocUpdate } from '../utils/condition-format-ydoc-update';
import { dataBlockListYdocUpdate } from '../utils/data-block-list-ydoc-update';
import { filterSelectYdocUpdate } from '../utils/filter-select-ydoc-update';
import { filterYdocUpdate } from '../utils/filter-ydoc-update';
import { hyperlinkYdocUpdate } from '../utils/hyperlink-ydoc-update';
import { configYdocUpdate } from '../utils/config-ydoc-update';
import {
  definedNamesYdocUpdate,
  getDefinedNamesYMap,
  readDefinedNamesFromYdoc,
} from '../utils/defined-names-ydoc';
import { updateYdocSheetData, SheetChangePath } from '../utils/update-ydoc';
import { applyCellFormatRangesCommits } from '../../sheet-engine/core/utils/mirror-cell-format-ranges';
import { invalidateFormulaWorkerSnapshot } from '../../sheet-engine/core/modules/formula-worker-bridge';
import { handleCSVUpload } from '../utils/csv-import';
import { handleExportToXLSX } from '../utils/xlsx-export';
import { handleExportToCSV } from '../utils/csv-export';
import { handleExportToJSON } from '../utils/json-export';
import { useXLSXImport } from '../hooks/use-xlsx-import';
import { usehandleHomepageRedirect } from '../hooks/use-homepage-redirect';
import { OnboardingHandlerType } from '../types';
import type { DSheetPermissionMode } from '../types';
import { PermissionChip } from './permission-chip';
import {
  createAfterColRowChangesHandler,
  createAfterColorChangesHandler,
  createAfterHideChangesHandler,
  createAfterOrderChangesHandler,
  createSheetLengthChangeHandler,
  syncCurrentSheetField,
  updateAllCell,
} from './editor-workbook-sync';
import { CommentsConfig } from '../types/comments';
import { CommentCellUI } from './comments/comment-cell-popup';
import {
  hideCellCommentMarker,
  closeCellCommentPopup,
} from '../utils/cell-comment-marker';
import { getCurrentSheetIdSafe } from '../utils/sheet-editor-safe';
import { detachWorkbookData } from '../utils/detach-workbook-data';
// import { useEditorData } from '../hooks/use-editor-data';
// Use the types defined in types.ts
type OnboardingHandler = OnboardingHandlerType;

function readBooleanFromLocalStorage(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

interface EditorWorkbookProps {
  setShowFetchURLModal?: React.Dispatch<React.SetStateAction<boolean>>;
  setFetchingURLData?: (fetching: boolean) => void;
  setInputFetchURLDataBlock?: React.Dispatch<React.SetStateAction<string>>;
  isReadOnly?: boolean;
  allowSheetDownload?: boolean;
  toggleTemplateSidebar?: () => void;
  onboardingComplete?: boolean;
  onboardingCompleteLocalStorageKey?: string;
  onboardingHandler?: OnboardingHandler;
  exportDropdownOpen?: boolean;
  commentsConfig?: CommentsConfig;
  setExportDropdownOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  dsheetId: string;
  onDuneChartEmbed?: () => void;
  onSheetCountChange?: (sheetCount: number) => void;
  sidebarActivePanel?: string | null;
  sidebarPortalRegistry?: SidebarPortalRegistryHandle | null;
  sidebarPortalRenderers?: Record<string, SidebarPortalRenderer>;
  permissionMode?: DSheetPermissionMode | null;
  onEnterEdit?: () => void;
  onSignInToComment?: () => void;
  onViewerModeChange?: (mode: 'comment' | 'view') => void;
  theme?: ThemeKey;
}

/**
 * EditorWorkbook component handles rendering the Fortune Workbook with proper configuration
 */
const EditorWorkbookComponent: React.FC<EditorWorkbookProps> = ({
  setInputFetchURLDataBlock,
  setShowFetchURLModal,
  setFetchingURLData,
  isReadOnly = false,
  allowSheetDownload = false,
  toggleTemplateSidebar,
  onboardingComplete,
  onboardingCompleteLocalStorageKey,
  onboardingHandler,
  exportDropdownOpen = false,
  commentsConfig,
  setExportDropdownOpen = () => { },
  dsheetId,
  onDuneChartEmbed,
  onSheetCountChange,
  sidebarActivePanel = null,
  sidebarPortalRegistry = null,
  sidebarPortalRenderers = {},
  permissionMode = null,
  onEnterEdit,
  onSignInToComment,
  onViewerModeChange,
  theme,
}) => {
  const {
    setSelectedTemplate,
    sheetEditorRef,
    ydocRef,
    currentDataRef,
    forceSheetRender,
    setForceSheetRender,
    syncStatus,
    dataBlockCalcFunction,
    setDataBlockCalcFunction,
    isAuthorized,
    getDocumentTitle,
    updateDocumentTitle,
    handleLiveQuery,
    setIsDataLoaded,
    awareness,
    collabEnabled,
    isLiveCollabSession,
    collabIsOwner,
    setSheetEditorRef,
    remoteUpdateRef,
    apiKeyStorage,
    openApiKeyModal,
    onDataBlockEvent,
    smartContract,
  } = useEditor();

  const localUserEditRef = useRef(false);

  // Read the latest commentsConfig at call time via a ref so `getCommentCellUI`
  // keeps a STABLE identity. Otherwise a new commentsConfig object on every
  // comment action would churn the prop and re-render the memoized Workbook
  // (visible canvas glitch). FortuneCore calls getCommentCellUI lazily, so
  // ref.current is always fresh when a popup actually renders.
  const commentsConfigRef = useRef(commentsConfig);
  commentsConfigRef.current = commentsConfig;
  const hasComments = !!commentsConfig;
  const allowComments = !commentsConfig?.disabled;

  const removeCommentFromCell = useCallback(
    (row: number, col: number) => {
      hideCellCommentMarker(sheetEditorRef, row, col);
    },
    [sheetEditorRef],
  );

  const closeCommentPopup = useCallback(() => {
    closeCellCommentPopup(sheetEditorRef);
  }, [sheetEditorRef]);

  const getCommentCellUI = useMemo(() => {
    if (!hasComments) return undefined;
    return (
      row: number,
      col: number,
      dragHandler: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => void,
      isHover?: boolean,
    ) => {
      const cfg = commentsConfigRef.current;
      if (!cfg) return null;
      const isAuthed = cfg.isAuthenticated ?? true;
      const sheetId = getCurrentSheetIdSafe(sheetEditorRef);
      const key = `${sheetId}_${row}_${col}`;
      const comment = cfg.commentsData[key];
      if (!isAuthed) return cfg.unauthenticatedFallback ?? null;
      return (
        <CommentCellUI
          row={row}
          col={col}
          sheetId={sheetId}
          comment={comment}
          onSendComment={(_k, textareaId) => cfg.onSendComment(key, textareaId)}
          onAction={cfg.onCommentAction}
          ownerAddress={cfg.ownerAddress}
          currentUserAddress={cfg.currentUserAddress}
          isOwner={cfg.isOwner}
          sheetEditorRef={sheetEditorRef as never}
          currentUserName={cfg.userName}
          removeCommentFromCell={removeCommentFromCell}
          closePopup={closeCommentPopup}
          dragHandler={dragHandler}
          isHover={isHover}
          disabled={cfg.disabled}
        />
      );
    };
  }, [hasComments, sheetEditorRef, removeCommentFromCell, closeCommentPopup]);

  // Block metadata → ydoc echoes only while a remote apply is in flight
  // (remoteApplyDepth > 0). User-initiated edits run when depth is zero.
  const guardRemoteEcho = useCallback(
    (fn: () => void) => () => {
      if (remoteUpdateRef.current) return;
      fn();
    },
    [remoteUpdateRef],
  );

  const applyDefinedNamesFromYdoc = useCallback(() => {
    const ydoc = ydocRef.current;
    const setContext = sheetEditorRef.current?.getWorkbookSetContext?.() as
      | ((updater: (draft: any) => void) => void)
      | undefined;
    if (!ydoc || !setContext) return;

    const names = readDefinedNamesFromYdoc(ydoc, dsheetId);
    remoteUpdateRef.current = true;
    try {
      setContext((draft) => {
        draft.definedNames = names;
      });
      invalidateFormulaWorkerSnapshot();
    } finally {
      requestAnimationFrame(() => {
        remoteUpdateRef.current = false;
      });
    }
  }, [dsheetId, remoteUpdateRef, sheetEditorRef, ydocRef]);

  // Rehydrate named ranges after Workbook remount (Context resets to []).
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        applyDefinedNamesFromYdoc();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [forceSheetRender, applyDefinedNamesFromYdoc]);

  // Collaborative / IDB updates to the workbook-level definedNames map.
  useEffect(() => {
    const ydoc = ydocRef.current;
    if (!ydoc || !dsheetId) return undefined;
    const map = getDefinedNamesYMap(ydoc, dsheetId);
    const onChange = () => {
      applyDefinedNamesFromYdoc();
    };
    map.observe(onChange);
    return () => {
      map.unobserve(onChange);
    };
  }, [dsheetId, ydocRef, applyDefinedNamesFromYdoc, forceSheetRender]);

  const awarenessRef = useRef(awareness);
  useEffect(() => {
    awarenessRef.current = awareness;
  }, [awareness]);

  useCollabAwareness(awareness, sheetEditorRef);

  const onboardingLsKey =
    onboardingCompleteLocalStorageKey ?? 'onboardingComplete';

  const effectiveOnboardingComplete = useMemo(() => {
    if (typeof onboardingComplete === 'boolean') {
      return onboardingComplete;
    }
    return readBooleanFromLocalStorage(onboardingLsKey);
  }, [onboardingComplete, onboardingLsKey]);

  // const { setIsDataLoaded } = useEditorData();

  useEffect(() => {
    if (dataBlockCalcFunction) {
      dataBlockListYdocUpdate({
        sheetEditorRef,
        ydocRef,
        dsheetId,
        dataBlockCalcFunction,
      });
    }
  }, [dataBlockCalcFunction]);

  useEffect(() => {
    // @ts-ignore
    window.editorRef = sheetEditorRef.current;
    // @ts-ignore
    window.ydocRef = ydocRef.current;
    // @ts-ignore
    window.currentDataRef = currentDataRef;
    // @ts-ignore move this to firward ref
    window.setForceRenderEditor = setForceSheetRender;
    return () => {
      // @ts-ignore
      delete window.editorRef;
      // @ts-ignore
      delete window.ydocRef;
      // @ts-ignore
      delete window.currentDataRef;
      // @ts-ignore
      delete window.setForceRenderEditor;
    };
  }, [isReadOnly]);

  const { handleOnChangePortalUpdate } = useEditor();

  // Initialize XLSX import functionality
  const { handleXLSXUpload } = useXLSXImport({
    sheetEditorRef,
    ydocRef,
    setForceSheetRender,
    dsheetId,
    currentDataRef,
    updateDocumentTitle,
    handleContentPortal: handleOnChangePortalUpdate,
  });

  usehandleHomepageRedirect({
    setIsDataLoaded,
    setSelectedTemplate,
    handleXLSXUpload,
    handleCSVUpload,
    ydocRef,
    dsheetId,
    currentDataRef,
    setForceSheetRender,
    sheetEditorRef,
    updateDocumentTitle,
  });

  const cellContextMenu = isReadOnly
    ? allowComments
      ? ['comment', 'copy']
      : ['copy']
    : CELL_CONTEXT_MENU_ITEMS;
  const headerContextMenu = isReadOnly ? ['filter'] : HEADER_CONTEXT_MENU_ITEMS;
  const toolbarItems = isReadOnly
    ? allowComments
      ? ['filter', 'sort', 'comment']
      : ['filter', 'sort']
    : TOOL_BAR_ITEMS;

  const syncContext = {
    sheetEditorRef,
    ydocRef,
    dsheetId,
    handleOnChangePortalUpdate,
  };
  const handleSheetLengthChange = createSheetLengthChangeHandler({
    ...syncContext,
    currentDataRef,
  });
  const handleAfterOrderChanges = createAfterOrderChangesHandler(syncContext);
  const handleAfterColorChanges = createAfterColorChangesHandler(syncContext);
  const handleAfterHideChanges = createAfterHideChangesHandler(syncContext);
  const handleAfterColRowChanges = createAfterColRowChangesHandler(syncContext);

  //@ts-ignore
  const handleUpdateAllCell = useCallback(
    (subSheetId: string) => updateAllCell(syncContext, subSheetId),
    [dsheetId, handleOnChangePortalUpdate],
  );

  const workbookData = useMemo(() => {
    const sourceData =
      currentDataRef.current && currentDataRef.current.length > 0
        ? currentDataRef.current
        : isReadOnly
          ? []
          : DEFAULT_SHEET_DATA;

    return detachWorkbookData(sourceData);
  }, [dsheetId, forceSheetRender, isReadOnly]);

  // Memoize stable Workbook props; sidebar portal props are merged after to avoid
  // rebuilding customToolbarItems (which glitches the toolbar) on panel switches.
  const workbookElement = useMemo(() => {
    // Create a unique key to force re-render when needed
    const workbookKey = `workbook-${dsheetId}-${forceSheetRender}`;

    return (
      // @ts-ignore
      <Workbook
        isFlvReadOnly={isReadOnly}
        isRTCActive={isLiveCollabSession}
        isAuthorized={isAuthorized}
        theme={theme}
        key={workbookKey}
        ref={setSheetEditorRef}
        suppressInitialCellSelection={
          !effectiveOnboardingComplete && !!onboardingHandler
        }
        // @ts-ignore
        data={workbookData}
        toolbarItems={toolbarItems}
        cellContextMenu={cellContextMenu}
        headerContextMenu={headerContextMenu}
        //@ts-ignore
        getCommentCellUI={getCommentCellUI}
        showFormulaBar={true}
        showToolbar={true}
        toolbarTrailingContent={
          permissionMode ? (
            <div
              className="dsheet-permission-chip-wrap fortune-toolbar-item"
              data-testid="dsheet-permission-chip-wrap"
            >
              <PermissionChip
                mode={permissionMode}
                onEnterEdit={onEnterEdit}
                onSignInToComment={onSignInToComment}
                onViewerModeChange={onViewerModeChange}
              />
            </div>
          ) : null
        }
        lang={'en'}
        rowHeaderWidth={60}
        columnHeaderHeight={24}
        defaultColWidth={104}
        defaultRowHeight={23}
        customToolbarItems={
          isReadOnly
            ? allowSheetDownload
              ? getReadOnlyCustomToolbarItems({
                setExportDropdownOpen,
                handleExportToXLSX,
                handleExportToCSV,
                handleExportToJSON,
                sheetEditorRef,
                ydocRef,
                dsheetId,
                getDocumentTitle,
              })
              : []
            : getCustomToolbarItems({
              handleContentPortal: handleOnChangePortalUpdate,
              setShowSmartContractModal: smartContract.enabled
                ? smartContract.setShowSmartContractModal
                : undefined,
              getDocumentTitle,
              updateDocumentTitle,
              setExportDropdownOpen,
              handleCSVUpload,
              // @ts-ignore
              handleXLSXUpload,
              handleExportToXLSX,
              handleExportToCSV,
              handleExportToJSON,
              sheetEditorRef,
              ydocRef,
              dsheetId,
              currentDataRef,
              setForceSheetRender,
              toggleTemplateSidebar,
              setShowFetchURLModal,
            })
        }
        hooks={{
          onLocalCellEdit: () => {
            localUserEditRef.current = true;
          },
          afterUpdateCell: (
            row: number,
            column: number,
            _oldValue: Cell,
            newValue: Cell,
          ): void => {
            const refObj = { current: sheetEditorRef.current };
            afterUpdateCell({
              handleContentPortal: handleOnChangePortalUpdate,
              dsheetId,
              ydocRef,
              oldValue: _oldValue,
              row,
              column,
              newValue,
              sheetEditorRef: refObj,
              onboardingComplete: effectiveOnboardingComplete,
              // @ts-ignore
              setFetchingURLData,
              onboardingHandler,
              apiKeyStorage,
              openApiKeyModal,
              onDataBlockEvent,
              setInputFetchURLDataBlock,
              setDataBlockCalcFunction,
              dataBlockCalcFunction,
              handleSmartContractQuery: smartContract.handleSmartContractQuery,
              handleLiveQueryData: handleLiveQuery,
              collabEnabled,
              collabIsOwner,
              remoteUpdateRef,
              localUserEditRef,
            });
            localUserEditRef.current = false;
          },
          // @ts-ignore Fortune Hooks type misses this runtime hook.
          sheetLengthChange: handleSheetLengthChange,
          dataVerificationChange: guardRemoteEcho(() => {
            dataVerificationYdocUpdate({
              sheetEditorRef,
              ydocRef,
              dsheetId,
              handleContentPortal: handleOnChangePortalUpdate,
            });
          }),
          liveQueryChange: guardRemoteEcho(() => {
            liveQueryListYdocUpdate({
              sheetEditorRef,
              ydocRef,
              dsheetId,
              handleContentPortal: handleOnChangePortalUpdate,
            });
          }),
          calcChainChange: guardRemoteEcho(() => {
            calcChainYdocUpdate({
              sheetEditorRef,
              ydocRef,
              dsheetId,
              handleContentPortal: handleOnChangePortalUpdate,
            });
          }),
          conditionFormatChange: guardRemoteEcho(() => {
            conditionFormatYdocUpdate({
              sheetEditorRef,
              ydocRef,
              dsheetId,
              handleContentPortal: handleOnChangePortalUpdate,
            });
          }),
          // @ts-ignore Fortune Hooks type misses this runtime hook.
          filterSelectChange: guardRemoteEcho(() => {
            filterSelectYdocUpdate({
              sheetEditorRef,
              ydocRef,
              dsheetId,
              handleContentPortal: handleOnChangePortalUpdate,
            });
          }),
          // @ts-ignore Fortune Hooks type misses this runtime hook.
          filterChange: guardRemoteEcho(() => {
            filterYdocUpdate({
              sheetEditorRef,
              ydocRef,
              dsheetId,
              handleContentPortal: handleOnChangePortalUpdate,
            });
          }),
          hyperlinkChange: guardRemoteEcho(() => {
            hyperlinkYdocUpdate({
              sheetEditorRef,
              ydocRef,
              dsheetId,
              handleContentPortal: handleOnChangePortalUpdate,
            });
          }),
          definedNamesChange: guardRemoteEcho(() => {
            definedNamesYdocUpdate({
              sheetEditorRef,
              ydocRef,
              dsheetId,
              handleContentPortal: handleOnChangePortalUpdate,
            });
          }),
          updateCellYdoc: (changes: SheetChangePath[]) => {
            updateYdocSheetData(
              ydocRef.current,
              dsheetId,
              changes,
              handleOnChangePortalUpdate,
              (commits) => {
                applyCellFormatRangesCommits(
                  commits,
                  sheetEditorRef.current?.getWorkbookSetContext?.() ?? null,
                );
              },
            );
          },
          afterImagesChange: guardRemoteEcho(() => {
            syncCurrentSheetField(syncContext, 'images');
          }),
          afterIframesChange: guardRemoteEcho(() => {
            syncCurrentSheetField(syncContext, 'iframes');
          }),
          afterFrozenChange: guardRemoteEcho(() => {
            syncCurrentSheetField(syncContext, 'frozen');
          }),
          afterNameChanges: guardRemoteEcho(() => {
            syncCurrentSheetField(syncContext, 'name');
          }),
          afterOrderChanges: handleAfterOrderChanges,
          afterConfigChanges: guardRemoteEcho(() => {
            configYdocUpdate({
              sheetEditorRef,
              ydocRef,
              dsheetId,
              handleContentPortal: handleOnChangePortalUpdate,
            });
          }),
          // @ts-ignore Fortune Hooks type misses this runtime hook.
          updateAllCell: (subSheetId: string, caller?: string) => {
            setTimeout(() => {
              updateAllCell(
                {
                  sheetEditorRef,
                  ydocRef,
                  dsheetId,
                  handleOnChangePortalUpdate,
                },
                subSheetId,
                caller ?? 'hook',
              );
            }, 500);
          },
          // @ts-ignore Fortune Hooks type misses this runtime hook.
          afterColorChanges: handleAfterColorChanges,
          // @ts-ignore Fortune Hooks type misses this runtime hook.
          afterHideChanges: handleAfterHideChanges,
          afterColRowChanges: handleAfterColRowChanges,
          afterShowGridLinesChange: guardRemoteEcho(() => {
            syncCurrentSheetField(syncContext, 'showGridLines');
          }),
          afterSelectionChange: (
            sheetId: string,
            selection: import('../../sheet-engine/core/types').Selection,
          ) => {
            const aw = awarenessRef.current;
            if (!aw) return;
            const r = selection.row_focus ?? selection.row?.[0];
            const c = selection.column_focus ?? selection.column?.[0];
            if (r == null || c == null) return;
            aw.setLocalStateField('cell', { r, c, sheetId });
          },
        }}
        onDuneChartEmbed={onDuneChartEmbed}
        onSheetCountChange={onSheetCountChange}
      />
    );
  }, [
    forceSheetRender,
    workbookData,
    isReadOnly,
    allowSheetDownload,
    toggleTemplateSidebar,
    effectiveOnboardingComplete,
    onboardingCompleteLocalStorageKey,
    onboardingHandler,
    dsheetId,
    exportDropdownOpen,
    getCommentCellUI,
    syncStatus,
    isAuthorized,
    collabEnabled,
    isLiveCollabSession,
    collabIsOwner,
    setSheetEditorRef,
    dataBlockCalcFunction,
    permissionMode,
    onEnterEdit,
    onSignInToComment,
    onViewerModeChange,
    theme,
  ]);

  return React.cloneElement(workbookElement, {
    sidebarActivePanel,
    sidebarPortalRegistry,
    sidebarPortalRenderers,
  });
};

export const EditorWorkbook = React.memo(EditorWorkbookComponent);
