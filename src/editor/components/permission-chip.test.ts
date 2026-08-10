import { describe, expect, it, vi } from 'vitest';
import React, { type ReactElement, type ReactNode } from 'react';

vi.mock('@fileverse/ui', () => ({
  DynamicDropdown: () => null,
  LucideIcon: () => null,
}));

import {
  canShowCommentSignIn,
  canShowEditElevation,
  canShowViewerModeMenu,
  getPermissionChipConfig,
  resolvePermissionChipMode,
} from './permission-chip-model';
import { PermissionChip } from './permission-chip';

const findByTestId = (
  node: ReactNode,
  testId: string,
): ReactElement<Record<string, unknown>> | undefined => {
  if (!React.isValidElement(node)) return undefined;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.props['data-testid'] === testId) return element;
  return React.Children.toArray(element.props.children as any).reduce<
    ReactElement<Record<string, unknown>> | undefined
  >((match, child) => match ?? findByTestId(child, testId), undefined);
};

describe('PermissionChip', () => {
  it('defines the package-owned edit presentation', () => {
    expect(getPermissionChipConfig('edit')).toEqual({
      icon: 'Pencil',
      label: 'Edit',
      modifier: 'edit',
    });
  });

  it.each(['view', 'comment'] as const)(
    'offers edit elevation from %s when the host supplies a callback',
    (mode) => {
      expect(canShowEditElevation({ mode, onEnterEdit: () => {} })).toBe(true);
    },
  );

  it('keeps the chip static without elevation or when already editing', () => {
    expect(canShowEditElevation({ mode: 'view' })).toBe(false);
    expect(canShowEditElevation({ mode: 'edit', onEnterEdit: () => {} })).toBe(
      false,
    );
  });

  it('offers the viewer mode menu when the host supplies a mode callback', () => {
    expect(
      canShowViewerModeMenu({
        mode: 'comment',
        onViewerModeChange: () => {},
      }),
    ).toBe(true);
    expect(canShowViewerModeMenu({ mode: 'view' })).toBe(false);
    expect(
      canShowViewerModeMenu({ mode: 'edit', onViewerModeChange: () => {} }),
    ).toBe(false);
  });

  it('offers direct comment sign-in only from a plain view chip', () => {
    const onSignInToComment = () => {};
    expect(canShowCommentSignIn({ mode: 'view', onSignInToComment })).toBe(
      true,
    );
    expect(
      canShowCommentSignIn({
        mode: 'view',
        onEnterEdit: () => {},
        onSignInToComment,
      }),
    ).toBe(false);
    expect(
      canShowCommentSignIn({
        mode: 'view',
        onSignInToComment,
        onViewerModeChange: () => {},
      }),
    ).toBe(false);
    expect(canShowCommentSignIn({ mode: 'comment', onSignInToComment })).toBe(
      false,
    );
  });

  it('invokes comment sign-in from the permission chip', () => {
    let signInCount = 0;
    const chip = PermissionChip({
      mode: 'view',
      onSignInToComment: () => {
        signInCount += 1;
      },
    }) as ReactElement<{ onClick: () => void }>;

    chip.props.onClick();

    expect(signInCount).toBe(1);
  });

  it.each(['comment', 'view'] as const)(
    'emits %s from the viewer mode menu',
    (mode) => {
      let selectedMode: 'comment' | 'view' | undefined;
      const chip = PermissionChip({
        mode: mode === 'comment' ? 'view' : 'comment',
        onViewerModeChange: (nextMode) => {
          selectedMode = nextMode;
        },
      }) as ReactElement<{ content: ReactNode }>;
      const option = findByTestId(
        chip.props.content,
        `permission-chip-${mode}-option`,
      );

      (option?.props.onClick as () => void)();

      expect(selectedMode).toBe(mode);
    },
  );

  it('keeps the existing edit action in the dropdown', () => {
    let editCount = 0;
    const chip = PermissionChip({
      mode: 'view',
      onEnterEdit: () => {
        editCount += 1;
      },
    }) as ReactElement<{ content: ReactNode }>;
    const option = findByTestId(
      chip.props.content,
      'permission-chip-edit-option',
    );

    (option?.props.onClick as () => void)();

    expect(editCount).toBe(1);
  });

  it.each([
    {
      name: 'explicit edit while RTC temporarily gates writes',
      input: {
        allowComments: true,
        isReadOnly: true,
        permissionMode: 'edit' as const,
      },
      expected: 'edit',
    },
    {
      name: 'explicit edit after RTC enables writes',
      input: {
        allowComments: true,
        isReadOnly: false,
        permissionMode: 'edit' as const,
      },
      expected: 'edit',
    },
    {
      name: 'legacy read-only commenter',
      input: { allowComments: true, isReadOnly: true },
      expected: 'comment',
    },
    {
      name: 'legacy read-only viewer',
      input: { allowComments: false, isReadOnly: true },
      expected: 'view',
    },
    {
      name: 'legacy writable owner',
      input: { allowComments: true, isReadOnly: false },
      expected: null,
    },
  ])('resolves $name', ({ input, expected }) => {
    expect(resolvePermissionChipMode(input)).toBe(expected);
  });
});
