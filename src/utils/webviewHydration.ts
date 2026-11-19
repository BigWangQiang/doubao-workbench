import type { Account, AccountAvailabilitySource } from '../types';

/**
 * 启动后台预热只服务于豆包的快速就绪探测。Dola 页面需要保持稳定的
 * Session/扩展生命周期，不能在用户尚未打开时创建后又释放 guest。
 * 执行中的 Dola 仍由任务驻留集合按需挂载，不受此规则影响。
 */
export function shouldWarmupAccount(account: Pick<Account, 'platform'>): boolean {
  return account.platform !== 'dola';
}

/**
 * 导航事件在 Dola 页面上可能由平台自身的语言/区域状态触发；把它们
 * 映射成可用性探测会造成状态更新和生命周期抖动。启动、任务门禁和手动
 * 检测仍然允许调用同一套只读探测。
 */
export function shouldScheduleAutomaticAvailabilityCheck(
  platform: Account['platform'] | undefined,
  source: AccountAvailabilitySource,
): boolean {
  return platform !== 'dola' || source !== 'navigation';
}

/**
 * Selects pending manual availability requests without exceeding the WebView probe limit.
 * Request counters make repeated checks lossless while an earlier request is still running.
 */
export function getPendingAvailabilityProbeAccountIds(
  requests: Readonly<Record<string, number>>,
  handledRequests: Readonly<Record<string, number>>,
  activeAccountIds: ReadonlySet<string>,
  maxConcurrent = 2,
): string[] {
  const availableSlots = Math.max(0, Math.floor(maxConcurrent) - activeAccountIds.size);
  if (availableSlots === 0) return [];

  return Object.entries(requests)
    .filter(([accountId, requestId]) =>
      requestId > 0 &&
      requestId > (handledRequests[accountId] || 0) &&
      !activeAccountIds.has(accountId),
    )
    .slice(0, availableSlots)
    .map(([accountId]) => accountId);
}

/**
 * 这些任务虽然不占用执行锁，但仍依赖原会话页面做人工处理或只读恢复。
 * 页面被回收后只能等用户再次切换账号，容易把任务长期留在等待态。
 */
const WEBVIEW_RETAINED_TASK_STATUSES = new Set([
  'executing',
  'generating',
  'waiting_verification',
  'waiting_generation_confirmation',
  'manual_submission_observing',
]);

export interface WebviewRetentionTask {
  assignedAccountId?: string | null;
  status?: string;
}

export interface ProxyUpdateEventDetail {
  reloadHandledByMain?: boolean;
}

/**
 * 代理配置保存时主进程会先重配 Session 并刷新已有 Dola WebView。
 * 渲染层只需要在旧版调用方未完成刷新时兜底 reload，避免同一次保存触发双重导航。
 */
export function shouldReloadAfterProxyUpdate(
  detail: ProxyUpdateEventDetail | undefined,
): boolean {
  return detail?.reloadHandledByMain !== true;
}

/** 返回仍需要驻留账号页面的任务账号集合。 */
export function getTaskWebviewRetentionIds(
  tasks: readonly WebviewRetentionTask[],
): Set<string> {
  return new Set(
    tasks
      .filter((task) =>
        Boolean(task.assignedAccountId) && WEBVIEW_RETAINED_TASK_STATUSES.has(task.status || ''),
      )
      .map((task) => task.assignedAccountId as string),
  );
}

/**
 * 启动时只挂载当前账号；任务真正进入执行态时再补挂对应账号。
 * 已经创建的 webview 由 BrowserPanel registry 保留，不在这里回收。
 */
export function getWebviewHydrationAccountIds(
  accounts: Array<Pick<Account, 'id'>>,
  activeAccountId: string | null,
  executingTasks: Record<string, string>,
  retainedAccountIds: ReadonlySet<string> = new Set<string>(),
): string[] {
  const existingIds = new Set(accounts.map((account) => account.id));
  const desired = new Set<string>();

  if (activeAccountId && existingIds.has(activeAccountId)) desired.add(activeAccountId);
  for (const accountId of Object.keys(executingTasks)) {
    if (executingTasks[accountId] && existingIds.has(accountId)) desired.add(accountId);
  }
  for (const accountId of retainedAccountIds) {
    if (existingIds.has(accountId)) desired.add(accountId);
  }

  return [...desired];
}

