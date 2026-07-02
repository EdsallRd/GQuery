import { type CacheOptions } from "./cache";
import { GQueryReadOptions, GQueryResult, GQueryRow, InferSchema, StandardSchemaV1 } from "./types";
export type { CacheOptions };
export * from "./types";
/**
 * Main GQuery class for interacting with Google Sheets
 * Provides a query-like interface for reading and writing spreadsheet data
 */
export declare class GQuery {
    spreadsheetId: string;
    /**
     * Create a new GQuery instance
     * @param spreadsheetId Optional spreadsheet ID. If not provided, uses the active spreadsheet
     */
    constructor(spreadsheetId?: string);
    /**
     * Get a typed table reference for a specific sheet using a Standard Schema.
     * The schema's output type flows through all subsequent operations.
     * Pass `validate: true` to `get()` / `update()` / `append()` to enable runtime validation.
     *
     * @example
     * const schema = z.object({ Name: z.string(), Age: z.number() });
     * const result = gq.from("People", schema).get(); // GQueryResult<{ Name: string; Age: number }>
     *
     * @param sheetName Name of the sheet
     * @param schema A Standard Schema V1 compatible schema (Zod, Valibot, ArkType, etc.)
     */
    from<S extends StandardSchemaV1>(sheetName: string, schema: S): GQueryTable<InferSchema<S> & Record<string, any>>;
    /**
     * Get a table reference for a specific sheet with an explicit type parameter.
     * No runtime validation — the type parameter is a compile-time assertion only.
     *
     * @example
     * const result = gq.from<MyRowType>("Sheet1").get(); // GQueryResult<MyRowType>
     *
     * @param sheetName Name of the sheet
     */
    from<T extends Record<string, any> = Record<string, any>>(sheetName: string): GQueryTable<T>;
    /**
     * Efficiently fetch data from multiple sheets at once.
     * For typed results per-sheet, use `from()` individually.
     *
     * @param sheetNames Array of sheet names to fetch
     * @param options Optional rendering options
     * @returns Object mapping sheet names to their data
     */
    getMany(sheetNames: string[], options?: GQueryReadOptions): {
        [sheetName: string]: GQueryResult;
    };
}
/**
 * Represents a single sheet table for query operations.
 * @typeParam T - The shape of each data row. Inferred from a Standard Schema if provided.
 */
