import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  entries: [] as Array<Record<string, unknown>>,
  accounts: [] as Array<Record<string, unknown>>,
  secrets: new Map<string, { cookies?: Array<Record<string, unknown>> }>(),
  failSessionWrites: false,
  sessions: [] as Array<{ partition: string; cookies: { set: ReturnType<typeof vi.fn> }; clearStorageData: ReturnType<typeof vi.fn>; clearCache: ReturnType<typeof vi.fn>; closeAllConnections: ReturnType<typeof vi.fn> }>,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  net: {},
  session: {
    fromPartition: vi.fn((partition: string) => {
      const target = {
        partition,
        cookies: {
          set: vi.fn(async () => {
            if (memory.failSessionWrites) throw new Error('write failed');
          }),
        },
        clearStorageData: vi.fn(async () => undefined),
        clearCache: vi.fn(async () => undefined),
        closeAllConnections: vi.fn(async () => undefined),
      };
      memory.sessions.push(target);
      return target;
    }),
  },
}));

vi.mock('../../main/utils/localManagerStore', () => ({
  addProxy: vi.fn(),
  bindSession: vi.fn(),
  clearDolaEntries: vi.fn(),
  deleteDolaEntry: vi.fn(),
  deleteProxy: vi.fn(),
  getConcurrency: vi.fn(() => 1),
  getDolaRelayConfig: vi.fn(() => null),
  getDolaRelayCredentials: vi.fn(() => null),
  getDolaSecret: vi.fn((id: string) => memory.secrets.get(id) || null),
  getProxyEntry: vi.fn(),
  getProxySecret: vi.fn(),
  importDolaCk: vi.fn(),
  importDolaEmail: vi.fn(),
  linkDolaAccount: vi.fn(),
  listLocalManager: vi.fn(() => ({
    dola: memory.entries,
    proxies: [],
    bindings: [],
    concurrency: 1,
    routingMode: 'legacy_global',
  })),
  randomAssign: vi.fn(),
  setConcurrency: vi.fn(),
  setRoutingMode: vi.fn(),
  unbindSession: vi.fn(),
  updateDolaCheck: vi.fn(),
  updateProxyCheck: vi.fn(),
}));

vi.mock('../../main/utils/store', () => ({
  readJSON: vi.fn((filename: string, fallback: unknown) => filename === 'accounts.json' ? memory.accounts : fallback),
}));

vi.mock('../../main/utils/localAssetStore', () => ({ listLocalAssets: vi.fn(() => []) }));
vi.mock('../../main/ipc/accounts', () => ({ refreshAccountSessionProxy: vi.fn() }));

import { restoreLinkedDolaSessions } from '../../main/ipc/localManager';

function entry(id: string, source: 'ck_json' | 'ck_txt' | 'email', accountId?: string): Record<string, unknown> {
  return {
    id,
    label: id,
    source,
    ...(accountId ? { accountId } : {}),
    state: 'valid',
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  };
}

describe('Dola CK startup restore', () => {
  beforeEach(() => {
    memory.entries = [];
    memory.accounts = [];
    memory.secrets.clear();
    memory.failSessionWrites = false;
    memory.sessions = [];
  });

  it('只恢复已关联的 CK，并把 Cookie 写入对应 Dola 持久分区', async () => {
    memory.entries = [
      entry('ck-a', 'ck_json', 'account-a'),
      entry('txt-a', 'ck_txt', 'account-txt'),
      entry('email-a', 'email', 'account-b'),
      entry('unlinked', 'ck_json'),
    ];
    memory.accounts = [
      { id: 'account-a', platform: 'dola', partition: 'account_aaaa1111' },
      { id: 'account-txt', platform: 'dola', partition: 'account_txt1111' },
    ];
    memory.secrets.set('ck-a', { cookies: [{ name: 'sid', value: 'masked', domain: '.dola.com' }] });
    memory.secrets.set('txt-a', { cookies: [{ name: 'sid_txt', value: 'masked', domain: '.dola.com' }] });

    await expect(restoreLinkedDolaSessions()).resolves.toMatchObject({
      attempted: 2,
      restored: 2,
      skipped: 0,
      failed: 0,
    });
    expect(memory.sessions).toHaveLength(2);
    expect(memory.sessions[0].partition).toBe('persist:dola_account_aaaa1111');
    expect(memory.sessions[0].clearStorageData).toHaveBeenCalledTimes(1);
    expect(memory.sessions[0].clearCache).toHaveBeenCalledTimes(1);
    expect(memory.sessions[0].cookies.set).toHaveBeenCalledWith(expect.objectContaining({ name: 'sid', domain: '.dola.com' }));
    expect(memory.sessions[0].closeAllConnections).toHaveBeenCalledTimes(1);
    expect(memory.sessions[1].partition).toBe('persist:dola_account_txt1111');
    expect(memory.sessions[1].cookies.set).toHaveBeenCalledWith(expect.objectContaining({ name: 'sid_txt', domain: '.dola.com' }));
  });

  it('缺少账号或加密 CK 时跳过，单条 Session 写入失败不阻断其他条目', async () => {
    memory.entries = [entry('missing-account', 'ck_json', 'account-missing'), entry('broken', 'ck_json', 'account-b')];
    memory.accounts = [{ id: 'account-b', platform: 'dola', partition: 'account_bbbb2222' }];
    memory.secrets.set('broken', { cookies: [{ name: 'sid', value: 'masked', domain: '.dola.com' }] });
    memory.failSessionWrites = true;

    await expect(restoreLinkedDolaSessions()).resolves.toMatchObject({ attempted: 2, skipped: 1, failed: 1, restored: 0 });
  });
});
