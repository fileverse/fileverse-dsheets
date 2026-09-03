import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import isEqual from 'lodash/isEqual';
import { SheetChangePath, updateYdocSheetData } from '../utils/update-ydoc';
import { shouldPersistCelldataCell } from '../../sheet-engine/core/utils/cell-persist-utils';
import { applyCellFormatRangesCommits } from '../../sheet-engine/core/utils/mirror-cell-format-ranges';
import { detachWorkbookData } from '../utils/detach-workbook-data';

type SyncContext = {
  sheetEditorRef: React.MutableRefObject<WorkbookInstance | null>;
  ydocRef: React.MutableRefObject<Y.Doc | null>;
  dsheetId: string;
  handleOnChangePortalUpdate: () => void;
};

const reportSyncWarning = (
  context: string,
  details: Record<string, unknown>,
) => {
  if (typeof window === 'undefined') return;
  const error = new Error(`[WorkbookSync] ${context}`);
  (error as any).details = details;

  if (typeof (window as any).reportError === 'function') {
    (window as any).reportError(error);
  }
};

const logSyncWarning = (context: string, details: Record<string, unknown>) => {
  const isMigrated =
    typeof window !== 'undefined'
      ? Boolean((window as any).__DSHEET_MIGRATION__?.isMigrated)
      : false;
  const warningDetails = {
    ...details,
    isMigrated,
  };

  console.warn(`[WorkbookSync] ${context}`, warningDetails);
  reportSyncWarning(context, warningDetails);
};

const getSheetField = (sheet: any, field: string) => {
  if (!sheet) return undefined;
  if (typeof sheet.get === 'function') return sheet.get(field);
  return sheet[field];
};

const setSheetField = (sheet: any, field: string, value: unknown) => {
  if (!sheet) return false;
  if (typeof sheet.set === 'function') {
    sheet.set(field, value);
    return true;
  }
  if (typeof sheet === 'object') {
    sheet[field] = value;
    return true;
  }
  logSyncWarning('setSheetField failed: unsupported sheet type', {
    field,
    value,
    sheet,
    sheetType: typeof sheet,
  });
  return false;
};

const findSheetById = (sheets: any[] | undefined, sheetId: unknown) => {
  if (!Array.isArray(sheets)) return undefined;
  return sheets.find((sheet) => getSheetField(sheet, 'id') === sheetId);
};

const toYMapFromObject = (value: Record<string, any> | undefined | null) => {
  const map = new Y.Map<any>();
  if (!value || typeof value !== 'object') return map;
  Object.entries(value).forEach(([k, v]) => {
    map.set(k, v);
  });
  return map;
};

const toCellMap = (sheet: any) => {
  const map = new Y.Map<any>();

  if (Array.isArray(sheet?.celldata)) {
    sheet.celldata.forEach((cell: any) => {
      if (cell && typeof cell.r === 'number' && typeof cell.c === 'number') {
        map.set(`${cell.r}_${cell.c}`, cell);
      }
    });
    return map;
  }

  if (Array.isArray(sheet?.data)) {
    sheet.data.forEach((row: any, r: number) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell: any, c: number) => {
        if (cell != null) {
          map.set(`${r}_${c}`, { r, c, v: cell });
        }
      });
    });
  }

  return map;
};

const toCalcChainMap = (sheet: any) => {
  const map = new Y.Map<any>();
  const calcChain = sheet?.calcChain;
  if (!calcChain) return map;

  if (Array.isArray(calcChain)) {
    calcChain.forEach((item: any) => {
      if (item && typeof item.r === 'number' && typeof item.c === 'number') {
        map.set(`${item.r}_${item.c}`, item);
      }
    });
    return map;
  }

  if (typeof calcChain === 'object') {
    Object.entries(calcChain).forEach(([k, v]) => {
      if (v && typeof (v as any).r === 'number' && typeof (v as any).c === 'number') {
        map.set(k, v);
      }
    });
  }

  return map;
};

