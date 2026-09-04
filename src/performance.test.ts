import { afterEach, expect, it, vi } from "vitest";
import { callHandler, configureGQueryObserver } from "./ratelimit";
import { configureGQueryWriteObserver, GQuery } from "./index";

afterEach(() => {
  configureGQueryObserver();
  configureGQueryWriteObserver();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("counts actual attempts and value rows without exposing source data", () => {
  const report = vi.fn();
  configureGQueryObserver(report);
  const operation = vi.fn()
    .mockImplementationOnce(() => { throw new Error("429 private details"); })
    .mockReturnValue({ valueRanges: [{ values: [["private"]] }, { values: [[1], [2]] }] });
  expect(callHandler(operation, 1, "values.batchGet", 2).valueRanges).toHaveLength(2);
  expect(report.mock.calls.map(([event]) => [event.attempt, event.succeeded, event.valueRows]))
    .toEqual([[1, false, 0], [2, true, 3]]);
  expect(JSON.stringify(report.mock.calls)).not.toContain("private");
});

it("does not turn successful writes into failures if diagnostics fail", () => {
  configureGQueryObserver(() => { throw new Error("observer failed"); });
  expect(callHandler(() => 42)).toBe(42);
});

it("reuses handles per instance and spreadsheet without caching table reads or query options", () => {
  const sheet = { getSheetId: () => 1 };
  const getSheetByName = vi.fn(() => sheet);
  const openById = vi.fn((_id: string) => ({ getSheetByName }));
  vi.stubGlobal("SpreadsheetApp", { openById });
  const read = vi.spyOn(Sheets!.Spreadsheets.Values, "batchGet").mockReturnValue({
    valueRanges: [{ values: [["id"], ["1"]] }],
  });
  const query = new GQuery("first");
  const first = query.from("Assets");
  const second = query.from("Assets");
  expect(first).not.toBe(second);
  expect(first.sheet).toBe(second.sheet);
  first.get();
  second.get();
  query.from("Students");
  expect(openById).toHaveBeenCalledTimes(1);
  expect(getSheetByName).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(2);
  query.spreadsheetId = "second";
  query.from("Assets");
  new GQuery("first").from("Assets");
  expect(openById.mock.calls.map(([id]) => id)).toEqual(["first", "second", "first"]);
});

it("does not retain a missing sheet handle after the sheet is created", () => {
  const getSheetByName = vi.fn().mockReturnValueOnce(null).mockReturnValue({ getSheetId: () => 1 });
  vi.stubGlobal("SpreadsheetApp", { openById: () => ({ getSheetByName }) });
  const query = new GQuery("spreadsheet");
  expect(query.from("Assets").sheet).toBeUndefined();
  expect(query.from("Assets").sheet).toBeDefined();
  expect(getSheetByName).toHaveBeenCalledTimes(2);
});

it("invalidates an actual table update once and contains write-observer failures", () => {
  vi.stubGlobal("SpreadsheetApp", { openById: () => ({ getSheetByName: () => ({ getSheetId: () => 1 }) }) });
  const cache = { get: () => null, remove: vi.fn(), removeAll: vi.fn(), put: vi.fn() };
  vi.stubGlobal("CacheService", { getScriptCache: () => cache });
  vi.spyOn(Sheets!.Spreadsheets.Values, "get").mockReturnValue({
    values: [["id", "name"], ["1", "before"]],
  });
  const write = vi.spyOn(Sheets!.Spreadsheets.Values, "batchUpdate").mockReturnValue({});
  const observer = vi.fn(() => { throw new Error("Application cache failed"); });
  configureGQueryWriteObserver(observer);
  expect(new GQuery("spreadsheet").from("Assets").update(() => ({ name: "after" })).rows[0].name).toBe("after");
  expect(write).toHaveBeenCalledTimes(1);
  expect(observer).toHaveBeenCalledExactlyOnceWith("Assets");
  expect(cache.remove).toHaveBeenCalledExactlyOnceWith("gq:Assets:list");
});

it("skips writes and invalidation for unchanged updates, unmatched deletes, and empty appends or batches", () => {
  vi.stubGlobal("SpreadsheetApp", { openById: () => ({ getSheetByName: () => ({ getSheetId: () => 1 }) }) });
  vi.spyOn(Sheets!.Spreadsheets.Values, "get").mockReturnValue({
    values: [["id", "name"], ["1", "unchanged"]],
  });
  const write = vi.spyOn(Sheets!.Spreadsheets.Values, "batchUpdate");
  const append = vi.spyOn(Sheets!.Spreadsheets.Values, "append");
  const remove = vi.spyOn(Sheets!.Spreadsheets, "batchUpdate");
  const observer = vi.fn();
  configureGQueryWriteObserver(observer);
  const query = new GQuery("spreadsheet");
  const table = query.from("Assets");
  table.update((row) => row);
  table.where(() => false).update(() => ({ name: "after" }));
  table.where(() => false).delete();
  expect(table.append([])).toEqual({ rows: [], headers: [] });
  table.where(() => true).append([]);
  expect(query.batchUpdateValues([]).responses).toEqual([]);
  expect(query.batchUpdateValues([{ range: "Assets!A1", values: [[]] }]).totalUpdatedCells).toBe(0);
  expect(write).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(observer).not.toHaveBeenCalled();
});
