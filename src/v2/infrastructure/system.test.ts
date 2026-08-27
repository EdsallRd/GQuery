import { describe, expect, it } from "vitest";
import { Fnv1aHash } from "./canonical";
import { GenerationTokenStore } from "./cache";
import {
  InstalledTrigger,
  ManagedTriggerSpec,
  SystemEventCoordinator,
  TriggerPlatform,
  TriggerReconciler,
} from "./system";
import { PropertyStore } from "./runtime";

class MemoryProperties implements PropertyStore {
  private readonly values = new Map<string, string>();
  public get(key: string): string | null { return this.values.get(key) ?? null; }
  public getMany(): Record<string, string> { return Object.fromEntries(this.values); }
  public set(key: string, value: string): void { this.values.set(key, value); }
  public setMany(values: Readonly<Record<string, string>>): void {
    Object.entries(values).forEach(([key, value]) => this.values.set(key, value));
  }
  public remove(key: string): void { this.values.delete(key); }
  public removeMany(keys: readonly string[]): void { keys.forEach((key) => this.values.delete(key)); }
}

class MemoryTriggers implements TriggerPlatform {
  public readonly installed: InstalledTrigger[];
  public readonly removed: string[] = [];
  private id = 10;
  public constructor(installed: InstalledTrigger[]) { this.installed = installed; }
  public list(): readonly InstalledTrigger[] { return this.installed; }
  public create(spec: ManagedTriggerSpec): InstalledTrigger {
    const trigger = { ...spec, id: `new-${++this.id}` };
    this.installed.push(trigger);
    return trigger;
  }
  public remove(id: string): void { this.removed.push(id); }
}

describe("TriggerReconciler", () => {
  it("keeps exact triggers, removes managed duplicates, and leaves unrelated handlers", () => {
    const platform = new MemoryTriggers([
      { id: "edit-1", kind: "edit", handler: "gqueryOnEdit", spreadsheetId: "book" },
      { id: "edit-duplicate", kind: "edit", handler: "gqueryOnEdit", spreadsheetId: "book" },
      { id: "old-flush", kind: "clock", handler: "gqueryFlush", everyMinutes: 10 },
      { id: "other", kind: "clock", handler: "unrelated", everyMinutes: 1 },
    ]);
    const result = new TriggerReconciler(platform).reconcile({
      spreadsheetId: "book",
      onEdit: "gqueryOnEdit",
      onChange: "gqueryOnChange",
      flush: { handler: "gqueryFlush", everyMinutes: 5 },
    });
    expect(result.kept.map((trigger) => trigger.id)).toEqual(["edit-1"]);
    expect(result.created.map((trigger) => trigger.handler)).toEqual(["gqueryOnChange", "gqueryFlush"]);
    expect(platform.removed).toEqual(["edit-duplicate", "old-flush"]);
  });
});

describe("SystemEventCoordinator", () => {
  it("bumps table and resolved row generations for a manual edit", () => {
    const properties = new MemoryProperties();
    let id = 0;
    const generations = new GenerationTokenStore(
      properties,
      new Fnv1aHash(),
      { next: () => `token-${++id}` },
    );
    const coordinator = new SystemEventCoordinator(
      [{ sourceId: "book", sheetId: 5, table: "Assets" }],
      generations,
      { onRowsEdited: () => ["0001", "0002"] },
    );
    const result = coordinator.handleEdit({
      sourceId: "book",
      sheetId: 5,
      rowStart: 2,
      rowCount: 2,
      columnStart: 3,
      columnCount: 1,
    });
    expect(result).toEqual({ invalidatedTables: ["Assets"], invalidatedRows: 2 });
    expect(generations.current({ kind: "table", sourceId: "book", table: "Assets" })).not.toBe("0");
    expect(
      generations.current({ kind: "row", sourceId: "book", table: "Assets", key: "0001" }),
    ).not.toBe("0");
  });
});
