/**
 * True while a cell is being edited and either input holds a formula. The
 * inputs' `innerText` is read only when `editing` is true (a read forces
 * layout), and the formula bar is read only when the cell input did not
 * already say yes.
 */
export function isEditingAsFormula(
  editing: boolean,
  readCellInputText: () => string | undefined,
  readFxInputText: () => string | undefined,
): boolean {
  if (!editing) return false;
  const startsWithEquals = (text: string | undefined) =>
    (text ?? '').trim().startsWith('=');
  return (
    startsWithEquals(readCellInputText()) || startsWithEquals(readFxInputText())
  );
}
