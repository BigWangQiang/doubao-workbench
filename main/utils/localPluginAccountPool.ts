import type { Account, Task, TaskAddParams } from '@doubao-studio/contracts';
import { selectAccountForRemoteTask } from '../services/lalorRemoteTaskBridge';

const LOAD_STATUSES = new Set<Task['status']>([
  'queued',
  'executing',
  'generating',
  'waiting_verification',
  'waiting_generation_confirmation',
  'manual_submission_observing',
]);

/**
 * 从指定渠道的可用账号池中选择排队负载最低的账号。
 * 候选资格复用网站任务已经验证过的登录、冷却、额度和平台门禁，
 * 但这里只读其纯选择函数，不改变网站任务桥的行为。
 */
export function selectAccountFromLocalPluginPool(
  accounts: readonly Account[],
  tasks: readonly Task[],
  params: TaskAddParams,
  now: number = Date.now(),
): Account | null {
  const excluded = new Set<string>();
  const candidates: Account[] = [];
  while (excluded.size < accounts.length) {
    const account = selectAccountForRemoteTask(accounts, tasks, params, excluded, now);
    if (!account) break;
    candidates.push(account);
    excluded.add(account.id);
  }
  if (!candidates.length) return null;

  const load = new Map<string, number>();
  for (const task of tasks) {
    if (!task.assignedAccountId || !LOAD_STATUSES.has(task.status)) continue;
    load.set(task.assignedAccountId, (load.get(task.assignedAccountId) || 0) + 1);
  }
  candidates.sort((left, right) => (load.get(left.id) || 0) - (load.get(right.id) || 0));
  return candidates[0];
}
