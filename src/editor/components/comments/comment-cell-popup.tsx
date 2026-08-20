// components/CommentCellUI.tsx
import React, { useState } from 'react';
import { CommentCellUIProps } from '../../types/comments';
import { CommentInput } from './comment-input';
import { CommentItem } from './comment-item';
import { useCommentCell } from './use-comment-cell-popup';
import { LucideIcon } from '@fileverse/ui';
import { CommentActionsDropdown } from './comment-actions-dropdown';

export const CommentCellUI: React.FC<CommentCellUIProps> = ({
  row,
  col,
  sheetId,
  comment,
  onSendComment,
  onAction,
  ownerAddress,
  currentUserAddress,
  isOwner,
  currentUserName,
  removeCommentFromCell,
  closePopup,
  dragHandler,
  isHover = false,
  disabled = false,
  isAuthenticated = true,
  unauthenticatedFallback,
}) => {
  const [isCommentHovered, setIsCommentHovered] = useState(false);
  const cellKey = `${sheetId}_${row}_${col}`;
  const textareaId = 'comment-edit';

  const { handleSend, handleKeyDown, handleDoubleClick, handleScroll } =
    useCommentCell({
      cellKey,
      onSendComment,
    });

  const cancelComment = () => {
    if (comment) return;

    removeCommentFromCell(row, col);
  };

  // No comment yet — nothing to show in read-only mode (can't add one).
  if (!comment && disabled) {
    return null;
  }

  // No comment yet — join/login before composing.
  if (!comment && !isAuthenticated) {
    return <>{unauthenticatedFallback ?? null}</>;
  }

  // No comment yet — always show the input regardless of hover/click,
  // since there's nothing else to display.
  if (!comment) {
    return (
      <div className="flex flex-col w-[298px] color-bg-secondary border-radius-sm  space-sm">
        <CommentInput
          id={textareaId}
          placeholder="Type your comment"
          onSend={handleSend}
          inCellComment={true}
          isStaticButton
          cancelComment={cancelComment}
          focusTrap
        />
      </div>
    );
  }

  function hasParentWithId(target: HTMLElement | null, id: string): boolean {
    let current = target;

    while (current) {
      if (current.id === id) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  const handler = (e: WheelEvent) => {
    if (hasParentWithId(e.target as HTMLElement, 'comment-scroll')) {
      e.stopImmediatePropagation();
    }
  };

  return (
    <div
      className="flex w-[298px] color-bg-default border-radius-sm border overflow-hidden flex-col comment-cell"
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => {
        const con = document.getElementsByClassName(
          'comment-cell',
        )[0] as HTMLDivElement;
        con?.addEventListener('wheel', handler, { capture: true });
      }}
    >
      {/* Header */}
      <div
        onMouseOver={() => setIsCommentHovered(true)}
        onMouseOut={() => setIsCommentHovered(false)}
        className="color-bg-default space-y-xsm space-x-sm flex justify-between rounded-t- items-center border-b color-border-default"
        onMouseDown={dragHandler}
      >
        <p className="text-sm font-medium color-text-default">Comments</p>
        <div className="min-h-[26px]">
          {onAction && isCommentHovered && !disabled && isAuthenticated && (
            <CommentActionsDropdown
              comment={comment}
              onAction={(action) => {
                onAction(action);
              }}
              isReply={false}
              ownerAddress={ownerAddress}
              currentUserAddress={currentUserAddress}
              isOwner={isOwner}
              currentUserName={currentUserName}
              dsheetId={comment.dsheetId}
              commentKey={comment.key}
              row={row}
              col={col}
            />
          )}
        </div>
      </div>

      <div
        className="max-h-[350px] overflow-y-auto space-sm no-scrollbar comment-scroll "
        id="comment-scroll"
        onScroll={handleScroll}
      >
        <CommentItem
          comment={comment}
          isHovered={true}
          onAction={disabled || !isAuthenticated ? undefined : onAction}
          ownerAddress={ownerAddress}
          currentUserAddress={currentUserAddress}
          isOwner={isOwner}
          currentUserName={currentUserName}
          contentClassName={comment.replies.length > 0 ? 'bottom-space-sm' : ''}
          isCellPopup={true}
          shouldShowActions={false}
          row={row}
          col={col}
        />
      </div>

      {/* Input Section — hidden on hover, shown only when the popup is pinned (clicked) */}
      {!isHover &&
        (disabled ? (
          <div className="space-sm color-bg-secondary">
            <div className="flex items-center gap-1 text-sm color-text-secondary">
              <LucideIcon name="Info" size="sm" />
              <span>
                Comments are not available during Real-Time Collaboration
              </span>
            </div>
          </div>
        ) : !isAuthenticated ? (
          <div className="space-sm color-bg-secondary">
            {unauthenticatedFallback ?? null}
          </div>
        ) : comment.isResolved ? (
          <div className="space-sm color-bg-secondary">
            <div className="flex items-center text-sm color-text-secondary">
              <LucideIcon name="CheckCircle" size="sm" />
              <span>
                This thread has been resolved. No new replies can be added.
              </span>
            </div>
          </div>
        ) : (
          <div className="space-sm color-bg-secondary">
            <CommentInput
              id={textareaId}
              onSend={handleSend}
              autoFocus
              isStaticButton
              cancelComment={() => {
                // Thread exists — don't delete the cell. Just close the popup,
                // same as pressing Escape.
                closePopup?.();
              }}
              focusTrap
            />
          </div>
        ))}
    </div>
  );
};
