import type {
  AccountAvailability,
  AccountAvailabilitySource,
  AccountPlatform,
} from '../types';
import { probeAccountAvailability } from './accountAvailability';
import {
  BoundedTimeoutError,
  WATCHDOG_POLICY,
  withTimeout,
} from './taskWatchdog';

export interface BoundedAvailabilityInput {
  webview: Parameters<typeof probeAccountAvailability>[0];
  platform: AccountPlatform;
  source: AccountAvailabilitySource;
  persist?: (availability: AccountAvailability) => Promise<boolean>;
  now?: () => number;
}

export interface BoundedAvailabilityResult {
  availability: AccountAvailability;
  persisted: boolean;
  timedOut: boolean;
}

/** 后台 WebView 切换账号后，Dola 的登录壳/编辑器可能分阶段挂载。 */
/** Dola 后台 WebView 的页面壳和编辑器挂载较慢，仅任务前置检查使用该预算。 */
export const DOLA_TASK_AVAILABILITY_CHECK_MS = 60_000;
const DOLA_TASK_AVAILABILITY_MAX_ATTEMPTS = 5;
const DOLA_TASK_AVAILABILITY_RETRY_DELAY_MS = 3_000;

function shouldConfirmDolaTaskAvailability(input: BoundedAvailabilityInput): boolean {
  return input.platform === 'dola' && (input.source === 'pre_task' || input.source === 'pre_submit');
}

function shouldRetryDolaTaskAvailability(availability: AccountAvailability): boolean {
  return availability.state === 'unknown' || availability.state === 'login_required';
}

async function probeUntilTaskAvailabilitySettles(
  input: BoundedAvailabilityInput,
  deadline: number,
  now: () => number,
): Promise<AccountAvailability> {
  const maxAttempts = shouldConfirmDolaTaskAvailability(input)
    ? DOLA_TASK_AVAILABILITY_MAX_ATTEMPTS
    : 1;
  let latest: AccountAvailability | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const probeBudget = Math.max(1, deadline - now());
    latest = await withTimeout(
      () => probeAccountAvailability(
        input.webview,
        input.platform,
        input.source,
        Math.min(6_000, probeBudget),
      ),
      probeBudget,
      '账号可用性检测超时，已停止等待',
    );

    if (
      attempt >= maxAttempts ||
      !shouldRetryDolaTaskAvailability(latest)
    ) return latest;

    // Dola 窗口刚切换到后台 WebView 时，加载壳会短暂显示登录入口。
    // 只等待页面继续挂载，不触发刷新、导航或任何平台写入动作。
    const remainingMs = deadline - now();
    if (remainingMs <= DOLA_TASK_AVAILABILITY_RETRY_DELAY_MS) return latest;
    await new Promise<void>((resolve) => setTimeout(resolve, DOLA_TASK_AVAILABILITY_RETRY_DELAY_MS));
  }

  return latest!;
}

function timeoutAvailability(
  platform: AccountPlatform,
  source: AccountAvailabilitySource,
  checkedAt: string,
  reason: string,
  message: string,
): AccountAvailability {
  void platform;
  return {
    state: 'unknown',
    reason,
    message,
    checkedAt,
    source,
  };
}

/**
 * 将“探测页面 → 写回状态”视为一个有界操作。
 * 探测或写回超时都不会把旧状态继续当成 ready，也不会再次触发平台动作。
 */
export async function runBoundedAvailabilityCheck(
  input: BoundedAvailabilityInput,
): Promise<BoundedAvailabilityResult> {
  const now = input.now || (() => Date.now());
  const startedAt = now();
  const checkBudget = shouldConfirmDolaTaskAvailability(input)
    ? DOLA_TASK_AVAILABILITY_CHECK_MS
    : WATCHDOG_POLICY.availabilityCheckMs;
  const deadline = startedAt + checkBudget;
  const checkedAt = new Date(startedAt).toISOString();
  let phase: 'probe' | 'persist' = 'probe';

  try {
    const availability = await probeUntilTaskAvailabilitySettles(input, deadline, now);

    if (!input.persist) {
      return { availability, persisted: true, timedOut: false };
    }

    phase = 'persist';
    const persistBudget = Math.max(1, deadline - now());
    const persisted = await withTimeout(
      () => input.persist!(availability),
      persistBudget,
      '账号可用性状态写入超时，已停止等待',
    );
    return { availability, persisted: persisted === true, timedOut: false };
  } catch (error: unknown) {
    const timedOut = error instanceof BoundedTimeoutError;
    const message = timedOut
      ? error.message
      : '账号可用性检测异常，已停止等待；请稍后重新检测';
    const fallback = timeoutAvailability(
      input.platform,
      input.source,
      checkedAt,
      timedOut ? 'availability_check_timeout' : 'availability_check_error',
      message,
    );

    // 探测阶段超时仍可尝试把 unknown 写回，防止旧的 ready 结论继续放行；
    // 写回阶段超时则不再发起第二次写入，避免两个迟到 Promise 互相覆盖。
    if (phase === 'probe' && input.persist && now() < deadline) {
      try {
        const fallbackBudget = Math.min(
          WATCHDOG_POLICY.availabilityPersistMs,
          Math.max(1, deadline - now()),
        );
        const persisted = await withTimeout(
          () => input.persist!(fallback),
          fallbackBudget,
          '账号可用性超时状态写入超时',
        );
        return { availability: fallback, persisted: persisted === true, timedOut: true };
      } catch {
        // 失败保持 fail-closed；调用方会清理 checking 标记但不启动队列。
      }
    }
    return { availability: fallback, persisted: false, timedOut: timedOut || phase === 'persist' };
  }
}
