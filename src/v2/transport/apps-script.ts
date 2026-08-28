import type {
  AtomicBatchUpdateOptions,
  AtomicBatchUpdateResult,
  AtomicMutation,
  SheetBatchGetResult,
  SheetBatchUpdateOptions,
  SheetBatchUpdateResult,
  SheetCellValue,
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
  normalizeReturnedMatrix,
} from "./raw-values";
import {
  ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT,
  assertAtomicBatchPayloadSize,
  atomicMutationToSheetsRequest,
  utf8ByteLength,
} from "./atomic-request";
import { RequestPayloadTooLargeError } from "../infrastructure/errors";
import {
  columnIndexToLetter,
  parseA1Range,
  sheetNameFromRange,
  sheetRange,
} from "./a1";

export { atomicMutationToSheetsRequest } from "./atomic-request";

export interface AppsScriptSheetsTransportOptions {
  /** Override the global advanced Sheets service, primarily for tests. */
  service?: GoogleAppsScript.Sheets;
  /** Synchronous deadline/retry/telemetry interception point. */
  invoker?: TransportInvoker;
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

function valuesBatchPayloadBytes(
  data: readonly GoogleAppsScript.Sheets.Schema.ValueRange[],
  options: SheetBatchUpdateOptions,
): number {
  return utf8ByteLength(JSON.stringify({
    data,
    valueInputOption: options.valueInputOption ?? "RAW",
    includeValuesInResponse: options.includeValuesInResponse,
    responseValueRenderOption: options.responseValueRenderOption,
    responseDateTimeRenderOption: options.responseDateTimeRenderOption,
  }));
}

function valueRangeData(
  update: SheetValueUpdate,
): GoogleAppsScript.Sheets.Schema.ValueRange {
  return {
    range: update.range,
    majorDimension: update.majorDimension ?? "ROWS",
    values: cloneRawMatrix(update.values, `values for ${update.range}`),
  };
}

function localCellRange(
  sheetName: string | null,
  startRowIndex: number,
  startColumnIndex: number,
  rowCount: number,
  columnCount: number,
): string {
  const start = `${columnIndexToLetter(startColumnIndex)}${startRowIndex + 1}`;
  const end = `${columnIndexToLetter(startColumnIndex + columnCount - 1)}${startRowIndex + rowCount}`;
  const local = start === end ? start : `${start}:${end}`;
  return sheetName === null ? local : sheetRange(sheetName, local);
}

/** Recursively split one oversized Values range along its declared dimension. */
function splitValueUpdate(
  update: SheetValueUpdate,
  options: SheetBatchUpdateOptions,
  rowOffset = 0,
  columnOffset = 0,
): readonly SheetValueUpdate[] {
  const data = valueRangeData(update);
  const bytes = valuesBatchPayloadBytes([data], options);
  if (bytes <= ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT) return [update];

  const values = data.values ?? [];
  const majorDimension = update.majorDimension ?? "ROWS";
  const parsed = parseA1Range(update.range);
  if (parsed.startRowIndex === undefined || parsed.startColumnIndex === undefined) {
    throw new RequestPayloadTooLargeError(
      "values.batchUpdate",
      bytes,
      ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT,
    );
  }

  const make = (
    nextValues: readonly (readonly unknown[])[],
    nextRowOffset: number,
    nextColumnOffset: number,
  ): SheetValueUpdate => {
    const rowCount = majorDimension === "ROWS"
      ? nextValues.length
      : nextValues.reduce((maximum, column) => Math.max(maximum, column.length), 0);
    const columnCount = majorDimension === "ROWS"
      ? nextValues.reduce((maximum, row) => Math.max(maximum, row.length), 0)
      : nextValues.length;
    return {
      range: localCellRange(
        parsed.sheetName,
        parsed.startRowIndex! + nextRowOffset,
        parsed.startColumnIndex! + nextColumnOffset,
        rowCount,
        columnCount,
      ),
      values: nextValues as readonly (readonly SheetCellValue[])[],
      majorDimension,
    };
  };

  if (values.length > 1) {
    const midpoint = Math.ceil(values.length / 2);
    const left = make(values.slice(0, midpoint), rowOffset, columnOffset);
    const right = make(
      values.slice(midpoint),
      rowOffset + (majorDimension === "ROWS" ? midpoint : 0),
      columnOffset + (majorDimension === "COLUMNS" ? midpoint : 0),
    );
    return [
      ...splitValueUpdate(left, options, 0, 0),
      ...splitValueUpdate(right, options, 0, 0),
    ];
  }

  const inner = values[0] ?? [];
  if (inner.length > 1) {
    const midpoint = Math.ceil(inner.length / 2);
    const left = make([inner.slice(0, midpoint)], rowOffset, columnOffset);
    const right = make(
      [inner.slice(midpoint)],
      rowOffset + (majorDimension === "COLUMNS" ? midpoint : 0),
      columnOffset + (majorDimension === "ROWS" ? midpoint : 0),
    );
    return [
      ...splitValueUpdate(left, options, 0, 0),
      ...splitValueUpdate(right, options, 0, 0),
    ];
  }

  throw new RequestPayloadTooLargeError(
    "values.batchUpdate",
    bytes,
    ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT,
  );
}

function chunkValueRanges(
  data: readonly GoogleAppsScript.Sheets.Schema.ValueRange[],
  options: SheetBatchUpdateOptions,
): readonly (readonly GoogleAppsScript.Sheets.Schema.ValueRange[])[] {
  const chunks: GoogleAppsScript.Sheets.Schema.ValueRange[][] = [];
  let current: GoogleAppsScript.Sheets.Schema.ValueRange[] = [];
  for (const valueRange of data) {
    const candidate = [...current, valueRange];
    const bytes = valuesBatchPayloadBytes(candidate, options);
    if (bytes <= ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw new RequestPayloadTooLargeError(
        "values.batchUpdate",
        bytes,
        ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT,
      );
    }
    chunks.push(current);
    current = [valueRange];
    const singleBytes = valuesBatchPayloadBytes(current, options);
    if (singleBytes > ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT) {
      throw new RequestPayloadTooLargeError(
        "values.batchUpdate",
        singleBytes,
        ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT,
      );
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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
            "spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),protectedRanges(range,warningOnly))",
        }),
    );

