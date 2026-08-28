import {
  GQueryExecutor,
  type ExecutableQuery,
  type ExecutorOptions,
  type RuntimeGenerationAdapter,
  type UnitOfWorkCommitResult,
  type UnitOfWorkIntent,
  type WriteConstraintSnapshot,
  type WorkbookCommitReceipt,
} from "./executor";
import { createExecutionStats, mergeExecutionStats, type ExecutionPlan, type ExecutionStats } from "./execution";
import {
  canonicalStringify,
  cloneQueryPlan,
  combinePredicates,
  emptyQueryPlan,
  normalizeWhere,
  type JoinCardinality,
  type JoinKind,
  type SerializableQueryPlan,
  type SortDirection,
  type Where,
} from "./query";
import { GQueryRuntimeError } from "./runtime-errors";
import { GQueryDefinitionError } from "./errors";
import {
  SELECTION_INTERNAL,
  Selection,
  type DeleteOptions,
  type MutationOptions,
  type MutationPatch,
  type MutationResult,
  type PendingMutationReceipt,
  type SelectionRuntime,
} from "./selection";
import type {
  DatabaseDefinition,
  InferTableRow,
  RelationDefinition,
  RelationMap,
  SourceMap,
  TableDefinition,
} from "./schema";
import {
  AppsScriptSheetsTransport,
  type AtomicMutation,
  type SheetBatchGetResult,
  type SheetBatchUpdateOptions,
  type SheetBatchUpdateResult,
  type SheetReadOptions,
  type SheetValueRange,
  type SheetValueUpdate,
  type SheetsTransport,
} from "./transport";
import type { SyncLock } from "./infrastructure/runtime";
import { RetryController } from "./infrastructure/retry";
import {
  ScopedRetryTransportInvoker,
  type ScopedRetryTransportInvokerOptions,
} from "./infrastructure/retry-transport";
import {
  createAppsScriptChunkedCache,
  createAppsScriptGenerationStore,
  type AppsScriptCacheScope,
  type ChunkedCache,
} from "./infrastructure/cache";
import {
  AppsScriptSchemaCanonicalState,
  InMemorySchemaCanonicalState,
  SchemaManager,
  type SchemaCanonicalState,
} from "./management";
import { SystemManager } from "./system-manager";
import type { ManualEditHooks } from "./infrastructure/system";
import { DeferredManager } from "./deferred-manager";
import {
  ChunkedDeferredOverlay,
  createAppsScriptDeferredJournal,
  type DeferredDeadLetterSink,
  type DeferredJournal,
  type DeferredOverlayReader,
} from "./infrastructure/deferred";
import type { PropertyStore } from "./infrastructure/runtime";
import { invalidateChangedRelations, type MaterializedRow } from "./provenance";
import { validateJoinPlan } from "./join-validation";
import { CacheInvalidationManager, type CacheInvalidationApi } from "./cache-manager";
import { isReservedTablePropertyName } from "./reserved";

type AnyRow = Record<string, unknown>;
type TableNames<D extends DatabaseDefinition> = Extract<keyof D["tables"], string>;
type TableAt<D extends DatabaseDefinition, N extends TableNames<D>> = D["tables"][N];
export type RowAt<D extends DatabaseDefinition, N extends TableNames<D>> =
  Extract<InferTableRow<TableAt<D, N>>, AnyRow>;

type RelationsAt<D extends DatabaseDefinition, N extends TableNames<D>> =
  TableAt<D, N> extends TableDefinition<
    infer _Columns,
    infer _Source,
    infer _Primary,
    infer Relations,
    infer _Unique
  > ? Relations : RelationMap;

type RelationTarget<R> = R extends RelationDefinition<
  infer _Kind,
  infer Target,
  infer _Local,
  infer _Foreign
> ? Target : never;

type RelationValue<
  D extends DatabaseDefinition,
  R,
> = RelationTarget<R> extends TableNames<D>
  ? R extends RelationDefinition<"has-many">
    ? readonly RowAt<D, Extract<RelationTarget<R>, TableNames<D>>>[]
    : RowAt<D, Extract<RelationTarget<R>, TableNames<D>>> | null
  : never;

export type IncludedRow<
  D extends DatabaseDefinition,
  N extends TableNames<D>,
  Row extends AnyRow,
  R extends Extract<keyof RelationsAt<D, N>, string>,
> = Row & { readonly [Name in R]: RelationValue<D, RelationsAt<D, N>[Name]> };

export interface JoinOptions<
  Row extends AnyRow,
  OtherRow extends AnyRow,
  Alias extends string,
  Kind extends JoinKind = "left",
  Cardinality extends JoinCardinality = "one",
  Selected extends readonly Extract<keyof OtherRow, string>[] | undefined = undefined,
> {
  readonly as: Alias;
  readonly on: {
    readonly local: Extract<keyof Row, string> | readonly Extract<keyof Row, string>[];
    readonly foreign: Extract<keyof OtherRow, string> | readonly Extract<keyof OtherRow, string>[];
  };
  readonly kind?: Kind;
  readonly cardinality?: Cardinality;
  readonly select?: Selected;
}

type SelectedJoinRow<
  Target extends AnyRow,
  Selected extends readonly Extract<keyof Target, string>[] | undefined,
> = Selected extends readonly Extract<keyof Target, string>[]
  ? Pick<Target, Selected[number]>
  : Target;

type AdHocJoinedRow<
  Base extends AnyRow,
  Target extends AnyRow,
  Alias extends string,
  Kind extends JoinKind,
  Cardinality extends JoinCardinality,
  Selected extends readonly Extract<keyof Target, string>[] | undefined,
> = Kind extends "semi" | "anti"
  ? Base
  : Base & {
      readonly [Key in Alias]: Cardinality extends "many"
        ? readonly SelectedJoinRow<Target, Selected>[]
        : Kind extends "inner"
          ? SelectedJoinRow<Target, Selected>
          : SelectedJoinRow<Target, Selected> | null;
    };

export interface Group<T extends AnyRow> {
  readonly key: Readonly<Partial<T>>;
  readonly rows: readonly Readonly<T>[];
  readonly count: number;
}

export interface UpsertResult<T extends AnyRow> {
  readonly status: "committed" | "queued" | "conflicted" | "partial";
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly conflicted: number;
  readonly workbooks: readonly WorkbookCommitReceipt[];
  readonly update?: MutationResult<T>;
  readonly insert?: MutationResult<T>;
  /** Deferred upserts cannot know insert-versus-update until flush. */
  readonly pending?: number;
  readonly receipt?: PendingMutationReceipt;
  readonly stats: ExecutionStats;
}

export interface UpsertOptions<T extends AnyRow> {
  readonly keys?: readonly Extract<keyof T, string>[];
  readonly delivery?: "immediate" | "deferred";
  readonly idempotencyKey?: string;
  readonly actor?: string;
}

export interface SyncOptions<T extends AnyRow> {
  readonly keys?: readonly Extract<keyof T, string>[];
  readonly preserve?: readonly Extract<keyof T, string>[];
  readonly missing?:
    | { readonly action: "keep" }
    | { readonly action: "delete" }
    | {
        readonly action: "deactivate";
        readonly field: Extract<keyof T, string>;
        readonly value: T[Extract<keyof T, string>];
      };
}

export interface SyncResult<T extends AnyRow> extends UpsertResult<T> {
  readonly deactivated: number;
  readonly deleted: number;
}

export type QueryMutationPatch<
  Visible extends AnyRow,
  Writable extends AnyRow,
> = Partial<Writable> | ((draft: Visible) => Partial<Writable> | void);

/** Public selection view whose base-table mutation keys exclude joined aliases. */
export type QuerySelection<
  Visible extends AnyRow,
  Writable extends AnyRow,
> = Omit<Selection<Visible>, "refresh" | "update"> & {
  refresh(): QuerySelection<Visible, Writable>;
  update(
    patch: QueryMutationPatch<Visible, Writable>,
    options?: MutationOptions,
  ): MutationResult<Visible>;
};

function nonNegativeInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GQueryRuntimeError("INVALID_QUERY", `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function rowFingerprint(row: AnyRow, keys: readonly string[]): string {
  return canonicalStringify(keys.map((key) => row[key]));
}

function operationKeys(
  operation: "sync" | "upsertMany",
  tableName: string,
  definition: TableDefinition,
  requested: readonly string[] | undefined,
): readonly string[] {
  const keys = requested ?? definition.primaryKey;
  if (keys.length === 0) {
    throw new GQueryRuntimeError(
      "INVALID_QUERY",
      `${operation}() requires a declared primary or unique key for ${tableName}.`,
    );
  }
  const declared = [definition.primaryKey, ...definition.unique].some((candidate) =>
    candidate.length === keys.length &&
    candidate.every((field, index) => field === keys[index])
  );
  if (!declared) {
    throw new GQueryRuntimeError(
      "INVALID_QUERY",
      `${operation}() keys must exactly match a declared primary or unique key for ${tableName}.`,
      {
        details: {
          table: tableName,
          keys,
          declaredKeys: [definition.primaryKey, ...definition.unique],
        },
      },
    );
  }
  return keys;
}

function indexCurrentRows(
  operation: "sync" | "upsertMany",
  tableName: string,
  rows: readonly Readonly<AnyRow>[],
  keys: readonly string[],
): Map<string, number> {
  const indexed = new Map<string, number>();
  rows.forEach((row, index) => {
    const fingerprint = rowFingerprint(row as AnyRow, keys);
    const duplicate = indexed.get(fingerprint);
    if (duplicate !== undefined) {
      throw new GQueryRuntimeError(
        "DUPLICATE_KEY",
        `${operation}() found duplicate existing ${tableName} rows for its selected key.`,
        {
          details: {
            table: tableName,
            keys,
            firstIndex: duplicate,
            duplicateIndex: index,
          },
        },
      );
    }
    indexed.set(fingerprint, index);
  });
  return indexed;
}

function logicalValueEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (Object.is(left, right)) return true;
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    try { return canonicalStringify(left) === canonicalStringify(right); } catch { return false; }
  }
  return false;
}

function rowsEqual(left: AnyRow, right: AnyRow, fields: readonly string[]): boolean {
  return fields.every((field) => logicalValueEqual(left[field], right[field]));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { then?: unknown }).then === "function"
    : false;
}

/** An immutable query handle. Every chain method returns a new instance. */
export class Query<
  D extends DatabaseDefinition,
  N extends TableNames<D>,
  Row extends AnyRow = RowAt<D, N>,
  WritableRow extends AnyRow = RowAt<D, N>,
> {
  protected readonly localPredicates: readonly ((row: Readonly<Row>) => boolean)[];

  public constructor(
    protected readonly database: GQueryDatabase<D>,
    public readonly tableName: N,
    protected readonly plan: SerializableQueryPlan,
    localPredicates: readonly ((row: Readonly<Row>) => boolean)[] = [],
  ) {
    this.localPredicates = Object.freeze([...localPredicates]);
  }

  protected next<NextRow extends AnyRow = Row>(
    plan: SerializableQueryPlan,
    localPredicates: readonly ((row: Readonly<NextRow>) => boolean)[] = this.localPredicates as unknown as readonly ((row: Readonly<NextRow>) => boolean)[],
  ): Query<D, N, NextRow, WritableRow> {
    return new Query<D, N, NextRow, WritableRow>(
      this.database,
      this.tableName,
      plan,
      localPredicates,
    );
  }

  public all(): Query<D, N, Row, WritableRow> {
    return this.next(this.plan);
  }

  public where(predicate: Where<Row>): Query<D, N, Row, WritableRow> {
    const normalized = normalizeWhere(predicate);
    return this.next(cloneQueryPlan(this.plan, {
      predicate: combinePredicates(this.plan.predicate, normalized),
    }));
  }

  public whereLocal(predicate: (row: Readonly<Row>) => boolean): Query<D, N, Row, WritableRow> {
    if (typeof predicate !== "function") throw new TypeError("whereLocal() expects a callback.");
    return this.next(this.plan, [...this.localPredicates, predicate]);
  }

  public select<const Fields extends readonly Extract<keyof Row, string>[]>(
    fields: Fields,
  ): Query<D, N, Pick<Row, Fields[number]> & AnyRow, WritableRow> {
    if (fields.length === 0) throw new GQueryRuntimeError("INVALID_QUERY", "select() requires at least one field.");
    return this.next<Pick<Row, Fields[number]> & AnyRow>(
      cloneQueryPlan(this.plan, { projection: [...fields] }),
      this.localPredicates as unknown as readonly ((row: Readonly<Pick<Row, Fields[number]> & AnyRow>) => boolean)[],
    );
  }

  public orderBy(
    field: Extract<keyof Row, string>,
    direction: SortDirection = "asc",
  ): Query<D, N, Row, WritableRow> {
    return this.next(cloneQueryPlan(this.plan, {
      orderBy: [...this.plan.orderBy, { field, direction }],
    }));
  }

  public limit(value: number): Query<D, N, Row, WritableRow> {
    return this.next(cloneQueryPlan(this.plan, { limit: nonNegativeInteger("limit", value) }));
  }

  public offset(value: number): Query<D, N, Row, WritableRow> {
    return this.next(cloneQueryPlan(this.plan, { offset: nonNegativeInteger("offset", value) }));
  }

  public tail(value: number): Query<D, N, Row, WritableRow> {
    return this.next(cloneQueryPlan(this.plan, { tail: nonNegativeInteger("tail", value) }));
  }

  public include<RelationName extends Extract<keyof RelationsAt<D, N>, string>>(
    name: RelationName,
  ): Query<D, N, IncludedRow<D, N, Row, RelationName>, WritableRow> {
    const relation = this.database.definition.tables[this.tableName].relations[name] as RelationDefinition | undefined;
    if (relation === undefined) {
      throw new GQueryRuntimeError("RELATION_NOT_FOUND", `Table ${this.tableName} has no relation ${name}.`);
    }
    const nextPlan = cloneQueryPlan(this.plan, {
      joins: [...this.plan.joins, {
        table: relation.target,
        alias: name,
        localField: relation.local,
        foreignField: relation.foreign,
        kind: "left",
        cardinality: relation.cardinality,
        relationName: name,
      }],
    });
    validateJoinPlan(this.database.definition, nextPlan);
    return this.next<IncludedRow<D, N, Row, RelationName>>(nextPlan);
  }

  public join<
    OtherName extends TableNames<D>,
    const Alias extends string,
    const Kind extends JoinKind = "left",
    const Cardinality extends JoinCardinality = "one",
    const Selected extends readonly Extract<keyof RowAt<D, OtherName>, string>[] | undefined = undefined,
  >(
    other: TableHandle<D, OtherName>,
    options: JoinOptions<Row, RowAt<D, OtherName>, Alias, Kind, Cardinality, Selected>,
  ): Query<
    D,
    N,
    AdHocJoinedRow<Row, RowAt<D, OtherName>, Alias, Kind, Cardinality, Selected>,
    WritableRow
  > {
    const nextPlan = cloneQueryPlan(this.plan, {
      joins: [...this.plan.joins, {
        table: other.tableName,
        alias: options.as,
        localField: options.on.local,
        foreignField: options.on.foreign,
        kind: options.kind ?? "left",
        cardinality: options.cardinality ?? "one",
        select: options.select,
      }],
    });
    validateJoinPlan(this.database.definition, nextPlan);
    return this.next(nextPlan) as Query<
      D,
      N,
      AdHocJoinedRow<Row, RowAt<D, OtherName>, Alias, Kind, Cardinality, Selected>,
      WritableRow
    >;
  }

  public get(): QuerySelection<Row, WritableRow> {
    return this.database.materialize(
      this.database.executor.execute(this.executable()).selection,
    ) as QuerySelection<Row, WritableRow>;
  }

  public findOne(): QuerySelection<Row, WritableRow> {
    const result = this.limit(2).get();
    if (result.length !== 1) {
      throw new GQueryRuntimeError(
        "EXPECTED_ONE",
        `Expected exactly one ${this.tableName} row; received ${result.length}.`,
        { details: { table: this.tableName, count: result.length } },
      );
    }
    return result;
  }

  public maybeOne(): QuerySelection<Row, WritableRow> {
    const result = this.limit(2).get();
    if (result.length > 1) {
      throw new GQueryRuntimeError(
        "EXPECTED_ONE",
        `Expected at most one ${this.tableName} row; received ${result.length}.`,
        { details: { table: this.tableName, count: result.length } },
      );
    }
    return result;
  }

  public find(key: unknown): QuerySelection<Row, WritableRow> {
    const definition = this.database.definition.tables[this.tableName];
    if (definition.primaryKey.length === 0) {
      throw new GQueryRuntimeError("INVALID_QUERY", `Table ${this.tableName} has no primary key.`);
    }
    const predicate: Record<string, unknown> = {};
    if (definition.primaryKey.length === 1 && (key === null || typeof key !== "object" || key instanceof Date)) {
      predicate[definition.primaryKey[0]] = key;
    } else {
      if (key === null || typeof key !== "object" || Array.isArray(key)) {
        throw new GQueryRuntimeError("INVALID_QUERY", `Composite key lookup for ${this.tableName} requires an object.`);
      }
      for (const field of definition.primaryKey) predicate[field] = (key as AnyRow)[field];
    }
    return this.where(predicate as Where<Row>).maybeOne();
  }

  public count(): number {
    return this.aggregateSelection().length;
  }

  public exists(): boolean {
    return this.aggregateSelection(1).length > 0;
  }

  /** Execute aggregates with a key-only output shape; joined rows are still
   * validated for cardinality, but their payload columns are not materialized. */
  private aggregateSelection(limit?: number): Selection<Record<string, unknown>> {
    const definition = this.database.definition.tables[this.tableName];
    const anchor = definition.primaryKey[0] ?? Object.keys(definition.columns)[0];
    const executable = this.executable() as unknown as ExecutableQuery<Record<string, unknown>>;
    const plan = cloneQueryPlan(executable.plan, {
      projection: anchor === undefined ? executable.plan.projection : [anchor],
      orderBy: [],
      joins: executable.plan.joins.map((join) => ({
        ...join,
        ...(join.kind === "semi" || join.kind === "anti" ? {} : { select: [] }),
      })),
      ...(limit === undefined ? {} : { limit }),
    });
    return this.database.executor.execute({ ...executable, plan }).selection;
  }

  public groupBy(
    fields: readonly Extract<keyof Row, string>[],
  ): readonly Group<Row>[] {
    if (fields.length === 0) throw new GQueryRuntimeError("INVALID_QUERY", "groupBy() requires at least one field.");
    const result = this.get();
    const groups = new Map<string, { key: Partial<Row>; rows: Readonly<Row>[] }>();
    for (const row of result.rows) {
      const key: Partial<Row> = {};
      for (const field of fields) key[field] = row[field] as Row[typeof field];
      const fingerprint = canonicalStringify(fields.map((field) => row[field]));
      const group = groups.get(fingerprint) ?? { key, rows: [] };
      group.rows.push(row);
      groups.set(fingerprint, group);
    }
    return Object.freeze([...groups.values()].map((group) => Object.freeze({
      key: Object.freeze(group.key),
      rows: Object.freeze(group.rows),
      count: group.rows.length,
    })));
  }

  public update(
    patch: QueryMutationPatch<Row, WritableRow>,
    options?: MutationOptions,
  ): MutationResult<Row> {
    return this.get().update(patch, options);
  }

  public delete(options?: DeleteOptions): MutationResult<Row> {
    return this.get().delete(options);
  }

  public explain(): ExecutionPlan {
    return this.database.executor.explain(this.executable());
  }

  public executable(): ExecutableQuery<Row> {
    return this.database.decorateExecutable({
      plan: this.plan,
      localPredicates: this.localPredicates,
      refresh: () => this.get() as unknown as Selection<Row>,
    });
  }
}

export class TableHandle<
  D extends DatabaseDefinition,
  N extends TableNames<D>,
> extends Query<D, N, RowAt<D, N>> {
  public constructor(database: GQueryDatabase<D>, tableName: N) {
    const definition = database.definition.tables[tableName];
    super(database, tableName, emptyQueryPlan(tableName, definition.source));
  }

  public append(
    row: RowAt<D, N>,
    options: MutationOptions = {},
  ): MutationResult<RowAt<D, N>> {
    return this.appendMany([row], options);
  }

  public appendMany(
    rows: readonly RowAt<D, N>[],
    options: MutationOptions = {},
  ): MutationResult<RowAt<D, N>> {
    if (options.delivery === "deferred") {
      if (rows.length !== 1) {
        throw new GQueryRuntimeError(
          "MUTATION_INVALID",
          "Deferred appendMany() requires exactly one caller-keyed row per idempotency key.",
        );
      }
      return this.database.deferKeyedWrite(this.tableName, rows[0], "create", options);
    }
    return this.database.appendRows(this.tableName, rows);
  }

  public upsertMany(
    incoming: readonly RowAt<D, N>[],
    options: UpsertOptions<RowAt<D, N>> = {},
  ): UpsertResult<RowAt<D, N>> {
    if (options.delivery === "deferred") {
      if (incoming.length !== 1) {
        throw new GQueryRuntimeError(
          "MUTATION_INVALID",
          "Deferred upsertMany() requires exactly one caller-keyed row per idempotency key.",
        );
      }
      const definition = this.database.definition.tables[this.tableName];
      const keys = operationKeys(
        "upsertMany",
        this.tableName,
        definition,
        options.keys as readonly string[] | undefined,
      );
      if (
        keys.length !== definition.primaryKey.length ||
        !keys.every((field, index) => field === definition.primaryKey[index])
      ) {
        throw new GQueryRuntimeError(
          "MUTATION_INVALID",
          "Deferred upserts must be addressed by the table primary key.",
        );
      }
      const queued = this.database.deferKeyedWrite(
        this.tableName,
        incoming[0],
        "upsert",
        options,
      );
      return {
        status: queued.status,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        conflicted: queued.status === "conflicted" ? 1 : 0,
        pending: queued.status === "queued" ? 1 : 0,
        receipt: queued.receipt,
        workbooks: [],
        stats: queued.stats,
      };
    }
    return this.database.withParticipatingWriteLock(
      () => this.upsertManyUnlocked(incoming, options),
    );
  }

  private upsertManyUnlocked(
    incoming: readonly RowAt<D, N>[],
    options: { readonly keys?: readonly Extract<keyof RowAt<D, N>, string>[] },
  ): UpsertResult<RowAt<D, N>> {
    const definition = this.database.definition.tables[this.tableName];
    const keys = operationKeys(
      "upsertMany",
      this.tableName,
      definition,
      options.keys as readonly string[] | undefined,
    );
    const current = this.get();
    const currentByKey = indexCurrentRows(
      "upsertMany",
      this.tableName,
      current.rows,
      keys,
    );
    const incomingByKey = new Map<string, RowAt<D, N>>();
    for (const row of incoming) {
      const fingerprint = rowFingerprint(row, keys);
      if (incomingByKey.has(fingerprint)) throw new GQueryRuntimeError("DUPLICATE_KEY", "upsertMany input contains duplicate keys.");
      incomingByKey.set(fingerprint, row);
    }
    const updates = new Map<string, RowAt<D, N>>();
    const inserts: RowAt<D, N>[] = [];
    let unchanged = 0;
    const fields = Object.keys(definition.columns);
    for (const [fingerprint, row] of incomingByKey) {
      const currentIndex = currentByKey.get(fingerprint);
      if (currentIndex === undefined) inserts.push(row);
      else if (rowsEqual(current.rows[currentIndex], row, fields)) unchanged += 1;
      else updates.set(fingerprint, row);
    }
    const intents: UnitOfWorkIntent[] = [];
    if (updates.size > 0) {
      const materialized = current[SELECTION_INTERNAL].materialized.filter((item) => updates.has(rowFingerprint(item.value, keys)));
      const subset = new Selection(materialized, current.headers, current.stats, this.database.executor, () => this.get());
      intents.push({
        id: "upsert:update",
        kind: "update",
        selection: subset as unknown as Selection<Record<string, unknown>>,
        patch: (row) => updates.get(rowFingerprint(row, keys)) ?? {},
      });
    }
    if (inserts.length > 0) {
      intents.push({
        id: "upsert:append",
        kind: "append",
        tableName: this.tableName,
        rows: inserts,
      });
    }
    const committed = this.database.commitIntents(intents, [{
      tableName: this.tableName,
      rows: current[SELECTION_INTERNAL].materialized as readonly MaterializedRow<Record<string, unknown>>[],
    }]);
    const succeeded = committed.status === "committed" || committed.status === "queued";
    return {
      status: committed.status,
      inserted: succeeded ? inserts.length : 0,
      updated: succeeded ? updates.size : 0,
      unchanged,
      conflicted: committed.conflicts.length,
      workbooks: committed.workbooks,
      stats: mergeExecutionStats(current.stats, committed.stats),
    };
  }

  public sync(
    incoming: readonly RowAt<D, N>[],
    options: SyncOptions<RowAt<D, N>> = {},
  ): SyncResult<RowAt<D, N>> {
    return this.database.withParticipatingWriteLock(
      () => this.syncUnlocked(incoming, options),
    );
  }

  private syncUnlocked(
    incoming: readonly RowAt<D, N>[],
    options: SyncOptions<RowAt<D, N>>,
  ): SyncResult<RowAt<D, N>> {
    const definition = this.database.definition.tables[this.tableName];
    const keys = operationKeys(
      "sync",
      this.tableName,
      definition,
      options.keys as readonly string[] | undefined,
    );
    const preserve = new Set<string>(options.preserve ?? []);
    const preservedKeys = keys.filter((field) => preserve.has(field));
    if (preservedKeys.length > 0) {
      throw new GQueryRuntimeError(
        "INVALID_QUERY",
        `sync() cannot preserve key column${preservedKeys.length === 1 ? "" : "s"}: ${preservedKeys.join(", ")}.`,
        { details: { table: this.tableName, keys, preservedKeys } },
      );
    }
    const current = this.get();
    const currentByKey = indexCurrentRows(
      "sync",
      this.tableName,
      current.rows,
      keys,
    );
    const incomingByKey = new Map<string, RowAt<D, N>>();
    for (const input of incoming) {
      const fingerprint = rowFingerprint(input, keys);
      if (incomingByKey.has(fingerprint)) throw new GQueryRuntimeError("DUPLICATE_KEY", "sync input contains duplicate keys.");
      const existingIndex = currentByKey.get(fingerprint);
      const next = { ...input } as RowAt<D, N>;
      if (existingIndex !== undefined) {
        const existing = current.rows[existingIndex];
        for (const field of preserve) (next as AnyRow)[field] = existing[field];
      }
      incomingByKey.set(fingerprint, next);
    }
    const incomingKeys = new Set(incomingByKey.keys());
    const fields = Object.keys(definition.columns);
    const updates = new Map<string, RowAt<D, N>>();
    const inserts: RowAt<D, N>[] = [];
    let unchanged = 0;
    for (const [fingerprint, row] of incomingByKey) {
      const existingIndex = currentByKey.get(fingerprint);
      if (existingIndex === undefined) inserts.push(row);
      else if (rowsEqual(current.rows[existingIndex], row, fields)) unchanged += 1;
      else updates.set(fingerprint, row);
    }
    const missing = current[SELECTION_INTERNAL].materialized.filter((item) => !incomingKeys.has(rowFingerprint(item.value, keys)));
    const missingPolicy = options.missing;
    const deactivationTargets = missingPolicy?.action === "deactivate"
      ? missing.filter((item) => !Object.is(
          item.value[missingPolicy.field],
          missingPolicy.value,
        ))
      : [];
    if (missingPolicy?.action === "keep" || missingPolicy === undefined) {
      unchanged += missing.length;
    } else if (missingPolicy.action === "deactivate") {
      unchanged += missing.length - deactivationTargets.length;
    }
    const intents: UnitOfWorkIntent[] = [];
    if (updates.size > 0) {
      const materialized = current[SELECTION_INTERNAL].materialized.filter((item) => updates.has(rowFingerprint(item.value, keys)));
      const subset = new Selection(materialized, current.headers, current.stats, this.database.executor, () => this.get());
      intents.push({
        id: "sync:update",
        kind: "update",
        selection: subset as unknown as Selection<Record<string, unknown>>,
        patch: (row) => updates.get(rowFingerprint(row, keys)) ?? {},
      });
    }
    if (inserts.length > 0) {
      intents.push({ id: "sync:append", kind: "append", tableName: this.tableName, rows: inserts });
    }
    if (missing.length > 0 && options.missing?.action === "delete") {
      const subset = new Selection(missing, current.headers, current.stats, this.database.executor, () => this.get());
      intents.push({
        id: "sync:delete",
        kind: "delete",
        selection: subset as unknown as Selection<Record<string, unknown>>,
      });
    } else if (deactivationTargets.length > 0 && options.missing?.action === "deactivate") {
      const subset = new Selection(deactivationTargets, current.headers, current.stats, this.database.executor, () => this.get());
      intents.push({
        id: "sync:deactivate",
        kind: "update",
        selection: subset as unknown as Selection<Record<string, unknown>>,
        patch: { [options.missing.field]: options.missing.value },
      });
    }
    const committed = this.database.commitIntents(intents, [{
      tableName: this.tableName,
      rows: current[SELECTION_INTERNAL].materialized as readonly MaterializedRow<Record<string, unknown>>[],
    }]);
    const succeeded = committed.status === "committed" || committed.status === "queued";
    return {
      status: committed.status,
      inserted: succeeded ? inserts.length : 0,
      updated: succeeded ? updates.size : 0,
      unchanged,
      conflicted: committed.conflicts.length,
      workbooks: committed.workbooks,
      deactivated: succeeded && options.missing?.action === "deactivate" ? deactivationTargets.length : 0,
      deleted: succeeded && options.missing?.action === "delete" ? missing.length : 0,
      stats: mergeExecutionStats(current.stats, committed.stats),
    };
  }
}

export type TableHandles<D extends DatabaseDefinition> = {
  readonly [N in TableNames<D>]: TableHandle<D, N>;
};

type BatchSelections<Q extends Readonly<Record<string, Query<any, any, any, any>>>> = {
  readonly [K in keyof Q]: Q[K] extends Query<any, any, infer Row, infer WritableRow>
    ? QuerySelection<Extract<Row, AnyRow>, Extract<WritableRow, AnyRow>>
    : never;
};

export class BatchQuery<
  D extends DatabaseDefinition,
  Q extends Readonly<Record<string, Query<any, any, any, any>>>,
> {
  public constructor(
    private readonly database: GQueryDatabase<D>,
    private readonly queries: Q,
  ) {}

  public get(): BatchSelections<Q> {
    this.database.assertTransactionOpen("batch read");
    const executable: Record<string, ExecutableQuery<AnyRow>> = {};
    for (const [name, query] of Object.entries(this.queries)) executable[name] = query.executable();
    const selections = this.database.executor.executeBatch(executable).selections;
    const materialized: Record<string, Selection<AnyRow>> = {};
    for (const [name, selection] of Object.entries(selections)) {
      materialized[name] = this.database.materialize(selection);
    }
    return materialized as BatchSelections<Q>;
  }
}

export interface RawValuesApi<Sources extends SourceMap> {
  get(source: Extract<keyof Sources, string>, range: string, options?: SheetReadOptions): SheetValueRange;
  batchGet(source: Extract<keyof Sources, string>, ranges: readonly string[], options?: SheetReadOptions): SheetBatchGetResult;
  batchUpdate(
    source: Extract<keyof Sources, string>,
    updates: readonly SheetValueUpdate[],
    options?: SheetBatchUpdateOptions,
  ): SheetBatchUpdateResult;
  atomicBatchUpdate(source: Extract<keyof Sources, string>, mutations: readonly AtomicMutation[]): void;
}

export interface CreateGQueryOptions extends Omit<ExecutorOptions, "transport"> {
  readonly transport?: SheetsTransport;
  readonly canonicalState?: SchemaCanonicalState;
  readonly retry?: ScopedRetryTransportInvokerOptions;
  readonly systemHooks?: ManualEditHooks;
  readonly deferredDeadLetters?: DeferredDeadLetterSink;
  readonly deferredAppliedReceipts?: PropertyStore;
}

export interface UnitOfWorkOptions {
  readonly lock?: "auto" | "document" | "script" | SyncLock;
  readonly timeoutMs?: number;
}

export interface UnitOfWorkResult<T> extends UnitOfWorkCommitResult {
  readonly value: T;
  readonly lockWaitMs: number;
}

interface DatabaseInternals {
  readonly executor: GQueryExecutor;
  readonly transport: SheetsTransport;
  readonly selectionRuntime: SelectionRuntime;
  readonly append: (
    tableName: string,
    rows: readonly Record<string, unknown>[],
  ) => MutationResult<Record<string, unknown>>;
  readonly resolveActiveSpreadsheetId?: () => string;
  readonly generations?: RuntimeGenerationAdapter;
  readonly systemHooks?: ManualEditHooks;
  readonly deferredJournal?: DeferredJournal;
  readonly deferredDeadLetters?: DeferredDeadLetterSink;
  readonly deferredAppliedReceipts?: PropertyStore;
  readonly canonicalState?: SchemaCanonicalState;
  readonly deferredOverlay?: DeferredOverlayReader;
}

class UnitOfWorkContext implements SelectionRuntime {
  private readonly intents: UnitOfWorkIntent[] = [];
  private readonly overlays = new Map<string, Record<string, unknown>>();
  private readonly deleted = new Set<string>();
  private readonly stagedUpdates = new Map<
    string,
    Extract<UnitOfWorkIntent, { kind: "update" }>
  >();
  private readonly stagedDeletes = new Set<string>();
  private readonly cancelledIntents = new Set<UnitOfWorkIntent>();
  private readonly virtualRows = new Map<
    string,
    { readonly tableName: string; readonly value: Record<string, unknown> }
  >();
  private readonly virtualIdentityByValue = new WeakMap<Record<string, unknown>, string>();
  private readonly constraintSnapshots = new Map<string, WriteConstraintSnapshot>();
  private sequence = 0;
  private virtualSequence = 0;
  private state: "open" | "committing" | "closed" = "open";

  public constructor(private readonly executor: GQueryExecutor) {}

  public assertOpen(operation: string): void {
    if (this.state === "open") return;
    throw new GQueryRuntimeError(
      "MUTATION_INVALID",
      `The unit of work is closed; ${operation} cannot be performed through its captured transaction or selections.`,
      { details: { operation, state: this.state } },
    );
  }

  public close(): void {
    this.state = "closed";
  }

  public refresh<T extends AnyRow>(selection: Selection<T>): Selection<T> {
    this.assertOpen("refresh");
    return this.apply(this.executor.refresh(selection));
  }

  public update<T extends AnyRow>(
    selection: Selection<T>,
    patch: MutationPatch<T>,
  ): MutationResult<T> {
    this.assertOpen("update");
    this.executor.assertNoDeferredOverlayRows(
      selection[SELECTION_INTERNAL].materialized as readonly MaterializedRow<Record<string, unknown>>[],
      "stage a unit-of-work update",
    );
    const id = this.nextId("update");
    const materialized = selection[SELECTION_INTERNAL].materialized.map((item) => {
      const identity = this.identity(item.provenance);
      if (this.deleted.has(identity)) {
        throw new GQueryRuntimeError(
          "MUTATION_INVALID",
          "A row deleted earlier in the unit of work cannot be updated.",
          { details: { identity } },
        );
      }
      const virtual = this.virtualRows.get(identity);
      const baseCurrent = this.overlays.get(identity) ?? virtual?.value;
      const current = (baseCurrent === undefined
        ? item.value
        : { ...item.value, ...baseCurrent }) as T;
      const mutable = { ...current } as T;
      const returned = typeof patch === "function" ? patch(mutable) : patch;
      const proposed = (typeof patch === "function" && returned === undefined
        ? mutable
        : returned) as Partial<T>;
      // Callback patches commonly return a spread joined row. Persist only
      // actual deltas so unchanged include/join aliases never become mutation
      // columns. Object patches retain their explicit shape and are validated
      // normally by the executor at commit.
      const changes = (typeof patch === "function"
        ? Object.fromEntries(Object.entries(proposed).filter(([field, value]) =>
            !Object.prototype.hasOwnProperty.call(current, field) ||
            !logicalValueEqual(current[field], value)
          ))
        : { ...proposed }) as Partial<T>;
      const value = { ...current, ...changes } as T;
      const relationAliases = new Set(Object.keys(item.provenance.relations));
      const baseSeed = Object.fromEntries(
        Object.entries(baseCurrent ?? item.value)
          .filter(([field]) => !relationAliases.has(field)),
      );
      const baseChanges = Object.fromEntries(
        Object.entries(changes).filter(([field]) => !relationAliases.has(field)),
      );
      this.overlays.set(identity, {
        ...baseSeed,
        ...baseChanges,
      });

      if (virtual !== undefined) {
        // A staged append has no physical row to preflight. Mutate its private
        // staging copy so the eventual append contains the latest value.
        Object.assign(virtual.value, changes);
      } else {
        const existing = this.stagedUpdates.get(identity);
        if (existing !== undefined) {
          // Repeated updates to one row collapse into one physical write intent.
          Object.assign(existing.patch as Record<string, unknown>, changes);
        } else {
          const stagedSelection = new Selection(
            [item],
            selection.headers,
            selection.stats,
            this,
            selection[SELECTION_INTERNAL].refresh,
          );
          // Resolve callback patches exactly once while staging. Commit receives
          // a serializable per-row patch, so side effects and time/random-based
          // draft logic cannot run a second time with a different result.
          const intent: Extract<UnitOfWorkIntent, { kind: "update" }> = {
            id,
            kind: "update",
            selection: stagedSelection as unknown as Selection<Record<string, unknown>>,
            patch: { ...changes } as Record<string, unknown>,
          };
          this.intents.push(intent);
          this.stagedUpdates.set(identity, intent);
        }
      }
      return invalidateChangedRelations(
        { value, provenance: item.provenance },
        Object.keys(baseChanges),
      );
    });
    const after = new Selection(
      materialized,
      selection.headers,
      createExecutionStats(),
      this,
      selection[SELECTION_INTERNAL].refresh,
    );
    return {
      status: "queued",
      matchedCount: selection.length,
      changedCount: selection.length,
      changedCells: 0,
      conflicts: [],
      before: selection,
      after,
      stats: createExecutionStats(),
      receipt: {
        id,
        idempotencyKey: id,
        queuedAt: new Date().toISOString(),
        operation: "update",
        table: selection[SELECTION_INTERNAL].materialized[0]?.provenance.tableName ?? "unknown",
        keys: selection[SELECTION_INTERNAL].materialized.map((item) => item.provenance.primaryKey),
      },
    };
  }

  public delete<T extends AnyRow>(selection: Selection<T>): MutationResult<T> {
    this.assertOpen("delete");
    this.executor.assertNoDeferredOverlayRows(
      selection[SELECTION_INTERNAL].materialized as readonly MaterializedRow<Record<string, unknown>>[],
      "stage a unit-of-work delete",
    );
    const id = this.nextId("delete");
    const physical: MaterializedRow<T>[] = [];
    for (const item of selection[SELECTION_INTERNAL].materialized) {
      const identity = this.identity(item.provenance);
      if (this.deleted.has(identity)) continue;
      this.deleted.add(identity);
      const update = this.stagedUpdates.get(identity);
      if (update !== undefined) {
        this.cancelledIntents.add(update);
        this.stagedUpdates.delete(identity);
        this.overlays.delete(identity);
      }
      if (this.virtualRows.has(identity)) continue;
      if (this.stagedDeletes.has(identity)) continue;
      this.stagedDeletes.add(identity);
      physical.push(item);
    }
    if (physical.length > 0) {
      this.intents.push({
        id,
        kind: "delete",
        selection: new Selection(
          physical,
          selection.headers,
          selection.stats,
          this,
          selection[SELECTION_INTERNAL].refresh,
        ) as unknown as Selection<Record<string, unknown>>,
      });
    }
    return {
      status: "queued",
      matchedCount: selection.length,
      changedCount: selection.length,
      changedCells: 0,
      conflicts: [],
      before: selection,
      stats: createExecutionStats(),
      receipt: {
        id,
        idempotencyKey: id,
        queuedAt: new Date().toISOString(),
        operation: "delete",
        table: selection[SELECTION_INTERNAL].materialized[0]?.provenance.tableName ?? "unknown",
        keys: selection[SELECTION_INTERNAL].materialized.map((item) => item.provenance.primaryKey),
      },
    };
  }

  public append(
    tableName: string,
    rows: readonly Record<string, unknown>[],
  ): MutationResult<Record<string, unknown>> {
    this.assertOpen("append");
    const id = this.nextId("append");
    const stagedRows = rows.map((row) => ({ ...row }));
    for (const value of stagedRows) {
      this.virtualSequence += 1;
      const identity = `__gquery_uow__:-1:${-this.virtualSequence}`;
      this.virtualRows.set(identity, { tableName, value });
      this.virtualIdentityByValue.set(value, identity);
    }
    this.intents.push({ id, kind: "append", tableName, rows: stagedRows });
    return {
      status: "queued",
      matchedCount: rows.length,
      changedCount: rows.length,
      changedCells: 0,
      conflicts: [],
      stats: createExecutionStats(),
      receipt: {
        id,
        idempotencyKey: id,
        queuedAt: new Date().toISOString(),
        operation: "create",
        table: tableName,
        keys: [],
      },
    };
  }

  public apply<T extends AnyRow>(selection: Selection<T>): Selection<T> {
    this.assertOpen("read");
    const materialized = this.overlayRows(
      selection[SELECTION_INTERNAL].materialized[0]?.provenance.tableName ?? "",
      selection[SELECTION_INTERNAL].materialized,
    ) as readonly MaterializedRow<T>[];
    return new Selection(
      materialized,
      selection.headers,
      selection.stats,
      this,
      selection[SELECTION_INTERNAL].refresh,
    );
  }

  public overlayRows(
    tableName: string,
    rows: readonly MaterializedRow<Record<string, unknown>>[],
  ): readonly MaterializedRow<Record<string, unknown>>[] {
    this.assertOpen("read");
    const physical = rows
      .filter((item) => !this.deleted.has(this.identity(item.provenance)))
      .map((item) => ({
        value: this.overlays.get(this.identity(item.provenance)) ?? item.value,
        provenance: item.provenance,
      }));
    const virtual: MaterializedRow<Record<string, unknown>>[] = [];
    for (const [identity, item] of this.virtualRows) {
      if (item.tableName !== tableName || this.deleted.has(identity)) continue;
      const [, , rowIndex] = identity.split(":");
      virtual.push({
        value: item.value,
        provenance: Object.freeze({
          sourceName: "__unit_of_work__",
          spreadsheetId: "__gquery_uow__",
          tableName,
          sheetName: tableName,
          sheetId: -1,
          rowIndex: Number(rowIndex),
          primaryKey: Object.freeze({}),
          encodedPrimaryKey: Object.freeze({}),
          version: undefined,
          originalEncoded: Object.freeze({}),
          columnIndexes: Object.freeze({}),
          headerFingerprint: "__unit_of_work__",
          readAt: new Date().toISOString(),
          relations: Object.freeze({}),
          relationCardinalities: Object.freeze({}),
        }),
      });
    }
    return [...physical, ...virtual];
  }

  public rememberCompleteSnapshot(
    tableName: string,
    rows: readonly MaterializedRow<Record<string, unknown>>[],
  ): void {
    this.assertOpen("read");
    this.constraintSnapshots.set(tableName, {
      tableName,
      rows: rows.filter(
        (row) => row.provenance.spreadsheetId !== "__gquery_uow__",
      ),
    });
  }

  public commit(): UnitOfWorkCommitResult {
    this.assertOpen("commit");
    this.state = "committing";
    try {
      const active = this.intents
        .filter((intent) => !this.cancelledIntents.has(intent))
        .flatMap((intent): readonly UnitOfWorkIntent[] => {
          if (intent.kind !== "append") return [intent];
          const rows = intent.rows.filter((row) => {
            const identity = this.virtualIdentityByValue.get(row);
            return identity === undefined || !this.deleted.has(identity);
          });
          return rows.length === 0 ? [] : [{ ...intent, rows }];
        });
      return this.executor.commitUnitOfWorkWithSnapshots(
        active,
        [...this.constraintSnapshots.values()],
      );
    } finally {
      this.state = "closed";
    }
  }

  public stageIntents(
    intents: readonly UnitOfWorkIntent[],
    snapshots: readonly WriteConstraintSnapshot[] = [],
  ): void {
    this.assertOpen("stage intents");
    for (const snapshot of snapshots) {
      this.constraintSnapshots.set(snapshot.tableName, {
        tableName: snapshot.tableName,
        rows: snapshot.rows.filter(
          (row) => row.provenance.spreadsheetId !== "__gquery_uow__",
        ),
      });
    }
    for (const intent of intents) {
      if (intent.kind === "update") {
        this.update(intent.selection, intent.patch);
      } else if (intent.kind === "delete") {
        this.delete(intent.selection);
      } else {
        this.append(intent.tableName, intent.rows);
      }
    }
  }

  private nextId(kind: string): string {
    this.sequence += 1;
    return `uow:${kind}:${this.sequence}`;
  }

  private identity(provenance: { spreadsheetId: string; sheetId: number; rowIndex: number }): string {
    return `${provenance.spreadsheetId}:${provenance.sheetId}:${provenance.rowIndex}`;
  }
}

function nativeLock(kind: "auto" | "document" | "script"): SyncLock | null {
  if (typeof LockService === "undefined") return null;
  const lock = kind === "script"
    ? LockService.getScriptLock()
    : kind === "document"
      ? LockService.getDocumentLock()
      : LockService.getDocumentLock() ?? LockService.getScriptLock();
  if (lock === null) return null;
  return {
    tryAcquire: (timeoutMs) => lock.tryLock(timeoutMs),
    release: () => lock.releaseLock(),
  };
}

export class GQueryDatabase<D extends DatabaseDefinition> {
  public readonly executor: GQueryExecutor;
  public readonly tables: TableHandles<D>;
  public readonly raw: { readonly values: RawValuesApi<D["sources"]> };
  public readonly schema: SchemaManager;
  public readonly system: SystemManager;
  public readonly deferred: DeferredManager;
  public readonly cache: CacheInvalidationApi<D>;
  private readonly selectionRuntime: SelectionRuntime;
  private readonly appendOperation: DatabaseInternals["append"];
  private readonly transport: SheetsTransport;
  private readonly activeResolver?: () => string;
  private readonly generations?: RuntimeGenerationAdapter;
  private readonly systemHooks?: ManualEditHooks;
  private readonly deferredJournal?: DeferredJournal;
  private readonly deferredDeadLetters?: DeferredDeadLetterSink;
  private readonly deferredAppliedReceipts?: PropertyStore;
  private readonly canonicalState: SchemaCanonicalState;
  private readonly deferredOverlay?: DeferredOverlayReader;

  public constructor(
    public readonly definition: D,
    options: CreateGQueryOptions = {},
    internals?: DatabaseInternals,
  ) {
    let defaultScope: ScopedRetryTransportInvoker | undefined;
    let transport = internals?.transport ?? options.transport;
    if (transport === undefined) {
      defaultScope = new ScopedRetryTransportInvoker(new RetryController(), options.retry);
      transport = new AppsScriptSheetsTransport({ invoker: defaultScope });
    }
    this.transport = transport;
    this.activeResolver = internals?.resolveActiveSpreadsheetId ?? options.resolveActiveSpreadsheetId;
    let cacheForScope = options.cacheForScope;
    let generations = options.generations;
    let scopeIdentity = options.scopeIdentity;
    let deferredJournal = internals?.deferredJournal ?? options.deferredJournal;
    let deferredOverlay = internals?.deferredOverlay ?? options.deferredOverlay;
    const canonicalState = internals?.canonicalState ?? options.canonicalState ?? (
      internals === undefined && options.transport === undefined
        ? new AppsScriptSchemaCanonicalState()
        : new InMemorySchemaCanonicalState()
    );
    if (internals === undefined && options.transport === undefined) {
      const configuredCache = Object.values(definition.tables).some((table) => table.cache !== undefined);
      generations ??= createAppsScriptGenerationStore();
      if (deferredJournal === undefined) {
        const defaultDeferredOverlay = new ChunkedDeferredOverlay(
          createAppsScriptChunkedCache({ scope: "script" }),
        );
        deferredOverlay = defaultDeferredOverlay;
        deferredJournal = createAppsScriptDeferredJournal({}, defaultDeferredOverlay);
      }
      if (configuredCache) {
        const caches = new Map<AppsScriptCacheScope, ChunkedCache>();
        cacheForScope ??= (scope) => {
          let cache = caches.get(scope);
          if (cache === undefined) {
            cache = createAppsScriptChunkedCache({ scope });
            caches.set(scope, cache);
          }
          return cache;
        };
        scopeIdentity ??= (scope) => {
          if (scope === "user") return Session.getTemporaryActiveUserKey();
          if (scope === "document") return this.activeResolver?.() ?? SpreadsheetApp.getActiveSpreadsheet().getId();
          return ScriptApp.getScriptId();
        };
      }
    }
    if (internals === undefined) {
      const configuredCache = Object.values(definition.tables).some((table) => table.cache !== undefined);
      const injectedCache = options.cache !== undefined || options.cacheForScope !== undefined;
      if (configuredCache && injectedCache && generations === undefined) {
        throw new GQueryDefinitionError(
          "Injected caches require a durable generation adapter so committed writes cannot leave old entries reachable.",
        );
      }
      const identityScopedCache = Object.values(definition.tables).some((table) =>
        table.cache?.scope === "document" || table.cache?.scope === "user"
      );
      if (configuredCache && injectedCache && identityScopedCache && scopeIdentity === undefined) {
        throw new GQueryDefinitionError(
          "Document- and user-scoped injected caches require a scopeIdentity resolver.",
        );
      }
      if (scopeIdentity !== undefined) {
        const resolveScopeIdentity = scopeIdentity;
        scopeIdentity = (scope) => {
          const identity = resolveScopeIdentity(scope);
          if (scope !== "script" && (identity === null || identity.trim().length === 0)) {
            throw new GQueryRuntimeError(
              "SOURCE_UNAVAILABLE",
              `Cache scope ${scope} did not resolve to a non-empty identity.`,
            );
          }
          return identity;
        };
      }
    }
    this.executor = internals?.executor ?? new GQueryExecutor(definition, {
      ...options,
      transport,
      executionScope: options.executionScope ?? defaultScope,
      cacheForScope,
      generations,
      scopeIdentity,
      deferredJournal,
      deferredOverlay,
      canonicalState,
    });
    this.generations = internals?.generations ?? generations;
    this.systemHooks = internals?.systemHooks ?? options.systemHooks;
    this.deferredJournal = deferredJournal;
    this.deferredDeadLetters = internals?.deferredDeadLetters ?? options.deferredDeadLetters;
    this.deferredAppliedReceipts = internals?.deferredAppliedReceipts ?? options.deferredAppliedReceipts;
    this.canonicalState = canonicalState;
    this.deferredOverlay = deferredOverlay;
    this.selectionRuntime = internals?.selectionRuntime ?? this.executor;
    this.appendOperation = internals?.append ?? ((tableName, rows) => this.executor.append(tableName, rows));
    const tables: Partial<TableHandles<D>> = {};
    for (const tableName of Object.keys(definition.tables) as TableNames<D>[]) {
      (tables as Record<string, unknown>)[tableName] = new TableHandle(this, tableName);
    }
    this.tables = Object.freeze(tables as TableHandles<D>);
    this.raw = Object.freeze({ values: this.createRawValues(transport, this.activeResolver) });
    this.cache = Object.freeze(new CacheInvalidationManager({
      definition,
      generations: this.generations,
      resolveSourceId: (sourceName) => this.resolveSourceId(sourceName, this.activeResolver),
    }));
    this.schema = new SchemaManager({
      definition,
      transport,
      canonicalState,
      resolveSourceId: (sourceName) => this.resolveSourceId(sourceName as Extract<keyof D["sources"], string>, this.activeResolver),
      invalidateStructure: (spreadsheetId) => this.executor.invalidateStructure(spreadsheetId),
      invalidateTable: (spreadsheetId, tableName) => {
        this.generations?.invalidateTable(spreadsheetId, tableName);
      },
    });
    this.system = new SystemManager({
      definition,
      transport,
      executor: this.executor,
      generations: this.generations,
      resolveSourceId: (sourceName) => this.resolveSourceId(sourceName as Extract<keyof D["sources"], string>, this.activeResolver),
    }, this.systemHooks);
    this.deferred = new DeferredManager({
      definition,
      resolveSourceId: (sourceName) => this.resolveSourceId(
        sourceName as Extract<keyof D["sources"], string>,
        this.activeResolver,
      ),
      find: (tableName, key) => {
        const handle = (this.tables as unknown as Record<string, TableHandle<D, TableNames<D>>>)[tableName];
        if (handle === undefined) throw new GQueryRuntimeError("INVALID_QUERY", `Unknown deferred table ${tableName}.`);
        return this.executor.withoutDeferredOverlay(
          () => handle.find(key) as unknown as Selection<Record<string, unknown>>,
        );
      },
      append: (tableName, row) => {
        const handle = (this.tables as unknown as Record<string, TableHandle<D, TableNames<D>>>)[tableName];
        if (handle === undefined) throw new GQueryRuntimeError("INVALID_QUERY", `Unknown deferred table ${tableName}.`);
        return handle.append(row as RowAt<D, TableNames<D>>) as MutationResult<Record<string, unknown>>;
      },
      batchRead: (tableNames) => {
        const executable: Record<string, ExecutableQuery<Record<string, unknown>>> = Object.create(null);
        for (const tableName of new Set(tableNames)) {
          const handle = (this.tables as unknown as Record<string, TableHandle<D, TableNames<D>>>)[tableName];
          if (handle === undefined) {
            throw new GQueryRuntimeError("INVALID_QUERY", `Unknown deferred table ${tableName}.`);
          }
          executable[tableName] = handle.executable() as unknown as ExecutableQuery<Record<string, unknown>>;
        }
        return this.executor.withoutDeferredOverlay(() =>
          this.executor.withoutReadCache(() => this.executor.executeBatch(executable).selections)
        );
      },
      commitBatch: (intents, snapshots) => this.executor.withoutDeferredOverlay(() =>
        this.executor.withoutReadCache(() =>
          this.executor.commitUnitOfWorkAfterPhysicalRead(intents, snapshots)
        )
      ),
      withWriteLock: (operation) => {
        const lock = nativeLock("auto");
        if (lock === null) return operation();
        if (!lock.tryAcquire(30_000)) {
          throw new GQueryRuntimeError(
            "MUTATION_CONFLICT",
            "Could not acquire the deferred flush write lock within 30000ms.",
          );
        }
        try {
          return operation();
        } finally {
          lock.release();
        }
      },
      withoutDeferredGuard: (operation) => this.executor.withoutDeferredOverlay(operation),
    }, {
      journal: this.deferredJournal,
      deadLetters: this.deferredDeadLetters,
      appliedReceipts: this.deferredAppliedReceipts,
    });
  }

  public batch<const Q extends Readonly<Record<string, Query<any, any, any, any>>>>(
    queries: Q,
  ): BatchQuery<D, Q> {
    return new BatchQuery(this, Object.freeze({ ...queries }) as Q);
  }

  /** Internal lifecycle gate shared by transaction-backed handles. */
  public assertTransactionOpen(operation: string): void {
    if (this.selectionRuntime instanceof UnitOfWorkContext) {
      this.selectionRuntime.assertOpen(operation);
    }
  }

  public decorateExecutable<T extends AnyRow>(query: ExecutableQuery<T>): ExecutableQuery<T> {
    if (!(this.selectionRuntime instanceof UnitOfWorkContext)) return query;
    this.assertTransactionOpen("read");
    const capturesCompleteBase = query.plan.predicate === undefined &&
      query.localPredicates.length === 0 &&
      query.plan.limit === undefined &&
      query.plan.offset === undefined &&
      query.plan.tail === undefined;
    return {
      ...query,
      overlayRows: (tableName, rows) => {
        if (!(this.selectionRuntime instanceof UnitOfWorkContext)) return rows;
        if (capturesCompleteBase && tableName === query.plan.table) {
          this.selectionRuntime.rememberCompleteSnapshot(tableName, rows);
        }
        return this.selectionRuntime.overlayRows(tableName, rows);
      },
    };
  }

  public materialize<T extends AnyRow>(selection: Selection<T>): Selection<T> {
    if (this.selectionRuntime === this.executor) return selection;
    if (this.selectionRuntime instanceof UnitOfWorkContext) {
      this.selectionRuntime.assertOpen("read");
    }
    return new Selection(
      selection[SELECTION_INTERNAL].materialized,
      selection.headers,
      selection.stats,
      this.selectionRuntime,
      selection[SELECTION_INTERNAL].refresh,
    );
  }

  public appendRows<T extends AnyRow>(tableName: string, rows: readonly T[]): MutationResult<T> {
    if (this.selectionRuntime instanceof UnitOfWorkContext) {
      this.selectionRuntime.assertOpen("append");
    }
    return this.appendOperation(tableName, rows) as MutationResult<T>;
  }

  public deferKeyedWrite<T extends AnyRow>(
    tableName: string,
    row: T,
    kind: "create" | "upsert",
    options: Pick<MutationOptions, "idempotencyKey" | "actor">,
  ): MutationResult<T> {
    if (this.selectionRuntime instanceof UnitOfWorkContext) {
      this.selectionRuntime.assertOpen("queue a deferred write");
      throw new GQueryRuntimeError(
        "MUTATION_INVALID",
        "Deferred delivery cannot be staged inside unitOfWork().",
      );
    }
    return this.executor.deferKeyedWrite(tableName, row, kind, options) as MutationResult<T>;
  }

  public commitIntents(
    intents: readonly UnitOfWorkIntent[],
    constraintSnapshots: readonly WriteConstraintSnapshot[] = [],
  ): Omit<UnitOfWorkCommitResult, "status"> & {
    readonly status: UnitOfWorkCommitResult["status"] | "queued";
  } {
    if (this.selectionRuntime instanceof UnitOfWorkContext) {
      this.selectionRuntime.assertOpen("stage intents");
      this.selectionRuntime.stageIntents(intents, constraintSnapshots);
      return {
        status: "queued",
        conflicts: [],
        workbooks: [],
        stats: createExecutionStats(),
      };
    }
    return this.executor.commitUnitOfWorkWithSnapshots(intents, constraintSnapshots);
  }

  /**
   * Serialize read-modify-write helpers with the same participating-writer lock
   * used by units of work. Transaction-backed handles already run under their
   * outer lock and therefore execute directly.
   */
  public withParticipatingWriteLock<T>(operation: () => T, timeoutMs = 30_000): T {
    if (this.selectionRuntime instanceof UnitOfWorkContext) {
      this.selectionRuntime.assertOpen("run a read-modify-write operation");
      return operation();
    }
    const lock = nativeLock("auto");
    if (lock === null) return operation();
    if (!lock.tryAcquire(timeoutMs)) {
      throw new GQueryRuntimeError(
        "MUTATION_CONFLICT",
        `Could not acquire the participating-writer lock within ${timeoutMs}ms.`,
      );
    }
    try {
      return operation();
    } finally {
      lock.release();
    }
  }

  public unitOfWork<T>(
    options: UnitOfWorkOptions,
    callback: (transaction: GQuery<D>) => T,
  ): UnitOfWorkResult<T>;
  public unitOfWork<T>(callback: (transaction: GQuery<D>) => T): UnitOfWorkResult<T>;
  public unitOfWork<T>(
    optionsOrCallback: UnitOfWorkOptions | ((transaction: GQuery<D>) => T),
    maybeCallback?: (transaction: GQuery<D>) => T,
  ): UnitOfWorkResult<T> {
    if (this.selectionRuntime instanceof UnitOfWorkContext) {
      this.selectionRuntime.assertOpen("start a nested unit of work");
      throw new GQueryRuntimeError(
        "MUTATION_INVALID",
        "Nested units of work are not supported.",
      );
    }
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (callback === undefined) throw new TypeError("unitOfWork() requires a callback.");
    const timeoutMs = options.timeoutMs ?? 30_000;
    const lock = typeof options.lock === "object"
      ? options.lock
      : nativeLock(options.lock ?? "auto");
    const lockStartedAt = Date.now();
    if (lock !== null && !lock.tryAcquire(timeoutMs)) {
      throw new GQueryRuntimeError("MUTATION_CONFLICT", `Could not acquire the unit-of-work lock within ${timeoutMs}ms.`);
    }
    const lockWaitMs = Date.now() - lockStartedAt;
    let context: UnitOfWorkContext | undefined;
    try {
      const activeContext = new UnitOfWorkContext(this.executor);
      context = activeContext;
      const transaction = attachTableProperties(new GQueryDatabase(this.definition, {}, {
        executor: this.executor,
        transport: this.transport,
        selectionRuntime: activeContext,
        append: (tableName, rows) => activeContext.append(tableName, rows),
        resolveActiveSpreadsheetId: this.activeResolver,
        generations: this.generations,
        systemHooks: this.systemHooks,
        deferredJournal: this.deferredJournal,
        deferredDeadLetters: this.deferredDeadLetters,
        deferredAppliedReceipts: this.deferredAppliedReceipts,
        canonicalState: this.canonicalState,
        deferredOverlay: this.deferredOverlay,
      })) as GQuery<D>;
      const value = callback(transaction);
      if (isThenable(value)) {
        throw new GQueryRuntimeError(
          "UNSUPPORTED_OPERATION",
          "unitOfWork() callbacks must complete synchronously and cannot return a Promise or thenable.",
        );
      }
      const committed = activeContext.commit();
      return {
        ...committed,
        value,
        lockWaitMs,
        stats: { ...committed.stats, lockWaitMs },
      };
    } finally {
      context?.close();
      lock?.release();
    }
  }

  public resolveSourceId(sourceName: Extract<keyof D["sources"], string>, resolver?: () => string): string {
    if (this.selectionRuntime instanceof UnitOfWorkContext) {
      this.selectionRuntime.assertOpen("resolve a source");
    }
    const source = this.definition.sources[sourceName];
    if (source.kind === "spreadsheet-id") return source.spreadsheetId;
    try {
      return resolver?.() ?? SpreadsheetApp.getActiveSpreadsheet().getId();
    } catch (cause) {
      throw new GQueryRuntimeError("SOURCE_UNAVAILABLE", "The active spreadsheet source is unavailable.", { cause });
    }
  }

  private createRawValues(
    transport: SheetsTransport,
    resolver?: () => string,
  ): RawValuesApi<D["sources"]> {
    type SourceName = Extract<keyof D["sources"], string>;
    const api: RawValuesApi<D["sources"]> = {
      get: (sourceName: SourceName, range: string, readOptions?: SheetReadOptions) =>
        transport.get(this.resolveSourceId(sourceName, resolver), range, readOptions),
      batchGet: (sourceName: SourceName, ranges: readonly string[], readOptions?: SheetReadOptions) =>
        transport.batchGet(this.resolveSourceId(sourceName, resolver), ranges, readOptions),
      batchUpdate: (
        sourceName: SourceName,
        updates: readonly SheetValueUpdate[],
        writeOptions?: SheetBatchUpdateOptions,
      ) => {
        if (this.selectionRuntime instanceof UnitOfWorkContext) {
          throw new GQueryRuntimeError(
            "UNSUPPORTED_OPERATION",
            "raw.values writes cannot run inside unitOfWork(); use typed staged mutations.",
          );
        }
        return transport.batchUpdate(this.resolveSourceId(sourceName, resolver), updates, writeOptions);
      },
      atomicBatchUpdate: (sourceName: SourceName, mutations: readonly AtomicMutation[]) => {
        if (this.selectionRuntime instanceof UnitOfWorkContext) {
          throw new GQueryRuntimeError(
            "UNSUPPORTED_OPERATION",
            "raw.values writes cannot run inside unitOfWork(); use typed staged mutations.",
          );
        }
        transport.atomicBatchUpdate(this.resolveSourceId(sourceName, resolver), mutations);
      },
    };
    return Object.freeze(api);
  }
}

export type GQuery<D extends DatabaseDefinition> = GQueryDatabase<D> & TableHandles<D>;

/** Create lazy typed table handles without opening any spreadsheet. */
export function createGQuery<const D extends DatabaseDefinition>(
  definition: D,
  options: CreateGQueryOptions = {},
): GQuery<D> {
  return attachTableProperties(new GQueryDatabase(definition, options)) as GQuery<D>;
}

function attachTableProperties<D extends DatabaseDefinition>(
  database: GQueryDatabase<D>,
): GQueryDatabase<D> & TableHandles<D> {
  const definition = database.definition;
  for (const tableName of Object.keys(definition.tables) as TableNames<D>[]) {
    if (isReservedTablePropertyName(tableName) || tableName in database) {
      throw new GQueryRuntimeError(
        "INVALID_QUERY",
        `Table name ${tableName} is reserved. Use a different schema property name.`,
      );
    }
    Object.defineProperty(database, tableName, {
      value: database.tables[tableName],
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return database as GQueryDatabase<D> & TableHandles<D>;
}
