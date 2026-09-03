import _ from 'lodash';
import { getdatabyselection } from './cell';
import { recalcAutoRowHeightForRow } from './cell';

import { Context, getFlowdata, updateContextWithSheetData } from '../context';
import {
  colLocation,
  colLocationByIndex,
  mousePosition,
  rowLocation,
  rowLocationByIndex,
} from './location';
import { hasPartMC } from './validation';
import { locale } from '../locale';
import { getBorderInfoCompute } from './border';
import { normalizeSelection } from './selection';
import { getSheetIndex, isAllowEdit } from '../utils';
import { cfSplitRange } from './conditionalFormat';
import { GlobalCache, HyperlinkEntry } from '../types';
import { jfrefreshgrid } from './refresh';
import { CFSplitRange } from './ConditionFormat';
import { functionMoveReference } from './formula';
import { moveCellFormatRanges, rangesEqual } from '../utils/range-format';
import {
  getSheetCommentKeyPrefixes,
  notifyCommentAnchorMove,
} from '../utils/comment-anchor-move';

const dragCellThreshold = 8;

function recalcMovedRowsAutoHeight(
  ctx: Context,
  d: ReturnType<typeof getFlowdata>,
  container: HTMLDivElement,
  sourceRowStart: number,
  sourceRowEnd: number,
  targetRowStart: number,
  targetRowEnd: number,
) {
  if (!d) return;
  const doc = container.ownerDocument || document;
  const canvasEl =
    (container.querySelector(
      '.fortune-sheet-canvas',
    ) as HTMLCanvasElement | null) ||
    (doc.querySelector('.fortune-sheet-canvas') as HTMLCanvasElement | null);
  const canvas = canvasEl?.getContext('2d');
  if (!canvas) return;
  canvas.textBaseline = 'top';

  const rowIndexes = new Set<number>();
  for (let r = sourceRowStart; r <= sourceRowEnd; r += 1) rowIndexes.add(r);
  for (let r = targetRowStart; r <= targetRowEnd; r += 1) rowIndexes.add(r);
  rowIndexes.forEach((r) => recalcAutoRowHeightForRow(ctx, r, d, canvas));
}

function getCellLocationByMouse(
  ctx: Context,
  e: MouseEvent,
  scrollbarX: HTMLDivElement,
  scrollbarY: HTMLDivElement,
  container: HTMLDivElement,
) {
  const rect = container.getBoundingClientRect();
  const x = e.pageX - rect.left - ctx.rowHeaderWidth + scrollbarX.scrollLeft;
  const y = e.pageY - rect.top - ctx.columnHeaderHeight + scrollbarY.scrollTop;

  return {
    row: rowLocation(y, ctx.visibledatarow),
    column: colLocation(x, ctx.visibledatacolumn),
  };
}

export function onCellsMoveStart(
  ctx: Context,
  globalCache: GlobalCache,
  e: MouseEvent,
  scrollbarX: HTMLDivElement,
  scrollbarY: HTMLDivElement,
  container: HTMLDivElement,
) {
  // if (isEditMode() || ctx.allowEdit === false) {
  const allowEdit = isAllowEdit(ctx);
  if (allowEdit === false) {
    // 此模式下禁用选区拖动
    return;
  }

  globalCache.dragCellStartPos = { x: e.pageX, y: e.pageY };
  ctx.luckysheet_cell_selected_move = true;
  ctx.luckysheet_scroll_status = true;

  let {
    row: [row_pre, row, row_index],
    column: [col_pre, col, col_index],
  } = getCellLocationByMouse(ctx, e, scrollbarX, scrollbarY, container);

  const range = _.last(ctx.luckysheet_select_save);
  if (range == null) return;

  if (row_index < range.row[0]) {
    [row_index] = range.row;
  } else if (row_index > range.row[1]) [, row_index] = range.row;
  if (col_index < range.column[0]) {
    [col_index] = range.column;
  } else if (col_index > range.column[1]) [, col_index] = range.column;
  [row_pre, row] = rowLocationByIndex(row_index, ctx.visibledatarow);
  [col_pre, col] = colLocationByIndex(col_index, ctx.visibledatacolumn);

  ctx.luckysheet_cell_selected_move_index = [row_index, col_index];

  const ele = document.getElementById('fortune-cell-selected-move');
  if (ele == null) return;
  ele.style.cursor = 'grabbing';
  ele.style.left = `${col_pre}px`;
  ele.style.top = `${row_pre}px`;
  ele.style.width = `${col - col_pre - 1}px`;
  ele.style.height = `${row - row_pre - 1}px`;
  ele.style.display = 'block';

  e.stopPropagation();
}

