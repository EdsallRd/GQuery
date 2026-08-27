export interface HashFunction {
    hash(value: string): string;
}
/** Stable, type-preserving serialization used only for fingerprints and cache keys. */
export declare function canonicalStringify(value: unknown): string;
export declare function hashCanonical(value: unknown, hasher: HashFunction): string;
export declare class AppsScriptSha256Hash implements HashFunction {
    hash(value: string): string;
}
/** A deterministic non-cryptographic implementation useful for isolated tests and in-memory transports. */
export declare class Fnv1aHash implements HashFunction {
    hash(value: string): string;
}
