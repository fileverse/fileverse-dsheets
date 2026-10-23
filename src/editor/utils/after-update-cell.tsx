/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/ban-ts-comment */
import { Cell } from '@sheet-engine/react';
import { WorkbookInstance } from '@sheet-engine/react';
import {
  OnboardingHandlerType,
  ErrorMessageHandlerReturnType,
} from '../types';
import { formulaResponseUiSync, USD_FA } from './formula-ui-sync';
import {
  executeStringFunction,
  parseArguments,
  isCellReference,
  isCellRangeReference,
  cellRangeToRowCol,
  cellReferenceToRowCol,
} from './executeStringFunction';
import { updateYdocSheetData } from './update-ydoc';
import { dataBlockCalcFunctionHandler } from './dataBlockCalcFunction';
import { ERROR_MESSAGES_FLAG } from '../constants/shared-constants';
import { getSheetIndex, LiveQueryData, update } from '@sheet-engine/core';
import * as Y from 'yjs';
import { isHexValue } from './generic';
import {
  isSmartContractResponse,
  smartContractQueryHandlerFunction,
} from './smart-contract-query-handler';
import { isDatablockError } from './datablock-error-utils';
import {
  handleDataBlockError,
  OpenApiKeyModalFn,
} from './data-block-error-handler';
import { ApiKeyStorage } from './api-key-storage';
import { DataBlockEvent } from '../types';

// Constants
const DEFAULT_FONT_SIZE = 10;
const LINE_HEIGHT_MULTIPLIER = 1.5;
const PROMISE_OBJECT_STRING = '[object Promise]';
const LOADING_MESSAGE = 'Loading...';
const FETCH_URL_MODAL_ID = 'fetch-url-modal';
const FLVURL_FUNCTIONS = ['FLVURL', 'flvurl'];

export type SmartContractResponse = {
  callSignature: unknown[];
};

export type SheetSmartContractApi = {
  sheetEditorRef: React.RefObject<WorkbookInstance | null>;
  formulaResponseUiSync: Function;
  row: number;
  column: number;
  newValue: Cell;
};

export type SmartContractQueryHandler = (
  sheetApi: SheetSmartContractApi,
) => (callSignature: unknown[]) => Promise<void>;

/**
 * Parameters for the afterUpdateCell function
 */
interface AfterUpdateCellParams {
  row: number;
  column: number;
  oldValue?: Cell;
  newValue: Cell;
  sheetEditorRef: React.RefObject<WorkbookInstance | null>;
  handleContentPortal?: () => void;
  dsheetId?: string;
  ydocRef?: React.MutableRefObject<Y.Doc | null>;
  onboardingComplete: boolean | undefined;
  setFetchingURLData?: (fetching: boolean) => void;
  onboardingHandler: OnboardingHandlerType | undefined;
  apiKeyStorage: ApiKeyStorage;
  openApiKeyModal: OpenApiKeyModalFn;
  onDataBlockEvent?: (event: DataBlockEvent) => void;
  handleSmartContractQuery?: SmartContractQueryHandler | undefined;
  handleLiveQueryData?: (
    subsheetIndex: number,
    queryData: LiveQueryData,
  ) => void;
  setInputFetchURLDataBlock?:
    | React.Dispatch<React.SetStateAction<string>>
    | undefined;
  setDataBlockCalcFunction?: React.Dispatch<
    React.SetStateAction<{ [key: string]: { [key: string]: any } }>
  >;
  dataBlockCalcFunction?: { [key: string]: { [key: string]: any } };
  collabEnabled?: boolean;
  collabIsOwner?: boolean;
  remoteUpdateRef?: React.MutableRefObject<boolean>;
  localUserEditRef?: React.MutableRefObject<boolean>;
  /** Sheet that held the cell at commit time; falls back to the current sheet. */
  sheetId?: string;
}

