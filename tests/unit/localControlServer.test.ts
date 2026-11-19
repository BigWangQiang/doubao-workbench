import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { request } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Account, Project, Task, TaskAddParams } from '@doubao-studio/contracts';
import { LocalControlServer } from '../../main/control/LocalControlServer';
import type { ControlCommandResult } from '../../main/control/controlTypes';

const token = 'test-token-with-enough-entropy-for-comparison';
const project: Project = {
  id: 'project-1', name: '受控项目', description: 'private description', color: '#fff', archived: false,
  createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
};
const task: Task = {
  id: 'task-1', projectId: project.id, batchId: 'batch-1', prompt: '绝不能由控制面返回的完整提示词',
  assignedAccountId: 'account-1', status: 'queued', mode: 'video',
  attachments: ['D:\\secret\\reference.png'], audioAttachment: 'D:\\secret\\voice.mp3',
  result: null, outputs: ['https://private.example/video.mp4'], artifacts: [],
  createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
};
const account: Account = {
  id: 'account-1', name: 'Dola 验收账号', platform: 'dola', avatar: 'private-avatar', partition: 'private-partition',
  status: 'idle', pinned: false, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
  health: {
    loginState: 'ok', verificationRequired: false, consecutiveFailures: 0, successCount: 0, failureCount: 0,
    availability: { state: 'ready', reason: 'ready', message: '账号可用', checkedAt: '2026-09-05T00:00:00.000Z', source: 'manual' },
  },
};

