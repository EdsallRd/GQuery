const CACHE_PREFIX = "gquery:v2";
const DEFAULT_HEADER_TTL = 3600;
const DEFAULT_DATA_TTL = 600;
const DEFAULT_QUERY_TTL = 300;
const DEFAULT_CHUNK_SIZE = 50;
const DEFAULT_COMPRESS_THRESHOLD = 50000;
const HARD_VALUE_LIMIT = 100000;
const RAW_PREFIX = "r:";
const GZIP_PREFIX = "g:";
/**
 * Wrapper around Apps Script's CacheService that handles:
 * - chunked storage for payloads above the 100KB per-value limit
 * - gzip compression for large chunks
 * - per-sheet manifests so invalidation can clear every variant key
 *
 * Default-on (constructed alongside every GQuery instance unless explicitly
 * disabled). All methods are no-ops when `enabled` is false, so call sites
 * don't need to branch on whether caching is configured.
 */
class GQueryCache {
    constructor(spreadsheetId, opts = {}) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        this.oversizeWarned = false;
        this.idShort = spreadsheetId.slice(0, 8);
        if (opts === false) {
            this.enabled = false;
            this.scope = "document";
            this.headerTtl = DEFAULT_HEADER_TTL;
            this.dataTtl = DEFAULT_DATA_TTL;
            this.queryTtl = DEFAULT_QUERY_TTL;
            this.chunkSize = DEFAULT_CHUNK_SIZE;
            this.compressThreshold = DEFAULT_COMPRESS_THRESHOLD;
            this.namespace = "";
            return;
        }
        this.enabled = true;
        this.scope = (_a = opts.scope) !== null && _a !== void 0 ? _a : "document";
        this.headerTtl = (_c = (_b = opts.ttl) === null || _b === void 0 ? void 0 : _b.headers) !== null && _c !== void 0 ? _c : DEFAULT_HEADER_TTL;
        this.dataTtl = (_e = (_d = opts.ttl) === null || _d === void 0 ? void 0 : _d.data) !== null && _e !== void 0 ? _e : DEFAULT_DATA_TTL;
        this.queryTtl = (_g = (_f = opts.ttl) === null || _f === void 0 ? void 0 : _f.query) !== null && _g !== void 0 ? _g : DEFAULT_QUERY_TTL;
        this.chunkSize = (_h = opts.chunkSize) !== null && _h !== void 0 ? _h : DEFAULT_CHUNK_SIZE;
        this.compressThreshold = (_j = opts.compressThreshold) !== null && _j !== void 0 ? _j : DEFAULT_COMPRESS_THRESHOLD;
        this.namespace = opts.namespace ? `:${opts.namespace}` : "";
    }
    /**
     * Look up a cached read by sheet + key opts. Returns null on miss
     * (including partial-hit on chunks, which is treated as a miss).
     */
    get(sheetName, opts) {
        if (!this.enabled)
            return null;
        const cache = this.cache();
        if (!cache)
            return null;
        const base = this.baseKey(sheetName, opts);
        const meta = this.readJson(cache.get(`${base}:meta`));
        if (!meta || typeof meta.chunkCount !== "number")
            return null;
        const headersRaw = cache.get(`${base}:headers`);
        if (!headersRaw)
            return null;
        const headers = this.readJson(headersRaw);
        if (!Array.isArray(headers))
            return null;
        if (meta.chunkCount === 0) {
            return { headers, rows: [] };
        }
        const keys = [];
        for (let i = 0; i < meta.chunkCount; i++) {
            keys.push(`${base}:chunk:${i}`);
        }
        const all = cache.getAll(keys);
        if (Object.keys(all).length !== keys.length)
            return null;
        const rows = [];
        for (let i = 0; i < meta.chunkCount; i++) {
            const chunk = this.readJson(all[`${base}:chunk:${i}`]);
            if (!Array.isArray(chunk))
                return null;
            for (const row of chunk)
                rows.push(row);
        }
        return { headers, rows };
    }
    /**
     * Store a read result. Splits rows into chunks of `chunkSize`, gzips
     * any chunk over the compression threshold, and falls back to a no-op
     * (with one warning) when a chunk still exceeds the 100KB CacheService
     * value cap.
     */
    put(sheetName, value, opts) {
        if (!this.enabled)
            return;
        const cache = this.cache();
        if (!cache)
            return;
        const base = this.baseKey(sheetName, opts);
        const chunks = this.splitChunks(value.rows);
        const headersEncoded = this.encode(JSON.stringify(value.headers));
        if (headersEncoded === null) {
            this.warnOversize(`${base}:headers`);
            return;
        }
        const writes = {
            [`${base}:headers`]: headersEncoded,
            [`${base}:meta`]: `${RAW_PREFIX}${JSON.stringify({
                chunkCount: chunks.length,
                totalRows: value.rows.length,
            })}`,
        };
        for (let i = 0; i < chunks.length; i++) {
            const encoded = this.encode(JSON.stringify(chunks[i]));
            if (encoded === null) {
                this.warnOversize(`${base}:chunk:${i}`);
                return;
            }
            writes[`${base}:chunk:${i}`] = encoded;
        }
        cache.putAll(writes, this.dataTtl);
        cache.put(`${base}:headers`, headersEncoded, this.headerTtl);
        this.recordManifest(cache, sheetName, base);
    }
    /**
     * Look up a cached query() result.
     */
    getQuery(sheetName, query) {
        if (!this.enabled)
            return null;
        const cache = this.cache();
        if (!cache)
            return null;
        const base = this.queryBaseKey(sheetName, query);
        const raw = cache.get(`${base}:body`);
        if (!raw)
            return null;
        const decoded = this.decode(raw);
        if (decoded === null)
            return null;
        const parsed = this.readJson(decoded, /*alreadyDecoded*/ true);
        if (!parsed ||
            !Array.isArray(parsed.headers) ||
            !Array.isArray(parsed.rows)) {
            return null;
        }
        return parsed;
    }
    putQuery(sheetName, query, value) {
        if (!this.enabled)
            return;
        const cache = this.cache();
        if (!cache)
            return;
        const base = this.queryBaseKey(sheetName, query);
        const encoded = this.encode(JSON.stringify(value));
        if (encoded === null) {
            this.warnOversize(`${base}:body`);
            return;
        }
        cache.put(`${base}:body`, encoded, this.queryTtl);
        this.recordManifest(cache, sheetName, base);
    }
    /**
     * Remove every cache entry tracked for `sheetName`. Reads the manifest,
     * deletes each base key's variants (headers + meta + chunks + query bodies),
     * then clears the manifest.
     */
    invalidate(sheetName) {
        if (!this.enabled)
            return;
        const cache = this.cache();
        if (!cache)
            return;
        const manifestKey = this.manifestKey(sheetName);
        const manifest = cache.get(manifestKey);
        if (!manifest)
            return;
        let bases = [];
        try {
            bases = JSON.parse(manifest);
        }
        catch {
            bases = [];
        }
        if (!Array.isArray(bases) || bases.length === 0) {
            cache.remove(manifestKey);
            return;
        }
        const toRemove = [manifestKey];
        for (const base of bases) {
            // Read meta to learn how many chunks exist; skip silently on parse errors.
            const metaRaw = cache.get(`${base}:meta`);
            let chunkCount = 0;
            if (metaRaw) {
                const meta = this.readJson(metaRaw);
                if (meta && typeof meta.chunkCount === "number") {
                    chunkCount = meta.chunkCount;
                }
            }
            toRemove.push(`${base}:headers`, `${base}:meta`, `${base}:body`);
            for (let i = 0; i < chunkCount; i++) {
                toRemove.push(`${base}:chunk:${i}`);
            }
        }
        cache.removeAll(toRemove);
    }
    // ---------- internal helpers ----------
    cache() {
        var _a;
        if (typeof CacheService === "undefined")
            return null;
        switch (this.scope) {
            case "script":
                return CacheService.getScriptCache();
            case "user":
                return CacheService.getUserCache();
            case "document":
            default:
                return ((_a = CacheService.getDocumentCache()) !== null && _a !== void 0 ? _a : CacheService.getScriptCache());
        }
    }
    baseKey(sheetName, opts) {
        var _a, _b, _c;
        const range = (_a = opts.range) !== null && _a !== void 0 ? _a : "all";
        const vr = (_b = opts.valueRender) !== null && _b !== void 0 ? _b : "FV";
        const dr = (_c = opts.dateRender) !== null && _c !== void 0 ? _c : "FS";
        return `${CACHE_PREFIX}${this.namespace}:${this.idShort}:${sheetName}:${range}:${vr}:${dr}`;
    }
    queryBaseKey(sheetName, query) {
        // Query keys can be long; hash via a stable digest so we stay under 250 chars.
        const digest = this.shortHash(query);
        return `${CACHE_PREFIX}${this.namespace}:${this.idShort}:${sheetName}:q:${digest}`;
    }
    manifestKey(sheetName) {
        return `${CACHE_PREFIX}${this.namespace}:${this.idShort}:${sheetName}:__manifest`;
    }
    recordManifest(cache, sheetName, base) {
        const manifestKey = this.manifestKey(sheetName);
        const existing = cache.get(manifestKey);
        let bases = [];
        if (existing) {
            try {
                const parsed = JSON.parse(existing);
                if (Array.isArray(parsed))
                    bases = parsed;
            }
            catch {
                // corrupt manifest — overwrite
            }
        }
        if (!bases.includes(base)) {
            bases.push(base);
            cache.put(manifestKey, JSON.stringify(bases), this.headerTtl);
        }
    }
    splitChunks(rows) {
        if (rows.length === 0)
            return [];
        const out = [];
        for (let i = 0; i < rows.length; i += this.chunkSize) {
            out.push(rows.slice(i, i + this.chunkSize));
        }
        return out;
    }
    /**
     * Encode a JSON string for storage. Compresses (gzip + base64) when the
     * input exceeds `compressThreshold`. Returns null if the encoded result
     * would exceed the per-value cache cap.
     */
    encode(json) {
        if (json.length < this.compressThreshold) {
            const out = `${RAW_PREFIX}${json}`;
            if (out.length > HARD_VALUE_LIMIT) {
                return this.compress(json);
            }
            return out;
        }
        return this.compress(json);
    }
    compress(json) {
        if (typeof Utilities === "undefined") {
            const out = `${RAW_PREFIX}${json}`;
            return out.length > HARD_VALUE_LIMIT ? null : out;
        }
        try {
            const blob = Utilities.gzip(Utilities.newBlob(json));
            const b64 = Utilities.base64Encode(blob.getBytes());
            const out = `${GZIP_PREFIX}${b64}`;
            return out.length > HARD_VALUE_LIMIT ? null : out;
        }
        catch {
            const out = `${RAW_PREFIX}${json}`;
            return out.length > HARD_VALUE_LIMIT ? null : out;
        }
    }
    decode(value) {
        if (value.startsWith(RAW_PREFIX))
            return value.slice(RAW_PREFIX.length);
        if (value.startsWith(GZIP_PREFIX)) {
            if (typeof Utilities === "undefined")
                return null;
            try {
                const bytes = Utilities.base64Decode(value.slice(GZIP_PREFIX.length));
                const unzipped = Utilities.ungzip(Utilities.newBlob(bytes));
                return unzipped.getDataAsString();
            }
            catch {
                return null;
            }
        }
        return null;
    }
    /**
     * Read a stored value as JSON. When `alreadyDecoded` is false the input
     * is expected to carry the `r:` / `g:` prefix from `encode()`; otherwise
     * it is parsed directly.
     */
    readJson(value, alreadyDecoded = false) {
        if (value === null || value === undefined)
            return null;
        const json = alreadyDecoded ? value : this.decode(value);
        if (json === null)
            return null;
        try {
            return JSON.parse(json);
        }
        catch {
            return null;
        }
    }
    warnOversize(key) {
        if (this.oversizeWarned)
            return;
        this.oversizeWarned = true;
        if (typeof console !== "undefined" && typeof console.warn === "function") {
            console.warn(`[gquery] cache value for "${key}" exceeds the 100KB CacheService limit even after compression; falling back to no-cache for this read.`);
        }
    }
    /**
     * 32-bit FNV-1a hash, base36-encoded. Stable across runtimes; fine as a
     * cache-key disambiguator (collisions just mean a cache miss).
     */
    shortHash(input) {
        let h = 0x811c9dc5;
        for (let i = 0; i < input.length; i++) {
            h ^= input.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return h.toString(36);
    }
}

