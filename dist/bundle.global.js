var GQuery = (function (exports) {
    'use strict';

    /** Base class for errors callers can safely discriminate without parsing text. */
    class GQueryError extends Error {
        constructor(code, message, options = {}) {
            var _a;
            super(message);
            this.name = "GQueryError";
            this.code = code;
            this.details = Object.freeze({ ...((_a = options.details) !== null && _a !== void 0 ? _a : {}) });
            this.cause = options.cause;
            Object.setPrototypeOf(this, new.target.prototype);
        }
    }
    class GQueryDefinitionError extends GQueryError {
        constructor(message, details = {}) {
            super("DEFINITION_INVALID", message, { details });
            this.name = "GQueryDefinitionError";
        }
    }
    class GQueryCodecError extends GQueryError {
        constructor(code, message, options) {
            super(code, message, options);
            this.name = "GQueryCodecError";
            this.direction = options.direction;
            this.codec = options.codec;
        }
    }

    /** Internal representation of a physically blank cell. */
    const BLANK_CELL = Symbol("gquery.blank-cell");
    const LEGACY_NO_MATCH = Symbol("gquery.legacy-no-match");
    const DEFAULT_MAX_CELL_CHARS = 48000;
    const DEFAULT_MAX_DEPTH = 64;
    const TEXT_TAG_PREFIX = "gq:text:v1:";
    const EMPTY_TEXT_CELL = `${TEXT_TAG_PREFIX}empty`;
    const ESCAPED_TEXT_PREFIX = `${TEXT_TAG_PREFIX}escaped:`;
    function isBlank(value) {
        return value === BLANK_CELL || value === undefined;
    }
    function describeValue(value) {
        if (value === BLANK_CELL)
            return "a blank cell";
        if (value === null)
            return "null";
        if (value === undefined)
            return "undefined";
        if (value instanceof Date)
            return "a Date";
        if (Array.isArray(value))
            return "an array";
        return typeof value;
    }
    function isFormulaCell(value) {
        return typeof value === "object" && value !== null &&
            value.__gqueryFormulaCell === true &&
            typeof value.expression === "string";
    }
    function codecError(kind, direction, code, message, context = {}, cause) {
        return new GQueryCodecError(code, message, {
            codec: kind,
            direction,
            cause,
            details: { ...context },
        });
    }
    function assertDefinitionOptions(kind, options) {
        if (options.header !== undefined && options.header.trim().length === 0) {
            throw new GQueryDefinitionError(`${kind} column header must not be empty.`);
        }
        if (options.legacyDecoders !== undefined &&
            options.legacyDecoders.some((decoder) => typeof decoder !== "function")) {
            throw new GQueryDefinitionError(`${kind} legacyDecoders must contain only functions.`);
        }
    }
    function freezeDefinition(codec, options, blankPolicy = "reject", tryLegacyDecoders = true, acceptsNull = false) {
        var _a;
        assertDefinitionOptions(codec.kind, options);
        const legacyDecoders = Object.freeze([...((_a = options.legacyDecoders) !== null && _a !== void 0 ? _a : [])]);
        const definition = {
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
            encode(value, context = {}) {
                if (isBlank(value) && blankPolicy !== "undefined") {
                    throw codecError(codec.kind, "encode", "CODEC_BLANK", `${codec.kind} cannot encode a missing value. Configure an explicit blank policy.`, context);
                }
                if (value === null && !acceptsNull) {
                    throw codecError(codec.kind, "encode", "CODEC_NULL", `${codec.kind} cannot encode null. Wrap the column with nullable().`, context);
                }
                try {
                    return codec.encode(value, context);
                }
                catch (error) {
                    if (error instanceof GQueryCodecError)
                        throw error;
                    throw codecError(codec.kind, "encode", "CODEC_ENCODE_FAILED", `${codec.kind} failed to encode a value.`, context, error);
                }
            },
            decode(value, context = {}) {
                if (isBlank(value) && blankPolicy === "reject") {
                    throw codecError(codec.kind, "decode", "CODEC_BLANK", `${codec.kind} cannot decode a blank cell. Configure an explicit blank policy.`, context);
                }
                if (value === null && !acceptsNull) {
                    throw codecError(codec.kind, "decode", "CODEC_NULL", `${codec.kind} cannot decode null. Wrap the column with nullable().`, context);
                }
                try {
                    return codec.decode(value, context);
                }
                catch (canonicalError) {
                    if (canonicalError instanceof GQueryCodecError) {
                        for (const decoder of tryLegacyDecoders && context.allowLegacy !== false ? legacyDecoders : []) {
                            try {
                                const decoded = decoder(value, context);
                                if (decoded !== LEGACY_NO_MATCH)
                                    return decoded;
                            }
                            catch (legacyError) {
                                throw codecError(codec.kind, "decode", "CODEC_DECODE_FAILED", `${codec.kind} legacy decoder failed.`, context, legacyError);
                            }
                        }
                        throw canonicalError;
                    }
                    throw codecError(codec.kind, "decode", "CODEC_DECODE_FAILED", `${codec.kind} failed to decode a value.`, context, canonicalError);
                }
            },
            decodeCanonical(value, context = {}) {
                // `allowLegacy` is set last deliberately so callers cannot override the
                // canonical-only contract. Wrapper codecs propagate the context to each
                // child definition, bypassing legacy decoders at every composition layer.
                return definition.decode(value, { ...context, allowLegacy: false });
            },
        };
        return Object.freeze(definition);
    }
    function cloneOptions(column) {
        return {
            header: column.header,
            format: column.format,
            legacyDecoders: column.legacyDecoders,
        };
    }
    function valueTypeCodec(kind, expectedType, validate) {
        const convert = (value, direction, context) => {
            if (typeof value !== expectedType) {
                throw codecError(kind, direction, "CODEC_TYPE", `${kind} expected ${expectedType}; received ${describeValue(value)}.`, context);
            }
            validate === null || validate === void 0 ? void 0 : validate(value, direction, context);
            return value;
        };
        return Object.freeze({
            kind,
            encode(value, context = {}) {
                return convert(value, "encode", context);
            },
            decode(value, context = {}) {
                return convert(value, "decode", context);
            },
        });
    }
    function text(options = {}) {
        const { trim = false, minLength, maxLength, pattern, } = options;
        if (minLength !== undefined && (!Number.isInteger(minLength) || minLength < 0)) {
            throw new GQueryDefinitionError("text minLength must be a non-negative integer.");
        }
        if (maxLength !== undefined && (!Number.isInteger(maxLength) || maxLength < 0)) {
            throw new GQueryDefinitionError("text maxLength must be a non-negative integer.");
        }
        if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
            throw new GQueryDefinitionError("text minLength must not exceed maxLength.");
        }
        const transform = (value, direction, context) => {
            if (typeof value !== "string") {
                throw codecError("text", direction, "CODEC_TYPE", `text expected string; received ${describeValue(value)}.`, context);
            }
            const result = trim ? value.trim() : value;
            if (minLength !== undefined && result.length < minLength) {
                throw codecError("text", direction, "CODEC_CONSTRAINT", `text must contain at least ${minLength} characters.`, context);
            }
            if (maxLength !== undefined && result.length > maxLength) {
                throw codecError("text", direction, "CODEC_CONSTRAINT", `text must contain no more than ${maxLength} characters.`, context);
            }
            if (pattern !== undefined) {
                pattern.lastIndex = 0;
                const matches = pattern.test(result);
                pattern.lastIndex = 0;
                if (!matches) {
                    throw codecError("text", direction, "CODEC_CONSTRAINT", `text does not match ${pattern.toString()}.`, context);
                }
            }
            return result;
        };
        const codec = Object.freeze({
            kind: "text",
            encode: (value, context = {}) => {
                const encoded = transform(value, "encode", context);
                if (encoded.length === 0)
                    return EMPTY_TEXT_CELL;
                return encoded.startsWith(TEXT_TAG_PREFIX) ? `${ESCAPED_TEXT_PREFIX}${encoded}` : encoded;
            },
            decode: (value, context = {}) => {
                if (value === EMPTY_TEXT_CELL)
                    return transform("", "decode", context);
                if (typeof value === "string" && value.startsWith(ESCAPED_TEXT_PREFIX)) {
                    return transform(value.slice(ESCAPED_TEXT_PREFIX.length), "decode", context);
                }
                return transform(value, "decode", context);
            },
        });
        return freezeDefinition(codec, options);
    }
    /**
     * Declares a column whose canonical value is a Sheets formula expression.
     * Formula intent comes from the schema, never from inspecting an arbitrary
     * string during transport encoding.
     */
    function formula(options = {}) {
        var _a;
        const maxChars = (_a = options.maxChars) !== null && _a !== void 0 ? _a : DEFAULT_MAX_CELL_CHARS;
        if (!Number.isSafeInteger(maxChars) || maxChars < 2 || maxChars >= 50000) {
            throw new GQueryDefinitionError("formula maxChars must be a safe integer from 2 through 49,999.");
        }
        const validate = (value, direction, context) => {
            if (typeof value !== "string") {
                throw codecError("formula", direction, "CODEC_TYPE", `formula expected a string, received ${describeValue(value)}.`, context);
            }
            if (!value.startsWith("=") || value.length < 2) {
                throw codecError("formula", direction, "CODEC_CONSTRAINT", "formula expressions must begin with '=' and contain an expression.", context);
            }
            if (value.length > maxChars) {
                throw codecError("formula", direction, "CODEC_CONSTRAINT", `formula contains ${value.length} characters; maximum is ${maxChars}.`, context);
            }
            return value;
        };
        const codec = Object.freeze({
            kind: "formula",
            encode(value, context = {}) {
                return Object.freeze({
                    __gqueryFormulaCell: true,
                    expression: validate(value, "encode", context),
                });
            },
            decode(value, context = {}) {
                return validate(value, "decode", context);
            },
        });
        return freezeDefinition(codec, options);
    }
    function identifier(options = {}) {
        const base = text({ ...options, trim: false, minLength: 1 });
        const codec = Object.freeze({
            kind: "identifier",
            encode: (value, context = {}) => base.encode(value, context),
            decode: (value, context = {}) => base.decode(value, context),
        });
        return freezeDefinition(codec, options);
    }
    function validateBounds(kind, min, max) {
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
    function number(options = {}) {
        validateBounds("number", options.min, options.max);
        const codec = valueTypeCodec("number", "number", (value, direction, context) => {
            if (!Number.isFinite(value)) {
                throw codecError("number", direction, "CODEC_CONSTRAINT", "number must be finite.", context);
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
    function integer(options = {}) {
        var _a;
        validateBounds("integer", options.min, options.max);
        const safe = (_a = options.safe) !== null && _a !== void 0 ? _a : true;
        const codec = valueTypeCodec("integer", "number", (value, direction, context) => {
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
    function normalizeDecimal(value, options, direction, context) {
        if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
            throw codecError("decimal", direction, "CODEC_TYPE", "decimal requires a base-10 string without exponent notation.", context);
        }
        let sign = "";
        let unsigned = value;
        if (unsigned.startsWith("+") || unsigned.startsWith("-")) {
            sign = unsigned[0] === "-" ? "-" : "";
            unsigned = unsigned.slice(1);
        }
        let [whole = "0", fraction = ""] = unsigned.split(".");
        if (whole.length === 0)
            whole = "0";
        whole = whole.replace(/^0+(?=\d)/, "");
        if (options.scale !== undefined) {
            if (fraction.length > options.scale) {
                throw codecError("decimal", direction, "CODEC_CONSTRAINT", `decimal supports at most ${options.scale} fractional digits.`, context);
            }
            fraction = fraction.padEnd(options.scale, "0");
        }
        else {
            fraction = fraction.replace(/0+$/, "");
        }
        const digitCount = `${whole}${fraction}`.replace(/^0+/, "").length || 1;
        if (options.maxDigits !== undefined && digitCount > options.maxDigits) {
            throw codecError("decimal", direction, "CODEC_CONSTRAINT", `decimal supports at most ${options.maxDigits} significant storage digits.`, context);
        }
        const isZero = /^0+$/.test(`${whole}${fraction}`);
        return `${isZero ? "" : sign}${whole}${fraction.length > 0 ? `.${fraction}` : ""}`;
    }
    function decimal(options = {}) {
        if (options.scale !== undefined && (!Number.isInteger(options.scale) || options.scale < 0)) {
            throw new GQueryDefinitionError("decimal scale must be a non-negative integer.");
        }
        if (options.maxDigits !== undefined && (!Number.isInteger(options.maxDigits) || options.maxDigits < 1)) {
            throw new GQueryDefinitionError("decimal maxDigits must be a positive integer.");
        }
        const codec = Object.freeze({
            kind: "decimal",
            encode: (value, context = {}) => normalizeDecimal(value, options, "encode", context),
            decode: (value, context = {}) => normalizeDecimal(value, options, "decode", context),
        });
        return freezeDefinition(codec, options);
    }
    function booleanColumn(options = {}) {
        return freezeDefinition(valueTypeCodec("boolean", "boolean"), options);
    }
    function enumeration(options) {
        const values = Object.freeze([...options.values]);
        if (new Set(values).size !== values.length) {
            throw new GQueryDefinitionError("enumeration values must be unique.");
        }
        const codec = Object.freeze({
            kind: "enum",
            encode(value, context = {}) {
                if (!values.some((candidate) => Object.is(candidate, value))) {
                    throw codecError("enum", "encode", "CODEC_CONSTRAINT", "Value is not a member of the enumeration.", context);
                }
                return value;
            },
            decode(value, context = {}) {
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
    function parseCanonicalDate(value, kind, direction, context) {
        if (value instanceof Date) {
            if (!Number.isFinite(value.getTime())) {
                throw codecError(kind, direction, "CODEC_CONSTRAINT", `${kind} must be valid.`, context);
            }
            const cloned = new Date(value.getTime());
            if (kind === "date" &&
                (cloned.getUTCHours() !== 0 ||
                    cloned.getUTCMinutes() !== 0 ||
                    cloned.getUTCSeconds() !== 0 ||
                    cloned.getUTCMilliseconds() !== 0)) {
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
    function date(options = {}) {
        const codec = Object.freeze({
            kind: "date",
            encode(value, context = {}) {
                return parseCanonicalDate(value, "date", "encode", context).toISOString().slice(0, 10);
            },
            decode(value, context = {}) {
                return parseCanonicalDate(value, "date", "decode", context);
            },
        });
        return freezeDefinition(codec, options);
    }
    function datetime(options = {}) {
        const codec = Object.freeze({
            kind: "datetime",
            encode(value, context = {}) {
                return parseCanonicalDate(value, "datetime", "encode", context).toISOString();
            },
            decode(value, context = {}) {
                return parseCanonicalDate(value, "datetime", "decode", context);
            },
        });
        return freezeDefinition(codec, options);
    }
    function assertSerializationOptions(kind, maxChars, maxDepth, formatVersion) {
        if (!Number.isInteger(formatVersion) || formatVersion < 1) {
            throw new GQueryDefinitionError(`${kind} formatVersion must be a positive integer.`);
        }
        if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars >= 50000) {
            throw new GQueryDefinitionError(`${kind} maxChars must be an integer between 1 and 49,999.`);
        }
        if (!Number.isInteger(maxDepth) || maxDepth < 1) {
            throw new GQueryDefinitionError(`${kind} maxDepth must be a positive integer.`);
        }
    }
    function assertSize(kind, value, maxChars, direction, context) {
        if (value.length > maxChars) {
            throw codecError(kind, direction, kind === "json" ? "JSON_TOO_LARGE" : "STRUCTURED_TOO_LARGE", `${kind} encoded value contains ${value.length} characters; maximum is ${maxChars}.`, context);
        }
    }
    function isPlainObject(value) {
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }
    function canonicalJsonValue(value, kind, context, stack, depth, maxDepth) {
        if (depth > maxDepth) {
            throw codecError(kind, "encode", "STRUCTURED_TOO_DEEP", `${kind} exceeds maximum depth ${maxDepth}.`, context);
        }
        if (value === null || typeof value === "string" || typeof value === "boolean")
            return value;
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
                const output = [];
                for (let index = 0; index < value.length; index += 1) {
                    if (!(index in value)) {
                        throw codecError(kind, "encode", "STRUCTURED_UNSUPPORTED", `${kind} does not support sparse arrays.`, context);
                    }
                    output.push(canonicalJsonValue(value[index], kind, context, stack, depth + 1, maxDepth));
                }
                return output;
            }
            const output = {};
            for (const key of Object.keys(value).sort()) {
                Object.defineProperty(output, key, {
                    value: canonicalJsonValue(value[key], kind, context, stack, depth + 1, maxDepth),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            }
            return output;
        }
        finally {
            stack.delete(value);
        }
    }
    function validateParsedJson(value, context, depth, maxDepth) {
        if (depth > maxDepth) {
            throw codecError("json", "decode", "STRUCTURED_TOO_DEEP", `json exceeds maximum depth ${maxDepth}.`, context);
        }
        if (value === null || typeof value === "string" || typeof value === "boolean")
            return value;
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        if (Array.isArray(value))
            return value.map((entry) => validateParsedJson(entry, context, depth + 1, maxDepth));
        if (typeof value === "object" && value !== null && isPlainObject(value)) {
            const output = {};
            for (const key of Object.keys(value)) {
                Object.defineProperty(output, key, {
                    value: validateParsedJson(value[key], context, depth + 1, maxDepth),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            }
            return output;
        }
        throw codecError("json", "decode", "JSON_INVALID", "json cell contains an unsupported value.", context);
    }
    function json(options = {}) {
        var _a, _b, _c;
        const formatVersion = (_a = options.formatVersion) !== null && _a !== void 0 ? _a : 1;
        const maxChars = (_b = options.maxChars) !== null && _b !== void 0 ? _b : DEFAULT_MAX_CELL_CHARS;
        const maxDepth = (_c = options.maxDepth) !== null && _c !== void 0 ? _c : DEFAULT_MAX_DEPTH;
        assertSerializationOptions("json", maxChars, maxDepth, formatVersion);
        const prefix = `gq:json:v${formatVersion}:`;
        const codec = Object.freeze({
            kind: "json",
            encode(value, context = {}) {
                const canonical = canonicalJsonValue(value, "json", context, new Set(), 0, maxDepth);
                const encoded = `${prefix}${JSON.stringify(canonical)}`;
                assertSize("json", encoded, maxChars, "encode", context);
                return encoded;
            },
            decode(value, context = {}) {
                if (typeof value !== "string") {
                    throw codecError("json", "decode", "CODEC_TYPE", "json expected an encoded string.", context);
                }
                assertSize("json", value, maxChars, "decode", context);
                if (!value.startsWith(prefix)) {
                    throw codecError("json", "decode", "JSON_INVALID", `json expected format version ${formatVersion}.`, context);
                }
                try {
                    return validateParsedJson(JSON.parse(value.slice(prefix.length)), context, 0, maxDepth);
                }
                catch (error) {
                    if (error instanceof GQueryCodecError)
                        throw error;
                    throw codecError("json", "decode", "JSON_INVALID", "json cell contains invalid JSON.", context, error);
                }
            },
        });
        return freezeDefinition(codec, options);
    }
    function encodeStructuredNode(value, context, stack, depth, maxDepth) {
        if (depth > maxDepth) {
            throw codecError("structured", "encode", "STRUCTURED_TOO_DEEP", `structured value exceeds maximum depth ${maxDepth}.`, context);
        }
        if (value === null || typeof value === "string" || typeof value === "boolean")
            return value;
        if (typeof value === "number") {
            if (!Number.isFinite(value)) {
                throw codecError("structured", "encode", "STRUCTURED_UNSUPPORTED", "structured does not support non-finite numbers.", context);
            }
            return Object.is(value, -0) ? 0 : value;
        }
        if (typeof value === "bigint")
            return { $gq: ["bigint", value.toString()] };
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
                const entries = [];
                for (let index = 0; index < value.length; index += 1) {
                    if (!(index in value)) {
                        throw codecError("structured", "encode", "STRUCTURED_UNSUPPORTED", "structured does not support sparse arrays.", context);
                    }
                    entries.push(encodeStructuredNode(value[index], context, stack, depth + 1, maxDepth));
                }
                return { $gq: ["array", entries] };
            }
            const entries = [];
            for (const key of Object.keys(value).sort()) {
                entries.push([key, encodeStructuredNode(value[key], context, stack, depth + 1, maxDepth)]);
            }
            return { $gq: ["object", entries] };
        }
        finally {
            stack.delete(value);
        }
    }
    function decodeStructuredNode(node, context, depth, maxDepth) {
        if (depth > maxDepth) {
            throw codecError("structured", "decode", "STRUCTURED_TOO_DEEP", `structured value exceeds maximum depth ${maxDepth}.`, context);
        }
        if (node === null || typeof node === "string" || typeof node === "boolean")
            return node;
        if (typeof node === "number" && Number.isFinite(node))
            return node;
        if (typeof node !== "object" || node === null || Array.isArray(node)) {
            throw codecError("structured", "decode", "STRUCTURED_INVALID", "structured cell contains an invalid node.", context);
        }
        const keys = Object.keys(node);
        const tag = node.$gq;
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
            const output = {};
            const seen = new Set();
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
    function structured(options = {}) {
        var _a, _b, _c;
        const formatVersion = (_a = options.formatVersion) !== null && _a !== void 0 ? _a : 1;
        const maxChars = (_b = options.maxChars) !== null && _b !== void 0 ? _b : DEFAULT_MAX_CELL_CHARS;
        const maxDepth = (_c = options.maxDepth) !== null && _c !== void 0 ? _c : DEFAULT_MAX_DEPTH;
        assertSerializationOptions("structured", maxChars, maxDepth, formatVersion);
        const prefix = `gq:structured:v${formatVersion}:`;
        const codec = Object.freeze({
            kind: "structured",
            encode(value, context = {}) {
                const encoded = `${prefix}${JSON.stringify(encodeStructuredNode(value, context, new Set(), 0, maxDepth))}`;
                assertSize("structured", encoded, maxChars, "encode", context);
                return encoded;
            },
            decode(value, context = {}) {
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
                    return decodeStructuredNode(JSON.parse(value.slice(prefix.length)), context, 0, maxDepth);
                }
                catch (error) {
                    if (error instanceof GQueryCodecError)
                        throw error;
                    throw codecError("structured", "decode", "STRUCTURED_INVALID", "structured cell contains invalid JSON.", context, error);
                }
            },
        });
        return freezeDefinition(codec, options);
    }
    function nullable(column) {
        const codec = Object.freeze({
            kind: column.kind,
            encode(value, context = {}) {
                return value === null ? BLANK_CELL : column.encode(value, context);
            },
            decode(value, context = {}) {
                return value === null || isBlank(value) ? null : column.decode(value, context);
            },
        });
        return freezeDefinition(codec, cloneOptions(column), "null", false, true);
    }
    function optional(column) {
        const codec = Object.freeze({
            kind: column.kind,
            encode(value, context = {}) {
                return value === undefined ? BLANK_CELL : column.encode(value, context);
            },
            decode(value, context = {}) {
                return isBlank(value) ? undefined : column.decode(value, context);
            },
        });
        return freezeDefinition(codec, cloneOptions(column), "undefined", false, column.acceptsNull);
    }
    function withDefault(column, defaultValue) {
        const resolveDefault = () => typeof defaultValue === "function"
            ? defaultValue()
            : defaultValue;
        const codec = Object.freeze({
            kind: column.kind,
            encode(value, context = {}) {
                const fallback = resolveDefault();
                const isDefault = Object.is(value, fallback) ||
                    (value instanceof Date && fallback instanceof Date && value.getTime() === fallback.getTime());
                // A default blank policy intentionally maps the logical default back to
                // a physical blank. This keeps blank-friendly application fields (for
                // example DayOne's unconfirmed timestamps) visibly blank instead of
                // storing the strict text codec's empty-string sentinel.
                if (isDefault)
                    return BLANK_CELL;
                return column.encode(value, context);
            },
            decode(value, context = {}) {
                return isBlank(value) ? resolveDefault() : column.decode(value, context);
            },
        });
        return freezeDefinition(codec, cloneOptions(column), "default", false, column.acceptsNull);
    }
    function withBlankPolicy(column, policy) {
        if (policy === "null") {
            return nullable(column);
        }
        if (policy === "undefined") {
            return optional(column);
        }
        return column;
    }
    function isColumnDefinition(value) {
        return typeof value === "object" && value !== null &&
            value.__gqueryColumn === true;
    }

    /** Physical sheets owned by GQuery itself rather than by a user table. */
    const GQUERY_SYSTEM_SHEET_NAMES = Object.freeze([
        "_gq_meta",
        "_gq_dead_letters",
    ]);
    const SYSTEM_SHEET_NAMES = new Set(GQUERY_SYSTEM_SHEET_NAMES.map((name) => name.toLowerCase()));
    /**
     * Names that cannot also be exposed as the direct `gq.TableName` handle.
     * This includes the public API, implementation-owned instance fields, and
     * Object prototype properties that an own table handle would shadow.
     */
    const RESERVED_TABLE_PROPERTIES = new Set([
        "definition",
        "executor",
        "tables",
        "raw",
        "schema",
        "system",
        "deferred",
        "cache",
        "batch",
        "assertTransactionOpen",
        "decorateExecutable",
        "materialize",
        "appendRows",
        "commitIntents",
        "unitOfWork",
        "resolveSourceId",
        "selectionRuntime",
        "appendOperation",
        "transport",
        "activeResolver",
        "generations",
        "systemHooks",
        "deferredJournal",
        "deferredDeadLetters",
        "deferredAppliedReceipts",
        "canonicalState",
        "deferredOverlay",
        "constructor",
        "__proto__",
        "__defineGetter__",
        "__defineSetter__",
        "__lookupGetter__",
        "__lookupSetter__",
        "hasOwnProperty",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toLocaleString",
        "toString",
        "valueOf",
    ]);
    function isGQuerySystemSheetName(name) {
        return SYSTEM_SHEET_NAMES.has(name.toLowerCase());
    }
    function isReservedTablePropertyName(name) {
        return RESERVED_TABLE_PROPERTIES.has(name) || isGQuerySystemSheetName(name);
    }

    const activeSpreadsheetSource = Object.freeze({
        __gquerySource: true,
        kind: "active-spreadsheet",
    });
    /** Source constructors are descriptors only; they never open a spreadsheet. */
    const source = Object.freeze({
        activeSpreadsheet() {
            return activeSpreadsheetSource;
        },
        byId(spreadsheetId) {
            if (spreadsheetId.trim().length === 0) {
                throw new GQueryDefinitionError("Spreadsheet source ID must not be empty.");
            }
            return Object.freeze({
                __gquerySource: true,
                kind: "spreadsheet-id",
                spreadsheetId,
            });
        },
    });
    function copyRelationKey(key) {
        return (Array.isArray(key) ? Object.freeze([...key]) : key);
    }
    function relationKeyParts(key) {
        return typeof key === "string" ? [key] : key;
    }
    function defineRelation(kind, target, options) {
        var _a, _b, _c;
        if (target.trim().length === 0) {
            throw new GQueryDefinitionError("Relation target must not be empty.");
        }
        const local = copyRelationKey(options.local);
        const foreign = copyRelationKey(options.foreign);
        const localLength = Array.isArray(local) ? local.length : 1;
        const foreignLength = Array.isArray(foreign) ? foreign.length : 1;
        if (localLength === 0 || foreignLength === 0 || localLength !== foreignLength) {
            throw new GQueryDefinitionError(`Relation ${target} local and foreign keys must be non-empty and have matching arity.`, { target, localLength, foreignLength });
        }
        const onDelete = (_a = options.onDelete) !== null && _a !== void 0 ? _a : "restrict";
        if (onDelete === "set-null" && ((_b = options.required) !== null && _b !== void 0 ? _b : false)) {
            throw new GQueryDefinitionError(`Required relation ${target} cannot use set-null delete behavior.`, { target });
        }
        return Object.freeze({
            __gqueryRelation: true,
            kind,
            cardinality: (kind === "has-many" ? "many" : "one"),
            target,
            local,
            foreign,
            required: (_c = options.required) !== null && _c !== void 0 ? _c : false,
            onDelete,
        });
    }
    function belongsTo(target, options) {
        return defineRelation("belongs-to", target, options);
    }
    function hasOne(target, options) {
        return defineRelation("has-one", target, options);
    }
    function hasMany(target, options) {
        return defineRelation("has-many", target, options);
    }
    function validateKeySet(label, keys, columnNames) {
        if (keys.length === 0) {
            throw new GQueryDefinitionError(`${label} must contain at least one column.`);
        }
        if (new Set(keys).size !== keys.length) {
            throw new GQueryDefinitionError(`${label} must not contain duplicate columns.`);
        }
        const missing = keys.filter((key) => !columnNames.has(key));
        if (missing.length > 0) {
            throw new GQueryDefinitionError(`${label} references unknown column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`, { missing });
        }
    }
    function validateCache(cache, columnNames) {
        var _a, _b;
        if (cache === undefined)
            return;
        if (!Number.isInteger(cache.ttlSeconds) || cache.ttlSeconds < 1) {
            throw new GQueryDefinitionError("Cache ttlSeconds must be a positive integer.");
        }
        if (cache.jitterSeconds !== undefined &&
            (!Number.isInteger(cache.jitterSeconds) ||
                cache.jitterSeconds < 0 ||
                cache.jitterSeconds >= cache.ttlSeconds)) {
            throw new GQueryDefinitionError("Cache jitterSeconds must be a non-negative integer smaller than ttlSeconds.");
        }
        for (const [index, keys] of ((_a = cache.indexes) !== null && _a !== void 0 ? _a : []).entries()) {
            validateKeySet(`Cache index ${index}`, keys, columnNames);
        }
        const seenTags = new Set();
        for (const tag of (_b = cache.tags) !== null && _b !== void 0 ? _b : []) {
            if (typeof tag !== "string" || tag.length === 0 || tag.trim() !== tag) {
                throw new GQueryDefinitionError("Cache tags must be non-empty strings without surrounding whitespace.", { tag });
            }
            if (seenTags.has(tag)) {
                throw new GQueryDefinitionError(`Cache tag ${tag} is declared more than once.`, { tag });
            }
            seenTags.add(tag);
        }
    }
    function table(config) {
        var _a, _b, _c, _d, _e;
        if (config.source.trim().length === 0) {
            throw new GQueryDefinitionError("Table source name must not be empty.");
        }
        if (config.sheet.trim().length === 0) {
            throw new GQueryDefinitionError("Table sheet name must not be empty.");
        }
        if (isGQuerySystemSheetName(config.sheet)) {
            throw new GQueryDefinitionError(`Table sheet ${config.sheet} is reserved for GQuery system state.`, { sheet: config.sheet });
        }
        if (config.versionColumn !== undefined && config.versionColumn.trim().length === 0) {
            throw new GQueryDefinitionError("Table versionColumn must not be empty.");
        }
        const columns = { ...config.columns };
        const columnNames = Object.keys(columns);
        if (columnNames.length === 0) {
            throw new GQueryDefinitionError(`Table ${config.sheet} must define at least one column.`);
        }
        const seenHeaders = new Set();
        for (const [name, column] of Object.entries(columns)) {
            if (!isColumnDefinition(column)) {
                throw new GQueryDefinitionError(`Table ${config.sheet} column ${name} is not a column definition.`);
            }
            const header = (_a = column.header) !== null && _a !== void 0 ? _a : name;
            if (seenHeaders.has(header)) {
                throw new GQueryDefinitionError(`Table ${config.sheet} maps more than one column to header ${header}.`, { header });
            }
            seenHeaders.add(header);
        }
        if (config.versionColumn !== undefined) {
            const physicalCollision = Object.entries(columns).find(([, column]) => { var _a; return ((_a = column.header) !== null && _a !== void 0 ? _a : "") === config.versionColumn; });
            if (physicalCollision !== undefined) {
                throw new GQueryDefinitionError(`Table ${config.sheet} versionColumn ${config.versionColumn} collides with the physical header of column ${physicalCollision[0]}.`, {
                    table: config.sheet,
                    versionColumn: config.versionColumn,
                    column: physicalCollision[0],
                    collision: "physical-header",
                });
            }
            if (Object.prototype.hasOwnProperty.call(columns, config.versionColumn)) {
                throw new GQueryDefinitionError(`Table ${config.sheet} versionColumn ${config.versionColumn} collides with a logical column property of the same name.`, {
                    table: config.sheet,
                    versionColumn: config.versionColumn,
                    column: config.versionColumn,
                    collision: "logical-property",
                });
            }
        }
        const columnNameSet = new Set(columnNames);
        const primaryKey = Object.freeze([...((_b = config.primaryKey) !== null && _b !== void 0 ? _b : [])]);
        if (primaryKey.length > 0)
            validateKeySet("Primary key", primaryKey, columnNameSet);
        const unique = Object.freeze(((_c = config.unique) !== null && _c !== void 0 ? _c : []).map((keys) => Object.freeze([...keys])));
        unique.forEach((keys, index) => validateKeySet(`Unique key ${index}`, keys, columnNameSet));
        const relations = { ...((_d = config.relations) !== null && _d !== void 0 ? _d : {}) };
        for (const [name, relation] of Object.entries(relations)) {
            if (columnNameSet.has(name)) {
                throw new GQueryDefinitionError(`Table ${config.sheet} relation ${name} collides with a column property of the same name.`, { table: config.sheet, relation: name });
            }
            if (typeof relation !== "object" ||
                relation === null ||
                relation.__gqueryRelation !== true) {
                throw new GQueryDefinitionError(`Table ${config.sheet} relation ${name} is not a relation definition.`);
            }
            const local = relationKeyParts(relation.local);
            validateKeySet(`Relation ${name} local key`, local, columnNameSet);
        }
        validateCache(config.cache, columnNameSet);
        const cache = config.cache === undefined
            ? undefined
            : Object.freeze({
                ...config.cache,
                indexes: config.cache.indexes === undefined
                    ? undefined
                    : Object.freeze(config.cache.indexes.map((keys) => Object.freeze([...keys]))),
                tags: config.cache.tags === undefined
                    ? undefined
                    : Object.freeze([...config.cache.tags].sort()),
            });
        return Object.freeze({
            __gqueryTable: true,
            source: config.source,
            sheet: config.sheet,
            columns: Object.freeze(columns),
            primaryKey,
            unique,
            versionColumn: config.versionColumn,
            relations: Object.freeze(relations),
            cache,
            appendOnly: (_e = config.appendOnly) !== null && _e !== void 0 ? _e : false,
        });
    }
    function defineDatabase(config) {
        if (config.version !== 2) {
            throw new GQueryDefinitionError("GQuery v2 schemas must declare version: 2.");
        }
        const sources = { ...config.sources };
        for (const [name, definition] of Object.entries(sources)) {
            if (name.trim().length === 0) {
                throw new GQueryDefinitionError("Database source names must not be empty.");
            }
            if (typeof definition !== "object" ||
                definition === null ||
                definition.__gquerySource !== true) {
                throw new GQueryDefinitionError(`Database source ${name} is not a source definition.`);
            }
        }
        const tables = { ...config.tables };
        for (const [name, definition] of Object.entries(tables)) {
            if (name.trim().length === 0) {
                throw new GQueryDefinitionError("Database table names must not be empty.");
            }
            if (isReservedTablePropertyName(name)) {
                throw new GQueryDefinitionError(`Database table name ${name} is reserved by GQuery.`, { table: name });
            }
            if (typeof definition !== "object" ||
                definition === null ||
                definition.__gqueryTable !== true) {
                throw new GQueryDefinitionError(`Database table ${name} is not a table definition.`);
            }
            if (!(definition.source in sources)) {
                throw new GQueryDefinitionError(`Database table ${name} references unknown source ${definition.source}.`, { table: name, source: definition.source });
            }
            for (const [relationName, relation] of Object.entries(definition.relations)) {
                const target = tables[relation.target];
                if (target === undefined) {
                    throw new GQueryDefinitionError(`Database table ${name} relation ${relationName} references unknown table ${relation.target}.`, { table: name, relation: relationName, target: relation.target });
                }
                const foreign = relationKeyParts(relation.foreign);
                const missing = foreign.filter((field) => !(field in target.columns));
                if (missing.length > 0) {
                    throw new GQueryDefinitionError(`Database table ${name} relation ${relationName} references unknown target column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`, { table: name, relation: relationName, missing });
                }
                if (relation.onDelete === "set-null") {
                    const dependent = relation.kind === "belongs-to" ? definition : target;
                    const dependentFields = relation.kind === "belongs-to"
                        ? relationKeyParts(relation.local)
                        : foreign;
                    const nonNullable = dependentFields.filter((field) => { var _a; return ((_a = dependent.columns[field]) === null || _a === void 0 ? void 0 : _a.acceptsNull) !== true; });
                    if (nonNullable.length > 0) {
                        throw new GQueryDefinitionError(`Database table ${name} relation ${relationName} uses set-null with non-nullable dependent column${nonNullable.length === 1 ? "" : "s"}: ${nonNullable.join(", ")}.`, {
                            table: name,
                            relation: relationName,
                            dependentTable: relation.kind === "belongs-to" ? name : relation.target,
                            nonNullable,
                        });
                    }
                }
            }
        }
        return Object.freeze({
            __gqueryDatabase: true,
            version: 2,
            sources: Object.freeze(sources),
            tables: Object.freeze(tables),
        });
    }
    function isTableDefinition(value) {
        return typeof value === "object" && value !== null &&
            value.__gqueryTable === true;
    }
    function isDatabaseDefinition(value) {
        return typeof value === "object" && value !== null &&
            value.__gqueryDatabase === true;
    }

    /** Serializable predicate and query-plan primitives used by the v2 planner. */
    const OPERATOR_MAP = {
        $eq: "eq",
        $ne: "ne",
        $in: "in",
        $notIn: "notIn",
        $gt: "gt",
        $gte: "gte",
        $lt: "lt",
        $lte: "lte",
        $between: "between",
        $contains: "contains",
        $startsWith: "startsWith",
        $endsWith: "endsWith",
        $isBlank: "isBlank",
        $isNull: "isNull",
    };
    function isRecord(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
    }
    function immutablePredicateValue(value, seen = new Map()) {
        if (value instanceof Date)
            return Object.freeze(new Date(value.getTime()));
        if (Array.isArray(value)) {
            const existing = seen.get(value);
            if (existing !== undefined)
                return existing;
            const copy = [];
            seen.set(value, copy);
            copy.push(...value.map((entry) => immutablePredicateValue(entry, seen)));
            return Object.freeze(copy);
        }
        if (value !== null && typeof value === "object") {
            const existing = seen.get(value);
            if (existing !== undefined)
                return existing;
            const copy = {};
            seen.set(value, copy);
            for (const [key, entry] of Object.entries(value)) {
                copy[key] = immutablePredicateValue(entry, seen);
            }
            return Object.freeze(copy);
        }
        return value;
    }
    function andNodes(nodes) {
        const flattened = [];
        for (const node of nodes) {
            if (node.kind === "constant" && node.value)
                continue;
            if (node.kind === "and")
                flattened.push(...node.nodes);
            else
                flattened.push(node);
        }
        if (flattened.length === 0)
            return Object.freeze({ kind: "constant", value: true });
        if (flattened.length === 1)
            return flattened[0];
        return Object.freeze({ kind: "and", nodes: Object.freeze(flattened) });
    }
    function orNodes(nodes) {
        if (nodes.length === 0)
            return Object.freeze({ kind: "constant", value: false });
        if (nodes.length === 1)
            return nodes[0];
        return Object.freeze({ kind: "or", nodes: Object.freeze([...nodes]) });
    }
    /** Convert the typed object DSL into a deterministic, serializable predicate tree. */
    function normalizeWhere(where) {
        if (!isRecord(where))
            throw new TypeError("where() expects an object predicate.");
        const nodes = [];
        for (const [field, condition] of Object.entries(where)) {
            if (field === "$and" || field === "$or") {
                if (!Array.isArray(condition))
                    throw new TypeError(`${field} expects an array of predicates.`);
                const children = condition.map((entry) => normalizeWhere(entry));
                nodes.push(field === "$and" ? andNodes(children) : orNodes(children));
                continue;
            }
            if (field === "$not") {
                if (!isRecord(condition))
                    throw new TypeError("$not expects a predicate object.");
                nodes.push(Object.freeze({ kind: "not", node: normalizeWhere(condition) }));
                continue;
            }
            if (field.startsWith("$"))
                throw new TypeError(`Unknown predicate operator: ${field}`);
            const operatorEntries = isRecord(condition)
                ? Object.entries(condition).filter(([key]) => key.startsWith("$"))
                : [];
            if (operatorEntries.length === 0) {
                nodes.push(Object.freeze({
                    kind: "field",
                    field,
                    operator: "eq",
                    value: immutablePredicateValue(condition),
                }));
                continue;
            }
            if (operatorEntries.length !== Object.keys(condition).length) {
                throw new TypeError(`Field ${field} mixes operator and value-object syntax.`);
            }
            for (const [rawOperator, value] of operatorEntries) {
                const operator = OPERATOR_MAP[rawOperator];
                if (!operator)
                    throw new TypeError(`Unknown field operator: ${rawOperator}`);
                if ((operator === "in" || operator === "notIn") && !Array.isArray(value)) {
                    throw new TypeError(`${rawOperator} expects an array.`);
                }
                if (operator === "between" && (!Array.isArray(value) || value.length !== 2)) {
                    throw new TypeError("$between expects a two-item tuple.");
                }
                if ((operator === "isBlank" || operator === "isNull") && typeof value !== "boolean") {
                    throw new TypeError(`${rawOperator} expects a boolean.`);
                }
                nodes.push(Object.freeze({
                    kind: "field",
                    field,
                    operator,
                    value: immutablePredicateValue(value),
                }));
            }
        }
        return andNodes(nodes);
    }
    function comparable(value) {
        return value instanceof Date ? value.getTime() : value;
    }
    function equalValue(left, right) {
        if (left instanceof Date || right instanceof Date) {
            const l = left instanceof Date ? left.getTime() : new Date(String(left)).getTime();
            const r = right instanceof Date ? right.getTime() : new Date(String(right)).getTime();
            return Number.isFinite(l) && Number.isFinite(r) && l === r;
        }
        if (Object.is(left, right))
            return true;
        if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
            return canonicalStringify$1(left) === canonicalStringify$1(right);
        }
        return false;
    }
    /** Evaluate a normalized predicate against a decoded logical row. */
    function evaluatePredicate(node, row) {
        if (node.kind === "constant")
            return node.value;
        if (node.kind === "and")
            return node.nodes.every((child) => evaluatePredicate(child, row));
        if (node.kind === "or")
            return node.nodes.some((child) => evaluatePredicate(child, row));
        if (node.kind === "not")
            return !evaluatePredicate(node.node, row);
        const actual = row[node.field];
        const expected = node.value;
        switch (node.operator) {
            case "eq": return equalValue(actual, expected);
            case "ne": return !equalValue(actual, expected);
            case "in": return expected.some((value) => equalValue(actual, value));
            case "notIn": return !expected.some((value) => equalValue(actual, value));
            case "gt": return comparable(actual) > comparable(expected);
            case "gte": return comparable(actual) >= comparable(expected);
            case "lt": return comparable(actual) < comparable(expected);
            case "lte": return comparable(actual) <= comparable(expected);
            case "between": {
                const [min, max] = expected;
                const value = comparable(actual);
                return value >= comparable(min) && value <= comparable(max);
            }
            case "contains":
                if (typeof actual === "string")
                    return actual.includes(String(expected));
                if (Array.isArray(actual))
                    return actual.some((value) => equalValue(value, expected));
                return false;
            case "startsWith": return typeof actual === "string" && actual.startsWith(String(expected));
            case "endsWith": return typeof actual === "string" && actual.endsWith(String(expected));
            case "isBlank": {
                const blank = actual === "" || actual === null || actual === undefined;
                return expected ? blank : !blank;
            }
            case "isNull": return expected ? actual === null : actual !== null;
        }
        return false;
    }
    function canonicalValue(value, seen) {
        if (value === undefined)
            return { $type: "undefined" };
        if (typeof value === "bigint")
            return { $type: "bigint", value: value.toString() };
        if (value instanceof Date)
            return { $type: "date", value: value.toISOString() };
        if (typeof value === "number" && !Number.isFinite(value)) {
            return { $type: "number", value: String(value) };
        }
        if (Array.isArray(value))
            return value.map((entry) => canonicalValue(entry, seen));
        if (value !== null && typeof value === "object") {
            if (seen.has(value))
                throw new TypeError("Cannot canonicalize a circular value.");
            seen.add(value);
            const result = {};
            for (const key of Object.keys(value).sort()) {
                result[key] = canonicalValue(value[key], seen);
            }
            seen.delete(value);
            return result;
        }
        return value;
    }
    /** Stable JSON used for cache keys and plan fingerprints. */
    function canonicalStringify$1(value) {
        return JSON.stringify(canonicalValue(value, new Set()));
    }
    /** Deterministic non-cryptographic hash suitable for compact cache keys. */
    function hashCanonical$1(value) {
        const input = canonicalStringify$1(value);
        let h1 = 0xdeadbeef ^ input.length;
        let h2 = 0x41c6ce57 ^ input.length;
        for (let index = 0; index < input.length; index += 1) {
            const code = input.charCodeAt(index);
            h1 = Math.imul(h1 ^ code, 2654435761);
            h2 = Math.imul(h2 ^ code, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }
    function combinePredicates(current, next) {
        return current ? andNodes([current, next]) : next;
    }
    function emptyQueryPlan(tableName, sourceName) {
        return Object.freeze({
            table: tableName,
            source: sourceName,
            orderBy: Object.freeze([]),
            joins: Object.freeze([]),
        });
    }
    function cloneQueryPlan(plan, changes) {
        const next = {
            ...plan,
            ...changes,
            projection: changes.projection ? Object.freeze([...changes.projection]) : plan.projection,
            orderBy: changes.orderBy
                ? Object.freeze(changes.orderBy.map((clause) => Object.freeze({ ...clause })))
                : plan.orderBy,
            joins: changes.joins
                ? Object.freeze(changes.joins.map((join) => Object.freeze({
                    ...join,
                    localField: Array.isArray(join.localField) ? Object.freeze([...join.localField]) : join.localField,
                    foreignField: Array.isArray(join.foreignField) ? Object.freeze([...join.foreignField]) : join.foreignField,
                    select: join.select === undefined ? undefined : Object.freeze([...join.select]),
                })))
                : plan.joins,
        };
        return Object.freeze(next);
    }

    function createExecutionStats(initial = {}) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
        return {
            apiCalls: (_a = initial.apiCalls) !== null && _a !== void 0 ? _a : 0,
            cellsRead: (_b = initial.cellsRead) !== null && _b !== void 0 ? _b : 0,
            cellsWritten: (_c = initial.cellsWritten) !== null && _c !== void 0 ? _c : 0,
            bytesRead: (_d = initial.bytesRead) !== null && _d !== void 0 ? _d : 0,
            bytesWritten: (_e = initial.bytesWritten) !== null && _e !== void 0 ? _e : 0,
            cacheHits: (_f = initial.cacheHits) !== null && _f !== void 0 ? _f : 0,
            cacheMisses: (_g = initial.cacheMisses) !== null && _g !== void 0 ? _g : 0,
            staleCacheHits: (_h = initial.staleCacheHits) !== null && _h !== void 0 ? _h : 0,
            retries: (_j = initial.retries) !== null && _j !== void 0 ? _j : 0,
            elapsedMs: (_k = initial.elapsedMs) !== null && _k !== void 0 ? _k : 0,
            lockWaitMs: (_l = initial.lockWaitMs) !== null && _l !== void 0 ? _l : 0,
            fullScans: (_m = initial.fullScans) !== null && _m !== void 0 ? _m : 0,
            joinFanOut: (_o = initial.joinFanOut) !== null && _o !== void 0 ? _o : 0,
            rangesRead: [...((_p = initial.rangesRead) !== null && _p !== void 0 ? _p : [])],
            rangesWritten: [...((_q = initial.rangesWritten) !== null && _q !== void 0 ? _q : [])],
        };
    }
    function mergeExecutionStats(...items) {
        const merged = createExecutionStats();
        for (const item of items) {
            merged.apiCalls += item.apiCalls;
            merged.cellsRead += item.cellsRead;
            merged.cellsWritten += item.cellsWritten;
            merged.bytesRead += item.bytesRead;
            merged.bytesWritten += item.bytesWritten;
            merged.cacheHits += item.cacheHits;
            merged.cacheMisses += item.cacheMisses;
            merged.staleCacheHits += item.staleCacheHits;
            merged.retries += item.retries;
            merged.elapsedMs += item.elapsedMs;
            merged.lockWaitMs += item.lockWaitMs;
            merged.fullScans += item.fullScans;
            merged.joinFanOut += item.joinFanOut;
            merged.rangesRead.push(...item.rangesRead);
            merged.rangesWritten.push(...item.rangesWritten);
        }
        return merged;
    }

    /** Quote a sheet title for use in Google Sheets A1 notation. */
    function quoteSheetName(sheetName) {
        if (typeof sheetName !== "string" || sheetName.length === 0) {
            throw new TypeError("A sheet name must be a non-empty string.");
        }
        return `'${sheetName.replace(/'/g, "''")}'`;
    }
    /** Build an A1 range from a literal sheet title and an optional cell range. */
    function sheetRange(sheetName, range) {
        const quotedSheetName = quoteSheetName(sheetName);
        return range === undefined || range.length === 0
            ? quotedSheetName
            : `${quotedSheetName}!${range}`;
    }
    /** Extract a literal sheet title from a sheet-qualified A1 range. */
    function sheetNameFromRange(range) {
        const quoted = range.match(/^'((?:[^']|'')+)'(?:!|$)/);
        if (quoted)
            return quoted[1].replace(/''/g, "'");
        const separator = range.indexOf("!");
        return separator > 0 ? range.slice(0, separator) : null;
    }

    function columnIndexToLetter(columnIndex) {
        if (!Number.isSafeInteger(columnIndex) || columnIndex < 0) {
            throw new RangeError("Column index must be a non-negative safe integer.");
        }
        let value = columnIndex + 1;
        let result = "";
        while (value > 0) {
            value -= 1;
            result = String.fromCharCode(65 + (value % 26)) + result;
            value = Math.floor(value / 26);
        }
        return result;
    }
    function columnLetterToIndex(column) {
        const normalized = column.replace(/\$/g, "").toUpperCase();
        if (!/^[A-Z]+$/.test(normalized)) {
            throw new TypeError(`Invalid A1 column: ${column}`);
        }
        let result = 0;
        for (const character of normalized) {
            result = result * 26 + character.charCodeAt(0) - 64;
        }
        return result - 1;
    }
    function unqualifiedPart(range, sheetName) {
        if (sheetName === null)
            return range;
        if (!range.startsWith("'"))
            return range.slice(range.indexOf("!") + 1);
        for (let index = 1; index < range.length; index += 1) {
            if (range[index] !== "'")
                continue;
            if (range[index + 1] === "'") {
                index += 1;
                continue;
            }
            if (range[index + 1] === "!")
                return range.slice(index + 2);
            if (index === range.length - 1)
                return "";
            break;
        }
        throw new TypeError(`Invalid quoted A1 range: ${range}`);
    }
    function parseEndpoint(value) {
        const match = value.match(/^\$?([A-Za-z]+)?\$?([1-9]\d*)?$/);
        if (!match || (!match[1] && !match[2])) {
            throw new TypeError(`Invalid A1 endpoint: ${value}`);
        }
        return {
            column: match[1] ? columnLetterToIndex(match[1]) : undefined,
            row: match[2] ? Number(match[2]) - 1 : undefined,
        };
    }
    /** Parse sheet-qualified or local A1 notation into zero-based grid bounds. */
    function parseA1Range(range) {
        if (typeof range !== "string" || range.length === 0) {
            throw new TypeError("An A1 range must be a non-empty string.");
        }
        const sheetName = sheetNameFromRange(range);
        const local = unqualifiedPart(range, sheetName);
        if (local.length === 0)
            return { sheetName };
        const pieces = local.split(":");
        if (pieces.length > 2)
            throw new TypeError(`Invalid A1 range: ${range}`);
        const start = parseEndpoint(pieces[0]);
        const end = pieces.length === 2 ? parseEndpoint(pieces[1]) : start;
        if (start.row !== undefined &&
            end.row !== undefined &&
            end.row < start.row) {
            throw new RangeError(`A1 row range is reversed: ${range}`);
        }
        if (start.column !== undefined &&
            end.column !== undefined &&
            end.column < start.column) {
            throw new RangeError(`A1 column range is reversed: ${range}`);
        }
        return {
            sheetName,
            startRowIndex: start.row,
            endRowIndex: end.row === undefined ? undefined : end.row + 1,
            startColumnIndex: start.column,
            endColumnIndex: end.column === undefined ? undefined : end.column + 1,
        };
    }
    function cellRange(sheetName, startRowIndex, startColumnIndex, rowCount = 1, columnCount = 1) {
        for (const [name, value, allowZero] of [
            ["startRowIndex", startRowIndex, true],
            ["startColumnIndex", startColumnIndex, true],
            ["rowCount", rowCount, false],
            ["columnCount", columnCount, false],
        ]) {
            if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
                throw new RangeError(`${name} is outside the valid grid range.`);
            }
        }
        const start = `${columnIndexToLetter(startColumnIndex)}${startRowIndex + 1}`;
        const endRowIndex = startRowIndex + rowCount - 1;
        const endColumnIndex = startColumnIndex + columnCount - 1;
        const end = `${columnIndexToLetter(endColumnIndex)}${endRowIndex + 1}`;
        return sheetRange(sheetName, start === end ? start : `${start}:${end}`);
    }

    function assertSheetCellValue(value, location = "cell") {
        if (value === null)
            return;
        if (typeof value !== "string" &&
            typeof value !== "number" &&
            typeof value !== "boolean") {
            throw new TypeError(`${location} must be a string, finite number, boolean, or null.`);
        }
        if (typeof value === "number" && !Number.isFinite(value)) {
            throw new TypeError(`${location} must be a finite number.`);
        }
    }
    function cloneRawMatrix(values, label = "values") {
        if (!Array.isArray(values)) {
            throw new TypeError(`${label} must be a two-dimensional array.`);
        }
        return values.map((row, rowIndex) => {
            if (!Array.isArray(row)) {
                throw new TypeError(`${label}[${rowIndex}] must be an array.`);
            }
            return row.map((value, columnIndex) => {
                assertSheetCellValue(value, `${label}[${rowIndex}][${columnIndex}]`);
                return value;
            });
        });
    }
    function assertSheetCellInput(value, location = "cell") {
        if (isFormulaCell(value)) {
            if (!value.expression.startsWith("=") || value.expression.length < 2) {
                throw new TypeError(`${location} contains an invalid formula expression.`);
            }
            return;
        }
        assertSheetCellValue(value, location);
    }
    function cloneSheetInputMatrix(values, label = "values") {
        if (!Array.isArray(values)) {
            throw new TypeError(`${label} must be a two-dimensional array.`);
        }
        return values.map((row, rowIndex) => {
            if (!Array.isArray(row)) {
                throw new TypeError(`${label}[${rowIndex}] must be an array.`);
            }
            return row.map((value, columnIndex) => {
                assertSheetCellInput(value, `${label}[${rowIndex}][${columnIndex}]`);
                return value;
            });
        });
    }
    function normalizeReturnedMatrix(values, label = "Sheets response values") {
        if (values === undefined)
            return [];
        return cloneRawMatrix(values, label);
    }
    /** Encode one primitive as a Sheets v4 ExtendedValue. `null` means clear. */
    function encodeRawExtendedValue(value) {
        assertSheetCellValue(value);
        if (value === null)
            return undefined;
        if (typeof value === "string")
            return { stringValue: value };
        if (typeof value === "number")
            return { numberValue: value };
        return { boolValue: value };
    }
    /** Encode a grid-write input as Sheets v4 ExtendedValue without guessing. */
    function encodeAtomicExtendedValue(value) {
        assertSheetCellInput(value);
        if (isFormulaCell(value))
            return { formulaValue: value.expression };
        return encodeRawExtendedValue(value);
    }
    function encodeRawCell(value) {
        const userEnteredValue = encodeRawExtendedValue(value);
        return userEnteredValue === undefined ? {} : { userEnteredValue };
    }
    function encodeRawRows(values) {
        return cloneRawMatrix(values).map((row) => ({
            values: row.map(encodeRawCell),
        }));
    }
    function encodeAtomicRows(values) {
        return cloneSheetInputMatrix(values).map((row) => ({
            values: row.map((value) => {
                const userEnteredValue = encodeAtomicExtendedValue(value);
                return userEnteredValue === undefined ? {} : { userEnteredValue };
            }),
        }));
    }

    class GQueryV2Error extends Error {
        constructor(code, message, details = {}, cause) {
            super(message);
            this.code = code;
            this.details = details;
            this.name = new.target.name;
            this.cause = cause;
        }
    }
    class RequestPayloadTooLargeError extends GQueryV2Error {
        constructor(operationKind, bytes, maximumBytes) {
            super("REQUEST_TOO_LARGE", `The ${operationKind} payload is ${bytes} bytes, above the ${maximumBytes}-byte safety limit. Split the unit of work before retrying.`, { operationKind, bytes, maximumBytes });
        }
    }
    class ApiFailure extends GQueryV2Error {
        constructor(api, cause) {
            const codes = {
                "rate-limit": "API_RATE_LIMIT",
                server: "API_SERVER",
                network: "API_NETWORK",
                deadline: "API_DEADLINE",
                "non-retryable": "API_FAILURE",
            };
            super(codes[api.kind], api.originalMessage, { ...api }, cause);
            this.api = api;
        }
    }
    class DeadlineExceededError extends GQueryV2Error {
        constructor(deadlineMs, nowMs, cause) {
            super("DEADLINE_EXCEEDED", "The GQuery execution budget was exhausted before another safe attempt could run.", { deadlineMs, nowMs }, cause);
        }
    }
    class RetryExhaustedError extends GQueryV2Error {
        constructor(attempts, lastFailure) {
            super("RETRY_EXHAUSTED", `The API operation still failed after ${attempts} attempt${attempts === 1 ? "" : "s"}.`, { attempts, lastFailure: lastFailure.api }, lastFailure);
        }
    }
    class AmbiguousCommitError extends GQueryV2Error {
        constructor(operationKind, failure) {
            super("AMBIGUOUS_COMMIT", `The ${operationKind} operation may have committed and cannot be retried without idempotency protection.`, { operationKind, failure: failure.api }, failure);
        }
    }
    function readNumber(value) {
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        if (typeof value === "string" && value.trim() !== "") {
            const parsed = Number(value);
            if (Number.isFinite(parsed))
                return parsed;
        }
        return undefined;
    }
    function recordOf(value) {
        return typeof value === "object" && value !== null
            ? value
            : undefined;
    }
    function messageOf(error) {
        if (error instanceof Error)
            return error.message;
        const record = recordOf(error);
        return typeof (record === null || record === void 0 ? void 0 : record.message) === "string" ? record.message : String(error);
    }
    function statusOf(error, message) {
        var _a, _b, _c, _d;
        const record = recordOf(error);
        const response = recordOf(record === null || record === void 0 ? void 0 : record.response);
        const direct = (_d = (_c = (_b = (_a = readNumber(record === null || record === void 0 ? void 0 : record.statusCode)) !== null && _a !== void 0 ? _a : readNumber(record === null || record === void 0 ? void 0 : record.status)) !== null && _b !== void 0 ? _b : readNumber(record === null || record === void 0 ? void 0 : record.code)) !== null && _c !== void 0 ? _c : readNumber(response === null || response === void 0 ? void 0 : response.statusCode)) !== null && _d !== void 0 ? _d : readNumber(response === null || response === void 0 ? void 0 : response.status);
        if (direct !== undefined)
            return direct;
        const match = message.match(/(?:^|\D)(4(?:08|29)|5\d\d)(?:\D|$)/);
        return match ? Number(match[1]) : undefined;
    }
    function retryAfterOf(error) {
        var _a, _b;
        const record = recordOf(error);
        const directMs = readNumber(record === null || record === void 0 ? void 0 : record.retryAfterMs);
        if (directMs !== undefined)
            return Math.max(0, directMs);
        const headers = recordOf(record === null || record === void 0 ? void 0 : record.headers);
        const seconds = (_b = (_a = readNumber(record === null || record === void 0 ? void 0 : record.retryAfter)) !== null && _a !== void 0 ? _a : readNumber(headers === null || headers === void 0 ? void 0 : headers["Retry-After"])) !== null && _b !== void 0 ? _b : readNumber(headers === null || headers === void 0 ? void 0 : headers["retry-after"]);
        return seconds === undefined ? undefined : Math.max(0, seconds * 1000);
    }
    /** Convert the loose errors emitted by Apps Script advanced services into a stable API error. */
    function normalizeApiFailure(error) {
        if (error instanceof ApiFailure)
            return error;
        const originalMessage = messageOf(error);
        const normalized = originalMessage.toLowerCase();
        const statusCode = statusOf(error, originalMessage);
        const retryAfterMs = retryAfterOf(error);
        let kind = "non-retryable";
        if (statusCode === 429 ||
            normalized.includes("quota exceeded") ||
            normalized.includes("rate limit") ||
            normalized.includes("too many requests") ||
            normalized.includes("service invoked too many times") ||
            normalized.includes("service using too much computer time") ||
            normalized.includes("resource_exhausted")) {
            kind = "rate-limit";
        }
        else if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
            kind = "server";
        }
        else if (statusCode === 408 ||
            normalized.includes("deadline exceeded") ||
            normalized.includes("timed out") ||
            normalized.includes("timeout")) {
            kind = "deadline";
        }
        else if (normalized.includes("network") ||
            normalized.includes("connection reset") ||
            normalized.includes("connection aborted") ||
            normalized.includes("temporarily unavailable")) {
            kind = "network";
        }
        return new ApiFailure({
            kind,
            statusCode,
            retryAfterMs,
            retryable: kind !== "non-retryable",
            originalMessage,
        }, error);
    }

    /** Safety ceiling below the Sheets API's recommended 2 MB request size. */
    const ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT = 1800000;
    function nonNegativeInteger$1(name, value) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new RangeError(`${name} must be a non-negative safe integer.`);
        }
    }
    function nonEmptyMatrix(values, label) {
        if (values.length === 0 || values.every((row) => row.length === 0)) {
            throw new TypeError(`${label} must contain at least one cell.`);
        }
    }
    function formatFieldMasks(format, prefix = "userEnteredFormat") {
        const masks = [];
        for (const [key, value] of Object.entries(format)) {
            const path = `${prefix}.${key}`;
            if (value !== null &&
                typeof value === "object" &&
                !Array.isArray(value) &&
                Object.keys(value).length > 0) {
                masks.push(...formatFieldMasks(value, path));
            }
            else {
                masks.push(path);
            }
        }
        return masks;
    }
    /** Compile a transport-neutral atomic mutation into a Sheets batchUpdate request. */
    function atomicMutationToSheetsRequest(mutation) {
        nonNegativeInteger$1("sheetId", mutation.sheetId);
        if (mutation.kind === "deleteRows") {
            nonNegativeInteger$1("startRowIndex", mutation.startRowIndex);
            nonNegativeInteger$1("endRowIndex", mutation.endRowIndex);
            if (mutation.endRowIndex <= mutation.startRowIndex) {
                throw new RangeError("endRowIndex must be greater than startRowIndex.");
            }
            return {
                deleteDimension: {
                    range: {
                        sheetId: mutation.sheetId,
                        dimension: "ROWS",
                        startIndex: mutation.startRowIndex,
                        endIndex: mutation.endRowIndex,
                    },
                },
            };
        }
        if (mutation.kind === "formatCells") {
            nonNegativeInteger$1("startRowIndex", mutation.startRowIndex);
            nonNegativeInteger$1("startColumnIndex", mutation.startColumnIndex);
            if (!Number.isSafeInteger(mutation.rowCount) || mutation.rowCount < 1) {
                throw new RangeError("rowCount must be a positive safe integer.");
            }
            if (!Number.isSafeInteger(mutation.columnCount) || mutation.columnCount < 1) {
                throw new RangeError("columnCount must be a positive safe integer.");
            }
            const fields = formatFieldMasks(mutation.format).sort();
            if (fields.length === 0) {
                throw new TypeError("formatCells.format must declare at least one format field.");
            }
            return {
                repeatCell: {
                    range: {
                        sheetId: mutation.sheetId,
                        startRowIndex: mutation.startRowIndex,
                        endRowIndex: mutation.startRowIndex + mutation.rowCount,
                        startColumnIndex: mutation.startColumnIndex,
                        endColumnIndex: mutation.startColumnIndex + mutation.columnCount,
                    },
                    cell: {
                        userEnteredFormat: { ...mutation.format },
                    },
                    fields: fields.join(","),
                },
            };
        }
        const matrix = cloneSheetInputMatrix(mutation.values, `${mutation.kind}.values`);
        nonEmptyMatrix(matrix, `${mutation.kind}.values`);
        const rows = encodeAtomicRows(matrix);
        if (mutation.kind === "appendRows") {
            const formatFields = new Set();
            if (mutation.formats !== undefined) {
                if (mutation.formats.length !== rows.length) {
                    throw new RangeError("appendRows.formats must align with appendRows.values.");
                }
                const masksByCell = mutation.formats.map((formats, rowIndex) => {
                    var _a, _b;
                    const width = (_b = (_a = rows[rowIndex].values) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0;
                    if (formats.length !== width) {
                        throw new RangeError("appendRows.formats must align with every appended cell.");
                    }
                    return formats.map((format) => format === null ? [] : formatFieldMasks(format).sort());
                });
                for (const masks of masksByCell.flat()) {
                    for (const field of masks)
                        formatFields.add(field);
                }
                const requiredMasks = [...formatFields].sort();
                if (requiredMasks.length > 0 &&
                    masksByCell.flat().some((masks) => masks.length !== requiredMasks.length ||
                        masks.some((field, index) => field !== requiredMasks[index]))) {
                    throw new TypeError("appendRows.formats must provide the same format leaf fields for every appended cell; partial append masks could erase existing sheet formatting.");
                }
                rows.forEach((row, rowIndex) => {
                    var _a, _b;
                    const formats = (_b = (_a = mutation.formats) === null || _a === void 0 ? void 0 : _a[rowIndex]) !== null && _b !== void 0 ? _b : [];
                    formats.forEach((format, columnIndex) => {
                        var _a, _b;
                        if (format === null)
                            return;
                        const cell = (_b = (_a = row.values) === null || _a === void 0 ? void 0 : _a[columnIndex]) !== null && _b !== void 0 ? _b : {};
                        cell.userEnteredFormat = { ...format };
                        if (row.values === undefined)
                            row.values = [];
                        row.values[columnIndex] = cell;
                    });
                });
            }
            return {
                appendCells: {
                    sheetId: mutation.sheetId,
                    rows,
                    fields: formatFields.size === 0
                        ? "userEnteredValue"
                        : ["userEnteredValue", ...[...formatFields].sort()].join(","),
                },
            };
        }
        nonNegativeInteger$1("startRowIndex", mutation.startRowIndex);
        nonNegativeInteger$1("startColumnIndex", mutation.startColumnIndex);
        return {
            updateCells: {
                start: {
                    sheetId: mutation.sheetId,
                    rowIndex: mutation.startRowIndex,
                    columnIndex: mutation.startColumnIndex,
                },
                rows,
                fields: "userEnteredValue",
            },
        };
    }
    function utf8ByteLength$1(value) {
        let bytes = 0;
        for (let index = 0; index < value.length; index += 1) {
            const codeUnit = value.charCodeAt(index);
            if (codeUnit < 0x80)
                bytes += 1;
            else if (codeUnit < 0x800)
                bytes += 2;
            else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
                const next = value.charCodeAt(index + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    bytes += 4;
                    index += 1;
                }
                else {
                    bytes += 3;
                }
            }
            else
                bytes += 3;
        }
        return bytes;
    }
    /** Reject a request before an oversized atomic commit can reach the API. */
    function assertAtomicBatchPayloadSize(requests, options = {}) {
        const payload = {
            requests,
            includeSpreadsheetInResponse: options.includeSpreadsheetInResponse,
            responseIncludeGridData: options.responseIncludeGridData,
            responseRanges: options.responseRanges === undefined
                ? undefined
                : [...options.responseRanges],
        };
        const bytes = utf8ByteLength$1(JSON.stringify(payload));
        if (bytes > ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT) {
            throw new RequestPayloadTooLargeError("atomicBatchUpdate", bytes, ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT);
        }
        return bytes;
    }

    function normalizeDimension(value, fallback) {
        return value === "COLUMNS" ? "COLUMNS" : value === "ROWS" ? "ROWS" : fallback;
    }
    function normalizeValueRange(response, fallbackRange, fallbackDimension) {
        var _a;
        return {
            range: (_a = response === null || response === void 0 ? void 0 : response.range) !== null && _a !== void 0 ? _a : fallbackRange,
            majorDimension: normalizeDimension(response === null || response === void 0 ? void 0 : response.majorDimension, fallbackDimension),
            values: normalizeReturnedMatrix(response === null || response === void 0 ? void 0 : response.values),
        };
    }
    function normalizeUpdate(response, spreadsheetId, fallbackRange, fallbackDimension) {
        var _a, _b, _c, _d, _e;
        return {
            spreadsheetId: (_a = response === null || response === void 0 ? void 0 : response.spreadsheetId) !== null && _a !== void 0 ? _a : spreadsheetId,
            updatedRange: (_b = response === null || response === void 0 ? void 0 : response.updatedRange) !== null && _b !== void 0 ? _b : fallbackRange,
            updatedRows: (_c = response === null || response === void 0 ? void 0 : response.updatedRows) !== null && _c !== void 0 ? _c : 0,
            updatedColumns: (_d = response === null || response === void 0 ? void 0 : response.updatedColumns) !== null && _d !== void 0 ? _d : 0,
            updatedCells: (_e = response === null || response === void 0 ? void 0 : response.updatedCells) !== null && _e !== void 0 ? _e : 0,
            updatedData: (response === null || response === void 0 ? void 0 : response.updatedData)
                ? normalizeValueRange(response.updatedData, fallbackRange, fallbackDimension)
                : null,
        };
    }
    function valuesBatchPayloadBytes(data, options) {
        var _a;
        return utf8ByteLength$1(JSON.stringify({
            data,
            valueInputOption: (_a = options.valueInputOption) !== null && _a !== void 0 ? _a : "RAW",
            includeValuesInResponse: options.includeValuesInResponse,
            responseValueRenderOption: options.responseValueRenderOption,
            responseDateTimeRenderOption: options.responseDateTimeRenderOption,
        }));
    }
    function valueRangeData(update) {
        var _a;
        return {
            range: update.range,
            majorDimension: (_a = update.majorDimension) !== null && _a !== void 0 ? _a : "ROWS",
            values: cloneRawMatrix(update.values, `values for ${update.range}`),
        };
    }
    function localCellRange(sheetName, startRowIndex, startColumnIndex, rowCount, columnCount) {
        const start = `${columnIndexToLetter(startColumnIndex)}${startRowIndex + 1}`;
        const end = `${columnIndexToLetter(startColumnIndex + columnCount - 1)}${startRowIndex + rowCount}`;
        const local = start === end ? start : `${start}:${end}`;
        return sheetName === null ? local : sheetRange(sheetName, local);
    }
    /** Recursively split one oversized Values range along its declared dimension. */
    function splitValueUpdate(update, options, rowOffset = 0, columnOffset = 0) {
        var _a, _b, _c;
        const data = valueRangeData(update);
        const bytes = valuesBatchPayloadBytes([data], options);
        if (bytes <= ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT)
            return [update];
        const values = (_a = data.values) !== null && _a !== void 0 ? _a : [];
        const majorDimension = (_b = update.majorDimension) !== null && _b !== void 0 ? _b : "ROWS";
        const parsed = parseA1Range(update.range);
        if (parsed.startRowIndex === undefined || parsed.startColumnIndex === undefined) {
            throw new RequestPayloadTooLargeError("values.batchUpdate", bytes, ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT);
        }
        const make = (nextValues, nextRowOffset, nextColumnOffset) => {
            const rowCount = majorDimension === "ROWS"
                ? nextValues.length
                : nextValues.reduce((maximum, column) => Math.max(maximum, column.length), 0);
            const columnCount = majorDimension === "ROWS"
                ? nextValues.reduce((maximum, row) => Math.max(maximum, row.length), 0)
                : nextValues.length;
            return {
                range: localCellRange(parsed.sheetName, parsed.startRowIndex + nextRowOffset, parsed.startColumnIndex + nextColumnOffset, rowCount, columnCount),
                values: nextValues,
                majorDimension,
            };
        };
        if (values.length > 1) {
            const midpoint = Math.ceil(values.length / 2);
            const left = make(values.slice(0, midpoint), rowOffset, columnOffset);
            const right = make(values.slice(midpoint), rowOffset + (majorDimension === "ROWS" ? midpoint : 0), columnOffset + (majorDimension === "COLUMNS" ? midpoint : 0));
            return [
                ...splitValueUpdate(left, options, 0, 0),
                ...splitValueUpdate(right, options, 0, 0),
            ];
        }
        const inner = (_c = values[0]) !== null && _c !== void 0 ? _c : [];
        if (inner.length > 1) {
            const midpoint = Math.ceil(inner.length / 2);
            const left = make([inner.slice(0, midpoint)], rowOffset, columnOffset);
            const right = make([inner.slice(midpoint)], rowOffset + (majorDimension === "COLUMNS" ? midpoint : 0), columnOffset + (majorDimension === "ROWS" ? midpoint : 0));
            return [
                ...splitValueUpdate(left, options, 0, 0),
                ...splitValueUpdate(right, options, 0, 0),
            ];
        }
        throw new RequestPayloadTooLargeError("values.batchUpdate", bytes, ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT);
    }
    function chunkValueRanges(data, options) {
        const chunks = [];
        let current = [];
        for (const valueRange of data) {
            const candidate = [...current, valueRange];
            const bytes = valuesBatchPayloadBytes(candidate, options);
            if (bytes <= ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT) {
                current = candidate;
                continue;
            }
            if (current.length === 0) {
                throw new RequestPayloadTooLargeError("values.batchUpdate", bytes, ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT);
            }
            chunks.push(current);
            current = [valueRange];
            const singleBytes = valuesBatchPayloadBytes(current, options);
            if (singleBytes > ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT) {
                throw new RequestPayloadTooLargeError("values.batchUpdate", singleBytes, ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT);
            }
        }
        if (current.length > 0)
            chunks.push(current);
        return chunks;
    }
    class AppsScriptSheetsTransport {
        constructor(options = {}) {
            this.injectedService = options.service;
            this.invoker = options.invoker;
        }
        service() {
            var _a, _b;
            const service = (_a = this.injectedService) !== null && _a !== void 0 ? _a : (typeof Sheets === "undefined" ? undefined : Sheets);
            if (!((_b = service === null || service === void 0 ? void 0 : service.Spreadsheets) === null || _b === void 0 ? void 0 : _b.Values)) {
                throw new Error("The Apps Script Advanced Sheets service is unavailable. Enable the Sheets v4 advanced service before executing GQuery.");
            }
            return service;
        }
        invoke(context, operation) {
            return this.invoker ? this.invoker.invoke(context, operation) : operation();
        }
        getSpreadsheetMetadata(spreadsheetId) {
            var _a, _b;
            const response = this.invoke({
                kind: "getSpreadsheetMetadata",
                operationClass: "read",
                spreadsheetId,
                ranges: [],
                requestCount: 1,
                idempotent: true,
            }, () => this.service().Spreadsheets.get(spreadsheetId, {
                includeGridData: false,
                fields: "spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),protectedRanges(range,warningOnly))",
            }));
            return {
                spreadsheetId: (_a = response === null || response === void 0 ? void 0 : response.spreadsheetId) !== null && _a !== void 0 ? _a : spreadsheetId,
                sheets: ((_b = response === null || response === void 0 ? void 0 : response.sheets) !== null && _b !== void 0 ? _b : []).map(({ properties, protectedRanges }) => {
                    var _a, _b, _c, _d;
                    const sheetId = properties === null || properties === void 0 ? void 0 : properties.sheetId;
                    const title = properties === null || properties === void 0 ? void 0 : properties.title;
                    if (sheetId === undefined || title === undefined) {
                        throw new Error("Sheets metadata response omitted a sheet ID or title.");
                    }
                    return {
                        sheetId,
                        title,
                        rowCount: (_b = (_a = properties === null || properties === void 0 ? void 0 : properties.gridProperties) === null || _a === void 0 ? void 0 : _a.rowCount) !== null && _b !== void 0 ? _b : 0,
                        columnCount: (_d = (_c = properties === null || properties === void 0 ? void 0 : properties.gridProperties) === null || _c === void 0 ? void 0 : _c.columnCount) !== null && _d !== void 0 ? _d : 0,
                        hasFullSheetProtection: (protectedRanges !== null && protectedRanges !== void 0 ? protectedRanges : []).some((protection) => {
                            const range = protection.range;
                            return protection.warningOnly !== true &&
                                (range === null || range === void 0 ? void 0 : range.sheetId) === sheetId &&
                                range.startRowIndex === undefined &&
                                range.endRowIndex === undefined &&
                                range.startColumnIndex === undefined &&
                                range.endColumnIndex === undefined;
                        }),
                    };
                }),
            };
        }
        get(spreadsheetId, range, options = {}) {
            var _a;
            const majorDimension = (_a = options.majorDimension) !== null && _a !== void 0 ? _a : "ROWS";
            const response = this.invoke({
                kind: "get",
                operationClass: "read",
                spreadsheetId,
                ranges: [range],
                requestCount: 1,
                idempotent: true,
            }, () => {
                var _a, _b;
                return this.service().Spreadsheets.Values.get(spreadsheetId, range, {
                    majorDimension,
                    valueRenderOption: (_a = options.valueRenderOption) !== null && _a !== void 0 ? _a : "UNFORMATTED_VALUE",
                    dateTimeRenderOption: (_b = options.dateTimeRenderOption) !== null && _b !== void 0 ? _b : "SERIAL_NUMBER",
                });
            });
            return normalizeValueRange(response, range, majorDimension);
        }
        batchGet(spreadsheetId, ranges, options = {}) {
            var _a, _b;
            if (ranges.length === 0)
                return { spreadsheetId, valueRanges: [] };
            const majorDimension = (_a = options.majorDimension) !== null && _a !== void 0 ? _a : "ROWS";
            const response = this.invoke({
                kind: "batchGet",
                operationClass: "read",
                spreadsheetId,
                ranges,
                requestCount: ranges.length,
                idempotent: true,
            }, () => {
                var _a, _b;
                return this.service().Spreadsheets.Values.batchGet(spreadsheetId, {
                    ranges: [...ranges],
                    majorDimension,
                    valueRenderOption: (_a = options.valueRenderOption) !== null && _a !== void 0 ? _a : "UNFORMATTED_VALUE",
                    dateTimeRenderOption: (_b = options.dateTimeRenderOption) !== null && _b !== void 0 ? _b : "SERIAL_NUMBER",
                });
            });
            return {
                spreadsheetId: (_b = response === null || response === void 0 ? void 0 : response.spreadsheetId) !== null && _b !== void 0 ? _b : spreadsheetId,
                valueRanges: ranges.map((range, index) => { var _a; return normalizeValueRange((_a = response === null || response === void 0 ? void 0 : response.valueRanges) === null || _a === void 0 ? void 0 : _a[index], range, majorDimension); }),
            };
        }
        batchUpdate(spreadsheetId, updates, options = {}) {
            var _a, _b, _c;
            if (updates.length === 0) {
                return {
                    spreadsheetId,
                    totalUpdatedRows: 0,
                    totalUpdatedColumns: 0,
                    totalUpdatedCells: 0,
                    totalUpdatedSheets: 0,
                    responses: [],
                };
            }
            const expandedUpdates = updates.flatMap((update) => splitValueUpdate(update, options));
            const data = expandedUpdates.map(valueRangeData);
            const chunks = chunkValueRanges(data, options);
            const responses = [];
            let totalUpdatedRows = 0;
            let totalUpdatedColumns = 0;
            let totalUpdatedCells = 0;
            let updateIndex = 0;
            for (const chunk of chunks) {
                const chunkUpdates = expandedUpdates.slice(updateIndex, updateIndex + chunk.length);
                const response = this.invoke({
                    kind: "batchUpdate",
                    operationClass: "idempotent-write",
                    spreadsheetId,
                    ranges: chunkUpdates.map(({ range }) => range),
                    requestCount: chunkUpdates.length,
                    idempotent: true,
                }, () => {
                    var _a;
                    return this.service().Spreadsheets.Values.batchUpdate({
                        data: [...chunk],
                        valueInputOption: (_a = options.valueInputOption) !== null && _a !== void 0 ? _a : "RAW",
                        includeValuesInResponse: options.includeValuesInResponse,
                        responseValueRenderOption: options.responseValueRenderOption,
                        responseDateTimeRenderOption: options.responseDateTimeRenderOption,
                    }, spreadsheetId);
                });
                totalUpdatedRows += (_a = response === null || response === void 0 ? void 0 : response.totalUpdatedRows) !== null && _a !== void 0 ? _a : 0;
                totalUpdatedColumns += (_b = response === null || response === void 0 ? void 0 : response.totalUpdatedColumns) !== null && _b !== void 0 ? _b : 0;
                totalUpdatedCells += (_c = response === null || response === void 0 ? void 0 : response.totalUpdatedCells) !== null && _c !== void 0 ? _c : 0;
                chunkUpdates.forEach((update, index) => {
                    var _a, _b;
                    responses.push(normalizeUpdate((_a = response === null || response === void 0 ? void 0 : response.responses) === null || _a === void 0 ? void 0 : _a[index], spreadsheetId, update.range, (_b = update.majorDimension) !== null && _b !== void 0 ? _b : "ROWS"));
                });
                updateIndex += chunk.length;
            }
            return {
                spreadsheetId,
                totalUpdatedRows,
                totalUpdatedColumns,
                totalUpdatedCells,
                totalUpdatedSheets: new Set(expandedUpdates.map((update) => { var _a; return (_a = sheetNameFromRange(update.range)) !== null && _a !== void 0 ? _a : "<default-sheet>"; })).size,
                responses,
            };
        }
        atomicBatchUpdate(spreadsheetId, mutations, options = {}) {
            var _a, _b;
            if (mutations.length === 0) {
                return { spreadsheetId, requestCount: 0, replies: [] };
            }
            const requests = mutations.map(atomicMutationToSheetsRequest);
            assertAtomicBatchPayloadSize(requests, options);
            const operationClass = mutations.some(({ kind }) => kind === "appendRows")
                ? "append"
                : mutations.some(({ kind }) => kind === "deleteRows")
                    ? "structural-delete"
                    : "idempotent-write";
            const response = this.invoke({
                kind: "atomicBatchUpdate",
                operationClass,
                spreadsheetId,
                ranges: [],
                requestCount: requests.length,
                idempotent: mutations.every(({ kind }) => kind === "updateCells" || kind === "formatCells"),
            }, () => this.service().Spreadsheets.batchUpdate({
                requests,
                includeSpreadsheetInResponse: options.includeSpreadsheetInResponse,
                responseIncludeGridData: options.responseIncludeGridData,
                responseRanges: options.responseRanges
                    ? [...options.responseRanges]
                    : undefined,
            }, spreadsheetId));
            return {
                spreadsheetId: (_a = response === null || response === void 0 ? void 0 : response.spreadsheetId) !== null && _a !== void 0 ? _a : spreadsheetId,
                requestCount: requests.length,
                replies: (_b = response === null || response === void 0 ? void 0 : response.replies) !== null && _b !== void 0 ? _b : [],
            };
        }
    }

    function assertIndex(name, value) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new RangeError(`${name} must be a non-negative safe integer.`);
        }
    }
    /**
     * Compact adjacent cell patches into maximal rectangles without filling gaps.
     * Duplicate physical cells are rejected so planner mistakes cannot silently
     * overwrite an earlier change.
     */
    function compactCellUpdates(patches) {
        var _a, _b;
        const sorted = patches.map((patch) => {
            assertIndex("sheetId", patch.sheetId);
            assertIndex("rowIndex", patch.rowIndex);
            assertIndex("columnIndex", patch.columnIndex);
            assertSheetCellInput(patch.value, "patch.value");
            return patch;
        }).sort((left, right) => left.sheetId - right.sheetId ||
            left.rowIndex - right.rowIndex ||
            left.columnIndex - right.columnIndex);
        const runs = [];
        for (const patch of sorted) {
            const previous = runs[runs.length - 1];
            if (previous &&
                previous.sheetId === patch.sheetId &&
                previous.rowIndex === patch.rowIndex) {
                const expectedColumn = previous.startColumnIndex + previous.values.length;
                if (patch.columnIndex < expectedColumn) {
                    throw new Error(`Duplicate cell patch at sheet ${patch.sheetId}, row ${patch.rowIndex}, column ${patch.columnIndex}.`);
                }
                if (patch.columnIndex === expectedColumn) {
                    previous.values.push(patch.value);
                    continue;
                }
            }
            runs.push({
                sheetId: patch.sheetId,
                rowIndex: patch.rowIndex,
                startColumnIndex: patch.columnIndex,
                values: [patch.value],
            });
        }
        const result = [];
        for (const run of runs) {
            const previous = result[result.length - 1];
            const previousWidth = (_b = (_a = previous === null || previous === void 0 ? void 0 : previous.values[0]) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0;
            if (previous &&
                previous.sheetId === run.sheetId &&
                previous.startColumnIndex === run.startColumnIndex &&
                previousWidth === run.values.length &&
                previous.startRowIndex + previous.values.length === run.rowIndex) {
                previous.values = [...previous.values, [...run.values]];
                continue;
            }
            result.push({
                kind: "updateCells",
                sheetId: run.sheetId,
                startRowIndex: run.rowIndex,
                startColumnIndex: run.startColumnIndex,
                values: [[...run.values]],
            });
        }
        return result;
    }
    /** Group row indices and order every sheet's delete ranges from bottom to top. */
    function compactRowDeletes(rows) {
        var _a, _b;
        const bySheet = new Map();
        for (const row of rows) {
            assertIndex("sheetId", row.sheetId);
            assertIndex("rowIndex", row.rowIndex);
            const indices = (_a = bySheet.get(row.sheetId)) !== null && _a !== void 0 ? _a : new Set();
            indices.add(row.rowIndex);
            bySheet.set(row.sheetId, indices);
        }
        const result = [];
        for (const sheetId of [...bySheet.keys()].sort((a, b) => a - b)) {
            const indices = [...((_b = bySheet.get(sheetId)) !== null && _b !== void 0 ? _b : [])].sort((a, b) => a - b);
            const ranges = [];
            let start = indices[0];
            let previous = indices[0];
            for (let index = 1; index < indices.length; index += 1) {
                const current = indices[index];
                if (current === previous + 1) {
                    previous = current;
                    continue;
                }
                ranges.push({
                    kind: "deleteRows",
                    sheetId,
                    startRowIndex: start,
                    endRowIndex: previous + 1,
                });
                start = current;
                previous = current;
            }
            if (start !== undefined && previous !== undefined) {
                ranges.push({
                    kind: "deleteRows",
                    sheetId,
                    startRowIndex: start,
                    endRowIndex: previous + 1,
                });
            }
            ranges.sort((left, right) => right.startRowIndex - left.startRowIndex);
            result.push(...ranges);
        }
        return result;
    }

    function cloneSheet(sheet) {
        return {
            sheetId: sheet.sheetId,
            title: sheet.title,
            values: sheet.values.map((row) => [...row]),
            ...(sheet.hasFullSheetProtection === undefined
                ? {}
                : { hasFullSheetProtection: sheet.hasFullSheetProtection }),
        };
    }
    function cloneSpreadsheet(spreadsheet) {
        return {
            spreadsheetId: spreadsheet.spreadsheetId,
            sheets: spreadsheet.sheets.map(cloneSheet),
        };
    }
    function validateSeed(seed) {
        if (!seed.spreadsheetId)
            throw new TypeError("spreadsheetId must not be empty.");
        const sheetIds = new Set();
        const titles = new Set();
        const sheets = seed.sheets.map((sheet) => {
            var _a;
            if (!Number.isSafeInteger(sheet.sheetId) || sheet.sheetId < 0) {
                throw new RangeError("sheetId must be a non-negative safe integer.");
            }
            if (!sheet.title)
                throw new TypeError("Sheet title must not be empty.");
            if (sheetIds.has(sheet.sheetId)) {
                throw new Error(`Duplicate sheet ID ${sheet.sheetId}.`);
            }
            if (titles.has(sheet.title)) {
                throw new Error(`Duplicate sheet title ${sheet.title}.`);
            }
            sheetIds.add(sheet.sheetId);
            titles.add(sheet.title);
            return {
                sheetId: sheet.sheetId,
                title: sheet.title,
                values: cloneSheetInputMatrix((_a = sheet.values) !== null && _a !== void 0 ? _a : [], `seed ${sheet.title}`),
                ...(sheet.hasFullSheetProtection === undefined
                    ? {}
                    : { hasFullSheetProtection: sheet.hasFullSheetProtection }),
            };
        });
        return { spreadsheetId: seed.spreadsheetId, sheets };
    }
    function transpose(values, blank) {
        const width = values.reduce((maximum, row) => Math.max(maximum, row.length), 0);
        return Array.from({ length: width }, (_, columnIndex) => values.map((row) => { var _a; return (_a = row[columnIndex]) !== null && _a !== void 0 ? _a : blank; }));
    }
    function trimTrailingNulls(values) {
        const rows = values.map((row) => {
            let end = row.length;
            while (end > 0 && row[end - 1] === null)
                end -= 1;
            return row.slice(0, end);
        });
        let end = rows.length;
        while (end > 0 && rows[end - 1].length === 0)
            end -= 1;
        return rows.slice(0, end);
    }
    function ensureCell(sheet, rowIndex, columnIndex) {
        while (sheet.values.length <= rowIndex)
            sheet.values.push([]);
        const row = sheet.values[rowIndex];
        while (row.length <= columnIndex)
            row.push(null);
    }
    function writeMatrix(sheet, startRowIndex, startColumnIndex, values) {
        values.forEach((row, rowOffset) => {
            row.forEach((value, columnOffset) => {
                const rowIndex = startRowIndex + rowOffset;
                const columnIndex = startColumnIndex + columnOffset;
                ensureCell(sheet, rowIndex, columnIndex);
                sheet.values[rowIndex][columnIndex] = value;
            });
        });
    }
    function maxWidth(values) {
        return values.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    }
    class InMemorySheetsTransport {
        constructor(seeds = []) {
            this.spreadsheets = new Map();
            this.calls = [];
            for (const seed of seeds)
                this.addSpreadsheet(seed);
        }
        addSpreadsheet(seed) {
            if (this.spreadsheets.has(seed.spreadsheetId)) {
                throw new Error(`Spreadsheet ${seed.spreadsheetId} already exists.`);
            }
            this.spreadsheets.set(seed.spreadsheetId, validateSeed(seed));
        }
        get history() {
            return this.calls.map((call) => ({ ...call, ranges: [...call.ranges] }));
        }
        clearHistory() {
            this.calls.length = 0;
        }
        snapshot(spreadsheetId) {
            const spreadsheet = this.requireSpreadsheet(spreadsheetId);
            return {
                spreadsheetId,
                sheets: spreadsheet.sheets.map((sheet) => ({
                    sheetId: sheet.sheetId,
                    title: sheet.title,
                    values: sheet.values.map((row) => [...row]),
                })),
            };
        }
        record(call) {
            this.calls.push({ ...call, ranges: [...call.ranges] });
        }
        requireSpreadsheet(spreadsheetId) {
            const spreadsheet = this.spreadsheets.get(spreadsheetId);
            if (!spreadsheet)
                throw new Error(`Unknown spreadsheet: ${spreadsheetId}`);
            return spreadsheet;
        }
        requireSheetById(spreadsheet, sheetId) {
            const sheet = spreadsheet.sheets.find((candidate) => candidate.sheetId === sheetId);
            if (!sheet)
                throw new Error(`Unknown sheet ID ${sheetId}.`);
            return sheet;
        }
        resolveRange(spreadsheet, range) {
            const parsed = parseA1Range(range);
            const sheet = parsed.sheetName
                ? spreadsheet.sheets.find(({ title }) => title === parsed.sheetName)
                : spreadsheet.sheets[0];
            if (!sheet) {
                throw new Error(parsed.sheetName
                    ? `Unknown sheet: ${parsed.sheetName}`
                    : `Spreadsheet ${spreadsheet.spreadsheetId} has no sheets.`);
            }
            return { sheet, parsed };
        }
        getSpreadsheetMetadata(spreadsheetId) {
            this.record({
                kind: "getSpreadsheetMetadata",
                spreadsheetId,
                ranges: [],
                requestCount: 1,
            });
            const spreadsheet = this.requireSpreadsheet(spreadsheetId);
            return {
                spreadsheetId,
                sheets: spreadsheet.sheets.map((sheet) => ({
                    sheetId: sheet.sheetId,
                    title: sheet.title,
                    rowCount: sheet.values.length,
                    columnCount: maxWidth(sheet.values),
                    ...(sheet.hasFullSheetProtection === undefined
                        ? {}
                        : { hasFullSheetProtection: sheet.hasFullSheetProtection }),
                })),
            };
        }
        read(spreadsheet, range, majorDimension, valueRenderOption) {
            var _a, _b, _c, _d, _e, _f;
            const { sheet, parsed } = this.resolveRange(spreadsheet, range);
            const startRow = (_a = parsed.startRowIndex) !== null && _a !== void 0 ? _a : 0;
            const startColumn = (_b = parsed.startColumnIndex) !== null && _b !== void 0 ? _b : 0;
            const endRow = Math.min((_c = parsed.endRowIndex) !== null && _c !== void 0 ? _c : sheet.values.length, sheet.values.length);
            const dataWidth = maxWidth(sheet.values);
            const endColumn = Math.min((_d = parsed.endColumnIndex) !== null && _d !== void 0 ? _d : dataWidth, dataWidth);
            const rows = [];
            for (let rowIndex = startRow; rowIndex < endRow; rowIndex += 1) {
                const source = (_e = sheet.values[rowIndex]) !== null && _e !== void 0 ? _e : [];
                const row = [];
                for (let columnIndex = startColumn; columnIndex < endColumn; columnIndex += 1) {
                    const value = (_f = source[columnIndex]) !== null && _f !== void 0 ? _f : null;
                    row.push(isFormulaCell(value)
                        ? valueRenderOption === "FORMULA"
                            ? value.expression
                            : null
                        : value);
                }
                rows.push(row);
            }
            const values = trimTrailingNulls(rows);
            return {
                range,
                majorDimension,
                values: majorDimension === "COLUMNS" ? trimTrailingNulls(transpose(values, null)) : values,
            };
        }
        get(spreadsheetId, range, options = {}) {
            var _a, _b, _c;
            this.record({
                kind: "get",
                spreadsheetId,
                ranges: [range],
                requestCount: 1,
                valueRenderOption: (_a = options.valueRenderOption) !== null && _a !== void 0 ? _a : "UNFORMATTED_VALUE",
            });
            return this.read(this.requireSpreadsheet(spreadsheetId), range, (_b = options.majorDimension) !== null && _b !== void 0 ? _b : "ROWS", (_c = options.valueRenderOption) !== null && _c !== void 0 ? _c : "UNFORMATTED_VALUE");
        }
        batchGet(spreadsheetId, ranges, options = {}) {
            var _a, _b;
            this.record({
                kind: "batchGet",
                spreadsheetId,
                ranges,
                requestCount: ranges.length,
                valueRenderOption: (_a = options.valueRenderOption) !== null && _a !== void 0 ? _a : "UNFORMATTED_VALUE",
            });
            const spreadsheet = this.requireSpreadsheet(spreadsheetId);
            const majorDimension = (_b = options.majorDimension) !== null && _b !== void 0 ? _b : "ROWS";
            return {
                spreadsheetId,
                valueRanges: ranges.map((range) => {
                    var _a;
                    return this.read(spreadsheet, range, majorDimension, (_a = options.valueRenderOption) !== null && _a !== void 0 ? _a : "UNFORMATTED_VALUE");
                }),
            };
        }
        batchUpdate(spreadsheetId, updates, options = {}) {
            var _a, _b, _c, _d;
            this.record({
                kind: "batchUpdate",
                spreadsheetId,
                ranges: updates.map(({ range }) => range),
                requestCount: updates.length,
            });
            const spreadsheet = this.requireSpreadsheet(spreadsheetId);
            const responses = [];
            const touchedSheets = new Set();
            let totalCells = 0;
            for (const update of updates) {
                const { sheet, parsed } = this.resolveRange(spreadsheet, update.range);
                const rowStart = (_a = parsed.startRowIndex) !== null && _a !== void 0 ? _a : 0;
                const columnStart = (_b = parsed.startColumnIndex) !== null && _b !== void 0 ? _b : 0;
                const input = cloneRawMatrix(update.values, `values for ${update.range}`);
                const rowMajor = update.majorDimension === "COLUMNS" ? transpose(input, null) : input;
                writeMatrix(sheet, rowStart, columnStart, rowMajor);
                const updatedCells = rowMajor.reduce((total, row) => total + row.length, 0);
                const updatedColumns = maxWidth(rowMajor);
                touchedSheets.add(sheet.sheetId);
                totalCells += updatedCells;
                responses.push({
                    spreadsheetId,
                    updatedRange: update.range,
                    updatedRows: rowMajor.length,
                    updatedColumns,
                    updatedCells,
                    updatedData: options.includeValuesInResponse
                        ? this.read(spreadsheet, update.range, (_c = update.majorDimension) !== null && _c !== void 0 ? _c : "ROWS", (_d = options.responseValueRenderOption) !== null && _d !== void 0 ? _d : "UNFORMATTED_VALUE")
                        : null,
                });
            }
            return {
                spreadsheetId,
                totalUpdatedRows: responses.reduce((total, item) => total + item.updatedRows, 0),
                totalUpdatedColumns: responses.reduce((total, item) => total + item.updatedColumns, 0),
                totalUpdatedCells: totalCells,
                totalUpdatedSheets: touchedSheets.size,
                responses,
            };
        }
        atomicBatchUpdate(spreadsheetId, mutations, options = {}) {
            assertAtomicBatchPayloadSize(mutations.map(atomicMutationToSheetsRequest), options);
            this.record({
                kind: "atomicBatchUpdate",
                spreadsheetId,
                ranges: [],
                requestCount: mutations.length,
            });
            const original = this.requireSpreadsheet(spreadsheetId);
            const candidate = cloneSpreadsheet(original);
            for (const mutation of mutations) {
                const sheet = this.requireSheetById(candidate, mutation.sheetId);
                if (mutation.kind === "updateCells") {
                    if (mutation.startRowIndex < 0 || mutation.startColumnIndex < 0) {
                        throw new RangeError("Atomic update indices must not be negative.");
                    }
                    const matrix = cloneSheetInputMatrix(mutation.values, "atomic update values");
                    if (matrix.length === 0)
                        throw new TypeError("Atomic update cannot be empty.");
                    writeMatrix(sheet, mutation.startRowIndex, mutation.startColumnIndex, matrix);
                }
                else if (mutation.kind === "appendRows") {
                    const matrix = cloneSheetInputMatrix(mutation.values, "atomic append values");
                    if (matrix.length === 0)
                        throw new TypeError("Atomic append cannot be empty.");
                    writeMatrix(sheet, sheet.values.length, 0, matrix);
                }
                else if (mutation.kind === "formatCells") {
                    if (!Number.isSafeInteger(mutation.startRowIndex) ||
                        !Number.isSafeInteger(mutation.startColumnIndex) ||
                        !Number.isSafeInteger(mutation.rowCount) ||
                        !Number.isSafeInteger(mutation.columnCount) ||
                        mutation.startRowIndex < 0 ||
                        mutation.startColumnIndex < 0 ||
                        mutation.rowCount < 1 ||
                        mutation.columnCount < 1) {
                        throw new RangeError("Atomic format range is outside the grid bounds.");
                    }
                    // The in-memory transport models values, not presentation. Compiling
                    // the request above still validates the format mutation shape.
                }
                else {
                    if (!Number.isSafeInteger(mutation.startRowIndex) ||
                        !Number.isSafeInteger(mutation.endRowIndex) ||
                        mutation.startRowIndex < 0 ||
                        mutation.endRowIndex <= mutation.startRowIndex ||
                        mutation.endRowIndex > sheet.values.length) {
                        throw new RangeError("Atomic row deletion is outside the sheet bounds.");
                    }
                    sheet.values.splice(mutation.startRowIndex, mutation.endRowIndex - mutation.startRowIndex);
                }
            }
            this.spreadsheets.set(spreadsheetId, candidate);
            return { spreadsheetId, requestCount: mutations.length, replies: [] };
        }
    }

    /** Structured failures raised by the schema/query/execution layers. */
    class GQueryRuntimeError extends Error {
        constructor(code, message, options = {}) {
            var _a;
            super(message);
            this.name = "GQueryRuntimeError";
            this.code = code;
            this.details = Object.freeze({ ...((_a = options.details) !== null && _a !== void 0 ? _a : {}) });
            this.cause = options.cause;
            Object.setPrototypeOf(this, new.target.prototype);
        }
    }

    function cloneProvenance(provenance, changes = {}) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        return Object.freeze({
            ...provenance,
            ...changes,
            primaryKey: Object.freeze({
                ...provenance.primaryKey,
                ...((_a = changes.primaryKey) !== null && _a !== void 0 ? _a : {}),
            }),
            encodedPrimaryKey: Object.freeze({
                ...provenance.encodedPrimaryKey,
                ...((_b = changes.encodedPrimaryKey) !== null && _b !== void 0 ? _b : {}),
            }),
            originalEncoded: Object.freeze({
                ...provenance.originalEncoded,
                ...((_c = changes.originalEncoded) !== null && _c !== void 0 ? _c : {}),
            }),
            columnIndexes: Object.freeze({
                ...provenance.columnIndexes,
                ...((_d = changes.columnIndexes) !== null && _d !== void 0 ? _d : {}),
            }),
            relations: Object.freeze({
                ...provenance.relations,
                ...((_e = changes.relations) !== null && _e !== void 0 ? _e : {}),
            }),
            relationCardinalities: Object.freeze({
                ...provenance.relationCardinalities,
                ...((_f = changes.relationCardinalities) !== null && _f !== void 0 ? _f : {}),
            }),
            relationLocalFields: Object.freeze({
                ...((_g = provenance.relationLocalFields) !== null && _g !== void 0 ? _g : {}),
                ...((_h = changes.relationLocalFields) !== null && _h !== void 0 ? _h : {}),
            }),
            deferredOverlay: changes.deferredOverlay === undefined
                ? provenance.deferredOverlay
                : Object.freeze({
                    ...changes.deferredOverlay,
                    mutationIds: Object.freeze([...changes.deferredOverlay.mutationIds]),
                    fields: Object.freeze([...changes.deferredOverlay.fields]),
                }),
        });
    }
    /**
     * Remove joined values whose lookup key was changed by a base-row mutation.
     * The remaining aliases keep their exact physical relation provenance.
     */
    function invalidateChangedRelations(item, changedFields) {
        var _a;
        if (changedFields.length === 0)
            return item;
        const changed = new Set(changedFields);
        const localFields = (_a = item.provenance.relationLocalFields) !== null && _a !== void 0 ? _a : {};
        const invalidated = Object.entries(localFields)
            .filter(([, fields]) => fields.some((field) => changed.has(field)))
            .map(([alias]) => alias);
        if (invalidated.length === 0)
            return item;
        const invalidatedSet = new Set(invalidated);
        const value = { ...item.value };
        for (const alias of invalidated)
            delete value[alias];
        const retain = (record) => Object.fromEntries(Object.entries(record).filter(([alias]) => !invalidatedSet.has(alias)));
        return {
            value: value,
            provenance: Object.freeze({
                ...item.provenance,
                relations: Object.freeze(retain(item.provenance.relations)),
                relationCardinalities: Object.freeze(retain(item.provenance.relationCardinalities)),
                relationLocalFields: Object.freeze(retain(localFields)),
            }),
        };
    }

    const SELECTION_INTERNAL = Symbol("gquery.selection.internal");
    function cloneAndFreeze(value, seen = new Map()) {
        if (value instanceof Date)
            return Object.freeze(new Date(value.getTime()));
        if (Array.isArray(value)) {
            const existing = seen.get(value);
            if (existing !== undefined)
                return existing;
            const copy = [];
            seen.set(value, copy);
            copy.push(...value.map((entry) => cloneAndFreeze(entry, seen)));
            return Object.freeze(copy);
        }
        if (value !== null && typeof value === "object") {
            const existing = seen.get(value);
            if (existing !== undefined)
                return existing;
            const copy = {};
            seen.set(value, copy);
            for (const [key, entry] of Object.entries(value)) {
                Object.defineProperty(copy, key, {
                    value: cloneAndFreeze(entry, seen),
                    enumerable: true,
                    configurable: false,
                    writable: false,
                });
            }
            return Object.freeze(copy);
        }
        return value;
    }
    function jsonSafe(value, ancestors = new Set()) {
        if (value === null || typeof value === "string" || typeof value === "boolean")
            return value;
        if (value === undefined)
            return Object.freeze({ $gquery: "undefined" });
        if (typeof value === "bigint") {
            return Object.freeze({ $gquery: "bigint", value: value.toString() });
        }
        if (typeof value === "number") {
            if (Number.isFinite(value) && !Object.is(value, -0))
                return value;
            const encoded = Number.isNaN(value)
                ? "NaN"
                : value === Infinity
                    ? "Infinity"
                    : value === -Infinity
                        ? "-Infinity"
                        : "-0";
            return Object.freeze({ $gquery: "number", value: encoded });
        }
        if (value instanceof Date) {
            if (!Number.isFinite(value.getTime()))
                throw new TypeError("Selection JSON cannot encode an invalid Date.");
            return Object.freeze({ $gquery: "date", value: value.toISOString() });
        }
        if (typeof value === "function" || typeof value === "symbol") {
            throw new TypeError(`Selection JSON cannot encode ${typeof value} values.`);
        }
        if (typeof value !== "object")
            throw new TypeError("Selection JSON encountered an unsupported value.");
        if (ancestors.has(value))
            throw new TypeError("Selection JSON cannot encode circular values.");
        ancestors.add(value);
        try {
            if (Array.isArray(value)) {
                return Object.freeze(value.map((entry) => jsonSafe(entry, ancestors)));
            }
            const prototype = Object.getPrototypeOf(value);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new TypeError("Selection JSON can encode only plain objects and supported tagged values.");
            }
            return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry, ancestors)])));
        }
        finally {
            ancestors.delete(value);
        }
    }
    /**
     * An immutable result set. Its public data is serializable; physical row
     * provenance is retained behind a symbol for safe targeted mutations.
     */
    class Selection {
        constructor(materialized, headers, stats, runtime, refresh = null, fanoutRequired = false) {
            const frozenMaterialized = materialized.map((item) => Object.freeze({
                value: cloneAndFreeze(item.value),
                provenance: item.provenance,
            }));
            // Keep public DTOs separate from hidden mutation state. Even mutable
            // built-ins such as Date can then be changed by a caller without altering
            // the key/version-bearing materialized selection.
            this.rows = Object.freeze(frozenMaterialized.map((item) => cloneAndFreeze(item.value)));
            this.headers = Object.freeze([...headers]);
            this.stats = Object.freeze({
                ...stats,
                rangesRead: Object.freeze([...stats.rangesRead]),
                rangesWritten: Object.freeze([...stats.rangesWritten]),
            });
            this[SELECTION_INTERNAL] = Object.freeze({
                materialized: Object.freeze(frozenMaterialized),
                runtime,
                refresh,
                fanoutRequired,
            });
            Object.freeze(this);
        }
        get length() {
            return this.rows.length;
        }
        toJSON() {
            return Object.freeze({
                headers: this.headers,
                rows: Object.freeze(this.rows.map((row) => jsonSafe(row))),
            });
        }
        refresh() {
            const refresh = this[SELECTION_INTERNAL].refresh;
            return refresh === null ? this[SELECTION_INTERNAL].runtime.refresh(this) : refresh();
        }
        update(patch, options = {}) {
            if (this[SELECTION_INTERNAL].fanoutRequired && options.fanout !== true) {
                throw new GQueryRuntimeError("MUTATION_INVALID", "Updating a to-many relation requires { fanout: true }.");
            }
            return this[SELECTION_INTERNAL].runtime.update(this, patch, options);
        }
        delete(options = {}) {
            if (this[SELECTION_INTERNAL].fanoutRequired && options.fanout !== true) {
                throw new GQueryRuntimeError("MUTATION_INVALID", "Deleting through a to-many relation requires { fanout: true }.");
            }
            return this[SELECTION_INTERNAL].runtime.delete(this, options);
        }
        /** Select and deduplicate the physical rows retained for an included/joined relation. */
        related(name) {
            var _a;
            const seen = new Set();
            const related = [];
            let fanoutRequired = false;
            for (const item of this[SELECTION_INTERNAL].materialized) {
                const provenances = (_a = item.provenance.relations[name]) !== null && _a !== void 0 ? _a : [];
                if (item.provenance.relationCardinalities[name] === "many" ||
                    provenances.length > 1) {
                    fanoutRequired = true;
                }
                const raw = item.value[name];
                const values = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
                for (let index = 0; index < provenances.length; index += 1) {
                    const provenance = provenances[index];
                    const identity = `${provenance.spreadsheetId}:${provenance.sheetId}:${provenance.rowIndex}`;
                    if (seen.has(identity))
                        continue;
                    const value = values[index];
                    if (value === undefined || value === null || typeof value !== "object")
                        continue;
                    seen.add(identity);
                    related.push({ value, provenance });
                }
            }
            if (related.length === 0) {
                const knownRelation = this[SELECTION_INTERNAL].materialized.some((item) => Object.prototype.hasOwnProperty.call(item.provenance.relations, name));
                if (!knownRelation) {
                    throw new GQueryRuntimeError("RELATION_NOT_FOUND", `Relation ${name} was not materialized. Add include(${JSON.stringify(name)}) or join it first.`);
                }
            }
            const headers = related.length === 0
                ? []
                : Object.keys(related[0].value);
            return new Selection(related, headers, this.stats, this[SELECTION_INTERNAL].runtime, null, fanoutRequired);
        }
    }
    function selectionProvenance(selection) {
        return selection[SELECTION_INTERNAL].materialized.map((item) => item.provenance);
    }

    function canonicalNode(value, ancestors) {
        if (value === null)
            return ["null"];
        if (typeof value === "boolean")
            return ["boolean", value];
        if (typeof value === "string")
            return ["string", value];
        if (typeof value === "number") {
            if (!Number.isFinite(value))
                throw new TypeError("Canonical values cannot contain NaN or Infinity.");
            if (Object.is(value, -0))
                return ["number", "-0"];
            return ["number", String(value)];
        }
        if (typeof value === "bigint")
            return ["bigint", value.toString()];
        if (value instanceof Date) {
            if (!Number.isFinite(value.getTime()))
                throw new TypeError("Canonical values cannot contain an invalid Date.");
            return ["date", value.toISOString()];
        }
        if (typeof value !== "object") {
            throw new TypeError(`Canonical values cannot contain ${typeof value}.`);
        }
        if (ancestors.includes(value))
            throw new TypeError("Canonical values cannot contain cycles.");
        const nextAncestors = [...ancestors, value];
        if (Array.isArray(value)) {
            return ["array", value.map((item) => canonicalNode(item, nextAncestors))];
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError("Canonical values must use plain objects, arrays, dates, or primitives.");
        }
        const record = value;
        const entries = [];
        for (const key of Object.keys(record).sort()) {
            if (record[key] === undefined)
                continue;
            entries.push([key, canonicalNode(record[key], nextAncestors)]);
        }
        return ["object", entries];
    }
    /** Stable, type-preserving serialization used only for fingerprints and cache keys. */
    function canonicalStringify(value) {
        return JSON.stringify(canonicalNode(value, []));
    }
    function hashCanonical(value, hasher) {
        return hasher.hash(canonicalStringify(value));
    }
    class AppsScriptSha256Hash {
        hash(value) {
            const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
            return bytes.map((byte) => (byte & 0xff).toString(16).padStart(2, "0")).join("");
        }
    }
    /** A deterministic non-cryptographic implementation useful for isolated tests and in-memory transports. */
    class Fnv1aHash {
        hash(value) {
            let hash = 0x811c9dc5;
            for (let index = 0; index < value.length; index += 1) {
                hash ^= value.charCodeAt(index);
                hash = Math.imul(hash, 0x01000193);
            }
            return (hash >>> 0).toString(16).padStart(8, "0");
        }
    }

    const systemClock = {
        now: () => Date.now(),
    };
    const appsScriptSleeper = {
        sleep: (milliseconds) => Utilities.sleep(milliseconds),
    };
    const mathRandomSource = {
        next: () => Math.random(),
    };
    class AppsScriptCacheStore {
        constructor(cache) {
            this.cache = cache;
        }
        get(key) {
            return this.cache.get(key);
        }
        getMany(keys) {
            const values = this.cache.getAll([...keys]);
            const result = {};
            for (const key of keys) {
                const value = values[key];
                if (typeof value === "string")
                    result[key] = value;
            }
            return result;
        }
        put(key, value, ttlSeconds) {
            this.cache.put(key, value, ttlSeconds);
        }
        putMany(values, ttlSeconds) {
            this.cache.putAll({ ...values }, ttlSeconds);
        }
        remove(key) {
            this.cache.remove(key);
        }
        removeMany(keys) {
            if (keys.length > 0)
                this.cache.removeAll([...keys]);
        }
    }
    class AppsScriptPropertyStore {
        constructor(properties) {
            this.properties = properties;
        }
        get(key) {
            return this.properties.getProperty(key);
        }
        getMany() {
            return this.properties.getProperties();
        }
        set(key, value) {
            this.properties.setProperty(key, value);
        }
        setMany(values) {
            this.properties.setProperties({ ...values });
        }
        remove(key) {
            this.properties.deleteProperty(key);
        }
        removeMany(keys) {
            for (const key of keys)
                this.properties.deleteProperty(key);
        }
    }
    class AppsScriptLock {
        constructor(lock) {
            this.lock = lock;
        }
        tryAcquire(timeoutMs) {
            return this.lock.tryLock(timeoutMs);
        }
        release() {
            if (this.lock.hasLock())
                this.lock.releaseLock();
        }
    }
    function withLock(lock, timeoutMs, operation) {
        if (!lock.tryAcquire(timeoutMs)) {
            throw new Error(`Could not acquire the GQuery lock within ${timeoutMs}ms.`);
        }
        try {
            return operation();
        }
        finally {
            lock.release();
        }
    }

    class AppsScriptGzipBase64Codec {
        constructor() {
            this.name = "gzip-base64-v1";
        }
        encode(value) {
            const compressed = Utilities.gzip(Utilities.newBlob(value, "application/json"));
            return Utilities.base64Encode(compressed.getBytes());
        }
        decode(value) {
            const compressed = Utilities.newBlob(Utilities.base64Decode(value), "application/gzip");
            return Utilities.ungzip(compressed).getDataAsString("UTF-8");
        }
    }
    class PlainTextCacheCodec {
        constructor() {
            this.name = "plain-text-v1";
        }
        encode(value) {
            return value;
        }
        decode(value) {
            return value;
        }
    }
    function parseManifest$1(value) {
        var _a;
        if (value === null)
            return null;
        try {
            const parsed = JSON.parse(value);
            if (parsed.version !== 1 ||
                typeof parsed.codec !== "string" ||
                typeof parsed.generation !== "string" ||
                !Number.isInteger(parsed.chunks) ||
                ((_a = parsed.chunks) !== null && _a !== void 0 ? _a : 0) < 1 ||
                typeof parsed.checksum !== "string" ||
                typeof parsed.createdAtMs !== "number") {
                return null;
            }
            return parsed;
        }
        catch {
            return null;
        }
    }
    function validateTtl(policy) {
        var _a, _b;
        const ttlSeconds = (_a = policy.ttlSeconds) !== null && _a !== void 0 ? _a : 300;
        const jitterSeconds = (_b = policy.jitterSeconds) !== null && _b !== void 0 ? _b : 0;
        if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 21600) {
            throw new GQueryV2Error("CACHE_CONFIGURATION", "Cache TTL must be an integer from 1 to 21600 seconds.", { ttlSeconds });
        }
        if (!Number.isInteger(jitterSeconds) || jitterSeconds < 0 || jitterSeconds >= ttlSeconds) {
            throw new GQueryV2Error("CACHE_CONFIGURATION", "Cache jitter must be a non-negative integer smaller than the TTL.", { jitterSeconds, ttlSeconds });
        }
        return { ttlSeconds, jitterSeconds };
    }
    /**
     * A CacheService-safe value cache. Chunks are immutable and the manifest is
     * published last, so incomplete publication and early eviction are cache misses.
     */
    class ChunkedCache {
        constructor(dependencies) {
            var _a, _b, _c, _d, _e;
            this.dependencies = dependencies;
            this.clock = (_a = dependencies.clock) !== null && _a !== void 0 ? _a : systemClock;
            this.random = (_b = dependencies.random) !== null && _b !== void 0 ? _b : mathRandomSource;
            this.namespace = (_c = dependencies.namespace) !== null && _c !== void 0 ? _c : "gq2";
            this.maxChunkCharacters = (_d = dependencies.maxChunkCharacters) !== null && _d !== void 0 ? _d : 90000;
            this.lockTimeoutMs = (_e = dependencies.lockTimeoutMs) !== null && _e !== void 0 ? _e : 1000;
            if (!Number.isInteger(this.maxChunkCharacters) || this.maxChunkCharacters < 1 || this.maxChunkCharacters > 95000) {
                throw new GQueryV2Error("CACHE_CONFIGURATION", "Cache chunks must contain between 1 and 95000 characters.", { maxChunkCharacters: this.maxChunkCharacters });
            }
        }
        read(logicalKey) {
            const baseKey = this.baseKey(logicalKey);
            const manifestKey = `${baseKey}:manifest`;
            let rawManifest;
            try {
                rawManifest = this.dependencies.store.get(manifestKey);
            }
            catch {
                return { state: "miss" };
            }
            if (rawManifest === null)
                return { state: "miss" };
            const manifest = parseManifest$1(rawManifest);
            if (manifest === null || manifest.codec !== this.dependencies.codec.name) {
                this.removePhysical(manifestKey, []);
                return { state: "corrupt" };
            }
            const chunkKeys = Array.from({ length: manifest.chunks }, (_, index) => `${baseKey}:${manifest.generation}:${index}`);
            let chunks;
            try {
                chunks = this.dependencies.store.getMany(chunkKeys);
            }
            catch {
                return { state: "miss" };
            }
            if (chunkKeys.some((key) => typeof chunks[key] !== "string")) {
                this.removePhysical(manifestKey, chunkKeys);
                return { state: "corrupt" };
            }
            const encoded = chunkKeys.map((key) => chunks[key]).join("");
            if (this.dependencies.hasher.hash(encoded) !== manifest.checksum) {
                this.removePhysical(manifestKey, chunkKeys);
                return { state: "corrupt" };
            }
            try {
                const decoded = this.dependencies.codec.decode(encoded);
                return { state: "hit", value: JSON.parse(decoded) };
            }
            catch {
                this.removePhysical(manifestKey, chunkKeys);
                return { state: "corrupt" };
            }
        }
        get(logicalKey) {
            const result = this.read(logicalKey);
            return result.state === "hit" ? result.value : null;
        }
        put(logicalKey, value, policy = {}) {
            const validated = validateTtl(policy);
            const random = Math.max(0, Math.min(0.999999999999, this.random.next()));
            const jitter = Math.floor(random * (validated.jitterSeconds + 1));
            const effectiveTtl = Math.max(1, validated.ttlSeconds - jitter);
            const serialized = JSON.stringify(value);
            if (serialized === undefined) {
                throw new TypeError("The cache value is not JSON serializable.");
            }
            const encoded = this.dependencies.codec.encode(serialized);
            const chunks = this.split(encoded);
            const baseKey = this.baseKey(logicalKey);
            const manifestKey = `${baseKey}:manifest`;
            const oldManifest = parseManifest$1(this.dependencies.store.get(manifestKey));
            const generation = this.dependencies.ids.next();
            const chunkValues = {};
            const chunkKeys = [];
            for (let index = 0; index < chunks.length; index += 1) {
                const key = `${baseKey}:${generation}:${index}`;
                chunkKeys.push(key);
                chunkValues[key] = chunks[index];
            }
            const manifest = {
                version: 1,
                codec: this.dependencies.codec.name,
                generation,
                chunks: chunks.length,
                checksum: this.dependencies.hasher.hash(encoded),
                createdAtMs: this.clock.now(),
            };
            try {
                this.dependencies.store.putMany(chunkValues, effectiveTtl);
                // Publication point. Readers cannot observe the new generation before this write.
                this.dependencies.store.put(manifestKey, JSON.stringify(manifest), effectiveTtl);
            }
            catch (error) {
                try {
                    this.dependencies.store.removeMany(chunkKeys);
                }
                catch {
                    // The old manifest is still authoritative; orphaned chunks expire naturally.
                }
                throw error;
            }
            if (oldManifest !== null && oldManifest.generation !== generation) {
                try {
                    this.dependencies.store.removeMany(Array.from({ length: oldManifest.chunks }, (_, index) => `${baseKey}:${oldManifest.generation}:${index}`));
                }
                catch {
                    // The old immutable chunks are unreachable and will expire.
                }
            }
        }
        remove(logicalKey) {
            const baseKey = this.baseKey(logicalKey);
            const manifestKey = `${baseKey}:manifest`;
            const manifest = parseManifest$1(this.dependencies.store.get(manifestKey));
            const chunkKeys = manifest === null
                ? []
                : Array.from({ length: manifest.chunks }, (_, index) => `${baseKey}:${manifest.generation}:${index}`);
            this.removePhysical(manifestKey, chunkKeys);
        }
        readThrough(logicalKey, producer, policy = {}) {
            const first = this.read(logicalKey);
            if (first.state === "hit")
                return { value: first.value, cache: "hit" };
            const lock = this.dependencies.lock;
            let acquired = false;
            if (lock !== undefined) {
                try {
                    acquired = lock.tryAcquire(this.lockTimeoutMs);
                }
                catch {
                    acquired = false;
                }
            }
            if (lock === undefined || !acquired) {
                const value = producer();
                if (lock === undefined && this.tryPut(logicalKey, value, policy)) {
                    return { value, cache: "filled" };
                }
                return { value, cache: "uncached" };
            }
            try {
                const second = this.read(logicalKey);
                if (second.state === "hit")
                    return { value: second.value, cache: "hit-after-wait" };
                const value = producer();
                return {
                    value,
                    cache: this.tryPut(logicalKey, value, policy) ? "filled" : "uncached",
                };
            }
            finally {
                try {
                    lock.release();
                }
                catch {
                    // Single-flight locks are an optimization; the cache value was already published.
                }
            }
        }
        baseKey(logicalKey) {
            return `${this.namespace}:cache:${hashCanonical(logicalKey, this.dependencies.hasher)}`;
        }
        split(value) {
            if (value.length === 0)
                return [""];
            const result = [];
            for (let offset = 0; offset < value.length; offset += this.maxChunkCharacters) {
                result.push(value.slice(offset, offset + this.maxChunkCharacters));
            }
            return result;
        }
        removePhysical(manifestKey, chunkKeys) {
            try {
                this.dependencies.store.remove(manifestKey);
                this.dependencies.store.removeMany(chunkKeys);
            }
            catch {
                // Cache invalidation is best effort and must not fail the caller.
            }
        }
        tryPut(logicalKey, value, policy) {
            try {
                this.put(logicalKey, value, policy);
                return true;
            }
            catch {
                return false;
            }
        }
    }
    /** Durable generation tokens make old cache entries unreachable without a key registry. */
    class GenerationTokenStore {
        constructor(properties, hasher, ids, namespace = "gq2") {
            this.properties = properties;
            this.hasher = hasher;
            this.ids = ids;
            this.namespace = namespace;
        }
        current(dependency) {
            var _a;
            return (_a = this.properties.get(this.key(dependency))) !== null && _a !== void 0 ? _a : "0";
        }
        snapshot(dependencies) {
            return dependencies
                .map((dependency) => ({ dependency, token: this.current(dependency) }))
                .sort((left, right) => canonicalStringify(left.dependency).localeCompare(canonicalStringify(right.dependency)));
        }
        rotate(dependency) {
            const token = this.ids.next();
            this.properties.set(this.key(dependency), token);
            return token;
        }
        invalidateTable(sourceId, table) {
            return this.rotate({ kind: "table", sourceId, table });
        }
        invalidateRow(sourceId, table, key) {
            return this.rotate({ kind: "row", sourceId, table, key });
        }
        invalidateTag(tag) {
            return this.rotate({ kind: "tag", tag });
        }
        /** Rotate the table dependency plus optional narrow row/tag dependencies after a committed write. */
        invalidateWrite(sourceId, table, rowKeys = [], tags = []) {
            const dependencies = [{ kind: "table", sourceId, table }];
            dependencies.push(...rowKeys.map((key) => ({ kind: "row", sourceId, table, key })));
            dependencies.push(...tags.map((tag) => ({ kind: "tag", tag })));
            return dependencies.map((dependency) => ({ dependency, token: this.rotate(dependency) }));
        }
        key(dependency) {
            return `${this.namespace}:generation:${hashCanonical(dependency, this.hasher)}`;
        }
    }
    function buildQueryCacheKey(input) {
        var _a, _b, _c;
        return {
            kind: "query",
            sourceIdentity: input.sourceIdentity,
            schemaVersion: input.schemaVersion,
            headerVersion: input.headerVersion,
            query: input.query,
            projection: (_a = input.projection) !== null && _a !== void 0 ? _a : [],
            renderOptions: (_b = input.renderOptions) !== null && _b !== void 0 ? _b : null,
            scopeIdentity: (_c = input.scopeIdentity) !== null && _c !== void 0 ? _c : null,
            generations: input.generations,
        };
    }
    function appsScriptCache(scope) {
        if (scope === "script")
            return CacheService.getScriptCache();
        if (scope === "user")
            return CacheService.getUserCache();
        const cache = CacheService.getDocumentCache();
        if (cache === null) {
            throw new GQueryV2Error("CACHE_CONFIGURATION", "Document cache is unavailable outside a container-bound Apps Script project.");
        }
        return cache;
    }
    function createAppsScriptChunkedCache(options = {}) {
        var _a, _b;
        const scope = (_a = options.scope) !== null && _a !== void 0 ? _a : "script";
        const defaultLock = scope === "script"
            ? LockService.getScriptLock()
            : scope === "user"
                ? LockService.getUserLock()
                : LockService.getDocumentLock();
        return new ChunkedCache({
            store: new AppsScriptCacheStore(appsScriptCache(scope)),
            codec: new AppsScriptGzipBase64Codec(),
            hasher: new AppsScriptSha256Hash(),
            ids: { next: () => Utilities.getUuid() },
            lock: (_b = options.lock) !== null && _b !== void 0 ? _b : new AppsScriptLock(defaultLock),
            namespace: options.namespace,
        });
    }
    function createAppsScriptGenerationStore(namespace) {
        return new GenerationTokenStore(new AppsScriptPropertyStore(PropertiesService.getScriptProperties()), new AppsScriptSha256Hash(), { next: () => Utilities.getUuid() }, namespace);
    }

    function invalidJoin(message, details) {
        throw new GQueryRuntimeError("INVALID_QUERY", message, { details });
    }
    function keyFields(value, side, alias) {
        if (typeof value !== "string" && !Array.isArray(value)) {
            return invalidJoin(`Join ${alias} ${side} key must be a field or field array.`, {
                alias,
                side,
                value,
            });
        }
        const fields = typeof value === "string" ? [value] : value;
        if (fields.length === 0) {
            return invalidJoin(`Join ${alias} ${side} key must contain at least one field.`, {
                alias,
                side,
            });
        }
        if (fields.some((field) => typeof field !== "string" || field.length === 0)) {
            return invalidJoin(`Join ${alias} ${side} key contains an invalid field name.`, {
                alias,
                side,
                fields,
            });
        }
        if (new Set(fields).size !== fields.length) {
            return invalidJoin(`Join ${alias} ${side} key contains duplicate fields.`, {
                alias,
                side,
                fields,
            });
        }
        return fields;
    }
    function requireTable(tables, tableName, alias) {
        const table = tables[tableName];
        if (table === undefined) {
            return invalidJoin(`Join ${alias} references unknown table ${tableName}.`, {
                alias,
                table: tableName,
            });
        }
        return table;
    }
    function missingFields(fields, table) {
        return fields.filter((field) => !(field in table.columns));
    }
    const PREDICATE_OPERATORS = new Set([
        "eq", "ne", "in", "notIn", "gt", "gte", "lt", "lte", "between",
        "contains", "startsWith", "endsWith", "isBlank", "isNull",
    ]);
    function validatePredicate(node, tableName, table) {
        if (node === null || typeof node !== "object") {
            invalidJoin(`Query for ${tableName} contains an invalid predicate node.`, { table: tableName, node });
        }
        if (node.kind === "constant") {
            if (typeof node.value !== "boolean") {
                invalidJoin(`Query for ${tableName} contains an invalid constant predicate.`, { table: tableName, node });
            }
            return;
        }
        if (node.kind === "field") {
            if (!(node.field in table.columns)) {
                invalidJoin(`Query for ${tableName} references unknown predicate field ${String(node.field)}.`, {
                    table: tableName,
                    field: node.field,
                    location: "predicate",
                });
            }
            if (!PREDICATE_OPERATORS.has(node.operator)) {
                invalidJoin(`Query for ${tableName} contains invalid predicate operator ${String(node.operator)}.`, {
                    table: tableName,
                    field: node.field,
                    operator: node.operator,
                });
            }
            return;
        }
        if (node.kind === "not") {
            validatePredicate(node.node, tableName, table);
            return;
        }
        if (node.kind === "and" || node.kind === "or") {
            if (!Array.isArray(node.nodes)) {
                invalidJoin(`Query for ${tableName} contains an invalid ${node.kind} predicate.`, { table: tableName, node });
            }
            for (const child of node.nodes)
                validatePredicate(child, tableName, table);
            return;
        }
        invalidJoin(`Query for ${tableName} contains an unknown predicate kind.`, { table: tableName, node });
    }
    function validateBaseQuery(plan, table) {
        if (plan.source !== table.source) {
            invalidJoin(`Query for ${plan.table} has an invalid source ${String(plan.source)}.`, {
                table: plan.table,
                expectedSource: table.source,
                actualSource: plan.source,
            });
        }
        if (plan.predicate !== undefined)
            validatePredicate(plan.predicate, plan.table, table);
        if (plan.projection !== undefined) {
            if (!Array.isArray(plan.projection) || plan.projection.some((field) => typeof field !== "string" || field.length === 0)) {
                invalidJoin(`Query for ${plan.table} select must be an array of field names.`, {
                    table: plan.table,
                    projection: plan.projection,
                });
            }
            const missing = missingFields(plan.projection, table);
            if (missing.length > 0) {
                invalidJoin(`Query for ${plan.table} selects unknown field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`, {
                    table: plan.table,
                    missing,
                    location: "projection",
                });
            }
            if (new Set(plan.projection).size !== plan.projection.length) {
                invalidJoin(`Query for ${plan.table} contains duplicate selected fields.`, {
                    table: plan.table,
                    projection: plan.projection,
                });
            }
        }
        if (!Array.isArray(plan.orderBy)) {
            invalidJoin(`Query for ${plan.table} orderBy must be an array.`, { table: plan.table, orderBy: plan.orderBy });
        }
        for (const clause of plan.orderBy) {
            if (clause === null || typeof clause !== "object" || !(clause.field in table.columns)) {
                invalidJoin(`Query for ${plan.table} orders by unknown field ${String(clause === null || clause === void 0 ? void 0 : clause.field)}.`, {
                    table: plan.table,
                    field: clause === null || clause === void 0 ? void 0 : clause.field,
                    location: "orderBy",
                });
            }
            if (clause.direction !== "asc" && clause.direction !== "desc") {
                invalidJoin(`Query for ${plan.table} has invalid order direction ${String(clause.direction)}.`, {
                    table: plan.table,
                    field: clause.field,
                    direction: clause.direction,
                });
            }
        }
    }
    function validateJoin(baseName, base, target, join, occupied) {
        var _a;
        if (typeof join.alias !== "string" || join.alias.trim().length === 0) {
            invalidJoin("Join aliases must be non-empty strings.", {
                alias: join.alias,
                table: join.table,
            });
        }
        if (!["left", "inner", "semi", "anti"].includes(join.kind)) {
            invalidJoin(`Join ${join.alias} has invalid kind ${String(join.kind)}.`, {
                alias: join.alias,
                kind: join.kind,
            });
        }
        if (join.cardinality !== "one" && join.cardinality !== "many") {
            invalidJoin(`Join ${join.alias} has invalid cardinality ${String(join.cardinality)}.`, { alias: join.alias, cardinality: join.cardinality });
        }
        if (occupied.has(join.alias)) {
            invalidJoin(`Join alias ${join.alias} collides with a ${join.alias in base.columns ? "base column" : "prior join alias"}.`, {
                alias: join.alias,
                baseTable: baseName,
                collision: join.alias in base.columns ? "base-column" : "join-alias",
            });
        }
        const local = keyFields(join.localField, "local", join.alias);
        const foreign = keyFields(join.foreignField, "foreign", join.alias);
        if (local.length !== foreign.length) {
            invalidJoin(`Join ${join.alias} local and foreign keys have different arity.`, {
                alias: join.alias,
                local,
                foreign,
            });
        }
        const missingLocal = missingFields(local, base);
        if (missingLocal.length > 0) {
            invalidJoin(`Join ${join.alias} references unknown ${baseName} local field${missingLocal.length === 1 ? "" : "s"}: ${missingLocal.join(", ")}.`, {
                alias: join.alias,
                side: "local",
                table: baseName,
                missing: missingLocal,
            });
        }
        const missingForeign = missingFields(foreign, target);
        if (missingForeign.length > 0) {
            invalidJoin(`Join ${join.alias} references unknown ${join.table} foreign field${missingForeign.length === 1 ? "" : "s"}: ${missingForeign.join(", ")}.`, {
                alias: join.alias,
                side: "foreign",
                table: join.table,
                missing: missingForeign,
            });
        }
        if (join.select !== undefined &&
            (!Array.isArray(join.select) ||
                join.select.some((field) => typeof field !== "string" || field.length === 0))) {
            invalidJoin(`Join ${join.alias} select must be an array of field names.`, {
                alias: join.alias,
                select: join.select,
            });
        }
        const select = (_a = join.select) !== null && _a !== void 0 ? _a : [];
        const missingSelect = missingFields(select, target);
        if (missingSelect.length > 0) {
            invalidJoin(`Join ${join.alias} selects unknown ${join.table} field${missingSelect.length === 1 ? "" : "s"}: ${missingSelect.join(", ")}.`, {
                alias: join.alias,
                side: "select",
                table: join.table,
                missing: missingSelect,
            });
        }
    }
    /** Validate a complete immutable join chain before any source is resolved or read. */
    function validateJoinPlan(schema, plan) {
        const tables = schema.tables;
        const base = requireTable(tables, plan.table, "<base>");
        validateBaseQuery(plan, base);
        const occupied = new Set(Object.keys(base.columns));
        for (const join of plan.joins) {
            const target = requireTable(tables, join.table, join.alias);
            validateJoin(plan.table, base, target, join, occupied);
            occupied.add(join.alias);
        }
    }

    function asArray(value) {
        return typeof value === "string" ? [value] : value;
    }
    function toSheetInput(value) {
        return value === BLANK_CELL ? null : value;
    }
    /** Formula provenance/cache/journal values use the FORMULA-rendered string. */
    function storedSheetValue(value) {
        return isFormulaCell(value) ? value.expression : value;
    }
    function tableUsesFormula$1(definition) {
        return Object.values(definition.columns).some((column) => column.kind === "formula");
    }
    function rawCell(value) {
        return value === undefined ? null : value;
    }
    function decodeCell$1(value) {
        return value === undefined || value === null || value === "" ? BLANK_CELL : value;
    }
    function sameCell(left, right) {
        return Object.is(rawCell(left), rawCell(right));
    }
    function sameLogical(left, right) {
        if (Object.is(left, right))
            return true;
        try {
            return canonicalStringify$1(left) === canonicalStringify$1(right);
        }
        catch {
            return false;
        }
    }
    function keyFingerprint(row, keys) {
        return canonicalStringify$1(keys.map((key) => row[key]));
    }
    function collectPredicateFields(node, fields) {
        if (node === undefined || node.kind === "constant")
            return;
        if (node.kind === "field") {
            fields.add(node.field);
            return;
        }
        if (node.kind === "not") {
            collectPredicateFields(node.node, fields);
            return;
        }
        for (const child of node.nodes)
            collectPredicateFields(child, fields);
    }
    function relationFingerprint(row, keys) {
        const values = keys.map((key) => row[key]);
        return values.some((value) => value === null || value === undefined)
            ? null
            : canonicalStringify$1(values);
    }
    function materializedIdentity(item) {
        return `${item.provenance.spreadsheetId}:${item.provenance.sheetId}:${item.provenance.rowIndex}`;
    }
    function baseMutationChanges(original, definition, changes, fromCallback) {
        const unknown = Object.keys(changes).filter((field) => {
            if (field in definition.columns)
                return false;
            return !(fromCallback && field in original &&
                sameLogical(original[field], changes[field]));
        });
        if (unknown.length > 0) {
            throw new GQueryRuntimeError("MUTATION_INVALID", `Unknown mutation column${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
        }
        return Object.fromEntries(Object.entries(changes).filter(([field]) => field in definition.columns));
    }
    function equalityFields(predicate) {
        if (predicate === undefined)
            return null;
        const result = new Map();
        const visit = (node) => {
            if (node.kind === "constant")
                return node.value;
            if (node.kind === "and")
                return node.nodes.every(visit);
            if (node.kind !== "field")
                return false;
            if (node.operator !== "eq")
                return true;
            if (result.has(node.field) && !sameLogical(result.get(node.field), node.value))
                return false;
            result.set(node.field, node.value);
            return true;
        };
        return visit(predicate) ? result : null;
    }
    function estimateBytes(value) {
        try {
            return JSON.stringify(value).length;
        }
        catch {
            return 0;
        }
    }
    function isQuotaFailure(error, seen = new Set()) {
        var _a;
        if (typeof error !== "object" || error === null) {
            const message = String(error).toLowerCase();
            return message.includes("quota") || message.includes("rate limit") || message.includes("too many requests");
        }
        if (seen.has(error))
            return false;
        seen.add(error);
        const candidate = error;
        if (candidate.code === "API_RATE_LIMIT")
            return true;
        if (candidate instanceof GQueryV2Error && candidate.code === "RETRY_EXHAUSTED") {
            const details = candidate.details;
            if (((_a = details.lastFailure) === null || _a === void 0 ? void 0 : _a.kind) === "rate-limit")
                return true;
        }
        const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
        if (message.includes("quota exceeded") ||
            message.includes("rate limit") ||
            message.includes("too many requests") ||
            message.includes("resource_exhausted") ||
            message.includes("service invoked too many times")) {
            return true;
        }
        return isQuotaFailure(candidate.cause, seen) ||
            isQuotaFailure(candidate.details, seen) ||
            isQuotaFailure(candidate.api, seen);
    }
    function mutableStats(stats) {
        return {
            ...stats,
            rangesRead: [...stats.rangesRead],
            rangesWritten: [...stats.rangesWritten],
        };
    }
    function cloneStats(stats) {
        return mutableStats(stats);
    }
    function addStats(target, source) {
        target.apiCalls += source.apiCalls;
        target.cellsRead += source.cellsRead;
        target.cellsWritten += source.cellsWritten;
        target.bytesRead += source.bytesRead;
        target.bytesWritten += source.bytesWritten;
        target.cacheHits += source.cacheHits;
        target.cacheMisses += source.cacheMisses;
        target.staleCacheHits += source.staleCacheHits;
        target.retries += source.retries;
        target.elapsedMs += source.elapsedMs;
        target.lockWaitMs += source.lockWaitMs;
        target.fullScans += source.fullScans;
        target.joinFanOut += source.joinFanOut;
        target.rangesRead.push(...source.rangesRead);
        target.rangesWritten.push(...source.rangesWritten);
    }
    function projectRow(row, fields) {
        if (fields === undefined)
            return { ...row };
        const projected = {};
        for (const field of fields)
            projected[field] = row[field];
        return projected;
    }
    /** Purely synchronous schema/query executor over an injectable Sheets transport. */
    class GQueryExecutor {
        constructor(schema, options) {
            var _a;
            this.schema = schema;
            this.options = options;
            this.metadata = new Map();
            this.knownSheets = new Map();
            this.knownSheetTitles = new Map();
            this.headers = new Map();
            this.locators = new Map();
            this.deferredOverlaySuppression = 0;
            this.readCacheSuppression = 0;
            this.now = (_a = options.now) !== null && _a !== void 0 ? _a : (() => new Date());
        }
        execute(query) {
            const result = this.executeBatch({
                result: query,
            });
            return {
                selection: result.selections.result,
                plan: result.plans.result,
            };
        }
        /** Internal flush hook: deferred delivery must compare against physical state. */
        withoutDeferredOverlay(operation) {
            this.deferredOverlaySuppression += 1;
            try {
                return operation();
            }
            finally {
                this.deferredOverlaySuppression -= 1;
            }
        }
        /**
         * Optimistic deferred rows are suitable for reads and further deferred
         * composition, but never as physical coordinates for an immediate write.
         */
        assertNoDeferredOverlayRows(rows, operation) {
            var _a, _b, _c;
            if (this.deferredOverlaySuppression > 0)
                return;
            const pending = (_b = (_a = this.options.deferredJournal) === null || _a === void 0 ? void 0 : _a.readAndRebuildOverlay()) !== null && _b !== void 0 ? _b : this.pendingDeferredEntries();
            const pendingByTarget = new Map();
            for (const entry of pending) {
                const target = `${entry.sourceId}\u0000${entry.table}\u0000${canonicalStringify$1(entry.key)}`;
                const matches = (_c = pendingByTarget.get(target)) !== null && _c !== void 0 ? _c : [];
                matches.push(entry);
                pendingByTarget.set(target, matches);
            }
            const affected = rows.flatMap((row) => {
                var _a;
                const target = `${row.provenance.spreadsheetId}\u0000${row.provenance.tableName}\u0000${canonicalStringify$1(row.provenance.encodedPrimaryKey)}`;
                const matchingEntries = (_a = pendingByTarget.get(target)) !== null && _a !== void 0 ? _a : [];
                if (row.provenance.deferredOverlay === undefined && matchingEntries.length === 0)
                    return [];
                return [{ row, matchingEntries }];
            });
            if (affected.length === 0)
                return;
            throw new GQueryRuntimeError("MUTATION_CONFLICT", `Cannot ${operation} from a selection containing unflushed deferred state. Flush the deferred journal and refresh the selection, or use deferred delivery for the new mutation.`, {
                details: {
                    rows: affected.map(({ row, matchingEntries }) => {
                        var _a, _b, _c, _d, _e, _f;
                        return ({
                            table: row.provenance.tableName,
                            key: row.provenance.primaryKey,
                            virtual: (_b = (_a = row.provenance.deferredOverlay) === null || _a === void 0 ? void 0 : _a.virtual) !== null && _b !== void 0 ? _b : false,
                            mutationIds: [...new Set([
                                    ...((_d = (_c = row.provenance.deferredOverlay) === null || _c === void 0 ? void 0 : _c.mutationIds) !== null && _d !== void 0 ? _d : []),
                                    ...matchingEntries.map((entry) => entry.id),
                                ])],
                            fields: [...new Set([
                                    ...((_f = (_e = row.provenance.deferredOverlay) === null || _e === void 0 ? void 0 : _e.fields) !== null && _f !== void 0 ? _f : []),
                                    ...matchingEntries.flatMap((entry) => { var _a; return Object.keys((_a = entry.values) !== null && _a !== void 0 ? _a : {}); }),
                                ])],
                        });
                    }),
                },
            });
        }
        /** Internal flush hook: journal preflight reads must observe physical Sheets state. */
        withoutReadCache(operation) {
            this.readCacheSuppression += 1;
            try {
                return operation();
            }
            finally {
                this.readCacheSuppression -= 1;
            }
        }
        executeBatch(queries) {
            return this.scoped(() => this.executeBatchUnscoped(queries));
        }
        executeBatchUnscoped(queries) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
            const startedAt = Date.now();
            for (const query of Object.values(queries)) {
                validateJoinPlan(this.schema, query.plan);
            }
            const requestedTables = new Set();
            for (const query of Object.values(queries)) {
                requestedTables.add(query.plan.table);
                for (const join of query.plan.joins)
                    requestedTables.add(join.table);
            }
            const identities = new Map();
            for (const tableName of requestedTables) {
                identities.set(tableName, this.tableIdentity(tableName));
            }
            const snapshots = new Map();
            const readStats = createExecutionStats();
            const resolved = new Map();
            const cacheHitTables = new Set();
            const staleHitTables = new Set();
            const staleCandidates = new Map();
            for (const identity of identities.values()) {
                const freshEntries = this.freshCacheEntries(identity, queries, identities);
                const snapshot = this.cachedSnapshotFrom(identity, freshEntries);
                if (snapshot !== null) {
                    resolved.set(identity.tableName, snapshot.resolved);
                    snapshots.set(identity.tableName, snapshot);
                    cacheHitTables.add(identity.tableName);
                    readStats.cacheHits += 1;
                }
                else if (freshEntries.length > 0) {
                    readStats.cacheMisses += 1;
                    const stale = this.cachedSnapshotFrom(identity, this.staleCacheEntries(identity, queries, identities));
                    if (stale !== null)
                        staleCandidates.set(identity.tableName, stale);
                }
            }
            const boundedQueries = new Set();
            try {
                for (const identity of identities.values()) {
                    if (resolved.has(identity.tableName))
                        continue;
                    resolved.set(identity.tableName, this.resolveIdentity(identity, readStats));
                }
                const queryEntries = Object.entries(queries);
                if (queryEntries.length === 1) {
                    const [queryName, query] = queryEntries[0];
                    const base = resolved.get(query.plan.table);
                    if (base !== undefined && !snapshots.has(base.tableName)) {
                        this.hydratePersistentLocator(query, base, readStats);
                        const bounded = this.tryBoundedRead(query, base);
                        if (bounded !== null) {
                            snapshots.set(base.tableName, bounded.snapshot);
                            addStats(readStats, bounded.stats);
                            boundedQueries.add(queryName);
                        }
                    }
                }
                const grouped = new Map();
                for (const table of resolved.values()) {
                    if (snapshots.has(table.tableName))
                        continue;
                    const group = (_a = grouped.get(table.spreadsheetId)) !== null && _a !== void 0 ? _a : [];
                    if (!group.some((candidate) => candidate.tableName === table.tableName))
                        group.push(table);
                    grouped.set(table.spreadsheetId, group);
                }
                for (const [spreadsheetId, tables] of grouped) {
                    const leaders = tables.flatMap((table) => this.freshCacheEntries(table, queries, identities)
                        .filter((entry) => entry.cache.readThrough !== undefined)
                        .map((entry) => ({ table, entry }))).sort((left, right) => canonicalStringify$1({
                        table: left.table.tableName,
                        key: left.entry.key,
                    }).localeCompare(canonicalStringify$1({
                        table: right.table.tableName,
                        key: right.entry.key,
                    })));
                    const leader = leaders[0];
                    if (leader === undefined) {
                        const loaded = this.readSnapshotGroup(spreadsheetId, tables, queries, identities, readStats);
                        for (const [tableName, item] of loaded)
                            snapshots.set(tableName, item.snapshot);
                        continue;
                    }
                    const production = {};
                    const readThrough = leader.entry.cache.readThrough.bind(leader.entry.cache);
                    const outcome = readThrough(leader.entry.key, () => {
                        production.loaded = this.readSnapshotGroup(spreadsheetId, tables, queries, identities, readStats, { tableName: leader.table.tableName, key: leader.entry.key });
                        return production.loaded.get(leader.table.tableName).payload;
                    }, {
                        ttlSeconds: (_b = leader.table.definition.cache) === null || _b === void 0 ? void 0 : _b.ttlSeconds,
                        jitterSeconds: (_c = leader.table.definition.cache) === null || _c === void 0 ? void 0 : _c.jitterSeconds,
                    });
                    const produced = production.loaded;
                    if (produced !== undefined) {
                        for (const [tableName, item] of produced)
                            snapshots.set(tableName, item.snapshot);
                        continue;
                    }
                    const leaderSnapshot = this.parseCachedSnapshot(leader.table, outcome.value);
                    if (leaderSnapshot !== null) {
                        snapshots.set(leader.table.tableName, leaderSnapshot);
                        cacheHitTables.add(leader.table.tableName);
                        readStats.cacheHits += 1;
                    }
                    const remaining = [];
                    for (const table of tables) {
                        if (snapshots.has(table.tableName))
                            continue;
                        const snapshot = this.cachedSnapshotFrom(table, this.freshCacheEntries(table, queries, identities));
                        if (snapshot === null) {
                            remaining.push(table);
                        }
                        else {
                            snapshots.set(table.tableName, snapshot);
                            cacheHitTables.add(table.tableName);
                            readStats.cacheHits += 1;
                        }
                    }
                    if (remaining.length > 0) {
                        const loaded = this.readSnapshotGroup(spreadsheetId, remaining, queries, identities, readStats);
                        for (const [tableName, item] of loaded)
                            snapshots.set(tableName, item.snapshot);
                    }
                }
            }
            catch (error) {
                const unresolved = [...identities.values()].filter((identity) => !snapshots.has(identity.tableName));
                if (!isQuotaFailure(error) ||
                    unresolved.length === 0 ||
                    unresolved.some((identity) => !staleCandidates.has(identity.tableName))) {
                    throw error;
                }
                for (const identity of unresolved) {
                    const stale = staleCandidates.get(identity.tableName);
                    resolved.set(identity.tableName, stale.resolved);
                    snapshots.set(identity.tableName, stale);
                    staleHitTables.add(identity.tableName);
                    readStats.staleCacheHits += 1;
                }
            }
            const deferredEntries = this.pendingDeferredEntries();
            const selections = {};
            const plans = {};
            for (const [name, query] of Object.entries(queries)) {
                const queryStats = cloneStats(readStats);
                const baseSnapshot = this.requireSnapshot(snapshots, query.plan.table);
                const baseRows = this.applyDeferredOverlay(baseSnapshot, deferredEntries);
                let materialized = [...((_e = (_d = query.overlayRows) === null || _d === void 0 ? void 0 : _d.call(query, query.plan.table, baseRows)) !== null && _e !== void 0 ? _e : baseRows)];
                if (query.plan.predicate !== undefined) {
                    materialized = materialized.filter((item) => evaluatePredicate(query.plan.predicate, item.value));
                }
                for (const predicate of query.localPredicates) {
                    materialized = materialized.filter((item) => predicate(item.value));
                }
                for (const join of query.plan.joins) {
                    const target = this.requireSnapshot(snapshots, join.table);
                    const deferredTargetRows = this.applyDeferredOverlay(target, deferredEntries);
                    const targetRows = (_g = (_f = query.overlayRows) === null || _f === void 0 ? void 0 : _f.call(query, join.table, deferredTargetRows)) !== null && _g !== void 0 ? _g : deferredTargetRows;
                    const localFields = asArray(join.localField);
                    const foreignFields = asArray(join.foreignField);
                    if (localFields.length !== foreignFields.length) {
                        throw new GQueryRuntimeError("INVALID_QUERY", `Join ${join.alias} key arity does not match.`);
                    }
                    const index = new Map();
                    for (const candidate of targetRows) {
                        const key = keyFingerprint(candidate.value, foreignFields);
                        const matches = (_h = index.get(key)) !== null && _h !== void 0 ? _h : [];
                        matches.push(candidate);
                        index.set(key, matches);
                    }
                    const joined = [];
                    for (const base of materialized) {
                        const key = keyFingerprint(base.value, localFields);
                        const matches = (_j = index.get(key)) !== null && _j !== void 0 ? _j : [];
                        queryStats.joinFanOut += Math.max(0, matches.length - 1);
                        if (join.relationName !== undefined) {
                            const declared = this.table(query.plan.table).relations[join.relationName];
                            if ((declared === null || declared === void 0 ? void 0 : declared.required) === true && matches.length === 0) {
                                throw new GQueryRuntimeError("RELATION_CARDINALITY", `Required relation ${join.relationName} has no ${join.table} row for key ${key}.`, { details: { relation: join.relationName, table: join.table, key } });
                            }
                        }
                        if (join.cardinality === "one" && matches.length > 1) {
                            throw new GQueryRuntimeError("RELATION_CARDINALITY", `Join ${join.alias} expected at most one ${join.table} row for key ${key}.`, { details: { alias: join.alias, table: join.table, key, matches: matches.length } });
                        }
                        if (join.kind === "anti") {
                            if (matches.length === 0)
                                joined.push(base);
                            continue;
                        }
                        if (join.kind === "semi") {
                            if (matches.length > 0)
                                joined.push(base);
                            continue;
                        }
                        if (join.kind === "inner" && matches.length === 0)
                            continue;
                        const nested = join.cardinality === "many"
                            ? matches.map((match) => projectRow(match.value, join.select))
                            : matches.length === 0
                                ? null
                                : projectRow(matches[0].value, join.select);
                        joined.push({
                            value: { ...base.value, [join.alias]: nested },
                            provenance: cloneProvenance(base.provenance, {
                                relations: {
                                    ...base.provenance.relations,
                                    [join.alias]: matches.map((match) => match.provenance),
                                },
                                relationCardinalities: {
                                    ...base.provenance.relationCardinalities,
                                    [join.alias]: join.cardinality,
                                },
                                relationLocalFields: {
                                    ...((_k = base.provenance.relationLocalFields) !== null && _k !== void 0 ? _k : {}),
                                    [join.alias]: Object.freeze([...localFields]),
                                },
                            }),
                        });
                    }
                    materialized = joined;
                }
                for (let index = query.plan.orderBy.length - 1; index >= 0; index -= 1) {
                    const order = query.plan.orderBy[index];
                    materialized.sort((left, right) => {
                        const a = left.value[order.field];
                        const b = right.value[order.field];
                        if (Object.is(a, b))
                            return 0;
                        const comparison = a === null || a === undefined ? -1 : b === null || b === undefined ? 1 : a < b ? -1 : 1;
                        return order.direction === "asc" ? comparison : -comparison;
                    });
                }
                if (query.plan.offset !== undefined)
                    materialized = materialized.slice(query.plan.offset);
                if (query.plan.tail !== undefined)
                    materialized = materialized.slice(-query.plan.tail);
                if (query.plan.limit !== undefined)
                    materialized = materialized.slice(0, query.plan.limit);
                const outputProjection = query.plan.projection === undefined
                    ? undefined
                    : [...new Set([
                            ...query.plan.projection,
                            ...query.plan.joins
                                .filter((join) => join.kind !== "semi" && join.kind !== "anti")
                                .map((join) => join.alias),
                        ])];
                if (outputProjection !== undefined) {
                    materialized = materialized.map((item) => ({
                        value: projectRow(item.value, outputProjection),
                        provenance: item.provenance,
                    }));
                }
                queryStats.elapsedMs = Date.now() - startedAt;
                const queryTables = [query.plan.table, ...query.plan.joins.map((join) => join.table)];
                const executionMode = queryTables.every((tableName) => cacheHitTables.has(tableName) || staleHitTables.has(tableName))
                    ? "cache"
                    : boundedQueries.has(name)
                        ? "bounded"
                        : "full-scan";
                if (executionMode === "full-scan")
                    queryStats.fullScans += 1;
                const headers = materialized.length > 0
                    ? Object.keys(materialized[0].value)
                    : [...(outputProjection !== null && outputProjection !== void 0 ? outputProjection : Object.keys(this.table(query.plan.table).columns))];
                selections[name] = new Selection(materialized, headers, queryStats, this, query.refresh);
                plans[name] = this.explain(query, executionMode, queryStats.rangesRead, queryTables.filter((tableName) => staleHitTables.has(tableName)));
            }
            return { selections, plans };
        }
        explain(query, executedMode, executedRanges = [], staleTables = []) {
            var _a, _b;
            const tables = [query.plan.table, ...query.plan.joins.map((join) => join.table)];
            const sourceIds = new Set();
            const steps = [];
            const mode = executedMode !== null && executedMode !== void 0 ? executedMode : (this.canPlanBounded(query) ? "bounded" : "full-scan");
            for (const tableName of tables) {
                const definition = this.table(tableName);
                const sourceId = this.sourceIdentity(definition.source);
                sourceIds.add(sourceId);
                if (mode === "cache") {
                    steps.push({
                        kind: "cache-read",
                        source: sourceId,
                        table: tableName,
                        ranges: [],
                        detail: staleTables.includes(tableName)
                            ? "Validated stale snapshot used after a Sheets quota failure."
                            : "Validated generation-keyed snapshot cache hit.",
                    });
                }
                else if (mode === "bounded" && tableName === query.plan.table) {
                    steps.push({
                        kind: "locator-read",
                        source: sourceId,
                        table: tableName,
                        ranges: executedMode === "bounded" ? [...executedRanges] : [],
                        columns: [...((_b = (_a = this.indexForQuery(query)) === null || _a === void 0 ? void 0 : _a.fields) !== null && _b !== void 0 ? _b : [])],
                        detail: executedMode === "bounded"
                            ? "Executed indexed locator verification and targeted row reads."
                            : "Indexed locator verification and targeted row reads are available after execution.",
                    });
                }
                else {
                    steps.push({
                        kind: "range-read",
                        source: sourceId,
                        table: tableName,
                        ranges: [sheetRange(definition.sheet)],
                        columns: Object.keys(definition.columns),
                        detail: "Unbounded table scan; execution batches this range with other tables in the workbook.",
                    });
                }
            }
            if (query.plan.predicate !== undefined || query.localPredicates.length > 0) {
                steps.push({
                    kind: "local-filter",
                    source: this.sourceIdentity(this.table(query.plan.table).source),
                    table: query.plan.table,
                    ranges: [],
                    detail: query.localPredicates.length > 0 ? "Includes non-fingerprintable whereLocal callback." : "Typed predicate AST.",
                });
            }
            for (const join of query.plan.joins) {
                steps.push({
                    kind: "join",
                    source: this.sourceIdentity(this.table(join.table).source),
                    table: join.table,
                    ranges: [],
                    detail: `${join.kind} ${join.cardinality} join as ${join.alias}`,
                });
            }
            const warnings = mode === "full-scan" ? [{
                    code: "FULL_SCAN",
                    table: query.plan.table,
                    message: "This query currently requires an unbounded table scan.",
                }] : [];
            if (query.localPredicates.length > 0) {
                warnings.push({
                    code: "LOCAL_FILTER",
                    table: query.plan.table,
                    message: "whereLocal callbacks cannot be persistently fingerprinted or query-cached.",
                });
            }
            if (query.plan.predicate !== undefined &&
                query.localPredicates.length === 0 &&
                this.indexForQuery(query) === null) {
                warnings.push({
                    code: "UNINDEXED_PREDICATE",
                    table: query.plan.table,
                    message: "The typed predicate is not covered by a declared primary, unique, or cache index.",
                });
            }
            for (const join of query.plan.joins) {
                if (join.cardinality !== "many")
                    continue;
                warnings.push({
                    code: "JOIN_FANOUT",
                    table: join.table,
                    message: `Join ${join.alias} may materialize multiple related rows per base row.`,
                });
            }
            for (const tableName of staleTables) {
                warnings.push({
                    code: "STALE_CACHE",
                    table: tableName,
                    message: "A stale cache snapshot was used because the Sheets API was quota-limited.",
                });
            }
            return {
                mode,
                sourceIds: [...sourceIds],
                tables,
                steps,
                warnings,
            };
        }
        refresh(selection) {
            const refresh = selection[SELECTION_INTERNAL].refresh;
            if (refresh !== null)
                return refresh();
            throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "This derived selection has no standalone refresh query.");
        }
        update(selection, patch, options = {}) {
            return this.scoped(() => this.updateUnscoped(selection, patch, options));
        }
        updateUnscoped(selection, patch, options) {
            var _a;
            const selectedMaterialized = selection[SELECTION_INTERNAL].materialized;
            if (selectedMaterialized.length === 0)
                return this.emptyMutation(selection);
            if (options.delivery === "deferred") {
                return this.deferUpdate(selection, patch, options);
            }
            this.assertNoDeferredOverlayRows(selectedMaterialized, "apply an immediate update");
            const hydrationStats = createExecutionStats();
            const materialized = this.hydrateMaterializedRows(selectedMaterialized, hydrationStats);
            this.assertSingleMutationTable(materialized);
            const definition = this.table(materialized[0].provenance.tableName);
            if (definition.appendOnly) {
                throw new GQueryRuntimeError("MUTATION_INVALID", `Table ${materialized[0].provenance.tableName} is append-only.`);
            }
            const prepared = [];
            for (const item of materialized) {
                const physicalBefore = this.physicalRowValue(item);
                const mutable = { ...item.value };
                let changes;
                if (typeof patch === "function") {
                    const returned = patch(mutable);
                    changes = returned === undefined ? mutable : returned;
                }
                else {
                    changes = patch;
                }
                const changeRecord = baseMutationChanges(item.value, definition, changes, typeof patch === "function");
                const changedKeys = Object.keys(changeRecord).filter((field) => !sameLogical(physicalBefore[field], changeRecord[field]));
                const primaryChanges = changedKeys.filter((field) => definition.primaryKey.includes(field));
                if (primaryChanges.length > 0) {
                    throw new GQueryRuntimeError("MUTATION_INVALID", `Primary key columns cannot be updated in place: ${primaryChanges.join(", ")}.`);
                }
                const cellPatches = [];
                const nextValue = { ...physicalBefore };
                const nextEncoded = { ...item.provenance.originalEncoded };
                for (const field of changedKeys) {
                    const column = definition.columns[field];
                    const encoded = toSheetInput(column.encode(changeRecord[field], {
                        table: item.provenance.tableName,
                        column: field,
                        header: (_a = column.header) !== null && _a !== void 0 ? _a : field,
                        rowNumber: item.provenance.rowIndex + 1,
                    }));
                    nextValue[field] = changeRecord[field];
                    nextEncoded[field] = storedSheetValue(encoded);
                    cellPatches.push({
                        sheetId: item.provenance.sheetId,
                        rowIndex: item.provenance.rowIndex,
                        columnIndex: item.provenance.columnIndexes[field],
                        value: encoded,
                    });
                }
                let nextVersion = item.provenance.version;
                if (changedKeys.length > 0 && definition.versionColumn !== undefined) {
                    const versionIndex = item.provenance.columnIndexes[definition.versionColumn];
                    nextVersion = typeof item.provenance.version === "number" ? item.provenance.version + 1 : 1;
                    cellPatches.push({
                        sheetId: item.provenance.sheetId,
                        rowIndex: item.provenance.rowIndex,
                        columnIndex: versionIndex,
                        value: nextVersion,
                    });
                }
                prepared.push({
                    before: {
                        value: physicalBefore,
                        provenance: item.provenance,
                    },
                    after: {
                        value: nextValue,
                        provenance: cloneProvenance(item.provenance, {
                            version: nextVersion,
                            originalEncoded: nextEncoded,
                        }),
                    },
                    patches: cellPatches,
                    changedFields: changedKeys,
                });
            }
            const preflight = this.preflight(materialized);
            const constraints = this.validateWriteConstraints(prepared, [], []);
            const validationStats = mutableStats(hydrationStats);
            addStats(validationStats, preflight.stats);
            addStats(validationStats, constraints.stats);
            const conflicts = [...preflight.conflicts, ...constraints.conflicts];
            if (conflicts.length > 0) {
                return {
                    status: "conflicted",
                    matchedCount: materialized.length,
                    changedCount: 0,
                    changedCells: 0,
                    conflicts,
                    before: selection,
                    stats: validationStats,
                };
            }
            const cellPatches = prepared.flatMap((item) => item.patches);
            const stats = validationStats;
            if (cellPatches.length > 0) {
                const bySpreadsheet = this.groupPatchesBySpreadsheet(prepared);
                for (const [spreadsheetId, patches] of bySpreadsheet) {
                    const workbookPrepared = prepared.filter((item) => item.before.provenance.spreadsheetId === spreadsheetId);
                    const valueMutations = compactCellUpdates(patches);
                    const mutations = [...valueMutations, ...this.formatMutations(workbookPrepared)];
                    this.options.transport.atomicBatchUpdate(spreadsheetId, mutations);
                    stats.apiCalls += 1;
                    stats.cellsWritten += patches.length;
                    stats.bytesWritten += estimateBytes(patches);
                    stats.rangesWritten.push(...valueMutations.map((mutation) => {
                        var _a, _b;
                        return cellRange(this.sheetName(spreadsheetId, mutation.sheetId), mutation.startRowIndex, mutation.startColumnIndex, mutation.values.length, (_b = (_a = mutation.values[0]) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 1);
                    }));
                }
                this.invalidateMaterialized(materialized);
            }
            const afterMaterialized = prepared.map((item, index) => invalidateChangedRelations({
                value: projectRow({
                    ...materialized[index].value,
                    ...item.after.value,
                }, selection.headers),
                provenance: item.after.provenance,
            }, item.changedFields));
            const after = new Selection(afterMaterialized, selection.headers, stats, this, selection[SELECTION_INTERNAL].refresh);
            return {
                status: "committed",
                matchedCount: materialized.length,
                changedCount: prepared.filter((item) => item.patches.length > 0).length,
                changedCells: cellPatches.length,
                conflicts: [],
                before: options.includeBefore === false ? undefined : selection,
                after: options.includeAfter === false ? undefined : after,
                stats,
            };
        }
        delete(selection, options = {}) {
            return this.scoped(() => this.deleteUnscoped(selection, options));
        }
        deleteUnscoped(selection, options) {
            var _a;
            const materialized = selection[SELECTION_INTERNAL].materialized;
            if (materialized.length === 0)
                return this.emptyMutation(selection);
            if (options.delivery === "deferred") {
                return this.deferDelete(selection, options);
            }
            this.assertNoDeferredOverlayRows(materialized, "apply an immediate delete");
            this.assertSingleMutationTable(materialized);
            const relational = this.planReferentialDelete(materialized.map((item) => ({
                value: this.physicalRowValue(item),
                provenance: item.provenance,
            })));
            const preparedSetNulls = relational.setNulls.map((action) => {
                const patch = Object.fromEntries([...action.fields].map((field) => [field, null]));
                return this.prepareUpdates([action.row], patch)[0];
            });
            const workbooks = new Set([
                ...relational.deletes.map((item) => item.provenance.spreadsheetId),
                ...preparedSetNulls.map((item) => item.before.provenance.spreadsheetId),
            ]);
            if (workbooks.size > 1) {
                throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "An immediate relational delete cannot atomically mutate more than one spreadsheet. Use unitOfWork() to receive cross-workbook commit receipts.", { details: { spreadsheets: [...workbooks] } });
            }
            const preflightRows = this.uniqueMaterialized([
                ...relational.deletes,
                ...preparedSetNulls.map((item) => item.before),
            ]);
            const preflight = this.preflight(preflightRows);
            if (preflight.conflicts.length > 0) {
                const stats = mutableStats(relational.stats);
                addStats(stats, preflight.stats);
                return {
                    status: "conflicted",
                    matchedCount: materialized.length,
                    changedCount: 0,
                    changedCells: 0,
                    conflicts: preflight.conflicts,
                    before: selection,
                    stats,
                };
            }
            const rows = relational.deletes.map((item) => ({
                sheetId: item.provenance.sheetId,
                rowIndex: item.provenance.rowIndex,
            }));
            const deletes = compactRowDeletes(rows);
            const cellPatches = preparedSetNulls.flatMap((item) => item.patches);
            const updates = compactCellUpdates(cellPatches);
            const mutations = [
                ...updates,
                ...this.formatMutations(preparedSetNulls),
                ...deletes,
            ];
            const spreadsheetId = (_a = [...workbooks][0]) !== null && _a !== void 0 ? _a : materialized[0].provenance.spreadsheetId;
            if (mutations.length > 0)
                this.options.transport.atomicBatchUpdate(spreadsheetId, mutations);
            const stats = mutableStats(relational.stats);
            addStats(stats, preflight.stats);
            if (mutations.length > 0)
                stats.apiCalls += 1;
            stats.cellsWritten += cellPatches.length;
            stats.bytesWritten += estimateBytes(mutations);
            stats.rangesWritten.push(...updates.map((mutation) => {
                var _a, _b;
                return cellRange(this.sheetName(spreadsheetId, mutation.sheetId), mutation.startRowIndex, mutation.startColumnIndex, mutation.values.length, (_b = (_a = mutation.values[0]) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 1);
            }));
            stats.rangesWritten.push(...deletes.map((item) => `${this.sheetName(spreadsheetId, item.sheetId)} rows ${item.startRowIndex + 1}:${item.endRowIndex}`));
            for (const item of relational.deletes) {
                this.clearTableLocators(item.provenance.spreadsheetId, item.provenance.tableName);
            }
            this.invalidateMaterialized(preflightRows);
            return {
                status: "committed",
                matchedCount: materialized.length,
                changedCount: relational.deletes.length + preparedSetNulls.filter((item) => item.patches.length > 0).length,
                changedCells: cellPatches.length,
                conflicts: [],
                before: options.includeBefore === false ? undefined : selection,
                stats,
            };
        }
        append(tableName, rows) {
            return this.scoped(() => this.appendUnscoped(tableName, rows));
        }
        /** Queue a caller-keyed create/upsert without opening the spreadsheet. */
        deferKeyedWrite(tableName, row, kind, options) {
            var _a;
            const journal = this.options.deferredJournal;
            if (journal === undefined) {
                throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "Deferred delivery is not configured for this GQuery instance.");
            }
            if (!options.idempotencyKey) {
                throw new GQueryRuntimeError("MUTATION_INVALID", `Deferred ${kind} requires idempotencyKey.`);
            }
            const definition = this.table(tableName);
            if (definition.primaryKey.length === 0) {
                throw new GQueryRuntimeError("MUTATION_INVALID", `Deferred ${kind} requires a declared primary key.`);
            }
            if (kind === "upsert" && definition.appendOnly) {
                throw new GQueryRuntimeError("MUTATION_INVALID", `Append-only table ${tableName} cannot accept deferred upserts.`);
            }
            const unknown = Object.keys(row).filter((field) => !(field in definition.columns));
            if (unknown.length > 0) {
                throw new GQueryRuntimeError("MUTATION_INVALID", `Unknown deferred ${kind} columns: ${unknown.join(", ")}.`);
            }
            const encoded = {};
            for (const [field, column] of Object.entries(definition.columns)) {
                encoded[field] = storedSheetValue(toSheetInput(column.encode(row[field], {
                    table: tableName,
                    column: field,
                    header: (_a = column.header) !== null && _a !== void 0 ? _a : field,
                })));
            }
            const key = Object.fromEntries(definition.primaryKey.map((field) => [field, encoded[field]]));
            const enqueued = journal.enqueue({
                sourceId: this.spreadsheetId(definition.source),
                table: tableName,
                kind,
                key,
                values: encoded,
                expectedVersion: null,
                actor: options.actor,
                idempotencyKey: options.idempotencyKey,
            });
            const status = enqueued.receipt.status === "committed"
                ? "committed"
                : enqueued.receipt.status === "conflicted"
                    ? "conflicted"
                    : "queued";
            return {
                status,
                matchedCount: kind === "upsert" ? 1 : 0,
                changedCount: status === "conflicted" ? 0 : 1,
                changedCells: 0,
                conflicts: [],
                stats: createExecutionStats(),
                receipt: {
                    id: enqueued.receipt.mutationId,
                    idempotencyKey: enqueued.receipt.idempotencyKey,
                    queuedAt: new Date(enqueued.receipt.createdAtMs).toISOString(),
                    operation: kind,
                    table: tableName,
                    keys: [Object.fromEntries(definition.primaryKey.map((field) => [field, row[field]]))],
                },
            };
        }
        appendUnscoped(tableName, rows) {
            if (rows.length === 0) {
                return {
                    status: "committed",
                    matchedCount: 0,
                    changedCount: 0,
                    changedCells: 0,
                    conflicts: [],
                    stats: createExecutionStats(),
                };
            }
            const prepared = this.prepareAppend(tableName, rows);
            const constraints = this.validateWriteConstraints([], [prepared], []);
            const stats = mutableStats(prepared.stats);
            addStats(stats, constraints.stats);
            if (constraints.conflicts.length > 0) {
                return {
                    status: "conflicted",
                    matchedCount: rows.length,
                    changedCount: 0,
                    changedCells: 0,
                    conflicts: constraints.conflicts,
                    stats,
                };
            }
            this.options.transport.atomicBatchUpdate(prepared.resolved.spreadsheetId, [{
                    kind: "appendRows",
                    sheetId: prepared.resolved.sheet.sheetId,
                    values: prepared.values,
                }]);
            this.clearTableLocators(prepared.resolved.spreadsheetId, tableName);
            this.invalidateTable(prepared.resolved.spreadsheetId, tableName);
            const changedCells = prepared.values.reduce((sum, row) => sum + row.length, 0);
            return {
                status: "committed",
                matchedCount: rows.length,
                changedCount: rows.length,
                changedCells,
                conflicts: [],
                stats: createExecutionStats({ ...stats, apiCalls: stats.apiCalls + 1, cellsWritten: changedCells }),
            };
        }
        /** Compile staged operations and commit each workbook in one atomic batch. */
        commitUnitOfWork(intents) {
            return this.commitUnitOfWorkWithSnapshots(intents);
        }
        commitUnitOfWorkWithSnapshots(intents, constraintSnapshots = []) {
            return this.scoped(() => this.commitUnitOfWorkUnscoped(intents, constraintSnapshots, false));
        }
        /**
         * Internal deferred-flush hook. The caller must hold the participating-writer
         * lock and must have obtained every selection from a cache-bypassing physical
         * batch read immediately before this call. That read is the targeted version
         * preflight, so repeating it here would double the Sheets read traffic without
         * providing compare-and-set semantics (which Sheets does not expose).
         */
        commitUnitOfWorkAfterPhysicalRead(intents, constraintSnapshots = []) {
            return this.scoped(() => this.commitUnitOfWorkUnscoped(intents, constraintSnapshots, true));
        }
        commitUnitOfWorkUnscoped(intents, constraintSnapshots, physicalReadIsPreflight) {
            var _a, _b, _c, _d, _e, _f;
            const selections = intents
                .filter((intent) => intent.kind !== "append")
                .flatMap((intent) => intent.selection[SELECTION_INTERNAL].materialized);
            this.assertNoDeferredOverlayRows(selections, "commit a unit-of-work mutation");
            const identities = new Set();
            for (const item of selections) {
                const identity = `${item.provenance.spreadsheetId}:${item.provenance.sheetId}:${item.provenance.rowIndex}`;
                if (identities.has(identity)) {
                    throw new GQueryRuntimeError("MUTATION_INVALID", "A unit of work cannot stage more than one mutation for the same physical row.", { details: { identity } });
                }
                identities.add(identity);
            }
            const explicitPreparedUpdates = [];
            const explicitDeletes = [];
            const valueOverrides = new Map();
            const preparationStats = createExecutionStats();
            for (const intent of intents) {
                if (intent.kind === "update") {
                    const selected = intent.selection[SELECTION_INTERNAL]
                        .materialized;
                    const materialized = this.hydrateMaterializedRows(selected, preparationStats);
                    const prepared = this.prepareUpdates(materialized, intent.patch);
                    explicitPreparedUpdates.push(...prepared);
                    for (const item of prepared) {
                        valueOverrides.set(materializedIdentity(item.before), item.after.value);
                    }
                }
                else if (intent.kind === "delete") {
                    explicitDeletes.push(...intent.selection[SELECTION_INTERNAL]
                        .materialized
                        .map((item) => ({
                        value: this.physicalRowValue(item),
                        provenance: item.provenance,
                    })));
                }
            }
            const relational = this.planReferentialDelete(explicitDeletes, valueOverrides);
            const deletedIdentities = new Set(relational.deletes.map((item) => materializedIdentity(item)));
            const setNullByIdentity = new Map(relational.setNulls.map((action) => [materializedIdentity(action.row), action]));
            const explicitByIdentity = new Map(explicitPreparedUpdates.map((item) => [materializedIdentity(item.before), item]));
            const preparedUpdates = [];
            for (const prepared of explicitPreparedUpdates) {
                const identity = materializedIdentity(prepared.before);
                if (deletedIdentities.has(identity))
                    continue;
                const setNull = setNullByIdentity.get(identity);
                if (setNull === undefined) {
                    preparedUpdates.push(prepared);
                    continue;
                }
                const finalValue = { ...prepared.after.value };
                for (const field of setNull.fields)
                    finalValue[field] = null;
                preparedUpdates.push(this.prepareUpdates([prepared.before], finalValue)[0]);
            }
            for (const action of relational.setNulls) {
                const identity = materializedIdentity(action.row);
                if (deletedIdentities.has(identity) || explicitByIdentity.has(identity))
                    continue;
                const patch = Object.fromEntries([...action.fields].map((field) => [field, null]));
                preparedUpdates.push(this.prepareUpdates([action.row], patch)[0]);
            }
            const preparedAppends = intents
                .filter((intent) => intent.kind === "append")
                .map((intent) => ({ intent, prepared: this.prepareAppend(intent.tableName, intent.rows) }));
            const preflightRows = this.uniqueMaterialized([
                ...relational.deletes,
                ...preparedUpdates.map((item) => item.before),
            ]);
            const preflight = physicalReadIsPreflight || preflightRows.length === 0
                ? { conflicts: [], stats: createExecutionStats() }
                : this.preflight(preflightRows);
            const constraints = this.validateWriteConstraints(preparedUpdates, preparedAppends.map(({ prepared }) => prepared), relational.deletes, constraintSnapshots);
            const conflicts = [...preflight.conflicts, ...constraints.conflicts];
            if (conflicts.length > 0) {
                const stats = mutableStats(relational.stats);
                addStats(stats, preparationStats);
                addStats(stats, preflight.stats);
                addStats(stats, constraints.stats);
                for (const { prepared } of preparedAppends)
                    addStats(stats, prepared.stats);
                return { status: "conflicted", conflicts, workbooks: [], stats };
            }
            const byWorkbook = new Map();
            const touched = new Map();
            const stats = mutableStats(relational.stats);
            addStats(stats, preparationStats);
            addStats(stats, preflight.stats);
            addStats(stats, constraints.stats);
            for (const [spreadsheetId, patches] of this.groupPatchesBySpreadsheet(preparedUpdates)) {
                const mutations = (_a = byWorkbook.get(spreadsheetId)) !== null && _a !== void 0 ? _a : [];
                mutations.push(...compactCellUpdates(patches));
                mutations.push(...this.formatMutations(preparedUpdates.filter((item) => item.before.provenance.spreadsheetId === spreadsheetId)));
                byWorkbook.set(spreadsheetId, mutations);
                stats.cellsWritten += patches.length;
                stats.bytesWritten += estimateBytes(patches);
            }
            this.recordTouched(touched, preparedUpdates.map((item) => item.before));
            const deleteRowsBySpreadsheet = new Map();
            // Across workbooks, commit cascaded/dependent rows before principals when
            // possible. Same-workbook requests remain one atomic batch regardless.
            for (const item of [...relational.deletes].reverse()) {
                const rows = (_b = deleteRowsBySpreadsheet.get(item.provenance.spreadsheetId)) !== null && _b !== void 0 ? _b : [];
                rows.push({ sheetId: item.provenance.sheetId, rowIndex: item.provenance.rowIndex });
                deleteRowsBySpreadsheet.set(item.provenance.spreadsheetId, rows);
            }
            for (const [spreadsheetId, rows] of deleteRowsBySpreadsheet) {
                const mutations = (_c = byWorkbook.get(spreadsheetId)) !== null && _c !== void 0 ? _c : [];
                mutations.push(...compactRowDeletes(rows));
                byWorkbook.set(spreadsheetId, mutations);
            }
            this.recordTouched(touched, relational.deletes);
            for (const { intent, prepared } of preparedAppends) {
                const mutations = (_d = byWorkbook.get(prepared.resolved.spreadsheetId)) !== null && _d !== void 0 ? _d : [];
                mutations.push({
                    kind: "appendRows",
                    sheetId: prepared.resolved.sheet.sheetId,
                    values: prepared.values,
                });
                byWorkbook.set(prepared.resolved.spreadsheetId, mutations);
                stats.apiCalls += prepared.stats.apiCalls;
                stats.cellsRead += prepared.stats.cellsRead;
                stats.rangesRead.push(...prepared.stats.rangesRead);
                stats.cellsWritten += prepared.values.reduce((sum, row) => sum + row.length, 0);
                const names = (_e = touched.get(prepared.resolved.spreadsheetId)) !== null && _e !== void 0 ? _e : new Set();
                names.add(intent.tableName);
                touched.set(prepared.resolved.spreadsheetId, names);
            }
            const receipts = [];
            let failed = false;
            for (const [spreadsheetId, mutations] of byWorkbook) {
                if (failed) {
                    receipts.push({ spreadsheetId, status: "failed", requestCount: mutations.length, error: "Skipped after prior workbook failure." });
                    continue;
                }
                try {
                    this.options.transport.atomicBatchUpdate(spreadsheetId, mutations);
                    stats.apiCalls += 1;
                    receipts.push({ spreadsheetId, status: "committed", requestCount: mutations.length });
                    for (const tableName of (_f = touched.get(spreadsheetId)) !== null && _f !== void 0 ? _f : []) {
                        this.clearTableLocators(spreadsheetId, tableName);
                        this.invalidateTable(spreadsheetId, tableName);
                    }
                }
                catch (error) {
                    // A same-workbook request is one atomic Sheets operation, not a saga.
                    // Preserve typed ambiguous-commit and deterministic transport failures
                    // so callers never mistake an unknown/failed commit for a receipt.
                    if (byWorkbook.size === 1)
                        throw error;
                    failed = true;
                    receipts.push({ spreadsheetId, status: "failed", requestCount: mutations.length, error });
                }
            }
            return {
                status: failed ? "partial" : "committed",
                conflicts: [],
                workbooks: receipts,
                stats,
            };
        }
        invalidateTable(spreadsheetId, tableName) {
            var _a;
            (_a = this.options.generations) === null || _a === void 0 ? void 0 : _a.invalidateTable(spreadsheetId, tableName);
        }
        invalidateStructure(spreadsheetId) {
            this.metadata.delete(spreadsheetId);
            for (const key of [...this.knownSheets.keys()]) {
                if (key.startsWith(`${spreadsheetId}\u0000`))
                    this.knownSheets.delete(key);
            }
            for (const key of [...this.knownSheetTitles.keys()]) {
                if (key.startsWith(`${spreadsheetId}\u0000`))
                    this.knownSheetTitles.delete(key);
            }
            for (const key of [...this.headers.keys()]) {
                if (key.startsWith(`${spreadsheetId}:`))
                    this.headers.delete(key);
            }
            for (const key of [...this.locators.keys()]) {
                if (key.startsWith(`${spreadsheetId}:`))
                    this.locators.delete(key);
            }
        }
        emptyMutation(selection) {
            return {
                status: "committed",
                matchedCount: 0,
                changedCount: 0,
                changedCells: 0,
                conflicts: [],
                before: selection,
                after: selection,
                stats: createExecutionStats(),
            };
        }
        scoped(operation) {
            var _a, _b, _c, _d;
            const scope = this.options.executionScope;
            if (scope === undefined)
                return operation();
            const before = (_b = (_a = scope.retryCount) === null || _a === void 0 ? void 0 : _a.call(scope)) !== null && _b !== void 0 ? _b : 0;
            const result = scope.run(operation);
            const retries = Math.max(0, ((_d = (_c = scope.retryCount) === null || _c === void 0 ? void 0 : _c.call(scope)) !== null && _d !== void 0 ? _d : before) - before);
            return this.attachRetryStats(result, retries);
        }
        attachRetryStats(result, retries) {
            if (retries === 0 || result === null || typeof result !== "object")
                return result;
            const record = result;
            if (record.selections !== null && typeof record.selections === "object") {
                const selections = Object.fromEntries(Object.entries(record.selections).map(([name, selection]) => {
                    const internal = selection[SELECTION_INTERNAL];
                    return [name, new Selection(internal.materialized, selection.headers, { ...selection.stats, retries: selection.stats.retries + retries }, internal.runtime, internal.refresh, internal.fanoutRequired)];
                }));
                return { ...record, selections };
            }
            if (record.stats !== null && typeof record.stats === "object") {
                const stats = record.stats;
                return {
                    ...record,
                    stats: { ...stats, retries: stats.retries + retries },
                };
            }
            return result;
        }
        deferUpdate(selection, patch, options) {
            var _a;
            const journal = this.options.deferredJournal;
            if (journal === undefined) {
                throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "Deferred delivery is not configured for this GQuery instance.");
            }
            if (typeof patch === "function") {
                throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred updates require a serializable object patch, not a callback.");
            }
            if (!options.idempotencyKey) {
                throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred updates require idempotencyKey.");
            }
            const materialized = selection[SELECTION_INTERNAL].materialized;
            if (materialized.length !== 1) {
                throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred updates must target exactly one key-addressed row.");
            }
            const item = materialized[0];
            const definition = this.table(item.provenance.tableName);
            if (definition.primaryKey.length === 0) {
                throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred updates require a declared primary key.");
            }
            const encoded = {};
            const logical = {};
            for (const [field, value] of Object.entries(patch)) {
                const column = definition.columns[field];
                if (column === undefined)
                    throw new GQueryRuntimeError("MUTATION_INVALID", `Unknown mutation column ${field}.`);
                if (definition.primaryKey.includes(field))
                    throw new GQueryRuntimeError("MUTATION_INVALID", `Deferred updates cannot change primary key column ${field}.`);
                encoded[field] = storedSheetValue(toSheetInput(column.encode(value, {
                    table: item.provenance.tableName,
                    column: field,
                    header: (_a = column.header) !== null && _a !== void 0 ? _a : field,
                    rowNumber: item.provenance.rowIndex + 1,
                })));
                logical[field] = value;
            }
            const expectedVersion = item.provenance.version;
            if (expectedVersion !== undefined && expectedVersion !== null && typeof expectedVersion !== "string" && typeof expectedVersion !== "number") {
                throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred row versions must be strings, numbers, null, or blank.");
            }
            const enqueued = journal.enqueue({
                sourceId: item.provenance.spreadsheetId,
                table: item.provenance.tableName,
                kind: "patch",
                key: item.provenance.encodedPrimaryKey,
                values: encoded,
                expectedVersion: expectedVersion === undefined ? null : expectedVersion,
                actor: options.actor,
                idempotencyKey: options.idempotencyKey,
            });
            const changedFields = Object.keys(logical);
            const afterMaterialized = materialized.map((current) => {
                var _a, _b, _c;
                const existingOverlay = current.provenance.deferredOverlay;
                return invalidateChangedRelations({
                    value: { ...current.value, ...logical },
                    provenance: cloneProvenance(current.provenance, {
                        deferredOverlay: {
                            mutationIds: [
                                ...((_a = existingOverlay === null || existingOverlay === void 0 ? void 0 : existingOverlay.mutationIds) !== null && _a !== void 0 ? _a : []),
                                enqueued.receipt.mutationId,
                            ],
                            fields: [...new Set([
                                    ...((_b = existingOverlay === null || existingOverlay === void 0 ? void 0 : existingOverlay.fields) !== null && _b !== void 0 ? _b : []),
                                    ...changedFields,
                                ])],
                            virtual: (_c = existingOverlay === null || existingOverlay === void 0 ? void 0 : existingOverlay.virtual) !== null && _c !== void 0 ? _c : false,
                        },
                    }),
                }, changedFields);
            });
            const after = new Selection(afterMaterialized, selection.headers, createExecutionStats(), this, selection[SELECTION_INTERNAL].refresh);
            return {
                status: enqueued.receipt.status === "committed" ? "committed" : enqueued.receipt.status === "conflicted" ? "conflicted" : "queued",
                matchedCount: 1,
                changedCount: Object.keys(encoded).length === 0 ? 0 : 1,
                changedCells: 0,
                conflicts: [],
                before: selection,
                after,
                stats: createExecutionStats(),
                receipt: {
                    id: enqueued.receipt.mutationId,
                    idempotencyKey: enqueued.receipt.idempotencyKey,
                    queuedAt: new Date(enqueued.receipt.createdAtMs).toISOString(),
                    operation: "update",
                    table: item.provenance.tableName,
                    keys: [item.provenance.primaryKey],
                },
            };
        }
        deferDelete(selection, options) {
            const journal = this.options.deferredJournal;
            if (journal === undefined)
                throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "Deferred delivery is not configured for this GQuery instance.");
            if (!options.idempotencyKey)
                throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred deletes require idempotencyKey.");
            const materialized = selection[SELECTION_INTERNAL].materialized;
            if (materialized.length !== 1)
                throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred deletes must target exactly one key-addressed row.");
            const item = materialized[0];
            const definition = this.table(item.provenance.tableName);
            if (definition.primaryKey.length === 0)
                throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred deletes require a declared primary key.");
            const expectedVersion = item.provenance.version;
            if (expectedVersion !== undefined && expectedVersion !== null && typeof expectedVersion !== "string" && typeof expectedVersion !== "number") {
                throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred row versions must be strings, numbers, null, or blank.");
            }
            const enqueued = journal.enqueue({
                sourceId: item.provenance.spreadsheetId,
                table: item.provenance.tableName,
                kind: "delete",
                key: item.provenance.encodedPrimaryKey,
                expectedVersion: expectedVersion === undefined ? null : expectedVersion,
                actor: options.actor,
                idempotencyKey: options.idempotencyKey,
            });
            return {
                status: enqueued.receipt.status === "committed" ? "committed" : enqueued.receipt.status === "conflicted" ? "conflicted" : "queued",
                matchedCount: 1,
                changedCount: 1,
                changedCells: 0,
                conflicts: [],
                before: selection,
                stats: createExecutionStats(),
                receipt: {
                    id: enqueued.receipt.mutationId,
                    idempotencyKey: enqueued.receipt.idempotencyKey,
                    queuedAt: new Date(enqueued.receipt.createdAtMs).toISOString(),
                    operation: "delete",
                    table: item.provenance.tableName,
                    keys: [item.provenance.primaryKey],
                },
            };
        }
        prepareUpdates(materialized, patch) {
            var _a;
            if (materialized.length === 0)
                return [];
            this.assertSingleMutationTable(materialized);
            const definition = this.table(materialized[0].provenance.tableName);
            if (definition.appendOnly) {
                throw new GQueryRuntimeError("MUTATION_INVALID", `Table ${materialized[0].provenance.tableName} is append-only.`);
            }
            const prepared = [];
            for (const item of materialized) {
                const physicalBefore = this.physicalRowValue(item);
                const mutable = { ...item.value };
                const returned = typeof patch === "function" ? patch(mutable) : patch;
                const changes = baseMutationChanges(item.value, definition, (typeof patch === "function" && returned === undefined ? mutable : returned), typeof patch === "function");
                const changedKeys = Object.keys(changes).filter((field) => !sameLogical(physicalBefore[field], changes[field]));
                const primaryChanges = changedKeys.filter((field) => definition.primaryKey.includes(field));
                if (primaryChanges.length > 0)
                    throw new GQueryRuntimeError("MUTATION_INVALID", `Primary key columns cannot be updated in place: ${primaryChanges.join(", ")}.`);
                const patches = [];
                const nextValue = { ...physicalBefore };
                const nextEncoded = { ...item.provenance.originalEncoded };
                for (const field of changedKeys) {
                    const column = definition.columns[field];
                    const encoded = toSheetInput(column.encode(changes[field], {
                        table: item.provenance.tableName,
                        column: field,
                        header: (_a = column.header) !== null && _a !== void 0 ? _a : field,
                        rowNumber: item.provenance.rowIndex + 1,
                    }));
                    nextValue[field] = changes[field];
                    nextEncoded[field] = storedSheetValue(encoded);
                    patches.push({
                        sheetId: item.provenance.sheetId,
                        rowIndex: item.provenance.rowIndex,
                        columnIndex: item.provenance.columnIndexes[field],
                        value: encoded,
                    });
                }
                let version = item.provenance.version;
                if (patches.length > 0 && definition.versionColumn !== undefined) {
                    version = typeof version === "number" ? version + 1 : 1;
                    patches.push({
                        sheetId: item.provenance.sheetId,
                        rowIndex: item.provenance.rowIndex,
                        columnIndex: item.provenance.columnIndexes[definition.versionColumn],
                        value: version,
                    });
                }
                prepared.push({
                    before: { value: physicalBefore, provenance: item.provenance },
                    after: {
                        value: nextValue,
                        provenance: cloneProvenance(item.provenance, { version, originalEncoded: nextEncoded }),
                    },
                    patches,
                    changedFields: changedKeys,
                });
            }
            return prepared;
        }
        deleteRelationEdges() {
            const edges = [];
            for (const [declaringTable, definition] of Object.entries(this.schema.tables)) {
                for (const [relationName, rawRelation] of Object.entries(definition.relations)) {
                    const relation = rawRelation;
                    if (relation.kind === "belongs-to") {
                        edges.push({
                            id: `${declaringTable}.${relationName}`,
                            relationName,
                            principalTable: relation.target,
                            dependentTable: declaringTable,
                            principalFields: asArray(relation.foreign),
                            dependentFields: asArray(relation.local),
                            onDelete: relation.onDelete,
                        });
                    }
                    else {
                        edges.push({
                            id: `${declaringTable}.${relationName}`,
                            relationName,
                            principalTable: declaringTable,
                            dependentTable: relation.target,
                            principalFields: asArray(relation.local),
                            dependentFields: asArray(relation.foreign),
                            onDelete: relation.onDelete,
                        });
                    }
                }
            }
            return edges;
        }
        reachableDeleteEdges(rootTables) {
            var _a, _b;
            const byPrincipal = new Map();
            for (const edge of this.deleteRelationEdges()) {
                if (edge.onDelete === "no-action")
                    continue;
                const current = (_a = byPrincipal.get(edge.principalTable)) !== null && _a !== void 0 ? _a : [];
                current.push(edge);
                byPrincipal.set(edge.principalTable, current);
            }
            const pending = [...rootTables];
            const visited = new Set();
            const result = [];
            while (pending.length > 0) {
                const tableName = pending.shift();
                if (visited.has(tableName))
                    continue;
                visited.add(tableName);
                for (const edge of (_b = byPrincipal.get(tableName)) !== null && _b !== void 0 ? _b : []) {
                    result.push(edge);
                    if (edge.onDelete === "cascade")
                        pending.push(edge.dependentTable);
                }
            }
            return result;
        }
        loadDeleteRelationRows(edges, stats) {
            var _a;
            const resolved = new Map();
            for (const edge of edges) {
                if (!resolved.has(edge.dependentTable)) {
                    resolved.set(edge.dependentTable, this.resolveTable(edge.dependentTable, stats));
                }
            }
            const grouped = new Map();
            for (const table of resolved.values()) {
                const tables = (_a = grouped.get(table.spreadsheetId)) !== null && _a !== void 0 ? _a : [];
                tables.push(table);
                grouped.set(table.spreadsheetId, tables);
            }
            const rows = new Map();
            for (const [spreadsheetId, tables] of grouped) {
                const ranges = tables.map((table) => sheetRange(table.definition.sheet));
                const response = this.options.transport.batchGet(spreadsheetId, ranges, {
                    valueRenderOption: tables.some((table) => tableUsesFormula$1(table.definition)) ? "FORMULA" : "UNFORMATTED_VALUE",
                    dateTimeRenderOption: "SERIAL_NUMBER",
                });
                stats.apiCalls += 1;
                stats.rangesRead.push(...ranges);
                stats.fullScans += ranges.length;
                stats.cellsRead += response.valueRanges.reduce((sum, valueRange) => sum + valueRange.values.reduce((inner, row) => inner + row.length, 0), 0);
                stats.bytesRead += estimateBytes(response.valueRanges);
                tables.forEach((table, index) => {
                    var _a, _b;
                    const snapshot = this.parseSnapshot(table, (_b = (_a = response.valueRanges[index]) === null || _a === void 0 ? void 0 : _a.values) !== null && _b !== void 0 ? _b : [], ranges[index]);
                    rows.set(table.tableName, snapshot.rows);
                });
            }
            return rows;
        }
        planReferentialDelete(explicitDeletes, valueOverrides = new Map()) {
            var _a, _b, _c, _d, _e, _f;
            for (const item of explicitDeletes) {
                const definition = this.table(item.provenance.tableName);
                if (definition.appendOnly) {
                    throw new GQueryRuntimeError("MUTATION_INVALID", `Table ${item.provenance.tableName} is append-only.`);
                }
            }
            const stats = createExecutionStats();
            if (explicitDeletes.length === 0)
                return { deletes: [], setNulls: [], stats };
            const rootTables = new Set(explicitDeletes.map((item) => item.provenance.tableName));
            const edges = this.reachableDeleteEdges(rootTables);
            if (edges.length === 0) {
                return { deletes: this.uniqueMaterialized(explicitDeletes), setNulls: [], stats };
            }
            const relationRows = this.loadDeleteRelationRows(edges, stats);
            const byPrincipal = new Map();
            for (const edge of edges) {
                const current = (_a = byPrincipal.get(edge.principalTable)) !== null && _a !== void 0 ? _a : [];
                current.push(edge);
                byPrincipal.set(edge.principalTable, current);
            }
            const effectiveValue = (item) => { var _a; return (_a = valueOverrides.get(materializedIdentity(item))) !== null && _a !== void 0 ? _a : item.value; };
            const matches = (principal, edge) => {
                var _a;
                const principalKey = relationFingerprint(effectiveValue(principal), edge.principalFields);
                if (principalKey === null)
                    return [];
                return ((_a = relationRows.get(edge.dependentTable)) !== null && _a !== void 0 ? _a : []).filter((dependent) => relationFingerprint(effectiveValue(dependent), edge.dependentFields) === principalKey);
            };
            const scheduled = new Map();
            const pending = [];
            for (const item of explicitDeletes) {
                const identity = materializedIdentity(item);
                if (!scheduled.has(identity)) {
                    scheduled.set(identity, item);
                    pending.push(item);
                }
            }
            while (pending.length > 0) {
                const principal = pending.shift();
                for (const edge of (_b = byPrincipal.get(principal.provenance.tableName)) !== null && _b !== void 0 ? _b : []) {
                    if (edge.onDelete !== "cascade")
                        continue;
                    for (const dependent of matches(principal, edge)) {
                        const identity = materializedIdentity(dependent);
                        if (scheduled.has(identity))
                            continue;
                        if (this.table(dependent.provenance.tableName).appendOnly) {
                            throw new GQueryRuntimeError("MUTATION_INVALID", `Cascade ${edge.id} cannot delete from append-only table ${dependent.provenance.tableName}.`, { details: { relation: edge.id, table: dependent.provenance.tableName } });
                        }
                        scheduled.set(identity, dependent);
                        pending.push(dependent);
                    }
                }
            }
            for (const principal of scheduled.values()) {
                for (const edge of (_c = byPrincipal.get(principal.provenance.tableName)) !== null && _c !== void 0 ? _c : []) {
                    if (edge.onDelete !== "restrict")
                        continue;
                    const blocked = matches(principal, edge).filter((dependent) => !scheduled.has(materializedIdentity(dependent)));
                    if (blocked.length > 0) {
                        throw new GQueryRuntimeError("RELATION_RESTRICT", `Cannot delete ${edge.principalTable} because relation ${edge.id} has ${blocked.length} dependent row${blocked.length === 1 ? "" : "s"}.`, {
                            details: {
                                relation: edge.id,
                                relationName: edge.relationName,
                                principalTable: edge.principalTable,
                                dependentTable: edge.dependentTable,
                                principalKey: Object.fromEntries(edge.principalFields.map((field) => [field, effectiveValue(principal)[field]])),
                                dependentKeys: blocked.map((item) => item.provenance.primaryKey),
                            },
                        });
                    }
                }
            }
            const setNulls = new Map();
            for (const principal of scheduled.values()) {
                for (const edge of (_d = byPrincipal.get(principal.provenance.tableName)) !== null && _d !== void 0 ? _d : []) {
                    if (edge.onDelete !== "set-null")
                        continue;
                    for (const dependent of matches(principal, edge)) {
                        const identity = materializedIdentity(dependent);
                        if (scheduled.has(identity))
                            continue;
                        const action = (_e = setNulls.get(identity)) !== null && _e !== void 0 ? _e : { row: dependent, fields: new Set() };
                        for (const field of edge.dependentFields) {
                            if (((_f = this.table(edge.dependentTable).columns[field]) === null || _f === void 0 ? void 0 : _f.acceptsNull) !== true) {
                                throw new GQueryRuntimeError("MUTATION_INVALID", `Relation ${edge.id} cannot set non-nullable column ${edge.dependentTable}.${field} to null.`, { details: { relation: edge.id, table: edge.dependentTable, field } });
                            }
                            action.fields.add(field);
                        }
                        setNulls.set(identity, action);
                    }
                }
            }
            return {
                deletes: [...scheduled.values()],
                setNulls: [...setNulls.values()],
                stats,
            };
        }
        uniqueMaterialized(items) {
            const unique = new Map();
            for (const item of items)
                unique.set(materializedIdentity(item), item);
            return [...unique.values()];
        }
        prepareAppend(tableName, rows) {
            var _a, _b, _c;
            const stats = createExecutionStats();
            const resolved = this.resolveTable(tableName, stats);
            const cacheKey = `${resolved.spreadsheetId}:${resolved.definition.sheet}`;
            let header = this.headers.get(cacheKey);
            if (header === undefined) {
                const headerRange = sheetRange(resolved.definition.sheet, "1:1");
                const response = this.options.transport.get(resolved.spreadsheetId, headerRange, {
                    valueRenderOption: "UNFORMATTED_VALUE",
                });
                stats.apiCalls += 1;
                stats.cellsRead += (_b = (_a = response.values[0]) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0;
                stats.rangesRead.push(headerRange);
                header = this.parseHeader(resolved, (_c = response.values[0]) !== null && _c !== void 0 ? _c : []);
            }
            const values = rows.map((row, rowOffset) => {
                var _a;
                const unknown = Object.keys(row).filter((field) => !(field in resolved.definition.columns));
                if (unknown.length > 0)
                    throw new GQueryRuntimeError("MUTATION_INVALID", `Unknown append columns: ${unknown.join(", ")}.`);
                const physical = Array.from({ length: header.headers.length }, () => null);
                for (const [field, column] of Object.entries(resolved.definition.columns)) {
                    physical[header.logicalToPhysical[field]] = toSheetInput(column.encode(row[field], {
                        table: tableName,
                        column: field,
                        header: (_a = column.header) !== null && _a !== void 0 ? _a : field,
                        rowNumber: rowOffset + 2,
                    }));
                }
                if (resolved.definition.versionColumn !== undefined) {
                    physical[header.logicalToPhysical[resolved.definition.versionColumn]] = 1;
                }
                return physical;
            });
            return {
                resolved,
                rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
                values,
                stats,
            };
        }
        /**
         * Validate the final key graph represented by a write before any workbook is
         * mutated. Existing rows that are updated/deleted are removed first, which
         * lets an update retain its own key and permits atomic key swaps.
         */
        validateWriteConstraints(updates, appends, deletes, constraintSnapshots = []) {
            var _a;
            const stats = createExecutionStats();
            const states = new Map();
            let stagedIndex = 0;
            const stateFor = (tableName) => {
                let state = states.get(tableName);
                if (state === undefined) {
                    state = { tableName, removals: new Set(), additions: [] };
                    states.set(tableName, state);
                }
                return state;
            };
            for (const update of updates) {
                if (update.patches.length === 0)
                    continue;
                const tableName = update.before.provenance.tableName;
                const definition = this.table(tableName);
                const changed = (fields) => fields.some((field) => !sameLogical(update.before.value[field], update.after.value[field]));
                const state = stateFor(tableName);
                const identity = materializedIdentity(update.before);
                state.removals.add(identity);
                state.additions.push({
                    tableName,
                    value: update.after.value,
                    identity,
                    rowIndex: update.before.provenance.rowIndex,
                    stagedIndex: stagedIndex++,
                    checkKeys: definition.primaryKey.some((field) => changed([field])) ||
                        definition.unique.some(changed),
                    checkForeignKeys: Object.values(definition.relations)
                        .some((relation) => relation.kind === "belongs-to" && changed(asArray(relation.local))),
                });
            }
            for (const item of deletes) {
                stateFor(item.provenance.tableName).removals.add(materializedIdentity(item));
            }
            for (const append of appends) {
                const state = stateFor(append.resolved.tableName);
                for (const row of append.rows) {
                    state.additions.push({
                        tableName: append.resolved.tableName,
                        value: row,
                        stagedIndex: stagedIndex++,
                        checkKeys: true,
                        checkForeignKeys: true,
                    });
                }
            }
            const candidateStates = [...states.values()].filter((state) => state.additions.length > 0);
            const hasChecks = candidateStates.some((state) => state.additions.some((candidate) => candidate.checkKeys || candidate.checkForeignKeys));
            if (!hasChecks)
                return { conflicts: [], stats };
            const requestedFields = new Map();
            const requestFields = (tableName, fields) => {
                var _a;
                const requested = (_a = requestedFields.get(tableName)) !== null && _a !== void 0 ? _a : new Set();
                for (const field of fields)
                    requested.add(field);
                requestedFields.set(tableName, requested);
            };
            for (const state of candidateStates) {
                const definition = this.table(state.tableName);
                if (state.additions.some((candidate) => candidate.checkKeys)) {
                    if (definition.primaryKey.length > 0) {
                        requestFields(state.tableName, definition.primaryKey);
                    }
                    for (const key of definition.unique)
                        requestFields(state.tableName, key);
                }
                for (const relation of Object.values(definition.relations)) {
                    if (relation.kind !== "belongs-to")
                        continue;
                    if (!state.additions.some((candidate) => candidate.checkForeignKeys))
                        continue;
                    requestFields(relation.target, asArray(relation.foreign));
                }
            }
            const reusableRows = new Map();
            for (const snapshot of constraintSnapshots) {
                reusableRows.set(snapshot.tableName, Object.freeze(snapshot.rows.map((item) => ({
                    identity: materializedIdentity(item),
                    rowIndex: item.provenance.rowIndex,
                    value: item.value,
                }))));
            }
            const existing = this.scanConstraintRows(requestedFields, stats, reusableRows);
            const conflicts = [];
            const conflictIds = new Set();
            for (const state of candidateStates) {
                const definition = this.table(state.tableName);
                if (!state.additions.some((candidate) => candidate.checkKeys))
                    continue;
                const constraints = [
                    ...(definition.primaryKey.length > 0
                        ? [{ kind: "primary", index: 0, fields: definition.primaryKey }]
                        : []),
                    ...definition.unique.map((fields, index) => ({
                        kind: "unique",
                        index,
                        fields,
                    })),
                ];
                for (const constraint of constraints) {
                    const existingByKey = new Map();
                    for (const row of (_a = existing.get(state.tableName)) !== null && _a !== void 0 ? _a : []) {
                        if (state.removals.has(row.identity))
                            continue;
                        const fingerprint = keyFingerprint(row.value, constraint.fields);
                        if (!existingByKey.has(fingerprint))
                            existingByKey.set(fingerprint, row);
                    }
                    const stagedByKey = new Map();
                    for (const candidate of state.additions) {
                        const canonical = this.canonicalConstraintRow(state.tableName, candidate.value, constraint.fields, candidate.rowIndex);
                        const fingerprint = keyFingerprint(canonical, constraint.fields);
                        const existingCollision = existingByKey.get(fingerprint);
                        const stagedCollision = stagedByKey.get(fingerprint);
                        const collision = existingCollision !== null && existingCollision !== void 0 ? existingCollision : stagedCollision;
                        const shouldReport = existingCollision !== undefined
                            ? candidate.checkKeys
                            : stagedCollision !== undefined &&
                                (candidate.checkKeys || stagedCollision.checkKeys);
                        if (collision !== undefined && shouldReport) {
                            const conflictId = `${state.tableName}:${constraint.kind}:${constraint.index}:${candidate.stagedIndex}:${fingerprint}`;
                            if (!conflictIds.has(conflictId)) {
                                conflictIds.add(conflictId);
                                const values = Object.freeze(Object.fromEntries(constraint.fields.map((field) => [field, canonical[field]])));
                                conflicts.push({
                                    code: "duplicate-key",
                                    table: state.tableName,
                                    key: this.candidateIdentityKey(definition, candidate, constraint.fields),
                                    rowIndex: candidate.rowIndex,
                                    expected: {
                                        constraint: constraint.kind,
                                        index: constraint.kind === "unique" ? constraint.index : undefined,
                                        fields: constraint.fields,
                                        values,
                                    },
                                    actual: existingCollision !== undefined
                                        ? { source: "existing", rowIndex: existingCollision.rowIndex }
                                        : { source: "staged", stagedIndex: stagedCollision.stagedIndex },
                                    message: `Table ${state.tableName} would violate its ${constraint.kind} key (${constraint.fields.join(", ")}).`,
                                });
                            }
                        }
                        if (!stagedByKey.has(fingerprint))
                            stagedByKey.set(fingerprint, candidate);
                    }
                }
            }
            const targetIndexes = new Map();
            const targetIndex = (tableName, fields) => {
                var _a, _b;
                const cacheKey = `${tableName}:${fields.join("\u001f")}`;
                let index = targetIndexes.get(cacheKey);
                if (index !== undefined)
                    return index;
                index = new Set();
                const targetState = states.get(tableName);
                for (const row of (_a = existing.get(tableName)) !== null && _a !== void 0 ? _a : []) {
                    if (targetState === null || targetState === void 0 ? void 0 : targetState.removals.has(row.identity))
                        continue;
                    index.add(keyFingerprint(row.value, fields));
                }
                for (const candidate of (_b = targetState === null || targetState === void 0 ? void 0 : targetState.additions) !== null && _b !== void 0 ? _b : []) {
                    const canonical = this.canonicalConstraintRow(tableName, candidate.value, fields, candidate.rowIndex);
                    index.add(keyFingerprint(canonical, fields));
                }
                targetIndexes.set(cacheKey, index);
                return index;
            };
            for (const state of candidateStates) {
                const definition = this.table(state.tableName);
                for (const [relationName, relation] of Object.entries(definition.relations)) {
                    if (relation.kind !== "belongs-to")
                        continue;
                    const localFields = asArray(relation.local);
                    const foreignFields = asArray(relation.foreign);
                    const targets = targetIndex(relation.target, foreignFields);
                    for (const candidate of state.additions) {
                        if (!candidate.checkForeignKeys)
                            continue;
                        const local = this.canonicalConstraintRow(state.tableName, candidate.value, localFields, candidate.rowIndex);
                        const localValues = localFields.map((field) => local[field]);
                        const blanks = localValues.map((value) => value === null || value === undefined || value === "");
                        if (!relation.required && blanks.some(Boolean))
                            continue;
                        const missing = blanks.some(Boolean) ||
                            !targets.has(canonicalStringify$1(localValues));
                        if (!missing)
                            continue;
                        const conflictId = `${state.tableName}:foreign:${relationName}:${candidate.stagedIndex}`;
                        if (conflictIds.has(conflictId))
                            continue;
                        conflictIds.add(conflictId);
                        conflicts.push({
                            code: "foreign-key-missing",
                            table: state.tableName,
                            key: this.candidateIdentityKey(definition, candidate, localFields),
                            rowIndex: candidate.rowIndex,
                            expected: {
                                relation: relationName,
                                targetTable: relation.target,
                                localFields,
                                foreignFields,
                                values: Object.freeze(Object.fromEntries(localFields.map((field, index) => [field, localValues[index]]))),
                            },
                            actual: null,
                            message: `Required relation ${state.tableName}.${relationName} has no matching ${relation.target} row.`,
                        });
                    }
                }
            }
            return { conflicts, stats };
        }
        canonicalConstraintRow(tableName, row, fields, rowIndex) {
            var _a;
            const definition = this.table(tableName);
            const canonical = {};
            for (const field of fields) {
                const column = definition.columns[field];
                const context = {
                    table: tableName,
                    column: field,
                    header: (_a = column.header) !== null && _a !== void 0 ? _a : field,
                    rowNumber: rowIndex === undefined ? undefined : rowIndex + 1,
                };
                const encoded = storedSheetValue(toSheetInput(column.encode(row[field], context)));
                canonical[field] = column.decode(decodeCell$1(encoded), context);
            }
            return canonical;
        }
        candidateIdentityKey(definition, candidate, fallbackFields) {
            const fields = definition.primaryKey.length > 0
                ? definition.primaryKey
                : fallbackFields;
            return Object.freeze(this.canonicalConstraintRow(candidate.tableName, candidate.value, fields, candidate.rowIndex));
        }
        /** Read only constrained fields plus the minimum row-presence anchors. */
        scanConstraintRows(requestedFields, stats, reusableRows = new Map()) {
            var _a, _b, _c, _d;
            const result = new Map(reusableRows);
            const resolved = [...requestedFields.keys()]
                .filter((tableName) => !reusableRows.has(tableName))
                .map((tableName) => this.resolveTable(tableName, stats));
            const missingHeaders = resolved.filter((table) => !this.headers.has(`${table.spreadsheetId}:${table.definition.sheet}`));
            const headersByWorkbook = new Map();
            for (const table of missingHeaders) {
                const tables = (_a = headersByWorkbook.get(table.spreadsheetId)) !== null && _a !== void 0 ? _a : [];
                tables.push(table);
                headersByWorkbook.set(table.spreadsheetId, tables);
            }
            for (const [spreadsheetId, tables] of headersByWorkbook) {
                const ranges = tables.map((table) => sheetRange(table.definition.sheet, "1:1"));
                const response = this.options.transport.batchGet(spreadsheetId, ranges, {
                    valueRenderOption: "UNFORMATTED_VALUE",
                    dateTimeRenderOption: "SERIAL_NUMBER",
                });
                stats.apiCalls += 1;
                stats.rangesRead.push(...ranges);
                stats.cellsRead += response.valueRanges.reduce((sum, valueRange) => sum + valueRange.values.reduce((inner, row) => inner + row.length, 0), 0);
                stats.bytesRead += estimateBytes(response.valueRanges);
                tables.forEach((table, index) => {
                    var _a, _b;
                    this.parseHeader(table, (_b = (_a = response.valueRanges[index]) === null || _a === void 0 ? void 0 : _a.values[0]) !== null && _b !== void 0 ? _b : []);
                });
            }
            const plans = resolved.map((table) => {
                var _a;
                const header = this.headers.get(`${table.spreadsheetId}:${table.definition.sheet}`);
                if (header === undefined) {
                    throw new GQueryRuntimeError("MISSING_HEADER", `Could not load headers for constrained table ${table.tableName}.`);
                }
                const fields = [...((_a = requestedFields.get(table.tableName)) !== null && _a !== void 0 ? _a : [])];
                const readFields = table.definition.versionColumn === undefined
                    ? Object.keys(table.definition.columns)
                    : fields;
                const byColumn = new Map();
                for (const field of readFields) {
                    byColumn.set(header.logicalToPhysical[field], fields.includes(field) ? field : undefined);
                }
                if (table.definition.versionColumn !== undefined) {
                    const index = header.logicalToPhysical[table.definition.versionColumn];
                    if (!byColumn.has(index))
                        byColumn.set(index, undefined);
                }
                const readColumns = [...byColumn.entries()]
                    .sort(([left], [right]) => left - right)
                    .map(([columnIndex, field]) => {
                    const letter = columnIndexToLetter(columnIndex);
                    return {
                        field,
                        columnIndex,
                        range: sheetRange(table.definition.sheet, `${letter}2:${letter}`),
                    };
                });
                return { resolved: table, header, requestedFields: fields, readColumns };
            });
            const plansByWorkbook = new Map();
            for (const plan of plans) {
                const workbookPlans = (_b = plansByWorkbook.get(plan.resolved.spreadsheetId)) !== null && _b !== void 0 ? _b : [];
                workbookPlans.push(plan);
                plansByWorkbook.set(plan.resolved.spreadsheetId, workbookPlans);
            }
            for (const [spreadsheetId, workbookPlans] of plansByWorkbook) {
                const ranges = workbookPlans.flatMap((plan) => plan.readColumns.map((column) => column.range));
                if (ranges.length === 0)
                    continue;
                const usesFormulaKey = workbookPlans.some((plan) => plan.requestedFields.some((field) => { var _a; return ((_a = plan.resolved.definition.columns[field]) === null || _a === void 0 ? void 0 : _a.kind) === "formula"; }));
                const response = this.options.transport.batchGet(spreadsheetId, ranges, {
                    valueRenderOption: usesFormulaKey ? "FORMULA" : "UNFORMATTED_VALUE",
                    dateTimeRenderOption: "SERIAL_NUMBER",
                });
                stats.apiCalls += 1;
                stats.rangesRead.push(...ranges);
                stats.fullScans += workbookPlans.length;
                stats.cellsRead += response.valueRanges.reduce((sum, valueRange) => sum + valueRange.values.reduce((inner, row) => inner + row.length, 0), 0);
                stats.bytesRead += estimateBytes(response.valueRanges);
                const allowLegacy = !((_c = this.options.canonicalState) === null || _c === void 0 ? void 0 : _c.isStrictCanonical(spreadsheetId));
                let rangeIndex = 0;
                for (const plan of workbookPlans) {
                    const columnRanges = plan.readColumns.map(() => response.valueRanges[rangeIndex++]);
                    const height = columnRanges.reduce((maximum, valueRange) => { var _a; return Math.max(maximum, (_a = valueRange === null || valueRange === void 0 ? void 0 : valueRange.values.length) !== null && _a !== void 0 ? _a : 0); }, 0);
                    const rows = [];
                    for (let rowOffset = 0; rowOffset < height; rowOffset += 1) {
                        const rawValues = columnRanges.map((valueRange) => { var _a; return (_a = valueRange === null || valueRange === void 0 ? void 0 : valueRange.values[rowOffset]) === null || _a === void 0 ? void 0 : _a[0]; });
                        if (rawValues.every((value) => value === undefined || value === null || value === ""))
                            continue;
                        const value = {};
                        for (let columnOffset = 0; columnOffset < plan.readColumns.length; columnOffset += 1) {
                            const field = plan.readColumns[columnOffset].field;
                            if (field === undefined)
                                continue;
                            const column = plan.resolved.definition.columns[field];
                            value[field] = column.decode(decodeCell$1(rawValues[columnOffset]), {
                                table: plan.resolved.tableName,
                                column: field,
                                header: (_d = column.header) !== null && _d !== void 0 ? _d : field,
                                rowNumber: rowOffset + 2,
                                allowLegacy,
                            });
                        }
                        const rowIndex = rowOffset + 1;
                        rows.push({
                            identity: `${spreadsheetId}:${plan.resolved.sheet.sheetId}:${rowIndex}`,
                            rowIndex,
                            value: Object.freeze(value),
                        });
                    }
                    result.set(plan.resolved.tableName, Object.freeze(rows));
                }
            }
            return result;
        }
        recordTouched(touched, materialized) {
            var _a;
            for (const item of materialized) {
                const names = (_a = touched.get(item.provenance.spreadsheetId)) !== null && _a !== void 0 ? _a : new Set();
                names.add(item.provenance.tableName);
                touched.set(item.provenance.spreadsheetId, names);
            }
        }
        pendingDeferredEntries() {
            var _a, _b;
            if (this.deferredOverlaySuppression > 0)
                return [];
            const overlay = this.options.deferredOverlay;
            if (overlay !== undefined) {
                try {
                    const cached = overlay.read();
                    if (cached !== null)
                        return cached;
                }
                catch {
                    // CacheService is an optimization; the durable journal is authoritative.
                }
            }
            return (_b = (_a = this.options.deferredJournal) === null || _a === void 0 ? void 0 : _a.readAndRebuildOverlay()) !== null && _b !== void 0 ? _b : [];
        }
        /** Merge the durable queued state before predicates and joins are evaluated. */
        applyDeferredOverlay(snapshot, entries) {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            const relevant = entries
                .filter((entry) => entry.sourceId === snapshot.resolved.spreadsheetId &&
                entry.table === snapshot.resolved.tableName)
                .sort((left, right) => left.sequence - right.sequence);
            if (relevant.length === 0)
                return snapshot.rows;
            const definition = snapshot.resolved.definition;
            const allowLegacy = !((_a = this.options.canonicalState) === null || _a === void 0 ? void 0 : _a.isStrictCanonical(snapshot.resolved.spreadsheetId));
            const decodeRecord = (encoded) => {
                var _a;
                const decoded = {};
                for (const [field, raw] of Object.entries(encoded)) {
                    const column = definition.columns[field];
                    if (column === undefined) {
                        throw new GQueryRuntimeError("MUTATION_INVALID", `Deferred overlay for ${snapshot.resolved.tableName} references unknown column ${field}.`);
                    }
                    decoded[field] = column.decode(decodeCell$1(raw), {
                        table: snapshot.resolved.tableName,
                        column: field,
                        header: (_a = column.header) !== null && _a !== void 0 ? _a : field,
                        allowLegacy,
                    });
                }
                return decoded;
            };
            const rows = [...snapshot.rows];
            for (const entry of relevant) {
                const logicalKey = decodeRecord(entry.key);
                const fingerprint = keyFingerprint(logicalKey, definition.primaryKey);
                const rowIndex = rows.findIndex((row) => keyFingerprint(row.value, definition.primaryKey) === fingerprint);
                if (entry.kind === "delete") {
                    if (rowIndex >= 0)
                        rows.splice(rowIndex, 1);
                    continue;
                }
                const logicalValues = decodeRecord((_b = entry.values) !== null && _b !== void 0 ? _b : {});
                if (rowIndex >= 0) {
                    if (entry.kind === "create")
                        continue;
                    const current = rows[rowIndex];
                    const existingOverlay = current.provenance.deferredOverlay;
                    const changedFields = Object.keys((_c = entry.values) !== null && _c !== void 0 ? _c : {});
                    rows[rowIndex] = {
                        value: Object.freeze({ ...current.value, ...logicalValues }),
                        provenance: cloneProvenance(current.provenance, {
                            originalEncoded: {
                                ...current.provenance.originalEncoded,
                                ...entry.values,
                            },
                            deferredOverlay: {
                                mutationIds: [...((_d = existingOverlay === null || existingOverlay === void 0 ? void 0 : existingOverlay.mutationIds) !== null && _d !== void 0 ? _d : []), entry.id],
                                fields: [...new Set([...((_e = existingOverlay === null || existingOverlay === void 0 ? void 0 : existingOverlay.fields) !== null && _e !== void 0 ? _e : []), ...changedFields])],
                                virtual: (_f = existingOverlay === null || existingOverlay === void 0 ? void 0 : existingOverlay.virtual) !== null && _f !== void 0 ? _f : false,
                            },
                        }),
                    };
                    continue;
                }
                if (entry.kind === "patch")
                    continue;
                const value = Object.freeze({ ...logicalKey, ...logicalValues });
                const primaryKey = Object.fromEntries(definition.primaryKey.map((field) => [field, value[field]]));
                rows.push({
                    value,
                    provenance: Object.freeze({
                        sourceName: snapshot.resolved.sourceName,
                        spreadsheetId: snapshot.resolved.spreadsheetId,
                        tableName: snapshot.resolved.tableName,
                        sheetName: definition.sheet,
                        sheetId: snapshot.resolved.sheet.sheetId,
                        rowIndex: -(entry.sequence + 1),
                        primaryKey: Object.freeze(primaryKey),
                        encodedPrimaryKey: Object.freeze({ ...entry.key }),
                        version: null,
                        originalEncoded: Object.freeze({
                            ...entry.key,
                            ...((_g = entry.values) !== null && _g !== void 0 ? _g : {}),
                        }),
                        columnIndexes: snapshot.header.logicalToPhysical,
                        headerFingerprint: snapshot.header.fingerprint,
                        readAt: this.now().toISOString(),
                        relations: Object.freeze({}),
                        relationCardinalities: Object.freeze({}),
                        relationLocalFields: Object.freeze({}),
                        deferredOverlay: Object.freeze({
                            mutationIds: Object.freeze([entry.id]),
                            fields: Object.freeze([...new Set([
                                    ...Object.keys(entry.key),
                                    ...Object.keys((_h = entry.values) !== null && _h !== void 0 ? _h : {}),
                                ])]),
                            virtual: true,
                        }),
                    }),
                });
            }
            return Object.freeze(rows);
        }
        table(tableName) {
            const table = this.schema.tables[tableName];
            if (table === undefined)
                throw new GQueryRuntimeError("INVALID_QUERY", `Unknown table ${tableName}.`);
            return table;
        }
        /**
         * Projected selections intentionally retain only the encoded columns that
         * were read. Before a write needs the complete prior row, fetch just the
         * missing column blocks for the already matched physical rows. This preserves
         * selection reuse without repeating the original predicate scan.
         */
        hydrateMaterializedRows(materialized, stats) {
            const readsByWorkbook = new Map();
            for (const rawItem of materialized) {
                const item = rawItem;
                const definition = this.table(item.provenance.tableName);
                const missingIndexes = Object.keys(definition.columns)
                    .filter((field) => !Object.prototype.hasOwnProperty.call(item.provenance.originalEncoded, field))
                    .map((field) => item.provenance.columnIndexes[field])
                    .sort((left, right) => left - right);
                let start;
                let end;
                const append = () => {
                    var _a;
                    if (start === undefined || end === undefined)
                        return;
                    const reads = (_a = readsByWorkbook.get(item.provenance.spreadsheetId)) !== null && _a !== void 0 ? _a : [];
                    reads.push({
                        item,
                        startColumnIndex: start,
                        endColumnIndex: end,
                        range: cellRange(item.provenance.sheetName, item.provenance.rowIndex, start, 1, end - start + 1),
                    });
                    readsByWorkbook.set(item.provenance.spreadsheetId, reads);
                };
                for (const columnIndex of missingIndexes) {
                    if (start === undefined) {
                        start = columnIndex;
                        end = columnIndex;
                    }
                    else if (columnIndex === end + 1) {
                        end = columnIndex;
                    }
                    else {
                        append();
                        start = columnIndex;
                        end = columnIndex;
                    }
                }
                append();
            }
            if (readsByWorkbook.size === 0)
                return materialized;
            const hydrated = new Map();
            for (const [spreadsheetId, reads] of readsByWorkbook) {
                const response = this.options.transport.batchGet(spreadsheetId, reads.map((read) => read.range), {
                    valueRenderOption: reads.some((read) => tableUsesFormula$1(this.table(read.item.provenance.tableName))) ? "FORMULA" : "UNFORMATTED_VALUE",
                    dateTimeRenderOption: "SERIAL_NUMBER",
                });
                stats.apiCalls += 1;
                stats.rangesRead.push(...reads.map((read) => read.range));
                stats.cellsRead += response.valueRanges.reduce((total, valueRange) => total + valueRange.values.reduce((sum, row) => sum + row.length, 0), 0);
                stats.bytesRead += estimateBytes(response.valueRanges);
                reads.forEach((read, readIndex) => {
                    var _a, _b, _c;
                    const definition = this.table(read.item.provenance.tableName);
                    const byPhysical = new Map(Object.keys(definition.columns).map((field) => [
                        read.item.provenance.columnIndexes[field],
                        field,
                    ]));
                    const identity = materializedIdentity(read.item);
                    const encoded = (_a = hydrated.get(identity)) !== null && _a !== void 0 ? _a : {
                        ...read.item.provenance.originalEncoded,
                    };
                    const values = (_c = (_b = response.valueRanges[readIndex]) === null || _b === void 0 ? void 0 : _b.values[0]) !== null && _c !== void 0 ? _c : [];
                    for (let columnIndex = read.startColumnIndex; columnIndex <= read.endColumnIndex; columnIndex += 1) {
                        const field = byPhysical.get(columnIndex);
                        if (field !== undefined) {
                            encoded[field] = rawCell(values[columnIndex - read.startColumnIndex]);
                        }
                    }
                    hydrated.set(identity, encoded);
                });
            }
            return materialized.map((rawItem) => {
                const item = rawItem;
                const encoded = hydrated.get(materializedIdentity(item));
                if (encoded === undefined)
                    return rawItem;
                return {
                    value: rawItem.value,
                    provenance: cloneProvenance(rawItem.provenance, {
                        originalEncoded: Object.freeze(encoded),
                    }),
                };
            });
        }
        /** Rebuild the complete decoded table row retained by encoded provenance. */
        physicalRowValue(item) {
            var _a, _b;
            const definition = this.table(item.provenance.tableName);
            const value = {};
            const allowLegacy = !((_a = this.options.canonicalState) === null || _a === void 0 ? void 0 : _a.isStrictCanonical(item.provenance.spreadsheetId));
            for (const [field, column] of Object.entries(definition.columns)) {
                if (Object.prototype.hasOwnProperty.call(item.provenance.originalEncoded, field)) {
                    value[field] = column.decode(decodeCell$1(item.provenance.originalEncoded[field]), {
                        table: item.provenance.tableName,
                        column: field,
                        header: (_b = column.header) !== null && _b !== void 0 ? _b : field,
                        rowNumber: item.provenance.rowIndex + 1,
                        allowLegacy,
                    });
                }
                else if (Object.prototype.hasOwnProperty.call(item.value, field)) {
                    value[field] = item.value[field];
                }
            }
            return value;
        }
        source(sourceName) {
            const source = this.schema.sources[sourceName];
            if (source === undefined)
                throw new GQueryRuntimeError("SOURCE_UNAVAILABLE", `Unknown source ${sourceName}.`);
            return source;
        }
        sourceIdentity(sourceName) {
            const definition = this.source(sourceName);
            return definition.kind === "spreadsheet-id" ? definition.spreadsheetId : "active-spreadsheet";
        }
        spreadsheetId(sourceName) {
            var _a, _b, _c;
            const definition = this.source(sourceName);
            if (definition.kind === "spreadsheet-id")
                return definition.spreadsheetId;
            try {
                const id = (_c = (_b = (_a = this.options).resolveActiveSpreadsheetId) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : SpreadsheetApp.getActiveSpreadsheet().getId();
                if (!id)
                    throw new Error("Active spreadsheet has no ID.");
                return id;
            }
            catch (error) {
                throw new GQueryRuntimeError("SOURCE_UNAVAILABLE", "The active spreadsheet source cannot be resolved in this execution context.", { cause: error });
            }
        }
        tableIdentity(tableName) {
            const definition = this.table(tableName);
            const spreadsheetId = this.spreadsheetId(definition.source);
            return {
                tableName,
                definition,
                sourceName: definition.source,
                spreadsheetId,
            };
        }
        resolveTable(tableName, stats) {
            return this.resolveIdentity(this.tableIdentity(tableName), stats);
        }
        resolveIdentity(identity, stats) {
            const { tableName, definition, spreadsheetId } = identity;
            let sheets = this.metadata.get(spreadsheetId);
            if (sheets === undefined) {
                const known = this.knownSheets.get(this.knownSheetKey(spreadsheetId, definition.sheet));
                if (known !== undefined)
                    return { ...identity, sheet: known };
                sheets = this.options.transport.getSpreadsheetMetadata(spreadsheetId).sheets;
                if (stats !== undefined)
                    stats.apiCalls += 1;
                this.metadata.set(spreadsheetId, sheets);
                this.rememberSheets(spreadsheetId, sheets);
            }
            const sheet = sheets.find((candidate) => candidate.title === definition.sheet);
            if (sheet === undefined) {
                throw new GQueryRuntimeError("SHEET_NOT_FOUND", `Table ${tableName} expects sheet ${definition.sheet}, but it does not exist.`, { details: { table: tableName, spreadsheetId, sheet: definition.sheet } });
            }
            return { ...identity, sheet };
        }
        parseCachedSnapshot(identity, cached) {
            try {
                return this.parseCachedSnapshotValue(identity, cached);
            }
            catch {
                // A cache adapter may return malformed non-JSON values. Cache identity is
                // never authoritative, so unexpected access/coercion failures are misses.
                return null;
            }
        }
        parseCachedSnapshotValue(identity, cached) {
            var _a, _b, _c;
            if (cached.version !== 2 ||
                cached.spreadsheetId !== identity.spreadsheetId ||
                cached.tableName !== identity.tableName ||
                cached.range !== sheetRange(identity.definition.sheet) ||
                !this.validCachedSheet(cached.sheet, identity.definition.sheet) ||
                !Array.isArray(cached.values) ||
                !cached.values.every((row) => Array.isArray(row)) ||
                cached.values.length > cached.sheet.rowCount ||
                ((_b = (_a = cached.values[0]) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) > cached.sheet.columnCount) {
                return null;
            }
            const rawHeaders = (_c = cached.values[0]) !== null && _c !== void 0 ? _c : [];
            const headers = rawHeaders.map((value) => typeof value === "string" ? value : String(value !== null && value !== void 0 ? value : ""));
            if (typeof cached.headerFingerprint !== "string" ||
                hashCanonical$1(headers) !== cached.headerFingerprint) {
                return null;
            }
            const resolved = {
                ...identity,
                sheet: Object.freeze({ ...cached.sheet }),
            };
            try {
                const snapshot = this.parseSnapshot(resolved, cached.values, cached.range, undefined, true, false);
                if (snapshot.header.fingerprint !== cached.headerFingerprint)
                    return null;
                this.rememberSheets(identity.spreadsheetId, [resolved.sheet]);
                return snapshot;
            }
            catch {
                // Cache values and metadata are optional hints. Any schema/codec/header
                // mismatch falls back to authoritative Sheets reads below.
                return null;
            }
        }
        validCachedSheet(sheet, expectedTitle) {
            return (typeof sheet === "object" &&
                sheet !== null &&
                Number.isSafeInteger(sheet.sheetId) &&
                sheet.sheetId >= 0 &&
                sheet.title === expectedTitle &&
                Number.isSafeInteger(sheet.rowCount) &&
                sheet.rowCount >= 0 &&
                Number.isSafeInteger(sheet.columnCount) &&
                sheet.columnCount >= 0);
        }
        cachedSheetMetadata(sheet, values) {
            const observedColumns = values.reduce((maximum, row) => Math.max(maximum, row.length), 0);
            return Object.freeze({
                ...sheet,
                rowCount: Math.max(sheet.rowCount, values.length),
                columnCount: Math.max(sheet.columnCount, observedColumns),
            });
        }
        knownSheetKey(spreadsheetId, title) {
            return `${spreadsheetId}\u0000${title}`;
        }
        knownSheetIdKey(spreadsheetId, sheetId) {
            return `${spreadsheetId}\u0000${sheetId}`;
        }
        rememberSheets(spreadsheetId, sheets) {
            for (const sheet of sheets) {
                const copy = Object.freeze({ ...sheet });
                this.knownSheets.set(this.knownSheetKey(spreadsheetId, sheet.title), copy);
                this.knownSheetTitles.set(this.knownSheetIdKey(spreadsheetId, sheet.sheetId), sheet.title);
            }
        }
        parseHeader(resolved, values) {
            var _a;
            const headers = values.map((value) => typeof value === "string" ? value : String(value !== null && value !== void 0 ? value : ""));
            const indexes = new Map();
            for (let index = 0; index < headers.length; index += 1) {
                const header = headers[index];
                if (header.length === 0)
                    continue;
                if (indexes.has(header)) {
                    throw new GQueryRuntimeError("DUPLICATE_HEADER", `Sheet ${resolved.definition.sheet} contains duplicate header ${header}.`);
                }
                indexes.set(header, index);
            }
            const logicalToPhysical = {};
            for (const [field, column] of Object.entries(resolved.definition.columns)) {
                const header = (_a = column.header) !== null && _a !== void 0 ? _a : field;
                const index = indexes.get(header);
                if (index === undefined) {
                    throw new GQueryRuntimeError("MISSING_HEADER", `Table ${resolved.tableName} is missing required header ${header}.`, { details: { table: resolved.tableName, field, header } });
                }
                logicalToPhysical[field] = index;
            }
            if (resolved.definition.versionColumn !== undefined) {
                const index = indexes.get(resolved.definition.versionColumn);
                if (index === undefined) {
                    throw new GQueryRuntimeError("MIGRATION_REQUIRED", `Table ${resolved.tableName} requires version header ${resolved.definition.versionColumn}. Run schema.plan() and schema.migrate().`);
                }
                logicalToPhysical[resolved.definition.versionColumn] = index;
            }
            const state = Object.freeze({
                headers: Object.freeze(headers),
                logicalToPhysical: Object.freeze(logicalToPhysical),
                fingerprint: hashCanonical$1(headers),
            });
            this.headers.set(`${resolved.spreadsheetId}:${resolved.definition.sheet}`, state);
            return state;
        }
        parseSnapshot(resolved, values, range, physicalRowIndexes, completeSnapshot = true, persistLocators = true, decodedFields) {
            var _a, _b, _c, _d, _e;
            const header = this.parseHeader(resolved, (_a = values[0]) !== null && _a !== void 0 ? _a : []);
            const rows = [];
            const seenPrimary = new Map();
            const seenUnique = resolved.definition.unique.map(() => new Map());
            const allowLegacy = !((_b = this.options.canonicalState) === null || _b === void 0 ? void 0 : _b.isStrictCanonical(resolved.spreadsheetId));
            const requested = decodedFields === undefined ? null : new Set(decodedFields);
            for (let dataIndex = 1; dataIndex < values.length; dataIndex += 1) {
                const physical = (_c = values[dataIndex]) !== null && _c !== void 0 ? _c : [];
                if (physical.every((value) => value === null || value === undefined || value === ""))
                    continue;
                const decoded = {};
                const encoded = {};
                for (const [field, column] of Object.entries(resolved.definition.columns)) {
                    if (requested !== null && !requested.has(field))
                        continue;
                    const index = header.logicalToPhysical[field];
                    const physicalValue = physical[index];
                    decoded[field] = column.decode(decodeCell$1(physicalValue), {
                        table: resolved.tableName,
                        column: field,
                        header: (_d = column.header) !== null && _d !== void 0 ? _d : field,
                        rowNumber: dataIndex + 1,
                        allowLegacy,
                    });
                    encoded[field] = rawCell(physicalValue);
                }
                if (resolved.definition.primaryKey.length > 0 &&
                    resolved.definition.primaryKey.every((field) => requested === null || requested.has(field))) {
                    const fingerprint = keyFingerprint(decoded, resolved.definition.primaryKey);
                    const previous = seenPrimary.get(fingerprint);
                    if (previous !== undefined) {
                        throw new GQueryRuntimeError("DUPLICATE_KEY", `Table ${resolved.tableName} contains duplicate primary key at rows ${previous + 1} and ${dataIndex + 1}.`, { details: { table: resolved.tableName, fingerprint, rows: [previous + 1, dataIndex + 1] } });
                    }
                    seenPrimary.set(fingerprint, dataIndex);
                }
                resolved.definition.unique.forEach((key, uniqueIndex) => {
                    if (!key.every((field) => requested === null || requested.has(field)))
                        return;
                    const fingerprint = keyFingerprint(decoded, key);
                    const previous = seenUnique[uniqueIndex].get(fingerprint);
                    if (previous !== undefined) {
                        throw new GQueryRuntimeError("DUPLICATE_KEY", `Table ${resolved.tableName} violates unique key (${key.join(", ")}) at rows ${previous + 1} and ${dataIndex + 1}.`);
                    }
                    seenUnique[uniqueIndex].set(fingerprint, dataIndex);
                });
                const primaryKey = {};
                const encodedPrimaryKey = {};
                for (const field of resolved.definition.primaryKey) {
                    primaryKey[field] = decoded[field];
                    encodedPrimaryKey[field] = encoded[field];
                }
                const version = resolved.definition.versionColumn === undefined
                    ? undefined
                    : rawCell(physical[header.logicalToPhysical[resolved.definition.versionColumn]]);
                const physicalRowIndex = (_e = physicalRowIndexes === null || physicalRowIndexes === void 0 ? void 0 : physicalRowIndexes[dataIndex - 1]) !== null && _e !== void 0 ? _e : dataIndex;
                const provenance = Object.freeze({
                    sourceName: resolved.sourceName,
                    spreadsheetId: resolved.spreadsheetId,
                    tableName: resolved.tableName,
                    sheetName: resolved.definition.sheet,
                    sheetId: resolved.sheet.sheetId,
                    rowIndex: physicalRowIndex,
                    primaryKey: Object.freeze(primaryKey),
                    encodedPrimaryKey: Object.freeze(encodedPrimaryKey),
                    version,
                    originalEncoded: Object.freeze(encoded),
                    columnIndexes: header.logicalToPhysical,
                    headerFingerprint: header.fingerprint,
                    readAt: this.now().toISOString(),
                    relations: Object.freeze({}),
                    relationCardinalities: Object.freeze({}),
                });
                rows.push({ value: decoded, provenance });
            }
            this.registerLocators(resolved, header, rows, completeSnapshot, persistLocators);
            return {
                resolved,
                header,
                rows,
                range,
                cellsRead: values.reduce((sum, row) => sum + row.length, 0),
                bytesRead: estimateBytes(values),
            };
        }
        requireSnapshot(snapshots, tableName) {
            const snapshot = snapshots.get(tableName);
            if (snapshot === undefined)
                throw new GQueryRuntimeError("INVALID_QUERY", `No snapshot was loaded for table ${tableName}.`);
            return snapshot;
        }
        cacheForTable(table) {
            var _a, _b, _c, _d;
            if (this.readCacheSuppression > 0)
                return null;
            const policy = table.definition.cache;
            if (policy === undefined)
                return null;
            return (_d = (_c = (_b = (_a = this.options).cacheForScope) === null || _b === void 0 ? void 0 : _b.call(_a, policy.scope)) !== null && _c !== void 0 ? _c : this.options.cache) !== null && _d !== void 0 ? _d : null;
        }
        queryCachePlansForTable(tableName, queries) {
            const relevant = Object.values(queries).filter((query) => query.plan.table === tableName || query.plan.joins.some((join) => join.table === tableName));
            if (relevant.length === 0 || relevant.some((query) => query.localPredicates.length > 0))
                return null;
            return Object.freeze(relevant
                .map((query) => query.plan)
                .sort((left, right) => canonicalStringify$1(left).localeCompare(canonicalStringify$1(right))));
        }
        queryCacheKey(table, plans, identities, stale) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j;
            const policy = table.definition.cache;
            if (policy === undefined)
                throw new Error("A query cache key requires a table cache policy.");
            const dependencyNames = new Set();
            for (const plan of plans) {
                dependencyNames.add(plan.table);
                for (const join of plan.joins)
                    dependencyNames.add(join.table);
            }
            const dependencyIdentities = [...dependencyNames]
                .map((name) => { var _a; return (_a = identities.get(name)) !== null && _a !== void 0 ? _a : this.tableIdentity(name); })
                .sort((left, right) => left.tableName.localeCompare(right.tableName));
            const generations = [];
            if (!stale) {
                for (const dependency of dependencyIdentities) {
                    generations.push({
                        dependency: {
                            kind: "table",
                            sourceId: dependency.spreadsheetId,
                            table: dependency.tableName,
                        },
                        token: (_b = (_a = this.options.generations) === null || _a === void 0 ? void 0 : _a.current({
                            kind: "table",
                            sourceId: dependency.spreadsheetId,
                            table: dependency.tableName,
                        })) !== null && _b !== void 0 ? _b : "0",
                    });
                    for (const tag of (_d = (_c = dependency.definition.cache) === null || _c === void 0 ? void 0 : _c.tags) !== null && _d !== void 0 ? _d : []) {
                        generations.push({
                            dependency: { kind: "tag", tag },
                            token: (_f = (_e = this.options.generations) === null || _e === void 0 ? void 0 : _e.current({ kind: "tag", tag })) !== null && _f !== void 0 ? _f : "0",
                        });
                    }
                }
                generations.sort((left, right) => canonicalStringify$1(left.dependency).localeCompare(canonicalStringify$1(right.dependency)));
            }
            const headerRegistry = dependencyIdentities.map((dependency) => {
                var _a;
                return ({
                    table: dependency.tableName,
                    sheet: dependency.definition.sheet,
                    versionColumn: (_a = dependency.definition.versionColumn) !== null && _a !== void 0 ? _a : null,
                    columns: Object.entries(dependency.definition.columns).map(([field, column]) => {
                        var _a;
                        return ({
                            field,
                            header: (_a = column.header) !== null && _a !== void 0 ? _a : field,
                            kind: column.kind,
                        });
                    }),
                });
            });
            const key = buildQueryCacheKey({
                sourceIdentity: {
                    cachedTable: table.tableName,
                    dependencies: dependencyIdentities.map((dependency) => ({
                        table: dependency.tableName,
                        spreadsheetId: dependency.spreadsheetId,
                        sheet: dependency.definition.sheet,
                    })),
                },
                schemaVersion: this.schema.version,
                headerVersion: hashCanonical$1(headerRegistry),
                query: plans,
                projection: plans.flatMap((plan) => { var _a; return (_a = plan.projection) !== null && _a !== void 0 ? _a : []; }),
                renderOptions: {
                    valueRenderOption: tableUsesFormula$1(table.definition) ? "FORMULA" : "UNFORMATTED_VALUE",
                    dateTimeRenderOption: "SERIAL_NUMBER",
                },
                scopeIdentity: {
                    scope: policy.scope,
                    identity: (_j = (_h = (_g = this.options).scopeIdentity) === null || _h === void 0 ? void 0 : _h.call(_g, policy.scope)) !== null && _j !== void 0 ? _j : null,
                },
                generations,
            });
            return stale ? { ...key, kind: "stale-query" } : key;
        }
        freshCacheEntries(table, queries, identities) {
            const cache = this.cacheForTable(table);
            const policy = table.definition.cache;
            if (cache === null || policy === undefined)
                return [];
            const entries = [];
            const plans = this.queryCachePlansForTable(table.tableName, queries);
            if ((policy.mode === "query" || policy.mode === "row-and-query") && plans !== null) {
                entries.push({ cache, key: this.queryCacheKey(table, plans, identities, false) });
            }
            if (policy.mode === "row" || policy.mode === "row-and-query") {
                entries.push({ cache, key: this.tableCacheKey(table) });
            }
            return Object.freeze(entries);
        }
        staleCacheEntries(table, queries, identities) {
            const cache = this.cacheForTable(table);
            const policy = table.definition.cache;
            if (cache === null || (policy === null || policy === void 0 ? void 0 : policy.allowStaleOnQuota) !== true)
                return [];
            const entries = [];
            const plans = this.queryCachePlansForTable(table.tableName, queries);
            if ((policy.mode === "query" || policy.mode === "row-and-query") && plans !== null) {
                entries.push({ cache, key: this.queryCacheKey(table, plans, identities, true) });
            }
            if (policy.mode === "row" || policy.mode === "row-and-query") {
                entries.push({ cache, key: this.staleTableCacheKey(table) });
            }
            return Object.freeze(entries);
        }
        cachedSnapshotFrom(identity, entries) {
            for (const entry of entries) {
                let cached;
                try {
                    cached = entry.cache.read(entry.key);
                }
                catch {
                    continue;
                }
                if (cached.state !== "hit" || cached.value === undefined)
                    continue;
                const snapshot = this.parseCachedSnapshot(identity, cached.value);
                if (snapshot !== null)
                    return snapshot;
            }
            return null;
        }
        publishSnapshot(table, values, snapshot, entries, stale) {
            var _a, _b;
            if (entries.length === 0)
                return;
            const payload = this.snapshotPayload(table, values, snapshot);
            for (const entry of entries) {
                try {
                    entry.cache.put(entry.key, payload, stale
                        ? { ttlSeconds: 21600 }
                        : {
                            ttlSeconds: (_a = table.definition.cache) === null || _a === void 0 ? void 0 : _a.ttlSeconds,
                            jitterSeconds: (_b = table.definition.cache) === null || _b === void 0 ? void 0 : _b.jitterSeconds,
                        });
                }
                catch {
                    // Cache publication is an optimization. A valid Sheets response remains authoritative.
                }
            }
        }
        snapshotPayload(table, values, snapshot) {
            return {
                version: 2,
                spreadsheetId: table.spreadsheetId,
                tableName: table.tableName,
                sheet: this.cachedSheetMetadata(table.sheet, values),
                headerFingerprint: snapshot.header.fingerprint,
                range: sheetRange(table.definition.sheet),
                values,
            };
        }
        /**
         * Work out the smallest safe logical row shape shared by every query that
         * depends on this table. Cold reads remain complete because physical column
         * positions are schema data learned from the header row. Cache-backed reads
         * also remain complete so a partial matrix is never published as a table
         * snapshot.
         */
        snapshotFieldsForQueries(table, queries) {
            var _a, _b;
            const header = this.headers.get(`${table.spreadsheetId}:${table.definition.sheet}`);
            if (header === undefined || this.cacheForTable(table) !== null)
                return null;
            if (table.definition.primaryKey.length === 0)
                return null;
            const fields = new Set();
            let relevant = false;
            for (const query of Object.values(queries)) {
                if (query.plan.table === table.tableName) {
                    relevant = true;
                    if (query.localPredicates.length > 0 || query.plan.projection === undefined)
                        return null;
                    collectPredicateFields(query.plan.predicate, fields);
                    for (const field of query.plan.projection) {
                        if (table.definition.columns[field] !== undefined)
                            fields.add(field);
                    }
                    for (const order of query.plan.orderBy) {
                        if (table.definition.columns[order.field] !== undefined)
                            fields.add(order.field);
                    }
                    for (const join of query.plan.joins) {
                        if (join.table === table.tableName)
                            continue;
                        for (const field of asArray(join.localField))
                            fields.add(field);
                    }
                }
                for (const join of query.plan.joins) {
                    if (join.table !== table.tableName)
                        continue;
                    relevant = true;
                    for (const field of asArray(join.foreignField))
                        fields.add(field);
                    if (join.kind === "semi" || join.kind === "anti")
                        continue;
                    if (join.select === undefined)
                        return null;
                    for (const field of join.select)
                        fields.add(field);
                }
            }
            if (!relevant)
                return null;
            for (const field of table.definition.primaryKey)
                fields.add(field);
            for (const key of table.definition.unique) {
                for (const field of key)
                    fields.add(field);
            }
            for (const key of (_b = (_a = table.definition.cache) === null || _a === void 0 ? void 0 : _a.indexes) !== null && _b !== void 0 ? _b : []) {
                for (const field of key)
                    fields.add(field);
            }
            for (const relation of Object.values(table.definition.relations)) {
                for (const field of asArray(relation.local))
                    fields.add(field);
            }
            return Object.freeze([...fields].sort((left, right) => header.logicalToPhysical[left] - header.logicalToPhysical[right]));
        }
        snapshotReadPlan(table, queries) {
            const fields = this.snapshotFieldsForQueries(table, queries);
            if (fields === null) {
                return {
                    table,
                    fields: null,
                    blocks: Object.freeze([{
                            startColumnIndex: 0,
                            endColumnIndex: Math.max(0, table.sheet.columnCount - 1),
                            range: sheetRange(table.definition.sheet),
                        }]),
                };
            }
            const header = this.headers.get(`${table.spreadsheetId}:${table.definition.sheet}`);
            const indexes = new Set(fields.map((field) => header.logicalToPhysical[field]));
            if (table.definition.versionColumn !== undefined) {
                indexes.add(header.logicalToPhysical[table.definition.versionColumn]);
            }
            const ordered = [...indexes].sort((left, right) => left - right);
            const blocks = [];
            for (const columnIndex of ordered) {
                const previous = blocks[blocks.length - 1];
                if (previous !== undefined && previous.endColumnIndex + 1 === columnIndex) {
                    blocks[blocks.length - 1] = {
                        startColumnIndex: previous.startColumnIndex,
                        endColumnIndex: columnIndex,
                        range: sheetRange(table.definition.sheet, `${columnIndexToLetter(previous.startColumnIndex)}:${columnIndexToLetter(columnIndex)}`),
                    };
                }
                else {
                    const column = columnIndexToLetter(columnIndex);
                    blocks.push({
                        startColumnIndex: columnIndex,
                        endColumnIndex: columnIndex,
                        range: sheetRange(table.definition.sheet, `${column}:${column}`),
                    });
                }
            }
            return { table, fields, blocks: Object.freeze(blocks) };
        }
        partialSnapshotValues(plan, ranges) {
            const header = this.headers.get(`${plan.table.spreadsheetId}:${plan.table.definition.sheet}`);
            if (header === undefined || plan.fields === null) {
                throw new Error("A partial snapshot requires a validated header registry.");
            }
            const height = Math.max(1, ...ranges.map((values) => values.length));
            const matrix = Array.from({ length: height }, () => Array.from({ length: header.headers.length }, () => null));
            matrix[0] = [...header.headers];
            plan.blocks.forEach((block, blockIndex) => {
                var _a, _b, _c, _d;
                const values = (_a = ranges[blockIndex]) !== null && _a !== void 0 ? _a : [];
                const width = block.endColumnIndex - block.startColumnIndex + 1;
                for (let offset = 0; offset < width; offset += 1) {
                    const physicalIndex = block.startColumnIndex + offset;
                    const actual = (_b = values[0]) === null || _b === void 0 ? void 0 : _b[offset];
                    const expected = (_c = header.headers[physicalIndex]) !== null && _c !== void 0 ? _c : "";
                    if (String(actual !== null && actual !== void 0 ? actual : "") !== expected) {
                        throw new GQueryRuntimeError("SCHEMA_CHANGED", `Sheet ${plan.table.definition.sheet} headers changed after the column registry was loaded.`, {
                            details: {
                                table: plan.table.tableName,
                                columnIndex: physicalIndex,
                                expected,
                                actual: String(actual !== null && actual !== void 0 ? actual : ""),
                            },
                        });
                    }
                }
                for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
                    const source = (_d = values[rowIndex]) !== null && _d !== void 0 ? _d : [];
                    for (let offset = 0; offset < width; offset += 1) {
                        matrix[rowIndex][block.startColumnIndex + offset] = rawCell(source[offset]);
                    }
                }
            });
            return matrix;
        }
        readSnapshotGroup(spreadsheetId, tables, queries, identities, stats, excludedFreshEntry) {
            var _a, _b;
            const plans = tables.map((table) => this.snapshotReadPlan(table, queries));
            const ranges = plans.flatMap((plan) => plan.blocks.map((block) => block.range));
            const response = this.options.transport.batchGet(spreadsheetId, ranges, {
                valueRenderOption: tables.some((table) => tableUsesFormula$1(table.definition))
                    ? "FORMULA"
                    : "UNFORMATTED_VALUE",
                dateTimeRenderOption: "SERIAL_NUMBER",
            });
            stats.apiCalls += 1;
            const loaded = new Map();
            let responseIndex = 0;
            for (const plan of plans) {
                const table = plan.table;
                const returned = plan.blocks.map(() => { var _a, _b; return (_b = (_a = response.valueRanges[responseIndex++]) === null || _a === void 0 ? void 0 : _a.values) !== null && _b !== void 0 ? _b : []; });
                const values = plan.fields === null
                    ? ((_a = returned[0]) !== null && _a !== void 0 ? _a : [])
                    : this.partialSnapshotValues(plan, returned);
                const actualCellsRead = returned.reduce((total, valueRange) => total + valueRange.reduce((sum, row) => sum + row.length, 0), 0);
                const actualBytesRead = estimateBytes(returned);
                const parsed = this.parseSnapshot(table, values, plan.blocks.map((block) => block.range).join(","), undefined, plan.fields === null, plan.fields === null, (_b = plan.fields) !== null && _b !== void 0 ? _b : undefined);
                const snapshot = {
                    ...parsed,
                    cellsRead: actualCellsRead,
                    bytesRead: actualBytesRead,
                };
                stats.cellsRead += actualCellsRead;
                stats.bytesRead += actualBytesRead;
                stats.rangesRead.push(...plan.blocks.map((block) => block.range));
                const freshEntries = this.freshCacheEntries(table, queries, identities).filter((entry) => excludedFreshEntry === undefined ||
                    table.tableName !== excludedFreshEntry.tableName ||
                    canonicalStringify$1(entry.key) !== canonicalStringify$1(excludedFreshEntry.key));
                if (plan.fields === null) {
                    this.publishSnapshot(table, values, snapshot, freshEntries, false);
                    this.publishSnapshot(table, values, snapshot, this.staleCacheEntries(table, queries, identities), true);
                }
                loaded.set(table.tableName, {
                    snapshot,
                    payload: this.snapshotPayload(table, values, snapshot),
                });
            }
            return loaded;
        }
        indexForQuery(query) {
            var _a, _b;
            if (query.plan.joins.length > 0 || query.localPredicates.length > 0)
                return null;
            const values = equalityFields(query.plan.predicate);
            if (values === null)
                return null;
            const definition = this.table(query.plan.table);
            const candidates = [
                definition.primaryKey,
                ...definition.unique,
                ...((_b = (_a = definition.cache) === null || _a === void 0 ? void 0 : _a.indexes) !== null && _b !== void 0 ? _b : []),
            ];
            const fields = candidates.find((candidate) => candidate.length > 0 && candidate.every((field) => values.has(field)));
            return fields === undefined ? null : { fields, values };
        }
        locatorCacheEntry(table, fields) {
            var _a, _b, _c, _d, _e, _f;
            const policy = table.definition.cache;
            const cache = this.cacheForTable(table);
            if (cache === null ||
                policy === undefined ||
                (policy.mode !== "row" && policy.mode !== "row-and-query")) {
                return null;
            }
            const generation = (_b = (_a = this.options.generations) === null || _a === void 0 ? void 0 : _a.current({
                kind: "table",
                sourceId: table.spreadsheetId,
                table: table.tableName,
            })) !== null && _b !== void 0 ? _b : "0";
            return {
                cache,
                key: {
                    kind: "locator-index",
                    spreadsheetId: table.spreadsheetId,
                    schemaVersion: this.schema.version,
                    table: table.tableName,
                    sheet: table.definition.sheet,
                    fields,
                    columns: fields.map((field) => {
                        var _a, _b;
                        const column = table.definition.columns[field];
                        return [field, (_a = column === null || column === void 0 ? void 0 : column.header) !== null && _a !== void 0 ? _a : field, (_b = column === null || column === void 0 ? void 0 : column.kind) !== null && _b !== void 0 ? _b : null];
                    }),
                    scope: policy.scope,
                    scopeIdentity: (_e = (_d = (_c = this.options).scopeIdentity) === null || _d === void 0 ? void 0 : _d.call(_c, policy.scope)) !== null && _e !== void 0 ? _e : null,
                    generation,
                    tagGenerations: ((_f = policy.tags) !== null && _f !== void 0 ? _f : []).map((tag) => {
                        var _a, _b;
                        return ({
                            tag,
                            generation: (_b = (_a = this.options.generations) === null || _a === void 0 ? void 0 : _a.current({ kind: "tag", tag })) !== null && _b !== void 0 ? _b : "0",
                        });
                    }),
                },
            };
        }
        hydratePersistentLocator(query, resolved, stats) {
            const indexed = this.indexForQuery(query);
            if (indexed === null)
                return;
            const entry = this.locatorCacheEntry(resolved, indexed.fields);
            if (entry === null)
                return;
            let cached;
            try {
                cached = entry.cache.read(entry.key);
            }
            catch {
                return;
            }
            if (cached.state !== "hit" || cached.value === undefined)
                return;
            const payload = cached.value;
            try {
                if (payload.version !== 1 ||
                    payload.spreadsheetId !== resolved.spreadsheetId ||
                    payload.table !== resolved.tableName ||
                    !this.validCachedSheet(payload.sheet, resolved.definition.sheet) ||
                    payload.sheet.sheetId !== resolved.sheet.sheetId ||
                    !Array.isArray(payload.headers) ||
                    !payload.headers.every((header) => typeof header === "string") ||
                    !Array.isArray(payload.fields) ||
                    canonicalStringify$1(payload.fields) !== canonicalStringify$1(indexed.fields) ||
                    hashCanonical$1(payload.headers) !== payload.headerFingerprint ||
                    !Array.isArray(payload.entries)) {
                    return;
                }
                const header = this.parseHeader(resolved, payload.headers);
                if (header.fingerprint !== payload.headerFingerprint)
                    return;
                const fingerprint = hashCanonical$1(indexed.fields.map((field) => indexed.values.get(field)));
                const cachedEntry = payload.entries.find(([key]) => key === fingerprint);
                // A locator cache is a hint, not a negative index. Out-of-band inserts
                // do not necessarily rotate GQuery's generation, so an absent key must
                // fall through to the authoritative narrow key-column scan.
                if (cachedEntry === undefined)
                    return;
                const located = cachedEntry[1];
                if (!Array.isArray(located) ||
                    !located.every((rowIndex) => Number.isSafeInteger(rowIndex) && rowIndex > 0 && rowIndex < payload.sheet.rowCount)) {
                    return;
                }
                this.locators.set(this.locatorKey(resolved, indexed.fields, Object.fromEntries(indexed.values)), Object.freeze([...located]));
                stats.cacheHits += 1;
            }
            catch {
                // Invalid locator indexes are optional cache misses. The planner will use
                // a full snapshot and republish a validated generation below.
            }
        }
        publishPersistentLocators(resolved, header, rows) {
            var _a, _b, _c, _d, _e;
            const indexes = [
                resolved.definition.primaryKey,
                ...resolved.definition.unique,
                ...((_b = (_a = resolved.definition.cache) === null || _a === void 0 ? void 0 : _a.indexes) !== null && _b !== void 0 ? _b : []),
            ];
            const seen = new Set();
            for (const fields of indexes) {
                if (fields.length === 0)
                    continue;
                const identity = canonicalStringify$1(fields);
                if (seen.has(identity))
                    continue;
                seen.add(identity);
                const entry = this.locatorCacheEntry(resolved, fields);
                if (entry === null)
                    continue;
                const entries = new Map();
                for (const row of rows) {
                    const fingerprint = hashCanonical$1(fields.map((field) => row.value[field]));
                    const located = (_c = entries.get(fingerprint)) !== null && _c !== void 0 ? _c : [];
                    located.push(row.provenance.rowIndex);
                    entries.set(fingerprint, located);
                }
                try {
                    entry.cache.put(entry.key, {
                        version: 1,
                        spreadsheetId: resolved.spreadsheetId,
                        table: resolved.tableName,
                        sheet: Object.freeze({ ...resolved.sheet }),
                        headerFingerprint: header.fingerprint,
                        headers: header.headers,
                        fields: Object.freeze([...fields]),
                        entries: Object.freeze([...entries.entries()]
                            .sort(([left], [right]) => left.localeCompare(right))
                            .map(([fingerprint, rowIndexes]) => Object.freeze([fingerprint, Object.freeze([...rowIndexes])]))),
                    }, {
                        ttlSeconds: (_d = resolved.definition.cache) === null || _d === void 0 ? void 0 : _d.ttlSeconds,
                        jitterSeconds: (_e = resolved.definition.cache) === null || _e === void 0 ? void 0 : _e.jitterSeconds,
                    });
                }
                catch {
                    // A locator index is only a hint; narrow scans rebuild it after misses.
                }
            }
        }
        canPlanBounded(query) {
            if (this.indexForQuery(query) === null)
                return false;
            const definition = this.table(query.plan.table);
            const runtimeCacheConfigured = definition.cache !== undefined &&
                (this.options.cache !== undefined || this.options.cacheForScope !== undefined);
            if (runtimeCacheConfigured)
                return false;
            const source = this.source(definition.source);
            if (source.kind === "spreadsheet-id") {
                return this.headers.has(`${source.spreadsheetId}:${definition.sheet}`);
            }
            return [...this.headers.keys()].some((key) => key.endsWith(`:${definition.sheet}`));
        }
        tryBoundedRead(query, resolved) {
            var _a;
            const indexed = this.indexForQuery(query);
            const header = this.headers.get(`${resolved.spreadsheetId}:${resolved.definition.sheet}`);
            if (indexed === null || header === undefined)
                return null;
            const logical = {};
            const encoded = {};
            for (const field of indexed.fields) {
                const value = indexed.values.get(field);
                logical[field] = value;
                const column = resolved.definition.columns[field];
                encoded[field] = storedSheetValue(toSheetInput(column.encode(value, {
                    table: resolved.tableName,
                    column: field,
                    header: (_a = column.header) !== null && _a !== void 0 ? _a : field,
                })));
            }
            const locatorKey = this.locatorKey(resolved, indexed.fields, logical);
            const stats = createExecutionStats();
            const decodedFields = this.snapshotFieldsForQueries(resolved, { bounded: query });
            let rowIndexes = this.locators.get(locatorKey);
            if (rowIndexes === undefined) {
                rowIndexes = this.scanLocator(resolved, header, indexed.fields, encoded, stats);
                this.locators.set(locatorKey, rowIndexes);
            }
            let loaded = this.loadLocatedRows(resolved, header, indexed.fields, encoded, rowIndexes, stats, decodedFields !== null && decodedFields !== void 0 ? decodedFields : undefined);
            if (loaded === null) {
                this.locators.delete(locatorKey);
                rowIndexes = this.scanLocator(resolved, header, indexed.fields, encoded, stats);
                this.locators.set(locatorKey, rowIndexes);
                loaded = this.loadLocatedRows(resolved, header, indexed.fields, encoded, rowIndexes, stats, decodedFields !== null && decodedFields !== void 0 ? decodedFields : undefined);
            }
            return loaded === null ? null : { snapshot: loaded, stats };
        }
        scanLocator(resolved, header, fields, expected, stats) {
            const ranges = fields.map((field) => {
                const column = columnIndexToLetter(header.logicalToPhysical[field]);
                return sheetRange(resolved.definition.sheet, `${column}2:${column}`);
            });
            const response = this.options.transport.batchGet(resolved.spreadsheetId, ranges, {
                valueRenderOption: fields.some((field) => { var _a; return ((_a = resolved.definition.columns[field]) === null || _a === void 0 ? void 0 : _a.kind) === "formula"; }) ? "FORMULA" : "UNFORMATTED_VALUE",
                dateTimeRenderOption: "SERIAL_NUMBER",
            });
            stats.apiCalls += 1;
            stats.rangesRead.push(...ranges);
            stats.cellsRead += response.valueRanges.reduce((total, valueRange) => total + valueRange.values.reduce((sum, row) => sum + row.length, 0), 0);
            stats.bytesRead += estimateBytes(response.valueRanges);
            const height = response.valueRanges.reduce((maximum, valueRange) => Math.max(maximum, valueRange.values.length), 0);
            const matches = [];
            for (let rowOffset = 0; rowOffset < height; rowOffset += 1) {
                const matchesKey = fields.every((field, fieldIndex) => { var _a, _b; return sameCell((_b = (_a = response.valueRanges[fieldIndex]) === null || _a === void 0 ? void 0 : _a.values[rowOffset]) === null || _b === void 0 ? void 0 : _b[0], expected[field]); });
                if (matchesKey)
                    matches.push(rowOffset + 1);
            }
            return Object.freeze(matches);
        }
        loadLocatedRows(resolved, header, fields, expected, rowIndexes, stats, decodedFields) {
            if (rowIndexes.length === 0) {
                return this.parseSnapshot(resolved, [header.headers], `${resolved.definition.sheet}:bounded-empty`, [], false, false, decodedFields);
            }
            const blocks = decodedFields === undefined
                ? [{ start: 0, end: Math.max(0, header.headers.length - 1) }]
                : (() => {
                    const indexes = new Set(decodedFields.map((field) => header.logicalToPhysical[field]));
                    if (resolved.definition.versionColumn !== undefined) {
                        indexes.add(header.logicalToPhysical[resolved.definition.versionColumn]);
                    }
                    const compacted = [];
                    for (const index of [...indexes].sort((left, right) => left - right)) {
                        const previous = compacted[compacted.length - 1];
                        if (previous !== undefined && previous.end + 1 === index)
                            previous.end = index;
                        else
                            compacted.push({ start: index, end: index });
                    }
                    return compacted;
                })();
            const ranges = rowIndexes.flatMap((rowIndex) => blocks.map((block) => cellRange(resolved.definition.sheet, rowIndex, block.start, 1, block.end - block.start + 1)));
            const response = this.options.transport.batchGet(resolved.spreadsheetId, ranges, {
                valueRenderOption: tableUsesFormula$1(resolved.definition)
                    ? "FORMULA"
                    : "UNFORMATTED_VALUE",
                dateTimeRenderOption: "SERIAL_NUMBER",
            });
            stats.apiCalls += 1;
            stats.rangesRead.push(...ranges);
            stats.cellsRead += response.valueRanges.reduce((total, valueRange) => total + valueRange.values.reduce((sum, row) => sum + row.length, 0), 0);
            stats.bytesRead += estimateBytes(response.valueRanges);
            const rows = rowIndexes.map((_, rowOffset) => {
                const row = Array.from({ length: header.headers.length }, () => null);
                blocks.forEach((block, blockOffset) => {
                    var _a, _b;
                    const values = (_b = (_a = response.valueRanges[rowOffset * blocks.length + blockOffset]) === null || _a === void 0 ? void 0 : _a.values[0]) !== null && _b !== void 0 ? _b : [];
                    for (let offset = 0; offset <= block.end - block.start; offset += 1) {
                        row[block.start + offset] = rawCell(values[offset]);
                    }
                });
                return row;
            });
            const valid = rows.every((row) => fields.every((field) => sameCell(row[header.logicalToPhysical[field]], expected[field])));
            if (!valid)
                return null;
            return this.parseSnapshot(resolved, [header.headers, ...rows], ranges.join(","), rowIndexes, false, false, decodedFields);
        }
        locatorKey(resolved, fields, row) {
            return `${resolved.spreadsheetId}:${resolved.tableName}:${fields.join("\u001f")}:${hashCanonical$1(fields.map((field) => row[field]))}`;
        }
        registerLocators(resolved, header, rows, completeSnapshot, persistLocators) {
            var _a, _b, _c;
            if (completeSnapshot)
                this.clearTableLocators(resolved.spreadsheetId, resolved.tableName);
            const indexes = [
                resolved.definition.primaryKey,
                ...resolved.definition.unique,
                ...((_b = (_a = resolved.definition.cache) === null || _a === void 0 ? void 0 : _a.indexes) !== null && _b !== void 0 ? _b : []),
            ];
            for (const fields of indexes) {
                if (fields.length === 0)
                    continue;
                for (const row of rows) {
                    if (!fields.every((field) => Object.prototype.hasOwnProperty.call(row.value, field)))
                        continue;
                    const key = this.locatorKey(resolved, fields, row.value);
                    const current = (_c = this.locators.get(key)) !== null && _c !== void 0 ? _c : [];
                    if (!current.includes(row.provenance.rowIndex)) {
                        this.locators.set(key, Object.freeze([...current, row.provenance.rowIndex].sort((a, b) => a - b)));
                    }
                }
            }
            if (completeSnapshot && persistLocators) {
                this.publishPersistentLocators(resolved, header, rows);
            }
        }
        clearTableLocators(spreadsheetId, tableName) {
            const prefix = `${spreadsheetId}:${tableName}:`;
            for (const key of [...this.locators.keys()]) {
                if (key.startsWith(prefix))
                    this.locators.delete(key);
            }
        }
        tableCacheKey(table) {
            var _a, _b, _c, _d, _e, _f;
            const policy = table.definition.cache;
            if (policy === undefined)
                throw new Error("A cache key requires a table cache policy.");
            const generation = (_b = (_a = this.options.generations) === null || _a === void 0 ? void 0 : _a.current({
                kind: "table",
                sourceId: table.spreadsheetId,
                table: table.tableName,
            })) !== null && _b !== void 0 ? _b : "0";
            const tagGenerations = ((_c = policy.tags) !== null && _c !== void 0 ? _c : []).map((tag) => {
                var _a, _b;
                return ({
                    tag,
                    generation: (_b = (_a = this.options.generations) === null || _a === void 0 ? void 0 : _a.current({ kind: "tag", tag })) !== null && _b !== void 0 ? _b : "0",
                });
            });
            return {
                kind: "table-snapshot",
                spreadsheetId: table.spreadsheetId,
                schemaVersion: this.schema.version,
                table: table.tableName,
                sheet: table.definition.sheet,
                columns: Object.entries(table.definition.columns).map(([field, column]) => {
                    var _a;
                    return [
                        field,
                        (_a = column.header) !== null && _a !== void 0 ? _a : field,
                        column.kind,
                    ];
                }),
                valueRenderOption: tableUsesFormula$1(table.definition)
                    ? "FORMULA"
                    : "UNFORMATTED_VALUE",
                scope: policy.scope,
                scopeIdentity: (_f = (_e = (_d = this.options).scopeIdentity) === null || _e === void 0 ? void 0 : _e.call(_d, policy.scope)) !== null && _f !== void 0 ? _f : null,
                generation,
                tagGenerations,
            };
        }
        staleTableCacheKey(table) {
            var _a, _b;
            const key = this.tableCacheKey(table);
            return {
                ...key,
                kind: "stale-table-snapshot",
                generation: "stale",
                tagGenerations: ((_b = (_a = table.definition.cache) === null || _a === void 0 ? void 0 : _a.tags) !== null && _b !== void 0 ? _b : []).map((tag) => ({ tag })),
            };
        }
        preflight(materialized) {
            var _a;
            const stats = createExecutionStats();
            const conflicts = [];
            const bySpreadsheet = new Map();
            for (const item of materialized) {
                const group = (_a = bySpreadsheet.get(item.provenance.spreadsheetId)) !== null && _a !== void 0 ? _a : [];
                group.push(item);
                bySpreadsheet.set(item.provenance.spreadsheetId, group);
            }
            for (const [spreadsheetId, items] of bySpreadsheet) {
                const headerGroups = new Map();
                for (const item of items)
                    headerGroups.set(`${item.provenance.sheetId}`, item.provenance);
                const headerRanges = [...headerGroups.values()].map((provenance) => sheetRange(provenance.sheetName, "1:1"));
                const entries = items.map((item) => {
                    const definition = this.table(item.provenance.tableName);
                    const fields = definition.primaryKey.length > 0
                        ? [...definition.primaryKey]
                        : Object.keys(definition.columns);
                    const indexes = fields.map((field) => item.provenance.columnIndexes[field]);
                    if (definition.versionColumn !== undefined)
                        indexes.push(item.provenance.columnIndexes[definition.versionColumn]);
                    const minColumn = Math.min(...indexes);
                    const maxColumn = Math.max(...indexes);
                    return {
                        materialized: item,
                        minColumn,
                        maxColumn,
                        range: cellRange(item.provenance.sheetName, item.provenance.rowIndex, minColumn, 1, maxColumn - minColumn + 1),
                    };
                });
                const ranges = [...headerRanges, ...entries.map((entry) => entry.range)];
                const response = this.options.transport.batchGet(spreadsheetId, ranges, {
                    valueRenderOption: items.some((item) => tableUsesFormula$1(this.table(item.provenance.tableName))) ? "FORMULA" : "UNFORMATTED_VALUE",
                    dateTimeRenderOption: "SERIAL_NUMBER",
                });
                stats.apiCalls += 1;
                stats.rangesRead.push(...ranges);
                stats.cellsRead += response.valueRanges.reduce((sum, valueRange) => sum + valueRange.values.reduce((inner, row) => inner + row.length, 0), 0);
                stats.bytesRead += estimateBytes(response.valueRanges);
                [...headerGroups.values()].forEach((provenance, index) => {
                    var _a, _b;
                    const fingerprint = hashCanonical$1(((_b = (_a = response.valueRanges[index]) === null || _a === void 0 ? void 0 : _a.values[0]) !== null && _b !== void 0 ? _b : []).map((value) => typeof value === "string" ? value : String(value !== null && value !== void 0 ? value : "")));
                    if (fingerprint !== provenance.headerFingerprint) {
                        conflicts.push({
                            code: "schema-changed",
                            table: provenance.tableName,
                            key: provenance.primaryKey,
                            expected: provenance.headerFingerprint,
                            actual: fingerprint,
                            message: `Headers changed after ${provenance.tableName} was read.`,
                        });
                    }
                });
                entries.forEach((entry, entryIndex) => {
                    var _a;
                    const row = (_a = response.valueRanges[headerRanges.length + entryIndex]) === null || _a === void 0 ? void 0 : _a.values[0];
                    const provenance = entry.materialized.provenance;
                    if (row === undefined || row.length === 0) {
                        conflicts.push({
                            code: "missing",
                            table: provenance.tableName,
                            key: provenance.primaryKey,
                            rowIndex: provenance.rowIndex,
                            message: "The selected row no longer exists.",
                        });
                        return;
                    }
                    const definition = this.table(provenance.tableName);
                    const verifyFields = definition.primaryKey.length > 0
                        ? definition.primaryKey
                        : Object.keys(definition.columns);
                    for (const field of verifyFields) {
                        const offset = provenance.columnIndexes[field] - entry.minColumn;
                        const expected = definition.primaryKey.length > 0
                            ? provenance.encodedPrimaryKey[field]
                            : provenance.originalEncoded[field];
                        const actual = row[offset];
                        if (!sameCell(actual, expected)) {
                            conflicts.push({
                                code: "key-changed",
                                table: provenance.tableName,
                                key: provenance.primaryKey,
                                rowIndex: provenance.rowIndex,
                                expected,
                                actual: rawCell(actual),
                                message: `Row identity column ${field} changed after it was selected.`,
                            });
                            break;
                        }
                    }
                    if (definition.versionColumn !== undefined) {
                        const offset = provenance.columnIndexes[definition.versionColumn] - entry.minColumn;
                        const actual = rawCell(row[offset]);
                        if (!sameCell(actual, provenance.version)) {
                            conflicts.push({
                                code: "version-changed",
                                table: provenance.tableName,
                                key: provenance.primaryKey,
                                rowIndex: provenance.rowIndex,
                                expected: provenance.version,
                                actual,
                                message: "The row version changed after it was selected.",
                            });
                        }
                    }
                });
            }
            return { conflicts, stats };
        }
        assertSingleMutationTable(materialized) {
            const identities = new Set(materialized.map((item) => `${item.provenance.spreadsheetId}:${item.provenance.tableName}`));
            if (identities.size > 1) {
                throw new GQueryRuntimeError("MUTATION_INVALID", "One selection mutation must target exactly one physical table.");
            }
        }
        groupPatchesBySpreadsheet(prepared) {
            var _a;
            const result = new Map();
            for (const item of prepared) {
                const id = item.before.provenance.spreadsheetId;
                const patches = (_a = result.get(id)) !== null && _a !== void 0 ? _a : [];
                patches.push(...item.patches);
                result.set(id, patches);
            }
            return result;
        }
        formatMutations(prepared) {
            var _a;
            const mutations = [];
            for (const item of prepared) {
                const definition = this.table(item.before.provenance.tableName);
                for (const field of item.changedFields) {
                    const format = (_a = definition.columns[field]) === null || _a === void 0 ? void 0 : _a.format;
                    if (format === undefined || Object.keys(format).length === 0)
                        continue;
                    mutations.push({
                        kind: "formatCells",
                        sheetId: item.before.provenance.sheetId,
                        startRowIndex: item.before.provenance.rowIndex,
                        startColumnIndex: item.before.provenance.columnIndexes[field],
                        rowCount: 1,
                        columnCount: 1,
                        format,
                    });
                }
            }
            return mutations;
        }
        sheetName(spreadsheetId, sheetId) {
            var _a, _b, _c, _d;
            return (_d = (_c = (_b = (_a = this.metadata.get(spreadsheetId)) === null || _a === void 0 ? void 0 : _a.find((sheet) => sheet.sheetId === sheetId)) === null || _b === void 0 ? void 0 : _b.title) !== null && _c !== void 0 ? _c : this.knownSheetTitles.get(this.knownSheetIdKey(spreadsheetId, sheetId))) !== null && _d !== void 0 ? _d : `sheetId:${sheetId}`;
        }
        invalidateMaterialized(materialized) {
            const tables = new Set();
            for (const item of materialized) {
                const identity = `${item.provenance.spreadsheetId}:${item.provenance.tableName}`;
                if (!tables.has(identity)) {
                    tables.add(identity);
                    this.invalidateTable(item.provenance.spreadsheetId, item.provenance.tableName);
                }
            }
        }
    }

    class ExecutionBudget {
        constructor(maxElapsedMs = 20000, clock = systemClock) {
            this.clock = clock;
            if (!Number.isFinite(maxElapsedMs) || maxElapsedMs <= 0) {
                throw new RangeError("Execution budget must be a positive number of milliseconds.");
            }
            this.startedAtMs = clock.now();
            this.deadlineMs = this.startedAtMs + maxElapsedMs;
        }
        now() {
            return this.clock.now();
        }
        elapsedMs() {
            return Math.max(0, this.now() - this.startedAtMs);
        }
        remainingMs() {
            return Math.max(0, this.deadlineMs - this.now());
        }
        assertAvailable(cause) {
            const now = this.now();
            if (now >= this.deadlineMs) {
                throw new DeadlineExceededError(this.deadlineMs, now, cause);
            }
        }
    }
    function validatePolicy(policy) {
        var _a, _b, _c;
        const maxAttempts = (_a = policy.maxAttempts) !== null && _a !== void 0 ? _a : 5;
        const baseDelayMs = (_b = policy.baseDelayMs) !== null && _b !== void 0 ? _b : 500;
        const maxDelayMs = (_c = policy.maxDelayMs) !== null && _c !== void 0 ? _c : 10000;
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
    function canRetry(operation) {
        return (operation.kind === "read" ||
            operation.kind === "idempotent-write" ||
            operation.idempotent === true ||
            (typeof operation.idempotencyKey === "string" && operation.idempotencyKey.length > 0));
    }
    function isCommitAmbiguous(operation) {
        return operation.kind === "append" || operation.kind === "structural-delete" || operation.kind === "write";
    }
    /** Synchronous retry execution which can share one deadline across many API calls. */
    class RetryController {
        constructor(dependencies = {}) {
            var _a, _b, _c;
            this.clock = (_a = dependencies.clock) !== null && _a !== void 0 ? _a : systemClock;
            this.sleeper = (_b = dependencies.sleeper) !== null && _b !== void 0 ? _b : appsScriptSleeper;
            this.random = (_c = dependencies.random) !== null && _c !== void 0 ? _c : mathRandomSource;
        }
        run(operation, options) {
            return this.execute(operation, options).value;
        }
        execute(operation, options) {
            var _a, _b;
            const policy = validatePolicy(options);
            const budget = (_a = options.budget) !== null && _a !== void 0 ? _a : new ExecutionBudget(20000, this.clock);
            const retrySafe = canRetry(options.operation);
            let attempts = 0;
            let sleptMs = 0;
            let lastFailureKind;
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
                }
                catch (error) {
                    if (error instanceof DeadlineExceededError || (error instanceof GQueryV2Error && !(error instanceof ApiFailure))) {
                        throw error;
                    }
                    const failure = normalizeApiFailure(error);
                    lastFailureKind = failure.api.kind;
                    if (!failure.api.retryable)
                        throw failure;
                    if (!retrySafe) {
                        if (isCommitAmbiguous(options.operation)) {
                            throw new AmbiguousCommitError(options.operation.kind, failure);
                        }
                        throw failure;
                    }
                    if (attempts >= policy.maxAttempts) {
                        throw new RetryExhaustedError(attempts, failure);
                    }
                    const exponentialCap = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, attempts - 1));
                    const jitter = Math.floor(Math.max(0, Math.min(1, this.random.next())) * exponentialCap);
                    const delayMs = Math.max(jitter, (_b = failure.api.retryAfterMs) !== null && _b !== void 0 ? _b : 0);
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
            throw new RetryExhaustedError(attempts, normalizeApiFailure(new Error("Retry loop exited unexpectedly.")));
        }
    }

    /** Connects the transport interception port to a shared retry/deadline budget. */
    class RetryTransportInvoker {
        constructor(controller, options) {
            this.controller = controller;
            this.options = options;
        }
        invoke(context, operation) {
            var _a, _b, _c, _d;
            const retryOperation = {
                kind: context.operationClass,
                idempotent: context.idempotent,
                idempotencyKey: (_b = (_a = this.options).idempotencyKey) === null || _b === void 0 ? void 0 : _b.call(_a, context),
            };
            const result = this.controller.execute(operation, {
                operation: retryOperation,
                budget: this.options.budget,
                maxAttempts: this.options.maxAttempts,
                baseDelayMs: this.options.baseDelayMs,
                maxDelayMs: this.options.maxDelayMs,
            });
            (_d = (_c = this.options).onAttemptComplete) === null || _d === void 0 ? void 0 : _d.call(_c, context, result.stats);
            return result.value;
        }
    }
    /**
     * Shares one deadline across every transport call made inside `run()`. Nested
     * scopes reuse the outer deadline, while an isolated invocation still gets a
     * bounded budget of its own.
     */
    class ScopedRetryTransportInvoker {
        constructor(controller, options = {}) {
            this.controller = controller;
            this.options = options;
            this.activeBudget = null;
            this.depth = 0;
            this.completedRetries = 0;
        }
        run(operation) {
            var _a;
            const ownsBudget = this.activeBudget === null;
            if (ownsBudget)
                this.activeBudget = new ExecutionBudget((_a = this.options.maxElapsedMs) !== null && _a !== void 0 ? _a : 20000);
            this.depth += 1;
            try {
                return operation();
            }
            finally {
                this.depth -= 1;
                if (ownsBudget && this.depth === 0)
                    this.activeBudget = null;
            }
        }
        invoke(context, operation) {
            const execute = () => {
                var _a, _b, _c, _d, _e, _f;
                const budget = (_a = this.activeBudget) !== null && _a !== void 0 ? _a : new ExecutionBudget((_b = this.options.maxElapsedMs) !== null && _b !== void 0 ? _b : 20000);
                const result = this.controller.execute(operation, {
                    operation: {
                        kind: context.operationClass,
                        idempotent: context.idempotent,
                        idempotencyKey: (_d = (_c = this.options).idempotencyKey) === null || _d === void 0 ? void 0 : _d.call(_c, context),
                    },
                    budget,
                    maxAttempts: this.options.maxAttempts,
                    baseDelayMs: this.options.baseDelayMs,
                    maxDelayMs: this.options.maxDelayMs,
                });
                this.completedRetries += result.stats.retries;
                (_f = (_e = this.options).onAttemptComplete) === null || _f === void 0 ? void 0 : _f.call(_e, context, result.stats);
                return result.value;
            };
            return this.activeBudget === null ? this.run(execute) : execute();
        }
        /** Monotonic counter consumed by executor result telemetry. */
        retryCount() {
            return this.completedRetries;
        }
    }

    class JournalCapacityError extends GQueryV2Error {
        constructor(bytes, maximumBytes) {
            super("JOURNAL_CAPACITY", `The deferred journal would use ${bytes} bytes, above its ${maximumBytes}-byte safety limit.`, { bytes, maximumBytes });
        }
    }
    class DeferredMutationTooLargeError extends GQueryV2Error {
        constructor(bytes, maximumBytes) {
            super("JOURNAL_ENTRY_TOO_LARGE", `The deferred mutation uses ${bytes} bytes, above its ${maximumBytes}-byte safety limit.`, { bytes, maximumBytes });
        }
    }
    class JournalCorruptionError extends GQueryV2Error {
        constructor(reason) {
            super("JOURNAL_CORRUPT", `The deferred journal is incomplete or corrupt: ${reason}.`, { reason });
        }
    }
    class JournalLockTimeoutError extends GQueryV2Error {
        constructor(timeoutMs) {
            super("JOURNAL_LOCK_TIMEOUT", `Could not acquire the deferred journal lock within ${timeoutMs}ms.`, { timeoutMs });
        }
    }
    class JournalFlushLeaseLostError extends GQueryV2Error {
        constructor(leaseId) {
            super("DEFERRED_CONFLICT", "The deferred flush lease expired or was replaced before journal reconciliation.", { leaseId });
        }
    }
    class IdempotencyConflictError extends GQueryV2Error {
        constructor(idempotencyKey) {
            super("DEFERRED_CONFLICT", "The idempotency key was already used for a different deferred mutation.", { idempotencyKey });
        }
    }
    class AppliedReceiptCapacityError extends GQueryV2Error {
        constructor(sourceMutationCount, retainedReceiptLimit, bytes, maximumBytes) {
            super("JOURNAL_CAPACITY", `The deferred flush cannot durably checkpoint all ${sourceMutationCount} source mutations before commit. Split the flush or increase the bounded applied-receipt capacity.`, { sourceMutationCount, retainedReceiptLimit, bytes, maximumBytes });
        }
    }
    /** CacheService-backed overlay which remains explicitly rebuildable from the journal. */
    class ChunkedDeferredOverlay {
        constructor(cache, logicalKey = { kind: "deferred-overlay" }, policy = { ttlSeconds: 300, jitterSeconds: 30 }) {
            this.cache = cache;
            this.logicalKey = logicalKey;
            this.policy = policy;
        }
        replace(entries) {
            this.cache.put(this.logicalKey, entries, this.policy);
        }
        read() {
            return this.cache.get(this.logicalKey);
        }
    }
    const DEFERRED_DEAD_LETTER_BASE_HEADERS = Object.freeze([
        "ID",
        "Mutation ID",
        "Source",
        "Table",
        "Key",
        "Conflict",
        "Moved At",
    ]);
    const DEFERRED_DEAD_LETTER_ACTOR_HEADER = "Actor";
    function emptyState() {
        return { version: 1, revision: 0, nextSequence: 1, entries: [], receipts: [] };
    }
    function utf8ByteLength(value) {
        let bytes = 0;
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            if (code < 0x80)
                bytes += 1;
            else if (code < 0x800)
                bytes += 2;
            else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
                const next = value.charCodeAt(index + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    bytes += 4;
                    index += 1;
                }
                else {
                    bytes += 3;
                }
            }
            else {
                bytes += 3;
            }
        }
        return bytes;
    }
    function splitUtf8(value, byteLimit) {
        if (value === "")
            return [""];
        const chunks = [];
        let chunk = "";
        let chunkBytes = 0;
        for (const character of value) {
            const bytes = utf8ByteLength(character);
            if (chunkBytes + bytes > byteLimit && chunk !== "") {
                chunks.push(chunk);
                chunk = "";
                chunkBytes = 0;
            }
            chunk += character;
            chunkBytes += bytes;
        }
        if (chunk !== "")
            chunks.push(chunk);
        return chunks;
    }
    function assertJsonValue(value, path, ancestors) {
        if (value === null || typeof value === "string" || typeof value === "boolean")
            return;
        if (typeof value === "number") {
            if (!Number.isFinite(value))
                throw new TypeError(`${path} must not contain NaN or Infinity.`);
            return;
        }
        if (typeof value !== "object")
            throw new TypeError(`${path} must contain only JSON values.`);
        if (value instanceof Date)
            throw new TypeError(`${path} must contain encoded values, not Date instances.`);
        if (ancestors.includes(value))
            throw new TypeError(`${path} must not contain cycles.`);
        const nextAncestors = [...ancestors, value];
        if (Array.isArray(value)) {
            value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, nextAncestors));
            return;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError(`${path} must contain only plain JSON objects.`);
        }
        for (const [key, child] of Object.entries(value)) {
            assertJsonValue(child, `${path}.${key}`, nextAncestors);
        }
    }
    function validateInput(input) {
        if (input.sourceId.trim() === "" || input.table.trim() === "") {
            throw new TypeError("Deferred mutations require non-empty sourceId and table values.");
        }
        if (input.idempotencyKey.trim() === "") {
            throw new TypeError("Deferred mutations require a non-empty idempotencyKey.");
        }
        if (Object.keys(input.key).length === 0) {
            throw new TypeError("Deferred mutations must be key-addressed.");
        }
        assertJsonValue(input.key, "key", []);
        if (typeof input.expectedVersion === "number" &&
            !Number.isFinite(input.expectedVersion)) {
            throw new TypeError("expectedVersion must be finite when it is numeric.");
        }
        if (input.kind === "delete") {
            if (input.values !== undefined)
                throw new TypeError("Deferred deletes cannot include values.");
        }
        else {
            if (input.values === undefined)
                throw new TypeError(`Deferred ${input.kind} mutations require values.`);
            assertJsonValue(input.values, "values", []);
        }
    }
    function parseManifest(raw) {
        var _a, _b;
        if (raw === null)
            return null;
        try {
            const value = JSON.parse(raw);
            if (value.version !== 1 ||
                typeof value.generation !== "string" ||
                !Number.isInteger(value.shards) ||
                ((_a = value.shards) !== null && _a !== void 0 ? _a : 0) < 1 ||
                !Number.isInteger(value.bytes) ||
                ((_b = value.bytes) !== null && _b !== void 0 ? _b : -1) < 0 ||
                typeof value.checksum !== "string" ||
                !Number.isInteger(value.revision)) {
                throw new Error("invalid manifest shape");
            }
            return value;
        }
        catch (error) {
            throw new JournalCorruptionError(error instanceof Error ? error.message : "invalid manifest");
        }
    }
    function terminalReceipts(receipts) {
        return receipts.filter((receipt) => receipt.status !== "queued");
    }
    function pruneReceipts(receipts, limit) {
        const queued = receipts.filter((receipt) => receipt.status === "queued");
        const terminal = terminalReceipts(receipts)
            .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
            .slice(0, limit);
        return [...queued, ...terminal];
    }
    /**
     * A compact crash-recovery ledger. It uses one bounded ScriptProperties value,
     * not one permanent property per mutation, and terminal journal publication
     * removes entries eagerly.
     */
    class AppliedMutationReceiptLedger {
        constructor(properties, options = {}) {
            var _a, _b, _c, _d, _e;
            this.properties = properties;
            this.namespace = (_a = options.namespace) !== null && _a !== void 0 ? _a : "gq2";
            this.retainedReceiptLimit = (_b = options.retainedReceiptLimit) !== null && _b !== void 0 ? _b : 256;
            this.maximumBytes = (_c = options.maximumBytes) !== null && _c !== void 0 ? _c : 8000;
            this.maximumAgeMs = (_d = options.maximumAgeMs) !== null && _d !== void 0 ? _d : 7 * 24 * 60 * 60 * 1000;
            this.clock = (_e = options.clock) !== null && _e !== void 0 ? _e : systemClock;
            if (!Number.isInteger(this.retainedReceiptLimit) || this.retainedReceiptLimit < 1) {
                throw new RangeError("Applied receipt retention must be a positive integer.");
            }
            if (!Number.isInteger(this.maximumBytes) || this.maximumBytes < 256 || this.maximumBytes > 8000) {
                throw new RangeError("Applied receipt storage must be between 256 and 8000 bytes.");
            }
            if (!Number.isFinite(this.maximumAgeMs) || this.maximumAgeMs < 1) {
                throw new RangeError("Applied receipt maximumAgeMs must be positive and finite.");
            }
        }
        has(mutationId) {
            return this.load().some((receipt) => receipt.mutationId === mutationId);
        }
        mark(mutationId) {
            this.markMany([mutationId]);
        }
        /** Publish all receipts in one bounded property write after an atomic batch. */
        markMany(mutationIds) {
            if (mutationIds.length === 0)
                return;
            if (mutationIds.some((mutationId) => mutationId.trim().length === 0)) {
                throw new TypeError("Applied mutation IDs must not be empty.");
            }
            this.persist(this.markedState(mutationIds, this.clock.now()));
        }
        /** Refuse a flush before remote I/O when its full crash checkpoint cannot fit. */
        assertCanMarkMany(mutationIds) {
            if (mutationIds.length === 0)
                return;
            if (mutationIds.some((mutationId) => mutationId.trim().length === 0)) {
                throw new TypeError("Applied mutation IDs must not be empty.");
            }
            this.markedState(mutationIds, this.clock.now());
        }
        forget(mutationIds) {
            if (mutationIds.length === 0)
                return;
            const removed = new Set(mutationIds);
            this.persist(this.load().filter((receipt) => !removed.has(receipt.mutationId)));
        }
        prune() {
            const current = this.load();
            const next = this.fit(this.pruned(current, this.clock.now()));
            this.persist(next);
            return current.length - next.length;
        }
        list() {
            return Object.freeze([...this.load()]);
        }
        get key() {
            return `${this.namespace}:deferred-applied`;
        }
        load() {
            const raw = this.properties.get(this.key);
            if (raw === null)
                return [];
            try {
                const state = JSON.parse(raw);
                if (state.version !== 1 || !Array.isArray(state.receipts))
                    throw new Error("invalid state shape");
                return state.receipts.map((receipt) => {
                    if (typeof receipt !== "object" ||
                        receipt === null ||
                        typeof receipt.mutationId !== "string" ||
                        !Number.isFinite(receipt.appliedAtMs)) {
                        throw new Error("invalid receipt shape");
                    }
                    return receipt;
                });
            }
            catch (error) {
                throw new JournalCorruptionError(`applied receipt ledger ${error instanceof Error ? error.message : "invalid JSON"}`);
            }
        }
        pruned(receipts, now) {
            return receipts
                .filter((receipt) => now - receipt.appliedAtMs <= this.maximumAgeMs)
                .sort((left, right) => left.appliedAtMs - right.appliedAtMs || left.mutationId.localeCompare(right.mutationId))
                .slice(-this.retainedReceiptLimit);
        }
        fit(receipts) {
            const fitted = [...receipts].slice(-this.retainedReceiptLimit);
            while (fitted.length > 0 && this.serializedBytes(fitted) > this.maximumBytes)
                fitted.shift();
            if (fitted.length === 0 && receipts.length > 0) {
                throw new JournalCapacityError(this.serializedBytes(receipts.slice(-1)), this.maximumBytes);
            }
            return fitted;
        }
        markedState(mutationIds, now) {
            const marked = new Set(mutationIds);
            const receipts = this.load()
                .filter((receipt) => !marked.has(receipt.mutationId));
            receipts.push(...[...marked].map((mutationId) => ({ mutationId, appliedAtMs: now })));
            const fitted = this.fit(receipts);
            if (receipts.some(({ mutationId }) => !fitted.some((receipt) => receipt.mutationId === mutationId))) {
                throw new AppliedReceiptCapacityError(receipts.length, this.retainedReceiptLimit, this.serializedBytes(receipts), this.maximumBytes);
            }
            return fitted;
        }
        serializedBytes(receipts) {
            return utf8ByteLength(JSON.stringify({ version: 1, receipts }));
        }
        persist(receipts) {
            if (receipts.length === 0) {
                this.properties.remove(this.key);
                return;
            }
            this.properties.set(this.key, JSON.stringify({ version: 1, receipts }));
        }
    }
    function compatible(left, right) {
        if (left.sourceId !== right.sourceId ||
            left.table !== right.table ||
            canonicalStringify(left.key) !== canonicalStringify(right.key) ||
            left.expectedVersion !== right.expectedVersion ||
            left.actor !== right.actor) {
            return false;
        }
        return ((left.kind === "patch" && right.kind === "patch") ||
            (left.kind === "patch" && right.kind === "delete") ||
            (left.kind === "upsert" && (right.kind === "upsert" || right.kind === "patch" || right.kind === "delete")) ||
            (left.kind === "create" && (right.kind === "patch" || right.kind === "upsert" || right.kind === "delete")));
    }
    function deferredTarget(mutation) {
        return `${mutation.sourceId}\u0000${mutation.table}\u0000${canonicalStringify(mutation.key)}`;
    }
    /**
     * Combine compatible operations for one key even when unrelated keys are
     * interleaved. The first occurrence retains its position, field values remain
     * last-write-wins for that key, and an incompatible operation on the same key
     * creates a semantic barrier for subsequent entries.
     */
    function coalesceDeferredMutations(entries, hasher) {
        var _a, _b;
        const result = [];
        const latestByTarget = new Map();
        for (const entry of [...entries].sort((left, right) => left.sequence - right.sequence)) {
            const target = deferredTarget(entry);
            const previousIndex = latestByTarget.get(target);
            const previous = previousIndex === undefined ? undefined : result[previousIndex];
            if (previous !== undefined && compatible(previous, entry)) {
                const combinedIds = [...previous.sourceMutationIds, entry.id];
                const nextKind = entry.kind === "delete"
                    ? "delete"
                    : previous.kind === "create" && entry.kind === "upsert"
                        ? "upsert"
                        : previous.kind;
                result[previousIndex] = {
                    ...previous,
                    id: hasher.hash(combinedIds.join("\u0000")),
                    sourceMutationIds: combinedIds,
                    sourceMutations: [...previous.sourceMutations, entry],
                    kind: nextKind,
                    ...(nextKind === "delete"
                        ? { values: undefined }
                        : { values: { ...((_a = previous.values) !== null && _a !== void 0 ? _a : {}), ...((_b = entry.values) !== null && _b !== void 0 ? _b : {}) } }),
                };
                continue;
            }
            latestByTarget.set(target, result.length);
            result.push({
                id: hasher.hash(entry.id),
                sourceMutationIds: [entry.id],
                sourceMutations: [entry],
                sourceId: entry.sourceId,
                table: entry.table,
                kind: entry.kind,
                key: entry.key,
                values: entry.values,
                expectedVersion: entry.expectedVersion,
                actor: entry.actor,
                firstSequence: entry.sequence,
            });
        }
        return result;
    }
    /** Durable, bounded ScriptProperties journal. Cache overlays are deliberately non-authoritative. */
    class DeferredJournal {
        constructor(dependencies, options = {}) {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            this.dependencies = dependencies;
            this.clock = (_a = dependencies.clock) !== null && _a !== void 0 ? _a : systemClock;
            this.namespace = (_b = options.namespace) !== null && _b !== void 0 ? _b : "gq2";
            this.shardByteLimit = (_c = options.shardByteLimit) !== null && _c !== void 0 ? _c : 8000;
            this.softByteLimit = (_d = options.softByteLimit) !== null && _d !== void 0 ? _d : 400000;
            this.maxMutationBytes = (_e = options.maxMutationBytes) !== null && _e !== void 0 ? _e : 32000;
            this.retainedReceiptLimit = (_f = options.retainedReceiptLimit) !== null && _f !== void 0 ? _f : 256;
            this.lockTimeoutMs = (_g = options.lockTimeoutMs) !== null && _g !== void 0 ? _g : 5000;
            this.flushLeaseMs = (_h = options.flushLeaseMs) !== null && _h !== void 0 ? _h : 7 * 60 * 1000;
            if (!Number.isInteger(this.shardByteLimit) || this.shardByteLimit < 256 || this.shardByteLimit > 8000) {
                throw new RangeError("Deferred journal shards must be between 256 and 8000 bytes.");
            }
            if (!Number.isInteger(this.softByteLimit) || this.softByteLimit < this.shardByteLimit) {
                throw new RangeError("Deferred journal capacity must be at least one shard.");
            }
            if (!Number.isInteger(this.maxMutationBytes) || this.maxMutationBytes < 1) {
                throw new RangeError("Deferred mutation size limit must be a positive integer.");
            }
            if (!Number.isInteger(this.flushLeaseMs) || this.flushLeaseMs < 1) {
                throw new RangeError("Deferred flush lease duration must be a positive integer.");
            }
        }
        enqueue(input) {
            validateInput(input);
            const serializedInput = canonicalStringify(input);
            const requestHash = this.dependencies.hasher.hash(serializedInput);
            const inputBytes = utf8ByteLength(serializedInput);
            if (inputBytes > this.maxMutationBytes) {
                throw new DeferredMutationTooLargeError(inputBytes, this.maxMutationBytes);
            }
            return this.locked(() => {
                const state = this.load();
                const existing = state.receipts.find((receipt) => receipt.idempotencyKey === input.idempotencyKey);
                if (existing !== undefined) {
                    if (existing.requestHash !== requestHash)
                        throw new IdempotencyConflictError(input.idempotencyKey);
                    return { duplicate: true, receipt: existing };
                }
                const now = this.clock.now();
                const mutation = {
                    ...input,
                    id: this.dependencies.ids.next(),
                    sequence: state.nextSequence,
                    enqueuedAtMs: now,
                    attempts: 0,
                };
                const receipt = {
                    idempotencyKey: input.idempotencyKey,
                    requestHash,
                    mutationId: mutation.id,
                    status: "queued",
                    createdAtMs: now,
                    updatedAtMs: now,
                };
                const next = {
                    ...state,
                    revision: state.revision + 1,
                    nextSequence: state.nextSequence + 1,
                    entries: [...state.entries, mutation],
                    receipts: pruneReceipts([...state.receipts, receipt], this.retainedReceiptLimit),
                };
                this.persist(next);
                return { duplicate: false, receipt };
            });
        }
        enqueueOrExecute(input, immediate) {
            try {
                return this.enqueue(input);
            }
            catch (error) {
                if (!(error instanceof JournalCapacityError) && !(error instanceof DeferredMutationTooLargeError)) {
                    throw error;
                }
                const receipt = immediate();
                if (receipt.idempotencyKey !== input.idempotencyKey || receipt.status === "queued") {
                    throw new TypeError("Immediate fallback must return a terminal receipt for the requested idempotency key.");
                }
                return { duplicate: false, receipt };
            }
        }
        list() {
            return this.locked(() => [...this.load().entries].sort((left, right) => left.sequence - right.sequence));
        }
        /** Read the authoritative journal and republish its cache-only overlay in one lock. */
        listAndRebuildOverlay() {
            return this.locked(() => {
                const entries = [...this.load().entries].sort((left, right) => left.sequence - right.sequence);
                this.publishOverlay(entries);
                return entries;
            });
        }
        /**
         * Read a manifest-last snapshot without taking the journal ScriptLock.
         *
         * This path is used only to rebuild the non-authoritative read-your-writes
         * overlay. A query can already be running under the unit-of-work/document
         * lock, so acquiring a second ScriptLock handle here risks a nested-lock
         * timeout in Apps Script. The immutable shard generation is safe to read
         * lock-free as long as the manifest remains unchanged for the duration of
         * the read. A concurrent publication is retried against its new generation.
         */
        readAndRebuildOverlay() {
            let lastError;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const manifestBefore = this.dependencies.properties.get(this.manifestKey);
                try {
                    const entries = [...this.load().entries].sort((left, right) => left.sequence - right.sequence);
                    const manifestAfter = this.dependencies.properties.get(this.manifestKey);
                    if (manifestBefore !== manifestAfter)
                        continue;
                    this.publishOverlay(entries);
                    return entries;
                }
                catch (error) {
                    lastError = error;
                    const manifestAfter = this.dependencies.properties.get(this.manifestKey);
                    if (manifestBefore !== manifestAfter)
                        continue;
                    throw error;
                }
            }
            if (lastError instanceof Error)
                throw lastError;
            throw new JournalCorruptionError("manifest changed repeatedly while rebuilding the overlay");
        }
        receipt(idempotencyKey) {
            return this.locked(() => { var _a; return (_a = this.load().receipts.find((receipt) => receipt.idempotencyKey === idempotencyKey)) !== null && _a !== void 0 ? _a : null; });
        }
        rebuildOverlay() {
            return this.locked(() => {
                const entries = this.load().entries;
                this.publishOverlay(entries);
                return entries.length;
            });
        }
        flush(executor, deadLetters) {
            const preparation = this.locked(() => this.prepareFlush());
            if (preparation.kind === "idle")
                return preparation.result;
            const { snapshot, lease } = preparation;
            const grouped = coalesceDeferredMutations(snapshot.entries, this.dependencies.hasher);
            const seenTargets = new Set();
            const coalesced = grouped.filter((mutation) => {
                const target = deferredTarget(mutation);
                if (seenTargets.has(target))
                    return false;
                seenTargets.add(target);
                return true;
            });
            const attempted = coalesced.reduce((count, mutation) => count + mutation.sourceMutationIds.length, 0);
            const errors = [];
            let outcomes;
            try {
                outcomes = executor.apply(coalesced);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push(message);
                outcomes = coalesced.map((mutation) => ({
                    mutationId: mutation.id,
                    status: "transient",
                    message,
                }));
            }
            const outcomeById = new Map(outcomes.map((outcome) => [outcome.mutationId, outcome]));
            const normalizedOutcomes = coalesced.map((mutation) => {
                var _a;
                return (_a = outcomeById.get(mutation.id)) !== null && _a !== void 0 ? _a : {
                    mutationId: mutation.id,
                    status: "transient",
                    message: "The deferred executor returned no outcome for this mutation.",
                };
            });
            const snapshotById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
            const conflictGroups = coalesced.filter((mutation) => { var _a; return ((_a = outcomeById.get(mutation.id)) === null || _a === void 0 ? void 0 : _a.status) === "conflict"; });
            const deadLetterRecords = conflictGroups.map((mutation) => {
                var _a, _b;
                const outcome = outcomeById.get(mutation.id);
                return {
                    id: mutation.id,
                    mutation,
                    originals: mutation.sourceMutationIds
                        .map((id) => snapshotById.get(id))
                        .filter((entry) => entry !== undefined),
                    conflict: (_a = outcome === null || outcome === void 0 ? void 0 : outcome.conflict) !== null && _a !== void 0 ? _a : { message: (_b = outcome === null || outcome === void 0 ? void 0 : outcome.message) !== null && _b !== void 0 ? _b : "Version conflict" },
                    movedAtMs: this.clock.now(),
                };
            });
            let deadLetteredIds = new Set();
            if (deadLetterRecords.length > 0) {
                try {
                    deadLetters.write(deadLetterRecords);
                    deadLetteredIds = new Set(deadLetterRecords.map((record) => record.mutation.id));
                }
                catch (error) {
                    errors.push(error instanceof Error ? error.message : String(error));
                }
            }
            const outcomeForSourceId = new Map();
            for (let index = 0; index < coalesced.length; index += 1) {
                const mutation = coalesced[index];
                const outcome = normalizedOutcomes[index];
                const effective = outcome.status === "conflict" && !deadLetteredIds.has(mutation.id)
                    ? { ...outcome, status: "transient" }
                    : outcome;
                for (const id of mutation.sourceMutationIds)
                    outcomeForSourceId.set(id, effective);
            }
            let updated;
            try {
                updated = this.locked(() => this.reconcileFlush(lease, outcomeForSourceId));
            }
            catch (error) {
                // A failed manifest publication leaves the pre-reconciliation lease
                // authoritative. Clear only our own lease so the applied-receipt ledger
                // can support an immediate idempotent recovery run.
                try {
                    this.locked(() => this.releaseFlushLease(lease.id));
                }
                catch {
                    // The durable lease will expire even when best-effort cleanup fails.
                }
                throw error;
            }
            const appliedIds = coalesced
                .filter((_, index) => normalizedOutcomes[index].status === "committed")
                .flatMap((mutation) => [mutation.id, ...mutation.sourceMutationIds]);
            if (appliedIds.length > 0 && executor.forgetApplied !== undefined) {
                try {
                    executor.forgetApplied(appliedIds);
                }
                catch (error) {
                    // Journal removal is already authoritative. A bounded ledger can prune
                    // this orphan on a later run without reapplying the mutation.
                    errors.push(error instanceof Error ? error.message : String(error));
                }
            }
            const committed = coalesced
                .filter((_, index) => normalizedOutcomes[index].status === "committed")
                .reduce((count, mutation) => count + mutation.sourceMutationIds.length, 0);
            const conflicted = coalesced
                .filter((_, index) => normalizedOutcomes[index].status === "conflict" &&
                deadLetteredIds.has(normalizedOutcomes[index].mutationId))
                .reduce((count, mutation) => count + mutation.sourceMutationIds.length, 0);
            return {
                attempted,
                committed,
                conflicted,
                retained: updated.entries.length,
                coalesced: attempted - coalesced.length,
                errors,
            };
        }
        prepareFlush() {
            const state = this.load();
            // CacheService may evict early; every trigger run republishes the
            // authoritative overlay even when another flush owns the durable lease.
            this.publishOverlay(state.entries);
            const now = this.clock.now();
            if (state.flushLease !== undefined && state.flushLease.expiresAtMs > now) {
                return {
                    kind: "idle",
                    result: {
                        attempted: 0,
                        committed: 0,
                        conflicted: 0,
                        retained: state.entries.length,
                        coalesced: 0,
                        errors: [],
                    },
                };
            }
            if (state.entries.length === 0) {
                if (state.flushLease !== undefined) {
                    const { flushLease: _expiredLease, ...withoutLease } = state;
                    this.persist({ ...withoutLease, revision: state.revision + 1 });
                }
                return {
                    kind: "idle",
                    result: {
                        attempted: 0,
                        committed: 0,
                        conflicted: 0,
                        retained: 0,
                        coalesced: 0,
                        errors: [],
                    },
                };
            }
            const lease = {
                id: this.dependencies.ids.next(),
                acquiredAtMs: now,
                expiresAtMs: now + this.flushLeaseMs,
                snapshotRevision: state.revision,
                entryIds: state.entries.map((entry) => entry.id),
            };
            this.persist({ ...state, revision: state.revision + 1, flushLease: lease });
            return { kind: "ready", snapshot: state, lease };
        }
        reconcileFlush(lease, outcomeForSourceId) {
            var _a;
            const current = this.load();
            if (((_a = current.flushLease) === null || _a === void 0 ? void 0 : _a.id) !== lease.id)
                throw new JournalFlushLeaseLostError(lease.id);
            const leasedIds = new Set(lease.entryIds);
            const removedIds = new Set();
            const now = this.clock.now();
            const entries = current.entries.flatMap((entry) => {
                var _a;
                // Concurrent enqueue calls are deliberately outside this flush snapshot.
                if (!leasedIds.has(entry.id))
                    return [entry];
                const outcome = outcomeForSourceId.get(entry.id);
                if (outcome === undefined)
                    return [entry];
                if (outcome.status === "committed" || outcome.status === "conflict") {
                    removedIds.add(entry.id);
                    return [];
                }
                return [{
                        ...entry,
                        attempts: entry.attempts + 1,
                        lastAttemptAtMs: now,
                        lastError: (_a = outcome.message) !== null && _a !== void 0 ? _a : "Transient deferred write failure",
                    }];
            });
            const receipts = current.receipts.map((receipt) => {
                var _a, _b;
                if (!removedIds.has(receipt.mutationId))
                    return receipt;
                const outcome = outcomeForSourceId.get(receipt.mutationId);
                if ((outcome === null || outcome === void 0 ? void 0 : outcome.status) === "conflict") {
                    return {
                        ...receipt,
                        status: "conflicted",
                        updatedAtMs: now,
                        conflict: (_a = outcome.conflict) !== null && _a !== void 0 ? _a : { message: (_b = outcome.message) !== null && _b !== void 0 ? _b : "Version conflict" },
                    };
                }
                return { ...receipt, status: "committed", updatedAtMs: now };
            });
            const { flushLease: _completedLease, ...withoutLease } = current;
            const next = {
                ...withoutLease,
                revision: current.revision + 1,
                entries,
                receipts: pruneReceipts(receipts, this.retainedReceiptLimit),
            };
            this.persist(next);
            return next;
        }
        releaseFlushLease(leaseId) {
            var _a;
            const current = this.load();
            if (((_a = current.flushLease) === null || _a === void 0 ? void 0 : _a.id) !== leaseId)
                return;
            const { flushLease: _lease, ...withoutLease } = current;
            this.persist({ ...withoutLease, revision: current.revision + 1 });
        }
        locked(operation) {
            if (!this.dependencies.lock.tryAcquire(this.lockTimeoutMs)) {
                throw new JournalLockTimeoutError(this.lockTimeoutMs);
            }
            try {
                return operation();
            }
            finally {
                this.dependencies.lock.release();
            }
        }
        get manifestKey() {
            return `${this.namespace}:deferred:manifest`;
        }
        shardKey(generation, index) {
            return `${this.namespace}:deferred:${generation}:${index}`;
        }
        load() {
            const manifest = parseManifest(this.dependencies.properties.get(this.manifestKey));
            if (manifest === null)
                return emptyState();
            const all = this.dependencies.properties.getMany();
            const chunks = [];
            for (let index = 0; index < manifest.shards; index += 1) {
                const value = all[this.shardKey(manifest.generation, index)];
                if (typeof value !== "string")
                    throw new JournalCorruptionError(`missing shard ${index}`);
                chunks.push(value);
            }
            const serialized = chunks.join("");
            if (utf8ByteLength(serialized) !== manifest.bytes) {
                throw new JournalCorruptionError("byte count does not match the manifest");
            }
            if (this.dependencies.hasher.hash(serialized) !== manifest.checksum) {
                throw new JournalCorruptionError("checksum does not match the manifest");
            }
            try {
                const state = JSON.parse(serialized);
                const lease = state.flushLease;
                if (state.version !== 1 ||
                    !Number.isInteger(state.revision) ||
                    !Number.isInteger(state.nextSequence) ||
                    !Array.isArray(state.entries) ||
                    !Array.isArray(state.receipts) ||
                    (lease !== undefined && (typeof lease !== "object" ||
                        lease === null ||
                        typeof lease.id !== "string" ||
                        !Number.isFinite(lease.acquiredAtMs) ||
                        !Number.isFinite(lease.expiresAtMs) ||
                        !Number.isInteger(lease.snapshotRevision) ||
                        !Array.isArray(lease.entryIds) ||
                        lease.entryIds.some((id) => typeof id !== "string"))) ||
                    state.revision !== manifest.revision) {
                    throw new Error("invalid state shape");
                }
                return state;
            }
            catch (error) {
                throw new JournalCorruptionError(error instanceof Error ? error.message : "invalid JSON state");
            }
        }
        persist(state) {
            const serialized = JSON.stringify(state);
            const bytes = utf8ByteLength(serialized);
            if (bytes > this.softByteLimit)
                throw new JournalCapacityError(bytes, this.softByteLimit);
            const chunks = splitUtf8(serialized, this.shardByteLimit);
            const previous = parseManifest(this.dependencies.properties.get(this.manifestKey));
            const generation = this.dependencies.ids.next();
            const values = {};
            const newKeys = [];
            chunks.forEach((chunk, index) => {
                const key = this.shardKey(generation, index);
                newKeys.push(key);
                values[key] = chunk;
            });
            const manifest = {
                version: 1,
                generation,
                shards: chunks.length,
                bytes,
                checksum: this.dependencies.hasher.hash(serialized),
                revision: state.revision,
            };
            try {
                this.dependencies.properties.setMany(values);
                // Publication point: old shards remain authoritative until this succeeds.
                this.dependencies.properties.set(this.manifestKey, JSON.stringify(manifest));
            }
            catch (error) {
                try {
                    this.dependencies.properties.removeMany(newKeys);
                }
                catch {
                    // Orphaned, unpublished shards are safe and can be reclaimed later.
                }
                throw error;
            }
            if (previous !== null && previous.generation !== generation) {
                try {
                    this.dependencies.properties.removeMany(Array.from({ length: previous.shards }, (_, index) => this.shardKey(previous.generation, index)));
                }
                catch {
                    // The manifest already points at the new generation; cleanup is best effort.
                }
            }
            this.publishOverlay(state.entries);
        }
        publishOverlay(entries) {
            var _a;
            try {
                (_a = this.dependencies.overlay) === null || _a === void 0 ? void 0 : _a.replace(entries);
            }
            catch {
                // CacheService is never authoritative; the journal remains the source of truth.
            }
        }
    }
    function createAppsScriptDeferredJournal(options = {}, overlay) {
        return new DeferredJournal({
            properties: new AppsScriptPropertyStore(PropertiesService.getScriptProperties()),
            lock: new AppsScriptLock(LockService.getScriptLock()),
            hasher: new AppsScriptSha256Hash(),
            ids: { next: () => Utilities.getUuid() },
            overlay,
        }, options);
    }

    class InMemorySchemaCanonicalState {
        constructor() {
            this.values = new Map();
        }
        isStrictCanonical(spreadsheetId) {
            var _a;
            return (_a = this.values.get(spreadsheetId)) !== null && _a !== void 0 ? _a : false;
        }
        setStrictCanonical(spreadsheetId, enabled) {
            this.values.set(spreadsheetId, enabled);
        }
    }
    function strictCanonicalPropertyKey(spreadsheetId) {
        return `gq2:strict-canonical:${spreadsheetId}`;
    }
    class AppsScriptSchemaCanonicalState {
        constructor(options = {}) {
            this.options = options;
            /** One authoritative system-sheet read per workbook and Apps Script execution. */
            this.resolved = new Map();
        }
        isStrictCanonical(spreadsheetId) {
            const resolved = this.resolved.get(spreadsheetId);
            if (resolved !== undefined)
                return resolved;
            const properties = this.properties();
            const key = strictCanonicalPropertyKey(spreadsheetId);
            const authoritative = this.options.readMeta === undefined
                ? this.readMeta(spreadsheetId)
                : this.options.readMeta(spreadsheetId);
            if (authoritative === undefined) {
                // A stale property must never activate strict mode before `_gq_meta`
                // exists. Remove it so subsequent inspections cannot mistake it for the
                // source of truth.
                properties.remove(key);
                this.resolved.set(spreadsheetId, false);
                return false;
            }
            const encoded = String(authoritative);
            if (properties.get(key) !== encoded)
                properties.set(key, encoded);
            this.resolved.set(spreadsheetId, authoritative);
            return authoritative;
        }
        setStrictCanonical(spreadsheetId, enabled) {
            // SchemaManager persists `_gq_meta` through its mode adapter first. This is
            // only a recoverable fast mirror; isStrictCanonical() always reconciles it
            // back to the protected sheet.
            this.properties().set(strictCanonicalPropertyKey(spreadsheetId), String(enabled));
            this.resolved.set(spreadsheetId, enabled);
        }
        properties() {
            var _a;
            return (_a = this.options.properties) !== null && _a !== void 0 ? _a : new AppsScriptPropertyStore(PropertiesService.getScriptProperties());
        }
        readMeta(spreadsheetId) {
            var _a, _b;
            if (typeof SpreadsheetApp === "undefined") {
                throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "SpreadsheetApp is required to read canonical migration mode.");
            }
            const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName("_gq_meta");
            if (sheet === null)
                return undefined;
            const lastRow = Math.max(1, sheet.getLastRow());
            const values = sheet.getRange(1, 1, lastRow, 2).getDisplayValues();
            const matches = values.filter((row) => row[0] === "strict_canonical");
            if (matches.length !== 1 || (((_a = matches[0]) === null || _a === void 0 ? void 0 : _a[1]) !== "true" && ((_b = matches[0]) === null || _b === void 0 ? void 0 : _b[1]) !== "false")) {
                throw new GQueryRuntimeError("MIGRATION_REQUIRED", "The protected _gq_meta sheet has invalid strict_canonical migration state.", {
                    details: {
                        spreadsheetId,
                        values: matches.map((row) => row[1]),
                    },
                });
            }
            return matches[0][1] === "true";
        }
    }
    function decodedBlank(value) {
        return value === undefined || value === null || value === "" ? BLANK_CELL : value;
    }
    function toSheetValue(value) {
        return value === BLANK_CELL ? null : value;
    }
    function tableUsesFormula(definition) {
        return Object.values(definition.columns).some((column) => column.kind === "formula");
    }
    function key(row, fields) {
        return canonicalStringify$1(fields.map((field) => row[field]));
    }
    function relationFields(value) {
        return typeof value === "string" ? [value] : value;
    }
    const META_HEADERS = Object.freeze(["Key", "Value"]);
    const META_REQUIRED_ROWS = Object.freeze([
        { key: "schema_version", fallback: { kind: "literal", value: "2" } },
        { key: "migrated_at", fallback: { kind: "migration-time" } },
        { key: "backup_id", fallback: { kind: "backup-id" } },
        { key: "strict_canonical", fallback: { kind: "literal", value: "false" } },
        { key: "strict_canonical_changed_at", fallback: { kind: "migration-time" } },
    ]);
    function physicalString(value) {
        return value === null || value === undefined ? "" : String(value);
    }
    /** Read-only audit plus explicit, backup-gated schema migration. */
    class SchemaManager {
        constructor(access) {
            var _a;
            this.access = access;
            this.canonicalState = (_a = access.canonicalState) !== null && _a !== void 0 ? _a : new InMemorySchemaCanonicalState();
        }
        strictCanonicalStatus() {
            return Object.freeze(this.spreadsheetIds().map((spreadsheetId) => Object.freeze({
                spreadsheetId,
                strictCanonical: this.canonicalState.isStrictCanonical(spreadsheetId),
            })));
        }
        /**
         * Enable canonical-only decoding only after a fresh audit proves that no
         * legacy cells, invalid cells, or unapplied migration actions remain.
         */
        activateStrictCanonical(options) {
            if (options.confirm !== true) {
                throw new GQueryRuntimeError("MIGRATION_REQUIRED", "activateStrictCanonical() requires confirm: true.");
            }
            const plan = this.plan();
            const errors = plan.issues.filter((issue) => issue.severity === "error");
            if (errors.length > 0 || plan.invalidCells > 0 || plan.legacyCells > 0 || plan.actions.length > 0) {
                throw new GQueryRuntimeError("MIGRATION_REQUIRED", "Canonical-only decoding requires a clean post-backfill schema audit.", {
                    details: {
                        errors,
                        invalidCells: plan.invalidCells,
                        legacyCells: plan.legacyCells,
                        pendingActions: plan.actions,
                    },
                });
            }
            return this.setStrictCanonical(true, options.adapter, plan);
        }
        /** Disable canonical-only decoding as the documented rollback switch. */
        rollbackStrictCanonical(options) {
            if (options.confirm !== true) {
                throw new GQueryRuntimeError("MIGRATION_REQUIRED", "rollbackStrictCanonical() requires confirm: true.");
            }
            return this.setStrictCanonical(false, options.adapter);
        }
        plan() {
            var _a, _b, _c, _d, _e, _f, _g;
            const generatedAt = new Date().toISOString();
            const issues = [];
            const actions = [];
            const loaded = this.loadTables(actions, issues);
            const decoded = new Map();
            let canonicalCells = 0;
            let legacyCells = 0;
            let invalidCells = 0;
            for (const table of loaded) {
                if (table.sheet === undefined || table.values.length === 0)
                    continue;
                const headers = ((_a = table.values[0]) !== null && _a !== void 0 ? _a : []).map((value) => typeof value === "string" ? value : String(value !== null && value !== void 0 ? value : ""));
                const byHeader = new Map();
                for (let index = 0; index < headers.length; index += 1) {
                    const header = headers[index];
                    if (header.length === 0)
                        continue;
                    if (byHeader.has(header)) {
                        issues.push(this.issue(table, "DUPLICATE_HEADER", "error", `Header ${header} appears more than once.`, { header }));
                    }
                    else {
                        byHeader.set(header, index);
                    }
                }
                const missingHeaders = [];
                for (const [field, column] of Object.entries(table.definition.columns)) {
                    const header = (_b = column.header) !== null && _b !== void 0 ? _b : field;
                    if (!byHeader.has(header)) {
                        missingHeaders.push(header);
                        issues.push(this.issue(table, "MISSING_HEADER", "error", `Required header ${header} is missing.`, { column: field, header }));
                    }
                }
                if (table.definition.versionColumn !== undefined && !byHeader.has(table.definition.versionColumn)) {
                    issues.push(this.issue(table, "MISSING_VERSION_COLUMN", "warning", `Hidden version header ${table.definition.versionColumn} must be added.`, { header: table.definition.versionColumn }));
                    actions.push({
                        kind: "add-version-column",
                        spreadsheetId: table.spreadsheetId,
                        table: table.tableName,
                        sheet: table.definition.sheet,
                        sheetId: table.sheet.sheetId,
                        header: table.definition.versionColumn,
                        columnIndex: headers.length,
                        populatedRowIndexes: Object.freeze(table.values
                            .map((row, rowIndex) => ({ row, rowIndex }))
                            .filter(({ row, rowIndex }) => rowIndex > 0 && row.some((value) => value !== null && value !== undefined && value !== ""))
                            .map(({ rowIndex }) => rowIndex)),
                        gridColumnCount: table.sheet.columnCount,
                    });
                }
                if (missingHeaders.length > 0)
                    continue;
                const dataColumnIndexes = Object.entries(table.definition.columns).map(([field, column]) => {
                    var _a, _b;
                    const index = byHeader.get((_a = column.header) !== null && _a !== void 0 ? _a : field);
                    if (index === undefined) {
                        throw new GQueryRuntimeError("MISSING_HEADER", `Required header ${(_b = column.header) !== null && _b !== void 0 ? _b : field} is missing.`);
                    }
                    return index;
                });
                const versionIndex = table.definition.versionColumn === undefined
                    ? undefined
                    : byHeader.get(table.definition.versionColumn);
                if (versionIndex !== undefined) {
                    for (let rowIndex = 1; rowIndex < table.values.length; rowIndex += 1) {
                        const physical = (_c = table.values[rowIndex]) !== null && _c !== void 0 ? _c : [];
                        const populated = dataColumnIndexes.some((index) => {
                            const value = physical[index];
                            return value !== null && value !== undefined && value !== "";
                        });
                        if (!populated)
                            continue;
                        const version = physical[versionIndex];
                        if (!Number.isSafeInteger(version) || version < 1) {
                            issues.push(this.issue(table, "INVALID_VERSION", "warning", `Populated row ${rowIndex + 1} requires a positive integer ${table.definition.versionColumn} value.`, { row: rowIndex + 1, header: table.definition.versionColumn }));
                            actions.push({
                                kind: "repair-version-cell",
                                spreadsheetId: table.spreadsheetId,
                                table: table.tableName,
                                sheet: table.definition.sheet,
                                sheetId: table.sheet.sheetId,
                                rowIndex,
                                columnIndex: versionIndex,
                                value: 1,
                            });
                        }
                    }
                }
                const rows = [];
                const keyTrackers = [
                    ...(table.definition.primaryKey.length === 0
                        ? []
                        : [{ kind: "primary", fields: table.definition.primaryKey, rows: new Map() }]),
                    ...table.definition.unique.map((fields, index) => ({
                        kind: "unique",
                        index,
                        fields,
                        rows: new Map(),
                    })),
                ];
                for (let rowIndex = 1; rowIndex < table.values.length; rowIndex += 1) {
                    const physical = (_d = table.values[rowIndex]) !== null && _d !== void 0 ? _d : [];
                    if (dataColumnIndexes.every((index) => {
                        const value = physical[index];
                        return value === null || value === undefined || value === "";
                    }))
                        continue;
                    const row = {};
                    let rowValid = true;
                    for (const [field, column] of Object.entries(table.definition.columns)) {
                        const header = (_e = column.header) !== null && _e !== void 0 ? _e : field;
                        const columnIndex = byHeader.get(header);
                        const raw = decodedBlank(physical[columnIndex]);
                        try {
                            const value = column.decode(raw, {
                                table: table.tableName,
                                column: field,
                                header,
                                rowNumber: rowIndex + 1,
                            });
                            row[field] = value;
                            try {
                                column.decodeCanonical(raw, {
                                    table: table.tableName,
                                    column: field,
                                    header,
                                    rowNumber: rowIndex + 1,
                                });
                                canonicalCells += 1;
                            }
                            catch {
                                legacyCells += 1;
                                const encoded = toSheetValue(column.encode(value, {
                                    table: table.tableName,
                                    column: field,
                                    header,
                                    rowNumber: rowIndex + 1,
                                }));
                                issues.push(this.issue(table, "LEGACY_ENCODING", "info", `Cell ${header}${rowIndex + 1} uses a legacy encoding.`, {
                                    row: rowIndex + 1,
                                    column: field,
                                    header,
                                }));
                                actions.push({
                                    kind: "backfill-cell",
                                    spreadsheetId: table.spreadsheetId,
                                    table: table.tableName,
                                    sheet: table.definition.sheet,
                                    sheetId: table.sheet.sheetId,
                                    rowIndex,
                                    columnIndex,
                                    value: encoded,
                                });
                            }
                        }
                        catch (error) {
                            invalidCells += 1;
                            rowValid = false;
                            issues.push(this.issue(table, "INVALID_CELL", "error", error instanceof Error ? error.message : String(error), {
                                row: rowIndex + 1,
                                column: field,
                                header,
                            }));
                        }
                    }
                    if (!rowValid)
                        continue;
                    for (const tracker of keyTrackers) {
                        const fingerprint = key(row, tracker.fields);
                        const previous = tracker.rows.get(fingerprint);
                        if (previous !== undefined) {
                            const label = tracker.kind === "primary"
                                ? "primary key"
                                : `unique key ${tracker.index + 1} (${tracker.fields.join(", ")})`;
                            issues.push(this.issue(table, tracker.kind === "primary" ? "DUPLICATE_PRIMARY_KEY" : "DUPLICATE_UNIQUE_KEY", "error", `Rows ${previous} and ${rowIndex + 1} share ${label}.`, {
                                row: rowIndex + 1,
                            }));
                        }
                        else {
                            tracker.rows.set(fingerprint, rowIndex + 1);
                        }
                    }
                    rows.push(row);
                }
                decoded.set(table.tableName, { loaded: table, rows });
            }
            for (const [tableName, table] of decoded) {
                for (const [relationName, relation] of Object.entries(table.loaded.definition.relations)) {
                    const target = decoded.get(relation.target);
                    if (target === undefined)
                        continue;
                    const local = relationFields(relation.local);
                    const foreign = relationFields(relation.foreign);
                    const targetCounts = new Map();
                    for (const targetRow of target.rows) {
                        const fingerprint = key(targetRow, foreign);
                        targetCounts.set(fingerprint, ((_f = targetCounts.get(fingerprint)) !== null && _f !== void 0 ? _f : 0) + 1);
                    }
                    for (let index = 0; index < table.rows.length; index += 1) {
                        const fingerprint = key(table.rows[index], local);
                        const matches = (_g = targetCounts.get(fingerprint)) !== null && _g !== void 0 ? _g : 0;
                        if (matches === 0 && relation.required) {
                            issues.push(this.issue(table.loaded, "BROKEN_RELATION", "error", `Required relation ${relationName} has no ${relation.target} match.`, {
                                row: index + 2,
                            }));
                        }
                        else if (matches > 1 && relation.cardinality === "one") {
                            issues.push(this.issue(table.loaded, "RELATION_CARDINALITY", "error", `Relation ${relationName} expected at most one ${relation.target} match but found ${matches}.`, { row: index + 2 }));
                        }
                    }
                }
            }
            const tables = loaded.map((table) => {
                var _a, _b;
                const rows = (_b = (_a = decoded.get(table.tableName)) === null || _a === void 0 ? void 0 : _a.rows) !== null && _b !== void 0 ? _b : [];
                return {
                    source: table.sourceName,
                    spreadsheetId: table.spreadsheetId,
                    table: table.tableName,
                    sheet: table.definition.sheet,
                    decodedRows: rows.length,
                    decodedHash: hashCanonical$1(rows),
                };
            });
            return Object.freeze({
                schemaVersion: 2,
                generatedAt,
                issues: Object.freeze(issues),
                actions: Object.freeze(actions),
                backupRequired: actions.length > 0,
                canMigrate: !issues.some((issue) => issue.severity === "error"),
                canonicalCells,
                legacyCells,
                invalidCells,
                tables: Object.freeze(tables),
            });
        }
        migrate(options) {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            if (options.confirm !== true)
                throw new GQueryRuntimeError("MIGRATION_REQUIRED", "schema.migrate() requires confirm: true.");
            const plan = this.plan();
            if (!plan.canMigrate) {
                throw new GQueryRuntimeError("MIGRATION_REQUIRED", "Schema migration is blocked by audit errors.", {
                    details: { errors: plan.issues.filter((issue) => issue.severity === "error") },
                });
            }
            const actions = plan.actions.filter((action) => options.includeBackfill === true || action.kind !== "backfill-cell");
            if (actions.length === 0)
                return { status: "no-op", backups: Object.freeze({}), appliedActions: 0, plan };
            const adapter = (_a = options.adapter) !== null && _a !== void 0 ? _a : new AppsScriptSchemaMigrationAdapter();
            const bySpreadsheet = new Map();
            for (const action of actions) {
                const group = (_b = bySpreadsheet.get(action.spreadsheetId)) !== null && _b !== void 0 ? _b : [];
                group.push(action);
                bySpreadsheet.set(action.spreadsheetId, group);
            }
            const backups = {};
            for (const [spreadsheetId, workbookActions] of bySpreadsheet) {
                const backupId = (_d = (_c = options.backupIds) === null || _c === void 0 ? void 0 : _c[spreadsheetId]) !== null && _d !== void 0 ? _d : (options.createBackups === true ? adapter.createBackup(spreadsheetId) : undefined);
                if (backupId === undefined || backupId.length === 0) {
                    throw new GQueryRuntimeError("BACKUP_REQUIRED", `A full backup is required before migrating spreadsheet ${spreadsheetId}.`);
                }
                backups[spreadsheetId] = backupId;
                adapter.apply(spreadsheetId, workbookActions, { backupId, migratedAt: new Date().toISOString() });
                (_f = (_e = this.access).invalidateStructure) === null || _f === void 0 ? void 0 : _f.call(_e, spreadsheetId);
                for (const tableName of new Set(workbookActions.flatMap((action) => "table" in action ? [action.table] : []))) {
                    (_h = (_g = this.access).invalidateTable) === null || _h === void 0 ? void 0 : _h.call(_g, spreadsheetId, tableName);
                }
            }
            return {
                status: "migrated",
                backups: Object.freeze(backups),
                appliedActions: actions.length,
                plan,
            };
        }
        spreadsheetIds() {
            return [...new Set(Object.values(this.access.definition.tables).map((definition) => this.access.resolveSourceId(definition.source)))].sort();
        }
        setStrictCanonical(enabled, adapter, plan) {
            const spreadsheetIds = this.spreadsheetIds();
            const changed = spreadsheetIds.filter((spreadsheetId) => this.canonicalState.isStrictCanonical(spreadsheetId) !== enabled);
            if (changed.length === 0) {
                return {
                    status: "no-op",
                    strictCanonical: enabled,
                    spreadsheets: Object.freeze([]),
                    ...(plan === undefined ? {} : { plan }),
                };
            }
            const modeAdapter = adapter !== null && adapter !== void 0 ? adapter : new AppsScriptSchemaCanonicalModeAdapter();
            const changedAt = new Date().toISOString();
            for (const spreadsheetId of changed) {
                modeAdapter.apply(spreadsheetId, enabled, { changedAt });
                this.canonicalState.setStrictCanonical(spreadsheetId, enabled);
            }
            return {
                status: enabled ? "activated" : "rolled-back",
                strictCanonical: enabled,
                spreadsheets: Object.freeze(changed),
                ...(plan === undefined ? {} : { plan }),
            };
        }
        loadTables(actions, issues) {
            var _a, _b, _c, _d;
            const grouped = new Map();
            for (const [tableName, definition] of Object.entries(this.access.definition.tables)) {
                const spreadsheetId = this.access.resolveSourceId(definition.source);
                let group = grouped.get(spreadsheetId);
                if (group === undefined) {
                    group = {
                        sourceName: definition.source,
                        metadata: this.access.transport.getSpreadsheetMetadata(spreadsheetId),
                        entries: [],
                    };
                    grouped.set(spreadsheetId, group);
                }
                group.entries.push([tableName, definition]);
            }
            const loaded = [];
            for (const [spreadsheetId, group] of grouped) {
                for (const systemSheet of GQUERY_SYSTEM_SHEET_NAMES) {
                    if (!group.metadata.sheets.some((sheet) => sheet.title === systemSheet)) {
                        actions.push({ kind: "create-system-sheet", spreadsheetId, sheet: systemSheet });
                    }
                }
                const existing = group.entries.filter(([, definition]) => group.metadata.sheets.some((sheet) => sheet.title === definition.sheet));
                const systemSheets = group.metadata.sheets.filter((sheet) => GQUERY_SYSTEM_SHEET_NAMES.includes(sheet.title));
                const ranges = [
                    ...existing.map(([, definition]) => `'${definition.sheet.replace(/'/g, "''")}'`),
                    ...systemSheets.map((sheet) => sheet.title === "_gq_dead_letters"
                        ? "'_gq_dead_letters'!1:1"
                        : "'_gq_meta'"),
                ];
                const response = ranges.length === 0
                    ? { valueRanges: [] }
                    : this.access.transport.batchGet(spreadsheetId, ranges, {
                        valueRenderOption: existing.some(([, definition]) => tableUsesFormula(definition)) ? "FORMULA" : "UNFORMATTED_VALUE",
                    });
                let existingIndex = 0;
                for (const [tableName, definition] of group.entries) {
                    const sheet = group.metadata.sheets.find((candidate) => candidate.title === definition.sheet);
                    if (sheet === undefined) {
                        const placeholder = {
                            sourceName: definition.source,
                            spreadsheetId,
                            tableName,
                            definition,
                            values: [],
                        };
                        issues.push(this.issue(placeholder, "MISSING_SHEET", "error", `Required sheet ${definition.sheet} is missing.`));
                        loaded.push(placeholder);
                        continue;
                    }
                    loaded.push({
                        sourceName: definition.source,
                        spreadsheetId,
                        tableName,
                        definition,
                        sheet,
                        values: (_b = (_a = response.valueRanges[existingIndex]) === null || _a === void 0 ? void 0 : _a.values) !== null && _b !== void 0 ? _b : [],
                    });
                    existingIndex += 1;
                }
                for (let index = 0; index < systemSheets.length; index += 1) {
                    this.auditSystemSheet(group.sourceName, spreadsheetId, systemSheets[index], (_d = (_c = response.valueRanges[existing.length + index]) === null || _c === void 0 ? void 0 : _c.values) !== null && _d !== void 0 ? _d : [], actions, issues);
                }
            }
            return loaded;
        }
        auditSystemSheet(sourceName, spreadsheetId, sheet, values, actions, issues) {
            var _a, _b, _c;
            if (sheet.title !== "_gq_meta" && sheet.title !== "_gq_dead_letters")
                return;
            const systemSheet = sheet.title;
            const cells = [];
            const headers = (_a = values[0]) !== null && _a !== void 0 ? _a : [];
            if (systemSheet === "_gq_meta") {
                META_HEADERS.forEach((header, columnIndex) => {
                    if (physicalString(headers[columnIndex]) !== header) {
                        cells.push({ rowIndex: 0, columnIndex, value: { kind: "literal", value: header } });
                    }
                });
                const byKey = new Map();
                for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
                    const candidate = physicalString((_b = values[rowIndex]) === null || _b === void 0 ? void 0 : _b[0]);
                    if (candidate !== "" && !byKey.has(candidate))
                        byKey.set(candidate, rowIndex);
                }
                let nextRow = Math.max(1, values.length);
                for (const required of META_REQUIRED_ROWS) {
                    let rowIndex = byKey.get(required.key);
                    if (rowIndex === undefined) {
                        rowIndex = nextRow;
                        nextRow += 1;
                        cells.push({ rowIndex, columnIndex: 0, value: { kind: "literal", value: required.key } });
                        cells.push({ rowIndex, columnIndex: 1, value: required.fallback });
                        continue;
                    }
                    const current = physicalString((_c = values[rowIndex]) === null || _c === void 0 ? void 0 : _c[1]);
                    const valid = required.key === "schema_version"
                        ? current === "2"
                        : required.key === "strict_canonical"
                            ? current === "true" || current === "false"
                            : current.trim().length > 0;
                    if (!valid)
                        cells.push({ rowIndex, columnIndex: 1, value: required.fallback });
                }
            }
            else {
                const expectedHeaders = [
                    ...DEFERRED_DEAD_LETTER_BASE_HEADERS,
                    DEFERRED_DEAD_LETTER_ACTOR_HEADER,
                ];
                const baseCanonical = DEFERRED_DEAD_LETTER_BASE_HEADERS.every((header, columnIndex) => physicalString(headers[columnIndex]) === header);
                const actorPresent = headers.some((header) => physicalString(header) === DEFERRED_DEAD_LETTER_ACTOR_HEADER);
                if (baseCanonical && !actorPresent) {
                    actions.push({
                        kind: "add-dead-letter-actor-column",
                        spreadsheetId,
                        sheetId: sheet.sheetId,
                        columnIndex: headers.length,
                        gridColumnCount: sheet.columnCount,
                    });
                }
                else if (!baseCanonical) {
                    expectedHeaders.forEach((header, columnIndex) => {
                        if (physicalString(headers[columnIndex]) !== header) {
                            cells.push({ rowIndex: 0, columnIndex, value: { kind: "literal", value: header } });
                        }
                    });
                }
            }
            if (cells.length > 0) {
                issues.push({
                    code: "INVALID_SYSTEM_SHEET",
                    severity: "warning",
                    source: sourceName,
                    spreadsheetId,
                    table: systemSheet,
                    sheet: systemSheet,
                    message: `System sheet ${systemSheet} is incomplete and will be repaired by schema.migrate().`,
                });
                actions.push({
                    kind: "repair-system-sheet-cells",
                    spreadsheetId,
                    sheet: systemSheet,
                    sheetId: sheet.sheetId,
                    gridColumnCount: sheet.columnCount,
                    cells: Object.freeze(cells),
                });
            }
            if (sheet.hasFullSheetProtection === false) {
                issues.push({
                    code: "UNPROTECTED_SYSTEM_SHEET",
                    severity: "warning",
                    source: sourceName,
                    spreadsheetId,
                    table: systemSheet,
                    sheet: systemSheet,
                    message: `System sheet ${systemSheet} is not fully protected.`,
                });
                actions.push({
                    kind: "protect-system-sheet",
                    spreadsheetId,
                    sheet: systemSheet,
                    sheetId: sheet.sheetId,
                });
            }
        }
        issue(table, code, severity, message, location = {}) {
            return {
                code,
                severity,
                source: table.sourceName,
                spreadsheetId: table.spreadsheetId,
                table: table.tableName,
                sheet: table.definition.sheet,
                ...location,
                message,
            };
        }
    }
    /** Persist the canonical-mode switch in the protected `_gq_meta` sheet. */
    class AppsScriptSchemaCanonicalModeAdapter {
        apply(spreadsheetId, enabled, context) {
            if (typeof SpreadsheetApp === "undefined") {
                throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "SpreadsheetApp is required to change canonical migration mode.");
            }
            const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName("_gq_meta");
            if (sheet === null) {
                throw new GQueryRuntimeError("MIGRATION_REQUIRED", "The protected _gq_meta sheet must exist before changing canonical migration mode.");
            }
            const lastRow = Math.max(1, sheet.getLastRow());
            const values = sheet.getRange(1, 1, lastRow, 2).getDisplayValues();
            const strictIndex = values.findIndex((row) => row[0] === "strict_canonical");
            if (strictIndex < 0) {
                throw new GQueryRuntimeError("MIGRATION_REQUIRED", "_gq_meta is missing the strict_canonical migration state row.");
            }
            sheet.getRange(strictIndex + 1, 2).setValue(String(enabled));
            const changedIndex = values.findIndex((row) => row[0] === "strict_canonical_changed_at");
            if (changedIndex >= 0)
                sheet.getRange(changedIndex + 1, 2).setValue(context.changedAt);
            else
                sheet.appendRow(["strict_canonical_changed_at", context.changedAt]);
        }
    }
    function utf8Bytes(value) {
        let bytes = 0;
        for (let index = 0; index < value.length; index += 1) {
            const codeUnit = value.charCodeAt(index);
            if (codeUnit < 0x80)
                bytes += 1;
            else if (codeUnit < 0x800)
                bytes += 2;
            else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
                const next = value.charCodeAt(index + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    bytes += 4;
                    index += 1;
                }
                else {
                    bytes += 3;
                }
            }
            else {
                bytes += 3;
            }
        }
        return bytes;
    }
    function requestBytes(request) {
        return utf8Bytes(JSON.stringify(request));
    }
    const MAX_VERSION_ROWS_PER_REQUEST = 10000;
    /** Default Apps Script migration adapter. It is used only by explicit migrate(). */
    class AppsScriptSchemaMigrationAdapter {
        createBackup(spreadsheetId) {
            const source = DriveApp.getFileById(spreadsheetId);
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            return source.makeCopy(`${source.getName()} GQuery backup ${timestamp}`).getId();
        }
        apply(spreadsheetId, actions, context) {
            var _a;
            const service = Sheets;
            if (service === undefined) {
                throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "The Advanced Sheets service must be enabled before schema migration.");
            }
            const metadata = service.Spreadsheets.get(spreadsheetId, { fields: "sheets(properties(sheetId,title))" });
            const usedIds = new Set(((_a = metadata.sheets) !== null && _a !== void 0 ? _a : []).map((sheet) => { var _a; return (_a = sheet.properties) === null || _a === void 0 ? void 0 : _a.sheetId; }).filter((id) => id !== undefined));
            let nextSystemId = 1900000000;
            const requests = [];
            for (const action of actions) {
                if (action.kind === "add-version-column") {
                    if (action.columnIndex >= action.gridColumnCount) {
                        requests.push({ appendDimension: { sheetId: action.sheetId, dimension: "COLUMNS", length: action.columnIndex - action.gridColumnCount + 1 } });
                    }
                    requests.push({
                        updateCells: {
                            range: {
                                sheetId: action.sheetId,
                                startRowIndex: 0,
                                startColumnIndex: action.columnIndex,
                            },
                            rows: [{ values: [{ userEnteredValue: { stringValue: action.header } }] }],
                            fields: "userEnteredValue",
                        },
                    });
                    const contiguous = [];
                    for (const rowIndex of action.populatedRowIndexes) {
                        const previous = contiguous[contiguous.length - 1];
                        if (previous !== undefined && rowIndex === previous.end)
                            previous.end += 1;
                        else
                            contiguous.push({ start: rowIndex, end: rowIndex + 1 });
                    }
                    for (const span of contiguous) {
                        for (let start = span.start; start < span.end; start += MAX_VERSION_ROWS_PER_REQUEST) {
                            const end = Math.min(span.end, start + MAX_VERSION_ROWS_PER_REQUEST);
                            requests.push({
                                updateCells: {
                                    range: {
                                        sheetId: action.sheetId,
                                        startRowIndex: start,
                                        startColumnIndex: action.columnIndex,
                                    },
                                    rows: Array.from({ length: end - start }, () => ({ values: [{ userEnteredValue: { numberValue: 1 } }] })),
                                    fields: "userEnteredValue",
                                },
                            });
                        }
                    }
                    requests.push({ updateDimensionProperties: {
                            range: { sheetId: action.sheetId, dimension: "COLUMNS", startIndex: action.columnIndex, endIndex: action.columnIndex + 1 },
                            properties: { hiddenByUser: true },
                            fields: "hiddenByUser",
                        } });
                }
                else if (action.kind === "backfill-cell" || action.kind === "repair-version-cell") {
                    const userEnteredValue = encodeAtomicExtendedValue(action.value);
                    requests.push({ updateCells: {
                            range: { sheetId: action.sheetId, startRowIndex: action.rowIndex, startColumnIndex: action.columnIndex },
                            rows: [{ values: [userEnteredValue === undefined ? {} : { userEnteredValue }] }],
                            fields: "userEnteredValue",
                        } });
                }
                else if (action.kind === "add-dead-letter-actor-column") {
                    if (action.columnIndex >= action.gridColumnCount) {
                        requests.push({ appendDimension: {
                                sheetId: action.sheetId,
                                dimension: "COLUMNS",
                                length: action.columnIndex - action.gridColumnCount + 1,
                            } });
                    }
                    requests.push({ updateCells: {
                            range: {
                                sheetId: action.sheetId,
                                startRowIndex: 0,
                                startColumnIndex: action.columnIndex,
                            },
                            rows: [{ values: [{ userEnteredValue: { stringValue: DEFERRED_DEAD_LETTER_ACTOR_HEADER } }] }],
                            fields: "userEnteredValue",
                        } });
                }
                else if (action.kind === "repair-system-sheet-cells") {
                    const requiredColumns = action.cells.reduce((maximum, cell) => Math.max(maximum, cell.columnIndex + 1), 0);
                    if (requiredColumns > action.gridColumnCount) {
                        requests.push({ appendDimension: {
                                sheetId: action.sheetId,
                                dimension: "COLUMNS",
                                length: requiredColumns - action.gridColumnCount,
                            } });
                    }
                    for (const cell of action.cells) {
                        const value = cell.value.kind === "literal"
                            ? cell.value.value
                            : cell.value.kind === "backup-id"
                                ? context.backupId
                                : context.migratedAt;
                        requests.push({ updateCells: {
                                range: {
                                    sheetId: action.sheetId,
                                    startRowIndex: cell.rowIndex,
                                    startColumnIndex: cell.columnIndex,
                                },
                                rows: [{ values: [{ userEnteredValue: { stringValue: value } }] }],
                                fields: "userEnteredValue",
                            } });
                    }
                }
                else if (action.kind === "protect-system-sheet") {
                    requests.push({ addProtectedRange: {
                            protectedRange: {
                                range: { sheetId: action.sheetId },
                                description: "Managed by GQuery 2.0",
                                warningOnly: false,
                            },
                        } });
                }
                else {
                    while (usedIds.has(nextSystemId))
                        nextSystemId -= 1;
                    const sheetId = nextSystemId;
                    usedIds.add(sheetId);
                    nextSystemId -= 1;
                    const values = action.sheet === "_gq_meta"
                        ? [
                            ["Key", "Value"],
                            ["schema_version", "2"],
                            ["migrated_at", context.migratedAt],
                            ["backup_id", context.backupId],
                            ["strict_canonical", "false"],
                            ["strict_canonical_changed_at", context.migratedAt],
                        ]
                        : [[...DEFERRED_DEAD_LETTER_BASE_HEADERS, DEFERRED_DEAD_LETTER_ACTOR_HEADER]];
                    requests.push({ addSheet: { properties: { sheetId, title: action.sheet, hidden: true } } });
                    requests.push({ updateCells: {
                            range: { sheetId, startRowIndex: 0, startColumnIndex: 0 },
                            rows: values.map((row) => ({ values: row.map((value) => ({ userEnteredValue: { stringValue: value } })) })),
                            fields: "userEnteredValue",
                        } });
                    requests.push({ addProtectedRange: {
                            protectedRange: {
                                range: { sheetId },
                                description: "Managed by GQuery 2.0",
                                warningOnly: false,
                            },
                        } });
                }
            }
            const chunks = [];
            let chunk = [];
            let bytes = 0;
            for (const request of requests) {
                const size = requestBytes(request);
                if (chunk.length > 0 && bytes + size > 1800000) {
                    chunks.push(chunk);
                    chunk = [];
                    bytes = 0;
                }
                chunk.push(request);
                bytes += size;
            }
            if (chunk.length > 0)
                chunks.push(chunk);
            for (const requestsChunk of chunks) {
                service.Spreadsheets.batchUpdate({ requests: requestsChunk }, spreadsheetId);
            }
        }
    }

    function sameTrigger(left, right) {
        return (left.kind === right.kind &&
            left.handler === right.handler &&
            left.spreadsheetId === right.spreadsheetId &&
            left.everyMinutes === right.everyMinutes);
    }
    /** Reconciles durably owned trigger IDs and leaves unrelated project triggers alone. */
    class TriggerReconciler {
        constructor(platform) {
            this.platform = platform;
        }
        reconcile(configuration) {
            var _a;
            const desired = [];
            if (configuration.onEdit !== undefined) {
                desired.push({
                    kind: "edit",
                    handler: configuration.onEdit,
                    spreadsheetId: configuration.spreadsheetId,
                });
            }
            if (configuration.onChange !== undefined) {
                desired.push({
                    kind: "change",
                    handler: configuration.onChange,
                    spreadsheetId: configuration.spreadsheetId,
                });
            }
            if (configuration.flush !== undefined) {
                desired.push({
                    kind: "clock",
                    handler: configuration.flush.handler,
                    everyMinutes: configuration.flush.everyMinutes,
                });
            }
            const installed = [...this.platform.list()];
            const kept = [];
            const used = new Set();
            for (const spec of desired) {
                const exact = (candidate) => !used.has(candidate.id) && sameTrigger(candidate, spec);
                const match = (_a = installed.find((candidate) => candidate.managed === true && exact(candidate))) !== null && _a !== void 0 ? _a : installed.find(exact);
                if (match !== undefined) {
                    const owned = match.managed === true || this.platform.manage === undefined
                        ? match
                        : this.platform.manage(match);
                    kept.push(owned);
                    used.add(owned.id);
                }
            }
            const removed = installed.filter((candidate) => candidate.managed === true && !used.has(candidate.id));
            for (const trigger of removed)
                this.platform.remove(trigger.id);
            const created = desired
                .filter((spec) => !kept.some((candidate) => sameTrigger(candidate, spec)))
                .map((spec) => this.platform.create(spec));
            return { created, kept, removed };
        }
    }
    /** Apps Script adapter which persists clock cadence because Trigger does not expose it. */
    class AppsScriptTriggerPlatform {
        constructor(properties, metadataNamespace = "gq2") {
            this.properties = properties;
            this.metadataNamespace = metadataNamespace;
        }
        list() {
            return ScriptApp.getProjectTriggers().map((trigger) => {
                const id = trigger.getUniqueId();
                const stored = this.readMetadata(id);
                if (stored !== null)
                    return { ...stored.spec, id, managed: true };
                const event = trigger.getEventType();
                const kind = event === ScriptApp.EventType.ON_EDIT
                    ? "edit"
                    : event === ScriptApp.EventType.ON_CHANGE
                        ? "change"
                        : "clock";
                let spreadsheetId;
                if (kind !== "clock") {
                    try {
                        spreadsheetId = trigger.getTriggerSourceId();
                    }
                    catch {
                        spreadsheetId = undefined;
                    }
                }
                return {
                    id,
                    kind,
                    handler: trigger.getHandlerFunction(),
                    spreadsheetId,
                    managed: false,
                };
            });
        }
        create(spec) {
            let trigger;
            if (spec.kind === "clock") {
                if (spec.everyMinutes === undefined)
                    throw new TypeError("Clock triggers require everyMinutes.");
                trigger = ScriptApp.newTrigger(spec.handler)
                    .timeBased()
                    .everyMinutes(spec.everyMinutes)
                    .create();
            }
            else {
                if (spec.spreadsheetId === undefined)
                    throw new TypeError("Sheet triggers require spreadsheetId.");
                const builder = ScriptApp.newTrigger(spec.handler).forSpreadsheet(spec.spreadsheetId);
                trigger = spec.kind === "edit" ? builder.onEdit().create() : builder.onChange().create();
            }
            const id = trigger.getUniqueId();
            const metadata = { version: 1, spec };
            try {
                this.properties.set(this.metadataKey(id), JSON.stringify(metadata));
            }
            catch (error) {
                ScriptApp.deleteTrigger(trigger);
                throw error;
            }
            return { ...spec, id, managed: true };
        }
        manage(trigger) {
            const spec = {
                kind: trigger.kind,
                handler: trigger.handler,
                ...(trigger.spreadsheetId === undefined ? {} : { spreadsheetId: trigger.spreadsheetId }),
                ...(trigger.everyMinutes === undefined ? {} : { everyMinutes: trigger.everyMinutes }),
            };
            this.properties.set(this.metadataKey(trigger.id), JSON.stringify({ version: 1, spec }));
            return { ...trigger, managed: true };
        }
        remove(id) {
            const trigger = ScriptApp.getProjectTriggers().find((candidate) => candidate.getUniqueId() === id);
            if (trigger !== undefined)
                ScriptApp.deleteTrigger(trigger);
            try {
                this.properties.remove(this.metadataKey(id));
            }
            catch {
                // Stale metadata is ignored when no trigger with this id exists.
            }
        }
        metadataKey(id) {
            return `${this.metadataNamespace}:trigger:${id}`;
        }
        readMetadata(id) {
            const raw = this.properties.get(this.metadataKey(id));
            if (raw === null)
                return null;
            try {
                const parsed = JSON.parse(raw);
                return parsed.version === 1 && typeof parsed.spec === "object" && parsed.spec !== null
                    ? parsed
                    : null;
            }
            catch {
                return null;
            }
        }
    }
    function createAppsScriptTriggerReconciler(namespace) {
        return new TriggerReconciler(new AppsScriptTriggerPlatform(new AppsScriptPropertyStore(PropertiesService.getScriptProperties()), namespace));
    }
    /** Bridges normalized or native installable-trigger events to version/cache invalidation hooks. */
    class SystemEventCoordinator {
        constructor(tables, generations, hooks = {}) {
            this.tables = tables;
            this.generations = generations;
            this.hooks = hooks;
        }
        handleEdit(event) {
            var _a, _b;
            const table = this.tables.find((candidate) => candidate.sourceId === event.sourceId && candidate.sheetId === event.sheetId);
            if (table === undefined)
                return { invalidatedTables: [], invalidatedRows: 0 };
            try {
                (_b = (_a = this.hooks).onRowsEdited) === null || _b === void 0 ? void 0 : _b.call(_a, table, event);
            }
            finally {
                // Even malformed/cleared primary keys must not leave a pre-edit cached
                // snapshot reachable when the hook reports a decoding problem.
                this.generations.invalidateTable(table.sourceId, table.table);
            }
            // Current read caches consume table generations only. Row tokens remain a
            // public opt-in invalidation primitive and must not leak one property per edit.
            return { invalidatedTables: [table.table], invalidatedRows: 0 };
        }
        handleNativeEdit(event) {
            const sheet = event.range.getSheet();
            return this.handleEdit({
                sourceId: event.source.getId(),
                sheetId: sheet.getSheetId(),
                rowStart: event.range.getRow(),
                rowCount: event.range.getNumRows(),
                columnStart: event.range.getColumn(),
                columnCount: event.range.getNumColumns(),
            });
        }
        handleChange(event) {
            var _a, _b;
            const tables = this.tables.filter((table) => table.sourceId === event.sourceId);
            for (const table of tables)
                this.generations.invalidateTable(table.sourceId, table.table);
            (_b = (_a = this.hooks).onStructuralChange) === null || _b === void 0 ? void 0 : _b.call(_a, tables, event);
            return { invalidatedTables: tables.map((table) => table.table), invalidatedRows: 0 };
        }
        handleNativeChange(event) {
            return this.handleChange({ sourceId: event.source.getId(), changeType: event.changeType });
        }
    }

    function tableByName(definition, name) {
        const table = definition.tables[name];
        if (table === undefined)
            throw new GQueryRuntimeError("INVALID_QUERY", `Unknown table ${name}.`);
        return table;
    }
    /** Implements manual-edit version increments with one bounded read/write per edited block. */
    class AppsScriptManualEditHooks {
        constructor(definition) {
            this.definition = definition;
        }
        onRowsEdited(table, event) {
            const definition = tableByName(this.definition, table.table);
            const versionHeader = definition.versionColumn;
            const spreadsheet = SpreadsheetApp.openById(table.sourceId);
            const sheet = spreadsheet.getSheets().find((candidate) => candidate.getSheetId() === table.sheetId);
            if (sheet === undefined)
                return [];
            const lastColumn = Math.max(1, sheet.getLastColumn());
            const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
            const startRow = Math.max(2, event.rowStart);
            const endRow = event.rowStart + event.rowCount - 1;
            if (endRow < startRow)
                return [];
            const rowCount = endRow - startRow + 1;
            const tableColumnIndexes = Object.entries(definition.columns).map(([field, column]) => {
                var _a, _b;
                const index = headers.indexOf((_a = column.header) !== null && _a !== void 0 ? _a : field);
                if (index < 0)
                    throw new GQueryRuntimeError("MISSING_HEADER", `Header ${(_b = column.header) !== null && _b !== void 0 ? _b : field} is missing.`);
                return index;
            });
            const physicalRows = sheet.getRange(startRow, 1, rowCount, lastColumn).getValues();
            const populated = physicalRows.map((row) => tableColumnIndexes.some((index) => {
                const value = row[index];
                return value !== "" && value !== null && value !== undefined;
            }));
            if (versionHeader !== undefined) {
                const versionIndex = headers.indexOf(versionHeader);
                if (versionIndex < 0) {
                    throw new GQueryRuntimeError("MIGRATION_REQUIRED", `Manual edit handling requires version header ${versionHeader} on ${definition.sheet}.`);
                }
                const range = sheet.getRange(startRow, versionIndex + 1, rowCount, 1);
                const current = range.getValues();
                range.setValues(current.map(([value], index) => [
                    populated[index]
                        ? typeof value === "number" && Number.isFinite(value) ? value + 1 : 1
                        : "",
                ]));
            }
            if (definition.primaryKey.length === 0)
                return [];
            const indexes = definition.primaryKey.map((field) => {
                var _a, _b;
                const column = definition.columns[field];
                const index = headers.indexOf((_a = column.header) !== null && _a !== void 0 ? _a : field);
                if (index < 0)
                    throw new GQueryRuntimeError("MISSING_HEADER", `Primary key header ${(_b = column.header) !== null && _b !== void 0 ? _b : field} is missing.`);
                return index;
            });
            return physicalRows.flatMap((row, offset) => {
                if (!populated[offset])
                    return [];
                const result = {};
                definition.primaryKey.forEach((field, index) => {
                    var _a;
                    const column = definition.columns[field];
                    const raw = row[indexes[index]];
                    result[field] = column.decode(raw === "" || raw === null || raw === undefined ? BLANK_CELL : raw, {
                        table: table.table,
                        column: field,
                        header: (_a = column.header) !== null && _a !== void 0 ? _a : field,
                        rowNumber: startRow + offset,
                    });
                });
                return [result];
            });
        }
    }
    class SystemManager {
        constructor(access, hooks) {
            this.access = access;
            this.hooks = hooks;
        }
        reconcileTriggers(configuration) {
            var _a;
            const spreadsheetId = (_a = configuration.spreadsheetId) !== null && _a !== void 0 ? _a : this.defaultSpreadsheetId();
            const full = { ...configuration, spreadsheetId };
            return createAppsScriptTriggerReconciler().reconcile(full);
        }
        handleEdit(event) {
            const coordinator = this.coordinator();
            return "range" in event
                ? coordinator.handleNativeEdit(event)
                : coordinator.handleEdit(event);
        }
        handleChange(event) {
            const coordinator = this.coordinator();
            const result = "source" in event
                ? coordinator.handleNativeChange(event)
                : coordinator.handleChange(event);
            const sourceId = "source" in event
                ? event.source.getId()
                : event.sourceId;
            this.access.executor.invalidateStructure(sourceId);
            return result;
        }
        status() {
            const generations = this.requireGenerations();
            return {
                tables: this.registeredTables().map((table) => ({
                    ...table,
                    generation: generations.current({ kind: "table", sourceId: table.sourceId, table: table.table }),
                })),
            };
        }
        coordinator() {
            var _a;
            const generations = this.requireGenerations();
            return new SystemEventCoordinator(this.registeredTables(), generations, (_a = this.hooks) !== null && _a !== void 0 ? _a : new AppsScriptManualEditHooks(this.access.definition));
        }
        registeredTables() {
            const result = [];
            const metadata = new Map();
            for (const [tableName, definition] of Object.entries(this.access.definition.tables)) {
                const sourceId = this.access.resolveSourceId(definition.source);
                let workbook = metadata.get(sourceId);
                if (workbook === undefined) {
                    workbook = this.access.transport.getSpreadsheetMetadata(sourceId);
                    metadata.set(sourceId, workbook);
                }
                const sheet = workbook.sheets.find((candidate) => candidate.title === definition.sheet);
                if (sheet !== undefined)
                    result.push({ sourceId, sheetId: sheet.sheetId, table: tableName });
            }
            return result;
        }
        defaultSpreadsheetId() {
            const first = Object.values(this.access.definition.tables)[0];
            if (first === undefined)
                throw new GQueryRuntimeError("SOURCE_UNAVAILABLE", "The schema has no table source for trigger installation.");
            return this.access.resolveSourceId(first.source);
        }
        requireGenerations() {
            if (this.access.generations === undefined) {
                throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "System event handling requires a durable generation store.");
            }
            return this.access.generations;
        }
    }

    function decodeCell(value) {
        return value === null || value === undefined ? BLANK_CELL : value;
    }
    class AppsScriptDeadLetterSheet {
        write(records) {
            var _a, _b, _c;
            const bySpreadsheet = new Map();
            for (const record of records) {
                const group = (_a = bySpreadsheet.get(record.mutation.sourceId)) !== null && _a !== void 0 ? _a : [];
                group.push(record);
                bySpreadsheet.set(record.mutation.sourceId, group);
            }
            for (const [spreadsheetId, group] of bySpreadsheet) {
                const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
                const sheet = spreadsheet.getSheetByName("_gq_dead_letters");
                if (sheet === null) {
                    throw new GQueryRuntimeError("MIGRATION_REQUIRED", "Deferred conflicts require the _gq_dead_letters system sheet.");
                }
                const lastRow = Math.max(1, sheet.getLastRow());
                const headerValues = (_b = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getDisplayValues()[0]) !== null && _b !== void 0 ? _b : [];
                const headers = new Map(headerValues.map((header, index) => [header, index]));
                const requiredHeaders = [...DEFERRED_DEAD_LETTER_BASE_HEADERS, DEFERRED_DEAD_LETTER_ACTOR_HEADER];
                const missing = requiredHeaders.filter((header) => !headers.has(header));
                if (missing.length > 0) {
                    throw new GQueryRuntimeError("MIGRATION_REQUIRED", `The _gq_dead_letters system sheet is missing required header${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`, { details: { spreadsheetId, missingHeaders: missing } });
                }
                const idColumn = ((_c = headers.get("ID")) !== null && _c !== void 0 ? _c : 0) + 1;
                const existingIds = lastRow <= 1
                    ? new Set()
                    : new Set(sheet.getRange(2, idColumn, lastRow - 1, 1).getDisplayValues().map((row) => row[0]).filter(Boolean));
                const novel = group.filter((record) => !existingIds.has(record.id));
                if (novel.length === 0)
                    continue;
                const values = novel.map((record) => {
                    var _a;
                    const row = Array.from({ length: headerValues.length }, () => "");
                    const set = (header, value) => { row[headers.get(header)] = value; };
                    set("ID", record.id);
                    set("Mutation ID", record.mutation.id);
                    set("Source", record.mutation.sourceId);
                    set("Table", record.mutation.table);
                    set("Key", JSON.stringify(record.mutation.key));
                    set("Conflict", JSON.stringify(record.conflict));
                    set("Moved At", new Date(record.movedAtMs).toISOString());
                    set(DEFERRED_DEAD_LETTER_ACTOR_HEADER, (_a = record.mutation.actor) !== null && _a !== void 0 ? _a : "");
                    return row;
                });
                sheet.getRange(lastRow + 1, 1, values.length, headerValues.length).setValues(values);
            }
        }
    }
    function composeDeferredSources(sources) {
        var _a;
        if (sources.length === 0) {
            throw new GQueryRuntimeError("MUTATION_INVALID", "Cannot compose an empty deferred mutation group.");
        }
        let kind = sources[0].kind;
        let values = sources[0].values === undefined ? undefined : { ...sources[0].values };
        for (const source of sources.slice(1)) {
            const nextKind = source.kind === "delete"
                ? "delete"
                : kind === "create" && source.kind === "upsert"
                    ? "upsert"
                    : kind;
            values = nextKind === "delete"
                ? undefined
                : { ...(values !== null && values !== void 0 ? values : {}), ...((_a = source.values) !== null && _a !== void 0 ? _a : {}) };
            kind = nextKind;
        }
        return { kind, values };
    }
    class JournalMutationExecutor {
        constructor(access, applied) {
            this.access = access;
            this.applied = applied;
        }
        apply(mutations) {
            const settled = new Map();
            const effective = [];
            for (const mutation of mutations) {
                const pendingSources = this.applied === undefined
                    ? mutation.sourceMutations
                    : mutation.sourceMutations.filter((source) => !this.applied.has(source.id));
                if (pendingSources.length === 0) {
                    settled.set(mutation.id, { mutationId: mutation.id, status: "committed" });
                    continue;
                }
                if (pendingSources.length === mutation.sourceMutations.length) {
                    effective.push(mutation);
                    continue;
                }
                const pending = composeDeferredSources(pendingSources);
                const appliedSources = mutation.sourceMutations.filter((source) => !pendingSources.some((pendingSource) => pendingSource.id === source.id));
                const applied = composeDeferredSources(appliedSources);
                effective.push({
                    ...mutation,
                    sourceMutationIds: pendingSources.map((source) => source.id),
                    sourceMutations: pendingSources,
                    kind: pending.kind,
                    values: pending.values,
                    // The durable applied-prefix receipt supersedes the original version.
                    // Its encoded final fields are verified against the physical snapshot
                    // before the unapplied suffix is allowed to proceed.
                    expectedVersion: null,
                    recoveryAppliedValues: applied.kind === "delete" ? undefined : applied.values,
                });
            }
            if (effective.length === 0)
                return mutations.map((mutation) => settled.get(mutation.id));
            if (this.access.batchRead === undefined || this.access.commitBatch === undefined) {
                for (const mutation of effective)
                    settled.set(mutation.id, this.applyOne(mutation));
                return mutations.map((mutation) => settled.get(mutation.id));
            }
            const execute = () => this.applyBatched(effective);
            const outcomes = this.access.withWriteLock === undefined
                ? execute()
                : this.access.withWriteLock(execute);
            for (const outcome of outcomes)
                settled.set(outcome.mutationId, outcome);
            return mutations.map((mutation) => {
                var _a;
                return (_a = settled.get(mutation.id)) !== null && _a !== void 0 ? _a : ({
                    mutationId: mutation.id,
                    status: "transient",
                    message: "The deferred recovery batch did not produce an outcome.",
                });
            });
        }
        applyBatched(mutations) {
            var _a;
            const outcomes = new Map();
            const byWorkbook = new Map();
            for (const mutation of mutations) {
                try {
                    const definition = this.table(mutation.table);
                    const source = this.access.definition.sources[definition.source];
                    if (source === undefined) {
                        outcomes.set(mutation.id, this.conflict(mutation, `Table ${mutation.table} references unknown source ${definition.source}.`));
                        continue;
                    }
                    const resolvedSourceId = this.access.resolveSourceId(definition.source);
                    if (resolvedSourceId !== mutation.sourceId) {
                        if (source.kind === "active-spreadsheet") {
                            throw new GQueryRuntimeError("SOURCE_UNAVAILABLE", `Deferred mutation ${mutation.id} targets ${mutation.sourceId}, but the active source resolved to ${resolvedSourceId}.`, { details: { expectedSourceId: mutation.sourceId, actualSourceId: resolvedSourceId } });
                        }
                        outcomes.set(mutation.id, this.conflict(mutation, `Deferred mutation source ${mutation.sourceId} does not match configured source ${resolvedSourceId}.`, { expectedSourceId: mutation.sourceId, actualSourceId: resolvedSourceId }));
                        continue;
                    }
                    if (definition.primaryKey.length === 0) {
                        outcomes.set(mutation.id, this.conflict(mutation, `Deferred table ${mutation.table} does not declare a primary key.`));
                        continue;
                    }
                    const logicalKey = this.decodeRecord(definition, mutation.key);
                    const missingKeyFields = definition.primaryKey.filter((field) => !(field in logicalKey));
                    if (missingKeyFields.length > 0) {
                        outcomes.set(mutation.id, this.conflict(mutation, `Deferred key is missing primary-key field${missingKeyFields.length === 1 ? "" : "s"}: ${missingKeyFields.join(", ")}.`, { missingKeyFields }));
                        continue;
                    }
                    const group = (_a = byWorkbook.get(mutation.sourceId)) !== null && _a !== void 0 ? _a : [];
                    group.push({ mutation, definition, logicalKey });
                    byWorkbook.set(mutation.sourceId, group);
                }
                catch (error) {
                    outcomes.set(mutation.id, this.transient(mutation, error));
                }
            }
            for (const group of byWorkbook.values()) {
                try {
                    this.applyWorkbookGroup(group, outcomes);
                }
                catch (error) {
                    for (const prepared of group) {
                        if (!outcomes.has(prepared.mutation.id)) {
                            outcomes.set(prepared.mutation.id, this.transient(prepared.mutation, error));
                        }
                    }
                }
            }
            return mutations.map((mutation) => {
                var _a;
                return (_a = outcomes.get(mutation.id)) !== null && _a !== void 0 ? _a : ({
                    mutationId: mutation.id,
                    status: "transient",
                    message: "The deferred batch did not produce an outcome.",
                });
            });
        }
        applyWorkbookGroup(prepared, outcomes) {
            var _a, _b, _c, _d, _e, _f;
            const tableNames = new Set(prepared.map((item) => item.mutation.table));
            for (const item of prepared) {
                if (item.mutation.kind !== "create" && item.mutation.kind !== "upsert" && item.mutation.kind !== "patch") {
                    continue;
                }
                const changedFields = new Set(Object.keys((_a = item.mutation.values) !== null && _a !== void 0 ? _a : {}));
                for (const relation of Object.values(item.definition.relations)) {
                    if (relation.kind !== "belongs-to")
                        continue;
                    const local = Array.isArray(relation.local) ? relation.local : [relation.local];
                    if (item.mutation.kind !== "patch" || local.some((field) => changedFields.has(field))) {
                        tableNames.add(relation.target);
                    }
                }
            }
            const complete = this.access.batchRead([...tableNames]);
            const snapshots = Object.entries(complete).map(([tableName, selection]) => ({
                tableName,
                rows: selection[SELECTION_INTERNAL].materialized,
            }));
            const staged = [];
            for (const item of prepared) {
                const full = complete[item.mutation.table];
                if (full === undefined) {
                    throw new GQueryRuntimeError("INVALID_QUERY", `The deferred batch reader returned no snapshot for ${item.mutation.table}.`);
                }
                const expectedKey = this.keyFingerprint(item.definition, item.logicalKey);
                const matches = full[SELECTION_INTERNAL].materialized.filter((row) => this.keyFingerprint(item.definition, row.value) === expectedKey);
                const selection = new Selection(matches, full.headers, full.stats, full[SELECTION_INTERNAL].runtime, full[SELECTION_INTERNAL].refresh);
                if (selection.length > 1) {
                    outcomes.set(item.mutation.id, this.conflict(item.mutation, "The deferred key resolved to more than one row."));
                    continue;
                }
                const provenance = (_b = matches[0]) === null || _b === void 0 ? void 0 : _b.provenance;
                const decodedValues = this.decodeRecord(item.definition, (_c = item.mutation.values) !== null && _c !== void 0 ? _c : {});
                const recoveryAppliedValues = item.mutation.recoveryAppliedValues === undefined
                    ? undefined
                    : this.decodeRecord(item.definition, item.mutation.recoveryAppliedValues);
                if (provenance !== undefined &&
                    recoveryAppliedValues !== undefined &&
                    this.matchesIntendedState(item.mutation.kind, matches[0].value, decodedValues)) {
                    outcomes.set(item.mutation.id, this.committed(item.mutation));
                    continue;
                }
                if (recoveryAppliedValues !== undefined &&
                    (provenance === undefined ||
                        !this.matchesIntendedState("patch", matches[0].value, recoveryAppliedValues))) {
                    outcomes.set(item.mutation.id, this.conflict(item.mutation, "The physical row no longer matches the confirmed deferred prefix during crash recovery.", { appliedFields: Object.keys(recoveryAppliedValues) }));
                    continue;
                }
                if (provenance !== undefined &&
                    item.mutation.expectedVersion !== undefined &&
                    item.mutation.expectedVersion !== null &&
                    !Object.is(provenance.version, item.mutation.expectedVersion)) {
                    if (this.matchesIntendedState(item.mutation.kind, matches[0].value, decodedValues)) {
                        outcomes.set(item.mutation.id, this.committed(item.mutation));
                        continue;
                    }
                    outcomes.set(item.mutation.id, this.conflict(item.mutation, "The expected row version no longer matches.", { expected: item.mutation.expectedVersion, actual: provenance.version }));
                    continue;
                }
                if (item.definition.appendOnly === true &&
                    (item.mutation.kind === "patch" || item.mutation.kind === "delete" ||
                        (item.mutation.kind === "upsert" && selection.length > 0))) {
                    outcomes.set(item.mutation.id, this.conflict(item.mutation, `Append-only table ${item.mutation.table} cannot apply deferred ${item.mutation.kind} to an existing row.`));
                    continue;
                }
                const suppliedKeyFields = item.definition.primaryKey.filter((field) => Object.prototype.hasOwnProperty.call(decodedValues, field));
                if (item.mutation.kind === "patch" && suppliedKeyFields.length > 0) {
                    outcomes.set(item.mutation.id, this.conflict(item.mutation, `Deferred patches cannot change primary-key field${suppliedKeyFields.length === 1 ? "" : "s"}: ${suppliedKeyFields.join(", ")}.`, { suppliedKeyFields }));
                    continue;
                }
                const mismatchedKeyFields = suppliedKeyFields.filter((field) => canonicalStringify$1(decodedValues[field]) !== canonicalStringify$1(item.logicalKey[field]));
                if (mismatchedKeyFields.length > 0) {
                    outcomes.set(item.mutation.id, this.conflict(item.mutation, `Deferred values do not match the key-addressed field${mismatchedKeyFields.length === 1 ? "" : "s"}: ${mismatchedKeyFields.join(", ")}.`, { mismatchedKeyFields }));
                    continue;
                }
                let intent;
                if (item.mutation.kind === "delete") {
                    if (selection.length === 0) {
                        outcomes.set(item.mutation.id, this.committed(item.mutation));
                        continue;
                    }
                    intent = { id: item.mutation.id, kind: "delete", selection };
                }
                else if (item.mutation.kind === "patch") {
                    if (selection.length === 0) {
                        outcomes.set(item.mutation.id, this.conflict(item.mutation, "The row no longer exists."));
                        continue;
                    }
                    intent = {
                        id: item.mutation.id,
                        kind: "update",
                        selection,
                        patch: decodedValues,
                    };
                }
                else {
                    const values = {
                        ...decodedValues,
                        ...item.logicalKey,
                    };
                    if (item.mutation.kind === "create" && selection.length > 0) {
                        outcomes.set(item.mutation.id, this.matchesIntendedState(item.mutation.kind, matches[0].value, values)
                            ? this.committed(item.mutation)
                            : this.conflict(item.mutation, "A different row already exists for the caller-assigned create key."));
                        continue;
                    }
                    intent = selection.length === 0
                        ? { id: item.mutation.id, kind: "append", tableName: item.mutation.table, rows: [values] }
                        : { id: item.mutation.id, kind: "update", selection, patch: values };
                }
                staged.push({ ...item, selection, intent });
            }
            if (staged.length === 0)
                return;
            const intents = [];
            const appendedByTable = new Map();
            for (const item of staged) {
                if (item.intent.kind !== "append") {
                    intents.push(item.intent);
                    continue;
                }
                const append = (_d = appendedByTable.get(item.intent.tableName)) !== null && _d !== void 0 ? _d : {
                    id: item.intent.id,
                    rows: [],
                };
                append.rows.push(...item.intent.rows);
                appendedByTable.set(item.intent.tableName, append);
            }
            for (const [tableName, append] of appendedByTable) {
                intents.push({ id: append.id, kind: "append", tableName, rows: append.rows });
            }
            (_e = this.applied) === null || _e === void 0 ? void 0 : _e.assertCanMarkMany(staged.flatMap((item) => item.mutation.sourceMutationIds));
            const committed = this.access.commitBatch(intents, snapshots);
            if (committed.status === "committed") {
                // One ledger publication narrows the post-commit crash window for the
                // whole atomic workbook request. State comparison below remains the
                // recovery fence if execution stops before this publication.
                (_f = this.applied) === null || _f === void 0 ? void 0 : _f.markMany(staged.flatMap((item) => item.mutation.sourceMutationIds));
                for (const item of staged) {
                    outcomes.set(item.mutation.id, this.committed(item.mutation, false));
                }
                return;
            }
            if (committed.status === "partial") {
                for (const item of staged) {
                    outcomes.set(item.mutation.id, {
                        mutationId: item.mutation.id,
                        status: "transient",
                        message: "The deferred workbook batch was only partially applied and will be retried idempotently.",
                        conflict: { workbooks: committed.workbooks },
                    });
                }
                return;
            }
            for (const item of staged) {
                const relevant = committed.conflicts.filter((conflict) => conflict.table === item.mutation.table && (conflict.rowIndex !== undefined &&
                    item.selection[SELECTION_INTERNAL].materialized.some((row) => row.provenance.rowIndex === conflict.rowIndex) ||
                    this.conflictKeyMatches(item.definition, item.logicalKey, conflict.key)));
                if (relevant.length > 0 || staged.length === 1) {
                    outcomes.set(item.mutation.id, this.conflict(item.mutation, "The atomic deferred workbook batch failed validation.", { conflicts: relevant.length > 0 ? relevant : committed.conflicts }));
                }
                else {
                    outcomes.set(item.mutation.id, {
                        mutationId: item.mutation.id,
                        status: "transient",
                        message: "Another mutation blocked the atomic workbook batch; this mutation remains queued.",
                        conflict: { conflicts: committed.conflicts },
                    });
                }
            }
        }
        keyFingerprint(definition, value) {
            return canonicalStringify$1(definition.primaryKey.map((field) => value[field]));
        }
        conflictKeyMatches(definition, expected, actual) {
            return definition.primaryKey.every((field) => Object.prototype.hasOwnProperty.call(actual, field)) && this.keyFingerprint(definition, expected) === this.keyFingerprint(definition, actual);
        }
        transient(mutation, error) {
            return {
                mutationId: mutation.id,
                status: "transient",
                message: error instanceof Error ? error.message : String(error),
            };
        }
        applyOne(mutation) {
            var _a, _b, _c;
            try {
                const definition = this.table(mutation.table);
                const source = this.access.definition.sources[definition.source];
                if (source === undefined) {
                    return this.conflict(mutation, `Table ${mutation.table} references unknown source ${definition.source}.`);
                }
                const resolvedSourceId = this.access.resolveSourceId(definition.source);
                if (resolvedSourceId !== mutation.sourceId) {
                    if (source.kind === "active-spreadsheet") {
                        throw new GQueryRuntimeError("SOURCE_UNAVAILABLE", `Deferred mutation ${mutation.id} targets ${mutation.sourceId}, but the active source resolved to ${resolvedSourceId}.`, { details: { expectedSourceId: mutation.sourceId, actualSourceId: resolvedSourceId } });
                    }
                    return this.conflict(mutation, `Deferred mutation source ${mutation.sourceId} does not match configured source ${resolvedSourceId}.`, { expectedSourceId: mutation.sourceId, actualSourceId: resolvedSourceId });
                }
                const logicalKey = this.decodeRecord(definition, mutation.key);
                const selection = this.access.find(mutation.table, logicalKey);
                if (selection.length > 1) {
                    return this.conflict(mutation, "The deferred key resolved to more than one row.");
                }
                const provenance = selection.length === 0
                    ? undefined
                    : (_a = selection[SELECTION_INTERNAL].materialized[0]) === null || _a === void 0 ? void 0 : _a.provenance;
                const decodedValues = this.decodeRecord(definition, (_b = mutation.values) !== null && _b !== void 0 ? _b : {});
                const recoveryAppliedValues = mutation.recoveryAppliedValues === undefined
                    ? undefined
                    : this.decodeRecord(definition, mutation.recoveryAppliedValues);
                if (provenance !== undefined &&
                    recoveryAppliedValues !== undefined &&
                    this.matchesIntendedState(mutation.kind, selection.rows[0], decodedValues)) {
                    return this.committed(mutation);
                }
                if (recoveryAppliedValues !== undefined &&
                    (provenance === undefined ||
                        !this.matchesIntendedState("patch", selection.rows[0], recoveryAppliedValues))) {
                    return this.conflict(mutation, "The physical row no longer matches the confirmed deferred prefix during crash recovery.", { appliedFields: Object.keys(recoveryAppliedValues) });
                }
                if (provenance !== undefined && mutation.expectedVersion !== undefined && mutation.expectedVersion !== null && !Object.is(provenance.version, mutation.expectedVersion)) {
                    if (this.matchesIntendedState(mutation.kind, selection.rows[0], decodedValues)) {
                        return this.committed(mutation);
                    }
                    return this.conflict(mutation, "The expected row version no longer matches.", {
                        expected: mutation.expectedVersion,
                        actual: provenance.version,
                    });
                }
                let result;
                (_c = this.applied) === null || _c === void 0 ? void 0 : _c.assertCanMarkMany(mutation.sourceMutationIds);
                if (mutation.kind === "delete") {
                    if (selection.length === 0)
                        return this.committed(mutation);
                    result = selection.delete();
                }
                else if (mutation.kind === "patch") {
                    if (selection.length === 0)
                        return this.conflict(mutation, "The row no longer exists.");
                    result = selection.update(decodedValues);
                }
                else if (mutation.kind === "upsert") {
                    const values = { ...logicalKey, ...decodedValues };
                    result = selection.length === 0 ? this.access.append(mutation.table, values) : selection.update(values);
                }
                else {
                    const values = { ...logicalKey, ...decodedValues };
                    if (selection.length > 0) {
                        return this.matchesIntendedState(mutation.kind, selection.rows[0], values)
                            ? this.committed(mutation)
                            : this.conflict(mutation, "A different row already exists for the caller-assigned create key.");
                    }
                    result = this.access.append(mutation.table, values);
                }
                if (result.status === "conflicted") {
                    return this.conflict(mutation, "Targeted mutation preflight found a conflict.", { conflicts: result.conflicts });
                }
                return this.committed(mutation);
            }
            catch (error) {
                return {
                    mutationId: mutation.id,
                    status: "transient",
                    message: error instanceof Error ? error.message : String(error),
                };
            }
        }
        table(tableName) {
            const definition = this.access.definition.tables[tableName];
            if (definition === undefined)
                throw new GQueryRuntimeError("INVALID_QUERY", `Deferred journal references unknown table ${tableName}.`);
            return definition;
        }
        decodeRecord(definition, values) {
            var _a;
            const result = {};
            for (const [field, raw] of Object.entries(values)) {
                const column = definition.columns[field];
                if (column === undefined)
                    throw new GQueryRuntimeError("MUTATION_INVALID", `Deferred value references unknown column ${field}.`);
                result[field] = column.decode(decodeCell(raw), {
                    column: field,
                    header: (_a = column.header) !== null && _a !== void 0 ? _a : field,
                });
            }
            return result;
        }
        conflict(mutation, message, conflict = {}) {
            return { mutationId: mutation.id, status: "conflict", message, conflict: { message, ...conflict } };
        }
        forgetApplied(mutationIds) {
            var _a;
            (_a = this.applied) === null || _a === void 0 ? void 0 : _a.forget(mutationIds);
        }
        matchesIntendedState(kind, row, values) {
            if (kind === "delete" || row === undefined)
                return false;
            return Object.entries(values).every(([field, value]) => canonicalStringify$1(row[field]) === canonicalStringify$1(value));
        }
        committed(mutation, recordApplied = true) {
            var _a;
            if (recordApplied)
                (_a = this.applied) === null || _a === void 0 ? void 0 : _a.markMany(mutation.sourceMutationIds);
            return { mutationId: mutation.id, status: "committed" };
        }
    }
    /** Operational facade for the durable journal and five-minute flush handler. */
    class DeferredManager {
        constructor(access, options = {}) {
            var _a;
            this.access = access;
            this.options = options;
            this.namespace = (_a = options.namespace) !== null && _a !== void 0 ? _a : "gq2";
        }
        list() {
            return this.journal().list();
        }
        receipt(idempotencyKey) {
            return this.journal().receipt(idempotencyKey);
        }
        rebuildOverlay() {
            return this.journal().rebuildOverlay();
        }
        flush() {
            var _a, _b;
            const properties = (_a = this.options.appliedReceipts) !== null && _a !== void 0 ? _a : this.defaultProperties();
            const applied = properties === undefined
                ? undefined
                : new AppliedMutationReceiptLedger(properties, {
                    namespace: this.namespace,
                    retainedReceiptLimit: this.options.retainedAppliedReceiptLimit,
                    maximumBytes: this.options.appliedReceiptMaximumBytes,
                    maximumAgeMs: this.options.appliedReceiptMaximumAgeMs,
                });
            const executor = new JournalMutationExecutor(this.access, applied);
            const deadLetters = (_b = this.options.deadLetters) !== null && _b !== void 0 ? _b : new AppsScriptDeadLetterSheet();
            const run = () => this.journal().flush(executor, deadLetters);
            return this.access.withoutDeferredGuard === undefined
                ? run()
                : this.access.withoutDeferredGuard(run);
        }
        journal() {
            if (this.options.journal === undefined) {
                throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "Durable deferred delivery is not configured.");
            }
            return this.options.journal;
        }
        defaultProperties() {
            try {
                return new AppsScriptPropertyStore(PropertiesService.getScriptProperties());
            }
            catch {
                return undefined;
            }
        }
    }

    /** Public generation rotation surface. It never reads cache payloads or executes a table query. */
    class CacheInvalidationManager {
        constructor(options) {
            this.options = options;
        }
        invalidateTable(table) {
            const generations = this.requireGenerations();
            const definition = this.table(table);
            return generations.invalidateTable(this.options.resolveSourceId(definition.source), table);
        }
        invalidateRow(table, key) {
            const generations = this.requireGenerations();
            if (generations.invalidateRow === undefined) {
                throw this.unsupported("Row cache invalidation requires a generation store with row-token support.");
            }
            const definition = this.table(table);
            if (definition.primaryKey.length === 0) {
                throw new GQueryRuntimeError("INVALID_QUERY", `Table ${table} has no primary key and cannot have a row generation invalidated.`, { details: { table } });
            }
            const sourceId = this.options.resolveSourceId(definition.source);
            // Current row caches are table snapshots. Rotate the broad dependency first
            // so freshness is preserved even if a custom narrow-row adapter then fails.
            generations.invalidateTable(sourceId, table);
            return generations.invalidateRow(sourceId, table, this.normalizeKey(table, definition.primaryKey, key));
        }
        invalidateTag(tag) {
            const generations = this.requireGenerations();
            if (generations.invalidateTag === undefined) {
                throw this.unsupported("Tag cache invalidation requires a generation store with tag-token support.");
            }
            if (typeof tag !== "string" || tag.trim().length === 0) {
                throw new GQueryRuntimeError("INVALID_QUERY", "Cache invalidation tags must not be empty.");
            }
            const declared = Object.values(this.options.definition.tables).some((table) => { var _a, _b; return ((_b = (_a = table.cache) === null || _a === void 0 ? void 0 : _a.tags) === null || _b === void 0 ? void 0 : _b.includes(tag)) === true; });
            if (!declared) {
                throw new GQueryRuntimeError("INVALID_QUERY", `Cache tag ${tag} is not declared by any table.`, { details: { tag } });
            }
            return generations.invalidateTag(tag);
        }
        table(table) {
            const definition = this.options.definition.tables[table];
            if (definition === undefined) {
                throw new GQueryRuntimeError("INVALID_QUERY", `Unknown table ${String(table)}.`, { details: { table } });
            }
            return definition;
        }
        normalizeKey(table, fields, input) {
            if (fields.length === 1 && (input === null || typeof input !== "object" || input instanceof Date)) {
                return Object.freeze({ [fields[0]]: input });
            }
            if (input === null || typeof input !== "object" || Array.isArray(input) || input instanceof Date) {
                throw new GQueryRuntimeError("INVALID_QUERY", `Composite cache key invalidation for ${table} requires an object.`, { details: { table, fields } });
            }
            const key = {};
            for (const field of fields) {
                if (!Object.prototype.hasOwnProperty.call(input, field)) {
                    throw new GQueryRuntimeError("INVALID_QUERY", `Cache row key for ${table} is missing ${field}.`, { details: { table, field, fields } });
                }
                key[field] = input[field];
            }
            return Object.freeze(key);
        }
        requireGenerations() {
            if (this.options.generations === undefined) {
                throw this.unsupported("Cache invalidation requires a durable generation store.");
            }
            return this.options.generations;
        }
        unsupported(message) {
            return new GQueryRuntimeError("UNSUPPORTED_OPERATION", message);
        }
    }

    function nonNegativeInteger(label, value) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new GQueryRuntimeError("INVALID_QUERY", `${label} must be a non-negative safe integer.`);
        }
        return value;
    }
    function rowFingerprint(row, keys) {
        return canonicalStringify$1(keys.map((key) => row[key]));
    }
    function operationKeys(operation, tableName, definition, requested) {
        const keys = requested !== null && requested !== void 0 ? requested : definition.primaryKey;
        if (keys.length === 0) {
            throw new GQueryRuntimeError("INVALID_QUERY", `${operation}() requires a declared primary or unique key for ${tableName}.`);
        }
        const declared = [definition.primaryKey, ...definition.unique].some((candidate) => candidate.length === keys.length &&
            candidate.every((field, index) => field === keys[index]));
        if (!declared) {
            throw new GQueryRuntimeError("INVALID_QUERY", `${operation}() keys must exactly match a declared primary or unique key for ${tableName}.`, {
                details: {
                    table: tableName,
                    keys,
                    declaredKeys: [definition.primaryKey, ...definition.unique],
                },
            });
        }
        return keys;
    }
    function indexCurrentRows(operation, tableName, rows, keys) {
        const indexed = new Map();
        rows.forEach((row, index) => {
            const fingerprint = rowFingerprint(row, keys);
            const duplicate = indexed.get(fingerprint);
            if (duplicate !== undefined) {
                throw new GQueryRuntimeError("DUPLICATE_KEY", `${operation}() found duplicate existing ${tableName} rows for its selected key.`, {
                    details: {
                        table: tableName,
                        keys,
                        firstIndex: duplicate,
                        duplicateIndex: index,
                    },
                });
            }
            indexed.set(fingerprint, index);
        });
        return indexed;
    }
    function logicalValueEqual(left, right) {
        if (left instanceof Date && right instanceof Date)
            return left.getTime() === right.getTime();
        if (Object.is(left, right))
            return true;
        if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
            try {
                return canonicalStringify$1(left) === canonicalStringify$1(right);
            }
            catch {
                return false;
            }
        }
        return false;
    }
    function rowsEqual(left, right, fields) {
        return fields.every((field) => logicalValueEqual(left[field], right[field]));
    }
    function isThenable(value) {
        return (typeof value === "object" && value !== null) || typeof value === "function"
            ? typeof value.then === "function"
            : false;
    }
    /** An immutable query handle. Every chain method returns a new instance. */
    class Query {
        constructor(database, tableName, plan, localPredicates = []) {
            this.database = database;
            this.tableName = tableName;
            this.plan = plan;
            this.localPredicates = Object.freeze([...localPredicates]);
        }
        next(plan, localPredicates = this.localPredicates) {
            return new Query(this.database, this.tableName, plan, localPredicates);
        }
        all() {
            return this.next(this.plan);
        }
        where(predicate) {
            const normalized = normalizeWhere(predicate);
            return this.next(cloneQueryPlan(this.plan, {
                predicate: combinePredicates(this.plan.predicate, normalized),
            }));
        }
        whereLocal(predicate) {
            if (typeof predicate !== "function")
                throw new TypeError("whereLocal() expects a callback.");
            return this.next(this.plan, [...this.localPredicates, predicate]);
        }
        select(fields) {
            if (fields.length === 0)
                throw new GQueryRuntimeError("INVALID_QUERY", "select() requires at least one field.");
            return this.next(cloneQueryPlan(this.plan, { projection: [...fields] }), this.localPredicates);
        }
        orderBy(field, direction = "asc") {
            return this.next(cloneQueryPlan(this.plan, {
                orderBy: [...this.plan.orderBy, { field, direction }],
            }));
        }
        limit(value) {
            return this.next(cloneQueryPlan(this.plan, { limit: nonNegativeInteger("limit", value) }));
        }
        offset(value) {
            return this.next(cloneQueryPlan(this.plan, { offset: nonNegativeInteger("offset", value) }));
        }
        tail(value) {
            return this.next(cloneQueryPlan(this.plan, { tail: nonNegativeInteger("tail", value) }));
        }
        include(name) {
            const relation = this.database.definition.tables[this.tableName].relations[name];
            if (relation === undefined) {
                throw new GQueryRuntimeError("RELATION_NOT_FOUND", `Table ${this.tableName} has no relation ${name}.`);
            }
            const nextPlan = cloneQueryPlan(this.plan, {
                joins: [...this.plan.joins, {
                        table: relation.target,
                        alias: name,
                        localField: relation.local,
                        foreignField: relation.foreign,
                        kind: "left",
                        cardinality: relation.cardinality,
                        relationName: name,
                    }],
            });
            validateJoinPlan(this.database.definition, nextPlan);
            return this.next(nextPlan);
        }
        join(other, options) {
            var _a, _b;
            const nextPlan = cloneQueryPlan(this.plan, {
                joins: [...this.plan.joins, {
                        table: other.tableName,
                        alias: options.as,
                        localField: options.on.local,
                        foreignField: options.on.foreign,
                        kind: (_a = options.kind) !== null && _a !== void 0 ? _a : "left",
                        cardinality: (_b = options.cardinality) !== null && _b !== void 0 ? _b : "one",
                        select: options.select,
                    }],
            });
            validateJoinPlan(this.database.definition, nextPlan);
            return this.next(nextPlan);
        }
        get() {
            return this.database.materialize(this.database.executor.execute(this.executable()).selection);
        }
        findOne() {
            const result = this.limit(2).get();
            if (result.length !== 1) {
                throw new GQueryRuntimeError("EXPECTED_ONE", `Expected exactly one ${this.tableName} row; received ${result.length}.`, { details: { table: this.tableName, count: result.length } });
            }
            return result;
        }
        maybeOne() {
            const result = this.limit(2).get();
            if (result.length > 1) {
                throw new GQueryRuntimeError("EXPECTED_ONE", `Expected at most one ${this.tableName} row; received ${result.length}.`, { details: { table: this.tableName, count: result.length } });
            }
            return result;
        }
        find(key) {
            const definition = this.database.definition.tables[this.tableName];
            if (definition.primaryKey.length === 0) {
                throw new GQueryRuntimeError("INVALID_QUERY", `Table ${this.tableName} has no primary key.`);
            }
            const predicate = {};
            if (definition.primaryKey.length === 1 && (key === null || typeof key !== "object" || key instanceof Date)) {
                predicate[definition.primaryKey[0]] = key;
            }
            else {
                if (key === null || typeof key !== "object" || Array.isArray(key)) {
                    throw new GQueryRuntimeError("INVALID_QUERY", `Composite key lookup for ${this.tableName} requires an object.`);
                }
                for (const field of definition.primaryKey)
                    predicate[field] = key[field];
            }
            return this.where(predicate).maybeOne();
        }
        count() {
            return this.aggregateSelection().length;
        }
        exists() {
            return this.aggregateSelection(1).length > 0;
        }
        /** Execute aggregates with a key-only output shape; joined rows are still
         * validated for cardinality, but their payload columns are not materialized. */
        aggregateSelection(limit) {
            var _a;
            const definition = this.database.definition.tables[this.tableName];
            const anchor = (_a = definition.primaryKey[0]) !== null && _a !== void 0 ? _a : Object.keys(definition.columns)[0];
            const executable = this.executable();
            const plan = cloneQueryPlan(executable.plan, {
                projection: anchor === undefined ? executable.plan.projection : [anchor],
                orderBy: [],
                joins: executable.plan.joins.map((join) => ({
                    ...join,
                    ...(join.kind === "semi" || join.kind === "anti" ? {} : { select: [] }),
                })),
                ...(limit === undefined ? {} : { limit }),
            });
            return this.database.executor.execute({ ...executable, plan }).selection;
        }
        groupBy(fields) {
            var _a;
            if (fields.length === 0)
                throw new GQueryRuntimeError("INVALID_QUERY", "groupBy() requires at least one field.");
            const result = this.get();
            const groups = new Map();
            for (const row of result.rows) {
                const key = {};
                for (const field of fields)
                    key[field] = row[field];
                const fingerprint = canonicalStringify$1(fields.map((field) => row[field]));
                const group = (_a = groups.get(fingerprint)) !== null && _a !== void 0 ? _a : { key, rows: [] };
                group.rows.push(row);
                groups.set(fingerprint, group);
            }
            return Object.freeze([...groups.values()].map((group) => Object.freeze({
                key: Object.freeze(group.key),
                rows: Object.freeze(group.rows),
                count: group.rows.length,
            })));
        }
        update(patch, options) {
            return this.get().update(patch, options);
        }
        delete(options) {
            return this.get().delete(options);
        }
        explain() {
            return this.database.executor.explain(this.executable());
        }
        executable() {
            return this.database.decorateExecutable({
                plan: this.plan,
                localPredicates: this.localPredicates,
                refresh: () => this.get(),
            });
        }
    }
    class TableHandle extends Query {
        constructor(database, tableName) {
            const definition = database.definition.tables[tableName];
            super(database, tableName, emptyQueryPlan(tableName, definition.source));
        }
        append(row, options = {}) {
            return this.appendMany([row], options);
        }
        appendMany(rows, options = {}) {
            if (options.delivery === "deferred") {
                if (rows.length !== 1) {
                    throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred appendMany() requires exactly one caller-keyed row per idempotency key.");
                }
                return this.database.deferKeyedWrite(this.tableName, rows[0], "create", options);
            }
            return this.database.appendRows(this.tableName, rows);
        }
        upsertMany(incoming, options = {}) {
            if (options.delivery === "deferred") {
                if (incoming.length !== 1) {
                    throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred upsertMany() requires exactly one caller-keyed row per idempotency key.");
                }
                const definition = this.database.definition.tables[this.tableName];
                const keys = operationKeys("upsertMany", this.tableName, definition, options.keys);
                if (keys.length !== definition.primaryKey.length ||
                    !keys.every((field, index) => field === definition.primaryKey[index])) {
                    throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred upserts must be addressed by the table primary key.");
                }
                const queued = this.database.deferKeyedWrite(this.tableName, incoming[0], "upsert", options);
                return {
                    status: queued.status,
                    inserted: 0,
                    updated: 0,
                    unchanged: 0,
                    conflicted: queued.status === "conflicted" ? 1 : 0,
                    pending: queued.status === "queued" ? 1 : 0,
                    receipt: queued.receipt,
                    workbooks: [],
                    stats: queued.stats,
                };
            }
            return this.database.withParticipatingWriteLock(() => this.upsertManyUnlocked(incoming, options));
        }
        upsertManyUnlocked(incoming, options) {
            const definition = this.database.definition.tables[this.tableName];
            const keys = operationKeys("upsertMany", this.tableName, definition, options.keys);
            const current = this.get();
            const currentByKey = indexCurrentRows("upsertMany", this.tableName, current.rows, keys);
            const incomingByKey = new Map();
            for (const row of incoming) {
                const fingerprint = rowFingerprint(row, keys);
                if (incomingByKey.has(fingerprint))
                    throw new GQueryRuntimeError("DUPLICATE_KEY", "upsertMany input contains duplicate keys.");
                incomingByKey.set(fingerprint, row);
            }
            const updates = new Map();
            const inserts = [];
            let unchanged = 0;
            const fields = Object.keys(definition.columns);
            for (const [fingerprint, row] of incomingByKey) {
                const currentIndex = currentByKey.get(fingerprint);
                if (currentIndex === undefined)
                    inserts.push(row);
                else if (rowsEqual(current.rows[currentIndex], row, fields))
                    unchanged += 1;
                else
                    updates.set(fingerprint, row);
            }
            const intents = [];
            if (updates.size > 0) {
                const materialized = current[SELECTION_INTERNAL].materialized.filter((item) => updates.has(rowFingerprint(item.value, keys)));
                const subset = new Selection(materialized, current.headers, current.stats, this.database.executor, () => this.get());
                intents.push({
                    id: "upsert:update",
                    kind: "update",
                    selection: subset,
                    patch: (row) => { var _a; return (_a = updates.get(rowFingerprint(row, keys))) !== null && _a !== void 0 ? _a : {}; },
                });
            }
            if (inserts.length > 0) {
                intents.push({
                    id: "upsert:append",
                    kind: "append",
                    tableName: this.tableName,
                    rows: inserts,
                });
            }
            const committed = this.database.commitIntents(intents, [{
                    tableName: this.tableName,
                    rows: current[SELECTION_INTERNAL].materialized,
                }]);
            const succeeded = committed.status === "committed" || committed.status === "queued";
            return {
                status: committed.status,
                inserted: succeeded ? inserts.length : 0,
                updated: succeeded ? updates.size : 0,
                unchanged,
                conflicted: committed.conflicts.length,
                workbooks: committed.workbooks,
                stats: mergeExecutionStats(current.stats, committed.stats),
            };
        }
        sync(incoming, options = {}) {
            return this.database.withParticipatingWriteLock(() => this.syncUnlocked(incoming, options));
        }
        syncUnlocked(incoming, options) {
            var _a, _b, _c, _d, _e;
            const definition = this.database.definition.tables[this.tableName];
            const keys = operationKeys("sync", this.tableName, definition, options.keys);
            const preserve = new Set((_a = options.preserve) !== null && _a !== void 0 ? _a : []);
            const preservedKeys = keys.filter((field) => preserve.has(field));
            if (preservedKeys.length > 0) {
                throw new GQueryRuntimeError("INVALID_QUERY", `sync() cannot preserve key column${preservedKeys.length === 1 ? "" : "s"}: ${preservedKeys.join(", ")}.`, { details: { table: this.tableName, keys, preservedKeys } });
            }
            const current = this.get();
            const currentByKey = indexCurrentRows("sync", this.tableName, current.rows, keys);
            const incomingByKey = new Map();
            for (const input of incoming) {
                const fingerprint = rowFingerprint(input, keys);
                if (incomingByKey.has(fingerprint))
                    throw new GQueryRuntimeError("DUPLICATE_KEY", "sync input contains duplicate keys.");
                const existingIndex = currentByKey.get(fingerprint);
                const next = { ...input };
                if (existingIndex !== undefined) {
                    const existing = current.rows[existingIndex];
                    for (const field of preserve)
                        next[field] = existing[field];
                }
                incomingByKey.set(fingerprint, next);
            }
            const incomingKeys = new Set(incomingByKey.keys());
            const fields = Object.keys(definition.columns);
            const updates = new Map();
            const inserts = [];
            let unchanged = 0;
            for (const [fingerprint, row] of incomingByKey) {
                const existingIndex = currentByKey.get(fingerprint);
                if (existingIndex === undefined)
                    inserts.push(row);
                else if (rowsEqual(current.rows[existingIndex], row, fields))
                    unchanged += 1;
                else
                    updates.set(fingerprint, row);
            }
            const missing = current[SELECTION_INTERNAL].materialized.filter((item) => !incomingKeys.has(rowFingerprint(item.value, keys)));
            const missingPolicy = options.missing;
            const deactivationTargets = (missingPolicy === null || missingPolicy === void 0 ? void 0 : missingPolicy.action) === "deactivate"
                ? missing.filter((item) => !Object.is(item.value[missingPolicy.field], missingPolicy.value))
                : [];
            if ((missingPolicy === null || missingPolicy === void 0 ? void 0 : missingPolicy.action) === "keep" || missingPolicy === undefined) {
                unchanged += missing.length;
            }
            else if (missingPolicy.action === "deactivate") {
                unchanged += missing.length - deactivationTargets.length;
            }
            const intents = [];
            if (updates.size > 0) {
                const materialized = current[SELECTION_INTERNAL].materialized.filter((item) => updates.has(rowFingerprint(item.value, keys)));
                const subset = new Selection(materialized, current.headers, current.stats, this.database.executor, () => this.get());
                intents.push({
                    id: "sync:update",
                    kind: "update",
                    selection: subset,
                    patch: (row) => { var _a; return (_a = updates.get(rowFingerprint(row, keys))) !== null && _a !== void 0 ? _a : {}; },
                });
            }
            if (inserts.length > 0) {
                intents.push({ id: "sync:append", kind: "append", tableName: this.tableName, rows: inserts });
            }
            if (missing.length > 0 && ((_b = options.missing) === null || _b === void 0 ? void 0 : _b.action) === "delete") {
                const subset = new Selection(missing, current.headers, current.stats, this.database.executor, () => this.get());
                intents.push({
                    id: "sync:delete",
                    kind: "delete",
                    selection: subset,
                });
            }
            else if (deactivationTargets.length > 0 && ((_c = options.missing) === null || _c === void 0 ? void 0 : _c.action) === "deactivate") {
                const subset = new Selection(deactivationTargets, current.headers, current.stats, this.database.executor, () => this.get());
                intents.push({
                    id: "sync:deactivate",
                    kind: "update",
                    selection: subset,
                    patch: { [options.missing.field]: options.missing.value },
                });
            }
            const committed = this.database.commitIntents(intents, [{
                    tableName: this.tableName,
                    rows: current[SELECTION_INTERNAL].materialized,
                }]);
            const succeeded = committed.status === "committed" || committed.status === "queued";
            return {
                status: committed.status,
                inserted: succeeded ? inserts.length : 0,
                updated: succeeded ? updates.size : 0,
                unchanged,
                conflicted: committed.conflicts.length,
                workbooks: committed.workbooks,
                deactivated: succeeded && ((_d = options.missing) === null || _d === void 0 ? void 0 : _d.action) === "deactivate" ? deactivationTargets.length : 0,
                deleted: succeeded && ((_e = options.missing) === null || _e === void 0 ? void 0 : _e.action) === "delete" ? missing.length : 0,
                stats: mergeExecutionStats(current.stats, committed.stats),
            };
        }
    }
    class BatchQuery {
        constructor(database, queries) {
            this.database = database;
            this.queries = queries;
        }
        get() {
            this.database.assertTransactionOpen("batch read");
            const executable = {};
            for (const [name, query] of Object.entries(this.queries))
                executable[name] = query.executable();
            const selections = this.database.executor.executeBatch(executable).selections;
            const materialized = {};
            for (const [name, selection] of Object.entries(selections)) {
                materialized[name] = this.database.materialize(selection);
            }
            return materialized;
        }
    }
    class UnitOfWorkContext {
        constructor(executor) {
            this.executor = executor;
            this.intents = [];
            this.overlays = new Map();
            this.deleted = new Set();
            this.stagedUpdates = new Map();
            this.stagedDeletes = new Set();
            this.cancelledIntents = new Set();
            this.virtualRows = new Map();
            this.virtualIdentityByValue = new WeakMap();
            this.constraintSnapshots = new Map();
            this.sequence = 0;
            this.virtualSequence = 0;
            this.state = "open";
        }
        assertOpen(operation) {
            if (this.state === "open")
                return;
            throw new GQueryRuntimeError("MUTATION_INVALID", `The unit of work is closed; ${operation} cannot be performed through its captured transaction or selections.`, { details: { operation, state: this.state } });
        }
        close() {
            this.state = "closed";
        }
        refresh(selection) {
            this.assertOpen("refresh");
            return this.apply(this.executor.refresh(selection));
        }
        update(selection, patch) {
            var _a, _b;
            this.assertOpen("update");
            this.executor.assertNoDeferredOverlayRows(selection[SELECTION_INTERNAL].materialized, "stage a unit-of-work update");
            const id = this.nextId("update");
            const materialized = selection[SELECTION_INTERNAL].materialized.map((item) => {
                var _a;
                const identity = this.identity(item.provenance);
                if (this.deleted.has(identity)) {
                    throw new GQueryRuntimeError("MUTATION_INVALID", "A row deleted earlier in the unit of work cannot be updated.", { details: { identity } });
                }
                const virtual = this.virtualRows.get(identity);
                const baseCurrent = (_a = this.overlays.get(identity)) !== null && _a !== void 0 ? _a : virtual === null || virtual === void 0 ? void 0 : virtual.value;
                const current = (baseCurrent === undefined
                    ? item.value
                    : { ...item.value, ...baseCurrent });
                const mutable = { ...current };
                const returned = typeof patch === "function" ? patch(mutable) : patch;
                const proposed = (typeof patch === "function" && returned === undefined
                    ? mutable
                    : returned);
                // Callback patches commonly return a spread joined row. Persist only
                // actual deltas so unchanged include/join aliases never become mutation
                // columns. Object patches retain their explicit shape and are validated
                // normally by the executor at commit.
                const changes = (typeof patch === "function"
                    ? Object.fromEntries(Object.entries(proposed).filter(([field, value]) => !Object.prototype.hasOwnProperty.call(current, field) ||
                        !logicalValueEqual(current[field], value)))
                    : { ...proposed });
                const value = { ...current, ...changes };
                const relationAliases = new Set(Object.keys(item.provenance.relations));
                const baseSeed = Object.fromEntries(Object.entries(baseCurrent !== null && baseCurrent !== void 0 ? baseCurrent : item.value)
                    .filter(([field]) => !relationAliases.has(field)));
                const baseChanges = Object.fromEntries(Object.entries(changes).filter(([field]) => !relationAliases.has(field)));
                this.overlays.set(identity, {
                    ...baseSeed,
                    ...baseChanges,
                });
                if (virtual !== undefined) {
                    // A staged append has no physical row to preflight. Mutate its private
                    // staging copy so the eventual append contains the latest value.
                    Object.assign(virtual.value, changes);
                }
                else {
                    const existing = this.stagedUpdates.get(identity);
                    if (existing !== undefined) {
                        // Repeated updates to one row collapse into one physical write intent.
                        Object.assign(existing.patch, changes);
                    }
                    else {
                        const stagedSelection = new Selection([item], selection.headers, selection.stats, this, selection[SELECTION_INTERNAL].refresh);
                        // Resolve callback patches exactly once while staging. Commit receives
                        // a serializable per-row patch, so side effects and time/random-based
                        // draft logic cannot run a second time with a different result.
                        const intent = {
                            id,
                            kind: "update",
                            selection: stagedSelection,
                            patch: { ...changes },
                        };
                        this.intents.push(intent);
                        this.stagedUpdates.set(identity, intent);
                    }
                }
                return invalidateChangedRelations({ value, provenance: item.provenance }, Object.keys(baseChanges));
            });
            const after = new Selection(materialized, selection.headers, createExecutionStats(), this, selection[SELECTION_INTERNAL].refresh);
            return {
                status: "queued",
                matchedCount: selection.length,
                changedCount: selection.length,
                changedCells: 0,
                conflicts: [],
                before: selection,
                after,
                stats: createExecutionStats(),
                receipt: {
                    id,
                    idempotencyKey: id,
                    queuedAt: new Date().toISOString(),
                    operation: "update",
                    table: (_b = (_a = selection[SELECTION_INTERNAL].materialized[0]) === null || _a === void 0 ? void 0 : _a.provenance.tableName) !== null && _b !== void 0 ? _b : "unknown",
                    keys: selection[SELECTION_INTERNAL].materialized.map((item) => item.provenance.primaryKey),
                },
            };
        }
        delete(selection) {
            var _a, _b;
            this.assertOpen("delete");
            this.executor.assertNoDeferredOverlayRows(selection[SELECTION_INTERNAL].materialized, "stage a unit-of-work delete");
            const id = this.nextId("delete");
            const physical = [];
            for (const item of selection[SELECTION_INTERNAL].materialized) {
                const identity = this.identity(item.provenance);
                if (this.deleted.has(identity))
                    continue;
                this.deleted.add(identity);
                const update = this.stagedUpdates.get(identity);
                if (update !== undefined) {
                    this.cancelledIntents.add(update);
                    this.stagedUpdates.delete(identity);
                    this.overlays.delete(identity);
                }
                if (this.virtualRows.has(identity))
                    continue;
                if (this.stagedDeletes.has(identity))
                    continue;
                this.stagedDeletes.add(identity);
                physical.push(item);
            }
            if (physical.length > 0) {
                this.intents.push({
                    id,
                    kind: "delete",
                    selection: new Selection(physical, selection.headers, selection.stats, this, selection[SELECTION_INTERNAL].refresh),
                });
            }
            return {
                status: "queued",
                matchedCount: selection.length,
                changedCount: selection.length,
                changedCells: 0,
                conflicts: [],
                before: selection,
                stats: createExecutionStats(),
                receipt: {
                    id,
                    idempotencyKey: id,
                    queuedAt: new Date().toISOString(),
                    operation: "delete",
                    table: (_b = (_a = selection[SELECTION_INTERNAL].materialized[0]) === null || _a === void 0 ? void 0 : _a.provenance.tableName) !== null && _b !== void 0 ? _b : "unknown",
                    keys: selection[SELECTION_INTERNAL].materialized.map((item) => item.provenance.primaryKey),
                },
            };
        }
        append(tableName, rows) {
            this.assertOpen("append");
            const id = this.nextId("append");
            const stagedRows = rows.map((row) => ({ ...row }));
            for (const value of stagedRows) {
                this.virtualSequence += 1;
                const identity = `__gquery_uow__:-1:${-this.virtualSequence}`;
                this.virtualRows.set(identity, { tableName, value });
                this.virtualIdentityByValue.set(value, identity);
            }
            this.intents.push({ id, kind: "append", tableName, rows: stagedRows });
            return {
                status: "queued",
                matchedCount: rows.length,
                changedCount: rows.length,
                changedCells: 0,
                conflicts: [],
                stats: createExecutionStats(),
                receipt: {
                    id,
                    idempotencyKey: id,
                    queuedAt: new Date().toISOString(),
                    operation: "create",
                    table: tableName,
                    keys: [],
                },
            };
        }
        apply(selection) {
            var _a, _b;
            this.assertOpen("read");
            const materialized = this.overlayRows((_b = (_a = selection[SELECTION_INTERNAL].materialized[0]) === null || _a === void 0 ? void 0 : _a.provenance.tableName) !== null && _b !== void 0 ? _b : "", selection[SELECTION_INTERNAL].materialized);
            return new Selection(materialized, selection.headers, selection.stats, this, selection[SELECTION_INTERNAL].refresh);
        }
        overlayRows(tableName, rows) {
            this.assertOpen("read");
            const physical = rows
                .filter((item) => !this.deleted.has(this.identity(item.provenance)))
                .map((item) => {
                var _a;
                return ({
                    value: (_a = this.overlays.get(this.identity(item.provenance))) !== null && _a !== void 0 ? _a : item.value,
                    provenance: item.provenance,
                });
            });
            const virtual = [];
            for (const [identity, item] of this.virtualRows) {
                if (item.tableName !== tableName || this.deleted.has(identity))
                    continue;
                const [, , rowIndex] = identity.split(":");
                virtual.push({
                    value: item.value,
                    provenance: Object.freeze({
                        sourceName: "__unit_of_work__",
                        spreadsheetId: "__gquery_uow__",
                        tableName,
                        sheetName: tableName,
                        sheetId: -1,
                        rowIndex: Number(rowIndex),
                        primaryKey: Object.freeze({}),
                        encodedPrimaryKey: Object.freeze({}),
                        version: undefined,
                        originalEncoded: Object.freeze({}),
                        columnIndexes: Object.freeze({}),
                        headerFingerprint: "__unit_of_work__",
                        readAt: new Date().toISOString(),
                        relations: Object.freeze({}),
                        relationCardinalities: Object.freeze({}),
                    }),
                });
            }
            return [...physical, ...virtual];
        }
        rememberCompleteSnapshot(tableName, rows) {
            this.assertOpen("read");
            this.constraintSnapshots.set(tableName, {
                tableName,
                rows: rows.filter((row) => row.provenance.spreadsheetId !== "__gquery_uow__"),
            });
        }
        commit() {
            this.assertOpen("commit");
            this.state = "committing";
            try {
                const active = this.intents
                    .filter((intent) => !this.cancelledIntents.has(intent))
                    .flatMap((intent) => {
                    if (intent.kind !== "append")
                        return [intent];
                    const rows = intent.rows.filter((row) => {
                        const identity = this.virtualIdentityByValue.get(row);
                        return identity === undefined || !this.deleted.has(identity);
                    });
                    return rows.length === 0 ? [] : [{ ...intent, rows }];
                });
                return this.executor.commitUnitOfWorkWithSnapshots(active, [...this.constraintSnapshots.values()]);
            }
            finally {
                this.state = "closed";
            }
        }
        stageIntents(intents, snapshots = []) {
            this.assertOpen("stage intents");
            for (const snapshot of snapshots) {
                this.constraintSnapshots.set(snapshot.tableName, {
                    tableName: snapshot.tableName,
                    rows: snapshot.rows.filter((row) => row.provenance.spreadsheetId !== "__gquery_uow__"),
                });
            }
            for (const intent of intents) {
                if (intent.kind === "update") {
                    this.update(intent.selection, intent.patch);
                }
                else if (intent.kind === "delete") {
                    this.delete(intent.selection);
                }
                else {
                    this.append(intent.tableName, intent.rows);
                }
            }
        }
        nextId(kind) {
            this.sequence += 1;
            return `uow:${kind}:${this.sequence}`;
        }
        identity(provenance) {
            return `${provenance.spreadsheetId}:${provenance.sheetId}:${provenance.rowIndex}`;
        }
    }
    function nativeLock(kind) {
        var _a;
        if (typeof LockService === "undefined")
            return null;
        const lock = kind === "script"
            ? LockService.getScriptLock()
            : kind === "document"
                ? LockService.getDocumentLock()
                : (_a = LockService.getDocumentLock()) !== null && _a !== void 0 ? _a : LockService.getScriptLock();
        if (lock === null)
            return null;
        return {
            tryAcquire: (timeoutMs) => lock.tryLock(timeoutMs),
            release: () => lock.releaseLock(),
        };
    }
    class GQueryDatabase {
        constructor(definition, options = {}, internals) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
            this.definition = definition;
            let defaultScope;
            let transport = (_a = internals === null || internals === void 0 ? void 0 : internals.transport) !== null && _a !== void 0 ? _a : options.transport;
            if (transport === undefined) {
                defaultScope = new ScopedRetryTransportInvoker(new RetryController(), options.retry);
                transport = new AppsScriptSheetsTransport({ invoker: defaultScope });
            }
            this.transport = transport;
            this.activeResolver = (_b = internals === null || internals === void 0 ? void 0 : internals.resolveActiveSpreadsheetId) !== null && _b !== void 0 ? _b : options.resolveActiveSpreadsheetId;
            let cacheForScope = options.cacheForScope;
            let generations = options.generations;
            let scopeIdentity = options.scopeIdentity;
            let deferredJournal = (_c = internals === null || internals === void 0 ? void 0 : internals.deferredJournal) !== null && _c !== void 0 ? _c : options.deferredJournal;
            let deferredOverlay = (_d = internals === null || internals === void 0 ? void 0 : internals.deferredOverlay) !== null && _d !== void 0 ? _d : options.deferredOverlay;
            const canonicalState = (_f = (_e = internals === null || internals === void 0 ? void 0 : internals.canonicalState) !== null && _e !== void 0 ? _e : options.canonicalState) !== null && _f !== void 0 ? _f : (internals === undefined && options.transport === undefined
                ? new AppsScriptSchemaCanonicalState()
                : new InMemorySchemaCanonicalState());
            if (internals === undefined && options.transport === undefined) {
                const configuredCache = Object.values(definition.tables).some((table) => table.cache !== undefined);
                generations !== null && generations !== void 0 ? generations : (generations = createAppsScriptGenerationStore());
                if (deferredJournal === undefined) {
                    const defaultDeferredOverlay = new ChunkedDeferredOverlay(createAppsScriptChunkedCache({ scope: "script" }));
                    deferredOverlay = defaultDeferredOverlay;
                    deferredJournal = createAppsScriptDeferredJournal({}, defaultDeferredOverlay);
                }
                if (configuredCache) {
                    const caches = new Map();
                    cacheForScope !== null && cacheForScope !== void 0 ? cacheForScope : (cacheForScope = (scope) => {
                        let cache = caches.get(scope);
                        if (cache === undefined) {
                            cache = createAppsScriptChunkedCache({ scope });
                            caches.set(scope, cache);
                        }
                        return cache;
                    });
                    scopeIdentity !== null && scopeIdentity !== void 0 ? scopeIdentity : (scopeIdentity = (scope) => {
                        var _a, _b;
                        if (scope === "user")
                            return Session.getTemporaryActiveUserKey();
                        if (scope === "document")
                            return (_b = (_a = this.activeResolver) === null || _a === void 0 ? void 0 : _a.call(this)) !== null && _b !== void 0 ? _b : SpreadsheetApp.getActiveSpreadsheet().getId();
                        return ScriptApp.getScriptId();
                    });
                }
            }
            if (internals === undefined) {
                const configuredCache = Object.values(definition.tables).some((table) => table.cache !== undefined);
                const injectedCache = options.cache !== undefined || options.cacheForScope !== undefined;
                if (configuredCache && injectedCache && generations === undefined) {
                    throw new GQueryDefinitionError("Injected caches require a durable generation adapter so committed writes cannot leave old entries reachable.");
                }
                const identityScopedCache = Object.values(definition.tables).some((table) => { var _a, _b; return ((_a = table.cache) === null || _a === void 0 ? void 0 : _a.scope) === "document" || ((_b = table.cache) === null || _b === void 0 ? void 0 : _b.scope) === "user"; });
                if (configuredCache && injectedCache && identityScopedCache && scopeIdentity === undefined) {
                    throw new GQueryDefinitionError("Document- and user-scoped injected caches require a scopeIdentity resolver.");
                }
                if (scopeIdentity !== undefined) {
                    const resolveScopeIdentity = scopeIdentity;
                    scopeIdentity = (scope) => {
                        const identity = resolveScopeIdentity(scope);
                        if (scope !== "script" && (identity === null || identity.trim().length === 0)) {
                            throw new GQueryRuntimeError("SOURCE_UNAVAILABLE", `Cache scope ${scope} did not resolve to a non-empty identity.`);
                        }
                        return identity;
                    };
                }
            }
            this.executor = (_g = internals === null || internals === void 0 ? void 0 : internals.executor) !== null && _g !== void 0 ? _g : new GQueryExecutor(definition, {
                ...options,
                transport,
                executionScope: (_h = options.executionScope) !== null && _h !== void 0 ? _h : defaultScope,
                cacheForScope,
                generations,
                scopeIdentity,
                deferredJournal,
                deferredOverlay,
                canonicalState,
            });
            this.generations = (_j = internals === null || internals === void 0 ? void 0 : internals.generations) !== null && _j !== void 0 ? _j : generations;
            this.systemHooks = (_k = internals === null || internals === void 0 ? void 0 : internals.systemHooks) !== null && _k !== void 0 ? _k : options.systemHooks;
            this.deferredJournal = deferredJournal;
            this.deferredDeadLetters = (_l = internals === null || internals === void 0 ? void 0 : internals.deferredDeadLetters) !== null && _l !== void 0 ? _l : options.deferredDeadLetters;
            this.deferredAppliedReceipts = (_m = internals === null || internals === void 0 ? void 0 : internals.deferredAppliedReceipts) !== null && _m !== void 0 ? _m : options.deferredAppliedReceipts;
            this.canonicalState = canonicalState;
            this.deferredOverlay = deferredOverlay;
            this.selectionRuntime = (_o = internals === null || internals === void 0 ? void 0 : internals.selectionRuntime) !== null && _o !== void 0 ? _o : this.executor;
            this.appendOperation = (_p = internals === null || internals === void 0 ? void 0 : internals.append) !== null && _p !== void 0 ? _p : ((tableName, rows) => this.executor.append(tableName, rows));
            const tables = {};
            for (const tableName of Object.keys(definition.tables)) {
                tables[tableName] = new TableHandle(this, tableName);
            }
            this.tables = Object.freeze(tables);
            this.raw = Object.freeze({ values: this.createRawValues(transport, this.activeResolver) });
            this.cache = Object.freeze(new CacheInvalidationManager({
                definition,
                generations: this.generations,
                resolveSourceId: (sourceName) => this.resolveSourceId(sourceName, this.activeResolver),
            }));
            this.schema = new SchemaManager({
                definition,
                transport,
                canonicalState,
                resolveSourceId: (sourceName) => this.resolveSourceId(sourceName, this.activeResolver),
                invalidateStructure: (spreadsheetId) => this.executor.invalidateStructure(spreadsheetId),
                invalidateTable: (spreadsheetId, tableName) => {
                    var _a;
                    (_a = this.generations) === null || _a === void 0 ? void 0 : _a.invalidateTable(spreadsheetId, tableName);
                },
            });
            this.system = new SystemManager({
                definition,
                transport,
                executor: this.executor,
                generations: this.generations,
                resolveSourceId: (sourceName) => this.resolveSourceId(sourceName, this.activeResolver),
            }, this.systemHooks);
            this.deferred = new DeferredManager({
                definition,
                resolveSourceId: (sourceName) => this.resolveSourceId(sourceName, this.activeResolver),
                find: (tableName, key) => {
                    const handle = this.tables[tableName];
                    if (handle === undefined)
                        throw new GQueryRuntimeError("INVALID_QUERY", `Unknown deferred table ${tableName}.`);
                    return this.executor.withoutDeferredOverlay(() => handle.find(key));
                },
                append: (tableName, row) => {
                    const handle = this.tables[tableName];
                    if (handle === undefined)
                        throw new GQueryRuntimeError("INVALID_QUERY", `Unknown deferred table ${tableName}.`);
                    return handle.append(row);
                },
                batchRead: (tableNames) => {
                    const executable = Object.create(null);
                    for (const tableName of new Set(tableNames)) {
                        const handle = this.tables[tableName];
                        if (handle === undefined) {
                            throw new GQueryRuntimeError("INVALID_QUERY", `Unknown deferred table ${tableName}.`);
                        }
                        executable[tableName] = handle.executable();
                    }
                    return this.executor.withoutDeferredOverlay(() => this.executor.withoutReadCache(() => this.executor.executeBatch(executable).selections));
                },
                commitBatch: (intents, snapshots) => this.executor.withoutDeferredOverlay(() => this.executor.withoutReadCache(() => this.executor.commitUnitOfWorkAfterPhysicalRead(intents, snapshots))),
                withWriteLock: (operation) => {
                    const lock = nativeLock("auto");
                    if (lock === null)
                        return operation();
                    if (!lock.tryAcquire(30000)) {
                        throw new GQueryRuntimeError("MUTATION_CONFLICT", "Could not acquire the deferred flush write lock within 30000ms.");
                    }
                    try {
                        return operation();
                    }
                    finally {
                        lock.release();
                    }
                },
                withoutDeferredGuard: (operation) => this.executor.withoutDeferredOverlay(operation),
            }, {
                journal: this.deferredJournal,
                deadLetters: this.deferredDeadLetters,
                appliedReceipts: this.deferredAppliedReceipts,
            });
        }
        batch(queries) {
            return new BatchQuery(this, Object.freeze({ ...queries }));
        }
        /** Internal lifecycle gate shared by transaction-backed handles. */
        assertTransactionOpen(operation) {
            if (this.selectionRuntime instanceof UnitOfWorkContext) {
                this.selectionRuntime.assertOpen(operation);
            }
        }
        decorateExecutable(query) {
            if (!(this.selectionRuntime instanceof UnitOfWorkContext))
                return query;
            this.assertTransactionOpen("read");
            const capturesCompleteBase = query.plan.predicate === undefined &&
                query.localPredicates.length === 0 &&
                query.plan.limit === undefined &&
                query.plan.offset === undefined &&
                query.plan.tail === undefined;
            return {
                ...query,
                overlayRows: (tableName, rows) => {
                    if (!(this.selectionRuntime instanceof UnitOfWorkContext))
                        return rows;
                    if (capturesCompleteBase && tableName === query.plan.table) {
                        this.selectionRuntime.rememberCompleteSnapshot(tableName, rows);
                    }
                    return this.selectionRuntime.overlayRows(tableName, rows);
                },
            };
        }
        materialize(selection) {
            if (this.selectionRuntime === this.executor)
                return selection;
            if (this.selectionRuntime instanceof UnitOfWorkContext) {
                this.selectionRuntime.assertOpen("read");
            }
            return new Selection(selection[SELECTION_INTERNAL].materialized, selection.headers, selection.stats, this.selectionRuntime, selection[SELECTION_INTERNAL].refresh);
        }
        appendRows(tableName, rows) {
            if (this.selectionRuntime instanceof UnitOfWorkContext) {
                this.selectionRuntime.assertOpen("append");
            }
            return this.appendOperation(tableName, rows);
        }
        deferKeyedWrite(tableName, row, kind, options) {
            if (this.selectionRuntime instanceof UnitOfWorkContext) {
                this.selectionRuntime.assertOpen("queue a deferred write");
                throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred delivery cannot be staged inside unitOfWork().");
            }
            return this.executor.deferKeyedWrite(tableName, row, kind, options);
        }
        commitIntents(intents, constraintSnapshots = []) {
            if (this.selectionRuntime instanceof UnitOfWorkContext) {
                this.selectionRuntime.assertOpen("stage intents");
                this.selectionRuntime.stageIntents(intents, constraintSnapshots);
                return {
                    status: "queued",
                    conflicts: [],
                    workbooks: [],
                    stats: createExecutionStats(),
                };
            }
            return this.executor.commitUnitOfWorkWithSnapshots(intents, constraintSnapshots);
        }
        /**
         * Serialize read-modify-write helpers with the same participating-writer lock
         * used by units of work. Transaction-backed handles already run under their
         * outer lock and therefore execute directly.
         */
        withParticipatingWriteLock(operation, timeoutMs = 30000) {
            if (this.selectionRuntime instanceof UnitOfWorkContext) {
                this.selectionRuntime.assertOpen("run a read-modify-write operation");
                return operation();
            }
            const lock = nativeLock("auto");
            if (lock === null)
                return operation();
            if (!lock.tryAcquire(timeoutMs)) {
                throw new GQueryRuntimeError("MUTATION_CONFLICT", `Could not acquire the participating-writer lock within ${timeoutMs}ms.`);
            }
            try {
                return operation();
            }
            finally {
                lock.release();
            }
        }
        unitOfWork(optionsOrCallback, maybeCallback) {
            var _a, _b;
            if (this.selectionRuntime instanceof UnitOfWorkContext) {
                this.selectionRuntime.assertOpen("start a nested unit of work");
                throw new GQueryRuntimeError("MUTATION_INVALID", "Nested units of work are not supported.");
            }
            const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
            const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
            if (callback === undefined)
                throw new TypeError("unitOfWork() requires a callback.");
            const timeoutMs = (_a = options.timeoutMs) !== null && _a !== void 0 ? _a : 30000;
            const lock = typeof options.lock === "object"
                ? options.lock
                : nativeLock((_b = options.lock) !== null && _b !== void 0 ? _b : "auto");
            const lockStartedAt = Date.now();
            if (lock !== null && !lock.tryAcquire(timeoutMs)) {
                throw new GQueryRuntimeError("MUTATION_CONFLICT", `Could not acquire the unit-of-work lock within ${timeoutMs}ms.`);
            }
            const lockWaitMs = Date.now() - lockStartedAt;
            let context;
            try {
                const activeContext = new UnitOfWorkContext(this.executor);
                context = activeContext;
                const transaction = attachTableProperties(new GQueryDatabase(this.definition, {}, {
                    executor: this.executor,
                    transport: this.transport,
                    selectionRuntime: activeContext,
                    append: (tableName, rows) => activeContext.append(tableName, rows),
                    resolveActiveSpreadsheetId: this.activeResolver,
                    generations: this.generations,
                    systemHooks: this.systemHooks,
                    deferredJournal: this.deferredJournal,
                    deferredDeadLetters: this.deferredDeadLetters,
                    deferredAppliedReceipts: this.deferredAppliedReceipts,
                    canonicalState: this.canonicalState,
                    deferredOverlay: this.deferredOverlay,
                }));
                const value = callback(transaction);
                if (isThenable(value)) {
                    throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "unitOfWork() callbacks must complete synchronously and cannot return a Promise or thenable.");
                }
                const committed = activeContext.commit();
                return {
                    ...committed,
                    value,
                    lockWaitMs,
                    stats: { ...committed.stats, lockWaitMs },
                };
            }
            finally {
                context === null || context === void 0 ? void 0 : context.close();
                lock === null || lock === void 0 ? void 0 : lock.release();
            }
        }
        resolveSourceId(sourceName, resolver) {
            var _a;
            if (this.selectionRuntime instanceof UnitOfWorkContext) {
                this.selectionRuntime.assertOpen("resolve a source");
            }
            const source = this.definition.sources[sourceName];
            if (source.kind === "spreadsheet-id")
                return source.spreadsheetId;
            try {
                return (_a = resolver === null || resolver === void 0 ? void 0 : resolver()) !== null && _a !== void 0 ? _a : SpreadsheetApp.getActiveSpreadsheet().getId();
            }
            catch (cause) {
                throw new GQueryRuntimeError("SOURCE_UNAVAILABLE", "The active spreadsheet source is unavailable.", { cause });
            }
        }
        createRawValues(transport, resolver) {
            const api = {
                get: (sourceName, range, readOptions) => transport.get(this.resolveSourceId(sourceName, resolver), range, readOptions),
                batchGet: (sourceName, ranges, readOptions) => transport.batchGet(this.resolveSourceId(sourceName, resolver), ranges, readOptions),
                batchUpdate: (sourceName, updates, writeOptions) => {
                    if (this.selectionRuntime instanceof UnitOfWorkContext) {
                        throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "raw.values writes cannot run inside unitOfWork(); use typed staged mutations.");
                    }
                    return transport.batchUpdate(this.resolveSourceId(sourceName, resolver), updates, writeOptions);
                },
                atomicBatchUpdate: (sourceName, mutations) => {
                    if (this.selectionRuntime instanceof UnitOfWorkContext) {
                        throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "raw.values writes cannot run inside unitOfWork(); use typed staged mutations.");
                    }
                    transport.atomicBatchUpdate(this.resolveSourceId(sourceName, resolver), mutations);
                },
            };
            return Object.freeze(api);
        }
    }
    /** Create lazy typed table handles without opening any spreadsheet. */
    function createGQuery(definition, options = {}) {
        return attachTableProperties(new GQueryDatabase(definition, options));
    }
    function attachTableProperties(database) {
        const definition = database.definition;
        for (const tableName of Object.keys(definition.tables)) {
            if (isReservedTablePropertyName(tableName) || tableName in database) {
                throw new GQueryRuntimeError("INVALID_QUERY", `Table name ${tableName} is reserved. Use a different schema property name.`);
            }
            Object.defineProperty(database, tableName, {
                value: database.tables[tableName],
                enumerable: true,
                configurable: false,
                writable: false,
            });
        }
        return database;
    }

    var index = /*#__PURE__*/Object.freeze({
        __proto__: null,
        AmbiguousCommitError: AmbiguousCommitError,
        ApiFailure: ApiFailure,
        AppliedMutationReceiptLedger: AppliedMutationReceiptLedger,
        AppliedReceiptCapacityError: AppliedReceiptCapacityError,
        AppsScriptCacheStore: AppsScriptCacheStore,
        AppsScriptGzipBase64Codec: AppsScriptGzipBase64Codec,
        AppsScriptLock: AppsScriptLock,
        AppsScriptPropertyStore: AppsScriptPropertyStore,
        AppsScriptSha256Hash: AppsScriptSha256Hash,
        AppsScriptTriggerPlatform: AppsScriptTriggerPlatform,
        ChunkedCache: ChunkedCache,
        ChunkedDeferredOverlay: ChunkedDeferredOverlay,
        DEFERRED_DEAD_LETTER_ACTOR_HEADER: DEFERRED_DEAD_LETTER_ACTOR_HEADER,
        DEFERRED_DEAD_LETTER_BASE_HEADERS: DEFERRED_DEAD_LETTER_BASE_HEADERS,
        DeadlineExceededError: DeadlineExceededError,
        DeferredJournal: DeferredJournal,
        DeferredMutationTooLargeError: DeferredMutationTooLargeError,
        ExecutionBudget: ExecutionBudget,
        Fnv1aHash: Fnv1aHash,
        GQueryV2Error: GQueryV2Error,
        GenerationTokenStore: GenerationTokenStore,
        IdempotencyConflictError: IdempotencyConflictError,
        JournalCapacityError: JournalCapacityError,
        JournalCorruptionError: JournalCorruptionError,
        JournalFlushLeaseLostError: JournalFlushLeaseLostError,
        JournalLockTimeoutError: JournalLockTimeoutError,
        PlainTextCacheCodec: PlainTextCacheCodec,
        RequestPayloadTooLargeError: RequestPayloadTooLargeError,
        RetryController: RetryController,
        RetryExhaustedError: RetryExhaustedError,
        RetryTransportInvoker: RetryTransportInvoker,
        ScopedRetryTransportInvoker: ScopedRetryTransportInvoker,
        SystemEventCoordinator: SystemEventCoordinator,
        TriggerReconciler: TriggerReconciler,
        appsScriptSleeper: appsScriptSleeper,
        buildQueryCacheKey: buildQueryCacheKey,
        canonicalStringify: canonicalStringify,
        coalesceDeferredMutations: coalesceDeferredMutations,
        createAppsScriptChunkedCache: createAppsScriptChunkedCache,
        createAppsScriptDeferredJournal: createAppsScriptDeferredJournal,
        createAppsScriptGenerationStore: createAppsScriptGenerationStore,
        createAppsScriptTriggerReconciler: createAppsScriptTriggerReconciler,
        hashCanonical: hashCanonical,
        mathRandomSource: mathRandomSource,
        normalizeApiFailure: normalizeApiFailure,
        systemClock: systemClock,
        withLock: withLock
    });

    exports.ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT = ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT;
    exports.AppsScriptDeadLetterSheet = AppsScriptDeadLetterSheet;
    exports.AppsScriptManualEditHooks = AppsScriptManualEditHooks;
    exports.AppsScriptSchemaCanonicalModeAdapter = AppsScriptSchemaCanonicalModeAdapter;
    exports.AppsScriptSchemaCanonicalState = AppsScriptSchemaCanonicalState;
    exports.AppsScriptSchemaMigrationAdapter = AppsScriptSchemaMigrationAdapter;
    exports.AppsScriptSheetsTransport = AppsScriptSheetsTransport;
    exports.BLANK_CELL = BLANK_CELL;
    exports.BatchQuery = BatchQuery;
    exports.CacheInvalidationManager = CacheInvalidationManager;
    exports.DeferredManager = DeferredManager;
    exports.GQueryCodecError = GQueryCodecError;
    exports.GQueryDatabase = GQueryDatabase;
    exports.GQueryDefinitionError = GQueryDefinitionError;
    exports.GQueryError = GQueryError;
    exports.GQueryExecutor = GQueryExecutor;
    exports.GQueryRuntimeError = GQueryRuntimeError;
    exports.InMemorySchemaCanonicalState = InMemorySchemaCanonicalState;
    exports.InMemorySheetsTransport = InMemorySheetsTransport;
    exports.LEGACY_NO_MATCH = LEGACY_NO_MATCH;
    exports.Query = Query;
    exports.SELECTION_INTERNAL = SELECTION_INTERNAL;
    exports.SchemaManager = SchemaManager;
    exports.Selection = Selection;
    exports.SystemManager = SystemManager;
    exports.TableHandle = TableHandle;
    exports.assertAtomicBatchPayloadSize = assertAtomicBatchPayloadSize;
    exports.assertSheetCellInput = assertSheetCellInput;
    exports.assertSheetCellValue = assertSheetCellValue;
    exports.atomicMutationToSheetsRequest = atomicMutationToSheetsRequest;
    exports.belongsTo = belongsTo;
    exports.boolean = booleanColumn;
    exports.booleanColumn = booleanColumn;
    exports.canonicalStringify = canonicalStringify$1;
    exports.cellRange = cellRange;
    exports.cloneProvenance = cloneProvenance;
    exports.cloneQueryPlan = cloneQueryPlan;
    exports.cloneRawMatrix = cloneRawMatrix;
    exports.cloneSheetInputMatrix = cloneSheetInputMatrix;
    exports.columnIndexToLetter = columnIndexToLetter;
    exports.columnLetterToIndex = columnLetterToIndex;
    exports.combinePredicates = combinePredicates;
    exports.compactCellUpdates = compactCellUpdates;
    exports.compactRowDeletes = compactRowDeletes;
    exports.createExecutionStats = createExecutionStats;
    exports.createGQuery = createGQuery;
    exports.date = date;
    exports.datetime = datetime;
    exports.decimal = decimal;
    exports.defineDatabase = defineDatabase;
    exports.emptyQueryPlan = emptyQueryPlan;
    exports.encodeAtomicExtendedValue = encodeAtomicExtendedValue;
    exports.encodeAtomicRows = encodeAtomicRows;
    exports.encodeRawCell = encodeRawCell;
    exports.encodeRawExtendedValue = encodeRawExtendedValue;
    exports.encodeRawRows = encodeRawRows;
    exports.enumeration = enumeration;
    exports.evaluatePredicate = evaluatePredicate;
    exports.formula = formula;
    exports.hasMany = hasMany;
    exports.hasOne = hasOne;
    exports.hashCanonical = hashCanonical$1;
    exports.identifier = identifier;
    exports.infrastructure = index;
    exports.integer = integer;
    exports.invalidateChangedRelations = invalidateChangedRelations;
    exports.isColumnDefinition = isColumnDefinition;
    exports.isDatabaseDefinition = isDatabaseDefinition;
    exports.isFormulaCell = isFormulaCell;
    exports.isTableDefinition = isTableDefinition;
    exports.json = json;
    exports.mergeExecutionStats = mergeExecutionStats;
    exports.normalizeReturnedMatrix = normalizeReturnedMatrix;
    exports.normalizeWhere = normalizeWhere;
    exports.nullable = nullable;
    exports.number = number;
    exports.optional = optional;
    exports.parseA1Range = parseA1Range;
    exports.quoteSheetName = quoteSheetName;
    exports.selectionProvenance = selectionProvenance;
    exports.sheetNameFromRange = sheetNameFromRange;
    exports.sheetRange = sheetRange;
    exports.source = source;
    exports.strictCanonicalPropertyKey = strictCanonicalPropertyKey;
    exports.structured = structured;
    exports.table = table;
    exports.text = text;
    exports.utf8ByteLength = utf8ByteLength$1;
    exports.withBlankPolicy = withBlankPolicy;
    exports.withDefault = withDefault;

    return Object.assign(exports.createGQuery, exports);

})({});
