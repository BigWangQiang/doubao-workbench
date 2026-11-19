import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * A browser-friendly derivative is deliberately kept separate from the
 * downloaded artifact. The source file is never rewritten or renamed.
 */
export interface VideoPreviewResult {
  success: boolean;
  filePath?: string;
  converted?: boolean;
  cached?: boolean;
  error?: string;
}

export interface VideoPreviewOptions {
  /** Optional override used by development builds and tests. */
  ffmpegPath?: string;
  /** Allows tests to provide a fake process without starting ffmpeg. */
  spawnProcess?: (command: string, args: string[]) => ChildProcess;
}

export interface VideoPreviewCacheKey {
  inputPath: string;
  size: number;
  mtimeMs: number;
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.ogv', '.avi', '.mkv']);

function isNonEmptyFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function shortError(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > 500 ? `${normalized.slice(-500)}` : normalized;
}

/**
 * Resolve an ffmpeg executable without assuming that a developer-only PATH
 * entry is available in a packaged Electron process.
 */
export function resolveFfmpegPath(
  explicitOrEnv?: string | NodeJS.ProcessEnv,
  resourcesPath = process.resourcesPath,
  cwdOrEnv: string | NodeJS.ProcessEnv = process.cwd(),
): string {
  const executableName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const env = typeof explicitOrEnv === 'object' && explicitOrEnv !== null
    ? explicitOrEnv
    : typeof cwdOrEnv === 'object' && cwdOrEnv !== null
      ? cwdOrEnv
      : process.env;
  const explicitPath = typeof explicitOrEnv === 'string' ? explicitOrEnv : undefined;
  const cwd = typeof cwdOrEnv === 'string' ? cwdOrEnv : process.cwd();
  const candidates = [
    explicitPath,
    env.DOUBAO_FFMPEG_PATH,
    env.FFMPEG_PATH,
    resourcesPath ? path.join(resourcesPath, 'ffmpeg', executableName) : undefined,
    resourcesPath ? path.join(resourcesPath, 'ffmpeg-static', executableName) : undefined,
    path.join(cwd, executableName),
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && isNonEmptyFile(candidate)) return candidate;
  }

  // Let the operating system resolve a PATH installation. spawn() will return
  // a clear ENOENT error if it is absent.
  return executableName;
}

/** Stable cache path derived from the source path and its current metadata. */
export function getVideoPreviewCachePath(sourcePath: string, cacheDir: string): string {
  let statToken = 'unknown';
  try {
    const stat = fs.statSync(sourcePath);
    statToken = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    // The caller reports the actual missing-file error; keep this helper pure.
  }
  const digest = crypto
    .createHash('sha256')
    .update(`${path.resolve(sourcePath)}:${statToken}`)
    .digest('hex')
    .slice(0, 32);
  return path.join(cacheDir, `video-preview-${digest}.mp4`);
}

/** Backwards-compatible name used by the IPC layer and its unit tests. */
export function getVideoPreviewPath(
  sourcePath: string,
  cacheDir: string,
  key?: VideoPreviewCacheKey,
): string {
  const statToken = key
    ? `${key.size}:${key.mtimeMs}`
    : (() => {
      try {
        const stat = fs.statSync(sourcePath);
        return `${stat.size}:${stat.mtimeMs}`;
      } catch {
        return 'unknown';
      }
    })();
  const digest = crypto
    .createHash('sha256')
    .update(`${path.resolve(sourcePath)}:${statToken}`)
    .digest('hex')
    .slice(0, 32);
  return path.join(cacheDir, `video-preview-${digest}.mp4`);
}

/**
 * H.264/AAC + faststart is broadly playable by Chromium/Electron on Windows.
 * Mapping only the first video/audio streams avoids accidentally copying
 * platform-specific data streams from a downloaded container.
 */
export function buildVideoPreviewArgs(sourcePath: string, outputPath: string): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ];
}

/**
 * Create/reuse a browser-compatible preview derivative.
 *
 * This function has no dependency on Electron, which keeps the conversion
 * policy testable and lets the IPC layer choose the cache directory.
 */
export async function prepareVideoPreview(
  sourcePath: string,
  cacheDir: string,
  options: VideoPreviewOptions = {},
): Promise<VideoPreviewResult> {
  const normalizedSource = typeof sourcePath === 'string' ? sourcePath.trim() : '';
  if (!normalizedSource) return { success: false, error: '视频路径为空' };
  if (!VIDEO_EXTENSIONS.has(path.extname(normalizedSource).toLowerCase())) {
    return { success: false, error: '不支持该视频文件格式' };
  }
  if (!isNonEmptyFile(normalizedSource)) {
    return { success: false, error: '本地视频不存在或文件为空' };
  }

  const outputPath = getVideoPreviewCachePath(normalizedSource, cacheDir);
  if (isNonEmptyFile(outputPath)) {
    return { success: true, filePath: outputPath, converted: true, cached: true };
  }

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `无法创建预览缓存目录：${shortError(message)}` };
  }

  const command = resolveFfmpegPath(options.ffmpegPath);
  const spawnProcess = options.spawnProcess || ((ffmpeg: string, args: string[]) => spawn(ffmpeg, args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  }));

  return new Promise<VideoPreviewResult>((resolve) => {
    let stderr = '';
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawnProcess(command, buildVideoPreviewArgs(normalizedSource, outputPath));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({ success: false, error: `启动视频兼容转换失败：${shortError(message)}` });
      return;
    }

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { /* best effort */ }
      const detail = error.message.includes('ENOENT')
        ? '未找到 ffmpeg。请安装 ffmpeg，或设置 DOUBAO_FFMPEG_PATH 指向 ffmpeg 可执行文件'
        : shortError(error.message);
      resolve({ success: false, error: `无法生成可播放预览：${detail}` });
    });
    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      if (code === 0 && isNonEmptyFile(outputPath)) {
        resolve({ success: true, filePath: outputPath, converted: true, cached: false });
        return;
      }
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { /* best effort */ }
      const detail = shortError(stderr);
      resolve({
        success: false,
        error: detail ? `视频兼容转换失败：${detail}` : `视频兼容转换失败（ffmpeg 退出码 ${code ?? '未知'}）`,
      });
    });
  });
}

/**
 * Low-level conversion entry point retained for callers that already chose an
 * output path. It rejects with an actionable message and never touches the
 * source file.
 */
export async function transcodeVideoForPreview(
  sourcePath: string,
  outputPath: string,
  options: VideoPreviewOptions = {},
): Promise<void> {
  const command = resolveFfmpegPath(options.ffmpegPath);
  const spawnProcess = options.spawnProcess || ((ffmpeg: string, args: string[]) => spawn(ffmpeg, args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  }));
  await runFfmpeg(command, sourcePath, outputPath, spawnProcess);
}

async function runFfmpeg(
  command: string,
  sourcePath: string,
  outputPath: string,
  spawnProcess: (command: string, args: string[]) => ChildProcess,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawnProcess(command, buildVideoPreviewArgs(sourcePath, outputPath));
    } catch (error: unknown) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      if (code === 0 && isNonEmptyFile(outputPath)) {
        resolve();
        return;
      }
      reject(new Error(shortError(stderr) || `ffmpeg 退出码 ${code ?? '未知'}`));
    });
  });
}
