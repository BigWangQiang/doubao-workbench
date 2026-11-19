import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  Account,
  AccountPlatform,
  GenerationMode,
  Task,
  TaskAddParams,
} from '@doubao-studio/contracts';

const CLAIM_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MONITOR_INTERVAL_MS = 5_000;
const LEASE_RENEW_INTERVAL_MS = 12_000;
const REQUEST_TIMEOUT_MS = 30_000;
const VIDEO_ARTIFACT_UPLOAD_TIMEOUT_MS = 20 * 60_000;
const PAUSED_GRACE_MS = 5 * 60_000;
// 手动提取无水印文件后还需要回到桌面端完成归档；这类任务保留一个
// 有界恢复窗口，期间持续续租，但不会永久占用远程任务。
const ARTIFACT_RECOVERY_GRACE_MS = 60 * 60_000;
const REMOTE_FAILURE_REPORT_ATTEMPTS = 3;
const REMOTE_FAILURE_REPORT_BACKOFF_MS = 250;
const MAX_IMAGE_COUNT = 30;
const MAX_VIDEO_COUNT = 10;
const MAX_AUDIO_COUNT = 10;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

type LogLevel = 'info' | 'warn' | 'error';

interface RemoteEnvelope<T> {
  code?: number;
  data?: T | null;
  msg?: string;
}

export interface LalorRemoteResource {
  id: string;
  name: string;
  kind: string;
  mimeType: string;
  size: number;
  downloadPath?: string;
}

export interface LalorRemoteTaskClaim {
  taskId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  type: string;
  mode: string;
  executionPlatform?: AccountPlatform;
  operation: string;
  prompt: string;
  model: string;
  input: Record<string, unknown>;
  resources: LalorRemoteResource[];
}

export interface LalorLocalArtifactFile {
  filePath: string;
  kind: 'image' | 'video' | 'file';
  contentType?: string;
  bytes?: number;
}

export interface LalorDeviceMetadata {
  deviceId: string;
  deviceName: string;
  appVersion: string;
  platform: string;
  currentTaskId: string;
}

/** 跨重启恢复远程任务所需的非敏感绑定，不保存任何令牌或凭据。 */
export interface LalorRemoteTaskBinding {
  remoteTaskId: string;
  localTaskId: string;
  accountId: string;
  tempDir?: string;
  createdAt: string;
}

export interface LalorRemoteTaskBridgeDependencies {
  apiBaseUrl: string;
  tempRoot: () => string;
  withAccessToken: <T>(callback: (accessToken: string) => Promise<T>) => Promise<T>;
  deviceMetadata: (currentTaskId: string) => LalorDeviceMetadata;
  listAccounts: () => Account[];
  listTasks: () => Task[];
  createTask: (params: TaskAddParams) => Task;
  assignTask: (taskId: string, accountId: string) => void;
  getTask: (taskId: string) => Task | null;
  cancelTask: (taskId: string, message: string) => void;
  listArtifactFiles: (taskId: string) => LalorLocalArtifactFile[];
  notifyTaskAvailable: (taskId: string) => void;
  notifyTaskCancelled: (taskId: string) => void;
  loadBindings?: () => LalorRemoteTaskBinding[];
  saveBindings?: (bindings: LalorRemoteTaskBinding[]) => boolean;
  networkVersion?: () => number;
  syncNetwork?: (config: unknown | null) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  log?: (level: LogLevel, message: string, error?: unknown) => void;
}

interface RemoteResourcePlan {
  images: LalorRemoteResource[];
  videos: LalorRemoteResource[];
  audios: LalorRemoteResource[];
}

interface DownloadedInputs {
  tempDir?: string;
  attachments: string[];
  referenceVideos: string[];
  audioAttachments: string[];
}

interface ActiveRemoteTask {
  remote: LalorRemoteTaskClaim;
  localTaskId: string;
  accountId: string;
  tempDir?: string;
  lastLeaseAt: number;
  pausedAt?: number;
  finalizeFailures: number;
  uploadedFiles: Set<string>;
}

interface LeaseResponse {
  taskId: string;
  leaseExpiresAt?: string;
  cancelled?: boolean;
}

export class LalorBridgeHttpError extends Error {
  readonly status: number;
  readonly code?: number;

  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = 'LalorBridgeHttpError';
    this.status = status;
    this.code = code;
  }
}

class PermanentBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentBridgeError';
  }
}

class RemoteTaskCancelledError extends Error {
  constructor() {
    super('Lalor 任务已取消');
    this.name = 'RemoteTaskCancelledError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(cleanString(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function resourceIdFromValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('resource:')) return null;
  const id = value.slice('resource:'.length).trim();
  return RESOURCE_ID_PATTERN.test(id) ? id : null;
}

function orderedResourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const id = resourceIdFromValue(record.storageKey) || resourceIdFromValue(record.url);
    if (id && !result.includes(id)) result.push(id);
  }
  return result;
}

function hasReferencedMask(input: Record<string, unknown>): boolean {
  const mask = asRecord(input.mask);
  return Boolean(mask && (resourceIdFromValue(mask.storageKey) || resourceIdFromValue(mask.url)));
}

