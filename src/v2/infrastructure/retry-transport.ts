import { TransportInvoker, TransportOperationContext } from "../transport/contracts";
import {
  ExecutionBudget,
  RetryController,
  RetryOperation,
  RetryPolicy,
  RetryStats,
} from "./retry";

export interface RetryTransportInvokerOptions extends RetryPolicy {
  readonly budget: ExecutionBudget;
  readonly idempotencyKey?: (context: TransportOperationContext) => string | undefined;
  readonly onAttemptComplete?: (
    context: TransportOperationContext,
    stats: RetryStats,
  ) => void;
}

/** Connects the transport interception port to a shared retry/deadline budget. */
export class RetryTransportInvoker implements TransportInvoker {
  public constructor(
    private readonly controller: RetryController,
    private readonly options: RetryTransportInvokerOptions,
  ) {}

  public invoke<T>(context: TransportOperationContext, operation: () => T): T {
    const retryOperation: RetryOperation = {
      kind: context.operationClass,
      idempotent: context.idempotent,
      idempotencyKey: this.options.idempotencyKey?.(context),
    };
    const result = this.controller.execute(operation, {
      operation: retryOperation,
      budget: this.options.budget,
      maxAttempts: this.options.maxAttempts,
      baseDelayMs: this.options.baseDelayMs,
      maxDelayMs: this.options.maxDelayMs,
    });
    this.options.onAttemptComplete?.(context, result.stats);
    return result.value;
  }
}

export interface ScopedRetryTransportInvokerOptions extends RetryPolicy {
  readonly maxElapsedMs?: number;
  readonly idempotencyKey?: (context: TransportOperationContext) => string | undefined;
  readonly onAttemptComplete?: (
    context: TransportOperationContext,
    stats: RetryStats,
  ) => void;
}

/**
 * Shares one deadline across every transport call made inside `run()`. Nested
 * scopes reuse the outer deadline, while an isolated invocation still gets a
 * bounded budget of its own.
 */
export class ScopedRetryTransportInvoker implements TransportInvoker {
  private activeBudget: ExecutionBudget | null = null;
  private depth = 0;

  public constructor(
    private readonly controller: RetryController,
    private readonly options: ScopedRetryTransportInvokerOptions = {},
  ) {}

  public run<T>(operation: () => T): T {
    const ownsBudget = this.activeBudget === null;
    if (ownsBudget) this.activeBudget = new ExecutionBudget(this.options.maxElapsedMs ?? 20_000);
    this.depth += 1;
    try {
      return operation();
    } finally {
      this.depth -= 1;
      if (ownsBudget && this.depth === 0) this.activeBudget = null;
    }
  }

  public invoke<T>(context: TransportOperationContext, operation: () => T): T {
    const execute = (): T => {
      const budget = this.activeBudget ?? new ExecutionBudget(this.options.maxElapsedMs ?? 20_000);
      const result = this.controller.execute(operation, {
        operation: {
          kind: context.operationClass,
          idempotent: context.idempotent,
          idempotencyKey: this.options.idempotencyKey?.(context),
        },
        budget,
        maxAttempts: this.options.maxAttempts,
        baseDelayMs: this.options.baseDelayMs,
        maxDelayMs: this.options.maxDelayMs,
      });
      this.options.onAttemptComplete?.(context, result.stats);
      return result.value;
    };
    return this.activeBudget === null ? this.run(execute) : execute();
  }
}
