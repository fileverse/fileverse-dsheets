import _, { isObject } from 'lodash';
import { Context, getFlowdata } from '../context';
import { execfunction } from '../modules/formula';
import { getdatabyselection } from '../modules/cell';
import { update, genarate } from '../modules/format';
import { normalizeSelection } from '../modules/selection';
import { Cell, CellMatrix, HyperlinkEntry } from '../types';
import { getSheetIndex, isAllowEdit } from '../utils';
import { ensureSheetFlowdata } from '../api/sheet';
import { hasPartMC, isRealNum } from '../modules/validation';
import { getBorderInfoCompute } from '../modules/border';
import { expandRowsAndColumns, storeSheetParamALL } from '../modules/sheet';
import { jfrefreshgrid } from '../modules/refresh';
import { CFSplitRange, saveHyperlink, spillSortResult } from '../modules';
import {
  calculateRangeCellSize,
  updateSheetCellSizes,
} from '../paste-helpers/calculate-range-cell-size';
import { scheduleSheetMetadataSyncHooks } from '../modules/sheet-metadata-hooks';
import { adjustFormulaForPaste } from './formula-adjust';
import { filterMeaningfulBorderSides } from './paste-border-utils';
import { shouldPersistCelldataCell } from '../utils/cell-persist-utils';
import {
  assignActiveConfigToSheetFile,
  syncFormatOnlyRectIntoRanges,
} from '../modules/sheet';

function pushPasteCelldataChange(
  changes: any[],
  ctx: Context,
  r: number,
  c: number,
  cell: Cell | null,
  /** True if this position held a persistable cell before the paste overwrite. */
  hadPersistedBefore = false,
) {
  if (shouldPersistCelldataCell(cell)) {
    changes.push({
      sheetId: ctx.currentSheetId,
      path: ['celldata'],
      value: { r, c, v: cell },
      key: `${r}_${c}`,
      type: 'update',
    });
    return;
  }
  // Empty / format-only paste: local grid is cleared, but Yjs still needs a
  // delete or peers/reload keep the pre-paste value under the new formatting.
  if (hadPersistedBefore) {
    changes.push({
      sheetId: ctx.currentSheetId,
      path: ['celldata'],
      key: `${r}_${c}`,
      value: null,
      type: 'delete',
    });
  }
}

/** Paste-rect only: migrate format-only empties → cellFormatRanges + ydoc change. */
function appendPasteFormatRangeMigration(
  ctx: Context,
  cfg: Context['config'],
  data: CellMatrix | null | undefined,
  r1: number,
  r2: number,
  c1: number,
  c2: number,
  changes: any[],
) {
  const ranges = syncFormatOnlyRectIntoRanges(ctx, cfg, data, r1, r2, c1, c2);
  if (!ranges) return;
  changes.push({
    sheetId: ctx.currentSheetId,
    path: ['config', 'cellFormatRanges'],
    value: ranges,
    type: 'update',
  });
}

function pushCellBorderToConfig(
  cfg: { borderInfo?: any[] },
  row: number,
  col: number,
  sides: { l?: unknown; r?: unknown; t?: unknown; b?: unknown },
) {
  const filtered = filterMeaningfulBorderSides(
    sides as {
      l?: { style?: number; color?: string };
      r?: { style?: number; color?: string };
      t?: { style?: number; color?: string };
      b?: { style?: number; color?: string };
    },
  );
  if (!filtered.l && !filtered.r && !filtered.t && !filtered.b) return;
  if (cfg.borderInfo == null) cfg.borderInfo = [];
  cfg.borderInfo.push({
    rangeType: 'cell',
    value: {
      row_index: row,
      col_index: col,
      l: filtered.l,
      r: filtered.r,
      t: filtered.t,
      b: filtered.b,
    },
  });
}

/** Deep-clone a cell for paste targets; avoids double-`cloneDeep` when assigning into the grid. */
function clonePasteCellValue(cell: any): any {
  if (cell == null || typeof cell !== 'object') {
    return cell;
  }
  try {
    return structuredClone(cell);
  } catch {
    return _.cloneDeep(cell);
  }
}

/** Snapshot copy buffer from grid (`getdatabyselection` returns live refs). */
function clonePasteMatrix(arr: CellMatrix): CellMatrix {
  if (arr.length === 0) {
    return arr;
  }
  // Avoid `structuredClone` on full matrices: large pastes with rich `ct`/inline
  // strings can block the main thread for a long time in some engines.
  return _.cloneDeep(arr);
}

function postPasteCut(
  ctx: Context,
  source: any,
  target: any,
  RowlChange: boolean,
) {
  // 单元格数据更新联动
  const execF_rc: any = {};
  ctx.formulaCache.execFunctionExist = [];
  // clearTimeout(refreshCanvasTimeOut);
  for (let r = source.range.row[0]; r <= source.range.row[1]; r += 1) {
    for (let c = source.range.column[0]; c <= source.range.column[1]; c += 1) {
      if (`${r}_${c}_${source.sheetId}` in execF_rc) {
        continue;
      }

      execF_rc[`${r}_${c}_${source.sheetId}`] = 0;
      ctx.formulaCache.execFunctionExist.push({ r, c, i: source.sheetId });
    }
  }

  for (let r = target.range.row[0]; r <= target.range.row[1]; r += 1) {
    for (let c = target.range.column[0]; c <= target.range.column[1]; c += 1) {
      if (`${r}_${c}_${target.sheetId}` in execF_rc) {
        continue;
      }

      execF_rc[`${r}_${c}_${target.sheetId}`] = 0;
      ctx.formulaCache.execFunctionExist.push({ r, c, i: target.sheetId });
    }
  }

  // config
  let rowHeight;
  if (ctx.currentSheetId === source.sheetId) {
    ctx.config = source.curConfig;
    rowHeight = source.curData.length;
    ctx.luckysheetfile[getSheetIndex(ctx, target.sheetId)!].config =
      target.curConfig;
  } else if (ctx.currentSheetId === target.sheetId) {
    ctx.config = target.curConfig;
    rowHeight = target.curData.length;
    ctx.luckysheetfile[getSheetIndex(ctx, source.sheetId)!].config =
      source.curConfig;
  }

  if (RowlChange) {
    ctx.visibledatarow = [];
    ctx.rh_height = 0;

    for (let i = 0; i < rowHeight; i += 1) {
      let rowlen = ctx.defaultrowlen;

      if (ctx.config.rowlen != null && ctx.config.rowlen[i] != null) {
        rowlen = ctx.config.rowlen[i];
      }

      if (ctx.config.rowhidden != null && ctx.config.rowhidden[i] != null) {
        rowlen = ctx.config.rowhidden[i];
        ctx.visibledatarow.push(ctx.rh_height);
        continue;
      } else {
        ctx.rh_height += rowlen + 1;
      }

      ctx.visibledatarow.push(ctx.rh_height); // 行的临时长度分布
    }
    ctx.rh_height += 80;
    // sheetmanage.showSheet();

    if (ctx.currentSheetId === source.sheetId) {
      // const rowlenArr = computeRowlenArr(
      //   ctx,
      //   target.curData.length,
      //   target.curConfig
      // );
      // ctx.luckysheetfile[
      //   getSheetIndex(ctx, target.sheetId)!
      // ].visibledatarow = rowlenArr;
    } else if (ctx.currentSheetId === target.sheetId) {
      // const rowlenArr = computeRowlenArr(
      //   ctx,
      //   source.curData.length,
      //   source.curConfig
      // );
      // ctx.luckysheetfile[getSheetIndex(ctx, source.sheetId)].visibledatarow =
      //   rowlenArr;
    }
  }

  // ctx.flowdata
  if (ctx.currentSheetId === source.sheetId) {
    // ctx.flowdata = source.curData;
    ctx.luckysheetfile[getSheetIndex(ctx, target.sheetId)!].data =
      target.curData;
  } else if (ctx.currentSheetId === target.sheetId) {
    // ctx.flowdata = target.curData;
    ctx.luckysheetfile[getSheetIndex(ctx, source.sheetId)!].data =
      source.curData;
  }
  // editor.webWorkerFlowDataCache(ctx.flowdata); // worker存数据
  // ctx.luckysheetfile[getSheetIndex(ctx.currentSheetId)].data = ctx.flowdata;

  // luckysheet_select_save
  if (ctx.currentSheetId === target.sheetId) {
    ctx.luckysheet_select_save = [
      { row: target.range.row, column: target.range.column },
    ];
  } else {
    ctx.luckysheet_select_save = [
      { row: source.range.row, column: source.range.column },
    ];
  }
  if (ctx.luckysheet_select_save.length > 0) {
    // 有选区时，刷新一下选区
    // selectHightlightShow();
  }
  // 条件格式
  ctx.luckysheetfile[
    getSheetIndex(ctx, source.sheetId)!
  ].luckysheet_conditionformat_save = source.curCdformat;
  ctx.luckysheetfile[
    getSheetIndex(ctx, target.sheetId)!
  ].luckysheet_conditionformat_save = target.curCdformat;

  // 数据验证
  // if (ctx.currentSheetId === source.sheetId) {
  //   dataVerificationCtrl.dataVerification = source.curDataVerification;
  // } else if (ctx.currentSheetId === target.sheetId) {
  //   dataVerificationCtrl.dataVerification = target.curDataVerification;
  // }
  ctx.luckysheetfile[getSheetIndex(ctx, source.sheetId)!].dataVerification =
    source.curDataVerification;
  ctx.luckysheetfile[getSheetIndex(ctx, target.sheetId)!].dataVerification =
    target.curDataVerification;

  ctx.formulaCache.execFunctionExist.reverse();
  // @ts-ignore
  // execFunctionGroup(ctx, null, null, null, null, target.curData);
  ctx.formulaCache.execFunctionGlobalData = null;

  // const index = getSheetIndex(ctx, ctx.currentSheetId);
  // const file = ctx.luckysheetfile[index];
  // file.scrollTop = $("#luckysheet-cell-main").scrollTop();
  // file.scrollLeft = $("#luckysheet-cell-main").scrollLeft();

  // showSheet();

  // refreshCanvasTimeOut = setTimeout(function () {
  //   luckysheetrefreshgrid();
  // }, 1);

  storeSheetParamALL(ctx);

  // saveparam
  // //来源表
  // server.saveParam("all", source["sheetId"], source["curConfig"], {
  //   k: "config",
  // });
  // //目的表
  // server.saveParam("all", target["sheetId"], target["curConfig"], {
  //   k: "config",
  // });

  // //来源表
  // server.historyParam(source["curData"], source["sheetId"], {
  //   row: source["range"]["row"],
  //   column: source["range"]["column"],
  // });
  // //目的表
  // server.historyParam(target["curData"], target["sheetId"], {
  //   row: target["range"]["row"],
  //   column: target["range"]["column"],
  // });

  // //来源表
  // server.saveParam("all", source["sheetId"], source["curCdformat"], {
  //   k: "luckysheet_conditionformat_save",
  // });
  // //目的表
  // server.saveParam("all", target["sheetId"], target["curCdformat"], {
  //   k: "luckysheet_conditionformat_save",
  // });

  // //来源表
  // server.saveParam("all", source["sheetId"], source["curDataVerification"], {
  //   k: "dataVerification",
  // });
  // //目的表
  // server.saveParam("all", target["sheetId"], target["curDataVerification"], {
  //   k: "dataVerification",
  // });

  scheduleSheetMetadataSyncHooks(ctx);
}

