import {
  quoteSheetName,
  sheetNameFromRange,
  sheetRange,
} from "../../a1";

export { quoteSheetName, sheetNameFromRange, sheetRange };

export interface ParsedA1Range {
  sheetName: string | null;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
}

export function columnIndexToLetter(columnIndex: number): string {
  if (!Number.isSafeInteger(columnIndex) || columnIndex < 0) {
    throw new RangeError("Column index must be a non-negative safe integer.");
  }

  let value = columnIndex + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function columnLetterToIndex(column: string): number {
  const normalized = column.replace(/\$/g, "").toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new TypeError(`Invalid A1 column: ${column}`);
  }

  let result = 0;
  for (const character of normalized) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result - 1;
}

function unqualifiedPart(range: string, sheetName: string | null): string {
  if (sheetName === null) return range;
  if (!range.startsWith("'")) return range.slice(range.indexOf("!") + 1);

  for (let index = 1; index < range.length; index += 1) {
    if (range[index] !== "'") continue;
    if (range[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (range[index + 1] === "!") return range.slice(index + 2);
    if (index === range.length - 1) return "";
    break;
  }
  throw new TypeError(`Invalid quoted A1 range: ${range}`);
}

interface Endpoint {
  row?: number;
  column?: number;
}

function parseEndpoint(value: string): Endpoint {
  const match = value.match(/^\$?([A-Za-z]+)?\$?([1-9]\d*)?$/);
  if (!match || (!match[1] && !match[2])) {
    throw new TypeError(`Invalid A1 endpoint: ${value}`);
  }
  return {
    column: match[1] ? columnLetterToIndex(match[1]) : undefined,
    row: match[2] ? Number(match[2]) - 1 : undefined,
  };
}

/** Parse sheet-qualified or local A1 notation into zero-based grid bounds. */
export function parseA1Range(range: string): ParsedA1Range {
  if (typeof range !== "string" || range.length === 0) {
    throw new TypeError("An A1 range must be a non-empty string.");
  }

  const sheetName = sheetNameFromRange(range);
  const local = unqualifiedPart(range, sheetName);
  if (local.length === 0) return { sheetName };

  const pieces = local.split(":");
  if (pieces.length > 2) throw new TypeError(`Invalid A1 range: ${range}`);
  const start = parseEndpoint(pieces[0]);
  const end = pieces.length === 2 ? parseEndpoint(pieces[1]) : start;

  if (
    start.row !== undefined &&
    end.row !== undefined &&
    end.row < start.row
  ) {
    throw new RangeError(`A1 row range is reversed: ${range}`);
  }
  if (
    start.column !== undefined &&
    end.column !== undefined &&
    end.column < start.column
  ) {
    throw new RangeError(`A1 column range is reversed: ${range}`);
  }

  return {
    sheetName,
    startRowIndex: start.row,
    endRowIndex: end.row === undefined ? undefined : end.row + 1,
    startColumnIndex: start.column,
    endColumnIndex: end.column === undefined ? undefined : end.column + 1,
  };
}

export function cellRange(
  sheetName: string,
  startRowIndex: number,
  startColumnIndex: number,
  rowCount = 1,
  columnCount = 1,
): string {
  for (const [name, value, allowZero] of [
    ["startRowIndex", startRowIndex, true],
    ["startColumnIndex", startColumnIndex, true],
    ["rowCount", rowCount, false],
    ["columnCount", columnCount, false],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new RangeError(`${name} is outside the valid grid range.`);
    }
  }

  const start = `${columnIndexToLetter(startColumnIndex)}${startRowIndex + 1}`;
  const endRowIndex = startRowIndex + rowCount - 1;
  const endColumnIndex = startColumnIndex + columnCount - 1;
  const end = `${columnIndexToLetter(endColumnIndex)}${endRowIndex + 1}`;
  return sheetRange(sheetName, start === end ? start : `${start}:${end}`);
}
