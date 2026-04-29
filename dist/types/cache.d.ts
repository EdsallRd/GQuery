import { GQueryCacheOptions, GQueryRow } from "./types";
/**
 * Identifying options for a cache key. Two reads with different
 * render options or ranges live under separate cache entries.
 */
export interface CacheKeyOpts {
    range?: string;
    valueRender?: string;
    dateRender?: string;
}
/**
 * Wrapper around Apps Script's CacheService that handles:
 * - chunked storage for payloads above the 100KB per-value limit
 * - gzip compression for large chunks
 * - per-sheet manifests so invalidation can clear every variant key
 *
 * Default-on (constructed alongside every GQuery instance unless explicitly
 * disabled). All methods are no-ops when `enabled` is false, so call sites
 * don't need to branch on whether caching is configured.
 */
export declare class GQueryCache {
    readonly enabled: boolean;
    private readonly idShort;
    private readonly scope;
    private readonly headerTtl;
    private readonly dataTtl;
    private readonly queryTtl;
    private readonly chunkSize;
    private readonly compressThreshold;
    private readonly namespace;
    private oversizeWarned;
    constructor(spreadsheetId: string, opts?: GQueryCacheOptions);
    /**
     * Look up a cached read by sheet + key opts. Returns null on miss
     * (including partial-hit on chunks, which is treated as a miss).
     */
    get(sheetName: string, opts: CacheKeyOpts): {
        headers: string[];
        rows: GQueryRow[];
    } | null;
    /**
     * Store a read result. Splits rows into chunks of `chunkSize`, gzips
     * any chunk over the compression threshold, and falls back to a no-op
     * (with one warning) when a chunk still exceeds the 100KB CacheService
     * value cap.
     */
    put(sheetName: string, value: {
        headers: string[];
        rows: GQueryRow[];
    }, opts: CacheKeyOpts): void;
    /**
     * Look up a cached query() result.
     */
    getQuery(sheetName: string, query: string): {
        headers: string[];
        rows: GQueryRow[];
    } | null;
    putQuery(sheetName: string, query: string, value: {
        headers: string[];
        rows: GQueryRow[];
    }): void;
    /**
     * Remove every cache entry tracked for `sheetName`. Reads the manifest,
     * deletes each base key's variants (headers + meta + chunks + query bodies),
     * then clears the manifest.
     */
    invalidate(sheetName: string): void;
    private cache;
    private baseKey;
    private queryBaseKey;
    private manifestKey;
    private recordManifest;
    private splitChunks;
    /**
     * Encode a JSON string for storage. Compresses (gzip + base64) when the
     * input exceeds `compressThreshold`. Returns null if the encoded result
     * would exceed the per-value cache cap.
     */
    private encode;
    private compress;
    private decode;
    /**
     * Read a stored value as JSON. When `alreadyDecoded` is false the input
     * is expected to carry the `r:` / `g:` prefix from `encode()`; otherwise
     * it is parsed directly.
     */
    private readJson;
    private warnOversize;
    /**
     * 32-bit FNV-1a hash, base36-encoded. Stable across runtimes; fine as a
     * cache-key disambiguator (collisions just mean a cache miss).
     */
    private shortHash;
}
