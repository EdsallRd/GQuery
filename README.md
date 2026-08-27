# GQuery 2.0

GQuery 2.0 is a schema-first, synchronous ORM for Google Sheets and Apps Script. It uses immutable query plans, deterministic codecs, provenance-bearing selections, explicit relation writes, atomic same-workbook batches, and an injectable transport for tests.

> `2.0.0-beta.0` is a clean break from 1.x. Existing applications should stay pinned to the maintained 1.x line until migrated. The archived 1.x guide is in [`docs/v1/README.md`](docs/v1/README.md).

## Setup

Enable the Advanced Google Sheets service in the Apps Script project, then install the beta:

```sh
npm install @edsallrd/gquery@2.0.0-beta.0
```

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

  tx.Audit.append({ id: Utilities.getUuid(), message: "assigned SX5GN1" });
});
```

The batch reader performs one `Values.batchGet` per workbook. A unit of work stages and validates all changes, provides read-your-writes for selected rows, performs one targeted version preflight, and emits one atomic `Spreadsheets.batchUpdate` per workbook. Cross-workbook receipts report partial progress instead of claiming rollback.

## Operations

```ts
const plan = db.Assets.where({ status: "Repair" }).explain();
const migration = db.schema.plan();              // read-only audit
db.schema.migrate({ confirm: true, createBackups: true });

// Rotate durable generations after an out-of-band write or external refresh.
db.cache.invalidateTable("Assets");
db.cache.invalidateRow("Assets", "SX5GN1");
db.cache.invalidateTag("inventory-dashboard");

db.system.reconcileTriggers({
  onEdit: "gqueryOnEdit",
  onChange: "gqueryOnChange",
  flush: { handler: "gqueryFlush", everyMinutes: 5 },
});

const queued = db.Assets.where({ serial: "SX5GN1" }).maybeOne().update(
  { status: "Available" },
  { delivery: "deferred", idempotencyKey: requestId },
);

db.deferred.flush();
```

Immediate write-through is the default. Deferred delivery is restricted to one key-addressed, idempotent patch/delete per call and uses a ScriptProperties journal; CacheService is only an overlay.

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

See [`docs/architecture.md`](docs/architecture.md) and [`docs/migrating-from-1.x.md`](docs/migrating-from-1.x.md) for platform details and migration guidance.
