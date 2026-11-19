/**
 * main/ipc/tasks.ts
 * 任务调度 IPC 处理器
 * 负责：任务队列管理、状态流转、批量操作、生成模式
 */

import { app, dialog, net, session } from 'electron';
import { ipcMain } from '../security/trustedIpc';
import { readJSON, writeJSON } from '../utils/store';
import { normalizeTasks, normalizeDownloadJobs } from '../utils/persistenceNormalization';
import {
  contentTypeFromArtifactBytes,
  inferArtifactKind,
  inferArtifactKindFromBytes,
} from '../utils/artifactKind';
import { validateDownloadResponse, classifyDownloadException } from '../utils/downloadValidation';
import {
  DOWNLOAD_MAX_ATTEMPTS,
  getDownloadRetryDelayMs,
  isRetryableDownloadError,
  isRetryableDownloadStatus,
  shouldRetryDownloadAttempt,
} from '../utils/downloadRetry';
import { resolvePublicShareMedia } from '../utils/publicShareMedia';
import { v4 as uuidv4 } from 'uuid';
import { getDefaultProjectId } from './projects';
import { replaceIpcHandlers } from './lifecycle';
import { recoverInterruptedDownloads, removeExactDownloadPart } from '../utils/downloadRecovery';
import { isDownloadFileInDirectory } from '../utils/downloadPath';
import { getPlatformReferer } from '../utils/platformReferer';
import {
  getDolaDirectDownloadUrl,
  shouldRetryDolaDownloadWithoutAccountSession,
} from '../utils/artifactDownloadFallback';
import {
  prepareVideoPreview,
  resolveFfmpegPath,
} from '../utils/videoPreview';
import { selectTasksBackedByCompletedDownloads } from '../utils/taskStoreRecovery';
import { listLocalAssets, registerDownloadedAsset, resolveAssetFile } from '../utils/localAssetStore';
import { getBinding } from '../utils/localManagerStore';
import { proxyRules } from '../utils/accountProxy';
import { resolveAccountSessionRouteAsync } from '../utils/sessionProxyRouter';
import { TaskEventStream } from '../core/TaskEventStream';
import { TaskRepository } from '../core/TaskRepository';
import { TaskService } from '../core/TaskService';
import type { ArtifactProbeResult } from '../core/TaskService';
import { selectAccountFromLocalPluginPool } from '../utils/localPluginAccountPool';
import { hasYuyanKey, requireYuyanGenerationAccess, yuyanGenerationAccessError } from './yuyanAuth';
import { YUYAN_CUSTOMER_API } from '../config/yuyanPlatform';
import type {
  Account,
  Task,
  TaskErrorInfo,
  TaskRunSnapshot,
  TaskRunRecord,
  TaskLock,
  TaskArtifact,
  DownloadJob,
  TaskAddParams,
  TaskAssignParams,
  TaskUpdateStatusParams,
  TaskRegisterArtifactParams,
  TaskUpdateRuntimeParams,
  TaskAcquireLockParams,
  TaskRenewLockParams,
  TaskReleaseLockParams,
  TaskImportCsvParams,
  TaskUpdateInput,
  TaskIdParams,
  TaskRetryAfterQuotaExhaustionParams,
  TaskRetryAfterPreSubmitFailureParams,
  CompletedOutput,
  TaskDownloadOutputsParams,
  TaskDownloadOutputsResult,
  TaskValidateArtifactParams,
  TaskValidateArtifactResult,
  TaskSaveAdapterReportParams,
} from '@doubao-studio/contracts';

// ==================== 类型定义 ====================

// 枚举/联合类型、领域模型接口和 IPC DTO 已迁移至 @doubao-studio/contracts。
// 此处通过 import type 引用，不产生运行时依赖。

export type {
  Task,
  TaskErrorInfo,
  TaskRunSnapshot,
  TaskRunRecord,
  TaskLock,
  TaskArtifact,
  DownloadJob,
};

// ==================== 数据持久化 ====================

const DOWNLOAD_STORE_FILE = 'downloads.json';
let downloadRecoveryApplied = false;
export const taskEventStream = new TaskEventStream();
const videoPreviewJobs = new Map<string, Promise<string>>();

function accountSessionPartition(account: { partition: string; platform?: 'doubao' | 'dola' }): string {
  const platform = account.platform === 'dola' ? 'dola' : 'doubao';
  return `persist:${platform}_${account.partition}`;
}

type StoredAccount = { id: string; partition: string; platform?: 'doubao' | 'dola' };

async function applyBoundAccountDownloadRoute(account: StoredAccount | undefined, accountSession: Electron.Session): Promise<void> {
  if (!account) return;
  const resolved = await resolveAccountSessionRouteAsync(account.id, account.platform === 'dola' ? 'dola' : 'doubao');
  if (!resolved.config) return;
  await accountSession.setProxy({ proxyRules: proxyRules(resolved.config), proxyBypassRules: '<local>' });
  await accountSession.closeAllConnections().catch(() => undefined);
}

function isRetryableDolaNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|CONNECTION_REFUSED|NETWORK_CHANGED)|fetch failed|socket hang up/i.test(message);
}

async function waitForRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 单次干净网络请求；总重试次数由 fetchArtifactBodyWithRetry 统一控制。 */
async function fetchDolaDirect(
  directUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  return net.fetch(directUrl, { headers, signal });
}

/**
 * Fetch and consume one artifact body under a bounded retry policy. Reading
 * the body here is intentional: a 200 response with an empty body is a
 * transient CDN failure just like a reset connection and should not create a
 * permanently failed download record on the first attempt.
 */