function sortResources(resources: LalorRemoteResource[], ids: string[]): LalorRemoteResource[] {
  const order = new Map(ids.map((id, index) => [id, index]));
  return resources.slice().sort((left, right) => {
    const leftIndex = order.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

export function classifyRemoteResources(task: LalorRemoteTaskClaim): RemoteResourcePlan {
  if (!Array.isArray(task.resources)) throw new PermanentBridgeError('Lalor 任务素材列表无效');
  if (hasReferencedMask(task.input)) {
    throw new PermanentBridgeError('当前本地管理器尚不支持蒙版素材任务');
  }
  const seen = new Set<string>();
  const images: LalorRemoteResource[] = [];
  const videos: LalorRemoteResource[] = [];
  const audios: LalorRemoteResource[] = [];
  let totalBytes = 0;
  for (const resource of task.resources) {
    const id = cleanString(resource?.id);
    const mimeType = cleanString(resource?.mimeType).toLowerCase();
    const kind = cleanString(resource?.kind).toLowerCase();
    const size = Number(resource?.size);
    if (!RESOURCE_ID_PATTERN.test(id) || seen.has(id)) {
      throw new PermanentBridgeError('Lalor 任务包含重复或无效的素材标识');
    }
    if (!Number.isFinite(size) || size <= 0) {
      throw new PermanentBridgeError(`参考素材 ${id} 的大小无效`);
    }
    seen.add(id);
    totalBytes += size;
    if (kind === 'image' || mimeType.startsWith('image/')) {
      if (size > MAX_IMAGE_BYTES) throw new PermanentBridgeError(`参考图片 ${id} 超过 30MB 上限`);
      images.push({ ...resource, id, mimeType, size });
      continue;
    }
    if (kind === 'video' || mimeType.startsWith('video/')) {
      if (size > MAX_VIDEO_BYTES) throw new PermanentBridgeError(`参考视频 ${id} 超过 200MB 上限`);
      videos.push({ ...resource, id, mimeType, size });
      continue;
    }
    if (kind === 'audio' || mimeType.startsWith('audio/')) {
      if (size > MAX_AUDIO_BYTES) throw new PermanentBridgeError(`参考音频 ${id} 超过 30MB 上限`);
      audios.push({ ...resource, id, mimeType, size });
      continue;
    }
    throw new PermanentBridgeError(`当前本地管理器不支持素材类型：${kind || mimeType || 'unknown'}`);
  }
  if (images.length > MAX_IMAGE_COUNT) throw new PermanentBridgeError(`参考图片不能超过 ${MAX_IMAGE_COUNT} 张`);
  if (videos.length > MAX_VIDEO_COUNT) throw new PermanentBridgeError(`参考视频不能超过 ${MAX_VIDEO_COUNT} 个`);
  if (audios.length > MAX_AUDIO_COUNT) throw new PermanentBridgeError(`参考音频不能超过 ${MAX_AUDIO_COUNT} 个`);
  if (totalBytes > MAX_INPUT_BYTES) throw new PermanentBridgeError('任务参考素材总大小超过 512MB 上限');

  return {
    images: sortResources(images, orderedResourceIds(task.input.referenceImages)),
    videos: sortResources(videos, orderedResourceIds(task.input.referenceVideos)),
    audios: sortResources(audios, orderedResourceIds(task.input.referenceAudios || task.input.audioAttachments)),
  };
}

function normalizeVideoExecutionPlatform(value: unknown): AccountPlatform {
  const platform = cleanString(value).toLowerCase();
  if (!platform) return 'dola';
  if (platform === 'doubao' || platform === 'dola') return platform;
  throw new PermanentBridgeError(`Lalor 视频执行平台无效：${platform}`);
}

function normalizeRemoteMode(value: unknown, executionPlatform?: unknown): { mode: GenerationMode; platform: AccountPlatform } {
  const mode = cleanString(value).toLowerCase();
  if (mode === 'text' || mode === 'chat' || mode === 'canvas_text') return { mode: 'chat', platform: 'doubao' };
  if (mode === 'image' || mode === 'canvas_image') return { mode: 'image', platform: 'doubao' };
  if (mode === 'video' || mode === 'canvas_video') {
    return { mode: 'video', platform: normalizeVideoExecutionPlatform(executionPlatform) };
  }
  throw new PermanentBridgeError(`Lalor 任务类型不受支持：${mode || 'unknown'}`);
}

type LocalVideoConfig = NonNullable<Task['videoConfig']>;

function normalizedVideoModelName(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[\s_]+/g, '-');
}

function normalizeDolaVideoModel(value: unknown): LocalVideoConfig['model'] {
  const normalized = normalizedVideoModelName(value);
  if (normalized.includes('fast')) return 'seedance-2.0-fast';
  if (/2[.-]?5/.test(normalized)) return 'seedance-2.5';
  if (normalized.includes('mini') || /2[.-]?0/.test(normalized)) {
    throw new PermanentBridgeError(`Dola 不支持视频模型 ${cleanString(value)}`);
  }
  // 业务模型别名无法直接映射时，使用 Dola 已验收的默认模型。
  return 'seedance-2.5';
}

function normalizeDoubaoVideoModel(value: unknown): LocalVideoConfig['model'] {
  const normalized = normalizedVideoModelName(value);
  if (normalized.includes('mini')) return 'seedance-2.0-mini';
  if (normalized.includes('fast')) return 'seedance-2.0-fast';
  if (/2[.-]?5/.test(normalized)) return 'seedance-2.5';
  if (/2[.-]?0/.test(normalized)) return 'seedance-2.0';
  // 豆包业务模型别名无法直接映射时，使用豆包当前默认模型。
  return 'seedance-2.0-mini';
}

function normalizeDolaVideoDuration(value: unknown): LocalVideoConfig['duration'] {
  const seconds = Math.round(numberValue(value) ?? 10);
  if ((seconds >= 4 && seconds <= 15) || seconds === 30) {
    return `${seconds}s` as LocalVideoConfig['duration'];
  }
  throw new PermanentBridgeError(`Dola 不支持 ${seconds} 秒视频，请使用 4-15 秒或 30 秒`);
}

function normalizeDoubaoVideoDuration(value: unknown): LocalVideoConfig['duration'] {
  const seconds = Math.round(numberValue(value) ?? 10);
  if ((seconds >= 4 && seconds <= 15) || seconds === 30) {
    return `${seconds}s` as LocalVideoConfig['duration'];
  }
  throw new PermanentBridgeError(`豆包不支持 ${seconds} 秒视频，请使用 4-15 秒或 30 秒`);
}

function ratioFromDimensions(value: string): string | null {
  const match = value.match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  const candidates = [
    ['1:1', 1], ['3:4', 3 / 4], ['4:3', 4 / 3], ['9:16', 9 / 16], ['16:9', 16 / 9], ['21:9', 21 / 9],
  ] as const;
  const ratio = width / height;
  const nearest = candidates.slice().sort((left, right) => Math.abs(left[1] - ratio) - Math.abs(right[1] - ratio))[0];
  return Math.abs(nearest[1] - ratio) <= 0.04 ? nearest[0] : null;
}

function normalizeDolaVideoRatio(value: unknown): LocalVideoConfig['aspectRatio'] {
  const raw = cleanString(value).replace(/\s+/g, '');
  const normalized = ratioFromDimensions(raw) || raw;
  const allowed: LocalVideoConfig['aspectRatio'][] = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'];
  if (allowed.includes(normalized as LocalVideoConfig['aspectRatio'])) {
    return normalized as LocalVideoConfig['aspectRatio'];
  }
  if (!raw || raw === 'auto') return '16:9';
  throw new PermanentBridgeError(`Dola 不支持画面比例 ${raw}`);
}

function normalizeDoubaoVideoRatio(value: unknown): LocalVideoConfig['aspectRatio'] {
  const raw = cleanString(value).replace(/\s+/g, '');
  const alias = raw.toLowerCase();
  const semanticRatio = /^(?:landscape|horizontal|横屏|宽屏)$/.test(alias)
    ? '16:9'
    : /^(?:portrait|vertical|竖屏)$/.test(alias)
      ? '9:16'
      : /^(?:square|方形|正方形)$/.test(alias)
        ? '1:1'
        : '';
  const normalized = ratioFromDimensions(raw) || semanticRatio || raw;
  const allowed: LocalVideoConfig['aspectRatio'][] = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'];
  if (allowed.includes(normalized as LocalVideoConfig['aspectRatio'])) {
    return normalized as LocalVideoConfig['aspectRatio'];
  }
  if (!raw || /^(?:auto|adaptive|自动|自适应)$/i.test(raw)) return '16:9';
  throw new PermanentBridgeError(`豆包不支持画面比例 ${raw}`);
}

export function buildLocalTaskParams(
  remote: LalorRemoteTaskClaim,
  attachments: string[] = [],
  referenceVideos: string[] = [],
  audioAttachments: string[] = [],
): TaskAddParams {
  const target = normalizeRemoteMode(
    remote.mode || remote.input.mode,
    remote.executionPlatform ?? remote.input.executionPlatform,
  );
  const prompt = cleanString(remote.prompt) || cleanString(remote.input.prompt);
  if (!prompt) throw new PermanentBridgeError('Lalor 任务提示词为空');
  const config = asRecord(remote.input.config) || {};
  const videoConfig = target.mode !== 'video'
    ? undefined
    : target.platform === 'dola'
      ? {
          model: normalizeDolaVideoModel(config.model || remote.model),
          duration: normalizeDolaVideoDuration(config.videoSeconds || config.durationSeconds || config.duration),
          aspectRatio: normalizeDolaVideoRatio(config.aspectRatio || config.size),
        }
      : {
          model: normalizeDoubaoVideoModel(config.model || remote.model),
          duration: normalizeDoubaoVideoDuration(config.videoSeconds || config.durationSeconds || config.duration),
          aspectRatio: normalizeDoubaoVideoRatio(config.aspectRatio || config.size),
        };
  return {
    prompts: [prompt],
    mode: target.mode,
    targetPlatform: target.platform,
    ...(videoConfig ? { videoConfig } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(referenceVideos.length > 0 ? { referenceVideos } : {}),
    ...(audioAttachments.length > 0 ? { audioAttachments, audioAttachment: audioAttachments[0] } : {}),
  };
}

function accountPlatform(account: Account): AccountPlatform {
  return account.platform === 'dola' ? 'dola' : 'doubao';
}

function videoQuotaAvailable(account: Account, taskParams: TaskAddParams): boolean {
  if (taskParams.mode !== 'video') return true;
  const quota = account.seedanceQuota;
  if (quota?.exhausted) return false;
  const total = typeof quota?.estimatedTotalUnits === 'number' && quota.estimatedTotalUnits > 0
    ? Math.round(quota.estimatedTotalUnits)
    : 6;
  const used = Math.max(0, quota?.usedUnits || 0);
  const configuredCost = quota?.costPerVideoUnits;
  const seconds = Number.parseInt(taskParams.videoConfig?.duration || '10', 10);
  const cost = typeof configuredCost === 'number' && configuredCost > 0
    ? Math.max(1, Math.round(configuredCost))
    : Math.max(1, Math.ceil(seconds / 5));
  return total - used >= cost;
}

export function selectAccountForRemoteTask(
  accounts: readonly Account[],
  tasks: readonly Task[],
  taskParams: TaskAddParams,
  reservedAccountIds: ReadonlySet<string> = new Set(),
  now = Date.now(),
): Account | null {
  const platform = taskParams.targetPlatform === 'dola' ? 'dola' : 'doubao';
  const activeStatuses = new Set<Task['status']>([
    'executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing',
  ]);
  const activeAccountIds = new Set(tasks.flatMap((task) => (
    task.assignedAccountId && activeStatuses.has(task.status) ? [task.assignedAccountId] : []
  )));
  const candidates = accounts.filter((account) => {
    if (accountPlatform(account) !== platform) return false;
    if (account.status !== 'idle') return false;
    if (reservedAccountIds.has(account.id) || activeAccountIds.has(account.id)) return false;
    if (account.scheduling?.enabled === false) return false;
    if (account.scheduling?.manualCooldownUntil && Date.parse(account.scheduling.manualCooldownUntil) > now) return false;
    if (account.health?.verificationRequired || account.health?.loginState === 'expired') return false;
    if (account.health?.cooldownUntil && Date.parse(account.health.cooldownUntil) > now) return false;
    const availability = account.health?.availability?.state;
    if (availability && availability !== 'ready' && availability !== 'unknown') return false;
    return videoQuotaAvailable(account, taskParams);
  });
  candidates.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    const leftPreferred = left.scheduling?.preferredModes?.includes(taskParams.mode || 'chat') ? 1 : 0;
    const rightPreferred = right.scheduling?.preferredModes?.includes(taskParams.mode || 'chat') ? 1 : 0;
    if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
    const weightDelta = (right.scheduling?.weight || 0) - (left.scheduling?.weight || 0);
    return weightDelta || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
  return candidates[0] || null;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { status?: unknown }).status;
  return typeof value === 'number' ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : String(error || '未知错误');
}

function remoteTaskStatus(value: unknown): string {
  const record = asRecord(value);
  if (!record) return '';
  const task = asRecord(record.task) || record;
  return cleanString(task.status).toLowerCase();
}

function noAvailableAccountMessage(accounts: readonly Account[], platform: AccountPlatform): string {
  const label = platform === 'dola' ? 'Dola' : '豆包';
  const platformAccountCount = accounts.filter((item) => accountPlatform(item) === platform).length;
  if (platformAccountCount === 0) {
    return `本机没有可用于该任务的 ${label} 账号：请先导入并登录 ${label} 账号`;
  }
  return `本机没有可用于该任务的 ${label} 账号：现有账号均不可用、正在执行其他任务、需要验证或额度不足，请检查账号状态后重试`;
}

function waitForRemoteFailureRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function localProgress(task: Task): { stage: string; progress: number; providerAccepted: boolean; accountConsumed: boolean } {
  const submitted = Boolean(task.runtime?.submittedAt);
  const accepted = submitted || ['generating', 'waiting_generation_confirmation', 'manual_submission_observing', 'done'].includes(task.status);
  const progressByStatus: Record<Task['status'], number> = {
    queued: 25,
    executing: 40,
    generating: 65,
    waiting_verification: 50,
    waiting_generation_confirmation: 70,
    manual_submission_observing: 75,
    paused: 70,
    done: 92,
    fail: 99,
    cancelled: 99,
  };
  return {
    stage: cleanString(task.runtime?.message) || `本地管理器：${task.status}`,
    progress: progressByStatus[task.status],
    providerAccepted: accepted,
    accountConsumed: accepted,
  };
}

function extensionForResource(resource: LalorRemoteResource): string {
  const ext = path.extname(cleanString(resource.name)).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
  const mime = resource.mimeType.toLowerCase();
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('avif')) return '.avif';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('mpeg')) return '.mp3';
  if (mime.includes('m4a')) return '.m4a';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('quicktime')) return '.mov';
  if (mime.includes('mp4')) return mime.startsWith('audio/') ? '.m4a' : '.mp4';
  if (mime.startsWith('video/')) return '.mp4';
  return mime.startsWith('audio/') ? '.audio' : '.jpg';
}

