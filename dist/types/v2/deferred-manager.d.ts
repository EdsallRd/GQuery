import type { MutationResult, Selection } from "./selection";
import type { DatabaseDefinition } from "./schema";
import type { UnitOfWorkCommitResult, UnitOfWorkIntent, WriteConstraintSnapshot } from "./executor";
import { type DeferredDeadLetter, type DeferredDeadLetterSink, type DeferredFlushResult, type DeferredJournal, type PendingDeferredMutation, type PendingMutationReceipt } from "./infrastructure/deferred";
import { type PropertyStore } from "./infrastructure/runtime";
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
    commitBatch?(intents: readonly UnitOfWorkIntent[], snapshots: readonly WriteConstraintSnapshot[]): UnitOfWorkCommitResult;
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
export declare class AppsScriptDeadLetterSheet implements DeferredDeadLetterSink {
    write(records: readonly DeferredDeadLetter[]): void;
}
/** Operational facade for the durable journal and five-minute flush handler. */
export declare class DeferredManager {
    private readonly access;
    private readonly options;
    private readonly namespace;
    constructor(access: DeferredManagerAccess, options?: DeferredManagerOptions);
    list(): readonly PendingDeferredMutation[];
    receipt(idempotencyKey: string): PendingMutationReceipt | null;
    rebuildOverlay(): number;
    flush(): DeferredFlushResult;
    private journal;
    private defaultProperties;
}
