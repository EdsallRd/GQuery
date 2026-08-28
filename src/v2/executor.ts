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
import {
  cloneProvenance,
  invalidateChangedRelations,
  type MaterializedRow,
  type RowProvenance,
} from "./provenance";
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
import type {
  DeferredJournal,
  DeferredOverlayReader,
  PendingDeferredMutation,
} from "./infrastructure/deferred";
import {
  buildQueryCacheKey,
  type DependencyGeneration,
} from "./infrastructure/cache";
import { GQueryV2Error } from "./infrastructure/errors";
import { validateJoinPlan } from "./join-validation";
import type { SchemaCanonicalState } from "./management";

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
  readThrough?<T>(
    key: unknown,
    producer: () => T,
    policy?: { ttlSeconds?: number; jitterSeconds?: number },
  ): {
    readonly value: T;
    readonly cache: "hit" | "hit-after-wait" | "filled" | "uncached";
  };
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
  readonly deferredOverlay?: DeferredOverlayReader;
  readonly canonicalState?: SchemaCanonicalState;
  readonly executionScope?: {
    run<T>(operation: () => T): T;
    retryCount?(): number;
  };
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

interface TableIdentity {
  readonly tableName: string;
  readonly definition: TableDefinition;
  readonly sourceName: string;
  readonly spreadsheetId: string;
}

interface ResolvedTable extends TableIdentity {
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
  readonly version: 2;
  readonly spreadsheetId: string;
  readonly tableName: string;
  readonly sheet: SheetMetadata;
  readonly headerFingerprint: string;
  readonly range: string;
  readonly values: readonly (readonly SheetCellValue[])[];
}

interface SnapshotCacheEntry {
  readonly cache: RuntimeCacheAdapter;
  readonly key: Readonly<Record<string, unknown>>;
}

interface CachedLocatorIndex {
  readonly version: 1;
  readonly spreadsheetId: string;
  readonly table: string;
  readonly sheet: SheetMetadata;
  readonly headerFingerprint: string;
  readonly headers: readonly string[];
  readonly fields: readonly string[];
  readonly entries: readonly (readonly [string, readonly number[]])[];
}

interface LoadedSnapshot {
  readonly snapshot: TableSnapshot;
  readonly payload: CachedTableSnapshot;
}

interface SnapshotColumnBlock {
  readonly startColumnIndex: number;
  readonly endColumnIndex: number;
  readonly range: string;
}

interface SnapshotReadPlan {
  readonly table: ResolvedTable;
  /** Null means the complete physical sheet is required. */
  readonly fields: readonly string[] | null;
  readonly blocks: readonly SnapshotColumnBlock[];
}

interface RowHydrationRead {
  readonly item: MaterializedRow<Record<string, unknown>>;
  readonly startColumnIndex: number;
  readonly endColumnIndex: number;
  readonly range: string;
}

