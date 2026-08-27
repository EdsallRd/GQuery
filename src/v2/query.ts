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

export type PredicateOperator =
  | "eq"
  | "ne"
  | "in"
  | "notIn"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "isBlank";

export type PredicateNode =
  | { kind: "field"; field: string; operator: PredicateOperator; value?: unknown }
  | { kind: "and"; nodes: readonly PredicateNode[] }
  | { kind: "or"; nodes: readonly PredicateNode[] }
  | { kind: "not"; node: PredicateNode }
  | { kind: "constant"; value: boolean };

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

const OPERATOR_MAP: Record<string, PredicateOperator> = {
  $eq: "eq",
  $ne: "ne",
  $in: "in",
  $notIn: "notIn",
  $gt: "gt",
  $gte: "gte",
  $lt: "lt",
  $lte: "lte",
  $between: "between",
  $contains: "contains",
  $startsWith: "startsWith",
  $endsWith: "endsWith",
  $isBlank: "isBlank",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function immutablePredicateValue(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value instanceof Date) return Object.freeze(new Date(value.getTime()));
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const copy: unknown[] = [];
    seen.set(value, copy);
    copy.push(...value.map((entry) => immutablePredicateValue(entry, seen)));
    return Object.freeze(copy);
  }
  if (value !== null && typeof value === "object") {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = immutablePredicateValue(entry, seen);
    }
    return Object.freeze(copy);
  }
  return value;
}

function andNodes(nodes: readonly PredicateNode[]): PredicateNode {
  const flattened: PredicateNode[] = [];
  for (const node of nodes) {
    if (node.kind === "constant" && node.value) continue;
    if (node.kind === "and") flattened.push(...node.nodes);
    else flattened.push(node);
  }
  if (flattened.length === 0) return Object.freeze({ kind: "constant", value: true });
  if (flattened.length === 1) return flattened[0];
  return Object.freeze({ kind: "and", nodes: Object.freeze(flattened) });
}

function orNodes(nodes: readonly PredicateNode[]): PredicateNode {
  if (nodes.length === 0) return Object.freeze({ kind: "constant", value: false });
  if (nodes.length === 1) return nodes[0];
  return Object.freeze({ kind: "or", nodes: Object.freeze([...nodes]) });
}

/** Convert the typed object DSL into a deterministic, serializable predicate tree. */
export function normalizeWhere<T extends Record<string, unknown>>(where: Where<T>): PredicateNode {
  if (!isRecord(where)) throw new TypeError("where() expects an object predicate.");

  const nodes: PredicateNode[] = [];
  for (const [field, condition] of Object.entries(where)) {
    if (field === "$and" || field === "$or") {
      if (!Array.isArray(condition)) throw new TypeError(`${field} expects an array of predicates.`);
      const children = condition.map((entry) => normalizeWhere(entry as Where<T>));
      nodes.push(field === "$and" ? andNodes(children) : orNodes(children));
      continue;
    }
    if (field === "$not") {
      if (!isRecord(condition)) throw new TypeError("$not expects a predicate object.");
      nodes.push(Object.freeze({ kind: "not", node: normalizeWhere(condition as Where<T>) }));
      continue;
    }
    if (field.startsWith("$")) throw new TypeError(`Unknown predicate operator: ${field}`);

    const operatorEntries = isRecord(condition)
      ? Object.entries(condition).filter(([key]) => key.startsWith("$"))
      : [];

    if (operatorEntries.length === 0) {
      nodes.push(Object.freeze({
        kind: "field",
        field,
        operator: "eq",
        value: immutablePredicateValue(condition),
      }));
      continue;
    }

    if (operatorEntries.length !== Object.keys(condition as object).length) {
      throw new TypeError(`Field ${field} mixes operator and value-object syntax.`);
    }

    for (const [rawOperator, value] of operatorEntries) {
      const operator = OPERATOR_MAP[rawOperator];
      if (!operator) throw new TypeError(`Unknown field operator: ${rawOperator}`);
      if ((operator === "in" || operator === "notIn") && !Array.isArray(value)) {
        throw new TypeError(`${rawOperator} expects an array.`);
      }
      if (operator === "between" && (!Array.isArray(value) || value.length !== 2)) {
        throw new TypeError("$between expects a two-item tuple.");
      }
      if (operator === "isBlank" && typeof value !== "boolean") {
        throw new TypeError("$isBlank expects a boolean.");
      }
      nodes.push(Object.freeze({
        kind: "field",
        field,
        operator,
        value: immutablePredicateValue(value),
      }));
    }
  }
  return andNodes(nodes);
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function equalValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    const l = left instanceof Date ? left.getTime() : new Date(String(left)).getTime();
    const r = right instanceof Date ? right.getTime() : new Date(String(right)).getTime();
    return Number.isFinite(l) && Number.isFinite(r) && l === r;
  }
  if (Object.is(left, right)) return true;
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    return canonicalStringify(left) === canonicalStringify(right);
  }
  return false;
}

