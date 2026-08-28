import type { AtomicBatchUpdateOptions, AtomicMutation } from "./contracts";
/** Safety ceiling below the Sheets API's recommended 2 MB request size. */
export declare const ATOMIC_BATCH_PAYLOAD_BYTE_LIMIT = 1800000;
/** Compile a transport-neutral atomic mutation into a Sheets batchUpdate request. */
export declare function atomicMutationToSheetsRequest(mutation: AtomicMutation): GoogleAppsScript.Sheets.Schema.Request;
export declare function utf8ByteLength(value: string): number;
/** Reject a request before an oversized atomic commit can reach the API. */
export declare function assertAtomicBatchPayloadSize(requests: readonly GoogleAppsScript.Sheets.Schema.Request[], options?: AtomicBatchUpdateOptions): number;
