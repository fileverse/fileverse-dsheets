import _ from 'lodash';
import { Context, getFlowdata } from '../context';
import { Cell, Sheet } from '../types';
import { getSheetIndex } from '../utils';
import { getcellFormula } from './cell';
import { execFunctionGroup, functionStrChange, refreshFormulasUsingDefinedNames } from './formula';
import {
  shiftDefinedNamesOnDelete,
  shiftDefinedNamesOnInsert,
} from './namedRanges';
import {
  ensureManualHiddenInitialized,
  getFilterHiddenRowsUnionFromFilterMap,
  rebuildRowHiddenUnion,
} from './rowVisibility';
import {
  migrateFormatOnlyCellsFromData,
  shiftCellFormatRangesOnDelete,
  shiftCellFormatRangesOnInsert,
} from '../utils/range-format';
import {
  emitCelldataDeletesBeyondGrid,
  emitCelldataRangeDiffToYdoc,
  getDeleteRowColSnapshotBounds,
  getInsertRowColSnapshotBounds,
  snapshotPersistedCelldataInRange,
} from '../utils/ydoc-celldata-changes';

const refreshLocalMergeData = (merge_new: Record<string, any>, file: Sheet) => {
  Object.entries(merge_new).forEach(([, v]) => {
    const { r, c, rs, cs } = v as {
      r: number;
      c: number;
      rs: number;
      cs: number;
    };

    for (let i = r; i < r + rs; i += 1) {
      for (let j = c; j < c + cs; j += 1) {
        if (!file?.data?.[i]) continue;
        if (i === r && j === c) {
          file.data[i][j] = { ...(file.data[i][j] || {}), mc: { r, c, rs, cs } };
        } else {
          file.data[i][j] = { ...(file.data[i][j] || {}), mc: { r, c } };
        }
      }
    }
  });
};
/** Shallow clone for inserted row/column cells: keep style; do not copy v, m, f (or ps / hl). */
const cloneCellTemplateStripContent = (cell: any) => {
  const t = { ...cell };
  delete t.v;
  delete t.m;
  delete t.f;
  delete t.ps;
  delete t.hl;
  return t;
};

function buildTemplateRowFromData(
  d: any[][],
  srcRowIndex: number,
  insertRowCount: number,
  direction: 'lefttop' | 'rightbottom',
) {
  const row: any[] = [];
  const srcRow = d[srcRowIndex];
  if (!srcRow || !d[0]) return row;
  for (let c = 0; c < d[0].length; c += 1) {
    const cell = srcRow[c];
    if (cell == null) {
      row.push(null);
      continue;
    }
    if (
      cell?.mc &&
      (direction === 'rightbottom' || srcRowIndex !== cell.mc.r)
    ) {
      const templateCell = cloneCellTemplateStripContent(_.cloneDeep(cell));
      if (templateCell.mc?.rs) {
        templateCell.mc.rs += insertRowCount;
      }
      if (!d?.[srcRowIndex + 1]?.[c]?.mc) {
        templateCell.mc = undefined;
      }
      row.push(templateCell);
    } else {
      const templateCell = cloneCellTemplateStripContent(_.cloneDeep(cell));
      delete templateCell.mc;
      row.push(templateCell);
    }
  }
  return row;
}

function buildTemplateColumnFromData(
  d: any[][],
  srcColIndex: number,
  insertColCount: number,
  direction: 'lefttop' | 'rightbottom',
) {
  const col: any[] = [];
  for (let r = 0; r < d.length; r += 1) {
    const cell = d[r][srcColIndex];
    if (cell == null) {
      col.push(null);
      continue;
    }
    if (
      cell?.mc &&
      (direction === 'rightbottom' || srcColIndex !== cell.mc.c)
    ) {
      const templateCell = cloneCellTemplateStripContent(_.cloneDeep(cell));
      if (templateCell.mc?.cs) {
        templateCell.mc.cs += insertColCount;
      }
      if (!d?.[r]?.[srcColIndex + 1]?.mc) {
        templateCell.mc = undefined;
      }
      col.push(templateCell);
    } else {
      const templateCell = cloneCellTemplateStripContent(_.cloneDeep(cell));
      delete templateCell.mc;
      col.push(templateCell);
    }
  }
  return col;
}

const getMergeBounds = (mergeMap: Record<string, any> | null | undefined) => {
  if (!mergeMap) return null;
  let minR = Infinity;
  let minC = Infinity;
  let maxR = -Infinity;
  let maxC = -Infinity;

  Object.values(mergeMap).forEach((mc: any) => {
    if (!mc) return;
    const r = Number(mc.r);
    const c = Number(mc.c);
    const rs = Number(mc.rs ?? 1);
    const cs = Number(mc.cs ?? 1);
    if (!Number.isFinite(r) || !Number.isFinite(c)) return;

    minR = Math.min(minR, r);
    minC = Math.min(minC, c);
    maxR = Math.max(maxR, r + Math.max(1, rs) - 1);
    maxC = Math.max(maxC, c + Math.max(1, cs) - 1);
  });

  if (minR === Infinity) return null;
  return { minR, minC, maxR, maxC };
};

const emitCellRangeToYdoc = (
  ctx: Context,
  sheetId: string,
  d: any[][],
  r1: number,
  r2: number,
  c1: number,
  c2: number,
  beforePersisted?: Map<string, Cell | string | number | boolean>,
) => {
  emitCelldataRangeDiffToYdoc(
    ctx,
    sheetId,
    d,
    r1,
    r2,
    c1,
    c2,
    beforePersisted,
  );
};

const emitCellFormatRangesToYdoc = (
  ctx: Context,
  sheetId: string,
  ranges: any[] | undefined,
) => {
  if (!ctx?.hooks?.updateCellYdoc) return;
  ctx.hooks.updateCellYdoc([
    {
      sheetId,
      path: ['config', 'cellFormatRanges'],
      value: ranges ?? [],
      type: 'update',
    },
  ]);
};

const markCellRefError = (cell: Cell) => {
  cell.v = '#REF!';
  cell.m = '#REF!';
  cell.error = { title: '#REF!', message: 'Reference is not valid.' };
  if (cell.ct) {
    cell.ct.t = 'e';
  } else {
    cell.ct = { fa: 'General', t: 'e' };
  }
};

const rewriteFormulasByScanningSheet = (
  sheet: Sheet,
  calcChain: any[] | null | undefined,
  mode: 'add' | 'del',
  rc: 'row' | 'col',
  orient: 'lefttop' | 'rightbottom' | null,
  stindex: number,
  step: number,
) => {
  const sheetData = sheet.data;
  if (!sheetData) return;

  const calcChainSet = new Set<string>();
  (calcChain || []).forEach((item: any) => {
    if (item && Number.isFinite(item.r) && Number.isFinite(item.c)) {
      calcChainSet.add(`${item.r}_${item.c}`);
    }
  });

  for (let r = 0; r < sheetData.length; r += 1) {
    const row = sheetData[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c] as any;
      if (!cell?.f) continue;
      if (calcChainSet.has(`${r}_${c}`)) continue;
      const newF = `=${functionStrChange(cell.f, mode, rc, orient, stindex, step)}`;
      cell.f = newF;
      if (newF.includes('#REF!')) markCellRefError(cell);
    }
  }
};

/**
 * 增加行列
 * @param {string} type 行或列 ['row', 'column'] 之一
 * @param {number} index 插入的位置 index
 * @param {number} count 插入 多少 行（列）
 * @param {string} direction 哪个方向插入 ['lefttop','rightbottom'] 之一
 * @param {string | number} id 操作的 sheet 的 id
 * @returns
 */
