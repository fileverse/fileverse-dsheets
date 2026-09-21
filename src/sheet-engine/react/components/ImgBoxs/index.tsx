import _ from 'lodash';
import {
  onImageMoveStart,
  onImageResizeStart,
  removeActiveImage,
  cancelNormalSelected,
  getFrozenPixelBounds,
} from '@sheet-engine/core';
import React, { useContext, useEffect, useMemo, useRef } from 'react';
import WorkbookContext from '../../context';

const ImgBoxs: React.FC = () => {
  const { context, setContext, refs } = useContext(WorkbookContext);
  const activeImgRef = useRef<HTMLDivElement>(null);
  const activeImg = useMemo(() => {
    return _.find(context.insertedImgs, { id: context.activeImg });
  }, [context.activeImg, context.insertedImgs]);

  // Frozen rows/columns are only ever redrawn at a fixed spot on the canvas
  // -- there's no separate DOM layer for them -- so an inserted image (a
  // plain DOM box positioned in document space) can scroll on top of them.
  // Clip each image to whatever screen space isn't claimed by the frozen
  // strip so it visually tucks behind it instead, like a real freeze pane.
  const { widthPx: frozenWidthPx, heightPx: frozenHeightPx } = useMemo(
    () => getFrozenPixelBounds(context),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      context.luckysheetfile,
      context.currentSheetId,
      context.visibledatarow,
      context.visibledatacolumn,
    ],
  );

  // Keep keyboard focus on the active image so Delete / Ctrl+C/X/V work
  // immediately after click (without needing a prior move/resize).
  useEffect(() => {
    if (!context.activeImg || !activeImgRef.current) return;
    activeImgRef.current.focus({ preventScroll: true });
  }, [context.activeImg]);

  const selectImage = (id: string) => {
    setContext((ctx) => {
      // Exit cell edit so Delete / shortcuts are not swallowed by edit-mode handling
      if (ctx.luckysheetCellUpdate.length > 0) {
        cancelNormalSelected(ctx);
      }
      ctx.activeImg = id;
    });
    // Focus sheet overlay path so both keydown and paste listeners fire
    requestAnimationFrame(() => {
      activeImgRef.current?.focus({ preventScroll: true });
      if (!activeImgRef.current) {
        (
          document.querySelector(
            '.fortune-sheet-overlay',
          ) as HTMLElement | null
        )?.focus({ preventScroll: true });
        refs.workbookContainer.current?.focus({ preventScroll: true });
      }
    });
  };

  return (
    <div id="luckysheet-image-showBoxs">
      {activeImg && (
        <div
          id="luckysheet-modal-dialog-activeImage"
          ref={activeImgRef}
          className="luckysheet-modal-dialog"
          tabIndex={-1}
          style={{
            padding: 0,
            position: 'absolute',
            zIndex: 300,
            width: activeImg.width * context.zoomRatio,
            height: activeImg.height * context.zoomRatio,
            left: activeImg.left * context.zoomRatio,
            top: activeImg.top * context.zoomRatio,
            outline: 'none',
          }}
        >
          <div
            className="luckysheet-modal-dialog-border"
            style={{ position: 'absolute' }}
          />
          <div
            className="luckysheet-modal-dialog-content"
            style={{
              width: activeImg.width * context.zoomRatio,
              height: activeImg.height * context.zoomRatio,
              backgroundImage: `url(${activeImg.src})`,
              backgroundSize: `${activeImg.width * context.zoomRatio}px ${
                activeImg.height * context.zoomRatio
              }px`,
              backgroundRepeat: 'no-repeat',
            }}
            onMouseDown={(e) => {
              const { nativeEvent } = e;
              onImageMoveStart(context, refs.globalCache, nativeEvent);
              e.stopPropagation();
            }}
          />
          <div className="luckysheet-modal-dialog-resize">
            {['lt', 'mt', 'lm', 'rm', 'rt', 'lb', 'mb', 'rb'].map((v) => (
              <div
                key={v}
                className={`luckysheet-modal-dialog-resize-item luckysheet-modal-dialog-resize-item-${v}`}
                data-type={v}
                onMouseDown={(e) => {
                  const { nativeEvent } = e;
                  onImageResizeStart(refs.globalCache, nativeEvent, v);
                  e.stopPropagation();
                }}
              />
            ))}
          </div>
          <div className="luckysheet-modal-dialog-controll">
            <span
              className="luckysheet-modal-controll-btn luckysheet-modal-controll-crop"
              role="button"
              tabIndex={0}
              aria-label="裁剪"
              title="裁剪"
            >
              <i className="fa fa-pencil" aria-hidden="true" />
            </span>
            <span
              className="luckysheet-modal-controll-btn luckysheet-modal-controll-restore"
              role="button"
              tabIndex={0}
              aria-label="恢复原图"
              title="恢复原图"
            >
              <i className="fa fa-window-maximize" aria-hidden="true" />
            </span>
            <span
              className="luckysheet-modal-controll-btn luckysheet-modal-controll-del"
              role="button"
              tabIndex={0}
              aria-label="删除"
              title="删除"
              onClick={(e) => {
                e.stopPropagation();
                setContext((ctx) => {
                  removeActiveImage(ctx);
                });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  setContext((ctx) => {
                    removeActiveImage(ctx);
                  });
                }
              }}
            >
              <i className="fa fa-trash" aria-hidden="true" />
            </span>
          </div>
        </div>
      )}
      <div className="img-list">
        {context.insertedImgs?.map((v: any) => {
          const { id, left, top, width, height, src } = v;
          if (v.id === context.activeImg) return null;

          // This image's current on-screen position, i.e. its document
          // position minus how far the sheet has scrolled. The frozen
          // strip always occupies screen (0,0) to (frozenWidthPx,
          // frozenHeightPx), so however much of the image falls to the
          // left of / above that boundary gets clipped away.
          const screenTop = top * context.zoomRatio - context.scrollTop;
          const screenLeft = left * context.zoomRatio - context.scrollLeft;
          const topClip = Math.max(0, frozenHeightPx - screenTop);
          const leftClip = Math.max(0, frozenWidthPx - screenLeft);
          const clipPath =
            topClip > 0 || leftClip > 0
              ? `inset(${topClip}px 0 0 ${leftClip}px)`
              : undefined;

          return (
            <div
              id={id}
              key={id}
              className="luckysheet-modal-dialog luckysheet-modal-dialog-image"
              style={{
                width: width * context.zoomRatio,
                height: height * context.zoomRatio,
                padding: 0,
                position: 'absolute',
                left: left * context.zoomRatio,
                top: top * context.zoomRatio,
                zIndex: 200,
                clipPath,
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                selectImage(id);
                e.stopPropagation();
              }}
            >
              <div
                className="luckysheet-modal-dialog-content"
                style={{
                  width: '100%',
                  height: '100%',
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                <img
                  src={src}
                  alt=""
                  style={{
                    width: width * context.zoomRatio,
                    height: height * context.zoomRatio,
                  }}
                />
              </div>
              <div className="luckysheet-modal-dialog-border" />
            </div>
          );
        })}
      </div>
      <div
        id="luckysheet-modal-dialog-cropping"
        className="luckysheet-modal-dialog"
        style={{
          display: 'none',
          padding: 0,
          position: 'absolute',
          zIndex: 300,
        }}
      >
        <div className="cropping-mask" />
        <div className="cropping-content" />
        <div
          className="luckysheet-modal-dialog-border"
          style={{ position: 'absolute' }}
        />
        <div className="luckysheet-modal-dialog-resize">
          <div className="resize-item lt" data-type="lt" />
          <div className="resize-item mt" data-type="mt" />
          <div className="resize-item lm" data-type="lm" />
          <div className="resize-item rm" data-type="rm" />
          <div className="resize-item rt" data-type="rt" />
          <div className="resize-item lb" data-type="lb" />
          <div className="resize-item mb" data-type="mb" />
          <div className="resize-item rb" data-type="rb" />
        </div>
        <div className="luckysheet-modal-dialog-controll">
          <span
            className="luckysheet-modal-controll-btn luckysheet-modal-controll-crop"
            role="button"
            tabIndex={0}
            aria-label="裁剪"
            title="裁剪"
          >
            <i className="fa fa-pencil" aria-hidden="true" />
          </span>
          <span
            className="luckysheet-modal-controll-btn luckysheet-modal-controll-restore"
            role="button"
            tabIndex={0}
            aria-label="恢复原图"
            title="恢复原图"
          >
            <i className="fa fa-window-maximize" aria-hidden="true" />
          </span>
          <span
            className="luckysheet-modal-controll-btn luckysheet-modal-controll-del"
            role="button"
            tabIndex={0}
            aria-label="删除"
            title="删除"
          >
            <i className="fa fa-trash" aria-hidden="true" />
          </span>
        </div>
      </div>

      <div className="cell-date-picker" />
    </div>
  );
};

export default ImgBoxs;