interface PreparedUpdate {
  readonly before: MaterializedRow<Record<string, unknown>>;
  readonly after: MaterializedRow<Record<string, unknown>>;
  readonly patches: readonly CellPatch[];
  readonly changedFields: readonly string[];
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
  return value === undefined || value === null || value === "" ? BLANK_CELL : value;
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

function collectPredicateFields(node: PredicateNode | undefined, fields: Set<string>): void {
  if (node === undefined || node.kind === "constant") return;
  if (node.kind === "field") {
    fields.add(node.field);
    return;
  }
  if (node.kind === "not") {
    collectPredicateFields(node.node, fields);
    return;
  }
  for (const child of node.nodes) collectPredicateFields(child, fields);
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

function isQuotaFailure(error: unknown, seen = new Set<object>()): boolean {
  if (typeof error !== "object" || error === null) {
    const message = String(error).toLowerCase();
    return message.includes("quota") || message.includes("rate limit") || message.includes("too many requests");
  }
  if (seen.has(error)) return false;
  seen.add(error);
  const candidate = error as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly details?: unknown;
    readonly cause?: unknown;
    readonly api?: unknown;
  };
  if (candidate.code === "API_RATE_LIMIT") return true;
  if (candidate instanceof GQueryV2Error && candidate.code === "RETRY_EXHAUSTED") {
    const details = candidate.details as { readonly lastFailure?: { readonly kind?: unknown } };
    if (details.lastFailure?.kind === "rate-limit") return true;
  }
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  if (
    message.includes("quota exceeded") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("resource_exhausted") ||
    message.includes("service invoked too many times")
  ) {
    return true;
  }
  return isQuotaFailure(candidate.cause, seen) ||
    isQuotaFailure(candidate.details, seen) ||
    isQuotaFailure((candidate as { readonly api?: unknown }).api, seen);
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
  target.joinFanOut += source.joinFanOut;
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
  private readonly knownSheets = new Map<string, SheetMetadata>();
  private readonly knownSheetTitles = new Map<string, string>();
  private readonly headers = new Map<string, HeaderState>();
  private readonly locators = new Map<string, readonly number[]>();
  private readonly now: () => Date;
  private deferredOverlaySuppression = 0;
  private readCacheSuppression = 0;

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

  /** Internal flush hook: deferred delivery must compare against physical state. */
  public withoutDeferredOverlay<T>(operation: () => T): T {
    this.deferredOverlaySuppression += 1;
    try {
      return operation();
    } finally {
      this.deferredOverlaySuppression -= 1;
    }
  }

  /**
   * Optimistic deferred rows are suitable for reads and further deferred
   * composition, but never as physical coordinates for an immediate write.
   */
  public assertNoDeferredOverlayRows(
    rows: readonly MaterializedRow<Record<string, unknown>>[],
    operation: string,
  ): void {
    if (this.deferredOverlaySuppression > 0) return;
    const pending = this.options.deferredJournal?.readAndRebuildOverlay() ??
      this.pendingDeferredEntries();
    const pendingByTarget = new Map<string, PendingDeferredMutation[]>();
    for (const entry of pending) {
      const target = `${entry.sourceId}\u0000${entry.table}\u0000${canonicalStringify(entry.key)}`;
      const matches = pendingByTarget.get(target) ?? [];
      matches.push(entry);
      pendingByTarget.set(target, matches);
    }
    const affected = rows.flatMap((row) => {
      const target = `${row.provenance.spreadsheetId}\u0000${row.provenance.tableName}\u0000${canonicalStringify(row.provenance.encodedPrimaryKey)}`;
      const matchingEntries = pendingByTarget.get(target) ?? [];
      if (row.provenance.deferredOverlay === undefined && matchingEntries.length === 0) return [];
      return [{ row, matchingEntries }];
    });
    if (affected.length === 0) return;
    throw new GQueryRuntimeError(
      "MUTATION_CONFLICT",
      `Cannot ${operation} from a selection containing unflushed deferred state. Flush the deferred journal and refresh the selection, or use deferred delivery for the new mutation.`,
      {
        details: {
          rows: affected.map(({ row, matchingEntries }) => ({
            table: row.provenance.tableName,
            key: row.provenance.primaryKey,
            virtual: row.provenance.deferredOverlay?.virtual ?? false,
            mutationIds: [...new Set([
              ...(row.provenance.deferredOverlay?.mutationIds ?? []),
              ...matchingEntries.map((entry) => entry.id),
            ])],
            fields: [...new Set([
              ...(row.provenance.deferredOverlay?.fields ?? []),
              ...matchingEntries.flatMap((entry) => Object.keys(entry.values ?? {})),
            ])],
          })),
        },
      },
    );
  }

  /** Internal flush hook: journal preflight reads must observe physical Sheets state. */
  public withoutReadCache<T>(operation: () => T): T {
    this.readCacheSuppression += 1;
    try {
      return operation();
    } finally {
      this.readCacheSuppression -= 1;
    }
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

    const identities = new Map<string, TableIdentity>();
    for (const tableName of requestedTables) {
      identities.set(tableName, this.tableIdentity(tableName));
    }

    const snapshots = new Map<string, TableSnapshot>();
    const readStats = createExecutionStats();
    const resolved = new Map<string, ResolvedTable>();
    const cacheHitTables = new Set<string>();
    const staleHitTables = new Set<string>();
    const staleCandidates = new Map<string, TableSnapshot>();
    for (const identity of identities.values()) {
      const freshEntries = this.freshCacheEntries(identity, queries, identities);
      const snapshot = this.cachedSnapshotFrom(identity, freshEntries);
      if (snapshot !== null) {
        resolved.set(identity.tableName, snapshot.resolved);
        snapshots.set(identity.tableName, snapshot);
        cacheHitTables.add(identity.tableName);
        readStats.cacheHits += 1;
      } else if (freshEntries.length > 0) {
        readStats.cacheMisses += 1;
        const stale = this.cachedSnapshotFrom(
          identity,
          this.staleCacheEntries(identity, queries, identities),
        );
        if (stale !== null) staleCandidates.set(identity.tableName, stale);
      }
    }

    const boundedQueries = new Set<string>();
    try {
      for (const identity of identities.values()) {
        if (resolved.has(identity.tableName)) continue;
        resolved.set(identity.tableName, this.resolveIdentity(identity, readStats));
      }

      const queryEntries = Object.entries(queries);
      if (queryEntries.length === 1) {
        const [queryName, query] = queryEntries[0];
        const base = resolved.get(query.plan.table);
        if (base !== undefined && !snapshots.has(base.tableName)) {
          this.hydratePersistentLocator(query, base, readStats);
          const bounded = this.tryBoundedRead(query, base);
          if (bounded !== null) {
            snapshots.set(base.tableName, bounded.snapshot);
            addStats(readStats, bounded.stats);
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
        const leaders = tables.flatMap((table) =>
          this.freshCacheEntries(table, queries, identities)
            .filter((entry) => entry.cache.readThrough !== undefined)
            .map((entry) => ({ table, entry })),
        ).sort((left, right) => canonicalStringify({
          table: left.table.tableName,
          key: left.entry.key,
        }).localeCompare(canonicalStringify({
          table: right.table.tableName,
          key: right.entry.key,
        })));
        const leader = leaders[0];
        if (leader === undefined) {
          const loaded = this.readSnapshotGroup(
            spreadsheetId,
            tables,
            queries,
            identities,
            readStats,
          );
          for (const [tableName, item] of loaded) snapshots.set(tableName, item.snapshot);
          continue;
        }

        const production: { loaded?: ReadonlyMap<string, LoadedSnapshot> } = {};
        const readThrough = leader.entry.cache.readThrough!.bind(leader.entry.cache) as <T>(
          key: unknown,
          producer: () => T,
          policy?: { ttlSeconds?: number; jitterSeconds?: number },
        ) => {
          readonly value: T;
          readonly cache: "hit" | "hit-after-wait" | "filled" | "uncached";
        };
        const outcome = readThrough<CachedTableSnapshot>(
          leader.entry.key,
          () => {
            production.loaded = this.readSnapshotGroup(
              spreadsheetId,
              tables,
              queries,
              identities,
              readStats,
              { tableName: leader.table.tableName, key: leader.entry.key },
            );
            return production.loaded.get(leader.table.tableName)!.payload;
          },
          {
            ttlSeconds: leader.table.definition.cache?.ttlSeconds,
            jitterSeconds: leader.table.definition.cache?.jitterSeconds,
          },
        );
        const produced = production.loaded;
        if (produced !== undefined) {
          for (const [tableName, item] of produced) snapshots.set(tableName, item.snapshot);
          continue;
        }

        const leaderSnapshot = this.parseCachedSnapshot(leader.table, outcome.value);
        if (leaderSnapshot !== null) {
          snapshots.set(leader.table.tableName, leaderSnapshot);
          cacheHitTables.add(leader.table.tableName);
          readStats.cacheHits += 1;
        }
        const remaining: ResolvedTable[] = [];
        for (const table of tables) {
          if (snapshots.has(table.tableName)) continue;
          const snapshot = this.cachedSnapshotFrom(
            table,
            this.freshCacheEntries(table, queries, identities),
          );
          if (snapshot === null) {
            remaining.push(table);
          } else {
            snapshots.set(table.tableName, snapshot);
            cacheHitTables.add(table.tableName);
            readStats.cacheHits += 1;
          }
        }
        if (remaining.length > 0) {
          const loaded = this.readSnapshotGroup(
            spreadsheetId,
            remaining,
            queries,
            identities,
            readStats,
          );
          for (const [tableName, item] of loaded) snapshots.set(tableName, item.snapshot);
        }
      }
    } catch (error) {
      const unresolved = [...identities.values()].filter((identity) =>
        !snapshots.has(identity.tableName),
      );
      if (
        !isQuotaFailure(error) ||
        unresolved.length === 0 ||
        unresolved.some((identity) => !staleCandidates.has(identity.tableName))
      ) {
        throw error;
      }
      for (const identity of unresolved) {
        const stale = staleCandidates.get(identity.tableName)!;
        resolved.set(identity.tableName, stale.resolved);
        snapshots.set(identity.tableName, stale);
        staleHitTables.add(identity.tableName);
        readStats.staleCacheHits += 1;
      }
    }

    const deferredEntries = this.pendingDeferredEntries();
    const selections: Record<string, Selection<Record<string, unknown>>> = {};
    const plans: Record<string, ExecutionPlan> = {};
    for (const [name, query] of Object.entries(queries)) {
      const queryStats = cloneStats(readStats);
      const baseSnapshot = this.requireSnapshot(snapshots, query.plan.table);
      const baseRows = this.applyDeferredOverlay(baseSnapshot, deferredEntries);
      let materialized = [...(query.overlayRows?.(query.plan.table, baseRows) ?? baseRows)];

      if (query.plan.predicate !== undefined) {
        materialized = materialized.filter((item) => evaluatePredicate(query.plan.predicate!, item.value));
      }
      for (const predicate of query.localPredicates) {
        materialized = materialized.filter((item) => predicate(item.value));
      }

      for (const join of query.plan.joins) {
        const target = this.requireSnapshot(snapshots, join.table);
        const deferredTargetRows = this.applyDeferredOverlay(target, deferredEntries);
        const targetRows = query.overlayRows?.(join.table, deferredTargetRows) ?? deferredTargetRows;
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
          queryStats.joinFanOut += Math.max(0, matches.length - 1);
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
              relationLocalFields: {
                ...(base.provenance.relationLocalFields ?? {}),
                [join.alias]: Object.freeze([...localFields]),
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

      const outputProjection = query.plan.projection === undefined
        ? undefined
        : [...new Set([
            ...query.plan.projection,
            ...query.plan.joins
              .filter((join) => join.kind !== "semi" && join.kind !== "anti")
              .map((join) => join.alias),
          ])];
      if (outputProjection !== undefined) {
        materialized = materialized.map((item) => ({
          value: projectRow(item.value, outputProjection),
          provenance: item.provenance,
        }));
      }
      queryStats.elapsedMs = Date.now() - startedAt;
      const queryTables = [query.plan.table, ...query.plan.joins.map((join) => join.table)];
      const executionMode = queryTables.every((tableName) =>
        cacheHitTables.has(tableName) || staleHitTables.has(tableName),
      )
        ? "cache" as const
        : boundedQueries.has(name)
          ? "bounded" as const
          : "full-scan" as const;
      if (executionMode === "full-scan") queryStats.fullScans += 1;
      const headers = materialized.length > 0
        ? Object.keys(materialized[0].value)
        : [...(outputProjection ?? Object.keys(this.table(query.plan.table).columns))];
      selections[name] = new Selection(
        materialized,
        headers,
        queryStats,
        this,
        query.refresh,
      );
      plans[name] = this.explain(
        query,
        executionMode,
        queryStats.rangesRead,
        queryTables.filter((tableName) => staleHitTables.has(tableName)),
      );
    }
    return { selections, plans };
  }

  public explain<T extends Record<string, unknown>>(
    query: ExecutableQuery<T>,
    executedMode?: "cache" | "bounded" | "full-scan",
    executedRanges: readonly string[] = [],
    staleTables: readonly string[] = [],
  ): ExecutionPlan {
    const tables = [query.plan.table, ...query.plan.joins.map((join) => join.table)];
    const sourceIds = new Set<string>();
    const steps: ExecutionPlan["steps"][number][] = [];
    const mode = executedMode ?? (this.canPlanBounded(query) ? "bounded" : "full-scan");
    for (const tableName of tables) {
      const definition = this.table(tableName);
      const sourceId = this.sourceIdentity(definition.source);
      sourceIds.add(sourceId);
      if (mode === "cache") {
        steps.push({
          kind: "cache-read",
          source: sourceId,
          table: tableName,
          ranges: [],
          detail: staleTables.includes(tableName)
            ? "Validated stale snapshot used after a Sheets quota failure."
            : "Validated generation-keyed snapshot cache hit.",
        });
      } else if (mode === "bounded" && tableName === query.plan.table) {
        steps.push({
          kind: "locator-read",
          source: sourceId,
          table: tableName,
          ranges: executedMode === "bounded" ? [...executedRanges] : [],
          columns: [...(this.indexForQuery(query)?.fields ?? [])],
          detail: executedMode === "bounded"
            ? "Executed indexed locator verification and targeted row reads."
            : "Indexed locator verification and targeted row reads are available after execution.",
        });
      } else {
        steps.push({
          kind: "range-read",
          source: sourceId,
          table: tableName,
          ranges: [sheetRange(definition.sheet)],
          columns: Object.keys(definition.columns),
          detail: "Unbounded table scan; execution batches this range with other tables in the workbook.",
        });
      }
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
    const warnings: ExecutionPlan["warnings"][number][] = mode === "full-scan" ? [{
      code: "FULL_SCAN",
      table: query.plan.table,
      message: "This query currently requires an unbounded table scan.",
    }] : [];
    if (query.localPredicates.length > 0) {
      warnings.push({
        code: "LOCAL_FILTER",
        table: query.plan.table,
        message: "whereLocal callbacks cannot be persistently fingerprinted or query-cached.",
      });
    }
    if (
      query.plan.predicate !== undefined &&
      query.localPredicates.length === 0 &&
      this.indexForQuery(query) === null
    ) {
      warnings.push({
        code: "UNINDEXED_PREDICATE",
        table: query.plan.table,
        message: "The typed predicate is not covered by a declared primary, unique, or cache index.",
      });
    }
    for (const join of query.plan.joins) {
      if (join.cardinality !== "many") continue;
      warnings.push({
        code: "JOIN_FANOUT",
        table: join.table,
        message: `Join ${join.alias} may materialize multiple related rows per base row.`,
      });
    }
    for (const tableName of staleTables) {
      warnings.push({
        code: "STALE_CACHE",
        table: tableName,
        message: "A stale cache snapshot was used because the Sheets API was quota-limited.",
      });
    }
    return {
      mode,
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
    const selectedMaterialized = selection[SELECTION_INTERNAL].materialized;
    if (selectedMaterialized.length === 0) return this.emptyMutation(selection);
    if (options.delivery === "deferred") {
      return this.deferUpdate(selection, patch, options);
    }
    this.assertNoDeferredOverlayRows(
      selectedMaterialized as readonly MaterializedRow<Record<string, unknown>>[],
      "apply an immediate update",
    );
    const hydrationStats = createExecutionStats();
    const materialized = this.hydrateMaterializedRows(
      selectedMaterialized as readonly MaterializedRow<Record<string, unknown>>[],
      hydrationStats,
    ) as readonly MaterializedRow<T>[];
    this.assertSingleMutationTable(materialized);
    const definition = this.table(materialized[0].provenance.tableName);
    if (definition.appendOnly) {
      throw new GQueryRuntimeError("MUTATION_INVALID", `Table ${materialized[0].provenance.tableName} is append-only.`);
    }

    const prepared: PreparedUpdate[] = [];
    for (const item of materialized) {
      const physicalBefore = this.physicalRowValue(item);
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
      const changedKeys = Object.keys(changeRecord).filter(
        (field) => !sameLogical(physicalBefore[field], changeRecord[field]),
      );
      const primaryChanges = changedKeys.filter((field) => definition.primaryKey.includes(field));
      if (primaryChanges.length > 0) {
        throw new GQueryRuntimeError("MUTATION_INVALID", `Primary key columns cannot be updated in place: ${primaryChanges.join(", ")}.`);
      }
      const cellPatches: CellPatch[] = [];
      const nextValue: Record<string, unknown> = { ...physicalBefore };
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
        before: {
          value: physicalBefore,
          provenance: item.provenance,
        },
        after: {
          value: nextValue,
          provenance: cloneProvenance(item.provenance, {
            version: nextVersion,
            originalEncoded: nextEncoded,
          }),
        },
        patches: cellPatches,
        changedFields: changedKeys,
      });
    }

    const preflight = this.preflight(materialized as readonly MaterializedRow<Record<string, unknown>>[]);
    const constraints = this.validateWriteConstraints(prepared, [], []);
    const validationStats = mutableStats(hydrationStats);
    addStats(validationStats, preflight.stats);
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
        const workbookPrepared = prepared.filter(
          (item) => item.before.provenance.spreadsheetId === spreadsheetId,
        );
        const valueMutations = compactCellUpdates(patches);
        const mutations = [...valueMutations, ...this.formatMutations(workbookPrepared)];
        this.options.transport.atomicBatchUpdate(spreadsheetId, mutations);
        stats.apiCalls += 1;
        stats.cellsWritten += patches.length;
        stats.bytesWritten += estimateBytes(patches);
        stats.rangesWritten.push(...valueMutations.map((mutation) => cellRange(
          this.sheetName(spreadsheetId, mutation.sheetId),
          mutation.startRowIndex,
          mutation.startColumnIndex,
          mutation.values.length,
          mutation.values[0]?.length ?? 1,
        )));
      }
      this.invalidateMaterialized(materialized as readonly MaterializedRow<Record<string, unknown>>[]);
    }
    const afterMaterialized = prepared.map((item, index) => invalidateChangedRelations({
      value: projectRow(
        {
          ...materialized[index].value,
          ...item.after.value,
        },
        selection.headers,
      ) as T,
      provenance: item.after.provenance,
    }, item.changedFields));
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
    this.assertNoDeferredOverlayRows(
      materialized as readonly MaterializedRow<Record<string, unknown>>[],
      "apply an immediate delete",
    );
    this.assertSingleMutationTable(materialized);
    const relational = this.planReferentialDelete(
      materialized.map((item) => ({
        value: this.physicalRowValue(item),
        provenance: item.provenance,
      })),
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
    const mutations: AtomicMutation[] = [
      ...updates,
      ...this.formatMutations(preparedSetNulls),
      ...deletes,
    ];
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

  /** Queue a caller-keyed create/upsert without opening the spreadsheet. */
  public deferKeyedWrite(
    tableName: string,
    row: Readonly<Record<string, unknown>>,
    kind: "create" | "upsert",
    options: Pick<MutationOptions, "idempotencyKey" | "actor">,
  ): MutationResult<Record<string, unknown>> {
    const journal = this.options.deferredJournal;
    if (journal === undefined) {
      throw new GQueryRuntimeError(
        "UNSUPPORTED_OPERATION",
        "Deferred delivery is not configured for this GQuery instance.",
      );
    }
    if (!options.idempotencyKey) {
      throw new GQueryRuntimeError(
        "MUTATION_INVALID",
        `Deferred ${kind} requires idempotencyKey.`,
      );
    }
    const definition = this.table(tableName);
    if (definition.primaryKey.length === 0) {
      throw new GQueryRuntimeError(
        "MUTATION_INVALID",
        `Deferred ${kind} requires a declared primary key.`,
      );
    }
    if (kind === "upsert" && definition.appendOnly) {
      throw new GQueryRuntimeError(
        "MUTATION_INVALID",
        `Append-only table ${tableName} cannot accept deferred upserts.`,
      );
    }
    const unknown = Object.keys(row).filter((field) => !(field in definition.columns));
    if (unknown.length > 0) {
      throw new GQueryRuntimeError(
        "MUTATION_INVALID",
        `Unknown deferred ${kind} columns: ${unknown.join(", ")}.`,
      );
    }
    const encoded: Record<string, SheetCellValue> = {};
    for (const [field, column] of Object.entries(definition.columns as ColumnMap)) {
      encoded[field] = storedSheetValue(toSheetInput(column.encode(row[field], {
        table: tableName,
        column: field,
        header: column.header ?? field,
      }) as EncodedCell));
    }
    const key = Object.fromEntries(definition.primaryKey.map((field) => [field, encoded[field]]));
    const enqueued = journal.enqueue({
      sourceId: this.spreadsheetId(definition.source),
      table: tableName,
      kind,
      key,
      values: encoded,
      expectedVersion: null,
      actor: options.actor,
      idempotencyKey: options.idempotencyKey,
    });
    const status = enqueued.receipt.status === "committed"
      ? "committed"
      : enqueued.receipt.status === "conflicted"
        ? "conflicted"
        : "queued";
    return {
      status,
      matchedCount: kind === "upsert" ? 1 : 0,
      changedCount: status === "conflicted" ? 0 : 1,
      changedCells: 0,
      conflicts: [],
      stats: createExecutionStats(),
      receipt: {
        id: enqueued.receipt.mutationId,
        idempotencyKey: enqueued.receipt.idempotencyKey,
        queuedAt: new Date(enqueued.receipt.createdAtMs).toISOString(),
        operation: kind,
        table: tableName,
        keys: [Object.fromEntries(definition.primaryKey.map((field) => [field, row[field]]))],
      },
    };
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
    return this.scoped(() => this.commitUnitOfWorkUnscoped(intents, constraintSnapshots, false));
  }

  /**
   * Internal deferred-flush hook. The caller must hold the participating-writer
   * lock and must have obtained every selection from a cache-bypassing physical
   * batch read immediately before this call. That read is the targeted version
   * preflight, so repeating it here would double the Sheets read traffic without
   * providing compare-and-set semantics (which Sheets does not expose).
   */
  public commitUnitOfWorkAfterPhysicalRead(
    intents: readonly UnitOfWorkIntent[],
    constraintSnapshots: readonly WriteConstraintSnapshot[] = [],
  ): UnitOfWorkCommitResult {
    return this.scoped(() => this.commitUnitOfWorkUnscoped(intents, constraintSnapshots, true));
  }

  private commitUnitOfWorkUnscoped(
    intents: readonly UnitOfWorkIntent[],
    constraintSnapshots: readonly WriteConstraintSnapshot[],
    physicalReadIsPreflight: boolean,
  ): UnitOfWorkCommitResult {
    const selections = intents
      .filter((intent): intent is Extract<UnitOfWorkIntent, { kind: "update" | "delete" }> => intent.kind !== "append")
      .flatMap((intent) => intent.selection[SELECTION_INTERNAL].materialized) as readonly MaterializedRow<Record<string, unknown>>[];
    this.assertNoDeferredOverlayRows(selections, "commit a unit-of-work mutation");
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
    const preparationStats = createExecutionStats();
    for (const intent of intents) {
      if (intent.kind === "update") {
        const selected = intent.selection[SELECTION_INTERNAL]
          .materialized as readonly MaterializedRow<Record<string, unknown>>[];
        const materialized = this.hydrateMaterializedRows(selected, preparationStats);
        const prepared = this.prepareUpdates(materialized, intent.patch);
        explicitPreparedUpdates.push(...prepared);
        for (const item of prepared) {
          valueOverrides.set(materializedIdentity(item.before), item.after.value);
        }
      } else if (intent.kind === "delete") {
        explicitDeletes.push(
          ...(intent.selection[SELECTION_INTERNAL]
            .materialized as readonly MaterializedRow<Record<string, unknown>>[])
            .map((item) => ({
              value: this.physicalRowValue(item),
              provenance: item.provenance,
            })),
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
    const preflight = physicalReadIsPreflight || preflightRows.length === 0
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
      addStats(stats, preparationStats);
      addStats(stats, preflight.stats);
      addStats(stats, constraints.stats);
      for (const { prepared } of preparedAppends) addStats(stats, prepared.stats);
      return { status: "conflicted", conflicts, workbooks: [], stats };
    }

    const byWorkbook = new Map<string, AtomicMutation[]>();
    const touched = new Map<string, Set<string>>();
    const stats = mutableStats(relational.stats);
    addStats(stats, preparationStats);
    addStats(stats, preflight.stats);
    addStats(stats, constraints.stats);
    for (const [spreadsheetId, patches] of this.groupPatchesBySpreadsheet(preparedUpdates)) {
      const mutations = byWorkbook.get(spreadsheetId) ?? [];
      mutations.push(...compactCellUpdates(patches));
      mutations.push(...this.formatMutations(preparedUpdates.filter(
        (item) => item.before.provenance.spreadsheetId === spreadsheetId,
      )));
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
        // A same-workbook request is one atomic Sheets operation, not a saga.
        // Preserve typed ambiguous-commit and deterministic transport failures
        // so callers never mistake an unknown/failed commit for a receipt.
        if (byWorkbook.size === 1) throw error;
        failed = true;
        receipts.push({ spreadsheetId, status: "failed", requestCount: mutations.length, error });
      }
    }
    return {
      status: failed ? "partial" : "committed",
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
    for (const key of [...this.knownSheets.keys()]) {
      if (key.startsWith(`${spreadsheetId}\u0000`)) this.knownSheets.delete(key);
    }
    for (const key of [...this.knownSheetTitles.keys()]) {
      if (key.startsWith(`${spreadsheetId}\u0000`)) this.knownSheetTitles.delete(key);
    }
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
    const scope = this.options.executionScope;
    if (scope === undefined) return operation();
    const before = scope.retryCount?.() ?? 0;
    const result = scope.run(operation);
    const retries = Math.max(0, (scope.retryCount?.() ?? before) - before);
    return this.attachRetryStats(result, retries);
  }

  private attachRetryStats<T>(result: T, retries: number): T {
    if (retries === 0 || result === null || typeof result !== "object") return result;
    const record = result as Record<string, unknown>;
    if (record.selections !== null && typeof record.selections === "object") {
      const selections = Object.fromEntries(Object.entries(
        record.selections as Record<string, Selection<Record<string, unknown>>>,
      ).map(([name, selection]) => {
        const internal = selection[SELECTION_INTERNAL];
        return [name, new Selection(
          internal.materialized,
          selection.headers,
          { ...selection.stats, retries: selection.stats.retries + retries },
          internal.runtime,
          internal.refresh,
          internal.fanoutRequired,
        )];
      }));
      return { ...record, selections } as T;
    }
    if (record.stats !== null && typeof record.stats === "object") {
      const stats = record.stats as ExecutionStats;
      return {
        ...record,
        stats: { ...stats, retries: stats.retries + retries },
      } as T;
    }
    return result;
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
    const changedFields = Object.keys(logical);
    const afterMaterialized = materialized.map((current) => {
      const existingOverlay = current.provenance.deferredOverlay;
      return invalidateChangedRelations({
        value: { ...current.value, ...logical },
        provenance: cloneProvenance(current.provenance, {
          deferredOverlay: {
            mutationIds: [
              ...(existingOverlay?.mutationIds ?? []),
              enqueued.receipt.mutationId,
            ],
            fields: [...new Set([
              ...(existingOverlay?.fields ?? []),
              ...changedFields,
            ])],
            virtual: existingOverlay?.virtual ?? false,
          },
        }),
      }, changedFields);
    });
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
      const physicalBefore = this.physicalRowValue(item);
      const mutable = { ...item.value };
      const returned = typeof patch === "function" ? patch(mutable) : patch;
      const changes = baseMutationChanges(
        item.value,
        definition,
        (typeof patch === "function" && returned === undefined ? mutable : returned) as Record<string, unknown>,
        typeof patch === "function",
      );
      const changedKeys = Object.keys(changes).filter(
        (field) => !sameLogical(physicalBefore[field], changes[field]),
      );
      const primaryChanges = changedKeys.filter((field) => definition.primaryKey.includes(field));
      if (primaryChanges.length > 0) throw new GQueryRuntimeError("MUTATION_INVALID", `Primary key columns cannot be updated in place: ${primaryChanges.join(", ")}.`);
      const patches: CellPatch[] = [];
      const nextValue = { ...physicalBefore };
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
        before: { value: physicalBefore, provenance: item.provenance },
        after: {
          value: nextValue,
          provenance: cloneProvenance(item.provenance, { version, originalEncoded: nextEncoded }),
        },
        patches,
        changedFields: changedKeys,
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
        resolved.set(edge.dependentTable, this.resolveTable(edge.dependentTable, stats));
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
    const stats = createExecutionStats();
    const resolved = this.resolveTable(tableName, stats);
    const cacheKey = `${resolved.spreadsheetId}:${resolved.definition.sheet}`;
    let header = this.headers.get(cacheKey);
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
            relation.kind === "belongs-to" && changed(asArray(relation.local))
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
        if (relation.kind !== "belongs-to") continue;
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
        if (relation.kind !== "belongs-to") continue;
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
          const blanks = localValues.map(
            (value) => value === null || value === undefined || value === "",
          );
          if (!relation.required && blanks.some(Boolean)) continue;
          const missing = blanks.some(Boolean) ||
            !targets.has(canonicalStringify(localValues));
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
      this.resolveTable(tableName, stats)
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
      const allowLegacy = !this.options.canonicalState?.isStrictCanonical(spreadsheetId);
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
              allowLegacy,
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

  private pendingDeferredEntries(): readonly PendingDeferredMutation[] {
    if (this.deferredOverlaySuppression > 0) return [];
    const overlay = this.options.deferredOverlay;
    if (overlay !== undefined) {
      try {
        const cached = overlay.read();
        if (cached !== null) return cached;
      } catch {
        // CacheService is an optimization; the durable journal is authoritative.
      }
    }
    return this.options.deferredJournal?.readAndRebuildOverlay() ?? [];
  }

  /** Merge the durable queued state before predicates and joins are evaluated. */
  private applyDeferredOverlay(
    snapshot: TableSnapshot,
    entries: readonly PendingDeferredMutation[],
  ): readonly MaterializedRow<Record<string, unknown>>[] {
    const relevant = entries
      .filter((entry) =>
        entry.sourceId === snapshot.resolved.spreadsheetId &&
        entry.table === snapshot.resolved.tableName
      )
      .sort((left, right) => left.sequence - right.sequence);
    if (relevant.length === 0) return snapshot.rows;

    const definition = snapshot.resolved.definition;
    const allowLegacy = !this.options.canonicalState?.isStrictCanonical(snapshot.resolved.spreadsheetId);
    const decodeRecord = (encoded: Readonly<Record<string, unknown>>): Record<string, unknown> => {
      const decoded: Record<string, unknown> = {};
      for (const [field, raw] of Object.entries(encoded)) {
        const column = definition.columns[field];
        if (column === undefined) {
          throw new GQueryRuntimeError(
            "MUTATION_INVALID",
            `Deferred overlay for ${snapshot.resolved.tableName} references unknown column ${field}.`,
          );
        }
        decoded[field] = column.decode(decodeCell(raw as SheetCellValue), {
          table: snapshot.resolved.tableName,
          column: field,
          header: column.header ?? field,
          allowLegacy,
        });
      }
      return decoded;
    };

    const rows = [...snapshot.rows];
    for (const entry of relevant) {
      const logicalKey = decodeRecord(entry.key);
      const fingerprint = keyFingerprint(logicalKey, definition.primaryKey);
      const rowIndex = rows.findIndex(
        (row) => keyFingerprint(row.value, definition.primaryKey) === fingerprint,
      );
      if (entry.kind === "delete") {
        if (rowIndex >= 0) rows.splice(rowIndex, 1);
        continue;
      }

      const logicalValues = decodeRecord(entry.values ?? {});
      if (rowIndex >= 0) {
        if (entry.kind === "create") continue;
        const current = rows[rowIndex];
        const existingOverlay = current.provenance.deferredOverlay;
        const changedFields = Object.keys(entry.values ?? {});
        rows[rowIndex] = {
          value: Object.freeze({ ...current.value, ...logicalValues }),
          provenance: cloneProvenance(current.provenance, {
            originalEncoded: {
              ...current.provenance.originalEncoded,
              ...(entry.values as Readonly<Record<string, SheetCellValue>> | undefined),
            },
            deferredOverlay: {
              mutationIds: [...(existingOverlay?.mutationIds ?? []), entry.id],
              fields: [...new Set([...(existingOverlay?.fields ?? []), ...changedFields])],
              virtual: existingOverlay?.virtual ?? false,
            },
          }),
        };
        continue;
      }
      if (entry.kind === "patch") continue;

      const value = Object.freeze({ ...logicalKey, ...logicalValues });
      const primaryKey = Object.fromEntries(
        definition.primaryKey.map((field) => [field, value[field]]),
      );
      rows.push({
        value,
        provenance: Object.freeze({
          sourceName: snapshot.resolved.sourceName,
          spreadsheetId: snapshot.resolved.spreadsheetId,
          tableName: snapshot.resolved.tableName,
          sheetName: definition.sheet,
          sheetId: snapshot.resolved.sheet.sheetId,
          rowIndex: -(entry.sequence + 1),
          primaryKey: Object.freeze(primaryKey),
          encodedPrimaryKey: Object.freeze({ ...entry.key } as Record<string, SheetCellValue>),
          version: null,
          originalEncoded: Object.freeze({
            ...entry.key,
            ...(entry.values ?? {}),
          } as Record<string, SheetCellValue>),
          columnIndexes: snapshot.header.logicalToPhysical,
          headerFingerprint: snapshot.header.fingerprint,
          readAt: this.now().toISOString(),
          relations: Object.freeze({}),
          relationCardinalities: Object.freeze({}),
          relationLocalFields: Object.freeze({}),
          deferredOverlay: Object.freeze({
            mutationIds: Object.freeze([entry.id]),
            fields: Object.freeze([...new Set([
              ...Object.keys(entry.key),
              ...Object.keys(entry.values ?? {}),
            ])]),
            virtual: true,
          }),
        }),
      });
    }
    return Object.freeze(rows);
  }

  private table(tableName: string): TableDefinition {
    const table = (this.schema.tables as TableMap)[tableName];
    if (table === undefined) throw new GQueryRuntimeError("INVALID_QUERY", `Unknown table ${tableName}.`);
    return table;
  }

  /**
   * Projected selections intentionally retain only the encoded columns that
   * were read. Before a write needs the complete prior row, fetch just the
   * missing column blocks for the already matched physical rows. This preserves
   * selection reuse without repeating the original predicate scan.
   */
  private hydrateMaterializedRows<T extends Record<string, unknown>>(
    materialized: readonly MaterializedRow<T>[],
    stats: ExecutionStats,
  ): readonly MaterializedRow<T>[] {
    const readsByWorkbook = new Map<string, RowHydrationRead[]>();
    for (const rawItem of materialized) {
      const item = rawItem as unknown as MaterializedRow<Record<string, unknown>>;
      const definition = this.table(item.provenance.tableName);
      const missingIndexes = Object.keys(definition.columns)
        .filter((field) =>
          !Object.prototype.hasOwnProperty.call(item.provenance.originalEncoded, field)
        )
        .map((field) => item.provenance.columnIndexes[field])
        .sort((left, right) => left - right);
      let start: number | undefined;
      let end: number | undefined;
      const append = (): void => {
        if (start === undefined || end === undefined) return;
        const reads = readsByWorkbook.get(item.provenance.spreadsheetId) ?? [];
        reads.push({
          item,
          startColumnIndex: start,
          endColumnIndex: end,
          range: cellRange(
            item.provenance.sheetName,
            item.provenance.rowIndex,
            start,
            1,
            end - start + 1,
          ),
        });
        readsByWorkbook.set(item.provenance.spreadsheetId, reads);
      };
      for (const columnIndex of missingIndexes) {
        if (start === undefined) {
          start = columnIndex;
          end = columnIndex;
        } else if (columnIndex === end! + 1) {
          end = columnIndex;
        } else {
          append();
          start = columnIndex;
          end = columnIndex;
        }
      }
      append();
    }
    if (readsByWorkbook.size === 0) return materialized;

    const hydrated = new Map<string, Record<string, SheetCellValue>>();
    for (const [spreadsheetId, reads] of readsByWorkbook) {
      const response = this.options.transport.batchGet(
        spreadsheetId,
        reads.map((read) => read.range),
        {
          valueRenderOption: reads.some((read) =>
            tableUsesFormula(this.table(read.item.provenance.tableName))
          ) ? "FORMULA" : "UNFORMATTED_VALUE",
          dateTimeRenderOption: "SERIAL_NUMBER",
        },
      );
      stats.apiCalls += 1;
      stats.rangesRead.push(...reads.map((read) => read.range));
      stats.cellsRead += response.valueRanges.reduce(
        (total, valueRange) =>
          total + valueRange.values.reduce((sum, row) => sum + row.length, 0),
        0,
      );
      stats.bytesRead += estimateBytes(response.valueRanges);
      reads.forEach((read, readIndex) => {
        const definition = this.table(read.item.provenance.tableName);
        const byPhysical = new Map(
          Object.keys(definition.columns).map((field) => [
            read.item.provenance.columnIndexes[field],
            field,
          ]),
        );
        const identity = materializedIdentity(read.item);
        const encoded = hydrated.get(identity) ?? {
          ...read.item.provenance.originalEncoded,
        };
        const values = response.valueRanges[readIndex]?.values[0] ?? [];
        for (
          let columnIndex = read.startColumnIndex;
          columnIndex <= read.endColumnIndex;
          columnIndex += 1
        ) {
          const field = byPhysical.get(columnIndex);
          if (field !== undefined) {
            encoded[field] = rawCell(values[columnIndex - read.startColumnIndex]);
          }
        }
        hydrated.set(identity, encoded);
      });
    }

    return materialized.map((rawItem) => {
      const item = rawItem as unknown as MaterializedRow<Record<string, unknown>>;
      const encoded = hydrated.get(materializedIdentity(item));
      if (encoded === undefined) return rawItem;
      return {
        value: rawItem.value,
        provenance: cloneProvenance(rawItem.provenance, {
          originalEncoded: Object.freeze(encoded),
        }),
      };
    });
  }

  /** Rebuild the complete decoded table row retained by encoded provenance. */
  private physicalRowValue(
    item: MaterializedRow<Record<string, unknown>>,
  ): Record<string, unknown> {
    const definition = this.table(item.provenance.tableName);
    const value: Record<string, unknown> = {};
    const allowLegacy = !this.options.canonicalState?.isStrictCanonical(item.provenance.spreadsheetId);
    for (const [field, column] of Object.entries(definition.columns as ColumnMap)) {
      if (Object.prototype.hasOwnProperty.call(item.provenance.originalEncoded, field)) {
        value[field] = column.decode(decodeCell(item.provenance.originalEncoded[field]), {
          table: item.provenance.tableName,
          column: field,
          header: column.header ?? field,
          rowNumber: item.provenance.rowIndex + 1,
          allowLegacy,
        });
      } else if (Object.prototype.hasOwnProperty.call(item.value, field)) {
        value[field] = item.value[field];
      }
    }
    return value;
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

  private tableIdentity(tableName: string): TableIdentity {
    const definition = this.table(tableName);
    const spreadsheetId = this.spreadsheetId(definition.source);
    return {
      tableName,
      definition,
      sourceName: definition.source,
      spreadsheetId,
    };
  }

  private resolveTable(tableName: string, stats?: ExecutionStats): ResolvedTable {
    return this.resolveIdentity(this.tableIdentity(tableName), stats);
  }

  private resolveIdentity(identity: TableIdentity, stats?: ExecutionStats): ResolvedTable {
    const { tableName, definition, spreadsheetId } = identity;
    let sheets = this.metadata.get(spreadsheetId);
    if (sheets === undefined) {
      const known = this.knownSheets.get(this.knownSheetKey(spreadsheetId, definition.sheet));
      if (known !== undefined) return { ...identity, sheet: known };
      sheets = this.options.transport.getSpreadsheetMetadata(spreadsheetId).sheets;
      if (stats !== undefined) stats.apiCalls += 1;
      this.metadata.set(spreadsheetId, sheets);
      this.rememberSheets(spreadsheetId, sheets);
    }
    const sheet = sheets.find((candidate) => candidate.title === definition.sheet);
    if (sheet === undefined) {
      throw new GQueryRuntimeError(
        "SHEET_NOT_FOUND",
        `Table ${tableName} expects sheet ${definition.sheet}, but it does not exist.`,
        { details: { table: tableName, spreadsheetId, sheet: definition.sheet } },
      );
    }
    return { ...identity, sheet };
  }

  private parseCachedSnapshot(
    identity: TableIdentity,
    cached: CachedTableSnapshot,
  ): TableSnapshot | null {
    try {
      return this.parseCachedSnapshotValue(identity, cached);
    } catch {
      // A cache adapter may return malformed non-JSON values. Cache identity is
      // never authoritative, so unexpected access/coercion failures are misses.
      return null;
    }
  }

  private parseCachedSnapshotValue(
    identity: TableIdentity,
    cached: CachedTableSnapshot,
  ): TableSnapshot | null {
    if (
      cached.version !== 2 ||
      cached.spreadsheetId !== identity.spreadsheetId ||
      cached.tableName !== identity.tableName ||
      cached.range !== sheetRange(identity.definition.sheet) ||
      !this.validCachedSheet(cached.sheet, identity.definition.sheet) ||
      !Array.isArray(cached.values) ||
      !cached.values.every((row) => Array.isArray(row)) ||
      cached.values.length > cached.sheet.rowCount ||
      (cached.values[0]?.length ?? 0) > cached.sheet.columnCount
    ) {
      return null;
    }
    const rawHeaders = cached.values[0] ?? [];
    const headers = rawHeaders.map((value) =>
      typeof value === "string" ? value : String(value ?? "")
    );
    if (
      typeof cached.headerFingerprint !== "string" ||
      hashCanonical(headers) !== cached.headerFingerprint
    ) {
      return null;
    }
    const resolved: ResolvedTable = {
      ...identity,
      sheet: Object.freeze({ ...cached.sheet }),
    };
    try {
      const snapshot = this.parseSnapshot(
        resolved,
        cached.values,
        cached.range,
        undefined,
        true,
        false,
      );
      if (snapshot.header.fingerprint !== cached.headerFingerprint) return null;
      this.rememberSheets(identity.spreadsheetId, [resolved.sheet]);
      return snapshot;
    } catch {
      // Cache values and metadata are optional hints. Any schema/codec/header
      // mismatch falls back to authoritative Sheets reads below.
      return null;
    }
  }

  private validCachedSheet(sheet: SheetMetadata, expectedTitle: string): boolean {
    return (
      typeof sheet === "object" &&
      sheet !== null &&
      Number.isSafeInteger(sheet.sheetId) &&
      sheet.sheetId >= 0 &&
      sheet.title === expectedTitle &&
      Number.isSafeInteger(sheet.rowCount) &&
      sheet.rowCount >= 0 &&
      Number.isSafeInteger(sheet.columnCount) &&
      sheet.columnCount >= 0
    );
  }

  private cachedSheetMetadata(
    sheet: SheetMetadata,
    values: readonly (readonly SheetCellValue[])[],
  ): SheetMetadata {
    const observedColumns = values.reduce(
      (maximum, row) => Math.max(maximum, row.length),
      0,
    );
    return Object.freeze({
      ...sheet,
      rowCount: Math.max(sheet.rowCount, values.length),
      columnCount: Math.max(sheet.columnCount, observedColumns),
    });
  }

  private knownSheetKey(spreadsheetId: string, title: string): string {
    return `${spreadsheetId}\u0000${title}`;
  }

  private knownSheetIdKey(spreadsheetId: string, sheetId: number): string {
    return `${spreadsheetId}\u0000${sheetId}`;
  }

  private rememberSheets(spreadsheetId: string, sheets: readonly SheetMetadata[]): void {
    for (const sheet of sheets) {
      const copy = Object.freeze({ ...sheet });
      this.knownSheets.set(this.knownSheetKey(spreadsheetId, sheet.title), copy);
      this.knownSheetTitles.set(this.knownSheetIdKey(spreadsheetId, sheet.sheetId), sheet.title);
    }
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
    persistLocators = true,
    decodedFields?: readonly string[],
  ): TableSnapshot {
    const header = this.parseHeader(resolved, values[0] ?? []);
    const rows: MaterializedRow<Record<string, unknown>>[] = [];
    const seenPrimary = new Map<string, number>();
    const seenUnique = resolved.definition.unique.map(() => new Map<string, number>());
    const allowLegacy = !this.options.canonicalState?.isStrictCanonical(resolved.spreadsheetId);
    const requested = decodedFields === undefined ? null : new Set(decodedFields);
    for (let dataIndex = 1; dataIndex < values.length; dataIndex += 1) {
      const physical = values[dataIndex] ?? [];
      if (physical.every((value) => value === null || value === undefined || value === "")) continue;
      const decoded: Record<string, unknown> = {};
      const encoded: Record<string, SheetCellValue> = {};
      for (const [field, column] of Object.entries(resolved.definition.columns as ColumnMap)) {
        if (requested !== null && !requested.has(field)) continue;
        const index = header.logicalToPhysical[field];
        const physicalValue = physical[index];
        decoded[field] = column.decode(decodeCell(physicalValue), {
          table: resolved.tableName,
          column: field,
          header: column.header ?? field,
          rowNumber: dataIndex + 1,
          allowLegacy,
        });
        encoded[field] = rawCell(physicalValue);
      }
      if (
        resolved.definition.primaryKey.length > 0 &&
        resolved.definition.primaryKey.every((field) => requested === null || requested.has(field))
      ) {
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
        if (!key.every((field) => requested === null || requested.has(field))) return;
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
    this.registerLocators(resolved, header, rows, completeSnapshot, persistLocators);
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

  private cacheForTable(table: TableIdentity): RuntimeCacheAdapter | null {
    if (this.readCacheSuppression > 0) return null;
    const policy = table.definition.cache;
    if (policy === undefined) return null;
    return this.options.cacheForScope?.(policy.scope) ?? this.options.cache ?? null;
  }

  private queryCachePlansForTable(
    tableName: string,
    queries: Readonly<Record<string, ExecutableQuery<Record<string, unknown>>>>,
  ): readonly SerializableQueryPlan[] | null {
    const relevant = Object.values(queries).filter((query) =>
      query.plan.table === tableName || query.plan.joins.some((join) => join.table === tableName),
    );
    if (relevant.length === 0 || relevant.some((query) => query.localPredicates.length > 0)) return null;
    return Object.freeze(
      relevant
        .map((query) => query.plan)
        .sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right))),
    );
  }

  private queryCacheKey(
    table: TableIdentity,
    plans: readonly SerializableQueryPlan[],
    identities: ReadonlyMap<string, TableIdentity>,
    stale: boolean,
  ): Readonly<Record<string, unknown>> {
    const policy = table.definition.cache;
    if (policy === undefined) throw new Error("A query cache key requires a table cache policy.");
    const dependencyNames = new Set<string>();
    for (const plan of plans) {
      dependencyNames.add(plan.table);
      for (const join of plan.joins) dependencyNames.add(join.table);
    }
    const dependencyIdentities = [...dependencyNames]
      .map((name) => identities.get(name) ?? this.tableIdentity(name))
      .sort((left, right) => left.tableName.localeCompare(right.tableName));
    const generations: DependencyGeneration[] = [];
    if (!stale) {
      for (const dependency of dependencyIdentities) {
        generations.push({
          dependency: {
            kind: "table",
            sourceId: dependency.spreadsheetId,
            table: dependency.tableName,
          },
          token: this.options.generations?.current({
            kind: "table",
            sourceId: dependency.spreadsheetId,
            table: dependency.tableName,
          }) ?? "0",
        });
        for (const tag of dependency.definition.cache?.tags ?? []) {
          generations.push({
            dependency: { kind: "tag", tag },
            token: this.options.generations?.current({ kind: "tag", tag }) ?? "0",
          });
        }
      }
      generations.sort((left, right) =>
        canonicalStringify(left.dependency).localeCompare(canonicalStringify(right.dependency)),
      );
    }
    const headerRegistry = dependencyIdentities.map((dependency) => ({
      table: dependency.tableName,
      sheet: dependency.definition.sheet,
      versionColumn: dependency.definition.versionColumn ?? null,
      columns: Object.entries(dependency.definition.columns).map(([field, column]) => ({
        field,
        header: column.header ?? field,
        kind: column.kind,
      })),
    }));
    const key = buildQueryCacheKey({
      sourceIdentity: {
        cachedTable: table.tableName,
        dependencies: dependencyIdentities.map((dependency) => ({
          table: dependency.tableName,
          spreadsheetId: dependency.spreadsheetId,
          sheet: dependency.definition.sheet,
        })),
      },
      schemaVersion: this.schema.version,
      headerVersion: hashCanonical(headerRegistry),
      query: plans,
      projection: plans.flatMap((plan) => plan.projection ?? []),
      renderOptions: {
        valueRenderOption: tableUsesFormula(table.definition) ? "FORMULA" : "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      },
      scopeIdentity: {
        scope: policy.scope,
        identity: this.options.scopeIdentity?.(policy.scope) ?? null,
      },
      generations,
    });
    return stale ? { ...key, kind: "stale-query" } : key;
  }

  private freshCacheEntries(
    table: TableIdentity,
    queries: Readonly<Record<string, ExecutableQuery<Record<string, unknown>>>>,
    identities: ReadonlyMap<string, TableIdentity>,
  ): readonly SnapshotCacheEntry[] {
    const cache = this.cacheForTable(table);
    const policy = table.definition.cache;
    if (cache === null || policy === undefined) return [];
    const entries: SnapshotCacheEntry[] = [];
    const plans = this.queryCachePlansForTable(table.tableName, queries);
    if ((policy.mode === "query" || policy.mode === "row-and-query") && plans !== null) {
      entries.push({ cache, key: this.queryCacheKey(table, plans, identities, false) });
    }
    if (policy.mode === "row" || policy.mode === "row-and-query") {
      entries.push({ cache, key: this.tableCacheKey(table) });
    }
    return Object.freeze(entries);
  }

  private staleCacheEntries(
    table: TableIdentity,
    queries: Readonly<Record<string, ExecutableQuery<Record<string, unknown>>>>,
    identities: ReadonlyMap<string, TableIdentity>,
  ): readonly SnapshotCacheEntry[] {
    const cache = this.cacheForTable(table);
    const policy = table.definition.cache;
    if (cache === null || policy?.allowStaleOnQuota !== true) return [];
    const entries: SnapshotCacheEntry[] = [];
    const plans = this.queryCachePlansForTable(table.tableName, queries);
    if ((policy.mode === "query" || policy.mode === "row-and-query") && plans !== null) {
      entries.push({ cache, key: this.queryCacheKey(table, plans, identities, true) });
    }
    if (policy.mode === "row" || policy.mode === "row-and-query") {
      entries.push({ cache, key: this.staleTableCacheKey(table) });
    }
    return Object.freeze(entries);
  }

  private cachedSnapshotFrom(
    identity: TableIdentity,
    entries: readonly SnapshotCacheEntry[],
  ): TableSnapshot | null {
    for (const entry of entries) {
      let cached: ReturnType<RuntimeCacheAdapter["read"]>;
      try {
        cached = entry.cache.read<CachedTableSnapshot>(entry.key);
      } catch {
        continue;
      }
      if (cached.state !== "hit" || cached.value === undefined) continue;
      const snapshot = this.parseCachedSnapshot(identity, cached.value as CachedTableSnapshot);
      if (snapshot !== null) return snapshot;
    }
    return null;
  }

  private publishSnapshot(
    table: ResolvedTable,
    values: readonly (readonly SheetCellValue[])[],
    snapshot: TableSnapshot,
    entries: readonly SnapshotCacheEntry[],
    stale: boolean,
  ): void {
    if (entries.length === 0) return;
    const payload = this.snapshotPayload(table, values, snapshot);
    for (const entry of entries) {
      try {
        entry.cache.put(entry.key, payload, stale
          ? { ttlSeconds: 21_600 }
          : {
              ttlSeconds: table.definition.cache?.ttlSeconds,
              jitterSeconds: table.definition.cache?.jitterSeconds,
            });
      } catch {
        // Cache publication is an optimization. A valid Sheets response remains authoritative.
      }
    }
  }

  private snapshotPayload(
    table: ResolvedTable,
    values: readonly (readonly SheetCellValue[])[],
    snapshot: TableSnapshot,
  ): CachedTableSnapshot {
    return {
      version: 2,
      spreadsheetId: table.spreadsheetId,
      tableName: table.tableName,
      sheet: this.cachedSheetMetadata(table.sheet, values),
      headerFingerprint: snapshot.header.fingerprint,
      range: sheetRange(table.definition.sheet),
      values,
    } satisfies CachedTableSnapshot;
  }

  /**
   * Work out the smallest safe logical row shape shared by every query that
   * depends on this table. Cold reads remain complete because physical column
   * positions are schema data learned from the header row. Cache-backed reads
   * also remain complete so a partial matrix is never published as a table
   * snapshot.
   */
  private snapshotFieldsForQueries(
    table: ResolvedTable,
    queries: Readonly<Record<string, ExecutableQuery<Record<string, unknown>>>>,
  ): readonly string[] | null {
    const header = this.headers.get(`${table.spreadsheetId}:${table.definition.sheet}`);
    if (header === undefined || this.cacheForTable(table) !== null) return null;
    if (table.definition.primaryKey.length === 0) return null;

    const fields = new Set<string>();
    let relevant = false;
    for (const query of Object.values(queries)) {
      if (query.plan.table === table.tableName) {
        relevant = true;
        if (query.localPredicates.length > 0 || query.plan.projection === undefined) return null;
        collectPredicateFields(query.plan.predicate, fields);
        for (const field of query.plan.projection) {
          if (table.definition.columns[field] !== undefined) fields.add(field);
        }
        for (const order of query.plan.orderBy) {
          if (table.definition.columns[order.field] !== undefined) fields.add(order.field);
        }
        for (const join of query.plan.joins) {
          if (join.table === table.tableName) continue;
          for (const field of asArray(join.localField)) fields.add(field);
        }
      }

      for (const join of query.plan.joins) {
        if (join.table !== table.tableName) continue;
        relevant = true;
        for (const field of asArray(join.foreignField)) fields.add(field);
        if (join.kind === "semi" || join.kind === "anti") continue;
        if (join.select === undefined) return null;
        for (const field of join.select) fields.add(field);
      }
    }
    if (!relevant) return null;

    for (const field of table.definition.primaryKey) fields.add(field);
    for (const key of table.definition.unique) {
      for (const field of key) fields.add(field);
    }
    for (const key of table.definition.cache?.indexes ?? []) {
      for (const field of key) fields.add(field);
    }
    for (const relation of Object.values(table.definition.relations)) {
      for (const field of asArray((relation as RelationDefinition).local)) fields.add(field);
    }
    return Object.freeze(
      [...fields].sort((left, right) =>
        header.logicalToPhysical[left] - header.logicalToPhysical[right]
      ),
    );
  }

  private snapshotReadPlan(
    table: ResolvedTable,
    queries: Readonly<Record<string, ExecutableQuery<Record<string, unknown>>>>,
  ): SnapshotReadPlan {
    const fields = this.snapshotFieldsForQueries(table, queries);
    if (fields === null) {
      return {
        table,
        fields: null,
        blocks: Object.freeze([{
          startColumnIndex: 0,
          endColumnIndex: Math.max(0, table.sheet.columnCount - 1),
          range: sheetRange(table.definition.sheet),
        }]),
      };
    }

    const header = this.headers.get(`${table.spreadsheetId}:${table.definition.sheet}`)!;
    const indexes = new Set(fields.map((field) => header.logicalToPhysical[field]));
    if (table.definition.versionColumn !== undefined) {
      indexes.add(header.logicalToPhysical[table.definition.versionColumn]);
    }
    const ordered = [...indexes].sort((left, right) => left - right);
    const blocks: SnapshotColumnBlock[] = [];
    for (const columnIndex of ordered) {
      const previous = blocks[blocks.length - 1];
      if (previous !== undefined && previous.endColumnIndex + 1 === columnIndex) {
        blocks[blocks.length - 1] = {
          startColumnIndex: previous.startColumnIndex,
          endColumnIndex: columnIndex,
          range: sheetRange(
            table.definition.sheet,
            `${columnIndexToLetter(previous.startColumnIndex)}:${columnIndexToLetter(columnIndex)}`,
          ),
        };
      } else {
        const column = columnIndexToLetter(columnIndex);
        blocks.push({
          startColumnIndex: columnIndex,
          endColumnIndex: columnIndex,
          range: sheetRange(table.definition.sheet, `${column}:${column}`),
        });
      }
    }
    return { table, fields, blocks: Object.freeze(blocks) };
  }

  private partialSnapshotValues(
    plan: SnapshotReadPlan,
    ranges: readonly (readonly (readonly SheetCellValue[])[])[],
  ): readonly (readonly SheetCellValue[])[] {
    const header = this.headers.get(
      `${plan.table.spreadsheetId}:${plan.table.definition.sheet}`,
    );
    if (header === undefined || plan.fields === null) {
      throw new Error("A partial snapshot requires a validated header registry.");
    }
    const height = Math.max(1, ...ranges.map((values) => values.length));
    const matrix: SheetCellValue[][] = Array.from(
      { length: height },
      () => Array.from({ length: header.headers.length }, () => null),
    );
    matrix[0] = [...header.headers];
    plan.blocks.forEach((block, blockIndex) => {
      const values = ranges[blockIndex] ?? [];
      const width = block.endColumnIndex - block.startColumnIndex + 1;
      for (let offset = 0; offset < width; offset += 1) {
        const physicalIndex = block.startColumnIndex + offset;
        const actual = values[0]?.[offset];
        const expected = header.headers[physicalIndex] ?? "";
        if (String(actual ?? "") !== expected) {
          throw new GQueryRuntimeError(
            "SCHEMA_CHANGED",
            `Sheet ${plan.table.definition.sheet} headers changed after the column registry was loaded.`,
            {
              details: {
                table: plan.table.tableName,
                columnIndex: physicalIndex,
                expected,
                actual: String(actual ?? ""),
              },
            },
          );
        }
      }
      for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
        const source = values[rowIndex] ?? [];
        for (let offset = 0; offset < width; offset += 1) {
          matrix[rowIndex][block.startColumnIndex + offset] = rawCell(source[offset]);
        }
      }
    });
    return matrix;
  }

  private readSnapshotGroup(
    spreadsheetId: string,
    tables: readonly ResolvedTable[],
    queries: Readonly<Record<string, ExecutableQuery<Record<string, unknown>>>>,
    identities: ReadonlyMap<string, TableIdentity>,
    stats: ExecutionStats,
    excludedFreshEntry?: {
      readonly tableName: string;
      readonly key: Readonly<Record<string, unknown>>;
    },
  ): ReadonlyMap<string, LoadedSnapshot> {
    const plans = tables.map((table) => this.snapshotReadPlan(table, queries));
    const ranges = plans.flatMap((plan) => plan.blocks.map((block) => block.range));
    const response = this.options.transport.batchGet(spreadsheetId, ranges, {
      valueRenderOption: tables.some((table) => tableUsesFormula(table.definition))
        ? "FORMULA"
        : "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    stats.apiCalls += 1;
    const loaded = new Map<string, LoadedSnapshot>();
    let responseIndex = 0;
    for (const plan of plans) {
      const table = plan.table;
      const returned = plan.blocks.map(() =>
        response.valueRanges[responseIndex++]?.values ?? []
      );
      const values = plan.fields === null
        ? (returned[0] ?? [])
        : this.partialSnapshotValues(plan, returned);
      const actualCellsRead = returned.reduce(
        (total, valueRange) =>
          total + valueRange.reduce((sum, row) => sum + row.length, 0),
        0,
      );
      const actualBytesRead = estimateBytes(returned);
      const parsed = this.parseSnapshot(
        table,
        values,
        plan.blocks.map((block) => block.range).join(","),
        undefined,
        plan.fields === null,
        plan.fields === null,
        plan.fields ?? undefined,
      );
      const snapshot: TableSnapshot = {
        ...parsed,
        cellsRead: actualCellsRead,
        bytesRead: actualBytesRead,
      };
      stats.cellsRead += actualCellsRead;
      stats.bytesRead += actualBytesRead;
      stats.rangesRead.push(...plan.blocks.map((block) => block.range));
      const freshEntries = this.freshCacheEntries(table, queries, identities).filter((entry) =>
        excludedFreshEntry === undefined ||
        table.tableName !== excludedFreshEntry.tableName ||
        canonicalStringify(entry.key) !== canonicalStringify(excludedFreshEntry.key),
      );
      if (plan.fields === null) {
        this.publishSnapshot(table, values, snapshot, freshEntries, false);
        this.publishSnapshot(
          table,
          values,
          snapshot,
          this.staleCacheEntries(table, queries, identities),
          true,
        );
      }
      loaded.set(table.tableName, {
        snapshot,
        payload: this.snapshotPayload(table, values, snapshot),
      });
    }
    return loaded;
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

  private locatorCacheEntry(
    table: TableIdentity,
    fields: readonly string[],
  ): SnapshotCacheEntry | null {
    const policy = table.definition.cache;
    const cache = this.cacheForTable(table);
    if (
      cache === null ||
      policy === undefined ||
      (policy.mode !== "row" && policy.mode !== "row-and-query")
    ) {
      return null;
    }
    const generation = this.options.generations?.current({
      kind: "table",
      sourceId: table.spreadsheetId,
      table: table.tableName,
    }) ?? "0";
    return {
      cache,
      key: {
        kind: "locator-index",
        spreadsheetId: table.spreadsheetId,
        schemaVersion: this.schema.version,
        table: table.tableName,
        sheet: table.definition.sheet,
        fields,
        columns: fields.map((field) => {
          const column = table.definition.columns[field];
          return [field, column?.header ?? field, column?.kind ?? null];
        }),
        scope: policy.scope,
        scopeIdentity: this.options.scopeIdentity?.(policy.scope) ?? null,
        generation,
        tagGenerations: (policy.tags ?? []).map((tag) => ({
          tag,
          generation: this.options.generations?.current({ kind: "tag", tag }) ?? "0",
        })),
      },
    };
  }

  private hydratePersistentLocator<T extends Record<string, unknown>>(
    query: ExecutableQuery<T>,
    resolved: ResolvedTable,
    stats: ExecutionStats,
  ): void {
    const indexed = this.indexForQuery(query);
    if (indexed === null) return;
    const entry = this.locatorCacheEntry(resolved, indexed.fields);
    if (entry === null) return;
    let cached: { readonly state: "hit" | "miss" | "corrupt"; readonly value?: CachedLocatorIndex };
    try {
      cached = entry.cache.read<CachedLocatorIndex>(entry.key);
    } catch {
      return;
    }
    if (cached.state !== "hit" || cached.value === undefined) return;
    const payload = cached.value;
    try {
      if (
        payload.version !== 1 ||
        payload.spreadsheetId !== resolved.spreadsheetId ||
        payload.table !== resolved.tableName ||
        !this.validCachedSheet(payload.sheet, resolved.definition.sheet) ||
        payload.sheet.sheetId !== resolved.sheet.sheetId ||
        !Array.isArray(payload.headers) ||
        !payload.headers.every((header) => typeof header === "string") ||
        !Array.isArray(payload.fields) ||
        canonicalStringify(payload.fields) !== canonicalStringify(indexed.fields) ||
        hashCanonical(payload.headers) !== payload.headerFingerprint ||
        !Array.isArray(payload.entries)
      ) {
        return;
      }
      const header = this.parseHeader(resolved, payload.headers);
      if (header.fingerprint !== payload.headerFingerprint) return;
      const fingerprint = hashCanonical(indexed.fields.map((field) => indexed.values.get(field)));
      const cachedEntry = payload.entries.find(([key]) => key === fingerprint);
      // A locator cache is a hint, not a negative index. Out-of-band inserts
      // do not necessarily rotate GQuery's generation, so an absent key must
      // fall through to the authoritative narrow key-column scan.
      if (cachedEntry === undefined) return;
      const located = cachedEntry[1];
      if (
        !Array.isArray(located) ||
        !located.every((rowIndex) =>
          Number.isSafeInteger(rowIndex) && rowIndex > 0 && rowIndex < payload.sheet.rowCount,
        )
      ) {
        return;
      }
      this.locators.set(
        this.locatorKey(resolved, indexed.fields, Object.fromEntries(indexed.values)),
        Object.freeze([...located]),
      );
      stats.cacheHits += 1;
    } catch {
      // Invalid locator indexes are optional cache misses. The planner will use
      // a full snapshot and republish a validated generation below.
    }
  }

  private publishPersistentLocators(
    resolved: ResolvedTable,
    header: HeaderState,
    rows: readonly MaterializedRow<Record<string, unknown>>[],
  ): void {
    const indexes: readonly (readonly string[])[] = [
      resolved.definition.primaryKey,
      ...resolved.definition.unique,
      ...(resolved.definition.cache?.indexes ?? []),
    ];
    const seen = new Set<string>();
    for (const fields of indexes) {
      if (fields.length === 0) continue;
      const identity = canonicalStringify(fields);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const entry = this.locatorCacheEntry(resolved, fields);
      if (entry === null) continue;
      const entries = new Map<string, number[]>();
      for (const row of rows) {
        const fingerprint = hashCanonical(fields.map((field) => row.value[field]));
        const located = entries.get(fingerprint) ?? [];
        located.push(row.provenance.rowIndex);
        entries.set(fingerprint, located);
      }
      try {
        entry.cache.put(entry.key, {
          version: 1,
          spreadsheetId: resolved.spreadsheetId,
          table: resolved.tableName,
          sheet: Object.freeze({ ...resolved.sheet }),
          headerFingerprint: header.fingerprint,
          headers: header.headers,
          fields: Object.freeze([...fields]),
          entries: Object.freeze(
            [...entries.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([fingerprint, rowIndexes]) =>
                Object.freeze([fingerprint, Object.freeze([...rowIndexes])] as const),
              ),
          ),
        } satisfies CachedLocatorIndex, {
          ttlSeconds: resolved.definition.cache?.ttlSeconds,
          jitterSeconds: resolved.definition.cache?.jitterSeconds,
        });
      } catch {
        // A locator index is only a hint; narrow scans rebuild it after misses.
      }
    }
  }

  private canPlanBounded<T extends Record<string, unknown>>(
    query: ExecutableQuery<T>,
  ): boolean {
    if (this.indexForQuery(query) === null) return false;
    const definition = this.table(query.plan.table);
    const runtimeCacheConfigured = definition.cache !== undefined &&
      (this.options.cache !== undefined || this.options.cacheForScope !== undefined);
    if (runtimeCacheConfigured) return false;
    const source = this.source(definition.source);
    if (source.kind === "spreadsheet-id") {
      return this.headers.has(`${source.spreadsheetId}:${definition.sheet}`);
    }
    return [...this.headers.keys()].some((key) => key.endsWith(`:${definition.sheet}`));
  }

  private tryBoundedRead<T extends Record<string, unknown>>(
    query: ExecutableQuery<T>,
    resolved: ResolvedTable,
  ): BoundedReadResult | null {
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
    const decodedFields = this.snapshotFieldsForQueries(
      resolved,
      { bounded: query as unknown as ExecutableQuery<Record<string, unknown>> },
    );
    let rowIndexes = this.locators.get(locatorKey);
    if (rowIndexes === undefined) {
      rowIndexes = this.scanLocator(resolved, header, indexed.fields, encoded, stats);
      this.locators.set(locatorKey, rowIndexes);
    }
    let loaded = this.loadLocatedRows(
      resolved,
      header,
      indexed.fields,
      encoded,
      rowIndexes,
      stats,
      decodedFields ?? undefined,
    );
    if (loaded === null) {
      this.locators.delete(locatorKey);
      rowIndexes = this.scanLocator(resolved, header, indexed.fields, encoded, stats);
      this.locators.set(locatorKey, rowIndexes);
      loaded = this.loadLocatedRows(
        resolved,
        header,
        indexed.fields,
        encoded,
        rowIndexes,
        stats,
        decodedFields ?? undefined,
      );
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
    decodedFields?: readonly string[],
  ): TableSnapshot | null {
    if (rowIndexes.length === 0) {
      return this.parseSnapshot(
        resolved,
        [header.headers as readonly SheetCellValue[]],
        `${resolved.definition.sheet}:bounded-empty`,
        [],
        false,
        false,
        decodedFields,
      );
    }
    const blocks: readonly { readonly start: number; readonly end: number }[] =
      decodedFields === undefined
        ? [{ start: 0, end: Math.max(0, header.headers.length - 1) }]
        : (() => {
            const indexes = new Set(
              decodedFields.map((field) => header.logicalToPhysical[field]),
            );
            if (resolved.definition.versionColumn !== undefined) {
              indexes.add(header.logicalToPhysical[resolved.definition.versionColumn]);
            }
            const compacted: { start: number; end: number }[] = [];
            for (const index of [...indexes].sort((left, right) => left - right)) {
              const previous = compacted[compacted.length - 1];
              if (previous !== undefined && previous.end + 1 === index) previous.end = index;
              else compacted.push({ start: index, end: index });
            }
            return compacted;
          })();
    const ranges = rowIndexes.flatMap((rowIndex) => blocks.map((block) => cellRange(
      resolved.definition.sheet,
      rowIndex,
      block.start,
      1,
      block.end - block.start + 1,
    )));
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
    const rows = rowIndexes.map((_, rowOffset) => {
      const row: SheetCellValue[] = Array.from(
        { length: header.headers.length },
        () => null,
      );
      blocks.forEach((block, blockOffset) => {
        const values = response.valueRanges[rowOffset * blocks.length + blockOffset]
          ?.values[0] ?? [];
        for (let offset = 0; offset <= block.end - block.start; offset += 1) {
          row[block.start + offset] = rawCell(values[offset]);
        }
      });
      return row;
    });
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
      false,
      decodedFields,
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
    header: HeaderState,
    rows: readonly MaterializedRow<Record<string, unknown>>[],
    completeSnapshot: boolean,
    persistLocators: boolean,
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
        if (!fields.every((field) =>
          Object.prototype.hasOwnProperty.call(row.value, field)
        )) continue;
        const key = this.locatorKey(resolved, fields, row.value);
        const current = this.locators.get(key) ?? [];
        if (!current.includes(row.provenance.rowIndex)) {
          this.locators.set(key, Object.freeze([...current, row.provenance.rowIndex].sort((a, b) => a - b)));
        }
      }
    }
    if (completeSnapshot && persistLocators) {
      this.publishPersistentLocators(resolved, header, rows);
    }
  }

  private clearTableLocators(spreadsheetId: string, tableName: string): void {
    const prefix = `${spreadsheetId}:${tableName}:`;
    for (const key of [...this.locators.keys()]) {
      if (key.startsWith(prefix)) this.locators.delete(key);
    }
  }

  private tableCacheKey(table: TableIdentity): Readonly<Record<string, unknown>> {
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

  private staleTableCacheKey(table: TableIdentity): Readonly<Record<string, unknown>> {
    const key = this.tableCacheKey(table);
    return {
      ...key,
      kind: "stale-table-snapshot",
      generation: "stale",
      tagGenerations: (table.definition.cache?.tags ?? []).map((tag) => ({ tag })),
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

  private formatMutations(prepared: readonly PreparedUpdate[]): AtomicMutation[] {
    const mutations: AtomicMutation[] = [];
    for (const item of prepared) {
      const definition = this.table(item.before.provenance.tableName);
      for (const field of item.changedFields) {
        const format = definition.columns[field]?.format;
        if (format === undefined || Object.keys(format).length === 0) continue;
        mutations.push({
          kind: "formatCells",
          sheetId: item.before.provenance.sheetId,
          startRowIndex: item.before.provenance.rowIndex,
          startColumnIndex: item.before.provenance.columnIndexes[field],
          rowCount: 1,
          columnCount: 1,
          format,
        });
      }
    }
    return mutations;
  }

  private sheetName(spreadsheetId: string, sheetId: number): string {
    return this.metadata.get(spreadsheetId)?.find((sheet) => sheet.sheetId === sheetId)?.title ??
      this.knownSheetTitles.get(this.knownSheetIdKey(spreadsheetId, sheetId)) ??
      `sheetId:${sheetId}`;
  }

  private invalidateMaterialized(materialized: readonly MaterializedRow<Record<string, unknown>>[]): void {
    const tables = new Set<string>();
    for (const item of materialized) {
      const identity = `${item.provenance.spreadsheetId}:${item.provenance.tableName}`;
      if (!tables.has(identity)) {
        tables.add(identity);
        this.invalidateTable(item.provenance.spreadsheetId, item.provenance.tableName);
      }
    }
  }
}