export declare class GQueryTable<T extends Record<string, any> = Record<string, any>> {
    GQuery: GQuery;
    spreadsheetId: string;
    spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet;
    sheetName: string;
    sheet: GoogleAppsScript.Spreadsheet.Sheet;
    /** The Standard Schema used for type inference and optional runtime validation */
    schema?: StandardSchemaV1<unknown, T>;
    /** Cache options set by .cached() — undefined means no caching */
    private cacheOpts?;
    constructor(GQuery: GQuery, spreadsheetId: string, sheetName: string, schema?: StandardSchemaV1<unknown, T>);
    /**
     * Select specific columns to return
     * @param headers Array of column names to select
     * @returns GQueryTableFactory for chaining
     */
    select(headers: string[]): GQueryTableFactory<T>;
    /**
     * Filter rows based on a condition
     * @param filterFn Function that receives a typed row and returns true for rows to include
     * @returns GQueryTableFactory for chaining
     */
    where(filterFn: (row: GQueryRow<T>) => boolean): GQueryTableFactory<T>;
    /**
     * Sort rows by a field before returning
     * @param field Column name to sort by
     * @param direction Sort direction: "asc" (default) or "desc"
     * @returns GQueryTableFactory for chaining
     */
    orderBy(field: keyof T & string, direction?: "asc" | "desc"): GQueryTableFactory<T>;
    /**
     * Limit the number of rows returned.
     * @param n Maximum number of rows
     * @returns GQueryTableFactory for chaining
     */
    limit(n: number): GQueryTableFactory<T>;
    /**
     * Skip the first N rows before returning.
     * @param n Number of rows to skip
     * @returns GQueryTableFactory for chaining
     */
    offset(n: number): GQueryTableFactory<T>;
    /**
     * Join with another sheet.
     * Note: joined columns are typed as additional `any` fields alongside T.
     *
     * @param sheetName Name of sheet to join with
     * @param sheetColumn Column in the joined sheet to match on
     * @param joinColumn Column in this sheet to match on
     * @param columnsToReturn Optional array of columns to return from joined sheet
     * @returns GQueryTableFactory for chaining
     */
    join(sheetName: string, sheetColumn: string, joinColumn: string, columnsToReturn?: string[]): GQueryTableFactory<T>;
    /**
     * Enable server-side caching for this read via CacheService.
     * Subsequent `.get()` calls will serve from cache on hit and populate the cache
     * on miss. Writes (append/appendOne/update/delete) on the same sheet
     * automatically invalidate the cache — no manual `.invalidate()` needed.
     *
     * @param opts Optional cache configuration (key, ttl, bypass)
     * @returns this (for chaining)
     */
    cached(opts?: CacheOptions): this;
    /**
     * Update rows in the sheet
     * @param updateFn Function that receives a typed row and returns updated values
     * @returns GQueryResult with updated rows
     */
    update(updateFn: (row: GQueryRow<T>) => Partial<T>): GQueryResult<T>;
    /**
     * Append new rows to the sheet.
     * If a schema is attached, input data is validated before writing (when validate is true).
     *
     * @param data Single object or array of objects to append
     * @param options Optional rendering options (set validate: true to run schema validation)
     * @returns GQueryResult with appended rows
     */
    append(data: T | T[], options?: Pick<GQueryReadOptions, "validate">): GQueryResult<T>;
    /**
     * Append a single row and return the inserted row directly (not wrapped in a result).
     * @param row Object to append
     * @param options Optional validation flag
     * @returns The inserted row with __meta populated
     */
    appendOne(row: T, options?: Pick<GQueryReadOptions, "validate">): GQueryRow<T>;
    /**
     * Get data from the sheet
     * @param options Optional rendering and validation options
     * @returns GQueryResult with rows typed to T
     */
    get(options?: GQueryReadOptions): GQueryResult<T>;
    /**
     * Get a single row by its `id` field.
     * @param id Value of the row's `id` field
     * @returns The matching row, or undefined if no row matches
     */
    getById(id: T extends {
        id: infer Id;
    } ? Id : string | number): GQueryRow<T> | undefined;
    /**
     * Update a single row identified by its `id` field.
     * The mutator may either mutate the row in place or return a Partial<T> — both styles are handled.
     * @param id Value of the row's `id` field
     * @param mutator Function that mutates the row in place or returns updated field values
     */
    updateById(id: T extends {
        id: infer Id;
    } ? Id : string | number, mutator: (row: T) => void | Partial<T>): void;
    /**
     * Delete a single row identified by its `id` field.
     * @param id Value of the row's `id` field
     */
    deleteById(id: T extends {
        id: infer Id;
    } ? Id : string | number): void;
    /**
     * Execute a Google Visualization API query
     * @param query Query string in Google Query Language
     * @returns GQueryResult with query results
     */
    query(query: string): GQueryResult;
    /**
     * Delete rows from the sheet
     * @returns Object with count of deleted rows
     */
    delete(): {
        deletedRows: number;
    };
}
/**
 * Factory class for building and executing queries with filters and joins.
 * @typeParam T - The shape of each data row, inherited from GQueryTable<T>.
 */
export declare class GQueryTableFactory<T extends Record<string, any> = Record<string, any>> {
    GQueryTable: GQueryTable<T>;
    selectOption?: string[];
    /** Stored as (row: any) => boolean to avoid friction with raw parsed rows internally */
    filterOption?: (row: any) => boolean;
    joinOption: {
        sheetName: string;
        sheetColumn: string;
        joinColumn: string;
        columnsToReturn?: string[];
    }[];
    orderByState?: {
        field: string;
        direction: "asc" | "desc";
    };
    limitState?: number;
    offsetState?: number;
    /** Cache options set by .cached() — undefined means no caching */
    cacheOpts?: CacheOptions;
    constructor(GQueryTable: GQueryTable<T>);
    select(headers: string[]): GQueryTableFactory<T>;
    where(filterFn: (row: GQueryRow<T>) => boolean): GQueryTableFactory<T>;
    orderBy(field: keyof T & string, direction?: "asc" | "desc"): this;
    limit(n: number): this;
    offset(n: number): this;
    join(sheetName: string, sheetColumn: string, joinColumn: string, columnsToReturn?: string[]): GQueryTableFactory<T>;
    /**
     * Enable server-side caching for this read via CacheService.
     * @param opts Optional cache configuration (key, ttl, bypass)
     * @returns this (for chaining)
     */
    cached(opts?: CacheOptions): this;
    private uncachedGet;
    get(options?: GQueryReadOptions): GQueryResult<T>;
    update(updateFn: (row: GQueryRow<T>) => Partial<T>): GQueryResult<T>;
    append(data: T | T[], options?: Pick<GQueryReadOptions, "validate">): GQueryResult<T>;
    delete(): {
        deletedRows: number;
    };
}
