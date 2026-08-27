import { BLANK_CELL, isFormulaCell, type EncodedCell } from "./codecs";
import {
  createExecutionStats,
  type ExecutionPlan,
  type ExecutionStats,
} from "./execution";
import {
  canonicalStringify,
  evaluatePredicate,
  hashCanonical,
  type PredicateNode,
  type SerializableQueryPlan,
} from "./query";
import { cloneProvenance, type MaterializedRow, type RowProvenance } from "./provenance";
import { GQueryRuntimeError } from "./runtime-errors";
import {
  SELECTION_INTERNAL,
  Selection,
  type DeleteOptions,
  type MutationConflict,
  type MutationOptions,
  type MutationPatch,
  type MutationResult,
  type SelectionRuntime,
} from "./selection";
import type {
  ColumnMap,
  DatabaseDefinition,
  DeleteBehavior,
  RelationDefinition,
  SourceDefinition,
  TableDefinition,
  TableMap,
} from "./schema";
import {
  cellRange,
  columnIndexToLetter,
  compactCellUpdates,
  compactRowDeletes,
  sheetRange,
  type AtomicMutation,
  type CellPatch,
  type RowPatch,
  type SheetCellInput,
  type SheetCellValue,
  type SheetMetadata,
  type SheetsTransport,
} from "./transport";
import type { DeferredJournal } from "./infrastructure/deferred";
import { validateJoinPlan } from "./join-validation";

export interface ExecutableQuery<T extends Record<string, unknown>> {
  readonly plan: SerializableQueryPlan;
  readonly localPredicates: readonly ((row: Readonly<T>) => boolean)[];
  readonly refresh: () => Selection<T>;
  readonly overlayRows?: (
    tableName: string,
    rows: readonly MaterializedRow<Record<string, unknown>>[],
  ) => readonly MaterializedRow<Record<string, unknown>>[];
}

export interface RuntimeCacheAdapter {
  read<T>(key: unknown): { readonly state: "hit" | "miss" | "corrupt"; readonly value?: T };
  put<T>(key: unknown, value: T, policy?: { ttlSeconds?: number; jitterSeconds?: number }): void;
}

export interface RuntimeGenerationAdapter {
  current(dependency:
    | { readonly kind: "table"; readonly sourceId: string; readonly table: string }
    | { readonly kind: "tag"; readonly tag: string }
  ): string;
  invalidateTable(sourceId: string, table: string): string;
  invalidateRow?(sourceId: string, table: string, key: unknown): string;
  invalidateTag?(tag: string): string;
}

export interface ExecutorOptions {
  readonly transport: SheetsTransport;
  readonly resolveActiveSpreadsheetId?: () => string;
  readonly now?: () => Date;
  readonly cache?: RuntimeCacheAdapter;
  readonly cacheForScope?: (scope: "script" | "document" | "user") => RuntimeCacheAdapter;
  readonly generations?: RuntimeGenerationAdapter;
  readonly scopeIdentity?: (scope: "script" | "document" | "user") => string | null;
  readonly deferredJournal?: DeferredJournal;
  readonly executionScope?: { run<T>(operation: () => T): T };
}

export interface QueryExecution<T extends Record<string, unknown>> {
  readonly selection: Selection<T>;
  readonly plan: ExecutionPlan;
}

export type UnitOfWorkIntent =
  | {
      readonly id: string;
      readonly kind: "update";
      readonly selection: Selection<Record<string, unknown>>;
      readonly patch: MutationPatch<Record<string, unknown>>;
    }
  | {
      readonly id: string;
      readonly kind: "delete";
      readonly selection: Selection<Record<string, unknown>>;
    }
  | {
      readonly id: string;
      readonly kind: "append";
      readonly tableName: string;
      readonly rows: readonly Record<string, unknown>[];
    };

export interface WorkbookCommitReceipt {
  readonly spreadsheetId: string;
  readonly status: "committed" | "failed";
  readonly requestCount: number;
  readonly error?: unknown;
}

export interface UnitOfWorkCommitResult {
  readonly status: "committed" | "conflicted" | "partial";
  readonly conflicts: readonly MutationConflict[];
  readonly workbooks: readonly WorkbookCommitReceipt[];
  readonly stats: ExecutionStats;
}

/** Internal complete-table snapshot hint used by sync/upsert validation. */
export interface WriteConstraintSnapshot {
  readonly tableName: string;
  readonly rows: readonly MaterializedRow<Record<string, unknown>>[];
}

interface ResolvedTable {
  readonly tableName: string;
  readonly definition: TableDefinition;
  readonly sourceName: string;
  readonly spreadsheetId: string;
  readonly sheet: SheetMetadata;
}

interface HeaderState {
  readonly headers: readonly string[];
  readonly logicalToPhysical: Readonly<Record<string, number>>;
  readonly fingerprint: string;
}

interface TableSnapshot {
  readonly resolved: ResolvedTable;
  readonly header: HeaderState;
  readonly rows: readonly MaterializedRow<Record<string, unknown>>[];
  readonly range: string;
  readonly cellsRead: number;
  readonly bytesRead: number;
}

interface CachedTableSnapshot {
  readonly version: 1;
  readonly range: string;
  readonly values: readonly (readonly SheetCellValue[])[];
}

interface PreparedUpdate {
  readonly before: MaterializedRow<Record<string, unknown>>;
  readonly after: MaterializedRow<Record<string, unknown>>;
  readonly patches: readonly CellPatch[];
}

interface PreparedAppend {
  readonly resolved: ResolvedTable;
  readonly rows: readonly Record<string, unknown>[];
  readonly values: readonly (readonly SheetCellInput[])[];
  readonly stats: ExecutionStats;
}

interface WriteConstraintCandidate {
  readonly tableName: string;
  readonly value: Record<string, unknown>;
  readonly identity?: string;
  readonly rowIndex?: number;
  readonly stagedIndex: number;
  readonly checkKeys: boolean;
  readonly checkForeignKeys: boolean;
}

interface TableMutationState {
  readonly tableName: string;
  readonly removals: Set<string>;
  readonly additions: WriteConstraintCandidate[];
}

interface ExistingConstraintRow {
  readonly identity: string;
  readonly rowIndex: number;
  readonly value: Readonly<Record<string, unknown>>;
}

interface ConstraintScanPlan {
  readonly resolved: ResolvedTable;
  readonly header: HeaderState;
  readonly requestedFields: readonly string[];
  readonly readColumns: readonly {
    readonly field?: string;
    readonly columnIndex: number;
    readonly range: string;
  }[];
}

interface PreflightEntry {
  readonly materialized: MaterializedRow<Record<string, unknown>>;
  readonly minColumn: number;
  readonly maxColumn: number;
  readonly range: string;
}

interface PreflightResult {
  readonly conflicts: readonly MutationConflict[];
  readonly stats: ExecutionStats;
}

interface BoundedReadResult {
  readonly snapshot: TableSnapshot;
  readonly stats: ExecutionStats;
}

interface DeleteRelationEdge {
  readonly id: string;
  readonly relationName: string;
  readonly principalTable: string;
  readonly dependentTable: string;
  readonly principalFields: readonly string[];
  readonly dependentFields: readonly string[];
  readonly onDelete: DeleteBehavior;
}

interface SetNullAction {
  readonly row: MaterializedRow<Record<string, unknown>>;
  readonly fields: ReadonlySet<string>;
}

interface ReferentialDeletePlan {
  readonly deletes: readonly MaterializedRow<Record<string, unknown>>[];
  readonly setNulls: readonly SetNullAction[];
  readonly stats: ExecutionStats;
}

function asArray(value: string | readonly string[]): readonly string[] {
  return typeof value === "string" ? [value] : value;
}

function toSheetInput(value: EncodedCell): SheetCellInput {
  return value === BLANK_CELL ? null : value;
}

/** Formula provenance/cache/journal values use the FORMULA-rendered string. */
function storedSheetValue(value: SheetCellInput): SheetCellValue {
  return isFormulaCell(value) ? value.expression : value;
}

function tableUsesFormula(definition: TableDefinition): boolean {
  return Object.values(definition.columns as ColumnMap).some(
    (column) => column.kind === "formula",
  );
}

function rawCell(value: SheetCellValue | undefined): SheetCellValue {
  return value === undefined ? null : value;
}

function decodeCell(value: SheetCellValue | undefined): unknown {
  return value === undefined || value === null ? BLANK_CELL : value;
}

function sameCell(left: SheetCellValue | undefined, right: SheetCellValue | undefined): boolean {
  return Object.is(rawCell(left), rawCell(right));
}

function sameLogical(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return canonicalStringify(left) === canonicalStringify(right);
  } catch {
    return false;
  }
}

function keyFingerprint(row: Record<string, unknown>, keys: readonly string[]): string {
  return canonicalStringify(keys.map((key) => row[key]));
}

function relationFingerprint(
  row: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  const values = keys.map((key) => row[key]);
  return values.some((value) => value === null || value === undefined)
    ? null
    : canonicalStringify(values);
}

function materializedIdentity(
  item: MaterializedRow<Record<string, unknown>>,
): string {
  return `${item.provenance.spreadsheetId}:${item.provenance.sheetId}:${item.provenance.rowIndex}`;
}

