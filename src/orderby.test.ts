import { describe, it, expect, vi, beforeEach } from "vitest";
import { GQuery } from "./index";

describe("orderBy", () => {
  beforeEach(() => {
    vi.stubGlobal("SpreadsheetApp", {
      getActiveSpreadsheet: () => ({ getId: () => "test-spreadsheet" }),
      openById: () => ({
        getId: () => "test-spreadsheet",
        getSheetByName: () => ({ getSheetId: () => 0 }),
      }),
    });

    vi.spyOn(Sheets!.Spreadsheets.Values, "batchGet").mockReturnValue({
      valueRanges: [
        {
          values: [
            ["id", "name", "age"],
            ["1", "Charlie", "30"],
            ["2", "Alice", "25"],
            ["3", "Bob", "35"],
          ],
        },
      ],
    } as any);
  });

  it("sorts ascending by string field", () => {
    const result = new GQuery().from("Sheet1").orderBy("name", "asc").get();
    expect(result.rows.map((r: any) => r.name)).toEqual([
      "Alice",
      "Bob",
      "Charlie",
    ]);
  });

  it("sorts descending by numeric field", () => {
    const result = new GQuery().from("Sheet1").orderBy("age", "desc").get();
    expect(result.rows.map((r: any) => Number(r.age))).toEqual([35, 30, 25]);
  });

  it("default direction is asc", () => {
    const result = new GQuery().from("Sheet1").orderBy("name").get();
    expect(result.rows.map((r: any) => r.name)).toEqual([
      "Alice",
      "Bob",
      "Charlie",
    ]);
  });
});
