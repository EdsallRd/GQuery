import { GQueryExecutor, type ExecutableQuery, type ExecutorOptions, type RuntimeGenerationAdapter, type UnitOfWorkCommitResult, type WorkbookCommitReceipt } from "./executor";
import { type ExecutionPlan, type ExecutionStats } from "./execution";
import { type JoinCardinality, type JoinKind, type SerializableQueryPlan, type SortDirection, type Where } from "./query";
import { Selection, type DeleteOptions, type MutationOptions, type MutationPatch, type MutationResult, type SelectionRuntime } from "./selection";
import type { DatabaseDefinition, InferTableRow, RelationDefinition, RelationMap, SourceMap, TableDefinition } from "./schema";
import { type AtomicMutation, type SheetBatchGetResult, type SheetBatchUpdateOptions, type SheetBatchUpdateResult, type SheetReadOptions, type SheetValueRange, type SheetValueUpdate, type SheetsTransport } from "./transport";
import type { SyncLock } from "./infrastructure/runtime";
import { type ScopedRetryTransportInvokerOptions } from "./infrastructure/retry-transport";
import { SchemaManager } from "./management";
import { SystemManager } from "./system-manager";
import type { ManualEditHooks } from "./infrastructure/system";
import { DeferredManager } from "./deferred-manager";
import { type DeferredDeadLetterSink, type DeferredJournal } from "./infrastructure/deferred";
import type { PropertyStore } from "./infrastructure/runtime";
type AnyRow = Record<string, unknown>;
type TableNames<D extends DatabaseDefinition> = Extract<keyof D["tables"], string>;
type TableAt<D extends DatabaseDefinition, N extends TableNames<D>> = D["tables"][N];
export type RowAt<D extends DatabaseDefinition, N extends TableNames<D>> = Extract<InferTableRow<TableAt<D, N>>, AnyRow>;
type RelationsAt<D extends DatabaseDefinition, N extends TableNames<D>> = TableAt<D, N> extends TableDefinition<infer _Columns, infer _Source, infer _Primary, infer Relations, infer _Unique> ? Relations : RelationMap;
type RelationTarget<R> = R extends RelationDefinition<infer _Kind, infer Target, infer _Local, infer _Foreign> ? Target : never;
type RelationValue<D extends DatabaseDefinition, R> = RelationTarget<R> extends TableNames<D> ? R extends RelationDefinition<"has-many"> ? readonly RowAt<D, Extract<RelationTarget<R>, TableNames<D>>>[] : RowAt<D, Extract<RelationTarget<R>, TableNames<D>>> | null : never;
export type IncludedRow<D extends DatabaseDefinition, N extends TableNames<D>, Row extends AnyRow, R extends Extract<keyof RelationsAt<D, N>, string>> = Row & {
    readonly [Name in R]: RelationValue<D, RelationsAt<D, N>[Name]>;
};
export interface JoinOptions<Row extends AnyRow, OtherRow extends AnyRow, Alias extends string> {
    readonly as: Alias;
    readonly on: {
        readonly local: Extract<keyof Row, string> | readonly Extract<keyof Row, string>[];
        readonly foreign: Extract<keyof OtherRow, string> | readonly Extract<keyof OtherRow, string>[];
    };
    readonly kind?: JoinKind;
    readonly cardinality?: JoinCardinality;
    readonly select?: readonly Extract<keyof OtherRow, string>[];
}
export interface Group<T extends AnyRow> {
    readonly key: Readonly<Partial<T>>;
    readonly rows: readonly Readonly<T>[];
    readonly count: number;
}
export interface UpsertResult<T extends AnyRow> {
    readonly status: "committed" | "conflicted" | "partial";
    readonly inserted: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly conflicted: number;
    readonly workbooks: readonly WorkbookCommitReceipt[];
    readonly update?: MutationResult<T>;
    readonly insert?: MutationResult<T>;
    readonly stats: ExecutionStats;
}
export interface SyncOptions<T extends AnyRow> {
    readonly keys?: readonly Extract<keyof T, string>[];
    readonly preserve?: readonly Extract<keyof T, string>[];
    readonly missing?: {
        readonly action: "keep";
    } | {
        readonly action: "delete";
    } | {
        readonly action: "deactivate";
        readonly field: Extract<keyof T, string>;
        readonly value: T[Extract<keyof T, string>];
    };
}
export interface SyncResult<T extends AnyRow> extends UpsertResult<T> {
    readonly deactivated: number;
    readonly deleted: number;
}
/** An immutable query handle. Every chain method returns a new instance. */
export declare class Query<D extends DatabaseDefinition, N extends TableNames<D>, Row extends AnyRow = RowAt<D, N>> {
    protected readonly database: GQueryDatabase<D>;
    readonly tableName: N;
    protected readonly plan: SerializableQueryPlan;
    protected readonly localPredicates: readonly ((row: Readonly<Row>) => boolean)[];
    constructor(database: GQueryDatabase<D>, tableName: N, plan: SerializableQueryPlan, localPredicates?: readonly ((row: Readonly<Row>) => boolean)[]);
    protected next<NextRow extends AnyRow = Row>(plan: SerializableQueryPlan, localPredicates?: readonly ((row: Readonly<NextRow>) => boolean)[]): Query<D, N, NextRow>;
    all(): Query<D, N, Row>;
    where(predicate: Where<Row>): Query<D, N, Row>;
    whereLocal(predicate: (row: Readonly<Row>) => boolean): Query<D, N, Row>;
    select<const Fields extends readonly Extract<keyof Row, string>[]>(fields: Fields): Query<D, N, Pick<Row, Fields[number]> & AnyRow>;
    orderBy(field: Extract<keyof Row, string>, direction?: SortDirection): Query<D, N, Row>;
    limit(value: number): Query<D, N, Row>;
    offset(value: number): Query<D, N, Row>;
    tail(value: number): Query<D, N, Row>;
    include<RelationName extends Extract<keyof RelationsAt<D, N>, string>>(name: RelationName): Query<D, N, IncludedRow<D, N, Row, RelationName>>;
    join<OtherName extends TableNames<D>, const Alias extends string>(other: TableHandle<D, OtherName>, options: JoinOptions<Row, RowAt<D, OtherName>, Alias>): Query<D, N, Row & {
        readonly [Key in Alias]: RowAt<D, OtherName> | readonly RowAt<D, OtherName>[] | null;
    }>;
    get(): Selection<Row>;
    findOne(): Selection<Row>;
    maybeOne(): Selection<Row>;
    find(key: unknown): Selection<Row>;
    count(): number;
    exists(): boolean;
    groupBy(fields: readonly Extract<keyof Row, string>[]): readonly Group<Row>[];
    update(patch: MutationPatch<Row>, options?: MutationOptions): MutationResult<Row>;
    delete(options?: DeleteOptions): MutationResult<Row>;
    explain(): ExecutionPlan;
    executable(): ExecutableQuery<Row>;
}
export declare class TableHandle<D extends DatabaseDefinition, N extends TableNames<D>> extends Query<D, N, RowAt<D, N>> {
    constructor(database: GQueryDatabase<D>, tableName: N);
    append(row: RowAt<D, N>): MutationResult<RowAt<D, N>>;
    appendMany(rows: readonly RowAt<D, N>[]): MutationResult<RowAt<D, N>>;
    upsertMany(incoming: readonly RowAt<D, N>[], options?: {
        readonly keys?: readonly Extract<keyof RowAt<D, N>, string>[];
    }): UpsertResult<RowAt<D, N>>;
    sync(incoming: readonly RowAt<D, N>[], options?: SyncOptions<RowAt<D, N>>): SyncResult<RowAt<D, N>>;
}
export type TableHandles<D extends DatabaseDefinition> = {
    readonly [N in TableNames<D>]: TableHandle<D, N>;
};
type BatchSelections<Q extends Readonly<Record<string, Query<any, any, any>>>> = {
    readonly [K in keyof Q]: Q[K] extends Query<any, any, infer Row> ? Selection<Extract<Row, AnyRow>> : never;
};
export declare class BatchQuery<D extends DatabaseDefinition, Q extends Readonly<Record<string, Query<any, any, any>>>> {
    private readonly database;
    private readonly queries;
    constructor(database: GQueryDatabase<D>, queries: Q);
    get(): BatchSelections<Q>;
}
export interface RawValuesApi<Sources extends SourceMap> {
    get(source: Extract<keyof Sources, string>, range: string, options?: SheetReadOptions): SheetValueRange;
    batchGet(source: Extract<keyof Sources, string>, ranges: readonly string[], options?: SheetReadOptions): SheetBatchGetResult;
    batchUpdate(source: Extract<keyof Sources, string>, updates: readonly SheetValueUpdate[], options?: SheetBatchUpdateOptions): SheetBatchUpdateResult;
    atomicBatchUpdate(source: Extract<keyof Sources, string>, mutations: readonly AtomicMutation[]): void;
}
export interface CreateGQueryOptions extends Omit<ExecutorOptions, "transport"> {
    readonly transport?: SheetsTransport;
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
    readonly append: (tableName: string, rows: readonly Record<string, unknown>[]) => MutationResult<Record<string, unknown>>;
    readonly resolveActiveSpreadsheetId?: () => string;
    readonly generations?: RuntimeGenerationAdapter;
    readonly systemHooks?: ManualEditHooks;
    readonly deferredJournal?: DeferredJournal;
    readonly deferredDeadLetters?: DeferredDeadLetterSink;
    readonly deferredAppliedReceipts?: PropertyStore;
}
export declare class GQueryDatabase<D extends DatabaseDefinition> {
    readonly definition: D;
    readonly executor: GQueryExecutor;
    readonly tables: TableHandles<D>;
    readonly raw: {
        readonly values: RawValuesApi<D["sources"]>;
    };
    readonly schema: SchemaManager;
    readonly system: SystemManager;
    readonly deferred: DeferredManager;
    private readonly selectionRuntime;
    private readonly appendOperation;
    private readonly transport;
    private readonly activeResolver?;
    private readonly generations?;
    private readonly systemHooks?;
    private readonly deferredJournal?;
    private readonly deferredDeadLetters?;
    private readonly deferredAppliedReceipts?;
    constructor(definition: D, options?: CreateGQueryOptions, internals?: DatabaseInternals);
    batch<const Q extends Readonly<Record<string, Query<any, any, any>>>>(queries: Q): BatchQuery<D, Q>;
    materialize<T extends AnyRow>(selection: Selection<T>): Selection<T>;
    appendRows<T extends AnyRow>(tableName: string, rows: readonly T[]): MutationResult<T>;
    unitOfWork<T>(options: UnitOfWorkOptions, callback: (transaction: GQuery<D>) => T): UnitOfWorkResult<T>;
    unitOfWork<T>(callback: (transaction: GQuery<D>) => T): UnitOfWorkResult<T>;
    resolveSourceId(sourceName: Extract<keyof D["sources"], string>, resolver?: () => string): string;
    private createRawValues;
}
export type GQuery<D extends DatabaseDefinition> = GQueryDatabase<D> & TableHandles<D>;
/** Create lazy typed table handles without opening any spreadsheet. */
export declare function createGQuery<const D extends DatabaseDefinition>(definition: D, options?: CreateGQueryOptions): GQuery<D>;
export {};
