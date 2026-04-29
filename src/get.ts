import { GQuery, GQueryTable, GQueryTableFactory } from "./index";
import { callHandler } from "./ratelimit";
import {
  DateTimeRenderOption,
  GQueryApiError,
  GQueryReadOptions,
  GQueryResult,
  GQueryRow,
  GQuerySchemaError,
  GQueryWhereExpr,
  StandardSchemaV1,
  ValueRenderOption,
} from "./types";
import {
  buildA1Range,
  decodeCellValue,
  normalizeForSchema,
  parseRows,
} from "./utils";

const DATE_PATTERN =
  /^\d{1,2}\/\d{1,2}\/\d{4}(\s\d{1,2}:\d{1,2}(:\d{1,2})?)?$/;

/**
 * Validate a single row through a Standard Schema.
 * Throws GQuerySchemaError if validation fails.
 * Throws a plain Error if the schema returns a Promise (async schemas are not
 * supported in Google Apps Script).
 */
function applySchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  row: Record<string, any>,
): T {
  const result = schema["~standard"].validate(row);

  if (result instanceof Promise) {
    throw new Error(
      "GQuery does not support async schema validation. " +
        "Google Apps Script is a synchronous runtime. " +
        "Use a schema library that validates synchronously (e.g. Zod, Valibot).",
    );
  }

  if (result.issues) {
    throw new GQuerySchemaError(result.issues, row);
  }

  return result.value;
}

/**
 * Apply a schema to an array of raw rows, returning typed rows with __meta preserved.
 */
function applySchemaToRows<T>(
  schema: StandardSchemaV1<unknown, T>,
  rows: GQueryRow[],
): GQueryRow<T>[] {
  return rows.map((row) => {
    const { __meta, ...data } = row;
    const validated = applySchema(schema, normalizeForSchema(data));
    return { ...(validated as object), __meta } as GQueryRow<T>;
  });
}

export function getManyInternal(
  GQuery: GQuery,
  sheetNames: string[],
  options?: GQueryReadOptions,
): {
  [sheetName: string]: GQueryResult;
} {
  if (!sheetNames || sheetNames.length === 0) {
    return {};
  }

  const valueRenderOption =
    options?.valueRenderOption || ValueRenderOption.FORMATTED_VALUE;
  const dateTimeRenderOption =
    options?.dateTimeRenderOption || DateTimeRenderOption.FORMATTED_STRING;

  const cache = options?.cache === false ? null : GQuery.cache;
  const cacheKeyOpts = {
    range: "all",
    valueRender: valueRenderOption,
    dateRender: dateTimeRenderOption,
  };

  const result: { [sheetName: string]: GQueryResult } = {};
  const sheetsToFetch: string[] = [];

  for (const sheetName of sheetNames) {
    if (cache?.enabled) {
      const hit = cache.get(sheetName, cacheKeyOpts);
      if (hit) {
        result[sheetName] = hit;
        continue;
      }
    }
    sheetsToFetch.push(sheetName);
  }

  if (sheetsToFetch.length === 0) return result;

  const dataResponse = callHandler(
    () =>
      Sheets!.Spreadsheets!.Values!.batchGet(GQuery.spreadsheetId, {
        ranges: sheetsToFetch,
        valueRenderOption,
        dateTimeRenderOption,
      }),
    20,
    { operation: `Values.batchGet(${sheetsToFetch.join(",")})` },
  );

  if (!dataResponse || !dataResponse.valueRanges) {
    sheetsToFetch.forEach((sheet) => {
      result[sheet] = { headers: [], rows: [] };
    });
    return result;
  }

  dataResponse.valueRanges.forEach((valueRange, index) => {
    const sheetName = sheetsToFetch[index];

    if (!valueRange.values || valueRange.values.length === 0) {
      result[sheetName] = { headers: [], rows: [] };
      return;
    }

    const headers = valueRange.values[0].map((h) => String(h));
    const rows = parseRows(headers, valueRange.values.slice(1));
    result[sheetName] = { headers, rows };

    if (cache?.enabled) {
      cache.put(sheetName, result[sheetName], cacheKeyOpts);
    }
  });

  return result;
}

