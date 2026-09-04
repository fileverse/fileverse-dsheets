export type DateBaseLocale = 'uk' | 'us';

let activeDateBaseLocale: DateBaseLocale = 'uk';

export function normalizeDateBaseLocale(locale: unknown): DateBaseLocale {
  return locale === 'us' ? 'us' : 'uk';
}

export function setDateBaseLocale(locale: unknown): void {
  activeDateBaseLocale = normalizeDateBaseLocale(locale);
}

export function getDateBaseLocale(): DateBaseLocale {
  return activeDateBaseLocale;
}

export function isUsDateBaseLocale(): boolean {
  return activeDateBaseLocale === 'us';
}

/** Standard Date toolbar / formula display format (no leading zeros). */
export function getCanonicalDateDisplayFormat(hasTime = false): string {
  if (isUsDateBaseLocale()) {
    return hasTime ? 'M/d/yyyy hh:mm AM/PM' : 'M/d/yyyy';
  }
  return hasTime ? 'd/M/yyyy hh:mm AM/PM' : 'd/M/yyyy';
}

export function getCanonicalDateEditFormat(hasTime: boolean): string {
  if (isUsDateBaseLocale()) {
    return hasTime ? 'M/d/yyyy HH:mm:ss' : 'M/d/yyyy';
  }
  return hasTime ? 'd/M/yyyy HH:mm:ss' : 'd/M/yyyy';
}

function normalizeDateFormatTokenOrder(format: string): Array<'d' | 'm' | 'y'> {
  if (!format) return [];
  const lower = format.toLowerCase();
  const withoutQuoted = lower.replace(/"[^"]*"/g, '');
  const withoutBracketed = withoutQuoted.replace(/\[[^\]]*]/g, '');
  const datePart = withoutBracketed.split(/(?:am\/pm|h+)/i)[0] || '';
  const tokenGroups = datePart.match(/[dmy]+/g) || [];
  const seq = tokenGroups
    .map((g) => g[0] as 'd' | 'm' | 'y')
    .filter((token, idx, arr) => idx === 0 || token !== arr[idx - 1]);
  return seq;
}

function hasOrderedDateParts(
  format: string,
  order: Array<'d' | 'm' | 'y'>,
): boolean {
  const seq = normalizeDateFormatTokenOrder(format);
  if (seq.length === 0) return false;
  const i0 = seq.indexOf(order[0]);
  const i1 = seq.indexOf(order[1]);
  const i2 = seq.indexOf(order[2]);
  return i0 !== -1 && i1 !== -1 && i2 !== -1 && i0 < i1 && i1 < i2;
}

function hasTextualMonthDateFormat(format: string): boolean {
  if (!format) return false;
  const lower = format.toLowerCase();
  const withoutQuoted = lower.replace(/"[^"]*"/g, '');
  const withoutBracketed = withoutQuoted.replace(/\[[^\]]*]/g, '');
  const datePart = withoutBracketed.split(/(?:am\/pm|h+)/i)[0] || '';
  const hasTextMonth = /m{3,}/.test(datePart);
  if (!hasTextMonth) return false;
  const tokenGroups = datePart.match(/[dmy]+/g) || [];
  const hasDay = tokenGroups.some((g) => g[0] === 'd');
  const hasYear = tokenGroups.some((g) => g[0] === 'y');
  return hasDay && hasYear;
}

export function shouldPreserveDateFormatForEdit(format: string): boolean {
  if (!format || format === 'General' || format === '@') return false;
  // Preserve text-month formats (e.g. "mmm dd, yyyy") across both locales.
  if (hasTextualMonthDateFormat(format)) return true;
  if (isUsDateBaseLocale()) {
    return (
      hasOrderedDateParts(format, ['m', 'd', 'y']) ||
      hasOrderedDateParts(format, ['y', 'm', 'd'])
    );
  }
  return (
    hasOrderedDateParts(format, ['d', 'm', 'y']) ||
    hasOrderedDateParts(format, ['y', 'm', 'd'])
  );
}

export function getDateEditFormatForCell(
  cellDateFormat: string,
  hasTime: boolean,
): string {
  if (shouldPreserveDateFormatForEdit(cellDateFormat)) {
    return cellDateFormat;
  }
  return getCanonicalDateEditFormat(hasTime);
}
