/* eslint-disable @typescript-eslint/no-explicit-any */
import type React from 'react';
import * as Y from 'yjs';
import { Sheet, WorkbookInstance } from '@sheet-engine/react';
import { migrateSheetFactoryForImport } from '../utils/migrate-new-yjs';
import { isFormatLocked } from '../utils/format-gate';
import { ySheetArrayToPlain } from '../utils/update-ydoc';
import {
  parseXlsxWorkbook,
  type XlsxImportWarning,
  type XlsxParsedWorkbook,
  type XlsxParseSettings,
} from '../utils/xlsx-import-pipeline';
import {
  isDsheetWorkerSupported,
  runDsheetWorkerTask,
} from '../../worker/dsheet-worker-client';
import { removeFileExtension } from '../utils/export-filename';
import { toast } from '@fileverse/ui';
import { excelEntriesToDefinedNames } from '../utils/xlsx-defined-names';
import {
  readDefinedNamesFromYdoc,
  syncDefinedNamesToYdoc,
} from '../utils/defined-names-ydoc';

const POST_IMPORT_RECALC_MAX_FRAMES = 200;

/**
 * Post-import force-recalc is off for now (large XLSX / worker jank).
 * Later: re-enable a real scan (or lazy/scoped recalc) for exports that
 * ship formulas without cached m/v (e.g. Google Sheets).
 */
const sheetsNeedPostImportFormulaRecalc = false;

