import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LalorAuthSnapshot, LalorProfile } from '@doubao-studio/contracts';
import { useLalorAuthStore } from '../../src/store/useLalorAuthStore';

function activeProfile(): LalorProfile {
  return {
    userId: 'user-1',
    username: 'member',
    displayName: 'Member',
    avatarUrl: '',
    membership: {
      tier: 'pro',
      tierLabel: 'Pro',
      source: 'test',
      active: true,
      startsAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    availablePoints: 100,
  };
}

const AUTHENTICATED: LalorAuthSnapshot = {
  authenticated: true,
  profile: activeProfile(),
  accessExpiresAt: '2099-01-01T00:00:00.000Z',
  refreshExpiresAt: '2099-01-02T00:00:00.000Z',
};

beforeEach(() => {
  vi.unstubAllGlobals();
  useLalorAuthStore.setState({
    ready: true,
    loading: false,
    error: null,
    snapshot: { authenticated: false },
    catalog: null,
    orders: null,
    ordersLoading: false,
  });
});

describe('Lalor auth renderer state', () => {
  it('switches to the pairing state when main reports membership expiry', async () => {
    const status = vi.fn().mockResolvedValue({
      success: true,
      data: { authenticated: false, error: 'Lalor 会员已到期，请重新匹配令牌' },
    });
    vi.stubGlobal('window', { electronAPI: { lalorAuth: { status } } });
    useLalorAuthStore.setState({ snapshot: AUTHENTICATED });

    const authenticated = await useLalorAuthStore.getState().loadStatus();

    expect(authenticated).toBe(false);
    expect(useLalorAuthStore.getState()).toMatchObject({
      ready: true,
      loading: false,
      snapshot: { authenticated: false },
      error: 'Lalor 会员已到期，请重新匹配令牌',
      catalog: null,
      orders: null,
    });
  });

  it('does not discard a valid snapshot when the local IPC call fails transiently', async () => {
    const status = vi.fn().mockRejectedValue(new Error('IPC temporarily unavailable'));
    vi.stubGlobal('window', { electronAPI: { lalorAuth: { status } } });
    useLalorAuthStore.setState({ snapshot: AUTHENTICATED });

    const authenticated = await useLalorAuthStore.getState().loadStatus();

    expect(authenticated).toBe(true);
    expect(useLalorAuthStore.getState().snapshot).toEqual(AUTHENTICATED);
    expect(useLalorAuthStore.getState().error).toBe('IPC temporarily unavailable');
  });
});
