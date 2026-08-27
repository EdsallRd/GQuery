import type { ExecutionStats } from "./execution";
import type { MaterializedRow, RowProvenance } from "./provenance";
import { GQueryRuntimeError } from "./runtime-errors";

export type MutationStatus = "committed" | "queued" | "conflicted";

export interface MutationConflict {
  readonly code:
    | "missing"
    | "key-changed"
    | "version-changed"
    | "schema-changed"
    | "duplicate-key"
    | "foreign-key-missing";
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

export type MutationPatch<T extends Record<string, unknown>> =
  | Partial<T>
  | ((draft: T) => Partial<T> | void);

export interface MutationOptions {
  readonly delivery?: "immediate" | "deferred";
  readonly idempotencyKey?: string;
  readonly actor?: string;
  readonly fanout?: boolean;
  readonly includeBefore?: boolean;
  readonly includeAfter?: boolean;
}

export interface DeleteOptions extends MutationOptions {}

export interface SelectionRuntime {
  refresh<T extends Record<string, unknown>>(
    selection: Selection<T>,
  ): Selection<T>;

  update<T extends Record<string, unknown>>(
    selection: Selection<T>,
    patch: MutationPatch<T>,
    options?: MutationOptions,
  ): MutationResult<T>;

  delete<T extends Record<string, unknown>>(
    selection: Selection<T>,
    options?: DeleteOptions,
  ): MutationResult<T>;
}

export const SELECTION_INTERNAL = Symbol("gquery.selection.internal");

export interface SelectionInternal<T extends Record<string, unknown>> {
  readonly materialized: readonly MaterializedRow<T>[];
  readonly runtime: SelectionRuntime;
  readonly refresh: (() => Selection<T>) | null;
  readonly fanoutRequired: boolean;
}

export type SelectionJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SelectionJsonValue[]
  | { readonly [key: string]: SelectionJsonValue };

export interface SelectionJSON {
  readonly headers: readonly string[];
  readonly rows: readonly { readonly [key: string]: SelectionJsonValue }[];
}

type RelatedRow<Value> = NonNullable<Value> extends readonly (infer Item)[]
  ? Extract<Item, Record<string, unknown>>
  : Extract<NonNullable<Value>, Record<string, unknown>>;

function cloneAndFreeze<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value instanceof Date) return Object.freeze(new Date(value.getTime())) as T;
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing as T;
    const copy: unknown[] = [];
    seen.set(value, copy);
    copy.push(...value.map((entry) => cloneAndFreeze(entry, seen)));
    return Object.freeze(copy) as T;
  }
  if (value !== null && typeof value === "object") {
    const existing = seen.get(value as object);
    if (existing !== undefined) return existing as T;
    const copy: Record<string, unknown> = {};
    seen.set(value as object, copy);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(copy, key, {
        value: cloneAndFreeze(entry, seen),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(copy) as T;
  }
  return value;
}

function jsonSafe(value: unknown, ancestors = new Set<object>()): SelectionJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (value === undefined) return Object.freeze({ $gquery: "undefined" });
  if (typeof value === "bigint") {
    return Object.freeze({ $gquery: "bigint", value: value.toString() });
  }
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    const encoded = Number.isNaN(value)
      ? "NaN"
      : value === Infinity
        ? "Infinity"
        : value === -Infinity
          ? "-Infinity"
          : "-0";
    return Object.freeze({ $gquery: "number", value: encoded });
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("Selection JSON cannot encode an invalid Date.");
    return Object.freeze({ $gquery: "date", value: value.toISOString() });
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Selection JSON cannot encode ${typeof value} values.`);
  }
  if (typeof value !== "object") throw new TypeError("Selection JSON encountered an unsupported value.");
  if (ancestors.has(value)) throw new TypeError("Selection JSON cannot encode circular values.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((entry) => jsonSafe(entry, ancestors)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Selection JSON can encode only plain objects and supported tagged values.");
    }
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry, ancestors)]),
    ));
  } finally {
    ancestors.delete(value);
  }
}

/**
 * An immutable result set. Its public data is serializable; physical row
 * provenance is retained behind a symbol for safe targeted mutations.
 */
export class Selection<T extends Record<string, unknown>> {
  public readonly rows: readonly Readonly<T>[];
  public readonly headers: readonly (keyof T & string)[];
  public readonly stats: ExecutionStats;
  public readonly [SELECTION_INTERNAL]: SelectionInternal<T>;

  public constructor(
    materialized: readonly MaterializedRow<T>[],
    headers: readonly (keyof T & string)[],
    stats: ExecutionStats,
    runtime: SelectionRuntime,
    refresh: (() => Selection<T>) | null = null,
    fanoutRequired = false,
  ) {
    const frozenMaterialized = materialized.map((item) => Object.freeze({
      value: cloneAndFreeze(item.value),
      provenance: item.provenance,
    }));
    // Keep public DTOs separate from hidden mutation state. Even mutable
    // built-ins such as Date can then be changed by a caller without altering
    // the key/version-bearing materialized selection.
    this.rows = Object.freeze(frozenMaterialized.map((item) => cloneAndFreeze(item.value)));
    this.headers = Object.freeze([...headers]);
    this.stats = Object.freeze({
      ...stats,
      rangesRead: Object.freeze([...stats.rangesRead]) as unknown as string[],
      rangesWritten: Object.freeze([...stats.rangesWritten]) as unknown as string[],
    });
    this[SELECTION_INTERNAL] = Object.freeze({
      materialized: Object.freeze(frozenMaterialized),
      runtime,
      refresh,
      fanoutRequired,
    });
    Object.freeze(this);
  }

  public get length(): number {
    return this.rows.length;
  }

  public toJSON(): SelectionJSON {
    return Object.freeze({
      headers: this.headers,
      rows: Object.freeze(this.rows.map((row) =>
        jsonSafe(row) as { readonly [key: string]: SelectionJsonValue },
      )),
    });
  }

  public refresh(): Selection<T> {
    const refresh = this[SELECTION_INTERNAL].refresh;
    return refresh === null ? this[SELECTION_INTERNAL].runtime.refresh(this) : refresh();
  }

  public update(
    patch: MutationPatch<T>,
    options: MutationOptions = {},
  ): MutationResult<T> {
    if (this[SELECTION_INTERNAL].fanoutRequired && options.fanout !== true) {
      throw new GQueryRuntimeError(
        "MUTATION_INVALID",
        "Updating a to-many relation requires { fanout: true }.",
      );
    }
    return this[SELECTION_INTERNAL].runtime.update(this, patch, options);
  }

  public delete(options: DeleteOptions = {}): MutationResult<T> {
    if (this[SELECTION_INTERNAL].fanoutRequired && options.fanout !== true) {
      throw new GQueryRuntimeError(
        "MUTATION_INVALID",
        "Deleting through a to-many relation requires { fanout: true }.",
      );
    }
    return this[SELECTION_INTERNAL].runtime.delete(this, options);
  }

  /** Select and deduplicate the physical rows retained for an included/joined relation. */
  public related<K extends keyof T & string>(
    name: K,
  ): Selection<RelatedRow<T[K]>> {
    type R = RelatedRow<T[K]>;
    const seen = new Set<string>();
    const related: MaterializedRow<R>[] = [];
    let fanoutRequired = false;

    for (const item of this[SELECTION_INTERNAL].materialized) {
      const provenances = item.provenance.relations[name] ?? [];
      if (
        item.provenance.relationCardinalities[name] === "many" ||
        provenances.length > 1
      ) {
        fanoutRequired = true;
      }
      const raw = item.value[name];
      const values = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
      for (let index = 0; index < provenances.length; index += 1) {
        const provenance = provenances[index];
        const identity = `${provenance.spreadsheetId}:${provenance.sheetId}:${provenance.rowIndex}`;
        if (seen.has(identity)) continue;
        const value = values[index] as R | undefined;
        if (value === undefined || value === null || typeof value !== "object") continue;
        seen.add(identity);
        related.push({ value, provenance });
      }
    }

    if (related.length === 0) {
      const knownRelation = this[SELECTION_INTERNAL].materialized.some(
        (item) => Object.prototype.hasOwnProperty.call(item.provenance.relations, name),
      );
      if (!knownRelation) {
        throw new GQueryRuntimeError(
          "RELATION_NOT_FOUND",
          `Relation ${name} was not materialized. Add include(${JSON.stringify(name)}) or join it first.`,
        );
      }
    }

    const headers = related.length === 0
      ? []
      : Object.keys(related[0].value) as (keyof R & string)[];
    return new Selection(
      related,
      headers,
      this.stats,
      this[SELECTION_INTERNAL].runtime,
      null,
      fanoutRequired,
    );
  }
}

export function selectionProvenance<T extends Record<string, unknown>>(
  selection: Selection<T>,
): readonly RowProvenance[] {
  return selection[SELECTION_INTERNAL].materialized.map((item) => item.provenance);
}
