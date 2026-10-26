import * as Y from "yjs";
import _ from "lodash";
import { Sheet } from "@sheet-engine/react";
import { Cell } from "../../sheet-engine/core/types";
import { current, isDraft } from "immer";
import {
  celldataEntryEqual,
  shouldPersistCelldataCell,
} from "../../sheet-engine/core/utils/cell-persist-utils";
import {
  migrateFormatOnlyCellIntoRanges,
  punchHoleInCellFormatRanges,
  rangesEqual as cellFormatRangesEqual,
  type CellFormatRange,
} from "../../sheet-engine/core/utils/range-format";
import { expandSheetDataVerification } from "./import-compaction";

export type SheetChangePath = {
  sheetId: string;
  path: string[]; // ['name'], ['config', 'merge'], ['celldata']
  key?: string; // 👈 only for celldata
  value: any;
  type?: "update" | "delete";
  /**
   * Compaction deletes planned earlier may race with edits across idle chunks.
   * When set, skip the delete if the live celldata entry is now persistable.
   * Do not set on intentional clears — those must always remove the key.
   */
  skipIfPersistable?: boolean;
};

/**
 * Ensure sheet.config is a Y.Map. Pre-PR / legacy docs often store config as a
 * plain object; replacing it with an empty Y.Map would drop merge, borders,
 * rowlen, etc. Copy existing keys when upgrading.
 */
function ensureConfigYMap(sheet: Y.Map<any>): Y.Map<any> {
  const existing = sheet.get("config");
  if (existing instanceof Y.Map) return existing;

  const configMap = new Y.Map();
  if (
    existing &&
    typeof existing === "object" &&
    !safeIsArray(existing)
  ) {
    Object.entries(existing as Record<string, unknown>).forEach(([k, v]) => {
      configMap.set(k, v);
    });
  }
  sheet.set("config", configMap);
  return configMap;
}

function cloneForYjs<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return deepCloneSafe(value);
  }
}

function safeIsArray(value: unknown): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function deepCloneSafe<T>(value: T): T {
  const seen = new WeakMap<object, any>();

  const walk = (input: any): any => {
    if (input === null || typeof input !== "object") return input;

    if (seen.has(input)) return seen.get(input);

    if (safeIsArray(input)) {
      const arr: any[] = [];
      seen.set(input, arr);
      let len = 0;
      try {
        len = Number((input as any).length) || 0;
      } catch {
        return arr;
      }
      for (let i = 0; i < len; i += 1) {
        try {
          arr.push(walk((input as any)[i]));
        } catch {
          arr.push(null);
        }
      }
      return arr;
    }

    const out: Record<string, any> = {};
    seen.set(input, out);
    let keys: (string | symbol)[] = [];
    try {
      keys = Reflect.ownKeys(input);
    } catch {
      return out;
    }
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (typeof k !== "string") continue;
      try {
        out[k] = walk((input as any)[k]);
      } catch {
        out[k] = null;
      }
    }
    return out;
  };

  return walk(value) as T;
}

/**
 * Convert draft/proxy-ish values to plain data for Yjs.
 * Fast path: primitives and non-draft objects are returned as-is.
 */
function toPlain<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    if (isDraft(value)) {
      return current(value) as T;
    }
  } catch {
    // Proxy/revoked proxy can throw during draft detection; force deep-plain fallback.
    return cloneForYjs(value);
  }
  // Keep low-memory fast path for plain non-draft objects.
  // But revoked proxies can still throw when Yjs introspects them (e.g. GetPrototypeOf / isArray).
  try {
    Object.getPrototypeOf(value);
    return value;
  } catch {
    return cloneForYjs(value);
  }
}

function normalizeForYjs<T>(value: T): T {
  const plainValue = toPlain(value);
  if (plainValue === null || typeof plainValue !== "object") {
    return plainValue;
  }
  return cloneForYjs(plainValue);
}

