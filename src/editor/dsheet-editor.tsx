import React, { useCallback, useEffect, useMemo, useState } from 'react';
import cn from 'classnames';
import * as Y from 'yjs';
import { DEFAULT_SHEET_DATA } from './constants/shared-constants';
import { useFortuneDocumentStyle } from './hooks/use-document-style';
import {
  type DSheetEditorHandle,
  DsheetProps,
  EditorValues,
  OnboardingHandlerType,
} from './types';
import SkeletonLoader from './components/skeleton-loader';
import { EditorProvider, useEditor } from './contexts/editor-context';
import { EditorWorkbook } from './components/editor-workbook';
import { ApiKeyModal } from './components/api-key-modal/api-key-modal';
import { useApplyTemplatesBtn } from './hooks/use-apply-templates';
import { TransitionWrapper } from './components/transition-wrapper';
import { resolvePermissionChipMode } from './components/permission-chip-model';
import '@sheet-engine/react/index.css';
import './styles/index.css';
import { useSidebar } from './components/sidebar/sidebar-context';
import { useSidebarPortalRegistryHandle } from './components/sidebar/sidebar-portal-registry';
import { EditorRightSidebar } from './components/sidebar/editor-right-sidebar';
import { PanelConfig } from './types';
import { DataVerification } from './components/sidebars/data-verification';
import { ConditionalFormat } from './components/sidebars/conditional-format';
import { NamedRanges } from './components/sidebars/named-ranges';
import { Templates } from './components/sidebars/templates';
import FunctionContent from './components/sidebars/function-content';
import { TemplatePreview, Template } from './components/sidebars/template-ui';
import { useMediaQuery } from 'usehooks-ts';
import { CommentsContent } from './components/comments/comment-sidebar';
import { setEnsResolutionUrl } from './components/comments/ens/ens-cache';
import { CommentsConfig } from './types/comments';
import { SmartContractModal } from './components/smart-contract/smart-contract-modal';
import { SmartContractListView } from './components/smart-contract/smart-contract-view-list';
import { SmartContractReadingIntro } from './components/smart-contract/smart-contract-reading-intro';
import { SmartContractReadingErrorToast } from './components/smart-contract/error-toast';
import { SMART_CONTRACT_PANEL_ID } from './utils/smart-contract/constants';
import './components/smart-contract/index.css';
import { shouldInitializeDefaultWorkbook } from './hooks/collaboration-lifecycle';

// Use the types defined in types.ts
type OnboardingHandler = OnboardingHandlerType;

/**
 * EditorContent - Internal component that renders the editor content
 * Uses the context to access state and renders appropriate UI
 */
