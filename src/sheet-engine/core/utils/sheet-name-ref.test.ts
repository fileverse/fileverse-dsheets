import { describe, expect, it } from 'vitest';
import {
  formatSheetNameForFormula,
  quoteSheetNamesInFormula,
  sheetNameNeedsQuotes,
} from './sheet-name-ref';

describe('formatSheetNameForFormula', () => {
  it('leaves plain identifiers bare', () => {
    expect(formatSheetNameForFormula('Sheet1')).toBe('Sheet1');
    expect(formatSheetNameForFormula('Finance_Q1')).toBe('Finance_Q1');
  });

  it('quotes names the parser cannot read bare', () => {
    expect(formatSheetNameForFormula('Finance - 1')).toBe("'Finance - 1'");
    expect(formatSheetNameForFormula('Sheet-4')).toBe("'Sheet-4'");
    expect(formatSheetNameForFormula('Q1.2024')).toBe("'Q1.2024'");
    expect(formatSheetNameForFormula('2024')).toBe("'2024'");
    expect(formatSheetNameForFormula('A1')).toBe("'A1'");
    expect(formatSheetNameForFormula('R1C1')).toBe("'R1C1'");
    expect(formatSheetNameForFormula('TRUE')).toBe("'TRUE'");
    expect(formatSheetNameForFormula('销售')).toBe("'销售'");
  });

  it('doubles embedded single quotes', () => {
    expect(formatSheetNameForFormula("It's Q1")).toBe("'It''s Q1'");
  });

  it('sheetNameNeedsQuotes agrees', () => {
    expect(sheetNameNeedsQuotes('Sheet1')).toBe(false);
    expect(sheetNameNeedsQuotes('Sheet 1')).toBe(true);
  });
});

describe('quoteSheetNamesInFormula', () => {
  const sheets = ['Sheet1', 'Sheet-4', 'Finance - 1', "It's", 'Sheet-4 copy'];

  it('quotes bare references to sheets that need quotes', () => {
    expect(quoteSheetNamesInFormula('=SUM(Sheet-4!H6,B2:C2)', sheets)).toBe(
      "=SUM('Sheet-4'!H6,B2:C2)",
    );
    expect(quoteSheetNamesInFormula('=Finance - 1!A1+1', sheets)).toBe(
      "='Finance - 1'!A1+1",
    );
    expect(quoteSheetNamesInFormula("=It's!A1:B2", sheets)).toBe(
      "='It''s'!A1:B2",
    );
    expect(quoteSheetNamesInFormula('=sheet-4!H6', sheets)).toBe(
      "='Sheet-4'!H6",
    );
  });

  it('prefers the longest matching sheet name', () => {
    expect(quoteSheetNamesInFormula('=Sheet-4 copy!A1', sheets)).toBe(
      "='Sheet-4 copy'!A1",
    );
  });

  it('leaves already-quoted names, strings and bare-safe names alone', () => {
    for (const f of [
      "=SUM('Sheet-4'!H6,B2:C2)",
      "='It''s'!A1",
      '="Sheet-4!H6"',
      '=Sheet1!A1',
      '=SUM(A1,B2)',
      'Sheet-4!H6',
    ]) {
      expect(quoteSheetNamesInFormula(f, sheets)).toBe(f);
    }
  });

  it('does not match inside another token', () => {
    expect(quoteSheetNamesInFormula('=XSheet-4!H6', sheets)).toBe(
      '=XSheet-4!H6',
    );
  });
});