/** True when data-block formulas (API / smart contract) should run for this edit. */
export const shouldExecuteDataBlocks = (params: {
  collabEnabled?: boolean;
  collabIsOwner?: boolean;
  remoteUpdateRef?: React.MutableRefObject<boolean>;
  localUserEditRef?: React.MutableRefObject<boolean>;
  sheetEditorRef: React.RefObject<WorkbookInstance | null>;
}): boolean => {
  if (params.collabEnabled) {
    // Joiners display owner-synced values; only run API work on explicit local edits.
    if (params.collabIsOwner === false) {
      return params.localUserEditRef?.current === true;
    }
    if (params.remoteUpdateRef?.current) {
      return false;
    }
  }

  const ctx = params.sheetEditorRef.current?.getWorkbookContext?.();
  if (!ctx?.luckysheetfile?.length) {
    return false;
  }

  const sheetId = ctx.currentSheetId;
  if (!sheetId) {
    return false;
  }

  return ctx.luckysheetfile.some((sheet) => sheet.id === sheetId);
};

/**
 * Parameters for the adjustRowHeight function
 */
interface AdjustRowHeightParams {
  newValue: Cell;
  sheetEditorRef: React.RefObject<WorkbookInstance | null>;
  row: number;
}

/**
 * Checks if the cell value is empty or invalid
 */
const isCellValueEmpty = (newValue: Cell): boolean => {
  if (!newValue) return true;

  const v = newValue.v;
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim().length === 0;

  // numbers (including 0) and booleans (including false) are valid cell values
  return false;
};

/**
 * Handles onboarding logic and updates row/column if needed
 */
const handleOnboarding = (
  params: Pick<
    AfterUpdateCellParams,
    | 'row'
    | 'column'
    | 'onboardingComplete'
    | 'onboardingHandler'
    | 'sheetEditorRef'
  >,
): { row: number; column: number } => {
  let { row, column } = params;

  if (!params.onboardingComplete && params.onboardingHandler) {
    const result = params.onboardingHandler({
      row,
      column,
      sheetEditorRef: params.sheetEditorRef,
    });
    row = result.row;
    column = result.column;
  }

  return { row, column };
};

/**
 * Checks if the formula contains FLVURL function
 */
const containsFlvurlFunction = (formula: string): boolean => {
  return FLVURL_FUNCTIONS.some((func) => formula.includes(func));
};