/** Evaluate a normalized predicate against a decoded logical row. */
export function evaluatePredicate(node: PredicateNode, row: Record<string, unknown>): boolean {
  if (node.kind === "constant") return node.value;
  if (node.kind === "and") return node.nodes.every((child) => evaluatePredicate(child, row));
  if (node.kind === "or") return node.nodes.some((child) => evaluatePredicate(child, row));
  if (node.kind === "not") return !evaluatePredicate(node.node, row);

  const actual = row[node.field];
  const expected = node.value;
  switch (node.operator) {
    case "eq": return equalValue(actual, expected);
    case "ne": return !equalValue(actual, expected);
    case "in": return (expected as readonly unknown[]).some((value) => equalValue(actual, value));
    case "notIn": return !(expected as readonly unknown[]).some((value) => equalValue(actual, value));
    case "gt": return (comparable(actual) as any) > (comparable(expected) as any);
    case "gte": return (comparable(actual) as any) >= (comparable(expected) as any);
    case "lt": return (comparable(actual) as any) < (comparable(expected) as any);
    case "lte": return (comparable(actual) as any) <= (comparable(expected) as any);
    case "between": {
      const [min, max] = expected as readonly [unknown, unknown];
      const value = comparable(actual) as any;
      return value >= (comparable(min) as any) && value <= (comparable(max) as any);
    }
    case "contains":
      if (typeof actual === "string") return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.some((value) => equalValue(value, expected));
      return false;
    case "startsWith": return typeof actual === "string" && actual.startsWith(String(expected));
    case "endsWith": return typeof actual === "string" && actual.endsWith(String(expected));
    case "isBlank": {
      const blank = actual === "" || actual === null || actual === undefined;
      return expected ? blank : !blank;
    }
  }
  return false;
}

function canonicalValue(value: unknown, seen: Set<object>): unknown {
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (value instanceof Date) return { $type: "date", value: value.toISOString() };
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { $type: "number", value: String(value) };
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, seen));
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Cannot canonicalize a circular value.");
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      result[key] = canonicalValue((value as Record<string, unknown>)[key], seen);
    }
    seen.delete(value);
    return result;
  }
  return value;
}

/** Stable JSON used for cache keys and plan fingerprints. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new Set()));
}

/** Deterministic non-cryptographic hash suitable for compact cache keys. */
export function hashCanonical(value: unknown): string {
  const input = canonicalStringify(value);
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function combinePredicates(
  current: PredicateNode | undefined,
  next: PredicateNode,
): PredicateNode {
  return current ? andNodes([current, next]) : next;
}

export function emptyQueryPlan(tableName: string, sourceName: string): SerializableQueryPlan {
  return Object.freeze({
    table: tableName,
    source: sourceName,
    orderBy: Object.freeze([]),
    joins: Object.freeze([]),
  });
}

export function cloneQueryPlan(
  plan: SerializableQueryPlan,
  changes: Partial<SerializableQueryPlan>,
): SerializableQueryPlan {
  const next = {
    ...plan,
    ...changes,
    projection: changes.projection ? Object.freeze([...changes.projection]) : plan.projection,
    orderBy: changes.orderBy
      ? Object.freeze(changes.orderBy.map((clause) => Object.freeze({ ...clause })))
      : plan.orderBy,
    joins: changes.joins
      ? Object.freeze(changes.joins.map((join) => Object.freeze({
          ...join,
          localField: Array.isArray(join.localField) ? Object.freeze([...join.localField]) : join.localField,
          foreignField: Array.isArray(join.foreignField) ? Object.freeze([...join.foreignField]) : join.foreignField,
          select: join.select === undefined ? undefined : Object.freeze([...join.select]),
        })))
      : plan.joins,
  };
  return Object.freeze(next);
}
