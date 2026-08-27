import { describe, it, expect, vi, beforeEach } from "vitest";
import { GQuery } from "./legacy";

describe("update filter type coercion", () => {
  beforeEach(() => {
    vi.stubGlobal("SpreadsheetApp", {
      getActiveSpreadsheet: () => ({ getId: () => "test-spreadsheet" }),
      openById: () => ({
        getId: () => "test-spreadsheet",
        getSheetByName: () => ({ getSheetId: () => 0 }),
      }),
    });

    vi.spyOn(Sheets!.Spreadsheets.Values, "get").mockReturnValue({
      values: [
        ["Id", "Status", "Confirmed"],
        ["1", "Assigned", "FALSE"],
      ],
    } as any);
    vi.spyOn(Sheets!.Spreadsheets.Values, "batchUpdate").mockReturnValue(
      {} as any,
    );
  });

  it("matches boolean-formatted checkbox cells against real booleans", () => {
    const gq = new GQuery();
    const res = gq
      .from("Sheet1")
      .where((row) => row.Status == "Assigned" && row.Confirmed == false)
      .update((row) => ({ ...row, Confirmed: true }));

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].Confirmed).toBe(true);
  });
});
