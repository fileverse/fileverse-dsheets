import {
  clearFilterForColumn,
  locale,
  getFilterColumnValues,
  getFilterColumnColors,
  orderbydatafiler,
  saveFilter,
  FilterValue,
  FilterDate,
  FilterColor,
  Context,
} from '@sheet-engine/core';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import _ from 'lodash';
import produce from 'immer';
import {
  Button,
  Checkbox,
  Divider,
  LucideIcon,
  TextField,
} from '@fileverse/ui';
import { useWorkbookContextIgnoringScroll } from '../../context/use-workbook-store';
import Menu from './Menu';
import SVGIcon from '../SVGIcon';
import { useAlert } from '../../hooks/useAlert';
import { useOutsideClick } from '../../hooks/useOutsideClick';

const SelectItem: React.FC<{
  item: FilterValue;
  isChecked: (key: string) => boolean;
  onChange: (item: FilterValue, checked: boolean) => void;
  isItemVisible: (item: FilterValue) => boolean;
}> = ({ item, isChecked, onChange, isItemVisible }) => {
  const checked = useMemo(() => isChecked(item.key), [isChecked, item.key]);
  return isItemVisible(item) ? (
    <div className="select-item">
      <div className="flex items-center gap-2">
        <Checkbox
          className="border-2"
          checked={checked}
          onCheckedChange={(e) => {
            onChange(item, e.target.checked);
          }}
        />
        <span>{item.text}</span>
      </div>
      <span className="count">{`${item.rows.length}`}</span>
    </div>
  ) : null;
};

const DateSelectTreeItem: React.FC<{
  item: FilterDate;
  depth?: number;
  initialExpand: (key: string) => boolean;
  onExpand?: (key: string, expand: boolean) => void;
  isChecked: (key: string) => boolean;
  onChange: (data: FilterDate, checked: boolean) => void;
  isItemVisible: (item: FilterDate) => boolean;
}> = ({
  item,
  depth = 0,
  initialExpand,
  onExpand,
  isChecked,
  onChange,
  isItemVisible,
}) => {
  const [expand, setExpand] = useState(initialExpand(item.key));
  const checked = useMemo(() => isChecked(item.key), [isChecked, item.key]);

  return isItemVisible(item) ? (
    <div className="flex flex-col gap-2">
      <div
        className="select-item"
        style={{ marginLeft: -2 + depth * 20 }}
        tabIndex={0}
      >
        <div
          className="flex items-center gap-2"
          style={{ flex: 1 }}
          onClick={(e) => e.stopPropagation()}
        >
          {_.isEmpty(item.children) ? (
            <div style={{ width: 10 }} />
          ) : (
            <LucideIcon
              name={expand ? 'ChevronDown' : 'ChevronRight'}
              className="cursor-pointer"
              size="sm"
              onClick={() => {
                onExpand?.(item.key, !expand);
                setExpand(!expand);
              }}
            />
          )}
          <Checkbox
            className="border-2"
            checked={checked}
            onCheckedChange={(e) => {
              onChange(item, e.target.checked);
            }}
          />
          <span>{item.text}</span>
        </div>
        <span className="count">{`${item.rows.length}`}</span>
      </div>
      {expand &&
        item.children.map((v) => (
          <DateSelectTreeItem
            key={v.key}
            item={v}
            depth={depth + 1}
            {...{ initialExpand, onExpand, isChecked, onChange, isItemVisible }}
          />
        ))}
    </div>
  ) : null;
};

const DateSelectTree: React.FC<{
  dates: FilterDate[];
  initialExpand: (key: string) => boolean;
  onExpand?: (key: string, expand: boolean) => void;
  isChecked: (key: string) => boolean;
  onChange: (item: FilterDate, checked: boolean) => void;
  isItemVisible: (item: FilterDate) => boolean;
}> = ({
  dates,
  initialExpand,
  onExpand,
  isChecked,
  onChange,
  isItemVisible,
}) => {
  return (
    <>
      {dates.map((v) => (
        <DateSelectTreeItem
          key={v.key}
          item={v}
          {...{ initialExpand, onExpand, isChecked, onChange, isItemVisible }}
        />
      ))}
    </>
  );
};

