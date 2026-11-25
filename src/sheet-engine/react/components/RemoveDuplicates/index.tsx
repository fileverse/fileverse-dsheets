import React, { useCallback, useContext, useState } from 'react';
import {
  indexToColumnChar,
  getRemoveDuplicatesPreview,
  getRemoveDuplicatesErrorMessage,
  locale,
  removeDuplicates,
  type RemoveDuplicatesColumnOption,
  type RemoveDuplicatesPreview,
  type RemoveDuplicatesResult,
} from '@sheet-engine/core';
import { Button, Checkbox } from '@fileverse/ui';
import WorkbookContext from '../../context';
import { useWorkbookContextIgnoringScroll } from '../../context/use-workbook-store';
import { useDialog } from '../../hooks/useDialog';

type RemoveDuplicatesDialogProps = {
  initialPreview: RemoveDuplicatesPreview;
  onClose: () => void;
};

const RemoveDuplicatesDialog: React.FC<RemoveDuplicatesDialogProps> = ({
  initialPreview,
  onClose,
}) => {
  const { context, setContext } = useContext(WorkbookContext);
  const { showDialog, hideDialog } = useDialog();
  const { removeDuplicates: copy, button } = locale(context) as any;

  const [hasHeaderRow, setHasHeaderRow] = useState(false);
  const [columns, setColumns] = useState<RemoveDuplicatesColumnOption[]>(
    initialPreview.columns,
  );

  const allChecked = columns.every((column) => column.checked);
  const someChecked = columns.some((column) => column.checked);

  const getColumnLabel = (column: RemoveDuplicatesColumnOption) =>
    hasHeaderRow ? column.label : indexToColumnChar(column.column);

  const toggleColumn = useCallback((columnIndex: number) => {
    setColumns((prev) =>
      prev.map((column) =>
        column.column === columnIndex
          ? { ...column, checked: !column.checked }
          : column,
      ),
    );
  }, []);

  const toggleSelectAll = useCallback(() => {
    const nextChecked = !allChecked;
    setColumns((prev) =>
      prev.map((column) => ({ ...column, checked: nextChecked })),
    );
  }, [allChecked]);

  const showResultDialog = useCallback(
    (result: RemoveDuplicatesResult) => {
      if (result.error) {
        showDialog(
          getRemoveDuplicatesErrorMessage(context, result.error),
          'ok',
          copy?.title || 'Remove duplicates',
        );
        return;
      }

      const resultMessage = (copy?.result ||
        '{removed} duplicate values removed from the analyzed columns. {remaining} unique values remain.')
        .replace('{removed}', String(result.removedCount))
        .replace('{remaining}', String(result.remainingCount));

      showDialog(resultMessage, 'ok', copy?.title || 'Remove duplicates');
    },
    [context, copy?.result, copy?.title, showDialog],
  );

  const handleConfirm = useCallback(() => {
    const analyzedColumns = columns
      .filter((column) => column.checked)
      .map((column) => column.column);

    if (analyzedColumns.length === 0) {
      showDialog(
        getRemoveDuplicatesErrorMessage(context, 'noColumns'),
        'ok',
        copy?.title || 'Remove duplicates',
      );
      return;
    }

    hideDialog();
    onClose();

    let result: RemoveDuplicatesResult = {
      removedCount: 0,
      remainingCount: 0,
    };

    setContext((draftCtx) => {
      result = removeDuplicates(draftCtx, {
        hasHeaderRow,
        analyzedColumns,
        range: initialPreview.range,
      });
    });

    showResultDialog(result);
  }, [
    columns,
    context,
    copy?.title,
    hasHeaderRow,
    hideDialog,
    onClose,
    setContext,
    showDialog,
    showResultDialog,
  ]);

  return (
    <div className="flex flex-col gap-4 min-w-[320px]">
      <div className="flex flex-row gap-2 items-center">
        <Checkbox
          className="border-2"
          checked={hasHeaderRow}
          onCheckedChange={(e) => setHasHeaderRow(e.target.checked)}
        />
        <span className="text-body-sm">
          {copy?.dataHasHeaderRow || 'Data has header row'}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-body-sm font-medium">
            {copy?.columnsToAnalyze || 'Columns to analyze'}
          </span>
          <button
            type="button"
            className="text-body-sm color-text-subtle hover:color-text-default"
            onClick={toggleSelectAll}
          >
            {copy?.selectAll || 'Select all'}
          </button>
        </div>

        <div className="max-h-[240px] overflow-y-auto flex flex-col gap-2 border color-border-default rounded p-3">
          {columns.map((column) => (
            <div
              key={column.column}
              className="flex flex-row gap-2 items-center"
            >
              <Checkbox
                className="border-2"
                checked={column.checked}
                onCheckedChange={() => toggleColumn(column.column)}
              />
              <span className="text-body-sm">{getColumnLabel(column)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>
          {button.cancel}
        </Button>
        <Button
          variant="default"
          onClick={handleConfirm}
          disabled={!someChecked}
        >
          {copy?.removeDuplicates || 'Remove duplicates'}
        </Button>
      </div>
    </div>
  );
};

export function useRemoveDuplicatesDialog() {
  const { context, setContext } = useWorkbookContextIgnoringScroll();
  const { showDialog, hideDialog } = useDialog();
  const { removeDuplicates: copy } = locale(context) as any;

  const openRemoveDuplicatesDialog = useCallback(() => {
    if (context.allowEdit === false) {
      showDialog(
        getRemoveDuplicatesErrorMessage(context, 'readOnly'),
        'ok',
        copy?.title || 'Remove duplicates',
      );
      return;
    }

    const { preview, error } = getRemoveDuplicatesPreview(context);
    if (error || !preview) {
      showDialog(
        getRemoveDuplicatesErrorMessage(context, error || 'noSelection'),
        'ok',
        copy?.title || 'Remove duplicates',
      );
      return;
    }

    showDialog(
      <RemoveDuplicatesDialog
        initialPreview={preview}
        onClose={hideDialog}
      />,
      undefined,
      copy?.title || 'Remove duplicates',
      undefined,
      undefined,
      hideDialog,
      hideDialog,
    );
  }, [context, copy?.title, hideDialog, setContext, showDialog]);

  return { openRemoveDuplicatesDialog };
}

export default RemoveDuplicatesDialog;
