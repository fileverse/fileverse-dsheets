import { useCallback, useState } from 'react';
import type {
  ChangeEvent,
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from 'react';
import type * as Y from 'yjs';
import type { WorkbookInstance } from '@sheet-engine/react';

type ImportType = 'new-dsheet' | 'merge-current-dsheet' | 'new-current-dsheet';

/**
 * XLSX / ODS import: keeps ~100k+ LOC (SSF, hyperlink helpers, exceljs/luckyexcel
 * orchestration) in a separate chunk until the user actually imports a file.
 * ODS is converted to XLSX first, then runs the same pipeline.
 */
export const useXLSXImport = ({
  sheetEditorRef,
  ydocRef,
  setForceSheetRender,
  dsheetId,
  currentDataRef,
  updateDocumentTitle,
  handleContentPortal,
}: {
  sheetEditorRef: RefObject<WorkbookInstance | null>;
  ydocRef: RefObject<Y.Doc | null>;
  setForceSheetRender: Dispatch<SetStateAction<number>>;
  dsheetId: string;
  currentDataRef: MutableRefObject<object | null>;
  updateDocumentTitle?: (title: string) => void;
  handleContentPortal?: () => void;
}) => {
  const [filterToastShown, setFilterToastShown] = useState(false);

  const handleXLSXUpload = useCallback(
    async (
      event: ChangeEvent<HTMLInputElement> | undefined,
      fileArg: File,
      importType?: ImportType,
    ): Promise<void> => {
      const { runXlsxFileUpload } = await import('./use-xlsx-import-impl');
      return runXlsxFileUpload(
        {
          sheetEditorRef,
          ydocRef,
          setForceSheetRender,
          dsheetId,
          currentDataRef,
          updateDocumentTitle,
          filterToastShown,
          setFilterToastShown,
          handleContentPortal,
        },
        event,
        fileArg,
        importType,
      );
    },
    [
      sheetEditorRef,
      ydocRef,
      setForceSheetRender,
      dsheetId,
      currentDataRef,
      updateDocumentTitle,
      filterToastShown,
      handleContentPortal,
    ],
  );

  /** ODS → XLSX conversion, then the same import pipeline as .xlsx. */
  const handleODSUpload = useCallback(
    async (
      event: ChangeEvent<HTMLInputElement> | undefined,
      fileArg: File,
      importType?: ImportType,
    ): Promise<void> => {
      const { convertOdsFileToXlsxFile } = await import('../utils/ods-to-xlsx');
      const { runXlsxFileUpload } = await import('./use-xlsx-import-impl');
      const input = event?.target;
      const odsFile = input?.files?.[0] || fileArg;
      if (!odsFile) return;
      const xlsxFile = await convertOdsFileToXlsxFile(odsFile);
      return runXlsxFileUpload(
        {
          sheetEditorRef,
          ydocRef,
          setForceSheetRender,
          dsheetId,
          currentDataRef,
          updateDocumentTitle,
          filterToastShown,
          setFilterToastShown,
          handleContentPortal,
        },
        undefined,
        xlsxFile,
        importType,
      );
    },
    [
      sheetEditorRef,
      ydocRef,
      setForceSheetRender,
      dsheetId,
      currentDataRef,
      updateDocumentTitle,
      filterToastShown,
      handleContentPortal,
    ],
  );

  return { handleXLSXUpload, handleODSUpload };
};
