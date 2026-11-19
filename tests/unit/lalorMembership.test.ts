import { describe, expect, it } from 'vitest';
import type { LalorProfile } from '@doubao-studio/contracts';
import {
  hasActiveLalorMembership,
  lalorMembershipExpiresAtMs,
} from '../../main/utils/lalorMembership';

const NOW_MS = Date.parse('2026-09-25T12:00:00.000Z');

function profile(active: boolean, expiresAt: string): LalorProfile {
  return {
    userId: 'user-1',
    username: 'member',
    displayName: 'Member',
    avatarUrl: '',
    membership: {
      tier: 'pro',
      tierLabel: 'Pro',
      source: 'test',
      active,
      startsAt: '2026-01-01T00:00:00.000Z',
      expiresAt,
    },
    availablePoints: 0,
  };
}

describe('Lalor membership validity', () => {
  it('only accepts an explicitly active membership with a future expiry', () => {
    expect(hasActiveLalorMembership(profile(true, '2026-09-25T12:00:01.000Z'), NOW_MS)).toBe(true);
    expect(hasActiveLalorMembership(profile(false, '2099-01-01T00:00:00.000Z'), NOW_MS)).toBe(false);
    expect(hasActiveLalorMembership({ ...profile(true, '2099-01-01T00:00:00.000Z'), membership: null }, NOW_MS)).toBe(false);
  });

  it('treats an exact, past, or malformed expiry as expired', () => {
    expect(hasActiveLalorMembership(profile(true, '2026-09-25T12:00:00.000Z'), NOW_MS)).toBe(false);
    expect(hasActiveLalorMembership(profile(true, '2026-09-25T11:59:59.999Z'), NOW_MS)).toBe(false);
    expect(hasActiveLalorMembership(profile(true, 'not-a-date'), NOW_MS)).toBe(false);
    expect(lalorMembershipExpiresAtMs(profile(true, 'not-a-date'))).toBeNull();
  });
});
