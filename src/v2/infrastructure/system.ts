import { GenerationTokenStore } from "./cache";
import { AppsScriptPropertyStore, PropertyStore } from "./runtime";

export type ManagedTriggerKind = "edit" | "change" | "clock";

export interface ManagedTriggerSpec {
  readonly kind: ManagedTriggerKind;
  readonly handler: string;
  readonly spreadsheetId?: string;
  readonly everyMinutes?: number;
}

export interface InstalledTrigger extends ManagedTriggerSpec {
  readonly id: string;
  /** True only when this reconciliation namespace durably owns the trigger ID. */
  readonly managed?: boolean;
}

export interface TriggerPlatform {
  list(): readonly InstalledTrigger[];
  create(spec: ManagedTriggerSpec): InstalledTrigger;
  remove(id: string): void;
  /** Persist ownership when an exact pre-existing trigger is adopted. */
  manage?(trigger: InstalledTrigger): InstalledTrigger;
}

export interface TriggerConfiguration {
  readonly spreadsheetId: string;
  readonly onEdit?: string;
  readonly onChange?: string;
  readonly flush?: {
    readonly handler: string;
    readonly everyMinutes: 1 | 5 | 10 | 15 | 30;
  };
}

export interface TriggerReconciliationResult {
  readonly created: readonly InstalledTrigger[];
  readonly kept: readonly InstalledTrigger[];
  readonly removed: readonly InstalledTrigger[];
}

function sameTrigger(left: ManagedTriggerSpec, right: ManagedTriggerSpec): boolean {
  return (
    left.kind === right.kind &&
    left.handler === right.handler &&
    left.spreadsheetId === right.spreadsheetId &&
    left.everyMinutes === right.everyMinutes
  );
}

/** Reconciles durably owned trigger IDs and leaves unrelated project triggers alone. */
export class TriggerReconciler {
  public constructor(private readonly platform: TriggerPlatform) {}

  public reconcile(configuration: TriggerConfiguration): TriggerReconciliationResult {
    const desired: ManagedTriggerSpec[] = [];
    if (configuration.onEdit !== undefined) {
      desired.push({
        kind: "edit",
        handler: configuration.onEdit,
        spreadsheetId: configuration.spreadsheetId,
      });
    }
    if (configuration.onChange !== undefined) {
      desired.push({
        kind: "change",
        handler: configuration.onChange,
        spreadsheetId: configuration.spreadsheetId,
      });
    }
    if (configuration.flush !== undefined) {
      desired.push({
        kind: "clock",
        handler: configuration.flush.handler,
        everyMinutes: configuration.flush.everyMinutes,
      });
    }

    const installed = [...this.platform.list()];
    const kept: InstalledTrigger[] = [];
    const used = new Set<string>();
    for (const spec of desired) {
      const exact = (candidate: InstalledTrigger): boolean =>
        !used.has(candidate.id) && sameTrigger(candidate, spec);
      const match = installed.find((candidate) => candidate.managed === true && exact(candidate))
        ?? installed.find(exact);
      if (match !== undefined) {
        const owned = match.managed === true || this.platform.manage === undefined
          ? match
          : this.platform.manage(match);
        kept.push(owned);
        used.add(owned.id);
      }
    }

    const removed = installed.filter(
      (candidate) => candidate.managed === true && !used.has(candidate.id),
    );
    for (const trigger of removed) this.platform.remove(trigger.id);

    const created = desired
      .filter((spec) => !kept.some((candidate) => sameTrigger(candidate, spec)))
      .map((spec) => this.platform.create(spec));
    return { created, kept, removed };
  }
}

interface StoredTriggerMetadata {
  readonly version: 1;
  readonly spec: ManagedTriggerSpec;
}

/** Apps Script adapter which persists clock cadence because Trigger does not expose it. */
export class AppsScriptTriggerPlatform implements TriggerPlatform {
  public constructor(
    private readonly properties: PropertyStore,
    private readonly metadataNamespace = "gq2",
  ) {}

  public list(): readonly InstalledTrigger[] {
    return ScriptApp.getProjectTriggers().map((trigger) => {
      const id = trigger.getUniqueId();
      const stored = this.readMetadata(id);
      if (stored !== null) return { ...stored.spec, id, managed: true };

      const event = trigger.getEventType();
      const kind: ManagedTriggerKind = event === ScriptApp.EventType.ON_EDIT
        ? "edit"
        : event === ScriptApp.EventType.ON_CHANGE
          ? "change"
          : "clock";
      let spreadsheetId: string | undefined;
      if (kind !== "clock") {
        try {
          spreadsheetId = trigger.getTriggerSourceId();
        } catch {
          spreadsheetId = undefined;
        }
      }
      return {
        id,
        kind,
        handler: trigger.getHandlerFunction(),
        spreadsheetId,
        managed: false,
      };
    });
  }

