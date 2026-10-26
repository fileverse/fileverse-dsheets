import type { WorkbookInstance } from '@sheet-engine/react';
import type { DefinedName } from '../../sheet-engine/core/types';
import type { RefObject } from 'react';
import * as Y from 'yjs';
import { isFormatLocked } from './format-gate';

/** Sibling share key on the same Y.Doc as the sheet array. */
export function getDefinedNamesMapKey(dsheetId: string): string {
  return `${dsheetId}:definedNames`;
}

export function getDefinedNamesYMap(
  ydoc: Y.Doc,
  dsheetId: string,
): Y.Map<DefinedName> {
  return ydoc.getMap(getDefinedNamesMapKey(dsheetId)) as Y.Map<DefinedName>;
}

function cloneDefinedName(dn: DefinedName): DefinedName {
  return {
    id: dn.id,
    name: dn.name,
    sheetId: dn.sheetId,
    range: {
      row: [dn.range.row[0], dn.range.row[1]],
      column: [dn.range.column[0], dn.range.column[1]],
    },
    scope: dn.scope ?? 'workbook',
    localSheetId: dn.localSheetId,
    comment: dn.comment,
  };
}

function isSameDefinedName(a: unknown, b: DefinedName): boolean {
  if (!a || typeof a !== 'object') return false;
  const prev = a as DefinedName;
  return (
    prev.id === b.id &&
    prev.name === b.name &&
    prev.sheetId === b.sheetId &&
    prev.scope === b.scope &&
    prev.localSheetId === b.localSheetId &&
    prev.comment === b.comment &&
    prev.range?.row?.[0] === b.range.row[0] &&
    prev.range?.row?.[1] === b.range.row[1] &&
    prev.range?.column?.[0] === b.range.column[0] &&
    prev.range?.column?.[1] === b.range.column[1]
  );
}

function normalizeDefinedName(value: unknown): DefinedName | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<DefinedName>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.sheetId !== 'string' ||
    !raw.range?.row ||
    !raw.range?.column
  ) {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    sheetId: raw.sheetId,
    range: {
      row: [Number(raw.range.row[0]), Number(raw.range.row[1])],
      column: [Number(raw.range.column[0]), Number(raw.range.column[1])],
    },
    scope: raw.scope === 'sheet' ? 'sheet' : 'workbook',
    localSheetId: raw.localSheetId,
    comment: raw.comment,
  };
}

/** Read workbook-level named ranges from Yjs (stable name order). */
export function readDefinedNamesFromYdoc(
  ydoc: Y.Doc,
  dsheetId: string,
): DefinedName[] {
  const map = getDefinedNamesYMap(ydoc, dsheetId);
  const list: DefinedName[] = [];
  map.forEach((value) => {
    const dn = normalizeDefinedName(value);
    if (dn) list.push(dn);
  });
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

/**
 * Prefer the sheet `Y.Array` share key when a doc has sibling maps
 * (e.g. `${dsheetId}:definedNames`).
 */
export function resolveSheetArrayShareKey(
  doc: Y.Doc,
  preferredKey?: string,
): string | null {
  if (preferredKey) {
    const preferred = doc.share.get(preferredKey);
    if (preferred instanceof Y.Array) return preferredKey;
  }
  for (const key of doc.share.keys()) {
    if (doc.share.get(key) instanceof Y.Array) return key;
  }
  return preferredKey ?? [...doc.share.keys()][0] ?? null;
}

/**
 * Diff Context definedNames against the Y.Map and apply set/delete by id.
 */
export function syncDefinedNamesToYdoc({
  ydoc,
  dsheetId,
  definedNames,
  handleContentPortal,
}: {
  ydoc: Y.Doc;
  dsheetId: string;
  definedNames: DefinedName[];
  handleContentPortal?: () => void;
}): void {
  if (isFormatLocked(ydoc, dsheetId)) return;
  const map = getDefinedNamesYMap(ydoc, dsheetId);
  const nextById = new Map(
    (definedNames || []).map((dn) => [dn.id, cloneDefinedName(dn)]),
  );

  let changed = false;
  ydoc.transact(() => {
    const toDelete: string[] = [];
    map.forEach((_value, key) => {
      if (!nextById.has(key)) toDelete.push(key);
    });
    toDelete.forEach((key) => {
      map.delete(key);
      changed = true;
    });

    nextById.forEach((dn, id) => {
      const prev = map.get(id);
      if (!isSameDefinedName(prev, dn)) {
        map.set(id, dn);
        changed = true;
      }
    });
  });

  if (changed) {
    handleContentPortal?.();
  }
}

/** Push current workbook definedNames into Yjs (editor hook target). */
export const definedNamesYdocUpdate = ({
  sheetEditorRef,
  ydocRef,
  dsheetId,
  handleContentPortal,
}: {
  sheetEditorRef: RefObject<WorkbookInstance | null>;
  ydocRef: RefObject<Y.Doc | null>;
  dsheetId: string;
  handleContentPortal?: () => void;
}) => {
  const ydoc = ydocRef.current;
  const editor = sheetEditorRef.current;
  if (!ydoc || !editor) return;

  const definedNames =
    editor.getWorkbookContext()?.definedNames || ([] as DefinedName[]);

  syncDefinedNamesToYdoc({
    ydoc,
    dsheetId,
    definedNames,
    handleContentPortal,
  });
};
