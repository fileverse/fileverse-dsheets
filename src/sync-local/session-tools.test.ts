import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  instances: [] as Array<{
    fetchHydrationRange: ReturnType<typeof vi.fn>;
    sendSnapshot: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>,
  hydrationResponses: [] as Array<unknown>,
  snapshotResponse: { status: true } as Record<string, unknown>,
  decryptData: vi.fn(),
  encryptData: vi.fn(),
}));

vi.mock('./socketClient', () => ({
  SocketClient: class MockSocketClient {
    fetchHydrationRange = vi.fn(async () =>
      harness.hydrationResponses.shift(),
    );
    sendSnapshot = vi.fn(async () => harness.snapshotResponse);
    disconnect = vi.fn();

    constructor(config: Record<string, unknown>) {
      harness.configs.push(config);
      harness.instances.push(this);
    }

    connectSocket(callbacks: { onHandshakeSuccess: () => void }) {
      callbacks.onHandshakeSuccess();
      return Promise.resolve();
    }
  },
}));

vi.mock('./crypto', () => ({
  crypto: {
    decryptData: harness.decryptData,
    encryptData: harness.encryptData,
  },
}));

import { fetchSessionState, seedSession } from './session-tools';

const ownerAuth = {
  wsUrl: 'wss://collab.example',
  roomKey: 'unused-owner-room-key',
  roomId: 'unused-owner-room-id',
  isOwner: true,
  identityToken: 'owner-identity',
};

describe('headless collaboration session tools', () => {
  beforeEach(() => {
    harness.configs.length = 0;
    harness.instances.length = 0;
    harness.hydrationResponses.length = 0;
    harness.snapshotResponse = { status: true };
    harness.decryptData.mockReset();
    harness.encryptData.mockReset();
  });

  it('hydrates every page with the canonical dsheet id and skips poison rows', async () => {
    harness.hydrationResponses.push(
      {
        status: true,
        data: {
          history: [{ data: 'first' }, { data: 'poison' }],
          hasMore: true,
          nextSeq: 7,
        },
      },
      {
        status: true,
        data: {
          history: [{ data: 'second' }],
          hasMore: false,
        },
      },
    );
    harness.decryptData.mockImplementation(
      (_roomKey: Uint8Array, encrypted: string) => {
        if (encrypted === 'poison') throw new Error('undecryptable');
        return encrypted === 'first'
          ? Uint8Array.from([1])
          : Uint8Array.from([2]);
      },
    );

    const updates = await fetchSessionState({
      dsheetId: 'sheet-42',
      roomKey: 'AQIDBA==',
      ownerAuth,
    });

    expect(harness.configs[0]).toMatchObject({
      wsUrl: 'wss://collab.example',
      roomId: 'sheet-42',
      roomKey: 'AQIDBA==',
      identityToken: 'owner-identity',
      joinOnly: true,
    });
    expect(
      harness.instances[0].fetchHydrationRange.mock.calls,
    ).toEqual([[undefined], [7]]);
    expect(updates).toEqual([Uint8Array.from([1]), Uint8Array.from([2])]);
    expect(harness.instances[0].disconnect).toHaveBeenCalledOnce();
  });

  it('seeds a new durable room as one encrypted floor-zero snapshot', async () => {
    const state = Uint8Array.from([9, 8, 7]);
    harness.encryptData.mockReturnValue('encrypted-snapshot');

    await seedSession({
      dsheetId: 'sheet-42',
      newRoomKey: 'BQYHCA==',
      state,
      ownerAuth,
    });

    expect(harness.configs[0]).toMatchObject({
      roomId: 'sheet-42',
      roomKey: 'BQYHCA==',
      joinOnly: false,
    });
    expect(harness.encryptData).toHaveBeenCalledWith(
      Uint8Array.from([5, 6, 7, 8]),
      state,
    );
    expect(harness.instances[0].sendSnapshot).toHaveBeenCalledWith({
      data: 'encrypted-snapshot',
      floorSeq: 0,
    });
    expect(harness.instances[0].disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects when a hydration pull fails', async () => {
    harness.hydrationResponses.push({
      status: false,
      error: 'history unavailable',
    });

    await expect(
      fetchSessionState({
        dsheetId: 'sheet-42',
        roomKey: 'AQIDBA==',
        ownerAuth,
      }),
    ).rejects.toThrow('history unavailable');
    expect(harness.instances[0].disconnect).toHaveBeenCalledOnce();
  });
});
