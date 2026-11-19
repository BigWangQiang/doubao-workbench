const LALOR_PUBLIC_ORIGIN = 'https://yuyan-ai.site';

/**
 * 头像可能来自服务端根相对地址，也可能是主进程已经转换好的 data URL。
 * 渲染层不直接拼接 resource:<id>，避免把需要授权的资源请求暴露给页面。
 */
export function resolveLalorAvatarUrl(value: string | null | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw || raw.startsWith('resource:')) return undefined;
  if (raw.startsWith('data:image/')) return raw;
  try {
    const parsed = new URL(raw, `${LALOR_PUBLIC_ORIGIN}/`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}
