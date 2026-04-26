import { callHandler } from "./ratelimit";
import { GQueryRow } from "./types";

/**
 * Try to parse a string as a JSON object or array. Returns the original
 * value if it is not valid JSON or not an object/array literal.
 */
function tryParseJson(value: string): any {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // not valid JSON – fall through
    }
  }
  return value;
}

/**
 * Encode a value for writing to a sheet cell.
 * - Dates are converted to locale strings.
 * - Plain objects/arrays are JSON-stringified.
 * - All other values are returned as-is.
 */
export function encodeCellValue(value: any): any {
  if (value instanceof Date) {
    return value.toLocaleString();
  }
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Normalize a data object for schema validation:
 * empty strings are treated as undefined (equivalent to a blank cell).
 */
export function normalizeForSchema(
  data: Record<string, any>,
): Record<string, any> {
  const normalized: Record<string, any> = {};
  for (const key of Object.keys(data)) {
    normalized[key] = data[key] === "" ? undefined : data[key];
  }
  return normalized;
}

/**
 * Parse raw sheet values into GQueryRow objects with metadata
 * @param headers Column headers from the sheet
 * @param values Raw values from the sheet (without header row)
 * @returns Array of GQueryRow objects
 */
export function parseRows(headers: string[], values: any[][]): GQueryRow[] {
  return values.map((row, rowIndex) => {
    const obj: GQueryRow = {
      __meta: {
        rowNum: rowIndex + 2, // +2 because header is row 1, data starts at row 2
        colLength: headers.length,
      },
    } as GQueryRow;

    headers.forEach((header: string, i: number) => {
      const raw = row[i] !== undefined ? row[i] : "";
      obj[header] = typeof raw === "string" ? tryParseJson(raw) : raw;
    });

    return obj;
  });
}

/**
 * Fetch all data from a sheet including headers
 * @param spreadsheetId The ID of the spreadsheet
 * @param sheetName The name of the sheet to fetch
 * @returns Object containing headers and rows
 */
export function fetchSheetData(
  spreadsheetId: string,
  sheetName: string,
): { headers: string[]; rows: GQueryRow[] } {
  const response = callHandler(() =>
    Sheets!.Spreadsheets!.Values!.get(spreadsheetId, sheetName),
  );

  const values = response.values || [];

  if (values.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = values[0].map((h: any) => String(h));
  const rows = parseRows(headers, values.slice(1));

  return { headers, rows };
}
