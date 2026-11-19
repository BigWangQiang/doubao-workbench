import type { AccountHealth, AccountVideoQuotaAction, SeedanceQuota } from '@doubao-studio/contracts';

/** 旧账号未配置额度时使用的兼容默认值。 */
export const VIDEO_DAILY_UNITS = 6;

/** 本机时区自然日键；跨过本地 00:00 即进入新一日。 */
export function localDateKey(now: Date = new Date()): string {
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export function applyVideoQuotaAction(
  quota: SeedanceQuota,
  action: AccountVideoQuotaAction,
  units: number | undefined,
  updatedAt: string,
): SeedanceQuota {
  const totalUnits = Number.isFinite(quota.estimatedTotalUnits) && quota.estimatedTotalUnits > 0
    ? Math.max(1, Math.round(quota.estimatedTotalUnits))
    : VIDEO_DAILY_UNITS;
  const usedUnits = action === 'reset'
    ? 0
    : action === 'exhausted'
      ? Math.max(quota.usedUnits, totalUnits)
      : quota.usedUnits + Math.max(1, Math.round(units || 1));
  return {
    ...quota,
    usedUnits,
    estimatedTotalUnits: totalUnits,
    exhausted: action !== 'reset' && (action === 'exhausted' || usedUnits >= totalUnits),
    updatedAt,
  };
}

/** 仅清除由本地额度误判产生的健康状态，不触碰登录、验证或其他错误。 */
export function releaseQuotaExhaustionHealth(health: AccountHealth): AccountHealth {
  if (health.lastErrorCode !== 'quota_exhausted') return health;
  return {
    ...health,
    consecutiveFailures: 0,
    lastErrorCode: undefined,
    cooldownUntil: undefined,
  };
}
