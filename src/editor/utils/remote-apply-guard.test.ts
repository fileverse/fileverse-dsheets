import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginRemoteApply,
  cancelStructuralRemount,
  endRemoteApplyAfterPaint,
  runRemoteApplyUntilPaint,
  scheduleStructuralRemount,
  shouldSkipEchoWrite,
  type StructuralRemountRefs,
} from './remote-apply-guard';

const makeRefs = (): StructuralRemountRefs => ({
  remoteApplyDepthRef: { current: 0 },
  remoteUpdateRef: { current: false },
  pendingRef: { current: false },
  timerRef: { current: null },
});

describe('scheduleStructuralRemount (B1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([1, 2, 5])(
    'keeps begin/end balanced for %i structural events in one debounce window',
    (events) => {
      const refs = makeRefs();
      const run = vi.fn();
      for (let i = 0; i < events; i += 1) {
        scheduleStructuralRemount(refs, run);
        vi.advanceTimersByTime(10);
      }
      vi.runAllTimers();
      expect(run).toHaveBeenCalledTimes(1);
      expect(refs.remoteApplyDepthRef.current).toBe(0);
      expect(refs.remoteUpdateRef.current).toBe(false);
      expect(refs.pendingRef.current).toBe(false);
    },
  );

  it('lets an owner commit through after two structural events 10 ms apart', () => {
    const refs = makeRefs();
    scheduleStructuralRemount(refs, () => {});
    vi.advanceTimersByTime(10);
    scheduleStructuralRemount(refs, () => {});
    vi.runAllTimers();
    // guardRemoteEcho skips the owner's Yjs write while this flag is true.
    expect(refs.remoteUpdateRef.current).toBe(false);
  });

  it('ends the guard when run throws', () => {
    const refs = makeRefs();
    scheduleStructuralRemount(refs, () => {
      throw new Error('boom');
    });
    expect(() => vi.runAllTimers()).toThrow('boom');
    vi.runAllTimers();
    expect(refs.remoteApplyDepthRef.current).toBe(0);
    expect(refs.pendingRef.current).toBe(false);
  });

  it('a new event after the remount fired opens a new guard', () => {
    const refs = makeRefs();
    scheduleStructuralRemount(refs, () => {});
    vi.advanceTimersByTime(50);
    // Remount fired; its end is waiting for paint. A new event arrives and
    // its own begin comes only when its timer fires.
    scheduleStructuralRemount(refs, () => {});
    expect(refs.remoteApplyDepthRef.current).toBe(1);
    vi.advanceTimersByTime(50);
    expect(refs.remoteApplyDepthRef.current).toBe(1);
    vi.runAllTimers();
    expect(refs.remoteApplyDepthRef.current).toBe(0);
  });

  it('cancel drops a pending remount and leaves depth at 0', () => {
    const refs = makeRefs();
    const run = vi.fn();
    scheduleStructuralRemount(refs, run);
    scheduleStructuralRemount(refs, run);
    cancelStructuralRemount(refs);
    expect(refs.remoteApplyDepthRef.current).toBe(0);
    expect(refs.remoteUpdateRef.current).toBe(false);
    expect(refs.pendingRef.current).toBe(false);
    vi.runAllTimers();
    expect(run).not.toHaveBeenCalled();
  });

  it('cancel with nothing pending is a no-op', () => {
    const refs = makeRefs();
    refs.remoteApplyDepthRef.current = 1;
    cancelStructuralRemount(refs);
    expect(refs.remoteApplyDepthRef.current).toBe(1);
  });
});

/**
 * Copy of the scheduler as it stood before B3 (B1 logic) plus the hook's
 * in-callback skip: when a cell edit is open at fire time the remount is
 * skipped and the pending flag cleared.
 */
function legacyScheduler(
  refs: StructuralRemountRefs,
  render: () => void,
  delayMs: number,
  isEditing: () => boolean,
) {
  if (!refs.pendingRef.current) {
    beginRemoteApply(refs);
  }
  refs.pendingRef.current = true;
  if (refs.timerRef.current !== null) {
    window.clearTimeout(refs.timerRef.current);
  }
  refs.timerRef.current = window.setTimeout(() => {
    const editing = isEditing();
    try {
      if (!editing) render();
    } finally {
      refs.pendingRef.current = false;
      refs.timerRef.current = null;
      endRemoteApplyAfterPaint(refs);
    }
  }, delayMs);
}

