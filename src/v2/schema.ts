import {
  type ColumnDefinition,
  type InferColumn,
  isColumnDefinition,
} from "./codecs";
import { GQueryDefinitionError } from "./errors";

// `any` is intentional in heterogeneous definition maps. The concrete value type
// remains available through each ColumnDefinition and InferColumn/InferRow.
export type ColumnMap = Readonly<Record<string, ColumnDefinition<any>>>;
export type ColumnKey<Columns extends ColumnMap> = Extract<keyof Columns, string>;
export type InferRow<Columns extends ColumnMap> = {
  -readonly [Key in keyof Columns]: InferColumn<Columns[Key]>;
};

export interface ActiveSpreadsheetSourceDefinition {
  readonly __gquerySource: true;
  readonly kind: "active-spreadsheet";
}

export interface SpreadsheetIdSourceDefinition<Id extends string = string> {
  readonly __gquerySource: true;
  readonly kind: "spreadsheet-id";
  readonly spreadsheetId: Id;
}

export type SourceDefinition =
  | ActiveSpreadsheetSourceDefinition
  | SpreadsheetIdSourceDefinition;

export type SourceMap = Readonly<Record<string, SourceDefinition>>;

const activeSpreadsheetSource: ActiveSpreadsheetSourceDefinition = Object.freeze({
  __gquerySource: true,
  kind: "active-spreadsheet",
});

/** Source constructors are descriptors only; they never open a spreadsheet. */
export const source = Object.freeze({
  activeSpreadsheet(): ActiveSpreadsheetSourceDefinition {
    return activeSpreadsheetSource;
  },
  byId<const Id extends string>(spreadsheetId: Id): SpreadsheetIdSourceDefinition<Id> {
    if (spreadsheetId.trim().length === 0) {
      throw new GQueryDefinitionError("Spreadsheet source ID must not be empty.");
    }
    return Object.freeze({
      __gquerySource: true,
      kind: "spreadsheet-id",
      spreadsheetId,
    });
  },
});

export type RelationKind = "belongs-to" | "has-one" | "has-many";
export type RelationCardinality = "one" | "many";
export type DeleteBehavior = "restrict" | "cascade" | "set-null" | "no-action";
export type RelationKey<Key extends string = string> =
  | Key
  | readonly [Key, ...Key[]];

export interface RelationDefinition<
  Kind extends RelationKind = RelationKind,
  Target extends string = string,
  Local extends RelationKey = RelationKey,
  Foreign extends RelationKey = RelationKey,
> {
  readonly __gqueryRelation: true;
  readonly kind: Kind;
  readonly cardinality: Kind extends "has-many" ? "many" : "one";
  readonly target: Target;
  readonly local: Local;
  readonly foreign: Foreign;
  readonly required: boolean;
  readonly onDelete: DeleteBehavior;
}

export type RelationMap = Readonly<
  Record<string, RelationDefinition<any, any, any, any>>
>;

export interface RelationOptions<
  Local extends RelationKey,
  Foreign extends RelationKey,
> {
  readonly local: Local;
  readonly foreign: Foreign;
  readonly required?: boolean;
  readonly onDelete?: DeleteBehavior;
}

function copyRelationKey<Key extends RelationKey>(key: Key): Key {
  return (Array.isArray(key) ? Object.freeze([...key]) : key) as Key;
}

function relationKeyParts(key: RelationKey): readonly string[] {
  return typeof key === "string" ? [key] : key;
}

function defineRelation<
  Kind extends RelationKind,
  const Target extends string,
  const Local extends RelationKey,
  const Foreign extends RelationKey,
>(
  kind: Kind,
  target: Target,
  options: RelationOptions<Local, Foreign>,
): RelationDefinition<Kind, Target, Local, Foreign> {
  if (target.trim().length === 0) {
    throw new GQueryDefinitionError("Relation target must not be empty.");
  }
  const local = copyRelationKey(options.local);
  const foreign = copyRelationKey(options.foreign);
  const localLength = Array.isArray(local) ? local.length : 1;
  const foreignLength = Array.isArray(foreign) ? foreign.length : 1;
  if (localLength === 0 || foreignLength === 0 || localLength !== foreignLength) {
    throw new GQueryDefinitionError(
      `Relation ${target} local and foreign keys must be non-empty and have matching arity.`,
      { target, localLength, foreignLength },
    );
  }
  const onDelete = options.onDelete ?? "restrict";
  if (onDelete === "set-null" && (options.required ?? false)) {
    throw new GQueryDefinitionError(
      `Required relation ${target} cannot use set-null delete behavior.`,
      { target },
    );
  }
  return Object.freeze({
    __gqueryRelation: true,
    kind,
    cardinality: (kind === "has-many" ? "many" : "one") as RelationDefinition<Kind>["cardinality"],
    target,
    local,
    foreign,
    required: options.required ?? false,
    onDelete,
  });
}

