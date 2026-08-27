import { ApiFailure } from "./errors";
import { Clock, RandomSource, Sleeper } from "./runtime";
export type RetryOperationKind = "read" | "idempotent-write" | "append" | "structural-delete" | "write";
export interface RetryOperation {
    readonly kind: RetryOperationKind;
    /** A durable key whose receipt is checked by the caller/transport. */
    readonly idempotencyKey?: string;
    /** Use only when applying the request twice is demonstrably harmless. */
    readonly idempotent?: boolean;
}
export interface RetryPolicy {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
}
export interface RetryAttemptContext {
    readonly attempt: number;
    readonly remainingMs: number;
}
export interface RetryStats {
    readonly attempts: number;
    readonly retries: number;
    readonly sleptMs: number;
    readonly elapsedMs: number;
    readonly lastFailureKind?: ApiFailure["api"]["kind"];
}
export interface RetryExecution<T> {
    readonly value: T;
    readonly stats: RetryStats;
}
export declare class ExecutionBudget {
    private readonly clock;
    readonly startedAtMs: number;
    readonly deadlineMs: number;
    constructor(maxElapsedMs?: number, clock?: Clock);
    now(): number;
    elapsedMs(): number;
    remainingMs(): number;
    assertAvailable(cause?: unknown): void;
}
export interface RetryControllerDependencies {
    readonly clock?: Clock;
    readonly sleeper?: Sleeper;
    readonly random?: RandomSource;
}
export interface RetryExecutionOptions extends RetryPolicy {
    readonly operation: RetryOperation;
    readonly budget?: ExecutionBudget;
}
/** Synchronous retry execution which can share one deadline across many API calls. */
export declare class RetryController {
    private readonly clock;
    private readonly sleeper;
    private readonly random;
    constructor(dependencies?: RetryControllerDependencies);
    run<T>(operation: (context: RetryAttemptContext) => T, options: RetryExecutionOptions): T;
    execute<T>(operation: (context: RetryAttemptContext) => T, options: RetryExecutionOptions): RetryExecution<T>;
}
