export const DEFAULT_RETRIES = 4;
export const MAX_RETRIES = 6;

export interface GQueryMeasurement {
  operation: string;
  durationMs: number;
  attempt: number;
  succeeded: boolean;
  rangeCount: number;
  valueRows: number;
}

let observer: ((measurement: GQueryMeasurement) => void) | undefined;

/** Observe service calls without exposing spreadsheet IDs, ranges, or values. */
export function configureGQueryObserver(next?: typeof observer): void {
  observer = next;
}

function reportRequest(operation: string, rangeCount: number, startedAt: number, attempt: number, succeeded: boolean, result?: any): void {
  if (!observer) return;
  try {
    const valueRows = Array.isArray(result?.valueRanges)
      ? result.valueRanges.reduce((sum: number, range: any) => sum + (range.values?.length ?? 0), 0)
      : result?.values?.length ?? result?.totalUpdatedRows ?? result?.updatedRows ?? result?.updates?.updatedRows ?? 0;
    observer({ operation, rangeCount, durationMs: Date.now() - startedAt, attempt, succeeded, valueRows });
  } catch { /* Diagnostics cannot change the result of a committed request. */ }
}

export function normalizeRetryCount(retries = DEFAULT_RETRIES): number {
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) {
    throw new RangeError(`GQuery retries must be an integer from 0 to ${MAX_RETRIES}.`);
  }
  return retries;
}

/**
 * Run a Sheets API request with bounded exponential backoff for quota errors.
 * `retries` counts retries after the initial request.
 */
export function callHandler<T>(fn: () => T, retries = DEFAULT_RETRIES, operation = "sheets", rangeCount = 1): T {
  const retryLimit = normalizeRetryCount(retries);
  let retry = 0;

  while (true) {
    const startedAt = observer ? Date.now() : 0;
    try {
      const result = fn();
      reportRequest(operation, rangeCount, startedAt, retry + 1, true, result);
      return result;
    } catch (error: any) {
      reportRequest(operation, rangeCount, startedAt, retry + 1, false);
      const errorMessage = error?.message || String(error);

      // Check if it's a rate limit or quota error
      const isRateLimitError =
        errorMessage.includes("429") ||
        errorMessage.includes("Quota exceeded") ||
        errorMessage.includes("Rate Limit Exceeded");

      if (isRateLimitError) {
        if (retry >= retryLimit) {
          throw new Error(
            `Max retries (${retryLimit}) reached for Google Sheets API call. Last error: ${errorMessage}`,
          );
        }

        retry += 1;

        // Exponential backoff with jitter, capped at 64 seconds
        const backoffDelay = Math.min(
          Math.pow(2, retry) * 1000 + Math.random() * 1000,
          64000,
        );

        console.log(
          `Rate limit hit, retrying in ${Math.round(backoffDelay)}ms (retry ${retry}/${retryLimit})`,
        );
        Utilities.sleep(backoffDelay);
      } else {
        // Not a rate limit error, rethrow immediately
        throw error;
      }
    }
  }
}
