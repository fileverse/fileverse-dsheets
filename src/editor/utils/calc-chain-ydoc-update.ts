import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import { diffObjectArrays } from './diff-sheet';
import { SheetChangePath } from './update-ydoc';
import {
  applyYdocSheetChanges,
  getSheetYdocSyncContext,
} from './sheet-ydoc-sync-utils';

const getCalcChainKey = (item: any) => `${item.r}_${item.c}`;

/**
 * Sync calcChain array for active sheet.
 * calcChain is keyed by `r_c` while stored in Yjs.
 */
export const calcChainYdocUpdate = ({
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
    field: 'calcChain',
  });
  if (!syncContext) return;

  const newData = syncContext.newValue || [];
  const oldData = syncContext.oldSheet.calcChain || [];
  // @ts-ignore
  const calcChainDiff = diffObjectArrays(oldData, newData, getCalcChainKey);
  const changes: SheetChangePath[] = [];

  if (calcChainDiff?.added?.length) {
    calcChainDiff.added.forEach((item) => {
      changes.push({
        sheetId: syncContext.currentSheetId,
        path: ['calcChain'],
        value: {
          r: item.r,
          c: item.c,
          v: item,
        },
        key: item.r + '_' + item.c,
        type: 'update',
      });
    });
  }

  calcChainDiff?.removed?.forEach((item) => {
    changes.push({
      sheetId: syncContext.currentSheetId,
      path: ['calcChain'],
      value: {
        r: item.r,
        c: item.c,
        v: item,
      },
      key: item.r + '_' + item.c,
      type: 'delete',
    });
  });

  applyYdocSheetChanges({
    ydoc: syncContext.ydoc,
    dsheetId,
    changes,
    handleContentPortal,
  });
};
