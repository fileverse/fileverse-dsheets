import _ from 'lodash';
import { mergeCells } from './merge';
import { Context, getFlowdata } from '../context';
// import { locale } from "../locale";
import { Cell, CellMatrix, GlobalCache } from '../types';
import { getSheetIndex, isAllowEdit } from '../utils';
import {
  getRangetxt,
  isAllSelectedCellsInStatus,
  normalizedAttr,
  recalcAutoRowHeightForRow,
  setCellValue,
} from './cell';
import { colors } from './color';
import {
  getFocusCharacterOffset,
  getSelectionCharacterOffsets,
} from './cursor';
import {
  buildFiatCurrencyFormat,
  datenum_local,
  getEffectiveGeneralDp,
  is_date,
  MAX_GENERAL_AUTO_DP,
  refreshGeneralNumericDisplay,
  update,
} from './format';
import {
  execfunction,
  execFunctionGroup,
  getFormulaEditorOwner,
  groupValuesRefresh,
  israngeseleciton,
  rangeSetValue,
  setCaretPosition,
  createFormulaRangeSelect,
} from './formula';
import {
  getUniformLinkFromWindowSelectionInEditor,
  inlineStyleAffectAttribute,
  updateInlineStringFormat,
  updateInlineStringFormatOutside,
} from './inline-string';
import { colLocationByIndex, rowLocationByIndex } from './location';
import {
  normalizeSelection,
  selectionCopyShow,
  selectIsOverlap,
} from './selection';
import { sortSelection } from './sort';
import {
  detectDateFormat,
  hasPartMC,
  isdatatypemulti,
  isRealNull,
  isRealNum,
  isNumericCellType,
} from './validation';
import {
  getCellHyperlinks,
  getUniformLinkAtPlainOffset,
  getUniformLinkCoveringPlainRange,
  showLinkCard,
} from './hyperlink';
import { cfSplitRange } from './conditionalFormat';
import {
  removeBorderInfoInSelections,
  syncBorderInfoToYdoc,
} from '../utils/border-config-utils';
import { clearMeasureTextCache, getCellTextInfo } from './text';
import { hasCellMeaningfulContent } from '../utils/cell-persist-utils';
import { CellFormatRange, removeCellFormatRangesInRect, upsertCellFormatRange } from '../utils/range-format';
import { assignActiveConfigToSheetFile } from './sheet';

type ToolbarItemClickHandler = (
  ctx: Context,
  cellInput: HTMLDivElement,
  cache?: GlobalCache,
) => void;

type ToolbarItemSelectedFunc = (cell: Cell | null | undefined) => boolean;

/** Same numeric recognition as default right-align: explicit number type or numeric value/display. */
function isCellEligibleForDecimalAdjust(
  cell: Cell | null | undefined,
): boolean {
  if (!cell) return false;
  if (cell.ct?.fa === '@') return false;
  if (isNumericCellType(cell)) return true;
  if (typeof cell.v === 'number') return true;
  if (isRealNum(cell.v)) return true;
  if (isRealNum(cell.m)) return true;
  return false;
}

function forEachSelectedCell(
  ctx: Context,
  flowdata: CellMatrix,
  fn: (row: number, col: number, cell: Cell | null | undefined) => void,
) {
  ctx.luckysheet_select_save?.forEach((selection) => {
    for (let row = selection.row[0]; row <= selection.row[1]; row += 1) {
      for (
        let col = selection.column[0];
        col <= selection.column[1];
        col += 1
      ) {
        fn(row, col, flowdata[row]?.[col]);
      }
    }
  });
}

function adjustGeneralDecimal(cell: Cell, delta: -1 | 1): boolean {
  if (!_.isPlainObject(cell)) return false;
  const raw = cell.v ?? cell.m;
  if (raw == null || !isRealNum(raw)) return false;
  if (!cell.ct) cell.ct = {};
  cell.ct.fa = 'General';
  cell.ct.t = 'g';
  const currentDp = getEffectiveGeneralDp(cell);
  if (delta < 0) {
    if (currentDp <= 0) return false;
    cell.ct.dp = currentDp - 1;
  } else {
    cell.ct.dp = Math.min(MAX_GENERAL_AUTO_DP, currentDp + 1);
  }
  refreshGeneralNumericDisplay(cell);
  return true;
}

function isGeneralFormatCell(cell: Cell | null | undefined): boolean {
  if (!cell) return false;
  const fa = cell.ct?.fa;
  if (fa === 'General' || fa == null) return true;
  return cell.ct?.t === 'g';
}

function pushToolbarCellDataUpdate(
  ctx: Context,
  r: number,
  c: number,
  d: CellMatrix,
) {
  clearMeasureTextCache();
  const cell = d[r]?.[c];
  ctx.hooks?.updateCellYdoc?.([
    {
      sheetId: ctx.currentSheetId,
      path: ['celldata'],
      value: { r, c, v: cell },
      key: `${r}_${c}`,
      type: 'update',
    },
  ]);
}

function pushRangeFormatConfigUpdate(
  changes: any[],
  ctx: Context,
  sheetIndex: number,
  row_st: number,
  row_ed: number,
  col_st: number,
  col_ed: number,
  attrs: Partial<CellFormatRange>,
) {
  ctx.luckysheetfile[sheetIndex].config ||= {};
  const cfg = ctx.luckysheetfile[sheetIndex].config!;
  const { ranges, changed } = upsertCellFormatRange(
    cfg.cellFormatRanges,
    row_st,
    row_ed,
    col_st,
    col_ed,
    attrs,
  );
  if (!changed) return;
  cfg.cellFormatRanges = ranges;
  // Keep live ctx.config in sync so sheet-leave persist cannot wipe ranges.
  const sheetId = ctx.luckysheetfile[sheetIndex]?.id;
  if (sheetId === ctx.currentSheetId) {
    ctx.config ||= {};
    ctx.config.cellFormatRanges = ranges;
  }
  changes.push({
    sheetId: ctx.currentSheetId,
    path: ['config', 'cellFormatRanges'],
    value: ranges,
    type: 'update',
  });
}