export function belongsTo<
  const Target extends string,
  const Local extends RelationKey,
  const Foreign extends RelationKey,
>(
  target: Target,
  options: RelationOptions<Local, Foreign>,
): RelationDefinition<"belongs-to", Target, Local, Foreign> {
  return defineRelation("belongs-to", target, options);
}

export function hasOne<
  const Target extends string,
  const Local extends RelationKey,
  const Foreign extends RelationKey,
>(
  target: Target,
  options: RelationOptions<Local, Foreign>,
): RelationDefinition<"has-one", Target, Local, Foreign> {
  return defineRelation("has-one", target, options);
}

export function hasMany<
  const Target extends string,
  const Local extends RelationKey,
  const Foreign extends RelationKey,
>(
  target: Target,
  options: RelationOptions<Local, Foreign>,
): RelationDefinition<"has-many", Target, Local, Foreign> {
  return defineRelation("has-many", target, options);
}

export type CacheMode = "row" | "query" | "row-and-query";
export type CacheScope = "script" | "document" | "user";

export interface TableCacheDefinition<
  Columns extends ColumnMap = ColumnMap,
> {
  readonly mode: CacheMode;
  readonly scope: CacheScope;
  readonly ttlSeconds: number;
  readonly jitterSeconds?: number;
  readonly indexes?: readonly (readonly ColumnKey<Columns>[])[];
  readonly tags?: readonly string[];
  readonly allowStaleOnQuota?: boolean;
}

export type NonEmptyKey<Columns extends ColumnMap> = readonly [
  ColumnKey<Columns>,
  ...ColumnKey<Columns>[],
];

export interface TableConfig<
  Columns extends ColumnMap,
  SourceName extends string,
  PrimaryKey extends readonly ColumnKey<Columns>[],
  Unique extends readonly (readonly ColumnKey<Columns>[])[],
  Relations extends RelationMap,
> {
  readonly source: SourceName;
  readonly sheet: string;
  readonly columns: Columns;
  readonly primaryKey?: PrimaryKey;
  readonly unique?: Unique;
  readonly versionColumn?: string;
  readonly relations?: Relations;
  readonly cache?: TableCacheDefinition<Columns>;
  readonly appendOnly?: boolean;
}

type TableInput = {
  readonly source: string;
  readonly sheet: string;
  readonly columns: ColumnMap;
  readonly primaryKey?: readonly string[];
  readonly unique?: readonly (readonly string[])[];
  readonly versionColumn?: string;
  readonly relations?: RelationMap;
  readonly cache?: {
    readonly mode: CacheMode;
    readonly scope: CacheScope;
    readonly ttlSeconds: number;
    readonly jitterSeconds?: number;
    readonly indexes?: readonly (readonly string[])[];
    readonly tags?: readonly string[];
    readonly allowStaleOnQuota?: boolean;
  };
  readonly appendOnly?: boolean;
};

type ConfigColumns<Config extends TableInput> = Config["columns"];

type ConfigPrimaryKey<Config extends TableInput> = Config extends {
  readonly primaryKey: infer Key extends readonly string[];
}
  ? Key & readonly ColumnKey<ConfigColumns<Config>>[]
  : readonly [];

type ConfigUnique<Config extends TableInput> = Config extends {
  readonly unique: infer Keys extends readonly (readonly string[])[];
}
  ? Keys & readonly (readonly ColumnKey<ConfigColumns<Config>>[])[]
  : readonly [];

type ConfigRelations<Config extends TableInput> = Config extends {
  readonly relations: infer Relations extends RelationMap;
}
  ? Relations
  : {};

export interface TableDefinition<
  Columns extends ColumnMap = ColumnMap,
  SourceName extends string = string,
  PrimaryKey extends readonly ColumnKey<Columns>[] = readonly ColumnKey<Columns>[],
  Relations extends RelationMap = RelationMap,
  Unique extends readonly (readonly ColumnKey<Columns>[])[] = readonly (readonly ColumnKey<Columns>[])[],
