import type { Account, Task } from '../types';
import { buildAutoAssignmentPlan } from './autoAssignment';
import { isTransientAutomationErrorCode } from './errorClassification';

export interface PreSubmitFailureContext {
  errorCode?: string;
  submittedAt?: string;
  submissionConfirmedAt?: string;
  submissionIntentAt?: string;
  cancelled?: boolean;
  userInitiatedAbort?: boolean;
  safetyPaused?: boolean;
  persistencePaused?: boolean;
  confirmationPaused?: boolean;
  artifactArchivePaused?: boolean;
}

/**
 * 页面/控件尚未稳定时的提交前错误。它们不代表账号掉线，不能触发切号；
 * 调用方应把任务放回等待验证状态，待页面恢复后在原账号重试。
 */
function isTransientPreSubmitCode(errorCode: string | undefined): boolean {
  return isTransientAutomationErrorCode(errorCode);
}

/**
 * 只有明确的账号级故障才允许提交前自动切号。
 *
 * 页面加载、编辑器/视频控件挂载和动态菜单动画属于瞬态会话状态；这些错误
 * 留在原账号等待恢复，避免把正常账号误判成掉线并造成失败、取消、重排队。
 */
export function canAutoSwitchBeforeSubmission(context: PreSubmitFailureContext): boolean {
  if (context.submittedAt || context.submissionConfirmedAt || context.cancelled || context.userInitiatedAbort) return false;
  if (context.safetyPaused || context.persistencePaused || context.confirmationPaused || context.artifactArchivePaused) return false;
  if (isTransientPreSubmitCode(context.errorCode)) return false;
  // 只允许平台给出明确账号级证据时切号。未知、网络、提交失败和页面
  // 状态错误都留在原账号等待恢复，避免正常账号刷新后被误判掉线。
  const confirmedAccountFailureCodes = new Set([
    'login_required',
    'account_unavailable',
    'unavailable',
    'platform_unavailable',
    'platform_mismatch',
    'region_restricted',
    'quota_exhausted',
    'membership_required',
    'face_restricted',
    'content_rejected',
  ]);
  if (!confirmedAccountFailureCodes.has(context.errorCode || '')) return false;
  const manualOrUncertainCodes = new Set([
    'human_verification',
    'verification',
    'material_authorization_required',
    'submission_uncertain',
    'generation_confirmation_required',
    'manual_review_required',
    'runtime_persistence_failed',
    'runtime_persistence_timeout',
    'internal_abort',
    'user_pause',
    'user_cancel',
    'component_unmounted',
  ]);
  return !manualOrUncertainCodes.has(context.errorCode || '');
}

/**
 * 选择提交前失败后的替代账号；永远排除刚刚失败的账号，并复用统一的
 * 平台、可用性、冷却和视频额度评分。候选账号必须已经通过可用性检测。
 */
export function selectPreSubmitFallbackAccount(
  task: Task,
  allTasks: readonly Task[],
  accounts: readonly Account[],
  failedAccountId: string,
  now: number = Date.now(),
): string | null {
  const candidate: Task = { ...task, assignedAccountId: null, status: 'queued' };
  const plan = buildAutoAssignmentPlan(
    [candidate],
    allTasks.filter((item) => item.id !== task.id),
    accounts.filter((account) => account.id !== failedAccountId),
    now,
  );
  return plan.assignments[0]?.accountId ?? null;
}

/** 额度明确耗尽后的替代账号选择；保留旧调用方名称。 */
export function selectQuotaFallbackAccount(
  task: Task,
  allTasks: readonly Task[],
  accounts: readonly Account[],
  exhaustedAccountId: string,
  now: number = Date.now(),
): string | null {
  return selectPreSubmitFallbackAccount(task, allTasks, accounts, exhaustedAccountId, now);
}
