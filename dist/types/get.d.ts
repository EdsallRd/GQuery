import { GQuery, GQueryTable, GQueryTableFactory } from "./index";
import { GQueryReadOptions, GQueryResult, StandardSchemaV1 } from "./types";
export declare function getManyInternal(GQuery: GQuery, sheetNames: string[], options?: GQueryReadOptions): {
    [sheetName: string]: GQueryResult;
};
export declare function getInternal<T extends Record<string, any> = Record<string, any>>(GQueryTableFactory: GQueryTableFactory<T>, options?: GQueryReadOptions, orderBy?: {
    field: string;
    direction: "asc" | "desc";
}, limit?: number, offset?: number): GQueryResult<T>;
export type ReadQueryPlan = Pick<GQueryTableFactory<any>, "joinOption" | "filterOption" | "selectOption">;
/** Pure query evaluation; never accesses Sheets or creates native handles. */
export declare function querySnapshotRows<T extends Record<string, any> = Record<string, any>>(results: Record<string, GQueryResult>, sheetName: string, plan: ReadQueryPlan, options?: GQueryReadOptions, schema?: StandardSchemaV1<unknown, T>, orderBy?: {
    field: string;
    direction: "asc" | "desc";
}, limit?: number, offset?: number): GQueryResult<T>;
export declare function queryInternal(GQueryTable: GQueryTable, query: string): GQueryResult;
