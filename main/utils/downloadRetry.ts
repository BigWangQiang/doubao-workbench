/**
 * Bounded retry policy for artifact downloads.
 *
 * Retries are deliberately limited to transient transport/server failures.
 * Authentication, expired URLs, invalid media and disk errors must surface to
 * the caller so a generation task is never silently submitted again.
 */

export const DOWNLOAD_MAX_ATTEMPTS = 3;

export function isRetryableDownloadStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

export function isRetryableDownloadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /(?:ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|CONNECTION_REFUSED|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|FAILED)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|fetch failed|socket hang up|network error|timeout|超时)/i.test(message);
}

/** Exponential backoff, capped so one URL cannot stall the queue indefinitely. */
export function getDownloadRetryDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(1_500, 350 * (2 ** (normalizedAttempt - 1)));
}

export function shouldRetryDownloadAttempt(attempt: number, retryable: boolean): boolean {
  return retryable && attempt < DOWNLOAD_MAX_ATTEMPTS;
}
