export declare const DEFAULT_RETRIES = 4;
export declare const MAX_RETRIES = 6;
export declare function normalizeRetryCount(retries?: number): number;
/**
 * Run a Sheets API request with bounded exponential backoff for quota errors.
 * `retries` counts retries after the initial request.
 */
export declare function callHandler<T>(fn: () => T, retries?: number): T;
