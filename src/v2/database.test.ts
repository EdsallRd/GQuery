import { describe, expect, it } from "vitest";
import { enumeration, formula, integer, nullable, text } from "./codecs";
import { createGQuery } from "./database";
import { defineDatabase, belongsTo, source, table } from "./schema";
import { InMemorySheetsTransport } from "./transport";
import { DeferredJournal } from "./infrastructure/deferred";
import { Fnv1aHash } from "./infrastructure/canonical";
import type { PropertyStore } from "./infrastructure/runtime";

class TestProperties implements PropertyStore {
  private readonly values = new Map<string, string>();
  get(key: string) { return this.values.get(key) ?? null; }
  getMany() { return Object.fromEntries(this.values); }
  set(key: string, value: string) { this.values.set(key, value); }
  setMany(values: Readonly<Record<string, string>>) { Object.entries(values).forEach(([key, value]) => this.values.set(key, value)); }
  remove(key: string) { this.values.delete(key); }
  removeMany(keys: readonly string[]) { keys.forEach((key) => this.values.delete(key)); }
}

const schema = defineDatabase({
  version: 2,
  sources: { main: source.byId("book") },
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
        modelId: nullable(text({ header: "Model" })),
      },
      relations: {
        model: belongsTo("Models", { local: "modelId", foreign: "id" }),
      },
      cache: {
        mode: "row-and-query",
        scope: "script",
        ttlSeconds: 300,
        indexes: [["serial"]],
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
        cost: integer({ header: "Cost" }),
      },
    }),
    Audit: table({
      source: "main",
      sheet: "Audit",
      appendOnly: true,
      primaryKey: ["id"],
      columns: {
        id: text({ header: "ID" }),
        message: text({ header: "Message" }),
      },
    }),
  },
});

function setup() {
  const transport = new InMemorySheetsTransport([{
    spreadsheetId: "book",
    sheets: [
      {
        sheetId: 1,
        title: "Assets",
        values: [
          ["Serial", "Status", "Model", "_gq_version"],
          ["SX5GN1", "Assigned", "m1", 3],
          ["SX5GN2", "Repair", "m1", 1],
          ["SX5GN3", "Available", null, 1],
        ],
      },
      {
        sheetId: 2,
        title: "Models",
        values: [
          ["ID", "Name", "Cost", "_gq_version"],
          ["m1", "Laptop", 900, 4],
          ["m2", "Tablet", 400, 1],
        ],
      },
      {
        sheetId: 3,
        title: "Audit",
        values: [["ID", "Message"]],
      },
    ],
  }]);
  return { transport, gq: createGQuery(schema, { transport }) };
}

