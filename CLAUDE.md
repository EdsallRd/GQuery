# gquery

A Google Apps Script (GAS) ORM for Google Sheets that provides a chainable, query-like interface (`from` / `select` / `where` / `whereExpr` / `limit` / `offset` / `join` / `get` / `update` / `append` / `delete`) over the `SpreadsheetApp` and Advanced Sheets services, with built-in `CacheService`-backed read caching, automatic write invalidation, and optional Standard Schema integration for typed rows and runtime validation.

## Public API

Exported from `src/index.ts`:

- `class GQuery` — entry point. Constructed with an optional `spreadsheetId` and `GQueryOptions` (cache config, default read options); falls back to the active spreadsheet. Exposes `from(sheetName, schema?)`, `getMany(sheetNames, options?)`, and `invalidateCache(sheetName?)`. Memoizes the Spreadsheet/Sheet handles so repeated `from()` calls don't pay the `openById` / `getSheetByName` cost again.
- `class GQueryTable<T>` — a typed table reference returned by `GQuery#from`. Methods: `select`, `where`, `whereExpr`, `limit`, `offset`, `join`, `get`, `query`, `update`, `append`, `delete`.
- `class GQueryTableFactory<T>` — chainable builder returned by `select` / `where` / `whereExpr` / `limit` / `offset` / `join` / `fields` / `includeJoinColumns`. Terminal methods: `get`, `update`, `append`, `delete`.
- `class GQueryCache` — `CacheService` wrapper used internally; exposed in case consumers want to invalidate or pre-warm manually.

Re-exported from `src/types.ts`:

- `class GQuerySchemaError` — thrown when a row fails Standard Schema validation; carries `issues` and the offending `row`.
- `class GQueryApiError` — thrown when a Google API call fails non-retryably or after exhausted retries; carries `operation`, `status`, `body`, and `cause`.
- `interface StandardSchemaV1` and namespace types — the Standard Schema spec, copied verbatim (no runtime dep).
- `type InferSchema<S>`, `type GQueryReadOptions`, `type GQueryResult<T>`, `type GQueryRow<T>`, `type GQueryCacheOptions`, `type GQueryWhereExpr`, `type GQueryComparisonOp`.
- `enum ValueRenderOption`, `enum DateTimeRenderOption` — mirrors of the Sheets API options.

## Source layout

- `src/index.ts` — entry point; defines and exports `GQuery`, `GQueryTable`, `GQueryTableFactory`, re-exports `GQueryCache`, and re-exports everything from `types.ts`. `GQuery` owns the cache instance and the memoized spreadsheet/sheet handles; tables and factories delegate operation methods to the `*Internal` functions in the per-op files.
- `src/types.ts` — `StandardSchemaV1` interface and namespace (copied verbatim from the spec), `InferSchema`, `GQueryReadOptions` (now includes `cache`), `GQueryResult`, `GQueryRow`, `GQueryCacheOptions`, `GQueryWhereExpr` / `GQueryComparisonOp`, the `ValueRenderOption` / `DateTimeRenderOption` enums, and the `GQuerySchemaError` / `GQueryApiError` classes.
- `src/cache.ts` — `GQueryCache`: `CacheService` wrapper. Stores headers and chunked row data under prefixed keys (`gquery:v2:<idShort>:<sheet>:<range>:<render>:<chunk|headers|meta>`), gzip-compresses any chunk above `compressThreshold`, and tracks variant base keys via a per-sheet manifest so `invalidate()` can clear every entry.
- `src/get.ts` — `getInternal` (select/where/join pipeline; routes to `queryInternal` when a `whereExpr` is set with no joins), `getManyInternal` (partitions sheets into cached vs. uncached, fires one `Values.batchGet` for the misses, writes results back), `queryInternal` (gviz/tq fetch wrapped in `callHandler` with header-row substitution done in a single Sheets call), and `compileWhereExpr` (typed predicate → tq query string).
- `src/update.ts` — `updateInternal`: runs the user's update fn over filtered rows, diffs against the originals via `encodeCellValue`, coalesces changed cells into contiguous A1 ranges (`optimizeRanges`), issues a single `Values.batchUpdate`, and invalidates the sheet's cache on success.
- `src/append.ts` — `appendInternal`: optionally validates rows through the schema, fetches the header row, maps inputs to the header order, calls `Values.append` with `USER_ENTERED` / `OVERWRITE`, reconstructs `GQueryRow`s from `updatedRange`, and invalidates the sheet's cache on success. Errors surface as `GQueryApiError`.
- `src/delete.ts` — `deleteInternal`: requires a `where` filter, sorts matching rows by `rowNum` descending, submits a single `Spreadsheets.batchUpdate` of `deleteDimension` requests, and invalidates the sheet's cache on success.
- `src/ratelimit.ts` — `callHandler`: exponential-backoff wrapper (jittered, capped at 64s, default 20 retries). Retries on 429 / "Quota exceeded" / "Rate Limit Exceeded". With `urlFetch: true` it also retries on `UrlFetchApp` 429/5xx responses and converts other non-2xx responses into `GQueryApiError`.
- `src/utils.ts` — `encodeCellValue` (Date → locale string, object/array → JSON, passthrough), `decodeCellValue` + `parseRows` for single-pass read-side decoding (boolean / date / JSON in one walk), `normalizeForSchema` (empty strings → `undefined` before validation), `columnLetter`, `buildA1Range`, and `fetchSheetData` (headers + rows in one `Values.get`, with cache lookup/write when a `GQueryCache` is provided).

