import { Popover, PopoverContent, PopoverTrigger } from '@fileverse/ui';
import { ChangeEventHandler, useEffect, useState } from 'react';
import {
  LucideIcon,
  IconButton,
  DynamicModal,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@fileverse/ui';

import { ExportMenuSection } from './export-menu-section';
import './import-button.scss';
const MAX_FILE_SIZE = 4 * 1024 * 1024;

/** Import modes that only apply to CSV; invalid if XLSX/ODS is selected. */
const CSV_ONLY_IMPORT_TYPES = new Set([
  'replace-current-sheet',
  'append-to-current-sheet',
  'replace-data-at-selected-cell',
]);

const WORKBOOK_IMPORT_EXTENSIONS = new Set(['xlsx', 'ods']);

export const CustomButton = ({
  setExportDropdownOpen,
  handleCSVUpload,
  handleXLSXUpload,
  handleODSUpload,
  handleExportToXLSX,
  handleExportToODS,
  handleExportToCSV,
  handleExportToJSON,
}: {
  setExportDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleCSVUpload: (
    event: ChangeEventHandler<HTMLInputElement> | undefined,
    file: any,
    importType: string,
    separatorType: string,
  ) => void | Promise<void>;
  handleXLSXUpload: (
    event: ChangeEventHandler<HTMLInputElement> | undefined,
    file: any,
    importType: string,
  ) => void | Promise<void>;
  handleODSUpload: (
    event: ChangeEventHandler<HTMLInputElement> | undefined,
    file: any,
    importType: string,
  ) => void | Promise<void>;
  handleExportToXLSX: () => void;
  handleExportToODS: () => void;
  handleExportToCSV: () => void;
  handleExportToJSON: () => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [openImportTypeModal, setOpenImportTypeModal] = useState(false);
  const [importType, setImportType] = useState('new-dsheet');
  const [file, setFile] = useState<any>(null);
  const [extension, setExtension] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [separatorType, setSeparatorType] = useState('auto');

  useEffect(() => {
    if (!WORKBOOK_IMPORT_EXTENSIONS.has(extension)) return;
    setImportType((prev) =>
      CSV_ONLY_IMPORT_TYPES.has(prev) ? 'new-dsheet' : prev,
    );
  }, [extension]);

  const handleApplyData = async () => {
    if (extension === 'xlsx' || extension === 'ods') {
      if (file && importType === 'new-dsheet') {
        const url = URL.createObjectURL(file);
        const queryKey = extension === 'ods' ? 'ods' : 'xlsx';
        setTimeout(() => {
          window.open(
            `/sheet/create?${queryKey}=${encodeURIComponent(url)}`,
            '_blank',
          );
        }, 0);
        setOpenImportTypeModal(false);
      } else {
        setIsImporting(true);
        try {
          const upload =
            extension === 'ods' ? handleODSUpload : handleXLSXUpload;
          await Promise.resolve(upload(undefined, file, importType));
        } finally {
          setIsImporting(false);
          setOpenImportTypeModal(false);
        }
      }
    } else {
      if (file && importType === 'new-dsheet') {
        const url = URL.createObjectURL(file);
        setTimeout(() => {
          window.open(
            `/sheet/create?csv=${encodeURIComponent(url)}&separator=${separatorType}`,
            '_blank',
          );
        }, 0);
        setOpenImportTypeModal(false);
      } else {
        setIsImporting(true);
        try {
          await Promise.resolve(
            handleCSVUpload(undefined, file, importType, separatorType),
          );
        } finally {
          setIsImporting(false);
          setOpenImportTypeModal(false);
        }
      }
    }
  };

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
        data-testid="export-popover-trigger"
      >
        {/* export-button is used in use xocument style */}
        <IconButton
          className="export-button dsheet-btn-icon hover:bg-red"
          icon="FileExport"
          variant="ghost"
          size="md"
          data-testid="export-dropdown-button"
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        alignOffset={0}
        className="w-72 export-content-popover dsheet-export-popover"
        elevation={2}
        side="bottom"
        sideOffset={4}
        data-testid="export-import-popover-content"
      >
        <ExportMenuSection
          handleExportToJSON={handleExportToJSON}
          handleExportToXLSX={handleExportToXLSX}
          handleExportToODS={handleExportToODS}
          handleExportToCSV={handleExportToCSV}
          onItemClick={() => setIsOpen(false)}
        />
        <div
          className="p-2 color-text-default dsheet-import-section"
          data-testid="import-section"
        // onClick={() => setIsOpen(false)}
        >
          <h2
            className="dsheet-heading dsheet-heading--section text-helper-text-sm color-text-secondary pl-2"
            data-testid="import-heading"
          >
            Import
          </h2>
          <div className="btn dsheet-import-actions">
            <button
              type="button"
              className="dsheet-btn dsheet-btn--import-xlsx hover:color-bg-default-hover h-8 rounded p-2 w-full text-left flex items-center justify-start space-x-2 transition"
              data-testid="import-xlsx-button"
            >
              <LucideIcon name="FileExport" />
              <label
                htmlFor="xlsx-upload"
                className="dsheet-label text-body-sm w-full cursor-pointer"
              >
                <span className="dsheet-text dsheet-text--body">
                  Import .xlsx
                </span>
              </label>
            </button>
            <input
              type="file"
              accept=".xlsx"
              id="xlsx-upload"
              data-testid="import-xlsx-input"
              onChange={(e) => {
                setExtension('xlsx');
                setFile(e.target.files?.[0]);
                setImportType('new-dsheet');
                setOpenImportTypeModal(true);
                setIsOpen(false);
                e.target.value = '';
              }}
              style={{ display: 'none' }}
            />
          </div>
          <div className="btn dsheet-import-actions">
            <button
              type="button"
              className="dsheet-btn dsheet-btn--import-ods hover:color-bg-default-hover h-8 rounded p-2 w-full text-left flex items-center justify-start space-x-2 transition"
              data-testid="import-ods-button"
            >
              <LucideIcon name="FileExport" />
              <label
                htmlFor="ods-upload"
                className="dsheet-label text-body-sm w-full cursor-pointer"
              >
                <span className="dsheet-text dsheet-text--body">
                  Import .ods
                </span>
              </label>
            </button>
            <input
              type="file"
              accept=".ods"
              id="ods-upload"
              data-testid="import-ods-input"
              onChange={(e) => {
                setExtension('ods');
                setFile(e.target.files?.[0]);
                setImportType('new-dsheet');
                setOpenImportTypeModal(true);
                setIsOpen(false);
                e.target.value = '';
              }}
              style={{ display: 'none' }}
            />
          </div>
          <div className="btn dsheet-import-actions">
            <input
              type="file"
              accept=".csv"
              id="csv-upload"
              data-testid="import-csv-input"
              onChange={(e) => {
                setExtension('csv');
                setFile(e.target.files?.[0]);
                setImportType('new-dsheet');
                setOpenImportTypeModal(true);
                setIsOpen(false);
                e.target.value = '';
              }}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="dsheet-btn dsheet-btn--import-csv hover:color-bg-default-hover h-8 rounded p-2 w-full text-left flex items-center justify-start space-x-2 transition"
              data-testid="import-csv-button"
            >
              <LucideIcon width={18} height={18} name="FileExport" />
              <label
                htmlFor="csv-upload"
                className="dsheet-label text-body-sm w-full cursor-pointer"
              >
                <span className="dsheet-text dsheet-text--body">
                  Import .csv
                </span>
              </label>
            </button>
          </div>
        </div>
      </PopoverContent>
      <DynamicModal
        hasCloseIcon
        open={openImportTypeModal}
        onOpenChange={(open) => {
          if (isImporting && !open) return;
          setOpenImportTypeModal(open);
        }}
        className="dsheet-modal dsheet-modal--import rounded-lg max-w-[540px]"
        contentClassName="!pt-4 px-6"
        title={
          <div
            className="dsheet-heading dsheet-heading--modal font-medium text-lg leading-6"
            data-testid="import-modal-title"
          >
            Import file
          </div>
        }
        content={
          <div
            className="dsheet-modal-content flex flex-col gap-4 font-normal text-sm leading-5"
            data-testid="import-modal-content"
          >
            <div
              className="dsheet-modal-field"
              data-testid="import-modal-filename-field"
            >
              <div className="dsheet-label dsheet-label--heading text-heading-xsm mb-2">
                File
              </div>
              <div className="dsheet-input-wrap h-[20px] rounded flex items-center">
                <p
                  className="dsheet-text dsheet-text--body text-body-sm truncate-text"
                  data-testid="import-modal-filename"
                >
                  {file?.name}
                </p>
              </div>
              {file?.size > MAX_FILE_SIZE && (
                <p
                  className="dsheet-text dsheet-text--error text-[hsla(var(--color-text-danger))] font-[`Helvetica_Neue`] text-[14px] font-normal mt-[4px] leading-[20px]"
                  data-testid="import-modal-file-size-error"
                >
                  Can't import this file right now. Try again later.
                </p>
              )}
            </div>

            <div className="flex flex-row gap-4">
              <div
                className="dsheet-modal-field flex-1 min-w-0"
                data-testid="import-modal-location-field"
              >
                <div className="dsheet-label dsheet-label--heading text-heading-xsm mb-2">
                  Import location
                </div>

                <Select
                  value={importType}
                  onValueChange={(value) => {
                    setImportType(value);
                  }}
                >
                  <SelectTrigger data-testid="import-location-trigger">
                    <SelectValue placeholder="Create new dSheet" />
                  </SelectTrigger>
                  <SelectContent id="publish-category">
                    {[
                      {
                        id: 'new-dsheet',
                        label: 'Create new dSheet',
                        csvOnly: false,
                      },
                      {
                        id: 'merge-current-dsheet',
                        label: 'Insert new sheet(s)',
                        csvOnly: false,
                      },
                      {
                        id: 'new-current-dsheet',
                        label: 'Replace dSheet',
                        csvOnly: false,
                      },
                      {
                        id: 'replace-current-sheet',
                        label: 'Replace current sheet',
                        csvOnly: true,
                      },
                      {
                        id: 'append-to-current-sheet',
                        label: 'Append to current sheet',
                        csvOnly: true,
                      },
                      {
                        id: 'replace-data-at-selected-cell',
                        label: 'Replace data at selected cell',
                        csvOnly: true,
                      },
                    ].map((cat) => {
                      const isDisabled =
                        cat.csvOnly && WORKBOOK_IMPORT_EXTENSIONS.has(extension);
                      return (
                        <SelectItem
                          key={cat.id}
                          value={cat.id}
                          disabled={isDisabled}
                          className={
                            isDisabled ? 'opacity-40 cursor-not-allowed' : ''
                          }
                        >
                          {cat.label}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              {extension === 'csv' && (
                <div
                  className="dsheet-modal-field flex-1 min-w-0"
                  data-testid="import-modal-separator-field"
                >
                  <div className="dsheet-label dsheet-label--heading text-heading-xsm mb-[4px]">
                    Separator type
                  </div>
                  <Select
                    value={separatorType}
                    onValueChange={setSeparatorType}
                  >
                    <SelectTrigger data-testid="import-separator-trigger">
                      <SelectValue placeholder="Detect automatically" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Detect automatically</SelectItem>
                      <SelectItem value="tab">Tab</SelectItem>
                      <SelectItem value="comma">Comma</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {importType === 'new-current-dsheet' && (
              <p className="px-3 py-2 rounded text-sm bg-[#F5A623]/20 text-[#7A4F00]">
                All data currently in this spreadsheet will be replaced.
              </p>
            )}
            <div
              className="dsheet-modal-actions flex justify-end items-center gap-2"
              data-testid="import-modal-actions"
            >
              <Button
                className="dsheet-btn dsheet-btn--secondary font-medium text-sm leading-5 px-3 py-2 w-20 min-w-[80px] h-10 h-[36px] max-h-10 rounded"
                size="md"
                variant="secondary"
                onClick={() => setOpenImportTypeModal(false)}
                data-testid="import-modal-cancel-button"
              >
                Cancel
              </Button>
              <Button
                disabled={!file || file?.size > MAX_FILE_SIZE || isImporting}
                isLoading={isImporting}
                className="dsheet-btn dsheet-btn--primary font-medium text-sm leading-5 px-3 py-2 w-20 min-w-[100px] h-10 h-[36px] max-h-10 rounded"
                size="md"
                onClick={handleApplyData}
                data-testid="import-modal-submit-button"
              >
                Import data
              </Button>
            </div>
          </div>
        }
      />
    </Popover>
  );
};