async function fetchArtifactBodyWithRetry(
  url: string,
  account: StoredAccount | undefined,
  accountSession: Electron.Session,
  headers: Record<string, string>,
  signal: AbortSignal,
  onAttempt?: (attempt: number) => void,
): Promise<{ response: Response; buffer: Buffer }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
    onAttempt?.(attempt);
    try {
      const response = await fetchArtifactWithPlatformFallback(url, account, accountSession, headers, signal);
      // Retry server overload/timeouts without buffering a potentially large
      // error page. The final response is returned for normal validation.
      if (isRetryableDownloadStatus(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        if (shouldRetryDownloadAttempt(attempt, true)) {
          await waitForRetry(signal, getDownloadRetryDelayMs(attempt));
          continue;
        }
        return { response, buffer: Buffer.alloc(0) };
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 && shouldRetryDownloadAttempt(attempt, true)) {
        await waitForRetry(signal, getDownloadRetryDelayMs(attempt));
        continue;
      }
      return { response, buffer };
    } catch (error: unknown) {
      lastError = error;
      if (signal.aborted || !shouldRetryDownloadAttempt(attempt, isRetryableDownloadError(error))) {
        throw error;
      }
      await waitForRetry(signal, getDownloadRetryDelayMs(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('产物下载失败');
}

/**
 * Dola 的签名媒体地址通常需要账号配置的海外代理。先使用账号 Session，
 * 让 Dola 的代理和登录态生效；只有 Session 被扩展/客户端本地拦截或网络
 * 失败时，才回退到干净的 Electron 网络上下文。两条路径共享外层的有界
 * 重试计数，避免一次 URL 被隐式重试多于三次。
 */
async function fetchArtifactWithPlatformFallback(
  url: string,
  account: StoredAccount | undefined,
  accountSession: Electron.Session,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  const directUrl = account?.platform === 'dola' ? getDolaDirectDownloadUrl(url) : url;
  // Dola signed CDN URLs can already be HTTPS. The platform, rather than
  // an HTTP-to-HTTPS rewrite, determines whether the clean network path is
  // preferred so both URL forms avoid the account Session interceptor.
  const isDolaDirect = account?.platform === 'dola';
  if (!isDolaDirect) return accountSession.fetch(url, { headers, signal });

  let sessionResponse: Response | undefined;
  let sessionError: unknown;
  if (account) {
    try {
      sessionResponse = await accountSession.fetch(url, { headers, signal });
      if (sessionResponse.ok) return sessionResponse;
      // Keep terminal status information as a fallback if the clean request
      // also fails; the outer validator will produce the useful HTTP reason.
      await sessionResponse.body?.cancel().catch(() => undefined);
    } catch (error: unknown) {
      sessionError = error;
    }
  }

  try {
    const directResponse = await fetchDolaDirect(directUrl, headers, signal);
    if (directResponse.ok || !sessionResponse) return directResponse;
    await directResponse.body?.cancel().catch(() => undefined);
    return sessionResponse;
  } catch (directError: unknown) {
    // A client-side block is the known case where the account Session cannot
    // consume an already-authorized CDN response. Network errors are also
    // safe to expose to the outer bounded retry loop. Non-network session
    // failures retain their original error instead of being hidden.
    if (sessionResponse) return sessionResponse;
    if (sessionError && !shouldRetryDolaDownloadWithoutAccountSession(account?.platform, url, sessionError)
      && !isRetryableDolaNetworkError(sessionError)) {
      throw sessionError;
    }
    throw directError;
  }
}

const taskRepository = new TaskRepository({
  read: (filename, fallback) => readJSON(filename, fallback),
  write: (filename, data) => writeJSON(filename, data),
  normalize: normalizeTasks,
  defaultProjectId: getDefaultProjectId,
  events: taskEventStream,
  warn: (message, details) => console.warn(message, details),
});
export const taskService = new TaskService({
  store: taskRepository,
  generationAccessError: yuyanGenerationAccessError,
  defaultProjectId: getDefaultProjectId,
  accountPlatformById: (accountId) => {
    const account = readJSON<Array<{ id: string; platform?: 'doubao' | 'dola' }>>('accounts.json', [])
      .find((item) => item.id === accountId);
    if (!account) return undefined;
    return account.platform === 'dola' ? 'dola' : 'doubao';
  },
  probeArtifact: createArtifactProbe(),
  basename: (value) => require('path').basename(value),
});

export interface LalorLocalArtifactFile {
  filePath: string;
  kind: TaskArtifact['kind'];
  contentType?: string;
  bytes?: number;
}

/**
 * Lalor 远程任务仍通过同一个 TaskService 写入，避免第二套任务文件写入器。
 * 该入口仅供主进程桥接服务调用，不注册为 renderer IPC。
 */
export function createTaskForLalor(params: TaskAddParams): Task {
  const result = taskService.create(params, 'lalor');
  if (!result.success || result.data.length !== 1) {
    throw new Error(result.success ? 'Lalor 本地任务创建数量异常' : result.error);
  }
  return result.data[0];
}

/**
 * 字字动画插件任务也必须通过同一个 TaskService 创建和自动指派。
 * 这样图片、视频任务共享账号平台校验、队列、额度、下载和失败回传，
 * 插件本身只选择豆包/Dola 账号池，不接触具体账号、tasks.json 或渲染层调度细节。
 */
export function createTasksForLocalPlugin(params: TaskAddParams): Task[] {
  const created = taskService.create(params, 'lalor');
  if (!created.success) throw new Error(created.error);
  const assigned: Task[] = [];
  const accounts = readJSON<Account[]>('accounts.json', []);
  try {
    for (const task of created.data) {
      // 每次都读取最新队列负载；批量任务和多个独立插件请求都会优先分散到空闲账号。
      const account = selectAccountFromLocalPluginPool(accounts, listTasksForLocalControl(), params);
      if (!account) throw new Error(`当前${params.targetPlatform === 'dola' ? 'Dola' : '豆包'}账号池没有可自动调度的账号`);
      const result = taskService.assign({ taskId: task.id, accountId: account.id });
      if (!result.success) throw new Error(result.error);
      const latest = getTaskForLalor(task.id);
      if (!latest) throw new Error('插件任务创建后无法读取');
      assigned.push(latest);
    }
    return assigned;
  } catch (error) {
    // 指派失败时清理本次仍未执行的任务，避免插件重试产生孤儿队列项。
    for (const task of created.data) taskService.delete(task.id);
    throw error;
  }
}

/** 本机插件 API 的媒体路径校验；只接受存在的常规媒体文件。 */
export function isLocalMediaFileForPlugin(filePath: string, kind: 'image' | 'video' | 'audio'): boolean {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const extension = path.extname(filePath).toLowerCase();
  const extensions: Record<typeof kind, string[]> = {
    image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'],
    video: ['.mp4', '.m4v', '.mov', '.webm', '.ogv', '.avi'],
    audio: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'],
  };
  if (!extensions[kind].includes(extension)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return false;
    const maxBytes = kind === 'video' ? 2 * 1024 * 1024 * 1024 : 512 * 1024 * 1024;
    return stat.size <= maxBytes;
  } catch {
    return false;
  }
}

/** 通过正式 TaskService 将 Lalor 任务锁定到当前会员自己的本地账号。 */
export function assignTaskForLalor(taskId: string, accountId: string): void {
  const result = taskService.assign({ taskId, accountId });
  if (!result.success) throw new Error(result.error);
}

/** 返回主进程中的最新任务快照，不暴露任务文件写权限。 */
export function getTaskForLalor(taskId: string): Task | null {
  const result = taskService.getTasks();
  if (!result.success) throw new Error(result.error);
  return result.data.find((task) => task.id === taskId) || null;
}

/** 服务端取消租约时，通过正式任务服务把对应本地任务标记为取消。 */
export function cancelTaskForLalor(taskId: string, message: string): void {
  const result = taskService.updateStatus({ taskId, status: 'cancelled', result: message });
  if (!result.success) throw new Error(result.error);
}

/**
 * 只返回已经落盘并仍存在的本地产物。平台 URL 或失效下载记录不会被上传
 * 到 Lalor，确保回传的是产物中心中的真实无水印文件。
 */
export function listTaskArtifactFilesForLalor(taskId: string): LalorLocalArtifactFile[] {
  const fs = require('fs') as typeof import('fs');
  const latestByPath = new Map<string, LalorLocalArtifactFile>();
  const seenRemoteUrls = new Set<string>();

  const addCandidate = (filePath: string, candidate: LalorLocalArtifactFile, remoteUrl?: string): void => {
    const resolved = require('path').resolve(filePath) as string;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size <= 0 || latestByPath.has(resolved)) return;
      const normalizedUrl = typeof remoteUrl === 'string' ? remoteUrl.trim() : '';
      // A download record and its local-assets copy represent one artifact;
      // prefer the original path when it still exists and avoid double upload.
      if (normalizedUrl && seenRemoteUrls.has(normalizedUrl)) return;
      latestByPath.set(resolved, {
        ...candidate,
        filePath: resolved,
        bytes: stat.size,
      });
      if (normalizedUrl) seenRemoteUrls.add(normalizedUrl);
    } catch {
      // 文件被用户移动或清理后不再作为可回传产物。
    }
  };

  for (const job of loadDownloadJobs()) {
    if (job.taskId !== taskId || job.status !== 'done' || !job.filePath) continue;
    addCandidate(job.filePath, {
      filePath: job.filePath,
      kind: job.kind || (job.mode === 'video' ? 'video' : job.mode === 'image' ? 'image' : 'file'),
      contentType: job.contentType,
    }, job.url);
  }

  // 扩展归档会把稳定副本写入受控目录。只有元数据带有同一个正式
  // taskId 才允许作为回传来源；历史手动资产不会被自动猜挂到任务。
  for (const asset of listLocalAssets()) {
    if (asset.taskId !== taskId || asset.taskStatus !== 'success') continue;
    const localFilePath = resolveAssetFile(asset.assetId);
    if (!localFilePath) continue;
    addCandidate(localFilePath, {
      filePath: localFilePath,
      kind: asset.kind,
    }, asset.remoteUrl);
  }

  return [...latestByPath.values()];
}

/** 仅供同进程本机控制面只读使用；返回脱敏由控制面负责。 */
export function listTasksForLocalControl(): Task[] {
  const result = taskService.getTasks();
  if (!result.success) throw new Error(result.error);
  return result.data;
}

type CsvImportResponse = {
  success: boolean;
  tasks?: Task[];
  batchId?: string;
  imported?: number;
  skipped?: number;
  errors?: string[];
  error?: string;
};

/** 文件入口共用同一 Core 导入边界；路径、大小和扩展名全部 fail-closed。 */
export function importCsvFile(filePath: string, projectId?: string): CsvImportResponse {
  try {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const resolved = path.resolve(filePath);
    if (path.extname(resolved).toLowerCase() !== '.csv') return { success: false, error: '仅支持 CSV 文件' };
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 10 * 1024 * 1024) {
      return { success: false, error: 'CSV 文件为空或超过 10MB 上限' };
    }
    const raw = fs.readFileSync(resolved, 'utf-8');
    const accounts = readJSON<Array<{ id: string; name: string; platform?: 'doubao' | 'dola' }>>('accounts.json', []);
    const result = taskService.importCsv({ text: raw, accounts, projectId });
    if (!result.success) return result;
    return {
      success: true,
      tasks: result.data.tasks,
      batchId: result.data.batchId,
      imported: result.data.imported,
      skipped: result.data.skipped,
      errors: result.data.errors,
    };
  } catch {
    return { success: false, error: 'CSV 导入失败，请检查文件格式和数据目录状态' };
  }
}

