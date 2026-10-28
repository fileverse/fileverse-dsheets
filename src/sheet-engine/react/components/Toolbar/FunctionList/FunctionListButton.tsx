import { Popover, PopoverContent, PopoverTrigger } from '@fileverse/ui';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { LucideIcon } from '@fileverse/ui';
import { HoverMenuItem } from './HoverMenuItem';
import { FunctionLocaleItem, groupFunctions } from './group-functions';
import { useWorkbookContextIgnoringScroll } from '../../../context/use-workbook-store';
import {
  api,
  escapeHTMLTag,
  escapeScriptTag,
  functionHTMLGenerate,
  getFormulaEditorOwner,
  setFormulaEditorOwner,
  locale,
} from '@sheet-engine/core';
import {
  buildFormulaSuggestionText,
  setCursorPosition,
} from '../../SheetOverlay/helper';

const POPOVER_STYLE = {
  border: '1px solid hsl(var(--color-border-default, #E8EBEC))',
  boxShadow: '0 4px 16px -4px rgba(0, 0, 0, 0.15)',
};

const QUICK_ACTIONS = ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'] as const;

type OutsideEvent = {
  target: EventTarget | null;
  preventDefault: () => void;
};

const isFromFunctionListSubmenuTarget = (target: EventTarget | null) => {
  return Boolean(
    target instanceof HTMLElement &&
    target.closest('[data-hovermenu-submenu="true"]'),
  );
};

const isFromSheetCellEditorTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      '#luckysheet-rich-text-editor, .luckysheet-cell-input, .luckysheet-cell-input *',
    ),
  );
};

