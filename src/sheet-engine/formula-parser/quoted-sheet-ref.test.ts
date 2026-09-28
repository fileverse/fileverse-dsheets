/* eslint-disable @typescript-eslint/no-explicit-any -- the formula parser is untyped JS */
import { describe, expect, it } from 'vitest';
import { Parser } from './index';

describe('formula parser: quoted sheet references', () => {
  const parser: any = new (Parser as any)();
  const seen: string[] = [];
  parser.on('callCellValue', (c: any, _o: any, done: any) => {
    seen.push(`${c.sheetName}!${c.column.label}${c.row.label}`);
    done(10);
  });
  parser.on('callRangeValue', (s: any, e: any, _o: any, done: any) => {
    seen.push(`${s.sheetName}!${s.label}:${e.label}`);
    done([[1, 2]]);
  });

  it.each([
    ["SUM('Finance - 1'!H6,B2:C2)", 13, ['Finance - 1!H6', 'null!B2:C2']],
    ["SUM('Sheet-4'!H6,B2:C2)", 13, ['Sheet-4!H6', 'null!B2:C2']],
    ["'It''s Q1'!A1*2", 20, ["It's Q1!A1"]],
    ["SUM('Finance - 1'!A1:B2)", 3, ['Finance - 1!A1:B2']],
  ])('%s', (formula, result, refs) => {
    seen.length = 0;
    const res = parser.parse(formula, { sheetId: 's' });
    expect(res.error).toBeNull();
    expect(res.result).toBe(result);
    expect(seen).toEqual(refs);
  });
});
