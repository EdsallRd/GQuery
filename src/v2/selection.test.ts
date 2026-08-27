import { describe, expect, it } from "vitest";
import { createExecutionStats } from "./execution";
import { SELECTION_INTERNAL, Selection, type SelectionRuntime } from "./selection";

const runtime: SelectionRuntime = {
  refresh: (selection) => selection,
  update: () => { throw new Error("not used"); },
  delete: () => { throw new Error("not used"); },
};

describe("v2 selections", () => {
  it("deeply isolates public DTOs from hidden mutation state", () => {
    const readAt = new Date("2026-08-26T12:00:00.000Z");
    const selection = new Selection([{
      value: {
        id: "one",
        metadata: { labels: ["ready"] },
        readAt,
      },
      provenance: {
        sourceName: "main",
        spreadsheetId: "book",
        tableName: "Rows",
        sheetName: "Rows",
        sheetId: 1,
        rowIndex: 1,
        primaryKey: { id: "one" },
        encodedPrimaryKey: { id: "one" },
        version: 1,
        originalEncoded: { id: "one", metadata: "{}", readAt: readAt.toISOString() },
        columnIndexes: { id: 0, metadata: 1, readAt: 2 },
        headerFingerprint: "header",
        readAt: readAt.toISOString(),
        relations: {},
        relationCardinalities: {},
      },
    }], ["id", "metadata", "readAt"], createExecutionStats(), runtime);

    expect(Object.isFrozen(selection.rows[0]?.metadata)).toBe(true);
    expect(Object.isFrozen(selection.rows[0]?.metadata.labels)).toBe(true);
    const publicDate = selection.rows[0]?.readAt;
    publicDate?.setUTCFullYear(2030);

    const internal = selection[SELECTION_INTERNAL].materialized[0]?.value;
    expect(internal?.readAt.toISOString()).toBe("2026-08-26T12:00:00.000Z");
    expect(internal?.metadata.labels).toEqual(["ready"]);
  });

  it("emits tagged JSON-safe DTOs for Date, BigInt, and undefined", () => {
    const selection = new Selection([{
      value: {
        id: "one",
        payload: {
          count: 9n,
          observedAt: new Date("2026-08-26T12:00:00.000Z"),
          optional: undefined,
        },
      },
      provenance: {
        sourceName: "main",
        spreadsheetId: "book",
        tableName: "Rows",
        sheetName: "Rows",
        sheetId: 1,
        rowIndex: 1,
        primaryKey: { id: "one" },
        encodedPrimaryKey: { id: "one" },
        version: 1,
        originalEncoded: { id: "one", payload: "tagged" },
        columnIndexes: { id: 0, payload: 1 },
        headerFingerprint: "header",
        readAt: "2026-08-26T12:00:00.000Z",
        relations: {},
        relationCardinalities: {},
      },
    }], ["id", "payload"], createExecutionStats(), runtime);

    expect(() => JSON.stringify(selection)).not.toThrow();
    expect(JSON.parse(JSON.stringify(selection))).toEqual({
      headers: ["id", "payload"],
      rows: [{
        id: "one",
        payload: {
          count: { $gquery: "bigint", value: "9" },
          observedAt: { $gquery: "date", value: "2026-08-26T12:00:00.000Z" },
          optional: { $gquery: "undefined" },
        },
      }],
    });
  });
});
