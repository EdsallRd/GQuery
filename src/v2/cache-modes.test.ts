import { describe, expect, it } from "vitest";
import { text } from "./codecs";
import { createGQuery } from "./database";
import type { RuntimeCacheAdapter, RuntimeGenerationAdapter } from "./executor";
import { belongsTo, defineDatabase, source, table, type CacheMode } from "./schema";
import type { SheetsTransport } from "./transport";
import { InMemorySheetsTransport } from "./transport";

const constantGenerations = {
  current: () => "0",
  invalidateTable: () => "1",
  invalidateRow: () => "1",
  invalidateTag: () => "1",
};

class MemoryCache implements RuntimeCacheAdapter {
  public readonly entries = new Map<string, unknown>();

  public read<T>(key: unknown) {
    const encoded = JSON.stringify(key);
    return this.entries.has(encoded)
      ? { state: "hit" as const, value: this.entries.get(encoded) as T }
      : { state: "miss" as const };
  }

  public put<T>(key: unknown, value: T): void {
    this.entries.set(JSON.stringify(key), value);
  }

  public retainKinds(...kinds: readonly string[]): void {
    for (const encoded of this.entries.keys()) {
      const kind = (JSON.parse(encoded) as { readonly kind?: unknown }).kind;
      if (!kinds.includes(String(kind))) this.entries.delete(encoded);
    }
  }
}

class SingleFlightMemoryCache extends MemoryCache {
  public readThroughCalls = 0;

  public readThrough<T>(
    key: unknown,
    producer: () => T,
  ): { readonly value: T; readonly cache: "hit" | "filled" } {
    this.readThroughCalls += 1;
    const current = this.read<T>(key);
    if (current.state === "hit") return { value: current.value as T, cache: "hit" };
    const value = producer();
    this.put(key, value);
    return { value, cache: "filled" };
  }
}

function schemaWithMode(mode: CacheMode, allowStaleOnQuota = false) {
  return defineDatabase({
    version: 2,
    sources: { main: source.byId("cache-book") },
    tables: {
      Assets: table({
        source: "main",
        sheet: "Assets",
        primaryKey: ["serial"],
        columns: {
          serial: text({ header: "Serial" }),
          status: text({ header: "Status" }),
        },
        cache: {
          mode,
          scope: "script",
          ttlSeconds: 300,
          allowStaleOnQuota,
        },
      }),
    },
  });
}

function sheets(): InMemorySheetsTransport {
  return new InMemorySheetsTransport([{
    spreadsheetId: "cache-book",
    sheets: [{
      sheetId: 1,
      title: "Assets",
      values: [
        ["Serial", "Status"],
        ["A-1", "Available"],
        ["A-2", "Assigned"],
      ],
    }],
  }]);
}

function generations(): RuntimeGenerationAdapter & { rotate(table: string): void } {
  const tokens = new Map<string, string>();
  let next = 0;
  return {
    current: (dependency) => dependency.kind === "table"
      ? tokens.get(`${dependency.sourceId}:${dependency.table}`) ?? "0"
      : tokens.get(`tag:${dependency.tag}`) ?? "0",
    invalidateTable: (sourceId, tableName) => {
      const token = `g${++next}`;
      tokens.set(`${sourceId}:${tableName}`, token);
      return token;
    },
    rotate(tableName) {
      this.invalidateTable("cache-book", tableName);
    },
  };
}