function artifactContentType(file: LalorLocalArtifactFile): string {
  const explicit = cleanString(file.contentType).toLowerCase();
  if (explicit && !explicit.endsWith('/*')) return explicit;
  const ext = path.extname(file.filePath).toLowerCase();
  const types: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  };
  return types[ext] || (file.kind === 'video' ? 'video/mp4' : file.kind === 'image' ? 'image/jpeg' : 'application/octet-stream');
}

export class LalorRemoteTaskBridge {
  private readonly deps: LalorRemoteTaskBridgeDependencies;
  private readonly active = new Map<string, ActiveRemoteTask>();
  private readonly bindings = new Map<string, LalorRemoteTaskBinding>();
  private started = false;
  private claimInFlight = false;
  private monitorInFlight = false;
  private heartbeatInFlight = false;
  private claimTimer?: ReturnType<typeof setInterval>;
  private monitorTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastLoggedError = '';

  constructor(deps: LalorRemoteTaskBridgeDependencies) {
    this.deps = deps;
    const persistedBindings = deps.loadBindings?.();
    for (const binding of Array.isArray(persistedBindings) ? persistedBindings : []) {
      const remoteTaskId = cleanString(binding?.remoteTaskId);
      const localTaskId = cleanString(binding?.localTaskId);
      const accountId = cleanString(binding?.accountId);
      if (!remoteTaskId || !localTaskId || !accountId) continue;
      this.bindings.set(remoteTaskId, {
        remoteTaskId,
        localTaskId,
        accountId,
        ...(cleanString(binding.tempDir) ? { tempDir: cleanString(binding.tempDir) } : {}),
        createdAt: cleanString(binding.createdAt) || new Date(this.now()).toISOString(),
      });
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runHeartbeat();
    void this.runClaim();
    void this.runMonitor();
    this.claimTimer = setInterval(() => void this.runClaim(), CLAIM_INTERVAL_MS);
    this.monitorTimer = setInterval(() => void this.runMonitor(), MONITOR_INTERVAL_MS);
    this.heartbeatTimer = setInterval(() => void this.runHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.claimTimer.unref?.();
    this.monitorTimer.unref?.();
    this.heartbeatTimer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.claimTimer) clearInterval(this.claimTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.claimTimer = undefined;
    this.monitorTimer = undefined;
    this.heartbeatTimer = undefined;
    // 活跃任务绑定和参考素材跨应用重启保留；远程任务结束后由 finishActive 清理。
    this.active.clear();
  }

  private persistBindings(): void {
    if (!this.deps.saveBindings) return;
    if (!this.deps.saveBindings([...this.bindings.values()])) {
      throw new Error('Lalor 远程任务绑定写入失败');
    }
  }

  private managedTempDir(value: unknown): string | undefined {
    const candidate = cleanString(value);
    if (!candidate) return undefined;
    const root = path.resolve(this.deps.tempRoot(), 'lalor-desktop-inputs');
    const resolved = path.resolve(candidate);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
      return undefined;
    }
    return path.basename(resolved).startsWith('task-') ? resolved : undefined;
  }

  private saveBinding(active: ActiveRemoteTask, createdAt?: string): void {
    const previous = this.bindings.get(active.remote.taskId);
    const tempDir = this.managedTempDir(active.tempDir);
    this.bindings.set(active.remote.taskId, {
      remoteTaskId: active.remote.taskId,
      localTaskId: active.localTaskId,
      accountId: active.accountId,
      ...(tempDir ? { tempDir } : {}),
      createdAt: createdAt || previous?.createdAt || new Date(this.now()).toISOString(),
    });
    this.persistBindings();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(level: LogLevel, message: string, error?: unknown): void {
    if (this.deps.log) {
      this.deps.log(level, message, error);
      return;
    }
    const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    writer(`[LalorBridge] ${message}`, error || '');
  }

  private logTransient(error: unknown): void {
    const message = errorMessage(error);
    if (message === this.lastLoggedError) return;
    this.lastLoggedError = message;
    this.log('warn', message);
  }

  private async fetchWithTimeout(
    endpoint: string,
    init: RequestInit,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const fetcher = this.deps.fetch || globalThis.fetch;
    try {
      return await fetcher(`${this.deps.apiBaseUrl.replace(/\/+$/, '')}${endpoint}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Lalor 远程任务请求超时');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async responseError(response: Response): Promise<LalorBridgeHttpError> {
    let message = `Lalor 远程任务请求失败（HTTP ${response.status}）`;
    let code: number | undefined;
    try {
      const envelope = await response.json() as RemoteEnvelope<unknown>;
      if (cleanString(envelope.msg)) message = cleanString(envelope.msg);
      if (typeof envelope.code === 'number') code = envelope.code;
    } catch {
      // Keep the bounded public HTTP message; response bodies are never logged.
    }
    return new LalorBridgeHttpError(message, response.status, code);
  }

  private async requestJson<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
    return this.deps.withAccessToken(async (accessToken) => {
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/json');
      headers.set('Authorization', `Bearer ${accessToken}`);
      if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      const response = await this.fetchWithTimeout(endpoint, { ...init, headers });
      if (!response.ok) throw await this.responseError(response);
      let envelope: RemoteEnvelope<T>;
      try {
        envelope = await response.json() as RemoteEnvelope<T>;
      } catch {
        throw new LalorBridgeHttpError('Lalor 远程任务返回数据格式无效', response.status);
      }
      if (envelope.code !== 0 || envelope.data === undefined || envelope.data === null) {
        throw new LalorBridgeHttpError(cleanString(envelope.msg) || 'Lalor 远程任务响应无效', response.status, envelope.code);
      }
      return envelope.data;
    });
  }

  private async runHeartbeat(): Promise<void> {
    if (!this.started || this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      const currentTaskId = this.active.keys().next().value || '';
      const heartbeat = await this.requestJson<{ networkVersion?: number }>('/desktop/heartbeat', {
        method: 'POST',
        body: JSON.stringify(this.deps.deviceMetadata(currentTaskId)),
      });
      if (this.deps.syncNetwork) {
        const version = Number(heartbeat.networkVersion) || 0;
        // 凭证独立于配置版本到期；心跳续取，不能只在管理员改配置时刷新。
        const config = await this.requestJson<unknown>('/desktop/network', { method: 'GET' });
        await this.deps.syncNetwork(config);
      }
      this.lastLoggedError = '';
    } catch (error: unknown) {
      this.logTransient(error);
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private async runClaim(): Promise<void> {
    if (!this.started || this.claimInFlight) return;
    this.claimInFlight = true;
    try {
      const result = await this.requestJson<{ task?: LalorRemoteTaskClaim | null }>('/desktop/tasks/claim', { method: 'POST' });
      if (!result.task) return;
      await this.acceptClaim(result.task);
      this.lastLoggedError = '';
    } catch (error: unknown) {
      this.logTransient(error);
    } finally {
      this.claimInFlight = false;
    }
  }

  private validateClaim(remote: LalorRemoteTaskClaim): void {
    if (!remote || !cleanString(remote.taskId) || !cleanString(remote.leaseToken)) {
      throw new PermanentBridgeError('Lalor 远程任务缺少任务号或租约');
    }
    if (!asRecord(remote.input)) throw new PermanentBridgeError('Lalor 远程任务输入无效');
    if (!Array.isArray(remote.resources)) throw new PermanentBridgeError('Lalor 远程任务素材列表无效');
  }

  private async acceptClaim(remote: LalorRemoteTaskClaim): Promise<void> {
    let downloaded: DownloadedInputs = { attachments: [], referenceVideos: [], audioAttachments: [] };
    let localTask: Task | null = null;
    let active: ActiveRemoteTask | null = null;
    try {
      this.validateClaim(remote);
      const alreadyActive = this.active.get(remote.taskId);
      if (alreadyActive) {
        alreadyActive.remote = remote;
        alreadyActive.lastLeaseAt = this.now();
        const task = this.deps.getTask(alreadyActive.localTaskId);
        const progress = task ? localProgress(task) : {
          stage: '正在恢复本地任务', progress: 30, providerAccepted: false, accountConsumed: false,
        };
        await this.renewLease(
          alreadyActive,
          progress.stage,
          progress.progress,
          progress.providerAccepted,
          progress.accountConsumed,
        );
        return;
      }

      const binding = this.bindings.get(remote.taskId);
      if (binding) {
        const existingTask = this.deps.getTask(binding.localTaskId);
        if (!existingTask) {
          this.bindings.delete(remote.taskId);
          this.persistBindings();
          throw new PermanentBridgeError('Lalor 任务绑定的本地任务已不存在');
        }
        active = {
          remote,
          localTaskId: binding.localTaskId,
          accountId: existingTask.assignedAccountId || binding.accountId,
          tempDir: this.managedTempDir(binding.tempDir),
          lastLeaseAt: this.now(),
          finalizeFailures: 0,
          uploadedFiles: new Set(),
        };
        this.active.set(remote.taskId, active);
        this.saveBinding(active, binding.createdAt);
        const progress = localProgress(existingTask);
        await this.renewLease(active, progress.stage, progress.progress, progress.providerAccepted, progress.accountConsumed);
        if (!this.active.has(remote.taskId)) return;
        const canResumeAfterReload = existingTask.status === 'queued'
          || (existingTask.status === 'paused'
            && !existingTask.runtime?.submittedAt
            && existingTask.result === '应用界面重新载入，任务已安全暂停');
        if (canResumeAfterReload) {
          this.deps.notifyTaskAvailable(existingTask.id);
        }
        await this.monitorActive(active);
        this.log('info', `已恢复 Lalor 任务 ${remote.taskId} 的本地绑定`);
        return;
      }

      const paramsWithoutFiles = buildLocalTaskParams(remote);
      const reserved = new Set([
        ...[...this.active.values()].map((item) => item.accountId),
        ...[...this.bindings.values()].map((item) => item.accountId),
      ]);
      const accounts = this.deps.listAccounts();
      const targetPlatform: AccountPlatform = paramsWithoutFiles.targetPlatform === 'dola' ? 'dola' : 'doubao';
      const account = selectAccountForRemoteTask(
        accounts,
        this.deps.listTasks(),
        paramsWithoutFiles,
        reserved,
        this.now(),
      );
      if (!account) {
        throw new PermanentBridgeError(noAvailableAccountMessage(accounts, targetPlatform));
      }

      downloaded = await this.downloadInputs(remote);
      const params = buildLocalTaskParams(
        remote,
        downloaded.attachments,
        downloaded.referenceVideos,
        downloaded.audioAttachments,
      );
      localTask = this.deps.createTask(params);
      this.deps.assignTask(localTask.id, account.id);
      active = {
        remote,
        localTaskId: localTask.id,
        accountId: account.id,
        tempDir: downloaded.tempDir,
        lastLeaseAt: this.now(),
        finalizeFailures: 0,
        uploadedFiles: new Set(),
      };
      this.active.set(remote.taskId, active);
      this.saveBinding(active);
      await this.renewLease(active, '已加入本地账号队列', 25, false, false);
      if (!this.active.has(remote.taskId)) return;
      this.deps.notifyTaskAvailable(localTask.id);
      this.log('info', `已接收 Lalor 任务 ${remote.taskId} 并加入本地队列`);
    } catch (error: unknown) {
      if (active) {
        this.active.delete(remote.taskId);
        if (this.bindings.get(remote.taskId)?.localTaskId === active.localTaskId) {
          this.bindings.delete(remote.taskId);
          try { this.persistBindings(); } catch {}
        }
      }
      if (localTask) {
        try { this.deps.cancelTask(localTask.id, `Lalor 任务接入失败：${errorMessage(error)}`); } catch {}
      }
      this.cleanupTempDir(downloaded.tempDir);
      if (error instanceof RemoteTaskCancelledError) return;
      const message = errorMessage(error);
      try {
         await this.reportRemoteFailureWithRetry(remote, message, false, false);
      } catch (reportError: unknown) {
        this.log('error', `Lalor 任务 ${cleanString(remote?.taskId) || 'unknown'} 接入失败且无法回报`, reportError);
      }
    }
  }

  private async downloadInputs(remote: LalorRemoteTaskClaim): Promise<DownloadedInputs> {
    const plan = classifyRemoteResources(remote);
    if (plan.images.length === 0 && plan.videos.length === 0 && plan.audios.length === 0) {
      return { attachments: [], referenceVideos: [], audioAttachments: [] };
    }
    const root = path.join(this.deps.tempRoot(), 'lalor-desktop-inputs');
    fs.mkdirSync(root, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(root, 'task-'));
    const attachments: string[] = [];
    const referenceVideos: string[] = [];
    const audioAttachments: string[] = [];
    try {
      const resources = [...plan.images, ...plan.videos, ...plan.audios];
      for (let index = 0; index < resources.length; index += 1) {
        const resource = resources[index];
        const lease = await this.renewClaim(remote, `正在下载参考素材 ${index + 1}/${resources.length}`, 18 + index);
        if (lease.cancelled) throw new RemoteTaskCancelledError();
        const filePath = await this.downloadResource(remote, resource, tempDir);
        if (plan.videos.some((item) => item.id === resource.id)) referenceVideos.push(filePath);
        else if (plan.audios.some((item) => item.id === resource.id)) audioAttachments.push(filePath);
        else attachments.push(filePath);
      }
      return { tempDir, attachments, referenceVideos, audioAttachments };
    } catch (error: unknown) {
      this.cleanupTempDir(tempDir);
      throw error;
    }
  }

  private async downloadResource(
    remote: LalorRemoteTaskClaim,
    resource: LalorRemoteResource,
    tempDir: string,
  ): Promise<string> {
    const response = await this.deps.withAccessToken(async (accessToken) => {
      const endpoint = `/desktop/tasks/${encodeURIComponent(remote.taskId)}/inputs/${encodeURIComponent(resource.id)}`;
      const result = await this.fetchWithTimeout(endpoint, {
        method: 'GET',
        headers: {
          Accept: resource.mimeType || '*/*',
          Authorization: `Bearer ${accessToken}`,
          'X-Lalor-Task-Lease': remote.leaseToken,
        },
      });
      if (!result.ok) throw await this.responseError(result);
      return result;
    });
    const contentType = cleanString(response.headers.get('content-type')).toLowerCase();
    const expectedImage = resource.kind.toLowerCase() === 'image' || resource.mimeType.startsWith('image/');
    const expectedVideo = resource.kind.toLowerCase() === 'video' || resource.mimeType.startsWith('video/');
    const expectedAudio = resource.kind.toLowerCase() === 'audio' || resource.mimeType.startsWith('audio/');
    if ((expectedImage && !contentType.startsWith('image/'))
      || (expectedVideo && !contentType.startsWith('video/'))
      || (expectedAudio && !contentType.startsWith('audio/'))) {
      throw new PermanentBridgeError(`参考素材 ${resource.id} 返回了错误的媒体类型`);
    }
    const maxBytes = expectedImage ? MAX_IMAGE_BYTES : expectedVideo ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES;
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > maxBytes) throw new PermanentBridgeError(`参考素材 ${resource.id} 超过大小上限`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length <= 0 || buffer.length > maxBytes) {
      throw new PermanentBridgeError(`参考素材 ${resource.id} 内容为空或超过大小上限`);
    }
    const filePath = path.join(tempDir, `${String(randomUUID())}${extensionForResource(resource)}`);
    fs.writeFileSync(filePath, buffer, { flag: 'wx' });
    return filePath;
  }

  private async renewClaim(remote: LalorRemoteTaskClaim, stage: string, progress: number): Promise<LeaseResponse> {
    return this.requestJson<LeaseResponse>(`/desktop/tasks/${encodeURIComponent(remote.taskId)}/lease`, {
      method: 'POST',
      body: JSON.stringify({
        leaseToken: remote.leaseToken,
        stage,
        progress: Math.max(0, Math.min(99, progress)),
        providerAccepted: false,
        accountConsumed: false,
      }),
    });
  }

  private async renewLease(
    active: ActiveRemoteTask,
    stage: string,
    progress: number,
    providerAccepted: boolean,
    accountConsumed: boolean,
  ): Promise<LeaseResponse> {
    const response = await this.requestJson<LeaseResponse>(`/desktop/tasks/${encodeURIComponent(active.remote.taskId)}/lease`, {
      method: 'POST',
      body: JSON.stringify({
        leaseToken: active.remote.leaseToken,
        stage,
        progress: Math.max(0, Math.min(99, progress)),
        providerAccepted,
        accountConsumed,
      }),
    });
    active.lastLeaseAt = this.now();
    if (response.cancelled) await this.handleRemoteCancellation(active);
    return response;
  }

  private async runMonitor(): Promise<void> {
    if (!this.started || this.monitorInFlight) return;
    this.monitorInFlight = true;
    try {
      for (const active of [...this.active.values()]) {
        if (!this.active.has(active.remote.taskId)) continue;
        await this.monitorActive(active);
      }
    } finally {
      this.monitorInFlight = false;
    }
  }

  private async monitorActive(active: ActiveRemoteTask): Promise<void> {
    try {
      const task = this.deps.getTask(active.localTaskId);
      if (!task) {
        await this.failActive(active, '对应的本地任务已不存在', false, false);
        return;
      }
      const progress = localProgress(task);
      if (task.status === 'done') {
        await this.finalizeActive(active, task);
        return;
      }
      if (task.status === 'fail' || task.status === 'cancelled') {
        await this.failActive(
          active,
          cleanString(task.result) || cleanString(task.errorInfo?.message) || '本地任务执行失败',
          progress.providerAccepted,
          progress.accountConsumed,
        );
        return;
      }
      if (task.status === 'paused') {
        active.pausedAt ??= this.now();
        const pausedGraceMs = task.errorInfo?.code === 'artifact_download_failed'
          ? ARTIFACT_RECOVERY_GRACE_MS
          : PAUSED_GRACE_MS;
        if (this.now() - active.pausedAt >= pausedGraceMs) {
          await this.failActive(
            active,
            cleanString(task.result) || (task.errorInfo?.code === 'artifact_download_failed'
              ? '本地视频归档恢复超过 60 分钟'
              : '本地任务暂停超过 5 分钟'),
            progress.providerAccepted,
            progress.accountConsumed,
          );
          return;
        }
      } else {
        active.pausedAt = undefined;
      }
      if (this.now() - active.lastLeaseAt >= LEASE_RENEW_INTERVAL_MS) {
        await this.renewLease(active, progress.stage, progress.progress, progress.providerAccepted, progress.accountConsumed);
      }
    } catch (error: unknown) {
      if (errorStatus(error) === 401 || errorStatus(error) === 403) {
        await this.handleLeaseLoss(active, errorMessage(error));
        return;
      }
      this.logTransient(error);
    }
  }

  private async finalizeActive(active: ActiveRemoteTask, task: Task): Promise<void> {
    const progress = localProgress(task);
    try {
      await this.renewLease(active, '正在上传本地产物', 94, progress.providerAccepted, progress.accountConsumed);
      if (!this.active.has(active.remote.taskId)) return;
      const expectedKind = task.mode === 'video' ? 'video' : task.mode === 'image' ? 'image' : null;
      if (expectedKind) {
        const files = this.deps.listArtifactFiles(task.id).filter((file) => file.kind === expectedKind);
        if (files.length === 0) throw new PermanentBridgeError(`本地${expectedKind === 'video' ? '视频' : '图片'}任务没有可回传的真实文件`);
        for (const file of files) {
          const resolved = path.resolve(file.filePath);
          if (active.uploadedFiles.has(resolved)) continue;
          await this.uploadArtifact(active, file);
          active.uploadedFiles.add(resolved);
          await this.renewLease(active, '正在上传本地产物', 96, true, true);
          if (!this.active.has(active.remote.taskId)) return;
        }
      }
      const inputMetadata = asRecord(active.remote.input.metadata) || {};
      const metadata = {
        source: 'lalor-desktop-manager',
        localTaskId: task.id,
        accountId: active.accountId,
        operation: active.remote.operation,
        ...(cleanString(inputMetadata.projectId) ? { projectId: cleanString(inputMetadata.projectId) } : {}),
        ...(cleanString(inputMetadata.nodeId) ? { nodeId: cleanString(inputMetadata.nodeId) } : {}),
      };
      const text = task.mode === 'chat' ? cleanString(task.result) : '';
      if (task.mode === 'chat' && !text) throw new PermanentBridgeError('豆包文本任务没有返回可回传的回复内容');
      await this.requestJson(`/desktop/tasks/${encodeURIComponent(active.remote.taskId)}/complete`, {
        method: 'POST',
        body: JSON.stringify({ leaseToken: active.remote.leaseToken, text, metadata }),
      });
      this.finishActive(active);
      this.log('info', `Lalor 任务 ${active.remote.taskId} 已完成回传`);
    } catch (error: unknown) {
      active.finalizeFailures += 1;
      const status = errorStatus(error);
      const permanent = error instanceof PermanentBridgeError || (status !== undefined && status >= 400 && status < 500);
      if (permanent || active.finalizeFailures >= 3) {
        await this.failActive(active, `产物回传失败：${errorMessage(error)}`, progress.providerAccepted, progress.accountConsumed);
        return;
      }
      this.log('warn', `Lalor 任务 ${active.remote.taskId} 产物回传暂时失败，将自动重试`, error);
    }
  }

  private async uploadArtifact(active: ActiveRemoteTask, file: LalorLocalArtifactFile): Promise<void> {
    const stat = fs.statSync(file.filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) {
      throw new PermanentBridgeError('本地产物不存在、为空或超过 512MB 上限');
    }
    await this.deps.withAccessToken(async (accessToken) => {
      const contentType = artifactContentType(file);
      const blob = await fs.openAsBlob(file.filePath, { type: contentType });
      const form = new FormData();
      form.append('file', blob, path.basename(file.filePath));
      form.append('leaseToken', active.remote.leaseToken);
      form.append('kind', file.kind);
      form.append('width', '0');
      form.append('height', '0');
      form.append('durationMs', '0');
      form.append('label', path.basename(file.filePath).slice(0, 160));
      const response = await this.fetchWithTimeout(`/desktop/tasks/${encodeURIComponent(active.remote.taskId)}/artifacts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        body: form,
      }, file.kind === 'video' ? VIDEO_ARTIFACT_UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
      if (!response.ok) throw await this.responseError(response);
      const envelope = await response.json() as RemoteEnvelope<unknown>;
      if (envelope.code !== 0 || !envelope.data) {
        throw new LalorBridgeHttpError(cleanString(envelope.msg) || 'Lalor 未确认产物上传', response.status, envelope.code);
      }
    });
  }

  private async reportRemoteFailure(
    remote: LalorRemoteTaskClaim,
    message: string,
    providerAccepted: boolean,
    accountConsumed: boolean,
  ): Promise<void> {
    const response = await this.requestJson<unknown>(`/desktop/tasks/${encodeURIComponent(remote.taskId)}/fail`, {
      method: 'POST',
      body: JSON.stringify({
        leaseToken: remote.leaseToken,
        message: message.slice(0, 2_000),
        providerAccepted,
        accountConsumed,
      }),
    });
    const status = remoteTaskStatus(response);
    if (!['failed', 'cancelled', 'canceled', 'error', 'expired'].includes(status)) {
      throw new Error(status
        ? `Lalor 未确认任务已失败（当前状态：${status}）`
        : 'Lalor 未返回任务失败状态确认');
    }
  }

  private async reportRemoteFailureWithRetry(
    remote: LalorRemoteTaskClaim,
    message: string,
    providerAccepted: boolean,
    accountConsumed: boolean,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= REMOTE_FAILURE_REPORT_ATTEMPTS; attempt += 1) {
      try {
        await this.reportRemoteFailure(remote, message, providerAccepted, accountConsumed);
        return;
      } catch (error: unknown) {
        lastError = error;
        const status = errorStatus(error);
        const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
        if (!retryable || attempt >= REMOTE_FAILURE_REPORT_ATTEMPTS) throw error;
        await waitForRemoteFailureRetry(REMOTE_FAILURE_REPORT_BACKOFF_MS * attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Lalor 任务失败状态回报未完成');
  }

  private async failActive(
    active: ActiveRemoteTask,
    message: string,
    providerAccepted: boolean,
    accountConsumed: boolean,
  ): Promise<void> {
    try {
      await this.reportRemoteFailure(active.remote, message, providerAccepted, accountConsumed);
      this.finishActive(active);
    } catch (error: unknown) {
      if (errorStatus(error) === 401 || errorStatus(error) === 403) {
        await this.handleLeaseLoss(active, errorMessage(error));
        return;
      }
      this.log('warn', `Lalor 任务 ${active.remote.taskId} 失败状态回报未完成，将自动重试`, error);
    }
  }

  private async handleRemoteCancellation(active: ActiveRemoteTask): Promise<void> {
    try { this.deps.cancelTask(active.localTaskId, 'Lalor 用户已取消任务'); } catch {}
    this.deps.notifyTaskCancelled(active.localTaskId);
    this.finishActive(active);
    this.log('info', `Lalor 任务 ${active.remote.taskId} 已取消`);
  }

  private async handleLeaseLoss(active: ActiveRemoteTask, message: string): Promise<void> {
    try { this.deps.cancelTask(active.localTaskId, `Lalor 租约已失效：${message}`); } catch {}
    this.deps.notifyTaskCancelled(active.localTaskId);
    this.finishActive(active);
    this.log('warn', `Lalor 任务 ${active.remote.taskId} 租约失效，本地执行已停止`);
  }

  private finishActive(active: ActiveRemoteTask): void {
    const binding = this.bindings.get(active.remote.taskId);
    if (binding?.localTaskId === active.localTaskId) {
      this.bindings.delete(active.remote.taskId);
      try {
        this.persistBindings();
      } catch (error: unknown) {
        this.bindings.set(active.remote.taskId, binding);
        this.log('warn', 'Lalor 已结束任务的本地绑定清理失败', error);
        return;
      }
    }
    this.active.delete(active.remote.taskId);
    this.cleanupTempDir(active.tempDir);
    void this.runHeartbeat();
  }

  private cleanupTempDir(tempDir: string | undefined): void {
    const managedTempDir = this.managedTempDir(tempDir);
    if (!managedTempDir) return;
    try {
      fs.rmSync(managedTempDir, { recursive: true, force: true });
    } catch (error: unknown) {
      this.log('warn', 'Lalor 临时参考素材目录清理失败', error);
    }
  }
}