export function getInternal<
  T extends Record<string, any> = Record<string, any>,
>(
  GQueryTableFactory: GQueryTableFactory<T>,
  options?: GQueryReadOptions,
): GQueryResult<T> {
  const GQueryTable = GQueryTableFactory.GQueryTable;
  const GQuery = GQueryTable.GQuery;

  // Server-side filter pushdown: when whereExpr is set and there are no
  // joins, dispatch through the gviz/tq path so only matching rows come
  // over the wire.
  if (
    GQueryTableFactory.whereExprOption &&
    GQueryTableFactory.joinOption.length === 0
  ) {
    const tq = compileWhereExpr(
      GQueryTableFactory.whereExprOption,
      GQueryTableFactory.selectOption,
      GQueryTableFactory.limitOption,
      GQueryTableFactory.offsetOption,
    );
    const result = queryInternal(GQueryTable, tq, options);
    const rows = GQueryTableFactory.filterOption
      ? result.rows.filter((row) => safeFilter(GQueryTableFactory.filterOption!, row))
      : result.rows;
    const typed =
      GQueryTable.schema && options?.validate
        ? applySchemaToRows(GQueryTable.schema, rows)
        : (rows as unknown as GQueryRow<T>[]);
    return { headers: result.headers, rows: typed };
  }

  // Determine which sheets we need to read from
  const sheetsToRead = [GQueryTable.sheetName];

  // Add all join sheets
  if (GQueryTableFactory.joinOption.length > 0) {
    GQueryTableFactory.joinOption.forEach((join) => {
      if (!sheetsToRead.includes(join.sheetName)) {
        sheetsToRead.push(join.sheetName);
      }
    });
  }

  // Read data from all required sheets at once
  const results = GQuery.getMany(sheetsToRead, options);

  // If the main sheet doesn't exist or has no data
  if (
    !results[GQueryTable.sheetName] ||
    results[GQueryTable.sheetName].rows.length === 0
  ) {
    return { headers: [], rows: [] };
  }

  // Get data for the primary table
  let result = results[GQueryTable.sheetName];
  let rows = result.rows;
  let headers = result.headers;

  // Process each join sequentially
  if (GQueryTableFactory.joinOption.length > 0) {
    GQueryTableFactory.joinOption.forEach((joinConfig) => {
      const { sheetName, sheetColumn, joinColumn, columnsToReturn } =
        joinConfig;

      const joinData = results[sheetName];
      if (!joinData || !joinData.rows || joinData.rows.length === 0) return;

      const joinHeaders = joinData.headers;
      if (!joinHeaders.includes(sheetColumn)) return;

      const joinMap: Record<string, GQueryRow[]> = {};
      joinData.rows.forEach((joinRow) => {
        const joinKey = String(joinRow[sheetColumn]);
        if (!joinMap[joinKey]) joinMap[joinKey] = [];
        joinMap[joinKey].push(joinRow);
      });

      rows = rows.map((row) => {
        const localJoinValue = row[joinColumn];
        const joinedRows = joinMap[String(localJoinValue)] || [];
        const joinedRow = { ...row };

        joinedRows.forEach((joinRow, index) => {
          const columnsToInclude =
            columnsToReturn ||
            Object.keys(joinRow).filter(
              (key) => key !== "__meta" && key !== sheetColumn,
            );

          columnsToInclude.forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(joinRow, key) && key !== "__meta") {
              const suffix = joinedRows.length > 1 ? `_${index + 1}` : "";
              const targetKey = key === sheetColumn ? key : `${key}${suffix}`;
              joinedRow[targetKey] = joinRow[key];
            }
          });
        });

        return joinedRow;
      });
    });
  }

  // Apply filter if specified
  if (GQueryTableFactory.filterOption) {
    rows = rows.filter((row) =>
      safeFilter(GQueryTableFactory.filterOption!, row),
    );
  }

  // Apply offset/limit (in-memory; A1-range pushdown happens earlier when no joins/filters require full data)
  if (GQueryTableFactory.offsetOption !== undefined) {
    rows = rows.slice(GQueryTableFactory.offsetOption);
  }
  if (GQueryTableFactory.limitOption !== undefined) {
    rows = rows.slice(0, GQueryTableFactory.limitOption);
  }

  // Apply select if specified — strict projection. Joined columns are kept
  // only when explicitly listed (or via .includeJoinColumns()).
  let outHeaders = headers;
  if (
    GQueryTableFactory.selectOption &&
    GQueryTableFactory.selectOption.length > 0
  ) {
    let selectedHeaders = [...GQueryTableFactory.selectOption];

    if (GQueryTableFactory.includeJoinColumnsOption) {
      const joinedColumns = new Set<string>();
      rows.forEach((row) => {
        Object.keys(row).forEach((key) => {
          if (!headers.includes(key) && key !== "__meta") {
            joinedColumns.add(key);
          }
        });
      });
      joinedColumns.forEach((c) => selectedHeaders.push(c));
    }

    selectedHeaders = Array.from(new Set(selectedHeaders));

    rows = rows.map((row) => {
      const selectedRow: GQueryRow = { __meta: row.__meta };
      selectedHeaders.forEach((header) => {
        if (Object.prototype.hasOwnProperty.call(row, header)) {
          selectedRow[header] = row[header];
        }
      });
      return selectedRow;
    });
    outHeaders = selectedHeaders;
  }

  const typedRows =
    GQueryTable.schema && options?.validate
      ? applySchemaToRows(GQueryTable.schema, rows)
      : (rows as unknown as GQueryRow<T>[]);

  return {
    headers: outHeaders,
    rows: typedRows,
  };
}

