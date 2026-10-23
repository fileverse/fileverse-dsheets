import { describe, expect, it } from 'vitest';
import { getRightSidebarOffsets } from './sidebar-offsets';

describe('getRightSidebarOffsets', () => {
  it('keeps the existing offsets when all chrome is shown', () => {
    expect(getRightSidebarOffsets({})).toEqual({
      top: '83px',
      height: 'calc(100vh - 83px - 37px)',
    });
    expect(getRightSidebarOffsets({ isReadOnly: true })).toEqual({
      top: '44px',
      height: 'calc(100vh - 44px - 27px)',
    });
  });

  it('drops the navbar height when the navbar is hidden', () => {
    expect(getRightSidebarOffsets({ showNavbar: false })).toEqual({
      top: '39px',
      height: 'calc(100vh - 39px - 37px)',
    });
    expect(
      getRightSidebarOffsets({ isReadOnly: true, showNavbar: false }),
    ).toEqual({
      top: '0px',
      height: 'calc(100vh - 0px - 27px)',
    });
  });

  it('drops the toolbar height when the toolbar is hidden', () => {
    expect(getRightSidebarOffsets({ showToolbar: false })).toEqual({
      top: '44px',
      height: 'calc(100vh - 44px - 37px)',
    });
    expect(
      getRightSidebarOffsets({ showNavbar: false, showToolbar: false }),
    ).toEqual({
      top: '0px',
      height: 'calc(100vh - 0px - 37px)',
    });
  });
});
