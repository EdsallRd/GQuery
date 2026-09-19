import type { GQueryAppendValuesOptions, GQueryAppendValuesResult, GQueryBatchUpdateValuesResult, GQueryCellValue, GQueryGetValuesOptions, GQueryUpdateValuesResult, GQueryValueRangeInput, GQueryValueRangeResult, GQueryWriteValuesOptions } from "./types";
interface ValuesClient {
    spreadsheetId: string;
    retries: number;
}
export declare function batchGetValuesInternal(client: ValuesClient, ranges: readonly string[], options?: GQueryGetValuesOptions): GQueryValueRangeResult[];
export declare function getValuesInternal(client: ValuesClient, range: string, options?: GQueryGetValuesOptions): GQueryValueRangeResult;
export declare function updateValuesInternal(client: ValuesClient, range: string, values: readonly (readonly GQueryCellValue[])[], options?: GQueryWriteValuesOptions): GQueryUpdateValuesResult;
export declare function batchUpdateValuesInternal(client: ValuesClient, ranges: readonly GQueryValueRangeInput[], options?: GQueryWriteValuesOptions): GQueryBatchUpdateValuesResult;
export declare function appendValuesInternal(client: ValuesClient, range: string, values: readonly (readonly GQueryCellValue[])[], options?: GQueryAppendValuesOptions): GQueryAppendValuesResult;
export {};
