import { describe, expect, it } from 'vitest';
import { getPlatformReferer } from '../../main/utils/platformReferer';

describe('平台媒体 Referer', () => {
  it('优先按账号平台选择来源页', () => {
    expect(getPlatformReferer('dola', 'https://neutral-cdn.example/video.mp4')).toBe('https://www.dola.com/');
    expect(getPlatformReferer('doubao', 'https://neutral-cdn.example/video.mp4')).toBe('https://www.doubao.com/');
  });

  it('账号缺失时只对明确的 Dola 主机回退识别', () => {
    expect(getPlatformReferer(undefined, 'https://media.dola.com/video.mp4')).toBe('https://www.dola.com/');
    expect(getPlatformReferer(undefined, 'https://neutral-cdn.example/video.mp4')).toBe('https://www.doubao.com/');
  });
});
