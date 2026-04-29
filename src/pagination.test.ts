import { describe, it, expect, vi, beforeEach } from "vitest";
import { GQuery } from "./index";

describe("limit/offset", () => {
  beforeEach(() => {
    vi.stubGlobal("SpreadsheetApp", {
      getActiveSpreadsheet: () => ({ getId: () => "test-spreadsheet" }),
      openById: () => ({
        getId: () => "test-spreadsheet",
        getSheetByName: () => ({ getSheetId: () => 0 }),
      }),
    });

    vi.spyOn(Sheets.Spreadsheets.Values, "batchGet").mockReturnValue({
      valueRanges: [{
        values: [
          ["id"],
          ...Array.from({ length: 50 }, (_, i) => [String(i + 1)]),
        ],
      }],
    } as any);
  });

  it("limit returns at most N rows", () => {
    const result = new GQuery().from("Sheet1").limit(10).get();
    expect(result.rows).toHaveLength(10);
    expect((result.rows[0] as any).id).toBe("1");
  });

  it("offset skips N rows", () => {
    const result = new GQuery().from("Sheet1").offset(20).limit(5).get();
    expect(result.rows).toHaveLength(5);
    expect((result.rows[0] as any).id).toBe("21");
  });

  it("limit applies after orderBy", () => {
    const result = new GQuery().from("Sheet1").orderBy("id", "desc").limit(3).get();
    // String sort descending: "9" > "8" > "7" > "50" > ... (single-char digits sort after "5x")
    expect(result.rows.map((r: any) => r.id)).toEqual(["9", "8", "7"]);
  });
});
