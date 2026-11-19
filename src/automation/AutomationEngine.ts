import type { ElectronAPI } from '@doubao-studio/contracts';
import type { GenerationMode, TaskStage } from '../types';
import {
  BoundedTimeoutError,
  TaskWatchdog,
  WATCHDOG_POLICY,
  withTimeout,
} from '../utils/taskWatchdog';
import type { TaskWatchdogTimeout } from '../utils/taskWatchdog';

interface Reservation {
  taskId: string;
  accountId: string;
  ownerId: string;
  mode?: GenerationMode;
  lockAcquired: boolean;
  controller?: AbortController;
  heartbeat?: ReturnType<typeof setInterval>;
  watchdog?: TaskWatchdog;
  renewing?: boolean;
  pendingAbortReason?: AutomationAbortReason;
  watchdogHandling?: boolean;
  onWatchdogTimeout?: (event: TaskWatchdogTimeout) => void | Promise<void>;
}

const LEASE_HEARTBEAT_MS = 30_000;
const LEASE_RENEW_RETRIES = 3;
const LEASE_RETRY_DELAY_MS = 750;

/** 自动化中止来源。写入 AbortSignal.reason，供执行层区分用户操作和内部故障。 */
export type AutomationAbortReasonCode =
  | 'user_pause'
  | 'user_cancel'
  | 'lease_lost'
  | 'task_watchdog_timeout'
  | 'webview_disposed'
  | 'component_unmounted'
  | 'internal_abort';

export interface AutomationAbortReason {
  code: AutomationAbortReasonCode;
  message?: string;
}

const ABORT_REASON_CODES = new Set<AutomationAbortReasonCode>([
  'user_pause',
  'user_cancel',
  'lease_lost',
  'task_watchdog_timeout',
  'webview_disposed',
  'component_unmounted',
  'internal_abort',
]);

/** 读取由 AutomationEngine 写入的结构化中止来源；兼容旧的无 reason abort。 */
export function readAutomationAbortReason(signal: AbortSignal): AutomationAbortReason | undefined {
  const raw = signal.reason as Partial<AutomationAbortReason> | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.code !== 'string') return undefined;
  if (!ABORT_REASON_CODES.has(raw.code as AutomationAbortReasonCode)) return undefined;
  return {
    code: raw.code as AutomationAbortReasonCode,
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
  };
}

export interface AutomationReservationOptions {
  mode?: GenerationMode;
  onWatchdogTimeout?: (event: TaskWatchdogTimeout) => void | Promise<void>;
}

function getElectronAPI(): ElectronAPI {
  return (window as unknown as { electronAPI: ElectronAPI }).electronAPI;
}

export class AutomationEngine {
  private reservations = new Map<string, Reservation>();
  private accountTasks = new Map<string, string>();

  async reserve(
    taskId: string,
    accountId: string,
    ownerId: string,
    options: AutomationReservationOptions = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const accountTask = this.accountTasks.get(accountId);
    if (accountTask && accountTask !== taskId) return { ok: false, error: '该账号已有执行中的任务' };
    const existing = this.reservations.get(taskId);
    if (existing) return existing.ownerId === ownerId ? { ok: true } : { ok: false, error: '任务已在运行' };

    const reservation: Reservation = {
      taskId,
      accountId,
      ownerId,
      mode: options.mode,
      lockAcquired: false,
      onWatchdogTimeout: options.onWatchdogTimeout,
    };
    this.reservations.set(taskId, reservation);
    this.accountTasks.set(accountId, taskId);
    const lockPromise = Promise.resolve().then(() => getElectronAPI().tasks.acquireLock(taskId, ownerId));
    let result: Awaited<typeof lockPromise>;
    try {
      result = await withTimeout(
        lockPromise,
        WATCHDOG_POLICY.lockAcquireMs,
        '任务锁获取超时，已停止等待',
      );
    } catch (error: unknown) {
      if (error instanceof BoundedTimeoutError) {
        this.scheduleLateLockCleanup(lockPromise, taskId, ownerId);
      }
      this.forgetReservation(reservation);
      return {
        ok: false,
        error: error instanceof Error ? error.message : '任务锁定失败',
      };
    }
    if (!result.success) {
      this.forgetReservation(reservation);
      return { ok: false, error: result.error || '任务锁定失败' };
    }
    // 用户可能在 IPC 等待期间已经暂停；迟到的成功锁不能继续留在远端。
    if (this.reservations.get(taskId) !== reservation || reservation.pendingAbortReason) {
      await this.releaseRemoteLock(taskId, ownerId);
      this.forgetReservation(reservation);
      return { ok: false, error: reservation.pendingAbortReason?.message || '任务已停止，未取得执行锁' };
    }
    reservation.lockAcquired = true;
    reservation.watchdog = new TaskWatchdog({
      initialStage: 'preparing_account',
      mode: options.mode,
      onTimeout: (event) => this.handleWatchdogTimeout(reservation, event),
    });
    reservation.watchdog.start();
    reservation.heartbeat = setInterval(() => {
      void this.renew(reservation);
    }, LEASE_HEARTBEAT_MS);
    return { ok: true };
  }