function makeUniqueSheetName(name: string, usedNames: Set<string>): string {
  if (!usedNames.has(name)) return name;
  let counter = 1;
  let candidate = `${name} (${counter})`;
  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${name} (${counter})`;
  }
  return candidate;
}

/**
 * Run when imported formula cells lack cached m/v (e.g. Google Sheets xlsx).
 * When Excel already provided display values, skip force-recalc and keep them.
 */
function schedulePostImportFormulaRecalc(
  sheetEditorRef: React.RefObject<WorkbookInstance | null>,
): void {
  let didRun = false;
  let frames = 0;

  const tryRecalc = (): boolean => {
    if (didRun) return true;
    const wb = sheetEditorRef.current;
    if (!wb?.getWorkbookContext || !wb.recalculateAllFormulas) return false;
    const ctx = wb.getWorkbookContext();
    const files = ctx?.luckysheetfile;
    if (!files?.length) return false;
    const hasGrid = files.some(
      (s) => Array.isArray(s.data) && s.data.length > 0,
    );
    if (!hasGrid) return false;
    wb.recalculateAllFormulas();
    didRun = true;
    return true;
  };

  const tick = () => {
    if (tryRecalc()) return;
    frames += 1;
    if (frames < POST_IMPORT_RECALC_MAX_FRAMES) {
      requestAnimationFrame(tick);
    } else {
      // Final attempt even if readiness heuristic missed (e.g. unusual sheet dimensions)
      sheetEditorRef.current?.recalculateAllFormulas?.();
      didRun = true;
    }
  };

  requestAnimationFrame(() => requestAnimationFrame(tick));

  // `loadLocale` in Workbook init is async — rAF may finish before grids exist.
  for (const ms of [120, 400, 1200]) {
    window.setTimeout(() => {
      if (!didRun) {
        tryRecalc();
      }
    }, ms);
  }
}

export type XlsxImportRuntimeDeps = {
  sheetEditorRef: React.RefObject<WorkbookInstance | null>;
  ydocRef: React.RefObject<Y.Doc | null>;
  setForceSheetRender: React.Dispatch<React.SetStateAction<number>>;
  dsheetId: string;
  currentDataRef: React.MutableRefObject<object | null>;
  updateDocumentTitle?: (title: string) => void;
  filterToastShown: boolean;
  setFilterToastShown: React.Dispatch<React.SetStateAction<boolean>>;
  handleContentPortal?: () => void;
};

export type XlsxImportOptions = {
  headless?: boolean;
  suppressUiWarnings?: boolean;
  onWarning?: (warning: string) => void;
  generateSheetId?: () => string;
};

function replayImportWarnings(
  warnings: XlsxImportWarning[],
  {
    filterToastShown,
    setFilterToastShown,
  }: Pick<XlsxImportRuntimeDeps, 'filterToastShown' | 'setFilterToastShown'>,
  options?: XlsxImportOptions,
): void {
  for (const warning of warnings) {
    if (warning.code === 'tables-unsupported') {
      options?.onWarning?.(
        'Tables are not fully supported. Table styles will not be applied.',
      );
      if (!options?.suppressUiWarnings) {
        toast({
          title: 'Tables are not fully supported',
          description: 'Table styles will not be applied',
          variant: 'warning',
          showCloseButton: true,
          duration: 40 * 1000,
        });
      }
    } else if (warning.code === 'filters-unsupported') {
      options?.onWarning?.('Filters are not supported in imported files.');
      if (!filterToastShown) {
        setFilterToastShown(true);
        if (!options?.suppressUiWarnings) {
          toast({
            title: 'Filters are not supported in imported files',
            variant: 'warning',
            showCloseButton: true,
            duration: 30 * 1000,
          });
        }
      }
    }
  }
}

/**
 * The pipeline assigns default sheet ids; when the caller supplies a custom
 * generator (options or workbook settings — same precedence as before the
 * worker split), swap the generated ids and keep calcChain in sync.
 */
function remapGeneratedSheetIds(
  parsed: XlsxParsedWorkbook,
  sheetEditorRef: React.RefObject<WorkbookInstance | null>,
  options?: XlsxImportOptions,
): void {
  if (parsed.generatedSheetIds.length === 0) return;
  const generateCustomId = (): string | undefined =>
    options?.generateSheetId?.() ??
    sheetEditorRef.current?.getSettings().generateSheetId();
  const generatedIds = new Set(parsed.generatedSheetIds);
  for (const sheet of parsed.sheets) {
    if (!sheet.id || !generatedIds.has(sheet.id)) continue;
    const newId = generateCustomId();
    if (!newId || newId === sheet.id) continue;
    const oldId = sheet.id;
    sheet.id = newId;
    sheet.calcChain?.forEach((entry: { id?: string }) => {
      if (entry?.id === oldId) entry.id = newId;
    });
  }
}

/** Full XLSX import pipeline; loaded only when user imports a file. */
export async function runXlsxFileUpload(
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
  }: XlsxImportRuntimeDeps,
  event: React.ChangeEvent<HTMLInputElement> | undefined,
  fileArg: File,
  importType?: 'new-dsheet' | 'merge-current-dsheet' | 'new-current-dsheet',
  options?: XlsxImportOptions,
): Promise<void> {
  const input = event?.target;
  if (!input?.files?.length && !fileArg) {
    return;
  }
  const file = input?.files?.[0] || fileArg;

  const workbookSettings = sheetEditorRef.current?.getSettings?.();
  const parseSettings: XlsxParseSettings = {
    workbookDefaultColWidth:
      Number(workbookSettings?.defaultColWidth) || undefined,
    workbookDefaultRowHeight:
      Number(workbookSettings?.defaultRowHeight) || undefined,
  };

  let parsed: XlsxParsedWorkbook | null = null;
  try {
    // Parse + decorate + compact off the main thread; the UI stays
    // interactive during the multi-second exceljs/luckyexcel work.
    if (isDsheetWorkerSupported()) {
      parsed = await runDsheetWorkerTask((api) =>
        api.parseXlsxWorkbook(file, parseSettings),
      );
    }
  } catch (workerError) {
    console.warn(
      '[xlsx-import] worker parse failed; falling back to main thread',
      workerError,
    );
    parsed = null;
  }

  try {
    if (!parsed) {
      parsed = await parseXlsxWorkbook(file, parseSettings);
    }
  } catch (error) {
    console.error('Error loading the workbook', error);
    if (!options?.suppressUiWarnings && typeof alert !== 'undefined') {
      alert(
        'Error loading the workbook. Please ensure it is a valid .xlsx file.',
      );
    }
    throw error;
  }

  replayImportWarnings(
    parsed.warnings,
    { filterToastShown, setFilterToastShown },
    options,
  );
  remapGeneratedSheetIds(parsed, sheetEditorRef, options);

  const sheets = parsed.sheets;
  const needsFormulaRecalc = sheetsNeedPostImportFormulaRecalc;

  if (!ydocRef.current) {
    console.error('ydocRef.current is null');
    return;
  }
  const sheetArray = ydocRef.current.getArray(dsheetId);
  const localSheetsArray = Array.from(sheetArray) as Sheet[];

  let combinedSheets;

  if (importType === 'merge-current-dsheet') {
    const usedNames = new Set<string>(
      localSheetsArray
        .map((s) => (s instanceof Y.Map ? s.get('name') : (s as Sheet).name))
        .filter(Boolean) as string[],
    );
    sheets.forEach((sheet) => {
      const original = sheet.name ?? '';
      const uniqueName = makeUniqueSheetName(original, usedNames);
      if (uniqueName !== original) {
        sheet.name = uniqueName;
      }
      usedNames.add(uniqueName);
    });
    combinedSheets = [...localSheetsArray, ...sheets];
  } else {
    combinedSheets = [...sheets];
  }

  combinedSheets = combinedSheets.map((sheet, index) => {
    sheet.order = index;
    return sheet;
  });

  const ydoc = ydocRef.current;
  if (isFormatLocked(ydoc, dsheetId)) return;
  ydoc.transact(() => {
    if (importType !== 'merge-current-dsheet') {
      sheetArray.delete(0, sheetArray.length);
    }

    combinedSheets.forEach((sheet) => {
      if (sheet instanceof Y.Map) return;

      const factory = migrateSheetFactoryForImport(sheet);
      sheetArray.push([factory()]);
    });
  });

  // Named ranges are workbook-level (sibling Y.Map), not sheet maps.
  const excelDefinedNameEntries = parsed.definedNameEntries ?? [];
  if (importType !== 'merge-current-dsheet') {
    const importedNames = excelEntriesToDefinedNames(
      excelDefinedNameEntries,
      combinedSheets,
    );
    syncDefinedNamesToYdoc({
      ydoc,
      dsheetId,
      definedNames: importedNames,
    });
  } else if (excelDefinedNameEntries.length > 0) {
    const existing = readDefinedNamesFromYdoc(ydoc, dsheetId);
    const importedNames = excelEntriesToDefinedNames(
      excelDefinedNameEntries,
      sheets,
    );
    const existingKeys = new Set(existing.map((d) => d.name.toLowerCase()));
    const merged = [
      ...existing,
      ...importedNames.filter((d) => !existingKeys.has(d.name.toLowerCase())),
    ];
    syncDefinedNamesToYdoc({
      ydoc,
      dsheetId,
      definedNames: merged,
    });
  }

  // Update UI immediately so sync handler sees correct count before it can run
  if (ydocRef?.current) {
    const arr = ydocRef.current.getArray(dsheetId);
    const plain = ySheetArrayToPlain(arr);
    currentDataRef.current = plain;
    setForceSheetRender((prev: number) => prev + 1);
  }
  // Mirror CSV import: persist Yjs body to host Dexie (share/publish read IDB content).
  setTimeout(() => {
    handleContentPortal?.();
  }, 200);
  // Post-import force-recalc gated by sheetsNeedPostImportFormulaRecalc
  // (currently false — revisit for Google Sheets / missing m/v later).
  if (!options?.headless && needsFormulaRecalc) {
    schedulePostImportFormulaRecalc(sheetEditorRef);
  }
  const fileName = removeFileExtension(parsed.workbookName);
  updateDocumentTitle?.(fileName);
}
