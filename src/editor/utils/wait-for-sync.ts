/**
 * Waits for a y-indexeddb provider without trusting it to finish.
 *
 * In y-indexeddb 9.0.12 `whenSynced` resolves only on 'synced'. It has no
 * reject path, and a provider that is destroyed before its first read, or whose
 * first read never completes, never syncs. Awaiting it directly hangs the
 * bootstrap, and a rebuild that waits for the bootstrap hangs with it.
 */

export const INDEXEDDB_SYNC_TIMEOUT_MS = 15_000;
/** How long a rebuild waits for a running bootstrap before it abandons it. */
export const REBUILD_BOOTSTRAP_WAIT_MS = 3_000;
const SUPERSEDED_POLL_MS = 100;

export class PersistenceSyncTimeoutError extends Error {
  constructor(ms: number) {
    super(`[DSheet] IndexedDB did not finish syncing within ${ms} ms`);
    this.name = 'PersistenceSyncTimeoutError';
  }
}

export class PersistenceSupersededError extends Error {
  constructor() {
    super('[DSheet] IndexedDB sync superseded');
    this.name = 'PersistenceSupersededError';
  }
}

/**
 * Resolves when `whenSynced` does. Rejects with PersistenceSyncTimeoutError
 * after `timeoutMs`, or with PersistenceSupersededError as soon as
 * `isCurrent()` turns false (checked every 100 ms): a newer bootstrap or an
 * unmount owns the provider then, and it may already be destroyed.
 */
export function waitForPersistenceSynced(
  persistence: { whenSynced: Promise<unknown> },
  options: { timeoutMs?: number; isCurrent?: () => boolean } = {},
): Promise<void> {
  const { timeoutMs = INDEXEDDB_SYNC_TIMEOUT_MS, isCurrent } = options;
  return new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const settle = (fn: () => void) => {
      clearTimeout(timeout);
      clearInterval(poll);
      fn();
    };
    timeout = setTimeout(
      () => settle(() => reject(new PersistenceSyncTimeoutError(timeoutMs))),
      timeoutMs,
    );
    if (isCurrent) {
      poll = setInterval(() => {
        if (!isCurrent()) settle(() => reject(new PersistenceSupersededError()));
      }, SUPERSEDED_POLL_MS);
    }
    persistence.whenSynced.then(
      () => settle(resolve),
      (error) => settle(() => reject(error)),
    );
  });
}

/**
 * Waits for a running bootstrap for at most `ms`. 'stuck' means it has not
 * settled; the caller then abandons it (bumps the generation) instead of
 * waiting for a provider that may never sync.
 */
export async function waitForBootstrapOrAbandon(
  bootstrap: Promise<unknown>,
  ms = REBUILD_BOOTSTRAP_WAIT_MS,
): Promise<'settled' | 'stuck'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<'stuck'>((resolve) => {
    timer = setTimeout(() => resolve('stuck'), ms);
  });
  try {
    return await Promise.race([
      bootstrap.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      stuck,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
