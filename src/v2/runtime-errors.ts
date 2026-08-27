export type RuntimeErrorCode =
  | "SOURCE_UNAVAILABLE"
  | "SHEET_NOT_FOUND"
  | "MISSING_HEADER"
  | "DUPLICATE_HEADER"
  | "SCHEMA_CHANGED"
  | "DUPLICATE_KEY"
  | "RELATION_CARDINALITY"
  | "RELATION_NOT_FOUND"
  | "RELATION_RESTRICT"
  | "INVALID_QUERY"
  | "NOT_FOUND"
  | "EXPECTED_ONE"
  | "STALE_SELECTION"
  | "MUTATION_CONFLICT"
  | "MUTATION_INVALID"
  | "TRANSACTION_PARTIAL"
  | "MIGRATION_REQUIRED"
  | "BACKUP_REQUIRED"
  | "UNSUPPORTED_OPERATION";

export interface RuntimeErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** Structured failures raised by the schema/query/execution layers. */
export class GQueryRuntimeError extends Error {
  public readonly code: RuntimeErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;
  public override readonly cause?: unknown;

  public constructor(
    code: RuntimeErrorCode,
    message: string,
    options: RuntimeErrorOptions = {},
  ) {
    super(message);
    this.name = "GQueryRuntimeError";
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