describe("table cache modes", () => {
  it("rejects injected caches without durable invalidation and scoped identities", () => {
    const cache = new MemoryCache();
    expect(() => createGQuery(schemaWithMode("row"), {
      transport: sheets(),
      cache,
    })).toThrowError(expect.objectContaining({ code: "DEFINITION_INVALID" }));

    const userSchema = defineDatabase({
      version: 2,
      sources: { main: source.byId("cache-book") },
      tables: {
        Assets: table({
          source: "main",
          sheet: "Assets",
          primaryKey: ["serial"],
          columns: { serial: text({ header: "Serial" }), status: text({ header: "Status" }) },
          cache: { mode: "row", scope: "user", ttlSeconds: 300 },
        }),
      },
    });
    expect(() => createGQuery(userSchema, {
      transport: sheets(),
      cache,
      generations: constantGenerations,
    })).toThrowError(expect.objectContaining({ code: "DEFINITION_INVALID" }));
    const database = createGQuery(userSchema, {
      transport: sheets(),
      cache,
      generations: constantGenerations,
      scopeIdentity: () => null,
    });
    expect(() => database.Assets.get()).toThrow(/non-empty identity/);
  });

  it("makes query-only entries exact to the normalized query plan", () => {
    const transport = sheets();
    const cache = new MemoryCache();
    const schema = schemaWithMode("query");

    createGQuery(schema, { transport, cache, generations: constantGenerations }).Assets.where({ serial: "A-1" }).get();
    transport.clearHistory();
    expect(createGQuery(schema, { transport, cache, generations: constantGenerations }).Assets.where({ serial: "A-1" }).get().rows)
      .toHaveLength(1);
    expect(transport.history).toHaveLength(0);

    transport.clearHistory();
    expect(createGQuery(schema, { transport, cache, generations: constantGenerations }).Assets.where({ serial: "A-2" }).get().rows)
      .toHaveLength(1);
    expect(transport.history.map((call) => call.kind)).toEqual([
      "getSpreadsheetMetadata",
      "batchGet",
    ]);
  });

  it("shares row snapshots across different queries, while whereLocal is never query-cached", () => {
    const transport = sheets();
    const rowCache = new MemoryCache();
    const rowSchema = schemaWithMode("row");
    createGQuery(rowSchema, { transport, cache: rowCache, generations: constantGenerations }).Assets.where({ serial: "A-1" }).get();
    transport.clearHistory();
    expect(createGQuery(rowSchema, { transport, cache: rowCache, generations: constantGenerations }).Assets.where({ serial: "A-2" }).get().rows)
      .toEqual([{ serial: "A-2", status: "Assigned" }]);
    expect(transport.history).toHaveLength(0);

    const queryTransport = sheets();
    const queryCache = new MemoryCache();
    const querySchema = schemaWithMode("query");
    createGQuery(querySchema, { transport: queryTransport, cache: queryCache, generations: constantGenerations })
      .Assets.whereLocal((row) => row.serial === "A-1").get();
    queryTransport.clearHistory();
    createGQuery(querySchema, { transport: queryTransport, cache: queryCache, generations: constantGenerations })
      .Assets.whereLocal((row) => row.serial === "A-1").get();
    expect(queryTransport.history.map((call) => call.kind)).toEqual([
      "getSpreadsheetMetadata",
      "batchGet",
    ]);
    expect(queryCache.entries.size).toBe(0);
  });

  it("includes every joined table generation in query cache identity", () => {
    const schema = defineDatabase({
      version: 2,
      sources: { main: source.byId("cache-book") },
      tables: {
        Assets: table({
          source: "main",
          sheet: "Assets",
          primaryKey: ["serial"],
          columns: {
            serial: text({ header: "Serial" }),
            modelId: text({ header: "Model" }),
          },
          relations: { model: belongsTo("Models", { local: "modelId", foreign: "id" }) },
          cache: { mode: "query", scope: "script", ttlSeconds: 300 },
        }),
        Models: table({
          source: "main",
          sheet: "Models",
          primaryKey: ["id"],
          columns: { id: text({ header: "ID" }), name: text({ header: "Name" }) },
          cache: { mode: "query", scope: "script", ttlSeconds: 300 },
        }),
      },
    });
    const transport = new InMemorySheetsTransport([{
      spreadsheetId: "cache-book",
      sheets: [
        { sheetId: 1, title: "Assets", values: [["Serial", "Model"], ["A-1", "m1"]] },
        { sheetId: 2, title: "Models", values: [["ID", "Name"], ["m1", "Laptop"]] },
      ],
    }]);
    const cache = new MemoryCache();
    const tokenStore = generations();
    createGQuery(schema, { transport, cache, generations: tokenStore })
      .Assets.include("model").get();
    transport.clearHistory();
    expect(createGQuery(schema, { transport, cache, generations: tokenStore })
      .Assets.include("model").get().rows[0].model).toEqual({ id: "m1", name: "Laptop" });
    expect(transport.history).toHaveLength(0);

    tokenStore.rotate("Models");
    transport.clearHistory();
    const refreshed = createGQuery(schema, { transport, cache, generations: tokenStore })
      .Assets.include("model").get();
    expect(refreshed.stats.cacheMisses).toBe(2);
    expect(transport.history.map((call) => call.kind)).toEqual([
      "getSpreadsheetMetadata",
      "batchGet",
    ]);
  });

  it("persists key locators, verifies their row, and narrowly rebuilds a stale position", () => {
    const transport = sheets();
    const cache = new MemoryCache();
    const schema = schemaWithMode("row");
    createGQuery(schema, { transport, cache, generations: constantGenerations }).Assets.where({ serial: "A-1" }).get();
    cache.retainKinds("locator-index");

    transport.atomicBatchUpdate("cache-book", [
      {
        kind: "updateCells",
        sheetId: 1,
        startRowIndex: 1,
        startColumnIndex: 0,
        values: [["A-X", "Available"]],
      },
      {
        kind: "updateCells",
        sheetId: 1,
        startRowIndex: 2,
        startColumnIndex: 0,
        values: [["A-1", "Assigned"]],
      },
    ]);
    transport.clearHistory();

    const selection = createGQuery(schema, { transport, cache, generations: constantGenerations })
      .Assets.where({ serial: "A-1" }).get();
    expect(selection.rows).toEqual([{ serial: "A-1", status: "Assigned" }]);
    expect(selection.stats).toMatchObject({ cacheHits: 1, cacheMisses: 1 });
    expect(transport.history.map((call) => call.kind)).toEqual([
      "getSpreadsheetMetadata",
      "batchGet",
      "batchGet",
      "batchGet",
    ]);
    expect(transport.history.slice(1).map((call) => call.ranges)).toEqual([
      ["'Assets'!A2:B2"],
      ["'Assets'!A2:A"],
      ["'Assets'!A3:B3"],
    ]);
  });

  it("treats a missing persisted locator key as a scan miss after an external insert", () => {
    const transport = sheets();
    const cache = new MemoryCache();
    const schema = schemaWithMode("row");
    createGQuery(schema, { transport, cache, generations: constantGenerations })
      .Assets.where({ serial: "A-1" }).get();
    cache.retainKinds("locator-index");
    transport.atomicBatchUpdate("cache-book", [{
      kind: "appendRows",
      sheetId: 1,
      values: [["A-3", "Repair"]],
    }]);
    transport.clearHistory();

    const selection = createGQuery(schema, {
      transport,
      cache,
      generations: constantGenerations,
    }).Assets.where({ serial: "A-3" }).get();

    expect(selection.rows).toEqual([{ serial: "A-3", status: "Repair" }]);
    expect(transport.history.map((call) => call.kind)).toEqual([
      "getSpreadsheetMetadata",
      "batchGet",
      "batchGet",
    ]);
    expect(transport.history.slice(1).map((call) => call.ranges)).toEqual([
      ["'Assets'!A2:A"],
      ["'Assets'!A4:B4"],
    ]);
  });

  it("routes a cold snapshot fill through the adapter's bounded single-flight", () => {
    const transport = sheets();
    const cache = new SingleFlightMemoryCache();
    const schema = schemaWithMode("row-and-query");
    const result = createGQuery(schema, { transport, cache, generations: constantGenerations })
      .Assets.where({ serial: { $startsWith: "A-" } }).get();

    expect(result.rows).toHaveLength(2);
    expect(cache.readThroughCalls).toBe(1);
    expect(transport.history.map((call) => call.kind)).toEqual([
      "getSpreadsheetMetadata",
      "batchGet",
    ]);
  });

  it("uses an opt-in stale snapshot only after a quota failure", () => {
    const base = sheets();
    const cache = new MemoryCache();
    const tokenStore = generations();
    const schema = schemaWithMode("query", true);
    const query = createGQuery(schema, { transport: base, cache, generations: tokenStore })
      .Assets.where({ serial: "A-1" });
    query.get();
    tokenStore.rotate("Assets");

    const quotaTransport = new Proxy(base as SheetsTransport, {
      get(target, property, receiver) {
        if (property === "getSpreadsheetMetadata" || property === "batchGet") {
          return () => { throw { statusCode: 429, message: "quota exceeded" }; };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const db = createGQuery(schema, { transport: quotaTransport, cache, generations: tokenStore });
    const executed = db.executor.execute(db.Assets.where({ serial: "A-1" }).executable());
    expect(executed.selection.rows).toEqual([{ serial: "A-1", status: "Available" }]);
    expect(executed.selection.stats).toMatchObject({ cacheMisses: 1, staleCacheHits: 1 });
    expect(executed.plan.mode).toBe("cache");
    expect(executed.plan.warnings).toContainEqual(expect.objectContaining({
      code: "STALE_CACHE",
      table: "Assets",
    }));

    const failedTransport = new Proxy(base as SheetsTransport, {
      get(target, property, receiver) {
        if (property === "getSpreadsheetMetadata" || property === "batchGet") {
          return () => { throw new Error("permission denied"); };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(() => createGQuery(schema, {
      transport: failedTransport,
      cache,
      generations: tokenStore,
    }).Assets.where({ serial: "A-1" }).get()).toThrow("permission denied");
  });
});
