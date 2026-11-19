import { beforeEach, describe, expect, it } from 'vitest';
import type { Account } from '../../src/types';
import { useAccountStore } from '../../src/store/useAccountStore';

const accounts = [
  { id: 'account-a', name: 'A' },
  { id: 'account-b', name: 'B' },
  { id: 'account-c', name: 'C' },
] as Account[];

describe('account availability batch state', () => {
  beforeEach(() => {
    useAccountStore.setState({
      accounts,
      selectedAccountId: 'account-b',
      availabilityChecking: {},
      availabilityCheckRequests: {},
      availabilityBatchCheck: {
        runId: 0,
        running: false,
        requestIds: {},
        completedAccountIds: [],
        attentionAccountIds: [],
      },
    });
  });

  it('queues every account without changing the selected account', () => {
    useAccountStore.getState().requestAvailabilityCheckAll();
    const state = useAccountStore.getState();

    expect(state.selectedAccountId).toBe('account-b');
    expect(state.availabilityCheckRequests).toEqual({
      'account-a': 1,
      'account-b': 1,
      'account-c': 1,
    });
    expect(state.availabilityBatchCheck).toMatchObject({
      runId: 1,
      running: true,
      requestIds: {
        'account-a': 1,
        'account-b': 1,
        'account-c': 1,
      },
      completedAccountIds: [],
      attentionAccountIds: [],
    });
  });

  it('tracks attention results and ignores stale completions from an older run', () => {
    useAccountStore.getState().requestAvailabilityCheckAll();
    useAccountStore.getState().completeAvailabilityBatchCheck('account-a', 1, false);
    useAccountStore.getState().completeAvailabilityBatchCheck('account-b', 1, true);

    expect(useAccountStore.getState().availabilityBatchCheck).toMatchObject({
      running: true,
      completedAccountIds: ['account-a', 'account-b'],
      attentionAccountIds: ['account-b'],
    });

    useAccountStore.getState().requestAvailabilityCheckAll();
    useAccountStore.getState().completeAvailabilityBatchCheck('account-c', 1, true);
    expect(useAccountStore.getState().availabilityBatchCheck.completedAccountIds).toEqual([]);

    useAccountStore.getState().requestAvailabilityCheck('account-a');
    useAccountStore.getState().completeAvailabilityBatchCheck('account-a', 3, false);
    expect(useAccountStore.getState().availabilityBatchCheck.completedAccountIds).toEqual(['account-a']);

    for (const account of accounts.slice(1)) {
      useAccountStore.getState().completeAvailabilityBatchCheck(account.id, 2, false);
    }
    expect(useAccountStore.getState().availabilityBatchCheck).toMatchObject({
      runId: 2,
      running: false,
      completedAccountIds: ['account-a', 'account-b', 'account-c'],
      attentionAccountIds: [],
    });
  });
});
