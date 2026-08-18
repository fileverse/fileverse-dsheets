import { v4 as uuidv4 } from 'uuid';
import React from 'react';
import { Sheet, Selection, CellMatrix, Cell } from './types';

export type DateBaseLocale = 'uk' | 'us';

type SheetChangePath = {
  sheetId: string;
  path: string[]; // ['name'], ['config', 'merge'], ['celldata']
  key?: string; // 👈 only for celldata
  value: any;
  type?: 'update' | 'delete';
};
export type Hooks = {
  calcChainChange?: () => void;
  sheetLengthChange?: () => void;
  dataVerificationChange?: () => void;
  liveQueryChange?: () => void;
  imageListChange?: () => void;
  iframeListChange?: () => void;
  conditionRulesChange?: () => void;
  conditionFormatChange?: () => void;
  filterSelectChange?: () => void;
  filterChange?: () => void;
  cellDataChange?: () => void;
  hyperlinkChange?: () => void;
  /** Workbook-level named ranges (definedNames) changed — sync to Yjs. */
  definedNamesChange?: () => void;
  updateCellYdoc?: (changes: SheetChangePath[]) => void;
  updateAllCell?: (sheetId: string, caller?: string) => void;
  beforeUpdateCell?: (r: number, c: number, value: any) => boolean;
  /** Clears RTC remote-apply lock so local edits can run data-block formulas. */
  onLocalCellEdit?: () => void;
  afterUpdateCell?: (
    row: number,
    column: number,
    oldValue: any,
    newValue: any,
  ) => void;
  afterSelectionChange?: (sheetId: string, selection: Selection) => void;
  beforeRenderRowHeaderCell?: (
    rowNumber: string,
    rowIndex: number,
    top: number,
    width: number,
    height: number,
    ctx: CanvasRenderingContext2D,
  ) => boolean;
  afterRenderRowHeaderCell?: (
    rowNumber: string,
    rowIndex: number,
    top: number,
    width: number,
    height: number,
    ctx: CanvasRenderingContext2D,
  ) => void;
  beforeRenderColumnHeaderCell?: (
    columnChar: string,
    columnIndex: number,
    left: number,
    width: number,
    height: number,
    ctx: CanvasRenderingContext2D,
  ) => boolean;
  afterRenderColumnHeaderCell?: (
    columnChar: string,
    columnIndex: number,
    left: number,
    width: number,
    height: number,
    ctx: CanvasRenderingContext2D,
  ) => void;
  beforeRenderCellArea?: (
    cells: CellMatrix,
    ctx: CanvasRenderingContext2D,
  ) => boolean;
  beforeRenderCell?: (
    cell: Cell | null,
    cellInfo: {
      row: number;
      column: number;
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    },
    ctx: CanvasRenderingContext2D,
  ) => boolean;
  afterRenderCell?: (
    cell: Cell | null,
    cellInfo: {
      row: number;
      column: number;
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    },
    ctx: CanvasRenderingContext2D,
  ) => void;
  beforeCellMouseDown?: (
    cell: Cell | null,
    cellInfo: {
      row: number;
      column: number;
      startRow: number;
      startColumn: number;
      endRow: number;
      endColumn: number;
    },
  ) => boolean;
  afterCellMouseDown?: (
    cell: Cell | null,
    cellInfo: {
      row: number;
      column: number;
      startRow: number;
      startColumn: number;
      endRow: number;
      endColumn: number;
    },
  ) => void;
  beforePaste?: (
    selection: Selection[] | undefined,
    content: string,
  ) => boolean;
  beforeUpdateComment?: (row: number, column: number, value: any) => boolean;
  afterUpdateComment?: (
    row: number,
    column: number,
    oldValue: any,
    value: any,
  ) => void;
  beforeInsertComment?: (row: number, column: number) => boolean;
  afterInsertComment?: (row: number, column: number) => void;
  beforeDeleteComment?: (row: number, column: number) => boolean;
  afterDeleteComment?: (row: number, column: number) => void;
  beforeAddSheet?: (sheet: Sheet) => boolean;
  afterAddSheet?: (sheet: Sheet) => void;
  beforeActivateSheet?: (id: string) => boolean;
  afterActivateSheet?: (id: string) => void;
  beforeDeleteSheet?: (id: string) => boolean;
  afterDeleteSheet?: (id: string) => void;
  beforeUpdateSheetName?: (
    id: string,
    oldName: string,
    newName: string,
  ) => boolean;
  afterUpdateSheetName?: (id: string, oldName: string, newName: string) => void;
  afterImagesChange?: () => void;
  afterIframesChange?: () => void;
  afterFrozenChange?: () => void;
  afterOrderChanges?: () => void;
  afterColorChanges?: () => void;
  afterHideChanges?: () => void;
  afterConfigChanges?: () => void;
  afterColRowChanges?: () => void;
  afterShowGridLinesChange?: () => void;
  afterNameChanges?: () => void;
  afterStatusChanges?: () => void;
  /**
   * Fired after row/column drag-drop, cell-range move, or insert/delete
   * so host apps can remap comment keys (`${sheetId}_${row}_${col}`).
   */
  afterCommentAnchorMove?: (move: CommentAnchorMove) => void;
};

