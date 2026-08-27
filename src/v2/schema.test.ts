import { describe, expect, it, vi } from "vitest";
import {
  GQueryDefinitionError,
  belongsTo,
  booleanColumn,
  defineDatabase,
  enumeration,
  hasMany,
  source,
  structured,
  table,
  text,
  type InferDatabaseRows,
  type InferTableRow,
} from "./index";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

describe("v2 schema definitions", () => {
  it("defines lazy, immutable source and table metadata", () => {
    const spreadsheetApp = vi.fn(() => {
      throw new Error("must stay lazy");
    });
    vi.stubGlobal("SpreadsheetApp", spreadsheetApp);

    const Assets = table({
      source: "main",
      sheet: "Assets",
      primaryKey: ["serial"],
      unique: [["serial"]],
      versionColumn: "_gq_version",
      columns: {
        serial: text({ header: "Serial" }),
        status: enumeration({
          header: "Status",
          values: ["Available", "Assigned", "Repair"],
        }),
        modelId: text({ header: "Model" }),
        metadata: structured<{ tags: string[] }>({ header: "Metadata" }),
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
      },
    });
    const Models = table({
      source: "main",
      sheet: "Models",
      primaryKey: ["id"],
      columns: { id: text(), name: text() },
      relations: {
        assets: hasMany("Assets", { local: "id", foreign: "modelId" }),
      },
    });
    const schema = defineDatabase({
      version: 2,
      sources: { main: source.activeSpreadsheet() },
      tables: { Assets, Models },
    });

    expect(spreadsheetApp).not.toHaveBeenCalled();
    expect(schema.version).toBe(2);
    expect(schema.tables.Assets.sheet).toBe("Assets");
    expect(schema.tables.Assets.columns.serial.header).toBe("Serial");
    expect(schema.tables.Assets.primaryKey).toEqual(["serial"]);
    expect(schema.tables.Assets.versionColumn).toBe("_gq_version");
    expect(schema.tables.Assets.relations.model).toMatchObject({
      kind: "belongs-to",
      cardinality: "one",
      target: "Models",
      local: "modelId",
      foreign: "id",
    });
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.tables.Assets.columns)).toBe(true);

    type Asset = InferTableRow<typeof Assets>;
    type Rows = InferDatabaseRows<typeof schema.tables>;
    const statusTypeMatches: Equal<
      Asset["status"],
      "Available" | "Assigned" | "Repair"
    > = true;
    const modelTypeMatches: Equal<Rows["Models"], {
      id: string;
      name: string;
    }> = true;
    expect(statusTypeMatches).toBe(true);
    expect(modelTypeMatches).toBe(true);
  });

  it("supports explicit spreadsheet sources without resolving them", () => {
    expect(source.byId("spreadsheet-123")).toEqual({
      __gquerySource: true,
      kind: "spreadsheet-id",
      spreadsheetId: "spreadsheet-123",
    });
    expect(() => source.byId(" ")).toThrowError(GQueryDefinitionError);
  });

  it("rejects duplicate headers and invalid local keys", () => {
    expect(() =>
      table({
        source: "main",
        sheet: "Bad Headers",
        columns: {
          first: text({ header: "Same" }),
          second: text({ header: "Same" }),
        },
      }),
    ).toThrowError(GQueryDefinitionError);

    expect(() =>
      table({
        source: "main",
        sheet: "Bad Relation",
        columns: { id: text() },
        relations: {
          owner: belongsTo("Users", {
            local: "missing",
            foreign: "id",
          }),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "DEFINITION_INVALID" }));

    expect(() =>
      table({
        source: "main",
        sheet: "Relation Collision",
        columns: { id: text(), owner: text() },
        relations: {
          owner: belongsTo("Users", { local: "owner", foreign: "id" }),
        },
      }),
    ).toThrowError(/collides/i);
  });

  it("rejects invalid sources, targets, and foreign fields", () => {
    const Users = table({
      source: "main",
      sheet: "Users",
      columns: { id: text(), active: booleanColumn() },
    });
    const Orphans = table({
      source: "missing-source",
      sheet: "Orphans",
      columns: { ownerId: text() },
    });

    expect(() =>
      defineDatabase({
        version: 2,
        sources: { main: source.activeSpreadsheet() },
        tables: { Users, Orphans },
      } as never),
    ).toThrowError(expect.objectContaining({ code: "DEFINITION_INVALID" }));

    const BadTarget = table({
      source: "main",
      sheet: "Bad Target",
      columns: { ownerId: text() },
      relations: {
        owner: belongsTo("Absent", { local: "ownerId", foreign: "id" }),
      },
    });
    expect(() =>
      defineDatabase({
        version: 2,
        sources: { main: source.activeSpreadsheet() },
        tables: { Users, BadTarget },
      } as never),
    ).toThrowError(GQueryDefinitionError);

    const BadField = table({
      source: "main",
      sheet: "Bad Field",
      columns: { ownerId: text() },
      relations: {
        owner: belongsTo("Users", { local: "ownerId", foreign: "missing" }),
      },
    });
    expect(() =>
      defineDatabase({
        version: 2,
        sources: { main: source.activeSpreadsheet() },
        tables: { Users, BadField },
      } as never),
    ).toThrowError(GQueryDefinitionError);
  });

  it("validates relation arity, keys, and cache configuration", () => {
    expect(() =>
      belongsTo("Users", {
        local: ["tenantId", "userId"],
        foreign: ["id"],
      }),
    ).toThrowError(GQueryDefinitionError);
    expect(() =>
      table({
        source: "main",
        sheet: "Invalid",
        columns: { id: text() },
        primaryKey: ["id", "id"],
      }),
    ).toThrowError(GQueryDefinitionError);
    expect(() =>
      table({
        source: "main",
        sheet: "Invalid Cache",
        columns: { id: text() },
        cache: {
          mode: "query",
          scope: "script",
          ttlSeconds: 30,
          jitterSeconds: 30,
        },
      }),
    ).toThrowError(GQueryDefinitionError);
  });
});
