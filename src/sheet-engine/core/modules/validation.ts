import dayjs from 'dayjs';
import _ from 'lodash';
import {
  ERROR_NAME,
  ERROR_DIV_ZERO,
  ERROR_NULL,
  ERROR_NUM,
  ERROR_REF,
  ERROR_VALUE,
  ERROR,
  CIRCULAR_REF_ERROR,
  // @ts-ignore
} from '@sheet-engine/formula-parser';
import { Context } from '../context';
import { isUsDateBaseLocale } from './date-base-locale';
import { hasChinaword } from './text';

export const error = {
  v: '#VALUE!', // 错误的参数或运算符
  n: '#NAME?', // 公式名称错误
  na: '#N/A', // 函数或公式中没有可用数值
  r: '#REF!', // 删除了由其他公式引用的单元格
  d: '#DIV/0!', // 除数是0或空单元格
  nm: '#NUM!', // 当公式或函数中某个数字有问题时
  nl: '#NULL!', // 交叉运算符（空格）使用不正确
  sp: '#SPILL!', // 数组范围有其它值
  circ: '#CIRC!', // 循环引用
};

export const errorMessagesFromValue: Record<string, string> = {
  [ERROR_DIV_ZERO]:
    'Invalid calculation: the divisor (second value) cannot be zero',
  [ERROR_NAME]: 'Wrong function name or parameter',
  [ERROR_NULL]: 'Formula returned null',
  [ERROR_NUM]: 'Invalid number',
  [ERROR_REF]: 'Invalid reference',
  [ERROR_VALUE]: 'Invalid value',
  [ERROR]: 'Unknown error',
  [CIRCULAR_REF_ERROR]: 'Circular dependency.',
};

export function detectErrorFromValue(input: string) {
  return errorMessagesFromValue[input];
}

const errorValues = Object.values(error);

export function valueIsError(value: string) {
  return errorValues.includes(value);
}

// 是否是空值
export function isRealNull(val: any) {
  return _.isNil(val) || val.toString().replace(/\s/g, '') === '';
}
export function isHexValue(str: string): boolean {
  // Requires 0x prefix for hex values
  return /^0x[a-fA-F0-9]+$/i.test(str);
}

// 是否是纯数字
export function isRealNum(val: any) {
  if (isHexValue(val?.toString())) {
    return false;
  }
  if (_.isNil(val) || val.toString().replace(/\s/g, '') === '') {
    return false;
  }

  if (typeof val === 'boolean') {
    return false;
  }

  return !Number.isNaN(Number(val));
}

/**
 * Explicit number format (`t === 'n'`) or General/Automatic with a numeric stored value (`t === 'g'`).
 * Use wherever logic previously required `ct.t === 'n'` so Automatic numeric cells behave the same.
 */
export function isNumericCellType(
  cell:
    | {
        ct?: { t?: string; fa?: string };
        v?: unknown;
      }
    | null
    | undefined,
): boolean {
  if (!cell?.ct?.t) return false;
  if (cell.ct.t === 'n') return true;
  if (cell.ct.t === 'g' && isRealNum(cell.v)) return true;
  return false;
}

export type DateFormatInfo = {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  formatType: string;
};

const MONTH_NAME_MAP: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MONTH_NAMES_RE =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec';
const MONTH_ABBR_RE = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const MONTH_ABBR_SET = new Set(MONTH_ABBR_RE.split('|'));
const WEEKDAY_NAMES_RE =
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const WEEKDAY_ABBR_RE = 'mon|tue|wed|thu|fri|sat|sun';

/**
 * Excel / Google Sheets two-digit year window:
 * 00–29 → 2000–2029, 30–99 → 1930–1999.
 * e.g. 12/12/13 → 2013, 12/12/31 → 1931.
 */
function parseTwoDigitYear(twoDigitYear: string): number {
  const yy = Number(twoDigitYear);
  return yy <= 29 ? 2000 + yy : 1900 + yy;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (year < 1900) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (month === 2) {
    const isLeap = new Date(year, 1, 29).getDate() === 29;
    if (isLeap && day > 29) return false;
    if (!isLeap && day > 28) return false;
  }
  if ([4, 6, 9, 11].includes(month) && day > 30) return false;
  return true;
}

