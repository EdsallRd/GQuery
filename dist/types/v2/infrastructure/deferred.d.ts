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
export declare class JournalFlushLeaseLostError extends GQueryV2Error {
    constructor(leaseId: string);
}
export declare class IdempotencyConflictError extends GQueryV2Error {
    constructor(idempotencyKey: string);
}
export declare class AppliedReceiptCapacityError extends GQueryV2Error {
    constructor(sourceMutationCount: number, retainedReceiptLimit: number, bytes: number, maximumBytes: number);
}
export interface DeferredOverlayPublisher {
    /** Cache-only optimization. Implementations must treat replace failures as recoverable. */
    replace(entries: readonly PendingDeferredMutation[]): void;
}
export interface DeferredOverlayReader {
    /** Returns null after eviction/corruption so callers can rebuild from the journal. */
    read(): readonly PendingDeferredMutation[] | null;
}
/** CacheService-backed overlay which remains explicitly rebuildable from the journal. */
export declare class ChunkedDeferredOverlay implements DeferredOverlayPublisher, DeferredOverlayReader {
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
    /**
     * Durable trigger-run fence. The default exceeds Apps Script's normal
     * six-minute execution ceiling so a healthy flush cannot be overtaken.
     */
    readonly flushLeaseMs?: number;
}
export interface AppliedMutationReceiptLedgerOptions {
    readonly namespace?: string;
    readonly retainedReceiptLimit?: number;
    readonly maximumBytes?: number;
    readonly maximumAgeMs?: number;
    readonly clock?: Clock;
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
    /** Original ordered operations retained for crash-safe partial recomposition. */
    readonly sourceMutations: readonly PendingDeferredMutation[];
    readonly sourceId: string;
    readonly table: string;
    readonly kind: DeferredMutationKind;
    readonly key: Readonly<Record<string, unknown>>;
    readonly values?: Readonly<Record<string, unknown>>;
    readonly expectedVersion?: string | number | null;
    readonly actor?: string;
    readonly firstSequence: number;
    /** Encoded state written by a confirmed applied prefix of this group. */
    readonly recoveryAppliedValues?: Readonly<Record<string, unknown>>;
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
    /** Called only after terminal journal removal has been durably published. */
    forgetApplied?(mutationIds: readonly string[]): void;
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
export declare const DEFERRED_DEAD_LETTER_BASE_HEADERS: readonly ["ID", "Mutation ID", "Source", "Table", "Key", "Conflict", "Moved At"];
export declare const DEFERRED_DEAD_LETTER_ACTOR_HEADER = "Actor";
export interface DeferredFlushResult {
    readonly attempted: number;
    readonly committed: number;
    readonly conflicted: number;
    readonly retained: number;
    readonly coalesced: number;
    readonly errors: readonly string[];
}
interface AppliedMutationReceipt {
    readonly mutationId: string;
    readonly appliedAtMs: number;
}
/**
 * A compact crash-recovery ledger. It uses one bounded ScriptProperties value,
 * not one permanent property per mutation, and terminal journal publication
 * removes entries eagerly.
 */
export declare class AppliedMutationReceiptLedger {
    private readonly properties;
    private readonly namespace;
    private readonly retainedReceiptLimit;
    private readonly maximumBytes;
    private readonly maximumAgeMs;
    private readonly clock;
    constructor(properties: PropertyStore, options?: AppliedMutationReceiptLedgerOptions);
    has(mutationId: string): boolean;
    mark(mutationId: string): void;
    /** Publish all receipts in one bounded property write after an atomic batch. */
    markMany(mutationIds: readonly string[]): void;
    /** Refuse a flush before remote I/O when its full crash checkpoint cannot fit. */
    assertCanMarkMany(mutationIds: readonly string[]): void;
    forget(mutationIds: readonly string[]): void;
    prune(): number;
    list(): readonly AppliedMutationReceipt[];
    private get key();
    private load;
    private pruned;
    private fit;
    private markedState;
    private serializedBytes;
    private persist;
}
/**
 * Combine compatible operations for one key even when unrelated keys are
 * interleaved. The first occurrence retains its position, field values remain
 * last-write-wins for that key, and an incompatible operation on the same key
 * creates a semantic barrier for subsequent entries.
 */
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
    private readonly flushLeaseMs;
    constructor(dependencies: DeferredJournalDependencies, options?: DeferredJournalOptions);
    enqueue(input: DeferredMutationInput): DeferredEnqueueResult;
    enqueueOrExecute(input: DeferredMutationInput, immediate: () => PendingMutationReceipt): DeferredEnqueueResult;
    list(): readonly PendingDeferredMutation[];
    /** Read the authoritative journal and republish its cache-only overlay in one lock. */
    listAndRebuildOverlay(): readonly PendingDeferredMutation[];
    /**
     * Read a manifest-last snapshot without taking the journal ScriptLock.
     *
     * This path is used only to rebuild the non-authoritative read-your-writes
     * overlay. A query can already be running under the unit-of-work/document
     * lock, so acquiring a second ScriptLock handle here risks a nested-lock
     * timeout in Apps Script. The immutable shard generation is safe to read
     * lock-free as long as the manifest remains unchanged for the duration of
     * the read. A concurrent publication is retried against its new generation.
     */
    readAndRebuildOverlay(): readonly PendingDeferredMutation[];
    receipt(idempotencyKey: string): PendingMutationReceipt | null;
    rebuildOverlay(): number;
    flush(executor: DeferredMutationBatchExecutor, deadLetters: DeferredDeadLetterSink): DeferredFlushResult;
    private prepareFlush;
    private reconcileFlush;
    private releaseFlushLease;
    private locked;
    private get manifestKey();
    private shardKey;
    private load;
    private persist;
    private publishOverlay;
}
export declare function createAppsScriptDeferredJournal(options?: DeferredJournalOptions, overlay?: DeferredOverlayPublisher): DeferredJournal;
export {};
