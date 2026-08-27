import type {
  AtomicBatchUpdateOptions,
  AtomicBatchUpdateResult,
  AtomicMutation,
  SheetBatchGetResult,
  SheetBatchUpdateOptions,
  SheetBatchUpdateResult,
  SheetMajorDimension,
  SheetReadOptions,
  SheetsTransport,
  SpreadsheetMetadata,
  SheetUpdateResult,
  SheetValueRange,
  SheetValueUpdate,
  TransportInvoker,
  TransportOperationContext,
} from "./contracts";
import {
  cloneRawMatrix,
  cloneSheetInputMatrix,
  encodeAtomicRows,
  normalizeReturnedMatrix,
} from "./raw-values";

export interface AppsScriptSheetsTransportOptions {
  /** Override the global advanced Sheets service, primarily for tests. */
  service?: GoogleAppsScript.Sheets;
  /** Synchronous deadline/retry/telemetry interception point. */
  invoker?: TransportInvoker;
}

function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function nonEmptyMatrix(
  values: readonly (readonly unknown[])[],
  label: string,
): void {
  if (values.length === 0 || values.every((row) => row.length === 0)) {
    throw new TypeError(`${label} must contain at least one cell.`);
  }
}

export function atomicMutationToSheetsRequest(
  mutation: AtomicMutation,
): GoogleAppsScript.Sheets.Schema.Request {
  nonNegativeInteger("sheetId", mutation.sheetId);

  if (mutation.kind === "deleteRows") {
    nonNegativeInteger("startRowIndex", mutation.startRowIndex);
    nonNegativeInteger("endRowIndex", mutation.endRowIndex);
    if (mutation.endRowIndex <= mutation.startRowIndex) {
      throw new RangeError("endRowIndex must be greater than startRowIndex.");
    }
    return {
      deleteDimension: {
        range: {
          sheetId: mutation.sheetId,
          dimension: "ROWS",
          startIndex: mutation.startRowIndex,
          endIndex: mutation.endRowIndex,
        },
      },
    };
  }

  const matrix = cloneSheetInputMatrix(mutation.values, `${mutation.kind}.values`);
  nonEmptyMatrix(matrix, `${mutation.kind}.values`);
  const rows = encodeAtomicRows(matrix) as GoogleAppsScript.Sheets.Schema.RowData[];

  if (mutation.kind === "appendRows") {
    return {
      appendCells: {
        sheetId: mutation.sheetId,
        rows,
        fields: "userEnteredValue",
      },
    };
  }

  nonNegativeInteger("startRowIndex", mutation.startRowIndex);
  nonNegativeInteger("startColumnIndex", mutation.startColumnIndex);
  return {
    updateCells: {
      start: {
        sheetId: mutation.sheetId,
        rowIndex: mutation.startRowIndex,
        columnIndex: mutation.startColumnIndex,
      },
      rows,
      fields: "userEnteredValue",
    },
  };
}

function normalizeDimension(
  value: string | undefined,
  fallback: SheetMajorDimension,
): SheetMajorDimension {
  return value === "COLUMNS" ? "COLUMNS" : value === "ROWS" ? "ROWS" : fallback;
}

function normalizeValueRange(
  response: GoogleAppsScript.Sheets.Schema.ValueRange | undefined,
  fallbackRange: string,
  fallbackDimension: SheetMajorDimension,
): SheetValueRange {
  return {
    range: response?.range ?? fallbackRange,
    majorDimension: normalizeDimension(response?.majorDimension, fallbackDimension),
    values: normalizeReturnedMatrix(response?.values),
  };
}

function normalizeUpdate(
  response: GoogleAppsScript.Sheets.Schema.UpdateValuesResponse | undefined,
  spreadsheetId: string,
  fallbackRange: string,
  fallbackDimension: SheetMajorDimension,
): SheetUpdateResult {
  return {
    spreadsheetId: response?.spreadsheetId ?? spreadsheetId,
    updatedRange: response?.updatedRange ?? fallbackRange,
    updatedRows: response?.updatedRows ?? 0,
    updatedColumns: response?.updatedColumns ?? 0,
    updatedCells: response?.updatedCells ?? 0,
    updatedData: response?.updatedData
      ? normalizeValueRange(response.updatedData, fallbackRange, fallbackDimension)
      : null,
  };
}

export class AppsScriptSheetsTransport implements SheetsTransport {
  private readonly injectedService?: GoogleAppsScript.Sheets;
  private readonly invoker?: TransportInvoker;

  public constructor(options: AppsScriptSheetsTransportOptions = {}) {
    this.injectedService = options.service;
    this.invoker = options.invoker;
  }

  private service(): GoogleAppsScript.Sheets {
    const service =
      this.injectedService ?? (typeof Sheets === "undefined" ? undefined : Sheets);
    if (!service?.Spreadsheets?.Values) {
      throw new Error(
        "The Apps Script Advanced Sheets service is unavailable. Enable the Sheets v4 advanced service before executing GQuery.",
      );
    }
    return service;
  }

  private invoke<T>(context: TransportOperationContext, operation: () => T): T {
    return this.invoker ? this.invoker.invoke(context, operation) : operation();
  }

  public getSpreadsheetMetadata(spreadsheetId: string): SpreadsheetMetadata {
    const response = this.invoke(
      {
        kind: "getSpreadsheetMetadata",
        operationClass: "read",
        spreadsheetId,
        ranges: [],
        requestCount: 1,
        idempotent: true,
      },
      () =>
        this.service().Spreadsheets.get(spreadsheetId, {
          includeGridData: false,
          fields:
            "spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
        }),
    );

    return {
      spreadsheetId: response?.spreadsheetId ?? spreadsheetId,
      sheets: (response?.sheets ?? []).map(({ properties }) => {
        const sheetId = properties?.sheetId;
        const title = properties?.title;
        if (sheetId === undefined || title === undefined) {
          throw new Error("Sheets metadata response omitted a sheet ID or title.");
        }
        return {
          sheetId,
          title,
          rowCount: properties?.gridProperties?.rowCount ?? 0,
          columnCount: properties?.gridProperties?.columnCount ?? 0,
        };
      }),
    };
  }

