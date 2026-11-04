import _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import { initSheetData } from '../api/sheet';
import { Context } from '../context';
import { locale } from '../locale';
import { Settings } from '../settings';
import { CellMatrix, Sheet, SheetConfig } from '../types';
import { generateRandomSheetName, getSheetIndex } from '../utils';
import {
  CellFormatRange,
  migrateFormatOnlyCellsFromData,
} from '../utils/range-format';
/**
 * Persist active ctx.config onto ONE sheet file only.
 * If Immer wrote keys (e.g. cellFormatRanges) on file.config but not ctx.config,
 * keep those instead of wiping them with a blind replace.
 * Never touches other sheets.
 */
export function assignActiveConfigToSheetFile(
  file: Sheet,
  activeConfig: SheetConfig | undefined,
) {
  if (activeConfig == null) return;
  const prev = file.config;
  const merged: SheetConfig = { ...(prev || {}), ...activeConfig };
  if (
    activeConfig.cellFormatRanges == null &&
    prev?.cellFormatRanges != null
  ) {
    merged.cellFormatRanges = prev.cellFormatRanges;
  }
  file.config = merged;
}

/**
 * Promote format-only cells in a rectangle into cellFormatRanges.
 * Scans only [r1..r2]×[c1..c2]. Returns new ranges if anything changed.
 *
 * Writes through luckysheetfile[i].config (same as toolbar) so Immer undo
 * history tracks the change and peers get the reverse via afterConfigChanges.
 */
export function syncFormatOnlyRectIntoRanges(
  ctx: Context,
  cfg: SheetConfig | undefined,
  data: CellMatrix | null | undefined,
  r1: number,
  r2: number,
  c1: number,
  c2: number,
): CellFormatRange[] | null {
  if (!cfg || !data?.length) return null;
  const migrated = migrateFormatOnlyCellsFromData(
    cfg.cellFormatRanges,
    data,
    r1,
    r2,
    c1,
    c2,
  );
  if (!migrated.changed) return null;

  const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
  if (sheetIndex != null) {
    const file = ctx.luckysheetfile[sheetIndex];
    file.config ||= {};
    file.config.cellFormatRanges = migrated.ranges;
    cfg.cellFormatRanges = migrated.ranges;
    ctx.config = file.config;
  } else {
    cfg.cellFormatRanges = migrated.ranges;
    ctx.config ||= {};
    ctx.config.cellFormatRanges = migrated.ranges;
  }
  return migrated.ranges;
}

function storeSheetParam(ctx: Context) {
  const index = getSheetIndex(ctx, ctx.currentSheetId);
  if (index == null) return;
  const file = ctx.luckysheetfile[index];
  assignActiveConfigToSheetFile(file, ctx.config);
  // Re-alias so later active-sheet mutations stay on the same object.
  ctx.config = file.config!;
  // file.visibledatarow = ctx.visibledatarow;
  // file.visibledatacolumn = ctx.visibledatacolumn;
  // file.ch_width = ctx.ch_width;
  // file.rh_height = ctx.rh_height;
  file.luckysheet_select_save = ctx.luckysheet_select_save;
  file.luckysheet_selection_range = ctx.luckysheet_selection_range;
  file.zoomRatio = ctx.zoomRatio;
}

export function storeSheetParamALL(ctx: Context) {
  storeSheetParam(ctx);
}

export function changeSheet(
  ctx: Context,
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isPivotInitial?: boolean,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isNewSheet?: boolean,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isCopySheet?: boolean,
) {
  //   if (isEditMode()) {
  //     // alert("非编辑模式下不允许该操作！");
  //     return;
  //   }

  if (id === ctx.currentSheetId) {
    return;
  }

  const file = ctx.luckysheetfile[getSheetIndex(ctx, id)!];

  if (ctx.hooks.beforeActivateSheet?.(id) === false) {
    return;
  }

  storeSheetParamALL(ctx);

  ctx.currentSheetId = id;

  if (file.isPivotTable) {
    ctx.luckysheetcurrentisPivotTable = true;
    //     if (!isPivotInitial) {
    //       pivotTable.changePivotTable(index);
    //     }
  } else {
    ctx.luckysheetcurrentisPivotTable = false;
    //     $("#luckysheet-modal-dialog-slider-pivot").hide();
    //     luckysheetsizeauto(false);
  }

  if (ctx.hooks.afterActivateSheet) {
    ctx.hooks.afterActivateSheet?.(id);
  }
}

