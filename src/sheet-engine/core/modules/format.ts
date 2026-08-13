import numeral from 'numeral';
import _ from 'lodash';
import { isRealNum, valueIsError, detectDateFormat } from './validation';
import { getDateBaseLocale } from './date-base-locale';
// @ts-ignore
import SSF from './ssf';
import { Cell, CellMatrix } from '../types';
import { getCellValue } from './cell';

const base1904 = new Date(1900, 2, 1, 0, 0, 0);

/** Below this absolute value, never use automatic scientific (Sheets-like). */
export const GS_PLAIN_MAX_ABS = 999999999999997;
/** Smallest 16-digit positive integer — use plain / text, not E-notation. */
export const GS_SIXTEEN_DIGIT_MIN_ABS = 1e15;

/** Scientific only in (GS_PLAIN_MAX_ABS, 1e15) — 999…997 itself stays plain. */
export function gsAllowsScientificMagnitude(av: number): boolean {
  return (
    Number.isFinite(av) &&
    av > GS_PLAIN_MAX_ABS &&
    av < GS_SIXTEEN_DIGIT_MIN_ABS
  );
}

/** Integer string (optional `-`, optional `,`) with ≥16 digits — store literally under General/Auto. */
export function isSixteenPlusDigitIntegerString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const t = value.trim().replace(/,/g, '');
  if (!/^-?\d+$/.test(t)) return false;
  const core = t.startsWith('-') ? t.slice(1) : t;
  return core.length >= 16;
}

/**
 * Display string for a JS number when `toString()` may use `e` notation.
 * Applies Sheets-like rules: no E below GS_PLAIN_MAX_ABS or at/above 16-digit scale.
 */
export function formatMForNumericCellAvoidingGsRules(v: number): string {
  const av = Math.abs(v);
  if (v === Infinity || v === -Infinity) return String(v);
  if (gsAllowsScientificMagnitude(av)) {
    const s = v.toString();
    let len = 0;
    if (s.toLowerCase().includes('e')) {
      const mant = s.split(/[eE]/)[0];
      if (mant.includes('.')) {
        len = Math.min(5, (mant.split('.')[1] || '').length);
      }
    } else if (s.includes('.')) {
      len = Math.min(5, (s.split('.')[1] || '').split(/[eE]/)[0].length);
    }
    return formatCompactScientific(v, len);
  }
  if (av >= GS_SIXTEEN_DIGIT_MIN_ABS) {
    return v.toLocaleString('en-US', {
      maximumFractionDigits: 50,
      useGrouping: false,
    });
  }
  return v.toLocaleString('en-US', {
    maximumFractionDigits: 21,
    useGrouping: false,
  });
}

function countSignificantDigits(v: number): number {
  if (!Number.isFinite(v) || v === 0) return 1;
  const mantissa = v
    .toExponential()
    .split('e')[0]
    .replace('-', '')
    .replace('.', '');
  const trimmed = mantissa.replace(/^0+/, '').replace(/0+$/, '');
  return trimmed.length || 1;
}

/**
 * Numeric safety gate for formula-computed numbers:
 * - integer beyond MAX_SAFE_INTEGER => scientific
 * - significant digits > 15 => scientific
 */
export function shouldUseScientificForComputedNumber(v: number): boolean {
  if (!Number.isFinite(v)) return false;
  if (Number.isInteger(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER) return true;
  return countSignificantDigits(v) > 15;
}

export function formatScientificForComputedNumber(v: number): string {
  const mantissa = v.toExponential().split('e')[0];
  let fracLen = 0;
  if (mantissa.includes('.')) {
    fracLen = (mantissa.split('.')[1] || '').length;
  }
  return formatCompactScientific(v, Math.min(5, Math.max(0, fracLen)));
}

export function formatCompactScientific(v: number, fractionDigits = 5): string {
  if (!Number.isFinite(v)) return String(v);
  const raw = v.toExponential(Math.max(0, Math.min(20, fractionDigits)));
  const [mantissaRaw, expRaw = '0'] = raw.split('e');
  const mantissa = mantissaRaw
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '')
    .replace(/\.$/, '');
  const expNum = Number(expRaw);
  const expSign = expNum >= 0 ? '+' : '-';
  const expAbs = Math.abs(expNum).toString().padStart(2, '0');
  return `${mantissa}E${expSign}${expAbs}`;
}

