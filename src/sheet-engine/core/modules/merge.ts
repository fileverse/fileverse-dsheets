import _ from 'lodash';
import { Context, getFlowdata } from '../context';
import { Range } from '../types';
import { getSheetIndex } from '../utils';
import { isInlineStringCT } from './inline-string';

/** Same “has content” notion as merge (plain value, inlineStr, formula, rich text). */
function cellHasMergeRelevantContent(cell: any): boolean {
  if (cell == null) return false;
  return (
    isInlineStringCT(cell.ct) ||
    !_.isEmpty(cell.v) ||
    cell.f != null ||
    // @ts-ignore
    cell.s != null ||
    (cell.ct && cell.ct.s?.length)
  );
}

/** True if any cell in the current selection has content that merge would consider. */
export function mergeSelectionHasValues(ctx: Context): boolean {
  const d = getFlowdata(ctx);
  if (!d || !ctx.luckysheet_select_save?.length) return false;

  for (let s = 0; s < ctx.luckysheet_select_save.length; s += 1) {
    const r1 = ctx.luckysheet_select_save[s].row[0];
    const r2 = ctx.luckysheet_select_save[s].row[1];
    const c1 = ctx.luckysheet_select_save[s].column[0];
    const c2 = ctx.luckysheet_select_save[s].column[1];

    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        if (cellHasMergeRelevantContent(d[r]?.[c])) return true;
      }
    }
  }
  return false;
}

