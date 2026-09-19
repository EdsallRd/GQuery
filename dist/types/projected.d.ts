import type { GQuery } from "./index";
import type { GQueryReadOptions, GQueryResult } from "./types";
/** Explicit projection, including dependencies needed by caller-side filters/joins. */
export declare function getManyProjectedInternal(client: GQuery, selections: Record<string, readonly string[]>, options?: GQueryReadOptions): Record<string, GQueryResult>;
