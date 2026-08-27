import { HashFunction, AppsScriptSha256Hash, canonicalStringify, hashCanonical } from "./canonical";
import { GQueryV2Error } from "./errors";
import {
  AppsScriptCacheStore,
  AppsScriptLock,
  AppsScriptPropertyStore,
  CacheStore,
  Clock,
  IdGenerator,
  PropertyStore,
  RandomSource,
  SyncLock,
  mathRandomSource,
  systemClock,
} from "./runtime";

export interface CacheTextCodec {
  readonly name: string;
  encode(value: string): string;
  decode(value: string): string;
}

export class AppsScriptGzipBase64Codec implements CacheTextCodec {
  public readonly name = "gzip-base64-v1";

  public encode(value: string): string {
    const compressed = Utilities.gzip(Utilities.newBlob(value, "application/json"));
    return Utilities.base64Encode(compressed.getBytes());
  }

  public decode(value: string): string {
    const compressed = Utilities.newBlob(Utilities.base64Decode(value), "application/gzip");
    return Utilities.ungzip(compressed).getDataAsString("UTF-8");
  }
}

export class PlainTextCacheCodec implements CacheTextCodec {
  public readonly name = "plain-text-v1";

  public encode(value: string): string {
    return value;
  }

  public decode(value: string): string {
    return value;
  }
}

interface ChunkManifest {
  readonly version: 1;
  readonly codec: string;
  readonly generation: string;
  readonly chunks: number;
  readonly checksum: string;
  readonly createdAtMs: number;
}

export interface ChunkedCachePolicy {
  readonly ttlSeconds?: number;
  readonly jitterSeconds?: number;
}

export type CacheReadState = "hit" | "miss" | "corrupt";

export interface CacheReadResult<T> {
  readonly state: CacheReadState;
  readonly value?: T;
}

export type ReadThroughState = "hit" | "hit-after-wait" | "filled" | "uncached";

export interface ReadThroughResult<T> {
  readonly value: T;
  readonly cache: ReadThroughState;
}

export interface ChunkedCacheDependencies {
  readonly store: CacheStore;
  readonly codec: CacheTextCodec;
  readonly hasher: HashFunction;
  readonly ids: IdGenerator;
  readonly clock?: Clock;
  readonly random?: RandomSource;
  readonly lock?: SyncLock;
  readonly namespace?: string;
  readonly maxChunkCharacters?: number;
  readonly lockTimeoutMs?: number;
}

function parseManifest(value: string | null): ChunkManifest | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ChunkManifest>;
    if (
      parsed.version !== 1 ||
      typeof parsed.codec !== "string" ||
      typeof parsed.generation !== "string" ||
      !Number.isInteger(parsed.chunks) ||
      (parsed.chunks ?? 0) < 1 ||
      typeof parsed.checksum !== "string" ||
      typeof parsed.createdAtMs !== "number"
    ) {
      return null;
    }
    return parsed as ChunkManifest;
  } catch {
    return null;
  }
}

function validateTtl(policy: ChunkedCachePolicy): { ttlSeconds: number; jitterSeconds: number } {
  const ttlSeconds = policy.ttlSeconds ?? 300;
  const jitterSeconds = policy.jitterSeconds ?? 0;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 21_600) {
    throw new GQueryV2Error(
      "CACHE_CONFIGURATION",
      "Cache TTL must be an integer from 1 to 21600 seconds.",
      { ttlSeconds },
    );
  }
  if (!Number.isInteger(jitterSeconds) || jitterSeconds < 0 || jitterSeconds >= ttlSeconds) {
    throw new GQueryV2Error(
      "CACHE_CONFIGURATION",
      "Cache jitter must be a non-negative integer smaller than the TTL.",
      { jitterSeconds, ttlSeconds },
    );
  }
  return { ttlSeconds, jitterSeconds };
}

/**
 * A CacheService-safe value cache. Chunks are immutable and the manifest is
 * published last, so incomplete publication and early eviction are cache misses.
 */
export class ChunkedCache {
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly namespace: string;
  private readonly maxChunkCharacters: number;
  private readonly lockTimeoutMs: number;

