import type { GQueryExecutor, RuntimeGenerationAdapter } from "./executor";
import type { DatabaseDefinition } from "./schema";
import type { SheetsTransport } from "./transport";
import { type ManualEditHooks, type NormalizedChangeEvent, type NormalizedEditEvent, type RegisteredSheetTable, type SystemEventResult, type TriggerReconciliationResult } from "./infrastructure/system";
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
    readonly tables: readonly (RegisteredSheetTable & {
        readonly generation: string;
    })[];
}
export interface SystemManagerAccess {
    readonly definition: DatabaseDefinition;
    readonly transport: SheetsTransport;
    readonly executor: GQueryExecutor;
    readonly generations?: RuntimeGenerationAdapter;
    resolveSourceId(sourceName: string): string;
}
/** Implements manual-edit version increments with one bounded read/write per edited block. */
export declare class AppsScriptManualEditHooks implements ManualEditHooks {
    private readonly definition;
    constructor(definition: DatabaseDefinition);
    onRowsEdited(table: RegisteredSheetTable, event: NormalizedEditEvent): readonly unknown[];
}
export declare class SystemManager {
    private readonly access;
    private readonly hooks?;
    constructor(access: SystemManagerAccess, hooks?: ManualEditHooks | undefined);
    reconcileTriggers(configuration: TriggerSetup): TriggerReconciliationResult;
    handleEdit(event: GoogleAppsScript.Events.SheetsOnEdit | NormalizedEditEvent): SystemEventResult;
    handleChange(event: GoogleAppsScript.Events.SheetsOnChange | NormalizedChangeEvent): SystemEventResult;
    status(): SystemStatus;
    private coordinator;
    private registeredTables;
    private defaultSpreadsheetId;
    private requireGenerations;
}