    return {
      spreadsheetId: response?.spreadsheetId ?? spreadsheetId,
      sheets: (response?.sheets ?? []).map(({ properties, protectedRanges }) => {
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
          hasFullSheetProtection: (protectedRanges ?? []).some((protection) => {
            const range = protection.range;
            return protection.warningOnly !== true &&
              range?.sheetId === sheetId &&
              range.startRowIndex === undefined &&
              range.endRowIndex === undefined &&
              range.startColumnIndex === undefined &&
              range.endColumnIndex === undefined;
          }),
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

    const expandedUpdates = updates.flatMap((update) => splitValueUpdate(update, options));
    const data: GoogleAppsScript.Sheets.Schema.ValueRange[] = expandedUpdates.map(valueRangeData);
    const chunks = chunkValueRanges(data, options);
    const responses: SheetUpdateResult[] = [];
    let totalUpdatedRows = 0;
    let totalUpdatedColumns = 0;
    let totalUpdatedCells = 0;
    let updateIndex = 0;
    for (const chunk of chunks) {
      const chunkUpdates = expandedUpdates.slice(updateIndex, updateIndex + chunk.length);
      const response = this.invoke(
        {
          kind: "batchUpdate",
          operationClass: "idempotent-write",
          spreadsheetId,
          ranges: chunkUpdates.map(({ range }) => range),
          requestCount: chunkUpdates.length,
          idempotent: true,
        },
        () =>
          this.service().Spreadsheets.Values.batchUpdate(
            {
              data: [...chunk],
              valueInputOption: options.valueInputOption ?? "RAW",
              includeValuesInResponse: options.includeValuesInResponse,
              responseValueRenderOption: options.responseValueRenderOption,
              responseDateTimeRenderOption: options.responseDateTimeRenderOption,
            },
            spreadsheetId,
          ),
      );
      totalUpdatedRows += response?.totalUpdatedRows ?? 0;
      totalUpdatedColumns += response?.totalUpdatedColumns ?? 0;
      totalUpdatedCells += response?.totalUpdatedCells ?? 0;
      chunkUpdates.forEach((update, index) => {
        responses.push(normalizeUpdate(
          response?.responses?.[index],
          spreadsheetId,
          update.range,
          update.majorDimension ?? "ROWS",
        ));
      });
      updateIndex += chunk.length;
    }

    return {
      spreadsheetId,
      totalUpdatedRows,
      totalUpdatedColumns,
      totalUpdatedCells,
      totalUpdatedSheets: new Set(
        expandedUpdates.map((update) => sheetNameFromRange(update.range) ?? "<default-sheet>"),
      ).size,
      responses,
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
    assertAtomicBatchPayloadSize(requests, options);
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
        idempotent: mutations.every(({ kind }) =>
          kind === "updateCells" || kind === "formatCells"
        ),
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
