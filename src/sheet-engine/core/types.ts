import { Patch as ImmerPatch } from 'immer';
import { PatchOptions } from './utils';
import type { CellFormatRange } from './utils/range-format';

export type Op = {
  op:
    | 'replace'
    | 'remove'
    | 'add'
    | 'insertRowCol'
    | 'deleteRowCol'
    | 'addSheet'
    | 'deleteSheet';
  id?: string;
  path: (string | number)[];
  value?: any;
};

export type Rect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type CellStyle = {
  bl?: number;
  it?: number;
  ff?: number | string;
  fs?: number;
  fc?: string;
  ht?: number;
  vt?: number;
  tb?: string;
  cl?: number;
  un?: number;
  tr?: string;
};

export type CellError = {
  title: string;
  message: string;
  left?: number;
  top?: number;
  row_column?: string;
};

export type Cell = {
  v?: string | number | boolean;
  m?: string | number;
  mc?: { r: number; c: number; rs?: number; cs?: number };
  f?: string;
  /** Size of the last array result, used to clear output when it shrinks. */
  spillRange?: { rows: number; columns: number };
  /** Origin of generated output; direct edits remove this ownership. */
  spillParent?: { r: number; c: number };
  /** Editor-only HTML snapshot for reopening multiline formulas as typed. */
  _formulaEditHtml?: string;
  /** `dp`: fixed decimal places for display when `fa` is General (Auto); does not change `fa`/`t`. */
  ct?: { fa?: string; t?: string; tb?: string; s?: any; dp?: number };
  qp?: number;
  spl?: any;
  bg?: string;
  lo?: number;
  rt?: number;
  baseValue?: number | string;
  baseCurrency?: string;
  baseCurrencyPrice?: string | number;
  isDataBlockFormula?: boolean;
  ps?: {
    left: number | null;
    top: number | null;
    width: number | null;
    height: number | null;
    value: string;
    isShow: boolean;
  };
  hl?: { r: number; c: number; id: string };
  error?: CellError;
} & CellStyle;

export type CellWithRowAndCol = {
  r: number;
  c: number;
  v: Cell | null;
};

export type CellMatrix = (Cell | null)[][];

export type HyperlinkEntry = { linkType: string; linkAddress: string };

export type Selection = {
  left?: number;
  width?: number;
  top?: number;
  height?: number;
  left_move?: number;
  width_move?: number;
  top_move?: number;
  height_move?: number;
  row: number[];
  column: number[];
  row_focus?: number;
  column_focus?: number;
  moveXY?: { x: number; y: number };
  row_select?: boolean;
  column_select?: boolean;
};

export type Presence = {
  sheetId: string;
  username: string;
  userId?: string;
  color: string;
  isEns?: boolean;
  selection: {
    r: number;
    c: number;
  };
};

export type SheetConfig = {
  merge?: Record<string, { r: number; c: number; rs: number; cs: number }>; // 合并单元格
  rowlen?: Record<string, number>; // 表格行高
  columnlen?: Record<string, number>; // 表格列宽
  rowhidden?: Record<string, number>; // 隐藏行（render-time union: manual ∪ filter）
  /**
   * Manually hidden rows (provenance-safe). `rowhidden` remains the render-time union of
   * manual + filter-hidden rows. This map stores only manual hides so filters can be
   * cleared without losing manual state.
   */
  rowhidden_manual?: Record<string, number>;
  /** Cached union of all filter-hidden rows on the sheet (derived from `ctx.filter[*].rowhidden`). */
  rowhidden_filter?: Record<string, number>;
  colhidden?: Record<string, number>; // 隐藏列
  customHeight?: Record<string, number>;
  customWidth?: Record<string, number>;
  borderInfo?: any[]; // 边框
  /** Range-level cell formatting for empty cells (toolbar bulk format). */
  cellFormatRanges?: CellFormatRange[];
  /** Background compaction revision (celldata + borderInfo); synced via Yjs. */
  sheetCompactionRev?: number;
  authority?: any;
  rowReadOnly?: Record<number, number>;
  colReadOnly?: Record<number, number>;
};

/**
 * Workbook-level named range (Google Sheets / Excel definedNames).
 * Runtime list lives on Context; persisted in Yjs as `${dsheetId}:definedNames`.
 */
