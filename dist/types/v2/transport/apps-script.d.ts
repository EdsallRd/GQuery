import type { AtomicBatchUpdateOptions, AtomicBatchUpdateResult, AtomicMutation, SheetBatchGetResult, SheetBatchUpdateOptions, SheetBatchUpdateResult, SheetReadOptions, SheetsTransport, SpreadsheetMetadata, SheetValueRange, SheetValueUpdate, TransportInvoker } from "./contracts";
export { atomicMutationToSheetsRequest } from "./atomic-request";
export interface AppsScriptSheetsTransportOptions {
    /** Override the global advanced Sheets service, primarily for tests. */
    service?: GoogleAppsScript.Sheets;
    /** Synchronous deadline/retry/telemetry interception point. */
    invoker?: TransportInvoker;
}
export declare class AppsScriptSheetsTransport implements SheetsTransport {
    private readonly injectedService?;
    private readonly invoker?;
    constructor(options?: AppsScriptSheetsTransportOptions);
    private service;
    private invoke;
    getSpreadsheetMetadata(spreadsheetId: string): SpreadsheetMetadata;
    get(spreadsheetId: string, range: string, options?: SheetReadOptions): SheetValueRange;
    batchGet(spreadsheetId: string, ranges: readonly string[], options?: SheetReadOptions): SheetBatchGetResult;
    batchUpdate(spreadsheetId: string, updates: readonly SheetValueUpdate[], options?: SheetBatchUpdateOptions): SheetBatchUpdateResult;
    atomicBatchUpdate(spreadsheetId: string, mutations: readonly AtomicMutation[], options?: AtomicBatchUpdateOptions): AtomicBatchUpdateResult;
}
