export declare const DEFAULT_RETRIES = 4;
export declare const MAX_RETRIES = 6;
export interface GQueryMeasurement {
    operation: string;
    durationMs: number;
    attempt: number;
    succeeded: boolean;
    rangeCount: number;
    valueRows: number;
}
declare let observer: ((measurement: GQueryMeasurement) => void) | undefined;
/** Observe service calls without exposing spreadsheet IDs, ranges, or values. */
export declare function configureGQueryObserver(next?: typeof observer): void;
export declare function normalizeRetryCount(retries?: number): number;
/**
 * Run a Sheets API request with bounded exponential backoff for quota errors.
 * `retries` counts retries after the initial request.
 */
export declare function callHandler<T>(fn: () => T, retries?: number, operation?: string, rangeCount?: number): T;
export {};
