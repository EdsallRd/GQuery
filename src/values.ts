import { sheetNameFromRange } from "./a1";
import { invalidateSheet } from "./cache";
import { callHandler } from "./ratelimit";
import type {
  GQueryAppendValuesOptions,
  GQueryAppendValuesResult,
  GQueryBatchUpdateValuesResult,
  GQueryCellValue,
  GQueryGetValuesOptions,
  GQueryUpdateValuesResult,
  GQueryValueRangeInput,
  GQueryValueRangeResult,
  GQueryWriteValuesOptions,
} from "./types";

interface ValuesClient {
  spreadsheetId: string;
  retries: number;
}

function valuesMatrix(
  values: readonly (readonly GQueryCellValue[])[],
): GQueryCellValue[][] {
  if (!Array.isArray(values)) throw new TypeError("Values must be a two-dimensional array.");
  return values.map((row) => {
    if (!Array.isArray(row)) throw new TypeError("Each values row must be an array.");
    return row.map((value) => {
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new TypeError("Sheet cell values must be strings, numbers, booleans, or null.");
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError("Sheet numeric values must be finite.");
      }
      return value;
    });
  });
}

function normalizedValueRange(
  response: GoogleAppsScript.Sheets.Schema.ValueRange | undefined,
  fallbackRange: string,
): GQueryValueRangeResult {
  return {
    range: response?.range ?? fallbackRange,
    majorDimension:
      response?.majorDimension === "COLUMNS" ? "COLUMNS" : "ROWS",
    values: (response?.values ?? []) as GQueryCellValue[][],
  };
}

function normalizedUpdate(
  response: GoogleAppsScript.Sheets.Schema.UpdateValuesResponse | undefined,
  spreadsheetId: string,
  fallbackRange: string,
): GQueryUpdateValuesResult {
  return {
    spreadsheetId: response?.spreadsheetId ?? spreadsheetId,
    updatedRange: response?.updatedRange ?? fallbackRange,
    updatedRows: response?.updatedRows ?? 0,
    updatedColumns: response?.updatedColumns ?? 0,
    updatedCells: response?.updatedCells ?? 0,
    updatedData: response?.updatedData
      ? normalizedValueRange(response.updatedData, fallbackRange)
      : null,
  };
}

function invalidateRanges(ranges: readonly string[]): void {
  const sheetNames = new Set(
    ranges.map(sheetNameFromRange).filter((name): name is string => name !== null),
  );
  sheetNames.forEach(invalidateSheet);
}

export function getValuesInternal(
  client: ValuesClient,
  range: string,
  options: GQueryGetValuesOptions = {},
): GQueryValueRangeResult {
  const response = callHandler(
    () =>
      Sheets!.Spreadsheets!.Values!.get(client.spreadsheetId, range, {
        majorDimension: options.majorDimension,
        valueRenderOption: options.valueRenderOption,
        dateTimeRenderOption: options.dateTimeRenderOption,
      }),
    client.retries,
    "values.get",
  );
  return normalizedValueRange(response, range);
}

export function updateValuesInternal(
  client: ValuesClient,
  range: string,
  values: readonly (readonly GQueryCellValue[])[],
  options: GQueryWriteValuesOptions = {},
): GQueryUpdateValuesResult {
  const response = callHandler(
    () =>
      Sheets!.Spreadsheets!.Values!.update(
        { values: valuesMatrix(values) },
        client.spreadsheetId,
        range,
        {
          valueInputOption: options.valueInputOption ?? "USER_ENTERED",
          includeValuesInResponse: options.includeValuesInResponse,
          responseValueRenderOption: options.responseValueRenderOption,
          responseDateTimeRenderOption: options.responseDateTimeRenderOption,
        },
      ),
    client.retries,
    "values.update",
  );
  invalidateRanges([range]);
  return normalizedUpdate(response, client.spreadsheetId, range);
}

export function batchUpdateValuesInternal(
  client: ValuesClient,
  ranges: readonly GQueryValueRangeInput[],
  options: GQueryWriteValuesOptions = {},
): GQueryBatchUpdateValuesResult {
  const data = ranges.map((range) => ({
    range: range.range,
    majorDimension: range.majorDimension,
    values: valuesMatrix(range.values),
  }));
  if (data.every(({ values }) => values.every((row) => row.length === 0))) {
    return {
      spreadsheetId: client.spreadsheetId,
      totalUpdatedRows: 0, totalUpdatedColumns: 0, totalUpdatedCells: 0, totalUpdatedSheets: 0,
      responses: ranges.map(({ range }) => normalizedUpdate(undefined, client.spreadsheetId, range)),
    };
  }
  const response = callHandler(
    () =>
      Sheets!.Spreadsheets!.Values!.batchUpdate(
        {
          data,
          valueInputOption: options.valueInputOption ?? "USER_ENTERED",
          includeValuesInResponse: options.includeValuesInResponse,
          responseValueRenderOption: options.responseValueRenderOption,
          responseDateTimeRenderOption: options.responseDateTimeRenderOption,
        },
        client.spreadsheetId,
      ),
    client.retries,
    "values.batchUpdate",
    ranges.length,
  );
  invalidateRanges(ranges.map(({ range }) => range));
  return {
    spreadsheetId: response?.spreadsheetId ?? client.spreadsheetId,
    totalUpdatedRows: response?.totalUpdatedRows ?? 0,
    totalUpdatedColumns: response?.totalUpdatedColumns ?? 0,
    totalUpdatedCells: response?.totalUpdatedCells ?? 0,
    totalUpdatedSheets: response?.totalUpdatedSheets ?? 0,
    responses: (response?.responses ?? []).map((item, index) =>
      normalizedUpdate(item, client.spreadsheetId, ranges[index]?.range ?? ""),
    ),
  };
}

export function appendValuesInternal(
  client: ValuesClient,
  range: string,
  values: readonly (readonly GQueryCellValue[])[],
  options: GQueryAppendValuesOptions = {},
): GQueryAppendValuesResult {
  const response = callHandler(
    () =>
      Sheets!.Spreadsheets!.Values!.append(
        { values: valuesMatrix(values) },
        client.spreadsheetId,
        range,
        {
          valueInputOption: options.valueInputOption ?? "USER_ENTERED",
          insertDataOption: options.insertDataOption ?? "INSERT_ROWS",
          includeValuesInResponse: options.includeValuesInResponse,
          responseValueRenderOption: options.responseValueRenderOption,
          responseDateTimeRenderOption: options.responseDateTimeRenderOption,
        },
      ),
    client.retries,
    "values.append",
  );
  const updatedRange = response?.updates?.updatedRange;
  if (!updatedRange) throw new Error("Sheets append did not return an updated range.");
  invalidateRanges([range]);
  return {
    ...normalizedUpdate(response.updates, client.spreadsheetId, updatedRange),
    tableRange: response.tableRange ?? null,
  };
}