describe('LocalControlServer', () => {
  let server: LocalControlServer | undefined;
  afterEach(async () => server?.stop());

  async function start(overrides: Partial<ConstructorParameters<typeof LocalControlServer>[0]> = {}) {
    const dispatch = vi.fn(async (command) => ({ commandId: 'command-1', ok: true, code: `${command.action.toUpperCase()}_ACCEPTED`, accepted: true }));
    server = new LocalControlServer({
      token, expiresAtMs: Date.now() + 60_000,
      listProjects: () => [project], listTasks: () => [task], isRendererReady: () => true,
      authorizePluginTasks: async (): Promise<void> => {}, dispatch, ...overrides,
    });
    const port = await server.start(0);
    return { port, dispatch, base: `http://127.0.0.1:${port}/v1` };
  }

  const auth = { authorization: `Bearer ${token}` };

  it('默认仅绑定 IPv4 loopback 且健康响应不泄露认证数据', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/health`, { headers: auth });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"protocolVersion":"v1"');
    expect(text).toContain('"rendererReady":true');
    expect(text).not.toContain(token);
  });

  it('健康检查区分 HTTP 存活与 Renderer 调度桥就绪', async () => {
    const { base } = await start({ isRendererReady: () => false });
    const response = await fetch(`${base}/health`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, ready: false, rendererReady: false });
  });

  it('插件页面不会把已过期或停止的服务显示为可连接', async () => {
    let now = 10;
    await start({ listPluginAccounts: () => [account], expiresAtMs: 100, nowMs: () => now });
    expect(server!.getPluginConnectionState()).toBe('ready');
    now = 100;
    expect(server!.getPluginConnectionState()).toBe('expired');
    await server!.stop();
    expect(server!.getPluginConnectionState()).toBe('unavailable');
  });

  it('拒绝缺失或错误令牌', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect((await fetch(`${base}/health`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('短期令牌到期后即使内容正确也拒绝访问', async () => {
    const { base } = await start({ expiresAtMs: 100, nowMs: () => 100 });
    const response = await fetch(`${base}/health`, { headers: auth });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  it('拒绝非本机 Host 与网页 Origin', async () => {
    const { base, port } = await start();
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/health`, {
        headers: { ...auth, host: `192.168.1.10:${port}` },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode || 0));
      });
      req.on('error', reject);
      req.end();
    });
    expect(hostStatus).toBe(403);
    expect((await fetch(`${base}/health`, { headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('按项目、批次、任务稳定定位并严格脱敏', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/projects/project-1/batches/batch-1/tasks/task-1`, { headers: auth });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"id":"task-1"');
    expect(text).not.toContain(task.prompt);
    expect(text).not.toContain('reference.png');
    expect(text).not.toContain('video.mp4');
    expect(text).not.toContain('private description');
  });

  it('项目或批次归属不一致时 fail-closed 且不下发命令', async () => {
    const { base, dispatch } = await start();
    const wrongBatch = await fetch(`${base}/projects/project-1/batches/batch-x/tasks/task-1/start`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'request-0001' }),
    });
    expect(wrongBatch.status).toBe(404);
    expect(await wrongBatch.json()).toMatchObject({ code: 'BATCH_TASK_MISMATCH' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(['start', 'pause', 'cancel', 'retry'] as const)('下发 %s 时携带三重 ID', async (action) => {
    const { base, dispatch } = await start();
    const response = await fetch(`${base}/projects/project-1/batches/batch-1/tasks/task-1/${action}`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: `request-${action}` }),
    });
    expect(response.status).toBe(202);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action, projectId: 'project-1', batchId: 'batch-1', taskId: 'task-1' }));
  });

  it('相同 requestId 同命令返回缓存结果，不重复执行；跨命令复用则冲突', async () => {
    const { base, dispatch } = await start();
    const call = (action: string) => fetch(`${base}/projects/project-1/batches/batch-1/tasks/task-1/${action}`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'request-replay' }),
    });
    expect((await call('start')).status).toBe(202);
    expect((await call('start')).status).toBe(202);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await call('pause')).status).toBe(409);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('并发相同 requestId 只下发一次，两个调用获得相同结果', async () => {
    let release!: (value: ControlCommandResult) => void;
    const dispatch = vi.fn(() => new Promise<ControlCommandResult>((resolve) => { release = resolve; }));
    const { base } = await start({ dispatch });
    const url = `${base}/projects/project-1/batches/batch-1/tasks/task-1/start`;
    const init = { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'request-concurrent' }) };
    const first = fetch(url, init);
    const second = fetch(url, init);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    release({ commandId: 'command-1', ok: true, code: 'START_ACCEPTED', accepted: true });
    expect((await first).status).toBe(202);
    expect((await second).status).toBe(202);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('畸形 URL 编码返回受控错误，不产生未处理拒绝', async () => {
    const { port } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/v1/projects/%E0%A4%A', headers: auth }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode || 0));
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
  });

  it('限制请求体并拒绝无效 requestId', async () => {
    const { base, dispatch } = await start();
    const url = `${base}/projects/project-1/batches/batch-1/tasks/task-1/start`;
    expect((await fetch(url, { method: 'POST', headers: auth, body: '{}' })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ requestId: 'x'.repeat(20_000) }) })).status).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('默认启动仅开放本机插件路由，Renderer 未就绪时插件仍可入队且不泄露账号凭据', async () => {
    const { base } = await start({
      enableTaskControls: false,
      listPluginAccounts: () => [account],
      isRendererReady: () => false,
    });
    const response = await fetch(`${base}/plugin/capabilities`, { headers: auth });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      ready: true,
      rendererReady: false,
      accounts: [{ id: account.id, name: account.name, platform: 'dola' }],
      accountPools: { doubao: { total: 0 }, dola: { total: 1 } },
      accountSelection: 'automatic-pool',
      videoModels: { dola: ['seedance-2.5', 'seedance-2.0-fast'] },
      imageCapabilities: { doubao: ['doubao-image'], dola: ['dola-image'] },
    });
    expect(text).not.toContain(account.partition);
    expect(text).not.toContain(account.avatar);
    expect((await fetch(`${base}/projects`, { headers: auth })).status).toBe(404);
  });

  it('Renderer 未就绪时插件视频任务仍可入队，并只绑定 Dola 账号池而非具体账号', async () => {
    let createdTask: Task | null = null;
    const createPluginTasks = vi.fn((params: TaskAddParams): Task[] => {
      createdTask = {
        ...task,
        id: 'plugin-video-task',
        prompt: params.prompts[0],
        targetPlatform: params.targetPlatform,
        assignedAccountId: null,
        mode: params.mode || 'chat',
        videoConfig: params.videoConfig,
        attachments: params.attachments,
        referenceVideos: params.referenceVideos,
        audioAttachment: params.audioAttachment,
        audioAttachments: params.audioAttachments,
      };
      return [createdTask];
    });
    const notifyPluginTaskAvailable = vi.fn();
    const { base } = await start({
      enableTaskControls: false,
      listPluginAccounts: () => [account],
      createPluginTasks,
      getPluginTask: () => createdTask,
      notifyPluginTaskAvailable,
      isLocalMediaFile: () => true,
      isRendererReady: () => false,
    });
    const payload = {
      requestId: 'zizi-video-request-1', platform: 'dola', mode: 'video', prompt: '竖屏测试视频',
      attachments: ['D:\\refs\\frame.png'], referenceVideos: ['D:\\refs\\clip.mp4'],
      audioAttachments: ['D:\\refs\\voice.wav'],
      videoConfig: { model: 'seedance-2.0-fast', duration: '15s', aspectRatio: '9:16' },
    };
    const response = await fetch(`${base}/plugin/tasks`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, taskIds: ['plugin-video-task'] });
    expect(createPluginTasks).toHaveBeenCalledWith(expect.objectContaining({
      targetPlatform: 'dola', mode: 'video', prompts: ['竖屏测试视频'],
      videoConfig: { model: 'seedance-2.0-fast', duration: '15s', aspectRatio: '9:16' },
      attachments: ['D:\\refs\\frame.png'], referenceVideos: ['D:\\refs\\clip.mp4'],
      audioAttachments: ['D:\\refs\\voice.wav'], audioAttachment: 'D:\\refs\\voice.wav',
    }));
    expect(notifyPluginTaskAvailable).toHaveBeenCalledWith('plugin-video-task');
    const status = await fetch(`${base}/plugin/tasks/plugin-video-task`, { headers: auth });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ task: { id: 'plugin-video-task', status: 'queued' } });
  });

  it('插件 requestId 幂等且冲突时 fail-closed，无效本地素材不创建任务', async () => {
    const created: Task = { ...task, id: 'plugin-image-task', mode: 'image', targetPlatform: 'dola' };
    const createPluginTasks = vi.fn(() => [created]);
    const { base } = await start({
      listPluginAccounts: () => [account], createPluginTasks,
      getPluginTask: () => created, notifyPluginTaskAvailable: vi.fn(),
      isLocalMediaFile: (filePath) => filePath.endsWith('.png'),
    });
    const call = (prompt: string, attachments = ['D:\\refs\\image.png']) => fetch(`${base}/plugin/tasks`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'zizi-image-request-1', platform: 'dola', mode: 'image', prompt, count: 1, attachments }),
    });
    expect((await call('图片任务')).status).toBe(202);
    expect((await call('图片任务')).status).toBe(200);
    expect(createPluginTasks).toHaveBeenCalledTimes(1);
    expect((await call('不同提示词')).status).toBe(409);
    expect((await call('图片任务', ['D:\\refs\\not-image.txt'])).status).toBe(400);

    const invalidRequest = await fetch(`${base}/plugin/tasks`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'zizi-image-request-2', platform: 'dola', mode: 'image', prompt: '无效素材', attachments: ['D:\\refs\\not-image.txt'] }),
    });
    expect(invalidRequest.status).toBe(400);
    expect(await invalidRequest.json()).toMatchObject({ code: 'INVALID_LOCAL_MEDIA' });
    expect(createPluginTasks).toHaveBeenCalledTimes(1);
  });

  it('会员授权失败不创建任务，重复请求在授权等待期间只创建一次', async () => {
    let release: (() => void) | undefined;
    const authorizePluginTasks = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const createPluginTasks = vi.fn(() => [{ ...task, id: 'authorized-task' }]);
    const { base } = await start({ listPluginAccounts: () => [account], createPluginTasks,
      notifyPluginTaskAvailable: vi.fn(), authorizePluginTasks });
    const payload = { requestId: 'authorized-image-1', platform: 'dola', mode: 'image', prompt: '授权测试' };
    const submit = (body = payload) => fetch(`${base}/plugin/tasks`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    const first = submit();
    await vi.waitFor(() => expect(authorizePluginTasks).toHaveBeenCalledTimes(1));
    const second = submit();
    expect((await submit({ ...payload, prompt: '另一个任务' })).status).toBe(409);
    expect(createPluginTasks).not.toHaveBeenCalled();
    release!();
    const responses = await Promise.all([first, second]);
    expect(responses.every((response) => response.status === 200 || response.status === 202)).toBe(true);
    expect(createPluginTasks).toHaveBeenCalledTimes(1);
    expect(authorizePluginTasks).toHaveBeenCalledTimes(1);
    authorizePluginTasks.mockRejectedValueOnce(new Error('membership expired'));
    const denied = await submit({ ...payload, requestId: 'authorized-image-2' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'PLUGIN_ACCESS_DENIED' });
    expect(createPluginTasks).toHaveBeenCalledTimes(1);
  });

  it('未接入授权检查的插件写入口保持关闭', async () => {
    const createPluginTasks = vi.fn(() => [task]);
    const { base } = await start({ listPluginAccounts: () => [account], createPluginTasks,
      notifyPluginTaskAvailable: vi.fn(), authorizePluginTasks: undefined });
    const response = await fetch(`${base}/plugin/tasks`, { method: 'POST', headers: auth,
      body: JSON.stringify({ requestId: 'missing-auth-check', platform: 'dola', mode: 'image', prompt: 'test' }) });
    expect(response.status).toBe(503);
    expect(createPluginTasks).not.toHaveBeenCalled();
  });

  it('仅允许下载本次插件任务的本地产物', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lalor-plugin-artifact-'));
    const filePath = join(directory, 'result.mp4');
    writeFileSync(filePath, Buffer.from('video-bytes'));
    const created: Task = { ...task, id: 'plugin-artifact-task', mode: 'video', targetPlatform: 'dola' };
    const { base } = await start({
      listPluginAccounts: () => [account], createPluginTasks: () => [created],
      getPluginTask: () => created, notifyPluginTaskAvailable: vi.fn(), isLocalMediaFile: () => true,
      listPluginArtifactFiles: (taskId) => taskId === created.id
        ? [{ filePath, kind: 'video', contentType: 'video/mp4', bytes: 11 }]
        : [],
    });
    try {
      const create = await fetch(`${base}/plugin/tasks`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'zizi-video-artifact', platform: 'dola', mode: 'video', prompt: '产物测试',
          videoConfig: { model: 'seedance-2.5', duration: '5s', aspectRatio: '16:9' },
        }),
      });
      expect(create.status).toBe(202);
      const listing = await fetch(`${base}/plugin/tasks/${created.id}/artifacts`, { headers: auth });
      expect(await listing.json()).toMatchObject({ artifacts: [{ kind: 'video', name: 'result.mp4' }] });
      const download = await fetch(`${base}/plugin/tasks/${created.id}/artifacts/0`, { headers: auth });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer()).toString()).toBe('video-bytes');
      expect((await fetch(`${base}/plugin/tasks/task-1/artifacts`, { headers: auth })).status).toBe(404);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
