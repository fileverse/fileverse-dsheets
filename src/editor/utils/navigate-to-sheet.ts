const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

export type NavigableContext = {
  currentSheetId?: string;
  luckysheetfile?: Array<{ id?: string; hide?: number } | null | undefined>;
};

export type NavigableEditor = {
  getWorkbookContext?: () => NavigableContext | null | undefined;
  getWorkbookSetContext?: () =>
    | ((recipe: (draft: unknown) => void) => void)
    | null
    | undefined;
};

export type NavigateToSheetOptions = {
  /** How long to wait for the workbook and sheet to load. Default 10s. */
  timeoutMs?: number;
};

/**
 * Wait until the workbook has loaded a sheet with `sheetId`, then switch to it.
 * Resolves `false` (never throws) when the sheet is missing after the timeout,
 * hidden, or the switch fails. `getEditor` must return the latest instance on
 * every call because Fortune regenerates its handle on each context change.
 */
export function navigateToSheet<TDraft>(
  getEditor: () => NavigableEditor | null | undefined,
  sheetId: string,
  activate: (draft: TDraft, sheetId: string) => void,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: NavigateToSheetOptions = {},
): Promise<boolean> {
  if (!sheetId) return Promise.resolve(false);

  const findTarget = () => {
    const editor = getEditor();
    const ctx = editor?.getWorkbookContext?.();
    const sheet = ctx?.luckysheetfile?.find((s) => s?.id === sheetId);
    return editor && ctx && sheet ? { editor, ctx, sheet } : null;
  };

  const switchTo = ({
    editor,
    ctx,
    sheet,
  }: NonNullable<ReturnType<typeof findTarget>>): boolean => {
    if (sheet.hide === 1) return false;
    if (ctx.currentSheetId === sheetId) return true;
    const setContext = editor.getWorkbookSetContext?.();
    if (!setContext) return false;
    setContext((draft) => activate(draft as TDraft, sheetId));
    return true;
  };

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      try {
        const target = findTarget();
        if (target) {
          resolve(switchTo(target));
          return;
        }
      } catch {
        resolve(false);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(attempt, POLL_INTERVAL_MS);
    };
    attempt();
  });
}