export function addSheet(
  ctx: Context,
  settings?: Required<Settings>,
  newSheetID: string | undefined = undefined, // if action is from websocket, there will be a new sheetID
  isPivotTable = false,
  sheetName: string | undefined = undefined,
  sheetData: Sheet | undefined = undefined,
) {
  if (/* isEditMode() || */ ctx.allowEdit === false) {
    // alert("非编辑模式下不允许该操作！");
    return;
  }
  const order = ctx.luckysheetfile.length;
  const id = newSheetID ?? (settings?.generateSheetId() as string);
  const sheetname =
    sheetName || generateRandomSheetName(ctx.luckysheetfile, isPivotTable, ctx);
  if (!_.isNil(sheetData)) {
    delete sheetData.data;
    ctx.luckysheetfile.forEach((sheet) => {
      sheet.order =
        (sheet.order as number) < sheetData.order!
          ? sheet.order
          : (sheet.order as number) + 1;
      return sheet;
    });
  }
  const sheetconfig: Sheet = _.isNil(sheetData)
    ? {
        name: sheetName === undefined ? sheetname : sheetName,
        status: 0,
        order,
        id,
        row: ctx.defaultrowNum,
        column: ctx.defaultcolumnNum,
        config: {},
        pivotTable: null,
        isPivotTable: !!isPivotTable,
        zoomRatio: 1,
      }
    : sheetData;
  if (sheetName !== undefined) sheetconfig.name = sheetName;
  if (sheetconfig.id === undefined) sheetconfig.id = uuidv4();
  if (ctx.hooks.beforeAddSheet?.(sheetconfig) === false) {
    return;
  }

  ctx.luckysheetfile.push(sheetconfig);

  //   server.saveParam("sha", null, $.extend(true, {}, sheetconfig));

  if (ctx.hooks.afterAddSheet) {
    ctx.hooks.afterAddSheet?.({ ...sheetconfig });
  }
}

export function deleteSheet(ctx: Context, id: string) {
  if (ctx.allowEdit === false) {
    return;
  }

  const arrIndex = getSheetIndex(ctx, id);

  if (arrIndex == null) {
    return;
  }

  // const file = ctx.luckysheetfile[arrIndex];

  if (ctx.hooks.beforeDeleteSheet?.(id) === false) {
    return;
  }

  // _this.setSheetHide(index, true);

  // $(`#luckysheet-sheets-item${index}`).remove();
  // $(`#luckysheet-datavisual-selection-set-${index}`).remove();
  ctx.luckysheetfile = ctx.luckysheetfile.map((sheet) => {
    sheet.order =
      (sheet.order as number) < (ctx.luckysheetfile[arrIndex].order as number)
        ? sheet.order
        : (sheet.order as number) - 1;
    return sheet;
  });

  ctx.luckysheetfile.splice(arrIndex, 1);
  // _this.reOrderAllSheet();

  // server.saveParam("shd", null, { deleIndex: index });
  if (id === ctx.currentSheetId) {
    const shownSheets = _.cloneDeep(ctx.luckysheetfile).filter(
      (singleSheet) =>
        _.isUndefined(singleSheet.hide) || singleSheet.hide !== 1,
    );
    const orderSheets = _.sortBy(shownSheets, (sheet) => sheet.order);
    ctx.currentSheetId = orderSheets?.[0]?.id as string;
  }

  const list = ctx.definedNames || [];
  if (list.length) {
    const removed: string[] = [];
    ctx.definedNames = list.filter((dn) => {
      if (dn.sheetId === id || dn.localSheetId === id) {
        removed.push(dn.name);
        return false;
      }
      return true;
    });
    if (removed.length) {
      const sync = ctx.hooks?.definedNamesChange;
      if (sync) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => sync());
        });
      }
      // Lazy import avoids circular deps (formula ↔ namedRanges ↔ sheet).
      void import('./formula').then(({ refreshFormulasUsingDefinedNames }) => {
        refreshFormulasUsingDefinedNames(ctx, removed);
      });
    }
  }

  if (ctx.hooks.afterDeleteSheet) {
    ctx.hooks.afterDeleteSheet?.(id);
  }
}

