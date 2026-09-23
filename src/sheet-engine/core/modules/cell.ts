import _ from 'lodash';
import { Context, getFlowdata } from '../context';
import { Cell, CellMatrix, Range, Selection, SingleRange } from '../types';
import {
  getSheetIndex,
  indexToColumnChar,
  rgbToHex,
  processArray,
  getContentInParentheses,
  getNumberFormat,
  formatSheetNameForFormula,
  quoteSheetNamesInFormula,
} from '../utils';
import { ensureSheetFlowdata } from '../api/sheet';
import { checkCF, getComputeMap } from './ConditionFormat';
import { getFailureText, validateCellData } from './dataVerification';
import {
  datenum_local,
  formatScientificForComputedNumber,
  formatMForNumericCellAvoidingGsRules,
  genarate,
  genarateOrCurrencyPrefixed,
  is_date,
  isCurrencyLikeNumberFormat,
  isSixteenPlusDigitIntegerString,
  refreshGeneralNumericDisplay,
  shouldUseScientificForComputedNumber,
  update,
} from './format';
import {
  getCanonicalDateEditFormat,
  getDateEditFormatForCell,
} from './date-base-locale';
import { punchRectHoleInCellFormatRanges } from '../utils/range-format';
import { clearCellError } from '../api';
import {
  delFunctionGroup,
  execfunction,
  execFunctionGroup,
  functionHTMLGenerate,
  getcellrange,
  isTodayNowPureArithmeticDateResult,
  iscelldata,
  suppressFormulaRangeSelectionForInitialEdit,
  ensureFormulaRangeToSheet,
  returnToFormulaOriginSheet,
} from './formula';
import { isFormulaEvalPending } from './formula-async-eval';
import {
  convertSpanToShareString,
  getHyperlinksFromInlineSegments,
  isInlineStringCell,
  isInlineStringCT,
} from './inline-string';
import {
  detectDateFormat,
  isRealNull,
  isRealNum,
  valueIsError,
} from './validation';
import { getCellTextInfo } from './text';
import { locale } from '../locale';
import { spillSortResult } from './sort';

// TODO put these in context ref
// let rangestart = false;
// let rangedrag_column_start = false;
// let rangedrag_row_start = false;

/** Extra px below measured text for auto row height (wrap + multiline edits). */
const AUTO_ROW_HEIGHT_VERTICAL_PADDING = 8;

/**
 * Recompute auto row height for one row from wrap/inline cells; updates cfg.rowlen and ctx.config.
 * Used from updateCell and deleteSelectedCellText (bulk clear).
 */
export function recalcAutoRowHeightForRow(
  ctx: Context,
  r: number,
  d: CellMatrix,
  canvas: CanvasRenderingContext2D | null | undefined,
): void {
  if (!canvas) return;

  const sheetIdx = getSheetIndex(ctx, ctx.currentSheetId as string) as number;
  const cfg = ctx.luckysheetfile[sheetIdx]?.config || {};
  if (cfg.customHeight?.[r]) return;

  const { defaultrowlen } = ctx;
  let nextRowLen = defaultrowlen;
  const rowData = d[r] || [];

  for (let col = 0; col < rowData.length; col += 1) {
    const rowCell = rowData[col];
    if (!rowCell) continue;
    if (!(rowCell?.tb === '2' || isInlineStringCell(rowCell))) continue;

    const cellWidth = cfg.columnlen?.[col] || ctx.defaultcollen;
    const textInfo = getCellTextInfo(rowCell as Cell, canvas, ctx, {
      r,
      c: col,
      cellWidth,
    });
    if (textInfo) {
      nextRowLen = Math.max(
        nextRowLen,
        textInfo.textHeightAll + AUTO_ROW_HEIGHT_VERTICAL_PADDING,
      );
    }
  }

  if (_.isNil(cfg.rowlen)) cfg.rowlen = {};
  if (nextRowLen > defaultrowlen) {
    cfg.rowlen[r] = nextRowLen;
  } else if (!_.isNil(cfg.rowlen?.[r])) {
    delete cfg.rowlen[r];
  }

  ctx.config = cfg;
}

export function normalizedCellAttr(
  cell: Cell,
  attr: keyof Cell,
  defaultFontSize = 10,
): any {
  const tf = { bl: 1, it: 1, ff: 1, cl: 1, un: 1 };
  let value: any = cell?.[attr];

  if (attr in tf || (attr === 'fs' && isInlineStringCell(cell))) {
    value ||= '0';
  } else if (['fc', 'bg', 'bc'].includes(attr)) {
    if (['fc', 'bc'].includes(attr)) {
      value ||= '#000000';
    }
    if (value?.indexOf('rgba') > -1) {
      value = rgbToHex(value);
    }
  } else if (attr.substring(0, 2) === 'bs') {
    value ||= 'none';
  } else if (attr === 'ht' || attr === 'vt') {
    // Spreadsheet-style default alignment:
    // - text: left
    // - number/date-time-like numeric cells: right
    const isExplicitPlainText = (cell as Cell)?.ct?.fa === '@';
    const isNumericCell =
      !!cell &&
      !isExplicitPlainText &&
      ((cell as Cell).ct?.t === 'n' ||
        typeof (cell as Cell).v === 'number' ||
        isRealNum((cell as Cell).v) ||
        isRealNum((cell as Cell).m));
    const defaultValue = attr === 'ht' ? (isNumericCell ? '2' : '1') : '0';
    value = !_.isNil(value) ? value.toString() : defaultValue;
    if (['0', '1', '2'].indexOf(value.toString()) === -1) {
      value = defaultValue;
    }
  } else if (attr === 'fs') {
    value ||= defaultFontSize.toString();
  } else if (attr === 'tb' || attr === 'tr') {
    value ||= '0';
  }

  return value;
}

export function normalizedAttr(
  data: CellMatrix,
  r: number,
  c: number,
  attr: keyof Cell,
): any {
  if (!data || !data[r]) {
    return null;
  }
  const cell = data[r][c];
  if (!cell) return undefined;
  return normalizedCellAttr(cell, attr);
}

function newlinesToBr(text: string) {
  if (!text) return '';
  return text.replace(/\r\n|\r|\n/g, '<br />');
}

/** Append `)` for each unmatched `(` when committing a formula (ignores parens inside "..." string literals, `""` escape). */
function closeUnclosedParenthesesInFormula(formula: string): string {
  if (!formula.startsWith('=') || formula.length <= 1) return formula;
  const body = formula.slice(1);
  let depth = 0;
  let inString = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
  }
  if (depth <= 0) return formula;
  return `${formula}${')'.repeat(depth)}`;
}

/**
 * Contenteditable can produce text/div/br nodes after linked spans in multiline edits.
 * convertSpanToShareString reads only spans, so normalize mixed children into spans
 * before extracting inline runs to avoid dropping trailing lines on commit.
 */
function normalizeEditorChildrenToSpans(editor: HTMLDivElement) {
  const hasNonSpanTopLevel = Array.from(editor.childNodes).some(
    (n) =>
      !(
        n.nodeType === Node.ELEMENT_NODE &&
        (n as HTMLElement).tagName === 'SPAN'
      ),
  );
  if (!hasNonSpanTopLevel) return;

  const out = document.createElement('div');
  const appendTextSpan = (text: string) => {
    if (!text) return;
    const sp = document.createElement('span');
    sp.className = 'luckysheet-input-span';
    sp.textContent = text;
    out.appendChild(sp);
  };
  const appendBreakSpan = () => {
    const sp = document.createElement('span');
    sp.className = 'luckysheet-input-span';
    sp.appendChild(document.createElement('br'));
    out.appendChild(sp);
  };

  for (const node of Array.from(editor.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.tagName === 'SPAN') {
        out.appendChild(el.cloneNode(true));
        continue;
      }
      if (el.tagName === 'BR') {
        appendBreakSpan();
        continue;
      }
      const text = (el.innerText ?? el.textContent ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
      const parts = text.split('\n');
      parts.forEach((part, idx) => {
        appendTextSpan(part);
        if (idx < parts.length - 1) appendBreakSpan();
      });
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
      const parts = text.split('\n');
      parts.forEach((part, idx) => {
        appendTextSpan(part);
        if (idx < parts.length - 1) appendBreakSpan();
      });
    }
  }

  editor.innerHTML = out.innerHTML;
}

