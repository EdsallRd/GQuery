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
5. Enable dual decoding and canonical writes, then run an explicit backfill after reviewing the plan.
6. Verify row counts, keys, relations, DTOs, and application-level shadow comparisons.
7. Cut over behind a feature flag and keep the 1.x rollback path until the observation window passes.