const EditorContent = ({
  setShowFetchURLModal,
  renderNavbar,
  isReadOnly,
  permissionMode,
  onEnterEdit,
  onSignInToComment,
  onViewerModeChange,
  allowSheetDownload,
  toggleTemplateSidebar,
  onboardingComplete,
  onboardingCompleteLocalStorageKey,
  onboardingHandler,
  isTemplateOpen,
  exportDropdownOpen,
  setExportDropdownOpen,
  dsheetId,
  commentsConfig,
  selectedTemplate,
  setFetchingURLData,
  setInputFetchURLDataBlock,
  onDuneChartEmbed,
  onSheetCountChange,
  isNewSheet,
  customPanels,
  theme,
}: Pick<
  DsheetProps,
  | 'renderNavbar'
  | 'isReadOnly'
  | 'permissionMode'
  | 'onEnterEdit'
  | 'onSignInToComment'
  | 'onViewerModeChange'
  | 'allowSheetDownload'
  | 'toggleTemplateSidebar'
  | 'selectedTemplate'
  | 'dsheetId'
  | 'setFetchingURLData'
  | 'setShowFetchURLModal'
  | 'setInputFetchURLDataBlock'
  | 'isNewSheet'
  | 'theme'
> & {
  commentsConfig?: CommentsConfig;
  isTemplateOpen?: boolean;
  exportDropdownOpen: boolean;
  setExportDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onboardingComplete?: boolean;
  onboardingCompleteLocalStorageKey?: string;
  onboardingHandler?: OnboardingHandler;
  onDuneChartEmbed?: () => void;
  onSheetCountChange?: (sheetCount: number) => void;
  customPanels?: PanelConfig[];
}) => {
  const resolvedPermissionMode = resolvePermissionChipMode({
    allowComments: !commentsConfig?.disabled,
    isReadOnly: Boolean(isReadOnly),
    permissionMode,
  });
  const {
    loading,
    syncStatus,
    collabEnabled,
    collabState,
    sheetEditorRef,
    currentDataRef,
    ydocRef,
    setForceSheetRender,
    setDataBlockCalcFunction,
    initialiseLiveQueryData,
    setSelectedTemplate: contextSetSelectedTemplate,
    apiKeyModalState,
    isAuthorized,
    smartContract,
  } = useEditor();

  const { activePanel, isOpen, openPanel, closePanel, togglePanel } =
    useSidebar();
  const sidebarPortalRegistry = useSidebarPortalRegistryHandle();

  // Stable reference so the memoized EditorWorkbook (and its toolbar) is not
  // rebuilt on every panel toggle.
  const openTemplatesPanel = useCallback(
    () => togglePanel('templates'),
    [togglePanel],
  );

  const [internalSelectedTemplate, setInternalSelectedTemplate] = useState<
    string | null
  >(null);
  const [hoveredTemplate, setHoveredTemplate] = useState<Template | null>(null);
  const [shouldHandleSuggestionFromCell, setShouldHandleSuggestionFromCell] =
    useState(0);
  const isMobile = useMediaQuery('(max-width: 840px)', { defaultValue: false });

  const builtInPanels: PanelConfig[] = [
    ...(smartContract.enabled
      ? [
          {
            id: SMART_CONTRACT_PANEL_ID,
            header: { title: 'My smart contracts' },
            width: '380px',
            content: (
              <SmartContractListView
                userSmartContracts={smartContract.userSmartContracts}
                onDelete={smartContract.onDelete}
                handleSearch={smartContract.handleSearch}
                onOpenImportModal={() =>
                  smartContract.setShowSmartContractModal(true)
                }
                fetchContractAbi={smartContract.fetchContractAbi}
                isAuthorized={isAuthorized}
              />
            ),
          },
        ]
      : []),
    ...(commentsConfig
      ? [
        {
          id: 'comments',
          header: { title: 'Comments' },
          width: '380px',
          content: (
            <CommentsContent
              sheetEditorRef={sheetEditorRef}
              userName={commentsConfig.userName}
              commentsData={commentsConfig.commentsData}
              onSendComment={commentsConfig.onSendComment}
              onCommentAction={commentsConfig.onCommentAction}
              ownerAddress={commentsConfig.ownerAddress}
              currentUserAddress={commentsConfig.currentUserAddress}
              isOwner={commentsConfig.isOwner}
              disabled={commentsConfig.disabled}
              isAuthenticated={commentsConfig.isAuthenticated}
              unauthenticatedFallback={commentsConfig.unauthenticatedFallback}
            />
          ),
        },
      ]
      : []),
    {
      id: 'templates',
      header: {
        title: 'Templates',
        subtitle:
          'Start with pre-built templates. Includes smart contract analysis, real time coins price and much more for blockchain analytics',
      },
      width: '380px',
      content: (
        <Templates
          setSelectedTemplate={(slug) => setInternalSelectedTemplate(slug)}
          setHoveredTemplate={setHoveredTemplate}
        />
      ),
    },
    {
      id: 'data-verification',
      header: { title: 'Data Validation' },
      width: '380px',
      content: <DataVerification />,
    },
    {
      id: 'conditional-format',
      header: { title: 'Conditional Formatting' },
      width: '380px',
      content: <ConditionalFormat />,
    },
    {
      id: 'named-ranges',
      header: { title: 'Named ranges' },
      width: '380px',
      content: <NamedRanges />,
    },
    {
      id: 'functions',
      header: { title: 'Function' },
      width: '380px',
      content: (
        <FunctionContent
          sheetEditorRef={sheetEditorRef}
          shouldHandleSuggestionFromCell={shouldHandleSuggestionFromCell}
        />
      ),
    },
  ];

  const allPanels: PanelConfig[] = [...builtInPanels, ...(customPanels ?? [])];

  const activePanelConfig = (() => {
    const panel = allPanels.find((p) => p.id === activePanel);
    if (!panel) return null;
    return {
      id: panel.id,
      width: panel.width ?? '380px',
      header: panel.header,
      content: panel.content,
    };
  })();

  // Initialize template button functionality
  useApplyTemplatesBtn({
    selectedTemplate: internalSelectedTemplate ?? selectedTemplate,
    setSelectedTemplate: (slug: string | null) => {
      setInternalSelectedTemplate(null);
      contextSetSelectedTemplate?.(slug as any);
    },
    ydocRef,
    dsheetId,
    currentDataRef,
    setForceSheetRender,
    sheetEditorRef,
    setDataBlockCalcFunction,
    initialiseLiveQueryData,
  });

  // Apply custom styling based on dropdown and template states
  useFortuneDocumentStyle({
    exportDropdownOpen,
    isTemplateOpen,
    isReadOnly,
    loading,
  });

  useEffect(() => {
    setEnsResolutionUrl(commentsConfig?.ensResolutionUrl);
  }, [commentsConfig?.ensResolutionUrl]);

  // Create editor values to pass to the navbar

  const editorValues: EditorValues = useMemo(
    () => ({
      sheetEditorRef,
      currentDataRef,
      ydocRef,
      openPanel,
      closePanel,
    }),
    [sheetEditorRef, currentDataRef, ydocRef, openPanel, closePanel],
  );

  const navbarContent = useMemo(
    () => (renderNavbar ? renderNavbar(editorValues) : null),
    [renderNavbar, editorValues],
  );

  const shouldRenderSheet = currentDataRef.current.length > 0 || isNewSheet;

  const cellArrayToYMap = (celldata: any[] = []) => {
    const yCellMap = new Y.Map();

    celldata.forEach((cell) => {
      if (
        cell == null ||
        typeof cell.r !== 'number' ||
        typeof cell.c !== 'number'
      ) {
        return;
      }
      yCellMap.set(`${cell.r}_${cell.c}`, cell);
    });

    return yCellMap;
  };

  const plainSheetToYMap = (sheet: any, index = 0) => {
    const ySheet = new Y.Map();

    ySheet.set('id', sheet.id ?? crypto.randomUUID());
    ySheet.set('name', sheet.name ?? `Sheet${index + 1}`);
    ySheet.set('order', sheet.order ?? index);
    ySheet.set('row', sheet.row ?? 500);
    ySheet.set('column', sheet.column ?? 36);
    ySheet.set('status', sheet.status ?? (index === 0 ? 1 : 0));
    ySheet.set('config', sheet.config ?? {});
    ySheet.set('celldata', cellArrayToYMap(sheet.celldata ?? []));
    ySheet.set('calcChain', cellArrayToYMap(sheet.calcChain ?? []));
    ySheet.set('dataBlockCalcFunction', sheet.dataBlockCalcFunction ?? {});
    const yDataBlockList = new Y.Map();
    ySheet.set('dataBlockCalcFunction', yDataBlockList);
    const yLiveQueryList = new Y.Map();
    ySheet.set('liveQueryList', yLiveQueryList);
    const dataVerification = new Y.Map();
    ySheet.set('dataVerification', dataVerification);
    const conditionRules = new Y.Map();
    ySheet.set('conditionRules', conditionRules);
    const luckysheet_conditionformat_save = new Y.Array();
    ySheet.set(
      'luckysheet_conditionformat_save',
      luckysheet_conditionformat_save,
    );
    return ySheet;
  };

  useEffect(() => {
    if (!isNewSheet || !ydocRef.current || !dsheetId) return;

    // An empty collaborative Y.Doc only means "brand new" after the durable
    // room has hydrated. This avoids racing a default sheet into an existing
    // room while still allowing a genuinely empty room to become editable.
    if (
      !shouldInitializeDefaultWorkbook(
        syncStatus,
        collabEnabled === true,
        collabState?.status,
      )
    ) {
      return;
    }

    ydocRef.current.transact(() => {
      const sheetArray = ydocRef.current?.getArray(dsheetId);
      //@ts-ignore
      const sData: any = [];
      if (sheetArray?.toArray().length === 0 && ydocRef.current) {
        DEFAULT_SHEET_DATA.forEach((sheet, index) => {
          const id = crypto.randomUUID();
          sheet = {
            ...sheet,
            id,
          };
          sheetArray?.insert(0, [plainSheetToYMap(sheet, index)]);
          sData.push(sheet);
        });
        //@ts-ignore
        currentDataRef.current = sData;
      }
    });
  }, [
    isNewSheet,
    syncStatus,
    collabEnabled,
    collabState?.status,
    dsheetId,
    ydocRef,
    currentDataRef,
  ]);

  return (
    <div
      style={{ height: 'calc(100vh)' }}
      className={cn('dsheet-editor', isReadOnly && 'fortune-read-only')}
      data-testid="dsheet-editor"
    >
      {/* Hidden DOM triggers — FortuneCore fires these by id via element.click() */}
      <button
        id="data-verification-button"
        className="hidden"
        onClick={() => togglePanel('data-verification')}
      />
      <button
        id="conditional-format-button"
        className="hidden"
        onClick={() => openPanel('conditional-format')}
      />
      <button
        id="named-ranges-button"
        className="hidden"
        onClick={() => openPanel('named-ranges')}
      />
      <button
        id="smartcontract-button"
        className="hidden"
        onClick={() => openPanel(SMART_CONTRACT_PANEL_ID)}
      />
      <button
        id="view-smart-contract"
        className="hidden"
        onClick={() => openPanel(SMART_CONTRACT_PANEL_ID)}
      />
      <button
        id="function-button"
        className="hidden"
        onClick={() => {
          openPanel('functions');
          setShouldHandleSuggestionFromCell((p) => p + 1);
        }}
      />

      {renderNavbar && (
        <nav
          id="Navbar"
          className={cn(
            'dsheet-nav h-[44px] color-bg-default px-4 flex gap-2 items-center justify-between w-screen fixed left-0 top-0 border-b color-border-default z-10 transition-transform duration-300',
            {
              'translate-y-0': true,
              'translate-y-[-100%]': false,
            },
          )}
          data-testid="dsheet-navbar"
        >
          {navbarContent}
        </nav>
      )}

      <div
        className="dsheet-editor-main relative overflow-hidden h-[94dvh] md:!h-[calc(100vh-44px)] mt-[44px]"
        data-testid="dsheet-editor-main"
      >
        <TransitionWrapper show={true}>
          <SkeletonLoader isReadOnly={isReadOnly} />
        </TransitionWrapper>

        <TransitionWrapper show={!loading && shouldRenderSheet} duration={1000}>
          <EditorWorkbook
            setShowFetchURLModal={setShowFetchURLModal}
            setFetchingURLData={setFetchingURLData}
            setInputFetchURLDataBlock={setInputFetchURLDataBlock}
            commentsConfig={commentsConfig}
            isReadOnly={isReadOnly}
            allowSheetDownload={allowSheetDownload}
            toggleTemplateSidebar={openTemplatesPanel}
            onboardingComplete={onboardingComplete}
            onboardingCompleteLocalStorageKey={
              onboardingCompleteLocalStorageKey
            }
            onboardingHandler={onboardingHandler}
            exportDropdownOpen={exportDropdownOpen}
            setExportDropdownOpen={setExportDropdownOpen}
            dsheetId={dsheetId}
            onDuneChartEmbed={onDuneChartEmbed}
            onSheetCountChange={onSheetCountChange}
            sidebarActivePanel={activePanel}
            sidebarPortalRegistry={sidebarPortalRegistry}
            permissionMode={resolvedPermissionMode}
            onEnterEdit={onEnterEdit}
            onSignInToComment={onSignInToComment}
            onViewerModeChange={onViewerModeChange}
            theme={theme}
          />
        </TransitionWrapper>
      </div>

      <EditorRightSidebar
        isOpen={isOpen && activePanelConfig !== null}
        activePanelConfig={activePanelConfig}
        onClose={closePanel}
        isReadOnly={isReadOnly}
      />
      {hoveredTemplate && !isMobile && (
        <TemplatePreview template={hoveredTemplate} />
      )}

      {apiKeyModalState && (
        <ApiKeyModal
          open={apiKeyModalState.open}
          apiKeyName={apiKeyModalState.apiKeyName}
          onSave={apiKeyModalState.onSave}
          onClose={apiKeyModalState.onClose}
        />
      )}

      {smartContract.enabled && (
        <>
          <SmartContractModal
            showSmartContractModal={smartContract.showSmartContractModal}
            setShowSmartContractModal={smartContract.setShowSmartContractModal}
            onSaveContract={smartContract.onImportContract}
            registryMapRef={smartContract.registryMapRef}
          />
          <SmartContractReadingIntro
            isAuthorized={isAuthorized}
            onOpenPanel={openPanel}
          />
          <SmartContractReadingErrorToast
            smartContractReadingError={smartContract.smartContractReadingError}
            setSmartContractReadingError={
              smartContract.setSmartContractReadingError
            }
            openPanel={openPanel}
          />
        </>
      )}
    </div>
  );
};

