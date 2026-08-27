import type { SheetCellValue } from "./transport";

/** Hidden, serializable-enough physical identity retained by materialized rows. */
export interface RowProvenance {
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
  /** Declared/planned cardinality is retained even when a relation matched 0 or 1 rows. */
  readonly relationCardinalities: Readonly<Record<string, "one" | "many">>;
}

export interface MaterializedRow<T extends Record<string, unknown>> {
  readonly value: T;
  readonly provenance: RowProvenance;
}

export function cloneProvenance(
  provenance: RowProvenance,
  changes: Partial<RowProvenance> = {},
): RowProvenance {
  return Object.freeze({
    ...provenance,
    ...changes,
    primaryKey: Object.freeze({
      ...provenance.primaryKey,
      ...(changes.primaryKey ?? {}),
    }),
    encodedPrimaryKey: Object.freeze({
      ...provenance.encodedPrimaryKey,
      ...(changes.encodedPrimaryKey ?? {}),
    }),
    originalEncoded: Object.freeze({
      ...provenance.originalEncoded,
      ...(changes.originalEncoded ?? {}),
    }),
    columnIndexes: Object.freeze({
      ...provenance.columnIndexes,
      ...(changes.columnIndexes ?? {}),
    }),
    relations: Object.freeze({
      ...provenance.relations,
      ...(changes.relations ?? {}),
    }),
    relationCardinalities: Object.freeze({
      ...provenance.relationCardinalities,
      ...(changes.relationCardinalities ?? {}),
    }),
  });
}
