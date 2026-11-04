import { DEFAULT_FONT_SIZE } from '../paste-table-helpers';
import { getSheetIndex } from '../utils';
import { Context, getFlowdata } from '../context';
import { Cell, Sheet } from '../types';
import { setRowHeight, setColumnWidth } from '../api';
import { getFontSet } from '../modules/text';

const DEFAULT_FONT_FAMILY =
  'Helvetica Neue, system-ui, Roboto, Lato, Segoe UI, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Arial, sans-serif';

const getColumnWidth = (colIndex: number, ctx: Context, sheetFile: Sheet) => {
  const defaultColumnWidth = ctx.defaultcollen ?? 73;
  return (
    (sheetFile.config?.columnlen as Record<number, number> | undefined)?.[
      colIndex
    ] ?? defaultColumnWidth
  );
};

const getCellDisplayText = (cell: Cell | null | undefined) => {
  let text = cell?.m ?? cell?.v;
  if (text == null && cell?.ct?.t === 'inlineStr') {
    text = (cell.ct.s || []).map((s: any) => s.v).join('');
  }
  return text == null ? '' : String(text);
};

const isCellWrapped = (cell: Cell | null | undefined) =>
  Number(cell?.tb) === 2 ||
  cell?.ct?.t === 'inlineStr' ||
  /[\r\n]/.test(getCellDisplayText(cell));

const applyFontOnMeasurer = (
  cell: Cell | null | undefined,
  cellSizeMeasurer: HTMLDivElement | null,
) => {
  const fontSizePx = (cell?.fs as number | undefined) ?? DEFAULT_FONT_SIZE;
  const fontFamily = (cell?.ff as string | undefined) ?? DEFAULT_FONT_FAMILY;
  const fontWeight = cell?.bl === 1 ? '700' : '400';
  const fontStyle = cell?.it === 1 ? 'italic' : 'normal';

  cellSizeMeasurer!.style.fontSize = `${fontSizePx}px`;
  cellSizeMeasurer!.style.fontFamily = fontFamily;
  cellSizeMeasurer!.style.fontWeight = fontWeight;
  cellSizeMeasurer!.style.fontStyle = fontStyle;

  return fontSizePx;
};


type Measure2d = {
  measureText(t: string): { width: number };
  font: string;
};

const SINGLE_LINE_CACHE_MAX = 50000;
const SINGLE_LINE_TEXT_MAX = 200;
let singleLineCache = new Map<string, number>();

/** Drop cached widths, e.g. after web fonts load and change the metrics. */
export function clearSingleLineCache() {
  singleLineCache = new Map();
}

const fontsApi = (): any =>
  typeof document !== 'undefined' ? (document as any).fonts : undefined;

if (typeof document !== 'undefined') {
  fontsApi()?.addEventListener?.('loadingdone', clearSingleLineCache);
}

/**
 * Width of one line of text in `font`, from canvas measureText, cached by
 * (font, text). No DOM layout is involved.
 */
export function measureSingleLine(
  font: string,
  text: string,
  ctx2d: Measure2d,
): number {
  const key = `${font}\u0000${text}`;
  const hit = singleLineCache.get(key);
  if (hit !== undefined) return hit;
  if (ctx2d.font !== font) ctx2d.font = font;
  const { width } = ctx2d.measureText(text);
  // Widths measured while fonts load use fallback metrics; long texts rarely
  // repeat and make large keys.
  if (text.length <= SINGLE_LINE_TEXT_MAX && fontsApi()?.status !== 'loading') {
    if (singleLineCache.size >= SINGLE_LINE_CACHE_MAX) {
      singleLineCache = new Map();
    }
    singleLineCache.set(key, width);
  }
  return width;
}

const getMeasureContext2d = (): Measure2d | null => {
  const canvas = document.createElement('canvas');
  return (canvas.getContext?.('2d') as Measure2d | null) ?? null;
};

type WrapJob = {
  font: string;
  text: string;
  whiteSpace: string;
  width: string;
  onResult: (el: HTMLDivElement) => void;
};

/**
 * Measure wrapped cells in the DOM with all writes before the first read:
 * one absolutely positioned element per job inside the measurer, then a read
 * pass. One layout per batch instead of one per cell.
 */
const measureWrappedBatch = (
  measurer: HTMLDivElement,
  jobs: WrapJob[],
) => {
  if (jobs.length === 0) return;
  const els = jobs.map((job) => {
    const el = document.createElement('div');
    el.style.font = job.font;
    el.style.position = 'absolute';
    el.style.whiteSpace = job.whiteSpace;
    el.style.width = job.width;
    el.style.lineHeight = '1.3';
    el.style.wordBreak = 'normal';
    el.style.overflowWrap = 'break-word';
    measurer.appendChild(el);
    el.textContent = job.text;
    return el;
  });
  jobs.forEach((job, i) => job.onResult(els[i]));
  els.forEach((el) => el.remove());
};

