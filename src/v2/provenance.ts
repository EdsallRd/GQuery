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
  /** Base-table fields whose values selected each materialized relation alias. */
  readonly relationLocalFields?: Readonly<Record<string, readonly string[]>>;
  /**
   * Marks rows whose visible value includes durable write-behind state that is
   * not yet authoritative in Sheets. Virtual rows have no physical row at all.
   */
  readonly deferredOverlay?: {
    readonly mutationIds: readonly string[];
    readonly fields: readonly string[];
    readonly virtual: boolean;
  };
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
    relationLocalFields: Object.freeze({
      ...(provenance.relationLocalFields ?? {}),
      ...(changes.relationLocalFields ?? {}),
    }),
    deferredOverlay: changes.deferredOverlay === undefined
      ? provenance.deferredOverlay
      : Object.freeze({
          ...changes.deferredOverlay,
          mutationIds: Object.freeze([...changes.deferredOverlay.mutationIds]),
          fields: Object.freeze([...changes.deferredOverlay.fields]),
        }),
  });
}

/**
 * Remove joined values whose lookup key was changed by a base-row mutation.
 * The remaining aliases keep their exact physical relation provenance.
 */
export function invalidateChangedRelations<T extends Record<string, unknown>>(
  item: MaterializedRow<T>,
  changedFields: readonly string[],
): MaterializedRow<T> {
  if (changedFields.length === 0) return item;
  const changed = new Set(changedFields);
  const localFields = item.provenance.relationLocalFields ?? {};
  const invalidated = Object.entries(localFields)
    .filter(([, fields]) => fields.some((field) => changed.has(field)))
    .map(([alias]) => alias);
  if (invalidated.length === 0) return item;

  const invalidatedSet = new Set(invalidated);
  const value = { ...item.value };
  for (const alias of invalidated) delete value[alias];
  const retain = <Value>(record: Readonly<Record<string, Value>>): Record<string, Value> =>
    Object.fromEntries(
      Object.entries(record).filter(([alias]) => !invalidatedSet.has(alias)),
    ) as Record<string, Value>;

  return {
    value: value as T,
    provenance: Object.freeze({
      ...item.provenance,
      relations: Object.freeze(retain(item.provenance.relations)),
      relationCardinalities: Object.freeze(retain(item.provenance.relationCardinalities)),
      relationLocalFields: Object.freeze(retain(localFields)),
    }),
  };
}