  private forgetReservation(reservation: Reservation): void {
    reservation.watchdog?.stop();
    reservation.watchdog = undefined;
    if (reservation.heartbeat) {
      clearInterval(reservation.heartbeat);
      reservation.heartbeat = undefined;
    }
    if (this.reservations.get(reservation.taskId) === reservation) {
      this.reservations.delete(reservation.taskId);
    }
    if (this.accountTasks.get(reservation.accountId) === reservation.taskId) {
      this.accountTasks.delete(reservation.accountId);
    }
  }

  private async releaseRemoteLock(taskId: string, ownerId: string): Promise<void> {
    try {
      await withTimeout(
        () => getElectronAPI().tasks.releaseLock(taskId, ownerId),
        WATCHDOG_POLICY.lockAcquireMs,
        '任务锁释放超时',
      );
    } catch (error: unknown) {
      console.warn(`[AutomationEngine] 任务锁释放未在有界时间内完成: ${taskId}`, error);
    }
  }

  private scheduleLateLockCleanup(
    lockPromise: Promise<Awaited<ReturnType<ElectronAPI['tasks']['acquireLock']>>>,
    taskId: string,
    ownerId: string,
  ): void {
    void lockPromise.then((result) => {
      if (!result.success) return;
      // 新一轮相同任务若已取得自己的锁，不用旧请求覆盖它；正常 runId
      // 每次不同，因而迟到请求只会在无活动 reservation 时做清理。
      const current = this.reservations.get(taskId);
      if (current && current.ownerId === ownerId) return;
      void this.releaseRemoteLock(taskId, ownerId);
    }, () => undefined);
  }

  private async handleWatchdogTimeout(
    reservation: Reservation,
    event: TaskWatchdogTimeout,
  ): Promise<void> {
    if (reservation.watchdogHandling || this.reservations.get(reservation.taskId) !== reservation) return;
    reservation.watchdogHandling = true;
    const timeoutSeconds = Math.ceil(event.timeoutMs / 1000);
    const reason: AutomationAbortReason = {
      code: 'task_watchdog_timeout',
      message: `任务在 ${event.stage} 阶段超过 ${timeoutSeconds} 秒，已停止等待；系统未自动重发`,
    };
    reservation.pendingAbortReason = reason;
    if (reservation.controller && !reservation.controller.signal.aborted) {
      reservation.controller.abort(reason);
    }
    const lockAcquired = reservation.lockAcquired;
    // 先释放本地占用，保证队列不会因页面/回调迟迟不返回而永久卡住。
    this.forgetReservation(reservation);
    const releasePromise = lockAcquired
      ? this.releaseRemoteLock(reservation.taskId, reservation.ownerId)
      : Promise.resolve();
    const statusWritePromise = reservation.onWatchdogTimeout ? (async (): Promise<void> => {
      try {
        await withTimeout(
          () => reservation.onWatchdogTimeout!(event),
          WATCHDOG_POLICY.availabilityPersistMs,
          '任务超时状态写入超时',
        );
      } catch (error: unknown) {
        console.error('[AutomationEngine] 任务超时状态回写失败:', error);
      }
    })() : Promise.resolve();
    await Promise.all([releasePromise, statusWritePromise]);
  }