export function onCellsMove(
  ctx: Context,
  globalCache: GlobalCache,
  e: MouseEvent,
  scrollbarX: HTMLDivElement,
  scrollbarY: HTMLDivElement,
  container: HTMLDivElement,
) {
  if (!ctx.luckysheet_cell_selected_move) return;
  if (globalCache.dragCellStartPos != null) {
    const deltaX = Math.abs(globalCache.dragCellStartPos.x - e.pageX);
    const deltaY = Math.abs(globalCache.dragCellStartPos.y - e.pageY);
    if (deltaX < dragCellThreshold && deltaY < dragCellThreshold) {
      return;
    }
    globalCache.dragCellStartPos = undefined;
  }
  const [x, y] = mousePosition(e.pageX, e.pageY, ctx);

  const rect = container.getBoundingClientRect();
  const winH = rect.height - 20 * ctx.zoomRatio;
  const winW = rect.width - 60 * ctx.zoomRatio;

  const { row: rowL, column } = getCellLocationByMouse(
    ctx,
    e,
    scrollbarX,
    scrollbarY,
    container,
  );
  let [row_pre, row] = rowL;
  let [col_pre, col] = column;
  const row_index = rowL[2];
  const col_index = column[2];

  const row_index_original = ctx.luckysheet_cell_selected_move_index[0];
  const col_index_original = ctx.luckysheet_cell_selected_move_index[1];
  if (ctx.luckysheet_select_save == null) return;
  let row_s =
    ctx.luckysheet_select_save[0].row[0] - row_index_original + row_index;
  let row_e =
    ctx.luckysheet_select_save[0].row[1] - row_index_original + row_index;

  let col_s =
    ctx.luckysheet_select_save[0].column[0] - col_index_original + col_index;
  let col_e =
    ctx.luckysheet_select_save[0].column[1] - col_index_original + col_index;

  if (row_s < 0 || y < 0) {
    row_s = 0;
    row_e =
      ctx.luckysheet_select_save[0].row[1] -
      ctx.luckysheet_select_save[0].row[0];
  }

  if (col_s < 0 || x < 0) {
    col_s = 0;
    col_e =
      ctx.luckysheet_select_save[0].column[1] -
      ctx.luckysheet_select_save[0].column[0];
  }

  if (row_e >= ctx.visibledatarow.length - 1 || y > winH) {
    row_s =
      ctx.visibledatarow.length -
      1 -
      ctx.luckysheet_select_save[0].row[1] +
      ctx.luckysheet_select_save[0].row[0];
    row_e = ctx.visibledatarow.length - 1;
  }

  if (col_e >= ctx.visibledatacolumn.length - 1 || x > winW) {
    col_s =
      ctx.visibledatacolumn.length -
      1 -
      ctx.luckysheet_select_save[0].column[1] +
      ctx.luckysheet_select_save[0].column[0];
    col_e = ctx.visibledatacolumn.length - 1;
  }

  col_pre = col_s - 1 === -1 ? 0 : ctx.visibledatacolumn[col_s - 1];
  col = ctx.visibledatacolumn[col_e];
  row_pre = row_s - 1 === -1 ? 0 : ctx.visibledatarow[row_s - 1];
  row = ctx.visibledatarow[row_e];

  const ele = document.getElementById('fortune-cell-selected-move');
  if (ele == null) return;
  ele.style.left = `${col_pre}px`;
  ele.style.top = `${row_pre}px`;
  ele.style.width = `${col - col_pre - 2}px`;
  ele.style.height = `${row - row_pre - 2}px`;
  ele.style.display = 'block';
}

