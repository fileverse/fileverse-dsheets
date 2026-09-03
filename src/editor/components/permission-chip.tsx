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
  const chipClassName = `dsheet-chip dsheet-chip--${modifier} inline-flex items-center gap-1.5 px-2 py-1.5 rounded-md color-bg-brand-light color-text-on-brand text-xs font-medium whitespace-nowrap`;
  const interactiveChipClassName = `${chipClassName} hover:opacity-90 transition-opacity`;
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
      <LucideIcon name={icon} size="sm" />
      <span
        className="dsheet-text dsheet-text--chip"
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
            className={interactiveChipClassName}
            data-testid="permission-chip"
            aria-label={`Switch spreadsheet mode. Current mode: ${label}`}
          >
            {chipContent}
            <LucideIcon name="ChevronDown" size="sm" />
          </button>
        }
        content={
          <div className="flex w-[260px] flex-col gap-1 p-2 shadow-elevation-3">
            {onEnterEdit && (
              <button
                type="button"
                aria-pressed={mode === 'edit'}
                className={`flex items-center gap-2 rounded-md p-2 text-left transition-colors hover:color-bg-default-hover ${
                  mode === 'edit' ? 'color-bg-default-hover' : ''
                }`}
                data-testid="permission-chip-edit-option"
                onClick={onEnterEdit}
              >
                <LucideIcon
                  name="Pencil"
                  size="sm"
                  className="shrink-0 color-text-default"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-body-sm color-text-default">
                    Edit
                  </span>
                  <span className="block text-helper-text-sm color-text-secondary">
                    Edit spreadsheet
                  </span>
                </span>
                {mode === 'edit' && (
                  <LucideIcon
                    name="Check"
                    size="sm"
                    className="shrink-0 color-text-default"
                  />
                )}
              </button>
            )}
            {canSwitchViewerMode && (
              <>
                <button
                  type="button"
                  className={`flex items-center gap-2 rounded-md p-2 text-left transition-colors hover:color-bg-default-hover ${
                    mode === 'comment' ? 'color-bg-default-hover' : ''
                  }`}
                  data-testid="permission-chip-comment-option"
                  aria-pressed={mode === 'comment'}
                  onClick={() => onViewerModeChange?.('comment')}
                >
                  <LucideIcon
                    name="MessageSquareText"
                    size="sm"
                    className="shrink-0 color-text-default"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body-sm color-text-default">
                      View and comment
                    </span>
                    <span className="block text-helper-text-sm color-text-secondary">
                      View and add comments
                    </span>
                  </span>
                  {mode === 'comment' && (
                    <LucideIcon
                      name="Check"
                      size="sm"
                      className="shrink-0 color-text-default"
                    />
                  )}
                </button>
                <button
                  type="button"
                  className={`flex items-center gap-2 rounded-md p-2 text-left transition-colors hover:color-bg-default-hover ${
                    mode === 'view' ? 'color-bg-default-hover' : ''
                  }`}
                  data-testid="permission-chip-view-option"
                  aria-pressed={mode === 'view'}
                  onClick={() => onViewerModeChange?.('view')}
                >
                  <LucideIcon
                    name="Eye"
                    size="sm"
                    className="shrink-0 color-text-default"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body-sm color-text-default">
                      View only
                    </span>
                    <span className="block text-helper-text-sm color-text-secondary">
                      View this spreadsheet, distraction-free
                    </span>
                  </span>
                  {mode === 'view' && (
                    <LucideIcon
                      name="Check"
                      size="sm"
                      className="shrink-0 color-text-default"
                    />
                  )}
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
        className={interactiveChipClassName}
        data-testid="permission-chip"
        aria-label="Sign in to comment"
        onClick={onSignInToComment}
      >
        <LucideIcon name="MessageSquareText" size="sm" />
        <span
          className="dsheet-text dsheet-text--chip"
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
