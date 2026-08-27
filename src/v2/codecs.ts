import { GQueryCodecError, GQueryDefinitionError } from "./errors";

/** Internal representation of a physically blank cell. */
export const BLANK_CELL: unique symbol = Symbol("gquery.blank-cell");
export type BlankCell = typeof BLANK_CELL;

/**
 * Internal typed cell used by the high-level formula codec. The marker is
 * deliberately an object so a normal text value such as `"=SUM(A1:A3)"`
 * can never be mistaken for a formula by the transport.
 */
export interface FormulaCell {
  readonly __gqueryFormulaCell: true;
  readonly expression: string;
}

export type EncodedCell = string | number | boolean | BlankCell | FormulaCell;

export const LEGACY_NO_MATCH: unique symbol = Symbol("gquery.legacy-no-match");
export type LegacyNoMatch = typeof LEGACY_NO_MATCH;

export interface CodecContext {
  readonly table?: string;
  readonly column?: string;
  readonly header?: string;
  readonly rowNumber?: number;
}

export interface ColumnCodec<T> {
  readonly kind: string;
  encode(value: T, context?: CodecContext): EncodedCell;
  decode(value: unknown, context?: CodecContext): T;
}

export type LegacyDecoder<T> = (
  value: unknown,
  context: CodecContext,
) => T | LegacyNoMatch;

export type CellFormat = Readonly<Record<string, unknown>>;

export interface ColumnDefinition<T> extends ColumnCodec<T> {
  readonly __gqueryColumn: true;
  /** Compile-time-only carrier used for row inference. */
  readonly __valueType?: T;
  readonly codec: ColumnCodec<T>;
  readonly header?: string;
  readonly format?: CellFormat;
  readonly legacyDecoders: readonly LegacyDecoder<T>[];
  readonly blankPolicy: "reject" | "null" | "undefined" | "default";
  readonly acceptsNull: boolean;
}

export type InferColumn<C> = C extends {
  readonly __gqueryColumn: true;
  readonly __valueType?: infer T;
}
  ? T
  : never;

export interface BaseColumnOptions<T> {
  readonly header?: string;
  readonly format?: CellFormat;
  readonly legacyDecoders?: readonly LegacyDecoder<T>[];
}

export interface TextColumnOptions extends BaseColumnOptions<string> {
  readonly trim?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
}

export interface NumberColumnOptions extends BaseColumnOptions<number> {
  readonly min?: number;
  readonly max?: number;
}

export interface IntegerColumnOptions extends NumberColumnOptions {
  readonly safe?: boolean;
}

export interface DecimalColumnOptions extends BaseColumnOptions<string> {
  readonly scale?: number;
  readonly maxDigits?: number;
}

export interface BooleanColumnOptions extends BaseColumnOptions<boolean> {}

export interface DateColumnOptions extends BaseColumnOptions<Date> {}

export interface FormulaColumnOptions extends BaseColumnOptions<string> {
  /** Safety limit below Sheets' 50,000-character cell boundary. */
  readonly maxChars?: number;
}

export interface JsonColumnOptions<T extends JsonValue>
  extends BaseColumnOptions<T> {
  readonly formatVersion?: number;
  readonly maxChars?: number;
  readonly maxDepth?: number;
}