export type DefinedName = {
  id: string;
  name: string;
  sheetId: string;
  range: {
    row: [number, number];
    column: [number, number];
  };
  scope: 'workbook' | 'sheet';
  /** When scope === 'sheet', which sheet owns the name. */
  localSheetId?: string;
  comment?: string;
};

export type Image = {
  id: string;
  width: number;
  height: number;
  left: number;
  top: number;
  src: string;
  originWidth?: number;
  originHeight?: number;
};

export type ConditionRulesProps = {
  editKey?: string | null;
  rulesType: string;
  rulesValue: string;
  textColor: { check: boolean; color: string };
  cellColor: { check: boolean; color: string };
  font: {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strikethrough: boolean;
  };
  betweenValue: { value1: string; value2: string };
  /** Preset for dateIs / dateBefore / dateAfter (allowed values depend on rule type). */
  datePreset: string;
  /** Declared format for stored date text (e.g. DD/MM/YYYY). */
  dateFormat: string;
  dateValue: string;
  repeatValue: string;
  projectValue: string;
};

export type LiveQueryData = {
  data: {
    row: number;
    column: number;
    function: string;
    value: any;
    id: string;
    name: string;
    subSheetId: string;
  };
  cellData: Cell;
};

export type Sheet = {
  name: string;
  config?: SheetConfig;
  order?: number;
  color?: string;
  data?: CellMatrix;
  celldata?: CellWithRowAndCol[];
  id?: string;
  images?: Image[];
  iframes?: {
    id: string;
    src: string;
    left: number;
    top: number;
    width: number;
    height: number;
  }[];
  zoomRatio?: number;
  column?: number;
  row?: number;
  addRows?: number;
  status?: number;
  hide?: number;
  luckysheet_select_save?: Selection[];
  luckysheet_selection_range?: {
    row: number[];
    column: number[];
  }[];
  calcChain?: any[];
  dataBlockCalcFunction?: { [key: string]: { [key: string]: any } };
  defaultRowHeight?: number;
  defaultColWidth?: number;
  showGridLines?: boolean | number;
  pivotTable?: any;
  isPivotTable?: boolean;
  filter?: Record<string, any>;
  filter_select?: { row: number[]; column: number[] };
  luckysheet_conditionformat_save?: any[];
  luckysheet_alternateformat_save?: any[];
  dataVerification?: any;
  /** Interned dataVerification entries; per-cell map may hold numeric refs into this list. */
  dataVerificationDefs?: any[];
  conditionRules?: ConditionRulesProps;
  hyperlink?: Record<string, HyperlinkEntry | HyperlinkEntry[]>;
  dynamicArray_compute?: any;
  dynamicArray?: any[];
  frozen?: {
    type: 'row' | 'column' | 'both' | 'rangeRow' | 'rangeColumn' | 'rangeBoth';
    range?: { row_focus: number; column_focus: number };
  };
  liveQueryList?: Record<string, LiveQueryData>;
};

export type CommentBox = {
  r: number;
  c: number;
  rc: string;
  autoFocus: boolean;
  value: string;
  size: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  } & Rect;
} & Rect;

export type SearchResult = {
  r: number;
  c: number;
  sheetName: string;
  sheetId: string;
  cellPosition: string;
  value: string;
};

export type LinkCardProps = {
  sheetId: string;
  r: number;
  c: number;
  rc: string;
  originText: string;
  originType: string;
  originAddress: string;
  /** Distinct links in this cell (rich text); view lists each with its own actions */
  links?: HyperlinkEntry[];
  /** When editing, index into `links` for multi-link cells (which URL is being edited) */
  editingLinkIndex?: number | null;
  position: { cellLeft: number; cellBottom: number };
  isEditing: boolean;
  selectingCellRange?: boolean;
  /** When true, link is applied only to the current selection (edit mode) */
  applyToSelection?: boolean;
  /** Character offsets in the cell to restore selection before applying link on Insert */
  selectionOffsets?: { start: number; end: number };
  /**
   * Normalized flat offset where typed / appended link text should go (selection focus),
   * especially when display text is edited and inserted. Falls back to selection end if unset.
   */
  linkInsertOffset?: number;
};

