import { describe, expect, it, vi } from 'vitest';
import type { Account, Task } from '../../src/types';
import { accountDeletionBlocker, orderBatchDeletion, runBatchDeletion, taskDeletionBlocker } from '../../src/utils/batchDeletion';
import { TaskService } from '../../main/core/TaskService';

function task(id: string, status: Task['status'] = 'done', dependsOnTaskIds: string[] = []): Task {
  return { id, prompt: id, status, mode: 'image', assignedAccountId: 'account', result: null, outputs: [], createdAt: 'old', updatedAt: 'old', dependsOnTaskIds };
}

describe('批量删除的范围与保护', (): void => {
  it('禁止运行中、未知状态及仍持有执行锁的任务', (): void => {
    for (const status of ['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'] as const) {
      expect(taskDeletionBlocker(task('one', status))).toBeTruthy();
    }
    expect(taskDeletionBlocker(task('one'), ['one'])).toBeTruthy();
    expect(taskDeletionBlocker({ ...task('one'), lock: { ownerId: 'runner', acquiredAt: 'now', expiresAt: new Date(Date.now() + 60000).toISOString() } })).toBeTruthy();
    for (const status of ['queued', 'paused', 'done', 'fail', 'cancelled'] as const) expect(taskDeletionBlocker(task('one', status))).toBeUndefined();
    expect(taskDeletionBlocker(undefined)).toBeTruthy();
  });

  it('禁止删除被排队或活动任务占用的账号，其他账号不受影响', (): void => {
    const account = { id: 'account', status: 'idle' } as Account;
    expect(accountDeletionBlocker(account, [task('one', 'queued')])).toBeTruthy();
    expect(accountDeletionBlocker(account, [task('one', 'generating')])).toBeTruthy();
    expect(accountDeletionBlocker(account, [task('one', 'done')])).toBeUndefined();
    expect(accountDeletionBlocker(account, [], true)).toBeTruthy();
    expect(accountDeletionBlocker(account, [{ ...task('one', 'queued'), assignedAccountId: 'other' }])).toBeUndefined();
  });

  it('同批删除依赖链时先删后置任务；不删除未选中的记录或产物文件', async (): Promise<void> => {
    let stored = [task('parent'), task('child', 'done', ['parent']), task('keep')];
    const service = new TaskService({ store: { read: () => structuredClone(stored), replace: (tasks: Task[]): boolean => { stored = structuredClone(tasks); return true; } }, defaultProjectId: () => 'default' });
    const result = await runBatchDeletion([{ id: 'parent', label: '前置任务' }, { id: 'child', label: '后置任务', dependsOnIds: ['parent'] }], async (id) => service.delete(id), (): void => undefined);
    expect(result.deletedIds).toEqual(['child', 'parent']);
    expect(result.failures).toEqual([]);
    expect(stored.map(item => item.id)).toEqual(['keep']);
  });

  it('未选中的依赖任务阻止删除，返回具体原因且不自动重试', async (): Promise<void> => {
    let stored = [task('parent'), task('child', 'done', ['parent'])];
    const service = new TaskService({ store: { read: () => structuredClone(stored), replace: (tasks: Task[]): boolean => { stored = structuredClone(tasks); return true; } }, defaultProjectId: () => 'default' });
    const remove = vi.fn(async (id: string) => service.delete(id));
    const result = await runBatchDeletion([{ id: 'parent', label: '父任务' }], remove, (): void => undefined);
    expect(result.deletedIds).toEqual([]);
    expect(result.failures[0].error).toContain('依赖');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(stored).toHaveLength(2);
  });

  it('串行执行并返回真实部分结果，异常不会吞掉后续项目', async (): Promise<void> => {
    let concurrent = 0;
    const remove = vi.fn(async (id: string): Promise<{ success: boolean }> => {
      concurrent++;
      expect(concurrent).toBe(1);
      await Promise.resolve();
      concurrent--;
      if (id === 'bad') throw new Error('磁盘写入失败');
      return { success: true };
    });
    const progress = vi.fn();
    const result = await runBatchDeletion([{ id: 'ok', label: '成功项' }, { id: 'bad', label: '失败项' }, { id: 'last', label: '最后一项' }, { id: 'protected', label: '保护项', blockedReason: '已开始运行' }], remove, progress);
    expect(result.deletedIds).toEqual(['ok', 'last']);
    expect(result.failures.map(item => item.id)).toEqual(['bad', 'protected']);
    expect(remove.mock.calls.map(call => call[0])).toEqual(['ok', 'bad', 'last']);
    expect(progress.mock.calls.map(call => call[0])).toEqual([1, 2, 3, 4]);
  });

  it('循环依赖交给主进程拒绝，重复 ID 不重复删除', (): void => {
    const ordered = orderBatchDeletion([{ id: 'a', label: 'a', dependsOnIds: ['b'] }, { id: 'b', label: 'b', dependsOnIds: ['a'] }, { id: 'a', label: 'a', dependsOnIds: ['b'] }]);
    expect(ordered.map(item => item.id)).toEqual(['a', 'b']);
  });

  it('确认后新取得执行锁时由主进程拒绝删除；无效锁不默认放行', (): void => {
    for (const expiresAt of [new Date(Date.now() + 60000).toISOString(), 'invalid-date']) {
      const stored = [{ ...task('locked', 'queued'), lock: { ownerId: 'runner', acquiredAt: 'now', expiresAt } }];
      const replace = vi.fn((): boolean => true);
      const service = new TaskService({ store: { read: () => structuredClone(stored), replace }, defaultProjectId: () => 'default' });
      expect(service.delete('locked')).toMatchObject({ success: false, error: '任务执行锁尚未释放，请稍后再删除' });
      expect(replace).not.toHaveBeenCalled();
      expect(taskDeletionBlocker(stored[0])).toBeTruthy();
    }
    const expired = { ...task('expired'), lock: { ownerId: 'runner', acquiredAt: 'old', expiresAt: '2000-01-01T00:00:00Z' } };
    const service = new TaskService({ store: { read: () => [expired], replace: (): boolean => true }, defaultProjectId: () => 'default' });
    expect(service.delete('expired').success).toBe(true);
  });
});
