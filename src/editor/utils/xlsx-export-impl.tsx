/* eslint-disable @typescript-eslint/no-explicit-any */
import { utils as XLSXUtil, write as XLSXWrite } from 'xlsx-js-style';
import { Workbook as ExcelJSWorkbook } from 'exceljs';
import * as Y from 'yjs';
import { WorkbookInstance } from '@sheet-engine/react';
import { MutableRefObject } from 'react';
import { toast } from '@fileverse/ui';
import { applyBordersToWorksheet } from './xlsx-border-utils';
import { addFortuneImagesToWorksheet } from './xlsx-image-utils';
import { exportConditionalFormatting } from './xlsx-cf-export-utils';
import { patchXlsxCf, type SheetCfPatch } from './xlsx-cf-postprocess';
import {
  buildExcelJsRichText,
  applyRichTextToWorksheet,
  type CellRichTextValue,
} from './xlsx-richtext-utils';
import { buildSheetDataMatrixForExport } from '../../sheet-engine/core/utils/range-format';
import { expandSheetDataVerification } from './import-compaction';
import {
  concatInlineStrRunsText,
  getFirstHyperlinkEntry,
} from './xlsx-hyperlink-inline';

function sheetModelHasFilter(sheetModel: any): boolean {
  const filter = sheetModel?.filter;
  const filterSelect = sheetModel?.filter_select;
  const hasFilterConfig = !!(filter && Object.keys(filter).length > 0);
  const hasFilterSelection =
    !!filterSelect &&
    (Array.isArray(filterSelect.row) || Array.isArray(filterSelect.column));
  return hasFilterConfig || hasFilterSelection;
}

const parseColorToHex = (color: string): string | null => {
  if (!color || typeof color !== 'string') return null;

  // Trim & lowercase for detection
  const c = color.trim().toLowerCase();

  // CASE 1: Already HEX (#fff or #ffffff)
  if (c.startsWith('#')) {
    const hex = c.replace('#', '').toUpperCase();

    if (hex.length === 3) {
      // Expand shortened hex (#f00 → #FF0000)
      return hex
        .split('')
        .map((x) => x + x)
        .join('')
        .toUpperCase();
    }

    if (hex.length === 6) return hex;
    return null; // invalid hex
  }

  // -------------------------------
  // CASE 2: RGB or RGBA
  // supports:
  // rgb(255,0,0)
  // rgba(255,0,0,1)
  // rgba(255 0 0 / 1)
  // rgb(  255 , 100 ,   0 )
  // -------------------------------
  const rgbRegex =
    /rgba?\s*\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+[\d.]+)?\s*\)/i;

  const match = c.match(rgbRegex);

  if (match) {
    const r = Math.min(255, Math.max(0, parseFloat(match[1])));
    const g = Math.min(255, Math.max(0, parseFloat(match[2])));
    const b = Math.min(255, Math.max(0, parseFloat(match[3])));

    return ((1 << 24) + (r << 16) + (g << 8) + b)
      .toString(16)
      .slice(1)
      .toUpperCase();
  }

  // Unknown format → ignore styling
  return null;
};