/**
 * Sheets-like Auto decimal display:
 * keep about 10 visible digits total (integer digits + decimal digits), with rounding.
 * Examples:
 * - 999999999.478 -> 999999999.5
 * - 123456.123456 -> 123456.1235
 */
export function formatGeneralAutoDecimalWithTenDigitRule(
  v: number,
): string | null {
  if (!Number.isFinite(v)) return null;
  if (Number.isInteger(v)) return null;
  const av = Math.abs(v);
  // Keep scientific handling in the existing special band.
  if (gsAllowsScientificMagnitude(av)) return null;

  const leftDigits = av >= 1 ? Math.floor(Math.log10(av)) + 1 : 1;
  const maxDecimals = Math.max(0, 10 - leftDigits);
  let rounded = Number(v.toFixed(maxDecimals));
  if (Object.is(rounded, -0)) rounded = 0;
  const fixed = rounded.toFixed(maxDecimals);
  return fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

export function datenum_local(v: Date, date1904?: number) {
  let epoch = Date.UTC(
    v.getFullYear(),
    v.getMonth(),
    v.getDate(),
    v.getHours(),
    v.getMinutes(),
    v.getSeconds(),
  );
  const dnthresh_utc = Date.UTC(1899, 11, 31, 0, 0, 0);

  if (date1904) epoch -= 1461 * 24 * 60 * 60 * 1000;
  else if (v >= base1904) epoch += 24 * 60 * 60 * 1000;
  return (epoch - dnthresh_utc) / (24 * 60 * 60 * 1000);
}

export function genarate(value: string | number | boolean) {
  // 万 单位格式增加！！！
  let m: string | null = null;
  let ct: any = {};
  let v: any = value;

  if (_.isNil(value)) {
    return null;
  }

  if (
    /^-?(?:\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value as string) &&
    !Array.isArray(value)
  ) {
    value = value as string;
    // 表述金额的字符串，如：12,000.00 或者 -12,000.00
    m = value;
    v = Number(value.replace(/,/g, ''));
    let fa = '#,##0';
    if (value.split('.')[1]) {
      fa = '#,##0.';
      for (let i = 0; i < value.split('.')[1].length; i += 1) {
        fa += 0;
      }
    }
    ct = { fa, t: 'n' };
  } else if (value.toString().substring(0, 1) === "'") {
    m = value.toString().substring(1);
    ct = { fa: '@', t: 's' };
  } else if (value.toString().toUpperCase() === 'TRUE') {
    m = 'TRUE';
    ct = { fa: 'General', t: 'b' };
    v = true;
  } else if (value.toString().toUpperCase() === 'FALSE') {
    m = 'FALSE';
    ct = { fa: 'General', t: 'b' };
    v = false;
  } else if (valueIsError(value.toString())) {
    m = value.toString();
    ct = { fa: 'General', t: 'e' };
  } else if (
    /^\d{6}(18|19|20)?\d{2}(0[1-9]|1[12])(0[1-9]|[12]\d|3[01])\d{3}(\d|X)$/i.test(
      value as string,
    )
  ) {
    m = value.toString();
    ct = { fa: '@', t: 's' };
  } else if (isSixteenPlusDigitIntegerString(value)) {
    const raw = (value as string).trim().replace(/,/g, '');
    m = raw;
    v = raw;
    ct = { fa: 'General', t: 'g' };
  } else if (
    isRealNum(value) &&
    Math.abs(parseFloat(value as string)) > 0 &&
    (Math.abs(parseFloat(value as string)) < 1e-9 ||
      gsAllowsScientificMagnitude(Math.abs(parseFloat(value as string))))
  ) {
    v = parseFloat(value as string);
    const str = v.toExponential();
    let precision = 0;
    if (str.indexOf('.') > -1) {
      precision = Math.min(5, str.split('.')[1].split('e')[0].length);
    }
    const optionalDecimals =
      precision > 0 ? `.${new Array(precision + 1).join('#')}` : '';
    ct = { fa: `#0${optionalDecimals}E+00`, t: 'n' };
    m = formatCompactScientific(v, precision);
  } else if (value.toString().indexOf('%') > -1) {
    const index = value.toString().indexOf('%');
    const value2 = value.toString().substring(0, index);
    const value3 = value2.replace(/,/g, '');

    if (index === value.toString().length - 1 && isRealNum(value3)) {
      if (value2.indexOf('.') > -1) {
        if (value2.indexOf('.') === value2.lastIndexOf('.')) {
          const value4 = value2.split('.')[0];
          const value5 = value2.split('.')[1];

          let len = value5.length;
          if (len > 9) {
            len = 9;
          }

          if (value4.indexOf(',') > -1) {
            let isThousands = true;
            const ThousandsArr = value4.split(',');

            for (let i = 1; i < ThousandsArr.length; i += 1) {
              if (ThousandsArr[i].length < 3) {
                isThousands = false;
                break;
              }
            }

            if (isThousands) {
              ct = {
                fa: `#,##0.${new Array(len + 1).join('0')}%`,
                t: 'n',
              };
              v = numeral(value).value();
              m = SSF.format(ct.fa, v);
            } else {
              m = value.toString();
              ct = { fa: '@', t: 's' };
            }
          } else {
            ct = { fa: `0.${new Array(len + 1).join('0')}%`, t: 'n' };
            v = numeral(value).value();
            m = SSF.format(ct.fa, v);
          }
        } else {
          m = value.toString();
          ct = { fa: '@', t: 's' };
        }
      } else if (value2.indexOf(',') > -1) {
        let isThousands = true;
        const ThousandsArr = value2.split(',');

        for (let i = 1; i < ThousandsArr.length; i += 1) {
          if (ThousandsArr[i].length < 3) {
            isThousands = false;
            break;
          }
        }

        if (isThousands) {
          ct = { fa: '#,##0%', t: 'n' };
          v = numeral(value).value();
          m = SSF.format(ct.fa, v);
        } else {
          m = value.toString();
          ct = { fa: '@', t: 's' };
        }
      } else {
        ct = { fa: '0%', t: 'n' };
        v = numeral(value).value();
        m = SSF.format(ct.fa, v);
      }
    } else {
      m = value.toString();
      ct = { fa: '@', t: 's' };
    }
  } else if (value.toString().indexOf('.') > -1) {
    if (value.toString().indexOf('.') === value.toString().lastIndexOf('.')) {
      const value1 = value.toString().split('.')[0];
      const value2 = value.toString().split('.')[1];

      let len = value2.length;
      if (len > 9) {
        len = 9;
      }

      if (value1.indexOf(',') > -1) {
        let isThousands = true;
        const ThousandsArr = value1.split(',');

        for (let i = 1; i < ThousandsArr.length; i += 1) {
          if (!isRealNum(ThousandsArr[i]) || ThousandsArr[i].length < 3) {
            isThousands = false;
            break;
          }
        }

        if (isThousands) {
          ct = { fa: `#,##0.${new Array(len + 1).join('0')}`, t: 'n' };
          v = numeral(value).value();
          m = SSF.format(ct.fa, v);
        } else {
          m = value.toString();
          ct = { fa: '@', t: 's' };
        }
      } else {
        if (isRealNum(value1) && isRealNum(value2)) {
          ct = { fa: `0.${new Array(len + 1).join('0')}`, t: 'n' };
          v = numeral(value).value();
          m = SSF.format(ct.fa, v);
        } else {
          m = value.toString();
          ct = { fa: '@', t: 's' };
        }
      }
    } else {
      m = value.toString();
      ct = { fa: '@', t: 's' };
    }
  } else if (isRealNum(value)) {
    const pv = parseFloat(value as string);
    const av = Math.abs(pv);
    v = pv;
    ct = { fa: 'General', t: 'n' };
    if (av >= GS_SIXTEEN_DIGIT_MIN_ABS) {
      m = pv.toLocaleString('en-US', {
        maximumFractionDigits: 50,
        useGrouping: false,
      });
    } else {
      m = pv.toString();
    }
  } else if (typeof value === 'string') {
    const df = detectDateFormat(value.toString());
    if (df) {
      const dateObj = new Date(
        df.year,
        df.month - 1,
        df.day,
        df.hours,
        df.minutes,
        df.seconds,
      );
      v = datenum_local(dateObj);
      ct.t = 'd';

      const map: Record<string, string> = {
        'yyyy-MM-dd': 'yyyy-MM-dd',
        'yyyy-MM-dd HH:mm': 'yyyy-MM-dd HH:mm',
        'yyyy-MM-ddTHH:mm': 'yyyy-MM-dd HH:mm',
        'yyyy-MM': 'yyyy-mm',
        'yyyy mmmm d': 'yyyy mmmm d',
        'yyyy/MM/dd': 'yyyy/MM/dd',
        'yyyy/MM/dd HH:mm': 'yyyy/MM/dd HH:mm',
        'yyyy.MM.dd': 'yyyy.MM.dd',
        'MM/dd/yyyy h:mm AM/PM': 'MM/dd/yyyy h:mm AM/PM',
        'MM/dd/yyyy h:mm:ss AM/PM': 'MM/dd/yyyy h:mm:ss AM/PM',
        'dd/MM/yyyy h:mm AM/PM': 'dd/MM/yyyy h:mm AM/PM',
        'd/M/yyyy h:mm AM/PM': 'd/M/yyyy h:mm AM/PM',
        'dd/MM/yyyy h:mm:ss AM/PM': 'dd/MM/yyyy h:mm:ss AM/PM',
        'MM/dd/yyyy': 'MM/dd/yyyy',
        'M/d/yyyy HH:mm:ss': 'm/d/yyyy hh:mm:ss',
        'MM/dd/yyyy HH:mm:ss': 'MM/dd/yyyy hh:mm:ss',
        'd/M/yyyy HH:mm:ss': 'd/M/yyyy hh:mm:ss',
        'dd/MM/yyyy HH:mm:ss': 'dd/MM/yyyy hh:mm:ss',
        'M/d/yyyy': 'M/d/yyyy',
        'M/d/yy': 'm/d/yy',
        'd/M/yyyy': 'd/M/yyyy',
        'd/M/yy': 'd/M/yy',
        'M/d/yyyy HH:mm': 'M/d/yyyy hh:mm',
        'MM/dd/yyyy HH:mm': 'MM/dd/yyyy hh:mm',
        'd/M/yyyy HH:mm': 'd/M/yyyy hh:mm',
        'dd/MM/yyyy HH:mm': 'dd/MM/yyyy hh:mm',
        'MM/dd/yy': 'MM/dd/yy',
        'dd/MM/yy': 'dd/MM/yy',
        'dd/MM/yyyy': 'dd/MM/yyyy',
        'd-M-yyyy': 'd-m-yyyy',
        'dd-MM-yyyy': 'dd-MM-yyyy',
        'dd.MM.yyyy': 'dd.MM.yyyy',
        'M-d-yyyy': 'm-d-yyyy',
        'MM-dd-yyyy': 'mm-dd-yyyy',
        'd-M-yy': 'd-m-yy',
        'dd-MM-yy': 'dd-mm-yy',
        'M-d-yy': 'm-d-yy',
        'MM-dd-yy': 'mm-dd-yy',
        'M d yyyy': 'm d yyyy',
        'MM dd yyyy': 'mm dd yyyy',
        'MM/yyyy': 'mm/yyyy',
        'M/yyyy': 'm/yyyy',
        'MM-yyyy': 'mm-yyyy',
        'M-yyyy': 'm-yyyy',
        'yyyy-M': 'yyyy-m',
        'mmmm yyyy': 'mmmm yyyy',
        'mmm yyyy': 'mmm yyyy',
        'mmmm d': 'mmmm d',
        'mmm d': 'mmm d',
        'd-mmm-yyyy': 'd-mmm-yyyy',
        'd-mmm-yy': 'd-mmm-yy',
        'named-mdy-full': 'mmmm d, yyyy',
        'named-mdy-abbr': 'mmm d, yyyy',
        'named-dmy-full': 'd mmmm yyyy',
        'named-dmy-abbr': 'd mmm yyyy',
        'named-abbr-dashes': 'mmm-d-yyyy',
        'mmm d, yyyy h:mm AM/PM': 'mmm d, yyyy h:mm AM/PM',
        'd-mmm-yyyy h:mm AM/PM': 'd-mmm-yyyy h:mm AM/PM',
        'day, mmmm d, yyyy': 'dddd, mmmm d, yyyy',
        'day, mmm d, yyyy': 'dddd, mmm d, yyyy',
        'day, d mmmm yyyy': 'dddd, d mmmm yyyy',
        'day, d mmm yyyy': 'dddd, d mmm yyyy',
        'day, dd/MM/yyyy': 'dddd, dd/mm/yyyy',
        'day, MM/dd/yyyy': 'dddd, mm/dd/yyyy',
        'dy, mmm d, yyyy': 'ddd, mmm d, yyyy',
        'dy, mmm d': 'ddd, mmm d',
        'dy, d mmm yyyy': 'ddd, d mmm yyyy',
        'dy dd/MM/yyyy': 'ddd dd/mm/yyyy',
        'dy MM/dd/yyyy': 'ddd mm/dd/yyyy',
      };

      ct.fa =
        map[df.formatType] ||
        (getDateBaseLocale() === 'us' ? 'MM/dd/yyyy' : 'dd/MM/yyyy');
      m = SSF.format(ct.fa, v);
    } else {
      m = String(value);
      ct.fa = 'General';
      ct.t = 'g';
    }
  } else {
    m = String(value);
    ct.fa = 'General';
    ct.t = 'g';
  }

  return [m, ct, v];
}

/** Crypto tickers for typed prefix (e.g. BTC123) — keep aligned with toolbar CRYPTO_OPTIONS. */
export const TYPED_CRYPTO_CURRENCY_PREFIXES = ['BTC', 'ETH', 'SOL'] as const;

function getSortedFiatPrefixSymbols(currencyDetail: unknown): string[] {
  const fiatArr = Array.isArray(currencyDetail)
    ? currencyDetail.filter((c: { pos?: string }) => c && c.pos !== 'after')
    : [];
  const indexByValue = new Map<string, number>();
  fiatArr.forEach((c: { value?: string }, i: number) => {
    if (c?.value && !indexByValue.has(c.value)) indexByValue.set(c.value, i);
  });
  return [
    ...new Set(
      fiatArr
        .map((c: { value?: string }) => c.value)
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  ].sort(
    (a: string, b: string) =>
      b.length - a.length ||
      (indexByValue.get(a) ?? 0) - (indexByValue.get(b) ?? 0),
  );
}

/**
 * True when `fa` matches formats produced by typed currency/crypto prefix (or the same shape).
 * Used so the format dropdown shows "Currency" instead of mislabeling `#,##0` masks as "Number".
 */
export function isTypedCurrencyDisplayFormat(
  fa: string | undefined,
  currencyDetail: unknown,
): boolean {
  if (!fa) return false;
  for (const c of TYPED_CRYPTO_CURRENCY_PREFIXES) {
    if (fa.includes(`"${c}"`)) return true;
  }
  return getSortedFiatPrefixSymbols(currencyDetail).some(
    (sym) =>
      (fa.startsWith(sym) || fa.startsWith(quoteSsfLiteral(sym))) &&
      /#,##0/.test(fa),
  );
}

/**
 * True for currency / accounting / crypto number formats where we should keep `fa` when the user
 * types plain text, so a later numeric entry still formats like Google Sheets.
 */
export function isCurrencyLikeNumberFormat(
  fa: string | undefined,
  currencyDetail: unknown,
): boolean {
  if (!fa || fa === 'General' || fa === '@') return false;
  if (isTypedCurrencyDisplayFormat(fa, currencyDetail)) return true;
  // Accounting: _("$"* #,##0...
  if (fa.includes('_("') && /#,?#+0/.test(fa)) return true;
  // Toolbar Currency / fiat with symbol + grouping (not plain #,##0 number preset)
  if (/#,##0/.test(fa) && !fa.includes('%')) {
    const syms = getSortedFiatPrefixSymbols(currencyDetail);
    if (syms.some((sym) => fa.includes(sym))) return true;
  }
  return false;
}

/**
 * If the user types a known currency/crypto prefix immediately followed by a parseable number
 * (e.g. `$1,234.5`, `€100`, `BTC1.5`), return numeric cell value + matching currency format.
 * Uses locale `currencyDetail` (fiat symbols); object-shaped locales yield no fiat prefixes.
 */
export function parseCurrencyPrefixedInput(
  raw: string,
  currencyDetail: unknown,
): [string, { fa: string; t: string }, number] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let s = raw.trim();
  if (s.startsWith('=') || s.startsWith("'")) return null;

  let sign = 1;
  if (s.startsWith('-')) {
    sign = -1;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  if (s === '') return null;

  const fiatSymbols = getSortedFiatPrefixSymbols(currencyDetail);

  const cryptoSorted = [...TYPED_CRYPTO_CURRENCY_PREFIXES].sort(
    (a, b) => b.length - a.length,
  );

  const entries: { sym: string; kind: 'crypto' | 'fiat' }[] = [
    ...cryptoSorted.map((sym) => ({ sym, kind: 'crypto' as const })),
    ...fiatSymbols.map((sym) => ({ sym, kind: 'fiat' as const })),
  ].sort((a, b) => b.sym.length - a.sym.length);

  for (const { sym, kind } of entries) {
    if (!s.startsWith(sym)) continue;
    const rest = s.slice(sym.length).trim();
    if (rest === '') continue;
    if (rest.includes('%')) continue;

    const g = genarate(rest);
    if (!g) continue;
    const [, ct] = g;
    if (ct.t !== 'n' || String(ct.fa || '').includes('%')) continue;
    const vNum = g[2];
    if (typeof vNum !== 'number' || !Number.isFinite(vNum)) continue;

    const finalV = sign * vNum;
    if (!Number.isFinite(finalV)) continue;

    // Integer-style currency (no fractional places); values round in display via SSF.
    // No space before `#,##0` so masks align with locale Currency presets and toolbar labeling.
    if (kind === 'crypto') {
      const fa = `0 "${sym}"`;
      const ctOut = { fa, t: 'n' };
      const m = SSF.format(fa, finalV);
      return [m, ctOut, finalV];
    }
    const fa = buildFiatCurrencyFormat(sym, 0, { spaced: false });
    const ctOut = { fa, t: 'n' };
    const m = SSF.format(fa, finalV);
    return [m, ctOut, finalV];
  }

  return null;
}

export function genarateOrCurrencyPrefixed(
  vupdateStr: string,
  vupdate: any,
  currencyDetail: unknown,
): ReturnType<typeof genarate> {
  const cur = parseCurrencyPrefixedInput(vupdateStr, currencyDetail);
  if (cur) return cur;
  return genarate(vupdate);
}

/** Wrap text for SSF/Excel `fa` so letters like M/H/S/d are not date/time tokens (e.g. MXN → 5XN). */
export function quoteSsfLiteral(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/** Build a fiat currency display mask safe for SSF.format (always quotes the symbol). */
export function buildFiatCurrencyFormat(
  symbol: string,
  decimals = 2,
  options?: { spaced?: boolean },
): string {
  const dp = '0'.repeat(Math.max(0, decimals));
  const mask = decimals > 0 ? `#,##0.${dp}` : '#,##0';
  const sep = options?.spaced === false ? '' : ' ';
  return `${quoteSsfLiteral(symbol)}${sep}${mask}`;
}

export function update(fmt: string, v: any) {
  return SSF.format(fmt, v);
}

/** Max decimal places for toolbar +/- on General (Auto) without switching to a numeric `fa`. */
export const MAX_GENERAL_AUTO_DP = 15;

/** Count decimal places currently shown for a General/Auto numeric cell. */
export function countGeneralDisplayDecimalPlaces(cell: Cell): number {
  if (typeof cell.m === 'string' && cell.m.includes('.')) {
    const digits = cell.m.split('.')[1]?.replace(/[^0-9]/g, '') ?? '';
    return digits.length;
  }
  const v = cell.v;
  if (!isRealNum(v)) return 0;
  const num = Number(v);
  if (Number.isInteger(num)) return 0;
  const auto = formatGeneralAutoDecimalWithTenDigitRule(num);
  if (auto?.includes('.')) {
    return auto.split('.')[1].length;
  }
  const s = num.toString();
  if (s.includes('.')) {
    const frac = s.split('.')[1];
    return frac.replace(/0+$/, '').length || frac.length;
  }
  return 0;
}

/** Effective decimal places for toolbar +/- (explicit `ct.dp` or inferred from display). */
export function getEffectiveGeneralDp(cell: Cell): number {
  if (cell.ct?.dp != null && cell.ct.dp >= 0) {
    return Math.min(MAX_GENERAL_AUTO_DP, Math.floor(cell.ct.dp));
  }
  return countGeneralDisplayDecimalPlaces(cell);
}

/**
 * Recompute `m` for numeric cells with `fa === "General"`.
 * When `ct.dp` is set (0..MAX), uses fixed decimals like Sheets Auto + decimal buttons.
 * Otherwise uses the usual `genarate` General display.
 */
export function refreshGeneralNumericDisplay(cell: Cell): void {
  const ct = cell.ct;
  if (!ct || ct.fa !== 'General') return;
  const v = cell.v;
  if (v === Infinity || v === -Infinity) {
    cell.m = String(v);
    return;
  }
  // Long integer strings: keep exact digits (IEEE doubles cannot represent them).
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    const core = v.startsWith('-') ? v.slice(1) : v;
    if (core.length >= 16) {
      cell.m = v;
      return;
    }
  }
  if (!isRealNum(v)) return;
  const num = Number(v);
  if (ct.dp != null && ct.dp >= 0) {
    if (ct.dp === 0) {
      const s = num.toString();
      if (s.toLowerCase().includes('e')) {
        const g = genarate(num);
        if (g) cell.m = g[0].toString();
        return;
      }
      cell.m = String(Math.round(num));
      return;
    }
    const d = Math.min(MAX_GENERAL_AUTO_DP, Math.max(1, Math.floor(ct.dp)));
    const s = num.toString();
    if (s.toLowerCase().includes('e')) {
      const g = genarate(num);
      if (g) cell.m = g[0].toString();
      return;
    }
    cell.m = num.toFixed(d);
    return;
  }
  const autoDecimal = formatGeneralAutoDecimalWithTenDigitRule(num);
  if (autoDecimal != null) {
    cell.m = autoDecimal;
    return;
  }
  const g = genarate(num);
  if (g) cell.m = g[0].toString();
}

export function is_date(fmt: string, v?: any) {
  return SSF.is_date(fmt, v);
}

function fuzzynum(s: string | number) {
  let v = Number(s);
  if (typeof s === 'number') {
    return s;
  }
  if (!Number.isNaN(v)) return v;
  let wt = 1;
  let ss = s
    .replace(/([\d]),([\d])/g, '$1$2')
    .replace(/[$]/g, '')
    .replace(/[%]/g, () => {
      wt *= 100;
      return '';
    });
  v = Number(ss);
  if (!Number.isNaN(v)) return v / wt;
  ss = ss.replace(/[(](.*)[)]/, ($$, $1) => {
    wt = -wt;
    return $1;
  });
  v = Number(ss);
  if (!Number.isNaN(v)) return v / wt;
  return v;
}

export function valueShowEs(r: number, c: number, d: CellMatrix) {
  let value = getCellValue(r, c, d, 'm');
  if (value == null) {
    value = getCellValue(r, c, d, 'v');
  } else {
    if (!Number.isNaN(fuzzynum(value))) {
      if (_.isString(value) && value.indexOf('%') > -1) {
      } else {
        value = getCellValue(r, c, d, 'v');
      }
    }
    // else if (!isNaN(parseDate(value).getDate())){
    else if (d[r]?.[c]?.ct?.t === 'd') {
    } else if (d[r]?.[c]?.ct?.t === 'b') {
    } else {
      value = getCellValue(r, c, d, 'v');
    }
  }
  return value;
}
