import { HashFunction } from "./canonical";
import { ChunkedCache, ChunkedCachePolicy } from "./cache";
import { GQueryV2Error } from "./errors";
import { Clock, IdGenerator, PropertyStore, SyncLock } from "./runtime";
export type DeferredMutationKind = "patch" | "upsert" | "delete" | "create";
export interface DeferredMutationInput {
    readonly sourceId: string;
    readonly table: string;
    readonly kind: DeferredMutationKind;
    /** Every deferred mutation is key-addressed; creates therefore require caller-assigned keys. */
    readonly key: Readonly<Record<string, unknown>>;
    readonly values?: Readonly<Record<string, unknown>>;
    readonly expectedVersion?: string | number | null;
    readonly actor?: string;
    readonly idempotencyKey: string;
}
export interface PendingDeferredMutation extends DeferredMutationInput {
    readonly id: string;
    readonly sequence: number;
    readonly enqueuedAtMs: number;
    readonly attempts: number;
    readonly lastAttemptAtMs?: number;
    readonly lastError?: string;
}
export type DeferredReceiptStatus = "queued" | "committed" | "conflicted";
export interface PendingMutationReceipt {
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly mutationId: string;
    readonly status: DeferredReceiptStatus;
    readonly createdAtMs: number;
    readonly updatedAtMs: number;
    readonly conflict?: Readonly<Record<string, unknown>>;
}
export interface DeferredEnqueueResult {
    readonly duplicate: boolean;
    readonly receipt: PendingMutationReceipt;
}
export declare class JournalCapacityError extends GQueryV2Error {
    constructor(bytes: number, maximumBytes: number);
}
export declare class DeferredMutationTooLargeError extends GQueryV2Error {
    constructor(bytes: number, maximumBytes: number);
}
export declare class JournalCorruptionError extends GQueryV2Error {
    constructor(reason: string);
}
export declare class JournalLockTimeoutError extends GQueryV2Error {
    constructor(timeoutMs: number);
}
export declare class IdempotencyConflictError extends GQueryV2Error {
    constructor(idempotencyKey: string);
}
export interface DeferredOverlayPublisher {
    /** Cache-only optimization. Implementations must treat replace failures as recoverable. */
    replace(entries: readonly PendingDeferredMutation[]): void;
}
/** CacheService-backed overlay which remains explicitly rebuildable from the journal. */
export declare class ChunkedDeferredOverlay implements DeferredOverlayPublisher {
    private readonly cache;
    private readonly logicalKey;
    private readonly policy;
    constructor(cache: ChunkedCache, logicalKey?: unknown, policy?: ChunkedCachePolicy);
    replace(entries: readonly PendingDeferredMutation[]): void;
    read(): readonly PendingDeferredMutation[] | null;
}
export interface DeferredJournalOptions {
    readonly namespace?: string;
    readonly shardByteLimit?: number;
    readonly softByteLimit?: number;
    readonly maxMutationBytes?: number;
    readonly retainedReceiptLimit?: number;
    readonly lockTimeoutMs?: number;
}
export interface DeferredJournalDependencies {
    readonly properties: PropertyStore;
    readonly lock: SyncLock;
    readonly hasher: HashFunction;
    readonly ids: IdGenerator;
    readonly clock?: Clock;
    readonly overlay?: DeferredOverlayPublisher;
}
export interface CoalescedDeferredMutation {
    readonly id: string;
    readonly sourceMutationIds: readonly string[];
    readonly sourceId: string;
    readonly table: string;
    readonly kind: DeferredMutationKind;
    readonly key: Readonly<Record<string, unknown>>;
    readonly values?: Readonly<Record<string, unknown>>;
    readonly expectedVersion?: string | number | null;
    readonly actor?: string;
    readonly firstSequence: number;
}
export type DeferredOutcomeStatus = "committed" | "transient" | "conflict";
export interface DeferredMutationOutcome {
    readonly mutationId: string;
    readonly status: DeferredOutcomeStatus;
    readonly message?: string;
    readonly conflict?: Readonly<Record<string, unknown>>;
}
export interface DeferredMutationBatchExecutor {
    /**
     * Missing outcomes are treated as transient. Applying the same mutation id
     * more than once must be harmless because a crash can follow a remote commit.
     */
    apply(mutations: readonly CoalescedDeferredMutation[]): readonly DeferredMutationOutcome[];
}
export interface DeferredDeadLetter {
    readonly id: string;
    readonly mutation: CoalescedDeferredMutation;
    readonly originals: readonly PendingDeferredMutation[];
    readonly conflict: Readonly<Record<string, unknown>>;
    readonly movedAtMs: number;
}
export interface DeferredDeadLetterSink {
    /** Must be idempotent by dead-letter id because persistence can fail after this call. */
    write(records: readonly DeferredDeadLetter[]): void;
}
export interface DeferredFlushResult {
    readonly attempted: number;
    readonly committed: number;
    readonly conflicted: number;
    readonly retained: number;
    readonly coalesced: number;
    readonly errors: readonly string[];
}
/** Only semantically compatible adjacent operations are combined; ordering is otherwise preserved. */
export declare function coalesceDeferredMutations(entries: readonly PendingDeferredMutation[], hasher: HashFunction): CoalescedDeferredMutation[];
/** Durable, bounded ScriptProperties journal. Cache overlays are deliberately non-authoritative. */
export declare class DeferredJournal {
    private readonly dependencies;
    private readonly clock;
    private readonly namespace;
    private readonly shardByteLimit;
    private readonly softByteLimit;
    private readonly maxMutationBytes;
    private readonly retainedReceiptLimit;
    private readonly lockTimeoutMs;
    constructor(dependencies: DeferredJournalDependencies, options?: DeferredJournalOptions);
    enqueue(input: DeferredMutationInput): DeferredEnqueueResult;
    enqueueOrExecute(input: DeferredMutationInput, immediate: () => PendingMutationReceipt): DeferredEnqueueResult;
    list(): readonly PendingDeferredMutation[];
    receipt(idempotencyKey: string): PendingMutationReceipt | null;
    rebuildOverlay(): number;
    flush(executor: DeferredMutationBatchExecutor, deadLetters: DeferredDeadLetterSink): DeferredFlushResult;
    private locked;
    private get manifestKey();
    private shardKey;
    private load;
    private persist;
    private publishOverlay;
}
export declare function createAppsScriptDeferredJournal(options?: DeferredJournalOptions, overlay?: DeferredOverlayPublisher): DeferredJournal;