function setMapValueSafe(
  target: Y.Map<any>,
  key: string,
  value: any,
  options?: { skipIfEqual?: boolean },
) {
  const normalizedValue = normalizeForYjs(value);
  if (options?.skipIfEqual) {
    const existing = target.get(key);
    if (celldataEntryEqual(existing, normalizedValue)) {
      return false;
    }
    if (_.isEqual(existing, normalizedValue)) {
      return false;
    }
  }
  try {
    target.set(key, normalizedValue);
  } catch {
    target.set(key, cloneForYjs(normalizedValue));
  }
  return true;
}

const getSheetId = (sheet: Y.Map<any> | Record<string, any>) => {
  if (sheet instanceof Y.Map) return sheet.get("id");
  return (sheet as Record<string, any>)?.id;
};

export const updateYdocSheetData = (
  ydoc: Y.Doc | null,
  dsheetId: string,
  changes: SheetChangePath[],
  handleContentPortal: any,
  onCellFormatRangesCommitted?: (
    commits: Array<{ sheetId: string; ranges: CellFormatRange[] }>,
  ) => void,
  /** Transaction origin; omit for user edits. */
  origin?: unknown,
) => {
  if (!ydoc || !changes.length) return;

  const sheetArray = ydoc.getArray<any>(dsheetId);
  const committedFormatRanges = new Map<string, CellFormatRange[]>();

  ydoc.transact(() => {
    const allSheets = sheetArray.toArray();
    const sheetById = new Map<string, Y.Map<any>>();
    for (let i = 0; i < allSheets.length; i += 1) {
      const s = allSheets[i];
      if (!(s instanceof Y.Map)) continue;
      const id = s.get("id");
      if (typeof id === "string" && !sheetById.has(id)) {
        sheetById.set(id, s);
      }
    }

    // Batch range mutations per sheet so N format-only deletes in one call
    // only write cellFormatRanges once (and merge adjacent 1x1s via normalize).
    const pendingFormatRanges = new Map<string, CellFormatRange[]>();
    const touchedFormatRangeSheets = new Set<string>();

    const noteCommittedRanges = (
      sheetId: string,
      ranges: CellFormatRange[],
    ) => {
      committedFormatRanges.set(sheetId, ranges);
    };

    const getWorkingFormatRanges = (sheet: Y.Map<any>, sheetId: string) => {
      const cached = pendingFormatRanges.get(sheetId);
      if (cached) return cached;
      const configMap = ensureConfigYMap(sheet);
      const existing = configMap.get("cellFormatRanges");
      const working = Array.isArray(existing) ? existing : [];
      pendingFormatRanges.set(sheetId, working);
      return working;
    };

    const setWorkingFormatRanges = (
      sheetId: string,
      ranges: CellFormatRange[],
    ) => {
      pendingFormatRanges.set(sheetId, ranges);
      touchedFormatRangeSheets.add(sheetId);
    };

    const migrateFormatOnlyToRanges = (
      sheet: Y.Map<any>,
      sheetId: string,
      r: number,
      c: number,
      cell: unknown,
    ) => {
      const working = getWorkingFormatRanges(sheet, sheetId);
      const { ranges, changed } = migrateFormatOnlyCellIntoRanges(
        working,
        r,
        c,
        cell as Cell | string | number | boolean | null | undefined,
      );
      if (changed) setWorkingFormatRanges(sheetId, ranges);
    };

    const cellFromCelldataEntry = (entry: unknown) => {
      if (entry == null || typeof entry !== "object") return entry;
      if ("v" in (entry as Record<string, unknown>)) {
        return (entry as { v?: unknown }).v;
      }
      return entry;
    };

    const parseCellKey = (cellKey: string) => {
      const sep = cellKey.lastIndexOf("_");
      if (sep <= 0) return null;
      const r = Number(cellKey.slice(0, sep));
      const c = Number(cellKey.slice(sep + 1));
      if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
      return { r, c };
    };

    changes.forEach(({ sheetId, path, key, value, type, skipIfPersistable }) => {
      const sheet = sheetById.get(sheetId);
      if (!sheet) return;

      // Sheet fields stored as Y.Map use path + key for granular updates
      // celldata
      if (path.length === 1 && path[0] === "celldata" && key) {
        let cellMap = sheet.get("celldata");
        if (!(cellMap instanceof Y.Map)) {
          cellMap = new Y.Map();
          sheet.set("celldata", cellMap);
        }

        if (type === "delete") {
          const currentCell = cellFromCelldataEntry(cellMap.get(key));
          // Stale compaction plan: cell gained real content since planning.
          if (
            skipIfPersistable &&
            shouldPersistCelldataCell(
              currentCell as Cell | string | number | boolean | null,
            )
          ) {
            return;
          }
          // Compaction / explicit delete: if the existing entry is format-only,
          // restore style into ranges before dropping celldata.
          const coords = parseCellKey(key);
          if (coords) {
            migrateFormatOnlyToRanges(
              sheet,
              sheetId,
              coords.r,
              coords.c,
              currentCell,
            );
          }
          cellMap.delete(key);
        } else if (
          shouldPersistCelldataCell(
            (value as { v?: unknown })?.v as
              | Cell
              | string
              | number
              | boolean
              | null,
          )
        ) {
          setMapValueSafe(cellMap, key, value, { skipIfEqual: true });

          const entry = normalizeForYjs(value) as {
            r?: number;
            c?: number;
            v?: unknown;
          };
          if (
            typeof entry?.r === "number" &&
            typeof entry?.c === "number" &&
            shouldPersistCelldataCell(
              entry.v as Cell | string | number | boolean | null,
            )
          ) {
            const working = getWorkingFormatRanges(sheet, sheetId);
            const punched = punchHoleInCellFormatRanges(
              working,
              entry.r,
              entry.c,
            );
            if (!cellFormatRangesEqual(working, punched)) {
              setWorkingFormatRanges(sheetId, punched);
            }
          }
        } else {
          // Content left but style remains: reverse of punch-hole.
          const entry = normalizeForYjs(value) as {
            r?: number;
            c?: number;
            v?: unknown;
          };
          const r =
            typeof entry?.r === "number" ? entry.r : parseCellKey(key)?.r;
          const c =
            typeof entry?.c === "number" ? entry.c : parseCellKey(key)?.c;
          if (typeof r === "number" && typeof c === "number") {
            migrateFormatOnlyToRanges(sheet, sheetId, r, c, entry?.v);
          }
          cellMap.delete(key);
        }
        return;
      }

      // calcChain
      if (path.length === 1 && path[0] === "calcChain" && key) {
        let cellMap = sheet.get("calcChain");
        if (!(cellMap instanceof Y.Map)) {
          cellMap = new Y.Map();
          sheet.set("calcChain", cellMap);
        }

        if (type === "delete") {
          cellMap.delete(key);
          return;
        }

        const entry = value?.v;
        if (
          entry == null ||
          typeof entry.r !== "number" ||
          typeof entry.c !== "number"
        ) {
          return;
        }
        setMapValueSafe(cellMap, key, entry);
        return;
      }

      // dataBlockCalcFunction
      if (path.length === 1 && path[0] === "dataBlockCalcFunction" && key) {
        let cellMap = sheet.get("dataBlockCalcFunction");
        if (!(cellMap instanceof Y.Map)) {
          cellMap = new Y.Map();
          sheet.set("dataBlockCalcFunction", cellMap);
        }

        type === "delete"
          ? cellMap.delete(key)
          : setMapValueSafe(cellMap, key, value);
        return;
      }

      // liveQueryList
      if (path.length === 1 && path[0] === "liveQueryList" && key) {
        let cellMap = sheet.get("liveQueryList");
        if (!(cellMap instanceof Y.Map)) {
          cellMap = new Y.Map();
          sheet.set("liveQueryList", cellMap);
        }

        type === "delete"
          ? cellMap.delete(key)
          : setMapValueSafe(cellMap, key, value);
        return;
      }

      // dataVerification
      if (path.length === 1 && path[0] === "dataVerification" && key) {
        let cellMap = sheet.get("dataVerification");
        if (!(cellMap instanceof Y.Map)) {
          cellMap = new Y.Map();
          sheet.set("dataVerification", cellMap);
        }

        type === "delete"
          ? cellMap.delete(key)
          : setMapValueSafe(cellMap, key, value);
        return;
      }

      // hyperlink
      if (path.length === 1 && path[0] === "hyperlink" && key) {
        let cellMap = sheet.get("hyperlink");
        if (!(cellMap instanceof Y.Map)) {
          cellMap = new Y.Map();
          sheet.set("hyperlink", cellMap);
        }

        type === "delete"
          ? cellMap.delete(key)
          : setMapValueSafe(cellMap, key, value);
        return;
      }

      // conditionRules
      if (path.length === 1 && path[0] === "conditionRules" && key) {
        let cellMap = sheet.get("conditionRules");
        if (!(cellMap instanceof Y.Map)) {
          cellMap = new Y.Map();
          sheet.set("conditionRules", cellMap);
        }

        type === "delete"
          ? cellMap.delete(key)
          : setMapValueSafe(cellMap, key, value);
        return;
      }

      // filter_select
      if (path.length === 1 && path[0] === "filter_select" && key) {
        let cellMap = sheet.get("filter_select");
        if (!(cellMap instanceof Y.Map)) {
          cellMap = new Y.Map();
          sheet.set("filter_select", cellMap);
        }

        type === "delete"
          ? cellMap.delete(key)
          : setMapValueSafe(cellMap, key, value);
        return;
      }

      // filter (object) - replace entire object payload
      if (path.length === 1 && path[0] === "filter") {
        let filterMap = sheet.get("filter");
        if (!(filterMap instanceof Y.Map)) {
          filterMap = new Y.Map();
          sheet.set("filter", filterMap);
        }

        // clear existing keys
        (filterMap as Y.Map<any>).forEach((_v: any, k: string) => {
          filterMap.delete(k);
        });

        if (type === "delete") return;

        const plainValue = toPlain(value) || {};
        if (
          plainValue &&
          typeof plainValue === "object" &&
          !safeIsArray(plainValue)
        ) {
          Object.entries(plainValue).forEach(([k, v]) => {
            setMapValueSafe(filterMap as Y.Map<any>, k, v);
          });
        }
        return;
      }

      // luckysheet_conditionformat_save (array) - replace entire array payload
      if (path.length === 1 && path[0] === "luckysheet_conditionformat_save") {
        let cellArray = sheet.get("luckysheet_conditionformat_save");
        if (!(cellArray instanceof Y.Array)) {
          cellArray = new Y.Array();
          sheet.set("luckysheet_conditionformat_save", cellArray);
        }

        cellArray.delete(0, cellArray.length);
        if (type === "delete") return;

        const plainValue = normalizeForYjs(value);
        const payload = safeIsArray(plainValue) ? plainValue : [plainValue];
        try {
          cellArray.insert(0, payload);
        } catch {
          cellArray.insert(0, cloneForYjs(payload));
        }
        return;
      }

      // config sub-keys (borderInfo, merge, rowlen, …) stored as Y.Map on sheet
      if (path.length === 2 && path[0] === "config") {
        const configKey = path[1];
        const configMap = ensureConfigYMap(sheet);

        if (type === "delete") {
          configMap.delete(configKey);
          if (configKey === "cellFormatRanges") {
            pendingFormatRanges.set(sheetId, []);
            touchedFormatRangeSheets.delete(sheetId);
            noteCommittedRanges(sheetId, []);
          }
        } else {
          setMapValueSafe(configMap, configKey, value, { skipIfEqual: true });
          if (configKey === "cellFormatRanges") {
            const normalized = normalizeForYjs(value);
            const ranges = Array.isArray(normalized) ? normalized : [];
            pendingFormatRanges.set(sheetId, ranges);
            // Already written to Yjs; don't flush a stale pending copy later.
            touchedFormatRangeSheets.delete(sheetId);
            noteCommittedRanges(sheetId, ranges);
          }
        }
        return;
      }

      /**
       * ===== NORMAL PATH WALK =====
       */

      let target: any = sheet;

      for (let i = 0; i < path.length - 1; i++) {
        const p = path[i];
        let next = target.get(p);

        if (!(next instanceof Y.Map)) {
          // Upgrading sheet.config must preserve plain-object keys (merge, etc.).
          if (p === "config" && target === sheet) {
            next = ensureConfigYMap(sheet);
          } else {
            next = new Y.Map();
            target.set(p, next);
          }
        }
        target = next;
      }

      setMapValueSafe(target, path[path.length - 1], value, {
        skipIfEqual: true,
      });
    });

    touchedFormatRangeSheets.forEach((sheetId) => {
      const sheet = sheetById.get(sheetId);
      if (!sheet) return;
      const configMap = ensureConfigYMap(sheet);
      const ranges = pendingFormatRanges.get(sheetId) ?? [];
      setMapValueSafe(configMap, "cellFormatRanges", ranges, {
        skipIfEqual: true,
      });
      noteCommittedRanges(sheetId, ranges);
    });

    // Keep a single active sheet by order after applying updates
    for (let i = 0; i < allSheets.length; i += 1) {
      const sheet = allSheets[i];
      if (!(sheet instanceof Y.Map)) continue;
      setMapValueSafe(sheet, "status", sheet.get("order") === 0 ? 1 : 0, {
        skipIfEqual: true,
      });
    }
  }, origin);

  if (committedFormatRanges.size > 0 && onCellFormatRangesCommitted) {
    onCellFormatRangesCommitted(
      Array.from(committedFormatRanges, ([sheetId, ranges]) => ({
        sheetId,
        ranges,
      })),
    );
  }

  if (handleContentPortal) {
    handleContentPortal();
  }
};