export interface StructuredColumnOptions<T> extends BaseColumnOptions<T> {
  readonly formatVersion?: number;
  readonly maxChars?: number;
  readonly maxDepth?: number;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type ColumnOptionsFor<T> = BaseColumnOptions<T>;

const DEFAULT_MAX_CELL_CHARS = 48_000;
const DEFAULT_MAX_DEPTH = 64;

function isBlank(value: unknown): value is BlankCell | undefined {
  return value === BLANK_CELL || value === undefined;
}

function describeValue(value: unknown): string {
  if (value === BLANK_CELL) return "a blank cell";
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Date) return "a Date";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

export function isFormulaCell(value: unknown): value is FormulaCell {
  return typeof value === "object" && value !== null &&
    (value as { __gqueryFormulaCell?: unknown }).__gqueryFormulaCell === true &&
    typeof (value as { expression?: unknown }).expression === "string";
}

function codecError(
  kind: string,
  direction: "encode" | "decode",
  code:
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
    | "JSON_TOO_LARGE",
  message: string,
  context: CodecContext = {},
  cause?: unknown,
): GQueryCodecError {
  return new GQueryCodecError(code, message, {
    codec: kind,
    direction,
    cause,
    details: { ...context },
  });
}

function assertDefinitionOptions(
  kind: string,
  options: BaseColumnOptions<unknown>,
): void {
  if (options.header !== undefined && options.header.trim().length === 0) {
    throw new GQueryDefinitionError(`${kind} column header must not be empty.`);
  }
  if (
    options.legacyDecoders !== undefined &&
    options.legacyDecoders.some((decoder) => typeof decoder !== "function")
  ) {
    throw new GQueryDefinitionError(
      `${kind} legacyDecoders must contain only functions.`,
    );
  }
}

function freezeDefinition<T>(
  codec: ColumnCodec<T>,
  options: ColumnOptionsFor<T>,
  blankPolicy: ColumnDefinition<T>["blankPolicy"] = "reject",
  tryLegacyDecoders = true,
  acceptsNull = false,
): ColumnDefinition<T> {
  assertDefinitionOptions(codec.kind, options as BaseColumnOptions<unknown>);
  const legacyDecoders = Object.freeze([...(options.legacyDecoders ?? [])]);

  const definition: ColumnDefinition<T> = {
    __gqueryColumn: true,
    kind: codec.kind,
    codec,
    header: options.header,
    format: options.format === undefined
      ? undefined
      : Object.freeze({ ...options.format }),
    legacyDecoders,
    blankPolicy,
    acceptsNull,
    encode(value: T, context: CodecContext = {}): EncodedCell {
      if (isBlank(value) && blankPolicy !== "undefined") {
        throw codecError(
          codec.kind,
          "encode",
          "CODEC_BLANK",
          `${codec.kind} cannot encode a missing value. Configure an explicit blank policy.`,
          context,
        );
      }
      if (value === null && !acceptsNull) {
        throw codecError(
          codec.kind,
          "encode",
          "CODEC_NULL",
          `${codec.kind} cannot encode null. Wrap the column with nullable().`,
          context,
        );
      }
      try {
        return codec.encode(value, context);
      } catch (error) {
        if (error instanceof GQueryCodecError) throw error;
        throw codecError(
          codec.kind,
          "encode",
          "CODEC_ENCODE_FAILED",
          `${codec.kind} failed to encode a value.`,
          context,
          error,
        );
      }
    },
    decode(value: unknown, context: CodecContext = {}): T {
      if (isBlank(value) && blankPolicy === "reject") {
        throw codecError(
          codec.kind,
          "decode",
          "CODEC_BLANK",
          `${codec.kind} cannot decode a blank cell. Configure an explicit blank policy.`,
          context,
        );
      }
      if (value === null && !acceptsNull) {
        throw codecError(
          codec.kind,
          "decode",
          "CODEC_NULL",
          `${codec.kind} cannot decode null. Wrap the column with nullable().`,
          context,
        );
      }
      try {
        return codec.decode(value, context);
      } catch (canonicalError) {
        if (canonicalError instanceof GQueryCodecError) {
          for (const decoder of tryLegacyDecoders ? legacyDecoders : []) {
            try {
              const decoded = decoder(value, context);
              if (decoded !== LEGACY_NO_MATCH) return decoded;
            } catch (legacyError) {
              throw codecError(
                codec.kind,
                "decode",
                "CODEC_DECODE_FAILED",
                `${codec.kind} legacy decoder failed.`,
                context,
                legacyError,
              );
            }
          }
          throw canonicalError;
        }
        throw codecError(
          codec.kind,
          "decode",
          "CODEC_DECODE_FAILED",
          `${codec.kind} failed to decode a value.`,
          context,
          canonicalError,
        );
      }
    },
  };

  return Object.freeze(definition);
}

function cloneOptions<T>(column: ColumnDefinition<T>): BaseColumnOptions<T> {
  return {
    header: column.header,
    format: column.format,
    legacyDecoders: column.legacyDecoders,
  };
}

function valueTypeCodec<T>(
  kind: string,
  expectedType: "string" | "number" | "boolean",
  validate?: (
    value: T,
    direction: "encode" | "decode",
    context: CodecContext,
  ) => void,
): ColumnCodec<T> {
  const convert = (
    value: unknown,
    direction: "encode" | "decode",
    context: CodecContext,
  ): T => {
    if (typeof value !== expectedType) {
      throw codecError(
        kind,
        direction,
        "CODEC_TYPE",
        `${kind} expected ${expectedType}; received ${describeValue(value)}.`,
        context,
      );
    }
    validate?.(value as T, direction, context);
    return value as T;
  };

  return Object.freeze({
    kind,
    encode(value: T, context: CodecContext = {}): EncodedCell {
      return convert(value, "encode", context) as EncodedCell;
    },
    decode(value: unknown, context: CodecContext = {}): T {
      return convert(value, "decode", context);
    },
  });
}

export function text(options: TextColumnOptions = {}): ColumnDefinition<string> {
  const {
    trim = false,
    minLength,
    maxLength,
    pattern,
  } = options;
  if (minLength !== undefined && (!Number.isInteger(minLength) || minLength < 0)) {
    throw new GQueryDefinitionError("text minLength must be a non-negative integer.");
  }
  if (maxLength !== undefined && (!Number.isInteger(maxLength) || maxLength < 0)) {
    throw new GQueryDefinitionError("text maxLength must be a non-negative integer.");
  }
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw new GQueryDefinitionError("text minLength must not exceed maxLength.");
  }

