import { type ExecutionPlan, type ExecutionStats } from "./execution";
import { type SerializableQueryPlan } from "./query";
import { Selection, type DeleteOptions, type MutationConflict, type MutationOptions, type MutationPatch, type MutationResult, type SelectionRuntime } from "./selection";
import type { DatabaseDefinition } from "./schema";
import { type SheetsTransport } from "./transport";
import type { DeferredJournal } from "./infrastructure/deferred";
export interface ExecutableQuery<T extends Record<string, unknown>> {
    readonly plan: SerializableQueryPlan;
    readonly localPredicates: readonly ((row: Readonly<T>) => boolean)[];
    readonly refresh: () => Selection<T>;
}
export interface RuntimeCacheAdapter {
    read<T>(key: unknown): {
        readonly state: "hit" | "miss" | "corrupt";
        readonly value?: T;
    };
    put<T>(key: unknown, value: T, policy?: {
        ttlSeconds?: number;
        jitterSeconds?: number;
    }): void;
}
export interface RuntimeGenerationAdapter {
    current(dependency: {
        readonly kind: "table";
        readonly sourceId: string;
        readonly table: string;
    }): string;
    invalidateTable(sourceId: string, table: string): string;
    invalidateRow?(sourceId: string, table: string, key: unknown): string;
}
export interface ExecutorOptions {
    readonly transport: SheetsTransport;
    readonly resolveActiveSpreadsheetId?: () => string;
    readonly now?: () => Date;
    readonly cache?: RuntimeCacheAdapter;
    readonly cacheForScope?: (scope: "script" | "document" | "user") => RuntimeCacheAdapter;
    readonly generations?: RuntimeGenerationAdapter;
    readonly scopeIdentity?: (scope: "script" | "document" | "user") => string | null;
    readonly deferredJournal?: DeferredJournal;
    readonly executionScope?: {
        run<T>(operation: () => T): T;
    };
}
export interface QueryExecution<T extends Record<string, unknown>> {
    readonly selection: Selection<T>;
    readonly plan: ExecutionPlan;
}
export type UnitOfWorkIntent = {
    readonly id: string;
    readonly kind: "update";
    readonly selection: Selection<Record<string, unknown>>;
    readonly patch: MutationPatch<Record<string, unknown>>;
} | {
    readonly id: string;
    readonly kind: "delete";
    readonly selection: Selection<Record<string, unknown>>;
} | {
    readonly id: string;
    readonly kind: "append";
    readonly tableName: string;
    readonly rows: readonly Record<string, unknown>[];
};
export interface WorkbookCommitReceipt {
    readonly spreadsheetId: string;
    readonly status: "committed" | "failed";
    readonly requestCount: number;
    readonly error?: unknown;
}
export interface UnitOfWorkCommitResult {
    readonly status: "committed" | "conflicted" | "partial";
    readonly conflicts: readonly MutationConflict[];
    readonly workbooks: readonly WorkbookCommitReceipt[];
    readonly stats: ExecutionStats;
}
/** Purely synchronous schema/query executor over an injectable Sheets transport. */
export declare class GQueryExecutor implements SelectionRuntime {
    private readonly schema;
    private readonly options;
    private readonly metadata;
    private readonly headers;
    private readonly locators;
    private readonly now;
    constructor(schema: DatabaseDefinition, options: ExecutorOptions);
    execute<T extends Record<string, unknown>>(query: ExecutableQuery<T>): QueryExecution<T>;
    executeBatch(queries: Readonly<Record<string, ExecutableQuery<Record<string, unknown>>>>): {
        readonly selections: Readonly<Record<string, Selection<Record<string, unknown>>>>;
        readonly plans: Readonly<Record<string, ExecutionPlan>>;
    };
    private executeBatchUnscoped;
    explain<T extends Record<string, unknown>>(query: ExecutableQuery<T>, executedMode?: "bounded" | "full-scan"): ExecutionPlan;
    refresh<T extends Record<string, unknown>>(selection: Selection<T>): Selection<T>;
    update<T extends Record<string, unknown>>(selection: Selection<T>, patch: MutationPatch<T>, options?: MutationOptions): MutationResult<T>;
    private updateUnscoped;
    delete<T extends Record<string, unknown>>(selection: Selection<T>, options?: DeleteOptions): MutationResult<T>;
    private deleteUnscoped;
    append(tableName: string, rows: readonly Record<string, unknown>[]): MutationResult<Record<string, unknown>>;
    private appendUnscoped;
    /** Compile staged operations and commit each workbook in one atomic batch. */
    commitUnitOfWork(intents: readonly UnitOfWorkIntent[]): UnitOfWorkCommitResult;
    private commitUnitOfWorkUnscoped;
    invalidateTable(spreadsheetId: string, tableName: string): void;
    invalidateStructure(spreadsheetId: string): void;
    private emptyMutation;
    private scoped;
    private deferUpdate;
    private deferDelete;
    private prepareUpdates;
    private deleteRelationEdges;
    private reachableDeleteEdges;
    private loadDeleteRelationRows;
    private planReferentialDelete;
    private uniqueMaterialized;
    private prepareAppend;
    private recordTouched;
    private table;
    private source;
    private sourceIdentity;
    private spreadsheetId;
    private resolveTable;
    private parseHeader;
    private parseSnapshot;
    private requireSnapshot;
    private cacheForTable;
    private indexForQuery;
    private tryBoundedRead;
    private scanLocator;
    private loadLocatedRows;
    private locatorKey;
    private registerLocators;
    private clearTableLocators;
    private tableCacheKey;
    private preflight;
    private assertSingleMutationTable;
    private groupPatchesBySpreadsheet;
    private sheetName;
    private invalidateMaterialized;
}
