import { getFlowdata, api } from '@sheet-engine/core';
import { getCachedPrice } from './cryptoApi';

export const getFiatSymbol = (code: string): string => {
  switch (code) {
    case 'USD':
      return '$';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'JPY':
      return '¥';
    case 'CNY':
      return '¥';
    case 'INR':
      return '₹';
    default:
      return code;
  }
};

export const getFiatGeckoId = (
  symbol: string,
  baseCurrency?: string,
): string => {
  switch (symbol) {
    case '$':
      return baseCurrency || 'usd';
    case '€':
      return 'eur';
    case '￡':
      return 'gbp';
    case '¥':
    case 'CN¥':
      return 'cny';
    case 'HK$':
    case 'K$':
      return 'hkd';
    case '￥':
    case 'jp¥':
      return 'jpy';
    case 'AU$':
      return 'aud';
    case '৳':
      return 'bdt';
    case 'din':
    case 'NAR':
      return baseCurrency || 'bhd';
    case 'R$':
      return 'brl';
    case 'CA$':
      return 'cad';
    case 'CHF':
    case 'CF':
      return 'chf';
    case 'CLP$':
      return 'clp';
    case 'Kč':
    case 'CZK':
      return 'czk';
    case 'kr':
      return baseCurrency || 'dkk';
    case 'GEL':
    case 'gl':
      return 'gel';
    case 'Ft':
    case 'ft':
      return 'huf';
    case 'Rp':
      return 'idr';
    case '₪':
    case 'N￡':
      return 'ils';
    case '₹':
      return 'inr';
    case 'Rs':
    case 'L₹':
    case 'P₹':
      return baseCurrency || 'inr';
    case '₩':
      return 'krw';
    case 'KW':
      return 'kwd';
    case 'K':
      return 'mmk';
    case 'MXN':
    case 'MX$':
    case 'PO$':
      return 'mxn';
    case 'RM':
      return 'myr';
    case '₦':
      return 'ngn';
    case '₦kr':
      return 'nok';
    case 'NZ$':
    case 'Z$':
      return 'nzd';
    case '₱':
      return 'php';
    case 'zł':
      return 'pln';
    case '₽':
    case 'RU':
      return 'rub';
    case 'Rial':
      return 'sar';
    case 'S$':
    case 'P$':
      return 'sgd';
    case '฿':
      return 'thb';
    case '₺':
    case 'TL':
      return 'try';
    case 'грн.':
      return 'uah';
    case 'R':
      return baseCurrency || 'zar';
    case 'ZAR':
      return 'zar';
    default:
      return baseCurrency || 'usd';
  }
};

const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  // SOL: 'solana',
  // add more as needed
};

// Extend the Cell type to include baseValue
type CryptoCell = {
  v?: string | number | boolean;
  m?: string | number;
  ct?: { fa?: string; t?: string; s?: any };
  baseValue?: number;
  [key: string]: any;
};

