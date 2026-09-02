import { describe, expect, it } from 'vitest';
import {
  CSS_SAFE_CLIPBOARD_ATTRS,
  isClipboardMetadataRedundant,
} from './cell-persist-utils';
import type { Cell } from '../types';

describe('isClipboardMetadataRedundant', () => {
  it('keeps blob for cells with content', () => {
    expect(isClipboardMetadataRedundant({ v: 'x', m: 'x' } as Cell)).toBe(false);
    expect(isClipboardMetadataRedundant({ f: '=A1' } as Cell)).toBe(false);
    expect(isClipboardMetadataRedundant('plain')).toBe(false);
    expect(isClipboardMetadataRedundant(42)).toBe(false);
  });

  it('drops blob for format-only empty cells reconstructible from CSS', () => {
    expect(isClipboardMetadataRedundant({ bg: '#f00' } as Cell)).toBe(true);
    expect(isClipboardMetadataRedundant({ bl: 1, fc: '#111' } as Cell)).toBe(
      true,
    );
    expect(
      isClipboardMetadataRedundant({ bg: '#eee', ht: 0, fs: 12 } as Cell),
    ).toBe(true);
  });

  it('keeps blob for non-CSS format channels (ct number format, tr rotation)', () => {
    expect(
      isClipboardMetadataRedundant({ ct: { fa: '0.00', t: 'n' } } as Cell),
    ).toBe(false);
    expect(isClipboardMetadataRedundant({ tr: 45 } as unknown as Cell)).toBe(
      false,
    );
    // mixed: one non-CSS attr present → keep
    expect(
      isClipboardMetadataRedundant({
        bg: '#f00',
        ct: { fa: '0.00', t: 'n' },
      } as Cell),
    ).toBe(false);
  });

  it('drops blob for truly empty cells', () => {
    expect(isClipboardMetadataRedundant(null)).toBe(true);
    expect(isClipboardMetadataRedundant(undefined)).toBe(true);
    expect(isClipboardMetadataRedundant({} as Cell)).toBe(true);
  });

  it('safe-attr set excludes ct and tr', () => {
    const set = new Set<string>(CSS_SAFE_CLIPBOARD_ATTRS);
    expect(set.has('ct')).toBe(false);
    expect(set.has('tr')).toBe(false);
    expect(set.has('bg')).toBe(true);
  });
});
