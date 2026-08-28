import type { RuntimeGenerationAdapter } from "./executor";
import type { DatabaseDefinition, InferTableRow, TableDefinition } from "./schema";
type AnyRow = Record<string, unknown>;
type TableName<D extends DatabaseDefinition> = Extract<keyof D["tables"], string>;
type TableAt<D extends DatabaseDefinition, N extends TableName<D>> = D["tables"][N];
type RowAt<D extends DatabaseDefinition, N extends TableName<D>> = Extract<InferTableRow<TableAt<D, N>>, AnyRow>;
type PrimaryKeyAt<D extends DatabaseDefinition, N extends TableName<D>> = TableAt<D, N> extends TableDefinition<infer _Columns, infer _Source, infer PrimaryKey, infer _Relations, infer _Unique> ? PrimaryKey : readonly string[];
/** Key accepted by cache row invalidation: a scalar for one-column keys, an object for composites. */
export type CacheRowKey<D extends DatabaseDefinition, N extends TableName<D>> = PrimaryKeyAt<D, N> extends readonly [infer Field extends keyof RowAt<D, N>] ? RowAt<D, N>[Field] : PrimaryKeyAt<D, N> extends readonly [] ? never : Readonly<Pick<RowAt<D, N>, Extract<PrimaryKeyAt<D, N>[number], keyof RowAt<D, N>>>>;
export interface CacheInvalidationApi<D extends DatabaseDefinition> {
    invalidateTable<N extends TableName<D>>(table: N): string;
    invalidateRow<N extends TableName<D>>(table: N, key: CacheRowKey<D, N>): string;
    invalidateTag(tag: string): string;
}
interface CacheInvalidationManagerOptions<D extends DatabaseDefinition> {
    readonly definition: D;
    readonly generations?: RuntimeGenerationAdapter;
    readonly resolveSourceId: (sourceName: Extract<keyof D["sources"], string>) => string;
}
/** Public generation rotation surface. It never reads cache payloads or executes a table query. */
export declare class CacheInvalidationManager<D extends DatabaseDefinition> implements CacheInvalidationApi<D> {
    private readonly options;
    constructor(options: CacheInvalidationManagerOptions<D>);
    invalidateTable<N extends TableName<D>>(table: N): string;
    invalidateRow<N extends TableName<D>>(table: N, key: CacheRowKey<D, N>): string;
    invalidateTag(tag: string): string;
    private table;
    private normalizeKey;
    private requireGenerations;
    private unsupported;
}
export {};
