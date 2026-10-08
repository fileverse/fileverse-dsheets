export const COPY_SHEET_LINK_ITEM = 'copy-link';
const DIVIDER = '|';

const READ_ONLY_SAFE_ITEMS = new Set<string>([COPY_SHEET_LINK_ITEM]);

type ReadOnlyFlags = { isFlvReadOnly?: boolean; allowEdit?: boolean };
type CopyLinkHooks = { onCopySheetLink?: unknown };

export function isSheetTabReadOnly(ctx: ReadOnlyFlags): boolean {
  return !!ctx.isFlvReadOnly || ctx.allowEdit === false;
}

export function canOpenSheetTabMenu(
  ctx: ReadOnlyFlags,
  hooks: CopyLinkHooks,
): boolean {
  if (!isSheetTabReadOnly(ctx)) return true;
  return typeof hooks.onCopySheetLink === 'function';
}

export function getVisibleSheetTabMenuItems(
  items: string[],
  opts: { readOnly: boolean; hasCopyLink: boolean },
): string[] {
  const filtered = items.filter((name) => {
    if (name === COPY_SHEET_LINK_ITEM && !opts.hasCopyLink) return false;
    if (opts.readOnly && name !== DIVIDER)
      return READ_ONLY_SAFE_ITEMS.has(name);
    return true;
  });

  // Dividers only make sense between two real items.
  return filtered.filter((name, i, arr) => {
    if (name !== DIVIDER) return true;
    const hasItemBefore = arr.slice(0, i).some((n) => n !== DIVIDER);
    const hasItemAfter = arr.slice(i + 1).some((n) => n !== DIVIDER);
    return hasItemBefore && hasItemAfter && arr[i - 1] !== DIVIDER;
  });
}
