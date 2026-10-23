import _ from 'lodash';
import { isDraft } from 'immer';
import { Context, getFlowdata } from '../context';
import { CellMatrix, Sheet } from '../types';
import { getSheetIndex } from '../utils';
import { getCellValue, getRangeByTxt } from './cell';
import { datenum_local, genarate, is_date } from './format';
import { execfunction, functionCopy } from './formula';
import { checkProtectionFormatCells } from './protection';
import { isRealNull, isNumericCellType } from './validation';

// Helper function to check if a value contains alphabetic characters
function hasAlphabeticChars(value: any): boolean {
  return /[a-zA-Z]/.test(String(value));
}

// Helper function to perform comparison that handles both numbers and strings
function compareGreaterThan(
  cellValue: any,
  conditionValue: any,
  symbol: any,
): boolean {
  const cellStr = String(cellValue);
  const conditionStr = String(conditionValue);

  // If either value contains alphabetic characters, use string comparison
  if (hasAlphabeticChars(cellValue) || hasAlphabeticChars(conditionValue)) {
    if (symbol === '>=') {
      return cellStr.localeCompare(conditionStr) >= 0;
    }
    return cellStr.localeCompare(conditionStr) > 0;
  }

  // If both are numeric, use numeric comparison
  const cellNum = Number(cellValue);
  const conditionNum = Number(conditionValue);

  if (
    !Number.isNaN(cellNum) &&
    !Number.isNaN(conditionNum) &&
    symbol === '>='
  ) {
    return cellNum >= conditionNum;
  }

  // Check if both conversions resulted in valid numbers
  if (!Number.isNaN(cellNum) && !Number.isNaN(conditionNum) && symbol === '>') {
    return cellNum > conditionNum;
  }

  // Fallback to string comparison if number conversion fails
  if (symbol === '>=') {
    return cellStr.localeCompare(conditionStr) >= 0;
  }
  return cellStr.localeCompare(conditionStr) > 0;
}

// Helper function for less than comparison
function compareLessThan(
  cellValue: any,
  conditionValue: any,
  symbol: any,
): boolean {
  const cellStr = String(cellValue);
  const conditionStr = String(conditionValue);

  // If either value contains alphabetic characters, use string comparison
  if (hasAlphabeticChars(cellValue) || hasAlphabeticChars(conditionValue)) {
    if (symbol === '<=') {
      return cellStr.localeCompare(conditionStr) <= 0;
    }
    return cellStr.localeCompare(conditionStr) < 0;
  }

  // If both are numeric, use numeric comparison
  const cellNum = Number(cellValue);
  const conditionNum = Number(conditionValue);

  if (
    !Number.isNaN(cellNum) &&
    !Number.isNaN(conditionNum) &&
    symbol === '<='
  ) {
    return cellNum <= conditionNum;
  }

  // Check if both conversions resulted in valid numbers
  if (!Number.isNaN(cellNum) && !Number.isNaN(conditionNum)) {
    return cellNum < conditionNum;
  }

  // Fallback to string comparison if number conversion fails
  if (symbol === '<=') {
    return cellStr.localeCompare(conditionStr) <= 0;
  }
  return cellStr.localeCompare(conditionStr) < 0;
}

// Helper function for between comparison with string support
function compareBetween(cellValue: any, value1: any, value2: any): boolean {
  const cellStr = String(cellValue);
  const val1Str = String(value1);
  const val2Str = String(value2);

  // Determine which value is "greater" and "smaller" for between comparison
  let smallerValue;
  let biggerValue;

  if (
    hasAlphabeticChars(value1) ||
    hasAlphabeticChars(value2) ||
    hasAlphabeticChars(cellValue)
  ) {
    // Use string comparison
    if (val1Str.localeCompare(val2Str) > 0) {
      biggerValue = val1Str;
      smallerValue = val2Str;
    } else {
      biggerValue = val2Str;
      smallerValue = val1Str;
    }

    return (
      cellStr.localeCompare(smallerValue) >= 0 &&
      cellStr.localeCompare(biggerValue) <= 0
    );
  }
  // Use numeric comparison
  const cellNum = Number(cellValue);
  const val1Num = Number(value1);
  const val2Num = Number(value2);

  if (
    !Number.isNaN(cellNum) &&
    !Number.isNaN(val1Num) &&
    !Number.isNaN(val2Num)
  ) {
    const smallerNum = Math.min(val1Num, val2Num);
    const biggerNum = Math.max(val1Num, val2Num);
    return cellNum >= smallerNum && cellNum <= biggerNum;
  }

  // Fallback to string comparison
  if (val1Str.localeCompare(val2Str) > 0) {
    biggerValue = val1Str;
    smallerValue = val2Str;
  } else {
    biggerValue = val2Str;
    smallerValue = val1Str;
  }

  return (
    cellStr.localeCompare(smallerValue) >= 0 &&
    cellStr.localeCompare(biggerValue) <= 0
  );
}

function conditionFormatDateSerial(raw: unknown): number | null {
  if (raw == null || String(raw).trim() === '') return null;
  const g = genarate(String(raw).trim());
  if (!g || g[2] == null) return null;
  const n = Number(g[2]);
  return Number.isNaN(n) ? null : n;
}

/** Default text format recorded alongside preset / value for CF date rules. */
export const CF_DATE_DEFAULT_FORMAT = 'DD/MM/YYYY';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function startOfLocalTodayDate(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function addCalendarDays(d: Date, days: number): Date {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + days);
  return x;
}

function formatLocalDateDdMmYyyy(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function legacyIsoYmdToDdMmYyyy(iso: string): string {
  const m = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  return `${pad2(day)}/${pad2(mo)}/${y}`;
}

function serialToLocalCalendarDateApprox(serial: number): Date {
  const z = Math.floor(serial);
  const dnthreshUtc = Date.UTC(1899, 11, 31, 0, 0, 0);
  const ms = z * 86400000 + dnthreshUtc;
  const u = new Date(ms);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
}

/** Parse strict DD/MM/YYYY to Excel serial (local calendar day). */
export function parseDdMmYyyyToSerial(s: string): number | null {
  const t = s.trim();
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const dd = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10) - 1;
  const yyyy = parseInt(m[3], 10);
  if (mm < 0 || mm > 11 || dd < 1 || dd > 31) return null;
  const d = new Date(yyyy, mm, dd);
  if (d.getFullYear() !== yyyy || d.getMonth() !== mm || d.getDate() !== dd) {
    return null;
  }
  return datenum_local(d, 0);
}

/** Plain text from a cell for CF rules (inlineStr runs, m, or literal v). */
function getCfPlainTextFromCell(cell: any, trim = false): string {
  if (!cell) return '';
  if (cell.ct?.t === 'inlineStr' && Array.isArray(cell.ct?.s)) {
    const text = cell.ct.s
      .map((seg: any) => (seg?.v != null ? String(seg.v) : ''))
      .join('');
    return trim ? text.trim() : text;
  }
  if (cell.m != null && String(cell.m).trim() !== '') {
    const m = String(cell.m);
    return trim ? m.trim() : m;
  }
  if (
    cell.v != null &&
    typeof cell.v === 'string' &&
    !String(cell.v).startsWith('=')
  ) {
    const v = String(cell.v);
    return trim ? v.trim() : v;
  }
  if (cell.v != null && !isRealNull(cell.v) && typeof cell.v !== 'string') {
    return String(cell.v);
  }
  return '';
}

function isCfCellEmpty(cell: any): boolean {
  if (_.isNil(cell)) return true;
  if (getCfPlainTextFromCell(cell, true) !== '') return false;
  if (!_.isNil(cell.v) && !isRealNull(cell.v)) return false;
  return true;
}

/** Visible / editable plain text for date CF parsing (inlineStr + m + literal string `v`). */
function getCfDatePlainTextFromCell(cell: any): string {
  return getCfPlainTextFromCell(cell, true);
}

/**
 * Calendar day serial for date conditional-format rules.
 * Uses `ct.t === 'd'` when set, DD/MM/YYYY text (matches CF saved format), genarate-parsable strings,
 * and numeric cells with date number-format — not only `ct.t === 'd'` (typed dates can stay text/General).
 */
function resolveCellDaySerialForDateCf(cell: any): number | null {
  if (!cell) return null;
  const vRaw = cell.v;

  if (cell.ct?.t === 'd' && typeof vRaw === 'number' && Number.isFinite(vRaw)) {
    return Math.floor(vRaw);
  }

  const text = getCfDatePlainTextFromCell(cell);
  if (text && !text.startsWith('=')) {
    const ddmm = parseDdMmYyyyToSerial(text);
    if (ddmm != null) return Math.floor(ddmm);
    const g = conditionFormatDateSerial(text);
    if (g != null) return Math.floor(g);
  }

  if (
    typeof vRaw === 'number' &&
    Number.isFinite(vRaw) &&
    cell.ct?.fa &&
    is_date(cell.ct.fa)
  ) {
    return Math.floor(vRaw);
  }

  return null;
}