export function detectDateFormat(str: string): DateFormatInfo | null {
  if (!str || str.toString().length < 5) return null;
  const s = str.toString().trim();
  const currentYear = new Date().getFullYear();
  const prefersUsDateOrder = isUsDateBaseLocale();
  let m: RegExpExecArray | null;

  // ISO 8601: 2026-02-25T14:30:00 or 2026-02-25T14:30
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    const h = +m[4];
    const mi = +m[5];
    const sec = m[6] != null ? +m[6] : 0;
    if (isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: h,
        minutes: mi,
        seconds: sec,
        formatType: 'yyyy-MM-ddTHH:mm',
      };
    }
  }

  // yyyy-MM-dd with optional time: 2026-02-25 or 2026-02-25 14:30 or 2026-02-25 14:30:00
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    s,
  );
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (isValidDateParts(y, mo, d)) {
      const h = m[4] != null ? +m[4] : 0;
      const mi = m[5] != null ? +m[5] : 0;
      const sec = m[6] != null ? +m[6] : 0;
      return {
        year: y,
        month: mo,
        day: d,
        hours: h,
        minutes: mi,
        seconds: sec,
        formatType: m[4] != null ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd',
      };
    }
  }

  // yyyy/MM/dd with optional time
  m =
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
      s,
    );
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (isValidDateParts(y, mo, d)) {
      const h = m[4] != null ? +m[4] : 0;
      const mi = m[5] != null ? +m[5] : 0;
      const sec = m[6] != null ? +m[6] : 0;
      return {
        year: y,
        month: mo,
        day: d,
        hours: h,
        minutes: mi,
        seconds: sec,
        formatType: m[4] != null ? 'yyyy/MM/dd HH:mm' : 'yyyy/MM/dd',
      };
    }
  }

  // yyyy.MM.dd: 2026.02.25
  m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(s);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: 'yyyy.MM.dd',
      };
    }
  }

  // Slash-separated with 4-digit year + AM/PM (base-order aware)
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s(\d{1,2}):(\d{2})\s?(AM|PM)$/i.exec(s);
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = +m[3];
    const h = +m[4];
    const mi = +m[5];
    const ampm = m[6].toUpperCase();
    const mo = prefersUsDateOrder ? p1 : p2;
    const d = prefersUsDateOrder ? p2 : p1;
    if (isValidDateParts(y, mo, d)) {
      let actualH = h;
      if (ampm === 'PM' && h !== 12) actualH = h + 12;
      if (ampm === 'AM' && h === 12) actualH = 0;
      return {
        year: y,
        month: mo,
        day: d,
        hours: actualH,
        minutes: mi,
        seconds: 0,
        formatType: prefersUsDateOrder
          ? m[1].length === 1
            ? 'M/d/yyyy h:mm AM/PM'
            : 'MM/dd/yyyy h:mm AM/PM'
          : m[1].length === 1
            ? 'd/M/yyyy h:mm AM/PM'
            : 'dd/MM/yyyy h:mm AM/PM',
      };
    }
  }

  // Slash-separated with 4-digit year last (base-order aware)
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = +m[3];
    const mo = prefersUsDateOrder ? p1 : p2;
    const d = prefersUsDateOrder ? p2 : p1;
    if (isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: prefersUsDateOrder
          ? m[1].length === 1
            ? 'M/d/yyyy'
            : 'MM/dd/yyyy'
          : m[1].length === 1
            ? 'd/M/yyyy'
            : 'dd/MM/yyyy',
      };
    }
  }

  // Slash-separated with 2-digit year (base-order aware)
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(s);
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = parseTwoDigitYear(m[3]);
    const mo = prefersUsDateOrder ? p1 : p2;
    const d = prefersUsDateOrder ? p2 : p1;
    if (isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: prefersUsDateOrder
          ? m[1].length === 1
            ? 'M/d/yy'
            : 'MM/dd/yy'
          : m[1].length === 1
            ? 'd/M/yy'
            : 'dd/MM/yy',
      };
    }
  }

  // Dash-separated with 4-digit year (base-order aware). UK: D-M-YYYY, US: M-D-YYYY.
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = +m[3];
    const mo = prefersUsDateOrder ? p1 : p2;
    const d = prefersUsDateOrder ? p2 : p1;
    if (mo <= 12 && d <= 31 && isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: prefersUsDateOrder
          ? m[1].length === 1
            ? 'M-d-yyyy'
            : 'MM-dd-yyyy'
          : m[1].length === 1
            ? 'd-M-yyyy'
            : 'dd-MM-yyyy',
      };
    }
  }

  // Dot-separated with 4-digit year (base-order aware). Unambiguous only when
  // the day-side part is > 12 so month/day cannot swap.
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = +m[3];
    if (prefersUsDateOrder) {
      if (p2 > 12 && isValidDateParts(y, p1, p2)) {
        return {
          year: y,
          month: p1,
          day: p2,
          hours: 0,
          minutes: 0,
          seconds: 0,
          formatType: 'MM.dd.yyyy',
        };
      }
    } else if (p1 > 12 && isValidDateParts(y, p2, p1)) {
      return {
        year: y,
        month: p2,
        day: p1,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: 'dd.MM.yyyy',
      };
    }
  }

  // Named month first: "February 25, 2026", "Feb 25, 2026", "February 25 2026"
  m = new RegExp(`^(${MONTH_NAMES_RE})\\s+(\\d{1,2}),?\\s+(\\d{4})$`, 'i').exec(
    s,
  );
  if (m) {
    const mo = MONTH_NAME_MAP[m[1].toLowerCase()];
    const d = +m[2];
    const y = +m[3];
    if (mo && isValidDateParts(y, mo, d)) {
      const isAbbr = MONTH_ABBR_SET.has(m[1].toLowerCase());
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: isAbbr ? 'named-mdy-abbr' : 'named-mdy-full',
      };
    }
  }

  // Day first: "25 February 2026", "25 Feb 2026"
  m = new RegExp(`^(\\d{1,2})\\s+(${MONTH_NAMES_RE})\\s+(\\d{4})$`, 'i').exec(
    s,
  );
  if (m) {
    const d = +m[1];
    const mo = MONTH_NAME_MAP[m[2].toLowerCase()];
    const y = +m[3];
    if (mo && isValidDateParts(y, mo, d)) {
      const isAbbr = MONTH_ABBR_SET.has(m[2].toLowerCase());
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: isAbbr ? 'named-dmy-abbr' : 'named-dmy-full',
      };
    }
  }

  // Abbreviated month with dashes: "Feb-25-2026"
  m = new RegExp(`^(${MONTH_ABBR_RE})-(\\d{1,2})-(\\d{4})$`, 'i').exec(s);
  if (m) {
    const mo = MONTH_NAME_MAP[m[1].toLowerCase()];
    const d = +m[2];
    const y = +m[3];
    if (mo && isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: 'named-abbr-dashes',
      };
    }
  }

  // D-Mon-YYYY: 5-Feb-2026
  m = new RegExp(`^(\\d{1,2})-(${MONTH_ABBR_RE})-(\\d{4})$`, 'i').exec(s);
  if (m) {
    const d = +m[1];
    const mo = MONTH_NAME_MAP[m[2].toLowerCase()];
    const y = +m[3];
    if (mo && isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: 'd-mmm-yyyy',
      };
    }
  }

  // D-Mon-YY: 5-Feb-26
  m = new RegExp(`^(\\d{1,2})-(${MONTH_ABBR_RE})-(\\d{2})$`, 'i').exec(s);
  if (m) {
    const d = +m[1];
    const mo = MONTH_NAME_MAP[m[2].toLowerCase()];
    const y = parseTwoDigitYear(m[3]);
    if (mo && isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: 'd-mmm-yy',
      };
    }
  }

  // Dash-separated with 2-digit year (base-order aware)
  m = /^(\d{1,2})-(\d{1,2})-(\d{2})$/.exec(s);
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = parseTwoDigitYear(m[3]);
    const mo = prefersUsDateOrder ? p1 : p2;
    const d = prefersUsDateOrder ? p2 : p1;
    if (mo <= 12 && d <= 31 && isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: prefersUsDateOrder
          ? m[1].length === 1
            ? 'M-d-yy'
            : 'MM-dd-yy'
          : m[1].length === 1
            ? 'd-M-yy'
            : 'dd-MM-yy',
      };
    }
  }

  // Space-separated numeric (base-order aware). UK: D M YYYY, US: M D YYYY.
  // Unambiguous wrong-order values (e.g. UK input "2 25 2026") stay text.
  m = /^(\d{1,2})\s+(\d{1,2})\s+(\d{4})$/.exec(s);
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = +m[3];
    const mo = prefersUsDateOrder ? p1 : p2;
    const d = prefersUsDateOrder ? p2 : p1;
    if (isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: prefersUsDateOrder
          ? m[1].length === 1
            ? 'M d yyyy'
            : 'MM dd yyyy'
          : m[1].length === 1
            ? 'd M yyyy'
            : 'dd MM yyyy',
      };
    }
  }

  // YYYY Month D: 2026 February 5 / 2026 Feb 5
  m = new RegExp(`^(\\d{4})\\s+(${MONTH_NAMES_RE})\\s+(\\d{1,2})$`, 'i').exec(
    s,
  );
  if (m) {
    const y = +m[1];
    const mo = MONTH_NAME_MAP[m[2].toLowerCase()];
    const d = +m[3];
    if (mo && isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: 'yyyy mmmm d',
      };
    }
  }

  // Month YYYY / Mon YYYY
  m = new RegExp(`^(${MONTH_NAMES_RE})\\s+(\\d{4})$`, 'i').exec(s);
  if (m) {
    const mo = MONTH_NAME_MAP[m[1].toLowerCase()];
    const y = +m[2];
    if (mo && isValidDateParts(y, mo, 1)) {
      const isAbbr = MONTH_ABBR_SET.has(m[1].toLowerCase());
      return {
        year: y,
        month: mo,
        day: 1,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: isAbbr ? 'mmm yyyy' : 'mmmm yyyy',
      };
    }
  }

  // Month D / Mon D (assume current year)
  m = new RegExp(`^(${MONTH_NAMES_RE})\\s+(\\d{1,2})$`, 'i').exec(s);
  if (m) {
    const mo = MONTH_NAME_MAP[m[1].toLowerCase()];
    const d = +m[2];
    if (mo && isValidDateParts(currentYear, mo, d)) {
      const isAbbr = MONTH_ABBR_SET.has(m[1].toLowerCase());
      return {
        year: currentYear,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: isAbbr ? 'mmm d' : 'mmmm d',
      };
    }
  }

  // Mon-YY / Mon YY
  m = new RegExp(`^(${MONTH_ABBR_RE})[-\\s](\\d{2})$`, 'i').exec(s);
  if (m) {
    const mo = MONTH_NAME_MAP[m[1].toLowerCase()];
    const y = parseTwoDigitYear(m[2]);
    if (mo && isValidDateParts(y, mo, 1)) {
      return {
        year: y,
        month: mo,
        day: 1,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: 'mmm-yy',
      };
    }
  }

  // M/YYYY or MM/YYYY
  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const mo = +m[1];
    const y = +m[2];
    if (isValidDateParts(y, mo, 1)) {
      return {
        year: y,
        month: mo,
        day: 1,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: m[1].length === 1 ? 'M/yyyy' : 'MM/yyyy',
      };
    }
  }

  // M-YYYY or MM-YYYY
  m = /^(\d{1,2})-(\d{4})$/.exec(s);
  if (m) {
    const mo = +m[1];
    const y = +m[2];
    if (isValidDateParts(y, mo, 1)) {
      return {
        year: y,
        month: mo,
        day: 1,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: m[1].length === 1 ? 'M-yyyy' : 'MM-yyyy',
      };
    }
  }

  // YYYY-M or YYYY-MM
  m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    if (isValidDateParts(y, mo, 1)) {
      return {
        year: y,
        month: mo,
        day: 1,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: m[2].length === 1 ? 'yyyy-M' : 'yyyy-MM',
      };
    }
  }

  // Slash-separated with 4-digit year + h:mm:ss AM/PM (base-order aware)
  m =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s(\d{1,2}):(\d{2}):(\d{2})\s?(AM|PM)$/i.exec(
      s,
    );
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = +m[3];
    const h = +m[4];
    const mi = +m[5];
    const sec = +m[6];
    const ampm = m[7].toUpperCase();
    const mo = prefersUsDateOrder ? p1 : p2;
    const d = prefersUsDateOrder ? p2 : p1;
    if (isValidDateParts(y, mo, d)) {
      let actualH = h;
      if (ampm === 'PM' && h !== 12) actualH = h + 12;
      if (ampm === 'AM' && h === 12) actualH = 0;
      return {
        year: y,
        month: mo,
        day: d,
        hours: actualH,
        minutes: mi,
        seconds: sec,
        formatType: prefersUsDateOrder
          ? m[1].length === 1
            ? 'M/d/yyyy h:mm:ss AM/PM'
            : 'MM/dd/yyyy h:mm:ss AM/PM'
          : m[1].length === 1
            ? 'd/M/yyyy h:mm:ss AM/PM'
            : 'dd/MM/yyyy h:mm:ss AM/PM',
      };
    }
  }

  // Mon D, YYYY h:mm AM/PM
  m = new RegExp(
    `^(${MONTH_ABBR_RE})\\s+(\\d{1,2}),\\s*(\\d{4})\\s+(\\d{1,2}):(\\d{2})\\s?(AM|PM)$`,
    'i',
  ).exec(s);
  if (m) {
    const mo = MONTH_NAME_MAP[m[1].toLowerCase()];
    const d = +m[2];
    const y = +m[3];
    const h = +m[4];
    const mi = +m[5];
    const ampm = m[6].toUpperCase();
    if (mo && isValidDateParts(y, mo, d)) {
      let actualH = h;
      if (ampm === 'PM' && h !== 12) actualH = h + 12;
      if (ampm === 'AM' && h === 12) actualH = 0;
      return {
        year: y,
        month: mo,
        day: d,
        hours: actualH,
        minutes: mi,
        seconds: 0,
        formatType: 'mmm d, yyyy h:mm AM/PM',
      };
    }
  }

  // D-Mon-YYYY h:mm AM/PM
  m = new RegExp(
    `^(\\d{1,2})-(${MONTH_ABBR_RE})-(\\d{4})\\s+(\\d{1,2}):(\\d{2})\\s?(AM|PM)$`,
    'i',
  ).exec(s);
  if (m) {
    const d = +m[1];
    const mo = MONTH_NAME_MAP[m[2].toLowerCase()];
    const y = +m[3];
    const h = +m[4];
    const mi = +m[5];
    const ampm = m[6].toUpperCase();
    if (mo && isValidDateParts(y, mo, d)) {
      let actualH = h;
      if (ampm === 'PM' && h !== 12) actualH = h + 12;
      if (ampm === 'AM' && h === 12) actualH = 0;
      return {
        year: y,
        month: mo,
        day: d,
        hours: actualH,
        minutes: mi,
        seconds: 0,
        formatType: 'd-mmm-yyyy h:mm AM/PM',
      };
    }
  }

  // Slash-separated with 4-digit year + HH:mm (base-order aware)
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s(\d{2}):(\d{2})$/.exec(s);
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = +m[3];
    const h = +m[4];
    const mi = +m[5];
    if (h > 23) return null;
    const mo = prefersUsDateOrder ? p1 : p2;
    const d = prefersUsDateOrder ? p2 : p1;
    if (isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: h,
        minutes: mi,
        seconds: 0,
        formatType: prefersUsDateOrder
          ? m[1].length === 1
            ? 'M/d/yyyy HH:mm'
            : 'MM/dd/yyyy HH:mm'
          : m[1].length === 1
            ? 'd/M/yyyy HH:mm'
            : 'dd/MM/yyyy HH:mm',
      };
    }
  }

  // Slash-separated with 4-digit year + H:mm:ss/HH:mm:ss (base-order aware)
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s(\d{1,2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = +m[3];
    const h = +m[4];
    const mi = +m[5];
    const sec = +m[6];
    if (h > 23) return null;
    const mo = prefersUsDateOrder ? p1 : p2;
    const d = prefersUsDateOrder ? p2 : p1;
    if (isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: h,
        minutes: mi,
        seconds: sec,
        formatType: prefersUsDateOrder
          ? m[1].length === 1
            ? 'M/d/yyyy HH:mm:ss'
            : 'MM/dd/yyyy HH:mm:ss'
          : m[1].length === 1
            ? 'd/M/yyyy HH:mm:ss'
            : 'dd/MM/yyyy HH:mm:ss',
      };
    }
  }

  // Day, Month D, YYYY | Day, Mon D, YYYY
  m = new RegExp(
    `^(?:${WEEKDAY_NAMES_RE}),\\s+(${MONTH_NAMES_RE})\\s+(\\d{1,2}),\\s*(\\d{4})$`,
    'i',
  ).exec(s);
  if (m) {
    const mo = MONTH_NAME_MAP[m[1].toLowerCase()];
    const d = +m[2];
    const y = +m[3];
    if (mo && isValidDateParts(y, mo, d)) {
      const isAbbr = MONTH_ABBR_SET.has(m[1].toLowerCase());
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: isAbbr ? 'day, mmm d, yyyy' : 'day, mmmm d, yyyy',
      };
    }
  }

  // Day, D Month YYYY | Day, D Mon YYYY
  m = new RegExp(
    `^(?:${WEEKDAY_NAMES_RE}),\\s+(\\d{1,2})\\s+(${MONTH_NAMES_RE})\\s+(\\d{4})$`,
    'i',
  ).exec(s);
  if (m) {
    const d = +m[1];
    const mo = MONTH_NAME_MAP[m[2].toLowerCase()];
    const y = +m[3];
    if (mo && isValidDateParts(y, mo, d)) {
      const isAbbr = MONTH_ABBR_SET.has(m[2].toLowerCase());
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: isAbbr ? 'day, d mmm yyyy' : 'day, d mmmm yyyy',
      };
    }
  }

  // Day, slash date (base-order aware)
  m = new RegExp(
    `^(?:${WEEKDAY_NAMES_RE}),\\s+(\\d{2})\\/(\\d{2})\\/(\\d{4})$`,
    'i',
  ).exec(s);
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = +m[3];
    const mo = prefersUsDateOrder ? p1 : p2;
    const d = prefersUsDateOrder ? p2 : p1;
    if (isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: prefersUsDateOrder ? 'day, MM/dd/yyyy' : 'day, dd/MM/yyyy',
      };
    }
  }

  // Dy, Mon D, YYYY | Dy Mon D, YYYY
  m = new RegExp(
    `^(?:${WEEKDAY_ABBR_RE}),?\\s+(${MONTH_ABBR_RE})\\s+(\\d{1,2}),\\s*(\\d{4})$`,
    'i',
  ).exec(s);
  if (m) {
    const mo = MONTH_NAME_MAP[m[1].toLowerCase()];
    const d = +m[2];
    const y = +m[3];
    if (mo && isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: 'dy, mmm d, yyyy',
      };
    }
  }

  // Dy, Mon D
  m = new RegExp(
    `^(?:${WEEKDAY_ABBR_RE}),\\s+(${MONTH_ABBR_RE})\\s+(\\d{1,2})$`,
    'i',
  ).exec(s);
  if (m) {
    const mo = MONTH_NAME_MAP[m[1].toLowerCase()];
    const d = +m[2];
    if (mo && isValidDateParts(currentYear, mo, d)) {
      return {
        year: currentYear,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: 'dy, mmm d',
      };
    }
  }

  // Dy, D Mon YYYY
  m = new RegExp(
    `^(?:${WEEKDAY_ABBR_RE}),\\s+(\\d{1,2})\\s+(${MONTH_ABBR_RE})\\s+(\\d{4})$`,
    'i',
  ).exec(s);
  if (m) {
    const d = +m[1];
    const mo = MONTH_NAME_MAP[m[2].toLowerCase()];
    const y = +m[3];
    if (mo && isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: 'dy, d mmm yyyy',
      };
    }
  }

  // Dy slash date (base-order aware)
  m = new RegExp(
    `^(?:${WEEKDAY_ABBR_RE})\\s+(\\d{2})\\/(\\d{2})\\/(\\d{4})$`,
    'i',
  ).exec(s);
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = +m[3];
    const mo = prefersUsDateOrder ? p1 : p2;
    const d = prefersUsDateOrder ? p2 : p1;
    if (isValidDateParts(y, mo, d)) {
      return {
        year: y,
        month: mo,
        day: d,
        hours: 0,
        minutes: 0,
        seconds: 0,
        formatType: prefersUsDateOrder ? 'dy MM/dd/yyyy' : 'dy dd/MM/yyyy',
      };
    }
  }

  return null;
}

