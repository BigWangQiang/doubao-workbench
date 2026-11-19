/**
 * 提交后的验证层判定。
 *
 * 平台在验证完成后有时不会立即移除旧的 iframe/弹层节点。这个模块只做
 * 纯状态判定：有可靠的生成证据时继续沿当前任务等待产物；只有验证层且
 * 没有任何生成证据时才把任务交给人工处理。它不会执行页面操作，也不会
 * 绕过验证码。
 */

import { isTransientAutomationErrorCode } from './errorClassification';

export interface PostSubmitGenerationEvidence {
  /** 页面上仍存在可见的人机/安全验证层。 */
  verificationVisible: boolean;
  /** 会话中出现平台生成提交/完成回执。 */
  generationReceipt: boolean;
  /** 网络监控或明确的生成中控件表明任务正在生成。 */
  generationActive: boolean;
  /** 当前会话已出现真实 video 元素、缓存媒体或视频下载控件。 */
  videoOutput: boolean;
}

export type PostSubmitVerificationDecision =
  | 'continue_generation'
  | 'pause_for_verification';

/**
 * 只在“验证层存在且没有生成证据”时暂停。
 *
 * 这里使用显式布尔证据而不是页面全文匹配，避免用户提示词中的“生成”或
 * 验证完成后残留 DOM 把已提交任务误判为人工阻断。
 */
export function decidePostSubmitVerification(
  evidence: PostSubmitGenerationEvidence,
): PostSubmitVerificationDecision {
  if (!evidence.verificationVisible) return 'continue_generation';
  if (evidence.generationReceipt || evidence.generationActive || evidence.videoOutput) {
    return 'continue_generation';
  }
  return 'pause_for_verification';
}

export function hasPostSubmitGenerationEvidence(
  evidence: PostSubmitGenerationEvidence,
): boolean {
  return evidence.generationReceipt || evidence.generationActive || evidence.videoOutput;
}

/**
 * 验证层消失后，决定 waiting_verification 任务的安全恢复路径。
 *
 * 人机验证和提交前的瞬时页面未就绪可在页面恢复后自动处理；其它“等待人工”
 * 状态（素材授权、生成参数确认等）仍交给各自的专用流程。没有 submittedAt
 * 表示页面尚未产生不可逆提交，可以重新入队；已经留下 submittedAt 的人机
 * 验证任务只能回到原会话做只读核对，绝不能 retry 或再次点击发送。
 */
export interface VerificationRecoveryTask {
  status?: string;
  errorCode?: string;
  submittedAt?: string;
  submissionConfirmedAt?: string;
  submissionIntentAt?: string;
  humanVerificationRetryCount?: number;
  attempt?: number;
}

export type VerificationRecoveryDecision =
  | 'none'
  | 'retry_unsubmitted'
  | 'reconcile_submitted';

const SUBMITTED_RECONCILIATION_CODES = new Set([
  'startup_reconcile_required',
]);

export const MAX_TRANSIENT_PRE_SUBMIT_ATTEMPTS = 3;
/** 视频控件加载较慢时给同一账号更长的有界恢复窗口。 */
export const MAX_VIDEO_CONTROL_RECOVERY_ATTEMPTS = 8;

const VIDEO_CONTROL_RECOVERY_CODES = new Set([
  'video_mode_entry_not_ready',
  'video_model_control_not_ready',
  'video_composite_control_not_ready',
  'video_stable_readback_not_ready',
  'video_final_readback_not_ready',
  'dola_video_duration',
  'dola_video_model',
  'dola_video_ratio',
  'dola_video_ratio_menu',
  'dola_video_more',
  'dola_video_control',
]);

function hasConfirmedSubmission(task: VerificationRecoveryTask): boolean {
  // submittedAt 是旧版本字段；旧数据按“已提交”处理，避免升级后重复发送。
  return Boolean(task.submittedAt || task.submissionConfirmedAt);
}

export function decideVerificationRecovery(
  task: VerificationRecoveryTask | undefined,
): VerificationRecoveryDecision {
  if (!task || task.status !== 'waiting_verification') return 'none';
  if (task.errorCode && SUBMITTED_RECONCILIATION_CODES.has(task.errorCode)) {
    return hasConfirmedSubmission(task) ? 'reconcile_submitted' : 'retry_unsubmitted';
  }
  if (task.errorCode === 'human_verification') {
    if (hasConfirmedSubmission(task)) return 'reconcile_submitted';
    return (task.humanVerificationRetryCount || 0) < 1 ? 'retry_unsubmitted' : 'none';
  }
  if (!hasConfirmedSubmission(task) && isTransientAutomationErrorCode(task.errorCode)) {
    const maxAttempts = VIDEO_CONTROL_RECOVERY_CODES.has(task.errorCode || '')
      ? MAX_VIDEO_CONTROL_RECOVERY_ATTEMPTS
      : MAX_TRANSIENT_PRE_SUBMIT_ATTEMPTS;
    return Math.max(0, task.attempt || 0) < maxAttempts
      ? 'retry_unsubmitted'
      : 'none';
  }
  return 'none';
}

export interface StartupRecoveryTask {
  status?: string;
  mode?: string;
  submittedAt?: string;
  conversationUrl?: string;
}

export type StartupRecoveryDecision =
  | 'none'
  | 'preserve_waiting'
  | 'reconcile_submitted_video'
  | 'pause_interrupted';

/**
 * 应用重载不能把已由平台接收的视频降级成普通可重试任务。
 * 有原会话证据时只读续查；人工等待态原样保留；其余运行中任务安全暂停。
 */
export function decideStartupRecovery(task: StartupRecoveryTask | undefined): StartupRecoveryDecision {
  if (!task) return 'none';
  if (task.status === 'waiting_verification' || task.status === 'waiting_generation_confirmation') {
    return 'preserve_waiting';
  }
  const interruptible = task.status === 'executing'
    || task.status === 'generating'
    || task.status === 'manual_submission_observing';
  if (!interruptible) return 'none';
  if (task.mode === 'video' && task.submittedAt && task.conversationUrl) {
    return 'reconcile_submitted_video';
  }
  return 'pause_interrupted';
}
