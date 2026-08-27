import { describe, expect, it, vi } from "vitest";
import { formula, type FormulaCell } from "../codecs";
import { AppsScriptSheetsTransport } from "./apps-script";

function fakeService() {
  const get = vi.fn().mockReturnValue({
    range: "'Assets'!A1:B2",
    majorDimension: "ROWS",
    values: [["Serial", "Active"], ["001", true]],
  });
  const batchGet = vi.fn().mockReturnValue({
    spreadsheetId: "book",
    valueRanges: [{ range: "'Assets'!A1", values: [["Serial"]] }],
  });
  const valuesBatchUpdate = vi.fn().mockReturnValue({
    spreadsheetId: "book",
    totalUpdatedRows: 1,
    totalUpdatedColumns: 2,
    totalUpdatedCells: 2,
    totalUpdatedSheets: 1,
    responses: [{ updatedRange: "'Assets'!A2:B2", updatedCells: 2 }],
  });
  const atomicBatchUpdate = vi.fn().mockReturnValue({
    spreadsheetId: "book",
    replies: [{}, {}, {}],
  });
  const metadataGet = vi.fn().mockReturnValue({
    spreadsheetId: "book",
    sheets: [
      {
        properties: {
          sheetId: 7,
          title: "Assets",
          gridProperties: { rowCount: 100, columnCount: 12 },
        },
      },
    ],
  });
  const service = {
    Spreadsheets: {
      Values: { get, batchGet, batchUpdate: valuesBatchUpdate },
      get: metadataGet,
      batchUpdate: atomicBatchUpdate,
    },
  } as unknown as GoogleAppsScript.Sheets;
  return {
    service,
    get,
    batchGet,
    valuesBatchUpdate,
    atomicBatchUpdate,
    metadataGet,
  };
}

describe("AppsScriptSheetsTransport", () => {
  it("uses deterministic machine-value defaults for reads", () => {
    const { service, get } = fakeService();
    const transport = new AppsScriptSheetsTransport({ service });

    expect(transport.get("book", "'Assets'!A1:B2").values[1]).toEqual([
      "001",
      true,
    ]);
    expect(get).toHaveBeenCalledWith("book", "'Assets'!A1:B2", {
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
  });

  it("coalesces ranges into one batchGet and preserves missing positions", () => {
    const { service, batchGet } = fakeService();
    const transport = new AppsScriptSheetsTransport({ service });
    const result = transport.batchGet("book", ["'Assets'!A1", "'Models'!A1"]);

    expect(batchGet).toHaveBeenCalledTimes(1);
    expect(result.valueRanges).toHaveLength(2);
    expect(result.valueRanges[1]).toEqual({
      range: "'Models'!A1",
      majorDimension: "ROWS",
      values: [],
    });
  });

  it("uses RAW writes and rejects non-finite values before calling Sheets", () => {
    const { service, valuesBatchUpdate } = fakeService();
    const transport = new AppsScriptSheetsTransport({ service });
    const result = transport.batchUpdate("book", [
      { range: "'Assets'!A2:B2", values: [["001", true]] },
    ]);

    expect(result.totalUpdatedCells).toBe(2);
    expect(valuesBatchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ valueInputOption: "RAW" }),
      "book",
    );
    expect(() =>
      transport.batchUpdate("book", [
        { range: "'Assets'!A2", values: [[Number.NaN]] },
      ]),
    ).toThrow(/finite number/i);
    expect(valuesBatchUpdate).toHaveBeenCalledTimes(1);
  });

  it("encodes typed cells, appends, and bottom-up deletes in one atomic call", () => {
    const { service, atomicBatchUpdate } = fakeService();
    const transport = new AppsScriptSheetsTransport({ service });
    const result = transport.atomicBatchUpdate("book", [
      {
        kind: "updateCells",
        sheetId: 7,
        startRowIndex: 1,
        startColumnIndex: 0,
        values: [["=literal", formula().encode("=A2*2") as FormulaCell, 3, true, null]],
      },
      { kind: "appendRows", sheetId: 7, values: [["002", false]] },
      {
        kind: "deleteRows",
        sheetId: 7,
        startRowIndex: 8,
        endRowIndex: 10,
      },
    ]);

    expect(result.requestCount).toBe(3);
    const payload = atomicBatchUpdate.mock.calls[0][0];
    expect(payload.requests[0].updateCells.rows[0].values).toEqual([
      { userEnteredValue: { stringValue: "=literal" } },
      { userEnteredValue: { formulaValue: "=A2*2" } },
      { userEnteredValue: { numberValue: 3 } },
      { userEnteredValue: { boolValue: true } },
      {},
    ]);
    expect(payload.requests[1].appendCells.fields).toBe("userEnteredValue");
    expect(payload.requests[2].deleteDimension.range).toEqual({
      sheetId: 7,
      dimension: "ROWS",
      startIndex: 8,
      endIndex: 10,
    });
    expect(atomicBatchUpdate).toHaveBeenCalledTimes(1);
  });

  it("resolves physical sheet metadata without grid data", () => {
    const { service, metadataGet } = fakeService();
    const transport = new AppsScriptSheetsTransport({ service });
    expect(transport.getSpreadsheetMetadata("book").sheets[0]).toEqual({
      sheetId: 7,
      title: "Assets",
      rowCount: 100,
      columnCount: 12,
    });
    expect(metadataGet).toHaveBeenCalledWith(
      "book",
      expect.objectContaining({ includeGridData: false }),
    );
  });
});
