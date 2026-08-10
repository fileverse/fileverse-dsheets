import { Sheet } from '@sheet-engine/react';
import { RefObject } from 'react';
import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import { Cell } from '@sheet-engine/react';
import { ERROR_MESSAGES_FLAG } from './constants/shared-constants';
import { CollaborationProps } from '../sync-local/types';
import { CommentsConfig } from './types/comments';
import type { SmartContractConfig } from './types/smart-contract';
import type { ApiKeyStorage } from './utils/api-key-storage';
import type { ThemeKey } from '@sheet-engine/core/theme';
import type { DSheetContentSnapshot } from '../persistence';

export type { ThemeKey } from '@sheet-engine/core/theme';

export type DSheetPermissionMode = 'view' | 'comment' | 'edit';

export type {
  CommentThread,
  CommentReply,
  CommentActionParams,
  CommentsConfig,
} from './types/comments';
export { CommentAction } from './types/comments';

export interface SheetUpdateData {
  data: Sheet[];
}

export interface EditorValues {
  sheetEditorRef: RefObject<WorkbookInstance>;
  currentDataRef: React.MutableRefObject<Sheet[] | null>;
  ydocRef: React.RefObject<Y.Doc | null>;
  openPanel: (panelId: string) => void; // NEW
  closePanel: () => void; // NEW
}

export type DSheetEditorHandle = WorkbookInstance & {
  refreshIndexedDB: () => Promise<void>;
  terminateSession: () => void;
  updateCollaboratorName: (name: string) => void;
  updateSessionTitle: (args: {
    encryptedTitle: string;
    documentTitle: string;
  }) => void;
};

export interface PanelConfig {
  id: string;
  header: {
    title: string;
    subtitle?: string;
  };
  width?: string; // default: '380px'
  content: React.ReactNode;
}

export type {
  PanelId,
  BuiltInPanelType,
} from './components/sidebar/use-right-panels';

// Define the onboarding handler type
export type OnboardingHandlerType = (params: {
  row: number;
  column: number;
  sheetEditorRef: React.RefObject<WorkbookInstance | null>;
}) => { row: number; column: number };

export type DataBlockEventType =
  | 'success'
  | 'error'
  | 'api-key-required'
  | 'api-key-saved'
  | 'retry';

export interface DataBlockEvent {
  type: DataBlockEventType;
  functionName?: string;
  errorType?: string;
  apiKeyName?: string;
}

export type { ApiKeyStorage } from './utils/api-key-storage';

