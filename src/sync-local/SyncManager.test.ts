import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
}));

vi.mock('./socketClient', () => ({
  SocketClient: class MockSocketClient {
    constructor(config: Record<string, unknown>) {
      harness.configs.push(config);
    }

    connectSocket() {
      return new Promise<void>(() => undefined);
    }
  },
}));

import { SyncManager } from './SyncManager';

describe('SyncManager connection config', () => {
  it('forwards the connection appFileId to the socket client', () => {
    const manager = new SyncManager({ ydoc: new Y.Doc() }, () => undefined);

    void manager.connect({
      roomKey: 'AQIDBA==',
      roomId: 'o-1234567890abcdefgh',
      wsUrl: 'ws://collab.test',
      isOwner: true,
      appFileId: 'dsheet-onchain-1',
    });

    expect(harness.configs[0]).toMatchObject({
      roomId: 'o-1234567890abcdefgh',
      appFileId: 'dsheet-onchain-1',
    });
  });
});
