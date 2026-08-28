import { BLANK_CELL, type EncodedCell } from "./codecs";
import { canonicalStringify, hashCanonical } from "./query";
import { GQUERY_SYSTEM_SHEET_NAMES } from "./reserved";
import {
  DEFERRED_DEAD_LETTER_ACTOR_HEADER,
  DEFERRED_DEAD_LETTER_BASE_HEADERS,
} from "./infrastructure/deferred";
import {
  AppsScriptPropertyStore,
  type PropertyStore,
} from "./infrastructure/runtime";
import { GQueryRuntimeError } from "./runtime-errors";
import type { DatabaseDefinition, TableDefinition } from "./schema";
import {
  encodeAtomicExtendedValue,
  type SheetCellInput,
  type SheetCellValue,
  type SheetMetadata,
  type SheetsTransport,
  type SpreadsheetMetadata,
} from "./transport";

export type SchemaIssueCode =
  | "MISSING_SHEET"
  | "MISSING_HEADER"
  | "MISSING_VERSION_COLUMN"
  | "INVALID_VERSION"
  | "DUPLICATE_HEADER"
  | "INVALID_CELL"
  | "LEGACY_ENCODING"
  | "DUPLICATE_PRIMARY_KEY"
  | "DUPLICATE_UNIQUE_KEY"
  | "RELATION_CARDINALITY"
  | "BROKEN_RELATION"
  | "INVALID_SYSTEM_SHEET"
  | "UNPROTECTED_SYSTEM_SHEET";

export type SystemCellRepairValue =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "backup-id" }
  | { readonly kind: "migration-time" };

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

export type SchemaMigrationAction =
  | {
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
    }
  | {
      readonly kind: "create-system-sheet";
      readonly spreadsheetId: string;
      readonly sheet: "_gq_meta" | "_gq_dead_letters";
    }
  | {
      readonly kind: "add-dead-letter-actor-column";
      readonly spreadsheetId: string;
      readonly sheetId: number;
      readonly columnIndex: number;
      readonly gridColumnCount: number;
    }
  | {
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
    }
  | {
      readonly kind: "protect-system-sheet";
      readonly spreadsheetId: string;
      readonly sheet: "_gq_meta" | "_gq_dead_letters";
      readonly sheetId: number;
    }
  | {
      readonly kind: "backfill-cell";
      readonly spreadsheetId: string;
      readonly table: string;
      readonly sheet: string;
      readonly sheetId: number;
      readonly rowIndex: number;
      readonly columnIndex: number;
      readonly value: SheetCellInput;
    }
  | {
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
  apply(
    spreadsheetId: string,
    actions: readonly SchemaMigrationAction[],
    context: { readonly backupId: string; readonly migratedAt: string },
  ): void;
}

export interface SchemaCanonicalState {
  isStrictCanonical(spreadsheetId: string): boolean;
  setStrictCanonical(spreadsheetId: string, enabled: boolean): void;
}

export interface SchemaCanonicalModeAdapter {
  apply(
    spreadsheetId: string,
    enabled: boolean,
    context: { readonly changedAt: string },
  ): void;
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

export class InMemorySchemaCanonicalState implements SchemaCanonicalState {
  private readonly values = new Map<string, boolean>();

  public isStrictCanonical(spreadsheetId: string): boolean {
    return this.values.get(spreadsheetId) ?? false;
  }

  public setStrictCanonical(spreadsheetId: string, enabled: boolean): void {
    this.values.set(spreadsheetId, enabled);
  }
}

export function strictCanonicalPropertyKey(spreadsheetId: string): string {
  return `gq2:strict-canonical:${spreadsheetId}`;
}

export interface AppsScriptSchemaCanonicalStateOptions {
  /** Injectable mirror used by tests and non-default Apps Script runtimes. */
  readonly properties?: PropertyStore;
  /**
   * Read the protected `_gq_meta` value. Undefined means the system sheet does
   * not exist yet, so dual decoding remains enabled.
   */
  readonly readMeta?: (spreadsheetId: string) => boolean | undefined;
}

export class AppsScriptSchemaCanonicalState implements SchemaCanonicalState {
  /** One authoritative system-sheet read per workbook and Apps Script execution. */
  private readonly resolved = new Map<string, boolean>();

  public constructor(
    private readonly options: AppsScriptSchemaCanonicalStateOptions = {},
  ) {}

  public isStrictCanonical(spreadsheetId: string): boolean {
    const resolved = this.resolved.get(spreadsheetId);
    if (resolved !== undefined) return resolved;
    const properties = this.properties();
    const key = strictCanonicalPropertyKey(spreadsheetId);
    const authoritative = this.options.readMeta === undefined
      ? this.readMeta(spreadsheetId)
      : this.options.readMeta(spreadsheetId);
    if (authoritative === undefined) {
      // A stale property must never activate strict mode before `_gq_meta`
      // exists. Remove it so subsequent inspections cannot mistake it for the
      // source of truth.
      properties.remove(key);
      this.resolved.set(spreadsheetId, false);
      return false;
    }
    const encoded = String(authoritative);
    if (properties.get(key) !== encoded) properties.set(key, encoded);
    this.resolved.set(spreadsheetId, authoritative);
    return authoritative;
  }

