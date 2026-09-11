import React, { useContext, useEffect } from 'react';
import {
  getFlowdata,
  onCommentBoxMoveStart,
  setEditingComment,
  showComments,
} from '@sheet-engine/core';
import _ from 'lodash';
import WorkbookContext from '../../context';

const NotationBoxes: React.FC = () => {
  const { context, setContext, refs, settings } = useContext(WorkbookContext);
  const flowdata = getFlowdata(context);

  // TODO use patch to detect ps isShow change may be more effecient
  useEffect(() => {
    if (flowdata) {
      const psShownCells: { r: number; c: number }[] = [];
      for (let i = 0; i < flowdata.length; i += 1) {
        for (let j = 0; j < flowdata[i].length; j += 1) {
          const cell = flowdata[i][j];
          if (!cell) continue;
          if (cell.ps?.isShow) {
            psShownCells.push({ r: i, c: j });
          }
        }
      }
      setContext((ctx) => {
        showComments(ctx, psShownCells);
      });
    }
  }, [flowdata, setContext]);

  // Escape closes the pinned (editingCommentBox) popup.
  useEffect(() => {
    if (!context.editingCommentBox) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setContext((draft) => {
        draft.editingCommentBox = undefined;
      });
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [context.editingCommentBox, setContext]);

  const handleMouseDownEvent =
    (r: number, c: number, rc: string, commentId: string) =>
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      const { nativeEvent } = e;
      // @ts-ignore
      setContext((draftContext) => {
        if (flowdata) {
          setEditingComment(draftContext, flowdata, r, c);
        }
      });
      onCommentBoxMoveStart(
        context,
        refs.globalCache,
        nativeEvent,
        { r, c, rc },
        commentId,
      );
      e.stopPropagation();
    };
  return (
    <div id="luckysheet-postil-showBoxs">
      {_.concat(
        context.commentBoxes?.filter(
          (v) => v?.rc !== context.editingCommentBox?.rc,
        ),
        [context.editingCommentBox, context.hoveredCommentBox],
      ).map((commentBox, index) => {
        if (!commentBox) return null;
        const { r, c, rc, left, top, size } = commentBox;
        const isEditing = context.editingCommentBox?.rc === rc;
        const isHover = !isEditing && context.hoveredCommentBox?.rc === rc;
        const commentId = `comment-box-${rc}`;
        return (
          <div key={rc + index}>
            <canvas
              id={`arrowCanvas-${rc}`}
              className="arrowCanvas"
              width={size.width}
              height={size.height}
              style={{
                position: 'absolute',
                left: size.left,
                top: size.top,
                zIndex: 400,
                pointerEvents: 'none',
              }}
            />
            <div
              id={commentId}
              style={{
                position: 'absolute',
                left: left - 17,
                top,
                zIndex: isEditing ? 500 : 400,
                boxShadow: '0 1px 1px #0000002e,0 4px 8px #0000001a',
                borderRadius: '4px',
              }}
              onMouseDown={(e) => {
                e.stopPropagation();
              }}
            >
              <div
                style={{
                  width: '100%',
                  overflow: 'visible',
                }}
              >
                {settings.getCommentCellUI?.(
                  r,
                  c,
                  handleMouseDownEvent(r, c, rc, commentId),
                  isHover,
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default NotationBoxes;
