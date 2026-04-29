import { describe, it, expect, vi, beforeEach } from "vitest";
import { GQuery } from "./index";

describe("byId shortcuts", () => {
  beforeEach(() => {
    vi.stubGlobal("SpreadsheetApp", {
      getActiveSpreadsheet: () => ({ getId: () => "test-spreadsheet" }),
      openById: () => ({
        getId: () => "test-spreadsheet",
        getSheetByName: () => ({ getSheetId: () => 0 }),
      }),
    });

    vi.spyOn(Sheets.Spreadsheets.Values, "batchGet").mockReturnValue({
      valueRanges: [{ values: [["id", "name"], ["1", "Alice"], ["2", "Bob"]] }],
    } as any);
  });

  it("getById returns a single row", () => {
    const gq = new GQuery();
    const row = gq.from("Sheet1").getById("2");
    expect(row).toEqual(expect.objectContaining({ id: "2", name: "Bob" }));
  });

  it("getById returns undefined when no match", () => {
    const gq = new GQuery();
    const row = gq.from("Sheet1").getById("999");
    expect(row).toBeUndefined();
  });

  it("updateById applies the mutator and writes via batchUpdate", () => {
    vi.spyOn(Sheets.Spreadsheets.Values, "get").mockReturnValue({
      values: [["id", "name"], ["1", "Alice"], ["2", "Bob"]],
    } as any);
    const batchUpdate = vi
      .spyOn(Sheets.Spreadsheets.Values, "batchUpdate")
      .mockReturnValue({} as any);
    const gq = new GQuery();
    gq.from("Sheet1").updateById("2", (r) => { (r as any).name = "Robert"; });
    expect(batchUpdate).toHaveBeenCalledTimes(1);
    // Verify the mutator's value reached the API call:
    const callArgs = batchUpdate.mock.calls[0];
    const payloadJson = JSON.stringify(callArgs);
    expect(payloadJson).toContain("Robert");
  });

  it("deleteById issues a deleteDimension batchUpdate", () => {
    vi.spyOn(Sheets.Spreadsheets.Values, "get").mockReturnValue({
      values: [["id", "name"], ["1", "Alice"], ["2", "Bob"]],
    } as any);
    const batchUpdate = vi
      .spyOn(Sheets.Spreadsheets, "batchUpdate")
      .mockReturnValue({} as any);
    const gq = new GQuery();
    gq.from("Sheet1").deleteById("1");
    expect(batchUpdate).toHaveBeenCalledTimes(1);
  });
});
