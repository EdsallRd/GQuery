# GQuery 2.0 architecture

GQuery is split into independently testable layers:

1. Schema and codecs define logical properties, physical headers, keys, relations, cache policy, and deterministic cell representations. Formula intent is explicit in the `formula()` codec, so `=`-prefixed text is never guessed or reinterpreted.
2. Immutable query ASTs normalize typed object predicates and produce stable fingerprints.
3. The executor resolves lazy sources, batches workbook reads, validates headers and cardinality, decodes rows, and retains physical provenance.
4. Selections expose serializable rows while hiding spreadsheet, sheet, row, key, version, header, and relation provenance.
5. Mutation planning performs a targeted header/key/version preflight, compacts adjacent cells and bottom-up deletes, and emits atomic same-workbook batches.
6. Infrastructure provides deadline-scoped retries, generation-keyed chunked caches, trigger coordination, and a bounded durable deferred journal.
7. Schema management audits before writing, requires a full backup, adds hidden version/system state explicitly, and can backfill legacy encodings.

The production transport uses the Advanced Sheets v4 service. `InMemorySheetsTransport` implements the same contract, records calls, and rolls back failed atomic batches for deterministic tests.

## Consistency boundary

One `Spreadsheets.batchUpdate` is atomic inside a workbook. A read followed by a write is not a database transaction, so mutable tables should declare a version column. GQuery verifies the row key and version immediately before committing. Locks coordinate participating Apps Script writers; external API writers and simultaneous human edits cannot receive database-level compare-and-set guarantees.

Cross-workbook work is an ordered saga. Its receipt identifies committed and failed workbooks.

## Cache boundary

Caching is disabled unless a table declares a policy. Cache keys include source identity, schema/column shape, scope identity, the durable table generation, and generations for any schema-declared `cache.tags`. Writes and edit/change triggers rotate generations, making old entries unreachable. Applications can also rotate table, primary-key row, or declared tag generations through `db.cache.invalidateTable()`, `invalidateRow()`, and `invalidateTag()` after out-of-band changes. Row invalidation rotates the table generation as well because current row caches are table snapshots; undeclared tags are rejected. These methods require a configured durable generation store. Payloads are checksum-verified, gzip/base64 encoded, chunked below CacheService limits, and published manifest-last.

## Deferred boundary

The journal is authoritative and stored in sharded ScriptProperties. It accepts only JSON-safe, key-addressed, idempotent operations within strict capacity limits. Flushes rebuild the cache overlay, coalesce compatible mutations, preserve actor/version metadata, and retain transient failures. Version conflicts move to `_gq_dead_letters`.
