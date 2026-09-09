import { useEffect } from 'react';
import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';

export const usehandleHomepageRedirect = ({
  setIsDataLoaded,
  setSelectedTemplate,
  handleXLSXUpload,
  handleODSUpload,
  handleCSVUpload,
  ydocRef,
  dsheetId,
  currentDataRef,
  setForceSheetRender,
  sheetEditorRef,
  updateDocumentTitle,
}: {
  setIsDataLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedTemplate?: React.Dispatch<React.SetStateAction<string>>;
  handleXLSXUpload: any;
  handleODSUpload: any;
  handleCSVUpload: any;
  ydocRef: React.RefObject<Y.Doc | null>;
  dsheetId: string;
  currentDataRef: React.MutableRefObject<object | null>;
  setForceSheetRender: React.Dispatch<React.SetStateAction<number>>;
  sheetEditorRef: React.RefObject<WorkbookInstance | null>;
  updateDocumentTitle: any;
}) => {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fileUrl = params.get('xlsx');

    if (fileUrl) {
      setIsDataLoaded(false);
      fetch(fileUrl)
        .then((res) => res.blob())
        .then((blob) => {
          const file = new File([blob], 'import.xlsx');
          if (file) {
            Promise.resolve(handleXLSXUpload(undefined, file)).finally(() => {
              setIsDataLoaded(true);
            });
          }
        })
        .finally(() => {
          setIsDataLoaded(true);
          params.delete('xlsx');
          window.history.replaceState(
            {},
            '',
            `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`,
          );
        });
    }

    const odsFileUrl = params.get('ods');

    if (odsFileUrl) {
      setIsDataLoaded(false);
      fetch(odsFileUrl)
        .then((res) => res.blob())
        .then((blob) => {
          const file = new File([blob], 'import.ods');
          if (file) {
            Promise.resolve(handleODSUpload(undefined, file)).finally(() => {
              setIsDataLoaded(true);
            });
          }
        })
        .finally(() => {
          setIsDataLoaded(true);
          params.delete('ods');
          window.history.replaceState(
            {},
            '',
            `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`,
          );
        });
    }

    const csvFileUrl = params.get('csv');

    if (csvFileUrl) {
      const separatorType = params.get('separator') ?? 'auto';
      fetch(csvFileUrl)
        .then((res) => res.blob())
        .then((blob) => {
          const file = new File([blob], 'import.csv');
          if (file) {
            Promise.resolve(
              handleCSVUpload(
                undefined,
                ydocRef.current,
                setForceSheetRender,
                dsheetId,
                currentDataRef,
                sheetEditorRef,
                updateDocumentTitle,
                file,
                undefined,
                undefined,
                separatorType,
              ),
            ).finally(() => {
              setIsDataLoaded(true);
            });
          }
        })
        .finally(() => {
          setIsDataLoaded(true);
          params.delete('csv');
          params.delete('separator');
          window.history.replaceState(
            {},
            '',
            `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`,
          );
        });
    }

    const templateSlug = params.get('template');
    if (templateSlug) {
      setSelectedTemplate?.(templateSlug);
      params.delete('template');
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`,
      );
    }
  }, []);
};
