/**
 * Opt-in debug logging. Silent unless enabled in the browser console:
 *
 *   localStorage.setItem('dsheet-debug', '1'); location.reload();
 *
 * Disable with `localStorage.removeItem('dsheet-debug')`.
 */
const DEBUG_STORAGE_KEY = 'dsheet-debug';

export const isDsheetDebugEnabled = (): boolean => {
  try {
    return window.localStorage.getItem(DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

export const debugLog = (...args: unknown[]) => {
  if (isDsheetDebugEnabled()) console.log(...args);
};

export const debugWarn = (...args: unknown[]) => {
  if (isDsheetDebugEnabled()) console.warn(...args);
};