export async function convertCellsToCrypto({
  context,
  setContext,
  denomination,
  decimals,
}: {
  context: any;
  setContext: (fn: (ctx: any) => void) => void;
  denomination: string;
  decimals: number;
}) {
  const selections = context.luckysheet_select_save;
  const flowdata = getFlowdata(context);
  if (!selections || !flowdata) return;

  // Expand all selected cells
  const selectedCells: { row: number; col: number }[] = [];
  selections.forEach((selection: any) => {
    for (let row = selection.row[0]; row <= selection.row[1]; row += 1) {
      for (
        let col = selection.column[0];
        col <= selection.column[1];
        col += 1
      ) {
        selectedCells.push({ row, col });
      }
    }
  });

  let denomStr: string =
    typeof denomination === 'string' && denomination.trim() !== ''
      ? denomination
      : 'ETH';
  denomStr = denomStr.toUpperCase();
  const coingeckoId: string =
    typeof COINGECKO_IDS[denomStr] === 'string'
      ? COINGECKO_IDS[denomStr]
      : 'ethereum';

  // Get the crypto price in USD
  // const price = await getCryptoPrice(
  //   String(coingeckoId),
  //   baseCurrency.toLowerCase()
  // );

  // Prepare all cell updates first
  const cellUpdates: Array<{
    row: number;
    col: number;
    baseValue: number;
    cryptoValue: number;
  }> = [];

  selectedCells.forEach(({ row, col }) => {
    const cell = flowdata[row]?.[col] as CryptoCell;
    let baseValue: number = 0;

    // Check if we have a stored USD base value
    if (cell?.baseValue !== undefined) {
      baseValue = cell.baseValue;
    } else {
      // First time conversion - extract USD value from current cell
      if (typeof cell?.v === 'number') {
        baseValue = cell.v;
      } else if (typeof cell?.v === 'string') {
        baseValue = parseFloat(cell.v);
      }

      // If the cell already has a crypto denomination, assume it's USD equivalent
      // This handles cases where cells were previously converted
      if (cell?.ct?.fa && cell.ct.fa.includes('"')) {
        // Extract the numeric value from the formatted string
        const numericValue = parseFloat(cell.v?.toString() || '0');
        if (!Number.isNaN(numericValue)) {
          baseValue = numericValue;
        }
      }
    }

    if (!baseValue || Number.isNaN(baseValue)) return;

    // @ts-expect-error later
    const fiatSymbol = cell?.m?.split(' ')[0];
    const fiatVsCryptoPrice = getCachedPrice(
      coingeckoId,
      getFiatGeckoId(fiatSymbol, cell?.baseCurrency),
    );

    // Convert USD base value to selected cryptocurrency
    const cryptoValue = baseValue / fiatVsCryptoPrice;
    if (typeof cryptoValue !== 'number' || Number.isNaN(cryptoValue)) return;

    cellUpdates.push({
      row,
      col,
      baseValue,
      cryptoValue,
      // @ts-expect-error later
      baseCurrency: getFiatGeckoId(fiatSymbol, cell?.baseCurrency) || 'usd',
      baseCurrencyPrice: fiatVsCryptoPrice,
    });
  });

  // Apply all updates in a single setContext call - this creates ONE undo operation
  setContext((ctx: any) => {
    const d = getFlowdata(ctx);
    if (!d || !Array.isArray(d)) return;

    const ydocChanges: {
      sheetId: string;
      path: string[];
      key?: string;
      value: any;
      type?: 'update' | 'delete';
    }[] = [];

    cellUpdates.forEach(
      ({
        row,
        col,
        baseValue,
        cryptoValue,
        // @ts-expect-error later
        baseCurrency,
        // @ts-expect-error later
        baseCurrencyPrice,
      }) => {
        // Ensure row and cell exist
        if (!d[row]) d[row] = [];
        if (!d[row][col]) d[row][col] = {};

        // TypeScript safe assignment
        const cellCp = d[row][col] as Partial<CryptoCell>;

        cellCp.v = baseValue.toString();
        cellCp.m = `${cryptoValue.toFixed(decimals)} ${denomStr}`;
        cellCp.ct = {
          fa: `0.${'0'.repeat(decimals)} "${denomStr}"`,
          t: 'n',
        };
        cellCp.baseValue = baseValue;
        cellCp.baseCurrency = baseCurrency.toLowerCase();
        cellCp.baseCurrencyPrice = baseCurrencyPrice;

        d[row][col] = cellCp as CryptoCell;

        ydocChanges.push({
          sheetId: ctx.currentSheetId,
          path: ['celldata'],
          value: { r: row, c: col, v: d[row]?.[col] ?? null },
          key: `${row}_${col}`,
          type: 'update',
        });
      },
    );

    if (ydocChanges.length > 0 && ctx?.hooks?.updateCellYdoc) {
      ctx.hooks.updateCellYdoc(ydocChanges);
    }
  });
  setContext((ctx: any) => {
    api.calculateSheetFromula(ctx, ctx.currentSheetId);
  });
}
