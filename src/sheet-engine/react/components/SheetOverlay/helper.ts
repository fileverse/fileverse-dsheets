import { isUndoRedoShortcut } from '@sheet-engine/core/events/keyboard-shortcut-utils';

export function moveCursorToEnd(editableDiv: HTMLDivElement) {
  editableDiv.focus(); // Ensure the element is focused

  const range = document.createRange();
  const selection = window.getSelection();

  // Set range to cover the entire content
  range.selectNodeContents(editableDiv);
  range.collapse(false); // Collapse to the end

  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

// ✅ Get cursor position inside a contentEditable div
export function getCursorPosition(editableDiv: HTMLDivElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;

  const range = selection.getRangeAt(0);
  const preRange = range.cloneRange();

  preRange.selectNodeContents(editableDiv);
  preRange.setEnd(range.endContainer, range.endOffset);

  return preRange.toString().length; // caret offset in characters
}

export function getSelectionOffsets(editableDiv: HTMLDivElement): {
  start: number;
  end: number;
} {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const caret = getCursorPosition(editableDiv);
    return { start: caret, end: caret };
  }
  const range = selection.getRangeAt(0);
  if (
    !editableDiv.contains(range.startContainer) ||
    !editableDiv.contains(range.endContainer)
  ) {
    const caret = getCursorPosition(editableDiv);
    return { start: caret, end: caret };
  }

  const startRange = range.cloneRange();
  startRange.selectNodeContents(editableDiv);
  startRange.setEnd(range.startContainer, range.startOffset);
  const start = startRange.toString().length;

  const endRange = range.cloneRange();
  endRange.selectNodeContents(editableDiv);
  endRange.setEnd(range.endContainer, range.endOffset);
  const end = endRange.toString().length;

  return {
    start: Math.max(0, Math.min(start, end)),
    end: Math.max(start, end),
  };
}

/**
 * Cmd/Ctrl+Z / Shift+Cmd+Z / Ctrl+Y redo — `onChange` must not run
 * `handleFormulaInput` or history append for these (Mac uses metaKey, not ctrlKey).
 */
export function isEditorUndoRedoKeyEvent(e: KeyboardEvent): boolean {
  if (!e.metaKey && !e.ctrlKey) return false;
  // Layout-aware (AZERTY types "z" on the KeyW slot, QWERTZ swaps Y/Z).
  if (isUndoRedoShortcut(e)) return true;
  if (e.code === 'KeyZ' || e.code === 'KeyY') return true;
  return e.keyCode === 90 || e.keyCode === 89;
}

/**
 * Use the same rule for cell input and fx bar: custom stack when the line is a
 * formula (=…) or the stack already has snapshots (plain/rich text edits).
 */
export function shouldUseCustomEditorHistory(
  editorInnerTextTrimmed: string,
  historyActive: boolean,
): boolean {
  // Treat plain text + formatted content + formulas the same: once the
  // editor has content, route undo/redo through the custom stack.
  return historyActive || editorInnerTextTrimmed.length > 0;
}

