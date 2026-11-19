import type { LalorProfile } from '@doubao-studio/contracts';

export const LALOR_MEMBERSHIP_EXPIRED_MESSAGE = 'Lalor 会员已到期，请重新匹配令牌';

export function lalorMembershipExpiresAtMs(profile: LalorProfile | null | undefined): number | null {
  const value = profile?.membership?.expiresAt;
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function hasActiveLalorMembership(
  profile: LalorProfile | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (profile?.membership?.active !== true) return false;
  const expiresAtMs = lalorMembershipExpiresAtMs(profile);
  return expiresAtMs !== null && expiresAtMs > nowMs;
}
