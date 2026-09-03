import React, {
  useContext,
  useCallback,
  useRef,
  useEffect,
  useState,
} from 'react';
import {
  toolbarItemClickHandler,
  handleTextBackground,
  handleTextColor,
  handleTextSize,
  normalizedCellAttr,
  getFlowdata,
  newComment,
  editComment,
  deleteComment,
  showHideComment,
  showHideAllComments,
  captureLinkEditorOpenSnapshot,
  locale,
  handleMerge,
  mergeSelectionHasValues,
  handleBorder,
  toolbarItemSelectedFunc,
  handleFreeze,
  insertImage,
  showImgChooser,
  updateFormat,
  handleHorizontalAlign,
  handleVerticalAlign,
  handleScreenShot,
  createFilter,
  clearFilter,
  toggleViewerFilter,
  applyLocation,
  getFormulaEditorOwner,
  Cell,
  api,
  is_date,
  isHyperlinkCreationBlocked,
  isTypedCurrencyDisplayFormat,
} from '@sheet-engine/core';
import _ from 'lodash';
import {
  IconButton,
  LucideIcon,
  Tooltip,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@fileverse/ui';
import { useRemoveDuplicatesDialog } from '../RemoveDuplicates';
// import DataVerification from "../DataVerification";
import WorkbookContext from '../../context';
import './index.css';
import Button from './Button';
import Divider, { MenuDivider } from './Divider';
import Combo from './Combo';
import Select, { Option } from './Select';
import SVGIcon from '../SVGIcon';
import { useDialog } from '../../hooks/useDialog';
import { useAlert } from '../../hooks/useAlert';
import { SplitColumn } from '../SplitColumn';
import { LocationCondition } from '../LocationCondition';
// import ConditionalFormat from "../ConditionFormat";
import CustomButton from './CustomButton';
import { CustomColor } from './CustomColor';
import { FormatSearch } from '../FormatSearch';
import MoreItemsContaier from './MoreItemsContainer';
import { getGroupedCurrencyOptions, CRYPTO_OPTIONS } from '../../constants';
import { buildFiatCurrencyFormat } from '@sheet-engine/core';
import { convertCellsToCrypto } from '../../utils/convertCellsToCrypto';
import { updateCellsDecimalFormat } from '../../utils/updateCellsDecimalFormat';
import { FunctionList } from './FunctionList/FunctionListButton';
import SortPopoverContent from './SortPopoverContent';

export const getLucideIcon = (title: string) => {
  switch (title) {
    case 'undo':
      return 'Undo';
    case 'redo':
      return 'Redo';
    case 'format-painter':
      return 'PaintRoller';
    case 'bold':
      return 'Bold';
    case 'italic':
      return 'Italic';
    case 'strike-through':
      return 'Strikethrough';
    case 'underline':
      return 'Underline';
    case 'align-left':
      return 'AlignLeft';
    case 'align-center':
      return 'AlignCenter';
    case 'align-right':
      return 'AlignRight';
    case 'align-top':
      return 'ArrowUpFromLine';
    case 'align-middle':
      return 'AlignVerticalMiddle';
    case 'align-bottom':
      return 'ArrowDownToLine';
    case 'text-overflow':
      return 'TextOverflow';
    case 'text-wrap':
      return 'WrapText';
    case 'text-clip':
      return 'TextClip';
    case 'font-color':
      return 'Baseline';
    case 'background':
      return 'PaintBucket';
    case 'border-all':
      return 'Border';
    case 'merge-all':
      return 'MergeHorizontal';
    case 'format':
      return 'DollarSign';
    case 'currency-format':
      return 'DollarSign';
    case 'currency':
      return 'ChevronDown';
    case 'percentage-format':
      return 'Percent';
    case 'number-decrease':
      return 'DecimalsArrowLeft';
    case 'number-increase':
      return 'DecimalsArrowRight';
    case 'conditionFormat':
      return 'PaintbrushVertical';
    case 'filter':
      return 'Filter';
    case 'sort':
      return 'ArrowDownUp';
    case 'link':
      return 'Link';
    case 'comment':
      return 'MessageSquarePlus';
    case 'image':
      return 'Image';
    case 'formula-sum':
      return 'Sigma';
    case 'dataVerification':
      return 'ShieldCheck';
    case 'search':
      return 'Search';
    case 'dune':
      return 'DuneChart';
    case 'crypto':
      return 'Ethereum';
    case 'Ellipsis':
      return 'Ellipsis';
    default:
      return '';
  }
};

export const CurrencySelector = ({
  cell,
  defaultTextFormat,
  toolTipText,
}: {
  cell: Cell | null | undefined;
  defaultTextFormat: string;
  toolTipText: string;
}) => {
  const { context, setContext, refs } = useContext(WorkbookContext);

  const [searchTerm, setSearchTerm] = useState('');
  const [decimals, setDecimals] = useState(2);
  const [selectedFiat, setSelectedFiat] = useState<string>('USD');

  let currentFmt = defaultTextFormat;
  const currentIcon = 'currency';
  if (cell) {
    const curr = normalizedCellAttr(cell, 'ct');
    if (curr?.fa) {
      // Try to match with crypto or fiat
      const allOptions = [
        ...CRYPTO_OPTIONS,
        ...locale(context).currencyDetail.map(
          (c: {
            name: string;
            value: string;
            pos: string;
            geckoId: string;
          }) => ({
            label: c.name,
            value: c.value,
            icon: undefined,
            type: 'fiat',
          }),
        ),
      ];
      const found = [...allOptions]
        .sort((a, b) => b.value.length - a.value.length) // sort longest first
        .find((o) => curr.fa.includes(o.value));
      if (found) {
        currentFmt = found.label;
      }
    }
  }
  const groupedOptions = getGroupedCurrencyOptions(
    locale(context).currencyDetail,
  );
  // Filter options by search term
  const filterOptions = (options: any[]): any[] => {
    if (!searchTerm.trim()) return options;
    const query = searchTerm.trim().toLowerCase();
    // Split query into words and require all words to match somewhere in label or value
    return options.filter((opt: any) =>
      query
        .split(/\s+/)
        .every(
          (word) =>
            opt.label.toLowerCase().includes(word) ||
            opt.value.toLowerCase().includes(word),
        ),
    );
  };

  // Utility to deduplicate by value
  const dedupeByValue = (options: any[]) => {
    const seen = new Set();
    return options.filter((opt) => {
      if (seen.has(opt.value)) return false;
      seen.add(opt.value);
      return true;
    });
  };

  const handleCurrencyDecimalsChange = (newDecimals: number) => {
    setDecimals(newDecimals);
    let isCrypto = false;
    if (cell && cell.ct && typeof cell.ct.fa === 'string') {
      const [, matchedDenom] = cell.ct.fa.match(/"([A-Z]+)"/) || [];
      if (matchedDenom) isCrypto = true;
    }
    updateCellsDecimalFormat({
      context,
      setContext,
      decimals: newDecimals,
      denomination: isCrypto ? undefined : selectedFiat,
    });
  };
  const triggerRef = useRef(null);
  return (
    <div
      style={{ padding: '0px' }}
      className="items-center fortune-toolbar-button"
    >
      <Tooltip text={toolTipText} position="bottom">
        <div
          className=""
          onClick={() => {
            // setContext((draftCtx) => {
            //   toolbarItemClickHandler("currency-format")?.(
            //     draftCtx,
            //     refs.cellInput.current!,
            //     refs.globalCache
            //   );
            // })
            // @ts-ignore
            triggerRef?.current?.click();
          }}
          tabIndex={0}
          role="button"
        >
          <LucideIcon
            name={getLucideIcon('currency-format')}
            width={16}
            height={16}
          />
        </div>
      </Tooltip>
      <Combo
        iconId={currentIcon}
        text={currentFmt}
        key="currency"
        tooltip=""
        showArrow
        triggerRef={triggerRef}
      >
        {(setOpen) => {
          return (
            <div
              style={{
                minWidth: '20rem',
                boxShadow: '2px 2px 10px rgba(0, 0, 0, 0.2)',
                borderRadius: '8px',
              }}
            >
              {/* Command UI for search and options */}
              <Command className="border color-border-default rounded-lg">
                <div id="search-input-container">
                  <CommandInput
                    placeholder="Search by name or code"
                    value={searchTerm}
                    onValueChange={(value) => {
                      setSearchTerm(value);
                    }}
                  />
                </div>
                {/* Decimal places UI */}
                <div
                  className="px-4 py-2 border-b color-border-default flex items-center justify-between gap-2 text-body-sm color-text-default"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span>Decimal places:</span>
                  <span className="cds-row flex items-center">
                    <IconButton
                      icon="Minus"
                      variant="ghost"
                      size="sm"
                      className=""
                      disabled={decimals === 1}
                      onClick={() =>
                        handleCurrencyDecimalsChange(Math.max(1, decimals - 1))
                      }
                    />
                    <input
                      type="number"
                      min={1}
                      max={18}
                      value={decimals}
                      onChange={(e) =>
                        handleCurrencyDecimalsChange(
                          Math.max(1, Math.min(18, Number(e.target.value))),
                        )
                      }
                      className="color-text-default color-border-default color-bg-default"
                    />
                    <IconButton
                      icon="Plus"
                      variant="ghost"
                      size="sm"
                      disabled={decimals === 18}
                      onClick={() =>
                        handleCurrencyDecimalsChange(Math.min(18, decimals + 1))
                      }
                    />
                  </span>
                </div>
                <CommandList>
                  <CommandEmpty
                    className="text-center text-body-sm color-text-secondary flex items-center justify-center"
                    style={{ minHeight: '5rem' }}
                  >
                    No results found.
                  </CommandEmpty>
                  {groupedOptions.map((group) => {
                    // Filter and dedupe
                    const filtered = dedupeByValue(
                      filterOptions(group.options),
                    );
                    return (
                      <CommandGroup key={group.group} heading={group.group}>
                        {filtered.map((opt) => {
                          return (
                            <CommandItem
                              key={opt.value}
                              value={`${opt.label} ${opt.value}`}
                              onSelect={async () => {
                                if (opt.type === 'crypto') {
                                  await convertCellsToCrypto({
                                    context,
                                    setContext,
                                    denomination: opt.value,
                                    decimals,
                                  });
                                } else {
                                  setSelectedFiat(opt.geckoId || opt.value);
                                  setContext((ctx) => {
                                    const d = getFlowdata(ctx);
                                    if (d == null) return;
                                    const formatString = buildFiatCurrencyFormat(
                                      opt.value,
                                      decimals,
                                    );
                                    updateFormat(
                                      ctx,
                                      refs.cellInput.current!,
                                      d,
                                      'ct',
                                      formatString,
                                    );
                                    if (opt.geckoId) {
                                      const selections =
                                        ctx.luckysheet_select_save;
                                      selections?.forEach((selection: any) => {
                                        for (
                                          let row = selection.row[0];
                                          row <= selection.row[1];
                                          row += 1
                                        ) {
                                          for (
                                            let col = selection.column[0];
                                            col <= selection.column[1];
                                            col += 1
                                          ) {
                                            const cell = d[row]?.[col];
                                            if (cell) {
                                              cell.baseCurrency = opt.geckoId;
                                            }
                                          }
                                        }
                                      });
                                    }
                                  });
                                }
                                setOpen(false);
                              }}
                            >
                              <div className="fortune-toolbar-menu-line flex items-center justify-between w-full">
                                <div className="flex items-center gap-2 w-[250px]">
                                  {currentFmt === opt.label ? (
                                    <LucideIcon
                                      name="Check"
                                      className="w-4 h-4"
                                    />
                                  ) : (
                                    <span className="w-4 h-4" />
                                  )}
                                  <span className="truncate flex-1 overflow-hidden whitespace-nowrap">
                                    {opt.label}
                                  </span>
                                </div>
                                {opt.type === 'crypto' ? (
                                  <span className="color-text-secondary">
                                    <LucideIcon
                                      name={opt.icon}
                                      className="cds-icon"
                                    />
                                    {/* {opt.value === 'SOL' && (
                                      <SVGIcon
                                        name="solana"
                                        width={16}
                                        height={16}
                                      />
                                    )} */}
                                  </span>
                                ) : (
                                  <span className="color-text-secondary">
                                    {opt.value}
                                  </span>
                                )}
                              </div>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    );
                  })}
                </CommandList>
              </Command>
            </div>
          );
        }}
      </Combo>
    </div>
  );
};

const Toolbar: React.FC<{
  setMoreItems: React.Dispatch<React.SetStateAction<React.ReactNode>>;
  moreItemsOpen: boolean;
  onMoreToolbarItemsClose?: () => void;
  moreToolbarItems?: React.ReactNode;
  trailingContent?: React.ReactNode;
}> = ({
  setMoreItems,
  moreItemsOpen,
  onMoreToolbarItemsClose,
  moreToolbarItems,
  trailingContent,
}) => {
    const { context, setContext, refs, settings, handleUndo, handleRedo } =
      useContext(WorkbookContext);

    const restoreEditorFocusAfterToolbarAction = useCallback(() => {
      if (context.luckysheetCellUpdate.length === 0) return;
      requestAnimationFrame(() => {
        const owner = getFormulaEditorOwner(context);
        const target =
          owner === 'fx' ? refs.fxInput.current : refs.cellInput.current;
        target?.focus();
      });
    }, [context, refs.cellInput, refs.fxInput]);

    const contextRef = useRef(context);
    const containerRef = useRef<HTMLDivElement>(null);
    const rightToolbarRef = useRef<HTMLDivElement>(null);
    const [toolbarWrapIndex, setToolbarWrapIndex] = useState(-1);
    const [rightToolbarWidth, setRightToolbarWidth] = useState(30);
    const [showDuneModal, setShowDuneModal] = useState(false);
    const [itemLocations, setItemLocations] = useState<number[]>([]);
    // const [showDuneModal, setShowDuneModal] = useState(false);
    const [isDesktop, setIsDesktop] = useState(window.innerWidth >= 1480);
    const { showDialog, hideDialog } = useDialog();
    const { showAlert, hideAlert } = useAlert();

    useEffect(() => {
      const gc = refs.globalCache;
      if (!gc) return undefined;
      gc.onHyperlinkInsertBlocked = () => {
        showDialog(
          'Cannot create hyperlink. Cell may be non-editable or may contain a formula.',
          'ok',
          'There was a problem',
          'OK',
          undefined,
          hideDialog,
          hideDialog,
        );
      };
      return () => {
        delete gc.onHyperlinkInsertBlocked;
      };
    }, [refs, showDialog, hideDialog]);
    const firstSelection = context.luckysheet_select_save?.[0];
    const flowdata = getFlowdata(context);
    contextRef.current = context;
    const row = firstSelection?.row_focus;

    const col = firstSelection?.column_focus;
    const cell =
      flowdata && row != null && col != null ? flowdata?.[row]?.[col] : undefined;
    const {
      toolbar,
      merge,
      border,
      freezen,
      defaultFmt,
      formula,
      sort,
      align,
      textWrap,
      rotation,
      screenshot,
      filter,
      splitText,
      findAndReplace,
      comment,
      fontarray,
      sheetconfig,
    } = locale(context);
    const toolbarFormat = locale(context).format;
    const sheetWidth = context.luckysheetTableContentHW[0];
    const { currency } = settings;
    const defaultFormat = defaultFmt(currency);

    const [customColor] = useState('#000000');
    const [customStyle] = useState('1');

    const showSubMenu = useCallback(
      (e: React.MouseEvent<HTMLDivElement, MouseEvent>, className: string) => {
        const target = e.target as HTMLDivElement;
        const menuItem =
          target.className === 'fortune-toolbar-menu-line'
            ? target.parentElement!
            : target;
        const menuItemRect = menuItem.getBoundingClientRect();
        const workbookContainerRect =
          refs.workbookContainer.current!.getBoundingClientRect();
        const subMenu = menuItem.querySelector(`.${className}`) as HTMLDivElement;
        if (_.isNil(subMenu)) return;
        const menuItemStyle = window.getComputedStyle(menuItem);
        const menuItemPaddingRight = parseFloat(
          menuItemStyle.getPropertyValue('padding-right').replace('px', ''),
        );

        if (
          workbookContainerRect.right - menuItemRect.right <
          parseFloat(subMenu.style.width.replace('px', ''))
        ) {
          subMenu.style.display = 'block';
          subMenu.style.right = `${menuItemRect.width - menuItemPaddingRight}px`;
        } else {
          subMenu.style.display = 'block';
          subMenu.style.right =
            className === 'more-format'
              ? `${-(parseFloat(subMenu.style.width.replace('px', '')) + 0)}px`
              : `${-(
                parseFloat(subMenu.style.width.replace('px', '')) +
                menuItemPaddingRight
              )}px`;
        }
      },
      [refs.workbookContainer],
    );

    const hideSubMenu = useCallback(
      (e: React.MouseEvent<HTMLDivElement, MouseEvent>, className: string) => {
        const target = e.target as HTMLDivElement;

        if (target.className === `${className}`) {
          target.style.display = 'none';
          return;
        }

        const subMenu = (
          target.className === 'condition-format-item'
            ? target.parentElement
            : target.querySelector(`.${className}`)
        ) as HTMLDivElement;
        if (_.isNil(subMenu)) return;
        subMenu.style.display = 'none';
      },
      [],
    );

    const toolbarItemsKey = settings.toolbarItems.join('|');
    const customToolbarItemsKey = settings.customToolbarItems
      .map((item) => item.key)
      .join('|');

    useEffect(() => {
      const rightToolbar = rightToolbarRef.current;
      if (!rightToolbar) return;

      const updateRightToolbarWidth = () => {
        setRightToolbarWidth(
          Math.ceil(rightToolbar.getBoundingClientRect().width),
        );
      };

      updateRightToolbarWidth();
      if (typeof ResizeObserver === 'undefined') return;

      const resizeObserver = new ResizeObserver(updateRightToolbarWidth);
      resizeObserver.observe(rightToolbar);
      return () => resizeObserver.disconnect();
    }, []);

    // rerender the entire toolbar before recalculating the wrap position
    useEffect(() => {
      setToolbarWrapIndex(-1);
      setMoreItems(null);
    }, [
      customToolbarItemsKey,
      rightToolbarWidth,
      setMoreItems,
      sheetWidth,
      toolbarItemsKey,
    ]);

    // calculate the position after which items should be wrapped
    useEffect(() => {
      if (toolbarWrapIndex !== -1) return;
      const container = containerRef.current!;
      if (!container) return;
      const items = container.querySelectorAll(
        '.fortune-toolbar-left .fortune-toolbar-item',
      );
      if (items.length === 0) return;

      const moreButtonWidth = 50;
      const containerRect = container.getBoundingClientRect();
      const availableWidth =
        containerRect.width - Math.max(30, rightToolbarWidth);

      for (let i = items.length - 1; i >= 0; i -= 1) {
        const itemRect = items[i].getBoundingClientRect();
        const loc = itemRect.left - containerRect.left + itemRect.width;
        if (loc + moreButtonWidth < availableWidth) {
          setToolbarWrapIndex(
            i - items.length + settings.toolbarItems.length,
          );
          if (i === items.length - 1) {
            setMoreItems(null);
          }
          break;
        }
      }
    }, [
      customToolbarItemsKey,
      rightToolbarWidth,
      setMoreItems,
      settings.toolbarItems.length,
      sheetWidth,
      toolbarItemsKey,
      toolbarWrapIndex,
    ]);

    useEffect(() => {
      setContext((ctx) => {
        ctx.dataVerification!.dataRegulation!.value1 = 'value1';
      });
    }, []);

    const dataVerificationClick = useCallback(
      (selectedCells: any) => {
        const selection = api.getSelection(context);
        if (!selection && !selectedCells) {
          setContext((ctx) => {
            api.setSelection(ctx, [{ row: [0, 0], column: [0, 0] }], {
              id: context.currentSheetId,
            });
          });
        }
        document.getElementById('data-verification-button')?.click();
      },
      [context, setContext],
    );

    const conditionalFormatClick = useCallback(
      (selectedCells: any) => {
        setContext((ctx) => {
          const selection =
            Array.isArray(selectedCells) && selectedCells.length > 0
              ? selectedCells
              : api.getSelection(ctx);
          if (selection?.length) {
            ctx.luckysheet_select_save = selection;
          } else {
            api.setSelection(ctx, [{ row: [0, 0], column: [0, 0] }], {
              id: ctx.currentSheetId,
            });
          }
        });
        document.getElementById('conditional-format-button')?.click();
      },
      [setContext],
    );

    const { openRemoveDuplicatesDialog } = useRemoveDuplicatesDialog();

    useEffect(() => {
      // @ts-ignore
      window.dataVerificationClick = dataVerificationClick;
      // @ts-ignore
      window.conditionalFormatClick = conditionalFormatClick;
      // @ts-ignore
      window.removeDuplicatesClick = openRemoveDuplicatesDialog;
    }, [dataVerificationClick, conditionalFormatClick, openRemoveDuplicatesDialog]);

    // Sync toolbar recent colors from selected cell so picker and display stay correct (only when cell exists)
    useEffect(() => {
      if (cell != null) {
        refs.globalCache.recentTextColor = normalizedCellAttr(cell, 'fc');
        refs.globalCache.recentBackgroundColor = normalizedCellAttr(cell, 'bg');
      }
    }, [cell, refs.globalCache]);

    const getToolbarItem = useCallback(
      (name: string, i: number) => {
        // @ts-ignore
        const tooltip = toolbar[name];
        if (name === '|') {
          return <Divider key={i} />;
        }
        if (['font-color', 'background'].includes(name)) {
          // Show selected cell's format when a cell exists; for empty/no cell use defaults so we never show wrong color
          const displayTextColor =
            cell != null ? normalizedCellAttr(cell, 'fc') : '#000000';
          const displayBackgroundColor =
            cell != null ? normalizedCellAttr(cell, 'bg') : undefined;

          const pick = (color: string | undefined) => {
            setContext((draftCtx) =>
              (name === 'font-color' ? handleTextColor : handleTextBackground)(
                draftCtx,
                refs.cellInput.current!,
                color as string,
              ),
            );
            if (name === 'font-color') {
              refs.globalCache.recentTextColor = color;
            } else {
              refs.globalCache.recentBackgroundColor = color;
            }
          };
          return (
            <div style={{ position: 'relative' }} key={name}>
              <div
                style={{
                  width: 24,
                  height: 4,
                  backgroundColor:
                    name === 'font-color'
                      ? displayTextColor
                      : displayBackgroundColor,
                  position: 'absolute',
                  bottom: 2,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 100,
                  pointerEvents: 'none',
                }}
              />
              <Combo
                iconId={name}
                tooltip={tooltip}
                showArrow={false}
                fillColor={name === 'font-color' ? displayTextColor : undefined}
                onClick={() => {
                  const color =
                    name === 'font-color'
                      ? displayTextColor
                      : displayBackgroundColor;
                  if (color) pick(color);
                }}
              >
                {(setOpen) => (
                  <CustomColor
                    onCustomPick={(color) => {
                      pick(color);
                      setOpen(false);
                    }}
                    onColorPick={(color) => {
                      pick(color);
                      setOpen(false);
                    }}
                  />
                )}
              </Combo>
            </div>
          );
        }
        if (name === 'format') {
          let currentFmt = defaultFormat[0].text;
          if (cell) {
            const curr = normalizedCellAttr(cell, 'ct');
            const format = _.find(defaultFormat, (v) => v.value === curr?.fa);
            if (curr?.fa != null) {
              const hasTime = /[hH]:/.test(curr.fa);

              if (curr.t === 'd') {
                currentFmt = hasTime ? 'Date time' : 'Date';
              } else if (curr.t === 'g' && curr.fa === 'General') {
                // General lives at index 0 ("Auto"); last item is "more formats", not Automatic.
                currentFmt = defaultFormat[0].text;
              } else if (format != null) {
                // Exact preset match (Currency, Accounting, Number, etc.) before heuristics:
                // currency/accounting patterns contain "#,##0" and would be mislabeled "Number".
                currentFmt = format.text;
              } else if (curr.fa.includes('%')) {
                // Freshly typed percentages use the implicit "0%" mask from auto-detect.
                // Keep these under Auto so behavior matches other direct typed values.
                // Explicit percent presets (e.g. "#0.00%") should still show Percent.
                currentFmt = curr.fa === '0%' ? defaultFormat[0].text : 'Percent';
              } else if (is_date(curr.fa)) {
                currentFmt = hasTime ? 'Date time' : 'Date';
              } else if (
                isTypedCurrencyDisplayFormat(
                  curr.fa,
                  locale(context).currencyDetail,
                )
              ) {
                // Typed $123 / BTC… keeps currency display via `fa` but format menu shows Auto (like plain numbers).
                currentFmt = defaultFormat[0].text;
              } else if (
                curr.t === 'n' ||
                curr.fa.includes('#,##0') ||
                curr.fa === '0' ||
                curr.fa === '0.00'
              ) {
                currentFmt = 'Number';
              } else {
                currentFmt = defaultFormat[0].text;
              }
            }
          }
          return (
            <Combo
              text={currentFmt}
              key={name}
              tooltip={tooltip}
              showArrow={false}
            >
              {(setOpen) => (
                <Select>
                  {defaultFormat.map(
                    (
                      {
                        text,
                        value,
                        example,
                      }: { text: string; value: string; example: string },
                      ii: number,
                    ) => {
                      if (value === 'split') {
                        return <MenuDivider key={ii} />;
                      }
                      if (value === 'fmtOtherSelf') {
                        return (
                          <Option
                            key={value}
                            onClick={() => {
                              showDialog(
                                <FormatSearch
                                  onCancel={hideDialog}
                                  type="currency"
                                />,
                                undefined,
                                'Currency Format',
                              );
                              setOpen(false);
                            }}
                          >
                            <div className="fortune-toolbar-menu-line">
                              <div className="flex gap-2 items-center">
                                {currentFmt === text ? (
                                  <LucideIcon name="Check" className="w-4 h-4" />
                                ) : (
                                  <span className="w-4 h-4" />
                                )}
                                <div>{text}</div>
                              </div>
                              <LucideIcon
                                name="ChevronRight"
                                className="w-4 h-4 color-icon-secondary"
                              />
                            </div>
                          </Option>
                        );
                      }
                      return (
                        <Option
                          key={value}
                          onClick={() => {
                            setOpen(false);
                            setContext((ctx) => {
                              const d = getFlowdata(ctx);
                              if (d == null) return;
                              updateFormat(
                                ctx,
                                refs.cellInput.current!,
                                d,
                                'ct',
                                value,
                              );
                            });
                          }}
                        >
                          <div
                            style={{ overflowX: 'scroll' }}
                            className="fortune-toolbar-menu-line scrollbar-hidden w-full"
                          >
                            <div className="flex gap-2 items-center">
                              {currentFmt === text ? (
                                <LucideIcon name="Check" className="w-4 h-4" />
                              ) : (
                                <span className="w-4 h-4" />
                              )}
                              <div>{text}</div>
                            </div>
                            <div className="fortune-toolbar-subtext">
                              {example}
                            </div>
                          </div>
                        </Option>
                      );
                    },
                  )}
                </Select>
              )}
            </Combo>
          );
        }
        if (name === 'font') {
          let current = fontarray[0];
          if (cell?.ff != null) {
            if (_.isNumber(cell.ff)) {
              current = fontarray[cell.ff];
            } else {
              current = cell.ff;
            }
          }
          return (
            <Combo text={current} key={name} tooltip={tooltip} showArrow={false}>
              {(setOpen) => (
                <Select>
                  {fontarray.map((o: string) => (
                    <Option
                      key={o}
                      onClick={() => {
                        setContext((ctx) => {
                          current = o;
                          const d = getFlowdata(ctx);
                          if (!d) return;
                          updateFormat(ctx, refs.cellInput.current!, d, 'ff', o);
                        });
                        setOpen(false);
                      }}
                    >
                      {o}
                    </Option>
                  ))}
                </Select>
              )}
            </Combo>
          );
        }
        if (name === 'font-size') {
          return (
            <Combo
              text={
                cell
                  ? normalizedCellAttr(cell, 'fs', context.defaultFontSize)
                  : context.defaultFontSize.toString()
              }
              key={name}
              tooltip={tooltip}
              showArrow={false}
            >
              {(setOpen) => (
                <Select
                  style={{
                    minWidth: 'fit-content',
                    width: '50px',
                  }}
                >
                  {[
                    9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72,
                  ].map((num) => (
                    <div
                      className="fortune-toolbar-select-option text-body-sm text-center color-text-default"
                      style={{
                        minWidth: 'fit-content',
                        padding: '0px',
                        width: '36px',
                        height: '36px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '14px',
                      }}
                      key={num}
                      onClick={() => {
                        setContext((draftContext) =>
                          handleTextSize(
                            draftContext,
                            refs.cellInput.current!,
                            num,
                            refs.canvas.current!.getContext('2d')!,
                          ),
                        );
                        setOpen(false);
                      }}
                    >
                      {num}
                    </div>
                  ))}
                </Select>
              )}
            </Combo>
          );
        }
        if (name === 'horizontal-align') {
          const items = [
            {
              title: 'align-left',
              text: align.left,
              value: 1,
            },
            {
              title: 'align-center',
              text: align.center,
              value: 0,
            },
            {
              title: 'align-right',
              text: align.right,
              value: 2,
            },
          ];
          return (
            <Combo
              iconId={
                _.find(items, (item) => `${item.value}` === `${cell?.ht}`)
                  ?.title || 'align-left'
              }
              key={name}
              tooltip={toolbar.horizontalAlign}
              showArrow={false}
            >
              {(setOpen) => (
                <Select
                  style={{
                    minWidth: 'fit-content',
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                  }}
                >
                  {items.map(({ title }) => (
                    <IconButton
                      key={title}
                      isActive={
                        _.find(items, (item) => `${item.value}` === `${cell?.ht}`)
                          ?.title === title
                      }
                      icon={getLucideIcon(title)}
                      variant="ghost"
                      onClick={() => {
                        setContext((ctx) => {
                          handleHorizontalAlign(
                            ctx,
                            refs.cellInput.current!,
                            title.replace('align-', ''),
                          );
                        });
                        setOpen(false);
                      }}
                      tabIndex={0}
                    />
                  ))}
                </Select>
              )}
            </Combo>
          );
        }
        if (name === 'vertical-align') {
          const items = [
            {
              title: 'align-top',
              text: align.top,
              value: 1,
            },
            {
              title: 'align-middle',
              text: align.middle,
              value: 0,
            },
            {
              title: 'align-bottom',
              text: align.bottom,
              value: 2,
            },
          ];
          return (
            <Combo
              iconId={
                _.find(items, (item) => `${item.value}` === `${cell?.vt}`)
                  ?.title || 'align-top'
              }
              key={name}
              tooltip={toolbar.verticalAlign}
              showArrow={false}
            >
              {(setOpen) => (
                <Select
                  style={{
                    minWidth: 'fit-content',
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                  }}
                >
                  {items.map(({ title }) => (
                    <IconButton
                      key={title}
                      isActive={
                        _.find(items, (item) => `${item.value}` === `${cell?.vt}`)
                          ?.title === title
                      }
                      icon={getLucideIcon(title)}
                      variant="ghost"
                      onClick={() => {
                        setContext((ctx) => {
                          handleVerticalAlign(
                            ctx,
                            refs.cellInput.current!,
                            title.replace('align-', ''),
                          );
                        });
                        setOpen(false);
                      }}
                      tabIndex={0}
                    />
                  ))}
                </Select>
              )}
            </Combo>
          );
        }
        if (name === 'undo') {
          return (
            <Button
              iconId={name}
              tooltip={tooltip}
              key={name}
              disabled={refs.globalCache.undoList.length === 0}
              onClick={() => handleUndo()}
            />
          );
        }
        if (name === 'redo') {
          return (
            <Button
              iconId={name}
              tooltip={tooltip}
              key={name}
              disabled={refs.globalCache.redoList.length === 0}
              onClick={() => handleRedo()}
            />
          );
        }
        if (name === 'screenshot') {
          return (
            <Button
              iconId={name}
              tooltip={tooltip}
              key={name}
              onClick={() => {
                const imgsrc = handleScreenShot(contextRef.current);
                if (imgsrc) {
                  showDialog(
                    <div>
                      <div>{screenshot.screenshotTipSuccess}</div>
                      <img
                        src={imgsrc}
                        alt=""
                        style={{ maxWidth: '100%', maxHeight: '100%' }}
                      />
                    </div>,
                  );
                }
              }}
            />
          );
        }
        if (name === 'splitColumn') {
          return (
            <Button
              id="splitColumn"
              iconId={name}
              tooltip={tooltip}
              key={name}
              onClick={() => {
                if (context.allowEdit === false) return;
                if (_.isUndefined(context.luckysheet_select_save)) {
                  showDialog(splitText.tipNoSelect, 'ok');
                } else {
                  const currentColumn =
                    context.luckysheet_select_save[
                      context.luckysheet_select_save.length - 1
                    ].column;
                  if (context.luckysheet_select_save.length > 1) {
                    showDialog(splitText.tipNoMulti, 'ok');
                  } else if (currentColumn[0] !== currentColumn[1]) {
                    showDialog(splitText.tipNoMultiColumn, 'ok');
                  } else {
                    showDialog(<SplitColumn />);
                  }
                }
              }}
            />
          );
        }
        if (name === 'dataVerification') {
          return (
            <Button
              id="dataVerification"
              iconId={name}
              tooltip={tooltip}
              key={name}
              onClick={dataVerificationClick}
            />
          );
        }
        if (name === 'locationCondition') {
          const items = [
            {
              text: findAndReplace.location,
              value: 'location',
            },
            {
              text: findAndReplace.locationFormula,
              value: 'locationFormula',
            },
            {
              text: findAndReplace.locationDate,
              value: 'locationDate',
            },
            {
              text: findAndReplace.locationDigital,
              value: 'locationDigital',
            },
            {
              text: findAndReplace.locationString,
              value: 'locationString',
            },
            {
              text: findAndReplace.locationError,
              value: 'locationError',
            },
            // TODO 条件格式
            // {
            //   text: findAndReplace.locationCondition,
            //   value: "locationCondition",
            // },
            {
              text: findAndReplace.locationRowSpan,
              value: 'locationRowSpan',
            },
            {
              text: findAndReplace.columnSpan,
              value: 'locationColumnSpan',
            },
          ];
          return (
            <Combo
              iconId="locationCondition"
              key={name}
              tooltip={findAndReplace.location}
              showArrow={false}
            >
              {(setOpen) => (
                <Select>
                  {items.map(({ text, value }) => (
                    <Option
                      key={value}
                      onClick={() => {
                        if (context.luckysheet_select_save == null) {
                          showDialog(freezen.noSelectionError, 'ok');
                          return;
                        }
                        const last = context.luckysheet_select_save[0];
                        let range: { row: any[]; column: any[] }[];
                        let rangeArr = [];
                        if (
                          context.luckysheet_select_save?.length === 0 ||
                          (context.luckysheet_select_save?.length === 1 &&
                            last.row[0] === last.row[1] &&
                            last.column[0] === last.column[1])
                        ) {
                          // 当选中的是一个单元格，则变为全选
                          range = [
                            {
                              row: [0, flowdata!.length - 1],
                              column: [0, flowdata![0].length - 1],
                            },
                          ];
                        } else {
                          range = _.assignIn([], context.luckysheet_select_save);
                        }
                        if (value === 'location') {
                          showDialog(<LocationCondition />);
                        } else if (value === 'locationFormula') {
                          setContext((ctx) => {
                            rangeArr = applyLocation(
                              range,
                              'locationFormula',
                              'all',
                              ctx,
                            );
                          });
                        } else if (value === 'locationDate') {
                          setContext((ctx) => {
                            rangeArr = applyLocation(
                              range,
                              'locationConstant',
                              'd',
                              ctx,
                            );
                          });
                        } else if (value === 'locationDigital') {
                          setContext((ctx) => {
                            rangeArr = applyLocation(
                              range,
                              'locationConstant',
                              'n',
                              ctx,
                            );
                          });
                        } else if (value === 'locationString') {
                          setContext((ctx) => {
                            rangeArr = applyLocation(
                              range,
                              'locationConstant',
                              's,g',
                              ctx,
                            );
                          });
                        } else if (value === 'locationError') {
                          setContext((ctx) => {
                            rangeArr = applyLocation(
                              range,
                              'locationConstant',
                              'e',
                              ctx,
                            );
                          });
                        } else if (value === 'locationCondition') {
                          setContext((ctx) => {
                            rangeArr = applyLocation(
                              range,
                              'locationCF',
                              undefined,
                              ctx,
                            );
                          });
                        } else if (value === 'locationRowSpan') {
                          if (
                            context.luckysheet_select_save?.length === 0 ||
                            (context.luckysheet_select_save?.length === 1 &&
                              context.luckysheet_select_save[0].row[0] ===
                              context.luckysheet_select_save[0].row[1])
                          ) {
                            showDialog(
                              findAndReplace.locationTiplessTwoRow,
                              'ok',
                            );
                            return;
                          }
                          range = _.assignIn([], context.luckysheet_select_save);
                          setContext((ctx) => {
                            rangeArr = applyLocation(
                              range,
                              'locationRowSpan',
                              undefined,
                              ctx,
                            );
                          });
                        } else if (value === 'locationColumnSpan') {
                          if (
                            context.luckysheet_select_save?.length === 0 ||
                            (context.luckysheet_select_save?.length === 1 &&
                              context.luckysheet_select_save[0].column[0] ===
                              context.luckysheet_select_save[0].column[1])
                          ) {
                            showDialog(
                              findAndReplace.locationTiplessTwoColumn,
                              'ok',
                            );
                            return;
                          }
                          range = _.assignIn([], context.luckysheet_select_save);
                          setContext((ctx) => {
                            rangeArr = applyLocation(
                              range,
                              'locationColumnSpan',
                              undefined,
                              ctx,
                            );
                          });
                        }
                        if (rangeArr.length === 0 && value !== 'location')
                          showDialog(findAndReplace.locationTipNotFindCell, 'ok');
                        setOpen(false);
                      }}
                    >
                      <div className="fortune-toolbar-menu-line">{text}</div>
                    </Option>
                  ))}
                </Select>
              )}
            </Combo>
          );
        }
        if (name === 'conditionFormat') {
          return (
            <Tooltip text="Conditional Format" position="bottom">
              <Button
                id="conditionFormat"
                iconId={name}
                tooltip={tooltip}
                key={name}
                onClick={conditionalFormatClick}
              />
            </Tooltip>
          );
        }
        if (name === 'image') {
          return (
            <Button
              iconId={name}
              tooltip={toolbar.insertImage}
              key={name}
              onClick={() => {
                if (context.allowEdit === false) return;
                showImgChooser();
              }}
            />
          );
        }
        if (name === 'comment') {
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
          let itemData: { key: any; text: any; onClick: any }[];
          if (flowdata?.[row_index]?.[col_index]?.ps != null) {
            itemData = [
              { key: 'edit', text: comment.edit, onClick: editComment },
              { key: 'delete', text: comment.delete, onClick: deleteComment },
              {
                key: 'showOrHide',
                text: comment.showOne,
                onClick: showHideComment,
              },
              {
                key: 'showOrHideAll',
                text: comment.showAll,
                onClick: showHideAllComments,
              },
            ];
          } else {
            itemData = [
              { key: 'new', text: comment.insert, onClick: newComment },
              {
                key: 'showOrHideAll',
                text: comment.showAll,
                onClick: showHideAllComments,
              },
            ];
          }
          return (
            <Combo iconId={name} key={name} tooltip={tooltip} showArrow={false}>
              {(setOpen) => (
                <Select>
                  {itemData.map(({ key, text, onClick }) => (
                    <Option
                      key={key}
                      onClick={() => {
                        setContext((draftContext) =>
                          onClick(
                            draftContext,
                            refs.globalCache,
                            row_index,
                            col_index,
                          ),
                        );
                        setOpen(false);
                      }}
                    >
                      {text}
                    </Option>
                  ))}
                </Select>
              )}
            </Combo>
          );
        }

        if (name === 'quick-formula') {
          const itemData = [
            { text: formula.sum, value: 'SUM' },
            { text: formula.average, value: 'AVERAGE' },
            { text: formula.count, value: 'COUNT' },
            { text: formula.max, value: 'MAX' },
            { text: formula.min, value: 'MIN' },
          ];
          return <FunctionList />;
        }
        if (name === 'merge-cell') {
          const itemdata = [
            { text: merge.mergeAll, value: 'merge-all', icon: 'MergeAll' },
            {
              text: merge.mergeV,
              value: 'merge-vertical',
              icon: 'MergeVertical',
            },
            {
              text: merge.mergeH,
              value: 'merge-horizontal',
              icon: 'MergeHorizontal',
            },
            {
              text: merge.mergeCancel,
              value: 'merge-cancel',
              icon: 'Unmerge',
            },
          ];
          return (
            <Combo
              iconId="merge-all"
              key={name}
              tooltip={tooltip}
              text="合并单元格"
              onClick={() => {
                if (!mergeSelectionHasValues(context)) {
                  setContext((ctx) => {
                    handleMerge(ctx, 'merge-all');
                  });
                  return;
                }
                const confirmMessage = sheetconfig.confirmMerge;
                showAlert(confirmMessage, 'yesno', () => {
                  setContext((ctx) => {
                    handleMerge(ctx, 'merge-all');
                  });
                  hideAlert();
                });
              }}
            >
              {(setOpen) => (
                <Select>
                  {itemdata.map(({ text, value, icon }) => (
                    <Option
                      key={value}
                      onClick={() => {
                        if (value === 'merge-cancel') {
                          // No confirmation for unmerge
                          setContext((ctx) => {
                            handleMerge(ctx, value);
                          });
                          setOpen(false);
                        } else {
                          setOpen(false);
                          if (!mergeSelectionHasValues(context)) {
                            setContext((ctx) => {
                              handleMerge(ctx, value);
                            });
                            return;
                          }
                          const confirmMessage = sheetconfig.confirmMerge;
                          showAlert(confirmMessage, 'yesno', () => {
                            setContext((ctx) => {
                              handleMerge(ctx, value);
                            });
                            hideAlert();
                          });
                        }
                      }}
                    >
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <LucideIcon name={icon} width={16} height={16} />
                        {text}
                      </div>
                    </Option>
                  ))}
                </Select>
              )}
            </Combo>
          );
        }
        if (name === 'border') {
          const items = [
            {
              text: border.borderTop,
              value: 'border-top',
              icon: 'BorderTop',
            },
            {
              text: border.borderBottom,
              value: 'border-bottom',
              icon: 'BorderBottom',
            },
            {
              text: border.borderLeft,
              value: 'border-left',
              icon: 'BorderLeft',
            },
            {
              text: border.borderRight,
              value: 'border-right',
              icon: 'BorderRight',
            },

            {
              text: border.borderNone,
              value: 'border-none',
              icon: 'NoBorder',
            },
            {
              text: border.borderAll,
              value: 'border-all',
              icon: 'Border',
            },
            {
              text: border.borderOutside,
              value: 'border-outside',
              icon: 'BorderOutside',
            },

            {
              text: border.borderInside,
              value: 'border-inside',
              icon: 'BorderInside',
            },
            {
              text: border.borderHorizontal,
              value: 'border-horizontal',
              icon: 'BorderHorizontal',
            },
            {
              text: border.borderVertical,
              value: 'border-vertical',
              icon: 'BorderVertical',
            },
            // {
            //   text: border.borderSlash,
            //   value: "border-slash",
            // },
          ];
          return (
            <Combo
              iconId="border-all"
              key={name}
              tooltip={tooltip}
              text="边框设置"
              showArrow={false}
              onClick={() =>
                setContext((ctx) => {
                  handleBorder(ctx, 'border-all', customColor, customStyle);
                })
              }
            >
              {(setOpen) => (
                <div className="fortune-toolbar-select fortune-border-grid">
                  {items.map(({ value, icon }) => (
                    <div
                      key={value}
                      className="fortune-border-grid-item"
                      onClick={() => {
                        setContext((ctx) => {
                          handleBorder(ctx, value, customColor, customStyle);
                        });
                        setOpen(false);
                      }}
                    >
                      <LucideIcon name={icon} width={16} height={16} />
                    </div>
                  ))}
                </div>
              )}
            </Combo>
          );
        }

        if (name === 'freeze') {
          const items = [
            {
              text: freezen.freezenRowRange,
              value: 'freeze-row',
            },
            {
              text: freezen.freezenColumnRange,
              value: 'freeze-col',
            },
            {
              text: freezen.freezenRCRange,
              value: 'freeze-row-col',
            },
            {
              text: freezen.freezenCancel,
              value: 'freeze-cancel',
            },
          ];
          return (
            <Combo
              iconId="freeze-row-col"
              key={name}
              tooltip={tooltip}
              showArrow={false}
              onClick={() =>
                setContext((ctx) => {
                  handleFreeze(ctx, 'freeze-row-col');
                })
              }
            >
              {(setOpen) => (
                <Select>
                  {items.map(({ text, value }) => (
                    <Option
                      key={value}
                      onClick={() => {
                        setContext((ctx) => {
                          handleFreeze(ctx, value);
                        });
                        setOpen(false);
                      }}
                    >
                      <div className="fortune-toolbar-menu-line">
                        {text}
                        <SVGIcon name={value} width={16} height={16} />
                      </div>
                    </Option>
                  ))}
                </Select>
              )}
            </Combo>
          );
        }
        if (name === 'text-wrap') {
          const items = [
            {
              text: textWrap.clip,
              iconId: 'text-clip',
              value: 'clip',
            },
            {
              text: textWrap.overflow,
              iconId: 'text-overflow',
              value: 'overflow',
            },
            {
              text: textWrap.wrap,
              iconId: 'text-wrap',
              value: 'wrap',
            },
          ];
          let curr = items[0];
          if (cell?.tb != null) {
            curr = _.get(items, cell.tb);
          }
          return (
            <Combo
              iconId={curr.iconId}
              key={name}
              tooltip={toolbar.textWrap}
              showArrow={false}
            >
              {(setOpen) => (
                <Select
                  style={{
                    minWidth: 'fit-content',
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                  }}
                >
                  {items.map(({ iconId, value }) => (
                    <IconButton
                      key={value}
                      isActive={curr.value === value}
                      icon={getLucideIcon(iconId)}
                      variant="ghost"
                      onClick={() => {
                        setContext((ctx) => {
                          const d = getFlowdata(ctx);
                          if (d == null) return;
                          updateFormat(
                            ctx,
                            refs.cellInput.current!,
                            d,
                            'tb',
                            value,
                            refs.canvas.current!.getContext('2d')!,
                          );
                        });
                        setOpen(false);
                      }}
                      tabIndex={0}
                    />
                  ))}
                </Select>
              )}
            </Combo>
          );
        }
        if (name === 'text-rotation') {
          const items = [
            { text: rotation.none, iconId: 'text-rotation-none', value: 'none' },
            {
              text: rotation.angleup,
              iconId: 'text-rotation-angleup',
              value: 'angleup',
            },
            {
              text: rotation.angledown,
              iconId: 'text-rotation-angledown',
              value: 'angledown',
            },
            {
              text: rotation.vertical,
              iconId: 'text-rotation-vertical',
              value: 'vertical',
            },
            {
              text: rotation.rotationUp,
              iconId: 'text-rotation-up',
              value: 'rotation-up',
            },
            {
              text: rotation.rotationDown,
              iconId: 'text-rotation-down',
              value: 'rotation-down',
            },
          ];
          let curr = items[0];
          if (cell?.tr != null) {
            curr = _.get(items, cell.tr);
          }
          return (
            <Combo
              iconId={curr.iconId}
              key={name}
              tooltip={toolbar.textRotate}
              showArrow={false}
            >
              {(setOpen) => (
                <Select>
                  {items.map(({ text, iconId, value }) => (
                    <Option
                      key={value}
                      onClick={() => {
                        setContext((ctx) => {
                          const d = getFlowdata(ctx);
                          if (d == null) return;
                          updateFormat(
                            ctx,
                            refs.cellInput.current!,
                            d,
                            'tr',
                            value,
                          );
                        });
                        setOpen(false);
                      }}
                    >
                      <div className="fortune-toolbar-menu-line">
                        {text}
                        <SVGIcon name={iconId} width={16} height={16} />
                      </div>
                    </Option>
                  ))}
                </Select>
              )}
            </Combo>
          );
        }
        if (name === 'sort') {
          return (
            <Combo
              iconId="sort"
              key={name}
              tooltip={toolbar.sort}
              showArrow={false}
            >
              {(setOpen) => (
                <SortPopoverContent
                  context={context}
                  setContext={setContext}
                  sortLocale={sort}
                  setOpen={setOpen}
                />
              )}
            </Combo>
          );
        }
        if (name === 'filter') {
          const hasFilterConfigured =
            !_.isEmpty(context.luckysheet_filter_save) ||
            context.filterOptions != null;
          const isReadOnlyViewer =
            context.allowEdit === false || context.isFlvReadOnly;
          const isFilterActive = isReadOnlyViewer
            ? hasFilterConfigured && context.viewerFilterVisible !== false
            : hasFilterConfigured;
          const tooltip = toolbar.sortAndFilter;
          const disabled = isReadOnlyViewer ? !hasFilterConfigured : false;
          return (
            <Tooltip text={tooltip} position="bottom">
              <div
                className="fortune-toolbar-item fortune-toolbar-button fortune-toolbar-button__cta fortune-toolbar-button--filter"
                data-icon-id="filter"
                data-testid="toolbar-cta-filter"
                tabIndex={0}
                role="button"
                style={disabled ? { pointerEvents: 'none', opacity: 0.45 } : {}}
                onClick={() => {
                  if (disabled) return;
                  setContext((draftCtx) => {
                    if (isReadOnlyViewer) {
                      toggleViewerFilter(draftCtx);
                      return;
                    }
                    if (isFilterActive) {
                      clearFilter(draftCtx);
                      return;
                    }
                    createFilter(draftCtx);
                  });
                }}
              >
                <span
                  className="fortune-toolbar-button__icon fortune-toolbar-button__icon--filter color-text-default"
                  data-icon-id="filter"
                  data-testid="toolbar-icon-filter"
                  style={{
                    width: 20,
                    height: 20,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <SVGIcon
                    name={isFilterActive ? 'filter-fill' : 'filter'}
                    width={20}
                    height={20}
                    style={{
                      ...(disabled ? { opacity: 0.3 } : {}),
                      width: '100%',
                      height: '100%',
                    }}
                  />
                </span>
              </div>
            </Tooltip>
          );
        }
        if (name === 'currency') {
          // Determine current format from cell
          return (
            <CurrencySelector
              cell={cell}
              defaultTextFormat={defaultFormat[0].text}
              toolTipText={toolbar['currency-format']}
            />
          );
        }
        const hyperlinkInsertBlocked =
          name === 'link' &&
          isHyperlinkCreationBlocked(
            context,
            refs.cellInput.current ?? undefined,
          );
        return (
          <Tooltip text={tooltip} position="bottom">
            <Button
              iconId={name}
              tooltip={tooltip}
              key={name}
              disabled={Boolean(hyperlinkInsertBlocked)}
              selected={toolbarItemSelectedFunc(name)?.(cell)}
              onMouseDown={(e) => {
                if (name === 'link') {
                  if (hyperlinkInsertBlocked) {
                    e.preventDefault();
                    return;
                  }
                  // Keep in-cell caret/selection when opening link from toolbar;
                  // otherwise browser focuses toolbar button on mousedown.
                  e.preventDefault();
                  captureLinkEditorOpenSnapshot(
                    context,
                    refs.cellInput.current ?? undefined,
                    refs.globalCache,
                  );
                }
              }}
              onClick={() => {
                if (name === 'link' && hyperlinkInsertBlocked) {
                  refs.globalCache?.onHyperlinkInsertBlocked?.();
                  return;
                }
                setContext((draftCtx) => {
                  toolbarItemClickHandler(name)?.(
                    draftCtx,
                    refs.cellInput.current!,
                    refs.globalCache,
                  );
                });
              }}
            />
          </Tooltip>
        );
      },
      [
        toolbar,
        cell,
        setContext,
        refs.cellInput,
        refs.fxInput,
        refs.globalCache,
        defaultFormat,
        align,
        handleUndo,
        handleRedo,
        flowdata,
        formula,
        merge,
        border,
        freezen,
        screenshot,
        sort,
        textWrap,
        rotation,
        filter,
        splitText,
        findAndReplace,
        context,
        context.luckysheet_select_save,
        context.defaultFontSize,
        context.allowEdit,
        comment,
        fontarray,
        hideSubMenu,
        showSubMenu,
        refs.canvas,
        customColor,
        customStyle,
        toolbarFormat.moreCurrency,
        context.dataVerification?.dataRegulation,
        conditionalFormatClick,
      ],
    );

    return (
      <div
        ref={containerRef}
        className="fortune-toolbar"
        aria-label={toolbar.toolbar}
        onMouseUpCapture={restoreEditorFocusAfterToolbarAction}
      >
        <input
          id="fortune-img-upload"
          className="test-fortune-img-upload"
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (!file) return;

            const render = new FileReader();
            render.readAsDataURL(file);
            render.onload = (event) => {
              if (event.target == null) return;
              const src = event.target?.result;
              const image = new Image();
              image.onload = () => {
                setContext((draftCtx) => {
                  insertImage(draftCtx, image);
                });
              };
              image.src = src as string;
            };
            e.currentTarget.value = '';
          }}
        />
        <div className="fortune-toolbar-left">
          {settings.customToolbarItems
            .filter((n) => n.key === 'import-export' || n.key === 'export-only')
            .map((n) => {
              return (
                <CustomButton
                  tooltip={n.tooltip}
                  onClick={n.onClick}
                  key={n.key}
                  icon={n.icon}
                  iconName={n.iconName}
                >
                  {n.children}
                </CustomButton>
              );
            })}
          {settings.customToolbarItems?.length > 0 ? (
            <Divider key="customDivider" />
          ) : null}
          {(toolbarWrapIndex === -1
            ? settings.toolbarItems
            : settings.toolbarItems.slice(0, toolbarWrapIndex + 1)
          ).map((name, i) => getToolbarItem(name, i))}
          {toolbarWrapIndex !== -1 &&
            toolbarWrapIndex < settings.toolbarItems.length - 1 ? (
            <Button
              iconId="Ellipsis"
              tooltip={toolbar.toolMore}
              onClick={() => {
                if (moreItemsOpen) {
                  setMoreItems(null);
                } else {
                  setMoreItems(
                    settings.toolbarItems
                      .slice(toolbarWrapIndex + 1)
                      .map((name, i) => getToolbarItem(name, i)),
                  );
                }
              }}
            />
          ) : null}
          {moreToolbarItems && (
            <MoreItemsContaier onClose={onMoreToolbarItemsClose}>
              {moreToolbarItems}
            </MoreItemsContaier>
          )}
        </div>
        <div ref={rightToolbarRef} className="fortune-toolbar-right">
          {settings.customToolbarItems.length > 0 && (
            <>
              {settings.customToolbarItems
                .filter((t) => t.key === 'Smart Contract')
                .map((n) => (
                  <CustomButton
                    tooltip={n.tooltip}
                    onClick={n.onClick}
                    key={n.key}
                    icon={n.icon}
                    iconName={n.iconName}
                  >
                    {n.children}
                  </CustomButton>
                ))}
              {/* Keep the permission status adjacent to the package tools. */}
              {trailingContent}
              {/* <Button
                iconId="dune"
                tooltip="Insert Dune Chart"
                key="dune-charts"
                onClick={() => {
                  if (context.allowEdit === false) return;
                  setShowDuneModal(true);
                }}
                style={{
                  backgroundColor: '#F4603E2E',
                  borderRadius: '8px',
                }}
              /> */}
              {/* <span style={{ display: 'inline-block', position: 'relative' }}>
                <CryptoDenominationSelector>
                  <Button
                    iconId="crypto"
                    tooltip="Crypto denominations"
                    key="crypto-denominations"
                    style={{
                      backgroundColor: 'hsl(var(--color-bg-secondary))',
                      borderRadius: '8px',
                    }}
                  />
                </CryptoDenominationSelector>
              </span> */}
            </>
          )}
          {settings.customToolbarItems.length === 0 && trailingContent}
          {settings.customToolbarItems
            .filter(
              (n) =>
                n.key !== 'import-export' &&
                n.key !== 'export-only' &&
                n.key !== 'Smart Contract',
            )
            .map((n) => {
              return (
                <CustomButton
                  tooltip={n.tooltip}
                  onClick={n.onClick}
                  key={n.key}
                  icon={n.icon}
                  iconName={n.iconName}
                >
                  {n.children}
                </CustomButton>
              );
            })}
          {/* {showDuneModal && (
            <DuneChartsInputModal
              isOpen={showDuneModal}
              onSubmit={(url) => {
                setContext((draftCtx) => {
                  insertDuneChart(draftCtx, url);
                });
                setShowDuneModal(false);
                settings.onDuneChartEmbed?.();
              }}
              onClose={() => setShowDuneModal(false)}
              placeholder="Paste here any Dune chart link for some magic"
              submitText="Add Dune chart"
            />
          )} */}
        </div>
      </div>
    );
  };

export default Toolbar;
