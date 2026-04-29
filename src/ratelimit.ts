import { GQueryApiError } from "./types";

const RETRYABLE_PATTERNS = ["429", "Quota exceeded", "Rate Limit Exceeded"];

function isRateLimitMessage(message: string): boolean {
  for (const p of RETRYABLE_PATTERNS) {
    if (message.includes(p)) return true;
  }
  return false;
}

/**
 * Exponential-backoff handler for Google Sheets API calls.
 *
 * Retries on rate-limit / quota errors thrown by the Advanced Sheets service.
 * `urlFetch: true` adds support for `UrlFetchApp.fetch` results: response
 * codes 429/5xx are converted into retries; other non-2xx responses are
 * surfaced as `GQueryApiError`.
 */
export function callHandler<T>(
  fn: () => T,
  retries: number = 20,
  options: { urlFetch?: boolean; operation?: string } = {},
): T {
  const operation = options.operation ?? "sheets-call";
  let attempt = 0;

  while (attempt < retries) {
    try {
      const result = fn();

      // UrlFetchApp.fetch never throws on non-2xx unless muteHttpExceptions
      // is false (the default), but downstream callers usually set it to
      // true so they can inspect headers. Treat retryable status codes as
      // throws and surface the rest as GQueryApiError.
      if (options.urlFetch && isHttpResponse(result)) {
        const code = result.getResponseCode();
        if (code >= 200 && code < 300) {
          return result;
        }
        const body = safeBody(result);
        if (code === 429 || (code >= 500 && code < 600)) {
          attempt++;
          if (attempt >= retries) {
            throw new GQueryApiError(operation, code, body);
          }
          sleep(backoffMs(attempt));
          continue;
        }
        throw new GQueryApiError(operation, code, body);
      }

      return result;
    } catch (error: any) {
      if (error instanceof GQueryApiError) throw error;

      const errorMessage = error?.message || String(error);

      if (isRateLimitMessage(errorMessage)) {
        attempt++;
        if (attempt >= retries) {
          throw new GQueryApiError(
            operation,
            null,
            `Max retries (${retries}) reached. Last error: ${errorMessage}`,
            error,
          );
        }
        sleep(backoffMs(attempt));
        continue;
      }

      throw error;
    }
  }

  throw new GQueryApiError(
    operation,
    null,
    "Unexpected state: max retries reached without throwing",
  );
}

function backoffMs(attempt: number): number {
  return Math.min(Math.pow(2, attempt) * 1000 + Math.random() * 1000, 64_000);
}

function sleep(ms: number): void {
  if (typeof Utilities !== "undefined" && Utilities.sleep) {
    Utilities.sleep(ms);
  }
}

function isHttpResponse(
  value: unknown,
): value is GoogleAppsScript.URL_Fetch.HTTPResponse {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as any).getResponseCode === "function" &&
    typeof (value as any).getContentText === "function"
  );
}

function safeBody(
  response: GoogleAppsScript.URL_Fetch.HTTPResponse,
): string {
  try {
    const text = response.getContentText();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "(unreadable response body)";
  }
}
