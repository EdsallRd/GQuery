import { beforeEach, describe, expect, it } from "vitest";
import { GQuery } from "../src/index";
import { gasFakes, resetGasFakes } from "./setup";

function setupSheet(name: string, rows: any[][]): void {
  gasFakes.sheets.set(name, { values: rows, sheetId: 0 });
}

describe("getMany / get", () => {
  beforeEach(() => resetGasFakes());

  it("fetches a sheet on first call and serves from cache on the second", () => {
    setupSheet("People", [
      ["Name", "Age"],
      ["Ada", "30"],
      ["Lin", "25"],
    ]);

    const gq = new GQuery("spreadsheet-aaaaaaaa");
    const first = gq.from("People").get();
    expect(first.rows.length).toBe(2);
    expect(first.rows[0].Name).toBe("Ada");

    const callsBefore = (Sheets as any).Spreadsheets.Values.batchGet.mock.calls
      .length;
    const second = gq.from("People").get();
    const callsAfter = (Sheets as any).Spreadsheets.Values.batchGet.mock.calls
      .length;

    expect(second.rows.length).toBe(2);
    expect(callsAfter).toBe(callsBefore); // served from cache, no additional RPC
  });

  it("respects cache:false to bypass the read cache", () => {
    setupSheet("People", [
      ["Name"],
      ["Ada"],
    ]);
    const gq = new GQuery("spreadsheet-aaaaaaaa");
    gq.from("People").get();
    const callsBefore = (Sheets as any).Spreadsheets.Values.batchGet.mock.calls
      .length;
    gq.from("People").get({ cache: false });
    const callsAfter = (Sheets as any).Spreadsheets.Values.batchGet.mock.calls
      .length;
    expect(callsAfter).toBe(callsBefore + 1);
  });

  it("applies type conversion in a single pass (booleans, dates, JSON)", () => {
    setupSheet("Mix", [
      ["Active", "When", "Tags"],
      ["true", "4/29/2026", '["x"]'],
    ]);
    const gq = new GQuery("spreadsheet-aaaaaaaa");
    const result = gq.from("Mix").get();
    expect(result.rows[0].Active).toBe(true);
    expect(result.rows[0].When).toBeInstanceOf(Date);
    expect(result.rows[0].Tags).toEqual(["x"]);
  });

  it(".select() projects strict columns (no Model/Model_Name special case)", () => {
    setupSheet("Cars", [
      ["Model", "Year", "Color"],
      ["X", "2024", "Red"],
    ]);
    setupSheet("Specs", [
      ["Model", "Engine"],
      ["X", "V8"],
    ]);

    const gq = new GQuery("spreadsheet-aaaaaaaa");
    const result = gq
      .from("Cars")
      .join("Specs", "Model", "Model")
      .select(["Model"])
      .get();

    // strict projection — Engine is NOT pulled in just because the select
    // happens to mention "Model"
    expect(result.headers).toEqual(["Model"]);
    expect(Object.keys(result.rows[0])).toEqual(["__meta", "Model"]);
  });

  it(".includeJoinColumns() opts back into the legacy include-everything-joined behavior", () => {
    setupSheet("Cars", [
      ["Model", "Year"],
      ["X", "2024"],
    ]);
    setupSheet("Specs", [
      ["Model", "Engine"],
      ["X", "V8"],
    ]);
    const gq = new GQuery("spreadsheet-aaaaaaaa");
    const result = gq
      .from("Cars")
      .join("Specs", "Model", "Model")
      .select(["Model"])
      .includeJoinColumns()
      .get();
    expect(result.headers).toContain("Engine");
  });
});
