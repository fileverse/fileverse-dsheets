import {
  defaultContext,
  defaultSettings,
  Settings,
  Context,
  initSheetIndex,
  CellWithRowAndCol,
  GlobalCache,
  Sheet as SheetType,
  handleGlobalKeyDown,
  getSheetIndex,
  handlePaste,
  filterPatch,
  patchToOp,
  Op,
  inverseRowColOptions,
  ensureSheetIndex,
  CellMatrix,
  insertRowCol,
  deleteRowCol,
  // locale,
  // calcSelectionInfo,
  groupValuesRefresh,
  runFormulaEvalChunk,
  applyWorkerFormulaChunkResults,
  insertDuneChart,
  getFlowdata,
  api,
  handlePasteByClick,
  insertImage,
  loadImageFromFile,
  isAllowEdit,
  copyActiveImage,
  cutActiveImage,
  pasteImageItem,
  getImageClipboard,
  getImageCutSourceId,
  update, // formatting helper
  loadLocale,
  defaultLuckysheetSelectRanges,
  updateContextWithSheetData,
  jfrefreshgrid,
} from '@sheet-engine/core';
import { applyCellFormatRangesToData, getCellFormatRangeGridBounds } from '@sheet-engine/core/utils/range-format';
import { applyMergeConfigToData } from '@sheet-engine/core/utils/merge-hydrate';
import { activePalette, setActiveGridPalette, type ThemeKey } from '@sheet-engine/core/theme';
import {
  normalizeDateBaseLocale,
  setDateBaseLocale,
} from '@sheet-engine/core/modules/date-base-locale';
import {
  isBrowserZoomShortcut,
  isFindReplaceShortcut,
  isFindShortcut,
  isInsertDateShortcut,
  isInsertDateTimeShortcut,
  isInsertTimeShortcut,
  isSelectAllShortcut,
  isUsInsertDateTimeQuoteShortcut,
} from '@sheet-engine/core/events/keyboard-shortcut-utils';
import {
  FORMULA_ASYNC_CHUNK_SIZE,
  FORMULA_WORKER_CHUNK_SIZE,
  FORMULA_WORKER_THRESHOLD,
  isFormulaExecutionDebugEnabled,
  isFormulaWorkerUnsafe,
} from '@sheet-engine/core/modules/formula-async-eval';
import {
  buildWorkerEvalInput,
  evalFormulasInBackground,
  initFormulaWorkerSnapshot,
  invalidateFormulaWorkerSnapshot,
} from '@sheet-engine/core/modules/formula-worker-bridge';
import { syncAndDemoteInactiveFlowdata } from '@sheet-engine/core/api/sheet-flowdata-lifecycle';
import { ensureSheetFlowdata } from '@sheet-engine/core/api/sheet';
import { setActiveDraftContext } from '@sheet-engine/core/utils/active-draft-context';
import { clearRangeValuePassCache } from '@sheet-engine/core/modules/formula-range-cache';
import { selectionCache } from '@sheet-engine/core/modules/selection';
import React, {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
  useImperativeHandle,
} from 'react';
import './index.css';
import produce, {
  applyPatches,
  enablePatches,
  Patch,
  produceWithPatches,
} from 'immer';
import _ from 'lodash';
import { getCryptoPrice } from '../../utils/cryptoApi';
import Sheet from '../Sheet';
import WorkbookContext, { RefValues, SetContextOptions } from '../../context';
import Toolbar from '../Toolbar';
import FxEditor from '../FxEditor';
import QuickSearchBar from '../QuickSearch';
import SheetTab from '../SheetTab';
import ContextMenu from '../ContextMenu';
import SVGDefines from '../SVGDefines';
import SheetTabContextMenu from '../ContextMenu/SheetTab';
import { generateAPIs } from './api';
import { ModalProvider } from '../../context/modal';
import FilterMenu from '../ContextMenu/FilterMenu';
import SheetList from '../SheetList';
import DunePreview from '../DunePreview/DunePreview';
import {
  SidebarPanelPortals,
  type SidebarPortalRegistryHandle,
  type SidebarPortalRenderer,
} from '../SidebarPanelPortals';
// import ConditionRules from "../ConditionFormat/ConditionRules";

enablePatches();

export type WorkbookInstance = ReturnType<typeof generateAPIs>;

type AdditionalProps = {
  onOp?: (op: Op[]) => void;
  sidebarActivePanel?: string | null;
  sidebarPortalRegistry?: SidebarPortalRegistryHandle | null;
  sidebarPortalRenderers?: Record<string, SidebarPortalRenderer>;
  toolbarTrailingContent?: React.ReactNode;
  theme?: ThemeKey;
};

const triggerGroupValuesRefresh = (ctx: Context) => {
  if (ctx.groupValuesRefreshData.length > 0) {
    groupValuesRefresh(ctx);
  }
};

const concatProducer = (...producers: ((ctx: Context) => void)[]) => {
  return (ctx: Context) => {
    producers.forEach((producer) => {
      producer(ctx);
    });
  };
};

/**
 * Undo/redo patches target dense `data` paths. After demote-on-switch a sheet
 * may only have sparse celldata — hydrate first so applyPatches doesn't crash
 * or write into a missing matrix. Mutates ctx: must be called on an immer
 * draft, never on frozen state.
 */
function ensureFlowdataForDataPatches(ctx: Context, patches: Patch[]) {
  const seen = new Set<number>();
  for (let i = 0; i < patches.length; i += 1) {
    const path = patches[i].path as (string | number)[];
    if (path?.[0] !== 'luckysheetfile') continue;
    const sheetIndex = path[1];
    if (!_.isNumber(sheetIndex) || path[2] !== 'data') continue;
    if (seen.has(sheetIndex)) continue;
    seen.add(sheetIndex);
    const sheet = ctx.luckysheetfile?.[sheetIndex];
    if (sheet && !sheet.data?.length) {
      ensureSheetFlowdata(ctx, { index: sheetIndex });
    }
  }
}

/** In-cell / formula-bar editors that must still receive workbook key handling. */
function isSheetEditorElement(el: HTMLElement | null | undefined): boolean {
  if (!el || typeof el.closest !== 'function') return false;
  return !!(
    el.id === 'luckysheet-rich-text-editor' ||
    el.id === 'luckysheet-functionbox-cell' ||
    el.closest('#luckysheet-rich-text-editor') ||
    el.closest('#luckysheet-functionbox-cell') ||
    el.classList?.contains('fortune-fx-input') ||
    el.closest('.fortune-fx-input')
  );
}

/**
 * Sidebar portals (named ranges, data verification, …) render outside the
 * workbook DOM but still bubble through React to Workbook's onKeyDown. Skip
 * type-to-edit / focus-steal for real form fields in those panels.
 */
function isPortaledUiTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (isSheetEditorElement(el)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

const Workbook = React.forwardRef<WorkbookInstance, Settings & AdditionalProps>(
  (
    {
      onOp,
      data: originalData,
      isFlvReadOnly,
      sidebarActivePanel = null,
      sidebarPortalRegistry = null,
      sidebarPortalRenderers = {},
      toolbarTrailingContent,
      theme,
      ...props
    },
    ref,
  ) => {
    const globalCache = useRef<GlobalCache>({ undoList: [], redoList: [] });
    const cellInput = useRef<HTMLDivElement>(null);
    const fxInput = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const scrollbarX = useRef<HTMLDivElement>(null);
    const scrollbarY = useRef<HTMLDivElement>(null);
    const cellArea = useRef<HTMLDivElement>(null);
    const workbookContainer = useRef<HTMLDivElement>(null);
    const workbookInstanceRef = useRef<WorkbookInstance | null>(null);

    const refs: RefValues = useMemo(
      () => ({
        globalCache: globalCache.current,
        cellInput,
        fxInput,
        canvas,
        scrollbarX,
        scrollbarY,
        cellArea,
        workbookContainer,
      }),
      [],
    );

    const [context, setContext] = useState(defaultContext(refs));
    const contextRef = useRef(context);
    contextRef.current = context;
    const prevSheetIdRef = useRef<string | null>(null);
    // const { formula } = locale(context);

    const [moreToolbarItems, setMoreToolbarItems] =
      useState<React.ReactNode>(null);

    // const [calInfo, setCalInfo] = useState<{
    //   numberC: number;
    //   count: number;
    //   sum: number;
    //   max: number;
    //   min: number;
    //   average: string;
    // }>({
    //   numberC: 0,
    //   count: 0,
    //   sum: 0,
    //   max: 0,
    //   min: 0,
    //   average: "",
    // });

    const mergedSettings = useMemo(
      () => _.assign(_.cloneDeep(defaultSettings), props) as Required<Settings>,
      // props expect data, onChage, onOp
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [..._.values(props)],
    );

    // 计算选区的信息
    // useEffect(() => {
    //   const selection = context.luckysheet_select_save;
    //   const { lang } = props;
    //   if (selection) {
    //     const re = calcSelectionInfo(context, lang);
    //     setCalInfo(re);
    //   }
    //   // eslint-disable-next-line react-hooks/exhaustive-deps
    // }, [context.luckysheet_select_save]);

    const initSheetData = useCallback(
      (
        draftCtx: Context,
        newData: SheetType,
        index: number,
      ): CellMatrix | null => {
        const { celldata, row, column } = newData;
        const lastRow = _.maxBy<CellWithRowAndCol>(celldata, 'r');
        const lastCol = _.maxBy(celldata, 'c');
        let lastRowNum = (lastRow?.r ?? 0) + 1;
        let lastColNum = (lastCol?.c ?? 0) + 1;
        if (row != null && column != null && row > 0 && column > 0) {
          lastRowNum = Math.max(lastRowNum, row);
          lastColNum = Math.max(lastColNum, column);
        } else {
          lastRowNum = Math.max(lastRowNum, draftCtx.defaultrowNum);
          lastColNum = Math.max(lastColNum, draftCtx.defaultcolumnNum);
        }
        const rangeBounds = getCellFormatRangeGridBounds(
          newData.config?.cellFormatRanges,
        );
        if (rangeBounds) {
          lastRowNum = Math.max(lastRowNum, rangeBounds.maxRow + 1);
          lastColNum = Math.max(lastColNum, rangeBounds.maxCol + 1);
        }
        if (lastRowNum && lastColNum) {
          const expandedData: SheetType['data'] = _.times(lastRowNum, () =>
            _.times(lastColNum, () => null),
          );
          celldata?.forEach((d) => {
            // TODO setCellValue(draftCtx, d.r, d.c, expandedData, d.v);
            expandedData[d.r][d.c] = d.v;
            // if a date cell doesn't already have a formatted string, generate one
            const cell = d.v as any;
            if (
              cell &&
              cell.ct &&
              cell.ct.t === 'd' &&
              (cell.m === undefined || cell.m === null)
            ) {
              try {
                cell.m = update(cell.ct.fa || 'General', cell.v);
              } catch (e) {
                // fallback silently
              }
            }
          });
          applyCellFormatRangesToData(
            expandedData,
            newData.config?.cellFormatRanges,
          );
          applyMergeConfigToData(expandedData, newData.config?.merge);
          draftCtx.luckysheetfile = produce(draftCtx.luckysheetfile, (d) => {
            d[index!].data = expandedData;
            delete d[index!].celldata;
            return d;
          });
          return expandedData;
        }
        return null;
      },
      [],
    );

    const emitOp = useCallback(
      (
        ctx: Context,
        patches: Patch[],
        options?: SetContextOptions,
        undo: boolean = false,
      ) => {
        if (onOp) {
          onOp(patchToOp(ctx, patches, options, undo));
        }
      },
      [onOp],
    );

    const emitYjsFromPatches = useCallback(
      (ctxBefore: Context, ctxAfter: Context, patches: Patch[]) => {
        const { updateCellYdoc } = ctxBefore.hooks ?? {};
        if (!updateCellYdoc) return;

        const mapFields = new Set([
          'celldata',
          'calcChain',
          'dataBlockCalcFunction',
          'liveQueryList',
          'dataVerification',
          'hyperlink',
          'conditionRules',
        ]);

        // De-dupe: last patch wins for the same (sheetId + path + key).
        const changeMap = new Map<string, any>();

        const upsert = (change: any) => {
          const pathKey = Array.isArray(change.path)
            ? change.path.join('.')
            : String(change.path ?? '');
          const k = `${change.sheetId}:${pathKey}:${change.key ?? ''}`;
          changeMap.set(k, change);
        };

        const upsertCell = (sheetId: string, r: number, c: number) => {
          const cell =
            (getFlowdata(ctxAfter, sheetId) as any)?.[r]?.[c] ?? null;
          const key = `${r}_${c}`;
          upsert({
            sheetId,
            path: ['celldata'],
            key,
            value: { r, c, v: cell },
            type: cell == null ? 'delete' : 'update',
          });
        };

        // Best-effort: translate patches that touch sheet.data or any "map-like" objects keyed by "r_c".
        patches.forEach((p) => {
          const path = p.path as any[];
          if (path?.[0] !== 'luckysheetfile') return;
          const sheetIndex = path[1];
          if (!_.isNumber(sheetIndex)) return;

          const sheetBefore = ctxBefore.luckysheetfile?.[sheetIndex];
          const sheetAfter = ctxAfter.luckysheetfile?.[sheetIndex];
          const sheetId = (sheetAfter?.id || sheetBefore?.id) as
            | string
            | undefined;
          if (!sheetId) return;

          const root = path[2];

          if (root === 'data') {
            // Any patch under ["data", r, c, ...] -> update whole cell in Yjs.
            if (_.isNumber(path[3]) && _.isNumber(path[4])) {
              upsertCell(sheetId, path[3], path[4]);
              return;
            }

            // Row replacement ["data", r]
            if (_.isNumber(path[3]) && path.length === 4) {
              const r = path[3] as number;
              const beforeRow = (sheetBefore as any)?.data?.[r] ?? [];
              const afterRow = (sheetAfter as any)?.data?.[r] ?? [];
              if (beforeRow === afterRow) return;
              const max = Math.max(beforeRow.length ?? 0, afterRow.length ?? 0);
              for (let c = 0; c < max; c += 1) {
                if (beforeRow[c] === afterRow[c]) continue;
                if (!_.isEqual(beforeRow[c] ?? null, afterRow[c] ?? null)) {
                  upsertCell(sheetId, r, c);
                }
              }
              return;
            }

            // Whole-matrix replacement ["data"] (rare). Diff row-by-row instead of full-sheet rewrite.
            if (path.length === 3) {
              const dataAfter = (sheetAfter as any)?.data as
                | any[][]
                | undefined;
              const dataBefore = (sheetBefore as any)?.data as
                | any[][]
                | undefined;
              const rows = dataAfter?.length ?? 0;
              if (rows > 50000) {
                console.warn(
                  `[Yjs] undo/redo whole-matrix diff on large sheet (${rows} rows)`,
                );
              }
              for (let r = 0; r < rows; r += 1) {
                const beforeRow = dataBefore?.[r] ?? [];
                const afterRow = dataAfter?.[r] ?? [];
                if (beforeRow === afterRow) continue;
                const max = Math.max(
                  beforeRow.length ?? 0,
                  afterRow.length ?? 0,
                );
                for (let c = 0; c < max; c += 1) {
                  if (beforeRow[c] === afterRow[c]) continue;
                  if (!_.isEqual(beforeRow[c] ?? null, afterRow[c] ?? null)) {
                    upsertCell(sheetId, r, c);
                  }
                }
              }
            }
            return;
          }

          // Map-like objects on sheet keyed by "r_c": ["hyperlink", "0_1"], etc.
          if (typeof root === 'string' && mapFields.has(root)) {
            const key = path[3];
            if (typeof key === 'string') {
              upsert({
                sheetId,
                path: [root],
                key,
                value: p.value,
                type:
                  p.op === 'remove' || p.value == null ? 'delete' : 'update',
              });
            }
            return;
          }

          // Undo/redo of empty-cell formats (toolbar + paste) live here.
          // afterConfigChanges also syncs, but emit on patch so peers never miss CFR.
          if (root === 'config') {
            const configKey = path[3];
            if (
              path.length === 3 ||
              configKey === 'cellFormatRanges' ||
              configKey === 'borderInfo'
            ) {
              const cfgAfter = sheetAfter?.config;
              if (path.length === 3 || configKey === 'cellFormatRanges') {
                upsert({
                  sheetId,
                  path: ['config', 'cellFormatRanges'],
                  value: cfgAfter?.cellFormatRanges ?? [],
                  type: 'update',
                });
              }
              if (path.length === 3 || configKey === 'borderInfo') {
                upsert({
                  sheetId,
                  path: ['config', 'borderInfo'],
                  value: cfgAfter?.borderInfo ?? [],
                  type: 'update',
                });
              }
            }
          }
        });

        const changes = Array.from(changeMap.values());
        if (changes.length > 0) updateCellYdoc(changes);
      },
      [],
    );

    function reduceUndoList(ctx: Context, ctxBefore: Context) {
      const sheetsId = ctx.luckysheetfile.map((sheet) => sheet.id);
      const sheetDeletedByMe = globalCache.current.undoList
        .filter((undo) => undo.options?.deleteSheetOp)
        .map((item) => item.options?.deleteSheetOp?.id);
      globalCache.current.undoList = globalCache.current.undoList.filter(
        (undo) =>
          undo.options?.deleteSheetOp ||
          undo.options?.id === undefined ||
          _.indexOf(sheetsId, undo.options?.id) !== -1 ||
          _.indexOf(sheetDeletedByMe, undo.options?.id) !== -1,
      );
      if (ctxBefore.luckysheetfile.length > ctx.luckysheetfile.length) {
        const sheetDeleted = ctxBefore.luckysheetfile
          .filter(
            (oneSheet) =>
              _.indexOf(
                ctx.luckysheetfile.map((item) => item.id),
                oneSheet.id,
              ) === -1,
          )
          .map((item) => getSheetIndex(ctxBefore, item.id as string));
        const deletedIndex = sheetDeleted[0];
        globalCache.current.undoList = globalCache.current.undoList.map(
          (oneStep) => {
            oneStep.patches = oneStep.patches.map((onePatch) => {
              if (
                typeof onePatch.path[1] === 'number' &&
                onePatch.path[1] > (deletedIndex as number)
              ) {
                onePatch.path[1] -= 1;
              }
              return onePatch;
            });
            oneStep.inversePatches = oneStep.inversePatches.map((onePatch) => {
              if (
                typeof onePatch.path[1] === 'number' &&
                onePatch.path[1] > (deletedIndex as number)
              ) {
                onePatch.path[1] -= 1;
              }
              return onePatch;
            });
            return oneStep;
          },
        );
      }
    }

    function dataToCelldata(data: CellMatrix) {
      const cellData: CellWithRowAndCol[] = [];
      for (let row = 0; row < data?.length; row += 1) {
        for (let col = 0; col < data[row]?.length; col += 1) {
          if (data[row][col] !== null) {
            cellData.push({
              r: row,
              c: col,
              v: data[row][col],
            });
          }
        }
      }
      return cellData;
    }

    const setContextWithProduce = useCallback(
      (recipe: (ctx: Context) => void, options: SetContextOptions = {}) => {
        setContext((ctx_) => {
          const runWithDraft = (draft: Context) => {
            setActiveDraftContext(draft);
            try {
              recipe(draft);
              triggerGroupValuesRefresh(draft);
            } finally {
              setActiveDraftContext(null);
            }
          };

          if (options.noHistory) {
            return produce(ctx_, runWithDraft);
          }

          const [result, patches, inversePatches] = produceWithPatches(
            ctx_,
            runWithDraft,
          );
          if (patches.length > 0) {
            if (options.logPatch) {
              console.info('patch', patches);
            }
            const filteredPatches = filterPatch(patches);
            let filteredInversePatches = filterPatch(inversePatches);
            if (filteredInversePatches.length > 0) {
              options.id = ctx_.currentSheetId;
              if (options.deleteSheetOp) {
                const target = ctx_.luckysheetfile.filter(
                  (sheet) => sheet.id === options.deleteSheetOp?.id,
                );
                if (target) {
                  const index = getSheetIndex(
                    ctx_,
                    options.deleteSheetOp.id as string,
                  ) as number;
                  options.deletedSheet = {
                    id: options.deleteSheetOp.id as string,
                    index: index as number,
                    value: _.cloneDeep(ctx_.luckysheetfile[index]),
                  };
                  options.deletedSheet!.value!.celldata = dataToCelldata(
                    options.deletedSheet!.value!.data as CellMatrix,
                  );
                  delete options.deletedSheet!.value!.data;
                  options.deletedSheet.value!.status = 0;
                  filteredInversePatches = [
                    {
                      op: 'add',
                      path: ['luckysheetfile', 0],
                      value: options.deletedSheet.value,
                    },
                  ];
                }
              } else if (options.addSheetOp) {
                options.addSheet = {};
                options.addSheet!.id =
                  result.luckysheetfile[result.luckysheetfile.length - 1].id;
              }
              globalCache.current.undoList.push({
                patches: filteredPatches,
                inversePatches: filteredInversePatches,
                options,
              });
              globalCache.current.redoList = [];
              emitOp(result, filteredPatches, options);
            }
          } else {
            if (patches?.[0]?.value?.length < ctx_?.luckysheetfile?.length) {
              reduceUndoList(result, ctx_);
            }
          }
          return result;
        });
      },
      [emitOp],
    );

    const handleUndo = useCallback(() => {
      const history = globalCache.current.undoList.pop();
      if (history) {
        setContext((ctx_) => {
          const isBorderUndo = history.patches.some(
            (onePatch) =>
              Array.isArray(onePatch.value?.borderInfo) &&
              onePatch.value.borderInfo.length > 0,
          );

          if (history.options?.deleteSheetOp) {
            history.inversePatches[0].path[1] = ctx_.luckysheetfile.length;
            const order = history.options.deletedSheet?.value?.order as number;
            const sheetsRight = ctx_.luckysheetfile.filter(
              (sheet) =>
                (sheet?.order as number) >= (order as number) &&
                sheet.id !== history?.options?.deleteSheetOp?.id,
            );
            _.forEach(sheetsRight, (sheet) => {
              history.inversePatches.push({
                op: 'replace',
                path: [
                  'luckysheetfile',
                  getSheetIndex(ctx_, sheet.id as string) as number,
                  'order',
                ],
                value: (sheet?.order as number) + 1,
              } as Patch);
            });
          }
          ctx_ = produce(ctx_, (draft: Context) => {
            ensureFlowdataForDataPatches(draft, history.inversePatches);
          });
          let newContext = applyPatches(ctx_, history.inversePatches);
          globalCache.current.redoList.push(history);
          const inversedOptions = inverseRowColOptions(history.options);
          if (inversedOptions?.insertRowColOp) {
            inversedOptions.restoreDeletedCells = true;
          }
          if (history.options?.addSheetOp) {
            const index = getSheetIndex(
              ctx_,
              history.options.addSheet!.id as string,
            ) as number;
            inversedOptions!.addSheet = {
              id: history.options.addSheet!.id as string,
              index: index as number,
              value: _.cloneDeep(ctx_.luckysheetfile[index]),
            };
            inversedOptions!.addSheet!.value!.celldata = dataToCelldata(
              inversedOptions!.addSheet!.value?.data as CellMatrix,
            );
            delete inversedOptions!.addSheet!.value!.data;
          }
          emitOp(newContext, history.inversePatches, inversedOptions, true);
          // Emit with a mutable draft as the active context: state is frozen
          // by immer, and cellFormatRanges mirror commits write into the
          // active draft during emission.
          newContext = produce(newContext, (draft: Context) => {
            setActiveDraftContext(draft);
            try {
              emitYjsFromPatches(ctx_, draft, history.inversePatches);
            } finally {
              setActiveDraftContext(null);
            }
          });
          // Sync ctx.config from current sheet after applying inverse patches.
          // This ensures components watching context.config (e.g. Sheet.tsx which
          // recalculates visibledatacolumn) react correctly to config changes.
          const sheetIdxAfterUndo = getSheetIndex(
            newContext,
            newContext.currentSheetId,
          );
          let nw = {
            ...newContext,
            ...(sheetIdxAfterUndo != null &&
              newContext.luckysheetfile[sheetIdxAfterUndo]?.config != null
              ? {
                config: newContext.luckysheetfile[sheetIdxAfterUndo].config,
              }
              : {}),
          };
          if (isBorderUndo) {
            const nwborderlist = nw?.config?.borderInfo?.slice(0, -1);
            nw = {
              ...nw,
              config: {
                ...nw.config,
                borderInfo: nwborderlist,
              },
            };
          }
          return nw;
        });
      }
    }, [emitOp, globalCache]);

    const handleRedo = useCallback(() => {
      const history = globalCache.current.redoList.pop();
      if (history) {
        setContext((ctx_) => {
          ctx_ = produce(ctx_, (draft: Context) => {
            ensureFlowdataForDataPatches(draft, history.patches);
          });
          let newContext = applyPatches(ctx_, history.patches);
          const isBorderUndo = history.patches.some(
            (onePatch) =>
              Array.isArray(onePatch.value?.borderInfo) &&
              onePatch.value.borderInfo.length > 0,
          );

          globalCache.current.undoList.push(history);
          emitOp(newContext, history.patches, history.options);
          // Emit with a mutable draft as the active context: state is frozen
          // by immer, and cellFormatRanges mirror commits write into the
          // active draft during emission.
          newContext = produce(newContext, (draft: Context) => {
            setActiveDraftContext(draft);
            try {
              emitYjsFromPatches(ctx_, draft, history.patches);
            } finally {
              setActiveDraftContext(null);
            }
          });
          // Sync ctx.config from current sheet after applying patches.
          const sheetIdxAfterRedo = getSheetIndex(
            newContext,
            newContext.currentSheetId,
          );
          let nw = {
            ...newContext,
            ...(sheetIdxAfterRedo != null &&
              newContext.luckysheetfile[sheetIdxAfterRedo]?.config != null
              ? {
                config: newContext.luckysheetfile[sheetIdxAfterRedo].config,
              }
              : {}),
          };
          if (isBorderUndo) {
            // patches[0] is often a cell/data patch — only read borderInfo from
            // a patch that actually has it, and guard [0] (a?.b[0] still throws).
            const borderEntry = history.patches.find(
              (p) => p.value?.borderInfo != null,
            )?.value?.borderInfo?.[0];
            if (borderEntry != null) {
              nw = {
                ...nw,
                config: {
                  ...nw.config,
                  borderInfo: (nw?.config?.borderInfo ?? []).concat(
                    borderEntry,
                  ),
                },
              };
            }
          }
          return nw;
        });
      }
    }, [emitOp, globalCache]);

    useEffect(() => {
      mergedSettings.hooks?.afterActivateSheet?.(context.currentSheetId);
    }, [context.currentSheetId]);

    useEffect(() => {
      getCryptoPrice('bitcoin', 'usd');
    }, []);

    useEffect(() => {
      setContext((ctx: any) => {
        const gridData = getFlowdata(ctx);
        const cellData = api.dataToCelldata(gridData as any);
        const denominatedUsed = (cellData ?? []).some((cell: any) => {
          const value = cell?.v?.m?.toString();
          return (
            value?.includes('BTC') ||
            value?.includes('ETH') ||
            value?.includes('SOL')
          );
        });
        const denoWarn = document.getElementById('denomination-warning');
        const scrollBar = document.getElementsByClassName(
          'luckysheet-scrollbar-x',
        )[0] as HTMLElement;
        if (denominatedUsed && denoWarn) {
          denoWarn.style.display = 'block';
          denoWarn.style.left = '0px';
          if (scrollBar) {
            scrollBar.setAttribute(
              'style',
              'bottom: 36px !important; width: calc(100% - 60px);',
            );
          }
        } else if (!denominatedUsed && denoWarn) {
          denoWarn.style.display = 'none';
          denoWarn.style.left = '-9999px';
          if (scrollBar) {
            scrollBar.setAttribute(
              'style',
              'bottom: 10px !important; width: calc(100% - 60px);',
            );
          }
        }
        return ctx;
      });

      if (context.luckysheet_select_save != null) {
        mergedSettings.hooks?.afterSelectionChange?.(
          context.currentSheetId,
          context.luckysheet_select_save[0],
        );
      }
    }, [
      context.currentSheetId,
      context.luckysheet_select_save,
      mergedSettings.hooks,
    ]);

    const providerValue = useMemo(
      () => ({
        context,
        setContext: setContextWithProduce,
        settings: mergedSettings,
        handleUndo,
        handleRedo,
        refs,
      }),
      [
        context,
        handleRedo,
        handleUndo,
        mergedSettings,
        refs,
        setContextWithProduce,
      ],
    );

    useEffect(() => {
      if (context?.hooks?.sheetLengthChange) {
        context.hooks.sheetLengthChange();
      }
    }, [context.luckysheetfile.length]);

    // Repaint the canvas grid when the theme changes. Chrome themes via CSS cascade off the
    // <html> class, but the grid is JS-painted and can't read CSS vars — so swap the active
    // palette and force a full-grid redraw. No remount (that would lose scroll/selection).
    useEffect(() => {
      const changed = setActiveGridPalette(theme);
      // Publish the resolved grid palette as CSS vars so DOM overlays that must match the
      // canvas exactly — the in-cell editor box — read the same value the canvas paints with
      // (not the ui chrome token, which may differ slightly). Set on every run (incl. mount)
      // so the vars exist even when the theme never changes from the default.
      const root = document.documentElement;
      root.style.setProperty('--grid-cell-bg', activePalette.cellBg);
      root.style.setProperty('--grid-cell-text', activePalette.cellText);
      if (changed) {
        setContextWithProduce((draftCtx) => {
          jfrefreshgrid(draftCtx, null, undefined);
        });
      }
    }, [theme, setContextWithProduce]);

    const currentSheet = useMemo(() => {
      return context?.luckysheetfile?.find(
        (sheet) => sheet.id === context?.currentSheetId,
      );
    }, [context?.luckysheetfile, context?.currentSheetId]);

    useEffect(() => {
      if (context?.hooks?.calcChainChange) {
        context.hooks.calcChainChange();
      }
    }, [currentSheet?.calcChain]);

    useEffect(() => {
      if (context?.hooks?.afterImagesChange) {
        context.hooks.afterImagesChange();
      }
    }, [currentSheet?.images]);

    useEffect(() => {
      if (context?.hooks?.afterIframesChange) {
        context.hooks.afterIframesChange();
      }
    }, [currentSheet?.iframes]);

    useEffect(() => {
      if (context?.hooks?.afterFrozenChange) {
        context.hooks.afterFrozenChange();
      }
    }, [currentSheet?.frozen]);

    useEffect(() => {
      if (context?.hooks?.afterOrderChanges) {
        context.hooks.afterOrderChanges();
      }
    }, [currentSheet?.order]);

    const sheetColorSig = useMemo(() => {
      return (context?.luckysheetfile ?? [])
        .map((s) => `${s.id}:${s.color ?? ''}`)
        .join('|');
    }, [context?.luckysheetfile]);

    useEffect(() => {
      if (context?.hooks?.afterColorChanges) {
        context.hooks.afterColorChanges();
      }
    }, [sheetColorSig]);

    const sheetHideSig = useMemo(() => {
      return (context?.luckysheetfile ?? [])
        .map((s) => `${s.id}:${s.hide ?? 0}`)
        .join('|');
    }, [context?.luckysheetfile]);

    useEffect(() => {
      if (context?.hooks?.afterHideChanges) {
        context.hooks.afterHideChanges();
      }
    }, [sheetHideSig]);

    useEffect(() => {
      if (context?.hooks?.afterConfigChanges) {
        context.hooks.afterConfigChanges();
      }
    }, [currentSheet?.config]);

    useEffect(() => {
      if (context?.hooks?.afterColRowChanges) {
        context.hooks.afterColRowChanges();
      }
    }, [currentSheet?.row, currentSheet?.column]);

    useEffect(() => {
      if (context?.hooks?.afterShowGridLinesChange) {
        context.hooks.afterShowGridLinesChange();
      }
    }, [currentSheet?.showGridLines]);

    useEffect(() => {
      if (context?.hooks?.afterNameChanges) {
        context.hooks.afterNameChanges();
      }
    }, [currentSheet?.name]);

    useEffect(() => {
      if (context?.hooks?.afterStatusChanges) {
        context.hooks.afterStatusChanges();
      }
    }, [currentSheet?.status]);

    useEffect(() => {
      if (context?.hooks?.dataVerificationChange) {
        context.hooks.dataVerificationChange();
      }
    }, [currentSheet?.dataVerification]);

    useEffect(() => {
      if (context?.hooks?.liveQueryChange) {
        context.hooks.liveQueryChange();
      }
    }, [currentSheet?.liveQueryList]);

    useEffect(() => {
      if (context?.hooks?.imageListChange) {
        context.hooks.imageListChange();
      }
    }, [currentSheet?.images]);

    useEffect(() => {
      if (context?.hooks?.iframeListChange) {
        context.hooks.iframeListChange();
      }
    }, [currentSheet?.iframes]);

    useEffect(() => {
      if (context?.hooks?.conditionRulesChange) {
        context.hooks.conditionRulesChange();
      }
    }, [currentSheet?.conditionRules]);

    useEffect(() => {
      if (context?.hooks?.conditionFormatChange) {
        context.hooks.conditionFormatChange();
      }
    }, [currentSheet?.luckysheet_conditionformat_save]);

    useEffect(() => {
      if (context?.hooks?.filterSelectChange) {
        context.hooks.filterSelectChange();
      }
    }, [currentSheet?.filter_select]);

    useEffect(() => {
      if (context?.hooks?.filterChange) {
        context.hooks.filterChange();
      }
    }, [currentSheet?.filter]);

    useEffect(() => {
      if (context?.hooks?.hyperlinkChange) {
        context.hooks.hyperlinkChange();
      }
    }, [currentSheet?.hyperlink]);

    useEffect(() => {
      const init = async () => {
        const resolvedLang: string =
          mergedSettings.lang ??
          ((navigator.languages && navigator.languages[0]) ||
            navigator.language ||
            // @ts-ignore
            navigator.userLanguage ||
            'en');
        await loadLocale(resolvedLang);
        setContextWithProduce(
          (draftCtx) => {
            draftCtx.defaultcolumnNum = mergedSettings.column;
            draftCtx.defaultrowNum = mergedSettings.row;
            draftCtx.defaultFontSize = mergedSettings.defaultFontSize;
            if (_.isEmpty(draftCtx.luckysheetfile)) {
              const newData = produce(originalData, (draftData) => {
                ensureSheetIndex(draftData, mergedSettings.generateSheetId);
              });
              draftCtx.luckysheetfile = newData;
              // Inactive tabs stay sparse (celldata only). The active sheet is
              // hydrated below once currentSheetId is resolved.
            }
            if (mergedSettings.devicePixelRatio > 0) {
              draftCtx.devicePixelRatio = mergedSettings.devicePixelRatio;
            }
            draftCtx.lang = resolvedLang;
            draftCtx.dateBaseLocale = normalizeDateBaseLocale(
              mergedSettings.dateBaseLocale,
            );
            setDateBaseLocale(draftCtx.dateBaseLocale);
            draftCtx.allowEdit = mergedSettings.allowEdit;
            draftCtx.isFlvReadOnly = isFlvReadOnly ?? false;
            draftCtx.hooks = mergedSettings.hooks;
            // draftCtx.fontList = mergedSettings.fontList;
            if (_.isEmpty(draftCtx.currentSheetId)) {
              initSheetIndex(draftCtx);
            }
            let sheetIdx = getSheetIndex(draftCtx, draftCtx.currentSheetId);
            if (sheetIdx == null) {
              if ((draftCtx.luckysheetfile?.length ?? 0) > 0) {
                sheetIdx = 0;
                draftCtx.currentSheetId = draftCtx.luckysheetfile[0].id!;
              }
            }
            if (sheetIdx == null) return;

            const activeSheetId = draftCtx.currentSheetId;
            const previousSheetId = prevSheetIdRef.current;
            if (!_.isEmpty(draftCtx.luckysheetfile) && activeSheetId) {
              if (previousSheetId !== activeSheetId) {
                syncAndDemoteInactiveFlowdata(
                  draftCtx,
                  activeSheetId,
                  previousSheetId,
                );
                if (previousSheetId) {
                  invalidateFormulaWorkerSnapshot();
                }
              }
              prevSheetIdRef.current = activeSheetId;
            }

            const sheet = draftCtx.luckysheetfile?.[sheetIdx];
            if (!sheet) return;

            let { data } = sheet;
            // expand cell data
            if (_.isEmpty(data)) {
              const temp = initSheetData(draftCtx, sheet, sheetIdx);
              if (!_.isNull(temp)) {
                data = temp;
              }
            }

            if (
              _.isEmpty(draftCtx.luckysheet_select_save) &&
              !_.isEmpty(sheet.luckysheet_select_save)
            ) {
              // Clone — sheet selection may be Immer-frozen from a prior produce.
              draftCtx.luckysheet_select_save = _.cloneDeep(
                sheet.luckysheet_select_save,
              );
            }
            if (
              !mergedSettings.suppressInitialCellSelection &&
              !draftCtx.luckysheet_select_save?.length
            ) {
              draftCtx.luckysheet_select_save =
                defaultLuckysheetSelectRanges(data);
            }

            draftCtx.config = _.isNil(sheet.config) ? {} : sheet.config;
            draftCtx.insertedImgs = sheet.images;
            draftCtx.insertedIframes = sheet.iframes;
            draftCtx.currency = mergedSettings.currency || '¥';

            draftCtx.zoomRatio = _.isNil(sheet.zoomRatio) ? 1 : sheet.zoomRatio;
            draftCtx.rowHeaderWidth =
              mergedSettings.rowHeaderWidth * draftCtx.zoomRatio;
            draftCtx.columnHeaderHeight =
              mergedSettings.columnHeaderHeight * draftCtx.zoomRatio;

            if (!_.isNil(sheet.defaultRowHeight)) {
              draftCtx.defaultrowlen = Number(sheet.defaultRowHeight);
            } else {
              draftCtx.defaultrowlen = mergedSettings.defaultRowHeight;
            }

            if (!_.isNil(sheet.addRows)) {
              draftCtx.addDefaultRows = Number(sheet.addRows);
            } else {
              draftCtx.addDefaultRows = mergedSettings.addRows;
            }

            if (!_.isNil(sheet.defaultColWidth)) {
              draftCtx.defaultcollen = Number(sheet.defaultColWidth);
            } else {
              draftCtx.defaultcollen = mergedSettings.defaultColWidth;
            }

            if (!_.isNil(sheet.showGridLines)) {
              const { showGridLines } = sheet;
              if (showGridLines === 0 || showGridLines === false) {
                draftCtx.showGridLines = false;
              } else {
                draftCtx.showGridLines = true;
              }
            } else {
              draftCtx.showGridLines = true;
            }

            const finalData = draftCtx.luckysheetfile[sheetIdx]?.data ?? data;
            if (finalData && finalData.length > 0) {
              updateContextWithSheetData(draftCtx, finalData);
            }
          },
          { noHistory: true },
        );
      };
      init();
    }, [
      context.currentSheetId,
      context.luckysheetfile.length,
      originalData,
      mergedSettings.defaultRowHeight,
      mergedSettings.defaultColWidth,
      mergedSettings.column,
      mergedSettings.row,
      mergedSettings.defaultFontSize,
      mergedSettings.devicePixelRatio,
      mergedSettings.lang,
      mergedSettings.dateBaseLocale,
      mergedSettings.allowEdit,
      mergedSettings.hooks,
      mergedSettings.generateSheetId,
      setContextWithProduce,
      initSheetData,
      mergedSettings.rowHeaderWidth,
      mergedSettings.columnHeaderHeight,
      mergedSettings.addRows,
      mergedSettings.currency,
      mergedSettings.suppressInitialCellSelection,
    ]);

    const isMac = navigator.platform.toUpperCase().includes('MAC');

    let waitingForRInsertRow = false;
    let resetInsertRowTimer: any;

    let waitingForDelRow = false;
    let resetDeleteRowTimer: any;

    useEffect(() => {
      const isExternalTextFocus = (root: HTMLDivElement | null) => {
        const active = document.activeElement;
        if (!active || active === document.body || active === document.documentElement) {
          return false;
        }
        if (root?.contains(active)) return false;
        const tag = active.tagName;
        return (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          (active as HTMLElement).isContentEditable
        );
      };

      const onWindowInsertShortcut = (e: KeyboardEvent) => {
        const root = workbookContainer.current;
        if (!root || isExternalTextFocus(root)) return;

        const isSheetShortcut =
          isInsertDateShortcut(e) ||
          isInsertTimeShortcut(e) ||
          isInsertDateTimeShortcut(e) ||
          isUsInsertDateTimeQuoteShortcut(e) ||
          isFindShortcut(e) ||
          isFindReplaceShortcut(e) ||
          isSelectAllShortcut(e);
        if (!isSheetShortcut) return;

        setContextWithProduce((draftCtx) => {
          handleGlobalKeyDown(
            draftCtx,
            cellInput.current!,
            fxInput.current!,
            e,
            globalCache.current!,
            handleUndo,
            handleRedo,
            canvas.current!.getContext('2d')!,
          );
        });

        if (e.defaultPrevented) {
          e.stopImmediatePropagation();
          e.stopPropagation();
        }
      };

      window.addEventListener('keydown', onWindowInsertShortcut, true);
      return () => window.removeEventListener('keydown', onWindowInsertShortcut, true);
    }, [handleRedo, handleUndo, setContextWithProduce]);

    const onKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        const { nativeEvent } = e;
        if (isBrowserZoomShortcut(nativeEvent)) return;

        // Portaled sidebar inputs bubble here via React, not DOM ancestry.
        if (isPortaledUiTextField(e.target)) return;

        // Floating-image clipboard shortcuts first — must run before the
        // Alt+I then C insert-column chord, which also listens for KeyC.
        if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
          const draftSnapshot = contextRef.current;
          const activeImgId = draftSnapshot.activeImg;
          if (e.code === 'KeyC' && activeImgId != null) {
            e.preventDefault();
            e.stopPropagation();
            setContextWithProduce((draftCtx) => {
              copyActiveImage(draftCtx);
            });
            return;
          }
          if (
            e.code === 'KeyX' &&
            activeImgId != null &&
            isAllowEdit(draftSnapshot) &&
            !draftSnapshot.isFlvReadOnly
          ) {
            e.preventDefault();
            e.stopPropagation();
            setContextWithProduce((draftCtx) => {
              cutActiveImage(draftCtx);
            });
            return;
          }
          if (
            e.code === 'KeyV' &&
            (getImageClipboard() || getImageCutSourceId()) &&
            isAllowEdit(draftSnapshot) &&
            !draftSnapshot.isFlvReadOnly
          ) {
            e.preventDefault();
            e.stopPropagation();
            setContextWithProduce((draftCtx) => {
              pasteImageItem(draftCtx);
            });
            return;
          }
        }

        const { getSelection, getSheet, setSelection } =
          workbookInstanceRef.current as any;
        const currentSelection = getSelection()?.[0];

        // Mac: Cmd + Option + =/+ inserts based on full row/column selection.
        const isMacQuickInsert =
          isMac &&
          e.metaKey &&
          e.altKey &&
          (e.code === 'Equal' || e.code === 'NumpadAdd');
        if (isMacQuickInsert && currentSelection) {
          let insertRowColOp: SetContextOptions['insertRowColOp'] | undefined;
          if (currentSelection.column_select) {
            insertRowColOp = {
              type: 'column',
              index: currentSelection.column[0],
              count: 1,
              direction: 'lefttop',
              id: context.currentSheetId,
            };
          } else if (currentSelection.row_select) {
            insertRowColOp = {
              type: 'row',
              index: currentSelection.row[1],
              count: 1,
              direction: 'rightbottom',
              id: context.currentSheetId,
            };
          }

          if (insertRowColOp) {
            const range = context.luckysheet_select_save;
            setContextWithProduce(
              (draftCtx) => {
                insertRowCol(draftCtx, insertRowColOp!);
                draftCtx.luckysheet_select_save = range;
              },
              { insertRowColOp },
            );
            e.preventDefault();
            return;
          }
        }

        // -------Insert-row-col--------
        // Step 1: Detect the initial shortcut combo (Alt + I on Win, Ctrl + Option + I on Mac)
        const isMacShortcutInsertRow = isMac && e.ctrlKey && e.altKey;
        const isWindowsShortcutInsertRow = !isMac && e.altKey;
        if (
          (isMacShortcutInsertRow || isWindowsShortcutInsertRow) &&
          e.code === 'KeyI'
        ) {
          waitingForRInsertRow = true;
          clearTimeout(resetInsertRowTimer);
          resetInsertRowTimer = setTimeout(() => {
            waitingForRInsertRow = false;
          }, 3000); // 3 seconds to press R
          e.preventDefault();
          return;
        }
        if (waitingForRInsertRow && (e.code === 'KeyR' || e.code === 'KeyC')) {
          // Don't steal Ctrl/Cmd+C copy (or other modified C/R) for insert chord
          if (e.metaKey || e.ctrlKey) {
            waitingForRInsertRow = false;
            clearTimeout(resetInsertRowTimer);
          } else {
            const direction = 'rightbottom';
            let position;
            let insertRowColOp: SetContextOptions['insertRowColOp'];
            if (e.code === 'KeyR') {
              position = getSelection()[0].row[1];
              insertRowColOp = {
                type: 'row',
                index: position,
                count: 1,
                direction,
                id: context.currentSheetId,
              };
            } else {
              position = getSelection()[0].column[1];
              insertRowColOp = {
                type: 'column',
                index: position,
                count: 1,
                direction,
                id: context.currentSheetId,
              };
            }
            if (!position) return;
            const range = context.luckysheet_select_save;
            setContextWithProduce(
              (draftCtx) => {
                if (insertRowColOp) insertRowCol(draftCtx, insertRowColOp);
                draftCtx.luckysheet_select_save = range;
              },
              {
                insertRowColOp,
              },
            );

            waitingForRInsertRow = false;
            clearTimeout(resetInsertRowTimer);
            e.preventDefault();
          }
        }

        // -------Delete-row-col--------

        const isDashKey = e.key === '-' || e.code === 'Minus';
        const isSecondShortcut = isMac
          ? e.ctrlKey && e.altKey && isDashKey // Ctrl + Option + -
          : false; // Windows keeps Ctrl+Alt+- for direct delete behavior

        if (isSecondShortcut) {
          waitingForDelRow = true;

          // Set a timeout to cancel if R or C isn’t pressed in time
          clearTimeout(resetDeleteRowTimer);
          resetDeleteRowTimer = setTimeout(() => {
            waitingForDelRow = false;
          }, 3000); // 3 seconds to press R or C

          e.preventDefault();
          return;
        }

        if (waitingForDelRow && (e.code === 'KeyR' || e.code === 'KeyC')) {
          let st_index: number;
          let ed_index: number;
          if (e.code === 'KeyR') {
            [st_index, ed_index] = getSelection()[0].row;
            const range = context.luckysheet_select_save;
            setContextWithProduce((draftCtx) => {
              deleteRowCol(draftCtx, {
                type: 'row',
                start: st_index,
                end: ed_index,
                id: context.currentSheetId,
              });
              draftCtx.luckysheet_select_save = range;
            });
          } else {
            [st_index, ed_index] = getSelection()[0].column;
            const range = context.luckysheet_select_save;
            setContextWithProduce((draftCtx) => {
              deleteRowCol(draftCtx, {
                type: 'column',
                start: st_index,
                end: ed_index,
                id: context.currentSheetId,
              });
              draftCtx.luckysheet_select_save = range;
            });
          }

          waitingForDelRow = false; // Reset the waiting state
          clearTimeout(resetDeleteRowTimer);
          e.preventDefault();
          return;
        }

        // -------Select-row-col----------

        if (e.ctrlKey && e.code === 'Space') {
          e.stopPropagation();
          e.preventDefault();
          const selection = getSelection();
          const selectedCol = selection?.[0].column;
          const totalRow = getSheet().data.length;
          setSelection([{ row: [0, totalRow - 1], column: selectedCol }]);
        }
        if (e.shiftKey && e.code === 'Space') {
          e.stopPropagation();
          e.preventDefault();
          const selection = getSelection();
          const selectedRow = selection?.[0].row;
          const totalCol = getSheet().data[0].length;
          setSelection([{ row: selectedRow, column: [0, totalCol - 1] }]);
        }

        // -----------

        /** past without format */
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyV') {
          navigator.clipboard.readText().then((clipboardText) => {
            setContextWithProduce((safeCtx: any) => {
              handlePasteByClick(safeCtx, clipboardText);
            });
          });
        }

        // handling undo and redo ahead because handleUndo and handleRedo
        // themselves are calling setContext, and should not be nested
        // in setContextWithProduce.
        if (
          (e.ctrlKey || e.metaKey) &&
          e.code === 'KeyZ' &&
          context.luckysheetCellUpdate.length === 0
        ) {
          if (e.shiftKey) {
            handleRedo();
          } else {
            handleUndo();
          }
          e.stopPropagation();
          return;
        }
        if (
          (e.ctrlKey || e.metaKey) &&
          e.code === 'KeyY' &&
          context.luckysheetCellUpdate.length === 0
        ) {
          handleRedo();
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        setContextWithProduce((draftCtx) => {
          handleGlobalKeyDown(
            draftCtx,
            cellInput.current!,
            fxInput.current!,
            nativeEvent,
            globalCache.current!,
            handleUndo, // still passing handleUndo and handleRedo here to satisfy API
            handleRedo,
            canvas.current!.getContext('2d')!,
          );
        });
      },
      [handleRedo, handleUndo, setContextWithProduce],
    );

    const onPaste = useCallback(
      (e: ClipboardEvent) => {
        let startPaste = true;
        const active = document.activeElement;
        const focusInSheetOverlay =
          typeof active?.closest === 'function' &&
          active.closest('.fortune-sheet-overlay') != null;
        const focusInWorkbook =
          active === workbookContainer.current ||
          (typeof active?.closest === 'function' &&
            active.closest('.fortune-container') === workbookContainer.current);
        // deal with multi instance case, only the focused sheet handles the paste
        if (
          cellInput.current === active ||
          focusInSheetOverlay ||
          focusInWorkbook ||
          context.activeImg != null
        ) {
          if (!startPaste) return;
          let { clipboardData } = e;
          if (!clipboardData) {
            // @ts-ignore
            // for IE
            clipboardData = window.clipboardData;
          }

          // System clipboard image file (async) — handle outside immer draft
          const imageFile =
            clipboardData?.files?.length === 1 &&
            clipboardData.files[0].type.indexOf('image') > -1
              ? clipboardData.files[0]
              : null;
          if (imageFile) {
            if (!selectionCache.isPasteAction) return;
            if (!isAllowEdit(context) || context.isFlvReadOnly) return;
            selectionCache.isPasteAction = false;
            e.preventDefault();
            loadImageFromFile(imageFile).then((image) => {
              if (!image) return;
              setContextWithProduce((draftCtx) => {
                insertImage(draftCtx, image);
              });
            });
            return;
          }

          const txtdata =
            clipboardData!.getData('text/html') ||
            clipboardData!.getData('text/plain');
          const ele = document.createElement('div');
          ele.innerHTML = txtdata;

          const trList = ele.querySelectorAll('table tr');
          const maxRow =
            trList.length + context.luckysheet_select_save![0].row[0];
          const rowToBeAdded =
            maxRow -
            context.luckysheetfile[
              getSheetIndex(
                context,
                context!.currentSheetId! as string,
              ) as number
            ].data!.length;
          const range = context.luckysheet_select_save;
          const insertRowColOp: SetContextOptions['insertRowColOp'] | null =
            rowToBeAdded > 0
              ? {
                type: 'row',
                index:
                  context.luckysheetfile[
                    getSheetIndex(
                      context,
                      context!.currentSheetId! as string,
                    ) as number
                  ].data!.length - 1,
                count: rowToBeAdded,
                direction: 'rightbottom',
                id: context.currentSheetId,
              }
              : null;
          setContextWithProduce(
            (draftCtx) => {
              try {
                if (insertRowColOp) {
                  insertRowCol(draftCtx, insertRowColOp);
                  draftCtx.luckysheet_select_save = range;
                }
                if (startPaste) {
                  startPaste = false;
                  handlePaste(draftCtx, e);
                }
              } catch (err: any) {
                console.error(err);
              }
            },
            insertRowColOp ? { insertRowColOp } : {},
          );
        }
        setContextWithProduce((ctx: any) => {
          if (ctx.luckysheet_selection_range) {
            ctx.luckysheet_selection_range = [];
          }
        });
      },
      [context, setContextWithProduce],
    );

    const onMoreToolbarItemsClose = useCallback(() => {
      setMoreToolbarItems(null);
    }, []);

    useEffect(() => {
      document.addEventListener('paste', onPaste);
      return () => {
        document.removeEventListener('paste', onPaste);
      };
    }, [onPaste]);

    const isFormulaCalculating = !!context.isFormulaCalculating;
    const formulaAsyncEvalTotal = context.formulaAsyncEval?.total;
    const showFormulaExecutionDebug = isFormulaExecutionDebugEnabled();

    // Drain deferred formula eval: main-thread chunks (small jobs) or Web Worker (large jobs).
    useEffect(() => {
      if (!isFormulaCalculating || formulaAsyncEvalTotal == null) {
        return;
      }

      let cancelled = false;
      let frameId: number | null = null;
      let workerOnlyChunkStreak = 0;

      const finishJobIfComplete = (draft: Context) => {
        const job = draft.formulaAsyncEval;
        if (!job || job.nextIndex < job.total) return;
        draft.formulaCache.execFunctionExist = undefined;
        clearRangeValuePassCache(draft.formulaCache);
        draft.formulaCache.execFunctionGlobalData = null;
        draft.formulaAsyncEval = null;
        draft.isFormulaCalculating = false;
      };

      const waitForNextFrame = () =>
        new Promise<void>((resolve) => {
          frameId = requestAnimationFrame(() => {
            frameId = null;
            resolve();
          });
        });

      const waitForMacrotask = () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });

      const drainLoop = async () => {
        while (!cancelled) {
          const job = contextRef.current.formulaAsyncEval;
          if (!contextRef.current.isFormulaCalculating || !job) return;

          const startIndex = job.nextIndex;
          if (startIndex >= job.total) {
            setContextWithProduce(
              (draft) => {
                finishJobIfComplete(draft);
              },
              { noHistory: true },
            );
            return;
          }

          const useWorker = job.total >= FORMULA_WORKER_THRESHOLD;
          const firstFormulaUnsafe = isFormulaWorkerUnsafe(
            job.formulaRunList[startIndex].calc_funcStr,
          );
          const useWorkerForChunk = useWorker && !firstFormulaUnsafe;
          const maxChunkSize = useWorkerForChunk
            ? FORMULA_WORKER_CHUNK_SIZE
            : FORMULA_ASYNC_CHUNK_SIZE;
          let chunkEnd = startIndex;
          while (
            chunkEnd < job.formulaRunList.length &&
            chunkEnd - startIndex < maxChunkSize
          ) {
            const formulaUnsafe = isFormulaWorkerUnsafe(
              job.formulaRunList[chunkEnd].calc_funcStr,
            );
            if (useWorker && formulaUnsafe !== firstFormulaUnsafe) {
              break;
            }
            chunkEnd += 1;
          }
          const formulas = job.formulaRunList.slice(startIndex, chunkEnd);
          const unsafeFormulaCount = formulas.filter((formula) =>
            isFormulaWorkerUnsafe(formula.calc_funcStr),
          ).length;
          const startedAt = performance.now();
          let processedByWorkerChunk = false;

          if (useWorkerForChunk) {
            try {
              if (
                !initFormulaWorkerSnapshot(
                  contextRef.current,
                  job.workerSnapshotKey,
                )
              ) {
                throw new Error('Formula worker unavailable');
              }
              const input = buildWorkerEvalInput(contextRef.current, formulas);
              const output = await evalFormulasInBackground(
                job.workerSnapshotKey,
                input,
              );
              if (cancelled) return;
              setContextWithProduce(
                (draft) => {
                  const liveJob = draft.formulaAsyncEval;
                  if (!liveJob || liveJob.nextIndex !== startIndex) return;
                  applyWorkerFormulaChunkResults(
                    draft,
                    output,
                    new Set(liveJob.impactedByCircular),
                    new Set(liveJob.cycleNodes),
                    liveJob.calcChainKeys,
                    getFlowdata(draft),
                  );
                  const elapsed = performance.now() - startedAt;
                  liveJob.nextIndex = chunkEnd;
                  liveJob.debug = {
                    mode: 'worker',
                    lastChunkMs: elapsed,
                    lastChunkSize: formulas.length,
                    completedChunks: (liveJob.debug?.completedChunks ?? 0) + 1,
                    fallbackChunks: liveJob.debug?.fallbackChunks ?? 0,
                    workerAvailable: true,
                    unsafeFormulaCount,
                    workerFormulaCount: formulas.length,
                    totalWorkerFormulas:
                      (liveJob.debug?.totalWorkerFormulas ?? 0) +
                      formulas.length,
                    totalMainThreadFormulas:
                      liveJob.debug?.totalMainThreadFormulas ?? 0,
                    lastError: null,
                  };
                  finishJobIfComplete(draft);
                },
                { noHistory: true },
              );
              processedByWorkerChunk = true;
            } catch (e) {
              if (cancelled) return;
              workerOnlyChunkStreak = 0;
              const message = e instanceof Error ? e.message : String(e);
              setContextWithProduce(
                (draft) => {
                  const liveJob = draft.formulaAsyncEval;
                  if (!liveJob || liveJob.nextIndex !== startIndex) return;
                  const fallbackChunkSize = Math.min(
                    FORMULA_ASYNC_CHUNK_SIZE,
                    formulas.length,
                  );
                  runFormulaEvalChunk(
                    draft,
                    liveJob,
                    fallbackChunkSize,
                  );
                  const elapsed = performance.now() - startedAt;
                  liveJob.debug = {
                    mode: 'fallback',
                    lastChunkMs: elapsed,
                    lastChunkSize: fallbackChunkSize,
                    completedChunks: (liveJob.debug?.completedChunks ?? 0) + 1,
                    fallbackChunks: (liveJob.debug?.fallbackChunks ?? 0) + 1,
                    workerAvailable: false,
                    unsafeFormulaCount,
                    workerFormulaCount: 0,
                    totalWorkerFormulas:
                      liveJob.debug?.totalWorkerFormulas ?? 0,
                    totalMainThreadFormulas:
                      (liveJob.debug?.totalMainThreadFormulas ?? 0) +
                      fallbackChunkSize,
                    lastError: message,
                  };
                  finishJobIfComplete(draft);
                },
                { noHistory: true },
              );
            }
          } else {
            workerOnlyChunkStreak = 0;
            setContextWithProduce(
              (draft) => {
                const liveJob = draft.formulaAsyncEval;
                if (!liveJob || liveJob.nextIndex !== startIndex) return;
                runFormulaEvalChunk(
                  draft,
                  liveJob,
                  chunkEnd - liveJob.nextIndex,
                );
                const elapsed = performance.now() - startedAt;
                liveJob.debug = {
                  mode: 'main-thread',
                  lastChunkMs: elapsed,
                  lastChunkSize: formulas.length,
                  completedChunks: (liveJob.debug?.completedChunks ?? 0) + 1,
                  fallbackChunks: liveJob.debug?.fallbackChunks ?? 0,
                  workerAvailable: useWorker,
                  unsafeFormulaCount,
                  workerFormulaCount: 0,
                  totalWorkerFormulas: liveJob.debug?.totalWorkerFormulas ?? 0,
                  totalMainThreadFormulas:
                    (liveJob.debug?.totalMainThreadFormulas ?? 0) +
                    formulas.length,
                  lastError:
                    useWorker && unsafeFormulaCount > 0
                      ? `${unsafeFormulaCount} formula(s) in this chunk require the main formula engine`
                      : null,
                };
                finishJobIfComplete(draft);
              },
              { noHistory: true },
            );
          }

          if (processedByWorkerChunk) {
            workerOnlyChunkStreak += 1;
            if (workerOnlyChunkStreak >= 3) {
              workerOnlyChunkStreak = 0;
              await waitForNextFrame();
            } else {
              await waitForMacrotask();
            }
          } else {
            await waitForNextFrame();
          }
        }
      };

      void drainLoop();

      return () => {
        cancelled = true;
        if (frameId != null) {
          cancelAnimationFrame(frameId);
        }
      };
    }, [isFormulaCalculating, formulaAsyncEvalTotal, setContextWithProduce]);

    // expose APIs
    useImperativeHandle(
      ref,
      () => {
        const workbookInstance = generateAPIs(
          context,
          setContextWithProduce,
          handleUndo,
          handleRedo,
          mergedSettings,
          cellInput.current,
          scrollbarX.current,
          scrollbarY.current,
          globalCache.current,
          refs,
        );
        workbookInstanceRef.current = workbookInstance;
        return workbookInstance;
      },
      [
        context,
        setContextWithProduce,
        handleUndo,
        handleRedo,
        mergedSettings,
        globalCache,
      ],
    );

    const i = getSheetIndex(context, context.currentSheetId);
    if (i == null) {
      return null;
    }
    const sheet = context.luckysheetfile?.[i];
    if (!sheet) {
      return null;
    }

    return (
      <WorkbookContext.Provider value={providerValue}>
        {/* <button onClick={()=>{
          setShow(!show)
          id="placeholder-data-verification placeholder-conditional-format"
        }}>Click</button> */}
        {/* <div
          id="placeholder-conditional-format"
          style={{
            width: "500px",
            height: "500px",
            position: "fixed",
            zIndex: "1000",
            backgroundColor: "white",
            padding: "12px",
            top: "100px",
          }}
        /> */}
        <ModalProvider>
          <div
            className="fortune-container"
            ref={workbookContainer}
            onKeyDown={onKeyDown}
            tabIndex={-1}
          >
            {showFormulaExecutionDebug &&
              context.isFormulaCalculating &&
              context.formulaAsyncEval && (
              <div
                className="fortune-formula-calculating-indicator"
                role="status"
                aria-live="polite"
              >
                <div>
                  Calculating formulas…{' '}
                  {Math.min(
                    context.formulaAsyncEval.nextIndex,
                    context.formulaAsyncEval.total,
                  )}
                  /{context.formulaAsyncEval.total}
                </div>
                {context.formulaAsyncEval.debug && (
                  <div className="fortune-formula-calculating-debug">
                    <div>
                      Mode: {context.formulaAsyncEval.debug.mode} | Last chunk:{' '}
                      {context.formulaAsyncEval.debug.lastChunkSize} in{' '}
                      {Math.round(context.formulaAsyncEval.debug.lastChunkMs)}ms
                    </div>
                    <div>
                      Chunks: {context.formulaAsyncEval.debug.completedChunks}
                    </div>
                    <div>
                      Fallbacks: {context.formulaAsyncEval.debug.fallbackChunks}
                    </div>
                    <div>
                      Worker formulas total:{' '}
                      {context.formulaAsyncEval.debug.totalWorkerFormulas}
                    </div>
                    <div>
                      Main-engine formulas total:{' '}
                      {context.formulaAsyncEval.debug.totalMainThreadFormulas}
                    </div>
                    <div>
                      Worker:{' '}
                      {context.formulaAsyncEval.debug.workerAvailable
                        ? 'ok'
                        : 'unavailable'}
                    </div>
                    {context.formulaAsyncEval.debug.unsafeFormulaCount > 0 && (
                      <div>
                        Main-engine formulas this chunk:{' '}
                        {context.formulaAsyncEval.debug.unsafeFormulaCount}
                      </div>
                    )}
                    {context.formulaAsyncEval.debug.lastError && (
                      <div className="fortune-formula-calculating-error">
                        Last error: {context.formulaAsyncEval.debug.lastError}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <SVGDefines currency={mergedSettings.currency} />
            <div className="fortune-workarea">
              {mergedSettings.showToolbar && (
                <Toolbar
                  moreItemsOpen={moreToolbarItems !== null}
                  setMoreItems={setMoreToolbarItems}
                  onMoreToolbarItemsClose={onMoreToolbarItemsClose}
                  moreToolbarItems={moreToolbarItems}
                  trailingContent={toolbarTrailingContent}
                />
              )}
              {mergedSettings.showFormulaBar && (
                <div className="fortune-formula-bar-row">
                  <FxEditor />
                </div>
              )}
            </div>
            <Sheet sheet={sheet} />
            {mergedSettings.showFormulaBar && context.showQuickSearch && (
              <div
                className="fortune-quick-search-float"
                style={{
                  top:
                    (mergedSettings.showToolbar ? context.toolbarHeight : 0) +
                    2,
                }}
              >
                <QuickSearchBar />
              </div>
            )}
            {mergedSettings.showSheetTabs && <SheetTab />}
            <ContextMenu />
            <FilterMenu />
            <SheetTabContextMenu />
            <SidebarPanelPortals
              activePanel={sidebarActivePanel}
              portalRegistry={sidebarPortalRegistry}
              extraPortals={sidebarPortalRenderers}
            />
            {context.showSheetList && <SheetList />}
            {!_.isEmpty(context.contextMenu) && (
              <div
                onMouseDown={() => {
                  setContextWithProduce((draftCtx) => {
                    draftCtx.contextMenu = {};
                    draftCtx.filterContextMenu = undefined;
                    draftCtx.showSheetList = undefined;
                  });
                }}
                onMouseMove={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                className="fortune-popover-backdrop"
              />
            )}
            <div className="fortune-stat-area">
              <div className="luckysheet-sheet-selection-calInfo">
                {/* {!!calInfo.count && (
                  <div style={{ width: "60px" }}>
                    {formula.count}: {calInfo.count}
                  </div>
                )}
                {!!calInfo.numberC && !!calInfo.sum && (
                  <div>
                    {formula.sum}: {calInfo.sum}
                  </div>
                )}
                {!!calInfo.numberC && !!calInfo.average && (
                  <div>
                    {formula.average}: {calInfo.average}
                  </div>
                )}
                {!!calInfo.numberC && !!calInfo.max && (
                  <div>
                    {formula.max}: {calInfo.max}
                  </div>
                )}
                {!!calInfo.numberC && !!calInfo.min && (
                  <div>
                    {formula.min}: {calInfo.min}
                  </div>
                )} */}
              </div>
            </div>
            {context.showDunePreview && (
              <DunePreview
                url={context.showDunePreview.url}
                position={context.showDunePreview.position}
                onKeepAsLink={() => {
                  setContextWithProduce(
                    (draftCtx) => {
                      draftCtx.showDunePreview = undefined;
                    },
                    { noHistory: true },
                  );
                }}
                onEmbed={() => {
                  setContextWithProduce(
                    (draftCtx) => {
                      insertDuneChart(draftCtx, context.showDunePreview!.url);
                      draftCtx.showDunePreview = undefined;
                    },
                    { noHistory: true },
                  );
                  mergedSettings.onDuneChartEmbed?.();
                }}
              />
            )}
          </div>
        </ModalProvider>
      </WorkbookContext.Provider>
    );
  },
);

export default Workbook;
