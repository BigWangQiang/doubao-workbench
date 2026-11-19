import { createHash, timingSafeEqual } from 'crypto';
import { createReadStream } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import type { Account, Project, Task, TaskAddParams, VideoModel } from '@doubao-studio/contracts';
import type { ControlCommandResult, ControlTaskAction } from './controlTypes';

const API_VERSION = 'v1';
const UNBATCHED = '_unbatched';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PLUGIN_BODY_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const VIDEO_MODELS: readonly VideoModel[] = ['seedance-2.5', 'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini'];
const DOLA_VIDEO_MODELS: readonly VideoModel[] = ['seedance-2.5', 'seedance-2.0-fast'];
const IMAGE_CAPABILITIES = {
  doubao: ['doubao-image'],
  dola: ['dola-image'],
} as const;

export interface LocalPluginArtifactFile {
  filePath: string;
  kind: 'image' | 'video' | 'file';
  contentType?: string;
  bytes?: number;
}

export interface LocalControlDependencies {
  token: string;
  expiresAtMs: number;
  listProjects: () => Project[];
  listTasks: () => Task[];
  isRendererReady: () => boolean;
  /** 常规启动仅启用本机插件 API；旧 Agent 控制路由保持显式 opt-in。 */
  enableTaskControls?: boolean;
  listPluginAccounts?: () => Account[];
  createPluginTasks?: (params: TaskAddParams) => Task[];
  authorizePluginTasks?: () => Promise<void>;
  getPluginTask?: (taskId: string) => Task | null;
  listPluginArtifactFiles?: (taskId: string) => LocalPluginArtifactFile[];
  isLocalMediaFile?: (filePath: string, kind: 'image' | 'video' | 'audio') => boolean;
  notifyPluginTaskAvailable?: (taskId: string) => void;
  dispatch: (command: {
    requestId: string;
    action: ControlTaskAction;
    projectId: string;
    batchId: string;
    taskId: string;
  }) => Promise<ControlCommandResult>;
  now?: () => string;
  nowMs?: () => number;
}

interface CachedResponse {
  fingerprint: string;
  status: number;
  body: Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function sanitizeProject(project: Project, tasks: Task[]): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    archived: project.archived,
    taskCount: tasks.filter((task) => (task.projectId || 'default-project') === project.id).length,
  };
}

function sanitizeTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    projectId: task.projectId || 'default-project',
    batchId: task.batchId || UNBATCHED,
    status: task.status,
    mode: task.mode,
    assignedAccountId: task.assignedAccountId,
    stage: task.runtime?.stage,
    attempt: task.runtime?.attempt,
    errorCode: task.errorInfo?.code,
    outputCount: task.outputs.length,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_JSON');
  return parsed as Record<string, unknown>;
}

async function readJsonLimited(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_JSON');
  return parsed as Record<string, unknown>;
}

function sanitizePluginAccount(account: Account): Record<string, unknown> {
  const platform = account.platform === 'dola' ? 'dola' : 'doubao';
  return {
    id: account.id,
    name: account.name,
    platform,
    status: account.status,
    loginState: account.health?.loginState || 'unknown',
    availability: account.health?.availability?.state || 'unknown',
    modes: ['image', 'video'],
  };
}

function summarizePluginAccountPools(accounts: Account[]): Record<'doubao' | 'dola', { total: number }> {
  return accounts.reduce<Record<'doubao' | 'dola', { total: number }>>((summary, account) => {
    const platform = account.platform === 'dola' ? 'dola' : 'doubao';
    summary[platform].total += 1;
    return summary;
  }, { doubao: { total: 0 }, dola: { total: 0 } });
}

function isSafeLocalMediaPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && path.isAbsolute(value)
    && !value.includes('\0')
    && !/^(?:https?|data|resource):/i.test(value);
}

function safeContentType(file: LocalPluginArtifactFile): string {
  const supplied = file.contentType?.split(';', 1)[0].trim().toLowerCase();
  if (supplied && /^(?:image\/(?:png|jpeg|webp|gif)|video\/(?:mp4|webm|quicktime)|application\/octet-stream)$/.test(supplied)) {
    return supplied;
  }
  const extension = path.extname(file.filePath).toLowerCase();
  if (['.jpg', '.jpeg'].includes(extension)) return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (['.mp4', '.m4v'].includes(extension)) return 'video/mp4';
  if (['.mov'].includes(extension)) return 'video/quicktime';
  if (['.webm'].includes(extension)) return 'video/webm';
  if (extension === '.png') return 'image/png';
  return file.kind === 'image' ? 'image/png' : file.kind === 'video' ? 'video/mp4' : 'application/octet-stream';
}

