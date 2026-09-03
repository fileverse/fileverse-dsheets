import type {
  CollabConnectionConfig,
  CollaborationProps,
} from "../../sync-local/types";
import { mergeDsheetEncodedContent } from "../../persistence-utils";

export const COLLAB_WARM_MS = 30_000;

export const shouldKeepCollaborationSocketAlive = (
  connection: CollabConnectionConfig,
): boolean =>
  connection.livePresence === true || connection.connectOnOpen === true;

// Keep UI restrictions aligned with dDoc: durable transport can be enabled
// without opting the workbook into a live peer/presence session.
export const isLiveCollaborationSession = (
  collaboration?: CollaborationProps,
): boolean =>
  Boolean(
    collaboration?.enabled && (collaboration.connection.livePresence ?? true),
  );

export const isQualifyingCollaborationEdit = (
  origin: unknown,
  indexeddbOrigin: unknown,
  isBootstrapReady: boolean,
): boolean =>
  isBootstrapReady &&
  origin !== "self" &&
  origin !== "remote" &&
  (indexeddbOrigin == null || origin !== indexeddbOrigin);

export const shouldRenderBootstrappedWorkbook = (
  collabEnabled: boolean,
  sheetCount: number,
): boolean => !collabEnabled || sheetCount > 0;

export const shouldInitializeDefaultWorkbook = (
  syncStatus: string | undefined,
  collabEnabled: boolean,
  collabStatus: string | undefined,
): boolean =>
  syncStatus === "synced" && (!collabEnabled || collabStatus === "ready");

export const getWorkbookHydrationReason = (
  status: string | undefined,
  previousStatus: string | undefined,
  hasHydratedReadyState: boolean,
): "initial" | "reconnect" | null => {
  if (status !== "ready" || previousStatus === "ready") return null;
  return hasHydratedReadyState ? "reconnect" : "initial";
};

export const shouldRehydrateWorkbookOnReady = ({
  reason,
  isOwner,
  hasUnmergedPeerUpdates,
}: {
  reason: "initial" | "reconnect";
  isOwner: boolean;
  hasUnmergedPeerUpdates: boolean;
}): boolean => reason === "reconnect" || !isOwner || hasUnmergedPeerUpdates;

export interface CollaborationConnectionController {
  onYdocUpdate: (update: Uint8Array, origin: unknown) => void;
  dispose: () => void;
}

export const createCollaborationConnectionController = (args: {
  connection: CollabConnectionConfig;
  isSocketConnectedRef: { current: boolean };
  getIndexeddbOrigin: () => unknown;
  isBootstrapReady: boolean;
  connect: (connection: CollabConnectionConfig) => void;
  disconnect: () => void;
}): CollaborationConnectionController => {
  let warmTimer: ReturnType<typeof setTimeout> | null = null;

  const doConnect = () => {
    if (args.isSocketConnectedRef.current) return;
    args.isSocketConnectedRef.current = true;
    args.connect(args.connection);
  };
  const doDisconnect = () => {
    if (!args.isSocketConnectedRef.current) return;
    args.isSocketConnectedRef.current = false;
    args.disconnect();
  };
  const armIdle = () => {
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = setTimeout(() => {
      warmTimer = null;
      if (!shouldKeepCollaborationSocketAlive(args.connection)) {
        doDisconnect();
      }
    }, COLLAB_WARM_MS);
  };

  if (
    args.isBootstrapReady &&
    shouldKeepCollaborationSocketAlive(args.connection)
  ) {
    doConnect();
  }

  return {
    onYdocUpdate: (_update, origin) => {
      if (
        !isQualifyingCollaborationEdit(
          origin,
          args.getIndexeddbOrigin(),
          args.isBootstrapReady,
        )
      ) {
        return;
      }
      doConnect();
      armIdle();
    },
    dispose: () => {
      if (warmTimer) clearTimeout(warmTimer);
      warmTimer = null;
    },
  };
};

/**
 * Merge the published artifact into the editor's one durable Y.Doc before
 * IndexedDB replay and collaboration hydration. The `self` origin prevents a
 * late package listener from treating the host seed as a live user edit;
 * SyncManager's state-vector diff still sees it when the room is hydrated.
 */
export const mergePublishedContentIntoYdoc = (
  ydoc: import("yjs").Doc,
  encodedContent?: string,
): boolean => {
  if (!encodedContent) return false;
  return mergeDsheetEncodedContent(ydoc, encodedContent, "self");
};