describe('structural remount while a cell edit is open (B3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Run the same scenario against the legacy and the new scheduler.
  const scenario = (
    schedule: typeof legacyScheduler,
  ): { renders: number; refs: StructuralRemountRefs } => {
    const refs = makeRefs();
    let renders = 0;
    let editing = true;
    schedule(refs, () => (renders += 1), 50, () => editing);
    vi.advanceTimersByTime(1000);
    editing = false;
    vi.advanceTimersByTime(1000);
    return { renders, refs };
  };

  it('legacy: the remount is dropped when the edit was open at fire time', () => {
    const { renders, refs } = scenario(legacyScheduler);
    // The bug: the render was skipped and the pending flag cleared.
    expect(renders).toBe(0);
    expect(refs.pendingRef.current).toBe(false);
  });

  it('new scheduler: remounts once after the edit ends, depth back to 0', () => {
    const { renders, refs } = scenario(
      (r, run, d, e) => scheduleStructuralRemount(r, run, d, e),
    );
    expect(renders).toBe(1);
    expect(refs.remoteApplyDepthRef.current).toBe(0);
    expect(refs.remoteUpdateRef.current).toBe(false);
    expect(refs.pendingRef.current).toBe(false);
    expect(refs.timerRef.current).toBeNull();
  });

  it('keeps the pending flag and re-arms while editing, without the guard', () => {
    const refs = makeRefs();
    const run = vi.fn();
    scheduleStructuralRemount(refs, run, 50, () => true);
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    expect(refs.pendingRef.current).toBe(true);
    expect(refs.timerRef.current).not.toBeNull();
    // Local onChange / guardRemoteEcho / afterUpdateCell check this flag.
    expect(refs.remoteApplyDepthRef.current).toBe(0);
    expect(refs.remoteUpdateRef.current).toBe(false);
  });

  it("the owner's commit is not suppressed while the remount is deferred", () => {
    const refs = makeRefs();
    let editing = true;
    scheduleStructuralRemount(refs, vi.fn(), 50, () => editing);
    vi.advanceTimersByTime(400);
    // Edit ends; the commit's onChange arrives before the next retry tick.
    editing = false;
    const commitSuppressed = refs.remoteUpdateRef.current;
    expect(commitSuppressed).toBe(false);
  });

  it('echo suppression holds during the actual remount and ends after paint', () => {
    const refs = makeRefs();
    let seenInRun: boolean | null = null;
    let editing = true;
    scheduleStructuralRemount(
      refs,
      () => {
        seenInRun = refs.remoteUpdateRef.current;
      },
      50,
      () => editing,
    );
    vi.advanceTimersByTime(300);
    editing = false;
    vi.advanceTimersByTime(250);
    expect(seenInRun).toBe(true);
    // Still held until paint.
    expect(refs.remoteUpdateRef.current).toBe(true);
    vi.runAllTimers();
    expect(refs.remoteUpdateRef.current).toBe(false);
    expect(refs.remoteApplyDepthRef.current).toBe(0);
  });

  it('events during a deferred remount add no begin and run once', () => {
    const refs = makeRefs();
    const run = vi.fn();
    let editing = true;
    scheduleStructuralRemount(refs, run, 50, () => editing);
    vi.advanceTimersByTime(300);
    scheduleStructuralRemount(refs, run, 50, () => editing);
    expect(refs.remoteApplyDepthRef.current).toBe(0);
    editing = false;
    vi.runAllTimers();
    expect(run).toHaveBeenCalledTimes(1);
    expect(refs.remoteApplyDepthRef.current).toBe(0);
  });

  it('treats a throwing isEditing as not editing', () => {
    const refs = makeRefs();
    const run = vi.fn();
    scheduleStructuralRemount(refs, run, 50, () => {
      throw new Error('ctx gone');
    });
    vi.runAllTimers();
    expect(run).toHaveBeenCalledTimes(1);
    expect(refs.remoteApplyDepthRef.current).toBe(0);
  });

  it('cancel drops a remount deferred by editing', () => {
    const refs = makeRefs();
    scheduleStructuralRemount(refs, vi.fn(), 50, () => true);
    vi.advanceTimersByTime(500);
    cancelStructuralRemount(refs);
    expect(refs.remoteApplyDepthRef.current).toBe(0);
    expect(refs.pendingRef.current).toBe(false);
    expect(refs.timerRef.current).toBeNull();
  });
});