export function updateFormatCell(
  ctx: Context,
  d: CellMatrix,
  attr: keyof Cell,
  foucsStatus: any,
  row_st: number,
  row_ed: number,
  col_st: number,
  col_ed: number,
  canvas?: CanvasRenderingContext2D,
) {
  if (_.isNil(d) || _.isNil(attr)) {
    return;
  }
  if (attr === 'ct') {
    const changes: any = [];
    let hasEmptyCellFormat = false;
    let emptyRangeAttrs: Partial<CellFormatRange> | null = null;

    for (let r = row_st; r <= row_ed; r += 1) {
      if (!_.isNil(ctx.config.rowhidden) && !_.isNil(ctx.config.rowhidden[r])) {
        continue;
      }

      for (let c = col_st; c <= col_ed; c += 1) {
        const cell = d[r][c];

        // Compute target type before resolving value (depends only on foucsStatus).
        let type = 'n';

        if (
          is_date(foucsStatus) ||
          foucsStatus === 14 ||
          foucsStatus === 15 ||
          foucsStatus === 16 ||
          foucsStatus === 17 ||
          foucsStatus === 18 ||
          foucsStatus === 19 ||
          foucsStatus === 20 ||
          foucsStatus === 21 ||
          foucsStatus === 22 ||
          foucsStatus === 45 ||
          foucsStatus === 46 ||
          foucsStatus === 47
        ) {
          type = 'd';
        } else if (foucsStatus === '@' || foucsStatus === 49) {
          type = 's';
        }

        let value;

        if (_.isPlainObject(cell)) {
          const rawV = cell?.v;
          const rawM = cell?.m ?? cell?.ct?.s?.[0]?.v;

          if (foucsStatus === '@' && cell?.ct?.t === 'd') {
            // Plain text: preserve user-visible date/time text.
            value = rawM ?? rawV ?? cell?.ct?.s?.[0]?.v;
          } else if (
            cell?.ct?.t === 'd' &&
            isRealNum(rawV) &&
            type !== 's'
          ) {
            // Date/time cells keep Excel serial in `v` — reuse it when reformatting.
            value = rawV;
          } else if (cell?.ct?.t === 'd') {
            value = rawM ?? rawV ?? cell?.ct?.s?.[0]?.v;
          } else {
            value = rawV ?? cell?.ct?.s?.[0]?.v;
          }
        } else {
          value = cell;
        }

        if (_.isNil(value)) {
          // Store format on empty cells so future data entries inherit it; previously these were skipped entirely
          if (!_.isNil(d[r])) {
            // Guard: only write if the row exists in the data array to avoid out-of-bounds
            if (_.isNil(d[r][c])) {
              // Cell slot is null/undefined — create a minimal cell carrying only the format
              const minimal: any = { ct: { fa: foucsStatus, t: type } };
              if (type === 'n') minimal.ht = 2;
              d[r][c] = minimal;
            } else if (_.isPlainObject(d[r][c])) {
              // Cell exists but has no value — update its format in place
              if (_.isNil(d[r][c]!.ct)) d[r][c]!.ct = {};
              delete d[r][c]!.ct!.dp;
              d[r][c]!.ct!.fa = foucsStatus;
              d[r][c]!.ct!.t = type;
              if (type === 'n') d[r][c]!.ht = 2;
            }
          }
          hasEmptyCellFormat = true;
          emptyRangeAttrs = {
            ct: { fa: foucsStatus, t: type },
            ...(type === 'n' ? { ht: 2 } : {}),
          };
          continue;
        }

        if (foucsStatus !== '@' && isRealNum(value)) {
          value = Number(value!);
        } else if (type === 'd' && typeof value === 'string') {
          // Convert date string to Excel serial number when switching to date format
          const dateInfo = detectDateFormat(value);
          if (!dateInfo) {
            // Invalid date input for date format: keep cell untouched.
            continue;
          }
          const dateObj = new Date(
            dateInfo.year,
            dateInfo.month - 1,
            dateInfo.day,
            dateInfo.hours,
            dateInfo.minutes,
            dateInfo.seconds,
          );
          value = datenum_local(dateObj);
        }

        // Refine type for General format after confirming a value exists (requires isRealNum check)
        if (foucsStatus === 'General' || foucsStatus === 0) {
          // type = "g";
          type = isRealNum(value) ? 'n' : 'g';
        }

        const mask = update(foucsStatus, value);

        if (cell && _.isPlainObject(cell)) {
          cell.m = `${mask}`;
          if (_.isNil(cell.ct)) {
            cell.ct = {};
          }
          delete cell.ct.dp;
          cell.ct.fa = foucsStatus;
          cell.ct.t = type;
          cell.v = typeof value === 'number' ? value : String(value);
          cell.fc = cell.fc || cell.ct?.s?.[0]?.fc;
          cell.bl = cell.bl || cell.ct?.s?.[0]?.bl;
          cell.it = cell.it || cell.ct?.s?.[0]?.it;
          cell.un = cell.un || cell.ct?.s?.[0]?.un;
          cell.fs = cell.fs || cell.ct?.s?.[0]?.fs;
          cell.cl = cell.cl || cell.ct?.s?.[0]?.cl;
        } else {
          d[r][c] = {
            ct: { fa: foucsStatus, t: type },
            v: typeof value === 'number' ? value : (value as string),
            m: mask,
          };
        }
        changes.push({
          sheetId: ctx.currentSheetId,
          path: ['celldata'],
          value: {
            r,
            c,
            v: d[r][c],
          },
          key: `${r}_${c}`,
          type: 'update',
        });
      }
    }

    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    if (hasEmptyCellFormat && emptyRangeAttrs && sheetIndex != null) {
      pushRangeFormatConfigUpdate(
        changes,
        ctx,
        sheetIndex,
        row_st,
        row_ed,
        col_st,
        col_ed,
        emptyRangeAttrs,
      );
    }

    if (ctx?.hooks?.updateCellYdoc && changes.length > 0) {
      ctx.hooks?.updateCellYdoc(changes);
    }
  } else {
    if (attr === 'ht') {
      if (foucsStatus === 'left') {
        foucsStatus = '1';
      } else if (foucsStatus === 'center') {
        foucsStatus = '0';
      } else if (foucsStatus === 'right') {
        foucsStatus = '2';
      }
    } else if (attr === 'vt') {
      if (foucsStatus === 'top') {
        foucsStatus = '1';
      } else if (foucsStatus === 'middle') {
        foucsStatus = '0';
      } else if (foucsStatus === 'bottom') {
        foucsStatus = '2';
      }
    } else if (attr === 'tb') {
      if (foucsStatus === 'overflow') {
        foucsStatus = '1';
      } else if (foucsStatus === 'clip') {
        foucsStatus = '0';
      } else if (foucsStatus === 'wrap') {
        foucsStatus = '2';
      }
    } else if (attr === 'tr') {
      if (foucsStatus === 'none') {
        foucsStatus = '0';
      } else if (foucsStatus === 'angleup') {
        foucsStatus = '1';
      } else if (foucsStatus === 'angledown') {
        foucsStatus = '2';
      } else if (foucsStatus === 'vertical') {
        foucsStatus = '3';
      } else if (foucsStatus === 'rotation-up') {
        foucsStatus = '4';
      } else if (foucsStatus === 'rotation-down') {
        foucsStatus = '5';
      }
    }

    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    if (sheetIndex == null) {
      return;
    }
    const changes: any = [];
    let hasEmptyCellFormat = false;
    for (let r = row_st; r <= row_ed; r += 1) {
      if (!_.isNil(ctx.config.rowhidden) && !_.isNil(ctx.config.rowhidden[r])) {
        continue;
      }

      for (let c = col_st; c <= col_ed; c += 1) {
        const value = d[r][c];

        if (value && _.isPlainObject(value)) {
          // if(attr in inlineStyleAffectAttribute && isInlineStringCell(value)){
          updateInlineStringFormatOutside(value!, attr, foucsStatus);
          // }
          // else{
          // @ts-ignore
          value[attr] = foucsStatus;
          // }
          ctx.luckysheetfile[sheetIndex].config ||= {};
          const cfg = ctx.luckysheetfile[sheetIndex].config!;
          const cellWidth =
            cfg.columnlen?.[c] ||
            ctx.luckysheetfile[sheetIndex].defaultColWidth;
          if (attr === 'fs' && canvas) {
            const textInfo = getCellTextInfo(d[r][c]!, canvas, ctx, {
              r,
              c,
              cellWidth,
            });
            if (!textInfo) continue;
            const rowHeight = _.round(textInfo.textHeightAll);
            const currentRowHeight =
              cfg.rowlen?.[r] ||
              ctx.luckysheetfile[sheetIndex].defaultRowHeight ||
              19;
            if (
              !_.isUndefined(rowHeight) &&
              rowHeight > currentRowHeight &&
              (!cfg.customHeight || cfg.customHeight[r] !== 1)
            ) {
              if (_.isUndefined(cfg.rowlen)) cfg.rowlen = {};
              _.set(cfg, `rowlen.${r}`, rowHeight);
            }
          }

          if (hasCellMeaningfulContent(value)) {
            changes.push({
              sheetId: ctx.currentSheetId,
              path: ['celldata'],
              value: {
                r,
                c,
                v: d[r][c],
              },
              key: `${r}_${c}`,
              type: 'update',
            });
          } else {
            hasEmptyCellFormat = true;
          }
        } else if (value != null && typeof value !== 'object') {
          d[r][c] = { v: value, [attr]: foucsStatus } as Cell;
          changes.push({
            sheetId: ctx.currentSheetId,
            path: ['celldata'],
            value: {
              r,
              c,
              v: d[r][c],
            },
            key: `${r}_${c}`,
            type: 'update',
          });
        } else {
          // @ts-ignore
          d[r][c] = { v: value };
          // @ts-ignore
          d[r][c][attr] = foucsStatus;
          hasEmptyCellFormat = true;
        }
      }
    }

    if (hasEmptyCellFormat) {
      pushRangeFormatConfigUpdate(
        changes,
        ctx,
        sheetIndex,
        row_st,
        row_ed,
        col_st,
        col_ed,
        { [attr]: foucsStatus } as Partial<CellFormatRange>,
      );
    }

    if (attr === 'tb' && canvas) {
      clearMeasureTextCache();
      for (let r = row_st; r <= row_ed; r += 1) {
        if (
          !_.isNil(ctx.config.rowhidden) &&
          !_.isNil(ctx.config.rowhidden[r])
        ) {
          continue;
        }
        // Applying text wrap should always expand the row to show all content,
        // even on imported sheets where luckyexcel sets customHeight=1 for rows
        // that the user never manually resized.
        if (foucsStatus === '2') {
          const sheetCfg = ctx.luckysheetfile?.[sheetIndex]?.config;
          if (sheetCfg?.customHeight?.[r]) delete sheetCfg.customHeight[r];
          if (ctx.config?.customHeight?.[r]) delete ctx.config.customHeight[r];
        }
        recalcAutoRowHeightForRow(ctx, r, d, canvas);
      }
    }

    if (ctx?.hooks?.updateCellYdoc && changes.length > 0) {
      ctx.hooks?.updateCellYdoc(changes);
    }
  }
}

