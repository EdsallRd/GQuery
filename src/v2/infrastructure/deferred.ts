import { AppsScriptSha256Hash, HashFunction, canonicalStringify } from "./canonical";
import { ChunkedCache, ChunkedCachePolicy } from "./cache";
import { GQueryV2Error } from "./errors";
import {
  AppsScriptLock,
  AppsScriptPropertyStore,
  Clock,
  IdGenerator,
  PropertyStore,
  SyncLock,
  systemClock,
} from "./runtime";

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

interface JournalState {
  readonly version: 1;
  readonly revision: number;
  readonly nextSequence: number;
  readonly entries: PendingDeferredMutation[];
  readonly receipts: PendingMutationReceipt[];
}

interface JournalManifest {
  readonly version: 1;
  readonly generation: string;
  readonly shards: number;
  readonly bytes: number;
  readonly checksum: string;
  readonly revision: number;
}

export class JournalCapacityError extends GQueryV2Error {
  public constructor(bytes: number, maximumBytes: number) {
    super(
      "JOURNAL_CAPACITY",
      `The deferred journal would use ${bytes} bytes, above its ${maximumBytes}-byte safety limit.`,
      { bytes, maximumBytes },
    );
  }
}

export class DeferredMutationTooLargeError extends GQueryV2Error {
  public constructor(bytes: number, maximumBytes: number) {
    super(
      "JOURNAL_ENTRY_TOO_LARGE",
      `The deferred mutation uses ${bytes} bytes, above its ${maximumBytes}-byte safety limit.`,
      { bytes, maximumBytes },
    );
  }
}

export class JournalCorruptionError extends GQueryV2Error {
  public constructor(reason: string) {
    super("JOURNAL_CORRUPT", `The deferred journal is incomplete or corrupt: ${reason}.`, { reason });
  }
}

export class JournalLockTimeoutError extends GQueryV2Error {
  public constructor(timeoutMs: number) {
    super(
      "JOURNAL_LOCK_TIMEOUT",
      `Could not acquire the deferred journal lock within ${timeoutMs}ms.`,
      { timeoutMs },
    );
  }
}

export class IdempotencyConflictError extends GQueryV2Error {
  public constructor(idempotencyKey: string) {
    super(
      "DEFERRED_CONFLICT",
      "The idempotency key was already used for a different deferred mutation.",
      { idempotencyKey },
    );
  }
}

export interface DeferredOverlayPublisher {
  /** Cache-only optimization. Implementations must treat replace failures as recoverable. */
  replace(entries: readonly PendingDeferredMutation[]): void;
}

/** CacheService-backed overlay which remains explicitly rebuildable from the journal. */
export class ChunkedDeferredOverlay implements DeferredOverlayPublisher {
  public constructor(
    private readonly cache: ChunkedCache,
    private readonly logicalKey: unknown = { kind: "deferred-overlay" },
    private readonly policy: ChunkedCachePolicy = { ttlSeconds: 300, jitterSeconds: 30 },
  ) {}

  public replace(entries: readonly PendingDeferredMutation[]): void {
    this.cache.put(this.logicalKey, entries, this.policy);
  }

  public read(): readonly PendingDeferredMutation[] | null {
    return this.cache.get<PendingDeferredMutation[]>(this.logicalKey);
  }
}

