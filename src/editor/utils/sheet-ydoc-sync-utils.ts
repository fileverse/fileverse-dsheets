import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import { diffObjectMap } from './diff-sheet';
import {
  SheetChangePath,
  readYdocSheetField,
  updateYdocSheetData,
} from './update-ydoc';

export { readYdocSheetField } from './update-ydoc';

/** Sheet fields the per-feature Yjs hooks sync. */
export const SYNCED_SHEET_FIELDS = [
  'calcChain',
  'config',
  'dataVerification',
  'luckysheet_conditionformat_save',
  'hyperlink',
  'filter',
  'filter_select',
  'liveQueryList',
  'dataBlockCalcFunction',
] as const;

type SyncContext = {
  currentSheetId: string;
  /** Only `field` is populated: the value stored in Yjs. */
  oldSheet: Record<string, any>;
  /** The engine's current value of `field` for the active sheet. */
  newValue: any;
  /** The engine's active sheet, for checks against its cells. */
  engineSheet: Record<string, any> | undefined;
  ydoc: Y.Doc;
};

/**
 * Old (Yjs) and new (engine) value of one field of the active sheet (A3).
 * Reads only that field: no whole-workbook conversion, and no getSheet(),
 * which rebuilds celldata from the dense grid.
 */
export const getSheetYdocSyncContext = ({
  sheetEditorRef,
  ydocRef,
  dsheetId,
  field,
}: {
  sheetEditorRef: React.RefObject<WorkbookInstance | null>;
  ydocRef: React.RefObject<Y.Doc | null>;
  dsheetId: string;
  field: string;
}): SyncContext | null => {
  if (!sheetEditorRef.current || !ydocRef.current) return null;

  const workbook = sheetEditorRef.current.getWorkbookContext();
  const currentSheetId = workbook?.currentSheetId as string;
  const engineSheet = workbook?.luckysheetfile?.find(
    (sheet) => sheet.id === currentSheetId,
  ) as Record<string, any> | undefined;

  return {
    currentSheetId,
    oldSheet: {
      [field]: readYdocSheetField(
        ydocRef.current,
        dsheetId,
        currentSheetId,
        field,
      ),
    },
    newValue: engineSheet?.[field],
    engineSheet,
    ydoc: ydocRef.current,
  };
};

export const buildMapFieldChanges = ({
  sheetId,
  fieldPath,
  oldData,
  newData,
}: {
  sheetId: string;
  fieldPath: string;
  oldData: Record<string, any>;
  newData: Record<string, any>;
}): SheetChangePath[] => {
  const diff = diffObjectMap(oldData, newData);
  const changes: SheetChangePath[] = [];

  Object.keys(diff.added).forEach((key) => {
    changes.push({
      sheetId,
      path: [fieldPath],
      value: diff.added[key],
      key,
      type: 'update',
    });
  });

  Object.keys(diff.removed).forEach((key) => {
    changes.push({
      sheetId,
      path: [fieldPath],
      value: diff.removed[key],
      key,
      type: 'delete',
    });
  });

  return changes;
};

export const applyYdocSheetChanges = ({
  ydoc,
  dsheetId,
  changes,
  handleContentPortal,
}: {
  ydoc: Y.Doc;
  dsheetId: string;
  changes: SheetChangePath[];
  handleContentPortal?: any;
}) => {
  if (!changes.length) return;
  updateYdocSheetData(ydoc, dsheetId, changes, handleContentPortal);
};
