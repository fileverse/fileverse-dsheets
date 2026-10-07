import type { CellFormatRange } from '../../../core/utils/range-format';
import {
  addSheet,
  api,
  Cell,
  Context,
  deleteRowCol,
  deleteSheet,
  insertRowCol,
  Op,
  opToPatch,
  Range,
  Selection,
  Presence,
  Settings,
  SingleRange,
  createFilterOptions,
  applySheetFilterState,
  getSheetIndex,
  Sheet,
  locale,
  setCaretPosition,
  CellMatrix,
  CellWithRowAndCol,
  newComment,
  setEditingComment,
  getFlowdata,
  GlobalCache,
  LiveQueryData,
  execFunctionGroup,
  jfrefreshgrid,
  isFormulaEvalPending,
  sanitizeSheetIframes,
} from '@sheet-engine/core';
import { applyPatches } from 'immer';
import _ from 'lodash';
import { getCryptoPrice } from '../../utils/cryptoApi';
import { SetContextOptions } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { SplitColumn } from '../../components/SplitColumn';
import ConditionRules from '../ConditionFormat/ConditionRules';

export function generateAPIs(
  context: Context,
  setContext: (
    recipe: (ctx: Context) => void,
    options?: SetContextOptions,
  ) => void,
  handleUndo: () => void,
  handleRedo: () => void,
  settings: Required<Settings>,
  cellInput: HTMLDivElement | null,
  scrollbarX: HTMLDivElement | null,
  scrollbarY: HTMLDivElement | null,
  globalCache: GlobalCache | null,
  refs: any,
) {
  return {
    applyOp: (ops: Op[]) => {
      setContext(
        (ctx_) => {
          const [patches, specialOps] = opToPatch(ctx_, ops);
          if (specialOps.length > 0) {
            const [specialOp] = specialOps;
            if (specialOp.op === 'insertRowCol') {
              try {
                insertRowCol(ctx_, specialOp.value, false);
              } catch (e: any) {
                console.error(e);
              }
            } else if (specialOp.op === 'deleteRowCol') {
              deleteRowCol(ctx_, specialOp.value);
            } else if (specialOp.op === 'addSheet') {
              const name = patches.filter(
                (path) => path.path[0] === 'name',
              )?.[0]?.value;
              if (specialOp.value?.id) {
                addSheet(
                  ctx_,
                  settings,
                  specialOp.value.id,
                  false,
                  name,
                  specialOp.value,
                );
              }
              // 添加addSheet完后，给sheet初始化data
              const fileIndex = getSheetIndex(
                ctx_,
                specialOp.value.id,
              ) as number;
              api.initSheetData(ctx_, fileIndex, specialOp.value);
            } else if (specialOp.op === 'deleteSheet') {
              deleteSheet(ctx_, specialOp.value.id);
              patches.length = 0;
            }
          }
          if (ops[0]?.path?.[0] === 'filter_select')
            ctx_.luckysheet_filter_save = ops[0].value;
          else if (ops[0]?.path?.[0] === 'hide') {
            //  hide sheet
            if (ctx_.currentSheetId === ops[0].id) {
              const shownSheets = ctx_.luckysheetfile.filter(
                (sheet) =>
                  (_.isUndefined(sheet.hide) || sheet?.hide !== 1) &&
                  sheet.id !== ops[0].id,
              );
              ctx_.currentSheetId = _.sortBy(
                shownSheets,
                (sheet) => sheet.order,
              )[0].id as string;
            }
          }
          createFilterOptions(ctx_, ctx_.luckysheet_filter_save, ops[0]?.id);
          if (patches.length === 0) return;
          try {
            applyPatches(ctx_, patches);
          } catch (e) {
            console.error(e);
          }
        },
        { noHistory: true },
      );
    },

    getCryptoPrice,

    /** Runs the formula engine on every cell in calcChain (all sheets). Use after XLSX import so values are computed, not cached from the file. */
    recalculateAllFormulas: () => {
      setContext((draftCtx) => {
        execFunctionGroup(
          draftCtx,
          // origin cell is unused when isForce=true; toolbar uses null with @ts-ignore
          null as unknown as number,
          null as unknown as number,
          null,
          undefined,
          undefined,
          true,
        );
        // Force a canvas/data refresh pass without re-running formulas.
        // Without this, formula results can be written but not painted until a later refresh.
        try {
          jfrefreshgrid(draftCtx, null, undefined, false);
        } catch (e) {
          // Intentionally ignore; refresh best-effort.
        }
        // Async eval still needs execFunctionGlobalData across chunks — clear when done.
        if (!isFormulaEvalPending(draftCtx)) {
          draftCtx.formulaCache.execFunctionGlobalData = null;
        }
      });
    },

    getCellValue: (
      row: number,
      column: number,
      options: api.CommonOptions & { type?: keyof Cell } = {},
    ) => api.getCellValue(context, row, column, options),

    onboardingActiveCell: (functionName: string) => {
      const { functionlist } = locale(context);
      const last =
        context.luckysheet_select_save?.[
        context.luckysheet_select_save.length - 1
        ];
      let row_index = last?.row_focus;
      let col_index = last?.column_focus;
      if (!last) {
        row_index = 0;
        col_index = 0;
      } else {
        if (row_index == null) {
          [row_index] = last.row;
        }
        if (col_index == null) {
          [col_index] = last.column;
        }
      }
      const formulaTxt = `<span>=</span><span>${functionName}</span><span>(</span>`;
      setContext((ctx) => {
        if (cellInput != null) {
          ctx.luckysheetCellUpdate = [row_index, col_index];
          cellInput.innerHTML = formulaTxt;
          const spans = cellInput.childNodes;
          if (!_.isEmpty(spans)) {
            setCaretPosition(
              ctx,
              spans[spans.length - 1] as HTMLSpanElement,
              0,
              1,
            );
          }
          ctx.functionHint = functionName;
          ctx.functionCandidates = [];
          if (_.isEmpty(ctx.formulaCache.functionlistMap)) {
            for (let i = 0; i < functionlist.length; i += 1) {
              ctx.formulaCache.functionlistMap[functionlist[i].n] =
                functionlist[i];
            }
          }
        }
      });
    },

    initializeComment: (row: number, column: number) => {
      setContext((ctx) => {
        newComment(ctx, undefined, row, column);
      });
    },

    openCommentUI: (row: number, column: number) => {
      setContext((ctx) => {
        const flowdata = getFlowdata(ctx);
        if (!flowdata?.[row]?.[column]?.ps) return;
        setEditingComment(ctx, flowdata, row, column);
      });
    },
    updateSheetLiveQueryList: (subsheetIndex: number, _data: LiveQueryData) => {
      setContext((ctx) => {
        const previousLiveQuery =
          ctx.luckysheetfile[subsheetIndex].liveQueryList;
        ctx.luckysheetfile[subsheetIndex] = {
          ...ctx.luckysheetfile[subsheetIndex],
          liveQueryList: {
            ...previousLiveQuery,
            [`${_data.data.id}`]: _data,
          },
        };
      });
    },
    removeFromLiveQueryList: (subSheetIndex: number, id: string) => {
      setContext((ctx) => {
        const previousLiveQuery = {
          ...ctx.luckysheetfile[subSheetIndex].liveQueryList,
        };
        delete previousLiveQuery?.[id];
        ctx.luckysheetfile[subSheetIndex] = {
          ...ctx.luckysheetfile[subSheetIndex],
          liveQueryList: previousLiveQuery,
        };
      });
    },

    setCellValue: (
      row: number,
      column: number,
      value: any,

      options: api.CommonOptions & { type?: keyof Cell } = {},
      callAfterUpdate?: boolean,
    ) =>
      setContext((draftCtx) =>
        api.setCellValue(
          draftCtx,
          row,
          column,
          value,
          cellInput,
          options,
          callAfterUpdate,
        ),
      ),

    /**
     * Apply a cell value coming from a remote RTC peer, verbatim.
     *
     * Use this (instead of `setCellValue`) for every Yjs-driven remote apply:
     * it writes the synced value/formula as-is without running the formula
     * engine and without firing local-edit hooks, while keeping formula cells
     * registered in `calcChain` so they remain reactive to future local edits.
     */
    applyRemoteCellValue: (
      row: number,
      column: number,
      value: any,
      options: api.CommonOptions & { type?: keyof Cell } = {},
    ) =>
      setContext((draftCtx) =>
        api.applyRemoteCellValue(draftCtx, row, column, value, options),
      ),

    setCellError: (
      row: number,
      column: number,
      errorMessage: { title: string; message: string },
    ) => {
      setContext((draftCtx) => {
        api.setCellError(draftCtx, row, column, errorMessage);
      });
    },

    clearCellError: (row: number, column: number) => {
      setContext((draftCtx) => {
        api.clearCellError(draftCtx, row, column);
      });
    },

    clearCell: (row: number, column: number, options: api.CommonOptions = {}) =>
      setContext((draftCtx) => api.clearCell(draftCtx, row, column, options)),

    setCellFormat: (
      row: number,
      column: number,
      attr: keyof Cell,
      value: any,
      options: api.CommonOptions = {},
    ) =>
      setContext((draftCtx) =>
        api.setCellFormat(draftCtx, row, column, attr, value, options),
      ),

    autoFillCell: (
      copyRange: SingleRange,
      applyRange: SingleRange,
      direction: 'up' | 'down' | 'left' | 'right',
    ) =>
      setContext((draftCtx) =>
        api.autoFillCell(draftCtx, copyRange, applyRange, direction),
      ),

    freeze: (
      type: 'row' | 'column' | 'both',
      range: { row: number; column: number },
      options: api.CommonOptions = {},
    ) => setContext((draftCtx) => api.freeze(draftCtx, type, range, options)),

    insertRowOrColumn: (
      type: 'row' | 'column',
      index: number,
      count: number,
      direction: 'lefttop' | 'rightbottom' = 'rightbottom',
      options: api.CommonOptions = {},
    ) =>
      setContext((draftCtx) =>
        api.insertRowOrColumn(draftCtx, type, index, count, direction, options),
      ),

    deleteRowOrColumn: (
      type: 'row' | 'column',
      start: number,
      end: number,
      options: api.CommonOptions = {},
    ) =>
      setContext((draftCtx) =>
        api.deleteRowOrColumn(draftCtx, type, start, end, options),
      ),

    hideRowOrColumn: (rowOrColInfo: string[], type: 'row' | 'column') =>
      setContext((draftCtx) =>
        api.hideRowOrColumn(draftCtx, rowOrColInfo, type),
      ),

    showRowOrColumn: (rowOrColInfo: string[], type: 'row' | 'column') =>
      setContext((draftCtx) =>
        api.showRowOrColumn(draftCtx, rowOrColInfo, type),
      ),

    setRowHeight: (
      rowInfo: Record<string, number>,
      options: api.CommonOptions = {},
      custom: boolean = false,
    ) =>
      setContext((draftCtx) =>
        api.setRowHeight(draftCtx, rowInfo, options, custom),
      ),

    setColumnWidth: (
      columnInfo: Record<string, number>,
      options: api.CommonOptions = {},
      custom: boolean = false,
    ) =>
      setContext((draftCtx) =>
        api.setColumnWidth(draftCtx, columnInfo, options, custom),
      ),

    getRowHeight: (rows: number[], options: api.CommonOptions = {}) =>
      api.getRowHeight(context, rows, options),

    getColumnWidth: (columns: number[], options: api.CommonOptions = {}) =>
      api.getColumnWidth(context, columns, options),

    getSelection: () => api.getSelection(context),

    getFlattenRange: (range: Range) => api.getFlattenRange(context, range),

    getCellsByFlattenRange: (range?: { r: number; c: number }[]) =>
      api.getCellsByFlattenRange(context, range),

    getSelectionCoordinates: () => api.getSelectionCoordinates(context),

    getCellsByRange: (range: Selection, options: api.CommonOptions = {}) =>
      api.getCellsByRange(context, range, options),

    getHtmlByRange: (range: Range, options: api.CommonOptions = {}) =>
      api.getHtmlByRange(context, range, options),

    setSelection: (range: Range, options: api.CommonOptions = {}) =>
      setContext((draftCtx) => api.setSelection(draftCtx, range, options)),

    setCellValuesByRange: (
      data: any[][],
      range: SingleRange,

      options: api.CommonOptions = {},
      cellAfter?: boolean,
    ) =>
      setContext((draftCtx) =>
        api.setCellValuesByRange(
          draftCtx,
          data,
          range,
          cellInput,
          options,
          cellAfter,
        ),
      ),

    setCellFormatByRange: (
      attr: keyof Cell,
      value: any,
      range: Range | SingleRange,
      options: api.CommonOptions = {},
    ) =>
      setContext((draftCtx) =>
        api.setCellFormatByRange(draftCtx, attr, value, range, options),
      ),

    mergeCells: (
      ranges: Range,
      type: string,
      options: api.CommonOptions = {},
    ) =>
      setContext((draftCtx) => api.mergeCells(draftCtx, ranges, type, options)),

    cancelMerge: (ranges: Range, options: api.CommonOptions = {}) =>
      setContext((draftCtx) => api.cancelMerge(draftCtx, ranges, options)),

    getAllSheets: () => api.getAllSheets(context),

    getSheet: (options: api.CommonOptions = {}) =>
      api.getSheetWithLatestCelldata(context, options),

    addSheet: () => setContext((draftCtx) => api.addSheet(draftCtx, settings)),

    deleteSheet: (options: api.CommonOptions = {}) =>
      setContext((draftCtx) => api.deleteSheet(draftCtx, options)),

    updateSheet: (data: Sheet[]) =>
      setContext((draftCtx) => api.updateSheet(draftCtx, data)),

    activateSheet: (options: api.CommonOptions = {}) =>
      setContext((draftCtx) => api.activateSheet(draftCtx, options)),

    setSheetName: (name: string, options: api.CommonOptions = {}) =>
      setContext((draftCtx) => api.setSheetName(draftCtx, name, options)),

    setSheetOrder: (orderList: Record<string, number>) =>
      setContext((draftCtx) => api.setSheetOrder(draftCtx, orderList)),

    // Replace a sheet's image overlay array imperatively. Used by the RTC
    // remote-apply path to reposition images without a full Workbook remount:
    // images render from `insertedImgs` (active sheet) backed by
    // `luckysheetfile[idx].images`. Updates both so the overlay repositions and
    // the data survives the next remount/sheet-switch.
    setSheetImages: (images: any[], options: api.CommonOptions = {}) =>
      setContext((draftCtx) => {
        const idx = getSheetIndex(
          draftCtx,
          options.id ?? draftCtx.currentSheetId,
        );
        if (idx == null) return;
        draftCtx.luckysheetfile[idx].images = images;
        if (draftCtx.luckysheetfile[idx].id === draftCtx.currentSheetId) {
          draftCtx.insertedImgs = images;
        }
      }),

    // Replace a sheet's iframe overlay array imperatively. Iframes render from
    // `luckysheetfile[idx].iframes` (memoized); `insertedIframes` is kept in
    // sync for parity with the remount init path.
    setSheetIframes: (iframes: any[], options: api.CommonOptions = {}) =>
      setContext((draftCtx) => {
        const idx = getSheetIndex(
          draftCtx,
          options.id ?? draftCtx.currentSheetId,
        );
        if (idx == null) return;
        const safeIframes = sanitizeSheetIframes(iframes);
        draftCtx.luckysheetfile[idx].iframes = safeIframes;
        if (draftCtx.luckysheetfile[idx].id === draftCtx.currentSheetId) {
          draftCtx.insertedIframes = safeIframes;
        }
      }),

    // Replace a sheet's dataVerification map imperatively. Used by the RTC
    // remote-apply path so dropdown/checkbox validation rules appear on peers
    // without a full Workbook remount (which could be skipped mid-cell-edit).
    setSheetDataVerification: (
      dataVerification: Record<string, any>,
      options: api.CommonOptions = {},
    ) =>
      setContext(
        (draftCtx) => {
          const idx = getSheetIndex(
            draftCtx,
            options.id ?? draftCtx.currentSheetId,
          );
          if (idx == null) return;
          draftCtx.luckysheetfile[idx].dataVerification = dataVerification;
          try {
            jfrefreshgrid(draftCtx, null, undefined, false);
          } catch {
            // refresh best-effort
          }
        },
        { noHistory: true },
      ),

    // Apply filter + filter_select from Yjs without remount (RTC remote apply).
    setSheetFilterState: (
      state: {
        filter?: Record<string, any> | null;
        filter_select?: { row: number[]; column: number[] } | null;
      },
      options: api.CommonOptions = {},
    ) =>
      setContext(
        (draftCtx) => {
          const sheetId = options.id ?? draftCtx.currentSheetId;
          applySheetFilterState(draftCtx, sheetId, state);
          try {
            jfrefreshgrid(draftCtx, null, undefined, false);
          } catch {
            // refresh best-effort
          }
        },
        { noHistory: true },
      ),

    // Generic map-backed sheet metadata (hyperlink, conditionRules, …).
    setSheetMapField: (
      field: string,
      value: Record<string, any> | null | undefined,
      options: api.CommonOptions = {},
    ) =>
      setContext(
        (draftCtx) => {
          const idx = getSheetIndex(
            draftCtx,
            options.id ?? draftCtx.currentSheetId,
          );
          if (idx == null) return;
          (draftCtx.luckysheetfile[idx] as Record<string, any>)[field] =
            value ?? undefined;
          try {
            jfrefreshgrid(draftCtx, null, undefined, false);
          } catch {
            // refresh best-effort
          }
        },
        { noHistory: true },
      ),

    /** Merge keys into a map-backed sheet field without replacing the whole map. */
    patchSheetMapField: (
      field: string,
      updates: Record<string, any>,
      deleteKeys: string[] = [],
      options: api.CommonOptions = {},
    ) =>
      setContext(
        (draftCtx) => {
          const idx = getSheetIndex(
            draftCtx,
            options.id ?? draftCtx.currentSheetId,
          );
          if (idx == null) return;
          const file = draftCtx.luckysheetfile[idx] as Record<string, any>;
          const current = { ...(file[field] || {}) };
          Object.entries(updates).forEach(([k, v]) => {
            if (v == null) delete current[k];
            else current[k] = v;
          });
          deleteKeys.forEach((k) => {
            delete current[k];
          });
          file[field] =
            Object.keys(current).length > 0 ? current : undefined;
          try {
            jfrefreshgrid(draftCtx, null, undefined, false);
          } catch {
            // refresh best-effort
          }
        },
        { noHistory: true },
      ),

    /** Merge sub-keys into sheet.config without replacing the whole config object. */
    setSheetConfigFields: (
      partial: Record<string, any>,
      options: api.CommonOptions & { deleteKeys?: string[] } = {},
    ) =>
      setContext(
        (draftCtx) => {
          const idx = getSheetIndex(
            draftCtx,
            options.id ?? draftCtx.currentSheetId,
          );
          if (idx == null) return;
          const file = draftCtx.luckysheetfile[idx];
          file.config = file.config || {};
          const cfg = file.config as Record<string, any>;
          Object.entries(partial).forEach(([k, v]) => {
            if (v == null) delete cfg[k];
            else cfg[k] = v;
          });
          (options.deleteKeys ?? []).forEach((k) => {
            delete cfg[k];
          });
          if (file.id === draftCtx.currentSheetId) {
            draftCtx.config = file.config!;
          }

          // Format-only empty cells live in config.cellFormatRanges, not dense
          // cell objects that survive refresh. Remote RTC updates write the
          // config key but peers already have a dense `data` matrix, so we must
          // rematerialize: strip format-only cells, then re-apply ranges.
          const rangesTouched =
            Object.prototype.hasOwnProperty.call(partial, 'cellFormatRanges') ||
            (options.deleteKeys ?? []).includes('cellFormatRanges');
          if (rangesTouched && Array.isArray(file.data) && file.data.length > 0) {
            const celldata = api.dataToCelldata(file.data);
            const rebuilt = api.celldataToData(
              celldata,
              file.row,
              file.column,
              cfg.cellFormatRanges,
              cfg.merge,
            );
            if (rebuilt) {
              file.data = rebuilt;
            }
          }

          try {
            jfrefreshgrid(draftCtx, null, undefined, false);
          } catch {
            // refresh best-effort
          }
        },
        { noHistory: true },
      ),

    setSheetConditionFormatRules: (
      rules: any[],
      options: api.CommonOptions = {},
    ) =>
      setContext(
        (draftCtx) => {
          const idx = getSheetIndex(
            draftCtx,
            options.id ?? draftCtx.currentSheetId,
          );
          if (idx == null) return;
          draftCtx.luckysheetfile[idx].luckysheet_conditionformat_save = rules;
          try {
            jfrefreshgrid(draftCtx, null, undefined, false);
          } catch {
            // refresh best-effort
          }
        },
        { noHistory: true },
      ),

    scroll: (options: {
      scrollLeft?: number;
      scrollTop?: number;
      targetRow?: number;
      targetColumn?: number;
    }) => api.scroll(context, scrollbarX, scrollbarY, options),

    addPresences: (newPresences: Presence[]) => {
      setContext((draftCtx) => {
        draftCtx.presences = _.differenceBy(
          draftCtx.presences || [],
          newPresences,
          (v) => (v.userId == null ? v.username : v.userId),
        ).concat(newPresences);
      });
    },

    removePresences: (
      arr: {
        username: string;
        userId?: string;
      }[],
    ) => {
      setContext((draftCtx) => {
        if (draftCtx.presences != null) {
          draftCtx.presences = _.differenceBy(draftCtx.presences, arr, (v) =>
            v.userId == null ? v.username : v.userId,
          );
        }
      });
    },

    handleUndo,
    handleRedo,

    calculateFormula: () => {
      setContext((draftCtx) => {
        _.forEach(draftCtx.luckysheetfile, (sheet_obj) => {
          api.calculateSheetFromula(draftCtx, sheet_obj.id as string);
        });
      });
    },

    calculateSubSheetFormula: (id: string) => {
      setContext((draftCtx) => {
        api.calculateSheetFromula(draftCtx, id as string);
      });
    },

    calculateCellReferencedSubSheetFormula: (
      id: string,
      refCell?: string[],
    ) => {
      setContext((draftCtx) => {
        api.calculateReferencedCellSheetFromula(
          draftCtx,
          id as string,
          refCell,
        );
      });
    },

    dataToCelldata: (data: CellMatrix | undefined) => {
      return api.dataToCelldata(data);
    },

    celldataToData: (
      celldata: CellWithRowAndCol[],
      rowCount?: number,
      colCount?: number,
      cellFormatRanges?: CellFormatRange[],
      merge?: Record<string, any> | null,
    ) => {
      return api.celldataToData(
        celldata,
        rowCount,
        colCount,
        cellFormatRanges,
        merge,
      );
    },
    insertFunction: (
      selectedFuncIndex: number,
      filteredFunctionList: any[],
      callback?: () => void,
    ) => {
      const last =
        context.luckysheet_select_save?.[
        context.luckysheet_select_save.length - 1
        ];
      let row_index = last?.row_focus;
      let col_index = last?.column_focus;
      if (!last) {
        row_index = 0;
        col_index = 0;
      } else {
        if (row_index == null) {
          [row_index] = last.row;
        }
        if (col_index == null) {
          [col_index] = last.column;
        }
      }
      const funcName = filteredFunctionList[selectedFuncIndex].n.toUpperCase();
      const formulaTxt = `<span dir="auto" class="luckysheet-formula-text-color">=</span><span dir="auto" class="luckysheet-formula-text-color">${funcName}</span><span dir="auto" class="luckysheet-formula-text-color">(</span>`;
      const { functionlist } = locale(context);

      if (cellInput == null || globalCache == null) return;

      // Populate function metadata + caret once the formula HTML is in the editor.
      const applyFunctionState = (ctx: Context) => {
        const spans = cellInput.childNodes;
        if (!_.isEmpty(spans)) {
          setCaretPosition(ctx, spans[spans.length - 1] as HTMLSpanElement, 0, 1);
        }
        ctx.functionHint = funcName;
        ctx.functionCandidates = [];
        if (_.isEmpty(ctx.formulaCache.functionlistMap)) {
          for (let i = 0; i < functionlist.length; i += 1) {
            ctx.formulaCache.functionlistMap[functionlist[i].n] =
              functionlist[i];
          }
        }
      };

      const isEditing = (context.luckysheetCellUpdate?.length ?? 0) > 0;

      if (isEditing) {
        // Editor already active and focused: write synchronously.
        setContext((ctx) => {
          ctx.luckysheetCellUpdate = [row_index, col_index];
          globalCache.doNotUpdateCell = true;
          cellInput.innerHTML = formulaTxt;
          applyFunctionState(ctx);
          callback?.();
        });
        return;
      }

      // Cold entry (cell selected, not editing): enter edit mode first, then
      // write the formula + focus AFTER React commits the edit-mode DOM.
      // Doing both in one tick leaves the contenteditable unfocused, so the
      // insert did not take until a second click (matches the toolbar path).
      globalCache.doNotFocus = true;
      globalCache.doNotUpdateCell = true;
      setContext((ctx) => {
        ctx.luckysheetCellUpdate = [row_index, col_index];
      });
      requestAnimationFrame(() => {
        cellInput.innerHTML = formulaTxt;
        cellInput.focus({ preventScroll: true });
        setContext((ctx) => {
          applyFunctionState(ctx);
        });
        callback?.();
      });
    },
    getLocaleContext: () => {
      return locale(context);
    },
    getWorkbookContext: () => {
      return context;
    },
    getWorkbookSetContext: () => {
      return setContext;
    },
    getSettings: () => {
      return settings;
    },
    getRefs: () => refs,
    getShowDialog: () => {
      return useDialog;
    },
    getSplitColComponent: () => {
      return SplitColumn;
    },
    getConditionalFormatComponent: () => {
      return ConditionRules;
    },
  };
}
