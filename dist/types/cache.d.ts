declare let writeObserver: ((sheetName: string) => void) | undefined;
/** Optional application invalidation hook; invoked only after successful writes. */
export declare function configureGQueryWriteObserver(next?: typeof writeObserver): void;
export interface CacheOptions {
    key?: string;
    ttl?: number;
    bypass?: boolean;
}
export declare function defaultKey(sheetName: string): string;
export declare function readThrough<T>(opts: CacheOptions | undefined, sheetName: string, producer: () => T): T;
export declare function invalidateSheet(sheetName: string): void;
export {};
