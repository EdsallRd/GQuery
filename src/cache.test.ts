import { describe, it, expect, vi, beforeEach } from "vitest";
import { GQuery } from "./index";

const headerRow = ["id", "name"];
const dataRows = [["1", "Alice"], ["2", "Bob"]];

describe("cached", () => {
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
    vi.stubGlobal("SpreadsheetApp", {
      getActiveSpreadsheet: () => ({ getId: () => "test-spreadsheet" }),
      openById: () => ({
        getId: () => "test-spreadsheet",
        getSheetByName: () => ({ getSheetId: () => 0 }),
      }),
    });
    vi.spyOn(Sheets.Spreadsheets.Values, "batchGet").mockReturnValue({
      valueRanges: [{ values: [headerRow, ...dataRows] }],
    } as any);
  });

  it("on cache miss, reads from Sheets and writes to cache", () => {
    new GQuery().from("Sheet1").cached().get();
    expect(cache.get).toHaveBeenCalledWith("gq:Sheet1:list");
    // put is called at least once for the data (trackKey may add a second call for the key index)
    expect(cache.put).toHaveBeenCalled();
    // Verify the data was written under the expected key
    const dataPut = cache.put.mock.calls.find((args: any[]) => args[0] === "gq:Sheet1:list");
    expect(dataPut).toBeDefined();
  });

  it("on cache hit, skips Sheets read", () => {
    cache.get.mockReturnValue(JSON.stringify({ headers: headerRow, rows: [{ id: "1", name: "Alice" }] }));
    const batchGet = Sheets.Spreadsheets.Values.batchGet as any;
    new GQuery().from("Sheet1").cached().get();
    expect(batchGet).not.toHaveBeenCalled();
  });

  it("bypass: true forces a fresh read and rewrites the cache", () => {
    cache.get.mockReturnValue(JSON.stringify({ headers: headerRow, rows: [{ id: "1", name: "Stale" }] }));
    const batchGet = Sheets.Spreadsheets.Values.batchGet as any;
    new GQuery().from("Sheet1").cached({ bypass: true }).get();
    expect(batchGet).toHaveBeenCalled();
    expect(cache.put).toHaveBeenCalled();
  });

  it("custom key honored", () => {
    new GQuery().from("Sheet1").cached({ key: "custom:key" }).get();
    expect(cache.get).toHaveBeenCalledWith("custom:key");
  });

  it("auto-invalidates same-sheet cache on appendOne", () => {
    vi.spyOn(Sheets.Spreadsheets.Values, "get").mockReturnValue({ values: [headerRow] } as any);
    vi.spyOn(Sheets.Spreadsheets.Values, "append").mockReturnValue({
      updates: { updatedRange: "Sheet1!A3:B3" },
    } as any);
    new GQuery().from("Sheet1").appendOne({ id: "3", name: "Carol" });
    expect(cache.remove).toHaveBeenCalledWith("gq:Sheet1:list");
  });
});
