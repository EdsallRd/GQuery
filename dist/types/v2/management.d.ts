import { type PropertyStore } from "./infrastructure/runtime";
import type { DatabaseDefinition } from "./schema";
import { type SheetCellInput, type SheetsTransport } from "./transport";
export type SchemaIssueCode = "MISSING_SHEET" | "MISSING_HEADER" | "MISSING_VERSION_COLUMN" | "INVALID_VERSION" | "DUPLICATE_HEADER" | "INVALID_CELL" | "LEGACY_ENCODING" | "DUPLICATE_PRIMARY_KEY" | "DUPLICATE_UNIQUE_KEY" | "RELATION_CARDINALITY" | "BROKEN_RELATION" | "INVALID_SYSTEM_SHEET" | "UNPROTECTED_SYSTEM_SHEET";
export type SystemCellRepairValue = {
    readonly kind: "literal";
    readonly value: string;
} | {
    readonly kind: "backup-id";
} | {
    readonly kind: "migration-time";
};
export interface SchemaIssue {
    readonly code: SchemaIssueCode;
    readonly severity: "info" | "warning" | "error";
    readonly source: string;
    readonly spreadsheetId: string;
    readonly table: string;
    readonly sheet: string;
    readonly row?: number;
    readonly column?: string;
    readonly header?: string;
    readonly message: string;
}
export type SchemaMigrationAction = {
    readonly kind: "add-version-column";
    readonly spreadsheetId: string;
    readonly table: string;
    readonly sheet: string;
    readonly sheetId: number;
    readonly header: string;
    readonly columnIndex: number;
    /** Zero-based physical rows which contain actual table data. */
    readonly populatedRowIndexes: readonly number[];
    readonly gridColumnCount: number;
} | {
    readonly kind: "create-system-sheet";
    readonly spreadsheetId: string;
    readonly sheet: "_gq_meta" | "_gq_dead_letters";
} | {
    readonly kind: "add-dead-letter-actor-column";
    readonly spreadsheetId: string;
    readonly sheetId: number;
    readonly columnIndex: number;
    readonly gridColumnCount: number;
} | {
    readonly kind: "repair-system-sheet-cells";
    readonly spreadsheetId: string;
    readonly sheet: "_gq_meta" | "_gq_dead_letters";
    readonly sheetId: number;
    readonly gridColumnCount: number;
    readonly cells: readonly {
        readonly rowIndex: number;
        readonly columnIndex: number;
        readonly value: SystemCellRepairValue;
    }[];
} | {
    readonly kind: "protect-system-sheet";
    readonly spreadsheetId: string;
    readonly sheet: "_gq_meta" | "_gq_dead_letters";
    readonly sheetId: number;
} | {
    readonly kind: "backfill-cell";
    readonly spreadsheetId: string;
    readonly table: string;
    readonly sheet: string;
    readonly sheetId: number;
    readonly rowIndex: number;
    readonly columnIndex: number;
    readonly value: SheetCellInput;
} | {
    readonly kind: "repair-version-cell";
    readonly spreadsheetId: string;
    readonly table: string;
    readonly sheet: string;
    readonly sheetId: number;
    readonly rowIndex: number;
    readonly columnIndex: number;
    readonly value: number;
};
export interface SchemaPlan {
    readonly schemaVersion: 2;
    readonly generatedAt: string;
    readonly issues: readonly SchemaIssue[];
    readonly actions: readonly SchemaMigrationAction[];
    readonly backupRequired: boolean;
    readonly canMigrate: boolean;
    readonly canonicalCells: number;
    readonly legacyCells: number;
    readonly invalidCells: number;
    /** Deterministic decoded-data summaries for migration/shadow verification. */
    readonly tables: readonly SchemaTableAudit[];
}
export interface SchemaTableAudit {
    readonly source: string;
    readonly spreadsheetId: string;
    readonly table: string;
    readonly sheet: string;
    readonly decodedRows: number;
    readonly decodedHash: string;
}
export interface SchemaMigrationOptions {
    readonly confirm: true;
    readonly backupIds?: Readonly<Record<string, string>>;
    readonly createBackups?: boolean;
    readonly includeBackfill?: boolean;
    readonly adapter?: SchemaMigrationAdapter;
}
export interface SchemaMigrationResult {
    readonly status: "migrated" | "no-op";
    readonly backups: Readonly<Record<string, string>>;
    readonly appliedActions: number;
    readonly plan: SchemaPlan;
}
export interface SchemaMigrationAdapter {
    createBackup(spreadsheetId: string): string;
    apply(spreadsheetId: string, actions: readonly SchemaMigrationAction[], context: {
        readonly backupId: string;
        readonly migratedAt: string;
    }): void;
}
export interface SchemaCanonicalState {
    isStrictCanonical(spreadsheetId: string): boolean;
    setStrictCanonical(spreadsheetId: string, enabled: boolean): void;
}
export interface SchemaCanonicalModeAdapter {
    apply(spreadsheetId: string, enabled: boolean, context: {
        readonly changedAt: string;
    }): void;
}
export interface SchemaCanonicalModeOptions {
    readonly confirm: true;
    readonly adapter?: SchemaCanonicalModeAdapter;
}
export interface SchemaCanonicalModeResult {
    readonly status: "activated" | "rolled-back" | "no-op";
    readonly strictCanonical: boolean;
    readonly spreadsheets: readonly string[];
    readonly plan?: SchemaPlan;
}
export interface SchemaCanonicalStatus {
    readonly spreadsheetId: string;
    readonly strictCanonical: boolean;
}
export declare class InMemorySchemaCanonicalState implements SchemaCanonicalState {
    private readonly values;
    isStrictCanonical(spreadsheetId: string): boolean;
    setStrictCanonical(spreadsheetId: string, enabled: boolean): void;
}
export declare function strictCanonicalPropertyKey(spreadsheetId: string): string;
export interface AppsScriptSchemaCanonicalStateOptions {
    /** Injectable mirror used by tests and non-default Apps Script runtimes. */
    readonly properties?: PropertyStore;
    /**
     * Read the protected `_gq_meta` value. Undefined means the system sheet does
     * not exist yet, so dual decoding remains enabled.
     */
    readonly readMeta?: (spreadsheetId: string) => boolean | undefined;
}
export declare class AppsScriptSchemaCanonicalState implements SchemaCanonicalState {
    private readonly options;
    /** One authoritative system-sheet read per workbook and Apps Script execution. */
    private readonly resolved;
    constructor(options?: AppsScriptSchemaCanonicalStateOptions);
    isStrictCanonical(spreadsheetId: string): boolean;
    setStrictCanonical(spreadsheetId: string, enabled: boolean): void;
    private properties;
    private readMeta;
}
export interface SchemaManagementAccess {
    readonly definition: DatabaseDefinition;
    readonly transport: SheetsTransport;
    readonly canonicalState?: SchemaCanonicalState;
    resolveSourceId(sourceName: string): string;
    invalidateStructure?(spreadsheetId: string): void;
    invalidateTable?(spreadsheetId: string, tableName: string): void;
}
/** Read-only audit plus explicit, backup-gated schema migration. */
export declare class SchemaManager {
    private readonly access;
    private readonly canonicalState;
    constructor(access: SchemaManagementAccess);
    strictCanonicalStatus(): readonly SchemaCanonicalStatus[];
    /**
     * Enable canonical-only decoding only after a fresh audit proves that no
     * legacy cells, invalid cells, or unapplied migration actions remain.
     */
    activateStrictCanonical(options: SchemaCanonicalModeOptions): SchemaCanonicalModeResult;
    /** Disable canonical-only decoding as the documented rollback switch. */
    rollbackStrictCanonical(options: SchemaCanonicalModeOptions): SchemaCanonicalModeResult;
    plan(): SchemaPlan;
    migrate(options: SchemaMigrationOptions): SchemaMigrationResult;
    private spreadsheetIds;
    private setStrictCanonical;
    private loadTables;
    private auditSystemSheet;
    private issue;
}
/** Persist the canonical-mode switch in the protected `_gq_meta` sheet. */
export declare class AppsScriptSchemaCanonicalModeAdapter implements SchemaCanonicalModeAdapter {
    apply(spreadsheetId: string, enabled: boolean, context: {
        readonly changedAt: string;
    }): void;
}
/** Default Apps Script migration adapter. It is used only by explicit migrate(). */
export declare class AppsScriptSchemaMigrationAdapter implements SchemaMigrationAdapter {
    createBackup(spreadsheetId: string): string;
    apply(spreadsheetId: string, actions: readonly SchemaMigrationAction[], context: {
        readonly backupId: string;
        readonly migratedAt: string;
    }): void;
}
