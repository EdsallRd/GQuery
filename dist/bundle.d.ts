type GQueryErrorCode$1 = "DEFINITION_INVALID" | "CODEC_ENCODE_FAILED" | "CODEC_DECODE_FAILED" | "CODEC_BLANK" | "CODEC_NULL" | "CODEC_TYPE" | "CODEC_CONSTRAINT" | "STRUCTURED_CYCLE" | "STRUCTURED_UNSUPPORTED" | "STRUCTURED_TOO_DEEP" | "STRUCTURED_TOO_LARGE" | "STRUCTURED_INVALID" | "STRUCTURED_VERSION" | "JSON_INVALID" | "JSON_TOO_LARGE";
interface GQueryErrorOptions {
    readonly cause?: unknown;
    readonly details?: Readonly<Record<string, unknown>>;
}
/** Base class for errors callers can safely discriminate without parsing text. */
declare class GQueryError extends Error {
    readonly code: GQueryErrorCode$1;
    readonly details: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
    constructor(code: GQueryErrorCode$1, message: string, options?: GQueryErrorOptions);
}
declare class GQueryDefinitionError extends GQueryError {
    constructor(message: string, details?: Readonly<Record<string, unknown>>);
}
type CodecDirection = "encode" | "decode";
declare class GQueryCodecError extends GQueryError {
    readonly direction: CodecDirection;
    readonly codec: string;
    constructor(code: Exclude<GQueryErrorCode$1, "DEFINITION_INVALID">, message: string, options: GQueryErrorOptions & {
        readonly direction: CodecDirection;
        readonly codec: string;
    });
}

/** Internal representation of a physically blank cell. */
declare const BLANK_CELL: unique symbol;
type BlankCell = typeof BLANK_CELL;
/**
 * Internal typed cell used by the high-level formula codec. The marker is
 * deliberately an object so a normal text value such as `"=SUM(A1:A3)"`
 * can never be mistaken for a formula by the transport.
 */
interface FormulaCell {
    readonly __gqueryFormulaCell: true;
    readonly expression: string;
}
type EncodedCell = string | number | boolean | BlankCell | FormulaCell;
declare const LEGACY_NO_MATCH: unique symbol;
type LegacyNoMatch = typeof LEGACY_NO_MATCH;
interface CodecContext {
    readonly table?: string;
    readonly column?: string;
    readonly header?: string;
    readonly rowNumber?: number;
}
interface ColumnCodec<T> {
    readonly kind: string;
    encode(value: T, context?: CodecContext): EncodedCell;
    decode(value: unknown, context?: CodecContext): T;
}
type LegacyDecoder<T> = (value: unknown, context: CodecContext) => T | LegacyNoMatch;
type CellFormat = Readonly<Record<string, unknown>>;
interface ColumnDefinition<T> extends ColumnCodec<T> {
    readonly __gqueryColumn: true;
    /** Compile-time-only carrier used for row inference. */
    readonly __valueType?: T;
    readonly codec: ColumnCodec<T>;
    readonly header?: string;
    readonly format?: CellFormat;
    readonly legacyDecoders: readonly LegacyDecoder<T>[];
    readonly blankPolicy: "reject" | "null" | "undefined" | "default";
    readonly acceptsNull: boolean;
}
type InferColumn<C> = C extends {
    readonly __gqueryColumn: true;
    readonly __valueType?: infer T;
} ? T : never;
interface BaseColumnOptions<T> {
    readonly header?: string;
    readonly format?: CellFormat;
    readonly legacyDecoders?: readonly LegacyDecoder<T>[];
}
interface TextColumnOptions extends BaseColumnOptions<string> {
    readonly trim?: boolean;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: RegExp;
}
interface NumberColumnOptions extends BaseColumnOptions<number> {
    readonly min?: number;
    readonly max?: number;
}
interface IntegerColumnOptions extends NumberColumnOptions {
    readonly safe?: boolean;
}
interface DecimalColumnOptions extends BaseColumnOptions<string> {
    readonly scale?: number;
    readonly maxDigits?: number;
}
interface BooleanColumnOptions extends BaseColumnOptions<boolean> {
}
interface DateColumnOptions extends BaseColumnOptions<Date> {
}
interface FormulaColumnOptions extends BaseColumnOptions<string> {
    /** Safety limit below Sheets' 50,000-character cell boundary. */
    readonly maxChars?: number;
}
interface JsonColumnOptions<T extends JsonValue> extends BaseColumnOptions<T> {
    readonly formatVersion?: number;
    readonly maxChars?: number;
    readonly maxDepth?: number;
}
interface StructuredColumnOptions<T> extends BaseColumnOptions<T> {
    readonly formatVersion?: number;
    readonly maxChars?: number;
    readonly maxDepth?: number;
}
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
declare function isFormulaCell(value: unknown): value is FormulaCell;
declare function text(options?: TextColumnOptions): ColumnDefinition<string>;
/**
 * Declares a column whose canonical value is a Sheets formula expression.
 * Formula intent comes from the schema, never from inspecting an arbitrary
 * string during transport encoding.
 */
declare function formula(options?: FormulaColumnOptions): ColumnDefinition<string>;
declare function identifier(options?: Omit<TextColumnOptions, "trim" | "minLength">): ColumnDefinition<string>;
declare function number(options?: NumberColumnOptions): ColumnDefinition<number>;
declare function integer(options?: IntegerColumnOptions): ColumnDefinition<number>;
declare function decimal(options?: DecimalColumnOptions): ColumnDefinition<string>;
declare function booleanColumn(options?: BooleanColumnOptions): ColumnDefinition<boolean>;

type EnumCellValue = string | number | boolean;
interface EnumerationColumnOptions<Values extends readonly [EnumCellValue, ...EnumCellValue[]]> extends BaseColumnOptions<Values[number]> {
    readonly values: Values;
}
declare function enumeration<const Values extends readonly [EnumCellValue, ...EnumCellValue[]]>(options: EnumerationColumnOptions<Values>): ColumnDefinition<Values[number]>;
declare function date(options?: DateColumnOptions): ColumnDefinition<Date>;
declare function datetime(options?: DateColumnOptions): ColumnDefinition<Date>;
declare function json<T extends JsonValue = JsonValue>(options?: JsonColumnOptions<T>): ColumnDefinition<T>;
declare function structured<T>(options?: StructuredColumnOptions<T>): ColumnDefinition<T>;
declare function nullable<T>(column: ColumnDefinition<T>): ColumnDefinition<T | null>;
declare function optional<T>(column: ColumnDefinition<T>): ColumnDefinition<T | undefined>;
declare function withDefault<T>(column: ColumnDefinition<T>, defaultValue: T | (() => T)): ColumnDefinition<T>;
type BlankPolicy = "reject" | "null" | "undefined";
type BlankPolicyOutput<T, P extends BlankPolicy> = P extends "null" ? T | null : P extends "undefined" ? T | undefined : T;
declare function withBlankPolicy<T, const P extends BlankPolicy>(column: ColumnDefinition<T>, policy: P): ColumnDefinition<BlankPolicyOutput<T, P>>;
declare function isColumnDefinition(value: unknown): value is ColumnDefinition<unknown>;

