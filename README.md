# GQuery 2.0

GQuery 2.0 is a schema-first, synchronous ORM for Google Sheets and Apps Script. It uses immutable query plans, deterministic codecs, provenance-bearing selections, explicit relation writes, atomic same-workbook batches, and an injectable transport for tests.

> `2.0.0-beta.0` is a clean break from 1.x. Existing applications should stay pinned to the maintained 1.x line until migrated. The archived 1.x guide is in [`docs/v1/README.md`](docs/v1/README.md).

## Setup

The beta is implemented in this repository but has not been published to npm. Enable the Advanced Google Sheets service in the Apps Script project, build GQuery, and install or link the local checkout while piloting:

```sh
npm ci
npm run build
npm install /absolute/path/to/gquery
```

The eventual published package version is `@edsallrd/gquery@2.0.0-beta.0`.

```ts
import {
  belongsTo,
  createGQuery,
  datetime,
  defineDatabase,
  enumeration,
  formula,
  source,
  structured,
  table,
  text,
} from "@edsallrd/gquery";

type AssetMetadata = { notes: string; inspectedAt?: Date };

const schema = defineDatabase({
  version: 2,
  sources: { main: source.activeSpreadsheet() },
  tables: {
    Assets: table({
      source: "main",
      sheet: "Assets",
      primaryKey: ["serial"],
      versionColumn: "_gq_version",
      columns: {
        serial: text({ header: "Serial" }),
        status: enumeration({
          header: "Status",
          values: ["Available", "Assigned", "Repair"],
        }),
        modelId: text({ header: "Model" }),
        purchasedAt: datetime({ header: "Purchased At" }),
        metadata: structured<AssetMetadata>({ header: "Metadata", formatVersion: 1 }),
      },
      relations: {
        model: belongsTo("Models", { local: "modelId", foreign: "id" }),
      },
      cache: {
        mode: "row-and-query",
        scope: "script",
        ttlSeconds: 300,
        jitterSeconds: 60,
        allowStaleOnQuota: true,
        indexes: [["serial"]],
        tags: ["inventory-dashboard"],
      },
    }),
    Models: table({
      source: "main",
      sheet: "Models",
      primaryKey: ["id"],
      versionColumn: "_gq_version",
      columns: {
        id: text({ header: "ID" }),
        name: text({ header: "Name" }),
      },
    }),
  },
});

export const db = createGQuery(schema);
```

Creating `db` does not open a spreadsheet. Execution starts only at methods such as `get()`, `count()`, `update()`, or `append()`.

## Query and mutate

```ts
const query = db.Assets.where({
  status: { $in: ["Available", "Repair"] },
  $or: [
    { modelId: "M100" },
    { modelId: "M200" },
  ],
});

const result = query.include("model").get();

// The selection keeps hidden physical provenance and verifies key/version cells.
const assetWrite = result.update({ status: "Available" });

// Related rows are always an explicit mutation target.
const modelWrite = result.related("model").update({ name: "apples" });

// Query plans and selections remain reusable and immutable.
const refreshed = query.get();
```

`whereLocal(row => ...)` remains available for arbitrary callbacks. It is deliberately reported as a full local scan and is not persistently query-cacheable.

## Batched reads and atomic work

```ts
const snapshot = db.batch({
  assets: db.Assets.all(),
  models: db.Models.all(),
}).get();

const receipt = db.unitOfWork({ lock: "auto", timeoutMs: 30_000 }, tx => {
  tx.Assets.where({ serial: "SX5GN1" }).maybeOne()
    .update({ status: "Assigned" });

  tx.Models.where({ id: "M100" }).maybeOne()
    .update({ name: "Assigned model" });
});
```

When uncached reads are required, the batch reader performs at most one `Values.batchGet` per workbook. A unit of work stages and validates all changes, provides read-your-writes for selected rows, performs one targeted version preflight, and emits one atomic `Spreadsheets.batchUpdate` per workbook. Cross-workbook receipts report partial progress instead of claiming rollback.

## Operations