const handleFormulaOnPaste = (ctx: Context, d: any) => {
  const changes: any = [];
  for (let r = 0; r < d.length; r += 1) {
    const x = d[r];
    for (let c = 0; c < d[0].length; c += 1) {
      const value = isObject(d[r][c]) ? d[r][c]?.v : d[r][c];
      if (value && String(value).startsWith('=')) {
        const cell: Cell = {};
        const [, v, f] = execfunction(
          ctx,
          String(value),
          r,
          c,
          undefined,
          undefined,
          true,
        );

        cell.v = v;
        cell.f = f;
        cell.m = v.toString();
        x[c] = cell;

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
      d[r] = x;
    }
  }
  if (ctx?.hooks?.updateCellYdoc) {
    ctx.hooks?.updateCellYdoc(changes);
  }
};

export function pasteHandler(ctx: Context, data: any, borderInfo?: any) {
  const normalizeDecimalStringOnPaste = (input: string): string => {
    const trimmed = input.trim();
    if (!/^[+-]?\d+\.\d+$/.test(trimmed)) return input;
    return trimmed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  };

  if (ctx.luckysheet_selection_range) {
    ctx.luckysheet_selection_range = [];
  }
  // if (
  //   !checkProtectionLockedRangeList(
  //     ctx.luckysheet_select_save,
  //     ctx.currentSheetId
  //   )
  // ) {
  //   return;
  // }
  const allowEdit = isAllowEdit(ctx);
  if (!allowEdit || ctx.isFlvReadOnly) return;

  if ((ctx.luckysheet_select_save?.length ?? 0) !== 1) {
    // if (isEditMode()) {
    //   alert("不能对多重选择区域执行此操作，请选择单个区域，然后再试");
    // } else {
    //   tooltip.info(
    //     '<i class="fa fa-exclamation-triangle"></i>提示',
    //     "不能对多重选择区域执行此操作，请选择单个区域，然后再试"
    //   );
    // }
    return;
  }

  if (typeof data === 'object') {
    if (data.length === 0) {
      return;
    }

    const cfg = ctx.config || {};
    if (cfg.merge == null) {
      cfg.merge = {};
    }

    if (JSON.stringify(borderInfo).length > 2 && cfg.borderInfo == null) {
      cfg.borderInfo = [];
    }

    const copyh = data.length;
    const copyc = data[0].length;

    const minh = ctx.luckysheet_select_save![0].row[0]; // 应用范围首尾行
    const maxh = minh + copyh - 1;
    const minc = ctx.luckysheet_select_save![0].column[0]; // 应用范围首尾列
    const maxc = minc + copyc - 1;

    // 应用范围包含部分合并单元格，则return提示
    let has_PartMC = false;
    if (cfg.merge != null) {
      has_PartMC = hasPartMC(ctx, cfg, minh, maxh, minc, maxc);
    }

    if (has_PartMC) {
      // if (isEditMode()) {
      //   alert("不能对合并单元格做部分更改");
      // } else {
      //   tooltip.info(
      //     '<i class="fa fa-exclamation-triangle"></i>提示',
      //     "不能对合并单元格做部分更改"
      //   );
      // }
      return;
    }

    const d = getFlowdata(ctx); // 取数据
    if (!d) return;

    const rowMaxLength = d.length;
    const cellMaxLength = d[0].length;

    // 若应用范围超过最大行或最大列，增加行列
    const addr = maxh - rowMaxLength + 1;
    const addc = maxc - cellMaxLength + 1;
    if (addr > 0 || addc > 0) {
      expandRowsAndColumns(d, addr, addc);
    }
    if (!d) return;

    if (cfg.rowlen == null) {
      cfg.rowlen = {};
    }

    const RowlChange = false;
    const offsetMC: any = {};
    const changes: any = [];
    for (let h = minh; h <= maxh; h += 1) {
      const x = d[h];

      let currentRowLen = ctx.defaultrowlen;
      if (cfg.rowlen[h] != null) {
        currentRowLen = cfg.rowlen[h];
      }

      for (let c = minc; c <= maxc; c += 1) {
        if (x?.[c]?.mc) {
          if ('rs' in x[c]!.mc!) {
            delete cfg.merge[`${x[c]!.mc!.r}_${x[c]!.mc!.c}`];
          }
          delete x![c]!.mc;
        }

        let value = null;
        if (data[h - minh] != null && data[h - minh][c - minc] != null) {
          value = data[h - minh][c - minc];
        }

        // Normalize pasted object/table values as dates too (HTML paste can bypass
        // the plain-text date path). This keeps direct paste behavior aligned with
        // typing/InputBox detection.
        if (typeof value === 'string') {
          const generated = genarate(value);
          if (generated?.[1]?.t === 'd') {
            const [m, ct, v] = generated;
            value = {
              v,
              m: m != null ? String(m) : value,
              ct,
              tb: '1',
            };
          }
        } else if (
          value &&
          typeof value === 'object' &&
          !isObject(value.v) &&
          typeof value.v === 'string'
        ) {
          const generated = genarate(value.v);
          if (generated?.[1]?.t === 'd') {
            const [m, ct, v] = generated;
            value = {
              ...value,
              v,
              m: m != null ? String(m) : value.v,
              ct,
            };
          }
        }

        const hadPersistedBefore = shouldPersistCelldataCell(x[c]);
        x[c] = value;

        if (value != null && x?.[c]?.mc) {
          if (x![c]!.mc!.rs != null) {
            x![c]!.mc!.r = h;
            x![c]!.mc!.c = c;

            // @ts-ignore
            cfg.merge[`${x[c]!.mc!.r}_${x[c]!.mc!.c}`] = x[c]!.mc!;

            offsetMC[`${value.mc.r}_${value.mc.c}`] = [
              x[c]!.mc!.r,
              x[c]!.mc!.c,
            ];
          } else {
            x[c] = {
              mc: {
                r: offsetMC[`${value.mc.r}_${value.mc.c}`][0],
                c: offsetMC[`${value.mc.r}_${value.mc.c}`][1],
              },
            };
          }
        }

        if (borderInfo[`${h - minh}_${c - minc}`]) {
          const sides = filterMeaningfulBorderSides(
            borderInfo[`${h - minh}_${c - minc}`],
          );
          if (sides.l || sides.r || sides.t || sides.b) {
            const bd_obj = {
              rangeType: 'cell',
              value: {
                row_index: h,
                col_index: c,
                l: sides.l,
                r: sides.r,
                t: sides.t,
                b: sides.b,
              },
            };

            cfg.borderInfo?.push(bd_obj);
          }
        }

        // const fontset = luckysheetfontformat(x[c]);
        // const oneLineTextHeight = menuButton.getTextSize("田", fontset)[1];
        // // 比较计算高度和当前高度取最大高度
        // if (oneLineTextHeight > currentRowLen) {
        //   currentRowLen = oneLineTextHeight;
        //   RowlChange = true;
        // }

        pushPasteCelldataChange(
          changes,
          ctx,
          h,
          c,
          d[h][c],
          hadPersistedBefore,
        );
      }
      d[h] = x;

      if (currentRowLen !== ctx.defaultrowlen) {
        cfg.rowlen[h] = currentRowLen;
      } else if (cfg.rowlen?.[h] != null) {
        delete cfg.rowlen[h];
      }
    }
    appendPasteFormatRangeMigration(
      ctx,
      cfg,
      d,
      minh,
      maxh,
      minc,
      maxc,
      changes,
    );
    if (ctx?.hooks?.updateCellYdoc) {
      ctx.hooks?.updateCellYdoc(changes);
    }

    ctx.luckysheet_select_save = [{ row: [minh, maxh], column: [minc, maxc] }];

    const pasteSheetIdx = getSheetIndex(ctx, ctx.currentSheetId)!;
    assignActiveConfigToSheetFile(ctx.luckysheetfile[pasteSheetIdx], cfg);
    ctx.config = ctx.luckysheetfile[pasteSheetIdx].config!;
    jfrefreshgrid(ctx, null, undefined);
    if (data.includes('=')) {
      handleFormulaOnPaste(ctx, d);
    }
    // for (let r = 0; r < d.length; r += 1) {
    //   const x = d[r];
    //   for (let c = 0; c < d[0].length; c += 1) {
    //     let value = isObject(d[r][c]) ? d[r][c]?.v : d[r][c];
    //     if (value && String(value).includes('=')) {
    //       const cell: Cell = {};
    //       const funcV = execfunction(ctx, String(value), r, c, undefined, undefined, true);
    //       console.log(funcV)
    //       cell.v = funcV[1];
    //       cell.f = funcV[2];
    //       cell.m = funcV[1].toString();
    //       x[c] = cell;
    //     }
    //     d[r] = x;
    //   }
    // }
  } else {
    data = data.replace(/\r/g, '');
    const dataChe: any[][] = [];

    // Detect a CSV-quoted single-cell multiline value written by fortune-sheet's
    // clipboard writer: `"line1\nline2"`.  The quotes were added solely to make
    // Excel treat the newlines as in-cell line breaks; they must NOT cause the
    // value to be split across rows or show literal " characters.
    // Only treat as a single quoted value when the content contains \n (the
    // wrapping reason) and has no \t (which would indicate multi-column data).
    if (data.startsWith('"') && data.endsWith('"') && data.length > 1) {
      const inner = data.slice(1, -1);
      if (inner.includes('\n') && !inner.includes('\t')) {
        dataChe.push([inner.replace(/""/g, '"')]);
      }
    }

    if (dataChe.length === 0) {
      const che = data.split('\n');
      const colchelen = che[0].split('\t').length;

      for (let i = 0; i < che.length; i += 1) {
        if (che[i].split('\t').length < colchelen) {
          continue;
        }
        dataChe.push(che[i].split('\t'));
      }
    }

    const d = getFlowdata(ctx); // 取数据
    if (!d) return;

    const last =
      ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
    if (!last) return;

    const curR = last.row == null ? 0 : last.row[0];
    const curC = last.column == null ? 0 : last.column[0];
    const rlen = dataChe.length;
    const clen = dataChe[0].length;

    // 应用范围包含部分合并单元格，则return提示
    let has_PartMC = false;
    if (ctx.config.merge != null) {
      has_PartMC = hasPartMC(
        ctx,
        ctx.config,
        curR,
        curR + rlen - 1,
        curC,
        curC + clen - 1,
      );
    }

    if (has_PartMC) {
      // if (isEditMode()) {
      //   alert("不能对合并单元格做部分更改");
      // } else {
      //   tooltip.info(
      //     '<i class="fa fa-exclamation-triangle"></i>提示',
      //     "不能对合并单元格做部分更改"
      //   );
      // }
      return;
    }

    const addr = curR + rlen - d.length;
    const addc = curC + clen - d[0].length;
    if (addr > 0 || addc > 0) {
      expandRowsAndColumns(d, addr, addc);
    }
    if (!d) return;

    // Helper function to detect and normalize URLs
    const getUrlFromText = (text: string): string | null => {
      const t = String(text).trim();
      // only treat a single token as a URL (no spaces/newlines)
      if (!t || /[\s\r\n]/.test(t)) return null;
      if (!/^(https?:\/\/|www\.)\S+$/i.test(t)) return null;
      return t.startsWith('http') ? t : `https://${t}`;
    };

    const applyMultilineTextToCell = (cell: Cell, text: string) => {
      const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const inlineStringSegment: Record<string, any> = { v: normalizedText };

      ['fs', 'fc', 'ff', 'bl', 'it', 'un', 'cl'].forEach((key) => {
        const typedKey = key as keyof Cell;
        const currentValue = cell[typedKey];
        if (currentValue != null) {
          inlineStringSegment[typedKey] = currentValue;
        }
      });

      cell.v = normalizedText;
      cell.m = normalizedText;
      cell.ct = {
        fa: cell.ct?.fa === '@' ? '@' : 'General',
        t: 'inlineStr',
        s: [inlineStringSegment],
      } as any;
      cell.tb = '2';
    };

    const changes: any = [];
    for (let r = 0; r < rlen; r += 1) {
      const x = d[r + curR];
      for (let c = 0; c < clen; c += 1) {
        const originCell = x[c + curC];
        const hadPersistedBefore = shouldPersistCelldataCell(originCell);
        let value = dataChe[r][c];
        const originalValueStr = String(value);
        const normalizedValueStr = originalValueStr
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n');
        const isMultilineValue = normalizedValueStr.includes('\n');

        // Check if the value is a URL first - if so, keep it as string and skip number conversion
        const url = getUrlFromText(normalizedValueStr);
        const isUrl = url !== null;

        const normalizedNumericValueStr =
          !isUrl && !isMultilineValue && isRealNum(value)
            ? normalizeDecimalStringOnPaste(normalizedValueStr)
            : normalizedValueStr;
        const generatedDateValue =
          !isUrl && !isMultilineValue ? genarate(normalizedValueStr) : null;
        const isGeneratedDate = generatedDateValue?.[1]?.t === 'd';

        if (!isUrl && !isMultilineValue && isRealNum(value)) {
          // 如果单元格设置了纯文本格式，那么就不要转成数值类型了，防止数值过大自动转成科学计数法
          if (originCell && originCell.ct && originCell.ct.fa === '@') {
            value = normalizedNumericValueStr;
          } else if (!/^0x?[a-fA-F0-9]+$/.test(value)) {
            value = parseFloat(normalizedNumericValueStr);
          }
        }

        if (originCell) {
          if (!isUrl && isMultilineValue) {
            applyMultilineTextToCell(originCell, normalizedValueStr);
          } else if (isGeneratedDate) {
            const [genM, genCt, genV] = generatedDateValue!;
            originCell.v = genV;
            originCell.m = genM ?? normalizedValueStr;
            originCell.ct = genCt;
          } else if (!isUrl) {
            const generated = genarate(normalizedNumericValueStr);
            if (generated) {
              const [genM, genCt, genV] = generated;
              if (genCt?.t === 'd') {
                // Pasted value is a date — always update ct so toolbar shows "Date"
                originCell.v = genV;
                originCell.m = genM ?? normalizedNumericValueStr;
                originCell.ct = genCt;
              } else {
                // Not a date: preserve destination format, just update value
                originCell.v = value;
                if (originCell.ct != null && originCell.ct.fa != null) {
                  if (
                    originCell.ct.t === 'd' &&
                    typeof originCell.v !== 'number'
                  ) {
                    originCell.m = String(originCell.v);
                  } else {
                    originCell.m = update(originCell.ct.fa, originCell.v);
                  }
                } else {
                  originCell.m =
                    typeof originCell.v === 'boolean'
                      ? String(originCell.v)
                      : originCell.v;
                }
              }
            } else {
              originCell.v = value;
              if (originCell.ct != null && originCell.ct.fa != null) {
                originCell.m = update(originCell.ct.fa, originCell.v);
              } else {
                originCell.m =
                  typeof originCell.v === 'boolean'
                    ? String(originCell.v)
                    : originCell.v;
              }
            }
          } else {
            originCell.v = originalValueStr;
            originCell.m = originalValueStr;
          }

          if (originCell.f != null && originCell.f.length > 0) {
            originCell.f = '';
            // delFunctionGroup(ctx, r + curR, c + curC, ctx.currentSheetId);
          }

          // Create hyperlink if URL detected
          if (isUrl && url) {
            const targetRow = r + curR;
            const targetCol = c + curC;
            saveHyperlink(
              ctx,
              targetRow,
              targetCol,
              url,
              'webpage',
              originalValueStr,
            );
            // Set hyperlink marker and styling
            originCell.hl = {
              r: targetRow,
              c: targetCol,
              id: ctx.currentSheetId,
            };
            originCell.fc = originCell.fc || 'rgb(0, 0, 255)';
            originCell.un = originCell.un !== undefined ? originCell.un : 1;
          }
        } else {
          const cell: Cell = {};

          // If it's a URL, keep it as string
          if (isUrl) {
            cell.v = originalValueStr;
            cell.m = originalValueStr;
            cell.ct = {
              fa: '@',
              t: 's',
            };
          } else if (isMultilineValue) {
            applyMultilineTextToCell(cell, normalizedValueStr);
          } else if (isGeneratedDate) {
            const [genM, genCt, genV] = generatedDateValue!;
            cell.v = genV;
            cell.m = genM != null ? String(genM) : normalizedValueStr;
            cell.ct = genCt;
          } else {
            // check if hex value to handle hex address
            if (/^0x?[a-fA-F0-9]+$/.test(value)) {
              cell.v = value;
              cell.m = value;
              cell.ct = { fa: '@', t: 's' };
            } else {
              const [m, ct, v] = genarate(normalizedNumericValueStr) ?? [];
              cell.v = v ?? normalizedNumericValueStr;
              cell.m = m != null ? String(m) : normalizedNumericValueStr;
              if (ct?.t === 'n') {
                cell.ct = { fa: 'General', t: 'g' };
              } else {
                cell.ct = ct ?? { fa: 'General', t: 'g' };
              }
            }
          }

          // Create hyperlink if URL detected
          if (isUrl && url) {
            const targetRow = r + curR;
            const targetCol = c + curC;
            saveHyperlink(
              ctx,
              targetRow,
              targetCol,
              url,
              'webpage',
              originalValueStr,
            );
            // Set hyperlink marker and styling
            cell.hl = { r: targetRow, c: targetCol, id: ctx.currentSheetId };
            cell.fc = cell.fc || 'rgb(0, 0, 255)';
            cell.un = cell.un !== undefined ? cell.un : 1;
          }

          if (cell.tb == null) {
            cell.tb = '1'; // overflow
          }
          x[c + curC] = cell;
        }
        pushPasteCelldataChange(
          changes,
          ctx,
          r + curR,
          c + curC,
          d[r + curR][c + curC],
          hadPersistedBefore,
        );
      }
      d[r + curR] = x;
    }

    if (ctx?.hooks?.updateCellYdoc) {
      ctx.hooks?.updateCellYdoc(changes);
    }

    last.row = [curR, curR + rlen - 1];
    last.column = [curC, curC + clen - 1];

    // if (addr > 0 || addc > 0) {
    //   const allParam = {
    //     RowlChange: true,
    //   };
    //   jfrefreshgrid(d, ctx.luckysheet_select_save, allParam);
    // } else {
    //   jfrefreshgrid(d, ctx.luckysheet_select_save);
    //   selectHightlightShow();
    // }
    jfrefreshgrid(ctx, null, undefined);
    if (data.includes('=')) {
      handleFormulaOnPaste(ctx, d);
    }

    // for (let r = 0; r < d.length; r += 1) {
    //   const x = d[r];
    //   for (let c = 0; c < d[0].length; c += 1) {
    //     let value = isObject(d[r][c]) ? d[r][c]?.v : d[r][c];
    //     if (value && String(value).includes('=')) {
    //       const cell: Cell = {};
    //       const funcV = execfunction(ctx, String(value), r, c, undefined, undefined, true);
    //       cell.v = funcV[1];
    //       cell.f = funcV[2];
    //       cell.m = funcV[1].toString();
    //       x[c] = cell;
    //     }
    //     d[r] = x;
    //   }
    // }
  }
}

function setCellHyperlink(
  ctx: Context,
  id: string,
  r: number,
  c: number,
  link: HyperlinkEntry | HyperlinkEntry[],
) {
  const index = getSheetIndex(ctx, id) as number;
  if (!ctx.luckysheetfile[index].hyperlink) {
    ctx.luckysheetfile[index].hyperlink = {};
  }
  ctx.luckysheetfile[index]!.hyperlink![`${r}_${c}`] = link;
}

export function pasteHandlerOfCutPaste(
  ctx: Context,
  copyRange: Context['luckysheet_copy_save'],
) {
  // if (
  //   !checkProtectionLockedRangeList(
  //     ctx.luckysheet_select_save,
  //     ctx.currentSheetId
  //   )
  // ) {
  //   return;
  // }
  const allowEdit = isAllowEdit(ctx);
  if (!allowEdit || ctx.isFlvReadOnly) return;

  if (!copyRange) return;

  const cfg = ctx.config || {};
  if (cfg.merge == null) {
    cfg.merge = {};
  }

  // 复制范围
  const copyHasMC = copyRange.HasMC;
  const copyRowlChange = copyRange.RowlChange;
  const copySheetId = copyRange.dataSheetId;

  const c_r1 = copyRange.copyRange[0].row[0];
  const c_r2 = copyRange.copyRange[0].row[1];
  const c_c1 = copyRange.copyRange[0].column[0];
  const c_c2 = copyRange.copyRange[0].column[1];

  const copyData = _.cloneDeep(
    getdatabyselection(
      ctx,
      { row: [c_r1, c_r2], column: [c_c1, c_c2] },
      copySheetId,
    ),
  );

  const copyh = copyData.length;
  const copyc = copyData[0].length;

  // 应用范围
  const last =
    ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
  if (!last || last.row_focus == null || last.column_focus == null) return;

  const minh = last.row_focus;
  const maxh = minh + copyh - 1; // 应用范围首尾行
  const minc = last.column_focus;
  const maxc = minc + copyc - 1; // 应用范围首尾列

  // 应用范围包含部分合并单元格，则提示
  let has_PartMC = false;
  if (cfg.merge != null) {
    has_PartMC = hasPartMC(ctx, cfg, minh, maxh, minc, maxc);
  }

  if (has_PartMC) {
    // if (isEditMode()) {
    //   alert("不能对合并单元格做部分更改");
    // } else {
    //   tooltip.info(
    //     '<i class="fa fa-exclamation-triangle"></i>提示',
    //     "不能对合并单元格做部分更改"
    //   );
    // }
    return;
  }

  const d = getFlowdata(ctx); // 取数据
  if (!d) return;
  const rowMaxLength = d.length;
  const cellMaxLength = d[0].length;

  const addr = copyh + minh - rowMaxLength;
  const addc = copyc + minc - cellMaxLength;
  if (addr > 0 || addc > 0) {
    expandRowsAndColumns(d, addr, addc);
  }

  const changes: {
    sheetId: string;
    path: string[];
    value: any;
    key: string;
    type: 'update' | 'delete';
  }[] = [];

  const borderInfoCompute = getBorderInfoCompute(ctx, copySheetId);
  const c_dataVerification =
    _.cloneDeep(
      ctx.luckysheetfile[getSheetIndex(ctx, copySheetId)!].dataVerification,
    ) || {};
  const dataVerification =
    _.cloneDeep(
      ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!]
        .dataVerification,
    ) || {};

  // 若选区内包含超链接（目标坐标在 currentSheetId 上，registry 必须写在当前表）
  if (ctx.luckysheet_copy_save?.copyRange?.length === 1) {
    _.forEach(ctx.luckysheet_copy_save?.copyRange, (range) => {
      const srcIndex = getSheetIndex(
        ctx,
        ctx.luckysheet_copy_save?.dataSheetId as string,
      ) as number;

      for (let r = 0; r <= range.row[1] - range.row[0]; r += 1) {
        for (let c = 0; c <= range.column[1] - range.column[0]; c += 1) {
          const srcRow = r + range.row[0];
          const srcCol = c + range.column[0];

          const srcLink =
            ctx.luckysheetfile[srcIndex].hyperlink?.[`${srcRow}_${srcCol}`];
          if (!srcLink) continue;

          const targetR = r + ctx.luckysheet_select_save![0].row[0];
          const targetC = c + ctx.luckysheet_select_save![0].column[0];

          setCellHyperlink(ctx, ctx.currentSheetId, targetR, targetC, srcLink);
        }
      }
    });
  }

  // 剪切粘贴在当前表操作，删除剪切范围内数据、合并单元格、数据验证和超链接
  if (ctx.currentSheetId === copySheetId) {
    for (let i = c_r1; i <= c_r2; i += 1) {
      for (let j = c_c1; j <= c_c2; j += 1) {
        const cell = d[i][j];

        if (cell && _.isPlainObject(cell) && 'mc' in cell) {
          if (cell.mc?.rs != null) {
            delete cfg.merge[`${cell.mc.r}_${cell.mc.c}`];
          }
          delete cell.mc;
        }

        d[i][j] = null;
        changes.push({
          sheetId: ctx.currentSheetId,
          path: ['celldata'],
          key: `${i}_${j}`,
          value: null,
          type: 'delete',
        });

        delete dataVerification[`${i}_${j}`];

        delete ctx.luckysheetfile[
          getSheetIndex(ctx, ctx.currentSheetId) as number
        ].hyperlink?.[`${i}_${j}`];
      }
    }

    // 边框
    if (cfg.borderInfo && cfg.borderInfo.length > 0) {
      const source_borderInfo = [];

      for (let i = 0; i < cfg.borderInfo.length; i += 1) {
        const bd_rangeType = cfg.borderInfo[i].rangeType;

        if (bd_rangeType === 'range') {
          const bd_range = cfg.borderInfo[i].range;
          let bd_emptyRange: any = [];

          for (let j = 0; j < bd_range.length; j += 1) {
            bd_emptyRange = bd_emptyRange.concat(
              CFSplitRange(
                bd_range[j],
                { row: [c_r1, c_r2], column: [c_c1, c_c2] },
                { row: [minh, maxh], column: [minc, maxc] },
                'restPart',
              ),
            );
          }

          cfg.borderInfo[i].range = bd_emptyRange;

          source_borderInfo.push(cfg.borderInfo[i]);
        } else if (bd_rangeType === 'cell') {
          const bd_r = cfg.borderInfo[i].value.row_index;
          const bd_c = cfg.borderInfo[i].value.col_index;

          if (!(bd_r >= c_r1 && bd_r <= c_r2 && bd_c >= c_c1 && bd_c <= c_c2)) {
            source_borderInfo.push(cfg.borderInfo[i]);
          }
        }
      }

      cfg.borderInfo = source_borderInfo;
    }
  }

  const offsetMC: any = {};
  for (let h = minh; h <= maxh; h += 1) {
    const x = d[h];

    for (let c = minc; c <= maxc; c += 1) {
      if (
        borderInfoCompute[`${c_r1 + h - minh}_${c_c1 + c - minc}`] &&
        !borderInfoCompute[`${c_r1 + h - minh}_${c_c1 + c - minc}`].s
      ) {
        pushCellBorderToConfig(
          cfg,
          h,
          c,
          borderInfoCompute[`${c_r1 + h - minh}_${c_c1 + c - minc}`],
        );
      } else if (borderInfoCompute[`${c_r1 + h - minh}_${c_c1 + c - minc}`]?.s) {
        const bd_obj = {
          rangeType: 'range',
          borderType: 'border-slash',
          color:
            borderInfoCompute[`${c_r1 + h - minh}_${c_c1 + c - minc}`].s.color!,
          style:
            borderInfoCompute[`${c_r1 + h - minh}_${c_c1 + c - minc}`].s.style!,
          range: normalizeSelection(ctx, [{ row: [h, h], column: [c, c] }]),
        };

        if (cfg.borderInfo == null) {
          cfg.borderInfo = [];
        }

        cfg.borderInfo.push(bd_obj);
      }

      // 数据验证 剪切
      if (c_dataVerification[`${c_r1 + h - minh}_${c_c1 + c - minc}`]) {
        dataVerification[`${h}_${c}`] =
          c_dataVerification[`${c_r1 + h - minh}_${c_c1 + c - minc}`];
      }

      if (x[c]?.mc) {
        if (x[c]?.mc?.rs != null) {
          delete cfg.merge[`${x[c]!.mc!.r}_${x[c]!.mc!.c}`];
        }
        delete x[c]!.mc;
      }

      let value = null;
      if (copyData[h - minh] != null && copyData[h - minh][c - minc] != null) {
        value = copyData[h - minh][c - minc];
      }

      const hadPersistedBefore = shouldPersistCelldataCell(x[c]);
      x[c] = _.cloneDeep(value);
      pushPasteCelldataChange(
        changes,
        ctx,
        h,
        c,
        d[h][c],
        hadPersistedBefore,
      );

      if (value != null && copyHasMC && x[c]?.mc) {
        if (x[c]!.mc!.rs != null) {
          x[c]!.mc!.r = h;
          x[c]!.mc!.c = c;

          // @ts-ignore
          cfg.merge[`${x[c]!.mc!.r}_${x[c]!.mc!.c}`] = x[c]!.mc!;

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
    }

    d[h] = x;
  }

  last.row = [minh, maxh];
  last.column = [minc, maxc];

  appendPasteFormatRangeMigration(
    ctx,
    cfg,
    d,
    minh,
    maxh,
    minc,
    maxc,
    changes,
  );
  if (changes.length > 0 && ctx?.hooks?.updateCellYdoc) {
    ctx.hooks.updateCellYdoc(changes);
  }

  // 若有行高改变，重新计算行高改变
  if (copyRowlChange) {
    // if (ctx.currentSheetId !== copySheetIndex) {
    //   cfg = rowlenByRange(d, minh, maxh, cfg);
    // } else {
    //   cfg = rowlenByRange(d, c_r1, c_r2, cfg);
    //   cfg = rowlenByRange(d, minh, maxh, cfg);
    // }
  }

  let source;
  let target;
  if (ctx.currentSheetId !== copySheetId) {
    // 跨表操作 — source tab may be demoted to celldata after switch
    const sourceData = _.cloneDeep(
      ensureSheetFlowdata(ctx, { id: copySheetId })!,
    );
    const sourceConfig = _.cloneDeep(
      ctx.luckysheetfile[getSheetIndex(ctx, copySheetId)!].config,
    );

    const sourceCurData = _.cloneDeep(sourceData);
    const sourceCurConfig = _.cloneDeep(sourceConfig) || {};
    if (sourceCurConfig.merge == null) {
      sourceCurConfig.merge = {};
    }

    for (let source_r = c_r1; source_r <= c_r2; source_r += 1) {
      for (let source_c = c_c1; source_c <= c_c2; source_c += 1) {
        const cell = sourceCurData[source_r][source_c];

        if (cell?.mc) {
          if ('rs' in cell.mc) {
            delete sourceCurConfig.merge[`${cell.mc.r}_${cell.mc.c}`];
          }
          delete cell.mc;
        }
        sourceCurData[source_r][source_c] = null;
      }
    }

    if (copyRowlChange) {
      // sourceCurConfig = rowlenByRange(
      //   sourceCurData,
      //   c_r1,
      //   c_r2,
      //   sourceCurConfig
      // );
    }

    // 边框
    if (sourceCurConfig.borderInfo && sourceCurConfig.borderInfo.length > 0) {
      const source_borderInfo = [];

      for (let i = 0; i < sourceCurConfig.borderInfo.length; i += 1) {
        const bd_rangeType = sourceCurConfig.borderInfo[i].rangeType;

        if (bd_rangeType === 'range') {
          const bd_range = sourceCurConfig.borderInfo[i].range;
          let bd_emptyRange: any = [];

          for (let j = 0; j < bd_range.length; j += 1) {
            bd_emptyRange = bd_emptyRange.concat(
              CFSplitRange(
                bd_range[j],
                { row: [c_r1, c_r2], column: [c_c1, c_c2] },
                { row: [minh, maxh], column: [minc, maxc] },
                'restPart',
              ),
            );
          }

          sourceCurConfig.borderInfo[i].range = bd_emptyRange;

          source_borderInfo.push(sourceCurConfig.borderInfo[i]);
        } else if (bd_rangeType === 'cell') {
          const bd_r = sourceCurConfig.borderInfo[i].value.row_index;
          const bd_c = sourceCurConfig.borderInfo[i].value.col_index;

          if (!(bd_r >= c_r1 && bd_r <= c_r2 && bd_c >= c_c1 && bd_c <= c_c2)) {
            source_borderInfo.push(sourceCurConfig.borderInfo[i]);
          }
        }
      }

      sourceCurConfig.borderInfo = source_borderInfo;
    }

    // 条件格式
    const source_cdformat = _.cloneDeep(
      ctx.luckysheetfile[getSheetIndex(ctx, copySheetId)!]
        .luckysheet_conditionformat_save,
    );
    const source_curCdformat = _.cloneDeep(source_cdformat);
    const ruleArr: any[] = [];

    if (source_curCdformat != null && source_curCdformat.length > 0) {
      for (let i = 0; i < source_curCdformat.length; i += 1) {
        const source_curCdformat_cellrange = source_curCdformat[i].cellrange;
        let emptyRange: any = [];
        let emptyRange2: any = [];

        for (let j = 0; j < source_curCdformat_cellrange.length; j += 1) {
          const range = CFSplitRange(
            source_curCdformat_cellrange[j],
            { row: [c_r1, c_r2], column: [c_c1, c_c2] },
            { row: [minh, maxh], column: [minc, maxc] },
            'restPart',
          );

          emptyRange = emptyRange.concat(range);

          const range2 = CFSplitRange(
            source_curCdformat_cellrange[j],
            { row: [c_r1, c_r2], column: [c_c1, c_c2] },
            { row: [minh, maxh], column: [minc, maxc] },
            'operatePart',
          );

          if (range2.length > 0) {
            emptyRange2 = emptyRange2.concat(range2);
          }
        }

        source_curCdformat[i].cellrange = emptyRange;

        if (emptyRange2.length > 0) {
          const ruleObj = source_curCdformat[i] ?? {};
          ruleObj.cellrange = emptyRange2;
          ruleArr.push(ruleObj);
        }
      }
    }

    const target_cdformat = _.cloneDeep(
      ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!]
        .luckysheet_conditionformat_save,
    );
    let target_curCdformat = _.cloneDeep(target_cdformat);
    if (ruleArr.length > 0) {
      target_curCdformat = target_curCdformat?.concat(ruleArr);
    }

    // 数据验证
    for (let i = c_r1; i <= c_r2; i += 1) {
      for (let j = c_c1; j <= c_c2; j += 1) {
        delete c_dataVerification[`${i}_${j}`];
      }
    }

    source = {
      sheetId: copySheetId,
      data: sourceData,
      curData: sourceCurData,
      config: sourceConfig,
      curConfig: sourceCurConfig,
      cdformat: source_cdformat,
      curCdformat: source_curCdformat,
      dataVerification: _.cloneDeep(
        ctx.luckysheetfile[getSheetIndex(ctx, copySheetId)!].dataVerification,
      ),
      curDataVerification: c_dataVerification,
      range: {
        row: [c_r1, c_r2],
        column: [c_c1, c_c2],
      },
    };
    target = {
      sheetId: ctx.currentSheetId,
      data: getFlowdata(ctx),
      curData: d,
      config: _.cloneDeep(ctx.config),
      curConfig: cfg,
      cdformat: target_cdformat,
      curCdformat: target_curCdformat,
      dataVerification: _.cloneDeep(
        ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!]
          .dataVerification,
      ),
      curDataVerification: dataVerification,
      range: {
        row: [minh, maxh],
        column: [minc, maxc],
      },
    };
  } else {
    // 条件格式
    const cdformat = _.cloneDeep(
      ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!]
        .luckysheet_conditionformat_save,
    );
    const curCdformat = _.cloneDeep(cdformat);
    if (curCdformat != null && curCdformat.length > 0) {
      for (let i = 0; i < curCdformat.length; i += 1) {
        const { cellrange } = curCdformat[i];
        let emptyRange: any = [];
        for (let j = 0; j < cellrange.length; j += 1) {
          const range = CFSplitRange(
            cellrange[j],
            { row: [c_r1, c_r2], column: [c_c1, c_c2] },
            { row: [minh, maxh], column: [minc, maxc] },
            'allPart',
          );
          emptyRange = emptyRange.concat(range);
        }
        curCdformat[i].cellrange = emptyRange;
      }
    }

    // 当前表操作
    source = {
      sheetId: ctx.currentSheetId,
      data: getFlowdata(ctx),
      curData: d,
      config: _.cloneDeep(ctx.config),
      curConfig: cfg,
      cdformat,
      curCdformat,
      dataVerification: _.cloneDeep(
        ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!]
          .dataVerification,
      ),
      curDataVerification: dataVerification,
      range: {
        row: [c_r1, c_r2],
        column: [c_c1, c_c2],
      },
    };
    target = {
      sheetId: ctx.currentSheetId,
      data: getFlowdata(ctx),
      curData: d,
      config: _.cloneDeep(ctx.config),
      curConfig: cfg,
      cdformat,
      curCdformat,
      dataVerification: _.cloneDeep(
        ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!]
          .dataVerification,
      ),
      curDataVerification: dataVerification,
      range: {
        row: [minh, maxh],
        column: [minc, maxc],
      },
    };
  }

  if (addr > 0 || addc > 0) {
    postPasteCut(ctx, source, target, true);
  } else {
    postPasteCut(ctx, source, target, copyRowlChange);
  }
}

