import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PersistenceSupersededError,
  PersistenceSyncTimeoutError,
  waitForBootstrapOrAbandon,
  waitForPersistenceSynced,
} from './wait-for-sync';

// PR 466 review (#4): y-indexeddb's whenSynced has no reject path, so a
// provider that never syncs must not hang the bootstrap or a rebuild.

describe('waitForPersistenceSynced', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves when the provider syncs', async () => {
    await expect(
      waitForPersistenceSynced({ whenSynced: Promise.resolve() }),
    ).resolves.toBeUndefined();
  });

  it('rejects with a timeout when the provider never syncs', async () => {
    const result = waitForPersistenceSynced(
      { whenSynced: new Promise(() => {}) },
      { timeoutMs: 1000 },
    );
    const assertion = expect(result).rejects.toBeInstanceOf(
      PersistenceSyncTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('rejects as soon as the owner is no longer current', async () => {
    let current = true;
    const result = waitForPersistenceSynced(
      { whenSynced: new Promise(() => {}) },
      { timeoutMs: 60_000, isCurrent: () => current },
    );
    const assertion = expect(result).rejects.toBeInstanceOf(
      PersistenceSupersededError,
    );
    await vi.advanceTimersByTimeAsync(300);
    current = false;
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
  });

  it('passes a rejection of whenSynced through', async () => {
    await expect(
      waitForPersistenceSynced({ whenSynced: Promise.reject(new Error('x')) }),
    ).rejects.toThrow('x');
  });

  it('leaves no timer behind after it settles', async () => {
    await waitForPersistenceSynced(
      { whenSynced: Promise.resolve() },
      { isCurrent: () => true },
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('waitForBootstrapOrAbandon', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns 'settled' when the bootstrap finishes, or fails, in time", async () => {
    await expect(waitForBootstrapOrAbandon(Promise.resolve(), 1000)).resolves.toBe(
      'settled',
    );
    await expect(
      waitForBootstrapOrAbandon(Promise.reject(new Error('boom')), 1000),
    ).resolves.toBe('settled');
  });

  it("returns 'stuck' when the bootstrap never settles", async () => {
    const result = waitForBootstrapOrAbandon(new Promise(() => {}), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe('stuck');
  });
});
