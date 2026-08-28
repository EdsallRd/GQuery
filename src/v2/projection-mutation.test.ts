import { describe, expect, it } from "vitest";
import { text } from "./codecs";
import { createGQuery } from "./database";
import { GQueryRuntimeError } from "./runtime-errors";
import { belongsTo, defineDatabase, source, table } from "./schema";
import { InMemorySheetsTransport } from "./transport";

const schema = defineDatabase({
  version: 2,
  sources: { main: source.byId("projection-book") },
  tables: {
    Parents: table({
      source: "main",
      sheet: "Parents",
      primaryKey: ["tenant", "code"],
      columns: {
        tenant: text({ header: "Tenant" }),
        code: text({ header: "Code" }),
        name: text({ header: "Name" }),
      },
    }),
    WorkItems: table({
      source: "main",
      sheet: "WorkItems",
      primaryKey: ["id"],
      unique: [["tenant", "code"]],
      columns: {
        id: text({ header: "ID" }),
        tenant: text({ header: "Tenant" }),
        code: text({ header: "Code" }),
        status: text({ header: "Status" }),
      },
      relations: {
        parent: belongsTo("Parents", {
          local: ["tenant", "code"],
          foreign: ["tenant", "code"],
          required: true,
          onDelete: "no-action",
        }),
      },
    }),
    CascadeChildren: table({
      source: "main",
      sheet: "CascadeChildren",
      primaryKey: ["id"],
      columns: {
        id: text({ header: "ID" }),
        tenant: text({ header: "Tenant" }),
        parentCode: text({ header: "Parent Code" }),
      },
      relations: {
        parent: belongsTo("Parents", {
          local: ["tenant", "parentCode"],
          foreign: ["tenant", "code"],
          onDelete: "cascade",
        }),
      },
    }),
    RestrictedChildren: table({
      source: "main",
      sheet: "RestrictedChildren",
      primaryKey: ["id"],
      columns: {
        id: text({ header: "ID" }),
        tenant: text({ header: "Tenant" }),
        parentCode: text({ header: "Parent Code" }),
      },
      relations: {
        parent: belongsTo("Parents", {
          local: ["tenant", "parentCode"],
          foreign: ["tenant", "code"],
          onDelete: "restrict",
        }),
      },
    }),
  },
});

function setup() {
  const transport = new InMemorySheetsTransport([{
    spreadsheetId: "projection-book",
    sheets: [
      {
        sheetId: 1,
        title: "Parents",
        values: [
          ["Tenant", "Code", "Name"],
          ["T1", "old", "Old parent"],
          ["T1", "new", "New parent"],
          ["T1", "restricted", "Restricted parent"],
        ],
      },
      {
        sheetId: 2,
        title: "WorkItems",
        values: [
          ["ID", "Tenant", "Code", "Status"],
          ["w1", "T1", "old", "Open"],
        ],
      },
      {
        sheetId: 3,
        title: "CascadeChildren",
        values: [["ID", "Tenant", "Parent Code"], ["c1", "T1", "old"]],
      },
      {
        sheetId: 4,
        title: "RestrictedChildren",
        values: [["ID", "Tenant", "Parent Code"], ["r1", "T1", "restricted"]],
      },
    ],
  }]);
  return { transport, db: createGQuery(schema, { transport }) };
}

describe("projected mutation provenance", () => {
  it("preserves untouched composite unique and foreign-key fields during update", () => {
    const { transport, db } = setup();
    const selected = db.WorkItems.where({ id: "w1" }).select(["code"] as const).maybeOne();
    expect(selected.rows).toEqual([{ code: "old" }]);

    const result = selected.update({ code: "new" });
    expect(result.status).toBe("committed");
    expect(result.after?.rows).toEqual([{ code: "new" }]);
    expect(transport.snapshot("projection-book").sheets[1].values[1]).toEqual([
      "w1", "T1", "new", "Open",
    ]);
  });

  it("hydrates only missing matched-row columns before a projected update", () => {
    const { transport, db } = setup();
    db.WorkItems.all().get();
    transport.clearHistory();

    const selected = db.WorkItems
      .where({ id: "w1" })
      .select(["code"] as const)
      .maybeOne();
    const selectionReads = transport.history.filter((call) => call.kind === "batchGet");
    expect(selectionReads).toEqual([
      expect.objectContaining({ ranges: ["'WorkItems'!A2:C2"] }),
    ]);

    transport.clearHistory();
    expect(selected.update({ code: "new" }).status).toBe("committed");
    const writeReads = transport.history
      .filter((call) => call.kind === "batchGet")
      .flatMap((call) => call.ranges);
    expect(writeReads).toContain("'WorkItems'!D2");
    expect(writeReads).not.toContain("'WorkItems'");
    expect(transport.snapshot("projection-book").sheets[1].values[1]).toEqual([
      "w1", "T1", "new", "Open",
    ]);
  });

  it("hydrates projected updates staged inside a unit of work", () => {
    const { transport, db } = setup();
    db.WorkItems.all().get();
    transport.clearHistory();
    const lock = { tryAcquire: () => true, release: () => undefined };

    const receipt = db.unitOfWork({ lock }, (tx) => {
      tx.WorkItems.where({ id: "w1" })
        .select(["code"] as const)
        .maybeOne()
        .update({ code: "new" });
    });

    expect(receipt.status).toBe("committed");
    expect(transport.history
      .filter((call) => call.kind === "batchGet")
      .flatMap((call) => call.ranges))
      .toContain("'WorkItems'!D2");
    expect(transport.snapshot("projection-book").sheets[1].values[1]).toEqual([
      "w1", "T1", "new", "Open",
    ]);
  });

  it("uses the hidden composite principal key for projected cascade deletes", () => {
    const { transport, db } = setup();
    const selected = db.Parents
      .where({ tenant: "T1", code: "old" })
      .select(["name"] as const)
      .maybeOne();

    expect(selected.delete().status).toBe("committed");
    const sheets = transport.snapshot("projection-book").sheets;
    expect(sheets[0].values.slice(1).map((row) => row[1])).toEqual(["new", "restricted"]);
    expect(sheets[2].values).toEqual([["ID", "Tenant", "Parent Code"]]);
  });

  it("uses the hidden composite principal key for projected restrict checks", () => {
    const { db } = setup();
    const selected = db.Parents
      .where({ tenant: "T1", code: "restricted" })
      .select(["name"] as const)
      .maybeOne();

    try {
      selected.delete();
      throw new Error("Expected projected restrict delete to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(GQueryRuntimeError);
      expect((error as GQueryRuntimeError).code).toBe("RELATION_RESTRICT");
    }
  });
});