/**
 * How values should be rendered in the output
 * @see https://developers.google.com/sheets/api/reference/rest/v4/ValueRenderOption
 */
var ValueRenderOption;
(function (ValueRenderOption) {
    /** Values will be calculated and formatted according to cell formatting */
    ValueRenderOption["FORMATTED_VALUE"] = "FORMATTED_VALUE";
    /** Values will be calculated but not formatted */
    ValueRenderOption["UNFORMATTED_VALUE"] = "UNFORMATTED_VALUE";
    /** Values will not be calculated; formulas will be returned as-is */
    ValueRenderOption["FORMULA"] = "FORMULA";
})(ValueRenderOption || (ValueRenderOption = {}));
/**
 * How dates and times should be rendered in the output
 * @see https://developers.google.com/sheets/api/reference/rest/v4/DateTimeRenderOption
 */
var DateTimeRenderOption;
(function (DateTimeRenderOption) {
    /** Dates and times will be rendered as strings according to cell formatting */
    DateTimeRenderOption["FORMATTED_STRING"] = "FORMATTED_STRING";
    /** Dates and times will be rendered as serial numbers */
    DateTimeRenderOption["SERIAL_NUMBER"] = "SERIAL_NUMBER";
})(DateTimeRenderOption || (DateTimeRenderOption = {}));
/**
 * Thrown when a row fails schema validation.
 */