export function getCellValue(
  r: number,
  c: number,
  data: CellMatrix,
  attr?: keyof Cell,
) {
  if (!attr) {
    attr = 'v';
  }

  let d_value;

  if (!_.isNil(r) && !_.isNil(c)) {
    d_value = data[r][c];
  } else if (!_.isNil(r)) {
    d_value = data[r];
  } else if (!_.isNil(c)) {
    const newData = data[0].map((col, i) => {
      return data.map((row) => {
        return row[i];
      });
    });
    d_value = newData[c];
  } else {
    return data;
  }

  let retv: any = d_value;

  if (_.isPlainObject(d_value)) {
    const d = d_value as Cell;
    retv = d[attr];

    if (attr === 'f' && !_.isNil(retv)) {
      const dCell = d as Cell;
      let fForDisplay = String(retv);
      const seg0v = dCell?.ct?.s?.[0]?.v;
      if (
        typeof seg0v === 'string' &&
        /[\r\n]/.test(seg0v) &&
        fForDisplay.startsWith('=')
      ) {
        const norm = (s: string) =>
          s
            .replace(/\u00a0/g, ' ')
            .replace(/\u200b/g, '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\n/g, '');
        const mirror = seg0v.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
        if (norm(mirror) === norm(fForDisplay)) {
          fForDisplay = mirror;
        }
      }
      retv = functionHTMLGenerate(fForDisplay);
    } else if (attr === 'f') {
      if (d?.ct?.t === 'd' && !_.isNil((d as Cell).v)) {
        const dateFormat = String(d?.ct?.fa || '');
        const hasTime =
          /\b(h|hh|H|HH|s|ss)\b/.test(dateFormat) || /AM\/PM/i.test(dateFormat);
        retv = update(
          getDateEditFormatForCell(dateFormat, hasTime),
          (d as Cell).v as any,
        );
      } else {
        retv = (d as Cell).v;
      }
    } else if (d && d.ct && d.ct.t === 'd') {
      retv = d.m;
    }

    if (d?.ct && isInlineStringCT(d.ct) && (attr === 'v' || attr === 'm')) {
      retv = newlinesToBr(d.ct.s[0]?.v);
    }
  }

  if (retv === undefined) {
    retv = null;
  }

  return retv;
}

export function setCellValue(
  ctx: Context,
  r: number,
  c: number,
  d: CellMatrix | null | undefined,
  v: any,
) {
  if (ctx.allowEdit === false || ctx.isFlvReadOnly) return;
  if (_.isNil(d)) {
    d = getFlowdata(ctx);
  }
  if (!d) return;

  // 若采用深拷贝，初始化时的单元格属性丢失
  // let cell = $.extend(true, {}, d[r][c]);
  // const oldValue = _.cloneDeep(d[r][c]);
  let cell = d[r][c];
  const hadDisplayValueBeforeEdit =
    !!cell &&
    !(
      isRealNull((cell as Cell).v) &&
      isRealNull((cell as Cell).m) &&
      isRealNull((cell as Cell).f)
    );

  let vupdate;

  if (_.isPlainObject(v)) {
    if (_.isNil(cell)) {
      cell = v;
    } else {
      if (!_.isNil(v.f)) {
        cell.f = v.f;
      } else if ('f' in cell) {
        delete cell.f;
      }
      if (!_.isNil(v.m)) {
        cell.m = v.m;
      }

      // if (!_.isNil(v.spl)) {
      //   cell.spl = v.spl;
      // }
      if (!_.isNil(v.baseCurrency)) {
        // @ts-ignore
        cell.baseValue = v.baseValue;
        // @ts-ignore
        cell.baseCurrency = v.baseCurrency;
        // @ts-ignore
        cell.baseCurrencyPrice = v.baseCurrencyPrice;
      }

      if (!_.isNil(v.ct)) {
        // Merge so formula mirror `ct.s` does not wipe format (`fa`/`t`) needed to compute `m`.
        cell.ct = _.isNil(cell.ct) ? v.ct : { ...cell.ct, ...v.ct };
      }
      // Preserve horizontal alignment from value object (e.g. when editing, keep number/currency right-aligned)
      if (!_.isNil(v.ht)) {
        cell.ht = v.ht;
      }
    }

    if (_.isPlainObject(v.v)) {
      vupdate = v.v.v;
    } else {
      vupdate = v.v;
    }
  } else {
    vupdate = v;
  }
  const incomingFormulaInlineSegments =
    _.isPlainObject(v) && Array.isArray((v as Cell)?.ct?.s)
      ? (v as Cell).ct!.s
      : null;
  let commaPresent = false;
  if (vupdate && typeof vupdate === 'string' && vupdate.includes(',')) {
    commaPresent = vupdate.includes(',');
    // Keep user-entered commas intact.
    // - Valid thousand-grouped inputs are parsed downstream by `genarate`.
    // - Invalid/random comma placement should remain text, not coerced to number.
  }

  const cellObj = _.isPlainObject(cell) ? (cell as Cell) : null;
  const isTextFormattedCell =
    cellObj != null && (cellObj.ct?.fa === '@' || cellObj.qp === 1);
  if (
    typeof vupdate === 'string' &&
    !isTextFormattedCell &&
    /^[+-]?\d+\.\d+$/.test(vupdate)
  ) {
    const normalizedDecimal = vupdate
      .replace(/(\.\d*?[1-9])0+$/, '$1')
      .replace(/\.0+$/, '');
    if (normalizedDecimal !== vupdate) {
      vupdate = normalizedDecimal;
    }
  }

  if (isRealNull(vupdate)) {
    if (_.isPlainObject(cell)) {
      delete cell!.m;
      // @ts-ignore
      delete cell.v;
    } else {
      cell = null;
    }

    d[r][c] = cell;
    // if (ctx?.hooks?.afterUpdateCell) {
    //   ctx.hooks.afterUpdateCell(r, c, oldValue, d[r][c] ?? null);
    // }

    return;
  }

  // 1.为null
  // 2.数据透视表的数据，flowdata的每个数据可能为字符串，结果就是cell === v === 一个字符串或者数字数据
  if (
    isRealNull(cell) ||
    ((_.isString(cell) || _.isNumber(cell)) && cell === v)
  ) {
    cell = {};
  }

  if (!cell) return;

  // Dependency recalcs (groupValuesRefresh, Yjs/sync) can deliver numeric formula results as
  // strings. Without coercion, `typeof vupdate === "number"` fails and we fall through to the
  // plain-numeric path that resets `ct` to General — dropping currency and other masks.
  if (
    !_.isNil((cell as Cell).f) &&
    typeof vupdate === 'string' &&
    isRealNum(vupdate) &&
    !valueIsError(vupdate)
  ) {
    const trimmed = vupdate.trim();
    if (
      !/^\d{6}(18|19|20)?\d{2}(0[1-9]|1[12])(0[1-9]|[12]\d|3[01])\d{3}(\d|X)$/i.test(
        trimmed,
      )
    ) {
      const coerced = Number(trimmed);
      if (Number.isFinite(coerced)) {
        vupdate = coerced;
      }
    }
  }

  const vupdateStr = vupdate.toString();

  if (vupdateStr.substr(0, 1) === "'") {
    cell.m = vupdateStr.substr(1);
    cell.ct = { fa: '@', t: 's' };
    cell.v = vupdateStr.substr(1);
    cell.qp = 1;
  } else if (cell.qp === 1) {
    cell.m = vupdateStr;
    cell.ct = { fa: '@', t: 's' };
    cell.v = vupdateStr;
  } else if (
    vupdateStr.toUpperCase() === 'TRUE' &&
    (_.isNil(cell.ct?.fa) || cell.ct?.fa !== '@')
  ) {
    cell.m = 'TRUE';
    cell.ct = { fa: 'General', t: 'b' };
    cell.v = true;
  } else if (
    vupdateStr.toUpperCase() === 'FALSE' &&
    (_.isNil(cell.ct?.fa) || cell.ct?.fa !== '@')
  ) {
    cell.m = 'FALSE';
    cell.ct = { fa: 'General', t: 'b' };
    cell.v = false;
  } else if (
    vupdateStr.substr(-1) === '%' &&
    isRealNum(vupdateStr.substring(0, vupdateStr.length - 1)) &&
    (_.isNil(cell.ct?.fa) || cell.ct?.fa !== '@')
  ) {
    cell.ct = { fa: '0%', t: 'n' };
    cell.v = vupdateStr.substring(0, vupdateStr.length - 1) / 100;
    cell.m = vupdate;
  } else if (valueIsError(vupdate)) {
    cell.m = vupdateStr;
    // cell.ct = { "fa": "General", "t": "e" };
    if (!_.isNil(cell.ct)) {
      cell.ct.t = 'e';
    } else {
      cell.ct = { fa: 'General', t: 'e' };
    }
    cell.v = vupdate;
  } else {
    if (isSixteenPlusDigitIntegerString(vupdateStr) && _.isNil(cell.f)) {
      const raw = vupdateStr.trim().replace(/,/g, '');
      cell.m = raw;
      cell.v = raw;
      if (cell.ct?.fa === '@') {
        cell.ct = { fa: '@', t: 's' };
      } else {
        cell.ct = { fa: 'General', t: 'g' };
      }
    } else if (!_.isNil(cell.f) && Array.isArray(vupdate)) {
      // Range spills (e.g. =A1:C1) arrive as matrices. Never run SSF/update with a numeric
      // currency mask on an array — it becomes NaN.00. Ref-format inference is scalar-only.
      // Spilled/matrix results: `Cell['v']` type is scalar-only at compile time, but runtime stores arrays.
      (cell as Omit<Cell, 'v'> & { v?: unknown }).v = vupdate;
      if (_.isNil(cell.ct)) {
        cell.ct = { fa: 'General', t: 'g' };
      } else {
        cell.ct = { ...cell.ct, fa: 'General', t: 'g' };
        delete cell.ct.dp;
      }
      cell.m = spilledMatrixFormulaDisplay(vupdate);
    } else if (
      !_.isNil(cell.f) &&
      typeof vupdate === 'number' &&
      Number.isFinite(vupdate) &&
      !/^\d{6}(18|19|20)?\d{2}(0[1-9]|1[12])(0[1-9]|[12]\d|3[01])\d{3}(\d|X)$/i.test(
        vupdateStr,
      )
    ) {
      cell.v = vupdate;
      // Multiline formula commits attach `ct.s` and `ensureFormulaCtFormatForMirror` fills
      // `fa`/`t`. Single-line commits often pass `ct: {}` so merge can leave `cell.ct` without
      // `fa`, and `update(cell.ct.fa, v)` cannot produce `m`. Default only missing fields.
      if (_.isNil(cell.ct)) {
        cell.ct = { fa: 'General', t: 'g' };
      } else {
        if (cell.ct.fa == null || cell.ct.fa === '') {
          cell.ct = { ...cell.ct, fa: 'General' };
        }
        if (cell.ct.t == null || cell.ct.t === '') {
          cell.ct = { ...cell.ct, t: 'g' };
        }
      }

      // Infer / refresh numeric format from referenced cells on every numeric formula write
      // (recalc paths), so changing A1:A3 from $ to € updates the SUM cell—not only when fa
      // is still General.
      const numericResultCanUseRefFmt =
        isRealNum(vupdate) &&
        /^[\d.,]+$/.test(vupdateStr.replace(/\s/g, '')) &&
        _.isNil((cell as Cell).qp) &&
        (cell as Cell).ct?.fa !== '@';

      if (numericResultCanUseRefFmt) {
        const flowdata = getFlowdata(ctx);
        const args = getContentInParentheses(cell?.f)?.split(',');
        const cellRefs = args?.map((arg) => arg.trim().toUpperCase());
        const formatted = processArray(cellRefs, d, flowdata);
        if (formatted) {
          cell.ct.fa = formatted;
          if (is_date(formatted)) {
            cell.ct.t = 'd';
          } else {
            cell.ct.t = 'n';
          }
        }
      }

      if (cell.v === Infinity || cell.v === -Infinity) {
        cell.m = cell.v.toString();
      } else {
        const v_p = Math.round((cell.v as number) * 1000000000) / 1000000000;
        if (shouldUseScientificForComputedNumber(v_p)) {
          cell.m = formatScientificForComputedNumber(v_p);
        } else if ((cell.v as number).toString().toLowerCase().indexOf('e') > -1) {
          cell.m = formatMForNumericCellAvoidingGsRules(cell.v as number);
        } else {
          if (_.isNil(cell.ct)) {
            const mask = genarate(v_p);
            if (mask != null) {
              cell.m = mask[0].toString();
            }
          } else {
            const mask = update(cell.ct.fa!, v_p);
            cell.m = mask.toString();
          }
        }
      }

      if (
        isTodayNowPureArithmeticDateResult(cell.f!, cell.v as number) &&
        (cell.ct?.fa === 'General' ||
          cell.ct?.t === 'g' ||
          (cell.ct?.t === 'n' && (!cell.ct?.fa || cell.ct?.fa === 'General')))
      ) {
        const hasTime = /\bNOW\s*\(/i.test(cell.f!);
        const fa = getCanonicalDateEditFormat(hasTime);
        cell.ct = { fa, t: 'd' };
        const vRound = Math.round((cell.v as number) * 1000000000) / 1000000000;
        cell.m = String(update(fa, vRound));
      }
    } else if (!_.isNil(cell.ct) && cell.ct.fa === '@') {
      cell.m = vupdateStr;
      cell.v = vupdate;
    } else if (cell.ct != null && cell.ct.t === 'd' && _.isString(vupdate)) {
      const mask = genarate(vupdate) as any;
      if (mask?.[1]?.t === 'd') {
        if (mask[1].fa === cell.ct.fa) {
          [cell.m, cell.ct, cell.v] = mask;
        } else {
          [, , cell.v] = mask;
          cell.m = update(cell.ct.fa!, cell.v);
        }
      } else {
        // Date cells edited via canonical base string with time should remain date cells.
        // If generic generate() did not return a date, fallback to explicit date detection.
        const df = detectDateFormat(vupdate);
        if (df) {
          const dateObj = new Date(
            df.year,
            df.month - 1,
            df.day,
            df.hours,
            df.minutes,
            df.seconds,
          );
          cell.v = datenum_local(dateObj);
          cell.m = update(cell.ct.fa!, cell.v);
        } else if (mask) {
          [cell.m, cell.ct, cell.v] = mask;
        }
      }
    } else if (
      !_.isNil(cell.ct) &&
      !_.isNil(cell.ct.fa) &&
      cell.ct.fa !== 'General'
    ) {
      let { fa } = cell.ct;
      const enteredEditByTyping =
        ctx.getRefs?.()?.globalCache?.enteredEditByTyping === true;
      const isInPlaceEditSession =
        ctx.luckysheetCellUpdate.length > 0 && !enteredEditByTyping;
      const shouldDropPercentFormatForDirectText =
        enteredEditByTyping &&
        fa.includes('%') &&
        !vupdateStr.includes('%') &&
        !isRealNum(vupdate);
      const shouldOverwritePercentFormat =
        isInPlaceEditSession && fa.includes('%') && !vupdateStr.includes('%');
      if (shouldDropPercentFormatForDirectText) {
        const gen = genarate(vupdate as any);
        if (gen) {
          const [m, ct, vv] = gen;
          cell.m = m == null ? '' : String(m);
          cell.ct = ct as Cell['ct'];
          cell.v = vv as Cell['v'];
          // Return to default alignment resolution for the new inferred type.
          delete cell.ht;
        } else {
          cell.m = vupdateStr;
          cell.v = vupdate;
          cell.ct = { fa: 'General', t: 's' };
          delete cell.ht;
        }
      } else if (shouldOverwritePercentFormat) {
        // Percent behaves as a literal suffix in editor input:
        // if user edits value without "%", drop percent format.
        if (
          isRealNum(vupdate) &&
          !/^\d{6}(18|19|20)?\d{2}(0[1-9]|1[12])(0[1-9]|[12]\d|3[01])\d{3}(\d|X)$/i.test(
            vupdateStr,
          )
        ) {
          if (typeof vupdate === 'string') {
            const flag = vupdate
              .split('')
              .every((ele) => ele === '0' || ele === '.');
            if (flag || /^0+\d/.test(vupdate)) {
              vupdate = parseFloat(vupdate);
            }
          }
          cell.v = vupdate;
          const preserveDp = cell.ct?.dp;
          cell.ct = { fa: 'General', t: 'g' };
          if (preserveDp != null && typeof preserveDp === 'number') {
            cell.ct.dp = preserveDp;
          }
          if (v.m) {
            cell.m = v.m;
          } else {
            refreshGeneralNumericDisplay(cell as Cell);
          }
        } else {
          const mask = genarateOrCurrencyPrefixed(
            vupdateStr,
            vupdate,
            locale(ctx).currencyDetail,
          );
          if (mask) {
            cell.m = mask[0].toString();
            [, cell.ct, cell.v] = mask;
          }
        }
      } else if (isRealNum(vupdate)) {
        // Only override fa when the user explicitly typed commas that the format doesn't support.
        // Conditions that compared format commas/decimals against input were removed because they
        // incorrectly changed an explicit format (e.g. "#,##0.00") when a plain value like "42" was typed,
        // causing the decimal places to be lost.
        if (commaPresent && !fa.includes(',')) {
          fa = getNumberFormat(String(vupdate), commaPresent);
        }
        vupdate = parseFloat(vupdate);
        if (
          fa.includes('%') &&
          !vupdateStr.includes('%') &&
          (!hadDisplayValueBeforeEdit || enteredEditByTyping)
        ) {
          // Empty cell already formatted as percent: treat freshly typed number
          // as percentage points (5 -> 5.00%, stored as 0.05).
          // Also apply this for sheet type-to-edit replacement on existing % cells
          // so typing "9" over "5.00%" becomes "9.00%", not "900.00%".
          vupdate /= 100;
        }
        if (cell?.ct) {
          cell.ct = { ...cell.ct, fa, t: 'n' };
        }
        const mask: any = update(fa, vupdate);

        if (mask === vupdate) {
          // 若原来单元格格式 应用不了 要更新的值，则获取更新值的 格式
          const gen = genarateOrCurrencyPrefixed(
            vupdateStr,
            vupdate,
            locale(ctx).currencyDetail,
          );
          if (gen) {
            const [m, ct, v] = gen;
            cell.m = m == null ? '' : String(m);
            cell.ct = ct as Cell['ct'];
            cell.v = v as Cell['v'];
          }
        } else {
          if (v.m) {
            cell.m = v.m;
          } else {
            cell.m = mask.toString();
          }
          cell.v = vupdate;
        }
      } else if (
        isCurrencyLikeNumberFormat(fa, locale(ctx).currencyDetail) &&
        typeof vupdate === 'string' &&
        !vupdateStr.startsWith('=') &&
        !isRealNum(vupdate)
      ) {
        // Google Sheets–like: text in a currency cell keeps the currency mask so the next numeric
        // entry still formats as currency (do not replace ct via genarate).
        cell.v = vupdateStr;
        cell.m = vupdateStr;
        cell.ct = { fa, t: 's' };
      } else {
        const mask: any = update(fa, vupdate);

        if (mask === vupdate) {
          // 若原来单元格格式 应用不了 要更新的值，则获取更新值的 格式
          const gen = genarateOrCurrencyPrefixed(
            vupdateStr,
            vupdate,
            locale(ctx).currencyDetail,
          );
          if (gen) {
            const [m, ct, v] = gen;
            cell.m = m == null ? '' : String(m);
            cell.ct = ct as Cell['ct'];
            cell.v = v as Cell['v'];
          }
        } else {
          if (v.m) {
            cell.m = v.m;
          } else {
            cell.m = mask.toString();
          }
          cell.v = vupdate;
        }
      }
    } else {
      if (
        isRealNum(vupdate) &&
        !/^\d{6}(18|19|20)?\d{2}(0[1-9]|1[12])(0[1-9]|[12]\d|3[01])\d{3}(\d|X)$/i.test(
          vupdate,
        )
      ) {
        if (typeof vupdate === 'string') {
          const flag = vupdate
            .split('')
            .every((ele) => ele === '0' || ele === '.');
          // Convert to number if: all zeros/dots, or has leading zeros that should be stripped
          if (flag || /^0+\d/.test(vupdate)) {
            vupdate = parseFloat(vupdate);
          }
        }
        cell.v =
          vupdate; /* 备注：如果使用parseFloat，1.1111111111111111会转换为1.1111111111111112 ? */
        const preserveDp = cell.ct?.dp;
        cell.ct = { fa: 'General', t: 'g' };
        if (preserveDp != null && typeof preserveDp === 'number') {
          cell.ct.dp = preserveDp;
        }
        if (v.m) {
          cell.m = v.m;
        } else {
          refreshGeneralNumericDisplay(cell as Cell);
        }
      } else {
        const mask = genarateOrCurrencyPrefixed(
          vupdateStr,
          vupdate,
          locale(ctx).currencyDetail,
        );
        if (mask) {
          cell.m = mask[0].toString();
          [, cell.ct, cell.v] = mask;
        }
      }
    }
  }

  // if (!server.allowUpdate && !luckysheetConfigsetting.pointEdit) {
  //   if (
  //     !_.isNil(cell.ct) &&
  //     /^(w|W)((0?)|(0\.0+))$/.test(cell.ct.fa) === false &&
  //     cell.ct.t === "n" &&
  //     !_.isNil(cell.v) &&
  //     parseInt(cell.v, 10).toString().length > 4
  //   ) {
  //     const autoFormatw = luckysheetConfigsetting.autoFormatw
  //       .toString()
  //       .toUpperCase();
  //     const { accuracy } = luckysheetConfigsetting;

  //     const sfmt = setAccuracy(autoFormatw, accuracy);

  //     if (sfmt !== "General") {
  //       cell.ct.fa = sfmt;
  //       cell.m = update(sfmt, cell.v);
  //     }
  //   }
  // }

  // Safety net: formula commits should always end with a display value `m`.
  // Some mixed multiline/auto-close paths can carry `f`+`v` forward while `m`
  // is still empty; derive it here without touching existing non-empty `m`.
  if (!_.isNil((cell as Cell).f) && isRealNull((cell as Cell).m)) {
    const formulaResult = (cell as Cell).v;
    if (cell?.ct?.t === 'd' && cell?.ct?.fa && !isRealNull(formulaResult)) {
      (cell as Cell).m = update(cell.ct.fa, formulaResult);
    } else if (typeof formulaResult === 'number') {
      const fa = cell?.ct?.fa;
      if (fa && fa !== 'General' && Number.isFinite(formulaResult)) {
        const vRound = Math.round(formulaResult * 1000000000) / 1000000000;
        (cell as Cell).m = String(update(fa, vRound));
      } else {
        refreshGeneralNumericDisplay(cell as Cell);
      }
    } else if (typeof formulaResult === 'boolean') {
      (cell as Cell).m = formulaResult ? 'TRUE' : 'FALSE';
    } else if (isRealNull(formulaResult)) {
      // Keep `m` present for formulas even when result is null/empty.
      (cell as Cell).m = '';
    } else {
      (cell as Cell).m = String(formulaResult);
    }
  }

  // Only persist formula mirror `ct.s` from the incoming `v` (multiline). Do not
  // reattach a stale `ct.s` from the pre-update cell, or single-line stays span-like.
  // Partial updates (e.g. `{ v, f }` from `groupValuesRefresh` after row/column
  // drag) omit `ct` entirely — they must not strip an existing multiline mirror.
  if (!_.isNil((cell as Cell).f)) {
    if (incomingFormulaInlineSegments) {
      if (!cell.ct) {
        cell.ct = { fa: 'General', t: 'g' };
      }
      cell.ct.s = incomingFormulaInlineSegments;
    } else if (
      cell?.ct &&
      _.isPlainObject(v) &&
      Object.prototype.hasOwnProperty.call(v, 'ct')
    ) {
      delete (cell as Cell).ct!.s;
    }
  }

  d[r][c] = cell;
  // if (ctx?.hooks?.afterUpdateCell) {
  //   ctx.hooks.afterUpdateCell(r, c, oldValue, d[r][c] ?? null);
  // }
  // after cell data update
  if (ctx.luckysheet_selection_range) {
    ctx.luckysheet_selection_range = [];
  }

  // Note: afterUpdateCell is invoked above (with old/new values).
}

export function getRealCellValue(
  r: number,
  c: number,
  data: CellMatrix,
  attr?: keyof Cell,
) {
  let value = getCellValue(r, c, data, 'm');
  if (_.isNil(value)) {
    value = getCellValue(r, c, data, attr);
    if (_.isNil(value)) {
      const ct = getCellValue(r, c, data, 'ct');
      if (isInlineStringCT(ct)) {
        value = ct.s;
      }
    }
  }

  return value;
}

export function mergeBorder(
  ctx: Context,
  d: CellMatrix,
  row_index: number,
  col_index: number,
) {
  if (!d || !d[row_index]) {
    console.warn('Merge info is null', row_index, col_index);
    return null;
  }
  const value = d[row_index][col_index];
  if (!value) return null;

  if (value?.mc) {
    const margeMaindata = value.mc;
    if (!margeMaindata) {
      console.warn('Merge info is null', row_index, col_index);
      return null;
    }
    col_index = margeMaindata.c;
    row_index = margeMaindata.r;

    if (_.isNil(d?.[row_index]?.[col_index])) {
      console.warn('Main merge Cell info is null', row_index, col_index);
      return null;
    }
    const col_rs = d[row_index]?.[col_index]?.mc?.cs;
    const row_rs = d[row_index]?.[col_index]?.mc?.rs;
    const mergeMain = d[row_index]?.[col_index]?.mc;

    if (
      !mergeMain ||
      _.isNil(mergeMain?.rs) ||
      _.isNil(mergeMain?.cs) ||
      _.isNil(col_rs) ||
      _.isNil(row_rs)
    ) {
      console.warn('Main merge info is null', mergeMain);
      return null;
    }

    let start_r: number;
    let end_r: number;
    let row: number | undefined;
    let row_pre: number | undefined;
    for (let r = row_index; r < mergeMain.rs + row_index; r += 1) {
      if (r === 0) {
        start_r = -1;
      } else {
        start_r = ctx.visibledatarow[r - 1] - 1;
      }

      end_r = ctx.visibledatarow[r];

      if (row_pre === undefined) {
        row_pre = start_r;
        row = end_r;
      } else if (row !== undefined) {
        row += end_r - start_r - 1;
      }
    }

    let start_c: number;
    let end_c: number;
    let col: number | undefined;
    let col_pre: number | undefined;

    for (let c = col_index; c < mergeMain.cs + col_index; c += 1) {
      if (c === 0) {
        start_c = 0;
      } else {
        start_c = ctx.visibledatacolumn[c - 1];
      }

      end_c = ctx.visibledatacolumn[c];

      if (col_pre === undefined) {
        col_pre = start_c;
        col = end_c;
      } else if (col !== undefined) {
        col += end_c - start_c;
      }
    }

    if (_.isNil(row_pre) || _.isNil(col_pre) || _.isNil(row) || _.isNil(col)) {
      console.warn(
        'Main merge info row_pre or col_pre or row or col is null',
        mergeMain,
      );
      return null;
    }

    return {
      row: [row_pre, row, row_index, row_index + row_rs - 1],
      column: [col_pre, col, col_index, col_index + col_rs - 1],
    };
  }
  return null;
}

function mergeMove(
  ctx: Context,
  mc: any,
  columnseleted: number[],
  rowseleted: number[],
  s: Partial<Selection>,
  top: number,
  height: number,
  left: number,
  width: number,
) {
  const row_st = mc.r;
  const row_ed = mc.r + mc.rs - 1;
  const col_st = mc.c;
  const col_ed = mc.c + mc.cs - 1;
  let ismatch = false;

  columnseleted[0] = Math.min(columnseleted[0], columnseleted[1]);
  rowseleted[0] = Math.min(rowseleted[0], rowseleted[1]);

  if (
    (columnseleted[0] <= col_st &&
      columnseleted[1] >= col_ed &&
      rowseleted[0] <= row_st &&
      rowseleted[1] >= row_ed) ||
    (!(columnseleted[1] < col_st || columnseleted[0] > col_ed) &&
      !(rowseleted[1] < row_st || rowseleted[0] > row_ed))
  ) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return null;

    const margeset = mergeBorder(ctx, flowdata, mc.r, mc.c);
    if (margeset) {
      const row = margeset.row[1];
      const row_pre = margeset.row[0];
      const col = margeset.column[1];
      const col_pre = margeset.column[0];

      if (!(columnseleted[1] < col_st || columnseleted[0] > col_ed)) {
        // 向上滑动
        if (rowseleted[0] <= row_ed && rowseleted[0] >= row_st) {
          height += top - row_pre;
          top = row_pre;
          rowseleted[0] = row_st;
        }

        // 向下滑动或者居中时往上滑动的向下补齐
        if (rowseleted[1] >= row_st && rowseleted[1] <= row_ed) {
          if (s.row_focus! >= row_st && s.row_focus! <= row_ed) {
            height = row - top;
          } else {
            height = row - top;
          }

          rowseleted[1] = row_ed;
        }
      }

      if (!(rowseleted[1] < row_st || rowseleted[0] > row_ed)) {
        if (columnseleted[0] <= col_ed && columnseleted[0] >= col_st) {
          width += left - col_pre;
          left = col_pre;
          columnseleted[0] = col_st;
        }

        // 向右滑动或者居中时往左滑动的向下补齐
        if (columnseleted[1] >= col_st && columnseleted[1] <= col_ed) {
          if (s.column_focus! >= col_st && s.column_focus! <= col_ed) {
            width = col - left;
          } else {
            width = col - left;
          }

          columnseleted[1] = col_ed;
        }
      }

      ismatch = true;
    }
  }

  if (ismatch) {
    return [columnseleted, rowseleted, top, height, left, width];
  }
  return null;
}

export function mergeMoveMain(
  ctx: Context,
  columnseleted: number[],
  rowseleted: number[],
  s: Partial<Selection>,
  top: number,
  height: number,
  left: number,
  width: number,
) {
  const mergesetting = ctx.config.merge;

  if (!mergesetting) {
    return null;
  }

  const mcset = Object.keys(mergesetting);

  rowseleted[1] = Math.max(rowseleted[0], rowseleted[1]);
  columnseleted[1] = Math.max(columnseleted[0], columnseleted[1]);

  let offloop = true;
  const mergeMoveData: any = {};

  while (offloop) {
    offloop = false;

    for (let i = 0; i < mcset.length; i += 1) {
      const key = mcset[i];
      const mc = mergesetting[key];

      if (key in mergeMoveData) {
        continue;
      }

      const changeparam = mergeMove(
        ctx,
        mc,
        columnseleted,
        rowseleted,
        s,
        top,
        height,
        left,
        width,
      );

      if (changeparam != null) {
        mergeMoveData[key] = mc;

        // @ts-ignore
        [columnseleted, rowseleted, top, height, left, width] = changeparam;

        offloop = true;
      } else {
        delete mergeMoveData[key];
      }
    }
  }

  return [columnseleted, rowseleted, top, height, left, width];
}

export function cancelFunctionrangeSelected(ctx: Context) {
  if (ctx.formulaCache.selectingRangeIndex === -1) {
    ctx.formulaRangeSelect = undefined;
  }
  // $("#luckysheet-row-count-show, #luckysheet-column-count-show").hide();
  // // $("#luckysheet-cols-h-selected, #luckysheet-rows-h-selected").hide();
  // $("#luckysheet-formula-search-c, #luckysheet-formula-help-c").hide();
}

export function cancelNormalSelected(ctx: Context) {
  cancelFunctionrangeSelected(ctx);

  ctx.luckysheetCellUpdate = [];
  ctx.formulaRangeHighlight = [];
  ctx.functionHint = null;
  // $("#fortune-formula-functionrange .fortune-formula-functionrange-highlight").remove();
  // $("#luckysheet-input-box").removeAttr("style");
  // $("#luckysheet-input-box-index").hide();
  // $("#luckysheet-wa-functionbox-cancel, #luckysheet-wa-functionbox-confirm").removeClass("luckysheet-wa-calculate-active");

  ctx.formulaCache.rangestart = false;
  ctx.formulaCache.rangedrag_column_start = false;
  ctx.formulaCache.rangedrag_row_start = false;
  ctx.formulaCache.rangeSelectionActive = null;
  ctx.formulaCache.keyboardRangeSelectionLock = false;
  ctx.formulaCache.formulaKeyboardRefSync = false;
  ctx.formulaCache.func_selectedrange = undefined;
  ctx.formulaCache.rangetosheet = undefined;
  ctx.formulaCache.refocusFormulaEditorAfterSheetSwitch = false;
  ctx.formulaCache.formulaEditorOwner = null;
}

/** Spilled/matrix formula results — not numeric scalars. */
function isFormulaResultNumericScalar(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'string') {
    return false;
  }
  return /^[\d.,]+$/.test(value.replace(/\s/g, ''));
}

