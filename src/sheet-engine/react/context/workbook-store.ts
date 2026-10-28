export type WorkbookStore<T> = {
  getState: () => T;
  setState: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
};

/** A one-value store; Workbook sets the latest context after every commit (E2). */
export function createWorkbookStore<T>(initial: T): WorkbookStore<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState(next) {
      if (next === state) return;
      state = next;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The snapshot logic behind `useWorkbookSelector`: `getSnapshot` returns the
 * previously handed-out value while `isEqual` says the newly selected one is
 * the same, so `useSyncExternalStore` sees no change and the component does
 * not render. The selector runs once per state.
 */
export function createSelection<T, S>(
  store: WorkbookStore<T>,
  selector: (state: T) => S,
  isEqual: (a: S, b: S) => boolean = Object.is,
) {
  let lastState: T | undefined;
  let lastValue: S | undefined;
  let hasValue = false;
  return {
    subscribe: store.subscribe,
    getSnapshot(): S {
      const state = store.getState();
      if (hasValue && state === lastState) return lastValue as S;
      const next = selector(state);
      lastState = state;
      if (hasValue && isEqual(lastValue as S, next)) return lastValue as S;
      lastValue = next;
      hasValue = true;
      return next;
    },
  };
}

/** True when two states differ only in the listed keys. */
export function onlyIgnoredKeysChanged(ignored: readonly string[]) {
  const skip = new Set(ignored);
  return (a: object, b: object): boolean => {
    if (a === b) return true;
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const key of keys) {
      if (!skip.has(key) && x[key] !== y[key]) return false;
    }
    return true;
  };
}

/**
 * Context keys that change on scroll or when the row and column offsets are
 * rebuilt after an edit, and that the components converted in E2 do not read:
 * Toolbar and its popovers, SheetTab, ContextMenu, FilterMenu and
 * SheetTabContextMenu. Checked with grep in those directories and in the
 * helpers they call with the context (`updateCellsDecimalFormat`,
 * `convertCellsToCrypto`, `isHyperlinkCreationBlocked`,
 * `captureLinkEditorOpenSnapshot`).
 */
export const SCROLL_ONLY_KEYS = [
  'scrollLeft',
  'scrollTop',
  'visibledatarow',
  'visibledatacolumn',
] as const;

export const contextEqualIgnoringScroll =
  onlyIgnoredKeysChanged(SCROLL_ONLY_KEYS);
