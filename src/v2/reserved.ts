/** Physical sheets owned by GQuery itself rather than by a user table. */
export const GQUERY_SYSTEM_SHEET_NAMES = Object.freeze([
  "_gq_meta",
  "_gq_dead_letters",
] as const);

const SYSTEM_SHEET_NAMES = new Set<string>(
  GQUERY_SYSTEM_SHEET_NAMES.map((name) => name.toLowerCase()),
);

/**
 * Names that cannot also be exposed as the direct `gq.TableName` handle.
 * This includes the public API, implementation-owned instance fields, and
 * Object prototype properties that an own table handle would shadow.
 */
const RESERVED_TABLE_PROPERTIES = new Set<string>([
  "definition",
  "executor",
  "tables",
  "raw",
  "schema",
  "system",
  "deferred",
  "cache",
  "batch",
  "assertTransactionOpen",
  "decorateExecutable",
  "materialize",
  "appendRows",
  "commitIntents",
  "unitOfWork",
  "resolveSourceId",
  "selectionRuntime",
  "appendOperation",
  "transport",
  "activeResolver",
  "generations",
  "systemHooks",
  "deferredJournal",
  "deferredDeadLetters",
  "deferredAppliedReceipts",
  "canonicalState",
  "deferredOverlay",
  "constructor",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);

export function isGQuerySystemSheetName(name: string): boolean {
  return SYSTEM_SHEET_NAMES.has(name.toLowerCase());
}

export function isReservedTablePropertyName(name: string): boolean {
  return RESERVED_TABLE_PROPERTIES.has(name) || isGQuerySystemSheetName(name);
}
