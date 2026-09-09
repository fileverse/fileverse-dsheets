import { fromUint8Array } from 'js-base64';
import * as Y from 'yjs';

import { handleCSVUpload } from './csv-import';
import { removeFileExtension } from './export-filename';

export type SpreadsheetImportFileType = 'xlsx' | 'csv' | 'ods';

export type ImportSpreadsheetFileOptions = {
  type: SpreadsheetImportFileType;
  separator?: 'auto' | 'tab' | 'comma' | string;
  dsheetId: string;
};

export type ImportSpreadsheetFileResult = {
  encodedContent: string;
  title?: string;
  warnings?: string[];
};

type MutableRef<T> = { current: T };

const generateId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `sheet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const noopSetState = <T>(
  _value: T | ((previous: T) => T),
): void => undefined;

const createHeadlessWorkbookRef = () =>
  ({
    current: {
      activateSheet: () => undefined,
      getWorkbookContext: () => ({
        currentSheetId: undefined,
        luckysheetfile: [],
        luckysheet_select_save: [],
      }),
      getSettings: () => ({
        defaultColWidth: 99,
        defaultRowHeight: 21,
        generateSheetId: generateId,
      }),
      recalculateAllFormulas: () => undefined,
    },
  }) as MutableRef<any>;

export async function importSpreadsheetFile(
  file: File,
  options: ImportSpreadsheetFileOptions,
): Promise<ImportSpreadsheetFileResult> {
  if (!options.dsheetId || options.dsheetId.trim().length === 0) {
    throw new Error('importSpreadsheetFile requires a dsheetId');
  }

  const dsheetId = options.dsheetId;
  const ydoc = new Y.Doc();
  const currentDataRef: MutableRef<object | null> = { current: null };
  const ydocRef: MutableRef<Y.Doc | null> = { current: ydoc };
  const sheetEditorRef = createHeadlessWorkbookRef();
  const titleRef = { current: removeFileExtension(file.name) };
  const warnings: string[] = [];
  const updateDocumentTitle = (title: string) => {
    titleRef.current = removeFileExtension(title || file.name);
  };

  try {
    if (options.type === 'csv') {
      await handleCSVUpload(
        undefined,
        ydoc,
        noopSetState,
        dsheetId,
        currentDataRef,
        sheetEditorRef,
        updateDocumentTitle,
        file,
        'new-dsheet',
        undefined,
        options.separator ?? 'auto',
        { suppressUiWarnings: true },
      );
    } else {
      let importFile = file;
      if (options.type === 'ods') {
        const { convertOdsFileToXlsxFile } = await import('./ods-to-xlsx');
        importFile = await convertOdsFileToXlsxFile(file);
      }

      const { runXlsxFileUpload } = await import(
        '../hooks/use-xlsx-import-impl'
      );

      await runXlsxFileUpload(
        {
          sheetEditorRef,
          ydocRef,
          setForceSheetRender: noopSetState,
          dsheetId,
          currentDataRef,
          updateDocumentTitle,
          filterToastShown: true,
          setFilterToastShown: noopSetState,
        },
        undefined,
        importFile,
        'new-dsheet',
        {
          generateSheetId: generateId,
          headless: true,
          onWarning: (warning) => warnings.push(warning),
          suppressUiWarnings: true,
        },
      );
    }

    const sheetArray = ydoc.getArray(dsheetId);
    if (sheetArray.length === 0) {
      throw new Error('No sheets were imported');
    }

    return {
      encodedContent: fromUint8Array(Y.encodeStateAsUpdate(ydoc)),
      title: titleRef.current,
      warnings,
    };
  } finally {
    ydoc.destroy();
  }
}
