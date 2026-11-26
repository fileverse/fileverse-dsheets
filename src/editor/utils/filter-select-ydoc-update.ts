import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import isEqual from 'lodash/isEqual';
import { isValidFilterSelection } from '@sheet-engine/core/utils/filter-selection';
import {
  applyYdocSheetChanges,
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

  const selection = syncContext.newValue;
  const next = isValidFilterSelection(selection) ? selection : undefined;
  if (isEqual(syncContext.oldSheet.filter_select, next)) return;

  // Send both ranges together so concurrent edits cannot leave half a filter.
  applyYdocSheetChanges({
    ydoc: syncContext.ydoc,
    dsheetId,
    changes: [
      {
        sheetId: syncContext.currentSheetId,
        path: ['filter_select'],
        value: next,
        type: next ? 'update' : 'delete',
      },
    ],
    handleContentPortal,
  });
};
