import type {
  AtomicBatchUpdateOptions,
  AtomicBatchUpdateResult,
  AtomicMutation,
  SheetBatchGetResult,
  SheetBatchUpdateOptions,
  SheetBatchUpdateResult,
  SheetCellInput,
  SheetCellValue,
  SheetMajorDimension,
  SheetReadOptions,
  SheetsTransport,
  SpreadsheetMetadata,
  SheetUpdateResult,
  SheetValueRange,
  SheetValueUpdate,
  TransportOperationKind,
} from "./contracts";
import { parseA1Range } from "./a1";
import { isFormulaCell } from "../codecs";
import { cloneRawMatrix, cloneSheetInputMatrix } from "./raw-values";

export interface InMemorySheetSeed {
  sheetId: number;
  title: string;
  values?: readonly (readonly SheetCellInput[])[];
}

export interface InMemorySpreadsheetSeed {
  spreadsheetId: string;
  sheets: readonly InMemorySheetSeed[];
}

export interface InMemoryTransportCall {
  kind: TransportOperationKind;
  spreadsheetId: string;
  ranges: readonly string[];
  requestCount: number;
  valueRenderOption?: SheetReadOptions["valueRenderOption"];
}

interface MemorySheet {
  sheetId: number;
  title: string;
  values: SheetCellInput[][];
}

interface MemorySpreadsheet {
  spreadsheetId: string;
  sheets: MemorySheet[];
}

function cloneSheet(sheet: MemorySheet): MemorySheet {
  return {
    sheetId: sheet.sheetId,
    title: sheet.title,
    values: sheet.values.map((row) => [...row]),
  };
}

function cloneSpreadsheet(spreadsheet: MemorySpreadsheet): MemorySpreadsheet {
  return {
    spreadsheetId: spreadsheet.spreadsheetId,
    sheets: spreadsheet.sheets.map(cloneSheet),
  };
}

function validateSeed(seed: InMemorySpreadsheetSeed): MemorySpreadsheet {
  if (!seed.spreadsheetId) throw new TypeError("spreadsheetId must not be empty.");
  const sheetIds = new Set<number>();
  const titles = new Set<string>();
  const sheets = seed.sheets.map((sheet) => {
    if (!Number.isSafeInteger(sheet.sheetId) || sheet.sheetId < 0) {
      throw new RangeError("sheetId must be a non-negative safe integer.");
    }
    if (!sheet.title) throw new TypeError("Sheet title must not be empty.");
    if (sheetIds.has(sheet.sheetId)) {
      throw new Error(`Duplicate sheet ID ${sheet.sheetId}.`);
    }
    if (titles.has(sheet.title)) {
      throw new Error(`Duplicate sheet title ${sheet.title}.`);
    }
    sheetIds.add(sheet.sheetId);
    titles.add(sheet.title);
    return {
      sheetId: sheet.sheetId,
      title: sheet.title,
      values: cloneSheetInputMatrix(sheet.values ?? [], `seed ${sheet.title}`),
    };
  });
  return { spreadsheetId: seed.spreadsheetId, sheets };
}

function transpose<T>(values: T[][], blank: T): T[][] {
  const width = values.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  return Array.from({ length: width }, (_, columnIndex) =>
    values.map((row) => row[columnIndex] ?? blank),
  );
}

function trimTrailingNulls(values: SheetCellValue[][]): SheetCellValue[][] {
  const rows = values.map((row) => {
    let end = row.length;
    while (end > 0 && row[end - 1] === null) end -= 1;
    return row.slice(0, end);
  });
  let end = rows.length;
  while (end > 0 && rows[end - 1].length === 0) end -= 1;
  return rows.slice(0, end);
}

function ensureCell(sheet: MemorySheet, rowIndex: number, columnIndex: number): void {
  while (sheet.values.length <= rowIndex) sheet.values.push([]);
  const row = sheet.values[rowIndex];
  while (row.length <= columnIndex) row.push(null);
}

function writeMatrix(
  sheet: MemorySheet,
  startRowIndex: number,
  startColumnIndex: number,
  values: readonly (readonly SheetCellInput[])[],
): void {
  values.forEach((row, rowOffset) => {
    row.forEach((value, columnOffset) => {
      const rowIndex = startRowIndex + rowOffset;
      const columnIndex = startColumnIndex + columnOffset;
      ensureCell(sheet, rowIndex, columnIndex);
      sheet.values[rowIndex][columnIndex] = value;
    });
  });
}

function maxWidth(values: readonly (readonly SheetCellInput[])[]): number {
  return values.reduce((maximum, row) => Math.max(maximum, row.length), 0);
}

export class InMemorySheetsTransport implements SheetsTransport {
  private readonly spreadsheets = new Map<string, MemorySpreadsheet>();
  private readonly calls: InMemoryTransportCall[] = [];

  public constructor(seeds: readonly InMemorySpreadsheetSeed[] = []) {
    for (const seed of seeds) this.addSpreadsheet(seed);
  }

