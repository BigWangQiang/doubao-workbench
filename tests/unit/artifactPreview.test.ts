import { describe, expect, it } from 'vitest';
import { decodeDataUrl, getLocalArtifactPath } from '../../src/utils/artifactPreview';

describe('getLocalArtifactPath', () => {
  it('只返回成功下载记录的非空本地路径', () => {
    expect(getLocalArtifactPath({ status: 'done', filePath: '  C:\\video.mp4  ' })).toBe('C:\\video.mp4');
    expect(getLocalArtifactPath({ status: 'downloading', filePath: 'C:\\video.mp4' })).toBeUndefined();
    expect(getLocalArtifactPath({ status: 'failed', filePath: 'C:\\video.mp4' })).toBeUndefined();
    expect(getLocalArtifactPath({ status: 'done', filePath: '   ' })).toBeUndefined();
  });

  it('缺少下载记录或路径时回退到远程地址', () => {
    expect(getLocalArtifactPath(undefined)).toBeUndefined();
    expect(getLocalArtifactPath({ status: 'done' })).toBeUndefined();
  });
});

describe('decodeDataUrl', () => {
  it('decodes base64 payloads while retaining the MIME type', () => {
    const result = decodeDataUrl('data:video/mp4;base64,AAEC/w==');
    expect(result.mimeType).toBe('video/mp4');
    expect(Array.from(result.bytes)).toEqual([0, 1, 2, 255]);
  });

  it('decodes URL-encoded non-base64 payloads', () => {
    const result = decodeDataUrl('data:text/plain;charset=utf-8,hello%20world');
    expect(result.mimeType).toBe('text/plain');
    expect(new TextDecoder().decode(result.bytes)).toBe('hello world');
  });

  it('rejects malformed data URLs', () => {
    expect(() => decodeDataUrl('not-a-data-url')).toThrow('数据 URL 格式无效');
  });
});
