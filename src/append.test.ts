import { describe, it, expect, vi, beforeEach } from "vitest";
import { GQuery } from "./index";

describe("appendOne", () => {
  beforeEach(() => {
    vi.stubGlobal("SpreadsheetApp", {
      getActiveSpreadsheet: () => ({ getId: () => "test-spreadsheet" }),
      openById: () => ({
        getId: () => "test-spreadsheet",
        getSheetByName: () => ({}),
      }),
    });

    vi.spyOn(Sheets.Spreadsheets.Values, "get").mockReturnValue({
      values: [["id", "name"]],
    } as any);
    vi.spyOn(Sheets.Spreadsheets.Values, "append").mockReturnValue({
      updates: { updatedRange: "Sheet1!A2:B2" },
    } as any);
  });

  it("returns a single row, not a batch wrapper", () => {
    const gq = new GQuery();
    const row = gq.from("Sheet1").appendOne({ id: "1", name: "Alice" });
    expect(row).toEqual(expect.objectContaining({ id: "1", name: "Alice" }));
    expect(Array.isArray(row)).toBe(false);
    expect(row).not.toHaveProperty("rows");
  });
});
