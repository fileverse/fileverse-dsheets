import _, { isPlainObject } from 'lodash';
import type {
  Sheet as SheetType,
  Freezen,
  Range,
  Selection,
  CellMatrix,
} from '../types';
import { Context, getFlowdata } from '../context';
import {
  getCellValue,
  getdatabyselection,
  getDataBySelectionNoCopy,
  getStyleByCell,
  getInlineStringHTML,
  mergeBorder,
  mergeMoveMain,
  recalcAutoRowHeightForRow,
  updateCell,
} from './cell';
import { isInlineStringCell } from './inline-string';
import { delFunctionGroup } from './formula';
import clipboard from './clipboard';
import { clearImageClipboard } from './image-clipboard';
import { getBorderInfoCompute } from './border';
import { checkCF, getComputeMap } from './ConditionFormat';
import { clampIndicesToUsedBounds } from './copy-range-bounds';
import {
  escapeHTMLTag,
  getSheetIndex,
  isAllowEdit,
  replaceHtml,
} from '../utils';
import { hasPartMC } from './validation';
import { update } from './format';
import { locale } from '../locale';
// @ts-ignore
// import SSF from "./ssf";
import { CFSplitRange } from './ConditionFormat';
import { clearCellError } from './error-state-helpers';
import { scheduleSheetMetadataSyncHooks } from './sheet-metadata-hooks';
import {
  assignActiveConfigToSheetFile,
  syncFormatOnlyRectIntoRanges,
} from './sheet';

export const selectionCache = {
  isPasteAction: false,
  isPasteValuesOnly: false,
};

interface RangeValueToHtmlOptions {
  includeCellMetadata?: boolean;
  preferRichText?: boolean;
  respectFilterHiddenRows?: boolean;
}

/** Browsers commonly truncate clipboard HTML near ~1–2MB; huge per-cell `data-fortune-cell` JSON causes tail loss on large copies. */
const CLIPBOARD_HTML_SAFE_BYTES = 1_400_000;

export function scrollToHighlightCell(ctx: Context, r: number, c: number) {
  const { scrollLeft, scrollTop } = ctx;
  const winH = ctx.cellmainHeight;
  const winW = ctx.cellmainWidth;

  const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
  const sheet = sheetIndex == null ? null : ctx.luckysheetfile[sheetIndex];

  if (!sheet) return;

  const frozen = sheet?.frozen;

  if (r >= 0) {
    const row_focus = sheet?.frozen?.range?.row_focus || 0;
    const freezeH = frozen && r > row_focus ? ctx.visibledatarow[row_focus] : 0;
    const row = ctx.visibledatarow[r];
    const row_pre = r - 1 === -1 ? 0 : ctx.visibledatarow[r - 1];

    if (row - scrollTop - winH + 20 > 0) {
      ctx.scrollTop = row - winH + 20;
    } else if (row_pre - scrollTop - freezeH < 0) {
      const scrollAmount = Math.max(20, freezeH);
      ctx.scrollTop = row_pre - scrollAmount;
    }
  }

  if (c >= 0) {
    const column_focus = sheet?.frozen?.range?.column_focus || 0;
    const freezeW =
      frozen && c > column_focus ? ctx.visibledatacolumn[column_focus] : 0;
    const col = ctx.visibledatacolumn[c];
    const col_pre = c - 1 === -1 ? 0 : ctx.visibledatacolumn[c - 1];

    if (col - scrollLeft - winW + 20 > 0) {
      ctx.scrollLeft = col - winW + 20;
    } else if (col_pre - scrollLeft - freezeW < 0) {
      const scrollAmount = Math.max(20, freezeW);
      ctx.scrollLeft = col_pre - scrollAmount;
    }
  }
}

// 公式函数 选区实体框
export function seletedHighlistByindex(
  ctx: Context,
  r1: number,
  r2: number,
  c1: number,
  c2: number,
) {
  const row = ctx.visibledatarow[r2];
  const row_pre = r1 - 1 === -1 ? 0 : ctx.visibledatarow[r1 - 1];
  const col = ctx.visibledatacolumn[c2];
  const col_pre = c1 - 1 === -1 ? 0 : ctx.visibledatacolumn[c1 - 1];

  if (
    _.isNumber(row) &&
    _.isNumber(row_pre) &&
    _.isNumber(col) &&
    _.isNumber(col_pre)
  ) {
    return {
      left: col_pre,
      width: col - col_pre - 1,
      top: row_pre,
      height: row - row_pre - 1,
    };
  }
  return null;
}

/**
 * True when the selection rectangle is exactly one merged block (multi grid cells, one
 * logical cell). Literal 1×1 is false here — callers use row/column span for that.
 */
export function selectionIsExactlyOneMergeBlock(
  ctx: Context,
  selection: Selection,
): boolean {
  const rLo = Math.min(selection.row[0], selection.row[1]);
  const rHi = Math.max(selection.row[0], selection.row[1]);
  const cLo = Math.min(selection.column[0], selection.column[1]);
  const cHi = Math.max(selection.column[0], selection.column[1]);
  if (rLo === rHi && cLo === cHi) {
    return false;
  }
  const mergeMap = ctx.config?.merge;
  if (!mergeMap) return false;
  const mc = mergeMap[`${rLo}_${cLo}`];
  if (!mc || mc.rs == null || mc.cs == null) return false;
  return (
    mc.r === rLo &&
    mc.c === cLo &&
    rHi === mc.r + mc.rs - 1 &&
    cHi === mc.c + mc.cs - 1
  );
}

/**
 * Updates `ctx.primaryCellActive` from a selection list (multi-cell → active focus cell;
 * else null). Pass `selection` explicitly when normalizing a **new** array that is not
 * yet assigned to `ctx.luckysheet_select_save`.
 */
export function syncPrimaryCellActiveFromSelection(
  ctx: Context,
  selection?: SheetType['luckysheet_select_save'] | null,
) {
  const sel = selection ?? ctx.luckysheet_select_save;
  if (!sel?.length) {
    ctx.primaryCellActive = null;
    return;
  }
  const last = sel[sel.length - 1];
  const multi =
    last.row[0] !== last.row[1] || last.column[0] !== last.column[1];
  if (!multi) {
    ctx.primaryCellActive = null;
    return;
  }
  if (selectionIsExactlyOneMergeBlock(ctx, last)) {
    ctx.primaryCellActive = null;
    return;
  }
  if (!_.isNil(last.row_focus) && !_.isNil(last.column_focus)) {
    ctx.primaryCellActive = { r: last.row_focus, c: last.column_focus };
  } else {
    const rLo = Math.min(last.row[0], last.row[1]);
    const cLo = Math.min(last.column[0], last.column[1]);
    ctx.primaryCellActive = { r: rLo, c: cLo };
  }
}

/**
 * Multi-cell range only: move `row_focus` / `column_focus` (and primary) in
 * column-major order — forward: down then next column right, wrapping top-left;
 * backward (Shift+Enter): up then previous column left, wrapping bottom-right.
 * Does not enter edit mode. Returns false if not a multi-cell selection.
 */
export function advancePrimaryCellInLastMultiSelection(
  ctx: Context,
  forward = true,
): boolean {
  const sel = ctx.luckysheet_select_save;
  if (!sel?.length) return false;
  const last = sel[sel.length - 1];
  const r0 = last.row[0];
  const r1 = last.row[1];
  const c0 = last.column[0];
  const c1 = last.column[1];
  if (r0 === r1 && c0 === c1) return false;

  const rLo = Math.min(r0, r1);
  const rHi = Math.max(r0, r1);
  const cLo = Math.min(c0, c1);
  const cHi = Math.max(c0, c1);

  const inRange = (r: number, c: number) =>
    r >= rLo && r <= rHi && c >= cLo && c <= cHi;

  let curR: number;
  let curC: number;
  const p = ctx.primaryCellActive;
  if (p != null && inRange(p.r, p.c)) {
    curR = p.r;
    curC = p.c;
  } else if (
    !_.isNil(last.row_focus) &&
    !_.isNil(last.column_focus) &&
    inRange(last.row_focus, last.column_focus)
  ) {
    curR = last.row_focus;
    curC = last.column_focus;
  } else {
    curR = rLo;
    curC = cLo;
  }

  let nr: number;
  let nc: number;
  if (forward) {
    if (curR < rHi) {
      nr = curR + 1;
      nc = curC;
    } else if (curC < cHi) {
      nr = rLo;
      nc = curC + 1;
    } else {
      nr = rLo;
      nc = cLo;
    }
  } else if (curR > rLo) {
    nr = curR - 1;
    nc = curC;
  } else if (curC > cLo) {
    nr = rHi;
    nc = curC - 1;
  } else {
    nr = rHi;
    nc = cHi;
  }

  last.row_focus = nr;
  last.column_focus = nc;
  normalizeSelection(ctx, sel);
  return true;
}

/**
 * Pin the primary-cell highlight to a sheet cell. Prefer calling inside the same
 * `setContext` (draft) as your selection update, after `normalizeSelection`, so a
 * later normalize in the same commit does not overwrite it. The next user-driven
 * selection that runs `normalizeSelection` will re-sync from the new range.
 */
export function setPrimaryCellActive(ctx: Context, r: number, c: number) {
  ctx.primaryCellActive = { r, c };
}

/**
 * After formula segment / delete handling, move selection focus to the edited cell
 * (r,c). If the sheet already has a multi-cell range and (r,c) is inside it, keep
 * that range so Enter-primary navigation + typing do not collapse the yellow box.
 */
export function snapSheetSelectionFocusToCellPreserveMultiRange(
  ctx: Context,
  r: number,
  c: number,
) {
  const sel = ctx.luckysheet_select_save;
  const last = sel?.[sel.length - 1];
  if (
    !last?.row ||
    last.row.length < 2 ||
    !last.column ||
    last.column.length < 2
  ) {
    ctx.luckysheet_select_save = [
      {
        row: [r, r],
        column: [c, c],
        row_focus: r,
        column_focus: c,
      },
    ];
    normalizeSelection(ctx, ctx.luckysheet_select_save);
    return;
  }
  const rLo = Math.min(last.row[0], last.row[1]);
  const rHi = Math.max(last.row[0], last.row[1]);
  const cLo = Math.min(last.column[0], last.column[1]);
  const cHi = Math.max(last.column[0], last.column[1]);
  const multi = rLo !== rHi || cLo !== cHi;
  const inside = r >= rLo && r <= rHi && c >= cLo && c <= cHi;
  if (multi && inside) {
    last.row_focus = r;
    last.column_focus = c;
    normalizeSelection(ctx, sel);
  } else {
    ctx.luckysheet_select_save = [
      {
        row: [r, r],
        column: [c, c],
        row_focus: r,
        column_focus: c,
      },
    ];
    normalizeSelection(ctx, ctx.luckysheet_select_save);
  }
}

/** Default selection (A1, or top-left merge block) when a sheet has no `luckysheet_select_save`. */
export function defaultLuckysheetSelectRanges(
  data: CellMatrix | null | undefined,
): Selection[] {
  if (
    data?.[0]?.[0]?.mc &&
    !_.isNil(data[0][0].mc?.rs) &&
    !_.isNil(data[0][0].mc?.cs)
  ) {
    return [
      {
        row: [0, data[0][0].mc!.rs - 1],
        column: [0, data[0][0].mc!.cs - 1],
      },
    ];
  }
  return [{ row: [0, 0], column: [0, 0] }];
}

export function normalizeSelection(
  ctx: Context,
  selection: SheetType['luckysheet_select_save'],
) {
  if (!selection) {
    ctx.primaryCellActive = null;
    return selection;
  }

  const flowdata = getFlowdata(ctx);
  if (!flowdata) {
    syncPrimaryCellActiveFromSelection(ctx, selection);
    return selection;
  }

  for (let i = 0; i < selection.length; i += 1) {
    const current = selection[i];
    const r1 = current.row[0];
    const r2 = current.row[1];
    const c1 = current.column[0];
    const c2 = current.column[1];

    let rf;
    let cf;
    if (_.isNil(current.row_focus)) {
      rf = r1;
    } else {
      rf = current.row_focus;
    }

    if (_.isNil(current.column_focus)) {
      cf = c1;
    } else {
      cf = current.column_focus;
    }

    if (_.isNil(rf) || _.isNil(cf)) {
      console.error('normalizeSelection: rf and cf is nil');
      ctx.primaryCellActive = null;
      return selection;
    }

    const row = ctx.visibledatarow[r2];
    const row_pre = r1 - 1 === -1 ? 0 : ctx.visibledatarow[r1 - 1];
    const col = ctx.visibledatacolumn[c2];
    const col_pre = c1 - 1 === -1 ? 0 : ctx.visibledatacolumn[c1 - 1];

    let row_f = ctx.visibledatarow[rf];
    let row_pre_f = rf - 1 === -1 ? 0 : ctx.visibledatarow[rf - 1];
    let col_f = ctx.visibledatacolumn[cf];
    let col_pre_f = cf - 1 === -1 ? 0 : ctx.visibledatacolumn[cf - 1];

    const margeset = mergeBorder(ctx, flowdata, rf, cf);
    if (margeset) {
      [row_pre_f, row_f] = margeset.row;
      [col_pre_f, col_f] = margeset.column;
    }

    // Replace the entry instead of mutating fields — selection objects may be
    // Immer-frozen (e.g. restored from sheetScrollRecord / prior produce).
    selection[i] = {
      ...current,
      row: [r1, r2],
      column: [c1, c2],
      row_focus: rf,
      column_focus: cf,
      left: col_pre_f,
      width: col_f - col_pre_f <= 0 ? 0 : col_f - col_pre_f - 1,
      top: row_pre_f,
      height: row_f - row_pre_f <= 0 ? 0 : row_f - row_pre_f - 1,
      left_move: col_pre,
      width_move: col - col_pre <= 0 ? 0 : col - col_pre - 1,
      top_move: row_pre,
      height_move: row - row_pre <= 0 ? 0 : row - row_pre - 1,
    };
  }
  syncPrimaryCellActiveFromSelection(ctx, selection);
  return selection;
}

