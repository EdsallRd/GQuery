import { GQuery, GQueryTable, GQueryTableFactory } from "./index";
import { GQueryReadOptions, GQueryResult } from "./types";
export declare function getManyInternal(GQuery: GQuery, sheetNames: string[], options?: GQueryReadOptions): {
    [sheetName: string]: GQueryResult;
};
export declare function getInternal<T extends Record<string, any> = Record<string, any>>(GQueryTableFactory: GQueryTableFactory<T>, options?: GQueryReadOptions, orderBy?: {
    field: string;
    direction: "asc" | "desc";
}, limit?: number, offset?: number): GQueryResult<T>;
export declare function queryInternal(GQueryTable: GQueryTable, query: string): GQueryResult;