/**
 * Plain snapshot of the sheet array. The returned arrays are new, but cell
 * objects and other plain values are the Yjs content itself (Y.Map#toJSON
 * returns stored references): treat them as shared and read-only. Writing
 * into them changes later encodes of the doc without sending an update.
 */
/** Convert one stored sheet key to its plain snapshot value on `obj`. */
function assignPlainSheetKey(obj: any, key: string, value: any) {
    // celldata: Y.Map → plain object for Fortune sheet format
    if (key === "celldata" && value instanceof Y.Map) {
      obj.celldata = value.toJSON();
      return;
    }

    if (key === "calcChain" && value instanceof Y.Map) {
      const calcChain = value.toJSON();
      if (Object.keys(calcChain).length === 0) return;
      obj.calcChain = calcChain;
      return;
    }

    if (
      key === "luckysheet_conditionformat_save" &&
      value instanceof Y.Array
    ) {
      const conditionFormatRules = value.toJSON();
      if (conditionFormatRules.length === 0) return;
      obj.luckysheet_conditionformat_save = conditionFormatRules;
      return;
    }

    if (key === "dataBlockCalcFunction" && value instanceof Y.Map) {
      const dataBlockCalcFunction = value.toJSON();
      if (Object.keys(dataBlockCalcFunction).length === 0) return;
      obj.dataBlockCalcFunction = dataBlockCalcFunction;
      return;
    }

    if (key === "liveQueryList" && value instanceof Y.Map) {
      const liveQueryList = value.toJSON();
      if (Object.keys(liveQueryList).length === 0) return;
      obj.liveQueryList = liveQueryList;
      return;
    }

    if (key === "dataVerification" && value instanceof Y.Map) {
      const dataVerification = value.toJSON();
      if (Object.keys(dataVerification).length === 0) return;
      obj.dataVerification = dataVerification;
      return;
    }

    if (key === "hyperlink" && value instanceof Y.Map) {
      const hyperlink = value.toJSON();
      if (Object.keys(hyperlink).length === 0) return;
      obj.hyperlink = hyperlink;
      return;
    }

    if (key === "conditionRules" && value instanceof Y.Map) {
      const conditionRules = value.toJSON();
      if (Object.keys(conditionRules).length === 0) return;
      obj.conditionRules = conditionRules;
      return;
    }

    if (key === "filter_select" && value instanceof Y.Map) {
      const filterSelect = value.toJSON();
      if (Object.keys(filterSelect).length === 0) return;
      obj.filter_select = filterSelect;
      return;
    }

    if (key === "filter" && value instanceof Y.Map) {
      const filter = value.toJSON();
      if (Object.keys(filter).length === 0) return;
      obj.filter = filter;
      return;
    }

    if (value instanceof Y.Map || value instanceof Y.Array) {
      obj[key] = value.toJSON();
    } else {
      obj[key] = value;
    }
}