describe("GQuery 2.0 database runtime", () => {
  it("round-trips formula columns while writing =-prefixed text literally", () => {
    const formulaSchema = defineDatabase({
      version: 2,
      sources: { main: source.byId("formula-book") },
      tables: {
        Calculations: table({
          source: "main",
          sheet: "Calculations",
          primaryKey: ["id"],
          versionColumn: "_gq_version",
          columns: {
            id: text({ header: "ID" }),
            label: text({ header: "Label" }),
            expression: formula({ header: "Expression" }),
          },
        }),
      },
    });
    const transport = new InMemorySheetsTransport([{
      spreadsheetId: "formula-book",
      sheets: [{
        sheetId: 9,
        title: "Calculations",
        values: [["ID", "Label", "Expression", "_gq_version"]],
      }],
    }]);
    const gq = createGQuery(formulaSchema, { transport });

    gq.Calculations.append({
      id: "calc-1",
      label: "=literal text",
      expression: "=SUM(A1:A3)",
    });
    expect(transport.snapshot("formula-book").sheets[0].values[1]).toEqual([
      "calc-1",
      "=literal text",
      { __gqueryFormulaCell: true, expression: "=SUM(A1:A3)" },
      1,
    ]);

    transport.clearHistory();
    const selected = gq.Calculations.all().get();
    expect(selected.rows[0]).toEqual({
      id: "calc-1",
      label: "=literal text",
      expression: "=SUM(A1:A3)",
    });
    expect(transport.history.find((call) => call.kind === "batchGet")?.valueRenderOption)
      .toBe("FORMULA");

    transport.clearHistory();
    selected.update({ expression: "=A2*2" });
    expect(transport.history[0].valueRenderOption).toBe("FORMULA");
    expect(transport.snapshot("formula-book").sheets[0].values[1]?.[2]).toEqual({
      __gqueryFormulaCell: true,
      expression: "=A2*2",
    });

    transport.clearHistory();
    expect(gq.schema.plan().invalidCells).toBe(0);
    expect(transport.history.find((call) => call.kind === "batchGet")?.valueRenderOption)
      .toBe("FORMULA");
  });

  it("creates lazy table handles and immutable reusable plans", () => {
    const { transport, gq } = setup();
    expect(transport.history).toHaveLength(0);
    expect(gq.Assets).toBe(gq.tables.Assets);

    const base = gq.Assets.where({ modelId: "m1" });
    const assigned = base.where({ status: "Assigned" });
    const repair = base.where({ status: "Repair" });
    expect(assigned.get().rows.map((row) => row.serial)).toEqual(["SX5GN1"]);
    expect(repair.get().rows.map((row) => row.serial)).toEqual(["SX5GN2"]);
    expect(base.get().length).toBe(2);
  });

  it("materializes nested relations and explicitly mutates the related row", () => {
    const { transport, gq } = setup();
    const result = gq.Assets.where({ serial: "SX5GN1" }).include("model").get();
    expect(result.rows[0].model?.name).toBe("Laptop");

    transport.clearHistory();
    const mutation = result.related("model")
      .update({ name: "apples" });
    expect(mutation.status).toBe("committed");
    expect(mutation.changedCells).toBe(2); // name plus row version
    expect(transport.history.map((call) => call.kind)).toEqual([
      "batchGet",
      "atomicBatchUpdate",
    ]);
    expect(transport.snapshot("book").sheets[1].values[1]).toEqual([
      "m1", "apples", 900, 5,
    ]);
  });

  it("ignores unchanged include/join aliases in callback base-row updates", () => {
    const includedSetup = setup();
    const included = includedSetup.gq.Assets
      .where({ serial: "SX5GN1" })
      .include("model")
      .get();
    expect(included.update((draft) => ({
      ...draft,
      status: "Available",
    })).status).toBe("committed");

    const joinedSetup = setup();
    const joined = joinedSetup.gq.Assets
      .where({ serial: "SX5GN1" })
      .join(joinedSetup.gq.Models, {
        as: "joinedModel",
        on: { local: "modelId", foreign: "id" },
        kind: "left",
        cardinality: "one",
      })
      .get();
    expect(joined.update((draft) => ({
      ...draft,
      status: "Available",
    })).status).toBe("committed");
    expect(() => joined.update(() => ({ rogue: true } as never)))
      .toThrow(/unknown mutation column/i);
  });

  it("updates a selection with a targeted preflight and never reruns its table scan", () => {
    const { transport, gq } = setup();
    const query = gq.Assets.where({ serial: "SX5GN1" });
    const result = query.get();
    transport.clearHistory();

    const mutation = result.update({ status: "Available" });
    expect(mutation.status).toBe("committed");
    expect(mutation.matchedCount).toBe(1);
    expect(mutation.changedCells).toBe(2);
    expect(transport.history.map((call) => call.kind)).toEqual([
      "batchGet",
      "atomicBatchUpdate",
    ]);
    expect(transport.history[0].ranges).toEqual([
      "'Assets'!1:1",
      "'Assets'!A2:D2",
    ]);
    expect(transport.snapshot("book").sheets[0].values[1]).toEqual([
      "SX5GN1", "Available", "m1", 4,
    ]);
    expect(query.get().rows[0].status).toBe("Available");
  });

  it("supports mutable update drafts without mutating the original selection", () => {
    const { gq } = setup();
    const selected = gq.Assets.where({ serial: "SX5GN1" }).maybeOne();
    const mutation = selected.update((draft) => {
      draft.status = "Available";
    });

    expect(selected.rows[0]?.status).toBe("Assigned");
    expect(mutation.after?.rows[0]?.status).toBe("Available");
  });

  it("returns a structured conflict when the selected version becomes stale", () => {
    const { transport, gq } = setup();
    const result = gq.Assets.where({ serial: "SX5GN1" }).get();
    transport.atomicBatchUpdate("book", [{
      kind: "updateCells",
      sheetId: 1,
      startRowIndex: 1,
      startColumnIndex: 3,
      values: [[9]],
    }]);
    transport.clearHistory();

    const mutation = result.update({ status: "Available" });
    expect(mutation.status).toBe("conflicted");
    expect(mutation.conflicts[0].code).toBe("version-changed");
    expect(transport.history.filter((call) => call.kind === "batchGet"))
      .toHaveLength(1);
  });

  it("coalesces heterogeneous snapshots into one Values batchGet per workbook", () => {
    const { transport, gq } = setup();
    const snapshot = gq.batch({
      assets: gq.Assets.where({ status: { $in: ["Available", "Repair"] } }),
      models: gq.Models.all(),
    }).get();
    expect(snapshot.assets.length).toBe(2);
    expect(snapshot.models.length).toBe(2);
    expect(transport.history.filter((call) => call.kind === "batchGet")).toHaveLength(1);
    expect(transport.history.find((call) => call.kind === "batchGet")?.ranges).toEqual([
      "'Assets'",
      "'Models'",
    ]);
  });

  it("supports anti joins without flattening joined columns", () => {
    const { gq } = setup();
    const withoutModel = gq.Assets.join(gq.Models, {
      as: "model",
      on: { local: "modelId", foreign: "id" },
      kind: "anti",
    }).get();
    expect(withoutModel.rows.map((row) => row.serial)).toEqual(["SX5GN3"]);
    expect("model" in withoutModel.rows[0]).toBe(false);
  });

  it("stages read-your-writes changes and commits one same-workbook atomic batch", () => {
    const { transport, gq } = setup();
    const receipt = gq.unitOfWork({ lock: "auto" }, (tx) => {
      const asset = tx.Assets.where({ serial: "SX5GN1" }).maybeOne();
      expect(asset.update({ status: "Available" }).status).toBe("queued");
      expect(tx.Assets.where({ serial: "SX5GN1" }).maybeOne().rows[0].status).toBe("Available");
      expect(tx.Assets.where({ status: "Assigned" }).get().rows).toHaveLength(0);
      expect(tx.Assets.where({ status: "Available" }).get().rows.map((row) => row.serial))
        .toEqual(["SX5GN1", "SX5GN3"]);
      expect(tx.Audit.append({ id: "event-1", message: "asset released" }).status).toBe("queued");
      const stagedAudit = tx.Audit.where({ id: "event-1" }).maybeOne();
      expect(stagedAudit.rows[0]).toEqual({ id: "event-1", message: "asset released" });
      stagedAudit.update({ message: "asset available" });
      expect(tx.Audit.where({ id: "event-1" }).maybeOne().rows[0]?.message)
        .toBe("asset available");
      return "done";
    });

    expect(receipt.status).toBe("committed");
    expect(receipt.value).toBe("done");
    const atomicCalls = transport.history.filter((call) => call.kind === "atomicBatchUpdate");
    expect(atomicCalls).toHaveLength(1);
    expect(atomicCalls[0].requestCount).toBe(3); // two non-adjacent cells plus one append
    expect(transport.snapshot("book").sheets[0].values[1]).toEqual([
      "SX5GN1", "Available", "m1", 4,
    ]);
    expect(transport.snapshot("book").sheets[2].values[1]).toEqual([
      "event-1", "asset available",
    ]);
  });

  it("collapses repeated row updates and can cancel a staged append", () => {
    const { transport, gq } = setup();
    const result = gq.unitOfWork((tx) => {
      const held = tx.Assets.find("SX5GN1");
      held.update({ status: "Repair" });
      held.update({ modelId: null });
      expect(tx.Assets.find("SX5GN1").rows[0]).toMatchObject({
        status: "Repair",
        modelId: null,
      });
      tx.Assets.find("SX5GN1").update({ status: "Available" });

      tx.Audit.append({ id: "cancelled", message: "not committed" });
      const staged = tx.Audit.find("cancelled");
      expect(staged.length).toBe(1);
      staged.delete();
      expect(tx.Audit.find("cancelled").length).toBe(0);
    });

    expect(result.status).toBe("committed");
    expect(gq.Assets.find("SX5GN1").rows[0]).toMatchObject({
      status: "Available",
      modelId: null,
    });
    expect(transport.snapshot("book").sheets[2].values).toEqual([["ID", "Message"]]);
  });

  it("compiles updates before bottom-up deletes so row shifts cannot retarget writes", () => {
    const { transport, gq } = setup();
    transport.clearHistory();

    const result = gq.unitOfWork((tx) => {
      // Deliberately stage the upper-row deletion first. Applying it before the
      // update would shift SX5GN2 from physical row 3 to row 2.
      tx.Assets.find("SX5GN1").delete();
      tx.Assets.find("SX5GN2").update({ status: "Available" });
    });

    expect(result.status).toBe("committed");
    expect(transport.history.filter(({ kind }) => kind === "atomicBatchUpdate"))
      .toHaveLength(1);
    expect(transport.snapshot("book").sheets[0].values).toEqual([
      ["Serial", "Status", "Model", "_gq_version"],
      ["SX5GN2", "Available", "m1", 2],
      ["SX5GN3", "Available", null, 1],
    ]);
  });

  it("resolves unit-of-work callback patches once while staging", () => {
    const { gq } = setup();
    let callbackCalls = 0;
    const result = gq.unitOfWork((tx) => {
      tx.Assets.find("SX5GN1").update((draft) => {
        callbackCalls += 1;
        draft.status = "Available";
      });
    });

    expect(result.status).toBe("committed");
    expect(callbackCalls).toBe(1);
    expect(gq.Assets.find("SX5GN1").rows[0]?.status).toBe("Available");
  });

  it("stages sync inside a unit of work and does not leak writes when the callback fails", () => {
    const { transport, gq } = setup();
    const before = transport.snapshot("book");
    transport.clearHistory();

    expect(() => gq.unitOfWork((tx) => {
      const sync = tx.Models.sync([
        { id: "m1", name: "Workstation", cost: 900 },
        { id: "m3", name: "Chromebook", cost: 250 },
      ], { missing: { action: "delete" } });
      expect(sync.status).toBe("queued");
      expect(tx.Models.all().get().rows.map((row) => row.id)).toEqual(["m1", "m3"]);
      throw new Error("abort transaction");
    })).toThrow("abort transaction");

    expect(transport.history.some((call) => call.kind === "atomicBatchUpdate")).toBe(false);
    expect(transport.snapshot("book")).toEqual(before);
  });

  it("syncs updates, inserts, and missing rows in one atomic workbook commit", () => {
    const { transport, gq } = setup();
    const result = gq.Models.sync([
      { id: "m1", name: "Workstation", cost: 1 },
      { id: "m3", name: "Chromebook", cost: 250 },
    ], {
      preserve: ["cost"],
      missing: { action: "delete" },
    });

    expect(result).toMatchObject({
      status: "committed",
      inserted: 1,
      updated: 1,
      unchanged: 0,
      deleted: 1,
      deactivated: 0,
      conflicted: 0,
    });
    expect(transport.history.map((call) => call.kind)).toEqual([
      "getSpreadsheetMetadata",
      "batchGet",
      "batchGet",
      "batchGet",
      "atomicBatchUpdate",
    ]);
    expect(transport.history.filter((call) => call.kind === "atomicBatchUpdate")).toHaveLength(1);
    expect(transport.snapshot("book").sheets[1].values).toEqual([
      ["ID", "Name", "Cost", "_gq_version"],
      ["m1", "Workstation", 900, 5],
      ["m3", "Chromebook", 250, 1],
    ]);
  });

  it("audits schema state read-only and gates explicit migration on a backup", () => {
    const { transport, gq } = setup();
    const before = transport.snapshot("book");
    const plan = gq.schema.plan();
    expect(plan.canMigrate).toBe(true);
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "create-system-sheet",
      "create-system-sheet",
    ]);
    expect(plan.tables.map((table) => ({ table: table.table, rows: table.decodedRows })))
      .toEqual([
        { table: "Assets", rows: 3 },
        { table: "Models", rows: 2 },
        { table: "Audit", rows: 0 },
      ]);
    expect(plan.tables.every((table) => table.decodedHash.length > 0)).toBe(true);
    expect(transport.snapshot("book")).toEqual(before);
    expect(() => gq.schema.migrate({ confirm: true })).toThrow(/backup/i);

    const applied: string[] = [];
    const migrated = gq.schema.migrate({
      confirm: true,
      backupIds: { book: "backup-copy" },
      adapter: {
        createBackup: () => "unused",
        apply: (spreadsheetId, actions) => applied.push(`${spreadsheetId}:${actions.length}`),
      },
    });
    expect(migrated.status).toBe("migrated");
    expect(migrated.backups.book).toBe("backup-copy");
    expect(applied).toEqual(["book:2"]);
  });

  it("audits unique-key duplicates and to-one relation cardinality", () => {
    const integritySchema = defineDatabase({
      version: 2,
      sources: { main: source.byId("integrity-book") },
      tables: {
        People: table({
          source: "main",
          sheet: "People",
          primaryKey: ["id"],
          unique: [["email"]],
          columns: {
            id: text({ header: "ID" }),
            email: text({ header: "Email" }),
          },
        }),
        Children: table({
          source: "main",
          sheet: "Children",
          primaryKey: ["id"],
          columns: {
            id: text({ header: "ID" }),
            parentEmail: text({ header: "Parent Email" }),
          },
          relations: {
            parent: belongsTo("People", {
              local: "parentEmail",
              foreign: "email",
              required: true,
            }),
          },
        }),
      },
    });
    const transport = new InMemorySheetsTransport([{
      spreadsheetId: "integrity-book",
      sheets: [
        {
          sheetId: 1,
          title: "People",
          values: [["ID", "Email"], ["p1", "same@example.test"], ["p2", "same@example.test"]],
        },
        {
          sheetId: 2,
          title: "Children",
          values: [["ID", "Parent Email"], ["c1", "same@example.test"]],
        },
      ],
    }]);

    const plan = createGQuery(integritySchema, { transport }).schema.plan();
    expect(plan.canMigrate).toBe(false);
    expect(plan.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "DUPLICATE_UNIQUE_KEY",
      "RELATION_CARDINALITY",
    ]));
  });

  it("routes manual edits through row and table generation invalidation", () => {
    const { transport } = setup();
    const tokens = new Map<string, string>();
    let sequence = 0;
    const generations = {
      current: (dependency:
        | { kind: "table"; sourceId: string; table: string }
        | { kind: "tag"; tag: string }
      ) => dependency.kind === "table"
        ? tokens.get(`${dependency.sourceId}:${dependency.table}`) ?? "0"
        : "0",
      invalidateTable: (sourceId: string, tableName: string) => {
        const token = `t${++sequence}`;
        tokens.set(`${sourceId}:${tableName}`, token);
        return token;
      },
      invalidateRow: () => `r${++sequence}`,
    };
    const gq = createGQuery(schema, {
      transport,
      generations,
      systemHooks: {
        onRowsEdited: () => [{ serial: "SX5GN1" }],
      },
    });
    const result = gq.system.handleEdit({
      sourceId: "book",
      sheetId: 1,
      rowStart: 2,
      rowCount: 1,
      columnStart: 2,
      columnCount: 1,
    });
    expect(result).toEqual({ invalidatedTables: ["Assets"], invalidatedRows: 1 });
    expect(gq.system.status().tables.find((table) => table.table === "Assets")?.generation).toBe("t1");
  });

  it("serves warm table snapshots from cache and rotates generations after writes", () => {
    const { transport } = setup();
    const cacheEntries = new Map<string, unknown>();
    const cache = {
      read: <T,>(key: unknown) => {
        const encoded = JSON.stringify(key);
        return cacheEntries.has(encoded)
          ? { state: "hit" as const, value: cacheEntries.get(encoded) as T }
          : { state: "miss" as const };
      },
      put: <T,>(key: unknown, value: T) => { cacheEntries.set(JSON.stringify(key), value); },
    };
    let generation = "0";
    const generations = {
      current: () => generation,
      invalidateTable: () => (generation = String(Number(generation) + 1)),
      invalidateRow: () => generation,
    };
    const gq = createGQuery(schema, { transport, cache, generations });
    const first = gq.Assets.where({ serial: "SX5GN1" }).get();
    expect(first.stats.cacheMisses).toBe(1);
    transport.clearHistory();
    const warm = gq.Assets.where({ serial: "SX5GN1" }).get();
    expect(warm.stats.cacheHits).toBe(1);
    expect(transport.history).toHaveLength(0);

    warm.update({ status: "Available" });
    transport.clearHistory();
    const refreshed = gq.Assets.where({ serial: "SX5GN1" }).get();
    expect(refreshed.stats.cacheMisses).toBe(1);
    expect(transport.history.map((call) => call.kind)).toEqual(["batchGet"]);
  });

  it("returns parsed rows when cache publication fails", () => {
    const { transport } = setup();
    const cache = {
      read: () => ({ state: "miss" as const }),
      put: () => { throw new Error("CacheService quota exceeded"); },
    };
    const gq = createGQuery(schema, { transport, cache });

    expect(gq.Assets.where({ serial: "SX5GN1" }).get().rows).toEqual([{
      serial: "SX5GN1",
      status: "Assigned",
      modelId: "m1",
    }]);
    expect(transport.history.filter((call) => call.kind === "batchGet"))
      .toHaveLength(1);
  });

  it("queues idempotent deferred patches durably and flushes them later", () => {
    const { transport } = setup();
    const properties = new TestProperties();
    let nextId = 0;
    const journal = new DeferredJournal({
      properties,
      lock: { tryAcquire: () => true, release: () => undefined },
      hasher: new Fnv1aHash(),
      ids: { next: () => `mutation-${++nextId}` },
      clock: { now: () => 1_000 },
    });
    const deadLetters: unknown[] = [];
    const gq = createGQuery(schema, {
      transport,
      deferredJournal: journal,
      deferredAppliedReceipts: properties,
      deferredDeadLetters: { write: (records) => deadLetters.push(...records) },
    });
    const selected = gq.Assets.where({ serial: "SX5GN1" }).maybeOne();
    transport.clearHistory();
    const queued = selected.update({ status: "Available" }, {
      delivery: "deferred",
      idempotencyKey: "request-123",
      actor: "scanner@example.edu",
    });
    expect(queued.status).toBe("queued");
    expect(gq.deferred.list()).toHaveLength(1);
    expect(transport.history).toHaveLength(0);

    const flushed = gq.deferred.flush();
    expect(flushed).toMatchObject({ attempted: 1, committed: 1, conflicted: 0, retained: 0 });
    expect(gq.deferred.receipt("request-123")?.status).toBe("committed");
    expect(deadLetters).toHaveLength(0);
    expect(transport.snapshot("book").sheets[0].values[1]).toEqual([
      "SX5GN1", "Available", "m1", 4,
    ]);
  });

  it("uses verified key locators and rebuilds them with a narrow key scan when stale", () => {
    const { transport, gq } = setup();
    gq.Models.all().get(); // builds the execution-local primary-key locator
    transport.clearHistory();
    const located = gq.Models.where({ id: "m1" }).get();
    expect(located.rows[0].name).toBe("Laptop");
    expect(located.stats.fullScans).toBe(0);
    expect(located.stats.rangesRead).toEqual(["'Models'!A2:D2"]);
    expect(gq.Models.where({ id: "m1" }).explain().mode).toBe("bounded");

    // An out-of-band structural delete moves m2 from row 3 to row 2.
    transport.atomicBatchUpdate("book", [{
      kind: "deleteRows",
      sheetId: 2,
      startRowIndex: 1,
      endRowIndex: 2,
    }]);
    transport.clearHistory();
    const rebuilt = gq.Models.where({ id: "m2" }).get();
    expect(rebuilt.rows[0].name).toBe("Tablet");
    expect(transport.history.map((call) => call.ranges)).toEqual([
      ["'Models'!A3:D3"],
      ["'Models'!A2:A"],
      ["'Models'!A2:D2"],
    ]);
  });
});
