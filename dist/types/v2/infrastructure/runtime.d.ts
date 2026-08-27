/** Small synchronous runtime ports shared by the Apps Script infrastructure. */
export interface Clock {
    now(): number;
}
export interface Sleeper {
    sleep(milliseconds: number): void;
}
export interface RandomSource {
    next(): number;
}
export interface IdGenerator {
    next(): string;
}
export interface SyncLock {
    tryAcquire(timeoutMs: number): boolean;
    release(): void;
}
export interface CacheStore {
    get(key: string): string | null;
    getMany(keys: readonly string[]): Record<string, string>;
    put(key: string, value: string, ttlSeconds: number): void;
    putMany(values: Readonly<Record<string, string>>, ttlSeconds: number): void;
    remove(key: string): void;
    removeMany(keys: readonly string[]): void;
}
export interface PropertyStore {
    get(key: string): string | null;
    getMany(): Record<string, string>;
    set(key: string, value: string): void;
    setMany(values: Readonly<Record<string, string>>): void;
    remove(key: string): void;
    removeMany(keys: readonly string[]): void;
}
export declare const systemClock: Clock;
export declare const appsScriptSleeper: Sleeper;
export declare const mathRandomSource: RandomSource;
export declare class AppsScriptCacheStore implements CacheStore {
    private readonly cache;
    constructor(cache: GoogleAppsScript.Cache.Cache);
    get(key: string): string | null;
    getMany(keys: readonly string[]): Record<string, string>;
    put(key: string, value: string, ttlSeconds: number): void;
    putMany(values: Readonly<Record<string, string>>, ttlSeconds: number): void;
    remove(key: string): void;
    removeMany(keys: readonly string[]): void;
}
export declare class AppsScriptPropertyStore implements PropertyStore {
    private readonly properties;
    constructor(properties: GoogleAppsScript.Properties.Properties);
    get(key: string): string | null;
    getMany(): Record<string, string>;
    set(key: string, value: string): void;
    setMany(values: Readonly<Record<string, string>>): void;
    remove(key: string): void;
    removeMany(keys: readonly string[]): void;
}
export declare class AppsScriptLock implements SyncLock {
    private readonly lock;
    constructor(lock: GoogleAppsScript.Lock.Lock);
    tryAcquire(timeoutMs: number): boolean;
    release(): void;
}
export declare function withLock<T>(lock: SyncLock, timeoutMs: number, operation: () => T): T;
