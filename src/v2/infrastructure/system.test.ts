import { afterEach, describe, expect, it, vi } from "vitest";
import { Fnv1aHash } from "./canonical";
import { GenerationTokenStore } from "./cache";
import {
  InstalledTrigger,
  AppsScriptTriggerPlatform,
  ManagedTriggerSpec,
  SystemEventCoordinator,
  TriggerPlatform,
  TriggerReconciler,
} from "./system";
import { PropertyStore } from "./runtime";

afterEach(() => vi.unstubAllGlobals());

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
    const trigger = { ...spec, id: `new-${++this.id}`, managed: true };
    this.installed.push(trigger);
    return trigger;
  }
  public remove(id: string): void { this.removed.push(id); }
  public manage(trigger: InstalledTrigger): InstalledTrigger {
    const index = this.installed.findIndex((candidate) => candidate.id === trigger.id);
    const managed = { ...trigger, managed: true };
    if (index >= 0) this.installed[index] = managed;
    return managed;
  }
}

describe("TriggerReconciler", () => {
  it("keeps exact triggers, removes managed duplicates, and leaves unrelated handlers", () => {
    const platform = new MemoryTriggers([
      { id: "edit-1", kind: "edit", handler: "gqueryOnEdit", spreadsheetId: "book", managed: true },
      { id: "edit-duplicate", kind: "edit", handler: "gqueryOnEdit", spreadsheetId: "book", managed: true },
      { id: "old-flush", kind: "clock", handler: "gqueryFlush", everyMinutes: 10, managed: true },
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

  it("removes durably managed triggers after handlers are renamed without touching unrelated triggers", () => {
    const platform = new MemoryTriggers([
      { id: "old-edit", kind: "edit", handler: "oldGqueryOnEdit", spreadsheetId: "book", managed: true },
      { id: "old-flush", kind: "clock", handler: "oldGqueryFlush", everyMinutes: 5, managed: true },
      { id: "same-name-unmanaged", kind: "clock", handler: "oldGqueryFlush", everyMinutes: 5 },
      { id: "unrelated", kind: "change", handler: "appOnChange", spreadsheetId: "book" },
    ]);

    const result = new TriggerReconciler(platform).reconcile({
      spreadsheetId: "book",
      onEdit: "gqueryOnEditV2",
      flush: { handler: "gqueryFlushV2", everyMinutes: 5 },
    });

    expect(result.removed.map((trigger) => trigger.id)).toEqual(["old-edit", "old-flush"]);
    expect(platform.removed).toEqual(["old-edit", "old-flush"]);
    expect(result.created.map((trigger) => trigger.handler)).toEqual(["gqueryOnEditV2", "gqueryFlushV2"]);
    expect(platform.removed).not.toContain("same-name-unmanaged");
    expect(platform.removed).not.toContain("unrelated");
  });

  it("adopts an exact unmanaged trigger so a later rename can clean it up safely", () => {
    const platform = new MemoryTriggers([
      { id: "legacy-edit", kind: "edit", handler: "gqueryOnEdit", spreadsheetId: "book" },
    ]);
    const reconciler = new TriggerReconciler(platform);

    expect(reconciler.reconcile({ spreadsheetId: "book", onEdit: "gqueryOnEdit" }).kept)
      .toEqual([expect.objectContaining({ id: "legacy-edit", managed: true })]);
    expect(reconciler.reconcile({ spreadsheetId: "book", onEdit: "gqueryOnEditV2" }).removed)
      .toEqual([expect.objectContaining({ id: "legacy-edit", managed: true })]);
  });

  it("persists adopted trigger ownership by unique ID", () => {
    const properties = new MemoryProperties();
    const trigger = {
      getUniqueId: () => "trigger-1",
      getEventType: () => "ON_EDIT",
      getTriggerSourceId: () => "book",
      getHandlerFunction: () => "gqueryOnEdit",
    };
    vi.stubGlobal("ScriptApp", {
      EventType: { ON_EDIT: "ON_EDIT", ON_CHANGE: "ON_CHANGE" },
      getProjectTriggers: () => [trigger],
    });
    const platform = new AppsScriptTriggerPlatform(properties);
    const discovered = platform.list()[0];
    if (discovered === undefined) throw new Error("missing discovered trigger");
    expect(discovered).toMatchObject({ id: "trigger-1", managed: false });

    platform.manage(discovered);

    expect(platform.list()[0]).toMatchObject({
      id: "trigger-1",
      handler: "gqueryOnEdit",
      spreadsheetId: "book",
      managed: true,
    });
    expect(Object.keys(properties.getMany())).toEqual(["gq2:trigger:trigger-1"]);
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
    expect(result).toEqual({ invalidatedTables: ["Assets"], invalidatedRows: 0 });
    expect(generations.current({ kind: "table", sourceId: "book", table: "Assets" })).not.toBe("0");
    expect(
      generations.current({ kind: "row", sourceId: "book", table: "Assets", key: "0001" }),
    ).toBe("0");
  });

  it("invalidates the table even when edited primary-key decoding fails", () => {
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
      { onRowsEdited: () => { throw new Error("invalid primary key"); } },
    );

    expect(() => coordinator.handleEdit({
      sourceId: "book",
      sheetId: 5,
      rowStart: 2,
      rowCount: 1,
      columnStart: 1,
      columnCount: 1,
    })).toThrow("invalid primary key");
    expect(generations.current({ kind: "table", sourceId: "book", table: "Assets" }))
      .not.toBe("0");
  });
});
