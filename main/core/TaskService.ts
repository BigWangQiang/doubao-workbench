import { randomUUID } from 'crypto';
import type {
  GenerationMode,
  VideoModel,
  VideoDuration,
  VideoAspectRatio,
  Task,
  TaskArtifact,
  TaskAddParams,
  TaskAssignParams,
  TaskUpdateStatusParams,
  TaskRegisterArtifactParams,
  TaskUpdateInput,
  TaskUpdateRuntimeParams,
  TaskAcquireLockParams,
  TaskRenewLockParams,
  TaskReleaseLockParams,
  TaskRetryAfterQuotaExhaustionParams,
  TaskRetryAfterPreSubmitFailureParams,
  TaskRunSnapshot,
  TaskRunRecord,
  TaskValidateArtifactParams,
  CompletedOutput,
  AccountPlatform,
  StoryboardBatchInput,
} from '@doubao-studio/contracts';
import { acquireTaskLease, renewTaskLease, canReleaseTaskLease } from '../utils/taskLease';
import { parseCsv } from '../utils/csv';
import { inferArtifactKind } from '../utils/artifactKind';

export interface TaskStore {
  read(): Task[];
  replace(tasks: Task[]): boolean;
}

export interface TaskServiceDependencies {
  store: TaskStore;
  defaultProjectId: () => string;
  /** 桌面 IPC 注入的账号平台查询，用于在持久化前拒绝跨平台指派。 */
  accountPlatformById?: (accountId: string) => AccountPlatform | undefined;
  id?: () => string;
  now?: () => string;
  nowMs?: () => number;
  /** 产物网络探针（Electron session 探测由 IPC 层注入，Core 只消费结果） */
  probeArtifact?: ArtifactProbe;
  /** 诊断脱敏用的路径 basename（IPC 注入 path.basename；Core 默认按分隔符截取末段） */
  basename?: (value: string) => string;
  /** 桌面运行时注入会员门禁；读取历史及已提交任务回收不受该门禁影响。 */
  generationAccessError?: () => string | undefined;
}

export type TaskServiceResult<T = undefined> =
  | ({ success: true } & (T extends undefined ? object : { data: T }))
  | { success: false; error: string };

export interface TaskRecoverySummary {
  recoveredTasks: number;
  clearedLocks: number;
}

const LEGACY_UNCERTAIN_SUBMISSION = /发送按钮不可用|点击结果不确定|发送动作结果不确定|发送状态不确定|人工核对豆包会话/;

function requiresSubmissionReconciliation(task: Task): boolean {
  if (task.status === 'waiting_generation_confirmation' || task.status === 'manual_submission_observing') return true;
  const confirmed = Boolean(task.runtime?.submittedAt || task.runtime?.submissionConfirmedAt);
  const uncertain = task.errorInfo?.code === 'submission_uncertain'
    || task.errorInfo?.code === 'generation_confirmation_required'
    || LEGACY_UNCERTAIN_SUBMISSION.test(`${task.errorInfo?.message || ''} ${task.result || ''}`);
  if (!confirmed) return uncertain;
  if (!['paused', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing', 'fail', 'cancelled'].includes(task.status)) return false;
  // 视频提交已经产生不可逆的平台副作用。无论后续是回执超时、
  // 下载失败还是本地归档失败，都只能走原会话只读核对，不能 retry 重发。
  // 与 renderer 的 requiresSubmissionReconciliation 保持一致，避免重启后
  // 核心服务放开一条重复提交路径。
  if (task.mode === 'video') return true;
  return uncertain;
}

/** CSV 导入时传入 Core 的最小账号投影 */
export interface TaskCsvAccountProjection {
  id: string;
  name: string;
  platform?: AccountPlatform;
}

/** CSV 导入命令：纯文本 + 账号投影 + 可选项目 ID */
export interface TaskCsvImportCommand {
  text: string;
  accounts: readonly TaskCsvAccountProjection[];
  projectId?: string;
}

/** CSV 导入成功返回的数据 */
export interface TaskCsvImportResultData {
  tasks: Task[];
  batchId: string;
  imported: number;
  skipped: number;
  errors: string[];
}

/** 产物校验成功返回的数据 */
export interface TaskValidateArtifactResultData {
  valid: boolean;
  artifact: TaskArtifact;
}

/** 产物网络探针结果：由 IPC 层注入的 Electron 探测产生 */
export type ArtifactProbeResult =
  | { kind: 'response'; statusCode: number; contentType?: string; contentLength?: number }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

/** 产物探针：Core 只消费结果，网络/session/账号解析由注入实现负责 */
export type ArtifactProbe = (
  artifact: TaskArtifact,
  assignedAccountId: string | null,
) => Promise<ArtifactProbeResult>;

const ACTIVE = new Set<Task['status']>(['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing']);
const WRITE_ERROR = '任务数据写入失败，请检查磁盘空间和数据目录权限';
const RENEW_WRITE_ERROR = '任务锁续租写入失败';
const RELEASE_WRITE_ERROR = '任务锁释放写入失败';
const TERMINAL_STATUSES: ReadonlyArray<Task['status']> = ['done', 'fail', 'paused', 'cancelled'];
const VALID_MODELS: readonly VideoModel[] = ['seedance-2.5', 'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini'];
const VALID_RATIOS: readonly VideoAspectRatio[] = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'];
const VALID_DURATIONS: readonly VideoDuration[] = ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s', '30s'];
const MAX_REFERENCE_IMAGES = 30;
const MAX_REFERENCE_VIDEOS = 10;
const MAX_REFERENCE_AUDIOS = 10;

function validateReferenceMaterialCounts(input: {
  attachments?: string[];
  referenceVideos?: string[];
  audioAttachment?: string;
  audioAttachments?: string[];
}): string | undefined {
  if ((input.attachments || []).length > MAX_REFERENCE_IMAGES) {
    return `参考图片最多 ${MAX_REFERENCE_IMAGES} 张`;
  }
  if ((input.referenceVideos || []).length > MAX_REFERENCE_VIDEOS) {
    return `参考视频最多 ${MAX_REFERENCE_VIDEOS} 个`;
  }
    const audios = new Set(
      [...(input.audioAttachments || []), input.audioAttachment || ''].filter(Boolean),
    );
  if (audios.size > MAX_REFERENCE_AUDIOS) {
    return `参考音频最多 ${MAX_REFERENCE_AUDIOS} 个`;
  }
  return undefined;
}

function validateVideoConfigForPlatform(
  mode: GenerationMode,
  config: Task['videoConfig'] | undefined,
  platform: AccountPlatform,
): string | undefined {
  if (mode !== 'video' || !config) return undefined;
  if (!VALID_MODELS.includes(config.model)) return `视频模型「${config.model}」无效`;
  if (!VALID_DURATIONS.includes(config.duration)) return `视频时长「${config.duration}」无效`;
  if (!VALID_RATIOS.includes(config.aspectRatio)) return `画面比例「${config.aspectRatio}」无效`;
  return undefined;
}

/** 保留服务边界校验函数，Dola 的具体能力由平台页面决定，不在本地额外封禁模式。 */
function validateGenerationModeForPlatform(mode: GenerationMode, platform: AccountPlatform): string | undefined {
  void mode;
  void platform;
  return undefined;
}

function parseCsvModeStrict(value: string): GenerationMode | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'chat';
  if (['chat', '对话'].includes(normalized)) return 'chat';
  if (['image', '图片'].includes(normalized)) return 'image';
  if (['video', '视频'].includes(normalized)) return 'video';
  if (['music', '音乐'].includes(normalized)) return 'music';
  return null;
}

function parseCsvPlatformStrict(value: string): AccountPlatform | null | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['doubao', '豆包'].includes(normalized)) return 'doubao';
  if (['dola', '国际豆包'].includes(normalized)) return 'dola';
  return null;
}

