import { GQueryCache } from "./cache";
import { getInternal, getManyInternal, queryInternal } from "./get";
import { updateInternal } from "./update";
import { appendInternal } from "./append";
import { deleteInternal } from "./delete";
import {
  GQueryCacheOptions,
  GQueryReadOptions,
  GQueryResult,
  GQueryRow,
  GQueryWhereExpr,
  InferSchema,
  StandardSchemaV1,
} from "./types";

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
export class GQuery {
  spreadsheetId: string;
  cache: GQueryCache;
  defaultReadOptions: GQueryReadOptions;
  private spreadsheetHandle?: GoogleAppsScript.Spreadsheet.Spreadsheet;
  private sheetHandles: Map<string, GoogleAppsScript.Spreadsheet.Sheet> =
    new Map();

  /**
   * Create a new GQuery instance.
   * @param spreadsheetId Optional spreadsheet ID. If not provided, uses the active spreadsheet.
   * @param options Optional configuration (caching, default read options).
   */
  constructor(spreadsheetId?: string, options: GQueryOptions = {}) {
    this.spreadsheetId = spreadsheetId
      ? spreadsheetId
      : SpreadsheetApp.getActiveSpreadsheet().getId();
    this.cache = new GQueryCache(this.spreadsheetId, options.cache);
    this.defaultReadOptions = options.defaultReadOptions ?? {};
  }

  /** Lazily resolve and memoize the Spreadsheet handle. */
  getSpreadsheet(): GoogleAppsScript.Spreadsheet.Spreadsheet {
    if (!this.spreadsheetHandle) {
      this.spreadsheetHandle = SpreadsheetApp.openById(this.spreadsheetId);
    }
    return this.spreadsheetHandle;
  }

  /** Lazily resolve and memoize a Sheet handle by name. */
  getSheet(sheetName: string): GoogleAppsScript.Spreadsheet.Sheet {
    let handle = this.sheetHandles.get(sheetName);
    if (!handle) {
      handle = this.getSpreadsheet().getSheetByName(sheetName)!;
      this.sheetHandles.set(sheetName, handle);
    }
    return handle;
  }

  /**
   * Get a typed table reference for a specific sheet using a Standard Schema.
   * The schema's output type flows through all subsequent operations.
   * Pass `validate: true` to `get()` / `update()` / `append()` to enable runtime validation.
   *
   * @example
   * const schema = z.object({ Name: z.string(), Age: z.number() });
   * const result = gq.from("People", schema).get(); // GQueryResult<{ Name: string; Age: number }>
   */
  from<S extends StandardSchemaV1>(
    sheetName: string,
    schema: S,
  ): GQueryTable<InferSchema<S> & Record<string, any>>;

  /**
   * Get a table reference for a specific sheet with an explicit type parameter.
   * No runtime validation — the type parameter is a compile-time assertion only.
   */
  from<T extends Record<string, any> = Record<string, any>>(
    sheetName: string,
  ): GQueryTable<T>;

  from<T extends Record<string, any> = Record<string, any>>(
    sheetName: string,
    schema?: StandardSchemaV1,
  ): GQueryTable<T> {
    return new GQueryTable<T>(
      this,
      this.spreadsheetId,
      sheetName,
      schema as StandardSchemaV1<unknown, T> | undefined,
    );
  }

  /**
   * Efficiently fetch data from multiple sheets at once.
   * For typed results per-sheet, use `from()` individually.
   */
  getMany(
    sheetNames: string[],
    options?: GQueryReadOptions,
  ): {
    [sheetName: string]: GQueryResult;
  } {
    return getManyInternal(this, sheetNames, mergeReadOptions(this, options));
  }

  /**
   * Drop every cached entry for a specific sheet (or for the entire
   * spreadsheet, when no sheet name is given).
   */
  invalidateCache(sheetName?: string): void {
    if (sheetName) this.cache.invalidate(sheetName);
  }
}

/**
 * Represents a single sheet table for query operations.
 * @typeParam T - The shape of each data row. Inferred from a Standard Schema if provided.
 */
export class GQueryTable<T extends Record<string, any> = Record<string, any>> {
  GQuery: GQuery;
  spreadsheetId: string;
  sheetName: string;
  /** The Standard Schema used for type inference and optional runtime validation */
  schema?: StandardSchemaV1<unknown, T>;

  constructor(
    GQuery: GQuery,
    spreadsheetId: string,
    sheetName: string,
    schema?: StandardSchemaV1<unknown, T>,
  ) {
    this.GQuery = GQuery;
    this.spreadsheetId = spreadsheetId;
    this.sheetName = sheetName;
    this.schema = schema;
  }

  /** Lazily-resolved Spreadsheet handle (memoized on the GQuery instance). */
  get spreadsheet(): GoogleAppsScript.Spreadsheet.Spreadsheet {
    return this.GQuery.getSpreadsheet();
  }

  /** Lazily-resolved Sheet handle (memoized on the GQuery instance). */
  get sheet(): GoogleAppsScript.Spreadsheet.Sheet {
    return this.GQuery.getSheet(this.sheetName);
  }

  /**
   * Select specific columns to return.
   *
   * Joined columns are excluded by default — chain `.includeJoinColumns()`
   * to keep them all when you don't want to enumerate each one.
   */
  select(headers: string[]): GQueryTableFactory<T> {
    return new GQueryTableFactory<T>(this).select(headers);
  }