export function updateSheet(ctx: Context, newData: Sheet[]) {
  // Replaced sheets bring formulas that were not evaluated here (C8).
  ctx.formulaCache.markDepGraphIncomplete();
  newData.forEach((newDatum) => {
    const { data, row, column } = newDatum;
    const index = getSheetIndex(ctx, newDatum.id!) as number;
    if (data != null) {
      // 如果row和column存在的话则进行row和column和data进行比较，如果row和column不存在的话则进行data和default进行比较。
      let lastRowNum = data.length;
      let lastColNum = data[0].length;
      if (row != null && column != null && row > 0 && column > 0) {
        lastRowNum = Math.max(lastRowNum, row);
        lastColNum = Math.max(lastColNum, column);
      } else {
        lastRowNum = Math.max(lastRowNum, ctx.defaultrowNum);
        lastColNum = Math.max(lastColNum, ctx.defaultcolumnNum);
      }
      const expandedData: Sheet['data'] = _.times(lastRowNum, () =>
        _.times(lastColNum, () => null),
      );
      for (let i = 0; i < data.length; i += 1) {
        for (let j = 0; j < data[i].length; j += 1) {
          expandedData[i][j] = data[i][j];
        }
      }
      newDatum.data = expandedData;
      if (ctx.luckysheetfile[index] == null) {
        ctx.luckysheetfile.push(newDatum);
      } else {
        ctx.luckysheetfile[index] = newDatum;
      }
    } else if (newDatum.celldata != null) {
      initSheetData(ctx, index, newDatum);
    }
  });
}

export function editSheetName(ctx: Context, editable: HTMLSpanElement) {
  const index = getSheetIndex(ctx, ctx.currentSheetId);
  if (ctx.allowEdit === false) {
    if (index == null) return;
    editable.innerText = ctx.luckysheetfile[index].name;
    return;
  }
  const { sheetconfig } = locale(ctx);
  const oldtxt = editable.dataset.oldText || '';
  const txt = editable.innerText;

  if (
    ctx.hooks.beforeUpdateSheetName?.(ctx.currentSheetId, oldtxt, txt) === false
  ) {
    return;
  }

  if (txt.length === 0) {
    editable.innerText = oldtxt;
    throw new Error(sheetconfig.sheetNamecannotIsEmptyError);
  }

  if (
    txt.charAt(0) === "'" ||
    txt.charAt(txt.length - 1) === "'" ||
    /[：:\\/？?*[\]]+/.test(txt)
  ) {
    editable.innerText = oldtxt;
    throw new Error(sheetconfig.sheetNameSpecCharError);
  }

  if (index == null) return;

  for (let i = 0; i < ctx.luckysheetfile.length; i += 1) {
    if (index !== i && ctx.luckysheetfile[i].name === txt) {
      // if (isEditMode()) {
      //   alert(locale_sheetconfig.tipNameRepeat);
      // } else {
      //   tooltip.info("", locale_sheetconfig.tipNameRepeat);
      // }
      editable.innerText = oldtxt;
      return;
    }
  }

  // sheetmanage.sheetArrowShowAndHide();

  ctx.luckysheetfile[index].name = txt;
  // server.saveParam("all", ctx.currentSheetId, txt, { k: "name" });

  // $t.attr("contenteditable", "false").removeClass(
  //   "luckysheet-mousedown-cancel"
  // );

  if (ctx.hooks.afterUpdateSheetName) {
    setTimeout(() => {
      ctx.hooks.afterUpdateSheetName?.(ctx.currentSheetId, oldtxt, txt);
    });
  }
}

export function expandRowsAndColumns(
  data: CellMatrix,
  rowsToAdd: number,
  columnsToAdd: number,
) {
  if (rowsToAdd <= 0 && columnsToAdd <= 0) {
    return data;
  }

  if (data.length + rowsToAdd >= 10000) {
    throw new Error(
      'This action would increase the number of rows in the workbook above the limit of 10000.',
    );
  }

  if (data[0].length + columnsToAdd >= 1000) {
    throw new Error(
      'This action would increase the number of columns in the workbook above the limit of 1000.',
    );
  }
  if (rowsToAdd <= 0) {
    rowsToAdd = 0;
  }

  if (columnsToAdd <= 0) {
    columnsToAdd = 0;
  }

  let currentColLen = 0;
  if (data.length > 0) {
    currentColLen = data[0].length;
  }

  for (let r = 0; r < data.length; r += 1) {
    for (let i = 0; i < columnsToAdd; i += 1) {
      data[r].push(null);
    }
  }

  for (let r = 0; r < rowsToAdd; r += 1) {
    data.push(_.times(currentColLen + columnsToAdd, () => null));
  }

  return data;
}
