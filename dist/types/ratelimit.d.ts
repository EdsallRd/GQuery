/**
 * Exponential-backoff handler for Google Sheets API calls.
 *
 * Retries on rate-limit / quota errors thrown by the Advanced Sheets service.
 * `urlFetch: true` adds support for `UrlFetchApp.fetch` results: response
 * codes 429/5xx are converted into retries; other non-2xx responses are
 * surfaced as `GQueryApiError`.
 */
export declare function callHandler<T>(fn: () => T, retries?: number, options?: {
    urlFetch?: boolean;
    operation?: string;
}): T;
