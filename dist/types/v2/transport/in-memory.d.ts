import type { AtomicBatchUpdateOptions, AtomicBatchUpdateResult, AtomicMutation, SheetBatchGetResult, SheetBatchUpdateOptions, SheetBatchUpdateResult, SheetCellInput, SheetReadOptions, SheetsTransport, SpreadsheetMetadata, SheetValueRange, SheetValueUpdate, TransportOperationKind } from "./contracts";
export interface InMemorySheetSeed {
    sheetId: number;
    title: string;
    values?: readonly (readonly SheetCellInput[])[];
    hasFullSheetProtection?: boolean;
}
export interface InMemorySpreadsheetSeed {
    spreadsheetId: string;
    sheets: readonly InMemorySheetSeed[];
}
export interface InMemoryTransportCall {
    kind: TransportOperationKind;
    spreadsheetId: string;
    ranges: readonly string[];
    requestCount: number;
    valueRenderOption?: SheetReadOptions["valueRenderOption"];
}
export declare class InMemorySheetsTransport implements SheetsTransport {
    private readonly spreadsheets;
    private readonly calls;
    constructor(seeds?: readonly InMemorySpreadsheetSeed[]);
    addSpreadsheet(seed: InMemorySpreadsheetSeed): void;
    get history(): readonly InMemoryTransportCall[];
    clearHistory(): void;
    snapshot(spreadsheetId: string): InMemorySpreadsheetSeed;
    private record;
    private requireSpreadsheet;
    private requireSheetById;
    private resolveRange;
    getSpreadsheetMetadata(spreadsheetId: string): SpreadsheetMetadata;
    private read;
    get(spreadsheetId: string, range: string, options?: SheetReadOptions): SheetValueRange;
    batchGet(spreadsheetId: string, ranges: readonly string[], options?: SheetReadOptions): SheetBatchGetResult;
    batchUpdate(spreadsheetId: string, updates: readonly SheetValueUpdate[], options?: SheetBatchUpdateOptions): SheetBatchUpdateResult;
    atomicBatchUpdate(spreadsheetId: string, mutations: readonly AtomicMutation[], options?: AtomicBatchUpdateOptions): AtomicBatchUpdateResult;
}
