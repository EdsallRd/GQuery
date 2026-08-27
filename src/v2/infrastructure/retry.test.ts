import { describe, expect, it } from "vitest";
import {
  AmbiguousCommitError,
  ApiFailure,
  DeadlineExceededError,
  RetryExhaustedError,
} from "./errors";
import { ExecutionBudget, RetryController } from "./retry";

function fakeRuntime() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    clock: { now: () => now },
    sleeper: {
      sleep: (milliseconds: number) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    },
    random: { next: () => 0.5 },
    sleeps,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("RetryController", () => {
  it("uses full-jitter exponential backoff for retryable reads", () => {
    const runtime = fakeRuntime();
    const controller = new RetryController(runtime);
    let calls = 0;

    const result = controller.execute(
      () => {
        calls += 1;
        if (calls < 3) throw { statusCode: 429, message: "quota exceeded" };
        return "ok";
      },
      {
        operation: { kind: "read" },
        budget: new ExecutionBudget(10_000, runtime.clock),
        baseDelayMs: 100,
        maxDelayMs: 1_000,
      },
    );

    expect(result.value).toBe("ok");
    expect(result.stats).toMatchObject({ attempts: 3, retries: 2, sleptMs: 150 });
    expect(runtime.sleeps).toEqual([50, 100]);
  });

  it("honors Retry-After when it exceeds jitter", () => {
    const runtime = fakeRuntime();
    const controller = new RetryController(runtime);
    let calls = 0;
    controller.run(
      () => {
        calls += 1;
        if (calls === 1) throw { status: 429, retryAfter: 2, message: "429" };
        return true;
      },
      {
        operation: { kind: "read" },
        budget: new ExecutionBudget(5_000, runtime.clock),
      },
    );
    expect(runtime.sleeps).toEqual([2_000]);
  });

  it("never sleeps across the shared deadline", () => {
    const runtime = fakeRuntime();
    const controller = new RetryController(runtime);
    expect(() =>
      controller.run(
        () => {
          throw { status: 429, retryAfter: 10, message: "429" };
        },
        {
          operation: { kind: "read" },
          budget: new ExecutionBudget(1_000, runtime.clock),
        },
      ),
    ).toThrow(DeadlineExceededError);
    expect(runtime.sleeps).toEqual([]);
  });

  it("does not retry an unprotected append whose commit may be ambiguous", () => {
    const runtime = fakeRuntime();
    const controller = new RetryController(runtime);
    let calls = 0;
    expect(() =>
      controller.run(
        () => {
          calls += 1;
          throw { status: 503, message: "503 unavailable" };
        },
        { operation: { kind: "append" } },
      ),
    ).toThrow(AmbiguousCommitError);
    expect(calls).toBe(1);
  });

  it("allows an idempotency-protected append to retry", () => {
    const runtime = fakeRuntime();
    const controller = new RetryController(runtime);
    let calls = 0;
    const value = controller.run(
      () => {
        calls += 1;
        if (calls === 1) throw { status: 503, message: "503 unavailable" };
        return 42;
      },
      {
        operation: { kind: "append", idempotencyKey: "request-1" },
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
    );
    expect(value).toBe(42);
    expect(calls).toBe(2);
  });

  it("types non-retryable failures and retry exhaustion", () => {
    const runtime = fakeRuntime();
    const controller = new RetryController(runtime);
    expect(() =>
      controller.run(
        () => {
          throw new Error("invalid request");
        },
        { operation: { kind: "read" } },
      ),
    ).toThrow(ApiFailure);

    expect(() =>
      controller.run(
        () => {
          throw { status: 500, message: "500" };
        },
        {
          operation: { kind: "read" },
          maxAttempts: 2,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      ),
    ).toThrow(RetryExhaustedError);
  });
});
