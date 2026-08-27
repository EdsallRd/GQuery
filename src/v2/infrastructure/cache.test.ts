import { describe, expect, it } from "vitest";
import { Fnv1aHash, canonicalStringify } from "./canonical";
import {
  ChunkedCache,
  GenerationTokenStore,
  PlainTextCacheCodec,
  buildQueryCacheKey,
} from "./cache";
import { CacheStore, PropertyStore } from "./runtime";

class MemoryCache implements CacheStore {
  public readonly values = new Map<string, string>();
  public readonly writes: string[] = [];
  public readonly ttls: number[] = [];

  public get(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  public getMany(keys: readonly string[]): Record<string, string> {
    return Object.fromEntries(
      keys.flatMap((key) => this.values.has(key) ? [[key, this.values.get(key) as string]] : []),
    );
  }
  public put(key: string, value: string, ttlSeconds: number): void {
    this.writes.push(key);
    this.ttls.push(ttlSeconds);
    this.values.set(key, value);
  }
  public putMany(values: Readonly<Record<string, string>>, ttlSeconds: number): void {
    for (const [key, value] of Object.entries(values)) {
      this.writes.push(key);
      this.ttls.push(ttlSeconds);
      this.values.set(key, value);
    }
  }
  public remove(key: string): void {
    this.values.delete(key);
  }
  public removeMany(keys: readonly string[]): void {
    keys.forEach((key) => this.values.delete(key));
  }
}

class MemoryProperties implements PropertyStore {
  public readonly values = new Map<string, string>();
  public get(key: string): string | null { return this.values.get(key) ?? null; }
  public getMany(): Record<string, string> { return Object.fromEntries(this.values); }
  public set(key: string, value: string): void { this.values.set(key, value); }
  public setMany(values: Readonly<Record<string, string>>): void {
    Object.entries(values).forEach(([key, value]) => this.values.set(key, value));
  }
  public remove(key: string): void { this.values.delete(key); }
  public removeMany(keys: readonly string[]): void { keys.forEach((key) => this.values.delete(key)); }
}

function createCache(store = new MemoryCache()) {
  let id = 0;
  return {
    store,
    cache: new ChunkedCache({
      store,
      codec: new PlainTextCacheCodec(),
      hasher: new Fnv1aHash(),
      ids: { next: () => `generation-${++id}` },
      clock: { now: () => 123 },
      random: { next: () => 0.5 },
      maxChunkCharacters: 10,
    }),
  };
}

describe("ChunkedCache", () => {
  it("publishes immutable chunks before the manifest and round-trips values", () => {
    const { cache, store } = createCache();
    const value = { rows: [{ id: "0001", payload: "a long payload" }] };
    cache.put({ table: "Assets", query: {} }, value, { ttlSeconds: 300, jitterSeconds: 20 });

    expect(store.writes.length).toBeGreaterThan(2);
    expect(store.writes.at(-1)).toMatch(/:manifest$/);
    expect(store.ttls.every((ttl) => ttl === 290)).toBe(true);
    expect(cache.get({ query: {}, table: "Assets" })).toEqual(value);
  });

  it("treats missing or corrupt chunks as a recoverable miss", () => {
    const { cache, store } = createCache();
    cache.put("key", { payload: "long enough for chunks" });
    const chunkKey = [...store.values.keys()].find((key) => !key.endsWith(":manifest"));
    expect(chunkKey).toBeDefined();
    store.values.delete(chunkKey as string);

    expect(cache.read("key")).toEqual({ state: "corrupt" });
    expect([...store.values.keys()].some((key) => key.endsWith(":manifest"))).toBe(false);
  });

  it("uses a bounded single-flight lock and rechecks after acquiring it", () => {
    const { cache } = createCache();
    let calls = 0;
    expect(cache.readThrough("key", () => ({ call: ++calls })).cache).toBe("filled");
    expect(cache.readThrough("key", () => ({ call: ++calls }))).toEqual({
      value: { call: 1 },
      cache: "hit",
    });
    expect(calls).toBe(1);
  });
});

describe("canonical cache identity and generations", () => {
  it("is stable across object insertion order and preserves scalar types", () => {
    expect(canonicalStringify({ b: 2, a: "2" })).toBe(canonicalStringify({ a: "2", b: 2 }));
    expect(canonicalStringify({ value: 2 })).not.toBe(canonicalStringify({ value: "2" }));
  });

  it("rotates table, row, and tag dependencies without maintaining a cache-key index", () => {
    const properties = new MemoryProperties();
    let id = 0;
    const generations = new GenerationTokenStore(
      properties,
      new Fnv1aHash(),
      { next: () => `token-${++id}` },
    );
    const table = { kind: "table" as const, sourceId: "book", table: "Assets" };
    expect(generations.current(table)).toBe("0");
    generations.invalidateTable("book", "Assets");
    const first = generations.snapshot([table]);
    generations.invalidateTable("book", "Assets");
    const second = generations.snapshot([table]);
    expect(first[0].token).not.toBe(second[0].token);

    const firstKey = buildQueryCacheKey({
      sourceIdentity: "book",
      schemaVersion: 2,
      headerVersion: "h1",
      query: { where: { serial: "1" } },
      generations: first,
    });
    const secondKey = buildQueryCacheKey({
      sourceIdentity: "book",
      schemaVersion: 2,
      headerVersion: "h1",
      query: { where: { serial: "1" } },
      generations: second,
    });
    expect(canonicalStringify(firstKey)).not.toBe(canonicalStringify(secondKey));
  });
});