  public constructor(private readonly dependencies: ChunkedCacheDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.random = dependencies.random ?? mathRandomSource;
    this.namespace = dependencies.namespace ?? "gq2";
    this.maxChunkCharacters = dependencies.maxChunkCharacters ?? 90_000;
    this.lockTimeoutMs = dependencies.lockTimeoutMs ?? 1_000;
    if (!Number.isInteger(this.maxChunkCharacters) || this.maxChunkCharacters < 1 || this.maxChunkCharacters > 95_000) {
      throw new GQueryV2Error(
        "CACHE_CONFIGURATION",
        "Cache chunks must contain between 1 and 95000 characters.",
        { maxChunkCharacters: this.maxChunkCharacters },
      );
    }
  }

  public read<T>(logicalKey: unknown): CacheReadResult<T> {
    const baseKey = this.baseKey(logicalKey);
    const manifestKey = `${baseKey}:manifest`;
    let rawManifest: string | null;
    try {
      rawManifest = this.dependencies.store.get(manifestKey);
    } catch {
      return { state: "miss" };
    }
    if (rawManifest === null) return { state: "miss" };
    const manifest = parseManifest(rawManifest);
    if (manifest === null || manifest.codec !== this.dependencies.codec.name) {
      this.removePhysical(manifestKey, []);
      return { state: "corrupt" };
    }

    const chunkKeys = Array.from(
      { length: manifest.chunks },
      (_, index) => `${baseKey}:${manifest.generation}:${index}`,
    );
    let chunks: Record<string, string>;
    try {
      chunks = this.dependencies.store.getMany(chunkKeys);
    } catch {
      return { state: "miss" };
    }
    if (chunkKeys.some((key) => typeof chunks[key] !== "string")) {
      this.removePhysical(manifestKey, chunkKeys);
      return { state: "corrupt" };
    }
    const encoded = chunkKeys.map((key) => chunks[key]).join("");
    if (this.dependencies.hasher.hash(encoded) !== manifest.checksum) {
      this.removePhysical(manifestKey, chunkKeys);
      return { state: "corrupt" };
    }

    try {
      const decoded = this.dependencies.codec.decode(encoded);
      return { state: "hit", value: JSON.parse(decoded) as T };
    } catch {
      this.removePhysical(manifestKey, chunkKeys);
      return { state: "corrupt" };
    }
  }

  public get<T>(logicalKey: unknown): T | null {
    const result = this.read<T>(logicalKey);
    return result.state === "hit" ? (result.value as T) : null;
  }