export function insertRowCol(
  ctx: Context,
  op: {
    type: 'row' | 'column';
    index: number;
    count: number;
    direction: 'lefttop' | 'rightbottom';
    id: string;
    /** Pre-insert row index for each inserted row (length must equal count). */
    templateSourceRows?: number[];
    /** Pre-insert column index for each inserted column (length must equal count). */
    templateSourceColumns?: number[];
  },
  changeSelection: boolean = true,
) {
  let { count, id } = op;
  const { type, index, direction, templateSourceRows, templateSourceColumns } =
    op;
  id = id || ctx.currentSheetId;

  // if (
  //   type === "row" &&
  //   !checkProtectionAuthorityNormal(sheetId, "insertRows")
  // ) {
  //   return;
  // } else if (
  //   type === "column" &&
  //   !checkProtectionAuthorityNormal(sheetId, "insertColumns")
  // ) {
  //   return;
  // }

  const curOrder = getSheetIndex(ctx, id);
  if (curOrder == null) return;

  const file = ctx.luckysheetfile[curOrder];
  if (!file) return;

  const d = file.data;
  if (!d) return;

  const cfg = file.config || {};
  // Ensure manual-hidden provenance exists for this sheet config.
  // If missing, derive as: (rowhidden - filterHidden) when a filter exists on this sheet.
  const filterUnionExisting = getFilterHiddenRowsUnionFromFilterMap(
    file.filter as any,
  );
  if (cfg.rowhidden_manual == null) {
    cfg.rowhidden_manual = _.omit(
      cfg.rowhidden || {},
      _.keys(filterUnionExisting),
    );
  }
  cfg.rowhidden_filter = filterUnionExisting;
  cfg.rowhidden = _.assign({}, cfg.rowhidden_manual, filterUnionExisting);

  count = Math.floor(count);

  const usePerRowTemplates =
    type === 'row' &&
    templateSourceRows != null &&
    templateSourceRows.length === count &&
    templateSourceRows.every((r) => r >= 0 && r < d.length);
  const usePerColTemplates =
    type === 'column' &&
    templateSourceColumns != null &&
    templateSourceColumns.length === count &&
    d[0] != null &&
    templateSourceColumns.every((c) => c >= 0 && c < d[0].length);
  const firstTemplateRow = usePerRowTemplates ? templateSourceRows![0] : null;
  const firstTemplateCol = usePerColTemplates
    ? templateSourceColumns![0]
    : null;

  if (changeSelection) {
    if (type === 'row') {
      if (usePerRowTemplates) {
        if (cfg.rowReadOnly?.[firstTemplateRow!]) {
          throw new Error('readOnly');
        }
      } else if (cfg.rowReadOnly?.[index]) {
        throw new Error('readOnly');
      }
    } else if (usePerColTemplates) {
      if (cfg.colReadOnly?.[firstTemplateCol!]) {
        throw new Error('readOnly');
      }
    } else if (cfg.colReadOnly?.[index]) {
      throw new Error('readOnly');
    }
  }

  if (type === 'row' && d.length + count >= 10000) {
    throw new Error('maxExceeded');
  }

  if (type === 'column' && d[0] && d[0].length + count >= 1000) {
    throw new Error('maxExceeded');
  }

  const insertSnapBounds = getInsertRowColSnapshotBounds(
    type,
    index,
    direction,
    d.length,
    d[0]?.length ?? 1,
    getMergeBounds(cfg.merge),
  );
  const ydocBeforePersisted = snapshotPersistedCelldataInRange(
    d,
    insertSnapBounds.r1,
    insertSnapBounds.r2,
    insertSnapBounds.c1,
    insertSnapBounds.c2,
    file.celldata,
  );

  const snapRowDv =
    usePerRowTemplates && file.dataVerification != null
      ? [firstTemplateRow!].map((sr) => {
          const m: Record<number, any> = {};
          _.forEach(file.dataVerification, (v, key) => {
            const r = Number(key.split('_')[0]);
            const c = Number(key.split('_')[1]);
            if (r === sr) m[c] = _.cloneDeep(v);
          });
          return m;
        })
      : null;
  const snapColDv =
    usePerColTemplates && file.dataVerification != null
      ? [firstTemplateCol!].map((sc) => {
          const m: Record<number, any> = {};
          _.forEach(file.dataVerification, (v, key) => {
            const r = Number(key.split('_')[0]);
            const c = Number(key.split('_')[1]);
            if (c === sc) m[r] = _.cloneDeep(v);
          });
          return m;
        })
      : null;

  // 合并单元格配置变动
  if (cfg.merge == null) {
    cfg.merge = {};
  }

  const merge_new: any = {};
  _.forEach(cfg.merge, (mc) => {
    const { r, c, rs, cs } = mc;

    if (type === 'row') {
      if (index < r) {
        merge_new[`${r + count}_${c}`] = { r: r + count, c, rs, cs };
      } else if (index === r) {
        if (direction === 'lefttop') {
          merge_new[`${r + count}_${c}`] = {
            r: r + count,
            c,
            rs,
            cs,
          };
        } else {
          merge_new[`${r}_${c}`] = { r, c, rs: rs + count, cs };
        }
      } else if (index < r + rs - 1) {
        merge_new[`${r}_${c}`] = { r, c, rs: rs + count, cs };
      } else if (index === r + rs - 1) {
        if (direction === 'lefttop') {
          merge_new[`${r}_${c}`] = { r, c, rs: rs + count, cs };
        } else {
          merge_new[`${r}_${c}`] = { r, c, rs, cs };
        }
      } else {
        merge_new[`${r}_${c}`] = { r, c, rs, cs };
      }
    } else if (type === 'column') {
      if (index < c) {
        merge_new[`${r}_${c + count}`] = {
          r,
          c: c + count,
          rs,
          cs,
        };
      } else if (index === c) {
        if (direction === 'lefttop') {
          merge_new[`${r}_${c + count}`] = {
            r,
            c: c + count,
            rs,
            cs,
          };
        } else {
          merge_new[`${r}_${c}`] = { r, c, rs, cs: cs + count };
        }
      } else if (index < c + cs - 1) {
        merge_new[`${r}_${c}`] = { r, c, rs, cs: cs + count };
      } else if (index === c + cs - 1) {
        if (direction === 'lefttop') {
          merge_new[`${r}_${c}`] = { r, c, rs, cs: cs + count };
        } else {
          merge_new[`${r}_${c}`] = { r, c, rs, cs };
        }
      } else {
        merge_new[`${r}_${c}`] = { r, c, rs, cs };
      }
    }
  });
  cfg.merge = merge_new;

  // 公式配置变动
  const newCalcChain = [];
  for (
    let SheetIndex = 0;
    SheetIndex < ctx.luckysheetfile.length;
    SheetIndex += 1
  ) {
    if (
      _.isNil(ctx.luckysheetfile[SheetIndex].calcChain) ||
      ctx.luckysheetfile.length === 0
    ) {
      continue;
    }
    const { calcChain } = ctx.luckysheetfile[SheetIndex];
    const { data } = ctx.luckysheetfile[SheetIndex];
    for (let i = 0; i < calcChain!.length; i += 1) {
      const calc: any = _.cloneDeep(calcChain![i]);
      const calc_r = calc.r;
      const calc_c = calc.c;
      const calc_i = calc.id;
      const calc_funcStr = getcellFormula(ctx, calc_r, calc_c, calc_i);

      if (type === 'row' && SheetIndex === curOrder) {
        const functionStr = `=${functionStrChange(
          calc_funcStr,
          'add',
          'row',
          direction,
          index,
          count,
        )}`;

        if (d[calc_r]?.[calc_c]?.f === calc_funcStr) {
          d[calc_r]![calc_c]!.f = functionStr;
        }

        if (direction === 'lefttop') {
          if (calc_r >= index) {
            calc.r += count;
          }
        } else if (direction === 'rightbottom') {
          if (calc_r > index) {
            calc.r += count;
          }
        }

        newCalcChain.push(calc);
      } else if (type === 'row') {
        const functionStr = `=${functionStrChange(
          calc_funcStr,
          'add',
          'row',
          direction,
          index,
          count,
        )}`;

        // Guard: other sheets may have calcChain before data is hydrated.
        if (data?.[calc_r]?.[calc_c]?.f === calc_funcStr) {
          data[calc_r]![calc_c]!.f = functionStr;
        }
      } else if (type === 'column' && SheetIndex === curOrder) {
        const functionStr = `=${functionStrChange(
          calc_funcStr,
          'add',
          'col',
          direction,
          index,
          count,
        )}`;

        if (d[calc_r]?.[calc_c]?.f === calc_funcStr) {
          d[calc_r]![calc_c]!.f = functionStr;
        }

        if (direction === 'lefttop') {
          if (calc_c >= index) {
            calc.c += count;
          }
        } else if (direction === 'rightbottom') {
          if (calc_c > index) {
            calc.c += count;
          }
        }

        newCalcChain.push(calc);
      } else if (type === 'column') {
        const functionStr = `=${functionStrChange(
          calc_funcStr,
          'add',
          'col',
          direction,
          index,
          count,
        )}`;

        if (data?.[calc_r]?.[calc_c]?.f === calc_funcStr) {
          data[calc_r]![calc_c]!.f = functionStr;
        }
      }
    }
    rewriteFormulasByScanningSheet(
      ctx.luckysheetfile[SheetIndex],
      calcChain,
      'add',
      type === 'row' ? 'row' : 'col',
      direction,
      index,
      count,
    );
  }

  // 筛选配置变动
  const { filter_select } = file;
  const { filter } = file;
  let newFilterObj: any = null;
  if (!_.isEmpty(filter_select) && filter_select != null) {
    newFilterObj = { filter_select: null, filter: null };

    let f_r1 = filter_select.row[0];
    let f_r2 = filter_select.row[1];
    let f_c1 = filter_select.column[0];
    let f_c2 = filter_select.column[1];

    if (type === 'row') {
      if (f_r1 < index) {
        if (f_r2 === index && direction === 'lefttop') {
          f_r2 += count;
        } else if (f_r2 > index) {
          f_r2 += count;
        }
      } else if (f_r1 === index) {
        if (direction === 'lefttop') {
          f_r1 += count;
          f_r2 += count;
        } else if (direction === 'rightbottom' && f_r2 > index) {
          f_r2 += count;
        }
      } else {
        f_r1 += count;
        f_r2 += count;
      }

      if (filter != null) {
        newFilterObj.filter = {};

        _.forEach(filter, (v, k) => {
          const f_rowhidden = filter[k].rowhidden;
          const f_rowhidden_new: any = {};
          _.forEach(f_rowhidden, (v1, nstr) => {
            const n = parseFloat(nstr);

            if (n < index) {
              f_rowhidden_new[n] = 0;
            } else if (n === index) {
              if (direction === 'lefttop') {
                f_rowhidden_new[n + count] = 0;
              } else if (direction === 'rightbottom') {
                f_rowhidden_new[n] = 0;
              }
            } else {
              f_rowhidden_new[n + count] = 0;
            }
          });
          newFilterObj.filter[k] = _.cloneDeep(filter[k]);
          newFilterObj.filter[k].rowhidden = f_rowhidden_new;
          newFilterObj.filter[k].str = f_r1;
          newFilterObj.filter[k].edr = f_r2;
        });
      }
    } else if (type === 'column') {
      if (f_c1 < index) {
        if (f_c2 === index && direction === 'lefttop') {
          f_c2 += count;
        } else if (f_c2 > index) {
          f_c2 += count;
        }
      } else if (f_c1 === index) {
        if (direction === 'lefttop') {
          f_c1 += count;
          f_c2 += count;
        } else if (direction === 'rightbottom' && f_c2 > index) {
          f_c2 += count;
        }
      } else {
        f_c1 += count;
        f_c2 += count;
      }

      if (filter != null) {
        newFilterObj.filter = {};

        _.forEach(filter, (v, k) => {
          let f_cindex = filter[k].cindex;

          if (f_cindex === index && direction === 'lefttop') {
            f_cindex += count;
          } else if (f_cindex > index) {
            f_cindex += count;
          }

          newFilterObj.filter[f_cindex - f_c1] = _.cloneDeep(filter[k]);
          newFilterObj.filter[f_cindex - f_c1].cindex = f_cindex;
          newFilterObj.filter[f_cindex - f_c1].stc = f_c1;
          newFilterObj.filter[f_cindex - f_c1].edc = f_c2;
        });
      }
    }

    newFilterObj.filter_select = { row: [f_r1, f_r2], column: [f_c1, f_c2] };
  }

  // Rebuild `cfg.rowhidden` as render-time union: manual ∪ filterHidden.
  const filterHiddenAfterInsert =
    newFilterObj?.filter != null
      ? getFilterHiddenRowsUnionFromFilterMap(newFilterObj.filter)
      : getFilterHiddenRowsUnionFromFilterMap(filter as any);
  cfg.rowhidden_filter = filterHiddenAfterInsert;
  cfg.rowhidden = _.assign(
    {},
    cfg.rowhidden_manual || {},
    filterHiddenAfterInsert,
  );

  // 条件格式配置变动
  const CFarr = file.luckysheet_conditionformat_save;
  const newCFarr = [];
  if (CFarr != null && CFarr.length > 0) {
    for (let i = 0; i < CFarr.length; i += 1) {
      const cf_range = CFarr[i].cellrange;
      const cf_new_range = [];

      for (let j = 0; j < cf_range.length; j += 1) {
        let CFr1 = cf_range[j].row[0];
        let CFr2 = cf_range[j].row[1];
        let CFc1 = cf_range[j].column[0];
        let CFc2 = cf_range[j].column[1];

        if (type === 'row') {
          if (CFr1 < index) {
            if (CFr2 === index && direction === 'lefttop') {
              CFr2 += count;
            } else if (CFr2 > index) {
              CFr2 += count;
            }
          } else if (CFr1 === index) {
            if (direction === 'lefttop') {
              // Expand range downward so new rows at `index` stay inside the rule (do not shift the whole rule).
              CFr2 += count;
            } else if (direction === 'rightbottom' && CFr2 >= index) {
              CFr2 += count;
            }
          } else {
            CFr1 += count;
            CFr2 += count;
          }
        } else if (type === 'column') {
          if (CFc1 < index) {
            if (CFc2 === index && direction === 'lefttop') {
              CFc2 += count;
            } else if (CFc2 > index) {
              CFc2 += count;
            }
          } else if (CFc1 === index) {
            if (direction === 'lefttop') {
              CFc2 += count;
            } else if (direction === 'rightbottom' && CFc2 >= index) {
              CFc2 += count;
            }
          } else {
            CFc1 += count;
            CFc2 += count;
          }
        }

        cf_new_range.push({ row: [CFr1, CFr2], column: [CFc1, CFc2] });
      }

      const cf = _.clone(CFarr[i]);
      cf.cellrange = cf_new_range;

      newCFarr.push(cf);
    }
  }

  // 交替颜色配置变动
  const AFarr = file.luckysheet_alternateformat_save;
  const newAFarr = [];
  if (AFarr != null && AFarr.length > 0) {
    for (let i = 0; i < AFarr.length; i += 1) {
      let AFr1 = AFarr[i].cellrange.row[0];
      let AFr2 = AFarr[i].cellrange.row[1];
      let AFc1 = AFarr[i].cellrange.column[0];
      let AFc2 = AFarr[i].cellrange.column[1];

      const af = _.clone(AFarr[i]);

      if (type === 'row') {
        if (AFr1 < index) {
          if (AFr2 === index && direction === 'lefttop') {
            AFr2 += count;
          } else if (AFr2 > index) {
            AFr2 += count;
          }
        } else if (AFr1 === index) {
          if (direction === 'lefttop') {
            AFr2 += count;
          } else if (direction === 'rightbottom' && AFr2 >= index) {
            AFr2 += count;
          }
        } else {
          AFr1 += count;
          AFr2 += count;
        }
      } else if (type === 'column') {
        if (AFc1 < index) {
          if (AFc2 === index && direction === 'lefttop') {
            AFc2 += count;
          } else if (AFc2 > index) {
            AFc2 += count;
          }
        } else if (AFc1 === index) {
          if (direction === 'lefttop') {
            AFc2 += count;
          } else if (direction === 'rightbottom' && AFc2 >= index) {
            AFc2 += count;
          }
        } else {
          AFc1 += count;
          AFc2 += count;
        }
      }

      af.cellrange = { row: [AFr1, AFr2], column: [AFc1, AFc2] };

      newAFarr.push(af);
    }
  }

  // 冻结配置变动
  const { frozen } = file;
  if (frozen) {
    const normalizedIndex = direction === 'lefttop' ? index - 1 : index;
    if (
      type === 'row' &&
      (frozen.type === 'rangeRow' || frozen.type === 'rangeBoth')
    ) {
      if ((frozen.range?.row_focus ?? -1) > normalizedIndex) {
        frozen.range!.row_focus += count;
      }
    }
    if (
      type === 'column' &&
      (frozen.type === 'rangeColumn' || frozen.type === 'rangeBoth')
    ) {
      if ((frozen.range?.column_focus ?? -1) > normalizedIndex) {
        frozen.range!.column_focus += count;
      }
    }
  }

  // 数据验证配置变动
  const { dataVerification } = file;
  const newDataVerification: any = {};
  if (dataVerification != null) {
    _.forEach(dataVerification, (v, key) => {
      const r = Number(key.split('_')[0]);
      const c = Number(key.split('_')[1]);
      const item = dataVerification[key];

      if (type === 'row') {
        if (index < r) {
          newDataVerification[`${r + count}_${c}`] = _.cloneDeep(item);
        } else if (index === r) {
          if (direction === 'lefttop') {
            newDataVerification[`${r + count}_${c}`] = _.cloneDeep(item);

            if (!snapRowDv) {
              for (let i = 0; i < count; i += 1) {
                newDataVerification[`${r + i}_${c}`] = _.cloneDeep(item);
              }
            }
          } else {
            newDataVerification[`${r}_${c}`] = _.cloneDeep(item);

            if (!snapRowDv) {
              for (let i = 0; i < count; i += 1) {
                newDataVerification[`${r + i + 1}_${c}`] = _.cloneDeep(item);
              }
            }
          }
        } else {
          newDataVerification[`${r}_${c}`] = _.cloneDeep(item);
        }
      } else if (type === 'column') {
        if (index < c) {
          newDataVerification[`${r}_${c + count}`] = _.cloneDeep(item);
        } else if (index === c) {
          if (direction === 'lefttop') {
            newDataVerification[`${r}_${c + count}`] = _.cloneDeep(item);

            if (!snapColDv) {
              for (let i = 0; i < count; i += 1) {
                newDataVerification[`${r}_${c + i}`] = _.cloneDeep(item);
              }
            }
          } else {
            newDataVerification[`${r}_${c}`] = _.cloneDeep(item);

            if (!snapColDv) {
              for (let i = 0; i < count; i += 1) {
                newDataVerification[`${r}_${c + i + 1}`] = _.cloneDeep(item);
              }
            }
          }
        } else {
          newDataVerification[`${r}_${c}`] = _.cloneDeep(item);
        }
      }
    });
  }

  // 超链接配置变动
  const { hyperlink } = file;
  const newHyperlink: any = {};
  if (hyperlink != null) {
    _.forEach(hyperlink, (v, key) => {
      const r = Number(key.split('_')[0]);
      const c = Number(key.split('_')[1]);
      const item = hyperlink[key];

      if (type === 'row') {
        if (index < r) {
          newHyperlink[`${r + count}_${c}`] = item;
        } else if (index === r) {
          if (direction === 'lefttop') {
            newHyperlink[`${r + count}_${c}`] = item;
          } else {
            newHyperlink[`${r}_${c}`] = item;
          }
        } else {
          newHyperlink[`${r}_${c}`] = item;
        }
      } else if (type === 'column') {
        if (index < c) {
          newHyperlink[`${r}_${c + count}`] = item;
        } else if (index === c) {
          if (direction === 'lefttop') {
            newHyperlink[`${r}_${c + count}`] = item;
          } else {
            newHyperlink[`${r}_${c}`] = item;
          }
        } else {
          newHyperlink[`${r}_${c}`] = item;
        }
      }
    });
  }

  let type1;
  if (type === 'row') {
    type1 = 'r';

    const rowBorderSnapshot = _.cloneDeep(cfg.borderInfo || []);

    const refRowHeightsForInsert = usePerRowTemplates
      ? [
          cfg.rowlen?.[firstTemplateRow!] ??
            file.defaultRowHeight ??
            ctx.defaultrowlen,
        ]
      : null;
    const refRowCustomsForInsert = usePerRowTemplates
      ? [cfg.customHeight?.[firstTemplateRow!]]
      : null;
    const refRowHeightBeforeInsert =
      cfg.rowlen?.[index] ?? file.defaultRowHeight ?? ctx.defaultrowlen;
    const refRowCustomBefore = cfg.customHeight?.[index];

    // 行高配置变动
    if (cfg.rowlen != null) {
      const rowlen_new: any = {};
      const rowReadOnly_new: Record<number, number> = {};

      _.forEach(cfg.rowlen, (v, rstr) => {
        const r = parseFloat(rstr);

        if (r < index) {
          rowlen_new[r] = cfg.rowlen![r];
        } else if (r === index) {
          if (direction === 'lefttop') {
            rowlen_new[r + count] = cfg.rowlen![r];
          } else if (direction === 'rightbottom') {
            rowlen_new[r] = cfg.rowlen![r];
          }
        } else {
          rowlen_new[r + count] = cfg.rowlen![r];
        }
      });
      _.forEach(cfg.rowReadOnly, (v, rstr) => {
        const r = parseFloat(rstr);
        if (r < index) {
          rowReadOnly_new[r] = cfg.rowReadOnly![r];
        } else if (r > index) {
          rowReadOnly_new[r + count] = cfg.rowReadOnly![r];
        }
      });

      cfg.rowlen = rowlen_new;
      cfg.rowReadOnly = rowReadOnly_new;
    }

    // 自定义行高配置变动
    if (cfg.customHeight != null) {
      const customHeight_new: any = {};

      _.forEach(cfg.customHeight, (v, rstr) => {
        const r = parseFloat(rstr);

        if (r < index) {
          customHeight_new[r] = cfg.customHeight![r];
        } else if (r === index) {
          if (direction === 'lefttop') {
            customHeight_new[r + count] = cfg.customHeight![r];
          } else if (direction === 'rightbottom') {
            customHeight_new[r] = cfg.customHeight![r];
          }
        } else {
          customHeight_new[r + count] = cfg.customHeight![r];
        }
      });

      cfg.customHeight = customHeight_new;
    }

    const applyInsertedRowSizing = count === 1;
    if (applyInsertedRowSizing) {
      if (cfg.rowlen == null) {
        cfg.rowlen = {};
      }
      const newRowStart = direction === 'lefttop' ? index : index + 1;
      for (let i = 0; i < count; i += 1) {
        cfg.rowlen![newRowStart + i] = refRowHeightsForInsert
          ? refRowHeightsForInsert[0]
          : refRowHeightBeforeInsert;
      }
      if (refRowHeightsForInsert) {
        cfg.customHeight ||= {};
        for (let i = 0; i < count; i += 1) {
          if (refRowCustomsForInsert![0] === 1) {
            cfg.customHeight[newRowStart + i] = 1;
          }
        }
      } else if (refRowCustomBefore === 1) {
        cfg.customHeight ||= {};
        for (let i = 0; i < count; i += 1) {
          cfg.customHeight[newRowStart + i] = 1;
        }
      }
    }

    // 隐藏行配置变动（manual provenance only; `cfg.rowhidden` is rebuilt as union later）
    const filterUnionBefore = getFilterHiddenRowsUnionFromFilterMap(
      file.filter as any,
    );
    const manualBefore =
      cfg.rowhidden_manual ??
      _.omit(cfg.rowhidden || {}, _.keys(filterUnionBefore));
    const rowhidden_manual_new: Record<string, number> = {};
    _.forEach(manualBefore, (v, rstr) => {
      const r = parseFloat(rstr);

      if (r < index) {
        rowhidden_manual_new[r] = (manualBefore as any)[r];
      } else if (r === index) {
        if (direction === 'lefttop') {
          rowhidden_manual_new[r + count] = (manualBefore as any)[r];
        } else if (direction === 'rightbottom') {
          rowhidden_manual_new[r] = (manualBefore as any)[r];
        }
      } else {
        rowhidden_manual_new[r + count] = (manualBefore as any)[r];
      }
    });
    cfg.rowhidden_manual = rowhidden_manual_new;
    // Keep render-time union in sync after shifting manual rows.
    const filterHiddenNow =
      newFilterObj?.filter != null
        ? getFilterHiddenRowsUnionFromFilterMap(newFilterObj.filter)
        : getFilterHiddenRowsUnionFromFilterMap(filter as any);
    cfg.rowhidden_filter = filterHiddenNow;
    cfg.rowhidden = _.assign({}, cfg.rowhidden_manual, filterHiddenNow);

    // 空行模板（非合并单元格也要复制样式；不复制 v / m / f / ps / 超链接）
    const cellBorderConfig: any[] = [];
    // 边框
    if (cfg.borderInfo && cfg.borderInfo.length > 0) {
      const borderInfo = [];

      for (let i = 0; i < cfg.borderInfo.length; i += 1) {
        const { rangeType } = cfg.borderInfo[i];

        if (rangeType === 'range') {
          const borderRange = cfg.borderInfo[i].range;

          const emptyRange = [];

          for (let j = 0; j < borderRange.length; j += 1) {
            let bd_r1 = borderRange[j].row[0];
            let bd_r2 = borderRange[j].row[1];

            if (direction === 'lefttop') {
              if (index <= bd_r1) {
                bd_r1 += count;
                bd_r2 += count;
              } else if (index <= bd_r2) {
                bd_r2 += count;
              }
            } else {
              if (index < bd_r1) {
                bd_r1 += count;
                bd_r2 += count;
              } else if (index < bd_r2) {
                bd_r2 += count;
              }
            }

            if (bd_r2 >= bd_r1) {
              emptyRange.push({
                row: [bd_r1, bd_r2],
                column: borderRange[j].column,
              });
            }
          }

          if (emptyRange.length > 0) {
            const bd_obj = {
              rangeType: 'range',
              borderType: cfg.borderInfo[i].borderType,
              style: cfg.borderInfo[i].style,
              color: cfg.borderInfo[i].color,
              range: emptyRange,
            };

            borderInfo.push(bd_obj);
          }
        } else if (rangeType === 'cell') {
          let { row_index } = cfg.borderInfo[i].value;
          // 位置相同标识边框相关 先缓存
          if (!usePerRowTemplates && row_index === index) {
            cellBorderConfig.push(
              JSON.parse(JSON.stringify(cfg.borderInfo[i])),
            );
          }

          if (direction === 'lefttop') {
            if (index <= row_index) {
              row_index += count;
            }
          } else {
            if (index < row_index) {
              row_index += count;
            }
          }

          cfg.borderInfo[i].value.row_index = row_index;
          borderInfo.push(cfg.borderInfo[i]);
        }
      }

      cfg.borderInfo = borderInfo;
    }

    const prevFormatRanges = cfg.cellFormatRanges;
    cfg.cellFormatRanges = shiftCellFormatRangesOnInsert(
      cfg.cellFormatRanges,
      'row',
      index,
      count,
      direction,
    );
    if (!_.isEqual(prevFormatRanges, cfg.cellFormatRanges)) {
      emitCellFormatRangesToYdoc(ctx, id, cfg.cellFormatRanges);
    }

    const arr = [];
    for (let r = 0; r < count; r += 1) {
      const srcRowIdx = usePerRowTemplates ? firstTemplateRow! : index;
      const row = buildTemplateRowFromData(d, srcRowIdx, count, direction);
      arr.push(JSON.stringify(row));
      let bordersToDup: any[] = [];
      if (usePerRowTemplates) {
        bordersToDup = rowBorderSnapshot
          .filter(
            (bi: any) =>
              bi.rangeType === 'cell' && bi.value.row_index === srcRowIdx,
          )
          .map((bi: any) => JSON.parse(JSON.stringify(bi)));
      } else if (cellBorderConfig.length) {
        bordersToDup = _.cloneDeep(cellBorderConfig);
      }
      if (bordersToDup.length) {
        bordersToDup.forEach((item) => {
          if (direction === 'rightbottom') {
            item.value.row_index += r + 1;
          } else if (direction === 'lefttop') {
            item.value.row_index += r;
          }
        });
        cfg.borderInfo?.push(...bordersToDup);
      }
    }

    if (direction === 'lefttop') {
      if (index === 0) {
        new Function('d', `return d.unshift(${arr.join(',')})`)(d);
      } else {
        new Function('d', `return d.splice(${index}, 0, ${arr.join(',')})`)(d);
      }
    } else {
      new Function('d', `return d.splice(${index + 1}, 0, ${arr.join(',')})`)(
        d,
      );
    }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    type1 = 'c';

    const colBorderSnapshot = _.cloneDeep(cfg.borderInfo || []);

    const refColWidthsForInsert = usePerColTemplates
      ? [
          cfg.columnlen?.[firstTemplateCol!] ??
            file.defaultColWidth ??
            ctx.defaultcollen,
        ]
      : null;
    const refColCustomsForInsert = usePerColTemplates
      ? [cfg.customWidth?.[firstTemplateCol!]]
      : null;
    const refColWidthBeforeInsert =
      cfg.columnlen?.[index] ?? file.defaultColWidth ?? ctx.defaultcollen;
    const refColCustomBefore = cfg.customWidth?.[index];

    // 列宽配置变动
    if (cfg.columnlen != null) {
      const columnlen_new: any = {};
      const columnReadOnly_new: any = {};

      _.forEach(cfg.columnlen, (v, cstr) => {
        const c = parseFloat(cstr);

        if (c < index) {
          columnlen_new[c] = cfg.columnlen![c];
        } else if (c === index) {
          if (direction === 'lefttop') {
            columnlen_new[c + count] = cfg.columnlen![c];
          } else if (direction === 'rightbottom') {
            columnlen_new[c] = cfg.columnlen![c];
          }
        } else {
          columnlen_new[c + count] = cfg.columnlen![c];
        }
      });

      _.forEach(cfg.colReadOnly, (v, cstr) => {
        const c = parseFloat(cstr);
        if (c < index) {
          columnReadOnly_new[c] = cfg.colReadOnly![c];
        } else if (c > index) {
          columnReadOnly_new[c + count] = cfg.colReadOnly![c];
        }
      });

      cfg.columnlen = columnlen_new;
      cfg.colReadOnly = columnReadOnly_new;
    }

    // 自定义列宽配置变动
    if (cfg.customWidth != null) {
      const customWidth_new: any = {};

      _.forEach(cfg.customWidth, (v, cstr) => {
        const c = parseFloat(cstr);

        if (c < index) {
          customWidth_new[c] = cfg.customWidth![c];
        } else if (c === index) {
          if (direction === 'lefttop') {
            customWidth_new[c + count] = cfg.customWidth![c];
          } else if (direction === 'rightbottom') {
            customWidth_new[c] = cfg.customWidth![c];
          }
        } else {
          customWidth_new[c + count] = cfg.customWidth![c];
        }
      });

      cfg.customWidth = customWidth_new;
    }

    const applyInsertedColSizing = count === 1;
    if (applyInsertedColSizing) {
      if (cfg.columnlen == null) {
        cfg.columnlen = {};
      }
      const newColStart = direction === 'lefttop' ? index : index + 1;
      for (let i = 0; i < count; i += 1) {
        cfg.columnlen![newColStart + i] = refColWidthsForInsert
          ? refColWidthsForInsert[0]
          : refColWidthBeforeInsert;
      }
      if (refColWidthsForInsert) {
        cfg.customWidth ||= {};
        for (let i = 0; i < count; i += 1) {
          if (refColCustomsForInsert![0] === 1) {
            cfg.customWidth[newColStart + i] = 1;
          }
        }
      } else if (refColCustomBefore === 1) {
        cfg.customWidth ||= {};
        for (let i = 0; i < count; i += 1) {
          cfg.customWidth[newColStart + i] = 1;
        }
      }
    }

    // 隐藏列配置变动
    if (cfg.colhidden != null) {
      const colhidden_new: any = {};

      _.forEach(cfg.colhidden, (v, cstr) => {
        const c = parseFloat(cstr);

        if (c < index) {
          colhidden_new[c] = cfg.colhidden![c];
        } else if (c === index) {
          if (direction === 'lefttop') {
            colhidden_new[c + count] = cfg.colhidden![c];
          } else if (direction === 'rightbottom') {
            colhidden_new[c] = cfg.colhidden![c];
          }
        } else {
          colhidden_new[c + count] = cfg.colhidden![c];
        }
      });

      cfg.colhidden = colhidden_new;
    }

    const colTemplates: any[][] = [];
    for (let ci = 0; ci < count; ci += 1) {
      const srcColIdx = usePerColTemplates ? firstTemplateCol! : index;
      colTemplates.push(
        buildTemplateColumnFromData(d, srcColIdx, count, direction),
      );
    }

    const cellBorderConfigCol: any[] = [];
    // 边框
    if (cfg.borderInfo && cfg.borderInfo.length > 0) {
      const borderInfo = [];

      for (let i = 0; i < cfg.borderInfo.length; i += 1) {
        const { rangeType } = cfg.borderInfo[i];

        if (rangeType === 'range') {
          const borderRange = cfg.borderInfo[i].range;

          const emptyRange = [];

          for (let j = 0; j < borderRange.length; j += 1) {
            let bd_c1 = borderRange[j].column[0];
            let bd_c2 = borderRange[j].column[1];

            if (direction === 'lefttop') {
              if (index <= bd_c1) {
                bd_c1 += count;
                bd_c2 += count;
              } else if (index <= bd_c2) {
                bd_c2 += count;
              }
            } else {
              if (index < bd_c1) {
                bd_c1 += count;
                bd_c2 += count;
              } else if (index < bd_c2) {
                bd_c2 += count;
              }
            }

            if (bd_c2 >= bd_c1) {
              emptyRange.push({
                row: borderRange[j].row,
                column: [bd_c1, bd_c2],
              });
            }
          }

          if (emptyRange.length > 0) {
            const bd_obj = {
              rangeType: 'range',
              borderType: cfg.borderInfo[i].borderType,
              style: cfg.borderInfo[i].style,
              color: cfg.borderInfo[i].color,
              range: emptyRange,
            };

            borderInfo.push(bd_obj);
          }
        } else if (rangeType === 'cell') {
          let { col_index } = cfg.borderInfo[i].value;
          // 位置相同标识边框相关 先缓存
          if (!usePerColTemplates && col_index === index) {
            cellBorderConfigCol.push(
              JSON.parse(JSON.stringify(cfg.borderInfo[i])),
            );
          }

          if (direction === 'lefttop') {
            if (index <= col_index) {
              col_index += count;
            }
          } else {
            if (index < col_index) {
              col_index += count;
            }
          }

          cfg.borderInfo[i].value.col_index = col_index;
          borderInfo.push(cfg.borderInfo[i]);
        }
      }

      cfg.borderInfo = borderInfo;
    }

    const prevFormatRangesCol = cfg.cellFormatRanges;
    cfg.cellFormatRanges = shiftCellFormatRangesOnInsert(
      cfg.cellFormatRanges,
      'column',
      index,
      count,
      direction,
    );
    if (!_.isEqual(prevFormatRangesCol, cfg.cellFormatRanges)) {
      emitCellFormatRangesToYdoc(ctx, id, cfg.cellFormatRanges);
    }

    for (let i = 0; i < count; i += 1) {
      const srcColIdx = usePerColTemplates ? firstTemplateCol! : index;
      let bordersToDupCol: any[] = [];
      if (usePerColTemplates) {
        bordersToDupCol = colBorderSnapshot
          .filter(
            (bi: any) =>
              bi.rangeType === 'cell' && bi.value.col_index === srcColIdx,
          )
          .map((bi: any) => JSON.parse(JSON.stringify(bi)));
      } else if (cellBorderConfigCol.length) {
        bordersToDupCol = _.cloneDeep(cellBorderConfigCol);
      }
      if (bordersToDupCol.length) {
        bordersToDupCol.forEach((item) => {
          if (direction === 'rightbottom') {
            item.value.col_index += i + 1;
          } else if (direction === 'lefttop') {
            item.value.col_index += i;
          }
        });
        cfg.borderInfo?.push(...bordersToDupCol);
      }
    }

    for (let r = 0; r < d.length; r += 1) {
      const row = d[r];
      const insertValues = colTemplates.map((tpl) => tpl[r]);
      if (direction === 'lefttop') {
        row.splice(index, 0, ...insertValues);
      } else {
        row.splice(index + 1, 0, ...insertValues);
      }
    }
  }

  // 修改当前sheet页时刷新
  file.data = d;
  file.config = cfg;
  file.calcChain = newCalcChain;
  if (newFilterObj != null) {
    file.filter = newFilterObj.filter;
    file.filter_select = newFilterObj.filter_select;
  }
  file.luckysheet_conditionformat_save = newCFarr;
  file.luckysheet_alternateformat_save = newAFarr;

  if (snapRowDv) {
    const newRowStart = direction === 'lefttop' ? index : index + 1;
    for (let i = 0; i < count; i += 1) {
      const destR = newRowStart + i;
      _.forEach(snapRowDv[0], (item, cStr) => {
        const c = Number(cStr);
        newDataVerification[`${destR}_${c}`] = _.cloneDeep(item);
      });
    }
  }
  if (snapColDv) {
    const newColStart = direction === 'lefttop' ? index : index + 1;
    for (let i = 0; i < count; i += 1) {
      const destC = newColStart + i;
      _.forEach(snapColDv[0], (item, rStr) => {
        const r = Number(rStr);
        newDataVerification[`${r}_${destC}`] = _.cloneDeep(item);
      });
    }
  }

  if (usePerRowTemplates && CFarr != null && CFarr.length > 0) {
    const newRowStart = direction === 'lefttop' ? index : index + 1;
    for (let i = 0; i < count; i += 1) {
      const srcRow = firstTemplateRow!;
      const destRow = newRowStart + i;
      for (let k = 0; k < CFarr.length; k += 1) {
        const srcCf = CFarr[k];
        const mappedRanges = (srcCf.cellrange || [])
          .filter((rg: any) => srcRow >= rg.row[0] && srcRow <= rg.row[1])
          .map((rg: any) => ({
            row: [destRow, destRow],
            column: [rg.column[0], rg.column[1]],
          }));
        if (mappedRanges.length > 0) {
          const cfClone = _.cloneDeep(srcCf);
          cfClone.cellrange = mappedRanges;
          newCFarr.push(cfClone);
        }
      }
    }
  }
  if (usePerColTemplates && CFarr != null && CFarr.length > 0) {
    const newColStart = direction === 'lefttop' ? index : index + 1;
    for (let i = 0; i < count; i += 1) {
      const srcCol = firstTemplateCol!;
      const destCol = newColStart + i;
      for (let k = 0; k < CFarr.length; k += 1) {
        const srcCf = CFarr[k];
        const mappedRanges = (srcCf.cellrange || [])
          .filter((rg: any) => srcCol >= rg.column[0] && srcCol <= rg.column[1])
          .map((rg: any) => ({
            row: [rg.row[0], rg.row[1]],
            column: [destCol, destCol],
          }));
        if (mappedRanges.length > 0) {
          const cfClone = _.cloneDeep(srcCf);
          cfClone.cellrange = mappedRanges;
          newCFarr.push(cfClone);
        }
      }
    }
  }

  file.dataVerification = newDataVerification;
  file.hyperlink = newHyperlink;
  if (file.id === ctx.currentSheetId) {
    ctx.config = cfg;
    // jfrefreshgrid_adRC(
    //   d,
    //   cfg,
    //   "addRC",
    //   {
    //     index,
    //     len: value,
    //     direction,
    //     rc: type1,
    //     restore: false,
    //   },
    //   newCalcChain,
    //   newFilterObj,
    //   newCFarr,
    //   newAFarr,
    //   newFreezen,
    //   newDataVerification,
    //   newHyperlink
    // );
  }

  let range = null;
  if (type === 'row') {
    if (direction === 'lefttop') {
      range = [
        { row: [index, index + count - 1], column: [0, d[0].length - 1] },
      ];
    } else {
      range = [
        { row: [index + 1, index + count], column: [0, d[0].length - 1] },
      ];
    }
    file.row = file.data.length;
  } else {
    if (direction === 'lefttop') {
      range = [{ row: [0, d.length - 1], column: [index, index + count - 1] }];
    } else {
      range = [{ row: [0, d.length - 1], column: [index + 1, index + count] }];
    }
    file.column = file.data[0]?.length;
  }

  if (changeSelection) {
    file.luckysheet_select_save = range;
    if (file.id === ctx.currentSheetId) {
      ctx.luckysheet_select_save = range;
      // selectHightlightShow();
    }
  }

  refreshLocalMergeData(merge_new, file);

  // Inserted template cells keep style but strip content → format-only. Those
  // never enter celldata; migrate them into cellFormatRanges so refresh keeps bg.
  if (range) {
    const migrated = migrateFormatOnlyCellsFromData(
      cfg.cellFormatRanges,
      d as any[][],
      range[0].row[0],
      range[0].row[1],
      range[0].column[0],
      range[0].column[1],
    );
    if (migrated.changed) {
      cfg.cellFormatRanges = migrated.ranges;
      file.config = cfg;
      if (file.id === ctx.currentSheetId) {
        ctx.config = cfg;
      }
      emitCellFormatRangesToYdoc(ctx, id, cfg.cellFormatRanges);
    }
  }

  const namedRangeNames = shiftDefinedNamesOnInsert(
    ctx,
    id,
    type,
    index,
    count,
    direction,
  );
  if (namedRangeNames.length > 0) {
    refreshFormulasUsingDefinedNames(ctx, namedRangeNames);
  }

  // Yjs: row/col insertion shifts many cells; emit the disturbed range.
  const mergeBounds = getMergeBounds(cfg.merge);
  if (type === 'row') {
    const baseStart = direction === 'lefttop' ? index : index + 1;
    const startR = mergeBounds
      ? Math.min(baseStart, mergeBounds.minR)
      : baseStart;
    emitCellRangeToYdoc(
      ctx,
      id,
      d as any[][],
      startR,
      d.length - 1,
      0,
      (d[0]?.length ?? 1) - 1,
      ydocBeforePersisted,
    );
  } else {
    const baseStart = direction === 'lefttop' ? index : index + 1;
    const startC = mergeBounds
      ? Math.min(baseStart, mergeBounds.minC)
      : baseStart;
    emitCellRangeToYdoc(
      ctx,
      id,
      d as any[][],
      0,
      d.length - 1,
      startC,
      (d[0]?.length ?? 1) - 1,
      ydocBeforePersisted,
    );
  }

  // if (type === "row") {
  //   const scrollLeft = $("#luckysheet-cell-main").scrollLeft();
  //   const scrollTop = $("#luckysheet-cell-main").scrollTop();
  //   const winH = $("#luckysheet-cell-main").height();
  //   const winW = $("#luckysheet-cell-main").width();

  //   const row = ctx.visibledatarow[range[0].row[1]];
  //   const row_pre =
  //     range[0].row[0] - 1 === -1 ? 0 : ctx.visibledatarow[range[0].row[0] - 1];

  //   if (row - scrollTop - winH + 20 > 0) {
  //     $("#luckysheet-scrollbar-y").scrollTop(row - winH + 20);
  //   } else if (row_pre - scrollTop - 20 < 0) {
  //     $("#luckysheet-scrollbar-y").scrollTop(row_pre - 20);
  //   }

  //   if (value > 30) {
  //     $("#luckysheet-row-count-show").hide();
  //   }
  // }
}

