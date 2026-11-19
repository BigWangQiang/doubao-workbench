/**
 * src/components/BrowserPanel.tsx
 * 内嵌浏览器面板 — V4 正式版
 *
 * 架构：
 * - 每个账号独立 webview，CSS 显隐控制，切换不销毁
 * - 支持多账号并行自动化 + 同账号任务队列
 * - per-account 执行状态监听，自动路由任务到对应 webview
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Input, message, Modal, notification, Switch, Tooltip } from 'antd';
import type { Account, AccountAvailability, AccountAvailabilitySource, AccountPlatform, Task, TaskUpdateInput } from '../types';
import { useAccountStore } from '../store/useAccountStore';
import { useTaskStore } from '../store/useTaskStore';
import type { AutomationState } from '../store/useTaskStore';
import {
  classifyTaskError,
  classifyTransientAutomationError,
  isTransientAutomationErrorCode,
  isPaidQuotaConfirmationMessage,
  isPaidQuotaGenerationStartedMessage,
  isQuotaExhaustedMessage,
} from '../utils/errorClassification';
import { evaluateVideoCapability, isRestrictionFailure } from '../utils/videoCapability';
import {
  automationEngine,
  readAutomationAbortReason,
  type AutomationAbortReason,
} from '../automation/AutomationEngine';
import { runAdapterSelfCheck } from '../automation/doubaoAdapter';
import {
  injectPrompt,
  prepareVideoPromptForSubmission,
  verifyPromptReadyForSubmission,
  submitPromptWithNativeClick,
  submitGenerationConfirmationWithNativeClick,
  confirmDoubaoPaidQuotaUsage,
  inspectMaterialAuthorization,
  confirmMaterialAuthorizationIfAllowed,
  inspectGenerationConfirmation,
  checkGeneratingDetailed,
  getResultUrl,
  switchMode,
  waitForChatReady,
  clickAITab,
  configureVideoOptions,
  DolaVideoControlReadinessError,
  uploadReferenceImages,
  uploadReferenceVideos,
  uploadReferenceAudios,
  resetVideoCaptureCache,
  resetImageCaptureCache,
  refreshBlockerBaseline,
  detectVideoGenerationBlocker,
  injectGenerationMonitor,
  getCachedImageUrls,
  getGenerationStartTime,
  getConversationText,
  getLatestAssistantReply,
  getSubmissionMessageCount,
  getSubmissionEvidence,
  startNewConversation,
  inspectPostSubmitGenerationState,
  resolveVideoArtifact,
  manualResolveVideoArtifact,
  waitForSubmissionControlsStable,
  dismissKnownDesktopDownloadPromotion,
  type NativeSubmitClickResult,
} from '../utils/doubaoBridge';
import {
  isExplicitlyWatermarkedVideoUrl,
  type VideoArtifactResolution,
} from '../utils/videoArtifactResolver';
import {
  canAttemptSubmission,
  classifySubmissionReadback,
  evaluateTerminal,
  matchesSubmissionConversation,
  requiresSubmissionReconciliation,
  updateStableStreak,
} from '../utils/realSendStateMachine';
import { createWebviewResourceScope } from '../utils/webviewLifecycle';
import type { WebviewResourceScope } from '../utils/webviewLifecycle';
import { getVideoQuotaUsageUnits } from '../utils/videoQuota';
import { normalizeImageArtifactUrls } from '../utils/artifactKind';
import { availabilityBlocksAutomation } from '../utils/accountAvailability';
import {
  decideVerificationRecovery,
  decidePostSubmitVerification,
  hasPostSubmitGenerationEvidence,
  MAX_TRANSIENT_PRE_SUBMIT_ATTEMPTS,
  MAX_VIDEO_CONTROL_RECOVERY_ATTEMPTS,
} from '../utils/postSubmitVerification';
import { isExperimentalNoWatermarkEnabled, setExperimentalNoWatermarkEnabled } from '../utils/experimentalNoWatermark';
import { decideMaterialAuthorizationProgress } from '../utils/materialAuthorization';
import {
  canAutoSwitchBeforeSubmission,
  selectPreSubmitFallbackAccount,
  selectQuotaFallbackAccount,
} from '../utils/quotaRecovery';
import {
  decideDoubaoVideoReplyAction,
  canFollowDoubaoInitialConversation,
  decideManualDoubaoConfirmationAction,
  getDoubaoGenerationWaitMessage,
  hasDoubaoConfirmationReadback,
  isDoubaoVideoCompletedReply,
  type GenerationConfirmationEvidence,
} from '../utils/generationConfirmation';
import { VideoControlReadinessError } from '../utils/videoControlReadiness';
import { initializationGate } from '../utils/initializationGate';
import { runBoundedAvailabilityCheck } from '../utils/boundedAvailability';
import { withTimeout } from '../utils/taskWatchdog';
import {
  MAX_REFERENCE_IMAGE_COUNT,
} from '../utils/uploadReadiness';
import { REFERENCE_VIDEO_LIMIT, REFERENCE_AUDIO_LIMIT } from '../utils/referenceMaterialLimits';
import {
  artifactPollLimit,
  generationPollLimit,
  generationWaitBudgetMs,
  TASK_TIMEOUT_POLICY,
} from '../utils/taskTimeoutPolicy';
import type { InitializationLease } from '../utils/initializationGate';
import {
  applyWebviewActivationStyle,
  forceWebviewLayoutRepaint,
  recoverModeEntry,
  getPendingAvailabilityProbeAccountIds,
  getSupersededLoadingAccountIds,
  getWebviewHydrationAccountIds,
  getIdleWebviewEvictionIds,
  getTaskWebviewRetentionIds,
  isWebviewDocumentReady,
  decideWebviewLoadRecovery,
  shouldReleaseBackgroundWebview,
  shouldReloadAfterProxyUpdate,
  shouldScheduleAutomaticAvailabilityCheck,
  shouldWarmupAccount,
} from '../utils/webviewHydration';

/** 将当前对话的结构化解析结果转换为用户可读消息。 */
const formatResolutionMessage = (result: VideoArtifactResolution): string => {
  const sourceLabels: Record<string, string> = {
    platform_download_info: '创作空间下载信息',
    doubao_extension: '豆包扩展无水印资源',
    dola_extension: 'Dola 扩展无水印资源',
    play_info: '播放信息接口',
    captured_response: '已拦截响应',
    conversation_scan: '对话页面扫描',
    page_fallback: '页面回退地址',
    experimental: '实验直取（未经官方授权）',
  };
  const statusLabels: Record<string, string> = {
    resolved: '已获取',
    unavailable: '不可用',
    expired: '已过期',
    unauthorized: '无权限或登录失效',
    retryable_error: '可重试错误',
    needs_manual_selection: '需要人工选择',
  };
  const sourceLabel = result.source ? sourceLabels[result.source] || result.source : '';
  const statusLabel = statusLabels[result.status] || result.status;
  return `${statusLabel}${sourceLabel ? `（来源：${sourceLabel}）` : ''}${result.reason ? `：${result.reason}` : ''}`;
};

interface BrowserPanelProps {
  accounts: Account[];
  activeAccount: Account | null;
  refreshKey: number;
}

async function readReferenceFileData(
  filePaths: string[],
  fallbackMime: string,
): Promise<Array<{ name: string; base64: string; mime: string }>> {
  const files: Array<{ name: string; base64: string; mime: string }> = [];
  for (const filePath of filePaths) {
    const result = await window.electronAPI.tasks.readFileAsBase64(filePath);
    if (!result.success || !result.data) continue;
    const fileName = filePath.split(/[/\\]/).pop() || 'reference.bin';
    const match = result.data.match(/^data:([^;]+);base64,(.*)$/s);
    const mime = match?.[1] || fallbackMime;
    const base64 = match?.[2] || result.data;
    files.push({ name: fileName, base64, mime });
  }
  return files;
}

function getAccountHome(account: Pick<Account, 'platform'>): string {
  // Dola 的语言由 Session Cookie/扩展固定；不要把 language 查询参数带入
  // 首次导航，避免服务端与本地语言状态互相重定向造成刷新循环。
  return account.platform === 'dola' ? 'https://www.dola.com/chat' : 'https://www.doubao.com/chat/';
}

function getAccountHost(account: Pick<Account, 'platform'>): string {
  return account.platform === 'dola' ? 'dola.com' : 'doubao.com';
}

function isDolaUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'dola.com' || hostname.endsWith('.dola.com');
  } catch {
    return false;
  }
}

/** 只识别 Dola 的非中文语言导航；普通会话导航和用户刷新不受影响。 */
function isDolaNonChineseLocaleNavigation(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (hostname !== 'dola.com' && !hostname.endsWith('.dola.com')) return false;
    return ['language', 'lang', 'locale', 'i18nextLng', 'i18next'].some((key) => {
      const locale = parsed.searchParams.get(key);
      return locale !== null && locale.trim() !== '' && !/^zh(?:[-_]|$)/i.test(locale.trim());
    });
  } catch {
    return false;
  }
}

function getAccountSessionPartition(account: Pick<Account, 'platform' | 'partition'>): string {
  const platform = account.platform === 'dola' ? 'dola' : 'doubao';
  return `persist:${platform}_${account.partition}`;
}

/** 生成用于匹配任务台账的会话 URL 键；忽略 hash 和末尾斜杠，保留具体会话路径。 */
function conversationUrlKeys(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    const exact = `${host}${path}${parsed.search}`;
    const pathKey = `${host}${path}`;
    return exact === pathKey ? [exact] : [exact, pathKey];
  } catch {
    const fallback = value.trim().replace(/[#].*$/, '').replace(/\/+$/, '').toLowerCase();
    return fallback ? [fallback] : [];
  }
}

/** 仅按同账号、同平台、同具体会话绑定，避免把手动产物错挂到其他任务。 */
function findTaskForManualArtifact(
  taskList: Task[],
  account: Pick<Account, 'id' | 'platform'>,
  conversationUrl: string,
): Task | undefined {
  const currentKeys = new Set(conversationUrlKeys(conversationUrl));
  if (currentKeys.size === 0) return undefined;
  const candidates = taskList
    .filter((task) => task.mode === 'video' && task.assignedAccountId === account.id)
    .filter((task) => (task.targetPlatform || account.platform || 'doubao') === (account.platform || 'doubao'));
  return candidates
    .filter((task) => {
      const taskUrls = [
        task.runtime?.conversationUrl,
        ...(task.artifacts || []).map((artifact) => artifact.conversationUrl),
      ];
      return taskUrls.some((url) => conversationUrlKeys(url).some((key) => currentKeys.has(key)));
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

/** 已经可能产生外部副作用，自动化必须暂停并禁止重试。 */
class SubmissionSafetyPauseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionSafetyPauseError';
  }
}

/** 发送控件在任何原生事件前就不可用；可以安全清除提交意图并改派。 */
class PreSubmitSendFailureError extends Error {
  readonly code = 'submission_failed';

  constructor(message: string) {
    super(message);
    this.name = 'PreSubmitSendFailureError';
  }
}

/** 提交意图无法落盘时的安全错误；点击发送前绝不能继续。 */
class SubmissionPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionPersistenceError';
  }
}

// 页面消息/SSE 回执可能晚于首屏渲染；等待有上限且只读，不会在超时后重试发送。
const SUBMISSION_READBACK_TIMEOUT_MS = TASK_TIMEOUT_POLICY.submissionReadbackMs;
const SUBMISSION_READBACK_INTERVAL_MS = 500;
const DOUBAO_VIDEO_CONFIRM_TEXT = '确认生成视频';
const DOUBAO_VIDEO_CONFIRM_MAX_ROUNDS = 12;
const DOUBAO_VIDEO_CONFIRM_MAX_WINDOW_MS = 10 * 60 * 1000;
const DOUBAO_VIDEO_CONFIRM_READBACK_MS = 15_000;
const DOUBAO_PAID_QUOTA_CONFIRM_MAX_WINDOW_MS = 45_000;

/** 页面明确需要用户处理；提交前任务在同一账号窗口恢复，已确认提交任务只读核对。 */
class AccountAvailabilityPauseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AccountAvailabilityPauseError';
  }
}

/** 自动确认超过保护上限时暂停，避免异常页面无限发送。 */
class GenerationConfirmationPauseError extends Error {
  constructor(readonly evidence: GenerationConfirmationEvidence, message?: string) {
    super(message || '豆包视频自动确认超过保护上限；请在原会话中人工核对，系统不会继续发送');
    this.name = 'GenerationConfirmationPauseError';
  }
}

