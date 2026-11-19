import type { GenerationMode, TaskArtifact } from '@doubao-studio/contracts';

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv', 'mpeg', 'mpg', 'm3u8', 'ts', 'ogv'] as const;
const IMAGE_EXTENSIONS = ['png', 'jpe', 'jpeg', 'jpg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif'] as const;

function normalizeMediaToken(value: string): string {
  return value.trim().toLowerCase().replace(/["'\s]/g, '').replace(/[._-]+/g, '/');
}

function kindFromMediaToken(value: string): TaskArtifact['kind'] | undefined {
  const normalized = normalizeMediaToken(value);
  if (!normalized) return undefined;
  if (normalized.startsWith('video/') || normalized === 'video') return 'video';
  if (normalized.startsWith('image/') || normalized === 'image' || normalized.startsWith('img/')) return 'image';
  const extension = normalized.replace(/^.*\//, '').replace(/^\./, '');
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return 'video';
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return 'image';
  return undefined;
}

function kindFromUrlMetadata(url: string): TaskArtifact['kind'] | undefined {
  try {
    const parsed = new URL(url);
    for (const [key, rawValue] of parsed.searchParams.entries()) {
      const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
      if (!['mime', 'mimetype', 'contenttype', 'mediatype', 'type', 'format', 'ext', 'extension'].includes(normalizedKey)) continue;
      const kind = kindFromMediaToken(rawValue);
      if (kind) return kind;
    }
  } catch {
    // 继续使用字符串扩展名回退。
  }
  const query = String(url || '').split(/[?#]/, 2)[1] || '';
  const match = /(?:^|[&#])(?:mime(?:[_-]?type)?|content[-_]?type|media[-_]?type|type|format|ext|extension)=([^&#]+)/i.exec(query);
  if (!match) return undefined;
  try { return kindFromMediaToken(decodeURIComponent(match[1])); } catch { return kindFromMediaToken(match[1]); }
}

/** Renderer counterpart of the main-process artifact type inference. */
export function inferArtifactKind(
  url: string,
  fallback: TaskArtifact['kind'],
  contentType?: string,
  taskMode?: GenerationMode,
): TaskArtifact['kind'] {
  const mime = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime?.startsWith('video/') || (mime !== undefined && ['application/mp4', 'application/vnd.apple.mpegurl', 'application/x-mpegurl'].includes(mime))) return 'video';
  if (mime?.startsWith('image/')) return 'image';
  const queryKind = kindFromUrlMetadata(url);
  if (queryKind) return queryKind;
  const normalized = String(url || '').trim().toLowerCase();
  const path = normalized.split(/[?#]/, 1)[0];
  if (/\.(?:mp4|webm|mov|m4v|avi|mkv|mpeg|mpg|m3u8|ts)$/.test(path)) return 'video';
  if (/\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/.test(path)) return 'image';
  if (taskMode === 'video') return 'video';
  if (taskMode === 'image') return 'image';
  return fallback;
}

const IMAGE_FORMAT_EXTENSIONS = new Set([
  'png', 'jpe', 'jpeg', 'jpg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif',
]);
const INCOMPATIBLE_IMAGE_EXTENSIONS = new Set(['heic', 'heif']);
const SIGNATURE_QUERY_KEYS = new Set([
  'signature', 'x-signature', 'sig', 'token', 'x-token', 'expires', 'x-expires',
]);

function getImagePathExtension(pathname: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(pathname);
  return match?.[1]?.toLowerCase() || '';
}

/**
 * Return a stable identity for format variants of one generated image.
 * CDN signatures and shard hosts are transport details; the generated asset
 * path is the stable part shared by PNG/HEIC variants.
 */
export function getImageArtifactIdentity(url: string): string {
  const raw = String(url || '').trim();
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^p\d+-/, '');
    const pathname = parsed.pathname
      .toLowerCase()
      .replace(/\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico|heic|heif)$/i, '');
    const stableParams = [...parsed.searchParams.entries()]
      .filter(([key]) => !SIGNATURE_QUERY_KEYS.has(key.toLowerCase()))
      .sort(([left], [right]) => left.localeCompare(right));
    const query = stableParams.length
      ? `?${stableParams.map(([key, value]) => `${key}=${value}`).join('&')}`
      : '';
    return `${host}${pathname}${query}`;
  } catch {
    return raw.toLowerCase()
      .replace(/[?#].*$/, '')
      .replace(/\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico|heic|heif)$/i, '');
  }
}

/** Lower values are preferred for direct Chromium preview. */
export function getImageArtifactFormatRank(url: string): number {
  let extension = '';
  try {
    extension = getImagePathExtension(new URL(url).pathname);
  } catch {
    extension = getImagePathExtension(String(url || '').split(/[?#]/, 1)[0]);
  }
  if (!IMAGE_FORMAT_EXTENSIONS.has(extension)) return 5;
  if (INCOMPATIBLE_IMAGE_EXTENSIONS.has(extension)) return 10;
  if (extension === 'svg' || extension === 'ico') return 4;
  if (extension === 'avif') return 2;
  return 0;
}

/**
 * Keep one URL per generated image while preferring a browser-compatible
 * raster format. Different asset paths remain separate outputs.
 */
export function normalizeImageArtifactUrls(urls: readonly string[]): string[] {
  const selected = new Map<string, { url: string; rank: number; index: number }>();
  for (const rawUrl of urls) {
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!url) continue;
    const identity = getImageArtifactIdentity(url);
    const rank = getImageArtifactFormatRank(url);
    const current = selected.get(identity);
    if (!current || rank < current.rank) {
      selected.set(identity, { url, rank, index: current?.index ?? selected.size });
    }
  }
  return [...selected.values()]
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.url);
}
