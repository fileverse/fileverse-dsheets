// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSwarmSaveQueue, type SwarmSaveState } from './swarm-save-queue';

const DEBOUNCE = 2_000;
const RESTORE_DELAY = 10_000;

/** A queue over a fake Swarm: records saves, states and errors. */
const setup = ({
  writable = true,
  slow = null as Promise<void> | null,
} = {}) => {
  const env = {
    ready: true,
    writable,
    started: [] as string[],
    saves: [] as string[],
    states: [] as SwarmSaveState[],
    errors: [] as string[],
    readOnly: 0,
    versions: [] as number[],
    failNext: null as Error | null,
  };
  const queue = createSwarmSaveQueue({
    save: async (state) => {
      if (env.failNext) {
        const error = env.failNext;
        env.failNext = null;
        throw error;
      }
      env.started.push(state);
      if (slow && env.started.length === 1) await slow;
      env.saves.push(state);
      return { index: env.saves.length - 1 };
    },
    isReady: () => env.ready,
    canWrite: () => env.writable,
    isReadOnlyError: (error) => error.message.includes('another identity'),
    onState: (state) => env.states.push(state),
    onSaved: (index) => env.versions.push(index),
    onError: (message) => env.errors.push(message),
    onReadOnly: () => env.readOnly++,
    debounceMs: DEBOUNCE,
    restoreDelayMs: RESTORE_DELAY,
  });
  return { env, queue };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('saving changes', () => {
  it('saves the newest state once, after the debounce', async () => {
    const { env, queue } = setup();
    queue.queue('a');
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    queue.queue('b');
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    expect(env.saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.saves).toEqual(['b']);
    expect(env.states).toEqual(['saving', 'saved']);
    expect(env.versions).toEqual([0]);
  });

  it('does not save again what Swarm already holds', async () => {
    const { env, queue } = setup();
    // Restored from Swarm, then reported unchanged by a remounted editor.
    queue.setLatest('a');
    queue.queue('a');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    // Saved once, then reported again.
    queue.queue('b');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    queue.queue('b');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(env.saves).toEqual(['b']);
  });

  it('waits for storage, then sends what changed', async () => {
    const { env, queue } = setup();
    env.ready = false;
    queue.queue('a');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(env.saves).toEqual([]);
    expect(env.states).toEqual([]);
    env.ready = true;
    queue.writable();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.saves).toEqual(['a']);
  });

  it('holds edits while Swarm cannot be written, then sends the newest', async () => {
    const { env, queue } = setup({ writable: false });
    queue.queue('a');
    queue.queue('b');
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 3);
    expect(env.saves).toEqual([]);
    expect(env.states).toEqual(['held', 'held']);
    env.writable = true;
    queue.writable();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.saves).toEqual(['b']);
    expect(env.states.slice(-2)).toEqual(['saving', 'saved']);
  });

  it('sends nothing when writing becomes possible with nothing pending', async () => {
    const { env, queue } = setup({ writable: false });
    env.writable = true;
    queue.writable();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(env.saves).toEqual([]);
    expect(env.states).toEqual([]);
  });
});

describe('restoring a version', () => {
  it('shows saving at once and saves after the longer wait', async () => {
    const { env, queue } = setup();
    queue.setLatest('newest');
    queue.queueRestore('old');
    expect(env.states).toEqual(['saving']);
    await vi.advanceTimersByTimeAsync(RESTORE_DELAY - 1);
    expect(env.saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.saves).toEqual(['old']);
  });

  it('lets a change made meanwhile join the restore as one version', async () => {
    const { env, queue } = setup();
    queue.setLatest('newest');
    queue.queueRestore('old');
    // The remounted editor records its compaction marker a few seconds on.
    await vi.advanceTimersByTimeAsync(5_000);
    queue.queue('old+marker');
    await vi.advanceTimersByTimeAsync(RESTORE_DELAY);
    expect(env.saves).toEqual(['old+marker']);
  });

  it('settles at saved when the version restored is already the newest', async () => {
    const { env, queue } = setup();
    queue.setLatest('newest');
    queue.queueRestore('newest');
    await vi.advanceTimersByTimeAsync(RESTORE_DELAY);
    expect(env.saves).toEqual([]);
    expect(env.states).toEqual(['saving', 'saved']);
  });

  it('is held, not shown as saving, where Swarm cannot be written', async () => {
    const { env, queue } = setup({ writable: false });
    queue.queueRestore('old');
    await vi.advanceTimersByTimeAsync(RESTORE_DELAY);
    expect(env.saves).toEqual([]);
    expect(env.states).toEqual(['held']);
  });
});

describe('failures', () => {
  it('reports an error, keeps the state and tries again', async () => {
    const { env, queue } = setup();
    env.failNext = new Error('Swarm request failed (500)');
    queue.queue('a');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(env.errors).toEqual(['Swarm request failed (500)']);
    expect(env.states).toEqual(['saving', 'error']);
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(env.saves).toEqual(['a']);
    expect(env.states.slice(-1)).toEqual(['saved']);
  });

  it('holds instead of erroring when the feed belongs to another identity', async () => {
    const { env, queue } = setup();
    env.failNext = new Error('This feed belongs to another identity');
    queue.queue('a');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(env.readOnly).toBe(1);
    expect(env.errors).toEqual([]);
    expect(env.states).toEqual(['saving', 'held']);
  });

  it('sends an edit made during a save right after it', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { env, queue } = setup({ slow });
    queue.queue('a');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    queue.queue('b'); // while 'a' is in flight
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(env.started).toEqual(['a']);
    release();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(env.saves).toEqual(['a', 'b']);
  });
});