export function calculateRangeCellSize(
  ctx: Context,
  sheetId: string,
  startRow: number,
  endRow: number,
  startCol: number,
  endCol: number,
  maxColumnWidth = 1200,
) {
  const sheetIndex = getSheetIndex(ctx, sheetId)!;
  const sheetFile = ctx.luckysheetfile[sheetIndex];
  const gridData = getFlowdata(ctx) || sheetFile.data;

  const maxRowHeights: Record<number, number> = {};
  const maxColumnWidths: Record<number, number> = {};

  let cellSizeMeasurer = document.getElementById(
    'fs-cell-measurer',
  ) as HTMLDivElement | null;
  if (!cellSizeMeasurer) {
    cellSizeMeasurer = document.createElement('div');
    cellSizeMeasurer.id = 'fs-cell-measurer';
    Object.assign(cellSizeMeasurer.style, {
      position: 'fixed',
      left: '-99999px',
      top: '-99999px',
      visibility: 'hidden',
      lineHeight: '1.3',
      whiteSpace: 'normal',
      wordBreak: 'normal',
      overflowWrap: 'break-word',
    });
    document.body.appendChild(cellSizeMeasurer);
  }

  const defaultRowHeight = sheetFile.defaultRowHeight ?? 19;

  const measure2d = getMeasureContext2d();
  // getFontSet per cell is the grid's draw font; memoize per attribute set.
  const fontByAttrs = new Map<string, string>();
  const fontFor = (cell: Cell | null | undefined) => {
    const key = `${cell?.ff}|${cell?.fs}|${cell?.bl}|${cell?.it}`;
    let font = fontByAttrs.get(key);
    if (font === undefined) {
      font = getFontSet(cell ?? {}, ctx.defaultFontSize, ctx);
      fontByAttrs.set(key, font);
    }
    return font;
  };

  // First, calculate max widths for each column. Single-line cells use canvas
  // measureText; wrapped cells are measured in the DOM in one batch.
  const widthJobs: WrapJob[] = [];
  for (let col = startCol; col <= endCol; col++) {
    maxColumnWidths[col] = getColumnWidth(col, ctx, sheetFile);

    for (let row = startRow; row <= endRow; row++) {
      const cell = gridData?.[row]?.[col];
      if (cell?.mc && cell.mc.rs == null) continue;

      const text = getCellDisplayText(cell);
      if (measure2d && !isCellWrapped(cell)) {
        if (text === '') continue;
        const font = fontFor(cell);
        const intrinsicWidth = Math.ceil(
          measureSingleLine(font, text, measure2d) + 12,
        );
        if (intrinsicWidth > maxColumnWidths[col])
          maxColumnWidths[col] = intrinsicWidth;
      } else {
        widthJobs.push({
          font: fontFor(cell),
          text,
          whiteSpace: 'pre',
          width: 'auto',
          onResult: (el) => {
            const intrinsicWidth = Math.ceil(el.scrollWidth + 12);
            if (intrinsicWidth > maxColumnWidths[col])
              maxColumnWidths[col] = intrinsicWidth;
          },
        });
      }
    }
  }
  measureWrappedBatch(cellSizeMeasurer, widthJobs);
  for (let col = startCol; col <= endCol; col++) {
    maxColumnWidths[col] = Math.min(maxColumnWidths[col], maxColumnWidth);
  }

  // Then, calculate max heights for each row based on the determined column
  // widths. Wrapped cells are measured in one batch (writes, then reads).
  const heightJobs: WrapJob[] = [];
  for (let row = startRow; row <= endRow; row++) {
    maxRowHeights[row] = defaultRowHeight;

    for (let col = startCol; col <= endCol; col++) {
      const cell = gridData?.[row]?.[col];
      if (cell?.mc && cell.mc.rs == null) continue;

      const text = getCellDisplayText(cell);
      if (isCellWrapped(cell)) {
        const finalColumnWidth = Math.max(
          getColumnWidth(col, ctx, sheetFile),
          maxColumnWidths[col] || 0,
        );
        heightJobs.push({
          font: fontFor(cell),
          text,
          whiteSpace: /[\r\n]/.test(text) ? 'pre-wrap' : 'normal',
          width: `${Math.max(5, finalColumnWidth - 8)}px`,
          onResult: (el) => {
            const wrappedHeight = Math.ceil(el.scrollHeight + 6);
            if (wrappedHeight > maxRowHeights[row])
              maxRowHeights[row] = wrappedHeight;
          },
        });
      } else {
        const fontSizePx = (cell?.fs as number | undefined) ?? DEFAULT_FONT_SIZE;
        const singleLineHeight = Math.ceil(fontSizePx * 1.3 + 6);
        if (singleLineHeight > maxRowHeights[row])
          maxRowHeights[row] = singleLineHeight;
      }
    }
  }
  measureWrappedBatch(cellSizeMeasurer, heightJobs);
  return { rowMax: maxRowHeights, colMax: maxColumnWidths };
}

