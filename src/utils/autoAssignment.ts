import type { Account, Task } from '../types';
import { getAccountSchedulingScore } from './schedulingScore';
import { getVideoQuotaUsageUnits } from './videoQuota';

const ACTIVE_STATUSES = new Set<Task['status']>(['queued', 'executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing']);

export interface AutoAssignmentPlan {
  assignments: Array<{ taskId: string; accountId: string }>;
  unassignedTaskIds: string[];
}

/** 为一批新任务生成确定性账号计划，并同时预留尚未扣除的视频额度。 */
export function buildAutoAssignmentPlan(
  newTasks: readonly Task[],
  existingTasks: readonly Task[],
  accounts: readonly Account[],
  now: number = Date.now(),
): AutoAssignmentPlan {
  const accountLoad: Record<string, number> = {};
  const reservedVideoUnits: Record<string, number> = {};
  accounts.forEach((account) => {
    accountLoad[account.id] = 0;
    reservedVideoUnits[account.id] = 0;
  });
  const accountsById = new Map(accounts.map((account) => [account.id, account]));

  const seen = new Set<string>();
  for (const task of [...existingTasks, ...newTasks]) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    if (!task.assignedAccountId || !ACTIVE_STATUSES.has(task.status)) continue;
    accountLoad[task.assignedAccountId] = (accountLoad[task.assignedAccountId] || 0) + 1;
    if (task.mode === 'video') {
      const assignedAccount = accountsById.get(task.assignedAccountId);
      reservedVideoUnits[task.assignedAccountId] = (reservedVideoUnits[task.assignedAccountId] || 0) +
        getVideoQuotaUsageUnits(task.videoConfig?.duration, assignedAccount?.seedanceQuota);
    }
  }

  const assignments: AutoAssignmentPlan['assignments'] = [];
  const unassignedTaskIds: string[] = [];
  for (const task of newTasks) {
    if (task.assignedAccountId) continue;
    const targetPlatform = task.targetPlatform || 'doubao';
    const ranked = accounts
      .filter((account) => (account.platform || 'doubao') === targetPlatform)
      .map((account) => {
        const requiredUnits = task.mode === 'video'
          ? getVideoQuotaUsageUnits(task.videoConfig?.duration, account.seedanceQuota)
          : 1;
        return {
          account,
          requiredUnits,
          score: getAccountSchedulingScore(
            account,
            accountLoad[account.id] || 0,
            task.mode,
            now,
            requiredUnits,
            reservedVideoUnits[account.id] || 0,
          ),
        };
      })
      .filter(({ score }) => Number.isFinite(score))
      .sort((left, right) => left.score - right.score || left.account.id.localeCompare(right.account.id));
    const selected = ranked[0];
    if (!selected) {
      unassignedTaskIds.push(task.id);
      continue;
    }
    assignments.push({ taskId: task.id, accountId: selected.account.id });
    accountLoad[selected.account.id] = (accountLoad[selected.account.id] || 0) + 1;
    if (task.mode === 'video') {
      reservedVideoUnits[selected.account.id] = (reservedVideoUnits[selected.account.id] || 0) + selected.requiredUnits;
    }
  }
  return { assignments, unassignedTaskIds };
}
