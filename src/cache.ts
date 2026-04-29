import { GQueryCacheOptions, GQueryCacheScope, GQueryRow } from "./types";

const CACHE_PREFIX = "gquery:v2";
const DEFAULT_HEADER_TTL = 3600;
const DEFAULT_DATA_TTL = 600;
const DEFAULT_QUERY_TTL = 300;
const DEFAULT_CHUNK_SIZE = 50;
const DEFAULT_COMPRESS_THRESHOLD = 50_000;
const HARD_VALUE_LIMIT = 100_000;

const RAW_PREFIX = "r:";
const GZIP_PREFIX = "g:";

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
export class GQueryCache {
  readonly enabled: boolean;
  private readonly idShort: string;
  private readonly scope: GQueryCacheScope;
  private readonly headerTtl: number;
  private readonly dataTtl: number;
  private readonly queryTtl: number;
  private readonly chunkSize: number;
  private readonly compressThreshold: number;
  private readonly namespace: string;
  private oversizeWarned = false;

  constructor(spreadsheetId: string, opts: GQueryCacheOptions = {}) {
    this.idShort = spreadsheetId.slice(0, 8);
    if (opts === false) {
      this.enabled = false;
      this.scope = "document";
      this.headerTtl = DEFAULT_HEADER_TTL;
      this.dataTtl = DEFAULT_DATA_TTL;
      this.queryTtl = DEFAULT_QUERY_TTL;
      this.chunkSize = DEFAULT_CHUNK_SIZE;
      this.compressThreshold = DEFAULT_COMPRESS_THRESHOLD;
      this.namespace = "";
      return;
    }
    this.enabled = true;
    this.scope = opts.scope ?? "document";
    this.headerTtl = opts.ttl?.headers ?? DEFAULT_HEADER_TTL;
    this.dataTtl = opts.ttl?.data ?? DEFAULT_DATA_TTL;
    this.queryTtl = opts.ttl?.query ?? DEFAULT_QUERY_TTL;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.compressThreshold = opts.compressThreshold ?? DEFAULT_COMPRESS_THRESHOLD;
    this.namespace = opts.namespace ? `:${opts.namespace}` : "";
  }

  /**
   * Look up a cached read by sheet + key opts. Returns null on miss
   * (including partial-hit on chunks, which is treated as a miss).
   */
  get(
    sheetName: string,
    opts: CacheKeyOpts,
  ): { headers: string[]; rows: GQueryRow[] } | null {
    if (!this.enabled) return null;
    const cache = this.cache();
    if (!cache) return null;

    const base = this.baseKey(sheetName, opts);
    const meta = this.readJson(cache.get(`${base}:meta`));
    if (!meta || typeof meta.chunkCount !== "number") return null;

    const headersRaw = cache.get(`${base}:headers`);
    if (!headersRaw) return null;
    const headers = this.readJson(headersRaw);
    if (!Array.isArray(headers)) return null;

    if (meta.chunkCount === 0) {
      return { headers, rows: [] };
    }

    const keys: string[] = [];
    for (let i = 0; i < meta.chunkCount; i++) {
      keys.push(`${base}:chunk:${i}`);
    }
    const all = cache.getAll(keys);
    if (Object.keys(all).length !== keys.length) return null;

    const rows: GQueryRow[] = [];
    for (let i = 0; i < meta.chunkCount; i++) {
      const chunk = this.readJson(all[`${base}:chunk:${i}`]);
      if (!Array.isArray(chunk)) return null;
      for (const row of chunk) rows.push(row as GQueryRow);
    }
    return { headers, rows };
  }

