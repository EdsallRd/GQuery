const KEY_INDEX_KEY = "gq:__keys__";

export interface CacheOptions {
  key?: string;
  ttl?: number;     // seconds; default 300
  bypass?: boolean; // force fresh read
}

export function defaultKey(sheetName: string): string {
  return `gq:${sheetName}:list`;
}

export function readThrough<T>(
  opts: CacheOptions | undefined,
  sheetName: string,
  producer: () => T,
): T {
  const cache = CacheService.getScriptCache();
  const key = opts?.key ?? defaultKey(sheetName);
  if (!opts?.bypass) {
    const hit = cache.get(key);
    if (hit !== null) {
      try { return JSON.parse(hit) as T; } catch { /* fall through to producer */ }
    }
  }
  const value = producer();
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 100_000) {
      cache.put(key, serialized, opts?.ttl ?? 300);
      trackKey(key);
    }
  } catch {
    /* serialization failure — return value but don't cache */
  }
  return value;
}

export function invalidateSheet(sheetName: string): void {
  const cache = CacheService.getScriptCache();
  // Default key
  cache.remove(defaultKey(sheetName));
  // Any tracked custom keys for this sheet
  const tracked = readKeyIndex();
  const prefix = `gq:${sheetName}:`;
  const toRemove = tracked.filter((k) => k.startsWith(prefix));
  if (toRemove.length > 0) {
    cache.removeAll(toRemove);
    writeKeyIndex(tracked.filter((k) => !toRemove.includes(k)));
  }
}

function trackKey(key: string): void {
  const existing = readKeyIndex();
  if (!existing.includes(key)) {
    writeKeyIndex([...existing, key]);
  }
}

function readKeyIndex(): string[] {
  const raw = CacheService.getScriptCache().get(KEY_INDEX_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

function writeKeyIndex(keys: string[]): void {
  CacheService.getScriptCache().put(KEY_INDEX_KEY, JSON.stringify(keys), 21600);
}
