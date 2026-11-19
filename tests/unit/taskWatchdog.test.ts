import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoundedTimeoutError,
  TaskWatchdog,
  isTaskStageStale,
  taskStageTimeoutMs,
  withTimeout,
} from '../../src/utils/taskWatchdog';
import { InitializationGate, InitializationTimeoutError } from '../../src/utils/initializationGate';

describe('task watchdog helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('withTimeout 在操作完成时清理定时器', async () => {
    vi.useFakeTimers();
    const value = await withTimeout(Promise.resolve('ok'), 1000);
    expect(value).toBe('ok');
    await vi.advanceTimersByTimeAsync(2000);
  });

  it('withTimeout 超时只拒绝当前等待并返回结构化错误', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<string>(() => undefined), 25, '检测超时');
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'timeout',
      message: '检测超时',
    });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    await expect(pending).rejects.toBeInstanceOf(BoundedTimeoutError);
  });

  it('阶段变更或心跳会重新计时，停滞后只通知一次', async () => {
    const now = 10_000;
    const onTimeout = vi.fn();
    const watchdog = new TaskWatchdog({
      initialStage: 'preparing_account',
      now: () => now,
      onTimeout,
      tickMs: 1000,
    });

    expect(watchdog.check(now + 44_999)).toBe(false);
    watchdog.heartbeat('configuring', now + 44_999);
    expect(watchdog.check(now + 44_999 + 119_999)).toBe(false);
    expect(watchdog.check(now + 44_999 + 120_000)).toBe(true);
    expect(watchdog.check(now + 44_999 + 240_000)).toBe(false);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({ stage: 'configuring', timeoutMs: 120_000 }));
  });

  it('终止阶段永不判定为停滞，非法心跳按 fail-closed 处理', () => {
    expect(taskStageTimeoutMs('completed')).toBe(Number.POSITIVE_INFINITY);
    expect(isTaskStageStale('completed', 'not-a-date', Date.now())).toBe(false);
    expect(isTaskStageStale('preparing_account', 'not-a-date', Date.now())).toBe(true);
  });

  it('初始化队列超时会移除等待者，后续任务仍可获得租约', async () => {
    vi.useFakeTimers();
    const gate = new InitializationGate();
    const first = await gate.acquire('task-a', { limit: 1, timeoutMs: 1000 });
    const secondPromise = gate.acquire('task-b', { limit: 1, timeoutMs: 25 });
    const assertion = expect(secondPromise).rejects.toBeInstanceOf(InitializationTimeoutError);

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    first.release();

    const third = await gate.acquire('task-c', { limit: 1, timeoutMs: 1000 });
    third.release();
  });
});
