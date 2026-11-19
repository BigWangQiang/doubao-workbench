import { describe, expect, it } from 'vitest';
import {
  buildVideoPreviewArgs,
  getVideoPreviewCachePath,
  resolveFfmpegPath,
} from '../../main/utils/videoPreview';

describe('video preview helpers', () => {
  it('generates a stable cache path for the same source metadata', () => {
    const source = 'C:\\videos\\sample.mp4';
    expect(getVideoPreviewCachePath(source, 'C:\\cache')).toBe(
      getVideoPreviewCachePath(source, 'C:\\cache'),
    );
    expect(getVideoPreviewCachePath(source, 'C:\\cache')).toMatch(/\.mp4$/);
  });

  it('prefers an existing configured ffmpeg path and falls back to PATH', () => {
    expect(resolveFfmpegPath({ DOUBAO_FFMPEG_PATH: 'C:\\missing\\ffmpeg.exe' }, 'C:\\missing-resources', 'C:\\missing-cwd')).toBe('ffmpeg.exe');
  });

  it('uses H.264/AAC and faststart for the derivative', () => {
    const args = buildVideoPreviewArgs('input.mp4', 'output.mp4');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart']));
  });
});
