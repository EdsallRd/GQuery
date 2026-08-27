import type { AtomicCellUpdate, AtomicRowDelete, SheetCellInput } from "./contracts";
/** One zero-based physical cell change prior to request compaction. */
export interface CellPatch {
    sheetId: number;
    rowIndex: number;
    columnIndex: number;
    value: SheetCellInput;
}
export interface RowPatch {
    sheetId: number;
    rowIndex: number;
}
/**
 * Compact adjacent cell patches into maximal rectangles without filling gaps.
 * Duplicate physical cells are rejected so planner mistakes cannot silently
 * overwrite an earlier change.
 */
export declare function compactCellUpdates(patches: readonly CellPatch[]): AtomicCellUpdate[];
/** Group row indices and order every sheet's delete ranges from bottom to top. */
export declare function compactRowDeletes(rows: readonly RowPatch[]): AtomicRowDelete[];
