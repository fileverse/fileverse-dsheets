import { LucideIcon } from '@fileverse/ui';

export type ExportHandlers = {
  handleExportToXLSX: () => void;
  handleExportToODS: () => void;
  handleExportToCSV: () => void;
  handleExportToJSON: () => void;
};

type ExportMenuSectionProps = ExportHandlers & {
  onItemClick?: () => void;
  testIdPrefix?: string;
};

export const ExportMenuSection = ({
  handleExportToJSON,
  handleExportToXLSX,
  handleExportToODS,
  handleExportToCSV,
  onItemClick,
  testIdPrefix = '',
}: ExportMenuSectionProps) => {
  const prefix = testIdPrefix ? `${testIdPrefix}-` : '';
  const runExport = (handler: () => void) => {
    handler();
    onItemClick?.();
  };

  return (
    <div
      className="p-2 color-text-default dsheet-export-section"
      data-testid={`${prefix}export-section`}
    >
      <h2
        className="dsheet-heading dsheet-heading--section text-helper-text-sm color-text-secondary pl-2"
        data-testid={`${prefix}export-heading`}
      >
        Export
      </h2>
      <button
        type="button"
        onClick={() => runExport(handleExportToJSON)}
        className="dsheet-btn dsheet-btn--export-json hover:color-bg-default-hover h-8 rounded p-2 w-full text-left flex items-center justify-start space-x-2 transition"
        data-testid={`${prefix}export-json-button`}
      >
        <LucideIcon name="FileImport" className="w-[17px] h-[17px]" />
        <span className="dsheet-text dsheet-text--body text-body-sm">
          Export to .json
        </span>
      </button>

      <button
        type="button"
        onClick={() => runExport(handleExportToXLSX)}
        className="dsheet-btn dsheet-btn--export-xlsx hover:color-bg-default-hover h-8 rounded p-2 w-full text-left flex items-center justify-start space-x-2 transition"
        data-testid={`${prefix}export-xlsx-button`}
      >
        <LucideIcon name="FileImport" className="w-[17px] h-[17px]" />
        <span className="dsheet-text dsheet-text--body text-body-sm">
          Export to .xlsx
        </span>
      </button>

      <button
        type="button"
        onClick={() => runExport(handleExportToODS)}
        className="dsheet-btn dsheet-btn--export-ods hover:color-bg-default-hover h-8 rounded p-2 w-full text-left flex items-center justify-start space-x-2 transition"
        data-testid={`${prefix}export-ods-button`}
      >
        <LucideIcon name="FileImport" className="w-[17px] h-[17px]" />
        <span className="dsheet-text dsheet-text--body text-body-sm">
          Export to .ods
        </span>
      </button>

      <button
        type="button"
        onClick={() => runExport(handleExportToCSV)}
        className="dsheet-btn dsheet-btn--export-csv hover:color-bg-default-hover h-8 rounded p-2 w-full text-left flex items-center justify-start space-x-2 transition"
        data-testid={`${prefix}export-csv-button`}
      >
        <LucideIcon name="FileImport" className="w-[17px] h-[17px]" />
        <span className="dsheet-text dsheet-text--body text-body-sm">
          Export to .csv
        </span>
      </button>
    </div>
  );
};