  const transform = (
    value: unknown,
    direction: "encode" | "decode",
    context: CodecContext,
  ): string => {
    if (typeof value !== "string") {
      throw codecError(
        "text",
        direction,
        "CODEC_TYPE",
        `text expected string; received ${describeValue(value)}.`,
        context,
      );
    }
    const result = trim ? value.trim() : value;
    if (minLength !== undefined && result.length < minLength) {
      throw codecError(
        "text",
        direction,
        "CODEC_CONSTRAINT",
        `text must contain at least ${minLength} characters.`,
        context,
      );
    }
    if (maxLength !== undefined && result.length > maxLength) {
      throw codecError(
        "text",
        direction,
        "CODEC_CONSTRAINT",
        `text must contain no more than ${maxLength} characters.`,
        context,
      );
    }
    if (pattern !== undefined) {
      pattern.lastIndex = 0;
      const matches = pattern.test(result);
      pattern.lastIndex = 0;
      if (!matches) {
        throw codecError(
          "text",
          direction,
          "CODEC_CONSTRAINT",
          `text does not match ${pattern.toString()}.`,
          context,
        );
      }
    }
    return result;
  };
  const codec: ColumnCodec<string> = Object.freeze({
    kind: "text",
    encode: (value: string, context: CodecContext = {}) => transform(value, "encode", context),
    decode: (value: unknown, context: CodecContext = {}) => transform(value, "decode", context),
  });
  return freezeDefinition(codec, options);
}

/**
 * Declares a column whose canonical value is a Sheets formula expression.
 * Formula intent comes from the schema, never from inspecting an arbitrary
 * string during transport encoding.
 */
export function formula(
  options: FormulaColumnOptions = {},
): ColumnDefinition<string> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CELL_CHARS;
  if (!Number.isSafeInteger(maxChars) || maxChars < 2 || maxChars >= 50_000) {
    throw new GQueryDefinitionError(
      "formula maxChars must be a safe integer from 2 through 49,999.",
    );
  }
  const validate = (
    value: unknown,
    direction: "encode" | "decode",
    context: CodecContext,
  ): string => {
    if (typeof value !== "string") {
      throw codecError(
        "formula",
        direction,
        "CODEC_TYPE",
        `formula expected a string, received ${describeValue(value)}.`,
        context,
      );
    }
    if (!value.startsWith("=") || value.length < 2) {
      throw codecError(
        "formula",
        direction,
        "CODEC_CONSTRAINT",
        "formula expressions must begin with '=' and contain an expression.",
        context,
      );
    }
    if (value.length > maxChars) {
      throw codecError(
        "formula",
        direction,
        "CODEC_CONSTRAINT",
        `formula contains ${value.length} characters; maximum is ${maxChars}.`,
        context,
      );
    }
    return value;
  };
  const codec: ColumnCodec<string> = Object.freeze({
    kind: "formula",
    encode(value: string, context: CodecContext = {}) {
      return Object.freeze({
        __gqueryFormulaCell: true as const,
        expression: validate(value, "encode", context),
      });
    },
    decode(value: unknown, context: CodecContext = {}) {
      return validate(value, "decode", context);
    },
  });
  return freezeDefinition(codec, options);
}

export function identifier(
  options: Omit<TextColumnOptions, "trim" | "minLength"> = {},
): ColumnDefinition<string> {
  const base = text({ ...options, trim: false, minLength: 1 });
  const codec: ColumnCodec<string> = Object.freeze({
    kind: "identifier",
    encode: (value: string, context: CodecContext = {}) => base.encode(value, context),
    decode: (value: unknown, context: CodecContext = {}) => base.decode(value, context),
  });
  return freezeDefinition(codec, options);
}

