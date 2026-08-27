export type RuntimeErrorCode = "SOURCE_UNAVAILABLE" | "SHEET_NOT_FOUND" | "MISSING_HEADER" | "DUPLICATE_HEADER" | "SCHEMA_CHANGED" | "DUPLICATE_KEY" | "RELATION_CARDINALITY" | "RELATION_NOT_FOUND" | "RELATION_RESTRICT" | "INVALID_QUERY" | "NOT_FOUND" | "EXPECTED_ONE" | "STALE_SELECTION" | "MUTATION_CONFLICT" | "MUTATION_INVALID" | "TRANSACTION_PARTIAL" | "MIGRATION_REQUIRED" | "BACKUP_REQUIRED" | "UNSUPPORTED_OPERATION";
export interface RuntimeErrorOptions {
    readonly details?: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
}
/** Structured failures raised by the schema/query/execution layers. */
export declare class GQueryRuntimeError extends Error {
    readonly code: RuntimeErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
    constructor(code: RuntimeErrorCode, message: string, options?: RuntimeErrorOptions);
}