class GQuerySchemaError extends Error {
    constructor(issues, row) {
        super(`GQuery schema validation failed:\n${issues
            .map((i) => {
            var _a;
            const pathStr = ((_a = i.path) === null || _a === void 0 ? void 0 : _a.length)
                ? i.path.map((p) => (typeof p === "object" ? p.key : p)).join(".")
                : "(root)";
            return `  [${pathStr}] ${i.message}`;
        })
            .join("\n")}\nRow data: ${JSON.stringify(row)}`);
        this.issues = issues;
        this.row = row;
        this.name = "GQuerySchemaError";
    }
}
/**
 * Thrown when a Google API call fails in a non-retryable way (or after
 * retries are exhausted). Carries the operation name, status code, and
 * response body for debugging.
 */
class GQueryApiError extends Error {
    constructor(operation, status, body, cause) {
        super(`GQuery API error during ${operation}` +
            (status !== null ? ` (status ${status})` : "") +
            `: ${body}`);
        this.operation = operation;
        this.status = status;
        this.body = body;
        this.cause = cause;
        this.name = "GQueryApiError";
    }
}

const RETRYABLE_PATTERNS = ["429", "Quota exceeded", "Rate Limit Exceeded"];
function isRateLimitMessage(message) {
    for (const p of RETRYABLE_PATTERNS) {
        if (message.includes(p))
            return true;
    }
    return false;
}
/**
 * Exponential-backoff handler for Google Sheets API calls.
 *
 * Retries on rate-limit / quota errors thrown by the Advanced Sheets service.
 * `urlFetch: true` adds support for `UrlFetchApp.fetch` results: response
 * codes 429/5xx are converted into retries; other non-2xx responses are
 * surfaced as `GQueryApiError`.
 */
function callHandler(fn, retries = 20, options = {}) {
    var _a;
    const operation = (_a = options.operation) !== null && _a !== void 0 ? _a : "sheets-call";
    let attempt = 0;
    while (attempt < retries) {
        try {
            const result = fn();
            // UrlFetchApp.fetch never throws on non-2xx unless muteHttpExceptions
            // is false (the default), but downstream callers usually set it to
            // true so they can inspect headers. Treat retryable status codes as
            // throws and surface the rest as GQueryApiError.
            if (options.urlFetch && isHttpResponse(result)) {
                const code = result.getResponseCode();
                if (code >= 200 && code < 300) {
                    return result;
                }
                const body = safeBody(result);
                if (code === 429 || (code >= 500 && code < 600)) {
                    attempt++;
                    if (attempt >= retries) {
                        throw new GQueryApiError(operation, code, body);
                    }
                    sleep(backoffMs(attempt));
                    continue;
                }
                throw new GQueryApiError(operation, code, body);
            }
            return result;
        }
        catch (error) {
            if (error instanceof GQueryApiError)
                throw error;
            const errorMessage = (error === null || error === void 0 ? void 0 : error.message) || String(error);
            if (isRateLimitMessage(errorMessage)) {
                attempt++;
                if (attempt >= retries) {
                    throw new GQueryApiError(operation, null, `Max retries (${retries}) reached. Last error: ${errorMessage}`, error);
                }
                sleep(backoffMs(attempt));
                continue;
            }
            throw error;
        }
    }
    throw new GQueryApiError(operation, null, "Unexpected state: max retries reached without throwing");
}
function backoffMs(attempt) {
    return Math.min(Math.pow(2, attempt) * 1000 + Math.random() * 1000, 64000);
}
function sleep(ms) {
    if (typeof Utilities !== "undefined" && Utilities.sleep) {
        Utilities.sleep(ms);
    }
}
function isHttpResponse(value) {
    return (!!value &&
        typeof value === "object" &&
        typeof value.getResponseCode === "function" &&
        typeof value.getContentText === "function");
}
function safeBody(response) {
    try {
        const text = response.getContentText();
        return text.length > 500 ? `${text.slice(0, 500)}…` : text;
    }
    catch {
        return "(unreadable response body)";
    }
}

const DATE_PATTERN$1 = /^\d{1,2}\/\d{1,2}\/\d{4}(\s\d{1,2}:\d{1,2}(:\d{1,2})?)?$/;
/**
 * Convert a raw cell value into its parsed form. Single-pass: handles
 * booleans, MM/DD/YYYY dates, and JSON object/array literals. Anything
 * that doesn't match is returned as-is.
 */
function decodeCellValue(raw) {
    if (raw === undefined || raw === null || raw === "")
        return raw;
    if (typeof raw !== "string")
        return raw;
    // Booleans
    if (raw === "true" || raw === "TRUE")
        return true;
    if (raw === "false" || raw === "FALSE")
        return false;
    // Dates (MM/DD/YYYY [HH:MM[:SS]])
    if (DATE_PATTERN$1.test(raw)) {
        const d = new Date(raw);
        if (!isNaN(d.getTime()))
            return d;
    }
    // JSON object/array literals — fast prefix check before the parse.
    const first = raw.charCodeAt(0);
    if (first === 123 /* { */ || first === 91 /* [ */) {
        const trimmed = raw.trim();
        const last = trimmed.charCodeAt(trimmed.length - 1);
        if ((first === 123 && last === 125) ||
            (first === 91 && last === 93)) {
            try {
                return JSON.parse(trimmed);
            }
            catch {
                // not JSON — fall through
            }
        }
    }
    return raw;
}
/**
 * Encode a value for writing to a sheet cell.
 * - Dates are converted to locale strings.
 * - Plain objects/arrays are JSON-stringified.
 * - All other values are returned as-is.
 */
function encodeCellValue(value) {
    if (value instanceof Date) {
        return value.toLocaleString();
    }
    if (value !== null && typeof value === "object") {
        return JSON.stringify(value);
    }
    return value;
}
/**
 * Normalize a data object for schema validation:
 * empty strings are treated as undefined (equivalent to a blank cell).
 */
function normalizeForSchema(data) {
    const normalized = {};
    for (const key of Object.keys(data)) {
        normalized[key] = data[key] === "" ? undefined : data[key];
    }
    return normalized;
}
/**
 * Parse raw sheet values into GQueryRow objects with metadata. Performs
 * the single-pass type conversion (boolean/date/JSON) inline so callers
 * don't need a second walk over the result.
 *
 * @param headers Column headers from the sheet
 * @param values Raw values from the sheet (without header row)
 * @param rowOffset Number of header rows above the data (default 1)
 */
function parseRows(headers, values, rowOffset = 1) {
    const colLength = headers.length;
    return values.map((row, rowIndex) => {
        const obj = {
            __meta: {
                rowNum: rowIndex + rowOffset + 1,
                colLength,
            },
        };
        for (let i = 0; i < headers.length; i++) {
            obj[headers[i]] = decodeCellValue(row[i] !== undefined ? row[i] : "");
        }
        return obj;
    });
}
/**
 * Convert a 0-based column index to its A1 letters (0 -> A, 25 -> Z, 26 -> AA).
 */
function columnLetter(index) {
    let out = "";
    let n = index;
    while (n >= 0) {
        out = String.fromCharCode(65 + (n % 26)) + out;
        n = Math.floor(n / 26) - 1;
    }
    return out;
}
/**
 * Build an A1 range covering `limit` data rows starting at `offset` (0-based).
 * Includes the header row when offset is 0 so callers can extract headers
 * from the same payload. Returns just the sheet name when neither bound is set.
 */
