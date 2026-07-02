import { GQueryTable } from "./index";
import { GQueryReadOptions, GQueryResult, GQueryRow } from "./types";
export declare function appendInternal<T extends Record<string, any> = Record<string, any>>(table: GQueryTable<T>, data: T[], options?: Pick<GQueryReadOptions, "validate">): GQueryResult<T>;
/**
 * Append a single row and return it directly (not wrapped in a GQueryResult).
 * @param table The GQueryTable to append to
 * @param row Object to append
 * @param options Optional validation flag
 * @returns The inserted row with __meta populated
 */
export declare function appendOneInternal<T extends Record<string, any> = Record<string, any>>(table: GQueryTable<T>, row: T, options?: Pick<GQueryReadOptions, "validate">): GQueryRow<T>;
