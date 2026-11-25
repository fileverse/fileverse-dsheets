import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';

const instances: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];

vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    whenSynced = Promise.reject(new Error('sync failed'));
    destroy = vi.fn(async () => undefined);
    constructor() {
      this.whenSynced.catch(() => {});
      instances.push(this);
    }
  },
}));

import { rebuildIndexedDbStore } from './rebuild-indexeddb-store';

describe('rebuildIndexedDbStore failure', () => {
  it('destroys the new provider and rethrows when whenSynced rejects', async () => {
    const created = vi.fn();
    await expect(
      rebuildIndexedDbStore('fail-db', new Y.Doc(), null, created),
    ).rejects.toThrow('sync failed');
    expect(created).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(1);
    expect(instances[0].destroy).toHaveBeenCalledOnce();
  });
});