export function updateFormat(
  ctx: Context,
  $input: HTMLDivElement,
  d: CellMatrix,
  attr: keyof Cell,
  foucsStatus: any,
  canvas?: CanvasRenderingContext2D,
) {
  const allowEdit = isAllowEdit(ctx);
  if (!allowEdit) return;

  if (attr in inlineStyleAffectAttribute) {
    if (ctx.luckysheetCellUpdate.length > 0) {
      const value = $input.innerText;
      if (value.substring(0, 1) !== '=') {
        updateInlineStringFormat(ctx, attr, foucsStatus, $input);
        return;
      }
    }
  }

  const cfg = _.cloneDeep(ctx.config);
  if (_.isNil(cfg.rowlen)) {
    cfg.rowlen = {};
  }

  _.forEach(ctx.luckysheet_select_save, (selection) => {
    const [row_st, row_ed] = selection.row;
    const [col_st, col_ed] = selection.column;

    updateFormatCell(
      ctx,
      d,
      attr,
      foucsStatus,
      row_st,
      row_ed,
      col_st,
      col_ed,
      canvas,
    );

    // if (attr === "tb" || attr === "tr" || attr === "fs") {
    //   cfg = rowlenByRange(ctx, d, row_st, row_ed, cfg);
    // }
  });

  // Value-only edits run execFunctionGroup; number-format edits do not, so dependents (e.g. SUM)
  // kept stale `fa`/`m`. If any touched cell has formula dependents (rev graph), refresh them.
  // Skip when dependency graph reports nothing — avoids an O(all-formulas) pass for stray formats.
  if (
    attr === 'ct' &&
    ctx.luckysheet_select_save?.length &&
    ctx.currentSheetId
  ) {
    const sid = ctx.currentSheetId;
    const revMap = ctx.formulaCache.revDepsByCell;
    const touchedByKey = new Map<string, { r: number; c: number }>();
    _.forEach(ctx.luckysheet_select_save, (selection) => {
      const [row_st, row_ed] = selection.row;
      const [col_st, col_ed] = selection.column;
      for (let r = row_st; r <= row_ed; r += 1) {
        if (
          !_.isNil(ctx.config.rowhidden) &&
          !_.isNil(ctx.config.rowhidden[r])
        ) {
          continue;
        }
        for (let c = col_st; c <= col_ed; c += 1) {
          touchedByKey.set(`${r}_${c}`, { r, c });
        }
      }
    });

    let hasDependent = false;
    if (revMap?.size) {
      for (const { r, c } of touchedByKey.values()) {
        if (revMap.get(`${sid}:${r}:${c}`)?.size) {
          hasDependent = true;
          break;
        }
      }
    }

    if (hasDependent && touchedByKey.size > 0) {
      const execExist = Array.from(touchedByKey.values()).map(({ r, c }) => ({
        r,
        c,
        i: sid,
      }));
      ctx.formulaCache.execFunctionExist = execExist;
      ctx.formulaCache.execFunctionExist.reverse();
      // @ts-expect-error origins null forces dependency fan-out via execFunctionExist
      execFunctionGroup(ctx, null, null, null, null, d);
      ctx.formulaCache.execFunctionGlobalData = null;
      groupValuesRefresh(ctx);
    }
  }

  //   let allParam = {};
  //   if (attr === "tb" || attr === "tr" || attr === "fs") {
  //     allParam = {
  //       cfg,
  //       RowlChange: true,
  //     };
  //   }

  //   jfrefreshgrid(d, ctx.luckysheet_select_save, allParam, false);
}

function toggleAttr(ctx: Context, cellInput: HTMLDivElement, attr: keyof Cell) {
  const flowdata = getFlowdata(ctx);
  if (!flowdata) return;

  const flag = isAllSelectedCellsInStatus(ctx, attr, 1);
  const foucsStatus = flag ? 0 : 1;

  updateFormat(ctx, cellInput, flowdata, attr, foucsStatus);
}

function setAttr(
  ctx: Context,
  cellInput: HTMLDivElement,
  attr: keyof Cell,
  value: any,
  canvas?: CanvasRenderingContext2D,
) {
  const flowdata = getFlowdata(ctx);
  if (!flowdata) return;

  updateFormat(ctx, cellInput, flowdata, attr, value, canvas);
}
// @ts-ignore
function checkNoNullValue(cell) {
  let v = cell;
  if (_.isPlainObject(v)) {
    v = v.v;
  }

  if (
    !isRealNull(v) &&
    isdatatypemulti(v).num &&
    (cell.ct == null ||
      cell.ct.t == null ||
      cell.ct.t === 'n' ||
      cell.ct.t === 'g')
  ) {
    return true;
  }

  return false;
}
// @ts-ignore
function checkNoNullValueAll(cell) {
  let v = cell;
  if (_.isPlainObject(v)) {
    v = v.v;
  }

  if (!isRealNull(v)) {
    return true;
  }

  return false;
}
function getNoNullValue(d: CellMatrix, st_x: number, ed: number, type: string) {
  // let hasValueSum = 0;
  let hasValueStart = null;
  let nullNum = 0;
  let nullTime = 0;

  for (let r = ed - 1; r >= 0; r -= 1) {
    let cell;
    if (type === 'c') {
      cell = d[st_x][r];
    } else {
      cell = d[r][st_x];
    }

    if (checkNoNullValue(cell)) {
      // hasValueSum += 1;
      hasValueStart = r;
    } else if (cell == null || cell.v == null || cell.v === '') {
      nullNum += 1;

      if (nullNum >= 40) {
        if (nullTime <= 0) {
          nullTime = 1;
        } else {
          break;
        }
      }
    } else {
      break;
    }
  }

  return hasValueStart;
}

function activeFormulaInput(
  cellInput: HTMLDivElement,
  fxInput: HTMLDivElement | null | undefined,
  ctx: Context,
  row_index: number,
  col_index: number,
  rowh: any,
  columnh: any,
  formula: string,
  cache: GlobalCache,
  isnull?: boolean,
) {
  if (isnull == null) {
    isnull = false;
  }

  ctx.luckysheetCellUpdate = [row_index, col_index];
  cache.doNotUpdateCell = true;
  if (isnull) {
    const formulaTxt = `<span dir="auto" class="luckysheet-formula-text-color">=</span><span dir="auto" class="luckysheet-formula-text-color">${formula.toUpperCase()}</span><span dir="auto" class="luckysheet-formula-text-color">(</span><span dir="auto" class="luckysheet-formula-text-color">)</span>`;

    cellInput.innerHTML = formulaTxt;

    const spanList = cellInput.querySelectorAll('span');
    setCaretPosition(ctx, spanList[spanList.length - 2], 0, 1);

    return;
  }

  const row_pre = rowLocationByIndex(rowh[0], ctx.visibledatarow)[0];
  const row = rowLocationByIndex(rowh[1], ctx.visibledatarow)[1];
  const col_pre = colLocationByIndex(columnh[0], ctx.visibledatacolumn)[0];
  const col = colLocationByIndex(columnh[1], ctx.visibledatacolumn)[1];

  const formulaTxt = `<span dir="auto" class="luckysheet-formula-text-color">=</span><span dir="auto" class="luckysheet-formula-text-color">${formula.toUpperCase()}</span><span dir="auto" class="luckysheet-formula-text-color">(</span><span class="fortune-formula-functionrange-cell" rangeindex="0" dir="auto" style="color:${
    colors[0]
  };">${getRangetxt(
    ctx,
    ctx.currentSheetId,
    { row: rowh, column: columnh },
    ctx.currentSheetId,
  )}</span><span dir="auto" class="luckysheet-formula-text-color">)</span>`;
  cellInput.innerHTML = formulaTxt;

  israngeseleciton(ctx);
  ctx.formulaCache.rangestart = true;
  ctx.formulaCache.rangedrag_column_start = false;
  ctx.formulaCache.rangedrag_row_start = false;
  ctx.formulaCache.rangechangeindex = 0;

  rangeSetValue(ctx, cellInput, { row: rowh, column: columnh }, fxInput);
  ctx.formulaCache.func_selectedrange = {
    left: col_pre,
    width: col - col_pre - 1,
    top: row_pre,
    height: row - row_pre - 1,
    left_move: col_pre,
    width_move: col - col_pre - 1,
    top_move: row_pre,
    height_move: row - row_pre - 1,
    row: [row_index, row_index],
    column: [col_index, col_index],
  };

  createFormulaRangeSelect(ctx, {
    rangeIndex: ctx.formulaCache.rangeIndex || 0,
    left: col_pre,
    width: col - col_pre - 1,
    top: row_pre,
    height: row - row_pre - 1,
  });
  // $("#fortune-formula-functionrange-select")
  //   .css({
  //     left: col_pre,
  //     width: col - col_pre - 1,
  //     top: row_pre,
  //     height: row - row_pre - 1,
  //   })
  //   .show(); TODO！！！

  // $("#luckysheet-formula-help-c").hide();
}

