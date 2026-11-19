import {
  contentTypeFromArtifactBytes,
  detectArtifactKindFromBytes,
  inferArtifactKind,
  inferArtifactKindFromBytes,
} from '../../main/utils/artifactKind';
import {
  getImageArtifactFormatRank,
  getImageArtifactIdentity,
  normalizeImageArtifactUrls,
} from '../../src/utils/artifactKind';
import { describe, expect, it } from 'vitest';

describe('inferArtifactKind', () => {
  it('MIME 优先于视频任务回退', () => {
    expect(inferArtifactKind('https://cdn.example.com/media?id=1', 'video', 'image/png', 'video')).toBe('image');
  });

  it('本地文件扩展名可识别视频任务中的海报图', () => {
    expect(inferArtifactKind('C:\\Downloads\\poster.webp', 'video')).toBe('image');
  });

  it('签名 URL 的扩展名会忽略 query/hash', () => {
    expect(inferArtifactKind('https://cdn.example.com/render.mp4?Expires=123#x', 'image')).toBe('video');
  });

  it('识别 Dola 常见 mime_type=video_mp4/image_jpeg 查询参数', () => {
    expect(inferArtifactKind('https://v16-dola.dola.com/asset?mime_type=video_mp4', 'image')).toBe('video');
    expect(inferArtifactKind('https://v16-dola.dola.com/asset?mime_type=image_jpeg', 'video')).toBe('image');
  });

  it('完整文件签名优先于错误的 MIME 与任务模式', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const mp4 = Uint8Array.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(detectArtifactKindFromBytes(png)).toBe('image');
    expect(contentTypeFromArtifactBytes(png)).toBe('image/png');
    expect(inferArtifactKindFromBytes('https://cdn.example.com/no-extension', 'video', png, 'video/mp4', 'video')).toBe('image');
    expect(inferArtifactKindFromBytes('https://cdn.example.com/no-extension', 'image', mp4, 'image/png', 'image')).toBe('video');
  });
});

describe('normalizeImageArtifactUrls', () => {
  const png = 'https://p6-flow-imagex-sign.byteimg.com/tos/asset.jpeg~tplv-demo-image_raw.png?x-expires=10&x-signature=png-sign&rcl=asset-1';
  const heic = 'https://p3-flow-imagex-sign.byteimg.com/tos/asset.jpeg~tplv-demo-image_raw.heic?x-expires=10&x-signature=heic-sign&rcl=asset-1';
  const other = 'https://p6-flow-imagex-sign.byteimg.com/tos/other.jpeg~tplv-demo-image_raw.png?x-expires=10&x-signature=other-sign&rcl=asset-2';

  it('同一 image_raw 资源的 PNG/HEIC 只保留可预览格式', () => {
    expect(getImageArtifactIdentity(png)).toBe(getImageArtifactIdentity(heic));
    expect(getImageArtifactFormatRank(png)).toBeLessThan(getImageArtifactFormatRank(heic));
    expect(normalizeImageArtifactUrls([heic, png, other])).toEqual([png, other]);
  });

  it('不同资源仍分别保留', () => {
    expect(normalizeImageArtifactUrls([png, other])).toEqual([png, other]);
  });
});
