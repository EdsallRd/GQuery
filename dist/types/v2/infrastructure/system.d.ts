import { GenerationTokenStore } from "./cache";
import { PropertyStore } from "./runtime";
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
/** Reconciles durably owned trigger IDs and leaves unrelated project triggers alone. */
export declare class TriggerReconciler {
    private readonly platform;
    constructor(platform: TriggerPlatform);
    reconcile(configuration: TriggerConfiguration): TriggerReconciliationResult;
}
/** Apps Script adapter which persists clock cadence because Trigger does not expose it. */
export declare class AppsScriptTriggerPlatform implements TriggerPlatform {
    private readonly properties;
    private readonly metadataNamespace;
    constructor(properties: PropertyStore, metadataNamespace?: string);
    list(): readonly InstalledTrigger[];
    create(spec: ManagedTriggerSpec): InstalledTrigger;
    manage(trigger: InstalledTrigger): InstalledTrigger;
    remove(id: string): void;
    private metadataKey;
    private readMetadata;
}
export declare function createAppsScriptTriggerReconciler(namespace?: string): TriggerReconciler;
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
    onRowsEdited?(table: RegisteredSheetTable, event: NormalizedEditEvent): readonly unknown[] | void;
    onStructuralChange?(tables: readonly RegisteredSheetTable[], event: NormalizedChangeEvent): void;
}
export interface SystemEventResult {
    readonly invalidatedTables: readonly string[];
    readonly invalidatedRows: number;
}
/** Bridges normalized or native installable-trigger events to version/cache invalidation hooks. */
export declare class SystemEventCoordinator {
    private readonly tables;
    private readonly generations;
    private readonly hooks;
    constructor(tables: readonly RegisteredSheetTable[], generations: GenerationTokenStore, hooks?: ManualEditHooks);
    handleEdit(event: NormalizedEditEvent): SystemEventResult;
    handleNativeEdit(event: GoogleAppsScript.Events.SheetsOnEdit): SystemEventResult;
    handleChange(event: NormalizedChangeEvent): SystemEventResult;
    handleNativeChange(event: GoogleAppsScript.Events.SheetsOnChange): SystemEventResult;
}