  /**
   * Store a read result. Splits rows into chunks of `chunkSize`, gzips
   * any chunk over the compression threshold, and falls back to a no-op
   * (with one warning) when a chunk still exceeds the 100KB CacheService
   * value cap.
   */
  put(
    sheetName: string,
    value: { headers: string[]; rows: GQueryRow[] },
    opts: CacheKeyOpts,
  ): void {
    if (!this.enabled) return;
    const cache = this.cache();
    if (!cache) return;

    const base = this.baseKey(sheetName, opts);
    const chunks = this.splitChunks(value.rows);

    const headersEncoded = this.encode(JSON.stringify(value.headers));
    if (headersEncoded === null) {
      this.warnOversize(`${base}:headers`);
      return;
    }

    const writes: Record<string, string> = {
      [`${base}:headers`]: headersEncoded,
      [`${base}:meta`]: `${RAW_PREFIX}${JSON.stringify({
        chunkCount: chunks.length,
        totalRows: value.rows.length,
      })}`,
    };

    for (let i = 0; i < chunks.length; i++) {
      const encoded = this.encode(JSON.stringify(chunks[i]));
      if (encoded === null) {
        this.warnOversize(`${base}:chunk:${i}`);
        return;
      }
      writes[`${base}:chunk:${i}`] = encoded;
    }

    cache.putAll(writes, this.dataTtl);
    cache.put(`${base}:headers`, headersEncoded, this.headerTtl);
    this.recordManifest(cache, sheetName, base);
  }

  /**
   * Look up a cached query() result.
   */
  getQuery(
    sheetName: string,
    query: string,
  ): { headers: string[]; rows: GQueryRow[] } | null {
    if (!this.enabled) return null;
    const cache = this.cache();
    if (!cache) return null;

    const base = this.queryBaseKey(sheetName, query);
    const raw = cache.get(`${base}:body`);
    if (!raw) return null;
    const decoded = this.decode(raw);
    if (decoded === null) return null;
    const parsed = this.readJson(decoded, /*alreadyDecoded*/ true);
    if (
      !parsed ||
      !Array.isArray(parsed.headers) ||
      !Array.isArray(parsed.rows)
    ) {
      return null;
    }
    return parsed;
  }

  putQuery(
    sheetName: string,
    query: string,
    value: { headers: string[]; rows: GQueryRow[] },
  ): void {
    if (!this.enabled) return;
    const cache = this.cache();
    if (!cache) return;

    const base = this.queryBaseKey(sheetName, query);
    const encoded = this.encode(JSON.stringify(value));
    if (encoded === null) {
      this.warnOversize(`${base}:body`);
      return;
    }
    cache.put(`${base}:body`, encoded, this.queryTtl);
    this.recordManifest(cache, sheetName, base);
  }

  /**
   * Remove every cache entry tracked for `sheetName`. Reads the manifest,
   * deletes each base key's variants (headers + meta + chunks + query bodies),
   * then clears the manifest.
   */
  invalidate(sheetName: string): void {
    if (!this.enabled) return;
    const cache = this.cache();
    if (!cache) return;

    const manifestKey = this.manifestKey(sheetName);
    const manifest = cache.get(manifestKey);
    if (!manifest) return;

    let bases: string[] = [];
    try {
      bases = JSON.parse(manifest);
    } catch {
      bases = [];
    }
    if (!Array.isArray(bases) || bases.length === 0) {
      cache.remove(manifestKey);
      return;
    }

    const toRemove: string[] = [manifestKey];
    for (const base of bases) {
      // Read meta to learn how many chunks exist; skip silently on parse errors.
      const metaRaw = cache.get(`${base}:meta`);
      let chunkCount = 0;
      if (metaRaw) {
        const meta = this.readJson(metaRaw);
        if (meta && typeof meta.chunkCount === "number") {
          chunkCount = meta.chunkCount;
        }
      }
      toRemove.push(`${base}:headers`, `${base}:meta`, `${base}:body`);
      for (let i = 0; i < chunkCount; i++) {
        toRemove.push(`${base}:chunk:${i}`);
      }
    }
    cache.removeAll(toRemove);
  }

  // ---------- internal helpers ----------

  private cache(): GoogleAppsScript.Cache.Cache | null {
    if (typeof CacheService === "undefined") return null;
    switch (this.scope) {
      case "script":
        return CacheService.getScriptCache();
      case "user":
        return CacheService.getUserCache();
      case "document":
      default:
        return (
          CacheService.getDocumentCache() ?? CacheService.getScriptCache()
        );
    }
  }

