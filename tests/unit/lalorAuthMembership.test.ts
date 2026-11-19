import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LalorAuthResult, LalorAuthSnapshot, LalorProfile } from '@doubao-studio/contracts';

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  profile: LalorProfile;
}

type IpcHandler = (...args: unknown[]) => Promise<unknown>;

const memory = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  session: null as StoredSession | null,
  clearCount: 0,
  saveCount: 0,
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '2.4.9-test'),
    getPath: vi.fn(() => 'C:\\lalor-auth-membership-test'),
  },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => memory.handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => memory.handlers.delete(channel)),
  },
}));

vi.mock('../../main/ipc/localManager', () => ({
  importAndCheckDolaCkText: vi.fn(async () => []),
  importAndCheckDoubaoCkText: vi.fn(async () => []),
  importAndCheckProxyInput: vi.fn(),
}));

vi.mock('../../main/utils/localManagerStore', () => ({
  listLocalManager: vi.fn(() => ({})),
}));

vi.mock('../../main/utils/lalorAuthStore', () => ({
  loadLalorSession: vi.fn(() => memory.session),
  saveLalorSession: vi.fn((session: StoredSession) => {
    memory.session = structuredClone(session);
    memory.saveCount += 1;
  }),
  clearLalorSession: vi.fn(() => {
    memory.session = null;
    memory.clearCount += 1;
  }),
}));

vi.mock('../../main/utils/store', () => ({
  readJSON: vi.fn((_file: string, fallback: unknown) => fallback),
  writeJSON: vi.fn(() => true),
}));

import { registerLalorAuthIPC, requireLalorGenerationAccess } from '../../main/ipc/lalorAuth';

const NOW_MS = Date.parse('2026-09-25T12:00:00.000Z');
let dispose: (() => void) | undefined;

function profile(active = true, expiresAt = '2099-01-01T00:00:00.000Z'): LalorProfile {
  return {
    userId: 'user-1',
    username: 'member',
    displayName: 'Member',
    avatarUrl: '',
    membership: {
      tier: active ? 'pro' : 'free',
      tierLabel: active ? 'Pro' : 'Free',
      source: 'test',
      active,
      startsAt: '2026-01-01T00:00:00.000Z',
      expiresAt,
    },
    availablePoints: 100,
  };
}

