import { RequestPayloadTooLargeError } from "../infrastructure/errors";
import type {
  AtomicBatchUpdateOptions,
  AtomicMutation,
} from "./contracts";
import { cloneSheetInputMatrix, encodeAtomicRows } from "./raw-values";

/** Safety ceiling below the Sheets API's recommended 2 MB request size. */
export const ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT = 1_800_000;

function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function nonEmptyMatrix(
  values: readonly (readonly unknown[])[],
  label: string,
): void {
  if (values.length === 0 || values.every((row) => row.length === 0)) {
    throw new TypeError(`${label} must contain at least one cell.`);
  }
}

function formatFieldMasks(
  format: Readonly<Record<string, unknown>>,
  prefix = "userEnteredFormat",
): string[] {
  const masks: string[] = [];
  for (const [key, value] of Object.entries(format)) {
    const path = `${prefix}.${key}`;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as object).length > 0
    ) {
      masks.push(...formatFieldMasks(value as Readonly<Record<string, unknown>>, path));
    } else {
      masks.push(path);
    }
  }
  return masks;
}

/** Compile a transport-neutral atomic mutation into a Sheets batchUpdate request. */
export function atomicMutationToSheetsRequest(
  mutation: AtomicMutation,
): GoogleAppsScript.Sheets.Schema.Request {
  nonNegativeInteger("sheetId", mutation.sheetId);

  if (mutation.kind === "deleteRows") {
    nonNegativeInteger("startRowIndex", mutation.startRowIndex);
    nonNegativeInteger("endRowIndex", mutation.endRowIndex);
    if (mutation.endRowIndex <= mutation.startRowIndex) {
      throw new RangeError("endRowIndex must be greater than startRowIndex.");
    }
    return {
      deleteDimension: {
        range: {
          sheetId: mutation.sheetId,
          dimension: "ROWS",
          startIndex: mutation.startRowIndex,
          endIndex: mutation.endRowIndex,
        },
      },
    };
  }

  if (mutation.kind === "formatCells") {
    nonNegativeInteger("startRowIndex", mutation.startRowIndex);
    nonNegativeInteger("startColumnIndex", mutation.startColumnIndex);
    if (!Number.isSafeInteger(mutation.rowCount) || mutation.rowCount < 1) {
      throw new RangeError("rowCount must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(mutation.columnCount) || mutation.columnCount < 1) {
      throw new RangeError("columnCount must be a positive safe integer.");
    }
    const fields = formatFieldMasks(mutation.format).sort();
    if (fields.length === 0) {
      throw new TypeError("formatCells.format must declare at least one format field.");
    }
    return {
      repeatCell: {
        range: {
          sheetId: mutation.sheetId,
          startRowIndex: mutation.startRowIndex,
          endRowIndex: mutation.startRowIndex + mutation.rowCount,
          startColumnIndex: mutation.startColumnIndex,
          endColumnIndex: mutation.startColumnIndex + mutation.columnCount,
        },
        cell: {
          userEnteredFormat: { ...mutation.format } as GoogleAppsScript.Sheets.Schema.CellFormat,
        },
        fields: fields.join(","),
      },
    };
  }

  const matrix = cloneSheetInputMatrix(mutation.values, `${mutation.kind}.values`);
  nonEmptyMatrix(matrix, `${mutation.kind}.values`);
  const rows = encodeAtomicRows(matrix) as GoogleAppsScript.Sheets.Schema.RowData[];

  if (mutation.kind === "appendRows") {
    const formatFields = new Set<string>();
    if (mutation.formats !== undefined) {
      if (mutation.formats.length !== rows.length) {
        throw new RangeError("appendRows.formats must align with appendRows.values.");
      }
      const masksByCell = mutation.formats.map((formats, rowIndex) => {
        const width = rows[rowIndex].values?.length ?? 0;
        if (formats.length !== width) {
          throw new RangeError("appendRows.formats must align with every appended cell.");
        }
        return formats.map((format) =>
          format === null ? [] : formatFieldMasks(format).sort()
        );
      });
      for (const masks of masksByCell.flat()) {
        for (const field of masks) formatFields.add(field);
      }
      const requiredMasks = [...formatFields].sort();
      if (
        requiredMasks.length > 0 &&
        masksByCell.flat().some((masks) =>
          masks.length !== requiredMasks.length ||
          masks.some((field, index) => field !== requiredMasks[index])
        )
      ) {
        throw new TypeError(
          "appendRows.formats must provide the same format leaf fields for every appended cell; partial append masks could erase existing sheet formatting.",
        );
      }
      rows.forEach((row, rowIndex) => {
        const formats = mutation.formats?.[rowIndex] ?? [];
        formats.forEach((format, columnIndex) => {
          if (format === null) return;
          const cell = row.values?.[columnIndex] ?? {};
          cell.userEnteredFormat = { ...format } as GoogleAppsScript.Sheets.Schema.CellFormat;
          if (row.values === undefined) row.values = [];
          row.values[columnIndex] = cell;
        });
      });
    }
    return {
      appendCells: {
        sheetId: mutation.sheetId,
        rows,
        fields: formatFields.size === 0
          ? "userEnteredValue"
          : ["userEnteredValue", ...[...formatFields].sort()].join(","),
      },
    };
  }

  nonNegativeInteger("startRowIndex", mutation.startRowIndex);
  nonNegativeInteger("startColumnIndex", mutation.startColumnIndex);
  return {
    updateCells: {
      start: {
        sheetId: mutation.sheetId,
        rowIndex: mutation.startRowIndex,
        columnIndex: mutation.startColumnIndex,
      },
      rows,
      fields: "userEnteredValue",
    },
  };
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/** Reject a request before an oversized atomic commit can reach the API. */
export function assertAtomicBatchPayloadSize(
  requests: readonly GoogleAppsScript.Sheets.Schema.Request[],
  options: AtomicBatchUpdateOptions = {},
): number {
  const payload = {
    requests,
    includeSpreadsheetInResponse: options.includeSpreadsheetInResponse,
    responseIncludeGridData: options.responseIncludeGridData,
    responseRanges: options.responseRanges === undefined
      ? undefined
      : [...options.responseRanges],
  };
  const bytes = utf8ByteLength(JSON.stringify(payload));
  if (bytes > ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT) {
    throw new RequestPayloadTooLargeError(
      "atomicBatchUpdate",
      bytes,
      ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT,
    );
  }
  return bytes;
}
