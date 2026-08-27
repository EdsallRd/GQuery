import { describe, expect, it } from "vitest";
import { InMemorySheetsTransport } from "./in-memory";

function transport(): InMemorySheetsTransport {
  return new InMemorySheetsTransport([
    {
      spreadsheetId: "book",
      sheets: [
        {
          sheetId: 7,
          title: "Director's Assets",
          values: [
            ["Serial", "Status"],
            ["001", "Assigned"],
            ["002", "Repair"],
          ],
        },
        { sheetId: 8, title: "Models", values: [["Id"], ["m1"]] },
      ],
    },
  ]);
}

describe("InMemorySheetsTransport", () => {
  it("supports quoted A1 ranges and one-call heterogeneous batches", () => {
    const memory = transport();
    const result = memory.batchGet("book", [
      "'Director''s Assets'!A2:B3",
      "'Models'!A2",
    ]);

    expect(result.valueRanges.map(({ values }) => values)).toEqual([
      [
        ["001", "Assigned"],
        ["002", "Repair"],
      ],
      [["m1"]],
    ]);
    expect(memory.history).toHaveLength(1);
    expect(memory.history[0].kind).toBe("batchGet");
  });

  it("applies value writes and exposes the resulting data", () => {
    const memory = transport();
    const result = memory.batchUpdate(
      "book",
      [
        {
          range: "'Director''s Assets'!B2:B3",
          values: [["Available"], ["Available"]],
        },
      ],
      { includeValuesInResponse: true },
    );

    expect(result.totalUpdatedCells).toBe(2);
    expect(result.responses[0].updatedData?.values).toEqual([
      ["Available"],
      ["Available"],
    ]);
  });

  it("commits grid writes, appends, and row deletes as one transaction", () => {
    const memory = transport();
    memory.atomicBatchUpdate("book", [
      {
        kind: "updateCells",
        sheetId: 7,
        startRowIndex: 1,
        startColumnIndex: 1,
        values: [["Available"]],
      },
      { kind: "appendRows", sheetId: 7, values: [["003", "Repair"]] },
      {
        kind: "deleteRows",
        sheetId: 7,
        startRowIndex: 2,
        endRowIndex: 3,
      },
    ]);

    expect(memory.get("book", "'Director''s Assets'").values).toEqual([
      ["Serial", "Status"],
      ["001", "Available"],
      ["003", "Repair"],
    ]);
  });

  it("rolls back every atomic mutation when one request is invalid", () => {
    const memory = transport();
    const before = memory.snapshot("book");

    expect(() =>
      memory.atomicBatchUpdate("book", [
        {
          kind: "updateCells",
          sheetId: 7,
          startRowIndex: 1,
          startColumnIndex: 1,
          values: [["Available"]],
        },
        {
          kind: "deleteRows",
          sheetId: 999,
          startRowIndex: 0,
          endRowIndex: 1,
        },
      ]),
    ).toThrow(/unknown sheet id/i);
    expect(memory.snapshot("book")).toEqual(before);
  });

  it("returns IDs and current extents as metadata", () => {
    expect(transport().getSpreadsheetMetadata("book").sheets[0]).toEqual({
      sheetId: 7,
      title: "Director's Assets",
      rowCount: 3,
      columnCount: 2,
    });
  });
});
