import { afterEach, describe, expect, it, vi } from "vitest";
import { enumeration, formula, integer, nullable, text } from "./codecs";
import { createGQuery } from "./database";
import { defineDatabase, belongsTo, source, table } from "./schema";
import { InMemorySheetsTransport, type SheetsTransport } from "./transport";
import { DeferredJournal } from "./infrastructure/deferred";
import { Fnv1aHash } from "./infrastructure/canonical";
import type { PropertyStore } from "./infrastructure/runtime";
import { AmbiguousCommitError, ApiFailure } from "./infrastructure/errors";

class TestProperties implements PropertyStore {
  private readonly values = new Map<string, string>();
  get(key: string) { return this.values.get(key) ?? null; }
  getMany() { return Object.fromEntries(this.values); }
  set(key: string, value: string) { this.values.set(key, value); }
  setMany(values: Readonly<Record<string, string>>) { Object.entries(values).forEach(([key, value]) => this.values.set(key, value)); }
  remove(key: string) { this.values.delete(key); }
  removeMany(keys: readonly string[]) { keys.forEach((key) => this.values.delete(key)); }
}

afterEach(() => vi.unstubAllGlobals());

class FailingJournalManifestProperties extends TestProperties {
  public failNextManifestPublication = false;

  override set(key: string, value: string) {
    if (this.failNextManifestPublication && key.endsWith(":deferred:manifest")) {
      this.failNextManifestPublication = false;
      throw new Error("simulated journal cleanup publication failure");
    }
    super.set(key, value);
  }
}

