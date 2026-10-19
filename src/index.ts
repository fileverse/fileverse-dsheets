// Main component
export { default as DSheetEditor } from './editor/dsheet-editor';
export { default as DSheetSkeleton } from './editor/components/skeleton-loader';

// Utilities
export { formulaResponseUiSync } from './editor/utils/formula-ui-sync';
export { executeStringFunction } from './editor/utils/executeStringFunction';
export { FLVURL } from '@fileverse-dev/formulajs';
export { loadLocale } from '@sheet-engine/core';

// Types
export type {
  ErrorMessageHandlerReturnType,
  DataBlockEvent,
  DataBlockEventType,
  ApiKeyStorage,
  DSheetEditorHandle,
  DSheetPermissionMode,
} from './editor/types';
export type { PanelConfig, PanelId, BuiltInPanelType } from './editor/types';
export type {
  CommentThread,
  CommentReply,
  CommentActionParams,
  CommentsConfig,
  CommentAnchorMove,
} from './editor/types/comments';
export { CommentAction } from './editor/types/comments';
export { remapCommentAnchors } from './editor/utils/remap-comment-anchors';
export { CommentsContent } from './editor/components/comments/comment-sidebar';
export { CommentCellUI } from './editor/components/comments/comment-cell-popup';
export { useEnsStatus } from './editor/components/comments/ens/use-ens-status';
export type { EnsStatus } from './editor/components/comments/ens/ens-cache';
export type {
  SmartContractConfig,
  SmartContractEvent,
  SmartContractEventType,
  ContractConfig,
  ContractRegistry,
  NewContractInput,
} from './editor/types/smart-contract';
export { SupportedChain } from './editor/types/smart-contract';
export type { WorkbookInstance } from '@sheet-engine/react';
export type {
  CollaborationProps,
  CollabConnectionConfig,
  CollabSessionMeta,
  CollabServices,
  CollabCallbacks,
  CollabState,
  CollabStatus,
  CollabError,
  CollabErrorCode,
  CollabUser,
} from './sync-local/types';
export { fetchSessionState, seedSession } from './sync-local/session-tools';
export {
  encryptForRoomKey,
  decryptForRoomKey,
} from './sync-local/crypto/room-key';

// Constants
export {
  ERROR_MESSAGES_FLAG,
  SERVICES_API_KEY,
} from './editor/constants/shared-constants';
// Subpath import avoids the package barrel (`index.js`), which statically
// re-exports heavy JSON — bundlers would otherwise pull all templates into the graph.
export { TEMPLATES } from '@fileverse-dev/dsheets-templates/template-metadata-list';

// Import/Export utilities
export { handleCSVUpload } from './editor/utils/csv-import';
export {
  importSpreadsheetFile,
  type ImportSpreadsheetFileOptions,
  type ImportSpreadsheetFileResult,
  type SpreadsheetImportFileType,
} from './editor/utils/spreadsheet-import';
export { handleExportToXLSX, handleExportToODS } from './editor/utils/xlsx-export';
export { handleExportToCSV } from './editor/utils/csv-export';
export { handleExportToJSON } from './editor/utils/json-export';
export { useXLSXImport } from './editor/hooks/use-xlsx-import';

// Full fortune-core namespace (used by dsheets.new as FortuneCore.*)
export * as FortuneCore from '@sheet-engine/core';

// Named re-exports from fortune-core used directly by dsheets.new navbar
export {
  // data-menu.tsx
  createFilter,
  clearFilter,
  handleSort,
  getRemoveDuplicatesPreview,
  removeDuplicates,
  getRemoveDuplicatesErrorMessage,
  // edit-menu.tsx
  handleCopy,
  handlePasteByClick,
  removeActiveImage,
  jfrefreshgrid,
  deleteSelectedCellText,
  deleteRowCol,
  // format-menu.tsx
  getFlowdata,
  updateFormat,
  handleTextSize,
  handleHorizontalAlign,
  handleVerticalAlign,
  toolbarItemClickHandler,
  getSheetIndex,
  handleMerge,
  clearSelectedCellFormat,
  clearColumnsCellsFormat,
  clearRowsCellsFormat,
  // view-menu.tsx
  handleFreeze,
  // insert-menu.tsx
  insertRowCol,
  showImgChooser,
  handleLink,
  // common
  api,
  describeMatchedShortcut,
  isBrowserZoomShortcut,
  isFormulaListShortcut,
  isOpenShortcutsModalShortcut,
} from '@sheet-engine/core';
export type { PatchOptions } from '@sheet-engine/core';

// Ethereum Swarm storage: serverless persistence with version history
export {
  createSwarmDocumentStorage,
  canSaveToSwarm,
  generateDocumentKey,
  makeDocumentFeedTopic,
} from './swarm/swarm-document-storage';
export type {
  SwarmDocumentStorage,
  SwarmDocumentStorageConfig,
  DocumentSnapshot,
  DocumentVersion,
} from './swarm/swarm-document-storage';
export { SwarmTimeoutError } from './swarm/swarm-common';
export type {
  SwarmProgress,
  SwarmProgressHandler,
  SwarmRequestConfig,
} from './swarm/swarm-common';
export {
  detectSwarmTransport,
  createBeeHttpTransport,
  createSwarmProviderTransport,
  probeLatestFeedIndex,
} from './swarm/swarm-transport';
export type {
  SwarmTransport,
  SwarmTransportStatus,
  SwarmProvider,
  BeeHttpTransportConfig,
  TransportDetectionConfig,
} from './swarm/swarm-transport';
export {
  diagnoseSwarm,
  primarySwarmCondition,
} from './swarm/swarm-diagnostics';
export type {
  SwarmCondition,
  SwarmConditionKind,
  SwarmDiagnosticsInput,
  SwarmRemedy,
  SwarmRemedyKind,
} from './swarm/swarm-diagnostics';
export {
  makeFeedTopic,
  writeFeedUpdate,
  readLatestFeedIndex,
  readFeedUpdate,
  feedOwnerAddress,
} from './swarm/swarm-feeds';
export type { SwarmFeedConfig } from './swarm/swarm-feeds';
export {
  listStamps,
  getStamp,
  stampUtilization,
  checkStampHealth,
  buyStamp,
  topUpStamp,
  diluteStamp,
  getChainState,
  getWalletBalance,
  estimateBatch,
  amountForDuration,
  MIN_BATCH_DEPTH,
  CHUNK_SIZE_BYTES,
  PLUR_PER_BZZ,
  BLOCK_TIME_SECONDS,
} from './swarm/swarm-stamps';
export type {
  SwarmNodeConfig,
  PostageStamp,
  StampHealth,
  StampHealthThresholds,
  ChainState,
  WalletBalance,
  BatchEstimate,
} from './swarm/swarm-stamps';
