import type * as Path from 'path';

/**
 * A completed download can be reused only when it is already in the directory
 * requested by the current operation. Reusing a file from another directory
 * makes the UI report the new directory while the bytes stay in the old one.
 */
export function isDownloadFileInDirectory(path: typeof Path, filePath: string, saveDir: string): boolean {
  if (!filePath || !saveDir) return false;
  return path.resolve(path.dirname(filePath)) === path.resolve(saveDir);
}
