export type ExecutionMode =
  | "cache"
  | "identity-map"
  | "bounded"
  | "full-scan";

export type ExecutionPlanStepKind =
  | "cache-read"
  | "header-read"
  | "locator-read"
  | "range-read"
  | "local-filter"
  | "join"
  | "version-preflight"
  | "atomic-write"
  | "cache-invalidate";

export interface ExecutionPlanWarning {
  code:
    | "FULL_SCAN"
    | "LOCAL_FILTER"
    | "UNINDEXED_PREDICATE"
    | "JOIN_FANOUT"
    | "STALE_CACHE";
  message: string;
  table?: string;
}

export interface ExecutionPlanStep {
  kind: ExecutionPlanStepKind;
  source: string;
  table?: string;
  ranges: readonly string[];
  columns?: readonly string[];
  detail?: string;
  estimatedCells?: number;
}

export interface ExecutionPlan {
  mode: ExecutionMode;
  sourceIds: readonly string[];
  tables: readonly string[];
  steps: readonly ExecutionPlanStep[];
  warnings: readonly ExecutionPlanWarning[];
}

export interface ExecutionStats {
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
  /** Additional related rows beyond one match per base row. */
  joinFanOut: number;
  rangesRead: string[];
  rangesWritten: string[];
}

export function createExecutionStats(
  initial: Partial<ExecutionStats> = {},
): ExecutionStats {
  return {
    apiCalls: initial.apiCalls ?? 0,
    cellsRead: initial.cellsRead ?? 0,
    cellsWritten: initial.cellsWritten ?? 0,
    bytesRead: initial.bytesRead ?? 0,
    bytesWritten: initial.bytesWritten ?? 0,
    cacheHits: initial.cacheHits ?? 0,
    cacheMisses: initial.cacheMisses ?? 0,
    staleCacheHits: initial.staleCacheHits ?? 0,
    retries: initial.retries ?? 0,
    elapsedMs: initial.elapsedMs ?? 0,
    lockWaitMs: initial.lockWaitMs ?? 0,
    fullScans: initial.fullScans ?? 0,
    joinFanOut: initial.joinFanOut ?? 0,
    rangesRead: [...(initial.rangesRead ?? [])],
    rangesWritten: [...(initial.rangesWritten ?? [])],
  };
}

export function mergeExecutionStats(
  ...items: readonly ExecutionStats[]
): ExecutionStats {
  const merged = createExecutionStats();
  for (const item of items) {
    merged.apiCalls += item.apiCalls;
    merged.cellsRead += item.cellsRead;
    merged.cellsWritten += item.cellsWritten;
    merged.bytesRead += item.bytesRead;
    merged.bytesWritten += item.bytesWritten;
    merged.cacheHits += item.cacheHits;
    merged.cacheMisses += item.cacheMisses;
    merged.staleCacheHits += item.staleCacheHits;
    merged.retries += item.retries;
    merged.elapsedMs += item.elapsedMs;
    merged.lockWaitMs += item.lockWaitMs;
    merged.fullScans += item.fullScans;
    merged.joinFanOut += item.joinFanOut;
    merged.rangesRead.push(...item.rangesRead);
    merged.rangesWritten.push(...item.rangesWritten);
  }
  return merged;
}