interface WebviewActivationStyle {
  opacity: string;
  pointerEvents: string;
  transform: string;
  zIndex: string;
  visibility: string;
}

/**
 * Electron 的 guest view 从 visibility:hidden 恢复时可能不触发合成器重绘。
 * webview 始终保留在可合成树中。Electron guest surface 不可靠遵守普通 DOM
 * z-index，因此后台页必须移出可视区域，不能与当前账号不透明叠放。
 */
export function applyWebviewActivationStyle(
  style: WebviewActivationStyle,
  active: boolean,
): void {
  style.visibility = 'visible';
  style.opacity = '1';
  style.pointerEvents = active ? 'auto' : 'none';
  // Keep inactive guests at the same non-zero viewport so visibility-dependent
  // controls remain measurable while the app is minimized or another page is open.
  style.transform = 'translate3d(0, 0, 0)';
  style.zIndex = active ? '1' : '-1';
}

export interface ModeEntryRecoveryOptions {
  warmup: () => Promise<void>;
  attempt: (attempt: number) => Promise<boolean>;
  forceLayout: () => Promise<void>;
  safeReload: () => Promise<boolean>;
  now?: () => number;
}

export interface ModeEntryRecoveryResult {
  switched: boolean;
  attempts: number;
  elapsedMs: number;
  reloadAttempted: boolean;
}

/** Recover a missing mode entry without permitting a post-submit reload. */
export async function recoverModeEntry(
  options: ModeEntryRecoveryOptions,
): Promise<ModeEntryRecoveryResult> {
  const now = options.now || Date.now;
  const startedAt = now();
  await options.warmup();
  if (await options.attempt(1)) {
    return { switched: true, attempts: 1, elapsedMs: now() - startedAt, reloadAttempted: false };
  }

  await options.forceLayout();
  if (await options.attempt(2)) {
    return { switched: true, attempts: 2, elapsedMs: now() - startedAt, reloadAttempted: false };
  }

  const reloadAllowed = await options.safeReload();
  if (!reloadAllowed) {
    return { switched: false, attempts: 2, elapsedMs: now() - startedAt, reloadAttempted: false };
  }

  const switched = await options.attempt(3);
  return { switched, attempts: 3, elapsedMs: now() - startedAt, reloadAttempted: true };
}

/** 快速切换时回收仍在加载且没有执行任务的旧前台页，避免网络加载风暴。 */
export function getSupersededLoadingAccountIds(
  registeredAccountIds: readonly string[],
  loadingAccountIds: ReadonlySet<string>,
  activeAccountId: string | null,
  executingTasks: Readonly<Record<string, string>>,
  retainedAccountIds: ReadonlySet<string> = new Set<string>(),
): string[] {
  return registeredAccountIds.filter((accountId) =>
    accountId !== activeAccountId &&
    loadingAccountIds.has(accountId) &&
    !executingTasks[accountId] &&
    !retainedAccountIds.has(accountId),
  );
}

/**
 * 后台预热页只用于一次性探测。探测完成后，只有在页面不是当前账号且
 * 没有执行中的任务时才允许释放；执行中的账号必须继续复用同一个 guest。
 */
export function shouldReleaseBackgroundWebview(
  accountId: string,
  activeAccountId: string | null,
  executingTasks: Readonly<Record<string, string>>,
  isBackgroundProbe: boolean,
  retainedAccountIds: ReadonlySet<string> = new Set<string>(),
): boolean {
  return isBackgroundProbe &&
    accountId !== activeAccountId &&
    !executingTasks[accountId] &&
    !retainedAccountIds.has(accountId);
}

export interface WebviewLoadRecoveryState {
  windowStartedAt: number;
  attempts: number;
}

