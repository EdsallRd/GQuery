import type { SerializableQueryPlan } from "./query";
import type { DatabaseDefinition } from "./schema";
/** Validate a complete immutable join chain before any source is resolved or read. */
export declare function validateJoinPlan(schema: DatabaseDefinition, plan: SerializableQueryPlan): void;