function resolveCsvAccount(
  value: string,
  accounts: readonly TaskCsvAccountProjection[],
): { account?: TaskCsvAccountProjection; error?: string } {
  const input = value.trim();
  if (!input) return {};
  const byId = accounts.find((account) => account.id === input);
  if (byId) return { account: byId };

  let platform: AccountPlatform | undefined;
  let name = input;
  const prefixMatch = /^(doubao|dola):(.*)$/i.exec(input);
  if (prefixMatch) {
    platform = prefixMatch[1].toLowerCase() as AccountPlatform;
    name = prefixMatch[2].trim();
    if (!name) return { error: `账号标识「${input}」缺少账号名称` };
  }

  const matches = accounts.filter((account) =>
    account.name === name && (!platform || (account.platform || 'doubao') === platform)
  );
  if (matches.length === 1) return { account: matches[0] };
  if (matches.length > 1) return { error: `账号「${input}」存在重名，请使用平台前缀或账号 ID` };
  return { error: `未找到账号「${input}」` };
}

function artifactId(url: string): string {
  let hash = 5381;
  for (let index = 0; index < url.length; index++) hash = ((hash << 5) + hash) ^ url.charCodeAt(index);
  return `artifact-${(hash >>> 0).toString(16)}`;
}

export class TaskService {
  private readonly id: () => string;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly basename: (value: string) => string;

  constructor(private readonly deps: TaskServiceDependencies) {
    this.id = deps.id || randomUUID;
    this.now = deps.now || (() => new Date().toISOString());
    this.nowMs = deps.nowMs || (() => Date.now());
    this.basename = deps.basename || ((value) => value.split(/[\\/]/).pop() || value);
  }

  private readTasks(): Task[] | null {
    try {
      return this.deps.store.read();
    } catch {
      return null;
    }
  }

  private persist(tasks: Task[]): boolean {
    try {
      return this.deps.store.replace(tasks);
    } catch {
      return false;
    }
  }

  /** 将任务重置为排队状态，清除运行结果、产物列表、错误信息和锁 */
  private resetTaskForQueue(task: Task, timestamp: string): void {
    task.status = 'queued';
    task.result = null;
    task.outputs = [];
    task.errorInfo = undefined;
    // 暂停/中断任务重新入队时不应继承旧运行锁，否则恢复后会被当作仍在执行。
    task.lock = undefined;
    if (task.runtime) {
      task.runtime = {
        ...task.runtime,
        stage: 'queued',
        message: '等待执行',
        stageStartedAt: timestamp,
        lastHeartbeatAt: timestamp,
        submissionIntentAt: undefined,
      };
    }
    task.updatedAt = timestamp;
  }

