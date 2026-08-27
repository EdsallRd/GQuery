import { describe, expect, it } from "vitest";
import { formula, nullable, text, type FormulaCell } from "./codecs";
import { createGQuery } from "./database";
import { GQueryDefinitionError } from "./errors";
import { GQueryRuntimeError } from "./runtime-errors";
import {
  belongsTo,
  defineDatabase,
  hasMany,
  source,
  table,
} from "./schema";
import { InMemorySheetsTransport } from "./transport";

const relationSchema = defineDatabase({
  version: 2,
  sources: { main: source.byId("relations-book") },
  tables: {
    Parents: table({
      source: "main",
      sheet: "Parents",
      primaryKey: ["id"],
      versionColumn: "_gq_version",
      columns: { id: text({ header: "ID" }), name: text({ header: "Name" }) },
      relations: {
        ownedChildren: hasMany("OwnedChildren", {
          local: "id",
          foreign: "parentId",
          onDelete: "cascade",
        }),
      },
    }),
    RestrictedChildren: table({
      source: "main",
      sheet: "Restricted Children",
      primaryKey: ["id"],
      versionColumn: "_gq_version",
      columns: {
        id: text({ header: "ID" }),
        parentId: text({ header: "Parent ID" }),
      },
      relations: {
        parent: belongsTo("Parents", {
          local: "parentId",
          foreign: "id",
          onDelete: "restrict",
        }),
      },
    }),
    CascadedChildren: table({
      source: "main",
      sheet: "Cascaded Children",
      primaryKey: ["id"],
      versionColumn: "_gq_version",
      columns: {
        id: text({ header: "ID" }),
        parentId: text({ header: "Parent ID" }),
      },
      relations: {
        parent: belongsTo("Parents", {
          local: "parentId",
          foreign: "id",
          onDelete: "cascade",
        }),
      },
    }),
    NullableChildren: table({
      source: "main",
      sheet: "Nullable Children",
      primaryKey: ["id"],
      versionColumn: "_gq_version",
      columns: {
        id: text({ header: "ID" }),
        parentId: nullable(text({ header: "Parent ID" })),
        label: text({ header: "Label" }),
      },
      relations: {
        parent: belongsTo("Parents", {
          local: "parentId",
          foreign: "id",
          onDelete: "set-null",
        }),
      },
    }),
    Orphans: table({
      source: "main",
      sheet: "Orphans",
      primaryKey: ["id"],
      columns: {
        id: text({ header: "ID" }),
        parentId: text({ header: "Parent ID" }),
      },
      relations: {
        parent: belongsTo("Parents", {
          local: "parentId",
          foreign: "id",
          onDelete: "no-action",
        }),
      },
    }),
    OwnedChildren: table({
      source: "main",
      sheet: "Owned Children",
      primaryKey: ["id"],
      versionColumn: "_gq_version",
      columns: {
        id: text({ header: "ID" }),
        parentId: text({ header: "Parent ID" }),
      },
    }),
  },
});

function setup() {
  const transport = new InMemorySheetsTransport([{
    spreadsheetId: "relations-book",
    sheets: [
      {
        sheetId: 1,
        title: "Parents",
        values: [
          ["ID", "Name", "_gq_version"],
          ["p-restrict", "Restricted", 1],
          ["p-cascade", "Cascade", 1],
          ["p-null", "Null", 1],
          ["p-orphan", "Orphan", 1],
        ],
      },
      {
        sheetId: 2,
        title: "Restricted Children",
        values: [["ID", "Parent ID", "_gq_version"], ["r1", "p-restrict", 1]],
      },
      {
        sheetId: 3,
        title: "Cascaded Children",
        values: [["ID", "Parent ID", "_gq_version"], ["c1", "p-cascade", 1]],
      },
      {
        sheetId: 4,
        title: "Nullable Children",
        values: [
          ["ID", "Parent ID", "Label", "_gq_version"],
          ["n1", "p-null", "original", 1],
        ],
      },
      {
        sheetId: 5,
        title: "Orphans",
        values: [["ID", "Parent ID"], ["o1", "p-orphan"]],
      },
      {
        sheetId: 6,
        title: "Owned Children",
        values: [["ID", "Parent ID", "_gq_version"], ["h1", "p-cascade", 1]],
      },
    ],
  }]);
  return { transport, gq: createGQuery(relationSchema, { transport }) };
}

