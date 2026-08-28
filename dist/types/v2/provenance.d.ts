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
export declare function cloneProvenance(provenance: RowProvenance, changes?: Partial<RowProvenance>): RowProvenance;
/**
 * Remove joined values whose lookup key was changed by a base-row mutation.
 * The remaining aliases keep their exact physical relation provenance.
 */
export declare function invalidateChangedRelations<T extends Record<string, unknown>>(item: MaterializedRow<T>, changedFields: readonly string[]): MaterializedRow<T>;
