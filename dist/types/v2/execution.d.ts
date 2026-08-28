export type ExecutionMode = "cache" | "identity-map" | "bounded" | "full-scan";
export type ExecutionPlanStepKind = "cache-read" | "header-read" | "locator-read" | "range-read" | "local-filter" | "join" | "version-preflight" | "atomic-write" | "cache-invalidate";
export interface ExecutionPlanWarning {
    code: "FULL_SCAN" | "LOCAL_FILTER" | "UNINDEXED_PREDICATE" | "JOIN_FANOUT" | "STALE_CACHE";
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
export declare function createExecutionStats(initial?: Partial<ExecutionStats>): ExecutionStats;
export declare function mergeExecutionStats(...items: readonly ExecutionStats[]): ExecutionStats;