function backFormulaInput(
  d: CellMatrix,
  r: number,
  c: number,
  rowh: any,
  columnh: any,
  formula: string,
  ctx: Context,
) {
  const f = `=${formula.toUpperCase()}(${getRangetxt(
    ctx,
    ctx.currentSheetId,
    { row: rowh, column: columnh },
    ctx.currentSheetId,
  )})`;
  const v = execfunction(ctx, f, r, c);
  const value = { v: v[1], f: v[2] };
  setCellValue(ctx, r, c, d, value);
  if (ctx?.hooks?.updateCellYdoc) {
    ctx.hooks.updateCellYdoc([
      {
        sheetId: ctx.currentSheetId,
        path: ['celldata'],
        value: { r, c, v: d?.[r]?.[c] ?? null },
        key: `${r}_${c}`,
        type: 'update',
      },
    ]);
  }
  ctx.formulaCache.execFunctionExist ||= [];
  ctx.formulaCache.execFunctionExist.push({
    r,
    c,
    i: ctx.currentSheetId,
  });

  // server.historyParam(d, ctx.currentSheetId, {
  //   row: [r, r],
  //   column: [c, c],
  // }); 目前没有server
}

function singleFormulaInput(
  cellInput: HTMLDivElement,
  fxInput: HTMLDivElement | null | undefined,
  ctx: Context,
  d: CellMatrix,
  _index: number,
  fix: number,
  st_m: number,
  ed_m: number,
  formula: string,
  type: string,
  cache: GlobalCache,
  noNum?: boolean,
  noNull?: boolean,
) {
  if (type == null) {
    type = 'r';
  }

  if (noNum == null) {
    noNum = true;
  }

  if (noNull == null) {
    noNull = true;
  }

  let isNull = true;
  let isNum = false;

  for (let c = st_m; c <= ed_m; c += 1) {
    let cell = null;

    if (type === 'c') {
      cell = d[c][fix];
    } else {
      cell = d[fix][c];
    }

    if (checkNoNullValue(cell)) {
      isNull = false;
      isNum = true;
    } else if (checkNoNullValueAll(cell)) {
      isNull = false;
    }
  }

  if (isNull && noNull) {
    let st_r_r = getNoNullValue(d, _index, fix, type);

    if (st_r_r == null) {
      if (type === 'c') {
        activeFormulaInput(
          cellInput,
          fxInput,
          ctx,
          _index,
          fix,
          null,
          null,
          formula,
          cache,
          true,
        );
      } else {
        activeFormulaInput(
          cellInput,
          fxInput,
          ctx,
          fix,
          _index,
          null,
          null,
          formula,
          cache,
          true,
        );
      }
    } else {
      if (_index === st_m) {
        for (let c = st_m; c <= ed_m; c += 1) {
          st_r_r = getNoNullValue(d, c, fix, type);

          if (st_r_r == null) {
            break;
          }

          if (type === 'c') {
            backFormulaInput(
              d,
              c,
              fix,
              [c, c],
              [st_r_r, fix - 1],
              formula,
              ctx,
            );
          } else {
            backFormulaInput(
              d,
              fix,
              c,
              [st_r_r, fix - 1],
              [c, c],
              formula,
              ctx,
            );
          }
        }
      } else {
        for (let c = ed_m; c >= st_m; c -= 1) {
          st_r_r = getNoNullValue(d, c, fix, type);

          if (st_r_r == null) {
            break;
          }

          if (type === 'c') {
            backFormulaInput(
              d,
              c,
              fix,
              [c, c],
              [st_r_r, fix - 1],
              formula,
              ctx,
            );
          } else {
            backFormulaInput(
              d,
              fix,
              c,
              [st_r_r, fix - 1],
              [c, c],
              formula,
              ctx,
            );
          }
        }
      }
    }
    return false;
  }
  if (isNum && noNum) {
    let cell = null;

    if (type === 'c') {
      cell = d[ed_m + 1][fix];
    } else {
      cell = d[fix][ed_m + 1];
    }

    /* 备注：在搜寻的时候排除自己以解决单元格函数引用自己的问题 */
    if (cell != null && cell.v != null && cell.v.toString().length > 0) {
      let c = ed_m + 1;

      if (type === 'c') {
        cell = d[ed_m + 1][fix];
      } else {
        cell = d[fix][ed_m + 1];
      }

      while (cell != null && cell.v != null && cell.v.toString().length > 0) {
        c += 1;
        let len = null;

        if (type === 'c') {
          len = d.length;
        } else {
          len = d[0].length;
        }

        if (c >= len) {
          return false;
        }

        if (type === 'c') {
          cell = d[c][fix];
        } else {
          cell = d[fix][c];
        }
      }

      if (type === 'c') {
        backFormulaInput(d, c, fix, [st_m, ed_m], [fix, fix], formula, ctx);
      } else {
        backFormulaInput(d, fix, c, [fix, fix], [st_m, ed_m], formula, ctx);
      }
    } else {
      if (type === 'c') {
        backFormulaInput(
          d,
          ed_m + 1,
          fix,
          [st_m, ed_m],
          [fix, fix],
          formula,
          ctx,
        );
      } else {
        backFormulaInput(
          d,
          fix,
          ed_m + 1,
          [fix, fix],
          [st_m, ed_m],
          formula,
          ctx,
        );
      }
    }
    return false;
  }
  return true;
}

