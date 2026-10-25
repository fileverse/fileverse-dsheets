import _ from 'lodash';
import { Context, getFlowdata } from '../context';
import { GlobalCache } from '../types';
import { getSheetIndex } from '../utils';
import { mergeBorder } from './cell';
import { generateRandomId } from './image';

// Allowlist Dune chart URLs only (HTTPS embeds / queries).
export function sanitizeDuneUrl(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const iframeAttrMatch = trimmed.match(
    /src=["']?(https:\/\/dune\.com\/embeds\/\d+\/\d+)/i,
  );
  if (iframeAttrMatch) {
    return iframeAttrMatch[1];
  }

  const embedMatch = trimmed.match(
    /^https:\/\/dune\.com\/embeds\/(\d+)\/(\d+)\/?(?:\?.*)?$/i,
  );
  if (embedMatch) {
    return `https://dune.com/embeds/${embedMatch[1]}/${embedMatch[2]}`;
  }

  const queryMatch = trimmed.match(
    /^https:\/\/dune\.com\/queries\/(\d+)\/(\d+)\/?(?:\?.*)?$/i,
  );
  if (queryMatch) {
    return `https://dune.com/embeds/${queryMatch[1]}/${queryMatch[2]}`;
  }

  return null;
}

export function sanitizeSheetIframes<T extends { src?: string }>(
  iframes: T[] | null | undefined,
): T[] {
  if (!Array.isArray(iframes)) return [];
  const out: T[] = [];
  for (const frame of iframes) {
    const safeSrc = sanitizeDuneUrl(frame?.src ?? '');
    if (!safeSrc) continue;
    out.push({ ...frame, src: safeSrc });
  }
  return out;
}

export function saveIframe(ctx: Context) {
  const index = getSheetIndex(ctx, ctx.currentSheetId);
  if (index == null) return;
  const file = ctx.luckysheetfile[index];
  file.iframes = ctx.insertedIframes;
}

export function insertIframe(ctx: Context, src: string) {
  try {
    const safeSrc = sanitizeDuneUrl(src);
    if (!safeSrc) {
      console.warn('Unsupported iframe src:', src);
      return;
    }

    const last =
      ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
    const rowIndex = last?.row_focus ?? last?.row?.[0] ?? 0;
    const colIndex = last?.column_focus ?? last?.column?.[0] ?? 0;

    const flowdata = getFlowdata(ctx);
    let left = colIndex === 0 ? 0 : ctx.visibledatacolumn[colIndex - 1];
    let top = rowIndex === 0 ? 0 : ctx.visibledatarow[rowIndex - 1];
    if (flowdata) {
      const margeset = mergeBorder(ctx, flowdata, rowIndex, colIndex);
      if (margeset) {
        [top] = margeset.row;
        [left] = margeset.column;
      }
    }

    const iframe = {
      id: generateRandomId('iframe'),
      src: safeSrc,
      left,
      top,
      width: 400,
      height: 300,
    };

    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const file = ctx.luckysheetfile[index];

    file.iframes = (file.iframes || []).concat(iframe);
    ctx.insertedIframes = file.iframes;
  } catch (err) {
    console.info(err);
  }
}

export function insertDuneChart(ctx: Context, input: string) {
  const embedUrl = sanitizeDuneUrl(input);

  if (!embedUrl) {
    console.warn('Unsupported Dune chart URL:', input);
    return;
  }

  insertIframe(ctx, embedUrl);
}

function getIframePosition() {
  const box = document.getElementById('fortune-modal-dialog-activeIframe');
  if (!box) return undefined;
  const { width, height } = box.getBoundingClientRect();
  const left = box.offsetLeft;
  const top = box.offsetTop;
  return { left, top, width, height };
}

// --- MOVE LOGIC ---

export function onIframeResizeEnd(ctx: Context, globalCache: GlobalCache) {
  if (globalCache.iframe?.resizingSide) {
    globalCache.iframe = undefined;
    const position = getIframePosition();
    if (position) {
      const iframe = _.find(
        ctx.insertedIframes,
        (v) => v.id === ctx.activeIframe,
      );
      if (iframe) {
        iframe.left = position.left / ctx.zoomRatio;
        iframe.top = position.top / ctx.zoomRatio;
        iframe.width = position.width / ctx.zoomRatio;
        iframe.height = position.height / ctx.zoomRatio;
        saveIframe(ctx);
      }
    }
  }
}

export function onIframeMove(
  ctx: Context,
  globalCache: GlobalCache,
  e: MouseEvent,
) {
  if (ctx.allowEdit === false) return false;
  const iframe = globalCache?.iframe;
  const el = document.getElementById('fortune-modal-dialog-activeIframe');
  if (el && iframe && !iframe.resizingSide) {
    const { x: startX, y: startY } = iframe.cursorMoveStartPosition!;
    let { top, left } = iframe.iframeInitialPosition!;
    left += e.pageX - startX;
    top += e.pageY - startY;
    if (top < 0) top = 0;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    return true;
  }
  return false;
}

export function onIframeMoveEnd(ctx: Context, globalCache: GlobalCache) {
  const position = getIframePosition();
  if (!globalCache.iframe?.resizingSide) {
    globalCache.iframe = undefined;
    if (position) {
      const iframe = _.find(
        ctx.insertedIframes,
        (v) => v.id === ctx.activeIframe,
      );
      if (iframe) {
        iframe.left = position.left / ctx.zoomRatio;
        iframe.top = position.top / ctx.zoomRatio;
        saveIframe(ctx);
      }
    }
  }
}

export function onIframeMoveStart(
  ctx: Context,
  globalCache: GlobalCache,
  e: MouseEvent,
) {
  const position = getIframePosition();
  if (position) {
    const { top, left } = position;
    _.set(globalCache, 'iframe', {
      cursorMoveStartPosition: { x: e.pageX, y: e.pageY },
      iframeInitialPosition: { left, top },
    });
  }
}

// --- RESIZE LOGIC ---

export function onIframeResize(
  ctx: Context,
  globalCache: GlobalCache,
  e: MouseEvent,
) {
  if (ctx.allowEdit === false) return false;
  const iframe = globalCache?.iframe;
  if (!iframe?.resizingSide) return false;

  const container = document.getElementById(
    'fortune-modal-dialog-activeIframe',
  );
  const content = container?.querySelector('.luckysheet-modal-dialog-content');
  if (!container || !content) return false;

  const { x: startX, y: startY } = iframe.cursorMoveStartPosition!;
  let { top, left, width, height } = iframe.iframeInitialPosition!;
  const dx = e.pageX - startX;
  const dy = e.pageY - startY;
  const minHeight = 60 * ctx.zoomRatio;
  const minWidth = 90 * ctx.zoomRatio;

  if (['lm', 'lt', 'lb'].includes(iframe.resizingSide)) {
    if (width - dx < minWidth) {
      left += width - minWidth;
      width = minWidth;
    } else {
      left += dx;
      width -= dx;
    }
    if (left < 0) left = 0;
    container.style.left = `${left}px`;
  }

  if (['rm', 'rt', 'rb'].includes(iframe.resizingSide)) {
    width = width + dx < minWidth ? minWidth : width + dx;
  }

  if (['mt', 'lt', 'rt'].includes(iframe.resizingSide)) {
    if (height - dy < minHeight) {
      top += height - minHeight;
      height = minHeight;
    } else {
      top += dy;
      height -= dy;
    }
    if (top < 0) top = 0;
    container.style.top = `${top}px`;
  }

  if (['mb', 'lb', 'rb'].includes(iframe.resizingSide)) {
    height = height + dy < minHeight ? minHeight : height + dy;
  }

  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  (content as HTMLElement).style.width = `${width}px`;
  (content as HTMLElement).style.height = `${height}px`;

  return true;
}

export function onIframeResizeStart(
  ctx: Context,
  globalCache: GlobalCache,
  e: MouseEvent,
  resizingSide: string,
) {
  const position = getIframePosition();
  if (position) {
    _.set(globalCache, 'iframe', {
      cursorMoveStartPosition: { x: e.pageX, y: e.pageY },
      resizingSide,
      iframeInitialPosition: position,
    });
  }
}
