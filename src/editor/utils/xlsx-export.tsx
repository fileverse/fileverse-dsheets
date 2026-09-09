import * as Y from 'yjs';
import { WorkbookInstance } from '@sheet-engine/react';
import { MutableRefObject } from 'react';

/**
 * Loads xlsx-js-style + exceljs + export helpers only when the user exports.
 * Keeps the main editor chunk smaller for consuming apps.
 */
export const handleExportToXLSX = async (
  workbookRef: MutableRefObject<WorkbookInstance | null>,
  ydocRef: MutableRefObject<Y.Doc | null>,
  dsheetId: string,
  getDocumentTitle?: (dsheetId: string) => Promise<string>,
): Promise<void> => {
  const { handleExportToXLSX: runExport } = await import('./xlsx-export-impl');
  return runExport(workbookRef, ydocRef, dsheetId, getDocumentTitle);
};

export const handleExportToODS = async (
  workbookRef: MutableRefObject<WorkbookInstance | null>,
  ydocRef: MutableRefObject<Y.Doc | null>,
  dsheetId: string,
  getDocumentTitle?: (dsheetId: string) => Promise<string>,
): Promise<void> => {
  const { handleExportToODS: runExport } = await import('./xlsx-export-impl');
  return runExport(workbookRef, ydocRef, dsheetId, getDocumentTitle);
};