export class LocalControlServer {
  private server: Server | null = null;
  private port = 0;
  private readonly replay = new Map<string, CachedResponse>();
  private readonly inFlight = new Map<string, { fingerprint: string; response: Promise<CachedResponse> }>();
  private readonly pluginTasks = new Set<string>();
  private readonly pluginReplay = new Map<string, { fingerprint: string; taskIds: string[] }>();
  private readonly pluginInFlight = new Map<string, { fingerprint: string; response: Promise<CachedResponse> }>();
  private readonly now: () => string;
  private readonly nowMs: () => number;

  constructor(private readonly deps: LocalControlDependencies) {
    this.now = deps.now || (() => new Date().toISOString());
    this.nowMs = deps.nowMs || (() => Date.now());
  }

  async start(requestedPort = 0): Promise<number> {
    if (this.server) throw new Error('CONTROL_SERVER_ALREADY_STARTED');
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
      throw new Error('INVALID_CONTROL_PORT');
    }
    const server = createServer((req, res) => void this.handle(req, res));
    server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = 0;
    this.replay.clear();
    this.inFlight.clear();
    this.pluginTasks.clear();
    this.pluginReplay.clear();
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  /** 只暴露本机服务状态，连接令牌不进入渲染进程。 */
  getPluginConnectionState(): 'ready' | 'starting' | 'expired' | 'unavailable' {
    if (!this.server?.listening || !this.deps.listPluginAccounts) return 'unavailable';
    if (this.nowMs() >= this.deps.expiresAtMs) return 'expired';
    return this.deps.isRendererReady() ? 'ready' : 'starting';
  }

