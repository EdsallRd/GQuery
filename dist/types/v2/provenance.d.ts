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
}
export interface MaterializedRow<T extends Record<string, unknown>> {
    readonly value: T;
    readonly provenance: RowProvenance;
}
export declare function cloneProvenance(provenance: RowProvenance, changes?: Partial<RowProvenance>): RowProvenance;
