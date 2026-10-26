import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import {
  applyYdocSheetChanges,
  buildMapFieldChanges,
  getSheetYdocSyncContext,
} from './sheet-ydoc-sync-utils';

/**
 * Sync `filter_select` for active sheet.
 * Stored as a Y.Map for granular updates (keys: "row", "column").
 */
export const filterSelectYdocUpdate = ({
  sheetEditorRef,
  ydocRef,
  dsheetId,
  handleContentPortal,
}: {
  sheetEditorRef: React.RefObject<WorkbookInstance | null>;
  ydocRef: React.RefObject<Y.Doc | null>;
  dsheetId: string;
  handleContentPortal?: any;
}) => {
  const syncContext = getSheetYdocSyncContext({
    sheetEditorRef,
    ydocRef,
    dsheetId,
    field: 'filter_select',
  });
  if (!syncContext) return;

  const newData = syncContext.newValue || {};
  const oldData = syncContext.oldSheet.filter_select || {};

  const changes = buildMapFieldChanges({
    sheetId: syncContext.currentSheetId,
    fieldPath: 'filter_select',
    oldData: oldData || {},
    newData: newData || {},
  });

  applyYdocSheetChanges({
    ydoc: syncContext.ydoc,
    dsheetId,
    changes,
    handleContentPortal,
  });
};
