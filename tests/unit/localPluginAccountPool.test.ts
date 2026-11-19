import { describe, expect, it } from 'vitest';
import type { Account, Task, TaskAddParams } from '@doubao-studio/contracts';
import { selectAccountFromLocalPluginPool } from '../../main/utils/localPluginAccountPool';

const now = Date.parse('2026-10-09T05:00:00.000Z');

function account(id: string, platform: 'doubao' | 'dola' = 'dola'): Account {
  return {
    id,
    name: id,
    platform,
    partition: id,
    status: 'idle',
    pinned: false,
    createdAt: `2026-10-09T00:00:0${id.endsWith('2') ? '2' : '1'}.000Z`,
    updatedAt: '2026-10-09T00:00:00.000Z',
    health: {
      loginState: 'ok',
      verificationRequired: false,
      consecutiveFailures: 0,
      successCount: 0,
      failureCount: 0,
      availability: {
        state: 'ready', reason: 'ready', message: '可用',
        checkedAt: '2026-10-09T00:00:00.000Z', source: 'manual',
      },
    },
  };
}

function task(id: string, assignedAccountId: string, status: Task['status'] = 'queued'): Task {
  return {
    id,
    projectId: 'project-1',
    prompt: id,
    assignedAccountId,
    status,
    mode: 'image',
    targetPlatform: 'dola',
    result: null,
    outputs: [],
    artifacts: [],
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
  };
}

const params: TaskAddParams = {
  prompts: ['测试'],
  mode: 'image',
  targetPlatform: 'dola',
};

describe('本机插件账号池自动调度', () => {
  it('多个独立请求优先选择排队负载更低的账号', () => {
    const accounts = [account('dola-1'), account('dola-2')];
    const first = selectAccountFromLocalPluginPool(accounts, [], params, now);
    expect(first).not.toBeNull();
    const second = selectAccountFromLocalPluginPool(accounts, [task('task-1', first!.id)], params, now);
    expect(second?.id).not.toBe(first?.id);
  });

  it('只在请求的渠道池内选择账号', () => {
    const selected = selectAccountFromLocalPluginPool(
      [account('doubao-1', 'doubao'), account('dola-1', 'dola')],
      [],
      params,
      now,
    );
    expect(selected?.platform).toBe('dola');
  });

  it('登录过期或需要验证的账号不会进入候选池', () => {
    const expired = account('dola-1');
    expired.health!.loginState = 'expired';
    const verification = account('dola-2');
    verification.health!.verificationRequired = true;
    expect(selectAccountFromLocalPluginPool([expired, verification], [], params, now)).toBeNull();
  });
});