```ts
const plan = db.Assets.where({ status: "Repair" }).explain();
const migration = db.schema.plan();              // read-only audit
db.schema.migrate({ confirm: true, createBackups: true });
db.schema.migrate({
  confirm: true,
  createBackups: true,
  includeBackfill: true,
});
// Verify that plan() reports no errors, legacy cells, or pending actions.
db.schema.plan();
db.schema.activateStrictCanonical({ confirm: true });
// Operational rollback switch; it does not rewrite workbook cells.
db.schema.rollbackStrictCanonical({ confirm: true });

// Rotate durable generations after an out-of-band write or external refresh.
db.cache.invalidateTable("Assets");
db.cache.invalidateRow("Assets", "SX5GN1");
db.cache.invalidateTag("inventory-dashboard");

db.system.reconcileTriggers({
  onEdit: "gqueryOnEdit",
  onChange: "gqueryOnChange",
  flush: { handler: "gqueryFlush", everyMinutes: 5 },
});

const requestId = Utilities.getUuid();
const queued = db.Assets.where({ serial: "SX5GN1" }).maybeOne().update(
  { status: "Available" },
  { delivery: "deferred", idempotencyKey: requestId },
);

db.deferred.flush();
```

Immediate write-through is the default. Deferred delivery accepts one key-addressed, idempotent patch, delete, caller-keyed create, or upsert per call and uses a leased, sharded ScriptProperties journal; CacheService is only a rebuildable overlay. A flush groups compatible work by workbook, performs one authoritative batch read, and commits one atomic write batch. Conflicts are retained as idempotent receipts and moved to the protected `_gq_dead_letters` sheet.

Caller-keyed creates and upserts can also be deferred. Each call must contain exactly one row, declare a primary key, and provide an idempotency key:

```ts
db.Assets.append(newAsset, {
  delivery: "deferred",
  idempotencyKey: `create:${newAsset.serial}`,
});

db.Assets.upsertMany([replacementAsset], {
  delivery: "deferred",
  idempotencyKey: `upsert:${replacementAsset.serial}:${requestId}`,
});
```

`allowStaleOnQuota` is deliberately opt-in. Stale snapshots are considered only after a typed quota/rate-limit failure, and the fallback appears in result statistics and `.explain()` warnings. A custom cache adapter is accepted only with a durable generation adapter; document/user scopes also require a non-empty scope identity.

For tables without a runtime snapshot cache, projected and aggregate reads narrow to predicate, projection, ordering, key, version, and relation columns after the header registry has been validated. Indexed equality reads narrow both rows and columns. A projected mutation fetches only missing cells for its already matched rows before validation; it does not repeat the original table scan. The first cold read remains complete because GQuery cannot safely assume physical column order before validating headers. Cache-enabled tables currently read or populate complete generation-keyed snapshots; a cache hit makes no Sheets read, but cache misses do not use partial column payloads.

Atomic requests above GQuery's 1.8 MB safety threshold fail with `REQUEST_TOO_LARGE` before reaching Sheets. Automatic splitting is intentionally unavailable for a same-workbook atomic commit because splitting would break its all-or-nothing guarantee; callers must chunk independent work into separate units of work. Idempotent low-level `db.raw.values.batchUpdate()` calls are split below the same ceiling.

Low-level typed Values operations are available under `db.raw.values`. High-level formulas are schema-explicit:

```ts
columns: {
  label: text({ header: "Label" }),
  total: formula({ header: "Total" }),
}

db.Calculations.append({
  label: "=this remains literal text",
  total: "=SUM(B2:B10)",
});
```

Formula columns are read with the Sheets `FORMULA` render option and written as `userEnteredValue.formulaValue`; ordinary text beginning with `=` is always written as a literal string.

### Beta boundaries

This source beta does not yet expose cursor tokens or a GViz/SQL-style expert query escape hatch; use immutable `offset()`/`limit()`/`tail()` plans and `db.raw.values` respectively. Declared column formats are applied atomically to changed existing cells with leaf-level field masks. High-level append formatting and migration-time reconciliation of untouched legacy cells are not yet implemented: one global `AppendCells` mask could otherwise erase sibling-column formatting. The low-level append transport rejects partial format matrices and accepts only a preservation-safe uniform leaf mask. Unindexed limited queries still scan all matching row ranges; chunked early-stop scans are planned before stable 2.0. Same-workbook writes remain safely rejected rather than silently split when their compiled atomic request exceeds the safety ceiling.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/migrating-from-1.x.md`](docs/migrating-from-1.x.md) for platform details and migration guidance.
