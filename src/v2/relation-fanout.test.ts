import { describe, expect, it } from "vitest";
import { text } from "./codecs";
import { createGQuery } from "./database";
import { defineDatabase, hasMany, source, table } from "./schema";
import { InMemorySheetsTransport } from "./transport";

const schema = defineDatabase({
  version: 2,
  sources: { main: source.byId("fanout-book") },
  tables: {
    Parents: table({
      source: "main",
      sheet: "Parents",
      primaryKey: ["id"],
      columns: { id: text({ header: "ID" }) },
      relations: {
        children: hasMany("Children", {
          local: "id",
          foreign: "parentId",
        }),
      },
    }),
    Children: table({
      source: "main",
      sheet: "Children",
      primaryKey: ["id"],
      versionColumn: "_gq_version",
      columns: {
        id: text({ header: "ID" }),
        parentId: text({ header: "Parent ID" }),
        label: text({ header: "Label" }),
      },
    }),
  },
});

function setup() {
  const transport = new InMemorySheetsTransport([{
    spreadsheetId: "fanout-book",
    sheets: [
      {
        sheetId: 1,
        title: "Parents",
        values: [["ID"], ["p0"], ["p1"], ["p2"]],
      },
      {
        sheetId: 2,
        title: "Children",
        values: [
          ["ID", "Parent ID", "Label", "_gq_version"],
          ["one", "p1", "one", 1],
          ["many-a", "p2", "a", 1],
          ["many-b", "p2", "b", 1],
        ],
      },
    ],
  }]);
  return { transport, gq: createGQuery(schema, { transport }) };
}

describe("declared to-many mutation fan-out", () => {
  it("requires fanout for a currently one-child relation", () => {
    const { transport, gq } = setup();
    const children = gq.Parents.where({ id: "p1" })
      .include("children")
      .maybeOne()
      .related("children");
    expect(children.length).toBe(1);
    transport.clearHistory();

    expect(() => children.update({ label: "changed" })).toThrowError(
      expect.objectContaining({ code: "MUTATION_INVALID" }),
    );
    expect(transport.history).toHaveLength(0);
    expect(children.update({ label: "changed" }, { fanout: true }).status)
      .toBe("committed");
  });

  it("retains the fanout guard when the relation currently has zero children", () => {
    const { gq } = setup();
    const children = gq.Parents.where({ id: "p0" })
      .include("children")
      .maybeOne()
      .related("children");
    expect(children.length).toBe(0);

    expect(() => children.delete()).toThrowError(
      expect.objectContaining({ code: "MUTATION_INVALID" }),
    );
    expect(children.delete({ fanout: true })).toMatchObject({
      status: "committed",
      matchedCount: 0,
      changedCount: 0,
    });
  });

  it("continues to require fanout for multiple children", () => {
    const { transport, gq } = setup();
    const query = gq.Parents.where({ id: "p2" }).include("children");
    expect(query.explain().warnings).toContainEqual(expect.objectContaining({
      code: "JOIN_FANOUT",
      table: "Children",
    }));
    const parent = query.maybeOne();
    expect(parent.stats.joinFanOut).toBe(1);
    const children = parent.related("children");
    expect(children.length).toBe(2);

    expect(() => children.delete()).toThrowError(
      expect.objectContaining({ code: "MUTATION_INVALID" }),
    );
    expect(children.delete({ fanout: true })).toMatchObject({
      status: "committed",
      matchedCount: 2,
      changedCount: 2,
    });
    expect(transport.snapshot("fanout-book").sheets[1].values).toEqual([
      ["ID", "Parent ID", "Label", "_gq_version"],
      ["one", "p1", "one", 1],
    ]);
  });
});
