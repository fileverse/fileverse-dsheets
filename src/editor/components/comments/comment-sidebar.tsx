// components/CommentsContent.tsx
import React, { useCallback } from 'react';
import { Avatar, Button, DynamicDropdown, LucideIcon, cn } from '@fileverse/ui';
import { CommentsContentProps, CommentThread } from '../../types/comments';
import { CommentItem } from './comment-item';
import { CommentInput } from './comment-input';
import {
  parseCellKey,
  generateWithoutCellKey,
  getCellReference,
} from '../../utils/comment-key-utils';
import {
  activateSheetById,
  activateSheetByOrder,
  buildSheetIdNameMap,
  getCurrentSheetSafe,
  isWorkbookReady,
} from '../../utils/sheet-editor-safe';
import { useEnsStatus } from './ens/use-ens-status';

function isElementInView(container: Element, element: Element): boolean {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  return (
    elementRect.top >= containerRect.top &&
    elementRect.left >= containerRect.left &&
    elementRect.bottom <= containerRect.bottom &&
    elementRect.right <= containerRect.right
  );
}

// Component for displaying user name with ENS support
const UserDisplayName: React.FC<{ userName?: string }> = ({ userName }) => {
  const { name: displayName, isEns } = useEnsStatus(userName);
  const isWalletAddress = /^0x[a-fA-F0-9]{40}$/.test(displayName);
  const visibleName = isWalletAddress
    ? `${displayName.slice(0, 5)}...${displayName.slice(-4)}`
    : displayName;

  return (
    <>
      <span className="min-w-0 truncate" title={displayName}>
        {visibleName}
      </span>
      {isEns && (
        <div title="Verified ENS name" className="flex shrink-0 items-center">
          <LucideIcon name="BadgeCheck" size="sm" className="text-blue-500" />
        </div>
      )}
    </>
  );
};

// Helper to extract sheet info from comment key.
// sheetNames is keyed by both sheet.id (UUID) and String(sheet.order) so a
// single lookup resolves both new UUID-based and legacy order-based keys.
const getSheetInfo = (
  key: string,
  sheetNames?: Map<string, string>,
): { sheetId: string; displayName: string } | null => {
  if (key.includes('WITHOUT')) return null;

  const parts = key.split('_');
  if (parts.length >= 2) {
    const sheetId = parts[0]; // UUID or numeric-order string
    const actualName = sheetNames?.get(sheetId);
    const legacyNum = Number(sheetId);
    const fallback = !isNaN(legacyNum)
      ? `Sheet ${legacyNum + 1}`
      : `Sheet ${sheetId}`;
    return { sheetId, displayName: actualName || fallback };
  }

  return null;
};

type TypeFilter = 'all' | 'open' | 'resolved';
type SheetFilter = 'all' | 'current';

const TYPE_LABELS: Record<TypeFilter, string> = {
  all: 'All Types',
  open: 'Open',
  resolved: 'Resolved',
};

const SHEET_LABELS: Record<SheetFilter, string> = {
  all: 'All Sheets',
  current: 'This Sheet',
};

const TYPE_OPTIONS: TypeFilter[] = ['all', 'open', 'resolved'];
const SHEET_OPTIONS: SheetFilter[] = ['all', 'current'];

