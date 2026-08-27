import { TransportInvoker, TransportOperationContext } from "../transport/contracts";
import { ExecutionBudget, RetryController, RetryPolicy, RetryStats } from "./retry";
export interface RetryTransportInvokerOptions extends RetryPolicy {
    readonly budget: ExecutionBudget;
    readonly idempotencyKey?: (context: TransportOperationContext) => string | undefined;
    readonly onAttemptComplete?: (context: TransportOperationContext, stats: RetryStats) => void;
}
/** Connects the transport interception port to a shared retry/deadline budget. */
export declare class RetryTransportInvoker implements TransportInvoker {
    private readonly controller;
    private readonly options;
    constructor(controller: RetryController, options: RetryTransportInvokerOptions);
    invoke<T>(context: TransportOperationContext, operation: () => T): T;
}
export interface ScopedRetryTransportInvokerOptions extends RetryPolicy {
    readonly maxElapsedMs?: number;
    readonly idempotencyKey?: (context: TransportOperationContext) => string | undefined;
    readonly onAttemptComplete?: (context: TransportOperationContext, stats: RetryStats) => void;
}
/**
 * Shares one deadline across every transport call made inside `run()`. Nested
 * scopes reuse the outer deadline, while an isolated invocation still gets a
 * bounded budget of its own.
 */
export declare class ScopedRetryTransportInvoker implements TransportInvoker {
    private readonly controller;
    private readonly options;
    private activeBudget;
    private depth;
    constructor(controller: RetryController, options?: ScopedRetryTransportInvokerOptions);
    run<T>(operation: () => T): T;
    invoke<T>(context: TransportOperationContext, operation: () => T): T;
}
