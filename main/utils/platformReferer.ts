/**
 * 平台媒体请求的来源页。
 *
 * Dola/CDN 会校验 Referer；下载链路不能把豆包来源页写死。优先使用
 * 已绑定账号的平台，账号缺失时再从资源地址的主机名做保守推断。
 */
export type MediaPlatform = 'doubao' | 'dola';

export function getPlatformReferer(platform?: MediaPlatform, resourceUrl?: string): string {
  if (platform === 'dola') return 'https://www.dola.com/';
  if (platform === 'doubao') return 'https://www.doubao.com/';

  if (typeof resourceUrl === 'string') {
    try {
      const hostname = new URL(resourceUrl).hostname.toLowerCase();
      if (hostname === 'dola.com' || hostname.endsWith('.dola.com')) {
        return 'https://www.dola.com/';
      }
    } catch {
      // 无法解析地址时按默认豆包来源页处理；调用方仍会验证 HTTP 响应。
    }
  }
  return 'https://www.doubao.com/';
}