## Tests

`test/` contains a Vitest harness with in-memory fakes for `Sheets`, `SpreadsheetApp`, `CacheService`, `UrlFetchApp`, `Utilities`, and `ScriptApp` (`test/setup.ts`). Run with `pnpm test`. Coverage spans utils, cache round-trip / chunking / invalidation, ratelimit / `UrlFetchApp` retry, get/cache integration, write invalidation, and `whereExpr` compilation.

## Build

Built with Rollup (`rollup -c` via `pnpm build`). `rollup.config.mjs` produces four artifacts:

- `dist/bundle.js` — ESM bundle (`main`), used by NPM consumers including Yggdrasil siblings.
- `dist/bundle.global.js` — IIFE bundle for pasting directly into a `.gs` file or publishing as an Apps Script library. A custom `rollupGasBundler` plugin patches the IIFE's `return exports;` so callers get back the `GQuery` class with the rest of the exports merged onto it.
- `dist/bundle.d.ts` — flat ESM types (`types`).
- `dist/bundle.global.d.ts` — types wrapped in `declare namespace GQuery { ... }` for the global/library installation paths.

## Developing inside Yggdrasil

- Build: `pnpm --filter @edsallrd/gquery build` from the Yggdrasil root, or `pnpm build` from this directory.
- Sibling apps consume it as `"@edsallrd/gquery": "workspace:*"` — pnpm resolves to the local checkout, so a rebuild is enough to propagate changes.
- This directory is its own git repo. Commit here, not at the Yggdrasil meta-repo level.

## Quirks

- **Apps Script runtime.** All sheet I/O assumes the GAS globals (`SpreadsheetApp`, `Sheets` Advanced Service, `CacheService`, `UrlFetchApp`, `Utilities`, `ScriptApp`) exist at runtime. Types come from `@types/google-apps-script` (a runtime `dependency`, not devDependency, because consumers building GAS projects need the ambient globals too). The package is unusable in plain Node — but the test harness stubs every used global so unit tests can run there.
- **Synchronous schema validation only.** GAS has no real event loop, so if a Standard Schema's `validate()` returns a `Promise`, GQuery throws immediately. Zod and Valibot validate synchronously by default and work fine.
- **Rate-limit retries.** `src/ratelimit.ts` wraps Sheets API calls (and the `UrlFetchApp` call inside `queryInternal`) in an exponential-backoff loop that retries on 429 / "Quota exceeded" / "Rate Limit Exceeded" / 5xx up to 20 times.
- **Caching default-on.** Reads are cached via `CacheService.getDocumentCache()` by default; writes invalidate. Pass `{ cache: false }` to the `GQuery` constructor (or `.get({ cache: false })` per-call) to disable. Values larger than 100KB are chunked across keys, with gzip compression for chunks ≥ 50KB; chunks that still overflow fall back to no-cache with a single warn.
- **Cell encoding.** `src/utils.ts` `encodeCellValue` stringifies plain objects/arrays as JSON and converts `Date` to a locale string before writing. `decodeCellValue` does the inverse for booleans, MM/DD/YYYY dates, and JSON literals in a single pass during `parseRows`.
- **`__ROW__` for `query()`.** Without selecting `__ROW__` in a gviz query the resulting rows have `__meta.rowNum = -1`. `update()` / `delete()` derived from `query()` results require an explicit row identifier.