/** Shape celldata/calcChain as arrays and expand compacted dataVerification. */
function finishPlainSheet(obj: any) {
  // Ensure celldata/calcChain are arrays (legacy may have them as objects keyed by r_c)
  let cellDataArray;
  cellDataArray = obj.celldata ? Object.values(obj.celldata) : [];
  obj.celldata = cellDataArray;

  // Drop nullish/malformed slots so formula/flowdata consumers never see them.
  const calcChainArray = obj.calcChain
    ? Object.values(obj.calcChain).filter(
        (entry: any) =>
          entry != null &&
          typeof entry.r === 'number' &&
          typeof entry.c === 'number',
      )
    : [];
  obj.calcChain = calcChainArray;
  expandSheetDataVerification(obj);
}

const iterateSheetEntries = (
  sheetMap: unknown,
  fn: (value: any, key: string) => void,
) => {
  // Handle legacy plain-object sheets (e.g. before migration) so we never call .forEach on a non-Map
  if (sheetMap instanceof Y.Map) {
    sheetMap.forEach(fn);
    return;
  }
  Object.entries((sheetMap ?? {}) as Record<string, any>).forEach(
    ([key, value]) => fn(value, key),
  );
};

export function ySheetArrayToPlain(
  // @ts-ignore
  sheetArray: Y.Array<Y.Map>,
): Sheet[] {
  return sheetArray.toArray().map((sheetMap) => {
    const obj: any = {};
    iterateSheetEntries(sheetMap, (value, key) =>
      assignPlainSheetKey(obj, key, value),
    );
    finishPlainSheet(obj);
    return obj as Sheet;
  });
}

const readSheetKey = (sheetMap: unknown, key: string) =>
  sheetMap instanceof Y.Map
    ? sheetMap.get(key)
    : (sheetMap as Record<string, any> | null)?.[key];

/**
 * One field of one sheet, with the same value ySheetArrayToPlain gives for
 * it, without converting the rest of the workbook (A3). Shared, read-only
 * semantics as ySheetArrayToPlain.
 */
export function readYdocSheetField(
  ydoc: Y.Doc,
  dsheetId: string,
  sheetId: string,
  field: string,
): any {
  const sheetMap = ydoc
    .getArray<unknown>(dsheetId)
    .toArray()
    .find((sheet) => readSheetKey(sheet, "id") === sheetId);
  if (sheetMap == null) return undefined;
  const obj: any = {};
  const keys =
    field === "dataVerification" ? [field, "dataVerificationDefs"] : [field];
  keys.forEach((key) => {
    const value = readSheetKey(sheetMap, key);
    if (value !== undefined) assignPlainSheetKey(obj, key, value);
  });
  finishPlainSheet(obj);
  return obj[field];
}
