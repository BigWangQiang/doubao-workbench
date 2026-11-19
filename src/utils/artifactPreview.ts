import type { DownloadJob } from '@doubao-studio/contracts';

export interface DecodedDataUrl {
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * 返回已完成下载任务对应的本地文件路径。
 *
 * 产物中心只把明确标记为 done 且存在路径的记录当作本地预览源，
 * 避免使用仍在下载、失败或历史残缺记录中的路径。
 */
export function getLocalArtifactPath(
  job?: Pick<DownloadJob, 'status' | 'filePath'>,
): string | undefined {
  if (!job || job.status !== 'done' || !job.filePath) return undefined;
  const filePath = job.filePath.trim();
  return filePath || undefined;
}

/**
 * Decode an IPC data URL without using fetch(). The renderer CSP may reject
 * data: in connect-src even when the payload is otherwise valid.
 */
export function decodeDataUrl(dataUrl: string): DecodedDataUrl {
  const commaIndex = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || commaIndex < 0) {
    throw new Error('数据 URL 格式无效');
  }

  const metadata = dataUrl.slice(5, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const metadataParts = metadata.split(';');
  const mimeType = metadataParts[0] || 'application/octet-stream';
  const isBase64 = metadataParts.some((part) => part.toLowerCase() === 'base64');
  if (!isBase64) {
    return {
      mimeType,
      bytes: new TextEncoder().encode(decodeURIComponent(payload)),
    };
  }

  const binary = globalThis.atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { mimeType, bytes };
}
