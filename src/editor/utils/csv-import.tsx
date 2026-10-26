// @ts-nocheck
import Papa from 'papaparse';
import { Sheet } from '@sheet-engine/react';
import React from 'react';
import * as Y from 'yjs';
import { WorkbookInstance } from '@sheet-engine/react';
import { encode } from 'punycode';
import { migrateSheetFactoryForImport } from '../utils/migrate-new-yjs';
import { isFormatLocked } from './format-gate';
import { ySheetArrayToPlain } from '../utils/update-ydoc';

export const handleCSVUpload = (
  event: React.ChangeEventHandler<HTMLInputElement> | undefined,
  ydoc: Y.Doc | null,
  setForceSheetRender: React.Dispatch<React.SetStateAction<number>>,
  dsheetId: string,
  currentDataRef: React.MutableRefObject<object | null>,
  sheetEditorRef: React.RefObject<WorkbookInstance | null>,
  updateDocumentTitle?: (title: string) => void,
  fileArg?: File,
  importType?: string,
  handleContentPortal?: any,
  separatorType?: string,
  options?: { suppressUiWarnings?: boolean },
): Promise<void> => {
  const input = event?.target;
  if (!input?.files?.length && !fileArg) {
    return Promise.resolve();
  }
  const file = input?.files[0] || fileArg;

  return new Promise<void>((resolve, reject) => {
    const reader = new FileReader({ encoded: 'UTF-8' });
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = (e) => {
      if (!e.target) {
        console.error('FileReader event target is null');
        reject(new Error('FileReader event target is null'));
        return;
      }
      const csvContent = e.target.result;

      if (typeof csvContent === 'string') {
        const delimiter =
          separatorType === 'tab' ? '\t' : separatorType === 'comma' ? ',' : '';
        Papa.parse(csvContent, {
          header: true,
          dynamicTyping: true,
          skipEmptyLines: true,
          delimiter,
          complete: (results) => {
            if (results.errors.length > 0 && results.data.length === 0) {
              console.error('CSV Parsing errors:', results.errors);
              if (!options?.suppressUiWarnings && typeof alert !== 'undefined') {
                alert('Error parsing CSV file');
              }
              reject(new Error('Error parsing CSV file'));
              return;
            }

            // Convert CSV data to fortune-sheet format
            const cellData: {
              r: number;
              c: number;
              v: {
                m: string | number | null;
                ct: { fa: string; t: string };
                v: string | number | null;
              };
            }[] = [];
            const headers = results.meta.fields || [];

            // Add header row
            const headerRow = headers.map((headerV, index) => {
              // @ts-expect-error later
              const renamedHeadersKeys = results.meta.renamedHeaders
                ? Object.keys(results.meta.renamedHeaders)
                : [];
              const header = renamedHeadersKeys.includes(headerV)
                ? results.meta.renamedHeaders[headerV]
                : headerV;
              return {
                r: 0,
                c: index,
                v: {
                  m: header !== null ? header : null,
                  ct: {
                    fa: 'General',
                    t: 'g',
                  },
                  v: header !== null ? header : null,
                },
              };
            });

            headerRow.forEach((cell) => {
              cellData.push(cell);
            });

            // Add data rows
            let maxRow = 0;
            let maxCol = 0;
            const urlRegex = /^https?:\/\/\S+$/i;
            const hyperlinkMap: Record<
              string,
              { linkType: string; linkAddress: string }
            > = {};
            results.data.forEach((row, rowIndex) => {
              headers.forEach((header, colIndex) => {
                const cellValue = (
                  row as Record<string, string | number | null>
                )[header];
                const cellStr =
                  cellValue !== null && cellValue !== undefined
                    ? cellValue.toString()
                    : null;
                const isUrl = cellStr && urlRegex.test(cellStr);
                cellData.push({
                  r: rowIndex + 1, // +1 because header is row 0
                  c: colIndex,
                  v: {
                    m: cellStr,
                    ct: {
                      fa: 'General',
                      t: 'g',
                    },
                    v: cellStr,
                    ...(isUrl && { fc: 'rgb(0, 0, 255)', un: 1 }),
                  },
                });
                // Detect URLs and store as hyperlinks
                if (isUrl) {
                  hyperlinkMap[`${rowIndex + 1}_${colIndex}`] = {
                    linkType: 'webpage',
                    linkAddress: cellStr,
                  };
                }
                maxRow = Math.max(maxRow, rowIndex + 1);
                maxCol = Math.max(maxCol, colIndex + 1);
              });
            });

            // Create sheet object in fortune-sheet format
            const rowCount = maxRow + 1 < 500 ? 500 : maxRow + 1;
            const colCount = maxCol + 1 < 36 ? 36 : maxCol + 1;

            if (!ydoc) {
              console.error('ydocRef.current is null');
              reject(new Error('ydocRef.current is null'));
              return;
            }

            if (isFormatLocked(ydoc, dsheetId)) {
              resolve();
              return;
            }
            const sheetArray = ydoc.getArray(dsheetId);

            // Helper: run the standard post-transaction sync and re-render
            const finishImport = (sheetIndex: number) => {
              const plain = ySheetArrayToPlain(ydoc.getArray(dsheetId));
              currentDataRef.current = plain;
              setTimeout(() => {
                if (handleContentPortal) handleContentPortal();
                setForceSheetRender((prev: number) => prev + 1);
              }, 200);
              setTimeout(() => {
                sheetEditorRef.current?.activateSheet({ index: sheetIndex });
              }, 500);
              resolve();
            };

            // Helper: get the active sheet Y.Map
            const getActiveSheetMap = (): Y.Map<any> | undefined => {
              const currentSheetId =
                sheetEditorRef.current?.getWorkbookContext()?.currentSheetId;
              return sheetArray
                .toArray()
                .find(
                  (s) => s instanceof Y.Map && s.get('id') === currentSheetId,
                ) as Y.Map<any> | undefined;
            };

            // Helper: clear all entries from a Y.Map field on a sheet map
            const clearYMap = (sheetMap: Y.Map<any>, field: string) => {
              const ymap = sheetMap.get(field);
              if (ymap instanceof Y.Map) {
                Array.from(ymap.keys()).forEach((k) => ymap.delete(k));
              }
            };

            if (importType === 'replace-current-sheet') {
              const activeSheetMap = getActiveSheetMap();
              if (!activeSheetMap) {
                reject(new Error('No active sheet found'));
                return;
              }

              ydoc.transact(() => {
                // Clear cell data
                clearYMap(activeSheetMap, 'celldata');
                let cellMap = activeSheetMap.get('celldata');
                if (!(cellMap instanceof Y.Map)) {
                  cellMap = new Y.Map();
                  activeSheetMap.set('celldata', cellMap);
                }

                // Clear side-maps
                for (const field of [
                  'hyperlink',
                  'filter',
                  'filter_select',
                  'dataVerification',
                  'conditionRules',
                ]) {
                  clearYMap(activeSheetMap, field);
                }

                // Reset merge config
                activeSheetMap.set('config', { merge: {} });

                // Write new cell data
                cellData.forEach((cell) => {
                  cellMap.set(`${cell.r}_${cell.c}`, cell);
                });

                // Update dimensions
                activeSheetMap.set('row', rowCount);
                activeSheetMap.set('column', colCount);

                // Write hyperlinks
                if (Object.keys(hyperlinkMap).length > 0) {
                  let hMap = activeSheetMap.get('hyperlink');
                  if (!(hMap instanceof Y.Map)) {
                    hMap = new Y.Map();
                    activeSheetMap.set('hyperlink', hMap);
                  }
                  Object.entries(hyperlinkMap).forEach(([k, v]) =>
                    hMap.set(k, v),
                  );
                }
              });

              const activeIndex = sheetArray
                .toArray()
                .findIndex(
                  (s) =>
                    s instanceof Y.Map &&
                    s.get('id') === activeSheetMap.get('id'),
                );
              finishImport(activeIndex);
              return;
            }

            if (importType === 'append-to-current-sheet') {
              const activeSheetMap = getActiveSheetMap();
              if (!activeSheetMap) {
                reject(new Error('No active sheet found'));
                return;
              }

              // Find the last used row in the existing sheet
              let maxExistingRow = -1;
              const existingCellMap = activeSheetMap.get('celldata');
              if (existingCellMap instanceof Y.Map) {
                existingCellMap.forEach((_v, key) => {
                  const r = parseInt(key.split('_')[0], 10);
                  if (r > maxExistingRow) maxExistingRow = r;
                });
              }
              const startRow = maxExistingRow + 1; // 0 when sheet is empty

              // Offset all rows by startRow
              const appendCells = cellData.map((cell) => ({
                ...cell,
                r: cell.r + startRow,
              }));

              // Offset hyperlink keys
              const offsetHyperlinkMap: Record<
                string,
                { linkType: string; linkAddress: string }
              > = {};
              Object.entries(hyperlinkMap).forEach(([key, val]) => {
                const [r, c] = key.split('_').map(Number);
                offsetHyperlinkMap[`${r + startRow}_${c}`] = val;
              });

              const newMaxRow = appendCells.reduce(
                (m, c) => Math.max(m, c.r),
                0,
              );

              ydoc.transact(() => {
                let cellMap = activeSheetMap.get('celldata');
                if (!(cellMap instanceof Y.Map)) {
                  cellMap = new Y.Map();
                  activeSheetMap.set('celldata', cellMap);
                }

                appendCells.forEach((cell) => {
                  cellMap.set(`${cell.r}_${cell.c}`, cell);
                });

                // Expand row count if needed
                const currentRowCount = activeSheetMap.get('row') ?? 0;
                if (newMaxRow + 1 > currentRowCount) {
                  activeSheetMap.set('row', Math.max(newMaxRow + 1, 500));
                }

                // Merge hyperlinks
                if (Object.keys(offsetHyperlinkMap).length > 0) {
                  let hMap = activeSheetMap.get('hyperlink');
                  if (!(hMap instanceof Y.Map)) {
                    hMap = new Y.Map();
                    activeSheetMap.set('hyperlink', hMap);
                  }
                  Object.entries(offsetHyperlinkMap).forEach(([k, v]) =>
                    hMap.set(k, v),
                  );
                }
              });

              const activeIndex = sheetArray
                .toArray()
                .findIndex(
                  (s) =>
                    s instanceof Y.Map &&
                    s.get('id') === activeSheetMap.get('id'),
                );
              finishImport(activeIndex);
              return;
            }

            if (importType === 'replace-data-at-selected-cell') {
              const activeSheetMap = getActiveSheetMap();
              if (!activeSheetMap) {
                reject(new Error('No active sheet found'));
                return;
              }

              // Get anchor cell from current selection
              const context = sheetEditorRef.current?.getWorkbookContext();
              const selections = (context as any)?.luckysheet_select_save ?? [];
              const lastSel = selections[selections.length - 1];
              const anchorRow: number =
                lastSel?.row_focus ?? lastSel?.row?.[0] ?? 0;
              const anchorCol: number =
                lastSel?.column_focus ?? lastSel?.column?.[0] ?? 0;

              // Offset all cells by anchor
              const offsetCells = cellData.map((cell) => ({
                ...cell,
                r: cell.r + anchorRow,
                c: cell.c + anchorCol,
              }));

              // Offset hyperlink keys
              const offsetHyperlinkMap: Record<
                string,
                { linkType: string; linkAddress: string }
              > = {};
              Object.entries(hyperlinkMap).forEach(([key, val]) => {
                const [r, c] = key.split('_').map(Number);
                offsetHyperlinkMap[`${r + anchorRow}_${c + anchorCol}`] = val;
              });

              const newMaxRow = offsetCells.reduce(
                (m, c) => Math.max(m, c.r),
                0,
              );
              const newMaxCol = offsetCells.reduce(
                (m, c) => Math.max(m, c.c),
                0,
              );

              ydoc.transact(() => {
                let cellMap = activeSheetMap.get('celldata');
                if (!(cellMap instanceof Y.Map)) {
                  cellMap = new Y.Map();
                  activeSheetMap.set('celldata', cellMap);
                }

                offsetCells.forEach((cell) => {
                  cellMap.set(`${cell.r}_${cell.c}`, cell);
                });

                // Expand dimensions if write region exceeds current bounds
                const currentRowCount = activeSheetMap.get('row') ?? 0;
                const currentColCount = activeSheetMap.get('column') ?? 0;
                if (newMaxRow + 1 > currentRowCount) {
                  activeSheetMap.set('row', Math.max(newMaxRow + 1, 500));
                }
                if (newMaxCol + 1 > currentColCount) {
                  activeSheetMap.set('column', Math.max(newMaxCol + 1, 36));
                }

                // Merge hyperlinks
                if (Object.keys(offsetHyperlinkMap).length > 0) {
                  let hMap = activeSheetMap.get('hyperlink');
                  if (!(hMap instanceof Y.Map)) {
                    hMap = new Y.Map();
                    activeSheetMap.set('hyperlink', hMap);
                  }
                  Object.entries(offsetHyperlinkMap).forEach(([k, v]) =>
                    hMap.set(k, v),
                  );
                }
              });

              const activeIndex = sheetArray
                .toArray()
                .findIndex(
                  (s) =>
                    s instanceof Y.Map &&
                    s.get('id') === activeSheetMap.get('id'),
                );
              finishImport(activeIndex);
              return;
            }

            // Existing modes: merge-current-dsheet / new-current-dsheet / new-dsheet
            const data = Array.from(sheetArray) as Sheet[];

            const sheetObject = {
              id: crypto.randomUUID(),
              name: file.name || 'Sheet1',
              celldata: [...cellData],
              row: rowCount,
              column: colCount,
              status: 1,
              order: data.length,
              config: {
                merge: {}, // No merge cells for CSV by default
              },
              ...(Object.keys(hyperlinkMap).length > 0 && {
                hyperlink: hyperlinkMap,
              }),
            };

            updateDocumentTitle?.(file.name);
            let finalData;
            if (importType === 'merge-current-dsheet') {
              finalData = [...data, sheetObject as Sheet];
            } else {
              finalData = [sheetObject as Sheet];
            }

            ydoc.transact(() => {
              if (importType !== 'merge-current-dsheet') {
                sheetArray.delete(0, sheetArray.length);
              }

              finalData.forEach((sheet) => {
                if (sheet instanceof Y.Map) return;

                const factory = migrateSheetFactoryForImport(sheet);
                sheetArray.push([factory()]);
              });
            });

            finishImport(finalData.length - 1);
            return;
          },
        });
      } else {
        reject(new Error('Invalid file content'));
      }
    };

    reader.readAsText(file);
  });
};
