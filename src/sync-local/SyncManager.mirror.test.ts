/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// connect() constructs a SocketClient; this stand-in never completes the handshake, so a
// test can observe what connect() set up synchronously.
vi.mock('./socketClient', () => ({
  SocketClient: class MockSocketClient {
    connectSocket() {
      return new Promise(() => {});
    }
    disconnect() {}
  },
}));

import { SyncManager } from './SyncManager';

type EncryptMirror = (yjsUpdate: Uint8Array) => Promise<string | null>;

// 32 zero bytes, base64 — a stand-in room key; nothing here decrypts with it.
const DUMMY_ROOM_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const NEW_ROOM_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

function makeReadyManager(encryptMirror: EncryptMirror) {
  const socket = {
    sendMirrorSnapshot: vi.fn(async () => ({ status: true })),
    disconnect: vi.fn(),
    flushBeacon: vi.fn(),
    // rekey() path: re-auth, then a gap catch-up read of an empty tail.
    rekey: vi.fn(async () => {}),
    fetchHydrationRange: vi.fn(async () => ({
      status: true,
      data: { history: [], hasMore: false },
    })),
    setDocumentMeta: vi.fn(async () => {}),
  };
  const manager = new SyncManager({ ydoc: new Y.Doc() }, () => {});
  const internal = manager as any;
  internal._status = 'ready';
  internal.socketClient = socket;
  internal.encryptMirror = encryptMirror;
  internal.roomKey = DUMMY_ROOM_KEY;
  internal.roomKeyBytes = new Uint8Array(32);
  return { manager, socket };
}

describe('SyncManager mirror authoring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends nothing when encryptMirror resolves to null', async () => {
    const { manager, socket } = makeReadyManager(async () => null);
    await (manager as any).authorMirror();
    expect(socket.sendMirrorSnapshot).not.toHaveBeenCalled();
  });

  it('does not send a mirror longer than 9,000,000 characters', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { manager, socket } = makeReadyManager(async () =>
      'x'.repeat(9_000_001),
    );
    await (manager as any).authorMirror();
    expect(socket.sendMirrorSnapshot).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('flushPendingMirror sends a pending mirror immediately', async () => {
    const { manager, socket } = makeReadyManager(async () => 'cipher');
    (manager as any).scheduleMirror();
    manager.flushPendingMirror();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sendMirrorSnapshot).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(socket.sendMirrorSnapshot).toHaveBeenCalledTimes(1);
  });

  it('flushPendingMirror is a no-op when nothing is pending', async () => {
    const { manager, socket } = makeReadyManager(async () => 'cipher');
    manager.flushPendingMirror();
    await vi.runAllTimersAsync();
    expect(socket.sendMirrorSnapshot).not.toHaveBeenCalled();
  });

  it('a second flush after the first is a no-op', async () => {
    const { manager, socket } = makeReadyManager(async () => 'cipher');
    (manager as any).scheduleMirror();
    manager.flushPendingMirror();
    manager.flushPendingMirror();
    await vi.runAllTimersAsync();
    expect(socket.sendMirrorSnapshot).toHaveBeenCalledTimes(1);
  });

  it('flushPendingMirror while disconnected sends nothing and does not throw', async () => {
    const { manager, socket } = makeReadyManager(async () => 'cipher');
    (manager as any).scheduleMirror();
    (manager as any)._status = 'idle';
    expect(() => manager.flushPendingMirror()).not.toThrow();
    await vi.runAllTimersAsync();
    expect(socket.sendMirrorSnapshot).not.toHaveBeenCalled();
  });

  it('flushPendingMirror logs a throwing encryptMirror instead of rejecting', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { manager } = makeReadyManager(async () => {
      throw new Error('boom');
    });
    (manager as any).scheduleMirror();
    manager.flushPendingMirror();
    await vi.runAllTimersAsync();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('no mirror is scheduled or sent after rekey', async () => {
    const { manager, socket } = makeReadyManager(async () => 'cipher');
    (manager as any).scheduleMirror();
    await manager.rekey(NEW_ROOM_KEY);
    (manager as any).scheduleMirror();
    manager.flushPendingMirror();
    await vi.advanceTimersByTimeAsync(4000);
    expect(socket.sendMirrorSnapshot).not.toHaveBeenCalled();
    expect((manager as any).encryptMirror).toBeNull();
  });

  it('in-flight mirror after rekey is dropped', async () => {
    let release!: (v: string) => void;
    const { manager, socket } = makeReadyManager(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const pending = (manager as any).authorMirror();
    await manager.rekey(NEW_ROOM_KEY);
    release('cipher');
    await pending;
    expect(socket.sendMirrorSnapshot).not.toHaveBeenCalled();
  });

  it('mirroring stays off after forceCleanup and a fresh connect with the same config', async () => {
    const encryptMirror = vi.fn(async () => 'cipher');
    const { manager } = makeReadyManager(encryptMirror);
    await manager.rekey(NEW_ROOM_KEY);
    manager.forceCleanup();
    void manager.connect({
      wsUrl: 'wss://collab.example',
      roomKey: DUMMY_ROOM_KEY,
      roomId: 'room',
      isOwner: false,
      encryptMirror,
    } as any);
    expect((manager as any).encryptMirror).toBeNull();
    expect((manager as any).mirrorDisabled).toBe(true);
  });

  it('a rekey whose re-auth fails still disables mirroring', async () => {
    const { manager, socket } = makeReadyManager(async () => 'cipher');
    socket.rekey.mockRejectedValueOnce(new Error('re-auth failed'));
    await expect(manager.rekey(NEW_ROOM_KEY)).rejects.toThrow('re-auth failed');
    (manager as any).scheduleMirror();
    await vi.advanceTimersByTimeAsync(4000);
    expect(socket.sendMirrorSnapshot).not.toHaveBeenCalled();
  });

  it('sends a mirror at exactly the cap', async () => {
    const atCap = 'x'.repeat(9_000_000);
    const { manager, socket } = makeReadyManager(async () => atCap);
    await (manager as any).authorMirror();
    expect(socket.sendMirrorSnapshot).toHaveBeenCalledWith({
      data: atCap,
      fileKeyEpoch: 0,
    });
  });
});
