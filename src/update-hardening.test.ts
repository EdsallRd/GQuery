import { beforeEach, describe, expect, it, vi } from "vitest";
import { GQuery } from "./index";

describe("update hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("SpreadsheetApp", {
      getActiveSpreadsheet: () => ({ getId: () => "test-spreadsheet" }),
      openById: () => ({
        getId: () => "test-spreadsheet",
        getSheetByName: () => ({ getSheetId: () => 0 }),
      }),
    });
    vi.spyOn(Sheets!.Spreadsheets.Values, "get").mockReturnValue({
      values: [
        ["id", "payload"],
        ["1", "original"],
      ],
    } as any);
  });

  it("propagates an update callback exception without writing", () => {
    const batchUpdate = vi.spyOn(Sheets!.Spreadsheets.Values, "batchUpdate");
    const failure = new Error("serialize failed");

    expect(() =>
      new GQuery().from("QuickTicket Users").where((row) => row.id === "1").update(
        () => {
          throw failure;
        },
      ),
    ).toThrow(failure);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it("propagates cell serialization errors without writing", () => {
    const batchUpdate = vi.spyOn(Sheets!.Spreadsheets.Values, "batchUpdate");
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      new GQuery().from("QuickTicket Users").update(
        () => ({ payload: circular } as any),
      ),
    ).toThrow(/circular/i);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it("quotes update ranges for sheet names containing spaces", () => {
    const batchUpdate = vi
      .spyOn(Sheets!.Spreadsheets.Values, "batchUpdate")
      .mockReturnValue({} as any);

    new GQuery().from("QuickTicket Users").update(() => ({ payload: "next" }));

    const request = batchUpdate.mock.calls[0][0] as any;
    expect(request.data[0].range).toBe("'QuickTicket Users'!B2");
  });
});
