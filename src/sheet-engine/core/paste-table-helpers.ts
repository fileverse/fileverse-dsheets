import _ from 'lodash';
import { Context } from './context';
import { locale } from './locale';
import { getQKBorder, saveHyperlink } from './modules';
import {
  filterMeaningfulBorderSides,
  isTransparentBorderColor,
} from './paste/paste-border-utils';
import { Cell } from './types';
import { getSheetIndex } from './utils';
import { setRowHeight, setColumnWidth } from './api';
import { adjustFormulaForPaste } from './paste/formula-adjust';
import { convertSpanToShareString } from './modules/inline-string';
import { genarate } from './modules/format';
import { isRealNum } from './modules/validation';

export const DEFAULT_FONT_SIZE = 10;

function parseTdBorderSide(
  td: HTMLTableCellElement,
  side: 'Top' | 'Bottom' | 'Left' | 'Right',
): [number, string] | null {
  const shorthand = td.style[
    `border${side}` as keyof CSSStyleDeclaration
  ] as string;
  if (
    shorthand &&
    (shorthand.startsWith('0px') || shorthand.startsWith('0 '))
  ) {
    return null;
  }

  const width = td.style[
    `border${side}Width` as keyof CSSStyleDeclaration
  ] as string;
  const borderStyle = td.style[
    `border${side}Style` as keyof CSSStyleDeclaration
  ] as string;
  const color = td.style[
    `border${side}Color` as keyof CSSStyleDeclaration
  ] as string;

  if (
    !width ||
    !borderStyle ||
    borderStyle === 'none' ||
    borderStyle === 'hidden'
  ) {
    return null;
  }

  const nWidth = parseFloat(width);
  // Reject only zero-width borders. A sub-1px value is still a real border — dsheet's
  // own copy emits thin borders as `0.5pt` (external Sheets sends `1px`). Rejecting `< 1` here
  // dropped dsheet→dsheet borders, so the light gridline showed through the inter-cell
  // gaps as white lines. getQKBorder maps the width→thickness (0.5pt → thin) and
  // returns type 0 for anything genuinely empty, which line 48 still filters.
  if (Number.isNaN(nWidth) || nWidth <= 0) return null;
  if (isTransparentBorderColor(color)) return null;

  const qk = getQKBorder(width, borderStyle, color) as [number, string];
  if (!qk || qk[0] === 0 || isTransparentBorderColor(String(qk[1])))
    return null;
  return [qk[0], qk[1]];
}

const parseStylesheetPairs = (styleInner: string) => {
  const patternReg = /{([^}]*)}/g;
  const patternStyle = styleInner.match(patternReg);
  const nameReg = /^[^\t].*/gm;
  const patternName = _.initial(styleInner.match(nameReg));
  if (
    typeof patternStyle !== typeof patternName ||
    patternName.length !== patternStyle?.length
  )
    return {} as Record<string, string>;

  return _.fromPairs(_.zip(patternName, patternStyle));
};

const parseInlineStyleBlock = (block?: string) => {
  if (!block) return {} as Record<string, string>;
  const trimmed = block.substring(1, block.length - 1); // remove { }
  const entries = trimmed
    .split('\n\t')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Record<string, string> = {};
  entries.forEach((entry) => {
    const [k, v] = entry.split(':');
    if (k && v) out[k] = v.replace(';', '').trim();
  });
  return out;
};

const mapFontFamilyToIndex = (ff: string, ctx: Context) => {
  const families = ff.split(',');
  const locale_fontjson = locale(ctx).fontjson as Record<string, number>;
  const found = families
    .map((raw) => raw.trim().toLowerCase())
    .find((key) => {
      const mapped = locale_fontjson[key];
      return mapped != null;
    });
  if (found != null) return locale_fontjson[found];
  return 0; // default font index
};

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'li',
  'tr',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