  public addSpreadsheet(seed: InMemorySpreadsheetSeed): void {
    if (this.spreadsheets.has(seed.spreadsheetId)) {
      throw new Error(`Spreadsheet ${seed.spreadsheetId} already exists.`);
    }
    this.spreadsheets.set(seed.spreadsheetId, validateSeed(seed));
  }

  public get history(): readonly InMemoryTransportCall[] {
    return this.calls.map((call) => ({ ...call, ranges: [...call.ranges] }));
  }

  public clearHistory(): void {
    this.calls.length = 0;
  }

  public snapshot(spreadsheetId: string): InMemorySpreadsheetSeed {
    const spreadsheet = this.requireSpreadsheet(spreadsheetId);
    return {
      spreadsheetId,
      sheets: spreadsheet.sheets.map((sheet) => ({
        sheetId: sheet.sheetId,
        title: sheet.title,
        values: sheet.values.map((row) => [...row]),
      })),
    };
  }

  private record(call: InMemoryTransportCall): void {
    this.calls.push({ ...call, ranges: [...call.ranges] });
  }

  private requireSpreadsheet(spreadsheetId: string): MemorySpreadsheet {
    const spreadsheet = this.spreadsheets.get(spreadsheetId);
    if (!spreadsheet) throw new Error(`Unknown spreadsheet: ${spreadsheetId}`);
    return spreadsheet;
  }

  private requireSheetById(spreadsheet: MemorySpreadsheet, sheetId: number): MemorySheet {
    const sheet = spreadsheet.sheets.find((candidate) => candidate.sheetId === sheetId);
    if (!sheet) throw new Error(`Unknown sheet ID ${sheetId}.`);
    return sheet;
  }

  private resolveRange(
    spreadsheet: MemorySpreadsheet,
    range: string,
  ): { sheet: MemorySheet; parsed: ReturnType<typeof parseA1Range> } {
    const parsed = parseA1Range(range);
    const sheet = parsed.sheetName
      ? spreadsheet.sheets.find(({ title }) => title === parsed.sheetName)
      : spreadsheet.sheets[0];
    if (!sheet) {
      throw new Error(
        parsed.sheetName
          ? `Unknown sheet: ${parsed.sheetName}`
          : `Spreadsheet ${spreadsheet.spreadsheetId} has no sheets.`,
      );
    }
    return { sheet, parsed };
  }

  public getSpreadsheetMetadata(spreadsheetId: string): SpreadsheetMetadata {
    this.record({
      kind: "getSpreadsheetMetadata",
      spreadsheetId,
      ranges: [],
      requestCount: 1,
    });
    const spreadsheet = this.requireSpreadsheet(spreadsheetId);
    return {
      spreadsheetId,
      sheets: spreadsheet.sheets.map((sheet) => ({
        sheetId: sheet.sheetId,
        title: sheet.title,
        rowCount: sheet.values.length,
        columnCount: maxWidth(sheet.values),
      })),
    };
  }

  private read(
    spreadsheet: MemorySpreadsheet,
    range: string,
    majorDimension: SheetMajorDimension,
    valueRenderOption: SheetReadOptions["valueRenderOption"],
  ): SheetValueRange {
    const { sheet, parsed } = this.resolveRange(spreadsheet, range);
    const startRow = parsed.startRowIndex ?? 0;
    const startColumn = parsed.startColumnIndex ?? 0;
    const endRow = Math.min(parsed.endRowIndex ?? sheet.values.length, sheet.values.length);
    const dataWidth = maxWidth(sheet.values);
    const endColumn = Math.min(parsed.endColumnIndex ?? dataWidth, dataWidth);
    const rows: SheetCellValue[][] = [];
    for (let rowIndex = startRow; rowIndex < endRow; rowIndex += 1) {
      const source = sheet.values[rowIndex] ?? [];
      const row: SheetCellValue[] = [];
      for (let columnIndex = startColumn; columnIndex < endColumn; columnIndex += 1) {
        const value = source[columnIndex] ?? null;
        row.push(isFormulaCell(value)
          ? valueRenderOption === "FORMULA"
            ? value.expression
            : null
          : value);
      }
      rows.push(row);
    }
    const values = trimTrailingNulls(rows);
    return {
      range,
      majorDimension,
      values: majorDimension === "COLUMNS" ? trimTrailingNulls(transpose(values, null)) : values,
    };
  }

  public get(
    spreadsheetId: string,
    range: string,
    options: SheetReadOptions = {},
  ): SheetValueRange {
    this.record({
      kind: "get",
      spreadsheetId,
      ranges: [range],
      requestCount: 1,
      valueRenderOption: options.valueRenderOption ?? "UNFORMATTED_VALUE",
    });
    return this.read(
      this.requireSpreadsheet(spreadsheetId),
      range,
      options.majorDimension ?? "ROWS",
      options.valueRenderOption ?? "UNFORMATTED_VALUE",
    );
  }

