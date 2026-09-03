import { afterEach, describe, expect, it, vi } from "vitest";
import { fromUint8Array } from "js-base64";
import * as Y from "yjs";

import type { CollabConnectionConfig } from "../../sync-local/types";
import {
  COLLAB_WARM_MS,
  createCollaborationConnectionController,
  getWorkbookHydrationReason,
  isLiveCollaborationSession,
  mergePublishedContentIntoYdoc,
  shouldRehydrateWorkbookOnReady,
  shouldInitializeDefaultWorkbook,
  shouldRenderBootstrappedWorkbook,
} from "./collaboration-lifecycle";

const connection = (
  overrides: Partial<CollabConnectionConfig> = {},
): CollabConnectionConfig => ({
  roomKey: "room-key",
  roomId: "sheet-1",
  wsUrl: "ws://localhost:5000",
  isOwner: true,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dDoc-parity collaboration connection lifecycle", () => {
  it("distinguishes durable transport from a live collaboration session", () => {
    expect(isLiveCollaborationSession(undefined)).toBe(false);
    expect(
      isLiveCollaborationSession({
        enabled: true,
        connection: connection({ livePresence: false }),
        session: { username: "Josh" },
        services: {},
      }),
    ).toBe(false);
    expect(
      isLiveCollaborationSession({
        enabled: true,
        connection: connection({ livePresence: true }),
        session: { username: "Josh" },
        services: {},
      }),
    ).toBe(true);
    expect(
      isLiveCollaborationSession({
        enabled: true,
        connection: connection(),
        session: { username: "Josh" },
        services: {},
      }),
    ).toBe(true);
  });

  it.each([{ livePresence: true }, { connectOnOpen: true }])(
    "connects and stays connected for $livePresence$connectOnOpen",
    (flags) => {
      vi.useFakeTimers();
      const connect = vi.fn();
      const disconnect = vi.fn();
      const controller = createCollaborationConnectionController({
        connection: connection(flags),
        isSocketConnectedRef: { current: false },
        getIndexeddbOrigin: () => null,
        isBootstrapReady: true,
        connect,
        disconnect,
      });

      expect(connect).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(COLLAB_WARM_MS * 2);
      expect(disconnect).not.toHaveBeenCalled();
      controller.dispose();
    },
  );

  it("connects lazily on a local edit and disconnects after the exact warm window", () => {
    vi.useFakeTimers();
    const connect = vi.fn();
    const disconnect = vi.fn();
    const indexeddbOrigin = {};
    const socketRef = { current: false };
    const controller = createCollaborationConnectionController({
      connection: connection(),
      isSocketConnectedRef: socketRef,
      getIndexeddbOrigin: () => indexeddbOrigin,
      isBootstrapReady: true,
      connect,
      disconnect,
    });

    controller.onYdocUpdate(new Uint8Array(), "self");
    controller.onYdocUpdate(new Uint8Array(), "remote");
    controller.onYdocUpdate(new Uint8Array(), indexeddbOrigin);
    expect(connect).not.toHaveBeenCalled();

    controller.onYdocUpdate(new Uint8Array([1]), null);
    expect(connect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(COLLAB_WARM_MS - 1);
    expect(disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(socketRef.current).toBe(false);
  });

  it("resets the warm timer on another edit and never terminates during disposal", () => {
    vi.useFakeTimers();
    const connect = vi.fn();
    const disconnect = vi.fn();
    const controller = createCollaborationConnectionController({
      connection: connection(),
      isSocketConnectedRef: { current: false },
      getIndexeddbOrigin: () => null,
      isBootstrapReady: true,
      connect,
      disconnect,
    });

    controller.onYdocUpdate(new Uint8Array([1]), null);
    vi.advanceTimersByTime(COLLAB_WARM_MS - 1_000);
    controller.onYdocUpdate(new Uint8Array([2]), null);
    vi.advanceTimersByTime(1_001);
    expect(disconnect).not.toHaveBeenCalled();

    controller.dispose();
    vi.advanceTimersByTime(COLLAB_WARM_MS);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("does not connect before content bootstrap completes", () => {
    const connect = vi.fn();
    const controller = createCollaborationConnectionController({
      connection: connection({ livePresence: true }),
      isSocketConnectedRef: { current: false },
      getIndexeddbOrigin: () => null,
      isBootstrapReady: false,
      connect,
      disconnect: vi.fn(),
    });

    controller.onYdocUpdate(new Uint8Array([1]), null);
    expect(connect).not.toHaveBeenCalled();
    controller.dispose();
  });
});

describe("published dSheet collaboration bootstrap", () => {
  it("merges published and local state once using the self origin", () => {
    const published = new Y.Doc();
    published.getMap("published").set("value", "server artifact");
    const encoded = fromUint8Array(Y.encodeStateAsUpdate(published));

    const local = new Y.Doc();
    local.getMap("local").set("value", "indexeddb draft");
    const origins: unknown[] = [];
    local.on("update", (_update, origin) => origins.push(origin));

    expect(mergePublishedContentIntoYdoc(local, encoded)).toBe(true);
    expect(local.getMap("published").get("value")).toBe("server artifact");
    expect(local.getMap("local").get("value")).toBe("indexeddb draft");
    expect(origins).toEqual(["self"]);

    expect(mergePublishedContentIntoYdoc(local, encoded)).toBe(false);
    expect(origins).toEqual(["self"]);

    published.destroy();
    local.destroy();
  });

  it("retains a published baseline during collaboration but waits when no baseline exists", () => {
    expect(shouldRenderBootstrappedWorkbook(true, 1)).toBe(true);
    expect(shouldRenderBootstrappedWorkbook(true, 0)).toBe(false);
    expect(shouldRenderBootstrappedWorkbook(false, 0)).toBe(true);
  });

  it("initializes a default workbook only after durable hydration for collaboration", () => {
    expect(shouldInitializeDefaultWorkbook("syncing", false, undefined)).toBe(
      false,
    );
    expect(shouldInitializeDefaultWorkbook("synced", false, undefined)).toBe(
      true,
    );
    expect(shouldInitializeDefaultWorkbook("synced", true, "syncing")).toBe(
      false,
    );
    expect(shouldInitializeDefaultWorkbook("synced", true, "ready")).toBe(true);
  });

  it("merges a 100k-cell artifact as one idempotent Yjs seed update", () => {
    const published = new Y.Doc();
    const sheets = published.getArray<Y.Map<unknown>>("sheet-1");
    const sheet = new Y.Map<unknown>();
    const cells = new Y.Map<unknown>();
    sheet.set("id", "sheet-1");
    for (let index = 0; index < 100_000; index += 1) {
      const row = Math.floor(index / 1_000);
      const column = index % 1_000;
      cells.set(`${row}_${column}`, { r: row, c: column, v: { v: index } });
    }
    sheet.set("celldata", cells);
    sheets.push([sheet]);

    const local = new Y.Doc();
    let updateCount = 0;
    local.on("update", () => {
      updateCount += 1;
    });
    const encoded = fromUint8Array(Y.encodeStateAsUpdate(published));

    expect(mergePublishedContentIntoYdoc(local, encoded)).toBe(true);
    expect(
      (
        local
          .getArray<Y.Map<unknown>>("sheet-1")
          .get(0)
          .get("celldata") as Y.Map<unknown>
      ).size,
    ).toBe(100_000);
    expect(updateCount).toBe(1);
    expect(mergePublishedContentIntoYdoc(local, encoded)).toBe(false);
    expect(updateCount).toBe(1);

    published.destroy();
    local.destroy();
  });
});

describe("Fortune hydration transitions", () => {
  it("rebuilds once for initial ready and once for each later ready transition", () => {
    expect(getWorkbookHydrationReason("syncing", "connecting", false)).toBe(
      null,
    );
    expect(getWorkbookHydrationReason("ready", "syncing", false)).toBe(
      "initial",
    );
    expect(getWorkbookHydrationReason("ready", "ready", true)).toBe(null);
    expect(getWorkbookHydrationReason("reconnecting", "ready", true)).toBe(
      null,
    );
    expect(getWorkbookHydrationReason("ready", "syncing", true)).toBe(
      "reconnect",
    );
  });

  it("keeps a fresh owner's workbook mounted when the first sync has no peer updates", () => {
    expect(
      shouldRehydrateWorkbookOnReady({
        reason: "initial",
        isOwner: true,
        hasUnmergedPeerUpdates: false,
      }),
    ).toBe(false);
  });

  it("rehydrates initial peer state and every reconnect", () => {
    expect(
      shouldRehydrateWorkbookOnReady({
        reason: "initial",
        isOwner: true,
        hasUnmergedPeerUpdates: true,
      }),
    ).toBe(true);
    expect(
      shouldRehydrateWorkbookOnReady({
        reason: "initial",
        isOwner: false,
        hasUnmergedPeerUpdates: false,
      }),
    ).toBe(true);
    expect(
      shouldRehydrateWorkbookOnReady({
        reason: "reconnect",
        isOwner: true,
        hasUnmergedPeerUpdates: false,
      }),
    ).toBe(true);
  });
});
