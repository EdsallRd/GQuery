import { GQueryCache } from "./cache";
import { GQueryRow } from "./types";
/**
 * Convert a raw cell value into its parsed form. Single-pass: handles
 * booleans, MM/DD/YYYY dates, and JSON object/array literals. Anything
 * that doesn't match is returned as-is.
 */
export declare function decodeCellValue(raw: any): any;
/**
 * Encode a value for writing to a sheet cell.
 * - Dates are converted to locale strings.
 * - Plain objects/arrays are JSON-stringified.
 * - All other values are returned as-is.
 */
export declare function encodeCellValue(value: any): any;
/**
 * Normalize a data object for schema validation:
 * empty strings are treated as undefined (equivalent to a blank cell).
 */
export declare function normalizeForSchema(data: Record<string, any>): Record<string, any>;
/**
 * Parse raw sheet values into GQueryRow objects with metadata. Performs
 * the single-pass type conversion (boolean/date/JSON) inline so callers
 * don't need a second walk over the result.
 *
 * @param headers Column headers from the sheet
 * @param values Raw values from the sheet (without header row)
 * @param rowOffset Number of header rows above the data (default 1)
 */
export declare function parseRows(headers: string[], values: any[][], rowOffset?: number): GQueryRow[];
/**
 * Convert a 0-based column index to its A1 letters (0 -> A, 25 -> Z, 26 -> AA).
 */
export declare function columnLetter(index: number): string;
/**
 * Build an A1 range covering `limit` data rows starting at `offset` (0-based).
 * Includes the header row when offset is 0 so callers can extract headers
 * from the same payload. Returns just the sheet name when neither bound is set.
 */
export declare function buildA1Range(sheetName: string, options?: {
    offset?: number;
    limit?: number;
    lastColumn?: number;
}): string;
/**
 * Fetch all data from a sheet including headers. Consults the cache if a
 * `GQueryCache` is provided and writes the result back on miss.
 */
export declare function fetchSheetData(spreadsheetId: string, sheetName: string, cache?: GQueryCache): {
    headers: string[];
    rows: GQueryRow[];
};