export type CommentAnchorMove =
  | {
      type: 'row' | 'column';
      sheetId: string;
      /** Prefixes that identify this sheet in comment keys (id, order, index). */
      sheetKeys?: string[];
      /** old index → new index for every row/col on the sheet */
      indexMap: Record<number, number>;
    }
  | {
      type: 'cells';
      sheetId: string;
      sheetKeys?: string[];
      source: { row: [number, number]; column: [number, number] };
      target: { row: [number, number]; column: [number, number] };
    }
  | {
      type: 'insert';
      axis: 'row' | 'column';
      sheetId: string;
      sheetKeys?: string[];
      index: number;
      count: number;
      direction: 'lefttop' | 'rightbottom';
    }
  | {
      type: 'delete';
      axis: 'row' | 'column';
      sheetId: string;
      sheetKeys?: string[];
      start: number;
      end: number;
    };

type CommentUIDragFn = (
  e: React.MouseEvent<HTMLDivElement, MouseEvent>,
) => void;
export type Settings = {
  column?: number;
  row?: number;
  addRows?: number;
  allowEdit?: boolean;
  showToolbar?: boolean;
  showFormulaBar?: boolean;
  showSheetTabs?: boolean;
  data: Sheet[];
  config?: any;
  devicePixelRatio?: number;
  lang?: string | null;
  forceCalculation?: boolean;
  rowHeaderWidth?: number;
  columnHeaderHeight?: number;
  defaultColWidth?: number;
  defaultRowHeight?: number;
  defaultFontSize?: number;
  toolbarItems?: string[];
  cellContextMenu?: string[];
  headerContextMenu?: string[];
  sheetTabContextMenu?: string[];
  filterContextMenu?: string[];
  getCommentCellUI?:
    | ((
        row: number,
        column: number,
        dragHandler: CommentUIDragFn,
        isHover?: boolean,
      ) => React.ReactNode)
    | null;
  generateSheetId?: () => string;
  hooks?: Hooks;
  customToolbarItems?: {
    key: string;
    tooltip?: string;
    children?: React.ReactNode;
    iconName?: string;
    icon?: React.ReactNode;
    onClick?: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
  }[];
  currency?: string;
  onDuneChartEmbed?: () => void;
  onSheetCountChange?: (count: number) => void;
  isAuthorized?: boolean;
  isFlvReadOnly?: boolean;
  isRTCActive?: boolean;
  dateBaseLocale?: DateBaseLocale;
  /** When true, do not auto-select A1 on load (e.g. onboarding modal runs first). */
  suppressInitialCellSelection?: boolean;
};

