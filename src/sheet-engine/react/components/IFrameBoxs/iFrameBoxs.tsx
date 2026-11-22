import React, { useContext, useEffect, useRef, useMemo } from 'react';
import { IconButton } from '@fileverse/ui';
import {
  onIframeMoveStart,
  onIframeResizeStart,
  onIframeMove,
  onIframeMoveEnd,
  onIframeResize,
  onIframeResizeEnd,
  sanitizeDuneUrl,
} from '@sheet-engine/core';
import WorkbookContext from '../../context';
import './iFrameBoxs.css';

const IframeBoxs: React.FC = () => {
  const { context, setContext, refs } = useContext(WorkbookContext);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentSheetIframes = useMemo(() => {
    const currentSheet = context.luckysheetfile.find(
      (sheet) => sheet.id === context.currentSheetId,
    );
    return currentSheet?.iframes || [];
  }, [context.luckysheetfile, context.currentSheetId]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!containerRef.current) return;

      const iframeBoxes = containerRef.current.querySelectorAll(
        '.luckysheet-modal-dialog-iframe',
      );

      const clickedInsideSomeIframe = Array.from(iframeBoxes).some((el) =>
        el.contains(e.target as Node),
      );

      if (!clickedInsideSomeIframe && context.activeIframe !== undefined) {
        setContext((ctx) => {
          ctx.activeIframe = undefined;
        });
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [context.activeIframe, setContext]);

  return (
    <div id="fortune-iframe-boxes" ref={containerRef}>
      {currentSheetIframes?.map((frame: any) => {
        const isActive = frame.id === context.activeIframe;
        const safeSrc = sanitizeDuneUrl(frame.src ?? '');
        const style = {
          width: frame.width * context.zoomRatio,
          height: frame.height * context.zoomRatio,
          left: frame.left * context.zoomRatio,
          top: frame.top * context.zoomRatio,
          position: 'absolute' as const,
          padding: 0,
          zIndex: isActive ? 300 : 200,
        };

        return (
          <div
            key={frame.id}
            id={isActive ? 'fortune-modal-dialog-activeIframe' : frame.id}
            className="luckysheet-modal-dialog luckysheet-modal-dialog-iframe"
            style={style}
            onClick={(e) => {
              if (!isActive) {
                setContext((ctx) => {
                  ctx.activeIframe = frame.id;
                });
              }
              e.stopPropagation();
            }}
            onMouseDown={(e) => {
              if (isActive) {
                onIframeMoveStart(context, refs.globalCache, e.nativeEvent);
                const handleMouseMove = (moveEvent: MouseEvent) => {
                  onIframeMove(context, refs.globalCache, moveEvent);
                };
                const handleMouseUp = () => {
                  onIframeMoveEnd(context, refs.globalCache);
                  document.removeEventListener('mousemove', handleMouseMove);
                  document.removeEventListener('mouseup', handleMouseUp);
                };
                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
              }
              e.stopPropagation();
            }}
          >
            <div
              className="luckysheet-modal-dialog-content"
              style={{ width: '100%', height: '100%', overflow: 'hidden' }}
            >
              {safeSrc ? (
                <iframe
                  title={`iframe-${frame.id}`}
                  src={safeSrc}
                  sandbox="allow-scripts allow-same-origin allow-popups"
                  referrerPolicy="no-referrer"
                  style={{
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    pointerEvents: 'none',
                  }}
                />
              ) : (
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 12,
                    boxSizing: 'border-box',
                    fontSize: 12,
                    color: '#666',
                    background: '#f5f5f5',
                    textAlign: 'center',
                  }}
                >
                  Embed blocked: unsupported or disallowed source
                </div>
              )}
            </div>

            <div className="luckysheet-modal-dialog-border" />

            {isActive && (
              <>
                <div className="luckysheet-modal-dialog-resize">
                  {['lt', 'mt', 'lm', 'rm', 'rt', 'lb', 'mb', 'rb'].map((v) => (
                    <div
                      key={v}
                      className={`luckysheet-modal-dialog-resize-item luckysheet-modal-dialog-resize-item-${v}`}
                      data-type={v}
                      onMouseDown={(e) => {
                        onIframeResizeStart(
                          context,
                          refs.globalCache,
                          e.nativeEvent,
                          v,
                        );
                        const handleMouseMove = (moveEvent: MouseEvent) => {
                          onIframeResize(context, refs.globalCache, moveEvent);
                        };
                        const handleMouseUp = () => {
                          onIframeResizeEnd(context, refs.globalCache);
                          document.removeEventListener(
                            'mousemove',
                            handleMouseMove,
                          );
                          document.removeEventListener(
                            'mouseup',
                            handleMouseUp,
                          );
                        };
                        document.addEventListener('mousemove', handleMouseMove);
                        document.addEventListener('mouseup', handleMouseUp);
                        e.stopPropagation();
                      }}
                    />
                  ))}
                </div>

                <div className="luckysheet-modal-dialog-controll">
                  <IconButton
                    icon="Trash2"
                    onClick={() => {
                      setContext((ctx) => {
                        const currentSheet = ctx.luckysheetfile.find(
                          (sheet) => sheet.id === ctx.currentSheetId,
                        );
                        if (currentSheet) {
                          currentSheet.iframes = currentSheet.iframes?.filter(
                            (f: any) => f.id !== frame.id,
                          );
                        }
                        ctx.activeIframe = undefined;
                      });
                    }}
                    variant="ghost"
                    className="fortune-iframe-boxes-delete-button"
                  />
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default IframeBoxs;
