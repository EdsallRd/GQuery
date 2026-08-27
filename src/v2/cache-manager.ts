import type { RuntimeGenerationAdapter } from "./executor";
import { GQueryRuntimeError } from "./runtime-errors";
import type { DatabaseDefinition, InferTableRow, TableDefinition } from "./schema";

type AnyRow = Record<string, unknown>;
type TableName<D extends DatabaseDefinition> = Extract<keyof D["tables"], string>;
type TableAt<D extends DatabaseDefinition, N extends TableName<D>> = D["tables"][N];
type RowAt<D extends DatabaseDefinition, N extends TableName<D>> =
  Extract<InferTableRow<TableAt<D, N>>, AnyRow>;
type PrimaryKeyAt<D extends DatabaseDefinition, N extends TableName<D>> =
  TableAt<D, N> extends TableDefinition<
    infer _Columns,
    infer _Source,
    infer PrimaryKey,
    infer _Relations,
    infer _Unique
  > ? PrimaryKey : readonly string[];

/** Key accepted by cache row invalidation: a scalar for one-column keys, an object for composites. */
export type CacheRowKey<
  D extends DatabaseDefinition,
  N extends TableName<D>,
> = PrimaryKeyAt<D, N> extends readonly [infer Field extends keyof RowAt<D, N>]
  ? RowAt<D, N>[Field]
  : PrimaryKeyAt<D, N> extends readonly []
    ? never
    : Readonly<Pick<RowAt<D, N>, Extract<PrimaryKeyAt<D, N>[number], keyof RowAt<D, N>>>>;

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
export class CacheInvalidationManager<D extends DatabaseDefinition>
implements CacheInvalidationApi<D> {
  public constructor(private readonly options: CacheInvalidationManagerOptions<D>) {}

  public invalidateTable<N extends TableName<D>>(table: N): string {
    const generations = this.requireGenerations();
    const definition = this.table(table);
    return generations.invalidateTable(
      this.options.resolveSourceId(definition.source as Extract<keyof D["sources"], string>),
      table,
    );
  }

  public invalidateRow<N extends TableName<D>>(table: N, key: CacheRowKey<D, N>): string {
    const generations = this.requireGenerations();
    if (generations.invalidateRow === undefined) {
      throw this.unsupported("Row cache invalidation requires a generation store with row-token support.");
    }
    const definition = this.table(table);
    if (definition.primaryKey.length === 0) {
      throw new GQueryRuntimeError(
        "INVALID_QUERY",
        `Table ${table} has no primary key and cannot have a row generation invalidated.`,
        { details: { table } },
      );
    }
    const sourceId = this.options.resolveSourceId(
      definition.source as Extract<keyof D["sources"], string>,
    );
    // Current row caches are table snapshots. Rotate the broad dependency first
    // so freshness is preserved even if a custom narrow-row adapter then fails.
    generations.invalidateTable(sourceId, table);
    return generations.invalidateRow(
      sourceId,
      table,
      this.normalizeKey(table, definition.primaryKey, key),
    );
  }

  public invalidateTag(tag: string): string {
    const generations = this.requireGenerations();
    if (generations.invalidateTag === undefined) {
      throw this.unsupported("Tag cache invalidation requires a generation store with tag-token support.");
    }
    if (typeof tag !== "string" || tag.trim().length === 0) {
      throw new GQueryRuntimeError("INVALID_QUERY", "Cache invalidation tags must not be empty.");
    }
    const declared = Object.values(this.options.definition.tables).some(
      (table) => table.cache?.tags?.includes(tag) === true,
    );
    if (!declared) {
      throw new GQueryRuntimeError(
        "INVALID_QUERY",
        `Cache tag ${tag} is not declared by any table.`,
        { details: { tag } },
      );
    }
    return generations.invalidateTag(tag);
  }

  private table<N extends TableName<D>>(table: N): D["tables"][N] {
    const definition = this.options.definition.tables[table];
    if (definition === undefined) {
      throw new GQueryRuntimeError(
        "INVALID_QUERY",
        `Unknown table ${String(table)}.`,
        { details: { table } },
      );
    }
    return definition as D["tables"][N];
  }

  private normalizeKey(
    table: string,
    fields: readonly string[],
    input: unknown,
  ): Readonly<Record<string, unknown>> {
    if (fields.length === 1 && (input === null || typeof input !== "object" || input instanceof Date)) {
      return Object.freeze({ [fields[0]]: input });
    }
    if (input === null || typeof input !== "object" || Array.isArray(input) || input instanceof Date) {
      throw new GQueryRuntimeError(
        "INVALID_QUERY",
        `Composite cache key invalidation for ${table} requires an object.`,
        { details: { table, fields } },
      );
    }
    const key: Record<string, unknown> = {};
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(input, field)) {
        throw new GQueryRuntimeError(
          "INVALID_QUERY",
          `Cache row key for ${table} is missing ${field}.`,
          { details: { table, field, fields } },
        );
      }
      key[field] = (input as AnyRow)[field];
    }
    return Object.freeze(key);
  }

  private requireGenerations(): RuntimeGenerationAdapter {
    if (this.options.generations === undefined) {
      throw this.unsupported("Cache invalidation requires a durable generation store.");
    }
    return this.options.generations;
  }

  private unsupported(message: string): GQueryRuntimeError {
    return new GQueryRuntimeError("UNSUPPORTED_OPERATION", message);
  }
}
