import { fromUint8Array } from 'js-base64';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ISocketInitConfig } from './types';

const harness = vi.hoisted(() => ({
  emits: [] as Array<{ event: string; args: Record<string, unknown> }>,
  handlers: new Map<string, (payload?: unknown) => void>(),
}));

vi.mock('socket.io-client', () => ({
  io: () => ({
    id: 'socket-1',
    connected: true,
    on: (event: string, handler: (payload?: unknown) => void) => {
      harness.handlers.set(event, handler);
    },
    emit: (
      event: string,
      args: Record<string, unknown>,
      ack?: (response: unknown) => void,
    ) => {
      harness.emits.push({ event, args });
      if (!ack) return;
      if (event === '/auth') {
        ack({ status: true, statusCode: 200 });
        return;
      }
      if (event === '/documents/peers/list') {
        ack({ status: true, data: { peers: [] } });
        return;
      }
      ack({ status: true });
    },
    disconnect: () => undefined,
    connect: () => undefined,
  }),
}));

vi.mock('@ucans/ucans', () => ({
  EdKeypair: {
    fromSecretKey: () => ({ did: () => 'did:key:z6MkSession' }),
  },
  build: async () => ({ payload: {} }),
  encode: () => 'encoded-ucan',
}));

import { SocketClient } from './socketClient';

const ROOM_KEY = fromUint8Array(new Uint8Array(32).fill(7));

const socketCallbacks = (
  onHandshakeSuccess: () => void,
): ISocketInitConfig => ({
  onHandshakeSuccess,
  onDisconnect: () => undefined,
  onSocketDropped: () => undefined,
  onError: () => undefined,
  onHandShakeError: () => undefined,
  onContentUpdate: () => undefined,
  onMembershipChange: () => undefined,
  onSessionTerminated: () => undefined,
  onReconnectFailed: () => undefined,
});

const connect = async (client: SocketClient) => {
  const onHandshakeSuccess = vi.fn();
  void client.connectSocket(socketCallbacks(onHandshakeSuccess));
  harness.handlers.get('connect')?.();
  harness.handlers.get('/server/handshake')?.({
    server_did: 'did:key:z6MkServer',
    message: 'handshake',
  });
  await vi.waitFor(() => expect(onHandshakeSuccess).toHaveBeenCalledOnce());
};

const emitted = (event: string) =>
  harness.emits.filter((entry) => entry.event === event).map((e) => e.args);

describe('dSheet socket client appFileId', () => {
  let client: SocketClient | null = null;

  beforeEach(() => {
    harness.emits.length = 0;
    harness.handlers.clear();
  });

  afterEach(() => {
    client?.disconnect();
    client = null;
  });

  it('sends the appFileId as ddocId in /auth and both document meta writes when set', async () => {
    client = new SocketClient({
      wsUrl: 'ws://collab.test',
      roomKey: ROOM_KEY,
      roomId: 'o-1234567890abcdefgh',
      appFileId: 'dsheet-onchain-1',
      encryptedTitle: 'encrypted-title',
    });

    await connect(client);
    await client.setDocumentMeta();
    await client.updateDocumentMeta({
      encryptedTitle: 'renamed-title',
      documentTitle: 'Renamed',
    });

    expect(emitted('/auth')).toEqual([
      expect.objectContaining({
        documentId: 'o-1234567890abcdefgh',
        appType: 'dsheet',
        ddocId: 'dsheet-onchain-1',
      }),
    ]);
    expect(emitted('/auth')[0]).not.toHaveProperty('appFileId');
    expect(emitted('/documents/meta')).toEqual([
      {
        documentId: 'o-1234567890abcdefgh',
        editLock: null,
        title: 'encrypted-title',
        ddocId: 'dsheet-onchain-1',
      },
      {
        documentId: 'o-1234567890abcdefgh',
        editLock: null,
        title: 'renamed-title',
        ddocId: 'dsheet-onchain-1',
      },
    ]);
  });

  it('sends no ddocId when the connection has no appFileId', async () => {
    client = new SocketClient({
      wsUrl: 'ws://collab.test',
      roomKey: ROOM_KEY,
      roomId: 'legacy-sheet-id',
      encryptedTitle: 'encrypted-title',
    });

    await connect(client);
    await client.setDocumentMeta();
    await client.updateDocumentMeta({
      encryptedTitle: 'renamed-title',
      documentTitle: 'Renamed',
    });

    const [auth] = emitted('/auth');
    expect(auth).toMatchObject({ documentId: 'legacy-sheet-id' });
    expect(auth).not.toHaveProperty('ddocId');
    expect(emitted('/documents/meta')).toEqual([
      {
        documentId: 'legacy-sheet-id',
        editLock: null,
        title: 'encrypted-title',
      },
      {
        documentId: 'legacy-sheet-id',
        editLock: null,
        title: 'renamed-title',
      },
    ]);
  });
});
