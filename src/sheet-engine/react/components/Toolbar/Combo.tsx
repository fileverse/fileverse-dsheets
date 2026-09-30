import React, { CSSProperties, useMemo, useRef, useState } from 'react';
import {
  IconButton,
  Tooltip,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
  Button,
  LucideIcon,
} from '@fileverse/ui';
import SVGIcon from '../SVGIcon';
import { getLucideIcon } from '.';

type Props = {
  tooltip: string;
  iconId?: string;
  text?: string;
  textStyle?: CSSProperties;
  showArrow?: boolean;
  onClick?: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
  children: (
    setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  ) => React.ReactNode;
  fillColor?: string;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
};

const toCssId = (s: string) =>
  String(s)
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-');

const Combo: React.FC<Props> = ({
  tooltip,
  onClick,
  text,
  textStyle,
  iconId,
  showArrow = true,
  children,
  fillColor,
  triggerRef,
}) => {
  const style: CSSProperties = { userSelect: 'none' };
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const iconIdClass = iconId ? toCssId(iconId) : 'combo';

  if (!triggerRef) {
    triggerRef = ref;
  }

  // Custom handler to prevent closing during interactions
  const handleOpenChange = (newOpen: boolean) => {
    // You can add custom logic here to prevent closing
    // For example, check if user is interacting with content
    setOpen(newOpen);
  };
  const isLucideIcon = useMemo(() => {
    return (
      iconId?.startsWith('align-') ||
      [
        'text-overflow',
        'text-wrap',
        'text-clip',
        'font-color',
        'background',
        'border-all',
        'merge-all',
        'format',
        'conditionFormat',
        'sort',
        'filter',
        'comment',
        'image',
        'formula-sum',
        'dune',
        'template',
        'font-color',
        'background',
        'currency',
      ].includes(iconId as string)
    );
  }, [iconId]);

  const trigger = !isLucideIcon ? (
    <Tooltip text={tooltip} position="bottom">
      <div
        className={`fortune-toolbar-combo-button fortune-toolbar-combo-button--${iconIdClass}`}
        data-icon-id={iconId ?? undefined}
        data-testid={`toolbar-combo-${iconId ?? 'combo'}`}
        onClick={(e) => {
          if (onClick) {
            onClick(e);
            // If there's no arrow, also toggle dropdown after executing onClick
            if (!showArrow) setOpen(!open);
          }
        }}
        tabIndex={0}
        role="button"
        style={style}
      >
        {iconId ? (
          <SVGIcon name={iconId} width={16} height={16} />
        ) : (
          <span className="fortune-toolbar-combo-text" style={textStyle}>
            {text !== undefined ? text : ''}
          </span>
        )}
        <LucideIcon className="w-[16px] h-[16px]" name="ChevronDown" />
      </div>
    </Tooltip>
  ) : (
    <span>
      {iconId === 'font-color' ? (
        <Tooltip text={tooltip} position="bottom">
          <Button
            variant="ghost"
            onClick={() => setOpen(!open)}
            className={cn(
              'fortune-toolbar-combo-button !min-w-fit !px-0 !flex !items-center !justify-center',
            )}
            style={{
              width: 30,
              height: 30,
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              className="color-text-default"
              style={{ display: 'block' }}
            >
              <path
                fill="currentColor"
                fillRule="evenodd"
                clipRule="evenodd"
                d="M11.9997 3C12.3784 3 12.7248 3.21402 12.8942 3.55273L20.8942 19.5527L20.9352 19.6465C21.115 20.1204 20.9101 20.663 20.447 20.8945C19.9839 21.1259 19.4272 20.9642 19.1559 20.5361L19.1052 20.4473L16.8815 16H7.11786L4.89422 20.4473C4.64719 20.9412 4.04636 21.1415 3.55243 20.8945C3.05867 20.6475 2.85831 20.0466 3.10516 19.5527L11.1052 3.55273L11.1764 3.43164C11.3613 3.16376 11.6684 3.0001 11.9997 3ZM8.11786 14H15.8815L11.9997 6.23633L8.11786 14Z"
              />
            </svg>
          </Button>
        </Tooltip>
      ) : (
        <Tooltip text={tooltip} position="bottom">
          <IconButton
            icon={getLucideIcon(iconId as string)}
            variant="ghost"
            onClick={() => {
              setOpen(!open);
            }}
            className={cn('fortune-toolbar-combo-button', {
              'custom-color-button': iconId === 'font-color' && fillColor,
              'min-w-fit rounded-l-none': iconId === 'currency',
            })}
            style={{
              color: iconId === 'font-color' ? fillColor : undefined,
            }}
          />
        </Tooltip>
      )}
    </span>
  );

  return (
    <div
      ref={buttonRef}
      className={`fortune-toolbar-item fortune-toolbar-combo fortune-toolbar-combo--${iconIdClass}`}
      data-icon-id={iconId ?? undefined}
      data-testid={`toolbar-combo-${iconId ?? 'combo'}`}
      onKeyDown={(e) => {
        e.stopPropagation();
      }}
    >
      <Popover open={open} onOpenChange={handleOpenChange} modal>
        <PopoverTrigger
          ref={triggerRef as React.Ref<HTMLButtonElement>}
          asChild
        >
          <div className="flex items-center">{trigger}</div>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={4}
          alignOffset={-16}
          className="fortune-toolbar-combo-popup border-none"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {children?.(setOpen)}
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default Combo;
