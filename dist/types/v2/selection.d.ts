import type { ExecutionStats } from "./execution";
import type { MaterializedRow, RowProvenance } from "./provenance";
export type MutationStatus = "committed" | "queued" | "conflicted";
export interface MutationConflict {
    readonly code: "missing" | "key-changed" | "version-changed" | "schema-changed" | "duplicate-key";
    readonly table: string;
    readonly key: Readonly<Record<string, unknown>>;
    readonly rowIndex?: number;
    readonly expected?: unknown;
    readonly actual?: unknown;
    readonly message: string;
}
export interface PendingMutationReceipt {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly queuedAt: string;
    readonly operation: "update" | "delete" | "upsert" | "create";
    readonly table: string;
    readonly keys: readonly Readonly<Record<string, unknown>>[];
}
export interface MutationResult<T extends Record<string, unknown>> {
    readonly status: MutationStatus;
    readonly matchedCount: number;
    readonly changedCount: number;
    readonly changedCells: number;
    readonly conflicts: readonly MutationConflict[];
    readonly before?: Selection<T>;
    readonly after?: Selection<T>;
    readonly stats: ExecutionStats;
    readonly receipt?: PendingMutationReceipt;
}
export type MutationPatch<T extends Record<string, unknown>> = Partial<T> | ((draft: T) => Partial<T> | void);
export interface MutationOptions {
    readonly delivery?: "immediate" | "deferred";
    readonly idempotencyKey?: string;
    readonly actor?: string;
    readonly fanout?: boolean;
    readonly includeBefore?: boolean;
    readonly includeAfter?: boolean;
}
export interface DeleteOptions extends MutationOptions {
}
export interface SelectionRuntime {
    refresh<T extends Record<string, unknown>>(selection: Selection<T>): Selection<T>;
    update<T extends Record<string, unknown>>(selection: Selection<T>, patch: MutationPatch<T>, options?: MutationOptions): MutationResult<T>;
    delete<T extends Record<string, unknown>>(selection: Selection<T>, options?: DeleteOptions): MutationResult<T>;
}
export declare const SELECTION_INTERNAL: unique symbol;
export interface SelectionInternal<T extends Record<string, unknown>> {
    readonly materialized: readonly MaterializedRow<T>[];
    readonly runtime: SelectionRuntime;
    readonly refresh: (() => Selection<T>) | null;
    readonly fanoutRequired: boolean;
}
type RelatedRow<Value> = NonNullable<Value> extends readonly (infer Item)[] ? Extract<Item, Record<string, unknown>> : Extract<NonNullable<Value>, Record<string, unknown>>;
/**
 * An immutable result set. Its public data is serializable; physical row
 * provenance is retained behind a symbol for safe targeted mutations.
 */
export declare class Selection<T extends Record<string, unknown>> {
    readonly rows: readonly Readonly<T>[];
    readonly headers: readonly (keyof T & string)[];
    readonly stats: ExecutionStats;
    readonly [SELECTION_INTERNAL]: SelectionInternal<T>;
    constructor(materialized: readonly MaterializedRow<T>[], headers: readonly (keyof T & string)[], stats: ExecutionStats, runtime: SelectionRuntime, refresh?: (() => Selection<T>) | null, fanoutRequired?: boolean);
    get length(): number;
    toJSON(): {
        readonly headers: readonly (keyof T & string)[];
        readonly rows: readonly Readonly<T>[];
    };
    refresh(): Selection<T>;
    update(patch: MutationPatch<T>, options?: MutationOptions): MutationResult<T>;
    delete(options?: DeleteOptions): MutationResult<T>;
    /** Select and deduplicate the physical rows retained for an included/joined relation. */
    related<K extends keyof T & string>(name: K): Selection<RelatedRow<T[K]>>;
}
export declare function selectionProvenance<T extends Record<string, unknown>>(selection: Selection<T>): readonly RowProvenance[];
export {};
