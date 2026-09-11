import { IconButton } from '@fileverse/ui';
import { ReactNode } from 'react';
import { RightSidebar, RightSidebarHeader } from './right-sidebar';

export interface ActivePanelConfig {
  id: string;
  width: string;
  header: { title: string; subtitle?: string };
  content: ReactNode;
}

interface EditorRightSidebarProps {
  isOpen: boolean;
  activePanelConfig: ActivePanelConfig | null;
  onClose: () => void;
  /** Read/preview mode hides the toolbar, so the sidebar starts higher. */
  isReadOnly?: boolean;
}

export const EditorRightSidebar = ({
  isOpen,
  activePanelConfig,
  onClose,
  isReadOnly = false,
}: EditorRightSidebarProps) => {
  const top = isReadOnly ? '44px' : '83px';
  const height = isReadOnly
    ? 'calc(100vh - 44px - 27px)'
    : 'calc(100vh - 83px - 37px)';

  return (
    <RightSidebar
      width={activePanelConfig?.width}
      isOpen={isOpen}
      top={top}
      height={height}
    >
      <RightSidebarHeader>
        <div className="flex items-center justify-between">
          <h2 className="text-heading-sm leading-[22px]">
            {activePanelConfig?.header.title}
          </h2>
          <IconButton
            variant="ghost"
            icon="X"
            size="sm"
            onClick={onClose}
            aria-label={`Close ${activePanelConfig?.header.title ?? ''} panel`}
          />
        </div>
      </RightSidebarHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activePanelConfig?.content}
      </div>
    </RightSidebar>
  );
};