export function selectTitlesMap(
  rangeMap: Record<string, number>,
  range1: number,
  range2: number,
) {
  const map: Record<string, number> = rangeMap || {};
  for (let i = range1; i <= range2; i += 1) {
    if (i in map) {
      continue;
    }
    map[i] = 0;
  }
  return map;
}

export function selectTitlesRange(map: Record<string, number>) {
  const mapArr = Object.keys(map).map(Number);

  mapArr.sort((a, b) => {
    return a - b;
  });

  let rangeArr: number[][] | undefined;
  let item = [];

  if (mapArr.length > 1) {
    rangeArr = [];
    for (let j = 1; j < mapArr.length; j += 1) {
      if (mapArr[j] - mapArr[j - 1] === 1) {
        item.push(mapArr[j - 1]);

        if (j === mapArr.length - 1) {
          item.push(mapArr[j]);
          rangeArr.push(item);
        }
      } else {
        if (j === 1) {
          if (j === mapArr.length - 1) {
            item.push(mapArr[j - 1]);
            rangeArr.push(item);
            rangeArr.push([mapArr[j]]);
          } else {
            rangeArr.push([mapArr[0]]);
          }
        } else if (j === mapArr.length - 1) {
          item.push(mapArr[j - 1]);
          rangeArr.push(item);
          rangeArr.push([mapArr[j]]);
        } else {
          item.push(mapArr[j - 1]);
          rangeArr.push(item);
          item = [];
        }
      }
    }
  } else {
    rangeArr = [];
    rangeArr.push([mapArr[0]]);
  }

  return rangeArr;
}

/** Compare two sheet CF rectangles (row/col inclusive bounds). */
function cfRangeBlocksEqual(
  a: { row: number[]; column: number[] },
  b: { row: number[]; column: number[] },
) {
  return (
    a.row[0] === b.row[0] &&
    a.row[1] === b.row[1] &&
    a.column[0] === b.column[0] &&
    a.column[1] === b.column[1]
  );
}

/** Used to match a source CF rule to an entry on the target sheet (multi-range), excluding cellrange. */
function condFormatRuleIdentityKey(rule: any) {
  if (rule == null) return '';
  const o = _.cloneDeep(rule);
  delete o.cellrange;
  return JSON.stringify(o);
}

export function pasteHandlerOfPaintModel(
  ctx: Context,
  copyRange: Context['luckysheet_copy_save'],
) {
  // if (!checkProtectionLockedRangeList(ctx.luckysheet_select_save, ctx.currentSheetId)) {
  //   return;
  // }
  const cfg = ctx.config;
  if (cfg.merge == null) {
    cfg.merge = {};
  }

  if (!copyRange) return;
  // 复制范围
  const copyHasMC = copyRange.HasMC;
  // let copyRowlChange = copyRange["RowlChange"];
  const copySheetIndex = copyRange.dataSheetId;

  const c_r1 = copyRange.copyRange[0].row[0];
  const c_r2 = copyRange.copyRange[0].row[1];
  const c_c1 = copyRange.copyRange[0].column[0];
  const c_c2 = copyRange.copyRange[0].column[1];

  const copyData = _.cloneDeep(
    getdatabyselection(
      ctx,
      { row: [c_r1, c_r2], column: [c_c1, c_c2] },
      copySheetIndex,
    ),
  );

  // 应用范围
  if (!ctx.luckysheet_select_save) return;
  // 框选区域
  const last =
    ctx.luckysheet_select_save[ctx.luckysheet_select_save.length - 1];
  // 框选区域输出
  const minh = last.row[0];
  let maxh = last.row[1]; // 应用范围首尾行
  const minc = last.column[0];
  let maxc = last.column[1]; // 应用范围首尾列

  const copyh = copyData.length;
  const copyc = copyData[0].length;

  if (minh === maxh && minc === maxc) {
    // 应用范围是一个单元格，自动增加到复制范围大小 (若自动增加的范围包含部分合并单元格，则提示)
    let has_PartMC = false;
    if (cfg.merge != null) {
      has_PartMC = hasPartMC(
        ctx,
        cfg,
        minh,
        minh + copyh - 1,
        minc,
        minc + copyc - 1,
      );
    }

    if (has_PartMC) {
      // if (isEditMode()) {
      //   alert("不能对合并单元格做部分更改");
      // }
      // else {
      //   tooltip.info('<i class="fa fa-exclamation-triangle"></i>提示', "不能对合并单元格做部分更改");
      // }
      return;
    }

    maxh = minh + copyh - 1;
    maxc = minc + copyc - 1;
  }

  const timesH = Math.ceil((maxh - minh + 1) / copyh); // 复制行 组数
  const timesC = Math.ceil((maxc - minc + 1) / copyc); // 复制列 组数

  // let d = editor.deepCopyFlowData(ctx.flowdata);//取数据
  const flowdata = getFlowdata(ctx); // 取数据
  if (flowdata == null) return;
  const cellChanges: {
    sheetId: string;
    path: string[];
    key?: string;
    value: any;
    type?: 'update' | 'delete';
  }[] = [];
  const dataVerificationYdocChanges: {
    sheetId: string;
    path: string[];
    key: string;
    value: any;
    type: 'update';
  }[] = [];
  const cellMaxLength = flowdata[0].length;
  const rowMaxLength = flowdata.length;

  const borderInfoCompute = getBorderInfoCompute(ctx, copySheetIndex);
  const c_dataVerification =
    _.cloneDeep(
      ctx.luckysheetfile[getSheetIndex(ctx, copySheetIndex)!].dataVerification,
    ) || {};
  let dataVerification = null;

  let mth = 0;
  let mtc = 0;
  let maxcellCahe = 0;
  let maxrowCache = 0;
  for (let th = 1; th <= timesH; th += 1) {
    for (let tc = 1; tc <= timesC; tc += 1) {
      mth = minh + (th - 1) * copyh;
      mtc = minc + (tc - 1) * copyc;

      maxrowCache =
        minh + th * copyh > rowMaxLength ? rowMaxLength : minh + th * copyh;
      if (maxrowCache > maxh + 1) {
        maxrowCache = maxh + 1;
      }

      maxcellCahe =
        minc + tc * copyc > cellMaxLength ? cellMaxLength : minc + tc * copyc;
      if (maxcellCahe > maxc + 1) {
        maxcellCahe = maxc + 1;
      }

      const offsetMC: any = {};
      for (let h = mth; h < maxrowCache; h += 1) {
        if (h == null) return;
        if (flowdata[h] == null) return;
        let x: any[] = [];
        x = flowdata[h];

        for (let c = mtc; c < maxcellCahe; c += 1) {
          if (borderInfoCompute[`${c_r1 + h - mth}_${c_c1 + c - mtc}`]) {
            const bd_obj = {
              rangeType: 'cell',
              value: {
                row_index: h,
                col_index: c,
                l: borderInfoCompute[`${c_r1 + h - mth}_${c_c1 + c - mtc}`].l,
                r: borderInfoCompute[`${c_r1 + h - mth}_${c_c1 + c - mtc}`].r,
                t: borderInfoCompute[`${c_r1 + h - mth}_${c_c1 + c - mtc}`].t,
                b: borderInfoCompute[`${c_r1 + h - mth}_${c_c1 + c - mtc}`].b,
              },
            };

            if (cfg.borderInfo == null) {
              cfg.borderInfo = [];
            }

            cfg.borderInfo.push(bd_obj);
          } else if (borderInfoCompute[`${h}_${c}`]) {
            const bd_obj = {
              rangeType: 'cell',
              value: {
                row_index: h,
                col_index: c,
                l: null,
                r: null,
                t: null,
                b: null,
              },
            };

            if (cfg.borderInfo == null) {
              cfg.borderInfo = [];
            }

            cfg.borderInfo.push(bd_obj);
          }

          // 数据验证 复制
          if (c_dataVerification[`${c_r1 + h - mth}_${c_c1 + c - mtc}`]) {
            if (dataVerification == null) {
              dataVerification = _.cloneDeep(
                ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!]
                  .dataVerification,
              );
            }

            const dvSrc =
              c_dataVerification[`${c_r1 + h - mth}_${c_c1 + c - mtc}`];
            dataVerification[`${h}_${c}`] = dvSrc;
            dataVerificationYdocChanges.push({
              sheetId: ctx.currentSheetId,
              path: ['dataVerification'],
              key: `${h}_${c}`,
              value: JSON.parse(JSON.stringify(dvSrc)),
              type: 'update',
            });
          }

          if (isPlainObject(x[c]) && x[c].mc) {
            if (x[c].mc.rs) {
              delete cfg.merge[`${x[c].mc.r}_${x[c].mc.c}`];
            }
            delete x[c].mc;
          }

          let value: any = null;
          if (copyData[h - mth] != null && copyData[h - mth][c - mtc] != null) {
            value = copyData[h - mth][c - mtc];
          }

          if (isPlainObject(x[c])) {
            if (x[c].ct && x[c].ct.t === 'inlineStr' && value) {
              delete value.ct;
            } else {
              const format = [
                'bg',
                'fc',
                'ct',
                'ht',
                'vt',
                'bl',
                'it',
                'cl',
                'un',
                'fs',
                'ff',
                'tb',
              ];
              format.forEach((item) => {
                Reflect.deleteProperty(x[c], item);
              });
            }
          } else {
            x[c] = { v: x[c] };
          }

          if (value != null) {
            delete value.v;
            delete value.m;
            delete value.f;
            delete value.spl;

            if (value.ct && value.ct.t === 'inlineStr') {
              delete value.ct;
            }

            x[c] = _.assign(x[c], _.cloneDeep(value));
            if (x[c].ct && x[c].ct.t === 'inlineStr') {
              x[c].ct.s.forEach((item: any) => _.assign(item, value));
            }

            if (copyHasMC && x[c].mc) {
              if (x[c].mc.rs != null) {
                x[c].mc.r = h;
                if (x[c].mc.rs + h >= maxrowCache) {
                  x[c].mc.rs = maxrowCache - h;
                }

                x[c].mc.c = c;
                if (x[c].mc.cs + c >= maxcellCahe) {
                  x[c].mc.cs = maxcellCahe - c;
                }

                cfg.merge[`${x[c]!.mc!.r}_${x[c]!.mc!.c}`] = x[c].mc;

                offsetMC[`${value.mc!.r}_${value.mc!.c}`] = [
                  x[c]!.mc!.r,
                  x[c]!.mc!.c,
                ];
              } else {
                x[c] = {
                  mc: {
                    r: offsetMC[`${value.mc!.r}_${value.mc!.c}`][0],
                    c: offsetMC[`${value.mc!.r}_${value.mc!.c}`][1],
                  },
                };
              }
            }

            if (x[c].v != null) {
              if (value.ct != null && value.ct.fa != null) {
                // 修改被格式刷的值
                const mask = update(value.ct.fa, x[c].v);
                x[c].m = mask;
              }
            }
          }

          // Persist every touched cell to Yjs, including "empty" cells.
          cellChanges.push({
            sheetId: ctx.currentSheetId,
            path: ['celldata'],
            value: { r: h, c, v: x[c] ?? null },
            key: `${h}_${c}`,
            type: 'update',
          });
        }
        flowdata[h] = x;
      }
    }
  }

  // Empty painted cells are format-only — not persistable in celldata.
  const migratedRanges = syncFormatOnlyRectIntoRanges(
    ctx,
    cfg,
    flowdata,
    minh,
    maxh,
    minc,
    maxc,
  );

  if (ctx?.hooks?.updateCellYdoc) {
    const ydocBatch = [...cellChanges, ...dataVerificationYdocChanges];
    if (migratedRanges) {
      ydocBatch.push({
        sheetId: ctx.currentSheetId,
        path: ['config', 'cellFormatRanges'],
        value: migratedRanges,
        type: 'update',
      });
    }
    if (ydocBatch.length > 0) {
      ctx.hooks.updateCellYdoc(ydocBatch);
    }
  }

  const currFile = ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!];
  assignActiveConfigToSheetFile(currFile, cfg);
  ctx.config = currFile.config!;
  // Only overwrite dataVerification when we actually merged in pasted validations;
  // otherwise we would replace the sheet's dataVerification with null and remove
  // all existing validations on the sheet (e.g. on other rows).
  if (dataVerification != null) {
    currFile.dataVerification = dataVerification;
  }

  // 复制范围 是否有 条件格式 (conditional formatting)
  const copyIndex = getSheetIndex(ctx, copySheetIndex);
  if (copyIndex != null) {
    const ruleArr = _.cloneDeep(
      ctx.luckysheetfile[copyIndex].luckysheet_conditionformat_save,
    );

    if (!_.isNil(ruleArr) && ruleArr.length > 0) {
      const currentIndex = getSheetIndex(ctx, ctx.currentSheetId) as number;
      const existingCf =
        ctx.luckysheetfile[currentIndex].luckysheet_conditionformat_save;
      const cdformat: any[] = _.cloneDeep(existingCf) ?? [];

      for (let i = 0; i < ruleArr.length; i += 1) {
        const cdformat_cellrange = ruleArr[i].cellrange;
        let emptyRange: any[] = [];

        for (let j = 0; j < cdformat_cellrange.length; j += 1) {
          const range = CFSplitRange(
            cdformat_cellrange[j],
            { row: [c_r1, c_r2], column: [c_c1, c_c2] },
            { row: [minh, maxh], column: [minc, maxc] },
            'operatePart',
          );

          if (range.length > 0) {
            emptyRange = emptyRange.concat(range);
          }
        }

        if (emptyRange.length > 0) {
          const pasteBlock = { row: [minh, maxh], column: [minc, maxc] };
          const idKey = condFormatRuleIdentityKey(ruleArr[i]);
          const existingRuleIdx = cdformat.findIndex(
            (r) => idKey === condFormatRuleIdentityKey(r),
          );

          if (existingRuleIdx >= 0) {
            const merged = _.cloneDeep(cdformat[existingRuleIdx]);
            if (!Array.isArray(merged.cellrange)) {
              merged.cellrange = [];
            }
            if (
              !merged.cellrange.some(
                (cr: { row: number[]; column: number[] }) =>
                  cfRangeBlocksEqual(cr, pasteBlock),
              )
            ) {
              merged.cellrange.push({ ...pasteBlock });
            }
            cdformat[existingRuleIdx] = merged;
          } else {
            const newRule = _.cloneDeep(ruleArr[i]);
            newRule.cellrange = [_.cloneDeep(pasteBlock)];
            cdformat.push(newRule);
          }
        }
      }

      currFile.luckysheet_conditionformat_save = cdformat;
    }
  }

  scheduleSheetMetadataSyncHooks(ctx);
}

