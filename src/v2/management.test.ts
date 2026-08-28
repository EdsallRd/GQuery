import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boolean as booleanColumn,
  identifier,
  LEGACY_NO_MATCH,
  nullable,
  text,
  withDefault,
} from "./codecs";
import { createGQuery } from "./database";
import {
  AppsScriptSchemaCanonicalState,
  AppsScriptSchemaMigrationAdapter,
  InMemorySchemaCanonicalState,
  SchemaManager,
  strictCanonicalPropertyKey,
} from "./management";
import type { PropertyStore } from "./infrastructure/runtime";
import { defineDatabase, source, table } from "./schema";
import { InMemorySheetsTransport } from "./transport";

afterEach(() => vi.unstubAllGlobals());

class TestProperties implements PropertyStore {
  private readonly values = new Map<string, string>();

  public get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public getMany(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  public set(key: string, value: string): void {
    this.values.set(key, value);
  }

  public setMany(values: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(values)) this.values.set(key, value);
  }

  public remove(key: string): void {
    this.values.delete(key);
  }

  public removeMany(keys: readonly string[]): void {
    for (const key of keys) this.values.delete(key);
  }
}

describe("schema migration safety", () => {
  it("uses protected metadata as canonical-mode authority and repairs the property mirror lazily", () => {
    const spreadsheetId = "canonical-authority-book";
    const key = strictCanonicalPropertyKey(spreadsheetId);
    const properties = new TestProperties();
    properties.set(key, "false");
    let meta: boolean | undefined = true;
    const readMeta = vi.fn(() => meta);
    const state = new AppsScriptSchemaCanonicalState({ properties, readMeta });

    expect(readMeta).not.toHaveBeenCalled();
    expect(state.isStrictCanonical(spreadsheetId)).toBe(true);
    expect(properties.get(key)).toBe("true");

    properties.remove(key);
    expect(state.isStrictCanonical(spreadsheetId)).toBe(true);
    // The protected value is cached for the current Apps Script execution;
    // the mirror is repaired on the first authoritative read only.
    expect(properties.get(key)).toBeNull();
    expect(readMeta).toHaveBeenCalledTimes(1);

    properties.set(key, "true");
    meta = false;
    const nextExecution = new AppsScriptSchemaCanonicalState({ properties, readMeta });
    expect(nextExecution.isStrictCanonical(spreadsheetId)).toBe(false);
    expect(properties.get(key)).toBe("false");

    properties.set(key, "true");
    meta = undefined;
    const missingMetaExecution = new AppsScriptSchemaCanonicalState({ properties, readMeta });
    expect(missingMetaExecution.isStrictCanonical(spreadsheetId)).toBe(false);
    expect(properties.get(key)).toBeNull();
    expect(readMeta).toHaveBeenCalledTimes(3);
  });

  it("fails closed when protected canonical metadata is malformed", () => {
    const properties = new TestProperties();
    const getDisplayValues = vi.fn(() => [
      ["Key", "Value"],
      ["strict_canonical", "invalid"],
    ]);
    vi.stubGlobal("SpreadsheetApp", {
      openById: vi.fn(() => ({
        getSheetByName: () => ({
          getLastRow: () => 2,
          getRange: () => ({ getDisplayValues }),
        }),
      })),
    });
    const state = new AppsScriptSchemaCanonicalState({ properties });

    expect(() => state.isStrictCanonical("malformed-book")).toThrowError(
      expect.objectContaining({ code: "MIGRATION_REQUIRED" }),
    );
    expect(properties.get(strictCanonicalPropertyKey("malformed-book"))).toBeNull();
  });

  it("audits wrapped legacy codecs canonically and blocks strict activation", () => {
    const migrationSchema = defineDatabase({
      version: 2,
      sources: { main: source.byId("wrapped-legacy-book") },
      tables: {
        Records: table({
          source: "main",
          sheet: "Records",
          primaryKey: ["id"],
          columns: {
            id: withDefault(identifier({
              header: "ID",
              legacyDecoders: [
                (value) => typeof value === "number" ? String(value) : LEGACY_NO_MATCH,
              ],
            }), "missing"),
            label: nullable(text({
              header: "Label",
              legacyDecoders: [
                (value) => typeof value === "number" ? String(value) : LEGACY_NO_MATCH,
              ],
            })),
          },
        }),
      },
    });
    const transport = new InMemorySheetsTransport([{
      spreadsheetId: "wrapped-legacy-book",
      sheets: [
        { sheetId: 1, title: "Records", values: [["ID", "Label"], [101, 202]] },
        {
          sheetId: 2,
          title: "_gq_meta",
          values: [
            ["Key", "Value"],
            ["schema_version", "2"],
            ["migrated_at", "2026-08-26T00:00:00.000Z"],
            ["backup_id", "backup"],
            ["strict_canonical", "false"],
            ["strict_canonical_changed_at", "2026-08-26T00:00:00.000Z"],
          ],
          hasFullSheetProtection: true,
        },
        {
          sheetId: 3,
          title: "_gq_dead_letters",
          values: [["ID", "Mutation ID", "Source", "Table", "Key", "Conflict", "Moved At", "Actor"]],
          hasFullSheetProtection: true,
        },
      ],
    }]);
    const manager = new SchemaManager({
      definition: migrationSchema,
      transport,
      canonicalState: new InMemorySchemaCanonicalState(),
      resolveSourceId: () => "wrapped-legacy-book",
    });

    const plan = manager.plan();
    expect(plan.invalidCells).toBe(0);
    expect(plan.legacyCells).toBe(2);
    expect(plan.actions.filter((action) => action.kind === "backfill-cell")).toEqual([
      expect.objectContaining({ table: "Records", rowIndex: 1, columnIndex: 0, value: "101" }),
      expect.objectContaining({ table: "Records", rowIndex: 1, columnIndex: 1, value: "202" }),
    ]);
    expect(() => manager.activateStrictCanonical({
      confirm: true,
      adapter: { apply: vi.fn() },
    })).toThrow(/clean post-backfill/i);
  });

  it("gates canonical-only activation on a clean audit and provides an explicit rollback", () => {
    const migrationSchema = defineDatabase({
      version: 2,
      sources: { main: source.byId("strict-book") },
      tables: {
        Records: table({
          source: "main",
          sheet: "Records",
          primaryKey: ["id"],
          columns: {
            id: text({ header: "ID" }),
            active: booleanColumn({
              header: "Active",
              legacyDecoders: [(value) => value === "TRUE" ? true : LEGACY_NO_MATCH],
            }),
          },
        }),
      },
    });
    const transport = new InMemorySheetsTransport([{
      spreadsheetId: "strict-book",
      sheets: [
        { sheetId: 1, title: "Records", values: [["ID", "Active"], ["a", "TRUE"]] },
        {
          sheetId: 2,
          title: "_gq_meta",
          values: [
            ["Key", "Value"],
            ["schema_version", "2"],
            ["migrated_at", "2026-08-26T00:00:00.000Z"],
            ["backup_id", "backup"],
            ["strict_canonical", "false"],
            ["strict_canonical_changed_at", "2026-08-26T00:00:00.000Z"],
          ],
        },
        {
          sheetId: 3,
          title: "_gq_dead_letters",
          values: [["ID", "Mutation ID", "Source", "Table", "Key", "Conflict", "Moved At", "Actor"]],
        },
      ],
    }]);
    const state = new InMemorySchemaCanonicalState();
    const manager = new SchemaManager({
      definition: migrationSchema,
      transport,
      canonicalState: state,
      resolveSourceId: () => "strict-book",
    });
    const apply = vi.fn();

    expect(() => manager.activateStrictCanonical({ confirm: true, adapter: { apply } })).toThrow(/clean post-backfill/i);
    expect(apply).not.toHaveBeenCalled();

    transport.atomicBatchUpdate("strict-book", [{
      kind: "updateCells",
      sheetId: 1,
      startRowIndex: 1,
      startColumnIndex: 1,
      values: [[true]],
    }]);
    const activated = manager.activateStrictCanonical({ confirm: true, adapter: { apply } });
    expect(activated.status).toBe("activated");
    expect(manager.strictCanonicalStatus()).toEqual([{ spreadsheetId: "strict-book", strictCanonical: true }]);
    expect(manager.activateStrictCanonical({ confirm: true, adapter: { apply } }).status).toBe("no-op");

    const database = createGQuery(migrationSchema, { transport, canonicalState: state });
    transport.atomicBatchUpdate("strict-book", [{
      kind: "updateCells",
      sheetId: 1,
      startRowIndex: 1,
      startColumnIndex: 1,
      values: [["TRUE"]],
    }]);
    expect(() => database.Records.get()).toThrow(/boolean/i);

    const rolledBack = manager.rollbackStrictCanonical({ confirm: true, adapter: { apply } });
    expect(rolledBack.status).toBe("rolled-back");
    expect(manager.strictCanonicalStatus()[0]?.strictCanonical).toBe(false);
    expect(database.Records.get().rows[0]?.active).toBe(true);
    expect(apply).toHaveBeenNthCalledWith(
      1,
      "strict-book",
      true,
      expect.objectContaining({ changedAt: expect.any(String) }),
    );
    expect(apply).toHaveBeenNthCalledWith(
      2,
      "strict-book",
      false,
      expect.objectContaining({ changedAt: expect.any(String) }),
    );
  });

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

  it("repairs interrupted version backfills and ignores version-only phantom rows", () => {
    const schema = defineDatabase({
      version: 2,
      sources: { main: source.byId("partial-version-book") },
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
      spreadsheetId: "partial-version-book",
      sheets: [
        { sheetId: 7, title: "Records", values: [["ID", "_gq_version"], ["a", 1], ["b", ""], [null, 4]] },
        { sheetId: 8, title: "_gq_meta", values: [["Key", "Value"]] },
        { sheetId: 9, title: "_gq_dead_letters", values: [["ID", "Actor"]] },
      ],
    }]);

    const plan = createGQuery(schema, { transport }).schema.plan();
    expect(plan.tables[0]).toMatchObject({ decodedRows: 2 });
    expect(plan.issues.filter((issue) => issue.code === "INVALID_VERSION")).toHaveLength(1);
    expect(plan.actions.filter((action) => action.kind === "repair-version-cell"))
      .toEqual([expect.objectContaining({ rowIndex: 2, columnIndex: 1, value: 1 })]);
    expect(plan.issues.some((issue) => issue.code === "INVALID_CELL")).toBe(false);
  });

  it("plans the actor-column upgrade for an existing dead-letter system sheet", () => {
    const schema = defineDatabase({
      version: 2,
      sources: { main: source.byId("migration-book") },
      tables: {
        Records: table({
          source: "main",
          sheet: "Records",
          primaryKey: ["id"],
          columns: { id: text({ header: "ID" }) },
        }),
      },
    });
    const transport = new InMemorySheetsTransport([{
      spreadsheetId: "migration-book",
      sheets: [
        { sheetId: 1, title: "Records", values: [["ID"], ["one"]] },
        { sheetId: 2, title: "_gq_meta", values: [["Key", "Value"]] },
        {
          sheetId: 3,
          title: "_gq_dead_letters",
          values: [["ID", "Mutation ID", "Source", "Table", "Key", "Conflict", "Moved At"]],
        },
      ],
    }]);

    expect(createGQuery(schema, { transport }).schema.plan().actions).toContainEqual({
      kind: "add-dead-letter-actor-column",
      spreadsheetId: "migration-book",
      sheetId: 3,
      columnIndex: 7,
      gridColumnCount: 7,
    });
  });

  it("repairs interrupted system-sheet creation, including metadata content and protection", () => {
    const schema = defineDatabase({
      version: 2,
      sources: { main: source.byId("interrupted-book") },
      tables: {
        Records: table({
          source: "main",
          sheet: "Records",
          primaryKey: ["id"],
          columns: { id: text({ header: "ID" }) },
        }),
      },
    });
    const transport = new InMemorySheetsTransport([{
      spreadsheetId: "interrupted-book",
      sheets: [
        { sheetId: 1, title: "Records", values: [["ID"], ["one"]] },
        {
          sheetId: 2,
          title: "_gq_meta",
          values: [["Key"], ["schema_version", ""], ["strict_canonical", "invalid"]],
          hasFullSheetProtection: false,
        },
        {
          sheetId: 3,
          title: "_gq_dead_letters",
          values: [["ID", "Mutation ID", "", "Table"]],
          hasFullSheetProtection: false,
        },
      ],
    }]);
    const database = createGQuery(schema, { transport });

    const plan = database.schema.plan();
    expect(plan.canMigrate).toBe(true);
    expect(plan.issues.filter((issue) => issue.code === "INVALID_SYSTEM_SHEET")).toHaveLength(2);
    expect(plan.issues.filter((issue) => issue.code === "UNPROTECTED_SYSTEM_SHEET")).toHaveLength(2);
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "repair-system-sheet-cells", sheet: "_gq_meta", sheetId: 2 }),
      expect.objectContaining({ kind: "repair-system-sheet-cells", sheet: "_gq_dead_letters", sheetId: 3 }),
      expect.objectContaining({ kind: "protect-system-sheet", sheet: "_gq_meta", sheetId: 2 }),
      expect.objectContaining({ kind: "protect-system-sheet", sheet: "_gq_dead_letters", sheetId: 3 }),
    ]));

    const apply = vi.fn();
    const result = database.schema.migrate({
      confirm: true,
      backupIds: { "interrupted-book": "backup-copy" },
      adapter: { createBackup: vi.fn(), apply },
    });
    expect(result.status).toBe("migrated");
    expect(apply).toHaveBeenCalledWith(
      "interrupted-book",
      expect.arrayContaining([
        expect.objectContaining({ kind: "repair-system-sheet-cells", sheet: "_gq_meta" }),
        expect.objectContaining({ kind: "protect-system-sheet", sheet: "_gq_dead_letters" }),
      ]),
      expect.objectContaining({ backupId: "backup-copy" }),
    );
  });

  it("treats fully repaired system sheets as an idempotent no-op", () => {
    const schema = defineDatabase({
      version: 2,
      sources: { main: source.byId("repaired-book") },
      tables: {
        Records: table({
          source: "main",
          sheet: "Records",
          primaryKey: ["id"],
          columns: { id: text({ header: "ID" }) },
        }),
      },
    });
    const transport = new InMemorySheetsTransport([{
      spreadsheetId: "repaired-book",
      sheets: [
        { sheetId: 1, title: "Records", values: [["ID"], ["one"]] },
        {
          sheetId: 2,
          title: "_gq_meta",
          values: [
            ["Key", "Value"],
            ["schema_version", "2"],
            ["migrated_at", "2026-08-26T00:00:00.000Z"],
            ["backup_id", "backup-copy"],
            ["strict_canonical", "false"],
            ["strict_canonical_changed_at", "2026-08-26T00:00:00.000Z"],
          ],
          hasFullSheetProtection: true,
        },
        {
          sheetId: 3,
          title: "_gq_dead_letters",
          values: [["ID", "Mutation ID", "Source", "Table", "Key", "Conflict", "Moved At", "Actor"]],
          hasFullSheetProtection: true,
        },
      ],
    }]);

    const plan = createGQuery(schema, { transport }).schema.plan();
    expect(plan.actions).toEqual([]);
    expect(plan.issues.filter((issue) =>
      issue.code === "INVALID_SYSTEM_SHEET" || issue.code === "UNPROTECTED_SYSTEM_SHEET",
    )).toEqual([]);
  });

  it("compiles system-sheet repairs with migration context and full-sheet protection", () => {
    const batchUpdate = vi.fn(() => ({}));
    vi.stubGlobal("Sheets", {
      Spreadsheets: {
        get: () => ({ sheets: [
          { properties: { sheetId: 2, title: "_gq_meta" } },
          { properties: { sheetId: 3, title: "_gq_dead_letters" } },
        ] }),
        batchUpdate,
      },
    });
    new AppsScriptSchemaMigrationAdapter().apply(
      "interrupted-book",
      [
        {
          kind: "repair-system-sheet-cells",
          spreadsheetId: "interrupted-book",
          sheet: "_gq_meta",
          sheetId: 2,
          gridColumnCount: 1,
          cells: [
            { rowIndex: 0, columnIndex: 1, value: { kind: "literal", value: "Value" } },
            { rowIndex: 3, columnIndex: 1, value: { kind: "backup-id" } },
            { rowIndex: 5, columnIndex: 1, value: { kind: "migration-time" } },
          ],
        },
        {
          kind: "protect-system-sheet",
          spreadsheetId: "interrupted-book",
          sheet: "_gq_meta",
          sheetId: 2,
        },
      ],
      { backupId: "backup-copy", migratedAt: "2026-08-26T12:34:56.000Z" },
    );

    const requests = batchUpdate.mock.calls.flatMap((call) => call[0].requests) as Array<{
      appendDimension?: { sheetId?: number; length?: number };
      updateCells?: { rows?: Array<{ values?: Array<{ userEnteredValue?: { stringValue?: string } }> }> };
      addProtectedRange?: { protectedRange?: { range?: { sheetId?: number } } };
    }>;
    expect(requests).toContainEqual(expect.objectContaining({
      appendDimension: expect.objectContaining({ sheetId: 2, length: 1 }),
    }));
    expect(requests.flatMap((request) =>
      request.updateCells?.rows?.flatMap((row) =>
        row.values?.map((cell) => cell.userEnteredValue?.stringValue) ?? [],
      ) ?? [],
    )).toEqual(expect.arrayContaining(["Value", "backup-copy", "2026-08-26T12:34:56.000Z"]));
    expect(requests).toContainEqual(expect.objectContaining({
      addProtectedRange: expect.objectContaining({
        protectedRange: expect.objectContaining({ range: { sheetId: 2 } }),
      }),
    }));
  });

  it("splits large version spans and measures request chunks as UTF-8 bytes", () => {
    const batchUpdate = vi.fn(() => ({}));
    vi.stubGlobal("Sheets", {
      Spreadsheets: {
        get: () => ({ sheets: [{ properties: { sheetId: 7, title: "Records" } }] }),
        batchUpdate,
      },
    });
    const adapter = new AppsScriptSchemaMigrationAdapter();
    adapter.apply(
      "migration-book",
      [{
        kind: "add-version-column",
        spreadsheetId: "migration-book",
        table: "Records",
        sheet: "Records",
        sheetId: 7,
        header: "_gq_version",
        columnIndex: 1,
        populatedRowIndexes: Array.from({ length: 25_001 }, (_, index) => index + 1),
        gridColumnCount: 2,
      }],
      { backupId: "backup", migratedAt: "2026-08-26T00:00:00.000Z" },
    );

    const versionRequests = batchUpdate.mock.calls.flatMap((call) => call[0].requests).filter(
      (request: { updateCells?: { range?: { startRowIndex?: number }; rows?: unknown[] } }) =>
        (request.updateCells?.range?.startRowIndex ?? 0) > 0,
    ) as Array<{ updateCells: { rows: unknown[] } }>;
    expect(versionRequests.map((request) => request.updateCells.rows.length)).toEqual([10_000, 10_000, 5_001]);

    batchUpdate.mockClear();
    adapter.apply(
      "migration-book",
      Array.from({ length: 15 }, (_, index) => ({
        kind: "backfill-cell" as const,
        spreadsheetId: "migration-book",
        table: "Records",
        sheet: "Records",
        sheetId: 7,
        rowIndex: index + 1,
        columnIndex: 0,
        value: "漢".repeat(48_000),
      })),
      { backupId: "backup", migratedAt: "2026-08-26T00:00:00.000Z" },
    );
    expect(batchUpdate.mock.calls.length).toBeGreaterThan(1);
  });
});
