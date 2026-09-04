// border
export { getBorderInfoComputeRange, getBorderInfoCompute } from './border';

// cell
export {
  normalizedCellAttr,
  normalizedAttr,
  getCellValue,
  setCellValue,
  getRealCellValue,
  mergeBorder,
  cancelNormalSelected,
  updateCell,
  getRangetxt,
  getRangeByTxt,
  isValidRangeText,
  getInlineStringHTML,
  getStyleByCell,
  clearSelectedCellFormat,
  clearRowsCellsFormat,
  clearColumnsCellsFormat,
  cancelFunctionrangeSelected,
} from './cell';

// clipboard
export { default as clipboard } from './clipboard';

// cursor
export { moveToEnd, getRangeRectsByCharacterOffset } from './cursor';

// date base locale
export {
  getDateBaseLocale,
  getCanonicalDateDisplayFormat,
  getCanonicalDateEditFormat,
  getDateEditFormatForCell,
  isUsDateBaseLocale,
  normalizeDateBaseLocale,
  shouldPreserveDateFormatForEdit,
  setDateBaseLocale,
} from './date-base-locale';

// format
export {
  update,
  is_date,
  valueShowEs,
  isTypedCurrencyDisplayFormat,
  isCurrencyLikeNumberFormat,
  buildFiatCurrencyFormat,
  quoteSsfLiteral,
} from './format';

// formula
export {
  FormulaCache,
  groupValuesRefresh,
  setCaretPosition,
  getrangeseleciton,
  getFormulaEditorOwner,
  rangeHightlightselected,
  handleFormulaInput,
  israngeseleciton,
  createRangeHightlight,
  createFormulaRangeSelect,
  maybeRecoverDirtyRangeSelection,
  delFunctionGroup,
  functionHTMLGenerate,
  onFormulaRangeDragEnd,
  rangeDrag,
  rangeSetValue,
  remapFormulaReferencesByMap,
  getFormulaRangeIndexAtCaret,
  isCaretAtValidFormulaRangeInsertionPoint,
  isLegacyFormulaRangeMode,
  markRangeSelectionDirty,
  getFormulaRangeIndexForKeyboardSync,
  isFormulaReferenceInputMode,
  seedFormulaFuncSelectedRangeFromLastSelection,
  functionStrChange,
  setFormulaEditorOwner,
  getAllFunctionGroup,
  suppressFormulaRangeSelectionForInitialEdit,
  ensureFormulaRangeToSheet,
  shouldPreserveFormulaEditOnSheetSwitch,
  activateSheetForNavigation,
  returnToFormulaOriginSheet,
} from './formula';
export {
  FORMULA_ASYNC_CHUNK_SIZE,
  FORMULA_ASYNC_EVAL_THRESHOLD,
  FORMULA_WORKER_CHUNK_SIZE,
  FORMULA_WORKER_THRESHOLD,
  isFormulaEvalPending,
} from './formula-async-eval';
export type { FormulaAsyncEvalJob } from './formula-async-eval';

// freeze
export { initFreeze } from './freeze';

// inline-string
export {
  isInlineStringCell,
  getInlineStringNoStyle,
  applyLinkToSelection,
  getHyperlinksFromInlineSegments,
  getUniformLinkFromWindowSelectionInEditor,
  getHyperlinkAtCaretInContentEditable,
} from './inline-string';

// location
export {
  rowLocation,
  rowLocationByIndex,
  colLocation,
  colLocationByIndex,
} from './location';

// rowcol
export {
  insertRowCol,
  deleteRowCol,
  hideSelected,
  showSelected,
  isShowHidenCR,
  hideCRCount,
} from './rowcol';

// row visibility (manual vs filter provenance)
export {
  getFilterHiddenRowsUnionFromFilterMap,
  getFilterHiddenRowsUnion,
  ensureManualHiddenInitialized,
  rebuildRowHiddenUnion,
} from './rowVisibility';

