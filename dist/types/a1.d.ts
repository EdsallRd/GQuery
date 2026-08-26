/** Quote a sheet title for use in Google Sheets A1 notation. */
export declare function quoteSheetName(sheetName: string): string;
/** Build an A1 range from a literal sheet title and an optional cell range. */
export declare function sheetRange(sheetName: string, range?: string): string;
/** Extract a literal sheet title from a sheet-qualified A1 range. */
export declare function sheetNameFromRange(range: string): string | null;