function spilledMatrixFormulaDisplay(matrix: unknown): string {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    return '';
  }
  const first = matrix[0];
  if (Array.isArray(first) && matrix.every((row) => Array.isArray(row))) {
    return (matrix as unknown[][])
      .map((row) => row.map((x) => String(x ?? '')).join(', '))
      .join('; ');
  }
  return (matrix as unknown[]).map((x) => String(x ?? '')).join(', ');
}

// formula.updatecell
export function updateCell(
  ctx: Context,
  r: number,
  c: number,
  $input?: HTMLDivElement | null,
  value?: any,
  canvas?: CanvasRenderingContext2D,
) {
  try {
    if (ctx.allowEdit === false || ctx.isFlvReadOnly) return;

    // Cross-sheet formula pick: write back to the sheet where the edit started.
    returnToFormulaOriginSheet(ctx);
    // Origin may have been demoted while picking on another tab — hydrate first
    // so we don't early-return on a null flowdata and leave a stale 0.
    ensureSheetFlowdata(ctx);

    const rawInputText = $input?.innerText;
    const normalizedFormulaInputText = (rawInputText || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u200b/g, '')
      .trimStart();
    const normalizeFormulaExecText = (s: string) =>
      s.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
    const normalizeInlineStringLineBreaks = (s: string) =>
      s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
    /** Keep `fa`/`t` whenever we attach formula mirror `ct.s` so setCellValue can compute `m`. */
    const ensureFormulaCtFormatForMirror = (cellLike: Cell) => {
      if (!cellLike.ct) cellLike.ct = {};
      if (
        cellLike.f &&
        Array.isArray(cellLike.ct.s) &&
        cellLike.ct.s.length > 0
      ) {
        if (cellLike.ct.fa == null || cellLike.ct.fa === '') {
          cellLike.ct.fa = 'General';
        }
        if (cellLike.ct.t == null || cellLike.ct.t === '') {
          cellLike.ct.t = 'g';
        }
      }
    };
    let autoClosedFormulaSuffix = '';
    const getFormulaInlineStringSnapshot = (
      fallbackFormula: string | undefined,
      suffix = autoClosedFormulaSuffix,
    ): string => {
      const raw = rawInputText ?? '';
      if (raw.length > 0) {
        return normalizeInlineStringLineBreaks(
          normalizeFormulaExecText(raw) + suffix,
        );
      }
      return normalizeInlineStringLineBreaks(
        normalizeFormulaExecText(fallbackFormula ?? ''),
      );
    };
    let inputText = rawInputText;
    if (inputText?.startsWith('=')) {
      inputText = normalizeFormulaExecText(inputText).replace(/[\r\n]/g, '');
    }
    const inputHtml = $input?.innerHTML;
    const hasFormulaLineBreakInHtml =
      !!inputHtml &&
      (/<br\s*\/?>/i.test(inputHtml) || /[\r\n]/.test(inputHtml));
    const hasFormulaLineBreakInRawText =
      !!rawInputText && /[\r\n]/.test(rawInputText);
    const shouldPersistFormulaEditHtml =
      !!inputHtml &&
      !!rawInputText &&
      normalizedFormulaInputText.startsWith('=') &&
      (hasFormulaLineBreakInHtml || hasFormulaLineBreakInRawText);

    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    // if (!checkProtectionLocked(r, c, ctx.currentSheetId)) {
    //   return;
    // }

    // 数据验证 输入数据无效时禁止输入
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const { dataVerification } = ctx.luckysheetfile[index];

    // --- hyperlink sync support ---
    const sheetFile = ctx.luckysheetfile[index] as any;
    // --- end ---

    if (!_.isNil(dataVerification)) {
      const dvItem = dataVerification[`${r}_${c}`];
      if (
        !_.isNil(dvItem) &&
        dvItem.prohibitInput &&
        !validateCellData(ctx, dvItem, inputText)
      ) {
        const failureText = getFailureText(ctx, dvItem);

        cancelNormalSelected(ctx);
        ctx.warnDialog = failureText;

        return;
      }
    }

    let curv = flowdata[r][c];

    const enteredEditByTyping =
      ctx.getRefs?.()?.globalCache?.enteredEditByTyping === true;
    const inputLooksLikeOnlySeededPercent =
      enteredEditByTyping &&
      typeof inputText === 'string' &&
      inputText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim() === '%' &&
      typeof (curv as any)?.ct?.fa === 'string' &&
      String((curv as any).ct.fa).includes('%');
    if (inputLooksLikeOnlySeededPercent) {
      // Type-to-edit on % cells pre-seeds a trailing "%". If user exits edit
      // without entering any actual value, do not persist that placeholder.
      inputText = '';
    }

    // ctx.old value for hook function
    const oldValue = _.cloneDeep(curv);

    const isPrevInline = isInlineStringCell(curv);
    let isCurInline =
      inputText?.slice(0, 1) !== '=' && inputHtml?.substring(0, 5) === '<span';

    let isCopyVal = false;
    if (!isCurInline && inputText && inputText.length > 0) {
      const splitArr = inputText
        .replace(/\r\n/g, '_x000D_')
        .replace(/&#13;&#10;/g, '_x000D_')
        .replace(/\r/g, '_x000D_')
        .replace(/\n/g, '_x000D_')
        .split('_x000D_');
      if (splitArr.length > 1 && inputHtml !== '<br>') {
        isCopyVal = true;
        isCurInline = true;
        inputText = splitArr.join('\r\n');
      }
    }

    if (curv?.ct && !value && !isCurInline && isPrevInline) {
      delete curv.ct.s;
      curv.ct.t = 'g';
      curv.ct.fa = 'General';
      curv.tb = '1';
      value = '';
    } else if (isCurInline) {
      if (!_.isPlainObject(curv)) {
        curv = {};
      }
      curv ||= {};
      const fontSize = curv.fs || 10;

      if (!curv.ct) {
        curv.ct = {};
        curv.ct.fa = 'General';
        curv.tb = '1';
      }

      curv.ct.t = 'inlineStr';

      normalizeEditorChildrenToSpans($input!);
      curv.ct.s = convertSpanToShareString(
        $input!.querySelectorAll('span'),
        curv,
      );

      delete curv.fs;
      delete curv.f;
      delete curv._formulaEditHtml;
      delete curv.v;
      delete curv.m;
      curv.fs = fontSize;
      if (isCopyVal) {
        curv.ct.s = [
          {
            v: inputText,
            fs: fontSize,
          },
        ];
      }
    }

    // API, we get value from user
    value = value || inputText;
    if (_.isString(value) && value.startsWith('=')) {
      value = quoteSheetNamesInFormula(
        normalizeFormulaExecText(value),
        ctx.luckysheetfile.map((f) => f.name),
      );
    }
    if (_.isString(value) && value.startsWith('=') && value.length > 1) {
      const closedValue = closeUnclosedParenthesesInFormula(value);
      if (
        shouldPersistFormulaEditHtml &&
        (rawInputText ?? '').startsWith('=') &&
        closedValue.length > value.length
      ) {
        autoClosedFormulaSuffix = closedValue.slice(value.length);
      }
      value = closedValue;
    } else if (
      _.isPlainObject(value) &&
      _.isString((value as Cell).f) &&
      (value as Cell).f!.startsWith('=') &&
      (value as Cell).f!.length > 1
    ) {
      const originalFormula = (value as Cell).f!;
      const closedFormula = closeUnclosedParenthesesInFormula(
        quoteSheetNamesInFormula(
          originalFormula,
          ctx.luckysheetfile.map((f) => f.name),
        ),
      );
      if (
        shouldPersistFormulaEditHtml &&
        (rawInputText ?? '').startsWith('=') &&
        closedFormula.length > originalFormula.length
      ) {
        autoClosedFormulaSuffix = closedFormula.slice(originalFormula.length);
      }
      (value as Cell).f = closedFormula;
    }
    const shouldPersistFormulaHtmlSnapshot =
      shouldPersistFormulaEditHtml && autoClosedFormulaSuffix.length === 0;
    const shouldClearError = oldValue?.f
      ? oldValue.f !== value
      : oldValue?.v !== value;

    if (shouldClearError) {
      clearCellError(ctx, r, c);
    }

    // Hook function
    if (ctx.hooks.beforeUpdateCell?.(r, c, value) === false) {
      cancelNormalSelected(ctx);
      return;
    }

    // Date edit mode uses a canonical editor value (from getCellValue(..., 'f')).
    // If user just enters/leaves edit without changing it, do not rewrite display format.
    const currentCell = _.isPlainObject(curv) ? (curv as Cell) : null;
    if (
      _.isString(value) &&
      currentCell?.ct?.t === 'd' &&
      value === getCellValue(r, c, flowdata, 'f')
    ) {
      cancelNormalSelected(ctx);
      return;
    }

    if (!isCurInline) {
      if (isRealNull(value) && !isPrevInline) {
        if (!curv || (isRealNull(curv.v) && !curv.spl && !curv.f)) {
          cancelNormalSelected(ctx);
          return;
        }
      } else if (curv && curv.qp !== 1) {
        if (
          _.isPlainObject(curv) &&
          (value === curv.f || value === curv.v || value === curv.m)
        ) {
          cancelNormalSelected(ctx);
          return;
        }
        if (value === curv) {
          cancelNormalSelected(ctx);
          return;
        }
      }

      if (_.isString(value) && value.slice(0, 1) === '=' && value.length > 1) {
      } else if (
        _.isPlainObject(curv) &&
        curv &&
        curv.ct &&
        curv.ct.fa &&
        curv.ct.fa !== '@' &&
        !isRealNull(value)
      ) {
        delete curv.m; // 更新时间m处理 ， 会实际删除单元格数据的参数（flowdata时已删除）
        if (curv.f) {
          // 如果原来是公式，而更新的数据不是公式，则把公式删除
          delete curv.f;
          delete curv._formulaEditHtml;
          delete curv.spl; // 删除单元格的sparklines的配置串
        }
      }
    }

    // TODO window.luckysheet_getcelldata_cache = null;

    let isRunExecFunction = true;

    const d = flowdata; // TODO const d = editor.deepCopyFlowData(flowdata);
    let dynamicArrayItem = null; // 动态数组

    if (_.isPlainObject(curv)) {
      if (!isCurInline) {
        if (
          _.isString(value) &&
          value.slice(0, 1) === '=' &&
          value.length > 1
        ) {
          const v = execfunction(ctx, value, r, c, undefined, undefined, true);
          isRunExecFunction = false;
          curv = _.cloneDeep(d?.[r]?.[c] || {});
          [, curv.v, curv.f] = v;
          if (!curv.ct) {
            curv.ct = {};
          }
          if (shouldPersistFormulaEditHtml) {
            curv.ct.s = [
              {
                v: getFormulaInlineStringSnapshot(curv.f),
                fs: curv.fs || 10,
              },
            ];
            ensureFormulaCtFormatForMirror(curv);
          } else {
            delete curv.ct.s;
          }
          if (shouldPersistFormulaHtmlSnapshot) {
            curv._formulaEditHtml = inputHtml;
          } else {
            delete curv._formulaEditHtml;
          }

          // 打进单元格的sparklines的配置串， 报错需要单独处理。
          if (v.length === 4 && v[3].type === 'sparklines') {
            delete curv.m;
            delete curv.v;

            const curCalv = v[3].data;

            if (_.isArray(curCalv) && !_.isPlainObject(curCalv[0])) {
              [curv.v] = curCalv;
            } else {
              curv.spl = v[3].data;
            }
          } else if (v.length === 4 && v[3].type === 'dynamicArrayItem') {
            dynamicArrayItem = v[3].data;
          }
        }
        // from API setCellValue,luckysheet.setCellValue(0, 0, {f: "=sum(D1)", bg:"#0188fb"}),value is an object, so get attribute f as value
        else if (_.isPlainObject(value)) {
          const valueFunction = value.f;

          if (
            _.isString(valueFunction) &&
            valueFunction.slice(0, 1) === '=' &&
            valueFunction.length > 1
          ) {
            const v = execfunction(
              ctx,
              valueFunction,
              r,
              c,
              undefined,
              undefined,
              true,
            );
            isRunExecFunction = false;
            // get v/m/ct

            curv = _.cloneDeep(d?.[r]?.[c] || {});
            [, curv.v, curv.f] = v;
            if (!curv.ct) {
              curv.ct = {};
            }
            if (shouldPersistFormulaEditHtml) {
              curv.ct.s = [
                {
                  v: getFormulaInlineStringSnapshot(curv.f),
                  fs: curv.fs || 10,
                },
              ];
              ensureFormulaCtFormatForMirror(curv);
            } else {
              delete curv.ct.s;
            }
            if (shouldPersistFormulaHtmlSnapshot) {
              curv._formulaEditHtml = inputHtml;
            } else {
              delete curv._formulaEditHtml;
            }

            // 打进单元格的sparklines的配置串， 报错需要单独处理。
            if (v.length === 4 && v[3].type === 'sparklines') {
              delete curv.m;
              delete curv.v;

              const curCalv = v[3].data;

              if (_.isArray(curCalv) && !_.isPlainObject(curCalv[0])) {
                [curv.v] = curCalv;
              } else {
                curv.spl = v[3].data;
              }
            } else if (v.length === 4 && v[3].type === 'dynamicArrayItem') {
              dynamicArrayItem = v[3].data;
            }
          }
          // from API setCellValue,luckysheet.setCellValue(0, 0, {f: "=sum(D1)", bg:"#0188fb"}),value is an object, so get attribute f as value
          else {
            Object.keys(value).forEach((attr) => {
              (curv as Record<string, any>)[attr] = value[attr];
            });
            clearCellError(ctx, r, c);
          }
        } else {
          clearCellError(ctx, r, c);
          delFunctionGroup(ctx, r, c);

          curv = _.cloneDeep(d?.[r]?.[c] || {});
          curv.v = value;

          delete curv.f;
          delete curv._formulaEditHtml;
          delete curv.spl;
          // Drop the previous display string so `setCellValue` recomputes `m`
          // from the new `v` (otherwise a stale mask like "4" survives a 4->5 edit).
          delete curv.m;

          // FLV crypto denomination --START--
          const decemialCount = oldValue?.m?.toString().includes('.')
            ? oldValue?.m?.toString().split(' ')[0].split('.')[1]?.length
            : 0;
          const coin = oldValue?.m?.toString().split(' ')[1];
          if (
            typeof curv === 'object' &&
            curv?.baseValue &&
            oldValue?.baseCurrencyPrice
          ) {
            curv.m = `${(
              parseFloat(value as string) /
              (oldValue.baseCurrencyPrice as number)
            ).toFixed(decemialCount || 2)} ${coin}`;
            curv.baseValue = value;
          }
          // FLV crypto denomination --END--
          execFunctionGroup(ctx, r, c, curv);
          isRunExecFunction = false;
          if (curv.qp === 1 && `${value}`.substring(0, 1) !== "'") {
            // if quotePrefix is 1, cell is force string, cell clear quotePrefix when it is updated
            curv.qp = 0;
            if (curv.ct) {
              curv.ct.fa = 'General';
              curv.ct.t = 'n';
            }
          }
        }
      }
      value = curv;
    } else {
      if (_.isString(value) && value.slice(0, 1) === '=' && value.length > 1) {
        const v = execfunction(ctx, value, r, c, undefined, undefined, true);
        isRunExecFunction = false;
        value = {
          v: v[1],
          f: v[2],
        };
        value.ct = value.ct || {};
        if (shouldPersistFormulaEditHtml) {
          value.ct.s = [
            {
              v: getFormulaInlineStringSnapshot(value.f),
              fs: (value as Cell).fs || 10,
            },
          ];
          ensureFormulaCtFormatForMirror(value as Cell);
        } else {
          delete (value as Cell).ct?.s;
        }

        if (isFormulaResultNumericScalar(value.v)) {
          const args = getContentInParentheses(value?.f)?.split(',');
          const cellRefs = args?.map((arg) => arg.trim().toUpperCase());
          const formatted = processArray(cellRefs, d, flowdata);
          if (formatted) {
            const numArg =
              typeof value.v === 'number'
                ? value.v
                : Number(String(value.v).replace(/,/g, ''));
            value.m = Number.isFinite(numArg)
              ? String(update(formatted, numArg))
              : String(value.v);
            value.ct = {
              ...value.ct,
              fa: formatted,
              t: is_date(formatted) ? 'd' : 'n',
            };
          }
        }

        // 打进单元格的sparklines的配置串， 报错需要单独处理。
        if (v.length === 4 && v[3].type === 'sparklines') {
          const curCalv = v[3].data;

          if (_.isArray(curCalv) && !_.isPlainObject(curCalv[0])) {
            [value.v] = curCalv;
          } else {
            value.spl = v[3].data;
          }
        } else if (v.length === 4 && v[3].type === 'dynamicArrayItem') {
          dynamicArrayItem = v[3].data;
        }
      }
      // from API setCellValue,luckysheet.setCellValue(0, 0, {f: "=sum(D1)", bg:"#0188fb"}),value is an object, so get attribute f as value
      else if (_.isPlainObject(value)) {
        const valueFunction = value.f;

        if (
          _.isString(valueFunction) &&
          valueFunction.slice(0, 1) === '=' &&
          valueFunction.length > 1
        ) {
          const v = execfunction(
            ctx,
            valueFunction,
            r,
            c,
            undefined,
            undefined,
            true,
          );
          isRunExecFunction = false;
          // value = {
          //     "v": v[1],
          //     "f": v[2]
          // };

          // update attribute v
          [, value.v, value.f] = v;
          value.ct = value.ct || {};
          if (shouldPersistFormulaEditHtml) {
            value.ct.s = [
              {
                v: getFormulaInlineStringSnapshot(value.f),
                fs: (value as Cell).fs || 10,
              },
            ];
            ensureFormulaCtFormatForMirror(value as Cell);
          } else {
            delete (value as Cell).ct?.s;
          }

          // 打进单元格的sparklines的配置串， 报错需要单独处理。
          if (v.length === 4 && v[3].type === 'sparklines') {
            const curCalv = v[3].data;

            if (_.isArray(curCalv) && !_.isPlainObject(curCalv[0])) {
              [value.v] = curCalv;
            } else {
              value.spl = v[3].data;
            }
          } else if (v.length === 4 && v[3].type === 'dynamicArrayItem') {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            dynamicArrayItem = v[3].data;
          }
        } else {
          clearCellError(ctx, r, c);
          const v = curv;
          if (_.isNil(value.v)) {
            value.v = v;
          }
        }
      } else {
        clearCellError(ctx, r, c);
        delFunctionGroup(ctx, r, c);
        execFunctionGroup(ctx, r, c, value);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        isRunExecFunction = false;
      }
    }

    // value maybe an object
    // FLV crypto denomination --START--
    const decemialCount = oldValue?.m?.toString().includes('.')
      ? oldValue?.m?.toString().split(' ')[0].split('.')[1]?.length
      : 0;
    const coin = oldValue?.m?.toString().split(' ')[1];
    if (typeof value === 'object' && value.baseValue && !value?.m) {
      value.m = `${
        // @ts-expect-error later

        (parseFloat(value?.v as string) / oldValue?.baseCurrencyPrice).toFixed(
          decemialCount || 2,
        )
        } ${coin}`;
    }

    // FLV crypto denomination --END--
    if (typeof value === 'string') {
      value = {
        ct: {
          fa: 'General',
          t: 'g',
        },
        v: value,
        tb: '1',
      };
    } else if (typeof value === 'object' && !value.tb) {
      value.tb = '1';
    }

    const isValueArray = Array.isArray((value as any)?.v?.[0]);

    try {
      if (isValueArray) {
        if (spillSortResult(ctx, r, c, value, d)) {
          cancelNormalSelected(ctx);
          if (ctx.hooks.afterUpdateCell) {
            const newValue = _.cloneDeep(d[r][c]);
            // Genuine user-driven edit (typed/committed via updateCell) — flag it
            // so RTC joiners persist + broadcast it. Remote applies use
            // setCellValueInternal and never reach here.
            ctx.hooks.onLocalCellEdit?.();
            setTimeout(() =>
              ctx.hooks.afterUpdateCell?.(r, c, oldValue, newValue),
            );
          }
          if (!isFormulaEvalPending(ctx)) {
            ctx.formulaCache.execFunctionGlobalData = null;
          }
          return;
        }
      }
    } catch (_e) { }

    // --- hyperlink support ---
    const hyperlinkKey = `${r}_${c}`;
    const prevHyperlink = sheetFile.hyperlink?.[hyperlinkKey];
    if (
      typeof value === 'object' &&
      value &&
      (value as Cell).ct?.t === 'inlineStr'
    ) {
      const links = getHyperlinksFromInlineSegments(value as Cell);
      if (!sheetFile.hyperlink) sheetFile.hyperlink = {};
      if (links.length === 0) {
        delete sheetFile.hyperlink[hyperlinkKey];
      } else {
        sheetFile.hyperlink[hyperlinkKey] =
          links.length === 1 ? links[0] : links;
      }
      if (typeof value === 'object' && value && 'hl' in (value as any)) {
        delete (value as any).hl;
      }
    } else {
      if (prevHyperlink && sheetFile.hyperlink) {
        delete sheetFile.hyperlink[hyperlinkKey];
      }
      if (typeof value === 'object' && value && 'hl' in (value as any)) {
        delete (value as any).hl;
      }
    }

    // --- end ---

    setCellValue(ctx, r, c, d, value);

    cancelNormalSelected(ctx);

    /*
    let RowlChange = false;
    const cfg =
      ctx.luckysheetfile?.[getSheetIndex(ctx, ctx.currentSheetId)]?.config ||
      {};
    if (!cfg.rowlen) {
      cfg.rowlen = {};
    }
    */

    const cfg =
      ctx.luckysheetfile[
        getSheetIndex(ctx, ctx.currentSheetId as string) as number
      ].config || {};

    // oldValue = cell before this edit. When content is deleted, new cell may be empty;
    // still recompute row height if the previous cell had wrap (tb "2") or inlineStr.
    const prevHadWrapOrInline =
      (oldValue?.tb === '2' && !_.isNil(oldValue?.v) && oldValue?.v !== '') ||
      isInlineStringCell(oldValue);

    const newCell = d[r][c];
    const newHasWrapOrInline =
      (newCell?.tb === '2' && !_.isNil(newCell?.v) && newCell?.v !== '') ||
      isInlineStringCell(newCell);

    if (
      (prevHadWrapOrInline || newHasWrapOrInline) &&
      !cfg.customHeight?.[r] &&
      canvas
    ) {
      // 自动换行 — recompute row height (grow/shrink) from wrap + inline cells
      recalcAutoRowHeightForRow(ctx, r, d, canvas);
    }

    // 动态数组
    /*
    let dynamicArray = null;
    if (dynamicArrayItem) {
      // let file = ctx.luckysheetfile[getSheetIndex(ctx.currentSheetId)];
      dynamicArray = $.extend(
        true,
        [],
        this.insertUpdateDynamicArray(dynamicArrayItem)
      );
      // dynamicArray.push(dynamicArrayItem);
    }
  
    let allParam = {
      dynamicArray,
    };
  
    if (RowlChange) {
      allParam = {
        cfg,
        dynamicArray,
        RowlChange,
      };
    }
    */
    if (ctx.hooks.afterUpdateCell) {
      const newValue = _.cloneDeep(flowdata[r][c]);
      const { afterUpdateCell } = ctx.hooks;
      // Genuine user-driven edit (typed/committed via updateCell) — flag it so
      // RTC joiners persist + broadcast it. Remote applies use
      // setCellValueInternal and never reach here.
      ctx.hooks.onLocalCellEdit?.();
      setTimeout(() => {
        afterUpdateCell?.(r, c, oldValue, newValue);
      });
    }

    if (!isFormulaEvalPending(ctx)) {
      ctx.formulaCache.execFunctionGlobalData = null;
    }
  } catch (e) {
    console.error(e);
    cancelNormalSelected(ctx);
  }
}

export function getOrigincell(ctx: Context, r: number, c: number, i: string) {
  const data = getFlowdata(ctx, i);
  if (_.isNil(r) || _.isNil(c)) {
    return null;
  }

  if (!data || !data[r] || !data[r][c]) {
    return null;
  }
  return data[r][c];
}

export function getcellFormula(
  ctx: Context,
  r: number,
  c: number,
  i: string,
  data?: any,
) {
  let cell;
  if (_.isNil(data)) {
    cell = getOrigincell(ctx, r, c, i);
  } else {
    cell = data[r][c];
  }

  if (_.isNil(cell)) {
    return null;
  }

  return cell.f;
}

export function getRange(ctx: Context) {
  const rangeArr = _.cloneDeep(ctx.luckysheet_select_save);
  const result: Range = [];
  if (!rangeArr) return result;

  for (let i = 0; i < rangeArr.length; i += 1) {
    const rangeItem = rangeArr[i];
    const temp = {
      row: rangeItem.row,
      column: rangeItem.column,
    };
    result.push(temp);
  }
  return result;
}

export function getFlattenedRange(ctx: Context, range?: Range) {
  range = range || getRange(ctx);

  const result: { r: number; c: number }[] = [];

  range.forEach((ele) => {
    // 这个data可能是个范围或者是单个cell
    const rs = ele.row;
    const cs = ele.column;
    for (let r = rs[0]; r <= rs[1]; r += 1) {
      for (let c = cs[0]; c <= cs[1]; c += 1) {
        // r c 当前的r和当前的c
        result.push({ r, c });
      }
    }
  });
  return result;
}

// 把选区范围数组转为string A1:A2
export function getRangetxt(
  ctx: Context,
  sheetId: string,
  range: SingleRange,
  currentId?: string,
) {
  let sheettxt = '';

  if (currentId == null) {
    currentId = ctx.currentSheetId;
  }

  if (sheetId !== currentId) {
    // Quote names that are not plain identifiers (spaces, `-`, etc.) so the
    // reference parses, e.g. `'Finance - 1'!A1`, `'Sheet-4'!H6`.
    const index = getSheetIndex(ctx, sheetId);
    if (index == null) return '';
    sheettxt = `${formatSheetNameForFormula(ctx.luckysheetfile[index].name)}!`;
  }

  const row0 = range.row[0];
  const row1 = range.row[1];
  const column0 = range.column[0];
  const column1 = range.column[1];

  if (row0 == null && row1 == null) {
    return `${sheettxt + indexToColumnChar(column0)}:${indexToColumnChar(
      column1,
    )}`;
  }
  if (column0 == null && column1 == null) {
    return `${sheettxt + (row0 + 1)}:${row1 + 1}`;
  }

  if (column0 === column1 && row0 === row1) {
    return sheettxt + indexToColumnChar(column0) + (row0 + 1);
  }

  return `${sheettxt + indexToColumnChar(column0) + (row0 + 1)
    }:${indexToColumnChar(column1)}${row1 + 1}`;
}

// 把string A1:A2转为选区数组
export function getRangeByTxt(ctx: Context, txt: string) {
  let range = [];
  if (txt.indexOf(',') !== -1) {
    const arr = txt.split(',');
    for (let i = 0; i < arr.length; i += 1) {
      if (iscelldata(arr[i])) {
        range.push(getcellrange(ctx, arr[i]));
      } else {
        range = [];
        break;
      }
    }
  } else {
    if (iscelldata(txt)) {
      range.push(getcellrange(ctx, txt));
    }
  }
  return range;
}

/**
 * Catches range strings the formula layer accepts (e.g. A1:B as “cell to column B”) that we
 * reject in CF / range modals. Both sides of a single `:` must agree: either each part
 * includes a row digit (A1, B2, 1) or neither does (A:B, whole-column / row-only style).
 */
function hasMismatchedRowSpecifiersOnColon(txt: string): boolean {
  const pieces = (txt ?? '').split(',');
  for (const raw of pieces) {
    const s = String(raw).trim();
    if (!s) continue;
    const afterBang =
      s.lastIndexOf('!') >= 0 ? s.slice(s.lastIndexOf('!') + 1) : s;
    if (afterBang.indexOf(':') === -1) continue;
    const seg = afterBang.split(':');
    if (seg.length !== 2) continue;
    const [left, right] = seg;
    if (left == null || right == null) return true;
    if (!String(left).trim() || !String(right).trim()) return true;
    const leftHasRow = /[0-9]/.test(String(left));
    const rightHasRow = /[0-9]/.test(String(right));
    if (leftHasRow !== rightHasRow) {
      return true;
    }
  }
  return false;
}

/**
 * True if the string is empty/whitespace (allowed while editing) or parses to at least
 * one range with {@link getRangeByTxt} (same rules as sheet range entry elsewhere), plus
 * stricter form checks for the conditional-format and range-dialog inputs.
 */
export function isValidRangeText(ctx: Context, txt: string): boolean {
  const t = (txt ?? '').trim();
  if (t === '') return true;
  if (hasMismatchedRowSpecifiersOnColon(t)) {
    return false;
  }
  return getRangeByTxt(ctx, t).length > 0;
}

export function isAllSelectedCellsInStatus(
  ctx: Context,
  attr: keyof Cell,
  status: any,
) {
  // editing mode
  if (!_.isEmpty(ctx.luckysheetCellUpdate)) {
    const w = window.getSelection();
    if (!w) return false;
    if (w.rangeCount === 0) return false;
    const range = w.getRangeAt(0);
    if (range.collapsed === true) {
      return false;
    }
    const { endContainer } = range;
    const { startContainer } = range;
    const toElement = (n: Node | null): HTMLElement | null => {
      if (!n) return null;
      if (n.nodeType === Node.ELEMENT_NODE) return n as HTMLElement;
      return n.parentElement;
    };
    const startEl = toElement(startContainer);
    const endEl = toElement(endContainer);
    const editorRoot =
      startEl?.closest('#luckysheet-rich-text-editor') ??
      endEl?.closest('#luckysheet-rich-text-editor') ??
      (toElement(range.commonAncestorContainer) as HTMLElement | null);

    const isStyleActive = (element: HTMLElement) => {
      const computed = window.getComputedStyle(element);
      const fontWeight = (computed.fontWeight || '').toLowerCase();
      const fontStyle = (computed.fontStyle || '').toLowerCase();
      const textDecorationLine = // Safari support fallback
        // @ts-ignore
        (
          computed.textDecorationLine ||
          computed.textDecoration ||
          ''
        ).toLowerCase();
      const borderBottomWidth = (
        computed.borderBottomWidth || ''
      ).toLowerCase();

      if (status === 1) {
        if (attr === 'bl') {
          if (fontWeight === 'bold') return true;
          const n = Number(fontWeight);
          return !Number.isNaN(n) && n >= 600;
        }
        if (attr === 'it') {
          return fontStyle === 'italic' || fontStyle === 'oblique';
        }
        if (attr === 'cl') {
          return textDecorationLine.includes('line-through');
        }
        if (attr === 'un') {
          return (
            textDecorationLine.includes('underline') ||
            (borderBottomWidth !== '' &&
              borderBottomWidth !== '0px' &&
              borderBottomWidth !== '0')
          );
        }
      }
      return false;
    };

    const selectedElements: HTMLElement[] = [];
    if (editorRoot) {
      const spans = editorRoot.querySelectorAll('span');
      spans.forEach((span) => {
        if (
          span.textContent &&
          span.textContent.length > 0 &&
          range.intersectsNode(span)
        ) {
          selectedElements.push(span);
        }
      });
    }

    if (selectedElements.length === 0) {
      if (startEl) selectedElements.push(startEl);
      if (endEl && endEl !== startEl) selectedElements.push(endEl);
    }

    if (selectedElements.length === 0) {
      return false;
    }

    return _.every(selectedElements, (el) => isStyleActive(el));
  }
  /* 获取选区内所有的单元格-扁平后的处理 */
  const cells = getFlattenedRange(ctx);
  const flowdata = getFlowdata(ctx);

  return cells.every(({ r, c }) => {
    const cell = flowdata?.[r]?.[c];
    if (_.isNil(cell)) {
      return false;
    }
    return cell[attr] === status;
  });
}

/** Apply luckysheet computeMap CF result (textColor, cellColor, font flags) to clipboard CSS. */
function applyConditionalFormatComputedStyle(
  style: Record<string, any>,
  checksCF: any | null | undefined,
) {
  if (!checksCF) return;
  if (checksCF.cellColor) {
    style.background = `${checksCF.cellColor}`;
  }
  if (checksCF.textColor) {
    style.color = checksCF.textColor;
  }
  if (checksCF.bold) {
    style.fontWeight = 'bold';
  }
  if (checksCF.italic) {
    style.fontStyle = 'italic';
  }
  if (checksCF.underline) {
    const cur = String(style.textDecoration || '').trim();
    const parts = cur ? cur.split(/\s+/).filter(Boolean) : [];
    if (!parts.includes('underline')) parts.push('underline');
    style.textDecoration = parts.join(' ');
  }
  if (checksCF.strikethrough) {
    const cur = String(style.textDecoration || '').trim();
    const parts = cur ? cur.split(/\s+/).filter(Boolean) : [];
    if (!parts.includes('line-through')) parts.push('line-through');
    style.textDecoration = parts.join(' ');
  }
}

export function getFontStyleByCell(
  cell: Cell | null | undefined,
  checksAF?: any[],
  checksCF?: any,
  isCheck = true,
) {
  const style: any = {};
  if (!cell) {
    return style;
  }
  // @ts-ignore
  _.forEach(cell, (v, key: keyof Cell) => {
    let value = cell[key];
    if (isCheck) {
      value = normalizedCellAttr(cell, key);
    }
    const valueNum = Number(value);
    if (key === 'bl' && valueNum !== 0) {
      style.fontWeight = 'bold';
    }

    if (key === 'it' && valueNum !== 0) {
      style.fontStyle = 'italic';
    }

    // if (key === "ff") {
    //   let f = value;
    //   if (!Number.isNaN(valueNum)) {
    //     f = locale_fontarray[parseInt(value)];
    //   } else {
    //     f = value;
    //   }
    //   style += "font-family: " + f + ";";
    // }

    if (key === 'fs' && !_.isNil(value)) {
      style.fontSize = `${valueNum}pt`;
    }

    if (
      (key === 'fc' && value !== '#000000') ||
      (checksAF?.length ?? 0) > 0 ||
      checksCF?.textColor
    ) {
      if (checksCF?.textColor) {
        style.color = checksCF.textColor;
      } else if ((checksAF?.length ?? 0) > 0) {
        [style.color] = checksAF!;
      } else {
        style.color = value;
      }
    }

    if (key === 'cl' && valueNum !== 0) {
      style.textDecoration = 'line-through';
    }

    if (key === 'un' && (valueNum === 1 || valueNum === 3)) {
      // @ts-ignore
      const color = cell._color ?? cell.fc;
      // @ts-ignore
      const fs = cell._fontSize ?? cell.fs;
      style.borderBottom = `${Math.floor(fs / 9)}px solid ${color}`;
    }
  });
  return style;
}

export function getStyleByCell(
  ctx: Context,
  d: CellMatrix,
  r: number,
  c: number,
  precomputedCfCompute?: ReturnType<typeof getComputeMap>,
) {
  let style: any = {};

  // 交替颜色
  //   const af_compute = alternateformat.getComputeMap();
  //   const checksAF = alternateformat.checksAF(r, c, af_compute);
  const checksAF: any = [];
  // 条件格式
  const cf_compute = precomputedCfCompute ?? getComputeMap(ctx);
  const checksCF = checkCF(r, c, cf_compute);

  const cell = d?.[r]?.[c];
  if (!cell) {
    if (!checksCF) {
      return {};
    }
    const out: Record<string, any> = {};
    applyConditionalFormatComputedStyle(out, checksCF);
    return out;
  }

  if (!checksCF?.cellColor) {
    if ((checksAF?.length ?? 0) > 1) {
      style.background = `${checksAF[1]}`;
    } else if ('bg' in cell) {
      style.background = `${normalizedCellAttr(cell, 'bg')}`;
    }
  }
  if ('ht' in cell) {
    const value = normalizedCellAttr(cell, 'ht');
    if (Number(value) === 0) {
      style.textAlign = 'center';
    } else if (Number(value) === 2) {
      style.textAlign = 'right';
      style.overflowWrap = 'anywhere';
    }
  }

  if ('tb' in cell) {
    if (Number(cell.tb) === 2) {
      style.overflowWrap = 'anywhere';
    }
  }

  if ('ff' in cell) {
    const value = normalizedCellAttr(cell, 'ff');
    const { fontarray } = locale(ctx);
    const ffIndex = parseInt(value, 10);
    style.fontFamily = Number.isNaN(ffIndex)
      ? value
      : (fontarray[ffIndex] ?? value);
  }

  if ('vt' in cell) {
    const value = normalizedCellAttr(cell, 'vt');
    if (Number(value) === 0) {
      style.alignItems = 'center';
    } else if (Number(value) === 2) {
      style.alignItems = 'flex-end';
    }
  }
  style = _.assign(style, getFontStyleByCell(cell, checksAF, checksCF));
  applyConditionalFormatComputedStyle(style, checksCF);

  return style;
}

function normalizeInlineStringClipboardStyle(style: Record<string, any>) {
  const decorations = new Set<string>();
  const normalizedStyle: Record<string, any> = {
    color: style.color || '#000000',
    fontFamily: style.fontFamily || 'Arial',
    fontSize: style.fontSize || '11pt',
    fontStyle: style.fontStyle || 'normal',
    fontWeight: style.fontWeight || '400',
  };

  const backgroundColor = style.backgroundColor || style.background;
  if (
    backgroundColor &&
    backgroundColor !== 'transparent' &&
    backgroundColor !== 'rgba(0, 0, 0, 0)'
  ) {
    normalizedStyle.backgroundColor = backgroundColor;
  }

  if (typeof style.textDecoration === 'string') {
    style.textDecoration
      .split(/\s+/)
      .filter(Boolean)
      .forEach((decoration: string) => decorations.add(decoration));
  }

  if (style.borderBottom) {
    decorations.add('underline');
    normalizedStyle.textDecorationSkipInk = 'none';
  }

  if (decorations.size > 0) {
    normalizedStyle.textDecoration = Array.from(decorations).join(' ');
  }

  return normalizedStyle;
}

function buildClipboardCompatibleInlineRuns(text: string, styleAttr: string) {
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const segments = normalizedText.split('\n');

  return segments
    .map((segment, index) => {
      let html = '';

      if (segment.length > 0) {
        html += `<span style='${styleAttr}'>${segment}</span>`;
      }

      if (index < segments.length - 1) {
        html += `<span style='${styleAttr}'><br></span>`;
      }

      return html;
    })
    .join('');
}

export function getInlineStringHTML(
  r: number,
  c: number,
  data: CellMatrix,
  options?: {
    useSemanticMarkup?: boolean;
    isRichTextCopy?: boolean;
    inheritedStyle?: Record<string, string>;
  },
) {
  const ct = getCellValue(r, c, data, 'ct');
  if (isInlineStringCT(ct)) {
    const strings = ct.s;
    let value = '';
    for (let i = 0; i < strings.length; i += 1) {
      const strObj = strings[i];
      if (strObj.v) {
        const baseStyle = {
          ...(options?.useSemanticMarkup ? (options.inheritedStyle ?? {}) : {}),
          ...getFontStyleByCell(strObj),
        };
        const style = options?.useSemanticMarkup
          ? normalizeInlineStringClipboardStyle(baseStyle)
          : baseStyle;
        // Explicitly set default text styles so Google Sheets preserves
        // mixed rich-text runs instead of inheriting formatting between spans.
        if (!style.fontWeight) {
          style.fontWeight = '400';
        }
        if (!style.fontStyle) {
          style.fontStyle = 'normal';
        }
        if (!style.fontSize) {
          style.fontSize = '11pt';
        }
        if (!style.fontFamily) {
          style.fontFamily = 'Arial';
        }
        const { link } = strObj as any;
        const segObj = strObj as Record<string, unknown>;
        const linkHasExplicitFc = Object.prototype.hasOwnProperty.call(
          segObj,
          'fc',
        );
        const linkHasExplicitUn = Object.prototype.hasOwnProperty.call(
          segObj,
          'un',
        );
        const unRaw = segObj.un;
        const segmentUnderlineOn =
          linkHasExplicitUn &&
          (unRaw === 1 ||
            unRaw === 3 ||
            Number(unRaw) === 1 ||
            Number(unRaw) === 3);
        // Only apply default hyperlink blue/underline when the segment still stores
        // explicit typography (fc/un). Cleared-format links keep metadata only — no keys —
        // so we must not re-inject chrome on each edit (see convertSpanToShareString + data-link-plain).
        if (link?.linkType && link?.linkAddress) {
          if (linkHasExplicitFc && !style.color) {
            style.color = 'rgb(0, 0, 255)';
          }
          if (segmentUnderlineOn) {
            if (options?.useSemanticMarkup) {
              if (!String(style.textDecoration || '').includes('underline')) {
                style.textDecoration = style.textDecoration
                  ? `${style.textDecoration} underline`
                  : 'underline';
                style.textDecorationSkipInk = 'none';
              }
            } else if (!style.borderBottom) {
              style.borderBottom = '1px solid rgb(0, 0, 255)';
            }
          }
        }
        const styleStr = _.toPairs(style)
          .filter(([, v]) => !_.isNil(v) && v !== '' && v !== 'undefined')
          .map(([key, v]) => {
            return `${_.kebabCase(key)}:${_.isNumber(v) ? `${v}px` : v};`;
          })
          .join(' ');
        const isPlainLinkDecor =
          Boolean(link?.linkType && link?.linkAddress) &&
          !linkHasExplicitFc &&
          !linkHasExplicitUn;
        const dataAttrs =
          !options?.useSemanticMarkup && link?.linkType && link?.linkAddress
            ? ` data-link-type='${String(link.linkType).replace(
              /'/g,
              '&#39;',
            )}' data-link-address='${String(link.linkAddress).replace(
              /'/g,
              '&#39;',
            )}'${isPlainLinkDecor ? " data-link-plain='1'" : ''}`
            : '';
        if (options?.isRichTextCopy) {
          if (options?.useSemanticMarkup) {
            value += buildClipboardCompatibleInlineRuns(strObj.v, styleStr);
          } else {
            // Convert newlines to <br> so apps that don't honour white-space:pre-wrap
            // (e.g. Google Sheets clipboard parser) still see proper line breaks.
            const segmentText = strObj.v
              .replace(/\r\n/g, '<br>')
              .replace(/\n/g, '<br>');
            value += `<span class="luckysheet-input-span" index='${i}' style='${styleStr}'${dataAttrs}>${segmentText}</span>`;
          }
        } else {
          value += `<span class="luckysheet-input-span" index='${i}' style='${styleStr}'${dataAttrs}>${strObj.v}</span>`;
        }
      }
    }
    return value;
  }
  return '';
}

export function getQKBorder(width: string, type: string, color: string) {
  let bordertype = '';

  if (width.toString().indexOf('pt') > -1) {
    const nWidth = parseFloat(width);

    if (nWidth < 1) {
    } else if (nWidth < 1.5) {
      bordertype = 'Medium';
    } else {
      bordertype = 'Thick';
    }
  } else {
    const nWidth = parseFloat(width);

    if (nWidth < 2) {
    } else if (nWidth < 3) {
      bordertype = 'Medium';
    } else {
      bordertype = 'Thick';
    }
  }

  let style = 0;
  type = type.toLowerCase();

  if (type === 'double') {
    style = 2;
  } else if (type === 'dotted') {
    if (bordertype === 'Medium' || bordertype === 'Thick') {
      style = 3;
    } else {
      style = 10;
    }
  } else if (type === 'dashed') {
    if (bordertype === 'Medium' || bordertype === 'Thick') {
      style = 4;
    } else {
      style = 9;
    }
  } else if (type === 'solid') {
    if (bordertype === 'Medium') {
      style = 8;
    } else if (bordertype === 'Thick') {
      style = 13;
    } else {
      style = 1;
    }
  }

  return [style, color];
}

/**
 * 计算范围行高
 *
 * @param d 原始数据
 * @param r1 起始行
 * @param r2 截至行
 * @param cfg 配置
 * @returns 计算后的配置
 */
/*
export function rowlenByRange(
  ctx: Context,
  d: CellMatrix,
  r1: number,
  r2: number,
  cfg: any
) {
  const cfg_clone = _.cloneDeep(cfg);
  if (cfg_clone.rowlen == null) {
    cfg_clone.rowlen = {};
  }

  if (cfg_clone.customHeight == null) {
    cfg_clone.customHeight = {};
  }

  const canvas = $("#luckysheetTableContent").get(0).getContext("2d");
  canvas.textBaseline = "top"; // textBaseline以top计算

  for (let r = r1; r <= r2; r += 1) {
    if (cfg_clone.rowhidden != null && cfg_clone.rowhidden[r] != null) {
      continue;
    }

    let currentRowLen = ctx.defaultrowlen;

    if (cfg_clone.customHeight[r] === 1) {
      continue;
    }

    delete cfg_clone.rowlen[r];

    for (let c = 0; c < d[r].length; c += 1) {
      const cell = d[r][c];

      if (cell == null) {
        continue;
      }

      if (cell != null && (cell.v != null || isInlineStringCell(cell))) {
        let cellWidth;
        if (cell.mc) {
          if (c === cell.mc.c) {
            const st_cellWidth = colLocationByIndex(
              c,
              ctx.visibledatacolumn
            )[0];
            const ed_cellWidth = colLocationByIndex(
              cell.mc.c + cell.mc.cs - 1,
              ctx.visibledatacolumn
            )[1];
            cellWidth = ed_cellWidth - st_cellWidth - 2;
          } else {
            continue;
          }
        } else {
          cellWidth =
            colLocationByIndex(c, ctx.visibledatacolumn)[1] -
            colLocationByIndex(c, ctx.visibledatacolumn)[0] -
            2;
        }

       const textInfo = getCellTextInfo(cell, canvas, {
          r,
          c,
          cellWidth,
        });

        let computeRowlen = 0;

        if (textInfo != null) {
          computeRowlen = textInfo.textHeightAll + 2;
        }

        // 比较计算高度和当前高度取最大高度
        if (computeRowlen > currentRowLen) {
          currentRowLen = computeRowlen;
        }
      }
    }

    currentRowLen /= ctx.zoomRatio;

    if (currentRowLen !== ctx.defaultrowlen) {
      cfg_clone.rowlen[r] = currentRowLen;
    } else {
      if (cfg.rowlen?.[r]) {
        cfg_clone.rowlen[r] = cfg.rowlen[r];
      }
    }
  }

  return cfg_clone;
}
*/

export function getdatabyselection(
  ctx: Context,
  range: Selection | undefined,
  sheetId: string,
) {
  if (range == null && ctx.luckysheet_select_save) {
    [range] = ctx.luckysheet_select_save;
  }

  if (!range) return [];

  if (range.row == null || range.row.length === 0) {
    return [];
  }

  // 取数据
  let d;
  let cfg;
  if (sheetId != null && sheetId !== ctx.currentSheetId) {
    // Cross-sheet copy/paste: source tab may be demoted — rehydrate dense grid.
    d = ensureSheetFlowdata(ctx, { id: sheetId });
    cfg = ctx.luckysheetfile[getSheetIndex(ctx, sheetId)!].config;
  } else {
    d = getFlowdata(ctx);
    cfg = ctx.config;
  }

  const data = [];
  for (let r = range.row[0]; r <= range.row[1]; r += 1) {
    if (d?.[r] == null) {
      continue;
    }
    if (cfg?.rowhidden != null && cfg.rowhidden[r] != null) {
      continue;
    }

    const row = [];

    for (let c = range.column[0]; c <= range.column[1]; c += 1) {
      if (cfg?.colhidden != null && cfg.colhidden[c] != null) {
        continue;
      }
      row.push(d[r][c]);
    }

    data.push(row);
  }
  return data;
}

export function luckysheetUpdateCell(
  ctx: Context,
  row_index: number,
  col_index: number,
) {
  const flowdata = getFlowdata(ctx);
  const cell = flowdata?.[row_index]?.[col_index] as { f?: string } | null;
  if (cell?.f != null && String(cell.f).trim() !== '') {
    suppressFormulaRangeSelectionForInitialEdit(ctx);
    ensureFormulaRangeToSheet(ctx);
  }
  ctx.luckysheetCellUpdate = [row_index, col_index];
}

export function getDataBySelectionNoCopy(ctx: Context, range: Selection) {
  if (!range || !range.row || range.row.length === 0) return [];
  const data = [];
  const flowData = getFlowdata(ctx);
  if (!flowData) return [];
  for (let r = range.row[0]; r <= range.row[1]; r += 1) {
    const row = [];
    if (ctx.config.rowhidden != null && ctx.config.rowhidden[r] != null) {
      continue;
    }
    for (let c = range.column[0]; c <= range.column[1]; c += 1) {
      let value = null;
      if (ctx.config.colhidden != null && ctx.config.colhidden[c] != null) {
        continue;
      }
      if (flowData[r] != null && flowData[r][c] != null) {
        value = flowData[r][c];
      }

      row.push(value);
    }

    data.push(row);
  }
  return data;
}

function keepOnlyValueParts(cell: Cell | null | undefined): Cell | null {
  if (!cell) return cell ?? null;
  const { v: rawValue, m: displayText, f: formula, ct } = cell;
  const keepInlineStringContent =
    ct?.t === 'inlineStr' &&
    Array.isArray((ct as { s?: unknown[] }).s) &&
    (ct as { s?: unknown[] }).s!.length > 0;

  const sanitizedInlineCt = keepInlineStringContent
    ? {
      ...(ct as { fa?: string; t?: string; tb?: string }),
      s: ((ct as { s?: Array<Record<string, unknown>> }).s || []).map(
        (seg) => {
          const cleaned: Record<string, unknown> = {
            v: String(seg?.v ?? ''),
          };
          // Keep hyperlink metadata as content.
          // For hyperlink runs, preserve link decoration (fc/un) so clear-format
          // does not remove visible link style (blue + underline).
          const link = seg?.link as
            | { linkType?: string; linkAddress?: string }
            | undefined;
          if (link?.linkType && link?.linkAddress) {
            cleaned.link = {
              linkType: link.linkType,
              linkAddress: link.linkAddress,
            };
            // Keep default hyperlink decoration after clear format.
            cleaned.fc = 'rgb(0, 0, 255)';
            cleaned.un = 1;
          }
          return cleaned;
        },
      ),
    }
    : undefined;

  if (
    rawValue !== undefined ||
    displayText !== undefined ||
    formula !== undefined ||
    keepInlineStringContent
  ) {
    // Clear formatting removes font/fill/border/alignment-style keys by rebuilding the cell from
    // value parts only — but keep `ct` so number / currency / percent / date formats stay (matches
    // handleClearFormat’s _.pick(..., "ct") and Google Sheets “clear formatting” for numbers).
    if (sanitizedInlineCt) {
      return {
        v: rawValue,
        m: displayText,
        f: formula,
        ct: sanitizedInlineCt,
      };
    }
    return {
      v: rawValue,
      m: displayText,
      f: formula,
      ...(ct != null && typeof ct === 'object' ? { ct } : {}),
    };
  }
  return null;
}

export function clearSelectedCellFormat(ctx: Context) {
  const activeSheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
  if (activeSheetIndex == null) return;

  const changeMap = new Map<string, any>();
  const activeSheetFile = ctx.luckysheetfile[activeSheetIndex];
  const selectedRanges = ctx.luckysheet_select_save;
  if (!activeSheetFile || !selectedRanges) return;

  const sheetData = activeSheetFile.data;

  selectedRanges.forEach(({ row: rowRange, column: columnRange }) => {
    const [startRow, endRow] = rowRange;
    const [startColumn, endColumn] = columnRange;

    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex++) {
      const rowCells = sheetData?.[rowIndex];
      if (!rowCells) continue;

      for (
        let columnIndex = startColumn;
        columnIndex <= endColumn;
        columnIndex++
      ) {
        if (rowCells[columnIndex] === undefined) continue;
        rowCells[columnIndex] = keepOnlyValueParts(
          rowCells[columnIndex],
        ) as Cell;
        const v = (rowCells[columnIndex] as any) ?? null;
        const key = `${rowIndex}_${columnIndex}`;
        changeMap.set(key, {
          sheetId: ctx.currentSheetId,
          path: ['celldata'],
          key,
          value: { r: rowIndex, c: columnIndex, v },
          type: v == null ? 'delete' : 'update',
        });
      }
    }
  });

  if (ctx?.hooks?.updateCellYdoc) {
    const changes = Array.from(changeMap.values());
    activeSheetFile.config ||= {};
    let nextRanges = activeSheetFile.config.cellFormatRanges;
    selectedRanges.forEach(({ row: rowRange, column: columnRange }) => {
      nextRanges = punchRectHoleInCellFormatRanges(
        nextRanges,
        rowRange[0],
        rowRange[1],
        columnRange[0],
        columnRange[1],
      );
    });
    if (!_.isEqual(activeSheetFile.config.cellFormatRanges, nextRanges)) {
      activeSheetFile.config.cellFormatRanges = nextRanges;
      changes.push({
        sheetId: ctx.currentSheetId,
        path: ['config', 'cellFormatRanges'],
        value: nextRanges,
        type: 'update',
      });
    }
    if (changes.length > 0) {
      ctx.hooks.updateCellYdoc(changes);
    }
  }
}

