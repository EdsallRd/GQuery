export interface CacheOptions {
    key?: string;
    ttl?: number;
    bypass?: boolean;
}
export declare function defaultKey(sheetName: string): string;
export declare function readThrough<T>(opts: CacheOptions | undefined, sheetName: string, producer: () => T): T;
export declare function invalidateSheet(sheetName: string): void;
