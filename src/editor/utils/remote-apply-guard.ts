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

/**
 * True when an engine → Yjs echo hook (calcChain, conditional formats, ...)
 * must stay quiet: a remote apply is running, or a structural remount is
 * pending. While one is pending the engine still has the grid from before the
 * peer's insert or delete, so a diff of its metadata against Yjs would write
 * the old coordinates over the peer's (and delete the peer's calcChain
 * entries). Cell commits are not echo hooks and are not held back by this.
 */
export function shouldSkipEchoWrite(refs: {
  remoteUpdateRef: MutableRefObject<boolean>;
  structuralRemountPendingRef?: MutableRefObject<boolean>;
}): boolean {
  return (
    refs.remoteUpdateRef.current ||
    refs.structuralRemountPendingRef?.current === true
  );
}

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
 * The guard is begun once, right before `run`, and ended after paint, so each
 * remount owns exactly one begin and one end. It is NOT held while the timer
 * is merely pending or deferred by a cell edit: `remoteUpdateRef` makes
 * handleChange and the data-block work in afterUpdateCell drop local work, so
 * holding it across an edit would drop the user's typed edit. (The cell write
 * in afterUpdateCell and the commit-time write do not check it.) What must not
 * run while a remount is pending is the engine → Yjs echo hooks, which diff
 * the old grid against Yjs: they check `shouldSkipEchoWrite`. Events that
 * land while one is pending only re-arm its timer.
 *
 * While `isEditing()` is true at fire time the timer re-arms (250 ms) and the
 * pending flag is kept; the remount runs once the edit ends.
 */
export function scheduleStructuralRemount(
  refs: StructuralRemountRefs,
  run: () => void,
  delayMs = 50,
  isEditing?: () => boolean,
) {
  refs.pendingRef.current = true;
  if (refs.timerRef.current !== null) {
    window.clearTimeout(refs.timerRef.current);
  }
  armStructuralRemount(refs, run, delayMs, isEditing);
}

/** Re-arm interval while a cell edit blocks the remount. */
export const STRUCTURAL_REMOUNT_EDIT_RETRY_MS = 250;

function editingNow(isEditing?: () => boolean): boolean {
  if (!isEditing) return false;
  try {
    return isEditing();
  } catch {
    return false;
  }
}

function armStructuralRemount(
  refs: StructuralRemountRefs,
  run: () => void,
  delayMs: number,
  isEditing?: () => boolean,
) {
  refs.timerRef.current = window.setTimeout(() => {
    if (editingNow(isEditing)) {
      armStructuralRemount(
        refs,
        run,
        STRUCTURAL_REMOUNT_EDIT_RETRY_MS,
        isEditing,
      );
      return;
    }
    beginRemoteApply(refs);
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
 * Drop a pending structural remount (observer teardown). The guard is only
 * held while `run` executes and until paint afterwards, so there is nothing
 * to release here.
 */
export function cancelStructuralRemount(refs: StructuralRemountRefs) {
  if (refs.timerRef.current !== null) {
    window.clearTimeout(refs.timerRef.current);
    refs.timerRef.current = null;
  }
  refs.pendingRef.current = false;
}

/**
 * Run `fn` under the guard and keep it until paint (a remount follows). If
 * `fn` throws, the guard is ended at once and the error is rethrown: a begin
 * with no matching end leaves the depth above zero, and `handleChange` then
 * drops every local write until reload.
 */
export function runRemoteApplyUntilPaint<T>(
  refs: RemoteApplyGuardRefs,
  fn: () => T,
): T {
  beginRemoteApply(refs);
  let result: T;
  try {
    result = fn();
  } catch (error) {
    endRemoteApply(refs);
    throw error;
  }
  endRemoteApplyAfterPaint(refs);
  return result;
}

/** End after Workbook remount hooks have flushed (2 rAF ≈ one paint). */
export function endRemoteApplyAfterPaint(refs: RemoteApplyGuardRefs) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      endRemoteApply(refs);
    });
  });
}