// }

// last["row"] = [minh, maxh];
// last["column"] = [minc, maxc];

// if (copyRowlChange) {
//   cfg = rowlenByRange(flowdata, minh, maxh, cfg);

//   let allParam = {
//     "cfg": cfg,
//     "RowlChange": true,
//     "cdformat": cdformat,
//     "dataVerification": dataVerification
//   }
//   jfrefreshgrid(flowdata, ctx.luckysheet_select_save, allParam);
// }
// else {
//   // 选区格式刷存在超出边界的情况
//   if (maxh >= flowdata.length) {
//     maxh = flowdata.length - 1;
//   }
//   cfg = rowlenByRange(flowdata, minh, maxh, cfg); //更新行高
//   let allParam = {
//     "cfg": cfg,
//     "RowlChange": true,
//     "cdformat": cdformat,
//     "dataVerification": dataVerification
//   }
//   jfrefreshgrid(flowdata, ctx.luckysheet_select_save, allParam);

//   selectHightlightShow();
// }
// }
export function selectionCopyShow(range: any, ctx: Context) {
  // $("#fortune-selection-copy").empty();

  if (range == null) {
    range = ctx.luckysheet_selection_range;
  }
  range = JSON.parse(JSON.stringify(range));

  // if (range.length > 0) {
  //     for (let s = 0; s < range.length; s++) {
  //         let r1 = range[s].row[0], r2 = range[s].row[1];
  //         let c1 = range[s].column[0], c2 = range[s].column[1];

  //         let row = ctx.visibledatarow[r2],
  //             row_pre = r1 - 1 == -1 ? 0 : ctx.visibledatarow[r1 - 1];
  //         let col = ctx.visibledatacolumn[c2],
  //             col_pre = c1 - 1 == -1 ? 0 : ctx.visibledatacolumn[c1 - 1];

  //         let copyDomHtml = '<div class="fortune-selection-copy" style="display: block; left: ' + col_pre + 'px; width: ' + (col - col_pre - 1) + 'px; top: ' + row_pre + 'px; height: ' + (row - row_pre - 1) + 'px;">' +
  //             '<div class="fortune-selection-copy-top fortune-copy"></div>' +
  //             '<div class="fortune-selection-copy-right fortune-copy"></div>' +
  //             '<div class="fortune-selection-copy-bottom fortune-copy"></div>' +
  //             '<div class="fortune-selection-copy-left fortune-copy"></div>' +
  //             '<div class="fortune-selection-copy-hc"></div>' +
  //             '</div>';
  //         $("#fortune-selection-copy").append(copyDomHtml);
  //     }
  // }
}

// shift + 方向键 / ctrl + shift + 方向键 功能
export function rowHasMerged(ctx: Context, r: number, c1: number, c2: number) {
  let hasMerged = false;
  const flowData = getFlowdata(ctx);
  if (_.isNil(flowData) || _.isNil(flowData[r])) return false;
  for (let c = c1; c <= c2; c += 1) {
    const cell = flowData[r][c];
    if (!_.isNil(cell) && 'mc' in cell) {
      hasMerged = true;
      break;
    }
  }

  return hasMerged;
}
export function colHasMerged(ctx: Context, c: number, r1: number, r2: number) {
  let hasMerged = false;
  const flowData = getFlowdata(ctx);
  if (_.isNil(flowData)) return false;
  for (let r = r1; r <= r2; r += 1) {
    const cell = flowData[r]?.[c];
    if (
      !_.isNil(ctx.config.merge) &&
      !_.isNil(cell) &&
      'mc' in cell &&
      !_.isNil(cell.mc)
    ) {
      hasMerged = true;
      break;
    }
  }
  return hasMerged;
}

// 得到合并
export function getRowMerge(
  ctx: Context,
  rIndex: number,
  c1: number,
  c2: number,
) {
  const flowData = getFlowdata(ctx);
  if (_.isNil(flowData)) return [null, null];
  // const r1 = 0;
  const r2 = flowData.length - 1;
  let str = null;
  if (rIndex > 0) {
    for (let r = rIndex; r >= 0; r -= 1) {
      for (let c = c1; c <= c2; c += 1) {
        const cell = flowData[r][c];
        if (
          !_.isNil(cell) &&
          !_.isNil(cell.mc) &&
          'mc' in cell &&
          !_.isNil(ctx.config.merge)
        ) {
          const mc = ctx.config.merge[`${cell.mc.r}_${cell.mc.c}`];
          if (_.isNil(str) || mc.r < str) {
            str = mc.r;
          }
        }
      }
      if (!_.isNil(str) && rowHasMerged(ctx, str - 1, c1, c2) && str > 0) {
        r = str;
      } else {
        break;
      }
    }
  } else {
    str = 0;
  }
  let end = null;
  if (rIndex < r2) {
    for (let r = rIndex; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        const cell = flowData[r][c];
        if (
          !_.isNil(cell) &&
          !_.isNil(cell.mc) &&
          'mc' in cell &&
          !_.isNil(ctx.config.merge)
        ) {
          const mc = ctx.config.merge[`${cell.mc.r}_${cell.mc.c}`];
          if (_.isNil(end) || mc.r + mc.rs - 1 > end) {
            end = mc.r + mc.rs - 1;
          }
        }
      }
      if (!_.isNil(end) && rowHasMerged(ctx, end + 1, c1, c2) && end < r2) {
        r = end;
      } else {
        break;
      }
    }
  } else {
    end = r2;
  }
  return [str, end];
}

export function getColMerge(
  ctx: Context,
  cIndex: number,
  r1: number,
  r2: number,
) {
  const flowData = getFlowdata(ctx);
  if (_.isNil(flowData)) {
    return [null, null];
  }
  // const c1 = 0;
  const c2 = flowData[0].length - 1;
  let str = null;
  if (cIndex > 0) {
    for (let c = cIndex; c >= 0; c -= 1) {
      for (let r = r1; r <= r2; r += 1) {
        const cell = flowData[r][c];
        if (
          !_.isNil(ctx.config.merge) &&
          !_.isNil(cell) &&
          'mc' in cell &&
          !_.isNil(cell.mc)
        ) {
          const mc = ctx.config.merge[`${cell.mc.r}_${cell.mc.c}`];
          if (_.isNil(str) || mc.c < str) {
            str = mc.c;
          }
        }
      }
      if (!_.isNil(str) && colHasMerged(ctx, str - 1, r1, r2) && str > 0) {
        c = str;
      } else {
        break;
      }
    }
  } else {
    str = 0;
  }
  let end = null;
  if (cIndex < c2) {
    for (let c = cIndex; c <= c2; c += 1) {
      for (let r = r1; r <= r2; r += 1) {
        const cell = flowData[r][c];
        if (
          !_.isNil(ctx.config.merge) &&
          !_.isNil(cell) &&
          'mc' in cell &&
          !_.isNil(cell.mc)
        ) {
          const mc = ctx.config.merge[`${cell.mc.r}_${cell.mc.c}`];
          if (_.isNil(end) || mc.c + mc.cs - 1 > end) {
            end = mc.c + mc.cs - 1;
          }
        }
      }

      if (!_.isNil(end) && colHasMerged(ctx, end + 1, r1, r2) && end < c2) {
        c = end;
      } else {
        break;
      }
    }
  } else {
    end = c2;
  }
  return [str, end];
}

export function moveHighlightCell(
  ctx: Context,
  postion: 'down' | 'right',
  index: number,
  type: 'rangeOfSelect' | 'rangeOfFormula',
) {
  const flowdata = getFlowdata(ctx);
  if (!flowdata) return;
  const datarowlen = flowdata.length;
  const datacolumnlen = flowdata[0].length;

  let row;
  let row_pre;
  let row_index;
  let row_index_ed;
  let col;
  let col_pre;
  let col_index;
  let col_index_ed;

  if (type === 'rangeOfSelect') {
    const last =
      ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
    if (!last) {
      console.error('moveHighlightCell: no selection found');
      return;
    }

    const extentR0 = last.row[0];
    const extentR1 = last.row[1];
    const extentC0 = last.column[0];
    const extentC1 = last.column[1];
    const extentWasMulti = extentR0 !== extentR1 || extentC0 !== extentC1;

    let curR;
    if (_.isNil(last.row_focus)) {
      [curR] = last.row;
    } else {
      curR = last.row_focus;
    }

    let curC;
    if (_.isNil(last.column_focus)) {
      [curC] = last.column;
    } else {
      curC = last.column_focus;
    }

    // focus单元格 是否是合并单元格
    const margeset = mergeBorder(ctx, flowdata, curR, curC);
    if (margeset) {
      const str_r = margeset.row[2];
      const end_r = margeset.row[3];

      const str_c = margeset.column[2];
      const end_c = margeset.column[3];

      if (index > 0) {
        if (postion === 'down') {
          curR = end_r;
          curC = str_c;
        } else if (postion === 'right') {
          curR = str_r;
          curC = end_c;
        }
      } else {
        curR = str_r;
        curC = str_c;
      }
    }

    if (_.isNil(curR) || _.isNil(curC)) {
      console.error('moveHighlightCell: curR or curC is nil');
      return;
    }

    let moveX = _.isNil(last.moveXY) ? curR : last.moveXY.x;
    let moveY = _.isNil(last.moveXY) ? curC : last.moveXY.y;

    if (postion === 'down') {
      curR += index;
      moveX = curR;
    } else if (postion === 'right') {
      curC += index;
      moveY = curC;
    }

    if (curR >= datarowlen) {
      curR = datarowlen - 1;
      moveX = curR;
    }

    if (curR < 0) {
      curR = 0;
      moveX = curR;
    }

    if (curC >= datacolumnlen) {
      curC = datacolumnlen - 1;
      moveY = curC;
    }

    if (curC < 0) {
      curC = 0;
      moveY = curC;
    }

    // 移动的下一个单元格是否是合并的单元格
    const margeset2 = mergeBorder(ctx, flowdata, curR, curC);
    if (margeset2) {
      [row_pre, row, row_index, row_index_ed] = margeset2.row;
      [col_pre, col, col_index, col_index_ed] = margeset2.column;
    } else {
      row = ctx.visibledatarow[moveX];
      row_pre = moveX - 1 === -1 ? 0 : ctx.visibledatarow[moveX - 1];
      // row_index = moveX;
      // row_index_ed = moveX;

      col = ctx.visibledatacolumn[moveY];
      col_pre = moveY - 1 === -1 ? 0 : ctx.visibledatacolumn[moveY - 1];
      // col_index = moveY;
      // col_index_ed = moveY;

      row_index = curR;
      row_index_ed = curR;
      col_index = curC;
      col_index_ed = curC;
    }

    if (
      _.isNil(row_index) ||
      _.isNil(row_index_ed) ||
      _.isNil(col_index) ||
      _.isNil(col_index_ed)
    ) {
      console.error(
        'moveHighlightCell: row_index or row_index_ed or col_index or col_index_ed is nil',
      );
      return;
    }

    if (extentWasMulti && index === 0) {
      last.row_focus = row_index;
      last.column_focus = col_index;
      last.moveXY = { x: moveX, y: moveY };
    } else {
      last.row = [row_index, row_index_ed];
      last.column = [col_index, col_index_ed];
      last.row_focus = row_index;
      last.column_focus = col_index;
      last.moveXY = { x: moveX, y: moveY };
    }

    normalizeSelection(ctx, ctx.luckysheet_select_save);
    // TODO pivotTable.pivotclick(row_index, col_index);
    // TODO formula.fucntionboxshow(row_index, col_index);
    scrollToHighlightCell(ctx, row_index, col_index);
  } else if (type === 'rangeOfFormula') {
    const last = ctx.formulaCache.func_selectedrange;
    if (!last) return;

    let curR;
    if (_.isNil(last.row_focus)) {
      [curR] = last.row;
    } else {
      curR = last.row_focus;
    }

    let curC;
    if (_.isNil(last.column_focus)) {
      [curC] = last.column;
    } else {
      curC = last.column_focus;
    }

    // focus单元格 是否是合并单元格
    const margeset = mergeBorder(ctx, flowdata, curR, curC);
    if (margeset) {
      const str_r = margeset.row[2];
      const end_r = margeset.row[3];

      const str_c = margeset.column[2];
      const end_c = margeset.column[3];

      if (index > 0) {
        if (postion === 'down') {
          curR = end_r;
          curC = str_c;
        } else if (postion === 'right') {
          curR = str_r;
          curC = end_c;
        }
      } else {
        curR = str_r;
        curC = str_c;
      }
    }

    if (_.isNil(curR) || _.isNil(curC)) {
      console.error('moveHighlightCell: curR or curC is nil');
      return;
    }

    let moveX = _.isNil(last.moveXY) ? curR : last.moveXY.x;
    let moveY = _.isNil(last.moveXY) ? curC : last.moveXY.y;

    if (postion === 'down') {
      curR += index;
      moveX = curR;
    } else if (postion === 'right') {
      curC += index;
      moveY = curC;
    }

    if (curR >= datarowlen) {
      curR = datarowlen - 1;
      moveX = curR;
    }

    if (curR < 0) {
      curR = 0;
      moveX = curR;
    }

    if (curC >= datacolumnlen) {
      curC = datacolumnlen - 1;
      moveY = curC;
    }

    if (curC < 0) {
      curC = 0;
      moveY = curC;
    }

    // 移动的下一个单元格是否是合并的单元格
    const margeset2 = mergeBorder(ctx, flowdata, curR, curC);
    if (margeset2) {
      [row_pre, row, row_index, row_index_ed] = margeset2.row;
      [col_pre, col, col_index, col_index_ed] = margeset2.column;
    } else {
      row = ctx.visibledatarow[moveX];
      row_pre = moveX - 1 === -1 ? 0 : ctx.visibledatarow[moveX - 1];
      row_index = moveX;
      row_index_ed = moveX;

      col = ctx.visibledatacolumn[moveY];
      col_pre = moveY - 1 === -1 ? 0 : ctx.visibledatacolumn[moveY - 1];
      col_index = moveY;
      col_index_ed = moveY;
    }

    if (
      _.isNil(col) ||
      _.isNil(col_pre) ||
      _.isNil(row) ||
      _.isNil(row_pre) ||
      _.isNil(row_index) ||
      _.isNil(row_index_ed) ||
      _.isNil(col_index) ||
      _.isNil(col_index_ed)
    ) {
      console.error(
        'moveHighlightCell: some values of func_selectedrange is nil',
      );
      return;
    }

    ctx.formulaCache.func_selectedrange = {
      left: col_pre,
      width: col - col_pre - 1,
      top: row_pre,
      height: row - row_pre - 1,
      left_move: col_pre,
      width_move: col - col_pre - 1,
      top_move: row_pre,
      height_move: row - row_pre - 1,
      row: [row_index, row_index_ed],
      column: [col_index, col_index_ed],
      row_focus: row_index,
      column_focus: col_index,
      moveXY: { x: moveX, y: moveY },
    };

    scrollToHighlightCell(ctx, row_index, col_index);

    // $("#fortune-formula-functionrange-select")
    //   .css({
    //     left: col_pre,
    //     width: col - col_pre - 1,
    //     top: row_pre,
    //     height: row - row_pre - 1,
    //   })
    //   .show();

    // formula.rangeSetValue({
    //   row: [row_index, row_index_ed],
    //   column: [col_index, col_index_ed],
    // });
  }

  /*
  const scrollLeft = $("#luckysheet-cell-main").scrollLeft();
  const scrollTop = $("#luckysheet-cell-main").scrollTop();
  const winH = $("#luckysheet-cell-main").height();
  const winW = $("#luckysheet-cell-main").width();

  let sleft = 0;
  let stop = 0;
  if (col - scrollLeft - winW + 20 > 0) {
    sleft = col - winW + 20;
    if (isScroll) {
      $("#luckysheet-scrollbar-x").scrollLeft(sleft);
    }
  } else if (col_pre - scrollLeft - 20 < 0) {
    sleft = col_pre - 20;
    if (isScroll) {
      $("#luckysheet-scrollbar-x").scrollLeft(sleft);
    }
  }

  if (row - scrollTop - winH + 20 > 0) {
    stop = row - winH + 20;
    if (isScroll) {
      $("#luckysheet-scrollbar-y").scrollTop(stop);
    }
  } else if (row_pre - scrollTop - 20 < 0) {
    stop = row_pre - 20;
    if (isScroll) {
      $("#luckysheet-scrollbar-y").scrollTop(stop);
    }
  }

  clearTimeout(ctx.countfuncTimeout);
  countfunc();
  */

  // 移动单元格通知后台
  // server.saveParam("mv", ctx.currentSheetId, ctx.luckysheet_select_save);
}

