import { describe, expect, it } from 'vitest';
import type { Account, LogAppendParams, Task } from '@doubao-studio/contracts';
import { enrichLogContext } from '../../main/utils/logContext';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-1',
    name: 'Dola 账号 1',
    platform: 'dola',
    avatar: '',
    partition: 'persist:dola_account-1',
    status: 'idle',
    pinned: false,
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    prompt: '当前任务提示词',
    targetPlatform: 'dola',
    assignedAccountId: 'account-1',
    status: 'executing',
    mode: 'video',
    result: null,
    outputs: [],
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
}

function makeLog(overrides: Partial<LogAppendParams> = {}): LogAppendParams {
  return {
    level: 'info',
    scope: 'automation',
    message: '任务开始执行',
    taskId: 'task-1',
    ...overrides,
  };
}

describe('enrichLogContext', () => {
  it('从运行快照和账号表补齐账号、平台、类型及完整提示词', () => {
    const prompt = '第一行提示词\n第二行提示词，保留完整内容。';
    const task = makeTask({
      prompt: '任务后来编辑后的提示词',
      runtime: {
        runId: 'run-1',
        attempt: 1,
        stage: 'preparing_account',
        message: '准备执行',
        startedAt: '2026-09-11T00:00:00.000Z',
        stageStartedAt: '2026-09-11T00:00:00.000Z',
        lastHeartbeatAt: '2026-09-11T00:00:00.000Z',
        input: { prompt, mode: 'image', attachments: [] },
      },
    });

    expect(enrichLogContext(makeLog(), [task], [makeAccount()])).toMatchObject({
      accountId: 'account-1',
      accountName: 'Dola 账号 1',
      accountPlatform: 'dola',
      mode: 'image',
      prompt,
    });
  });

  it('保留调用方已经提供的执行时快照', () => {
    const entry = makeLog({
      accountId: 'historic-account',
      accountName: '历史账号',
      accountPlatform: 'doubao',
      mode: 'chat',
      prompt: '历史完整提示词',
    });

    expect(enrichLogContext(entry, [makeTask()], [makeAccount()])).toMatchObject({
      accountId: 'historic-account',
      accountName: '历史账号',
      accountPlatform: 'doubao',
      mode: 'chat',
      prompt: '历史完整提示词',
    });
  });

  it('账号已删除时仍从任务保留账号 ID、平台、类型和提示词', () => {
    expect(enrichLogContext(makeLog(), [makeTask()], [])).toMatchObject({
      accountId: 'account-1',
      accountPlatform: 'dola',
      mode: 'video',
      prompt: '当前任务提示词',
    });
  });

  it('历史任务已删除时不根据消息伪造提示词或类型', () => {
    const result = enrichLogContext(makeLog({ accountId: undefined }), [], []);

    expect(result.prompt).toBeUndefined();
    expect(result.mode).toBeUndefined();
    expect(result.accountName).toBeUndefined();
    expect(result.accountPlatform).toBeUndefined();
  });

  it('系统事件没有任务时不添加任务上下文', () => {
    const result = enrichLogContext(makeLog({ taskId: undefined, scope: 'system' }), [makeTask()], [makeAccount()]);

    expect(result.accountId).toBeUndefined();
    expect(result.prompt).toBeUndefined();
    expect(result.mode).toBeUndefined();
  });
});
