import { GQuery, GQueryTable, GQueryTableFactory } from "./index";
import { GQueryReadOptions, GQueryResult, GQueryWhereExpr } from "./types";
export declare function getManyInternal(GQuery: GQuery, sheetNames: string[], options?: GQueryReadOptions): {
    [sheetName: string]: GQueryResult;
};
export declare function getInternal<T extends Record<string, any> = Record<string, any>>(GQueryTableFactory: GQueryTableFactory<T>, options?: GQueryReadOptions): GQueryResult<T>;
/**
 * Execute a Google Visualization API (gviz/tq) query against the table's
 * sheet. The caller passes in a fully-formed `tq` query string; we handle
 * the column-name → A1-letter substitution by reading the header row once
 * (cached when the spreadsheet's GQueryCache is enabled), wrap the HTTP
 * call in callHandler for retries, and parse the response into typed rows.
 */
export declare function queryInternal(GQueryTable: GQueryTable, query: string, options?: GQueryReadOptions): GQueryResult;
/**
 * Compile a typed GQueryWhereExpr into a Google Visualization API query
 * string. Column names are emitted as backtick-quoted identifiers so they
 * survive the later name → letter substitution step.
 */
export declare function compileWhereExpr(expr: GQueryWhereExpr, select?: string[], limit?: number, offset?: number): string;
