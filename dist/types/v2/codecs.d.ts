/** Internal representation of a physically blank cell. */
export declare const BLANK_CELL: unique symbol;
export type BlankCell = typeof BLANK_CELL;
/**
 * Internal typed cell used by the high-level formula codec. The marker is
 * deliberately an object so a normal text value such as `"=SUM(A1:A3)"`
 * can never be mistaken for a formula by the transport.
 */
export interface FormulaCell {
    readonly __gqueryFormulaCell: true;
    readonly expression: string;
}
export type EncodedCell = string | number | boolean | BlankCell | FormulaCell;
export declare const LEGACY_NO_MATCH: unique symbol;
export type LegacyNoMatch = typeof LEGACY_NO_MATCH;
export interface CodecContext {
    readonly table?: string;
    readonly column?: string;
    readonly header?: string;
    readonly rowNumber?: number;
    /** Set to false after an explicit canonical-only migration cutover. */
    readonly allowLegacy?: boolean;
}
export interface ColumnCodec<T> {
    readonly kind: string;
    encode(value: T, context?: CodecContext): EncodedCell;
    decode(value: unknown, context?: CodecContext): T;
}
export type LegacyDecoder<T> = (value: unknown, context: CodecContext) => T | LegacyNoMatch;
export type CellFormat = Readonly<Record<string, unknown>>;
export interface ColumnDefinition<T> extends ColumnCodec<T> {
    readonly __gqueryColumn: true;
    /** Compile-time-only carrier used for row inference. */
    readonly __valueType?: T;
    readonly codec: ColumnCodec<T>;
    readonly header?: string;
    readonly format?: CellFormat;
    readonly legacyDecoders: readonly LegacyDecoder<T>[];
    readonly blankPolicy: "reject" | "null" | "undefined" | "default";
    readonly acceptsNull: boolean;
    /** Decode using only canonical encodings, including through wrapper codecs. */
    decodeCanonical(value: unknown, context?: CodecContext): T;
}
export type InferColumn<C> = C extends {
    readonly __gqueryColumn: true;
    readonly __valueType?: infer T;
} ? T : never;
export interface BaseColumnOptions<T> {
    readonly header?: string;
    readonly format?: CellFormat;
    readonly legacyDecoders?: readonly LegacyDecoder<T>[];
}
export interface TextColumnOptions extends BaseColumnOptions<string> {
    readonly trim?: boolean;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: RegExp;
}
export interface NumberColumnOptions extends BaseColumnOptions<number> {
    readonly min?: number;
    readonly max?: number;
}
export interface IntegerColumnOptions extends NumberColumnOptions {
    readonly safe?: boolean;
}
export interface DecimalColumnOptions extends BaseColumnOptions<string> {
    readonly scale?: number;
    readonly maxDigits?: number;
}
export interface BooleanColumnOptions extends BaseColumnOptions<boolean> {
}
export interface DateColumnOptions extends BaseColumnOptions<Date> {
}
export interface FormulaColumnOptions extends BaseColumnOptions<string> {
    /** Safety limit below Sheets' 50,000-character cell boundary. */
    readonly maxChars?: number;
}
export interface JsonColumnOptions<T extends JsonValue> extends BaseColumnOptions<T> {
    readonly formatVersion?: number;
    readonly maxChars?: number;
    readonly maxDepth?: number;
}
export interface StructuredColumnOptions<T> extends BaseColumnOptions<T> {
    readonly formatVersion?: number;
    readonly maxChars?: number;
    readonly maxDepth?: number;
}
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export declare function isFormulaCell(value: unknown): value is FormulaCell;
export declare function text(options?: TextColumnOptions): ColumnDefinition<string>;
/**
 * Declares a column whose canonical value is a Sheets formula expression.
 * Formula intent comes from the schema, never from inspecting an arbitrary
 * string during transport encoding.
 */
export declare function formula(options?: FormulaColumnOptions): ColumnDefinition<string>;
export declare function identifier(options?: Omit<TextColumnOptions, "trim" | "minLength">): ColumnDefinition<string>;
export declare function number(options?: NumberColumnOptions): ColumnDefinition<number>;
export declare function integer(options?: IntegerColumnOptions): ColumnDefinition<number>;
export declare function decimal(options?: DecimalColumnOptions): ColumnDefinition<string>;
export declare function booleanColumn(options?: BooleanColumnOptions): ColumnDefinition<boolean>;
export { booleanColumn as boolean };
export type EnumCellValue = string | number | boolean;
export interface EnumerationColumnOptions<Values extends readonly [EnumCellValue, ...EnumCellValue[]]> extends BaseColumnOptions<Values[number]> {
    readonly values: Values;
}
export declare function enumeration<const Values extends readonly [EnumCellValue, ...EnumCellValue[]]>(options: EnumerationColumnOptions<Values>): ColumnDefinition<Values[number]>;
export declare function date(options?: DateColumnOptions): ColumnDefinition<Date>;
export declare function datetime(options?: DateColumnOptions): ColumnDefinition<Date>;
export declare function json<T extends JsonValue = JsonValue>(options?: JsonColumnOptions<T>): ColumnDefinition<T>;
export declare function structured<T>(options?: StructuredColumnOptions<T>): ColumnDefinition<T>;
export declare function nullable<T>(column: ColumnDefinition<T>): ColumnDefinition<T | null>;
export declare function optional<T>(column: ColumnDefinition<T>): ColumnDefinition<T | undefined>;
export declare function withDefault<T>(column: ColumnDefinition<T>, defaultValue: T | (() => T)): ColumnDefinition<T>;
export type BlankPolicy = "reject" | "null" | "undefined";
export type BlankPolicyOutput<T, P extends BlankPolicy> = P extends "null" ? T | null : P extends "undefined" ? T | undefined : T;
export declare function withBlankPolicy<T, const P extends BlankPolicy>(column: ColumnDefinition<T>, policy: P): ColumnDefinition<BlankPolicyOutput<T, P>>;
export declare function isColumnDefinition(value: unknown): value is ColumnDefinition<unknown>;