function buildA1Range(sheetName, options = {}) {
    const { offset, limit, lastColumn } = options;
    if (offset === undefined && limit === undefined)
        return sheetName;
    const startRow = (offset !== null && offset !== void 0 ? offset : 0) + 1; // include header row
    const endRow = limit === undefined ? "" : String((offset !== null && offset !== void 0 ? offset : 0) + 1 + (limit !== null && limit !== void 0 ? limit : 0));
    const lastCol = lastColumn !== undefined && lastColumn > 0
        ? columnLetter(lastColumn - 1)
        : "";
    if (lastCol) {
        return `${sheetName}!A${startRow}:${lastCol}${endRow}`;
    }
    return `${sheetName}!${startRow}:${endRow}`;
}
/**
 * Fetch all data from a sheet including headers. Consults the cache if a
 * `GQueryCache` is provided and writes the result back on miss.
 */
function fetchSheetData(spreadsheetId, sheetName, cache) {
    const keyOpts = {
        range: "all",
        valueRender: "FORMATTED_VALUE",
        dateRender: "FORMATTED_STRING",
    };
    if (cache === null || cache === void 0 ? void 0 : cache.enabled) {
        const hit = cache.get(sheetName, keyOpts);
        if (hit)
            return hit;
    }
    const response = callHandler(() => Sheets.Spreadsheets.Values.get(spreadsheetId, sheetName), 20, { operation: `Values.get(${sheetName})` });
    const values = response.values || [];
    if (values.length === 0) {
        return { headers: [], rows: [] };
    }
    const headers = values[0].map((h) => String(h));
    const rows = parseRows(headers, values.slice(1));
    const result = { headers, rows };
    if (cache === null || cache === void 0 ? void 0 : cache.enabled) {
        cache.put(sheetName, result, keyOpts);
    }
    return result;
}

const DATE_PATTERN = /^\d{1,2}\/\d{1,2}\/\d{4}(\s\d{1,2}:\d{1,2}(:\d{1,2})?)?$/;
/**
 * Validate a single row through a Standard Schema.
 * Throws GQuerySchemaError if validation fails.
 * Throws a plain Error if the schema returns a Promise (async schemas are not
 * supported in Google Apps Script).
 */
function applySchema$2(schema, row) {
    const result = schema["~standard"].validate(row);
    if (result instanceof Promise) {
        throw new Error("GQuery does not support async schema validation. " +
            "Google Apps Script is a synchronous runtime. " +
            "Use a schema library that validates synchronously (e.g. Zod, Valibot).");
    }
    if (result.issues) {
        throw new GQuerySchemaError(result.issues, row);
    }
    return result.value;
}
/**
 * Apply a schema to an array of raw rows, returning typed rows with __meta preserved.
 */
function applySchemaToRows(schema, rows) {
    return rows.map((row) => {
        const { __meta, ...data } = row;
        const validated = applySchema$2(schema, normalizeForSchema(data));
        return { ...validated, __meta };
    });
}
function getManyInternal(GQuery, sheetNames, options) {
    if (!sheetNames || sheetNames.length === 0) {
        return {};
    }
    const valueRenderOption = (options === null || options === void 0 ? void 0 : options.valueRenderOption) || ValueRenderOption.FORMATTED_VALUE;
    const dateTimeRenderOption = (options === null || options === void 0 ? void 0 : options.dateTimeRenderOption) || DateTimeRenderOption.FORMATTED_STRING;
    const cache = (options === null || options === void 0 ? void 0 : options.cache) === false ? null : GQuery.cache;
    const cacheKeyOpts = {
        range: "all",
        valueRender: valueRenderOption,
        dateRender: dateTimeRenderOption,
    };
    const result = {};
    const sheetsToFetch = [];
    for (const sheetName of sheetNames) {
        if (cache === null || cache === void 0 ? void 0 : cache.enabled) {
            const hit = cache.get(sheetName, cacheKeyOpts);
            if (hit) {
                result[sheetName] = hit;
                continue;
            }
        }
        sheetsToFetch.push(sheetName);
    }
    if (sheetsToFetch.length === 0)
        return result;
    const dataResponse = callHandler(() => Sheets.Spreadsheets.Values.batchGet(GQuery.spreadsheetId, {
        ranges: sheetsToFetch,
        valueRenderOption,
        dateTimeRenderOption,
    }), 20, { operation: `Values.batchGet(${sheetsToFetch.join(",")})` });
    if (!dataResponse || !dataResponse.valueRanges) {
        sheetsToFetch.forEach((sheet) => {
            result[sheet] = { headers: [], rows: [] };
        });
        return result;
    }
    dataResponse.valueRanges.forEach((valueRange, index) => {
        const sheetName = sheetsToFetch[index];
        if (!valueRange.values || valueRange.values.length === 0) {
            result[sheetName] = { headers: [], rows: [] };
            return;
        }
        const headers = valueRange.values[0].map((h) => String(h));
        const rows = parseRows(headers, valueRange.values.slice(1));
        result[sheetName] = { headers, rows };
        if (cache === null || cache === void 0 ? void 0 : cache.enabled) {
            cache.put(sheetName, result[sheetName], cacheKeyOpts);
        }
    });
    return result;
}
function getInternal(GQueryTableFactory, options) {
    const GQueryTable = GQueryTableFactory.GQueryTable;
    const GQuery = GQueryTable.GQuery;
    // Server-side filter pushdown: when whereExpr is set and there are no
    // joins, dispatch through the gviz/tq path so only matching rows come
    // over the wire.
    if (GQueryTableFactory.whereExprOption &&
        GQueryTableFactory.joinOption.length === 0) {
        const tq = compileWhereExpr(GQueryTableFactory.whereExprOption, GQueryTableFactory.selectOption, GQueryTableFactory.limitOption, GQueryTableFactory.offsetOption);
        const result = queryInternal(GQueryTable, tq, options);
        const rows = GQueryTableFactory.filterOption
            ? result.rows.filter((row) => safeFilter(GQueryTableFactory.filterOption, row))
            : result.rows;
        const typed = GQueryTable.schema && (options === null || options === void 0 ? void 0 : options.validate)
            ? applySchemaToRows(GQueryTable.schema, rows)
            : rows;
        return { headers: result.headers, rows: typed };
    }
    // Determine which sheets we need to read from
    const sheetsToRead = [GQueryTable.sheetName];
    // Add all join sheets
    if (GQueryTableFactory.joinOption.length > 0) {
        GQueryTableFactory.joinOption.forEach((join) => {
            if (!sheetsToRead.includes(join.sheetName)) {
                sheetsToRead.push(join.sheetName);
            }
        });
    }
    // Read data from all required sheets at once
    const results = GQuery.getMany(sheetsToRead, options);
    // If the main sheet doesn't exist or has no data
    if (!results[GQueryTable.sheetName] ||
        results[GQueryTable.sheetName].rows.length === 0) {
        return { headers: [], rows: [] };
    }
    // Get data for the primary table
    let result = results[GQueryTable.sheetName];
    let rows = result.rows;
    let headers = result.headers;
    // Process each join sequentially
    if (GQueryTableFactory.joinOption.length > 0) {
        GQueryTableFactory.joinOption.forEach((joinConfig) => {
            const { sheetName, sheetColumn, joinColumn, columnsToReturn } = joinConfig;
            const joinData = results[sheetName];
            if (!joinData || !joinData.rows || joinData.rows.length === 0)
                return;
            const joinHeaders = joinData.headers;
            if (!joinHeaders.includes(sheetColumn))
                return;
            const joinMap = {};
            joinData.rows.forEach((joinRow) => {
                const joinKey = String(joinRow[sheetColumn]);
                if (!joinMap[joinKey])
                    joinMap[joinKey] = [];
                joinMap[joinKey].push(joinRow);
            });
            rows = rows.map((row) => {
                const localJoinValue = row[joinColumn];
                const joinedRows = joinMap[String(localJoinValue)] || [];
                const joinedRow = { ...row };
                joinedRows.forEach((joinRow, index) => {
                    const columnsToInclude = columnsToReturn ||
                        Object.keys(joinRow).filter((key) => key !== "__meta" && key !== sheetColumn);
                    columnsToInclude.forEach((key) => {
                        if (Object.prototype.hasOwnProperty.call(joinRow, key) && key !== "__meta") {
                            const suffix = joinedRows.length > 1 ? `_${index + 1}` : "";
                            const targetKey = key === sheetColumn ? key : `${key}${suffix}`;
                            joinedRow[targetKey] = joinRow[key];
                        }
                    });
                });
                return joinedRow;
            });
        });
    }
    // Apply filter if specified
    if (GQueryTableFactory.filterOption) {
        rows = rows.filter((row) => safeFilter(GQueryTableFactory.filterOption, row));
    }
    // Apply offset/limit (in-memory; A1-range pushdown happens earlier when no joins/filters require full data)
    if (GQueryTableFactory.offsetOption !== undefined) {
        rows = rows.slice(GQueryTableFactory.offsetOption);
    }
    if (GQueryTableFactory.limitOption !== undefined) {
        rows = rows.slice(0, GQueryTableFactory.limitOption);
    }
    // Apply select if specified — strict projection. Joined columns are kept
    // only when explicitly listed (or via .includeJoinColumns()).
    let outHeaders = headers;
    if (GQueryTableFactory.selectOption &&
        GQueryTableFactory.selectOption.length > 0) {
        let selectedHeaders = [...GQueryTableFactory.selectOption];
        if (GQueryTableFactory.includeJoinColumnsOption) {
            const joinedColumns = new Set();
            rows.forEach((row) => {
                Object.keys(row).forEach((key) => {
                    if (!headers.includes(key) && key !== "__meta") {
                        joinedColumns.add(key);
                    }
                });
            });
            joinedColumns.forEach((c) => selectedHeaders.push(c));
        }
        selectedHeaders = Array.from(new Set(selectedHeaders));
        rows = rows.map((row) => {
            const selectedRow = { __meta: row.__meta };
            selectedHeaders.forEach((header) => {
                if (Object.prototype.hasOwnProperty.call(row, header)) {
                    selectedRow[header] = row[header];
                }
            });
            return selectedRow;
        });
        outHeaders = selectedHeaders;
    }
    const typedRows = GQueryTable.schema && (options === null || options === void 0 ? void 0 : options.validate)
        ? applySchemaToRows(GQueryTable.schema, rows)
        : rows;
    return {
        headers: outHeaders,
        rows: typedRows,
    };
}
function safeFilter(fn, row) {
    try {
        return fn(row);
    }
    catch (error) {
        console.error("Error filtering row:", error);
        return false;
    }
}
/**
 * Execute a Google Visualization API (gviz/tq) query against the table's
 * sheet. The caller passes in a fully-formed `tq` query string; we handle
 * the column-name → A1-letter substitution by reading the header row once
 * (cached when the spreadsheet's GQueryCache is enabled), wrap the HTTP
 * call in callHandler for retries, and parse the response into typed rows.
 */