export interface DeferredJournalOptions {
  readonly namespace?: string;
  readonly shardByteLimit?: number;
  readonly softByteLimit?: number;
  readonly maxMutationBytes?: number;
  readonly retainedReceiptLimit?: number;
  readonly lockTimeoutMs?: number;
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

export interface DeferredFlushResult {
  readonly attempted: number;
  readonly committed: number;
  readonly conflicted: number;
  readonly retained: number;
  readonly coalesced: number;
  readonly errors: readonly string[];
}

function emptyState(): JournalState {
  return { version: 1, revision: 0, nextSequence: 1, entries: [], receipts: [] };
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function splitUtf8(value: string, byteLimit: number): string[] {
  if (value === "") return [""];
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of value) {
    const bytes = utf8ByteLength(character);
    if (chunkBytes + bytes > byteLimit && chunk !== "") {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += bytes;
  }
  if (chunk !== "") chunks.push(chunk);
  return chunks;
}

function assertJsonValue(value: unknown, path: string, ancestors: object[]): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must not contain NaN or Infinity.`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${path} must contain only JSON values.`);
  if (value instanceof Date) throw new TypeError(`${path} must contain encoded values, not Date instances.`);
  if (ancestors.includes(value)) throw new TypeError(`${path} must not contain cycles.`);
  const nextAncestors = [...ancestors, value];
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, nextAncestors));
    return;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only plain JSON objects.`);
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertJsonValue(child, `${path}.${key}`, nextAncestors);
  }
}

function validateInput(input: DeferredMutationInput): void {
  if (input.sourceId.trim() === "" || input.table.trim() === "") {
    throw new TypeError("Deferred mutations require non-empty sourceId and table values.");
  }
  if (input.idempotencyKey.trim() === "") {
    throw new TypeError("Deferred mutations require a non-empty idempotencyKey.");
  }
  if (Object.keys(input.key).length === 0) {
    throw new TypeError("Deferred mutations must be key-addressed.");
  }
  assertJsonValue(input.key, "key", []);
  if (
    typeof input.expectedVersion === "number" &&
    !Number.isFinite(input.expectedVersion)
  ) {
    throw new TypeError("expectedVersion must be finite when it is numeric.");
  }
  if (input.kind === "delete") {
    if (input.values !== undefined) throw new TypeError("Deferred deletes cannot include values.");
  } else {
    if (input.values === undefined) throw new TypeError(`Deferred ${input.kind} mutations require values.`);
    assertJsonValue(input.values, "values", []);
  }
}

function parseManifest(raw: string | null): JournalManifest | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<JournalManifest>;
    if (
      value.version !== 1 ||
      typeof value.generation !== "string" ||
      !Number.isInteger(value.shards) ||
      (value.shards ?? 0) < 1 ||
      !Number.isInteger(value.bytes) ||
      (value.bytes ?? -1) < 0 ||
      typeof value.checksum !== "string" ||
      !Number.isInteger(value.revision)
    ) {
      throw new Error("invalid manifest shape");
    }
    return value as JournalManifest;
  } catch (error) {
    throw new JournalCorruptionError(error instanceof Error ? error.message : "invalid manifest");
  }
}

function terminalReceipts(receipts: readonly PendingMutationReceipt[]): PendingMutationReceipt[] {
  return receipts.filter((receipt) => receipt.status !== "queued");
}

function pruneReceipts(
  receipts: readonly PendingMutationReceipt[],
  limit: number,
): PendingMutationReceipt[] {
  const queued = receipts.filter((receipt) => receipt.status === "queued");
  const terminal = terminalReceipts(receipts)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, limit);
  return [...queued, ...terminal];
}

interface AppliedMutationReceipt {
  readonly mutationId: string;
  readonly appliedAtMs: number;
}

interface AppliedMutationReceiptState {
  readonly version: 1;
  readonly receipts: readonly AppliedMutationReceipt[];
}

/**
 * A compact crash-recovery ledger. It uses one bounded ScriptProperties value,
 * not one permanent property per mutation, and terminal journal publication
 * removes entries eagerly.
 */
export class AppliedMutationReceiptLedger {
  private readonly namespace: string;
  private readonly retainedReceiptLimit: number;
  private readonly maximumBytes: number;
  private readonly maximumAgeMs: number;
  private readonly clock: Clock;

  public constructor(
    private readonly properties: PropertyStore,
    options: AppliedMutationReceiptLedgerOptions = {},
  ) {
    this.namespace = options.namespace ?? "gq2";
    this.retainedReceiptLimit = options.retainedReceiptLimit ?? 64;
    this.maximumBytes = options.maximumBytes ?? 8_000;
    this.maximumAgeMs = options.maximumAgeMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.clock = options.clock ?? systemClock;
    if (!Number.isInteger(this.retainedReceiptLimit) || this.retainedReceiptLimit < 1) {
      throw new RangeError("Applied receipt retention must be a positive integer.");
    }
    if (!Number.isInteger(this.maximumBytes) || this.maximumBytes < 256 || this.maximumBytes > 8_000) {
      throw new RangeError("Applied receipt storage must be between 256 and 8000 bytes.");
    }
    if (!Number.isFinite(this.maximumAgeMs) || this.maximumAgeMs < 1) {
      throw new RangeError("Applied receipt maximumAgeMs must be positive and finite.");
    }
  }

  public has(mutationId: string): boolean {
    return this.pruned(this.load(), this.clock.now()).some(
      (receipt) => receipt.mutationId === mutationId,
    );
  }

  public mark(mutationId: string): void {
    if (mutationId.trim().length === 0) throw new TypeError("Applied mutation IDs must not be empty.");
    const now = this.clock.now();
    const receipts = this.pruned(this.load(), now)
      .filter((receipt) => receipt.mutationId !== mutationId);
    receipts.push({ mutationId, appliedAtMs: now });
    this.persist(this.fit(receipts));
  }

  public forget(mutationIds: readonly string[]): void {
    if (mutationIds.length === 0) return;
    const removed = new Set(mutationIds);
    this.persist(this.pruned(this.load(), this.clock.now()).filter(
      (receipt) => !removed.has(receipt.mutationId),
    ));
  }

  public prune(): number {
    const current = this.load();
    const next = this.fit(this.pruned(current, this.clock.now()));
    this.persist(next);
    return current.length - next.length;
  }

  public list(): readonly AppliedMutationReceipt[] {
    return Object.freeze([...this.pruned(this.load(), this.clock.now())]);
  }

  private get key(): string {
    return `${this.namespace}:deferred-applied`;
  }

  private load(): AppliedMutationReceipt[] {
    const raw = this.properties.get(this.key);
    if (raw === null) return [];
    try {
      const state = JSON.parse(raw) as Partial<AppliedMutationReceiptState>;
      if (state.version !== 1 || !Array.isArray(state.receipts)) throw new Error("invalid state shape");
      return state.receipts.map((receipt) => {
        if (
          typeof receipt !== "object" ||
          receipt === null ||
          typeof (receipt as AppliedMutationReceipt).mutationId !== "string" ||
          !Number.isFinite((receipt as AppliedMutationReceipt).appliedAtMs)
        ) {
          throw new Error("invalid receipt shape");
        }
        return receipt as AppliedMutationReceipt;
      });
    } catch (error) {
      throw new JournalCorruptionError(
        `applied receipt ledger ${error instanceof Error ? error.message : "invalid JSON"}`,
      );
    }
  }

  private pruned(
    receipts: readonly AppliedMutationReceipt[],
    now: number,
  ): AppliedMutationReceipt[] {
    return receipts
      .filter((receipt) => now - receipt.appliedAtMs <= this.maximumAgeMs)
      .sort((left, right) =>
        left.appliedAtMs - right.appliedAtMs || left.mutationId.localeCompare(right.mutationId)
      )
      .slice(-this.retainedReceiptLimit);
  }

  private fit(receipts: readonly AppliedMutationReceipt[]): AppliedMutationReceipt[] {
    const fitted = [...receipts];
    while (fitted.length > 0 && this.serializedBytes(fitted) > this.maximumBytes) fitted.shift();
    if (fitted.length === 0 && receipts.length > 0) {
      throw new JournalCapacityError(this.serializedBytes(receipts.slice(-1)), this.maximumBytes);
    }
    return fitted;
  }

  private serializedBytes(receipts: readonly AppliedMutationReceipt[]): number {
    return utf8ByteLength(JSON.stringify({ version: 1, receipts } satisfies AppliedMutationReceiptState));
  }

  private persist(receipts: readonly AppliedMutationReceipt[]): void {
    if (receipts.length === 0) {
      this.properties.remove(this.key);
      return;
    }
    this.properties.set(
      this.key,
      JSON.stringify({ version: 1, receipts } satisfies AppliedMutationReceiptState),
    );
  }
}

function compatible(left: CoalescedDeferredMutation, right: PendingDeferredMutation): boolean {
  if (
    left.sourceId !== right.sourceId ||
    left.table !== right.table ||
    canonicalStringify(left.key) !== canonicalStringify(right.key) ||
    left.expectedVersion !== right.expectedVersion ||
    left.actor !== right.actor
  ) {
    return false;
  }
  return (
    (left.kind === "patch" && right.kind === "patch") ||
    (left.kind === "upsert" && (right.kind === "upsert" || right.kind === "patch"))
  );
}

/** Only semantically compatible adjacent operations are combined; ordering is otherwise preserved. */
export function coalesceDeferredMutations(
  entries: readonly PendingDeferredMutation[],
  hasher: HashFunction,
): CoalescedDeferredMutation[] {
  const result: CoalescedDeferredMutation[] = [];
  for (const entry of [...entries].sort((left, right) => left.sequence - right.sequence)) {
    const previous = result[result.length - 1];
    if (previous !== undefined && compatible(previous, entry)) {
      const combinedIds = [...previous.sourceMutationIds, entry.id];
      result[result.length - 1] = {
        ...previous,
        id: hasher.hash(combinedIds.join("\u0000")),
        sourceMutationIds: combinedIds,
        values: { ...(previous.values ?? {}), ...(entry.values ?? {}) },
      };
      continue;
    }
    result.push({
      id: hasher.hash(entry.id),
      sourceMutationIds: [entry.id],
      sourceId: entry.sourceId,
      table: entry.table,
      kind: entry.kind,
      key: entry.key,
      values: entry.values,
      expectedVersion: entry.expectedVersion,
      actor: entry.actor,
      firstSequence: entry.sequence,
    });
  }
  return result;
}

/** Durable, bounded ScriptProperties journal. Cache overlays are deliberately non-authoritative. */
export class DeferredJournal {
  private readonly clock: Clock;
  private readonly namespace: string;
  private readonly shardByteLimit: number;
  private readonly softByteLimit: number;
  private readonly maxMutationBytes: number;
  private readonly retainedReceiptLimit: number;
  private readonly lockTimeoutMs: number;

  public constructor(
    private readonly dependencies: DeferredJournalDependencies,
    options: DeferredJournalOptions = {},
  ) {
    this.clock = dependencies.clock ?? systemClock;
    this.namespace = options.namespace ?? "gq2";
    this.shardByteLimit = options.shardByteLimit ?? 8_000;
    this.softByteLimit = options.softByteLimit ?? 400_000;
    this.maxMutationBytes = options.maxMutationBytes ?? 32_000;
    this.retainedReceiptLimit = options.retainedReceiptLimit ?? 256;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.shardByteLimit) || this.shardByteLimit < 256 || this.shardByteLimit > 8_000) {
      throw new RangeError("Deferred journal shards must be between 256 and 8000 bytes.");
    }
    if (!Number.isInteger(this.softByteLimit) || this.softByteLimit < this.shardByteLimit) {
      throw new RangeError("Deferred journal capacity must be at least one shard.");
    }
    if (!Number.isInteger(this.maxMutationBytes) || this.maxMutationBytes < 1) {
      throw new RangeError("Deferred mutation size limit must be a positive integer.");
    }
  }

  public enqueue(input: DeferredMutationInput): DeferredEnqueueResult {
    validateInput(input);
    const serializedInput = canonicalStringify(input);
    const requestHash = this.dependencies.hasher.hash(serializedInput);
    const inputBytes = utf8ByteLength(serializedInput);
    if (inputBytes > this.maxMutationBytes) {
      throw new DeferredMutationTooLargeError(inputBytes, this.maxMutationBytes);
    }

    return this.locked(() => {
      const state = this.load();
      const existing = state.receipts.find((receipt) => receipt.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) throw new IdempotencyConflictError(input.idempotencyKey);
        return { duplicate: true, receipt: existing };
      }

      const now = this.clock.now();
      const mutation: PendingDeferredMutation = {
        ...input,
        id: this.dependencies.ids.next(),
        sequence: state.nextSequence,
        enqueuedAtMs: now,
        attempts: 0,
      };
      const receipt: PendingMutationReceipt = {
        idempotencyKey: input.idempotencyKey,
        requestHash,
        mutationId: mutation.id,
        status: "queued",
        createdAtMs: now,
        updatedAtMs: now,
      };
      const next: JournalState = {
        version: 1,
        revision: state.revision + 1,
        nextSequence: state.nextSequence + 1,
        entries: [...state.entries, mutation],
        receipts: pruneReceipts([...state.receipts, receipt], this.retainedReceiptLimit),
      };
      this.persist(next);
      return { duplicate: false, receipt };
    });
  }

  public enqueueOrExecute(
    input: DeferredMutationInput,
    immediate: () => PendingMutationReceipt,
  ): DeferredEnqueueResult {
    try {
      return this.enqueue(input);
    } catch (error) {
      if (!(error instanceof JournalCapacityError) && !(error instanceof DeferredMutationTooLargeError)) {
        throw error;
      }
      const receipt = immediate();
      if (receipt.idempotencyKey !== input.idempotencyKey || receipt.status === "queued") {
        throw new TypeError(
          "Immediate fallback must return a terminal receipt for the requested idempotency key.",
        );
      }
      return { duplicate: false, receipt };
    }
  }

  public list(): readonly PendingDeferredMutation[] {
    return this.locked(() => [...this.load().entries].sort((left, right) => left.sequence - right.sequence));
  }

  public receipt(idempotencyKey: string): PendingMutationReceipt | null {
    return this.locked(
      () => this.load().receipts.find((receipt) => receipt.idempotencyKey === idempotencyKey) ?? null,
    );
  }

  public rebuildOverlay(): number {
    return this.locked(() => {
      const entries = this.load().entries;
      this.publishOverlay(entries);
      return entries.length;
    });
  }

  public flush(
    executor: DeferredMutationBatchExecutor,
    deadLetters: DeferredDeadLetterSink,
  ): DeferredFlushResult {
    return this.locked(() => this.flushLocked(executor, deadLetters));
  }

  private flushLocked(
    executor: DeferredMutationBatchExecutor,
    deadLetters: DeferredDeadLetterSink,
  ): DeferredFlushResult {
    const snapshot = this.load();
    // CacheService may evict early; every flush republishes the authoritative overlay.
    this.publishOverlay(snapshot.entries);
    if (snapshot.entries.length === 0) {
      return { attempted: 0, committed: 0, conflicted: 0, retained: 0, coalesced: 0, errors: [] };
    }

    const coalesced = coalesceDeferredMutations(snapshot.entries, this.dependencies.hasher);
    const errors: string[] = [];
    let outcomes: readonly DeferredMutationOutcome[];
    try {
      outcomes = executor.apply(coalesced);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      outcomes = coalesced.map((mutation) => ({
        mutationId: mutation.id,
        status: "transient" as const,
        message,
      }));
    }

    const outcomeById = new Map(outcomes.map((outcome) => [outcome.mutationId, outcome]));
    const normalizedOutcomes = coalesced.map((mutation): DeferredMutationOutcome =>
      outcomeById.get(mutation.id) ?? {
        mutationId: mutation.id,
        status: "transient",
        message: "The deferred executor returned no outcome for this mutation.",
      },
    );
    const snapshotById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    const conflictGroups = coalesced.filter(
      (mutation) => outcomeById.get(mutation.id)?.status === "conflict",
    );
    const deadLetterRecords: DeferredDeadLetter[] = conflictGroups.map((mutation) => {
      const outcome = outcomeById.get(mutation.id);
      return {
        id: mutation.id,
        mutation,
        originals: mutation.sourceMutationIds
          .map((id) => snapshotById.get(id))
          .filter((entry): entry is PendingDeferredMutation => entry !== undefined),
        conflict: outcome?.conflict ?? { message: outcome?.message ?? "Version conflict" },
        movedAtMs: this.clock.now(),
      };
    });

    let deadLetteredIds = new Set<string>();
    if (deadLetterRecords.length > 0) {
      try {
        deadLetters.write(deadLetterRecords);
        deadLetteredIds = new Set(deadLetterRecords.map((record) => record.mutation.id));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const outcomeForSourceId = new Map<string, DeferredMutationOutcome>();
    for (let index = 0; index < coalesced.length; index += 1) {
      const mutation = coalesced[index];
      const outcome = normalizedOutcomes[index];
      const effective = outcome.status === "conflict" && !deadLetteredIds.has(mutation.id)
        ? { ...outcome, status: "transient" as const }
        : outcome;
      for (const id of mutation.sourceMutationIds) outcomeForSourceId.set(id, effective);
    }

    const now = this.clock.now();
    const updated = (() => {
      const current = this.load();
      const removedIds = new Set<string>();
      const entries = current.entries.flatMap((entry): PendingDeferredMutation[] => {
        const outcome = outcomeForSourceId.get(entry.id);
        if (outcome === undefined) return [entry];
        if (outcome.status === "committed" || outcome.status === "conflict") {
          removedIds.add(entry.id);
          return [];
        }
        return [{
          ...entry,
          attempts: entry.attempts + 1,
          lastAttemptAtMs: now,
          lastError: outcome.message ?? "Transient deferred write failure",
        }];
      });
      const receipts = current.receipts.map((receipt): PendingMutationReceipt => {
        if (!removedIds.has(receipt.mutationId)) return receipt;
        const outcome = outcomeForSourceId.get(receipt.mutationId);
        if (outcome?.status === "conflict") {
          return {
            ...receipt,
            status: "conflicted",
            updatedAtMs: now,
            conflict: outcome.conflict ?? { message: outcome.message ?? "Version conflict" },
          };
        }
        return { ...receipt, status: "committed", updatedAtMs: now };
      });
      const next: JournalState = {
        ...current,
        revision: current.revision + 1,
        entries,
        receipts: pruneReceipts(receipts, this.retainedReceiptLimit),
      };
      this.persist(next);
      return next;
    })();

    const appliedIds = coalesced
      .filter((_, index) => normalizedOutcomes[index].status === "committed")
      .map((mutation) => mutation.id);
    if (appliedIds.length > 0 && executor.forgetApplied !== undefined) {
      try {
        executor.forgetApplied(appliedIds);
      } catch (error) {
        // Journal removal is already authoritative. A bounded ledger can prune
        // this orphan on a later run without reapplying the mutation.
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const committed = coalesced
      .filter((_, index) => normalizedOutcomes[index].status === "committed")
      .reduce((count, mutation) => count + mutation.sourceMutationIds.length, 0);
    const conflicted = coalesced
      .filter(
        (_, index) =>
          normalizedOutcomes[index].status === "conflict" &&
          deadLetteredIds.has(normalizedOutcomes[index].mutationId),
      )
      .reduce((count, mutation) => count + mutation.sourceMutationIds.length, 0);
    return {
      attempted: snapshot.entries.length,
      committed,
      conflicted,
      retained: updated.entries.length,
      coalesced: snapshot.entries.length - coalesced.length,
      errors,
    };
  }

  private locked<T>(operation: () => T): T {
    if (!this.dependencies.lock.tryAcquire(this.lockTimeoutMs)) {
      throw new JournalLockTimeoutError(this.lockTimeoutMs);
    }
    try {
      return operation();
    } finally {
      this.dependencies.lock.release();
    }
  }

  private get manifestKey(): string {
    return `${this.namespace}:deferred:manifest`;
  }

  private shardKey(generation: string, index: number): string {
    return `${this.namespace}:deferred:${generation}:${index}`;
  }

  private load(): JournalState {
    const manifest = parseManifest(this.dependencies.properties.get(this.manifestKey));
    if (manifest === null) return emptyState();
    const all = this.dependencies.properties.getMany();
    const chunks: string[] = [];
    for (let index = 0; index < manifest.shards; index += 1) {
      const value = all[this.shardKey(manifest.generation, index)];
      if (typeof value !== "string") throw new JournalCorruptionError(`missing shard ${index}`);
      chunks.push(value);
    }
    const serialized = chunks.join("");
    if (utf8ByteLength(serialized) !== manifest.bytes) {
      throw new JournalCorruptionError("byte count does not match the manifest");
    }
    if (this.dependencies.hasher.hash(serialized) !== manifest.checksum) {
      throw new JournalCorruptionError("checksum does not match the manifest");
    }
    try {
      const state = JSON.parse(serialized) as JournalState;
      if (
        state.version !== 1 ||
        !Number.isInteger(state.revision) ||
        !Number.isInteger(state.nextSequence) ||
        !Array.isArray(state.entries) ||
        !Array.isArray(state.receipts) ||
        state.revision !== manifest.revision
      ) {
        throw new Error("invalid state shape");
      }
      return state;
    } catch (error) {
      throw new JournalCorruptionError(error instanceof Error ? error.message : "invalid JSON state");
    }
  }

  private persist(state: JournalState): void {
    const serialized = JSON.stringify(state);
    const bytes = utf8ByteLength(serialized);
    if (bytes > this.softByteLimit) throw new JournalCapacityError(bytes, this.softByteLimit);
    const chunks = splitUtf8(serialized, this.shardByteLimit);
    const previous = parseManifest(this.dependencies.properties.get(this.manifestKey));
    const generation = this.dependencies.ids.next();
    const values: Record<string, string> = {};
    const newKeys: string[] = [];
    chunks.forEach((chunk, index) => {
      const key = this.shardKey(generation, index);
      newKeys.push(key);
      values[key] = chunk;
    });
    const manifest: JournalManifest = {
      version: 1,
      generation,
      shards: chunks.length,
      bytes,
      checksum: this.dependencies.hasher.hash(serialized),
      revision: state.revision,
    };

    try {
      this.dependencies.properties.setMany(values);
      // Publication point: old shards remain authoritative until this succeeds.
      this.dependencies.properties.set(this.manifestKey, JSON.stringify(manifest));
    } catch (error) {
      try {
        this.dependencies.properties.removeMany(newKeys);
      } catch {
        // Orphaned, unpublished shards are safe and can be reclaimed later.
      }
      throw error;
    }

    if (previous !== null && previous.generation !== generation) {
      try {
        this.dependencies.properties.removeMany(
          Array.from(
            { length: previous.shards },
            (_, index) => this.shardKey(previous.generation, index),
          ),
        );
      } catch {
        // The manifest already points at the new generation; cleanup is best effort.
      }
    }
    this.publishOverlay(state.entries);
  }

  private publishOverlay(entries: readonly PendingDeferredMutation[]): void {
    try {
      this.dependencies.overlay?.replace(entries);
    } catch {
      // CacheService is never authoritative; the journal remains the source of truth.
    }
  }
}

export function createAppsScriptDeferredJournal(
  options: DeferredJournalOptions = {},
  overlay?: DeferredOverlayPublisher,
): DeferredJournal {
  return new DeferredJournal(
    {
      properties: new AppsScriptPropertyStore(PropertiesService.getScriptProperties()),
      lock: new AppsScriptLock(LockService.getScriptLock()),
      hasher: new AppsScriptSha256Hash(),
      ids: { next: () => Utilities.getUuid() },
      overlay,
    },
    options,
  );
}
