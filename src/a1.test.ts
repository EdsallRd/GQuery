import { beforeEach, describe, expect, it, vi } from "vitest";
import { GQuery, quoteSheetName, sheetNameFromRange, sheetRange } from "./index";

describe("A1 sheet names", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("SpreadsheetApp", {
      getActiveSpreadsheet: () => ({ getId: () => "test-spreadsheet" }),
      openById: () => ({
        getId: () => "test-spreadsheet",
        getSheetByName: () => ({}),
      }),
    });
  });

  it("quotes spaces, apostrophes, and exclamation marks", () => {
    expect(quoteSheetName("QuickTicket Users")).toBe("'QuickTicket Users'");
    expect(sheetRange("Director's ! Log", "A2:C4")).toBe(
      "'Director''s ! Log'!A2:C4",
    );
    expect(sheetNameFromRange("'Director''s ! Log'!A2:C4")).toBe(
      "Director's ! Log",
    );
  });

  it("quotes existing table reads before calling the Values API", () => {
    const batchGet = vi
      .spyOn(Sheets!.Spreadsheets.Values, "batchGet")
      .mockReturnValue({ valueRanges: [{ values: [["id"], ["1"]] }] } as any);

    new GQuery().from("QuickTicket Users").get();

    expect(batchGet).toHaveBeenCalledWith(
      "test-spreadsheet",
      expect.objectContaining({ ranges: ["'QuickTicket Users'"] }),
    );
  });
});
