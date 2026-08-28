# Migrating from GQuery 1.x

GQuery 2.0 intentionally does not provide a v1 compatibility facade. Keep production callers pinned to 1.x while migrating one application at a time.

## API mapping

| 1.x | 2.0 |
| --- | --- |
| `new GQuery(id).from("Assets")` | `createGQuery(schema).Assets` |
| callback `.where(row => ...)` | typed object `.where({...})`; arbitrary callbacks use `.whereLocal(...)` |
| mutable factory chains | immutable, reusable `Query` values |
| plain `{rows, headers}` result | immutable `Selection` with hidden provenance |
| flat `.join(...)` fields | declared `.include(name)` or nested ad hoc `.join(...)` |
| base/joined writes mixed together | base `selection.update()` or explicit `selection.related(name).update()` |
| `getMany(["A", "B"])` | typed `db.batch({a: db.A.all(), b: db.B.all()}).get()` |
| heuristic values/date conversion | schema-directed deterministic codecs |
| per-call retries | one deadline-aware retry budget per operation |

## Data sequence

1. Add every existing physical header to a v2 schema using logical property names plus `header` mappings.
2. Register legacy decoders for historical booleans, dates, identifiers, JSON, and blank conventions.
3. Run `db.schema.plan()` and resolve every ambiguous or invalid cell without writing.
4. Run `db.schema.migrate({confirm: true, createBackups: true})` to take a full copy, create system sheets, and add hidden row-version columns.
5. Enable dual decoding and canonical writes, then run the reviewed canonical backfill with `db.schema.migrate({confirm: true, createBackups: true, includeBackfill: true})`.
6. Verify row counts, keys, relations, DTOs, and application-level shadow comparisons; rerun `schema.plan()` until it reports no legacy cells or pending actions.
7. Call `db.schema.activateStrictCanonical({confirm: true})`. This is an explicit, audit-gated switch; use `rollbackStrictCanonical({confirm: true})` to restore dual decoding without rewriting cells.
8. Cut over behind a feature flag and keep the 1.x rollback path until the observation window passes.

The beta backfill is idempotent but currently applied in one migration invocation; checkpoint/resume controls are not yet public. For large workbooks, keep strict mode disabled, split legacy cleanup operationally, and rerun the audit before invoking the final backfill and strict-mode gate.