/** 产物网络探针：Electron session/partition 探测由 IPC 边界提供，Core 只消费结果 */
function createArtifactProbe(): (artifact: TaskArtifact, assignedAccountId: string | null) => Promise<ArtifactProbeResult> {
  return async (artifact, assignedAccountId) => {
    const fs = require('fs') as typeof import('fs');
    // A completed local download is the authoritative artifact for the
    // desktop workflow. Do not let a later CDN/session check turn it red just
    // because a signed URL has expired or an extension blocked the request.
    const localJob = loadDownloadJobs()
      .slice()
      .reverse()
      .find((job) => (
        job.status === 'done' &&
        job.url === artifact.url &&
        typeof job.filePath === 'string' &&
        fs.existsSync(job.filePath)
      ));
    if (localJob?.filePath) {
      try {
        const stat = fs.statSync(localJob.filePath);
        if (stat.isFile() && stat.size > 0) {
          // A local download carries a stronger type signal than its parent
          // task mode. This matters for poster images emitted by video tasks.
          const localKind = inferArtifactKind(localJob.filePath, artifact.kind, undefined);
          if (localKind !== artifact.kind) artifact.kind = localKind;
          const contentType = localKind === 'video' ? 'video/mp4'
            : localKind === 'image' ? 'image/*' : 'application/octet-stream';
          return {
            kind: 'response',
            statusCode: 200,
            contentType,
            contentLength: stat.size,
          };
        }
      } catch {
        // Fall through to the network probe when the local file disappeared.
      }
    }
    const accounts = readJSON<StoredAccount[]>('accounts.json', []);
    const account = accounts.find((item) => item.id === assignedAccountId);
    const accountSession = account ? session.fromPartition(accountSessionPartition(account)) : session.defaultSession;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      await applyBoundAccountDownloadRoute(account, accountSession);
      const response = await fetchArtifactWithPlatformFallback(
        artifact.url,
        account,
        accountSession,
        {
          Referer: getPlatformReferer(account?.platform, artifact.url),
          Range: 'bytes=0-0',
        },
        controller.signal,
      );
      await response.body?.cancel();
      return {
        kind: 'response',
        statusCode: response.status,
        contentType: response.headers.get('content-type') || undefined,
        contentLength: Number(response.headers.get('content-length') || 0) || undefined,
      };
    } catch (err: any) {
      return err?.name === 'AbortError'
        ? { kind: 'timeout' }
        : { kind: 'error', message: err?.message || '未知网络错误' };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 读取下载记录（含运行时归一化 + 中断恢复） */
function loadDownloadJobs(): DownloadJob[] {
  const raw = readJSON<unknown>(DOWNLOAD_STORE_FILE, []);
  const result = normalizeDownloadJobs(raw);
  // 仅在归一化确实改变数据时写回磁盘
  if (result.changed) {
    writeJSON(DOWNLOAD_STORE_FILE, result.data);
  }
  if (result.warnings.length > 0) {
    console.warn('[Downloads] 数据归一化告警:', result.warnings);
  }
  const jobs = result.data;
  // 下载中断恢复：将上次进程遗留的 'downloading' 状态标记为 'failed'
  if (!downloadRecoveryApplied) {
    downloadRecoveryApplied = true;
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const recovery = recoverInterruptedDownloads(fs, path, jobs, new Date().toISOString());
    if (recovery.recovered > 0) writeJSON(DOWNLOAD_STORE_FILE, jobs);
  }
  return jobs;
}

function saveDownloadJobs(jobs: DownloadJob[]): boolean {
  return writeJSON(DOWNLOAD_STORE_FILE, jobs.slice(-1000));
}

/** 下载记录是任务恢复和产物中心的依据；关键状态写入失败时必须 fail-closed。 */
function ensureDownloadJobsSaved(jobs: DownloadJob[]): void {
  if (!saveDownloadJobs(jobs)) throw new Error('下载记录保存失败，请检查本地数据目录和磁盘空间');
}

function isManualDownloadTask(taskId: string): boolean {
  return /^manual-/i.test(taskId);
}

/** 统计去重后的下载请求，供 IPC 异常返回准确的 failed 数。 */
function countUniqueDownloadRequests(outputs: readonly CompletedOutput[]): number {
  const keys = new Set<string>();
  for (const task of outputs) {
    for (const rawUrl of task.outputs) {
      const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
      keys.add(`${task.taskId}\u0000${url}`);
    }
  }
  return keys.size;
}

/**
 * Recover a task list that was persisted as an empty array while completed
 * local artifacts still prove that a task existed. The replacement goes
 * through TaskRepository; an empty store without a matching completed file is
 * left untouched.
 */
function recoverTasksFromBackupWhenDownloadsExist(downloads: DownloadJob[]): void {
  try {
    const current = taskRepository.read();
    if (current.length > 0) return;

    const backupRaw = readJSON<unknown>('tasks.json.bak', []);
    const backup = normalizeTasks(backupRaw, getDefaultProjectId()).data;
    const fs = require('fs') as typeof import('fs');
    const candidates = selectTasksBackedByCompletedDownloads(
      current,
      backup,
      downloads,
      (filePath) => fs.existsSync(filePath),
    );
    if (candidates.length === 0) return;

    current.push(...candidates);
    if (!taskRepository.replace(current)) {
      console.warn('[Tasks] 备份任务恢复写入失败');
      return;
    }
    console.warn(`[Tasks] 已从备份恢复 ${candidates.length} 个仍有本地产物的任务`);
  } catch (error: unknown) {
    console.warn('[Tasks] 备份任务恢复跳过:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * 将旧版手动提取留下的成功下载记录归档到正式任务。
 * 只有同账号下恰好一个同平台视频任务时才自动绑定，避免把文件猜挂到错误任务。
 */
function adoptOrphanedManualDownloads(): DownloadJob[] {
  const jobs = loadDownloadJobs();
  const taskResult = taskService.getTasks();
  if (!taskResult.success) return jobs;
  const accounts = readJSON<Array<{ id: string; platform?: 'doubao' | 'dola' }>>('accounts.json', []);
  let changed = false;
  for (const job of jobs) {
    if (job.status !== 'done' || !/^manual-/i.test(job.taskId) || job.mode !== 'video') continue;
    const account = accounts.find((item) => item.id === job.accountId);
    const accountPlatform = account?.platform === 'dola' ? 'dola' : 'doubao';
    const candidates = taskResult.data.filter((task) =>
      task.mode === 'video' &&
      task.assignedAccountId === job.accountId &&
      (task.targetPlatform || accountPlatform) === accountPlatform,
    );
    if (candidates.length !== 1) continue;
    const task = candidates[0];
    const registered = taskService.registerArtifact({
      taskId: task.id,
      url: job.url,
      source: 'manual',
      conversationUrl: task.runtime?.conversationUrl,
      runId: task.runtime?.runId,
    });
    if (!registered.success) continue;
    job.taskId = task.id;
    job.updatedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) saveDownloadJobs(jobs);
  return jobs;
}

function getAvailableDownloadPath(fs: typeof import('fs'), path: typeof import('path'), saveDir: string, fileName: string): string {
  const parsed = path.parse(fileName);
  let candidate = path.join(saveDir, fileName);
  for (let suffix = 2; fs.existsSync(candidate); suffix++) {
    candidate = path.join(saveDir, `${parsed.name}-${suffix}${parsed.ext}`);
  }
  return candidate;
}

/** 只读取文件头用于魔数识别，避免为分类而把大型视频整体读入内存。 */
function readArtifactSignature(fs: typeof import('fs'), filePath: string, maxBytes = 512): Uint8Array {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(descriptor, buffer, 0, maxBytes, 0);
    return new Uint8Array(buffer.subarray(0, bytesRead));
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Keep the existing download/task registration path authoritative while also
 * writing a stable local-manager copy for future consumers such as Lalor.
 * Indexing is deliberately best-effort so a secondary export failure cannot
 * change the already-tested download result or task state.
 */
function registerLocalManagerAsset(job: DownloadJob, task: Pick<Task, 'mode'>, url: string, kind: TaskArtifact['kind']): void {
  if (!job.filePath) return;
  // 并发分镜直接引用用户下载目录，不再复制整段视频到内部素材目录。
  if (job.taskId && getTaskForLalor(job.taskId)?.canvasBatch) return;
  try {
    registerDownloadedAsset({
      assetId: job.id,
      taskId: job.taskId || undefined,
      kind,
      sourceFilePath: job.filePath,
      remoteUrl: url,
      generatedAt: job.createdAt,
      accountId: job.accountId || undefined,
      proxyId: job.accountId ? (getBinding(job.accountId)?.proxyId || undefined) : undefined,
      taskStatus: 'success',
      tags: ['local-download', task.mode],
    });
  } catch (error: unknown) {
    // The original download remains valid and recoverable from downloads.json.
    // Do not echo URLs, cookies or proxy credentials into diagnostics.
    console.warn('[Tasks] 本地产物出口登记失败:', error instanceof Error ? error.message : '未知错误');
  }
}

/** Backfill the standard local output for downloads created before this index existed. */
function adoptCompletedDownloadsAsLocalAssets(jobs: readonly DownloadJob[]): void {
  for (const job of jobs) {
    if (job.status !== 'done' || !job.filePath) continue;
    const fallbackKind: TaskArtifact['kind'] = job.mode === 'video' ? 'video' : job.mode === 'image' ? 'image' : 'file';
    const kind = job.kind || inferArtifactKind(job.filePath, fallbackKind, job.contentType, job.mode);
    registerLocalManagerAsset(job, { mode: job.mode }, job.url, kind);
  }
}

// ==================== IPC 处理器注册 ====================

const TASK_IPC_CHANNELS = [
  'tasks:list', 'tasks:add', 'tasks:assign', 'tasks:updateStatus', 'tasks:registerArtifact', 'tasks:update',
  'tasks:delete', 'tasks:retry', 'tasks:retryAfterQuotaExhaustion', 'tasks:retryAfterPreSubmitFailure', 'tasks:batchPause', 'tasks:updateRuntime',
  'tasks:acquireLock', 'tasks:renewLock', 'tasks:importCsv', 'tasks:releaseLock',
  'tasks:getCompletedOutputs', 'tasks:selectImages', 'tasks:selectVideos', 'tasks:selectAudio', 'tasks:selectAudios',
  'tasks:readFileAsBase64', 'tasks:prepareVideoPreview', 'tasks:downloadOutputs', 'tasks:downloadPublicShareMedia', 'tasks:listDownloads',
  'tasks:exportDiagnostics', 'tasks:validateArtifact', 'tasks:saveAdapterReport',
  'tasks:selectAdapterRules', 'settings:get', 'settings:save', 'tasks:selectSaveDir',
  'workbenchApi:get', 'workbenchApi:save', 'workbenchApi:clear',
] as const;

let outputDownloadQueue: Promise<unknown> = Promise.resolve();
/** 所有下载共用串行写入队列，避免多个批次覆盖 downloads.json 的快照。 */
export function downloadTaskOutputs(params: TaskDownloadOutputsParams): Promise<TaskDownloadOutputsResult> {
  const next = outputDownloadQueue.catch(() => undefined).then(() => performTaskDownloads(params));
  outputDownloadQueue = next;
  return next;
}

async function performTaskDownloads(params: TaskDownloadOutputsParams): Promise<TaskDownloadOutputsResult> {
  let downloadedCount = 0;
  const failures: string[] = [];
  const jobIds: string[] = [];
  let saveDir: string | undefined;
  let requestedCount = 0;
  try {
    requestedCount = countUniqueDownloadRequests(params.outputs);
    const fs = require('fs');
    const path = require('path');
    const { app } = require('electron');

    // 默认下载目录；即使调用方没有显式传 saveDir，也要回读设置页保存的目录。
    const defaultDir = path.join(app.getPath('downloads'), '豆包工作室产物');
    let configuredSaveDir = typeof params.saveDir === 'string' ? params.saveDir.trim() : '';
    if (!configuredSaveDir) {
      try {
        const settingsFile = path.join(app.getPath('userData'), 'settings.json');
        if (fs.existsSync(settingsFile)) {
          const storedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { downloadDir?: unknown };
          if (typeof storedSettings.downloadDir === 'string') configuredSaveDir = storedSettings.downloadDir.trim();
        }
      } catch (error: unknown) {
        console.warn('[tasks:downloadOutputs] 读取下载目录设置失败，使用默认目录', error instanceof Error ? error.message : String(error));
      }
    }
    const resolvedSaveDir = configuredSaveDir || defaultDir;
    saveDir = resolvedSaveDir;

    // 确保目录存在
    if (!fs.existsSync(resolvedSaveDir)) {
      fs.mkdirSync(resolvedSaveDir, { recursive: true });
    }

    const jobs = loadDownloadJobs();
    const accounts = readJSON<StoredAccount[]>('accounts.json', []);
    const attemptedUrls = new Set<string>();

    for (const task of params.outputs) {
      const account = accounts.find((item) => item.id === task.accountId);
      const accountSession = account
        ? session.fromPartition(accountSessionPartition(account))
        : session.defaultSession;
      await applyBoundAccountDownloadRoute(account, accountSession);
      for (let outputIndex = 0; outputIndex < task.outputs.length; outputIndex++) {
        const rawUrl = task.outputs[outputIndex];
        const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
        const requestKey = `${task.taskId}\u0000${url}`;
        if (attemptedUrls.has(requestKey)) continue;
        attemptedUrls.add(requestKey);
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(url);
          if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('不支持的地址协议');
        } catch {
          failures.push(`${task.taskId.slice(0, 8)}: 产物地址无效`);
          continue;
        }

        // A retry from the UI or a repeated completion callback must be
        // idempotent. Reuse a verified local file for the same task/URL;
        // this also lets a completed download survive a later state-write
        // retry without creating another copy with a numeric suffix.
        const existing = jobs.slice().reverse().find((candidate) => {
          if (candidate.taskId !== task.taskId || candidate.url !== url || candidate.status !== 'done' || !candidate.filePath) return false;
          // The idempotency key includes the destination directory. A
          // history item from another directory must be downloaded again
          // so the current success message points to a real file there.
          if (!isDownloadFileInDirectory(path, candidate.filePath, resolvedSaveDir)) return false;
          try {
            const stat = fs.statSync(candidate.filePath);
            return stat.isFile() && stat.size > 0;
          } catch {
            return false;
          }
        });
        if (existing) {
          const existingPath = existing.filePath;
          if (!existingPath) {
            failures.push(`${task.taskId.slice(0, 8)}: 下载记录缺少本地文件`);
            continue;
          }
          let existingBytes: number | undefined;
          try { existingBytes = fs.statSync(existingPath).size; } catch { existingBytes = undefined; }
          let signature: Uint8Array = new Uint8Array(0);
          try { signature = readArtifactSignature(fs, existingPath); } catch { /* 旧记录可能只剩路径 */ }
          const fallbackKind = task.mode === 'video' ? 'video' : task.mode === 'image' ? 'image' : 'file';
          const existingKind = inferArtifactKindFromBytes(existingPath, existing.kind || fallbackKind, signature, existing.contentType, task.mode);
          const detectedContentType = existing.contentType || contentTypeFromArtifactBytes(signature)
            || (existingKind === 'video' ? 'video/*' : existingKind === 'image' ? 'image/*' : 'application/octet-stream');
          let existingMetadataChanged = false;
          if (existing.kind !== existingKind) { existing.kind = existingKind; existingMetadataChanged = true; }
          if (!existing.contentType && detectedContentType) { existing.contentType = detectedContentType; existingMetadataChanged = true; }
          if (existingBytes !== undefined && existing.bytes !== existingBytes) { existing.bytes = existingBytes; existingMetadataChanged = true; }
          if (existing.statusCode === undefined) { existing.statusCode = 200; existingMetadataChanged = true; }
          if (existingMetadataChanged) {
            existing.updatedAt = new Date().toISOString();
            if (!saveDownloadJobs(jobs)) {
              failures.push(`${task.taskId.slice(0, 8)}: 下载记录保存失败`);
              continue;
            }
          }
          registerLocalManagerAsset(existing, task, url, existingKind);
          // The file is already durable; repair formal task registration
          // if a previous completion attempt stopped between download and
          // updateStatus. A missing task is allowed for manual-* records,
          // which are conservatively adopted when the center is opened.
          const taskResult = taskService.getTasks();
          const persistedTask = taskResult.success ? taskResult.data.find((item) => item.id === task.taskId) : undefined;
          const manualDownload = isManualDownloadTask(task.taskId);
          if (!taskResult.success && !manualDownload) {
            failures.push(`${task.taskId.slice(0, 8)}: 无法读取正式任务，已停止归档`);
            continue;
          }
          if (!persistedTask && !manualDownload) {
            failures.push(`${task.taskId.slice(0, 8)}: 正式任务不存在，已停止归档`);
            continue;
          }
          if (persistedTask) {
            const registered = taskService.registerArtifact({
              taskId: task.taskId,
              url,
              source: 'network',
              kind: existingKind,
              contentType: detectedContentType,
              contentLength: existingBytes,
              statusCode: existing.statusCode || 200,
              runId: persistedTask.runtime?.runId,
              conversationUrl: persistedTask.runtime?.conversationUrl,
            });
            if (!registered.success) {
              failures.push(`${task.taskId.slice(0, 8)}: ${registered.error || '产物登记失败'}`);
              continue;
            }
          }
          downloadedCount++;
          jobIds.push(existing.id);
          continue;
        }
        const now = new Date().toISOString();
        const job: DownloadJob = {
          id: uuidv4(),
          taskId: task.taskId,
          accountId: task.accountId,
          mode: task.mode,
          url,
          status: 'downloading',
          attempts: 1,
          saveDir: resolvedSaveDir,
          createdAt: now,
          updatedAt: now,
        };
        jobs.push(job);
        if (!saveDownloadJobs(jobs)) {
          job.status = 'failed';
          job.error = '下载记录保存失败，请检查本地数据目录和磁盘空间';
          job.updatedAt = new Date().toISOString();
          failures.push(`${task.taskId.slice(0, 8)}: ${job.error}`);
          // 尽力把失败状态落盘；若磁盘本身不可写，外层结果仍保持失败。
          saveDownloadJobs(jobs);
          continue;
        }
        let temporaryPath: string | undefined;
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 60000);
          const headers = {
            Referer: getPlatformReferer(account?.platform, url),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          };
          let response: Response;
          let buffer: Buffer;
          try {
            const fetched = await fetchArtifactBodyWithRetry(
              url,
              account,
              accountSession,
              headers,
              controller.signal,
              (attempt) => {
                job.attempts = attempt;
                job.updatedAt = new Date().toISOString();
                ensureDownloadJobsSaved(jobs);
              },
            );
            response = fetched.response;
            buffer = fetched.buffer;
          } finally {
            clearTimeout(timeout);
          }

          const contentType = response.headers.get('content-type') || '';

          // 统一验证：HTTP 状态、非空文件和媒体 content-type。视频任务
          // 可能同时返回海报图，不能再让 task.mode 把图片误判为非法视频。
          const fallbackKind = task.mode === 'video' ? 'video' : task.mode === 'image' ? 'image' : 'file';
          const responseKind = inferArtifactKindFromBytes(
            url,
            fallbackKind,
            buffer,
            contentType,
            task.mode,
          );
          const detectedContentType = contentType || contentTypeFromArtifactBytes(buffer) || '';
          const validation = validateDownloadResponse(
            response.status,
            detectedContentType,
            buffer.length,
            responseKind === 'image' ? 'image' : task.mode,
          );
          if (!validation.valid) {
            const failure = validation.message || '下载验证失败';
            failures.push(`${task.taskId.slice(0, 8)}: ${failure}`);
            job.status = 'failed';
            job.error = failure;
            job.kind = responseKind;
            job.contentType = detectedContentType || undefined;
            job.statusCode = response.status;
            job.bytes = buffer.length;
            job.updatedAt = new Date().toISOString();
            saveDownloadJobs(jobs);
            continue;
          }

          let ext = path.extname(parsedUrl.pathname).toLowerCase();
          const knownExtensions = new Set([
            '.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv', '.mpeg', '.mpg', '.m3u8', '.ts', '.ogv',
            '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.heic', '.heif',
          ]);
          if (!knownExtensions.has(ext)) {
            const lowerContentType = detectedContentType.toLowerCase();
            if (responseKind === 'video') {
              if (lowerContentType.includes('webm')) ext = '.webm';
              else if (lowerContentType.includes('quicktime')) ext = '.mov';
              else if (lowerContentType.includes('mpegurl') || lowerContentType.includes('m3u8')) ext = '.m3u8';
              else if (lowerContentType.includes('mp2t')) ext = '.ts';
              else ext = '.mp4';
            } else if (responseKind === 'image') {
              if (lowerContentType.includes('webp')) ext = '.webp';
              else if (lowerContentType.includes('jpeg') || lowerContentType.includes('jpg')) ext = '.jpg';
              else if (lowerContentType.includes('gif')) ext = '.gif';
              else if (lowerContentType.includes('avif')) ext = '.avif';
              else ext = '.png';
            } else {
              ext = '.bin';
            }
          }
          const batchMeta = getTaskForLalor(task.taskId)?.canvasBatch;
          const fileName = batchMeta
            ? `分镜${batchMeta.number}_${task.taskId.substring(0, 8)}_${outputIndex + 1}${ext}`
            : `${task.taskId.substring(0, 8)}_${outputIndex + 1}${ext}`;
          const filePath = getAvailableDownloadPath(fs, path, resolvedSaveDir, fileName);
          temporaryPath = `${filePath}.${job.id}.part`;
          fs.writeFileSync(temporaryPath, buffer);
          fs.renameSync(temporaryPath, filePath);
          job.status = 'done';
          job.filePath = filePath;
          job.kind = responseKind;
          job.contentType = detectedContentType || undefined;
          job.statusCode = response.status;
          job.bytes = buffer.length;
          job.updatedAt = new Date().toISOString();
          ensureDownloadJobsSaved(jobs);
          registerLocalManagerAsset(job, task, url, responseKind);
          const taskResult = taskService.getTasks();
          const persistedTask = taskResult.success ? taskResult.data.find((item) => item.id === task.taskId) : undefined;
          const manualDownload = isManualDownloadTask(task.taskId);
          if (!taskResult.success && !manualDownload) {
            failures.push(`${task.taskId.slice(0, 8)}: 无法读取正式任务，已停止归档`);
            continue;
          }
          if (!persistedTask && !manualDownload) {
            failures.push(`${task.taskId.slice(0, 8)}: 正式任务不存在，已停止归档`);
            continue;
          }
          if (persistedTask) {
            const registered = taskService.registerArtifact({
              taskId: task.taskId,
              url,
              source: 'network',
              kind: responseKind,
              contentType: detectedContentType || undefined,
              contentLength: buffer.length,
              statusCode: response.status,
              runId: persistedTask.runtime?.runId,
              conversationUrl: persistedTask.runtime?.conversationUrl,
            });
            if (!registered.success) {
              failures.push(`${task.taskId.slice(0, 8)}: ${registered.error || '产物登记失败'}`);
              // Keep the successful file record for recovery, but report
              // failure so completion does not claim an unarchived task.
              continue;
            }
          }
          downloadedCount++;
          jobIds.push(job.id);
        } catch (e: unknown) {
          try {
            removeExactDownloadPart(fs, path, resolvedSaveDir, temporaryPath, job.id);
          } catch {}
          const classified = classifyDownloadException(
            e instanceof Error ? e : { message: String(e) },
          );
          failures.push(`${task.taskId.slice(0, 8)}: ${classified.message}`);
          job.status = 'failed';
          job.error = classified.message;
          job.updatedAt = new Date().toISOString();
          if (!saveDownloadJobs(jobs)) {
            console.error('[tasks:downloadOutputs] 无法保存失败下载记录');
          }
          console.warn(`[tasks:downloadOutputs] 下载产物失败 (${classified.type}):`, e instanceof Error ? e.message : String(e));
        }
      }
    }

    const failedCount = Math.max(failures.length, requestedCount - downloadedCount);
    return {
      success: downloadedCount > 0,
      count: downloadedCount,
      failed: failedCount,
      saveDir,
      error: failures.length ? failures.slice(0, 3).join('；') : undefined,
      jobIds,
    };
  } catch (err: unknown) {
    const failedCount = Math.max(failures.length, requestedCount - downloadedCount);
    return {
      success: downloadedCount > 0,
      count: downloadedCount,
      failed: failedCount,
      saveDir,
      error: failures.length > 0
        ? failures.slice(0, 3).join('；')
        : (err instanceof Error ? err.message : String(err)),
      jobIds,
    };
  }
}

export function registerTaskIPC(): () => void {
  const dispose = replaceIpcHandlers(ipcMain, TASK_IPC_CHANNELS);
  // 先读取下载记录：若任务文件为空但仍有完成的本地产物，尝试一次保守备份恢复。
  const downloads = loadDownloadJobs();
  adoptCompletedDownloadsAsLocalAssets(downloads);
  recoverTasksFromBackupWhenDownloadsExist(downloads);
  const recoveryResult = taskService.recoverInterruptedTasks();
  if (!recoveryResult.success) {
    dispose();
    throw new Error('任务恢复失败，请检查数据目录和磁盘状态');
  }
  adoptOrphanedManualDownloads();
  writeJSON('schema.json', { version: 6, appVersion: '2.0.0', updatedAt: new Date().toISOString() });
  // ---- 获取所有任务 ----
  ipcMain.handle('tasks:list', async (): Promise<Task[]> => {
    const result = taskService.getTasks();
    if (!result.success) throw new Error(result.error);
    return result.data;
  });

  // ---- 添加任务（支持批量 + 指定模式 + 视频配置 + 附件） ----
  ipcMain.handle(
    'tasks:add',
    async (_event, params: TaskAddParams): Promise<{ success: boolean; tasks?: Task[]; error?: string }> => {
      try {
        await requireYuyanGenerationAccess();
        const result = taskService.create(params);
        return result.success ? { success: true, tasks: result.data } : result;
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  );

  // ---- 公开分享页媒体下载（独立临时会话，不复用账号 Cookie） ----
  ipcMain.handle(
    'tasks:downloadPublicShareMedia',
    async (_event, params: { shareUrl?: unknown; saveDir?: unknown }) => {
      if (typeof params?.shareUrl !== 'string') {
        return { success: false, count: 0, error: '公开分享链接无效' };
      }
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const { app } = require('electron') as typeof import('electron');
      const transientSession = session.fromPartition(`public-share-${uuidv4()}`);
      try {
        const fetchPublic = (url: string, init?: Record<string, unknown>) => transientSession.fetch(url, init as RequestInit);
        const resolution = await resolvePublicShareMedia(params.shareUrl, fetchPublic);
        if (resolution.status !== 'resolved' || !resolution.mediaUrl || !resolution.finalShareUrl) {
          return { success: false, count: 0, error: resolution.error || '未找到公开媒体流' };
        }

        // 分享页解析与真正下载之间不携带任何临时 Cookie。
        await transientSession.clearStorageData({ storages: ['cookies'] });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);
        const response = await transientSession.fetch(resolution.mediaUrl, {
          method: 'GET',
          credentials: 'omit',
          headers: { Referer: resolution.finalShareUrl },
          signal: controller.signal,
        }).finally(() => clearTimeout(timeout));
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') || '';
        const validation = validateDownloadResponse(response.status, contentType, buffer.length, 'video');
        if (!validation.valid) {
          return { success: false, count: 0, error: validation.message || '公开媒体流下载验证失败' };
        }

        const defaultDir = path.join(app.getPath('downloads'), '豆包工作室产物');
        const saveDir = typeof params.saveDir === 'string' && params.saveDir.trim() ? params.saveDir : defaultDir;
        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
        const ext = path.extname(new URL(resolution.mediaUrl).pathname).toLowerCase() || '.mp4';
        const filePath = getAvailableDownloadPath(fs, path, saveDir, `public-share-${Date.now()}${ext.length <= 6 ? ext : '.mp4'}`);
        const temporaryPath = `${filePath}.${uuidv4()}.part`;
        fs.writeFileSync(temporaryPath, buffer);
        fs.renameSync(temporaryPath, filePath);
        return {
          success: true,
          count: 1,
          saveDir,
          sourceHost: resolution.sourceHost,
          contentType,
          contentLength: buffer.length,
        };
      } catch (error: unknown) {
        const classified = classifyDownloadException(error instanceof Error ? error : {});
        return { success: false, count: 0, error: classified.message };
      } finally {
        await transientSession.clearStorageData().catch(() => undefined);
      }
    },
  );

  // ---- 指派任务给账号 ----
  ipcMain.handle(
    'tasks:assign',
    async (_event, params: TaskAssignParams): Promise<{ success: boolean; error?: string }> => {
      return taskService.assign(params);
    }
  );

  // ---- 更新任务状态 ----
  ipcMain.handle(
    'tasks:updateStatus',
    async (
      _event,
      params: TaskUpdateStatusParams
    ): Promise<{ success: boolean; error?: string }> => {
      return taskService.updateStatus(params);
    }
  );

  // ---- 登记手动提取的任务产物（不改变任务状态） ----
  ipcMain.handle(
    'tasks:registerArtifact',
    async (
      _event,
      params: TaskRegisterArtifactParams,
    ): Promise<{ success: boolean; task?: Task; error?: string }> => {
      const result = taskService.registerArtifact(params);
      return result.success ? { success: true, task: result.data } : result;
    },
  );

  // ---- 编辑任务并重置为待执行 ----
  ipcMain.handle(
    'tasks:update',
    async (
      _event,
      params: {
        taskId: string;
        updates: TaskUpdateInput;
      }
    ): Promise<{ success: boolean; task?: Task; error?: string }> => {
      const result = taskService.update(params);
      return result.success ? { success: true, task: result.data } : result;
    }
  );

  // ---- 删除任务 ----
  ipcMain.handle(
    'tasks:delete',
    async (_event, params: TaskIdParams): Promise<{ success: boolean; error?: string }> => {
      return taskService.delete(params.taskId);
    }
  );

  // ---- 重试任务（失败/已完成任务重置为排队状态） ----
  ipcMain.handle(
    'tasks:retry',
    async (_event, params: TaskIdParams): Promise<{ success: boolean; task?: Task; error?: string }> => {
      const result = taskService.retry(params.taskId);
      return result.success ? { success: true, task: result.data } : result;
    }
  );

  // ---- 额度明确耗尽后的原子改派/重排队 ----
  ipcMain.handle(
    'tasks:retryAfterQuotaExhaustion',
    async (_event, params: TaskRetryAfterQuotaExhaustionParams): Promise<{ success: boolean; task?: Task; error?: string }> => {
      const result = taskService.retryAfterQuotaExhaustion(params);
      return result.success ? { success: true, task: result.data } : result;
    },
  );

  // ---- 提交前账号异常后的原子改派/重排队 ----
  ipcMain.handle(
    'tasks:retryAfterPreSubmitFailure',
    async (_event, params: TaskRetryAfterPreSubmitFailureParams): Promise<{ success: boolean; task?: Task; error?: string }> => {
      const result = taskService.retryAfterPreSubmitFailure(params);
      return result.success ? { success: true, task: result.data } : result;
    },
  );

  // ---- 批量暂停/继续 ----
  ipcMain.handle(
    'tasks:batchPause',
    async (): Promise<{ success: boolean }> => {
      const result = taskService.batchPause();
      return { success: result.success };
    }
  );

  // ---- 持久化运行阶段、心跳与结构化错误 ----
  ipcMain.handle(
    'tasks:updateRuntime',
    async (_event, params: TaskUpdateRuntimeParams): Promise<{ success: boolean; task?: Task; error?: string }> => {
      const result = taskService.updateRuntime(params);
      return result.success ? { success: true, task: result.data } : result;
    }
  );

  ipcMain.handle(
    'tasks:acquireLock',
    async (_event, params: TaskAcquireLockParams): Promise<{ success: boolean; task?: Task; error?: string }> => {
      const task = getTaskForLalor(params.taskId);
      if (task?.status === 'queued') {
        try {
          await requireYuyanGenerationAccess();
        } catch (error: unknown) {
          return { success: false, error: error instanceof Error ? error.message : '会员校验失败，请重新登录' };
        }
      }
      const result = taskService.acquireLock(params);
      return result.success ? { success: true, task: result.data } : result;
    }
  );

  ipcMain.handle(
    'tasks:renewLock',
    async (_event, params: TaskRenewLockParams): Promise<{ success: boolean; task?: Task; error?: string }> => {
      const result = taskService.renewLock(params);
      return result.success ? { success: true, task: result.data } : result;
    }
  );

  ipcMain.handle(
    'tasks:importCsv',
    async (_event, params?: TaskImportCsvParams): Promise<CsvImportResponse> => {
      try {
        let filePath = typeof params?.filePath === 'string' ? params.filePath : '';
        if (!filePath) {
          const selected = await dialog.showOpenDialog({
            title: '导入 CSV 任务',
            properties: ['openFile'],
            filters: [{ name: 'CSV', extensions: ['csv'] }],
          });
          if (selected.canceled || !selected.filePaths[0]) return { success: false };
          filePath = selected.filePaths[0];
        }
        return importCsvFile(filePath, params?.projectId);
      } catch {
        return { success: false, error: 'CSV 导入失败，请检查文件格式和数据目录状态' };
      }
    }
  );

  ipcMain.handle(
    'tasks:releaseLock',
    async (_event, params: TaskReleaseLockParams): Promise<{ success: boolean; error?: string }> => {
      return taskService.releaseLock(params);
    }
  );

  // ---- 批量获取已完成任务的产物 ----
  ipcMain.handle(
    'tasks:getCompletedOutputs',
    async (): Promise<CompletedOutput[]> => {
      const result = taskService.getCompletedOutputs();
      if (!result.success) throw new Error(result.error);
      return result.data;
    }
  );

  // ---- 选择参考图片（文件对话框） ----
  ipcMain.handle(
    'tasks:selectImages',
    async (): Promise<{ success: boolean; filePaths?: string[]; error?: string }> => {
      try {
        const result = await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
          ],
          title: '选择参考图片',
        });
        if (result.canceled) {
          return { success: true, filePaths: [] };
        }
        return { success: true, filePaths: result.filePaths };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  );

  // ---- 选择参考视频（文件对话框） ----
  ipcMain.handle(
    'tasks:selectVideos',
    async (): Promise<{ success: boolean; filePaths?: string[]; error?: string }> => {
      try {
        const result = await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: '视频文件', extensions: ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'avi', 'mkv'] },
          ],
          title: '选择参考视频',
        });
        return result.canceled ? { success: true, filePaths: [] } : { success: true, filePaths: result.filePaths };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  );

  // ---- 选择参考音频（文件对话框） ----
  ipcMain.handle(
    'tasks:selectAudio',
    async (): Promise<{ success: boolean; filePath?: string; error?: string }> => {
      try {
        const result = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [
            { name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] },
          ],
          title: '选择参考音频',
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { success: true };
        }
        return { success: true, filePath: result.filePaths[0] };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  );

  // ---- 选择多个参考音频（文件对话框） ----
  ipcMain.handle(
    'tasks:selectAudios',
    async (): Promise<{ success: boolean; filePaths?: string[]; error?: string }> => {
      try {
        const result = await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] },
          ],
          title: '选择参考音频（最多 10 个）',
        });
        return result.canceled ? { success: true, filePaths: [] } : { success: true, filePaths: result.filePaths };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  );

  // ---- 读取文件为 base64（用于缩略图显示） ----
  ipcMain.handle(
    'tasks:readFileAsBase64',
    async (_event, filePath: string): Promise<{ success: boolean; data?: string; error?: string }> => {
      try {
        const fs = require('fs');
        const fileBuffer = fs.readFileSync(filePath);
        const base64 = fileBuffer.toString('base64');
        // 根据文件扩展名推断 MIME 类型
        const ext = filePath.split('.').pop()?.toLowerCase();
        const mimeTypes: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          bmp: 'image/bmp',
          mp3: 'audio/mpeg',
          wav: 'audio/wav',
          m4a: 'audio/mp4',
          aac: 'audio/aac',
          flac: 'audio/flac',
          ogg: 'audio/ogg',
          mp4: 'video/mp4',
          m4v: 'video/mp4',
          mov: 'video/quicktime',
          webm: 'video/webm',
          ogv: 'video/ogg',
        };
        const mime = mimeTypes[ext || ''] || 'image/jpeg';
        return { success: true, data: `data:${mime};base64,${base64}` };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  );

  // ---- 生成 Chromium 可播放的视频预览副本（不修改原始下载文件） ----
  ipcMain.handle(
    'tasks:prepareVideoPreview',
    async (_event, filePath: string): Promise<{ success: boolean; data?: string; filePath?: string; error?: string }> => {
      try {
        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');
        const { app } = require('electron') as typeof import('electron');
        if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
          return { success: false, error: '本地视频路径无效' };
        }
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return { success: false, error: '本地视频文件不存在' };
        const ext = path.extname(filePath).toLowerCase();
        if (!['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'].includes(ext)) {
          return { success: false, error: '该文件不是支持的视频格式' };
        }

        const cacheDir = path.join(app.getPath('sessionData'), 'DoubaoStudio', 'video-previews');
        const jobKey = path.resolve(filePath);
        let conversion = videoPreviewJobs.get(jobKey);
        if (!conversion) {
          conversion = (async () => {
            const result = await prepareVideoPreview(filePath, cacheDir, { ffmpegPath: resolveFfmpegPath() });
            if (!result.success || !result.filePath) throw new Error(result.error || '无法生成兼容视频预览');
            return result.filePath;
          })();
          videoPreviewJobs.set(jobKey, conversion);
          void conversion.then(
            () => { if (videoPreviewJobs.get(jobKey) === conversion) videoPreviewJobs.delete(jobKey); },
            () => { if (videoPreviewJobs.get(jobKey) === conversion) videoPreviewJobs.delete(jobKey); },
          );
        }
        const compatiblePath = await conversion;
        const buffer = fs.readFileSync(compatiblePath);
        return { success: true, filePath: compatiblePath, data: `data:video/mp4;base64,${buffer.toString('base64')}` };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ---- 批量下载产物 ----
  ipcMain.handle('tasks:downloadOutputs', (_event, params: TaskDownloadOutputsParams) => downloadTaskOutputs(params));

  ipcMain.handle('tasks:listDownloads', async (): Promise<DownloadJob[]> => {
    const jobs = adoptOrphanedManualDownloads();
    adoptCompletedDownloadsAsLocalAssets(jobs);
    return jobs;
  });

  ipcMain.handle(
    'tasks:exportDiagnostics',
    async (): Promise<{ success: boolean; filePath?: string; error?: string }> => {
      try {
        const fs = require('fs');
        const path = require('path');
        const result = await dialog.showSaveDialog({
          title: '导出诊断包',
          defaultPath: `doubao-studio-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) return { success: false };

        const tasksResult = taskService.buildTaskDiagnostics();
        if (!tasksResult.success) return { success: false, error: tasksResult.error };
        const tasks = tasksResult.data;
        const accounts = readJSON<Array<Record<string, any>>>('accounts.json', []).map((account) => ({
          id: account.id,
          name: account.name,
          status: account.status,
          pinned: account.pinned,
          seedanceQuota: account.seedanceQuota,
          health: account.health,
        }));
        const downloads = loadDownloadJobs().map((job) => ({
          ...job,
          url: '[已脱敏]',
          saveDir: path.basename(job.saveDir),
          filePath: job.filePath ? path.basename(job.filePath) : undefined,
        }));
        const payload = {
          exportedAt: new Date().toISOString(),
          appVersion: require('electron').app.getVersion(),
          platform: process.platform,
          taskCount: tasks.length,
          accountCount: accounts.length,
          tasks,
          accounts,
          downloads,
        };
        fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf-8');
        return { success: true, filePath: result.filePath };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  );

  ipcMain.handle(
    'tasks:validateArtifact',
    async (_event, params: TaskValidateArtifactParams): Promise<TaskValidateArtifactResult> => {
      try {
        const result = await taskService.validateArtifact(params);
        if (!result.success) return { success: false, error: result.error };
        return {
          success: result.data.valid,
          artifact: result.data.artifact,
          error: result.data.artifact.validation?.error,
        };
      } catch {
        return { success: false, error: '产物验证失败，请检查网络和数据目录状态' };
      }
    }
  );

  ipcMain.handle(
    'tasks:saveAdapterReport',
    async (_event, params: TaskSaveAdapterReportParams): Promise<{ success: boolean }> => {
      const reports = readJSON<Array<Record<string, any>>>('adapter-diagnostics.json', []);
      reports.push({ ...params.report, accountId: params.accountId, savedAt: new Date().toISOString() });
      writeJSON('adapter-diagnostics.json', reports.slice(-50));
      return { success: true };
    }
  );

  ipcMain.handle(
    'tasks:selectAdapterRules',
    async (): Promise<{ success: boolean; bundle?: Record<string, any>; error?: string }> => {
      try {
        const selected = await dialog.showOpenDialog({
          title: '导入豆包页面适配规则', properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (selected.canceled || !selected.filePaths[0]) return { success: false };
        const fs = require('fs');
        const bundle = JSON.parse(fs.readFileSync(selected.filePaths[0], 'utf-8'));
        return { success: true, bundle };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  );

  // ---- 保存/获取设置 ----
  const settingsPath = require('path').join(
    require('electron').app.getPath('userData'),
    'settings.json'
  );

  ipcMain.handle(
    'settings:get',
    async (): Promise<Record<string, any>> => {
      try {
        const fs = require('fs');
        if (fs.existsSync(settingsPath)) {
          return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        }
      } catch (e: any) {
        console.warn('[settings:get] 读取设置失败:', e.message);
      }
      return {};
    }
  );

  ipcMain.handle(
    'settings:save',
    async (_event, settings: Record<string, any>): Promise<{ success: boolean; error?: string }> => {
      try {
        const fs = require('fs');
        const path = require('path');
        const dir = path.dirname(settingsPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  );

  ipcMain.handle('workbenchApi:get', () => ({ success: true, config: { baseUrl: YUYAN_CUSTOMER_API, apiKeyConfigured: hasYuyanKey() } }));
  ipcMain.handle('workbenchApi:save', () => ({ success: false, error: '请在个人中心连接屿砚账号。' }));
  ipcMain.handle('workbenchApi:clear', () => ({ success: false, error: '请在个人中心退出屿砚账号。' }));

  // ---- 选择下载目录 ----
  ipcMain.handle(
    'tasks:selectSaveDir',
    async (): Promise<{ success: boolean; dirPath?: string; error?: string }> => {
      try {
        const result = await dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
          title: '选择下载目录',
        });
        if (result.canceled) {
          return { success: true, dirPath: undefined };
        }
        return { success: true, dirPath: result.filePaths[0] };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  );

  console.log('[IPC] 任务调度模块已注册');
  return dispose;
}