// shift + 方向键  调整选区
export function moveHighlightRange(
  ctx: Context,
  postion: 'down' | 'right',
  index: number,
  type: 'rangeOfSelect' | 'rangeOfFormula',
) {
  let row;
  let row_pre;
  let col;
  let col_pre;
  const flowData = getFlowdata(ctx);
  if (_.isNil(flowData)) return;
  if (_.isNil(ctx.luckysheet_select_save)) return;
  if (type === 'rangeOfSelect') {
    const last =
      ctx.luckysheet_select_save[ctx.luckysheet_select_save.length - 1];
    let curR = last.row[0];
    let endR = last.row[1];
    let curC = last.column[0];
    let endC = last.column[1];
    const rf = last.row_focus;
    const cf = last.column_focus;
    if (_.isNil(rf) || _.isNil(cf)) return;
    const datarowlen = flowData.length;
    const datacolumnlen = flowData[0].length;
    if (postion === 'down') {
      // 选区上下变动
      if (rowHasMerged(ctx, rf, curC, endC)) {
        // focus单元格所在行有合并单元格
        const rfMerge = getRowMerge(ctx, rf, curC, endC);
        const rf_str = rfMerge[0];
        const rf_end = rfMerge[1];
        if (!_.isNil(rf_str) && rf_str > curR && rf_end === endR) {
          if (index > 0 && rowHasMerged(ctx, curR, curC, endC)) {
            const v = getRowMerge(ctx, curR, curC, endC)[1];
            if (!_.isNil(v)) {
              curR = v;
            }
          }
          curR += index;
        } else if (!_.isNil(rf_end) && rf_end < endR && rf_str === curR) {
          if (index < 0 && rowHasMerged(ctx, endR, curC, endC)) {
            const v = getRowMerge(ctx, curR, curC, endC)[0];
            if (!_.isNil(v)) {
              endR = v;
            }
          }
          endR += index;
        } else {
          if (index > 0) {
            endR += index;
          } else {
            curR += index;
          }
        }
      } else {
        if (rf > curR && rf === endR) {
          if (index > 0 && rowHasMerged(ctx, curR, curC, endC)) {
            const v = getRowMerge(ctx, curR, curC, endC)[1];
            if (!_.isNil(v)) {
              curR = v;
            }
          }
          curR += index;
        } else if (rf < endR && rf === curR) {
          if (index < 0 && rowHasMerged(ctx, endR, curC, endC)) {
            const v = getRowMerge(ctx, endR, curC, endC)[0];
            if (!_.isNil(v)) {
              endR = v;
            }
          }
          endR += index;
        } else if (rf === curR && rf === endR) {
          if (index > 0) {
            endR += index;
          } else {
            curR += index;
          }
        }
      }
      if (endR >= datarowlen) {
        endR = datarowlen - 1;
      }
      if (endR < 0) {
        endR = 0;
      }
      if (curR >= datarowlen) {
        curR = datarowlen - 1;
      }
      if (curR < 0) {
        curR = 0;
      }
    } else {
      if (colHasMerged(ctx, cf, curR, endR)) {
        const cfMerge = getColMerge(ctx, cf, curR, endR);
        const cf_str = cfMerge[0];
        const cf_end = cfMerge[1];
        if (!_.isNil(cf_str) && cf_str > curC && cf_end === endC) {
          if (index > 0 && colHasMerged(ctx, curC, curR, endR)) {
            const v = getColMerge(ctx, curC, curR, endR)[1];
            if (!_.isNil(v)) {
              curC = v;
            }
            curC += index;
          }
          curC += index;
        } else if (!_.isNil(cf_end) && cf_end < endC && cf_str === curC) {
          if (index < 0 && colHasMerged(ctx, endC, curR, endR)) {
            const v = getColMerge(ctx, endC, curR, endR)[0];
            if (!_.isNil(v)) {
              endC = v;
            }
          }
          endC += index;
        } else {
          if (index > 0) {
            endC += index;
          } else {
            curC += index;
          }
        }
      } else {
        if (cf > curC && cf === endC) {
          if (index > 0 && colHasMerged(ctx, curC, curR, endR)) {
            const v = getColMerge(ctx, curC, curR, endR)[1];
            if (!_.isNil(v)) {
              curC = v;
            }
            curC += index;
          }
          curC += index;
        } else if (cf < endC && cf === curC) {
          if (index < 0 && colHasMerged(ctx, endC, curR, endR)) {
            const v = getColMerge(ctx, endC, curR, endR)[0];
            if (!_.isNil(v)) {
              endC = v;
            }
          }
          endC += index;
        } else if (cf === curC && cf === endC) {
          if (index > 0) {
            endC += index;
          } else {
            curC += index;
          }
        }
      }
      if (endC >= datacolumnlen) {
        endC = datacolumnlen - 1;
      }
      if (endC < 0) {
        endC = 0;
      }
      if (curC >= datacolumnlen) {
        curC = datacolumnlen - 1;
      }
      if (curC < 0) {
        curC = 0;
      }
    }
    let rowseleted: any = [curR, endR];
    let columnseleted: any = [curC, endC];
    row = ctx.visibledatarow[endR];
    row_pre = curR - 1 === -1 ? 0 : ctx.visibledatarow[curR - 1];
    col = ctx.visibledatacolumn[endC];
    col_pre = curC - 1 === -1 ? 0 : ctx.visibledatacolumn[curC - 1];
    const changeparam = mergeMoveMain(
      ctx,
      columnseleted,
      rowseleted,
      last,
      row_pre,
      row - row_pre - 1,
      col_pre,
      col - col_pre - 1,
    );
    if (!_.isNil(changeparam)) {
      [columnseleted, rowseleted] = changeparam;
    }
    last.row = rowseleted;
    last.column = columnseleted;
    normalizeSelection(ctx, ctx.luckysheet_select_save);

    if (postion === 'down') {
      const rowToScroll =
        last.row_focus === last.row[0] ? last.row[1] : last.row[0];
      scrollToHighlightCell(ctx, rowToScroll, -1);
    } else {
      const columnToScroll =
        last.column_focus === last.column[0] ? last.column[1] : last.column[0];
      scrollToHighlightCell(ctx, -1, columnToScroll);
    }
  } else if (type === 'rangeOfFormula') {
    const last = ctx.formulaCache.func_selectedrange;
    if (_.isNil(last)) return;
    let curR = last.row[0];
    let endR = last.row[1];
    let curC = last.column[0];
    let endC = last.column[1];
    const rf = last.row_focus;
    const cf = last.column_focus;

    const datarowlen = flowData.length;
    const datacolumnlen = flowData[0].length;

    if (postion === 'down') {
      if (!_.isNil(rf) && rowHasMerged(ctx, rf, curC, endC)) {
        const rfMerge = getRowMerge(ctx, rf, curC, endC);
        const rf_str = rfMerge[0];
        const rf_end = rfMerge[1];
        if (!_.isNil(rf_str) && rf_str > curR && rf_end === endR) {
          if (index > 0 && rowHasMerged(ctx, curR, curC, endC)) {
            const v = getRowMerge(ctx, curR, curC, endC)[1];
            if (!_.isNil(v)) {
              curR = v;
            }
          }
          curR += index;
        } else if (!_.isNil(rf_end) && rf_end < endR && rf_str === curR) {
          if (index < 0 && rowHasMerged(ctx, endR, curC, endC)) {
            const v = getRowMerge(ctx, endR, curC, endC)[0];
            if (!_.isNil(v)) {
              endR = v;
            }
            endR += index;
          }
        } else {
          if (index > 0) {
            endR += index;
          } else {
            curR += index;
          }
        }
      } else {
        if (!_.isNil(rf) && rf > curR && rf === endR) {
          if (index > 0 && rowHasMerged(ctx, curR, curC, endC)) {
            const v = getRowMerge(ctx, curR, curC, endC)[1];
            if (!_.isNil(v)) {
              curR = v;
            }
          }
          curR += index;
        } else if (!_.isNil(rf) && rf < endR && rf === curR) {
          if (index < 0 && rowHasMerged(ctx, endR, curC, endC)) {
            const v = getRowMerge(ctx, endR, curC, endC)[0];
            if (!_.isNil(v)) {
              endR = v;
            }
          }
          endR += index;
        } else if (rf === curR && rf === endR) {
          if (index > 0) {
            endR += index;
          } else {
            curR += index;
          }
        }
      }
      if (endR >= datarowlen) {
        endR = datarowlen - 1;
      }
      if (endR < 0) {
        endR = 0;
      }
      if (curR >= datarowlen) {
        curR = datarowlen - 1;
      }
      if (curR < 0) {
        curR = 0;
      }
    } else {
      if (!_.isNil(cf) && colHasMerged(ctx, cf, curR, endR)) {
        const cfMerge = getColMerge(ctx, cf, curR, endR);
        const cf_str = cfMerge[0];
        const cf_end = cfMerge[1];
        if (!_.isNil(cf_str) && cf_str > curC && cf_end === endC) {
          if (index > 0 && colHasMerged(ctx, curC, curR, endR)) {
            const v = getColMerge(ctx, curC, curR, endR)[1];
            if (!_.isNil(v)) {
              curC = v;
            }
          }

          curC += index;
        } else if (!_.isNil(cf_end) && cf_end < endC && cf_str === curC) {
          if (index < 0 && colHasMerged(ctx, endC, curR, endR)) {
            const v = getColMerge(ctx, endC, curR, endR)[0];
            if (!_.isNil(v)) {
              endC = v;
            }
          }

          endC += index;
        } else {
          if (index > 0) {
            endC += index;
          } else {
            curC += index;
          }
        }
      } else {
        if (!_.isNil(cf) && cf > curC && cf === endC) {
          if (index > 0 && colHasMerged(ctx, curC, curR, endR)) {
            const v = getColMerge(ctx, curC, curR, endR)[1];
            if (!_.isNil(v)) {
              curC = v;
            }
          }

          curC += index;
        } else if (!_.isNil(cf) && cf < endC && cf === curC) {
          if (index < 0 && colHasMerged(ctx, endC, curR, endR)) {
            const v = getColMerge(ctx, endC, curR, endR)[0];
            if (!_.isNil(v)) {
              endC = v;
            }
          }

          endC += index;
        } else if (cf === curC && cf === endC) {
          if (index > 0) {
            endC += index;
          } else {
            curC += index;
          }
        }
      }
      if (endC >= datacolumnlen) {
        endC = datacolumnlen - 1;
      }
      if (endC < 0) {
        endC = 0;
      }
      if (curC >= datacolumnlen) {
        curC = datacolumnlen - 1;
      }
      if (curC < 0) {
        curC = 0;
      }
    }
    let rowseleted = [curR, endR];
    let columnseleted = [curC, endC];

    row = ctx.visibledatarow[endR];
    row_pre = curR - 1 === -1 ? 0 : ctx.visibledatarow[curR - 1];
    col = ctx.visibledatacolumn[endC];
    col_pre = curC - 1 === -1 ? 0 : ctx.visibledatacolumn[curC - 1];

    let top = row_pre;
    let height = row - row_pre - 1;
    let left = col_pre;
    let width = col - col_pre - 1;

    const changeparam = mergeMoveMain(
      ctx,
      columnseleted,
      rowseleted,
      last,
      top,
      height,
      left,
      width,
    );
    if (!_.isNil(changeparam)) {
      // @ts-ignore
      [columnseleted, rowseleted, top, height, left, width] = changeparam;
    }
    ctx.formulaCache.func_selectedrange = {
      left,
      width,
      top,
      height,
      left_move: left,
      width_move: width,
      top_move: top,
      height_move: height,
      row: rowseleted,
      column: columnseleted,
      row_focus: rf,
      column_focus: cf,
    };

    if (!_.isNil(rf) && !_.isNil(cf)) {
      scrollToHighlightCell(ctx, rf, cf);
    }
  }
}