function failAtomicWith(
  transport: InMemorySheetsTransport,
  error: Error,
): SheetsTransport {
  return new Proxy(transport, {
    get(target, property, receiver) {
      if (property === "atomicBatchUpdate") return () => { throw error; };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
  it("serializes standalone upsert and sync read-modify-write sequences", () => {
    const lock = { tryLock: vi.fn(() => true), releaseLock: vi.fn() };
    vi.stubGlobal("LockService", {
      getDocumentLock: () => lock,
      getScriptLock: () => lock,
    });
    const { gq } = setup();

    gq.Assets.upsertMany([{
      serial: "SX5GN4",
      status: "Available",
      modelId: "m2",
    }]);
    gq.Assets.sync(gq.Assets.get().rows.map((row) => ({ ...row })));

    expect(lock.tryLock).toHaveBeenCalledTimes(2);
    expect(lock.tryLock).toHaveBeenNthCalledWith(1, 30_000);
    expect(lock.releaseLock).toHaveBeenCalledTimes(2);
  });

  it("executes the null operator through validated query plans", () => {
    const { gq } = setup();

    expect(gq.Assets.where({ modelId: { $isNull: true } }).get().rows.map((row) => row.serial))
      .toEqual(["SX5GN3"]);
    expect(gq.Assets.where({ modelId: { $isNull: false } }).count()).toBe(2);
  });

  it("uses the validated column registry to narrow projected scans", () => {
    const { gq, transport } = setup();
    gq.Models.all().get();
    transport.clearHistory();

    const selected = gq.Models
      .where({ name: "Laptop" })
      .select(["id"] as const)
      .get();

    expect(selected.rows).toEqual([{ id: "m1" }]);
    expect(transport.history).toEqual([
      expect.objectContaining({
        kind: "batchGet",
        ranges: ["'Models'!A:B", "'Models'!D:D"],
      }),
    ]);
    expect(selected.stats.cellsRead).toBeLessThan(12);
  });

  it("warns when a typed predicate cannot use a declared locator index", () => {
    const { gq } = setup();
    expect(gq.Assets.where({ status: "Repair" }).explain().warnings)
      .toContainEqual(expect.objectContaining({
        code: "UNINDEXED_PREDICATE",
        table: "Assets",
      }));
  });

  it("rejects unknown predicate, projection, and order fields before transport access", () => {
    const { gq, transport } = setup();
    const invalidQueries = [
      gq.Assets.where({ serail: "SX5GN1" } as never),
      gq.Assets.select(["bogus"] as never),
      gq.Assets.orderBy("bogus" as never),
    ];

    transport.clearHistory();
    for (const query of invalidQueries) {
      expect(() => query.get()).toThrow(/unknown (predicate field|field)|orders by unknown field/i);
    }
    expect(transport.history).toEqual([]);
  });

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

  it("invalidates only relation aliases whose local key changes in immediate, deferred, and UOW after-selections", () => {
    const immediateSetup = setup();
    const immediate = immediateSetup.gq.Assets
      .where({ serial: "SX5GN1" })
      .include("model")
      .maybeOne()
      .update({ modelId: "m2" });
    expect(immediate.after?.rows[0]).not.toHaveProperty("model");
    expect(() => immediate.after?.related("model")).toThrowError(
      expect.objectContaining({ code: "RELATION_NOT_FOUND" }),
    );
    expect(immediateSetup.gq.Models.find("m1").rows[0]?.name).toBe("Laptop");

    const uowSetup = setup();
    expect(uowSetup.gq.unitOfWork((tx) => {
      const queued = tx.Assets
        .where({ serial: "SX5GN1" })
        .include("model")
        .maybeOne()
        .update({ modelId: "m2" });
      expect(queued.after?.rows[0]).not.toHaveProperty("model");
      expect(() => queued.after?.related("model")).toThrowError(
        expect.objectContaining({ code: "RELATION_NOT_FOUND" }),
      );
    }).status).toBe("committed");

    const deferredSetup = setup();
    const properties = new TestProperties();
    let nextId = 0;
    const journal = new DeferredJournal({
      properties,
      lock: { tryAcquire: () => true, release: () => undefined },
      hasher: new Fnv1aHash(),
      ids: { next: () => `relation-${++nextId}` },
      clock: { now: () => 1_000 },
    });
    const deferred = createGQuery(schema, {
      transport: deferredSetup.transport,
      deferredJournal: journal,
    }).Assets
      .where({ serial: "SX5GN1" })
      .include("model")
      .maybeOne()
      .update({ modelId: "m2" }, {
        delivery: "deferred",
        idempotencyKey: "relation-key-change",
      });
    expect(deferred.after?.rows[0]).not.toHaveProperty("model");
    expect(() => deferred.after?.related("model")).toThrowError(
      expect.objectContaining({ code: "RELATION_NOT_FOUND" }),
    );
  });

  it("retains include and join aliases through projections in either chain order", () => {
    const { gq } = setup();
    const selectedThenIncluded = gq.Assets
      .select(["serial"])
      .include("model")
      .find("SX5GN1");
    const includedThenSelected = gq.Assets
      .include("model")
      .select(["serial"])
      .find("SX5GN1");
    const selectedThenJoined = gq.Assets
      .select(["serial"])
      .join(gq.Models, {
        as: "joinedModel",
        on: { local: "modelId", foreign: "id" },
        kind: "left",
        cardinality: "one",
      })
      .find("SX5GN1");
    const joinedThenSelected = gq.Assets
      .join(gq.Models, {
        as: "joinedModel",
        on: { local: "modelId", foreign: "id" },
        kind: "left",
        cardinality: "one",
      })
      .select(["serial"])
      .find("SX5GN1");

    expect(selectedThenIncluded.rows[0]).toMatchObject({
      serial: "SX5GN1",
      model: { id: "m1", name: "Laptop" },
    });
    expect(includedThenSelected.rows[0]).toMatchObject({
      serial: "SX5GN1",
      model: { id: "m1", name: "Laptop" },
    });
    expect(selectedThenJoined.rows[0]).toMatchObject({
      serial: "SX5GN1",
      joinedModel: { id: "m1", name: "Laptop" },
    });
    expect(joinedThenSelected.rows[0]).toMatchObject({
      serial: "SX5GN1",
      joinedModel: { id: "m1", name: "Laptop" },
    });
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

  it("stages only base-row deltas from joined callbacks in a unit of work", () => {
    const includedSetup = setup();
    const included = includedSetup.gq.unitOfWork((tx) => {
      tx.Assets.where({ serial: "SX5GN1" })
        .include("model")
        .get()
        .update((draft) => ({
          ...draft,
          status: "Available",
        }));
    });
    expect(included.status).toBe("committed");
    expect(includedSetup.gq.Assets.find("SX5GN1").rows[0]?.status)
      .toBe("Available");

    const joinedSetup = setup();
    const joined = joinedSetup.gq.unitOfWork((tx) => {
      tx.Assets
        .where({ serial: "SX5GN1" })
        .join(tx.Models, {
          as: "joinedModel",
          on: { local: "modelId", foreign: "id" },
          kind: "left",
          cardinality: "one",
        })
        .get()
        .update((draft) => ({ ...draft, status: "Repair" }));
      expect("joinedModel" in tx.Assets.find("SX5GN1").rows[0]).toBe(false);
    });
    expect(joined.status).toBe("committed");
    expect(joinedSetup.gq.Assets.find("SX5GN1").rows[0]?.status).toBe("Repair");
  });

  it("rejects immediate raw writes inside a unit of work", () => {
    const { transport, gq } = setup();
    transport.clearHistory();

    expect(() => gq.unitOfWork((tx) => {
      tx.raw.values.batchUpdate("main", [{
        range: "'Assets'!B2",
        values: [["Available"]],
      }]);
    })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_OPERATION" }));
    expect(transport.history).toEqual([]);
    expect(transport.snapshot("book").sheets[0].values[1]?.[1]).toBe("Assigned");
  });

  it("rethrows a same-workbook ambiguous append/delete commit instead of returning a partial saga", () => {
    const { transport } = setup();
    const ambiguous = new AmbiguousCommitError(
      "atomic batch",
      new ApiFailure({
        kind: "network",
        retryable: true,
        originalMessage: "connection reset after request upload",
      }),
    );
    const gq = createGQuery(schema, {
      transport: failAtomicWith(transport, ambiguous),
    });

    expect(() => gq.unitOfWork((tx) => {
      tx.Assets.find("SX5GN1").delete();
      tx.Audit.append({ id: "ambiguous-audit", message: "unknown outcome" });
    })).toThrow(ambiguous);
  });

  it("rethrows deterministic same-workbook commit failures instead of claiming partial success", () => {
    const { transport } = setup();
    const failure = new Error("deterministic batch validation failure");
    const gq = createGQuery(schema, {
      transport: failAtomicWith(transport, failure),
    });

    expect(() => gq.unitOfWork((tx) => {
      tx.Assets.find("SX5GN1").update({ status: "Available" });
    })).toThrow(failure);
  });

  it("closes captured unit-of-work transactions and selections", () => {
    const { transport, gq } = setup();
    let capturedTransaction: typeof gq | undefined;
    let capturedSelection: ReturnType<typeof gq.Assets.find> | undefined;
    let capturedBatch: { get(): unknown } | undefined;

    const result = gq.unitOfWork((tx) => {
      capturedTransaction = tx;
      capturedSelection = tx.Assets.find("SX5GN1");
      capturedBatch = tx.batch({ assets: gq.Assets.all() });
    });
    expect(result.status).toBe("committed");

    const closedError = expect.objectContaining({ code: "MUTATION_INVALID" });
    expect(() => capturedTransaction!.Assets.all().get()).toThrowError(closedError);
    expect(() => capturedTransaction!.Audit.append({ id: "late", message: "late" }))
      .toThrowError(closedError);
    expect(() => capturedTransaction!.raw.values.get("main", "'Assets'"))
      .toThrowError(closedError);
    expect(() => capturedTransaction!.unitOfWork(() => undefined))
      .toThrowError(closedError);
    expect(() => capturedSelection!.refresh()).toThrowError(closedError);
    expect(() => capturedSelection!.update({ status: "Available" }))
      .toThrowError(closedError);
    expect(() => capturedSelection!.delete()).toThrowError(closedError);
    transport.clearHistory();
    expect(() => capturedBatch!.get()).toThrowError(closedError);
    expect(transport.history).toEqual([]);

    let abortedTransaction: typeof gq | undefined;
    expect(() => gq.unitOfWork((tx) => {
      abortedTransaction = tx;
      throw new Error("abort");
    })).toThrow("abort");
    expect(() => abortedTransaction!.Assets.all().get()).toThrowError(closedError);
  });

  it("rejects async unit-of-work callbacks without committing staged writes", () => {
    const { transport, gq } = setup();
    const before = transport.snapshot("book");
    transport.clearHistory();

    expect(() => gq.unitOfWork((tx) => {
      tx.Assets.find("SX5GN1").update({ status: "Available" });
      return Promise.resolve("async") as never;
    })).toThrow(/synchronously.*Promise|Promise.*synchronously/i);

    expect(transport.history.some(({ kind }) => kind === "atomicBatchUpdate"))
      .toBe(false);
    expect(transport.snapshot("book")).toEqual(before);
  });

  it("reuses a complete unit-of-work all() snapshot for append constraints", () => {
    const { transport, gq } = setup();
    transport.clearHistory();

    const result = gq.unitOfWork((tx) => {
      expect(tx.Audit.all().get().rows).toEqual([]);
      tx.Audit.append({ id: "event-snapshot", message: "one read" });
    });

    expect(result.status).toBe("committed");
    expect(transport.history.filter(({ kind }) => kind === "batchGet"))
      .toHaveLength(1);
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
    expect(result).toEqual({ invalidatedTables: ["Assets"], invalidatedRows: 0 });
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
    const gq = createGQuery(schema, {
      transport,
      cache,
      generations: {
        current: () => "0",
        invalidateTable: () => "1",
        invalidateRow: () => "1",
      },
    });

    expect(gq.Assets.where({ serial: "SX5GN1" }).get().rows).toEqual([{
      serial: "SX5GN1",
      status: "Assigned",
      modelId: "m1",
    }]);
    expect(transport.history.filter((call) => call.kind === "batchGet"))
      .toHaveLength(1);
  });

  it("reports retries accumulated by the shared execution scope", () => {
    const { transport } = setup();
    let completedRetries = 0;
    const executionScope = {
      run<T>(operation: () => T): T {
        const result = operation();
        completedRetries += 2;
        return result;
      },
      retryCount: () => completedRetries,
    };
    const gq = createGQuery(schema, { transport, executionScope });

    expect(gq.Assets.where({ serial: "SX5GN1" }).get().stats.retries).toBe(2);
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
    expect(() => selected.update({ modelId: "m2" })).toThrowError(
      expect.objectContaining({ code: "MUTATION_CONFLICT" }),
    );
    expect(() => selected.delete()).toThrowError(
      expect.objectContaining({ code: "MUTATION_CONFLICT" }),
    );

    const optimistic = gq.Assets.where({ serial: "SX5GN1" }).maybeOne();
    expect(optimistic.rows[0]?.status).toBe("Available");
    expect(transport.snapshot("book").sheets[0].values[1]?.[1]).toBe("Assigned");
    expect(() => optimistic.update({ modelId: "m2" })).toThrowError(
      expect.objectContaining({ code: "MUTATION_CONFLICT" }),
    );
    expect(() => optimistic.delete()).toThrowError(
      expect.objectContaining({ code: "MUTATION_CONFLICT" }),
    );
    expect(() => gq.unitOfWork((tx) => {
      tx.Assets.where({ serial: "SX5GN1" }).maybeOne().update({ modelId: "m2" });
    })).toThrowError(expect.objectContaining({ code: "MUTATION_CONFLICT" }));
    expect(journal.list()[0].values).toEqual({ status: "Available" });

    const flushed = gq.deferred.flush();
    expect(flushed).toMatchObject({ attempted: 1, committed: 1, conflicted: 0, retained: 0 });
    expect(gq.deferred.receipt("request-123")?.status).toBe("committed");
    expect(deadLetters).toHaveLength(0);
    expect(transport.snapshot("book").sheets[0].values[1]).toEqual([
      "SX5GN1", "Available", "m1", 4,
    ]);
  });

  it("queues caller-keyed deferred creates and upserts through the high-level API", () => {
    const { transport } = setup();
    const properties = new TestProperties();
    let nextId = 0;
    const journal = new DeferredJournal({
      properties,
      lock: { tryAcquire: () => true, release: () => undefined },
      hasher: new Fnv1aHash(),
      ids: { next: () => `keyed-${++nextId}` },
      clock: { now: () => 1_000 },
    });
    const gq = createGQuery(schema, {
      transport,
      deferredJournal: journal,
      deferredAppliedReceipts: properties,
      deferredDeadLetters: { write: () => undefined },
    });

    transport.clearHistory();
    const created = gq.Assets.append({
      serial: "SX5GN4",
      status: "Available",
      modelId: "m2",
    }, {
      delivery: "deferred",
      idempotencyKey: "create-SX5GN4",
      actor: "scanner@example.test",
    });
    const upserted = gq.Assets.upsertMany([{
      serial: "SX5GN2",
      status: "Available",
      modelId: "m1",
    }], {
      delivery: "deferred",
      idempotencyKey: "upsert-SX5GN2",
    });

    expect(created).toMatchObject({ status: "queued", receipt: { operation: "create" } });
    expect(upserted).toMatchObject({ status: "queued", pending: 1, receipt: { operation: "upsert" } });
    expect(transport.history).toEqual([]);
    expect(() => gq.Assets.appendMany([
      { serial: "SX5GN5", status: "Available", modelId: null },
      { serial: "SX5GN6", status: "Available", modelId: null },
    ], { delivery: "deferred", idempotencyKey: "too-many" })).toThrow(/exactly one/);

    expect(gq.deferred.flush()).toMatchObject({ attempted: 2, committed: 2, retained: 0 });
    expect(gq.Assets.find("SX5GN4").rows[0]).toMatchObject({ status: "Available", modelId: "m2" });
    expect(gq.Assets.find("SX5GN2").rows[0]).toMatchObject({ status: "Available" });
  });

  it("rejects immediate and UOW mutations of virtual deferred creates", () => {
    const { transport } = setup();
    const properties = new TestProperties();
    let nextId = 0;
    const journal = new DeferredJournal({
      properties,
      lock: { tryAcquire: () => true, release: () => undefined },
      hasher: new Fnv1aHash(),
      ids: { next: () => `virtual-${++nextId}` },
      clock: { now: () => 1_000 },
    });
    journal.enqueue({
      sourceId: "book",
      table: "Assets",
      kind: "create",
      key: { serial: "VIRTUAL-1" },
      values: { status: "Repair", modelId: "m2" },
      idempotencyKey: "virtual-create",
    });
    const gq = createGQuery(schema, {
      transport,
      deferredJournal: journal,
    });

    const virtual = gq.Assets.find("VIRTUAL-1");
    expect(virtual.rows[0]).toMatchObject({
      serial: "VIRTUAL-1",
      status: "Repair",
      modelId: "m2",
    });
    expect(() => virtual.update({ status: "Available" })).toThrowError(
      expect.objectContaining({ code: "MUTATION_CONFLICT" }),
    );
    expect(() => virtual.delete()).toThrowError(
      expect.objectContaining({ code: "MUTATION_CONFLICT" }),
    );
    expect(() => gq.unitOfWork((tx) => {
      tx.Assets.find("VIRTUAL-1").update({ status: "Available" });
    })).toThrowError(expect.objectContaining({ code: "MUTATION_CONFLICT" }));
    expect(transport.snapshot("book").sheets[0].values.map((row) => row[0]))
      .not.toContain("VIRTUAL-1");
  });

  it("flushes multiple same-workbook journal patches with one physical batch read and one atomic write", () => {
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
    const gq = createGQuery(schema, {
      transport,
      deferredJournal: journal,
      deferredAppliedReceipts: properties,
      deferredDeadLetters: { write: () => undefined },
    });
    const first = gq.Assets.find("SX5GN1");
    const second = gq.Assets.find("SX5GN2");
    first.update({ status: "Available" }, {
      delivery: "deferred",
      idempotencyKey: "batch-first",
    });
    second.update({ status: "Available" }, {
      delivery: "deferred",
      idempotencyKey: "batch-second",
    });

    transport.clearHistory();
    expect(gq.deferred.flush()).toMatchObject({
      attempted: 2,
      committed: 2,
      conflicted: 0,
      retained: 0,
    });

    expect(transport.history.filter((call) => call.kind === "batchGet")).toHaveLength(1);
    expect(transport.history.filter((call) => call.kind === "atomicBatchUpdate")).toHaveLength(1);
    expect(transport.snapshot("book").sheets[0].values.slice(1, 3)).toEqual([
      ["SX5GN1", "Available", "m1", 4],
      ["SX5GN2", "Available", "m1", 2],
    ]);
  });

  it("coalesces interleaved A/B/A patches without losing either A field", () => {
    const { transport } = setup();
    const properties = new TestProperties();
    let nextId = 0;
    const journal = new DeferredJournal({
      properties,
      lock: { tryAcquire: () => true, release: () => undefined },
      hasher: new Fnv1aHash(),
      ids: { next: () => `interleaved-${++nextId}` },
      clock: { now: () => 1_000 },
    });
    const gq = createGQuery(schema, {
      transport,
      deferredJournal: journal,
      deferredAppliedReceipts: properties,
      deferredDeadLetters: { write: () => undefined },
    });
    gq.Assets.find("SX5GN1").update({ status: "Repair" }, {
      delivery: "deferred",
      idempotencyKey: "A-status",
    });
    gq.Assets.find("SX5GN2").update({ status: "Available" }, {
      delivery: "deferred",
      idempotencyKey: "B-status",
    });
    gq.Assets.find("SX5GN1").update({ modelId: "m2" }, {
      delivery: "deferred",
      idempotencyKey: "A-model",
    });

    transport.clearHistory();
    expect(gq.deferred.flush()).toMatchObject({
      attempted: 3,
      committed: 3,
      coalesced: 1,
      retained: 0,
    });
    expect(transport.history.filter((call) => call.kind === "batchGet")).toHaveLength(1);
    expect(transport.history.filter((call) => call.kind === "atomicBatchUpdate")).toHaveLength(1);
    expect(transport.snapshot("book").sheets[0].values.slice(1, 3)).toEqual([
      ["SX5GN1", "Repair", "m2", 4],
      ["SX5GN2", "Available", "m1", 2],
    ]);
  });

  it("applies only a newly queued suffix after commit succeeded but journal cleanup failed", () => {
    const { transport } = setup();
    const properties = new FailingJournalManifestProperties();
    let nextId = 0;
    let armCleanupFailure = true;
    const wrappedTransport = new Proxy(transport, {
      get(target, property, receiver) {
        if (property === "atomicBatchUpdate") {
          return (...args: Parameters<SheetsTransport["atomicBatchUpdate"]>) => {
            const result = target.atomicBatchUpdate(...args);
            if (armCleanupFailure) {
              armCleanupFailure = false;
              properties.failNextManifestPublication = true;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as SheetsTransport;
    const journal = new DeferredJournal({
      properties,
      lock: { tryAcquire: () => true, release: () => undefined },
      hasher: new Fnv1aHash(),
      ids: { next: () => `crash-${++nextId}` },
      clock: { now: () => 1_000 },
    });
    const gq = createGQuery(schema, {
      transport: wrappedTransport,
      deferredJournal: journal,
      deferredAppliedReceipts: properties,
      deferredDeadLetters: { write: () => undefined },
    });
    gq.Assets.find("SX5GN1").update({ status: "Repair" }, {
      delivery: "deferred",
      idempotencyKey: "crash-prefix-status",
    });
    const prefix = gq.Assets.find("SX5GN1").update({ modelId: "m2" }, {
      delivery: "deferred",
      idempotencyKey: "crash-prefix-model",
    });

    expect(() => gq.deferred.flush()).toThrow(
      "simulated journal cleanup publication failure",
    );
    expect(transport.snapshot("book").sheets[0].values[1]).toEqual([
      "SX5GN1", "Repair", "m2", 4,
    ]);
    expect(journal.list()).toHaveLength(2);

    prefix.after!.update({ status: "Available" }, {
      delivery: "deferred",
      idempotencyKey: "crash-new-suffix",
    });
    expect(gq.deferred.flush()).toMatchObject({
      attempted: 3,
      committed: 3,
      coalesced: 2,
      retained: 0,
    });
    expect(transport.history.filter((call) => call.kind === "atomicBatchUpdate"))
      .toHaveLength(2);
    expect(transport.snapshot("book").sheets[0].values[1]).toEqual([
      "SX5GN1", "Available", "m2", 5,
    ]);
    expect(gq.deferred.receipt("crash-prefix-status")?.status).toBe("committed");
    expect(gq.deferred.receipt("crash-prefix-model")?.status).toBe("committed");
    expect(gq.deferred.receipt("crash-new-suffix")?.status).toBe("committed");
  });

  it("retains a complete 65-source applied checkpoint across cleanup failure", () => {
    const { transport } = setup();
    const properties = new FailingJournalManifestProperties();
    let nextId = 0;
    let armCleanupFailure = true;
    const wrappedTransport = new Proxy(transport, {
      get(target, property, receiver) {
        if (property === "atomicBatchUpdate") {
          return (...args: Parameters<SheetsTransport["atomicBatchUpdate"]>) => {
            const result = target.atomicBatchUpdate(...args);
            if (armCleanupFailure) {
              armCleanupFailure = false;
              properties.failNextManifestPublication = true;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as SheetsTransport;
    const journal = new DeferredJournal({
      properties,
      lock: { tryAcquire: () => true, release: () => undefined },
      hasher: new Fnv1aHash(),
      ids: { next: () => `checkpoint-${String(++nextId).padStart(40, "0")}` },
      clock: { now: () => 1_000 },
    });
    const gq = createGQuery(schema, {
      transport: wrappedTransport,
      deferredJournal: journal,
      deferredAppliedReceipts: properties,
      deferredDeadLetters: { write: () => undefined },
    });
    const selected = gq.Assets.find("SX5GN1");
    for (let index = 0; index < 65; index += 1) {
      selected.update({ status: index === 64 ? "Available" : index % 2 === 0 ? "Repair" : "Assigned" }, {
        delivery: "deferred",
        idempotencyKey: `checkpoint-request-${index}`,
      });
    }

    expect(() => gq.deferred.flush()).toThrow(
      "simulated journal cleanup publication failure",
    );
    expect(journal.list()).toHaveLength(65);
    expect(transport.history.filter((call) => call.kind === "atomicBatchUpdate"))
      .toHaveLength(1);

    expect(gq.deferred.flush()).toMatchObject({
      attempted: 65,
      committed: 65,
      coalesced: 64,
      retained: 0,
    });
    expect(transport.history.filter((call) => call.kind === "atomicBatchUpdate"))
      .toHaveLength(1);
    expect(transport.snapshot("book").sheets[0].values[1]).toEqual([
      "SX5GN1", "Available", "m1", 4,
    ]);
  });

  it("dead-letters a stale deferred version while committing other workbook patches", () => {
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
    const deadLetters: { mutation: { actor?: string; key: Readonly<Record<string, unknown>> } }[] = [];
    const gq = createGQuery(schema, {
      transport,
      deferredJournal: journal,
      deferredAppliedReceipts: properties,
      deferredDeadLetters: { write: (records) => deadLetters.push(...records) },
    });
    const first = gq.Assets.find("SX5GN1");
    const second = gq.Assets.find("SX5GN2");
    first.update({ status: "Available" }, {
      delivery: "deferred",
      idempotencyKey: "stale-first",
      actor: "original@example.test",
    });
    second.update({ status: "Available" }, {
      delivery: "deferred",
      idempotencyKey: "fresh-second",
    });
    transport.atomicBatchUpdate("book", [{
      kind: "updateCells",
      sheetId: 1,
      startRowIndex: 1,
      startColumnIndex: 3,
      values: [[99]],
    }]);

    transport.clearHistory();
    expect(gq.deferred.flush()).toMatchObject({
      attempted: 2,
      committed: 1,
      conflicted: 1,
      retained: 0,
    });
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].mutation).toMatchObject({
      actor: "original@example.test",
      key: { serial: "SX5GN1" },
    });
    expect(transport.history.filter((call) => call.kind === "batchGet")).toHaveLength(1);
    expect(transport.history.filter((call) => call.kind === "atomicBatchUpdate")).toHaveLength(1);
    expect(transport.snapshot("book").sheets[0].values.slice(1, 3)).toEqual([
      ["SX5GN1", "Assigned", "m1", 99],
      ["SX5GN2", "Available", "m1", 2],
    ]);
  });

  it("shows and flushes the final state of a queued patch followed by delete", () => {
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
    const gq = createGQuery(schema, {
      transport,
      deferredJournal: journal,
      deferredAppliedReceipts: properties,
      deferredDeadLetters: { write: () => undefined },
    });
    const selected = gq.Assets.where({ serial: "SX5GN1" }).maybeOne();
    selected.update({ status: "Available" }, {
      delivery: "deferred",
      idempotencyKey: "patch-before-delete",
      actor: "scanner@example.edu",
    });
    selected.delete({
      delivery: "deferred",
      idempotencyKey: "delete-after-patch",
      actor: "scanner@example.edu",
    });

    expect(gq.Assets.where({ serial: "SX5GN1" }).get()).toHaveLength(0);
    expect(transport.snapshot("book").sheets[0].values).toHaveLength(4);
    expect(gq.deferred.flush()).toMatchObject({
      attempted: 2,
      committed: 2,
      conflicted: 0,
      coalesced: 1,
      retained: 0,
    });
    expect(transport.snapshot("book").sheets[0].values.map((row) => row[0]))
      .not.toContain("SX5GN1");
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

  it("adds declared column formats to changed-cell atomic writes", () => {
    const formattedSchema = defineDatabase({
      version: 2,
      sources: { main: source.byId("format-book") },
      tables: {
        Rows: table({
          source: "main",
          sheet: "Rows",
          primaryKey: ["id"],
          columns: {
            id: text({ header: "ID" }),
            label: text({
              header: "Label",
              format: { textFormat: { bold: true } },
            }),
          },
        }),
      },
    });
    const transport = new InMemorySheetsTransport([{
      spreadsheetId: "format-book",
      sheets: [{
        sheetId: 1,
        title: "Rows",
        values: [["ID", "Label"], ["r1", "Before"]],
      }],
    }]);
    const db = createGQuery(formattedSchema, { transport });

    db.Rows.find("r1").update({ label: "After" });
    expect(transport.history.findLast((call) => call.kind === "atomicBatchUpdate"))
      .toMatchObject({ requestCount: 2 });

    transport.clearHistory();
    db.Rows.append({ id: "r2", label: "Created" });
    // Append formatting is intentionally not inferred through one global
    // AppendCells mask; that could clear formatting on sibling columns.
    expect(transport.history.findLast((call) => call.kind === "atomicBatchUpdate"))
      .toMatchObject({ requestCount: 1 });
  });
});