  public setStrictCanonical(spreadsheetId: string, enabled: boolean): void {
    // SchemaManager persists `_gq_meta` through its mode adapter first. This is
    // only a recoverable fast mirror; isStrictCanonical() always reconciles it
    // back to the protected sheet.
    this.properties().set(strictCanonicalPropertyKey(spreadsheetId), String(enabled));
    this.resolved.set(spreadsheetId, enabled);
  }

  private properties(): PropertyStore {
    return this.options.properties
      ?? new AppsScriptPropertyStore(PropertiesService.getScriptProperties());
  }

  private readMeta(spreadsheetId: string): boolean | undefined {
    if (typeof SpreadsheetApp === "undefined") {
      throw new GQueryRuntimeError(
        "UNSUPPORTED_OPERATION",
        "SpreadsheetApp is required to read canonical migration mode.",
      );
    }
    const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName("_gq_meta");
    if (sheet === null) return undefined;
    const lastRow = Math.max(1, sheet.getLastRow());
    const values = sheet.getRange(1, 1, lastRow, 2).getDisplayValues();
    const matches = values.filter((row) => row[0] === "strict_canonical");
    if (matches.length !== 1 || (matches[0]?.[1] !== "true" && matches[0]?.[1] !== "false")) {
      throw new GQueryRuntimeError(
        "MIGRATION_REQUIRED",
        "The protected _gq_meta sheet has invalid strict_canonical migration state.",
        {
          details: {
            spreadsheetId,
            values: matches.map((row) => row[1]),
          },
        },
      );
    }
    return matches[0][1] === "true";
  }
}

export interface SchemaManagementAccess {
  readonly definition: DatabaseDefinition;
  readonly transport: SheetsTransport;
  readonly canonicalState?: SchemaCanonicalState;
  resolveSourceId(sourceName: string): string;
  invalidateStructure?(spreadsheetId: string): void;
  invalidateTable?(spreadsheetId: string, tableName: string): void;
}

interface LoadedTable {
  readonly sourceName: string;
  readonly spreadsheetId: string;
  readonly tableName: string;
  readonly definition: TableDefinition;
  readonly sheet?: SheetMetadata;
  readonly values: readonly (readonly SheetCellValue[])[];
}

interface DecodedTable {
  readonly loaded: LoadedTable;
  readonly rows: readonly Record<string, unknown>[];
}

function decodedBlank(value: SheetCellValue | undefined): unknown {
  return value === undefined || value === null || value === "" ? BLANK_CELL : value;
}

function toSheetValue(value: EncodedCell): SheetCellInput {
  return value === BLANK_CELL ? null : value;
}

function tableUsesFormula(definition: TableDefinition): boolean {
  return Object.values(definition.columns).some(
    (column) => column.kind === "formula",
  );
}

function key(row: Record<string, unknown>, fields: readonly string[]): string {
  return canonicalStringify(fields.map((field) => row[field]));
}

function relationFields(value: string | readonly string[]): readonly string[] {
  return typeof value === "string" ? [value] : value;
}

const META_HEADERS = Object.freeze(["Key", "Value"] as const);
const META_REQUIRED_ROWS = Object.freeze([
  { key: "schema_version", fallback: { kind: "literal", value: "2" } as const },
  { key: "migrated_at", fallback: { kind: "migration-time" } as const },
  { key: "backup_id", fallback: { kind: "backup-id" } as const },
  { key: "strict_canonical", fallback: { kind: "literal", value: "false" } as const },
  { key: "strict_canonical_changed_at", fallback: { kind: "migration-time" } as const },
] as const);

function physicalString(value: SheetCellValue | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Read-only audit plus explicit, backup-gated schema migration. */
export class SchemaManager {
  private readonly canonicalState: SchemaCanonicalState;

  public constructor(private readonly access: SchemaManagementAccess) {
    this.canonicalState = access.canonicalState ?? new InMemorySchemaCanonicalState();
  }

  public strictCanonicalStatus(): readonly SchemaCanonicalStatus[] {
    return Object.freeze(this.spreadsheetIds().map((spreadsheetId) => Object.freeze({
      spreadsheetId,
      strictCanonical: this.canonicalState.isStrictCanonical(spreadsheetId),
    })));
  }

  /**
   * Enable canonical-only decoding only after a fresh audit proves that no
   * legacy cells, invalid cells, or unapplied migration actions remain.
   */
  public activateStrictCanonical(options: SchemaCanonicalModeOptions): SchemaCanonicalModeResult {
    if (options.confirm !== true) {
      throw new GQueryRuntimeError("MIGRATION_REQUIRED", "activateStrictCanonical() requires confirm: true.");
    }
    const plan = this.plan();
    const errors = plan.issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0 || plan.invalidCells > 0 || plan.legacyCells > 0 || plan.actions.length > 0) {
      throw new GQueryRuntimeError(
        "MIGRATION_REQUIRED",
        "Canonical-only decoding requires a clean post-backfill schema audit.",
        {
          details: {
            errors,
            invalidCells: plan.invalidCells,
            legacyCells: plan.legacyCells,
            pendingActions: plan.actions,
          },
        },
      );
    }
    return this.setStrictCanonical(true, options.adapter, plan);
  }

  /** Disable canonical-only decoding as the documented rollback switch. */
  public rollbackStrictCanonical(options: SchemaCanonicalModeOptions): SchemaCanonicalModeResult {
    if (options.confirm !== true) {
      throw new GQueryRuntimeError("MIGRATION_REQUIRED", "rollbackStrictCanonical() requires confirm: true.");
    }
    return this.setStrictCanonical(false, options.adapter);
  }

  public plan(): SchemaPlan {
    const generatedAt = new Date().toISOString();
    const issues: SchemaIssue[] = [];
    const actions: SchemaMigrationAction[] = [];
    const loaded = this.loadTables(actions, issues);
    const decoded = new Map<string, DecodedTable>();
    let canonicalCells = 0;
    let legacyCells = 0;
    let invalidCells = 0;

    for (const table of loaded) {
      if (table.sheet === undefined || table.values.length === 0) continue;
      const headers = (table.values[0] ?? []).map((value) => typeof value === "string" ? value : String(value ?? ""));
      const byHeader = new Map<string, number>();
      for (let index = 0; index < headers.length; index += 1) {
        const header = headers[index];
        if (header.length === 0) continue;
        if (byHeader.has(header)) {
          issues.push(this.issue(table, "DUPLICATE_HEADER", "error", `Header ${header} appears more than once.`, { header }));
        } else {
          byHeader.set(header, index);
        }
      }
      const missingHeaders: string[] = [];
      for (const [field, column] of Object.entries(table.definition.columns)) {
        const header = column.header ?? field;
        if (!byHeader.has(header)) {
          missingHeaders.push(header);
          issues.push(this.issue(table, "MISSING_HEADER", "error", `Required header ${header} is missing.`, { column: field, header }));
        }
      }
      if (table.definition.versionColumn !== undefined && !byHeader.has(table.definition.versionColumn)) {
        issues.push(this.issue(
          table,
          "MISSING_VERSION_COLUMN",
          "warning",
          `Hidden version header ${table.definition.versionColumn} must be added.`,
          { header: table.definition.versionColumn },
        ));
        actions.push({
          kind: "add-version-column",
          spreadsheetId: table.spreadsheetId,
          table: table.tableName,
          sheet: table.definition.sheet,
          sheetId: table.sheet.sheetId,
          header: table.definition.versionColumn,
          columnIndex: headers.length,
          populatedRowIndexes: Object.freeze(
            table.values
              .map((row, rowIndex) => ({ row, rowIndex }))
              .filter(({ row, rowIndex }) =>
                rowIndex > 0 && row.some((value) => value !== null && value !== undefined && value !== ""),
              )
              .map(({ rowIndex }) => rowIndex),
          ),
          gridColumnCount: table.sheet.columnCount,
        });
      }
      if (missingHeaders.length > 0) continue;

      const dataColumnIndexes = Object.entries(table.definition.columns).map(([field, column]) => {
        const index = byHeader.get(column.header ?? field);
        if (index === undefined) {
          throw new GQueryRuntimeError("MISSING_HEADER", `Required header ${column.header ?? field} is missing.`);
        }
        return index;
      });
      const versionIndex = table.definition.versionColumn === undefined
        ? undefined
        : byHeader.get(table.definition.versionColumn);
      if (versionIndex !== undefined) {
        for (let rowIndex = 1; rowIndex < table.values.length; rowIndex += 1) {
          const physical = table.values[rowIndex] ?? [];
          const populated = dataColumnIndexes.some((index) => {
            const value = physical[index];
            return value !== null && value !== undefined && value !== "";
          });
          if (!populated) continue;
          const version = physical[versionIndex];
          if (!Number.isSafeInteger(version) || (version as number) < 1) {
            issues.push(this.issue(
              table,
              "INVALID_VERSION",
              "warning",
              `Populated row ${rowIndex + 1} requires a positive integer ${table.definition.versionColumn} value.`,
              { row: rowIndex + 1, header: table.definition.versionColumn },
            ));
            actions.push({
              kind: "repair-version-cell",
              spreadsheetId: table.spreadsheetId,
              table: table.tableName,
              sheet: table.definition.sheet,
              sheetId: table.sheet.sheetId,
              rowIndex,
              columnIndex: versionIndex,
              value: 1,
            });
          }
        }
      }

      const rows: Record<string, unknown>[] = [];
      const keyTrackers = [
        ...(table.definition.primaryKey.length === 0
          ? []
          : [{ kind: "primary" as const, fields: table.definition.primaryKey, rows: new Map<string, number>() }]),
        ...table.definition.unique.map((fields, index) => ({
          kind: "unique" as const,
          index,
          fields,
          rows: new Map<string, number>(),
        })),
      ];
      for (let rowIndex = 1; rowIndex < table.values.length; rowIndex += 1) {
        const physical = table.values[rowIndex] ?? [];
        if (dataColumnIndexes.every((index) => {
          const value = physical[index];
          return value === null || value === undefined || value === "";
        })) continue;
        const row: Record<string, unknown> = {};
        let rowValid = true;
        for (const [field, column] of Object.entries(table.definition.columns)) {
          const header = column.header ?? field;
          const columnIndex = byHeader.get(header)!;
          const raw = decodedBlank(physical[columnIndex]);
          try {
            const value = column.decode(raw, {
              table: table.tableName,
              column: field,
              header,
              rowNumber: rowIndex + 1,
            });
            row[field] = value;
            try {
              column.decodeCanonical(raw, {
                table: table.tableName,
                column: field,
                header,
                rowNumber: rowIndex + 1,
              });
              canonicalCells += 1;
            } catch {
              legacyCells += 1;
              const encoded = toSheetValue(column.encode(value, {
                table: table.tableName,
                column: field,
                header,
                rowNumber: rowIndex + 1,
              }) as EncodedCell);
              issues.push(this.issue(table, "LEGACY_ENCODING", "info", `Cell ${header}${rowIndex + 1} uses a legacy encoding.`, {
                row: rowIndex + 1,
                column: field,
                header,
              }));
              actions.push({
                kind: "backfill-cell",
                spreadsheetId: table.spreadsheetId,
                table: table.tableName,
                sheet: table.definition.sheet,
                sheetId: table.sheet.sheetId,
                rowIndex,
                columnIndex,
                value: encoded,
              });
            }
          } catch (error) {
            invalidCells += 1;
            rowValid = false;
            issues.push(this.issue(table, "INVALID_CELL", "error", error instanceof Error ? error.message : String(error), {
              row: rowIndex + 1,
              column: field,
              header,
            }));
          }
        }
        if (!rowValid) continue;
        for (const tracker of keyTrackers) {
          const fingerprint = key(row, tracker.fields);
          const previous = tracker.rows.get(fingerprint);
          if (previous !== undefined) {
            const label = tracker.kind === "primary"
              ? "primary key"
              : `unique key ${tracker.index + 1} (${tracker.fields.join(", ")})`;
            issues.push(this.issue(
              table,
              tracker.kind === "primary" ? "DUPLICATE_PRIMARY_KEY" : "DUPLICATE_UNIQUE_KEY",
              "error",
              `Rows ${previous} and ${rowIndex + 1} share ${label}.`,
              {
              row: rowIndex + 1,
              },
            ));
          } else {
            tracker.rows.set(fingerprint, rowIndex + 1);
          }
        }
        rows.push(row);
      }
      decoded.set(table.tableName, { loaded: table, rows });
    }

    for (const [tableName, table] of decoded) {
      for (const [relationName, relation] of Object.entries(table.loaded.definition.relations)) {
        const target = decoded.get(relation.target);
        if (target === undefined) continue;
        const local = relationFields(relation.local);
        const foreign = relationFields(relation.foreign);
        const targetCounts = new Map<string, number>();
        for (const targetRow of target.rows) {
          const fingerprint = key(targetRow, foreign);
          targetCounts.set(fingerprint, (targetCounts.get(fingerprint) ?? 0) + 1);
        }
        for (let index = 0; index < table.rows.length; index += 1) {
          const fingerprint = key(table.rows[index], local);
          const matches = targetCounts.get(fingerprint) ?? 0;
          if (matches === 0 && relation.required) {
            issues.push(this.issue(table.loaded, "BROKEN_RELATION", "error", `Required relation ${relationName} has no ${relation.target} match.`, {
              row: index + 2,
            }));
          } else if (matches > 1 && relation.cardinality === "one") {
            issues.push(this.issue(
              table.loaded,
              "RELATION_CARDINALITY",
              "error",
              `Relation ${relationName} expected at most one ${relation.target} match but found ${matches}.`,
              { row: index + 2 },
            ));
          }
        }
      }
      void tableName;
    }

    const tables: SchemaTableAudit[] = loaded.map((table) => {
      const rows = decoded.get(table.tableName)?.rows ?? [];
      return {
        source: table.sourceName,
        spreadsheetId: table.spreadsheetId,
        table: table.tableName,
        sheet: table.definition.sheet,
        decodedRows: rows.length,
        decodedHash: hashCanonical(rows),
      };
    });

    return Object.freeze({
      schemaVersion: 2 as const,
      generatedAt,
      issues: Object.freeze(issues),
      actions: Object.freeze(actions),
      backupRequired: actions.length > 0,
      canMigrate: !issues.some((issue) => issue.severity === "error"),
      canonicalCells,
      legacyCells,
      invalidCells,
      tables: Object.freeze(tables),
    });
  }

  public migrate(options: SchemaMigrationOptions): SchemaMigrationResult {
    if (options.confirm !== true) throw new GQueryRuntimeError("MIGRATION_REQUIRED", "schema.migrate() requires confirm: true.");
    const plan = this.plan();
    if (!plan.canMigrate) {
      throw new GQueryRuntimeError("MIGRATION_REQUIRED", "Schema migration is blocked by audit errors.", {
        details: { errors: plan.issues.filter((issue) => issue.severity === "error") },
      });
    }
    const actions = plan.actions.filter((action) => options.includeBackfill === true || action.kind !== "backfill-cell");
    if (actions.length === 0) return { status: "no-op", backups: Object.freeze({}), appliedActions: 0, plan };
    const adapter = options.adapter ?? new AppsScriptSchemaMigrationAdapter();
    const bySpreadsheet = new Map<string, SchemaMigrationAction[]>();
    for (const action of actions) {
      const group = bySpreadsheet.get(action.spreadsheetId) ?? [];
      group.push(action);
      bySpreadsheet.set(action.spreadsheetId, group);
    }
    const backups: Record<string, string> = {};
    for (const [spreadsheetId, workbookActions] of bySpreadsheet) {
      const backupId = options.backupIds?.[spreadsheetId]
        ?? (options.createBackups === true ? adapter.createBackup(spreadsheetId) : undefined);
      if (backupId === undefined || backupId.length === 0) {
        throw new GQueryRuntimeError("BACKUP_REQUIRED", `A full backup is required before migrating spreadsheet ${spreadsheetId}.`);
      }
      backups[spreadsheetId] = backupId;
      adapter.apply(spreadsheetId, workbookActions, { backupId, migratedAt: new Date().toISOString() });
      this.access.invalidateStructure?.(spreadsheetId);
      for (const tableName of new Set(workbookActions.flatMap((action) =>
        "table" in action ? [action.table] : [],
      ))) {
        this.access.invalidateTable?.(spreadsheetId, tableName);
      }
    }
    return {
      status: "migrated",
      backups: Object.freeze(backups),
      appliedActions: actions.length,
      plan,
    };
  }

  private spreadsheetIds(): string[] {
    return [...new Set(Object.values(this.access.definition.tables).map(
      (definition) => this.access.resolveSourceId(definition.source),
    ))].sort();
  }

  private setStrictCanonical(
    enabled: boolean,
    adapter: SchemaCanonicalModeAdapter | undefined,
    plan?: SchemaPlan,
  ): SchemaCanonicalModeResult {
    const spreadsheetIds = this.spreadsheetIds();
    const changed = spreadsheetIds.filter(
      (spreadsheetId) => this.canonicalState.isStrictCanonical(spreadsheetId) !== enabled,
    );
    if (changed.length === 0) {
      return {
        status: "no-op",
        strictCanonical: enabled,
        spreadsheets: Object.freeze([]),
        ...(plan === undefined ? {} : { plan }),
      };
    }
    const modeAdapter = adapter ?? new AppsScriptSchemaCanonicalModeAdapter();
    const changedAt = new Date().toISOString();
    for (const spreadsheetId of changed) {
      modeAdapter.apply(spreadsheetId, enabled, { changedAt });
      this.canonicalState.setStrictCanonical(spreadsheetId, enabled);
    }
    return {
      status: enabled ? "activated" : "rolled-back",
      strictCanonical: enabled,
      spreadsheets: Object.freeze(changed),
      ...(plan === undefined ? {} : { plan }),
    };
  }

  private loadTables(actions: SchemaMigrationAction[], issues: SchemaIssue[]): LoadedTable[] {
    const grouped = new Map<string, { sourceName: string; metadata: SpreadsheetMetadata; entries: Array<[string, TableDefinition]> }>();
    for (const [tableName, definition] of Object.entries(this.access.definition.tables)) {
      const spreadsheetId = this.access.resolveSourceId(definition.source);
      let group = grouped.get(spreadsheetId);
      if (group === undefined) {
        group = {
          sourceName: definition.source,
          metadata: this.access.transport.getSpreadsheetMetadata(spreadsheetId),
          entries: [],
        };
        grouped.set(spreadsheetId, group);
      }
      group.entries.push([tableName, definition]);
    }
    const loaded: LoadedTable[] = [];
    for (const [spreadsheetId, group] of grouped) {
      for (const systemSheet of GQUERY_SYSTEM_SHEET_NAMES) {
        if (!group.metadata.sheets.some((sheet) => sheet.title === systemSheet)) {
          actions.push({ kind: "create-system-sheet", spreadsheetId, sheet: systemSheet });
        }
      }
      const existing = group.entries.filter(([, definition]) => group.metadata.sheets.some((sheet) => sheet.title === definition.sheet));
      const systemSheets = group.metadata.sheets.filter(
        (sheet) => GQUERY_SYSTEM_SHEET_NAMES.includes(sheet.title as typeof GQUERY_SYSTEM_SHEET_NAMES[number]),
      );
      const ranges = [
        ...existing.map(([, definition]) => `'${definition.sheet.replace(/'/g, "''")}'`),
        ...systemSheets.map((sheet) => sheet.title === "_gq_dead_letters"
          ? "'_gq_dead_letters'!1:1"
          : "'_gq_meta'",
        ),
      ];
      const response = ranges.length === 0
        ? { valueRanges: [] }
        : this.access.transport.batchGet(spreadsheetId, ranges, {
            valueRenderOption: existing.some(([, definition]) =>
              tableUsesFormula(definition)
            ) ? "FORMULA" : "UNFORMATTED_VALUE",
          });
      let existingIndex = 0;
      for (const [tableName, definition] of group.entries) {
        const sheet = group.metadata.sheets.find((candidate) => candidate.title === definition.sheet);
        if (sheet === undefined) {
          const placeholder: LoadedTable = {
            sourceName: definition.source,
            spreadsheetId,
            tableName,
            definition,
            values: [],
          };
          issues.push(this.issue(placeholder, "MISSING_SHEET", "error", `Required sheet ${definition.sheet} is missing.`));
          loaded.push(placeholder);
          continue;
        }
        loaded.push({
          sourceName: definition.source,
          spreadsheetId,
          tableName,
          definition,
          sheet,
          values: response.valueRanges[existingIndex]?.values ?? [],
        });
        existingIndex += 1;
      }
      for (let index = 0; index < systemSheets.length; index += 1) {
        this.auditSystemSheet(
          group.sourceName,
          spreadsheetId,
          systemSheets[index],
          response.valueRanges[existing.length + index]?.values ?? [],
          actions,
          issues,
        );
      }
    }
    return loaded;
  }

  private auditSystemSheet(
    sourceName: string,
    spreadsheetId: string,
    sheet: SheetMetadata,
    values: readonly (readonly SheetCellValue[])[],
    actions: SchemaMigrationAction[],
    issues: SchemaIssue[],
  ): void {
    if (sheet.title !== "_gq_meta" && sheet.title !== "_gq_dead_letters") return;
    const systemSheet = sheet.title;
    const cells: Array<{
      rowIndex: number;
      columnIndex: number;
      value: SystemCellRepairValue;
    }> = [];
    const headers = values[0] ?? [];

    if (systemSheet === "_gq_meta") {
      META_HEADERS.forEach((header, columnIndex) => {
        if (physicalString(headers[columnIndex]) !== header) {
          cells.push({ rowIndex: 0, columnIndex, value: { kind: "literal", value: header } });
        }
      });
      const byKey = new Map<string, number>();
      for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
        const candidate = physicalString(values[rowIndex]?.[0]);
        if (candidate !== "" && !byKey.has(candidate)) byKey.set(candidate, rowIndex);
      }
      let nextRow = Math.max(1, values.length);
      for (const required of META_REQUIRED_ROWS) {
        let rowIndex = byKey.get(required.key);
        if (rowIndex === undefined) {
          rowIndex = nextRow;
          nextRow += 1;
          cells.push({ rowIndex, columnIndex: 0, value: { kind: "literal", value: required.key } });
          cells.push({ rowIndex, columnIndex: 1, value: required.fallback });
          continue;
        }
        const current = physicalString(values[rowIndex]?.[1]);
        const valid = required.key === "schema_version"
          ? current === "2"
          : required.key === "strict_canonical"
            ? current === "true" || current === "false"
            : current.trim().length > 0;
        if (!valid) cells.push({ rowIndex, columnIndex: 1, value: required.fallback });
      }
    } else {
      const expectedHeaders = [
        ...DEFERRED_DEAD_LETTER_BASE_HEADERS,
        DEFERRED_DEAD_LETTER_ACTOR_HEADER,
      ];
      const baseCanonical = DEFERRED_DEAD_LETTER_BASE_HEADERS.every(
        (header, columnIndex) => physicalString(headers[columnIndex]) === header,
      );
      const actorPresent = headers.some(
        (header) => physicalString(header) === DEFERRED_DEAD_LETTER_ACTOR_HEADER,
      );
      if (baseCanonical && !actorPresent) {
        actions.push({
          kind: "add-dead-letter-actor-column",
          spreadsheetId,
          sheetId: sheet.sheetId,
          columnIndex: headers.length,
          gridColumnCount: sheet.columnCount,
        });
      } else if (!baseCanonical) {
        expectedHeaders.forEach((header, columnIndex) => {
          if (physicalString(headers[columnIndex]) !== header) {
            cells.push({ rowIndex: 0, columnIndex, value: { kind: "literal", value: header } });
          }
        });
      }
    }

    if (cells.length > 0) {
      issues.push({
        code: "INVALID_SYSTEM_SHEET",
        severity: "warning",
        source: sourceName,
        spreadsheetId,
        table: systemSheet,
        sheet: systemSheet,
        message: `System sheet ${systemSheet} is incomplete and will be repaired by schema.migrate().`,
      });
      actions.push({
        kind: "repair-system-sheet-cells",
        spreadsheetId,
        sheet: systemSheet,
        sheetId: sheet.sheetId,
        gridColumnCount: sheet.columnCount,
        cells: Object.freeze(cells),
      });
    }
    if (sheet.hasFullSheetProtection === false) {
      issues.push({
        code: "UNPROTECTED_SYSTEM_SHEET",
        severity: "warning",
        source: sourceName,
        spreadsheetId,
        table: systemSheet,
        sheet: systemSheet,
        message: `System sheet ${systemSheet} is not fully protected.`,
      });
      actions.push({
        kind: "protect-system-sheet",
        spreadsheetId,
        sheet: systemSheet,
        sheetId: sheet.sheetId,
      });
    }
  }

