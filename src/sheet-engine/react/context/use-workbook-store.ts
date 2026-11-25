import { useContext, useMemo, useSyncExternalStore } from 'react';
import { Context } from '@sheet-engine/core';
import { WorkbookStableContext } from './index';
import { contextEqualIgnoringScroll, createSelection } from './workbook-store';

export function useWorkbookSelector<S>(
  selector: (ctx: Context) => S,
  isEqual: (a: S, b: S) => boolean = Object.is,
): S {
  const { store } = useContext(WorkbookStableContext);
  const selection = useMemo(
    () => createSelection(store, selector, isEqual),
    [store, selector, isEqual],
  );
  return useSyncExternalStore(selection.subscribe, selection.getSnapshot);
}

const identity = (ctx: Context) => ctx;

/**
 * Drop-in for `useContext(WorkbookContext)` in components that should not
 * render on every context update: it returns the same shape, but the
 * component renders again only when `equal` says the context changed in a way
 * it cares about (or when its own props or state change). The returned
 * `context` is always the latest one.
 */
export function useWorkbookContextWhen(
  equal: (previous: Context, next: Context) => boolean,
) {
  const stable = useContext(WorkbookStableContext);
  useWorkbookSelector(identity, equal);
  return {
    context: stable.store.getState(),
    setContext: stable.setContext,
    settings: stable.settings,
    refs: stable.refs,
    handleUndo: stable.handleUndo,
    handleRedo: stable.handleRedo,
  };
}

/**
 * `useContext(WorkbookContext)` for components that must not render when only
 * the scroll position or the row and column offsets changed (E2).
 */
export function useWorkbookContextIgnoringScroll() {
  return useWorkbookContextWhen(contextEqualIgnoringScroll);
}