export function mergeCells(
  ctx: Context,
  sheetId: string,
  ranges: Range,
  type: string,
) {
  // if (!checkIsAllowEdit()) {
  //   tooltip.info("", locale().pivotTable.errorNotAllowEdit);
  //   return;
  // }
  const idx = getSheetIndex(ctx, sheetId);
  if (idx == null) return;

  const sheet = ctx.luckysheetfile[idx];

  const cfg = sheet.config || {};
  if (cfg.merge == null) {
    cfg.merge = {};
  }

  const d = sheet.data!;

  const cellChanges: {
    sheetId: string;
    path: string[];
    key?: string;
    value: any;
    type?: 'update' | 'delete';
  }[] = [];

  // if (!checkProtectionNotEnable(ctx.currentSheetId)) {
  //   return;
  // }
  if (type === 'merge-cancel') {
    for (let i = 0; i < ranges.length; i += 1) {
      const range = ranges[i];
      const r1 = range.row[0];
      const r2 = range.row[1];
      const c1 = range.column[0];
      const c2 = range.column[1];

      if (r1 === r2 && c1 === c2) {
        continue;
      }

      const fv: any = {};

      for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
          const cell = d[r][c];

          if (cell != null && cell.mc != null) {
            const mc_r = cell.mc.r;
            const mc_c = cell.mc.c;

            if ('rs' in cell.mc) {
              delete cell.mc;
              delete cfg.merge[`${mc_r}_${mc_c}`];

              fv[`${mc_r}_${mc_c}`] = _.cloneDeep(cell) || {};
            } else {
              // The anchor cell may not have been visited yet in this pass (e.g. the
              // selection only partially overlaps the merged block, or spans multiple
              // disjoint ranges), so `fv` might not have it cached. Fall back to reading
              // the anchor straight from the grid instead of assuming traversal order,
              // so a stray/partial merge reference never crashes the merge operation.
              const anchorCell = fv[`${mc_r}_${mc_c}`] ?? d[mc_r]?.[mc_c];
              const cell_clone = _.cloneDeep(anchorCell) || {};

              delete cell_clone.v;
              delete cell_clone.m;
              delete cell_clone.ct;
              delete cell_clone.f;
              delete cell_clone.spl;

              d[r][c] = cell_clone;
              cellChanges.push({
                sheetId,
                path: ['celldata'],
                value: { r, c, v: d[r][c] },
                key: `${r}_${c}`,
                type: 'update',
              });
            }
          }
        }
      }
    }
  } else {
    let isHasMc = false; // 选区是否含有 合并的单元格

    for (let i = 0; i < ranges.length; i += 1) {
      const range = ranges[i];
      const r1 = range.row[0];
      const r2 = range.row[1];
      const c1 = range.column[0];
      const c2 = range.column[1];

      for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
          const cell = d[r][c];

          if (cell?.mc) {
            isHasMc = true;
            break;
          }
        }
      }
    }

    // If selection contains merged cells, unmerge them first before merging
    if (isHasMc) {
      // 选区有合并单元格（先取消合并，然后继续合并）
      for (let i = 0; i < ranges.length; i += 1) {
        const range = ranges[i];
        const r1 = range.row[0];
        const r2 = range.row[1];
        const c1 = range.column[0];
        const c2 = range.column[1];

        if (r1 === r2 && c1 === c2) {
          continue;
        }

        const fv: any = {};

        for (let r = r1; r <= r2; r += 1) {
          for (let c = c1; c <= c2; c += 1) {
            const cell = d[r][c];

            if (cell != null && cell.mc != null) {
              const mc_r = cell.mc.r;
              const mc_c = cell.mc.c;

              if ('rs' in cell.mc) {
                delete cell.mc;
                delete cfg.merge[`${mc_r}_${mc_c}`];

                fv[`${mc_r}_${mc_c}`] = _.cloneDeep(cell) || {};
              } else {
                // The anchor cell may not have been visited yet in this pass (e.g. the
                // selection only partially overlaps the merged block, or spans multiple
                // disjoint ranges), so `fv` might not have it cached. Fall back to reading
                // the anchor straight from the grid instead of assuming traversal order,
                // so a stray/partial merge reference never crashes the merge operation.
                const anchorCell = fv[`${mc_r}_${mc_c}`] ?? d[mc_r]?.[mc_c];
                const cell_clone = _.cloneDeep(anchorCell) || {};

                delete cell_clone.v;
                delete cell_clone.m;
                delete cell_clone.ct;
                delete cell_clone.f;
                delete cell_clone.spl;

                d[r][c] = cell_clone;
                cellChanges.push({
                  sheetId,
                  path: ['celldata'],
                  value: { r, c, v: d[r][c] },
                  key: `${r}_${c}`,
                  type: 'update',
                });
              }
            }
          }
        }
      }
    }

    // Always proceed with merge operation (whether or not there were merged cells)
    for (let i = 0; i < ranges.length; i += 1) {
      const range = ranges[i];
      const r1 = range.row[0];
      const r2 = range.row[1];
      const c1 = range.column[0];
      const c2 = range.column[1];

      if (r1 === r2 && c1 === c2) {
        continue;
      }

      if (type === 'merge-all') {
        let fv = {};
        let isfirst = false;

        for (let r = r1; r <= r2; r += 1) {
          for (let c = c1; c <= c2; c += 1) {
            const cell = d[r][c];

            if (
              cell != null &&
              (isInlineStringCT(cell.ct) ||
                !_.isEmpty(cell.v) ||
                cell.f != null ||
                // @ts-ignore
                cell.s != null ||
                (cell.ct && cell.ct.s?.length)) &&
              !isfirst
            ) {
              fv = _.cloneDeep(cell);
              isfirst = true;
            }

            d[r][c] = { mc: { r: r1, c: c1 } };
            cellChanges.push({
              sheetId,
              path: ['celldata'],
              value: { r, c, v: d[r][c] },
              key: `${r}_${c}`,
              type: 'update',
            });
          }
        }

        d[r1][c1] = fv;
        const a = d[r1][c1];
        if (!a) return;
        a.mc = { r: r1, c: c1, rs: r2 - r1 + 1, cs: c2 - c1 + 1 };
        cellChanges.push({
          sheetId,
          path: ['celldata'],
          value: { r: r1, c: c1, v: d[r1][c1] },
          key: `${r1}_${c1}`,
          type: 'update',
        });

        cfg.merge[`${r1}_${c1}`] = {
          r: r1,
          c: c1,
          rs: r2 - r1 + 1,
          cs: c2 - c1 + 1,
        };
      } else if (type === 'merge-vertical') {
        for (let c = c1; c <= c2; c += 1) {
          let fv = {};
          let isfirst = false;

          for (let r = r1; r <= r2; r += 1) {
            const cell = d[r][c];

            if (
              cell != null &&
              (isInlineStringCT(cell.ct) ||
                !_.isEmpty(cell.v) ||
                cell.f != null ||
                // @ts-ignore
                cell.s != null ||
                (cell.ct && cell.ct.s?.length)) &&
              !isfirst
            ) {
              fv = _.cloneDeep(cell);
              isfirst = true;
            }

            d[r][c] = { mc: { r: r1, c } };
            cellChanges.push({
              sheetId,
              path: ['celldata'],
              value: { r, c, v: d[r][c] },
              key: `${r}_${c}`,
              type: 'update',
            });
          }

          d[r1][c] = fv;
          const a = d[r1][c];
          if (!a) return;
          a.mc = { r: r1, c, rs: r2 - r1 + 1, cs: 1 };
          cellChanges.push({
            sheetId,
            path: ['celldata'],
            value: { r: r1, c, v: d[r1][c] },
            key: `${r1}_${c}`,
            type: 'update',
          });

          cfg.merge[`${r1}_${c}`] = {
            r: r1,
            c,
            rs: r2 - r1 + 1,
            cs: 1,
          };
        }
      } else if (type === 'merge-horizontal') {
        for (let r = r1; r <= r2; r += 1) {
          let fv = {};
          let isfirst = false;

          for (let c = c1; c <= c2; c += 1) {
            const cell = d[r][c];

            if (
              cell != null &&
              (isInlineStringCT(cell.ct) ||
                !_.isEmpty(cell.v) ||
                cell.f != null ||
                // @ts-ignore
                cell.s != null ||
                (cell.ct && cell.ct.s?.length)) &&
              !isfirst
            ) {
              fv = _.cloneDeep(cell);
              isfirst = true;
            }

            d[r][c] = { mc: { r, c: c1 } };
            cellChanges.push({
              sheetId,
              path: ['celldata'],
              value: { r, c, v: d[r][c] },
              key: `${r}_${c}`,
              type: 'update',
            });
          }

          d[r][c1] = fv;
          const a = d[r][c1];
          if (!a) return;
          a.mc = { r, c: c1, rs: 1, cs: c2 - c1 + 1 };
          cellChanges.push({
            sheetId,
            path: ['celldata'],
            value: { r, c: c1, v: d[r][c1] },
            key: `${r}_${c1}`,
            type: 'update',
          });

          cfg.merge[`${r}_${c1}`] = {
            r,
            c: c1,
            rs: 1,
            cs: c2 - c1 + 1,
          };
        }
      }
    }
  }
  if (cellChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
    ctx.hooks.updateCellYdoc(cellChanges);
  }
  sheet.config = cfg;
  if (sheet.id === ctx.currentSheetId) {
    ctx.config = cfg;
  }
}