// PR 466 review (#3): engine -> Yjs echo hooks stay quiet from the moment a
// peer's structural edit is scheduled until the remount has painted.
describe('shouldSkipEchoWrite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is false when nothing is pending', () => {
    const refs = makeRefs();
    expect(
      shouldSkipEchoWrite({
        remoteUpdateRef: refs.remoteUpdateRef,
        structuralRemountPendingRef: refs.pendingRef,
      }),
    ).toBe(false);
  });

  it('is true while a remount is deferred by a cell edit, and the edit is not held', () => {
    const refs = makeRefs();
    const echo = () =>
      shouldSkipEchoWrite({
        remoteUpdateRef: refs.remoteUpdateRef,
        structuralRemountPendingRef: refs.pendingRef,
      });
    scheduleStructuralRemount(refs, vi.fn(), 50, () => true);
    vi.advanceTimersByTime(500);
    expect(refs.pendingRef.current).toBe(true);
    expect(echo()).toBe(true);
    // The guard that drops typed commits is still not held.
    expect(refs.remoteUpdateRef.current).toBe(false);
  });

  it('stays true through the remount and its paint, then clears', () => {
    const refs = makeRefs();
    const echo = () =>
      shouldSkipEchoWrite({
        remoteUpdateRef: refs.remoteUpdateRef,
        structuralRemountPendingRef: refs.pendingRef,
      });
    scheduleStructuralRemount(refs, vi.fn(), 50);
    expect(echo()).toBe(true);
    vi.advanceTimersByTime(50);
    expect(refs.pendingRef.current).toBe(false);
    expect(echo()).toBe(true); // remote-apply guard held until paint
    vi.advanceTimersByTime(100);
    expect(echo()).toBe(false);
  });

  it('is false again after the observer tears the pending remount down', () => {
    const refs = makeRefs();
    scheduleStructuralRemount(refs, vi.fn(), 50);
    cancelStructuralRemount(refs);
    expect(
      shouldSkipEchoWrite({
        remoteUpdateRef: refs.remoteUpdateRef,
        structuralRemountPendingRef: refs.pendingRef,
      }),
    ).toBe(false);
  });

  it('works without the pending ref (older callers)', () => {
    expect(shouldSkipEchoWrite({ remoteUpdateRef: { current: true } })).toBe(
      true,
    );
    expect(shouldSkipEchoWrite({ remoteUpdateRef: { current: false } })).toBe(
      false,
    );
  });
});

// PR 466 review (#18): rehydrateWorkbookFromYdoc began the guard and never
// ended it when something inside threw.
describe('runRemoteApplyUntilPaint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('holds the guard while fn runs and until paint after it', () => {
    const refs = makeRefs();
    let during = false;
    runRemoteApplyUntilPaint(refs, () => {
      during = refs.remoteUpdateRef.current;
    });
    expect(during).toBe(true);
    expect(refs.remoteUpdateRef.current).toBe(true);
    vi.advanceTimersByTime(100);
    expect(refs.remoteUpdateRef.current).toBe(false);
    expect(refs.remoteApplyDepthRef.current).toBe(0);
  });

  it('ends the guard at once and rethrows when fn throws', () => {
    const refs = makeRefs();
    expect(() =>
      runRemoteApplyUntilPaint(refs, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(refs.remoteApplyDepthRef.current).toBe(0);
    expect(refs.remoteUpdateRef.current).toBe(false);
  });

  it('returns the value of fn', () => {
    expect(runRemoteApplyUntilPaint(makeRefs(), () => 42)).toBe(42);
  });
});