const getCurrentSheetSafe = (
  sheetEditorRef: React.MutableRefObject<WorkbookInstance | null>,
  source: string,
) => {
  try {
    return sheetEditorRef?.current?.getSheet?.() as any;
  } catch (error) {
    logSyncWarning(`${source}: getSheet failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const getCurrentYdocSheet = ({
  sheetEditorRef,
  ydocRef,
  dsheetId,
}: Omit<SyncContext, 'handleOnChangePortalUpdate'>) => {
  const currentSheet = getCurrentSheetSafe(
    sheetEditorRef,
    'getCurrentYdocSheet',
  );
  const oldSheets = ydocRef?.current?.getArray(dsheetId);
  return findSheetById(
    oldSheets?.toArray() as any[] | undefined,
    currentSheet?.id,
  ) as any;
};

export const syncCurrentSheetField = (
  context: SyncContext,
  field:
    | 'images'
    | 'iframes'
    | 'frozen'
    | 'name'
    | 'config'
    | 'showGridLines'
    | 'color'
    | 'hide',
) => {
  const { sheetEditorRef, handleOnChangePortalUpdate } = context;
  const currentSheet = getCurrentSheetSafe(
    sheetEditorRef,
    'syncCurrentSheetField',
  ) as any;
  const currentYdocSheet = getCurrentYdocSheet(context);
  if (!currentSheet || !currentYdocSheet) return;

  const ydocValue = getSheetField(currentYdocSheet, field);
  const nextValue = currentSheet[field];

  // Object fields (config, frozen, images, iframes) are rebuilt as fresh
  // references on every Workbook remount, so a reference check (`!==`) reports
  // a change even when the value is identical. In RTC that re-write broadcasts
  // to peers, who remount (config/frozen are classified structural), rebuild a
  // fresh reference, and write it straight back — a continuous cross-peer
  // remount ping-pong (the "filter flicker"). Deep-compare object values so an
  // unchanged field never re-writes.
  const isObjectValue =
    (typeof nextValue === 'object' && nextValue !== null) ||
    (typeof ydocValue === 'object' && ydocValue !== null);
  const changed = isObjectValue
    ? !isEqual(ydocValue, nextValue)
    : ydocValue !== nextValue;

  if (changed) {
    setSheetField(currentYdocSheet, field, nextValue);
    handleOnChangePortalUpdate();
  }
};

export const createSheetLengthChangeHandler = ({
  sheetEditorRef,
  ydocRef,
  dsheetId,
  currentDataRef,
  handleOnChangePortalUpdate,
}: {
  sheetEditorRef: React.MutableRefObject<WorkbookInstance | null>;
  ydocRef: React.MutableRefObject<Y.Doc | null>;
  dsheetId: string;
  currentDataRef: React.MutableRefObject<any>;
  handleOnChangePortalUpdate: () => void;
}) => {
  return () => {
    const sheetArray = ydocRef.current?.getArray<Y.Map<any>>(dsheetId);
    const sheets = sheetEditorRef.current?.getAllSheets();

    if (!sheetArray || !sheets) return;

    const docSheets = sheetArray.toArray();
    const docSheetLength = docSheets.length || 1;
    const editorSheetLength = sheets.length || 1;

    if (
      docSheetLength < editorSheetLength &&
      editorSheetLength > 1 &&
      docSheetLength > 0
    ) {
      currentDataRef.current = detachWorkbookData(sheets);
      setTimeout(() => {
        const createdSheet = sheets[sheets.length - 1];
        const sheet = { ...createdSheet };

        const ySheet = new Y.Map<any>();
        ySheet.set('id', sheet.id);
        ySheet.set('name', sheet.name);
        ySheet.set('order', sheet.order);
        ySheet.set('row', sheet.row ?? 500);
        ySheet.set('column', sheet.column ?? 36);
        ySheet.set('status', 1);
        ySheet.set('config', toYMapFromObject(sheet.config ?? {}));
        ySheet.set('celldata', toCellMap(sheet));
        ySheet.set('calcChain', toCalcChainMap(sheet));
        ySheet.set(
          'dataBlockCalcFunction',
          toYMapFromObject(sheet.dataBlockCalcFunction),
        );
        ySheet.set('liveQueryList', toYMapFromObject(sheet.liveQueryList));
        ySheet.set(
          'dataVerification',
          toYMapFromObject(sheet.dataVerification),
        );
        ySheet.set('hyperlink', toYMapFromObject(sheet.hyperlink));
        ySheet.set('conditionRules', toYMapFromObject(sheet.conditionRules));
        ySheet.set('filter_select', toYMapFromObject(sheet.filter_select));
        ySheet.set('filter', toYMapFromObject(sheet.filter));
        const conditionFormatArray = new Y.Array<any>();
        const conditionFormat = Array.isArray(
          sheet.luckysheet_conditionformat_save,
        )
          ? sheet.luckysheet_conditionformat_save
          : [];
        conditionFormatArray.insert(0, conditionFormat);
        ySheet.set('luckysheet_conditionformat_save', conditionFormatArray);
        if (sheet.showGridLines != null) {
          ySheet.set('showGridLines', sheet.showGridLines);
        }
        if (sheet.images != null) {
          ySheet.set('images', sheet.images);
        }
        if (sheet.iframes != null) {
          ySheet.set('iframes', sheet.iframes);
        }
        if (sheet.frozen != null) {
          ySheet.set('frozen', sheet.frozen);
        }
        if (sheet.hide != null) {
          ySheet.set('hide', sheet.hide);
        }
        if (sheet.color != null) {
          ySheet.set('color', sheet.color);
        }

        ydocRef.current?.transact(() => {
          sheetArray.push([ySheet]);
        });

        sheetEditorRef.current?.activateSheet({ id: sheet.id });
        handleOnChangePortalUpdate();
      }, 50);

      return;
    }

    if (docSheetLength > editorSheetLength && editorSheetLength > 0) {
      const editorSheetIds = new Set(sheets.map((s) => s.id));
      const removedIndex = docSheets.findIndex(
        (ySheet) => !editorSheetIds.has(getSheetField(ySheet, 'id')),
      );

      if (removedIndex !== -1) {
        currentDataRef.current = detachWorkbookData(
          sheetEditorRef.current?.getAllSheets() || [],
        );
        setTimeout(() => {
          ydocRef.current?.transact(() => {
            sheetArray.delete(removedIndex, 1);
          });
          handleOnChangePortalUpdate();
        }, 50);
      }
    }
  };
};

export const createAfterOrderChangesHandler = ({
  sheetEditorRef,
  ydocRef,
  dsheetId,
  handleOnChangePortalUpdate,
}: SyncContext) => {
  return () => {
    const allSheets = sheetEditorRef?.current?.getAllSheets();
    const oldSheets = ydocRef?.current?.getArray(dsheetId);
    const oldSheetsList = oldSheets?.toArray() as any[] | undefined;
    let changed = false;
    allSheets?.forEach((sheet) => {
      const currentYdocSheet = findSheetById(oldSheetsList, sheet?.id) as any;
      if (!currentYdocSheet) {
        logSyncWarning('afterOrderChanges: matching sheet not found', {
          dsheetId,
          targetSheetId: sheet?.id,
          currentSheet: {
            id: getSheetField(sheet, 'id'),
            name: getSheetField(sheet, 'name'),
            hasCelldata: getSheetField(sheet, 'celldata') != null,
          },
          ydocSheets: (oldSheetsList ?? []).map((ydocSheet) => ({
            id: getSheetField(ydocSheet, 'id'),
            name: getSheetField(ydocSheet, 'name'),
            hasCelldata: getSheetField(ydocSheet, 'celldata') != null,
          })),
        });
        return;
      }

      const ydocOrder = getSheetField(currentYdocSheet, 'order');
      if (ydocOrder !== sheet?.order) {
        setSheetField(currentYdocSheet, 'order', sheet?.order);
        changed = true;
      }
    });
    if (changed) handleOnChangePortalUpdate();
  };
};

export const createAfterColorChangesHandler = ({
  sheetEditorRef,
  ydocRef,
  dsheetId,
  handleOnChangePortalUpdate,
}: SyncContext) => {
  return () => {
    const allSheets = sheetEditorRef?.current?.getAllSheets();
    const oldSheets = ydocRef?.current?.getArray(dsheetId);
    const oldSheetsList = oldSheets?.toArray() as any[] | undefined;
    let changed = false;

    allSheets?.forEach((sheet) => {
      const currentYdocSheet = findSheetById(oldSheetsList, sheet?.id) as any;
      if (!currentYdocSheet) {
        logSyncWarning('afterColorChanges: matching sheet not found', {
          dsheetId,
          targetSheetId: sheet?.id,
          currentSheet: {
            id: getSheetField(sheet, 'id'),
            name: getSheetField(sheet, 'name'),
            hasCelldata: getSheetField(sheet, 'celldata') != null,
          },
          ydocSheets: (oldSheetsList ?? []).map((ydocSheet) => ({
            id: getSheetField(ydocSheet, 'id'),
            name: getSheetField(ydocSheet, 'name'),
            hasCelldata: getSheetField(ydocSheet, 'celldata') != null,
          })),
        });
        return;
      }

      const ydocColor = getSheetField(currentYdocSheet, 'color');
      if (ydocColor !== (sheet as any)?.color) {
        setSheetField(currentYdocSheet, 'color', (sheet as any)?.color);
        changed = true;
      }
    });

    if (changed) handleOnChangePortalUpdate();
  };
};

export const createAfterHideChangesHandler = ({
  sheetEditorRef,
  ydocRef,
  dsheetId,
  handleOnChangePortalUpdate,
}: SyncContext) => {
  return () => {
    const allSheets = sheetEditorRef?.current?.getAllSheets();
    const oldSheets = ydocRef?.current?.getArray(dsheetId);
    const oldSheetsList = oldSheets?.toArray() as any[] | undefined;
    let changed = false;

    allSheets?.forEach((sheet) => {
      const currentYdocSheet = findSheetById(oldSheetsList, sheet?.id) as any;
      if (!currentYdocSheet) {
        logSyncWarning('afterHideChanges: matching sheet not found', {
          dsheetId,
          targetSheetId: sheet?.id,
          currentSheet: {
            id: getSheetField(sheet, 'id'),
            name: getSheetField(sheet, 'name'),
            hasCelldata: getSheetField(sheet, 'celldata') != null,
          },
          ydocSheets: (oldSheetsList ?? []).map((ydocSheet) => ({
            id: getSheetField(ydocSheet, 'id'),
            name: getSheetField(ydocSheet, 'name'),
            hasCelldata: getSheetField(ydocSheet, 'celldata') != null,
          })),
        });
        return;
      }

      const ydocHide = getSheetField(currentYdocSheet, 'hide');
      if (ydocHide !== (sheet as any)?.hide) {
        setSheetField(currentYdocSheet, 'hide', (sheet as any)?.hide);
        changed = true;
      }
    });

    if (changed) handleOnChangePortalUpdate();
  };
};

export const createAfterColRowChangesHandler = ({
  sheetEditorRef,
  ydocRef,
  dsheetId,
  handleOnChangePortalUpdate,
}: SyncContext) => {
  return () => {
    const currentSheet = getCurrentSheetSafe(
      sheetEditorRef,
      'createAfterColRowChangesHandler',
    );
    const oldSheets = ydocRef?.current?.getArray(dsheetId);
    const oldSheetsList = oldSheets?.toArray() as any[] | undefined;
    const currentYdocSheet = findSheetById(
      oldSheetsList,
      currentSheet?.id,
    ) as any;
    if (!currentSheet) {
      logSyncWarning('afterColRowChanges: current sheet missing', { dsheetId });
      return;
    }
    if (!currentYdocSheet) {
      logSyncWarning('afterColRowChanges: matching sheet not found', {
        dsheetId,
        targetSheetId: currentSheet?.id,
        currentSheet: {
          id: getSheetField(currentSheet, 'id'),
          name: getSheetField(currentSheet, 'name'),
          hasCelldata: getSheetField(currentSheet, 'celldata') != null,
        },
        ydocSheets: (oldSheetsList ?? []).map((ydocSheet) => ({
          id: getSheetField(ydocSheet, 'id'),
          name: getSheetField(ydocSheet, 'name'),
          hasCelldata: getSheetField(ydocSheet, 'celldata') != null,
        })),
      });
      return;
    }

    const ydocCol = getSheetField(currentYdocSheet, 'column');
    const ydocRow = getSheetField(currentYdocSheet, 'row');
    if (ydocCol !== currentSheet?.column || ydocRow !== currentSheet?.row) {
      setSheetField(currentYdocSheet, 'column', currentSheet?.column);
      setSheetField(currentYdocSheet, 'row', currentSheet?.row);
      handleOnChangePortalUpdate();
    }
  };
};

export const updateAllCell = (
  {
    sheetEditorRef,
    ydocRef,
    dsheetId,
    handleOnChangePortalUpdate,
  }: SyncContext,
  subSheetId: string,
  caller = 'unknown',
) => {
  const workbookContext = sheetEditorRef.current?.getWorkbookContext?.() as any;
  const currentSheet = getCurrentSheetSafe(sheetEditorRef, 'updateAllCell');
  const currentSheetId =
    workbookContext?.currentSheetId?.toString?.() ||
    currentSheet?.id?.toString?.();
  if (!currentSheetId) return;

  const sheet = currentSheet;
  if (!sheet) return;

  let dataMatrix = (sheet as any).data as any[][] | undefined;
  if (
    !dataMatrix &&
    Array.isArray((sheet as any).celldata) &&
    sheetEditorRef.current?.celldataToData
  ) {
    dataMatrix =
      sheetEditorRef.current.celldataToData(
        (sheet as any).celldata,
        (sheet as any).row,
        (sheet as any).column,
        (sheet as any).config?.cellFormatRanges,
        (sheet as any).config?.merge,
      ) ?? undefined;
  }
  if (!Array.isArray(dataMatrix)) return;

  const changes: SheetChangePath[] = [];
  for (let r = 0; r < dataMatrix.length; r++) {
    const row = dataMatrix[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!shouldPersistCelldataCell(cell)) continue;
      changes.push({
        sheetId: subSheetId,
        path: ['celldata'],
        value: { r, c, v: cell },
        key: `${r}_${c}`,
        type: 'update',
      });
    }
  }

  updateYdocSheetData(
    // @ts-ignore Y.Doc present at runtime
    ydocRef.current,
    dsheetId,
    changes,
    handleOnChangePortalUpdate,
    (commits) => {
      applyCellFormatRangesCommits(
        commits,
        sheetEditorRef.current?.getWorkbookSetContext?.() ?? null,
      );
    },
  );

  if (changes.length > 0) {
    console.warn(
      `[Yjs] updateAllCell caller=${caller} sheet=${subSheetId} cells=${changes.length}`,
    );
  }
};
