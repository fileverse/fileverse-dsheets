import { describe, expect, it, vi } from 'vitest';
import { isEditingAsFormula } from './editing-as-formula';

describe('isEditingAsFormula', () => {
  it('reads neither input while no cell is being edited', () => {
    const readCell = vi.fn(() => '=A1');
    const readFx = vi.fn(() => '=A1');
    expect(isEditingAsFormula(false, readCell, readFx)).toBe(false);
    expect(readCell).not.toHaveBeenCalled();
    expect(readFx).not.toHaveBeenCalled();
  });

  it('is true when the cell input text starts with =', () => {
    expect(
      isEditingAsFormula(
        true,
        () => '=SUM(A1)',
        () => '',
      ),
    ).toBe(true);
  });

  it('is true when only the formula bar text starts with =', () => {
    expect(
      isEditingAsFormula(
        true,
        () => '',
        () => '=SUM(A1)',
      ),
    ).toBe(true);
  });

  it('is false for plain text in both inputs, and trims before checking', () => {
    expect(
      isEditingAsFormula(
        true,
        () => 'abc',
        () => 'abc',
      ),
    ).toBe(false);
    expect(
      isEditingAsFormula(
        true,
        () => '  =A1 ',
        () => '',
      ),
    ).toBe(true);
  });

  it('does not read the formula bar when the cell input already decides', () => {
    const readFx = vi.fn(() => '');
    isEditingAsFormula(true, () => '=A1', readFx);
    expect(readFx).not.toHaveBeenCalled();
  });
});