> {
  readonly __gqueryTable: true;
  readonly source: SourceName;
  readonly sheet: string;
  readonly columns: Columns;
  readonly primaryKey: PrimaryKey;
  readonly unique: Unique;
  readonly versionColumn?: string;
  readonly relations: Relations;
  readonly cache?: TableCacheDefinition<Columns>;
  readonly appendOnly: boolean;
}

export type TableMap = Readonly<
  Record<string, TableDefinition<any, any, any, any, any>>
>;
export type InferTableRow<Table> = Table extends {
  readonly columns: infer Columns extends ColumnMap;
}
  ? InferRow<Columns>
  : never;
export type InferDatabaseRows<Tables extends TableMap> = {
  [Name in keyof Tables]: InferTableRow<Tables[Name]>;
};

type RelationField<R extends RelationKey> = R extends readonly string[]
  ? R[number]
  : R;

function validateKeySet(
  label: string,
  keys: readonly string[],
  columnNames: ReadonlySet<string>,
): void {
  if (keys.length === 0) {
    throw new GQueryDefinitionError(`${label} must contain at least one column.`);
  }
  if (new Set(keys).size !== keys.length) {
    throw new GQueryDefinitionError(`${label} must not contain duplicate columns.`);
  }
  const missing = keys.filter((key) => !columnNames.has(key));
  if (missing.length > 0) {
    throw new GQueryDefinitionError(
      `${label} references unknown column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
      { missing },
    );
  }
}

function validateCache<Columns extends ColumnMap>(
  cache: TableCacheDefinition<Columns> | undefined,
  columnNames: ReadonlySet<string>,
): void {
  if (cache === undefined) return;
  if (!Number.isInteger(cache.ttlSeconds) || cache.ttlSeconds < 1) {
    throw new GQueryDefinitionError("Cache ttlSeconds must be a positive integer.");
  }
  if (
    cache.jitterSeconds !== undefined &&
    (!Number.isInteger(cache.jitterSeconds) ||
      cache.jitterSeconds < 0 ||
      cache.jitterSeconds >= cache.ttlSeconds)
  ) {
    throw new GQueryDefinitionError(
      "Cache jitterSeconds must be a non-negative integer smaller than ttlSeconds.",
    );
  }
  for (const [index, keys] of (cache.indexes ?? []).entries()) {
    validateKeySet(`Cache index ${index}`, keys, columnNames);
  }
  const seenTags = new Set<string>();
  for (const tag of cache.tags ?? []) {
    if (typeof tag !== "string" || tag.length === 0 || tag.trim() !== tag) {
      throw new GQueryDefinitionError(
        "Cache tags must be non-empty strings without surrounding whitespace.",
        { tag },
      );
    }
    if (seenTags.has(tag)) {
      throw new GQueryDefinitionError(`Cache tag ${tag} is declared more than once.`, { tag });
    }
    seenTags.add(tag);
  }
}

export function table<
  const Config extends TableInput,
>(
  config: Config,
): TableDefinition<
  ConfigColumns<Config>,
  Config["source"],
  ConfigPrimaryKey<Config>,
  ConfigRelations<Config>,
  ConfigUnique<Config>
> {
  if (config.source.trim().length === 0) {
    throw new GQueryDefinitionError("Table source name must not be empty.");
  }
  if (config.sheet.trim().length === 0) {
    throw new GQueryDefinitionError("Table sheet name must not be empty.");
  }
  if (config.versionColumn !== undefined && config.versionColumn.trim().length === 0) {
    throw new GQueryDefinitionError("Table versionColumn must not be empty.");
  }

  const columns = { ...config.columns } as ConfigColumns<Config>;
  const columnNames = Object.keys(columns);
  if (columnNames.length === 0) {
    throw new GQueryDefinitionError(`Table ${config.sheet} must define at least one column.`);
  }
  const seenHeaders = new Set<string>();
  for (const [name, column] of Object.entries(columns)) {
    if (!isColumnDefinition(column)) {
      throw new GQueryDefinitionError(`Table ${config.sheet} column ${name} is not a column definition.`);
    }
    const header = column.header ?? name;
    if (seenHeaders.has(header)) {
      throw new GQueryDefinitionError(
        `Table ${config.sheet} maps more than one column to header ${header}.`,
        { header },
      );
    }
    seenHeaders.add(header);
  }

  const columnNameSet = new Set(columnNames);
  const primaryKey = Object.freeze([...(config.primaryKey ?? [])]) as unknown as ConfigPrimaryKey<Config>;
  if (primaryKey.length > 0) validateKeySet("Primary key", primaryKey, columnNameSet);
  const unique = Object.freeze(
    (config.unique ?? []).map((keys) => Object.freeze([...keys])),
  ) as unknown as ConfigUnique<Config>;
  unique.forEach((keys, index) => validateKeySet(`Unique key ${index}`, keys, columnNameSet));

  const relations = { ...(config.relations ?? {}) } as ConfigRelations<Config>;
  for (const [name, relation] of Object.entries(relations as RelationMap)) {
    if (columnNameSet.has(name)) {
      throw new GQueryDefinitionError(
        `Table ${config.sheet} relation ${name} collides with a column property of the same name.`,
        { table: config.sheet, relation: name },
      );
    }
    if (
      typeof relation !== "object" ||
      relation === null ||
      (relation as { __gqueryRelation?: unknown }).__gqueryRelation !== true
    ) {
      throw new GQueryDefinitionError(`Table ${config.sheet} relation ${name} is not a relation definition.`);
    }
    const local = relationKeyParts(relation.local);
    validateKeySet(`Relation ${name} local key`, local, columnNameSet);
  }

  validateCache(config.cache, columnNameSet);
  const cache = config.cache === undefined
    ? undefined
    : Object.freeze({
        ...config.cache,
        indexes: config.cache.indexes === undefined
          ? undefined
          : Object.freeze(
              config.cache.indexes.map((keys) => Object.freeze([...keys])),
            ),
        tags: config.cache.tags === undefined
          ? undefined
          : Object.freeze([...config.cache.tags].sort()),
      }) as TableCacheDefinition<ConfigColumns<Config>>;

  return Object.freeze({
    __gqueryTable: true,
    source: config.source,
    sheet: config.sheet,
    columns: Object.freeze(columns),
    primaryKey,
    unique,
    versionColumn: config.versionColumn,
    relations: Object.freeze(relations) as ConfigRelations<Config>,
    cache,
    appendOnly: config.appendOnly ?? false,
  });
}

type TableSourceName<Table> = Table extends { readonly source: infer SourceName }
  ? SourceName
  : never;

type TableRelations<Table> = Table extends { readonly relations: infer Relations }
  ? Relations
  : never;

type TableColumns<Table> = Table extends { readonly columns: infer Columns }
  ? Columns
  : never;

type InvalidSourceNames<Sources extends SourceMap, Tables extends TableMap> = {
  [Name in keyof Tables]: Exclude<TableSourceName<Tables[Name]>, keyof Sources>;
}[keyof Tables];

type InvalidRelationTargets<Tables extends TableMap> = {
  [TableName in keyof Tables]: {
    [RelationName in keyof TableRelations<Tables[TableName]>]: Exclude<
      TableRelations<Tables[TableName]>[RelationName]["target"],
      keyof Tables
    >;
  }[keyof TableRelations<Tables[TableName]>];
}[keyof Tables];

type InvalidRelationLocalFields<Tables extends TableMap> = {
  [TableName in keyof Tables]: {
    [RelationName in keyof TableRelations<Tables[TableName]>]: Exclude<
      RelationField<TableRelations<Tables[TableName]>[RelationName]["local"]>,
      ColumnKey<TableColumns<Tables[TableName]>>
    >;
  }[keyof TableRelations<Tables[TableName]>];
}[keyof Tables];

type TargetColumns<
  Tables extends TableMap,
  Target extends string,
> = Target extends keyof Tables
  ? Tables[Target] extends { readonly columns: infer Columns extends ColumnMap }
    ? ColumnKey<Columns>
    : never
  : never;

type InvalidRelationForeignFields<Tables extends TableMap> = {
  [TableName in keyof Tables]: {
    [RelationName in keyof TableRelations<Tables[TableName]>]: Exclude<
      RelationField<TableRelations<Tables[TableName]>[RelationName]["foreign"]>,
      TargetColumns<
        Tables,
        TableRelations<Tables[TableName]>[RelationName]["target"]
      >
    >;
  }[keyof TableRelations<Tables[TableName]>];
}[keyof Tables];

type DatabaseValidation<
  Sources extends SourceMap,
  Tables extends TableMap,
> = [
  | InvalidSourceNames<Sources, Tables>
  | InvalidRelationTargets<Tables>
  | InvalidRelationLocalFields<Tables>
  | InvalidRelationForeignFields<Tables>,
] extends [never]
  ? unknown
  : {
      readonly __invalidDatabaseReferences__: {
        readonly sources: InvalidSourceNames<Sources, Tables>;
        readonly relationTargets: InvalidRelationTargets<Tables>;
        readonly relationLocalFields: InvalidRelationLocalFields<Tables>;
        readonly relationForeignFields: InvalidRelationForeignFields<Tables>;
      };
    };

export interface DatabaseDefinition<
  Tables extends TableMap = TableMap,
  Sources extends SourceMap = SourceMap,
> {
  readonly __gqueryDatabase: true;
  readonly version: 2;
  readonly sources: Sources;
  readonly tables: Tables;
}

export interface DatabaseConfig<
  Sources extends SourceMap,
  Tables extends TableMap,
> {
  readonly version: 2;
  readonly sources: Sources;
  readonly tables: Tables;
}

export function defineDatabase<
  const Sources extends SourceMap,
  const Tables extends TableMap,
>(
  config: DatabaseConfig<Sources, Tables> & DatabaseValidation<Sources, Tables>,
): DatabaseDefinition<Tables, Sources> {
  if (config.version !== 2) {
    throw new GQueryDefinitionError("GQuery v2 schemas must declare version: 2.");
  }
  const sources = { ...config.sources } as Sources;
  for (const [name, definition] of Object.entries(sources)) {
    if (name.trim().length === 0) {
      throw new GQueryDefinitionError("Database source names must not be empty.");
    }
    if (
      typeof definition !== "object" ||
      definition === null ||
      (definition as { __gquerySource?: unknown }).__gquerySource !== true
    ) {
      throw new GQueryDefinitionError(`Database source ${name} is not a source definition.`);
    }
  }

  const tables = { ...config.tables } as Tables;
  for (const [name, definition] of Object.entries(tables)) {
    if (name.trim().length === 0) {
      throw new GQueryDefinitionError("Database table names must not be empty.");
    }
    if (
      typeof definition !== "object" ||
      definition === null ||
      (definition as { __gqueryTable?: unknown }).__gqueryTable !== true
    ) {
      throw new GQueryDefinitionError(`Database table ${name} is not a table definition.`);
    }
    if (!(definition.source in sources)) {
      throw new GQueryDefinitionError(
        `Database table ${name} references unknown source ${definition.source}.`,
        { table: name, source: definition.source },
      );
    }
    for (const [relationName, relation] of Object.entries(
      definition.relations as RelationMap,
    )) {
      const target = tables[relation.target];
      if (target === undefined) {
        throw new GQueryDefinitionError(
          `Database table ${name} relation ${relationName} references unknown table ${relation.target}.`,
          { table: name, relation: relationName, target: relation.target },
        );
      }
      const foreign = relationKeyParts(relation.foreign);
      const missing = foreign.filter((field) => !(field in target.columns));
      if (missing.length > 0) {
        throw new GQueryDefinitionError(
          `Database table ${name} relation ${relationName} references unknown target column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
          { table: name, relation: relationName, missing },
        );
      }
      if (relation.onDelete === "set-null") {
        const dependent = relation.kind === "belongs-to" ? definition : target;
        const dependentFields = relation.kind === "belongs-to"
          ? relationKeyParts(relation.local)
          : foreign;
        const nonNullable = dependentFields.filter(
          (field) => dependent.columns[field]?.acceptsNull !== true,
        );
        if (nonNullable.length > 0) {
          throw new GQueryDefinitionError(
            `Database table ${name} relation ${relationName} uses set-null with non-nullable dependent column${nonNullable.length === 1 ? "" : "s"}: ${nonNullable.join(", ")}.`,
            {
              table: name,
              relation: relationName,
              dependentTable: relation.kind === "belongs-to" ? name : relation.target,
              nonNullable,
            },
          );
        }
      }
    }
  }

  return Object.freeze({
    __gqueryDatabase: true,
    version: 2,
    sources: Object.freeze(sources),
    tables: Object.freeze(tables),
  });
}

export function isTableDefinition(value: unknown): value is TableDefinition {
  return typeof value === "object" && value !== null &&
    (value as { __gqueryTable?: unknown }).__gqueryTable === true;
}

export function isDatabaseDefinition(value: unknown): value is DatabaseDefinition {
  return typeof value === "object" && value !== null &&
    (value as { __gqueryDatabase?: unknown }).__gqueryDatabase === true;
}
