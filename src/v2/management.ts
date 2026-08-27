import { BLANK_CELL, type EncodedCell } from "./codecs";
import { hashCanonical } from "./query";
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
  | "DUPLICATE_HEADER"
  | "INVALID_CELL"
  | "LEGACY_ENCODING"
  | "DUPLICATE_PRIMARY_KEY"
  | "DUPLICATE_UNIQUE_KEY"
  | "RELATION_CARDINALITY"
  | "BROKEN_RELATION";

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

export interface SchemaManagementAccess {
  readonly definition: DatabaseDefinition;
  readonly transport: SheetsTransport;
  resolveSourceId(sourceName: string): string;
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
  return value === undefined || value === null ? BLANK_CELL : value;
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
  return JSON.stringify(fields.map((field) => row[field]));
}

function relationFields(value: string | readonly string[]): readonly string[] {
  return typeof value === "string" ? [value] : value;
}

/** Read-only audit plus explicit, backup-gated schema migration. */
export class SchemaManager {
  public constructor(private readonly access: SchemaManagementAccess) {}

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
        if (physical.every((value) => value === null || value === undefined || value === "")) continue;
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
              column.codec.decode(raw, { table: table.tableName, column: field, header, rowNumber: rowIndex + 1 });
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
    }
    return {
      status: "migrated",
      backups: Object.freeze(backups),
      appliedActions: actions.length,
      plan,
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
      for (const systemSheet of ["_gq_meta", "_gq_dead_letters"] as const) {
        if (!group.metadata.sheets.some((sheet) => sheet.title === systemSheet)) {
          actions.push({ kind: "create-system-sheet", spreadsheetId, sheet: systemSheet });
        }
      }
      const existing = group.entries.filter(([, definition]) => group.metadata.sheets.some((sheet) => sheet.title === definition.sheet));
      const ranges = existing.map(([, definition]) => `'${definition.sheet.replace(/'/g, "''")}'`);
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
    }
    return loaded;
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

function requestBytes(request: unknown): number {
  return JSON.stringify(request).length;
}

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
          requests.push({
            updateCells: {
              range: {
                sheetId: action.sheetId,
                startRowIndex: span.start,
                startColumnIndex: action.columnIndex,
              },
              rows: Array.from(
                { length: span.end - span.start },
                () => ({ values: [{ userEnteredValue: { numberValue: 1 } }] }),
              ),
              fields: "userEnteredValue",
            },
          });
        }
        requests.push({ updateDimensionProperties: {
          range: { sheetId: action.sheetId, dimension: "COLUMNS", startIndex: action.columnIndex, endIndex: action.columnIndex + 1 },
          properties: { hiddenByUser: true },
          fields: "hiddenByUser",
        } });
      } else if (action.kind === "backfill-cell") {
        const userEnteredValue = encodeAtomicExtendedValue(action.value);
        requests.push({ updateCells: {
          range: { sheetId: action.sheetId, startRowIndex: action.rowIndex, startColumnIndex: action.columnIndex },
          rows: [{ values: [userEnteredValue === undefined ? {} : { userEnteredValue }] }],
          fields: "userEnteredValue",
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
            ]
          : [["ID", "Mutation ID", "Source", "Table", "Key", "Conflict", "Moved At"]];
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
