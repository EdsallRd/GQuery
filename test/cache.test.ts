import { beforeEach, describe, expect, it } from "vitest";
import { GQueryCache } from "../src/cache";
import { GQueryRow } from "../src/types";
import { gasFakes, resetGasFakes } from "./setup";

function makeRows(count: number): GQueryRow[] {
  const rows: GQueryRow[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      __meta: { rowNum: i + 2, colLength: 2 },
      Name: `row-${i}`,
      Score: i,
    });
  }
  return rows;
}

describe("GQueryCache", () => {
  beforeEach(() => resetGasFakes());

  it("round-trips a small payload uncompressed", () => {
    const cache = new GQueryCache("spreadsheet-aaaaaaaa");
    const value = { headers: ["Name", "Score"], rows: makeRows(3) };
    cache.put("Sheet1", value, {
      range: "all",
      valueRender: "FORMATTED_VALUE",
      dateRender: "FORMATTED_STRING",
    });
    const hit = cache.get("Sheet1", {
      range: "all",
      valueRender: "FORMATTED_VALUE",
      dateRender: "FORMATTED_STRING",
    });
    expect(hit).not.toBeNull();
    expect(hit!.headers).toEqual(value.headers);
    expect(hit!.rows.length).toBe(3);
    expect(hit!.rows[0].Name).toBe("row-0");
  });

  it("splits rows into chunks based on chunkSize", () => {
    const cache = new GQueryCache("spreadsheet-aaaaaaaa", { chunkSize: 5 });
    const value = { headers: ["Name", "Score"], rows: makeRows(13) };
    cache.put("Sheet1", value, {
      range: "all",
      valueRender: "FV",
      dateRender: "FS",
    });
    // 13 rows / 5 chunkSize = 3 chunks
    const chunkKeys = [...gasFakes.cache.keys()].filter((k) =>
      k.endsWith(":chunk:0") ||
      k.endsWith(":chunk:1") ||
      k.endsWith(":chunk:2"),
    );
    expect(chunkKeys.length).toBe(3);

    const hit = cache.get("Sheet1", {
      range: "all",
      valueRender: "FV",
      dateRender: "FS",
    });
    expect(hit!.rows.length).toBe(13);
    expect(hit!.rows[12].Name).toBe("row-12");
  });

  it("compresses payloads above the threshold (gzip prefix in storage)", () => {
    const cache = new GQueryCache("spreadsheet-aaaaaaaa", {
      compressThreshold: 100,
    });
    cache.put(
      "Sheet1",
      { headers: ["A"], rows: makeRows(2) },
      { range: "all", valueRender: "FV", dateRender: "FS" },
    );
    const stored = [...gasFakes.cache.values()].find((v) => v.startsWith("g:"));
    expect(stored).toBeDefined();
    const hit = cache.get("Sheet1", {
      range: "all",
      valueRender: "FV",
      dateRender: "FS",
    });
    expect(hit!.rows.length).toBe(2);
  });

  it("returns null on partial-hit chunks (treated as miss)", () => {
    const cache = new GQueryCache("spreadsheet-aaaaaaaa", { chunkSize: 2 });
    cache.put(
      "Sheet1",
      { headers: ["A"], rows: makeRows(5) },
      { range: "all", valueRender: "FV", dateRender: "FS" },
    );
    // Manually drop one chunk to simulate partial eviction.
    const chunkKey = [...gasFakes.cache.keys()].find((k) =>
      k.endsWith(":chunk:1"),
    )!;
    gasFakes.cache.delete(chunkKey);

    const hit = cache.get("Sheet1", {
      range: "all",
      valueRender: "FV",
      dateRender: "FS",
    });
    expect(hit).toBeNull();
  });

  it("invalidate(sheet) drops every key tracked for that sheet", () => {
    const cache = new GQueryCache("spreadsheet-aaaaaaaa", { chunkSize: 2 });
    cache.put(
      "Sheet1",
      { headers: ["A"], rows: makeRows(4) },
      { range: "all", valueRender: "FV", dateRender: "FS" },
    );
    cache.put(
      "Sheet1",
      { headers: ["A"], rows: makeRows(4) },
      { range: "all", valueRender: "UNFORMATTED", dateRender: "FS" },
    );

    expect(gasFakes.cache.size).toBeGreaterThan(0);
    cache.invalidate("Sheet1");
    expect(gasFakes.cache.size).toBe(0);
  });

  it("isEnabled=false short-circuits all operations (no cache writes)", () => {
    const cache = new GQueryCache("spreadsheet-aaaaaaaa", false);
    expect(cache.enabled).toBe(false);
    cache.put(
      "Sheet1",
      { headers: ["A"], rows: makeRows(1) },
      { range: "all", valueRender: "FV", dateRender: "FS" },
    );
    expect(gasFakes.cache.size).toBe(0);
  });

  it("query cache round-trip", () => {
    const cache = new GQueryCache("spreadsheet-aaaaaaaa");
    const value = { headers: ["A"], rows: makeRows(2) };
    cache.putQuery("Sheet1", "select * where A > 0", value);
    const hit = cache.getQuery("Sheet1", "select * where A > 0");
    expect(hit).not.toBeNull();
    expect(hit!.rows.length).toBe(2);
  });
});
