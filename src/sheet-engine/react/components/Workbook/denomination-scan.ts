import type { Cell } from '../../../core/types';

const DENOMINATIONS = ['BTC', 'ETH', 'SOL'];

/**
 * True when any displayed value (`m`) contains BTC, ETH or SOL. Walks the grid
 * in place and returns at the first hit; no intermediate cell list is built.
 */
export function hasDenominatedCell(data: (Cell | null)[][]): boolean {
  if (!data) return false;
  for (let r = 0; r < data.length; r += 1) {
    const row = data[r];
    if (row) {
      for (let c = 0; c < row.length; c += 1) {
        const m = row[c]?.m;
        if (m != null) {
          const text = m.toString();
          for (let i = 0; i < DENOMINATIONS.length; i += 1) {
            if (text.includes(DENOMINATIONS[i])) return true;
          }
        }
      }
    }
  }
  return false;
}

type BannerDoc = Pick<Document, 'getElementById' | 'getElementsByClassName'>;

/**
 * Show or hide the crypto-denomination banner and move the scrollbar and
 * add-row bar to match. A no-op when the host has not mounted the banner
 * element; call again later (for example on selection change) to retry.
 * Returns true when the banner element was found.
 */
export function applyDenominationBanner(
  denominated: boolean,
  doc: BannerDoc = document,
): boolean {
  const denoWarn = doc.getElementById('denomination-warning');
  if (!denoWarn) return false;
  const scrollBar = doc.getElementsByClassName(
    'luckysheet-scrollbar-x',
  )[0] as HTMLElement | undefined;
  const addRowBar = doc.getElementById('luckysheet-bottom-controll-row');
  if (denominated) {
    denoWarn.style.display = 'block';
    denoWarn.style.left = '0px';
    scrollBar?.setAttribute(
      'style',
      'bottom: 36px !important; width: calc(100% - 60px);',
    );
    // Lift add-row bar so its white band sits directly on top of the disclaimer bar (no grid gap).
    if (addRowBar) addRowBar.style.bottom = '54px';
  } else {
    denoWarn.style.display = 'none';
    denoWarn.style.left = '-9999px';
    scrollBar?.setAttribute(
      'style',
      'bottom: 10px !important; width: calc(100% - 60px);',
    );
    if (addRowBar) addRowBar.style.bottom = '38px';
  }
  return true;
}
