import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../src/types';
import { useTaskStore } from '../../src/store/useTaskStore';

function makeTask(mode: Task['mode']): Task {
  return {
    id: `${mode}-task`,
    prompt: 'test prompt',
    assignedAccountId: 'account-1',
    status: 'generating',
    mode,
    result: null,
    outputs: [],
    artifacts: [],
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  };
}

function installElectronApi(
  task: Task,
  updateStatus: ReturnType<typeof vi.fn>,
  downloadDir = '',
): {
  downloadOutputs: ReturnType<typeof vi.fn>;
  registerArtifact: ReturnType<typeof vi.fn>;
} {
  const downloadOutputs = vi.fn(async () => ({ success: true, count: 1, failed: 0 }));
  const registerArtifact = vi.fn(async () => ({ success: true }));
  vi.stubGlobal('window', {
    electronAPI: {
      settings: { get: vi.fn(async () => ({ downloadDir })) },
      logs: { append: vi.fn(async () => undefined) },
      accounts: { setStatus: vi.fn(async () => ({ success: true })) },
      tasks: {
        updateStatus,
        updateRuntime: vi.fn(async () => ({ success: true })),
        list: vi.fn(async () => [task]),
        downloadOutputs,
        registerArtifact,
      },
    },
  });
  return { downloadOutputs, registerArtifact };
}

describe('completeAutomation 按任务模式处理产物', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('豆包对话没有媒体 URL 时仍完成，不触发视频下载或归档错误', async () => {
    const task = makeTask('chat');
    const updateStatus = vi.fn(async () => ({ success: true }));
    const { downloadOutputs, registerArtifact } = installElectronApi(task, updateStatus);
    useTaskStore.setState({
      tasks: [task],
      executingTasks: { 'account-1': task.id },
      accountBusy: { 'account-1': true },
      accountAutomationState: { 'account-1': 'generating' },
      accountAutoMessage: { 'account-1': '等待回复' },
      activeTaskId: task.id,
      automationState: 'generating',
    });

    await useTaskStore.getState().completeAutomation(task.id, 'account-1', '助手：你好，我可以帮你处理。', []);

    expect(updateStatus).toHaveBeenCalledWith(task.id, 'done', '助手：你好，我可以帮你处理。', []);
    expect(downloadOutputs).not.toHaveBeenCalled();
    expect(registerArtifact).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[0]).toMatchObject({
      status: 'done',
      outputs: [],
      result: '助手：你好，我可以帮你处理。',
    });
  });

  it('视频没有媒体 URL 时仍 fail-closed，不能被对话放宽规则吞掉', async () => {
    const task = makeTask('video');
    const updateStatus = vi.fn(async () => ({ success: true }));
    const { downloadOutputs } = installElectronApi(task, updateStatus);
    useTaskStore.setState({ tasks: [task] });

    await expect(useTaskStore.getState().completeAutomation(task.id, 'account-1', '', [])).rejects.toThrow(
      '视频已生成，但没有可保存的产物地址',
    );
    expect(downloadOutputs).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('图片生成会读取设置中的目录并自动保存后完成任务', async () => {
    const task = makeTask('image');
    const updateStatus = vi.fn(async () => ({ success: true }));
    const { downloadOutputs } = installElectronApi(task, updateStatus, 'D:\\ai漫剧');
    useTaskStore.setState({ tasks: [task] });

    await useTaskStore.getState().completeAutomation(
      task.id,
      'account-1',
      'https://cdn.example.test/image.png',
      ['https://cdn.example.test/image.png'],
    );

    expect(downloadOutputs).toHaveBeenCalledWith([
      expect.objectContaining({
        taskId: task.id,
        mode: 'image',
        outputs: ['https://cdn.example.test/image.png'],
      }),
    ], 'D:\\ai漫剧');
    expect(updateStatus).toHaveBeenCalledWith(
      task.id,
      'done',
      'https://cdn.example.test/image.png',
      ['https://cdn.example.test/image.png'],
    );
    expect(useTaskStore.getState().tasks[0]).toMatchObject({ status: 'done', mode: 'image' });
  });
});