  public put<T>(logicalKey: unknown, value: T, policy: ChunkedCachePolicy = {}): void {
    const validated = validateTtl(policy);
    const random = Math.max(0, Math.min(0.999999999999, this.random.next()));
    const jitter = Math.floor(random * (validated.jitterSeconds + 1));
    const effectiveTtl = Math.max(1, validated.ttlSeconds - jitter);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("The cache value is not JSON serializable.");
    }
    const encoded = this.dependencies.codec.encode(serialized);
    const chunks = this.split(encoded);
    const baseKey = this.baseKey(logicalKey);
    const manifestKey = `${baseKey}:manifest`;
    const oldManifest = parseManifest(this.dependencies.store.get(manifestKey));
    const generation = this.dependencies.ids.next();
    const chunkValues: Record<string, string> = {};
    const chunkKeys: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const key = `${baseKey}:${generation}:${index}`;
      chunkKeys.push(key);
      chunkValues[key] = chunks[index];
    }
    const manifest: ChunkManifest = {
      version: 1,
      codec: this.dependencies.codec.name,
      generation,
      chunks: chunks.length,
      checksum: this.dependencies.hasher.hash(encoded),
      createdAtMs: this.clock.now(),
    };

    try {
      this.dependencies.store.putMany(chunkValues, effectiveTtl);
      // Publication point. Readers cannot observe the new generation before this write.
      this.dependencies.store.put(manifestKey, JSON.stringify(manifest), effectiveTtl);
    } catch (error) {
      try {
        this.dependencies.store.removeMany(chunkKeys);
      } catch {
        // The old manifest is still authoritative; orphaned chunks expire naturally.
      }
      throw error;
    }

    if (oldManifest !== null && oldManifest.generation !== generation) {
      try {
        this.dependencies.store.removeMany(
          Array.from(
            { length: oldManifest.chunks },
            (_, index) => `${baseKey}:${oldManifest.generation}:${index}`,
          ),
        );
      } catch {
        // The old immutable chunks are unreachable and will expire.
      }
    }
  }

  public remove(logicalKey: unknown): void {
    const baseKey = this.baseKey(logicalKey);
    const manifestKey = `${baseKey}:manifest`;
    const manifest = parseManifest(this.dependencies.store.get(manifestKey));
    const chunkKeys = manifest === null
      ? []
      : Array.from(
          { length: manifest.chunks },
          (_, index) => `${baseKey}:${manifest.generation}:${index}`,
        );
    this.removePhysical(manifestKey, chunkKeys);
  }

  public readThrough<T>(
    logicalKey: unknown,
    producer: () => T,
    policy: ChunkedCachePolicy = {},
  ): ReadThroughResult<T> {
    const first = this.read<T>(logicalKey);
    if (first.state === "hit") return { value: first.value as T, cache: "hit" };

    const lock = this.dependencies.lock;
    let acquired = false;
    if (lock !== undefined) {
      try {
        acquired = lock.tryAcquire(this.lockTimeoutMs);
      } catch {
        acquired = false;
      }
    }
    if (lock === undefined || !acquired) {
      const value = producer();
      if (lock === undefined && this.tryPut(logicalKey, value, policy)) {
        return { value, cache: "filled" };
      }
      return { value, cache: "uncached" };
    }

    try {
      const second = this.read<T>(logicalKey);
      if (second.state === "hit") return { value: second.value as T, cache: "hit-after-wait" };
      const value = producer();
      return {
        value,
        cache: this.tryPut(logicalKey, value, policy) ? "filled" : "uncached",
      };
    } finally {
      try {
        lock.release();
      } catch {
        // Single-flight locks are an optimization; the cache value was already published.
      }
    }
  }

  private baseKey(logicalKey: unknown): string {
    return `${this.namespace}:cache:${hashCanonical(logicalKey, this.dependencies.hasher)}`;
  }

  private split(value: string): string[] {
    if (value.length === 0) return [""];
    const result: string[] = [];
    for (let offset = 0; offset < value.length; offset += this.maxChunkCharacters) {
      result.push(value.slice(offset, offset + this.maxChunkCharacters));
    }
    return result;
  }

  private removePhysical(manifestKey: string, chunkKeys: readonly string[]): void {
    try {
      this.dependencies.store.remove(manifestKey);
      this.dependencies.store.removeMany(chunkKeys);
    } catch {
      // Cache invalidation is best effort and must not fail the caller.
    }
  }

  private tryPut<T>(logicalKey: unknown, value: T, policy: ChunkedCachePolicy): boolean {
    try {
      this.put(logicalKey, value, policy);
      return true;
    } catch {
      return false;
    }
  }
}

export type CacheDependency =
  | { readonly kind: "table"; readonly sourceId: string; readonly table: string }
  | { readonly kind: "row"; readonly sourceId: string; readonly table: string; readonly key: unknown }
  | { readonly kind: "tag"; readonly tag: string };

export interface DependencyGeneration {
  readonly dependency: CacheDependency;
  readonly token: string;
}

/** Durable generation tokens make old cache entries unreachable without a key registry. */
export class GenerationTokenStore {
  public constructor(
    private readonly properties: PropertyStore,
    private readonly hasher: HashFunction,
    private readonly ids: IdGenerator,
    private readonly namespace = "gq2",
  ) {}

  public current(dependency: CacheDependency): string {
    return this.properties.get(this.key(dependency)) ?? "0";
  }

  public snapshot(dependencies: readonly CacheDependency[]): DependencyGeneration[] {
    return dependencies
      .map((dependency) => ({ dependency, token: this.current(dependency) }))
      .sort((left, right) => canonicalStringify(left.dependency).localeCompare(canonicalStringify(right.dependency)));
  }

