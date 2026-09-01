import React, { useState, useContext, useCallback, useMemo } from 'react';
import { getFlowdata, normalizedCellAttr } from '@sheet-engine/core';
import {
  IconButton,
  LucideIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@fileverse/ui';
import './index.css';
import SVGIcon from '../SVGIcon';
import WorkbookContext from '../../context';
import { convertCellsToCrypto } from '../../utils/convertCellsToCrypto';
import { updateCellsDecimalFormat } from '../../utils/updateCellsDecimalFormat';

const CRYPTO_OPTIONS = [
  { label: 'Bitcoin (BTC)', value: 'BTC', icon: 'Btc' },
  { label: 'Ethereum (ETH)', value: 'ETH', icon: 'Ethereum' },
  // { label: 'Solana (SOL)', value: 'SOL', icon: 'Solana' },
  // Add more as needed
];

interface CryptoDenominationSelectorProps {
  initialDecimals?: number;
  children: React.ReactNode;
}

const CryptoDenominationSelector: React.FC<CryptoDenominationSelectorProps> = ({
  initialDecimals = 6,
  children,
}) => {
  const { setContext, context } = useContext(WorkbookContext);

  // Detect if a crypto currency is currently active
  const activeCryptoCurrency = useMemo(() => {
    const firstSelection = context.luckysheet_select_save?.[0];
    const flowdata = getFlowdata(context);

    if (!firstSelection || !flowdata) return null;

    const row = firstSelection.row_focus;
    const col = firstSelection.column_focus;

    if (row == null || col == null) return null;

    const cell = flowdata[row]?.[col];
    if (!cell) return null;

    const curr = normalizedCellAttr(cell, 'ct');
    if (!curr?.fa) return null;

    // Check if the current format contains any crypto currency
    const found = CRYPTO_OPTIONS.find((option) =>
      curr.fa.includes(option.value),
    );

    return found ? found.value : null;
  }, [context]);

  const [decimals, setDecimals] = useState(initialDecimals);
  const [open, setOpen] = useState(false);

  const handleDenominationChange = useCallback(
    async (newDenomination: string) => {
      await convertCellsToCrypto({
        context,
        setContext,
        denomination: newDenomination,
        decimals,
      });
    },
    [context, setContext, decimals],
  );

  const handleDecimalsChange = useCallback(
    (newDecimals: number) => {
      setDecimals(newDecimals);
      updateCellsDecimalFormat({
        context,
        setContext,
        decimals: newDecimals,
      });
    },
    [context, setContext],
  );

  const handleTriggerClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Check if editing is allowed
      if (context.allowEdit === false) {
        return;
      }

      setOpen(!open);
    },
    [open, context.allowEdit],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div onClick={handleTriggerClick}>{children}</div>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={4} className="p-2">
        <div className="crypto-denomination-selector">
          <div className="cds-row px-2">
            <span className="color-text-default">Decimal places:</span>
            <span className="flex items-center">
              <IconButton
                icon="Minus"
                variant="ghost"
                size="sm"
                className="!bg-transparent color-text-default"
                disabled={decimals === 1}
                onClick={() => handleDecimalsChange(Math.max(1, decimals - 1))}
              />
              <input
                type="number"
                min={1}
                max={18}
                value={decimals}
                onChange={(e) =>
                  handleDecimalsChange(
                    Math.max(1, Math.min(18, Number(e.target.value))),
                  )
                }
                className="color-text-default color-border-default color-bg-default"
              />
              <IconButton
                icon="Plus"
                variant="ghost"
                size="sm"
                className="!bg-transparent color-text-default"
                disabled={decimals === 18}
                onClick={() => handleDecimalsChange(Math.min(18, decimals + 1))}
              />
            </span>
          </div>
          <div className="cds-list">
            {CRYPTO_OPTIONS.map((opt) => (
              <div
                key={opt.value}
                className={`flex items-center justify-between cds-option${activeCryptoCurrency === opt.value ? ' selected' : ''
                  }`}
                onClick={() => handleDenominationChange(opt.value)}
              >
                <span className="flex items-center gap-2">
                  {activeCryptoCurrency === opt.value ? (
                    <LucideIcon
                      name="Check"
                      className="w-4 h-4 color-text-default"
                    />
                  ) : (
                    <div className="w-4 h-4" />
                  )}
                  {opt.label}
                </span>
                <LucideIcon
                  name={opt.icon}
                  className="cds-icon color-text-default"
                />
                {/* {opt.value === 'SOL' && (
                  <SVGIcon name="solana" width={16} height={16} />
                )} */}
              </div>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default CryptoDenominationSelector;
