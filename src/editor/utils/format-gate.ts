import * as Y from 'yjs';

/** Highest `meta.format` this client can write. */
export const SUPPORTED_FORMAT = 1;

/** Shown to the user once the sheet is locked. */
export const FORMAT_LOCKED_MESSAGE =
  'This sheet was updated. Reload to continue.';

const lockedDocs = new WeakMap<Y.Doc, Set<string>>();

const metaMapName = (dsheetId: string) => `${dsheetId}/meta`;

/**
 * Format of the sheet in `doc`. A missing map or key means 1, and so does a
 * value that is not a number. Does not create the map when it is absent.
 */
export function readFormatVersion(doc: Y.Doc, dsheetId: string): number {
  const name = metaMapName(dsheetId);
  if (!doc.share.has(name)) return 1;
  const format = doc.getMap<unknown>(name).get('format');
  return typeof format === 'number' ? format : 1;
}

/**
 * True once a watched sheet of `doc` has shown a format above SUPPORTED_FORMAT.
 * With `dsheetId` it answers for that sheet only, and also reads the doc, so
 * it holds before the watch starts. Without it, true if any sheet is locked.
 */
export function isFormatLocked(
  doc: Y.Doc | null | undefined,
  dsheetId?: string,
): boolean {
  if (!doc) return false;
  const ids = lockedDocs.get(doc);
  if (dsheetId === undefined) return !!ids && ids.size > 0;
  return !!ids?.has(dsheetId) || readFormatVersion(doc, dsheetId) > SUPPORTED_FORMAT;
}

/**
 * Checks `meta.format` now and while the sheet is open. On the first value
 * above SUPPORTED_FORMAT the sheet is locked (write helpers return early) and
 * `onLocked` runs once per watcher with that value, even if the sheet was
 * already locked by an earlier watcher. Returns an unsubscribe function.
 */
export function watchFormatGate(
  doc: Y.Doc,
  dsheetId: string,
  onLocked: (format: number) => void,
): () => void {
  let notified = false;
  const check = () => {
    if (notified) return;
    const format = readFormatVersion(doc, dsheetId);
    if (format <= SUPPORTED_FORMAT) return;
    notified = true;
    const ids = lockedDocs.get(doc) ?? new Set<string>();
    ids.add(dsheetId);
    lockedDocs.set(doc, ids);
    onLocked(format);
  };

  check();
  const meta = doc.getMap<unknown>(metaMapName(dsheetId));
  meta.observe(check);
  return () => meta.unobserve(check);
}
