import { isFormulaCell } from "../codecs";
import type { SheetCellInput, SheetCellValue } from "./contracts";

export type RawExtendedValue =
  | { stringValue: string }
  | { numberValue: number }
  | { boolValue: boolean }
  | { formulaValue: string };

export interface RawCellData {
  /** Omitted when a `null` transport value means clear this cell. */
  userEnteredValue?: RawExtendedValue;
}

export function assertSheetCellValue(
  value: unknown,
  location = "cell",
): asserts value is SheetCellValue {
  if (value === null) return;
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new TypeError(
      `${location} must be a string, finite number, boolean, or null.`,
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`${location} must be a finite number.`);
  }
}

export function cloneRawMatrix(
  values: readonly (readonly SheetCellValue[])[],
  label = "values",
): SheetCellValue[][] {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be a two-dimensional array.`);
  }

  return values.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new TypeError(`${label}[${rowIndex}] must be an array.`);
    }
    return row.map((value, columnIndex) => {
      assertSheetCellValue(value, `${label}[${rowIndex}][${columnIndex}]`);
      return value;
    });
  });
}

export function assertSheetCellInput(
  value: unknown,
  location = "cell",
): asserts value is SheetCellInput {
  if (isFormulaCell(value)) {
    if (!value.expression.startsWith("=") || value.expression.length < 2) {
      throw new TypeError(`${location} contains an invalid formula expression.`);
    }
    return;
  }
  assertSheetCellValue(value, location);
}

export function cloneSheetInputMatrix(
  values: readonly (readonly SheetCellInput[])[],
  label = "values",
): SheetCellInput[][] {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be a two-dimensional array.`);
  }
  return values.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new TypeError(`${label}[${rowIndex}] must be an array.`);
    }
    return row.map((value, columnIndex) => {
      assertSheetCellInput(value, `${label}[${rowIndex}][${columnIndex}]`);
      return value;
    });
  });
}

export function normalizeReturnedMatrix(
  values: readonly (readonly unknown[])[] | undefined,
  label = "Sheets response values",
): SheetCellValue[][] {
  if (values === undefined) return [];
  return cloneRawMatrix(values as readonly (readonly SheetCellValue[])[], label);
}

/** Encode one primitive as a Sheets v4 ExtendedValue. `null` means clear. */
export function encodeRawExtendedValue(
  value: SheetCellValue,
): RawExtendedValue | undefined {
  assertSheetCellValue(value);
  if (value === null) return undefined;
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { numberValue: value };
  return { boolValue: value };
}

/** Encode a grid-write input as Sheets v4 ExtendedValue without guessing. */
export function encodeAtomicExtendedValue(
  value: SheetCellInput,
): RawExtendedValue | undefined {
  assertSheetCellInput(value);
  if (isFormulaCell(value)) return { formulaValue: value.expression };
  return encodeRawExtendedValue(value);
}

export function encodeRawCell(value: SheetCellValue): RawCellData {
  const userEnteredValue = encodeRawExtendedValue(value);
  return userEnteredValue === undefined ? {} : { userEnteredValue };
}

export function encodeRawRows(
  values: readonly (readonly SheetCellValue[])[],
): { values: RawCellData[] }[] {
  return cloneRawMatrix(values).map((row) => ({
    values: row.map(encodeRawCell),
  }));
}

export function encodeAtomicRows(
  values: readonly (readonly SheetCellInput[])[],
): { values: RawCellData[] }[] {
  return cloneSheetInputMatrix(values).map((row) => ({
    values: row.map((value) => {
      const userEnteredValue = encodeAtomicExtendedValue(value);
      return userEnteredValue === undefined ? {} : { userEnteredValue };
    }),
  }));
}