function getLocalTodaySerial(): number {
  return Math.floor(datenum_local(startOfLocalTodayDate(), 0));
}

/** Human-readable snapshot for the given preset (evaluation still uses preset id at compute time). */
export function formatCfDatePresetSnapshot(preset: string): string {
  const t = startOfLocalTodayDate();
  switch (preset) {
    case 'today':
      return formatLocalDateDdMmYyyy(t);
    case 'tomorrow':
      return formatLocalDateDdMmYyyy(addCalendarDays(t, 1));
    case 'yesterday':
      return formatLocalDateDdMmYyyy(addCalendarDays(t, -1));
    case 'pastWeek':
    case 'pastMonth':
    case 'pastYear':
      return formatLocalDateDdMmYyyy(t);
    case 'exact':
      return '';
    default:
      return formatLocalDateDdMmYyyy(t);
  }
}

export function parseCfDateConditionForUi(cv: any[] | undefined): {
  preset: string;
  snapshotOrExact: string;
  format: string;
} {
  const fmt = CF_DATE_DEFAULT_FORMAT;
  if (!cv || cv.length === 0) {
    return {
      preset: 'today',
      snapshotOrExact: formatCfDatePresetSnapshot('today'),
      format: fmt,
    };
  }
  const v0 = String(cv[0] ?? '');
  if (v0.startsWith('preset:')) {
    const p = v0.slice(7) || 'today';
    return {
      preset: p,
      snapshotOrExact: String(cv[1] ?? ''),
      format: String(cv[2] ?? fmt) || fmt,
    };
  }
  const leg = v0.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(leg)) {
    return {
      preset: 'exact',
      snapshotOrExact: legacyIsoYmdToDdMmYyyy(leg),
      format: fmt,
    };
  }
  const serial = conditionFormatDateSerial(leg);
  if (serial != null) {
    return {
      preset: 'exact',
      snapshotOrExact: formatLocalDateDdMmYyyy(
        serialToLocalCalendarDateApprox(serial),
      ),
      format: fmt,
    };
  }
  return { preset: 'exact', snapshotOrExact: leg, format: fmt };
}

function matchesCfDateIsOrBefore(
  cellVal: number,
  conditionName: 'dateIs' | 'dateBefore',
  cva: any[],
): boolean {
  if (!cva?.length) return false;
  const v0 = String(cva[0] ?? '');
  const cellDay = Math.floor(cellVal);

  if (!v0.startsWith('preset:')) {
    const ref = conditionFormatDateSerial(v0);
    if (ref == null) return false;
    const refDay = Math.floor(ref);
    if (conditionName === 'dateIs') return cellDay === refDay;
    return cellDay < refDay;
  }

  const preset = v0.slice(7);
  const exactStr = String(cva[1] ?? '');

  if (preset === 'exact') {
    const ref = parseDdMmYyyyToSerial(exactStr);
    if (ref == null) return false;
    const refDay = Math.floor(ref);
    if (conditionName === 'dateIs') return cellDay === refDay;
    return cellDay < refDay;
  }

  const todayS = getLocalTodaySerial();
  if (
    preset === 'pastWeek' ||
    preset === 'pastMonth' ||
    preset === 'pastYear'
  ) {
    let span = 6;
    if (preset === 'pastMonth') span = 29;
    if (preset === 'pastYear') span = 364;
    const lo = todayS - span;
    const hi = todayS;
    if (conditionName === 'dateIs') {
      return cellDay >= lo && cellDay <= hi;
    }
    return cellDay < lo;
  }

  let refDay: number;
  if (preset === 'today') refDay = todayS;
  else if (preset === 'tomorrow') refDay = todayS + 1;
  else if (preset === 'yesterday') refDay = todayS - 1;
  else return false;

  if (conditionName === 'dateIs') return cellDay === refDay;
  return cellDay < refDay;
}

const CF_DATE_AFTER_PRESETS = new Set([
  'today',
  'tomorrow',
  'yesterday',
  'exact',
]);

function normalizeCfConditionName(name: string): string {
  switch (name) {
    case 'containsText':
      return 'textContains';
    case 'notContainsText':
    case 'notContains':
      return 'textDoesNotContain';
    case 'beginsWith':
      return 'textStartsWith';
    case 'endsWith':
      return 'textEndsWith';
    case 'containsBlanks':
      return 'empty';
    case 'notContainsBlanks':
      return 'notEmpty';
    case 'top10Percent':
      return 'top10_percent';
    case 'last10Percent':
      return 'last10_percent';
    default:
      return name;
  }
}

function matchesCfDateAfter(cellVal: number, cva: any[]): boolean {
  if (!cva?.length) return false;
  const v0 = String(cva[0] ?? '');
  const cellDay = Math.floor(cellVal);

  if (!v0.startsWith('preset:')) {
    const ref = conditionFormatDateSerial(v0);
    if (ref == null) return false;
    return cellDay > Math.floor(ref);
  }

  const preset = v0.slice(7);
  const exactStr = String(cva[1] ?? '');

  if (preset === 'exact') {
    const ref = parseDdMmYyyyToSerial(exactStr);
    if (ref == null) return false;
    return cellDay > Math.floor(ref);
  }

  if (!CF_DATE_AFTER_PRESETS.has(preset)) {
    return false;
  }

  const todayS = getLocalTodaySerial();
  let refDay: number;
  if (preset === 'today') refDay = todayS;
  else if (preset === 'tomorrow') refDay = todayS + 1;
  else if (preset === 'yesterday') refDay = todayS - 1;
  else return false;

  return cellDay > refDay;
}

function collectPresetDateConditionValue(rules: any): string[] | null {
  const conditionName = rules.rulesType;
  if (conditionName === 'dateAfter') {
    let preset = rules.datePreset || 'today';
    if (!CF_DATE_AFTER_PRESETS.has(preset)) preset = 'today';
    const fmt = rules.dateFormat || CF_DATE_DEFAULT_FORMAT;
    let snap = String(rules.dateValue ?? '').trim();
    if (preset !== 'exact') {
      snap = snap || formatCfDatePresetSnapshot(preset);
    }
    return [`preset:${preset}`, snap, fmt];
  }
  if (conditionName !== 'dateIs' && conditionName !== 'dateBefore') {
    return null;
  }
  const preset = rules.datePreset || 'today';
  const fmt = rules.dateFormat || CF_DATE_DEFAULT_FORMAT;
  let snap = String(rules.dateValue ?? '').trim();
  if (preset !== 'exact') {
    snap = snap || formatCfDatePresetSnapshot(preset);
  }
  return [`preset:${preset}`, snap, fmt];
}

// 得到历史的规则
export function getHistoryRules(fileH: Sheet[]) {
  const historyRules = [];
  for (let h = 0; h < fileH.length; h += 1) {
    historyRules.push({
      sheetIndex: h,
      luckysheet_conditionformat_save: fileH[h].luckysheet_conditionformat_save,
    });
  }
  return historyRules;
}

// 得到当前的规则
export function getCurrentRules(fileC: Sheet[]) {
  const currentRules = [];
  for (let c = 0; c < fileC.length; c += 1) {
    currentRules.push({
      sheetIndex: c,
      luckysheet_conditionformat_save: fileC[c].luckysheet_conditionformat_save,
    });
  }
  return currentRules;
}

