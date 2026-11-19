import type { VideoDuration } from '../types';

/** 旧账号未配置额度时使用的兼容默认值。 */
export const VIDEO_DAILY_UNITS = 6;

/** 每个额度单位对应的视频秒数。 */
export const VIDEO_SECONDS_PER_UNIT = 5;

/** 优先使用账号自定义消耗；旧账号继续按每 5 秒 1 单位估算。 */
export function getVideoQuotaUsageUnits(
  duration: VideoDuration | string | undefined,
  quota?: { costPerVideoUnits?: number },
): number {
  const configuredCost = quota?.costPerVideoUnits;
  if (typeof configuredCost === 'number' && Number.isFinite(configuredCost) && configuredCost > 0) {
    return Math.max(1, Math.round(configuredCost));
  }
  const seconds = Number.parseInt(duration || '', 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(seconds / VIDEO_SECONDS_PER_UNIT));
}

export function getVideoQuotaRemaining(quota: { usedUnits: number; estimatedTotalUnits?: number } | undefined): number {
  const configuredTotal = quota?.estimatedTotalUnits;
  const totalUnits = typeof configuredTotal === 'number' && Number.isFinite(configuredTotal) && configuredTotal > 0
    ? Math.max(1, Math.round(configuredTotal))
    : VIDEO_DAILY_UNITS;
  return Math.max(0, totalUnits - Math.max(0, quota?.usedUnits || 0));
}
