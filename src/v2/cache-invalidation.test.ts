import { describe, expect, it } from "vitest";
import { text } from "./codecs";
import { createGQuery } from "./database";
import { GQueryDefinitionError } from "./errors";
import { GQueryRuntimeError, type RuntimeErrorCode } from "./runtime-errors";
import { defineDatabase, source, table } from "./schema";
import { GenerationTokenStore } from "./infrastructure/cache";
import { Fnv1aHash } from "./infrastructure/canonical";
import type { PropertyStore } from "./infrastructure/runtime";
import { InMemorySheetsTransport } from "./transport";

class MemoryProperties implements PropertyStore {
  private readonly values = new Map<string, string>();

  public get(key: string): string | null { return this.values.get(key) ?? null; }
  public getMany(): Record<string, string> { return Object.fromEntries(this.values); }
  public set(key: string, value: string): void { this.values.set(key, value); }
  public setMany(values: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(values)) this.values.set(key, value);
  }
  public remove(key: string): void { this.values.delete(key); }
  public removeMany(keys: readonly string[]): void {
    for (const key of keys) this.values.delete(key);
  }
}

const schema = defineDatabase({
  version: 2,
  sources: {
    primary: source.byId("book-primary"),
    archive: source.byId("book-archive"),
  },
  tables: {
    Assets: table({
      source: "primary",
      sheet: "Assets",
      primaryKey: ["serial"],
      columns: { serial: text({ header: "Serial" }) },
      cache: {
        mode: "row-and-query",
        scope: "script",
        ttlSeconds: 300,
        tags: ["inventory-dashboard"],
      },
    }),
    ArchivedAssets: table({
      source: "archive",
      sheet: "Assets",
      primaryKey: ["serial"],
      columns: { serial: text({ header: "Serial" }) },
      cache: {
        mode: "row-and-query",
        scope: "script",
        ttlSeconds: 300,
        tags: ["inventory-dashboard"],
      },
    }),
  },
});

function generationStore() {
  let sequence = 0;
  return new GenerationTokenStore(
    new MemoryProperties(),
    new Fnv1aHash(),
    { next: () => `generation-${++sequence}` },
  );
}

function expectRuntimeCode(operation: () => unknown, code: RuntimeErrorCode): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(GQueryRuntimeError);
    expect((error as GQueryRuntimeError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
}

describe("public cache invalidation", () => {
  it("rotates table generations using each table's resolved source identity", () => {
    const generations = generationStore();
    const db = createGQuery(schema, {
      transport: new InMemorySheetsTransport(),
      generations,
    });

    expect(db.cache.invalidateTable("Assets")).toBe("generation-1");
    expect(generations.current({
      kind: "table",
      sourceId: "book-primary",
      table: "Assets",
    })).toBe("generation-1");
    expect(generations.current({
      kind: "table",
      sourceId: "book-archive",
      table: "ArchivedAssets",
    })).toBe("0");

    expect(db.cache.invalidateTable("ArchivedAssets")).toBe("generation-2");
    expect(generations.current({
      kind: "table",
      sourceId: "book-archive",
      table: "ArchivedAssets",
    })).toBe("generation-2");
  });

  it("normalizes scalar row keys to provenance-shaped keys and rotates tags", () => {
    const generations = generationStore();
    const db = createGQuery(schema, {
      transport: new InMemorySheetsTransport(),
      generations,
    });

    expect(db.cache.invalidateRow("Assets", "SX5GN1")).toBe("generation-2");
    expect(generations.current({
      kind: "table",
      sourceId: "book-primary",
      table: "Assets",
    })).toBe("generation-1");
    expect(generations.current({
      kind: "row",
      sourceId: "book-primary",
      table: "Assets",
      key: { serial: "SX5GN1" },
    })).toBe("generation-2");
    expect(db.cache.invalidateTag("inventory-dashboard")).toBe("generation-3");
    expect(generations.current({ kind: "tag", tag: "inventory-dashboard" })).toBe("generation-3");
  });

  it("makes a shared tag generation part of every tagged table snapshot key", () => {
    const generations = generationStore();
    const transport = new InMemorySheetsTransport([
      {
        spreadsheetId: "book-primary",
        sheets: [{ sheetId: 1, title: "Assets", values: [["Serial"], ["SX1"]] }],
      },
      {
        spreadsheetId: "book-archive",
        sheets: [{ sheetId: 2, title: "Assets", values: [["Serial"], ["OLD1"]] }],
      },
    ]);
    const entries = new Map<string, unknown>();
    const cache = {
      read: <T,>(key: unknown) => {
        const encoded = JSON.stringify(key);
        return entries.has(encoded)
          ? { state: "hit" as const, value: entries.get(encoded) as T }
          : { state: "miss" as const };
      },
      put: <T,>(key: unknown, value: T) => { entries.set(JSON.stringify(key), value); },
    };
    const db = createGQuery(schema, { transport, generations, cache });

    expect(db.Assets.get().stats.cacheMisses).toBe(1);
    expect(db.ArchivedAssets.get().stats.cacheMisses).toBe(1);
    transport.clearHistory();
    expect(db.Assets.get().stats.cacheHits).toBe(1);
    expect(db.ArchivedAssets.get().stats.cacheHits).toBe(1);
    expect(transport.history).toHaveLength(0);

    db.cache.invalidateTag("inventory-dashboard");
    expect(db.Assets.get().stats.cacheMisses).toBe(1);
    expect(db.ArchivedAssets.get().stats.cacheMisses).toBe(1);
    expect(transport.history.map((call) => call.kind)).toEqual(["batchGet", "batchGet"]);
  });

  it("rejects invalid schema tags and invalidation of undeclared tags", () => {
    expect(() => table({
      source: "primary",
      sheet: "Invalid",
      columns: { id: text() },
      cache: { mode: "query", scope: "script", ttlSeconds: 30, tags: [" bad "] },
    })).toThrowError(GQueryDefinitionError);

    const db = createGQuery(schema, {
      transport: new InMemorySheetsTransport(),
      generations: generationStore(),
    });
    expectRuntimeCode(() => db.cache.invalidateTag("not-declared"), "INVALID_QUERY");
  });

  it("raises structured unsupported-operation errors when no generation store is configured", () => {
    const db = createGQuery(schema, { transport: new InMemorySheetsTransport() });

    expectRuntimeCode(() => db.cache.invalidateTable("Assets"), "UNSUPPORTED_OPERATION");
    expectRuntimeCode(() => db.cache.invalidateRow("Assets", "SX5GN1"), "UNSUPPORTED_OPERATION");
    expectRuntimeCode(() => db.cache.invalidateTag("inventory-dashboard"), "UNSUPPORTED_OPERATION");
  });
});
