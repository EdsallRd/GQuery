export type GQueryErrorCode =
  | "DEFINITION_INVALID"
  | "CODEC_ENCODE_FAILED"
  | "CODEC_DECODE_FAILED"
  | "CODEC_BLANK"
  | "CODEC_NULL"
  | "CODEC_TYPE"
  | "CODEC_CONSTRAINT"
  | "STRUCTURED_CYCLE"
  | "STRUCTURED_UNSUPPORTED"
  | "STRUCTURED_TOO_DEEP"
  | "STRUCTURED_TOO_LARGE"
  | "STRUCTURED_INVALID"
  | "STRUCTURED_VERSION"
  | "JSON_INVALID"
  | "JSON_TOO_LARGE";

export interface GQueryErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Base class for errors callers can safely discriminate without parsing text. */
export class GQueryError extends Error {
  readonly code: GQueryErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;

  constructor(
    code: GQueryErrorCode,
    message: string,
    options: GQueryErrorOptions = {},
  ) {
    super(message);
    this.name = "GQueryError";
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class GQueryDefinitionError extends GQueryError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("DEFINITION_INVALID", message, { details });
    this.name = "GQueryDefinitionError";
  }
}

export type CodecDirection = "encode" | "decode";

export class GQueryCodecError extends GQueryError {
  readonly direction: CodecDirection;
  readonly codec: string;

  constructor(
    code: Exclude<GQueryErrorCode, "DEFINITION_INVALID">,
    message: string,
    options: GQueryErrorOptions & {
      readonly direction: CodecDirection;
      readonly codec: string;
    },
  ) {
    super(code, message, options);
    this.name = "GQueryCodecError";
    this.direction = options.direction;
    this.codec = options.codec;
  }
}
