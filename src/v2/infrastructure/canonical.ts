export interface HashFunction {
  hash(value: string): string;
}

type CanonicalNode =
  | ["null"]
  | ["boolean", boolean]
  | ["number", string]
  | ["string", string]
  | ["bigint", string]
  | ["date", string]
  | ["array", CanonicalNode[]]
  | ["object", Array<[string, CanonicalNode]>];

function canonicalNode(value: unknown, ancestors: object[]): CanonicalNode {
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical values cannot contain NaN or Infinity.");
    if (Object.is(value, -0)) return ["number", "-0"];
    return ["number", String(value)];
  }
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("Canonical values cannot contain an invalid Date.");
    return ["date", value.toISOString()];
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical values cannot contain ${typeof value}.`);
  }
  if (ancestors.includes(value)) throw new TypeError("Canonical values cannot contain cycles.");

  const nextAncestors = [...ancestors, value];
  if (Array.isArray(value)) {
    return ["array", value.map((item) => canonicalNode(item, nextAncestors))];
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical values must use plain objects, arrays, dates, or primitives.");
  }
  const record = value as Record<string, unknown>;
  const entries: Array<[string, CanonicalNode]> = [];
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue;
    entries.push([key, canonicalNode(record[key], nextAncestors)]);
  }
  return ["object", entries];
}

/** Stable, type-preserving serialization used only for fingerprints and cache keys. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalNode(value, []));
}

export function hashCanonical(value: unknown, hasher: HashFunction): string {
  return hasher.hash(canonicalStringify(value));
}

export class AppsScriptSha256Hash implements HashFunction {
  public hash(value: string): string {
    const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      value,
      Utilities.Charset.UTF_8,
    );
    return bytes.map((byte) => (byte & 0xff).toString(16).padStart(2, "0")).join("");
  }
}

/** A deterministic non-cryptographic implementation useful for isolated tests and in-memory transports. */
export class Fnv1aHash implements HashFunction {
  public hash(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
}
