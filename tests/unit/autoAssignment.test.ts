import { describe, expect, it } from 'vitest';
import { buildAutoAssignmentPlan } from '../../src/utils/autoAssignment';
import type { Account, AccountPlatform, Task } from '../../src/types';

function account(id: string, usedUnits: number, overrides: Partial<Account> = {}): Account {
  return {
    id, name: id, avatar: '', partition: id, platform: 'doubao', status: 'idle', pinned: false,
    seedanceQuota: { date: '2026-08-24', usedUnits, estimatedTotalUnits: 6, exhausted: usedUnits >= 6, updatedAt: '2026-08-24T00:00:00.000Z' },
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', ...overrides,
  };
}

function task(
  id: string,
  duration: NonNullable<Task['videoConfig']>['duration'] = '10s',
  targetPlatform: AccountPlatform = 'doubao',
): Task {
  return {
    id, prompt: id, targetPlatform, assignedAccountId: null, status: 'queued', mode: 'video',
    videoConfig: { model: 'seedance-2.0', duration, aspectRatio: '16:9' }, result: null, outputs: [],
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

describe('批量自动指派计划', () => {
  it('会预留批内额度，不把三个 10 秒任务都塞给剩余 6 单位的同一账号', () => {
    const plan = buildAutoAssignmentPlan([task('t1'), task('t2'), task('t3'), task('t4')], [], [account('a1', 0)]);
    expect(plan.assignments.map((item) => item.taskId)).toEqual(['t1', 't2', 't3']);
    expect(plan.unassignedTaskIds).toEqual(['t4']);
  });

  it('自动冷却账号不参与自动指派，但任务不会被伪装成已指派', () => {
    const plan = buildAutoAssignmentPlan([task('t1', '5s')], [], [account('a1', 0, {
      health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 3, successCount: 0, failureCount: 3, cooldownUntil: '2099-01-01T00:00:00.000Z' },
    })], new Date('2026-08-24T00:00:00.000Z').getTime());
    expect(plan.assignments).toEqual([]);
    expect(plan.unassignedTaskIds).toEqual(['t1']);
  });

  it('Dola 任务只会自动指派给 Dola 账号', () => {
    const plan = buildAutoAssignmentPlan(
      [task('dola-task', '5s', 'dola')],
      [],
      [account('doubao-1', 0), account('dola-1', 0, { platform: 'dola' })],
    );
    expect(plan.assignments).toEqual([{ taskId: 'dola-task', accountId: 'dola-1' }]);
  });

  it('批内预留使用账号自定义的单次视频消耗', () => {
    const configured = account('a1', 0, {
      seedanceQuota: {
        date: '2026-08-24', usedUnits: 0, estimatedTotalUnits: 10,
        costPerVideoUnits: 3, exhausted: false, updatedAt: '2026-08-24T00:00:00.000Z',
      },
    });
    const plan = buildAutoAssignmentPlan(
      [task('t1', '30s'), task('t2', '30s'), task('t3', '30s'), task('t4', '30s')],
      [],
      [configured],
    );
    expect(plan.assignments.map((item) => item.taskId)).toEqual(['t1', 't2', 't3']);
    expect(plan.unassignedTaskIds).toEqual(['t4']);
  });
});