export interface WebviewLoadRecoveryDecision {
  allowed: boolean;
  nextState: WebviewLoadRecoveryState;
}

/**
 * 自动重载只允许在有界时间窗口内尝试有限次数。
 * 页面连续失败时 fail-closed，避免 did-fail-load/dom-ready 交替造成重载风暴。
 */
export function decideWebviewLoadRecovery(
  state: Readonly<WebviewLoadRecoveryState>,
  now: number,
  maxAttempts = 1,
  windowMs = 30_000,
): WebviewLoadRecoveryDecision {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const safeMaxAttempts = Math.max(0, Math.floor(maxAttempts));
  const safeWindowMs = Math.max(1, windowMs);
  const windowExpired = !Number.isFinite(state.windowStartedAt)
    || state.windowStartedAt <= 0
    || safeNow - state.windowStartedAt >= safeWindowMs;
  const base: WebviewLoadRecoveryState = windowExpired
    ? { windowStartedAt: safeNow, attempts: 0 }
    : {
      windowStartedAt: state.windowStartedAt,
      attempts: Math.max(0, Math.floor(state.attempts)),
    };
  if (base.attempts >= safeMaxAttempts) {
    return { allowed: false, nextState: base };
  }
  return {
    allowed: true,
    nextState: { ...base, attempts: base.attempts + 1 },
  };
}

/**
 * 在驻留页面超过上限时选择最久未使用的闲置账号。
 * 当前账号、执行中账号和调用方显式排除的后台探测账号永远不会被选中。
 */
export function getIdleWebviewEvictionIds(
  registeredAccountIds: readonly string[],
  activeAccountId: string | null,
  executingTasks: Readonly<Record<string, string>>,
  lastUsedAt: Readonly<Record<string, number>>,
  maxResident = 4,
  excludedAccountIds: ReadonlySet<string> = new Set<string>(),
): string[] {
  const protectedIds = new Set<string>([
    ...(activeAccountId ? [activeAccountId] : []),
    ...Object.keys(executingTasks).filter((accountId) => Boolean(executingTasks[accountId])),
    ...excludedAccountIds,
  ]);
  const residentLimit = Math.max(1, Math.floor(maxResident));
  const excess = Math.max(0, registeredAccountIds.length - residentLimit);
  if (excess === 0) return [];
  return registeredAccountIds
    .filter((accountId) => !protectedIds.has(accountId))
    .sort((left, right) => {
      const leftTime = Number.isFinite(lastUsedAt[left]) ? lastUsedAt[left] : 0;
      const rightTime = Number.isFinite(lastUsedAt[right]) ? lastUsedAt[right] : 0;
      return leftTime - rightTime;
    })
    .slice(0, excess);
}

interface WebviewRepaintTarget {
  readonly offsetWidth: number;
  style: { width: string };
}

/**
 * Electron guest surface 偶发已加载但未提交首帧；一次 1px 布局变化可触发与用户
 * 调整窗口相同的合成器重绘。恢复在下一帧完成，不改变最终布局。
 */
export function forceWebviewLayoutRepaint(
  target: WebviewRepaintTarget,
  scheduleFrame: (callback: () => void) => void = (callback) => requestAnimationFrame(callback),
): Promise<void> {
  const originalWidth = target.style.width || '100%';
  target.style.width = 'calc(100% - 1px)';
  void target.offsetWidth;
  return new Promise((resolve) => {
    scheduleFrame(() => {
      target.style.width = originalWidth;
      void target.offsetWidth;
      resolve();
    });
  });
}

/**
 * Electron guest 的 DOM 脚本接口偶尔晚于页面本身可用。页面已经提交真实标题且
 * URL 属于预期平台时，可作为不读取账号数据的就绪证据，避免加载层永久遮挡。
 */
export function isWebviewDocumentReady(
  url: string,
  title: string,
  expectedHost: string,
): boolean {
  if (!title.trim() || !url.trim()) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const host = expectedHost.toLowerCase();
    return hostname === host || hostname.endsWith(`.${host}`);
  } catch {
    return false;
  }
}
