import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, LocalManagerSnapshot } from '@doubao-studio/contracts';
import { useLocalManagerStore } from '../../src/store/useLocalManagerStore';

const createdAt = '2026-09-18T00:00:00.000Z';

function snapshot(state: 'invalid' | 'valid', accountId?: string): LocalManagerSnapshot {
  return {
    dola: [],
    doubao: [{
      id: 'doubao-ck-1',
      label: '豆包 CK 1',
      source: 'ck_json',
      state,
      ...(accountId ? { accountId } : {}),
      createdAt,
      updatedAt: createdAt,
    }],
    proxies: [],
    subscriptions: [],
    bindings: [],
    concurrency: 1,
    routingMode: 'legacy_global',
  };
}

describe('Doubao CK automatic window provisioning', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates and binds a Doubao window even when the temporary precheck reported invalid', async () => {
    const account = {
      id: 'doubao-account-1',
      name: '豆包 1',
      platform: 'doubao',
      partition: 'account_test',
    } as Account;
    const before = snapshot('invalid');
    const after = snapshot('valid', account.id);
    const loadDoubaoCkToAccount = vi.fn().mockResolvedValue({ success: true, data: after });
    const snapshotRequest = vi.fn()
      .mockResolvedValueOnce({ success: true, data: before })
      .mockResolvedValueOnce({ success: true, data: after });

    vi.stubGlobal('window', {
      electronAPI: {
        accounts: {
          list: vi.fn().mockResolvedValue([]),
          add: vi.fn().mockResolvedValue({ success: true, account }),
        },
        localManager: {
          snapshot: snapshotRequest,
          loadDoubaoCkToAccount,
        },
      },
    });

    const result = await useLocalManagerStore.getState().provisionAvailableDoubaoCk(['doubao-ck-1']);

    expect(loadDoubaoCkToAccount).toHaveBeenCalledWith('doubao-ck-1', account.id);
    expect(result).toMatchObject({
      requestedCount: 1,
      linkedCount: 1,
      createdCount: 1,
      validCount: 1,
      unavailableCount: 0,
      failedCount: 0,
    });
  });

  it('creates a dedicated window for an explicitly imported CK instead of reusing an existing Doubao window', async () => {
    const existingAccount = {
      id: 'existing-doubao-account',
      name: '豆包 1',
      platform: 'doubao',
      partition: 'account_existing',
    } as Account;
    const createdAccount = {
      id: 'new-doubao-account',
      name: '豆包 2',
      platform: 'doubao',
      partition: 'account_new',
    } as Account;
    const before = snapshot('invalid');
    const after = snapshot('valid', createdAccount.id);
    const addAccount = vi.fn().mockResolvedValue({ success: true, account: createdAccount });
    const loadDoubaoCkToAccount = vi.fn().mockResolvedValue({ success: true, data: after });

    vi.stubGlobal('window', {
      electronAPI: {
        accounts: {
          list: vi.fn().mockResolvedValue([existingAccount]),
          add: addAccount,
        },
        localManager: {
          snapshot: vi.fn()
            .mockResolvedValueOnce({ success: true, data: before })
            .mockResolvedValueOnce({ success: true, data: after }),
          loadDoubaoCkToAccount,
        },
      },
    });

    const result = await useLocalManagerStore.getState().provisionAvailableDoubaoCk(['doubao-ck-1']);

    expect(addAccount).toHaveBeenCalledWith('豆包 2', 'doubao');
    expect(loadDoubaoCkToAccount).toHaveBeenCalledWith('doubao-ck-1', createdAccount.id);
    expect(loadDoubaoCkToAccount).not.toHaveBeenCalledWith('doubao-ck-1', existingAccount.id);
    expect(result).toMatchObject({ linkedCount: 1, createdCount: 1, failedCount: 0 });
  });

  it('does not provision historical entries when the current import produced no IDs', async () => {
    const before = snapshot('invalid');
    const listAccounts = vi.fn().mockResolvedValue([]);
    const loadDoubaoCkToAccount = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        accounts: { list: listAccounts },
        localManager: {
          snapshot: vi.fn()
            .mockResolvedValueOnce({ success: true, data: before })
            .mockResolvedValueOnce({ success: true, data: before }),
          loadDoubaoCkToAccount,
        },
      },
    });

    const result = await useLocalManagerStore.getState().provisionAvailableDoubaoCk([]);

    expect(listAccounts).not.toHaveBeenCalled();
    expect(loadDoubaoCkToAccount).not.toHaveBeenCalled();
    expect(result.requestedCount).toBe(0);
  });
});
