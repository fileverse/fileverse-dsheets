import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelStructuralRemount,
  scheduleStructuralRemount,
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
      expect(refs.remoteUpdateRef.current).toBe(true);
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
    // Remount fired; its end is waiting for paint. A new event arrives.
    scheduleStructuralRemount(refs, () => {});
    expect(refs.remoteApplyDepthRef.current).toBe(2);
    vi.runAllTimers();
    expect(refs.remoteApplyDepthRef.current).toBe(0);
  });

  it('cancel releases the guard of a pending remount', () => {
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