function queryInternal(GQueryTable, query, options) {
    const cache = (options === null || options === void 0 ? void 0 : options.cache) === false ? null : GQueryTable.GQuery.cache;
    if (cache === null || cache === void 0 ? void 0 : cache.enabled) {
        const hit = cache.getQuery(GQueryTable.sheetName, query);
        if (hit)
            return hit;
    }
    const headers = readHeadersOnce(GQueryTable);
    // Build column name → A1 letter map in a single pass over the header row.
    let replaced = query;
    for (let i = 0; i < headers.length; i++) {
        const name = headers[i];
        if (!name)
            continue;
        const letter = columnLetterOf(i);
        // Replace whole-word column references; most user queries quote names
        // with backticks but we keep the legacy global-replace for compatibility.
        replaced = replaced.split(name).join(letter);
    }
    const url = Utilities.formatString("https://docs.google.com/spreadsheets/d/%s/gviz/tq?tq=%s&sheet=%s&headers=1", GQueryTable.spreadsheetId, encodeURIComponent(replaced), encodeURIComponent(GQueryTable.sheetName));
    const response = callHandler(() => UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        headers: {
            Authorization: "Bearer " + ScriptApp.getOAuthToken(),
        },
    }), 20, { urlFetch: true, operation: `gviz.query(${GQueryTable.sheetName})` });
    const body = response.getContentText();
    const stripped = body
        .replace("/*O_o*/\n", "")
        .replace(/(google\.visualization\.Query\.setResponse\()|(\);)/gm, "");
    let jsonResponse;
    try {
        jsonResponse = JSON.parse(stripped);
    }
    catch (error) {
        throw new GQueryApiError(`gviz.query(${GQueryTable.sheetName})`, response.getResponseCode(), `Failed to parse gviz response: ${stripped.slice(0, 200)}`, error);
    }
    if (jsonResponse.status === "error") {
        const message = (jsonResponse.errors || [])
            .map((e) => e.detailed_message || e.message)
            .join("; ");
        throw new GQueryApiError(`gviz.query(${GQueryTable.sheetName})`, response.getResponseCode(), message || "gviz returned an error status");
    }
    const table = jsonResponse.table;
    const outHeaders = table.cols.map((col) => col.label || col.id || "");
    const rows = table.rows.map((row) => {
        const rowObj = {
            __meta: {
                rowNum: -1, // gviz doesn't expose source row numbers without __ROW__
                colLength: row.c.length,
            },
        };
        table.cols.forEach((col, colIndex) => {
            const cellData = row.c[colIndex];
            let value = "";
            if (cellData) {
                value =
                    cellData.f !== null && cellData.f !== undefined
                        ? cellData.f
                        : cellData.v;
                if (typeof value === "string" && DATE_PATTERN.test(value)) {
                    const dateValue = new Date(value);
                    if (!isNaN(dateValue.getTime()))
                        value = dateValue;
                }
                else if (typeof value === "string") {
                    value = decodeCellValue(value);
                }
            }
            rowObj[outHeaders[colIndex] || col.id] = value;
        });
        return rowObj;
    });
    const out = { headers: outHeaders, rows };
    if (cache === null || cache === void 0 ? void 0 : cache.enabled) {
        cache.putQuery(GQueryTable.sheetName, query, out);
    }
    return out;
}
/**
 * Read the header row for a sheet. Uses the GQueryCache when available
 * (avoids the per-call Sheets RPC); otherwise issues a single
 * `Values.get(sheet!1:1)` instead of the legacy per-column getRange loop.
 */
