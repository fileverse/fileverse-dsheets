const NAVBAR_HEIGHT = 44;
const TOOLBAR_HEIGHT = 39;

/**
 * Right sidebar position below the editor chrome. Read/preview mode keeps
 * its existing offsets (the sidebar overlays the toolbar there).
 */
export const getRightSidebarOffsets = ({
  isReadOnly = false,
  showNavbar = true,
  showToolbar = true,
}: {
  isReadOnly?: boolean;
  showNavbar?: boolean;
  showToolbar?: boolean;
}): { top: string; height: string } => {
  const topPx =
    (showNavbar ? NAVBAR_HEIGHT : 0) +
    (!isReadOnly && showToolbar ? TOOLBAR_HEIGHT : 0);
  const bottomPx = isReadOnly ? 27 : 37;

  return {
    top: `${topPx}px`,
    height: `calc(100vh - ${topPx}px - ${bottomPx}px)`,
  };
};