function getHtmlBorderStyle(type: string, color: string) {
  let style = '';
  const borderType: any = {
    '0': 'none',
    '1': 'Thin',
    '2': 'Hair',
    '3': 'Dotted',
    '4': 'Dashed',
    '5': 'DashDot',
    '6': 'DashDotDot',
    '7': 'Double',
    '8': 'Medium',
    '9': 'MediumDashed',
    '10': 'MediumDashDot',
    '11': 'MediumDashDotDot',
    '12': 'SlantedDashDot',
    '13': 'Thick',
  };
  type = borderType[type.toString()];

  if (type.indexOf('Medium') > -1) {
    style += '1pt ';
  } else if (type === 'Thick') {
    style += '1.5pt ';
  } else {
    style += '0.5pt ';
  }

  if (type === 'Hair') {
    style += 'double ';
  } else if (type.indexOf('DashDotDot') > -1) {
    style += 'dotted ';
  } else if (type.indexOf('DashDot') > -1) {
    style += 'dashed ';
  } else if (type.indexOf('Dotted') > -1) {
    style += 'dotted ';
  } else if (type.indexOf('Dashed') > -1) {
    style += 'dashed ';
  } else {
    style += 'solid ';
  }

  return `${style + color};`;
}

export function rangeValueToHtml(
  ctx: Context,
  sheetId: string,
  ranges?: Range,
  options?: RangeValueToHtmlOptions,
) {
  const includeCellMetadata = options?.includeCellMetadata ?? false;
  const preferRichText = options?.preferRichText ?? false;
  const respectFilterHiddenRows = options?.respectFilterHiddenRows ?? false;
  const cf_compute = getComputeMap(ctx);
  const filteredHiddenRows = new Set<number>();
  if (
    respectFilterHiddenRows &&
    sheetId === ctx.currentSheetId &&
    !_.isNil(ctx.luckysheet_filter_save) &&
    !_.isEmpty(ctx.filter)
  ) {
    Object.values(ctx.filter || {}).forEach((entry: any) => {
      const rowhidden: Record<string, number> | undefined = entry?.rowhidden;
      if (!rowhidden) return;
      Object.keys(rowhidden).forEach((r) => {
        const n = Number(r);
        if (!Number.isNaN(n)) filteredHiddenRows.add(n);
      });
    });
  }
  const idx = getSheetIndex(ctx, sheetId);
  if (idx == null) return '';
  const sheet = ctx.luckysheetfile[idx];

  let rowIndexArr: number[] = [];
  let colIndexArr: number[] = [];

  for (let s = 0; s < (ranges?.length ?? 0); s += 1) {
    const range = ranges![s];

    const r1 = range.row[0];
    const r2 = range.row[1];
    const c1 = range.column[0];
    const c2 = range.column[1];

    for (let copyR = r1; copyR <= r2; copyR += 1) {
      if (filteredHiddenRows.has(copyR)) continue;
      if (!rowIndexArr.includes(copyR)) {
        rowIndexArr.push(copyR);
      }

      for (let copyC = c1; copyC <= c2; copyC += 1) {
        if (!colIndexArr.includes(copyC)) {
          colIndexArr.push(copyC);
        }
      }
    }
  }

  let borderInfoCompute: Record<string, any> | undefined;
  if (sheet.config?.borderInfo && sheet.config.borderInfo.length > 0) {
    // 边框
    borderInfoCompute = getBorderInfoCompute(ctx, sheetId);
  }

  let cpdata = '';
  const d = sheet.data;
  if (!d) return null;

  // Clamp the serialised range to the bounding box of cells that actually carry
  // content (data, border, or conditional format). Stops a select-all of a mostly-
  // empty sheet from emitting thousands of blank <td>s (the whole-sheet copy blowup).
  // Trimmed cells hold no data and no CSS, so the copy stays lossless.
  ({ rows: rowIndexArr, cols: colIndexArr } = clampIndicesToUsedBounds(
    rowIndexArr,
    colIndexArr,
    (r, c) =>
      d[r]?.[c] != null ||
      (borderInfoCompute != null && borderInfoCompute[`${r}_${c}`] != null) ||
      checkCF(r, c, cf_compute) != null,
  ));

  let colgroup = '';

  // rowIndexArr = rowIndexArr.sort();
  // colIndexArr = colIndexArr.sort();

  for (let i = 0; i < rowIndexArr.length; i += 1) {
    const r = rowIndexArr[i];

    cpdata += '<tr>';

    for (let j = 0; j < colIndexArr.length; j += 1) {
      const c = colIndexArr[j];

      let column =
        '<td ${span} style="${style}" data-fortune-cell="${cellData}">';

      const cell = d[r]?.[c];

      if (cell != null) {
        let style = '';
        let span = '';

        if (r === rowIndexArr[0]) {
          if (
            _.isNil(sheet.config) ||
            _.isNil(sheet.config.columnlen) ||
            _.isNil(sheet.config.columnlen[c.toString()])
          ) {
            colgroup += '<colgroup width="72px"></colgroup>';
          } else {
            colgroup += `<colgroup width="${
              sheet.config.columnlen[c.toString()]
            }px"></colgroup>`;
          }
        }

        if (c === colIndexArr[0]) {
          if (
            _.isNil(sheet.config) ||
            _.isNil(sheet.config.rowlen) ||
            _.isNil(sheet.config.rowlen[r.toString()])
          ) {
            style += 'height:19px;';
          } else {
            style += `height:${sheet.config.rowlen[r.toString()]}px;`;
          }
        }

        const reg = /^(w|W)((0?)|(0\.0+))$/;
        let c_value;
        if (
          !_.isNil(cell.ct) &&
          !_.isNil(cell.ct.fa) &&
          cell.ct.fa.match(reg)
        ) {
          c_value = getCellValue(r, c, d);
        } else {
          c_value = getCellValue(r, c, d, 'm');
        }

        const styleObj = getStyleByCell(ctx, d, r, c, cf_compute);
        style += _.map(styleObj, (v, key) => {
          return `${_.kebabCase(key)}:${_.isNumber(v) ? `${v}px` : v};`;
        }).join('');

        if (cell.mc) {
          if ('rs' in cell.mc) {
            span = `rowspan="${cell.mc.rs}" colspan="${cell.mc.cs}"`;

            // 边框
            if (borderInfoCompute && borderInfoCompute[`${r}_${c}`]) {
              const bl_obj: any = { color: {}, style: {} };
              const br_obj: any = { color: {}, style: {} };
              const bt_obj: any = { color: {}, style: {} };
              const bb_obj: any = { color: {}, style: {} };

              for (let bd_r = r; bd_r < r + cell.mc.rs!; bd_r += 1) {
                for (let bd_c = c; bd_c < c + cell.mc.cs!; bd_c += 1) {
                  if (
                    bd_r === r &&
                    borderInfoCompute[`${bd_r}_${bd_c}`] &&
                    borderInfoCompute[`${bd_r}_${bd_c}`].t
                  ) {
                    const linetype =
                      borderInfoCompute[`${bd_r}_${bd_c}`].t.style;
                    const bcolor = borderInfoCompute[`${bd_r}_${bd_c}`].t.color;

                    if (_.isNil(bt_obj.style[linetype])) {
                      bt_obj.style[linetype] = 1;
                    } else {
                      bt_obj.style[linetype] += 1;
                    }

                    if (_.isNil(bt_obj.color[bcolor])) {
                      bt_obj.color[bcolor] = 1;
                    } else {
                      bt_obj.color[bcolor] += 1;
                    }
                  }

                  if (
                    bd_r === r + cell.mc.rs! - 1 &&
                    borderInfoCompute[`${bd_r}_${bd_c}`] &&
                    borderInfoCompute[`${bd_r}_${bd_c}`].b
                  ) {
                    const linetype =
                      borderInfoCompute[`${bd_r}_${bd_c}`].b.style;
                    const bcolor = borderInfoCompute[`${bd_r}_${bd_c}`].b.color;

                    if (_.isNil(bb_obj.style[linetype])) {
                      bb_obj.style[linetype] = 1;
                    } else {
                      bb_obj.style[linetype] += 1;
                    }

                    if (_.isNil(bb_obj.color[bcolor])) {
                      bb_obj.color[bcolor] = 1;
                    } else {
                      bb_obj.color[bcolor] += 1;
                    }
                  }

                  if (
                    bd_c === c &&
                    borderInfoCompute[`${bd_r}_${bd_c}`] &&
                    borderInfoCompute[`${bd_r}_${bd_c}`].l
                  ) {
                    const linetype = borderInfoCompute[`${r}_${c}`].l.style;
                    const bcolor = borderInfoCompute[`${bd_r}_${bd_c}`].l.color;

                    if (_.isNil(bl_obj.style[linetype])) {
                      bl_obj.style[linetype] = 1;
                    } else {
                      bl_obj.style[linetype] += 1;
                    }

                    if (_.isNil(bl_obj.color[bcolor])) {
                      bl_obj.color[bcolor] = 1;
                    } else {
                      bl_obj.color[bcolor] += 1;
                    }
                  }

                  if (
                    bd_c === c + cell.mc.cs! - 1 &&
                    borderInfoCompute[`${bd_r}_${bd_c}`] &&
                    borderInfoCompute[`${bd_r}_${bd_c}`].r
                  ) {
                    const linetype =
                      borderInfoCompute[`${bd_r}_${bd_c}`].r.style;
                    const bcolor = borderInfoCompute[`${bd_r}_${bd_c}`].r.color;

                    if (_.isNil(br_obj.style[linetype])) {
                      br_obj.style[linetype] = 1;
                    } else {
                      br_obj.style[linetype] += 1;
                    }

                    if (_.isNil(br_obj.color[bcolor])) {
                      br_obj.color[bcolor] = 1;
                    } else {
                      br_obj.color[bcolor] += 1;
                    }
                  }
                }
              }

              const rowlen = cell.mc.rs!;
              const collen = cell.mc.cs!;

              if (JSON.stringify(bl_obj).length > 23) {
                let bl_color = null;
                let bl_style = null;

                Object.keys(bl_obj.color).forEach((x) => {
                  if (bl_obj.color[x] >= rowlen / 2) {
                    bl_color = x;
                  }
                });

                Object.keys(bl_obj.style).forEach((x) => {
                  if (bl_obj.style[x] >= rowlen / 2) {
                    bl_style = x;
                  }
                });

                if (!_.isNil(bl_color) && !_.isNil(bl_style)) {
                  style += `border-left:${getHtmlBorderStyle(
                    bl_style,
                    bl_color,
                  )}`;
                }
              }

              if (JSON.stringify(br_obj).length > 23) {
                let br_color = null;
                let br_style = null;

                Object.keys(br_obj.color).forEach((x) => {
                  if (br_obj.color[x] >= rowlen / 2) {
                    br_color = x;
                  }
                });

                Object.keys(br_obj.style).forEach((x) => {
                  if (br_obj.style[x] >= rowlen / 2) {
                    br_style = x;
                  }
                });

                if (!_.isNil(br_color) && !_.isNil(br_style)) {
                  style += `border-right:${getHtmlBorderStyle(
                    br_style,
                    br_color,
                  )}`;
                }
              }

              if (JSON.stringify(bt_obj).length > 23) {
                let bt_color = null;
                let bt_style = null;

                Object.keys(bt_obj.color).forEach((x) => {
                  if (bt_obj.color[x] >= collen / 2) {
                    bt_color = x;
                  }
                });

                Object.keys(bt_obj.style).forEach((x) => {
                  if (bt_obj.style[x] >= collen / 2) {
                    bt_style = x;
                  }
                });

                if (!_.isNil(bt_color) && !_.isNil(bt_style)) {
                  style += `border-top:${getHtmlBorderStyle(
                    bt_style,
                    bt_color,
                  )}`;
                }
              }

              if (JSON.stringify(bb_obj).length > 23) {
                let bb_color = null;
                let bb_style = null;

                Object.keys(bb_obj.color).forEach((x) => {
                  if (bb_obj.color[x] >= collen / 2) {
                    bb_color = x;
                  }
                });

                Object.keys(bb_obj.style).forEach((x) => {
                  if (bb_obj.style[x] >= collen / 2) {
                    bb_style = x;
                  }
                });

                if (!_.isNil(bb_color) && !_.isNil(bb_style)) {
                  style += `border-bottom:${getHtmlBorderStyle(
                    bb_style,
                    bb_color,
                  )}`;
                }
              }
            }
          } else {
            continue;
          }
        } else {
          // 边框
          if (borderInfoCompute && borderInfoCompute[`${r}_${c}`]) {
            // 左边框
            if (borderInfoCompute[`${r}_${c}`].l) {
              const linetype = borderInfoCompute[`${r}_${c}`].l.style;
              const bcolor = borderInfoCompute[`${r}_${c}`].l.color;
              style += `border-left:${getHtmlBorderStyle(linetype, bcolor)}`;
            }

            // 右边框
            if (borderInfoCompute[`${r}_${c}`].r) {
              const linetype = borderInfoCompute[`${r}_${c}`].r.style;
              const bcolor = borderInfoCompute[`${r}_${c}`].r.color;
              style += `border-right:${getHtmlBorderStyle(linetype, bcolor)}`;
            }

            // 下边框
            if (borderInfoCompute[`${r}_${c}`].b) {
              const linetype = borderInfoCompute[`${r}_${c}`].b.style;
              const bcolor = borderInfoCompute[`${r}_${c}`].b.color;
              style += `border-bottom:${getHtmlBorderStyle(linetype, bcolor)}`;
            }

            // 上边框
            if (borderInfoCompute[`${r}_${c}`].t) {
              const linetype = borderInfoCompute[`${r}_${c}`].t.style;
              const bcolor = borderInfoCompute[`${r}_${c}`].t.color;
              style += `border-top:${getHtmlBorderStyle(linetype, bcolor)}`;
            }
          }
        }

        const cellData = includeCellMetadata
          ? encodeURIComponent(
              JSON.stringify({ ...cell, _srcRow: r, _srcCol: c }),
            )
          : '';
        column = replaceHtml(column, { style, span, cellData });

        if (_.isNil(c_value)) {
          c_value = getCellValue(r, c, d);
        }

        if (_.isNil(c_value)) {
          c_value = '';
        }

        if (preferRichText && isInlineStringCell(cell)) {
          column += getInlineStringHTML(r, c, d, {
            useSemanticMarkup: true,
            inheritedStyle: styleObj,
            isRichTextCopy: true,
          });
        } else {
          column += escapeHTMLTag(c_value);
        }
      } else {
        let style = '';

        // 边框
        if (borderInfoCompute && borderInfoCompute[`${r}_${c}`]) {
          // 左边框
          if (borderInfoCompute[`${r}_${c}`].l) {
            const linetype = borderInfoCompute[`${r}_${c}`].l.style;
            const bcolor = borderInfoCompute[`${r}_${c}`].l.color;
            style += `border-left:${getHtmlBorderStyle(linetype, bcolor)}`;
          }

          // 右边框
          if (borderInfoCompute[`${r}_${c}`].r) {
            const linetype = borderInfoCompute[`${r}_${c}`].r.style;
            const bcolor = borderInfoCompute[`${r}_${c}`].r.color;
            style += `border-right:${getHtmlBorderStyle(linetype, bcolor)}`;
          }

          // 下边框
          if (borderInfoCompute[`${r}_${c}`].b) {
            const linetype = borderInfoCompute[`${r}_${c}`].b.style;
            const bcolor = borderInfoCompute[`${r}_${c}`].b.color;
            style += `border-bottom:${getHtmlBorderStyle(linetype, bcolor)}`;
          }

          // 上边框
          if (borderInfoCompute[`${r}_${c}`].t) {
            const linetype = borderInfoCompute[`${r}_${c}`].t.style;
            const bcolor = borderInfoCompute[`${r}_${c}`].t.color;
            style += `border-top:${getHtmlBorderStyle(linetype, bcolor)}`;
          }
        }

        column += '';

        if (r === rowIndexArr[0]) {
          if (
            _.isNil(sheet.config) ||
            _.isNil(sheet.config.columnlen) ||
            _.isNil(sheet.config.columnlen[c.toString()])
          ) {
            colgroup += '<colgroup width="72px"></colgroup>';
          } else {
            colgroup += `<colgroup width="${
              sheet.config.columnlen[c.toString()]
            }px"></colgroup>`;
          }
        }

        if (c === colIndexArr[0]) {
          if (
            _.isNil(sheet.config) ||
            _.isNil(sheet.config.rowlen) ||
            _.isNil(sheet.config.rowlen[r.toString()])
          ) {
            style += 'height:19px;';
          } else {
            style += `height:${sheet.config.rowlen[r.toString()]}px;`;
          }
        }

        const styleObjEmpty = getStyleByCell(ctx, d, r, c, cf_compute);
        style += _.map(styleObjEmpty, (v, key) => {
          return `${_.kebabCase(key)}:${_.isNumber(v) ? `${v}px` : v};`;
        }).join('');

        column = replaceHtml(column, { style, span: '', cellData: '' });
        column += '';
      }

      column += '</td>';
      cpdata += column;
    }

    cpdata += '</tr>';
  }

  const html = `<table data-type="fortune-copy-action-table">${colgroup}${cpdata}</table>`;

  return html;
}

