import { BLANK_CELL } from "./codecs";
import type { MutationResult, Selection } from "./selection";
import { SELECTION_INTERNAL } from "./selection";
import { GQueryRuntimeError } from "./runtime-errors";
import type { DatabaseDefinition, TableDefinition } from "./schema";
import {
  AppliedMutationReceiptLedger,
  type CoalescedDeferredMutation,
  type DeferredDeadLetter,
  type DeferredDeadLetterSink,
  type DeferredFlushResult,
  type DeferredJournal,
  type DeferredMutationBatchExecutor,
  type DeferredMutationOutcome,
  type PendingDeferredMutation,
  type PendingMutationReceipt,
} from "./infrastructure/deferred";
import { AppsScriptPropertyStore, type PropertyStore } from "./infrastructure/runtime";

export interface DeferredManagerAccess {
  readonly definition: DatabaseDefinition;
  find(tableName: string, key: Readonly<Record<string, unknown>>): Selection<Record<string, unknown>>;
  append(tableName: string, row: Record<string, unknown>): MutationResult<Record<string, unknown>>;
}

export interface DeferredManagerOptions {
  readonly journal?: DeferredJournal;
  readonly deadLetters?: DeferredDeadLetterSink;
  readonly appliedReceipts?: PropertyStore;
  readonly retainedAppliedReceiptLimit?: number;
  readonly appliedReceiptMaximumBytes?: number;
  readonly appliedReceiptMaximumAgeMs?: number;
  readonly namespace?: string;
}

function decodeCell(value: unknown): unknown {
  return value === null || value === undefined ? BLANK_CELL : value;
}

class AppsScriptDeadLetterSheet implements DeferredDeadLetterSink {
  public write(records: readonly DeferredDeadLetter[]): void {
    const bySpreadsheet = new Map<string, DeferredDeadLetter[]>();
    for (const record of records) {
      const group = bySpreadsheet.get(record.mutation.sourceId) ?? [];
      group.push(record);
      bySpreadsheet.set(record.mutation.sourceId, group);
    }
    for (const [spreadsheetId, group] of bySpreadsheet) {
      const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      const sheet = spreadsheet.getSheetByName("_gq_dead_letters");
      if (sheet === null) {
        throw new GQueryRuntimeError("MIGRATION_REQUIRED", "Deferred conflicts require the _gq_dead_letters system sheet.");
      }
      const values = group.map((record) => [
        record.id,
        record.mutation.id,
        record.mutation.sourceId,
        record.mutation.table,
        JSON.stringify(record.mutation.key),
        JSON.stringify(record.conflict),
        new Date(record.movedAtMs).toISOString(),
      ]);
      sheet.getRange(sheet.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
    }
  }
}

class JournalMutationExecutor implements DeferredMutationBatchExecutor {
  public constructor(
    private readonly access: DeferredManagerAccess,
    private readonly applied: AppliedMutationReceiptLedger | undefined,
  ) {}

  public apply(mutations: readonly CoalescedDeferredMutation[]): readonly DeferredMutationOutcome[] {
    return mutations.map((mutation) => this.applyOne(mutation));
  }

