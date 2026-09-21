import { afterEach, describe, expect, it } from 'vitest';
import { setDateBaseLocale } from './date-base-locale';
import { genarate } from './format';
import { detectDateFormat } from './validation';

describe('detectDateFormat UK locale (GSheets parity)', () => {
  afterEach(() => {
    setDateBaseLocale('uk');
  });

  it('parses day-first slash dates', () => {
    const d = detectDateFormat('25/02/2026');
    expect(d).toMatchObject({ year: 2026, month: 2, day: 25 });
  });

  it('rejects unambiguous US slash dates as text', () => {
    expect(detectDateFormat('02/25/2026')).toBeNull();
    expect(detectDateFormat('2/25/2026')).toBeNull();
  });

  it('interprets ambiguous slash dates as day/month', () => {
    const d = detectDateFormat('03/04/2026');
    expect(d).toMatchObject({ year: 2026, month: 4, day: 3 });
  });

  it('rejects unambiguous US space-separated dates', () => {
    expect(detectDateFormat('2 25 2026')).toBeNull();
  });

  it('parses UK space-separated dates', () => {
    const d = detectDateFormat('25 2 2026');
    expect(d).toMatchObject({ year: 2026, month: 2, day: 25 });
  });

  it('parses ISO and named UK-friendly strings', () => {
    expect(detectDateFormat('2026-02-25')).toMatchObject({
      year: 2026,
      month: 2,
      day: 25,
    });
    expect(detectDateFormat('25 February 2026')).toMatchObject({
      year: 2026,
      month: 2,
      day: 25,
    });
    expect(detectDateFormat('February 25, 2026')).toMatchObject({
      year: 2026,
      month: 2,
      day: 25,
    });
  });

  it('uses Excel/GSheets two-digit year window (00-29 → 2000s, 30-99 → 1900s)', () => {
    expect(detectDateFormat('12/12/13')).toMatchObject({
      year: 2013,
      month: 12,
      day: 12,
    });
    expect(detectDateFormat('12/12/31')).toMatchObject({
      year: 1931,
      month: 12,
      day: 12,
    });
    expect(detectDateFormat('12/12/29')).toMatchObject({
      year: 2029,
      month: 12,
      day: 12,
    });
    expect(detectDateFormat('12/12/30')).toMatchObject({
      year: 1930,
      month: 12,
      day: 12,
    });
  });
});

describe('detectDateFormat US locale', () => {
  afterEach(() => {
    setDateBaseLocale('uk');
  });

  it('parses month-first slash dates', () => {
    setDateBaseLocale('us');
    const d = detectDateFormat('02/25/2026');
    expect(d).toMatchObject({ year: 2026, month: 2, day: 25 });
    expect(detectDateFormat('25/02/2026')).toBeNull();
  });
});

describe('genarate auto-input date display (GSheets UK parity)', () => {
  afterEach(() => {
    setDateBaseLocale('uk');
  });

  it('preserves typed yy display on auto-input (does not expand to yyyy)', () => {
    const result = genarate('12/12/98');
    expect(result).not.toBeNull();
    const [m, ct] = result!;
    expect(ct.t).toBe('d');
    expect(ct.fa).toBe('dd/MM/yy');
    expect(String(m)).toBe('12/12/98');
  });

  it('keeps unambiguous US numeric input as non-date text', () => {
    const result = genarate('02/25/2026');
    expect(result).not.toBeNull();
    const [, ct] = result!;
    expect(ct.t).not.toBe('d');
  });
});
