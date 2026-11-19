import { describe, expect, it } from 'vitest';
import { applyVideoQuotaAction, releaseQuotaExhaustionHealth, VIDEO_DAILY_UNITS } from '../../main/utils/videoQuota';
import type { AccountHealth, SeedanceQuota } from '../../src/types';

const quota: SeedanceQuota = {
  date: '2026-08-24', usedUnits: 3, estimatedTotalUnits: 10, costPerVideoUnits: 3, exhausted: false, updatedAt: 'old',
};

describe('主进程视频额度写入', () => {
  it('消费后保留用户总额和单次消耗配置', () => {
    const result = applyVideoQuotaAction(quota, 'consume', 3, 'new');
    expect(result).toEqual({ ...quota, usedUnits: 6, estimatedTotalUnits: 10, exhausted: false, updatedAt: 'new' });
  });

  it('平台报告耗尽时至少推进到用户设置的总额', () => {
    const result = applyVideoQuotaAction(quota, 'exhausted', undefined, 'new');
    expect(result.usedUnits).toBe(10);
    expect(result.estimatedTotalUnits).toBe(10);
    expect(result.exhausted).toBe(true);
  });

  it('非法旧总额才回退兼容默认值', () => {
    const result = applyVideoQuotaAction({ ...quota, estimatedTotalUnits: 0 }, 'consume', 1, 'new');
    expect(result.estimatedTotalUnits).toBe(VIDEO_DAILY_UNITS);
  });

  it('手动释放只重置本地已用额度并保留用户配置', () => {
    const result = applyVideoQuotaAction({ ...quota, usedUnits: 10, exhausted: true }, 'reset', undefined, 'new');
    expect(result).toEqual({ ...quota, usedUnits: 0, exhausted: false, updatedAt: 'new' });
  });

  it('只清除额度耗尽造成的连续失败与自动冷却', () => {
    const health: AccountHealth = {
      loginState: 'ok', verificationRequired: false, consecutiveFailures: 3,
      successCount: 4, failureCount: 3, lastErrorCode: 'quota_exhausted', cooldownUntil: '2099-01-01T00:00:00.000Z',
    };
    expect(releaseQuotaExhaustionHealth(health)).toEqual({
      ...health, consecutiveFailures: 0, lastErrorCode: undefined, cooldownUntil: undefined,
    });
  });

  it('释放额度不会清除登录失效或人工验证状态', () => {
    const health: AccountHealth = {
      loginState: 'expired', verificationRequired: true, consecutiveFailures: 2,
      successCount: 1, failureCount: 2, lastErrorCode: 'verification', cooldownUntil: '2099-01-01T00:00:00.000Z',
    };
    expect(releaseQuotaExhaustionHealth(health)).toBe(health);
  });
});
