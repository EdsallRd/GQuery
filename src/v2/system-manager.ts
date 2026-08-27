import type { GQueryExecutor, RuntimeGenerationAdapter } from "./executor";
import { BLANK_CELL } from "./codecs";
import { GQueryRuntimeError } from "./runtime-errors";
import type { DatabaseDefinition, TableDefinition } from "./schema";
import type { SheetsTransport } from "./transport";
import {
  SystemEventCoordinator,
  createAppsScriptTriggerReconciler,
  type ManualEditHooks,
  type NormalizedChangeEvent,
  type NormalizedEditEvent,
  type RegisteredSheetTable,
  type SystemEventResult,
  type TriggerConfiguration,
  type TriggerReconciliationResult,
} from "./infrastructure/system";
import type { GenerationTokenStore } from "./infrastructure/cache";

export interface TriggerSetup {
  readonly spreadsheetId?: string;
  readonly onEdit?: string;
  readonly onChange?: string;
  readonly flush?: {
    readonly handler: string;
    readonly everyMinutes: 1 | 5 | 10 | 15 | 30;
  };
}

export interface SystemStatus {
  readonly tables: readonly (RegisteredSheetTable & { readonly generation: string })[];
}

export interface SystemManagerAccess {
  readonly definition: DatabaseDefinition;
  readonly transport: SheetsTransport;
  readonly executor: GQueryExecutor;
  readonly generations?: RuntimeGenerationAdapter;
  resolveSourceId(sourceName: string): string;
}

function tableByName(definition: DatabaseDefinition, name: string): TableDefinition {
  const table = definition.tables[name];
  if (table === undefined) throw new GQueryRuntimeError("INVALID_QUERY", `Unknown table ${name}.`);
  return table;
}

/** Implements manual-edit version increments with one bounded read/write per edited block. */
export class AppsScriptManualEditHooks implements ManualEditHooks {
  public constructor(private readonly definition: DatabaseDefinition) {}

  public onRowsEdited(
    table: RegisteredSheetTable,
    event: NormalizedEditEvent,
  ): readonly unknown[] {
    const definition = tableByName(this.definition, table.table);
    const versionHeader = definition.versionColumn;
    const spreadsheet = SpreadsheetApp.openById(table.sourceId);
    const sheet = spreadsheet.getSheets().find((candidate) => candidate.getSheetId() === table.sheetId);
    if (sheet === undefined) return [];
    const lastColumn = Math.max(1, sheet.getLastColumn());
    const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
    const startRow = Math.max(2, event.rowStart);
    const endRow = event.rowStart + event.rowCount - 1;
    if (endRow < startRow) return [];
    const rowCount = endRow - startRow + 1;

    if (versionHeader !== undefined) {
      const versionIndex = headers.indexOf(versionHeader);
      if (versionIndex < 0) {
        throw new GQueryRuntimeError("MIGRATION_REQUIRED", `Manual edit handling requires version header ${versionHeader} on ${definition.sheet}.`);
      }
      const range = sheet.getRange(startRow, versionIndex + 1, rowCount, 1);
      const current = range.getValues();
      range.setValues(current.map(([value]) => [typeof value === "number" && Number.isFinite(value) ? value + 1 : 1]));
    }

    if (definition.primaryKey.length === 0) return [];
    const indexes = definition.primaryKey.map((field) => {
      const column = definition.columns[field];
      const index = headers.indexOf(column.header ?? field);
      if (index < 0) throw new GQueryRuntimeError("MISSING_HEADER", `Primary key header ${column.header ?? field} is missing.`);
      return index;
    });
    const min = Math.min(...indexes);
    const max = Math.max(...indexes);
    const values = sheet.getRange(startRow, min + 1, rowCount, max - min + 1).getValues();
    return values.map((row, offset) => {
      const result: Record<string, unknown> = {};
      definition.primaryKey.forEach((field, index) => {
        const column = definition.columns[field];
        const raw = row[indexes[index] - min];
        result[field] = column.decode(raw === "" || raw === null || raw === undefined ? BLANK_CELL : raw, {
          table: table.table,
          column: field,
          header: column.header ?? field,
          rowNumber: startRow + offset,
        });
      });
      return result;
    });
  }
}

export class SystemManager {
  public constructor(
    private readonly access: SystemManagerAccess,
    private readonly hooks?: ManualEditHooks,
  ) {}

  public reconcileTriggers(configuration: TriggerSetup): TriggerReconciliationResult {
    const spreadsheetId = configuration.spreadsheetId ?? this.defaultSpreadsheetId();
    const full: TriggerConfiguration = { ...configuration, spreadsheetId };
    return createAppsScriptTriggerReconciler().reconcile(full);
  }

  public handleEdit(event: GoogleAppsScript.Events.SheetsOnEdit | NormalizedEditEvent): SystemEventResult {
    const coordinator = this.coordinator();
    return "range" in event
      ? coordinator.handleNativeEdit(event as GoogleAppsScript.Events.SheetsOnEdit)
      : coordinator.handleEdit(event as NormalizedEditEvent);
  }

  public handleChange(event: GoogleAppsScript.Events.SheetsOnChange | NormalizedChangeEvent): SystemEventResult {
    const coordinator = this.coordinator();
    const result = "source" in event
      ? coordinator.handleNativeChange(event as GoogleAppsScript.Events.SheetsOnChange)
      : coordinator.handleChange(event as NormalizedChangeEvent);
    const sourceId = "source" in event
      ? (event as GoogleAppsScript.Events.SheetsOnChange).source.getId()
      : (event as NormalizedChangeEvent).sourceId;
    this.access.executor.invalidateStructure(sourceId);
    return result;
  }

  public status(): SystemStatus {
    const generations = this.requireGenerations();
    return {
      tables: this.registeredTables().map((table) => ({
        ...table,
        generation: generations.current({ kind: "table", sourceId: table.sourceId, table: table.table }),
      })),
    };
  }

  private coordinator(): SystemEventCoordinator {
    const generations = this.requireGenerations();
    return new SystemEventCoordinator(
      this.registeredTables(),
      generations as GenerationTokenStore,
      this.hooks ?? new AppsScriptManualEditHooks(this.access.definition),
    );
  }

  private registeredTables(): RegisteredSheetTable[] {
    const result: RegisteredSheetTable[] = [];
    const metadata = new Map<string, ReturnType<SheetsTransport["getSpreadsheetMetadata"]>>();
    for (const [tableName, definition] of Object.entries(this.access.definition.tables)) {
      const sourceId = this.access.resolveSourceId(definition.source);
      let workbook = metadata.get(sourceId);
      if (workbook === undefined) {
        workbook = this.access.transport.getSpreadsheetMetadata(sourceId);
        metadata.set(sourceId, workbook);
      }
      const sheet = workbook.sheets.find((candidate) => candidate.title === definition.sheet);
      if (sheet !== undefined) result.push({ sourceId, sheetId: sheet.sheetId, table: tableName });
    }
    return result;
  }

  private defaultSpreadsheetId(): string {
    const first = Object.values(this.access.definition.tables)[0];
    if (first === undefined) throw new GQueryRuntimeError("SOURCE_UNAVAILABLE", "The schema has no table source for trigger installation.");
    return this.access.resolveSourceId(first.source);
  }

  private requireGenerations(): RuntimeGenerationAdapter {
    if (this.access.generations === undefined) {
      throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "System event handling requires a durable generation store.");
    }
    return this.access.generations;
  }
}