export function deleteRowCol(
  ctx: Context,
  op: {
    type: 'row' | 'column';
    start: number;
    end: number;
    id?: string;
    /** Internal: when true, do not re-split row ranges by visibility under filter. */
    skipFilterVisibleOnly?: boolean;
  },
) {
  const { type } = op;
  let { start, end, id } = op;
  id = id || ctx.currentSheetId;

  // if (
  //   type == "row" &&
  //   !checkProtectionAuthorityNormal(sheetId, "deleteRows")
  // ) {
  //   return;
  // }
  // if (
  //   type == "column" &&
  //   !checkProtectionAuthorityNormal(sheetId, "deleteColumns")
  // ) {
  //   return;
  // }

  const curOrder = getSheetIndex(ctx, id);
  if (curOrder == null) return;

  const file = ctx.luckysheetfile[curOrder];
  if (!file) return;
  const cfg = file.config || {};
  // Ensure manual-hidden provenance exists for this sheet config.
  const filterUnionExisting = getFilterHiddenRowsUnionFromFilterMap(
    file.filter as any,
  );
  if (cfg.rowhidden_manual == null) {
    cfg.rowhidden_manual = _.omit(
      cfg.rowhidden || {},
      _.keys(filterUnionExisting),
    );
  }
  cfg.rowhidden_filter = filterUnionExisting;
  cfg.rowhidden = _.assign({}, cfg.rowhidden_manual, filterUnionExisting);
  if (type === 'row') {
    for (let r = start; r <= end; r += 1) {
      if (cfg.rowReadOnly?.[r]) {
        throw new Error('readOnly');
      }
    }
  } else {
    for (let c = start; c <= end; c += 1) {
      if (cfg.colReadOnly?.[c]) {
        throw new Error('readOnly');
      }
    }
  }

  const d = file.data;
  if (!d) return;

  if (start < 0) {
    start = 0;
  }

  if (end < 0) {
    end = 0;
  }

  if (type === 'row') {
    if (start > d.length - 1) {
      start = d.length - 1;
    }

    if (end > d.length - 1) {
      end = d.length - 1;
    }
  } else {
    if (start > d[0].length - 1) {
      start = d[0].length - 1;
    }

    if (end > d[0].length - 1) {
      end = d[0].length - 1;
    }
  }

  if (start > end) {
    return;
  }

  // Under an active filter, deleting a row range should delete only rows that are currently
  // visible (i.e. not hidden by filter *or* manual hide). This matches Excel-like behavior.
  if (
    type === 'row' &&
    !op.skipFilterVisibleOnly &&
    !_.isEmpty(file.filter_select) &&
    !_.isEmpty(file.filter) &&
    cfg.rowhidden != null
  ) {
    const visibleRows: number[] = [];
    for (let r = start; r <= end; r += 1) {
      if (cfg.rowhidden?.[r] != null) continue;
      visibleRows.push(r);
    }
    if (visibleRows.length === 0) return;

    // If the visible rows form multiple segments, delete segments bottom-up so indices stay stable.
    const segments: { start: number; end: number }[] = [];
    let segStart = visibleRows[0]!;
    let prev = visibleRows[0]!;
    for (let i = 1; i < visibleRows.length; i += 1) {
      const cur = visibleRows[i]!;
      if (cur === prev + 1) {
        prev = cur;
        continue;
      }
      segments.push({ start: segStart, end: prev });
      segStart = cur;
      prev = cur;
    }
    segments.push({ start: segStart, end: prev });

    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const seg = segments[i]!;
      deleteRowCol(ctx, {
        type: 'row',
        start: seg.start,
        end: seg.end,
        id,
        skipFilterVisibleOnly: true,
      });
    }
    return;
  }

  const slen = end - start + 1;

  const deleteSnapBounds = getDeleteRowColSnapshotBounds(
    type,
    start,
    d.length,
    d[0]?.length ?? 1,
    getMergeBounds(cfg.merge),
  );
  const ydocBeforePersisted = snapshotPersistedCelldataInRange(
    d,
    deleteSnapBounds.r1,
    deleteSnapBounds.r2,
    deleteSnapBounds.c1,
    deleteSnapBounds.c2,
    file.celldata,
  );

  // 合并单元格配置变动
  if (cfg.merge == null) {
    cfg.merge = {};
  }

  const merge_new: any = {};
  _.forEach(cfg.merge, (mc) => {
    const { r } = mc;
    const { c } = mc;
    const { rs } = mc;
    const { cs } = mc;

    if (type === 'row') {
      if (r < start) {
        if (r + rs - 1 < start) {
          merge_new[`${r}_${c}`] = { r, c, rs, cs };
        } else if (r + rs - 1 >= start && r + rs - 1 < end) {
          merge_new[`${r}_${c}`] = { r, c, rs: start - r, cs };
        } else if (r + rs - 1 >= end) {
          merge_new[`${r}_${c}`] = { r, c, rs: rs - slen, cs };
        }
      } else if (r >= start && r <= end) {
        if (r + rs - 1 > end) {
          merge_new[`${start}_${c}`] = {
            r: start,
            c,
            rs: r + rs - 1 - end,
            cs,
          };
        }
      } else if (r > end) {
        merge_new[`${r - slen}_${c}`] = { r: r - slen, c, rs, cs };
      }
    } else if (type === 'column') {
      if (c < start) {
        if (c + cs - 1 < start) {
          merge_new[`${r}_${c}`] = { r, c, rs, cs };
        } else if (c + cs - 1 >= start && c + cs - 1 < end) {
          merge_new[`${r}_${c}`] = { r, c, rs, cs: start - c };
        } else if (c + cs - 1 >= end) {
          merge_new[`${r}_${c}`] = { r, c, rs, cs: cs - slen };
        }
      } else if (c >= start && c <= end) {
        if (c + cs - 1 > end) {
          merge_new[`${r}_${start}`] = {
            r,
            c: start,
            rs,
            cs: c + cs - 1 - end,
          };
        }
      } else if (c > end) {
        merge_new[`${r}_${c - slen}`] = { r, c: c - slen, rs, cs };
      }
    }
  });
  cfg.merge = merge_new;

  // 公式配置变动
  const newCalcChain = [];
  for (
    let SheetIndex = 0;
    SheetIndex < ctx.luckysheetfile.length;
    SheetIndex += 1
  ) {
    if (
      _.isNil(ctx.luckysheetfile[SheetIndex].calcChain) ||
      ctx.luckysheetfile.length === 0
    ) {
      continue;
    }
    const { calcChain } = ctx.luckysheetfile[SheetIndex];
    const { data } = ctx.luckysheetfile[SheetIndex];
    for (let i = 0; i < calcChain!.length; i += 1) {
      const calc: any = _.cloneDeep(calcChain![i]);
      const calc_r = calc.r;
      const calc_c = calc.c;
      const calc_i = calc.id;
      const calc_funcStr = getcellFormula(ctx, calc_r, calc_c, calc_i);

      if (type === 'row' && SheetIndex === curOrder) {
        if (calc_r < start || calc_r > end) {
          const functionStr = `=${functionStrChange(
            calc_funcStr,
            'del',
            'row',
            null,
            start,
            slen,
          )}`;

          if (data![calc_r]?.[calc_c]?.f === calc_funcStr) {
            data![calc_r]![calc_c]!.f = functionStr;
            if (functionStr.includes('#REF!'))
              markCellRefError(data![calc_r]![calc_c]!);
          }

          if (calc_r > end) {
            calc.r = calc_r - slen;
          }

          newCalcChain.push(calc);
        }
      } else if (type === 'row') {
        const functionStr = `=${functionStrChange(
          calc_funcStr,
          'del',
          'row',
          null,
          start,
          slen,
        )}`;

        if (data?.[calc_r]?.[calc_c]?.f === calc_funcStr) {
          data[calc_r]![calc_c]!.f = functionStr;
          if (functionStr === '=#REF!')
            markCellRefError(data[calc_r]![calc_c]!);
        }
      } else if (type === 'column' && SheetIndex === curOrder) {
        if (calc_c < start || calc_c > end) {
          const functionStr = `=${functionStrChange(
            calc_funcStr,
            'del',
            'col',
            null,
            start,
            slen,
          )}`;

          if (data![calc_r]?.[calc_c]?.f === calc_funcStr) {
            data![calc_r]![calc_c]!.f = functionStr;
            if (functionStr.includes('#REF!'))
              markCellRefError(data![calc_r]![calc_c]!);
          }

          if (calc_c > end) {
            calc.c = calc_c - slen;
          }

          newCalcChain.push(calc);
        }
      } else if (type === 'column') {
        const functionStr = `=${functionStrChange(
          calc_funcStr,
          'del',
          'col',
          null,
          start,
          slen,
        )}`;

        if (data?.[calc_r]?.[calc_c]?.f === calc_funcStr) {
          data[calc_r]![calc_c]!.f = functionStr;
          if (functionStr === '=#REF!')
            markCellRefError(data[calc_r]![calc_c]!);
        }
      }
    }
    rewriteFormulasByScanningSheet(
      ctx.luckysheetfile[SheetIndex],
      calcChain,
      'del',
      type === 'row' ? 'row' : 'col',
      null,
      start,
      slen,
    );
  }

  // 筛选配置变动
  const { filter_select } = file;
  const { filter } = file;
  let newFilterObj: any = null;
  if (!_.isEmpty(filter_select) && filter_select != null) {
    newFilterObj = { filter_select: null, filter: null };

    let f_r1 = filter_select.row[0];
    let f_r2 = filter_select.row[1];
    let f_c1 = filter_select.column[0];
    let f_c2 = filter_select.column[1];

    if (type === 'row') {
      if (f_r1 > end) {
        f_r1 -= slen;
        f_r2 -= slen;

        newFilterObj.filter_select = {
          row: [f_r1, f_r2],
          column: [f_c1, f_c2],
        };
      } else if (f_r1 < start) {
        if (f_r2 < start) {
        } else if (f_r2 <= end) {
          f_r2 = start - 1;
        } else {
          f_r2 -= slen;
        }

        newFilterObj.filter_select = {
          row: [f_r1, f_r2],
          column: [f_c1, f_c2],
        };
      }

      if (newFilterObj.filter_select != null && filter != null) {
        _.forEach(filter, (v, k) => {
          const f_rowhidden = filter[k].rowhidden;
          const f_rowhidden_new: any = {};
          _.forEach(f_rowhidden, (v1, nstr) => {
            const n = parseFloat(nstr);

            if (n < start) {
              f_rowhidden_new[n] = 0;
            } else if (n > end) {
              f_rowhidden_new[n - slen] = 0;
            }
          });

          if (!_.isEmpty(f_rowhidden_new)) {
            if (newFilterObj.filter == null) {
              newFilterObj.filter = {};
            }

            newFilterObj.filter[k] = _.cloneDeep(filter[k]);
            newFilterObj.filter[k].rowhidden = f_rowhidden_new;
            newFilterObj.filter[k].str = f_r1;
            newFilterObj.filter[k].edr = f_r2;
          }
        });
      }
    } else if (type === 'column') {
      if (f_c1 > end) {
        f_c1 -= slen;
        f_c2 -= slen;

        newFilterObj.filter_select = {
          row: [f_r1, f_r2],
          column: [f_c1, f_c2],
        };
      } else if (f_c1 < start) {
        if (f_c2 < start) {
        } else if (f_c2 <= end) {
          f_c2 = start - 1;
        } else {
          f_c2 -= slen;
        }

        newFilterObj.filter_select = {
          row: [f_r1, f_r2],
          column: [f_c1, f_c2],
        };
      } else {
        if (f_c2 > end) {
          f_c1 = start;
          f_c2 -= slen;

          newFilterObj.filter_select = {
            row: [f_r1, f_r2],
            column: [f_c1, f_c2],
          };
        }
      }

      if (newFilterObj.filter_select != null && filter != null) {
        _.forEach(filter, (v, k) => {
          let f_cindex = filter[k].cindex;

          if (f_cindex < start) {
            if (newFilterObj.filter == null) {
              newFilterObj.filter = {};
            }

            newFilterObj.filter[f_cindex - f_c1] = _.cloneDeep(filter[k]);
            newFilterObj.filter[f_cindex - f_c1].edc = f_c2;
          } else if (f_cindex > end) {
            f_cindex -= slen;

            if (newFilterObj.filter == null) {
              newFilterObj.filter = {};
            }

            newFilterObj.filter[f_cindex - f_c1] = _.cloneDeep(filter[k]);
            newFilterObj.filter[f_cindex - f_c1].cindex = f_cindex;
            newFilterObj.filter[f_cindex - f_c1].stc = f_c1;
            newFilterObj.filter[f_cindex - f_c1].edc = f_c2;
          }
        });
      }
    }
  }

  // Rebuild `cfg.rowhidden` as render-time union: manual ∪ filterHidden.
  const filterHiddenAfterDelete =
    newFilterObj?.filter != null
      ? getFilterHiddenRowsUnionFromFilterMap(newFilterObj.filter)
      : getFilterHiddenRowsUnionFromFilterMap(filter as any);
  cfg.rowhidden_filter = filterHiddenAfterDelete;
  cfg.rowhidden = _.assign(
    {},
    cfg.rowhidden_manual || {},
    filterHiddenAfterDelete,
  );

  // 条件格式配置变动
  const CFarr = file.luckysheet_conditionformat_save;
  const newCFarr = [];
  if (CFarr != null && CFarr.length > 0) {
    for (let i = 0; i < CFarr.length; i += 1) {
      const cf_range = CFarr[i].cellrange;
      const cf_new_range = [];

      for (let j = 0; j < cf_range.length; j += 1) {
        let CFr1 = cf_range[j].row[0];
        let CFr2 = cf_range[j].row[1];
        let CFc1 = cf_range[j].column[0];
        let CFc2 = cf_range[j].column[1];

        if (type === 'row') {
          if (!(CFr1 >= start && CFr2 <= end)) {
            if (CFr1 > end) {
              CFr1 -= slen;
              CFr2 -= slen;
            } else if (CFr1 < start) {
              if (CFr2 < start) {
              } else if (CFr2 <= end) {
                CFr2 = start - 1;
              } else {
                CFr2 -= slen;
              }
            } else {
              if (CFr2 > end) {
                CFr1 = start;
                CFr2 -= slen;
              }
            }

            cf_new_range.push({ row: [CFr1, CFr2], column: [CFc1, CFc2] });
          }
        } else if (type === 'column') {
          if (!(CFc1 >= start && CFc2 <= end)) {
            if (CFc1 > end) {
              CFc1 -= slen;
              CFc2 -= slen;
            } else if (CFc1 < start) {
              if (CFc2 < start) {
              } else if (CFc2 <= end) {
                CFc2 = start - 1;
              } else {
                CFc2 -= slen;
              }
            } else {
              if (CFc2 > end) {
                CFc1 = start;
                CFc2 -= slen;
              }
            }

            cf_new_range.push({ row: [CFr1, CFr2], column: [CFc1, CFc2] });
          }
        }
      }

      if (cf_new_range.length > 0) {
        const cf = _.clone(CFarr[i]);
        cf.cellrange = cf_new_range;

        newCFarr.push(cf);
      }
    }
  }

  // 交替颜色配置变动
  const AFarr = file.luckysheet_alternateformat_save;
  const newAFarr = [];
  if (AFarr != null && AFarr.length > 0) {
    for (let i = 0; i < AFarr.length; i += 1) {
      let AFr1 = AFarr[i].cellrange.row[0];
      let AFr2 = AFarr[i].cellrange.row[1];
      let AFc1 = AFarr[i].cellrange.column[0];
      let AFc2 = AFarr[i].cellrange.column[1];

      if (type === 'row') {
        if (!(AFr1 >= start && AFr2 <= end)) {
          const af = _.clone(AFarr[i]);

          if (AFr1 > end) {
            AFr1 -= slen;
            AFr2 -= slen;
          } else if (AFr1 < start) {
            if (AFr2 < start) {
            } else if (AFr2 <= end) {
              AFr2 = start - 1;
            } else {
              AFr2 -= slen;
            }
          } else {
            if (AFr2 > end) {
              AFr1 = start;
              AFr2 -= slen;
            }
          }

          af.cellrange = { row: [AFr1, AFr2], column: [AFc1, AFc2] };

          newAFarr.push(af);
        }
      } else if (type === 'column') {
        if (!(AFc1 >= start && AFc2 <= end)) {
          const af = _.clone(AFarr[i]);

          if (AFc1 > end) {
            AFc1 -= slen;
            AFc2 -= slen;
          } else if (AFc1 < start) {
            if (AFc2 < start) {
            } else if (AFc2 <= end) {
              AFc2 = start - 1;
            } else {
              AFc2 -= slen;
            }
          } else {
            if (AFc2 > end) {
              AFc1 = start;
              AFc2 -= slen;
            }
          }

          af.cellrange = { row: [AFr1, AFr2], column: [AFc1, AFc2] };

          newAFarr.push(af);
        }
      }
    }
  }

  // 冻结配置变动
  const { frozen } = file;
  if (frozen) {
    if (
      type === 'row' &&
      (frozen.type === 'rangeRow' || frozen.type === 'rangeBoth')
    ) {
      if ((frozen.range?.row_focus ?? -1) >= start) {
        frozen.range!.row_focus -=
          Math.min(end, frozen.range!.row_focus) - start + 1;
      }
    }
    if (
      type === 'column' &&
      (frozen.type === 'rangeColumn' || frozen.type === 'rangeBoth')
    ) {
      if ((frozen.range?.column_focus ?? -1) >= start) {
        frozen.range!.column_focus -=
          Math.min(end, frozen.range!.column_focus) - start + 1;
      }
    }
  }

  // 数据验证配置变动
  const { dataVerification } = file;
  const newDataVerification: any = {};
  if (dataVerification != null) {
    _.forEach(dataVerification, (v, key) => {
      const r = Number(key.split('_')[0]);
      const c = Number(key.split('_')[1]);
      const item = dataVerification[key];

      if (type === 'row') {
        if (r < start) {
          newDataVerification[`${r}_${c}`] = item;
        } else if (r > end) {
          newDataVerification[`${r - slen}_${c}`] = item;
        }
      } else if (type === 'column') {
        if (c < start) {
          newDataVerification[`${r}_${c}`] = item;
        } else if (c > end) {
          newDataVerification[`${r}_${c - slen}`] = item;
        }
      }
    });
  }

  // 超链接配置变动
  const { hyperlink } = file;
  const newHyperlink: any = {};
  if (hyperlink != null) {
    _.forEach(hyperlink, (v, key) => {
      const r = Number(key.split('_')[0]);
      const c = Number(key.split('_')[1]);
      const item = hyperlink[key];

      if (type === 'row') {
        if (r < start) {
          newHyperlink[`${r}_${c}`] = item;
        } else if (r > end) {
          newHyperlink[`${r - slen}_${c}`] = item;
        }
      } else if (type === 'column') {
        if (c < start) {
          newHyperlink[`${r}_${c}`] = item;
        } else if (c > end) {
          newHyperlink[`${r}_${c - slen}`] = item;
        }
      }
    });
  }

  // 主逻辑
  let type1;
  if (type === 'row') {
    type1 = 'r';

    // 行高配置变动
    if (cfg.rowlen == null) {
      cfg.rowlen = {};
    }

    const rowlen_new: any = {};
    const rowReadOnly_new: Record<number, number> = {};
    _.forEach(cfg.rowlen, (v, rstr) => {
      const r = parseFloat(rstr);
      if (r < start) {
        rowlen_new[r] = cfg.rowlen![r];
      } else if (r > end) {
        rowlen_new[r - slen] = cfg.rowlen![r];
      }
    });
    _.forEach(cfg.rowReadOnly, (v, rstr) => {
      const r = parseFloat(rstr);
      if (r < start) {
        rowReadOnly_new[r] = cfg.rowReadOnly![r];
      } else if (r > end) {
        rowReadOnly_new[r - slen] = cfg.rowReadOnly![r];
      }
    });

    cfg.rowlen = rowlen_new;
    cfg.rowReadOnly = rowReadOnly_new;

    // 隐藏行配置变动（manual provenance only; `cfg.rowhidden` is rebuilt as union later）
    const rowhidden_manual_new: Record<string, number> = {};
    _.forEach(cfg.rowhidden_manual || {}, (v, rstr) => {
      const r = parseFloat(rstr);
      if (r < start) {
        rowhidden_manual_new[r] = (cfg.rowhidden_manual as any)[r];
      } else if (r > end) {
        rowhidden_manual_new[r - slen] = (cfg.rowhidden_manual as any)[r];
      }
    });
    cfg.rowhidden_manual = rowhidden_manual_new;
    // Keep render-time union in sync after shifting manual rows.
    const filterHiddenNow =
      newFilterObj?.filter != null
        ? getFilterHiddenRowsUnionFromFilterMap(newFilterObj.filter)
        : getFilterHiddenRowsUnionFromFilterMap(filter as any);
    cfg.rowhidden_filter = filterHiddenNow;
    cfg.rowhidden = _.assign({}, cfg.rowhidden_manual, filterHiddenNow);

    // 自定义行高配置变动
    if (cfg.customHeight == null) {
      cfg.customHeight = {};

      const customHeight_new: any = {};
      _.forEach(cfg.customHeight, (v, rstr) => {
        const r = parseFloat(rstr);
        if (r < start) {
          customHeight_new[r] = cfg.customHeight![r];
        } else if (r > end) {
          customHeight_new[r - slen] = cfg.customHeight![r];
        }
      });

      cfg.customHeight = customHeight_new;
    }

    // 自定义行高配置变动
    if (cfg.customHeight == null) {
      cfg.customHeight = {};

      const customHeight_new: any = {};
      _.forEach(cfg.customHeight, (v, rstr) => {
        const r = parseFloat(rstr);
        if (r < start) {
          customHeight_new[r] = cfg.customHeight![r];
        } else if (r > end) {
          customHeight_new[r - slen] = cfg.customHeight![r];
        }
      });

      cfg.customHeight = customHeight_new;
    }

    // `cfg.rowhidden` will be recomputed after filter adjustments.

    // 边框配置变动
    if (cfg.borderInfo && cfg.borderInfo.length > 0) {
      const borderInfo = [];

      for (let i = 0; i < cfg.borderInfo.length; i += 1) {
        const { rangeType } = cfg.borderInfo[i];

        if (rangeType === 'range') {
          const borderRange = cfg.borderInfo[i].range;

          const emptyRange = [];

          for (let j = 0; j < borderRange.length; j += 1) {
            let bd_r1 = borderRange[j].row[0];
            let bd_r2 = borderRange[j].row[1];

            for (let r = start; r <= end; r += 1) {
              if (r < borderRange[j].row[0]) {
                bd_r1 -= 1;
                bd_r2 -= 1;
              } else if (r <= borderRange[j].row[1]) {
                bd_r2 -= 1;
              }
            }

            if (bd_r2 >= bd_r1) {
              emptyRange.push({
                row: [bd_r1, bd_r2],
                column: borderRange[j].column,
              });
            }
          }

          if (emptyRange.length > 0) {
            const bd_obj = {
              rangeType: 'range',
              borderType: cfg.borderInfo[i].borderType,
              style: cfg.borderInfo[i].style,
              color: cfg.borderInfo[i].color,
              range: emptyRange,
            };

            borderInfo.push(bd_obj);
          }
        } else if (rangeType === 'cell') {
          const { row_index } = cfg.borderInfo[i].value;

          if (row_index < start) {
            borderInfo.push(cfg.borderInfo[i]);
          } else if (row_index > end) {
            cfg.borderInfo[i].value.row_index = row_index - (end - start + 1);
            borderInfo.push(cfg.borderInfo[i]);
          }
        }
      }

      cfg.borderInfo = borderInfo;
    }

    // 备注：该处理方式会在删除多行的时候会存在bug
    // 说明：删除多行后，会把同一个row空数组(引用类型)添加成为data多行的数据源，导致设置这些行数据时产生错误。
    // 空白行模板
    // let row = [];
    // for (let c = 0; c < d[0].length; c++) {
    //     row.push(null);
    // }

    // //删除选中行
    // d.splice(st, slen);

    // //删除多少行，增加多少行空白行
    // for (let r = 0; r < slen; r++) {
    //     d.push(row);
    // }

    // 删除选中行
    d.splice(start, slen);

    // 删除行后，调整行数
    file.row = d.length;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    type1 = 'c';

    // 列宽配置变动
    if (cfg.columnlen == null) {
      cfg.columnlen = {};
    }

    const columnlen_new: any = {};
    const columnReadOnly_new: any = {};
    _.forEach(cfg.columnlen, (v, cstr) => {
      const c = parseFloat(cstr);
      if (c < start) {
        columnlen_new[c] = cfg.columnlen![c];
      } else if (c > end) {
        columnlen_new[c - slen] = cfg.columnlen![c];
      }
    });
    _.forEach(cfg.colReadOnly, (v, cstr) => {
      const c = parseFloat(cstr);
      if (c < start) {
        columnReadOnly_new[c] = cfg.colReadOnly![c];
      } else if (c > end) {
        columnReadOnly_new[c - slen] = cfg.colReadOnly![c];
      }
    });

    cfg.columnlen = columnlen_new;
    cfg.colReadOnly = columnReadOnly_new;

    // 自定义列宽配置变动
    if (cfg.customWidth == null) {
      cfg.customWidth = {};

      const customWidth_new: any = {};
      _.forEach(cfg.customWidth, (v, rstr) => {
        const r = parseFloat(rstr);
        if (r < start) {
          customWidth_new[r] = cfg.customWidth![r];
        } else if (r > end) {
          customWidth_new[r - slen] = cfg.customWidth![r];
        }
      });

      cfg.customWidth = customWidth_new;
    }
    cfg.colReadOnly = columnReadOnly_new;

    // 隐藏列配置变动
    if (cfg.colhidden == null) {
      cfg.colhidden = {};
    }

    const colhidden_new: any = {};
    _.forEach(cfg.colhidden, (v, cstr) => {
      const c = parseFloat(cstr);
      if (c < start) {
        colhidden_new[c] = cfg.colhidden![c];
      } else if (c > end) {
        colhidden_new[c - slen] = cfg.colhidden![c];
      }
    });

    cfg.colhidden = colhidden_new;

    // 边框配置变动
    if (cfg.borderInfo && cfg.borderInfo.length > 0) {
      const borderInfo = [];

      for (let i = 0; i < cfg.borderInfo.length; i += 1) {
        const { rangeType } = cfg.borderInfo[i];

        if (rangeType === 'range') {
          const borderRange = cfg.borderInfo[i].range;

          const emptyRange = [];

          for (let j = 0; j < borderRange.length; j += 1) {
            let bd_c1 = borderRange[j].column[0];
            let bd_c2 = borderRange[j].column[1];

            for (let c = start; c <= end; c += 1) {
              if (c < borderRange[j].column[0]) {
                bd_c1 -= 1;
                bd_c2 -= 1;
              } else if (c <= borderRange[j].column[1]) {
                bd_c2 -= 1;
              }
            }

            if (bd_c2 >= bd_c1) {
              emptyRange.push({
                row: borderRange[j].row,
                column: [bd_c1, bd_c2],
              });
            }
          }

          if (emptyRange.length > 0) {
            const bd_obj = {
              rangeType: 'range',
              borderType: cfg.borderInfo[i].borderType,
              style: cfg.borderInfo[i].style,
              color: cfg.borderInfo[i].color,
              range: emptyRange,
            };

            borderInfo.push(bd_obj);
          }
        } else if (rangeType === 'cell') {
          const { col_index } = cfg.borderInfo[i].value;

          if (col_index < start) {
            borderInfo.push(cfg.borderInfo[i]);
          } else if (col_index > end) {
            cfg.borderInfo[i].value.col_index = col_index - (end - start + 1);
            borderInfo.push(cfg.borderInfo[i]);
          }
        }
      }

      cfg.borderInfo = borderInfo;
    }

    for (let r = 0; r < d.length; r += 1) {
      // 删除选中列
      d[r].splice(start, slen);
    }

    // 删除列后，调整列数
    file.column = d[0]?.length;
  }

  // 选中元素被删取消选区
  ctx.luckysheet_select_save = undefined;

  // 修改当前sheet页时刷新
  file.data = d;
  file.config = cfg;
  file.calcChain = newCalcChain;
  if (newFilterObj != null) {
    file.filter = newFilterObj.filter;
    file.filter_select = newFilterObj.filter_select;
  }
  file.luckysheet_conditionformat_save = newCFarr;
  file.luckysheet_alternateformat_save = newAFarr;
  file.dataVerification = newDataVerification;
  file.hyperlink = newHyperlink;

  refreshLocalMergeData(merge_new, file);

  const prevFormatRangesDelete = cfg.cellFormatRanges;
  cfg.cellFormatRanges = shiftCellFormatRangesOnDelete(
    cfg.cellFormatRanges,
    type,
    start,
    end,
  );
  if (!_.isEqual(prevFormatRangesDelete, cfg.cellFormatRanges)) {
    emitCellFormatRangesToYdoc(ctx, id, cfg.cellFormatRanges);
  }

  const namedRangeNames = shiftDefinedNamesOnDelete(ctx, id, type, start, end);
  if (namedRangeNames.length > 0) {
    refreshFormulasUsingDefinedNames(ctx, namedRangeNames);
  }

  // Yjs: row/col deletion shifts many cells; emit the disturbed range.
  const mergeBounds = getMergeBounds(cfg.merge);
  if (type === 'row') {
    const startR = mergeBounds ? Math.min(start, mergeBounds.minR) : start;
    emitCellRangeToYdoc(
      ctx,
      id,
      d as any[][],
      startR,
      d.length - 1,
      0,
      (d[0]?.length ?? 1) - 1,
      ydocBeforePersisted,
    );
  } else {
    const startC = mergeBounds ? Math.min(start, mergeBounds.minC) : start;
    emitCellRangeToYdoc(
      ctx,
      id,
      d as any[][],
      0,
      d.length - 1,
      startC,
      (d[0]?.length ?? 1) - 1,
      ydocBeforePersisted,
    );
  }
  // Range diffs never visit coords past the new grid — delete those ghosts.
  emitCelldataDeletesBeyondGrid(
    ctx,
    id,
    ydocBeforePersisted,
    d.length,
    d[0]?.length ?? 0,
  );

  if (file.id === ctx.currentSheetId) {
    ctx.config = cfg;
    // Structural edits rewrite formula strings (and may create/remove circular dependencies).
    // Trigger a dependent-aware recalculation so:
    // - values update
    // - dependency graph is refreshed (used for #CIRC! detection/propagation)
    const touchedFormulaCells: { r: number; c: number; i: string }[] = (
      newCalcChain || []
    ).map((calc: { r: number; c: number; id: string }) => ({
      r: calc.r,
      c: calc.c,
      i: ctx.currentSheetId,
    }));
    if (touchedFormulaCells.length > 0) {
      ctx.formulaCache.execFunctionExist = touchedFormulaCells;
      // @ts-expect-error: full-sheet recalc passes null for origin_r/c/value/id
      execFunctionGroup(ctx, null, null, null, null, getFlowdata(ctx));
      ctx.formulaCache.execFunctionExist = undefined;
    }
  } else {
  }
}