// 设置规则
export function setConditionRules(
  ctx: Context,
  protection: any,
  generalDialog: any,
  conditionformat: any,
  rules: any,
  edit?: boolean,
  editKey?: string,
) {
  if (!checkProtectionFormatCells(ctx)) {
    return;
  }

  // 条件名称
  const conditionName = rules.rulesType;

  // 条件单元格
  const conditionRange = [];

  // 条件值
  const conditionValue = [];

  if (
    conditionName === 'greaterThan' ||
    conditionName === 'greaterThanOrEqual' ||
    conditionName === 'lessThan' ||
    conditionName === 'lessThanOrEqual' ||
    conditionName === 'equal' ||
    conditionName === 'notEqual' ||
    conditionName === 'textContains' ||
    conditionName === 'textDoesNotContain' ||
    conditionName === 'textStartsWith' ||
    conditionName === 'textEndsWith' ||
    conditionName === 'textExactly'
  ) {
    let v = rules.rulesValue;
    const rangeArr = getRangeByTxt(ctx, v);
    // 判断条件值是不是选区
    if (rangeArr.length > 1) {
      const r1 = rangeArr[0].row[0];
      const r2 = rangeArr[0].row[1];
      const c1 = rangeArr[0].column[0];
      const c2 = rangeArr[0].column[1];
      if (r1 === r2 && c1 === c2) {
        const d = getFlowdata(ctx);
        if (!d) return;
        v = getCellValue(r1, c1, d);
        conditionRange.push({
          row: rangeArr[0].row,
          column: rangeArr[0].column,
        });
        conditionValue.push(v);
      } else {
        ctx.warnDialog = conditionformat.onlySingleCell;
      }
    } else if (rangeArr.length === 0) {
      if (_.isNaN(v) || v === '') {
        if (v === '') {
          ctx.warnDialog = 'Value is required';
          return;
        }
        ctx.warnDialog = conditionformat.conditionValueCanOnly;
        return;
      }
      conditionValue.push(v);
    }
  } else if (conditionName === 'between' || conditionName === 'notBetween') {
    let v1 = rules.betweenValue.value1;
    let v2 = rules.betweenValue.value2;

    // 值转为数组坐标
    const rangeArr1 = getRangeByTxt(ctx, v1);
    if (rangeArr1.length > 1) {
      ctx.warnDialog = conditionformat.onlySingleCell;
      return;
    }
    if (rangeArr1.length === 1) {
      const r1 = rangeArr1[0].row[0];
      const r2 = rangeArr1[0].row[1];
      const c1 = rangeArr1[0].column[0];
      const c2 = rangeArr1[0].column[1];
      if (r1 === r2 && c1 === c2) {
        const d = getFlowdata(ctx);
        if (!d) return;
        v1 = getCellValue(r1, c1, d);
        conditionRange.push({
          row: rangeArr1[0].row,
          column: rangeArr1[0].column,
        });
        conditionValue.push(v1);
      } else {
        ctx.warnDialog = conditionformat.onlySingleCell;
        return;
      }
    } else if (rangeArr1.length === 0) {
      if (_.isNaN(v1) || v1 === '') {
        ctx.warnDialog = conditionformat.conditionValueCanOnly;
        return;
      }
      conditionValue.push(v1);
    }
    const rangeArr2 = getRangeByTxt(ctx, v2);
    if (rangeArr2.length > 1) {
      ctx.warnDialog = conditionformat.onlySingleCell;
      return;
    }
    if (rangeArr2.length === 1) {
      const r1 = rangeArr2[0].row[0];
      const r2 = rangeArr2[0].row[1];
      const c1 = rangeArr2[0].column[0];
      const c2 = rangeArr2[0].column[1];
      if (r1 === r2 && c1 === c2) {
        const d = getFlowdata(ctx);
        if (!d) return;
        v2 = getCellValue(r1, c1, d);
        conditionRange.push({
          row: rangeArr2[0].row,
          column: rangeArr2[0].column,
        });
      } else {
        ctx.warnDialog = conditionformat.onlySingleCell;
        return;
      }
    } else if (rangeArr2.length === 0) {
      if (_.isNaN(v2) || v2 === '') {
        ctx.warnDialog = conditionformat.conditionValueCanOnly;
      } else {
        conditionValue.push(v2);
      }
    }
  } else if (conditionName === 'dateIs' || conditionName === 'dateBefore') {
    const preset = rules.datePreset || 'today';
    if (preset === 'exact') {
      const ex = String(rules.dateValue ?? '').trim();
      if (parseDdMmYyyyToSerial(ex) == null) {
        ctx.warnDialog =
          conditionformat.pleaseEnterDateDdMmYyyy ||
          conditionformat.pleaseSelectADate;
        return;
      }
    }
    const parts = collectPresetDateConditionValue(rules);
    if (parts) {
      conditionValue.push(parts[0], parts[1], parts[2]);
    }
  } else if (conditionName === 'dateAfter') {
    let preset = rules.datePreset || 'today';
    if (!CF_DATE_AFTER_PRESETS.has(preset)) preset = 'today';
    if (preset === 'exact') {
      const ex = String(rules.dateValue ?? '').trim();
      if (parseDdMmYyyyToSerial(ex) == null) {
        ctx.warnDialog =
          conditionformat.pleaseEnterDateDdMmYyyy ||
          conditionformat.pleaseSelectADate;
        return;
      }
    }
    const parts = collectPresetDateConditionValue(rules);
    if (parts) {
      conditionValue.push(parts[0], parts[1], parts[2]);
    }
  } else if (conditionName === 'occurrenceDate') {
    const v = rules.dateValue;
    if (!v) {
      ctx.warnDialog = conditionformat.pleaseSelectADate;
      return;
    }
    conditionValue.push(v);
  } else if (conditionName === 'duplicateValue') {
    conditionValue.push(rules.repeatValue);
  } else if (
    conditionName === 'top10' ||
    conditionName === 'top10_percent' ||
    conditionName === 'last10' ||
    conditionName === 'last10_percent'
  ) {
    const v = rules.projectValue;
    if (
      parseInt(v, 10).toString() !== v ||
      parseInt(v, 10) < 1 ||
      parseInt(v, 10) > 1000
    ) {
      ctx.warnDialog = conditionformat.pleaseEnterInteger;
      return;
    }
    conditionValue.push(v);
  } else {
    conditionValue.push(conditionName);
  }
  //  else if (conditionName === "aboveAverage") {
  //   conditionValue.push("aboveAverage");
  // } else if (conditionName === "belowAverage") {
  //   conditionValue.push("belowAverage");
  // }

  // 颜色
  let textColor = null;
  if (rules.textColor.check) {
    textColor = rules.textColor.color;
  }

  let cellColor = null;
  if (rules.cellColor.check) {
    cellColor = rules.cellColor.color;
  }

  // 获得之前的规则
  // const fileH = ctx.luckysheetfile ?? [];
  // const historyRules = getHistoryRules(fileH);

  // 构造现在的规则
  const rule = {
    type: 'default',
    cellrange: ctx.luckysheet_select_save ?? [],
    format: {
      textColor,
      cellColor,
      bold: rules?.font?.bold,
      italic: rules?.font?.italic,
      underline: rules?.font?.underline,
      strikethrough: rules?.font?.strikethrough,
    },
    conditionName,
    conditionRange,
    conditionValue,
  };
  const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
  const ruleArr =
    ctx.luckysheetfile[index].luckysheet_conditionformat_save ?? [];
  if (edit) {
    ruleArr.splice(Number(editKey), 1, rule);
  } else {
    ruleArr.push(rule);
  }

  // Update both the condition format rules and the condition rules
  ctx.luckysheetfile[index].luckysheet_conditionformat_save = ruleArr;
  ctx.luckysheetfile[index].conditionRules = {
    ...rules,
    // Ensure all required properties are present
    rulesType: rules.rulesType || '',
    rulesValue: rules.rulesValue || '',
    textColor: rules.textColor || { check: true, color: '#000000' },
    cellColor: rules.cellColor || { check: true, color: '#000000' },
    betweenValue: rules.betweenValue || { value1: '', value2: '' },
    datePreset: rules.datePreset || 'today',
    dateFormat: rules.dateFormat || CF_DATE_DEFAULT_FORMAT,
    dateValue: rules.dateValue || '',
    repeatValue: rules.repeatValue || '0',
    projectValue: rules.projectValue || '10',
  };
}

export function getColorGradation(
  color1: string,
  color2: string,
  value1: number,
  value2: number,
  value: number,
) {
  const rgb1 = color1.split(',');
  const r1 = parseInt(rgb1[0].split('(')[1], 10);
  const g1 = parseInt(rgb1[1], 10);
  const b1 = parseInt(rgb1[2].split(')')[0], 10);

  const rgb2 = color2.split(',');
  const r2 = parseInt(rgb2[0].split('(')[1], 10);
  const g2 = parseInt(rgb2[1], 10);
  const b2 = parseInt(rgb2[2].split(')')[0], 10);

  const v12 = value1 - value2;
  const v10 = value1 - value;

  const r = Math.round(r1 - ((r1 - r2) / v12) * v10);
  const g = Math.round(g1 - ((g1 - g2) / v12) * v10);
  const b = Math.round(b1 - ((b1 - b2) / v12) * v10);

  return `rgb(${r}, ${g}, ${b})`;
}