export function clearRowsCellsFormat(ctx: Context) {
  const activeSheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
  if (activeSheetIndex == null) return;

  const changeMap = new Map<string, any>();
  const activeSheetFile = ctx.luckysheetfile[activeSheetIndex];
  const selectedRanges = ctx.luckysheet_select_save;
  if (!activeSheetFile || !selectedRanges) return;

  const sheetData = activeSheetFile.data;
  const columnCount = sheetData?.[0]?.length ?? 0;

  selectedRanges.forEach(({ row: rowRange }) => {
    const [startRow, endRow] = rowRange;

    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex++) {
      const rowCells = sheetData?.[rowIndex];
      if (!rowCells) continue;

      for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
        if (rowCells[columnIndex] === undefined) continue;
        rowCells[columnIndex] = keepOnlyValueParts(
          rowCells[columnIndex],
        ) as Cell;
        const v = (rowCells[columnIndex] as any) ?? null;
        const key = `${rowIndex}_${columnIndex}`;
        changeMap.set(key, {
          sheetId: ctx.currentSheetId,
          path: ['celldata'],
          key,
          value: { r: rowIndex, c: columnIndex, v },
          type: v == null ? 'delete' : 'update',
        });
      }
    }
  });

  if (ctx?.hooks?.updateCellYdoc && changeMap.size > 0) {
    const changes = Array.from(changeMap.values());
    activeSheetFile.config ||= {};
    let nextRanges = activeSheetFile.config.cellFormatRanges;
    selectedRanges.forEach(({ row: rowRange }) => {
      nextRanges = punchRectHoleInCellFormatRanges(
        nextRanges,
        rowRange[0],
        rowRange[1],
        0,
        columnCount - 1,
      );
    });
    if (!_.isEqual(activeSheetFile.config.cellFormatRanges, nextRanges)) {
      activeSheetFile.config.cellFormatRanges = nextRanges;
      changes.push({
        sheetId: ctx.currentSheetId,
        path: ['config', 'cellFormatRanges'],
        value: nextRanges,
        type: 'update',
      });
    }
    ctx.hooks.updateCellYdoc(changes);
  }
}

