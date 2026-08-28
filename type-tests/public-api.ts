import {
  belongsTo,
  createGQuery,
  defineDatabase,
  formula,
  integer,
  source,
  table,
  text,
} from "../src";
import { InMemorySheetsTransport } from "../src/v2/transport";

const schema = defineDatabase({
  version: 2,
  sources: { main: source.byId("type-test") },
  tables: {
    Assets: table({
      source: "main",
      sheet: "Assets",
      primaryKey: ["serial", "site"],
      columns: {
        serial: text({ header: "Serial" }),
        site: text({ header: "Site" }),
        modelId: text({ header: "Model" }),
      },
      relations: {
        model: belongsTo("Models", { local: "modelId", foreign: "id" }),
      },
    }),
    Models: table({
      source: "main",
      sheet: "Models",
      primaryKey: ["id"],
      columns: {
        id: text({ header: "ID" }),
        name: text({ header: "Name" }),
        cost: integer({ header: "Cost" }),
        display: formula({ header: "Display" }),
      },
    }),
  },
});

const db = createGQuery(schema, { transport: new InMemorySheetsTransport() });
const filtered = db.Assets.where({ serial: { $startsWith: "SX" }, site: { $in: ["A", "B"] } });
const included = filtered.include("model").get();
included.rows[0].model?.cost.toFixed();
included.related("model").update({ name: "renamed" });
included.update((draft) => ({ modelId: draft.model?.id ?? draft.modelId }));
// @ts-expect-error related aliases require explicit related(name).update(...)
included.update({ model: { id: "m2", name: "Tablet", cost: 400, display: "=B2" } });
db.Assets.find({ serial: "SX1", site: "A" });
db.Assets.select(["serial", "site"] as const).get().rows[0].serial.toUpperCase();

const batch = db.batch({
  assets: filtered,
  models: db.Models.where({ cost: { $gte: 100 } }),
}).get();
batch.assets.rows[0].serial.toUpperCase();
batch.models.rows[0].cost.toFixed();
batch.models.rows[0].display.toUpperCase();
db.Models.where({ id: "m1" }).get().update({ display: "=A2&\" model\"" });
db.Models.where({ name: { $isNull: false } });
db.Models.append(
  { id: "m2", name: "Tablet", cost: 400, display: "=B2" },
  { delivery: "deferred", idempotencyKey: "create-m2" },
);
db.Models.upsertMany(
  [{ id: "m2", name: "Tablet", cost: 450, display: "=B2" }],
  { delivery: "deferred", idempotencyKey: "upsert-m2" },
);

const projectedInner = db.Assets.join(db.Models, {
  as: "modelInfo",
  on: { local: "modelId", foreign: "id" },
  kind: "inner",
  select: ["name"] as const,
}).get().rows[0];
projectedInner.modelInfo.name.toUpperCase();
// @ts-expect-error join projection omits unselected target fields
projectedInner.modelInfo.cost.toFixed();

const manyModels = db.Assets.join(db.Models, {
  as: "models",
  on: { local: "modelId", foreign: "id" },
  cardinality: "many",
}).get().rows[0];
manyModels.models[0].cost.toFixed();

const withoutModels = db.Assets.join(db.Models, {
  as: "model",
  on: { local: "modelId", foreign: "id" },
  kind: "anti",
}).get().rows[0];
withoutModels.serial.toUpperCase();
// @ts-expect-error semi/anti joins filter the base and do not materialize aliases
withoutModels.model;

db.cache.invalidateTable("Assets");
db.cache.invalidateRow("Assets", { serial: "SX1", site: "A" });
db.cache.invalidateRow("Models", "m1");
db.cache.invalidateTag("inventory");

// @ts-expect-error unknown schema field
db.Assets.where({ unknown: "nope" });
// @ts-expect-error enum/column operators preserve value types
db.Models.where({ cost: { $gte: "100" } });
// @ts-expect-error mutation patches cannot target unknown columns
db.Models.where({ id: "m1" }).get().update({ missing: true });
// @ts-expect-error cache invalidation accepts only declared table names
db.cache.invalidateTable("Missing");
// @ts-expect-error composite row keys require every primary-key field
db.cache.invalidateRow("Assets", { serial: "SX1" });
// @ts-expect-error one-column row keys use the column's decoded scalar type
db.cache.invalidateRow("Models", { id: "m1" });
