import { GQueryTable } from "./index";
import { callHandler } from "./ratelimit";
import {
  GQueryApiError,
  GQueryReadOptions,
  GQueryResult,
  GQueryRow,
  GQuerySchemaError,
  StandardSchemaV1,
} from "./types";
import { encodeCellValue, normalizeForSchema } from "./utils";

/**
 * Validate a single value through a Standard Schema.
 * Throws GQuerySchemaError if validation fails.
 */
function applySchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): T {
  const result = schema["~standard"].validate(value);

  if (result instanceof Promise) {
    throw new Error(
      "GQuery does not support async schema validation. " +
        "Google Apps Script is a synchronous runtime.",
    );
  }

  if (result.issues) {
    throw new GQuerySchemaError(result.issues, value as Record<string, any>);
  }

  return result.value;
}

export function appendInternal<
  T extends Record<string, any> = Record<string, any>,
>(
  table: GQueryTable<T>,
  data: T[],
  options?: Pick<GQueryReadOptions, "validate">,
): GQueryResult<T> {
  if (!data || data.length === 0) {
    return { rows: [], headers: [] };
  }

  const spreadsheetId = table.spreadsheetId;
  const sheetName = table.sheetName;
  const schema = table.schema;
  const cache = table.GQuery.cache;

  // Validate each item through the schema before writing, if requested
  const validatedData: T[] =
    schema && options?.validate
      ? data.map((item) =>
          applySchema(schema, normalizeForSchema(item as Record<string, any>)),
        )
      : data;

  // Fetch headers from the first row
  const response = callHandler(
    () =>
      Sheets!.Spreadsheets!.Values!.get(spreadsheetId, `${sheetName}!1:1`),
    20,
    { operation: `Values.get(${sheetName}!1:1)` },
  );

  if (!response || !response.values || response.values.length === 0) {
    throw new GQueryApiError(
      `Values.append(${sheetName})`,
      null,
      `Sheet "${sheetName}" not found or has no header row.`,
    );
  }

  const headers = response.values[0].map((header) => String(header));

  // Map data to rows according to header order
  const rowsToAppend = validatedData.map((item) => {
    const record = item as Record<string, any>;
    return headers.map((header) => {
      const value = record[header];
      return value !== undefined ? encodeCellValue(value) : "";
    });
  });

  let appendResponse: GoogleAppsScript.Sheets.Schema.AppendValuesResponse;
  try {
    appendResponse = callHandler(
      () =>
        Sheets!.Spreadsheets!.Values!.append(
          { values: rowsToAppend },
          spreadsheetId,
          sheetName,
          {
            valueInputOption: "USER_ENTERED",
            insertDataOption: "OVERWRITE",
            responseValueRenderOption: "FORMATTED_VALUE",
            responseDateTimeRenderOption: "FORMATTED_STRING",
            includeValuesInResponse: true,
          },
        ),
      20,
      { operation: `Values.append(${sheetName})` },
    );
  } catch (error) {
    if (error instanceof GQueryApiError) throw error;
    throw new GQueryApiError(
      `Values.append(${sheetName})`,
      null,
      `Failed to append ${rowsToAppend.length} row(s) to "${sheetName}".`,
      error,
    );
  }

  if (
    !appendResponse ||
    !appendResponse.updates ||
    !appendResponse.updates.updatedRange
  ) {
    throw new GQueryApiError(
      `Values.append(${sheetName})`,
      null,
      `Append response missing updatedRange. Payload size: ${rowsToAppend.length} rows × ${headers.length} cols.`,
    );
  }

  // Parse the updated range to get row numbers
  const updatedRange = appendResponse.updates.updatedRange;
  const rangeMatch = updatedRange.match(/([^!]+)!([A-Z]+)(\d+):([A-Z]+)(\d+)/);

  if (!rangeMatch) {
    throw new GQueryApiError(
      `Values.append(${sheetName})`,
      null,
      `Could not parse updated range: ${updatedRange}`,
    );
  }

  const startRow = parseInt(rangeMatch[3], 10);
  const endRow = parseInt(rangeMatch[5], 10);

  const expectedRowCount = data.length;
  const actualRowCount = endRow - startRow + 1;
  if (actualRowCount !== expectedRowCount) {
    console.warn(
      `Expected to append ${expectedRowCount} rows but ${actualRowCount} were appended`,
    );
  }

  cache?.invalidate(sheetName);

  // Create result rows with metadata, typed to T
  const resultRows: GQueryRow<T>[] = rowsToAppend.map((row, index) => {
    const rowObj: Record<string, any> = {
      __meta: {
        rowNum: startRow + index,
        colLength: headers.length,
      },
    };
    headers.forEach((header, colIndex) => {
      rowObj[header] = row[colIndex];
    });
    return rowObj as GQueryRow<T>;
  });

  return {
    rows: resultRows,
    headers,
  };
}