export function compute(ctx: Context, ruleArr: any, d: CellMatrix) {
  if (_.isNil(ruleArr)) {
    ruleArr = [];
  }
  // 条件计算存储 (rule order matches UI list: first matching rule wins, like Google Sheets)
  const computeMap: any = {};

  if (ruleArr.length > 0) {
    for (let i = 0; i < ruleArr.length; i += 1) {
      const { type, cellrange, format } = ruleArr[i];
      // 数据条
      if (type === 'dataBar') {
        let max = null;
        let min = null;
        for (let s = 0; s < cellrange.length; s += 1) {
          for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
            for (
              let c = cellrange[s].column[0];
              c <= cellrange[s].column[1];
              c += 1
            ) {
              if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                continue;
              }
              const cell = d[r][c];
              if (
                !_.isNil(cell) &&
                isNumericCellType(cell) &&
                _.isNil(cell.v)
              ) {
                if (_.isNil(max) || parseInt(`${cell.v}`, 10) > max) {
                  max = parseInt(`${cell.v}`, 10);
                }

                if (_.isNil(min) || parseInt(`${cell.v}`, 10) < min) {
                  min = parseInt(`${cell.v}`, 10);
                }
              }
            }
          }
        }
        if (!_.isNil(max) && !_.isNil(min)) {
          if (min < 0) {
            // 选区范围内有负数
            const plusLen = Math.round((max / (max - min)) * 10) / 10; // 正数所占比
            const minusLen =
              Math.round((Math.abs(min) / (max - min)) * 10) / 10; // 负数所占比

            for (let s = 0; s < cellrange.length; s += 1) {
              for (
                let r = cellrange[s].row[0];
                r <= cellrange[s].row[1];
                r += 1
              ) {
                for (
                  let c = cellrange[s].column[0];
                  c <= cellrange[s].column[1];
                  c += 1
                ) {
                  if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                    continue;
                  }

                  const cell = d[r][c];

                  if (
                    !_.isNil(cell) &&
                    isNumericCellType(cell) &&
                    !_.isNil(cell.v)
                  ) {
                    if (parseInt(`${cell.v}`, 10) < 0) {
                      // 负数
                      const valueLen =
                        Math.round(
                          (Math.abs(parseInt(`${cell.v}`, 10)) /
                            Math.abs(min)) *
                            100,
                        ) / 100;

                      if (!(`${r}_${c}` in computeMap)) {
                        computeMap[`${r}_${c}`] = {
                          dataBar: {
                            valueType: 'minus',
                            minusLen,
                            valueLen,
                            format,
                          },
                        };
                      }
                    }

                    if (parseInt(`${cell.v}`, 10) > 0) {
                      // 正数
                      const valueLen =
                        Math.round((parseInt(`${cell.v}`, 10) / max) * 100) /
                        100;

                      if (!(`${r}_${c}` in computeMap)) {
                        computeMap[`${r}_${c}`] = {
                          dataBar: {
                            valueType: 'plus',
                            plusLen,
                            minusLen,
                            valueLen,
                            format,
                          },
                        };
                      }
                    }
                  }
                }
              }
            }
          } else {
            const plusLen = 1;

            for (let s = 0; s < cellrange.length; s += 1) {
              for (
                let r = cellrange[s].row[0];
                r <= cellrange[s].row[1];
                r += 1
              ) {
                for (
                  let c = cellrange[s].column[0];
                  c <= cellrange[s].column[1];
                  c += 1
                ) {
                  if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                    continue;
                  }

                  const cell = d[r][c];

                  if (
                    !_.isNil(cell) &&
                    isNumericCellType(cell) &&
                    !_.isNil(cell.v)
                  ) {
                    let valueLen;
                    if (max === 0) {
                      valueLen = 1;
                    } else {
                      valueLen =
                        Math.round((parseInt(`${cell.v}`, 10) / max) * 100) /
                        100;
                    }

                    if (!(`${r}_${c}` in computeMap)) {
                      computeMap[`${r}_${c}`] = {
                        dataBar: {
                          valueType: 'plus',
                          plusLen,
                          valueLen,
                          format,
                        },
                      };
                    }
                  }
                }
              }
            }
          }
        }
      } else if (type === 'colorGradation') {
        // 色阶
        let max = null;
        let min = null;
        let sum = 0;
        let count = 0;
        for (let s = 0; s < cellrange.length; s += 1) {
          for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
            for (
              let c = cellrange[s].column[0];
              c <= cellrange[s].column[1];
              c += 1
            ) {
              if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                continue;
              }

              const cell = d[r][c];

              if (
                !_.isNil(cell) &&
                isNumericCellType(cell) &&
                !_.isNil(cell.v)
              ) {
                count += 1;
                sum += parseInt(`${cell.v}`, 10);

                if (_.isNil(max) || parseInt(`${cell.v}`, 10) > max) {
                  max = parseInt(`${cell.v}`, 10);
                }

                if (_.isNil(min) || parseInt(`${cell.v}`, 10) < min) {
                  min = parseInt(`${cell.v}`, 10);
                }
              }
            }
          }
        }
        if (!_.isNil(max) && !_.isNil(min)) {
          if (format.length === 3) {
            // 三色色阶
            const avg = Math.floor(sum / count);

            for (let s = 0; s < cellrange.length; s += 1) {
              for (
                let r = cellrange[s].row[0];
                r <= cellrange[s].row[1];
                r += 1
              ) {
                for (
                  let c = cellrange[s].column[0];
                  c <= cellrange[s].column[1];
                  c += 1
                ) {
                  if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                    continue;
                  }

                  const cell = d[r][c];

                  if (
                    !_.isNil(cell) &&
                    isNumericCellType(cell) &&
                    !_.isNil(cell.v)
                  ) {
                    if (parseInt(`${cell.v}`, 10) === min) {
                      if (!(`${r}_${c}` in computeMap)) {
                        computeMap[`${r}_${c}`] = {
                          cellColor: format.cellColor,
                        };
                      }
                    } else if (
                      parseInt(`${cell.v}`, 10) > min &&
                      parseInt(`${cell.v}`, 10) < avg
                    ) {
                      if (!(`${r}_${c}` in computeMap)) {
                        computeMap[`${r}_${c}`] = {
                          cellColor: getColorGradation(
                            format[2],
                            format[1],
                            min,
                            avg,
                            parseInt(`${cell.v}`, 10),
                          ),
                        };
                      }
                    } else if (parseInt(`${cell.v}`, 10) === avg) {
                      if (!(`${r}_${c}` in computeMap)) {
                        computeMap[`${r}_${c}`] = { cellColor: format[1] };
                      }
                    } else if (
                      parseInt(`${cell.v}`, 10) > avg &&
                      parseInt(`${cell.v}`, 10) < max
                    ) {
                      if (!(`${r}_${c}` in computeMap)) {
                        computeMap[`${r}_${c}`] = {
                          cellColor: getColorGradation(
                            format[1],
                            format[0],
                            avg,
                            max,
                            parseInt(`${cell.v}`, 10),
                          ),
                        };
                      }
                    } else if (parseInt(`${cell.v}`, 10) === max) {
                      if (!(`${r}_${c}` in computeMap)) {
                        computeMap[`${r}_${c}`] = { cellColor: format[0] };
                      }
                    }
                  }
                }
              }
            }
          } else if (format.length === 2) {
            // 两色色阶
            for (let s = 0; s < cellrange.length; s += 1) {
              for (
                let r = cellrange[s].row[0];
                r <= cellrange[s].row[1];
                r += 1
              ) {
                for (
                  let c = cellrange[s].column[0];
                  c <= cellrange[s].column[1];
                  c += 1
                ) {
                  if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                    continue;
                  }

                  const cell = d[r][c];

                  if (
                    !_.isNil(cell) &&
                    isNumericCellType(cell) &&
                    !_.isNil(cell.v)
                  ) {
                    if (parseInt(`${cell.v}`, 10) === min) {
                      if (!(`${r}_${c}` in computeMap)) {
                        computeMap[`${r}_${c}`] = { cellColor: format[1] };
                      }
                    } else if (
                      parseInt(`${cell.v}`, 10) > min &&
                      parseInt(`${cell.v}`, 10) < max
                    ) {
                      if (!(`${r}_${c}` in computeMap)) {
                        computeMap[`${r}_${c}`] = {
                          cellColor: getColorGradation(
                            format[1],
                            format[0],
                            min,
                            max,
                            parseInt(`${cell.v}`, 10),
                          ),
                        };
                      }
                    } else if (parseInt(`${cell.v}`, 10) === max) {
                      if (!(`${r}_${c}` in computeMap)) {
                        computeMap[`${r}_${c}`] = { cellColor: format[0] };
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } else if (type === 'icons') {
        // 图标集
      } else {
        // 其他
        // 获取变量值
        const conditionName = normalizeCfConditionName(
          String(ruleArr[i].conditionName ?? ''),
        );
        const conditionValue0 = ruleArr[i].conditionValue[0];
        const conditionValue1 = ruleArr[i].conditionValue[1];
        const { textColor, cellColor, bold, italic, underline, strikethrough } =
          format;
        for (let s = 0; s < cellrange.length; s += 1) {
          // 条件类型判断
          if (
            conditionName === 'greaterThan' ||
            conditionName === 'greaterThanOrEqual' ||
            conditionName === 'lessThan' ||
            conditionName === 'lessThanOrEqual' ||
            conditionName === 'equal' ||
            conditionName === 'notEqual' ||
            conditionName === 'textContains' ||
            conditionName === 'textDoesNotContain' ||
            conditionName === 'textStartsWith' ||
            conditionName === 'textEndsWith' ||
            conditionName === 'textExactly'
          ) {
            // 循环应用范围计算
            for (
              let r = cellrange[s].row[0];
              r <= cellrange[s].row[1];
              r += 1
            ) {
              for (
                let c = cellrange[s].column[0];
                c <= cellrange[s].column[1];
                c += 1
              ) {
                if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                  continue;
                }
                // 单元格值
                const cell = d[r][c];
                const isEmptyCell = isCfCellEmpty(cell);
                const cellText = getCfPlainTextFromCell(cell);
                const cellVal =
                  isEmptyCell || _.isNil(cell?.v) || isRealNull(cell.v)
                    ? cellText || null
                    : cell.v;
                const needleText =
                  conditionValue0 == null ? '' : String(conditionValue0);
                const cellTextLower = cellText.toLowerCase();
                const needleLower = needleText.toLowerCase();
                if (isEmptyCell && conditionName !== 'textDoesNotContain') {
                  continue;
                }
                // 符合条件 - UPDATED WITH STRING COMPARISON SUPPORT
                if (
                  conditionName === 'greaterThan' &&
                  compareGreaterThan(cellVal, conditionValue0, '>') &&
                  !(`${r}_${c}` in computeMap)
                ) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                } else if (
                  conditionName === 'greaterThanOrEqual' &&
                  compareGreaterThan(cellVal, conditionValue0, '>=') &&
                  !(`${r}_${c}` in computeMap)
                ) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                } else if (
                  conditionName === 'lessThan' &&
                  compareLessThan(cellVal, conditionValue0, '<') &&
                  !(`${r}_${c}` in computeMap)
                ) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                } else if (
                  conditionName === 'lessThanOrEqual' &&
                  compareLessThan(cellVal, conditionValue0, '<=') &&
                  !(`${r}_${c}` in computeMap)
                ) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                } else if (
                  conditionName === 'equal' &&
                  String(cellVal) === conditionValue0 &&
                  !(`${r}_${c}` in computeMap)
                ) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                } else if (
                  conditionName === 'textExactly' &&
                  cellTextLower === needleLower &&
                  !(`${r}_${c}` in computeMap)
                ) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                } else if (
                  conditionName === 'notEqual' &&
                  String(cellVal) !== conditionValue0.toString() &&
                  !(`${r}_${c}` in computeMap)
                ) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                } else if (
                  conditionName === 'textContains' &&
                  cellTextLower.indexOf(needleLower) !== -1 &&
                  !(`${r}_${c}` in computeMap)
                ) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                } else if (
                  conditionName === 'textDoesNotContain' &&
                  cellTextLower.indexOf(needleLower) === -1 &&
                  !(`${r}_${c}` in computeMap)
                ) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                } else if (
                  conditionName === 'textStartsWith' &&
                  cellTextLower.startsWith(needleLower) &&
                  !(`${r}_${c}` in computeMap)
                ) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                } else if (
                  conditionName === 'textEndsWith' &&
                  cellTextLower.endsWith(needleLower) &&
                  !(`${r}_${c}` in computeMap)
                ) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                }
              }
            }
          } else if (conditionName === 'empty') {
            // Format cells that are empty (no value or blank)
            for (
              let r = cellrange[s].row[0];
              r <= cellrange[s].row[1];
              r += 1
            ) {
              for (
                let c = cellrange[s].column[0];
                c <= cellrange[s].column[1];
                c += 1
              ) {
                const cell = _.isNil(d[r]) || _.isNil(d[r][c]) ? null : d[r][c];
                const isEmpty = isCfCellEmpty(cell);
                if (isEmpty && !(`${r}_${c}` in computeMap)) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                }
              }
            }
          } else if (conditionName === 'notEmpty') {
            for (
              let r = cellrange[s].row[0];
              r <= cellrange[s].row[1];
              r += 1
            ) {
              for (
                let c = cellrange[s].column[0];
                c <= cellrange[s].column[1];
                c += 1
              ) {
                const cell = _.isNil(d[r]) || _.isNil(d[r][c]) ? null : d[r][c];
                const isEmpty = isCfCellEmpty(cell);
                if (!isEmpty && !(`${r}_${c}` in computeMap)) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                }
              }
            }
          } else if (
            conditionName === 'between' ||
            conditionName === 'notBetween'
          ) {
            // UPDATED BETWEEN COMPARISON WITH STRING SUPPORT
            // 循环应用范围计算
            for (
              let r = cellrange[s].row[0];
              r <= cellrange[s].row[1];
              r += 1
            ) {
              for (
                let c = cellrange[s].column[0];
                c <= cellrange[s].column[1];
                c += 1
              ) {
                if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                  continue;
                }
                // 单元格值
                const cell = d[r][c];
                if (_.isNil(cell) || _.isNil(cell.v) || isRealNull(cell.v)) {
                  continue;
                }
                // 符合条件 - Updated to use the new compareBetween function
                const inBetween = compareBetween(
                  cell.v,
                  conditionValue0,
                  conditionValue1,
                );
                if (
                  (conditionName === 'between' && inBetween) ||
                  (conditionName === 'notBetween' && !inBetween)
                ) {
                  if (!(`${r}_${c}` in computeMap)) {
                    computeMap[`${r}_${c}`] = {
                      textColor,
                      cellColor,
                      bold,
                      italic,
                      underline,
                      strikethrough,
                    };
                  }
                }
              }
            }
          } else if (conditionName === 'occurrenceDate') {
            let dBig;
            let dSmall;
            if (conditionValue0.toString().indexOf('-') === -1) {
              dBig = genarate(conditionValue0)![2].toString();
              dSmall = genarate(conditionValue0)![2].toString();
            } else {
              const str = conditionValue0.toString().split('-');
              dBig = genarate(str[1].trim())![2].toString();
              dSmall = genarate(str[0].trim()![2].toString());
            }
            // 循环应用范围计算
            for (
              let r = cellrange[s].row[0];
              r <= cellrange[s].row[1];
              r += 1
            ) {
              for (
                let c = cellrange[s].column[0];
                c <= cellrange[s].column[1];
                c += 1
              ) {
                if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                  continue;
                }
                // 单元格值类型为日期类型
                if (
                  !_.isNil(d[r][c]) &&
                  !_.isNil(d[r][c]!.ct) &&
                  d[r][c]!.ct!.t === 'd'
                ) {
                  // 单元格值
                  const cellVal = getCellValue(r, c, d);
                  // 符合条件
                  if (
                    cellVal >= dSmall &&
                    cellVal <= dBig &&
                    !(`${r}_${c}` in computeMap)
                  ) {
                    computeMap[`${r}_${c}`] = {
                      textColor,
                      cellColor,
                      bold,
                      italic,
                      underline,
                      strikethrough,
                    };
                  }
                }
              }
            }
          } else if (
            conditionName === 'dateIs' ||
            conditionName === 'dateBefore'
          ) {
            const cva = ruleArr[i].conditionValue;
            for (
              let r = cellrange[s].row[0];
              r <= cellrange[s].row[1];
              r += 1
            ) {
              for (
                let c = cellrange[s].column[0];
                c <= cellrange[s].column[1];
                c += 1
              ) {
                if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                  continue;
                }
                const cellDay = resolveCellDaySerialForDateCf(d[r][c]);
                if (cellDay == null) {
                  continue;
                }
                const matches = matchesCfDateIsOrBefore(
                  cellDay,
                  conditionName,
                  cva,
                );
                if (matches && !(`${r}_${c}` in computeMap)) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                }
              }
            }
          } else if (conditionName === 'dateAfter') {
            const cva = ruleArr[i].conditionValue;
            for (
              let r = cellrange[s].row[0];
              r <= cellrange[s].row[1];
              r += 1
            ) {
              for (
                let c = cellrange[s].column[0];
                c <= cellrange[s].column[1];
                c += 1
              ) {
                if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                  continue;
                }
                const cellDay = resolveCellDaySerialForDateCf(d[r][c]);
                if (cellDay == null) {
                  continue;
                }
                const matches = matchesCfDateAfter(cellDay, cva);
                if (matches && !(`${r}_${c}` in computeMap)) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                }
              }
            }
          } else if (conditionName === 'duplicateValue') {
            const dmap: any = {};
            for (
              let r = cellrange[s].row[0];
              r <= cellrange[s].row[1];
              r += 1
            ) {
              for (
                let c = cellrange[s].column[0];
                c <= cellrange[s].column[1];
                c += 1
              ) {
                const item = getCellValue(r, c, d);
                if (!(item in dmap)) {
                  dmap[item] = [];
                }
                dmap[item].push({ r, c });
              }
            }
            const fullFmt = {
              textColor,
              cellColor,
              bold,
              italic,
              underline,
              strikethrough,
            };
            if (conditionValue0 === '0') {
              const dup = new Set<string>();
              _.forEach(dmap, (x) => {
                if (x.length > 1) {
                  for (let j = 0; j < x.length; j += 1) {
                    dup.add(`${x[j].r}_${x[j].c}`);
                  }
                }
              });
              for (
                let r = cellrange[s].row[0];
                r <= cellrange[s].row[1];
                r += 1
              ) {
                for (
                  let c = cellrange[s].column[0];
                  c <= cellrange[s].column[1];
                  c += 1
                ) {
                  const k = `${r}_${c}`;
                  if (k in computeMap) {
                    continue;
                  }
                  computeMap[k] = dup.has(k) ? { ...fullFmt } : { bold };
                }
              }
            } else if (conditionValue0 === '1') {
              const uniq = new Set<string>();
              _.forEach(dmap, (x) => {
                if (x.length === 1) {
                  uniq.add(`${x[0].r}_${x[0].c}`);
                }
              });
              for (
                let r = cellrange[s].row[0];
                r <= cellrange[s].row[1];
                r += 1
              ) {
                for (
                  let c = cellrange[s].column[0];
                  c <= cellrange[s].column[1];
                  c += 1
                ) {
                  const k = `${r}_${c}`;
                  if (k in computeMap) {
                    continue;
                  }
                  computeMap[k] = uniq.has(k) ? { ...fullFmt } : { bold };
                }
              }
            }
          } else if (
            conditionName === 'top10' ||
            conditionName === 'top10_percent' ||
            conditionName === 'last10' ||
            conditionName === 'last10_percent' ||
            conditionName === 'aboveAverage' ||
            conditionName === 'belowAverage'
          ) {
            // 应用范围单元格值(数值型)
            const dArr = [];
            for (
              let r = cellrange[s].row[0];
              r <= cellrange[s].row[1];
              r += 1
            ) {
              for (
                let c = cellrange[s].column[0];
                c <= cellrange[s].column[1];
                c += 1
              ) {
                if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                  continue;
                }

                // 单元格值类型为数字类型
                if (!_.isNil(d[r][c]) && isNumericCellType(d[r][c]!)) {
                  dArr.push(getCellValue(r, c, d));
                }
              }
            }
            // 数组处理
            if (
              conditionName === 'top10' ||
              conditionName === 'top10_percent' ||
              conditionName === 'last10' ||
              conditionName === 'last10_percent'
            ) {
              // 从大到小排序
              for (let j = 0; j < dArr.length; j += 1) {
                for (let k = 0; k < dArr.length - 1 - j; k += 1) {
                  if (dArr[k] < dArr[k + 1]) {
                    const temp: any = dArr[k];
                    dArr[k] = dArr[k + 1];
                    dArr[k + 1] = temp;
                  }
                }
              }
              // 取条件值数组

              let cArr;
              if (conditionName === 'top10') {
                cArr = dArr.slice(0, conditionValue0); // 前10项数组
              } else if (conditionName === 'top10_percent') {
                cArr = dArr.slice(
                  0,
                  Math.floor((conditionValue0 * dArr.length) / 100),
                ); // 前10%数组
              } else if (conditionName === 'last10') {
                cArr = dArr.slice(dArr.length - conditionValue0, dArr.length); // 最后10项数组
              } else if (conditionName === 'last10_percent') {
                cArr = dArr.slice(
                  dArr.length -
                    Math.floor((conditionValue0 * dArr.length) / 100),
                  dArr.length,
                ); // 最后10%数组
              }
              // 循环应用范围计算
              for (
                let r = cellrange[s].row[0];
                r <= cellrange[s].row[1];
                r += 1
              ) {
                for (
                  let c = cellrange[s].column[0];
                  c <= cellrange[s].column[1];
                  c += 1
                ) {
                  if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                    continue;
                  }

                  // 单元格值
                  const cellVal = getCellValue(r, c, d);
                  // 符合条件
                  if (
                    !_.isNil(cArr) &&
                    cArr.indexOf(cellVal) !== -1 &&
                    !(`${r}_${c}` in computeMap)
                  ) {
                    computeMap[`${r}_${c}`] = {
                      textColor,
                      cellColor,
                      bold,
                      italic,
                      underline,
                      strikethrough,
                    };
                  }
                }
              }
            } else if (
              conditionName === 'aboveAverage' ||
              conditionName === 'belowAverage'
            ) {
              // 计算数组平均值
              let sum = 0;
              for (let j = 0; j < dArr.length; j += 1) {
                sum += dArr[j];
              }
              const averageNum = sum / dArr.length;
              // 循环应用范围计算
              if (conditionName === 'aboveAverage') {
                // 高于平均值
                for (
                  let r = cellrange[s].row[0];
                  r <= cellrange[s].row[1];
                  r += 1
                ) {
                  for (
                    let c = cellrange[s].column[0];
                    c <= cellrange[s].column[1];
                    c += 1
                  ) {
                    if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                      continue;
                    }

                    // 单元格值
                    const cellVal = getCellValue(r, c, d);
                    // 符合条件
                    if (cellVal > averageNum && !(`${r}_${c}` in computeMap)) {
                      computeMap[`${r}_${c}`] = {
                        textColor,
                        cellColor,
                        bold,
                        italic,
                        underline,
                        strikethrough,
                      };
                    }
                  }
                }
              } else if (conditionName === 'belowAverage') {
                // 低于平均值
                for (
                  let r = cellrange[s].row[0];
                  r <= cellrange[s].row[1];
                  r += 1
                ) {
                  for (
                    let c = cellrange[s].column[0];
                    c <= cellrange[s].column[1];
                    c += 1
                  ) {
                    if (_.isNil(d[r]) || _.isNil(d[r][c])) {
                      continue;
                    }

                    // 单元格值
                    const cellVal = getCellValue(r, c, d);
                    // 符合条件
                    if (cellVal < averageNum && !(`${r}_${c}` in computeMap)) {
                      computeMap[`${r}_${c}`] = {
                        textColor,
                        cellColor,
                        bold,
                        italic,
                        underline,
                        strikethrough,
                      };
                    }
                  }
                }
              }
            }
          } else if (conditionName === 'formula') {
            const str = cellrange[s].row[0];
            const edr = cellrange[s].row[1];
            const stc = cellrange[s].column[0];
            const edc = cellrange[s].column[1];

            let formulaTxt = conditionValue0;
            if (conditionValue0.toString().slice(0, 1) !== '=') {
              formulaTxt = `=${conditionValue0}`;
            }
            for (let r = str; r <= edr; r += 1) {
              for (let c = stc; c <= edc; c += 1) {
                let func = formulaTxt;
                const offsetRow = r - str;
                const offsetCol = c - stc;

                if (offsetRow > 0) {
                  func = `=${functionCopy(ctx, func, 'down', offsetRow)}`;
                }

                if (offsetCol > 0) {
                  func = `=${functionCopy(ctx, func, 'right', offsetCol)}`;
                }

                const funcV = execfunction(ctx, func, r, c);
                let v = funcV[1];

                if (typeof v !== 'boolean') {
                  v = !!Number(v);
                }

                if (!v) {
                  continue;
                }

                if (!(`${r}_${c}` in computeMap)) {
                  computeMap[`${r}_${c}`] = {
                    textColor,
                    cellColor,
                    bold,
                    italic,
                    underline,
                    strikethrough,
                  };
                }
              }
            }
          }
        }
      }
    }
  }
  return computeMap;
}

