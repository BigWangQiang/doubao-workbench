import { describe, expect, it } from 'vitest';
import { buildManualAssignmentOptions } from '../../src/utils/accountAssignment';
import type { Account } from '../../src/types';

const NOW = new Date('2026-08-24T10:00:00.000Z').getTime();

function account(overrides: Partial<Account>): Account {
  return {
    id: 'account-1', name: '失败账号', avatar: '', partition: 'one', platform: 'doubao',
    status: 'idle', pinned: false, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('手动指派账号选项', () => {
  it('连续失败进入自动冷却后仍保留账号选项并显示原因', () => {
    const cooldownUntil = new Date(NOW + 30 * 60_000).toISOString();
    const options = buildManualAssignmentOptions([
      account({ health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 3, successCount: 0, failureCount: 3, cooldownUntil } }),
    ], 'doubao', 'chat', undefined, NOW);
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('account-1');
    expect(options[0].automaticBlockReason).toBe('自动冷却中');
    expect(options[0].label).toContain('失败账号');
  });

  it('只显示任务平台对应的账号，同平台额度不足账号仍保留', () => {
    const accounts = [
      account({ id: 'dola-1', name: 'Dola号', platform: 'dola' }),
      account({ id: 'quota-1', name: '余额号', seedanceQuota: { date: '2026-08-24', usedUnits: 5, estimatedTotalUnits: 6, exhausted: false, updatedAt: new Date(NOW).toISOString() } }),
    ];
    const doubaoOptions = buildManualAssignmentOptions(accounts, 'doubao', 'video', '10s', NOW);
    const dolaOptions = buildManualAssignmentOptions(accounts, 'dola', 'video', '10s', NOW);
    expect(doubaoOptions.map((item) => item.value)).toEqual(['quota-1']);
    expect(doubaoOptions[0].automaticBlockReason).toContain('额度不足');
    expect(dolaOptions.map((item) => item.value)).toEqual(['dola-1']);
    expect(dolaOptions[0].label).toContain('Dola');
  });

  it('手动指派按账号自定义消耗判断额度', () => {
    const options = buildManualAssignmentOptions([
      account({
        id: 'custom-quota',
        seedanceQuota: {
          date: '2026-08-24', usedUnits: 5, estimatedTotalUnits: 6,
          costPerVideoUnits: 1, exhausted: false, updatedAt: new Date(NOW).toISOString(),
        },
      }),
    ], 'doubao', 'video', '30s', NOW);
    expect(options[0].automaticBlockReason).toBeNull();
  });
});
