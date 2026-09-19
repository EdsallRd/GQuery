import { querySnapshotRows, type ReadQueryPlan } from "./get";
import type { GQueryResult, GQueryRow } from "./types";

function copy<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T;
  }
  return value;
}

/** Explicit, read-only snapshot. Create a new one after writes; never shared across RPCs. */
export class GQueryReadSnapshot {
  private readonly tables: Record<string, GQueryResult>;
  constructor(tables: Record<string, GQueryResult>) { this.tables = copy(tables); }
  from<T extends Record<string, any> = Record<string, any>>(sheetName: string): GQuerySnapshotTable<T> {
    if (!Object.prototype.hasOwnProperty.call(this.tables, sheetName)) throw new Error(`Sheet not captured in snapshot: ${sheetName}`);
    return new GQuerySnapshotTable<T>(this.tables, sheetName);
  }
}

export class GQuerySnapshotTable<T extends Record<string, any> = Record<string, any>> {
  private readonly plan: ReadQueryPlan = { joinOption: [] };
  private ordering?: { field: string; direction: "asc" | "desc" };
  private count?: number;
  private skip?: number;
  constructor(private readonly tables: Record<string, GQueryResult>, private readonly sheetName: string) {}
  where(predicate: (row: GQueryRow<T>) => boolean): this { this.plan.filterOption = predicate; return this; }
  select(columns: string[]): this { this.plan.selectOption = [...columns]; return this; }
  join(sheetName: string, sheetColumn: string, joinColumn: string, columnsToReturn?: string[]): this {
    if (!Object.prototype.hasOwnProperty.call(this.tables, sheetName)) throw new Error(`Sheet not captured in snapshot: ${sheetName}`);
    this.plan.joinOption.push({ sheetName, sheetColumn, joinColumn, columnsToReturn });
    return this;
  }
  orderBy(field: keyof T & string, direction: "asc" | "desc" = "asc"): this { this.ordering = { field, direction }; return this; }
  limit(count: number): this { this.count = count; return this; }
  offset(skip: number): this { this.skip = skip; return this; }
  get(): GQueryResult<T> {
    // Copy before callbacks so even a mutating predicate cannot modify the snapshot.
    return querySnapshotRows<T>(copy(this.tables), this.sheetName, this.plan, undefined, undefined, this.ordering, this.count, this.skip);
  }
}
