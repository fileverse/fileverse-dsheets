import _ from 'lodash';
import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { LucideIcon, Tooltip } from '@fileverse/ui';
import { UNFilter } from './constant';
import WorkbookContext from '../../../context';
import './index.css';

type FormulaSearchProps = React.HTMLAttributes<HTMLDivElement> & {
  from?: 'fx' | 'cell';
  lockedTop?: number | null;
  onTopComputed?: (top: number) => void;
};

const FormulaSearch: React.FC<FormulaSearchProps> = ({
  lockedTop = null,
  onTopComputed,
  from,
  ...divProps
}) => {
  const {
    context,
    settings: { isAuthorized },
  } = useContext(WorkbookContext);
  const authedFunction = [
    'COINGECKO',
    'ETHERSCAN',
    'DEFILLAMA',
    'GNOSIS',
    'BASE',
    'EOA',
    'PNL',
    'SAFE',
    'BLOCKSCOUT',
    'LENS',
    'FARCASTER',
    'Ethereum',
    'SMARTCONTRACT',
    'DUNESIM',
  ];
  const filteredDefaultCandidates = context.defaultCandidates.filter(
    (item) => !authedFunction.includes(item.n),
  );
  const unfilteredDefaultCandidates = UNFilter.filter(
    (item) => item.n !== 'PNL',
  );
  const finalDefaultCandidates = !isAuthorized
    ? filteredDefaultCandidates.slice(0, 10)
    : context.defaultCandidates.slice(0, 10);

  const finalFunctionCandidates = isAuthorized
    ? context.functionCandidates
    : context.functionCandidates.filter((item) => item.t !== 20);
  const topFunctionCandidates = finalFunctionCandidates.slice(0, 10);

  const firstSelection = context.luckysheet_select_save?.[0];
  const hintRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);

  const calcuatePopUpPlacement = useCallback(() => {
    // Keep lock behavior for Fx bar only. In-cell editor can grow (multi-line),
    // so the popup must reflow with live editor height.
    const isFxMode = from === 'fx';
    const effectiveLockedTop = isFxMode ? lockedTop : null;
    if (effectiveLockedTop !== null) {
      if (top !== effectiveLockedTop) {
        setTop(effectiveLockedTop);
      }
      return;
    }

    if (
      !firstSelection?.top?.toString() ||
      !firstSelection.height_move?.toString() ||
      !hintRef.current
    )
      return;
    const hintHeight = 350;
    const inputBoxTop =
      parseInt(
        document.getElementById('luckysheet-input-box')?.style.top || '0',
        10,
      ) - 85;
    const inputBottom = inputBoxTop + firstSelection.height_move;
    const availableBelow = window.innerHeight - inputBottom;
    const hintAbove = hintHeight > availableBelow;
    const inputBoxInnerEl = document.querySelector(
      '#luckysheet-input-box .luckysheet-input-box-inner',
    ) as HTMLDivElement | null;
    const selectionHeight = isFxMode
      ? (firstSelection?.height_move ?? 0)
      : (inputBoxInnerEl?.offsetHeight ?? firstSelection?.height_move ?? 0);
    const divOffset = hintRef.current?.offsetHeight || 0;
    let topV = hintAbove
      ? selectionHeight - (divOffset + 80)
      : selectionHeight + 4;
    const el = document.getElementsByClassName('fx-hint')?.[0];
    // @ts-expect-error legacy DOM type mismatch
    if (el && el?.style?.display !== 'none') {
      topV = 25;
    }
    setTop(topV);
    onTopComputed?.(topV);
  }, [
    firstSelection?.height_move,
    firstSelection?.top,
    from,
    lockedTop,
    onTopComputed,
    top,
  ]);

  useEffect(() => {
    calcuatePopUpPlacement();
    // Re-evaluate only when candidates/selection context changes.
    // The locked top, if provided, prevents re-position jump while editing.
  }, [
    calcuatePopUpPlacement,
    context.functionCandidates?.length,
    context.defaultCandidates?.length,
    context.functionHint,
  ]);

  useEffect(() => {
    if (from === 'fx') return;
    const inputBoxInnerEl = document.querySelector(
      '#luckysheet-input-box .luckysheet-input-box-inner',
    ) as HTMLDivElement | null;
    if (!inputBoxInnerEl || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      calcuatePopUpPlacement();
    });
    observer.observe(inputBoxInnerEl);
    return () => {
      observer.disconnect();
    };
  }, [from, calcuatePopUpPlacement]);

  if (
    _.isEmpty(context.functionCandidates) &&
    _.isEmpty(context.defaultCandidates)
  )
    return null;

  return (
    <div
      className={`flex color-border-default border flex-col luckysheet-formula-search-c-p custom-scroll ${from === 'fx' ? 'fx-search' : 'cell-search'
        }`}
      id="luckysheet-formula-search-c-p"
      style={{
        top,
      }}
    >
      <div
        {...divProps}
        ref={hintRef}
        id="luckysheet-formula-search-c"
        className="luckysheet-formula-search-c"
      >
        {context.defaultCandidates.length > 0 && (
          <>
            <div
              style={{ marginBottom: '4px' }}
              className="w-full flex flex-col p-2 gap-1"
            >
              <h4 className="text-helper-sm-bold color-text-secondary">
                Onchain functions
              </h4>
              <p className="text-helper-text-sm color-text-secondary">
                Every onchain function is a native data structure allowing
                dSheets to read and structure data from smart contracts and
                APIs.
              </p>
            </div>
            {!isAuthorized && (
              <div
                style={{ marginBottom: '8px', backgroundColor: 'hsl(var(--color-bg-secondary))' }}
                className="w-full flex flex-col p-2 gap-1"
              >
                <h4 className="font-semibold">dSheets account required</h4>
                <p className="text-helper-text-sm color-text-secondary">
                  Use more onchain functions by creating a dSheets account.{' '}
                  <span
                    className="sign-fortune"
                    style={{ color: 'hsl(var(--color-text-link))', cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      document.getElementById('triggerAuth')?.click();
                    }}
                  >
                    Signup/Login
                  </span>
                </p>
              </div>
            )}
          </>
        )}

        {context.defaultCandidates.length > 0 ? (
          <>
            {finalDefaultCandidates.map((v, index) => {
              return (
                <div
                  key={v.n}
                  data-func={v.n}
                  style={{
                    cursor: 'pointer',
                  }}
                  className={`luckysheet-formula-search-item ${index === 0 ? 'luckysheet-formula-search-item-active' : ''
                    }`}
                >
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between' }}
                  >
                    <div className="luckysheet-formula-search-func color-text-default text-body-sm">
                      {v.n}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'end',
                        minWidth: '68px',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                    >
                      {v.LOGO && (
                        <img
                          src={v.LOGO}
                          alt="Service Logo"
                          style={{ width: '16px' }}
                        />
                      )}
                      {v.SECONDARY_LOGO && (
                        <img
                          src={v.SECONDARY_LOGO}
                          alt="Service Logo"
                          style={{ width: '16px' }}
                        />
                      )}
                      {v.API_KEY && (
                        <Tooltip
                          text={
                            localStorage.getItem(v.API_KEY)
                              ? 'API Key added'
                              : 'API key optional'
                          }
                        >
                          <div
                            style={{
                              borderRadius: '4px',
                              backgroundColor: localStorage.getItem(
                                v.API_KEY,
                              )
                                ? 'hsl(var(--color-bg-success))'
                                : 'hsl(var(--color-border-default))',
                              width: '16px',
                              height: '16px',
                            }}
                            className="flex justify-center"
                          >
                            <LucideIcon
                              name="Key"
                              style={{
                                color: localStorage.getItem(v.API_KEY)
                                  ? 'hsl(var(--color-text-inverse))'
                                  : 'hsl(var(--color-text-secondary))',
                                width: '12px',
                                height: '12px',
                              }}
                            />
                          </div>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                  <div className="luckysheet-formula-search-detail mt-1 text-helper-text-sm  color-text-default">
                    {v.d}
                  </div>
                </div>
              );
            })}
          </>
        ) : (
          <>
            {topFunctionCandidates.length > 0 &&
              topFunctionCandidates.map((v, index) => {
                return (
                  <div
                    key={v.n}
                    data-func={v.n}
                    className={`luckysheet-formula-search-item ${index === 0 ? 'luckysheet-formula-search-item-active' : ''
                      }`}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div className="luckysheet-formula-search-func color-text-default text-body-sm">
                        {v.n}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'end',
                          width: '68px',
                          alignItems: 'center',
                          gap: '6px',
                        }}
                      >
                        {v.LOGO && (
                          <img
                            src={v.LOGO}
                            alt="Service Logo"
                            style={{ width: '16px' }}
                          />
                        )}
                        {v.SECONDARY_LOGO && (
                          <img
                            src={v.SECONDARY_LOGO}
                            alt="Service Logo"
                            style={{ width: '16px' }}
                          />
                        )}
                        {v.API_KEY && (
                          <Tooltip
                            text={
                              localStorage.getItem(v.API_KEY)
                                ? 'API Key added'
                                : 'API key optional'
                            }
                          >
                            <div
                              style={{
                                borderRadius: '4px',
                                backgroundColor: localStorage.getItem(
                                  v.API_KEY,
                                )
                                  ? 'hsl(var(--color-bg-success))'
                                  : 'hsl(var(--color-border-default))',
                                width: '16px',
                                height: '16px',
                              }}
                              className="flex justify-center"
                            >
                              <LucideIcon
                                name="Key"
                                style={{
                                  color: localStorage.getItem(v.API_KEY)
                                    ? 'hsl(var(--color-text-inverse))'
                                    : 'hsl(var(--color-text-secondary))',
                                  width: '12px',
                                  height: '12px',
                                }}
                              />
                            </div>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                    <div className="luckysheet-formula-search-detail mt-1 text-helper-text-sm color-text-secondary">
                      {v.d}
                    </div>
                  </div>
                );
              })}
            {topFunctionCandidates.length === 0 && (
              <span>
                {!isAuthorized && (
                  <div
                    style={{ marginBottom: '8px', backgroundColor: 'hsl(var(--color-bg-secondary))' }}
                    className="w-full flex flex-col p-2 gap-1"
                  >
                    <h4
                      className="text-helper-sm-bold"
                      style={{ fontWeight: 'bold' }}
                    >
                      dSheets account required
                    </h4>
                    <p className="text-helper-text-sm color-text-secondary">
                      Use more onchain functions by creating a dSheets account.{' '}
                      <span
                        className="sign-fortune"
                        style={{ color: 'hsl(var(--color-text-link))', cursor: 'pointer' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          document.getElementById('triggerAuth')?.click();
                        }}
                      >
                        Signup/Login
                      </span>
                    </p>
                  </div>
                )}
              </span>
            )}
          </>
        )}
      </div>
      <div className="p-2 pt-0">
        <hr className="color-border-default mb-2" />
        <div
          style={{ paddingLeft: '10px', paddingRight: '10px' }}
          className="flex gap-1 items-center color-border-default text-helper-sm"
        >
          <div className="border p-1 color-text-default rounded">Tab</div>
          <p className="color-text-secondary">to insert.</p>
          {'   '}
          <div className="border p-1 color-text-default rounded text-sm ">
            ↑
          </div>
          <div className="border p-1 color-text-default rounded text-sm ">
            ↓
          </div>
          <p className="color-text-secondary">to navigate</p>
        </div>
      </div>
    </div>
  );
};

export default FormulaSearch;
