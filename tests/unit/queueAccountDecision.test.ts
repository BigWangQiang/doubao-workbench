import { describe, expect, it } from 'vitest';
import { getAssignedAccountBlockReason } from '../../src/utils/queueAccountDecision';
import type { Account, Task } from '../../src/types';

const NOW = new Date('2026-08-24T00:00:00.000Z').getTime();
const account: Account = {
  id: 'a1', name: 'a1', avatar: '', partition: 'a1', status: 'idle', pinned: false,
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
};
const task: Task = {
  id: 't1', prompt: 'x', assignedAccountId: 'a1', status: 'queued', mode: 'chat', result: null, outputs: [],
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
};

describe('已指派任务的账号门禁', () => {
  it('连续失败冷却时返回等待原因，由队列保留原指派而不是寻找替代账号', () => {
    const reason = getAssignedAccountBlockReason({
      ...account,
      health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 3, successCount: 0, failureCount: 3, cooldownUntil: new Date(NOW + 30 * 60_000).toISOString() },
    }, task, NOW);
    expect(reason).toBe('指派账号处于自动冷却期');
    expect(task.assignedAccountId).toBe('a1');
  });

  it('视频任务按账号自定义消耗执行额度门禁', () => {
    const videoTask: Task = {
      ...task,
      mode: 'video',
      videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '16:9' },
    };
    const reason = getAssignedAccountBlockReason({
      ...account,
      seedanceQuota: {
        date: '2026-08-24', usedUnits: 8, estimatedTotalUnits: 10,
        costPerVideoUnits: 3, exhausted: false, updatedAt: new Date(NOW).toISOString(),
      },
    }, videoTask, NOW);
    expect(reason).toContain('需 3');
    expect(reason).toContain('剩余 2');
  });
});