const normalizeVideoUrls = (urls: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of urls) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed)) continue;
    const lower = trimmed.toLowerCase();
    const isImageOnly = /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(lower) || lower.includes('image') || lower.includes('poster');
    const isLikelyVideo =
      /\.(mp4|mov|m4v|webm|m3u8)(\?|#|$)/i.test(lower) ||
      lower.includes('video') ||
      lower.includes('vod') ||
      lower.includes('play') ||
      lower.includes('mime_type=video') ||
      lower.includes('lr=');
    if (isImageOnly && !isLikelyVideo) continue;
    if (!isLikelyVideo) continue;
    if (isExplicitlyWatermarkedVideoUrl(trimmed)) {
      console.warn('[BrowserPanel] 已拒绝明确带水印的视频地址');
      continue;
    }
    // 下载豆包明确返回的原始 URL；禁止通过改写查询参数伪装成无水印地址。
    const clean = trimmed;
    if (!seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
};

const normalizeResolvedVideoOutput = (
  result: VideoArtifactResolution,
  _platform: AccountPlatform | undefined,
): string[] => {
  if (result.status !== 'resolved' || !result.url) return [];

  // 所有平台与来源统一经过最终水印过滤，解析器的来源证明不能绕过归档闸门。
  return normalizeVideoUrls([result.url.trim()]);
};

const BrowserPanel: React.FC<BrowserPanelProps> = ({
  accounts,
  activeAccount,
  refreshKey,
}) => {
  const poolRef = useRef<HTMLDivElement>(null);
  const registryRef = useRef<Map<string, HTMLWebViewElement>>(new Map());
  const loadingMapRef = useRef<Map<string, boolean>>(new Map());
  const runningRef = useRef<Set<string>>(new Set());
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const pendingRestartTasksRef = useRef<Map<string, TaskUpdateInput>>(new Map());
  const pendingCancellationStatusRef = useRef<Map<string, 'paused' | 'cancelled'>>(new Map());
  const manualVideoUsageRef = useRef<Set<string>>(new Set());
  const submissionReconcileRef = useRef<Set<string>>(new Set());
  const submissionReconcileUsageRef = useRef<Set<string>>(new Set());
  const manualArtifactRecoveryRef = useRef<Set<string>>(new Set());
  /** 防止同一 waiting_verification 任务被可用性轮询重复恢复。 */
  const verificationRecoveryRef = useRef<Set<string>>(new Set());
  /** 每个账号需要连续两次 ready 探测后才触发自动恢复，过滤瞬时误判。 */
  const verificationReadyStreakRef = useRef<Record<string, number>>({});
  /** 避免恢复轮询在同一账号上重叠执行。 */
  const verificationProbeRef = useRef<Set<string>>(new Set());
  const availabilityRequestHandledRef = useRef<Record<string, number>>({});
  const availabilityProbeSequenceRef = useRef<Record<string, number>>({});
  /** Manual checks keep their hidden WebViews resident until the bounded probe completes. */
  const manualAvailabilityProbeRef = useRef<Set<string>>(new Set());
  const manualAvailabilityRunningRef = useRef<Set<string>>(new Set());
  /** 启动期后台巡检一次只保留一个临时 Webview，完成后立即释放。 */
  const backgroundProbeRef = useRef<Set<string>>(new Set());
  const backgroundAuditedRef = useRef<Set<string>>(new Set());
  /** 当前预热完成后直接唤醒下一账号；定时轮询仅作为 Electron 漏事件兜底。 */
  const advanceBackgroundWarmupRef = useRef<() => void>(() => undefined);
  /** 每个账号的 webview 监听器与定时器作用域。 */
  const resourceScopesRef = useRef<Map<string, WebviewResourceScope>>(new Map());
  /** 仅用于闲置 WebView 的 LRU 回收；不影响持久化 Session。 */
  const webviewLastUsedAtRef = useRef<Record<string, number>>({});
  const MAX_RESIDENT_IDLE_WEBVIEWS = 4;
  const MAX_CONCURRENT_MANUAL_AVAILABILITY_PROBES = 2;

  const [activeLoading, setActiveLoading] = useState(true);
  const [loadText, setLoadText] = useState('加载豆包中...');
  /** webview 注册完成时递增，确保已预留的任务会在页面实例出现后重新路由。 */
  const [webviewEpoch, setWebviewEpoch] = useState(0);
  const [manualAvailabilityEpoch, setManualAvailabilityEpoch] = useState(0);
  const [manualVideoExtracting, setManualVideoExtracting] = useState(false);
  const [publicShareDialogOpen, setPublicShareDialogOpen] = useState(false);
  const [publicShareUrl, setPublicShareUrl] = useState('');
  const [experimentalNoWatermark, setExperimentalNoWatermark] = useState<boolean>(() => isExperimentalNoWatermarkEnabled());

  /** 实验直取默认关闭；开启时明确提示平台条款与账号风控风险。 */
  const toggleExperimentalNoWatermark = (enabled: boolean): void => {
    if (!enabled) {
      setExperimentalNoWatermarkEnabled(false);
      setExperimentalNoWatermark(false);
      return;
    }
    Modal.confirm({
      title: '开启实验模式：直接提取源文件？',
      content:
        '该模式在豆包官方未开放无水印下载时，尝试从当前对话直接提取源文件。' +
        '可能违反平台条款或触发账号风控，结果也可能仍含水印或无法播放。' +
        '仅对手动提取生效，自动任务不受影响。确定开启？',
      okText: '知晓风险，开启',
      cancelText: '取消',
      onOk: () => {
        setExperimentalNoWatermarkEnabled(true);
        setExperimentalNoWatermark(true);
        message.warning('实验模式已开启，仅手动提取会使用实验通道');
      },
    });
  };

  const accountBusy = useTaskStore((s) => s.accountBusy);
  const accountAutoState = useTaskStore((s) => s.accountAutomationState);
  const accountAutoMsg = useTaskStore((s) => s.accountAutoMessage);
  const executingTasks = useTaskStore((s) => s.executingTasks);
  const tasks = useTaskStore((s) => s.tasks);
  const availabilityCheckRequests = useAccountStore((s) => s.availabilityCheckRequests);

  /**
   * 人工验证消失后的安全恢复：未留下提交意图的任务保留原账号绑定并重新入队，
   * 由当前账号对应的 WebView 自动重新发送；已经提交的任务只触发原会话只读核对。
   * 两条路径都不改写平台请求；已确认提交的任务绝不再次点击发送。
   */
  const recoverWaitingVerificationTasks = useCallback(async (
    accountId: string,
    webview: HTMLWebViewElement,
  ): Promise<void> => {
    if (registryRef.current.get(accountId) !== webview) return;
    const account = useAccountStore.getState().accounts.find((item) => item.id === accountId);
    const waitingTasks = useTaskStore.getState().tasks.filter((task) => {
      if (task.status !== 'waiting_verification' || task.assignedAccountId !== accountId) return false;
      return decideVerificationRecovery({
        status: task.status,
        errorCode: task.errorInfo?.code,
        submittedAt: task.runtime?.submittedAt,
        submissionConfirmedAt: task.runtime?.submissionConfirmedAt,
        submissionIntentAt: task.runtime?.submissionIntentAt,
        humanVerificationRetryCount: task.runtime?.humanVerificationRetryCount,
        attempt: task.runtime?.attempt,
       }) !== 'none';
    });

    for (const task of waitingTasks) {
      const decision = decideVerificationRecovery({
        status: task.status,
        errorCode: task.errorInfo?.code,
        submittedAt: task.runtime?.submittedAt,
        submissionConfirmedAt: task.runtime?.submissionConfirmedAt,
        submissionIntentAt: task.runtime?.submissionIntentAt,
        humanVerificationRetryCount: task.runtime?.humanVerificationRetryCount,
        attempt: task.runtime?.attempt,
      });
      if (decision === 'none' || verificationRecoveryRef.current.has(task.id)) continue;
      // 已有专用只读核对在运行时，不再派发重复事件。
      if (decision === 'reconcile_submitted' && submissionReconcileRef.current.has(task.id)) continue;
      if (decision === 'reconcile_submitted' && !task.runtime?.conversationUrl) {
        console.warn(`[BrowserPanel] 任务 ${task.id} 缺少原会话地址，暂不自动核对`);
        continue;
      }

      verificationRecoveryRef.current.add(task.id);
      if (decision === 'retry_unsubmitted') {
        try {
          const latest = useTaskStore.getState().tasks.find((item) => item.id === task.id);
          // 当前窗口恢复必须保持原账号绑定；如果 WebView 已被替换或任务被
          // 其他流程改派，放弃本次自动重试，避免把提示词发到错误会话。
          if (
            latest?.assignedAccountId !== accountId
            || registryRef.current.get(accountId) !== webview
          ) {
            console.warn(`[BrowserPanel] 人机验证恢复取消：任务 ${task.id} 已不再绑定当前账号窗口`);
            continue;
          }
          if (decideVerificationRecovery({
            status: latest?.status,
            errorCode: latest?.errorInfo?.code,
            submittedAt: latest?.runtime?.submittedAt,
            submissionConfirmedAt: latest?.runtime?.submissionConfirmedAt,
            submissionIntentAt: latest?.runtime?.submissionIntentAt,
            humanVerificationRetryCount: latest?.runtime?.humanVerificationRetryCount,
            attempt: latest?.runtime?.attempt,
          }) !== 'retry_unsubmitted') continue;
          const isHumanVerification = latest?.errorInfo?.code === 'human_verification';
          if (isHumanVerification) {
            const retryCount = latest?.runtime?.humanVerificationRetryCount || 0;
            const marked = await useTaskStore.getState().updateTaskRuntime(task.id, {
              runtime: { humanVerificationRetryCount: retryCount + 1 },
            });
            if (!marked) {
              console.warn(`[BrowserPanel] 人机验证后的同账号自动重试标记失败: ${task.id}`);
              continue;
            }
          }
          const retried = await useTaskStore.getState().retryTask(task.id);
          if (retried) {
            const recoveryLabel = isHumanVerification
              ? '人机验证已完成，当前窗口将自动重发提示词'
              : '页面已就绪';
            message.success(`${account?.name || '账号'}：${recoveryLabel}，任务已自动恢复`);
          } else {
            console.warn(`[BrowserPanel] 页面已恢复，但任务 ${task.id} 未能重新入队`);
          }
        } finally {
          verificationRecoveryRef.current.delete(task.id);
        }
        continue;
      }

      // 可用性探测只看页面层证据；在派发只读核对前再确认一次当前页没有
      // 仍可见的验证层，避免瞬时 ready 或残留状态造成过早分流。
      try {
        const inspection = await inspectPostSubmitGenerationState(webview);
        if (inspection.verificationVisible && !hasPostSubmitGenerationEvidence(inspection)) {
          verificationRecoveryRef.current.delete(task.id);
          continue;
        }
        const latest = useTaskStore.getState().tasks.find((item) => item.id === task.id);
        if (decideVerificationRecovery({
          status: latest?.status,
          errorCode: latest?.errorInfo?.code,
          submittedAt: latest?.runtime?.submittedAt,
          submissionConfirmedAt: latest?.runtime?.submissionConfirmedAt,
          submissionIntentAt: latest?.runtime?.submissionIntentAt,
          humanVerificationRetryCount: latest?.runtime?.humanVerificationRetryCount,
          attempt: latest?.runtime?.attempt,
        }) !== 'reconcile_submitted') {
          verificationRecoveryRef.current.delete(task.id);
          continue;
        }
        // 该事件处理器在同步段会先登记 submissionReconcileRef，再开始异步回读；
        // 因而这里可以安全地保持原任务状态，不会触发新的发送动作。
        message.info(`${account?.name || '账号'}：人机验证已完成，正在只读核对原会话`);
        window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id } }));
      } catch (error: unknown) {
        verificationRecoveryRef.current.delete(task.id);
        console.warn('[BrowserPanel] 人机验证恢复前只读复核失败：', error);
      }
    }
  }, []);

  /** 真实读取指定账号当前页面并持久化可用性；不读取 Cookie 或页面内部身份数据。 */
  const performAvailabilityCheck = useCallback(async (
    accountId: string,
    webview: HTMLWebViewElement,
    source: AccountAvailabilitySource,
  ): Promise<AccountAvailability> => {
    const accountState = useAccountStore.getState();
    const account = accountState.accounts.find((item) => item.id === accountId);
    if (!account) {
      return {
        state: 'unavailable', reason: 'account_missing', message: '账号不存在',
        checkedAt: new Date().toISOString(), source,
      };
    }
    accountState.setAvailabilityChecking(accountId, true);
    const sequence = (availabilityProbeSequenceRef.current[accountId] || 0) + 1;
    availabilityProbeSequenceRef.current[accountId] = sequence;
    try {
      const bounded = await runBoundedAvailabilityCheck({
        webview,
        platform: account.platform || 'doubao',
        source,
        persist: async (nextAvailability) => {
          // 探测 Promise 可能在刷新/重建后才返回；旧 WebView 或旧序列不得
          // 覆盖当前账号状态，也不得据此推进任务队列。
          if (
            registryRef.current.get(accountId) !== webview ||
            availabilityProbeSequenceRef.current[accountId] !== sequence
          ) return false;
          return useAccountStore.getState().setAccountAvailability(accountId, nextAvailability);
        },
      });
      const availability = bounded.availability;
      // webview 被刷新/删除时丢弃旧实例的迟到结果。
      if (
        registryRef.current.get(accountId) !== webview ||
        availabilityProbeSequenceRef.current[accountId] !== sequence
      ) return availability;
      if (!bounded.persisted) {
        console.warn(`[BrowserPanel] ${accountId} 可用性状态未能在有界时间内写回，停止队列推进`);
        return availability;
      }
      if (availability.state === 'ready') {
        const waitingRecoveryTasks = useTaskStore.getState().tasks.some((task) =>
          task.assignedAccountId === accountId && decideVerificationRecovery({
            status: task.status,
            errorCode: task.errorInfo?.code,
            submittedAt: task.runtime?.submittedAt,
            submissionConfirmedAt: task.runtime?.submissionConfirmedAt,
            submissionIntentAt: task.runtime?.submissionIntentAt,
            humanVerificationRetryCount: task.runtime?.humanVerificationRetryCount,
            attempt: task.runtime?.attempt,
          }) !== 'none',
        );
        if (waitingRecoveryTasks) {
          const nextStreak = (verificationReadyStreakRef.current[accountId] || 0) + 1;
          verificationReadyStreakRef.current[accountId] = nextStreak;
          if (nextStreak >= 2) {
            // 本次恢复只读/重排队完成后，要求下一次真实非 ready → ready
            // 转换才允许再次触发，避免低频心跳重复派发。
            verificationReadyStreakRef.current[accountId] = 0;
            void recoverWaitingVerificationTasks(accountId, webview).catch((error: unknown) => {
              console.warn(`[BrowserPanel] ${accountId} 验证恢复检查失败:`, error);
            });
          }
        } else {
          delete verificationReadyStreakRef.current[accountId];
        }
        setTimeout(() => useTaskStore.getState().processQueue(), 0);
      } else {
        delete verificationReadyStreakRef.current[accountId];
      }
      const batch = useAccountStore.getState().availabilityBatchCheck;
      const belongsToRunningBatch = batch.running && Boolean(batch.requestIds[accountId]);
      if (source === 'manual' && !belongsToRunningBatch) {
        if (availability.state === 'ready') message.success(`${account.name}：检测通过，可执行自动化`);
        else message.warning(`${account.name}：${availability.message}`);
      }
      return availability;
    } finally {
      if (availabilityProbeSequenceRef.current[accountId] === sequence) {
        useAccountStore.getState().setAvailabilityChecking(accountId, false);
      }
    }
  }, [recoverWaitingVerificationTasks]);

  /** 启动探测完成后合并提醒，避免多账号逐条弹窗轰炸用户。 */
  const availabilityAlertSignature = accounts
    .filter((account) => ['action_required', 'login_required', 'unavailable'].includes(account.health?.availability?.state || ''))
    .map((account) => `${account.id}:${account.health?.availability?.state}:${account.health?.availability?.reason}`)
    .sort()
    .join('|');
  useEffect(() => {
    const timer = setTimeout(() => {
      const blocked = useAccountStore.getState().accounts.filter((account) =>
        ['action_required', 'login_required', 'unavailable'].includes(account.health?.availability?.state || ''),
      );
      if (blocked.length === 0) {
        notification.destroy('account-availability-summary');
        return;
      }
      const preview = blocked.slice(0, 4).map((account) =>
        `${account.name}：${account.health?.availability?.message || '需要处理'}`,
      ).join('；');
      notification.warning({
        key: 'account-availability-summary',
        message: `${blocked.length} 个账号需要处理`,
        description: `${preview}${blocked.length > 4 ? `；另有 ${blocked.length - 4} 个` : ''}。点击左侧账号进入对应页面处理。`,
        duration: 0,
        placement: 'topRight',
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [availabilityAlertSignature]);

  const extractVideoOutputs = async (
    webview: HTMLWebViewElement,
    conversationUrl?: string,
    signal?: AbortSignal,
    captureToken?: string,
    platform?: AccountPlatform,
  ): Promise<string[]> => {
    // 使用结构化解析器，优先获取平台明确返回的原始媒体地址
    const result = await resolveVideoArtifact(webview, {
      conversationUrl: conversationUrl || webview.getURL(),
      timeoutMs: 12000,
      requireWithoutWatermark: true,
      captureToken,
      signal,
    });
    if (result.status === 'resolved' && result.url) {
      console.log(`[extractVideoOutputs] 解析成功，来源: ${result.source}, vid: ${result.vid || 'N/A'}`);
      return normalizeResolvedVideoOutput(result, platform);
    }
    console.warn(`[extractVideoOutputs] 解析失败: ${result.status} - ${result.reason}`);
    return [];
  };

  const activeAutoState: AutomationState | undefined = activeAccount
    ? accountAutoState[activeAccount.id]
    : undefined;
  const activeAutoMsg = activeAccount ? (accountAutoMsg[activeAccount.id] || '') : '';

  // ---- 组件卸载时清理所有 webview 资源与执行控制器 ----
  useEffect(() => {
    const resourceScopes = resourceScopesRef.current;
    const registry = registryRef.current;
    const loadingMap = loadingMapRef.current;
    const controllers = abortControllersRef.current;
    const runningAccounts = runningRef.current;
    return () => {
      for (const [taskId, controller] of controllers) {
        const reason: AutomationAbortReason = {
          code: 'component_unmounted',
          message: '应用界面重新载入，自动化已安全中止',
        };
        if (!automationEngine.abort(taskId, reason) && !controller.signal.aborted) {
          controller.abort(reason);
        }
      }
      controllers.clear();
      resourceScopes.forEach((scope) => scope.dispose());
      resourceScopes.clear();
      registry.forEach((webview) => webview.remove());
      registry.clear();
      loadingMap.clear();
      runningAccounts.clear();
      console.log('[BrowserPanel] 组件卸载，已清理全部 webview 资源');
    };
  }, []);

  // 已可能提交的任务只能沿原会话只读核对产物，绝不重新注入或点击发送。
  useEffect(() => {
    const handleManualSubmission = async (event: Event): Promise<void> => {
      const detail = (event as CustomEvent<{ taskId: string; conversationUrl?: string; useCurrentPage?: boolean }>).detail;
      const task = useTaskStore.getState().tasks.find((item) => item.id === detail?.taskId);
      if (!task || task.status === 'done' || !task.assignedAccountId) {
        message.error('任务不存在、已完成或尚未绑定账号，不能进入人工提交观察');
        return;
      }
      const currentWebview = registryRef.current.get(task.assignedAccountId);
      const suppliedUrl = detail.conversationUrl?.trim();
      const userConfirmedCurrentUrl = detail.useCurrentPage ? currentWebview?.getURL() : undefined;
      const conversationUrl = suppliedUrl || userConfirmedCurrentUrl || task.runtime?.conversationUrl;
      if (!conversationUrl || !/^https:\/\/www\.doubao\.com\/chat\/[^/?#]+(?:[?#].*)?$/i.test(conversationUrl)) {
        message.error('缺少可验证的豆包具体会话 URL；任务保持原状态，未猜测当前页面');
        return;
      }
      const account = useAccountStore.getState().accounts.find((item) => item.id === task.assignedAccountId);
      if (!account || (account.platform || 'doubao') !== 'doubao') {
        message.error('当前只支持已验证的豆包会话；Dola 尚未完成真实验收');
        return;
      }
      const now = new Date();
      const startedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
      const manualRunId = `manual-${task.id}-${now.getTime()}`;
      const observationMessage = '用户声明已手动提交；正在只读观察原会话，系统不会注入、发送或新建对话';
      await useTaskStore.getState().updateTaskRuntime(task.id, {
        status: 'manual_submission_observing',
        result: observationMessage,
        errorInfo: { code: 'manual_review_required', message: observationMessage, recoverable: true, detectedAt: startedAt },
        runtime: {
          runId: manualRunId,
          attempt: (task.runtime?.attempt || 0) + 1,
          stage: 'manual_submission_observing',
          message: observationMessage,
          startedAt,
          stageStartedAt: startedAt,
          lastHeartbeatAt: startedAt,
          submittedAt: startedAt,
          conversationUrl,
          manualObservation: {
            startedAt,
            expiresAt,
            source: suppliedUrl || userConfirmedCurrentUrl ? 'user_confirmed_url' : 'stored_conversation',
            outcome: 'observing',
          },
          input: {
            prompt: task.prompt,
            mode: task.mode,
            videoConfig: task.videoConfig,
            attachments: [...(task.attachments || [])],
            referenceVideos: [...(task.referenceVideos || [])],
            audioAttachment: task.audioAttachment,
            audioAttachments: [...(task.audioAttachments || [])],
          },
        },
      });
      if (useTaskStore.getState().tasks.find((item) => item.id === task.id)?.status !== 'manual_submission_observing') {
        message.error('人工提交观察状态写入失败；任务保持原状态，未读取或绑定产物');
        return;
      }
      window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id } }));
    };

    const handleSubmissionReconcile = async (event: Event): Promise<void> => {
      const taskId = (event as CustomEvent<{ taskId: string }>).detail?.taskId;
      if (!taskId || submissionReconcileRef.current.has(taskId)) return;
      const task = useTaskStore.getState().tasks.find((item) => item.id === taskId);
      if (!requiresSubmissionReconciliation(task)) {
        verificationRecoveryRef.current.delete(taskId);
        message.warning('该任务没有需要核对的提交记录');
        return;
      }
      const accountId = task?.assignedAccountId;
      const webview = accountId ? registryRef.current.get(accountId) : undefined;
      const storedConversationUrl = task?.runtime?.conversationUrl;
      if (!task || !accountId || !webview || !storedConversationUrl) {
        verificationRecoveryRef.current.delete(taskId);
        message.error('缺少原账号页面或原对话地址，已保持暂停且未重新发送');
        return;
      }
      const reconciliationPlatform = useAccountStore.getState().accounts
        .find((account) => account.id === accountId)?.platform || task.targetPlatform;

      const isManualObservation = task.status === 'manual_submission_observing';
      const isSubmittedVerificationRecovery = decideVerificationRecovery({
        status: task.status,
        errorCode: task.errorInfo?.code,
        submittedAt: task.runtime?.submittedAt,
        submissionConfirmedAt: task.runtime?.submissionConfirmedAt,
        submissionIntentAt: task.runtime?.submissionIntentAt,
        humanVerificationRetryCount: task.runtime?.humanVerificationRetryCount,
        attempt: task.runtime?.attempt,
      }) === 'reconcile_submitted';
      const observationController = new AbortController();
      abortControllersRef.current.set(taskId, observationController);
      submissionReconcileRef.current.add(taskId);
      try {
        useAccountStore.getState().selectAccount(accountId);
        if (isSubmittedVerificationRecovery) {
          const recoveryMessage = task.errorInfo?.code === 'human_verification'
            ? '人机验证已完成，正在只读核对原会话（不会重新发送）'
            : '应用已恢复，正在只读续查原 Dola 会话（不会重新发送）';
          const promoted = await useTaskStore.getState().updateTaskRuntime(taskId, {
            status: 'generating',
            result: recoveryMessage,
            errorInfo: null,
            runtime: {
              stage: 'generating',
              message: recoveryMessage,
              lastHeartbeatAt: new Date().toISOString(),
            },
          });
          if (!promoted) throw new Error('验证已完成，但只读核对状态写入失败');
        }
        useTaskStore.getState().setAccountAutomationState(accountId, 'generating', '正在核对平台结果（不会重新发送）...');
        const currentUrl = webview.getURL();
        // 只允许回到台账在原提交链中保存的会话 URL。即使同账号 WebView 当前停在
        // 另一个具体会话，也不得把它猜作目标会话，避免错绑产物或间接放开重发。
        const conversationUrl = storedConversationUrl;
        if (currentUrl !== conversationUrl) {
          webview.loadURL(conversationUrl);
        }
        // loadURL 是异步导航；旧实现立即读取会误读上一页并判失败。轮询只读取
        // URL/会话文本，不触发任何点击、键盘或表单动作。
        let conversationMatched = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          if (webview.getURL() === conversationUrl) {
            const conversationText = await getConversationText(webview);
            if (matchesSubmissionConversation(task.prompt, conversationText)) {
              conversationMatched = true;
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!conversationMatched) {
          throw new Error('原对话未同时匹配任务提示词前缀与平台提交回执，无法安全绑定结果');
        }
        // 豆包恢复旧会话时会先渲染历史确认消息，再异步恢复最终视频卡片。
        // 先短时解析现有产物，避免旧确认消息在视频恢复前抢先截断只读回收。
        const preResolvedArtifact = (reconciliationPlatform || 'doubao') === 'doubao'
          ? await resolveVideoArtifact(webview, {
            conversationUrl,
            timeoutMs: 12_000,
            isManual: true,
            requireWithoutWatermark: true,
            signal: observationController.signal,
          })
          : undefined;
        const preResolvedOutputs = preResolvedArtifact
          ? normalizeResolvedVideoOutput(preResolvedArtifact, reconciliationPlatform)
          : [];
        const generationState = await inspectPostSubmitGenerationState(webview);
        const latestAssistantReply = (reconciliationPlatform || 'doubao') === 'doubao'
          ? await getLatestAssistantReply(webview)
          : '';
        const hasCurrentGenerationEvidence = preResolvedOutputs.length > 0
          || hasPostSubmitGenerationEvidence(generationState)
          || isDoubaoVideoCompletedReply(latestAssistantReply);
        const confirmation = hasCurrentGenerationEvidence
          ? null
          : await inspectGenerationConfirmation(webview);
        if (confirmation?.state === 'present') {
          const waitingMessage = '平台仍在等待视频生成参数确认；请人工确认后再次执行只读回读，系统不会代答或重发';
          await useTaskStore.getState().updateTaskRuntime(taskId, {
            status: 'waiting_generation_confirmation',
            result: waitingMessage,
            errorInfo: { code: 'generation_confirmation_required', message: waitingMessage, recoverable: true, detectedAt: confirmation.detectedAt },
            runtime: {
              stage: 'waiting_generation_confirmation',
              message: waitingMessage,
              lastHeartbeatAt: new Date().toISOString(),
              generationConfirmation: {
                detectedAt: confirmation.detectedAt,
                marker: confirmation.marker || 'confirm_before_generation',
                model: confirmation.model,
                duration: confirmation.duration,
                aspectRatio: confirmation.aspectRatio,
              },
            },
          });
          message.warning(waitingMessage);
          return;
        }
        if (task.status === 'waiting_generation_confirmation') {
          const latestConversationText = await getConversationText(webview);
          const generationStartedAt = await getGenerationStartTime(webview);
          const hasConfirmationReceipt = hasCurrentGenerationEvidence
            || /视频生成已提交|正在生成|生成中|你的视频生成好了/.test(latestConversationText)
            || generationStartedAt > 0;
          if (!hasConfirmationReceipt) {
            const waitingMessage = '确认页已不可见，但尚未取得生成回执；任务继续等待，不会自动重发';
            await useTaskStore.getState().updateTaskRuntime(taskId, {
              status: 'waiting_generation_confirmation',
              result: waitingMessage,
              errorInfo: { code: 'generation_confirmation_required', message: waitingMessage, recoverable: true, detectedAt: new Date().toISOString() },
              runtime: { stage: 'waiting_generation_confirmation', message: waitingMessage, lastHeartbeatAt: new Date().toISOString() },
            });
            message.warning(waitingMessage);
            return;
          }
          await useTaskStore.getState().updateTaskRuntime(taskId, {
            status: 'generating',
            result: '已确认生成，正在只读等待原会话产物',
            runtime: { stage: 'generating', message: '已确认生成，正在只读等待原会话产物', lastHeartbeatAt: new Date().toISOString() },
          });
        }
        // 自动回收和人工复检都只绑定平台明确提供的无水印产物，禁止回落到
        // 普通播放流，否则豆包归档会重新带上“豆包生成”水印。
        const resolution = preResolvedOutputs.length > 0 && preResolvedArtifact
          ? preResolvedArtifact
          : await resolveVideoArtifact(webview, {
            conversationUrl,
            // 人工验证恢复后，生成可能才刚刚开始；沿用确认页/人工观察的长窗口，
            // 避免 30 秒视频在正常生成期间被 45 秒短窗口误判为未产出。
            timeoutMs: isSubmittedVerificationRecovery || task.status === 'waiting_generation_confirmation' || isManualObservation
              ? 15 * 60_000
              : 45_000,
            isManual: true,
            requireWithoutWatermark: true,
            signal: observationController.signal,
          });
        const outputs = preResolvedOutputs.length > 0
          ? preResolvedOutputs
          : normalizeResolvedVideoOutput(resolution, reconciliationPlatform);
        if (outputs.length === 0) {
          const pendingMessage = isManualObservation
            ? `人工提交观察已到达本轮上限，仍未读取到唯一匹配产物；请人工复核（${formatResolutionMessage(resolution)}）`
            : `平台已确认提交，暂未读取到产物；请稍后再次核对（${formatResolutionMessage(resolution)}）`;
          await useTaskStore.getState().updateTaskRuntime(taskId, {
            status: 'paused',
            result: pendingMessage,
            errorInfo: { code: isManualObservation ? 'manual_review_required' : 'submission_uncertain', message: pendingMessage, recoverable: true, detectedAt: new Date().toISOString() },
            runtime: {
              stage: 'paused', message: pendingMessage, lastHeartbeatAt: new Date().toISOString(),
              manualObservation: isManualObservation && task.runtime?.manualObservation ? {
                ...task.runtime.manualObservation, lastCheckedAt: new Date().toISOString(), outcome: 'manual_review',
              } : task.runtime?.manualObservation,
            },
          });
          verificationRecoveryRef.current.delete(taskId);
          message.warning(pendingMessage);
          return;
        }
        await useTaskStore.getState().completeAutomation(taskId, accountId, outputs[0], outputs);
        if (!submissionReconcileUsageRef.current.has(taskId)) {
          submissionReconcileUsageRef.current.add(taskId);
          const quota = useAccountStore.getState().accounts.find((account) => account.id === accountId)?.seedanceQuota;
          await useAccountStore.getState().recordSeedanceUsage(accountId, getVideoQuotaUsageUnits(task.videoConfig?.duration, quota));
        }
        await useAccountStore.getState().recordAccountOutcome(accountId, 'success');
        message.success('平台产物核对成功，任务台账已恢复完成；未重新发送');
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        const isManualObservation = task?.status === 'manual_submission_observing';
        const pauseMessage = `核对未完成：${reason}；任务保持暂停，未重新发送`;
        await useTaskStore.getState().updateTaskRuntime(taskId, {
          status: 'paused',
          result: pauseMessage,
          errorInfo: { code: isManualObservation ? 'manual_review_required' : 'submission_uncertain', message: pauseMessage, recoverable: true, detectedAt: new Date().toISOString() },
          runtime: {
            stage: 'paused', message: pauseMessage, lastHeartbeatAt: new Date().toISOString(),
            manualObservation: isManualObservation && task.runtime?.manualObservation ? {
              ...task.runtime.manualObservation, lastCheckedAt: new Date().toISOString(), outcome: 'manual_review',
            } : task.runtime?.manualObservation,
          },
        });
        message.error(pauseMessage);
      } finally {
        if (abortControllersRef.current.get(taskId) === observationController) {
          abortControllersRef.current.delete(taskId);
        }
        submissionReconcileRef.current.delete(taskId);
        verificationRecoveryRef.current.delete(taskId);
        useTaskStore.getState().setAccountAutomationState(accountId, 'idle', '');
      }
    };

    const handleManualArtifactRecovery = async (event: Event): Promise<void> => {
      const taskId = (event as CustomEvent<{ taskId: string }>).detail?.taskId;
      if (!taskId || manualArtifactRecoveryRef.current.has(taskId)) return;
      const task = useTaskStore.getState().tasks.find((item) => item.id === taskId);
      const accountId = task?.assignedAccountId;
      if (
        !task
        || task.mode !== 'video'
        || !accountId
        || !(task.runtime?.submittedAt || task.runtime?.submissionConfirmedAt)
        || !task.runtime?.conversationUrl
      ) {
        message.error('该任务缺少已提交记录、绑定账号或原会话地址，不能安全识别视频');
        return;
      }

      manualArtifactRecoveryRef.current.add(taskId);
      try {
        useAccountStore.getState().selectAccount(accountId);
        const controller = abortControllersRef.current.get(taskId);
        const taskIsRunning = automationEngine.isReserved(taskId)
          || !!controller
          || !!useTaskStore.getState().accountBusy[accountId];
        if (taskIsRunning) {
          const reason: AutomationAbortReason = {
            code: 'user_pause',
            message: '用户发起手动视频回收，正在停止自动等待',
          };
          pendingCancellationStatusRef.current.set(taskId, 'paused');
          const abortedByEngine = automationEngine.abort(taskId, reason);
          if (!abortedByEngine && controller && !controller.signal.aborted) controller.abort(reason);
          message.info('正在停止当前自动等待，释放账号后将只读识别原会话视频...');

          const releaseDeadline = Date.now() + 15_000;
          while (Date.now() < releaseDeadline) {
            const state = useTaskStore.getState();
            if (
              !automationEngine.isReserved(taskId)
              && !abortControllersRef.current.has(taskId)
              && !state.accountBusy[accountId]
            ) break;
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
          }
        }

        const state = useTaskStore.getState();
        const refreshedTask = state.tasks.find((item) => item.id === taskId);
        if (refreshedTask?.status === 'done') {
          message.success('任务已经完成并回传，无需再次识别');
          return;
        }
        if (
          automationEngine.isReserved(taskId)
          || abortControllersRef.current.has(taskId)
          || state.accountBusy[accountId]
        ) {
          message.error('任务执行锁在 15 秒内未释放，已停止手动识别，避免并发操作同一会话');
          return;
        }
        if (!requiresSubmissionReconciliation(refreshedTask)) {
          message.error('任务未进入可安全回读状态，未识别视频，也未重新发送提示词');
          return;
        }

        window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId } }));
      } finally {
        manualArtifactRecoveryRef.current.delete(taskId);
      }
    };
    window.addEventListener('mark-manual-submission', handleManualSubmission);
    window.addEventListener('reconcile-task-submission', handleSubmissionReconcile);
    window.addEventListener('recover-task-video-artifact', handleManualArtifactRecovery);
    return () => {
      window.removeEventListener('mark-manual-submission', handleManualSubmission);
      window.removeEventListener('reconcile-task-submission', handleSubmissionReconcile);
      window.removeEventListener('recover-task-video-artifact', handleManualArtifactRecovery);
    };
  }, []);

  /** 幂等释放指定账号的 webview、监听器和定时器。 */
  const disposeAccountWebview = (accountId: string): void => {
    const state = useTaskStore.getState();
    const taskIds = new Set(
      state.tasks
        .filter((task) => task.assignedAccountId === accountId)
        .map((task) => task.id),
    );
    const executingTaskId = state.executingTasks[accountId];
    if (executingTaskId) taskIds.add(executingTaskId);
    for (const taskId of taskIds) {
      const reason: AutomationAbortReason = {
        code: 'webview_disposed',
        message: '账号页面已关闭，自动化已安全中止',
      };
      const controller = abortControllersRef.current.get(taskId);
      if (!automationEngine.abort(taskId, reason) && controller && !controller.signal.aborted) {
        controller.abort(reason);
      }
      abortControllersRef.current.delete(taskId);
    }
    resourceScopesRef.current.get(accountId)?.dispose();
    resourceScopesRef.current.delete(accountId);
    manualAvailabilityProbeRef.current.delete(accountId);
    manualAvailabilityRunningRef.current.delete(accountId);
    const webview = registryRef.current.get(accountId);
    if (webview) {
      webview.remove();
      registryRef.current.delete(accountId);
    }
    loadingMapRef.current.delete(accountId);
    runningRef.current.delete(accountId);
    delete webviewLastUsedAtRef.current[accountId];
  };

  /** 仅释放后台预热页，不触碰任务锁或任务状态；persist 分区会保留 CK/Cookie。 */
  const releaseBackgroundWebview = (accountId: string): void => {
    resourceScopesRef.current.get(accountId)?.dispose();
    resourceScopesRef.current.delete(accountId);
    manualAvailabilityProbeRef.current.delete(accountId);
    manualAvailabilityRunningRef.current.delete(accountId);
    const webview = registryRef.current.get(accountId);
    if (webview) {
      webview.remove();
      registryRef.current.delete(accountId);
    }
    loadingMapRef.current.delete(accountId);
    runningRef.current.delete(accountId);
    delete webviewLastUsedAtRef.current[accountId];
    setWebviewEpoch((value) => value + 1);
    console.log(`[BrowserPanel] 后台预热完成，已释放临时 webview: ${accountId}`);
  };

  // ---- webview 池动态管理（账号增删同步） ----
  /** 只回收闲置页面，保留其 persist 分区中的 CK/Cookie/Storage。 */
  const evictIdleWebviews = (): void => {
    const state = useTaskStore.getState();
    const selectedId = useAccountStore.getState().selectedAccountId;
    const retainedTaskAccountIds = getTaskWebviewRetentionIds(state.tasks);
    const evictIds = getIdleWebviewEvictionIds(
      [...registryRef.current.keys()],
      selectedId,
      state.executingTasks,
      webviewLastUsedAtRef.current,
      MAX_RESIDENT_IDLE_WEBVIEWS,
      new Set([
        ...backgroundProbeRef.current,
        ...manualAvailabilityProbeRef.current,
        ...retainedTaskAccountIds,
      ]),
    );
    if (evictIds.length === 0) return;
    for (const accountId of evictIds) {
      releaseBackgroundWebview(accountId);
      console.log('[BrowserPanel] 闲置 WebView 已回收: ' + accountId);
    }
  };

  // ---- webview 池动态管理（账号增删同步） ----
  const accountsKey = accounts.map(a => a.id).join(',');
  const retainedTaskAccountIds = getTaskWebviewRetentionIds(tasks);
  const retainedTaskAccountKey = [...retainedTaskAccountIds].sort().join(',');
  useEffect(() => {
    const container = poolRef.current;
    if (!container) return;

    const accountIds = new Set(accounts.map(a => a.id));

    // 清理已删除账号的 webview 和定时器
    registryRef.current.forEach((webview, accountId) => {
      if (!accountIds.has(accountId)) {
        disposeAccountWebview(accountId);
        console.log(`[BrowserPanel] 已移除账号 ${accountId} 的 webview`);
      }
    });

    // 用户快速切换账号时，只保留最后选择的前台加载。没有执行任务的旧加载页
    // 立即释放，防止多个 Chromium 导航同时堆积并拖死 NetworkService。
    const loadingIds = new Set(
      [...loadingMapRef.current.entries()]
        .filter(([, loading]) => loading)
        .map(([accountId]) => accountId),
    );
    const supersededIds = getSupersededLoadingAccountIds(
      [...registryRef.current.keys()],
      loadingIds,
      activeAccount?.id || null,
      executingTasks,
      new Set([...retainedTaskAccountIds, ...manualAvailabilityProbeRef.current]),
    );
    for (const accountId of supersededIds) {
      backgroundProbeRef.current.delete(accountId);
      disposeAccountWebview(accountId);
    }

    // 启动时只挂载当前账号，避免十几个账号同时访问平台后留下黑屏。
    // 已经进入执行态的后台账号必须同时挂载；其余账号在用户切换时按需创建。
    const hydrationIds = getWebviewHydrationAccountIds(
      accounts,
      activeAccount?.id || null,
      executingTasks,
      retainedTaskAccountIds,
    );
    evictIdleWebviews();
    for (const accountId of hydrationIds) {
      const account = accounts.find((item) => item.id === accountId);
      if (account) createWebview(account, container);
    }

    // 确保当前活跃账号的加载状态同步
    if (activeAccount) {
      const isLoading = loadingMapRef.current.get(activeAccount.id);
      setActiveLoading(!!isLoading);
      if (!isLoading) setLoadText('');
      console.log(`[BrowserPanel] webview 池同步完成 (当前 ${registryRef.current.size} 个), activeAccount=${activeAccount.id}, isLoading=${isLoading}`);
    } else {
      console.log(`[BrowserPanel] webview 池同步完成 (当前 ${registryRef.current.size} 个), 无活跃账号`);
    }
  }, [accountsKey, refreshKey, activeAccount?.id, executingTasks, retainedTaskAccountKey]);

  // ---- 创建单个 webview ----
  const createWebview = (account: Account, container: HTMLDivElement) => {
    if (registryRef.current.has(account.id)) return;

    const accId = account.id;
    const scope = createWebviewResourceScope();
    resourceScopesRef.current.set(accId, scope);
    loadingMapRef.current.set(accId, true);
    webviewLastUsedAtRef.current[accId] = Date.now();

    const webview = document.createElement('webview') as HTMLWebViewElement;
    // partition 必须在首次导航前固定；先设置隔离分区，再设置地址。
    webview.setAttribute('partition', getAccountSessionPartition(account));
    webview.setAttribute('src', getAccountHome(account));
    webview.setAttribute('allowpopups', 'true');
    webview.style.cssText = 'width:100%;height:100%;border:none;position:absolute;top:0;left:0;visibility:visible;';
    // 首次创建发生在 hydration effect 内；不要等待另一个 effect 才激活当前页，
    // 否则 guest 可能以透明状态启动并被 Chromium 延迟合成或加载。
    applyWebviewActivationStyle(
      webview.style,
      useAccountStore.getState().selectedAccountId === accId,
    );

    let pollInterval: ReturnType<typeof setInterval> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let availabilityTimer: ReturnType<typeof setTimeout> | undefined;
    let availabilitySettleTimer: ReturnType<typeof setTimeout> | undefined;
    let availabilityFinalTimer: ReturnType<typeof setTimeout> | undefined;
    let warmupReleaseTimer: ReturnType<typeof setTimeout> | undefined;
    let loadRecoveryState = { windowStartedAt: 0, attempts: 0 };
    // 同一 WebView 的导航、稳定化和手动检测可能同时到达；串行化只读检查，
    // 避免重复触碰页面状态并再次触发 Dola 的推广层。
    let availabilityCheckRunning = false;
    // Dola 启动检查只由本次 WebView 的第一次 dom-ready 安排一次；后续
    // 页面导航/重绘不再重新武装计时器，避免可用性写回造成刷新链。
    let dolaStartupAvailabilityScheduled = false;
    // 自动恢复触发的 did-start-loading 不应重新武装恢复次数；
    // 用户手动刷新或代理应用触发的新导航则可开始新的恢复周期。
    let autoRecoveryReloadPending = false;

    const finishBackgroundProbe = (): void => {
      if (!backgroundProbeRef.current.has(accId)) return;
      backgroundProbeRef.current.delete(accId);
      backgroundAuditedRef.current.add(accId);
      const state = useTaskStore.getState();
      const activeId = useAccountStore.getState().selectedAccountId;
      if (shouldReleaseBackgroundWebview(
        accId,
        activeId,
        state.executingTasks,
        true,
        new Set([
          ...getTaskWebviewRetentionIds(state.tasks),
          ...manualAvailabilityProbeRef.current,
        ]),
      )) {
        releaseBackgroundWebview(accId);
      }
      queueMicrotask(() => advanceBackgroundWarmupRef.current());
    };

    const runAvailabilityCheck = async (source: AccountAvailabilitySource): Promise<void> => {
      if (availabilityCheckRunning) {
        console.log(`[BrowserPanel] 跳过重叠的账号可用性检测: ${accId}`);
        return;
      }
      availabilityCheckRunning = true;
      try {
        // “下载电脑版”是豆包专属推广层。Dola 页面不能调用该清理器，
        // 否则会把正常的 Dola 页面误判为清理失败并反复触发检查。
        const currentUrl = typeof webview.getURL === 'function' ? webview.getURL() : '';
        if (account.platform !== 'dola' && !isDolaUrl(currentUrl)) {
          const dismissed = await withTimeout(
            () => dismissKnownDesktopDownloadPromotion(webview),
            5000,
            '推广层清理超时',
          ).catch(() => 'failed' as const);
          if (dismissed === 'failed') {
            console.warn(`[BrowserPanel] ${accId} 下载电脑版推广弹窗未能安全关闭`);
          }
        }
        await performAvailabilityCheck(accId, webview, source);
      } catch (error: unknown) {
        console.warn(`[BrowserPanel] ${accId} 可用性检测未完成:`, error);
      } finally {
        availabilityCheckRunning = false;
      }
    };

    const scheduleAvailabilityCheck = (source: AccountAvailabilitySource, delayMs: number = 600): void => {
      if (manualAvailabilityProbeRef.current.has(accId)) return;
      // Dola 的普通导航可能由平台自己的语言/区域状态触发；不把每次
      // 导航都升级为可用性探测，避免探测写回账号状态后再次抖动页面生命周期。
      // 启动探测、任务门禁和手动检测仍通过 performAvailabilityCheck 保留。
      if (!shouldScheduleAutomaticAvailabilityCheck(account.platform, source)) return;
      if (account.platform === 'dola' && source === 'startup') {
        if (dolaStartupAvailabilityScheduled) return;
        dolaStartupAvailabilityScheduled = true;
      }
      scope.clearTimer(availabilityTimer);
      scope.clearTimer(availabilitySettleTimer);
      scope.clearTimer(availabilityFinalTimer);
      availabilityTimer = setTimeout(() => {
        if (!scope.active || registryRef.current.get(accId) !== webview) return;
        void runAvailabilityCheck(source).catch((error: unknown) => {
          console.warn(`[BrowserPanel] ${accId} 自动可用性检查失败:`, error);
        });
      }, delayMs);
      scope.trackTimer(availabilityTimer);
      // 豆包 SPA 常在 dom-ready 后数秒才渲染“登录”/验证层。第二次稳定化检测
      // 防止把匿名页先出现的输入框误判为已登录。
      availabilitySettleTimer = setTimeout(() => {
        if (!scope.active || registryRef.current.get(accId) !== webview) return;
        void runAvailabilityCheck(source).catch((error: unknown) => {
          console.warn(`[BrowserPanel] ${accId} 稳定化可用性检查失败:`, error);
        });
      }, Math.max(3500, delayMs + 3000));
      scope.trackTimer(availabilitySettleTimer);
      // 多账号同时打开时，隐藏 webview 的账号壳可能需要更长时间才稳定。
      availabilityFinalTimer = setTimeout(() => {
        if (!scope.active || registryRef.current.get(accId) !== webview) return;
        void runAvailabilityCheck(source)
          .catch((error: unknown) => {
            console.warn(`[BrowserPanel] ${accId} 后置可用性检查失败:`, error);
          })
          .finally(finishBackgroundProbe);
      }, Math.max(15_000, delayMs + 12_000));
      scope.trackTimer(availabilityFinalTimer);
    };

    // 统一加载完成处理
    const markLoaded = (evt: string) => {
      if (!scope.active) return;
      if (!loadingMapRef.current.get(accId)) return; // 已标记完成，不重复处理
      loadingMapRef.current.set(accId, false);
      scope.clearTimer(pollInterval);
      scope.clearTimer(timeoutId);
      console.log(`[BrowserPanel] markLoaded: ${accId} via ${evt}`);
      const cur = useAccountStore.getState().selectedAccountId;
      if (accId === cur) {
        setLoadText('正在显示账号页面...');
        void forceWebviewLayoutRepaint(webview).finally(() => {
          if (!scope.active || useAccountStore.getState().selectedAccountId !== accId) return;
          if (loadingMapRef.current.get(accId)) return;
          setActiveLoading(false);
          setLoadText('');
        });
      }
      if (backgroundProbeRef.current.has(accId)) {
        scope.clearTimer(warmupReleaseTimer);
        // 给首轮和稳定化可用性检查留出时间，再释放非活跃后台页；
        // 这样不会因立即卸载而丢失登录状态探测，同时避免长期驻留 renderer。
        warmupReleaseTimer = setTimeout(finishBackgroundProbe, 5000);
        scope.trackTimer(warmupReleaseTimer);
      }
    };

    scope.listen(webview, 'did-start-loading', () => {
      if (!scope.active) return;
      // 稳定窗口内再次导航说明页面尚未真正就绪，禁止提前并发下一账号。
      scope.clearTimer(warmupReleaseTimer);
      loadingMapRef.current.set(accId, true);
      if (!autoRecoveryReloadPending) {
        loadRecoveryState = { windowStartedAt: 0, attempts: 0 };
      }
      const cur = useAccountStore.getState().selectedAccountId;
      if (accId === cur) {
        setActiveLoading(true);
        setLoadText('页面加载中...');
      }
    });

    scope.listen(webview, 'did-finish-load', () => {
      autoRecoveryReloadPending = false;
      loadRecoveryState = { windowStartedAt: 0, attempts: 0 };
      markLoaded('did-finish-load');
      scheduleAvailabilityCheck('navigation');
    });
    scope.listen(webview, 'did-stop-loading', () => { markLoaded('did-stop-loading'); scheduleAvailabilityCheck('navigation'); });
    // 服务器重定向可能绕过页面主世界脚本；只阻止带非中文语言参数的
    // Dola 主文档导航，避免中英文来回跳转。普通导航与用户刷新保持原样。
    scope.listen(webview, 'will-navigate', (rawEvent) => {
      if (account.platform !== 'dola') return;
      const event = rawEvent as Event & { url?: string; preventDefault?: () => void };
      const targetUrl = typeof event.url === 'string' ? event.url : '';
      if (!isDolaNonChineseLocaleNavigation(targetUrl)) return;
      event.preventDefault?.();
      console.warn(`[BrowserPanel] 已阻止 Dola 非中文语言导航: ${accId}`);
    });
    // did-navigate 只代表主文档地址变化，豆包 SPA 此时可能仍是空壳；不能提前撤掉加载层。
    scope.listen(webview, 'did-navigate', () => undefined);
    scope.listen(webview, 'did-navigate-in-page', () => { scheduleAvailabilityCheck('navigation'); });
    scope.listen(webview, 'dom-ready', () => {
      markLoaded('dom-ready');
      // Dola 只在本次 WebView 首次就绪时做一次启动探测；后续导航事件不再
      // 重复安排探测。豆包沿用原有的历史状态分支。
      scheduleAvailabilityCheck(
        account.platform === 'dola' || !account.health?.availability ? 'startup' : 'navigation',
      );
    });
    scope.listen(webview, 'did-fail-load', (rawEvent) => {
      if (!scope.active) return;
      const event = rawEvent as Event & { errorCode?: number; isMainFrame?: boolean };
      // Chromium 导航替换会产生 ERR_ABORTED；子资源失败也不等于主页面不可用。
      if (event.errorCode === -3 || event.isMainFrame === false) return;
      loadingMapRef.current.set(accId, false);
      scope.clearTimers();
      autoRecoveryReloadPending = false;
      const cur = useAccountStore.getState().selectedAccountId;
      if (accId === cur) {
        setActiveLoading(false);
        if (account.platform === 'dola') {
          // Dola 的语言/区域状态异常时，自动 reload 会把失败导航再次放大成
          // 中英文循环刷新。CK 会在启动恢复/重登时先清理旧 Session 再写回，
          // 此处只提示人工处理，不再由渲染层自动 reload。
          setLoadText('Dola 页面加载失败，请清除登录后重登 CK');
          console.warn('[BrowserPanel] Dola 页面失败，已禁止自动重载: ' + accId);
        } else {
          setLoadText('加载失败');
          // 豆包保留原有的有界自动恢复逻辑。
          const recovery = decideWebviewLoadRecovery(loadRecoveryState, Date.now(), 1, Number.POSITIVE_INFINITY);
          loadRecoveryState = recovery.nextState;
          if (recovery.allowed) {
            const recoveryTimer = setTimeout(() => {
              if (!scope.active || registryRef.current.get(accId) !== webview) return;
              if (useAccountStore.getState().selectedAccountId !== accId) return;
              loadingMapRef.current.set(accId, true);
              setActiveLoading(true);
              setLoadText('正在重新加载账号页面...');
              autoRecoveryReloadPending = true;
              webview.reload();
            }, 1200);
            scope.trackTimer(recoveryTimer);
          } else {
            console.warn('[BrowserPanel] 已达到账号页面自动恢复上限，停止重载: ' + accId);
          }
        }
      }
      void useAccountStore.getState().setAccountAvailability(accId, {
        state: 'unavailable',
        reason: 'network_error',
        message: '页面加载失败，请检查网络后重新检测',
        checkedAt: new Date().toISOString(),
        source: 'navigation',
      }).finally(finishBackgroundProbe);
    });

    container.appendChild(webview);
    registryRef.current.set(accId, webview);
    setWebviewEpoch((value) => value + 1);
    console.log(`[BrowserPanel] webview 已创建: ${accId}, src=${webview.getAttribute('src')}, partition=${webview.getAttribute('partition')}, inDOM=${container.contains(webview)}`);

    // 轮询兜底：每 2s 检查一次 webview 是否已加载内容
    // 解决 Electron webview 事件不触发的问题
    let pollRunning = false;
    pollInterval = setInterval(async () => {
      const wv = registryRef.current.get(accId);
      if (!wv || pollRunning) {
        if (!wv) scope.clearTimers();
        return;
      }
      pollRunning = true;
      try {
        const url = wv.getURL?.() || '';
        const isLoaded = loadingMapRef.current.get(accId);
        if (!isLoaded || !url.startsWith('http') || !url.includes(getAccountHost(account))) return;
        const title = (wv as HTMLWebViewElement & { getTitle?: () => string }).getTitle?.() || '';
        if (isWebviewDocumentReady(url, title, getAccountHost(account))) {
          console.log(`[BrowserPanel] 轮询检测到 webview 标题已就绪: ${accId}`);
          markLoaded('poll-title');
          scheduleAvailabilityCheck('navigation');
          return;
        }
        const hasDocument = await Promise.race([
          wv.executeJavaScript(
            'Boolean(document.body && document.body.childElementCount > 0 && document.readyState !== "loading")',
          ),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1200)),
        ]);
        if (hasDocument) {
          console.log(`[BrowserPanel] 轮询检测到 webview 文档已就绪: ${accId}`);
          markLoaded('poll-document');
          scheduleAvailabilityCheck('navigation');
        }
      } catch {
        // guest 尚未允许执行脚本时继续等待正式加载事件。
      } finally {
        pollRunning = false;
      }
    }, 2000);
    scope.trackTimer(pollInterval);

    // 60s 后停止高频轮询，但保留不透明加载层；后续正式加载事件仍可解除。
    timeoutId = setTimeout(() => {
      scope.clearTimer(pollInterval);
      if (!scope.active) return;
      if (loadingMapRef.current.get(accId)) {
        console.warn(`[BrowserPanel] 60s 超时，账号页面仍未形成可用文档: ${accId}`);
        if (manualAvailabilityProbeRef.current.has(accId)) {
          loadingMapRef.current.set(accId, false);
          setManualAvailabilityEpoch((value) => value + 1);
        }
        if (useAccountStore.getState().selectedAccountId === accId) {
          setActiveLoading(true);
          setLoadText('账号页面加载较慢，请稍候或点击刷新');
        }
      }
      scope.clearTimer(timeoutId);
      scope.clearTimer(pollInterval);
    }, 60000);
    scope.trackTimer(timeoutId);
  };

  // 启动后以单通道顺序巡检其余账号。每次只新增一个后台 Webview，完成
  // 稳定化检测后保持常驻；兼顾快速切换和避免 13 个页面同时抢占网络。
  useEffect(() => {
    let disposed = false;
    const startNextWarmup = (): void => {
      if (disposed) return;
      if (manualAvailabilityProbeRef.current.size > 0) return;
      if (useAccountStore.getState().availabilityBatchCheck.running) return;
      if (backgroundProbeRef.current.size > 0) return;
      if ([...loadingMapRef.current.values()].some(Boolean)) return;
      if (Object.values(useTaskStore.getState().accountBusy).some(Boolean)) return;
      const selectedId = useAccountStore.getState().selectedAccountId;
      const candidate = useAccountStore.getState().accounts.find((account) =>
        account.id !== selectedId &&
        shouldWarmupAccount(account) &&
        !registryRef.current.has(account.id) &&
        !backgroundAuditedRef.current.has(account.id) &&
        !useTaskStore.getState().executingTasks[account.id],
      );
      const container = poolRef.current;
      if (!candidate || !container) return;
      backgroundProbeRef.current.add(candidate.id);
      createWebview(candidate, container);
    };

    advanceBackgroundWarmupRef.current = startNextWarmup;
    const initialTimer = setTimeout(startNextWarmup, 0);
    // Electron 偶发漏发 guest load 事件时仍能继续，不把正常路径降级成轮询等待。
    const fallbackInterval = setInterval(startNextWarmup, 1000);
    return () => {
      disposed = true;
      clearTimeout(initialTimer);
      clearInterval(fallbackInterval);
      if (advanceBackgroundWarmupRef.current === startNextWarmup) {
        advanceBackgroundWarmupRef.current = () => undefined;
      }
    };
  }, [accountsKey]);

  // Manual checks use hidden, isolated WebViews and never change selectedAccountId.
  // Two slots keep the renderer responsive while still allowing a real batch check.
  useEffect(() => {
    let disposed = false;

    const completeBatchItem = (
      accountId: string,
      requestId: number,
      needsAttention: boolean,
    ): void => {
      const before = useAccountStore.getState().availabilityBatchCheck;
      useAccountStore.getState().completeAvailabilityBatchCheck(
        accountId,
        requestId,
        needsAttention,
      );
      const after = useAccountStore.getState().availabilityBatchCheck;
      if (before.runId !== after.runId || !before.running || after.running) return;
      if (after.attentionAccountIds.length > 0) {
        message.warning(`批量检测完成：${after.attentionAccountIds.length} 个账号需要处理`);
      } else {
        message.success('批量检测完成：全部账号可用');
      }
    };

    const releaseCompletedProbe = (accountId: string): void => {
      manualAvailabilityRunningRef.current.delete(accountId);
      manualAvailabilityProbeRef.current.delete(accountId);
      const taskState = useTaskStore.getState();
      if (shouldReleaseBackgroundWebview(
        accountId,
        useAccountStore.getState().selectedAccountId,
        taskState.executingTasks,
        true,
        getTaskWebviewRetentionIds(taskState.tasks),
      )) {
        releaseBackgroundWebview(accountId);
      }
      if (!disposed) setManualAvailabilityEpoch((value) => value + 1);
    };

    const scheduleManualChecks = (): void => {
      if (disposed) return;
      const accountState = useAccountStore.getState();
      const candidates = getPendingAvailabilityProbeAccountIds(
        accountState.availabilityCheckRequests,
        availabilityRequestHandledRef.current,
        manualAvailabilityProbeRef.current,
        MAX_CONCURRENT_MANUAL_AVAILABILITY_PROBES,
      );

      for (const accountId of candidates) {
        const requestId = accountState.availabilityCheckRequests[accountId];
        const account = accountState.accounts.find((item) => item.id === accountId);
        const container = poolRef.current;
        if (!account || !container) {
          availabilityRequestHandledRef.current[accountId] = requestId;
          completeBatchItem(accountId, requestId, true);
          continue;
        }

        manualAvailabilityProbeRef.current.add(accountId);
        if (!registryRef.current.has(accountId)) {
          createWebview(account, container);
        }
      }

      for (const accountId of [...manualAvailabilityProbeRef.current]) {
        if (manualAvailabilityRunningRef.current.has(accountId)) continue;
        const latestState = useAccountStore.getState();
        const requestId = latestState.availabilityCheckRequests[accountId] || 0;
        if (!requestId || requestId <= (availabilityRequestHandledRef.current[accountId] || 0)) continue;
        if (latestState.availabilityChecking[accountId]) continue;
        const webview = registryRef.current.get(accountId);
        if (!webview || loadingMapRef.current.get(accountId) !== false) continue;

        availabilityRequestHandledRef.current[accountId] = requestId;
        manualAvailabilityRunningRef.current.add(accountId);
        void performAvailabilityCheck(accountId, webview, 'manual')
          .then((availability) => {
            completeBatchItem(accountId, requestId, availability.state !== 'ready');
          })
          .catch((error: unknown) => {
            console.warn(`[BrowserPanel] ${accountId} 手动可用性检查失败:`, error);
            completeBatchItem(accountId, requestId, true);
          })
          .finally(() => releaseCompletedProbe(accountId));
      }
    };

    scheduleManualChecks();
    const interval = setInterval(scheduleManualChecks, 400);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [
    accountsKey,
    availabilityCheckRequests,
    manualAvailabilityEpoch,
    performAvailabilityCheck,
    webviewEpoch,
  ]);

  // 用户正在查看的页面可能在不导航的情况下弹出验证或完成登录。
  // 低频只读复检可及时更新提醒；任务执行期间由 pre_task/pre_submit 专用门禁接管。
  useEffect(() => {
    const accountId = activeAccount?.id;
    if (!accountId || activeAccount?.platform === 'dola') return;
    const recheck = () => {
      if (useTaskStore.getState().accountBusy[accountId]) return;
      const webview = registryRef.current.get(accountId);
      if (webview) {
        void performAvailabilityCheck(accountId, webview, 'navigation').catch((error: unknown) => {
          console.warn(`[BrowserPanel] ${accountId} 导航可用性检查失败:`, error);
        });
      }
    };
    const initialTimer = setTimeout(recheck, 2000);
    const interval = setInterval(recheck, 30_000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [activeAccount?.id, activeAccount?.platform, performAvailabilityCheck]);

  // waiting_verification 任务需要在用户完成验证后自动恢复。验证层通常只
  // 更新 DOM，不触发导航事件，因此对这类任务单独做低频只读复检；不读取
  // Cookie，不点击验证控件，也不把任务直接标成 queued。
  useEffect(() => {
    const activeVerificationProbes = verificationProbeRef.current;
    const probeWaitingVerification = (): void => {
      const state = useTaskStore.getState();
      const accountIds = new Set(
        state.tasks
          .filter((task) => decideVerificationRecovery({
            status: task.status,
            errorCode: task.errorInfo?.code,
            submittedAt: task.runtime?.submittedAt,
            submissionConfirmedAt: task.runtime?.submissionConfirmedAt,
            submissionIntentAt: task.runtime?.submissionIntentAt,
            humanVerificationRetryCount: task.runtime?.humanVerificationRetryCount,
            attempt: task.runtime?.attempt,
          }) !== 'none')
          .map((task) => task.assignedAccountId)
          .filter((accountId): accountId is string => Boolean(accountId)),
      );
      for (const accountId of accountIds) {
        if (verificationProbeRef.current.has(accountId)) continue;
        // waiting_verification 使用自己的互斥锁。普通检测标记可能来自已失效
        // 的页面探测，不能让用户完成验证码后的原窗口恢复永久停住。
        if (state.accountBusy[accountId]) continue;
        const webview = registryRef.current.get(accountId);
        if (!webview) continue;
        verificationProbeRef.current.add(accountId);
        void performAvailabilityCheck(accountId, webview, 'navigation')
          .catch((error: unknown) => {
            console.warn(`[BrowserPanel] ${accountId} 验证状态检查失败:`, error);
          })
          .finally(() => {
            verificationProbeRef.current.delete(accountId);
          });
      }
    };
    const initialTimer = setTimeout(probeWaitingVerification, 1500);
    const interval = setInterval(probeWaitingVerification, 3000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
      activeVerificationProbes.clear();
    };
  }, [performAvailabilityCheck, webviewEpoch]);

  // 代理配置变更后刷新对应账号页面，使新的 Session 网络出口立即生效。
  useEffect(() => {
    const handleProxyUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<{
        accountId?: string;
        platform?: string;
        reloadHandledByMain?: boolean;
      }>).detail;
      if (!shouldReloadAfterProxyUpdate(detail)) {
        console.log('[BrowserPanel] Dola 代理 Session 已由主进程刷新，跳过渲染层重复 reload');
        return;
      }
      const accounts = useAccountStore.getState().accounts;
      const accountIds = detail?.platform === 'dola'
        ? accounts.filter((account) => account.platform === 'dola').map((account) => account.id)
        : detail?.accountId ? [detail.accountId] : [];
      for (const accountId of accountIds) {
        const webview = registryRef.current.get(accountId);
        if (!webview) continue;
        loadingMapRef.current.set(accountId, true);
        if (useAccountStore.getState().selectedAccountId === accountId) {
          setActiveLoading(true);
          setLoadText('正在应用代理并刷新页面...');
        }
        webview.reload();
      }
    };
    window.addEventListener('account-proxy-updated', handleProxyUpdated);
    return () => window.removeEventListener('account-proxy-updated', handleProxyUpdated);
  }, []);

  // ---- 切换可见性 ----
  useEffect(() => {
    if (!activeAccount) return;
    registryRef.current.forEach((webview, accountId) => {
      const isActive = accountId === activeAccount.id;
      if (isActive) backgroundProbeRef.current.delete(accountId);
      applyWebviewActivationStyle(webview.style, isActive);
      if (isActive) {
        webviewLastUsedAtRef.current[accountId] = Date.now();
        const isLoading = loadingMapRef.current.get(accountId);
        setActiveLoading(!!isLoading);
        if (!isLoading) {
          setActiveLoading(true);
          setLoadText('正在显示账号页面...');
          void forceWebviewLayoutRepaint(webview).finally(() => {
            if (useAccountStore.getState().selectedAccountId !== accountId) return;
            setActiveLoading(false);
            setLoadText('');
          });
        }
      }
    });
  }, [activeAccount?.id, webviewEpoch]);

  /** 从当前账号的可见对话手动提取视频；实验通道只在显式开关开启时参与。 */
  const handleExtractCurrentVideo = async (): Promise<void> => {
    if (!activeAccount) return;
    const accountId = activeAccount.id;
    const webview = registryRef.current.get(accountId);
    if (!webview) {
      message.error('当前账号页面尚未就绪');
      return;
    }
    if (accountBusy[accountId]) {
      message.warning('当前账号正在执行自动化任务，请等待完成或暂停任务后再提取');
      return;
    }

    setManualVideoExtracting(true);
    useTaskStore.getState().setAccountAutomationState(accountId, 'generating', '正在解析当前对话视频...');
    try {
      const conversationUrl = webview.getURL();
      const taskForArtifact = findTaskForManualArtifact(tasks, activeAccount, conversationUrl);
      const canRecoverArchivedTask = taskForArtifact?.status === 'paused'
        && taskForArtifact.errorInfo?.code === 'artifact_download_failed';
      // 使用真实任务 ID 写下载记录，产物中心才能把本地文件与任务产物关联；
      // 没有可证明归属的会话时仍保留临时下载记录，但不会猜测绑定到其他任务。
      const downloadTaskId = taskForArtifact?.id || `manual-${Date.now().toString(36)}`;
      const result = await manualResolveVideoArtifact(webview, {
        conversationUrl,
        timeoutMs: 30_000,
        isManual: true,
        experimentalNoWatermark: isExperimentalNoWatermarkEnabled(),
      });
      const outputs = normalizeResolvedVideoOutput(result, activeAccount.platform);
      if (outputs.length === 0) {
        message.warning(`暂未提取到视频地址：${formatResolutionMessage(result)}`);
        useTaskStore.getState().setAccountAutomationState(accountId, 'idle', '');
        return;
      }

      const download = await window.electronAPI.tasks.downloadOutputs([{
        taskId: downloadTaskId,
        prompt: taskForArtifact?.prompt || '手动对话视频',
        outputs,
        accountId,
        mode: 'video',
      }]);
      if (!download.success) throw new Error(download.error || '视频地址已提取，但下载失败');

      if (taskForArtifact) {
        const registered = await useTaskStore.getState().registerArtifact(taskForArtifact.id, outputs[0], {
          source: 'manual',
          conversationUrl,
          runId: taskForArtifact.runtime?.runId,
        });
        if (!registered) {
          throw new Error('视频已下载，但未能登记到对应任务的产物中心');
        }
        if (canRecoverArchivedTask) {
          // 手动提取已经把真实文件落盘；completeAutomation 会复用同一
          // taskId/url 的已完成下载记录，不会再次请求平台或重新发送提示词。
          await useTaskStore.getState().completeAutomation(taskForArtifact.id, accountId, outputs[0], outputs);
        }
      }

      const usageKey = `${accountId}:${result.vid || outputs[0]}`;
      if (!manualVideoUsageRef.current.has(usageKey)) {
        manualVideoUsageRef.current.add(usageKey);
        const quota = useAccountStore.getState().accounts.find((account) => account.id === accountId)?.seedanceQuota;
        await useAccountStore.getState().recordSeedanceUsage(
          accountId,
          getVideoQuotaUsageUnits(taskForArtifact?.videoConfig?.duration, quota),
        );
      }
      await useAccountStore.getState().recordAccountOutcome(accountId, 'success');
      useTaskStore.getState().setAccountAutomationState(accountId, 'completed', taskForArtifact
        ? `视频已下载并归档（来源：${result.source || 'unknown'}）`
        : `视频已下载（来源：${result.source || 'unknown'}）`);
      message.success(canRecoverArchivedTask
        ? `已下载 ${download.count} 个视频，任务已恢复并等待回传 Lalor`
        : taskForArtifact
          ? `已下载 ${download.count} 个视频，并已保存到产物中心`
        : `已下载 ${download.count} 个视频；未找到对应任务，暂未归档`);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[BrowserPanel] 手动视频提取失败：', error);
      message.error(`提取或下载失败：${reason}`);
      useTaskStore.getState().setAccountAutomationState(accountId, 'idle', '');
    } finally {
      setManualVideoExtracting(false);
    }
  };

  const handleDownloadPublicShareMedia = async (): Promise<void> => {
    const shareUrl = publicShareUrl.trim();
    if (!shareUrl) {
      message.warning('请先粘贴豆包公开分享链接');
      return;
    }
    setManualVideoExtracting(true);
    try {
      const settings = await window.electronAPI.settings.get();
      const download = await window.electronAPI.tasks.downloadPublicShareMedia(shareUrl, settings.downloadDir || undefined);
      if (!download.success) {
        message.error(`公开媒体下载失败：${download.error || '未找到可验证的视频流'}`);
        return;
      }
      setPublicShareDialogOpen(false);
      setPublicShareUrl('');
      const size = download.contentLength ? `，${Math.ceil(download.contentLength / 1024 / 1024)} MB` : '';
      message.success(`已下载页面公开媒体流（${download.sourceHost || '公开来源'}${size}）。该文件保留平台可能附带的水印。`);
    } catch (err: unknown) {
      message.error(`公开媒体下载失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setManualVideoExtracting(false);
    }
  };

  // ---- 立即终止自动化等待；可携带新提示词，在终止后重新排队 ----
  useEffect(() => {
    const handleCancelAutomation = (event: Event) => {
      const detail = (event as CustomEvent<{
        taskId: string;
        restartTask?: TaskUpdateInput;
        targetStatus?: 'paused' | 'cancelled';
      }>).detail;
      if (!detail?.taskId) return;
      if (detail.restartTask?.prompt?.trim()) {
        pendingRestartTasksRef.current.set(detail.taskId, {
          ...detail.restartTask,
          prompt: detail.restartTask.prompt.trim(),
        });
      }
      const requestedCancellationStatus = detail.targetStatus || 'paused';
      const controller = abortControllersRef.current.get(detail.taskId);
      const abortReason: AutomationAbortReason = {
        code: requestedCancellationStatus === 'cancelled' ? 'user_cancel' : 'user_pause',
        message: requestedCancellationStatus === 'cancelled' ? '任务已由本机控制面取消' : '用户已暂停，可随时重新执行',
      };
      const hasActiveController = automationEngine.isReserved(detail.taskId) || !!controller;
      if (hasActiveController) {
        pendingCancellationStatusRef.current.set(detail.taskId, requestedCancellationStatus);
      }
      if (automationEngine.abort(detail.taskId, abortReason) || controller) {
        if (controller && !controller.signal.aborted) controller.abort(abortReason);
        message.info(detail.restartTask ? '正在停止旧任务并重新排队...' : '正在取消任务等待...');
        return;
      }

      // 等待确认/人工核对任务可能已经释放执行控制器，但界面仍属于活动状态。
      // 此时暂停必须直接写入任务状态，不能因为没有 AbortController 而无响应。
      const task = useTaskStore.getState().tasks.find((item) => item.id === detail.taskId);
      const inactiveButPausable = task && [
        'executing',
        'generating',
        'waiting_verification',
        'waiting_generation_confirmation',
        'manual_submission_observing',
      ].includes(task.status);
      if (!inactiveButPausable || !task.assignedAccountId) {
        message.warning('任务当前没有可暂停的执行或等待状态');
        return;
      }

      void (async (): Promise<void> => {
        try {
          await useTaskStore.getState().pauseAutomation(
            task.id,
            task.assignedAccountId!,
            abortReason.message || '用户已暂停，可随时重新执行',
            {
              status: requestedCancellationStatus,
              code: abortReason.code,
            },
          );
          if (detail.restartTask) {
            pendingRestartTasksRef.current.delete(task.id);
            const updated = await useTaskStore.getState().updateTask(task.id, detail.restartTask);
            if (!updated) throw new Error(useTaskStore.getState().error || '任务重新排队失败');
            useTaskStore.getState().processQueue();
            message.success('旧等待已停止，任务已重新加入队列');
          } else {
            message.success(requestedCancellationStatus === 'cancelled' ? '任务已取消' : '任务已暂停');
          }
        } catch (error: unknown) {
          message.error(error instanceof Error ? error.message : '任务暂停失败');
        }
      })();
    };

    window.addEventListener('cancel-task-automation', handleCancelAutomation);
    return () => window.removeEventListener('cancel-task-automation', handleCancelAutomation);
  }, []);

  useEffect(() => {
    const handleOpenConversation = async (event: Event) => {
      const task = (event as CustomEvent<{ task: Task }>).detail?.task;
      const accountId = task?.assignedAccountId;
      const conversationUrl = task?.runtime?.conversationUrl || task?.artifacts?.find((artifact) => artifact.conversationUrl)?.conversationUrl;
      const webview = accountId ? registryRef.current.get(accountId) : null;
      if (!accountId || !conversationUrl || !webview) {
        message.warning('该产物没有可用的原对话地址');
        return;
      }
      useAccountStore.getState().selectAccount(accountId);
      webview.loadURL(conversationUrl);
      message.info('正在打开产物对应的豆包对话');
    };
    window.addEventListener('open-task-conversation', handleOpenConversation);
    return () => window.removeEventListener('open-task-conversation', handleOpenConversation);
  }, []);

  useEffect(() => {
    const handleAdapterSelfCheck = async () => {
      if (!activeAccount) {
        window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { error: '请先选择账号' } }));
        return;
      }
      const webview = registryRef.current.get(activeAccount.id);
      if (!webview) {
        window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { error: '账号页面尚未就绪' } }));
        return;
      }
      try {
        const report = await runAdapterSelfCheck(webview);
        await window.electronAPI.tasks.saveAdapterReport(activeAccount.id, report);
        window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { report } }));
      } catch (error: any) {
        window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { error: error.message || String(error) } }));
      }
    };
    window.addEventListener('adapter-self-check', handleAdapterSelfCheck);
    return () => window.removeEventListener('adapter-self-check', handleAdapterSelfCheck);
  }, [activeAccount]);

  // ---- V3 自动化：监听 per-account 执行状态 ----
  useEffect(() => {
    accounts.forEach((account) => {
      const accountId = account.id;
      const isBusy = accountBusy[accountId];
      const taskId = executingTasks[accountId];
      const webview = registryRef.current.get(accountId);
      if (!isBusy || !taskId || !webview) return;
      if (runningRef.current.has(accountId)) return;
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      console.log(`[BrowserPanel] 路由任务 ${taskId} → ${accountId}`);
      // Route directly to the resident guest without stealing the user's view.
      runningRef.current.add(accountId);
      // 任务自身的平台是执行路由的最终事实来源。账号平台只用于校验/兼容旧任务，
      // 不能在自动化阶段重新推断，否则旧状态或异步刷新会把 Dola 任务送回豆包入口。
      executeAutomation(
        accountId,
        taskId,
        task.prompt,
        task.mode || "chat",
        webview,
        task.videoConfig,
        task.attachments,
        task.audioAttachment,
        task.referenceVideos,
        task.audioAttachments,
        task.targetPlatform,
      );
    });
  }, [accountBusy, executingTasks, tasks, webviewEpoch]);

  // ---- 自动化执行 ----
  const executeAutomation = async (
    accountId: string,
    taskId: string,
    prompt: string,
    mode: Task['mode'],
    webview: HTMLWebViewElement,
    videoConfig?: Task['videoConfig'],
    attachments?: string[],
    audioAttachment?: string,
    referenceVideos?: string[],
    audioAttachments?: string[],
    targetPlatform?: Task['targetPlatform'],
  ) => {
    const {
      setAccountAutomationState,
      updateTaskRuntime,
      completeAutomation,
      pauseAutomation,
      failAutomation,
      updateTask,
      retryAfterQuotaExhaustion,
      retryAfterPreSubmitFailure,
    } =
      useTaskStore.getState();
    const expectedRunId = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime?.runId;
    const videoCaptureToken = mode === 'video'
      ? `${taskId}:${expectedRunId || 'unversioned'}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`
      : undefined;
    let controller: AbortController;
    try {
      controller = automationEngine.createController(taskId, accountId);
    } catch (error: any) {
      const messageText = error?.message || '任务控制器初始化失败';
      await failAutomation(taskId, accountId, messageText, classifyTaskError(messageText));
      await automationEngine.release(taskId);
      return;
    }
    abortControllersRef.current.set(taskId, controller);
    const pause = (ms: number) => sleepWithAbort(ms, controller.signal);
    let initializationLease: InitializationLease | undefined;
    let autoConfirmMaterialAuthorization = false;
    let initializationLimit = 3;
    const clearKnownPromotion = async (): Promise<void> => {
      const currentAccount = useAccountStore.getState().accounts.find((item) => item.id === accountId);
      const currentUrl = typeof webview.getURL === 'function' ? webview.getURL() : '';
      if (targetPlatform === 'dola' || currentAccount?.platform === 'dola' || isDolaUrl(currentUrl)) return;
      const result = await dismissKnownDesktopDownloadPromotion(webview);
      if (result === 'failed') {
        throw new Error('下载电脑版推广弹窗未能安全关闭，已在提交前停止');
      }
      if (result === 'dismissed') await pause(350);
    };
    const materialAuthorizationNotificationKey = `material-authorization-${taskId}`;
    try {
      const settings = await window.electronAPI.settings.get();
      autoConfirmMaterialAuthorization = settings.autoConfirmMaterialAuthorization === true;
      initializationLimit = Math.max(1, Math.min(3, Number(settings.initializationConcurrency) || 3));
      initializationLease = await initializationGate.acquire(taskId, { limit: initializationLimit, signal: controller.signal });
      await updateTaskRuntime(taskId, {
        runtime: {
          executionDiagnostics: {
            initializationQueueWaitMs: initializationLease.waitedMs,
            initializationLimit,
          },
        },
      });
      console.log(`[Automation:${accountId}] 开始`);
      const account = useAccountStore.getState().accounts.find((a) => a.id === accountId);
      // targetPlatform 在任务创建/指派时已完成平台消歧，执行阶段优先使用它。
      // 只有历史任务缺失该字段时才回退到账号平台。
      const automationPlatform = targetPlatform || account?.platform || 'doubao';
      console.log(`[Automation:${accountId}] 平台路由: task=${targetPlatform || 'missing'} account=${account?.platform || 'missing'} effective=${automationPlatform}`);
      // 视频发送副本追加直出指令；Dola 30 秒再兼容中文时长标记。
      // 任务原文、编辑和历史记录保持不变。
      const promptForSubmission = mode === 'video'
        ? prepareVideoPromptForSubmission(prompt, {
          platform: automationPlatform,
          duration: videoConfig?.duration,
        })
        : prompt;
      if (promptForSubmission !== prompt) {
        console.log(`[Automation:${accountId}] 视频提示词发送副本已准备: 原长=${prompt.length}, 发送副本长=${promptForSubmission.length}`);
      }

      setAccountAutomationState(accountId, 'injecting', '正在检测账号可用性...', 'preparing_account');
      await clearKnownPromotion();
      const preTaskAvailability = await performAvailabilityCheck(accountId, webview, 'pre_task');
      if (availabilityBlocksAutomation(preTaskAvailability)) {
        useAccountStore.getState().selectAccount(accountId);
        throw new AccountAvailabilityPauseError(preTaskAvailability.message, preTaskAvailability.reason);
      }

      // 视频能力预检：在提交前基于本地已知状态判断是否允许提交
      if (mode === 'video' && videoConfig) {
        if (account) {
          const capability = evaluateVideoCapability({
            model: videoConfig.model,
            duration: videoConfig.duration,
            aspectRatio: videoConfig.aspectRatio,
            platform: automationPlatform,
            manual15sEnabled: false,
            seedanceQuota: account.seedanceQuota,
            health: account.health,
            scheduling: account.scheduling,
            accountStatus: account.status,
          });
          if (!capability.canSubmit) {
            // 本地已知阻塞条件，直接终止，不进入页面操作
            throw new Error(capability.userMessage);
          }
          if (capability.state === 'unknown') {
            // 有风险提示但允许提交，记录日志
            console.warn(`[Automation:${accountId}] 视频能力预检提示: ${capability.userMessage}`);
          }
        }
      }

      let taskConversationUrl: string | undefined;
      let modeEntryElapsedMs: number | undefined;
      let initialMsgCount = 0;
      let conversationTextAfterSubmit = '';
      // 记录提交前最后一条助手回复，避免把历史额度提示误判为本次任务拒绝。
      let assistantReplyBeforeSubmit = '';
      setAccountAutomationState(accountId, 'injecting', '正在创建新对话...', 'new_conversation');
      const newConversationResult = await startNewConversation(webview);
      if (!newConversationResult.ok) {
        const failedAvailability = await performAvailabilityCheck(accountId, webview, 'pre_task');
        if (failedAvailability.state !== 'ready') {
          useAccountStore.getState().selectAccount(accountId);
          throw new AccountAvailabilityPauseError(failedAvailability.message, failedAvailability.reason);
        }
        const transientReasonCode: Record<string, string> = {
          PAGE_NOT_READY: 'page_not_ready',
          EDITOR_NOT_FOUND: 'editor_not_found',
          EDITOR_NOT_FOCUSABLE: 'editor_not_focusable',
        };
        const transientCode = transientReasonCode[newConversationResult.reason || ''];
        if (transientCode) {
          const currentAttempt = Math.max(
            1,
            useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime?.attempt || 1,
          );
          const retryMessage = currentAttempt < MAX_TRANSIENT_PRE_SUBMIT_ATTEMPTS
            ? `Dola 页面暂未就绪（${newConversationResult.reason}），页面稳定后将自动恢复（第 ${currentAttempt}/${MAX_TRANSIENT_PRE_SUBMIT_ATTEMPTS} 次）`
            : `Dola 页面连续 ${MAX_TRANSIENT_PRE_SUBMIT_ATTEMPTS} 次未就绪（${newConversationResult.reason}），已停止自动恢复，请人工检查页面后重试`;
          throw new AccountAvailabilityPauseError(retryMessage, transientCode);
        }
        // reason 为脱敏状态码（如 PAGE_NOT_READY/EDITOR_NOT_FOUND/SESSION_NOT_EMPTY），不泄露页面细节。
        throw new Error(`创建新对话失败（${newConversationResult.reason || 'PAGE_UNKNOWN'}）`);
      }
      await waitForWebviewReady(webview, 15000);
      await clearKnownPromotion();
      taskConversationUrl = webview.getURL();
      await updateTaskRuntime(taskId, { runtime: { conversationUrl: taskConversationUrl } });
      // 根据任务模式切换到对应页面
      if (mode && mode !== 'chat') {
        const modeLabel = mode === 'image' ? '图片' : mode === 'video' ? '视频' : mode === 'music' ? '音乐' : mode;
        setAccountAutomationState(accountId, 'injecting', '切换到' + modeLabel + '模式...', 'switching_mode');
        switchMode(webview, mode);
        await waitForWebviewReady(webview, 20000);
        await clearKnownPromotion();

        // image/video 模式：在 AI 创作页面点击 Tab 切换
        if (mode === 'image' || mode === 'video') {
          setAccountAutomationState(accountId, 'injecting', '点击' + modeLabel + 'Tab...', 'switching_mode');
          const modeEntry = await recoverModeEntry({
            warmup: async () => {
              await waitForWebviewReady(webview, 5_000);
              await clearKnownPromotion();
              await pause(350);
            },
            attempt: async (attempt) => {
              console.log(`[Automation:${accountId}] mode_entry recovery attempt ${attempt}/3`);
              return clickAITab(webview, mode, automationPlatform);
            },
            forceLayout: async () => {
              await forceWebviewLayoutRepaint(webview);
              await pause(350);
            },
            safeReload: async () => {
              const currentTask = useTaskStore.getState().tasks.find((item) => item.id === taskId);
              if (currentTask?.runtime?.submittedAt
                || currentTask?.runtime?.submissionConfirmedAt
                || currentTask?.runtime?.submissionIntentAt) {
                console.warn(`[Automation:${accountId}] mode_entry reload skipped after submission intent`);
                return false;
              }
              webview.reload();
              await waitForWebviewReady(webview, 20_000);
              await clearKnownPromotion();
              await pause(350);
              return true;
            },
          });
          modeEntryElapsedMs = modeEntry.elapsedMs;
          if (!modeEntry.switched) {
            if (mode === 'video') {
              throw new VideoControlReadinessError('mode_entry', {
                ready: false,
                failureStage: 'mode_entry',
                attempts: modeEntry.attempts,
                elapsedMs: modeEntryElapsedMs,
              });
            }
            throw new Error(`${modeLabel}模式入口未就绪，已在提交前停止`);
          }
          await pause(1500); // 等待 Tab 切换动画
        }

        // 视频模式：只使用页面可见控件配置，禁止请求改写绕过会员门槛。
        if (mode === 'video') {
          if (videoConfig) {
            setAccountAutomationState(accountId, 'injecting', '配置视频参数...', 'configuring');
            await configureVideoOptions(webview, videoConfig, {
              platform: automationPlatform,
              onReadiness: async (diagnostic) => {
                await updateTaskRuntime(taskId, {
                  runtime: {
                    controlReadiness: {
                      modeEntryElapsedMs,
                      attempts: diagnostic.attempts,
                      elapsedMs: diagnostic.elapsedMs,
                      modelVisibleAtMs: diagnostic.modelVisibleAtMs,
                      compositeVisibleAtMs: diagnostic.compositeVisibleAtMs,
                      stableAtMs: diagnostic.stableAtMs,
                      failureStage: diagnostic.failureStage,
                    },
                    lastHeartbeatAt: new Date().toISOString(),
                  },
                });
              },
            });
            await pause(500);
          }
        }

        // 有参考图片时上传
        if (attachments && attachments.length > 0) {
          if (attachments.length > MAX_REFERENCE_IMAGE_COUNT) {
            throw new Error(`参考图片最多 ${MAX_REFERENCE_IMAGE_COUNT} 张，当前 ${attachments.length} 张；已在提交前停止`);
          }
          setAccountAutomationState(accountId, 'injecting', '上传参考图片...', 'uploading_assets');
          // 读取文件为 base64
          const fileDataList: Array<{ name: string; base64: string; mime: string }> = [];
          for (const filePath of attachments) {
            try {
              const result = await window.electronAPI.tasks.readFileAsBase64(filePath);
              if (result.success && result.data) {
                const fileName = filePath.split(/[/\\]/).pop() || 'image.jpg';
                const mimeMatch = result.data.match(/^data:(image\/\w+);base64,/);
                const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                const base64 = result.data.replace(/^data:image\/\w+;base64,/, '');
                fileDataList.push({ name: fileName, base64, mime });
              }
            } catch (e: any) {
              console.warn(`[BrowserPanel] 读取文件失败 ${filePath}:`, e.message);
            }
          }
          if (fileDataList.length !== attachments.length) {
            throw new Error('参考图片读取不完整，已在提交前停止');
          }
          let lastUploadPersistAt = -Infinity;
          const uploaded = await uploadReferenceImages(webview, fileDataList, {
            timeoutMs: 180_000,
            stableSamples: 3,
            signal: controller.signal,
            onProgress: async (diagnostic) => {
              if (diagnostic.elapsedMs - lastUploadPersistAt < 5000 && diagnostic.failure !== undefined) return;
              lastUploadPersistAt = diagnostic.elapsedMs;
              const uploadMessage = diagnostic.pending
                ? `参考图片正在上传或处理（${diagnostic.observedCount}/${diagnostic.expectedCount} 张），等待完成…`
                : diagnostic.stableSamples >= 3
                  ? `参考图片上传完成（${diagnostic.expectedCount} 张）`
                  : `正在核对参考图片（${diagnostic.observedCount}/${diagnostic.expectedCount} 张）…`;
              setAccountAutomationState(accountId, 'injecting', uploadMessage, 'uploading_assets');
              const existingDiagnostics = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime?.executionDiagnostics;
              await updateTaskRuntime(taskId, {
                runtime: { message: uploadMessage, lastHeartbeatAt: new Date().toISOString(), executionDiagnostics: { ...existingDiagnostics, upload: diagnostic } },
              });
            },
          });
          if (!uploaded) throw new Error('参考图片未全部上传完成，请检查缩略图进度和网络（最长等待 180 秒）；已在提交前停止');
        }

        // 参考视频和音频使用与图片相同的提交前硬校验；历史单音频字段并入列表且去重。
        if (mode === 'video' && referenceVideos && referenceVideos.length > 0) {
          if (referenceVideos.length > REFERENCE_VIDEO_LIMIT) {
            throw new Error(`参考视频最多 ${REFERENCE_VIDEO_LIMIT} 个，当前 ${referenceVideos.length} 个；已在提交前停止`);
          }
          setAccountAutomationState(accountId, 'injecting', '上传参考视频...', 'uploading_assets');
          try {
            const fileDataList = await readReferenceFileData(referenceVideos, 'video/mp4');
            if (fileDataList.length !== referenceVideos.length) throw new Error('参考视频读取不完整，已在提交前停止');
            const uploaded = await uploadReferenceVideos(webview, fileDataList);
            if (!uploaded) throw new Error('参考视频未上传完成，已在提交前停止');
          } catch (error: unknown) {
            const reason = error instanceof Error ? error.message : '参考视频处理失败';
            throw new Error(reason.includes('已在提交前停止') ? reason : '参考视频处理失败，已在提交前停止');
          }
        }

        if (mode === 'video') {
          const mergedAudioPaths = [...new Set([...(audioAttachments || []), audioAttachment || ''].filter(Boolean))];
          if (mergedAudioPaths.length > REFERENCE_AUDIO_LIMIT) {
            throw new Error(`参考音频最多 ${REFERENCE_AUDIO_LIMIT} 个，当前 ${mergedAudioPaths.length} 个；已在提交前停止`);
          }
          if (mergedAudioPaths.length > 0) {
            setAccountAutomationState(accountId, 'injecting', '上传参考音频...', 'uploading_assets');
            try {
              const fileDataList = await readReferenceFileData(mergedAudioPaths, 'audio/mpeg');
              if (fileDataList.length !== mergedAudioPaths.length) throw new Error('参考音频读取不完整，已在提交前停止');
              const uploaded = await uploadReferenceAudios(webview, fileDataList);
              if (!uploaded) throw new Error('参考音频未上传完成，已在提交前停止');
            } catch (error: unknown) {
              const reason = error instanceof Error ? error.message : '参考音频处理失败';
              throw new Error(reason.includes('已在提交前停止') ? reason : '参考音频处理失败，已在提交前停止');
            }
          }
        }
      } else {
        await waitForWebviewReady(webview, 15000);
      }

      await clearKnownPromotion();
      const preSubmitAvailability = await performAvailabilityCheck(accountId, webview, 'pre_submit');
      if (preSubmitAvailability.state !== 'ready') {
        useAccountStore.getState().selectAccount(accountId);
        throw new AccountAvailabilityPauseError(preSubmitAvailability.message, preSubmitAvailability.reason);
      }

      // 注入生成状态网络监听器（后台 webview 也能准确检测生成完成）
      await injectGenerationMonitor(webview);
      if (mode === 'video') {
        await resetVideoCaptureCache(webview, videoCaptureToken!);
      } else if (mode === 'image') {
        await resetImageCaptureCache(webview);
      }

      setAccountAutomationState(accountId, 'injecting', '正在注入提示词...', 'injecting_prompt');
      const injected = await Promise.race([
        injectPrompt(webview, promptForSubmission),
        new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error('注入超时')), 60000)),
      ]);
      if (!injected) throw new Error('注入失败');
      await pause(800);
      if (!await verifyPromptReadyForSubmission(webview, promptForSubmission)) {
        throw new Error('提示词全文回读不一致，可能存在截断或台词缺失；已在提交前停止');
      }

      // 参考图上传和提示词写入都可能触发 Dola 创作栏重新挂载，导致时长
      // 悄悄恢复为默认值。这里在真正发送前再次配置并连续回读最终控件状态，
      // 确保提交使用的是任务要求，而不是仅在初始化阶段选中的临时状态。
      if (automationPlatform === 'dola' && mode === 'video' && videoConfig) {
        setAccountAutomationState(accountId, 'injecting', '发送前复核 Dola 视频参数...', 'configuring');
        await configureVideoOptions(webview, videoConfig, {
          platform: 'dola',
          onReadiness: async (diagnostic) => {
            await updateTaskRuntime(taskId, {
              runtime: {
                controlReadiness: {
                  modeEntryElapsedMs,
                  attempts: diagnostic.attempts,
                  elapsedMs: diagnostic.elapsedMs,
                  modelVisibleAtMs: diagnostic.modelVisibleAtMs,
                  compositeVisibleAtMs: diagnostic.compositeVisibleAtMs,
                  stableAtMs: diagnostic.stableAtMs,
                  failureStage: diagnostic.failureStage,
                },
                lastHeartbeatAt: new Date().toISOString(),
              },
            });
          },
        });
        await pause(500);
        if (!await verifyPromptReadyForSubmission(webview, promptForSubmission)) {
          throw new Error('Dola 参数复核后提示词回读不一致，已在提交前停止');
        }
      }

      // 素材确认可能在用户点击后直接继续发送。先取只读基线，确认后只回读，
      // 绝不能再点一次发送。
      const generationStartTimeBeforeSubmit = await getGenerationStartTime(webview);
      initialMsgCount = await getSubmissionMessageCount(webview);
      assistantReplyBeforeSubmit = await getLatestAssistantReply(webview);
      let authorizationTriggeredSubmission = false;
      let submissionMarkedAt: string | undefined;

      const markSubmissionIntent = async (stage: 'submitting' | 'waiting_verification', messageText: string): Promise<string> => {
        const currentRuntime = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime;
        if (!canAttemptSubmission(
          expectedRunId,
          currentRuntime?.runId,
          currentRuntime?.submittedAt,
          currentRuntime?.submissionIntentAt,
          currentRuntime?.submissionConfirmedAt,
        )) {
          throw new SubmissionSafetyPauseError('本次运行已存在发送记录或运行身份已变化；系统已停止，未再次发送');
        }
        const markedAt = new Date().toISOString();
        const persisted = await updateTaskRuntime(taskId, {
          status: stage === 'waiting_verification' ? 'waiting_verification' : 'executing',
          runtime: {
            stage,
            message: messageText,
            stageStartedAt: markedAt,
            lastHeartbeatAt: markedAt,
            submissionIntentAt: markedAt,
          },
        });
        if (!persisted) {
          throw new SubmissionPersistenceError('提交意图无法持久化；为避免重复发送，本次未执行页面提交');
        }
        const persistedRuntime = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime;
        if (persistedRuntime?.runId !== expectedRunId || persistedRuntime?.submissionIntentAt !== markedAt) {
          throw new SubmissionPersistenceError('提交意图回读不一致；为避免重复发送，本次未执行页面提交');
        }
        return markedAt;
      };

      // 参考素材首次用于某个账号时，新版页面会用“安全确认”遮挡发送按钮。
      // 自动化只识别、不代点。由于人工“确认”可能直接提交，必须先持久化提交意图，
      // 再等待用户操作并回读同一 run，避免任务失联或二次发送。
      if (mode === 'video' && attachments && attachments.length > 0) {
        const authorization = await inspectMaterialAuthorization(webview);
        if (authorization === 'blocked') {
          throw new AccountAvailabilityPauseError('素材安全确认未完成，请检查右侧页面；本次尚未提交', 'material_authorization_required');
        }
        if (authorization === 'present') {
          const waitingMessage = autoConfirmMaterialAuthorization
            ? '已识别素材授权白名单，准备单次确认并只读回查'
            : '等待你在右侧页面确认素材授权；确认后将自动继续跟踪，系统不会代点或重复发送';
          submissionMarkedAt = await markSubmissionIntent('waiting_verification', waitingMessage);
          setAccountAutomationState(accountId, 'injecting', waitingMessage, 'waiting_verification');
          useAccountStore.getState().selectAccount(accountId);
          const detectedAt = new Date().toISOString();
          const currentDiagnostics = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime?.executionDiagnostics;
          await updateTaskRuntime(taskId, {
            runtime: {
              executionDiagnostics: {
                ...currentDiagnostics,
                materialAuthorization: {
                  fingerprint: 'doubao-material-authorization-v1', detectedAt, outcome: 'detected',
                },
              },
            },
          });
          if (autoConfirmMaterialAuthorization) {
            const confirmationResult = await confirmMaterialAuthorizationIfAllowed(webview, {
              enabled: true,
              expectedConversationUrl: taskConversationUrl || '',
              assetsValidated: true,
            });
            const latestDiagnostics = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime?.executionDiagnostics;
            await updateTaskRuntime(taskId, {
              runtime: {
                executionDiagnostics: {
                  ...latestDiagnostics,
                  materialAuthorization: {
                    fingerprint: 'doubao-material-authorization-v1',
                    detectedAt: confirmationResult.detectedAt,
                    clickedAt: confirmationResult.clickedAt,
                    verifiedAt: confirmationResult.verifiedAt,
                    outcome: confirmationResult.status === 'confirmed' ? 'confirmed' : 'uncertain',
                  },
                },
              },
            });
            if (confirmationResult.status === 'not_allowed') {
              throw new AccountAvailabilityPauseError(`素材授权自动确认被安全门禁拒绝（${confirmationResult.reason}），请人工核对`, 'material_authorization_required');
            }
          } else {
            notification.warning({
              key: materialAuthorizationNotificationKey,
              message: '需要人工确认素材授权',
              description: '请核对素材权利后在豆包页面手动选择“确认”或“拒绝”。确认后任务会继续跟踪本次生成。',
              duration: 0,
            });
          }
          initializationLease?.release();
          initializationLease = undefined;

          const authorizationWaitStartedAt = Date.now();
          const authorizationTimeoutMs = TASK_TIMEOUT_POLICY.materialAuthorizationMs;
          while (true) {
            automationEngine.heartbeat(taskId, 'waiting_verification');
            await pause(600);
            const evidence = await getSubmissionEvidence(webview, promptForSubmission, generationStartTimeBeforeSubmit, initialMsgCount, mode);
            const dialogState = await inspectMaterialAuthorization(webview);
            const progress = decideMaterialAuthorizationProgress({
              dialogState,
              submissionConfirmed: classifySubmissionReadback(evidence) === 'confirmed',
              elapsedMs: Date.now() - authorizationWaitStartedAt,
              timeoutMs: authorizationTimeoutMs,
            });
            if (progress === 'confirmed') {
              authorizationTriggeredSubmission = true;
              break;
            }
            if (progress === 'timeout') {
              throw new SubmissionSafetyPauseError('等待素材授权确认超时；提交意图已保留，系统不会自动重发');
            }
            if (progress === 'uncertain') {
              // 弹窗消失后给页面最多 6 秒产生权威提交回执；拒绝或异常关闭均不得补点发送。
              for (let attempt = 0; attempt < 12; attempt += 1) {
                await pause(500);
                const followup = await getSubmissionEvidence(webview, promptForSubmission, generationStartTimeBeforeSubmit, initialMsgCount, mode);
                if (classifySubmissionReadback(followup) === 'confirmed') {
                  authorizationTriggeredSubmission = true;
                  break;
                }
              }
              if (!authorizationTriggeredSubmission) {
                throw new SubmissionSafetyPauseError('素材授权弹窗已关闭，但未取得提交回执；请人工核对平台，系统不会自动重发');
              }
              break;
            }
          }
          notification.destroy(materialAuthorizationNotificationKey);
        }
      }

      let finalUploadPending = false;
      let lastSubmissionProgressAt = 0;
      if (!authorizationTriggeredSubmission && !await waitForSubmissionControlsStable(webview, attachments?.length ? 180_000 : 20_000, {
        signal: controller.signal,
        onProgress: async (pending) => {
          finalUploadPending = pending;
          if (Date.now() - lastSubmissionProgressAt < 5000) return;
          lastSubmissionProgressAt = Date.now();
          const progressMessage = pending ? '参考素材仍在上传或处理，等待完成后自动发送…' : '正在等待发送按钮就绪…';
          setAccountAutomationState(accountId, 'injecting', progressMessage, 'uploading_assets');
          await updateTaskRuntime(taskId, { runtime: { message: progressMessage, lastHeartbeatAt: new Date().toISOString() } });
        },
      })) {
        throw new Error(finalUploadPending
          ? '参考素材上传或处理超时，请检查缩略图进度和网络；已在提交前停止'
          : '未识别到稳定可用的发送按钮；已在提交前停止');
      }

      // P0：真实发送是不可重复副作用。先从当前任务快照核对 runId/submittedAt，
      // 再把本次提交意图持久化；写入失败或运行已变化时绝不点击页面。
      if (!submissionMarkedAt) {
        submissionMarkedAt = await markSubmissionIntent('submitting', '正在发送...');
      } else {
        await updateTaskRuntime(taskId, {
          status: 'executing',
          runtime: { stage: 'submitting', message: '素材授权已确认，正在回读本次提交...', lastHeartbeatAt: new Date().toISOString() },
        });
      }
      setAccountAutomationState(
        accountId,
        'submitting',
        authorizationTriggeredSubmission ? '素材授权已确认，正在回读本次提交...' : '正在发送...',
        'submitting',
      );
      // 必须和提交回读使用同一个 DOM 选择器；综合生成检测可能因为网络状态
      // 提前返回而没有消息计数，不能把旧会话消息误当成本次发送回执。
      let submitted = authorizationTriggeredSubmission;
      // 视频/图片模式下直接用发送按钮提交（聊天+标签模式，发送按钮就是提交）
      // 之前的"生成视频"文字按钮会发送默认提示词，不是输入框内容
      if (!authorizationTriggeredSubmission) {
        try {
          const clickResult: NativeSubmitClickResult = await Promise.race([
            submitPromptWithNativeClick(webview),
            new Promise<NativeSubmitClickResult>((_, rej) => setTimeout(() => rej(new Error('提交超时')), 10000)),
          ]);
          if (clickResult.status === 'not_attempted') {
            // markSubmissionIntent 先写入意图是为了防止并发点击；只有桥接层
            // 明确证明尚未发出任何原生事件时，才允许撤销这次意图并改派。
            const cleared = await updateTaskRuntime(taskId, {
              runtime: {
                submissionIntentAt: undefined,
                message: `发送未执行（${clickResult.reason}），准备切换账号`,
                lastHeartbeatAt: new Date().toISOString(),
              },
            });
            if (!cleared) {
              throw new SubmissionPersistenceError('发送未执行，但提交意图清除失败；为避免重复发送已暂停');
            }
            throw new PreSubmitSendFailureError(`发送失败：发送控件未就绪（${clickResult.reason}），本次未产生平台提交`);
          }
          if (clickResult.status !== 'submitted') {
            throw new SubmissionSafetyPauseError('发送动作结果不确定，请人工核对豆包会话；系统未自动重发');
          }
          submitted = true;
        } catch (error: unknown) {
          // 只有上面的明确“未尝试发送”错误会继续向外层恢复逻辑传播；
          // 超时、原生事件异常等无法排除部分副作用的情况必须保持安全暂停。
          if (error instanceof PreSubmitSendFailureError || error instanceof SubmissionPersistenceError || error instanceof SubmissionSafetyPauseError) {
            throw error;
          }
          throw new SubmissionSafetyPauseError('发送动作结果不确定，请人工核对豆包会话；系统未自动重发');
        }
      }
      if (!submitted) {
        throw new SubmissionSafetyPauseError('发送按钮不可用或点击结果不确定；系统已停止且未自动重发');
      }

      let submissionConfirmed = false;
      const submissionReadbackDeadline = Date.now() + SUBMISSION_READBACK_TIMEOUT_MS;
      let submissionReadbackAttempts = 0;
      while (!submissionConfirmed && Date.now() < submissionReadbackDeadline) {
        automationEngine.heartbeat(taskId, 'submitting');
        submissionReadbackAttempts += 1;
        await pause(Math.min(
          SUBMISSION_READBACK_INTERVAL_MS,
          Math.max(0, submissionReadbackDeadline - Date.now()),
        ));
        const evidence = await getSubmissionEvidence(webview, promptForSubmission, generationStartTimeBeforeSubmit, initialMsgCount, mode);
        if (classifySubmissionReadback(evidence) === 'confirmed') {
          submissionConfirmed = true;
          break;
        }
      }
      if (!submissionConfirmed) {
        throw new SubmissionSafetyPauseError(`发送回执在 ${SUBMISSION_READBACK_TIMEOUT_MS / 1000} 秒内未确认，请人工核对豆包会话；系统未自动重发（只读检查 ${submissionReadbackAttempts} 次）`);
      }
      // 平台已经接受这次不可重复的提交。先持久化为 generating，再做后续
      // 验证层/生成状态核对；否则慢页面会让 60 秒 submitting watchdog 误中断。
      const submissionAcceptedAt = new Date().toISOString();
      const submissionConversationUrl = webview.getURL();
      // 新对话通常在首次发送后才从 /chat 跳到具体会话地址。后续自动确认、
      // 产物提取和人工回读都必须使用平台实际接收提交后的具体地址。
      taskConversationUrl = submissionConversationUrl;
      const submissionAcceptedPersisted = await updateTaskRuntime(taskId, {
        status: 'generating',
        runtime: {
          stage: 'generating',
          message: '平台已确认接收，正在核对生成状态...',
          stageStartedAt: submissionAcceptedAt,
          lastHeartbeatAt: submissionAcceptedAt,
          submissionIntentAt: undefined,
          submittedAt: submissionAcceptedAt,
          submissionConfirmedAt: submissionAcceptedAt,
          conversationUrl: submissionConversationUrl,
        },
      });
      if (!submissionAcceptedPersisted) {
        throw new SubmissionSafetyPauseError('平台已确认接收，但本地生成状态写入失败；请只读核对原会话，系统不会重新发送');
      }
      setAccountAutomationState(accountId, 'generating', '平台已确认接收，正在核对生成状态...', 'generating');
      // 新版页面不总是暴露 data-message-id 或网络监听状态；保存“用户消息已进入
      // 会话后”的文本基线，后续仅把新的会话内容认定为助手回复终态。
      conversationTextAfterSubmit = await getConversationText(webview);
      initializationLease?.release();
      initializationLease = undefined;

      // 提交成功后刷新阻断检测基线。
      // resetVideoCaptureCache 在注入提示词前设置基线，此时用户消息尚未渲染。
      // 提交成功后用户消息已写入页面，需要重新设置基线，否则
      // detectVideoGenerationBlocker 的增量文本会包含用户提示词内容，
      // 导致提示词中含"生成失败""会员专享"等词时被误判为平台限制。
      if (mode === 'video') {
        await pause(800); // 等待用户消息渲染完成
        await refreshBlockerBaseline(webview);
      }

      let verificationDetected = false;
      // 验证完成后旧 iframe/class 可能在页面中短暂残留。给页面一个有界的
      // 只读观察窗口，并在暂停前先核对本次提交是否已经出现生成证据。
      // 只有“验证层存在 + 没有回执/生成中/视频”才进入人工处理。
      const postSubmitVerificationDeadline = Date.now() + 12_000;
      const postSubmitVerificationGraceMs = 5_000;
      let verificationFirstSeenAt: number | undefined;
      for (let check = 0; check < 12 && Date.now() < postSubmitVerificationDeadline; check += 1) {
        automationEngine.heartbeat(taskId, 'generating');
        const inspection = await inspectPostSubmitGenerationState(webview, {
          generationStartAfter: generationStartTimeBeforeSubmit,
        });
        if (inspection.verificationVisible && hasPostSubmitGenerationEvidence(inspection)) {
          console.log(
            `[Automation:${accountId}] 检测到验证节点但已有生成证据(${inspection.evidence || 'unknown'})，继续只读等待产物`,
          );
          break;
        }
        if (inspection.verificationVisible) {
          const decision = decidePostSubmitVerification(inspection);
          if (decision === 'pause_for_verification') {
            verificationFirstSeenAt ??= Date.now();
            // 验证节点刚出现时给平台最多 5 秒完成收尾；如果到本轮上限仍
            // 没有任何生成证据，才按真实人工验证阻断处理。
            if (Date.now() - verificationFirstSeenAt >= postSubmitVerificationGraceMs || check === 11) {
              verificationDetected = true;
              break;
            }
            await pause(1000);
            continue;
          }
        }
        await pause(1000);
      }

      if (verificationDetected) {
        await useAccountStore.getState().setAccountAvailability(accountId, {
          state: 'action_required',
          reason: 'human_verification',
          message: '需要在右侧页面完成人机验证，然后重新检测',
          checkedAt: new Date().toISOString(),
          source: 'pre_submit',
        });
        useAccountStore.getState().selectAccount(accountId);
        throw new AccountAvailabilityPauseError('检测到机器人验证，请人工处理并核对会话；系统不会自动重新提交', 'human_verification');
      }

      setAccountAutomationState(accountId, 'generating', '等待豆包生成回复...', 'generating');
      await pause(3000);
      await updateTaskRuntime(taskId, {
        runtime: { conversationUrl: webview.getURL(), lastHeartbeatAt: new Date().toISOString() },
      });

      let generating = true;
      let imageUrls: string[] = [];
      const generationWaitStartedAt = Date.now();
      const generationWaitBudget = generationWaitBudgetMs(mode);
      const generationAttemptLimit = generationPollLimit(mode);
      let unknownCount = 0;
      const maxUnknown = 10; // 连续 10 次无法确定（约 30 秒）触发兜底
      // P0-3：chat 模式真实回复终态——提交后基线文本的净增长 + 连续稳定采样。
      let stableStreak = 0;
      let lastConversationText = conversationTextAfterSubmit;
      let observedMessageCount = initialMsgCount;
      let doubaoConfirmationCount = 0;
      let doubaoConfirmationStartedAt: number | undefined;
      let waitForAssistantAfterMessageCount: number | undefined;
      let lastConfirmedAssistantReply = '';
      let lastObservedAssistantReply = assistantReplyBeforeSubmit;
      let assistantReplyStableStreak = 0;
      let manualDoubaoConfirmationRequired = false;
      let manualDoubaoConfirmationAccepted = false;
      let manualDoubaoConfirmationBaselineCount = initialMsgCount;
      let manualDoubaoConfirmationBaselineText = conversationTextAfterSubmit;
      let doubaoWaitingStatePersisted = false;
      let paidQuotaConfirmed = false;
      let paidQuotaConfirmationStartedAt: number | undefined;

      let generationPollCount = 0;
      while (
        Date.now() - generationWaitStartedAt < generationWaitBudget
        && generationPollCount < generationAttemptLimit
      ) {
        generationPollCount += 1;
        await pause(TASK_TIMEOUT_POLICY.generationProbeIntervalMs);
        let assistantReplySettled = false;
        let waitingForPaidQuotaButton = false;
        try {
          const detail = await Promise.race([
            checkGeneratingDetailed(webview),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('检测超时')), 8000)),
          ]);
          assistantReplySettled = detail.status === 'detected' && !detail.generating;
          observedMessageCount = Math.max(observedMessageCount, detail.messageCount || 0);

          if (mode === 'image') {
            // 图片接口可能在页面先报告“生成结束”后才把原始地址写入缓存；
            // 每轮先读一次缓存，拿到可信地址即可立即结束等待。
            const cached = await getCachedImageUrls(webview);
            if (cached?.imageUrls.length) {
              imageUrls = cached.imageUrls;
              generating = false;
              console.log(`[Automation:${accountId}] 生成轮询中捕获原始图片: ${imageUrls.length} 个`);
              break;
            }
          }

          if (mode === 'chat') {
            // P0-3：只把“提交后基线文本的净增长 + 稳定终态”认定为助手回复。
            // 历史消息/欢迎语/推荐内容都落在提交后基线内，不计为回复；
            // 消息数量仅作补充证据，不单独作为完成依据。
            const currentConversationText = await getConversationText(webview);
            stableStreak = updateStableStreak(lastConversationText, currentConversationText, stableStreak);
            lastConversationText = currentConversationText;
            const networkFinished = detail.status === 'detected' && !detail.generating;
            const decision = evaluateTerminal({
              baselineText: conversationTextAfterSubmit,
              currentText: currentConversationText,
              networkFinished,
              messageCountDelta: Math.max(0, (detail.messageCount || 0) - initialMsgCount),
              stableStreak,
            });
            if (decision === 'completed') {
              console.log(`[Automation:${accountId}] 真实回复终态确认：基线后新增回复内容且已稳定`);
              generating = false;
            }
            unknownCount = 0;
          } else if (detail.status === 'detected') {
            // 明确检测到结果（video/image 保留既有语义）
            // 图片页面的生成状态会先于扩展原始地址结束；在有限宽限期内
            // 保持轮询，避免过早进入“未捕获图片”错误分支。
            generating = mode === 'image'
              ? Date.now() - generationWaitStartedAt < 90_000
              : detail.generating;
            unknownCount = 0;
          } else {
            // 无法确定，使用消息数量兜底（video/image）
            unknownCount++;
            const currentMsgCount = detail.messageCount || 0;
            // 如果消息数增加了（说明有新回复），且最新消息有产物或输入框可用，认为完成
            if (mode !== 'image' && unknownCount >= maxUnknown && currentMsgCount > initialMsgCount) {
              console.log(`[Automation:${accountId}] 兜底检测：消息数从 ${initialMsgCount} → ${currentMsgCount}，认为生成完成`);
              generating = false;
            }
            if (mode === 'image') {
              generating = Date.now() - generationWaitStartedAt < 90_000;
            } else if (unknownCount >= maxUnknown && !generating) {
              // 保持原消息计数路径的语义；无需额外读取。
            } else if (unknownCount >= maxUnknown) {
              const currentConversationText = await getConversationText(webview);
              if (conversationTextAfterSubmit && currentConversationText.length > conversationTextAfterSubmit.length && currentConversationText.startsWith(conversationTextAfterSubmit)) {
                console.log(`[Automation:${accountId}] 新版页面回读：会话内容已在提交后新增，认为生成完成`);
                generating = false;
              }
            }
          }
        } catch {
          unknownCount++;
          // JS 注入失败也计入 unknown
          if (unknownCount >= maxUnknown * 2) {
            console.warn(`[Automation:${accountId}] 连续 ${unknownCount} 次检测失败，继续等待`);
            unknownCount = maxUnknown; // 防止溢出
          }
        }
        if (mode === 'video') {
          // Dola 的额度拒绝通常出现在助手聊天消息，而不是 toast/dialog。
          // 只接受提交后新增（或消息计数已增加）的最新助手回复，避免用户提示词
          // 或历史消息中的“额度”文案触发错误改派。
          const latestAssistantReply = await getLatestAssistantReply(webview);
          const currentMessageCount = await getSubmissionMessageCount(webview);
          observedMessageCount = Math.max(observedMessageCount, currentMessageCount);
          const hasNewAssistantReply = latestAssistantReply !== assistantReplyBeforeSubmit
            || observedMessageCount > initialMsgCount;
          const paidQuotaConfirmationRequested = automationPlatform === 'doubao'
            && hasNewAssistantReply
            && isPaidQuotaConfirmationMessage(latestAssistantReply);
          const paidQuotaGenerationStarted = automationPlatform === 'doubao'
            && hasNewAssistantReply
            && isPaidQuotaGenerationStartedMessage(latestAssistantReply);
          if (paidQuotaConfirmationRequested) {
            generating = true;
            if (!paidQuotaConfirmed) {
              paidQuotaConfirmationStartedAt ??= Date.now();
              setAccountAutomationState(accountId, 'generating', '免费额度已用完，正在确认使用付费额度...', 'generating');
              const confirmed = await confirmDoubaoPaidQuotaUsage(webview);
              if (confirmed) {
                paidQuotaConfirmed = true;
                doubaoWaitingStatePersisted = true;
                await updateTaskRuntime(taskId, {
                  status: 'generating',
                  runtime: {
                    stage: 'generating',
                    message: '已确认使用付费额度，等待视频生成中...',
                    lastHeartbeatAt: new Date().toISOString(),
                  },
                });
              } else if (Date.now() - paidQuotaConfirmationStartedAt >= DOUBAO_PAID_QUOTA_CONFIRM_MAX_WINDOW_MS) {
                throw new SubmissionSafetyPauseError('已识别到付费额度确认请求，但 45 秒内未找到“确认生成”按钮；任务已暂停，请人工核对');
              } else {
                waitingForPaidQuotaButton = true;
              }
            }
          } else if (isQuotaExhaustedMessage(latestAssistantReply) && hasNewAssistantReply) {
            throw new Error(`平台返回额度不足：${latestAssistantReply}`);
          }
          imageUrls = await extractVideoOutputs(webview, taskConversationUrl, controller.signal, videoCaptureToken, automationPlatform);
          if (imageUrls.length > 0) {
            generating = false;
            break;
          }
          const blocker = await detectVideoGenerationBlocker(webview);
          const paidGenerationFreeQuotaNotice = paidQuotaGenerationStarted
            && /免费[^。！？\n]{0,24}(?:额度|次数)[^。！？\n]{0,16}(?:用完|用尽|耗尽|达到上限)/.test(blocker || '');
          if (blocker && !paidGenerationFreeQuotaNotice) throw new Error(`豆包已停止生成：${blocker}`);

          if (automationPlatform === 'doubao' && !paidQuotaConfirmationRequested) {
            if (latestAssistantReply && latestAssistantReply === lastObservedAssistantReply) {
              assistantReplyStableStreak += 1;
            } else {
              lastObservedAssistantReply = latestAssistantReply;
              assistantReplyStableStreak = 0;
            }
            const confirmationAction = manualDoubaoConfirmationRequired || manualDoubaoConfirmationAccepted
              ? decideManualDoubaoConfirmationAction({
                latestAssistantReply,
                currentMessageCount,
                baselineMessageCount: manualDoubaoConfirmationBaselineCount,
                baselineConversationText: manualDoubaoConfirmationBaselineText,
                currentConversationText: await getConversationText(webview),
              })
              : decideDoubaoVideoReplyAction({
                platform: automationPlatform,
                mode,
                latestAssistantReply,
                assistantReplyBeforeSubmit,
                currentMessageCount,
                initialMessageCount: initialMsgCount,
                waitForAssistantAfterMessageCount,
                lastConfirmedAssistantReply,
                replyStable: assistantReplySettled || assistantReplyStableStreak >= 1,
              });

            if (confirmationAction === 'wait_for_video') {
              generating = true;
              if (manualDoubaoConfirmationRequired) {
                manualDoubaoConfirmationRequired = false;
                manualDoubaoConfirmationAccepted = true;
              }
              setAccountAutomationState(accountId, 'generating', '豆包已进入视频生成等待，正在等待产物...', 'generating');
              if (!doubaoWaitingStatePersisted) {
                doubaoWaitingStatePersisted = true;
                await updateTaskRuntime(taskId, {
                  status: 'generating',
                  runtime: {
                    stage: 'generating',
                    message: '豆包已进入视频生成等待，正在等待产物...',
                    lastHeartbeatAt: new Date().toISOString(),
                  },
                });
              }
            } else if (confirmationAction === 'wait_for_user') {
              generating = true;
              setAccountAutomationState(accountId, 'generating', '等待你在当前豆包会话人工回复确认...', 'waiting_generation_confirmation');
              continue;
            } else if (confirmationAction === 'collect_video') {
              generating = false;
              setAccountAutomationState(accountId, 'generating', '豆包已报告视频生成完成，正在提取产物...', 'extracting_outputs');
            } else if (confirmationAction === 'send_confirmation') {
              const now = Date.now();
              doubaoConfirmationStartedAt ??= now;
              if (
                doubaoConfirmationCount >= DOUBAO_VIDEO_CONFIRM_MAX_ROUNDS
                || now - doubaoConfirmationStartedAt >= DOUBAO_VIDEO_CONFIRM_MAX_WINDOW_MS
              ) {
                const evidence = await inspectGenerationConfirmation(webview);
                throw new GenerationConfirmationPauseError(
                  evidence,
                  `豆包连续 ${doubaoConfirmationCount} 轮回复后仍未进入“视频生成中/预计等待”，已暂停防止异常循环`,
                );
              }

              const persistedConversationUrl = useTaskStore.getState().tasks
                .find((item) => item.id === taskId)?.runtime?.conversationUrl;
              const expectedConversationUrl = persistedConversationUrl || taskConversationUrl;
              const expectedConversationKeys = new Set(conversationUrlKeys(expectedConversationUrl));
              const stillInTaskConversation = conversationUrlKeys(webview.getURL())
                .some((key) => expectedConversationKeys.has(key));
              if (expectedConversationKeys.size === 0 || !stillInTaskConversation) {
                const currentConversationUrl = webview.getURL();
                const currentConversationText = await getConversationText(webview);
                const currentConversationMatchesTask = matchesSubmissionConversation(promptForSubmission, currentConversationText)
                  || matchesSubmissionConversation(prompt, currentConversationText);
                if (!currentConversationMatchesTask || !currentConversationUrl) {
                  throw new SubmissionSafetyPauseError('豆包会话已变化，当前会话未匹配本任务；请核对当前任务会话');
                }
                if (canFollowDoubaoInitialConversation({
                  previousUrl: expectedConversationUrl,
                  currentUrl: currentConversationUrl,
                  matchesTask: currentConversationMatchesTask,
                })) {
                  // 首次发送回执可能早于网址分配；只认本任务从 /chat 到具体会话
                  // 的一次变化。先保存绑定再确认，不放宽已有具体会话之间的隔离。
                  const conversationBound = await updateTaskRuntime(taskId, {
                    runtime: { conversationUrl: currentConversationUrl, lastHeartbeatAt: new Date().toISOString() },
                  });
                  if (!conversationBound) {
                    throw new SubmissionSafetyPauseError('豆包任务会话绑定保存失败，未发送自动确认；请核对原会话');
                  }
                  taskConversationUrl = currentConversationUrl;
                } else {
                  // 已有具体会话之间发生变化仍需人工确认，不能凭相似提示词自动发送。
                  taskConversationUrl = currentConversationUrl;
                  manualDoubaoConfirmationRequired = true;
                  manualDoubaoConfirmationAccepted = false;
                  manualDoubaoConfirmationBaselineCount = currentMessageCount;
                  manualDoubaoConfirmationBaselineText = currentConversationText;
                  const detectedAt = new Date().toISOString();
                  const waitingForManualConfirmationMessage = '豆包会话已变化，请在当前会话人工回复确认；回复后继续等待视频生成';
                  await updateTaskRuntime(taskId, {
                    status: 'waiting_generation_confirmation',
                    result: waitingForManualConfirmationMessage,
                    errorInfo: {
                      code: 'generation_confirmation_required',
                      message: waitingForManualConfirmationMessage,
                      recoverable: true,
                      detectedAt,
                    },
                    runtime: {
                      stage: 'waiting_generation_confirmation',
                      message: waitingForManualConfirmationMessage,
                      conversationUrl: currentConversationUrl,
                      lastHeartbeatAt: detectedAt,
                      generationConfirmation: {
                        detectedAt,
                        marker: 'confirm_before_generation',
                      },
                    },
                  });
                  setAccountAutomationState(accountId, 'generating', waitingForManualConfirmationMessage, 'waiting_generation_confirmation');
                  generating = true;
                  continue;
                }
              }

              const beforeConfirmationCount = currentMessageCount;
              const assistantReplyBeforeConfirmation = latestAssistantReply;
              const conversationTextBeforeConfirmation = await getConversationText(webview);
              setAccountAutomationState(
                accountId,
                'generating',
                `豆包请求继续确认，正在发送第 ${doubaoConfirmationCount + 1} 次确认...`,
                'generating',
              );
              const injected = await injectPrompt(webview, DOUBAO_VIDEO_CONFIRM_TEXT, 1);
              if (!injected || !await verifyPromptReadyForSubmission(webview, DOUBAO_VIDEO_CONFIRM_TEXT)) {
                throw new SubmissionSafetyPauseError('豆包自动确认写入或回读失败，未点击发送；请人工核对原会话');
              }
              const confirmationSubmitted = await submitGenerationConfirmationWithNativeClick(webview);
              if (!confirmationSubmitted) {
                throw new SubmissionSafetyPauseError('豆包自动确认点击结果不确定，系统不会重复发送；请人工核对原会话');
              }

              const confirmationReadbackDeadline = Date.now() + DOUBAO_VIDEO_CONFIRM_READBACK_MS;
              let confirmationMessageCount = beforeConfirmationCount;
              let confirmationPublished = false;
              while (Date.now() < confirmationReadbackDeadline) {
                await pause(SUBMISSION_READBACK_INTERVAL_MS);
                const [
                  currentConfirmationMessageCount,
                  confirmationStillInComposer,
                  currentAssistantReply,
                  currentConversationText,
                ] = await Promise.all([
                  getSubmissionMessageCount(webview),
                  verifyPromptReadyForSubmission(webview, DOUBAO_VIDEO_CONFIRM_TEXT),
                  getLatestAssistantReply(webview),
                  getConversationText(webview),
                ]);
                confirmationMessageCount = currentConfirmationMessageCount;
                if (hasDoubaoConfirmationReadback({
                  beforeMessageCount: beforeConfirmationCount,
                  currentMessageCount: confirmationMessageCount,
                  confirmationStillInComposer,
                  assistantReplyBeforeConfirmation,
                  latestAssistantReply: currentAssistantReply,
                  conversationTextBeforeConfirmation,
                  currentConversationText,
                })) {
                  confirmationPublished = true;
                  break;
                }
              }
              if (!confirmationPublished) {
                throw new SubmissionSafetyPauseError('豆包自动确认发送回执未确认，系统不会重复发送；请人工核对原会话');
              }

              doubaoConfirmationCount += 1;
              waitForAssistantAfterMessageCount = confirmationMessageCount;
              lastConfirmedAssistantReply = latestAssistantReply;
              assistantReplyStableStreak = 0;
              generating = true;
              await updateTaskRuntime(taskId, {
                status: 'generating',
                runtime: {
                  stage: 'generating',
                  message: `已自动确认 ${doubaoConfirmationCount} 次，等待豆包下一条回复...`,
                  lastHeartbeatAt: new Date().toISOString(),
                },
              });
              continue;
            } else {
              // 豆包视频在等首条回复或等确认后的下一条回复时，不得被通用的
              // “生成已结束”检测提前带入产物轮询。
              generating = true;
            }
          }
        }
        if (!generating) break;
        const elapsedSec = Math.round((Date.now() - generationWaitStartedAt) / 1000);
        const generationWaitMessage = waitingForPaidQuotaButton
          ? `等待付费额度确认按钮... (${elapsedSec}s)`
          : automationPlatform === 'doubao' && mode === 'video'
            ? getDoubaoGenerationWaitMessage(doubaoWaitingStatePersisted, elapsedSec)
          : `等待回复... (${elapsedSec}s)`;
        setAccountAutomationState(accountId, 'generating', generationWaitMessage, 'generating');
      }
      if (generating) {
        const limitMinutes = Math.round(generationWaitBudget / 60_000);
        throw new Error(`生成等待超时（上限 ${limitMinutes} 分钟，已检测 ${generationPollCount} 次），系统未自动重发`);
      }

      setAccountAutomationState(accountId, 'generating', '正在识别并绑定任务产物...', 'extracting_outputs');

      // 生成完成后获取产物
      if (mode === 'video') {
        // 视频生成耗时经常远超普通回复结束时间；以拿到视频地址为准。
        const maxVideoWaitMs = generationWaitBudget;
        const pollIntervalMs = TASK_TIMEOUT_POLICY.artifactPollIntervalMs;
        const startWait = generationWaitStartedAt;
        let pollCount = 0;
        let lastLogBucket = -1;

        let artifactPollCount = 0;
        while (
          imageUrls.length === 0
          && Date.now() - startWait < maxVideoWaitMs
          && artifactPollCount < artifactPollLimit()
        ) {
          artifactPollCount += 1;
          pollCount++;

          imageUrls = await extractVideoOutputs(webview, taskConversationUrl, controller.signal, videoCaptureToken, automationPlatform);
          if (imageUrls.length > 0) {
            console.log(`[Automation:${accountId}] 获取视频地址成功: ${imageUrls.length} 个`);
            break;
          }

          const blocker = await detectVideoGenerationBlocker(webview);
          if (blocker) {
            throw new Error(`豆包已停止生成：${blocker}`);
          }

          // 某些页面会先结束“生成中”状态，再把额度拒绝作为助手消息渲染；
          // 第二段产物轮询也要读取该消息，避免一直等到整小时超时。
          const latestAssistantReply = await getLatestAssistantReply(webview);
          const currentMessageCount = await getSubmissionMessageCount(webview);
          if (
            isQuotaExhaustedMessage(latestAssistantReply) &&
            (latestAssistantReply !== assistantReplyBeforeSubmit || currentMessageCount > initialMsgCount)
          ) {
            throw new Error(`平台返回额度不足：${latestAssistantReply}`);
          }

          const elapsedSec = Math.round((Date.now() - startWait) / 1000);
          const maxSec = Math.round(maxVideoWaitMs / 1000);
          const logBucket = Math.floor(elapsedSec / 60);
          if (logBucket !== lastLogBucket || pollCount <= 3) {
            console.log(`[Automation:${accountId}] 视频产物尚未就绪，继续等待 (${elapsedSec}/${maxSec}s, 第 ${pollCount} 次)`);
            lastLogBucket = logBucket;
          }
          setAccountAutomationState(accountId, 'generating', `等待视频产物... (${Math.floor(elapsedSec / 60)}/${Math.floor(maxSec / 60)}分钟)`, 'extracting_outputs');
          await pause(pollIntervalMs);
        }

        if (imageUrls.length === 0) {
          const limitMinutes = Math.round(maxVideoWaitMs / 60_000);
          throw new Error(`视频产物等待超时（上限 ${limitMinutes} 分钟，已轮询 ${artifactPollCount} 次），尚未获取到可下载地址；系统未自动重发`);
        }
      } else {
        // 图片模式只接受内置扩展从可信原始字段提取的地址，
        // 避免把页面展示用的带水印 <img> 归档到产物中心。
        if (mode === 'image') {
          for (let retry = 0; retry < TASK_TIMEOUT_POLICY.imageCaptureAttempts; retry++) {
            const cached = await getCachedImageUrls(webview);
            if (cached?.imageUrls.length) {
              imageUrls = cached.imageUrls;
              console.log(
                `[Automation:${accountId}] 使用扩展原始图片地址: ${imageUrls.length} 个, source=${cached.fieldSource || 'unknown'}`,
              );
              break;
            }
            if (retry + 1 < TASK_TIMEOUT_POLICY.imageCaptureAttempts) {
              await pause(TASK_TIMEOUT_POLICY.imageCaptureIntervalMs);
            }
          }
        }
        if (mode === 'image' && imageUrls.length === 0) {
          throw new Error('图片已生成，但扩展未捕获可信原始图片地址；为避免归档带水印图片，未保存展示图');
        }
      }
      const archiveOutputs = mode === 'image'
        ? normalizeImageArtifactUrls(imageUrls)
        : imageUrls;
      if (mode === 'video' && archiveOutputs.some(isExplicitlyWatermarkedVideoUrl)) {
        throw new Error('只检测到豆包带水印播放流；为避免归档带水印视频，本次未保存产物');
      }
      if (mode === 'image' && archiveOutputs.length === 0) {
        throw new Error('图片已生成，但未找到可归档的原始图片地址');
      }
      let conversationResult = '';
      if (mode === 'chat') {
        // 对话没有媒体 URL；只保存当前会话最后一条助手消息正文，
        // 不把导航、历史会话、用户消息或推荐问题写入任务 result。
        conversationResult = await getLatestAssistantReply(webview);
        if (!conversationResult) {
          console.warn(`[Automation:${accountId}] 未识别到明确的助手回复，保留空结果而不回退到整页文本`);
        }
      }
      console.log(`[Automation:${accountId}] 完成, 产物:`, archiveOutputs);
      if (controller.signal.aborted) {
        throw new DOMException('任务已取消', 'AbortError');
      }
      // 媒体任务仍传入第一个 URL 作为 result；对话任务只保存文本，
      // 不把普通回复误当成可下载产物。
      await completeAutomation(
        taskId,
        accountId,
        mode === 'chat' ? conversationResult : archiveOutputs[0] || '',
        archiveOutputs,
      );
      if (mode === 'video') {
        const quota = useAccountStore.getState().accounts.find((account) => account.id === accountId)?.seedanceQuota;
        const usageUnits = getVideoQuotaUsageUnits(videoConfig?.duration, quota);
        await useAccountStore.getState().recordSeedanceUsage(accountId, usageUnits);
      }
      await useAccountStore.getState().recordAccountOutcome(accountId, 'success');
    } catch (err: any) {
      const cancelled = controller.signal.aborted;
      const abortReason = cancelled ? readAutomationAbortReason(controller.signal) : undefined;
      const userInitiatedAbort = cancelled && (
        abortReason?.code === 'user_pause' ||
        abortReason?.code === 'user_cancel' ||
        (!abortReason && pendingCancellationStatusRef.current.has(taskId))
      );
      const safetyPaused = err instanceof SubmissionSafetyPauseError;
      const persistencePaused = err instanceof SubmissionPersistenceError;
      const preSubmitSendFailure = err instanceof PreSubmitSendFailureError;
      const availabilityPaused = err instanceof AccountAvailabilityPauseError;
      const confirmationPaused = err instanceof GenerationConfirmationPauseError;
      const errorCodeFromError = typeof err?.code === 'string' ? err.code : '';
      const controlReadinessFailure = err instanceof VideoControlReadinessError
        || err instanceof DolaVideoControlReadinessError
        || /^dola_video_(?:duration|model|ratio|ratio_menu|more|control)$/.test(errorCodeFromError)
        || /^video_(?:mode_entry|model_control|composite_control|stable_readback|final_readback)_not_ready$/.test(errorCodeFromError);
      const errorMessage = cancelled
        ? abortReason?.message || (userInitiatedAbort ? '用户已取消等待' : '自动化被内部中止，任务未完成')
        : (err.message || String(err));
      const artifactArchivePaused = mode === 'video' && (
        err?.code === 'artifact_download_failed'
        || /自动保存到产物中心失败|任务产物登记失败|任务完成状态写入失败/.test(errorMessage)
      );
      const transientErrorCode = classifyTransientAutomationError(errorMessage);
      const effectiveErrorCode = errorCodeFromError || transientErrorCode;
      const transientAutomationFailure = Boolean(transientErrorCode)
        || isTransientAutomationErrorCode(effectiveErrorCode);
      const errorInfo = controlReadinessFailure || transientAutomationFailure || preSubmitSendFailure
        ? { code: effectiveErrorCode || 'unknown', message: errorMessage, recoverable: true, detectedAt: new Date().toISOString() }
        : cancelled && !userInitiatedAbort
          ? { code: abortReason?.code || 'internal_abort', message: errorMessage, recoverable: true, detectedAt: new Date().toISOString() }
          : classifyTaskError(errorMessage);
      const recoveryErrorCode = availabilityPaused ? err.code : errorInfo.code;
      const latestTaskBeforeRecovery = useTaskStore.getState().tasks.find((item) => item.id === taskId);
      const preSubmitAutoSwitchCandidate = latestTaskBeforeRecovery && canAutoSwitchBeforeSubmission({
        errorCode: recoveryErrorCode,
        submittedAt: latestTaskBeforeRecovery.runtime?.submittedAt,
        submissionConfirmedAt: latestTaskBeforeRecovery.runtime?.submissionConfirmedAt,
        submissionIntentAt: latestTaskBeforeRecovery.runtime?.submissionIntentAt,
        cancelled,
        userInitiatedAbort,
        safetyPaused,
        persistencePaused,
        confirmationPaused,
        artifactArchivePaused,
      })
        ? selectPreSubmitFallbackAccount(
            latestTaskBeforeRecovery,
            useTaskStore.getState().tasks,
            useAccountStore.getState().accounts,
            accountId,
          )
        : null;
      const preSubmitAutoSwitch = Boolean(preSubmitAutoSwitchCandidate);
      // 限制类失败（会员/额度/真人脸/内容审核）不扣减 Seedance 额度，
      // 也不应继续等待视频产物。recordSeedanceUsage 仅在成功路径调用。
      if (mode === 'video' && isRestrictionFailure(errorInfo.code)) {
        console.warn(`[Automation:${accountId}] 检测到限制类失败(${errorInfo.code})，不扣减额度`);
      }
      const quotaExhausted = mode === 'video' && errorInfo.code === 'quota_exhausted';
      if (quotaExhausted) await useAccountStore.getState().markSeedanceExhausted(accountId);
      if (!preSubmitAutoSwitch && !cancelled && !safetyPaused && !persistencePaused && !artifactArchivePaused && !availabilityPaused && !confirmationPaused && !controlReadinessFailure && !transientAutomationFailure) {
        await useAccountStore.getState().recordAccountOutcome(accountId, 'failure', errorInfo.code);
      }
      console.error(`[Automation:${accountId}] ${cancelled || safetyPaused || persistencePaused || artifactArchivePaused || availabilityPaused || confirmationPaused || controlReadinessFailure || transientAutomationFailure ? (userInitiatedAbort ? '已暂停' : '已中止') : '失败'}:`, errorMessage);
      if (preSubmitAutoSwitch) {
        const replacementAccountId = preSubmitAutoSwitchCandidate!;
        const replacementAccount = useAccountStore.getState().accounts.find((item) => item.id === replacementAccountId);
        const switchMessage = `原账号${availabilityPaused ? '掉线或不可用' : '未能完成提交'}，已切换到「${replacementAccount?.name || replacementAccountId}」并重新排队`;
        useAccountStore.getState().selectAccount(replacementAccountId);
        await useAccountStore.getState().recordAccountOutcome(accountId, 'failure', recoveryErrorCode);
        setAccountAutomationState(accountId, 'failed', switchMessage, 'failed');
        await failAutomation(taskId, accountId, switchMessage, {
          ...errorInfo,
          code: recoveryErrorCode,
          message: switchMessage,
        });
        const recovered = expectedRunId
          ? await retryAfterPreSubmitFailure(taskId, expectedRunId, replacementAccountId)
          : false;
        if (recovered) {
          message.warning(switchMessage);
        } else {
          message.error('原账号提交前失败，但自动切号未完成；任务已停止，请检查可用账号后重试');
          console.warn(`[Automation:${accountId}] 提交前自动改派未执行：任务状态或运行标识已变化`);
        }
      } else if (cancelled || safetyPaused || persistencePaused || artifactArchivePaused || availabilityPaused || confirmationPaused || controlReadinessFailure || transientAutomationFailure) {
        const requestedCancellationStatus = pendingCancellationStatusRef.current.get(taskId);
        try {
          await pauseAutomation(
            taskId,
            accountId,
            userInitiatedAbort && requestedCancellationStatus === 'cancelled'
              ? '任务已由本机控制面取消'
              : artifactArchivePaused
                ? '视频已生成，但本地无水印素材归档失败；任务保持暂停，核对时不会重新发送'
                : persistencePaused
                ? '任务状态写入失败，未执行页面提交；请检查磁盘空间和数据目录权限'
              : controlReadinessFailure || transientAutomationFailure
                ? controlReadinessFailure
                  ? `视频控件仍在加载，任务保持等待；页面稳定后将在原账号自动恢复（最多 ${MAX_VIDEO_CONTROL_RECOVERY_ATTEMPTS} 次）`
                  : '页面仍在加载，任务保持等待；页面稳定后将在原账号自动恢复'
                : errorMessage,
            confirmationPaused
              ? {
                  status: 'waiting_generation_confirmation',
                  code: 'generation_confirmation_required',
                  generationConfirmation: {
                    detectedAt: err.evidence.detectedAt,
                    marker: err.evidence.marker || 'confirm_before_generation',
                    model: err.evidence.model,
                    duration: err.evidence.duration,
                    aspectRatio: err.evidence.aspectRatio,
                  },
                }
              : controlReadinessFailure || transientAutomationFailure
              ? { status: 'waiting_verification', code: recoveryErrorCode }
              : availabilityPaused
              ? { status: 'waiting_verification', code: err.code }
              : artifactArchivePaused
                ? { status: 'paused', code: 'artifact_download_failed' }
                : persistencePaused
                ? { status: 'paused', code: 'runtime_persistence_failed' }
                : safetyPaused
                  ? { status: 'paused', code: 'submission_uncertain' }
                  : userInitiatedAbort && requestedCancellationStatus === 'cancelled'
                    ? { status: 'cancelled', code: 'cancelled' }
                    : cancelled && !userInitiatedAbort
                      ? { status: 'paused', code: abortReason?.code || 'internal_abort' }
                      : undefined,
          );
        } catch (pauseError: unknown) {
          // 任务状态无法落盘时，不清除本地执行占用，不伪装成已暂停；
          // finally 会继续走资源清理，但 UI 会保留错误提示，等待用户修复数据目录。
          const pauseReason = pauseError instanceof Error ? pauseError.message : String(pauseError);
          console.error(`[Automation:${accountId}] 暂停状态持久化失败:`, pauseReason);
          useTaskStore.getState().setAccountAutomationState(
            accountId,
            'failed',
            '任务状态写入失败，执行锁未确认释放；请检查数据目录权限',
            'failed',
          );
        }
      } else {
        setAccountAutomationState(accountId, 'failed', errorMessage, 'failed');
        await failAutomation(taskId, accountId, errorMessage, errorInfo);
        if (quotaExhausted) {
          const state = useTaskStore.getState();
          const failedTask = state.tasks.find((item) => item.id === taskId);
          const fallbackAccountId = failedTask ? selectQuotaFallbackAccount(
            failedTask,
            state.tasks,
            useAccountStore.getState().accounts,
            accountId,
          ) : null;
          const recovered = expectedRunId
            ? await retryAfterQuotaExhaustion(taskId, expectedRunId, fallbackAccountId)
            : false;
          if (recovered && fallbackAccountId) {
            message.warning('原账号视频额度已清零，任务已安全改派到其他可用账号');
          } else if (recovered) {
            message.warning('原账号视频额度已清零；暂无替代账号，任务保留排队等待次日 00:00 刷新');
          } else {
            console.warn(`[Automation:${accountId}] 额度恢复未执行：任务状态或运行标识已变化`);
          }
        }
      }

      const restartTask = pendingRestartTasksRef.current.get(taskId);
      if (restartTask) {
        pendingRestartTasksRef.current.delete(taskId);
        const updated = await updateTask(taskId, restartTask);
        if (updated) message.success('提示词已更新，任务已重新加入队列');
      }
    } finally {
      initializationLease?.release();
      notification.destroy(materialAuthorizationNotificationKey);
      abortControllersRef.current.delete(taskId);
      pendingRestartTasksRef.current.delete(taskId);
      pendingCancellationStatusRef.current.delete(taskId);
      runningRef.current.delete(accountId);
      await automationEngine.release(taskId);
      setTimeout(() => useTaskStore.getState().processQueue(), 0);
    }
  };

  // ---- 导航 ----
  const getActiveWebview = useCallback(() => {
    if (!activeAccount) return null;
    return registryRef.current.get(activeAccount.id) || null;
  }, [activeAccount]);

  const handleRefresh = useCallback(() => { getActiveWebview()?.reload(); }, [getActiveWebview]);
  const handleGoBack = useCallback(() => { const w = getActiveWebview(); if (w?.canGoBack()) w.goBack(); }, [getActiveWebview]);
  const handleGoForward = useCallback(() => { const w = getActiveWebview(); if (w?.canGoForward()) w.goForward(); }, [getActiveWebview]);
  const handleGoHome = useCallback(() => {
    if (activeAccount) getActiveWebview()?.loadURL(getAccountHome(activeAccount));
  }, [activeAccount, getActiveWebview]);

  const showOverlay = activeAutoState && activeAutoState !== 'idle' && activeAutoState !== 'completed' && activeAutoState !== 'failed';

  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        <div className="browser-nav-buttons">
          <button onClick={handleGoBack} title="后退">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.5 3L5.5 8l5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button onClick={handleGoForward} title="前进">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.5 3l5 5-5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button onClick={handleRefresh} title="刷新">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.5 8a5.5 5.5 0 00-10-2.5M2.5 8a5.5 5.5 0 0010 2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
              <path d="M2 3v3h3M14 13v-3h-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button onClick={handleGoHome} title={`回到${activeAccount?.platform === 'dola' ? ' Dola' : '豆包'}首页`}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 6l6-4.5L14 6v7.5a.5.5 0 01-.5.5h-3.5V9H6v5H2.5a.5.5 0 01-.5-.5V6z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <div className="browser-url-bar">
          <span className="browser-url-text">{activeAccount ? getAccountHost(activeAccount) : 'doubao.com'}</span>
        </div>
        <Tooltip title="粘贴豆包公开分享链接，下载该页面实际公开提供的视频流；不移除平台水印">
          <button
            onClick={() => setPublicShareDialogOpen(true)}
            title="解析公开分享链接"
            disabled={manualVideoExtracting}
            style={{
              width: 30,
              height: 30,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#b8b4ff',
              opacity: manualVideoExtracting ? 0.45 : 1,
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip title="从当前账号的可见对话提取视频；实验直取仅在右侧开关显式开启后参与">
          <button
            onClick={() => void handleExtractCurrentVideo()}
            title="提取当前对话视频"
            disabled={manualVideoExtracting || !activeAccount || !!(activeAccount && accountBusy[activeAccount.id])}
            style={{
              width: 30,
              height: 30,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: experimentalNoWatermark ? '#f59e0b' : '#b8b4ff',
              opacity: manualVideoExtracting || !activeAccount || !!(activeAccount && accountBusy[activeAccount.id]) ? 0.45 : 1,
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 6h16v12H4zM9 9l6 3-6 3V9z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip
          title={experimentalNoWatermark
            ? '实验直取已开启：手动提取可能触发平台风控'
            : '实验直取默认关闭；开启需确认平台条款与账号风险'}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 4 }}>
            <Switch
              size="small"
              checked={experimentalNoWatermark}
              onChange={toggleExperimentalNoWatermark}
              style={{ transform: 'scale(0.8)' }}
            />
            <span style={{ fontSize: 10, color: experimentalNoWatermark ? '#f59e0b' : '#8a8f99', whiteSpace: 'nowrap' }}>
              实验直取
            </span>
          </span>
        </Tooltip>
      </div>

      <Modal
        open={publicShareDialogOpen}
        title="解析公开分享链接"
        okText="解析并下载公开流"
        cancelText="取消"
        confirmLoading={manualVideoExtracting}
        onOk={() => void handleDownloadPublicShareMedia()}
        onCancel={() => !manualVideoExtracting && setPublicShareDialogOpen(false)}
      >
        <p style={{ color: '#9898b8' }}>仅解析豆包公开分享页实际声明的媒体流，不使用账号 Cookie，不探测隐藏接口，也不会移除水印。</p>
        <Input
          value={publicShareUrl}
          onChange={(event) => setPublicShareUrl(event.target.value)}
          placeholder="粘贴 https://www.doubao.com/... 公开分享链接"
          autoFocus
        />
      </Modal>

      <div className="browser-viewport">
        {!activeAccount && (
          <div className="browser-panel-empty" style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
            <div className="browser-empty-content"><p>正在为任务准备账号页面…</p></div>
          </div>
        )}
        {activeLoading && (
          <div className="browser-loading-overlay">
            <div className="browser-loading-spinner" />
            <span>{loadText}</span>
          </div>
        )}

        {showOverlay && (
          <div className="automation-overlay">
            <div className="automation-indicator">
              <div className="automation-spinner" />
              <span>{activeAutoMsg}</span>
            </div>
          </div>
        )}

        {activeAutoState === 'completed' && (
          <div className="automation-toast completed">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="8" stroke="#34d399" strokeWidth="2" />
              <path d="M5.5 9l2.5 2.5 4.5-5" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{activeAutoMsg}</span>
          </div>
        )}

        {activeAutoState === 'failed' && (
          <div className="automation-toast failed">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="8" stroke="#fb7185" strokeWidth="2" />
              <path d="M6 6l6 6M12 6l-6 6" stroke="#fb7185" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>执行失败: {activeAutoMsg}</span>
          </div>
        )}

        <div
          ref={poolRef}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
};

function waitForWebviewReady(webview: HTMLWebViewElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const poll = async () => {
      if (Date.now() - startTime >= timeoutMs) {
        reject(new Error('页面就绪检测超时（' + timeoutMs + 'ms）'));
        return;
      }
      try {
        const ready = await waitForChatReady(webview, 3000);
        if (ready) resolve();
        else setTimeout(poll, 1000);
      } catch {
        setTimeout(poll, 1000);
      }
    };
    poll();
  });
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('任务已取消', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, ms);
    const handleAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('任务已取消', 'AbortError'));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

export default BrowserPanel;