const getInlineStringSegmentsFromTd = (
  td: HTMLTableCellElement,
  cell: Cell,
  defaultFontSize: number,
) => {
  const segments: HTMLSpanElement[] = [];

  function walk(
    node: Node,
    css: Record<string, string>,
    link?: { type: string; address: string },
  ) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (text) {
        const span = document.createElement('span');
        const cssText = Object.entries(css)
          .map(([k, v]) => `${k}:${v}`)
          .join(';');
        if (cssText) span.setAttribute('style', cssText);
        span.textContent = text;
        if (link) {
          span.dataset.linkType = link.type;
          span.dataset.linkAddress = link.address;
        }
        segments.push(span);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === 'br') {
      const span = document.createElement('span');
      span.textContent = '\n';
      segments.push(span);
      return;
    }

    if (BLOCK_TAGS.has(tag) && segments.length > 0) {
      const nl = document.createElement('span');
      nl.textContent = '\n';
      segments.push(nl);
    }

    const newCss = { ...css };
    if (tag === 'b' || tag === 'strong') newCss['font-weight'] = 'bold';
    if (tag === 'i' || tag === 'em') newCss['font-style'] = 'italic';
    if (tag === 'u') newCss['text-decoration'] = 'underline';
    if (tag === 's' || tag === 'strike') {
      newCss['text-decoration'] = 'line-through';
    }

    if (el.style?.cssText) {
      Array.from(el.style).forEach((prop) => {
        if (prop === 'font-size') return;
        // Borders are cell-level (handled by applyBordersAndMerges). Never copy them
        // onto a text run: convertCssToStyleList treats `border-bottom` as underline,
        // so a cell's bottom border would wrongly underline all its text (external
        // Sheets cells, which carry `border: 1px solid …`).
        if (prop === 'border' || prop.startsWith('border-')) return;
        const val = el.style.getPropertyValue(prop);
        if (val) newCss[prop] = val;
      });
    }

    let newLink = link;
    if (tag === 'a') {
      const href = el.getAttribute('href')?.trim() || '';
      if (/^https?:\/\//i.test(href)) {
        newLink = { type: 'webpage', address: href };
      }
    }

    Array.from(el.childNodes).forEach((child) => {
      walk(child, newCss, newLink);
    });
  }

  walk(td, {});

  if (segments.length === 0) return [];

  const base = {
    fc: cell.fc || '#000000',
    fs: cell.fs || defaultFontSize,
    cl: cell.cl || 0,
    un: cell.un || 0,
    bl: cell.bl || 0,
    it: cell.it || 0,
    ff: cell.ff || 0,
  };

  const result = convertSpanToShareString(segments as any, base as Cell);

  return result.map((seg: any) => ({
    ...base,
    ...seg,
    fs: base.fs,
  }));
};

function applyBordersAndMerges(
  td: HTMLTableCellElement,
  startRow: number,
  startCol: number,
  absRow: number,
  absCol: number,
  rowSpanCount: number,
  colSpanCount: number,
  borderInfo: any,
  data: any[][],
) {
  // Pre-compute border configs once
  const topBorder = parseTdBorderSide(td, 'Top');
  const bottomBorder = parseTdBorderSide(td, 'Bottom');
  const leftBorder = parseTdBorderSide(td, 'Left');
  const rightBorder = parseTdBorderSide(td, 'Right');

  for (let rowOffset = 0; rowOffset < rowSpanCount; rowOffset++) {
    const relativeRow = startRow + rowOffset;

    for (let colOffset = 0; colOffset < colSpanCount; colOffset++) {
      const relativeCol = startCol + colOffset;

      // mark merge reference (skip the anchor cell)
      if (!(rowOffset === 0 && colOffset === 0)) {
        data[relativeRow][relativeCol] = { mc: { r: absRow, c: absCol } };
      }

      // Only apply borders at perimeter cells
      const isTopEdge = rowOffset === 0;
      const isBottomEdge = rowOffset === rowSpanCount - 1;
      const isLeftEdge = colOffset === 0;
      const isRightEdge = colOffset === colSpanCount - 1;

      if (!(isTopEdge || isBottomEdge || isLeftEdge || isRightEdge)) continue;

      const cellBorders: {
        l?: { style?: number; color?: string };
        r?: { style?: number; color?: string };
        t?: { style?: number; color?: string };
        b?: { style?: number; color?: string };
      } = {};

      if (isTopEdge && topBorder) {
        cellBorders.t = { style: topBorder[0], color: topBorder[1] };
      }
      if (isBottomEdge && bottomBorder) {
        cellBorders.b = {
          style: bottomBorder[0],
          color: bottomBorder[1],
        };
      }
      if (isLeftEdge && leftBorder) {
        cellBorders.l = {
          style: leftBorder[0],
          color: leftBorder[1],
        };
      }
      if (isRightEdge && rightBorder) {
        cellBorders.r = {
          style: rightBorder[0],
          color: rightBorder[1],
        };
      }

      if (cellBorders.l || cellBorders.r || cellBorders.t || cellBorders.b) {
        const meaningful = filterMeaningfulBorderSides(cellBorders);
        if (meaningful.l || meaningful.r || meaningful.t || meaningful.b) {
          borderInfo[`${relativeRow}_${relativeCol}`] = meaningful;
        }
      }
    }
  }
}
interface BuiltCellResult {
  cell: Cell;
  rowspan: number;
  colspan: number;
  hyperlink?: { href: string; display: string } | null;
  srcRow?: number;
  srcCol?: number;
}

