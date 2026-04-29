import { GQueryCache } from "./cache";
import { callHandler } from "./ratelimit";
import { GQueryRow } from "./types";

const DATE_PATTERN =
  /^\d{1,2}\/\d{1,2}\/\d{4}(\s\d{1,2}:\d{1,2}(:\d{1,2})?)?$/;

/**
 * Convert a raw cell value into its parsed form. Single-pass: handles
 * booleans, MM/DD/YYYY dates, and JSON object/array literals. Anything
 * that doesn't match is returned as-is.
 */
export function decodeCellValue(raw: any): any {
  if (raw === undefined || raw === null || raw === "") return raw;
  if (typeof raw !== "string") return raw;

  // Booleans
  if (raw === "true" || raw === "TRUE") return true;
  if (raw === "false" || raw === "FALSE") return false;

  // Dates (MM/DD/YYYY [HH:MM[:SS]])
  if (DATE_PATTERN.test(raw)) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }

  // JSON object/array literals — fast prefix check before the parse.
  const first = raw.charCodeAt(0);
  if (first === 123 /* { */ || first === 91 /* [ */) {
    const trimmed = raw.trim();
    const last = trimmed.charCodeAt(trimmed.length - 1);
    if (
      (first === 123 && last === 125) ||
      (first === 91 && last === 93)
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // not JSON — fall through
      }
    }
  }

  return raw;
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
 * Parse raw sheet values into GQueryRow objects with metadata. Performs
 * the single-pass type conversion (boolean/date/JSON) inline so callers
 * don't need a second walk over the result.
 *
 * @param headers Column headers from the sheet
 * @param values Raw values from the sheet (without header row)
 * @param rowOffset Number of header rows above the data (default 1)
 */
export function parseRows(
  headers: string[],
  values: any[][],
  rowOffset: number = 1,
): GQueryRow[] {
  const colLength = headers.length;
  return values.map((row, rowIndex) => {
    const obj: GQueryRow = {
      __meta: {
        rowNum: rowIndex + rowOffset + 1,
        colLength,
      },
    } as GQueryRow;
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = decodeCellValue(row[i] !== undefined ? row[i] : "");
    }
    return obj;
  });
}

/**
 * Convert a 0-based column index to its A1 letters (0 -> A, 25 -> Z, 26 -> AA).
 */
export function columnLetter(index: number): string {
  let out = "";
  let n = index;
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

/**
 * Build an A1 range covering `limit` data rows starting at `offset` (0-based).
 * Includes the header row when offset is 0 so callers can extract headers
 * from the same payload. Returns just the sheet name when neither bound is set.
 */
export function buildA1Range(
  sheetName: string,
  options: { offset?: number; limit?: number; lastColumn?: number } = {},
): string {
  const { offset, limit, lastColumn } = options;
  if (offset === undefined && limit === undefined) return sheetName;

  const startRow = (offset ?? 0) + 1; // include header row
  const endRow =
    limit === undefined ? "" : String((offset ?? 0) + 1 + (limit ?? 0));
  const lastCol =
    lastColumn !== undefined && lastColumn > 0
      ? columnLetter(lastColumn - 1)
      : "";

  if (lastCol) {
    return `${sheetName}!A${startRow}:${lastCol}${endRow}`;
  }
  return `${sheetName}!${startRow}:${endRow}`;
}

/**
 * Fetch all data from a sheet including headers. Consults the cache if a
 * `GQueryCache` is provided and writes the result back on miss.
 */
export function fetchSheetData(
  spreadsheetId: string,
  sheetName: string,
  cache?: GQueryCache,
): { headers: string[]; rows: GQueryRow[] } {
  const keyOpts = {
    range: "all",
    valueRender: "FORMATTED_VALUE",
    dateRender: "FORMATTED_STRING",
  } as const;

  if (cache?.enabled) {
    const hit = cache.get(sheetName, keyOpts);
    if (hit) return hit;
  }

  const response = callHandler(
    () => Sheets!.Spreadsheets!.Values!.get(spreadsheetId, sheetName),
    20,
    { operation: `Values.get(${sheetName})` },
  );

  const values = response.values || [];
  if (values.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = values[0].map((h: any) => String(h));
  const rows = parseRows(headers, values.slice(1));
  const result = { headers, rows };

  if (cache?.enabled) {
    cache.put(sheetName, result, keyOpts);
  }
  return result;
}
