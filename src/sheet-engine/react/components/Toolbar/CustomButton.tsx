import React from 'react';
import { Tooltip } from '@fileverse/ui';
import CustomIcon from './CustomIcon';

type Props = {
  tooltip?: string;
  onClick?: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
  selected?: boolean;
  children?: React.ReactNode;
  iconName?: string;
  icon?: React.ReactNode;
};

const toCssId = (s: string) =>
  String(s)
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-');

const CustomButton: React.FC<Props> = ({
  tooltip,
  onClick,
  selected,
  children,
  iconName,
  icon,
}) => {
  const iconNameClass = iconName ? toCssId(iconName) : 'custom';
  return (
    <Tooltip text={tooltip} position="bottom">
      <div
        className={`fortune-toolbar-button fortune-toolbar-item fortune-toolbar-button--${iconNameClass}`}
        data-icon-name={iconName ?? undefined}
        onClick={onClick}
        tabIndex={0}
        role="button"
        style={selected ? { backgroundColor: '#FFDF0A' } : {}}
        data-testid={`toolbar-cta-${iconName ?? 'custom'}`}
      >
        <span
          className={`fortune-toolbar-button__icon fortune-toolbar-button__icon--${iconNameClass} ${selected ? 'color-text-on-brand' : ''}`}
          data-icon-name={iconName ?? undefined}
        >
          <CustomIcon
            width={16}
            height={16}
            iconName={iconName}
            content={icon}
          />
        </span>
        {children}
      </div>
    </Tooltip>
  );
};

export default CustomButton;
