import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, LocalManagerSnapshot } from '@doubao-studio/contracts';
import { useLocalManagerStore } from '../../src/store/useLocalManagerStore';

const createdAt = '2026-09-25T00:00:00.000Z';

function snapshot(accountId?: string): LocalManagerSnapshot {
  return {
    dola: [{
      id: 'dola-ck-1',
      label: 'Dola CK 1',
      source: 'ck_json',
      state: 'valid',
      ...(accountId ? { accountId } : {}),
      createdAt,
      updatedAt: createdAt,
    }],
    doubao: [],
    proxies: [],
    subscriptions: [],
    bindings: [],
    concurrency: 1,
    routingMode: 'legacy_global',
  };
}

describe('Dola CK automatic window provisioning', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a dedicated window for an explicitly imported CK', async () => {
    const existingAccount = {
      id: 'existing-dola-account',
      name: 'Dola 1',
      platform: 'dola',
      partition: 'account_existing',
    } as Account;
    const createdAccount = {
      id: 'new-dola-account',
      name: 'Dola 2',
      platform: 'dola',
      partition: 'account_new',
    } as Account;
    const before = snapshot();
    const after = snapshot(createdAccount.id);
    const addAccount = vi.fn().mockResolvedValue({ success: true, account: createdAccount });
    const loadDolaCkToAccount = vi.fn().mockResolvedValue({ success: true, data: after });

    vi.stubGlobal('window', {
      electronAPI: {
        accounts: {
          list: vi.fn().mockResolvedValue([existingAccount]),
          add: addAccount,
          delete: vi.fn(),
        },
        localManager: {
          snapshot: vi.fn()
            .mockResolvedValueOnce({ success: true, data: before })
            .mockResolvedValueOnce({ success: true, data: after }),
          loadDolaCkToAccount,
        },
      },
    });

    const result = await useLocalManagerStore.getState().provisionAvailableDolaCk(['dola-ck-1']);

    expect(addAccount).toHaveBeenCalledWith('Dola 2', 'dola');
    expect(loadDolaCkToAccount).toHaveBeenCalledWith('dola-ck-1', createdAccount.id);
    expect(loadDolaCkToAccount).not.toHaveBeenCalledWith('dola-ck-1', existingAccount.id);
    expect(result).toMatchObject({ linkedCount: 1, createdCount: 1, failedCount: 0 });
  });

  it('removes a newly created empty window when CK loading fails', async () => {
    const createdAccount = {
      id: 'new-dola-account',
      name: 'Dola 1',
      platform: 'dola',
      partition: 'account_new',
    } as Account;
    const before = snapshot();
    const deleteAccount = vi.fn().mockResolvedValue({ success: true });

    vi.stubGlobal('window', {
      electronAPI: {
        accounts: {
          list: vi.fn().mockResolvedValue([]),
          add: vi.fn().mockResolvedValue({ success: true, account: createdAccount }),
          delete: deleteAccount,
        },
        localManager: {
          snapshot: vi.fn()
            .mockResolvedValueOnce({ success: true, data: before })
            .mockResolvedValueOnce({ success: true, data: before }),
          loadDolaCkToAccount: vi.fn().mockResolvedValue({ success: false, error: 'CK load failed' }),
        },
      },
    });

    const result = await useLocalManagerStore.getState().provisionAvailableDolaCk(['dola-ck-1']);

    expect(deleteAccount).toHaveBeenCalledWith(createdAccount.id);
    expect(result).toMatchObject({ linkedCount: 0, createdCount: 0, failedCount: 1 });
  });
});
