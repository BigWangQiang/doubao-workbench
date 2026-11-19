import { WATCHDOG_POLICY } from './taskWatchdog';

export interface InitializationLease {
  waitedMs: number;
  release: () => void;
}

export class InitializationTimeoutError extends Error {
  readonly code = 'initialization_timeout' as const;

  constructor(readonly timeoutMs: number) {
    super(`初始化排队超过 ${Math.ceil(timeoutMs / 1000)} 秒，任务已停止等待`);
    this.name = 'InitializationTimeoutError';
  }
}

interface Waiter {
  taskId: string;
  enqueuedAt: number;
  signal?: AbortSignal;
  resolve: (lease: InitializationLease) => void;
  reject: (error: Error) => void;
  abortHandler?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/**
 * 仅限制页面高冲突初始化区；任务进入 generating 后调用 release，生成阶段不占槽。
 */
export class InitializationGate {
  private active = new Set<string>();
  private waiters: Waiter[] = [];
  private limit = 1;

  async acquire(taskId: string, options: { limit?: number; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<InitializationLease> {
    this.limit = Math.max(1, Math.min(3, Math.floor(options.limit || 1)));
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(0, options.timeoutMs as number)
      : WATCHDOG_POLICY.initializationQueueMs;
    return new Promise<InitializationLease>((resolve, reject) => {
      const waiter: Waiter = {
        taskId,
        enqueuedAt: Date.now(),
        signal: options.signal,
        resolve,
        reject,
        settled: false,
      };
      const cleanup = (): void => {
        if (waiter.timer !== undefined) {
          clearTimeout(waiter.timer);
          waiter.timer = undefined;
        }
        if (waiter.abortHandler) {
          options.signal?.removeEventListener('abort', waiter.abortHandler);
          waiter.abortHandler = undefined;
        }
      };
      const rejectWaiter = (error: Error): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.waiters = this.waiters.filter((item) => item !== waiter);
        cleanup();
        reject(error);
        this.drain();
      };
      const resolveWaiter = (lease: InitializationLease): void => {
        if (waiter.settled) {
          // A timeout/abort can win the same event-loop turn as drain().
          lease.release();
          return;
        }
        waiter.settled = true;
        cleanup();
        resolve(lease);
      };
      waiter.reject = rejectWaiter;
      waiter.resolve = resolveWaiter;
      const onAbort = (): void => rejectWaiter(new DOMException('Aborted', 'AbortError'));
      waiter.abortHandler = onAbort;
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs !== Number.POSITIVE_INFINITY) {
        waiter.timer = setTimeout(() => {
          rejectWaiter(new InitializationTimeoutError(timeoutMs));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active.size < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.settled) continue;
      if (waiter.signal?.aborted) {
        waiter.reject(new DOMException('Aborted', 'AbortError'));
        continue;
      }
      this.active.add(waiter.taskId);
      let released = false;
      waiter.resolve({
        waitedMs: Date.now() - waiter.enqueuedAt,
        release: () => {
          if (released) return;
          released = true;
          this.active.delete(waiter.taskId);
          this.drain();
        },
      });
    }
  }
}

export const initializationGate = new InitializationGate();
