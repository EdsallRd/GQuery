# GQuery 2.0 architecture

GQuery is split into independently testable layers:

1. Schema and codecs define logical properties, physical headers, keys, relations, cache policy, and deterministic cell representations. Formula intent is explicit in the `formula()` codec, so `=`-prefixed text is never guessed or reinterpreted.
2. Immutable query ASTs normalize typed object predicates and produce stable fingerprints.
3. The executor resolves lazy sources, batches workbook reads, validates headers and cardinality, narrows warm projected reads to planner-required columns, decodes rows, and retains physical provenance.
4. Selections expose serializable rows while hiding spreadsheet, sheet, row, key, version, header, and relation provenance.
5. Mutation planning performs a targeted header/key/version preflight, compacts adjacent cells and bottom-up deletes, and emits atomic same-workbook batches.
6. Infrastructure provides deadline-scoped retries, generation-keyed chunked caches, trigger coordination, and a bounded durable deferred journal.
7. Schema management audits before writing, requires a full backup, adds hidden version/system state explicitly, and can backfill legacy encodings.

The production transport uses the Advanced Sheets v4 service. `InMemorySheetsTransport` implements the same contract, records calls, and rolls back failed atomic batches for deterministic tests.

## Consistency boundary

One `Spreadsheets.batchUpdate` is atomic inside a workbook. A read followed by a write is not a database transaction, so mutable tables should declare a version column. GQuery verifies the row key and version immediately before committing. Locks coordinate participating Apps Script writers; external API writers and simultaneous human edits cannot receive database-level compare-and-set guarantees.

Cross-workbook work is an ordered saga. Its receipt identifies committed and failed workbooks.

## Cache boundary

Caching is disabled unless a table declares a policy. `row` caches share a physical table snapshot and locator indexes. `query` currently stores a complete physical table snapshot under a normalized query-specific key; it isolates reuse and invalidation but is not yet a filtered result cache. `row-and-query` publishes both forms. Query keys include source identity, schema/header shape, projection and render options, scope identity, and table/tag generations for every base and joined dependency. `whereLocal()` never receives a persistent query key.

Injected cache adapters must be paired with a durable generation adapter. Document/user-scoped caches additionally require a non-empty scope identity resolver, preventing cross-principal cache reuse and deterministic post-write staleness.

Writes and edit/change triggers rotate generations, making old entries unreachable. Applications can also rotate table, primary-key row, or declared tag generations through `db.cache.invalidateTable()`, `invalidateRow()`, and `invalidateTag()` after out-of-band changes. Row invalidation rotates the table generation as well because row caches are table snapshots; undeclared tags are rejected. These methods require a configured durable generation store.

Payloads are checksum-verified, gzip/base64 encoded, chunked below CacheService limits, and published manifest-last. Cold snapshot fills use a bounded single-flight lock. `allowStaleOnQuota` is opt-in; when enabled, the executor may use a validated stale generation only after a typed quota/rate-limit failure and records that decision in stats and `.explain()` warnings.

## Deferred boundary

The journal is authoritative and stored in sharded ScriptProperties. It accepts only JSON-safe, key-addressed, idempotent operations within strict capacity limits. CacheService is a rebuildable read-your-writes overlay, never the source of truth.

A flush takes a short durable lease while holding ScriptLock, releases the lock before remote I/O, and reconciles only if it still owns that lease. This permits concurrent enqueues without losing them and lets a later trigger recover an expired lease. Compatible entries are grouped by workbook, read once with caches and overlays bypassed, then compiled into one atomic write batch. Actor/version metadata and idempotency receipts are retained; transient failures remain queued and mapped conflicts move once to `_gq_dead_letters`.

## Operational boundary

Schema migration audits and repairs partially created system sheets instead of assuming setup completed atomically. `_gq_meta` and `_gq_dead_letters` must have their required cells and full-sheet protections before migration is considered complete. Trigger reconciliation persists the trigger IDs it owns, so renamed or removed GQuery handlers can be cleaned up without deleting unrelated project triggers.

The Apps Script and in-memory transports reject compiled atomic request payloads above the 1.8 MB safety threshold with `REQUEST_TOO_LARGE`. An atomic same-workbook commit is not automatically split because doing so would discard the API's all-or-nothing guarantee. Callers must divide independent work into separate units of work; the guard prevents an oversized request from reaching Sheets and leaves the rejected unit uncommitted. The Apps Script transport does automatically split idempotent low-level Values `batchUpdate` calls below this ceiling.

`_gq_meta` is the authoritative canonical-mode and migration-state store. ScriptProperties can mirror it for fast access, but missing, divergent, or malformed property state is reconciled from the protected sheet rather than overriding it.

## Planner boundary

Cold reads validate the complete physical header/table shape. For tables without a runtime snapshot cache, projected and aggregate reads then request only the predicate, projection, ordering, primary/unique/index, version, and relation-key columns needed by the plan. Indexed equality locators narrow the physical rows as well. Runtime cache misses intentionally stay complete so GQuery never publishes a partial matrix as a table snapshot; cache hits avoid Sheets entirely. Mutating a projected selection hydrates only its missing matched-row cells before constraints and writes are compiled.

The current beta still performs an all-row scan for unindexed limited predicates; chunked early-stop scanning is not implemented. Cursor tokens and an expert GViz query surface are also deferred. `ColumnDefinition.format` is compiled with leaf-level masks into the same atomic request for changed existing cells. High-level append formatting and migration-time reconciliation for untouched legacy cells are deferred; the raw append transport rejects partial format matrices because `AppendCells` exposes one mask for every appended cell.
