import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationEngine } from '../../src/automation/AutomationEngine';
import { taskStageTimeoutMs, WATCHDOG_POLICY } from '../../src/utils/taskWatchdog';

const acquireLock = vi.fn();
const renewLock = vi.fn();
const releaseLock = vi.fn();

describe('AutomationEngine 租约心跳', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    acquireLock.mockReset().mockResolvedValue({ success: true });
    renewLock.mockReset().mockResolvedValue({ success: true });
    releaseLock.mockReset().mockResolvedValue({ success: true });
    vi.stubGlobal('window', {
      electronAPI: { tasks: { acquireLock, renewLock, releaseLock } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('持锁期间每 30 秒续租，释放后停止心跳并携带 owner', async () => {
    const engine = new AutomationEngine();
    await engine.reserve('task-1', 'account-1', 'owner-1');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewLock).toHaveBeenCalledWith('task-1', 'owner-1');

    await engine.release('task-1');
    expect(releaseLock).toHaveBeenCalledWith('task-1', 'owner-1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renewLock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['返回失败', () => renewLock.mockResolvedValueOnce({ success: false, error: 'lost' })],
    ['IPC 抛错', () => renewLock.mockRejectedValueOnce(new Error('offline'))],
  ])('单次%s后续租恢复，不中止控制器', async (_label, arrange) => {
    const engine = new AutomationEngine();
    await engine.reserve('task-2', 'account-2', 'owner-2');
    const controller = engine.createController('task-2', 'account-2');
    const abortSpy = vi.spyOn(controller, 'abort');
    arrange();

    await vi.advanceTimersByTimeAsync(31_000);

    expect(abortSpy).not.toHaveBeenCalled();
    expect(engine.isReserved('task-2')).toBe(true);
  });

  it('连续三次续租失败后携带 lease_lost 原因中止并显式释放锁', async () => {
    const engine = new AutomationEngine();
    await engine.reserve('task-3', 'account-3', 'owner-3');
    const controller = engine.createController('task-3', 'account-3');
    const abortSpy = vi.spyOn(controller, 'abort');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renewLock.mockResolvedValue({ success: false, error: 'lost' });

    await vi.advanceTimersByTimeAsync(32_000);

    expect(abortSpy).toHaveBeenCalledOnce();
    expect(abortSpy).toHaveBeenCalledWith(expect.objectContaining({ code: 'lease_lost' }));
    expect(engine.isReserved('task-3')).toBe(false);
    expect(releaseLock).toHaveBeenCalledWith('task-3', 'owner-3');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('任务租约续租失败'));
    consoleSpy.mockRestore();
  });

  it('控制器创建前收到暂停时会保留原因并立即中止新控制器', async () => {
    const engine = new AutomationEngine();
    await engine.reserve('task-4', 'account-4', 'owner-4');

    expect(engine.abort('task-4', { code: 'user_pause', message: '用户暂停' })).toBe(true);
    const controller = engine.createController('task-4', 'account-4');

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toEqual({ code: 'user_pause', message: '用户暂停' });
  });

  it('任务锁获取超时后清理本地占用，并释放迟到取得的远端锁', async () => {
    let finishAcquire: ((result: { success: true }) => void) | undefined;
    acquireLock.mockImplementationOnce(() => new Promise((resolve) => {
      finishAcquire = resolve;
    }));
    const engine = new AutomationEngine();
    const reserving = engine.reserve('task-timeout', 'account-timeout', 'owner-timeout');

    await vi.advanceTimersByTimeAsync(WATCHDOG_POLICY.lockAcquireMs);
    await expect(reserving).resolves.toMatchObject({ ok: false, error: expect.stringContaining('获取超时') });
    expect(engine.isReserved('task-timeout')).toBe(false);

    finishAcquire?.({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(releaseLock).toHaveBeenCalledWith('task-timeout', 'owner-timeout');
  });

  it('阶段无心跳达到上限后中止控制器、通知状态层并释放任务锁', async () => {
    const onWatchdogTimeout = vi.fn().mockResolvedValue(undefined);
    const engine = new AutomationEngine();
    await engine.reserve('task-watchdog', 'account-watchdog', 'owner-watchdog', {
      mode: 'chat',
      onWatchdogTimeout,
    });
    const controller = engine.createController('task-watchdog', 'account-watchdog');

    await vi.advanceTimersByTimeAsync(taskStageTimeoutMs('preparing_account', 'chat'));

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toMatchObject({ code: 'task_watchdog_timeout' });
    expect(onWatchdogTimeout).toHaveBeenCalledWith(expect.objectContaining({ stage: 'preparing_account' }));
    expect(engine.isReserved('task-watchdog')).toBe(false);
    expect(releaseLock).toHaveBeenCalledWith('task-watchdog', 'owner-watchdog');
  });
});