// selection
export {
  scrollToHighlightCell,
  seletedHighlistByindex,
  selectTitlesMap,
  selectTitlesRange,
  defaultLuckysheetSelectRanges,
  normalizeSelection,
  syncPrimaryCellActiveFromSelection,
  selectionIsExactlyOneMergeBlock,
  setPrimaryCellActive,
  advancePrimaryCellInLastMultiSelection,
  snapSheetSelectionFocusToCellPreserveMultiRange,
  moveHighlightCell,
  deleteSelectedCellText,
  selectAll,
  fixRowStyleOverflowInFreeze,
  fixColumnStyleOverflowInFreeze,
  calcSelectionInfo,
  rangeValueToHtml,
} from './selection';

// sheet
export {
  addSheet,
  deleteSheet,
  editSheetName,
  changeSheet,
  updateSheet,
} from './sheet';

// text — no direct imports needed from consumers

// toolbar
export {
  updateFormat,
  autoSelectionFormula,
  handleBold,
  handleItalic,
  handleStrikeThrough,
  handleUnderline,
  handleHorizontalAlign,
  handleVerticalAlign,
  handleTextColor,
  handleTextBackground,
  handleBorder,
  handleMerge,
  handleSort,
  handleFreeze,
  handleTextSize,
  handleSum,
  handleLink,
  captureLinkEditorOpenSnapshot,
  isHyperlinkCreationBlocked,
  toolbarItemClickHandler,
  toolbarItemSelectedFunc,
  updateFormatCell,
  cancelPaintModel,
} from './toolbar';

// screenshot
export { handleScreenShot } from './screenshot';

// comment
export {
  drawArrow,
  setEditingComment,
  removeEditingComment,
  newComment,
  editComment,
  deleteComment,
  showComments,
  showHideComment,
  showHideAllComments,
  getCommentBoxByRC,
  onCommentBoxMoveStart,
  onCommentBoxMove,
  onCommentBoxMoveEnd,
  onCommentBoxResize,
  onCommentBoxResizeEnd,
  removeOverShowComment,
} from './comment';

// image
export {
  showImgChooser,
  insertImage,
  removeActiveImage,
  copyActiveImage,
  cutActiveImage,
  pasteImageItem,
  loadImageFromFile,
  getImageClipboard,
  getImageCutSourceId,
  cancelActiveImgItem,
  onImageMoveStart,
  onImageResizeStart,
  onImageMove,
  onImageMoveEnd,
  onImageResize,
  onImageResizeEnd,
} from './image';

// dropCell
export {
  createDropCellRange,
  dropCellCache,
  getTypeItemHide,
  updateDropCell,
} from './dropCell';

// merge
export { mergeCells, mergeSelectionHasValues } from './merge';

// removeDuplicates
export {
  getRemoveDuplicatesPreview,
  removeDuplicates,
  getRemoveDuplicatesErrorMessage,
} from './removeDuplicates';
export type {
  RemoveDuplicatesColumnOption,
  RemoveDuplicatesError,
  RemoveDuplicatesOptions,
  RemoveDuplicatesPreview,
  RemoveDuplicatesResult,
} from './removeDuplicates';

// sort
export {
  sortSelection,
  sortSheetBySelectedColumn,
  spillSortResult,
} from './sort';

// screenshot — handleScreenShot already exported from toolbar

// searchReplace
export {
  searchAll,
  searchNext,
  replace,
  replaceAll,
  replaceAllScoped,
  getSearchIndexArr,
  getSearchIndexArrAsync,
  getFindRangeOnCurrentSheet,
  getQuickSearchIndexArr,
  getQuickSearchHiddenConfig,
  expandCellRectForMerge,
  shouldQuickSearchUseAsync,
  runQuickSearchIndexArrAsync,
  QUICK_SEARCH_ASYNC_ROW_THRESHOLD,
  parseRangeText,
} from './searchReplace';
export type {
  CheckModes,
  HyperlinkMap,
  FindSearchScope,
  ReplaceScope,
  SearchHiddenConfig,
  SearchNextResult,
  ReplaceAllResult,
} from './searchReplace';

