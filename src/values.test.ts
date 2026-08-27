import { beforeEach, describe, expect, it, vi } from "vitest";
import { GQuery, sheetRange } from "./legacy";

describe("targeted Values API", () => {
  let cache: { get: any; put: any; remove: any; removeAll: any };

  beforeEach(() => {
    vi.clearAllMocks();
    cache = {
      get: vi.fn().mockReturnValue(null),
      put: vi.fn(),
      remove: vi.fn(),
      removeAll: vi.fn(),
    };
    vi.stubGlobal("CacheService", { getScriptCache: () => cache });
  });

  it("reads one range with unformatted machine values", () => {
    const range = sheetRange("QuickTicket Users", "A2:F2");
    const get = vi.spyOn(Sheets!.Spreadsheets.Values, "get").mockReturnValue({
      range,
      majorDimension: "ROWS",
      values: [["user@example.edu", 123]],
    } as any);

    const result = new GQuery("spreadsheet-id", { retries: 3 }).getValues(
      range,
      { valueRenderOption: "UNFORMATTED_VALUE" },
    );

    expect(get).toHaveBeenCalledWith("spreadsheet-id", range, {
      majorDimension: undefined,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: undefined,
    });
    expect(result).toEqual({
      range,
      majorDimension: "ROWS",
      values: [["user@example.edu", 123]],
    });
  });

  it("updates one range and returns a normalized updated range", () => {
    const range = sheetRange("QuickTicket Users", "D2:E2");
    const update = vi
      .spyOn(Sheets!.Spreadsheets.Values, "update")
      .mockReturnValue({
        spreadsheetId: "spreadsheet-id",
        updatedRange: range,
        updatedRows: 1,
        updatedColumns: 2,
        updatedCells: 2,
      } as any);

    const result = new GQuery("spreadsheet-id").updateValues(
      range,
      [["revision", 42]],
      { valueInputOption: "RAW" },
    );

    expect(update).toHaveBeenCalledWith(
      { values: [["revision", 42]] },
      "spreadsheet-id",
      range,
      expect.objectContaining({ valueInputOption: "RAW" }),
    );
    expect(result.updatedRange).toBe(range);
    expect(result.updatedCells).toBe(2);
    expect(cache.remove).toHaveBeenCalledWith("gq:QuickTicket Users:list");
  });

  it("batch-updates prevalidated ranges atomically", () => {
    const first = sheetRange("QuickTicket Users", "D2:E2");
    const second = sheetRange("QuickTicket Errors", "A2:B2");
    const batchUpdate = vi
      .spyOn(Sheets!.Spreadsheets.Values, "batchUpdate")
      .mockReturnValue({
        spreadsheetId: "spreadsheet-id",
        totalUpdatedCells: 4,
        responses: [{ updatedRange: first }, { updatedRange: second }],
      } as any);

    const result = new GQuery("spreadsheet-id").batchUpdateValues(
      [
        { range: first, values: [["one", 1]] },
        { range: second, values: [["two", 2]] },
      ],
      { valueInputOption: "USER_ENTERED" },
    );

    expect(batchUpdate).toHaveBeenCalledTimes(1);
    expect(result.totalUpdatedCells).toBe(4);
    expect(result.responses.map(({ updatedRange }) => updatedRange)).toEqual([
      first,
      second,
    ]);
  });

  it("appends values and exposes updatedRange at the top level", () => {
    const range = sheetRange("QuickTicket Errors");
    const updatedRange = sheetRange("QuickTicket Errors", "A2:B2");
    vi.spyOn(Sheets!.Spreadsheets.Values, "append").mockReturnValue({
      tableRange: sheetRange("QuickTicket Errors", "A1:B1"),
      updates: { updatedRange, updatedRows: 1, updatedCells: 2 },
    } as any);

    const result = new GQuery("spreadsheet-id").appendValues(
      range,
      [["2026-08-25", "SERVER_ERROR"]],
    );

    expect(result.updatedRange).toBe(updatedRange);
    expect(result.updatedRows).toBe(1);
  });

  it("rejects unsupported values before issuing a batch write", () => {
    const batchUpdate = vi.spyOn(Sheets!.Spreadsheets.Values, "batchUpdate");
    const invalid = { range: sheetRange("Sheet1", "A1"), values: [[{}]] };

    expect(() =>
      new GQuery("spreadsheet-id").batchUpdateValues([invalid] as any),
    ).toThrow(/cell values/i);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it("honors the instance retry bound", () => {
    const get = vi
      .spyOn(Sheets!.Spreadsheets.Values, "get")
      .mockImplementation(() => {
        throw new Error("429 Too many requests");
      });

    expect(() =>
      new GQuery("spreadsheet-id", { retries: 2 }).getValues("Sheet1!A1"),
    ).toThrow(/Max retries \(2\)/);
    expect(get).toHaveBeenCalledTimes(3);
    expect(Utilities.sleep).toHaveBeenCalledTimes(2);
  });

  it("rejects retry windows that can outlive Apps Script", () => {
    expect(() => new GQuery("spreadsheet-id", { retries: 7 })).toThrow(
      /integer from 0 to 6/,
    );
  });
});