function hasLivePreviewCondition(cr: any): boolean {
  if (!cr) return false;
  const cn = cr.rulesType;
  if (!cn) return false;
  if (cn === 'empty' || cn === 'notEmpty') return true;
  if (cn === 'aboveAverage' || cn === 'belowAverage') return true;
  if (
    cn === 'duplicateValue' ||
    cn === 'top10' ||
    cn === 'top10_percent' ||
    cn === 'last10' ||
    cn === 'last10_percent'
  ) {
    return true;
  }
  if (cn === 'dateIs' || cn === 'dateBefore') {
    const p = cr.datePreset || 'today';
    if (p === 'exact') {
      return String(cr.dateValue ?? '').trim() !== '';
    }
    return true;
  }
  if (cn === 'dateAfter') {
    const p = cr.datePreset || 'today';
    if (p === 'exact') {
      return String(cr.dateValue ?? '').trim() !== '';
    }
    return CF_DATE_AFTER_PRESETS.has(p);
  }
  if (cn === 'occurrenceDate') {
    return String(cr.dateValue ?? '').trim() !== '';
  }
  if (cn === 'between' || cn === 'notBetween') {
    return (
      String(cr.betweenValue?.value1 ?? '').trim() !== '' &&
      String(cr.betweenValue?.value2 ?? '').trim() !== ''
    );
  }
  return String(cr.rulesValue ?? '').trim() !== '';
}