function safeFilter(
  fn: (row: any) => boolean,
  row: GQueryRow,
): boolean {
  try {
    return fn(row);
  } catch (error) {
    console.error("Error filtering row:", error);
    return false;
  }
}

/**
 * Execute a Google Visualization API (gviz/tq) query against the table's
 * sheet. The caller passes in a fully-formed `tq` query string; we handle
 * the column-name → A1-letter substitution by reading the header row once
 * (cached when the spreadsheet's GQueryCache is enabled), wrap the HTTP
 * call in callHandler for retries, and parse the response into typed rows.
 */
export function queryInternal(
  GQueryTable: GQueryTable,
  query: string,
  options?: GQueryReadOptions,
): GQueryResult {
  const cache =
    options?.cache === false ? null : GQueryTable.GQuery.cache;

  if (cache?.enabled) {
    const hit = cache.getQuery(GQueryTable.sheetName, query);
    if (hit) return hit;
  }

  const headers = readHeadersOnce(GQueryTable);

  // Build column name → A1 letter map in a single pass over the header row.
  let replaced = query;
  for (let i = 0; i < headers.length; i++) {
    const name = headers[i];
    if (!name) continue;
    const letter = columnLetterOf(i);
    // Replace whole-word column references; most user queries quote names
    // with backticks but we keep the legacy global-replace for compatibility.
    replaced = replaced.split(name).join(letter);
  }

  const url = Utilities.formatString(
    "https://docs.google.com/spreadsheets/d/%s/gviz/tq?tq=%s&sheet=%s&headers=1",
    GQueryTable.spreadsheetId,
    encodeURIComponent(replaced),
    encodeURIComponent(GQueryTable.sheetName),
  );

  const response = callHandler(
    () =>
      UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        headers: {
          Authorization: "Bearer " + ScriptApp.getOAuthToken(),
        },
      }),
    20,
    { urlFetch: true, operation: `gviz.query(${GQueryTable.sheetName})` },
  );

  const body = response.getContentText();
  const stripped = body
    .replace("/*O_o*/\n", "")
    .replace(/(google\.visualization\.Query\.setResponse\()|(\);)/gm, "");

  let jsonResponse: any;
  try {
    jsonResponse = JSON.parse(stripped);
  } catch (error) {
    throw new GQueryApiError(
      `gviz.query(${GQueryTable.sheetName})`,
      response.getResponseCode(),
      `Failed to parse gviz response: ${stripped.slice(0, 200)}`,
      error,
    );
  }

  if (jsonResponse.status === "error") {
    const message = (jsonResponse.errors || [])
      .map((e: any) => e.detailed_message || e.message)
      .join("; ");
    throw new GQueryApiError(
      `gviz.query(${GQueryTable.sheetName})`,
      response.getResponseCode(),
      message || "gviz returned an error status",
    );
  }

  const table = jsonResponse.table;
  const outHeaders: string[] = table.cols.map(
    (col: any) => col.label || col.id || "",
  );

  const rows: GQueryRow[] = table.rows.map((row: any) => {
    const rowObj: GQueryRow = {
      __meta: {
        rowNum: -1, // gviz doesn't expose source row numbers without __ROW__
        colLength: row.c.length,
      },
    };
    table.cols.forEach((col: any, colIndex: number) => {
      const cellData = row.c[colIndex];
      let value: any = "";
      if (cellData) {
        value =
          cellData.f !== null && cellData.f !== undefined
            ? cellData.f
            : cellData.v;
        if (typeof value === "string" && DATE_PATTERN.test(value)) {
          const dateValue = new Date(value);
          if (!isNaN(dateValue.getTime())) value = dateValue;
        } else if (typeof value === "string") {
          value = decodeCellValue(value);
        }
      }
      rowObj[outHeaders[colIndex] || col.id] = value;
    });
    return rowObj;
  });

  const out = { headers: outHeaders, rows };

  if (cache?.enabled) {
    cache.putQuery(GQueryTable.sheetName, query, out);
  }
  return out;
}

