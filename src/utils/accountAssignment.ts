import type { Account, AccountPlatform, GenerationMode, VideoDuration } from '../types';
import { getAutomaticSchedulingBlockReason } from './schedulingScore';
import { getVideoQuotaUsageUnits } from './videoQuota';

export interface ManualAssignmentOption {
  value: string;
  label: string;
  automaticBlockReason: string | null;
}

/** 手动指派只列出任务目标平台的账号；自动调度阻塞只作为说明，不删除同平台选项。 */
export function buildManualAssignmentOptions(
  accounts: readonly Account[],
  targetPlatform: AccountPlatform,
  mode: GenerationMode,
  duration?: VideoDuration,
  now: number = Date.now(),
): ManualAssignmentOption[] {
  return accounts
    .filter((account) => (account.platform || 'doubao') === targetPlatform)
    .map((account) => {
      const requiredUnits = mode === 'video' ? getVideoQuotaUsageUnits(duration, account.seedanceQuota) : 1;
      const automaticBlockReason = getAutomaticSchedulingBlockReason(account, mode, requiredUnits, 0, now);
      const platform = (account.platform || 'doubao') === 'dola' ? 'Dola' : '豆包';
      return {
        value: account.id,
        label: `${account.name} · ${platform}${automaticBlockReason ? ` · ${automaticBlockReason}` : ''}`,
        automaticBlockReason,
      };
    });
}
