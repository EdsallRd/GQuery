import { type ColumnDefinition, type InferColumn } from "./codecs";
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
export type SourceDefinition = ActiveSpreadsheetSourceDefinition | SpreadsheetIdSourceDefinition;
export type SourceMap = Readonly<Record<string, SourceDefinition>>;
/** Source constructors are descriptors only; they never open a spreadsheet. */
export declare const source: Readonly<{
    activeSpreadsheet(): ActiveSpreadsheetSourceDefinition;
    byId<const Id extends string>(spreadsheetId: Id): SpreadsheetIdSourceDefinition<Id>;
}>;
export type RelationKind = "belongs-to" | "has-one" | "has-many";
export type RelationCardinality = "one" | "many";
export type DeleteBehavior = "restrict" | "cascade" | "set-null" | "no-action";
export type RelationKey<Key extends string = string> = Key | readonly [Key, ...Key[]];
export interface RelationDefinition<Kind extends RelationKind = RelationKind, Target extends string = string, Local extends RelationKey = RelationKey, Foreign extends RelationKey = RelationKey> {
    readonly __gqueryRelation: true;
    readonly kind: Kind;
    readonly cardinality: Kind extends "has-many" ? "many" : "one";
    readonly target: Target;
    readonly local: Local;
    readonly foreign: Foreign;
    readonly required: boolean;
    readonly onDelete: DeleteBehavior;
}
export type RelationMap = Readonly<Record<string, RelationDefinition<any, any, any, any>>>;
export interface RelationOptions<Local extends RelationKey, Foreign extends RelationKey> {
    readonly local: Local;
    readonly foreign: Foreign;
    readonly required?: boolean;
    readonly onDelete?: DeleteBehavior;
}
export declare function belongsTo<const Target extends string, const Local extends RelationKey, const Foreign extends RelationKey>(target: Target, options: RelationOptions<Local, Foreign>): RelationDefinition<"belongs-to", Target, Local, Foreign>;
export declare function hasOne<const Target extends string, const Local extends RelationKey, const Foreign extends RelationKey>(target: Target, options: RelationOptions<Local, Foreign>): RelationDefinition<"has-one", Target, Local, Foreign>;
export declare function hasMany<const Target extends string, const Local extends RelationKey, const Foreign extends RelationKey>(target: Target, options: RelationOptions<Local, Foreign>): RelationDefinition<"has-many", Target, Local, Foreign>;
export type CacheMode = "row" | "query" | "row-and-query";
export type CacheScope = "script" | "document" | "user";
export interface TableCacheDefinition<Columns extends ColumnMap = ColumnMap> {
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
    ...ColumnKey<Columns>[]
];
export interface TableConfig<Columns extends ColumnMap, SourceName extends string, PrimaryKey extends readonly ColumnKey<Columns>[], Unique extends readonly (readonly ColumnKey<Columns>[])[], Relations extends RelationMap> {
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
} ? Key & readonly ColumnKey<ConfigColumns<Config>>[] : readonly [];
type ConfigUnique<Config extends TableInput> = Config extends {
    readonly unique: infer Keys extends readonly (readonly string[])[];
} ? Keys & readonly (readonly ColumnKey<ConfigColumns<Config>>[])[] : readonly [];
type ConfigRelations<Config extends TableInput> = Config extends {
    readonly relations: infer Relations extends RelationMap;
} ? Relations : {};
export interface TableDefinition<Columns extends ColumnMap = ColumnMap, SourceName extends string = string, PrimaryKey extends readonly ColumnKey<Columns>[] = readonly ColumnKey<Columns>[], Relations extends RelationMap = RelationMap, Unique extends readonly (readonly ColumnKey<Columns>[])[] = readonly (readonly ColumnKey<Columns>[])[]> {
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
export type TableMap = Readonly<Record<string, TableDefinition<any, any, any, any, any>>>;
export type InferTableRow<Table> = Table extends {
    readonly columns: infer Columns extends ColumnMap;
} ? InferRow<Columns> : never;
export type InferDatabaseRows<Tables extends TableMap> = {
    [Name in keyof Tables]: InferTableRow<Tables[Name]>;
};
type RelationField<R extends RelationKey> = R extends readonly string[] ? R[number] : R;
export declare function table<const Config extends TableInput>(config: Config): TableDefinition<ConfigColumns<Config>, Config["source"], ConfigPrimaryKey<Config>, ConfigRelations<Config>, ConfigUnique<Config>>;
type TableSourceName<Table> = Table extends {
    readonly source: infer SourceName;
} ? SourceName : never;
type TableRelations<Table> = Table extends {
    readonly relations: infer Relations;
} ? Relations : never;
type TableColumns<Table> = Table extends {
    readonly columns: infer Columns;
} ? Columns : never;
type InvalidSourceNames<Sources extends SourceMap, Tables extends TableMap> = {
    [Name in keyof Tables]: Exclude<TableSourceName<Tables[Name]>, keyof Sources>;
}[keyof Tables];
type InvalidRelationTargets<Tables extends TableMap> = {
    [TableName in keyof Tables]: {
        [RelationName in keyof TableRelations<Tables[TableName]>]: Exclude<TableRelations<Tables[TableName]>[RelationName]["target"], keyof Tables>;
    }[keyof TableRelations<Tables[TableName]>];
}[keyof Tables];
type InvalidRelationLocalFields<Tables extends TableMap> = {
    [TableName in keyof Tables]: {
        [RelationName in keyof TableRelations<Tables[TableName]>]: Exclude<RelationField<TableRelations<Tables[TableName]>[RelationName]["local"]>, ColumnKey<TableColumns<Tables[TableName]>>>;
    }[keyof TableRelations<Tables[TableName]>];
}[keyof Tables];
type TargetColumns<Tables extends TableMap, Target extends string> = Target extends keyof Tables ? Tables[Target] extends {
    readonly columns: infer Columns extends ColumnMap;
} ? ColumnKey<Columns> : never : never;
type InvalidRelationForeignFields<Tables extends TableMap> = {
    [TableName in keyof Tables]: {
        [RelationName in keyof TableRelations<Tables[TableName]>]: Exclude<RelationField<TableRelations<Tables[TableName]>[RelationName]["foreign"]>, TargetColumns<Tables, TableRelations<Tables[TableName]>[RelationName]["target"]>>;
    }[keyof TableRelations<Tables[TableName]>];
}[keyof Tables];
type DatabaseValidation<Sources extends SourceMap, Tables extends TableMap> = [
    InvalidSourceNames<Sources, Tables> | InvalidRelationTargets<Tables> | InvalidRelationLocalFields<Tables> | InvalidRelationForeignFields<Tables>
] extends [never] ? unknown : {
    readonly __invalidDatabaseReferences__: {
        readonly sources: InvalidSourceNames<Sources, Tables>;
        readonly relationTargets: InvalidRelationTargets<Tables>;
        readonly relationLocalFields: InvalidRelationLocalFields<Tables>;
        readonly relationForeignFields: InvalidRelationForeignFields<Tables>;
    };
};
export interface DatabaseDefinition<Tables extends TableMap = TableMap, Sources extends SourceMap = SourceMap> {
    readonly __gqueryDatabase: true;
    readonly version: 2;
    readonly sources: Sources;
    readonly tables: Tables;
}
export interface DatabaseConfig<Sources extends SourceMap, Tables extends TableMap> {
    readonly version: 2;
    readonly sources: Sources;
    readonly tables: Tables;
}
export declare function defineDatabase<const Sources extends SourceMap, const Tables extends TableMap>(config: DatabaseConfig<Sources, Tables> & DatabaseValidation<Sources, Tables>): DatabaseDefinition<Tables, Sources>;
export declare function isTableDefinition(value: unknown): value is TableDefinition;
export declare function isDatabaseDefinition(value: unknown): value is DatabaseDefinition;
export {};
