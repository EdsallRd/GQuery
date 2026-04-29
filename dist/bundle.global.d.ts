declare namespace GQuery {
  /**
   * Standard Schema V1 interface
   * @see https://standardschema.dev
   *
   * Copied verbatim from the spec — no runtime dependency.
   * Any schema library that implements this interface (Zod, Valibot, ArkType, etc.)
   * can be passed directly to GQuery.from() for type inference and optional validation.
   */
  interface StandardSchemaV1<Input = unknown, Output = unknown> {
      readonly "~standard": {
          readonly version: 1;
          readonly vendor: string;
          readonly validate: (value: unknown) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>;
          readonly types?: StandardSchemaV1.Types<Input, Output> | undefined;
      };
  }
  declare namespace StandardSchemaV1 {
      type Result<Output> = SuccessResult<Output> | FailureResult;
      interface SuccessResult<Output> {
          readonly value: Output;
          readonly issues?: undefined;
      }
      interface FailureResult {
          readonly issues: ReadonlyArray<Issue>;
      }
      interface Issue {
          readonly message: string;
          readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
      }
      interface PathSegment {
          readonly key: PropertyKey;
      }
      interface Types<Input, Output> {
          readonly input: Input;
          readonly output: Output;
      }
  }
  /**
   * Infer the output type from a StandardSchemaV1-compatible schema.
   * Falls back to Record<string, unknown> if S is not a Standard Schema.
   *
   * @example
   * const schema = z.object({ name: z.string() });
   * type Row = InferSchema<typeof schema>; // { name: string }
   */
  type InferSchema<S> = S extends StandardSchemaV1<any, infer O> ? O : Record<string, unknown>;
  /**
   * CacheService scope. Document scope is the right grain for an ORM that
   * always operates against one spreadsheet — keeps separate caches per file.
   */
  type GQueryCacheScope = "document" | "script" | "user";
  /**
   * Cache configuration. Pass `false` to disable caching entirely on an
   * instance or a single call.
   */
  type GQueryCacheOptions = false | {
      /** Which CacheService scope to use. Defaults to "document". */
      scope?: GQueryCacheScope;
      /** TTL overrides (seconds). Headers default to 3600, data to 600, query to 300. */
      ttl?: {
          headers?: number;
          data?: number;
          query?: number;
      };
      /** Rows per chunk before splitting across cache keys. Default 50. */
      chunkSize?: number;
      /** Bytes above which a chunk is gzipped before storage. Default 50_000. */
      compressThreshold?: number;
      /** Optional namespace suffix to isolate caches across deployments. */
      namespace?: string;
  };
  /**
   * Options for reading data from Google Sheets
   */
  type GQueryReadOptions = {
      /** How values should be rendered in the output */
      valueRenderOption?: ValueRenderOption;
      /** How dates and times should be rendered in the output */
      dateTimeRenderOption?: DateTimeRenderOption;
      /**
       * When true, each row is parsed through the table's schema (if set).
       * Throws a GQuerySchemaError if validation fails.
       * Defaults to false (schema is used for type inference only).
       */
      validate?: boolean;
      /**
       * Per-call cache override. Set to `false` to bypass the cache (and skip
       * writing the result back) for this read.
       */
      cache?: GQueryCacheOptions;
  };
  /**
   * Result structure returned by GQuery operations
   */
  type GQueryResult<T = Record<string, any>> = {
      /** Array of row objects typed to T */
      rows: GQueryRow<T>[];
      /** Column headers from the sheet */
      headers: string[];
  };
  /**
   * A single row with metadata about its position in the sheet.
   * T is the shape of the data columns; __meta is always present alongside them.
   */
  type GQueryRow<T = Record<string, any>> = T & {
      __meta: {
          /** 1-based row number in the sheet (row 1 is headers). -1 when unknown. */
          rowNum: number;
          /** Number of columns in the row */
          colLength: number;
      };
  };
  /**
   * How values should be rendered in the output
   * @see https://developers.google.com/sheets/api/reference/rest/v4/ValueRenderOption
   */
  declare enum ValueRenderOption {
      /** Values will be calculated and formatted according to cell formatting */
      FORMATTED_VALUE = "FORMATTED_VALUE",
      /** Values will be calculated but not formatted */
      UNFORMATTED_VALUE = "UNFORMATTED_VALUE",
      /** Values will not be calculated; formulas will be returned as-is */
      FORMULA = "FORMULA"
  }
  /**
   * How dates and times should be rendered in the output
   * @see https://developers.google.com/sheets/api/reference/rest/v4/DateTimeRenderOption
   */
  declare enum DateTimeRenderOption {
      /** Dates and times will be rendered as strings according to cell formatting */
      FORMATTED_STRING = "FORMATTED_STRING",
      /** Dates and times will be rendered as serial numbers */
      SERIAL_NUMBER = "SERIAL_NUMBER"
  }
  /**
   * Comparison operators supported by the typed query builder.
   * These map directly to Google Visualization API (gviz/tq) operators.
   */
  type GQueryComparisonOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "contains" | "starts with" | "ends with" | "matches";
  /**
   * Typed predicate that compiles to a server-side gviz/tq filter.
   * Use `.whereExpr()` instead of `.where()` to push the filter to Google's
   * servers (returns only matching rows over the wire).
   */
  type GQueryWhereExpr = {
      col: string;
      op: GQueryComparisonOp;
      value: string | number | boolean | null | Date;
  } | {
      and: GQueryWhereExpr[];
  } | {
      or: GQueryWhereExpr[];
  } | {
      not: GQueryWhereExpr;
  };
  /**
   * Thrown when a row fails schema validation.
   */
  declare class GQuerySchemaError extends Error {
      readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;
      readonly row: Record<string, any>;
      constructor(issues: ReadonlyArray<StandardSchemaV1.Issue>, row: Record<string, any>);
  }
  /**
   * Thrown when a Google API call fails in a non-retryable way (or after
   * retries are exhausted). Carries the operation name, status code, and
   * response body for debugging.
   */
  declare class GQueryApiError extends Error {
      readonly operation: string;
      readonly status: number | null;
      readonly body: string;
      readonly cause?: unknown | undefined;
      constructor(operation: string, status: number | null, body: string, cause?: unknown | undefined);
  }
  
  /**
   * Identifying options for a cache key. Two reads with different
   * render options or ranges live under separate cache entries.
   */
  interface CacheKeyOpts {
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
  declare class GQueryCache {
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
  
  /**
   * Optional configuration for a GQuery instance.
   */
  interface GQueryOptions {
      /**
       * CacheService configuration. Defaults to document-scoped caching with
       * 1h header TTL and 10m data TTL. Pass `false` to disable caching for
       * every read/write on this instance.
       */
      cache?: GQueryCacheOptions;
      /**
       * Default read options applied to every `.get()` / `.getMany()` call
       * unless overridden per-call.
       */
      defaultReadOptions?: GQueryReadOptions;
  }
  /**
   * Main GQuery class for interacting with Google Sheets.
   *
   * Caches the Spreadsheet handle and per-sheet handles internally so that
   * repeated `from()` calls on the same instance avoid the per-call cost of
   * `SpreadsheetApp.openById` / `getSheetByName`.
   */
  declare class GQuery {
      spreadsheetId: string;
      cache: GQueryCache;
      defaultReadOptions: GQueryReadOptions;
      private spreadsheetHandle?;
      private sheetHandles;
      /**
       * Create a new GQuery instance.
       * @param spreadsheetId Optional spreadsheet ID. If not provided, uses the active spreadsheet.
       * @param options Optional configuration (caching, default read options).
       */
      constructor(spreadsheetId?: string, options?: GQueryOptions);
      /** Lazily resolve and memoize the Spreadsheet handle. */
      getSpreadsheet(): GoogleAppsScript.Spreadsheet.Spreadsheet;
      /** Lazily resolve and memoize a Sheet handle by name. */
      getSheet(sheetName: string): GoogleAppsScript.Spreadsheet.Sheet;
      /**
       * Get a typed table reference for a specific sheet using a Standard Schema.
       * The schema's output type flows through all subsequent operations.
       * Pass `validate: true` to `get()` / `update()` / `append()` to enable runtime validation.
       *
       * @example
       * const schema = z.object({ Name: z.string(), Age: z.number() });
       * const result = gq.from("People", schema).get(); // GQueryResult<{ Name: string; Age: number }>
       */
      from<S extends StandardSchemaV1>(sheetName: string, schema: S): GQueryTable<InferSchema<S> & Record<string, any>>;
      /**
       * Get a table reference for a specific sheet with an explicit type parameter.
       * No runtime validation — the type parameter is a compile-time assertion only.
       */
      from<T extends Record<string, any> = Record<string, any>>(sheetName: string): GQueryTable<T>;
      /**
       * Efficiently fetch data from multiple sheets at once.
       * For typed results per-sheet, use `from()` individually.
       */
      getMany(sheetNames: string[], options?: GQueryReadOptions): {
          [sheetName: string]: GQueryResult;
      };
      /**
       * Drop every cached entry for a specific sheet (or for the entire
       * spreadsheet, when no sheet name is given).
       */
      invalidateCache(sheetName?: string): void;
  }
  /**
   * Represents a single sheet table for query operations.
   * @typeParam T - The shape of each data row. Inferred from a Standard Schema if provided.
   */
  declare class GQueryTable<T extends Record<string, any> = Record<string, any>> {
      GQuery: GQuery;
      spreadsheetId: string;
      sheetName: string;
      /** The Standard Schema used for type inference and optional runtime validation */
      schema?: StandardSchemaV1<unknown, T>;
      constructor(GQuery: GQuery, spreadsheetId: string, sheetName: string, schema?: StandardSchemaV1<unknown, T>);
      /** Lazily-resolved Spreadsheet handle (memoized on the GQuery instance). */
      get spreadsheet(): GoogleAppsScript.Spreadsheet.Spreadsheet;
      /** Lazily-resolved Sheet handle (memoized on the GQuery instance). */
      get sheet(): GoogleAppsScript.Spreadsheet.Sheet;
      /**
       * Select specific columns to return.
       *
       * Joined columns are excluded by default — chain `.includeJoinColumns()`
       * to keep them all when you don't want to enumerate each one.
       */
      select(headers: string[]): GQueryTableFactory<T>;
      /**
       * Filter rows with an arbitrary predicate. Runs in-memory after the
       * fetch — for server-side filtering, use `.whereExpr()` instead.
       */
      where(filterFn: (row: GQueryRow<T>) => boolean): GQueryTableFactory<T>;
      /**
       * Server-side filter via Google Visualization API (gviz/tq). Only matching
       * rows come over the wire. Cannot be combined with joins.
       */
      whereExpr(expr: GQueryWhereExpr): GQueryTableFactory<T>;
      /**
       * Limit the number of rows returned. When combined with `.offset()` and
       * no joins/in-memory filters, the underlying fetch only requests the
       * requested band.
       */
      limit(n: number): GQueryTableFactory<T>;
      /** Skip the first N rows. */
      offset(n: number): GQueryTableFactory<T>;
      /**
       * Join with another sheet.
       * Note: joined columns are typed as additional `any` fields alongside T.
       */
      join(sheetName: string, sheetColumn: string, joinColumn: string, columnsToReturn?: string[]): GQueryTableFactory<T>;
      /**
       * Update rows in the sheet. Cache (if enabled) is invalidated on success.
       */
      update(updateFn: (row: GQueryRow<T>) => Partial<T>): GQueryResult<T>;
      /**
       * Append new rows to the sheet. If a schema is attached and `validate:true`
       * is passed, input data is validated before writing. Cache is invalidated
       * on success.
       */
      append(data: T | T[], options?: Pick<GQueryReadOptions, "validate">): GQueryResult<T>;
      /** Get data from the sheet. */
      get(options?: GQueryReadOptions): GQueryResult<T>;
      /** Execute a Google Visualization API query string directly. */
      query(query: string, options?: GQueryReadOptions): GQueryResult;
      /** Delete rows from the sheet. Cache is invalidated on success. */
      delete(): {
          deletedRows: number;
      };
  }
  /**
   * Factory class for building and executing queries with filters, joins,
   * pagination, and server-side predicates.
   */
  declare class GQueryTableFactory<T extends Record<string, any> = Record<string, any>> {
      GQueryTable: GQueryTable<T>;
      selectOption?: string[];
      /** In-memory filter applied after fetch. */
      filterOption?: (row: any) => boolean;
      /** Typed predicate compiled to gviz/tq for server-side filtering. */
      whereExprOption?: GQueryWhereExpr;
      joinOption: {
          sheetName: string;
          sheetColumn: string;
          joinColumn: string;
          columnsToReturn?: string[];
      }[];
      limitOption?: number;
      offsetOption?: number;
      /** Restrict update fetches/diffs to a subset of columns. */
      fieldsOption?: string[];
      /** Keep all joined columns even when `.select()` doesn't list them. */
      includeJoinColumnsOption: boolean;
      constructor(GQueryTable: GQueryTable<T>);
      select(headers: string[]): GQueryTableFactory<T>;
      where(filterFn: (row: GQueryRow<T>) => boolean): GQueryTableFactory<T>;
      whereExpr(expr: GQueryWhereExpr): GQueryTableFactory<T>;
      limit(n: number): GQueryTableFactory<T>;
      offset(n: number): GQueryTableFactory<T>;
      fields(columns: string[]): GQueryTableFactory<T>;
      includeJoinColumns(include?: boolean): GQueryTableFactory<T>;
      join(sheetName: string, sheetColumn: string, joinColumn: string, columnsToReturn?: string[]): GQueryTableFactory<T>;
      get(options?: GQueryReadOptions): GQueryResult<T>;
      update(updateFn: (row: GQueryRow<T>) => Partial<T>): GQueryResult<T>;
      append(data: T | T[], options?: Pick<GQueryReadOptions, "validate">): GQueryResult<T>;
      delete(): {
          deletedRows: number;
      };
  }
  
  export { DateTimeRenderOption, GQuery, GQueryApiError, GQueryCache, GQuerySchemaError, GQueryTable, GQueryTableFactory, StandardSchemaV1, ValueRenderOption };
  export type { GQueryCacheOptions, GQueryCacheScope, GQueryComparisonOp, GQueryOptions, GQueryReadOptions, GQueryResult, GQueryRow, GQueryWhereExpr, InferSchema };
  
}
declare var GQuery: typeof GQuery;
