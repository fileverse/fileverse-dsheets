import React from 'react';
import { DynamicDropdown, LucideIcon } from '@fileverse/ui';
import type { DSheetPermissionMode } from '../types';
import {
  canShowCommentSignIn,
  canShowEditElevation,
  canShowViewerModeMenu,
  getPermissionChipConfig,
} from './permission-chip-model';

interface PermissionChipProps {
  mode: DSheetPermissionMode;
  onEnterEdit?: () => void;
  onSignInToComment?: () => void;
  onViewerModeChange?: (mode: 'comment' | 'view') => void;
}

export const PermissionChip: React.FC<PermissionChipProps> = ({
  mode,
  onEnterEdit,
  onSignInToComment,
  onViewerModeChange,
}) => {
  const { icon, label, modifier } = getPermissionChipConfig(mode);
  const chipClassName = `dsheet-chip dsheet-chip--${modifier} inline-flex items-center py-1 gap-1 px-2 bg-yellow-100 rounded-full`;
  const canEnterEdit = canShowEditElevation({ mode, onEnterEdit });
  const canSwitchViewerMode = canShowViewerModeMenu({
    mode,
    onViewerModeChange,
  });
  const canSignInToComment = canShowCommentSignIn({
    mode,
    onEnterEdit,
    onSignInToComment,
    onViewerModeChange,
  });

  const chipContent = (
    <>
      <LucideIcon name={icon} className="w-4 h-4 color-text-default" />
      <span
        className="dsheet-text dsheet-text--chip text-xs color-text-default"
        data-testid="permission-chip-label"
      >
        {label}
      </span>
    </>
  );

  if (canEnterEdit || canSwitchViewerMode) {
    return (
      <DynamicDropdown
        align="end"
        sideOffset={6}
        anchorTrigger={
          <button
            type="button"
            className={chipClassName}
            data-testid="permission-chip"
            aria-label={
              canSwitchViewerMode
                ? 'Switch viewer mode'
                : `${label}. Edit access available`
            }
          >
            {chipContent}
            <LucideIcon
              name="ChevronDown"
              className="w-4 h-4 color-text-default"
            />
          </button>
        }
        content={
          <div className="flex flex-col gap-1 p-2 w-[280px] shadow-elevation-3">
            {canEnterEdit && (
              <button
                type="button"
                className="flex items-start gap-3 px-3 py-2 rounded-md text-left hover:color-bg-default-hover transition-colors"
                data-testid="permission-chip-edit-option"
                onClick={onEnterEdit}
              >
                <LucideIcon
                  name="SquarePen"
                  size="md"
                  className="mt-0.5 shrink-0 color-text-default"
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-body-sm-bold color-text-default">
                    Edit
                  </span>
                  <span className="block text-helper-text-sm color-text-secondary">
                    Make changes directly
                  </span>
                </span>
              </button>
            )}
            {canSwitchViewerMode && (
              <>
                <button
                  type="button"
                  className="flex items-start gap-3 px-3 py-2 rounded-md text-left hover:color-bg-default-hover transition-colors"
                  data-testid="permission-chip-comment-option"
                  aria-pressed={mode === 'comment'}
                  onClick={() => onViewerModeChange?.('comment')}
                >
                  <LucideIcon
                    name="MessageSquareText"
                    size="md"
                    className="mt-0.5 shrink-0 color-text-default"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-body-sm-bold color-text-default">
                      View and comment
                    </span>
                  </span>
                  {mode === 'comment' && (
                    <LucideIcon name="Check" size="sm" />
                  )}
                </button>
                <button
                  type="button"
                  className="flex items-start gap-3 px-3 py-2 rounded-md text-left hover:color-bg-default-hover transition-colors"
                  data-testid="permission-chip-view-option"
                  aria-pressed={mode === 'view'}
                  onClick={() => onViewerModeChange?.('view')}
                >
                  <LucideIcon
                    name="Eye"
                    size="md"
                    className="mt-0.5 shrink-0 color-text-default"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-body-sm-bold color-text-default">
                      View only
                    </span>
                  </span>
                  {mode === 'view' && <LucideIcon name="Check" size="sm" />}
                </button>
              </>
            )}
          </div>
        }
      />
    );
  }

  if (canSignInToComment) {
    return (
      <button
        type="button"
        className={chipClassName}
        data-testid="permission-chip"
        aria-label="Sign in to comment"
        onClick={onSignInToComment}
      >
        <LucideIcon
          name="MessageSquareText"
          className="w-4 h-4 color-text-default"
        />
        <span
          className="dsheet-text dsheet-text--chip text-xs color-text-default"
          data-testid="permission-chip-label"
        >
          Sign in to comment
        </span>
      </button>
    );
  }

  return (
    <div className={chipClassName} data-testid="permission-chip" role="status">
      {chipContent}
    </div>
  );
};