  private issue(
    table: LoadedTable,
    code: SchemaIssueCode,
    severity: SchemaIssue["severity"],
    message: string,
    location: Partial<Pick<SchemaIssue, "row" | "column" | "header">> = {},
  ): SchemaIssue {
    return {
      code,
      severity,
      source: table.sourceName,
      spreadsheetId: table.spreadsheetId,
      table: table.tableName,
      sheet: table.definition.sheet,
      ...location,
      message,
    };
  }
}

/** Persist the canonical-mode switch in the protected `_gq_meta` sheet. */
export class AppsScriptSchemaCanonicalModeAdapter implements SchemaCanonicalModeAdapter {
  public apply(spreadsheetId: string, enabled: boolean, context: { readonly changedAt: string }): void {
    if (typeof SpreadsheetApp === "undefined") {
      throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "SpreadsheetApp is required to change canonical migration mode.");
    }
    const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName("_gq_meta");
    if (sheet === null) {
      throw new GQueryRuntimeError("MIGRATION_REQUIRED", "The protected _gq_meta sheet must exist before changing canonical migration mode.");
    }
    const lastRow = Math.max(1, sheet.getLastRow());
    const values = sheet.getRange(1, 1, lastRow, 2).getDisplayValues();
    const strictIndex = values.findIndex((row) => row[0] === "strict_canonical");
    if (strictIndex < 0) {
      throw new GQueryRuntimeError("MIGRATION_REQUIRED", "_gq_meta is missing the strict_canonical migration state row.");
    }
    sheet.getRange(strictIndex + 1, 2).setValue(String(enabled));
    const changedIndex = values.findIndex((row) => row[0] === "strict_canonical_changed_at");
    if (changedIndex >= 0) sheet.getRange(changedIndex + 1, 2).setValue(context.changedAt);
    else sheet.appendRow(["strict_canonical_changed_at", context.changedAt]);
  }
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function requestBytes(request: unknown): number {
  return utf8Bytes(JSON.stringify(request));
}

