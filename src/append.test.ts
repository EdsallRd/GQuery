import { describe, it, expect, vi, beforeEach } from "vitest";
import { GQuery } from "./legacy";

describe("appendOne", () => {
  beforeEach(() => {
    vi.stubGlobal("SpreadsheetApp", {
      getActiveSpreadsheet: () => ({ getId: () => "test-spreadsheet" }),
      openById: () => ({
        getId: () => "test-spreadsheet",
        getSheetByName: () => ({}),
      }),
    });

    vi.spyOn(Sheets!.Spreadsheets.Values, "get").mockReturnValue({
      values: [["id", "name"]],
    } as any);
    vi.spyOn(Sheets!.Spreadsheets.Values, "append").mockReturnValue({
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

  it("quotes a sheet name containing spaces in both API calls", () => {
    const get = vi.spyOn(Sheets!.Spreadsheets.Values, "get");
    const append = vi
      .spyOn(Sheets!.Spreadsheets.Values, "append")
      .mockReturnValue({
        updates: { updatedRange: "'QuickTicket Users'!A2:B2" },
      } as any);

    new GQuery().from("QuickTicket Users").appendOne({
      id: "1",
      name: "Alice",
    });

    expect(get).toHaveBeenLastCalledWith(
      "test-spreadsheet",
      "'QuickTicket Users'!1:1",
    );
    expect(append.mock.calls.at(-1)?.[2]).toBe("'QuickTicket Users'");
  });
});