export function autoSelectionFormula(
  ctx: Context,
  cellInput: HTMLDivElement,
  fxInput: HTMLDivElement | null | undefined,
  formula: string,
  cache: GlobalCache,
) {
  const allowEdit = isAllowEdit(ctx);
  if (!allowEdit) return;
  const flowdata = getFlowdata(ctx);
  if (flowdata == null) return;
  // const nullfindnum = 40;
  let isfalse = true;
  ctx.formulaCache.execFunctionExist = [];

  function execFormulaInput_c(
    d: CellMatrix,
    st_r: number,
    ed_r: number,
    st_c: number,
    ed_c: number,
    _formula: string,
  ) {
    const st_c_c = getNoNullValue(d, st_r, ed_c, 'c');

    if (st_c_c == null) {
      activeFormulaInput(
        cellInput,
        fxInput,
        ctx,
        st_r,
        st_c,
        null,
        null,
        _formula,
        cache,
        true,
      );
    } else {
      activeFormulaInput(
        cellInput,
        fxInput,
        ctx,
        st_r,
        st_c,
        [st_r, ed_r],
        [st_c_c, ed_c - 1],
        _formula,
        cache,
      );
    }
  }

  function execFormulaInput(
    d: CellMatrix,
    st_r: number,
    ed_r: number,
    st_c: number,
    ed_c: number,
    _formula: string,
  ) {
    const st_r_c = getNoNullValue(d, st_c, ed_r, 'r');

    if (st_r_c == null) {
      execFormulaInput_c(d, st_r, ed_r, st_c, ed_c, _formula);
    } else {
      activeFormulaInput(
        cellInput,
        fxInput,
        ctx,
        st_r,
        st_c,
        [st_r_c, ed_r - 1],
        [st_c, ed_c],
        _formula,
        cache,
      );
    }
  }
  if (!ctx.luckysheet_select_save) return;

  _.forEach(ctx.luckysheet_select_save, (selection) => {
    const [st_r, ed_r] = selection.row;
    const [st_c, ed_c] = selection.column;
    const row_index = selection.row_focus;
    const col_index = selection.column_focus;

    if (st_r === ed_r && st_c === ed_c) {
      if (ed_r - 1 < 0 && ed_c - 1 < 0) {
        activeFormulaInput(
          cellInput,
          fxInput,
          ctx,
          st_r,
          st_c,
          null,
          null,
          formula,
          cache,
          true,
        );
        return;
      }

      if (ed_r - 1 >= 0 && checkNoNullValue(flowdata[ed_r - 1][st_c])) {
        execFormulaInput(flowdata, st_r, ed_r, st_c, ed_c, formula);
      } else if (ed_c - 1 >= 0 && checkNoNullValue(flowdata[st_r][ed_c - 1])) {
        execFormulaInput_c(flowdata, st_r, ed_r, st_c, ed_c, formula);
      } else {
        execFormulaInput(flowdata, st_r, ed_r, st_c, ed_c, formula);
      }
    } else if (st_r === ed_r) {
      isfalse = singleFormulaInput(
        cellInput,
        fxInput,
        ctx,
        flowdata,
        col_index!,
        st_r,
        st_c,
        ed_c,
        formula,
        'r',
        cache,
      );
    } else if (st_c === ed_c) {
      isfalse = singleFormulaInput(
        cellInput,
        fxInput,
        ctx,
        flowdata,
        row_index!,
        st_c,
        st_r,
        ed_r,
        formula,
        'c',
        cache,
      );
    } else {
      let r_false = true;
      for (let r = st_r; r <= ed_r; r += 1) {
        r_false =
          singleFormulaInput(
            cellInput,
            fxInput,
            ctx,
            flowdata,
            col_index!,
            r,
            st_c,
            ed_c,
            formula,
            'r',
            cache,
            true,
            false,
          ) && r_false;
      }

      let c_false = true;
      for (let c = st_c; c <= ed_c; c += 1) {
        c_false =
          singleFormulaInput(
            cellInput,
            fxInput,
            ctx,
            flowdata,
            row_index!,
            c,
            st_r,
            ed_r,
            formula,
            'c',
            cache,
            true,
            false,
          ) && c_false;
      }

      isfalse = !!r_false && !!c_false;
    }

    isfalse = isfalse && isfalse;
  });

  if (!isfalse) {
    ctx.formulaCache.execFunctionExist.reverse();
    // @ts-ignore
    execFunctionGroup(ctx, null, null, null, null, flowdata);
    ctx.formulaCache.execFunctionGlobalData = null;
  }
}
export function cancelPaintModel(ctx: Context) {
  // $("#luckysheet-sheettable_0").removeClass("luckysheetPaintCursor");
  if (ctx.luckysheet_copy_save === null) return;
  if (ctx.luckysheet_copy_save?.dataSheetId === ctx.currentSheetId) {
    ctx.luckysheet_selection_range = [];
    selectionCopyShow(ctx.luckysheet_selection_range, ctx);
  } else {
    if (!ctx.luckysheet_copy_save) return;
    const index = getSheetIndex(ctx, ctx.luckysheet_copy_save.dataSheetId);
    if (!index) return;
    // ctx.luckysheetfile[getSheetIndex(ctx.luckysheet_copy_save["dataSheetIndex"])].luckysheet_selection_range = [];
    ctx.luckysheetfile[index].luckysheet_selection_range = [];
  }

  ctx.luckysheet_copy_save = {
    dataSheetId: '',
    copyRange: [{ row: [0], column: [0] }],
    RowlChange: false,
    HasMC: false,
  };

  ctx.luckysheetPaintModelOn = false;
  // $("#luckysheetpopover").fadeOut(200,function(){
  //     $("#luckysheetpopover").remove();
}
export function handleCurrencyFormat(ctx: Context, cellInput: HTMLDivElement) {
  const flowdata = getFlowdata(ctx);
  if (!flowdata) return;

  const currency = ctx.currency || '¥';

  updateFormat(
    ctx,
    cellInput,
    flowdata,
    'ct',
    buildFiatCurrencyFormat(currency, 2),
  );
}

export function handlePercentageFormat(
  ctx: Context,
  cellInput: HTMLDivElement,
) {
  const flowdata = getFlowdata(ctx);
  if (!flowdata) return;

  updateFormat(ctx, cellInput, flowdata, 'ct', '0.00%');
}