export function onCellsMoveEnd(
  ctx: Context,
  globalCache: GlobalCache,
  e: MouseEvent,
  scrollbarX: HTMLDivElement,
  scrollbarY: HTMLDivElement,
  container: HTMLDivElement,
) {
  // 改变选择框的位置并替换目标单元格
  if (!ctx.luckysheet_cell_selected_move) return;
  ctx.luckysheet_cell_selected_move = false;
  const ele = document.getElementById('fortune-cell-selected-move');
  if (ele != null) {
    ele.style.cursor = 'grabbing';
    ele.style.display = 'none';
  }
  if (globalCache.dragCellStartPos != null) {
    globalCache.dragCellStartPos = undefined;
    return;
  }

  const [x, y] = mousePosition(e.pageX, e.pageY, ctx);

  // if (
  //   !checkProtectionLockedRangeList(
  //     ctx.luckysheet_select_save,
  //     ctx.currentSheetIndex
  //   )
  // ) {
  //   return;
  // }

  const rect = container.getBoundingClientRect();
  const winH = rect.height - 20 * ctx.zoomRatio;
  const winW = rect.width - 60 * ctx.zoomRatio;

  const {
    row: [, , row_index],
    column: [, , col_index],
  } = getCellLocationByMouse(ctx, e, scrollbarX, scrollbarY, container);

  const allowEdit = isAllowEdit(ctx, [
    {
      row: [row_index, row_index],
      column: [col_index, col_index],
    },
  ]);
  if (!allowEdit) return;

  const row_index_original = ctx.luckysheet_cell_selected_move_index[0];
  const col_index_original = ctx.luckysheet_cell_selected_move_index[1];

  if (row_index === row_index_original && col_index === col_index_original) {
    return;
  }

  const d = getFlowdata(ctx);
  if (d == null || ctx.luckysheet_select_save == null) return;
  const last =
    ctx.luckysheet_select_save[ctx.luckysheet_select_save.length - 1];

  const data = _.cloneDeep(getdatabyselection(ctx, last, ctx.currentSheetId));

  const cfg = ctx.config;
  if (cfg.merge == null) {
    cfg.merge = {};
  }
  if (cfg.rowlen == null) {
    cfg.rowlen = {};
  }
  const { drag: locale_drag } = locale(ctx);

  // 选区包含部分单元格
  if (
    hasPartMC(
      ctx,
      cfg,
      last.row[0],
      last.row[1],
      last.column[0],
      last.column[1],
    )
  ) {
    // if (isEditMode()) {
    //   alert(locale_drag.noMerge);
    // } else {
    // drag.info(
    //   '<i class="fa fa-exclamation-triangle"></i>',
    throw new Error(locale_drag.noMerge);
    // );
    // }
    // return;
  }

  let row_s = last.row[0] - row_index_original + row_index;
  let row_e = last.row[1] - row_index_original + row_index;
  let col_s = last.column[0] - col_index_original + col_index;
  let col_e = last.column[1] - col_index_original + col_index;

  // if (
  //   !checkProtectionLockedRangeList(
  //     [{ row: [row_s, row_e], column: [col_s, col_e] }],
  //     ctx.currentSheetIndex
  //   )
  // ) {
  //   return;
  // }

  if (row_s < 0 || y < 0) {
    row_s = 0;
    row_e = last.row[1] - last.row[0];
  }

  if (col_s < 0 || x < 0) {
    col_s = 0;
    col_e = last.column[1] - last.column[0];
  }

  if (row_e >= ctx.visibledatarow.length - 1 || y > winH) {
    row_s = ctx.visibledatarow.length - 1 - last.row[1] + last.row[0];
    row_e = ctx.visibledatarow.length - 1;
  }

  if (col_e >= ctx.visibledatacolumn.length - 1 || x > winW) {
    col_s = ctx.visibledatacolumn.length - 1 - last.column[1] + last.column[0];
    col_e = ctx.visibledatacolumn.length - 1;
  }

  // 替换的位置包含部分单元格
  if (hasPartMC(ctx, cfg, row_s, row_e, col_s, col_e)) {
    // if (isEditMode()) {
    //   alert(locale_drag.noMerge);
    // } else {
    // tooltip.info(
    //   '<i class="fa fa-exclamation-triangle"></i>',
    throw new Error(locale_drag.noMerge);
    // );
    // }
    // return;
  }

  const borderInfoCompute = getBorderInfoCompute(ctx, ctx.currentSheetId);

  const cellChanges: {
    sheetId: string;
    path: string[];
    key?: string;
    value: any;
    type?: 'update' | 'delete';
  }[] = [];

  const hyperLinkList: Record<string, HyperlinkEntry | HyperlinkEntry[]> = {};
  // 删除原本位置的数据
  // const RowlChange = null;
  const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
  const file: any = ctx.luckysheetfile[index];
  // Data validation is stored under `dataVerification` in this codebase.
  // Keep a fallback to legacy `dataValidation` to avoid dropping old in-memory state.
  const sourceDataValidation =
    file.dataVerification ?? file.dataValidation ?? {};
  const nextDataValidation = _.cloneDeep(sourceDataValidation);
  const movedDataValidation: Record<string, any> = {};
  const sourceCalcChain = file.calcChain ?? [];
  const nextCalcChain: any[] = [];
  const movedCalcChain: any[] = [];
  const rowOffset = row_s - last.row[0];
  const colOffset = col_s - last.column[0];
  const isInSourceRange = (r: number, c: number) =>
    r >= last.row[0] &&
    r <= last.row[1] &&
    c >= last.column[0] &&
    c <= last.column[1];
  const isInTargetRange = (r: number, c: number) =>
    r >= row_s && r <= row_e && c >= col_s && c <= col_e;

  for (let i = 0; i < sourceCalcChain.length; i += 1) {
    const calc = sourceCalcChain[i];
    if (calc == null || _.isNil(calc.r) || _.isNil(calc.c)) continue;
    const calcR = Number(calc.r);
    const calcC = Number(calc.c);

    if (isInSourceRange(calcR, calcC)) {
      const movedCalc = _.cloneDeep(calc);
      movedCalc.r = calcR + rowOffset;
      movedCalc.c = calcC + colOffset;
      movedCalcChain.push(movedCalc);
      continue;
    }
    if (isInTargetRange(calcR, calcC)) continue;
    nextCalcChain.push(calc);
  }
  file.calcChain = nextCalcChain.concat(movedCalcChain);
  for (let r = last.row[0]; r <= last.row[1]; r += 1) {
    // if (r in cfg.rowlen) {
    //   RowlChange = true;
    // }

    for (let c = last.column[0]; c <= last.column[1]; c += 1) {
      const cellData = d[r][c];

      if (cellData?.mc != null) {
        const mergeKey = `${cellData.mc.r}_${c}`;
        if (cfg.merge[mergeKey] != null) {
          delete cfg.merge[mergeKey];
        }
      }

      d[r][c] = null;
      cellChanges.push({
        sheetId: ctx.currentSheetId,
        path: ['celldata'],
        value: { r, c, v: null },
        key: `${r}_${c}`,
        type: 'update',
      });
      if (ctx.luckysheetfile[index].hyperlink?.[`${r}_${c}`]) {
        hyperLinkList[`${r}_${c}`] =
          ctx.luckysheetfile[index].hyperlink?.[`${r}_${c}`]!;
        delete ctx.luckysheetfile[
          getSheetIndex(ctx, ctx.currentSheetId) as number
        ].hyperlink?.[`${r}_${c}`];
      }

      const targetR = r - last.row[0] + row_s;
      const targetC = c - last.column[0] + col_s;
      const sourceKey = `${r}_${c}`;
      const targetKey = `${targetR}_${targetC}`;
      const sourceDv = sourceDataValidation[sourceKey];
      delete nextDataValidation[sourceKey];
      delete nextDataValidation[targetKey];
      if (sourceDv != null) {
        movedDataValidation[targetKey] = _.cloneDeep(sourceDv);
      }
    }
  }
  _.forEach(movedDataValidation, (v, key) => {
    nextDataValidation[key] = v;
  });
  file.dataVerification = nextDataValidation;
  // 边框
  if (cfg.borderInfo && cfg.borderInfo.length > 0) {
    const borderInfo = [];

    for (let i = 0; i < cfg.borderInfo.length; i += 1) {
      const bd_rangeType = cfg.borderInfo[i].rangeType;

      if (
        bd_rangeType === 'range' &&
        cfg.borderInfo[i].borderType !== 'border-slash'
      ) {
        const bd_range = cfg.borderInfo[i].range;
        let bd_emptyRange: any[] = [];
        for (let j = 0; j < bd_range.length; j += 1) {
          bd_emptyRange = bd_emptyRange.concat(
            cfSplitRange(
              bd_range[j],
              { row: last.row, column: last.column },
              { row: [row_s, row_e], column: [col_s, col_e] },
              'restPart',
            ),
          );
        }

        cfg.borderInfo[i].range = bd_emptyRange;
        borderInfo.push(cfg.borderInfo[i]);
      } else if (bd_rangeType === 'cell') {
        const bd_r = cfg.borderInfo[i].value.row_index;
        const bd_c = cfg.borderInfo[i].value.col_index;

        if (
          !(
            bd_r >= last.row[0] &&
            bd_r <= last.row[1] &&
            bd_c >= last.column[0] &&
            bd_c <= last.column[1]
          )
        ) {
          borderInfo.push(cfg.borderInfo[i]);
        }
      } else if (
        bd_rangeType === 'range' &&
        cfg.borderInfo[i].borderType === 'border-slash' &&
        !(
          cfg.borderInfo[i].range[0].row[0] >= last.row[0] &&
          cfg.borderInfo[i].range[0].row[0] <= last.row[1] &&
          cfg.borderInfo[i].range[0].column[0] >= last.column[0] &&
          cfg.borderInfo[i].range[0].column[0] <= last.column[1]
        )
      ) {
        borderInfo.push(cfg.borderInfo[i]);
      }
    }

    cfg.borderInfo = borderInfo;
  }
  // 替换位置数据更新
  const offsetMC: Record<string, any> = {};
  for (let r = 0; r < data.length; r += 1) {
    for (let c = 0; c < data[0].length; c += 1) {
      if (
        borderInfoCompute[`${r + last.row[0]}_${c + last.column[0]}`] &&
        !borderInfoCompute[`${r + last.row[0]}_${c + last.column[0]}`].s
      ) {
        const bd_obj = {
          rangeType: 'cell',
          value: {
            row_index: r + row_s,
            col_index: c + col_s,
            l: borderInfoCompute[`${r + last.row[0]}_${c + last.column[0]}`].l,
            r: borderInfoCompute[`${r + last.row[0]}_${c + last.column[0]}`].r,
            t: borderInfoCompute[`${r + last.row[0]}_${c + last.column[0]}`].t,
            b: borderInfoCompute[`${r + last.row[0]}_${c + last.column[0]}`].b,
          },
        };

        if (cfg.borderInfo == null) {
          cfg.borderInfo = [];
        }

        cfg.borderInfo.push(bd_obj);
      } else if (
        borderInfoCompute[`${r + last.row[0]}_${c + last.column[0]}`]
      ) {
        const bd_obj = {
          rangeType: 'range',
          borderType: 'border-slash',
          color:
            borderInfoCompute[`${r + last.row[0]}_${c + last.column[0]}`].s
              .color!,
          style:
            borderInfoCompute[`${r + last.row[0]}_${c + last.column[0]}`].s
              .style!,
          range: normalizeSelection(ctx, [
            { row: [r + row_s, r + row_s], column: [c + col_s, c + col_s] },
          ]),
        };

        if (cfg.borderInfo == null) {
          cfg.borderInfo = [];
        }

        cfg.borderInfo.push(bd_obj);
      }

      let value = null;
      if (data[r] != null && data[r][c] != null) {
        value = data[r][c];
      }

      if (value?.mc != null) {
        const mc = _.assign({}, value.mc);
        if ('rs' in value.mc) {
          _.set(offsetMC, `${mc.r}_${mc.c}`, [r + row_s, c + col_s]);

          value.mc.r = r + row_s;
          value.mc.c = c + col_s;

          _.set(cfg.merge, `${r + row_s}_${c + col_s}`, value.mc);
        } else {
          _.set(value.mc, 'r', offsetMC[`${mc.r}_${mc.c}`][0]);
          _.set(value.mc, 'c', offsetMC[`${mc.r}_${mc.c}`][1]);
        }
      }
      d[r + row_s][c + col_s] = value;
      cellChanges.push({
        sheetId: ctx.currentSheetId,
        path: ['celldata'],
        value: { r: r + row_s, c: c + col_s, v: d[r + row_s][c + col_s] },
        key: `${r + row_s}_${c + col_s}`,
        type: 'update',
      });
      if (hyperLinkList?.[`${r + last.row[0]}_${c + last.column[0]}`]) {
        ctx.luckysheetfile[index].hyperlink![`${r + row_s}_${c + col_s}`] =
          hyperLinkList?.[`${r + last.row[0]}_${c + last.column[0]}`] as {
            linkType: string;
            linkAddress: string;
          };
      }
    }
  }

  // if (RowlChange) {
  //   cfg = rowlenByRange(d, last.row[0], last.row[1], cfg);
  //   cfg = rowlenByRange(d, row_s, row_e, cfg);
  // }
  // 条件格式：
  // 1) remove source coverage from original place
  // 2) clear destination coverage (so moved cells overwrite destination CF)
  // 3) append source-coverage mapped to destination
  const cdformat =
    ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId) as number]
      .luckysheet_conditionformat_save ?? [];
  if (cdformat != null && cdformat.length > 0) {
    const sourceRange = { row: last.row, column: last.column };
    const targetRange = { row: [row_s, row_e], column: [col_s, col_e] };

    for (let i = 0; i < cdformat.length; i += 1) {
      const ruleRanges = cdformat[i].cellrange ?? [];
      let keptRanges: any[] = [];
      let movedRanges: any[] = [];

      for (let j = 0; j < ruleRanges.length; j += 1) {
        const current = ruleRanges[j];
        movedRanges = movedRanges.concat(
          CFSplitRange(current, sourceRange, targetRange, 'operatePart'),
        );

        const sourceRest = CFSplitRange(
          current,
          sourceRange,
          targetRange,
          'restPart',
        );
        for (let k = 0; k < sourceRest.length; k += 1) {
          const rest = sourceRest[k];
          keptRanges = keptRanges.concat(
            CFSplitRange(rest, targetRange, targetRange, 'restPart'),
          );
        }
      }
      cdformat[i].cellrange = keptRanges.concat(movedRanges);
    }
  }

  let rf;
  if (
    ctx.luckysheet_select_save[0].row_focus ===
    ctx.luckysheet_select_save[0].row[0]
  ) {
    rf = row_s;
  } else {
    rf = row_e;
  }

  let cf;
  if (
    ctx.luckysheet_select_save[0].column_focus ===
    ctx.luckysheet_select_save[0].column[0]
  ) {
    cf = col_s;
  } else {
    cf = col_e;
  }

  const range = [];
  range.push({ row: last.row, column: last.column });
  range.push({ row: [row_s, row_e], column: [col_s, col_e] });

  const previousFormatRanges =
    file.config?.cellFormatRanges ?? cfg.cellFormatRanges;
  const nextFormatRanges = moveCellFormatRanges(
    previousFormatRanges,
    {
      row: [last.row[0], last.row[1]],
      column: [last.column[0], last.column[1]],
    },
    { row: [row_s, row_e], column: [col_s, col_e] },
  );
  if (!rangesEqual(previousFormatRanges, nextFormatRanges)) {
    cfg.cellFormatRanges = nextFormatRanges;
    cellChanges.push({
      sheetId: ctx.currentSheetId,
      path: ['config', 'cellFormatRanges'],
      value: nextFormatRanges,
      type: 'update',
    });
  }

  last.row = [row_s, row_e];
  last.column = [col_s, col_e];
  last.row_focus = rf;
  last.column_focus = cf;
  ctx.luckysheet_select_save = normalizeSelection(ctx, [last]);
  const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
  if (sheetIndex != null) {
    ctx.luckysheetfile[sheetIndex].config = _.assign({}, cfg);
  }

  if (cellChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
    ctx.hooks.updateCellYdoc(cellChanges);
  }

  // Keep formula references stable after moving cells: any formula token
  // pointing to the moved source rectangle is remapped to destination.
  const sourceRect = {
    rowStart: range[0].row[0],
    rowEnd: range[0].row[1],
    colStart: range[0].column[0],
    colEnd: range[0].column[1],
  };
  const targetRowStart = row_s;
  const targetColStart = col_s;
  const movedSheet = ctx.luckysheetfile[index];
  const movedSheetName = movedSheet?.name || '';
  const refCellChanges: typeof cellChanges = [];

  for (let si = 0; si < ctx.luckysheetfile.length; si += 1) {
    const sheet = ctx.luckysheetfile[si];
    const sheetData = sheet.data;
    if (!sheetData || !sheet.name) continue;

    for (let r = 0; r < sheetData.length; r += 1) {
      const rowData = sheetData[r];
      if (!rowData) continue;
      for (let c = 0; c < rowData.length; c += 1) {
        const cell = rowData[c];
        if (!cell?.f) continue;

        const nextF = `=${functionMoveReference(
          cell.f,
          sheet.name,
          movedSheetName,
          sourceRect,
          targetRowStart,
          targetColStart,
        )}`;

        if (nextF !== cell.f) {
          cell.f = nextF;
          refCellChanges.push({
            sheetId: sheet.id || ctx.currentSheetId,
            path: ['celldata'],
            value: { r, c, v: cell },
            key: `${r}_${c}`,
            type: 'update',
          });
        }
      }
    }
  }

  if (refCellChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
    ctx.hooks.updateCellYdoc(refCellChanges);
  }

  recalcMovedRowsAutoHeight(
    ctx,
    d,
    container,
    range[0].row[0],
    range[0].row[1],
    range[1].row[0],
    range[1].row[1],
  );
  updateContextWithSheetData(ctx, d);

  // const allParam = {
  //   cfg,
  //   RowlChange,
  //   cdformat,
  // };

  jfrefreshgrid(ctx, d, range);

  notifyCommentAnchorMove(ctx, {
    type: 'cells',
    sheetId: String(file?.id ?? ctx.currentSheetId),
    sheetKeys: getSheetCommentKeyPrefixes(file, index),
    source: {
      row: [range[0].row[0], range[0].row[1]],
      column: [range[0].column[0], range[0].column[1]],
    },
    target: {
      row: [range[1].row[0], range[1].row[1]],
      column: [range[1].column[0], range[1].column[1]],
    },
  });

  // selectHightlightShow();

  // $("#luckysheet-sheettable").css("cursor", "default");
  // clearTimeout(ctx.countfuncTimeout);
  // ctx.countfuncTimeout = setTimeout(function () {
  //   countfunc();
  // }, 500);
}
