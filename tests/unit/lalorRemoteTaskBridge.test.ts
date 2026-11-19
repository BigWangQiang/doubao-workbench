import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, Task, TaskAddParams } from '@doubao-studio/contracts';
import {
  LalorRemoteTaskBridge,
  buildLocalTaskParams,
  classifyRemoteResources,
  selectAccountForRemoteTask,
  type LalorRemoteTaskBinding,
  type LalorRemoteTaskBridgeDependencies,
  type LalorRemoteTaskClaim,
} from '../../main/services/lalorRemoteTaskBridge';

function account(id: string, platform: 'doubao' | 'dola'): Account {
  return {
    id,
    name: id,
    platform,
    avatar: '',
    partition: `persist:${id}`,
    status: 'idle',
    pinned: false,
    health: {
      loginState: 'ok',
      verificationRequired: false,
      consecutiveFailures: 0,
      successCount: 0,
      failureCount: 0,
      availability: {
        state: 'ready',
        reason: 'test',
        message: 'ready',
        checkedAt: '2026-09-16T00:00:00.000Z',
        source: 'manual',
      },
    },
    scheduling: { enabled: true, weight: 1, preferredModes: [] },
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
}

function claim(overrides: Partial<LalorRemoteTaskClaim> = {}): LalorRemoteTaskClaim {
  return {
    taskId: 'remote-1',
    leaseToken: 'lease-secret',
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    type: 'generation',
    mode: 'video',
    executionPlatform: 'dola',
    operation: 'canvas_video',
    prompt: '一段城市延时摄影',
    model: 'seedance-2.5',
    input: {
      mode: 'canvas_video',
      config: { model: 'seedance-2.5', videoSeconds: 30, aspectRatio: '16:9' },
      metadata: { projectId: 'project-1', nodeId: 'node-1' },
    },
    resources: [],
    ...overrides,
  };
}

function localTask(params: TaskAddParams, status: Task['status'] = 'queued'): Task {
  return {
    id: 'local-1',
    prompt: params.prompts[0],
    targetPlatform: params.targetPlatform,
    assignedAccountId: null,
    status,
    mode: params.mode || 'chat',
    videoConfig: params.videoConfig,
    attachments: params.attachments,
    referenceVideos: params.referenceVideos,
    audioAttachment: params.audioAttachment,
    audioAttachments: params.audioAttachments,
    result: null,
    outputs: [],
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: status >= 400 ? status : 0, data, msg: status >= 400 ? 'error' : 'ok' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface BridgeFixtureOptions {
  remote?: LalorRemoteTaskClaim;
  accounts?: Account[];
  leaseCancelled?: boolean;
  artifactPath?: string;
  artifactKind?: 'image' | 'video';
  repeatClaim?: boolean;
  failTransientAttempts?: number;
  bindingStore?: { value: LalorRemoteTaskBinding[] };
  taskStore?: { value: Task | null };
}

function bridgeFixture(options: BridgeFixtureOptions = {}) {
  const remote = options.remote || claim();
  let claimed = false;
  let failTransientAttempts = options.failTransientAttempts || 0;
  const bindingStore = options.bindingStore || { value: [] as LalorRemoteTaskBinding[] };
  const taskStore = options.taskStore || { value: null as Task | null };
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const notifyTaskAvailable = vi.fn();
  const notifyTaskCancelled = vi.fn();
  const cancelTask = vi.fn((taskId: string, message: string) => {
    if (taskStore.value?.id === taskId) {
      taskStore.value.status = 'cancelled';
      taskStore.value.result = message;
    }
  });
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/desktop/heartbeat')) return jsonResponse({ online: true });
    if (url.endsWith('/desktop/tasks/claim')) {
      if (claimed && !options.repeatClaim) return jsonResponse({ task: null });
      claimed = true;
      return jsonResponse({ task: remote });
    }
    if (/\/inputs\//.test(url)) {
      const resourceId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      const resource = remote.resources.find((item) => item.id === resourceId);
      return new Response(Buffer.from(resourceId, 'utf8'), {
        status: 200,
        headers: { 'Content-Type': resource?.mimeType || 'application/octet-stream', 'Content-Length': String(Buffer.byteLength(resourceId)) },
      });
    }
    if (url.endsWith('/lease')) {
      return jsonResponse({ taskId: remote.taskId, cancelled: options.leaseCancelled === true });
    }
    if (url.endsWith('/artifacts')) return jsonResponse({ artifact: { id: 'artifact-1' } });
    if (url.endsWith('/complete')) return jsonResponse({ task: { id: remote.taskId } });
    if (url.endsWith('/fail')) {
      if (failTransientAttempts > 0) {
        failTransientAttempts -= 1;
        return jsonResponse(null, 503);
      }
      return jsonResponse({ id: remote.taskId, status: 'failed', error: '本机没有可用于该任务的 Dola 账号' });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const deps: LalorRemoteTaskBridgeDependencies = {
    apiBaseUrl: 'https://lalor.test/api',
    tempRoot: tmpdir,
    withAccessToken: (callback) => callback('access-secret'),
    deviceMetadata: (currentTaskId) => ({
      deviceId: 'device-1', deviceName: 'test', appVersion: '1.0.0', platform: 'win32', currentTaskId,
    }),
    listAccounts: () => options.accounts || [account('dola-1', 'dola')],
    listTasks: () => taskStore.value ? [taskStore.value] : [],
    createTask: vi.fn((params: TaskAddParams) => {
      taskStore.value = localTask(params);
      return taskStore.value;
    }),
    assignTask: vi.fn((taskId: string, accountId: string) => {
      if (!taskStore.value || taskStore.value.id !== taskId) throw new Error('task mismatch');
      taskStore.value.assignedAccountId = accountId;
    }),
    getTask: () => taskStore.value,
    cancelTask,
    listArtifactFiles: () => options.artifactPath ? [{
      filePath: options.artifactPath,
      kind: options.artifactKind || 'video',
      contentType: options.artifactKind === 'image' ? 'image/png' : 'video/mp4',
    }] : [],
    notifyTaskAvailable,
    notifyTaskCancelled,
    loadBindings: () => bindingStore.value,
    saveBindings: (bindings) => {
      bindingStore.value = bindings;
      return true;
    },
    fetch: fetchMock as typeof globalThis.fetch,
    log: vi.fn(),
  };
  const bridge = new LalorRemoteTaskBridge(deps);
  return {
    bridge,
    deps,
    requests,
    notifyTaskAvailable,
    notifyTaskCancelled,
    cancelTask,
    bindingStore,
    taskStore,
    task: () => taskStore.value,
  };
}

async function flushImmediateBridgeWork(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Lalor remote task mapping', () => {
  it.each([
    ['text', 'chat', 'doubao'],
    ['canvas_text', 'chat', 'doubao'],
    ['image', 'image', 'doubao'],
    ['canvas_image', 'image', 'doubao'],
    ['video', 'video', 'dola'],
    ['canvas_video', 'video', 'dola'],
  ] as const)('maps %s to %s on %s only', (remoteMode, localMode, platform) => {
    const params = buildLocalTaskParams(claim({
      mode: remoteMode,
      input: { mode: remoteMode, config: { videoSeconds: 10, aspectRatio: '16:9' } },
    }));
    expect(params.mode).toBe(localMode);
    expect(params.targetPlatform).toBe(platform);
  });

  it('preserves Dola 30-second, model and exact ratio settings', () => {
    const params = buildLocalTaskParams(claim({
      model: 'Seedance 2.0 Fast',
      input: { mode: 'video', config: { model: 'Seedance 2.0 Fast', durationSeconds: 30, size: '1920x1080' } },
    }));
    expect(params.videoConfig).toEqual({
      model: 'seedance-2.0-fast',
      duration: '30s',
      aspectRatio: '16:9',
    });
  });

  it('routes Doubao video to the Doubao pool with its own model and ratio mapping', () => {
    const params = buildLocalTaskParams(claim({
      executionPlatform: 'doubao',
      model: 'Seedance 2.0 Mini',
      input: { mode: 'canvas_video', config: { model: 'Seedance 2.0 Mini', durationSeconds: 30, size: 'portrait' } },
    }));
    expect(params).toMatchObject({
      mode: 'video',
      targetPlatform: 'doubao',
      videoConfig: {
        model: 'seedance-2.0-mini',
        duration: '30s',
        aspectRatio: '9:16',
      },
    });
    expect(selectAccountForRemoteTask([
      account('dola-1', 'dola'),
      account('doubao-1', 'doubao'),
    ], [], params)?.id).toBe('doubao-1');
  });

  it('keeps legacy video claims on Dola and rejects an unknown explicit platform', () => {
    expect(buildLocalTaskParams(claim({ executionPlatform: undefined })).targetPlatform).toBe('dola');
    expect(() => buildLocalTaskParams(claim({
      executionPlatform: 'unknown' as LalorRemoteTaskClaim['executionPlatform'],
    }))).toThrow('视频执行平台无效');
  });

  it('rejects a Doubao-only model when the authoritative platform is Dola', () => {
    expect(() => buildLocalTaskParams(claim({
      executionPlatform: 'dola',
      model: 'Seedance 2.0 Mini',
      input: { mode: 'video', config: { model: 'Seedance 2.0 Mini', videoSeconds: 10, aspectRatio: '16:9' } },
    }))).toThrow('Dola 不支持视频模型');
  });

  it('keeps reference-image order and supports reference video/audio within 30/10/10 limits', () => {
    const remote = claim({
      input: {
        mode: 'video',
        config: { videoSeconds: 30, aspectRatio: '16:9' },
        referenceImages: [{ storageKey: 'resource:image-b' }, { url: 'resource:image-a' }],
      },
      resources: [
        { id: 'image-a', name: 'a.png', kind: 'image', mimeType: 'image/png', size: 10 },
        { id: 'image-b', name: 'b.png', kind: 'image', mimeType: 'image/png', size: 10 },
        { id: 'video-1', name: 'clip.mp4', kind: 'video', mimeType: 'video/mp4', size: 10 },
        { id: 'audio-1', name: 'voice.mp3', kind: 'audio', mimeType: 'audio/mpeg', size: 10 },
      ],
    });
    expect(classifyRemoteResources(remote).images.map((item) => item.id)).toEqual(['image-b', 'image-a']);
    const classified = classifyRemoteResources({
      ...remote,
      input: {
        ...remote.input,
        referenceVideos: [{ storageKey: 'resource:video-1' }],
        referenceAudios: [{ storageKey: 'resource:audio-1' }],
      },
    });
    expect(classified.videos.map((item) => item.id)).toEqual(['video-1']);
    expect(classified.audios.map((item) => item.id)).toEqual(['audio-1']);
  });

  it('rejects remote reference material counts above 30/10/10', () => {
    const resources = (kind: 'image' | 'video' | 'audio', count: number) => Array.from({ length: count }, (_, index) => ({
      id: `${kind}-${index}`,
      name: `${kind}-${index}.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'}`,
      kind,
      mimeType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg',
      size: 1,
    }));
    expect(() => classifyRemoteResources(claim({ resources: resources('image', 31) }))).toThrow('参考图片不能超过 30 张');
    expect(() => classifyRemoteResources(claim({ resources: resources('video', 11) }))).toThrow('参考视频不能超过 10 个');
    expect(() => classifyRemoteResources(claim({ resources: resources('audio', 11) }))).toThrow('参考音频不能超过 10 个');
  });

  it('never falls back to another platform account pool', () => {
    const video = buildLocalTaskParams(claim());
    expect(selectAccountForRemoteTask([account('doubao-only', 'doubao')], [], video)).toBeNull();
    expect(selectAccountForRemoteTask([
      account('doubao-1', 'doubao'),
      account('dola-1', 'dola'),
    ], [], video)?.id).toBe('dola-1');
  });
});

describe('Lalor remote task lifecycle', () => {
  it('repeatedly claimed remote task reuses the active local task', async () => {
    vi.useFakeTimers();
    const fixture = bridgeFixture({ repeatClaim: true });
    fixture.bridge.start();
    await flushImmediateBridgeWork();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fixture.deps.createTask).toHaveBeenCalledTimes(1);
    expect(fixture.notifyTaskAvailable).toHaveBeenCalledTimes(1);
    expect(fixture.requests.filter((item) => item.url.endsWith('/desktop/tasks/claim'))).toHaveLength(2);
    fixture.bridge.stop();
  });

  it('restarts with a persisted binding without creating a second local task', async () => {
    vi.useFakeTimers();
    const bindingStore = { value: [] as LalorRemoteTaskBinding[] };
    const taskStore = { value: null as Task | null };
    const first = bridgeFixture({ bindingStore, taskStore });
    first.bridge.start();
    await flushImmediateBridgeWork();
    expect(bindingStore.value).toHaveLength(1);
    first.bridge.stop();

    const second = bridgeFixture({ bindingStore, taskStore });
    second.bridge.start();
    await flushImmediateBridgeWork();

    expect(second.deps.createTask).not.toHaveBeenCalled();
    expect(second.notifyTaskAvailable).toHaveBeenCalledWith('local-1');
    expect(bindingStore.value[0].remoteTaskId).toBe('remote-1');
    second.bridge.stop();
  });

  it('does not notify a submitted task after restart, preventing an automatic resend', async () => {
    vi.useFakeTimers();
    const bindingStore = { value: [] as LalorRemoteTaskBinding[] };
    const taskStore = { value: null as Task | null };
    const first = bridgeFixture({ bindingStore, taskStore });
    first.bridge.start();
    await flushImmediateBridgeWork();
    const submittedTask = first.task();
    if (!submittedTask) throw new Error('local task missing');
    submittedTask.status = 'paused';
    submittedTask.result = '应用界面重新载入，任务已安全暂停';
    submittedTask.runtime = {
      runId: 'run-1',
      attempt: 1,
      stage: 'paused',
      message: submittedTask.result,
      startedAt: '2026-09-16T00:00:00.000Z',
      stageStartedAt: '2026-09-16T00:00:00.000Z',
      lastHeartbeatAt: '2026-09-16T00:00:00.000Z',
      submittedAt: '2026-09-16T00:01:00.000Z',
      input: {
        prompt: submittedTask.prompt,
        mode: submittedTask.mode,
        videoConfig: submittedTask.videoConfig,
        attachments: submittedTask.attachments || [],
        audioAttachment: submittedTask.audioAttachment || '',
      },
    };
    first.bridge.stop();

    const second = bridgeFixture({ bindingStore, taskStore });
    second.bridge.start();
    await flushImmediateBridgeWork();

    expect(second.deps.createTask).not.toHaveBeenCalled();
    expect(second.notifyTaskAvailable).not.toHaveBeenCalled();
    second.bridge.stop();
  });

  it('removes the persisted binding and reference directory after completion', async () => {
    vi.useFakeTimers();
    const remote = claim({
      input: {
        mode: 'video',
        config: { videoSeconds: 30, aspectRatio: '16:9' },
        referenceImages: [{ storageKey: 'resource:image-a' }],
      },
      resources: [{ id: 'image-a', name: 'a.png', kind: 'image', mimeType: 'image/png', size: 7 }],
    });
    const artifactDir = mkdtempSync(join(tmpdir(), 'lalor-artifact-'));
    const artifactPath = join(artifactDir, 'result.mp4');
    writeFileSync(artifactPath, Buffer.from('video-bytes'));
    const fixture = bridgeFixture({ remote, artifactPath });
    fixture.bridge.start();
    await flushImmediateBridgeWork();
    const task = fixture.task();
    if (!task) throw new Error('local task missing');
    const tempDir = fixture.task()?.attachments?.[0];
    if (!tempDir) throw new Error('reference image missing');
    const referenceDir = dirname(tempDir);
    task.status = 'done';
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fixture.bindingStore.value).toHaveLength(0);
    expect(existsSync(referenceDir)).toBe(false);
    fixture.bridge.stop();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('downloads reference images with the bearer and lease headers before queueing', async () => {
    vi.useFakeTimers();
    const remote = claim({
      input: {
        mode: 'video',
        config: { videoSeconds: 30, aspectRatio: '16:9' },
        referenceImages: [{ storageKey: 'resource:image-b' }, { storageKey: 'resource:image-a' }],
      },
      resources: [
        { id: 'image-a', name: 'a.png', kind: 'image', mimeType: 'image/png', size: 7 },
        { id: 'image-b', name: 'b.png', kind: 'image', mimeType: 'image/png', size: 7 },
      ],
    });
    const fixture = bridgeFixture({ remote });
    fixture.bridge.start();
    await flushImmediateBridgeWork();

    expect(fixture.notifyTaskAvailable).toHaveBeenCalledWith('local-1');
    const attachments = fixture.task()?.attachments || [];
    expect(attachments.map((filePath) => readFileSync(filePath, 'utf8'))).toEqual(['image-b', 'image-a']);
    const downloads = fixture.requests.filter((item) => /\/inputs\//.test(item.url));
    expect(downloads).toHaveLength(2);
    expect(new Headers(downloads[0].init?.headers).get('Authorization')).toBe('Bearer access-secret');
    expect(new Headers(downloads[0].init?.headers).get('X-Lalor-Task-Lease')).toBe('lease-secret');
    const referenceDir = dirname(attachments[0]);
    fixture.bridge.stop();
    expect(existsSync(referenceDir)).toBe(true);
    rmSync(referenceDir, { recursive: true, force: true });
  });

  it('downloads and maps image/video/audio inputs into separate local task fields', async () => {
    vi.useFakeTimers();
    const remote = claim({
      input: {
        mode: 'video',
        config: { videoSeconds: 30, aspectRatio: '16:9' },
        referenceImages: [{ storageKey: 'resource:image-1' }],
        referenceVideos: [{ storageKey: 'resource:video-1' }],
        referenceAudios: [{ storageKey: 'resource:audio-1' }],
      },
      resources: [
        { id: 'image-1', name: 'image.png', kind: 'image', mimeType: 'image/png', size: 7 },
        { id: 'video-1', name: 'video.mp4', kind: 'video', mimeType: 'video/mp4', size: 7 },
        { id: 'audio-1', name: 'audio.mp3', kind: 'audio', mimeType: 'audio/mpeg', size: 7 },
      ],
    });
    const fixture = bridgeFixture({ remote });
    fixture.bridge.start();
    await flushImmediateBridgeWork();

    expect(fixture.task()?.attachments?.map((filePath) => readFileSync(filePath, 'utf8'))).toEqual(['image-1']);
    expect(fixture.task()?.referenceVideos?.map((filePath) => readFileSync(filePath, 'utf8'))).toEqual(['video-1']);
    expect(fixture.task()?.audioAttachments?.map((filePath) => readFileSync(filePath, 'utf8'))).toEqual(['audio-1']);
    expect(fixture.task()?.audioAttachment).toBe(fixture.task()?.audioAttachments?.[0]);
    const referenceDir = dirname(fixture.task()?.attachments?.[0] || '');
    fixture.bridge.stop();
    rmSync(referenceDir, { recursive: true, force: true });
  });

  it('fails remotely without creating a task when this user has no matching local account', async () => {
    vi.useFakeTimers();
    const fixture = bridgeFixture({ accounts: [account('doubao-only', 'doubao')] });
    fixture.bridge.start();
    await flushImmediateBridgeWork();

    expect(fixture.deps.createTask).not.toHaveBeenCalled();
    const failure = fixture.requests.find((item) => item.url.endsWith('/fail'));
    expect(failure).toBeTruthy();
    const payload = JSON.parse(String(failure?.init?.body));
    expect(payload.leaseToken).toBe('lease-secret');
    expect(payload.message).toBe('本机没有可用于该任务的 Dola 账号：请先导入并登录 Dola 账号');
    expect(payload.providerAccepted).toBe(false);
    expect(payload.accountConsumed).toBe(false);
    expect(fixture.notifyTaskAvailable).not.toHaveBeenCalled();
    fixture.bridge.stop();
  });

  it('explains when Dola accounts exist but none are currently usable', async () => {
    vi.useFakeTimers();
    const unavailable = { ...account('dola-1', 'dola'), status: 'busy' as const };
    const fixture = bridgeFixture({ accounts: [unavailable] });
    fixture.bridge.start();
    await flushImmediateBridgeWork();

    const failure = fixture.requests.find((item) => item.url.endsWith('/fail'));
    const payload = JSON.parse(String(failure?.init?.body));
    expect(payload.message).toContain('现有账号均不可用');
    expect(payload.message).toContain('正在执行其他任务');
    fixture.bridge.stop();
  });

  it('retries a transient failure report and waits for a terminal remote acknowledgement', async () => {
    vi.useFakeTimers();
    const fixture = bridgeFixture({
      accounts: [account('doubao-only', 'doubao')],
      failTransientAttempts: 2,
    });
    fixture.bridge.start();
    await flushImmediateBridgeWork();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fixture.requests.filter((item) => item.url.endsWith('/fail'))).toHaveLength(3);
    expect(fixture.notifyTaskAvailable).not.toHaveBeenCalled();
    fixture.bridge.stop();
  });

  it('honors cancellation during the first lease and never starts the cancelled local task', async () => {
    vi.useFakeTimers();
    const fixture = bridgeFixture({ leaseCancelled: true });
    fixture.bridge.start();
    await flushImmediateBridgeWork();

    expect(fixture.cancelTask).toHaveBeenCalledWith('local-1', 'Lalor 用户已取消任务');
    expect(fixture.notifyTaskCancelled).toHaveBeenCalledWith('local-1');
    expect(fixture.notifyTaskAvailable).not.toHaveBeenCalled();
    fixture.bridge.stop();
  });

  it('does not complete an image/video task when no real local artifact exists', async () => {
    vi.useFakeTimers();
    const fixture = bridgeFixture();
    fixture.bridge.start();
    await flushImmediateBridgeWork();
    const task = fixture.task();
    if (!task) throw new Error('local task missing');
    task.status = 'done';
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fixture.requests.some((item) => item.url.endsWith('/artifacts'))).toBe(false);
    expect(fixture.requests.some((item) => item.url.endsWith('/complete'))).toBe(false);
    expect(fixture.requests.some((item) => item.url.endsWith('/fail'))).toBe(true);
    fixture.bridge.stop();
  });

  it('keeps an artifact-archive failure lease open for manual recovery', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'lalor-recovery-'));
    const artifactPath = join(directory, 'result.mp4');
    writeFileSync(artifactPath, Buffer.from('video-bytes'));
    try {
      const fixture = bridgeFixture({ artifactPath });
      fixture.bridge.start();
      await flushImmediateBridgeWork();
      const task = fixture.task();
      if (!task) throw new Error('local task missing');
      task.status = 'paused';
      task.errorInfo = {
        code: 'artifact_download_failed',
        message: '视频已生成，但本地无水印素材归档失败',
        recoverable: true,
        detectedAt: new Date().toISOString(),
      };

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 5_000);
      expect(fixture.requests.some((item) => item.url.endsWith('/fail'))).toBe(false);

      task.status = 'done';
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fixture.requests.some((item) => item.url.endsWith('/artifacts'))).toBe(true);
      expect(fixture.requests.some((item) => item.url.endsWith('/complete'))).toBe(true);
      expect(fixture.requests.some((item) => item.url.endsWith('/fail'))).toBe(false);
      fixture.bridge.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uploads an existing local artifact before completing the remote task', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'lalor-artifact-'));
    const artifactPath = join(directory, 'result.mp4');
    writeFileSync(artifactPath, Buffer.from('video-bytes'));
    try {
      const fixture = bridgeFixture({ artifactPath });
      fixture.bridge.start();
      await flushImmediateBridgeWork();
      const task = fixture.task();
      if (!task) throw new Error('local task missing');
      task.status = 'done';
      await vi.advanceTimersByTimeAsync(5_000);

      const uploadIndex = fixture.requests.findIndex((item) => item.url.endsWith('/artifacts'));
      const completeIndex = fixture.requests.findIndex((item) => item.url.endsWith('/complete'));
      expect(uploadIndex).toBeGreaterThanOrEqual(0);
      expect(completeIndex).toBeGreaterThan(uploadIndex);
      expect(fixture.requests.some((item) => item.url.endsWith('/fail'))).toBe(false);
      fixture.bridge.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