export interface DsheetProps {
  isNewSheet: boolean;
  setSelectedTemplate?: React.Dispatch<React.SetStateAction<string>>;
  getDocumentTitle?: (dsheetId: string) => Promise<string>;
  updateDocumentTitle?: (title: string) => void;
  isAuthorized: boolean;
  setShowFetchURLModal?: React.Dispatch<React.SetStateAction<boolean>>;
  setFetchingURLData?: (fetching: boolean) => void;
  setInputFetchURLDataBlock?: React.Dispatch<React.SetStateAction<string>>;
  renderNavbar?: (editorValues?: EditorValues) => JSX.Element;
  enableIndexeddbSync?: boolean;
  dsheetId: string;
  /**
   * Cheap change signal for hosts that persist sheet bodies through Yjs.
   * Unlike `onChange`, this does not build a plain sheet or encode the Y.Doc.
   */
  onContentUpdate?: () => void;
  onChange?: (updateData: SheetUpdateData, encodedUpdate?: string) => void;
  collaboration?: CollaborationProps;
  /** Called when local IndexedDB persistence fails. The editor and durable
   * collaboration continue using the in-memory Y.Doc, matching dDoc. */
  onIndexedDbError?: (error: Error) => void;
  username?: string;
  portalContent?: string;
  isReadOnly?: boolean;
  /** Permission status displayed above the toolbar. When omitted, read-only
   * sheets retain the existing View/View-and-comment behavior. */
  permissionMode?: DSheetPermissionMode;
  /** Called when a read-only consumer asks to elevate to edit mode. The host
   * owns access proof, loading, errors, and the resulting mode transition. */
  onEnterEdit?: () => void;
  /** Called when an invited commenter needs to authenticate before the host can
   * recover comment capability. */
  onSignInToComment?: () => void;
  /** Lets the host toggle a recovered commenter between comment and view mode. */
  onViewerModeChange?: (mode: 'comment' | 'view') => void;
  allowSheetDownload?: boolean;
  isTemplateOpen?: boolean;
  selectedTemplate?: string;
  onboardingComplete?: boolean;
  /** When `onboardingComplete` is omitted, read `localStorage.getItem(key)==='true'` (default key `onboardingComplete`). */
  onboardingCompleteLocalStorageKey?: string;
  onboardingHandler?: OnboardingHandlerType;
  setForceSheetRender?: React.Dispatch<React.SetStateAction<number>>;
  commentsConfig?: CommentsConfig;
  toggleTemplateSidebar?: () => void;
  /** Legacy ref prop. Standard React refs are also supported. */
  sheetEditorRef?: React.Ref<DSheetEditorHandle>;
  /** Override where datablock API keys are stored (default: localStorage). */
  apiKeyStorage?: ApiKeyStorage;
  /** Optional lifecycle events for analytics / side-effects. */
  onDataBlockEvent?: (event: DataBlockEvent) => void;
  onDuneChartEmbed?: () => void;
  onSheetCountChange?: (sheetCount: number) => void;
  /** Fires whenever local content-sync status changes. Host apps should gate
   * collab start/resume on 'synced' — starting before local content is fully
   * synced is what let the RTC layer bind to a stale doc in the past. */
  onContentSyncStatusChange?: (
    status: 'initializing' | 'syncing' | 'synced' | 'error',
  ) => void;
  /** Fires once the first collaboration sync has been reconciled with the
   * workbook, or when that reconciliation fails. */
  onCollaborationInitializationComplete?: (result: 'ready' | 'error') => void;
  editorStateRef?: React.MutableRefObject<{
    refreshIndexedDB: () => Promise<void>;
    getContentSnapshot: () => DSheetContentSnapshot;
    mergeContent: (encodedState: string) => DSheetContentSnapshot;
  } | null>;
  /** Smart contract config: execution + UI in package; consumer owns persistence via callbacks. */
  smartContracts?: SmartContractConfig;
  enableLiveQuery?: boolean;
  liveQueryRefreshRate?: number;
  customPanels?: PanelConfig[];
  /** Active theme; drives the canvas/grid palette (chrome themes via the <html> class). */
  theme?: ThemeKey;
}
export type BaseError = {
  message: string;
  functionName?: string;
  type: (typeof ERROR_MESSAGES_FLAG)[keyof typeof ERROR_MESSAGES_FLAG];
};

export type CustomError = BaseError & {
  type: typeof ERROR_MESSAGES_FLAG.CUSTOM;
  reason: string;
};

export type InvalidParamError = BaseError & {
  type: typeof ERROR_MESSAGES_FLAG.INVALID_PARAM;
};

export type MissingKeyError = BaseError & {
  type: typeof ERROR_MESSAGES_FLAG.MISSING_KEY;
};

export type EnsResolveError = BaseError & {
  type: typeof ERROR_MESSAGES_FLAG.ENS;
};

export type InvalidApiKeyError = BaseError & {
  type: typeof ERROR_MESSAGES_FLAG.INVALID_API_KEY;
  apiKeyName?: string;
};

export type RateLimitError = BaseError & {
  type: typeof ERROR_MESSAGES_FLAG.RATE_LIMIT;
  apiKeyName?: string;
};

export type NetworkError = BaseError & {
  type: typeof ERROR_MESSAGES_FLAG.NETWORK_ERROR;
  apiKeyName?: string;
};

export type DefaultError = BaseError & {
  type: typeof ERROR_MESSAGES_FLAG.DEFAULT;
  reason: string;
};

export type ErrorMessageHandlerReturnType =
  | InvalidParamError
  | MissingKeyError
  | RateLimitError
  | NetworkError
  | EnsResolveError
  | InvalidApiKeyError
  | CustomError
  | DefaultError;
