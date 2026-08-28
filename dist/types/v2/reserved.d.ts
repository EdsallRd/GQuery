/** Physical sheets owned by GQuery itself rather than by a user table. */
export declare const GQUERY_SYSTEM_SHEET_NAMES: readonly ["_gq_meta", "_gq_dead_letters"];
export declare function isGQuerySystemSheetName(name: string): boolean;
export declare function isReservedTablePropertyName(name: string): boolean;