  public create(spec: ManagedTriggerSpec): InstalledTrigger {
    let trigger: GoogleAppsScript.Script.Trigger;
    if (spec.kind === "clock") {
      if (spec.everyMinutes === undefined) throw new TypeError("Clock triggers require everyMinutes.");
      trigger = ScriptApp.newTrigger(spec.handler)
        .timeBased()
        .everyMinutes(spec.everyMinutes)
        .create();
    } else {
      if (spec.spreadsheetId === undefined) throw new TypeError("Sheet triggers require spreadsheetId.");
      const builder = ScriptApp.newTrigger(spec.handler).forSpreadsheet(spec.spreadsheetId);
      trigger = spec.kind === "edit" ? builder.onEdit().create() : builder.onChange().create();
    }
    const id = trigger.getUniqueId();
    const metadata: StoredTriggerMetadata = { version: 1, spec };
    try {
      this.properties.set(this.metadataKey(id), JSON.stringify(metadata));
    } catch (error) {
      ScriptApp.deleteTrigger(trigger);
      throw error;
    }
    return { ...spec, id, managed: true };
  }

  public manage(trigger: InstalledTrigger): InstalledTrigger {
    const spec: ManagedTriggerSpec = {
      kind: trigger.kind,
      handler: trigger.handler,
      ...(trigger.spreadsheetId === undefined ? {} : { spreadsheetId: trigger.spreadsheetId }),
      ...(trigger.everyMinutes === undefined ? {} : { everyMinutes: trigger.everyMinutes }),
    };
    this.properties.set(this.metadataKey(trigger.id), JSON.stringify({ version: 1, spec } satisfies StoredTriggerMetadata));
    return { ...trigger, managed: true };
  }

  public remove(id: string): void {
    const trigger = ScriptApp.getProjectTriggers().find((candidate) => candidate.getUniqueId() === id);
    if (trigger !== undefined) ScriptApp.deleteTrigger(trigger);
    try {
      this.properties.remove(this.metadataKey(id));
    } catch {
      // Stale metadata is ignored when no trigger with this id exists.
    }
  }

  private metadataKey(id: string): string {
    return `${this.metadataNamespace}:trigger:${id}`;
  }

  private readMetadata(id: string): StoredTriggerMetadata | null {
    const raw = this.properties.get(this.metadataKey(id));
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredTriggerMetadata>;
      return parsed.version === 1 && typeof parsed.spec === "object" && parsed.spec !== null
        ? (parsed as StoredTriggerMetadata)
        : null;
    } catch {
      return null;
    }
  }
}

export function createAppsScriptTriggerReconciler(namespace?: string): TriggerReconciler {
  return new TriggerReconciler(
    new AppsScriptTriggerPlatform(
      new AppsScriptPropertyStore(PropertiesService.getScriptProperties()),
      namespace,
    ),
  );
}

export interface RegisteredSheetTable {
  readonly sourceId: string;
  readonly sheetId: number;
  readonly table: string;
}

export interface NormalizedEditEvent {
  readonly sourceId: string;
  readonly sheetId: number;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly columnStart: number;
  readonly columnCount: number;
}

export interface NormalizedChangeEvent {
  readonly sourceId: string;
  readonly changeType: GoogleAppsScript.Events.SheetsOnChangeChangeType;
}

export interface ManualEditHooks {
  /** Implementations may increment hidden row versions and return decoded primary keys. */
  onRowsEdited?(
    table: RegisteredSheetTable,
    event: NormalizedEditEvent,
  ): readonly unknown[] | void;
  onStructuralChange?(
    tables: readonly RegisteredSheetTable[],
    event: NormalizedChangeEvent,
  ): void;
}

export interface SystemEventResult {
  readonly invalidatedTables: readonly string[];
  readonly invalidatedRows: number;
}

/** Bridges normalized or native installable-trigger events to version/cache invalidation hooks. */
export class SystemEventCoordinator {
  public constructor(
    private readonly tables: readonly RegisteredSheetTable[],
    private readonly generations: GenerationTokenStore,
    private readonly hooks: ManualEditHooks = {},
  ) {}

  public handleEdit(event: NormalizedEditEvent): SystemEventResult {
    const table = this.tables.find(
      (candidate) => candidate.sourceId === event.sourceId && candidate.sheetId === event.sheetId,
    );
    if (table === undefined) return { invalidatedTables: [], invalidatedRows: 0 };
    try {
      this.hooks.onRowsEdited?.(table, event);
    } finally {
      // Even malformed/cleared primary keys must not leave a pre-edit cached
      // snapshot reachable when the hook reports a decoding problem.
      this.generations.invalidateTable(table.sourceId, table.table);
    }
    // Current read caches consume table generations only. Row tokens remain a
    // public opt-in invalidation primitive and must not leak one property per edit.
    return { invalidatedTables: [table.table], invalidatedRows: 0 };
  }

  public handleNativeEdit(event: GoogleAppsScript.Events.SheetsOnEdit): SystemEventResult {
    const sheet = event.range.getSheet();
    return this.handleEdit({
      sourceId: event.source.getId(),
      sheetId: sheet.getSheetId(),
      rowStart: event.range.getRow(),
      rowCount: event.range.getNumRows(),
      columnStart: event.range.getColumn(),
      columnCount: event.range.getNumColumns(),
    });
  }

  public handleChange(event: NormalizedChangeEvent): SystemEventResult {
    const tables = this.tables.filter((table) => table.sourceId === event.sourceId);
    for (const table of tables) this.generations.invalidateTable(table.sourceId, table.table);
    this.hooks.onStructuralChange?.(tables, event);
    return { invalidatedTables: tables.map((table) => table.table), invalidatedRows: 0 };
  }

  public handleNativeChange(event: GoogleAppsScript.Events.SheetsOnChange): SystemEventResult {
    return this.handleChange({ sourceId: event.source.getId(), changeType: event.changeType });
  }
}