describe("declared relation delete behavior", () => {
  it("raises a structured restrict error before writing", () => {
    const { transport, gq } = setup();
    const parent = gq.Parents.find("p-restrict");
    transport.clearHistory();

    let error: unknown;
    try {
      parent.delete();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GQueryRuntimeError);
    expect(error).toMatchObject({
      code: "RELATION_RESTRICT",
      details: {
        relation: "RestrictedChildren.parent",
        principalTable: "Parents",
        dependentTable: "RestrictedChildren",
      },
    });
    expect(transport.history.some(({ kind }) => kind === "atomicBatchUpdate")).toBe(false);
    expect(transport.snapshot("relations-book").sheets[0].values).toHaveLength(5);
  });

  it("recursively compiles belongs-to and has-many cascades into one atomic call", () => {
    const { transport, gq } = setup();
    const result = gq.Parents.find("p-cascade").delete();

    expect(result).toMatchObject({ status: "committed", matchedCount: 1, changedCount: 3 });
    const atomic = transport.history.filter(({ kind }) => kind === "atomicBatchUpdate");
    expect(atomic).toHaveLength(1);
    expect(transport.snapshot("relations-book").sheets[0].values.map((row) => row[0]))
      .toEqual(["ID", "p-restrict", "p-null", "p-orphan"]);
    expect(transport.snapshot("relations-book").sheets[2].values).toEqual([
      ["ID", "Parent ID", "_gq_version"],
    ]);
    expect(transport.snapshot("relations-book").sheets[5].values).toEqual([
      ["ID", "Parent ID", "_gq_version"],
    ]);
  });

  it("sets nullable foreign keys to null and increments their row version atomically", () => {
    const { transport, gq } = setup();
    const result = gq.Parents.find("p-null").delete();

    expect(result).toMatchObject({
      status: "committed",
      matchedCount: 1,
      changedCount: 2,
      changedCells: 2,
    });
    expect(transport.history.filter(({ kind }) => kind === "atomicBatchUpdate")).toHaveLength(1);
    expect(transport.snapshot("relations-book").sheets[3].values[1]).toEqual([
      "n1", null, "original", 2,
    ]);
  });

  it("leaves dependent rows untouched for no-action", () => {
    const { transport, gq } = setup();
    gq.Parents.find("p-orphan").delete();
    expect(transport.snapshot("relations-book").sheets[4].values[1]).toEqual([
      "o1", "p-orphan",
    ]);
  });

  it("merges staged updates with set-null and cascades in one unit-of-work batch", () => {
    const { transport, gq } = setup();
    transport.clearHistory();
    const committed = gq.unitOfWork((tx) => {
      tx.NullableChildren.find("n1").update({ label: "changed" });
      tx.Parents.find("p-null").delete();
      tx.Parents.find("p-cascade").delete();
    });

    expect(committed.status).toBe("committed");
    expect(transport.history.filter(({ kind }) => kind === "atomicBatchUpdate")).toHaveLength(1);
    expect(transport.snapshot("relations-book").sheets[3].values[1]).toEqual([
      "n1", null, "changed", 2,
    ]);
    expect(transport.snapshot("relations-book").sheets[2].values).toHaveLength(1);
    expect(transport.snapshot("relations-book").sheets[5].values).toHaveLength(1);
  });

  it("requests formula rendering while scanning formula-bearing dependents", () => {
    const formulaRelationSchema = defineDatabase({
      version: 2,
      sources: { main: source.byId("formula-relations") },
      tables: {
        Parents: table({
          source: "main",
          sheet: "Parents",
          primaryKey: ["id"],
          versionColumn: "_gq_version",
          columns: { id: text({ header: "ID" }) },
        }),
        FormulaChildren: table({
          source: "main",
          sheet: "Formula Children",
          primaryKey: ["id"],
          versionColumn: "_gq_version",
          columns: {
            id: text({ header: "ID" }),
            parentId: text({ header: "Parent ID" }),
            calculation: formula({ header: "Calculation" }),
          },
          relations: {
            parent: belongsTo("Parents", {
              local: "parentId",
              foreign: "id",
              onDelete: "cascade",
            }),
          },
        }),
      },
    });
    const transport = new InMemorySheetsTransport([{
      spreadsheetId: "formula-relations",
      sheets: [
        {
          sheetId: 1,
          title: "Parents",
          values: [["ID", "_gq_version"], ["p1", 1]],
        },
        {
          sheetId: 2,
          title: "Formula Children",
          values: [
            ["ID", "Parent ID", "Calculation", "_gq_version"],
            [
              "c1",
              "p1",
              formula().encode("=1+1") as FormulaCell,
              1,
            ],
          ],
        },
      ],
    }]);
    const gq = createGQuery(formulaRelationSchema, { transport });
    const parent = gq.Parents.find("p1");
    transport.clearHistory();

    expect(parent.delete()).toMatchObject({
      status: "committed",
      changedCount: 2,
    });
    const dependencyScan = transport.history.find((call) =>
      call.kind === "batchGet" && call.ranges.includes("'Formula Children'")
    );
    expect(dependencyScan?.valueRenderOption).toBe("FORMULA");
    expect(transport.snapshot("formula-relations").sheets[1].values).toEqual([
      ["ID", "Parent ID", "Calculation", "_gq_version"],
    ]);
  });

  it("rejects set-null definitions whose physical foreign key is not nullable", () => {
    const Parent = table({
      source: "main",
      sheet: "Parent",
      columns: { id: text() },
    });
    const Child = table({
      source: "main",
      sheet: "Child",
      columns: { parentId: text() },
      relations: {
        parent: belongsTo("Parent", {
          local: "parentId",
          foreign: "id",
          onDelete: "set-null",
        }),
      },
    });
    expect(() =>
      defineDatabase({
        version: 2,
        sources: { main: source.byId("book") },
        tables: { Parent, Child },
      }),
    ).toThrowError(GQueryDefinitionError);
  });
});
