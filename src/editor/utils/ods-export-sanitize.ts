/**
 * Fortune uses ct.t = 'g' (general) for plain text. SheetJS / ODS only
 * understand b|n|e|s|d|z|str. Writing 'g' drops those cells in Google Sheets
 * and can NRE in .NET ODS readers when paired with xlsx-js-style `s` objects.
 */

const SHEETJS_TYPES = new Set(['b', 'n', 'e', 's', 'd', 'z', 'str']);

export function toSheetJsCellType(
  fortuneOrSheetType: unknown,
  value: unknown,
): 'b' | 'n' | 'e' | 's' | 'd' | 'z' | 'str' {
  if (fortuneOrSheetType === 'd') return 'n';
  if (fortuneOrSheetType === 'inlineStr' || fortuneOrSheetType === 'g') {
    return 's';
  }
  if (
    typeof fortuneOrSheetType === 'string' &&
    SHEETJS_TYPES.has(fortuneOrSheetType)
  ) {
    return fortuneOrSheetType as 'b' | 'n' | 'e' | 's' | 'd' | 'z' | 'str';
  }
  if (typeof value === 'number' && Number.isFinite(value)) return 'n';
  if (typeof value === 'boolean') return 'b';
  if (value instanceof Date) return 'd';
  return 's';
}

/** Keep only fields the ODS writer handles; drop style blobs that crash parsers. */
export function sanitizeSheetJsCellForOds(cell: Record<string, unknown>): void {
  const t = toSheetJsCellType(cell.t, cell.v);
  let v = cell.v;
  if (t === 's' && v != null && typeof v !== 'string') {
    v = String(v);
  }
  const next: Record<string, unknown> = { t, v };
  if (typeof cell.f === 'string' && cell.f) next.f = cell.f;
  if (cell.w != null) next.w = cell.w;
  if (typeof cell.z === 'string' && cell.z && cell.z !== 'General') {
    next.z = cell.z;
  }
  Object.keys(cell).forEach((key) => {
    delete cell[key];
  });
  Object.assign(cell, next);
}

export function sanitizeWorksheetForOds(worksheet: Record<string, unknown>): void {
  delete worksheet.sheetFormat;
  Object.keys(worksheet).forEach((key) => {
    if (key.startsWith('!')) return;
    const cell = worksheet[key];
    if (cell && typeof cell === 'object') {
      sanitizeSheetJsCellForOds(cell as Record<string, unknown>);
    }
  });
}
