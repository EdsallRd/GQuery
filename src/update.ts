import { GQueryTableFactory } from "./index";
import { callHandler } from "./ratelimit";
import {
  GQueryResult,
  GQueryRow,
  GQuerySchemaError,
  StandardSchemaV1,
} from "./types";
import { encodeCellValue, fetchSheetData, normalizeForSchema } from "./utils";

/**
 * Validate a single row through a Standard Schema, preserving __meta.
 * Throws GQuerySchemaError if validation fails.
 */
function applySchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  row: GQueryRow,
): GQueryRow<T> {
  const { __meta, ...data } = row;
  const result = schema["~standard"].validate(normalizeForSchema(data));

  if (result instanceof Promise) {
    throw new Error(
      "GQuery does not support async schema validation. " +
        "Google Apps Script is a synchronous runtime.",
    );
  }

  if (result.issues) {
    throw new GQuerySchemaError(result.issues, data);
  }

  return { ...(result.value as object), __meta } as GQueryRow<T>;
}

export function updateInternal<
  T extends Record<string, any> = Record<string, any>,
>(
  GQueryTableFactory: GQueryTableFactory<T>,
  updateFn: (row: GQueryRow<T>) => Partial<T>,
): GQueryResult<T> {
  const spreadsheetId = GQueryTableFactory.GQueryTable.spreadsheetId;
  const sheetName = GQueryTableFactory.GQueryTable.sheetName;
  const schema = GQueryTableFactory.GQueryTable.schema;
  const range = sheetName;

  const { headers, rows } = fetchSheetData(spreadsheetId, range);

  if (headers.length === 0) {
    return { rows: [], headers: [] };
  }

  // Filter rows if filter is specified
  const filteredRows = GQueryTableFactory.filterOption
    ? rows.filter((row) => {
        try {
          return GQueryTableFactory.filterOption!(row);
        } catch (error) {
          console.error("Error filtering row:", error);
          return false;
        }
      })
    : rows;

  // Apply updates to filtered rows
  const updatedRows: GQueryRow[] = filteredRows.map((row) => {
    const updatedRow: GQueryRow = { ...row };
    try {
      const result = updateFn(updatedRow as GQueryRow<T>);
      if (result && typeof result === "object") {
        Object.assign(updatedRow, result);
      }
    } catch (error) {
      console.error("Error updating row:", error);
    }
    return updatedRow;
  });

  // Collect changed cells
  const changedCells = new Map<string, any[]>();

  updatedRows.forEach((updatedRow) => {
    const rowIndex = updatedRow.__meta.rowNum - 2;
    const originalRow = rows[rowIndex];

    headers.forEach((header, columnIndex) => {
      const originalValue = encodeCellValue(originalRow[header]);
      let updatedValue = encodeCellValue(updatedRow[header]);

      // Skip if values are the same
      if (originalValue === updatedValue) return;

      // Only update if value changed or is being set/cleared
      if (updatedValue !== undefined && updatedValue !== null) {
        const columnLetter = getColumnLetter(columnIndex);
        const cellRange = `${sheetName}!${columnLetter}${updatedRow.__meta.rowNum}`;
        changedCells.set(cellRange, [[updatedValue]]);
      } else if (originalValue !== undefined && originalValue !== null) {
        const columnLetter = getColumnLetter(columnIndex);
        const cellRange = `${sheetName}!${columnLetter}${updatedRow.__meta.rowNum}`;
        changedCells.set(cellRange, [[updatedValue || ""]]);
      }
    });
  });

  // Perform batch update if there are changes
  if (changedCells.size > 0) {
    const optimizedUpdates = optimizeRanges(changedCells);

    const batchUpdateRequest = {
      data: optimizedUpdates,
      valueInputOption: "USER_ENTERED",
    };

    callHandler(() =>
      Sheets!.Spreadsheets!.Values!.batchUpdate(
        batchUpdateRequest,
        spreadsheetId,
      ),
    );
  }

  // Apply schema validation if a schema is attached
  const typedRows: GQueryRow<T>[] = schema
    ? updatedRows.map((row) => applySchema(schema, row))
    : (updatedRows as unknown as GQueryRow<T>[]);

  return {
    rows: filteredRows.length > 0 ? typedRows : [],
    headers,
  };
}

/**
 * Convert column index to column letter (0 -> A, 1 -> B, etc.)
 */
function getColumnLetter(columnIndex: number): string {
  let columnLetter = "";
  let index = columnIndex;

  while (index >= 0) {
    columnLetter = String.fromCharCode(65 + (index % 26)) + columnLetter;
    index = Math.floor(index / 26) - 1;
  }

  return columnLetter;
}

/**
 * Optimize update ranges by combining adjacent cells in the same column
 * into contiguous row segments.
 */
function optimizeRanges(
  changedCells: Map<string, any[]>,
): { range: string; values: any[][] }[] {
  const columnGroups = new Map<string, Map<number, any>>();

  for (const [cellRange, value] of changedCells.entries()) {
    const matches = cellRange.match(/([^!]+)!([A-Z]+)(\d+)$/);
    if (!matches) continue;

    const sheet = matches[1];
    const columnLetter = matches[2];
    const rowNumber = parseInt(matches[3], 10);
    const columnKey = `${sheet}!${columnLetter}`;

    if (!columnGroups.has(columnKey)) {
      columnGroups.set(columnKey, new Map());
    }
    columnGroups.get(columnKey)!.set(rowNumber, value[0][0]);
  }

  const optimizedUpdates: { range: string; values: any[][] }[] = [];

  for (const [columnKey, rowsMap] of columnGroups.entries()) {
    const rowNumbers = Array.from(rowsMap.keys()).sort((a, b) => a - b);
    if (rowNumbers.length === 0) continue;

    const [sheet, column] = columnKey.split("!");

    let start = rowNumbers[0];
    let groupValues: any[][] = [[rowsMap.get(start)]];

    for (let i = 1; i < rowNumbers.length; i++) {
      const rowNum = rowNumbers[i];
      const prev = rowNumbers[i - 1];
      if (rowNum === prev + 1) {
        groupValues.push([rowsMap.get(rowNum)]);
      } else {
        const end = prev;
        const rangeKey =
          start === end
            ? `${sheet}!${column}${start}`
            : `${sheet}!${column}${start}:${column}${end}`;
        optimizedUpdates.push({ range: rangeKey, values: groupValues });
        start = rowNum;
        groupValues = [[rowsMap.get(rowNum)]];
      }
    }

    const last = rowNumbers[rowNumbers.length - 1];
    const rangeKey =
      start === last
        ? `${sheet}!${column}${start}`
        : `${sheet}!${column}${start}:${column}${last}`;
    optimizedUpdates.push({ range: rangeKey, values: groupValues });
  }

  return optimizedUpdates;
}
