import type { DatabaseDefinition } from "./schema";
import { type SheetCellInput, type SheetsTransport } from "./transport";
export type SchemaIssueCode = "MISSING_SHEET" | "MISSING_HEADER" | "MISSING_VERSION_COLUMN" | "DUPLICATE_HEADER" | "INVALID_CELL" | "LEGACY_ENCODING" | "DUPLICATE_PRIMARY_KEY" | "BROKEN_RELATION";
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
    readonly dataRows: number;
    readonly gridColumnCount: number;
} | {
    readonly kind: "create-system-sheet";
    readonly spreadsheetId: string;
    readonly sheet: "_gq_meta" | "_gq_dead_letters";
} | {
    readonly kind: "backfill-cell";
    readonly spreadsheetId: string;
    readonly table: string;
    readonly sheet: string;
    readonly sheetId: number;
    readonly rowIndex: number;
    readonly columnIndex: number;
    readonly value: SheetCellInput;
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
export interface SchemaManagementAccess {
    readonly definition: DatabaseDefinition;
    readonly transport: SheetsTransport;
    resolveSourceId(sourceName: string): string;
}
/** Read-only audit plus explicit, backup-gated schema migration. */
export declare class SchemaManager {
    private readonly access;
    constructor(access: SchemaManagementAccess);
    plan(): SchemaPlan;
    migrate(options: SchemaMigrationOptions): SchemaMigrationResult;
    private loadTables;
    private issue;
}
/** Default Apps Script migration adapter. It is used only by explicit migrate(). */
export declare class AppsScriptSchemaMigrationAdapter implements SchemaMigrationAdapter {
    createBackup(spreadsheetId: string): string;
    apply(spreadsheetId: string, actions: readonly SchemaMigrationAction[], context: {
        readonly backupId: string;
        readonly migratedAt: string;
    }): void;
}
