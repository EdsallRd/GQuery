import { describe, expect, it } from "vitest";
import { formula, text } from "./codecs";
import { createGQuery } from "./database";
import { SELECTION_INTERNAL } from "./selection";
import { defineDatabase, source, table } from "./schema";
import { InMemorySheetsTransport } from "./transport";

const generations = {
  current: () => "0",
  invalidateTable: () => "1",
  invalidateRow: () => "1",
  invalidateTag: () => "1",
};

const schema = defineDatabase({
  version: 2,
  sources: { main: source.byId("metadata-book") },
  tables: {
    Assets: table({
      source: "main",
      sheet: "Assets",
      primaryKey: ["serial"],
      columns: {
        serial: text({ header: "Serial" }),
        label: formula({ header: "Label" }),
      },
      cache: { mode: "row-and-query", scope: "script", ttlSeconds: 300 },
    }),
    Models: table({
      source: "main",
      sheet: "Models",
      primaryKey: ["id"],
      columns: { id: text({ header: "ID" }), name: text({ header: "Name" }) },
      cache: { mode: "row-and-query", scope: "script", ttlSeconds: 300 },
    }),
  },
});

class MemoryRuntimeCache {
  private readonly entries = new Map<string, unknown>();

  public read<T>(key: unknown) {
    const encoded = JSON.stringify(key);
    return this.entries.has(encoded)
      ? { state: "hit" as const, value: this.entries.get(encoded) as T }
      : { state: "miss" as const };
  }

  public put<T>(key: unknown, value: T): void {
    this.entries.set(JSON.stringify(key), value);
  }

  public mutate(tableName: string, mutation: (value: Record<string, unknown>) => void): void {
    const value = [...this.entries.values()].find(
      (candidate) => (candidate as { tableName?: unknown })?.tableName === tableName,
    );
    if (value === undefined) throw new Error(`No cached payload for ${tableName}.`);
    mutation(value as Record<string, unknown>);
  }
}

function transport() {
  return new InMemorySheetsTransport([{
    spreadsheetId: "metadata-book",
    sheets: [
      {
        sheetId: 7,
        title: "Assets",
        values: [["Serial", "Label"], ["SX1", "=A2&\" asset\""]],
      },
      {
        sheetId: 8,
        title: "Models",
        values: [["ID", "Name"], ["m1", "Laptop"]],
      },
    ],
  }]);
}

describe("generation-keyed cached sheet identity", () => {
  it("reports actual cold, cache, and bounded execution modes with matching steps", () => {
    const sheets = transport();
    const cache = new MemoryRuntimeCache();
    const coldDb = createGQuery(schema, { transport: sheets, cache, generations });
    const coldQuery = coldDb.Assets.where({ serial: "SX1" });
    const cold = coldDb.executor.execute(coldQuery.executable());
    expect(cold.plan.mode).toBe("full-scan");
    expect(cold.plan.warnings.map((warning) => warning.code)).toContain("FULL_SCAN");
    expect(cold.plan.steps[0]).toMatchObject({
      kind: "range-read",
      ranges: ["'Assets'"],
    });

    sheets.clearHistory();
    const warmDb = createGQuery(schema, { transport: sheets, cache, generations });
    const warm = warmDb.executor.execute(warmDb.Assets.where({ serial: "SX1" }).executable());
    expect(warm.plan.mode).toBe("cache");
    expect(warm.plan.steps[0]).toMatchObject({ kind: "cache-read", ranges: [] });
    expect(warm.plan.warnings.map((warning) => warning.code)).not.toContain("FULL_SCAN");
    expect(sheets.history).toHaveLength(0);

    const uncachedSheets = transport();
    const uncachedDb = createGQuery(schema, { transport: uncachedSheets });
    expect(uncachedDb.executor.execute(
      uncachedDb.Assets.where({ serial: "SX1" }).executable(),
    ).plan.mode).toBe("full-scan");
    uncachedSheets.clearHistory();
    const bounded = uncachedDb.executor.execute(
      uncachedDb.Assets.where({ serial: "SX1" }).executable(),
    );
    expect(bounded.plan.mode).toBe("bounded");
    expect(bounded.plan.steps[0].kind).toBe("locator-read");
    expect(bounded.plan.steps[0].ranges).toEqual(["'Assets'!A2:B2"]);
    expect(uncachedSheets.history.map((call) => call.kind)).toEqual(["batchGet"]);
  });

  it("serves a fresh executor without metadata or values calls and preserves formula provenance", () => {
    const sheets = transport();
    const cache = new MemoryRuntimeCache();
    const coldDb = createGQuery(schema, { transport: sheets, cache, generations });
    const cold = coldDb.batch({ assets: coldDb.Assets.all(), models: coldDb.Models.all() }).get();

    expect(cold.assets.stats.apiCalls).toBe(2); // one metadata call plus one batchGet
    expect(cold.assets.stats.cacheMisses).toBe(2);
    expect(sheets.history.map((call) => call.kind)).toEqual([
      "getSpreadsheetMetadata",
      "batchGet",
    ]);
    sheets.clearHistory();

    const warmDb = createGQuery(schema, { transport: sheets, cache, generations });
    const warm = warmDb.batch({ assets: warmDb.Assets.all(), models: warmDb.Models.all() }).get();
    expect(warm.assets.stats.apiCalls).toBe(0);
    expect(warm.assets.stats.cacheHits).toBe(2);
    expect(warm.assets.rows[0].label).toBe("=A2&\" asset\"");
    expect(warm.assets[SELECTION_INTERNAL].materialized[0].provenance.sheetId).toBe(7);
    expect(sheets.history).toHaveLength(0);
  });

  it("rejects stale cached sheet metadata and falls back to one counted metadata miss", () => {
    const sheets = transport();
    const cache = new MemoryRuntimeCache();
    createGQuery(schema, { transport: sheets, cache, generations }).Assets.get();
    cache.mutate("Assets", (payload) => {
      payload.sheet = { ...(payload.sheet as object), sheetId: -1, title: "Old Assets" };
    });
    sheets.clearHistory();

    const result = createGQuery(schema, { transport: sheets, cache, generations }).Assets.get();
    expect(result.rows[0].serial).toBe("SX1");
    expect(result.stats).toMatchObject({ apiCalls: 2, cacheHits: 0, cacheMisses: 1 });
    expect(sheets.history.map((call) => call.kind)).toEqual([
      "getSpreadsheetMetadata",
      "batchGet",
    ]);
  });

  it("rejects a cached header fingerprint mismatch instead of decoding untrusted provenance", () => {
    const sheets = transport();
    const cache = new MemoryRuntimeCache();
    createGQuery(schema, { transport: sheets, cache, generations }).Assets.get();
    cache.mutate("Assets", (payload) => { payload.headerFingerprint = "stale-header"; });
    sheets.clearHistory();

    const result = createGQuery(schema, { transport: sheets, cache, generations }).Assets.get();
    expect(result.rows[0].label).toBe("=A2&\" asset\"");
    expect(result.stats).toMatchObject({ apiCalls: 2, cacheHits: 0, cacheMisses: 1 });
    expect(sheets.history.map((call) => call.kind)).toEqual([
      "getSpreadsheetMetadata",
      "batchGet",
    ]);
  });
});