export function clearColumnsCellsFormat(ctx: Context) {
  const activeSheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
  if (activeSheetIndex == null) return;

  const changeMap = new Map<string, any>();
  const activeSheetFile = ctx.luckysheetfile[activeSheetIndex];
  const selectedRanges = ctx.luckysheet_select_save;
  if (!activeSheetFile || !selectedRanges) return;

  const sheetData = activeSheetFile.data as Cell[][];
  const rowCount = sheetData.length;

  selectedRanges.forEach(({ column: columnRange }) => {
    const [startColumn, endColumn] = columnRange;

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      const rowCells = sheetData[rowIndex];
      if (!rowCells) continue;

      for (
        let columnIndex = startColumn;
        columnIndex <= endColumn;
        columnIndex++
      ) {
        if (rowCells[columnIndex] === undefined) continue;
        rowCells[columnIndex] = keepOnlyValueParts(
          rowCells[columnIndex],
        ) as Cell;
        const v = (rowCells[columnIndex] as any) ?? null;
        const key = `${rowIndex}_${columnIndex}`;
        changeMap.set(key, {
          sheetId: ctx.currentSheetId,
          path: ['celldata'],
          key,
          value: { r: rowIndex, c: columnIndex, v },
          type: v == null ? 'delete' : 'update',
        });
      }
    }
  });

  if (ctx?.hooks?.updateCellYdoc && changeMap.size > 0) {
    const changes = Array.from(changeMap.values());
    activeSheetFile.config ||= {};
    let nextRanges = activeSheetFile.config.cellFormatRanges;
    selectedRanges.forEach(({ column: columnRange }) => {
      nextRanges = punchRectHoleInCellFormatRanges(
        nextRanges,
        0,
        rowCount - 1,
        columnRange[0],
        columnRange[1],
      );
    });
    if (!_.isEqual(activeSheetFile.config.cellFormatRanges, nextRanges)) {
      activeSheetFile.config.cellFormatRanges = nextRanges;
      changes.push({
        sheetId: ctx.currentSheetId,
        path: ['config', 'cellFormatRanges'],
        value: nextRanges,
        type: 'update',
      });
    }
    ctx.hooks.updateCellYdoc(changes);
  }
}
