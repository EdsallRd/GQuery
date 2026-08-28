export type GQueryErrorCode = "API_RATE_LIMIT" | "API_SERVER" | "API_NETWORK" | "API_DEADLINE" | "API_FAILURE" | "DEADLINE_EXCEEDED" | "RETRY_EXHAUSTED" | "AMBIGUOUS_COMMIT" | "CACHE_CORRUPT" | "CACHE_CONFIGURATION" | "JOURNAL_CAPACITY" | "JOURNAL_ENTRY_TOO_LARGE" | "JOURNAL_CORRUPT" | "JOURNAL_LOCK_TIMEOUT" | "DEFERRED_CONFLICT" | "REQUEST_TOO_LARGE";
export declare class GQueryV2Error extends Error {
    readonly code: GQueryErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
    constructor(code: GQueryErrorCode, message: string, details?: Readonly<Record<string, unknown>>, cause?: unknown);
}
export declare class RequestPayloadTooLargeError extends GQueryV2Error {
    constructor(operationKind: string, bytes: number, maximumBytes: number);
}
export type ApiFailureKind = "rate-limit" | "server" | "network" | "deadline" | "non-retryable";
export interface ApiFailureDetails {
    readonly kind: ApiFailureKind;
    readonly statusCode?: number;
    readonly retryAfterMs?: number;
    readonly retryable: boolean;
    readonly originalMessage: string;
}
export declare class ApiFailure extends GQueryV2Error {
    readonly api: ApiFailureDetails;
    constructor(api: ApiFailureDetails, cause?: unknown);
}
export declare class DeadlineExceededError extends GQueryV2Error {
    constructor(deadlineMs: number, nowMs: number, cause?: unknown);
}
export declare class RetryExhaustedError extends GQueryV2Error {
    constructor(attempts: number, lastFailure: ApiFailure);
}
export declare class AmbiguousCommitError extends GQueryV2Error {
    constructor(operationKind: string, failure: ApiFailure);
}
/** Convert the loose errors emitted by Apps Script advanced services into a stable API error. */
export declare function normalizeApiFailure(error: unknown): ApiFailure;
