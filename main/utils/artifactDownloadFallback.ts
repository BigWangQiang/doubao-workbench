export type ArtifactDownloadPlatform = 'doubao' | 'dola' | undefined;

const SESSION_LOCAL_BLOCK_ERROR = /ERR_BLOCKED_BY_CLIENT/i;

function parseDolaCdnUrl(rawUrl: string): URL | undefined {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== 'dola.com' && !hostname.endsWith('.dola.com')) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Only bypass an account Session when its extension/proxy layer rejected an
 * already-authorized Dola CDN request locally. Network and HTTP failures must
 * keep using the account route so they are not silently masked.
 */
export function shouldRetryDolaDownloadWithoutAccountSession(
  platform: ArtifactDownloadPlatform,
  rawUrl: string,
  error: unknown,
): boolean {
  if (platform !== 'dola' || !parseDolaCdnUrl(rawUrl)) return false;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return SESSION_LOCAL_BLOCK_ERROR.test(message);
}

/** Dola currently emits some signed CDN URLs as HTTP although HTTPS is valid. */
export function getDolaDirectDownloadUrl(rawUrl: string): string {
  const parsed = parseDolaCdnUrl(rawUrl);
  if (!parsed) return rawUrl;
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  return parsed.toString();
}
