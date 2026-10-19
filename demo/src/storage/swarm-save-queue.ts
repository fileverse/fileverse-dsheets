/**
 * When the demo saves a sheet to Swarm, kept apart from React so its
 * timing can be tested on its own. The latest unsent state survives the
 * debounce, node downtime and re-renders; a state identical to what Swarm
 * already holds as the newest version is never saved again.
 */

export type SwarmSaveState = 'idle' | 'saving' | 'saved' | 'held' | 'error';

export interface SwarmSaveQueue {
  /** A change to the sheet: saved after the debounce. */
  queue(encodedState: string): void;
  /**
   * A restored version, saved as the newest one after a longer wait, so
   * that a change the remounted editor makes meanwhile joins this save.
   */
  queueRestore(encodedState: string): void;
  /** What Swarm holds as the newest version, from a restore; null if none. */
  setLatest(encodedState: string | null): void;
  /** Storage or write access changed: send what waited, if writing is possible. */
  writable(): void;
  dispose(): void;
}

export const createSwarmSaveQueue = (options: {
  /** Saves a state as the next version; resolves with its feed index. */
  save: (encodedState: string) => Promise<{ index: number }>;
  /** False while there is no storage to save to. */
  isReady: () => boolean;
  canWrite: () => boolean;
  /** True for a failure that means this browser may never write the sheet. */
  isReadOnlyError: (error: Error) => boolean;
  onState: (state: SwarmSaveState) => void;
  onSaved: (index: number) => void;
  onError: (message: string) => void;
  onReadOnly: () => void;
  debounceMs: number;
  restoreDelayMs: number;
}): SwarmSaveQueue => {
  let pending: string | null = null;
  let latest: string | null = null;
  let saving = false;
  // A restore shows "saving" before anything is sent; if it then turns out
  // to be the state Swarm already holds, the status must not stay there.
  let restorePending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), delayMs);
  };

  const flush = async () => {
    timer = null;
    if (!options.isReady() || !options.canWrite() || saving) return;
    const state = pending;
    if (state === null) return;
    pending = null;
    if (state === latest) {
      if (restorePending) options.onState('saved');
      restorePending = false;
      return;
    }
    restorePending = false;
    saving = true;
    options.onState('saving');
    try {
      const { index } = await options.save(state);
      latest = state;
      options.onSaved(index);
      options.onState('saved');
    } catch (error) {
      // Keep the newest state: an edit made during the failed save wins.
      pending ??= state;
      if (options.isReadOnlyError(error as Error)) {
        options.onReadOnly();
        options.onState('held');
      } else {
        options.onError((error as Error).message);
        options.onState('error');
      }
    } finally {
      saving = false;
      // A change that arrived while the request was in flight goes next.
      if (pending !== null && options.canWrite()) {
        schedule(options.debounceMs);
      }
    }
  };

  const enqueue = (encodedState: string, delayMs: number, restore: boolean) => {
    pending = encodedState;
    if (!options.isReady()) return;
    if (!options.canWrite()) {
      options.onState('held');
      return;
    }
    if (restore) {
      restorePending = true;
      options.onState('saving');
    }
    schedule(delayMs);
  };

  return {
    queue: (encodedState) => enqueue(encodedState, options.debounceMs, false),
    queueRestore: (encodedState) =>
      enqueue(encodedState, options.restoreDelayMs, true),
    setLatest: (encodedState) => {
      latest = encodedState;
    },
    writable: () => {
      if (options.canWrite() && pending !== null) void flush();
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
};