  private baseKey(sheetName: string, opts: CacheKeyOpts): string {
    const range = opts.range ?? "all";
    const vr = opts.valueRender ?? "FV";
    const dr = opts.dateRender ?? "FS";
    return `${CACHE_PREFIX}${this.namespace}:${this.idShort}:${sheetName}:${range}:${vr}:${dr}`;
  }

  private queryBaseKey(sheetName: string, query: string): string {
    // Query keys can be long; hash via a stable digest so we stay under 250 chars.
    const digest = this.shortHash(query);
    return `${CACHE_PREFIX}${this.namespace}:${this.idShort}:${sheetName}:q:${digest}`;
  }

  private manifestKey(sheetName: string): string {
    return `${CACHE_PREFIX}${this.namespace}:${this.idShort}:${sheetName}:__manifest`;
  }

  private recordManifest(
    cache: GoogleAppsScript.Cache.Cache,
    sheetName: string,
    base: string,
  ): void {
    const manifestKey = this.manifestKey(sheetName);
    const existing = cache.get(manifestKey);
    let bases: string[] = [];
    if (existing) {
      try {
        const parsed = JSON.parse(existing);
        if (Array.isArray(parsed)) bases = parsed;
      } catch {
        // corrupt manifest — overwrite
      }
    }
    if (!bases.includes(base)) {
      bases.push(base);
      cache.put(manifestKey, JSON.stringify(bases), this.headerTtl);
    }
  }

  private splitChunks(rows: GQueryRow[]): GQueryRow[][] {
    if (rows.length === 0) return [];
    const out: GQueryRow[][] = [];
    for (let i = 0; i < rows.length; i += this.chunkSize) {
      out.push(rows.slice(i, i + this.chunkSize));
    }
    return out;
  }

  /**
   * Encode a JSON string for storage. Compresses (gzip + base64) when the
   * input exceeds `compressThreshold`. Returns null if the encoded result
   * would exceed the per-value cache cap.
   */
  private encode(json: string): string | null {
    if (json.length < this.compressThreshold) {
      const out = `${RAW_PREFIX}${json}`;
      if (out.length > HARD_VALUE_LIMIT) {
        return this.compress(json);
      }
      return out;
    }
    return this.compress(json);
  }

  private compress(json: string): string | null {
    if (typeof Utilities === "undefined") {
      const out = `${RAW_PREFIX}${json}`;
      return out.length > HARD_VALUE_LIMIT ? null : out;
    }
    try {
      const blob = Utilities.gzip(Utilities.newBlob(json));
      const b64 = Utilities.base64Encode(blob.getBytes());
      const out = `${GZIP_PREFIX}${b64}`;
      return out.length > HARD_VALUE_LIMIT ? null : out;
    } catch {
      const out = `${RAW_PREFIX}${json}`;
      return out.length > HARD_VALUE_LIMIT ? null : out;
    }
  }

  private decode(value: string): string | null {
    if (value.startsWith(RAW_PREFIX)) return value.slice(RAW_PREFIX.length);
    if (value.startsWith(GZIP_PREFIX)) {
      if (typeof Utilities === "undefined") return null;
      try {
        const bytes = Utilities.base64Decode(value.slice(GZIP_PREFIX.length));
        const unzipped = Utilities.ungzip(Utilities.newBlob(bytes));
        return unzipped.getDataAsString();
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Read a stored value as JSON. When `alreadyDecoded` is false the input
   * is expected to carry the `r:` / `g:` prefix from `encode()`; otherwise
   * it is parsed directly.
   */
  private readJson(value: string | null, alreadyDecoded = false): any {
    if (value === null || value === undefined) return null;
    const json = alreadyDecoded ? value : this.decode(value);
    if (json === null) return null;
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  private warnOversize(key: string): void {
    if (this.oversizeWarned) return;
    this.oversizeWarned = true;
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(
        `[gquery] cache value for "${key}" exceeds the 100KB CacheService limit even after compression; falling back to no-cache for this read.`,
      );
    }
  }

  /**
   * 32-bit FNV-1a hash, base36-encoded. Stable across runtimes; fine as a
   * cache-key disambiguator (collisions just mean a cache miss).
   */
  private shortHash(input: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }
}