  private async renew(reservation: Reservation): Promise<void> {
    if (reservation.renewing || !this.reservations.has(reservation.taskId)) return;
    if (reservation.controller?.signal.aborted) return;
    reservation.renewing = true;
    let error = '未知错误';
    try {
      for (let attempt = 0; attempt < LEASE_RENEW_RETRIES; attempt += 1) {
        if (reservation.pendingAbortReason || reservation.controller?.signal.aborted || !this.reservations.has(reservation.taskId)) return;
        if (attempt > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, LEASE_RETRY_DELAY_MS));
          if (reservation.pendingAbortReason || reservation.controller?.signal.aborted || !this.reservations.has(reservation.taskId)) return;
        }
        try {
          const renewPromise = Promise.resolve().then(() => getElectronAPI().tasks.renewLock(reservation.taskId, reservation.ownerId));
          let result: Awaited<typeof renewPromise>;
          try {
            result = await withTimeout(
              renewPromise,
              WATCHDOG_POLICY.lockAcquireMs,
              '任务锁续租超时',
            );
          } catch (reason: unknown) {
            if (reason instanceof BoundedTimeoutError) {
              void renewPromise.then((lateResult) => {
                if (!lateResult.success || this.reservations.get(reservation.taskId) === reservation) return;
                void this.releaseRemoteLock(reservation.taskId, reservation.ownerId);
              }, () => undefined);
            }
            throw reason;
          }
          if (result.success) return;
          error = result.error || error;
        } catch (reason: unknown) {
          error = reason instanceof Error ? reason.message : String(reason);
        }
      }

      // 用户已经主动暂停/取消时，不能被本次异步续租结果改写为租约丢失。
      if (!this.reservations.has(reservation.taskId) || reservation.controller?.signal.aborted) return;
      const abortReason: AutomationAbortReason = {
        code: 'lease_lost',
        message: `任务执行锁续租失败：${error}`,
      };
      reservation.controller?.abort(abortReason);
      const lockAcquired = reservation.lockAcquired;
      this.forgetReservation(reservation);
      if (lockAcquired) await this.releaseRemoteLock(reservation.taskId, reservation.ownerId);
      console.error(`[AutomationEngine] 任务租约续租失败，已中止执行: ${error}`);
    } finally {
      reservation.renewing = false;
    }
  }

  /** 更新当前任务阶段的 watchdog 心跳；返回 false 表示任务已无活动 reservation。 */
  heartbeat(taskId: string, stage?: TaskStage): boolean {
    const reservation = this.reservations.get(taskId);
    if (!reservation?.watchdog || reservation.watchdog.hasTimedOut) return false;
    reservation.watchdog.heartbeat(stage);
    return true;
  }

  createController(taskId: string, accountId: string): AbortController {
    const reservation = this.reservations.get(taskId);
    if (!reservation || reservation.accountId !== accountId) {
      throw new Error('任务尚未获得执行锁');
    }
    reservation.controller?.abort({ code: 'internal_abort', message: '任务控制器被替换' } satisfies AutomationAbortReason);
    reservation.controller = new AbortController();
    if (reservation.pendingAbortReason) {
      reservation.controller.abort(reservation.pendingAbortReason);
    }
    return reservation.controller;
  }

  abort(taskId: string, reason: AutomationAbortReason = { code: 'user_pause' }): boolean {
    const reservation = this.reservations.get(taskId);
    if (!reservation) return false;
    reservation.pendingAbortReason = reason;
    if (reservation.controller && !reservation.controller.signal.aborted) reservation.controller.abort(reason);
    return true;
  }

  isReserved(taskId: string): boolean {
    return this.reservations.has(taskId);
  }

  async release(taskId: string): Promise<void> {
    const reservation = this.reservations.get(taskId);
    if (!reservation) {
      return;
    }
    const lockAcquired = reservation.lockAcquired;
    this.forgetReservation(reservation);
    if (lockAcquired) await this.releaseRemoteLock(taskId, reservation.ownerId);
  }
}

export const automationEngine = new AutomationEngine();