export function pasteHandlerOfCopyPaste(
  ctx: Context,
  copyRange: Context['luckysheet_copy_save'],
  valuesOnly = false,
) {
  // if (
  //   !checkProtectionLockedRangeList(
  //     ctx.luckysheet_select_save,
  //     ctx.currentSheetId
  //   )
  // ) {
  //   return;
  // }
  const allowEdit = isAllowEdit(ctx);
  if (!allowEdit || ctx.isFlvReadOnly) return;

  if (!copyRange) return;

  const cfg = ctx.config;
  if (_.isNil(cfg.merge)) {
    cfg.merge = {};
  }

  // 复制范围
  const copyHasMC = copyRange.HasMC;
  const copyRowlChange = copyRange.RowlChange;
  const copySheetIndex = copyRange.dataSheetId;

  const c_r1 = copyRange.copyRange[0].row[0];
  const c_r2 = copyRange.copyRange[0].row[1];
  const c_c1 = copyRange.copyRange[0].column[0];
  const c_c2 = copyRange.copyRange[0].column[1];

  let arr: CellMatrix = [];
  let isSameRow = false;
  for (let i = 0; i < copyRange.copyRange.length; i += 1) {
    let arrData = getdatabyselection(
      ctx,
      {
        row: copyRange.copyRange[i].row,
        column: copyRange.copyRange[i].column,
      },
      copySheetIndex,
    );
    if (copyRange.copyRange.length > 1) {
      if (
        c_r1 === copyRange.copyRange[1].row[0] &&
        c_r2 === copyRange.copyRange[1].row[1]
      ) {
        arrData = arrData[0].map((col, a) => {
          return arrData.map((row) => {
            return row[a];
          });
        });

        arr = arr.concat(arrData);

        isSameRow = true;
      } else if (
        c_c1 === copyRange.copyRange[1].column[0] &&
        c_c2 === copyRange.copyRange[1].column[1]
      ) {
        arr = arr.concat(arrData);
      }
    } else {
      arr = arrData;
    }
  }

  if (isSameRow) {
    arr = arr[0].map((col, b) => {
      return arr.map((row) => {
        return row[b];
      });
    });
  }

  const copyData = clonePasteMatrix(arr);

  if (valuesOnly) {
    for (let i = 0; i < copyData.length; i += 1) {
      for (let j = 0; j < copyData[i].length; j += 1) {
        const cell = copyData[i][j];
        if (!cell) continue;
        // Replace formula with its computed value
        delete cell.f;
        delete cell.spl;
        // Strip all cell styling
        delete cell.bl;
        delete cell.it;
        delete cell.ff;
        delete cell.fs;
        delete cell.fc;
        delete cell.ht;
        delete cell.vt;
        delete cell.tb;
        delete cell.cl;
        delete cell.un;
        delete cell.tr;
        delete cell.bg;
      }
    }
  }

  // 多重选择选择区域 单元格如果有函数 则只取值 不取函数
  if (copyRange.copyRange.length > 1) {
    for (let i = 0; i < copyData.length; i += 1) {
      for (let j = 0; j < copyData[i].length; j += 1) {
        if (copyData[i][j] != null && copyData[i]![j]!.f != null) {
          delete copyData[i]![j]!.f;
          delete copyData[i]![j]!.spl;
        }
      }
    }
  }

  const copyh = copyData.length;
  const copyc = copyData[0].length;

  // 应用范围
  const last =
    ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
  if (!last) return;
  const minh = last.row[0];
  let maxh = last.row[1]; // 应用范围首尾行
  const minc = last.column[0];
  let maxc = last.column[1]; // 应用范围首尾列

  const mh = (maxh - minh + 1) % copyh;
  const mc = (maxc - minc + 1) % copyc;

  if (mh !== 0 || mc !== 0) {
    // 若应用范围不是copydata行列数的整数倍，则取copydata的行列数
    maxh = minh + copyh - 1;
    maxc = minc + copyc - 1;
  }

  // 应用范围包含部分合并单元格，则提示
  let has_PartMC = false;
  if (!_.isNil(cfg.merge)) {
    has_PartMC = hasPartMC(ctx, cfg, minh, maxh, minc, maxc);
  }

  if (has_PartMC) {
    // if (isEditMode()) {
    //   alert("不能对合并单元格做部分更改");
    // } else {
    //   tooltip.info(
    //     '<i class="fa fa-exclamation-triangle"></i>提示',
    //     "不能对合并单元格做部分更改"
    //   );
    // }
    return;
  }

  const timesH = (maxh - minh + 1) / copyh;
  const timesC = (maxc - minc + 1) / copyc;

  /** Tiled paste reuses the same source cell for multiple targets — fork each instance. */
  const needForkPasteCell = timesH > 1 || timesC > 1;

  const d = getFlowdata(ctx); // 取数据
  if (!d) return;

  const rowMaxLength = d.length;
  const cellMaxLength = d[0].length;

  // 若应用范围超过最大行或最大列，增加行列
  const addr = copyh + minh - rowMaxLength;
  const addc = copyc + minc - cellMaxLength;
  if (addr > 0 || addc > 0) {
    expandRowsAndColumns(d, addr, addc);
  }

  const changes: {
    sheetId: string;
    path: string[];
    value: any;
    key: string;
    type: 'update';
  }[] = [];

  const dataVerificationYdocChanges: {
    sheetId: string;
    path: string[];
    value: any;
    key: string;
    type: 'update';
  }[] = [];

  const hyperlinkYdocChanges: {
    sheetId: string;
    path: string[];
    value: any;
    key: string;
    type: 'update';
  }[] = [];

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

  const file = ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!];
  const hiddenRows = new Set(Object.keys(file.config?.rowhidden || {}));
  const hiddenCols = new Set(Object.keys(file.config?.colhidden || {}));

  for (let th = 1; th <= timesH; th += 1) {
    for (let tc = 1; tc <= timesC; tc += 1) {
      mth = minh + (th - 1) * copyh;
      mtc = minc + (tc - 1) * copyc;
      maxrowCache = minh + th * copyh;
      maxcellCahe = minc + tc * copyc;

      // 行列位移值 用于单元格有函数

      const offsetMC: any = {};
      for (let h = mth; h < maxrowCache; h += 1) {
        // skip if row is hidden
        if (hiddenRows?.has(h.toString())) continue;
        const x = d[h];

        for (let c = mtc; c < maxcellCahe; c += 1) {
          if (hiddenCols?.has(c.toString())) continue;
          if (
            borderInfoCompute[`${c_r1 + h - mth}_${c_c1 + c - mtc}`] &&
            !borderInfoCompute[`${c_r1 + h - mth}_${c_c1 + c - mtc}`].s
          ) {
            pushCellBorderToConfig(
              cfg,
              h,
              c,
              borderInfoCompute[`${c_r1 + h - mth}_${c_c1 + c - mtc}`],
            );
          } else if (borderInfoCompute[`${c_r1 + h - mth}_${c_c1 + c - mtc}`]?.s) {
            const bd_obj = {
              rangeType: 'range',
              borderType: 'border-slash',
              color:
                borderInfoCompute[`${c_r1 + h - minh}_${c_c1 + c - minc}`].s
                  .color!,
              style:
                borderInfoCompute[`${c_r1 + h - minh}_${c_c1 + c - minc}`].s
                  .style!,
              range: normalizeSelection(ctx, [{ row: [h, h], column: [c, c] }]),
            };

            if (cfg.borderInfo == null) {
              cfg.borderInfo = [];
            }

            cfg.borderInfo.push(bd_obj);
          }

          // 数据验证 复制
          if (c_dataVerification[`${c_r1 + h - mth}_${c_c1 + c - mtc}`]) {
            if (_.isNil(dataVerification)) {
              dataVerification = _.cloneDeep(
                ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId)!]
                  ?.dataVerification || {},
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

          if (x[c]?.mc != null) {
            if ('rs' in x[c]!.mc!) {
              delete cfg.merge[`${x[c]!.mc!.r}_${x[c]!.mc!.c}`];
            }
            delete x[c]!.mc;
          }

          let value = null;
          if (copyData[h - mth]?.[c - mtc]) {
            const srcCell = copyData[h - mth][c - mtc];
            value = needForkPasteCell ? clonePasteCellValue(srcCell) : srcCell;
            if (
              value?.v &&
              value?.f &&
              value?.isDataBlockFormula &&
              arr.length === 1
            ) {
              value.m = 'Loading...';
            }
          }

          if (!_.isNil(value) && !_.isNil(value.f)) {
            let adjustedFormula = value.f;
            let isError = false;
            // Use actual source cell for this pasted cell so relative refs adjust correctly
            const srcRow = c_r1 + (h - mth);
            const srcCol = c_c1 + (c - mtc);
            try {
              adjustedFormula = adjustFormulaForPaste(
                value.f,
                srcCol,
                srcRow,
                c,
                h,
              );
            } catch (error: any) {
              isError = true;
              value.error = {
                row_column: `${h}_${c}`,
                title: 'Error',
                message: error?.message || 'Failed to adjust cell reference',
              };
              // strip off all formatting from source
              value.m = '#ERROR';
              value.f = error?.formula;
              delete value.ct;
              delete value.v;
              delete value.tb;
              delete value.ht;
            }

            if (!isError) {
              const funcV = execfunction(
                ctx,
                adjustedFormula,
                h,
                c,
                undefined,
                undefined,
                true,
              );

              value.f = adjustedFormula;

              if (!(funcV[1] instanceof Promise) && !funcV[3]) {
                if (Array.isArray(funcV[1])) {
                  const formulaResultValue = funcV[1];
                  value.m = String(formulaResultValue[0][0]);
                  spillSortResult(
                    ctx,
                    h,
                    c,
                    {
                      m: String(formulaResultValue[0][0]),
                      f: value.f,
                      v: formulaResultValue,
                    },
                    d,
                  );
                } else {
                  value.m = String(funcV[1]);
                  value.v = String(funcV[1]);
                }
              } else if (funcV[3]) {
                value.error = funcV[3];
                // strip off all formatting from source
                value.m = '#ERROR';
                value.f = adjustedFormula;
                delete value.ct;
                delete value.v;
                delete value.tb;
                delete value.ht;
              }

              const { afterUpdateCell } = ctx.hooks;
              if (afterUpdateCell) {
                afterUpdateCell(h, c, null, {
                  ...value,
                  v: arr.length === 1 ? funcV[1] : value.v, // To check with mritunjay for the "arr.length === 1" cond
                  m:
                    funcV[1] instanceof Promise ? '[object Promise]' : funcV[1],
                });
              }
            }

            if (!_.isNil(value.spl)) {
              // value.f = funcV[2];
              // value.v = funcV[1];
              // value.spl = funcV[3].data;
            }
            // else {
            //   [, value.v, value.f] = ['ssss', 'ffff', 'hhhh'];

            //   if (!_.isNil(value.ct) && !_.isNil(value.ct.fa)) {
            //     value.m = update(value.ct.fa, 'ffff');
            //   } else {
            //     value.m = update("General", 'ffff');
            //   }
            // }
          }

          const hadPersistedBefore = shouldPersistCelldataCell(x[c]);
          x[c] = value;

          if (value != null && copyHasMC && x?.[c]?.mc) {
            if (x?.[c]?.mc?.rs != null) {
              x![c]!.mc!.r = h;
              x![c]!.mc!.c = c;

              // @ts-ignore
              cfg.merge[`${h}_${c}`] = x![c]!.mc!;

              offsetMC[`${value!.mc!.r}_${value!.mc!.c}`] = [
                x![c]!.mc!.r,
                x![c]!.mc!.c,
              ];
            } else {
              x[c] = {
                mc: {
                  r: offsetMC[`${value!.mc!.r}_${value!.mc!.c}`][0],
                  c: offsetMC[`${value!.mc!.r}_${value!.mc!.c}`][1],
                },
              };
            }
          }
          // Always in this paste's own batch write: afterUpdateCell skips its
          // write when data-block work is gated off (B2).
          pushPasteCelldataChange(
            changes,
            ctx,
            h,
            c,
            d[h][c],
            hadPersistedBefore,
          );
        }
        d[h] = x;
      }
    }
  }

  // 复制范围 是否有 条件格式和数据验证
  let cdformat: any = null;
  if (copyRange.copyRange.length === 1) {
    const c_file =
      ctx.luckysheetfile[getSheetIndex(ctx, copySheetIndex) as number];
    const a_file =
      ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId) as number];

    const ruleArr_cf = _.cloneDeep(c_file.luckysheet_conditionformat_save);

    if (!_.isNil(ruleArr_cf) && ruleArr_cf.length > 0) {
      cdformat = _.cloneDeep(a_file.luckysheet_conditionformat_save) ?? [];

      for (let i = 0; i < ruleArr_cf.length; i += 1) {
        const cf_range = ruleArr_cf[i].cellrange;

        let emptyRange: any = [];

        for (let th = 1; th <= timesH; th += 1) {
          for (let tc = 1; tc <= timesC; tc += 1) {
            mth = minh + (th - 1) * copyh;
            mtc = minc + (tc - 1) * copyc;
            maxrowCache = minh + th * copyh;
            maxcellCahe = minc + tc * copyc;

            for (let j = 0; j < cf_range.length; j += 1) {
              const range = CFSplitRange(
                cf_range[j],
                { row: [c_r1, c_r2], column: [c_c1, c_c2] },
                { row: [mth, maxrowCache - 1], column: [mtc, maxcellCahe - 1] },
                'operatePart',
              );

              if (range.length > 0) {
                emptyRange = emptyRange.concat(range);
              }
            }
          }
        }

        if (emptyRange.length > 0) {
          ruleArr_cf[i].cellrange = emptyRange;
          cdformat.push(ruleArr_cf[i]);
        }
      }
    }
  }

  last.row = [minh, maxh];
  last.column = [minc, maxc];

  file.config = cfg;
  if (cdformat != null) {
    file.luckysheet_conditionformat_save = cdformat;
  }
  if (dataVerification != null) {
    file.dataVerification = { ...file.dataVerification, ...dataVerification };
  }

  // Copy sheet hyperlink registry for single-range internal paste (multi-range uses different layout).
  if (ctx.luckysheet_copy_save?.copyRange?.length === 1) {
    const srcIndex = getSheetIndex(
      ctx,
      ctx.luckysheet_copy_save?.dataSheetId as string,
    ) as number;
    const targetSheetIndex = getSheetIndex(ctx, ctx.currentSheetId) as number;

    // Cache property access to avoid repeated lookups
    const srcHyperlinks = ctx.luckysheetfile[srcIndex].hyperlink;
    const srcData = ensureSheetFlowdata(ctx, {
      id: ctx.luckysheet_copy_save?.dataSheetId as string,
    });

    // Initialize hyperlink registry for target sheet if needed
    if (!ctx.luckysheetfile[targetSheetIndex].hyperlink) {
      ctx.luckysheetfile[targetSheetIndex].hyperlink = {};
    }
    const targetHyperlinks = ctx.luckysheetfile[targetSheetIndex].hyperlink!;

    // For single cell copy, cache source link and cell to avoid repeated lookups
    const isSingleCell = copyh === 1 && copyc === 1;
    const cachedSrcLinkKey = isSingleCell ? `${c_r1}_${c_c1}` : null;
    const cachedSrcLink =
      isSingleCell && srcHyperlinks ? srcHyperlinks[cachedSrcLinkKey!] : null;
    const cachedSrcCell =
      isSingleCell && srcData ? srcData[c_r1]?.[c_c1] : null;

    // Loop through all target cells using the same repetition pattern as cell data
    for (let th = 1; th <= timesH; th += 1) {
      for (let tc = 1; tc <= timesC; tc += 1) {
        const linkMth = minh + (th - 1) * copyh;
        const linkMtc = minc + (tc - 1) * copyc;
        const linkMaxRow = minh + th * copyh;
        const linkMaxCol = minc + tc * copyc;

        // Loop through target cells in this repetition block
        for (let h = linkMth; h < linkMaxRow; h += 1) {
          for (let c = linkMtc; c < linkMaxCol; c += 1) {
            // Get source link (use cache for single cell, otherwise lookup)
            let srcLink: any;
            if (isSingleCell && cachedSrcLink) {
              srcLink = cachedSrcLink;
            } else {
              const srcRow = c_r1 + (h - linkMth);
              const srcCol = c_c1 + (c - linkMtc);
              srcLink = srcHyperlinks?.[`${srcRow}_${srcCol}`];
            }
            if (!srcLink) continue;

            // Set hyperlink in registry (cache key string)
            const targetKey = `${h}_${c}`;
            targetHyperlinks[targetKey] = srcLink;
            hyperlinkYdocChanges.push({
              sheetId: ctx.currentSheetId,
              path: ['hyperlink'],
              key: targetKey,
              value: JSON.parse(JSON.stringify(srcLink)),
              type: 'update',
            });

            // Update cell data to ensure hyperlink properties are set
            const cell = d[h]?.[c];
            if (cell) {
              // Get source cell styling (use cache for single cell, otherwise lookup)
              let srcCell: any;
              if (isSingleCell && cachedSrcCell) {
                srcCell = cachedSrcCell;
              } else {
                const srcRow = c_r1 + (h - linkMth);
                const srcCol = c_c1 + (c - linkMtc);
                srcCell = srcData?.[srcRow]?.[srcCol];
              }

              // Set hyperlink marker
              cell.hl = { r: h, c, id: ctx.currentSheetId };

              // Copy hyperlink styling from source if available
              if (srcCell) {
                if (srcCell.fc) cell.fc = srcCell.fc;
                if (srcCell.un !== undefined) cell.un = srcCell.un;
              } else {
                // Default hyperlink styling
                cell.fc = cell.fc || 'rgb(0, 0, 255)';
                cell.un = cell.un !== undefined ? cell.un : 1;
              }
            }
          }
        }
      }
    }
  }

  appendPasteFormatRangeMigration(
    ctx,
    cfg,
    d,
    minh,
    maxh,
    minc,
    maxc,
    changes,
  );

  if (ctx?.hooks?.updateCellYdoc) {
    if (
      changes.length > 0 ||
      dataVerificationYdocChanges.length > 0 ||
      hyperlinkYdocChanges.length > 0
    ) {
      ctx.hooks.updateCellYdoc([
        ...changes,
        ...dataVerificationYdocChanges,
        ...hyperlinkYdocChanges,
      ]);
    }
  }

  if (copyRowlChange || addr > 0 || addc > 0) {
    // cfg = rowlenByRange(d, minh, maxh, cfg);
    // const allParam = {
    //   cfg,
    //   RowlChange: true,
    //   cdformat,
    //   dataVerification,
    // };
    jfrefreshgrid(ctx, d, ctx.luckysheet_select_save);
  } else {
    // const allParam = {
    //   cfg,
    //   cdformat,
    //   dataVerification,
    // };
    jfrefreshgrid(ctx, d, ctx.luckysheet_select_save);
    // selectHightlightShow();
  }

  scheduleSheetMetadataSyncHooks(ctx);
}

