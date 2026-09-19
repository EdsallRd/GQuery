import { afterEach, expect, it, vi } from "vitest";
import { GQuery, configureGQueryWriteObserver } from "./index";

afterEach(() => { configureGQueryWriteObserver(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it("reads without opening native handles, while explicit access remains lazy and writable", () => {
  const sheet = { getSheetId: () => 3 };
  const open = vi.fn(() => ({ getSheetByName: () => sheet }));
  vi.stubGlobal("SpreadsheetApp", { openById: open });
  vi.spyOn(Sheets!.Spreadsheets.Values, "batchGet").mockReturnValue({ valueRanges: [{ values: [["id"], ["01"]] }] });
  const table = new GQuery("db").from("Assets");
  expect(table.get().rows[0].id).toBe("01");
  expect(open).not.toHaveBeenCalled();
  expect(table.sheet).toBe(sheet);
  expect(table.sheet).toBe(sheet);
  expect(open).toHaveBeenCalledOnce();
  const replacement = { getSheetId: () => 4 } as GoogleAppsScript.Spreadsheet.Sheet;
  table.sheet = replacement;
  expect(table.sheet).toBe(replacement);
});

it("batches sparse ranges in order and skips empty requests", () => {
  const request = vi.spyOn(Sheets!.Spreadsheets.Values, "batchGet").mockReturnValue({ valueRanges: [
    { values: [["a"]], range: "Assets!A1" }, {},
  ] });
  const db = new GQuery("db");
  expect(db.batchGetValues([])).toEqual([]);
  expect(request).not.toHaveBeenCalled();
  expect(db.batchGetValues(["Assets!A1", "Models!B2"])).toEqual([
    { range: "Assets!A1", majorDimension: "ROWS", values: [["a"]] },
    { range: "Models!B2", majorDimension: "ROWS", values: [] },
  ]);
  expect(request).toHaveBeenCalledOnce();
});

it("projects reordered columns across sheets without reading unused columns", () => {
  const request = vi.spyOn(Sheets!.Spreadsheets.Values, "batchGet")
    .mockReturnValueOnce({ valueRanges: [{ values: [["secret", "Id", "Confirmed"]] }, { values: [["Name"]] }] })
    .mockReturnValueOnce({ valueRanges: [{ values: [["01"], [], ["03"]] }, { values: [["TRUE"], ["FALSE"]] }, { values: [["M"]] }] });
  const result = new GQuery("db").getManyProjected({ Assets: ["Id", "Confirmed"], Models: ["Name"] });
  expect((request.mock.calls[1][1] as { ranges: string[] }).ranges).toEqual(["'Assets'!B2:B", "'Assets'!C2:C", "'Models'!A2:A"]);
  expect(result.Assets.rows.map((row) => [row.Id, row.Confirmed, row.__meta.rowNum])).toEqual([
    ["01", true, 2], ["", false, 3], ["03", "", 4],
  ]);
  expect(result.Assets.rows[0]).not.toHaveProperty("secret");
});

it("rejects missing or ambiguous projected headers before fetching data", () => {
  const request = vi.spyOn(Sheets!.Spreadsheets.Values, "batchGet").mockReturnValue({ valueRanges: [{ values: [["Id", "Id"]] }] });
  expect(() => new GQuery("db").getManyProjected({ Assets: ["Id"] })).toThrow("exactly once");
  expect(request).toHaveBeenCalledOnce();
});

it("fills explicitly optional missing columns while preserving required identities and rejecting duplicates", () => {
  const request = vi.spyOn(Sheets!.Spreadsheets.Values, "batchGet")
    .mockReturnValueOnce({ valueRanges: [{ values: [["Id", "Confirmed"]] }] })
    .mockReturnValueOnce({ valueRanges: [{ values: [["001"], ["002"]] }, { values: [["TRUE"], ["FALSE"]] }] });
  const result = new GQuery("db").getManyProjected({ Assets: ["Id", "Assigned_Date", "Confirmed"] }, {
    optionalColumns: { Assets: ["Assigned_Date"] },
  });
  expect((request.mock.calls[1][1] as { ranges: string[] }).ranges).toEqual(["'Assets'!A2:A", "'Assets'!B2:B"]);
  expect(result.Assets.rows.map((row) => [row.Id, row.Assigned_Date, row.Confirmed])).toEqual([["001", "", true], ["002", "", false]]);
  request.mockReset().mockReturnValue({ valueRanges: [{ values: [["Assigned_Date", "Assigned_Date"]] }] });
  expect(() => new GQuery("db").getManyProjected({ Assets: ["Assigned_Date"] }, { optionalColumns: { Assets: ["Assigned_Date"] } })).toThrow("exactly once");
  expect(() => new GQuery("db").getManyProjected({ Assets: ["Id"] }, { optionalColumns: { Assets: ["Assigned_Date"] } })).toThrow("exactly once");
});

it("snapshot queries are isolated from callback mutations and perform no additional reads", () => {
  const request = vi.spyOn(Sheets!.Spreadsheets.Values, "batchGet").mockReturnValue({ valueRanges: [
    { values: [["id", "Model"], ["1", "M"], ["2", "N"]] },
    { values: [["name", "cost"], ["M", 25], ["N", 50]] },
  ] });
  const snapshot = new GQuery("db").readSnapshot(["Assets", "Models"]);
  expect(snapshot.from("Assets").join("Models", "name", "Model", ["cost"]).where((row) => row.cost > 30).get().rows[0].id).toBe("2");
  snapshot.from("Assets").where((row) => { row.id = "changed"; return true; }).get();
  expect(snapshot.from("Assets").orderBy("id", "desc").limit(1).get().rows[0].id).toBe("2");
  expect(() => snapshot.from("Missing")).toThrow("not captured");
  expect(snapshot.from("Assets")).not.toHaveProperty("update");
  expect(request).toHaveBeenCalledOnce();
});

it("structural batches invalidate declared sheets once and never retry ambiguous writes by default", () => {
  const observer = vi.fn(); configureGQueryWriteObserver(observer);
  const write = vi.spyOn(Sheets!.Spreadsheets, "batchUpdate").mockReturnValue({ replies: [] });
  const db = new GQuery("db");
  db.batchUpdate([{ appendCells: { sheetId: 1, fields: "userEnteredValue" } }], { affectedSheets: ["Assets", "Assets", "Outbox"] });
  expect(observer.mock.calls).toEqual([["Assets", { spreadsheetId: "db" }], ["Outbox", { spreadsheetId: "db" }]]);
  observer.mockClear(); write.mockClear();
  write.mockImplementation(() => { throw new Error("429 response lost"); });
  expect(() => db.batchUpdate([{ appendCells: {} }], { affectedSheets: ["Assets"] })).toThrow("Max retries (0)");
  expect(write).toHaveBeenCalledOnce(); expect(observer).not.toHaveBeenCalled();
});
