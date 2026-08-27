import { describe, expect, it } from "vitest";
import { parseA1Range, cellRange } from "./a1";
import { compactCellUpdates, compactRowDeletes } from "./compaction";

describe("transport range utilities", () => {
  it("parses and emits quoted, zero-based ranges", () => {
    expect(parseA1Range("'Director''s Assets'!B2:D4")).toEqual({
      sheetName: "Director's Assets",
      startRowIndex: 1,
      endRowIndex: 4,
      startColumnIndex: 1,
      endColumnIndex: 4,
    });
    expect(cellRange("Director's Assets", 1, 1, 3, 3)).toBe(
      "'Director''s Assets'!B2:D4",
    );
  });

  it("compacts adjacent cells into exact rectangles", () => {
    expect(
      compactCellUpdates([
        { sheetId: 7, rowIndex: 2, columnIndex: 2, value: "d" },
        { sheetId: 7, rowIndex: 1, columnIndex: 1, value: "a" },
        { sheetId: 7, rowIndex: 2, columnIndex: 1, value: "c" },
        { sheetId: 7, rowIndex: 1, columnIndex: 2, value: "b" },
        { sheetId: 7, rowIndex: 2, columnIndex: 4, value: true },
      ]),
    ).toEqual([
      {
        kind: "updateCells",
        sheetId: 7,
        startRowIndex: 1,
        startColumnIndex: 1,
        values: [
          ["a", "b"],
          ["c", "d"],
        ],
      },
      {
        kind: "updateCells",
        sheetId: 7,
        startRowIndex: 2,
        startColumnIndex: 4,
        values: [[true]],
      },
    ]);
  });

  it("deduplicates rows, groups contiguous deletes, and orders bottom-up", () => {
    expect(
      compactRowDeletes([
        { sheetId: 7, rowIndex: 3 },
        { sheetId: 7, rowIndex: 10 },
        { sheetId: 7, rowIndex: 11 },
        { sheetId: 7, rowIndex: 13 },
        { sheetId: 7, rowIndex: 10 },
      ]),
    ).toEqual([
      {
        kind: "deleteRows",
        sheetId: 7,
        startRowIndex: 13,
        endRowIndex: 14,
      },
      {
        kind: "deleteRows",
        sheetId: 7,
        startRowIndex: 10,
        endRowIndex: 12,
      },
      {
        kind: "deleteRows",
        sheetId: 7,
        startRowIndex: 3,
        endRowIndex: 4,
      },
    ]);
  });
});