function session(memberProfile = profile()): StoredSession {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accessExpiresAt: '2099-01-01T00:00:00.000Z',
    refreshExpiresAt: '2099-01-02T00:00:00.000Z',
    profile: memberProfile,
  };
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, data, msg: 'ok' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ code: status, data: null, msg: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function handler<T>(channel: string): (...args: unknown[]) => Promise<T> {
  const registered = memory.handlers.get(channel);
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`);
  return registered as (...args: unknown[]) => Promise<T>;
}

beforeEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  memory.handlers.clear();
  memory.session = null;
  memory.clearCount = 0;
  memory.saveCount = 0;
  dispose = undefined;
});

afterEach(() => {
  dispose?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Lalor membership session enforcement', () => {
  it('requires an online valid membership before new generation', async () => {
    memory.session = session();
    dispose = registerLalorAuthIPC();
    const fetchMock = vi.fn().mockResolvedValue(response(profile()));
    vi.stubGlobal('fetch', fetchMock);
    await requireLalorGenerationAccess();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/desktop\/profile$/);
  });

  it('blocks new generation during an auth network failure without deleting valid session', async () => {
    memory.session = session();
    dispose = registerLalorAuthIPC();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(requireLalorGenerationAccess()).rejects.toThrow('无法连接');
    expect(memory.session).not.toBeNull();
  });

  it('blocks new generation when the server revokes membership', async () => {
    memory.session = session();
    dispose = registerLalorAuthIPC();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(profile(false))));
    await expect(requireLalorGenerationAccess()).rejects.toThrow('会员已到期');
    expect(memory.session).toBeNull();
  });
  it('clears an already expired encrypted session during startup', async () => {
    memory.session = session(profile(true, '2026-09-25T11:59:59.000Z'));
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);

    dispose = registerLalorAuthIPC();
    const result = await handler<LalorAuthResult<LalorAuthSnapshot>>('lalorAuth:status')();

    expect(memory.session).toBeNull();
    expect(result.data).toMatchObject({
      authenticated: false,
      error: 'Lalor 会员已到期，请重新匹配令牌',
    });
  });

  it('clears the session when the main-process expiry timer reaches the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    memory.session = session(profile(true, new Date(NOW_MS + 1_000).toISOString()));
    dispose = registerLalorAuthIPC();

    await vi.advanceTimersByTimeAsync(1_025);

    expect(memory.session).toBeNull();
    expect(memory.clearCount).toBe(1);
  });

  it('clears the session when the server reports an inactive membership', async () => {
    memory.session = session();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(profile(false))));
    dispose = registerLalorAuthIPC();

    const result = await handler<LalorAuthResult<LalorAuthSnapshot>>('lalorAuth:status')();

    expect(memory.session).toBeNull();
    expect(result.data).toMatchObject({ authenticated: false, error: 'Lalor 会员已到期，请重新匹配令牌' });
  });

  it('keeps a locally valid membership during a temporary network failure', async () => {
    memory.session = session();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    dispose = registerLalorAuthIPC();

    const result = await handler<LalorAuthResult<LalorAuthSnapshot>>('lalorAuth:status')();

    expect(memory.session).not.toBeNull();
    expect(memory.clearCount).toBe(0);
    expect(result.data).toMatchObject({ authenticated: true, error: '无法连接 Lalor 服务，请检查网络后重试' });
  });

  it('coalesces concurrent token refreshes and keeps the rotated session', async () => {
    memory.session = {
      ...session(),
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token-old',
      accessExpiresAt: '2020-01-01T00:00:00.000Z',
    };
    const rotated = {
      ...session(),
      accessToken: 'access-token-new',
      refreshToken: 'refresh-token-new',
    };
    let resolveRefresh!: (value: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.endsWith('/desktop/token/refresh')) return refreshResponse;
      if (url.endsWith('/desktop/profile')) return Promise.resolve(response(profile()));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    dispose = registerLalorAuthIPC();

    const getStatus = handler<LalorAuthResult<LalorAuthSnapshot>>('lalorAuth:status');
    const first = getStatus();
    const second = getStatus();

    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/desktop/token/refresh'))).toHaveLength(1);
    resolveRefresh(response(rotated));
    const results = await Promise.all([first, second]);

    expect(results.every((result) => result.data?.authenticated)).toBe(true);
    expect(memory.session?.refreshToken).toBe('refresh-token-new');
    expect(memory.clearCount).toBe(0);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/desktop/token/refresh'))).toHaveLength(1);
  });

  it('does not let a stale refresh rejection delete a newer persisted session', async () => {
    memory.session = {
      ...session(),
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token-old',
      accessExpiresAt: '2020-01-01T00:00:00.000Z',
    };
    let resolveRefresh!: (value: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.endsWith('/desktop/token/refresh')) return refreshResponse;
      if (url.endsWith('/desktop/profile')) return Promise.resolve(response(profile()));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    dispose = registerLalorAuthIPC();

    const pending = handler<LalorAuthResult<LalorAuthSnapshot>>('lalorAuth:status')();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    memory.session = {
      ...session(),
      accessToken: 'access-token-newer',
      refreshToken: 'refresh-token-newer',
    };
    resolveRefresh(errorResponse('refresh token already used', 401));
    const result = await pending;

    expect(result.data?.authenticated).toBe(true);
    expect(memory.session?.refreshToken).toBe('refresh-token-newer');
    expect(memory.clearCount).toBe(0);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer access-token-newer' }),
    });
  });

  it('still clears the current session when its refresh token is rejected', async () => {
    memory.session = {
      ...session(),
      accessToken: 'expired-access-token',
      accessExpiresAt: '2020-01-01T00:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse('session revoked', 401)));
    dispose = registerLalorAuthIPC();

    const result = await handler<LalorAuthResult<LalorAuthSnapshot>>('lalorAuth:status')();

    expect(result.data).toMatchObject({ authenticated: false, error: 'session revoked' });
    expect(memory.session).toBeNull();
    expect(memory.clearCount).toBeGreaterThan(0);
  });

  it('rejects pairing when the returned membership is already expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(session(profile(true, '2026-09-25T11:59:59.000Z')))));
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    dispose = registerLalorAuthIPC();

    const result = await handler<LalorAuthResult<LalorAuthSnapshot>>('lalorAuth:pair')({}, 'PAIR-CODE');

    expect(result).toMatchObject({ success: false, error: 'Lalor 会员已到期，请重新匹配令牌' });
    expect(memory.session).toBeNull();
    expect(memory.saveCount).toBe(0);
  });
});
