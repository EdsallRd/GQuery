import { type ExecutionPlan, type ExecutionStats } from "./execution";
import { type SerializableQueryPlan } from "./query";
import { type MaterializedRow } from "./provenance";
import { Selection, type DeleteOptions, type MutationConflict, type MutationOptions, type MutationPatch, type MutationResult, type SelectionRuntime } from "./selection";
import type { DatabaseDefinition } from "./schema";
import { type SheetsTransport } from "./transport";
import type { DeferredJournal, DeferredOverlayReader } from "./infrastructure/deferred";
import type { SchemaCanonicalState } from "./management";
export interface ExecutableQuery<T extends Record<string, unknown>> {
    readonly plan: SerializableQueryPlan;
    readonly localPredicates: readonly ((row: Readonly<T>) => boolean)[];
    readonly refresh: () => Selection<T>;
    readonly overlayRows?: (tableName: string, rows: readonly MaterializedRow<Record<string, unknown>>[]) => readonly MaterializedRow<Record<string, unknown>>[];
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
    readThrough?<T>(key: unknown, producer: () => T, policy?: {
        ttlSeconds?: number;
        jitterSeconds?: number;
    }): {
        readonly value: T;
        readonly cache: "hit" | "hit-after-wait" | "filled" | "uncached";
    };
}
export interface RuntimeGenerationAdapter {
    current(dependency: {
        readonly kind: "table";
        readonly sourceId: string;
        readonly table: string;
    } | {
        readonly kind: "tag";
        readonly tag: string;
    }): string;
    invalidateTable(sourceId: string, table: string): string;
    invalidateRow?(sourceId: string, table: string, key: unknown): string;
    invalidateTag?(tag: string): string;
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
    readonly deferredOverlay?: DeferredOverlayReader;
    readonly canonicalState?: SchemaCanonicalState;
    readonly executionScope?: {
        run<T>(operation: () => T): T;
        retryCount?(): number;
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
/** Internal complete-table snapshot hint used by sync/upsert validation. */
export interface WriteConstraintSnapshot {
    readonly tableName: string;
    readonly rows: readonly MaterializedRow<Record<string, unknown>>[];
}
/** Purely synchronous schema/query executor over an injectable Sheets transport. */
export declare class GQueryExecutor implements SelectionRuntime {
    private readonly schema;
    private readonly options;
    private readonly metadata;
    private readonly knownSheets;
    private readonly knownSheetTitles;
    private readonly headers;
    private readonly locators;
    private readonly now;
    private deferredOverlaySuppression;
    private readCacheSuppression;
    constructor(schema: DatabaseDefinition, options: ExecutorOptions);
    execute<T extends Record<string, unknown>>(query: ExecutableQuery<T>): QueryExecution<T>;
    /** Internal flush hook: deferred delivery must compare against physical state. */
    withoutDeferredOverlay<T>(operation: () => T): T;
    /**
     * Optimistic deferred rows are suitable for reads and further deferred
     * composition, but never as physical coordinates for an immediate write.
     */
    assertNoDeferredOverlayRows(rows: readonly MaterializedRow<Record<string, unknown>>[], operation: string): void;
    /** Internal flush hook: journal preflight reads must observe physical Sheets state. */
    withoutReadCache<T>(operation: () => T): T;
    executeBatch(queries: Readonly<Record<string, ExecutableQuery<Record<string, unknown>>>>): {
        readonly selections: Readonly<Record<string, Selection<Record<string, unknown>>>>;
        readonly plans: Readonly<Record<string, ExecutionPlan>>;
    };
    private executeBatchUnscoped;
    explain<T extends Record<string, unknown>>(query: ExecutableQuery<T>, executedMode?: "cache" | "bounded" | "full-scan", executedRanges?: readonly string[], staleTables?: readonly string[]): ExecutionPlan;
    refresh<T extends Record<string, unknown>>(selection: Selection<T>): Selection<T>;
    update<T extends Record<string, unknown>>(selection: Selection<T>, patch: MutationPatch<T>, options?: MutationOptions): MutationResult<T>;
    private updateUnscoped;
    delete<T extends Record<string, unknown>>(selection: Selection<T>, options?: DeleteOptions): MutationResult<T>;
    private deleteUnscoped;
    append(tableName: string, rows: readonly Record<string, unknown>[]): MutationResult<Record<string, unknown>>;
    /** Queue a caller-keyed create/upsert without opening the spreadsheet. */
    deferKeyedWrite(tableName: string, row: Readonly<Record<string, unknown>>, kind: "create" | "upsert", options: Pick<MutationOptions, "idempotencyKey" | "actor">): MutationResult<Record<string, unknown>>;
    private appendUnscoped;
    /** Compile staged operations and commit each workbook in one atomic batch. */
    commitUnitOfWork(intents: readonly UnitOfWorkIntent[]): UnitOfWorkCommitResult;
    commitUnitOfWorkWithSnapshots(intents: readonly UnitOfWorkIntent[], constraintSnapshots?: readonly WriteConstraintSnapshot[]): UnitOfWorkCommitResult;
    /**
     * Internal deferred-flush hook. The caller must hold the participating-writer
     * lock and must have obtained every selection from a cache-bypassing physical
     * batch read immediately before this call. That read is the targeted version
     * preflight, so repeating it here would double the Sheets read traffic without
     * providing compare-and-set semantics (which Sheets does not expose).
     */
    commitUnitOfWorkAfterPhysicalRead(intents: readonly UnitOfWorkIntent[], constraintSnapshots?: readonly WriteConstraintSnapshot[]): UnitOfWorkCommitResult;
    private commitUnitOfWorkUnscoped;
    invalidateTable(spreadsheetId: string, tableName: string): void;
    invalidateStructure(spreadsheetId: string): void;
    private emptyMutation;
    private scoped;
    private attachRetryStats;
    private deferUpdate;
    private deferDelete;
    private prepareUpdates;
    private deleteRelationEdges;
    private reachableDeleteEdges;
    private loadDeleteRelationRows;
    private planReferentialDelete;
    private uniqueMaterialized;
    private prepareAppend;
    /**
     * Validate the final key graph represented by a write before any workbook is
     * mutated. Existing rows that are updated/deleted are removed first, which
     * lets an update retain its own key and permits atomic key swaps.
     */
    private validateWriteConstraints;
    private canonicalConstraintRow;
    private candidateIdentityKey;
    /** Read only constrained fields plus the minimum row-presence anchors. */
    private scanConstraintRows;
    private recordTouched;
    private pendingDeferredEntries;
    /** Merge the durable queued state before predicates and joins are evaluated. */
    private applyDeferredOverlay;
    private table;
    /**
     * Projected selections intentionally retain only the encoded columns that
     * were read. Before a write needs the complete prior row, fetch just the
     * missing column blocks for the already matched physical rows. This preserves
     * selection reuse without repeating the original predicate scan.
     */
    private hydrateMaterializedRows;
    /** Rebuild the complete decoded table row retained by encoded provenance. */
    private physicalRowValue;
    private source;
    private sourceIdentity;
    private spreadsheetId;
    private tableIdentity;
    private resolveTable;
    private resolveIdentity;
    private parseCachedSnapshot;
    private parseCachedSnapshotValue;
    private validCachedSheet;
    private cachedSheetMetadata;
    private knownSheetKey;
    private knownSheetIdKey;
    private rememberSheets;
    private parseHeader;
    private parseSnapshot;
    private requireSnapshot;
    private cacheForTable;
    private queryCachePlansForTable;
    private queryCacheKey;
    private freshCacheEntries;
    private staleCacheEntries;
    private cachedSnapshotFrom;
    private publishSnapshot;
    private snapshotPayload;
    /**
     * Work out the smallest safe logical row shape shared by every query that
     * depends on this table. Cold reads remain complete because physical column
     * positions are schema data learned from the header row. Cache-backed reads
     * also remain complete so a partial matrix is never published as a table
     * snapshot.
     */
    private snapshotFieldsForQueries;
    private snapshotReadPlan;
    private partialSnapshotValues;
    private readSnapshotGroup;
    private indexForQuery;
    private locatorCacheEntry;
    private hydratePersistentLocator;
    private publishPersistentLocators;
    private canPlanBounded;
    private tryBoundedRead;
    private scanLocator;
    private loadLocatedRows;
    private locatorKey;
    private registerLocators;
    private clearTableLocators;
    private tableCacheKey;
    private staleTableCacheKey;
    private preflight;
    private assertSingleMutationTable;
    private groupPatchesBySpreadsheet;
    private formatMutations;
    private sheetName;
    private invalidateMaterialized;
}