// 计算表格行高数组
export function computeRowlenArr(ctx: Context, rowHeight: number, cfg: any) {
  const rowlenArr = [];
  let rh_height = 0;

  for (let i = 0; i < rowHeight; i += 1) {
    let rowlen = ctx.defaultrowlen;

    if (cfg.rowlen != null && cfg.rowlen[i] != null) {
      rowlen = cfg.rowlen[i];
    }

    if (cfg.rowhidden != null && cfg.rowhidden[i] != null) {
      rowlen = cfg.rowhidden[i];
      rowlenArr.push(rh_height);
      continue;
    } else {
      rh_height += rowlen + 1;
    }

    rowlenArr.push(rh_height); // 行的临时长度分布
  }

  return rowlenArr;
}

// 隐藏选中行列
export function hideSelected(ctx: Context, type: string) {
  if (!ctx.luckysheet_select_save || ctx.luckysheet_select_save.length > 1)
    return 'noMulti';
  const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
  // 隐藏行
  if (type === 'row') {
    // Manual hide writes `rowhidden_manual`; `rowhidden` remains the render-time union.
    ensureManualHiddenInitialized(ctx);
    /* TODO: 工作表保护判断
    if (
      !checkProtectionAuthorityNormal(Store.currentSheetIndex, "formatRows")
    ) {
      return ;
    } */
    const rowhidden = ctx.config.rowhidden_manual ?? {};
    const r1 = ctx.luckysheet_select_save[0].row[0];
    const r2 = ctx.luckysheet_select_save[0].row[1];
    const rowhiddenNumber = r2;
    for (let r = r1; r <= r2; r += 1) {
      rowhidden[r] = 0;
    }
    /* 保存撤销,luck中保存撤销用以下方式实现，而在本项目中不需要另外处理
      if(Store.clearjfundo){
        let redo = {};
        redo["type"] = "showHidRows";
        redo["sheetIndex"] = Store.currentSheetIndex;
        redo["config"] = $.extend(true, {}, Store.config);
        redo["curconfig"] = cfg;

        Store.jfundo.length  = 0;
        Store.jfredo.push(redo);
    } */
    ctx.config.rowhidden_manual = rowhidden;
    rebuildRowHiddenUnion(ctx);
    const rowLen = ctx.luckysheetfile[index].data!.length;
    /**
     * 计算要隐藏的行是否是最后一列
     * 符合最后一列的条件：要隐藏的index===表格的长度-1 或者
     * 记录隐藏数组里面的数-1===要隐藏的index
     */
    const isEndRow =
      rowLen - 1 === rowhiddenNumber ||
      Object.keys(rowhidden).findIndex(
        (o) => parseInt(o, 10) - 1 === rowhiddenNumber,
      ) >= 0;
    if (isEndRow) {
      ctx.luckysheet_select_save[0].row[0] -= 1;
      ctx.luckysheet_select_save[0].row[1] -= 1;
    } else {
      ctx.luckysheet_select_save[0].row[0] += 1;
      ctx.luckysheet_select_save[0].row[1] += 1;
    }
  } else if (type === 'column') {
    // 隐藏列
    const colhidden = ctx.config.colhidden ?? {};
    const c1 = ctx.luckysheet_select_save[0].column[0];
    const c2 = ctx.luckysheet_select_save[0].column[1];
    const colhiddenNumber = c2;
    for (let c = c1; c <= c2; c += 1) {
      colhidden[c] = 0;
    }
    ctx.config.colhidden = colhidden;
    const columnLen = ctx.luckysheetfile[index].data![0].length;
    // 计算要隐藏的列是否是最后一列
    const isEndColumn =
      columnLen - 1 === colhiddenNumber ||
      Object.keys(colhidden).findIndex(
        (o) => parseInt(o, 10) - 1 === colhiddenNumber,
      ) >= 0;
    if (isEndColumn) {
      ctx.luckysheet_select_save[0].column[0] -= 1;
      ctx.luckysheet_select_save[0].column[1] -= 1;
    } else {
      ctx.luckysheet_select_save[0].column[0] += 1;
      ctx.luckysheet_select_save[0].column[1] += 1;
    }
  }
  ctx.luckysheetfile[index].config = ctx.config;
  return '';
}