function FunctionListSubmenuScrollArea({
  children,
  maxHeight = 360,
}: {
  children: React.ReactNode;
  maxHeight?: number;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(
    null,
  );

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const viewportHeight = el.clientHeight;
    const scrollHeight = el.scrollHeight;

    if (scrollHeight <= viewportHeight) {
      setThumb(null);
      return;
    }

    const trackPadding = 2;
    const trackHeight = Math.max(0, viewportHeight - trackPadding * 2);

    const minThumbHeight = 24;
    const rawThumbHeight = (viewportHeight / scrollHeight) * trackHeight;
    const thumbHeight = Math.max(minThumbHeight, Math.floor(rawThumbHeight));

    const maxScrollTop = scrollHeight - viewportHeight;
    const scrollRatio = maxScrollTop > 0 ? el.scrollTop / maxScrollTop : 0;

    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = trackPadding + Math.round(scrollRatio * maxThumbTop);

    setThumb({ top: thumbTop, height: thumbHeight });
  }, []);

  useEffect(() => {
    recompute();
    const onResize = () => recompute();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [recompute]);

  return (
    <div
      className="fortune-functionlist-submenu-scrollarea"
      style={{ maxHeight }}
    >
      <div
        ref={scrollRef}
        className="fortune-functionlist-submenu-viewport"
        onScroll={recompute}
      >
        {children}
      </div>
      <div className="fortune-functionlist-submenu-scrollbar" aria-hidden>
        {thumb ? (
          <div
            className="fortune-functionlist-submenu-thumb"
            style={{
              top: `${thumb.top}px`,
              height: `${thumb.height}px`,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export const FunctionList = () => {
  const { context, setContext, refs } = useWorkbookContextIgnoringScroll();
  const [isFunctionOpen, setIsFunctionOpen] = useState<boolean>(false);
  const [openSampleCategory, setOpenSampleCategory] = useState<string | null>(
    null,
  );

  const insertFormulaIntoActiveCell = useCallback(
    (formulaName: string) => {
      if (context.allowEdit === false || context.isFlvReadOnly === true) {
        setIsFunctionOpen(false);
        setOpenSampleCategory(null);
        return;
      }

      const selection = context.luckysheet_select_save?.[0];
      const row = selection?.row_focus ?? 0;
      const col = selection?.column_focus ?? 0;

      // If there's no selection yet, establish one (A1) before entering edit mode.
      if (!selection) {
        setContext((draftCtx) => {
          api.setSelection(draftCtx, [{ row: [0, 0], column: [0, 0] }], {
            id: draftCtx.currentSheetId,
          });
        });
      }

      const owner =
        context.luckysheetCellUpdate.length > 0
          ? getFormulaEditorOwner(context)
          : 'cell';

      refs.globalCache.doNotFocus = true;
      refs.globalCache.doNotUpdateCell = true;

      setContext((draftCtx) => {
        setFormulaEditorOwner(draftCtx, owner);
        draftCtx.luckysheetCellUpdate = [row, col];
      });

      requestAnimationFrame(() => {
        const cellEditor = refs.cellInput.current;
        const fxEditor = refs.fxInput.current;
        const target = owner === 'fx' ? fxEditor : cellEditor;
        if (!target) return;

        const upper = String(formulaName || '')
          .trim()
          .toUpperCase();
        const { text: baseText, caretOffset: baseCaret } =
          buildFormulaSuggestionText(target, `=${upper}`);

        const caretInsideParen = baseText.slice(baseCaret).startsWith('(')
          ? baseCaret + 1
          : baseCaret;

        const nextText =
          baseText[caretInsideParen] === ')'
            ? baseText
            : `${baseText.slice(0, caretInsideParen)})${baseText.slice(caretInsideParen)}`;

        const safeText = escapeScriptTag(nextText);
        const html = safeText.startsWith('=')
          ? functionHTMLGenerate(safeText)
          : escapeHTMLTag(safeText);

        if (cellEditor) cellEditor.innerHTML = html;
        if (fxEditor) fxEditor.innerHTML = html;

        setCursorPosition(target, caretInsideParen);
        target.focus({ preventScroll: true });
      });

      setIsFunctionOpen(false);
      setOpenSampleCategory(null);
    },
    [context, refs.cellInput, refs.fxInput, refs.globalCache, setContext],
  );

  // The list only changes with the language, so depend on it, not the whole
  // context (E4). The locale object is read each render because its data can
  // finish loading after the language was set.
  const functionlist = locale(context).functionlist as unknown as
    | FunctionLocaleItem[]
    | undefined;
  const groupedFunctions = useMemo(
    () => groupFunctions(functionlist ?? []),
    [functionlist],
  );

  return (
    <div>
      <Popover
        open={isFunctionOpen}
        onOpenChange={(open: boolean) => {
          setIsFunctionOpen(open);
          if (!open) setOpenSampleCategory(null);
        }}
      >
        <PopoverTrigger asChild>
          <div className="flex items-center justify-center w-[30px] h-[30px] hover:!color-bg-default-hover rounded cursor-pointer">
            <LucideIcon name="Sigma" className="w-[16px] h-[16px]" />
          </div>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-full p-2 border-[1px] border-solid border-[var(--color-border-default,#E8EBEC)] min-w-[240px]"
          elevation={2}
          side="bottom"
          sideOffset={4}
          style={POPOVER_STYLE}
          // Nested submenus render in their own Popover (portal). Without this,
          // Radix can treat entering the submenu as an "outside interaction" and
          // close the parent popover immediately.
          onInteractOutside={(e: OutsideEvent) => {
            if (
              isFromFunctionListSubmenuTarget(e.target) ||
              isFromSheetCellEditorTarget(e.target)
            ) {
              e.preventDefault();
            }
          }}
          onPointerDownOutside={(e: OutsideEvent) => {
            if (
              isFromFunctionListSubmenuTarget(e.target) ||
              isFromSheetCellEditorTarget(e.target)
            ) {
              e.preventDefault();
            }
          }}
          onFocusOutside={(e: OutsideEvent) => {
            if (
              isFromFunctionListSubmenuTarget(e.target) ||
              isFromSheetCellEditorTarget(e.target)
            ) {
              e.preventDefault();
            }
          }}
        >
          <div className="color-text-default">
            {QUICK_ACTIONS.map((action) => (
              <HoverMenuItem
                key={action}
                label={action}
                onClick={() => {
                  insertFormulaIntoActiveCell(action);
                }}
              />
            ))}
            <hr className="color-border-default my-1" />
            {groupedFunctions.categories.map((categoryKey) => (
              <HoverMenuItem
                key={categoryKey}
                label={categoryKey}
                rightSlot={
                  <LucideIcon
                    name="ChevronRight"
                    className="w-[17px] h-[17px]"
                  />
                }
                open={openSampleCategory === categoryKey}
                onOpenChange={(open: boolean) => {
                  if (open) {
                    setOpenSampleCategory(categoryKey);
                    return;
                  }

                  // If the user has already moved to another category, ignore stale
                  // close events coming from the previous category's delayed timer.
                  setOpenSampleCategory((current) =>
                    current === categoryKey ? null : current,
                  );
                }}
                contentStyle={{
                  ...POPOVER_STYLE,
                  minWidth: '220px',
                }}
                renderSubmenu={() => (
                  <FunctionListSubmenuScrollArea>
                    <div className="flex flex-col">
                      {groupedFunctions.getFunctions(categoryKey).map((fn) => (
                        <HoverMenuItem
                          key={fn}
                          label={fn}
                          onClick={() => {
                            insertFormulaIntoActiveCell(fn);
                          }}
                        />
                      ))}
                    </div>
                  </FunctionListSubmenuScrollArea>
                )}
              />
            ))}
            <hr className="color-border-default my-1" />

            <button
              type="button"
              className="hover:color-bg-default-hover h-8 rounded p-2 w-full text-left flex items-center justify-between space-x-2 transition"
              onClick={() => {
                const button = document.getElementById('function-button');
                if (button) {
                  button.click();
                }
                setIsFunctionOpen(false);
                setOpenSampleCategory(null);
              }}
            >
              <span className="text-body-sm truncate">Learn More</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
