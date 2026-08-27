export type GQueryErrorCode = "DEFINITION_INVALID" | "CODEC_ENCODE_FAILED" | "CODEC_DECODE_FAILED" | "CODEC_BLANK" | "CODEC_NULL" | "CODEC_TYPE" | "CODEC_CONSTRAINT" | "STRUCTURED_CYCLE" | "STRUCTURED_UNSUPPORTED" | "STRUCTURED_TOO_DEEP" | "STRUCTURED_TOO_LARGE" | "STRUCTURED_INVALID" | "STRUCTURED_VERSION" | "JSON_INVALID" | "JSON_TOO_LARGE";
export interface GQueryErrorOptions {
    readonly cause?: unknown;
    readonly details?: Readonly<Record<string, unknown>>;
}
/** Base class for errors callers can safely discriminate without parsing text. */
export declare class GQueryError extends Error {
    readonly code: GQueryErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
    constructor(code: GQueryErrorCode, message: string, options?: GQueryErrorOptions);
}
export declare class GQueryDefinitionError extends GQueryError {
    constructor(message: string, details?: Readonly<Record<string, unknown>>);
}
export type CodecDirection = "encode" | "decode";
export declare class GQueryCodecError extends GQueryError {
    readonly direction: CodecDirection;
    readonly codec: string;
    constructor(code: Exclude<GQueryErrorCode, "DEFINITION_INVALID">, message: string, options: GQueryErrorOptions & {
        readonly direction: CodecDirection;
        readonly codec: string;
    });
}
