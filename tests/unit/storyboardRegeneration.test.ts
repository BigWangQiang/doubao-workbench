import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryboardBatch, StoryboardRow } from '@doubao-studio/contracts';

const harness = vi.hoisted(() => ({
  batch: undefined as StoryboardBatch | undefined,
  command: vi.fn<(batch: StoryboardBatch, method: string, input?: unknown) => Promise<unknown>>(),
  saved: vi.fn(),
  access: vi.fn(async (): Promise<void> => {}),
  update: vi.fn((): unknown => ({ success: true })),
  download: vi.fn(async (): Promise<unknown> => ({ success: true, count: 1 })),
}));
vi.mock('../../main/services/storyboardBatchStore', (): unknown => ({
  StoryboardBatchStore: class {
    list(): StoryboardBatch[] { return [harness.batch!]; }
    get(): StoryboardBatch { return harness.batch!; }
    save(): void { harness.saved(); }
  },
  resolveStoryboardPrompt: (prompt: string): string => prompt,
}));
vi.mock('../../main/services/storyboardBrowser', (): unknown => ({
  StoryboardCommandNotStartedError: class extends Error {},
  StoryboardBrowser: class { command = harness.command; },
}));
vi.mock('../../main/ipc/yuyanAuth', () => ({ requireYuyanGenerationAccess: harness.access }));
vi.mock('../../main/ipc/tasks', (): unknown => ({
  getTaskForLalor: (id: string): unknown => ({ id }),
  taskService: { updateStatus: harness.update },
  downloadTaskOutputs: harness.download,
}));
import { StoryboardBatchService } from '../../main/services/storyboardBatchService';

interface Poller { pollRow: (batch: StoryboardBatch, row: StoryboardRow) => Promise<void>; stopping: Set<string> }

function fixture(): { batch: StoryboardBatch; row: StoryboardRow; poller: Poller } {
  const row: StoryboardRow = { id: 'row', taskId: 'task', nodeId: 'node', number: '001', prompt: 'fixture', duration: 5, images: [], state: 'generating', submittedAt: 'accepted' };
  const batch: StoryboardBatch = { id: 'batch', title: 'fixture', projectId: 'project', accountId: 'account', canvasId: 'canvas', rows: [row], phase: 'running', message: '', createdAt: '', updatedAt: '', model: 'seedance-2.5', ratio: '16:9', concurrency: 4, referenceNames: {} };
  harness.batch = batch;
  return { batch, row, poller: new StoryboardBatchService() as unknown as Poller };
}