function validateBounds(
  kind: string,
  min: number | undefined,
  max: number | undefined,
): void {
  if (min !== undefined && !Number.isFinite(min)) {
    throw new GQueryDefinitionError(`${kind} min must be finite.`);
  }
  if (max !== undefined && !Number.isFinite(max)) {
    throw new GQueryDefinitionError(`${kind} max must be finite.`);
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new GQueryDefinitionError(`${kind} min must not exceed max.`);
  }
}

export function number(options: NumberColumnOptions = {}): ColumnDefinition<number> {
  validateBounds("number", options.min, options.max);
  const codec = valueTypeCodec<number>("number", "number", (value, direction, context) => {
    if (!Number.isFinite(value)) {
      throw codecError(
        "number",
        direction,
        "CODEC_CONSTRAINT",
        "number must be finite.",
        context,
      );
    }
    if (options.min !== undefined && value < options.min) {
      throw codecError("number", direction, "CODEC_CONSTRAINT", `number must be at least ${options.min}.`, context);
    }
    if (options.max !== undefined && value > options.max) {
      throw codecError("number", direction, "CODEC_CONSTRAINT", `number must be at most ${options.max}.`, context);
    }
  });
  return freezeDefinition(codec, options);
}

export function integer(options: IntegerColumnOptions = {}): ColumnDefinition<number> {
  validateBounds("integer", options.min, options.max);
  const safe = options.safe ?? true;
  const codec = valueTypeCodec<number>("integer", "number", (value, direction, context) => {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw codecError("integer", direction, "CODEC_CONSTRAINT", "integer must be a finite whole number.", context);
    }
    if (safe && !Number.isSafeInteger(value)) {
      throw codecError("integer", direction, "CODEC_CONSTRAINT", "integer must be within JavaScript's safe integer range.", context);
    }
    if (options.min !== undefined && value < options.min) {
      throw codecError("integer", direction, "CODEC_CONSTRAINT", `integer must be at least ${options.min}.`, context);
    }
    if (options.max !== undefined && value > options.max) {
      throw codecError("integer", direction, "CODEC_CONSTRAINT", `integer must be at most ${options.max}.`, context);
    }
  });
  return freezeDefinition(codec, options);
}

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function normalizeDecimal(
  value: unknown,
  options: DecimalColumnOptions,
  direction: "encode" | "decode",
  context: CodecContext,
): string {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw codecError(
      "decimal",
      direction,
      "CODEC_TYPE",
      "decimal requires a base-10 string without exponent notation.",
      context,
    );
  }
  let sign = "";
  let unsigned = value;
  if (unsigned.startsWith("+") || unsigned.startsWith("-")) {
    sign = unsigned[0] === "-" ? "-" : "";
    unsigned = unsigned.slice(1);
  }
  let [whole = "0", fraction = ""] = unsigned.split(".");
  if (whole.length === 0) whole = "0";
  whole = whole.replace(/^0+(?=\d)/, "");

  if (options.scale !== undefined) {
    if (fraction.length > options.scale) {
      throw codecError(
        "decimal",
        direction,
        "CODEC_CONSTRAINT",
        `decimal supports at most ${options.scale} fractional digits.`,
        context,
      );
    }
    fraction = fraction.padEnd(options.scale, "0");
  } else {
    fraction = fraction.replace(/0+$/, "");
  }

  const digitCount = `${whole}${fraction}`.replace(/^0+/, "").length || 1;
  if (options.maxDigits !== undefined && digitCount > options.maxDigits) {
    throw codecError(
      "decimal",
      direction,
      "CODEC_CONSTRAINT",
      `decimal supports at most ${options.maxDigits} significant storage digits.`,
      context,
    );
  }
  const isZero = /^0+$/.test(`${whole}${fraction}`);
  return `${isZero ? "" : sign}${whole}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

export function decimal(options: DecimalColumnOptions = {}): ColumnDefinition<string> {
  if (options.scale !== undefined && (!Number.isInteger(options.scale) || options.scale < 0)) {
    throw new GQueryDefinitionError("decimal scale must be a non-negative integer.");
  }
  if (options.maxDigits !== undefined && (!Number.isInteger(options.maxDigits) || options.maxDigits < 1)) {
    throw new GQueryDefinitionError("decimal maxDigits must be a positive integer.");
  }
  const codec: ColumnCodec<string> = Object.freeze({
    kind: "decimal",
    encode: (value: string, context: CodecContext = {}) => normalizeDecimal(value, options, "encode", context),
    decode: (value: unknown, context: CodecContext = {}) => normalizeDecimal(value, options, "decode", context),
  });
  return freezeDefinition(codec, options);
}

export function booleanColumn(
  options: BooleanColumnOptions = {},
): ColumnDefinition<boolean> {
  return freezeDefinition(valueTypeCodec<boolean>("boolean", "boolean"), options);
}

export { booleanColumn as boolean };

export type EnumCellValue = string | number | boolean;

export interface EnumerationColumnOptions<
  Values extends readonly [EnumCellValue, ...EnumCellValue[]],
> extends BaseColumnOptions<Values[number]> {
  readonly values: Values;
}

export function enumeration<
  const Values extends readonly [EnumCellValue, ...EnumCellValue[]],
>(options: EnumerationColumnOptions<Values>): ColumnDefinition<Values[number]> {
  const values = Object.freeze([...options.values]) as unknown as Values;
  if (new Set<EnumCellValue>(values).size !== values.length) {
    throw new GQueryDefinitionError("enumeration values must be unique.");
  }
  const codec: ColumnCodec<Values[number]> = Object.freeze({
    kind: "enum",
    encode(value: Values[number], context: CodecContext = {}) {
      if (!values.some((candidate) => Object.is(candidate, value))) {
        throw codecError("enum", "encode", "CODEC_CONSTRAINT", "Value is not a member of the enumeration.", context);
      }
      return value;
    },
    decode(value: unknown, context: CodecContext = {}) {
      const matched = values.find((candidate) => Object.is(candidate, value));
      if (matched === undefined) {
        throw codecError("enum", "decode", "CODEC_CONSTRAINT", "Cell value is not a member of the enumeration.", context);
      }
      return matched;
    },
  });
  return freezeDefinition(codec, options);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function parseCanonicalDate(
  value: unknown,
  kind: "date" | "datetime",
  direction: "encode" | "decode",
  context: CodecContext,
): Date {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw codecError(kind, direction, "CODEC_CONSTRAINT", `${kind} must be valid.`, context);
    }
    const cloned = new Date(value.getTime());
    if (
      kind === "date" &&
      (cloned.getUTCHours() !== 0 ||
        cloned.getUTCMinutes() !== 0 ||
        cloned.getUTCSeconds() !== 0 ||
        cloned.getUTCMilliseconds() !== 0)
    ) {
      throw codecError(kind, direction, "CODEC_CONSTRAINT", "date must represent midnight UTC.", context);
    }
    return cloned;
  }
  if (typeof value !== "string") {
    throw codecError(kind, direction, "CODEC_TYPE", `${kind} expected a Date or canonical ISO string.`, context);
  }
  const pattern = kind === "date" ? DATE_PATTERN : DATETIME_PATTERN;
  if (!pattern.test(value)) {
    throw codecError(kind, direction, "CODEC_CONSTRAINT", `${kind} must use canonical UTC ISO format.`, context);
  }
  const parsed = new Date(kind === "date" ? `${value}T00:00:00.000Z` : value);
  const canonical = kind === "date"
    ? parsed.toISOString().slice(0, 10)
    : parsed.toISOString();
  if (!Number.isFinite(parsed.getTime()) || canonical !== value) {
    throw codecError(kind, direction, "CODEC_CONSTRAINT", `${kind} is not a valid calendar value.`, context);
  }
  return parsed;
}

export function date(options: DateColumnOptions = {}): ColumnDefinition<Date> {
  const codec: ColumnCodec<Date> = Object.freeze({
    kind: "date",
    encode(value: Date, context: CodecContext = {}) {
      return parseCanonicalDate(value, "date", "encode", context).toISOString().slice(0, 10);
    },
    decode(value: unknown, context: CodecContext = {}) {
      return parseCanonicalDate(value, "date", "decode", context);
    },
  });
  return freezeDefinition(codec, options);
}

export function datetime(options: DateColumnOptions = {}): ColumnDefinition<Date> {
  const codec: ColumnCodec<Date> = Object.freeze({
    kind: "datetime",
    encode(value: Date, context: CodecContext = {}) {
      return parseCanonicalDate(value, "datetime", "encode", context).toISOString();
    },
    decode(value: unknown, context: CodecContext = {}) {
      return parseCanonicalDate(value, "datetime", "decode", context);
    },
  });
  return freezeDefinition(codec, options);
}

function assertSerializationOptions(
  kind: "json" | "structured",
  maxChars: number,
  maxDepth: number,
  formatVersion: number,
): void {
  if (!Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new GQueryDefinitionError(`${kind} formatVersion must be a positive integer.`);
  }
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars >= 50_000) {
    throw new GQueryDefinitionError(`${kind} maxChars must be an integer between 1 and 49,999.`);
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new GQueryDefinitionError(`${kind} maxDepth must be a positive integer.`);
  }
}

function assertSize(
  kind: "json" | "structured",
  value: string,
  maxChars: number,
  direction: "encode" | "decode",
  context: CodecContext,
): void {
  if (value.length > maxChars) {
    throw codecError(
      kind,
      direction,
      kind === "json" ? "JSON_TOO_LARGE" : "STRUCTURED_TOO_LARGE",
      `${kind} encoded value contains ${value.length} characters; maximum is ${maxChars}.`,
      context,
    );
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJsonValue(
  value: unknown,
  kind: "json" | "structured",
  context: CodecContext,
  stack: Set<object>,
  depth: number,
  maxDepth: number,
): JsonValue {
  if (depth > maxDepth) {
    throw codecError(kind, "encode", "STRUCTURED_TOO_DEEP", `${kind} exceeds maximum depth ${maxDepth}.`, context);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw codecError(kind, "encode", "STRUCTURED_UNSUPPORTED", `${kind} does not support non-finite numbers.`, context);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw codecError(kind, "encode", "STRUCTURED_UNSUPPORTED", `${kind} does not support ${typeof value} values.`, context);
  }
  if (stack.has(value)) {
    throw codecError(kind, "encode", "STRUCTURED_CYCLE", `${kind} does not support circular references.`, context);
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw codecError(kind, "encode", "STRUCTURED_UNSUPPORTED", `${kind} supports only JSON objects and arrays.`, context);
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw codecError(kind, "encode", "STRUCTURED_UNSUPPORTED", `${kind} does not support sparse arrays.`, context);
        }
        output.push(canonicalJsonValue(value[index], kind, context, stack, depth + 1, maxDepth));
      }
      return output;
    }
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(output, key, {
        value: canonicalJsonValue(value[key], kind, context, stack, depth + 1, maxDepth),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } finally {
    stack.delete(value);
  }
}

function validateParsedJson(
  value: unknown,
  context: CodecContext,
  depth: number,
  maxDepth: number,
): JsonValue {
  if (depth > maxDepth) {
    throw codecError("json", "decode", "STRUCTURED_TOO_DEEP", `json exceeds maximum depth ${maxDepth}.`, context);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => validateParsedJson(entry, context, depth + 1, maxDepth));
  if (typeof value === "object" && value !== null && isPlainObject(value)) {
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(output, key, {
        value: validateParsedJson((value as Record<string, unknown>)[key], context, depth + 1, maxDepth),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  }
  throw codecError("json", "decode", "JSON_INVALID", "json cell contains an unsupported value.", context);
}

export function json<T extends JsonValue = JsonValue>(
  options: JsonColumnOptions<T> = {},
): ColumnDefinition<T> {
  const formatVersion = options.formatVersion ?? 1;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CELL_CHARS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  assertSerializationOptions("json", maxChars, maxDepth, formatVersion);
  const prefix = `gq:json:v${formatVersion}:`;
  const codec: ColumnCodec<T> = Object.freeze({
    kind: "json",
    encode(value: T, context: CodecContext = {}) {
      const canonical = canonicalJsonValue(value, "json", context, new Set<object>(), 0, maxDepth);
      const encoded = `${prefix}${JSON.stringify(canonical)}`;
      assertSize("json", encoded, maxChars, "encode", context);
      return encoded;
    },
    decode(value: unknown, context: CodecContext = {}) {
      if (typeof value !== "string") {
        throw codecError("json", "decode", "CODEC_TYPE", "json expected an encoded string.", context);
      }
      assertSize("json", value, maxChars, "decode", context);
      if (!value.startsWith(prefix)) {
        throw codecError("json", "decode", "JSON_INVALID", `json expected format version ${formatVersion}.`, context);
      }
      try {
        return validateParsedJson(JSON.parse(value.slice(prefix.length)), context, 0, maxDepth) as T;
      } catch (error) {
        if (error instanceof GQueryCodecError) throw error;
        throw codecError("json", "decode", "JSON_INVALID", "json cell contains invalid JSON.", context, error);
      }
    },
  });
  return freezeDefinition(codec, options);
}

type StructuredTag =
  | readonly ["date", string]
  | readonly ["bigint", string]
  | readonly ["array", readonly StructuredNode[]]
  | readonly ["object", readonly (readonly [string, StructuredNode])[]];

type StructuredNode = JsonPrimitive | { readonly $gq: StructuredTag };

function encodeStructuredNode(
  value: unknown,
  context: CodecContext,
  stack: Set<object>,
  depth: number,
  maxDepth: number,
): StructuredNode {
  if (depth > maxDepth) {
    throw codecError("structured", "encode", "STRUCTURED_TOO_DEEP", `structured value exceeds maximum depth ${maxDepth}.`, context);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw codecError("structured", "encode", "STRUCTURED_UNSUPPORTED", "structured does not support non-finite numbers.", context);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") return { $gq: ["bigint", value.toString()] };
  if (typeof value !== "object") {
    throw codecError("structured", "encode", "STRUCTURED_UNSUPPORTED", `structured does not support ${typeof value} values.`, context);
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw codecError("structured", "encode", "STRUCTURED_UNSUPPORTED", "structured does not support invalid dates.", context);
    }
    return { $gq: ["date", value.toISOString()] };
  }
  if (stack.has(value)) {
    throw codecError("structured", "encode", "STRUCTURED_CYCLE", "structured does not support circular references.", context);
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw codecError("structured", "encode", "STRUCTURED_UNSUPPORTED", "structured supports only plain objects, arrays, Date, and BigInt.", context);
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: StructuredNode[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw codecError("structured", "encode", "STRUCTURED_UNSUPPORTED", "structured does not support sparse arrays.", context);
        }
        entries.push(encodeStructuredNode(value[index], context, stack, depth + 1, maxDepth));
      }
      return { $gq: ["array", entries] };
    }
    const entries: [string, StructuredNode][] = [];
    for (const key of Object.keys(value).sort()) {
      entries.push([key, encodeStructuredNode(value[key], context, stack, depth + 1, maxDepth)]);
    }
    return { $gq: ["object", entries] };
  } finally {
    stack.delete(value);
  }
}

function decodeStructuredNode(
  node: unknown,
  context: CodecContext,
  depth: number,
  maxDepth: number,
): unknown {
  if (depth > maxDepth) {
    throw codecError("structured", "decode", "STRUCTURED_TOO_DEEP", `structured value exceeds maximum depth ${maxDepth}.`, context);
  }
  if (node === null || typeof node === "string" || typeof node === "boolean") return node;
  if (typeof node === "number" && Number.isFinite(node)) return node;
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw codecError("structured", "decode", "STRUCTURED_INVALID", "structured cell contains an invalid node.", context);
  }
  const keys = Object.keys(node);
  const tag = (node as { $gq?: unknown }).$gq;
  if (keys.length !== 1 || keys[0] !== "$gq" || !Array.isArray(tag) || typeof tag[0] !== "string") {
    throw codecError("structured", "decode", "STRUCTURED_INVALID", "structured cell contains an invalid tag.", context);
  }
  if (tag[0] === "date") {
    if (tag.length !== 2 || typeof tag[1] !== "string" || !DATETIME_PATTERN.test(tag[1])) {
      throw codecError("structured", "decode", "STRUCTURED_INVALID", "structured cell contains an invalid Date tag.", context);
    }
    const parsed = new Date(tag[1]);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== tag[1]) {
      throw codecError("structured", "decode", "STRUCTURED_INVALID", "structured cell contains an invalid Date value.", context);
    }
    return parsed;
  }
  if (tag[0] === "bigint") {
    if (tag.length !== 2 || typeof tag[1] !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(tag[1])) {
      throw codecError("structured", "decode", "STRUCTURED_INVALID", "structured cell contains an invalid BigInt tag.", context);
    }
    return BigInt(tag[1]);
  }
  if (tag[0] === "array") {
    if (tag.length !== 2 || !Array.isArray(tag[1])) {
      throw codecError("structured", "decode", "STRUCTURED_INVALID", "structured cell contains an invalid array tag.", context);
    }
    return tag[1].map((entry) => decodeStructuredNode(entry, context, depth + 1, maxDepth));
  }
  if (tag[0] === "object") {
    if (tag.length !== 2 || !Array.isArray(tag[1])) {
      throw codecError("structured", "decode", "STRUCTURED_INVALID", "structured cell contains an invalid object tag.", context);
    }
    const output: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const entry of tag[1]) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || seen.has(entry[0])) {
        throw codecError("structured", "decode", "STRUCTURED_INVALID", "structured cell contains an invalid object entry.", context);
      }
      seen.add(entry[0]);
      Object.defineProperty(output, entry[0], {
        value: decodeStructuredNode(entry[1], context, depth + 1, maxDepth),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  }
  throw codecError("structured", "decode", "STRUCTURED_INVALID", `structured cell contains unknown tag ${tag[0]}.`, context);
}

export function structured<T>(
  options: StructuredColumnOptions<T> = {},
): ColumnDefinition<T> {
  const formatVersion = options.formatVersion ?? 1;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CELL_CHARS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  assertSerializationOptions("structured", maxChars, maxDepth, formatVersion);
  const prefix = `gq:structured:v${formatVersion}:`;
  const codec: ColumnCodec<T> = Object.freeze({
    kind: "structured",
    encode(value: T, context: CodecContext = {}) {
      const encoded = `${prefix}${JSON.stringify(encodeStructuredNode(value, context, new Set<object>(), 0, maxDepth))}`;
      assertSize("structured", encoded, maxChars, "encode", context);
      return encoded;
    },
    decode(value: unknown, context: CodecContext = {}) {
      if (typeof value !== "string") {
        throw codecError("structured", "decode", "CODEC_TYPE", "structured expected an encoded string.", context);
      }
      assertSize("structured", value, maxChars, "decode", context);
      const versionPrefix = /^gq:structured:v(\d+):/;
      const versionMatch = versionPrefix.exec(value);
      if (versionMatch === null) {
        throw codecError("structured", "decode", "STRUCTURED_INVALID", "structured cell is missing its format marker.", context);
      }
      if (Number(versionMatch[1]) !== formatVersion) {
        throw codecError("structured", "decode", "STRUCTURED_VERSION", `structured format version ${versionMatch[1]} is not supported; expected ${formatVersion}.`, context);
      }
      try {
        return decodeStructuredNode(JSON.parse(value.slice(prefix.length)), context, 0, maxDepth) as T;
      } catch (error) {
        if (error instanceof GQueryCodecError) throw error;
        throw codecError("structured", "decode", "STRUCTURED_INVALID", "structured cell contains invalid JSON.", context, error);
      }
    },
  });
  return freezeDefinition(codec, options);
}

export function nullable<T>(
  column: ColumnDefinition<T>,
): ColumnDefinition<T | null> {
  const codec: ColumnCodec<T | null> = Object.freeze({
    kind: column.kind,
    encode(value: T | null, context: CodecContext = {}) {
      return value === null ? BLANK_CELL : column.encode(value, context);
    },
    decode(value: unknown, context: CodecContext = {}) {
      return value === null || isBlank(value) ? null : column.decode(value, context);
    },
  });
  return freezeDefinition(
    codec,
    cloneOptions(column) as BaseColumnOptions<T | null>,
    "null",
    false,
    true,
  );
}

export function optional<T>(
  column: ColumnDefinition<T>,
): ColumnDefinition<T | undefined> {
  const codec: ColumnCodec<T | undefined> = Object.freeze({
    kind: column.kind,
    encode(value: T | undefined, context: CodecContext = {}) {
      return value === undefined ? BLANK_CELL : column.encode(value, context);
    },
    decode(value: unknown, context: CodecContext = {}) {
      return isBlank(value) ? undefined : column.decode(value, context);
    },
  });
  return freezeDefinition(
    codec,
    cloneOptions(column) as BaseColumnOptions<T | undefined>,
    "undefined",
    false,
    column.acceptsNull,
  );
}

export function withDefault<T>(
  column: ColumnDefinition<T>,
  defaultValue: T | (() => T),
): ColumnDefinition<T> {
  const resolveDefault = (): T =>
    typeof defaultValue === "function"
      ? (defaultValue as () => T)()
      : defaultValue;
  const codec: ColumnCodec<T> = Object.freeze({
    kind: column.kind,
    encode(value: T, context: CodecContext = {}) {
      return column.encode(value, context);
    },
    decode(value: unknown, context: CodecContext = {}) {
      return isBlank(value) ? resolveDefault() : column.decode(value, context);
    },
  });
  return freezeDefinition(
    codec,
    cloneOptions(column),
    "default",
    false,
    column.acceptsNull,
  );
}

export type BlankPolicy = "reject" | "null" | "undefined";
export type BlankPolicyOutput<T, P extends BlankPolicy> = P extends "null"
  ? T | null
  : P extends "undefined"
    ? T | undefined
    : T;

export function withBlankPolicy<T, const P extends BlankPolicy>(
  column: ColumnDefinition<T>,
  policy: P,
): ColumnDefinition<BlankPolicyOutput<T, P>> {
  if (policy === "null") {
    return nullable(column) as ColumnDefinition<BlankPolicyOutput<T, P>>;
  }
  if (policy === "undefined") {
    return optional(column) as ColumnDefinition<BlankPolicyOutput<T, P>>;
  }
  return column as ColumnDefinition<BlankPolicyOutput<T, P>>;
}

export function isColumnDefinition(value: unknown): value is ColumnDefinition<unknown> {
  return typeof value === "object" && value !== null &&
    (value as { __gqueryColumn?: unknown }).__gqueryColumn === true;
}