function buildLivePreviewConditionValue(cr: any): any[] {
  if (!cr) return [''];
  const pd = collectPresetDateConditionValue(cr);
  if (pd) return pd;
  const cn = cr.rulesType;
  if (cn === 'occurrenceDate') {
    return [cr.dateValue || ''];
  }
  if ((cn === 'between' || cn === 'notBetween') && cr.betweenValue) {
    return [cr.betweenValue.value1, cr.betweenValue.value2];
  }
  return [cr.rulesValue || ''];
}

type ComputeMapCacheEntry = {
  luckysheetfile: unknown;
  rules: unknown;
  conditionRules: unknown;
  draftActive: boolean;
  selection: unknown;
  result: ReturnType<typeof compute> | null;
};

/**
 * Last compute map per sheet (C2). drawMain asks for it on every repaint,
 * up to four times with frozen panes, and compute walks every rule's full
 * range. Keyed by identity: Immer gives luckysheetfile (and so the sheet's
 * data, rules and conditionRules) a new identity on any change, so a hit is
 * exact. luckysheetfile rather than data alone, because formula rules can
 * read other sheets. The draft selection counts only while a live preview
 * is active. Callers only read the map. Frozen (committed) state only.
 */
const computeMapCache = new Map<string, ComputeMapCacheEntry>();

