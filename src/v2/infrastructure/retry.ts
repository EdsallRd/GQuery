import {
  AmbiguousCommitError,
  ApiFailure,
  DeadlineExceededError,
  GQueryV2Error,
  RetryExhaustedError,
  normalizeApiFailure,
} from "./errors";
import {
  Clock,
  RandomSource,
  Sleeper,
  appsScriptSleeper,
  mathRandomSource,
  systemClock,
} from "./runtime";

export type RetryOperationKind =
  | "read"
  | "idempotent-write"
  | "append"
  | "structural-delete"
  | "write";

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

export class ExecutionBudget {
  public readonly startedAtMs: number;
  public readonly deadlineMs: number;

  public constructor(
    maxElapsedMs = 20_000,
    private readonly clock: Clock = systemClock,
  ) {
    if (!Number.isFinite(maxElapsedMs) || maxElapsedMs <= 0) {
      throw new RangeError("Execution budget must be a positive number of milliseconds.");
    }
    this.startedAtMs = clock.now();
    this.deadlineMs = this.startedAtMs + maxElapsedMs;
  }

  public now(): number {
    return this.clock.now();
  }

  public elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAtMs);
  }

  public remainingMs(): number {
    return Math.max(0, this.deadlineMs - this.now());
  }

  public assertAvailable(cause?: unknown): void {
    const now = this.now();
    if (now >= this.deadlineMs) {
      throw new DeadlineExceededError(this.deadlineMs, now, cause);
    }
  }
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

function validatePolicy(policy: RetryPolicy): Required<RetryPolicy> {
  const maxAttempts = policy.maxAttempts ?? 5;
  const baseDelayMs = policy.baseDelayMs ?? 500;
  const maxDelayMs = policy.maxDelayMs ?? 10_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer.");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError("baseDelayMs must be a non-negative number.");
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new RangeError("maxDelayMs must be greater than or equal to baseDelayMs.");
  }
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

function canRetry(operation: RetryOperation): boolean {
  return (
    operation.kind === "read" ||
    operation.kind === "idempotent-write" ||
    operation.idempotent === true ||
    (typeof operation.idempotencyKey === "string" && operation.idempotencyKey.length > 0)
  );
}

function isCommitAmbiguous(operation: RetryOperation): boolean {
  return operation.kind === "append" || operation.kind === "structural-delete" || operation.kind === "write";
}

/** Synchronous retry execution which can share one deadline across many API calls. */
export class RetryController {
  private readonly clock: Clock;
  private readonly sleeper: Sleeper;
  private readonly random: RandomSource;

  public constructor(dependencies: RetryControllerDependencies = {}) {
    this.clock = dependencies.clock ?? systemClock;
    this.sleeper = dependencies.sleeper ?? appsScriptSleeper;
    this.random = dependencies.random ?? mathRandomSource;
  }

  public run<T>(operation: (context: RetryAttemptContext) => T, options: RetryExecutionOptions): T {
    return this.execute(operation, options).value;
  }

  public execute<T>(
    operation: (context: RetryAttemptContext) => T,
    options: RetryExecutionOptions,
  ): RetryExecution<T> {
    const policy = validatePolicy(options);
    const budget = options.budget ?? new ExecutionBudget(20_000, this.clock);
    const retrySafe = canRetry(options.operation);
    let attempts = 0;
    let sleptMs = 0;
    let lastFailureKind: ApiFailure["api"]["kind"] | undefined;

    while (attempts < policy.maxAttempts) {
      budget.assertAvailable();
      attempts += 1;

      try {
        const value = operation({ attempt: attempts, remainingMs: budget.remainingMs() });
        return {
          value,
          stats: {
            attempts,
            retries: attempts - 1,
            sleptMs,
            elapsedMs: budget.elapsedMs(),
            lastFailureKind,
          },
        };
      } catch (error) {
        if (error instanceof DeadlineExceededError || (error instanceof GQueryV2Error && !(error instanceof ApiFailure))) {
          throw error;
        }
        const failure = normalizeApiFailure(error);
        lastFailureKind = failure.api.kind;
        if (!failure.api.retryable) throw failure;
        if (!retrySafe) {
          if (isCommitAmbiguous(options.operation)) {
            throw new AmbiguousCommitError(options.operation.kind, failure);
          }
          throw failure;
        }
        if (attempts >= policy.maxAttempts) {
          throw new RetryExhaustedError(attempts, failure);
        }

        const exponentialCap = Math.min(
          policy.maxDelayMs,
          policy.baseDelayMs * Math.pow(2, attempts - 1),
        );
        const jitter = Math.floor(Math.max(0, Math.min(1, this.random.next())) * exponentialCap);
        const delayMs = Math.max(jitter, failure.api.retryAfterMs ?? 0);
        const now = budget.now();
        if (delayMs >= budget.deadlineMs - now) {
          throw new DeadlineExceededError(budget.deadlineMs, now, failure);
        }
        if (delayMs > 0) {
          this.sleeper.sleep(delayMs);
          sleptMs += delayMs;
        }
      }
    }

    // The loop always returns or throws. This guards future changes to policy validation.
    throw new RetryExhaustedError(
      attempts,
      normalizeApiFailure(new Error("Retry loop exited unexpectedly.")),
    );
  }
}