export const CommentsContent: React.FC<CommentsContentProps> = ({
  sheetEditorRef,
  userName,
  commentsData,
  onSendComment,
  onCommentAction,
  ownerAddress,
  currentUserAddress,
  isOwner,
  disabled = false,
  isAuthenticated = true,
  unauthenticatedFallback,
}) => {
  const [selectedComment, setSelectedComment] = React.useState<string | null>(
    null,
  );

  const [typeFilter, setTypeFilter] = React.useState<TypeFilter>('all');
  const [sheetFilter, setSheetFilter] = React.useState<SheetFilter>('all');

  // Combined map keyed by both sheet.id (UUID) and String(sheet.order) so
  // getSheetInfo resolves both new UUID-based and legacy order-based comment keys.
  const [sheetNames, setSheetNames] = React.useState<Map<string, string>>(
    new Map(),
  );

  // When disabled (e.g. during real-time collaboration), comments are visible
  // but read-only: input + actions are blocked.
  const enableCollaboration = disabled;

  React.useEffect(() => {
    try {
      setSheetNames(buildSheetIdNameMap(sheetEditorRef));
    } catch {
      setSheetNames(new Map());
    }
  }, [sheetEditorRef, commentsData]); // Re-run when comments change (might indicate sheet changes)

  // When the workbook isn't ready yet (viewer loads comments before the sheet
  // engine initialises), poll until getAllSheets returns data then rebuild the map.
  React.useEffect(() => {
    if (isWorkbookReady(sheetEditorRef)) return;

    const interval = setInterval(() => {
      if (isWorkbookReady(sheetEditorRef)) {
        try {
          setSheetNames(buildSheetIdNameMap(sheetEditorRef));
        } catch {
          // ignore
        }
        clearInterval(interval);
      }
    }, 300);

    return () => clearInterval(interval);
  }, [sheetEditorRef, commentsData]);

  const filteredComments = React.useMemo(() => {
    const currentSheet = getCurrentSheetSafe(sheetEditorRef);
    // Accept both the immutable UUID and the legacy numeric-order string so
    // existing comments still match after a partial migration.
    const currentSheetId = currentSheet?.id ?? '';
    const currentSheetOrderStr = String(
      typeof currentSheet?.order === 'number' ? currentSheet.order : 0,
    );

    return Object.fromEntries(
      Object.entries(commentsData).filter(([key, comment]) => {
        if (!comment || comment.isDeleted) return false;

        if (typeFilter === 'open' && comment.isResolved) return false;
        if (typeFilter === 'resolved' && !comment.isResolved) return false;

        if (sheetFilter === 'current') {
          if (key.includes('WITHOUT')) return true;
          const sheetInfo = getSheetInfo(key, sheetNames);
          if (!sheetInfo) return true;
          return (
            sheetInfo.sheetId === currentSheetId ||
            sheetInfo.sheetId === currentSheetOrderStr
          );
        }
        return true;
      }),
    );
  }, [commentsData, typeFilter, sheetFilter, sheetNames, sheetEditorRef]);

  const handleNavigateToCell = useCallback(
    (row: number, col: number) => {
      sheetEditorRef.current?.setSelection([{ row: [row], column: [col] }]);

      setTimeout(() => {
        const container =
          document.getElementsByClassName('fortune-row-body')[0];
        const child = document.getElementsByClassName(
          'luckysheet-input-box',
        )[0];
        if (container && child && !isElementInView(container, child)) {
          sheetEditorRef.current?.scroll({ targetRow: row, targetColumn: col });
        }
      }, 10);
    },
    [sheetEditorRef],
  );

  const [isCommentClick, setIsCommentClick] = React.useState(new Set<string>());

  const handleCommentClick = useCallback(
    (key: string) => {
      setIsCommentClick((prev) => {
        const newSet = new Set(prev);
        if (!newSet.has(key)) {
          newSet.add(key);
        }
        return newSet;
      });
      const cellPosition = parseCellKey(key);
      if (!cellPosition || !sheetEditorRef?.current) return;

      try {
        const editor = sheetEditorRef.current as {
          openCommentUI?: (row: number, col: number) => void;
        };
        const currentSheet = getCurrentSheetSafe(sheetEditorRef);
        const currentSheetId = currentSheet?.id ?? '';
        const currentSheetOrderStr = String(
          typeof currentSheet?.order === 'number' ? currentSheet.order : 0,
        );

        const targetSheetId = cellPosition.sheetId ?? '0';
        const targetAsOrder = Number(targetSheetId);
        const isLegacyKey = !isNaN(targetAsOrder);

        const needsSheetSwitch =
          targetSheetId !== currentSheetId &&
          targetSheetId !== currentSheetOrderStr;

        if (needsSheetSwitch) {
          const switched = isLegacyKey
            ? activateSheetByOrder(sheetEditorRef, targetAsOrder)
            : activateSheetById(sheetEditorRef, targetSheetId);
          setTimeout(() => {
            handleNavigateToCell(cellPosition.row, cellPosition.col);
            if (switched) {
              editor.openCommentUI?.(cellPosition.row, cellPosition.col);
            }
          }, 100);
          return;
        }

        handleNavigateToCell(cellPosition.row, cellPosition.col);
        editor.openCommentUI?.(cellPosition.row, cellPosition.col);
      } catch {
        if (cellPosition) {
          handleNavigateToCell(cellPosition.row, cellPosition.col);
        }
      }
    },
    [handleNavigateToCell, sheetEditorRef],
  );

  const handleReplyClick = useCallback(
    (key: string) => {
      setSelectedComment(selectedComment === key ? null : key);
    },
    [selectedComment],
  );

  const handleSendReply = useCallback(
    (key: string) => (textareaId: string) => {
      onSendComment(key, textareaId);
      setSelectedComment(null);
    },
    [onSendComment],
  );

  const handleSendNewComment = useCallback(() => {
    const newKey = generateWithoutCellKey(Object.keys(commentsData).length);
    onSendComment(newKey, 'sidebar-comment-add');
  }, [commentsData, onSendComment]);

  const [isHovered, setIsHovered] = React.useState(new Set<string>());

  const handleHover = (key: string) => {
    setIsHovered((prev) => {
      const newSet = new Set(prev);
      if (!newSet.has(key)) {
        newSet.add(key);
      }
      return newSet;
    });
  };

  if (!isAuthenticated) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        {unauthenticatedFallback ?? null}
      </div>
    );
  }

  return (
    <div>
      {/* Filter Bar */}
      <div className="flex items-center gap-2 px-2 py-2 border-b color-border-default">
        <DynamicDropdown
          align="start"
          sideOffset={4}
          className="shadow-lg rounded-lg p-1 border"
          anchorTrigger={
            <Button
              variant="ghost"
              size="md"
              className="gap-1 h-7 px-2 min-w-0"
            >
              <span className="text-xs">{TYPE_LABELS[typeFilter]}</span>
              <LucideIcon name="ChevronDown" size="sm" />
            </Button>
          }
          content={
            <div className="flex flex-col min-w-[140px]">
              {TYPE_OPTIONS.map((v) => (
                <Button
                  key={v}
                  variant="ghost"
                  onClick={() => setTypeFilter(v)}
                  className="justify-start w-full gap-2 px-3 py-2 text-sm"
                >
                  {TYPE_LABELS[v]}
                  {typeFilter === v && <LucideIcon name="Check" size="sm" />}
                </Button>
              ))}
            </div>
          }
        />
        <DynamicDropdown
          align="start"
          sideOffset={4}
          className="shadow-lg rounded-lg p-1 border"
          anchorTrigger={
            <Button
              variant="ghost"
              size="md"
              className="gap-1 h-7 px-2 min-w-0"
            >
              <span className="text-xs">{SHEET_LABELS[sheetFilter]}</span>
              <LucideIcon name="ChevronDown" size="sm" />
            </Button>
          }
          content={
            <div className="flex flex-col min-w-[140px]">
              {SHEET_OPTIONS.map((v) => (
                <Button
                  key={v}
                  variant="ghost"
                  onClick={() => setSheetFilter(v)}
                  className="justify-start w-full gap-2 px-3 py-2 text-sm"
                >
                  {SHEET_LABELS[v]}
                  {sheetFilter === v && <LucideIcon name="Check" size="sm" />}
                </Button>
              ))}
            </div>
          }
        />
      </div>

      {/* Comments List */}
      <div className="flex flex-col h-[calc(100vh-445px)] overflow-y-auto no-scrollbar">
        {Object.entries(filteredComments)
          .sort(([, a], [, b]) => {
            const dateA = new Date(a?.createdAt ?? '').getTime();
            const dateB = new Date(b?.createdAt ?? '').getTime();
            return dateB - dateA; // Newest first
          })
          .map(([key, comment]) => {
            const sheetInfo = getSheetInfo(key, sheetNames);
            const cellPosition = parseCellKey(key);

            // Get cell reference like "C5" if we have valid position
            const cellReference = cellPosition
              ? getCellReference(cellPosition.row, cellPosition.col)
              : undefined;

            return (
              <div
                key={key}
                className={`cursor-pointer border-b color-border-default gap-2xsm hover:bg-[hsl(var(--color-bg-secondary))] transition-colors space-y-lg space-x-lg duration-300 ease-in-out ${selectedComment === key && 'color-bg-secondary'} ${enableCollaboration && '!cursor-not-allowed !pointer-events-none'}`}
                onClick={() => handleCommentClick(key)}
                onMouseOver={() => handleHover(key)}
                onMouseOut={() =>
                  setIsHovered((prev) => {
                    const newSet = new Set(prev);
                    newSet.delete(key);
                    return newSet;
                  })
                }
              >
                <CommentItem
                  comment={comment as CommentThread}
                  sheetName={sheetInfo?.displayName}
                  cellReference={cellReference}
                  onAction={disabled ? undefined : onCommentAction}
                  ownerAddress={ownerAddress}
                  currentUserAddress={currentUserAddress}
                  isOwner={isOwner}
                  isHovered={isHovered.has(key)}
                  currentUserName={userName}
                  row={cellPosition?.row}
                  col={cellPosition?.col}
                  contentClassName={
                    isCommentClick.has(key) || comment.replies.length > 0
                      ? 'bottom-space-sm'
                      : ''
                  }
                />

                {/* Reply Section */}
                {selectedComment === key ? (
                  <div className="pl-[32px]">
                    {comment.isResolved ? (
                      <div className="mt-3 p-3 color-bg-secondary border color-border-default rounded-lg">
                        <div className="flex items-center gap-2 text-sm color-text-secondary">
                          <LucideIcon name="CheckCircle" size="sm" />
                          <span>
                            This thread has been resolved. No new replies can be
                            added.
                          </span>
                        </div>
                      </div>
                    ) : (
                      <CommentInput
                        id="sidebar-comment-edit"
                        onSend={handleSendReply(key)}
                        autoFocus
                        backgroundColor="white"
                      />
                    )}
                  </div>
                ) : comment.replies.length <= 0 ? (
                  <div className="pl-[32px]">
                    {isCommentClick.has(key) && !comment.isResolved && (
                      <CommentInput
                        id="sidebar-comment-edit"
                        onSend={handleSendReply(key)}
                        onBlur={() =>
                          setIsCommentClick(() => {
                            const newSet = new Set(isCommentClick);
                            newSet.delete(key);
                            return newSet;
                          })
                        }
                        cancelComment={() => {
                          setTimeout(() => {
                            setIsCommentClick(() => {
                              const newSet = new Set(isCommentClick);
                              newSet.delete(key);
                              return newSet;
                            });
                          }, 10); // Delay to allow click event to propagate (TODO: find better solution)
                        }}
                        backgroundColor="white"
                      />
                    )}
                  </div>
                ) : (
                  !comment.isResolved &&
                  comment.replies.length > 0 && (
                    <Button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReplyClick(key);
                      }}
                      className={cn(
                        'w-full flex items-center justify-start gap-3 !pb-0 !py-0 hover:!bg-transparent px-9',
                      )}
                      variant="ghost"
                    >
                      <LucideIcon
                        name="MessageSquarePlus"
                        className="color-text-secondary"
                        size="sm"
                      />
                      <span className="text-xs font-medium">
                        Reply to this thread
                      </span>
                    </Button>
                  )
                )}
              </div>
            );
          })}
      </div>

      {/* New Comment Section */}
      <div className="border-t p-2 space-lg">
        <div className="flex min-w-0 items-center justify-start gap-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center">
            <Avatar key={userName} size="md" content="text" alt={userName} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col p-2">
            <span className="text-body-sm-bold force-font inline-flex min-w-0 items-center gap-1">
              <UserDisplayName userName={userName} />
            </span>
          </div>
        </div>

        <CommentInput
          id="sidebar-comment-add"
          onSend={handleSendNewComment}
          placeholder={
            enableCollaboration
              ? 'Comments are not available during Real-Time Collaboration'
              : 'Add a new comment'
          }
          disabled={enableCollaboration}
          autoFocus={!enableCollaboration}
          backgroundColor="white"
          isStaticButton={true}
          removeCancelButton={true}
          className="mt-2"
        />
      </div>
    </div>
  );
};
