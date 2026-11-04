import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import {
  applyYdocSheetChanges,
  buildMapFieldChanges,
  getSheetYdocSyncContext,
} from './sheet-ydoc-sync-utils';

/**
 * Sync liveQueryList map for the active sheet to Yjs.
 */
export const liveQueryListYdocUpdate = ({
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
    field: 'liveQueryList',
  });
  if (!syncContext) return;

  const newData = syncContext.newValue || {};
  const oldData = syncContext.oldSheet.liveQueryList || {};

  const changes = buildMapFieldChanges({
    sheetId: syncContext.currentSheetId,
    fieldPath: 'liveQueryList',
    oldData,
    newData,
  });

  applyYdocSheetChanges({
    ydoc: syncContext.ydoc,
    dsheetId,
    changes,
    handleContentPortal,
  });
};