export type RangeDialogProps = {
  show: boolean;
  rangeTxt: string;
  type: string;
  singleSelect: boolean;
};

export type DataRegulationProps = {
  color?: string;
  type: string;
  type2: string;
  rangeTxt: string;
  value1: string;
  value2: string;
  validity: string;
  remote: boolean;
  prohibitInput: boolean;
  hintShow: boolean;
  hintValue: string;
};

export type FilterOptions = {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  left: number;
  top: number;
  width: number;
  height: number;
  items: {
    col: number;
    left: number;
    top: number;
  }[];
};

export type History = {
  patches: ImmerPatch[];
  inversePatches: ImmerPatch[];
  options?: PatchOptions;
};

export type Freezen = {
  horizontal?: { freezenhorizontaldata: any[]; top: number };
  vertical?: { freezenverticaldata: any[]; left: number };
};

export type GlobalCache = {
  /** True when the current edit session was started by typing into the sheet (not F2 / double-click / Enter-to-edit). */
  enteredEditByTyping?: boolean;
  /** When set, in-cell / formula-bar hydration from sheet data is skipped for this cell (type-to-edit replacement). */
  pendingTypeOverCell?: [number, number];
  verticalScrollLock?: boolean;
  horizontalScrollLock?: boolean;
  overwriteCell?: boolean;
  overwriteCellFirstChar?: string;
  ignoreWriteCell?: boolean;
  doNotFocus?: boolean;
  doNotUpdateCell?: boolean;
  recentTextColor?: string;
  recentBackgroundColor?: string;
  visibleColumnsUnique?: number[];
  visibleRowsUnique?: number[];
  undoList: History[];
  redoList: History[];
  editingCommentBoxEle?: HTMLDivElement;
  freezen?: Record<string, Freezen>;
  image?: {
    imgInitialPosition: Rect | undefined;
    cursorMoveStartPosition: { x: number; y: number } | undefined;
    resizingSide: string | undefined;
  };
  iframe?: {
    iframeInitialPosition: Rect | undefined;
    cursorMoveStartPosition: { x: number; y: number } | undefined;
    resizingSide: string | undefined;
  };
  commentBox?: {
    movingId: string | undefined;
    resizingId: string | undefined;
    resizingSide: string | undefined;
    commentRC: { r: number; c: number; rc: string };
    boxInitialPosition: Rect | undefined;
    cursorMoveStartPosition: { x: number; y: number } | undefined;
  };
  searchDialog?: {
    mouseEnter?: boolean;
    moveProps?: {
      initialPosition: Rect | undefined;
      cursorMoveStartPosition: { x: number; y: number } | undefined;
    };
  };
  /** Element to restore focus to after closing Quick Search (not stored in Immer context). */
  quickSearchReturnFocus?: Element | null;
  linkCard?: {
    mouseEnter?: boolean;
    rangeSelectionModal?: {
      initialPosition: Rect | undefined;
      cursorMoveStartPosition: { x: number; y: number } | undefined;
    };
  };
  /**
   * Last caret/selection in the cell editor while editing, captured on selectionchange
   * and on toolbar link mousedown so handleLink still knows insert offsets after focus moves.
   */
  linkEditorOpenSnapshot?: {
    sheetId: string;
    r: number;
    c: number;
    focusOffset: number;
    range: { start: number; end: number } | null;
    selectedPlain: string;
  };
  /** Injected by React: show modal when link insert is blocked (formula / = in editor). */
  onHyperlinkInsertBlocked?: () => void;
  dragCellStartPos?: {
    x: number;
    y: number;
  };
  touchMoveStatus?: boolean;
  touchHandleStatus?: boolean;
  touchMoveStartPos?: {
    x: number;
    y: number;
    vy: number;
    moveType: string;
    vy_x?: number;
    vy_y?: number;
    scrollTop?: number;
    scrollLeft?: number;
  };
  /** Live column right edge (px) while dragging column resize; not in Immer context. */
  colResizeLiveRightPx?: number;
  /** Live row bottom edge (px) while dragging row resize; not in Immer context. */
  rowResizeLiveBottomPx?: number;
};

export type SingleRange = { row: number[]; column: number[] };
export type Range = SingleRange[];
