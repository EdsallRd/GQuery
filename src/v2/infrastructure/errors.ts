export type GQueryErrorCode =
  | "API_RATE_LIMIT"
  | "API_SERVER"
  | "API_NETWORK"
  | "API_DEADLINE"
  | "API_FAILURE"
  | "DEADLINE_EXCEEDED"
  | "RETRY_EXHAUSTED"
  | "AMBIGUOUS_COMMIT"
  | "CACHE_CORRUPT"
  | "CACHE_CONFIGURATION"
  | "JOURNAL_CAPACITY"
  | "JOURNAL_ENTRY_TOO_LARGE"
  | "JOURNAL_CORRUPT"
  | "JOURNAL_LOCK_TIMEOUT"
  | "DEFERRED_CONFLICT"
  | "REQUEST_TOO_LARGE";

export class GQueryV2Error extends Error {
  public readonly cause?: unknown;

  public constructor(
    public readonly code: GQueryErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    this.cause = cause;
  }
}

export class RequestPayloadTooLargeError extends GQueryV2Error {
  public constructor(operationKind: string, bytes: number, maximumBytes: number) {
    super(
      "REQUEST_TOO_LARGE",
      `The ${operationKind} payload is ${bytes} bytes, above the ${maximumBytes}-byte safety limit. Split the unit of work before retrying.`,
      { operationKind, bytes, maximumBytes },
    );
  }
}

export type ApiFailureKind =
  | "rate-limit"
  | "server"
  | "network"
  | "deadline"
  | "non-retryable";

export interface ApiFailureDetails {
  readonly kind: ApiFailureKind;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly originalMessage: string;
}

export class ApiFailure extends GQueryV2Error {
  public constructor(public readonly api: ApiFailureDetails, cause?: unknown) {
    const codes: Record<ApiFailureKind, GQueryErrorCode> = {
      "rate-limit": "API_RATE_LIMIT",
      server: "API_SERVER",
      network: "API_NETWORK",
      deadline: "API_DEADLINE",
      "non-retryable": "API_FAILURE",
    };
    super(codes[api.kind], api.originalMessage, { ...api }, cause);
  }
}

export class DeadlineExceededError extends GQueryV2Error {
  public constructor(deadlineMs: number, nowMs: number, cause?: unknown) {
    super(
      "DEADLINE_EXCEEDED",
      "The GQuery execution budget was exhausted before another safe attempt could run.",
      { deadlineMs, nowMs },
      cause,
    );
  }
}

export class RetryExhaustedError extends GQueryV2Error {
  public constructor(attempts: number, lastFailure: ApiFailure) {
    super(
      "RETRY_EXHAUSTED",
      `The API operation still failed after ${attempts} attempt${attempts === 1 ? "" : "s"}.`,
      { attempts, lastFailure: lastFailure.api },
      lastFailure,
    );
  }
}

export class AmbiguousCommitError extends GQueryV2Error {
  public constructor(operationKind: string, failure: ApiFailure) {
    super(
      "AMBIGUOUS_COMMIT",
      `The ${operationKind} operation may have committed and cannot be retried without idempotency protection.`,
      { operationKind, failure: failure.api },
      failure,
    );
  }
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = recordOf(error);
  return typeof record?.message === "string" ? record.message : String(error);
}

function statusOf(error: unknown, message: string): number | undefined {
  const record = recordOf(error);
  const response = recordOf(record?.response);
  const direct =
    readNumber(record?.statusCode) ??
    readNumber(record?.status) ??
    readNumber(record?.code) ??
    readNumber(response?.statusCode) ??
    readNumber(response?.status);
  if (direct !== undefined) return direct;
  const match = message.match(/(?:^|\D)(4(?:08|29)|5\d\d)(?:\D|$)/);
  return match ? Number(match[1]) : undefined;
}

function retryAfterOf(error: unknown): number | undefined {
  const record = recordOf(error);
  const directMs = readNumber(record?.retryAfterMs);
  if (directMs !== undefined) return Math.max(0, directMs);

  const headers = recordOf(record?.headers);
  const seconds =
    readNumber(record?.retryAfter) ??
    readNumber(headers?.["Retry-After"]) ??
    readNumber(headers?.["retry-after"]);
  return seconds === undefined ? undefined : Math.max(0, seconds * 1000);
}

/** Convert the loose errors emitted by Apps Script advanced services into a stable API error. */
export function normalizeApiFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;

  const originalMessage = messageOf(error);
  const normalized = originalMessage.toLowerCase();
  const statusCode = statusOf(error, originalMessage);
  const retryAfterMs = retryAfterOf(error);
  let kind: ApiFailureKind = "non-retryable";

  if (
    statusCode === 429 ||
    normalized.includes("quota exceeded") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("service invoked too many times") ||
    normalized.includes("service using too much computer time") ||
    normalized.includes("resource_exhausted")
  ) {
    kind = "rate-limit";
  } else if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    kind = "server";
  } else if (
    statusCode === 408 ||
    normalized.includes("deadline exceeded") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout")
  ) {
    kind = "deadline";
  } else if (
    normalized.includes("network") ||
    normalized.includes("connection reset") ||
    normalized.includes("connection aborted") ||
    normalized.includes("temporarily unavailable")
  ) {
    kind = "network";
  }

  return new ApiFailure(
    {
      kind,
      statusCode,
      retryAfterMs,
      retryable: kind !== "non-retryable",
      originalMessage,
    },
    error,
  );
}
