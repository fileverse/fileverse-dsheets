/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('./socketClient', () => ({
  SocketClient: class MockSocketClient {
    connectSocket() {
      return new Promise(() => {});
    }
    disconnect() {}
  },
}));

import { SyncManager } from './SyncManager';

const deltasFrom = (count: number) => {
  const src = new Y.Doc();
  const deltas: Uint8Array[] = [];
  src.on('update', (u: Uint8Array) => deltas.push(u));
  for (let i = 0; i < count; i += 1) src.getMap('cells').set(`${i}_0`, i);
  return { src, deltas };
};

// Encrypted payloads are stand-ins: tryDecrypt maps them back to the delta.
const makeManager = (onRemoteApplied: (u: Uint8Array) => void) => {
  const ydoc = new Y.Doc();
  const manager = new SyncManager({ ydoc, onRemoteApplied }, () => {});
  const payloads = new Map<string, Uint8Array>();
  (manager as any).tryDecrypt = (data: string) => payloads.get(data) ?? null;
  return { ydoc, manager: manager as any, payloads };
};

describe('SyncManager remote apply (A2)', () => {
  it('hands onRemoteApplied the applied delta only', () => {
    const onRemoteApplied = vi.fn();
    const { ydoc, manager, payloads } = makeManager(onRemoteApplied);
    const { src, deltas } = deltasFrom(3);
    deltas.forEach((d, i) => payloads.set(`p${i}`, d));

    deltas.forEach((_d, i) => manager.applyRemoteYjsUpdate(`p${i}`));

    expect(onRemoteApplied).toHaveBeenCalledTimes(3);
    onRemoteApplied.mock.calls.forEach(([arg], i) => {
      expect(arg).toBe(deltas[i]);
    });
    expect(ydoc.getMap('cells').toJSON()).toEqual(src.getMap('cells').toJSON());
  });

  it('hands onRemoteApplied the merged queued delta once', () => {
    const onRemoteApplied = vi.fn();
    const { ydoc, manager, payloads } = makeManager(onRemoteApplied);
    const { src, deltas } = deltasFrom(4);
    deltas.forEach((d, i) => payloads.set(`q${i}`, d));
    manager.contentTobeAppliedQueue = deltas.map((_d, i) => ({
      data: `q${i}`,
      id: `id${i}`,
    }));

    manager.applyQueuedRemoteContents();

    expect(onRemoteApplied).toHaveBeenCalledTimes(1);
    const [merged] = onRemoteApplied.mock.calls[0];
    expect(merged).toEqual(Y.mergeUpdates(deltas));
    expect(ydoc.getMap('cells').toJSON()).toEqual(src.getMap('cells').toJSON());
  });

  it('does not call onRemoteApplied when the update cannot be decrypted', () => {
    const onRemoteApplied = vi.fn();
    const { manager } = makeManager(onRemoteApplied);
    manager.onDecryptMiss = vi.fn(async () => undefined);
    manager.applyRemoteYjsUpdate('unknown');
    expect(onRemoteApplied).not.toHaveBeenCalled();
  });
});