// 取消隐藏选中行列
export function showSelected(ctx: Context, type: string) {
  if (!ctx.luckysheet_select_save || ctx.luckysheet_select_save.length > 1)
    return 'noMulti';
  const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
  // 取消隐藏行
  if (type === 'row') {
    ensureManualHiddenInitialized(ctx);
    const rowhidden = ctx.config.rowhidden_manual ?? {};
    const r1 = ctx.luckysheet_select_save[0].row[0];
    const r2 = ctx.luckysheet_select_save[0].row[1];
    for (let r = r1; r <= r2; r += 1) {
      delete rowhidden[r];
    }
    ctx.config.rowhidden_manual = rowhidden;
    rebuildRowHiddenUnion(ctx);
  } else if (type === 'column') {
    // 取消隐藏列
    const colhidden = ctx.config.colhidden ?? {};
    const c1 = ctx.luckysheet_select_save[0].column[0];
    const c2 = ctx.luckysheet_select_save[0].column[1];
    for (let c = c1; c <= c2; c += 1) {
      delete colhidden[c];
    }
    ctx.config.colhidden = colhidden;
  }
  ctx.luckysheetfile[index].config = ctx.config;
  return '';
}

// 判断当前选区是不是隐藏行列
export function isShowHidenCR(ctx: Context): boolean {
  if (
    !ctx.luckysheet_select_save ||
    (!ctx.config.colhidden && !ctx.config.rowhidden)
  )
    return false;
  // 如果当先选区处在隐藏行列的时候则不可编辑
  if (!!ctx.config.colhidden && _.size(ctx.config.colhidden) >= 1) {
    const ctxColumn = ctx.luckysheet_select_save[0]?.column?.[0];
    const isHidenColumn =
      Object.keys(ctx.config.colhidden).findIndex((o) => {
        return ctxColumn === parseInt(o, 10);
      }) >= 0;
    if (isHidenColumn) {
      return true;
    }
  }
  if (!!ctx.config.rowhidden && _.size(ctx.config.rowhidden) >= 1) {
    const ctxRow = ctx.luckysheet_select_save[0]?.row?.[0];
    const isHidenRow =
      Object.keys(ctx.config.rowhidden).findIndex((o) => {
        return ctxRow === parseInt(o, 10);
      }) >= 0;
    if (isHidenRow) {
      return true;
    }
  }
  return false;
}

