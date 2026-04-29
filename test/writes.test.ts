import { beforeEach, describe, expect, it } from "vitest";
import { GQuery } from "../src/index";
import { GQueryApiError } from "../src/types";
import { gasFakes, resetGasFakes } from "./setup";

function setupSheet(name: string, rows: any[][], sheetId = 7): void {
  gasFakes.sheets.set(name, { values: rows, sheetId });
}

describe("update / append / delete", () => {
  beforeEach(() => resetGasFakes());

  it("update invalidates cache so the next get re-fetches", () => {
    setupSheet("People", [
      ["Name", "Age"],
      ["Ada", "30"],
    ]);
    const gq = new GQuery("spreadsheet-aaaaaaaa");
    // prime cache
    gq.from("People").get();
    const cacheKeysBefore = gasFakes.cache.size;
    expect(cacheKeysBefore).toBeGreaterThan(0);

    gq.from<{ Name: string; Age: any }>("People")
      .where((r) => r.Name === "Ada")
      .update(() => ({ Age: 31 }));

    expect(gasFakes.batchUpdateCalls.length).toBe(1);
    expect(gasFakes.cache.size).toBe(0);
  });

  it("append invalidates cache and uses USER_ENTERED with includeValuesInResponse", () => {
    setupSheet("People", [["Name", "Age"]]);
    const gq = new GQuery("spreadsheet-aaaaaaaa");
    // prime cache
    gq.from("People").get();
    const cacheKeysBefore = gasFakes.cache.size;
    expect(cacheKeysBefore).toBeGreaterThan(0);

    const result = gq.from("People").append({ Name: "Ada", Age: 30 });
    expect(result.rows.length).toBe(1);
    expect(gasFakes.appendCalls.length).toBe(1);
    expect(gasFakes.cache.size).toBe(0);
  });

  it("append throws GQueryApiError when sheet has no header row", () => {
    setupSheet("Empty", []);
    const gq = new GQuery("spreadsheet-aaaaaaaa");
    expect(() =>
      gq.from("Empty").append({ Name: "x" } as any),
    ).toThrow(GQueryApiError);
  });

  it("delete sorts descending and invalidates cache", () => {
    setupSheet(
      "People",
      [
        ["Name"],
        ["Ada"],
        ["Lin"],
        ["Bob"],
      ],
      42,
    );
    const gq = new GQuery("spreadsheet-aaaaaaaa");
    gq.from("People").get();

    const out = gq
      .from<{ Name: string }>("People")
      .where((r) => r.Name !== "Lin")
      .delete();

    expect(out.deletedRows).toBe(2);
    const req = gasFakes.batchUpdateCalls[0];
    const startIndices = req.requests.map(
      (r: any) => r.deleteDimension.range.startIndex,
    );
    // descending order: Bob (row 4) → Ada (row 2)
    expect(startIndices).toEqual([3, 1]);
    expect(gasFakes.cache.size).toBe(0);
  });
});