export function getComputeMap(ctx: Context) {
  const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
  const sheet = sheetIndex == null ? undefined : ctx.luckysheetfile[sheetIndex];
  // Inside an Immer recipe the draft keeps its identity while it changes:
  // never cache there.
  if (!sheet || isDraft(ctx.luckysheetfile)) return computeMapUncached(ctx);
  const draftActive = Boolean(
    ctx.conditionFormatDraftActive &&
    ctx.luckysheet_select_save &&
    hasLivePreviewCondition(sheet.conditionRules),
  );
  const key = {
    luckysheetfile: ctx.luckysheetfile,
    rules: sheet.luckysheet_conditionformat_save,
    conditionRules: sheet.conditionRules,
    draftActive,
    selection: draftActive ? ctx.luckysheet_select_save : null,
  };
  const cached = computeMapCache.get(ctx.currentSheetId);
  if (
    cached &&
    cached.luckysheetfile === key.luckysheetfile &&
    cached.rules === key.rules &&
    cached.conditionRules === key.conditionRules &&
    cached.draftActive === key.draftActive &&
    cached.selection === key.selection
  ) {
    return cached.result;
  }
  const result = computeMapUncached(ctx);
  computeMapCache.set(ctx.currentSheetId, { ...key, result });
  return result;
}

function computeMapUncached(ctx: Context) {
  const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
  const ruleArr = ctx.luckysheetfile[index]?.luckysheet_conditionformat_save
    ? [...(ctx.luckysheetfile[index]?.luckysheet_conditionformat_save as any[])]
    : [];
  const { data } = ctx.luckysheetfile[index];
  if (_.isNil(data)) return null;
  const editKey = ctx.luckysheetfile[index].conditionRules?.editKey;
  const sheetCr = ctx.luckysheetfile[index].conditionRules;
  if (
    ctx.conditionFormatDraftActive &&
    ctx.luckysheet_select_save &&
    hasLivePreviewCondition(sheetCr)
  ) {
    if (editKey !== null && editKey !== undefined) {
      ruleArr.splice(Number(editKey), 1);
    }
    // Prepend so the draft is evaluated first; matches prior "preview overrides" UX with first-wins order.
    ruleArr.unshift({
      type: 'default',
      cellrange: ctx.luckysheet_select_save,
      format: {
        textColor: ctx.luckysheetfile[index].conditionRules?.textColor.color,
        cellColor: ctx.luckysheetfile[index].conditionRules?.cellColor.color,
        bold: ctx.luckysheetfile[index].conditionRules?.font?.bold,
        italic: ctx.luckysheetfile[index].conditionRules?.font?.italic,
        underline: ctx.luckysheetfile[index].conditionRules?.font?.underline,
        strikethrough:
          ctx.luckysheetfile[index].conditionRules?.font?.strikethrough,
      },
      conditionName: ctx.luckysheetfile[index].conditionRules?.rulesType,
      conditionRange: [],
      conditionValue: buildLivePreviewConditionValue(sheetCr),
    });
  }

  const computeMap = compute(ctx, ruleArr, data);
  return computeMap;
}

export function checkCF(r: number, c: number, computeMap: any) {
  if (!_.isNil(computeMap) && `${r}_${c}` in computeMap) {
    return computeMap[`${r}_${c}`];
  }
  return null;
}

export function updateItem(ctx: Context, type: string) {
  if (!checkProtectionFormatCells(ctx)) {
    return;
  }
  const index = getSheetIndex(ctx, ctx.currentSheetId) as number;

  // 保存之前的规则
  // const fileH = ctx.luckysheetfile ?? [];
  // const historyRules = getHistoryRules(fileH);

  // 保存当前的规则
  let ruleArr = [];
  if (type === 'delSheet') {
    ruleArr = [];
  } else {
    const rule = {
      type,
      cellrange: ctx.luckysheet_select_save ?? [],
      format: {
        textColor: ctx.conditionRules.textColor,
        cellColor: ctx.conditionRules.cellColor,
      },
    };
    ruleArr = ctx.luckysheetfile[index].luckysheet_conditionformat_save ?? [];
    ruleArr.push(rule);
  }
  ctx.luckysheetfile[index].luckysheet_conditionformat_save = ruleArr;
}

