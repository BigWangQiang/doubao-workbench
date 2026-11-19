import { describe, expect, it } from 'vitest';
import {
  getDolaDirectDownloadUrl,
  shouldRetryDolaDownloadWithoutAccountSession,
} from '../../main/utils/artifactDownloadFallback';

describe('Dola artifact download fallback', () => {
  const dolaUrl = 'http://v16-dola.dola.com/video/tos/example?lr=unwatermarked&token=signed';

  it('retries a Dola-owned CDN URL only for a local client block', () => {
    expect(shouldRetryDolaDownloadWithoutAccountSession(
      'dola',
      dolaUrl,
      new Error('net::ERR_BLOCKED_BY_CLIENT'),
    )).toBe(true);
  });

  it.each([
    ['doubao', dolaUrl, 'net::ERR_BLOCKED_BY_CLIENT'],
    ['dola', 'https://cdn.example.com/video.mp4', 'net::ERR_BLOCKED_BY_CLIENT'],
    ['dola', dolaUrl, 'net::ERR_TIMED_OUT'],
  ] as const)('does not broaden the fallback for platform=%s url=%s error=%s', (platform, url, message) => {
    expect(shouldRetryDolaDownloadWithoutAccountSession(platform, url, new Error(message))).toBe(false);
  });

  it('upgrades an HTTP Dola CDN URL to HTTPS without changing its signature', () => {
    expect(getDolaDirectDownloadUrl(dolaUrl)).toBe(
      'https://v16-dola.dola.com/video/tos/example?lr=unwatermarked&token=signed',
    );
  });

  it('leaves unrelated URLs unchanged', () => {
    const url = 'http://cdn.example.com/video.mp4?token=signed';
    expect(getDolaDirectDownloadUrl(url)).toBe(url);
  });
});
