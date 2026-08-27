import { afterEach, describe, expect, it, vi } from "vitest";
import { text } from "./codecs";
import { createGQuery } from "./database";
import { AppsScriptSchemaMigrationAdapter } from "./management";
import { defineDatabase, source, table } from "./schema";
import { InMemorySheetsTransport } from "./transport";

afterEach(() => vi.unstubAllGlobals());

describe("schema migration safety", () => {
  it("versions only populated physical rows and preserves interior blank rows", () => {
    const schema = defineDatabase({
      version: 2,
      sources: { main: source.byId("migration-book") },
      tables: {
        Records: table({
          source: "main",
          sheet: "Records",
          primaryKey: ["id"],
          versionColumn: "_gq_version",
          columns: { id: text({ header: "ID" }) },
        }),
      },
    });
    const transport = new InMemorySheetsTransport([{
      spreadsheetId: "migration-book",
      sheets: [{
        sheetId: 7,
        title: "Records",
        values: [["ID"], ["a"], [null], ["b"]],
      }],
    }]);
    const plan = createGQuery(schema, { transport }).schema.plan();
    const action = plan.actions.find((candidate) => candidate.kind === "add-version-column");
    expect(action).toMatchObject({ populatedRowIndexes: [1, 3] });
    if (action?.kind !== "add-version-column") throw new Error("missing version action");

    const batchUpdate = vi.fn(() => ({}));
    vi.stubGlobal("Sheets", {
      Spreadsheets: {
        get: () => ({ sheets: [{ properties: { sheetId: 7, title: "Records" } }] }),
        batchUpdate,
      },
    });
    new AppsScriptSchemaMigrationAdapter().apply(
      "migration-book",
      [action],
      { backupId: "backup", migratedAt: "2026-08-26T00:00:00.000Z" },
    );

    const requests = batchUpdate.mock.calls[0]?.[0].requests as Array<{
      updateCells?: { range?: { startRowIndex?: number } };
    }>;
    expect(requests.filter((request) => request.updateCells).map(
      (request) => request.updateCells?.range?.startRowIndex,
    )).toEqual([0, 1, 3]);
  });
});
