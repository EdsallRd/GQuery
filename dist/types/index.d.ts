import { GQueryCache } from "./cache";
import { GQueryCacheOptions, GQueryReadOptions, GQueryResult, GQueryRow, GQueryWhereExpr, InferSchema, StandardSchemaV1 } from "./types";
export * from "./types";
export { GQueryCache } from "./cache";
/**
 * Optional configuration for a GQuery instance.
 */
export interface GQueryOptions {
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
export declare class GQuery {
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
export declare class GQueryTable<T extends Record<string, any> = Record<string, any>> {
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
export declare class GQueryTableFactory<T extends Record<string, any> = Record<string, any>> {
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