type ColumnMap = Readonly<Record<string, ColumnDefinition<any>>>;
type ColumnKey<Columns extends ColumnMap> = Extract<keyof Columns, string>;
type InferRow<Columns extends ColumnMap> = {
    -readonly [Key in keyof Columns]: InferColumn<Columns[Key]>;
};
interface ActiveSpreadsheetSourceDefinition {
    readonly __gquerySource: true;
    readonly kind: "active-spreadsheet";
}
interface SpreadsheetIdSourceDefinition<Id extends string = string> {
    readonly __gquerySource: true;
    readonly kind: "spreadsheet-id";
    readonly spreadsheetId: Id;
}
type SourceDefinition = ActiveSpreadsheetSourceDefinition | SpreadsheetIdSourceDefinition;
type SourceMap = Readonly<Record<string, SourceDefinition>>;
/** Source constructors are descriptors only; they never open a spreadsheet. */
declare const source: Readonly<{
    activeSpreadsheet(): ActiveSpreadsheetSourceDefinition;
    byId<const Id extends string>(spreadsheetId: Id): SpreadsheetIdSourceDefinition<Id>;
}>;
type RelationKind = "belongs-to" | "has-one" | "has-many";
type RelationCardinality = "one" | "many";
type DeleteBehavior = "restrict" | "cascade" | "set-null" | "no-action";
type RelationKey<Key extends string = string> = Key | readonly [Key, ...Key[]];
interface RelationDefinition<Kind extends RelationKind = RelationKind, Target extends string = string, Local extends RelationKey = RelationKey, Foreign extends RelationKey = RelationKey> {
    readonly __gqueryRelation: true;
    readonly kind: Kind;
    readonly cardinality: Kind extends "has-many" ? "many" : "one";
    readonly target: Target;
    readonly local: Local;
    readonly foreign: Foreign;
    readonly required: boolean;
    readonly onDelete: DeleteBehavior;
}
type RelationMap = Readonly<Record<string, RelationDefinition<any, any, any, any>>>;
interface RelationOptions<Local extends RelationKey, Foreign extends RelationKey> {
    readonly local: Local;
    readonly foreign: Foreign;
    readonly required?: boolean;
    readonly onDelete?: DeleteBehavior;
}
declare function belongsTo<const Target extends string, const Local extends RelationKey, const Foreign extends RelationKey>(target: Target, options: RelationOptions<Local, Foreign>): RelationDefinition<"belongs-to", Target, Local, Foreign>;
declare function hasOne<const Target extends string, const Local extends RelationKey, const Foreign extends RelationKey>(target: Target, options: RelationOptions<Local, Foreign>): RelationDefinition<"has-one", Target, Local, Foreign>;
declare function hasMany<const Target extends string, const Local extends RelationKey, const Foreign extends RelationKey>(target: Target, options: RelationOptions<Local, Foreign>): RelationDefinition<"has-many", Target, Local, Foreign>;
type CacheMode = "row" | "query" | "row-and-query";
type CacheScope = "script" | "document" | "user";
interface TableCacheDefinition<Columns extends ColumnMap = ColumnMap> {
    readonly mode: CacheMode;
    readonly scope: CacheScope;
    readonly ttlSeconds: number;
    readonly jitterSeconds?: number;
    readonly indexes?: readonly (readonly ColumnKey<Columns>[])[];
    readonly allowStaleOnQuota?: boolean;
}
type NonEmptyKey<Columns extends ColumnMap> = readonly [
    ColumnKey<Columns>,
    ...ColumnKey<Columns>[]
];
interface TableConfig<Columns extends ColumnMap, SourceName extends string, PrimaryKey extends readonly ColumnKey<Columns>[], Unique extends readonly (readonly ColumnKey<Columns>[])[], Relations extends RelationMap> {
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
interface TableDefinition<Columns extends ColumnMap = ColumnMap, SourceName extends string = string, PrimaryKey extends readonly ColumnKey<Columns>[] = readonly ColumnKey<Columns>[], Relations extends RelationMap = RelationMap, Unique extends readonly (readonly ColumnKey<Columns>[])[] = readonly (readonly ColumnKey<Columns>[])[]> {
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
type TableMap = Readonly<Record<string, TableDefinition<any, any, any, any, any>>>;
type InferTableRow<Table> = Table extends {
    readonly columns: infer Columns extends ColumnMap;
} ? InferRow<Columns> : never;
type InferDatabaseRows<Tables extends TableMap> = {
    [Name in keyof Tables]: InferTableRow<Tables[Name]>;
};
type RelationField<R extends RelationKey> = R extends readonly string[] ? R[number] : R;
declare function table<const Config extends TableInput>(config: Config): TableDefinition<ConfigColumns<Config>, Config["source"], ConfigPrimaryKey<Config>, ConfigRelations<Config>, ConfigUnique<Config>>;
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
interface DatabaseDefinition<Tables extends TableMap = TableMap, Sources extends SourceMap = SourceMap> {
    readonly __gqueryDatabase: true;
    readonly version: 2;
    readonly sources: Sources;
    readonly tables: Tables;
}
interface DatabaseConfig<Sources extends SourceMap, Tables extends TableMap> {
    readonly version: 2;
    readonly sources: Sources;
    readonly tables: Tables;
}
declare function defineDatabase<const Sources extends SourceMap, const Tables extends TableMap>(config: DatabaseConfig<Sources, Tables> & DatabaseValidation<Sources, Tables>): DatabaseDefinition<Tables, Sources>;
declare function isTableDefinition(value: unknown): value is TableDefinition;
declare function isDatabaseDefinition(value: unknown): value is DatabaseDefinition;

/** Serializable predicate and query-plan primitives used by the v2 planner. */
type SortDirection = "asc" | "desc";
type JoinKind = "left" | "inner" | "semi" | "anti";
type JoinCardinality = "one" | "many";
type FieldOperators<V> = {
    $eq?: V;
    $ne?: V;
    $in?: readonly V[];
    $notIn?: readonly V[];
    $gt?: V;
    $gte?: V;
    $lt?: V;
    $lte?: V;
    $between?: readonly [V, V];
    $contains?: V extends string ? string : V extends readonly (infer Item)[] ? Item : unknown;
    $startsWith?: V extends string ? string : never;
    $endsWith?: V extends string ? string : never;
    $isBlank?: boolean;
};
type Where<T extends Record<string, unknown>> = {
    [K in keyof T]?: T[K] | FieldOperators<T[K]>;
} & {
    $and?: readonly Where<T>[];
    $or?: readonly Where<T>[];
    $not?: Where<T>;
};
type PredicateOperator = "eq" | "ne" | "in" | "notIn" | "gt" | "gte" | "lt" | "lte" | "between" | "contains" | "startsWith" | "endsWith" | "isBlank";
type PredicateNode = {
    kind: "field";
    field: string;
    operator: PredicateOperator;
    value?: unknown;
} | {
    kind: "and";
    nodes: readonly PredicateNode[];
} | {
    kind: "or";
    nodes: readonly PredicateNode[];
} | {
    kind: "not";
    node: PredicateNode;
} | {
    kind: "constant";
    value: boolean;
};
interface OrderClause {
    field: string;
    direction: SortDirection;
}
interface JoinPlan {
    table: string;
    alias: string;
    localField: string | readonly string[];
    foreignField: string | readonly string[];
    kind: JoinKind;
    cardinality: JoinCardinality;
    select?: readonly string[];
    relationName?: string;
}
interface SerializableQueryPlan {
    table: string;
    source: string;
    predicate?: PredicateNode;
    projection?: readonly string[];
    orderBy: readonly OrderClause[];
    joins: readonly JoinPlan[];
    limit?: number;
    offset?: number;
    tail?: number;
}
/** Convert the typed object DSL into a deterministic, serializable predicate tree. */
declare function normalizeWhere<T extends Record<string, unknown>>(where: Where<T>): PredicateNode;
/** Evaluate a normalized predicate against a decoded logical row. */
declare function evaluatePredicate(node: PredicateNode, row: Record<string, unknown>): boolean;
/** Stable JSON used for cache keys and plan fingerprints. */
declare function canonicalStringify$1(value: unknown): string;
/** Deterministic non-cryptographic hash suitable for compact cache keys. */
declare function hashCanonical$1(value: unknown): string;
declare function combinePredicates(current: PredicateNode | undefined, next: PredicateNode): PredicateNode;
declare function emptyQueryPlan(tableName: string, sourceName: string): SerializableQueryPlan;
declare function cloneQueryPlan(plan: SerializableQueryPlan, changes: Partial<SerializableQueryPlan>): SerializableQueryPlan;

type ExecutionMode = "cache" | "identity-map" | "bounded" | "full-scan";
type ExecutionPlanStepKind = "cache-read" | "header-read" | "locator-read" | "range-read" | "local-filter" | "join" | "version-preflight" | "atomic-write" | "cache-invalidate";
interface ExecutionPlanWarning {
    code: "FULL_SCAN" | "LOCAL_FILTER" | "UNINDEXED_PREDICATE" | "JOIN_FANOUT" | "STALE_CACHE";
    message: string;
    table?: string;
}
interface ExecutionPlanStep {
    kind: ExecutionPlanStepKind;
    source: string;
    table?: string;
    ranges: readonly string[];
    columns?: readonly string[];
    detail?: string;
    estimatedCells?: number;
}
interface ExecutionPlan {
    mode: ExecutionMode;
    sourceIds: readonly string[];
    tables: readonly string[];
    steps: readonly ExecutionPlanStep[];
    warnings: readonly ExecutionPlanWarning[];
}
interface ExecutionStats {
    apiCalls: number;
    cellsRead: number;
    cellsWritten: number;
    bytesRead: number;
    bytesWritten: number;
    cacheHits: number;
    cacheMisses: number;
    staleCacheHits: number;
    retries: number;
    elapsedMs: number;
    lockWaitMs: number;
    fullScans: number;
    rangesRead: string[];
    rangesWritten: string[];
}
declare function createExecutionStats(initial?: Partial<ExecutionStats>): ExecutionStats;
declare function mergeExecutionStats(...items: readonly ExecutionStats[]): ExecutionStats;

/** Quote a sheet title for use in Google Sheets A1 notation. */
declare function quoteSheetName(sheetName: string): string;
/** Build an A1 range from a literal sheet title and an optional cell range. */
declare function sheetRange(sheetName: string, range?: string): string;
/** Extract a literal sheet title from a sheet-qualified A1 range. */
declare function sheetNameFromRange(range: string): string | null;

interface ParsedA1Range {
    sheetName: string | null;
    startRowIndex?: number;
    endRowIndex?: number;
    startColumnIndex?: number;
    endColumnIndex?: number;
}
declare function columnIndexToLetter(columnIndex: number): string;
declare function columnLetterToIndex(column: string): number;
/** Parse sheet-qualified or local A1 notation into zero-based grid bounds. */
declare function parseA1Range(range: string): ParsedA1Range;
declare function cellRange(sheetName: string, startRowIndex: number, startColumnIndex: number, rowCount?: number, columnCount?: number): string;

/** Values that can be represented losslessly by the Google Sheets Values API. */
type SheetCellValue = string | number | boolean | null;
/** Typed input accepted only by grid writes that preserve formula intent. */
type SheetCellInput = SheetCellValue | FormulaCell;
type SheetMajorDimension = "ROWS" | "COLUMNS";
type SheetValueRenderOption = "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA";
type SheetDateTimeRenderOption = "SERIAL_NUMBER" | "FORMATTED_STRING";
type SheetValueInputOption = "RAW" | "USER_ENTERED";
interface SheetReadOptions {
    majorDimension?: SheetMajorDimension;
    valueRenderOption?: SheetValueRenderOption;
    dateTimeRenderOption?: SheetDateTimeRenderOption;
}
interface SheetValueRange {
    range: string;
    majorDimension: SheetMajorDimension;
    values: SheetCellValue[][];
}
interface SheetBatchGetResult {
    spreadsheetId: string;
    valueRanges: SheetValueRange[];
}
interface SheetMetadata {
    sheetId: number;
    title: string;
    rowCount: number;
    columnCount: number;
}
interface SpreadsheetMetadata {
    spreadsheetId: string;
    sheets: SheetMetadata[];
}
interface SheetValueUpdate {
    range: string;
    values: readonly (readonly SheetCellValue[])[];
    majorDimension?: SheetMajorDimension;
}
interface SheetBatchUpdateOptions {
    valueInputOption?: SheetValueInputOption;
    includeValuesInResponse?: boolean;
    responseValueRenderOption?: SheetValueRenderOption;
    responseDateTimeRenderOption?: SheetDateTimeRenderOption;
}
interface SheetUpdateResult {
    spreadsheetId: string;
    updatedRange: string;
    updatedRows: number;
    updatedColumns: number;
    updatedCells: number;
    updatedData: SheetValueRange | null;
}
interface SheetBatchUpdateResult {
    spreadsheetId: string;
    totalUpdatedRows: number;
    totalUpdatedColumns: number;
    totalUpdatedCells: number;
    totalUpdatedSheets: number;
    responses: SheetUpdateResult[];
}
/**
 * A zero-based rectangular grid write. `null` clears the corresponding cell.
 * Strings beginning with `=` remain strings; formulas must use an explicit
 * higher-level formula codec instead of this raw transport operation.
 */
interface AtomicCellUpdate {
    kind: "updateCells";
    sheetId: number;
    startRowIndex: number;
    startColumnIndex: number;
    values: readonly (readonly SheetCellInput[])[];
}
/** Append rows to the current logical end of a sheet. */
interface AtomicRowAppend {
    kind: "appendRows";
    sheetId: number;
    values: readonly (readonly SheetCellInput[])[];
}
/** A zero-based, end-exclusive row deletion. */
interface AtomicRowDelete {
    kind: "deleteRows";
    sheetId: number;
    startRowIndex: number;
    endRowIndex: number;
}
type AtomicMutation = AtomicCellUpdate | AtomicRowAppend | AtomicRowDelete;
interface AtomicBatchUpdateOptions {
    includeSpreadsheetInResponse?: boolean;
    responseIncludeGridData?: boolean;
    responseRanges?: readonly string[];
}
interface AtomicBatchUpdateResult {
    spreadsheetId: string;
    requestCount: number;
    replies: readonly unknown[];
}
type TransportOperationKind = "getSpreadsheetMetadata" | "get" | "batchGet" | "batchUpdate" | "atomicBatchUpdate";
interface TransportOperationContext {
    kind: TransportOperationKind;
    operationClass: "read" | "idempotent-write" | "append" | "structural-delete" | "write";
    spreadsheetId: string;
    ranges: readonly string[];
    requestCount: number;
    /** Whether retrying the operation cannot duplicate a logical mutation. */
    idempotent: boolean;
}
/** Synchronous interception point used by the retry/deadline layer. */
interface TransportInvoker {
    invoke<T>(context: TransportOperationContext, operation: () => T): T;
}
/**
 * Injectable synchronous transport used by the query planner. All indices in
 * atomic mutations are zero-based to match the Sheets v4 grid API.
 */
interface SheetsTransport {
    getSpreadsheetMetadata(spreadsheetId: string): SpreadsheetMetadata;
    get(spreadsheetId: string, range: string, options?: SheetReadOptions): SheetValueRange;
    batchGet(spreadsheetId: string, ranges: readonly string[], options?: SheetReadOptions): SheetBatchGetResult;
    batchUpdate(spreadsheetId: string, updates: readonly SheetValueUpdate[], options?: SheetBatchUpdateOptions): SheetBatchUpdateResult;
    atomicBatchUpdate(spreadsheetId: string, mutations: readonly AtomicMutation[], options?: AtomicBatchUpdateOptions): AtomicBatchUpdateResult;
}

interface AppsScriptSheetsTransportOptions {
    /** Override the global advanced Sheets service, primarily for tests. */
    service?: GoogleAppsScript.Sheets;
    /** Synchronous deadline/retry/telemetry interception point. */
    invoker?: TransportInvoker;
}
declare function atomicMutationToSheetsRequest(mutation: AtomicMutation): GoogleAppsScript.Sheets.Schema.Request;
declare class AppsScriptSheetsTransport implements SheetsTransport {
    private readonly injectedService?;
    private readonly invoker?;
    constructor(options?: AppsScriptSheetsTransportOptions);
    private service;
    private invoke;
    getSpreadsheetMetadata(spreadsheetId: string): SpreadsheetMetadata;
    get(spreadsheetId: string, range: string, options?: SheetReadOptions): SheetValueRange;
    batchGet(spreadsheetId: string, ranges: readonly string[], options?: SheetReadOptions): SheetBatchGetResult;
    batchUpdate(spreadsheetId: string, updates: readonly SheetValueUpdate[], options?: SheetBatchUpdateOptions): SheetBatchUpdateResult;
    atomicBatchUpdate(spreadsheetId: string, mutations: readonly AtomicMutation[], options?: AtomicBatchUpdateOptions): AtomicBatchUpdateResult;
}

/** One zero-based physical cell change prior to request compaction. */
interface CellPatch {
    sheetId: number;
    rowIndex: number;
    columnIndex: number;
    value: SheetCellInput;
}
interface RowPatch {
    sheetId: number;
    rowIndex: number;
}
/**
 * Compact adjacent cell patches into maximal rectangles without filling gaps.
 * Duplicate physical cells are rejected so planner mistakes cannot silently
 * overwrite an earlier change.
 */
declare function compactCellUpdates(patches: readonly CellPatch[]): AtomicCellUpdate[];
/** Group row indices and order every sheet's delete ranges from bottom to top. */
declare function compactRowDeletes(rows: readonly RowPatch[]): AtomicRowDelete[];

interface InMemorySheetSeed {
    sheetId: number;
    title: string;
    values?: readonly (readonly SheetCellInput[])[];
}
interface InMemorySpreadsheetSeed {
    spreadsheetId: string;
    sheets: readonly InMemorySheetSeed[];
}
interface InMemoryTransportCall {
    kind: TransportOperationKind;
    spreadsheetId: string;
    ranges: readonly string[];
    requestCount: number;
    valueRenderOption?: SheetReadOptions["valueRenderOption"];
}
declare class InMemorySheetsTransport implements SheetsTransport {
    private readonly spreadsheets;
    private readonly calls;
    constructor(seeds?: readonly InMemorySpreadsheetSeed[]);
    addSpreadsheet(seed: InMemorySpreadsheetSeed): void;
    get history(): readonly InMemoryTransportCall[];
    clearHistory(): void;
    snapshot(spreadsheetId: string): InMemorySpreadsheetSeed;
    private record;
    private requireSpreadsheet;
    private requireSheetById;
    private resolveRange;
    getSpreadsheetMetadata(spreadsheetId: string): SpreadsheetMetadata;
    private read;
    get(spreadsheetId: string, range: string, options?: SheetReadOptions): SheetValueRange;
    batchGet(spreadsheetId: string, ranges: readonly string[], options?: SheetReadOptions): SheetBatchGetResult;
    batchUpdate(spreadsheetId: string, updates: readonly SheetValueUpdate[], options?: SheetBatchUpdateOptions): SheetBatchUpdateResult;
    atomicBatchUpdate(spreadsheetId: string, mutations: readonly AtomicMutation[], options?: AtomicBatchUpdateOptions): AtomicBatchUpdateResult;
}

type RawExtendedValue = {
    stringValue: string;
} | {
    numberValue: number;
} | {
    boolValue: boolean;
} | {
    formulaValue: string;
};
interface RawCellData {
    /** Omitted when a `null` transport value means clear this cell. */
    userEnteredValue?: RawExtendedValue;
}
declare function assertSheetCellValue(value: unknown, location?: string): asserts value is SheetCellValue;
declare function cloneRawMatrix(values: readonly (readonly SheetCellValue[])[], label?: string): SheetCellValue[][];
declare function assertSheetCellInput(value: unknown, location?: string): asserts value is SheetCellInput;
declare function cloneSheetInputMatrix(values: readonly (readonly SheetCellInput[])[], label?: string): SheetCellInput[][];
declare function normalizeReturnedMatrix(values: readonly (readonly unknown[])[] | undefined, label?: string): SheetCellValue[][];
/** Encode one primitive as a Sheets v4 ExtendedValue. `null` means clear. */
declare function encodeRawExtendedValue(value: SheetCellValue): RawExtendedValue | undefined;
/** Encode a grid-write input as Sheets v4 ExtendedValue without guessing. */
declare function encodeAtomicExtendedValue(value: SheetCellInput): RawExtendedValue | undefined;
declare function encodeRawCell(value: SheetCellValue): RawCellData;
declare function encodeRawRows(values: readonly (readonly SheetCellValue[])[]): {
    values: RawCellData[];
}[];
declare function encodeAtomicRows(values: readonly (readonly SheetCellInput[])[]): {
    values: RawCellData[];
}[];

type RuntimeErrorCode = "SOURCE_UNAVAILABLE" | "SHEET_NOT_FOUND" | "MISSING_HEADER" | "DUPLICATE_HEADER" | "SCHEMA_CHANGED" | "DUPLICATE_KEY" | "RELATION_CARDINALITY" | "RELATION_NOT_FOUND" | "RELATION_RESTRICT" | "INVALID_QUERY" | "NOT_FOUND" | "EXPECTED_ONE" | "STALE_SELECTION" | "MUTATION_CONFLICT" | "MUTATION_INVALID" | "TRANSACTION_PARTIAL" | "MIGRATION_REQUIRED" | "BACKUP_REQUIRED" | "UNSUPPORTED_OPERATION";
interface RuntimeErrorOptions {
    readonly details?: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
}
/** Structured failures raised by the schema/query/execution layers. */
declare class GQueryRuntimeError extends Error {
    readonly code: RuntimeErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
    constructor(code: RuntimeErrorCode, message: string, options?: RuntimeErrorOptions);
}

/** Hidden, serializable-enough physical identity retained by materialized rows. */
interface RowProvenance {
    readonly sourceName: string;
    readonly spreadsheetId: string;
    readonly tableName: string;
    readonly sheetName: string;
    readonly sheetId: number;
    /** Zero-based grid row. Row zero is the header. */
    readonly rowIndex: number;
    readonly primaryKey: Readonly<Record<string, unknown>>;
    readonly encodedPrimaryKey: Readonly<Record<string, SheetCellValue>>;
    readonly version: unknown;
    readonly originalEncoded: Readonly<Record<string, SheetCellValue>>;
    readonly columnIndexes: Readonly<Record<string, number>>;
    readonly headerFingerprint: string;
    readonly readAt: string;
    readonly relations: Readonly<Record<string, readonly RowProvenance[]>>;
}
interface MaterializedRow<T extends Record<string, unknown>> {
    readonly value: T;
    readonly provenance: RowProvenance;
}
declare function cloneProvenance(provenance: RowProvenance, changes?: Partial<RowProvenance>): RowProvenance;

type MutationStatus = "committed" | "queued" | "conflicted";
interface MutationConflict {
    readonly code: "missing" | "key-changed" | "version-changed" | "schema-changed" | "duplicate-key";
    readonly table: string;
    readonly key: Readonly<Record<string, unknown>>;
    readonly rowIndex?: number;
    readonly expected?: unknown;
    readonly actual?: unknown;
    readonly message: string;
}
interface PendingMutationReceipt$1 {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly queuedAt: string;
    readonly operation: "update" | "delete" | "upsert" | "create";
    readonly table: string;
    readonly keys: readonly Readonly<Record<string, unknown>>[];
}
interface MutationResult<T extends Record<string, unknown>> {
    readonly status: MutationStatus;
    readonly matchedCount: number;
    readonly changedCount: number;
    readonly changedCells: number;
    readonly conflicts: readonly MutationConflict[];
    readonly before?: Selection<T>;
    readonly after?: Selection<T>;
    readonly stats: ExecutionStats;
    readonly receipt?: PendingMutationReceipt$1;
}
type MutationPatch<T extends Record<string, unknown>> = Partial<T> | ((draft: T) => Partial<T> | void);
interface MutationOptions {
    readonly delivery?: "immediate" | "deferred";
    readonly idempotencyKey?: string;
    readonly actor?: string;
    readonly fanout?: boolean;
    readonly includeBefore?: boolean;
    readonly includeAfter?: boolean;
}
interface DeleteOptions extends MutationOptions {
}
interface SelectionRuntime {
    refresh<T extends Record<string, unknown>>(selection: Selection<T>): Selection<T>;
    update<T extends Record<string, unknown>>(selection: Selection<T>, patch: MutationPatch<T>, options?: MutationOptions): MutationResult<T>;
    delete<T extends Record<string, unknown>>(selection: Selection<T>, options?: DeleteOptions): MutationResult<T>;
}
declare const SELECTION_INTERNAL: unique symbol;
interface SelectionInternal<T extends Record<string, unknown>> {
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
declare class Selection<T extends Record<string, unknown>> {
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
declare function selectionProvenance<T extends Record<string, unknown>>(selection: Selection<T>): readonly RowProvenance[];

interface HashFunction {
    hash(value: string): string;
}
/** Stable, type-preserving serialization used only for fingerprints and cache keys. */
declare function canonicalStringify(value: unknown): string;
declare function hashCanonical(value: unknown, hasher: HashFunction): string;
declare class AppsScriptSha256Hash implements HashFunction {
    hash(value: string): string;
}
/** A deterministic non-cryptographic implementation useful for isolated tests and in-memory transports. */
declare class Fnv1aHash implements HashFunction {
    hash(value: string): string;
}

/** Small synchronous runtime ports shared by the Apps Script infrastructure. */
interface Clock {
    now(): number;
}
interface Sleeper {
    sleep(milliseconds: number): void;
}
interface RandomSource {
    next(): number;
}
interface IdGenerator {
    next(): string;
}
interface SyncLock {
    tryAcquire(timeoutMs: number): boolean;
    release(): void;
}
interface CacheStore {
    get(key: string): string | null;
    getMany(keys: readonly string[]): Record<string, string>;
    put(key: string, value: string, ttlSeconds: number): void;
    putMany(values: Readonly<Record<string, string>>, ttlSeconds: number): void;
    remove(key: string): void;
    removeMany(keys: readonly string[]): void;
}
interface PropertyStore {
    get(key: string): string | null;
    getMany(): Record<string, string>;
    set(key: string, value: string): void;
    setMany(values: Readonly<Record<string, string>>): void;
    remove(key: string): void;
    removeMany(keys: readonly string[]): void;
}
declare const systemClock: Clock;
declare const appsScriptSleeper: Sleeper;
declare const mathRandomSource: RandomSource;
declare class AppsScriptCacheStore implements CacheStore {
    private readonly cache;
    constructor(cache: GoogleAppsScript.Cache.Cache);
    get(key: string): string | null;
    getMany(keys: readonly string[]): Record<string, string>;
    put(key: string, value: string, ttlSeconds: number): void;
    putMany(values: Readonly<Record<string, string>>, ttlSeconds: number): void;
    remove(key: string): void;
    removeMany(keys: readonly string[]): void;
}
declare class AppsScriptPropertyStore implements PropertyStore {
    private readonly properties;
    constructor(properties: GoogleAppsScript.Properties.Properties);
    get(key: string): string | null;
    getMany(): Record<string, string>;
    set(key: string, value: string): void;
    setMany(values: Readonly<Record<string, string>>): void;
    remove(key: string): void;
    removeMany(keys: readonly string[]): void;
}
declare class AppsScriptLock implements SyncLock {
    private readonly lock;
    constructor(lock: GoogleAppsScript.Lock.Lock);
    tryAcquire(timeoutMs: number): boolean;
    release(): void;
}
declare function withLock<T>(lock: SyncLock, timeoutMs: number, operation: () => T): T;

interface CacheTextCodec {
    readonly name: string;
    encode(value: string): string;
    decode(value: string): string;
}
declare class AppsScriptGzipBase64Codec implements CacheTextCodec {
    readonly name = "gzip-base64-v1";
    encode(value: string): string;
    decode(value: string): string;
}
declare class PlainTextCacheCodec implements CacheTextCodec {
    readonly name = "plain-text-v1";
    encode(value: string): string;
    decode(value: string): string;
}
interface ChunkedCachePolicy {
    readonly ttlSeconds?: number;
    readonly jitterSeconds?: number;
}
type CacheReadState = "hit" | "miss" | "corrupt";
interface CacheReadResult<T> {
    readonly state: CacheReadState;
    readonly value?: T;
}
type ReadThroughState = "hit" | "hit-after-wait" | "filled" | "uncached";
interface ReadThroughResult<T> {
    readonly value: T;
    readonly cache: ReadThroughState;
}
interface ChunkedCacheDependencies {
    readonly store: CacheStore;
    readonly codec: CacheTextCodec;
    readonly hasher: HashFunction;
    readonly ids: IdGenerator;
    readonly clock?: Clock;
    readonly random?: RandomSource;
    readonly lock?: SyncLock;
    readonly namespace?: string;
    readonly maxChunkCharacters?: number;
    readonly lockTimeoutMs?: number;
}
/**
 * A CacheService-safe value cache. Chunks are immutable and the manifest is
 * published last, so incomplete publication and early eviction are cache misses.
 */
declare class ChunkedCache {
    private readonly dependencies;
    private readonly clock;
    private readonly random;
    private readonly namespace;
    private readonly maxChunkCharacters;
    private readonly lockTimeoutMs;
    constructor(dependencies: ChunkedCacheDependencies);
    read<T>(logicalKey: unknown): CacheReadResult<T>;
    get<T>(logicalKey: unknown): T | null;
    put<T>(logicalKey: unknown, value: T, policy?: ChunkedCachePolicy): void;
    remove(logicalKey: unknown): void;
    readThrough<T>(logicalKey: unknown, producer: () => T, policy?: ChunkedCachePolicy): ReadThroughResult<T>;
    private baseKey;
    private split;
    private removePhysical;
    private tryPut;
}
type CacheDependency = {
    readonly kind: "table";
    readonly sourceId: string;
    readonly table: string;
} | {
    readonly kind: "row";
    readonly sourceId: string;
    readonly table: string;
    readonly key: unknown;
} | {
    readonly kind: "tag";
    readonly tag: string;
};
interface DependencyGeneration {
    readonly dependency: CacheDependency;
    readonly token: string;
}
/** Durable generation tokens make old cache entries unreachable without a key registry. */
declare class GenerationTokenStore {
    private readonly properties;
    private readonly hasher;
    private readonly ids;
    private readonly namespace;
    constructor(properties: PropertyStore, hasher: HashFunction, ids: IdGenerator, namespace?: string);
    current(dependency: CacheDependency): string;
    snapshot(dependencies: readonly CacheDependency[]): DependencyGeneration[];
    rotate(dependency: CacheDependency): string;
    invalidateTable(sourceId: string, table: string): string;
    invalidateRow(sourceId: string, table: string, key: unknown): string;
    invalidateTag(tag: string): string;
    /** Rotate the table dependency plus optional narrow row/tag dependencies after a committed write. */
    invalidateWrite(sourceId: string, table: string, rowKeys?: readonly unknown[], tags?: readonly string[]): DependencyGeneration[];
    private key;
}
interface QueryCacheKeyInput {
    readonly sourceIdentity: unknown;
    readonly schemaVersion: number | string;
    readonly headerVersion: string;
    readonly query: unknown;
    readonly projection?: readonly string[];
    readonly renderOptions?: unknown;
    readonly scopeIdentity?: unknown;
    readonly generations: readonly DependencyGeneration[];
}
declare function buildQueryCacheKey(input: QueryCacheKeyInput): Readonly<Record<string, unknown>>;
type AppsScriptCacheScope = "script" | "document" | "user";
interface AppsScriptChunkedCacheOptions {
    readonly scope?: AppsScriptCacheScope;
    readonly lock?: SyncLock;
    readonly namespace?: string;
}
declare function createAppsScriptChunkedCache(options?: AppsScriptChunkedCacheOptions): ChunkedCache;
declare function createAppsScriptGenerationStore(namespace?: string): GenerationTokenStore;

type GQueryErrorCode = "API_RATE_LIMIT" | "API_SERVER" | "API_NETWORK" | "API_DEADLINE" | "API_FAILURE" | "DEADLINE_EXCEEDED" | "RETRY_EXHAUSTED" | "AMBIGUOUS_COMMIT" | "CACHE_CORRUPT" | "CACHE_CONFIGURATION" | "JOURNAL_CAPACITY" | "JOURNAL_ENTRY_TOO_LARGE" | "JOURNAL_CORRUPT" | "JOURNAL_LOCK_TIMEOUT" | "DEFERRED_CONFLICT";
declare class GQueryV2Error extends Error {
    readonly code: GQueryErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
    constructor(code: GQueryErrorCode, message: string, details?: Readonly<Record<string, unknown>>, cause?: unknown);
}
type ApiFailureKind = "rate-limit" | "server" | "network" | "deadline" | "non-retryable";
interface ApiFailureDetails {
    readonly kind: ApiFailureKind;
    readonly statusCode?: number;
    readonly retryAfterMs?: number;
    readonly retryable: boolean;
    readonly originalMessage: string;
}
declare class ApiFailure extends GQueryV2Error {
    readonly api: ApiFailureDetails;
    constructor(api: ApiFailureDetails, cause?: unknown);
}
declare class DeadlineExceededError extends GQueryV2Error {
    constructor(deadlineMs: number, nowMs: number, cause?: unknown);
}
declare class RetryExhaustedError extends GQueryV2Error {
    constructor(attempts: number, lastFailure: ApiFailure);
}
declare class AmbiguousCommitError extends GQueryV2Error {
    constructor(operationKind: string, failure: ApiFailure);
}
/** Convert the loose errors emitted by Apps Script advanced services into a stable API error. */
declare function normalizeApiFailure(error: unknown): ApiFailure;

type DeferredMutationKind = "patch" | "upsert" | "delete" | "create";
interface DeferredMutationInput {
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
interface PendingDeferredMutation extends DeferredMutationInput {
    readonly id: string;
    readonly sequence: number;
    readonly enqueuedAtMs: number;
    readonly attempts: number;
    readonly lastAttemptAtMs?: number;
    readonly lastError?: string;
}
type DeferredReceiptStatus = "queued" | "committed" | "conflicted";
interface PendingMutationReceipt {
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly mutationId: string;
    readonly status: DeferredReceiptStatus;
    readonly createdAtMs: number;
    readonly updatedAtMs: number;
    readonly conflict?: Readonly<Record<string, unknown>>;
}
interface DeferredEnqueueResult {
    readonly duplicate: boolean;
    readonly receipt: PendingMutationReceipt;
}
declare class JournalCapacityError extends GQueryV2Error {
    constructor(bytes: number, maximumBytes: number);
}
declare class DeferredMutationTooLargeError extends GQueryV2Error {
    constructor(bytes: number, maximumBytes: number);
}
declare class JournalCorruptionError extends GQueryV2Error {
    constructor(reason: string);
}
declare class JournalLockTimeoutError extends GQueryV2Error {
    constructor(timeoutMs: number);
}
declare class IdempotencyConflictError extends GQueryV2Error {
    constructor(idempotencyKey: string);
}
interface DeferredOverlayPublisher {
    /** Cache-only optimization. Implementations must treat replace failures as recoverable. */
    replace(entries: readonly PendingDeferredMutation[]): void;
}
/** CacheService-backed overlay which remains explicitly rebuildable from the journal. */
declare class ChunkedDeferredOverlay implements DeferredOverlayPublisher {
    private readonly cache;
    private readonly logicalKey;
    private readonly policy;
    constructor(cache: ChunkedCache, logicalKey?: unknown, policy?: ChunkedCachePolicy);
    replace(entries: readonly PendingDeferredMutation[]): void;
    read(): readonly PendingDeferredMutation[] | null;
}
interface DeferredJournalOptions {
    readonly namespace?: string;
    readonly shardByteLimit?: number;
    readonly softByteLimit?: number;
    readonly maxMutationBytes?: number;
    readonly retainedReceiptLimit?: number;
    readonly lockTimeoutMs?: number;
}
interface DeferredJournalDependencies {
    readonly properties: PropertyStore;
    readonly lock: SyncLock;
    readonly hasher: HashFunction;
    readonly ids: IdGenerator;
    readonly clock?: Clock;
    readonly overlay?: DeferredOverlayPublisher;
}
interface CoalescedDeferredMutation {
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
type DeferredOutcomeStatus = "committed" | "transient" | "conflict";
interface DeferredMutationOutcome {
    readonly mutationId: string;
    readonly status: DeferredOutcomeStatus;
    readonly message?: string;
    readonly conflict?: Readonly<Record<string, unknown>>;
}
interface DeferredMutationBatchExecutor {
    /**
     * Missing outcomes are treated as transient. Applying the same mutation id
     * more than once must be harmless because a crash can follow a remote commit.
     */
    apply(mutations: readonly CoalescedDeferredMutation[]): readonly DeferredMutationOutcome[];
}
interface DeferredDeadLetter {
    readonly id: string;
    readonly mutation: CoalescedDeferredMutation;
    readonly originals: readonly PendingDeferredMutation[];
    readonly conflict: Readonly<Record<string, unknown>>;
    readonly movedAtMs: number;
}
interface DeferredDeadLetterSink {
    /** Must be idempotent by dead-letter id because persistence can fail after this call. */
    write(records: readonly DeferredDeadLetter[]): void;
}
interface DeferredFlushResult {
    readonly attempted: number;
    readonly committed: number;
    readonly conflicted: number;
    readonly retained: number;
    readonly coalesced: number;
    readonly errors: readonly string[];
}
/** Only semantically compatible adjacent operations are combined; ordering is otherwise preserved. */
declare function coalesceDeferredMutations(entries: readonly PendingDeferredMutation[], hasher: HashFunction): CoalescedDeferredMutation[];
/** Durable, bounded ScriptProperties journal. Cache overlays are deliberately non-authoritative. */
declare class DeferredJournal {
    private readonly dependencies;
    private readonly clock;
    private readonly namespace;
    private readonly shardByteLimit;
    private readonly softByteLimit;
    private readonly maxMutationBytes;
    private readonly retainedReceiptLimit;
    private readonly lockTimeoutMs;
    constructor(dependencies: DeferredJournalDependencies, options?: DeferredJournalOptions);
    enqueue(input: DeferredMutationInput): DeferredEnqueueResult;
    enqueueOrExecute(input: DeferredMutationInput, immediate: () => PendingMutationReceipt): DeferredEnqueueResult;
    list(): readonly PendingDeferredMutation[];
    receipt(idempotencyKey: string): PendingMutationReceipt | null;
    rebuildOverlay(): number;
    flush(executor: DeferredMutationBatchExecutor, deadLetters: DeferredDeadLetterSink): DeferredFlushResult;
    private locked;
    private get manifestKey();
    private shardKey;
    private load;
    private persist;
    private publishOverlay;
}
declare function createAppsScriptDeferredJournal(options?: DeferredJournalOptions, overlay?: DeferredOverlayPublisher): DeferredJournal;

interface ExecutableQuery<T extends Record<string, unknown>> {
    readonly plan: SerializableQueryPlan;
    readonly localPredicates: readonly ((row: Readonly<T>) => boolean)[];
    readonly refresh: () => Selection<T>;
}
interface RuntimeCacheAdapter {
    read<T>(key: unknown): {
        readonly state: "hit" | "miss" | "corrupt";
        readonly value?: T;
    };
    put<T>(key: unknown, value: T, policy?: {
        ttlSeconds?: number;
        jitterSeconds?: number;
    }): void;
}
interface RuntimeGenerationAdapter {
    current(dependency: {
        readonly kind: "table";
        readonly sourceId: string;
        readonly table: string;
    }): string;
    invalidateTable(sourceId: string, table: string): string;
    invalidateRow?(sourceId: string, table: string, key: unknown): string;
}
interface ExecutorOptions {
    readonly transport: SheetsTransport;
    readonly resolveActiveSpreadsheetId?: () => string;
    readonly now?: () => Date;
    readonly cache?: RuntimeCacheAdapter;
    readonly cacheForScope?: (scope: "script" | "document" | "user") => RuntimeCacheAdapter;
    readonly generations?: RuntimeGenerationAdapter;
    readonly scopeIdentity?: (scope: "script" | "document" | "user") => string | null;
    readonly deferredJournal?: DeferredJournal;
    readonly executionScope?: {
        run<T>(operation: () => T): T;
    };
}
interface QueryExecution<T extends Record<string, unknown>> {
    readonly selection: Selection<T>;
    readonly plan: ExecutionPlan;
}
type UnitOfWorkIntent = {
    readonly id: string;
    readonly kind: "update";
    readonly selection: Selection<Record<string, unknown>>;
    readonly patch: MutationPatch<Record<string, unknown>>;
} | {
    readonly id: string;
    readonly kind: "delete";
    readonly selection: Selection<Record<string, unknown>>;
} | {
    readonly id: string;
    readonly kind: "append";
    readonly tableName: string;
    readonly rows: readonly Record<string, unknown>[];
};
interface WorkbookCommitReceipt {
    readonly spreadsheetId: string;
    readonly status: "committed" | "failed";
    readonly requestCount: number;
    readonly error?: unknown;
}
interface UnitOfWorkCommitResult {
    readonly status: "committed" | "conflicted" | "partial";
    readonly conflicts: readonly MutationConflict[];
    readonly workbooks: readonly WorkbookCommitReceipt[];
    readonly stats: ExecutionStats;
}
/** Purely synchronous schema/query executor over an injectable Sheets transport. */
declare class GQueryExecutor implements SelectionRuntime {
    private readonly schema;
    private readonly options;
    private readonly metadata;
    private readonly headers;
    private readonly locators;
    private readonly now;
    constructor(schema: DatabaseDefinition, options: ExecutorOptions);
    execute<T extends Record<string, unknown>>(query: ExecutableQuery<T>): QueryExecution<T>;
    executeBatch(queries: Readonly<Record<string, ExecutableQuery<Record<string, unknown>>>>): {
        readonly selections: Readonly<Record<string, Selection<Record<string, unknown>>>>;
        readonly plans: Readonly<Record<string, ExecutionPlan>>;
    };
    private executeBatchUnscoped;
    explain<T extends Record<string, unknown>>(query: ExecutableQuery<T>, executedMode?: "bounded" | "full-scan"): ExecutionPlan;
    refresh<T extends Record<string, unknown>>(selection: Selection<T>): Selection<T>;
    update<T extends Record<string, unknown>>(selection: Selection<T>, patch: MutationPatch<T>, options?: MutationOptions): MutationResult<T>;
    private updateUnscoped;
    delete<T extends Record<string, unknown>>(selection: Selection<T>, options?: DeleteOptions): MutationResult<T>;
    private deleteUnscoped;
    append(tableName: string, rows: readonly Record<string, unknown>[]): MutationResult<Record<string, unknown>>;
    private appendUnscoped;
    /** Compile staged operations and commit each workbook in one atomic batch. */
    commitUnitOfWork(intents: readonly UnitOfWorkIntent[]): UnitOfWorkCommitResult;
    private commitUnitOfWorkUnscoped;
    invalidateTable(spreadsheetId: string, tableName: string): void;
    invalidateStructure(spreadsheetId: string): void;
    private emptyMutation;
    private scoped;
    private deferUpdate;
    private deferDelete;
    private prepareUpdates;
    private deleteRelationEdges;
    private reachableDeleteEdges;
    private loadDeleteRelationRows;
    private planReferentialDelete;
    private uniqueMaterialized;
    private prepareAppend;
    private recordTouched;
    private table;
    private source;
    private sourceIdentity;
    private spreadsheetId;
    private resolveTable;
    private parseHeader;
    private parseSnapshot;
    private requireSnapshot;
    private cacheForTable;
    private indexForQuery;
    private tryBoundedRead;
    private scanLocator;
    private loadLocatedRows;
    private locatorKey;
    private registerLocators;
    private clearTableLocators;
    private tableCacheKey;
    private preflight;
    private assertSingleMutationTable;
    private groupPatchesBySpreadsheet;
    private sheetName;
    private invalidateMaterialized;
}

type RetryOperationKind = "read" | "idempotent-write" | "append" | "structural-delete" | "write";
interface RetryOperation {
    readonly kind: RetryOperationKind;
    /** A durable key whose receipt is checked by the caller/transport. */
    readonly idempotencyKey?: string;
    /** Use only when applying the request twice is demonstrably harmless. */
    readonly idempotent?: boolean;
}
interface RetryPolicy {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
}
interface RetryAttemptContext {
    readonly attempt: number;
    readonly remainingMs: number;
}
interface RetryStats {
    readonly attempts: number;
    readonly retries: number;
    readonly sleptMs: number;
    readonly elapsedMs: number;
    readonly lastFailureKind?: ApiFailure["api"]["kind"];
}
interface RetryExecution<T> {
    readonly value: T;
    readonly stats: RetryStats;
}
declare class ExecutionBudget {
    private readonly clock;
    readonly startedAtMs: number;
    readonly deadlineMs: number;
    constructor(maxElapsedMs?: number, clock?: Clock);
    now(): number;
    elapsedMs(): number;
    remainingMs(): number;
    assertAvailable(cause?: unknown): void;
}
interface RetryControllerDependencies {
    readonly clock?: Clock;
    readonly sleeper?: Sleeper;
    readonly random?: RandomSource;
}
interface RetryExecutionOptions extends RetryPolicy {
    readonly operation: RetryOperation;
    readonly budget?: ExecutionBudget;
}
/** Synchronous retry execution which can share one deadline across many API calls. */
declare class RetryController {
    private readonly clock;
    private readonly sleeper;
    private readonly random;
    constructor(dependencies?: RetryControllerDependencies);
    run<T>(operation: (context: RetryAttemptContext) => T, options: RetryExecutionOptions): T;
    execute<T>(operation: (context: RetryAttemptContext) => T, options: RetryExecutionOptions): RetryExecution<T>;
}

interface RetryTransportInvokerOptions extends RetryPolicy {
    readonly budget: ExecutionBudget;
    readonly idempotencyKey?: (context: TransportOperationContext) => string | undefined;
    readonly onAttemptComplete?: (context: TransportOperationContext, stats: RetryStats) => void;
}
/** Connects the transport interception port to a shared retry/deadline budget. */
declare class RetryTransportInvoker implements TransportInvoker {
    private readonly controller;
    private readonly options;
    constructor(controller: RetryController, options: RetryTransportInvokerOptions);
    invoke<T>(context: TransportOperationContext, operation: () => T): T;
}
interface ScopedRetryTransportInvokerOptions extends RetryPolicy {
    readonly maxElapsedMs?: number;
    readonly idempotencyKey?: (context: TransportOperationContext) => string | undefined;
    readonly onAttemptComplete?: (context: TransportOperationContext, stats: RetryStats) => void;
}
/**
 * Shares one deadline across every transport call made inside `run()`. Nested
 * scopes reuse the outer deadline, while an isolated invocation still gets a
 * bounded budget of its own.
 */
declare class ScopedRetryTransportInvoker implements TransportInvoker {
    private readonly controller;
    private readonly options;
    private activeBudget;
    private depth;
    constructor(controller: RetryController, options?: ScopedRetryTransportInvokerOptions);
    run<T>(operation: () => T): T;
    invoke<T>(context: TransportOperationContext, operation: () => T): T;
}

type SchemaIssueCode = "MISSING_SHEET" | "MISSING_HEADER" | "MISSING_VERSION_COLUMN" | "DUPLICATE_HEADER" | "INVALID_CELL" | "LEGACY_ENCODING" | "DUPLICATE_PRIMARY_KEY" | "BROKEN_RELATION";
interface SchemaIssue {
    readonly code: SchemaIssueCode;
    readonly severity: "info" | "warning" | "error";
    readonly source: string;
    readonly spreadsheetId: string;
    readonly table: string;
    readonly sheet: string;
    readonly row?: number;
    readonly column?: string;
    readonly header?: string;
    readonly message: string;
}
type SchemaMigrationAction = {
    readonly kind: "add-version-column";
    readonly spreadsheetId: string;
    readonly table: string;
    readonly sheet: string;
    readonly sheetId: number;
    readonly header: string;
    readonly columnIndex: number;
    readonly dataRows: number;
    readonly gridColumnCount: number;
} | {
    readonly kind: "create-system-sheet";
    readonly spreadsheetId: string;
    readonly sheet: "_gq_meta" | "_gq_dead_letters";
} | {
    readonly kind: "backfill-cell";
    readonly spreadsheetId: string;
    readonly table: string;
    readonly sheet: string;
    readonly sheetId: number;
    readonly rowIndex: number;
    readonly columnIndex: number;
    readonly value: SheetCellInput;
};
interface SchemaPlan {
    readonly schemaVersion: 2;
    readonly generatedAt: string;
    readonly issues: readonly SchemaIssue[];
    readonly actions: readonly SchemaMigrationAction[];
    readonly backupRequired: boolean;
    readonly canMigrate: boolean;
    readonly canonicalCells: number;
    readonly legacyCells: number;
    readonly invalidCells: number;
}
interface SchemaMigrationOptions {
    readonly confirm: true;
    readonly backupIds?: Readonly<Record<string, string>>;
    readonly createBackups?: boolean;
    readonly includeBackfill?: boolean;
    readonly adapter?: SchemaMigrationAdapter;
}
interface SchemaMigrationResult {
    readonly status: "migrated" | "no-op";
    readonly backups: Readonly<Record<string, string>>;
    readonly appliedActions: number;
    readonly plan: SchemaPlan;
}
interface SchemaMigrationAdapter {
    createBackup(spreadsheetId: string): string;
    apply(spreadsheetId: string, actions: readonly SchemaMigrationAction[], context: {
        readonly backupId: string;
        readonly migratedAt: string;
    }): void;
}
interface SchemaManagementAccess {
    readonly definition: DatabaseDefinition;
    readonly transport: SheetsTransport;
    resolveSourceId(sourceName: string): string;
}
/** Read-only audit plus explicit, backup-gated schema migration. */
declare class SchemaManager {
    private readonly access;
    constructor(access: SchemaManagementAccess);
    plan(): SchemaPlan;
    migrate(options: SchemaMigrationOptions): SchemaMigrationResult;
    private loadTables;
    private issue;
}
/** Default Apps Script migration adapter. It is used only by explicit migrate(). */
declare class AppsScriptSchemaMigrationAdapter implements SchemaMigrationAdapter {
    createBackup(spreadsheetId: string): string;
    apply(spreadsheetId: string, actions: readonly SchemaMigrationAction[], context: {
        readonly backupId: string;
        readonly migratedAt: string;
    }): void;
}

type ManagedTriggerKind = "edit" | "change" | "clock";
interface ManagedTriggerSpec {
    readonly kind: ManagedTriggerKind;
    readonly handler: string;
    readonly spreadsheetId?: string;
    readonly everyMinutes?: number;
}
interface InstalledTrigger extends ManagedTriggerSpec {
    readonly id: string;
}
interface TriggerPlatform {
    list(): readonly InstalledTrigger[];
    create(spec: ManagedTriggerSpec): InstalledTrigger;
    remove(id: string): void;
}
interface TriggerConfiguration {
    readonly spreadsheetId: string;
    readonly onEdit?: string;
    readonly onChange?: string;
    readonly flush?: {
        readonly handler: string;
        readonly everyMinutes: 1 | 5 | 10 | 15 | 30;
    };
}
interface TriggerReconciliationResult {
    readonly created: readonly InstalledTrigger[];
    readonly kept: readonly InstalledTrigger[];
    readonly removed: readonly InstalledTrigger[];
}
/** Reconciles only handlers named by the configuration and leaves unrelated project triggers alone. */
declare class TriggerReconciler {
    private readonly platform;
    constructor(platform: TriggerPlatform);
    reconcile(configuration: TriggerConfiguration): TriggerReconciliationResult;
}
/** Apps Script adapter which persists clock cadence because Trigger does not expose it. */
declare class AppsScriptTriggerPlatform implements TriggerPlatform {
    private readonly properties;
    private readonly metadataNamespace;
    constructor(properties: PropertyStore, metadataNamespace?: string);
    list(): readonly InstalledTrigger[];
    create(spec: ManagedTriggerSpec): InstalledTrigger;
    remove(id: string): void;
    private metadataKey;
    private readMetadata;
}
declare function createAppsScriptTriggerReconciler(namespace?: string): TriggerReconciler;
interface RegisteredSheetTable {
    readonly sourceId: string;
    readonly sheetId: number;
    readonly table: string;
}
interface NormalizedEditEvent {
    readonly sourceId: string;
    readonly sheetId: number;
    readonly rowStart: number;
    readonly rowCount: number;
    readonly columnStart: number;
    readonly columnCount: number;
}
interface NormalizedChangeEvent {
    readonly sourceId: string;
    readonly changeType: GoogleAppsScript.Events.SheetsOnChangeChangeType;
}
interface ManualEditHooks {
    /** Implementations may increment hidden row versions and return decoded primary keys. */
    onRowsEdited?(table: RegisteredSheetTable, event: NormalizedEditEvent): readonly unknown[] | void;
    onStructuralChange?(tables: readonly RegisteredSheetTable[], event: NormalizedChangeEvent): void;
}
interface SystemEventResult {
    readonly invalidatedTables: readonly string[];
    readonly invalidatedRows: number;
}
/** Bridges normalized or native installable-trigger events to version/cache invalidation hooks. */
declare class SystemEventCoordinator {
    private readonly tables;
    private readonly generations;
    private readonly hooks;
    constructor(tables: readonly RegisteredSheetTable[], generations: GenerationTokenStore, hooks?: ManualEditHooks);
    handleEdit(event: NormalizedEditEvent): SystemEventResult;
    handleNativeEdit(event: GoogleAppsScript.Events.SheetsOnEdit): SystemEventResult;
    handleChange(event: NormalizedChangeEvent): SystemEventResult;
    handleNativeChange(event: GoogleAppsScript.Events.SheetsOnChange): SystemEventResult;
}

interface TriggerSetup {
    readonly spreadsheetId?: string;
    readonly onEdit?: string;
    readonly onChange?: string;
    readonly flush?: {
        readonly handler: string;
        readonly everyMinutes: 1 | 5 | 10 | 15 | 30;
    };
}
interface SystemStatus {
    readonly tables: readonly (RegisteredSheetTable & {
        readonly generation: string;
    })[];
}
interface SystemManagerAccess {
    readonly definition: DatabaseDefinition;
    readonly transport: SheetsTransport;
    readonly executor: GQueryExecutor;
    readonly generations?: RuntimeGenerationAdapter;
    resolveSourceId(sourceName: string): string;
}
/** Implements manual-edit version increments with one bounded read/write per edited block. */
declare class AppsScriptManualEditHooks implements ManualEditHooks {
    private readonly definition;
    constructor(definition: DatabaseDefinition);
    onRowsEdited(table: RegisteredSheetTable, event: NormalizedEditEvent): readonly unknown[];
}
declare class SystemManager {
    private readonly access;
    private readonly hooks?;
    constructor(access: SystemManagerAccess, hooks?: ManualEditHooks | undefined);
    reconcileTriggers(configuration: TriggerSetup): TriggerReconciliationResult;
    handleEdit(event: GoogleAppsScript.Events.SheetsOnEdit | NormalizedEditEvent): SystemEventResult;
    handleChange(event: GoogleAppsScript.Events.SheetsOnChange | NormalizedChangeEvent): SystemEventResult;
    status(): SystemStatus;
    private coordinator;
    private registeredTables;
    private defaultSpreadsheetId;
    private requireGenerations;
}

interface DeferredManagerAccess {
    readonly definition: DatabaseDefinition;
    find(tableName: string, key: Readonly<Record<string, unknown>>): Selection<Record<string, unknown>>;
    append(tableName: string, row: Record<string, unknown>): MutationResult<Record<string, unknown>>;
}
interface DeferredManagerOptions {
    readonly journal?: DeferredJournal;
    readonly deadLetters?: DeferredDeadLetterSink;
    readonly appliedReceipts?: PropertyStore;
    readonly namespace?: string;
}
/** Operational facade for the durable journal and five-minute flush handler. */
declare class DeferredManager {
    private readonly access;
    private readonly options;
    private readonly namespace;
    constructor(access: DeferredManagerAccess, options?: DeferredManagerOptions);
    list(): readonly PendingDeferredMutation[];
    receipt(idempotencyKey: string): PendingMutationReceipt | null;
    rebuildOverlay(): number;
    flush(): DeferredFlushResult;
    private journal;
    private defaultProperties;
}

type AnyRow = Record<string, unknown>;
type TableNames<D extends DatabaseDefinition> = Extract<keyof D["tables"], string>;
type TableAt<D extends DatabaseDefinition, N extends TableNames<D>> = D["tables"][N];
type RowAt<D extends DatabaseDefinition, N extends TableNames<D>> = Extract<InferTableRow<TableAt<D, N>>, AnyRow>;
type RelationsAt<D extends DatabaseDefinition, N extends TableNames<D>> = TableAt<D, N> extends TableDefinition<infer _Columns, infer _Source, infer _Primary, infer Relations, infer _Unique> ? Relations : RelationMap;
type RelationTarget<R> = R extends RelationDefinition<infer _Kind, infer Target, infer _Local, infer _Foreign> ? Target : never;
type RelationValue<D extends DatabaseDefinition, R> = RelationTarget<R> extends TableNames<D> ? R extends RelationDefinition<"has-many"> ? readonly RowAt<D, Extract<RelationTarget<R>, TableNames<D>>>[] : RowAt<D, Extract<RelationTarget<R>, TableNames<D>>> | null : never;
type IncludedRow<D extends DatabaseDefinition, N extends TableNames<D>, Row extends AnyRow, R extends Extract<keyof RelationsAt<D, N>, string>> = Row & {
    readonly [Name in R]: RelationValue<D, RelationsAt<D, N>[Name]>;
};
interface JoinOptions<Row extends AnyRow, OtherRow extends AnyRow, Alias extends string> {
    readonly as: Alias;
    readonly on: {
        readonly local: Extract<keyof Row, string> | readonly Extract<keyof Row, string>[];
        readonly foreign: Extract<keyof OtherRow, string> | readonly Extract<keyof OtherRow, string>[];
    };
    readonly kind?: JoinKind;
    readonly cardinality?: JoinCardinality;
    readonly select?: readonly Extract<keyof OtherRow, string>[];
}
interface Group<T extends AnyRow> {
    readonly key: Readonly<Partial<T>>;
    readonly rows: readonly Readonly<T>[];
    readonly count: number;
}
interface UpsertResult<T extends AnyRow> {
    readonly status: "committed" | "conflicted" | "partial";
    readonly inserted: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly conflicted: number;
    readonly workbooks: readonly WorkbookCommitReceipt[];
    readonly update?: MutationResult<T>;
    readonly insert?: MutationResult<T>;
    readonly stats: ExecutionStats;
}
interface SyncOptions<T extends AnyRow> {
    readonly keys?: readonly Extract<keyof T, string>[];
    readonly preserve?: readonly Extract<keyof T, string>[];
    readonly missing?: {
        readonly action: "keep";
    } | {
        readonly action: "delete";
    } | {
        readonly action: "deactivate";
        readonly field: Extract<keyof T, string>;
        readonly value: T[Extract<keyof T, string>];
    };
}
interface SyncResult<T extends AnyRow> extends UpsertResult<T> {
    readonly deactivated: number;
    readonly deleted: number;
}
/** An immutable query handle. Every chain method returns a new instance. */
declare class Query<D extends DatabaseDefinition, N extends TableNames<D>, Row extends AnyRow = RowAt<D, N>> {
    protected readonly database: GQueryDatabase<D>;
    readonly tableName: N;
    protected readonly plan: SerializableQueryPlan;
    protected readonly localPredicates: readonly ((row: Readonly<Row>) => boolean)[];
    constructor(database: GQueryDatabase<D>, tableName: N, plan: SerializableQueryPlan, localPredicates?: readonly ((row: Readonly<Row>) => boolean)[]);
    protected next<NextRow extends AnyRow = Row>(plan: SerializableQueryPlan, localPredicates?: readonly ((row: Readonly<NextRow>) => boolean)[]): Query<D, N, NextRow>;
    all(): Query<D, N, Row>;
    where(predicate: Where<Row>): Query<D, N, Row>;
    whereLocal(predicate: (row: Readonly<Row>) => boolean): Query<D, N, Row>;
    select<const Fields extends readonly Extract<keyof Row, string>[]>(fields: Fields): Query<D, N, Pick<Row, Fields[number]> & AnyRow>;
    orderBy(field: Extract<keyof Row, string>, direction?: SortDirection): Query<D, N, Row>;
    limit(value: number): Query<D, N, Row>;
    offset(value: number): Query<D, N, Row>;
    tail(value: number): Query<D, N, Row>;
    include<RelationName extends Extract<keyof RelationsAt<D, N>, string>>(name: RelationName): Query<D, N, IncludedRow<D, N, Row, RelationName>>;
    join<OtherName extends TableNames<D>, const Alias extends string>(other: TableHandle<D, OtherName>, options: JoinOptions<Row, RowAt<D, OtherName>, Alias>): Query<D, N, Row & {
        readonly [Key in Alias]: RowAt<D, OtherName> | readonly RowAt<D, OtherName>[] | null;
    }>;
    get(): Selection<Row>;
    findOne(): Selection<Row>;
    maybeOne(): Selection<Row>;
    find(key: unknown): Selection<Row>;
    count(): number;
    exists(): boolean;
    groupBy(fields: readonly Extract<keyof Row, string>[]): readonly Group<Row>[];
    update(patch: MutationPatch<Row>, options?: MutationOptions): MutationResult<Row>;
    delete(options?: DeleteOptions): MutationResult<Row>;
    explain(): ExecutionPlan;
    executable(): ExecutableQuery<Row>;
}
declare class TableHandle<D extends DatabaseDefinition, N extends TableNames<D>> extends Query<D, N, RowAt<D, N>> {
    constructor(database: GQueryDatabase<D>, tableName: N);
    append(row: RowAt<D, N>): MutationResult<RowAt<D, N>>;
    appendMany(rows: readonly RowAt<D, N>[]): MutationResult<RowAt<D, N>>;
    upsertMany(incoming: readonly RowAt<D, N>[], options?: {
        readonly keys?: readonly Extract<keyof RowAt<D, N>, string>[];
    }): UpsertResult<RowAt<D, N>>;
    sync(incoming: readonly RowAt<D, N>[], options?: SyncOptions<RowAt<D, N>>): SyncResult<RowAt<D, N>>;
}
type TableHandles<D extends DatabaseDefinition> = {
    readonly [N in TableNames<D>]: TableHandle<D, N>;
};
type BatchSelections<Q extends Readonly<Record<string, Query<any, any, any>>>> = {
    readonly [K in keyof Q]: Q[K] extends Query<any, any, infer Row> ? Selection<Extract<Row, AnyRow>> : never;
};
declare class BatchQuery<D extends DatabaseDefinition, Q extends Readonly<Record<string, Query<any, any, any>>>> {
    private readonly database;
    private readonly queries;
    constructor(database: GQueryDatabase<D>, queries: Q);
    get(): BatchSelections<Q>;
}
interface RawValuesApi<Sources extends SourceMap> {
    get(source: Extract<keyof Sources, string>, range: string, options?: SheetReadOptions): SheetValueRange;
    batchGet(source: Extract<keyof Sources, string>, ranges: readonly string[], options?: SheetReadOptions): SheetBatchGetResult;
    batchUpdate(source: Extract<keyof Sources, string>, updates: readonly SheetValueUpdate[], options?: SheetBatchUpdateOptions): SheetBatchUpdateResult;
    atomicBatchUpdate(source: Extract<keyof Sources, string>, mutations: readonly AtomicMutation[]): void;
}
interface CreateGQueryOptions extends Omit<ExecutorOptions, "transport"> {
    readonly transport?: SheetsTransport;
    readonly retry?: ScopedRetryTransportInvokerOptions;
    readonly systemHooks?: ManualEditHooks;
    readonly deferredDeadLetters?: DeferredDeadLetterSink;
    readonly deferredAppliedReceipts?: PropertyStore;
}
interface UnitOfWorkOptions {
    readonly lock?: "auto" | "document" | "script" | SyncLock;
    readonly timeoutMs?: number;
}
interface UnitOfWorkResult<T> extends UnitOfWorkCommitResult {
    readonly value: T;
    readonly lockWaitMs: number;
}
interface DatabaseInternals {
    readonly executor: GQueryExecutor;
    readonly transport: SheetsTransport;
    readonly selectionRuntime: SelectionRuntime;
    readonly append: (tableName: string, rows: readonly Record<string, unknown>[]) => MutationResult<Record<string, unknown>>;
    readonly resolveActiveSpreadsheetId?: () => string;
    readonly generations?: RuntimeGenerationAdapter;
    readonly systemHooks?: ManualEditHooks;
    readonly deferredJournal?: DeferredJournal;
    readonly deferredDeadLetters?: DeferredDeadLetterSink;
    readonly deferredAppliedReceipts?: PropertyStore;
}
declare class GQueryDatabase<D extends DatabaseDefinition> {
    readonly definition: D;
    readonly executor: GQueryExecutor;
    readonly tables: TableHandles<D>;
    readonly raw: {
        readonly values: RawValuesApi<D["sources"]>;
    };
    readonly schema: SchemaManager;
    readonly system: SystemManager;
    readonly deferred: DeferredManager;
    private readonly selectionRuntime;
    private readonly appendOperation;
    private readonly transport;
    private readonly activeResolver?;
    private readonly generations?;
    private readonly systemHooks?;
    private readonly deferredJournal?;
    private readonly deferredDeadLetters?;
    private readonly deferredAppliedReceipts?;
    constructor(definition: D, options?: CreateGQueryOptions, internals?: DatabaseInternals);
    batch<const Q extends Readonly<Record<string, Query<any, any, any>>>>(queries: Q): BatchQuery<D, Q>;
    materialize<T extends AnyRow>(selection: Selection<T>): Selection<T>;
    appendRows<T extends AnyRow>(tableName: string, rows: readonly T[]): MutationResult<T>;
    unitOfWork<T>(options: UnitOfWorkOptions, callback: (transaction: GQuery<D>) => T): UnitOfWorkResult<T>;
    unitOfWork<T>(callback: (transaction: GQuery<D>) => T): UnitOfWorkResult<T>;
    resolveSourceId(sourceName: Extract<keyof D["sources"], string>, resolver?: () => string): string;
    private createRawValues;
}
type GQuery<D extends DatabaseDefinition> = GQueryDatabase<D> & TableHandles<D>;
/** Create lazy typed table handles without opening any spreadsheet. */
declare function createGQuery<const D extends DatabaseDefinition>(definition: D, options?: CreateGQueryOptions): GQuery<D>;

type index_d_AmbiguousCommitError = AmbiguousCommitError;
declare const index_d_AmbiguousCommitError: typeof AmbiguousCommitError;
type index_d_ApiFailure = ApiFailure;
declare const index_d_ApiFailure: typeof ApiFailure;
type index_d_ApiFailureDetails = ApiFailureDetails;
type index_d_ApiFailureKind = ApiFailureKind;
type index_d_AppsScriptCacheScope = AppsScriptCacheScope;
type index_d_AppsScriptCacheStore = AppsScriptCacheStore;
declare const index_d_AppsScriptCacheStore: typeof AppsScriptCacheStore;
type index_d_AppsScriptChunkedCacheOptions = AppsScriptChunkedCacheOptions;
type index_d_AppsScriptGzipBase64Codec = AppsScriptGzipBase64Codec;
declare const index_d_AppsScriptGzipBase64Codec: typeof AppsScriptGzipBase64Codec;
type index_d_AppsScriptLock = AppsScriptLock;
declare const index_d_AppsScriptLock: typeof AppsScriptLock;
type index_d_AppsScriptPropertyStore = AppsScriptPropertyStore;
declare const index_d_AppsScriptPropertyStore: typeof AppsScriptPropertyStore;
type index_d_AppsScriptSha256Hash = AppsScriptSha256Hash;
declare const index_d_AppsScriptSha256Hash: typeof AppsScriptSha256Hash;
type index_d_AppsScriptTriggerPlatform = AppsScriptTriggerPlatform;
declare const index_d_AppsScriptTriggerPlatform: typeof AppsScriptTriggerPlatform;
type index_d_CacheDependency = CacheDependency;
type index_d_CacheReadResult<T> = CacheReadResult<T>;
type index_d_CacheReadState = CacheReadState;
type index_d_CacheStore = CacheStore;
type index_d_CacheTextCodec = CacheTextCodec;
type index_d_ChunkedCache = ChunkedCache;
declare const index_d_ChunkedCache: typeof ChunkedCache;
type index_d_ChunkedCacheDependencies = ChunkedCacheDependencies;
type index_d_ChunkedCachePolicy = ChunkedCachePolicy;
type index_d_ChunkedDeferredOverlay = ChunkedDeferredOverlay;
declare const index_d_ChunkedDeferredOverlay: typeof ChunkedDeferredOverlay;
type index_d_Clock = Clock;
type index_d_CoalescedDeferredMutation = CoalescedDeferredMutation;
type index_d_DeadlineExceededError = DeadlineExceededError;
declare const index_d_DeadlineExceededError: typeof DeadlineExceededError;
type index_d_DeferredDeadLetter = DeferredDeadLetter;
type index_d_DeferredDeadLetterSink = DeferredDeadLetterSink;
type index_d_DeferredEnqueueResult = DeferredEnqueueResult;
type index_d_DeferredFlushResult = DeferredFlushResult;
type index_d_DeferredJournal = DeferredJournal;
declare const index_d_DeferredJournal: typeof DeferredJournal;
type index_d_DeferredJournalDependencies = DeferredJournalDependencies;
type index_d_DeferredJournalOptions = DeferredJournalOptions;
type index_d_DeferredMutationBatchExecutor = DeferredMutationBatchExecutor;
type index_d_DeferredMutationInput = DeferredMutationInput;
type index_d_DeferredMutationKind = DeferredMutationKind;
type index_d_DeferredMutationOutcome = DeferredMutationOutcome;
type index_d_DeferredMutationTooLargeError = DeferredMutationTooLargeError;
declare const index_d_DeferredMutationTooLargeError: typeof DeferredMutationTooLargeError;
type index_d_DeferredOutcomeStatus = DeferredOutcomeStatus;
type index_d_DeferredOverlayPublisher = DeferredOverlayPublisher;
type index_d_DeferredReceiptStatus = DeferredReceiptStatus;
type index_d_DependencyGeneration = DependencyGeneration;
type index_d_ExecutionBudget = ExecutionBudget;
declare const index_d_ExecutionBudget: typeof ExecutionBudget;
type index_d_Fnv1aHash = Fnv1aHash;
declare const index_d_Fnv1aHash: typeof Fnv1aHash;
type index_d_GQueryErrorCode = GQueryErrorCode;
type index_d_GQueryV2Error = GQueryV2Error;
declare const index_d_GQueryV2Error: typeof GQueryV2Error;
type index_d_GenerationTokenStore = GenerationTokenStore;
declare const index_d_GenerationTokenStore: typeof GenerationTokenStore;
type index_d_HashFunction = HashFunction;
type index_d_IdGenerator = IdGenerator;
type index_d_IdempotencyConflictError = IdempotencyConflictError;
declare const index_d_IdempotencyConflictError: typeof IdempotencyConflictError;
type index_d_InstalledTrigger = InstalledTrigger;
type index_d_JournalCapacityError = JournalCapacityError;
declare const index_d_JournalCapacityError: typeof JournalCapacityError;
type index_d_JournalCorruptionError = JournalCorruptionError;
declare const index_d_JournalCorruptionError: typeof JournalCorruptionError;
type index_d_JournalLockTimeoutError = JournalLockTimeoutError;
declare const index_d_JournalLockTimeoutError: typeof JournalLockTimeoutError;
type index_d_ManagedTriggerKind = ManagedTriggerKind;
type index_d_ManagedTriggerSpec = ManagedTriggerSpec;
type index_d_ManualEditHooks = ManualEditHooks;
type index_d_NormalizedChangeEvent = NormalizedChangeEvent;
type index_d_NormalizedEditEvent = NormalizedEditEvent;
type index_d_PendingDeferredMutation = PendingDeferredMutation;
type index_d_PendingMutationReceipt = PendingMutationReceipt;
type index_d_PlainTextCacheCodec = PlainTextCacheCodec;
declare const index_d_PlainTextCacheCodec: typeof PlainTextCacheCodec;
type index_d_PropertyStore = PropertyStore;
type index_d_QueryCacheKeyInput = QueryCacheKeyInput;
type index_d_RandomSource = RandomSource;
type index_d_ReadThroughResult<T> = ReadThroughResult<T>;
type index_d_ReadThroughState = ReadThroughState;
type index_d_RegisteredSheetTable = RegisteredSheetTable;
type index_d_RetryAttemptContext = RetryAttemptContext;
type index_d_RetryController = RetryController;
declare const index_d_RetryController: typeof RetryController;
type index_d_RetryControllerDependencies = RetryControllerDependencies;
type index_d_RetryExecution<T> = RetryExecution<T>;
type index_d_RetryExecutionOptions = RetryExecutionOptions;
type index_d_RetryExhaustedError = RetryExhaustedError;
declare const index_d_RetryExhaustedError: typeof RetryExhaustedError;
type index_d_RetryOperation = RetryOperation;
type index_d_RetryOperationKind = RetryOperationKind;
type index_d_RetryPolicy = RetryPolicy;
type index_d_RetryStats = RetryStats;
type index_d_RetryTransportInvoker = RetryTransportInvoker;
declare const index_d_RetryTransportInvoker: typeof RetryTransportInvoker;
type index_d_RetryTransportInvokerOptions = RetryTransportInvokerOptions;
type index_d_ScopedRetryTransportInvoker = ScopedRetryTransportInvoker;
declare const index_d_ScopedRetryTransportInvoker: typeof ScopedRetryTransportInvoker;
type index_d_ScopedRetryTransportInvokerOptions = ScopedRetryTransportInvokerOptions;
type index_d_Sleeper = Sleeper;
type index_d_SyncLock = SyncLock;
type index_d_SystemEventCoordinator = SystemEventCoordinator;
declare const index_d_SystemEventCoordinator: typeof SystemEventCoordinator;
type index_d_SystemEventResult = SystemEventResult;
type index_d_TriggerConfiguration = TriggerConfiguration;
type index_d_TriggerPlatform = TriggerPlatform;
type index_d_TriggerReconciler = TriggerReconciler;
declare const index_d_TriggerReconciler: typeof TriggerReconciler;
type index_d_TriggerReconciliationResult = TriggerReconciliationResult;
declare const index_d_appsScriptSleeper: typeof appsScriptSleeper;
declare const index_d_buildQueryCacheKey: typeof buildQueryCacheKey;
declare const index_d_canonicalStringify: typeof canonicalStringify;
declare const index_d_coalesceDeferredMutations: typeof coalesceDeferredMutations;
declare const index_d_createAppsScriptChunkedCache: typeof createAppsScriptChunkedCache;
declare const index_d_createAppsScriptDeferredJournal: typeof createAppsScriptDeferredJournal;
declare const index_d_createAppsScriptGenerationStore: typeof createAppsScriptGenerationStore;
declare const index_d_createAppsScriptTriggerReconciler: typeof createAppsScriptTriggerReconciler;
declare const index_d_hashCanonical: typeof hashCanonical;
declare const index_d_mathRandomSource: typeof mathRandomSource;
declare const index_d_normalizeApiFailure: typeof normalizeApiFailure;
declare const index_d_systemClock: typeof systemClock;
declare const index_d_withLock: typeof withLock;
declare namespace index_d {
  export { index_d_AmbiguousCommitError as AmbiguousCommitError, index_d_ApiFailure as ApiFailure, index_d_AppsScriptCacheStore as AppsScriptCacheStore, index_d_AppsScriptGzipBase64Codec as AppsScriptGzipBase64Codec, index_d_AppsScriptLock as AppsScriptLock, index_d_AppsScriptPropertyStore as AppsScriptPropertyStore, index_d_AppsScriptSha256Hash as AppsScriptSha256Hash, index_d_AppsScriptTriggerPlatform as AppsScriptTriggerPlatform, index_d_ChunkedCache as ChunkedCache, index_d_ChunkedDeferredOverlay as ChunkedDeferredOverlay, index_d_DeadlineExceededError as DeadlineExceededError, index_d_DeferredJournal as DeferredJournal, index_d_DeferredMutationTooLargeError as DeferredMutationTooLargeError, index_d_ExecutionBudget as ExecutionBudget, index_d_Fnv1aHash as Fnv1aHash, index_d_GQueryV2Error as GQueryV2Error, index_d_GenerationTokenStore as GenerationTokenStore, index_d_IdempotencyConflictError as IdempotencyConflictError, index_d_JournalCapacityError as JournalCapacityError, index_d_JournalCorruptionError as JournalCorruptionError, index_d_JournalLockTimeoutError as JournalLockTimeoutError, index_d_PlainTextCacheCodec as PlainTextCacheCodec, index_d_RetryController as RetryController, index_d_RetryExhaustedError as RetryExhaustedError, index_d_RetryTransportInvoker as RetryTransportInvoker, index_d_ScopedRetryTransportInvoker as ScopedRetryTransportInvoker, index_d_SystemEventCoordinator as SystemEventCoordinator, index_d_TriggerReconciler as TriggerReconciler, index_d_appsScriptSleeper as appsScriptSleeper, index_d_buildQueryCacheKey as buildQueryCacheKey, index_d_canonicalStringify as canonicalStringify, index_d_coalesceDeferredMutations as coalesceDeferredMutations, index_d_createAppsScriptChunkedCache as createAppsScriptChunkedCache, index_d_createAppsScriptDeferredJournal as createAppsScriptDeferredJournal, index_d_createAppsScriptGenerationStore as createAppsScriptGenerationStore, index_d_createAppsScriptTriggerReconciler as createAppsScriptTriggerReconciler, index_d_hashCanonical as hashCanonical, index_d_mathRandomSource as mathRandomSource, index_d_normalizeApiFailure as normalizeApiFailure, index_d_systemClock as systemClock, index_d_withLock as withLock };
  export type { index_d_ApiFailureDetails as ApiFailureDetails, index_d_ApiFailureKind as ApiFailureKind, index_d_AppsScriptCacheScope as AppsScriptCacheScope, index_d_AppsScriptChunkedCacheOptions as AppsScriptChunkedCacheOptions, index_d_CacheDependency as CacheDependency, index_d_CacheReadResult as CacheReadResult, index_d_CacheReadState as CacheReadState, index_d_CacheStore as CacheStore, index_d_CacheTextCodec as CacheTextCodec, index_d_ChunkedCacheDependencies as ChunkedCacheDependencies, index_d_ChunkedCachePolicy as ChunkedCachePolicy, index_d_Clock as Clock, index_d_CoalescedDeferredMutation as CoalescedDeferredMutation, index_d_DeferredDeadLetter as DeferredDeadLetter, index_d_DeferredDeadLetterSink as DeferredDeadLetterSink, index_d_DeferredEnqueueResult as DeferredEnqueueResult, index_d_DeferredFlushResult as DeferredFlushResult, index_d_DeferredJournalDependencies as DeferredJournalDependencies, index_d_DeferredJournalOptions as DeferredJournalOptions, index_d_DeferredMutationBatchExecutor as DeferredMutationBatchExecutor, index_d_DeferredMutationInput as DeferredMutationInput, index_d_DeferredMutationKind as DeferredMutationKind, index_d_DeferredMutationOutcome as DeferredMutationOutcome, index_d_DeferredOutcomeStatus as DeferredOutcomeStatus, index_d_DeferredOverlayPublisher as DeferredOverlayPublisher, index_d_DeferredReceiptStatus as DeferredReceiptStatus, index_d_DependencyGeneration as DependencyGeneration, index_d_GQueryErrorCode as GQueryErrorCode, index_d_HashFunction as HashFunction, index_d_IdGenerator as IdGenerator, index_d_InstalledTrigger as InstalledTrigger, index_d_ManagedTriggerKind as ManagedTriggerKind, index_d_ManagedTriggerSpec as ManagedTriggerSpec, index_d_ManualEditHooks as ManualEditHooks, index_d_NormalizedChangeEvent as NormalizedChangeEvent, index_d_NormalizedEditEvent as NormalizedEditEvent, index_d_PendingDeferredMutation as PendingDeferredMutation, index_d_PendingMutationReceipt as PendingMutationReceipt, index_d_PropertyStore as PropertyStore, index_d_QueryCacheKeyInput as QueryCacheKeyInput, index_d_RandomSource as RandomSource, index_d_ReadThroughResult as ReadThroughResult, index_d_ReadThroughState as ReadThroughState, index_d_RegisteredSheetTable as RegisteredSheetTable, index_d_RetryAttemptContext as RetryAttemptContext, index_d_RetryControllerDependencies as RetryControllerDependencies, index_d_RetryExecution as RetryExecution, index_d_RetryExecutionOptions as RetryExecutionOptions, index_d_RetryOperation as RetryOperation, index_d_RetryOperationKind as RetryOperationKind, index_d_RetryPolicy as RetryPolicy, index_d_RetryStats as RetryStats, index_d_RetryTransportInvokerOptions as RetryTransportInvokerOptions, index_d_ScopedRetryTransportInvokerOptions as ScopedRetryTransportInvokerOptions, index_d_Sleeper as Sleeper, index_d_SyncLock as SyncLock, index_d_SystemEventResult as SystemEventResult, index_d_TriggerConfiguration as TriggerConfiguration, index_d_TriggerPlatform as TriggerPlatform, index_d_TriggerReconciliationResult as TriggerReconciliationResult };
}

export { AppsScriptManualEditHooks, AppsScriptSchemaMigrationAdapter, AppsScriptSheetsTransport, BLANK_CELL, BatchQuery, DeferredManager, GQueryCodecError, GQueryDatabase, GQueryDefinitionError, GQueryError, GQueryExecutor, GQueryRuntimeError, InMemorySheetsTransport, LEGACY_NO_MATCH, Query, SELECTION_INTERNAL, SchemaManager, Selection, SystemManager, TableHandle, assertSheetCellInput, assertSheetCellValue, atomicMutationToSheetsRequest, belongsTo, booleanColumn as boolean, booleanColumn, canonicalStringify$1 as canonicalStringify, cellRange, cloneProvenance, cloneQueryPlan, cloneRawMatrix, cloneSheetInputMatrix, columnIndexToLetter, columnLetterToIndex, combinePredicates, compactCellUpdates, compactRowDeletes, createExecutionStats, createGQuery, date, datetime, decimal, defineDatabase, emptyQueryPlan, encodeAtomicExtendedValue, encodeAtomicRows, encodeRawCell, encodeRawExtendedValue, encodeRawRows, enumeration, evaluatePredicate, formula, hasMany, hasOne, hashCanonical$1 as hashCanonical, identifier, index_d as infrastructure, integer, isColumnDefinition, isDatabaseDefinition, isFormulaCell, isTableDefinition, json, mergeExecutionStats, normalizeReturnedMatrix, normalizeWhere, nullable, number, optional, parseA1Range, quoteSheetName, selectionProvenance, sheetNameFromRange, sheetRange, source, structured, table, text, withBlankPolicy, withDefault };
export type { ActiveSpreadsheetSourceDefinition, AppsScriptSheetsTransportOptions, AtomicBatchUpdateOptions, AtomicBatchUpdateResult, AtomicCellUpdate, AtomicMutation, AtomicRowAppend, AtomicRowDelete, BaseColumnOptions, BlankCell, BlankPolicy, BlankPolicyOutput, BooleanColumnOptions, CacheMode, CacheScope, CellFormat, CellPatch, CodecContext, CodecDirection, ColumnCodec, ColumnDefinition, ColumnKey, ColumnMap, CreateGQueryOptions, DatabaseConfig, DatabaseDefinition, DateColumnOptions, DecimalColumnOptions, DeferredManagerAccess, DeferredManagerOptions, DeleteBehavior, DeleteOptions, EncodedCell, EnumCellValue, EnumerationColumnOptions, ExecutableQuery, ExecutionMode, ExecutionPlan, ExecutionPlanStep, ExecutionPlanStepKind, ExecutionPlanWarning, ExecutionStats, ExecutorOptions, FieldOperators, FormulaCell, FormulaColumnOptions, GQuery, GQueryErrorCode$1 as GQueryErrorCode, GQueryErrorOptions, Group, InMemorySheetSeed, InMemorySpreadsheetSeed, InMemoryTransportCall, IncludedRow, InferColumn, InferDatabaseRows, InferRow, InferTableRow, IntegerColumnOptions, JoinCardinality, JoinKind, JoinOptions, JoinPlan, JsonColumnOptions, JsonPrimitive, JsonValue, LegacyDecoder, LegacyNoMatch, MaterializedRow, MutationConflict, MutationOptions, MutationPatch, MutationResult, MutationStatus, NonEmptyKey, NumberColumnOptions, OrderClause, ParsedA1Range, PendingMutationReceipt$1 as PendingMutationReceipt, PredicateNode, PredicateOperator, QueryExecution, RawCellData, RawExtendedValue, RawValuesApi, RelationCardinality, RelationDefinition, RelationKey, RelationKind, RelationMap, RelationOptions, RowAt, RowPatch, RowProvenance, RuntimeCacheAdapter, RuntimeErrorCode, RuntimeErrorOptions, RuntimeGenerationAdapter, SchemaIssue, SchemaIssueCode, SchemaManagementAccess, SchemaMigrationAction, SchemaMigrationAdapter, SchemaMigrationOptions, SchemaMigrationResult, SchemaPlan, SelectionInternal, SelectionRuntime, SerializableQueryPlan, SheetBatchGetResult, SheetBatchUpdateOptions, SheetBatchUpdateResult, SheetCellInput, SheetCellValue, SheetDateTimeRenderOption, SheetMajorDimension, SheetMetadata, SheetReadOptions, SheetUpdateResult, SheetValueInputOption, SheetValueRange, SheetValueRenderOption, SheetValueUpdate, SheetsTransport, SortDirection, SourceDefinition, SourceMap, SpreadsheetIdSourceDefinition, SpreadsheetMetadata, StructuredColumnOptions, SyncOptions, SyncResult, SystemManagerAccess, SystemStatus, TableCacheDefinition, TableConfig, TableDefinition, TableHandles, TableMap, TextColumnOptions, TransportInvoker, TransportOperationContext, TransportOperationKind, TriggerSetup, UnitOfWorkCommitResult, UnitOfWorkIntent, UnitOfWorkOptions, UnitOfWorkResult, UpsertResult, Where, WorkbookCommitReceipt };
