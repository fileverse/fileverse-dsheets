// customToolbarItems.tsx

import React, { ChangeEventHandler } from 'react';
import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import { CustomButton } from './../components/import-button-ui';
import { ReadOnlyExportButton } from '../components/read-only-export-button';
import { SmartContractButton } from '../components/smart-contract';

import { IconButton } from '@fileverse/ui';

export const getCustomToolbarItems = ({
  handleContentPortal,
  setShowSmartContractModal,
  setExportDropdownOpen,
  handleCSVUpload,
  handleXLSXUpload,
  handleODSUpload,
  handleExportToXLSX,
  handleExportToODS,
  handleExportToCSV,
  handleExportToJSON,
  sheetEditorRef,
  ydocRef,
  dsheetId,
  currentDataRef,
  setForceSheetRender,
  toggleTemplateSidebar,
  getDocumentTitle,
  updateDocumentTitle,
  // setShowFetchURLModal,
}: {
  handleContentPortal?: any;
  setShowSmartContractModal?: React.Dispatch<React.SetStateAction<boolean>>;
  getDocumentTitle?: (dsheetId: string) => Promise<string>;
  updateDocumentTitle?: (title: string) => void;
  // setShowFetchURLModal: React.Dispatch<React.SetStateAction<boolean>>;
  setExportDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleCSVUpload: (
    event: ChangeEventHandler<HTMLInputElement> | undefined,
    ydocRef: Y.Doc | null,
    setForceSheetRender: React.Dispatch<React.SetStateAction<number>>,
    dsheetId: string,
    currentDataRef: React.MutableRefObject<object | null>,
    sheetEditorRef: React.RefObject<WorkbookInstance | null>,
    updateDocumentTitle?: (title: string) => void,
    file?: File,
    importType?: string,
    handleContentPortal?: any,
    separatorType?: string,
  ) => void | Promise<void>;
  handleXLSXUpload: (
    event: ChangeEventHandler<HTMLInputElement> | undefined,
    file?: File,
    importType?: string,
  ) => void | Promise<void>;
  handleODSUpload: (
    event: ChangeEventHandler<HTMLInputElement> | undefined,
    file?: File,
    importType?: string,
  ) => void | Promise<void>;
  handleExportToXLSX: (
    sheetEditorRef: React.RefObject<WorkbookInstance | null>,
    ydocRef: React.RefObject<Y.Doc | null>,
    dsheetId: string,
    getDocumentTitle?: (dsheetId: string) => Promise<string>,
  ) => void;
  handleExportToODS: (
    sheetEditorRef: React.RefObject<WorkbookInstance | null>,
    ydocRef: React.RefObject<Y.Doc | null>,
    dsheetId: string,
    getDocumentTitle?: (dsheetId: string) => Promise<string>,
  ) => void;
  handleExportToCSV: (
    sheetEditorRef: React.RefObject<WorkbookInstance | null>,
    ydocRef: React.RefObject<Y.Doc | null>,
    dsheetId: string,
    getDocumentTitle?: (dsheetId: string) => Promise<string>,
  ) => void;
  handleExportToJSON: (
    sheetEditorRef: React.RefObject<WorkbookInstance | null>,
    ydocRef: React.RefObject<Y.Doc | null>,
    dsheetId: string,
  ) => void;
  sheetEditorRef: React.RefObject<WorkbookInstance | null>;
  ydocRef: React.RefObject<Y.Doc | null>;
  dsheetId: string;
  currentDataRef: React.MutableRefObject<object | null>;
  setForceSheetRender: React.Dispatch<React.SetStateAction<number>>;
  toggleTemplateSidebar: (() => void) | undefined;
  setShowFetchURLModal:
  | React.Dispatch<React.SetStateAction<boolean>>
  | undefined;
}) => {
  return [
    ...(setShowSmartContractModal
      ? [
          {
            key: 'Smart Contract',
            tooltip: 'Smart Contract',
            icon: (
              <SmartContractButton
                handleImportSmartContract={() =>
                  setShowSmartContractModal?.((prev: boolean) => {
                    return !prev;
                  })
                }
                handleViewSmartContract={() =>
                  document.getElementById('view-smart-contract')?.click()
                }
              />
            ),
          },
        ]
      : []),
    {
      key: 'import-export',
      tooltip: 'Import/Export',
      onClick: () => {
        setExportDropdownOpen((prev) => !prev);
      },
      icon: (
        <CustomButton
          setExportDropdownOpen={setExportDropdownOpen}
          handleCSVUpload={(event, file, importType, separatorType) =>
            handleCSVUpload(
              event,
              ydocRef.current,
              setForceSheetRender,
              dsheetId,
              currentDataRef,
              sheetEditorRef,
              updateDocumentTitle,
              file,
              importType,
              handleContentPortal,
              separatorType,
            )
          }
          handleXLSXUpload={handleXLSXUpload}
          handleODSUpload={handleODSUpload}
          handleExportToXLSX={() =>
            handleExportToXLSX(
              sheetEditorRef,
              ydocRef,
              dsheetId,
              getDocumentTitle,
            )
          }
          handleExportToODS={() =>
            handleExportToODS(
              sheetEditorRef,
              ydocRef,
              dsheetId,
              getDocumentTitle,
            )
          }
          handleExportToCSV={() =>
            handleExportToCSV(
              sheetEditorRef,
              ydocRef,
              dsheetId,
              getDocumentTitle,
            )
          }
          handleExportToJSON={() =>
            handleExportToJSON(sheetEditorRef, ydocRef, dsheetId)
          }
        />
      ),
    },
    {
      /*template-button is used in use xocument style */
      key: 'fetch-url',
      tooltip: 'Fetch data: Coming soon',
      icon: (
        <IconButton
          className="cursor-not-allowed fetch-url-button !min-w-[30px] w-[30px] h-[30px] !px-0 bg-[#1977E42E] hover:!bg-[#1977E42E] rounded-lg"
          icon="FetchData"
          size="md"
          variant="ghost"
          color="blue"
          aria-label="Fetch data"
          data-testid="toolbar-fetch-data-button"
        />
      ),
      onClick: () => {
        return;
        // const selection = sheetEditorRef.current?.getSelection();
        // setShowFetchURLModal?.((prev) => {
        //   if (selection && !prev) {
        //     return true;
        //   } else {
        //     return false;
        //   }
        // });
      },
    },
    {
      /*template-button is used in use xocument style */
      key: 'templates',
      tooltip: 'Templates',
      icon: (
        <IconButton
          className="!min-w-[30px] w-[30px] h-[30px] !px-0 template-button text-[#CF1C82] bg-[#CF1C821F] rounded-lg hover:!bg-[#CF1C821F] "
          icon="LayoutTemplate"
          size="md"
          variant="ghost"
          aria-label="Open templates"
          data-testid="toolbar-templates-button"
        />
      ),
      onClick: toggleTemplateSidebar,
    },
  ];
};