function readHeadersOnce(GQueryTable) {
    const cache = GQueryTable.GQuery.cache;
    if (cache === null || cache === void 0 ? void 0 : cache.enabled) {
        const hit = cache.get(GQueryTable.sheetName, {
            range: "all",
            valueRender: "FORMATTED_VALUE",
            dateRender: "FORMATTED_STRING",
        });
        if (hit)
            return hit.headers;
    }
    const range = buildA1Range(GQueryTable.sheetName, { offset: 0, limit: 0 });
    const response = callHandler(() => Sheets.Spreadsheets.Values.get(GQueryTable.spreadsheetId, range), 20, { operation: `Values.get(${range})` });
    const values = response.values || [];
    if (values.length === 0)
        return [];
    return values[0].map((h) => String(h));
}
function columnLetterOf(index) {
    let out = "";
    let n = index;
    while (n >= 0) {
        out = String.fromCharCode(65 + (n % 26)) + out;
        n = Math.floor(n / 26) - 1;
    }
    return out;
}
/**
 * Compile a typed GQueryWhereExpr into a Google Visualization API query
 * string. Column names are emitted as backtick-quoted identifiers so they
 * survive the later name → letter substitution step.
 */
function compileWhereExpr(expr, select, limit, offset) {
    const parts = [];
    if (select && select.length > 0) {
        parts.push(`select ${select.map((c) => `\`${c}\``).join(", ")}`);
    }
    else {
        parts.push("select *");
    }
    parts.push(`where ${compileExpr(expr)}`);
    if (limit !== undefined)
        parts.push(`limit ${limit}`);
    if (offset !== undefined)
        parts.push(`offset ${offset}`);
    return parts.join(" ");
}
function compileExpr(expr) {
    if ("and" in expr) {
        return `(${expr.and.map(compileExpr).join(" and ")})`;
    }
    if ("or" in expr) {
        return `(${expr.or.map(compileExpr).join(" or ")})`;
    }
    if ("not" in expr) {
        return `(not ${compileExpr(expr.not)})`;
    }
    const { col, op, value } = expr;
    return `\`${col}\` ${op} ${formatLiteral(value)}`;
}
function formatLiteral(value) {
    if (value === null)
        return "null";
    if (value instanceof Date) {
        return `date '${value.toISOString().slice(0, 10)}'`;
    }
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number")
        return String(value);
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

/**
 * Validate a single row through a Standard Schema, preserving __meta.
 * Throws GQuerySchemaError if validation fails.
 */
function applySchema$1(schema, row) {
    const { __meta, ...data } = row;
    const result = schema["~standard"].validate(normalizeForSchema(data));
    if (result instanceof Promise) {
        throw new Error("GQuery does not support async schema validation. " +
            "Google Apps Script is a synchronous runtime.");
    }
    if (result.issues) {
        throw new GQuerySchemaError(result.issues, data);
    }
    return { ...result.value, __meta };
}
function updateInternal(GQueryTableFactory, updateFn) {
    const spreadsheetId = GQueryTableFactory.GQueryTable.spreadsheetId;
    const sheetName = GQueryTableFactory.GQueryTable.sheetName;
    const schema = GQueryTableFactory.GQueryTable.schema;
    const cache = GQueryTableFactory.GQueryTable.GQuery.cache;
    const { headers, rows } = fetchSheetData(spreadsheetId, sheetName, cache);
    if (headers.length === 0) {
        return { rows: [], headers: [] };
    }
    // Filter rows if filter is specified
    const filteredRows = GQueryTableFactory.filterOption
        ? rows.filter((row) => {
            try {
                return GQueryTableFactory.filterOption(row);
            }
            catch (error) {
                console.error("Error filtering row:", error);
                return false;
            }
        })
        : rows;
    // Apply updates to filtered rows
    const updatedRows = filteredRows.map((row) => {
        const updatedRow = { ...row };
        try {
            const result = updateFn(updatedRow);
            if (result && typeof result === "object") {
                Object.assign(updatedRow, result);
            }
        }
        catch (error) {
            console.error("Error updating row:", error);
        }
        return updatedRow;
    });
    // Collect changed cells
    const changedCells = new Map();
    updatedRows.forEach((updatedRow) => {
        const rowIndex = updatedRow.__meta.rowNum - 2;
        const originalRow = rows[rowIndex];
        if (!originalRow)
            return;
        headers.forEach((header, columnIndex) => {
            const originalValue = encodeCellValue(originalRow[header]);
            const updatedValue = encodeCellValue(updatedRow[header]);
            if (originalValue === updatedValue)
                return;
            const letter = columnLetter(columnIndex);
            const cellRange = `${sheetName}!${letter}${updatedRow.__meta.rowNum}`;
            const writeValue = updatedValue !== undefined && updatedValue !== null
                ? updatedValue
                : "";
            changedCells.set(cellRange, [[writeValue]]);
        });
    });
    if (changedCells.size > 0) {
        const optimizedUpdates = optimizeRanges(changedCells);
        const batchUpdateRequest = {
            data: optimizedUpdates,
            valueInputOption: "USER_ENTERED",
        };
        try {
            callHandler(() => Sheets.Spreadsheets.Values.batchUpdate(batchUpdateRequest, spreadsheetId), 20, { operation: `Values.batchUpdate(${sheetName})` });
        }
        catch (error) {
            if (error instanceof GQueryApiError)
                throw error;
            throw new GQueryApiError(`Values.batchUpdate(${sheetName})`, null, `Failed to update ${changedCells.size} cell(s) across ${optimizedUpdates.length} range(s).`, error);
        }
        cache === null || cache === void 0 ? void 0 : cache.invalidate(sheetName);
    }
    // Apply schema validation if a schema is attached
    const typedRows = schema
        ? updatedRows.map((row) => applySchema$1(schema, row))
        : updatedRows;
    return {
        rows: filteredRows.length > 0 ? typedRows : [],
        headers,
    };
}
/**
 * Optimize update ranges by combining adjacent cells in the same column
 * into contiguous row segments.
 */
function optimizeRanges(changedCells) {
    const columnGroups = new Map();
    for (const [cellRange, value] of changedCells.entries()) {
        const matches = cellRange.match(/([^!]+)!([A-Z]+)(\d+)$/);
        if (!matches)
            continue;
        const sheet = matches[1];
        const col = matches[2];
        const rowNumber = parseInt(matches[3], 10);
        const columnKey = `${sheet}!${col}`;
        if (!columnGroups.has(columnKey)) {
            columnGroups.set(columnKey, new Map());
        }
        columnGroups.get(columnKey).set(rowNumber, value[0][0]);
    }
    const optimizedUpdates = [];
    for (const [columnKey, rowsMap] of columnGroups.entries()) {
        const rowNumbers = Array.from(rowsMap.keys()).sort((a, b) => a - b);
        if (rowNumbers.length === 0)
            continue;
        const [sheet, col] = columnKey.split("!");
        let start = rowNumbers[0];
        let groupValues = [[rowsMap.get(start)]];
        for (let i = 1; i < rowNumbers.length; i++) {
            const rowNum = rowNumbers[i];
            const prev = rowNumbers[i - 1];
            if (rowNum === prev + 1) {
                groupValues.push([rowsMap.get(rowNum)]);
            }
            else {
                const end = prev;
                const rangeKey = start === end
                    ? `${sheet}!${col}${start}`
                    : `${sheet}!${col}${start}:${col}${end}`;
                optimizedUpdates.push({ range: rangeKey, values: groupValues });
                start = rowNum;
                groupValues = [[rowsMap.get(rowNum)]];
            }
        }
        const last = rowNumbers[rowNumbers.length - 1];
        const rangeKey = start === last
            ? `${sheet}!${col}${start}`
            : `${sheet}!${col}${start}:${col}${last}`;
        optimizedUpdates.push({ range: rangeKey, values: groupValues });
    }
    return optimizedUpdates;
}

/**
 * Validate a single value through a Standard Schema.
 * Throws GQuerySchemaError if validation fails.
 */
function applySchema(schema, value) {
    const result = schema["~standard"].validate(value);
    if (result instanceof Promise) {
        throw new Error("GQuery does not support async schema validation. " +
            "Google Apps Script is a synchronous runtime.");
    }
    if (result.issues) {
        throw new GQuerySchemaError(result.issues, value);
    }
    return result.value;
}
function appendInternal(table, data, options) {
    if (!data || data.length === 0) {
        return { rows: [], headers: [] };
    }
    const spreadsheetId = table.spreadsheetId;
    const sheetName = table.sheetName;
    const schema = table.schema;
    const cache = table.GQuery.cache;
    // Validate each item through the schema before writing, if requested
    const validatedData = schema && (options === null || options === void 0 ? void 0 : options.validate)
        ? data.map((item) => applySchema(schema, normalizeForSchema(item)))
        : data;
    // Fetch headers from the first row
    const response = callHandler(() => Sheets.Spreadsheets.Values.get(spreadsheetId, `${sheetName}!1:1`), 20, { operation: `Values.get(${sheetName}!1:1)` });
    if (!response || !response.values || response.values.length === 0) {
        throw new GQueryApiError(`Values.append(${sheetName})`, null, `Sheet "${sheetName}" not found or has no header row.`);
    }
    const headers = response.values[0].map((header) => String(header));
    // Map data to rows according to header order
    const rowsToAppend = validatedData.map((item) => {
        const record = item;
        return headers.map((header) => {
            const value = record[header];
            return value !== undefined ? encodeCellValue(value) : "";
        });
    });
    let appendResponse;
    try {
        appendResponse = callHandler(() => Sheets.Spreadsheets.Values.append({ values: rowsToAppend }, spreadsheetId, sheetName, {
            valueInputOption: "USER_ENTERED",
            insertDataOption: "OVERWRITE",
            responseValueRenderOption: "FORMATTED_VALUE",
            responseDateTimeRenderOption: "FORMATTED_STRING",
            includeValuesInResponse: true,
        }), 20, { operation: `Values.append(${sheetName})` });
    }
    catch (error) {
        if (error instanceof GQueryApiError)
            throw error;
        throw new GQueryApiError(`Values.append(${sheetName})`, null, `Failed to append ${rowsToAppend.length} row(s) to "${sheetName}".`, error);
    }
    if (!appendResponse ||
        !appendResponse.updates ||
        !appendResponse.updates.updatedRange) {
        throw new GQueryApiError(`Values.append(${sheetName})`, null, `Append response missing updatedRange. Payload size: ${rowsToAppend.length} rows × ${headers.length} cols.`);
    }
    // Parse the updated range to get row numbers
    const updatedRange = appendResponse.updates.updatedRange;
    const rangeMatch = updatedRange.match(/([^!]+)!([A-Z]+)(\d+):([A-Z]+)(\d+)/);
    if (!rangeMatch) {
        throw new GQueryApiError(`Values.append(${sheetName})`, null, `Could not parse updated range: ${updatedRange}`);
    }
    const startRow = parseInt(rangeMatch[3], 10);
    const endRow = parseInt(rangeMatch[5], 10);
    const expectedRowCount = data.length;
    const actualRowCount = endRow - startRow + 1;
    if (actualRowCount !== expectedRowCount) {
        console.warn(`Expected to append ${expectedRowCount} rows but ${actualRowCount} were appended`);
    }
    cache === null || cache === void 0 ? void 0 : cache.invalidate(sheetName);
    // Create result rows with metadata, typed to T
    const resultRows = rowsToAppend.map((row, index) => {
        const rowObj = {
            __meta: {
                rowNum: startRow + index,
                colLength: headers.length,
            },
        };
        headers.forEach((header, colIndex) => {
            rowObj[header] = row[colIndex];
        });
        return rowObj;
    });
    return {
        rows: resultRows,
        headers,
    };
}

function deleteInternal(GQueryTableFactory) {
    const spreadsheetId = GQueryTableFactory.GQueryTable.spreadsheetId;
    const sheetName = GQueryTableFactory.GQueryTable.sheetName;
    const sheet = GQueryTableFactory.GQueryTable.sheet;
    const sheetId = sheet.getSheetId();
    const cache = GQueryTableFactory.GQueryTable.GQuery.cache;
    const { rows } = fetchSheetData(spreadsheetId, sheetName, cache);
    if (!GQueryTableFactory.filterOption || rows.length === 0) {
        return { deletedRows: 0 };
    }
    const rowsToDelete = rows.filter((row) => {
        try {
            return GQueryTableFactory.filterOption(row);
        }
        catch (error) {
            console.error("Error filtering row:", error);
            return false;
        }
    });
    if (rowsToDelete.length === 0) {
        return { deletedRows: 0 };
    }
    // Sort in descending order to avoid row number shifting issues
    rowsToDelete.sort((a, b) => b.__meta.rowNum - a.__meta.rowNum);
    const batchUpdateRequest = {
        requests: rowsToDelete.map((row) => ({
            deleteDimension: {
                range: {
                    sheetId,
                    dimension: "ROWS",
                    startIndex: row.__meta.rowNum - 1,
                    endIndex: row.__meta.rowNum,
                },
            },
        })),
    };
    try {
        callHandler(() => Sheets.Spreadsheets.batchUpdate(batchUpdateRequest, spreadsheetId), 20, { operation: `Spreadsheets.batchUpdate(delete:${sheetName})` });
    }
    catch (error) {
        if (error instanceof GQueryApiError)
            throw error;
        throw new GQueryApiError(`Spreadsheets.batchUpdate(delete:${sheetName})`, null, `Failed to delete ${rowsToDelete.length} row(s) from "${sheetName}".`, error);
    }
    cache === null || cache === void 0 ? void 0 : cache.invalidate(sheetName);
    return { deletedRows: rowsToDelete.length };
}

/**
 * Main GQuery class for interacting with Google Sheets.
 *
 * Caches the Spreadsheet handle and per-sheet handles internally so that
 * repeated `from()` calls on the same instance avoid the per-call cost of
 * `SpreadsheetApp.openById` / `getSheetByName`.
 */
class GQuery {
    /**
     * Create a new GQuery instance.
     * @param spreadsheetId Optional spreadsheet ID. If not provided, uses the active spreadsheet.
     * @param options Optional configuration (caching, default read options).
     */
    constructor(spreadsheetId, options = {}) {
        var _a;
        this.sheetHandles = new Map();
        this.spreadsheetId = spreadsheetId
            ? spreadsheetId
            : SpreadsheetApp.getActiveSpreadsheet().getId();
        this.cache = new GQueryCache(this.spreadsheetId, options.cache);
        this.defaultReadOptions = (_a = options.defaultReadOptions) !== null && _a !== void 0 ? _a : {};
    }
    /** Lazily resolve and memoize the Spreadsheet handle. */
    getSpreadsheet() {
        if (!this.spreadsheetHandle) {
            this.spreadsheetHandle = SpreadsheetApp.openById(this.spreadsheetId);
        }
        return this.spreadsheetHandle;
    }
    /** Lazily resolve and memoize a Sheet handle by name. */
    getSheet(sheetName) {
        let handle = this.sheetHandles.get(sheetName);
        if (!handle) {
            handle = this.getSpreadsheet().getSheetByName(sheetName);
            this.sheetHandles.set(sheetName, handle);
        }
        return handle;
    }
    from(sheetName, schema) {
        return new GQueryTable(this, this.spreadsheetId, sheetName, schema);
    }
    /**
     * Efficiently fetch data from multiple sheets at once.
     * For typed results per-sheet, use `from()` individually.
     */
    getMany(sheetNames, options) {
        return getManyInternal(this, sheetNames, mergeReadOptions(this, options));
    }
    /**
     * Drop every cached entry for a specific sheet (or for the entire
     * spreadsheet, when no sheet name is given).
     */
    invalidateCache(sheetName) {
        if (sheetName)
            this.cache.invalidate(sheetName);
    }
}
/**
 * Represents a single sheet table for query operations.
 * @typeParam T - The shape of each data row. Inferred from a Standard Schema if provided.
 */
class GQueryTable {
    constructor(GQuery, spreadsheetId, sheetName, schema) {
        this.GQuery = GQuery;
        this.spreadsheetId = spreadsheetId;
        this.sheetName = sheetName;
        this.schema = schema;
    }
    /** Lazily-resolved Spreadsheet handle (memoized on the GQuery instance). */
    get spreadsheet() {
        return this.GQuery.getSpreadsheet();
    }
    /** Lazily-resolved Sheet handle (memoized on the GQuery instance). */
    get sheet() {
        return this.GQuery.getSheet(this.sheetName);
    }
    /**
     * Select specific columns to return.
     *
     * Joined columns are excluded by default — chain `.includeJoinColumns()`
     * to keep them all when you don't want to enumerate each one.
     */
    select(headers) {
        return new GQueryTableFactory(this).select(headers);
    }
    /**
     * Filter rows with an arbitrary predicate. Runs in-memory after the
     * fetch — for server-side filtering, use `.whereExpr()` instead.
     */
    where(filterFn) {
        return new GQueryTableFactory(this).where(filterFn);
    }
    /**
     * Server-side filter via Google Visualization API (gviz/tq). Only matching
     * rows come over the wire. Cannot be combined with joins.
     */
    whereExpr(expr) {
        return new GQueryTableFactory(this).whereExpr(expr);
    }
    /**
     * Limit the number of rows returned. When combined with `.offset()` and
     * no joins/in-memory filters, the underlying fetch only requests the
     * requested band.
     */
    limit(n) {
        return new GQueryTableFactory(this).limit(n);
    }
    /** Skip the first N rows. */
    offset(n) {
        return new GQueryTableFactory(this).offset(n);
    }
    /**
     * Join with another sheet.
     * Note: joined columns are typed as additional `any` fields alongside T.
     */
    join(sheetName, sheetColumn, joinColumn, columnsToReturn) {
        return new GQueryTableFactory(this).join(sheetName, sheetColumn, joinColumn, columnsToReturn);
    }
    /**
     * Update rows in the sheet. Cache (if enabled) is invalidated on success.
     */
    update(updateFn) {
        return new GQueryTableFactory(this).update(updateFn);
    }
    /**
     * Append new rows to the sheet. If a schema is attached and `validate:true`
     * is passed, input data is validated before writing. Cache is invalidated
     * on success.
     */
    append(data, options) {
        const dataArray = Array.isArray(data) ? data : [data];
        return appendInternal(this, dataArray, options);
    }
    /** Get data from the sheet. */
    get(options) {
        return new GQueryTableFactory(this).get(options);
    }
    /** Execute a Google Visualization API query string directly. */
    query(query, options) {
        return queryInternal(this, query, mergeReadOptions(this.GQuery, options));
    }
    /** Delete rows from the sheet. Cache is invalidated on success. */
    delete() {
        return new GQueryTableFactory(this).delete();
    }
}
/**
 * Factory class for building and executing queries with filters, joins,
 * pagination, and server-side predicates.
 */
class GQueryTableFactory {
    constructor(GQueryTable) {
        this.joinOption = [];
        /** Keep all joined columns even when `.select()` doesn't list them. */
        this.includeJoinColumnsOption = false;
        this.GQueryTable = GQueryTable;
    }
    select(headers) {
        this.selectOption = headers;
        return this;
    }
    where(filterFn) {
        this.filterOption = filterFn;
        return this;
    }
    whereExpr(expr) {
        this.whereExprOption = expr;
        return this;
    }
    limit(n) {
        this.limitOption = n;
        return this;
    }
    offset(n) {
        this.offsetOption = n;
        return this;
    }
    fields(columns) {
        this.fieldsOption = columns;
        return this;
    }
    includeJoinColumns(include = true) {
        this.includeJoinColumnsOption = include;
        return this;
    }
    join(sheetName, sheetColumn, joinColumn, columnsToReturn) {
        this.joinOption.push({
            sheetName,
            sheetColumn,
            joinColumn,
            columnsToReturn,
        });
        return this;
    }
    get(options) {
        return getInternal(this, mergeReadOptions(this.GQueryTable.GQuery, options));
    }
    update(updateFn) {
        return updateInternal(this, updateFn);
    }
    append(data, options) {
        const dataArray = Array.isArray(data) ? data : [data];
        return appendInternal(this.GQueryTable, dataArray, options);
    }
    delete() {
        return deleteInternal(this);
    }
}
function mergeReadOptions(GQuery, options) {
    if (!options)
        return GQuery.defaultReadOptions;
    return { ...GQuery.defaultReadOptions, ...options };
}

export { DateTimeRenderOption, GQuery, GQueryApiError, GQueryCache, GQuerySchemaError, GQueryTable, GQueryTableFactory, ValueRenderOption };
