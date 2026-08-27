import type { MutationResult, Selection } from "./selection";
import type { DatabaseDefinition } from "./schema";
import { type DeferredDeadLetterSink, type DeferredFlushResult, type DeferredJournal, type PendingDeferredMutation, type PendingMutationReceipt } from "./infrastructure/deferred";
import { type PropertyStore } from "./infrastructure/runtime";
export interface DeferredManagerAccess {
    readonly definition: DatabaseDefinition;
    find(tableName: string, key: Readonly<Record<string, unknown>>): Selection<Record<string, unknown>>;
    append(tableName: string, row: Record<string, unknown>): MutationResult<Record<string, unknown>>;
}
export interface DeferredManagerOptions {
    readonly journal?: DeferredJournal;
    readonly deadLetters?: DeferredDeadLetterSink;
    readonly appliedReceipts?: PropertyStore;
    readonly namespace?: string;
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