export function handleFormulaStringPaste(ctx: Context, formulaStr: string) {
  // plaintext formula is applied only to one cell
  const r = ctx.luckysheet_select_save![0].row[0];
  const c = ctx.luckysheet_select_save![0].column[0];

  const funcV = execfunction(ctx, formulaStr, r, c, undefined, undefined, true);

  const val = funcV[1];

  const isDataBlockRespose = typeof val !== 'string' && typeof val !== 'number';

  const d = getFlowdata(ctx);
  if (!d) return;

  if (!d[r][c]) d[r][c] = {};
  d[r][c]!.m = isDataBlockRespose ? 'Loading...' : val.toString();
  d[r][c]!.v = val;
  d[r][c]!.f = formulaStr;
  // Persist the pasted formula; afterUpdateCell below only runs for data-block
  // results, so ordinary formulas never reached Yjs (B6).
  ctx.hooks.updateCellYdoc?.([
    {
      sheetId: ctx.currentSheetId,
      path: ['celldata'],
      key: `${r}_${c}`,
      value: { r, c, v: d[r][c] },
      type: 'update',
    },
  ]);
  const cellTemp = { m: '', v: '', f: '' };

  cellTemp.m = isDataBlockRespose ? 'Loading...' : val.toString();
  cellTemp.v = val;
  cellTemp.f = formulaStr;

  const { afterUpdateCell } = ctx.hooks;
  if (afterUpdateCell && isDataBlockRespose) {
    afterUpdateCell(r, c, null, cellTemp);
  }
}

