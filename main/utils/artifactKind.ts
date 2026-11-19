import type { GenerationMode, TaskArtifact } from '@doubao-studio/contracts';

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv', 'mpeg', 'mpg', 'm3u8', 'ts', 'ogv'] as const;
const IMAGE_EXTENSIONS = ['png', 'jpe', 'jpeg', 'jpg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif'] as const;

function normalizeMediaToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/["'\s]/g, '')
    .replace(/[._-]+/g, '/');
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

/** 从 URL 查询参数中读取媒体类型提示（例如 mime_type=video_mp4）。 */
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
    // URL 可能是历史相对路径；下面的字符串回退仍可处理扩展名。
  }
  const query = String(url || '').split(/[?#]/, 2)[1] || '';
  const match = /(?:^|[&#])(?:mime(?:[_-]?type)?|content[-_]?type|media[-_]?type|type|format|ext|extension)=([^&#]+)/i.exec(query);
  return match ? kindFromMediaToken(decodeURIComponentSafe(match[1])) : undefined;
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return '';
  let result = '';
  for (let index = offset; index < offset + length; index += 1) result += String.fromCharCode(bytes[index]);
  return result;
}

/**
 * 用文件签名识别媒体类型。服务端偶尔返回错误的 MIME 或无扩展名地址，
 * 因此下载完成后以完整文件的魔数作为最后一道分类校验。
 */
export function detectArtifactKindFromBytes(bytes: Uint8Array): TaskArtifact['kind'] | undefined {
  if (!bytes || bytes.length < 4) return undefined;
  if (bytes[0] === 0x89 && asciiAt(bytes, 1, 3) === 'PNG') return 'image';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image';
  if (asciiAt(bytes, 0, 6) === 'GIF87a' || asciiAt(bytes, 0, 6) === 'GIF89a') return 'image';
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'image';
  if (asciiAt(bytes, 4, 4) === 'ftyp') {
    const brand = asciiAt(bytes, 8, 4).toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'].includes(brand)) return 'image';
    return 'video';
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video';
  if (asciiAt(bytes, 0, 4) === 'OggS') return 'video';
  if (asciiAt(bytes, 0, 3) === 'FLV') return 'video';
  if (bytes[0] === 0x47 && bytes.length >= 188 && bytes[188] === 0x47) return 'video';
  return undefined;
}

/** 由已下载文件签名推断一个可写入验证记录的 MIME。 */
export function contentTypeFromArtifactBytes(bytes: Uint8Array): string | undefined {
  if (!bytes || bytes.length < 4) return undefined;
  if (bytes[0] === 0x89 && asciiAt(bytes, 1, 3) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (asciiAt(bytes, 0, 6) === 'GIF87a' || asciiAt(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (asciiAt(bytes, 4, 4) === 'ftyp') {
    const brand = asciiAt(bytes, 8, 4).toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'].includes(brand)) return 'image/avif';
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  if (asciiAt(bytes, 0, 4) === 'OggS') return 'video/ogg';
  if (asciiAt(bytes, 0, 3) === 'FLV') return 'video/x-flv';
  if (bytes[0] === 0x47 && bytes.length >= 189 && bytes[188] === 0x47) return 'video/mp2t';
  return undefined;
}

/**
 * Infer the media type of an artifact from trusted metadata before falling
 * back to the task mode. CDN URLs often omit a file extension, while some
 * video tasks also expose a poster image; using the URL/MIME signal prevents
 * those images from being listed under 视频.
 */
export function inferArtifactKind(
  url: string,
  fallback: TaskArtifact['kind'],
  contentType?: string,
  taskMode?: GenerationMode,
): TaskArtifact['kind'] {
  const mime = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime?.startsWith('video/') || (mime !== undefined && ['application/mp4', 'application/vnd.apple.mpegurl', 'application/x-mpegurl'].includes(mime))) return 'video';
  if (mime?.startsWith('image/')) return 'image';

  const normalized = String(url || '').trim().toLowerCase();
  const queryKind = kindFromUrlMetadata(normalized);
  if (queryKind) return queryKind;

  // Strip query/hash before checking a conventional extension. This also
  // handles signed URLs such as `/asset.mp4?Expires=...`.
  const path = normalized.split(/[?#]/, 1)[0];
  if (/\.(?:mp4|webm|mov|m4v|avi|mkv|mpeg|mpg|m3u8|ts)$/.test(path)) return 'video';
  if (/\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/.test(path)) return 'image';

  // taskMode is retained for legacy URLs without any media signal.
  if (taskMode === 'video') return 'video';
  if (taskMode === 'image') return 'image';
  return fallback;
}

/** 先用文件签名，再使用 MIME/URL/任务模式回退。 */
export function inferArtifactKindFromBytes(
  url: string,
  fallback: TaskArtifact['kind'],
  bytes: Uint8Array,
  contentType?: string,
  taskMode?: GenerationMode,
): TaskArtifact['kind'] {
  return detectArtifactKindFromBytes(bytes) || inferArtifactKind(url, fallback, contentType, taskMode);
}