const getFormulaName = (cell: Cell): string | undefined =>
  cell.f?.match(/^=([A-Za-z0-9_]+)\s*\(/)?.[1]?.toUpperCase();

/**
 * Extracts URL from FLVURL function
 */
const extractUrlFromFlvurlFunction = (formula: string): string => {
  const lowerCaseMatch = formula.split('flvurl(');
  const upperCaseMatch = formula.split('FLVURL(');

  if (lowerCaseMatch.length > 1) {
    return lowerCaseMatch[1].split(')')[0];
  } else if (upperCaseMatch.length > 1) {
    return upperCaseMatch[1].split(')')[0];
  } else {
    return ''; // or throw an error, depending on your requirements
  }
};

/**
 * Handles error response from promise
 */
const handlePromiseError = (
  data: string,
  sheetEditorRef: React.RefObject<WorkbookInstance | null>,
  row: number,
  column: number,
  newValue: Cell,
): void => {
  sheetEditorRef.current?.setCellValue(row, column, {
    ...newValue,
    m: data,
    isDataBlockFormula: true,
  });
};

/**
 * Handles array response from promise
 */
const handleArrayResponse = (
  data: Record<string, object>[],
  params: Pick<
    AfterUpdateCellParams,
    'row' | 'column' | 'newValue' | 'sheetEditorRef'
  >,
  formulaName?: string,
): void => {
  formulaResponseUiSync({
    row: params.row,
    column: params.column,
    newValue: params.newValue as Record<string, string>,
    apiData: data,
    sheetEditorRef: params.sheetEditorRef,
    shouldIgnoreUsdValue: formulaName === 'COINGECKO',
  });
};

/**
 * Handles string response from promise
 */
const handleStringResponse = (
  data: string,
  params: Pick<
    AfterUpdateCellParams,
    'sheetEditorRef' | 'row' | 'column' | 'newValue'
  >,
  formulaName?: string,
): void => {
  const extraProperties = {} as any;

  if (formulaName && formulaName === 'PRICE') {
    extraProperties.m = update(USD_FA, data);
    extraProperties.ht = 2;
    extraProperties.v = data;
    extraProperties.ct = { fa: USD_FA, t: 'n' };
  } else {
    extraProperties.m = String(data);
  }
  params.sheetEditorRef.current?.setCellValue(params.row, params.column, {
    ...params.newValue,
    ...extraProperties,
    isDataBlockFormula: true,
  });
  params.sheetEditorRef.current?.clearCellError(params.row, params.column);
};

/**
 * Processes promise resolution for FLVURL functions
 */
const processFlvurlPromise = async (
  promise: Promise<Record<string, string>[] | string>,
  params: Pick<
    AfterUpdateCellParams,
    'row' | 'column' | 'newValue' | 'sheetEditorRef' | 'setFetchingURLData'
  >,
): Promise<void> => {
  try {
    const data = await promise;

    if (typeof data === 'string' && data.includes('Error')) {
      handlePromiseError(
        data,
        params.sheetEditorRef,
        params.row,
        params.column,
        params.newValue,
      );
      return;
    }

    const fetchView = document.getElementById(FETCH_URL_MODAL_ID);
    if (Array.isArray(data) && fetchView) {
      // @ts-ignore
      handleArrayResponse(data, params);
    }

    params.setFetchingURLData?.(false);
  } catch (error) {
    console.error('Error processing FLVURL promise:', error);
    params.setFetchingURLData?.(false);
  }
};

const handleDatablockError = (
  data: ErrorMessageHandlerReturnType,
  params: Pick<
    AfterUpdateCellParams,
    | 'sheetEditorRef'
    | 'row'
    | 'column'
    | 'newValue'
    | 'apiKeyStorage'
    | 'openApiKeyModal'
    | 'onDataBlockEvent'
    | 'handleSmartContractQuery'
  >,
): void => {
  void handleDataBlockError({
    data,
    sheetEditorRef: params.sheetEditorRef,
    row: params.row,
    column: params.column,
    newValue: params.newValue,
    apiKeyStorage: params.apiKeyStorage,
    openApiKeyModal: params.openApiKeyModal,
    onDataBlockEvent: params.onDataBlockEvent,
    handleSmartContractQuery: params.handleSmartContractQuery,
  });
};

export { isDatablockError } from './datablock-error-utils';

/**
 * Processes promise resolution for regular formulas
 */
const processRegularPromise = async (
  promise: Promise<
    unknown[] | ErrorMessageHandlerReturnType | string | SmartContractResponse
  >,
  params: Pick<
    AfterUpdateCellParams,
    | 'row'
    | 'column'
    | 'newValue'
    | 'sheetEditorRef'
    | 'apiKeyStorage'
    | 'openApiKeyModal'
    | 'onDataBlockEvent'
    | 'handleSmartContractQuery'
    | 'handleLiveQueryData'
  >,
): Promise<void> => {
  try {
    const data = await promise;
    const formulaName = getFormulaName(params.newValue);
    if (isDatablockError(data)) {
      const _data = data as ErrorMessageHandlerReturnType;
      const message =
        _data.message === 'Required'
          ? 'Required parameter was not provided'
          : _data.message;
      params.sheetEditorRef.current?.setCellError(params.row, params.column, {
        title: _data.type,
        message,
      });

      handleDatablockError(_data, params);
      return;
    }

    if (isSmartContractResponse(data)) {
      smartContractQueryHandlerFunction({
        result: data,
        handleSmartContractQuery: params.handleSmartContractQuery!,
        sheetEditorRef: params.sheetEditorRef,
        dataBlockRow: params.row,
        dataBlockColumn: params.column,
        newValue: params.newValue,
      });
      return;
    }
    const context = params.sheetEditorRef.current?.getWorkbookContext();

    if (
      context &&
      context.currentSheetId.toString() &&
      params.handleLiveQueryData
    ) {
      const subsheetIndex = getSheetIndex(context, context.currentSheetId);
      if (subsheetIndex?.toString()) {
        const liveQueryData: LiveQueryData = {
          data: {
            row: params.row,
            column: params.column,
            name: formulaName || '',
            value: data as any,
            id: `${params.row}_${params.column}`,
            function: params.newValue.f as string,
            subSheetId: context.currentSheetId,
          },
          cellData: params.newValue,
        };
        params.handleLiveQueryData(subsheetIndex, liveQueryData);
      }
    }

    if (Array.isArray(data)) {
      const firstItem = (data as any[])?.[0];
      if (!data.length || Object.keys(firstItem).length === 0) {
        params.sheetEditorRef.current?.setCellValue(params.row, params.column, {
          ...params.newValue,
          m: 'No Data',
          isDataBlockFormula: true,
        });
        params.sheetEditorRef.current?.clearCellError(params.row, params.column);
      } else {
        // @ts-ignore
        handleArrayResponse(data, params, formulaName);
      }
    } else if (!data && typeof data !== 'boolean') {
      params.sheetEditorRef.current?.setCellValue(params.row, params.column, {
        ...params.newValue,
        m: 'No Data',
        isDataBlockFormula: true,
      });
      params.sheetEditorRef.current?.clearCellError(params.row, params.column);
    } else {
      handleStringResponse(data as string, params, formulaName);
    }
    params.onDataBlockEvent?.({ type: 'success', functionName: formulaName });
    const workbookContext = params.sheetEditorRef.current?.getWorkbookContext();
    const apiKeyName =
      workbookContext?.formulaCache.functionlistMap[formulaName || '']?.API_KEY;
    if (apiKeyName) {
      const key = params.apiKeyStorage.get(apiKeyName);
      if (key && key !== 'DEFAULT_PROXY_MODE') {
        params.onDataBlockEvent?.({
          type: 'api-key-saved',
          apiKeyName,
          functionName: formulaName,
        });
      }
    }
  } catch (error: any) {
    const formulaName = getFormulaName(params.newValue);
    handleDatablockError(
      {
        type: 'DSHEET_ERROR',
        message: 'Unexpected Error',
        functionName: formulaName,
        reason: error?.message,
      },
      params,
    );
  }
};

/**
 * Handles promise-based cell values
 */
const handlePromiseValue = async (
  newValue: Cell,
  params: AfterUpdateCellParams,
): Promise<void> => {
  const { row, column, sheetEditorRef } = params;
  const promise = newValue.v as unknown as Promise<
    Record<string, string>[] | string
  >;

  // Check if this is a FLVURL function
  if (newValue.f && containsFlvurlFunction(newValue.f)) {
    const inputURL = extractUrlFromFlvurlFunction(newValue.f);
    params.setInputFetchURLDataBlock?.(inputURL);
    params.setFetchingURLData?.(true);

    processFlvurlPromise(promise, params);
    sheetEditorRef.current?.setCellValue(row, column, null);
  } else {
    // Regular promise handling
    processRegularPromise(promise, params);
    const newCellValue = {
      ...newValue,
      m: LOADING_MESSAGE,
    };
    try {
      (sheetEditorRef.current as any)?.setCellValuesByRange(
        [[newCellValue]],
        {
          row: [row, row],
          column: [column, column],
        },
        {},
        false,
      );
    } catch (error) {
      console.warn(
        '[DSheet] Skipped loading UI update — workbook not ready',
        error,
      );
    }
  }
};

/**
 * Handles logic after a cell is updated, including processing formula results
 *
 * @param params - Object containing all required parameters
 * @returns Promise that resolves when processing is complete
 */
export const afterUpdateCell = async (
  params: AfterUpdateCellParams,
): Promise<void> => {
  // Persist first, on the sheet that held the cell at commit time. The write
  // is idempotent (skipIfEqual), so it is harmless after updateCell's own
  // commit-time write, and it keeps paths that only reach Yjs through this
  // hook (api.setCellValue with callAfterUpdate) working. It must not sit
  // behind the data-block gate below: that gate dropped typed commits (B2).
  const currentSheetId =
    params.sheetId ??
    (params.sheetEditorRef.current?.getWorkbookContext()
      ?.currentSheetId as string);
  updateYdocSheetData(
    // @ts-ignore
    params.ydocRef.current,
    // @ts-ignore
    params.dsheetId,
    [
      {
        sheetId: currentSheetId,
        path: ['celldata'],
        value: {
          r: params.row,
          c: params.column,
          v: params.newValue,
        },
        key: params.row + '_' + params.column,
        type: 'update',
      },
    ],
    // @ts-ignore
    params.handleContentPortal,
  );

  // During RTC remote apply (e.g. owner XLSX import), skip local data-block work.
  // Owner local edits and joiner local formula entry clear the lock via onLocalCellEdit.
  if (!shouldExecuteDataBlocks(params)) {
    return;
  }

  const { newValue, sheetEditorRef } = params;
  // Early return for empty values
  if (isCellValueEmpty(newValue)) {
    return;
  }

  if (!newValue?.m && !newValue?.v && newValue?.baseValue) {
    sheetEditorRef.current?.setCellValue(params.row, params.column, {
      ...newValue,
      baseValue: undefined,
      ct: { fa: '@', t: 's' },
    });
  }

  if (isHexValue(newValue.v as string)) {
    sheetEditorRef.current?.setCellValue(params.row, params.column, {
      ...newValue,
      m: newValue.v,
      ct: { fa: '@', t: 's' },
    });
  }

  // Handle onboarding if needed
  const { row, column } = handleOnboarding(params);
  const updatedParams = { ...params, row, column };
  const formulaName = getFormulaName(newValue);

  // Handle promise-based values
  if (
    newValue.m === PROMISE_OBJECT_STRING ||
    newValue.m === LOADING_MESSAGE ||
    newValue.m === 'Loading'
  ) {
    await handlePromiseValue(newValue, updatedParams);

    // register dataBlockCalcFunction cell
    updateDataCalcFunc({ params: updatedParams, currentSheetId });
  }

  const dataBlockCalcFunction = params?.dataBlockCalcFunction;
  dataBlockCalcFunctionHandler({
    handleSmartContractQuery: params.handleSmartContractQuery,
    // @ts-expect-error later
    dataBlockCalcFunction,
    sheetEditorRef,
    currentRow: params.row,
    currentColumn: params.column,
    currentFormulaName: formulaName,
  });
};

// Add a new entry for the edited data block dependency map.
const updateDataCalcFunc = ({
  params,
  currentSheetId,
}: {
  params: AfterUpdateCellParams;
  currentSheetId: string;
}) => {
  try {
    const formulaString = params.newValue?.f?.split('=')[1];
    const functionMatch = formulaString?.match(/^=?(\w+)(?:\(([^)]*)\)?)?$/);
    if (!functionMatch) {
      // Skip dependency registration — formula is already executing and our regex doesn't cover all valid syntax.
      return;
    }

    params?.setDataBlockCalcFunction?.((dataBlockCalcFunction) => {
      const argsString = functionMatch[2]; // The entire argument string

      // Parse the arguments, respecting nested structures
      const ar = parseArguments(argsString);

      let args = ar
        //@ts-expect-error later
        .filter((arg: string) => {
          if (isCellRangeReference(arg)) {
            return cellRangeToRowCol(arg);
          }
          if (isCellReference(arg)) {
            return cellReferenceToRowCol(arg);
          }
          return false;
        })
        // @ts-expect-error later
        .map((arg: string) => {
          if (isCellRangeReference(arg)) {
            return cellRangeToRowCol(arg);
          }
          if (isCellReference(arg)) {
            return cellReferenceToRowCol(arg);
          }
          return false;
        });

      args = args.flat();

      // @ts-expect-error later
      const rowRefrenced = args.map((item) => item.row);
      // @ts-expect-error later
      const columnRefrenced = args.map((item) => item.column);
      const formulaName = params.newValue.f
        ?.match(/^=([A-Za-z0-9_]+)\s*\(/)?.[1]
        ?.toUpperCase();

      const newItem = {
        formulaName,
        formula: params.newValue.f,
        row: params.row,
        column: params.column,
        rowRefrenced,
        columnRefrenced,
      };

      // Add new item if it doesn't exist
      return {
        ...dataBlockCalcFunction,
        [currentSheetId]: {
          ...(dataBlockCalcFunction?.[currentSheetId as string] || {}),
          [params.row + '_' + params.column]: newItem,
        },
      };
    });
  } catch (error: any) {
    const formulaName = getFormulaName(params.newValue);
    handleDatablockError(
      {
        message: `ERROR from updateDataCalcFunc ${error?.message}`,
        type: 'Unexpected error',
        functionName: formulaName,
      } as ErrorMessageHandlerReturnType,
      {
        sheetEditorRef: params.sheetEditorRef,
        row: params.row,
        column: params.column,
        newValue: params.newValue,
        apiKeyStorage: params.apiKeyStorage,
        openApiKeyModal: params.openApiKeyModal,
        onDataBlockEvent: params.onDataBlockEvent,
        handleSmartContractQuery: params.handleSmartContractQuery,
      },
    );
  }
};
