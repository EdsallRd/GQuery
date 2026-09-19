import type { GQueryResult, GQueryRow } from "./types";
/** Explicit, read-only snapshot. Create a new one after writes; never shared across RPCs. */
export declare class GQueryReadSnapshot {
    private readonly tables;
    constructor(tables: Record<string, GQueryResult>);
    from<T extends Record<string, any> = Record<string, any>>(sheetName: string): GQuerySnapshotTable<T>;
}
export declare class GQuerySnapshotTable<T extends Record<string, any> = Record<string, any>> {
    private readonly tables;
    private readonly sheetName;
    private readonly plan;
    private ordering?;
    private count?;
    private skip?;
    constructor(tables: Record<string, GQueryResult>, sheetName: string);
    where(predicate: (row: GQueryRow<T>) => boolean): this;
    select(columns: string[]): this;
    join(sheetName: string, sheetColumn: string, joinColumn: string, columnsToReturn?: string[]): this;
    orderBy(field: keyof T & string, direction?: "asc" | "desc"): this;
    limit(count: number): this;
    offset(skip: number): this;
    get(): GQueryResult<T>;
}
