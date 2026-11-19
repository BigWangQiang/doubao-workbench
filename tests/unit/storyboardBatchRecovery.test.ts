import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryboardBatch } from '@doubao-studio/contracts';

const harness = vi.hoisted(() => ({
  batch: undefined as StoryboardBatch | undefined,
  command: vi.fn<(batch: StoryboardBatch, method: string, input?: unknown) => Promise<unknown>>(),
  saved: vi.fn(),
}));
vi.mock('../../main/services/storyboardBatchStore', (): unknown => ({
  StoryboardBatchStore: class {
    list(): StoryboardBatch[] { return harness.batch ? [harness.batch] : []; }
    get(): StoryboardBatch { return harness.batch!; }
    save(): void { harness.saved(); }
  },
  resolveStoryboardPrompt: (prompt: string): string => prompt,
}));
vi.mock('../../main/services/storyboardBrowser', (): unknown => ({
  StoryboardCommandNotStartedError: class extends Error {},
  StoryboardBrowser: class {
    command = harness.command;
    async ensureCanvas(): Promise<unknown> { return { canvasId: 'canvas', url: '' }; }
  },
}));
vi.mock('../../main/ipc/yuyanAuth', () => ({ requireYuyanGenerationAccess: async (): Promise<void> => {} }));
vi.mock('../../main/ipc/tasks', (): unknown => ({
  getTaskForLalor: (id: string): unknown => ({ id }),
  taskService: {
    acquireLock: (): unknown => ({ success: true }),
    releaseLock: (): unknown => ({ success: true }),
    updateStatus: (): unknown => ({ success: true }),
  },
}));
import { StoryboardBatchService } from '../../main/services/storyboardBatchService';
import { StoryboardCommandNotStartedError } from '../../main/services/storyboardBrowser';

function batch(): StoryboardBatch {
  return {
    id: 'batch', accountId: 'account', projectId: 'project', title: 'test', phase: 'ready', message: '',
    canvasId: 'canvas', model: 'seedance-2.5', ratio: '16:9', concurrency: 2, referenceNames: {},
    createdAt: '', updatedAt: '',
    rows: [{ id: 'row', taskId: 'task', number: '001', nodeId: 'node', prompt: 'test', duration: 5, images: [], referenceKeys: [], state: 'ready' }],
  };
}

describe('分镜待核对恢复', (): void => {
  beforeEach((): void => {
    harness.batch = batch(); harness.saved.mockReset(); harness.command.mockReset();
    harness.command.mockImplementation(async (_batch, method): Promise<unknown> => method === 'receipts' ? [] : {});
  });
  it.each(['页面校验拒绝', '窗口未前台'])('%s 不留下永久发送意图', async (kind): Promise<void> => {
    harness.command.mockImplementation(async (_batch, method): Promise<unknown> => {
      if (method === 'submit') {
        if (kind === '窗口未前台') throw new StoryboardCommandNotStartedError('窗口未前台');
        return { clicked: false, message: '复核失效' };
      }
      return {};
    });
    await expect(new StoryboardBatchService().start('batch')).rejects.toThrow('未点击发送');
    expect(harness.batch!.rows[0].submissionIntentAt).toBeUndefined();
    expect(harness.batch!.rows[0].state).toBe('pending');
    expect(harness.command.mock.calls.some(call => call[1] === 'receipts')).toBe(false);
  });
  it('执行中断保留意图和原始错误，不允许重试发送', async (): Promise<void> => {
    harness.command.mockImplementation(async (_batch, method): Promise<unknown> => {
      if (method === 'submit') throw new Error('连接中断');
      return method === 'receipts' ? [] : {};
    });
    const service = new StoryboardBatchService();
    await expect(service.start('batch')).rejects.toThrow('连接中断');
    expect(harness.batch!.rows[0]).toMatchObject({ state: 'review', submissionIntentAt: expect.any(String), submissionError: '连接中断' });
    expect(service.list()[0].busy).toBe(false);
  });
  it('待核对分镜不重发，其他已就绪分镜可以发送', async (): Promise<void> => {
    const first = harness.batch!.rows[0]; first.state = 'review'; first.submissionIntentAt = 'previous';
    harness.batch!.rows.push({ ...first, id: 'other', nodeId: 'other-node', taskId: 'other-task', number: '002', state: 'ready', submissionIntentAt: undefined });
    harness.command.mockImplementation(async (_batch, method): Promise<unknown> => {
      if (method === 'submit') return { clicked: true };
      if (method === 'receipts') return [{ nodeId: 'other-node', accepted: true }];
      if (method === 'observe') return { state: 'failed', message: 'fixture terminal' };
      return {};
    });
    await new StoryboardBatchService().start('batch');
    const submits = harness.command.mock.calls.filter(call => call[1] === 'submit');
    expect(submits).toHaveLength(1); expect(submits[0][2]).toMatchObject({ nodeId: 'other-node' });
    expect(first.submissionIntentAt).toBe('previous'); expect(first.state).toBe('review');
  });
  it('首次未全部准备时仍然拒绝发送', async (): Promise<void> => {
    harness.batch!.rows.push({ ...harness.batch!.rows[0], id: 'pending', state: 'pending' });
    await expect(new StoryboardBatchService().start('batch')).rejects.toThrow('尚未全部就绪');
    expect(harness.command).not.toHaveBeenCalled();
  });
  it('恢复必须人工确认；已受理分镜不能恢复', async (): Promise<void> => {
    const row = harness.batch!.rows[0]; row.state = 'review'; row.submissionIntentAt = 'previous';
    const service = new StoryboardBatchService();
    await expect(service.restoreUnsent('batch', row.id, false)).rejects.toThrow('请先');
    row.submittedAt = 'accepted';
    await expect(service.restoreUnsent('batch', row.id, true)).rejects.toThrow('已受理任务只能查询');
    expect(row.submissionIntentAt).toBe('previous'); expect(harness.command).not.toHaveBeenCalled();
  });
  it('人工核对并确认原节点无发送记录后只恢复待准备，不发送', async (): Promise<void> => {
    const row = harness.batch!.rows[0]; row.state = 'review'; row.submissionIntentAt = 'previous';
    harness.command.mockResolvedValue({ draft: true });
    await new StoryboardBatchService().restoreUnsent('batch', row.id, true);
    expect(row.state).toBe('pending'); expect(row.submissionIntentAt).toBeUndefined();
    expect(row.submissionRecovery).toMatchObject({ previousIntentAt: 'previous' });
    expect(harness.command.mock.calls.map(call => call[1])).toEqual(['confirmUnsentDraft']);
  });
});