  public batchGet(
    spreadsheetId: string,
    ranges: readonly string[],
    options: SheetReadOptions = {},
  ): SheetBatchGetResult {
    this.record({
      kind: "batchGet",
      spreadsheetId,
      ranges,
      requestCount: ranges.length,
      valueRenderOption: options.valueRenderOption ?? "UNFORMATTED_VALUE",
    });
    const spreadsheet = this.requireSpreadsheet(spreadsheetId);
    const majorDimension = options.majorDimension ?? "ROWS";
    return {
      spreadsheetId,
      valueRanges: ranges.map((range) => this.read(
        spreadsheet,
        range,
        majorDimension,
        options.valueRenderOption ?? "UNFORMATTED_VALUE",
      )),
    };
  }

  public batchUpdate(
    spreadsheetId: string,
    updates: readonly SheetValueUpdate[],
    options: SheetBatchUpdateOptions = {},
  ): SheetBatchUpdateResult {
    void options;
    this.record({
      kind: "batchUpdate",
      spreadsheetId,
      ranges: updates.map(({ range }) => range),
      requestCount: updates.length,
    });
    const spreadsheet = this.requireSpreadsheet(spreadsheetId);
    const responses: SheetUpdateResult[] = [];
    const touchedSheets = new Set<number>();
    let totalCells = 0;

    for (const update of updates) {
      const { sheet, parsed } = this.resolveRange(spreadsheet, update.range);
      const rowStart = parsed.startRowIndex ?? 0;
      const columnStart = parsed.startColumnIndex ?? 0;
      const input = cloneRawMatrix(update.values, `values for ${update.range}`);
      const rowMajor = update.majorDimension === "COLUMNS" ? transpose(input, null) : input;
      writeMatrix(sheet, rowStart, columnStart, rowMajor);
      const updatedCells = rowMajor.reduce((total, row) => total + row.length, 0);
      const updatedColumns = maxWidth(rowMajor);
      touchedSheets.add(sheet.sheetId);
      totalCells += updatedCells;
      responses.push({
        spreadsheetId,
        updatedRange: update.range,
        updatedRows: rowMajor.length,
        updatedColumns,
        updatedCells,
        updatedData: options.includeValuesInResponse
          ? this.read(
              spreadsheet,
              update.range,
              update.majorDimension ?? "ROWS",
              options.responseValueRenderOption ?? "UNFORMATTED_VALUE",
            )
          : null,
      });
    }
    return {
      spreadsheetId,
      totalUpdatedRows: responses.reduce((total, item) => total + item.updatedRows, 0),
      totalUpdatedColumns: responses.reduce(
        (total, item) => total + item.updatedColumns,
        0,
      ),
      totalUpdatedCells: totalCells,
      totalUpdatedSheets: touchedSheets.size,
      responses,
    };
  }

  public atomicBatchUpdate(
    spreadsheetId: string,
    mutations: readonly AtomicMutation[],
    options: AtomicBatchUpdateOptions = {},
  ): AtomicBatchUpdateResult {
    void options;
    this.record({
      kind: "atomicBatchUpdate",
      spreadsheetId,
      ranges: [],
      requestCount: mutations.length,
    });

    const original = this.requireSpreadsheet(spreadsheetId);
    const candidate = cloneSpreadsheet(original);
    for (const mutation of mutations) {
      const sheet = this.requireSheetById(candidate, mutation.sheetId);
      if (mutation.kind === "updateCells") {
        if (mutation.startRowIndex < 0 || mutation.startColumnIndex < 0) {
          throw new RangeError("Atomic update indices must not be negative.");
        }
        const matrix = cloneSheetInputMatrix(mutation.values, "atomic update values");
        if (matrix.length === 0) throw new TypeError("Atomic update cannot be empty.");
        writeMatrix(
          sheet,
          mutation.startRowIndex,
          mutation.startColumnIndex,
          matrix,
        );
      } else if (mutation.kind === "appendRows") {
        const matrix = cloneSheetInputMatrix(mutation.values, "atomic append values");
        if (matrix.length === 0) throw new TypeError("Atomic append cannot be empty.");
        writeMatrix(sheet, sheet.values.length, 0, matrix);
      } else {
        if (
          !Number.isSafeInteger(mutation.startRowIndex) ||
          !Number.isSafeInteger(mutation.endRowIndex) ||
          mutation.startRowIndex < 0 ||
          mutation.endRowIndex <= mutation.startRowIndex ||
          mutation.endRowIndex > sheet.values.length
        ) {
          throw new RangeError("Atomic row deletion is outside the sheet bounds.");
        }
        sheet.values.splice(
          mutation.startRowIndex,
          mutation.endRowIndex - mutation.startRowIndex,
        );
      }
    }

    this.spreadsheets.set(spreadsheetId, candidate);
    return { spreadsheetId, requestCount: mutations.length, replies: [] };
  }
}