export function handleNumberDecrease(ctx: Context, cellInput: HTMLDivElement) {
  const flowdata = getFlowdata(ctx);
  if (!flowdata || !ctx.luckysheet_select_save) return;

  const row_index = ctx.luckysheet_select_save[0].row_focus;
  const col_index = ctx.luckysheet_select_save[0].column_focus;
  if (row_index === undefined || col_index === undefined) return;

  let foucsStatus = normalizedAttr(flowdata, row_index, col_index, 'ct');
  const cell = flowdata[row_index][col_index];

  if (!isCellEligibleForDecimalAdjust(cell)) {
    return;
  }

  if (foucsStatus == null) {
    foucsStatus = { fa: 'General', t: 'g' };
  }

  // General (Auto): adjust display decimals via ct.dp — keep fa General + t "g" (Sheets-like).
  if (isGeneralFormatCell(cell)) {
    const updated: { row: number; col: number }[] = [];
    forEachSelectedCell(ctx, flowdata, (r, c, targetCell) => {
      if (!isCellEligibleForDecimalAdjust(targetCell) || !targetCell) return;
      if (!isGeneralFormatCell(targetCell)) return;
      if (adjustGeneralDecimal(targetCell, -1)) {
        updated.push({ row: r, col: c });
      }
    });
    updated.forEach(({ row, col }) =>
      pushToolbarCellDataUpdate(ctx, row, col, flowdata),
    );
    return;
  }

  if (foucsStatus.t !== 'n') {
    return;
  }

  // 万亿格式
  const reg = /^(w|W)((0?)|(0\.0+))$/;
  if (reg.test(foucsStatus.fa)) {
    if (foucsStatus.fa.indexOf('.') > -1) {
      if (foucsStatus.fa.substr(-2) === '.0') {
        updateFormat(
          ctx,
          cellInput,
          flowdata,
          'ct',
          foucsStatus.fa.split('.')[0],
        );
      } else {
        updateFormat(
          ctx,
          cellInput,
          flowdata,
          'ct',
          foucsStatus.fa.substr(0, foucsStatus.fa.length - 1),
        );
      }
    } else {
      updateFormat(ctx, cellInput, flowdata, 'ct', foucsStatus.fa);
    }

    return;
  }
  // Uncaught ReferenceError: Cannot access 'fa' before initialization
  let prefix = '';
  let main = '';
  let fa = [];
  if (foucsStatus.fa.indexOf('.') > -1) {
    fa = foucsStatus.fa.split('.');
    [prefix, main] = fa;
  } else {
    return;
  }

  fa = main.split('');
  let tail = '';
  for (let i = fa.length - 1; i >= 0; i -= 1) {
    const c = fa[i];
    if (c !== '#' && c !== '0' && c !== ',' && Number.isNaN(parseInt(c, 10))) {
      tail = c + tail;
    } else {
      break;
    }
  }

  let fmt = '';
  if (foucsStatus.fa.indexOf('.') > -1) {
    let suffix = main;
    if (tail.length > 0) {
      suffix = main.replace(tail, '');
    }

    let pos = suffix.replace(/#/g, '0');
    pos = pos.substr(0, pos.length - 1);
    if (pos === '') {
      fmt = prefix + tail;
    } else {
      fmt = `${prefix}.${pos}${tail}`;
    }
  }

  updateFormat(ctx, cellInput, flowdata, 'ct', fmt);
}

export function handleNumberIncrease(ctx: Context, cellInput: HTMLDivElement) {
  const flowdata = getFlowdata(ctx);
  if (!flowdata) return;
  if (!ctx.luckysheet_select_save) return;
  const row_index = ctx.luckysheet_select_save[0].row_focus;
  const col_index = ctx.luckysheet_select_save[0].column_focus;
  if (row_index === undefined || col_index === undefined) return;
  let foucsStatus = normalizedAttr(flowdata, row_index, col_index, 'ct');
  const cell = flowdata[row_index][col_index];

  if (!isCellEligibleForDecimalAdjust(cell)) {
    return;
  }

  if (foucsStatus == null) {
    foucsStatus = { fa: 'General', t: 'g' };
  }

  // General (Auto): store decimal hint on ct.dp; keep fa/t as Auto (Sheets-like).
  if (isGeneralFormatCell(cell)) {
    const updated: { row: number; col: number }[] = [];
    forEachSelectedCell(ctx, flowdata, (r, c, targetCell) => {
      if (!isCellEligibleForDecimalAdjust(targetCell) || !targetCell) return;
      if (!isGeneralFormatCell(targetCell)) return;
      if (adjustGeneralDecimal(targetCell, 1)) {
        updated.push({ row: r, col: c });
      }
    });
    updated.forEach(({ row, col }) =>
      pushToolbarCellDataUpdate(ctx, row, col, flowdata),
    );
    return;
  }

  if (foucsStatus.t !== 'n') {
    return;
  }

  // 万亿格式
  const reg = /^(w|W)((0?)|(0\.0+))$/;
  if (reg.test(foucsStatus.fa)) {
    if (foucsStatus.fa.indexOf('.') > -1) {
      updateFormat(ctx, cellInput, flowdata, 'ct', `${foucsStatus.fa}0`);
    } else {
      if (foucsStatus.fa.substr(-1) === '0') {
        updateFormat(ctx, cellInput, flowdata, 'ct', `${foucsStatus.fa}.0`);
      } else {
        updateFormat(ctx, cellInput, flowdata, 'ct', `${foucsStatus.fa}0.0`);
      }
    }

    return;
  }

  // Uncaught ReferenceError: Cannot access 'fa' before initialization
  let prefix = '';
  let main = '';
  let fa = [];

  if (foucsStatus.fa.indexOf('.') > -1) {
    fa = foucsStatus.fa.split('.');
    [prefix, main] = fa;
  } else {
    main = foucsStatus.fa;
  }

  fa = main.split('');
  let tail = '';
  for (let i = fa.length - 1; i >= 0; i -= 1) {
    const c = fa[i];
    if (c !== '#' && c !== '0' && c !== ',' && Number.isNaN(parseInt(c, 10))) {
      tail = c + tail;
    } else {
      break;
    }
  }

  let fmt = '';
  if (foucsStatus.fa.indexOf('.') > -1) {
    let suffix = main;
    if (tail.length > 0) {
      suffix = main.replace(tail, '');
    }

    let pos = suffix.replace(/#/g, '0');
    pos += '0';
    fmt = `${prefix}.${pos}${tail}`;
  } else {
    if (tail.length > 0) {
      fmt = `${main.replace(tail, '')}.0${tail}`;
    } else {
      fmt = `${main}.0${tail}`;
    }
  }

  updateFormat(ctx, cellInput, flowdata, 'ct', fmt);
}

export function handleBold(ctx: Context, cellInput: HTMLDivElement) {
  toggleAttr(ctx, cellInput, 'bl');
}

export function handleItalic(ctx: Context, cellInput: HTMLDivElement) {
  toggleAttr(ctx, cellInput, 'it');
}

export function handleStrikeThrough(ctx: Context, cellInput: HTMLDivElement) {
  toggleAttr(ctx, cellInput, 'cl');
}

export function handleUnderline(ctx: Context, cellInput: HTMLDivElement) {
  toggleAttr(ctx, cellInput, 'un');
}

export function handleHorizontalAlign(
  ctx: Context,
  cellInput: HTMLDivElement,
  value: string,
) {
  setAttr(ctx, cellInput, 'ht', value);
}

export function handleVerticalAlign(
  ctx: Context,
  cellInput: HTMLDivElement,
  value: string,
) {
  setAttr(ctx, cellInput, 'vt', value);
}

export function handleFormatPainter(ctx: Context) {
  //   if (!checkIsAllowEdit()) {
  //     tooltip.info("", locale().pivotTable.errorNotAllowEdit);
  //     return
  // }

  // e.stopPropagation();

  // let _locale = locale();
  // let locale_paint = _locale.paint;
  const allowEdit = isAllowEdit(ctx);
  if (!allowEdit) return;
  if (
    ctx.luckysheet_select_save == null ||
    ctx.luckysheet_select_save.length === 0
  ) {
    // if(isEditMode()){
    //     alert(locale_paint.tipSelectRange);
    // }
    // else{
    //     tooltip.info("",locale_paint.tipSelectRange);
    // }
    return;
  }
  if (ctx.luckysheet_select_save.length > 1) {
    // if(isEditMode()){
    //     alert(locale_paint.tipNotMulti);
    // }
    // else{
    //     tooltip.info("",locale_paint.tipNotMulti);
    // }
    return;
  }

  // *增加了对选区范围是否为部分合并单元格的校验，如果为部分合并单元格，就阻止格式刷的下一步
  // TODO 这里也可以改为：判断到是合并单元格的一部分后，格式刷执行黏贴格式后删除范围单元格的 mc 值

  let has_PartMC = false;

  const r1 = ctx.luckysheet_select_save[0].row[0];
  const r2 = ctx.luckysheet_select_save[0].row[1];

  const c1 = ctx.luckysheet_select_save[0].column[0];
  const c2 = ctx.luckysheet_select_save[0].column[1];

  has_PartMC = hasPartMC(ctx, ctx.config, r1, r2, c1, c2);

  if (has_PartMC) {
    // *提示后中止下一步
    // tooltip.info('无法对部分合并单元格执行此操作', '');
    return;
  }

  // tooltip.popover("<i class='fa fa-paint-brush'></i> "+locale_paint.start+"", "topCenter", true, null, locale_paint.end,function(){
  cancelPaintModel(ctx);
  // });

  // $("#luckysheet-sheettable_0").addClass("luckysheetPaintCursor");

  ctx.luckysheet_selection_range = [
    {
      row: ctx.luckysheet_select_save[0].row,
      column: ctx.luckysheet_select_save[0].column,
    },
  ];

  selectionCopyShow(ctx.luckysheet_selection_range, ctx);
  let RowlChange = false;
  let HasMC = false;

  for (
    let r = ctx.luckysheet_select_save[0].row[0];
    r <= ctx.luckysheet_select_save[0].row[1];
    r += 1
  ) {
    if (ctx.config.rowhidden != null && ctx.config.rowhidden[r] != null) {
      continue;
    }

    if (ctx.config.rowlen != null && r in ctx.config.rowlen) {
      RowlChange = true;
    }

    for (
      let c = ctx.luckysheet_select_save[0].column[0];
      c <= ctx.luckysheet_select_save[0].column[1];
      c += 1
    ) {
      const flowdata = getFlowdata(ctx);
      if (!flowdata) return;
      const cell = flowdata[r][c];
      if (cell != null && cell.mc != null && cell.mc.rs != null) {
        HasMC = true;
      }
    }
  }
  ctx.luckysheet_copy_save = {
    dataSheetId: ctx.currentSheetId,
    copyRange: [
      {
        row: ctx.luckysheet_select_save[0].row,
        column: ctx.luckysheet_select_save[0].column,
      },
    ],
    RowlChange,
    HasMC,
  };

  ctx.luckysheetPaintModelOn = true;
  ctx.luckysheetPaintSingle = true;
}

// 2022-10-10 废弃了handleClearFormat中的foreach写法，改为可跳出的every写法，以防止选区多次覆盖
export function handleClearFormat(ctx: Context) {
  if (ctx.allowEdit === false) return;
  const flowdata = getFlowdata(ctx);
  if (!flowdata) return;
  const ydocChanges: any[] = [];
  let borderInfoChanged = false;
  ctx.luckysheet_select_save?.every((selection) => {
    const [rowSt, rowEd] = selection.row;
    const [colSt, colEd] = selection.column;
    for (let r = rowSt; r <= rowEd; r += 1) {
      if (!_.isNil(ctx.config.rowhidden) && !_.isNil(ctx.config.rowhidden[r])) {
        continue;
      }
      for (let c = colSt; c <= colEd; c += 1) {
        const cell = flowdata[r][c];
        if (!cell) continue;
        const nextCell = _.pick(cell, 'v', 'm', 'mc', 'f') as any;
        // Preserve semantic cell type/number format metadata on clear-format.
        // This keeps Date/Number/Text kind stable while removing visual styles.
        if (cell.ct != null && _.isPlainObject(cell.ct)) {
          nextCell.ct = _.cloneDeep(cell.ct);
        }
        if (cell.qp != null) {
          nextCell.qp = cell.qp;
        }
        flowdata[r][c] = nextCell;
        ydocChanges.push({
          sheetId: ctx.currentSheetId,
          path: ['celldata'],
          key: `${r}_${c}`,
          value: { r, c, v: flowdata[r][c] },
          type: 'update',
        });
      }
    }
    return true;
  });

  const index = getSheetIndex(ctx, ctx.currentSheetId);
  if (index != null && ctx.config.borderInfo?.length) {
    const selections =
      ctx.luckysheet_select_save?.map((s) => ({
        row: s.row as [number, number],
        column: s.column as [number, number],
      })) ?? [];
    const filtered = removeBorderInfoInSelections(
      ctx.config.borderInfo,
      selections,
    );
    ctx.luckysheetfile[index].config!.borderInfo = filtered;
    ctx.config.borderInfo = filtered;
    borderInfoChanged = true;
  }

  // Range-backed formatting survives strip-of-inline-attrs; punch selections out
  // of cellFormatRanges (O(ranges), not O(area × ranges)).
  let formatRangesChanged = false;
  if (index != null && ctx.luckysheet_select_save?.length) {
    const sheet = ctx.luckysheetfile[index];
    sheet.config ||= {};
    let nextRanges = sheet.config.cellFormatRanges ?? ctx.config?.cellFormatRanges;
    const prevRanges = nextRanges;
    ctx.luckysheet_select_save.forEach((selection) => {
      nextRanges = removeCellFormatRangesInRect(
        nextRanges,
        selection.row as [number, number],
        selection.column as [number, number],
      );
    });
    if (!_.isEqual(prevRanges, nextRanges)) {
      sheet.config.cellFormatRanges = nextRanges;
      ctx.config.cellFormatRanges = nextRanges;
      formatRangesChanged = true;
    }
  }

  if (ctx?.hooks?.updateCellYdoc) {
    if (borderInfoChanged) {
      syncBorderInfoToYdoc(ctx, ctx.config?.borderInfo ?? []);
    }
    if (formatRangesChanged) {
      ydocChanges.push({
        sheetId: ctx.currentSheetId,
        path: ['config', 'cellFormatRanges'],
        value: ctx.config.cellFormatRanges ?? [],
        type: 'update',
      });
    }
    if (ydocChanges.length > 0) {
      ctx.hooks.updateCellYdoc(ydocChanges);
    }
  }
}

export function handleTextColor(
  ctx: Context,
  cellInput: HTMLDivElement,
  color: string,
) {
  setAttr(ctx, cellInput, 'fc', color);
}

export function handleTextBackground(
  ctx: Context,
  cellInput: HTMLDivElement,
  color: string,
) {
  setAttr(ctx, cellInput, 'bg', color);
}

export function handleBorder(
  ctx: Context,
  type: string,
  borderColor?: string,
  borderStyle?: string,
) {
  // *如果禁止前台编辑，则中止下一步操作
  // if (!checkIsAllowEdit()) {
  //   tooltip.info("", locale().pivotTable.errorNotAllowEdit);
  //   return;
  // }
  // if (!checkProtectionFormatCells(Store.currentSheetId)) {
  //   return;
  // }

  // const d = editor.deepCopyFlowData(Store.flowdata);
  // let type = $(this).attr("type");
  // let type = "border-all";
  const allowEdit = isAllowEdit(ctx);
  if (!allowEdit) return;
  if (type == null) {
    type = 'border-all';
  }

  // const subcolormenuid = "luckysheet-icon-borderColor-menuButton";
  // let color = $(`#${subcolormenuid}`).find(".luckysheet-color-selected").val();
  // let style = $("#luckysheetborderSizepreview").attr("itemvalue");

  // let color = "#000000";
  let color = borderColor;
  let style = borderStyle;

  if (color == null || color === '') {
    color = '#000';
  }

  if (style == null || style === '') {
    style = '1';
  }

  const cfg = ctx.config;
  if (cfg.borderInfo == null) {
    cfg.borderInfo = [];
  }

  const selections =
    ctx.luckysheet_select_save?.map((s) => ({
      row: s.row as [number, number],
      column: s.column as [number, number],
    })) ?? [];

  // Only strip overlapping entries for the eraser. Other border types must
  // accumulate (border-all then border-top = both), matching pre-strip semantics.
  if (type === 'border-none') {
    cfg.borderInfo = removeBorderInfoInSelections(cfg.borderInfo, selections);
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    assignActiveConfigToSheetFile(ctx.luckysheetfile[index], ctx.config);
    ctx.config = ctx.luckysheetfile[index].config!;
    syncBorderInfoToYdoc(ctx, cfg.borderInfo);
    return;
  }

  if (type !== 'border-slash') {
    const borderInfo = {
      rangeType: 'range',
      borderType: type,
      color,
      style,
      range: _.cloneDeep(ctx.luckysheet_select_save) || [],
    };
    cfg.borderInfo.push(borderInfo);
  } else {
    const rangeList: string[] = [];
    _.forEach(ctx.luckysheet_select_save, (selection) => {
      for (let r = selection.row[0]; r <= selection.row[1]; r += 1) {
        for (let c = selection.column[0]; c <= selection.column[1]; c += 1) {
          const range = `${r}_${c}`;
          if (_.includes(rangeList, range)) continue;
          const borderInfo = {
            rangeType: 'range',
            borderType: type,
            color,
            style,
            range: normalizeSelection(ctx, [{ row: [r, r], column: [c, c] }]),
          };
          cfg.borderInfo!.push(borderInfo);
          rangeList.push(range);
        }
      }
    });
  }

  // server.saveParam("cg", ctx.currentSheetId, cfg.borderInfo, {
  //   k: "borderInfo",
  // });

  const index = getSheetIndex(ctx, ctx.currentSheetId);
  if (index == null) return;

  assignActiveConfigToSheetFile(ctx.luckysheetfile[index], ctx.config);
  ctx.config = ctx.luckysheetfile[index].config!;
  syncBorderInfoToYdoc(ctx, cfg.borderInfo);
}

export function handleMerge(ctx: Context, type: string) {
  const allowEdit = isAllowEdit(ctx);
  if (!allowEdit) return;
  // if (!checkProtectionNotEnable(ctx.currentSheetId)) {
  //   return;
  // }

  if (selectIsOverlap(ctx)) {
    //   if (isEditMode()) {
    //     alert("不能合并重叠区域");
    //   } else {
    //     tooltip.info("不能合并重叠区域", "");
    //   }
    return;
  }

  if (ctx.config.merge != null) {
    let has_PartMC = false;
    if (!ctx.luckysheet_select_save) return;
    for (let s = 0; s < ctx.luckysheet_select_save.length; s += 1) {
      const r1 = ctx.luckysheet_select_save[s].row[0];
      const r2 = ctx.luckysheet_select_save[s].row[1];
      const c1 = ctx.luckysheet_select_save[s].column[0];
      const c2 = ctx.luckysheet_select_save[s].column[1];

      has_PartMC = hasPartMC(ctx, ctx.config, r1, r2, c1, c2);

      if (has_PartMC) {
        break;
      }
    }

    if (has_PartMC) {
      // if (isEditMode()) {
      //   alert("无法对部分合并单元格执行此操作");
      // } else {
      //   tooltip.info("无法对部分合并单元格执行此操作", "");
      // }
      return;
    }
  }

  const flowdata = getFlowdata(ctx);
  if (!flowdata) return;

  if (!ctx.luckysheet_select_save) return;

  mergeCells(ctx, ctx.currentSheetId, ctx.luckysheet_select_save, type);
}

export function handleSort(ctx: Context, isAsc: boolean) {
  sortSelection(ctx, isAsc);
}

export function handleFreeze(ctx: Context, type: string) {
  const allowEdit = isAllowEdit(ctx);
  if (!allowEdit) return;

  const file = ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!];
  if (!file) return;

  if (type === 'freeze-cancel') {
    delete file.frozen;
    return;
  }

  const firstSelection = ctx.luckysheet_select_save?.[0];
  if (!firstSelection) return;

  let { row_focus, column_focus } = firstSelection;
  if (row_focus == null || column_focus == null) return;

  const m = ctx.config.merge?.[`${row_focus}_${column_focus}`];
  if (m) {
    row_focus = m.r + m.rs - 1;
    column_focus = m.c + m.cs - 1;
  }

  file.frozen = { type: 'both', range: { row_focus, column_focus } };
  if (type === 'freeze-row') {
    file.frozen.type = 'rangeRow';
  } else if (type === 'freeze-col') {
    file.frozen.type = 'rangeColumn';
  }
}

export function handleTextSize(
  ctx: Context,
  cellInput: HTMLDivElement,
  size: number,
  canvas?: CanvasRenderingContext2D,
) {
  setAttr(ctx, cellInput, 'fs', size, canvas);
}

export function handleSum(
  ctx: Context,
  cellInput: HTMLDivElement,
  fxInput: HTMLDivElement | null | undefined,
  cache?: GlobalCache,
) {
  autoSelectionFormula(ctx, cellInput, fxInput, 'SUM', cache!);
}

/** Match contenteditable / innerText newline normalization for offset math. */
function normalizeCellPlainTextForEditor(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Records caret and selection offsets for the active cell editor into `cache`.
 * Call on toolbar link mousedown (before focus leaves the editor) and from selectionchange while editing.
 */
/** Plain text from the active cell or formula-bar editor (when editing). */
function getActiveEditPlainTextForHyperlink(
  ctx: Context,
  cellInput: HTMLDivElement | null | undefined,
): string {
  const editing =
    ctx.luckysheetCellUpdate?.length === 2 &&
    ctx.luckysheetCellUpdate[0] != null &&
    ctx.luckysheetCellUpdate[1] != null;
  if (!editing) return '';
  const owner = getFormulaEditorOwner(ctx);
  if (owner === 'fx') {
    const el = document.getElementById(
      'luckysheet-functionbox-cell',
    ) as HTMLDivElement | null;
    return el?.innerText ?? '';
  }
  return cellInput?.innerText ?? '';
}

/**
 * Hyperlink insert is not supported for formula cells or when the user is entering a formula
 * (cell / formula bar content starts with `=`).
 */
export function isHyperlinkCreationBlocked(
  ctx: Context,
  cellInput: HTMLDivElement | null | undefined,
): boolean {
  const selection = ctx.luckysheet_select_save?.[0];
  const flowdata = getFlowdata(ctx);
  if (flowdata == null || selection == null) return false;

  const r = selection.row[0];
  const c = selection.column[0];
  const cell = flowdata[r]?.[c];
  const hasFormula = cell?.f != null && String(cell.f).trim() !== '';

  if (hasFormula) return true;

  const editText = getActiveEditPlainTextForHyperlink(ctx, cellInput);
  if (editText.length > 0 && editText.trimStart().startsWith('=')) {
    return true;
  }

  return false;
}

export function captureLinkEditorOpenSnapshot(
  ctx: Context,
  cellInput: HTMLDivElement | null | undefined,
  cache: GlobalCache | undefined,
): void {
  if (!cache || !cellInput) return;
  if (ctx.luckysheetCellUpdate.length !== 2) {
    delete cache.linkEditorOpenSnapshot;
    return;
  }
  const [r, c] = ctx.luckysheetCellUpdate;
  const value = cellInput.innerText ?? '';
  if (value.startsWith('=')) {
    delete cache.linkEditorOpenSnapshot;
    return;
  }
  const fullNorm = normalizeCellPlainTextForEditor(value);
  const range = getSelectionCharacterOffsets(cellInput);
  const focusOff = getFocusCharacterOffset(cellInput);
  if (focusOff == null && range == null) {
    delete cache.linkEditorOpenSnapshot;
    return;
  }
  let selectedPlain = '';
  if (range) {
    selectedPlain = fullNorm.slice(range.start, range.end);
  }
  cache.linkEditorOpenSnapshot = {
    sheetId: ctx.currentSheetId,
    r,
    c,
    focusOffset: focusOff ?? range?.start ?? 0,
    range,
    selectedPlain,
  };
}

export function handleLink(
  ctx: Context,
  cellInput: HTMLDivElement | null | undefined,
  cache?: GlobalCache,
) {
  const allowEdit = isAllowEdit(ctx);
  if (!allowEdit) return;
  if (isHyperlinkCreationBlocked(ctx, cellInput)) {
    cache?.onHyperlinkInsertBlocked?.();
    return;
  }
  const selection = ctx.luckysheet_select_save?.[0];
  const flowdata = getFlowdata(ctx);
  if (flowdata == null || selection == null) return;

  const r = selection.row[0];
  const c = selection.column[0];
  const isEditMode =
    ctx.luckysheetCellUpdate?.length === 2 &&
    ctx.luckysheetCellUpdate[0] === r &&
    ctx.luckysheetCellUpdate[1] === c;

  let applyToSelection = false;
  let originText: string | undefined;
  let selectionOffsets: { start: number; end: number } | undefined;
  let linkInsertOffset: number | undefined;
  let prefillLink: { linkType: string; linkAddress: string } | undefined;
  const selectedCell = flowdata?.[r]?.[c];

  if (isEditMode && cellInput) {
    const value = cellInput.innerText ?? '';
    if (value.substring(0, 1) !== '=') {
      const snap = cache?.linkEditorOpenSnapshot;
      const snapOk =
        snap &&
        snap.sheetId === ctx.currentSheetId &&
        snap.r === r &&
        snap.c === c;

      if (snapOk) {
        linkInsertOffset = snap.focusOffset;
        if (snap.range) {
          applyToSelection = true;
          selectionOffsets = { start: snap.range.start, end: snap.range.end };
          originText = snap.selectedPlain;
        } else {
          applyToSelection = true;
          selectionOffsets = { start: snap.focusOffset, end: snap.focusOffset };
          originText = '';
        }
        delete cache!.linkEditorOpenSnapshot;
      } else {
        const focusOff = getFocusCharacterOffset(cellInput);
        if (focusOff != null) {
          linkInsertOffset = focusOff;
        }
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && cellInput.contains(sel.anchorNode)) {
          const r0 = sel.getRangeAt(0);
          if (!r0.collapsed) {
            originText = sel.toString();
            applyToSelection = true;
            const off = getSelectionCharacterOffsets(cellInput);
            if (off) selectionOffsets = off;
          } else if (focusOff != null) {
            applyToSelection = true;
            selectionOffsets = { start: focusOff, end: focusOff };
            originText = '';
          }
        }
      }
    }
    if (selectionOffsets && selectedCell && value.substring(0, 1) !== '=') {
      prefillLink =
        getUniformLinkFromWindowSelectionInEditor(cellInput) ??
        getUniformLinkCoveringPlainRange(
          selectedCell as Cell,
          selectionOffsets.start,
          selectionOffsets.end,
        ) ??
        getUniformLinkAtPlainOffset(
          selectedCell as Cell,
          selectionOffsets.start,
        );
    }
  }

  // If link action is triggered from a selected (non-editing) cell,
  // switch that cell into edit mode so insert/edit link happens in-editor.
  if (!isEditMode) {
    delete cache?.linkEditorOpenSnapshot;
    const rawFull = (() => {
      if (
        selectedCell?.ct?.t === 'inlineStr' &&
        Array.isArray((selectedCell as any).ct?.s)
      ) {
        return ((selectedCell as any).ct.s as Array<{ v?: string }>)
          .map((s) => s?.v ?? '')
          .join('');
      }
      if (selectedCell?.v == null || Array.isArray(selectedCell?.v)) return '';
      return `${selectedCell.v}`;
    })();
    const fullNorm = normalizeCellPlainTextForEditor(rawFull);
    const endPos = fullNorm.length;
    applyToSelection = true;

    const existingLinks = getCellHyperlinks(ctx, r, c);
    const firstExisting = existingLinks[0];
    // Insert from toolbar / Cmd+K while not editing: always treat display + in-editor
    // selection as the **entire** cell so the modal shows full text and highlight matches.
    // (Partial inline runs are for edit-mode / pencil flows; sheet hyperlink map must not
    // shrink selection to only the linked substring here.)
    if (endPos > 0) {
      selectionOffsets = { start: 0, end: endPos };
      originText = fullNorm;
      linkInsertOffset = endPos;
    } else {
      selectionOffsets = { start: 0, end: 0 };
      originText = '';
      linkInsertOffset = 0;
    }
    if (firstExisting) {
      prefillLink = firstExisting;
    }
    ctx.luckysheetCellUpdate = [r, c];
  }

  showLinkCard(
    ctx,
    r,
    c,
    {
      applyToSelection: applyToSelection || undefined,
      originText,
      selectionOffsets,
      linkInsertOffset,
      prefillLink,
    },
    true,
    false,
  );
}

const handlerMap: Record<string, ToolbarItemClickHandler> = {
  'currency-format': handleCurrencyFormat,
  'percentage-format': handlePercentageFormat,
  'number-decrease': handleNumberDecrease,
  'number-increase': handleNumberIncrease,
  'sort-cell': (ctx: Context) => handleSort(ctx, true),
  'merge-all': (ctx: Context) => handleMerge(ctx, 'merge-all'),
  'border-all': (ctx: Context) => handleBorder(ctx, 'border-all'),
  bold: handleBold,
  italic: handleItalic,
  'strike-through': handleStrikeThrough,
  underline: handleUnderline,
  'clear-format': handleClearFormat,
  'format-painter': handleFormatPainter,
  search: (ctx: Context) => {
    ctx.showSearch = true;
  },
  link: (ctx, cellInput, c) => handleLink(ctx, cellInput, c),
};

const selectedMap: Record<string, ToolbarItemSelectedFunc> = {
  bold: (cell) => cell?.bl === 1,
  italic: (cell) => cell?.it === 1,
  'strike-through': (cell) => cell?.cl === 1,
  underline: (cell) => cell?.un === 1,
};

export function toolbarItemClickHandler(name: string) {
  return handlerMap[name];
}

export function toolbarItemSelectedFunc(name: string) {
  return selectedMap[name];
}