export function parseAsLinkIfUrl(txtdata: string, ctx: Context) {
  const urlRegex = /^(https?:\/\/[^\s]+)/;
  if (urlRegex.test(txtdata)) {
    // In edit mode, use luckysheetCellUpdate to get the cell position
    if (ctx.luckysheetCellUpdate.length === 2) {
      const rowIndex = ctx.luckysheetCellUpdate[0];
      const colIndex = ctx.luckysheetCellUpdate[1];
      saveHyperlink(ctx, rowIndex, colIndex, txtdata, 'webpage', txtdata);
    } else {
      // Otherwise, use luckysheet_select_save
      const last =
        ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
      if (last) {
        const rowIndex = last.row_focus ?? last.row?.[0] ?? 0;
        const colIndex = last.column_focus ?? last.column?.[0] ?? 0;
        saveHyperlink(ctx, rowIndex, colIndex, txtdata, 'webpage', txtdata);
      }
    }
  }
}

export function resizePastedCellsToContent(ctx: Context) {
  const lastSelectedRange =
    ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
  if (!lastSelectedRange) return;

  const startRow =
    lastSelectedRange.row?.[0] ?? lastSelectedRange.row_focus ?? 0;
  const endRow =
    lastSelectedRange.row?.[1] ?? lastSelectedRange.row_focus ?? startRow;
  const startCol =
    lastSelectedRange.column?.[0] ?? lastSelectedRange.column_focus ?? 0;
  const endCol =
    lastSelectedRange.column?.[1] ?? lastSelectedRange.column_focus ?? startCol;

  const rangeCellSize = calculateRangeCellSize(
    ctx,
    ctx.currentSheetId,
    startRow,
    endRow,
    startCol,
    endCol,
  );
  const sheetIdx = getSheetIndex(ctx, ctx.currentSheetId);
  if (sheetIdx == null) return;

  updateSheetCellSizes(ctx, sheetIdx, rangeCellSize);
}

