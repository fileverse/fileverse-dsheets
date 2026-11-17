import * as Y from 'yjs';
import { Sheet } from '@sheet-engine/react';
import { INIT_ORIGIN } from './content-change';

function normalizeCelldataArray(celldata: any[]): Record<string, any> {
  const result: Record<string, any> = {};

  celldata.forEach((cell) => {
    if (typeof cell?.r === 'number' && typeof cell?.c === 'number') {
      const key = `${cell.r}_${cell.c}`;
      result[key] = cell;
    }
  });

  return result;
}

const setMigrationStatusOnWindow = (isMigrated: boolean) => {
  if (typeof window === 'undefined') return;
  (window as any).__DSHEET_MIGRATION__ = { isMigrated };
};

export function migrateSheetArrayIfNeeded(
  ydoc: Y.Doc,
  sheetArray: Y.Array<any>,
) {
  let needsMigration = false;

  sheetArray.forEach((item) => {
    if (!(item instanceof Y.Map)) {
      needsMigration = true;
    }
  });

  if (!needsMigration) {
    setMigrationStatusOnWindow(false);
    return false;
  }

  ydoc.transact(() => {
    sheetArray.forEach((item, index) => {
      if (item instanceof Y.Map) return;

      const sheetMap = new Y.Map();

      Object.entries(item).forEach(([key, value]) => {
        if (value === undefined || value === null) {
          console.warn(
            `[DSheet] Skipping property '${key}' as its value is undefined or null.`,
          );
          return;
        }

        // celldata array → Y.Map keyed by r_c for efficient Yjs updates
        if (key === 'celldata' && Array.isArray(value)) {
          const cellMap = new Y.Map();
          const normalized = normalizeCelldataArray(value);

          Object.entries(normalized).forEach(([cellKey, cellValue]) => {
            cellMap.set(cellKey, cellValue);
          });

          sheetMap.set('celldata', cellMap);
          return;
        }

        if (key === 'calcChain' && Array.isArray(value)) {
          const calcChainMap = new Y.Map();
          const normalized = normalizeCelldataArray(value);

          Object.entries(normalized).forEach(([cellKey, cellValue]) => {
            calcChainMap.set(cellKey, cellValue);
          });

          sheetMap.set('calcChain', calcChainMap);
          return;
        }

        if (key === 'luckysheet_conditionformat_save' && Array.isArray(value)) {
          const luckysheet_conditionformat_save = new Y.Array();
          value.forEach((item) => {
            luckysheet_conditionformat_save.push([item]); // 👈 wrap in array
          });

          sheetMap.set(
            'luckysheet_conditionformat_save',
            luckysheet_conditionformat_save,
          );
          return;
        }

        if (key === 'dataBlockCalcFunction') {
          const dataBlockCalcFunction = new Y.Map();
          Object.entries(value as object).forEach(([k, v]) =>
            dataBlockCalcFunction.set(k, v),
          );
          sheetMap.set('dataBlockCalcFunction', dataBlockCalcFunction);
          return;
        }

        if (key === 'dataVerification') {
          const dataVerification = new Y.Map();
          const dV = value ? value : {};
          Object.entries(dV as object).forEach(([k, v]) =>
            dataVerification.set(k, v),
          );
          sheetMap.set('dataVerification', dataVerification);
          return;
        }

        if (key === 'hyperlink') {
          const hyperlink = new Y.Map();
          const hL = value ? value : {};
          Object.entries(hL as object).forEach(([k, v]) => hyperlink.set(k, v));
          sheetMap.set('hyperlink', hyperlink);
          return;
        }

        if (key === 'conditionRules') {
          const conditionRules = new Y.Map();
          const cR = value ? value : {};
          Object.entries(cR as object).forEach(([k, v]) =>
            conditionRules.set(k, v),
          );
          sheetMap.set('conditionRules', conditionRules);
          return;
        }

        if (key === 'filter_select') {
          const filterSelect = new Y.Map();
          const fS = value ? value : {};
          Object.entries(fS as object).forEach(([k, v]) =>
            filterSelect.set(k, v),
          );
          sheetMap.set('filter_select', filterSelect);
          return;
        }

        if (key === 'filter') {
          const filter = new Y.Map();
          const f = value ? value : {};
          Object.entries(f as object).forEach(([k, v]) => filter.set(k, v));
          sheetMap.set('filter', filter);
          return;
        }

      if (key === 'config') {
        const configMap = new Y.Map();
        const c = value ? value : {};
        Object.entries(c as object).forEach(([k, v]) => configMap.set(k, v));
        sheetMap.set('config', configMap);
        return;
      }

        // nested object → Y.Map
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const yMap = new Y.Map();
          Object.entries(value).forEach(([k, v]) => yMap.set(k, v));
          sheetMap.set(key, yMap);
          return;
        }

        // primitives
        sheetMap.set(key, value);
      });

      if (sheetArray?.delete) {
        sheetArray.delete(index, 1);
        sheetArray.insert(index, [sheetMap]);
      }
    });
    // Storage migration, not a user edit (A1 userEdited).
  }, INIT_ORIGIN);
  setMigrationStatusOnWindow(true);

  return true;
}

type SheetFactory = () => Y.Map<any>;

export function migrateSheetFactoryForImport(
  sheet: Sheet | Y.Map<any>,
): SheetFactory {
  // already Yjs → reuse directly
  if (sheet instanceof Y.Map) {
    return () => sheet;
  }

  return () => {
    const sheetMap = new Y.Map();

    Object.entries(sheet).forEach(([key, value]) => {
      if (key === 'celldata' && Array.isArray(value)) {
        const cellMap = new Y.Map();
        const normalized = normalizeCelldataArray(value);

        Object.entries(normalized).forEach(([k, v]) => {
          cellMap.set(k, v);
        });

        sheetMap.set('celldata', cellMap);
        return;
      }

      // Same shape as migrateSheetArrayIfNeeded — keyed Y.Map, drop nullish slots.
      if (key === 'calcChain' && Array.isArray(value)) {
        const calcChainMap = new Y.Map();
        const normalized = normalizeCelldataArray(value);

        Object.entries(normalized).forEach(([cellKey, cellValue]) => {
          calcChainMap.set(cellKey, cellValue);
        });

        sheetMap.set('calcChain', calcChainMap);
        return;
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const yMap = new Y.Map();
        Object.entries(value).forEach(([k, v]) => yMap.set(k, v));
        sheetMap.set(key, yMap);
        return;
      }

      sheetMap.set(key, value);
    });

    return sheetMap;
  };
}