/**
 * Read the header row for a sheet. Uses the GQueryCache when available
 * (avoids the per-call Sheets RPC); otherwise issues a single
 * `Values.get(sheet!1:1)` instead of the legacy per-column getRange loop.
 */
function readHeadersOnce(GQueryTable: GQueryTable): string[] {
  const cache = GQueryTable.GQuery.cache;
  if (cache?.enabled) {
    const hit = cache.get(GQueryTable.sheetName, {
      range: "all",
      valueRender: "FORMATTED_VALUE",
      dateRender: "FORMATTED_STRING",
    });
    if (hit) return hit.headers;
  }
  const range = buildA1Range(GQueryTable.sheetName, { offset: 0, limit: 0 });
  const response = callHandler(
    () => Sheets!.Spreadsheets!.Values!.get(GQueryTable.spreadsheetId, range),
    20,
    { operation: `Values.get(${range})` },
  );
  const values = response.values || [];
  if (values.length === 0) return [];
  return values[0].map((h: any) => String(h));
}

function columnLetterOf(index: number): string {
  let out = "";
  let n = index;
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

/**
 * Compile a typed GQueryWhereExpr into a Google Visualization API query
 * string. Column names are emitted as backtick-quoted identifiers so they
 * survive the later name → letter substitution step.
 */
export function compileWhereExpr(
  expr: GQueryWhereExpr,
  select?: string[],
  limit?: number,
  offset?: number,
): string {
  const parts: string[] = [];
  if (select && select.length > 0) {
    parts.push(`select ${select.map((c) => `\`${c}\``).join(", ")}`);
  } else {
    parts.push("select *");
  }
  parts.push(`where ${compileExpr(expr)}`);
  if (limit !== undefined) parts.push(`limit ${limit}`);
  if (offset !== undefined) parts.push(`offset ${offset}`);
  return parts.join(" ");
}

function compileExpr(expr: GQueryWhereExpr): string {
  if ("and" in expr) {
    return `(${expr.and.map(compileExpr).join(" and ")})`;
  }
  if ("or" in expr) {
    return `(${expr.or.map(compileExpr).join(" or ")})`;
  }
  if ("not" in expr) {
    return `(not ${compileExpr(expr.not)})`;
  }
  const { col, op, value } = expr;
  return `\`${col}\` ${op} ${formatLiteral(value)}`;
}

function formatLiteral(
  value: string | number | boolean | null | Date,
): string {
  if (value === null) return "null";
  if (value instanceof Date) {
    return `date '${value.toISOString().slice(0, 10)}'`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return `"${String(value).replace(/"/g, '\\"')}"`;
}
