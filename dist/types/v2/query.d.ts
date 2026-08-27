/** Serializable predicate and query-plan primitives used by the v2 planner. */
export type SortDirection = "asc" | "desc";
export type JoinKind = "left" | "inner" | "semi" | "anti";
export type JoinCardinality = "one" | "many";
export type FieldOperators<V> = {
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
export type Where<T extends Record<string, unknown>> = {
    [K in keyof T]?: T[K] | FieldOperators<T[K]>;
} & {
    $and?: readonly Where<T>[];
    $or?: readonly Where<T>[];
    $not?: Where<T>;
};
export type PredicateOperator = "eq" | "ne" | "in" | "notIn" | "gt" | "gte" | "lt" | "lte" | "between" | "contains" | "startsWith" | "endsWith" | "isBlank";
export type PredicateNode = {
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
export interface OrderClause {
    field: string;
    direction: SortDirection;
}
export interface JoinPlan {
    table: string;
    alias: string;
    localField: string | readonly string[];
    foreignField: string | readonly string[];
    kind: JoinKind;
    cardinality: JoinCardinality;
    select?: readonly string[];
    relationName?: string;
}
export interface SerializableQueryPlan {
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
export declare function normalizeWhere<T extends Record<string, unknown>>(where: Where<T>): PredicateNode;
/** Evaluate a normalized predicate against a decoded logical row. */
export declare function evaluatePredicate(node: PredicateNode, row: Record<string, unknown>): boolean;
/** Stable JSON used for cache keys and plan fingerprints. */
export declare function canonicalStringify(value: unknown): string;
/** Deterministic non-cryptographic hash suitable for compact cache keys. */
export declare function hashCanonical(value: unknown): string;
export declare function combinePredicates(current: PredicateNode | undefined, next: PredicateNode): PredicateNode;
export declare function emptyQueryPlan(tableName: string, sourceName: string): SerializableQueryPlan;
export declare function cloneQueryPlan(plan: SerializableQueryPlan, changes: Partial<SerializableQueryPlan>): SerializableQueryPlan;
