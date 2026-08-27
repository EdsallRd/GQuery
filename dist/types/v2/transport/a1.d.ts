import { quoteSheetName, sheetNameFromRange, sheetRange } from "../../a1";
export { quoteSheetName, sheetNameFromRange, sheetRange };
export interface ParsedA1Range {
    sheetName: string | null;
    startRowIndex?: number;
    endRowIndex?: number;
    startColumnIndex?: number;
    endColumnIndex?: number;
}
export declare function columnIndexToLetter(columnIndex: number): string;
export declare function columnLetterToIndex(column: string): number;
/** Parse sheet-qualified or local A1 notation into zero-based grid bounds. */
export declare function parseA1Range(range: string): ParsedA1Range;
export declare function cellRange(sheetName: string, startRowIndex: number, startColumnIndex: number, rowCount?: number, columnCount?: number): string;
