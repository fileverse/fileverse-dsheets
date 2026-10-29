import _ from 'lodash';

/**
 * A structural edit rewrites the cross-tab formulas of a tab that is not
 * loaded in its `celldata`, as one replacement of the whole array (PR 466 N1).
 * Undo and redo replay that replacement, so the engine is right; the Yjs write
 * for it compares the two arrays here.
 *
 * Only formulas that name another tab (they contain `!`) are compared. Those
 * are the cells a structural edit on another tab can rewrite; a cell a
 * collaborator changed in between is not written back.
 */

type CelldataEntry = { r: number; c: number; v?: any };

export type CelldataArrayChange = {
  sheetId: string;
  path: ['celldata'];
  key: string;
  value: CelldataEntry | null;
  type: 'update' | 'delete';
};

const crossTabFormula = (entry: CelldataEntry | undefined) => {
  const f = entry?.v?.f;
  return typeof f === 'string' && f.includes('!');
};

/** The Yjs changes that turn `before` into `after` for the cross-tab formulas. */
export function celldataArrayChanges(
  sheetId: string,
  before: CelldataEntry[] | undefined,
  after: CelldataEntry[] | undefined,
): CelldataArrayChange[] {
  if (!Array.isArray(before) || !Array.isArray(after)) return [];
  const key = (entry: CelldataEntry) => `${entry.r}_${entry.c}`;
  const beforeByKey = new Map(before.map((entry) => [key(entry), entry]));
  const afterByKey = new Map(after.map((entry) => [key(entry), entry]));
  const changes: CelldataArrayChange[] = [];
  afterByKey.forEach((entry, k) => {
    const previous = beforeByKey.get(k);
    if (!crossTabFormula(entry) && !crossTabFormula(previous)) return;
    if (previous && _.isEqual(previous.v, entry.v)) return;
    changes.push({
      sheetId,
      path: ['celldata'],
      key: k,
      value: { r: entry.r, c: entry.c, v: entry.v },
      type: 'update',
    });
  });
  beforeByKey.forEach((entry, k) => {
    if (afterByKey.has(k) || !crossTabFormula(entry)) return;
    changes.push({
      sheetId,
      path: ['celldata'],
      key: k,
      value: null,
      type: 'delete',
    });
  });
  return changes;
}
