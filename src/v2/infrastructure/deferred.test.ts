import { describe, expect, it } from "vitest";
import { Fnv1aHash } from "./canonical";
import {
  AppliedMutationReceiptLedger,
  DeferredDeadLetter,
  DeferredJournal,
  DeferredMutationOutcome,
  IdempotencyConflictError,
  JournalCapacityError,
  JournalLockTimeoutError,
} from "./deferred";
import { PropertyStore, SyncLock } from "./runtime";

class MemoryProperties implements PropertyStore {
  public readonly values = new Map<string, string>();
  public get(key: string): string | null { return this.values.get(key) ?? null; }
  public getMany(): Record<string, string> { return Object.fromEntries(this.values); }
  public set(key: string, value: string): void { this.values.set(key, value); }
  public setMany(values: Readonly<Record<string, string>>): void {
    Object.entries(values).forEach(([key, value]) => this.values.set(key, value));
  }
  public remove(key: string): void { this.values.delete(key); }
  public removeMany(keys: readonly string[]): void { keys.forEach((key) => this.values.delete(key)); }
}

class FailingManifestProperties extends MemoryProperties {
  public failNextManifestPublication = false;

  public override set(key: string, value: string): void {
    if (this.failNextManifestPublication && key.endsWith(":deferred:manifest")) {
      this.failNextManifestPublication = false;
      throw new Error("simulated manifest publication failure");
    }
    super.set(key, value);
  }
}

class MemoryLock implements SyncLock {
  public held = false;
  public tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }
  public release(): void { this.held = false; }
}

function fixture(options: ConstructorParameters<typeof DeferredJournal>[1] = {}) {
  const properties = new MemoryProperties();
  const lock = new MemoryLock();
  let id = 0;
  let now = 100;
  const journal = new DeferredJournal(
    {
      properties,
      lock,
      hasher: new Fnv1aHash(),
      ids: { next: () => `id-${++id}` },
      clock: { now: () => ++now },
    },
    options,
  );
  return { journal, properties, lock };
}

function patch(idempotencyKey: string, values: Record<string, unknown>) {
  return {
    sourceId: "book",
    table: "Assets",
    kind: "patch" as const,
    key: { serial: "0001" },
    values,
    expectedVersion: 2,
    actor: "user@example.com",
    idempotencyKey,
  };
}