  private applyOne(mutation: CoalescedDeferredMutation): DeferredMutationOutcome {
    if (this.applied?.has(mutation.id) === true) {
      return { mutationId: mutation.id, status: "committed" };
    }
    try {
      const definition = this.table(mutation.table);
      const logicalKey = this.decodeRecord(definition, mutation.key);
      const selection = this.access.find(mutation.table, logicalKey);
      if (selection.length > 1) {
        return this.conflict(mutation, "The deferred key resolved to more than one row.");
      }
      const provenance = selection[SELECTION_INTERNAL].materialized[0]?.provenance;
      if (provenance !== undefined && mutation.expectedVersion !== undefined && mutation.expectedVersion !== null && !Object.is(provenance.version, mutation.expectedVersion)) {
        return this.conflict(mutation, "The expected row version no longer matches.", {
          expected: mutation.expectedVersion,
          actual: provenance.version,
        });
      }

      let result: MutationResult<Record<string, unknown>> | undefined;
      if (mutation.kind === "delete") {
        if (selection.length === 0) return this.committed(mutation);
        result = selection.delete();
      } else if (mutation.kind === "patch") {
        if (selection.length === 0) return this.conflict(mutation, "The row no longer exists.");
        result = selection.update(this.decodeRecord(definition, mutation.values ?? {}));
      } else if (mutation.kind === "upsert") {
        const values = { ...logicalKey, ...this.decodeRecord(definition, mutation.values ?? {}) };
        result = selection.length === 0 ? this.access.append(mutation.table, values) : selection.update(values);
      } else {
        if (selection.length > 0) return this.committed(mutation);
        const values = { ...logicalKey, ...this.decodeRecord(definition, mutation.values ?? {}) };
        result = this.access.append(mutation.table, values);
      }
      if (result.status === "conflicted") {
        return this.conflict(mutation, "Targeted mutation preflight found a conflict.", { conflicts: result.conflicts });
      }
      return this.committed(mutation);
    } catch (error) {
      return {
        mutationId: mutation.id,
        status: "transient",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private table(tableName: string): TableDefinition {
    const definition = this.access.definition.tables[tableName];
    if (definition === undefined) throw new GQueryRuntimeError("INVALID_QUERY", `Deferred journal references unknown table ${tableName}.`);
    return definition;
  }

  private decodeRecord(
    definition: TableDefinition,
    values: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [field, raw] of Object.entries(values)) {
      const column = definition.columns[field];
      if (column === undefined) throw new GQueryRuntimeError("MUTATION_INVALID", `Deferred value references unknown column ${field}.`);
      result[field] = column.decode(decodeCell(raw), {
        column: field,
        header: column.header ?? field,
      });
    }
    return result;
  }

  private conflict(
    mutation: CoalescedDeferredMutation,
    message: string,
    conflict: Readonly<Record<string, unknown>> = {},
  ): DeferredMutationOutcome {
    return { mutationId: mutation.id, status: "conflict", message, conflict: { message, ...conflict } };
  }

  public forgetApplied(mutationIds: readonly string[]): void {
    this.applied?.forget(mutationIds);
  }

  private committed(mutation: CoalescedDeferredMutation): DeferredMutationOutcome {
    this.applied?.mark(mutation.id);
    return { mutationId: mutation.id, status: "committed" };
  }
}

/** Operational facade for the durable journal and five-minute flush handler. */
export class DeferredManager {
  private readonly namespace: string;

  public constructor(
    private readonly access: DeferredManagerAccess,
    private readonly options: DeferredManagerOptions = {},
  ) {
    this.namespace = options.namespace ?? "gq2";
  }

  public list(): readonly PendingDeferredMutation[] {
    return this.journal().list();
  }

  public receipt(idempotencyKey: string): PendingMutationReceipt | null {
    return this.journal().receipt(idempotencyKey);
  }

  public rebuildOverlay(): number {
    return this.journal().rebuildOverlay();
  }

  public flush(): DeferredFlushResult {
    const properties = this.options.appliedReceipts ?? this.defaultProperties();
    const applied = properties === undefined
      ? undefined
      : new AppliedMutationReceiptLedger(properties, {
          namespace: this.namespace,
          retainedReceiptLimit: this.options.retainedAppliedReceiptLimit,
          maximumBytes: this.options.appliedReceiptMaximumBytes,
          maximumAgeMs: this.options.appliedReceiptMaximumAgeMs,
        });
    const executor = new JournalMutationExecutor(this.access, applied);
    const deadLetters = this.options.deadLetters ?? new AppsScriptDeadLetterSheet();
    return this.journal().flush(executor, deadLetters);
  }

  private journal(): DeferredJournal {
    if (this.options.journal === undefined) {
      throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "Durable deferred delivery is not configured.");
    }
    return this.options.journal;
  }

  private defaultProperties(): PropertyStore | undefined {
    try {
      return new AppsScriptPropertyStore(PropertiesService.getScriptProperties());
    } catch {
      return undefined;
    }
  }
}
