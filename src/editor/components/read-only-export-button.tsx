import { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  IconButton,
} from '@fileverse/ui';
import { ExportMenuSection, type ExportHandlers } from './export-menu-section';
import './import-button.scss';

type ReadOnlyExportButtonProps = ExportHandlers & {
  setExportDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

export const ReadOnlyExportButton = ({
  setExportDropdownOpen,
  handleExportToXLSX,
  handleExportToODS,
  handleExportToCSV,
  handleExportToJSON,
}: ReadOnlyExportButtonProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        setExportDropdownOpen(open);
      }}
    >
      <PopoverTrigger
        className="dsheet-btn dsheet-export-trigger hover:bg-red"
        style={{ backgroundColor: 'red!important' }}
        data-testid="export-only-popover-trigger"
      >
        <IconButton
          className="export-button dsheet-btn-icon hover:bg-red"
          icon="FileExport"
          variant="ghost"
          size="md"
          data-testid="export-only-dropdown-button"
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        alignOffset={0}
        className="w-72 export-content-popover dsheet-export-popover"
        elevation={2}
        side="bottom"
        sideOffset={4}
        data-testid="export-only-popover-content"
      >
        <ExportMenuSection
          handleExportToJSON={handleExportToJSON}
          handleExportToXLSX={handleExportToXLSX}
          handleExportToODS={handleExportToODS}
          handleExportToCSV={handleExportToCSV}
          onItemClick={() => setIsOpen(false)}
          testIdPrefix="export-only"
        />
      </PopoverContent>
    </Popover>
  );
};
