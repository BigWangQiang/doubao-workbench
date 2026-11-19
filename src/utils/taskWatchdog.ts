import type { GenerationMode, TaskStage } from '../types';
import { generationWaitBudgetMs } from './taskTimeoutPolicy';

/** 本轮新增的生命周期上限集中在此文件，避免改写已有策略文件。 */
export const WATCHDOG_POLICY = Object.freeze({
  availabilityCheckMs: 20_000,
  availabilityPersistMs: 8_000,
  runtimePersistMs: 8_000,
  initializationQueueMs: 30_000,
  lockAcquireMs: 15_000,
  taskWatchdogTickMs: 5_000,
  taskWatchdogDefaultMs: 120_000,
  taskWatchdogGraceMs: 60_000,
});

/** 可取消等待之外的统一超时错误，调用方可据此落为可恢复暂停。 */
export class BoundedTimeoutError extends Error {
  readonly code = 'timeout' as const;

  constructor(message: string, readonly timeoutMs: number) {
    super(message);
    this.name = 'BoundedTimeoutError';
  }
}

type TimeoutOperation<T> = PromiseLike<T> | (() => PromiseLike<T> | T);

/**
 * 给可能来自 WebView/IPC 的 Promise 增加上限。
 * 超时只结束当前等待，不会重发平台请求；迟到结果由调用方的 run/sequence 校验丢弃。
 */
export function withTimeout<T>(
  operation: TimeoutOperation<T>,
  timeoutMs: number,
  message = `操作超时（${timeoutMs}ms）`,
): Promise<T> {
  const boundedMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : Number.POSITIVE_INFINITY;
  const operationPromise = typeof operation === 'function'
    ? Promise.resolve().then(() => operation())
    : Promise.resolve(operation);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    };

    if (boundedMs !== Number.POSITIVE_INFINITY) {
      timer = setTimeout(() => {
        rejectOnce(new BoundedTimeoutError(message, boundedMs));
      }, boundedMs);
    }
    operationPromise.then(resolveOnce, rejectOnce);
  });
}

const TERMINAL_STAGES = new Set<TaskStage>(['completed', 'paused', 'failed', 'cancelled']);

/** 各执行阶段的无进展上限；生成阶段沿用既有生成预算并留出收尾宽限。 */
const STAGE_TIMEOUTS: Readonly<Partial<Record<TaskStage, number>>> = Object.freeze({
  queued: 2 * 60 * 1000,
  preparing_account: 45_000,
  new_conversation: 90_000,
  switching_mode: 90_000,
  configuring: 120_000,
  uploading_assets: 4 * 60 * 1000,
  injecting_prompt: 90_000,
  submitting: 60_000,
  waiting_verification: 35 * 60 * 1000,
  waiting_generation_confirmation: 35 * 60 * 1000,
  manual_submission_observing: 35 * 60 * 1000,
});

export function taskStageTimeoutMs(stage: TaskStage | undefined, mode?: GenerationMode): number {
  if (!stage || TERMINAL_STAGES.has(stage)) return Number.POSITIVE_INFINITY;
  if (stage === 'generating' || stage === 'extracting_outputs') {
    return generationWaitBudgetMs(mode || 'chat') + WATCHDOG_POLICY.taskWatchdogGraceMs;
  }
  return STAGE_TIMEOUTS[stage] ?? WATCHDOG_POLICY.taskWatchdogDefaultMs;
}

export function isTaskStageStale(
  stage: TaskStage | undefined,
  lastHeartbeatAt: number | string,
  now = Date.now(),
  mode?: GenerationMode,
): boolean {
  const timeoutMs = taskStageTimeoutMs(stage, mode);
  if (!Number.isFinite(timeoutMs)) return false;
  const heartbeatMs = typeof lastHeartbeatAt === 'number' ? lastHeartbeatAt : Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return true;
  return Math.max(0, now - heartbeatMs) >= timeoutMs;
}

export interface TaskWatchdogTimeout {
  stage: TaskStage;
  timeoutMs: number;
  elapsedMs: number;
  lastHeartbeatAt: number;
}

export interface TaskWatchdogOptions {
  initialStage?: TaskStage;
  mode?: GenerationMode;
  now?: () => number;
  tickMs?: number;
  onTimeout: (event: TaskWatchdogTimeout) => void | Promise<void>;
}

/** 运行时阶段心跳 watchdog；只负责发出一次超时通知，资源释放由调用方完成。 */
export class TaskWatchdog {
  private readonly now: () => number;
  private readonly mode: GenerationMode | undefined;
  private readonly tickMs: number;
  private readonly onTimeout: TaskWatchdogOptions['onTimeout'];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private timedOut = false;
  private stage: TaskStage;
  private lastHeartbeatMs: number;

  constructor(options: TaskWatchdogOptions) {
    this.now = options.now || (() => Date.now());
    this.mode = options.mode;
    this.tickMs = Math.max(250, options.tickMs || WATCHDOG_POLICY.taskWatchdogTickMs);
    this.onTimeout = options.onTimeout;
    this.stage = options.initialStage || 'preparing_account';
    this.lastHeartbeatMs = this.now();
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      this.check();
    }, this.tickMs);
    // Node/Vitest timers must not keep a closed test process alive; browsers simply ignore this.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  heartbeat(stage?: TaskStage, at = this.now()): void {
    if (this.stopped || this.timedOut) return;
    if (stage) this.stage = stage;
    this.lastHeartbeatMs = at;
  }

  check(at = this.now()): boolean {
    if (this.stopped || this.timedOut) return false;
    const timeoutMs = taskStageTimeoutMs(this.stage, this.mode);
    if (!isTaskStageStale(this.stage, this.lastHeartbeatMs, at, this.mode)) return false;
    this.timedOut = true;
    const event: TaskWatchdogTimeout = {
      stage: this.stage,
      timeoutMs,
      elapsedMs: Math.max(0, at - this.lastHeartbeatMs),
      lastHeartbeatAt: this.lastHeartbeatMs,
    };
    try {
      Promise.resolve(this.onTimeout(event)).catch((error: unknown) => {
        console.error('[TaskWatchdog] 超时处理失败:', error);
      });
    } catch (error: unknown) {
      console.error('[TaskWatchdog] 超时回调失败:', error);
    }
    return true;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get currentStage(): TaskStage {
    return this.stage;
  }

  get lastHeartbeatAt(): number {
    return this.lastHeartbeatMs;
  }

  get hasTimedOut(): boolean {
    return this.timedOut;
  }
}
