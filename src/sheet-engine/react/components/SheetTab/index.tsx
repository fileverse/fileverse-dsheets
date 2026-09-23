import _ from 'lodash';
import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  LucideIcon,
  Button,
  IconButton,
} from '@fileverse/ui';
import { useMediaQuery } from 'usehooks-ts';
import { updateCell, addSheet, calcSelectionInfo } from '@sheet-engine/core';
// @ts-ignore
import WorkbookContext from '../../context';
import './index.css';
import SheetItem from './SheetItem';
import ZoomControl from '../ZoomControl';

const STATS = [
  { label: 'Sum', value: 'sum' },
  { label: 'Avg', value: 'average' },
  { label: 'Min', value: 'min' },
  { label: 'Max', value: 'max' },
  { label: 'Count', value: 'count' },
  { label: 'Count Numbers', value: 'numberC' },
];

const STATS_LABELS = {
  average: 'Avg',
  count: 'Count',
  max: 'Max',
  min: 'Min',
  numberC: 'Count Numbers',
  sum: 'Sum',
};

const SheetTab: React.FC = () => {
  const isMobile = useMediaQuery('(max-width: 780px)', { defaultValue: true });
  const { context, setContext, settings, refs } = useContext(WorkbookContext);
  const tabContainerRef = useRef<HTMLDivElement>(null);
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const [isShowScrollBtn, setIsShowScrollBtn] = useState<boolean>(false);
  const [isShowBoundary, setIsShowBoundary] = useState<boolean>(true);
  const [calInfo, setCalInfo] = useState<{
    numberC: number;
    count: number;
    sum: number;
    max: number;
    min: number;
    average: string;
  }>({
    numberC: 0,
    count: 0,
    sum: 0,
    max: 0,
    min: 0,
    average: '',
  });

  const [selectedStat, setSelectedStat] = useState<string>('sum');

  const scrollDelta = 150;

  const scrollBy = useCallback((amount: number) => {
    if (
      tabContainerRef.current == null ||
      tabContainerRef.current.scrollLeft == null
    ) {
      return;
    }
    const { scrollLeft } = tabContainerRef.current;
    if (scrollLeft + amount <= 0) setIsShowBoundary(true);
    else if (scrollLeft > 0) setIsShowBoundary(false);

    tabContainerRef.current?.scrollBy({
      left: amount,
      behavior: 'smooth',
    });
  }, []);

  useEffect(() => {
    const selection = context.luckysheet_select_save;
    // const { lang } = props;
    if (selection) {
      const re = calcSelectionInfo(context /* "en" */);
      setCalInfo(re);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.luckysheet_select_save]);

  useEffect(() => {
    const tabCurrent = tabContainerRef.current;
    if (!tabCurrent) return;
    setIsShowScrollBtn(tabCurrent!.scrollWidth - 2 > tabCurrent!.clientWidth);
  }, [context.luckysheetfile]);

  const onAddSheetClick = useCallback(
    () =>
      setTimeout(() => {
        setContext(
          (draftCtx) => {
            if (draftCtx.luckysheetCellUpdate.length > 0) {
              updateCell(
                draftCtx,
                draftCtx.luckysheetCellUpdate[0],
                draftCtx.luckysheetCellUpdate[1],
                refs.cellInput.current!,
              );
            }
            addSheet(draftCtx, settings);
          },
          { addSheetOp: true },
        );
        const tabCurrent = tabContainerRef.current;
        setIsShowScrollBtn(tabCurrent!.scrollWidth > tabCurrent!.clientWidth);
      }),
    [refs.cellInput, setContext, settings],
  );

  useEffect(() => {
    const cornerPlus = document.getElementById('corner-plus');
    if (cornerPlus) {
      cornerPlus.style.display = 'none';
    }
  }, [isMobile]);

  useEffect(() => {
    settings.onSheetCountChange?.(context.luckysheetfile.length);
  }, [context.luckysheetfile.length]);

  const statsFilter = STATS.filter((stat) => {
    const statsValue = String(calInfo[stat.value as keyof typeof calInfo]);
    return !statsValue.includes('NaN') && !statsValue.includes('Infinity');
  });

  const finalStats = statsFilter.length !== 6 ? [] : statsFilter;

  return (
    <div>
      <div
        className="fortune-sheettab luckysheet-sheet-area luckysheet-noselected-text border-t color-border-default color-bg-secondary"
        onContextMenu={(e) => e.preventDefault()}
        id="luckysheet-sheet-area"
        data-testid="sheettab"
      >
        <div
          id="luckysheet-sheet-content"
          className="fortune-sheettab__content"
          data-testid="sheettab-content"
        >
          {context.allowEdit && (
            <IconButton
              className="fortune-sheettab__cta fortune-sheettab-button border-none shadow-none"
              onClick={onAddSheetClick}
              elevation={1}
              icon="Plus"
              size="sm"
              variant="secondary"
              data-testid="sheettab-cta-add-sheet"
            />
          )}
          {context.allowEdit && (
            <div className="sheet-list-container">
              <div
                id="all-sheets"
                className="fortune-sheettab__icon fortune-sheettab-button"
                ref={tabContainerRef}
                data-testid="sheettab-icon-all-sheets"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setContext((ctx) => {
                    ctx.showSheetList = _.isUndefined(ctx.showSheetList)
                      ? true
                      : !ctx.showSheetList;
                    ctx.sheetTabContextMenu = {};
                  });
                }}
              >
                <IconButton
                  className="fortune-sheettab__icon fortune-sheettab-button border-none shadow-none"
                  elevation={1}
                  icon="Menu"
                  size="sm"
                  variant="secondary"
                  data-testid="sheettab-icon-menu"
                />
                {/* <SVGIcon name="all-sheets" width={16} height={16} /> */}
              </div>
            </div>
          )}
          {/* <div
            id="luckysheet-sheets-m"
            className="luckysheet-sheets-m lucky-button-custom"
          >
            <i className="iconfont luckysheet-iconfont-caidan2" />
          </div> */}
          <div
            className="fortune-sheettab__tabs fortune-sheettab-container"
            id="fortune-sheettab-container"
            data-testid="sheettab-tabs"
          >
            {!isShowBoundary && <div className="boundary boundary-left" />}
            <div
              className="fortune-sheettab-container-c"
              id="fortune-sheettab-container-c"
              ref={tabContainerRef}
            >
              {_.sortBy(context.luckysheetfile, (s) => Number(s.order)).map(
                (sheet) => {
                  return <SheetItem key={sheet.id} sheet={sheet} />;
                },
              )}
              {/* <SheetItem
              isDropPlaceholder
              sheet={{ name: "", id: "drop-placeholder" }}
            /> */}
            </div>
            {/* {isShowBoundary && isShowScrollBtn && (
              <div className="boundary boundary-right" />
            )} */}
          </div>
          {isShowScrollBtn && (
            <div
              id="fortune-sheettab-leftscroll"
              className="fortune-sheettab-scroll"
              ref={leftScrollRef}
              onClick={() => {
                scrollBy(-scrollDelta);
              }}
              tabIndex={0}
            >
              <IconButton
                name="arrow-doubleleft"
                className="fortune-sheettab-button-arrow border-none shadow-none"
                onClick={() => {
                  scrollBy(-scrollDelta);
                }}
                elevation={1}
                icon="ChevronLeft"
                size="sm"
                variant="secondary"
              />
            </div>
          )}
          {isShowScrollBtn && (
            <div
              id="fortune-sheettab-rightscroll"
              className="fortune-sheettab-scroll"
              ref={rightScrollRef}
              onClick={() => {
                scrollBy(scrollDelta);
              }}
              tabIndex={0}
            >
              <IconButton
                name="arrow-doubleright"
                className="fortune-sheettab-button-arrow border-none shadow-none"
                onClick={() => {
                  scrollBy(scrollDelta);
                }}
                elevation={1}
                icon="ChevronRight"
                size="sm"
                variant="secondary"
              />
            </div>
          )}
        </div>
        <div className="fortune-sheet-area-right">
          {statsFilter.length === 6 && calInfo.count > 1 && (
            <Popover>
              <PopoverTrigger
                className="fortune-sheettab__info-trigger p-0 m-0 mr-2"
                data-testid="sheettab-info-stats-trigger"
              >
                <Button
                  variant="ghost"
                  className="fortune-sheettab__info fortune-sheettab__info--stats w-full !h-6 p-2 m-1 text-left flex items-center justify-center transition mr-2 !rounded-[0px]"
                  style={{ height: '24px !important' }}
                  data-testid="sheettab-info-stats"
                >
                  <div className="flex items-center">
                    <p
                      className="fortune-sheettab__para fortune-sheettab__para--stats text-body-sm"
                      style={{ fontWeight: '500', marginRight: '8px' }}
                      data-testid="sheettab-para-stats"
                    >
                      {STATS_LABELS[selectedStat as keyof typeof STATS_LABELS]}:{' '}
                      {calInfo[selectedStat as keyof typeof calInfo]}
                    </p>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="lucide lucide-chevron-down-icon lucide-chevron-down"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </div>
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                alignOffset={0}
                className="stats-content color-border-default shadow-elevation-3"
                style={{ width: 'fit-content!important' }}
                elevation={2}
                side="bottom"
                sideOffset={4}
              >
                <div
                  className="p-2 color-text-default color-border-default"
                  style={{ paddingRight: '15px' }}
                >
                  {finalStats.map((option) => (
                    <Button
                      variant="ghost"
                      key={option.value}
                      className={`fortune-sheettab__stats-option fortune-sheettab__stats-option--${option.value
                        } w-full h-8 rounded p-2 m-1 text-left flex items-center justify-between transition mr-2 min-w-[50px] ${selectedStat === option.value && 'color-bg-secondary'
                        }`}
                      data-stat-value={option.value}
                      data-testid={`sheettab-stats-option-${option.value}`}
                      onClick={() => setSelectedStat(option.value)}
                    >
                      <div className="flex gap-2 items-center w-full">
                        {selectedStat === option.value && (
                          <div className="w-[20px] h-[20px]">
                            <LucideIcon name="Check" size="sm" />
                          </div>
                        )}
                        <p
                          className="text-body-sm color-text-secondary"
                          style={{
                            marginLeft:
                              selectedStat === option.value ? 0 : '24px',
                            fontSize: '14px',
                          }}
                        >
                          {option.label}:{' '}
                        </p>
                        <div className="flex w-full justify-end">
                          <p
                            className="font-body-sm-bold color-text-default"
                            style={{
                              marginLeft:
                                selectedStat === option.value ? 0 : '24px',
                              fontSize: '14px',
                              fontWeight: 500,
                            }}
                          >
                            {calInfo[option.value as keyof typeof calInfo]}
                          </p>
                        </div>
                      </div>
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
          <ZoomControl />
        </div>
      </div>
    </div>
  );
};

export default SheetTab;
