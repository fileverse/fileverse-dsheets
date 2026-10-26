import { MutableRefObject } from 'react';

/**
 * Scoped guard for RTC remote → local apply.
 *
 * `remoteUpdateRef` used to stay true for seconds (holdRemoteApplyLock), which
 * blocked real user metadata writes via guardRemoteEcho. Depth tracks only the
 * synchronous remote-apply window (plus one paint for structural remounts).
 */
export type RemoteApplyGuardRefs = {
  remoteApplyDepthRef: MutableRefObject<number>;
  remoteUpdateRef: MutableRefObject<boolean>;
};

export function syncRemoteUpdateFlag(refs: RemoteApplyGuardRefs) {
  refs.remoteUpdateRef.current = refs.remoteApplyDepthRef.current > 0;
}

export function beginRemoteApply(refs: RemoteApplyGuardRefs) {
  refs.remoteApplyDepthRef.current += 1;
  syncRemoteUpdateFlag(refs);
}

export function endRemoteApply(refs: RemoteApplyGuardRefs) {
  refs.remoteApplyDepthRef.current = Math.max(
    0,
    refs.remoteApplyDepthRef.current - 1,
  );
  syncRemoteUpdateFlag(refs);
}

export function runUnderRemoteApply(
  refs: RemoteApplyGuardRefs,
  fn: () => void,
) {
  beginRemoteApply(refs);
  try {
    fn();
  } finally {
    endRemoteApply(refs);
  }
}

export type StructuralRemountRefs = RemoteApplyGuardRefs & {
  pendingRef: MutableRefObject<boolean>;
  timerRef: MutableRefObject<number | null>;
};

/**
 * Debounced structural remount under the remote-apply guard.
 *
 * Each pending remount owns exactly one begin and one end: events that land
 * while one is pending only re-arm its timer. Beginning on every call left the
 * depth above 0 for the session after two events in one window, which blocked
 * the owner's typed commits from reaching Yjs.
 */
export function scheduleStructuralRemount(
  refs: StructuralRemountRefs,
  run: () => void,
  delayMs = 50,
) {
  if (!refs.pendingRef.current) {
    beginRemoteApply(refs);
  }
  refs.pendingRef.current = true;
  if (refs.timerRef.current !== null) {
    window.clearTimeout(refs.timerRef.current);
  }
  refs.timerRef.current = window.setTimeout(() => {
    try {
      run();
    } finally {
      refs.pendingRef.current = false;
      refs.timerRef.current = null;
      endRemoteApplyAfterPaint(refs);
    }
  }, delayMs);
}

/**
 * Drop a pending structural remount (observer teardown) and release the guard
 * it owns, so a re-subscribed observer does not start with a stale depth.
 */
export function cancelStructuralRemount(refs: StructuralRemountRefs) {
  if (refs.timerRef.current !== null) {
    window.clearTimeout(refs.timerRef.current);
    refs.timerRef.current = null;
  }
  if (refs.pendingRef.current) {
    refs.pendingRef.current = false;
    endRemoteApply(refs);
  }
}

/** End after Workbook remount hooks have flushed (2 rAF ≈ one paint). */
export function endRemoteApplyAfterPaint(refs: RemoteApplyGuardRefs) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      endRemoteApply(refs);
    });
  });
}
