import { useEffect, useRef, type RefObject } from 'react';

/**
 * Remembers the last caret position (text offset) inside a formula editor.
 *
 * Clicking a sheet tab moves the DOM selection out of the editor, so by the
 * time the sheet switch finishes the caret is gone. The value kept here lets
 * the editor put the caret back exactly where the user left it (e.g. after the
 * `,` in `=SUM('Sheet - 2'!B2,`) instead of guessing.
 *
 * The offset counts characters across text nodes, matching
 * `setCursorPosition`. It resets to `null` when the edit session ends.
 */
export function useLastFormulaCaretOffset(
  editorRef: RefObject<HTMLDivElement | null>,
  editSessionActive: boolean,
): RefObject<number | null> {
  const offsetRef = useRef<number | null>(null);

  useEffect(() => {
    offsetRef.current = null;
    if (!editSessionActive) {
      return () => {};
    }

    const onSelectionChange = () => {
      const el = editorRef.current;
      const sel = window.getSelection();
      if (!el || !sel?.rangeCount) return;
      const range = sel.getRangeAt(0);
      // Ignore selections outside the editor (e.g. clicking a sheet tab) so
      // the last in-editor position survives.
      if (!el.contains(range.startContainer)) return;
      const pre = document.createRange();
      pre.selectNodeContents(el);
      pre.setEnd(range.startContainer, range.startOffset);
      offsetRef.current = pre.toString().length;
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [editorRef, editSessionActive]);

  return offsetRef;
}