function checkDateTime(str: string) {
  return detectDateFormat(str) !== null;
}

export function isdatetime(s: any) {
  if (s === null || s.toString().length < 5) {
    return false;
  }
  if (checkDateTime(s)) {
    return true;
  }
  return false;
}

export function diff(now: any, then: any) {
  return dayjs(now).diff(dayjs(then));
}

export function isdatatypemulti(s: any) {
  const type: any = {};

  if (isdatetime(s)) {
    type.date = true;
  }

  if (!Number.isNaN(parseFloat(s)) && !hasChinaword(s)) {
    type.num = true;
  }

  return type;
}

export function isdatatype(s: any) {
  let type = 'string';

  if (isdatetime(s)) {
    type = 'date';
  } else if (!Number.isNaN(parseFloat(s)) && !hasChinaword(s)) {
    type = 'num';
  }

  return type;
}

// 范围是否只包含部分合并单元格
export function hasPartMC(
  ctx: Context,
  cfg: any,
  r1: number,
  r2: number,
  c1: number,
  c2: number,
) {
  let ret = false;

  _.forEach(ctx.config.merge, (mc) => {
    if (r1 < mc.r) {
      if (r2 >= mc.r && r2 < mc.r + mc.rs - 1) {
        if (c1 >= mc.c && c1 <= mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c2 >= mc.c && c2 <= mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c1 < mc.c && c2 > mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
      } else if (r2 >= mc.r && r2 === mc.r + mc.rs - 1) {
        if (c1 > mc.c && c1 < mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c2 > mc.c && c2 < mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c1 === mc.c && c2 < mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c1 > mc.c && c2 === mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
      } else if (r2 > mc.r + mc.rs - 1) {
        if (c1 > mc.c && c1 <= mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c2 >= mc.c && c2 < mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c1 === mc.c && c2 < mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c1 > mc.c && c2 === mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
      }
    } else if (r1 === mc.r) {
      if (r2 < mc.r + mc.rs - 1) {
        if (c1 >= mc.c && c1 <= mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c2 >= mc.c && c2 <= mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c1 < mc.c && c2 > mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
      } else if (r2 >= mc.r + mc.rs - 1) {
        if (c1 > mc.c && c1 <= mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c2 >= mc.c && c2 < mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c1 === mc.c && c2 < mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
        if (c1 > mc.c && c2 === mc.c + mc.cs - 1) {
          ret = true;
          return false;
        }
      }
    } else if (r1 <= mc.r + mc.rs - 1) {
      if (c1 >= mc.c && c1 <= mc.c + mc.cs - 1) {
        ret = true;
        return false;
      }
      if (c2 >= mc.c && c2 <= mc.c + mc.cs - 1) {
        ret = true;
        return false;
      }
      if (c1 < mc.c && c2 > mc.c + mc.cs - 1) {
        ret = true;
        return false;
      }
    }
    return true;
  });

  return ret;
}