describe("DeferredJournal", () => {
  it("deduplicates identical requests and rejects idempotency-key reuse", () => {
    const { journal } = fixture();
    const first = journal.enqueue(patch("request-1", { status: "Available" }));
    const duplicate = journal.enqueue(patch("request-1", { status: "Available" }));
    expect(first.duplicate).toBe(false);
    expect(duplicate).toEqual({ duplicate: true, receipt: first.receipt });
    expect(journal.list()).toHaveLength(1);
    expect(() => journal.enqueue(patch("request-1", { status: "Repair" }))).toThrow(
      IdempotencyConflictError,
    );
  });

  it("uses UTF-8-safe bounded shards and manifest-last generations", () => {
    const { journal, properties } = fixture({ shardByteLimit: 256 });
    journal.enqueue(patch("request-1", { notes: "🎫".repeat(100) }));
    const shardValues = [...properties.values.entries()]
      .filter(([key]) => !key.endsWith(":manifest"))
      .map(([, value]) => value);
    expect(shardValues.length).toBeGreaterThan(1);
    expect(shardValues.every((value) => new TextEncoder().encode(value).length <= 256)).toBe(true);
    expect(journal.list()[0].values?.notes).toBe("🎫".repeat(100));
  });

  it("coalesces compatible patches and marks every source receipt committed", () => {
    const { journal } = fixture();
    const one = journal.enqueue(patch("request-1", { status: "Repair" }));
    const two = journal.enqueue(patch("request-2", { notes: "checked" }));
    let received = 0;
    const result = journal.flush(
      {
        apply: (mutations) => {
          received = mutations.length;
          expect(mutations[0].values).toEqual({ status: "Repair", notes: "checked" });
          return [{ mutationId: mutations[0].id, status: "committed" }];
        },
      },
      { write: () => undefined },
    );

    expect(received).toBe(1);
    expect(result).toMatchObject({ attempted: 2, committed: 2, coalesced: 1, retained: 0 });
    expect(journal.receipt(one.receipt.idempotencyKey)?.status).toBe("committed");
    expect(journal.receipt(two.receipt.idempotencyKey)?.status).toBe("committed");
  });

  it("moves conflicts to an idempotent dead-letter sink and retains transient failures", () => {
    const { journal } = fixture();
    journal.enqueue(patch("conflict", { status: "Repair" }));
    journal.enqueue({
      ...patch("transient", { status: "Assigned" }),
      key: { serial: "0002" },
    });
    const dead: DeferredDeadLetter[] = [];
    const result = journal.flush(
      {
        apply: (mutations): DeferredMutationOutcome[] => [
          { mutationId: mutations[0].id, status: "conflict", conflict: { expected: 2, actual: 3 } },
          { mutationId: mutations[1].id, status: "transient", message: "quota" },
        ],
      },
      { write: (records) => dead.push(...records) },
    );

    expect(result).toMatchObject({ conflicted: 1, committed: 0, retained: 1 });
    expect(dead).toHaveLength(1);
    expect(journal.receipt("conflict")?.status).toBe("conflicted");
    expect(journal.list()[0]).toMatchObject({ attempts: 1, lastError: "quota" });
  });

  it("holds one lock across remote application so overlapping flushes cannot reuse a snapshot", () => {
    const { journal } = fixture({ lockTimeoutMs: 1 });
    journal.enqueue(patch("request-1", { status: "Available" }));
    let applied = 0;
    let nestedApplied = 0;
    const deadLetters = { write: () => undefined };

    const first = journal.flush({
      apply: (mutations) => {
        applied += mutations.length;
        expect(() => journal.flush({
          apply: (nested) => {
            nestedApplied += nested.length;
            return nested.map((mutation) => ({ mutationId: mutation.id, status: "committed" as const }));
          },
        }, deadLetters)).toThrow(JournalLockTimeoutError);
        return mutations.map((mutation) => ({ mutationId: mutation.id, status: "committed" as const }));
      },
    }, deadLetters);

    expect(first).toMatchObject({ attempted: 1, committed: 1, retained: 0 });
    expect(applied).toBe(1);
    expect(nestedApplied).toBe(0);
    const duplicate = journal.flush({
      apply: (mutations) => {
        applied += mutations.length;
        return [];
      },
    }, deadLetters);
    expect(duplicate.attempted).toBe(0);
    expect(applied).toBe(1);
  });

  it("stores applied receipts in one bounded, age-pruned ledger", () => {
    const properties = new MemoryProperties();
    let now = 1;
    const ledger = new AppliedMutationReceiptLedger(properties, {
      namespace: "test",
      retainedReceiptLimit: 2,
      maximumBytes: 256,
      maximumAgeMs: 10,
      clock: { now: () => now },
    });

    ledger.mark("mutation-1");
    now = 2;
    ledger.mark("mutation-2");
    now = 3;
    ledger.mark("mutation-3");
    expect(ledger.list().map((receipt) => receipt.mutationId)).toEqual([
      "mutation-2",
      "mutation-3",
    ]);
    expect([...properties.values.keys()]).toEqual(["test:deferred-applied"]);
    expect(ledger.has("mutation-1")).toBe(false);
    expect(ledger.has("mutation-3")).toBe(true);

    ledger.forget(["mutation-2"]);
    expect(ledger.list().map((receipt) => receipt.mutationId)).toEqual(["mutation-3"]);
    now = 20;
    expect(ledger.prune()).toBe(1);
    expect(properties.get("test:deferred-applied")).toBeNull();
  });

  it("uses the applied ledger to recover without replay after journal cleanup publication fails", () => {
    const properties = new FailingManifestProperties();
    const lock = new MemoryLock();
    let id = 0;
    const journal = new DeferredJournal({
      properties,
      lock,
      hasher: new Fnv1aHash(),
      ids: { next: () => `recovery-${++id}` },
      clock: { now: () => 100 },
    });
    const ledger = new AppliedMutationReceiptLedger(properties, {
      namespace: "recovery",
      clock: { now: () => 100 },
    });
    let remoteApplications = 0;
    const executor = {
      apply: (mutations: readonly { readonly id: string }[]) => mutations.map((mutation) => {
        if (!ledger.has(mutation.id)) {
          remoteApplications += 1;
          ledger.mark(mutation.id);
        }
        return { mutationId: mutation.id, status: "committed" as const };
      }),
      forgetApplied: (mutationIds: readonly string[]) => ledger.forget(mutationIds),
    };
    journal.enqueue(patch("recover-once", { status: "Available" }));
    properties.failNextManifestPublication = true;

    expect(() => journal.flush(executor, { write: () => undefined })).toThrow(
      "simulated manifest publication failure",
    );
    expect(remoteApplications).toBe(1);
    expect(journal.list()).toHaveLength(1);
    expect(ledger.list()).toHaveLength(1);

    expect(journal.flush(executor, { write: () => undefined })).toMatchObject({
      attempted: 1,
      committed: 1,
      retained: 0,
    });
    expect(remoteApplications).toBe(1);
    expect(journal.list()).toHaveLength(0);
    expect(ledger.list()).toHaveLength(0);
  });

  it("offers immediate fallback when the bounded journal is full", () => {
    const { journal } = fixture({ shardByteLimit: 256, softByteLimit: 300 });
    const immediate = {
      idempotencyKey: "request-1",
      requestHash: "immediate",
      mutationId: "sync-1",
      status: "committed" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const result = journal.enqueueOrExecute(
      patch("request-1", { notes: "x".repeat(200) }),
      () => immediate,
    );
    expect(result.receipt).toBe(immediate);
    expect(journal.list()).toHaveLength(0);
  });

  it("raises a typed capacity error when no fallback is supplied", () => {
    const { journal } = fixture({ shardByteLimit: 256, softByteLimit: 300 });
    expect(() => journal.enqueue(patch("request-1", { notes: "x".repeat(200) }))).toThrow(
      JournalCapacityError,
    );
  });
});