  public get(
    spreadsheetId: string,
    range: string,
    options: SheetReadOptions = {},
  ): SheetValueRange {
    const majorDimension = options.majorDimension ?? "ROWS";
    const response = this.invoke(
      {
        kind: "get",
        operationClass: "read",
        spreadsheetId,
        ranges: [range],
        requestCount: 1,
        idempotent: true,
      },
      () =>
        this.service().Spreadsheets.Values.get(spreadsheetId, range, {
          majorDimension,
          valueRenderOption: options.valueRenderOption ?? "UNFORMATTED_VALUE",
          dateTimeRenderOption: options.dateTimeRenderOption ?? "SERIAL_NUMBER",
        }),
    );
    return normalizeValueRange(response, range, majorDimension);
  }

  public batchGet(
    spreadsheetId: string,
    ranges: readonly string[],
    options: SheetReadOptions = {},
  ): SheetBatchGetResult {
    if (ranges.length === 0) return { spreadsheetId, valueRanges: [] };
    const majorDimension = options.majorDimension ?? "ROWS";
    const response = this.invoke(
      {
        kind: "batchGet",
        operationClass: "read",
        spreadsheetId,
        ranges,
        requestCount: ranges.length,
        idempotent: true,
      },
      () =>
        this.service().Spreadsheets.Values.batchGet(spreadsheetId, {
          ranges: [...ranges],
          majorDimension,
          valueRenderOption: options.valueRenderOption ?? "UNFORMATTED_VALUE",
          dateTimeRenderOption: options.dateTimeRenderOption ?? "SERIAL_NUMBER",
        }),
    );

    return {
      spreadsheetId: response?.spreadsheetId ?? spreadsheetId,
      valueRanges: ranges.map((range, index) =>
        normalizeValueRange(response?.valueRanges?.[index], range, majorDimension),
      ),
    };
  }

  public batchUpdate(
    spreadsheetId: string,
    updates: readonly SheetValueUpdate[],
    options: SheetBatchUpdateOptions = {},
  ): SheetBatchUpdateResult {
    if (updates.length === 0) {
      return {
        spreadsheetId,
        totalUpdatedRows: 0,
        totalUpdatedColumns: 0,
        totalUpdatedCells: 0,
        totalUpdatedSheets: 0,
        responses: [],
      };
    }

    const data: GoogleAppsScript.Sheets.Schema.ValueRange[] = updates.map(
      (update) => ({
        range: update.range,
        majorDimension: update.majorDimension ?? "ROWS",
        values: cloneRawMatrix(update.values, `values for ${update.range}`),
      }),
    );
    const response = this.invoke(
      {
        kind: "batchUpdate",
        operationClass: "idempotent-write",
        spreadsheetId,
        ranges: updates.map(({ range }) => range),
        requestCount: updates.length,
        idempotent: true,
      },
      () =>
        this.service().Spreadsheets.Values.batchUpdate(
          {
            data,
            valueInputOption: options.valueInputOption ?? "RAW",
            includeValuesInResponse: options.includeValuesInResponse,
            responseValueRenderOption: options.responseValueRenderOption,
            responseDateTimeRenderOption: options.responseDateTimeRenderOption,
          },
          spreadsheetId,
        ),
    );

    return {
      spreadsheetId: response?.spreadsheetId ?? spreadsheetId,
      totalUpdatedRows: response?.totalUpdatedRows ?? 0,
      totalUpdatedColumns: response?.totalUpdatedColumns ?? 0,
      totalUpdatedCells: response?.totalUpdatedCells ?? 0,
      totalUpdatedSheets: response?.totalUpdatedSheets ?? 0,
      responses: updates.map((update, index) =>
        normalizeUpdate(
          response?.responses?.[index],
          spreadsheetId,
          update.range,
          update.majorDimension ?? "ROWS",
        ),
      ),
    };
  }

  public atomicBatchUpdate(
    spreadsheetId: string,
    mutations: readonly AtomicMutation[],
    options: AtomicBatchUpdateOptions = {},
  ): AtomicBatchUpdateResult {
    if (mutations.length === 0) {
      return { spreadsheetId, requestCount: 0, replies: [] };
    }
    const requests = mutations.map(atomicMutationToSheetsRequest);
    const operationClass = mutations.some(({ kind }) => kind === "appendRows")
      ? "append"
      : mutations.some(({ kind }) => kind === "deleteRows")
        ? "structural-delete"
        : "idempotent-write";
    const response = this.invoke(
      {
        kind: "atomicBatchUpdate",
        operationClass,
        spreadsheetId,
        ranges: [],
        requestCount: requests.length,
        idempotent: mutations.every(({ kind }) => kind === "updateCells"),
      },
      () =>
        this.service().Spreadsheets.batchUpdate(
          {
            requests,
            includeSpreadsheetInResponse: options.includeSpreadsheetInResponse,
            responseIncludeGridData: options.responseIncludeGridData,
            responseRanges: options.responseRanges
              ? [...options.responseRanges]
              : undefined,
          },
          spreadsheetId,
        ),
    );
    return {
      spreadsheetId: response?.spreadsheetId ?? spreadsheetId,
      requestCount: requests.length,
      replies: response?.replies ?? [],
    };
  }
}
