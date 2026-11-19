import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  userDataPath: 'C:\\lalor-auth-test',
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => memory.userDataPath),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

import { LalorAuth } from '../../main/auth/lalorAuth';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function session(active: boolean, avatarUrl = '') {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accessExpiresAt: '2099-01-01T00:00:00.000Z',
    refreshExpiresAt: '2099-01-02T00:00:00.000Z',
    profile: {
      userId: 'user-1',
      username: 'member',
      displayName: 'Member',
      avatarUrl,
      membership: {
        tier: active ? 'pro' : 'free',
        tierLabel: active ? 'Pro' : 'Free',
        source: 'test',
        active,
        startsAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      availablePoints: 100,
    },
  };
}

describe('Lalor desktop purchase boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a purchase when the known profile is not an active member', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ code: 0, data: session(false), msg: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = new LalorAuth();

    await auth.pair('PAIR-CODE');
    await expect(auth.purchase('dola-basic', 'request-1')).rejects.toThrow('仅限有效 Lalor 会员购买账号');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the purchase path available for an active member', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, data: session(true), msg: 'ok' }))
      .mockResolvedValueOnce(response({
        code: 0,
        data: {
          delivery: {
            id: 'delivery-1',
            productId: 'dola-basic',
            productName: 'Dola 账号',
            contentType: 'application/json',
            content: '[]',
            deliveredAt: '2026-09-14T00:00:00.000Z',
          },
          profile: session(true).profile,
        },
        msg: 'ok',
      }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = new LalorAuth();

    await auth.pair('PAIR-CODE');
    const result = await auth.purchase('dola-basic', 'request-1');
    expect(result.delivery.id).toBe('delivery-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/desktop/purchases/points');
  });

  it('normalizes root-relative avatars for the local file renderer', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ code: 0, data: session(true, '/avatars/member.png'), msg: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = new LalorAuth();

    const result = await auth.pair('PAIR-CODE');

    expect(result.profile?.avatarUrl).toBe('http://127.0.0.1:8080/avatars/member.png');
  });

  it('hydrates resource avatars with the authenticated image response', async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, data: session(true, 'resource:avatar-1'), msg: 'ok' }))
      .mockResolvedValueOnce(new Response(imageBytes, { status: 200, headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = new LalorAuth();

    const result = await auth.pair('PAIR-CODE');

    expect(result.profile?.avatarUrl).toBe(`data:image/png;base64,${Buffer.from(imageBytes).toString('base64')}`);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/resources/avatar-1/file');
  });
});
