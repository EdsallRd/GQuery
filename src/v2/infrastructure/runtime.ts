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

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const appsScriptSleeper: Sleeper = {
  sleep: (milliseconds) => Utilities.sleep(milliseconds),
};

export const mathRandomSource: RandomSource = {
  next: () => Math.random(),
};

export class AppsScriptCacheStore implements CacheStore {
  public constructor(private readonly cache: GoogleAppsScript.Cache.Cache) {}

  public get(key: string): string | null {
    return this.cache.get(key);
  }

  public getMany(keys: readonly string[]): Record<string, string> {
    const values = this.cache.getAll([...keys]);
    const result: Record<string, string> = {};
    for (const key of keys) {
      const value = values[key];
      if (typeof value === "string") result[key] = value;
    }
    return result;
  }

  public put(key: string, value: string, ttlSeconds: number): void {
    this.cache.put(key, value, ttlSeconds);
  }

  public putMany(values: Readonly<Record<string, string>>, ttlSeconds: number): void {
    this.cache.putAll({ ...values }, ttlSeconds);
  }

  public remove(key: string): void {
    this.cache.remove(key);
  }

  public removeMany(keys: readonly string[]): void {
    if (keys.length > 0) this.cache.removeAll([...keys]);
  }
}

export class AppsScriptPropertyStore implements PropertyStore {
  public constructor(private readonly properties: GoogleAppsScript.Properties.Properties) {}

  public get(key: string): string | null {
    return this.properties.getProperty(key);
  }

  public getMany(): Record<string, string> {
    return this.properties.getProperties();
  }

  public set(key: string, value: string): void {
    this.properties.setProperty(key, value);
  }

  public setMany(values: Readonly<Record<string, string>>): void {
    this.properties.setProperties({ ...values });
  }

  public remove(key: string): void {
    this.properties.deleteProperty(key);
  }

  public removeMany(keys: readonly string[]): void {
    for (const key of keys) this.properties.deleteProperty(key);
  }
}

export class AppsScriptLock implements SyncLock {
  public constructor(private readonly lock: GoogleAppsScript.Lock.Lock) {}

  public tryAcquire(timeoutMs: number): boolean {
    return this.lock.tryLock(timeoutMs);
  }

  public release(): void {
    if (this.lock.hasLock()) this.lock.releaseLock();
  }
}

export function withLock<T>(lock: SyncLock, timeoutMs: number, operation: () => T): T {
  if (!lock.tryAcquire(timeoutMs)) {
    throw new Error(`Could not acquire the GQuery lock within ${timeoutMs}ms.`);
  }
  try {
    return operation();
  } finally {
    lock.release();
  }
}
