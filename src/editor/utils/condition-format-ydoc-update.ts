import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import { diffObjectArrays } from './diff-sheet';
import {
  applyYdocSheetChanges,
  getSheetYdocSyncContext,
} from './sheet-ydoc-sync-utils';
import { SheetChangePath } from './update-ydoc';

/**
 * Sync condition format rules for active sheet.
 * This field is stored as one array payload in Yjs.
 */
export const conditionFormatYdocUpdate = ({
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
    field: 'luckysheet_conditionformat_save',
  });
  if (!syncContext) return;

  const newData = syncContext.newValue || [];
  const oldData = syncContext.oldSheet.luckysheet_conditionformat_save || [];

  //@ts-ignore
  const diffConditionFormat = diffObjectArrays(oldData, newData);

  if (
    diffConditionFormat.added.length > 0 ||
    diffConditionFormat.removed.length > 0 ||
    diffConditionFormat.updated.length > 0
  ) {
    const changes: SheetChangePath[] = [
      {
        sheetId: syncContext.currentSheetId,
        path: ['luckysheet_conditionformat_save'],
        value: newData,
        key: 'luckysheet_conditionformat_save',
        type: 'update',
      },
    ];

    applyYdocSheetChanges({
      ydoc: syncContext.ydoc,
      dsheetId,
      changes,
      handleContentPortal,
    });
  }
};
