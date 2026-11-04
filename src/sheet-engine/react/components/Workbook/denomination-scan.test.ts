import { describe, expect, it } from 'vitest';
import { applyDenominationBanner, hasDenominatedCell } from './denomination-scan';

describe('hasDenominatedCell', () => {
  it.each(['BTC', 'ETH', 'SOL'])('is true when a displayed value has %s', (t) => {
    expect(hasDenominatedCell([[{ v: 1 }, { v: 2, m: `1.5 ${t}` }]])).toBe(true);
  });

  it('is false when no displayed value has a denomination', () => {
    expect(
      hasDenominatedCell([
        [{ v: 'BTC', m: '1' }, null],
        [null, { v: 5, m: '5' }, { v: 'abc' }],
      ]),
    ).toBe(false);
  });

  it('handles null, empty and missing rows', () => {
    expect(hasDenominatedCell([])).toBe(false);
    expect(hasDenominatedCell([null as any, [null]])).toBe(false);
    expect(hasDenominatedCell(undefined as any)).toBe(false);
  });

  it('stops at the first hit', () => {
    const grid: any[][] = [
      [{ v: 1, m: '1' }, { v: 2, m: '2 ETH' }],
      new Proxy([], {
        get() {
          throw new Error('scanned past the first hit');
        },
      }) as any,
    ];
    expect(hasDenominatedCell(grid)).toBe(true);
  });
});

describe('applyDenominationBanner', () => {
  const mkDoc = (withBanner: () => boolean) => {
    const banner: any = { style: {} };
    const addRow: any = { style: {} };
    const bar: any = { setAttribute: (_k: string, v: string) => { bar.attr = v; } };
    const doc: any = {
      getElementById: (id: string) =>
        id === 'denomination-warning'
          ? withBanner() ? banner : null
          : id === 'luckysheet-bottom-controll-row' ? addRow : null,
      getElementsByClassName: () => [bar],
    };
    return { doc, banner, addRow, bar };
  };

  it('shows and hides the banner', () => {
    const { doc, banner, addRow, bar } = mkDoc(() => true);
    expect(applyDenominationBanner(true, doc)).toBe(true);
    expect(banner.style.display).toBe('block');
    expect(addRow.style.bottom).toBe('54px');
    expect(bar.attr).toContain('36px');
    applyDenominationBanner(false, doc);
    expect(banner.style.display).toBe('none');
    expect(addRow.style.bottom).toBe('38px');
  });

  it('is a no-op while the banner is missing, and applies once it mounts', () => {
    let mounted = false;
    const { doc, banner } = mkDoc(() => mounted);
    expect(applyDenominationBanner(true, doc)).toBe(false);
    mounted = true;
    expect(applyDenominationBanner(true, doc)).toBe(true);
    expect(banner.style.display).toBe('block');
  });
});
