import { afterEach, describe, expect, it, vi } from "vitest";
import { text } from "./codecs";
import {
  AppsScriptDeadLetterSheet,
  DeferredManager,
  type DeferredManagerAccess,
} from "./deferred-manager";
import {
  DeferredJournal,
  type DeferredDeadLetter,
} from "./infrastructure/deferred";
import { Fnv1aHash } from "./infrastructure/canonical";
import type { PropertyStore } from "./infrastructure/runtime";
import type { Selection } from "./selection";
import { defineDatabase, source, table, type DatabaseDefinition } from "./schema";

afterEach(() => vi.unstubAllGlobals());

class MemoryProperties implements PropertyStore {
  private readonly values = new Map<string, string>();
  public get(key: string): string | null { return this.values.get(key) ?? null; }
  public getMany(): Record<string, string> { return Object.fromEntries(this.values); }
  public set(key: string, value: string): void { this.values.set(key, value); }
  public setMany(values: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(values)) this.values.set(key, value);
  }
  public remove(key: string): void { this.values.delete(key); }
  public removeMany(keys: readonly string[]): void {
    for (const key of keys) this.values.delete(key);
  }
}

function schema(active: boolean): DatabaseDefinition {
  return defineDatabase({
    version: 2,
    sources: { main: active ? source.activeSpreadsheet() : source.byId("configured-book") },
    tables: {
      Assets: table({
        source: "main",
        sheet: "Assets",
        primaryKey: ["id"],
        columns: { id: text({ header: "ID" }) },
      }),
    },
  });
}

function setup(definition: DatabaseDefinition, queuedSourceId: string) {
  const properties = new MemoryProperties();
  let id = 0;
  const journal = new DeferredJournal({
    properties,
    lock: { tryAcquire: () => true, release: () => undefined },
    hasher: new Fnv1aHash(),
    ids: { next: () => `id-${++id}` },
    clock: { now: () => 100 },
  });
  journal.enqueue({
    sourceId: queuedSourceId,
    table: "Assets",
    kind: "delete",
    key: { id: "A1" },
    idempotencyKey: "delete-A1",
  });
  return { properties, journal };
}

function emptySelection(): Selection<Record<string, unknown>> {
  return { length: 0 } as Selection<Record<string, unknown>>;
}

describe("DeferredManager source binding", () => {
  it("retains an active-source mutation until the trigger resolves its persisted workbook", () => {
    const definition = schema(true);
    const { properties, journal } = setup(definition, "target-book");
    let resolvedSourceId = "wrong-active-book";
    let finds = 0;
    const access: DeferredManagerAccess = {
      definition,
      resolveSourceId: () => resolvedSourceId,
      find: () => { finds += 1; return emptySelection(); },
      append: () => { throw new Error("not used"); },
    };
    const manager = new DeferredManager(access, {
      journal,
      appliedReceipts: properties,
      deadLetters: { write: () => undefined },
    });

    expect(manager.flush()).toMatchObject({ committed: 0, conflicted: 0, retained: 1 });
    expect(finds).toBe(0);
    expect(journal.list()[0]).toMatchObject({ attempts: 1 });

    resolvedSourceId = "target-book";
    expect(manager.flush()).toMatchObject({ committed: 1, conflicted: 0, retained: 0 });
    expect(finds).toBe(1);
  });

  it("dead-letters a durable fixed-source mismatch without touching the configured workbook", () => {
    const definition = schema(false);
    const { properties, journal } = setup(definition, "wrong-book");
    const deadLetters: DeferredDeadLetter[] = [];
    let finds = 0;
    const manager = new DeferredManager({
      definition,
      resolveSourceId: () => "configured-book",
      find: () => { finds += 1; return emptySelection(); },
      append: () => { throw new Error("not used"); },
    }, {
      journal,
      appliedReceipts: properties,
      deadLetters: { write: (records) => deadLetters.push(...records) },
    });

    expect(manager.flush()).toMatchObject({ committed: 0, conflicted: 1, retained: 0 });
    expect(finds).toBe(0);
    expect(deadLetters).toHaveLength(1);
    expect(journal.receipt("delete-A1")?.status).toBe("conflicted");
  });
});

describe("AppsScriptDeadLetterSheet", () => {
  it("deduplicates deterministic record IDs and persists the original actor", () => {
    const headers = ["ID", "Mutation ID", "Source", "Table", "Key", "Conflict", "Moved At", "Actor"];
    const rows: string[][] = [headers, ["already-written", "old", "book", "Assets", "{}", "{}", "2026-01-01", "old-actor"]];
    const sheet = {
      getLastRow: () => rows.length,
      getLastColumn: () => headers.length,
      getRange: (row: number, column: number, rowCount: number, columnCount: number) => ({
        getDisplayValues: () => Array.from({ length: rowCount }, (_, rowOffset) =>
          Array.from({ length: columnCount }, (_, columnOffset) =>
            rows[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? ""
          )
        ),
        setValues: (values: string[][]) => {
          for (let rowOffset = 0; rowOffset < values.length; rowOffset += 1) {
            const target = rows[row - 1 + rowOffset] ?? Array.from({ length: headers.length }, () => "");
            for (let columnOffset = 0; columnOffset < values[rowOffset].length; columnOffset += 1) {
              target[column - 1 + columnOffset] = values[rowOffset][columnOffset];
            }
            rows[row - 1 + rowOffset] = target;
          }
        },
      }),
    };
    vi.stubGlobal("SpreadsheetApp", {
      openById: (id: string) => {
        expect(id).toBe("book");
        return { getSheetByName: () => sheet };
      },
    });
    const record = (id: string) => ({
      id,
      mutation: {
        id: `mutation-${id}`,
        sourceMutationIds: [`source-${id}`],
        sourceMutations: [],
        sourceId: "book",
        table: "Assets",
        kind: "delete" as const,
        key: { id: "A1" },
        actor: "liam@example.test",
        firstSequence: 1,
      },
      originals: [],
      conflict: { message: "version conflict" },
      movedAtMs: Date.parse("2026-08-26T12:00:00.000Z"),
    });
    const sink = new AppsScriptDeadLetterSheet();

    sink.write([record("already-written"), record("new-record")]);
    sink.write([record("new-record")]);

    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual([
      "new-record",
      "mutation-new-record",
      "book",
      "Assets",
      JSON.stringify({ id: "A1" }),
      JSON.stringify({ message: "version conflict" }),
      "2026-08-26T12:00:00.000Z",
      "liam@example.test",
    ]);
  });
});