  /**
   * Filter rows with an arbitrary predicate. Runs in-memory after the
   * fetch — for server-side filtering, use `.whereExpr()` instead.
   */
  where(filterFn: (row: GQueryRow<T>) => boolean): GQueryTableFactory<T> {
    return new GQueryTableFactory<T>(this).where(filterFn);
  }

  /**
   * Server-side filter via Google Visualization API (gviz/tq). Only matching
   * rows come over the wire. Cannot be combined with joins.
   */
  whereExpr(expr: GQueryWhereExpr): GQueryTableFactory<T> {
    return new GQueryTableFactory<T>(this).whereExpr(expr);
  }

  /**
   * Limit the number of rows returned. When combined with `.offset()` and
   * no joins/in-memory filters, the underlying fetch only requests the
   * requested band.
   */
  limit(n: number): GQueryTableFactory<T> {
    return new GQueryTableFactory<T>(this).limit(n);
  }

  /** Skip the first N rows. */
  offset(n: number): GQueryTableFactory<T> {
    return new GQueryTableFactory<T>(this).offset(n);
  }

  /**
   * Join with another sheet.
   * Note: joined columns are typed as additional `any` fields alongside T.
   */
  join(
    sheetName: string,
    sheetColumn: string,
    joinColumn: string,
    columnsToReturn?: string[],
  ): GQueryTableFactory<T> {
    return new GQueryTableFactory<T>(this).join(
      sheetName,
      sheetColumn,
      joinColumn,
      columnsToReturn,
    );
  }

  /**
   * Update rows in the sheet. Cache (if enabled) is invalidated on success.
   */
  update(updateFn: (row: GQueryRow<T>) => Partial<T>): GQueryResult<T> {
    return new GQueryTableFactory<T>(this).update(updateFn);
  }

  /**
   * Append new rows to the sheet. If a schema is attached and `validate:true`
   * is passed, input data is validated before writing. Cache is invalidated
   * on success.
   */
  append(
    data: T | T[],
    options?: Pick<GQueryReadOptions, "validate">,
  ): GQueryResult<T> {
    const dataArray = Array.isArray(data) ? data : [data];
    return appendInternal<T>(this, dataArray, options);
  }

  /** Get data from the sheet. */
  get(options?: GQueryReadOptions): GQueryResult<T> {
    return new GQueryTableFactory<T>(this).get(options);
  }

  /** Execute a Google Visualization API query string directly. */
  query(query: string, options?: GQueryReadOptions): GQueryResult {
    return queryInternal(this, query, mergeReadOptions(this.GQuery, options));
  }

  /** Delete rows from the sheet. Cache is invalidated on success. */
  delete(): { deletedRows: number } {
    return new GQueryTableFactory<T>(this).delete();
  }
}

/**
 * Factory class for building and executing queries with filters, joins,
 * pagination, and server-side predicates.
 */
export class GQueryTableFactory<
  T extends Record<string, any> = Record<string, any>,
> {
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
  }[] = [];
  limitOption?: number;
  offsetOption?: number;
  /** Restrict update fetches/diffs to a subset of columns. */
  fieldsOption?: string[];
  /** Keep all joined columns even when `.select()` doesn't list them. */
  includeJoinColumnsOption: boolean = false;

  constructor(GQueryTable: GQueryTable<T>) {
    this.GQueryTable = GQueryTable;
  }

  select(headers: string[]): GQueryTableFactory<T> {
    this.selectOption = headers;
    return this;
  }

  where(filterFn: (row: GQueryRow<T>) => boolean): GQueryTableFactory<T> {
    this.filterOption = filterFn;
    return this;
  }

  whereExpr(expr: GQueryWhereExpr): GQueryTableFactory<T> {
    this.whereExprOption = expr;
    return this;
  }

  limit(n: number): GQueryTableFactory<T> {
    this.limitOption = n;
    return this;
  }

  offset(n: number): GQueryTableFactory<T> {
    this.offsetOption = n;
    return this;
  }

  fields(columns: string[]): GQueryTableFactory<T> {
    this.fieldsOption = columns;
    return this;
  }

  includeJoinColumns(include: boolean = true): GQueryTableFactory<T> {
    this.includeJoinColumnsOption = include;
    return this;
  }

  join(
    sheetName: string,
    sheetColumn: string,
    joinColumn: string,
    columnsToReturn?: string[],
  ): GQueryTableFactory<T> {
    this.joinOption.push({
      sheetName,
      sheetColumn,
      joinColumn,
      columnsToReturn,
    });
    return this;
  }

  get(options?: GQueryReadOptions): GQueryResult<T> {
    return getInternal<T>(
      this,
      mergeReadOptions(this.GQueryTable.GQuery, options),
    );
  }

  update(updateFn: (row: GQueryRow<T>) => Partial<T>): GQueryResult<T> {
    return updateInternal<T>(this, updateFn);
  }

  append(
    data: T | T[],
    options?: Pick<GQueryReadOptions, "validate">,
  ): GQueryResult<T> {
    const dataArray = Array.isArray(data) ? data : [data];
    return appendInternal<T>(this.GQueryTable, dataArray, options);
  }

  delete(): { deletedRows: number } {
    return deleteInternal(this);
  }
}

function mergeReadOptions(
  GQuery: GQuery,
  options?: GQueryReadOptions,
): GQueryReadOptions {
  if (!options) return GQuery.defaultReadOptions;
  return { ...GQuery.defaultReadOptions, ...options };
}
