import { GQueryRow } from "./types";
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
 * Parse raw sheet values into GQueryRow objects with metadata
 * @param headers Column headers from the sheet
 * @param values Raw values from the sheet (without header row)
 * @returns Array of GQueryRow objects
 */
export declare function parseRows(headers: string[], values: any[][]): GQueryRow[];
/**
 * Fetch all data from a sheet including headers
 * @param spreadsheetId The ID of the spreadsheet
 * @param sheetName The name of the sheet to fetch
 * @returns Object containing headers and rows
 */
export declare function fetchSheetData(spreadsheetId: string, sheetName: string, retries?: number): {
    headers: string[];
    rows: GQueryRow[];
};