export function setCursorPosition(
  editableDiv: HTMLDivElement,
  targetOffset: number,
) {
  editableDiv.focus();

  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  const walker = document.createTreeWalker(editableDiv, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, targetOffset);
  let node = walker.nextNode();

  while (node) {
    const textLength = node.textContent?.length ?? 0;
    if (remaining <= textLength) {
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= textLength;
    node = walker.nextNode();
  }

  range.selectNodeContents(editableDiv);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function setSelectionOffsets(
  editableDiv: HTMLDivElement,
  startOffset: number,
  endOffset: number,
) {
  editableDiv.focus();

  const selection = window.getSelection();
  if (!selection) return;

  const startTarget = Math.max(0, Math.min(startOffset, endOffset));
  const endTarget = Math.max(startTarget, endOffset);

  const walker = document.createTreeWalker(editableDiv, NodeFilter.SHOW_TEXT);
  const resolve = (target: number) => {
    let remaining = target;
    let node = walker.nextNode();
    while (node) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) return { node, offset: remaining };
      remaining -= len;
      node = walker.nextNode();
    }
    return null;
  };

  walker.currentNode = editableDiv;
  const startPos = resolve(startTarget);
  walker.currentNode = editableDiv;
  const endPos = resolve(endTarget);

  const range = document.createRange();
  if (startPos && endPos) {
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
  } else {
    range.selectNodeContents(editableDiv);
    range.collapse(false);
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

export function buildFormulaSuggestionText(
  editableDiv: HTMLDivElement,
  formulaName: string,
) {
  const fullText = editableDiv.innerText || '';
  const selection = window.getSelection();
  const selectionInEditor =
    !!selection?.rangeCount &&
    editableDiv.contains(selection.getRangeAt(0).startContainer);
  const caretOffset = selectionInEditor
    ? getCursorPosition(editableDiv)
    : fullText.length;

  const safeCaretOffset = Math.max(0, Math.min(caretOffset, fullText.length));
  const beforeCaret = fullText.slice(0, safeCaretOffset);
  const afterCaret = fullText.slice(safeCaretOffset);

  let replaceStart = safeCaretOffset;
  const tokenMatch = beforeCaret.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  if (tokenMatch) {
    const token = tokenMatch[0];
    const tokenStart = safeCaretOffset - token.length;
    const charBeforeToken = tokenStart > 0 ? beforeCaret[tokenStart - 1] : '';
    if (tokenStart === 0 || /[\s=(,+\-*/&^<>]$/.test(charBeforeToken)) {
      replaceStart = tokenStart;
    }
  }

  const shouldAddOpeningParen = !afterCaret.startsWith('(');
  const insertedText = `${formulaName}${shouldAddOpeningParen ? '(' : ''}`;
  const nextText = fullText.slice(0, replaceStart) + insertedText + afterCaret;

  return {
    text: nextText,
    caretOffset: replaceStart + insertedText.length,
  };
}

export function isLetterNumberPattern(str: string): boolean {
  const regex = /^[a-zA-Z]+\d+$/;
  return regex.test(str);
}

function normalizeEditorTextForFormula(s: string): string {
  // Keep string length stable for caret math where possible.
  // - NBSP behaves like space in editors; normalize to plain space.
  // - Strip zero-width spaces that can appear around spans.
  return (s || '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
}

function getNormalizedTextAndCaret(editor: HTMLDivElement): {
  text: string;
  beforeCaret: string;
  caret: number;
} {
  const raw = editor.innerText ?? '';
  const caretRaw = getCursorPosition(editor);
  const beforeRaw = raw.slice(0, Math.max(0, Math.min(caretRaw, raw.length)));
  const text = normalizeEditorTextForFormula(raw);
  const beforeCaret = normalizeEditorTextForFormula(beforeRaw);
  return { text, beforeCaret, caret: beforeCaret.length };
}

export function isStrictFormulaEditorText(
  editor: HTMLDivElement | null,
): boolean {
  if (!editor) return false;
  const raw = editor.innerText ?? '';
  const text = normalizeEditorTextForFormula(raw);
  return text.trimStart()[0] === '=';
}

/** Same rule as InputBox/Fx onChange: show function list while typing a name after `=`. */
export function shouldShowFormulaFunctionList(
  editor: HTMLDivElement | null,
): boolean {
  if (!editor) return false;
  const { text, beforeCaret } = getNormalizedTextAndCaret(editor);
  if (!text) return false;
  const formulaText = text.trimStart();

  // Strict rule: treat as a formula only if '=' is the very first character.
  if (formulaText[0] !== '=') {
    return false;
  }

  // Delay dropdown: do not open until the user typed some non-space after '='.
  if (formulaText.slice(1).trim().length === 0) {
    return false;
  }

  // Caret-aware: show suggestions while typing a function identifier near caret.
  let tokenMatch = beforeCaret.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  if (!tokenMatch) {
    // Fallback for first-keystroke-after-newline caret lag:
    // in some contentEditable transitions, `text` already includes the typed
    // letter while `beforeCaret` still points just before it.
    const trailingTokenMatch = text.match(/[A-Za-z_][A-Za-z0-9_]*$/);
    if (
      trailingTokenMatch &&
      text.length >= beforeCaret.length &&
      text.startsWith(beforeCaret)
    ) {
      tokenMatch = trailingTokenMatch;
    }
  }
  if (!tokenMatch) {
    return false;
  }
  const token = tokenMatch[0];
  const tokenStart = beforeCaret.length - token.length;

  // Require a valid token boundary: allow after '=' and after spaces, as well as
  // common separators inside a formula.
  const charBefore = tokenStart > 0 ? beforeCaret[tokenStart - 1] : '';
  const okBoundary = tokenStart === 1 || /[\s=(,+\-*/&^<>]/.test(charBefore);
  if (!okBoundary) {
    return false;
  }

  // Ensure the token is not before '='.
  if (tokenStart <= 0) {
    return false;
  }

  return true;
}

/**
 * True when the formula looks complete at the caret:
 * - strict first character '='
 * - caret at end of editor text
 * - parentheses are balanced (no negative depth; final depth 0)
 */
export function isFormulaCompleteAtCaret(
  editor: HTMLDivElement | null,
): boolean {
  if (!editor) return false;
  const { text, caret } = getNormalizedTextAndCaret(editor);
  const formulaText = text.trimStart();
  if (!formulaText || formulaText[0] !== '=') return false;
  if (caret !== text.length) return false;

  const body = formulaText.slice(1);
  let depth = 0;
  let sawOpenParen = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '(') {
      depth += 1;
      sawOpenParen = true;
    } else if (ch === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  if (!sawOpenParen) return false;
  return depth === 0;
}

const FORMULA_FUNC_CLASS = 'luckysheet-formula-text-func';
const FORMULA_LPAR_CLASS = 'luckysheet-formula-text-lpar';

/**
 * When the caret sits on a function name span or its opening-paren span, return
 * that function's name (uppercase). Used so nested formulas like `SUM(MIN(`
 * show the inner function's hint when the caret is inside `MIN` / `MIN(`.
 *
 * Rules (match generated formula HTML):
 * - Caret inside/outside a `luckysheet-formula-text-func` span whose immediate
 *   next element sibling is `luckysheet-formula-text-lpar` → that function.
 * - Caret inside a `luckysheet-formula-text-lpar` span whose immediate previous
 *   element sibling is `luckysheet-formula-text-func` → that function.
 */
export function getFunctionNameFromFormulaCaretSpans(
  editor: HTMLDivElement | null,
): string | null {
  if (!editor) return null;

  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;

  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return null;

  let n: Node | null = range.startContainer;
  while (n && n !== editor) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const elem = n as Element;
      if (elem.classList.contains(FORMULA_FUNC_CLASS)) {
        const next = elem.nextElementSibling;
        if (next?.classList.contains(FORMULA_LPAR_CLASS)) {
          const name = elem.textContent?.trim();
          return name ? name.toUpperCase() : null;
        }
      }
      if (elem.classList.contains(FORMULA_LPAR_CLASS)) {
        const prev = elem.previousElementSibling;
        if (prev?.classList.contains(FORMULA_FUNC_CLASS)) {
          const name = prev.textContent?.trim();
          return name ? name.toUpperCase() : null;
        }
      }
    }
    n = n.parentNode;
  }

  return null;
}

export function removeLastSpan(htmlString: string) {
  // Create a temporary container
  const container = document.createElement('div');
  container.innerHTML = htmlString;

  // Get all span elements
  const spans = container.querySelectorAll('span');

  if (spans.length > 0) {
    const lastSpan = spans[spans.length - 1];
    lastSpan.remove();
  }

  // Return the updated HTML string
  return container.innerHTML;
}

function parseCell(input: string) {
  const match = input.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;
  return {
    colPart: match[1].toUpperCase(),
    rowPart: parseInt(match[2], 10),
  };
}

function columnToNumber(colPart: string) {
  let colNumber = 0;
  for (let i = 0; i < colPart.length; i += 1) {
    colNumber = colNumber * 26 + (colPart.charCodeAt(i) - 64);
  }
  return colNumber;
}

export function numberToColumn(colNumber: number) {
  let colPart = '';
  while (colNumber > 0) {
    colNumber -= 1;
    colPart = String.fromCharCode(65 + (colNumber % 26)) + colPart;
    colNumber = Math.floor(colNumber / 26);
  }
  return colPart;
}

export function incrementColumn(cell: string): string {
  const parsed = parseCell(cell);
  if (!parsed) return '';

  let colNumber = columnToNumber(parsed.colPart);
  colNumber += 1;

  const newColPart = numberToColumn(colNumber);
  return newColPart + parsed.rowPart;
}

export function decrementColumn(cell: string): string {
  const parsed = parseCell(cell);
  if (!parsed) return '';

  let colNumber = columnToNumber(parsed.colPart);
  colNumber = Math.max(1, colNumber - 1); // Prevent going below 'A'

  const newColPart = numberToColumn(colNumber);
  return newColPart + parsed.rowPart;
}

export function incrementRow(cell: string): string {
  const parsed = parseCell(cell);
  if (!parsed) return '';

  const newRowPart = parsed.rowPart + 1;
  return parsed.colPart + newRowPart;
}

export function decrementRow(cell: string): string {
  const parsed = parseCell(cell);
  if (!parsed) return '';

  const newRowPart = Math.max(1, parsed.rowPart - 1); // Prevent going below row 1
  return parsed.colPart + newRowPart;
}

export function countCommasBeforeCursor(editableDiv: HTMLDivElement): number {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return 0;

  const range = selection.getRangeAt(0);
  const preCaretRange = range.cloneRange();
  preCaretRange.selectNodeContents(editableDiv);
  preCaretRange.setEnd(range.endContainer, range.endOffset);

  const textBeforeCursor = preCaretRange.toString();

  let inQuotes = false;
  let count = 0;

  for (let i = 0; i < textBeforeCursor.length; i += 1) {
    const char = textBeforeCursor[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      count += 1;
    }
  }

  return count;
}