/**
 * SpreadsheetEditor component that provides a collaborative spreadsheet interface
 * with various import/export capabilities and template support.
 *
 * @param props - Component properties
 * @returns The SpreadsheetEditor component
 */
const SpreadsheetEditor = React.forwardRef<DSheetEditorHandle, DsheetProps>(
  (
    {
  isReadOnly = false,
      permissionMode,
      onEnterEdit,
      onSignInToComment,
      onViewerModeChange,
  allowSheetDownload,
  renderNavbar,
  enableIndexeddbSync,
  dsheetId = '',
  portalContent,
  onContentUpdate,
  onChange,
  username,
  selectedTemplate,
  toggleTemplateSidebar,
  isTemplateOpen,
  onboardingComplete,
  onboardingCompleteLocalStorageKey,
  onboardingHandler,
  commentsConfig,
  setFetchingURLData,
  setShowFetchURLModal,
  setInputFetchURLDataBlock,
  sheetEditorRef: externalSheetEditorRef,
  onDuneChartEmbed,
  onSheetCountChange,
  isAuthorized,
  getDocumentTitle,
  updateDocumentTitle,
  editorStateRef,
  setSelectedTemplate,
  isNewSheet,
  liveQueryRefreshRate,
  enableLiveQuery,
  collaboration,
  customPanels,
  apiKeyStorage,
  onDataBlockEvent,
  smartContracts,
  theme,
  onContentSyncStatusChange,
  onCollaborationInitializationComplete,
      onIndexedDbError,
    }: DsheetProps,
    forwardedEditorRef,
  ): JSX.Element => {
    const [exportDropdownOpen, setExportDropdownOpen] =
      useState<boolean>(false);

  return (
    <EditorProvider
        key={dsheetId}
      setSelectedTemplate={setSelectedTemplate}
      getDocumentTitle={getDocumentTitle}
      updateDocumentTitle={updateDocumentTitle}
      dsheetId={dsheetId}
      username={username}
      portalContent={portalContent}
      enableIndexeddbSync={enableIndexeddbSync}
      isReadOnly={isReadOnly}
      onContentUpdate={onContentUpdate}
      onChange={onChange}
        externalEditorRef={forwardedEditorRef}
        legacyEditorRef={externalSheetEditorRef}
      collaboration={collaboration}
      commentsConfig={commentsConfig}
      isAuthorized={isAuthorized}
      editorStateRef={editorStateRef}
      liveQueryRefreshRate={liveQueryRefreshRate}
      enableLiveQuery={enableLiveQuery}
      apiKeyStorage={apiKeyStorage}
      onDataBlockEvent={onDataBlockEvent}
      smartContracts={smartContracts}
      onContentSyncStatusChange={onContentSyncStatusChange}
      onCollaborationInitializationComplete={
        onCollaborationInitializationComplete
      }
        onIndexedDbError={onIndexedDbError}
    >
      <EditorContent
        commentsConfig={commentsConfig}
        renderNavbar={renderNavbar}
        setFetchingURLData={setFetchingURLData}
        isNewSheet={isNewSheet}
        setShowFetchURLModal={setShowFetchURLModal}
        setInputFetchURLDataBlock={setInputFetchURLDataBlock}
        isReadOnly={isReadOnly}
          permissionMode={permissionMode}
          onEnterEdit={onEnterEdit}
          onSignInToComment={onSignInToComment}
          onViewerModeChange={onViewerModeChange}
        allowSheetDownload={allowSheetDownload}
        toggleTemplateSidebar={toggleTemplateSidebar}
        onboardingComplete={onboardingComplete}
        onboardingCompleteLocalStorageKey={onboardingCompleteLocalStorageKey}
        onboardingHandler={onboardingHandler as OnboardingHandler}
        isTemplateOpen={isTemplateOpen}
        exportDropdownOpen={exportDropdownOpen}
        setExportDropdownOpen={setExportDropdownOpen}
        dsheetId={dsheetId}
        selectedTemplate={selectedTemplate}
        onDuneChartEmbed={onDuneChartEmbed}
        onSheetCountChange={onSheetCountChange}
        customPanels={customPanels}
        theme={theme}
      />
    </EditorProvider>
  );
  },
);

SpreadsheetEditor.displayName = 'SpreadsheetEditor';

export default SpreadsheetEditor;