const MAX_VERSION_ROWS_PER_REQUEST = 10_000;

/** Default Apps Script migration adapter. It is used only by explicit migrate(). */
export class AppsScriptSchemaMigrationAdapter implements SchemaMigrationAdapter {
  public createBackup(spreadsheetId: string): string {
    const source = DriveApp.getFileById(spreadsheetId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return source.makeCopy(`${source.getName()} GQuery backup ${timestamp}`).getId();
  }

  public apply(
    spreadsheetId: string,
    actions: readonly SchemaMigrationAction[],
    context: { readonly backupId: string; readonly migratedAt: string },
  ): void {
    const service = Sheets;
    if (service === undefined) {
      throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "The Advanced Sheets service must be enabled before schema migration.");
    }
    const metadata = service.Spreadsheets.get(spreadsheetId, { fields: "sheets(properties(sheetId,title))" });
    const usedIds = new Set((metadata.sheets ?? []).map((sheet) => sheet.properties?.sheetId).filter((id): id is number => id !== undefined));
    let nextSystemId = 1_900_000_000;
    const requests: unknown[] = [];
    for (const action of actions) {
      if (action.kind === "add-version-column") {
        if (action.columnIndex >= action.gridColumnCount) {
          requests.push({ appendDimension: { sheetId: action.sheetId, dimension: "COLUMNS", length: action.columnIndex - action.gridColumnCount + 1 } });
        }
        requests.push({
          updateCells: {
            range: {
              sheetId: action.sheetId,
              startRowIndex: 0,
              startColumnIndex: action.columnIndex,
            },
            rows: [{ values: [{ userEnteredValue: { stringValue: action.header } }] }],
            fields: "userEnteredValue",
          },
        });
        const contiguous: Array<{ start: number; end: number }> = [];
        for (const rowIndex of action.populatedRowIndexes) {
          const previous = contiguous[contiguous.length - 1];
          if (previous !== undefined && rowIndex === previous.end) previous.end += 1;
          else contiguous.push({ start: rowIndex, end: rowIndex + 1 });
        }
        for (const span of contiguous) {
          for (let start = span.start; start < span.end; start += MAX_VERSION_ROWS_PER_REQUEST) {
            const end = Math.min(span.end, start + MAX_VERSION_ROWS_PER_REQUEST);
            requests.push({
              updateCells: {
                range: {
                  sheetId: action.sheetId,
                  startRowIndex: start,
                  startColumnIndex: action.columnIndex,
                },
                rows: Array.from(
                  { length: end - start },
                  () => ({ values: [{ userEnteredValue: { numberValue: 1 } }] }),
                ),
                fields: "userEnteredValue",
              },
            });
          }
        }
        requests.push({ updateDimensionProperties: {
          range: { sheetId: action.sheetId, dimension: "COLUMNS", startIndex: action.columnIndex, endIndex: action.columnIndex + 1 },
          properties: { hiddenByUser: true },
          fields: "hiddenByUser",
        } });
      } else if (action.kind === "backfill-cell" || action.kind === "repair-version-cell") {
        const userEnteredValue = encodeAtomicExtendedValue(action.value);
        requests.push({ updateCells: {
          range: { sheetId: action.sheetId, startRowIndex: action.rowIndex, startColumnIndex: action.columnIndex },
          rows: [{ values: [userEnteredValue === undefined ? {} : { userEnteredValue }] }],
          fields: "userEnteredValue",
        } });
      } else if (action.kind === "add-dead-letter-actor-column") {
        if (action.columnIndex >= action.gridColumnCount) {
          requests.push({ appendDimension: {
            sheetId: action.sheetId,
            dimension: "COLUMNS",
            length: action.columnIndex - action.gridColumnCount + 1,
          } });
        }
        requests.push({ updateCells: {
          range: {
            sheetId: action.sheetId,
            startRowIndex: 0,
            startColumnIndex: action.columnIndex,
          },
          rows: [{ values: [{ userEnteredValue: { stringValue: DEFERRED_DEAD_LETTER_ACTOR_HEADER } }] }],
          fields: "userEnteredValue",
        } });
      } else if (action.kind === "repair-system-sheet-cells") {
        const requiredColumns = action.cells.reduce(
          (maximum, cell) => Math.max(maximum, cell.columnIndex + 1),
          0,
        );
        if (requiredColumns > action.gridColumnCount) {
          requests.push({ appendDimension: {
            sheetId: action.sheetId,
            dimension: "COLUMNS",
            length: requiredColumns - action.gridColumnCount,
          } });
        }
        for (const cell of action.cells) {
          const value = cell.value.kind === "literal"
            ? cell.value.value
            : cell.value.kind === "backup-id"
              ? context.backupId
              : context.migratedAt;
          requests.push({ updateCells: {
            range: {
              sheetId: action.sheetId,
              startRowIndex: cell.rowIndex,
              startColumnIndex: cell.columnIndex,
            },
            rows: [{ values: [{ userEnteredValue: { stringValue: value } }] }],
            fields: "userEnteredValue",
          } });
        }
      } else if (action.kind === "protect-system-sheet") {
        requests.push({ addProtectedRange: {
          protectedRange: {
            range: { sheetId: action.sheetId },
            description: "Managed by GQuery 2.0",
            warningOnly: false,
          },
        } });
      } else {
        while (usedIds.has(nextSystemId)) nextSystemId -= 1;
        const sheetId = nextSystemId;
        usedIds.add(sheetId);
        nextSystemId -= 1;
        const values = action.sheet === "_gq_meta"
          ? [
              ["Key", "Value"],
              ["schema_version", "2"],
              ["migrated_at", context.migratedAt],
              ["backup_id", context.backupId],
              ["strict_canonical", "false"],
              ["strict_canonical_changed_at", context.migratedAt],
            ]
          : [[...DEFERRED_DEAD_LETTER_BASE_HEADERS, DEFERRED_DEAD_LETTER_ACTOR_HEADER]];
        requests.push({ addSheet: { properties: { sheetId, title: action.sheet, hidden: true } } });
        requests.push({ updateCells: {
          range: { sheetId, startRowIndex: 0, startColumnIndex: 0 },
          rows: values.map((row) => ({ values: row.map((value) => ({ userEnteredValue: { stringValue: value } })) })),
          fields: "userEnteredValue",
        } });
        requests.push({ addProtectedRange: {
          protectedRange: {
            range: { sheetId },
            description: "Managed by GQuery 2.0",
            warningOnly: false,
          },
        } });
      }
    }
    const chunks: unknown[][] = [];
    let chunk: unknown[] = [];
    let bytes = 0;
    for (const request of requests) {
      const size = requestBytes(request);
      if (chunk.length > 0 && bytes + size > 1_800_000) {
        chunks.push(chunk);
        chunk = [];
        bytes = 0;
      }
      chunk.push(request);
      bytes += size;
    }
    if (chunk.length > 0) chunks.push(chunk);
    for (const requestsChunk of chunks) {
      service.Spreadsheets.batchUpdate({ requests: requestsChunk as GoogleAppsScript.Sheets.Schema.Request[] }, spreadsheetId);
    }
  }
}
