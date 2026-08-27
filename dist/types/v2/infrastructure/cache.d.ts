import { HashFunction } from "./canonical";
import { CacheStore, Clock, IdGenerator, PropertyStore, RandomSource, SyncLock } from "./runtime";
export interface CacheTextCodec {
    readonly name: string;
    encode(value: string): string;
    decode(value: string): string;
}
export declare class AppsScriptGzipBase64Codec implements CacheTextCodec {
    readonly name = "gzip-base64-v1";
    encode(value: string): string;
    decode(value: string): string;
}
export declare class PlainTextCacheCodec implements CacheTextCodec {
    readonly name = "plain-text-v1";
    encode(value: string): string;
    decode(value: string): string;
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
/**
 * A CacheService-safe value cache. Chunks are immutable and the manifest is
 * published last, so incomplete publication and early eviction are cache misses.
 */
export declare class ChunkedCache {
    private readonly dependencies;
    private readonly clock;
    private readonly random;
    private readonly namespace;
    private readonly maxChunkCharacters;
    private readonly lockTimeoutMs;
    constructor(dependencies: ChunkedCacheDependencies);
    read<T>(logicalKey: unknown): CacheReadResult<T>;
    get<T>(logicalKey: unknown): T | null;
    put<T>(logicalKey: unknown, value: T, policy?: ChunkedCachePolicy): void;
    remove(logicalKey: unknown): void;
    readThrough<T>(logicalKey: unknown, producer: () => T, policy?: ChunkedCachePolicy): ReadThroughResult<T>;
    private baseKey;
    private split;
    private removePhysical;
    private tryPut;
}
export type CacheDependency = {
    readonly kind: "table";
    readonly sourceId: string;
    readonly table: string;
} | {
    readonly kind: "row";
    readonly sourceId: string;
    readonly table: string;
    readonly key: unknown;
} | {
    readonly kind: "tag";
    readonly tag: string;
};
export interface DependencyGeneration {
    readonly dependency: CacheDependency;
    readonly token: string;
}
/** Durable generation tokens make old cache entries unreachable without a key registry. */
export declare class GenerationTokenStore {
    private readonly properties;
    private readonly hasher;
    private readonly ids;
    private readonly namespace;
    constructor(properties: PropertyStore, hasher: HashFunction, ids: IdGenerator, namespace?: string);
    current(dependency: CacheDependency): string;
    snapshot(dependencies: readonly CacheDependency[]): DependencyGeneration[];
    rotate(dependency: CacheDependency): string;
    invalidateTable(sourceId: string, table: string): string;
    invalidateRow(sourceId: string, table: string, key: unknown): string;
    invalidateTag(tag: string): string;
    /** Rotate the table dependency plus optional narrow row/tag dependencies after a committed write. */
    invalidateWrite(sourceId: string, table: string, rowKeys?: readonly unknown[], tags?: readonly string[]): DependencyGeneration[];
    private key;
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
export declare function buildQueryCacheKey(input: QueryCacheKeyInput): Readonly<Record<string, unknown>>;
export type AppsScriptCacheScope = "script" | "document" | "user";
export interface AppsScriptChunkedCacheOptions {
    readonly scope?: AppsScriptCacheScope;
    readonly lock?: SyncLock;
    readonly namespace?: string;
}
export declare function createAppsScriptChunkedCache(options?: AppsScriptChunkedCacheOptions): ChunkedCache;
export declare function createAppsScriptGenerationStore(namespace?: string): GenerationTokenStore;
