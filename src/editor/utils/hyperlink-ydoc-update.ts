import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import {
  applyYdocSheetChanges,
  buildMapFieldChanges,
  getSheetYdocSyncContext,
} from './sheet-ydoc-sync-utils';

/**
 * Sync hyperlink map for the active sheet to Yjs.
 */
export const hyperlinkYdocUpdate = ({
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
    field: 'hyperlink',
  });
  if (!syncContext) return;

  const newData = syncContext.newValue || {};
  const oldData = syncContext.oldSheet.hyperlink || {};

  const changes = buildMapFieldChanges({
    sheetId: syncContext.currentSheetId,
    fieldPath: 'hyperlink',
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