export function CFSplitRange(
  range1: any,
  range2: any,
  range3: any,
  type: string,
) {
  let range: any = [];

  const offset_r = range3.row[0] - range2.row[0];
  const offset_c = range3.column[0] - range2.column[0];

  const r1 = range1.row[0];
  const r2 = range1.row[1];
  const c1 = range1.column[0];
  const c2 = range1.column[1];

  if (
    r1 >= range2.row[0] &&
    r2 <= range2.row[1] &&
    c1 >= range2.column[0] &&
    c2 <= range2.column[1]
  ) {
    // 选区 包含 条件格式应用范围 全部

    if (type === 'allPart') {
      // 所有部分
      range = [
        {
          row: [r1 + offset_r, r2 + offset_r],
          column: [c1 + offset_c, c2 + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [r1 + offset_r, r2 + offset_r],
          column: [c1 + offset_c, c2 + offset_c],
        },
      ];
    }
  } else if (
    r1 >= range2.row[0] &&
    r1 <= range2.row[1] &&
    c1 >= range2.column[0] &&
    c2 <= range2.column[1]
  ) {
    // 选区 行贯穿 条件格式应用范围 上部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
        {
          row: [r1 + offset_r, range2.row[1] + offset_r],
          column: [c1 + offset_c, c2 + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [{ row: [range2.row[1] + 1, r2], column: [c1, c2] }];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [r1 + offset_r, range2.row[1] + offset_r],
          column: [c1 + offset_c, c2 + offset_c],
        },
      ];
    }
  } else if (
    r2 >= range2.row[0] &&
    r2 <= range2.row[1] &&
    c1 >= range2.column[0] &&
    c2 <= range2.column[1]
  ) {
    // 选区 行贯穿 条件格式应用范围 下部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        {
          row: [range2.row[0] + offset_r, r2 + offset_r],
          column: [c1 + offset_c, c2 + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [{ row: [r1, range2.row[0] - 1], column: [c1, c2] }];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [range2.row[0] + offset_r, r2 + offset_r],
          column: [c1 + offset_c, c2 + offset_c],
        },
      ];
    }
  } else if (
    r1 < range2.row[0] &&
    r2 > range2.row[1] &&
    c1 >= range2.column[0] &&
    c2 <= range2.column[1]
  ) {
    // 选区 行贯穿 条件格式应用范围 中间部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
        {
          row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
          column: [c1 + offset_c, c2 + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
      ];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
          column: [c1 + offset_c, c2 + offset_c],
        },
      ];
    }
  } else if (
    c1 >= range2.column[0] &&
    c1 <= range2.column[1] &&
    r1 >= range2.row[0] &&
    r2 <= range2.row[1]
  ) {
    // 选区 列贯穿 条件格式应用范围 左部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, r2], column: [range2.column[1] + 1, c2] },
        {
          row: [r1 + offset_r, r2 + offset_r],
          column: [c1 + offset_c, range2.column[1] + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [{ row: [r1, r2], column: [range2.column[1] + 1, c2] }];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [r1 + offset_r, r2 + offset_r],
          column: [c1 + offset_c, range2.column[1] + offset_c],
        },
      ];
    }
  } else if (
    c2 >= range2.column[0] &&
    c2 <= range2.column[1] &&
    r1 >= range2.row[0] &&
    r2 <= range2.row[1]
  ) {
    // 选区 列贯穿 条件格式应用范围 右部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, r2], column: [c1, range2.column[0] - 1] },
        {
          row: [r1 + offset_r, r2 + offset_r],
          column: [range2.column[0] + offset_c, c2 + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [{ row: [r1, r2], column: [c1, range2.column[0] - 1] }];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [r1 + offset_r, r2 + offset_r],
          column: [range2.column[0] + offset_c, c2 + offset_c],
        },
      ];
    }
  } else if (
    c1 < range2.column[0] &&
    c2 > range2.column[1] &&
    r1 >= range2.row[0] &&
    r2 <= range2.row[1]
  ) {
    // 选区 列贯穿 条件格式应用范围 中间部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, r2], column: [c1, range2.column[0] - 1] },
        { row: [r1, r2], column: [range2.column[1] + 1, c2] },
        {
          row: [r1 + offset_r, r2 + offset_r],
          column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [
        { row: [r1, r2], column: [c1, range2.column[0] - 1] },
        { row: [r1, r2], column: [range2.column[1] + 1, c2] },
      ];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [r1 + offset_r, r2 + offset_r],
          column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
        },
      ];
    }
  } else if (
    r1 >= range2.row[0] &&
    r1 <= range2.row[1] &&
    c1 >= range2.column[0] &&
    c1 <= range2.column[1]
  ) {
    // 选区 包含 条件格式应用范围 左上角部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, range2.row[1]], column: [range2.column[1] + 1, c2] },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
        {
          row: [r1 + offset_r, range2.row[1] + offset_r],
          column: [c1 + offset_c, range2.column[1] + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [
        { row: [r1, range2.row[1]], column: [range2.column[1] + 1, c2] },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
      ];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [r1 + offset_r, range2.row[1] + offset_r],
          column: [c1 + offset_c, range2.column[1] + offset_c],
        },
      ];
    }
  } else if (
    r1 >= range2.row[0] &&
    r1 <= range2.row[1] &&
    c2 >= range2.column[0] &&
    c2 <= range2.column[1]
  ) {
    // 选区 包含 条件格式应用范围 右上角部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, range2.row[1]], column: [c1, range2.column[0] - 1] },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
        {
          row: [range2.row[0] + offset_r, r2 + offset_r],
          column: [range2.column[0] + offset_c, c2 + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [
        { row: [r1, range2.row[1]], column: [c1, range2.column[0] - 1] },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
      ];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [range2.row[0] + offset_r, r2 + offset_r],
          column: [range2.column[0] + offset_c, c2 + offset_c],
        },
      ];
    }
  } else if (
    r2 >= range2.row[0] &&
    r2 <= range2.row[1] &&
    c1 >= range2.column[0] &&
    c1 <= range2.column[1]
  ) {
    // 选区 包含 条件格式应用范围 左下角部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        { row: [range2.row[0], r2], column: [range2.column[1] + 1, c2] },
        {
          row: [range2.row[0] + offset_r, r2 + offset_r],
          column: [c1 + offset_c, range2.column[1] + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        { row: [range2.row[0], r2], column: [range2.column[1] + 1, c2] },
      ];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [range2.row[0] + offset_r, r2 + offset_r],
          column: [c1 + offset_c, range2.column[1] + offset_c],
        },
      ];
    }
  } else if (
    r2 >= range2.row[0] &&
    r2 <= range2.row[1] &&
    c2 >= range2.column[0] &&
    c2 <= range2.column[1]
  ) {
    // 选区 包含 条件格式应用范围 右下角部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        { row: [range2.row[0], r2], column: [c1, range2.column[0] - 1] },
        {
          row: [range2.row[0] + offset_r, r2 + offset_r],
          column: [range2.column[0] + offset_c, c2 + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        { row: [range2.row[0], r2], column: [c1, range2.column[0] - 1] },
      ];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [range2.row[0] + offset_r, r2 + offset_r],
          column: [range2.column[0] + offset_c, c2 + offset_c],
        },
      ];
    }
  } else if (
    r1 < range2.row[0] &&
    r2 > range2.row[1] &&
    c1 >= range2.column[0] &&
    c1 <= range2.column[1]
  ) {
    // 选区 包含 条件格式应用范围 左中间部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        {
          row: [range2.row[0], range2.row[1]],
          column: [range2.column[1] + 1, c2],
        },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
        {
          row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
          column: [c1 + offset_c, range2.column[1] + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        {
          row: [range2.row[0], range2.row[1]],
          column: [range2.column[1] + 1, c2],
        },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
      ];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
          column: [c1 + offset_c, range2.column[1] + offset_c],
        },
      ];
    }
  } else if (
    r1 < range2.row[0] &&
    r2 > range2.row[1] &&
    c2 >= range2.column[0] &&
    c2 <= range2.column[1]
  ) {
    // 选区 包含 条件格式应用范围 右中间部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        {
          row: [range2.row[0], range2.row[1]],
          column: [c1, range2.column[0] - 1],
        },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
        {
          row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
          column: [range2.column[0] + offset_c, c2 + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        {
          row: [range2.row[0], range2.row[1]],
          column: [c1, range2.column[0] - 1],
        },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
      ];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
          column: [range2.column[0] + offset_c, c2 + offset_c],
        },
      ];
    }
  } else if (
    c1 < range2.column[0] &&
    c2 > range2.column[1] &&
    r1 >= range2.row[0] &&
    r1 <= range2.row[1]
  ) {
    // 选区 包含 条件格式应用范围 上中间部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, range2.row[1]], column: [c1, range2.column[0] - 1] },
        { row: [r1, range2.row[1]], column: [range2.column[1] + 1, c2] },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
        {
          row: [r1 + offset_r, range2.row[1] + offset_r],
          column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [
        { row: [r1, range2.row[1]], column: [c1, range2.column[0] - 1] },
        { row: [r1, range2.row[1]], column: [range2.column[1] + 1, c2] },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
      ];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [r1 + offset_r, range2.row[1] + offset_r],
          column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
        },
      ];
    }
  } else if (
    c1 < range2.column[0] &&
    c2 > range2.column[1] &&
    r2 >= range2.row[0] &&
    r2 <= range2.row[1]
  ) {
    // 选区 包含 条件格式应用范围 下中间部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        { row: [range2.row[0], r2], column: [c1, range2.column[0] - 1] },
        { row: [range2.row[0], r2], column: [range2.column[1] + 1, c2] },
        {
          row: [range2.row[0] + offset_r, r2 + offset_r],
          column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        { row: [range2.row[0], r2], column: [c1, range2.column[0] - 1] },
        { row: [range2.row[0], r2], column: [range2.column[1] + 1, c2] },
      ];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [range2.row[0] + offset_r, r2 + offset_r],
          column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
        },
      ];
    }
  } else if (
    r1 < range2.row[0] &&
    r2 > range2.row[1] &&
    c1 < range2.column[0] &&
    c2 > range2.column[1]
  ) {
    // 选区 包含 条件格式应用范围 正中间部分

    if (type === 'allPart') {
      // 所有部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        {
          row: [range2.row[0], range2.row[1]],
          column: [c1, range2.column[0] - 1],
        },
        {
          row: [range2.row[0], range2.row[1]],
          column: [range2.column[1] + 1, c2],
        },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
        {
          row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
          column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
        },
      ];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [
        { row: [r1, range2.row[0] - 1], column: [c1, c2] },
        {
          row: [range2.row[0], range2.row[1]],
          column: [c1, range2.column[0] - 1],
        },
        {
          row: [range2.row[0], range2.row[1]],
          column: [range2.column[1] + 1, c2],
        },
        { row: [range2.row[1] + 1, r2], column: [c1, c2] },
      ];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [
        {
          row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
          column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
        },
      ];
    }
  } else {
    // 选区 在 条件格式应用范围 之外

    if (type === 'allPart') {
      // 所有部分
      range = [{ row: [r1, r2], column: [c1, c2] }];
    } else if (type === 'restPart') {
      // 剩余部分
      range = [{ row: [r1, r2], column: [c1, c2] }];
    } else if (type === 'operatePart') {
      // 操作部分
      range = [];
    }
  }

  return range;
}