function baseMutationChanges(
  original: Record<string, unknown>,
  definition: TableDefinition,
  changes: Record<string, unknown>,
  fromCallback: boolean,
): Record<string, unknown> {
  const unknown = Object.keys(changes).filter((field) => {
    if (field in definition.columns) return false;
    return !(fromCallback && field in original &&
      sameLogical(original[field], changes[field]));
  });
  if (unknown.length > 0) {
    throw new GQueryRuntimeError(
      "MUTATION_INVALID",
      `Unknown mutation column${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }
  return Object.fromEntries(
    Object.entries(changes).filter(([field]) => field in definition.columns),
  );
}

function equalityFields(
  predicate: PredicateNode | undefined,
): ReadonlyMap<string, unknown> | null {
  if (predicate === undefined) return null;
  const result = new Map<string, unknown>();
  const visit = (node: PredicateNode): boolean => {
    if (node.kind === "constant") return node.value;
    if (node.kind === "and") return node.nodes.every(visit);
    if (node.kind !== "field") return false;
    if (node.operator !== "eq") return true;
    if (result.has(node.field) && !sameLogical(result.get(node.field), node.value)) return false;
    result.set(node.field, node.value);
    return true;
  };
  return visit(predicate) ? result : null;
}

function estimateBytes(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function mutableStats(stats: ExecutionStats): ExecutionStats {
  return {
    ...stats,
    rangesRead: [...stats.rangesRead],
    rangesWritten: [...stats.rangesWritten],
  };
}

function cloneStats(stats: ExecutionStats): ExecutionStats {
  return mutableStats(stats);
}

function addStats(target: ExecutionStats, source: ExecutionStats): void {
  target.apiCalls += source.apiCalls;
  target.cellsRead += source.cellsRead;
  target.cellsWritten += source.cellsWritten;
  target.bytesRead += source.bytesRead;
  target.bytesWritten += source.bytesWritten;
  target.cacheHits += source.cacheHits;
  target.cacheMisses += source.cacheMisses;
  target.staleCacheHits += source.staleCacheHits;
  target.retries += source.retries;
  target.elapsedMs += source.elapsedMs;
  target.lockWaitMs += source.lockWaitMs;
  target.fullScans += source.fullScans;
  target.rangesRead.push(...source.rangesRead);
  target.rangesWritten.push(...source.rangesWritten);
}

function projectRow(
  row: Record<string, unknown>,
  fields: readonly string[] | undefined,
): Record<string, unknown> {
  if (fields === undefined) return { ...row };
  const projected: Record<string, unknown> = {};
  for (const field of fields) projected[field] = row[field];
  return projected;
}

/** Purely synchronous schema/query executor over an injectable Sheets transport. */
export class GQueryExecutor implements SelectionRuntime {
  private readonly metadata = new Map<string, readonly SheetMetadata[]>();
  private readonly headers = new Map<string, HeaderState>();
  private readonly locators = new Map<string, readonly number[]>();
  private readonly now: () => Date;

  public constructor(
    private readonly schema: DatabaseDefinition,
    private readonly options: ExecutorOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public execute<T extends Record<string, unknown>>(
    query: ExecutableQuery<T>,
  ): QueryExecution<T> {
    const result = this.executeBatch({
      result: query as unknown as ExecutableQuery<Record<string, unknown>>,
    });
    return {
      selection: result.selections.result as Selection<T>,
      plan: result.plans.result,
    };
  }

  public executeBatch(
    queries: Readonly<Record<string, ExecutableQuery<Record<string, unknown>>>>,
  ): {
    readonly selections: Readonly<Record<string, Selection<Record<string, unknown>>>>;
    readonly plans: Readonly<Record<string, ExecutionPlan>>;
  } {
    return this.scoped(() => this.executeBatchUnscoped(queries));
  }

  private executeBatchUnscoped(
    queries: Readonly<Record<string, ExecutableQuery<Record<string, unknown>>>>,
  ): {
    readonly selections: Readonly<Record<string, Selection<Record<string, unknown>>>>;
    readonly plans: Readonly<Record<string, ExecutionPlan>>;
  } {
    const startedAt = Date.now();
    for (const query of Object.values(queries)) {
      validateJoinPlan(this.schema, query.plan);
    }
    const requestedTables = new Set<string>();
    for (const query of Object.values(queries)) {
      requestedTables.add(query.plan.table);
      for (const join of query.plan.joins) requestedTables.add(join.table);
    }

    const resolved = new Map<string, ResolvedTable>();
    for (const tableName of requestedTables) {
      resolved.set(tableName, this.resolveTable(tableName));
    }

    const snapshots = new Map<string, TableSnapshot>();
    const readStats = createExecutionStats();
    const boundedQueries = new Set<string>();
    const queryEntries = Object.entries(queries);
    if (queryEntries.length === 1) {
      const [queryName, query] = queryEntries[0];
      const base = resolved.get(query.plan.table);
      if (base !== undefined) {
        const bounded = this.tryBoundedRead(query, base);
        if (bounded !== null) {
          snapshots.set(base.tableName, bounded.snapshot);
          Object.assign(readStats, mutableStats(bounded.stats));
          boundedQueries.add(queryName);
        }
      }
    }

    const grouped = new Map<string, ResolvedTable[]>();
    for (const table of resolved.values()) {
      if (snapshots.has(table.tableName)) continue;
      const group = grouped.get(table.spreadsheetId) ?? [];
      if (!group.some((candidate) => candidate.tableName === table.tableName)) group.push(table);
      grouped.set(table.spreadsheetId, group);
    }

    for (const [spreadsheetId, tables] of grouped) {
      const misses: ResolvedTable[] = [];
      for (const table of tables) {
        const cache = this.cacheForTable(table);
        const cacheKey = cache === null ? null : this.tableCacheKey(table);
        const cached = cacheKey === null
          ? { state: "miss" as const }
          : cache?.read<CachedTableSnapshot>(cacheKey) ?? { state: "miss" as const };
        if (cached.state === "hit" && cached.value?.version === 1) {
          const snapshot = this.parseSnapshot(table, cached.value.values, cached.value.range);
          snapshots.set(table.tableName, snapshot);
          readStats.cacheHits += 1;
          continue;
        }
        if (cacheKey !== null) readStats.cacheMisses += 1;
        misses.push(table);
      }
      if (misses.length === 0) continue;

      const ranges = misses.map((table) => sheetRange(table.definition.sheet));
      const response = this.options.transport.batchGet(spreadsheetId, ranges, {
        valueRenderOption: misses.some((table) => tableUsesFormula(table.definition))
          ? "FORMULA"
          : "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      });
      readStats.apiCalls += 1;
      for (let index = 0; index < misses.length; index += 1) {
        const table = misses[index];
        const values = response.valueRanges[index]?.values ?? [];
        const snapshot = this.parseSnapshot(table, values, ranges[index]);
        snapshots.set(table.tableName, snapshot);
        readStats.cellsRead += snapshot.cellsRead;
        readStats.bytesRead += snapshot.bytesRead;
        readStats.rangesRead.push(snapshot.range);
        const cache = this.cacheForTable(table);
        const cacheKey = cache === null ? null : this.tableCacheKey(table);
        if (cacheKey !== null && cache !== null) {
          try {
            cache.put(cacheKey, {
              version: 1,
              range: ranges[index],
              values,
            } satisfies CachedTableSnapshot, {
              ttlSeconds: table.definition.cache?.ttlSeconds,
              jitterSeconds: table.definition.cache?.jitterSeconds,
            });
          } catch {
            // Cache publication is an optimization. Once the Sheets response has
            // been parsed successfully, quota/serialization failures must not
            // turn a valid read into a query failure.
          }
        }
      }
    }

    const selections: Record<string, Selection<Record<string, unknown>>> = {};
    const plans: Record<string, ExecutionPlan> = {};
    for (const [name, query] of Object.entries(queries)) {
      const queryStats = cloneStats(readStats);
      const baseRows = this.requireSnapshot(snapshots, query.plan.table).rows;
      let materialized = [...(query.overlayRows?.(query.plan.table, baseRows) ?? baseRows)];

      if (query.plan.predicate !== undefined) {
        materialized = materialized.filter((item) => evaluatePredicate(query.plan.predicate!, item.value));
      }
      for (const predicate of query.localPredicates) {
        materialized = materialized.filter((item) => predicate(item.value));
      }

      for (const join of query.plan.joins) {
        const target = this.requireSnapshot(snapshots, join.table);
        const targetRows = query.overlayRows?.(join.table, target.rows) ?? target.rows;
        const localFields = asArray(join.localField);
        const foreignFields = asArray(join.foreignField);
        if (localFields.length !== foreignFields.length) {
          throw new GQueryRuntimeError("INVALID_QUERY", `Join ${join.alias} key arity does not match.`);
        }
        const index = new Map<string, MaterializedRow<Record<string, unknown>>[]>();
        for (const candidate of targetRows) {
          const key = keyFingerprint(candidate.value, foreignFields);
          const matches = index.get(key) ?? [];
          matches.push(candidate);
          index.set(key, matches);
        }

        const joined: MaterializedRow<Record<string, unknown>>[] = [];
        for (const base of materialized) {
          const key = keyFingerprint(base.value, localFields);
          const matches = index.get(key) ?? [];
          if (join.relationName !== undefined) {
            const declared = this.table(query.plan.table).relations[join.relationName];
            if (declared?.required === true && matches.length === 0) {
              throw new GQueryRuntimeError(
                "RELATION_CARDINALITY",
                `Required relation ${join.relationName} has no ${join.table} row for key ${key}.`,
                { details: { relation: join.relationName, table: join.table, key } },
              );
            }
          }
          if (join.cardinality === "one" && matches.length > 1) {
            throw new GQueryRuntimeError(
              "RELATION_CARDINALITY",
              `Join ${join.alias} expected at most one ${join.table} row for key ${key}.`,
              { details: { alias: join.alias, table: join.table, key, matches: matches.length } },
            );
          }
          if (join.kind === "anti") {
            if (matches.length === 0) joined.push(base);
            continue;
          }
          if (join.kind === "semi") {
            if (matches.length > 0) joined.push(base);
            continue;
          }
          if (join.kind === "inner" && matches.length === 0) continue;

          const nested = join.cardinality === "many"
            ? matches.map((match) => projectRow(match.value, join.select))
            : matches.length === 0
              ? null
              : projectRow(matches[0].value, join.select);
          joined.push({
            value: { ...base.value, [join.alias]: nested },
            provenance: cloneProvenance(base.provenance, {
              relations: {
                ...base.provenance.relations,
                [join.alias]: matches.map((match) => match.provenance),
              },
              relationCardinalities: {
                ...base.provenance.relationCardinalities,
                [join.alias]: join.cardinality,
              },
            }),
          });
        }
        materialized = joined;
      }

      for (let index = query.plan.orderBy.length - 1; index >= 0; index -= 1) {
        const order = query.plan.orderBy[index];
        materialized.sort((left, right) => {
          const a = left.value[order.field] as never;
          const b = right.value[order.field] as never;
          if (Object.is(a, b)) return 0;
          const comparison = a === null || a === undefined ? -1 : b === null || b === undefined ? 1 : a < b ? -1 : 1;
          return order.direction === "asc" ? comparison : -comparison;
        });
      }
      if (query.plan.offset !== undefined) materialized = materialized.slice(query.plan.offset);
      if (query.plan.tail !== undefined) materialized = materialized.slice(-query.plan.tail);
      if (query.plan.limit !== undefined) materialized = materialized.slice(0, query.plan.limit);

      if (query.plan.projection !== undefined) {
        materialized = materialized.map((item) => ({
          value: projectRow(item.value, query.plan.projection),
          provenance: item.provenance,
        }));
      }
      queryStats.elapsedMs = Date.now() - startedAt;
      if (!boundedQueries.has(name)) queryStats.fullScans += 1;
      const headers = materialized.length > 0
        ? Object.keys(materialized[0].value)
        : [...(query.plan.projection ?? Object.keys(this.table(query.plan.table).columns))];
      selections[name] = new Selection(
        materialized,
        headers,
        queryStats,
        this,
        query.refresh,
      );
      plans[name] = this.explain(query, boundedQueries.has(name) ? "bounded" : undefined);
    }
    return { selections, plans };
  }

  public explain<T extends Record<string, unknown>>(
    query: ExecutableQuery<T>,
    executedMode?: "bounded" | "full-scan",
  ): ExecutionPlan {
    const tables = [query.plan.table, ...query.plan.joins.map((join) => join.table)];
    const sourceIds = new Set<string>();
    const steps: ExecutionPlan["steps"][number][] = [];
    for (const tableName of tables) {
      const definition = this.table(tableName);
      const sourceId = this.sourceIdentity(definition.source);
      sourceIds.add(sourceId);
      steps.push({
        kind: "range-read",
        source: sourceId,
        table: tableName,
        ranges: [sheetRange(definition.sheet)],
        columns: Object.keys(definition.columns),
        detail: "Unbounded table scan; execution batches this range with other tables in the workbook.",
      });
    }
    if (query.plan.predicate !== undefined || query.localPredicates.length > 0) {
      steps.push({
        kind: "local-filter",
        source: this.sourceIdentity(this.table(query.plan.table).source),
        table: query.plan.table,
        ranges: [],
        detail: query.localPredicates.length > 0 ? "Includes non-fingerprintable whereLocal callback." : "Typed predicate AST.",
      });
    }
    for (const join of query.plan.joins) {
      steps.push({
        kind: "join",
        source: this.sourceIdentity(this.table(join.table).source),
        table: join.table,
        ranges: [],
        detail: `${join.kind} ${join.cardinality} join as ${join.alias}`,
      });
    }
    const plannedBounded = executedMode === "bounded" || (executedMode === undefined && this.indexForQuery(query) !== null);
    const warnings: ExecutionPlan["warnings"][number][] = plannedBounded ? [] : [{
      code: "FULL_SCAN",
      table: query.plan.table,
      message: "This query currently requires an unbounded table scan.",
    }];
    if (query.localPredicates.length > 0) {
      warnings.push({
        code: "LOCAL_FILTER",
        table: query.plan.table,
        message: "whereLocal callbacks cannot be persistently fingerprinted or query-cached.",
      });
    }
    return {
      mode: plannedBounded ? "bounded" : "full-scan",
      sourceIds: [...sourceIds],
      tables,
      steps,
      warnings,
    };
  }

  public refresh<T extends Record<string, unknown>>(selection: Selection<T>): Selection<T> {
    const refresh = selection[SELECTION_INTERNAL].refresh;
    if (refresh !== null) return refresh();
    throw new GQueryRuntimeError(
      "UNSUPPORTED_OPERATION",
      "This derived selection has no standalone refresh query.",
    );
  }

  public update<T extends Record<string, unknown>>(
    selection: Selection<T>,
    patch: MutationPatch<T>,
    options: MutationOptions = {},
  ): MutationResult<T> {
    return this.scoped(() => this.updateUnscoped(selection, patch, options));
  }

  private updateUnscoped<T extends Record<string, unknown>>(
    selection: Selection<T>,
    patch: MutationPatch<T>,
    options: MutationOptions,
  ): MutationResult<T> {
    const materialized = selection[SELECTION_INTERNAL].materialized;
    if (materialized.length === 0) return this.emptyMutation(selection);
    if (options.delivery === "deferred") {
      return this.deferUpdate(selection, patch, options);
    }
    this.assertSingleMutationTable(materialized);
    const definition = this.table(materialized[0].provenance.tableName);
    if (definition.appendOnly) {
      throw new GQueryRuntimeError("MUTATION_INVALID", `Table ${materialized[0].provenance.tableName} is append-only.`);
    }

    const prepared: PreparedUpdate[] = [];
    for (const item of materialized) {
      const mutable = { ...item.value } as T;
      let changes: Partial<T>;
      if (typeof patch === "function") {
        const returned = patch(mutable);
        changes = returned === undefined ? mutable : returned;
      } else {
        changes = patch;
      }
      const changeRecord = baseMutationChanges(
        item.value,
        definition,
        changes as Record<string, unknown>,
        typeof patch === "function",
      );
      const changedKeys = Object.keys(changeRecord).filter((field) => !sameLogical(item.value[field], changeRecord[field]));
      const primaryChanges = changedKeys.filter((field) => definition.primaryKey.includes(field));
      if (primaryChanges.length > 0) {
        throw new GQueryRuntimeError("MUTATION_INVALID", `Primary key columns cannot be updated in place: ${primaryChanges.join(", ")}.`);
      }
      const cellPatches: CellPatch[] = [];
      const nextValue: Record<string, unknown> = { ...item.value };
      const nextEncoded = { ...item.provenance.originalEncoded };
      for (const field of changedKeys) {
        const column = definition.columns[field];
        const encoded = toSheetInput(column.encode(changeRecord[field], {
          table: item.provenance.tableName,
          column: field,
          header: column.header ?? field,
          rowNumber: item.provenance.rowIndex + 1,
        }) as EncodedCell);
        nextValue[field] = changeRecord[field];
        nextEncoded[field] = storedSheetValue(encoded);
        cellPatches.push({
          sheetId: item.provenance.sheetId,
          rowIndex: item.provenance.rowIndex,
          columnIndex: item.provenance.columnIndexes[field],
          value: encoded,
        });
      }
      let nextVersion = item.provenance.version;
      if (changedKeys.length > 0 && definition.versionColumn !== undefined) {
        const versionIndex = item.provenance.columnIndexes[definition.versionColumn];
        nextVersion = typeof item.provenance.version === "number" ? item.provenance.version + 1 : 1;
        cellPatches.push({
          sheetId: item.provenance.sheetId,
          rowIndex: item.provenance.rowIndex,
          columnIndex: versionIndex,
          value: nextVersion as number,
        });
      }
      prepared.push({
        before: item as MaterializedRow<Record<string, unknown>>,
        after: {
          value: nextValue,
          provenance: cloneProvenance(item.provenance, {
            version: nextVersion,
            originalEncoded: nextEncoded,
          }),
        },
        patches: cellPatches,
      });
    }

    const preflight = this.preflight(materialized as readonly MaterializedRow<Record<string, unknown>>[]);
    const constraints = this.validateWriteConstraints(prepared, [], []);
    const validationStats = mutableStats(preflight.stats);
    addStats(validationStats, constraints.stats);
    const conflicts = [...preflight.conflicts, ...constraints.conflicts];
    if (conflicts.length > 0) {
      return {
        status: "conflicted",
        matchedCount: materialized.length,
        changedCount: 0,
        changedCells: 0,
        conflicts,
        before: selection,
        stats: validationStats,
      };
    }

    const cellPatches = prepared.flatMap((item) => item.patches);
    const stats = validationStats;
    if (cellPatches.length > 0) {
      const bySpreadsheet = this.groupPatchesBySpreadsheet(prepared);
      for (const [spreadsheetId, patches] of bySpreadsheet) {
        const mutations = compactCellUpdates(patches);
        this.options.transport.atomicBatchUpdate(spreadsheetId, mutations);
        stats.apiCalls += 1;
        stats.cellsWritten += patches.length;
        stats.bytesWritten += estimateBytes(patches);
        stats.rangesWritten.push(...mutations.map((mutation) => cellRange(
          this.sheetName(spreadsheetId, mutation.sheetId),
          mutation.startRowIndex,
          mutation.startColumnIndex,
          mutation.values.length,
          mutation.values[0]?.length ?? 1,
        )));
      }
      this.invalidateMaterialized(materialized as readonly MaterializedRow<Record<string, unknown>>[]);
    }
    const afterMaterialized = prepared.map((item) => item.after as MaterializedRow<T>);
    const after = new Selection(afterMaterialized, selection.headers, stats, this, selection[SELECTION_INTERNAL].refresh);
    return {
      status: "committed",
      matchedCount: materialized.length,
      changedCount: prepared.filter((item) => item.patches.length > 0).length,
      changedCells: cellPatches.length,
      conflicts: [],
      before: options.includeBefore === false ? undefined : selection,
      after: options.includeAfter === false ? undefined : after,
      stats,
    };
  }

  public delete<T extends Record<string, unknown>>(
    selection: Selection<T>,
    options: DeleteOptions = {},
  ): MutationResult<T> {
    return this.scoped(() => this.deleteUnscoped(selection, options));
  }

  private deleteUnscoped<T extends Record<string, unknown>>(
    selection: Selection<T>,
    options: DeleteOptions,
  ): MutationResult<T> {
    const materialized = selection[SELECTION_INTERNAL].materialized;
    if (materialized.length === 0) return this.emptyMutation(selection);
    if (options.delivery === "deferred") {
      return this.deferDelete(selection, options);
    }
    this.assertSingleMutationTable(materialized);
    const relational = this.planReferentialDelete(
      materialized as readonly MaterializedRow<Record<string, unknown>>[],
    );
    const preparedSetNulls = relational.setNulls.map((action) => {
      const patch = Object.fromEntries([...action.fields].map((field) => [field, null]));
      return this.prepareUpdates([action.row], patch)[0];
    });
    const workbooks = new Set([
      ...relational.deletes.map((item) => item.provenance.spreadsheetId),
      ...preparedSetNulls.map((item) => item.before.provenance.spreadsheetId),
    ]);
    if (workbooks.size > 1) {
      throw new GQueryRuntimeError(
        "UNSUPPORTED_OPERATION",
        "An immediate relational delete cannot atomically mutate more than one spreadsheet. Use unitOfWork() to receive cross-workbook commit receipts.",
        { details: { spreadsheets: [...workbooks] } },
      );
    }
    const preflightRows = this.uniqueMaterialized([
      ...relational.deletes,
      ...preparedSetNulls.map((item) => item.before),
    ]);
    const preflight = this.preflight(preflightRows);
    if (preflight.conflicts.length > 0) {
      const stats = mutableStats(relational.stats);
      addStats(stats, preflight.stats);
      return {
        status: "conflicted",
        matchedCount: materialized.length,
        changedCount: 0,
        changedCells: 0,
        conflicts: preflight.conflicts,
        before: selection,
        stats,
      };
    }
    const rows: RowPatch[] = relational.deletes.map((item) => ({
      sheetId: item.provenance.sheetId,
      rowIndex: item.provenance.rowIndex,
    }));
    const deletes = compactRowDeletes(rows);
    const cellPatches = preparedSetNulls.flatMap((item) => item.patches);
    const updates = compactCellUpdates(cellPatches);
    const mutations: AtomicMutation[] = [...updates, ...deletes];
    const spreadsheetId = [...workbooks][0] ?? materialized[0].provenance.spreadsheetId;
    if (mutations.length > 0) this.options.transport.atomicBatchUpdate(spreadsheetId, mutations);
    const stats = mutableStats(relational.stats);
    addStats(stats, preflight.stats);
    if (mutations.length > 0) stats.apiCalls += 1;
    stats.cellsWritten += cellPatches.length;
    stats.bytesWritten += estimateBytes(mutations);
    stats.rangesWritten.push(...updates.map((mutation) => cellRange(
      this.sheetName(spreadsheetId, mutation.sheetId),
      mutation.startRowIndex,
      mutation.startColumnIndex,
      mutation.values.length,
      mutation.values[0]?.length ?? 1,
    )));
    stats.rangesWritten.push(...deletes.map((item) => `${this.sheetName(spreadsheetId, item.sheetId)} rows ${item.startRowIndex + 1}:${item.endRowIndex}`));
    for (const item of relational.deletes) {
      this.clearTableLocators(item.provenance.spreadsheetId, item.provenance.tableName);
    }
    this.invalidateMaterialized(preflightRows);
    return {
      status: "committed",
      matchedCount: materialized.length,
      changedCount: relational.deletes.length + preparedSetNulls.filter((item) => item.patches.length > 0).length,
      changedCells: cellPatches.length,
      conflicts: [],
      before: options.includeBefore === false ? undefined : selection,
      stats,
    };
  }

  public append(
    tableName: string,
    rows: readonly Record<string, unknown>[],
  ): MutationResult<Record<string, unknown>> {
    return this.scoped(() => this.appendUnscoped(tableName, rows));
  }

  private appendUnscoped(
    tableName: string,
    rows: readonly Record<string, unknown>[],
  ): MutationResult<Record<string, unknown>> {
    if (rows.length === 0) {
      return {
        status: "committed",
        matchedCount: 0,
        changedCount: 0,
        changedCells: 0,
        conflicts: [],
        stats: createExecutionStats(),
      };
    }
    const prepared = this.prepareAppend(tableName, rows);
    const constraints = this.validateWriteConstraints([], [prepared], []);
    const stats = mutableStats(prepared.stats);
    addStats(stats, constraints.stats);
    if (constraints.conflicts.length > 0) {
      return {
        status: "conflicted",
        matchedCount: rows.length,
        changedCount: 0,
        changedCells: 0,
        conflicts: constraints.conflicts,
        stats,
      };
    }
    this.options.transport.atomicBatchUpdate(prepared.resolved.spreadsheetId, [{
      kind: "appendRows",
      sheetId: prepared.resolved.sheet.sheetId,
      values: prepared.values,
    }]);
    this.clearTableLocators(prepared.resolved.spreadsheetId, tableName);
    this.invalidateTable(prepared.resolved.spreadsheetId, tableName);
    const changedCells = prepared.values.reduce((sum, row) => sum + row.length, 0);
    return {
      status: "committed",
      matchedCount: rows.length,
      changedCount: rows.length,
      changedCells,
      conflicts: [],
      stats: createExecutionStats({ ...stats, apiCalls: stats.apiCalls + 1, cellsWritten: changedCells }),
    };
  }

  /** Compile staged operations and commit each workbook in one atomic batch. */
  public commitUnitOfWork(intents: readonly UnitOfWorkIntent[]): UnitOfWorkCommitResult {
    return this.commitUnitOfWorkWithSnapshots(intents);
  }

  public commitUnitOfWorkWithSnapshots(
    intents: readonly UnitOfWorkIntent[],
    constraintSnapshots: readonly WriteConstraintSnapshot[] = [],
  ): UnitOfWorkCommitResult {
    return this.scoped(() => this.commitUnitOfWorkUnscoped(intents, constraintSnapshots));
  }

  private commitUnitOfWorkUnscoped(
    intents: readonly UnitOfWorkIntent[],
    constraintSnapshots: readonly WriteConstraintSnapshot[],
  ): UnitOfWorkCommitResult {
    const selections = intents
      .filter((intent): intent is Extract<UnitOfWorkIntent, { kind: "update" | "delete" }> => intent.kind !== "append")
      .flatMap((intent) => intent.selection[SELECTION_INTERNAL].materialized) as readonly MaterializedRow<Record<string, unknown>>[];
    const identities = new Set<string>();
    for (const item of selections) {
      const identity = `${item.provenance.spreadsheetId}:${item.provenance.sheetId}:${item.provenance.rowIndex}`;
      if (identities.has(identity)) {
        throw new GQueryRuntimeError(
          "MUTATION_INVALID",
          "A unit of work cannot stage more than one mutation for the same physical row.",
          { details: { identity } },
        );
      }
      identities.add(identity);
    }

    const explicitPreparedUpdates: PreparedUpdate[] = [];
    const explicitDeletes: MaterializedRow<Record<string, unknown>>[] = [];
    const valueOverrides = new Map<string, Record<string, unknown>>();
    for (const intent of intents) {
      if (intent.kind === "update") {
        const materialized = intent.selection[SELECTION_INTERNAL]
          .materialized as readonly MaterializedRow<Record<string, unknown>>[];
        const prepared = this.prepareUpdates(materialized, intent.patch);
        explicitPreparedUpdates.push(...prepared);
        for (const item of prepared) {
          valueOverrides.set(materializedIdentity(item.before), item.after.value);
        }
      } else if (intent.kind === "delete") {
        explicitDeletes.push(
          ...(intent.selection[SELECTION_INTERNAL]
            .materialized as readonly MaterializedRow<Record<string, unknown>>[]),
        );
      }
    }

    const relational = this.planReferentialDelete(explicitDeletes, valueOverrides);
    const deletedIdentities = new Set(
      relational.deletes.map((item) => materializedIdentity(item)),
    );
    const setNullByIdentity = new Map(
      relational.setNulls.map((action) => [materializedIdentity(action.row), action]),
    );
    const explicitByIdentity = new Map(
      explicitPreparedUpdates.map((item) => [materializedIdentity(item.before), item]),
    );
    const preparedUpdates: PreparedUpdate[] = [];
    for (const prepared of explicitPreparedUpdates) {
      const identity = materializedIdentity(prepared.before);
      if (deletedIdentities.has(identity)) continue;
      const setNull = setNullByIdentity.get(identity);
      if (setNull === undefined) {
        preparedUpdates.push(prepared);
        continue;
      }
      const finalValue = { ...prepared.after.value };
      for (const field of setNull.fields) finalValue[field] = null;
      preparedUpdates.push(this.prepareUpdates([prepared.before], finalValue)[0]);
    }
    for (const action of relational.setNulls) {
      const identity = materializedIdentity(action.row);
      if (deletedIdentities.has(identity) || explicitByIdentity.has(identity)) continue;
      const patch = Object.fromEntries([...action.fields].map((field) => [field, null]));
      preparedUpdates.push(this.prepareUpdates([action.row], patch)[0]);
    }

    const preparedAppends = intents
      .filter((intent): intent is Extract<UnitOfWorkIntent, { kind: "append" }> =>
        intent.kind === "append"
      )
      .map((intent) => ({ intent, prepared: this.prepareAppend(intent.tableName, intent.rows) }));

    const preflightRows = this.uniqueMaterialized([
      ...relational.deletes,
      ...preparedUpdates.map((item) => item.before),
    ]);
    const preflight = preflightRows.length === 0
      ? { conflicts: [] as readonly MutationConflict[], stats: createExecutionStats() }
      : this.preflight(preflightRows);
    const constraints = this.validateWriteConstraints(
      preparedUpdates,
      preparedAppends.map(({ prepared }) => prepared),
      relational.deletes,
      constraintSnapshots,
    );
    const conflicts = [...preflight.conflicts, ...constraints.conflicts];
    if (conflicts.length > 0) {
      const stats = mutableStats(relational.stats);
      addStats(stats, preflight.stats);
      addStats(stats, constraints.stats);
      for (const { prepared } of preparedAppends) addStats(stats, prepared.stats);
      return { status: "conflicted", conflicts, workbooks: [], stats };
    }

    const byWorkbook = new Map<string, AtomicMutation[]>();
    const touched = new Map<string, Set<string>>();
    const stats = mutableStats(relational.stats);
    addStats(stats, preflight.stats);
    addStats(stats, constraints.stats);
    for (const [spreadsheetId, patches] of this.groupPatchesBySpreadsheet(preparedUpdates)) {
      const mutations = byWorkbook.get(spreadsheetId) ?? [];
      mutations.push(...compactCellUpdates(patches));
      byWorkbook.set(spreadsheetId, mutations);
      stats.cellsWritten += patches.length;
      stats.bytesWritten += estimateBytes(patches);
    }
    this.recordTouched(touched, preparedUpdates.map((item) => item.before));

    const deleteRowsBySpreadsheet = new Map<string, RowPatch[]>();
    // Across workbooks, commit cascaded/dependent rows before principals when
    // possible. Same-workbook requests remain one atomic batch regardless.
    for (const item of [...relational.deletes].reverse()) {
      const rows = deleteRowsBySpreadsheet.get(item.provenance.spreadsheetId) ?? [];
      rows.push({ sheetId: item.provenance.sheetId, rowIndex: item.provenance.rowIndex });
      deleteRowsBySpreadsheet.set(item.provenance.spreadsheetId, rows);
    }
    for (const [spreadsheetId, rows] of deleteRowsBySpreadsheet) {
      const mutations = byWorkbook.get(spreadsheetId) ?? [];
      mutations.push(...compactRowDeletes(rows));
      byWorkbook.set(spreadsheetId, mutations);
    }
    this.recordTouched(touched, relational.deletes);

    for (const { intent, prepared } of preparedAppends) {
      const mutations = byWorkbook.get(prepared.resolved.spreadsheetId) ?? [];
      mutations.push({
        kind: "appendRows",
        sheetId: prepared.resolved.sheet.sheetId,
        values: prepared.values,
      });
      byWorkbook.set(prepared.resolved.spreadsheetId, mutations);
      stats.apiCalls += prepared.stats.apiCalls;
      stats.cellsRead += prepared.stats.cellsRead;
      stats.rangesRead.push(...prepared.stats.rangesRead);
      stats.cellsWritten += prepared.values.reduce((sum, row) => sum + row.length, 0);
      const names = touched.get(prepared.resolved.spreadsheetId) ?? new Set<string>();
      names.add(intent.tableName);
      touched.set(prepared.resolved.spreadsheetId, names);
    }

    const receipts: WorkbookCommitReceipt[] = [];
    let failed = false;
    for (const [spreadsheetId, mutations] of byWorkbook) {
      if (failed) {
        receipts.push({ spreadsheetId, status: "failed", requestCount: mutations.length, error: "Skipped after prior workbook failure." });
        continue;
      }
      try {
        this.options.transport.atomicBatchUpdate(spreadsheetId, mutations);
        stats.apiCalls += 1;
        receipts.push({ spreadsheetId, status: "committed", requestCount: mutations.length });
        for (const tableName of touched.get(spreadsheetId) ?? []) {
          this.clearTableLocators(spreadsheetId, tableName);
          this.invalidateTable(spreadsheetId, tableName);
        }
      } catch (error) {
        failed = true;
        receipts.push({ spreadsheetId, status: "failed", requestCount: mutations.length, error });
      }
    }
    const committed = receipts.filter((receipt) => receipt.status === "committed").length;
    return {
      status: failed && committed > 0 ? "partial" : failed ? "partial" : "committed",
      conflicts: [],
      workbooks: receipts,
      stats,
    };
  }

  public invalidateTable(spreadsheetId: string, tableName: string): void {
    this.options.generations?.invalidateTable(spreadsheetId, tableName);
  }

  public invalidateStructure(spreadsheetId: string): void {
    this.metadata.delete(spreadsheetId);
    for (const key of [...this.headers.keys()]) {
      if (key.startsWith(`${spreadsheetId}:`)) this.headers.delete(key);
    }
    for (const key of [...this.locators.keys()]) {
      if (key.startsWith(`${spreadsheetId}:`)) this.locators.delete(key);
    }
  }

  private emptyMutation<T extends Record<string, unknown>>(selection: Selection<T>): MutationResult<T> {
    return {
      status: "committed",
      matchedCount: 0,
      changedCount: 0,
      changedCells: 0,
      conflicts: [],
      before: selection,
      after: selection,
      stats: createExecutionStats(),
    };
  }

  private scoped<T>(operation: () => T): T {
    return this.options.executionScope?.run(operation) ?? operation();
  }

  private deferUpdate<T extends Record<string, unknown>>(
    selection: Selection<T>,
    patch: MutationPatch<T>,
    options: MutationOptions,
  ): MutationResult<T> {
    const journal = this.options.deferredJournal;
    if (journal === undefined) {
      throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "Deferred delivery is not configured for this GQuery instance.");
    }
    if (typeof patch === "function") {
      throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred updates require a serializable object patch, not a callback.");
    }
    if (!options.idempotencyKey) {
      throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred updates require idempotencyKey.");
    }
    const materialized = selection[SELECTION_INTERNAL].materialized;
    if (materialized.length !== 1) {
      throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred updates must target exactly one key-addressed row.");
    }
    const item = materialized[0];
    const definition = this.table(item.provenance.tableName);
    if (definition.primaryKey.length === 0) {
      throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred updates require a declared primary key.");
    }
    const encoded: Record<string, SheetCellValue> = {};
    const logical: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) {
      const column = definition.columns[field];
      if (column === undefined) throw new GQueryRuntimeError("MUTATION_INVALID", `Unknown mutation column ${field}.`);
      if (definition.primaryKey.includes(field)) throw new GQueryRuntimeError("MUTATION_INVALID", `Deferred updates cannot change primary key column ${field}.`);
      encoded[field] = storedSheetValue(toSheetInput(column.encode(value, {
        table: item.provenance.tableName,
        column: field,
        header: column.header ?? field,
        rowNumber: item.provenance.rowIndex + 1,
      }) as EncodedCell));
      logical[field] = value;
    }
    const expectedVersion = item.provenance.version;
    if (expectedVersion !== undefined && expectedVersion !== null && typeof expectedVersion !== "string" && typeof expectedVersion !== "number") {
      throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred row versions must be strings, numbers, null, or blank.");
    }
    const enqueued = journal.enqueue({
      sourceId: item.provenance.spreadsheetId,
      table: item.provenance.tableName,
      kind: "patch",
      key: item.provenance.encodedPrimaryKey,
      values: encoded,
      expectedVersion: expectedVersion === undefined ? null : expectedVersion,
      actor: options.actor,
      idempotencyKey: options.idempotencyKey,
    });
    const afterMaterialized = materialized.map((current) => ({
      value: { ...current.value, ...logical },
      provenance: current.provenance,
    }));
    const after = new Selection(afterMaterialized, selection.headers, createExecutionStats(), this, selection[SELECTION_INTERNAL].refresh);
    return {
      status: enqueued.receipt.status === "committed" ? "committed" : enqueued.receipt.status === "conflicted" ? "conflicted" : "queued",
      matchedCount: 1,
      changedCount: Object.keys(encoded).length === 0 ? 0 : 1,
      changedCells: 0,
      conflicts: [],
      before: selection,
      after,
      stats: createExecutionStats(),
      receipt: {
        id: enqueued.receipt.mutationId,
        idempotencyKey: enqueued.receipt.idempotencyKey,
        queuedAt: new Date(enqueued.receipt.createdAtMs).toISOString(),
        operation: "update",
        table: item.provenance.tableName,
        keys: [item.provenance.primaryKey],
      },
    };
  }

  private deferDelete<T extends Record<string, unknown>>(
    selection: Selection<T>,
    options: DeleteOptions,
  ): MutationResult<T> {
    const journal = this.options.deferredJournal;
    if (journal === undefined) throw new GQueryRuntimeError("UNSUPPORTED_OPERATION", "Deferred delivery is not configured for this GQuery instance.");
    if (!options.idempotencyKey) throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred deletes require idempotencyKey.");
    const materialized = selection[SELECTION_INTERNAL].materialized;
    if (materialized.length !== 1) throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred deletes must target exactly one key-addressed row.");
    const item = materialized[0];
    const definition = this.table(item.provenance.tableName);
    if (definition.primaryKey.length === 0) throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred deletes require a declared primary key.");
    const expectedVersion = item.provenance.version;
    if (expectedVersion !== undefined && expectedVersion !== null && typeof expectedVersion !== "string" && typeof expectedVersion !== "number") {
      throw new GQueryRuntimeError("MUTATION_INVALID", "Deferred row versions must be strings, numbers, null, or blank.");
    }
    const enqueued = journal.enqueue({
      sourceId: item.provenance.spreadsheetId,
      table: item.provenance.tableName,
      kind: "delete",
      key: item.provenance.encodedPrimaryKey,
      expectedVersion: expectedVersion === undefined ? null : expectedVersion,
      actor: options.actor,
      idempotencyKey: options.idempotencyKey,
    });
    return {
      status: enqueued.receipt.status === "committed" ? "committed" : enqueued.receipt.status === "conflicted" ? "conflicted" : "queued",
      matchedCount: 1,
      changedCount: 1,
      changedCells: 0,
      conflicts: [],
      before: selection,
      stats: createExecutionStats(),
      receipt: {
        id: enqueued.receipt.mutationId,
        idempotencyKey: enqueued.receipt.idempotencyKey,
        queuedAt: new Date(enqueued.receipt.createdAtMs).toISOString(),
        operation: "delete",
        table: item.provenance.tableName,
        keys: [item.provenance.primaryKey],
      },
    };
  }

  private prepareUpdates(
    materialized: readonly MaterializedRow<Record<string, unknown>>[],
    patch: MutationPatch<Record<string, unknown>>,
  ): PreparedUpdate[] {
    if (materialized.length === 0) return [];
    this.assertSingleMutationTable(materialized);
    const definition = this.table(materialized[0].provenance.tableName);
    if (definition.appendOnly) {
      throw new GQueryRuntimeError("MUTATION_INVALID", `Table ${materialized[0].provenance.tableName} is append-only.`);
    }
    const prepared: PreparedUpdate[] = [];
    for (const item of materialized) {
      const mutable = { ...item.value };
      const returned = typeof patch === "function" ? patch(mutable) : patch;
      const changes = baseMutationChanges(
        item.value,
        definition,
        (typeof patch === "function" && returned === undefined ? mutable : returned) as Record<string, unknown>,
        typeof patch === "function",
      );
      const changedKeys = Object.keys(changes).filter((field) => !sameLogical(item.value[field], changes[field]));
      const primaryChanges = changedKeys.filter((field) => definition.primaryKey.includes(field));
      if (primaryChanges.length > 0) throw new GQueryRuntimeError("MUTATION_INVALID", `Primary key columns cannot be updated in place: ${primaryChanges.join(", ")}.`);
      const patches: CellPatch[] = [];
      const nextValue = { ...item.value };
      const nextEncoded = { ...item.provenance.originalEncoded };
      for (const field of changedKeys) {
        const column = definition.columns[field];
        const encoded = toSheetInput(column.encode(changes[field], {
          table: item.provenance.tableName,
          column: field,
          header: column.header ?? field,
          rowNumber: item.provenance.rowIndex + 1,
        }) as EncodedCell);
        nextValue[field] = changes[field];
        nextEncoded[field] = storedSheetValue(encoded);
        patches.push({
          sheetId: item.provenance.sheetId,
          rowIndex: item.provenance.rowIndex,
          columnIndex: item.provenance.columnIndexes[field],
          value: encoded,
        });
      }
      let version = item.provenance.version;
      if (patches.length > 0 && definition.versionColumn !== undefined) {
        version = typeof version === "number" ? version + 1 : 1;
        patches.push({
          sheetId: item.provenance.sheetId,
          rowIndex: item.provenance.rowIndex,
          columnIndex: item.provenance.columnIndexes[definition.versionColumn],
          value: version as number,
        });
      }
      prepared.push({
        before: item,
        after: {
          value: nextValue,
          provenance: cloneProvenance(item.provenance, { version, originalEncoded: nextEncoded }),
        },
        patches,
      });
    }
    return prepared;
  }

  private deleteRelationEdges(): readonly DeleteRelationEdge[] {
    const edges: DeleteRelationEdge[] = [];
    for (const [declaringTable, definition] of Object.entries(
      this.schema.tables as TableMap,
    )) {
      for (const [relationName, rawRelation] of Object.entries(
        definition.relations,
      )) {
        const relation = rawRelation as RelationDefinition;
        if (relation.kind === "belongs-to") {
          edges.push({
            id: `${declaringTable}.${relationName}`,
            relationName,
            principalTable: relation.target,
            dependentTable: declaringTable,
            principalFields: asArray(relation.foreign),
            dependentFields: asArray(relation.local),
            onDelete: relation.onDelete,
          });
        } else {
          edges.push({
            id: `${declaringTable}.${relationName}`,
            relationName,
            principalTable: declaringTable,
            dependentTable: relation.target,
            principalFields: asArray(relation.local),
            dependentFields: asArray(relation.foreign),
            onDelete: relation.onDelete,
          });
        }
      }
    }
    return edges;
  }

  private reachableDeleteEdges(
    rootTables: ReadonlySet<string>,
  ): readonly DeleteRelationEdge[] {
    const byPrincipal = new Map<string, DeleteRelationEdge[]>();
    for (const edge of this.deleteRelationEdges()) {
      if (edge.onDelete === "no-action") continue;
      const current = byPrincipal.get(edge.principalTable) ?? [];
      current.push(edge);
      byPrincipal.set(edge.principalTable, current);
    }
    const pending = [...rootTables];
    const visited = new Set<string>();
    const result: DeleteRelationEdge[] = [];
    while (pending.length > 0) {
      const tableName = pending.shift()!;
      if (visited.has(tableName)) continue;
      visited.add(tableName);
      for (const edge of byPrincipal.get(tableName) ?? []) {
        result.push(edge);
        if (edge.onDelete === "cascade") pending.push(edge.dependentTable);
      }
    }
    return result;
  }

  private loadDeleteRelationRows(
    edges: readonly DeleteRelationEdge[],
    stats: ExecutionStats,
  ): ReadonlyMap<string, readonly MaterializedRow<Record<string, unknown>>[]> {
    const resolved = new Map<string, ResolvedTable>();
    for (const edge of edges) {
      if (!resolved.has(edge.dependentTable)) {
        resolved.set(edge.dependentTable, this.resolveTable(edge.dependentTable));
      }
    }
    const grouped = new Map<string, ResolvedTable[]>();
    for (const table of resolved.values()) {
      const tables = grouped.get(table.spreadsheetId) ?? [];
      tables.push(table);
      grouped.set(table.spreadsheetId, tables);
    }
    const rows = new Map<string, readonly MaterializedRow<Record<string, unknown>>[]>();
    for (const [spreadsheetId, tables] of grouped) {
      const ranges = tables.map((table) => sheetRange(table.definition.sheet));
      const response = this.options.transport.batchGet(spreadsheetId, ranges, {
        valueRenderOption: tables.some((table) =>
          tableUsesFormula(table.definition)
        ) ? "FORMULA" : "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      });
      stats.apiCalls += 1;
      stats.rangesRead.push(...ranges);
      stats.fullScans += ranges.length;
      stats.cellsRead += response.valueRanges.reduce(
        (sum, valueRange) =>
          sum + valueRange.values.reduce((inner, row) => inner + row.length, 0),
        0,
      );
      stats.bytesRead += estimateBytes(response.valueRanges);
      tables.forEach((table, index) => {
        const snapshot = this.parseSnapshot(
          table,
          response.valueRanges[index]?.values ?? [],
          ranges[index],
        );
        rows.set(table.tableName, snapshot.rows);
      });
    }
    return rows;
  }

  private planReferentialDelete(
    explicitDeletes: readonly MaterializedRow<Record<string, unknown>>[],
    valueOverrides: ReadonlyMap<string, Record<string, unknown>> = new Map(),
  ): ReferentialDeletePlan {
    for (const item of explicitDeletes) {
      const definition = this.table(item.provenance.tableName);
      if (definition.appendOnly) {
        throw new GQueryRuntimeError(
          "MUTATION_INVALID",
          `Table ${item.provenance.tableName} is append-only.`,
        );
      }
    }
    const stats = createExecutionStats();
    if (explicitDeletes.length === 0) return { deletes: [], setNulls: [], stats };
    const rootTables = new Set(explicitDeletes.map((item) => item.provenance.tableName));
    const edges = this.reachableDeleteEdges(rootTables);
    if (edges.length === 0) {
      return { deletes: this.uniqueMaterialized(explicitDeletes), setNulls: [], stats };
    }
    const relationRows = this.loadDeleteRelationRows(edges, stats);
    const byPrincipal = new Map<string, DeleteRelationEdge[]>();
    for (const edge of edges) {
      const current = byPrincipal.get(edge.principalTable) ?? [];
      current.push(edge);
      byPrincipal.set(edge.principalTable, current);
    }
    const effectiveValue = (item: MaterializedRow<Record<string, unknown>>) =>
      valueOverrides.get(materializedIdentity(item)) ?? item.value;
    const matches = (
      principal: MaterializedRow<Record<string, unknown>>,
      edge: DeleteRelationEdge,
    ): readonly MaterializedRow<Record<string, unknown>>[] => {
      const principalKey = relationFingerprint(effectiveValue(principal), edge.principalFields);
      if (principalKey === null) return [];
      return (relationRows.get(edge.dependentTable) ?? []).filter((dependent) =>
        relationFingerprint(effectiveValue(dependent), edge.dependentFields) === principalKey,
      );
    };

    const scheduled = new Map<string, MaterializedRow<Record<string, unknown>>>();
    const pending: MaterializedRow<Record<string, unknown>>[] = [];
    for (const item of explicitDeletes) {
      const identity = materializedIdentity(item);
      if (!scheduled.has(identity)) {
        scheduled.set(identity, item);
        pending.push(item);
      }
    }
    while (pending.length > 0) {
      const principal = pending.shift()!;
      for (const edge of byPrincipal.get(principal.provenance.tableName) ?? []) {
        if (edge.onDelete !== "cascade") continue;
        for (const dependent of matches(principal, edge)) {
          const identity = materializedIdentity(dependent);
          if (scheduled.has(identity)) continue;
          if (this.table(dependent.provenance.tableName).appendOnly) {
            throw new GQueryRuntimeError(
              "MUTATION_INVALID",
              `Cascade ${edge.id} cannot delete from append-only table ${dependent.provenance.tableName}.`,
              { details: { relation: edge.id, table: dependent.provenance.tableName } },
            );
          }
          scheduled.set(identity, dependent);
          pending.push(dependent);
        }
      }
    }

    for (const principal of scheduled.values()) {
      for (const edge of byPrincipal.get(principal.provenance.tableName) ?? []) {
        if (edge.onDelete !== "restrict") continue;
        const blocked = matches(principal, edge).filter(
          (dependent) => !scheduled.has(materializedIdentity(dependent)),
        );
        if (blocked.length > 0) {
          throw new GQueryRuntimeError(
            "RELATION_RESTRICT",
            `Cannot delete ${edge.principalTable} because relation ${edge.id} has ${blocked.length} dependent row${blocked.length === 1 ? "" : "s"}.`,
            {
              details: {
                relation: edge.id,
                relationName: edge.relationName,
                principalTable: edge.principalTable,
                dependentTable: edge.dependentTable,
                principalKey: Object.fromEntries(
                  edge.principalFields.map((field) => [field, effectiveValue(principal)[field]]),
                ),
                dependentKeys: blocked.map((item) => item.provenance.primaryKey),
              },
            },
          );
        }
      }
    }

    const setNulls = new Map<string, { row: MaterializedRow<Record<string, unknown>>; fields: Set<string> }>();
    for (const principal of scheduled.values()) {
      for (const edge of byPrincipal.get(principal.provenance.tableName) ?? []) {
        if (edge.onDelete !== "set-null") continue;
        for (const dependent of matches(principal, edge)) {
          const identity = materializedIdentity(dependent);
          if (scheduled.has(identity)) continue;
          const action = setNulls.get(identity) ?? { row: dependent, fields: new Set<string>() };
          for (const field of edge.dependentFields) {
            if (this.table(edge.dependentTable).columns[field]?.acceptsNull !== true) {
              throw new GQueryRuntimeError(
                "MUTATION_INVALID",
                `Relation ${edge.id} cannot set non-nullable column ${edge.dependentTable}.${field} to null.`,
                { details: { relation: edge.id, table: edge.dependentTable, field } },
              );
            }
            action.fields.add(field);
          }
          setNulls.set(identity, action);
        }
      }
    }
    return {
      deletes: [...scheduled.values()],
      setNulls: [...setNulls.values()],
      stats,
    };
  }

  private uniqueMaterialized(
    items: readonly MaterializedRow<Record<string, unknown>>[],
  ): MaterializedRow<Record<string, unknown>>[] {
    const unique = new Map<string, MaterializedRow<Record<string, unknown>>>();
    for (const item of items) unique.set(materializedIdentity(item), item);
    return [...unique.values()];
  }

  private prepareAppend(
    tableName: string,
    rows: readonly Record<string, unknown>[],
  ): PreparedAppend {
    const resolved = this.resolveTable(tableName);
    const cacheKey = `${resolved.spreadsheetId}:${resolved.definition.sheet}`;
    let header = this.headers.get(cacheKey);
    const stats = createExecutionStats();
    if (header === undefined) {
      const headerRange = sheetRange(resolved.definition.sheet, "1:1");
      const response = this.options.transport.get(resolved.spreadsheetId, headerRange, {
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      stats.apiCalls += 1;
      stats.cellsRead += response.values[0]?.length ?? 0;
      stats.rangesRead.push(headerRange);
      header = this.parseHeader(resolved, response.values[0] ?? []);
    }
    const values: SheetCellInput[][] = rows.map((row, rowOffset) => {
      const unknown = Object.keys(row).filter((field) => !(field in resolved.definition.columns));
      if (unknown.length > 0) throw new GQueryRuntimeError("MUTATION_INVALID", `Unknown append columns: ${unknown.join(", ")}.`);
      const physical = Array.from({ length: header.headers.length }, () => null as SheetCellInput);
      for (const [field, column] of Object.entries(resolved.definition.columns)) {
        physical[header.logicalToPhysical[field]] = toSheetInput(column.encode(row[field], {
          table: tableName,
          column: field,
          header: column.header ?? field,
          rowNumber: rowOffset + 2,
        }) as EncodedCell);
      }
      if (resolved.definition.versionColumn !== undefined) {
        physical[header.logicalToPhysical[resolved.definition.versionColumn]] = 1;
      }
      return physical;
    });
    return {
      resolved,
      rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
      values,
      stats,
    };
  }

  /**
   * Validate the final key graph represented by a write before any workbook is
   * mutated. Existing rows that are updated/deleted are removed first, which
   * lets an update retain its own key and permits atomic key swaps.
   */
  private validateWriteConstraints(
    updates: readonly PreparedUpdate[],
    appends: readonly PreparedAppend[],
    deletes: readonly MaterializedRow<Record<string, unknown>>[],
    constraintSnapshots: readonly WriteConstraintSnapshot[] = [],
  ): PreflightResult {
    const stats = createExecutionStats();
    const states = new Map<string, TableMutationState>();
    let stagedIndex = 0;
    const stateFor = (tableName: string): TableMutationState => {
      let state = states.get(tableName);
      if (state === undefined) {
        state = { tableName, removals: new Set<string>(), additions: [] };
        states.set(tableName, state);
      }
      return state;
    };

    for (const update of updates) {
      if (update.patches.length === 0) continue;
      const tableName = update.before.provenance.tableName;
      const definition = this.table(tableName);
      const changed = (fields: readonly string[]) => fields.some((field) =>
        !sameLogical(update.before.value[field], update.after.value[field])
      );
      const state = stateFor(tableName);
      const identity = materializedIdentity(update.before);
      state.removals.add(identity);
      state.additions.push({
        tableName,
        value: update.after.value,
        identity,
        rowIndex: update.before.provenance.rowIndex,
        stagedIndex: stagedIndex++,
        checkKeys: definition.primaryKey.some((field) => changed([field])) ||
          definition.unique.some(changed),
        checkForeignKeys: (Object.values(definition.relations) as RelationDefinition[])
          .some((relation) =>
            relation.kind === "belongs-to" && relation.required &&
            changed(asArray(relation.local))
          ),
      });
    }
    for (const item of deletes) {
      stateFor(item.provenance.tableName).removals.add(materializedIdentity(item));
    }
    for (const append of appends) {
      const state = stateFor(append.resolved.tableName);
      for (const row of append.rows) {
        state.additions.push({
          tableName: append.resolved.tableName,
          value: row,
          stagedIndex: stagedIndex++,
          checkKeys: true,
          checkForeignKeys: true,
        });
      }
    }

    const candidateStates = [...states.values()].filter(
      (state) => state.additions.length > 0,
    );
    const hasChecks = candidateStates.some((state) => state.additions.some(
      (candidate) => candidate.checkKeys || candidate.checkForeignKeys,
    ));
    if (!hasChecks) return { conflicts: [], stats };

    const requestedFields = new Map<string, Set<string>>();
    const requestFields = (tableName: string, fields: readonly string[]) => {
      const requested = requestedFields.get(tableName) ?? new Set<string>();
      for (const field of fields) requested.add(field);
      requestedFields.set(tableName, requested);
    };
    for (const state of candidateStates) {
      const definition = this.table(state.tableName);
      if (state.additions.some((candidate) => candidate.checkKeys)) {
        if (definition.primaryKey.length > 0) {
          requestFields(state.tableName, definition.primaryKey);
        }
        for (const key of definition.unique) requestFields(state.tableName, key);
      }
      for (const relation of Object.values(definition.relations) as RelationDefinition[]) {
        if (relation.kind !== "belongs-to" || !relation.required) continue;
        if (!state.additions.some((candidate) => candidate.checkForeignKeys)) continue;
        requestFields(relation.target, asArray(relation.foreign));
      }
    }

    const reusableRows = new Map<string, readonly ExistingConstraintRow[]>();
    for (const snapshot of constraintSnapshots) {
      reusableRows.set(snapshot.tableName, Object.freeze(snapshot.rows.map((item) => ({
        identity: materializedIdentity(item),
        rowIndex: item.provenance.rowIndex,
        value: item.value,
      }))));
    }
    const existing = this.scanConstraintRows(requestedFields, stats, reusableRows);
    const conflicts: MutationConflict[] = [];
    const conflictIds = new Set<string>();

    for (const state of candidateStates) {
      const definition = this.table(state.tableName);
      if (!state.additions.some((candidate) => candidate.checkKeys)) continue;
      const constraints: readonly {
        readonly kind: "primary" | "unique";
        readonly index: number;
        readonly fields: readonly string[];
      }[] = [
        ...(definition.primaryKey.length > 0
          ? [{ kind: "primary" as const, index: 0, fields: definition.primaryKey }]
          : []),
        ...definition.unique.map((fields, index) => ({
          kind: "unique" as const,
          index,
          fields,
        })),
      ];
      for (const constraint of constraints) {
        const existingByKey = new Map<string, ExistingConstraintRow>();
        for (const row of existing.get(state.tableName) ?? []) {
          if (state.removals.has(row.identity)) continue;
          const fingerprint = keyFingerprint(
            row.value as Record<string, unknown>,
            constraint.fields,
          );
          if (!existingByKey.has(fingerprint)) existingByKey.set(fingerprint, row);
        }
        const stagedByKey = new Map<string, WriteConstraintCandidate>();
        for (const candidate of state.additions) {
          const canonical = this.canonicalConstraintRow(
            state.tableName,
            candidate.value,
            constraint.fields,
            candidate.rowIndex,
          );
          const fingerprint = keyFingerprint(canonical, constraint.fields);
          const existingCollision = existingByKey.get(fingerprint);
          const stagedCollision = stagedByKey.get(fingerprint);
          const collision = existingCollision ?? stagedCollision;
          const shouldReport = existingCollision !== undefined
            ? candidate.checkKeys
            : stagedCollision !== undefined &&
              (candidate.checkKeys || stagedCollision.checkKeys);
          if (collision !== undefined && shouldReport) {
            const conflictId = `${state.tableName}:${constraint.kind}:${constraint.index}:${candidate.stagedIndex}:${fingerprint}`;
            if (!conflictIds.has(conflictId)) {
              conflictIds.add(conflictId);
              const values = Object.freeze(Object.fromEntries(
                constraint.fields.map((field) => [field, canonical[field]]),
              ));
              conflicts.push({
                code: "duplicate-key",
                table: state.tableName,
                key: this.candidateIdentityKey(definition, candidate, constraint.fields),
                rowIndex: candidate.rowIndex,
                expected: {
                  constraint: constraint.kind,
                  index: constraint.kind === "unique" ? constraint.index : undefined,
                  fields: constraint.fields,
                  values,
                },
                actual: existingCollision !== undefined
                  ? { source: "existing", rowIndex: existingCollision.rowIndex }
                  : { source: "staged", stagedIndex: stagedCollision!.stagedIndex },
                message: `Table ${state.tableName} would violate its ${constraint.kind} key (${constraint.fields.join(", ")}).`,
              });
            }
          }
          if (!stagedByKey.has(fingerprint)) stagedByKey.set(fingerprint, candidate);
        }
      }
    }

    const targetIndexes = new Map<string, Set<string>>();
    const targetIndex = (
      tableName: string,
      fields: readonly string[],
    ): Set<string> => {
      const cacheKey = `${tableName}:${fields.join("\u001f")}`;
      let index = targetIndexes.get(cacheKey);
      if (index !== undefined) return index;
      index = new Set<string>();
      const targetState = states.get(tableName);
      for (const row of existing.get(tableName) ?? []) {
        if (targetState?.removals.has(row.identity)) continue;
        index.add(keyFingerprint(row.value as Record<string, unknown>, fields));
      }
      for (const candidate of targetState?.additions ?? []) {
        const canonical = this.canonicalConstraintRow(
          tableName,
          candidate.value,
          fields,
          candidate.rowIndex,
        );
        index.add(keyFingerprint(canonical, fields));
      }
      targetIndexes.set(cacheKey, index);
      return index;
    };

    for (const state of candidateStates) {
      const definition = this.table(state.tableName);
      for (const [relationName, relation] of Object.entries(
        definition.relations,
      ) as [string, RelationDefinition][]) {
        if (relation.kind !== "belongs-to" || !relation.required) continue;
        const localFields = asArray(relation.local);
        const foreignFields = asArray(relation.foreign);
        const targets = targetIndex(relation.target, foreignFields);
        for (const candidate of state.additions) {
          if (!candidate.checkForeignKeys) continue;
          const local = this.canonicalConstraintRow(
            state.tableName,
            candidate.value,
            localFields,
            candidate.rowIndex,
          );
          const localValues = localFields.map((field) => local[field]);
          const missing = localValues.some(
            (value) => value === null || value === undefined || value === "",
          ) || !targets.has(canonicalStringify(localValues));
          if (!missing) continue;
          const conflictId = `${state.tableName}:foreign:${relationName}:${candidate.stagedIndex}`;
          if (conflictIds.has(conflictId)) continue;
          conflictIds.add(conflictId);
          conflicts.push({
            code: "foreign-key-missing",
            table: state.tableName,
            key: this.candidateIdentityKey(definition, candidate, localFields),
            rowIndex: candidate.rowIndex,
            expected: {
              relation: relationName,
              targetTable: relation.target,
              localFields,
              foreignFields,
              values: Object.freeze(Object.fromEntries(
                localFields.map((field, index) => [field, localValues[index]]),
              )),
            },
            actual: null,
            message: `Required relation ${state.tableName}.${relationName} has no matching ${relation.target} row.`,
          });
        }
      }
    }

    return { conflicts, stats };
  }

  private canonicalConstraintRow(
    tableName: string,
    row: Record<string, unknown>,
    fields: readonly string[],
    rowIndex?: number,
  ): Record<string, unknown> {
    const definition = this.table(tableName);
    const canonical: Record<string, unknown> = {};
    for (const field of fields) {
      const column = definition.columns[field];
      const context = {
        table: tableName,
        column: field,
        header: column.header ?? field,
        rowNumber: rowIndex === undefined ? undefined : rowIndex + 1,
      };
      const encoded = storedSheetValue(toSheetInput(
        column.encode(row[field], context) as EncodedCell,
      ));
      canonical[field] = column.decode(decodeCell(encoded), context);
    }
    return canonical;
  }

  private candidateIdentityKey(
    definition: TableDefinition,
    candidate: WriteConstraintCandidate,
    fallbackFields: readonly string[],
  ): Readonly<Record<string, unknown>> {
    const fields = definition.primaryKey.length > 0
      ? definition.primaryKey
      : fallbackFields;
    return Object.freeze(this.canonicalConstraintRow(
      candidate.tableName,
      candidate.value,
      fields,
      candidate.rowIndex,
    ));
  }

  /** Read only constrained fields plus the minimum row-presence anchors. */
  private scanConstraintRows(
    requestedFields: ReadonlyMap<string, ReadonlySet<string>>,
    stats: ExecutionStats,
    reusableRows: ReadonlyMap<string, readonly ExistingConstraintRow[]> = new Map(),
  ): ReadonlyMap<string, readonly ExistingConstraintRow[]> {
    const result = new Map<string, readonly ExistingConstraintRow[]>(reusableRows);
    const resolved = [...requestedFields.keys()]
      .filter((tableName) => !reusableRows.has(tableName))
      .map((tableName) =>
      this.resolveTable(tableName)
    );
    const missingHeaders = resolved.filter((table) =>
      !this.headers.has(`${table.spreadsheetId}:${table.definition.sheet}`)
    );
    const headersByWorkbook = new Map<string, ResolvedTable[]>();
    for (const table of missingHeaders) {
      const tables = headersByWorkbook.get(table.spreadsheetId) ?? [];
      tables.push(table);
      headersByWorkbook.set(table.spreadsheetId, tables);
    }
    for (const [spreadsheetId, tables] of headersByWorkbook) {
      const ranges = tables.map((table) => sheetRange(table.definition.sheet, "1:1"));
      const response = this.options.transport.batchGet(spreadsheetId, ranges, {
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      });
      stats.apiCalls += 1;
      stats.rangesRead.push(...ranges);
      stats.cellsRead += response.valueRanges.reduce(
        (sum, valueRange) =>
          sum + valueRange.values.reduce((inner, row) => inner + row.length, 0),
        0,
      );
      stats.bytesRead += estimateBytes(response.valueRanges);
      tables.forEach((table, index) => {
        this.parseHeader(table, response.valueRanges[index]?.values[0] ?? []);
      });
    }

    const plans: ConstraintScanPlan[] = resolved.map((table) => {
      const header = this.headers.get(
        `${table.spreadsheetId}:${table.definition.sheet}`,
      );
      if (header === undefined) {
        throw new GQueryRuntimeError(
          "MISSING_HEADER",
          `Could not load headers for constrained table ${table.tableName}.`,
        );
      }
      const fields = [...(requestedFields.get(table.tableName) ?? [])];
      const readFields = table.definition.versionColumn === undefined
        ? Object.keys(table.definition.columns)
        : fields;
      const byColumn = new Map<number, string | undefined>();
      for (const field of readFields) {
        byColumn.set(header.logicalToPhysical[field], fields.includes(field) ? field : undefined);
      }
      if (table.definition.versionColumn !== undefined) {
        const index = header.logicalToPhysical[table.definition.versionColumn];
        if (!byColumn.has(index)) byColumn.set(index, undefined);
      }
      const readColumns = [...byColumn.entries()]
        .sort(([left], [right]) => left - right)
        .map(([columnIndex, field]) => {
          const letter = columnIndexToLetter(columnIndex);
          return {
            field,
            columnIndex,
            range: sheetRange(table.definition.sheet, `${letter}2:${letter}`),
          };
        });
      return { resolved: table, header, requestedFields: fields, readColumns };
    });

    const plansByWorkbook = new Map<string, ConstraintScanPlan[]>();
    for (const plan of plans) {
      const workbookPlans = plansByWorkbook.get(plan.resolved.spreadsheetId) ?? [];
      workbookPlans.push(plan);
      plansByWorkbook.set(plan.resolved.spreadsheetId, workbookPlans);
    }
    for (const [spreadsheetId, workbookPlans] of plansByWorkbook) {
      const ranges = workbookPlans.flatMap((plan) =>
        plan.readColumns.map((column) => column.range)
      );
      if (ranges.length === 0) continue;
      const usesFormulaKey = workbookPlans.some((plan) =>
        plan.requestedFields.some((field) =>
          plan.resolved.definition.columns[field]?.kind === "formula"
        )
      );
      const response = this.options.transport.batchGet(spreadsheetId, ranges, {
        valueRenderOption: usesFormulaKey ? "FORMULA" : "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      });
      stats.apiCalls += 1;
      stats.rangesRead.push(...ranges);
      stats.fullScans += workbookPlans.length;
      stats.cellsRead += response.valueRanges.reduce(
        (sum, valueRange) =>
          sum + valueRange.values.reduce((inner, row) => inner + row.length, 0),
        0,
      );
      stats.bytesRead += estimateBytes(response.valueRanges);
      let rangeIndex = 0;
      for (const plan of workbookPlans) {
        const columnRanges = plan.readColumns.map(() =>
          response.valueRanges[rangeIndex++]
        );
        const height = columnRanges.reduce(
          (maximum, valueRange) => Math.max(maximum, valueRange?.values.length ?? 0),
          0,
        );
        const rows: ExistingConstraintRow[] = [];
        for (let rowOffset = 0; rowOffset < height; rowOffset += 1) {
          const rawValues = columnRanges.map((valueRange) =>
            valueRange?.values[rowOffset]?.[0]
          );
          if (rawValues.every((value) =>
            value === undefined || value === null || value === ""
          )) continue;
          const value: Record<string, unknown> = {};
          for (let columnOffset = 0; columnOffset < plan.readColumns.length; columnOffset += 1) {
            const field = plan.readColumns[columnOffset].field;
            if (field === undefined) continue;
            const column = plan.resolved.definition.columns[field];
            value[field] = column.decode(decodeCell(rawValues[columnOffset]), {
              table: plan.resolved.tableName,
              column: field,
              header: column.header ?? field,
              rowNumber: rowOffset + 2,
            });
          }
          const rowIndex = rowOffset + 1;
          rows.push({
            identity: `${spreadsheetId}:${plan.resolved.sheet.sheetId}:${rowIndex}`,
            rowIndex,
            value: Object.freeze(value),
          });
        }
        result.set(plan.resolved.tableName, Object.freeze(rows));
      }
    }
    return result;
  }

  private recordTouched(
    touched: Map<string, Set<string>>,
    materialized: readonly MaterializedRow<Record<string, unknown>>[],
  ): void {
    for (const item of materialized) {
      const names = touched.get(item.provenance.spreadsheetId) ?? new Set<string>();
      names.add(item.provenance.tableName);
      touched.set(item.provenance.spreadsheetId, names);
    }
  }

  private table(tableName: string): TableDefinition {
    const table = (this.schema.tables as TableMap)[tableName];
    if (table === undefined) throw new GQueryRuntimeError("INVALID_QUERY", `Unknown table ${tableName}.`);
    return table;
  }

  private source(sourceName: string): SourceDefinition {
    const source = this.schema.sources[sourceName];
    if (source === undefined) throw new GQueryRuntimeError("SOURCE_UNAVAILABLE", `Unknown source ${sourceName}.`);
    return source;
  }

  private sourceIdentity(sourceName: string): string {
    const definition = this.source(sourceName);
    return definition.kind === "spreadsheet-id" ? definition.spreadsheetId : "active-spreadsheet";
  }

  private spreadsheetId(sourceName: string): string {
    const definition = this.source(sourceName);
    if (definition.kind === "spreadsheet-id") return definition.spreadsheetId;
    try {
      const id = this.options.resolveActiveSpreadsheetId?.() ?? SpreadsheetApp.getActiveSpreadsheet().getId();
      if (!id) throw new Error("Active spreadsheet has no ID.");
      return id;
    } catch (error) {
      throw new GQueryRuntimeError(
        "SOURCE_UNAVAILABLE",
        "The active spreadsheet source cannot be resolved in this execution context.",
        { cause: error },
      );
    }
  }

  private resolveTable(tableName: string): ResolvedTable {
    const definition = this.table(tableName);
    const spreadsheetId = this.spreadsheetId(definition.source);
    let sheets = this.metadata.get(spreadsheetId);
    if (sheets === undefined) {
      sheets = this.options.transport.getSpreadsheetMetadata(spreadsheetId).sheets;
      this.metadata.set(spreadsheetId, sheets);
    }
    const sheet = sheets.find((candidate) => candidate.title === definition.sheet);
    if (sheet === undefined) {
      throw new GQueryRuntimeError(
        "SHEET_NOT_FOUND",
        `Table ${tableName} expects sheet ${definition.sheet}, but it does not exist.`,
        { details: { table: tableName, spreadsheetId, sheet: definition.sheet } },
      );
    }
    return { tableName, definition, sourceName: definition.source, spreadsheetId, sheet };
  }

  private parseHeader(resolved: ResolvedTable, values: readonly SheetCellValue[]): HeaderState {
    const headers = values.map((value) => typeof value === "string" ? value : String(value ?? ""));
    const indexes = new Map<string, number>();
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      if (header.length === 0) continue;
      if (indexes.has(header)) {
        throw new GQueryRuntimeError("DUPLICATE_HEADER", `Sheet ${resolved.definition.sheet} contains duplicate header ${header}.`);
      }
      indexes.set(header, index);
    }
    const logicalToPhysical: Record<string, number> = {};
    for (const [field, column] of Object.entries(resolved.definition.columns as ColumnMap)) {
      const header = column.header ?? field;
      const index = indexes.get(header);
      if (index === undefined) {
        throw new GQueryRuntimeError(
          "MISSING_HEADER",
          `Table ${resolved.tableName} is missing required header ${header}.`,
          { details: { table: resolved.tableName, field, header } },
        );
      }
      logicalToPhysical[field] = index;
    }
    if (resolved.definition.versionColumn !== undefined) {
      const index = indexes.get(resolved.definition.versionColumn);
      if (index === undefined) {
        throw new GQueryRuntimeError(
          "MIGRATION_REQUIRED",
          `Table ${resolved.tableName} requires version header ${resolved.definition.versionColumn}. Run schema.plan() and schema.migrate().`,
        );
      }
      logicalToPhysical[resolved.definition.versionColumn] = index;
    }
    const state = Object.freeze({
      headers: Object.freeze(headers),
      logicalToPhysical: Object.freeze(logicalToPhysical),
      fingerprint: hashCanonical(headers),
    });
    this.headers.set(`${resolved.spreadsheetId}:${resolved.definition.sheet}`, state);
    return state;
  }

  private parseSnapshot(
    resolved: ResolvedTable,
    values: readonly (readonly SheetCellValue[])[],
    range: string,
    physicalRowIndexes?: readonly number[],
    completeSnapshot = true,
  ): TableSnapshot {
    const header = this.parseHeader(resolved, values[0] ?? []);
    const rows: MaterializedRow<Record<string, unknown>>[] = [];
    const seenPrimary = new Map<string, number>();
    const seenUnique = resolved.definition.unique.map(() => new Map<string, number>());
    for (let dataIndex = 1; dataIndex < values.length; dataIndex += 1) {
      const physical = values[dataIndex] ?? [];
      if (physical.every((value) => value === null || value === undefined || value === "")) continue;
      const decoded: Record<string, unknown> = {};
      const encoded: Record<string, SheetCellValue> = {};
      for (const [field, column] of Object.entries(resolved.definition.columns as ColumnMap)) {
        const index = header.logicalToPhysical[field];
        const physicalValue = physical[index];
        decoded[field] = column.decode(decodeCell(physicalValue), {
          table: resolved.tableName,
          column: field,
          header: column.header ?? field,
          rowNumber: dataIndex + 1,
        });
        encoded[field] = rawCell(physicalValue);
      }
      if (resolved.definition.primaryKey.length > 0) {
        const fingerprint = keyFingerprint(decoded, resolved.definition.primaryKey);
        const previous = seenPrimary.get(fingerprint);
        if (previous !== undefined) {
          throw new GQueryRuntimeError(
            "DUPLICATE_KEY",
            `Table ${resolved.tableName} contains duplicate primary key at rows ${previous + 1} and ${dataIndex + 1}.`,
            { details: { table: resolved.tableName, fingerprint, rows: [previous + 1, dataIndex + 1] } },
          );
        }
        seenPrimary.set(fingerprint, dataIndex);
      }
      resolved.definition.unique.forEach((key, uniqueIndex) => {
        const fingerprint = keyFingerprint(decoded, key);
        const previous = seenUnique[uniqueIndex].get(fingerprint);
        if (previous !== undefined) {
          throw new GQueryRuntimeError(
            "DUPLICATE_KEY",
            `Table ${resolved.tableName} violates unique key (${key.join(", ")}) at rows ${previous + 1} and ${dataIndex + 1}.`,
          );
        }
        seenUnique[uniqueIndex].set(fingerprint, dataIndex);
      });
      const primaryKey: Record<string, unknown> = {};
      const encodedPrimaryKey: Record<string, SheetCellValue> = {};
      for (const field of resolved.definition.primaryKey) {
        primaryKey[field] = decoded[field];
        encodedPrimaryKey[field] = encoded[field];
      }
      const version = resolved.definition.versionColumn === undefined
        ? undefined
        : rawCell(physical[header.logicalToPhysical[resolved.definition.versionColumn]]);
      const physicalRowIndex = physicalRowIndexes?.[dataIndex - 1] ?? dataIndex;
      const provenance: RowProvenance = Object.freeze({
        sourceName: resolved.sourceName,
        spreadsheetId: resolved.spreadsheetId,
        tableName: resolved.tableName,
        sheetName: resolved.definition.sheet,
        sheetId: resolved.sheet.sheetId,
        rowIndex: physicalRowIndex,
        primaryKey: Object.freeze(primaryKey),
        encodedPrimaryKey: Object.freeze(encodedPrimaryKey),
        version,
        originalEncoded: Object.freeze(encoded),
        columnIndexes: header.logicalToPhysical,
        headerFingerprint: header.fingerprint,
        readAt: this.now().toISOString(),
        relations: Object.freeze({}),
        relationCardinalities: Object.freeze({}),
      });
      rows.push({ value: decoded, provenance });
    }
    this.registerLocators(resolved, rows, completeSnapshot);
    return {
      resolved,
      header,
      rows,
      range,
      cellsRead: values.reduce((sum, row) => sum + row.length, 0),
      bytesRead: estimateBytes(values),
    };
  }

  private requireSnapshot(snapshots: ReadonlyMap<string, TableSnapshot>, tableName: string): TableSnapshot {
    const snapshot = snapshots.get(tableName);
    if (snapshot === undefined) throw new GQueryRuntimeError("INVALID_QUERY", `No snapshot was loaded for table ${tableName}.`);
    return snapshot;
  }

  private cacheForTable(table: ResolvedTable): RuntimeCacheAdapter | null {
    const policy = table.definition.cache;
    if (policy === undefined) return null;
    return this.options.cacheForScope?.(policy.scope) ?? this.options.cache ?? null;
  }

  private indexForQuery<T extends Record<string, unknown>>(
    query: ExecutableQuery<T>,
  ): { readonly fields: readonly string[]; readonly values: ReadonlyMap<string, unknown> } | null {
    if (query.plan.joins.length > 0 || query.localPredicates.length > 0) return null;
    const values = equalityFields(query.plan.predicate);
    if (values === null) return null;
    const definition = this.table(query.plan.table);
    const candidates: readonly (readonly string[])[] = [
      definition.primaryKey,
      ...definition.unique,
      ...(definition.cache?.indexes ?? []),
    ];
    const fields = candidates.find((candidate) => candidate.length > 0 && candidate.every((field) => values.has(field)));
    return fields === undefined ? null : { fields, values };
  }

  private tryBoundedRead<T extends Record<string, unknown>>(
    query: ExecutableQuery<T>,
    resolved: ResolvedTable,
  ): BoundedReadResult | null {
    if (this.cacheForTable(resolved) !== null) return null;
    const indexed = this.indexForQuery(query);
    const header = this.headers.get(`${resolved.spreadsheetId}:${resolved.definition.sheet}`);
    if (indexed === null || header === undefined) return null;
    const logical: Record<string, unknown> = {};
    const encoded: Record<string, SheetCellValue> = {};
    for (const field of indexed.fields) {
      const value = indexed.values.get(field);
      logical[field] = value;
      const column = resolved.definition.columns[field];
      encoded[field] = storedSheetValue(toSheetInput(column.encode(value, {
        table: resolved.tableName,
        column: field,
        header: column.header ?? field,
      }) as EncodedCell));
    }
    const locatorKey = this.locatorKey(resolved, indexed.fields, logical);
    const stats = createExecutionStats();
    let rowIndexes = this.locators.get(locatorKey);
    if (rowIndexes === undefined) {
      rowIndexes = this.scanLocator(resolved, header, indexed.fields, encoded, stats);
      this.locators.set(locatorKey, rowIndexes);
    }
    let loaded = this.loadLocatedRows(resolved, header, indexed.fields, encoded, rowIndexes, stats);
    if (loaded === null) {
      this.locators.delete(locatorKey);
      rowIndexes = this.scanLocator(resolved, header, indexed.fields, encoded, stats);
      this.locators.set(locatorKey, rowIndexes);
      loaded = this.loadLocatedRows(resolved, header, indexed.fields, encoded, rowIndexes, stats);
    }
    return loaded === null ? null : { snapshot: loaded, stats };
  }

  private scanLocator(
    resolved: ResolvedTable,
    header: HeaderState,
    fields: readonly string[],
    expected: Readonly<Record<string, SheetCellValue>>,
    stats: ExecutionStats,
  ): readonly number[] {
    const ranges = fields.map((field) => {
      const column = columnIndexToLetter(header.logicalToPhysical[field]);
      return sheetRange(resolved.definition.sheet, `${column}2:${column}`);
    });
    const response = this.options.transport.batchGet(resolved.spreadsheetId, ranges, {
      valueRenderOption: fields.some(
        (field) => resolved.definition.columns[field]?.kind === "formula",
      ) ? "FORMULA" : "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    stats.apiCalls += 1;
    stats.rangesRead.push(...ranges);
    stats.cellsRead += response.valueRanges.reduce(
      (total, valueRange) => total + valueRange.values.reduce((sum, row) => sum + row.length, 0),
      0,
    );
    stats.bytesRead += estimateBytes(response.valueRanges);
    const height = response.valueRanges.reduce((maximum, valueRange) => Math.max(maximum, valueRange.values.length), 0);
    const matches: number[] = [];
    for (let rowOffset = 0; rowOffset < height; rowOffset += 1) {
      const matchesKey = fields.every((field, fieldIndex) =>
        sameCell(response.valueRanges[fieldIndex]?.values[rowOffset]?.[0], expected[field]),
      );
      if (matchesKey) matches.push(rowOffset + 1);
    }
    return Object.freeze(matches);
  }

  private loadLocatedRows(
    resolved: ResolvedTable,
    header: HeaderState,
    fields: readonly string[],
    expected: Readonly<Record<string, SheetCellValue>>,
    rowIndexes: readonly number[],
    stats: ExecutionStats,
  ): TableSnapshot | null {
    if (rowIndexes.length === 0) {
      return this.parseSnapshot(
        resolved,
        [header.headers as readonly SheetCellValue[]],
        `${resolved.definition.sheet}:bounded-empty`,
        [],
        false,
      );
    }
    const ranges = rowIndexes.map((rowIndex) => cellRange(
      resolved.definition.sheet,
      rowIndex,
      0,
      1,
      Math.max(1, header.headers.length),
    ));
    const response = this.options.transport.batchGet(resolved.spreadsheetId, ranges, {
      valueRenderOption: tableUsesFormula(resolved.definition)
        ? "FORMULA"
        : "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    stats.apiCalls += 1;
    stats.rangesRead.push(...ranges);
    stats.cellsRead += response.valueRanges.reduce(
      (total, valueRange) => total + valueRange.values.reduce((sum, row) => sum + row.length, 0),
      0,
    );
    stats.bytesRead += estimateBytes(response.valueRanges);
    const rows = response.valueRanges.map((valueRange) => valueRange.values[0] ?? []);
    const valid = rows.every((row) => fields.every((field) =>
      sameCell(row[header.logicalToPhysical[field]], expected[field]),
    ));
    if (!valid) return null;
    return this.parseSnapshot(
      resolved,
      [header.headers as readonly SheetCellValue[], ...rows],
      ranges.join(","),
      rowIndexes,
      false,
    );
  }

  private locatorKey(
    resolved: ResolvedTable,
    fields: readonly string[],
    row: Record<string, unknown>,
  ): string {
    return `${resolved.spreadsheetId}:${resolved.tableName}:${fields.join("\u001f")}:${hashCanonical(fields.map((field) => row[field]))}`;
  }

  private registerLocators(
    resolved: ResolvedTable,
    rows: readonly MaterializedRow<Record<string, unknown>>[],
    completeSnapshot: boolean,
  ): void {
    if (completeSnapshot) this.clearTableLocators(resolved.spreadsheetId, resolved.tableName);
    const indexes: readonly (readonly string[])[] = [
      resolved.definition.primaryKey,
      ...resolved.definition.unique,
      ...(resolved.definition.cache?.indexes ?? []),
    ];
    for (const fields of indexes) {
      if (fields.length === 0) continue;
      for (const row of rows) {
        const key = this.locatorKey(resolved, fields, row.value);
        const current = this.locators.get(key) ?? [];
        if (!current.includes(row.provenance.rowIndex)) {
          this.locators.set(key, Object.freeze([...current, row.provenance.rowIndex].sort((a, b) => a - b)));
        }
      }
    }
  }

  private clearTableLocators(spreadsheetId: string, tableName: string): void {
    const prefix = `${spreadsheetId}:${tableName}:`;
    for (const key of [...this.locators.keys()]) {
      if (key.startsWith(prefix)) this.locators.delete(key);
    }
  }

  private tableCacheKey(table: ResolvedTable): Readonly<Record<string, unknown>> {
    const policy = table.definition.cache;
    if (policy === undefined) throw new Error("A cache key requires a table cache policy.");
    const generation = this.options.generations?.current({
      kind: "table",
      sourceId: table.spreadsheetId,
      table: table.tableName,
    }) ?? "0";
    const tagGenerations = (policy.tags ?? []).map((tag) => ({
      tag,
      generation: this.options.generations?.current({ kind: "tag", tag }) ?? "0",
    }));
    return {
      kind: "table-snapshot",
      spreadsheetId: table.spreadsheetId,
      schemaVersion: this.schema.version,
      table: table.tableName,
      sheet: table.definition.sheet,
      columns: Object.entries(table.definition.columns).map(([field, column]) => [
        field,
        column.header ?? field,
        column.kind,
      ]),
      valueRenderOption: tableUsesFormula(table.definition)
        ? "FORMULA"
        : "UNFORMATTED_VALUE",
      scope: policy.scope,
      scopeIdentity: this.options.scopeIdentity?.(policy.scope) ?? null,
      generation,
      tagGenerations,
    };
  }

  private preflight(
    materialized: readonly MaterializedRow<Record<string, unknown>>[],
  ): PreflightResult {
    const stats = createExecutionStats();
    const conflicts: MutationConflict[] = [];
    const bySpreadsheet = new Map<string, MaterializedRow<Record<string, unknown>>[]>();
    for (const item of materialized) {
      const group = bySpreadsheet.get(item.provenance.spreadsheetId) ?? [];
      group.push(item);
      bySpreadsheet.set(item.provenance.spreadsheetId, group);
    }
    for (const [spreadsheetId, items] of bySpreadsheet) {
      const headerGroups = new Map<string, RowProvenance>();
      for (const item of items) headerGroups.set(`${item.provenance.sheetId}`, item.provenance);
      const headerRanges = [...headerGroups.values()].map((provenance) => sheetRange(provenance.sheetName, "1:1"));
      const entries: PreflightEntry[] = items.map((item) => {
        const definition = this.table(item.provenance.tableName);
        const fields = definition.primaryKey.length > 0
          ? [...definition.primaryKey]
          : Object.keys(definition.columns);
        const indexes = fields.map((field) => item.provenance.columnIndexes[field]);
        if (definition.versionColumn !== undefined) indexes.push(item.provenance.columnIndexes[definition.versionColumn]);
        const minColumn = Math.min(...indexes);
        const maxColumn = Math.max(...indexes);
        return {
          materialized: item,
          minColumn,
          maxColumn,
          range: cellRange(item.provenance.sheetName, item.provenance.rowIndex, minColumn, 1, maxColumn - minColumn + 1),
        };
      });
      const ranges = [...headerRanges, ...entries.map((entry) => entry.range)];
      const response = this.options.transport.batchGet(spreadsheetId, ranges, {
        valueRenderOption: items.some((item) =>
          tableUsesFormula(this.table(item.provenance.tableName))
        ) ? "FORMULA" : "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      });
      stats.apiCalls += 1;
      stats.rangesRead.push(...ranges);
      stats.cellsRead += response.valueRanges.reduce((sum, valueRange) => sum + valueRange.values.reduce((inner, row) => inner + row.length, 0), 0);
      stats.bytesRead += estimateBytes(response.valueRanges);
      [...headerGroups.values()].forEach((provenance, index) => {
        const fingerprint = hashCanonical((response.valueRanges[index]?.values[0] ?? []).map((value) => typeof value === "string" ? value : String(value ?? "")));
        if (fingerprint !== provenance.headerFingerprint) {
          conflicts.push({
            code: "schema-changed",
            table: provenance.tableName,
            key: provenance.primaryKey,
            expected: provenance.headerFingerprint,
            actual: fingerprint,
            message: `Headers changed after ${provenance.tableName} was read.`,
          });
        }
      });
      entries.forEach((entry, entryIndex) => {
        const row = response.valueRanges[headerRanges.length + entryIndex]?.values[0];
        const provenance = entry.materialized.provenance;
        if (row === undefined || row.length === 0) {
          conflicts.push({
            code: "missing",
            table: provenance.tableName,
            key: provenance.primaryKey,
            rowIndex: provenance.rowIndex,
            message: "The selected row no longer exists.",
          });
          return;
        }
        const definition = this.table(provenance.tableName);
        const verifyFields = definition.primaryKey.length > 0
          ? definition.primaryKey
          : Object.keys(definition.columns);
        for (const field of verifyFields) {
          const offset = provenance.columnIndexes[field] - entry.minColumn;
          const expected = definition.primaryKey.length > 0
            ? provenance.encodedPrimaryKey[field]
            : provenance.originalEncoded[field];
          const actual = row[offset];
          if (!sameCell(actual, expected)) {
            conflicts.push({
              code: "key-changed",
              table: provenance.tableName,
              key: provenance.primaryKey,
              rowIndex: provenance.rowIndex,
              expected,
              actual: rawCell(actual),
              message: `Row identity column ${field} changed after it was selected.`,
            });
            break;
          }
        }
        if (definition.versionColumn !== undefined) {
          const offset = provenance.columnIndexes[definition.versionColumn] - entry.minColumn;
          const actual = rawCell(row[offset]);
          if (!sameCell(actual, provenance.version as SheetCellValue)) {
            conflicts.push({
              code: "version-changed",
              table: provenance.tableName,
              key: provenance.primaryKey,
              rowIndex: provenance.rowIndex,
              expected: provenance.version,
              actual,
              message: "The row version changed after it was selected.",
            });
          }
        }
      });
    }
    return { conflicts, stats };
  }

  private assertSingleMutationTable<T extends Record<string, unknown>>(
    materialized: readonly MaterializedRow<T>[],
  ): void {
    const identities = new Set(materialized.map((item) => `${item.provenance.spreadsheetId}:${item.provenance.tableName}`));
    if (identities.size > 1) {
      throw new GQueryRuntimeError("MUTATION_INVALID", "One selection mutation must target exactly one physical table.");
    }
  }

  private groupPatchesBySpreadsheet(prepared: readonly PreparedUpdate[]): Map<string, CellPatch[]> {
    const result = new Map<string, CellPatch[]>();
    for (const item of prepared) {
      const id = item.before.provenance.spreadsheetId;
      const patches = result.get(id) ?? [];
      patches.push(...item.patches);
      result.set(id, patches);
    }
    return result;
  }

  private sheetName(spreadsheetId: string, sheetId: number): string {
    return this.metadata.get(spreadsheetId)?.find((sheet) => sheet.sheetId === sheetId)?.title ?? `sheetId:${sheetId}`;
  }

  private invalidateMaterialized(materialized: readonly MaterializedRow<Record<string, unknown>>[]): void {
    const tables = new Set<string>();
    for (const item of materialized) {
      const identity = `${item.provenance.spreadsheetId}:${item.provenance.tableName}`;
      if (!tables.has(identity)) {
        tables.add(identity);
        this.invalidateTable(item.provenance.spreadsheetId, item.provenance.tableName);
      }
      this.options.generations?.invalidateRow?.(
        item.provenance.spreadsheetId,
        item.provenance.tableName,
        item.provenance.primaryKey,
      );
    }
  }
}
