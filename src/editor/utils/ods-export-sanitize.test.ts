import { describe, expect, it } from 'vitest';
import { utils as XLSXUtil, write as XLSXWrite, read as XLSXRead } from 'xlsx-js-style';
import {
  sanitizeWorksheetForOds,
  toSheetJsCellType,
} from './ods-export-sanitize';

describe('toSheetJsCellType', () => {
  it('maps Fortune general text to shared-string', () => {
    expect(toSheetJsCellType('g', 'Dulce')).toBe('s');
  });

  it('keeps numbers as n', () => {
    expect(toSheetJsCellType('n', 32)).toBe('n');
  });
});

describe('sanitizeWorksheetForOds', () => {
  it('round-trips text and numbers through ODS write/read', () => {
    const worksheet: any = XLSXUtil.aoa_to_sheet([
      [0, 'First Name', 32, '15/10/2017'],
      [1, 'Mara', 25, '16/08/2016'],
    ]);
    worksheet.B1.t = 'g';
    worksheet.B1.s = { font: { sz: 10, color: { rgb: undefined } } };
    worksheet.sheetFormat = { defaultRowHeight: '15' };

    sanitizeWorksheetForOds(worksheet);

    expect(worksheet.B1.t).toBe('s');
    expect(worksheet.B1.s).toBeUndefined();
    expect(worksheet.sheetFormat).toBeUndefined();

    const workbook = XLSXUtil.book_new();
    XLSXUtil.book_append_sheet(workbook, worksheet, 'Sheet1');
    const ods = XLSXWrite(workbook, {
      bookType: 'ods',
      type: 'array',
      compression: true,
    });
    const back = XLSXRead(ods, { type: 'array' });
    const sheet = back.Sheets.Sheet1;
    expect(sheet.B1.v).toBe('First Name');
    expect(sheet.B2.v).toBe('Mara');
    expect(Number(sheet.A1.v)).toBe(0);
    expect(sheet.C1.v).toBe(32);
    expect(String(sheet.D1.v)).toContain('15/10/2017');
  });
});
