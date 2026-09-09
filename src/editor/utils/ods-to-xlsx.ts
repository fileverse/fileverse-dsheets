import { read as XLSXRead, write as XLSXWrite } from 'xlsx-js-style';

/**
 * Convert an ODS file to an XLSX File so we can reuse the existing LuckyExcel
 * + ExcelJS import pipeline (XLSX-only). Values, formulas, and sheets are
 * preserved; LibreOffice-specific styling may be reduced.
 */
export async function convertOdsFileToXlsxFile(file: File): Promise<File> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSXRead(buffer, {
    type: 'array',
    cellDates: true,
    dense: false,
  });
  const xlsxBuffer: ArrayBuffer = XLSXWrite(workbook, {
    bookType: 'xlsx',
    type: 'array',
    compression: true,
    cellDates: true,
  });
  const baseName = file.name.replace(/\.ods$/i, '') || 'import';
  return new File([xlsxBuffer], `${baseName}.xlsx`, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
