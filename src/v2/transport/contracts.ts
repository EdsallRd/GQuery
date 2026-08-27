import type { FormulaCell } from "../codecs";

/** Values that can be represented losslessly by the Google Sheets Values API. */
export type SheetCellValue = string | number | boolean | null;

/** Typed input accepted only by grid writes that preserve formula intent. */
export type SheetCellInput = SheetCellValue | FormulaCell;

export type SheetMajorDimension = "ROWS" | "COLUMNS";
export type SheetValueRenderOption =
  | "FORMATTED_VALUE"
  | "UNFORMATTED_VALUE"
  | "FORMULA";
export type SheetDateTimeRenderOption = "SERIAL_NUMBER" | "FORMATTED_STRING";
export type SheetValueInputOption = "RAW" | "USER_ENTERED";

export interface SheetReadOptions {
  majorDimension?: SheetMajorDimension;
  valueRenderOption?: SheetValueRenderOption;
  dateTimeRenderOption?: SheetDateTimeRenderOption;
}

export interface SheetValueRange {
  range: string;
  majorDimension: SheetMajorDimension;
  values: SheetCellValue[][];
}

export interface SheetBatchGetResult {
  spreadsheetId: string;
  valueRanges: SheetValueRange[];
}

export interface SheetMetadata {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
}

export interface SpreadsheetMetadata {
  spreadsheetId: string;
  sheets: SheetMetadata[];
}

export interface SheetValueUpdate {
  range: string;
  values: readonly (readonly SheetCellValue[])[];
  majorDimension?: SheetMajorDimension;
}

export interface SheetBatchUpdateOptions {
  valueInputOption?: SheetValueInputOption;
  includeValuesInResponse?: boolean;
  responseValueRenderOption?: SheetValueRenderOption;
  responseDateTimeRenderOption?: SheetDateTimeRenderOption;
}

export interface SheetUpdateResult {
  spreadsheetId: string;
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
  updatedData: SheetValueRange | null;
}

export interface SheetBatchUpdateResult {
  spreadsheetId: string;
  totalUpdatedRows: number;
  totalUpdatedColumns: number;
  totalUpdatedCells: number;
  totalUpdatedSheets: number;
  responses: SheetUpdateResult[];
}

/**
 * A zero-based rectangular grid write. `null` clears the corresponding cell.
 * Strings beginning with `=` remain strings; formulas must use an explicit
 * higher-level formula codec instead of this raw transport operation.
 */
export interface AtomicCellUpdate {
  kind: "updateCells";
  sheetId: number;
  startRowIndex: number;
  startColumnIndex: number;
  values: readonly (readonly SheetCellInput[])[];
}

/** Append rows to the current logical end of a sheet. */
export interface AtomicRowAppend {
  kind: "appendRows";
  sheetId: number;
  values: readonly (readonly SheetCellInput[])[];
}

/** A zero-based, end-exclusive row deletion. */
export interface AtomicRowDelete {
  kind: "deleteRows";
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
}

export type AtomicMutation =
  | AtomicCellUpdate
  | AtomicRowAppend
  | AtomicRowDelete;

export interface AtomicBatchUpdateOptions {
  includeSpreadsheetInResponse?: boolean;
  responseIncludeGridData?: boolean;
  responseRanges?: readonly string[];
}

export interface AtomicBatchUpdateResult {
  spreadsheetId: string;
  requestCount: number;
  replies: readonly unknown[];
}

export type TransportOperationKind =
  | "getSpreadsheetMetadata"
  | "get"
  | "batchGet"
  | "batchUpdate"
  | "atomicBatchUpdate";

export interface TransportOperationContext {
  kind: TransportOperationKind;
  operationClass:
    | "read"
    | "idempotent-write"
    | "append"
    | "structural-delete"
    | "write";
  spreadsheetId: string;
  ranges: readonly string[];
  requestCount: number;
  /** Whether retrying the operation cannot duplicate a logical mutation. */
  idempotent: boolean;
}

/** Synchronous interception point used by the retry/deadline layer. */
export interface TransportInvoker {
  invoke<T>(context: TransportOperationContext, operation: () => T): T;
}

/**
 * Injectable synchronous transport used by the query planner. All indices in
 * atomic mutations are zero-based to match the Sheets v4 grid API.
 */
export interface SheetsTransport {
  getSpreadsheetMetadata(spreadsheetId: string): SpreadsheetMetadata;

  get(
    spreadsheetId: string,
    range: string,
    options?: SheetReadOptions,
  ): SheetValueRange;

  batchGet(
    spreadsheetId: string,
    ranges: readonly string[],
    options?: SheetReadOptions,
  ): SheetBatchGetResult;

  batchUpdate(
    spreadsheetId: string,
    updates: readonly SheetValueUpdate[],
    options?: SheetBatchUpdateOptions,
  ): SheetBatchUpdateResult;

  atomicBatchUpdate(
    spreadsheetId: string,
    mutations: readonly AtomicMutation[],
    options?: AtomicBatchUpdateOptions,
  ): AtomicBatchUpdateResult;
}
