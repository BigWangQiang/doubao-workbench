import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
  task: { id: 'pool-task', mode: 'video', status: 'pending', createdAt: '2026-11-01T00:00:00Z' },
  create: vi.fn(),
  authorize: vi.fn(async (): Promise<void> => {}),
}));
vi.mock('../../main/ipc/yuyanAuth', () => ({ requireYuyanGenerationAccess: state.authorize }));
vi.mock('../../main/ipc/tasks', (): unknown => ({
  createTasksForLocalPlugin: state.create,
  getTaskForLalor: (): unknown => state.task,
  cancelTaskForLalor: vi.fn(), listTaskArtifactFilesForLalor: vi.fn(),
}));
vi.mock('../../main/services/workbenchCanvasStorage', (): unknown => ({
  canvasRead: async (key: string): Promise<unknown> => state.storage.get(key),
  canvasWrite: async (key: string, value: unknown): Promise<void> => { state.storage.set(key, value); },
  getCanvasResource: vi.fn(), registerCanvasFile: vi.fn(),
}));
import { createCanvasPoolTask } from '../../main/services/workbenchCanvasTasks';

function request(model: string, videoSeconds: string | number, channelId = 'desktop-doubao'): Record<string, unknown> {
  return { prompt: '测试分镜', projectId: 'canvas', type: 'video', input: { mode: 'video', config: { channelId, model, videoSeconds, size: '16:9' } } };
}

describe('本地画布视频时长提交', (): void => {
  beforeEach((): void => {
    state.storage.clear(); state.create.mockReset(); state.authorize.mockReset();
    state.authorize.mockResolvedValue(undefined);
    state.create.mockReturnValue([state.task]);
  });

  it.each(['seedance-2.0', 'seedance-2.0-fast'])('将 %s 的 15 秒原样交给豆包任务队列并持久保存', async (model: string): Promise<void> => {
    const result = await createCanvasPoolTask(request(model, '15'));
    expect(result).toMatchObject({ id: 'pool-task', status: 'queued' });
    expect(state.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      targetPlatform: 'doubao', videoConfig: { model, duration: '15s', aspectRatio: '16:9' },
    }));
    const saved = state.storage.get('task:pool-task') as { inputJson: string };
    expect(JSON.parse(saved.inputJson)).toMatchObject({ config: { model, videoSeconds: '15' } });
  });

  it.each([
    ['seedance-2.0', 5, 'desktop-doubao'], ['seedance-2.0-fast', 10, 'desktop-doubao'],
    ['seedance-2.5', 30, 'desktop-dola'],
  ])('保留原有 %s / %s / %s 提交', async (model: string, seconds: number, channel: string): Promise<void> => {
    await createCanvasPoolTask(request(model, seconds, channel));
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ videoConfig: { model, duration: `${seconds}s`, aspectRatio: '16:9' } }));
  });

  it.each([
    ['seedance-2.0-mini', 15, 'desktop-doubao'], ['seedance-2.5', 15, 'desktop-doubao'],
    ['seedance-2.0', 15, 'desktop-dola'], ['seedance-2.0-fast', 15, 'desktop-dola'],
    ['seedance-2.0', 16, 'desktop-doubao'], ['seedance-2.0-fast', 14.5, 'desktop-doubao'],
  ])('不额外放宽 %s / %s / %s', async (model: string, seconds: number, channel: string): Promise<void> => {
    await expect(createCanvasPoolTask(request(model, seconds, channel))).rejects.toThrow('不支持所选视频参数');
    expect(state.create).not.toHaveBeenCalled();
    expect(state.storage.size).toBe(0);
  });

  it('15 秒任务仍经过会员鉴权，失败时不创建任务', async (): Promise<void> => {
    state.authorize.mockRejectedValue(new Error('会员已过期'));
    await expect(createCanvasPoolTask(request('seedance-2.0', '15'))).rejects.toThrow('会员已过期');
    expect(state.create).not.toHaveBeenCalled();
  });
});