type ReadOnlyExportDeps = {
  setExportDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleExportToXLSX: (
    sheetEditorRef: React.RefObject<WorkbookInstance | null>,
    ydocRef: React.RefObject<Y.Doc | null>,
    dsheetId: string,
    getDocumentTitle?: (dsheetId: string) => Promise<string>,
  ) => void;
  handleExportToODS: (
    sheetEditorRef: React.RefObject<WorkbookInstance | null>,
    ydocRef: React.RefObject<Y.Doc | null>,
    dsheetId: string,
    getDocumentTitle?: (dsheetId: string) => Promise<string>,
  ) => void;
  handleExportToCSV: (
    sheetEditorRef: React.RefObject<WorkbookInstance | null>,
    ydocRef: React.RefObject<Y.Doc | null>,
    dsheetId: string,
    getDocumentTitle?: (dsheetId: string) => Promise<string>,
  ) => void;
  handleExportToJSON: (
    sheetEditorRef: React.RefObject<WorkbookInstance | null>,
    ydocRef: React.RefObject<Y.Doc | null>,
    dsheetId: string,
  ) => void;
  sheetEditorRef: React.RefObject<WorkbookInstance | null>;
  ydocRef: React.RefObject<Y.Doc | null>;
  dsheetId: string;
  getDocumentTitle?: (dsheetId: string) => Promise<string>;
};

export const getReadOnlyCustomToolbarItems = ({
  setExportDropdownOpen,
  handleExportToXLSX,
  handleExportToODS,
  handleExportToCSV,
  handleExportToJSON,
  sheetEditorRef,
  ydocRef,
  dsheetId,
  getDocumentTitle,
}: ReadOnlyExportDeps) => {
  return [
    {
      key: 'export-only',
      tooltip: 'Download',
      onClick: () => {
        setExportDropdownOpen((prev) => !prev);
      },
      icon: (
        <ReadOnlyExportButton
          setExportDropdownOpen={setExportDropdownOpen}
          handleExportToXLSX={() =>
            handleExportToXLSX(
              sheetEditorRef,
              ydocRef,
              dsheetId,
              getDocumentTitle,
            )
          }
          handleExportToODS={() =>
            handleExportToODS(
              sheetEditorRef,
              ydocRef,
              dsheetId,
              getDocumentTitle,
            )
          }
          handleExportToCSV={() =>
            handleExportToCSV(
              sheetEditorRef,
              ydocRef,
              dsheetId,
              getDocumentTitle,
            )
          }
          handleExportToJSON={() =>
            handleExportToJSON(sheetEditorRef, ydocRef, dsheetId)
          }
        />
      ),
    },
  ];
};
