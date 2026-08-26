/** Quote a sheet title for use in Google Sheets A1 notation. */
export function quoteSheetName(sheetName: string): string {
  if (typeof sheetName !== "string" || sheetName.length === 0) {
    throw new TypeError("A sheet name must be a non-empty string.");
  }
  return `'${sheetName.replace(/'/g, "''")}'`;
}

/** Build an A1 range from a literal sheet title and an optional cell range. */
export function sheetRange(sheetName: string, range?: string): string {
  const quotedSheetName = quoteSheetName(sheetName);
  return range === undefined || range.length === 0
    ? quotedSheetName
    : `${quotedSheetName}!${range}`;
}

/** Extract a literal sheet title from a sheet-qualified A1 range. */
export function sheetNameFromRange(range: string): string | null {
  const quoted = range.match(/^'((?:[^']|'')+)'(?:!|$)/);
  if (quoted) return quoted[1].replace(/''/g, "'");

  const separator = range.indexOf("!");
  return separator > 0 ? range.slice(0, separator) : null;
}