export const defaultSettings: Required<Settings> = {
  column: 60, // 空表格默认的列数量
  row: 84, // 空表格默认的行数据量
  addRows: 50, // It will add the rows when we click on add row button
  showToolbar: true, // 是否显示工具栏
  showFormulaBar: true, // 是否显示公式栏
  showSheetTabs: true, // 是否显示底部表格名称区域
  data: [], // 客户端sheet数据[sheet1, sheet2, sheet3]
  config: {}, // 表格行高、列宽、合并单元格、公式等设置
  devicePixelRatio: 0, // 设备比例，比例越大表格分标率越高，0表示自动
  allowEdit: true, // 是否允许前台编辑
  lang: null, // language
  forceCalculation: false, // 强制刷新公式，公式较多会有性能问题，慎用
  rowHeaderWidth: 46,
  columnHeaderHeight: 20,
  defaultColWidth: 73,
  defaultRowHeight: 19,
  defaultFontSize: 10,
  toolbarItems: [
    'undo',
    'redo',
    'format-painter',
    'clear-format',
    '|',
    'currency',
    'percentage-format',
    'number-decrease',
    'number-increase',
    'format',
    '|',
    'font',
    '|',
    'font-size',
    '|',
    'bold',
    'italic',
    'strike-through',
    'underline',
    '|',
    'font-color',
    'background',
    'border',
    'merge-cell',
    '|',
    'horizontal-align',
    'vertical-align',
    'text-wrap',
    'text-rotation',
    '|',
    'freeze',
    'filter',
    'sort',
    'link',
    'image',
    'comment',
    'quick-formula',
    'dataVerification',
    'splitColumn',
    'locationCondition',
    'screenshot',
    'search',
  ], // 自定义工具栏
  cellContextMenu: [
    'split-text',
    'cut',
    'copy', // 复制
    'paste', // 粘贴
    '|',
    'insert-column', // 插入列
    'insert-cells',
    '|',
    'cell-delete-row', // 删除选中行
    'cell-delete-column', // 删除选中列
    'delete-cells',
    'clear', // 清除内容
    'delete-cell', // 删除单元格
    'hide-row', // 隐藏选中行和显示选中行
    'hide-column', // 隐藏选中列和显示选中列
    'set-row-height', // 设置行高
    'set-column-width', // 设置列宽
    '|',
    'conditionFormat',
    'sort', // 排序选区
    'ascSort',
    'desSort',
    'orderAZ', // 升序
    'orderZA', // 降序
    'filter', // 筛选选区
    'searchReplace',
    'dataVerification',
    '|',
    'chart', // 图表生成
    // "image", // 插入图片
    'link', // 插入链接
    'data', // 数据验证
    'cell-format', // 设置单元格格式
    'comment', // 添加注释
    '|',
    'clear-format',
  ], // 自定义单元格右键菜单
  headerContextMenu: [
    'copy', // 复制
    'paste', // 粘贴
    '|',
    'insert-row', // 插入行
    'insert-column', // 插入列
    '|',
    'delete-row', // 删除选中行
    'delete-column', // 删除选中列
    'clear', // 清除内容
    'delete-cell', // 删除单元格
    'hide-row', // 隐藏选中行和显示选中行
    'hide-column', // 隐藏选中列和显示选中列
    'set-row-height', // 设置行高
    'set-column-width', // 设置列宽
    '|',
    'split-text',
    'sort', // 排序选区
    'orderAZ', // 升序
    'orderZA', // 降序
    '|',
    'clear-format',
  ], // header菜单
  sheetTabContextMenu: [
    'delete',
    'copy',
    'rename',
    'color',
    'hide',
    '|',
    'move',
    // "focus",
  ], // 自定义底部sheet页右击菜单
  filterContextMenu: [
    'sort-by-asc',
    'sort-by-desc',
    // "|",
    // "filter-by-color",
    // "|",
    // "filter-by-condition",
    // "|",
    'filter-by-value',
  ], // 筛选菜单
  generateSheetId: () => uuidv4(),
  hooks: {},
  customToolbarItems: [],
  currency: '$',
  getCommentCellUI: null,
  onDuneChartEmbed: () => {},
  onSheetCountChange: () => {},
  isAuthorized: false,
  isFlvReadOnly: false,
  isRTCActive: false,
  dateBaseLocale: 'uk',
  suppressInitialCellSelection: false,
};
