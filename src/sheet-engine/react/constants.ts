// @ts-ignore
import { SERVICES_API_KEY } from '@fileverse-dev/formulajs/crypto-constants';

export const API_KEY_PLACEHOLDER: Record<string, string> = Object.fromEntries(
  Object.values(SERVICES_API_KEY).map((key: any) => [
    key,
    `${key.replace(/_/g, ' ').replace(/\bAPI\b/, 'API key')}`,
  ]),
);

// Unified currency and crypto options for dropdowns
export const CRYPTO_OPTIONS = [
  { label: 'Bitcoin (BTC)', value: 'BTC', icon: 'Btc', type: 'crypto' },
  { label: 'Ethereum (ETH)', value: 'ETH', icon: 'Ethereum', type: 'crypto' },
  // { label: 'Solana (SOL)', value: 'SOL', icon: 'Solana', type: 'crypto' },
  // Add more cryptos as needed
];

// Map fiat currency codes to Lucide/SVG icons if available
export const FIAT_ICON_MAP = {
  USD: 'DollarSign',
  EUR: 'Euro',
  GBP: 'PoundSterling',
  JPY: 'Yen',
  CNY: 'Yuan',
  INR: 'Rupee',
  // Add more as needed
};

// Helper to merge and group options from locale currencyDetail
export function getGroupedCurrencyOptions(
  currencyDetail: Array<{ name: string; value: string; geckoId?: string }>,
) {
  const fiatOptions = currencyDetail.map(
    (c: { name: string; value: string; geckoId?: string }) => {
      return {
        label: c.name,
        value: c.value,
        geckoId: c.geckoId,
        icon: FIAT_ICON_MAP[c.value as keyof typeof FIAT_ICON_MAP] || undefined,
        type: 'fiat',
      };
    },
  );
  return [
    { group: 'Crypto', options: CRYPTO_OPTIONS },
    { group: 'Currency', options: fiatOptions },
  ];
}
