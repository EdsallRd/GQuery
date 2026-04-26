# gquery

A Google Apps Script (GAS) ORM for Google Sheets that provides a chainable, query-like interface (`from` / `select` / `where` / `join` / `get` / `update` / `append` / `delete`) over the `SpreadsheetApp` and Advanced Sheets services, with optional Standard Schema integration for typed rows and runtime validation.

## Public API

Exported from `src/index.ts`:

- `class GQuery` — entry point. Constructed with an optional `spreadsheetId`; falls back to the active spreadsheet. Exposes `from(sheetName, schema?)` and `getMany(sheetNames, options?)`.
- `class GQueryTable<T>` — a typed table reference returned by `GQuery#from`. Methods: `select`, `where`, `join`, `get`, `query`, `update`, `append`, `delete`.
- `class GQueryTableFactory<T>` — chainable builder returned by `select` / `where` / `join`. Terminal methods: `get`, `update`, `append`, `delete`.

Re-exported from `src/types.ts`:

- `class GQuerySchemaError` — thrown when a row fails Standard Schema validation; carries `issues` and the offending `row`.
- `interface StandardSchemaV1` and namespace types — the Standard Schema spec, copied verbatim (no runtime dep).
- `type InferSchema<S>`, `type GQueryReadOptions`, `type GQueryResult<T>`, `type GQueryRow<T>`.
- `enum ValueRenderOption`, `enum DateTimeRenderOption` — mirrors of the Sheets API options.

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

- **Apps Script runtime.** All sheet I/O assumes the GAS globals (`SpreadsheetApp`, `Sheets` Advanced Service, etc.) exist at runtime. Types come from `@types/google-apps-script` (a runtime `dependency`, not devDependency, because consumers building GAS projects need the ambient globals too). The package is unusable in plain Node.
- **Synchronous schema validation only.** GAS has no real event loop, so if a Standard Schema's `validate()` returns a `Promise`, GQuery throws immediately. Zod and Valibot validate synchronously by default and work fine.
- **Rate-limit retries.** `src/ratelimit.ts` wraps Sheets API calls in an exponential-backoff loop that retries on 429 / "Quota exceeded" / "Rate Limit Exceeded" up to 20 times.
- **Cell encoding.** `src/utils.ts` `encodeCellValue` stringifies plain objects/arrays as JSON and converts `Date` to a locale string before writing. Reads attempt to JSON-parse strings that look like object/array literals.
- **`tslib`.** Listed in devDependencies and emitted into the bundle by `@rollup/plugin-typescript`'s `importHelpers`-style emit; consumers don't need to install it themselves.
