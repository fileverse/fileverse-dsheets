import * as Y from 'yjs';
import throttle from 'lodash/throttle';

/**
 * Cheap change signal for hosts (Stabilize A1). Built from the live Y.Doc
 * without encoding it; full state stays available through
 * editorStateRef.getContentSnapshot().
 */
export type DSheetContentChange = {
  /** Same meaning as dsheets.new `isEmptySheet(...) === false`. */
  hasContent: boolean;
  /** A local user edit has happened since this editor mounted. */
  userEdited: boolean;
  /**
   * base64 state vector + ":" + deleted count. Changes on every change,
   * deletes included; compare with === only. null until y-indexeddb is
   * attached and synced.
   */
  fingerprint: string | null;
};

/** Default-workbook seed and legacy migration: content, but not a user edit. */
export const INIT_ORIGIN = 'init';
/** Idle celldata compaction: rewrites storage, not a user edit. */
export const COMPACTION_ORIGIN = 'compaction';

const NON_USER_ORIGINS: ReadonlySet<unknown> = new Set([
  'self',
  'remote',
  INIT_ORIGIN,
  COMPACTION_ORIGIN,
  'dsheet-package-ingress',
]);

// Y.Map#size walks every entry; keys() is lazy, so this stops at the first.
const hasAnyEntry = (value: unknown): boolean => {
  if (value instanceof Y.Map) return !value.keys().next().done;
  if (value instanceof Y.Array) return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') {
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return true;
    }
  }
  return false;
};

/**
 * Mirrors dsheets.new `isEmptySheet` (components/dsheet-editor/editor-utils.ts):
 * no sheets → empty; more than one sheet → content; otherwise content when
 * sheet 0 has any config key or any celldata entry. Stops at the first live
 * entry, so it does not walk the sheet.
 */
export function computeHasContent(doc: Y.Doc, dsheetId: string): boolean {
  const sheets = doc.getArray<unknown>(dsheetId);
  if (sheets.length === 0) return false;
  if (sheets.length > 1) return true;
  const sheet = sheets.get(0);
  const read = (key: string): unknown =>
    sheet instanceof Y.Map
      ? sheet.get(key)
      : (sheet as Record<string, unknown> | null)?.[key];
  return hasAnyEntry(read('config')) || hasAnyEntry(read('celldata'));
}

const changedDocument = (tr: Y.Transaction) => {
  if (tr.deleteSet.clients.size > 0) return true;
  for (const [client, clock] of tr.afterState) {
    if ((tr.beforeState.get(client) ?? 0) !== clock) return true;
  }
  return false;
};

export type UserEditTracker = {
  userEdited(): boolean;
  dispose(): void;
};

/**
 * Turns on at the first transaction that changes the document and whose
 * origin is not a known non-user origin or the IndexedDB provider.
 */
export function attachUserEditTracker(
  doc: Y.Doc,
  getIndexeddbOrigin: () => unknown,
): UserEditTracker {
  let edited = false;
  const onAfterTransaction = (tr: Y.Transaction) => {
    if (edited) return;
    if (NON_USER_ORIGINS.has(tr.origin)) return;
    const provider = getIndexeddbOrigin();
    if (provider != null && tr.origin === provider) return;
    if (!changedDocument(tr)) return;
    edited = true;
    doc.off('afterTransaction', onAfterTransaction);
  };
  doc.on('afterTransaction', onAfterTransaction);
  return {
    userEdited: () => edited,
    dispose: () => doc.off('afterTransaction', onAfterTransaction),
  };
}

export const CONTENT_CHANGE_WAIT_MS = 1000;

/**
 * At most one host call per second (trailing only); local and remote changes
 * share the throttle. The change is built when the call fires, never per edit.
 */
export function createContentChangeNotifier(
  getChange: () => DSheetContentChange,
  getHandler: () => ((change: DSheetContentChange) => void) | undefined,
  waitMs = CONTENT_CHANGE_WAIT_MS,
) {
  const fire = throttle(
    () => {
      const handler = getHandler();
      if (handler) handler(getChange());
    },
    waitMs,
    { leading: false, trailing: true },
  );
  return {
    notify: () => {
      fire();
    },
    flush: () => {
      fire.flush();
    },
    cancel: () => fire.cancel(),
  };
}