export function copy(ctx: Context) {
  const flowdata = getFlowdata(ctx);

  ctx.lastInternalCopyHtmlMetadataStripped = false;
  ctx.luckysheet_selection_range = [];
  // Cell copy supersedes any prior floating-image clipboard payload
  clearImageClipboard();
  // copy范围
  const copyRange = [];
  let RowlChange = false;
  let HasMC = false;
  let hasInlineRichText = false;
  let hasFormula = false;
  let hasHyperlink = false;
  let hasMultiline = false;

  for (let s = 0; s < (ctx.luckysheet_select_save?.length ?? 0); s += 1) {
    const range = ctx.luckysheet_select_save![s];

    const r1 = range.row[0];
    const r2 = range.row[1];
    const c1 = range.column[0];
    const c2 = range.column[1];

    for (let copyR = r1; copyR <= r2; copyR += 1) {
      if (
        !_.isNil(ctx.config.rowhidden) &&
        !_.isNil(ctx.config.rowhidden[copyR])
      ) {
        continue;
      }

      if (!_.isNil(ctx.config.rowlen) && copyR in ctx.config.rowlen) {
        RowlChange = true;
      }

      for (let copyC = c1; copyC <= c2; copyC += 1) {
        if (
          !_.isNil(ctx.config.colhidden) &&
          !_.isNil(ctx.config.colhidden[copyC])
        ) {
          continue;
        }

        const cell = flowdata?.[copyR]?.[copyC];
        if (cell) {
          if (isInlineStringCell(cell)) hasInlineRichText = true;
          if (!_.isNil(cell.f)) hasFormula = true;
          if (!_.isNil((cell as any).hl)) hasHyperlink = true;
          const mv = cell.m ?? cell.v;
          if (_.isString(mv) && mv.includes('\n')) hasMultiline = true;
        }

        if (!_.isNil(cell?.mc?.rs)) {
          HasMC = true;
        }
      }
    }

    ctx.luckysheet_selection_range.push({
      row: range.row,
      column: range.column,
    });
    copyRange.push({ row: range.row, column: range.column });
  }

  // selectionCopyShow();

  // luckysheet内copy保存
  ctx.luckysheet_copy_save = {
    dataSheetId: ctx.currentSheetId,
    copyRange,
    RowlChange,
    HasMC,
  };

  const canUseRichMode =
    hasInlineRichText || hasFormula || hasHyperlink || hasMultiline;
  const includeCellMetadata =
    canUseRichMode && (hasInlineRichText || hasFormula || hasHyperlink);

  let cpdata: string | null;
  const sel = ctx.luckysheet_select_save;
  const isSingleCell =
    sel?.length === 1 &&
    sel[0].row[0] === sel[0].row[1] &&
    sel[0].column[0] === sel[0].column[1];

  if (isSingleCell && canUseRichMode) {
    const r = sel![0].row[0];
    const c = sel![0].column[0];
    const { fontarray } = locale(ctx);
    const defaultStyle: Record<string, string> = {
      color: '#000000',
      fontFamily: fontarray[0] ?? 'Arial',
      fontSize: '11pt',
      fontWeight: '400',
      fontStyle: 'normal',
      textAlign: 'left',
      backgroundColor: 'transparent',
    };
    const cell = flowdata?.[r]?.[c];
    const isRichText = cell != null && isInlineStringCell(cell);
    const styleObj = getStyleByCell(ctx, flowdata!, r, c);
    const mergedStyle = { ...defaultStyle, ...styleObj };
    const TEXT_LEVEL_KEYS = new Set([
      'color',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'fontStyle',
      'textDecoration',
      'textDecorationSkipInk',
    ]);
    const styleStr = _.toPairs(mergedStyle)
      .filter(
        ([k, v]) =>
          !_.isNil(v) &&
          v !== '' &&
          v !== 'undefined' &&
          !(isRichText && TEXT_LEVEL_KEYS.has(k)),
      )
      .map(([key, v]) => `${_.kebabCase(key)}:${_.isNumber(v) ? `${v}px` : v};`)
      .join(' ');
    const innerContent = isRichText
      ? getInlineStringHTML(r, c, flowdata!, {
          useSemanticMarkup: true,
          inheritedStyle: mergedStyle,
          isRichTextCopy: true,
        })
      : escapeHTMLTag(
          String(
            getCellValue(r, c, flowdata!, 'm') ??
              getCellValue(r, c, flowdata!) ??
              '',
          ),
        ).replace(/&lt;br\s*\/?&gt;/g, '<br>');

    const cellData = includeCellMetadata
      ? encodeURIComponent(
          JSON.stringify({ ...(cell ?? {}), _srcRow: r, _srcCol: c }),
        )
      : '';
    cpdata = `<table data-type="fortune-copy-action-table"><tr><td style="white-space: pre-line; ${styleStr}" data-fortune-cell="${cellData}">${innerContent}</td></tr></table>`;
  } else {
    cpdata = rangeValueToHtml(
      ctx,
      ctx.currentSheetId,
      ctx.luckysheet_select_save,
      {
        includeCellMetadata,
        preferRichText: canUseRichMode,
        respectFilterHiddenRows: true,
      },
    );
    cpdata =
      cpdata === null
        ? cpdata
        : cpdata.replace('<td style="', '<td style="white-space: pre-line; ');
  }

  let clipboardMetadataStripped = false;
  if (
    cpdata &&
    includeCellMetadata &&
    cpdata.length > CLIPBOARD_HTML_SAFE_BYTES
  ) {
    clipboardMetadataStripped = true;
    cpdata = cpdata.replace(/\sdata-fortune-cell="[^"]*"/g, '');
  }

  if (cpdata) {
    ctx.iscopyself = true;
    ctx.lastInternalCopyHtmlMetadataStripped = clipboardMetadataStripped;
    clipboard.writeHtml(cpdata);
  }
}

export function deleteSelectedCellText(ctx: Context): string {
  // if (
  //   !checkProtectionLockedRangeList(
  //     ctx.luckysheet_select_save,
  //     ctx.currentSheetId
  //   )
  // ) {
  //   return;
  // }

  // $("#luckysheet-rightclick-menu").hide();
  // luckysheetContainerFocus();

  const allowEdit = isAllowEdit(ctx);
  if (allowEdit === false || ctx.isFlvReadOnly) {
    return 'allowEdit';
  }

  const selection = ctx.luckysheet_select_save;
  if (selection && !_.isEmpty(selection)) {
    const d = getFlowdata(ctx);
    if (!d) return 'dataNullError';

    const rowsToRecalcAutoHeight = new Set<number>();
    // Batch Yjs sync for bulk deletes. Dedupe by cell key; skip no-ops.
    const changeMap = new Map<string, any>();

    let has_PartMC = false;

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      if (hasPartMC(ctx, ctx.config, r1, r2, c1, c2)) {
        has_PartMC = true;
        break;
      }
    }
    if (has_PartMC) {
      // const locale_drag = locale().drag;

      // if (isEditMode()) {
      //   alert(locale_drag.noPartMerge);
      // } else {
      //   tooltip.info(locale_drag.noPartMerge, "");
      // }

      return 'partMC';
    }
    const hyperlinkMap =
      ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!].hyperlink;

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
          const index = getSheetIndex(ctx, ctx.currentSheetId) as number;

          const oldCellBefore =
            d[r][c] != null ? (_.cloneDeep(d[r][c]) as any) : null;
          const prevHadWrapOrInline =
            oldCellBefore != null &&
            ((oldCellBefore.tb === '2' &&
              !_.isNil(oldCellBefore.v) &&
              oldCellBefore.v !== '') ||
              isInlineStringCell(oldCellBefore));

          const { dataVerification } = ctx.luckysheetfile[index];
          if (dataVerification && dataVerification?.[`${r}_${c}`]) {
            delete dataVerification?.[`${r}_${c}`];
          }
          // if (pivotTable.isPivotRange(r, c)) {
          //   continue;
          // }

          if (_.isPlainObject(d[r][c])) {
            const cell = d[r][c]!;
            delete cell.m;
            delete cell.v;
            delete cell.fc;
            delete cell.un;

            if (cell.f != null) {
              delete cell.f;
              delFunctionGroup(ctx, r, c, ctx.currentSheetId);

              delete cell.spl;
            }

            if (
              cell.ct != null &&
              (cell.ct.t === 'inlineStr' ||
                cell.ct.fa?.includes('BTC') ||
                cell.ct.fa?.includes('ETH') ||
                cell.ct.fa?.includes('SOL'))
            ) {
              delete cell.ct;
              delete cell?.baseValue;
              delete cell?.baseCurrency;
            }
            clearCellError(ctx, r, c);
          } else {
            d[r][c] = null;
          }
          // 同步清除 hyperlink
          if (hyperlinkMap && hyperlinkMap[`${r}_${c}`]) {
            delete hyperlinkMap[`${r}_${c}`];
          }

          //skip already-blank/no-op cells (don't emit Yjs change).
          const newCellAfter = (d[r][c] as any) ?? null;
          if (!_.isEqual(oldCellBefore, newCellAfter)) {
            const key = `${r}_${c}`;
            changeMap.set(key, {
              sheetId: ctx.currentSheetId,
              path: ['celldata'],
              value: { r, c, v: newCellAfter },
              key,
              type: newCellAfter == null ? 'delete' : 'update',
            });
          }

          if (prevHadWrapOrInline) {
            rowsToRecalcAutoHeight.add(r);
          }
        }
      }
    }

    if (changeMap.size > 0 && ctx?.hooks?.updateCellYdoc) {
      ctx.hooks.updateCellYdoc(Array.from(changeMap.values()));
    }

    const canvasCtx =
      ctx.getRefs?.()?.canvas?.current?.getContext('2d') ?? null;
    if (canvasCtx && rowsToRecalcAutoHeight.size > 0) {
      for (const rowIndex of rowsToRecalcAutoHeight) {
        recalcAutoRowHeightForRow(ctx, rowIndex, d, canvasCtx);
      }
    }

    // jfrefreshgrid(d, ctx.luckysheet_select_save);

    // // 清空编辑框的内容
    // // 备注：在functionInputHanddler方法中会把该标签的内容拷贝到 #luckysheet-functionbox-cell
    // $("#luckysheet-rich-text-editor").html("");
  }
  return 'success';
}

