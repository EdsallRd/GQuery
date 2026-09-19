import type { GQuery } from "./index";
import type { GQueryProjectedReadOptions, GQueryResult } from "./types";
/** Explicit projection, including dependencies needed by caller-side filters/joins. */
export declare function getManyProjectedInternal(client: GQuery, selections: Record<string, readonly string[]>, options?: GQueryProjectedReadOptions): Record<string, GQueryResult>;