export function shouldHandleNonTableHtml(html: string) {
  if (!html || /<table[\s/>]/i.test(html)) return false;
  return /<[a-z]/i.test(html);
}

export function convertAnyHtmlToTable(html: string): string {
  const container = document.createElement('div');
  container.innerHTML = html;

  const rows: string[] = [];
  let currentParts: string[] = [];

  const BLOCK_TAGS = new Set([
    'P',
    'DIV',
    'SECTION',
    'ARTICLE',
    'ASIDE',
    'HEADER',
    'FOOTER',
    'MAIN',
    'NAV',
    'BLOCKQUOTE',
    'PRE',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'UL',
    'OL',
    'LI',
    'DL',
    'DT',
    'DD',
    'TABLE',
    'THEAD',
    'TBODY',
    'TFOOT',
    'TR',
    'TD',
    'TH',
    'HR',
  ]);

  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'META',
    'LINK',
    'HEAD',
    'SVG',
    'CANVAS',
    'IFRAME',
    'OBJECT',
  ]);

  const escapeHtml = (text: string): string =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const normalizeText = (text: string): string =>
    text.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ');

  const flushRow = () => {
    const htmlContent = currentParts.join('').trim();
    const textOnly = htmlContent
      .replace(/<br\s*\/?>/gi, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (textOnly) {
      rows.push(`<tr><td>${htmlContent}</td></tr>`);
    }

    currentParts = [];
  };

  const appendText = (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized.trim()) return;

    const prev = currentParts[currentParts.length - 1] || '';
    const needsSpace =
      prev &&
      !prev.endsWith(' ') &&
      !prev.endsWith('<br>') &&
      !/>\s*$/.test(prev);

    currentParts.push((needsSpace ? ' ' : '') + escapeHtml(normalized.trim()));
  };

  const isBlock = (node: Node): boolean =>
    node.nodeType === Node.ELEMENT_NODE &&
    BLOCK_TAGS.has((node as Element).tagName);

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent || '');
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as Element;
    const tag = el.tagName;

    if (SKIP_TAGS.has(tag)) return;

    if (tag === 'BR' || tag === 'HR') {
      flushRow();
      return;
    }

    if (tag === 'TABLE') {
      flushRow();

      const trs = el.querySelectorAll(
        ':scope > tbody > tr, :scope > thead > tr, :scope > tfoot > tr, :scope > tr',
      );
      if (trs.length > 0) {
        trs.forEach((tr) => {
          const cells = Array.from(tr.children).filter((child) =>
            /^(TD|TH)$/.test((child as Element).tagName),
          ) as Element[];

          if (!cells.length) return;

          const rowHtml = cells
            .map(
              (cell) =>
                `<td>${escapeHtml(
                  (cell.textContent || '').replace(/\s+/g, ' ').trim(),
                )}</td>`,
            )
            .join('');

          if (rowHtml.replace(/<[^>]+>/g, '').trim()) {
            rows.push(`<tr>${rowHtml}</tr>`);
          }
        });
      } else {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) rows.push(`<tr><td>${escapeHtml(text)}</td></tr>`);
      }

      return;
    }

    const block = isBlock(el);

    if (block && currentParts.length > 0 && tag !== 'LI') {
      flushRow();
    }

    if (tag === 'LI') {
      flushRow();
    }

    Array.from(el.childNodes).forEach(walk);

    if (block) {
      flushRow();
    }
  };

  Array.from(container.childNodes).forEach(walk);
  flushRow();

  if (!rows.length) {
    const text = (container.textContent || '').replace(/\s+/g, ' ').trim();
    return `<table><tr><td>${escapeHtml(text)}</td></tr></table>`;
  }

  return `<table>${rows.join('')}</table>`;
}
