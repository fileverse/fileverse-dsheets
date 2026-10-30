import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import isEqual from 'lodash/isEqual';
import {
  applyYdocSheetChanges,
  getSheetYdocSyncContext,
} from './sheet-ydoc-sync-utils';
import { SheetChangePath } from './update-ydoc';

/**
 * Sync `filter` for active sheet.
 * Stored as one object payload in Yjs (keys like "0", "1", "all" map to objects).
 */
export const filterYdocUpdate = ({
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
    field: 'filter',
  });
  if (!syncContext) return;

  const newData = syncContext.newValue || {};
  const oldData = syncContext.oldSheet.filter || {};

  // Order-insensitive deep compare (matches every other metadata updater).
  // JSON.stringify is key-order-sensitive: a remount rebuilds `filter` with the
  // same values but possibly different key order, which a string compare reports
  // as a change — triggering a cross-peer write/remount ping-pong (the filter
  // flicker). isEqual compares by value so an unchanged filter never re-writes.
  if (isEqual(oldData || {}, newData || {})) return;

  const changes: SheetChangePath[] = [
    {
      sheetId: syncContext.currentSheetId,
      path: ['filter'],
      value: newData || {},
      key: 'filter',
      type: 'update',
    },
  ];

  applyYdocSheetChanges({
    ydoc: syncContext.ydoc,
    dsheetId,
    changes,
    handleContentPortal,
  });
};