  public rotate(dependency: CacheDependency): string {
    const token = this.ids.next();
    this.properties.set(this.key(dependency), token);
    return token;
  }

  public invalidateTable(sourceId: string, table: string): string {
    return this.rotate({ kind: "table", sourceId, table });
  }

  public invalidateRow(sourceId: string, table: string, key: unknown): string {
    return this.rotate({ kind: "row", sourceId, table, key });
  }

  public invalidateTag(tag: string): string {
    return this.rotate({ kind: "tag", tag });
  }

  /** Rotate the table dependency plus optional narrow row/tag dependencies after a committed write. */
  public invalidateWrite(
    sourceId: string,
    table: string,
    rowKeys: readonly unknown[] = [],
    tags: readonly string[] = [],
  ): DependencyGeneration[] {
    const dependencies: CacheDependency[] = [{ kind: "table", sourceId, table }];
    dependencies.push(...rowKeys.map((key): CacheDependency => ({ kind: "row", sourceId, table, key })));
    dependencies.push(...tags.map((tag): CacheDependency => ({ kind: "tag", tag })));
    return dependencies.map((dependency) => ({ dependency, token: this.rotate(dependency) }));
  }

  private key(dependency: CacheDependency): string {
    return `${this.namespace}:generation:${hashCanonical(dependency, this.hasher)}`;
  }
}

export interface QueryCacheKeyInput {
  readonly sourceIdentity: unknown;
  readonly schemaVersion: number | string;
  readonly headerVersion: string;
  readonly query: unknown;
  readonly projection?: readonly string[];
  readonly renderOptions?: unknown;
  readonly scopeIdentity?: unknown;
  readonly generations: readonly DependencyGeneration[];
}

export function buildQueryCacheKey(input: QueryCacheKeyInput): Readonly<Record<string, unknown>> {
  return {
    kind: "query",
    sourceIdentity: input.sourceIdentity,
    schemaVersion: input.schemaVersion,
    headerVersion: input.headerVersion,
    query: input.query,
    projection: input.projection ?? [],
    renderOptions: input.renderOptions ?? null,
    scopeIdentity: input.scopeIdentity ?? null,
    generations: input.generations,
  };
}

export type AppsScriptCacheScope = "script" | "document" | "user";

function appsScriptCache(scope: AppsScriptCacheScope): GoogleAppsScript.Cache.Cache {
  if (scope === "script") return CacheService.getScriptCache();
  if (scope === "user") return CacheService.getUserCache();
  const cache = CacheService.getDocumentCache();
  if (cache === null) {
    throw new GQueryV2Error(
      "CACHE_CONFIGURATION",
      "Document cache is unavailable outside a container-bound Apps Script project.",
    );
  }
  return cache;
}

export interface AppsScriptChunkedCacheOptions {
  readonly scope?: AppsScriptCacheScope;
  readonly lock?: SyncLock;
  readonly namespace?: string;
}

export function createAppsScriptChunkedCache(options: AppsScriptChunkedCacheOptions = {}): ChunkedCache {
  const scope = options.scope ?? "script";
  const defaultLock = scope === "script"
    ? LockService.getScriptLock()
    : scope === "user"
      ? LockService.getUserLock()
      : LockService.getDocumentLock();
  return new ChunkedCache({
    store: new AppsScriptCacheStore(appsScriptCache(scope)),
    codec: new AppsScriptGzipBase64Codec(),
    hasher: new AppsScriptSha256Hash(),
    ids: { next: () => Utilities.getUuid() },
    lock: options.lock ?? new AppsScriptLock(defaultLock),
    namespace: options.namespace,
  });
}

export function createAppsScriptGenerationStore(namespace?: string): GenerationTokenStore {
  return new GenerationTokenStore(
    new AppsScriptPropertyStore(PropertiesService.getScriptProperties()),
    new AppsScriptSha256Hash(),
    { next: () => Utilities.getUuid() },
    namespace,
  );
}