export function getColumnAutoFitWidth(ctx: Context, colIndex: number): number {
  const flowdata = getFlowdata(ctx);
  if (!flowdata) return ctx.defaultcollen;

  const rowCount = flowdata.length;

  let cellSizeMeasurer = document.getElementById(
    'fs-cell-measurer',
  ) as HTMLDivElement | null;
  if (!cellSizeMeasurer) {
    cellSizeMeasurer = document.createElement('div');
    cellSizeMeasurer.id = 'fs-cell-measurer';
    Object.assign(cellSizeMeasurer.style, {
      position: 'fixed',
      left: '-99999px',
      top: '-99999px',
      visibility: 'hidden',
      lineHeight: '1.3',
      whiteSpace: 'pre',
      wordBreak: 'normal',
      overflowWrap: 'break-word',
    });
    document.body.appendChild(cellSizeMeasurer);
  }

  let maxWidth = ctx.defaultcollen;

  for (let row = 0; row < rowCount; row++) {
    const cell = flowdata[row]?.[colIndex];
    if (!cell) continue;
    if (cell.mc && cell.mc.rs == null) continue;

    const text = getCellDisplayText(cell);
    if (!text) continue;

    applyFontOnMeasurer(cell, cellSizeMeasurer);
    // fs is stored in points; applyFontOnMeasurer incorrectly applies it as px,
    // so override with the correct pt unit to match canvas rendering
    const fontSizePt = (cell.fs as number | undefined) ?? ctx.defaultFontSize;
    cellSizeMeasurer.style.fontSize = `${fontSizePt}pt`;
    cellSizeMeasurer.style.whiteSpace = 'pre';
    cellSizeMeasurer.style.width = 'auto';
    cellSizeMeasurer.textContent = text;
    const intrinsicWidth = Math.ceil(cellSizeMeasurer.scrollWidth + 12);
    if (intrinsicWidth > maxWidth) maxWidth = intrinsicWidth;
  }

  return maxWidth;
}

export const updateSheetCellSizes = (
  ctx: Context,
  sheetIndex: number,
  measurements: {
    rowMax: Record<number, number>;
    colMax: Record<number, number>;
  },
  maxColumnWidth = 1200,
) => {
  const sheetFile = ctx.luckysheetfile[sheetIndex];
  if (!sheetFile) return;

  // Ensure config objects exist
  if (!sheetFile.config) {
    sheetFile.config = {};
  }
  const { config } = sheetFile;

  if (!config.rowlen) {
    config.rowlen = {} as Record<number, number>;
  }
  const rowHeightsConfig = config.rowlen;

  if (!config.columnlen) {
    config.columnlen = {} as Record<number, number>;
  }
  const columnWidthsConfig = config.columnlen;

  const defaultRowHeight = sheetFile.defaultRowHeight ?? 19;
  const defaultColumnWidth = sheetFile.defaultColWidth ?? ctx.defaultcollen ?? 73;

  const rowUpdates: Record<string, number> = {};
  Object.entries(measurements.rowMax).forEach(
    ([rowIndexString, requiredHeight]) => {
      const rowIndex = Number(rowIndexString);
      const currentHeight = rowHeightsConfig[rowIndex] ?? defaultRowHeight;

      if (
        requiredHeight > currentHeight &&
        requiredHeight !== defaultRowHeight
      ) {
        rowHeightsConfig[rowIndex] = requiredHeight;
        rowUpdates[String(rowIndex)] = requiredHeight;
      } else if (
        requiredHeight <= defaultRowHeight &&
        rowHeightsConfig[rowIndex] != null
      ) {
        delete rowHeightsConfig[rowIndex];
      }
    },
  );

  const colUpdates: Record<string, number> = {};
  Object.entries(measurements.colMax).forEach(
    ([colIndexString, requiredWidth]) => {
      const colIndex = Number(colIndexString);
      const currentWidth = columnWidthsConfig[colIndex] ?? defaultColumnWidth;
      const cappedWidth = Math.min(requiredWidth, maxColumnWidth);

      if (
        cappedWidth > currentWidth &&
        cappedWidth !== defaultColumnWidth
      ) {
        columnWidthsConfig[colIndex] = cappedWidth;
        colUpdates[String(colIndex)] = cappedWidth;
      } else if (
        cappedWidth <= defaultColumnWidth &&
        columnWidthsConfig[colIndex] != null
      ) {
        delete columnWidthsConfig[colIndex];
      }
    },
  );

  if (Object.keys(rowUpdates).length > 0) {
    setRowHeight(ctx, rowUpdates);
  }
  if (Object.keys(colUpdates).length > 0) {
    setColumnWidth(ctx, colUpdates);
  }
};
