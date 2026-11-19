import { describe, expect, it } from 'vitest';
import {
  DOWNLOAD_MAX_ATTEMPTS,
  getDownloadRetryDelayMs,
  isRetryableDownloadError,
  isRetryableDownloadStatus,
  shouldRetryDownloadAttempt,
} from '../../main/utils/downloadRetry';

describe('artifact download retry policy', () => {
  it.each([408, 425, 429, 500, 502, 503, 599])('retries transient HTTP status %s', (status) => {
    expect(isRetryableDownloadStatus(status)).toBe(true);
  });

  it.each([200, 206, 400, 401, 403, 404])('does not retry permanent HTTP status %s', (status) => {
    expect(isRetryableDownloadStatus(status)).toBe(false);
  });

  it.each([
    'net::ERR_CONNECTION_RESET',
    'net::ERR_TIMED_OUT',
    'ECONNRESET: connection reset',
    'fetch failed',
    'socket hang up',
  ])('retries transient transport error %s', (message) => {
    expect(isRetryableDownloadError(new Error(message))).toBe(true);
  });

  it('does not retry abort, auth or disk failures', () => {
    expect(isRetryableDownloadError(new Error('The operation was aborted'))).toBe(false);
    expect(isRetryableDownloadError(new Error('HTTP 403：登录态失效'))).toBe(false);
    expect(isRetryableDownloadError(new Error('ENOSPC: no space left on device'))).toBe(false);
  });

  it('limits retries to three total attempts with capped backoff', () => {
    expect(shouldRetryDownloadAttempt(1, true)).toBe(true);
    expect(shouldRetryDownloadAttempt(2, true)).toBe(true);
    expect(shouldRetryDownloadAttempt(DOWNLOAD_MAX_ATTEMPTS, true)).toBe(false);
    expect(shouldRetryDownloadAttempt(1, false)).toBe(false);
    expect(getDownloadRetryDelayMs(1)).toBe(350);
    expect(getDownloadRetryDelayMs(2)).toBe(700);
    expect(getDownloadRetryDelayMs(99)).toBe(1500);
  });
});