// 计算键盘选区中要经过的隐藏行列的个数
export function hideCRCount(ctx: Context, type: string): number {
  let count = 1;
  if (!ctx.luckysheet_select_save) return 0;
  const section = ctx.luckysheet_select_save[0];
  const rowhidden = ctx.config.rowhidden ?? {};
  const colhidden = ctx.config.colhidden ?? {};
  if (type === 'ArrowUp' || type === 'ArrowDown') {
    const rowArr = Object.keys(rowhidden);
    if (type === 'ArrowUp') {
      let row = section.row[0] - 1;
      const rowIndex = rowArr.indexOf(row.toString());
      for (let i = rowIndex; i >= 0; i -= 1) {
        if (parseInt(rowArr[i], 10) === row) {
          count += 1;
          row -= 1;
        } else {
          return count;
        }
      }
    } else {
      let row = section.row[0] + 1;
      const rowIndex = rowArr.indexOf(`${row}`);
      for (let i = rowIndex; i < rowArr.length; i += 1) {
        if (parseInt(rowArr[i], 10) === row) {
          count += 1;
          row += 1;
        } else {
          return count;
        }
      }
    }
  } else if (type === 'ArrowLeft' || type === 'ArrowRight') {
    const columnArr = Object.keys(colhidden);
    if (type === 'ArrowLeft') {
      let column = section.column[0] - 1;
      const columnIndex = columnArr.indexOf(column.toString());
      for (let i = columnIndex; i >= 0; i -= 1) {
        if (parseInt(columnArr[i], 10) === column) {
          count += 1;
          column -= 1;
        } else {
          return count;
        }
      }
    } else {
      let column = section.column[0] + 1;
      const columnIndex = columnArr.indexOf(`${column}`);
      for (let i = columnIndex; i < columnArr.length; i += 1) {
        if (parseInt(columnArr[i], 10) === column) {
          count += 1;
          column += 1;
        } else {
          return count;
        }
      }
    }
  }

  return count;
}