  // 单一封闭路由表刻意集中安全门禁，便于审计每条路径均经过 Host/Origin/Auth 校验。
  // eslint-disable-next-line complexity
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = this.port || (this.server?.address() as AddressInfo | null)?.port || 0;
    if (!isAllowedHost(req.headers.host, port) || !isAllowedOrigin(req.headers.origin, port)) {
      send(res, 403, { ok: false, code: 'LOCAL_ORIGIN_REQUIRED' });
      return;
    }
    if (!authorized(req.headers.authorization, this.deps.token)) {
      send(res, 401, { ok: false, code: 'UNAUTHORIZED' });
      return;
    }
    if (this.nowMs() >= this.deps.expiresAtMs) {
      send(res, 401, { ok: false, code: 'TOKEN_EXPIRED' });
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[0] !== API_VERSION) {
        send(res, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }
      if (req.method === 'GET' && parts[1] === 'health' && parts.length === 2) {
        const rendererReady = this.deps.isRendererReady();
        send(res, 200, { ok: true, ready: rendererReady, rendererReady, protocolVersion: API_VERSION, pid: process.pid, time: this.now() });
        return;
      }
      if (parts[1] === 'plugin') {
        await this.handlePlugin(req, res, parts, port);
        return;
      }
      if (this.deps.enableTaskControls === false) {
        send(res, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }
      const projects = this.deps.listProjects();
      const tasks = this.deps.listTasks();
      if (req.method === 'GET' && parts[1] === 'projects' && parts.length === 2) {
        send(res, 200, { ok: true, projects: projects.map((project) => sanitizeProject(project, tasks)) });
        return;
      }
      const projectId = parts[2];
      if (parts[1] !== 'projects' || !SAFE_ID.test(projectId || '')) {
        send(res, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }
      const project = projects.find((item) => item.id === projectId);
      if (!project) {
        send(res, 404, { ok: false, code: 'PROJECT_NOT_FOUND' });
        return;
      }
      const projectTasks = tasks.filter((task) => (task.projectId || 'default-project') === projectId);
      if (req.method === 'GET' && parts.length === 3) {
        send(res, 200, { ok: true, project: sanitizeProject(project, tasks) });
        return;
      }
      if (parts[3] !== 'batches') {
        send(res, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }
      if (req.method === 'GET' && parts.length === 4) {
        const batches = [...new Set(projectTasks.map((task) => task.batchId || UNBATCHED))];
        send(res, 200, { ok: true, batches: batches.map((batchId) => ({
          id: batchId,
          taskCount: projectTasks.filter((task) => (task.batchId || UNBATCHED) === batchId).length,
        })) });
        return;
      }
      const batchId = parts[4];
      if (!SAFE_ID.test(batchId || '') || parts[5] !== 'tasks') {
        send(res, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }
      const batchTasks = projectTasks.filter((task) => (task.batchId || UNBATCHED) === batchId);
      if (req.method === 'GET' && parts.length === 6) {
        send(res, 200, { ok: true, tasks: batchTasks.map(sanitizeTask) });
        return;
      }
      const taskId = parts[6];
      if (!SAFE_ID.test(taskId || '')) {
        send(res, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }
      const task = batchTasks.find((item) => item.id === taskId);
      if (!task) {
        const sameProject = projectTasks.some((item) => item.id === taskId);
        send(res, 404, { ok: false, code: sameProject ? 'BATCH_TASK_MISMATCH' : 'TASK_NOT_FOUND' });
        return;
      }
      if (req.method === 'GET' && parts.length === 7) {
        send(res, 200, { ok: true, task: sanitizeTask(task) });
        return;
      }
      const action = parts[7] as ControlTaskAction;
      if (req.method !== 'POST' || parts.length !== 8 || !['start', 'pause', 'cancel', 'retry'].includes(action)) {
        send(res, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }
      const body = await readJson(req);
      const requestId = typeof body.requestId === 'string' ? body.requestId : '';
      if (!SAFE_ID.test(requestId) || requestId.length < 8) {
        send(res, 400, { ok: false, code: 'INVALID_REQUEST_ID' });
        return;
      }
      const fingerprint = createHash('sha256').update(`${action}\n${projectId}\n${batchId}\n${taskId}`).digest('hex');
      const prior = this.replay.get(requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) send(res, 409, { ok: false, code: 'REQUEST_ID_CONFLICT' });
        else send(res, prior.status, prior.body);
        return;
      }
      const pending = this.inFlight.get(requestId);
      if (pending) {
        if (pending.fingerprint !== fingerprint) {
          send(res, 409, { ok: false, code: 'REQUEST_ID_CONFLICT' });
          return;
        }
        const replayed = await pending.response;
        send(res, replayed.status, replayed.body);
        return;
      }
      const responsePromise = this.deps.dispatch({ requestId, action, projectId, batchId, taskId }).then((result) => {
        const unavailable = result.code === 'RENDERER_UNAVAILABLE' || result.code === 'RENDERER_NOT_READY';
        const status = result.ok ? 202 : unavailable ? 503 : 409;
        return {
          fingerprint,
          status,
          body: { ok: result.ok, code: result.code, accepted: result.accepted === true, requestId },
        };
      });
      this.inFlight.set(requestId, { fingerprint, response: responsePromise });
      const completed = await responsePromise.finally(() => this.inFlight.delete(requestId));
      this.replay.set(requestId, completed);
      if (this.replay.size > 1000) {
        const oldest = this.replay.keys().next().value;
        if (oldest) this.replay.delete(oldest);
      }
      send(res, completed.status, completed.body);
    } catch (error) {
      const code = error instanceof Error && error.message === 'BODY_TOO_LARGE'
        ? 'BODY_TOO_LARGE'
        : 'INVALID_REQUEST';
      send(res, code === 'BODY_TOO_LARGE' ? 413 : 400, { ok: false, code });
    }
  }

  private async handlePlugin(req: IncomingMessage, res: ServerResponse, parts: string[], port: number): Promise<void> {
    const rendererReady = this.deps.isRendererReady();
    if (req.method === 'GET' && parts.length === 3 && parts[2] === 'capabilities') {
      if (!this.deps.listPluginAccounts) {
        send(res, 503, { ok: false, code: 'PLUGIN_API_UNAVAILABLE' });
        return;
      }
      const accounts = this.deps.listPluginAccounts();
      send(res, 200, {
        ok: true,
        // 插件任务由主进程 TaskService 持久化，Renderer 尚未挂载时也可以安全入队。
        ready: true,
        rendererReady,
        accounts: accounts.map(sanitizePluginAccount),
        accountPools: summarizePluginAccountPools(accounts),
        accountSelection: 'automatic-pool',
        videoModels: { doubao: VIDEO_MODELS, dola: DOLA_VIDEO_MODELS },
        imageCapabilities: IMAGE_CAPABILITIES,
        imageModelSelection: 'account-page',
      });
      return;
    }

    if (req.method === 'POST' && parts.length === 3 && parts[2] === 'tasks') {
      await this.createPluginTasks(req, res);
      return;
    }

    if (parts.length >= 4 && parts[2] === 'tasks' && SAFE_ID.test(parts[3]) && this.pluginTasks.has(parts[3])) {
      const taskId = parts[3];
      if (req.method === 'GET' && parts.length === 4) {
        const task = this.deps.getPluginTask?.(taskId);
        if (!task) {
          send(res, 404, { ok: false, code: 'TASK_NOT_FOUND' });
          return;
        }
        const percentByStatus: Record<Task['status'], number> = {
          queued: 10, executing: 25, generating: 65, waiting_verification: 50,
          waiting_generation_confirmation: 70, manual_submission_observing: 75,
          paused: 30, done: 100, fail: 100, cancelled: 100,
        };
        send(res, 200, {
          ok: true,
          task: {
            id: task.id,
            status: task.status,
            progress: task.status === 'done' ? 100 : percentByStatus[task.status],
            stage: task.runtime?.stage,
            message: task.runtime?.message,
            error: task.errorInfo?.message || (task.status === 'fail' ? task.result : undefined),
          },
        });
        return;
      }

      if (req.method === 'GET' && parts.length === 5 && parts[4] === 'artifacts') {
        const files = this.deps.listPluginArtifactFiles?.(taskId) || [];
        send(res, 200, {
          ok: true,
          artifacts: files.map((file, index) => ({
            index,
            kind: file.kind,
            name: path.basename(file.filePath),
            bytes: file.bytes,
            contentType: safeContentType(file),
            downloadPath: `/v1/plugin/tasks/${encodeURIComponent(taskId)}/artifacts/${index}`,
          })),
        });
        return;
      }

      if (req.method === 'GET' && parts.length === 6 && parts[4] === 'artifacts' && /^\d+$/.test(parts[5])) {
        const index = Number(parts[5]);
        const file = this.deps.listPluginArtifactFiles?.(taskId)?.[index];
        if (!file || !Number.isSafeInteger(index)) {
          send(res, 404, { ok: false, code: 'ARTIFACT_NOT_FOUND' });
          return;
        }
        const stream = createReadStream(file.filePath);
        stream.once('error', () => {
          if (!res.headersSent) send(res, 404, { ok: false, code: 'ARTIFACT_NOT_FOUND' });
          else res.destroy();
        });
        res.writeHead(200, {
          'content-type': safeContentType(file),
          ...(file.bytes ? { 'content-length': file.bytes } : {}),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        stream.pipe(res);
        return;
      }
    }

    send(res, 404, { ok: false, code: 'NOT_FOUND' });
    void port;
  }

  private async createPluginTasks(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.deps.createPluginTasks || !this.deps.authorizePluginTasks || !this.deps.listPluginAccounts || !this.deps.notifyPluginTaskAvailable) {
      send(res, 503, { ok: false, code: 'PLUGIN_API_UNAVAILABLE' });
      return;
    }
    try {
      const body = await readJsonLimited(req, MAX_PLUGIN_BODY_BYTES);
      const requestId = typeof body.requestId === 'string' ? body.requestId : '';
      const requestedPlatform = body.platform === 'dola' || body.platform === 'doubao' ? body.platform : '';
      const legacyAccountId = typeof body.accountId === 'string' ? body.accountId : '';
      const mode = body.mode;
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!SAFE_ID.test(requestId) || requestId.length < 8) {
        send(res, 400, { ok: false, code: 'INVALID_REQUEST' });
        return;
      }
      if ((mode !== 'image' && mode !== 'video') || !prompt || prompt.length > 20_000) {
        send(res, 400, { ok: false, code: 'INVALID_TASK_INPUT' });
        return;
      }
      const accounts = this.deps.listPluginAccounts();
      // 2.6.0 之前的插件会提交 accountId；只借它识别渠道，不再固定到该账号。
      const legacyAccount = legacyAccountId ? accounts.find((item) => item.id === legacyAccountId) : undefined;
      const platform = requestedPlatform || (legacyAccount ? (legacyAccount.platform === 'dola' ? 'dola' : 'doubao') : '');
      if (platform !== 'doubao' && platform !== 'dola') {
        send(res, 400, { ok: false, code: 'INVALID_ACCOUNT_POOL' });
        return;
      }
      if (!accounts.some((item) => (item.platform === 'dola' ? 'dola' : 'doubao') === platform)) {
        send(res, 409, { ok: false, code: 'ACCOUNT_POOL_EMPTY' });
        return;
      }
      const readPaths = (key: string, kind: 'image' | 'video' | 'audio', max: number): string[] | null => {
        const value = body[key];
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.length > max || !this.deps.isLocalMediaFile) return null;
        const paths = value as unknown[];
        if (!paths.every((filePath) => isSafeLocalMediaPath(filePath) && this.deps.isLocalMediaFile!(filePath, kind))) return null;
        return paths as string[];
      };
      const attachments = readPaths('attachments', 'image', 30);
      const referenceVideos = readPaths('referenceVideos', 'video', 10);
      const audioAttachments = readPaths('audioAttachments', 'audio', 10);
      if (!attachments || !referenceVideos || !audioAttachments || (mode === 'image' && (referenceVideos.length || audioAttachments.length))) {
        send(res, 400, { ok: false, code: 'INVALID_LOCAL_MEDIA' });
        return;
      }
      let videoConfig: TaskAddParams['videoConfig'];
      if (mode === 'video') {
        const rawConfig = body.videoConfig;
        if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
          send(res, 400, { ok: false, code: 'INVALID_VIDEO_CONFIG' });
          return;
        }
        const config = rawConfig as Record<string, unknown>;
        const allowedModels = platform === 'dola' ? DOLA_VIDEO_MODELS : VIDEO_MODELS;
        const duration = config.duration;
        const aspectRatio = config.aspectRatio;
        if (!allowedModels.includes(config.model as VideoModel)
          || typeof duration !== 'string' || !/^\d{1,2}s$/.test(duration)
          || !['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s', '30s'].includes(duration)
          || !['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(String(aspectRatio))) {
          send(res, 400, { ok: false, code: 'INVALID_VIDEO_CONFIG' });
          return;
        }
        videoConfig = {
          model: config.model as VideoModel,
          duration: duration as NonNullable<TaskAddParams['videoConfig']>['duration'],
          aspectRatio: aspectRatio as NonNullable<TaskAddParams['videoConfig']>['aspectRatio'],
        };
      }
      const count = mode === 'image' && Number.isInteger(body.count) ? Number(body.count) : 1;
      if (count < 1 || count > 15) {
        send(res, 400, { ok: false, code: 'INVALID_COUNT' });
        return;
      }
      const fingerprint = createHash('sha256').update(JSON.stringify({
        platform, mode, prompt, attachments, referenceVideos, audioAttachments, videoConfig, count,
      })).digest('hex');
      const prior = this.pluginReplay.get(requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) send(res, 409, { ok: false, code: 'REQUEST_ID_CONFLICT' });
        else send(res, 200, { ok: true, replayed: true, taskIds: prior.taskIds });
        return;
      }
      const pending = this.pluginInFlight.get(requestId);
      if (pending) {
        if (pending.fingerprint !== fingerprint) send(res, 409, { ok: false, code: 'REQUEST_ID_CONFLICT' });
        else { const result = await pending.response; send(res, result.status, result.body); }
        return;
      }
      const params: TaskAddParams = {
        prompts: Array.from({ length: count }, () => prompt),
        targetPlatform: platform,
        mode,
        ...(videoConfig ? { videoConfig } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(referenceVideos.length ? { referenceVideos } : {}),
        ...(audioAttachments.length ? { audioAttachments, audioAttachment: audioAttachments[0] } : {}),
      };
      // 在线会员检查引入异步等待，同一请求必须共享检查和创建结果，避免重复入队。
      const response = Promise.resolve().then(async (): Promise<CachedResponse> => {
        try { await this.deps.authorizePluginTasks!(); }
        catch { return { fingerprint, status: 403, body: { ok: false, code: 'PLUGIN_ACCESS_DENIED', message: 'Lalor 会员授权未通过，请在工作台确认会员和网络状态后重试。' } }; }
        if (!this.server || this.nowMs() >= this.deps.expiresAtMs) return { fingerprint, status: 401, body: { ok: false, code: 'TOKEN_EXPIRED' } };
        const tasks = this.deps.createPluginTasks!(params);
        if (!tasks.length || tasks.length !== count) return { fingerprint, status: 503, body: { ok: false, code: 'TASK_CREATE_FAILED', message: '工作台没有创建出完整任务，请检查本地任务队列。' } };
        tasks.forEach((task) => {
          this.pluginTasks.add(task.id);
          this.deps.notifyPluginTaskAvailable!(task.id);
        });
        this.pluginReplay.set(requestId, { fingerprint, taskIds: tasks.map((task) => task.id) });
        if (this.pluginReplay.size > 1000) {
          const oldest = this.pluginReplay.keys().next().value;
          if (oldest) this.pluginReplay.delete(oldest);
        }
        return { fingerprint, status: 202, body: { ok: true, taskIds: tasks.map((task) => task.id) } };
      });
      this.pluginInFlight.set(requestId, { fingerprint, response });
      const result = await response.finally(() => this.pluginInFlight.delete(requestId));
      send(res, result.status, result.body);
    } catch (error) {
      const code = error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'TASK_CREATE_FAILED';
      send(res, code === 'BODY_TOO_LARGE' ? 413 : 400, { ok: false, code });
    }
  }
}

export const LOCAL_CONTROL_UNBATCHED = UNBATCHED;