export function deleteSelectedCellFormat(ctx: Context): string {
  const allowEdit = isAllowEdit(ctx);
  if (allowEdit === false) {
    return 'allowEdit';
  }

  const selection = ctx.luckysheet_select_save;
  if (selection && !_.isEmpty(selection)) {
    const d = getFlowdata(ctx);
    if (!d) return 'dataNullError';

    let has_PartMC = false;

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      if (hasPartMC(ctx, ctx.config, r1, r2, c1, c2)) {
        has_PartMC = true;
        break;
      }
    }
    if (has_PartMC) {
      return 'partMC';
    }

    const cellChanges: {
      sheetId: string;
      path: string[];
      key?: string;
      value: any;
      type?: 'update' | 'delete';
    }[] = [];

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
          if (_.isPlainObject(d[r][c])) {
            const cell = d[r][c]!;
            if (cell.ct) {
              delete cell.ct;
              delete cell.ff;
              delete cell.fs;
              delete cell.bl;
              delete cell.fc;
              delete cell.bg;
              delete cell.tb;
            }
            cellChanges.push({
              sheetId: ctx.currentSheetId,
              path: ['celldata'],
              value: { r, c, v: d[r][c] },
              key: `${r}_${c}`,
              type: 'update',
            });
          }
        }
      }
    }

    if (cellChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
      ctx.hooks.updateCellYdoc(cellChanges);
    }
  }
  return 'success';
}

export function fillRightData(ctx: Context): string {
  const allowEdit = isAllowEdit(ctx);
  if (allowEdit === false) {
    return 'allowEdit';
  }

  const selection = ctx.luckysheet_select_save;
  if (selection && !_.isEmpty(selection)) {
    const d = getFlowdata(ctx);
    if (!d) return 'dataNullError';

    let has_PartMC = false;

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      if (hasPartMC(ctx, ctx.config, r1, r2, c1, c2)) {
        has_PartMC = true;
        break;
      }
    }
    if (has_PartMC) {
      return 'partMC';
    }

    const cellChanges: {
      sheetId: string;
      path: string[];
      key?: string;
      value: any;
      type?: 'update' | 'delete';
    }[] = [];

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
      const file = sheetIndex != null ? ctx.luckysheetfile[sheetIndex] : null;
      const dataVerification = file?.dataVerification;

      const hyperlink = file?.hyperlink;
      const cdformat = file?.luckysheet_conditionformat_save;

      const isSingleCell = r1 === r2 && c1 === c2;
      if (isSingleCell) {
        if (c1 - 1 >= 0 && d[r1]) {
          const srcRow = r1;
          const srcCol = c1 - 1;
          const prev = d[r1][c1 - 1];
          d[r1][c1] = prev != null ? { ...prev } : {};
          cellChanges.push({
            sheetId: ctx.currentSheetId,
            path: ['celldata'],
            value: { r: r1, c: c1, v: d[r1][c1] },
            key: `${r1}_${c1}`,
            type: 'update',
          });
          if (file != null) {
            const srcKey = `${srcRow}_${srcCol}`;
            const tgtKey = `${r1}_${c1}`;
            if (dataVerification != null) {
              const dv = dataVerification[srcKey];
              if (dv != null) {
                file.dataVerification = {
                  ...(file.dataVerification || {}),
                  [tgtKey]: _.cloneDeep(dv),
                };
              }
            }
            if (hyperlink != null && hyperlink[srcKey] != null) {
              file.hyperlink = {
                ...(file.hyperlink || {}),
                [tgtKey]: _.cloneDeep(hyperlink[srcKey]),
              };
              const tgtCell = d[r1][c1];
              if (tgtCell != null)
                tgtCell.hl = { r: r1, c: c1, id: ctx.currentSheetId };
            }
            if (cdformat != null && cdformat.length > 0) {
              for (let i = 0; i < cdformat.length; i += 1) {
                const ranges = cdformat[i].cellrange;
                if (!ranges) continue;
                for (let j = 0; j < ranges.length; j += 1) {
                  const cr = ranges[j];
                  if (
                    srcRow >= cr.row[0] &&
                    srcRow <= cr.row[1] &&
                    srcCol >= cr.column[0] &&
                    srcCol <= cr.column[1]
                  ) {
                    ranges.push({ row: [r1, r1], column: [c1, c1] });
                    break;
                  }
                }
              }
            }
          }
        }
      } else {
        for (let r = r1; r <= r2; r += 1) {
          const sourceCell = d[r]?.[c1];
          for (let c = c1 + 1; c <= c2; c += 1) {
            if (d[r]) {
              d[r][c] =
                sourceCell != null ? { ...sourceCell } : (d[r][c] ?? {});
              cellChanges.push({
                sheetId: ctx.currentSheetId,
                path: ['celldata'],
                value: { r, c, v: d[r][c] },
                key: `${r}_${c}`,
                type: 'update',
              });
            }
            if (file != null) {
              const srcKey = `${r}_${c1}`;
              const tgtKey = `${r}_${c}`;
              if (dataVerification != null) {
                const dv = dataVerification[srcKey];
                if (dv != null) {
                  file.dataVerification = {
                    ...(file.dataVerification || {}),
                    [tgtKey]: _.cloneDeep(dv),
                  };
                }
              }
              if (hyperlink != null && hyperlink[srcKey] != null) {
                file.hyperlink = {
                  ...(file.hyperlink || {}),
                  [tgtKey]: _.cloneDeep(hyperlink[srcKey]),
                };
                const tgtCell = d[r]?.[c];
                if (tgtCell != null)
                  tgtCell.hl = { r, c, id: ctx.currentSheetId };
              }
              if (cdformat != null && cdformat.length > 0) {
                for (let i = 0; i < cdformat.length; i += 1) {
                  const ranges = cdformat[i].cellrange;
                  if (!ranges) continue;
                  for (let j = 0; j < ranges.length; j += 1) {
                    const cr = ranges[j];
                    if (
                      r >= cr.row[0] &&
                      r <= cr.row[1] &&
                      c1 >= cr.column[0] &&
                      c1 <= cr.column[1]
                    ) {
                      ranges.push({ row: [r, r], column: [c, c] });
                      break;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    if (cellChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
      ctx.hooks.updateCellYdoc(cellChanges);
    }
  }
  return 'success';
}

export function fillDownData(ctx: Context): string {
  const allowEdit = isAllowEdit(ctx);
  if (allowEdit === false) {
    return 'allowEdit';
  }

  const selection = ctx.luckysheet_select_save;
  if (selection && !_.isEmpty(selection)) {
    const d = getFlowdata(ctx);
    if (!d) return 'dataNullError';

    let has_PartMC = false;

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      if (hasPartMC(ctx, ctx.config, r1, r2, c1, c2)) {
        has_PartMC = true;
        break;
      }
    }
    if (has_PartMC) {
      return 'partMC';
    }

    const cellChanges: {
      sheetId: string;
      path: string[];
      key?: string;
      value: any;
      type?: 'update' | 'delete';
    }[] = [];

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
      const file = sheetIndex != null ? ctx.luckysheetfile[sheetIndex] : null;
      const dataVerification = file?.dataVerification;
      const hyperlink = file?.hyperlink;
      const cdformat = file?.luckysheet_conditionformat_save;

      const isSingleCell = r1 === r2 && c1 === c2;
      if (isSingleCell) {
        if (r1 - 1 >= 0 && d[r1 - 1]) {
          const srcRow = r1 - 1;
          const srcCol = c1;
          const prev = d[r1 - 1][c1];
          if (!d[r1]) d[r1] = [];
          d[r1][c1] = prev != null ? { ...prev } : {};
          cellChanges.push({
            sheetId: ctx.currentSheetId,
            path: ['celldata'],
            value: { r: r1, c: c1, v: d[r1][c1] },
            key: `${r1}_${c1}`,
            type: 'update',
          });
          if (file != null) {
            const srcKey = `${srcRow}_${srcCol}`;
            const tgtKey = `${r1}_${c1}`;
            if (dataVerification != null) {
              const dv = dataVerification[srcKey];
              if (dv != null) {
                file.dataVerification = {
                  ...(file.dataVerification || {}),
                  [tgtKey]: _.cloneDeep(dv),
                };
              }
            }
            if (hyperlink != null && hyperlink[srcKey] != null) {
              file.hyperlink = {
                ...(file.hyperlink || {}),
                [tgtKey]: _.cloneDeep(hyperlink[srcKey]),
              };
              const tgtCell = d[r1][c1];
              if (tgtCell != null)
                tgtCell.hl = { r: r1, c: c1, id: ctx.currentSheetId };
            }
            if (cdformat != null && cdformat.length > 0) {
              for (let i = 0; i < cdformat.length; i += 1) {
                const ranges = cdformat[i].cellrange;
                if (!ranges) continue;
                for (let j = 0; j < ranges.length; j += 1) {
                  const cr = ranges[j];
                  if (
                    srcRow >= cr.row[0] &&
                    srcRow <= cr.row[1] &&
                    srcCol >= cr.column[0] &&
                    srcCol <= cr.column[1]
                  ) {
                    ranges.push({ row: [r1, r1], column: [c1, c1] });
                    break;
                  }
                }
              }
            }
          }
        }
      } else {
        for (let c = c1; c <= c2; c += 1) {
          const sourceCell = d[r1]?.[c];
          for (let r = r1 + 1; r <= r2; r += 1) {
            if (!d[r]) d[r] = [];
            d[r][c] = sourceCell != null ? { ...sourceCell } : (d[r][c] ?? {});
            cellChanges.push({
              sheetId: ctx.currentSheetId,
              path: ['celldata'],
              value: { r, c, v: d[r][c] },
              key: `${r}_${c}`,
              type: 'update',
            });
            if (file != null) {
              const srcKey = `${r1}_${c}`;
              const tgtKey = `${r}_${c}`;
              if (dataVerification != null) {
                const dv = dataVerification[srcKey];
                if (dv != null) {
                  file.dataVerification = {
                    ...(file.dataVerification || {}),
                    [tgtKey]: _.cloneDeep(dv),
                  };
                }
              }
              if (hyperlink != null && hyperlink[srcKey] != null) {
                file.hyperlink = {
                  ...(file.hyperlink || {}),
                  [tgtKey]: _.cloneDeep(hyperlink[srcKey]),
                };
                const tgtCell = d[r]?.[c];
                if (tgtCell != null)
                  tgtCell.hl = { r, c, id: ctx.currentSheetId };
              }
              if (cdformat != null && cdformat.length > 0) {
                for (let i = 0; i < cdformat.length; i += 1) {
                  const ranges = cdformat[i].cellrange;
                  if (!ranges) continue;
                  for (let j = 0; j < ranges.length; j += 1) {
                    const cr = ranges[j];
                    if (
                      r1 >= cr.row[0] &&
                      r1 <= cr.row[1] &&
                      c >= cr.column[0] &&
                      c <= cr.column[1]
                    ) {
                      ranges.push({ row: [r, r], column: [c, c] });
                      break;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    if (cellChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
      ctx.hooks.updateCellYdoc(cellChanges);
    }
  }
  return 'success';
}

export function textFormat(
  ctx: Context,
  type: 'left' | 'center' | 'right',
): string {
  const allowEdit = isAllowEdit(ctx);
  if (allowEdit === false) {
    return 'allowEdit';
  }

  const selection = ctx.luckysheet_select_save;
  if (selection && !_.isEmpty(selection)) {
    const d = getFlowdata(ctx);
    if (!d) return 'dataNullError';

    const cellChanges: {
      sheetId: string;
      path: string[];
      key?: string;
      value: any;
      type?: 'update' | 'delete';
    }[] = [];

    let has_PartMC = false;

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      if (hasPartMC(ctx, ctx.config, r1, r2, c1, c2)) {
        has_PartMC = true;
        break;
      }
    }
    if (has_PartMC) {
      return 'partMC';
    }

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
          if (_.isPlainObject(d[r][c])) {
            const cell = d[r][c]!;
            if (type === 'left') {
              cell.tb = '1';
              cell.ht = 1;
            } else if (type === 'center') {
              cell.tb = '1';
              cell.ht = 0;
            } else if (type === 'right') {
              cell.tb = '1';
              cell.ht = 2;
            }
            cellChanges.push({
              sheetId: ctx.currentSheetId,
              path: ['celldata'],
              value: { r, c, v: d[r][c] },
              key: `${r}_${c}`,
              type: 'update',
            });
          }
        }
      }
    }

    if (cellChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
      ctx.hooks.updateCellYdoc(cellChanges);
    }
  }
  return 'success';
}

export function fillDate(ctx: Context): string {
  const allowEdit = isAllowEdit(ctx);
  if (allowEdit === false) {
    return 'allowEdit';
  }

  const selection = ctx.luckysheet_select_save;
  if (selection && !_.isEmpty(selection)) {
    const d = getFlowdata(ctx);
    if (!d) return 'dataNullError';

    const cellChanges: {
      sheetId: string;
      path: string[];
      key?: string;
      value: any;
      type?: 'update' | 'delete';
    }[] = [];

    let has_PartMC = false;

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      if (hasPartMC(ctx, ctx.config, r1, r2, c1, c2)) {
        has_PartMC = true;
        break;
      }
    }
    if (has_PartMC) {
      return 'partMC';
    }

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
          const today = new Date();
          const formattedDate = `${String(today.getDate()).padStart(
            2,
            '0',
          )}/${String(today.getMonth() + 1).padStart(
            2,
            '0',
          )}/${today.getFullYear()}`;
          d[r][c] = { v: formattedDate };
          cellChanges.push({
            sheetId: ctx.currentSheetId,
            path: ['celldata'],
            value: { r, c, v: d[r][c] },
            key: `${r}_${c}`,
            type: 'update',
          });
        }
      }
    }

    if (cellChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
      ctx.hooks.updateCellYdoc(cellChanges);
    }
  }
  return 'success';
}

export function fillTime(ctx: Context): string {
  const allowEdit = isAllowEdit(ctx);
  if (allowEdit === false) {
    return 'allowEdit';
  }

  const selection = ctx.luckysheet_select_save;
  if (selection && !_.isEmpty(selection)) {
    const d = getFlowdata(ctx);
    if (!d) return 'dataNullError';

    const cellChanges: {
      sheetId: string;
      path: string[];
      key?: string;
      value: any;
      type?: 'update' | 'delete';
    }[] = [];

    let has_PartMC = false;

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      if (hasPartMC(ctx, ctx.config, r1, r2, c1, c2)) {
        has_PartMC = true;
        break;
      }
    }
    if (has_PartMC) {
      return 'partMC';
    }

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
          const now = new Date();
          const formattedTime = `${String(now.getHours()).padStart(
            2,
            '0',
          )}:${String(now.getMinutes()).padStart(2, '0')}:${String(
            now.getSeconds(),
          ).padStart(2, '0')}`;
          d[r][c] = { v: formattedTime };
          cellChanges.push({
            sheetId: ctx.currentSheetId,
            path: ['celldata'],
            value: { r, c, v: d[r][c] },
            key: `${r}_${c}`,
            type: 'update',
          });
        }
      }
    }

    if (cellChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
      ctx.hooks.updateCellYdoc(cellChanges);
    }
  }
  return 'success';
}

export function fillDateTime(ctx: Context): string {
  const allowEdit = isAllowEdit(ctx);
  if (allowEdit === false) {
    return 'allowEdit';
  }

  const selection = ctx.luckysheet_select_save;
  if (selection && !_.isEmpty(selection)) {
    const d = getFlowdata(ctx);
    if (!d) return 'dataNullError';

    const cellChanges: {
      sheetId: string;
      path: string[];
      key?: string;
      value: any;
      type?: 'update' | 'delete';
    }[] = [];

    let has_PartMC = false;

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      if (hasPartMC(ctx, ctx.config, r1, r2, c1, c2)) {
        has_PartMC = true;
        break;
      }
    }
    if (has_PartMC) {
      return 'partMC';
    }

    const now = new Date();
    const formattedDateTime = `${String(now.getDate()).padStart(2, '0')}/${String(
      now.getMonth() + 1,
    ).padStart(2, '0')}/${now.getFullYear()} ${String(now.getHours()).padStart(
      2,
      '0',
    )}:${String(now.getMinutes()).padStart(2, '0')}:${String(
      now.getSeconds(),
    ).padStart(2, '0')}`;

    for (let s = 0; s < selection.length; s += 1) {
      const r1 = selection[s].row[0];
      const r2 = selection[s].row[1];
      const c1 = selection[s].column[0];
      const c2 = selection[s].column[1];

      for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
          d[r][c] = { v: formattedDateTime };
          cellChanges.push({
            sheetId: ctx.currentSheetId,
            path: ['celldata'],
            value: { r, c, v: d[r][c] },
            key: `${r}_${c}`,
            type: 'update',
          });
        }
      }
    }

    if (cellChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
      ctx.hooks.updateCellYdoc(cellChanges);
    }
  }
  return 'success';
}

