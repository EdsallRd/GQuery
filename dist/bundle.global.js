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
                        for (const decoder of tryLegacyDecoders ? legacyDecoders : []) {
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
            encode: (value, context = {}) => transform(value, "encode", context),
            decode: (value, context = {}) => transform(value, "decode", context),
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
        var _a;
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
    }
    function table(config) {
        var _a, _b, _c, _d, _e;
        if (config.source.trim().length === 0) {
            throw new GQueryDefinitionError("Table source name must not be empty.");
        }
        if (config.sheet.trim().length === 0) {
            throw new GQueryDefinitionError("Table sheet name must not be empty.");
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
                if (operator === "isBlank" && typeof value !== "boolean") {
                    throw new TypeError("$isBlank expects a boolean.");
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
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
            rangesRead: [...((_o = initial.rangesRead) !== null && _o !== void 0 ? _o : [])],
            rangesWritten: [...((_p = initial.rangesWritten) !== null && _p !== void 0 ? _p : [])],
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
        const matrix = cloneSheetInputMatrix(mutation.values, `${mutation.kind}.values`);
        nonEmptyMatrix(matrix, `${mutation.kind}.values`);
        const rows = encodeAtomicRows(matrix);
        if (mutation.kind === "appendRows") {
            return {
                appendCells: {
                    sheetId: mutation.sheetId,
                    rows,
                    fields: "userEnteredValue",
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
                fields: "spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
            }));
            return {
                spreadsheetId: (_a = response === null || response === void 0 ? void 0 : response.spreadsheetId) !== null && _a !== void 0 ? _a : spreadsheetId,
                sheets: ((_b = response === null || response === void 0 ? void 0 : response.sheets) !== null && _b !== void 0 ? _b : []).map(({ properties }) => {
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
            var _a, _b, _c, _d, _e;
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
            const data = updates.map((update) => {
                var _a;
                return ({
                    range: update.range,
                    majorDimension: (_a = update.majorDimension) !== null && _a !== void 0 ? _a : "ROWS",
                    values: cloneRawMatrix(update.values, `values for ${update.range}`),
                });
            });
            const response = this.invoke({
                kind: "batchUpdate",
                operationClass: "idempotent-write",
                spreadsheetId,
                ranges: updates.map(({ range }) => range),
                requestCount: updates.length,
                idempotent: true,
            }, () => {
                var _a;
                return this.service().Spreadsheets.Values.batchUpdate({
                    data,
                    valueInputOption: (_a = options.valueInputOption) !== null && _a !== void 0 ? _a : "RAW",
                    includeValuesInResponse: options.includeValuesInResponse,
                    responseValueRenderOption: options.responseValueRenderOption,
                    responseDateTimeRenderOption: options.responseDateTimeRenderOption,
                }, spreadsheetId);
            });
            return {
                spreadsheetId: (_a = response === null || response === void 0 ? void 0 : response.spreadsheetId) !== null && _a !== void 0 ? _a : spreadsheetId,
                totalUpdatedRows: (_b = response === null || response === void 0 ? void 0 : response.totalUpdatedRows) !== null && _b !== void 0 ? _b : 0,
                totalUpdatedColumns: (_c = response === null || response === void 0 ? void 0 : response.totalUpdatedColumns) !== null && _c !== void 0 ? _c : 0,
                totalUpdatedCells: (_d = response === null || response === void 0 ? void 0 : response.totalUpdatedCells) !== null && _d !== void 0 ? _d : 0,
                totalUpdatedSheets: (_e = response === null || response === void 0 ? void 0 : response.totalUpdatedSheets) !== null && _e !== void 0 ? _e : 0,
                responses: updates.map((update, index) => {
                    var _a, _b;
                    return normalizeUpdate((_a = response === null || response === void 0 ? void 0 : response.responses) === null || _a === void 0 ? void 0 : _a[index], spreadsheetId, update.range, (_b = update.majorDimension) !== null && _b !== void 0 ? _b : "ROWS");
                }),
            };
        }
        atomicBatchUpdate(spreadsheetId, mutations, options = {}) {
            var _a, _b;
            if (mutations.length === 0) {
                return { spreadsheetId, requestCount: 0, replies: [] };
            }
            const requests = mutations.map(atomicMutationToSheetsRequest);
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
                idempotent: mutations.every(({ kind }) => kind === "updateCells"),
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
        var _a, _b, _c, _d, _e;
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
        });
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
            return { headers: this.headers, rows: this.rows };
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
                if (provenances.length > 1)
                    fanoutRequired = true;
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
        return value === undefined || value === null ? BLANK_CELL : value;
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
    function relationFingerprint(row, keys) {
        const values = keys.map((key) => row[key]);
        return values.some((value) => value === null || value === undefined)
            ? null
            : canonicalStringify$1(values);
    }
    function materializedIdentity(item) {
        return `${item.provenance.spreadsheetId}:${item.provenance.sheetId}:${item.provenance.rowIndex}`;
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
            this.headers = new Map();
            this.locators = new Map();
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
        executeBatch(queries) {
            return this.scoped(() => this.executeBatchUnscoped(queries));
        }
        executeBatchUnscoped(queries) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
            const startedAt = Date.now();
            const requestedTables = new Set();
            for (const query of Object.values(queries)) {
                requestedTables.add(query.plan.table);
                for (const join of query.plan.joins)
                    requestedTables.add(join.table);
            }
            const resolved = new Map();
            for (const tableName of requestedTables) {
                resolved.set(tableName, this.resolveTable(tableName));
            }
            const snapshots = new Map();
            const readStats = createExecutionStats();
            const boundedQueries = new Set();
            const queryEntries = Object.entries(queries);
            if (queryEntries.length === 1) {
                const [queryName, query] = queryEntries[0];
                const base = resolved.get(query.plan.table);
                if (base !== undefined) {
                    const bounded = this.tryBoundedRead(query, base);
                    if (bounded !== null) {
                        snapshots.set(base.tableName, bounded.snapshot);
                        Object.assign(readStats, mutableStats(bounded.stats));
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
                const misses = [];
                for (const table of tables) {
                    const cache = this.cacheForTable(table);
                    const cacheKey = cache === null ? null : this.tableCacheKey(table);
                    const cached = cacheKey === null
                        ? { state: "miss" }
                        : (_b = cache === null || cache === void 0 ? void 0 : cache.read(cacheKey)) !== null && _b !== void 0 ? _b : { state: "miss" };
                    if (cached.state === "hit" && ((_c = cached.value) === null || _c === void 0 ? void 0 : _c.version) === 1) {
                        const snapshot = this.parseSnapshot(table, cached.value.values, cached.value.range);
                        snapshots.set(table.tableName, snapshot);
                        readStats.cacheHits += 1;
                        continue;
                    }
                    if (cacheKey !== null)
                        readStats.cacheMisses += 1;
                    misses.push(table);
                }
                if (misses.length === 0)
                    continue;
                const ranges = misses.map((table) => sheetRange(table.definition.sheet));
                const response = this.options.transport.batchGet(spreadsheetId, ranges, {
                    valueRenderOption: misses.some((table) => tableUsesFormula$1(table.definition))
                        ? "FORMULA"
                        : "UNFORMATTED_VALUE",
                    dateTimeRenderOption: "SERIAL_NUMBER",
                });
                readStats.apiCalls += 1;
                for (let index = 0; index < misses.length; index += 1) {
                    const table = misses[index];
                    const values = (_e = (_d = response.valueRanges[index]) === null || _d === void 0 ? void 0 : _d.values) !== null && _e !== void 0 ? _e : [];
                    const snapshot = this.parseSnapshot(table, values, ranges[index]);
                    snapshots.set(table.tableName, snapshot);
                    readStats.cellsRead += snapshot.cellsRead;
                    readStats.bytesRead += snapshot.bytesRead;
                    readStats.rangesRead.push(snapshot.range);
                    const cache = this.cacheForTable(table);
                    const cacheKey = cache === null ? null : this.tableCacheKey(table);
                    if (cacheKey !== null && cache !== null) {
                        cache.put(cacheKey, {
                            version: 1,
                            range: ranges[index],
                            values,
                        }, {
                            ttlSeconds: (_f = table.definition.cache) === null || _f === void 0 ? void 0 : _f.ttlSeconds,
                            jitterSeconds: (_g = table.definition.cache) === null || _g === void 0 ? void 0 : _g.jitterSeconds,
                        });
                    }
                }
            }
            const selections = {};
            const plans = {};
            for (const [name, query] of Object.entries(queries)) {
                const queryStats = cloneStats(readStats);
                let materialized = [...this.requireSnapshot(snapshots, query.plan.table).rows];
                if (query.plan.predicate !== undefined) {
                    materialized = materialized.filter((item) => evaluatePredicate(query.plan.predicate, item.value));
                }
                for (const predicate of query.localPredicates) {
                    materialized = materialized.filter((item) => predicate(item.value));
                }
                for (const join of query.plan.joins) {
                    const target = this.requireSnapshot(snapshots, join.table);
                    const localFields = asArray(join.localField);
                    const foreignFields = asArray(join.foreignField);
                    if (localFields.length !== foreignFields.length) {
                        throw new GQueryRuntimeError("INVALID_QUERY", `Join ${join.alias} key arity does not match.`);
                    }
                    const index = new Map();
                    for (const candidate of target.rows) {
                        const key = keyFingerprint(candidate.value, foreignFields);
                        const matches = (_h = index.get(key)) !== null && _h !== void 0 ? _h : [];
                        matches.push(candidate);
                        index.set(key, matches);
                    }
                    const joined = [];
                    for (const base of materialized) {
                        const key = keyFingerprint(base.value, localFields);
                        const matches = (_j = index.get(key)) !== null && _j !== void 0 ? _j : [];
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
                if (query.plan.projection !== undefined) {
                    materialized = materialized.map((item) => ({
                        value: projectRow(item.value, query.plan.projection),
                        provenance: item.provenance,
                    }));
                }
                queryStats.elapsedMs = Date.now() - startedAt;
                if (!boundedQueries.has(name))
                    queryStats.fullScans += 1;
                const headers = materialized.length > 0
                    ? Object.keys(materialized[0].value)
                    : [...((_k = query.plan.projection) !== null && _k !== void 0 ? _k : Object.keys(this.table(query.plan.table).columns))];
                selections[name] = new Selection(materialized, headers, queryStats, this, query.refresh);
                plans[name] = this.explain(query, boundedQueries.has(name) ? "bounded" : undefined);
            }
            return { selections, plans };
        }
        explain(query, executedMode) {
            const tables = [query.plan.table, ...query.plan.joins.map((join) => join.table)];
            const sourceIds = new Set();
            const steps = [];
            for (const tableName of tables) {
                const definition = this.table(tableName);
                const sourceId = this.sourceIdentity(definition.source);
                sourceIds.add(sourceId);
                steps.push({
                    kind: "range-read",
                    source: sourceId,
                    table: tableName,
                    ranges: [sheetRange(definition.sheet)],
                    columns: Object.keys(definition.columns),
                    detail: "Unbounded table scan; execution batches this range with other tables in the workbook.",
                });
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
            const plannedBounded = executedMode === "bounded" || (executedMode === undefined && this.indexForQuery(query) !== null);
            const warnings = plannedBounded ? [] : [{
                    code: "FULL_SCAN",
                    table: query.plan.table,
                    message: "This query currently requires an unbounded table scan.",
                }];
            if (query.localPredicates.length > 0) {
                warnings.push({
                    code: "LOCAL_FILTER",
                    table: query.plan.table,
                    message: "whereLocal callbacks cannot be persistently fingerprinted or query-cached.",
                });
            }
            return {
                mode: plannedBounded ? "bounded" : "full-scan",
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
            const materialized = selection[SELECTION_INTERNAL].materialized;
            if (materialized.length === 0)
                return this.emptyMutation(selection);
            if (options.delivery === "deferred") {
                return this.deferUpdate(selection, patch, options);
            }
            this.assertSingleMutationTable(materialized);
            const definition = this.table(materialized[0].provenance.tableName);
            if (definition.appendOnly) {
                throw new GQueryRuntimeError("MUTATION_INVALID", `Table ${materialized[0].provenance.tableName} is append-only.`);
            }
            const prepared = [];
            for (const item of materialized) {
                const mutable = { ...item.value };
                let changes;
                if (typeof patch === "function") {
                    const returned = patch(mutable);
                    changes = returned === undefined ? mutable : returned;
                }
                else {
                    changes = patch;
                }
                const changeRecord = changes;
                const unknown = Object.keys(changeRecord).filter((field) => !(field in definition.columns));
                if (unknown.length > 0) {
                    throw new GQueryRuntimeError("MUTATION_INVALID", `Unknown mutation column${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
                }
                const changedKeys = Object.keys(changeRecord).filter((field) => !sameLogical(item.value[field], changeRecord[field]));
                const primaryChanges = changedKeys.filter((field) => definition.primaryKey.includes(field));
                if (primaryChanges.length > 0) {
                    throw new GQueryRuntimeError("MUTATION_INVALID", `Primary key columns cannot be updated in place: ${primaryChanges.join(", ")}.`);
                }
                const cellPatches = [];
                const nextValue = { ...item.value };
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
                    before: item,
                    after: {
                        value: nextValue,
                        provenance: cloneProvenance(item.provenance, {
                            version: nextVersion,
                            originalEncoded: nextEncoded,
                        }),
                    },
                    patches: cellPatches,
                });
            }
            const preflight = this.preflight(materialized);
            if (preflight.conflicts.length > 0) {
                return {
                    status: "conflicted",
                    matchedCount: materialized.length,
                    changedCount: 0,
                    changedCells: 0,
                    conflicts: preflight.conflicts,
                    before: selection,
                    stats: preflight.stats,
                };
            }
            const cellPatches = prepared.flatMap((item) => item.patches);
            const stats = mutableStats(preflight.stats);
            if (cellPatches.length > 0) {
                const bySpreadsheet = this.groupPatchesBySpreadsheet(prepared);
                for (const [spreadsheetId, patches] of bySpreadsheet) {
                    const mutations = compactCellUpdates(patches);
                    this.options.transport.atomicBatchUpdate(spreadsheetId, mutations);
                    stats.apiCalls += 1;
                    stats.cellsWritten += patches.length;
                    stats.bytesWritten += estimateBytes(patches);
                    stats.rangesWritten.push(...mutations.map((mutation) => {
                        var _a, _b;
                        return cellRange(this.sheetName(spreadsheetId, mutation.sheetId), mutation.startRowIndex, mutation.startColumnIndex, mutation.values.length, (_b = (_a = mutation.values[0]) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 1);
                    }));
                }
                this.invalidateMaterialized(materialized);
            }
            const afterMaterialized = prepared.map((item) => item.after);
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
            this.assertSingleMutationTable(materialized);
            const relational = this.planReferentialDelete(materialized);
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
            const mutations = [...updates, ...deletes];
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
                stats: createExecutionStats({ ...prepared.stats, apiCalls: prepared.stats.apiCalls + 1, cellsWritten: changedCells }),
            };
        }
        /** Compile staged operations and commit each workbook in one atomic batch. */
        commitUnitOfWork(intents) {
            return this.scoped(() => this.commitUnitOfWorkUnscoped(intents));
        }
        commitUnitOfWorkUnscoped(intents) {
            var _a, _b, _c, _d, _e, _f;
            const selections = intents
                .filter((intent) => intent.kind !== "append")
                .flatMap((intent) => intent.selection[SELECTION_INTERNAL].materialized);
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
            for (const intent of intents) {
                if (intent.kind === "update") {
                    const materialized = intent.selection[SELECTION_INTERNAL]
                        .materialized;
                    const prepared = this.prepareUpdates(materialized, intent.patch);
                    explicitPreparedUpdates.push(...prepared);
                    for (const item of prepared) {
                        valueOverrides.set(materializedIdentity(item.before), item.after.value);
                    }
                }
                else if (intent.kind === "delete") {
                    explicitDeletes.push(...intent.selection[SELECTION_INTERNAL]
                        .materialized);
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
            const preflightRows = this.uniqueMaterialized([
                ...relational.deletes,
                ...preparedUpdates.map((item) => item.before),
            ]);
            const preflight = preflightRows.length === 0
                ? { conflicts: [], stats: createExecutionStats() }
                : this.preflight(preflightRows);
            if (preflight.conflicts.length > 0) {
                const stats = mutableStats(relational.stats);
                addStats(stats, preflight.stats);
                return { status: "conflicted", conflicts: preflight.conflicts, workbooks: [], stats };
            }
            const byWorkbook = new Map();
            const touched = new Map();
            const stats = mutableStats(relational.stats);
            addStats(stats, preflight.stats);
            for (const [spreadsheetId, patches] of this.groupPatchesBySpreadsheet(preparedUpdates)) {
                const mutations = (_a = byWorkbook.get(spreadsheetId)) !== null && _a !== void 0 ? _a : [];
                mutations.push(...compactCellUpdates(patches));
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
            for (const intent of intents) {
                if (intent.kind === "append") {
                    const prepared = this.prepareAppend(intent.tableName, intent.rows);
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
                    failed = true;
                    receipts.push({ spreadsheetId, status: "failed", requestCount: mutations.length, error });
                }
            }
            const committed = receipts.filter((receipt) => receipt.status === "committed").length;
            return {
                status: failed && committed > 0 ? "partial" : failed ? "partial" : "committed",
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
            var _a, _b;
            return (_b = (_a = this.options.executionScope) === null || _a === void 0 ? void 0 : _a.run(operation)) !== null && _b !== void 0 ? _b : operation();
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
            const afterMaterialized = materialized.map((current) => ({
                value: { ...current.value, ...logical },
                provenance: current.provenance,
            }));
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
                const mutable = { ...item.value };
                const returned = typeof patch === "function" ? patch(mutable) : patch;
                const changes = (typeof patch === "function" && returned === undefined ? mutable : returned);
                const unknown = Object.keys(changes).filter((field) => !(field in definition.columns));
                if (unknown.length > 0)
                    throw new GQueryRuntimeError("MUTATION_INVALID", `Unknown mutation columns: ${unknown.join(", ")}.`);
                const changedKeys = Object.keys(changes).filter((field) => !sameLogical(item.value[field], changes[field]));
                const primaryChanges = changedKeys.filter((field) => definition.primaryKey.includes(field));
                if (primaryChanges.length > 0)
                    throw new GQueryRuntimeError("MUTATION_INVALID", `Primary key columns cannot be updated in place: ${primaryChanges.join(", ")}.`);
                const patches = [];
                const nextValue = { ...item.value };
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
                    before: item,
                    after: {
                        value: nextValue,
                        provenance: cloneProvenance(item.provenance, { version, originalEncoded: nextEncoded }),
                    },
                    patches,
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
                    resolved.set(edge.dependentTable, this.resolveTable(edge.dependentTable));
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
                    valueRenderOption: "UNFORMATTED_VALUE",
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
            const resolved = this.resolveTable(tableName);
            const cacheKey = `${resolved.spreadsheetId}:${resolved.definition.sheet}`;
            let header = this.headers.get(cacheKey);
            const stats = createExecutionStats();
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
            return { resolved, values, stats };
        }
        recordTouched(touched, materialized) {
            var _a;
            for (const item of materialized) {
                const names = (_a = touched.get(item.provenance.spreadsheetId)) !== null && _a !== void 0 ? _a : new Set();
                names.add(item.provenance.tableName);
                touched.set(item.provenance.spreadsheetId, names);
            }
        }
        table(tableName) {
            const table = this.schema.tables[tableName];
            if (table === undefined)
                throw new GQueryRuntimeError("INVALID_QUERY", `Unknown table ${tableName}.`);
            return table;
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
        resolveTable(tableName) {
            const definition = this.table(tableName);
            const spreadsheetId = this.spreadsheetId(definition.source);
            let sheets = this.metadata.get(spreadsheetId);
            if (sheets === undefined) {
                sheets = this.options.transport.getSpreadsheetMetadata(spreadsheetId).sheets;
                this.metadata.set(spreadsheetId, sheets);
            }
            const sheet = sheets.find((candidate) => candidate.title === definition.sheet);
            if (sheet === undefined) {
                throw new GQueryRuntimeError("SHEET_NOT_FOUND", `Table ${tableName} expects sheet ${definition.sheet}, but it does not exist.`, { details: { table: tableName, spreadsheetId, sheet: definition.sheet } });
            }
            return { tableName, definition, sourceName: definition.source, spreadsheetId, sheet };
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
        parseSnapshot(resolved, values, range, physicalRowIndexes, completeSnapshot = true) {
            var _a, _b, _c, _d;
            const header = this.parseHeader(resolved, (_a = values[0]) !== null && _a !== void 0 ? _a : []);
            const rows = [];
            const seenPrimary = new Map();
            const seenUnique = resolved.definition.unique.map(() => new Map());
            for (let dataIndex = 1; dataIndex < values.length; dataIndex += 1) {
                const physical = (_b = values[dataIndex]) !== null && _b !== void 0 ? _b : [];
                if (physical.every((value) => value === null || value === undefined || value === ""))
                    continue;
                const decoded = {};
                const encoded = {};
                for (const [field, column] of Object.entries(resolved.definition.columns)) {
                    const index = header.logicalToPhysical[field];
                    const physicalValue = physical[index];
                    decoded[field] = column.decode(decodeCell$1(physicalValue), {
                        table: resolved.tableName,
                        column: field,
                        header: (_c = column.header) !== null && _c !== void 0 ? _c : field,
                        rowNumber: dataIndex + 1,
                    });
                    encoded[field] = rawCell(physicalValue);
                }
                if (resolved.definition.primaryKey.length > 0) {
                    const fingerprint = keyFingerprint(decoded, resolved.definition.primaryKey);
                    const previous = seenPrimary.get(fingerprint);
                    if (previous !== undefined) {
                        throw new GQueryRuntimeError("DUPLICATE_KEY", `Table ${resolved.tableName} contains duplicate primary key at rows ${previous + 1} and ${dataIndex + 1}.`, { details: { table: resolved.tableName, fingerprint, rows: [previous + 1, dataIndex + 1] } });
                    }
                    seenPrimary.set(fingerprint, dataIndex);
                }
                resolved.definition.unique.forEach((key, uniqueIndex) => {
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
                const physicalRowIndex = (_d = physicalRowIndexes === null || physicalRowIndexes === void 0 ? void 0 : physicalRowIndexes[dataIndex - 1]) !== null && _d !== void 0 ? _d : dataIndex;
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
                });
                rows.push({ value: decoded, provenance });
            }
            this.registerLocators(resolved, rows, completeSnapshot);
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
            const policy = table.definition.cache;
            if (policy === undefined)
                return null;
            return (_d = (_c = (_b = (_a = this.options).cacheForScope) === null || _b === void 0 ? void 0 : _b.call(_a, policy.scope)) !== null && _c !== void 0 ? _c : this.options.cache) !== null && _d !== void 0 ? _d : null;
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
        tryBoundedRead(query, resolved) {
            var _a;
            if (this.cacheForTable(resolved) !== null)
                return null;
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
            let rowIndexes = this.locators.get(locatorKey);
            if (rowIndexes === undefined) {
                rowIndexes = this.scanLocator(resolved, header, indexed.fields, encoded, stats);
                this.locators.set(locatorKey, rowIndexes);
            }
            let loaded = this.loadLocatedRows(resolved, header, indexed.fields, encoded, rowIndexes, stats);
            if (loaded === null) {
                this.locators.delete(locatorKey);
                rowIndexes = this.scanLocator(resolved, header, indexed.fields, encoded, stats);
                this.locators.set(locatorKey, rowIndexes);
                loaded = this.loadLocatedRows(resolved, header, indexed.fields, encoded, rowIndexes, stats);
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
        loadLocatedRows(resolved, header, fields, expected, rowIndexes, stats) {
            if (rowIndexes.length === 0) {
                return this.parseSnapshot(resolved, [header.headers], `${resolved.definition.sheet}:bounded-empty`, [], false);
            }
            const ranges = rowIndexes.map((rowIndex) => cellRange(resolved.definition.sheet, rowIndex, 0, 1, Math.max(1, header.headers.length)));
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
            const rows = response.valueRanges.map((valueRange) => { var _a; return (_a = valueRange.values[0]) !== null && _a !== void 0 ? _a : []; });
            const valid = rows.every((row) => fields.every((field) => sameCell(row[header.logicalToPhysical[field]], expected[field])));
            if (!valid)
                return null;
            return this.parseSnapshot(resolved, [header.headers, ...rows], ranges.join(","), rowIndexes, false);
        }
        locatorKey(resolved, fields, row) {
            return `${resolved.spreadsheetId}:${resolved.tableName}:${fields.join("\u001f")}:${hashCanonical$1(fields.map((field) => row[field]))}`;
        }
        registerLocators(resolved, rows, completeSnapshot) {
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
                    const key = this.locatorKey(resolved, fields, row.value);
                    const current = (_c = this.locators.get(key)) !== null && _c !== void 0 ? _c : [];
                    if (!current.includes(row.provenance.rowIndex)) {
                        this.locators.set(key, Object.freeze([...current, row.provenance.rowIndex].sort((a, b) => a - b)));
                    }
                }
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
            var _a, _b, _c, _d, _e;
            const policy = table.definition.cache;
            if (policy === undefined)
                throw new Error("A cache key requires a table cache policy.");
            const generation = (_b = (_a = this.options.generations) === null || _a === void 0 ? void 0 : _a.current({
                kind: "table",
                sourceId: table.spreadsheetId,
                table: table.tableName,
            })) !== null && _b !== void 0 ? _b : "0";
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
                scopeIdentity: (_e = (_d = (_c = this.options).scopeIdentity) === null || _d === void 0 ? void 0 : _d.call(_c, policy.scope)) !== null && _e !== void 0 ? _e : null,
                generation,
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
        sheetName(spreadsheetId, sheetId) {
            var _a, _b, _c;
            return (_c = (_b = (_a = this.metadata.get(spreadsheetId)) === null || _a === void 0 ? void 0 : _a.find((sheet) => sheet.sheetId === sheetId)) === null || _b === void 0 ? void 0 : _b.title) !== null && _c !== void 0 ? _c : `sheetId:${sheetId}`;
        }
        invalidateMaterialized(materialized) {
            var _a, _b;
            const tables = new Set();
            for (const item of materialized) {
                const identity = `${item.provenance.spreadsheetId}:${item.provenance.tableName}`;
                if (!tables.has(identity)) {
                    tables.add(identity);
                    this.invalidateTable(item.provenance.spreadsheetId, item.provenance.tableName);
                }
                (_b = (_a = this.options.generations) === null || _a === void 0 ? void 0 : _a.invalidateRow) === null || _b === void 0 ? void 0 : _b.call(_a, item.provenance.spreadsheetId, item.provenance.tableName, item.provenance.primaryKey);
            }
        }
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
                (_f = (_e = this.options).onAttemptComplete) === null || _f === void 0 ? void 0 : _f.call(_e, context, result.stats);
                return result.value;
            };
            return this.activeBudget === null ? this.run(execute) : execute();
        }
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

    function decodedBlank(value) {
        return value === undefined || value === null ? BLANK_CELL : value;
    }
    function toSheetValue(value) {
        return value === BLANK_CELL ? null : value;
    }
    function tableUsesFormula(definition) {
        return Object.values(definition.columns).some((column) => column.kind === "formula");
    }
    function key(row, fields) {
        return JSON.stringify(fields.map((field) => row[field]));
    }
    function relationFields(value) {
        return typeof value === "string" ? [value] : value;
    }
    /** Read-only audit plus explicit, backup-gated schema migration. */
    class SchemaManager {
        constructor(access) {
            this.access = access;
        }
        plan() {
            var _a, _b, _c, _d;
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
                        dataRows: Math.max(0, table.values.length - 1),
                        gridColumnCount: table.sheet.columnCount,
                    });
                }
                if (missingHeaders.length > 0)
                    continue;
                const rows = [];
                const primaryKeys = new Map();
                for (let rowIndex = 1; rowIndex < table.values.length; rowIndex += 1) {
                    const physical = (_c = table.values[rowIndex]) !== null && _c !== void 0 ? _c : [];
                    if (physical.every((value) => value === null || value === undefined || value === ""))
                        continue;
                    const row = {};
                    let rowValid = true;
                    for (const [field, column] of Object.entries(table.definition.columns)) {
                        const header = (_d = column.header) !== null && _d !== void 0 ? _d : field;
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
                                column.codec.decode(raw, { table: table.tableName, column: field, header, rowNumber: rowIndex + 1 });
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
                    if (table.definition.primaryKey.length > 0) {
                        const fingerprint = key(row, table.definition.primaryKey);
                        const previous = primaryKeys.get(fingerprint);
                        if (previous !== undefined) {
                            issues.push(this.issue(table, "DUPLICATE_PRIMARY_KEY", "error", `Rows ${previous} and ${rowIndex + 1} share a primary key.`, {
                                row: rowIndex + 1,
                            }));
                        }
                        else {
                            primaryKeys.set(fingerprint, rowIndex + 1);
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
                    const targetKeys = new Set(target.rows.map((row) => key(row, foreign)));
                    for (let index = 0; index < table.rows.length; index += 1) {
                        const fingerprint = key(table.rows[index], local);
                        if (targetKeys.has(fingerprint) || !relation.required)
                            continue;
                        issues.push(this.issue(table.loaded, "BROKEN_RELATION", "error", `Required relation ${relationName} has no ${relation.target} match.`, {
                            row: index + 2,
                        }));
                    }
                }
            }
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
            });
        }
        migrate(options) {
            var _a, _b, _c, _d;
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
            }
            return {
                status: "migrated",
                backups: Object.freeze(backups),
                appliedActions: actions.length,
                plan,
            };
        }
        loadTables(actions, issues) {
            var _a, _b;
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
                for (const systemSheet of ["_gq_meta", "_gq_dead_letters"]) {
                    if (!group.metadata.sheets.some((sheet) => sheet.title === systemSheet)) {
                        actions.push({ kind: "create-system-sheet", spreadsheetId, sheet: systemSheet });
                    }
                }
                const existing = group.entries.filter(([, definition]) => group.metadata.sheets.some((sheet) => sheet.title === definition.sheet));
                const ranges = existing.map(([, definition]) => `'${definition.sheet.replace(/'/g, "''")}'`);
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
            }
            return loaded;
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
    function requestBytes(request) {
        return JSON.stringify(request).length;
    }
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
                    const rows = Array.from({ length: action.dataRows + 1 }, (_, index) => ({
                        values: [{ userEnteredValue: index === 0 ? { stringValue: action.header } : { numberValue: 1 } }],
                    }));
                    requests.push({ updateCells: { range: { sheetId: action.sheetId, startRowIndex: 0, startColumnIndex: action.columnIndex }, rows, fields: "userEnteredValue" } });
                    requests.push({ updateDimensionProperties: {
                            range: { sheetId: action.sheetId, dimension: "COLUMNS", startIndex: action.columnIndex, endIndex: action.columnIndex + 1 },
                            properties: { hiddenByUser: true },
                            fields: "hiddenByUser",
                        } });
                }
                else if (action.kind === "backfill-cell") {
                    const userEnteredValue = encodeAtomicExtendedValue(action.value);
                    requests.push({ updateCells: {
                            range: { sheetId: action.sheetId, startRowIndex: action.rowIndex, startColumnIndex: action.columnIndex },
                            rows: [{ values: [userEnteredValue === undefined ? {} : { userEnteredValue }] }],
                            fields: "userEnteredValue",
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
                        ]
                        : [["ID", "Mutation ID", "Source", "Table", "Key", "Conflict", "Moved At"]];
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
    /** Reconciles only handlers named by the configuration and leaves unrelated project triggers alone. */
    class TriggerReconciler {
        constructor(platform) {
            this.platform = platform;
        }
        reconcile(configuration) {
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
            const managedHandlers = new Set(desired.map((spec) => spec.handler));
            const kept = [];
            const used = new Set();
            for (const spec of desired) {
                const match = installed.find((candidate) => !used.has(candidate.id) && sameTrigger(candidate, spec));
                if (match !== undefined) {
                    kept.push(match);
                    used.add(match.id);
                }
            }
            const removed = installed.filter((candidate) => managedHandlers.has(candidate.handler) && !used.has(candidate.id));
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
                    return { ...stored.spec, id };
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
            return { ...spec, id };
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
            var _a, _b, _c;
            const table = this.tables.find((candidate) => candidate.sourceId === event.sourceId && candidate.sheetId === event.sheetId);
            if (table === undefined)
                return { invalidatedTables: [], invalidatedRows: 0 };
            const keys = (_c = (_b = (_a = this.hooks).onRowsEdited) === null || _b === void 0 ? void 0 : _b.call(_a, table, event)) !== null && _c !== void 0 ? _c : [];
            this.generations.invalidateTable(table.sourceId, table.table);
            for (const key of keys)
                this.generations.invalidateRow(table.sourceId, table.table, key);
            return { invalidatedTables: [table.table], invalidatedRows: keys.length };
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
            if (versionHeader !== undefined) {
                const versionIndex = headers.indexOf(versionHeader);
                if (versionIndex < 0) {
                    throw new GQueryRuntimeError("MIGRATION_REQUIRED", `Manual edit handling requires version header ${versionHeader} on ${definition.sheet}.`);
                }
                const range = sheet.getRange(startRow, versionIndex + 1, rowCount, 1);
                const current = range.getValues();
                range.setValues(current.map(([value]) => [typeof value === "number" && Number.isFinite(value) ? value + 1 : 1]));
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
            const min = Math.min(...indexes);
            const max = Math.max(...indexes);
            const values = sheet.getRange(startRow, min + 1, rowCount, max - min + 1).getValues();
            return values.map((row, offset) => {
                const result = {};
                definition.primaryKey.forEach((field, index) => {
                    var _a;
                    const column = definition.columns[field];
                    const raw = row[indexes[index] - min];
                    result[field] = column.decode(raw === "" || raw === null || raw === undefined ? BLANK_CELL : raw, {
                        table: table.table,
                        column: field,
                        header: (_a = column.header) !== null && _a !== void 0 ? _a : field,
                        rowNumber: startRow + offset,
                    });
                });
                return result;
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
            var _a;
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
                const values = group.map((record) => [
                    record.id,
                    record.mutation.id,
                    record.mutation.sourceId,
                    record.mutation.table,
                    JSON.stringify(record.mutation.key),
                    JSON.stringify(record.conflict),
                    new Date(record.movedAtMs).toISOString(),
                ]);
                sheet.getRange(sheet.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
            }
        }
    }
    class JournalMutationExecutor {
        constructor(access, applied, namespace) {
            this.access = access;
            this.applied = applied;
            this.namespace = namespace;
        }
        apply(mutations) {
            return mutations.map((mutation) => this.applyOne(mutation));
        }
        applyOne(mutation) {
            var _a, _b, _c, _d, _e, _f;
            const receiptKey = `${this.namespace}:deferred-applied:${mutation.id}`;
            if (((_a = this.applied) === null || _a === void 0 ? void 0 : _a.get(receiptKey)) !== null && ((_b = this.applied) === null || _b === void 0 ? void 0 : _b.get(receiptKey)) !== undefined) {
                return { mutationId: mutation.id, status: "committed" };
            }
            try {
                const definition = this.table(mutation.table);
                const logicalKey = this.decodeRecord(definition, mutation.key);
                const selection = this.access.find(mutation.table, logicalKey);
                if (selection.length > 1) {
                    return this.conflict(mutation, "The deferred key resolved to more than one row.");
                }
                const provenance = (_c = selection[SELECTION_INTERNAL].materialized[0]) === null || _c === void 0 ? void 0 : _c.provenance;
                if (provenance !== undefined && mutation.expectedVersion !== undefined && mutation.expectedVersion !== null && !Object.is(provenance.version, mutation.expectedVersion)) {
                    return this.conflict(mutation, "The expected row version no longer matches.", {
                        expected: mutation.expectedVersion,
                        actual: provenance.version,
                    });
                }
                let result;
                if (mutation.kind === "delete") {
                    if (selection.length === 0)
                        return this.committed(mutation, receiptKey);
                    result = selection.delete();
                }
                else if (mutation.kind === "patch") {
                    if (selection.length === 0)
                        return this.conflict(mutation, "The row no longer exists.");
                    result = selection.update(this.decodeRecord(definition, (_d = mutation.values) !== null && _d !== void 0 ? _d : {}));
                }
                else if (mutation.kind === "upsert") {
                    const values = { ...logicalKey, ...this.decodeRecord(definition, (_e = mutation.values) !== null && _e !== void 0 ? _e : {}) };
                    result = selection.length === 0 ? this.access.append(mutation.table, values) : selection.update(values);
                }
                else {
                    if (selection.length > 0)
                        return this.committed(mutation, receiptKey);
                    const values = { ...logicalKey, ...this.decodeRecord(definition, (_f = mutation.values) !== null && _f !== void 0 ? _f : {}) };
                    result = this.access.append(mutation.table, values);
                }
                if (result.status === "conflicted") {
                    return this.conflict(mutation, "Targeted mutation preflight found a conflict.", { conflicts: result.conflicts });
                }
                return this.committed(mutation, receiptKey);
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
        committed(mutation, receiptKey) {
            var _a;
            (_a = this.applied) === null || _a === void 0 ? void 0 : _a.set(receiptKey, new Date().toISOString());
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
            const applied = (_a = this.options.appliedReceipts) !== null && _a !== void 0 ? _a : this.defaultProperties();
            const executor = new JournalMutationExecutor(this.access, applied, this.namespace);
            const deadLetters = (_b = this.options.deadLetters) !== null && _b !== void 0 ? _b : new AppsScriptDeadLetterSheet();
            return this.journal().flush(executor, deadLetters);
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
    class IdempotencyConflictError extends GQueryV2Error {
        constructor(idempotencyKey) {
            super("DEFERRED_CONFLICT", "The idempotency key was already used for a different deferred mutation.", { idempotencyKey });
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
    function compatible(left, right) {
        if (left.sourceId !== right.sourceId ||
            left.table !== right.table ||
            canonicalStringify(left.key) !== canonicalStringify(right.key) ||
            left.expectedVersion !== right.expectedVersion ||
            left.actor !== right.actor) {
            return false;
        }
        return ((left.kind === "patch" && right.kind === "patch") ||
            (left.kind === "upsert" && (right.kind === "upsert" || right.kind === "patch")));
    }
    /** Only semantically compatible adjacent operations are combined; ordering is otherwise preserved. */
    function coalesceDeferredMutations(entries, hasher) {
        var _a, _b;
        const result = [];
        for (const entry of [...entries].sort((left, right) => left.sequence - right.sequence)) {
            const previous = result[result.length - 1];
            if (previous !== undefined && compatible(previous, entry)) {
                const combinedIds = [...previous.sourceMutationIds, entry.id];
                result[result.length - 1] = {
                    ...previous,
                    id: hasher.hash(combinedIds.join("\u0000")),
                    sourceMutationIds: combinedIds,
                    values: { ...((_a = previous.values) !== null && _a !== void 0 ? _a : {}), ...((_b = entry.values) !== null && _b !== void 0 ? _b : {}) },
                };
                continue;
            }
            result.push({
                id: hasher.hash(entry.id),
                sourceMutationIds: [entry.id],
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
            var _a, _b, _c, _d, _e, _f, _g;
            this.dependencies = dependencies;
            this.clock = (_a = dependencies.clock) !== null && _a !== void 0 ? _a : systemClock;
            this.namespace = (_b = options.namespace) !== null && _b !== void 0 ? _b : "gq2";
            this.shardByteLimit = (_c = options.shardByteLimit) !== null && _c !== void 0 ? _c : 8000;
            this.softByteLimit = (_d = options.softByteLimit) !== null && _d !== void 0 ? _d : 400000;
            this.maxMutationBytes = (_e = options.maxMutationBytes) !== null && _e !== void 0 ? _e : 32000;
            this.retainedReceiptLimit = (_f = options.retainedReceiptLimit) !== null && _f !== void 0 ? _f : 256;
            this.lockTimeoutMs = (_g = options.lockTimeoutMs) !== null && _g !== void 0 ? _g : 5000;
            if (!Number.isInteger(this.shardByteLimit) || this.shardByteLimit < 256 || this.shardByteLimit > 8000) {
                throw new RangeError("Deferred journal shards must be between 256 and 8000 bytes.");
            }
            if (!Number.isInteger(this.softByteLimit) || this.softByteLimit < this.shardByteLimit) {
                throw new RangeError("Deferred journal capacity must be at least one shard.");
            }
            if (!Number.isInteger(this.maxMutationBytes) || this.maxMutationBytes < 1) {
                throw new RangeError("Deferred mutation size limit must be a positive integer.");
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
                    version: 1,
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
            const snapshot = this.locked(() => this.load());
            // CacheService may evict early; every flush republishes the authoritative overlay.
            this.publishOverlay(snapshot.entries);
            if (snapshot.entries.length === 0) {
                return { attempted: 0, committed: 0, conflicted: 0, retained: 0, coalesced: 0, errors: [] };
            }
            const coalesced = coalesceDeferredMutations(snapshot.entries, this.dependencies.hasher);
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
            const now = this.clock.now();
            const updated = this.locked(() => {
                const current = this.load();
                const removedIds = new Set();
                const entries = current.entries.flatMap((entry) => {
                    var _a;
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
                const next = {
                    ...current,
                    revision: current.revision + 1,
                    entries,
                    receipts: pruneReceipts(receipts, this.retainedReceiptLimit),
                };
                this.persist(next);
                return next;
            });
            const committed = coalesced
                .filter((_, index) => normalizedOutcomes[index].status === "committed")
                .reduce((count, mutation) => count + mutation.sourceMutationIds.length, 0);
            const conflicted = coalesced
                .filter((_, index) => normalizedOutcomes[index].status === "conflict" &&
                deadLetteredIds.has(normalizedOutcomes[index].mutationId))
                .reduce((count, mutation) => count + mutation.sourceMutationIds.length, 0);
            return {
                attempted: snapshot.entries.length,
                committed,
                conflicted,
                retained: updated.entries.length,
                coalesced: snapshot.entries.length - coalesced.length,
                errors,
            };
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
                if (state.version !== 1 ||
                    !Number.isInteger(state.revision) ||
                    !Number.isInteger(state.nextSequence) ||
                    !Array.isArray(state.entries) ||
                    !Array.isArray(state.receipts) ||
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

    function nonNegativeInteger(label, value) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new GQueryRuntimeError("INVALID_QUERY", `${label} must be a non-negative safe integer.`);
        }
        return value;
    }
    function rowFingerprint(row, keys) {
        return JSON.stringify(keys.map((key) => row[key]));
    }
    function rowsEqual(left, right, fields) {
        return fields.every((field) => {
            const a = left[field];
            const b = right[field];
            if (a instanceof Date && b instanceof Date)
                return a.getTime() === b.getTime();
            if (Object.is(a, b))
                return true;
            if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
                try {
                    return JSON.stringify(a) === JSON.stringify(b);
                }
                catch {
                    return false;
                }
            }
            return false;
        });
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
            return this.next(cloneQueryPlan(this.plan, {
                joins: [...this.plan.joins, {
                        table: relation.target,
                        alias: name,
                        localField: relation.local,
                        foreignField: relation.foreign,
                        kind: "left",
                        cardinality: relation.cardinality,
                        relationName: name,
                    }],
            }));
        }
        join(other, options) {
            var _a, _b;
            if (options.as.length === 0)
                throw new GQueryRuntimeError("INVALID_QUERY", "Join aliases must not be empty.");
            return this.next(cloneQueryPlan(this.plan, {
                joins: [...this.plan.joins, {
                        table: other.tableName,
                        alias: options.as,
                        localField: options.on.local,
                        foreignField: options.on.foreign,
                        kind: (_a = options.kind) !== null && _a !== void 0 ? _a : "left",
                        cardinality: (_b = options.cardinality) !== null && _b !== void 0 ? _b : "one",
                        select: options.select,
                    }],
            }));
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
            return this.get().length;
        }
        exists() {
            return this.limit(1).get().length > 0;
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
                const fingerprint = JSON.stringify(fields.map((field) => row[field]));
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
            return {
                plan: this.plan,
                localPredicates: this.localPredicates,
                refresh: () => this.get(),
            };
        }
    }
    class TableHandle extends Query {
        constructor(database, tableName) {
            const definition = database.definition.tables[tableName];
            super(database, tableName, emptyQueryPlan(tableName, definition.source));
        }
        append(row) {
            return this.appendMany([row]);
        }
        appendMany(rows) {
            return this.database.appendRows(this.tableName, rows);
        }
        upsertMany(incoming, options = {}) {
            var _a;
            const definition = this.database.definition.tables[this.tableName];
            const keys = ((_a = options.keys) !== null && _a !== void 0 ? _a : definition.primaryKey);
            if (keys.length === 0)
                throw new GQueryRuntimeError("INVALID_QUERY", `upsertMany() requires keys for ${this.tableName}.`);
            const current = this.get();
            const currentByKey = new Map(current.rows.map((row, index) => [rowFingerprint(row, keys), index]));
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
            const committed = this.database.executor.commitUnitOfWork(intents);
            const succeeded = committed.status === "committed";
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
            var _a, _b, _c, _d, _e, _f;
            const definition = this.database.definition.tables[this.tableName];
            const keys = ((_a = options.keys) !== null && _a !== void 0 ? _a : definition.primaryKey);
            if (keys.length === 0)
                throw new GQueryRuntimeError("INVALID_QUERY", `sync() requires keys for ${this.tableName}.`);
            const preserve = new Set((_b = options.preserve) !== null && _b !== void 0 ? _b : []);
            const current = this.get();
            const currentByKey = new Map(current.rows.map((row, index) => [rowFingerprint(row, keys), index]));
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
            if (missing.length > 0 && ((_c = options.missing) === null || _c === void 0 ? void 0 : _c.action) === "delete") {
                const subset = new Selection(missing, current.headers, current.stats, this.database.executor, () => this.get());
                intents.push({
                    id: "sync:delete",
                    kind: "delete",
                    selection: subset,
                });
            }
            else if (missing.length > 0 && ((_d = options.missing) === null || _d === void 0 ? void 0 : _d.action) === "deactivate") {
                const subset = new Selection(missing, current.headers, current.stats, this.database.executor, () => this.get());
                intents.push({
                    id: "sync:deactivate",
                    kind: "update",
                    selection: subset,
                    patch: { [options.missing.field]: options.missing.value },
                });
            }
            const committed = this.database.executor.commitUnitOfWork(intents);
            const succeeded = committed.status === "committed";
            return {
                status: committed.status,
                inserted: succeeded ? inserts.length : 0,
                updated: succeeded ? updates.size : 0,
                unchanged,
                conflicted: committed.conflicts.length,
                workbooks: committed.workbooks,
                deactivated: succeeded && ((_e = options.missing) === null || _e === void 0 ? void 0 : _e.action) === "deactivate" ? missing.length : 0,
                deleted: succeeded && ((_f = options.missing) === null || _f === void 0 ? void 0 : _f.action) === "delete" ? missing.length : 0,
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
            this.sequence = 0;
        }
        refresh(selection) {
            return this.apply(this.executor.refresh(selection));
        }
        update(selection, patch) {
            var _a, _b;
            const id = this.nextId("update");
            this.intents.push({
                id,
                kind: "update",
                selection: selection,
                patch: patch,
            });
            const materialized = selection[SELECTION_INTERNAL].materialized.map((item) => {
                const mutable = { ...item.value };
                const returned = typeof patch === "function" ? patch(mutable) : patch;
                const changes = (typeof patch === "function" && returned === undefined ? mutable : returned);
                const value = { ...item.value, ...changes };
                this.overlays.set(this.identity(item.provenance), value);
                return { value, provenance: item.provenance };
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
            const id = this.nextId("delete");
            this.intents.push({
                id,
                kind: "delete",
                selection: selection,
            });
            for (const item of selection[SELECTION_INTERNAL].materialized) {
                this.deleted.add(this.identity(item.provenance));
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
            const id = this.nextId("append");
            this.intents.push({ id, kind: "append", tableName, rows });
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
            const materialized = selection[SELECTION_INTERNAL].materialized
                .filter((item) => !this.deleted.has(this.identity(item.provenance)))
                .map((item) => {
                var _a;
                return ({
                    value: ((_a = this.overlays.get(this.identity(item.provenance))) !== null && _a !== void 0 ? _a : item.value),
                    provenance: item.provenance,
                });
            });
            return new Selection(materialized, selection.headers, selection.stats, this, selection[SELECTION_INTERNAL].refresh);
        }
        commit() {
            return this.executor.commitUnitOfWork(this.intents);
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
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
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
            if (internals === undefined && options.transport === undefined) {
                const configuredCache = Object.values(definition.tables).some((table) => table.cache !== undefined);
                generations !== null && generations !== void 0 ? generations : (generations = createAppsScriptGenerationStore());
                deferredJournal !== null && deferredJournal !== void 0 ? deferredJournal : (deferredJournal = createAppsScriptDeferredJournal());
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
            this.executor = (_d = internals === null || internals === void 0 ? void 0 : internals.executor) !== null && _d !== void 0 ? _d : new GQueryExecutor(definition, {
                ...options,
                transport,
                executionScope: (_e = options.executionScope) !== null && _e !== void 0 ? _e : defaultScope,
                cacheForScope,
                generations,
                scopeIdentity,
                deferredJournal,
            });
            this.generations = (_f = internals === null || internals === void 0 ? void 0 : internals.generations) !== null && _f !== void 0 ? _f : generations;
            this.systemHooks = (_g = internals === null || internals === void 0 ? void 0 : internals.systemHooks) !== null && _g !== void 0 ? _g : options.systemHooks;
            this.deferredJournal = deferredJournal;
            this.deferredDeadLetters = (_h = internals === null || internals === void 0 ? void 0 : internals.deferredDeadLetters) !== null && _h !== void 0 ? _h : options.deferredDeadLetters;
            this.deferredAppliedReceipts = (_j = internals === null || internals === void 0 ? void 0 : internals.deferredAppliedReceipts) !== null && _j !== void 0 ? _j : options.deferredAppliedReceipts;
            this.selectionRuntime = (_k = internals === null || internals === void 0 ? void 0 : internals.selectionRuntime) !== null && _k !== void 0 ? _k : this.executor;
            this.appendOperation = (_l = internals === null || internals === void 0 ? void 0 : internals.append) !== null && _l !== void 0 ? _l : ((tableName, rows) => this.executor.append(tableName, rows));
            const tables = {};
            for (const tableName of Object.keys(definition.tables)) {
                tables[tableName] = new TableHandle(this, tableName);
            }
            this.tables = Object.freeze(tables);
            this.raw = Object.freeze({ values: this.createRawValues(transport, options.resolveActiveSpreadsheetId) });
            this.schema = new SchemaManager({
                definition,
                transport,
                resolveSourceId: (sourceName) => this.resolveSourceId(sourceName, this.activeResolver),
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
                find: (tableName, key) => {
                    const handle = this.tables[tableName];
                    if (handle === undefined)
                        throw new GQueryRuntimeError("INVALID_QUERY", `Unknown deferred table ${tableName}.`);
                    return handle.find(key);
                },
                append: (tableName, row) => {
                    const handle = this.tables[tableName];
                    if (handle === undefined)
                        throw new GQueryRuntimeError("INVALID_QUERY", `Unknown deferred table ${tableName}.`);
                    return handle.append(row);
                },
            }, {
                journal: this.deferredJournal,
                deadLetters: this.deferredDeadLetters,
                appliedReceipts: this.deferredAppliedReceipts,
            });
        }
        batch(queries) {
            return new BatchQuery(this, Object.freeze({ ...queries }));
        }
        materialize(selection) {
            if (this.selectionRuntime === this.executor)
                return selection;
            if (this.selectionRuntime instanceof UnitOfWorkContext)
                return this.selectionRuntime.apply(selection);
            return new Selection(selection[SELECTION_INTERNAL].materialized, selection.headers, selection.stats, this.selectionRuntime, selection[SELECTION_INTERNAL].refresh);
        }
        appendRows(tableName, rows) {
            return this.appendOperation(tableName, rows);
        }
        unitOfWork(optionsOrCallback, maybeCallback) {
            var _a, _b;
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
            try {
                const context = new UnitOfWorkContext(this.executor);
                const transaction = attachTableProperties(new GQueryDatabase(this.definition, {}, {
                    executor: this.executor,
                    transport: this.transport,
                    selectionRuntime: context,
                    append: (tableName, rows) => context.append(tableName, rows),
                    resolveActiveSpreadsheetId: this.activeResolver,
                    generations: this.generations,
                    systemHooks: this.systemHooks,
                    deferredJournal: this.deferredJournal,
                    deferredDeadLetters: this.deferredDeadLetters,
                    deferredAppliedReceipts: this.deferredAppliedReceipts,
                }));
                const value = callback(transaction);
                const committed = context.commit();
                return {
                    ...committed,
                    value,
                    lockWaitMs,
                    stats: { ...committed.stats, lockWaitMs },
                };
            }
            finally {
                lock === null || lock === void 0 ? void 0 : lock.release();
            }
        }
        resolveSourceId(sourceName, resolver) {
            var _a;
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
                batchUpdate: (sourceName, updates, writeOptions) => transport.batchUpdate(this.resolveSourceId(sourceName, resolver), updates, writeOptions),
                atomicBatchUpdate: (sourceName, mutations) => {
                    transport.atomicBatchUpdate(this.resolveSourceId(sourceName, resolver), mutations);
                },
            };
            return Object.freeze(api);
        }
    }
    const RESERVED_PROPERTIES = new Set([
        "definition",
        "executor",
        "tables",
        "raw",
        "batch",
        "unitOfWork",
        "schema",
        "system",
        "deferred",
    ]);
    /** Create lazy typed table handles without opening any spreadsheet. */
    function createGQuery(definition, options = {}) {
        return attachTableProperties(new GQueryDatabase(definition, options));
    }
    function attachTableProperties(database) {
        const definition = database.definition;
        for (const tableName of Object.keys(definition.tables)) {
            if (RESERVED_PROPERTIES.has(tableName)) {
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
        AppsScriptCacheStore: AppsScriptCacheStore,
        AppsScriptGzipBase64Codec: AppsScriptGzipBase64Codec,
        AppsScriptLock: AppsScriptLock,
        AppsScriptPropertyStore: AppsScriptPropertyStore,
        AppsScriptSha256Hash: AppsScriptSha256Hash,
        AppsScriptTriggerPlatform: AppsScriptTriggerPlatform,
        ChunkedCache: ChunkedCache,
        ChunkedDeferredOverlay: ChunkedDeferredOverlay,
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
        JournalLockTimeoutError: JournalLockTimeoutError,
        PlainTextCacheCodec: PlainTextCacheCodec,
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

    exports.AppsScriptManualEditHooks = AppsScriptManualEditHooks;
    exports.AppsScriptSchemaMigrationAdapter = AppsScriptSchemaMigrationAdapter;
    exports.AppsScriptSheetsTransport = AppsScriptSheetsTransport;
    exports.BLANK_CELL = BLANK_CELL;
    exports.BatchQuery = BatchQuery;
    exports.DeferredManager = DeferredManager;
    exports.GQueryCodecError = GQueryCodecError;
    exports.GQueryDatabase = GQueryDatabase;
    exports.GQueryDefinitionError = GQueryDefinitionError;
    exports.GQueryError = GQueryError;
    exports.GQueryExecutor = GQueryExecutor;
    exports.GQueryRuntimeError = GQueryRuntimeError;
    exports.InMemorySheetsTransport = InMemorySheetsTransport;
    exports.LEGACY_NO_MATCH = LEGACY_NO_MATCH;
    exports.Query = Query;
    exports.SELECTION_INTERNAL = SELECTION_INTERNAL;
    exports.SchemaManager = SchemaManager;
    exports.Selection = Selection;
    exports.SystemManager = SystemManager;
    exports.TableHandle = TableHandle;
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
    exports.structured = structured;
    exports.table = table;
    exports.text = text;
    exports.withBlankPolicy = withBlankPolicy;
    exports.withDefault = withDefault;

    return Object.assign(exports.createGQuery, exports);

})({});
