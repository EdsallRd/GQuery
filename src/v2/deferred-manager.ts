import { BLANK_CELL } from "./codecs";
import type { MutationResult, Selection } from "./selection";
import { Selection as MaterializedSelection, SELECTION_INTERNAL } from "./selection";
import { GQueryRuntimeError } from "./runtime-errors";
import type { DatabaseDefinition, TableDefinition } from "./schema";
import { canonicalStringify } from "./query";
import type {
  UnitOfWorkCommitResult,
  UnitOfWorkIntent,
  WriteConstraintSnapshot,
} from "./executor";
import {
  AppliedMutationReceiptLedger,
  DEFERRED_DEAD_LETTER_ACTOR_HEADER,
  DEFERRED_DEAD_LETTER_BASE_HEADERS,
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
  resolveSourceId(sourceName: string): string;
  find(tableName: string, key: Readonly<Record<string, unknown>>): Selection<Record<string, unknown>>;
  append(tableName: string, row: Record<string, unknown>): MutationResult<Record<string, unknown>>;
  /**
   * Optional optimized flush path. Implementations must return physical,
   * cache-bypassing complete-table selections for every requested table in one
   * batch read per workbook.
   */
  batchRead?(tableNames: readonly string[]): Readonly<Record<string, Selection<Record<string, unknown>>>>;
  /** Commit intents derived from the immediately preceding physical batch read. */
  commitBatch?(
    intents: readonly UnitOfWorkIntent[],
    snapshots: readonly WriteConstraintSnapshot[],
  ): UnitOfWorkCommitResult;
  /** Coordinate the physical read and write with other participating writers. */
  withWriteLock?<T>(operation: () => T): T;
  /** Suppress user-facing deferred guards while applying this journal itself. */
  withoutDeferredGuard?<T>(operation: () => T): T;
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

export class AppsScriptDeadLetterSheet implements DeferredDeadLetterSink {
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
      const lastRow = Math.max(1, sheet.getLastRow());
      const headerValues = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getDisplayValues()[0] ?? [];
      const headers = new Map(headerValues.map((header, index) => [header, index]));
      const requiredHeaders = [...DEFERRED_DEAD_LETTER_BASE_HEADERS, DEFERRED_DEAD_LETTER_ACTOR_HEADER];
      const missing = requiredHeaders.filter((header) => !headers.has(header));
      if (missing.length > 0) {
        throw new GQueryRuntimeError(
          "MIGRATION_REQUIRED",
          `The _gq_dead_letters system sheet is missing required header${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
          { details: { spreadsheetId, missingHeaders: missing } },
        );
      }
      const idColumn = (headers.get("ID") ?? 0) + 1;
      const existingIds = lastRow <= 1
        ? new Set<string>()
        : new Set(sheet.getRange(2, idColumn, lastRow - 1, 1).getDisplayValues().map((row) => row[0]).filter(Boolean));
      const novel = group.filter((record) => !existingIds.has(record.id));
      if (novel.length === 0) continue;
      const values = novel.map((record) => {
        const row = Array.from({ length: headerValues.length }, () => "");
        const set = (header: string, value: string): void => { row[headers.get(header)!] = value; };
        set("ID", record.id);
        set("Mutation ID", record.mutation.id);
        set("Source", record.mutation.sourceId);
        set("Table", record.mutation.table);
        set("Key", JSON.stringify(record.mutation.key));
        set("Conflict", JSON.stringify(record.conflict));
        set("Moved At", new Date(record.movedAtMs).toISOString());
        set(DEFERRED_DEAD_LETTER_ACTOR_HEADER, record.mutation.actor ?? "");
        return row;
      });
      sheet.getRange(lastRow + 1, 1, values.length, headerValues.length).setValues(values);
    }
  }
}

interface PreparedDeferredMutation {
  readonly mutation: CoalescedDeferredMutation;
  readonly definition: TableDefinition;
  readonly logicalKey: Record<string, unknown>;
}

interface StagedDeferredMutation extends PreparedDeferredMutation {
  readonly selection: Selection<Record<string, unknown>>;
  readonly intent: UnitOfWorkIntent;
}

function composeDeferredSources(
  sources: readonly PendingDeferredMutation[],
): Pick<CoalescedDeferredMutation, "kind" | "values"> {
  if (sources.length === 0) {
    throw new GQueryRuntimeError("MUTATION_INVALID", "Cannot compose an empty deferred mutation group.");
  }
  let kind = sources[0].kind;
  let values = sources[0].values === undefined ? undefined : { ...sources[0].values };
  for (const source of sources.slice(1)) {
    const nextKind = source.kind === "delete"
      ? "delete"
      : kind === "create" && source.kind === "upsert"
        ? "upsert"
        : kind;
    values = nextKind === "delete"
      ? undefined
      : { ...(values ?? {}), ...(source.values ?? {}) };
    kind = nextKind;
  }
  return { kind, values };
}

class JournalMutationExecutor implements DeferredMutationBatchExecutor {
  public constructor(
    private readonly access: DeferredManagerAccess,
    private readonly applied: AppliedMutationReceiptLedger | undefined,
  ) {}

  public apply(mutations: readonly CoalescedDeferredMutation[]): readonly DeferredMutationOutcome[] {
    const settled = new Map<string, DeferredMutationOutcome>();
    const effective: CoalescedDeferredMutation[] = [];
    for (const mutation of mutations) {
      const pendingSources = this.applied === undefined
        ? mutation.sourceMutations
        : mutation.sourceMutations.filter((source) => !this.applied!.has(source.id));
      if (pendingSources.length === 0) {
        settled.set(mutation.id, { mutationId: mutation.id, status: "committed" });
        continue;
      }
      if (pendingSources.length === mutation.sourceMutations.length) {
        effective.push(mutation);
        continue;
      }
      const pending = composeDeferredSources(pendingSources);
      const appliedSources = mutation.sourceMutations.filter((source) =>
        !pendingSources.some((pendingSource) => pendingSource.id === source.id)
      );
      const applied = composeDeferredSources(appliedSources);
      effective.push({
        ...mutation,
        sourceMutationIds: pendingSources.map((source) => source.id),
        sourceMutations: pendingSources,
        kind: pending.kind,
        values: pending.values,
        // The durable applied-prefix receipt supersedes the original version.
        // Its encoded final fields are verified against the physical snapshot
        // before the unapplied suffix is allowed to proceed.
        expectedVersion: null,
        recoveryAppliedValues: applied.kind === "delete" ? undefined : applied.values,
      });
    }
    if (effective.length === 0) return mutations.map((mutation) => settled.get(mutation.id)!);
    if (this.access.batchRead === undefined || this.access.commitBatch === undefined) {
      for (const mutation of effective) settled.set(mutation.id, this.applyOne(mutation));
      return mutations.map((mutation) => settled.get(mutation.id)!);
    }
    const execute = () => this.applyBatched(effective);
    const outcomes = this.access.withWriteLock === undefined
      ? execute()
      : this.access.withWriteLock(execute);
    for (const outcome of outcomes) settled.set(outcome.mutationId, outcome);
    return mutations.map((mutation) => settled.get(mutation.id) ?? ({
      mutationId: mutation.id,
      status: "transient" as const,
      message: "The deferred recovery batch did not produce an outcome.",
    }));
  }

  private applyBatched(
    mutations: readonly CoalescedDeferredMutation[],
  ): readonly DeferredMutationOutcome[] {
    const outcomes = new Map<string, DeferredMutationOutcome>();
    const byWorkbook = new Map<string, PreparedDeferredMutation[]>();

    for (const mutation of mutations) {
      try {
        const definition = this.table(mutation.table);
        const source = this.access.definition.sources[definition.source];
        if (source === undefined) {
          outcomes.set(
            mutation.id,
            this.conflict(mutation, `Table ${mutation.table} references unknown source ${definition.source}.`),
          );
          continue;
        }
        const resolvedSourceId = this.access.resolveSourceId(definition.source);
        if (resolvedSourceId !== mutation.sourceId) {
          if (source.kind === "active-spreadsheet") {
            throw new GQueryRuntimeError(
              "SOURCE_UNAVAILABLE",
              `Deferred mutation ${mutation.id} targets ${mutation.sourceId}, but the active source resolved to ${resolvedSourceId}.`,
              { details: { expectedSourceId: mutation.sourceId, actualSourceId: resolvedSourceId } },
            );
          }
          outcomes.set(mutation.id, this.conflict(
            mutation,
            `Deferred mutation source ${mutation.sourceId} does not match configured source ${resolvedSourceId}.`,
            { expectedSourceId: mutation.sourceId, actualSourceId: resolvedSourceId },
          ));
          continue;
        }
        if (definition.primaryKey.length === 0) {
          outcomes.set(mutation.id, this.conflict(
            mutation,
            `Deferred table ${mutation.table} does not declare a primary key.`,
          ));
          continue;
        }
        const logicalKey = this.decodeRecord(definition, mutation.key);
        const missingKeyFields = definition.primaryKey.filter((field) => !(field in logicalKey));
        if (missingKeyFields.length > 0) {
          outcomes.set(mutation.id, this.conflict(
            mutation,
            `Deferred key is missing primary-key field${missingKeyFields.length === 1 ? "" : "s"}: ${missingKeyFields.join(", ")}.`,
            { missingKeyFields },
          ));
          continue;
        }
        const group = byWorkbook.get(mutation.sourceId) ?? [];
        group.push({ mutation, definition, logicalKey });
        byWorkbook.set(mutation.sourceId, group);
      } catch (error) {
        outcomes.set(mutation.id, this.transient(mutation, error));
      }
    }

    for (const group of byWorkbook.values()) {
      try {
        this.applyWorkbookGroup(group, outcomes);
      } catch (error) {
        for (const prepared of group) {
          if (!outcomes.has(prepared.mutation.id)) {
            outcomes.set(prepared.mutation.id, this.transient(prepared.mutation, error));
          }
        }
      }
    }

    return mutations.map((mutation) => outcomes.get(mutation.id) ?? ({
      mutationId: mutation.id,
      status: "transient" as const,
      message: "The deferred batch did not produce an outcome.",
    }));
  }

  private applyWorkbookGroup(
    prepared: readonly PreparedDeferredMutation[],
    outcomes: Map<string, DeferredMutationOutcome>,
  ): void {
    const tableNames = new Set(prepared.map((item) => item.mutation.table));
    for (const item of prepared) {
      if (item.mutation.kind !== "create" && item.mutation.kind !== "upsert" && item.mutation.kind !== "patch") {
        continue;
      }
      const changedFields = new Set(Object.keys(item.mutation.values ?? {}));
      for (const relation of Object.values(item.definition.relations)) {
        if (relation.kind !== "belongs-to") continue;
        const local = Array.isArray(relation.local) ? relation.local : [relation.local];
        if (item.mutation.kind !== "patch" || local.some((field) => changedFields.has(field))) {
          tableNames.add(relation.target);
        }
      }
    }

    const complete = this.access.batchRead!([...tableNames]);
    const snapshots: WriteConstraintSnapshot[] = Object.entries(complete).map(([tableName, selection]) => ({
      tableName,
      rows: selection[SELECTION_INTERNAL].materialized,
    }));
    const staged: StagedDeferredMutation[] = [];

    for (const item of prepared) {
      const full = complete[item.mutation.table];
      if (full === undefined) {
        throw new GQueryRuntimeError(
          "INVALID_QUERY",
          `The deferred batch reader returned no snapshot for ${item.mutation.table}.`,
        );
      }
      const expectedKey = this.keyFingerprint(item.definition, item.logicalKey);
      const matches = full[SELECTION_INTERNAL].materialized.filter((row) =>
        this.keyFingerprint(item.definition, row.value) === expectedKey
      );
      const selection = new MaterializedSelection(
        matches,
        full.headers,
        full.stats,
        full[SELECTION_INTERNAL].runtime,
        full[SELECTION_INTERNAL].refresh,
      );
      if (selection.length > 1) {
        outcomes.set(item.mutation.id, this.conflict(
          item.mutation,
          "The deferred key resolved to more than one row.",
        ));
        continue;
      }
      const provenance = matches[0]?.provenance;
      const decodedValues = this.decodeRecord(item.definition, item.mutation.values ?? {});
      const recoveryAppliedValues = item.mutation.recoveryAppliedValues === undefined
        ? undefined
        : this.decodeRecord(item.definition, item.mutation.recoveryAppliedValues);
      if (
        provenance !== undefined &&
        recoveryAppliedValues !== undefined &&
        this.matchesIntendedState(item.mutation.kind, matches[0].value, decodedValues)
      ) {
        outcomes.set(item.mutation.id, this.committed(item.mutation));
        continue;
      }
      if (
        recoveryAppliedValues !== undefined &&
        (provenance === undefined ||
          !this.matchesIntendedState("patch", matches[0].value, recoveryAppliedValues))
      ) {
        outcomes.set(item.mutation.id, this.conflict(
          item.mutation,
          "The physical row no longer matches the confirmed deferred prefix during crash recovery.",
          { appliedFields: Object.keys(recoveryAppliedValues) },
        ));
        continue;
      }
      if (
        provenance !== undefined &&
        item.mutation.expectedVersion !== undefined &&
        item.mutation.expectedVersion !== null &&
        !Object.is(provenance.version, item.mutation.expectedVersion)
      ) {
        if (this.matchesIntendedState(item.mutation.kind, matches[0].value, decodedValues)) {
          outcomes.set(item.mutation.id, this.committed(item.mutation));
          continue;
        }
        outcomes.set(item.mutation.id, this.conflict(
          item.mutation,
          "The expected row version no longer matches.",
          { expected: item.mutation.expectedVersion, actual: provenance.version },
        ));
        continue;
      }

      if (
        item.definition.appendOnly === true &&
        (item.mutation.kind === "patch" || item.mutation.kind === "delete" ||
          (item.mutation.kind === "upsert" && selection.length > 0))
      ) {
        outcomes.set(item.mutation.id, this.conflict(
          item.mutation,
          `Append-only table ${item.mutation.table} cannot apply deferred ${item.mutation.kind} to an existing row.`,
        ));
        continue;
      }

      const suppliedKeyFields = item.definition.primaryKey.filter((field) =>
        Object.prototype.hasOwnProperty.call(decodedValues, field)
      );
      if (item.mutation.kind === "patch" && suppliedKeyFields.length > 0) {
        outcomes.set(item.mutation.id, this.conflict(
          item.mutation,
          `Deferred patches cannot change primary-key field${suppliedKeyFields.length === 1 ? "" : "s"}: ${suppliedKeyFields.join(", ")}.`,
          { suppliedKeyFields },
        ));
        continue;
      }
      const mismatchedKeyFields = suppliedKeyFields.filter((field) =>
        canonicalStringify(decodedValues[field]) !== canonicalStringify(item.logicalKey[field])
      );
      if (mismatchedKeyFields.length > 0) {
        outcomes.set(item.mutation.id, this.conflict(
          item.mutation,
          `Deferred values do not match the key-addressed field${mismatchedKeyFields.length === 1 ? "" : "s"}: ${mismatchedKeyFields.join(", ")}.`,
          { mismatchedKeyFields },
        ));
        continue;
      }

      let intent: UnitOfWorkIntent | undefined;
      if (item.mutation.kind === "delete") {
        if (selection.length === 0) {
          outcomes.set(item.mutation.id, this.committed(item.mutation));
          continue;
        }
        intent = { id: item.mutation.id, kind: "delete", selection };
      } else if (item.mutation.kind === "patch") {
        if (selection.length === 0) {
          outcomes.set(item.mutation.id, this.conflict(item.mutation, "The row no longer exists."));
          continue;
        }
        intent = {
          id: item.mutation.id,
          kind: "update",
          selection,
          patch: decodedValues,
        };
      } else {
        const values = {
          ...decodedValues,
          ...item.logicalKey,
        };
        if (item.mutation.kind === "create" && selection.length > 0) {
          outcomes.set(
            item.mutation.id,
            this.matchesIntendedState(item.mutation.kind, matches[0].value, values)
              ? this.committed(item.mutation)
              : this.conflict(
                  item.mutation,
                  "A different row already exists for the caller-assigned create key.",
                ),
          );
          continue;
        }
        intent = selection.length === 0
          ? { id: item.mutation.id, kind: "append", tableName: item.mutation.table, rows: [values] }
          : { id: item.mutation.id, kind: "update", selection, patch: values };
      }
      staged.push({ ...item, selection, intent });
    }

    if (staged.length === 0) return;
    const intents: UnitOfWorkIntent[] = [];
    const appendedByTable = new Map<string, { id: string; rows: Record<string, unknown>[] }>();
    for (const item of staged) {
      if (item.intent.kind !== "append") {
        intents.push(item.intent);
        continue;
      }
      const append = appendedByTable.get(item.intent.tableName) ?? {
        id: item.intent.id,
        rows: [],
      };
      append.rows.push(...item.intent.rows);
      appendedByTable.set(item.intent.tableName, append);
    }
    for (const [tableName, append] of appendedByTable) {
      intents.push({ id: append.id, kind: "append", tableName, rows: append.rows });
    }
    this.applied?.assertCanMarkMany(
      staged.flatMap((item) => item.mutation.sourceMutationIds),
    );
    const committed = this.access.commitBatch!(intents, snapshots);
    if (committed.status === "committed") {
      // One ledger publication narrows the post-commit crash window for the
      // whole atomic workbook request. State comparison below remains the
      // recovery fence if execution stops before this publication.
      this.applied?.markMany(staged.flatMap((item) => item.mutation.sourceMutationIds));
      for (const item of staged) {
        outcomes.set(item.mutation.id, this.committed(item.mutation, false));
      }
      return;
    }
    if (committed.status === "partial") {
      for (const item of staged) {
        outcomes.set(item.mutation.id, {
          mutationId: item.mutation.id,
          status: "transient",
          message: "The deferred workbook batch was only partially applied and will be retried idempotently.",
          conflict: { workbooks: committed.workbooks },
        });
      }
      return;
    }

    for (const item of staged) {
      const relevant = committed.conflicts.filter((conflict) =>
        conflict.table === item.mutation.table && (
          conflict.rowIndex !== undefined &&
            item.selection[SELECTION_INTERNAL].materialized.some((row) => row.provenance.rowIndex === conflict.rowIndex) ||
          this.conflictKeyMatches(item.definition, item.logicalKey, conflict.key)
        )
      );
      if (relevant.length > 0 || staged.length === 1) {
        outcomes.set(item.mutation.id, this.conflict(
          item.mutation,
          "The atomic deferred workbook batch failed validation.",
          { conflicts: relevant.length > 0 ? relevant : committed.conflicts },
        ));
      } else {
        outcomes.set(item.mutation.id, {
          mutationId: item.mutation.id,
          status: "transient",
          message: "Another mutation blocked the atomic workbook batch; this mutation remains queued.",
          conflict: { conflicts: committed.conflicts },
        });
      }
    }
  }

  private keyFingerprint(
    definition: TableDefinition,
    value: Readonly<Record<string, unknown>>,
  ): string {
    return canonicalStringify(definition.primaryKey.map((field) => value[field]));
  }

  private conflictKeyMatches(
    definition: TableDefinition,
    expected: Readonly<Record<string, unknown>>,
    actual: Readonly<Record<string, unknown>>,
  ): boolean {
    return definition.primaryKey.every((field) =>
      Object.prototype.hasOwnProperty.call(actual, field)
    ) && this.keyFingerprint(definition, expected) === this.keyFingerprint(definition, actual);
  }

  private transient(
    mutation: CoalescedDeferredMutation,
    error: unknown,
  ): DeferredMutationOutcome {
    return {
      mutationId: mutation.id,
      status: "transient",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private applyOne(mutation: CoalescedDeferredMutation): DeferredMutationOutcome {
    try {
      const definition = this.table(mutation.table);
      const source = this.access.definition.sources[definition.source];
      if (source === undefined) {
        return this.conflict(mutation, `Table ${mutation.table} references unknown source ${definition.source}.`);
      }
      const resolvedSourceId = this.access.resolveSourceId(definition.source);
      if (resolvedSourceId !== mutation.sourceId) {
        if (source.kind === "active-spreadsheet") {
          throw new GQueryRuntimeError(
            "SOURCE_UNAVAILABLE",
            `Deferred mutation ${mutation.id} targets ${mutation.sourceId}, but the active source resolved to ${resolvedSourceId}.`,
            { details: { expectedSourceId: mutation.sourceId, actualSourceId: resolvedSourceId } },
          );
        }
        return this.conflict(
          mutation,
          `Deferred mutation source ${mutation.sourceId} does not match configured source ${resolvedSourceId}.`,
          { expectedSourceId: mutation.sourceId, actualSourceId: resolvedSourceId },
        );
      }
      const logicalKey = this.decodeRecord(definition, mutation.key);
      const selection = this.access.find(mutation.table, logicalKey);
      if (selection.length > 1) {
        return this.conflict(mutation, "The deferred key resolved to more than one row.");
      }
      const provenance = selection.length === 0
        ? undefined
        : selection[SELECTION_INTERNAL].materialized[0]?.provenance;
      const decodedValues = this.decodeRecord(definition, mutation.values ?? {});
      const recoveryAppliedValues = mutation.recoveryAppliedValues === undefined
        ? undefined
        : this.decodeRecord(definition, mutation.recoveryAppliedValues);
      if (
        provenance !== undefined &&
        recoveryAppliedValues !== undefined &&
        this.matchesIntendedState(mutation.kind, selection.rows[0], decodedValues)
      ) {
        return this.committed(mutation);
      }
      if (
        recoveryAppliedValues !== undefined &&
        (provenance === undefined ||
          !this.matchesIntendedState("patch", selection.rows[0], recoveryAppliedValues))
      ) {
        return this.conflict(
          mutation,
          "The physical row no longer matches the confirmed deferred prefix during crash recovery.",
          { appliedFields: Object.keys(recoveryAppliedValues) },
        );
      }
      if (provenance !== undefined && mutation.expectedVersion !== undefined && mutation.expectedVersion !== null && !Object.is(provenance.version, mutation.expectedVersion)) {
        if (this.matchesIntendedState(mutation.kind, selection.rows[0], decodedValues)) {
          return this.committed(mutation);
        }
        return this.conflict(mutation, "The expected row version no longer matches.", {
          expected: mutation.expectedVersion,
          actual: provenance.version,
        });
      }

      let result: MutationResult<Record<string, unknown>> | undefined;
      this.applied?.assertCanMarkMany(mutation.sourceMutationIds);
      if (mutation.kind === "delete") {
        if (selection.length === 0) return this.committed(mutation);
        result = selection.delete();
      } else if (mutation.kind === "patch") {
        if (selection.length === 0) return this.conflict(mutation, "The row no longer exists.");
        result = selection.update(decodedValues);
      } else if (mutation.kind === "upsert") {
        const values = { ...logicalKey, ...decodedValues };
        result = selection.length === 0 ? this.access.append(mutation.table, values) : selection.update(values);
      } else {
        const values = { ...logicalKey, ...decodedValues };
        if (selection.length > 0) {
          return this.matchesIntendedState(mutation.kind, selection.rows[0], values)
            ? this.committed(mutation)
            : this.conflict(
                mutation,
                "A different row already exists for the caller-assigned create key.",
              );
        }
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

  private matchesIntendedState(
    kind: CoalescedDeferredMutation["kind"],
    row: Readonly<Record<string, unknown>> | undefined,
    values: Readonly<Record<string, unknown>>,
  ): boolean {
    if (kind === "delete" || row === undefined) return false;
    return Object.entries(values).every(([field, value]) =>
      canonicalStringify(row[field]) === canonicalStringify(value)
    );
  }

  private committed(
    mutation: CoalescedDeferredMutation,
    recordApplied = true,
  ): DeferredMutationOutcome {
    if (recordApplied) this.applied?.markMany(mutation.sourceMutationIds);
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
    const run = () => this.journal().flush(executor, deadLetters);
    return this.access.withoutDeferredGuard === undefined
      ? run()
      : this.access.withoutDeferredGuard(run);
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
