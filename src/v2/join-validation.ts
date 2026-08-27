import type { SerializableQueryPlan, JoinPlan } from "./query";
import { GQueryRuntimeError } from "./runtime-errors";
import type { DatabaseDefinition, TableDefinition, TableMap } from "./schema";

function invalidJoin(
  message: string,
  details: Readonly<Record<string, unknown>>,
): never {
  throw new GQueryRuntimeError("INVALID_QUERY", message, { details });
}

function keyFields(
  value: unknown,
  side: "local" | "foreign",
  alias: string,
): readonly string[] {
  if (typeof value !== "string" && !Array.isArray(value)) {
    return invalidJoin(`Join ${alias} ${side} key must be a field or field array.`, {
      alias,
      side,
      value,
    });
  }
  const fields = typeof value === "string" ? [value] : value;
  if (fields.length === 0) {
    return invalidJoin(`Join ${alias} ${side} key must contain at least one field.`, {
      alias,
      side,
    });
  }
  if (fields.some((field) => typeof field !== "string" || field.length === 0)) {
    return invalidJoin(`Join ${alias} ${side} key contains an invalid field name.`, {
      alias,
      side,
      fields,
    });
  }
  if (new Set(fields).size !== fields.length) {
    return invalidJoin(`Join ${alias} ${side} key contains duplicate fields.`, {
      alias,
      side,
      fields,
    });
  }
  return fields;
}

function requireTable(
  tables: TableMap,
  tableName: string,
  alias: string,
): TableDefinition {
  const table = tables[tableName];
  if (table === undefined) {
    return invalidJoin(`Join ${alias} references unknown table ${tableName}.`, {
      alias,
      table: tableName,
    });
  }
  return table;
}

function missingFields(
  fields: readonly string[],
  table: TableDefinition,
): readonly string[] {
  return fields.filter((field) => !(field in table.columns));
}

function validateJoin(
  baseName: string,
  base: TableDefinition,
  target: TableDefinition,
  join: JoinPlan,
  occupied: ReadonlySet<string>,
): void {
  if (typeof join.alias !== "string" || join.alias.trim().length === 0) {
    invalidJoin("Join aliases must be non-empty strings.", {
      alias: join.alias,
      table: join.table,
    });
  }
  if (!["left", "inner", "semi", "anti"].includes(join.kind)) {
    invalidJoin(`Join ${join.alias} has invalid kind ${String(join.kind)}.`, {
      alias: join.alias,
      kind: join.kind,
    });
  }
  if (join.cardinality !== "one" && join.cardinality !== "many") {
    invalidJoin(
      `Join ${join.alias} has invalid cardinality ${String(join.cardinality)}.`,
      { alias: join.alias, cardinality: join.cardinality },
    );
  }
  if (occupied.has(join.alias)) {
    invalidJoin(
      `Join alias ${join.alias} collides with a ${join.alias in base.columns ? "base column" : "prior join alias"}.`,
      {
        alias: join.alias,
        baseTable: baseName,
        collision: join.alias in base.columns ? "base-column" : "join-alias",
      },
    );
  }

  const local = keyFields(join.localField, "local", join.alias);
  const foreign = keyFields(join.foreignField, "foreign", join.alias);
  if (local.length !== foreign.length) {
    invalidJoin(`Join ${join.alias} local and foreign keys have different arity.`, {
      alias: join.alias,
      local,
      foreign,
    });
  }
  const missingLocal = missingFields(local, base);
  if (missingLocal.length > 0) {
    invalidJoin(
      `Join ${join.alias} references unknown ${baseName} local field${missingLocal.length === 1 ? "" : "s"}: ${missingLocal.join(", ")}.`,
      {
        alias: join.alias,
        side: "local",
        table: baseName,
        missing: missingLocal,
      },
    );
  }
  const missingForeign = missingFields(foreign, target);
  if (missingForeign.length > 0) {
    invalidJoin(
      `Join ${join.alias} references unknown ${join.table} foreign field${missingForeign.length === 1 ? "" : "s"}: ${missingForeign.join(", ")}.`,
      {
        alias: join.alias,
        side: "foreign",
        table: join.table,
        missing: missingForeign,
      },
    );
  }
  if (
    join.select !== undefined &&
    (!Array.isArray(join.select) ||
      join.select.some((field) => typeof field !== "string" || field.length === 0))
  ) {
    invalidJoin(`Join ${join.alias} select must be an array of field names.`, {
      alias: join.alias,
      select: join.select,
    });
  }
  const select = join.select ?? [];
  const missingSelect = missingFields(select, target);
  if (missingSelect.length > 0) {
    invalidJoin(
      `Join ${join.alias} selects unknown ${join.table} field${missingSelect.length === 1 ? "" : "s"}: ${missingSelect.join(", ")}.`,
      {
        alias: join.alias,
        side: "select",
        table: join.table,
        missing: missingSelect,
      },
    );
  }
}

/** Validate a complete immutable join chain before any source is resolved or read. */
export function validateJoinPlan(
  schema: DatabaseDefinition,
  plan: SerializableQueryPlan,
): void {
  const tables = schema.tables as TableMap;
  const base = requireTable(tables, plan.table, "<base>");
  const occupied = new Set(Object.keys(base.columns));
  for (const join of plan.joins) {
    const target = requireTable(tables, join.table, join.alias);
    validateJoin(plan.table, base, target, join, occupied);
    occupied.add(join.alias);
  }
}