const HEX_REGEX = /^0x?[a-fA-F0-9]+$/;

const detectHyperlink = (td: HTMLTableCellElement) => {
  const anchor = td.querySelector('a[href]') as HTMLAnchorElement | null;
  const urlRegex = /^(https?:\/\/[^\s]+)$/i;
  if (anchor) {
    const href = anchor.getAttribute('href')?.trim() || '';
    const display = anchor.textContent?.trim() || href;
    const cellText = (td.textContent || '').trim();
    const anchorText = (anchor.textContent || '').trim();
    if (href && urlRegex.test(href) && cellText === anchorText)
      return { href, display };
  } else {
    const raw = (td.textContent || '').trim();
    if (urlRegex.test(raw)) return { href: raw, display: raw };
  }
  return null;
};

function brToNewline(str: string) {
  return str.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li)>/gi, '\n');
}

const buildCellFromTd = (
  td: HTMLTableCellElement,
  classStyles: Record<string, string>,
  ctx: Context,
): BuiltCellResult => {
  const fortuneCellAttr = td.getAttribute('data-fortune-cell');
  if (fortuneCellAttr) {
    try {
      const { _srcRow, _srcCol, ...parsed } = JSON.parse(
        decodeURIComponent(fortuneCellAttr),
      );
      const cell = parsed as Cell;
      delete cell.mc;
      delete cell.hl;
      const rowspan = parseInt(td.getAttribute('rowspan') || '1', 10);
      const colspan = parseInt(td.getAttribute('colspan') || '1', 10);
      return {
        cell,
        rowspan: Number.isNaN(rowspan) ? 1 : rowspan,
        colspan: Number.isNaN(colspan) ? 1 : colspan,
        hyperlink: detectHyperlink(td),
        srcRow: _srcRow,
        srcCol: _srcCol,
      };
    } catch {
      // fall through to CSS parsing if JSON is malformed
    }
  }

  let cell: Cell = {};
  const rawHtml = td.innerHTML || '';
  const hasHtmlLineBreak = /<br\s*\/?>|<\/(div|p|li)>/i.test(rawHtml);
  const domText = td.innerText || td.textContent || '';
  const htmlText = brToNewline(rawHtml).replace(/<[^>]*>/g, '');
  const rawText = (
    hasHtmlLineBreak && !/[\r\n]/.test(domText)
      ? htmlText
      : domText || htmlText || rawHtml || ''
  ).trim();
  const normalizedText = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const isLineBreak = hasHtmlLineBreak || normalizedText.includes('\n');

  if (!normalizedText) {
    cell.v = undefined;
    cell.m = '';
  } else if (isLineBreak) {
    cell.v = normalizedText;
    cell.m = normalizedText;
    cell = {
      ...cell,
      ct: { fa: 'General', t: 'inlineStr', s: [{ v: normalizedText }] },
    };
  } else {
    cell.v = normalizedText;
    cell.m = normalizedText;
    cell.ct = { fa: 'General', t: 'g' };
    if (HEX_REGEX.test(normalizedText)) {
      cell.ct = { fa: '@', t: 's' };
    } else {
      const generated = genarate(normalizedText);
      if (generated?.[1]) {
        const [m, ct, v] = generated;
        if (ct?.t === 'n') {
          cell.v = v;
          cell.m = normalizedText;
          cell.ct = { fa: 'General', t: 'g' };
        } else {
          // Keep generated date/time (and other explicit) cell typing for HTML paste,
          // matching plain-text paste behavior.
          cell.v = v;
          cell.m = m != null ? String(m) : normalizedText;
          cell.ct = ct;
        }
      } else if (isRealNum(normalizedText)) {
        cell.v = parseFloat(normalizedText);
        cell.m = normalizedText;
        cell.ct = { fa: 'General', t: 'g' };
      }
    }
  }

  if (td.style?.alignItems === 'center') {
    cell.vt = 0;
  } else if (td.style?.alignItems === 'flex-end') {
    cell.vt = 2;
  } else if (td.style?.alignItems === 'flex-start') {
    cell.vt = 1;
  }

  const styleBlock =
    typeof classStyles[`.${td.className}`] === 'string'
      ? classStyles[`.${td.className}`]
      : '';
  const styles = parseInlineStyleBlock(styleBlock);

  if (!_.isNil(styles.border)) td.style.border = styles.border;

  // Background
  let bg: string | undefined = (td.style.backgroundColor ||
    styles.background) as string | undefined;
  if (!bg || bg === 'rgba(0, 0, 0, 0)') bg = undefined;
  cell.bg = bg;

  // Bold / Italic
  const { fontWeight } = td.style;
  cell.bl =
    (fontWeight.toString() === '400' ||
      fontWeight === 'normal' ||
      _.isEmpty(fontWeight)) &&
      !_.includes(styles['font-style'], 'bold') &&
      (!styles['font-weight'] || styles['font-weight'] === '400')
      ? 0
      : 1;
  cell.it =
    (td.style.fontStyle === 'normal' || _.isEmpty(td.style.fontStyle)) &&
      !_.includes(styles['font-style'], 'italic')
      ? 0
      : 1;

  // Underline / strike
  const textDecoration = [
    td.style.textDecoration,
    // @ts-ignore
    td.style.textDecorationLine,
    styles['text-decoration'],
    styles['text-decoration-line'],
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  cell.un = textDecoration.includes('underline') ? 1 : undefined;
  cell.cl =
    textDecoration.includes('line-through') || _.includes(td.innerHTML, '<s>')
      ? 1
      : undefined;

  // Font family / size / color
  const ff = td.style.fontFamily || styles['font-family'] || '';
  cell.ff = mapFontFamilyToIndex(ff, ctx);
  const ctxDefaultFontSize = ctx.defaultFontSize ?? DEFAULT_FONT_SIZE;
  const fontSize = Math.round(
    styles['font-size']
      ? parseInt(styles['font-size'].replace('pt', ''), 10)
      : parseInt(td.style.fontSize || `${ctxDefaultFontSize}`, 10),
  );
  cell.fs = fontSize;
  cell.fc = td.style.color || styles.color;

  // Preserve explicit horizontal alignment from pasted HTML (e.g. dsheet->dsheet),
  // but do not force a default alignment when text-align is not provided.
  const htStyle = td.style.textAlign || styles['text-align'];
  if (htStyle === 'center') {
    cell.ht = 0;
  } else if (htStyle === 'right') {
    cell.ht = 2;
  } else if (htStyle === 'left') {
    cell.ht = 1;
  }

  // const regex = /vertical-align:\s*(.*?);/;

  // // Vertical align
  // const vtStyle =
  //   (typeof classStyles.td === "string" &&
  //     (classStyles.td.match(regex)?.[1] ?? "")) ||
  //   "top";
  // const vt = td.style.verticalAlign || styles["vertical-align"] || vtStyle;
  // if (vt === "middle") {
  //   cell.vt = 0;
  // } else if (vt === "top" || vt === "text-top") {
  //   cell.vt = 1;
  // } else {
  //   cell.vt = 2;
  // }

  // @ts-ignore
  if (td?.style?.['overflow-wrap'] === 'anywhere') {
    cell.tb = '2';
  } else {
    cell.tb = '1'; // overflow
  }

  // Rotation
  if ('mso-rotate' in styles) cell.rt = parseFloat(styles['mso-rotate']);

  const inlineSegments = getInlineStringSegmentsFromTd(
    td,
    cell,
    ctxDefaultFontSize,
  );
  const segmentsText = inlineSegments.map((s: any) => s.v ?? '').join('');
  const shouldUseInlineString =
    normalizedText.length > 0 &&
    inlineSegments.length > 0 &&
    segmentsText.trim().length > 0 &&
    (isLineBreak ||
      td.querySelector('[data-sheets-root]') != null ||
      td.querySelector(
        'span[style], b, strong, i, em, u, s, strike, a[href]',
      ) != null);

  if (shouldUseInlineString) {
    cell.v = normalizedText;
    cell.m = normalizedText;
    cell.ct = { fa: 'General', t: 'inlineStr', s: inlineSegments };
  }

  // Span
  let rowspan = parseInt(td.getAttribute('rowspan') || '1', 10);
  let colspan = parseInt(td.getAttribute('colspan') || '1', 10);
  if (Number.isNaN(rowspan)) rowspan = 1;
  if (Number.isNaN(colspan)) colspan = 1;

  return { cell, rowspan, colspan, hyperlink: detectHyperlink(td) };
};

export function handlePastedTable(
  ctx: Context,
  html: string,
  pasteHandler: (context: Context, data: any, borderInfo?: any) => void,
) {
  if (!/<table[\s/>]/i.test(html)) return;

  const containerDiv = document.createElement('div');
  containerDiv.innerHTML = html;

  // Column widths live in different places depending on the source:
  //  - dsheet copy:   one <colgroup width="72px"> per column (width on the colgroup)
  //  - external Sheets: a single <colgroup> containing <col width="100"> per column
  // Prefer the <col> elements (external); fall back to <colgroup> width attrs (dsheet).
  const colEls = containerDiv.querySelectorAll('col');
  const colGroupEls = containerDiv.querySelectorAll('colgroup');
  const widthSources: Element[] =
    colEls.length > 0 ? Array.from(colEls) : Array.from(colGroupEls);

  widthSources.forEach((el, index) => {
    const colWidth = el?.getAttribute('width');
    const intColWidth = parseInt(colWidth || '0', 10);
    if (intColWidth <= 0) return;
    const anchorCol = ctx.luckysheet_select_save![0].column[0];
    const absoluteCol = anchorCol + index;
    const defaultColW =
      ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!]
        ?.defaultColWidth ?? ctx.defaultcollen;
    if (intColWidth !== defaultColW) {
      setColumnWidth(ctx, { [absoluteCol]: intColWidth });
    }
  });

  const tableRows = containerDiv.querySelectorAll('table tr');
  if (tableRows.length === 0) {
    containerDiv.remove();
    return;
  }

  let totalColumns = 0;
  tableRows[0].querySelectorAll('td, th').forEach((cellEl) => {
    const tableCell = cellEl as HTMLTableCellElement;
    const span = Number.isNaN(tableCell.colSpan) ? 1 : tableCell.colSpan;
    totalColumns += span;
  });

  const totalRows = tableRows.length;
  const pastedMatrix: any[][] = Array.from(
    { length: totalRows },
    () => new Array(totalColumns),
  );
  const pasteBorderInfo: any = {};

  const inlineStyleBlock =
    containerDiv.querySelectorAll('style')[0]?.innerHTML || '';
  const classStyleMap = parseStylesheetPairs(inlineStyleBlock);

  const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
  if (_.isNil(sheetIndex)) {
    ctx.luckysheet_selection_range = [];
    pasteHandler(ctx, pastedMatrix, pasteBorderInfo);
    containerDiv.remove();
    return;
  }

  const sheetFile = ctx.luckysheetfile[sheetIndex];
  if (!sheetFile.config) sheetFile.config = {};
  if (!sheetFile.config.rowlen)
    sheetFile.config.rowlen = {} as Record<number, number>;
  const rowHeightsConfig = sheetFile.config.rowlen as Record<number, number>;

  let localRowIndex = 0;
  tableRows.forEach((tr) => {
    let localColIndex = 0;

    const anchorRow = ctx.luckysheet_select_save![0].row[0];
    const targetRowIndex = anchorRow + localRowIndex;

    // Row height lives in different places depending on the source:
    //  - <tr height> attribute      (some external apps)
    //  - <tr style="height:20px">   (external Sheets — inline style on the row)
    //  - inline style on first <td> (dsheet copy)
    // Prefer them in that order.
    const explicitRowHeightAttr = tr.getAttribute('height');
    const trInlineHeight = (tr as HTMLElement).style?.height || '';
    const firstCellInlineHeight =
      (tr.querySelector('td, th') as HTMLElement | null)?.style?.height || '';
    const rowHeightRaw = !_.isNil(explicitRowHeightAttr)
      ? explicitRowHeightAttr
      : trInlineHeight || firstCellInlineHeight;
    const parsedRowHeight = parseInt(rowHeightRaw, 10);
    if (!Number.isNaN(parsedRowHeight) && parsedRowHeight > 0) {
      const defaultRowH = sheetFile.defaultRowHeight ?? ctx.defaultrowlen;
      const hasCustomRowHeight = _.has(
        sheetFile.config?.rowlen,
        targetRowIndex,
      );
      const currentRowHeight = hasCustomRowHeight
        ? sheetFile.config!.rowlen![targetRowIndex]
        : defaultRowH;

      if (
        parsedRowHeight !== defaultRowH &&
        currentRowHeight !== parsedRowHeight
      ) {
        rowHeightsConfig[targetRowIndex] = parsedRowHeight;
        setRowHeight(ctx, {
          [String(targetRowIndex)]: parsedRowHeight,
        });
      }
    }
    tr.querySelectorAll('td, th').forEach((node) => {
      const tdElement = node as HTMLTableCellElement;

      while (
        localColIndex < totalColumns &&
        pastedMatrix[localRowIndex][localColIndex] != null
      ) {
        localColIndex++;
      }
      if (localColIndex === totalColumns) return; // row overflow

      const { cell, rowspan, colspan, hyperlink, srcRow, srcCol } =
        buildCellFromTd(tdElement, classStyleMap, ctx);

      const anchorCol = ctx.luckysheet_select_save![0].column[0];
      const absoluteRow = anchorRow + localRowIndex;
      const absoluteCol = anchorCol + localColIndex;

      if (cell.f && srcRow != null && srcCol != null) {
        try {
          cell.f = adjustFormulaForPaste(
            cell.f,
            srcCol,
            srcRow,
            absoluteCol,
            absoluteRow,
          );
        } catch {
          // invalid ref — leave formula as-is
        }
      }

      // Place cell into matrix
      pastedMatrix[localRowIndex][localColIndex] = cell;

      // Persist hyperlink if present
      if (hyperlink) {
        saveHyperlink(
          ctx,
          absoluteRow,
          absoluteCol,
          hyperlink.href,
          'webpage',
          hyperlink.display,
        );
        // Force blue color and underline for all pasted links
        cell.hl = { r: absoluteRow, c: absoluteCol, id: ctx.currentSheetId };
        cell.fc = 'rgb(0, 0, 255)';
        cell.un = 1;
        // Update the cell in the matrix with the styling
        pastedMatrix[localRowIndex][localColIndex] = cell;
      }

      // Apply borders and merges
      applyBordersAndMerges(
        tdElement,
        localRowIndex,
        localColIndex,
        absoluteRow,
        absoluteCol,
        rowspan,
        colspan,
        pasteBorderInfo,
        pastedMatrix,
      );

      // Mark merged cell metadata, if any
      if (rowspan > 1 || colspan > 1) {
        (pastedMatrix[localRowIndex][localColIndex] as any).mc = {
          rs: rowspan,
          cs: colspan,
          r: absoluteRow,
          c: absoluteCol,
        };
      }

      localColIndex++;
    });

    localRowIndex++;
  });

  ctx.luckysheet_selection_range = [];

  pasteHandler(ctx, pastedMatrix, pasteBorderInfo);
  containerDiv.remove();
}
