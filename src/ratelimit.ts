export const DEFAULT_RETRIES = 4;
export const MAX_RETRIES = 6;

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
export function callHandler<T>(fn: () => T, retries = DEFAULT_RETRIES): T {
  const retryLimit = normalizeRetryCount(retries);
  let retry = 0;

  while (true) {
    try {
      return fn();
    } catch (error: any) {
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