export const handleExportToXLSX = async (
  workbookRef: MutableRefObject<WorkbookInstance | null>,
  ydocRef: MutableRefObject<Y.Doc | null>,
  dsheetId: string,
  getDocumentTitle?: (dsheetId: string) => Promise<string>,
) => {
  if (!workbookRef.current || !ydocRef.current) return;

  try {
    const ctx = workbookRef.current.getWorkbookContext?.();
    const sheetModels: any[] | undefined = ctx?.luckysheetfile;
    if (Array.isArray(sheetModels) && sheetModels.some(sheetModelHasFilter)) {
      toast({
        title: 'Filters are not supported in Export',
        variant: 'warning',
        showCloseButton: true,
        duration: 30 * 1000,
      });
    }

    const ydoc = ydocRef.current;
    ydoc.getArray(dsheetId);

    const sheetWithData = workbookRef.current.getAllSheets();
    // Headless exports (folder list) pass raw ydoc sheets that may hold
    // interned dataVerification refs; live workbook sheets pass through.
    sheetWithData.forEach((sheet) => expandSheetDataVerification(sheet));
    const workbook = XLSXUtil.book_new();
    const sheetRichTextMaps: Map<string, CellRichTextValue>[] =
      sheetWithData.map(() => new Map());

    const usedSheetNames = new Set<string>();

    sheetWithData.forEach((sheet, index) => {
      const rows = buildSheetDataMatrixForExport(sheet);

      const worksheet: any = XLSXUtil.aoa_to_sheet(rows);

      // FIX: aoa_to_sheet may type numeric-looking strings as 's'.
      // Convert them to proper numeric cells so Google Sheets / Excel don't treat them as text.
      Object.keys(worksheet).forEach((key) => {
        if (key.startsWith('!')) return;
        const cell = worksheet[key];
        if (
          cell &&
          (cell.t === 's' || cell.t === undefined) &&
          cell.v !== '' &&
          !isNaN(Number(cell.v))
        ) {
          worksheet[key] = { ...cell, v: Number(cell.v), t: 'n' };
        }
      });

      // APPLY MERGED CELLS
      worksheet['!merges'] = [];
      if (sheet.config?.merge) {
        Object.values(sheet.config.merge).forEach((m: any) => {
          worksheet['!merges'].push({
            s: { r: m.r, c: m.c },
            e: { r: m.r + m.rs - 1, c: m.c + m.cs - 1 },
          });
        });
      }

      // APPLY COLUMN WIDTH
      // Write wch (character units) using MDW=7 (Calibri 11pt at 96 DPI, matches Google Sheets:
      // pixels = charWidth × 7 + 5). Write explicit widths for ALL columns so default-width
      // columns don't fall back to Excel's built-in default (≈64px) in Google Sheets.
      // DEFAULT_COL_WCH = (99 - 5) / 7 ≈ 13.43 (pre-computed for 99px default column width).
      {
        const MDW = 7;
        const DEFAULT_COL_WCH = Math.round(((99 - 5) / MDW) * 256) / 256;
        const colCount = sheet.column || 36;
        worksheet['!cols'] = [];
        for (let col = 0; col < colCount; col++) {
          const explicitPx = sheet.config?.columnlen?.[col];
          if (explicitPx !== undefined) {
            const wch = Math.max(
              0,
              Math.round(((Number(explicitPx) - 5) / MDW) * 256) / 256,
            );
            worksheet['!cols'][col] = { wch };
          } else {
            worksheet['!cols'][col] = { wch: DEFAULT_COL_WCH };
          }
        }
      }

      // ROW HEIGHT
      // Google Sheets renders XLSX row heights using 100 DPI (pt × 100/72),
      // so we write pt using the inverse: pt = px × 72/100 = px × 0.72.
      // This is slightly smaller than the standard 96 DPI factor (0.75) and
      // compensates for Google Sheets rendering rows a bit taller than intended.
      // DEFAULT_ROW_HPT = 21 × 0.72 = 15.12pt (pre-computed).
      {
        const DEFAULT_ROW_HPT = Math.round(21 * 0.72 * 4) / 4;
        (worksheet as any).sheetFormat = {
          ...((worksheet as any).sheetFormat || {}),
          defaultRowHeight: String(DEFAULT_ROW_HPT),
        };
        if (sheet.config?.rowlen) {
          worksheet['!rows'] = [];
          Object.entries(sheet.config.rowlen).forEach(([row, h]) => {
            const hpt = Math.round(Number(h) * 0.72 * 4) / 4;
            worksheet['!rows'][Number(row)] = { hpt };
          });
        }
      }

      // PROCESS CELL DATA
      // Track cells styled via celldata so the sheet.data fallback loop below skips them
      const celldataStyled = new Set<string>();
      (sheet.celldata ?? []).forEach((cell: any) => {
        const r = cell.r;
        const c = cell.c;
        const v = cell.v || {};

        const cellRef = XLSXUtil.encode_cell({ r, c });

        let newCell: any = worksheet[cellRef] || {};
        newCell = { ...newCell };

        // -----------------------------
        // VALUE + FORMULA
        // -----------------------------
        if (v.f) newCell.f = v.f.replace(/^=/, '');

        // For inlineStr (rich text), concatenate all runs as the plain-text fallback.
        // Pass 2 (ExcelJS) will overwrite with the real rich text value.
        if (!v.f && v.ct?.t === 'inlineStr' && Array.isArray(v.ct.s)) {
          newCell.v = concatInlineStrRunsText(v.ct.s);
          newCell.t = 's';
        } else {
          newCell.v = v.v ?? v?.ct?.s?.[0]?.v;
        }
        if (v.m) newCell.w = v.m;

        // COLLECT RICH TEXT (skip formula cells — they have no display runs)
        if (!v.f && v.ct?.t === 'inlineStr' && Array.isArray(v.ct.s)) {
          const rt = buildExcelJsRichText(v.ct.s);
          if (rt) sheetRichTextMaps[index].set(cellRef, rt);
        }

        // -----------------------------
        // NUMBER FORMAT
        // -----------------------------
        if (v.ct) {
          if (v.ct.fa) newCell.z = v.ct.fa;
          // inlineStr is handled above; map 'd' → 'n' for dates; pass through other types
          if (v.ct.t && v.ct.t !== 'inlineStr') {
            newCell.t = v.ct.t === 'd' ? 'n' : v.ct.t;
          }
        }

        // Ensure numeric values are typed as 'n' so Google Sheets / Excel
        // don't import them as text (happens when ct.t is absent)
        if (typeof newCell.v === 'number' && !newCell.t) {
          newCell.t = 'n';
        }

        // -----------------------------
        // STYLE OBJECT
        // -----------------------------
        newCell.s = newCell.s || {};

        // ============ FILL ============
        if (v.bg) {
          const hex = parseColorToHex(v.bg);
          if (hex) {
            newCell.s.fill = {
              patternType: 'solid',
              fgColor: { rgb: hex },
            };
          }
        }

        // ============ FONT ============
        newCell.s.font = {
          ...(newCell.s.font || {}),
          bold: v.bl === 1 || undefined,
          italic: v.it === 1 || undefined,
          strike: v.cl === 1 || undefined,
          underline: v.un === 1 || undefined,

          sz: v.fs ?? 10,
          name: v.ff ?? undefined,

          color: (() => {
            const hex = parseColorToHex(v.fc);
            return hex ? { rgb: hex } : undefined;
          })(),
        };

        // ============ ALIGNMENT ============
        const HT_MAP: any = { '0': 'center', '1': 'left', '2': 'right' };
        const VT_MAP: any = { '0': 'center', '1': 'top', '2': 'bottom' };

        newCell.s.alignment = {
          ...(newCell.s.alignment || {}),
          wrapText: v.tb === '1' || v.tb === '2' ? true : undefined,
          textRotation: v.tr !== undefined ? v.tr : undefined,
        };

        newCell.s.alignment.horizontal = HT_MAP[v.ht] || undefined;
        newCell.s.alignment.vertical = VT_MAP[v.vt] || undefined;

        if (v.tb !== undefined) {
          newCell.s.alignment = newCell.s.alignment || {};

          if (v.tb === '1') {
            newCell.s.alignment.wrapText = true; // Wrap text
          } else if (v.tb === '2') {
            newCell.s.alignment.shrinkToFit = true; // Clip text
          }
          // "0" → overflow → do nothing
        }

        celldataStyled.add(cellRef);
        worksheet[cellRef] = newCell;
      });

      // FORMATTING FALLBACK from sheet.data
      // celldata is often empty for live/collaborative sheets. For any cell not
      // already styled above, read formatting properties directly from sheet.data.
      // Rich text (inlineStr) cells are handled separately below — skip them here
      // so we don't interfere with the rich-text pipeline.
      rows.forEach((row: any[], r: number) => {
        if (!Array.isArray(row)) return;
        row.forEach((v: any, c: number) => {
          if (!v || typeof v !== 'object') return;
          // Skip cells already styled via celldata
          const cellRef = XLSXUtil.encode_cell({ r, c });
          if (celldataStyled.has(cellRef)) return;

          const hasFormula = !!v.f;
          const hasFormatting =
            v.bg ||
            v.bl ||
            v.it ||
            v.cl ||
            v.un ||
            v.fs ||
            v.ff ||
            v.fc ||
            v.ht !== undefined ||
            v.vt !== undefined ||
            v.tb !== undefined ||
            v.tr !== undefined;
          if (!hasFormula && !hasFormatting) return;

          const cell: any = { ...(worksheet[cellRef] || {}) };
          cell.s = cell.s || {};

          // Strip leading = from formula (XLSX <f> must not include it)
          if (hasFormula) cell.f = v.f.replace(/^=/, '');

          // FILL
          if (v.bg) {
            const hex = parseColorToHex(v.bg);
            if (hex) {
              cell.s.fill = { patternType: 'solid', fgColor: { rgb: hex } };
            }
          }

          // FONT
          cell.s.font = {
            ...(cell.s.font || {}),
            bold: v.bl === 1 || undefined,
            italic: v.it === 1 || undefined,
            strike: v.cl === 1 || undefined,
            underline: v.un === 1 || undefined,
            sz: v.fs ?? 10,
            name: v.ff ?? undefined,
            color: (() => {
              const hex = parseColorToHex(v.fc);
              return hex ? { rgb: hex } : undefined;
            })(),
          };

          // ALIGNMENT
          const HT_MAP: any = { '0': 'center', '1': 'left', '2': 'right' };
          const VT_MAP: any = { '0': 'center', '1': 'top', '2': 'bottom' };
          cell.s.alignment = {
            ...(cell.s.alignment || {}),
            horizontal: HT_MAP[v.ht] || undefined,
            vertical: VT_MAP[v.vt] || undefined,
            textRotation: v.tr !== undefined ? v.tr : undefined,
          };
          if (v.tb === '1') cell.s.alignment.wrapText = true;
          else if (v.tb === '2') cell.s.alignment.shrinkToFit = true;

          worksheet[cellRef] = cell;
        });
      });

      // RICH TEXT from sheet.data (celldata is often empty for live sheets)
      // aoa_to_sheet leaves inlineStr cells empty since v.v is undefined;
      // set plain-text fallback here and collect runs for Pass 2.
      rows.forEach((row: any[], r: number) => {
        if (!Array.isArray(row)) return;
        row.forEach((v: any, c: number) => {
          if (!v || v.ct?.t !== 'inlineStr' || !Array.isArray(v.ct.s)) return;
          const cellRef = XLSXUtil.encode_cell({ r, c });
          const plainText = concatInlineStrRunsText(v.ct.s);
          worksheet[cellRef] = {
            ...(worksheet[cellRef] || {}),
            v: plainText,
            t: 's',
          };
          const rt = buildExcelJsRichText(v.ct.s);
          if (rt) sheetRichTextMaps[index].set(cellRef, rt);
        });
      });

      // APPLY BORDERS
      if (sheet.config?.borderInfo) {
        applyBordersToWorksheet(worksheet, sheet.config.borderInfo);
      }

      // STUB FORMAT-ONLY CELLS
      // xlsx-js-style drops any cell that has no type `t` — so a styled but
      // valueless cell (e.g. a black background on an empty cell)
      // is written with no <c> element and loses
      // its fill on export. Give such cells an empty-string type so the writer
      // emits `<c .. t="str"><v></v></c>` and preserves the style.
      Object.keys(worksheet).forEach((key) => {
        if (key.startsWith('!')) return;
        const cell = worksheet[key];
        if (
          cell &&
          cell.s &&
          cell.t == null &&
          cell.v == null &&
          cell.f == null
        ) {
          cell.t = 's';
          cell.v = '';
        }
      });

      const subSheetName =
        sheet.name.length > 30 ? sheet.name.slice(0, 30) : sheet.name;

      if (usedSheetNames.has(subSheetName)) {
        const collided =
          subSheetName !== sheet.name
            ? `"${sheet.name}" is too long and collides with another sheet after being shortened to "${subSheetName}"`
            : `Two sheets share the name "${sheet.name}"`;
        throw new Error(
          `${collided}. Sheet names must be unique. Rename one and try again.`,
        );
      }
      usedSheetNames.add(subSheetName);

      XLSXUtil.book_append_sheet(workbook, worksheet, subSheetName);
    });

    const title = (await getDocumentTitle?.(dsheetId)) || 'Untitled';

    // Pass 1: write to buffer with xlsx-js-style (preserves all cell styling)
    const xlsxBuffer: ArrayBuffer = XLSXWrite(workbook, {
      bookType: 'xlsx',
      type: 'array',
      compression: true,
    });

    // Pass 2: ExcelJS reads the buffer and adds data validations
    const excelWorkbook = new ExcelJSWorkbook();
    await excelWorkbook.xlsx.load(xlsxBuffer);

    const excelModel = (excelWorkbook as any).model;
    if (excelModel?.styles?.fonts?.[0]) {
      excelModel.styles.fonts[0] = { ...excelModel.styles.fonts[0], size: 10 };
    }

    const sheetCfPatches: SheetCfPatch[] = sheetWithData.map(() => ({
      duplicateValues: [],
    }));

    sheetWithData.forEach((sheet, index) => {
      const ws = excelWorkbook.worksheets[index];
      if (!ws) return;

      // Apply rich text collected during Pass 1
      applyRichTextToWorksheet(ws, sheetRichTextMaps[index]);

      // XLSX export supports one hyperlink per cell. Accept both legacy single-entry
      // shape and the newer array shape, exporting only the first entry.
      const grid = sheet.data as any[] | undefined;
      Object.entries(sheet.hyperlink || {}).forEach(([rowColKey, rawLink]) => {
        const firstLink = getFirstHyperlinkEntry(rawLink);
        if (!firstLink?.linkAddress) return;
        const [row, col] = rowColKey.split('_').map(Number);
        if (Number.isNaN(row) || Number.isNaN(col)) return;
        const cellAddress = XLSXUtil.encode_cell({ r: row, c: col });
        const cell = ws.getCell(cellAddress) as any;
        const fv = grid?.[row]?.[col];
        let fromFortune = '';
        if (
          fv &&
          typeof fv === 'object' &&
          fv.ct?.t === 'inlineStr' &&
          Array.isArray(fv.ct.s)
        ) {
          fromFortune = concatInlineStrRunsText(fv.ct.s);
        }
        const currentText =
          fromFortune ||
          (typeof cell.text === 'string' && cell.text.length > 0
            ? cell.text
            : cell.value?.text ||
            (Array.isArray(cell.value?.richText)
              ? cell.value.richText
                .map((x: { text?: string }) => x.text || '')
                .join('')
              : '') ||
            '');
        cell.value = {
          text: currentText || firstLink.linkAddress,
          hyperlink: firstLink.linkAddress,
        };
      });

      // Export real conditional formatting first so dropdown-color CF priorities don't conflict
      const { nextPriority, pendingDuplicateValues } =
        exportConditionalFormatting(ws, sheet, 1);
      sheetCfPatches[index] = { duplicateValues: pendingDuplicateValues };
      let cfPriority = nextPriority;

      if (!sheet.dataVerification) return;

      const wsAny = ws as any;
      if (!wsAny.dataValidations) wsAny.dataValidations = { model: {} };
      if (!wsAny.dataValidations.model) wsAny.dataValidations.model = {};
      const dvModel: Record<string, unknown> = wsAny.dataValidations.model;
      Object.entries(sheet.dataVerification).forEach(([rowColKey, dvRaw]) => {
        const dv = dvRaw as {
          type?: string;
          value1?: string;
          value2?: string;
          color?: string;
          hintShow?: boolean;
          hintValue?: string;
          prohibitInput?: boolean;
        };
        if (dv.type !== 'dropdown' && dv.type !== 'checkbox') return;
        const [row, col] = rowColKey.split('_').map(Number);
        const cellAddress = XLSXUtil.encode_cell({ r: row, c: col });

        if (dv.type === 'checkbox') {
          const selectedVal = (dv.value1 || 'TRUE').trim();
          const unselectedVal = (dv.value2 || 'FALSE').trim();
          const opts = [selectedVal, unselectedVal].filter(Boolean);
          dvModel[cellAddress] = {
            type: 'list',
            allowBlank: true,
            formulae: [`"${opts.join(',')}"`],
            showInputMessage: Boolean(dv.hintShow),
            prompt: dv.hintValue || '',
            showErrorMessage: Boolean(dv.prohibitInput),
          };
          return;
        }
        const options = (dv.value1 || '')
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean);
        if (options.length === 0) return;

        // Write directly to the model in the same format the import reads it
        dvModel[cellAddress] = {
          type: 'list',
          allowBlank: true,
          formulae: [`"${options.join(',')}"`],
          showInputMessage: Boolean(dv.hintShow),
          prompt: dv.hintValue || '',
          showErrorMessage: Boolean(dv.prohibitInput),
        };

        // Add conditional formatting so option colors persist in Google Sheets / Excel.
        // color is a flat comma-separated string of R, G, B triplets (one per option).
        if (dv.color) {
          const colorNums = dv.color
            .split(',')
            .map((s: string) => parseInt(s.trim(), 10));
          const toHex2 = (n: number) =>
            Math.max(0, Math.min(255, n))
              .toString(16)
              .padStart(2, '0')
              .toUpperCase();
          const cfRules = options
            .map((option, i) => {
              const r = colorNums[i * 3];
              const g = colorNums[i * 3 + 1];
              const b = colorNums[i * 3 + 2];
              if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
              const argb = `FF${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
              return {
                type: 'cellIs',
                operator: 'equal',
                formulae: [`"${option}"`],
                priority: cfPriority++,
                style: {
                  fill: {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb },
                  },
                },
              };
            })
            .filter(Boolean);
          if (cfRules.length > 0) {
            wsAny.addConditionalFormatting({
              ref: cellAddress,
              rules: cfRules,
            });
          }
        }
      });
    });

    sheetWithData.forEach((sheet, index) => {
      if (!sheet.images?.length) return;
      const ws = excelWorkbook.worksheets[index];
      if (!ws) return;
      const defaultColPx = Number(sheet.defaultColWidth) || 99;
      const defaultRowPx = Number(sheet.defaultRowHeight) || 21;
      addFortuneImagesToWorksheet(
        ws,
        excelWorkbook,
        sheet.images,
        sheet,
        defaultColPx,
        defaultRowPx,
      );
    });

    const { applyDefinedNamesToExcelWorkbook } = await import(
      './xlsx-defined-names'
    );
    applyDefinedNamesToExcelWorkbook(
      excelWorkbook,
      workbookRef.current.getWorkbookContext?.()?.definedNames,
      sheetWithData,
    );

    const rawBuffer = await excelWorkbook.xlsx.writeBuffer();
    const finalBuffer = await patchXlsxCf(rawBuffer, sheetCfPatches);
    const blob = new Blob([finalBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Export failed:', error);
    toast({
      title: 'Export failed',
      description:
        error instanceof Error && error.message
          ? error.message
          : 'Something went wrong while exporting to .xlsx. Please try again.',
      variant: 'error',
      showCloseButton: true,
      duration: 10 * 1000,
    });
  }
};