  create(params: TaskAddParams, source: NonNullable<Task['source']> = 'manual'): TaskServiceResult<Task[]> {
    const accessError = this.deps.generationAccessError?.();
    if (accessError) return { success: false, error: accessError };
    const prompts = (params.prompts || []).map((prompt) => prompt.trim()).filter(Boolean);
    if (prompts.length === 0) return { success: false, error: '请输入至少一条提示词' };
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const mode: GenerationMode = params.mode || 'chat';
    const targetPlatform: AccountPlatform = params.targetPlatform === 'dola' ? 'dola' : 'doubao';
    const modeError = validateGenerationModeForPlatform(mode, targetPlatform);
    if (modeError) return { success: false, error: modeError };
    const configError = validateVideoConfigForPlatform(mode, params.videoConfig, targetPlatform);
    if (configError) return { success: false, error: configError };
    const materialError = validateReferenceMaterialCounts(params);
    if (materialError) return { success: false, error: materialError };
    const normalizedAudios = [...new Set([...(params.audioAttachments || []), params.audioAttachment || ''].filter(Boolean))];
    const created = prompts.map((prompt): Task => {
      const timestamp = this.now();
      return {
        id: this.id(), prompt, targetPlatform,
        assignedAccountId: null, status: 'queued', mode,
        videoConfig: params.videoConfig, attachments: params.attachments,
        referenceVideos: params.referenceVideos,
        audioAttachment: normalizedAudios[0],
        audioAttachments: normalizedAudios.length ? normalizedAudios : undefined,
        result: null, outputs: [], artifacts: [],
        runHistory: [], source, dependsOnTaskIds: [],
        projectId: params.projectId || this.deps.defaultProjectId(),
        createdAt: timestamp, updatedAt: timestamp,
      };
    });
    tasks.push(...created);
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true, data: created };
  }

  /** 批次一次落盘，避免中途失败留下可被普通队列误发的分镜。 */
  createStoryboardBatch(batchId: string, input: StoryboardBatchInput): TaskServiceResult<Task[]> {
    const accessError = this.deps.generationAccessError?.();
    if (accessError) return { success: false, error: accessError };
    if (!batchId || !input.rows.length || input.rows.length > 100 || input.rows.some((row) => !row.prompt.trim() || !row.id)) {
      return { success: false, error: '分镜批次格式无效' };
    }
    if (this.deps.accountPlatformById?.(input.accountId) !== 'doubao') return { success: false, error: '请选择有效的豆包账号' };
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    if (tasks.some((task) => task.canvasBatch?.batchId === batchId)) return { success: false, error: '批次已经创建' };
    const created = input.rows.map((row): Task => ({
      id: this.id(), prompt: row.prompt, mode: 'video', targetPlatform: 'doubao',
      assignedAccountId: input.accountId, status: 'paused', attachments: row.images,
      canvasBatch: { batchId, rowId: row.id, number: row.number }, batchId,
      result: '请在“并发”页面创建画布草稿并确认提交', outputs: [], artifacts: [],
      source: 'workflow', projectId: input.projectId, createdAt: this.now(), updatedAt: this.now(),
    }));
    // 保留 Repository.read() 返回数组的版本基线，复制数组会被防覆盖校验拒绝。
    tasks.push(...created);
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true, data: created };
  }

  assign(params: TaskAssignParams): TaskServiceResult {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const task = tasks.find((item) => item.id === params.taskId);
    if (!task) return { success: false, error: '任务不存在' };
    if (task.canvasBatch) return { success: false, error: '画布分镜请在“并发”页面管理，不能改派为对话任务' };
    if (ACTIVE.has(task.status)) return { success: false, error: '任务正在自动化执行中，无法重新指派' };
    const taskPlatform = task.targetPlatform || 'doubao';
    const modeError = validateGenerationModeForPlatform(task.mode, taskPlatform);
    if (modeError) return { success: false, error: modeError };
    const configError = validateVideoConfigForPlatform(task.mode, task.videoConfig, taskPlatform);
    if (configError) return { success: false, error: configError };
    if (this.deps.accountPlatformById) {
      const accountPlatform = this.deps.accountPlatformById(params.accountId);
      if (!accountPlatform) return { success: false, error: '账号不存在' };
      if (accountPlatform !== (task.targetPlatform || 'doubao')) {
        return { success: false, error: '任务平台与账号平台不一致，无法指派' };
      }
    }
    task.assignedAccountId = params.accountId;
    this.resetTaskForQueue(task, this.now());
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true };
  }

  update(params: { taskId: string; updates: TaskUpdateInput }): TaskServiceResult<Task> {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const task = tasks.find((item) => item.id === params.taskId);
    if (!task) return { success: false, error: '任务不存在' };
    const prompt = params.updates?.prompt?.trim();
    if (task.canvasBatch) return { success: false, error: '画布分镜请在“并发”页面管理' };
    if (!prompt) return { success: false, error: '提示词不能为空' };
    const taskPlatform = task.targetPlatform || 'doubao';
    const modeError = validateGenerationModeForPlatform(task.mode, taskPlatform);
    if (modeError) return { success: false, error: modeError };
    const configError = validateVideoConfigForPlatform(task.mode, params.updates.videoConfig, taskPlatform);
    if (configError) return { success: false, error: configError };
    const materialError = validateReferenceMaterialCounts(params.updates);
    if (materialError) return { success: false, error: materialError };
    const normalizedAudios = [...new Set([
      ...(params.updates.audioAttachments || []),
      params.updates.audioAttachment || '',
    ].filter(Boolean))];
    task.prompt = prompt;
    task.videoConfig = params.updates.videoConfig;
    task.attachments = params.updates.attachments?.length ? params.updates.attachments : undefined;
    task.referenceVideos = params.updates.referenceVideos?.length ? params.updates.referenceVideos : undefined;
    task.audioAttachment = normalizedAudios[0];
    task.audioAttachments = normalizedAudios.length ? normalizedAudios : undefined;
    this.resetTaskForQueue(task, this.now());
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true, data: task };
  }

  updateStatus(params: TaskUpdateStatusParams): TaskServiceResult {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const task = tasks.find((item) => item.id === params.taskId);
    if (!task) return { success: false, error: '任务不存在' };
    task.status = params.status;
    if (params.result !== undefined) task.result = params.result;
    if (params.outputs !== undefined) {
      task.outputs = [...new Set(params.outputs.filter(Boolean))];
      const existing = new Map((task.artifacts || []).map((artifact) => [artifact.url, artifact]));
      for (const url of task.outputs) {
        const current = existing.get(url);
        if (current) {
          current.kind = inferArtifactKind(url, current.kind, current.validation?.contentType, task.mode);
          continue;
        }
        existing.set(url, {
          id: artifactId(url), url,
          kind: inferArtifactKind(url, task.mode === 'video' ? 'video' : task.mode === 'image' ? 'image' : 'file', undefined, task.mode),
          source: 'network', runId: task.runtime?.runId,
          conversationUrl: task.runtime?.conversationUrl, discoveredAt: this.now(),
        });
      }
      task.artifacts = [...existing.values()];
    }
    if (params.status === 'done') task.errorInfo = undefined;
    task.updatedAt = this.now();
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true };
  }

  /**
   * 将手动提取/下载得到的地址登记到已有任务，不改变任务状态。
   * 下载记录由 IPC 层单独持久化；这里负责让产物中心能从正式任务读取该产物。
   */
  registerArtifact(params: TaskRegisterArtifactParams): TaskServiceResult<Task> {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const task = tasks.find((item) => item.id === params.taskId);
    if (!task) return { success: false, error: '任务不存在' };

    const url = typeof params.url === 'string' ? params.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) return { success: false, error: '产物地址无效' };

    const source = params.source || 'manual';
    const checkedAt = this.now();
    const contentType = params.contentType?.trim() || undefined;
    const hasValidationMetadata = contentType !== undefined
      || params.contentLength !== undefined
      || params.statusCode !== undefined;
    const kindFallback = task.mode === 'video' ? 'video' : task.mode === 'image' ? 'image' : 'file';
    const existing = (task.artifacts || []).find((artifact) => artifact.url === url);
    if (existing) {
      existing.source = source;
      existing.kind = params.kind || inferArtifactKind(url, existing.kind, contentType || existing.validation?.contentType, task.mode);
      if (params.conversationUrl) existing.conversationUrl = params.conversationUrl;
      if (params.runId) existing.runId = params.runId;
      if (hasValidationMetadata) {
        existing.validation = {
          state: 'valid',
          checkedAt,
          contentType,
          contentLength: params.contentLength,
          statusCode: params.statusCode,
        };
      }
    } else {
      const artifact: TaskArtifact = {
        id: artifactId(url),
        url,
        kind: params.kind || inferArtifactKind(url, kindFallback, contentType, task.mode),
        source,
        runId: params.runId || task.runtime?.runId,
        conversationUrl: params.conversationUrl || task.runtime?.conversationUrl,
        discoveredAt: checkedAt,
      };
      if (hasValidationMetadata) {
        artifact.validation = {
          state: 'valid',
          checkedAt,
          contentType,
          contentLength: params.contentLength,
          statusCode: params.statusCode,
        };
      }
      task.artifacts = [...(task.artifacts || []), artifact];
    }
    task.outputs = [...new Set([...(task.outputs || []), url])];
    task.updatedAt = this.now();
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true, data: task };
  }

  delete(taskId: string): TaskServiceResult {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return { success: false, error: '任务不存在' };
    if (ACTIVE.has(tasks[index].status)) return { success: false, error: '任务正在执行，请先暂停后再删除' };
    // 启动先拿锁再更新状态；删除必须在持久层拦住这段时间，不能只信前端列表。
    const lease = tasks[index].lock;
    if (lease && (!Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) > this.nowMs())) return { success: false, error: '任务执行锁尚未释放，请稍后再删除' };
    const dependentCount = tasks.filter((task) => task.dependsOnTaskIds?.includes(taskId)).length;
    if (dependentCount > 0) return { success: false, error: `仍有 ${dependentCount} 个任务依赖此任务，请先调整依赖关系` };
    tasks.splice(index, 1);
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true };
  }

  retry(taskId: string): TaskServiceResult<Task> {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return { success: false, error: '任务不存在' };
    if (requiresSubmissionReconciliation(task)) {
      return { success: false, error: '任务存在已提交记录，请先核对平台结果；为避免重复扣费，禁止重新发送' };
    }
    // waiting_verification 已释放执行锁和账号忙状态，用户完成登录/验证后
    // 必须能从这里重新入队；真正仍在执行/生成的任务继续拒绝重试。
    if (task.status === 'executing' || task.status === 'generating') {
      return { success: false, error: '任务正在执行中，无法重试' };
    }
    this.resetTaskForQueue(task, this.now());
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true, data: task };
  }

  /**
   * 额度明确耗尽后的唯一重排队入口。
   *
   * 该路径与普通 retry 分离，要求当前失败仍属于同一 run、没有任何产物
   * 或输出，并在一次持久化中完成账号改派与任务重置，避免先 retry 再 assign
   * 之间留下可重复提交的中间状态。
   */
  retryAfterQuotaExhaustion(
    params: TaskRetryAfterQuotaExhaustionParams,
  ): TaskServiceResult<Task> {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const task = tasks.find((item) => item.id === params.taskId);
    if (!task) return { success: false, error: '任务不存在' };
    if (task.mode !== 'video' || task.errorInfo?.code !== 'quota_exhausted') {
      return { success: false, error: '仅允许恢复明确额度耗尽的视频任务' };
    }
    if (task.status === 'executing' || task.status === 'generating') {
      return { success: false, error: '任务正在执行中，无法切换额度账号' };
    }
    if (!params.expectedRunId || task.runtime?.runId !== params.expectedRunId) {
      return { success: false, error: '任务运行已变化，拒绝使用过期额度恢复请求' };
    }
    if ((task.outputs?.length || 0) > 0 || (task.artifacts?.length || 0) > 0) {
      return { success: false, error: '任务已有产物或输出，禁止额度恢复重发' };
    }

    const originalAccountId = task.assignedAccountId;
    if (!originalAccountId) return { success: false, error: '额度恢复任务缺少原账号绑定' };
    const accountPlatformById = this.deps.accountPlatformById;
    if (!accountPlatformById) return { success: false, error: '无法校验账号平台，拒绝额度恢复' };
    const taskPlatform = task.targetPlatform || 'doubao';
    const originalPlatform = accountPlatformById(originalAccountId);
    if (!originalPlatform) return { success: false, error: '原账号不存在，拒绝额度恢复' };

    const hasExplicitReplacement = params.replacementAccountId !== undefined && params.replacementAccountId !== null;
    const replacementAccountId = hasExplicitReplacement
      ? params.replacementAccountId!.trim()
      : originalAccountId;
    if (!replacementAccountId) return { success: false, error: '替换账号不能为空' };
    if (hasExplicitReplacement && replacementAccountId === originalAccountId) {
      return { success: false, error: '替换账号必须不同于原账号' };
    }
    if (replacementAccountId !== originalAccountId) {
      const replacementPlatform = accountPlatformById(replacementAccountId);
      if (!replacementPlatform) return { success: false, error: '替换账号不存在，拒绝额度恢复' };
      if (replacementPlatform !== taskPlatform || originalPlatform !== taskPlatform) {
        return { success: false, error: '原账号或替换账号与任务平台不一致' };
      }
    } else if (originalPlatform !== taskPlatform) {
      return { success: false, error: '原账号与任务平台不一致' };
    }

    task.assignedAccountId = replacementAccountId;
    this.resetTaskForQueue(task, this.now());
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true, data: task };
  }

  /**
   * 提交前账号异常后的唯一自动改派入口。
   * 运行号、未提交标记、产物和平台都必须再次核对，避免把已提交任务重发到
   * 另一个账号造成重复生成或重复扣费。
   */
  retryAfterPreSubmitFailure(
    params: TaskRetryAfterPreSubmitFailureParams,
  ): TaskServiceResult<Task> {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const task = tasks.find((item) => item.id === params.taskId);
    if (!task) return { success: false, error: '任务不存在' };
    if (!['fail', 'paused', 'waiting_verification'].includes(task.status)) {
      return { success: false, error: '任务当前状态不允许提交前改派' };
    }
    if (!params.expectedRunId || task.runtime?.runId !== params.expectedRunId) {
      return { success: false, error: '任务运行已变化，拒绝使用过期改派请求' };
    }
    if (task.runtime?.submittedAt || task.runtime?.submissionConfirmedAt) {
      return { success: false, error: '任务已经留下提交记录，禁止自动改派重发' };
    }
    if ((task.outputs?.length || 0) > 0 || (task.artifacts?.length || 0) > 0) {
      return { success: false, error: '任务已有产物或输出，禁止自动改派重发' };
    }

    const originalAccountId = task.assignedAccountId;
    const replacementAccountId = params.replacementAccountId.trim();
    if (!originalAccountId) return { success: false, error: '任务缺少原账号绑定' };
    if (!replacementAccountId || replacementAccountId === originalAccountId) {
      return { success: false, error: '替换账号必须不同于原账号' };
    }
    const accountPlatformById = this.deps.accountPlatformById;
    if (!accountPlatformById) return { success: false, error: '无法校验账号平台，拒绝自动改派' };
    const taskPlatform = task.targetPlatform || 'doubao';
    const originalPlatform = accountPlatformById(originalAccountId);
    const replacementPlatform = accountPlatformById(replacementAccountId);
    if (!originalPlatform || !replacementPlatform) return { success: false, error: '原账号或替换账号不存在' };
    if (originalPlatform !== taskPlatform || replacementPlatform !== taskPlatform) {
      return { success: false, error: '原账号或替换账号与任务平台不一致' };
    }

    task.assignedAccountId = replacementAccountId;
    this.resetTaskForQueue(task, this.now());
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true, data: task };
  }

  batchPause(): TaskServiceResult {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const timestamp = this.now();
    let changed = false;
    for (const task of tasks) {
      // 该状态已经释放执行锁，但平台侧仍停在一次已提交请求的人工确认边界。
      // 批量暂停不得把它降级成普通 cancelled，否则会丢失禁止重发保护。
      if (task.status === 'waiting_generation_confirmation' || task.status === 'manual_submission_observing') continue;
      if (ACTIVE.has(task.status)) {
        task.status = 'paused';
        task.result = '批量暂停';
        task.errorInfo = { code: 'cancelled', message: '批量暂停', recoverable: true, detectedAt: timestamp };
        if (task.runtime) {
          task.runtime = { ...task.runtime, stage: 'paused', message: '批量暂停', stageStartedAt: timestamp, lastHeartbeatAt: timestamp };
        }
        task.updatedAt = timestamp;
        changed = true;
      }
    }
    if (!changed) return { success: true };
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true };
  }

  recoverInterruptedTasks(): TaskServiceResult<TaskRecoverySummary> {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };

    const timestamp = this.now();
    let recoveredTasks = 0;
    let clearedLocks = 0;
    let changed = false;

    for (const task of tasks) {
      if (task.status === 'waiting_generation_confirmation' || task.status === 'manual_submission_observing') {
        if (task.lock) {
          task.lock = undefined;
          clearedLocks++;
          changed = true;
        }
        continue;
      }
      if (!ACTIVE.has(task.status)) {
        if (task.lock) {
          task.lock = undefined;
          clearedLocks++;
          changed = true;
        }
        continue;
      }

      task.status = 'paused';
      task.result = '程序上次退出时任务仍在运行，可重新执行';
      task.errorInfo = {
        code: 'cancelled',
        message: task.result,
        recoverable: true,
        detectedAt: timestamp,
      };
      if (task.runtime) {
        task.runtime = {
          ...task.runtime,
          stage: 'paused',
          message: '程序重启，任务已安全暂停',
          stageStartedAt: timestamp,
          lastHeartbeatAt: timestamp,
        };
      }
      task.updatedAt = timestamp;
      if (task.lock) clearedLocks++;
      task.lock = undefined;

      if (task.runtime) {
        const runtime = task.runtime;
        const activeRun = task.runHistory?.find(
          (run) => run.runId === runtime.runId && !run.finishedAt,
        );
        if (activeRun) {
          activeRun.finishedAt = timestamp;
          activeRun.finalStage = 'paused';
          activeRun.outcome = 'paused';
          activeRun.errorCode = 'cancelled';
          activeRun.durationMs = Math.max(0, new Date(timestamp).getTime() - new Date(activeRun.startedAt).getTime());
        }
      }

      recoveredTasks++;
      changed = true;
    }

    if (!changed) return { success: true, data: { recoveredTasks: 0, clearedLocks: 0 } };
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true, data: { recoveredTasks, clearedLocks } };
  }

  updateRuntime(params: TaskUpdateRuntimeParams): TaskServiceResult<Task> {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const task = tasks.find((item) => item.id === params.taskId);
    if (!task) return { success: false, error: '任务不存在' };

    const timestamp = this.now();

    if (params.status) task.status = params.status;
    if (params.result !== undefined) task.result = params.result;
    if (params.errorInfo === null) task.errorInfo = undefined;
    else if (params.errorInfo) task.errorInfo = params.errorInfo;

    if (params.runtime) {
      if (!task.runtime && !params.runtime.runId) {
        return { success: false, error: '运行快照尚未初始化' };
      }
      const startsNewRun = Boolean(
        params.runtime.runId && task.runtime?.runId && params.runtime.runId !== task.runtime.runId,
      );
      // 新 run 必须替换而不是合并旧快照。否则旧 submittedAt/conversationUrl 会
      // 穿透到改派后的新运行，防重复门禁会把安全的新提交误判为二次发送。
      // 旧 run 的不可变证据仍保留在 runHistory 中。
      task.runtime = (startsNewRun
        ? { ...params.runtime }
        : { ...(task.runtime || {}), ...params.runtime }) as TaskRunSnapshot;
      const runtime = task.runtime;
      task.runHistory = task.runHistory || [];
      let record = task.runHistory.find((item) => item.runId === runtime.runId);
      if (!record && runtime.runId && runtime.startedAt) {
        record = { runId: runtime.runId, attempt: runtime.attempt, startedAt: runtime.startedAt };
        task.runHistory.push(record);
        task.runHistory = task.runHistory.slice(-20);
      }
      if (record && params.status && TERMINAL_STATUSES.includes(params.status)) {
        record.finishedAt = timestamp;
        record.finalStage = runtime.stage;
        record.outcome = params.status === 'fail' ? 'failed' : params.status as TaskRunRecord['outcome'];
        record.errorCode = task.errorInfo?.code;
        record.durationMs = Math.max(0, new Date(timestamp).getTime() - new Date(record.startedAt).getTime());
      }
    }

    task.updatedAt = timestamp;
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true, data: task };
  }

  acquireLock(params: TaskAcquireLockParams, canvasBatchExecutor = false): TaskServiceResult<Task> {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const task = tasks.find((item) => item.id === params.taskId);
    if (!task) return { success: false, error: '任务不存在' };

    if (task.canvasBatch && !canvasBatchExecutor) return { success: false, error: '画布分镜只能通过“并发”页面执行' };
    if (task.status === 'queued') {
      const accessError = this.deps.generationAccessError?.();
      if (accessError) return { success: false, error: accessError };
    }

    const nowMs = this.nowMs();
    const accountConflict = task.assignedAccountId && tasks.some((item) =>
      item.id !== task.id &&
      item.assignedAccountId === task.assignedAccountId &&
      item.lock &&
      Date.parse(item.lock.expiresAt) > nowMs,
    );
    if (accountConflict) return { success: false, error: '该账号已经被其他任务锁定' };

    const decision = acquireTaskLease(task.lock, params.ownerId, nowMs);
    if (!decision.success) return decision;

    task.lock = decision.lock;
    task.updatedAt = new Date(nowMs).toISOString();
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };
    return { success: true, data: task };
  }

  renewLock(params: TaskRenewLockParams): TaskServiceResult<Task> {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const task = tasks.find((item) => item.id === params.taskId);
    if (!task) return { success: false, error: '任务不存在' };

    const nowMs = this.nowMs();
    const decision = renewTaskLease(task.lock, params.ownerId, nowMs);
    if (!decision.success) return decision;

    task.lock = decision.lock;
    task.updatedAt = new Date(nowMs).toISOString();
    if (!this.persist(tasks)) return { success: false, error: RENEW_WRITE_ERROR };
    return { success: true, data: task };
  }

  releaseLock(params: TaskReleaseLockParams): TaskServiceResult {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    const task = tasks.find((item) => item.id === params.taskId);
    if (!task) return { success: false, error: '任务不存在' };

    if (!canReleaseTaskLease(task.lock, params.ownerId)) {
      return { success: false, error: '任务锁 owner 不匹配' };
    }

    const nowMs = this.nowMs();
    task.lock = undefined;
    task.updatedAt = new Date(nowMs).toISOString();
    if (!this.persist(tasks)) return { success: false, error: RELEASE_WRITE_ERROR };
    return { success: true };
  }

  /** CSV 批量导入：纯文本解析 → 字段规范化 → 账号匹配 → 依赖映射 → 单次 Repository 写入 */
  importCsv(command: TaskCsvImportCommand): TaskServiceResult<TaskCsvImportResultData> {
    // 1. 去除 UTF-8 BOM
    const text = command.text.replace(/^\uFEFF/, '');

    // 2. 纯解析（parseCsv 可能抛出未闭合引号错误）
    let rows: string[][];
    try {
      rows = parseCsv(text);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    // 3. 结构校验：至少包含表头和一行数据
    if (rows.length < 2) return { success: false, error: 'CSV 没有可导入的数据行' };

    // 4. 识别表头列索引
    const headers = rows[0].map((header) => header.trim().toLowerCase());
    const indexOf = (...names: string[]): number =>
      names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
    const promptIndex = indexOf('prompt', '提示词');

    // 5. 结构校验：必须存在 prompt 或 提示词 列
    if (promptIndex < 0) return { success: false, error: 'CSV 必须包含 prompt 或 提示词 列' };

    // 6. 纯行处理：字段规范化、账号匹配、空行跳过（无副作用）
    const modeIndex = indexOf('mode', '模式');
    const modelIndex = indexOf('model', '模型');
    const durationIndex = indexOf('duration', '时长');
    const ratioIndex = indexOf('aspectratio', 'aspect_ratio', '比例');
    const attachmentsIndex = indexOf('attachments', '参考图片');
    const videosIndex = indexOf('referencevideos', 'reference_videos', '参考视频');
    const audioIndex = indexOf('audio', '参考音频');
    const audiosIndex = indexOf('audioattachments', 'audio_attachments', '参考音频列表');
    const accountIndex = indexOf('account', '账号');
    const platformIndex = indexOf('platform', '平台');
    const dependsIndex = indexOf('depends_on', '依赖行');
    const policyIndex = indexOf('dependency_policy', '依赖策略');

    const errors: string[] = [];
    const sourceRows: number[] = [];

    interface CsvPartialTask {
      prompt: string;
      mode: GenerationMode;
      targetPlatform: AccountPlatform;
      assignedAccountId: string | null;
      videoConfig: Task['videoConfig'];
      attachments: string[] | undefined;
      referenceVideos: string[] | undefined;
      audioAttachment: string | undefined;
      audioAttachments: string[] | undefined;
      dependencyPolicy: 'all_done' | 'all_finished';
      dependsOnRaw: string;
    }
    const partialTasks: CsvPartialTask[] = [];

    for (let dataIndex = 1; dataIndex < rows.length; dataIndex++) {
      const row = rows[dataIndex];
      const prompt = (row[promptIndex] || '').trim();
      if (!prompt) {
        errors.push(`第 ${dataIndex + 1} 行：提示词为空`);
        continue;
      }
      const rawMode = modeIndex >= 0 ? row[modeIndex] || '' : '';
      const mode = parseCsvModeStrict(rawMode);
      if (!mode) {
        errors.push(`第 ${dataIndex + 1} 行：模式「${rawMode.trim()}」无效`);
        continue;
      }
      const rawModel = modelIndex >= 0 ? (row[modelIndex] || '').trim() : '';
      const rawDuration = durationIndex >= 0 ? (row[durationIndex] || '').trim() : '';
      const rawAspectRatio = ratioIndex >= 0 ? (row[ratioIndex] || '').trim() : '';
      if (mode === 'video' && rawModel && !VALID_MODELS.includes(rawModel as VideoModel)) {
        errors.push(`第 ${dataIndex + 1} 行：视频模型「${rawModel}」无效`);
        continue;
      }
      if (mode === 'video' && rawDuration && !VALID_DURATIONS.includes(rawDuration as VideoDuration)) {
        errors.push(`第 ${dataIndex + 1} 行：视频时长「${rawDuration}」无效`);
        continue;
      }
      if (mode === 'video' && rawAspectRatio && !VALID_RATIOS.includes(rawAspectRatio as VideoAspectRatio)) {
        errors.push(`第 ${dataIndex + 1} 行：画面比例「${rawAspectRatio}」无效`);
        continue;
      }
      const accountName = accountIndex >= 0 ? (row[accountIndex] || '').trim() : '';
      const accountResolution = resolveCsvAccount(accountName, command.accounts);
      if (accountResolution.error) {
        errors.push(`第 ${dataIndex + 1} 行：${accountResolution.error}`);
        continue;
      }
      const rawPlatform = platformIndex >= 0 ? (row[platformIndex] || '').trim() : '';
      const explicitPlatform = parseCsvPlatformStrict(rawPlatform);
      if (explicitPlatform === null) {
        errors.push(`第 ${dataIndex + 1} 行：平台「${rawPlatform}」无效`);
        continue;
      }
      const assignedPlatform = accountResolution.account
        ? accountResolution.account.platform || 'doubao'
        : undefined;
      if (explicitPlatform && assignedPlatform && explicitPlatform !== assignedPlatform) {
        errors.push(`第 ${dataIndex + 1} 行：任务平台与指派账号平台不一致`);
        continue;
      }
      const rawPolicy = policyIndex >= 0 ? (row[policyIndex] || '').trim() : '';
      if (rawPolicy && rawPolicy !== 'all_done' && rawPolicy !== 'all_finished') {
        errors.push(`第 ${dataIndex + 1} 行：依赖策略「${rawPolicy}」无效`);
        continue;
      }

      partialTasks.push({
        prompt,
        mode,
        targetPlatform: assignedPlatform || explicitPlatform || 'doubao',
        assignedAccountId: accountResolution.account?.id || null,
        videoConfig: mode === 'video' ? {
          model: (rawModel || 'seedance-2.0-mini') as VideoModel,
          duration: (rawDuration || '10s') as VideoDuration,
          aspectRatio: (rawAspectRatio || '16:9') as VideoAspectRatio,
        } : undefined,
        attachments: attachmentsIndex >= 0
          ? (row[attachmentsIndex] || '').split('|').map((item) => item.trim()).filter(Boolean)
          : undefined,
        referenceVideos: videosIndex >= 0
          ? (row[videosIndex] || '').split('|').map((item) => item.trim()).filter(Boolean)
          : undefined,
        audioAttachment: audioIndex >= 0 ? (row[audioIndex] || '').trim() || undefined : undefined,
        audioAttachments: audiosIndex >= 0
          ? (row[audiosIndex] || '').split('|').map((item) => item.trim()).filter(Boolean)
          : undefined,
        dependencyPolicy: rawPolicy === 'all_finished' ? 'all_finished' : 'all_done',
        dependsOnRaw: dependsIndex >= 0 ? (row[dependsIndex] || '') : '',
      });
      const materialError = validateReferenceMaterialCounts(partialTasks[partialTasks.length - 1]);
      if (materialError) {
        partialTasks.pop();
        errors.push(`第 ${dataIndex + 1} 行：${materialError}`);
        continue;
      }
      sourceRows.push(dataIndex + 1);
    }

    // 7. 零有效任务：返回 success，不调用 Repository read、ID、时钟或 replace
    if (partialTasks.length === 0) {
      return {
        success: true,
        data: {
          tasks: [],
          batchId: '',
          imported: 0,
          skipped: rows.length - 1,
          errors: errors.slice(0, 20),
        },
      };
    }

    // 8. Repository read（fail-closed）
    const existingTasks = this.readTasks();
    if (!existingTasks) return { success: false, error: WRITE_ERROR };

    // 9. 单次 now() — 整个批次共享同一时间
    const timestamp = this.now();

    // 10. 生成 batchId（后缀来自注入 ID 生成器）
    const batchId = `batch-${timestamp.replace(/[-:.TZ]/g, '').slice(0, 14)}-${this.id().slice(0, 6)}`;

    // 11. 为每个成功任务生成独立 ID 并构造 Task 对象
    const projectId = command.projectId || this.deps.defaultProjectId();
    const imported: Task[] = partialTasks.map((partial): Task => ({
      id: this.id(),
      prompt: partial.prompt,
      targetPlatform: partial.targetPlatform,
      assignedAccountId: partial.assignedAccountId,
      status: 'queued',
      mode: partial.mode,
      videoConfig: partial.videoConfig,
      attachments: partial.attachments,
      referenceVideos: partial.referenceVideos,
      audioAttachment: partial.audioAttachment,
      audioAttachments: partial.audioAttachments,
      result: null,
      outputs: [],
      artifacts: [],
      runHistory: [],
      batchId,
      source: 'csv',
      dependsOnTaskIds: [],
      dependencyPolicy: partial.dependencyPolicy,
      projectId,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));

    // 12. 构造依赖关系：CSV 行号 → 本次成功导入任务的 ID
    const taskByCsvRow = new Map(sourceRows.map((rowNumber, index) => [rowNumber, imported[index]]));
    imported.forEach((task, index) => {
      const partial = partialTasks[index];
      task.dependsOnTaskIds = partial.dependsOnRaw.split('|')
        .map((item) => Number(item.trim()))
        .map((rowNumber) => taskByCsvRow.get(rowNumber)?.id)
        .filter((id): id is string => !!id);
    });

    // 13. 所有有效任务一次性追加至 Repository 返回的受追踪数组
    existingTasks.push(...imported);

    // 14. 单次 Repository replace（fail-closed）
    if (!this.persist(existingTasks)) return { success: false, error: WRITE_ERROR };

    // 15. 返回结果
    return {
      success: true,
      data: {
        tasks: imported,
        batchId,
        imported: imported.length,
        skipped: rows.length - 1 - imported.length,
        errors: errors.slice(0, 20),
      },
    };
  }

  /** 产物校验：查找 → 注入探针 → 四态判定 → 单次 Repository 写入（fail-closed） */
  async validateArtifact(params: TaskValidateArtifactParams): Promise<TaskServiceResult<TaskValidateArtifactResultData>> {
    // 1. Repository read（fail-closed）
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };

    // 2. 查找任务与产物；不存在时零探针/零时钟/零写入
    const task = tasks.find((item) => item.id === params.taskId);
    const artifact = task?.artifacts?.find((item) => item.id === params.artifactId);
    if (!task || !artifact) return { success: false, error: '产物不存在' };

    // 3. 探针依赖注入（Electron 网络探测由 IPC 层提供）
    if (!this.deps.probeArtifact) return { success: false, error: '产物验证不可用' };
    const probe = await this.deps.probeArtifact(artifact, task.assignedAccountId);

    // 4. 单次 now() — validation.checkedAt 与 task.updatedAt 共用
    const timestamp = this.now();

    // 5. 四态判定（保持既有语义：2xx 含 206 为 valid，401/403/404/410 为 expired，其余为 invalid）
    let validation: TaskArtifact['validation'];
    if (probe.kind === 'response') {
      const { statusCode } = probe;
      const state: NonNullable<TaskArtifact['validation']>['state'] =
        statusCode >= 200 && statusCode < 300 ? 'valid'
          : [401, 403, 404, 410].includes(statusCode) ? 'expired'
            : 'invalid';
      validation = {
        state,
        checkedAt: timestamp,
        contentType: probe.contentType,
        contentLength: probe.contentLength,
        statusCode,
      };
    } else if (probe.kind === 'timeout') {
      validation = { state: 'unknown', checkedAt: timestamp, error: '验证超时' };
    } else {
      validation = { state: 'invalid', checkedAt: timestamp, error: probe.message };
    }
    artifact.validation = validation;
    if (probe.kind === 'response') {
      artifact.kind = inferArtifactKind(artifact.url, artifact.kind, probe.contentType, task.mode);
    }
    task.updatedAt = timestamp;

    // 6. 单次 Repository replace（fail-closed，写失败不返回成功）
    if (!this.persist(tasks)) return { success: false, error: WRITE_ERROR };

    // 7. 返回：valid 标志由 state 派生，错误消息沿用 validation.error
    return {
      success: true,
      data: { valid: validation.state === 'valid', artifact },
    };
  }

  /** 只读查询：返回全部任务（零写入） */
  getTasks(): TaskServiceResult<Task[]> {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    return { success: true, data: tasks };
  }

  /** 只读查询：已完成且有产物的任务摘要（零写入） */
  getCompletedOutputs(): TaskServiceResult<CompletedOutput[]> {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    return {
      success: true,
      data: tasks
        .filter((task) => task.status === 'done' && task.outputs.length > 0)
        .map((task) => ({
          taskId: task.id,
          prompt: task.prompt,
          outputs: task.outputs,
          accountId: task.assignedAccountId,
          mode: task.mode,
        })),
    };
  }

  /** 只读查询：导出诊断用的脱敏任务投影（路径名经注入 basename 收敛，零写入） */
  buildTaskDiagnostics(): TaskServiceResult<Task[]> {
    const tasks = this.readTasks();
    if (!tasks) return { success: false, error: WRITE_ERROR };
    return {
      success: true,
      data: tasks.map((task) => ({
        ...task,
        prompt: `[已脱敏，长度 ${task.prompt.length}]`,
        attachments: (task.attachments || []).map((item) => this.basename(item)),
        referenceVideos: (task.referenceVideos || []).map((item) => this.basename(item)),
        audioAttachment: task.audioAttachment ? this.basename(task.audioAttachment) : undefined,
        audioAttachments: (task.audioAttachments || []).map((item) => this.basename(item)),
        outputs: task.outputs.map((_, index) => `[产物地址 ${index + 1}]`),
        artifacts: (task.artifacts || []).map((artifact) => ({ ...artifact, url: '[已脱敏]' })),
      })),
    };
  }
}