const FilterMenu: React.FC = () => {
  const { context, setContext, settings, refs } =
    useWorkbookContextIgnoringScroll();
  const containerRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<Context>(context);
  const byColorMenuRef = useRef<HTMLDivElement>(null);
  const subMenuRef = useRef<HTMLDivElement>(null);
  const { filterContextMenu } = context;
  const { startRow, startCol, endRow, endCol, col } = filterContextMenu || {
    startRow: null,
    startCol: null,
    endRow: null,
    endCol: null,
    col: null,
    listBoxMaxHeight: 400,
  };
  const { filter } = locale(context);
  const [data, setData] = useState<{
    dates: FilterDate[];
    dateRowMap: Record<string, number[]>;
    values: FilterValue[];
    valueRowMap: Record<string, number[]>;
    visibleRows: number[];
    flattenValues: string[];
  }>({
    dates: [],
    dateRowMap: {},
    values: [],
    valueRowMap: {},
    visibleRows: [],
    flattenValues: [],
  });
  const [datesUncheck, setDatesUncheck] = useState<string[]>([]);
  const [valuesUncheck, setValuesUncheck] = useState<string[]>([]);
  const dateTreeExpandState = useRef<Record<string, boolean>>({});
  const hiddenRows = useRef<number[]>([]);
  const [showValues, setShowValues] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const normalizeValueText = useCallback((v: unknown) => {
    return String(v ?? '').toLocaleLowerCase();
  }, []);
  const showValuesTextSet = useMemo(() => {
    return new Set(showValues.map((v) => normalizeValueText(v)));
  }, [normalizeValueText, showValues]);
  const groupedValues = useMemo(() => {
    const groups = new Map<
      string,
      {
        normalizedText: string;
        text: string;
        keys: string[];
        rows: number[];
        value: string;
        mask: string;
      }
    >();

    for (const v of data.values) {
      const normalizedText = normalizeValueText(v.text);
      const existing = groups.get(normalizedText);
      if (!existing) {
        groups.set(normalizedText, {
          normalizedText,
          text: v.text,
          keys: [v.key],
          rows: [...v.rows],
          value: v.value,
          mask: v.mask,
        });
      } else {
        existing.keys.push(v.key);
        existing.rows.push(...v.rows);
      }
    }

    return Array.from(groups.values()).map((g) => ({
      ...g,
      rows: _.uniq(g.rows),
    }));
  }, [data.values, normalizeValueText]);
  const [subMenuPos, setSubMenuPos] = useState<{
    left?: number;
    top: number;
    right?: number;
  }>();
  const [filterColors, setFilterColors] = useState<{
    bgColors: FilterColor[];
    fcColors: FilterColor[];
  }>({ bgColors: [], fcColors: [] });
  const [showSubMenu, setShowSubMenu] = useState(false);
  const { showAlert } = useAlert();
  const mouseHoverSubMenu = useRef<boolean>(false);
  contextRef.current = context;

  // 点击其他区域的时候关闭FilterMenu
  const close = useCallback(() => {
    setContext((ctx) => {
      ctx.filterContextMenu = undefined;
    });
  }, [setContext]);

  useOutsideClick(containerRef, close, [close]);

  const initialExpand = useCallback((key: string) => {
    const expand = dateTreeExpandState.current[key];
    if (expand == null) {
      dateTreeExpandState.current[key] = true;
      return true;
    }
    return expand;
  }, []);

  const onExpand = useCallback((key: string, expand: boolean) => {
    dateTreeExpandState.current[key] = expand;
  }, []);

  const searchValues = useMemo(
    () =>
      _.debounce((text: string) => {
        setShowValues(
          _.filter(
            data.flattenValues,
            (v) => v.toLowerCase().indexOf(text.toLowerCase()) > -1,
          ),
        );
      }, 300),
    [data.flattenValues],
  );

  // const selectAll = useCallback(() => {
  //   setDatesUncheck([]);
  //   setValuesUncheck([]);
  //   hiddenRows.current = [];
  // }, []);

  // const clearAll = useCallback(() => {
  //   setDatesUncheck(_.keys(data.dateRowMap));
  //   setValuesUncheck(_.keys(data.valueRowMap));
  //   hiddenRows.current = data.visibleRows;
  // }, [data.dateRowMap, data.valueRowMap, data.visibleRows]);

  // const inverseSelect = useCallback(() => {
  //   setDatesUncheck(produce((draft) => _.xor(draft, _.keys(data.dateRowMap))));
  //   setValuesUncheck(
  //     produce((draft) => _.xor(draft, _.keys(data.valueRowMap)))
  //   );
  //   hiddenRows.current = _.xor(hiddenRows.current, data.visibleRows);
  // }, [data.dateRowMap, data.valueRowMap, data.visibleRows]);

  const onColorSelectChange = useCallback(
    (key: string, color: string, checked: boolean) => {
      setFilterColors(
        produce((draft) => {
          const colorData = _.find(_.get(draft, key), (v) => v.color === color);
          colorData.checked = checked;
        }),
      );
    },
    [],
  );

  const delayHideSubMenu = useMemo(
    () =>
      _.debounce(() => {
        if (mouseHoverSubMenu.current) return;
        setShowSubMenu(false);
      }, 200),
    [],
  );

  const sortData = useCallback(
    (asc: boolean) => {
      if (col == null) return;
      setContext((draftCtx) => {
        const errMsg = orderbydatafiler(
          draftCtx,
          startRow,
          startCol,
          endRow,
          endCol,
          col,
          asc,
        );
        if (errMsg != null) showAlert(errMsg);
      });
    },
    [col, setContext, startRow, startCol, endRow, endCol, showAlert],
  );

  const renderColorList = useCallback(
    (
      key: string,
      title: string,
      colors: FilterColor[],
      onSelectChange: (
        datakey: string,
        color: string,
        checked: boolean,
      ) => void,
    ) =>
      colors.length > 1 ? (
        <div key={key}>
          <div className="title">{title}</div>
          <div className="color-list">
            {colors.map((v) => (
              <div
                key={v.color}
                className="item"
                onClick={() => onSelectChange(key, v.color, !v.checked)}
                tabIndex={0}
              >
                <div
                  className="color-label"
                  style={{ backgroundColor: v.color }}
                />
                <input
                  className="luckysheet-mousedown-cancel"
                  type="checkbox"
                  checked={v.checked}
                  onChange={() => {}}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null,
    [],
  );

  useLayoutEffect(() => {
    // re-position the filterContextMenu if it overflows the window
    if (!containerRef.current || !filterContextMenu) {
      return;
    }
    const winH = window.innerHeight;
    const winW = window.innerWidth;
    const rect = containerRef.current.getBoundingClientRect();
    const workbookRect =
      refs.workbookContainer.current?.getBoundingClientRect();
    if (!workbookRect) {
      return;
    }
    const menuW = rect.width;
    // menu最小高度
    const menuH = 350;
    let top = filterContextMenu.y;
    let left = filterContextMenu.x;

    let hasOverflow = false;
    if (workbookRect.left + left + menuW > winW) {
      left -= menuW;
      hasOverflow = true;
    }
    if (workbookRect.top + top + menuH > winH) {
      top -= menuH;
      hasOverflow = true;
    }
    if (top < 0) {
      top = 0;
      hasOverflow = true;
    }
    // 适配小屏
    let containerH = winH - rect.top - 350;
    if (containerH < 0) {
      containerH = 100;
    }
    // 防止Maximum update depth exceeded错误，如果当前值和前一个filterContextMenu值一样则不进行赋值
    if (
      filterContextMenu.x === left &&
      filterContextMenu.y === top &&
      filterContextMenu.listBoxMaxHeight === containerH
    ) {
      return;
    }
    setContext((draftCtx) => {
      if (hasOverflow) {
        _.set(draftCtx, 'filterContextMenu.x', left);
        _.set(draftCtx, 'filterContextMenu.y', top);
      }
      _.set(draftCtx, 'filterContextMenu.listBoxMaxHeight', containerH);
    });
  }, [filterContextMenu, refs.workbookContainer, setContext]);

  useLayoutEffect(() => {
    if (!subMenuPos) return;
    // re-position the subMenu if it overflows the window
    const rect = byColorMenuRef.current?.getBoundingClientRect();
    const subMenuRect = subMenuRef.current?.getBoundingClientRect();
    if (rect == null || subMenuRect == null) return;

    const winW = window.innerWidth;
    const pos = _.cloneDeep(subMenuPos);
    if (subMenuRect.left + subMenuRect.width > winW) {
      pos.left! -= subMenuRect.width;
      setSubMenuPos(pos);
    }
  }, [subMenuPos]);

  useEffect(() => {
    if (col == null) return;
    setSearchText('');
    setShowSubMenu(false);
    dateTreeExpandState.current = {};
    hiddenRows.current = filterContextMenu?.hiddenRows || [];
    const res = getFilterColumnValues(
      contextRef.current,
      col,
      startRow,
      endRow,
      startCol,
    );
    setData(_.omit(res, ['datesUncheck', 'valuesUncheck']));
    setDatesUncheck(res.datesUncheck);
    setValuesUncheck(res.valuesUncheck);
    setShowValues(res.flattenValues);
  }, [
    col,
    endRow,
    startRow,
    startCol,
    hiddenRows,
    filterContextMenu?.hiddenRows,
  ]);

  useEffect(() => {
    if (col == null) return;
    setFilterColors(
      getFilterColumnColors(contextRef.current, col, startRow, endRow),
    );
  }, [col, endRow, startRow]);

  if (filterContextMenu == null) return null;

  return (
    <>
      <div
        className="fortune-context-menu luckysheet-cols-menu fortune-filter-menu"
        id="luckysheet-\${menuid}-menu"
        ref={containerRef}
        style={{
          left: filterContextMenu.x,
          top: filterContextMenu.y,
          minWidth: '280px !important',
        }}
      >
        {settings.filterContextMenu?.map((name, i) => {
          if (name === '|') {
            return <Divider key={`divider-${i}`} />;
          }
          if (name === 'sort-by-asc') {
            return (
              <Menu key={name} onClick={() => sortData(true)}>
                <div className="context-item w-full">
                  <SVGIcon
                    name="sort-asc"
                    width={24}
                    height={18}
                    style={{ marginRight: '4px' }}
                  />
                  <p>{filter.sortByAsc}</p>
                </div>
              </Menu>
            );
          }
          if (name === 'sort-by-desc') {
            return (
              <Menu key={name} onClick={() => sortData(false)}>
                <div className="context-item w-full">
                  <SVGIcon
                    name="sort-desc"
                    width={24}
                    height={18}
                    style={{ marginRight: '4px' }}
                  />
                  <p>{filter.sortByDesc}</p>
                </div>
              </Menu>
            );
          }
          if (name === 'filter-by-color') {
            return (
              <div
                key={name}
                ref={byColorMenuRef}
                onMouseEnter={() => {
                  if (!containerRef.current || !filterContextMenu) {
                    return;
                  }
                  setShowSubMenu(true);
                  const rect = byColorMenuRef.current?.getBoundingClientRect();
                  if (rect == null) return;
                  setSubMenuPos({ top: rect.top - 5, left: rect.right });
                }}
                onMouseLeave={delayHideSubMenu}
              >
                <Menu onClick={() => {}}>
                  <div className="filter-bycolor-container">
                    {filter.filterByColor}
                    <div className="filter-caret right" />
                  </div>
                </Menu>
              </div>
            );
          }
          // if (name === "filter-by-condition") {
          //   return (
          //     <div key="name">
          //       <Menu onClick={() => {}}>
          //         <div className="filter-caret right" />
          //         {filter.filterByCondition}
          //       </Menu>
          //       <div
          //         className="luckysheet-\${menuid}-bycondition"
          //         style={{ display: "none" }}
          //       >
          //         <div
          //           className="luckysheet-flat-menu-button luckysheet-mousedown-cancel"
          //           id="luckysheet-\${menuid}-selected"
          //         >
          //           <span
          //             className="luckysheet-mousedown-cancel"
          //             data-value="null"
          //             data-type="0"
          //           >
          //             {filter.filiterInputNone}
          //           </span>
          //           <div className="luckysheet-mousedown-cancel">
          //             <i className="fa fa-sort" aria-hidden="true" />
          //           </div>
          //         </div>
          //         {/* <div className="luckysheet-\${menuid}-selected-input">
          //          <input
          //            type="text"
          //            placeholder="${filter.filiterInputTip}"
          //            className="luckysheet-mousedown-cancel"
          //          />
          //        </div>
          //       <div className="luckysheet-\${menuid}-selected-input luckysheet-\${menuid}-selected-input2">
          //         <span>{filter.filiterRangeStart}</span>
          //         <input
          //           type="text"
          //           placeholder="${filter.filiterRangeStartTip}"
          //           className="luckysheet-mousedown-cancel"
          //         />
          //         <span>{filter.filiterRangeEnd}</span>
          //         <input
          //           type="text"
          //           placeholder="${filter.filiterRangeEndTip}"
          //           className="luckysheet-mousedown-cancel"
          //         />
          //       </div> */}
          //       </div>
          //     </div>
          //   );
          // }
          if (name === 'filter-by-value') {
            return (
              <div key={name}>
                <div className="luckysheet-filter-byvalue flex flex-col gap-2 mt-2">
                  <div className="filtermenu-input-container">
                    <TextField
                      leftIcon={<LucideIcon name="Search" size="sm" />}
                      onKeyDown={(e) => e.stopPropagation()}
                      placeholder={filter.filterValueByTip}
                      id="luckysheet-\${menuid}-byvalue-input"
                      value={searchText}
                      className="!pl-10"
                      onChange={(e) => {
                        setSearchText(e.target.value);
                        searchValues(e.target.value);
                      }}
                    />
                  </div>
                  <div id="luckysheet-filter-byvalue-select">
                    <DateSelectTree
                      dates={data.dates}
                      onExpand={onExpand}
                      initialExpand={initialExpand}
                      isChecked={(key: string) =>
                        _.find(
                          datesUncheck,
                          (v: string) => v.match(key) != null,
                        ) == null
                      }
                      onChange={(item: FilterDate, checked: boolean) => {
                        const rows = hiddenRows.current;
                        hiddenRows.current = checked
                          ? _.without(rows, ...item.rows)
                          : _.union(rows, item.rows);
                        setDatesUncheck(
                          produce((draft) => {
                            return checked
                              ? _.without(draft, ...item.dateValues)
                              : _.union(draft, item.dateValues);
                          }),
                        );
                      }}
                      isItemVisible={(item) => {
                        return showValues.length === data.flattenValues.length
                          ? true
                          : _.findIndex(
                              showValues,
                              (v) => v.match(item.key) != null,
                            ) > -1;
                      }}
                    />
                    <SelectItem
                      item={{
                        key: 'all',
                        text: filter.filterValueByAllBtn,
                        value: '',
                        mask: '',
                        rows: data.values
                          .filter((v) =>
                            showValuesTextSet.has(normalizeValueText(v.text)),
                          )
                          .flatMap((v) => v.rows),
                      }}
                      isChecked={() => {
                        // Check if all items are checked by verifying no items are in the uncheck arrays
                        const allDatesChecked = datesUncheck.length === 0;
                        const allValuesChecked = valuesUncheck.length === 0;
                        return allDatesChecked && allValuesChecked;
                      }}
                      onChange={(item, checked) => {
                        if (checked) {
                          // If checking "all", clear all unchecked items
                          setDatesUncheck([]);
                          setValuesUncheck([]);
                          hiddenRows.current = [];
                        } else {
                          // If unchecking "all", uncheck all items
                          setDatesUncheck(_.keys(data.dateRowMap));
                          setValuesUncheck(_.keys(data.valueRowMap));
                          hiddenRows.current = data.visibleRows;
                        }
                      }}
                      isItemVisible={() => true}
                    />
                    {groupedValues.map((g) => (
                      <SelectItem
                        key={g.normalizedText}
                        item={{
                          key: g.normalizedText,
                          text: g.text,
                          value: g.value,
                          mask: g.mask,
                          rows: g.rows,
                        }}
                        isChecked={() =>
                          _.every(g.keys, (k) => !_.includes(valuesUncheck, k))
                        }
                        onChange={(_item, checked) => {
                          const rows = hiddenRows.current;

                          if (checked) {
                            hiddenRows.current = _.without(rows, ...g.rows);
                            setValuesUncheck(
                              produce((draft) => {
                                _.pull(draft, ...g.keys);
                              }),
                            );
                          } else {
                            hiddenRows.current = _.uniq(_.concat(rows, g.rows));
                            setValuesUncheck(
                              produce((draft) => {
                                draft.push(...g.keys);
                              }),
                            );
                          }
                        }}
                        isItemVisible={() => {
                          return showValues.length === data.flattenValues.length
                            ? true
                            : showValuesTextSet.has(g.normalizedText);
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            );
          }
          return null;
        })}
        <div className="fortune-menuitem-row mt-2">
          <Button
            variant="ghost"
            style={{ minWidth: '80px' }}
            onClick={() => {
              if (col == null) return;
              setContext((draftCtx) => {
                clearFilterForColumn(draftCtx, col, startCol);
                draftCtx.filterContextMenu = undefined;
              });
            }}
            tabIndex={0}
          >
            {filter.clearFilter}
          </Button>
          <Button
            variant="secondary"
            style={{ minWidth: '80px' }}
            onClick={() => {
              setContext((draftCtx) => {
                draftCtx.filterContextMenu = undefined;
              });
            }}
            tabIndex={0}
          >
            {filter.filterCancel}
          </Button>
          <Button
            variant="default"
            style={{ minWidth: '80px' }}
            onClick={() => {
              if (col == null) return;
              setContext((draftCtx) => {
                const rowHidden = _.reduce(
                  hiddenRows.current,
                  (pre, curr) => {
                    pre[curr] = 0;
                    return pre;
                  },
                  {} as Record<string, number>,
                );
                saveFilter(
                  draftCtx,
                  hiddenRows.current.length > 0,
                  rowHidden,
                  {},
                  startRow,
                  endRow,
                  col,
                  startCol,
                  endCol,
                );
                hiddenRows.current = [];
                draftCtx.filterContextMenu = undefined;
              });
            }}
            tabIndex={0}
          >
            {filter.filterConfirm}
          </Button>
        </div>
      </div>
      {showSubMenu && (
        <div
          ref={subMenuRef}
          className="luckysheet-filter-bycolor-submenu"
          style={subMenuPos}
          onMouseEnter={() => {
            mouseHoverSubMenu.current = true;
          }}
          onMouseLeave={() => {
            mouseHoverSubMenu.current = false;
            setShowSubMenu(false);
          }}
        >
          {filterColors.bgColors.length < 2 &&
          filterColors.fcColors.length < 2 ? (
            <div className="one-color-tip">
              {filter.filterContainerOneColorTip}
            </div>
          ) : (
            <>
              {[
                {
                  key: 'bgColors',
                  title: filter.filiterByColorTip,
                  colors: filterColors.bgColors,
                },
                {
                  key: 'fcColors',
                  title: filter.filiterByTextColorTip,
                  colors: filterColors.fcColors,
                },
              ].map((v) =>
                renderColorList(v.key, v.title, v.colors, onColorSelectChange),
              )}
              <div
                className="button-basic button-primary"
                onClick={() => {
                  if (col == null) return;
                  setContext((draftCtx) => {
                    const rowHidden = _.reduce(
                      _(filterColors)
                        .values()
                        .flatten()
                        .map((v) => (v.checked ? [] : v.rows))
                        .flatten()
                        .valueOf(),
                      (pre, curr) => {
                        pre[curr] = 0;
                        return pre;
                      },
                      {} as Record<string, number>,
                    );
                    saveFilter(
                      draftCtx,
                      !_.isEmpty(rowHidden),
                      rowHidden,
                      {},
                      startRow,
                      endRow,
                      col,
                      startCol,
                      endCol,
                    );
                    hiddenRows.current = [];
                    draftCtx.filterContextMenu = undefined;
                  });
                }}
                tabIndex={0}
              >
                {filter.filterConfirm}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
};

export default React.memo(FilterMenu);
