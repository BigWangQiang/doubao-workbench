import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isDownloadFileInDirectory } from '../../main/utils/downloadPath';

describe('download destination reuse guard', () => {
  it('only reuses a completed file when it is in the requested directory', () => {
    expect(isDownloadFileInDirectory(path, 'C:\\downloads\\video.mp4', 'C:\\downloads')).toBe(true);
    expect(isDownloadFileInDirectory(path, 'C:\\old-downloads\\video.mp4', 'C:\\downloads')).toBe(false);
    expect(isDownloadFileInDirectory(path, '', 'C:\\downloads')).toBe(false);
  });
});