// hyperlink
export {
  getCellRowColumn,
  getCellHyperlink,
  getCellHyperlinks,
  getHyperlinkDisplayTextInCell,
  getInlineLinkPlainRange,
  getUniformLinkCoveringPlainRange,
  getUniformLinkAtPlainOffset,
  saveHyperlink,
  removeHyperlink,
  removeHyperlinkForLink,
  updateHyperlinkForLink,
  syncLinkCardAfterHyperlinkChange,
  showLinkCard,
  goToLink,
  isLinkValid,
} from './hyperlink';

// filter
export {
  createFilterOptions,
  clearFilter,
  clearFilterForColumn,
  toggleViewerFilter,
  createFilter,
  applySheetFilterState,
  getFilterColumnValues,
  getFilterColumnColors,
  orderbydatafiler,
  saveFilter,
} from './filter';
export type { FilterDate, FilterValue, FilterColor } from './filter';

// moveCells
export { onCellsMoveStart, onCellsMove, onCellsMoveEnd } from './moveCells';

// conditionalFormat
export { cfSplitRange } from './conditionalFormat';

// ConditionFormat (additional internal exports)
export { CFSplitRange } from './ConditionFormat';

// splitColumn
export { updateMoreCell, getRegStr, getDataArr } from './splitColumn';

// locationCondition
export {
  applyLocation,
  getOptionValue,
  getSelectRange,
} from './locationCondition';

// dataVerification
export {
  getDropdownList,
  setDropdownValue,
  confirmMessage,
  cellFocus,
  validateCellData,
} from './dataVerification';

// ConditionFormat
export {
  setConditionRules,
  CF_DATE_DEFAULT_FORMAT,
  parseCfDateConditionForUi,
  formatCfDatePresetSnapshot,
  parseDdMmYyyyToSerial,
} from './ConditionFormat';

// mobile
export { handleOverlayTouchStart, handleOverlayTouchEnd } from './mobile';

// zoom
export { MAX_ZOOM_RATIO, MIN_ZOOM_RATIO } from './zoom';

// refresh
export { jfrefreshgrid } from './refresh';

// iframe
export {
  sanitizeDuneUrl,
  insertDuneChart,
  onIframeMoveStart,
  onIframeResizeStart,
  onIframeMove,
  onIframeMoveEnd,
  onIframeResize,
  onIframeResizeEnd,
} from './iframe';

// error-state-helpers (used internally by formula.ts and events/mouse.ts via barrel)
export {
  setCellError,
  clearCellError,
  overShowError,
} from './error-state-helpers';

// protection (used internally by utils/index.ts)
export { checkCellIsLocked } from './protection';

// validation (used internally by text.ts, dataVerification.ts, sort.ts via barrel)
export {
  detectDateFormat,
  isdatatypemulti,
  diff,
  isdatetime,
  isRealNull,
  isRealNum,
  isNumericCellType,
} from './validation';

// formula (additional internal exports)
export {
  iscelldata,
  getcellrange,
  execfunction,
  execFunctionGroup,
  refreshFormulasUsingDefinedNames,
  runFormulaEvalChunk,
  applyWorkerFormulaChunkResults,
  insertUpdateFunctionGroup,
  functionCopy,
} from './formula';

// ConditionFormat (additional internal exports)
export { checkCF, getComputeMap } from './ConditionFormat';

// named ranges (workbook-level defined names)
export {
  isValidDefinedNameIdentifier,
  getDefinedNameDisplayRange,
  findDefinedNameForSelection,
  findDefinedNameByName,
  resolveDefinedNameForFormula,
  addDefinedName,
  updateDefinedName,
  deleteDefinedName,
  selectDefinedName,
  openNamedRangesSidebar,
  scheduleDefinedNamesSync,
  shiftDefinedNamesOnInsert,
  shiftDefinedNamesOnDelete,
  removeDefinedNamesForSheet,
} from './namedRanges';

// cell (additional internal exports)
export { getdatabyselection, getQKBorder } from './cell';