// 选区是否重叠
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function selectIsOverlap(ctx: Context, range?: any) {
  return false;
  // if (range == null) {
  //   range = ctx.luckysheet_select_save;
  // }
  // range = _.cloneDeep(range);

  // let overlap = false;
  // const map: any = {};

  // for (let s = 0; s < range?.length; s += 1) {
  //   const str_r = range[s].row[0];
  //   const end_r = range[s].row[1];
  //   const str_c = range[s].column[0];
  //   const end_c = range[s].column[1];

  //   for (let r = str_r; r <= end_r; r += 1) {
  //     for (let c = str_c; c <= end_c; c += 1) {
  //       if (`${r}_${c}` in map) {
  //         overlap = true;
  //         break;
  //       } else {
  //         map[`${r}_${c}`] = 0;
  //       }
  //     }
  //   }
  // }

  // return overlap;
}

export function selectAll(ctx: Context) {
  // 全选表格
  // if (!checkProtectionAllSelected(ctx.currentSheetId)) {
  //   return;
  // }

  const flowdata = getFlowdata(ctx);
  if (!flowdata) return;

  // $("#luckysheet-wa-functionbox-confirm").click();
  ctx.luckysheet_select_status = false;

  ctx.luckysheet_select_save = [
    {
      row: [0, flowdata.length - 1],
      column: [0, flowdata[0].length - 1],
      row_focus: 0,
      column_focus: 0,
      row_select: true,
      column_select: true,
    },
  ];

  normalizeSelection(ctx, ctx.luckysheet_select_save);
}

export function fixRowStyleOverflowInFreeze(
  ctx: Context,
  r1: number,
  r2: number,
  freeze: Freezen | undefined,
): {
  top?: number;
  height?: number;
  display?: string;
} {
  if (!freeze) return {};

  const ret: ReturnType<typeof fixRowStyleOverflowInFreeze> = {};
  const { scrollTop } = ctx;
  const freezenhorizontaldata = freeze.horizontal?.freezenhorizontaldata;

  let rangeshow = true;

  if (freezenhorizontaldata != null) {
    const freezenTop = freezenhorizontaldata[0];
    const freezen_rowindex = freezenhorizontaldata[1];
    const offTop = scrollTop - freezenhorizontaldata[2];

    const row = ctx.visibledatarow[r2];
    const row_pre = r1 - 1 === -1 ? 0 : ctx.visibledatarow[r1 - 1];

    const top_move = row_pre;
    const height_move = row - row_pre - 1;

    if (r1 >= freezen_rowindex) {
      // 原选区在冻结区外
      if (top_move + height_move < freezenTop + offTop) {
        rangeshow = false;
      } else if (top_move < freezenTop + offTop) {
        ret.top = freezenTop + offTop;
        ret.height = height_move - (freezenTop + offTop - top_move);
      } else {
      }
    } else if (r2 >= freezen_rowindex) {
      // 原选区有一部分在冻结区内
      if (top_move + height_move < freezenTop + offTop) {
        ret.top = top_move + offTop;
        ret.height = freezenTop - top_move;
      } else {
        ret.top = top_move + offTop;
        ret.height = height_move - offTop;
      }
    } else {
      // 原选区在冻结区内
      ret.top = top_move + offTop;
    }
  }

  if (!rangeshow) {
    ret.display = 'none';
  }
  return ret;
}

export function fixColumnStyleOverflowInFreeze(
  ctx: Context,
  c1: number,
  c2: number,
  freeze: Freezen | undefined,
): {
  left?: number;
  width?: number;
  display?: string;
} {
  if (!freeze) return {};

  const ret: ReturnType<typeof fixColumnStyleOverflowInFreeze> = {};
  const { scrollLeft } = ctx;
  const freezenverticaldata = freeze.vertical?.freezenverticaldata;

  let rangeshow = true;

  if (freezenverticaldata != null) {
    const freezenLeft = freezenverticaldata[0];
    const freezen_colindex = freezenverticaldata[1];
    const offLeft = scrollLeft - freezenverticaldata[2];

    const col = ctx.visibledatacolumn[c2];
    const col_pre = c1 - 1 === -1 ? 0 : ctx.visibledatacolumn[c1 - 1];

    const left_move = col_pre;
    const width_move = col - col_pre - 1;

    if (c1 >= freezen_colindex) {
      // 原选区在冻结区外
      if (left_move + width_move < freezenLeft + offLeft) {
        rangeshow = false;
      } else if (left_move < freezenLeft + offLeft) {
        ret.left = freezenLeft + offLeft;
        ret.width = width_move - (freezenLeft + offLeft - left_move);
      } else {
      }
    } else if (c2 >= freezen_colindex) {
      // 原选区有一部分在冻结区内
      if (left_move + width_move < freezenLeft + offLeft) {
        ret.left = left_move + offLeft;
        ret.width = freezenLeft - left_move;
      } else {
        ret.left = left_move + offLeft;
        ret.width = width_move - offLeft;
      }
    } else {
      // 原选区在冻结区内
      ret.left = left_move + offLeft;
    }
  }
  if (!rangeshow) {
    ret.display = 'none';
  }
  return ret;
}

export function calcSelectionInfo(
  ctx: Context,
  // lang?: string | null
) {
  const selection = ctx.luckysheet_select_save!;
  let numberC = 0;
  let count = 0;
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (let s = 0; s < selection.length; s += 1) {
    const data = getDataBySelectionNoCopy(ctx, selection[s]);
    for (let r = 0; r < data.length; r += 1) {
      for (let c = 0; c < data[0].length; c += 1) {
        // 防止选区长度超出data
        if (r >= data.length || c >= data[0].length) break;
        const ct = data![r][c]?.ct?.t as string;
        let value = data![r][c]?.m as string;
        if (data![r][c]?.ct?.fa?.includes('#,##0')) {
          value = data![r][c]?.v as string;
        }

        if (
          data![r][c]?.ct?.t === 'inlineStr' &&
          (value === null || value === undefined || value === '') &&
          data![r][c]?.ct?.s &&
          !data![r][c]?.ct?.s[0]?.v.includes('\r')
        ) {
          value = data![r][c]?.ct?.s[0]?.v as string;
        }

        // 判断是不是数字
        if (
          ct === 'n' ||
          (ct === 'g' && parseFloat(value).toString() !== 'NaN') ||
          (ct === 'inlineStr' && parseFloat(value).toString() !== 'NaN')
        ) {
          const removeComma = String(value)?.replace(/,/g, '') || '0';
          const valueNumber = parseFloat(removeComma);
          count += 1;
          sum += valueNumber;
          max = Math.max(valueNumber, max);
          min = Math.min(valueNumber, min);
          numberC += 1;
        } else if (value != null) {
          count += 1;
        }
      }
    }
  }
  // const formatString =
  //   lang && !["zh", "zh_tw"].includes(lang) ? "0.00000" : "0.00000";
  const average = String(sum / numberC);
  return { numberC, count, sum, max, min, average };
}

/** Move the active selection focus to an absolute row/column (Home/End navigation). */
export function jumpHighlightCell(ctx: Context, targetRow: number, targetCol: number) {
  const flowdata = getFlowdata(ctx);
  if (!flowdata?.length || !flowdata[0]?.length) return;

  const last =
    ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
  if (!last) return;

  const r = Math.max(0, Math.min(targetRow, flowdata.length - 1));
  const c = Math.max(0, Math.min(targetCol, flowdata[0].length - 1));

  last.row = [r, r];
  last.column = [c, c];
  last.row_focus = r;
  last.column_focus = c;
  last.moveXY = { x: r, y: c };
  normalizeSelection(ctx, ctx.luckysheet_select_save);
  scrollToHighlightCell(ctx, r, c);
}

/**
 * Fill every cell in the current selection with the active/focus cell value
 * (Ctrl/Cmd+Enter — same value across the whole selection).
 */
export function fillSelectionWithActiveValue(
  ctx: Context,
  cellInput: HTMLDivElement,
  canvas?: CanvasRenderingContext2D,
): boolean {
  if (!isAllowEdit(ctx)) return false;
  const selection = ctx.luckysheet_select_save;
  if (!selection?.length) return false;

  if (ctx.luckysheetCellUpdate.length > 0) {
    updateCell(
      ctx,
      ctx.luckysheetCellUpdate[0],
      ctx.luckysheetCellUpdate[1],
      cellInput,
      undefined,
      canvas,
    );
  }

  const d = getFlowdata(ctx);
  if (!d) return false;

  const last = selection[selection.length - 1];
  const srcR = last.row_focus ?? last.row[0];
  const srcC = last.column_focus ?? last.column[0];
  const sourceCell = d[srcR]?.[srcC];

  for (let s = 0; s < selection.length; s += 1) {
    const r1 = selection[s].row[0];
    const r2 = selection[s].row[1];
    const c1 = selection[s].column[0];
    const c2 = selection[s].column[1];
    for (let r = r1; r <= r2; r += 1) {
      if (!d[r]) d[r] = [];
      for (let c = c1; c <= c2; c += 1) {
        if (r === srcR && c === srcC) continue;
        d[r][c] =
          sourceCell != null && _.isPlainObject(sourceCell)
            ? _.cloneDeep(sourceCell)
            : sourceCell != null
              ? sourceCell
              : null;
      }
    }
  }

  return true;
}
