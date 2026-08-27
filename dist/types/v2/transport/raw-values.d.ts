import type { SheetCellInput, SheetCellValue } from "./contracts";
export type RawExtendedValue = {
    stringValue: string;
} | {
    numberValue: number;
} | {
    boolValue: boolean;
} | {
    formulaValue: string;
};
export interface RawCellData {
    /** Omitted when a `null` transport value means clear this cell. */
    userEnteredValue?: RawExtendedValue;
}
export declare function assertSheetCellValue(value: unknown, location?: string): asserts value is SheetCellValue;
export declare function cloneRawMatrix(values: readonly (readonly SheetCellValue[])[], label?: string): SheetCellValue[][];
export declare function assertSheetCellInput(value: unknown, location?: string): asserts value is SheetCellInput;
export declare function cloneSheetInputMatrix(values: readonly (readonly SheetCellInput[])[], label?: string): SheetCellInput[][];
export declare function normalizeReturnedMatrix(values: readonly (readonly unknown[])[] | undefined, label?: string): SheetCellValue[][];
/** Encode one primitive as a Sheets v4 ExtendedValue. `null` means clear. */
export declare function encodeRawExtendedValue(value: SheetCellValue): RawExtendedValue | undefined;
/** Encode a grid-write input as Sheets v4 ExtendedValue without guessing. */
export declare function encodeAtomicExtendedValue(value: SheetCellInput): RawExtendedValue | undefined;
export declare function encodeRawCell(value: SheetCellValue): RawCellData;
export declare function encodeRawRows(values: readonly (readonly SheetCellValue[])[]): {
    values: RawCellData[];
}[];
export declare function encodeAtomicRows(values: readonly (readonly SheetCellInput[])[]): {
    values: RawCellData[];
}[];