describe('并发分镜失败节点重新生成', (): void => {
  beforeEach((): void => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00Z'));
    harness.command.mockReset(); harness.saved.mockClear(); harness.access.mockClear(); harness.update.mockClear(); harness.download.mockClear();
    harness.command.mockImplementation(async (_batch, method, raw): Promise<unknown> => {
      const input = raw as { attemptId?: string };
      if (method === 'regenerate') return { clicked: true };
      return { state: 'failed', retryable: true, retryReceipt: input.attemptId ? { attemptId: input.attemptId, status: 'settled' } : undefined };
    });
  });
  afterEach((): void => { vi.useRealTimers(); });

  it('同一失败节点最多点击五次，反复轮询不会产生第六次', async (): Promise<void> => {
    const { batch, row, poller } = fixture();
    for (let index = 0; index < 9; index += 1) {
      await poller.pollRow(batch, row);
      vi.setSystemTime(Date.now() + 6000);
    }
    expect(harness.command.mock.calls.filter(call => call[1] === 'regenerate')).toHaveLength(5);
    expect(row.regeneration?.attempts).toBe(5);
    expect(row.state).toBe('failed'); expect(row.message).toContain('5 次');
  });

  it('点击前已经持久化意图，间隔不足不会再点', async (): Promise<void> => {
    const { batch, row, poller } = fixture();
    harness.command.mockImplementation(async (_batch, method): Promise<unknown> => {
      if (method === 'regenerate') {
        expect(row.regeneration).toMatchObject({ attempts: 1, intentAt: expect.any(String), attemptId: expect.any(String) });
        expect(harness.saved).toHaveBeenCalled();
        return { clicked: true };
      }
      return { state: 'failed', retryable: true, retryReceipt: row.regeneration ? { attemptId: row.regeneration.attemptId, status: 'settled' } : undefined };
    });
    await poller.pollRow(batch, row); await poller.pollRow(batch, row);
    expect(harness.command.mock.calls.filter(call => call[1] === 'regenerate')).toHaveLength(1);
  });

  it.each(['waiting', 'unknown', 'blocked'])('回执 %s 时不继续点击', async (status): Promise<void> => {
    const { batch, row, poller } = fixture();
    row.regeneration = { attempts: 1, attemptId: 'retry', intentAt: 'persisted' };
    harness.command.mockResolvedValue({ state: 'failed', retryable: true, retryReceipt: { attemptId: 'retry', status } });
    await poller.pollRow(batch, row);
    expect(harness.command.mock.calls.map(call => call[1])).toEqual(['observe']);
    expect(row.state).toBe(status === 'waiting' ? 'generating' : 'review');
  });

  it('刷新后不采用旧回执，观察到短暂生成也不解除不明意图', async (): Promise<void> => {
    const { batch, row, poller } = fixture();
    row.regeneration = { attempts: 2, attemptId: 'current', intentAt: 'persisted' };
    harness.command.mockResolvedValueOnce({ state: 'generating', retryReceipt: { attemptId: 'old', status: 'settled' } });
    await poller.pollRow(batch, row);
    expect(row.regeneration.settled).toBeUndefined();
    harness.command.mockResolvedValue({ state: 'failed', retryable: true });
    await poller.pollRow(batch, row);
    expect(row.state).toBe('review');
    expect(harness.command.mock.calls.every(call => call[1] === 'observe')).toBe(true);
  });

  it('明确未点击不耗次数，点击中断保留意图', async (): Promise<void> => {
    const { batch, row, poller } = fixture();
    harness.command.mockImplementation(async (_batch, method): Promise<unknown> => method === 'regenerate' ? { clicked: false, message: '窗口不在前台' } : { state: 'failed', retryable: true });
    await poller.pollRow(batch, row);
    expect(row.regeneration).toBeUndefined(); expect(row.state).toBe('review');
    harness.command.mockImplementation(async (_batch, method): Promise<unknown> => {
      if (method === 'regenerate') throw new Error('页面中断');
      return { state: 'failed', retryable: true };
    });
    await expect(poller.pollRow(batch, row)).rejects.toThrow('页面中断');
    expect(row.regeneration?.attempts).toBe(1); expect(row.regeneration?.settled).toBeUndefined();
  });

  it('审核拒绝、未确认受理、已生成节点不点击', async (): Promise<void> => {
    const { batch, row, poller } = fixture();
    harness.command.mockResolvedValue({ state: 'failed', retryable: false, message: '审核不通过' });
    await poller.pollRow(batch, row);
    harness.command.mockResolvedValue({ state: 'failed', retryable: true }); row.submittedAt = undefined;
    await poller.pollRow(batch, row);
    harness.command.mockResolvedValue({ state: 'done', url: 'https://example.com/video.mp4' });
    await poller.pollRow(batch, row);
    expect(row.state).toBe('done'); expect(harness.download).toHaveBeenCalledTimes(1);
    expect(harness.command.mock.calls.some(call => call[1] === 'regenerate')).toBe(false);
  });

  it('多个失败节点的点击串行且绑定各自 nodeId', async (): Promise<void> => {
    const { batch, row, poller } = fixture();
    const other = { ...row, id: 'other-row', nodeId: 'other-node', taskId: 'other-task' }; batch.rows.push(other);
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered: (() => void) | undefined;
    const firstClick = new Promise<void>(resolve => { entered = resolve; });
    harness.command.mockImplementation(async (_batch, method, input): Promise<unknown> => {
      if (method === 'regenerate') {
        if ((input as { nodeId: string }).nodeId === 'node') { entered!(); await gate; }
        return { clicked: true };
      }
      return { state: 'failed', retryable: true };
    });
    const running = Promise.all([poller.pollRow(batch, row), poller.pollRow(batch, other)]);
    await firstClick;
    expect(harness.command.mock.calls.filter(call => call[1] === 'regenerate')).toHaveLength(1);
    release!(); await running;
    expect(harness.command.mock.calls.filter(call => call[1] === 'regenerate').map(call => (call[2] as { nodeId: string }).nodeId)).toEqual(['node', 'other-node']);
  });

  it('暂停后不点击，重新实例化服务也保留五次上限', async (): Promise<void> => {
    const { batch, row, poller } = fixture();
    poller.stopping.add(batch.id);
    await expect(poller.pollRow(batch, row)).rejects.toThrow('已暂停');
    row.regeneration = { attempts: 5, attemptId: 'saved', intentAt: 'persisted', settled: true };
    const restarted = new StoryboardBatchService() as unknown as Poller;
    await restarted.pollRow(batch, row);
    expect(harness.command.mock.calls.some(call => call[1] === 'regenerate')).toBe(false);
    expect(row.message).toContain('5 次');
  });
});
