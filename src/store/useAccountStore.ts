/**
 * src/store/useAccountStore.ts
 * 账号管理状态（Zustand）
 *
 * 管理账号列表的 CRUD、当前选中账号、加载状态
 */

import { create } from 'zustand';
import type { Account, AccountAvailability, AccountPlatform, AccountStatus } from '../types';
import { requireStartupAvailabilityRecheck } from '../utils/accountAvailability';
import { resolveStartupAccountId } from '../utils/accountStartupSelection';

export interface AvailabilityBatchCheckState {
  runId: number;
  running: boolean;
  requestIds: Record<string, number>;
  completedAccountIds: string[];
  attentionAccountIds: string[];
}

const INITIAL_AVAILABILITY_BATCH_CHECK: AvailabilityBatchCheckState = {
  runId: 0,
  running: false,
  requestIds: {},
  completedAccountIds: [],
  attentionAccountIds: [],
};

function prepareAccountForRuntime(account: Account, checkedAt: string, recheckAvailability = false): Account {
  const existingHealth = account.health || {
    loginState: 'unknown' as const,
    verificationRequired: false,
    consecutiveFailures: 0,
    successCount: 0,
    failureCount: 0,
  };
  return {
    ...account,
    pinned: account.pinned ?? false,
    health: {
      ...existingHealth,
      // 只有应用启动或没有历史结论时才进入待检测；普通页面刷新必须保留
      // 已完成的可用性检测，否则常驻 WebView 不会因状态重置而重新探测。
      availability: recheckAvailability || !existingHealth.availability
        ? requireStartupAvailabilityRecheck(existingHealth.availability, checkedAt)
        : existingHealth.availability,
    },
  };
}

// ==================== 类型 ====================

interface AccountState {
  /** 所有账号列表 */
  accounts: Account[];
  /** 当前选中的账号 ID */
  selectedAccountId: string | null;
  /** 数据是否正在加载 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  availabilityChecking: Record<string, boolean>;
  availabilityCheckRequests: Record<string, number>;
  availabilityBatchCheck: AvailabilityBatchCheckState;

  // Actions
  /** 从主进程加载账号列表 */
  loadAccounts: (options?: { recheckAvailability?: boolean }) => Promise<void>;
  /** 刷新成功返回 true；失败时保留旧日期标记，允许后续补偿重试。 */
  refreshDailyQuota: () => Promise<boolean>;
  /** 添加新账号 */
  addAccount: (name: string, platform?: AccountPlatform) => Promise<boolean>;
  /** 编辑账号名称 */
  updateAccount: (id: string, name: string) => Promise<boolean>;
  /** 删除账号 */
  deleteAccount: (id: string) => Promise<boolean>;
  /** 刷新账号 Session */
  refreshAccount: (id: string) => Promise<boolean>;
  /** 选中账号 */
  selectAccount: (id: string | null) => void;
  /** 更新账号状态 */
  updateAccountStatus: (id: string, status: AccountStatus) => Promise<void>;
  /** 切换置顶状态 */
  togglePinned: (id: string) => Promise<void>;
  recordSeedanceUsage: (id: string, units: number) => Promise<void>;
  markSeedanceExhausted: (id: string) => Promise<void>;
  releaseSeedanceQuota: (id: string) => Promise<boolean>;
  setVideoQuotaConfig: (id: string, totalUnits: number, costPerVideoUnits: number) => Promise<boolean>;
  recordAccountOutcome: (id: string, action: 'success' | 'failure' | 'verification' | 'login_expired' | 'clear', errorCode?: string) => Promise<void>;
  setAccountAvailability: (id: string, availability: AccountAvailability) => Promise<boolean>;
  setAvailabilityChecking: (id: string, checking: boolean) => void;
  requestAvailabilityCheck: (id: string) => void;
  requestAvailabilityCheckAll: () => void;
  completeAvailabilityBatchCheck: (id: string, requestId: number, needsAttention: boolean) => void;
  updateScheduling: (id: string, updates: Partial<NonNullable<Account['scheduling']>>) => Promise<void>;
  /** 清除错误 */
  clearError: () => void;
}

// ==================== Store ====================

export const useAccountStore = create<AccountState>((set, get) => ({
  accounts: [],
  selectedAccountId: null,
  loading: false,
  error: null,
  availabilityChecking: {},
  availabilityCheckRequests: {},
  availabilityBatchCheck: INITIAL_AVAILABILITY_BATCH_CHECK,

  // 加载账号列表
  loadAccounts: async (options) => {
    set({ loading: true, error: null });
    try {
      const accounts = await window.electronAPI.accounts.list();
      const checkedAt = new Date().toISOString();
      const normalized = accounts.map((account) => prepareAccountForRuntime(
        account,
        checkedAt,
        options?.recheckAvailability === true,
      ));
      set({
        accounts: normalized,
        selectedAccountId: resolveStartupAccountId(normalized, get().selectedAccountId),
        loading: false,
      });
    } catch (err: any) {
      set({ error: err.message, loading: false });
    }
  },

  // 跨过本机 00:00 时只刷新额度字段，保留当前页面探测与人工验证状态。
  refreshDailyQuota: async () => {
    try {
      // 新版走轻量 IPC，不重建代理/扩展/WebView；保留旧 preload 的
      // list 回退，确保热更新期间不会因为桥接版本短暂不一致而中断刷新。
      const refresh = window.electronAPI.accounts.refreshDailyQuota;
      const result = refresh
        ? await refresh()
        : { success: true, accounts: await window.electronAPI.accounts.list() };
      if (!result.success || !result.accounts) {
        throw new Error(result.error || '每日额度刷新失败');
      }
      const quotaById = new Map(result.accounts.map((account) => [account.id, account.seedanceQuota]));
      set({
        accounts: get().accounts.map((account) => ({
          ...account,
          seedanceQuota: quotaById.get(account.id) || account.seedanceQuota,
        })),
      });
      return true;
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : '每日额度刷新失败' });
      return false;
    }
  },

  // 添加账号
  addAccount: async (name: string, platform: AccountPlatform = 'doubao') => {
    set({ error: null });
    try {
      const result = await window.electronAPI.accounts.add(name, platform);
      if (result.success && result.account) {
        const accounts = [...get().accounts, prepareAccountForRuntime(result.account, new Date().toISOString(), true)];
        set({ accounts });
        return true;
      } else {
        set({ error: result.error || '添加失败' });
        return false;
      }
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },

  // 编辑账号
  updateAccount: async (id: string, name: string) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.accounts.update(id, name);
      if (result.success) {
        const accounts = get().accounts.map((a) =>
          a.id === id ? { ...a, name: name.trim(), updatedAt: new Date().toISOString() } : a
        );
        set({ accounts });
        return true;
      } else {
        set({ error: result.error || '编辑失败' });
        return false;
      }
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },

  // 删除账号
  deleteAccount: async (id: string) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.accounts.delete(id);
      if (result.success) {
        const accounts = get().accounts.filter((a) => a.id !== id);
        let newSelectedId = get().selectedAccountId;
        // 如果删除的是当前选中的账号，自动切换到第一个可用账号
        if (newSelectedId === id) {
          const pinned = accounts.find(a => a.pinned);
          newSelectedId = pinned ? pinned.id : (accounts.length > 0 ? accounts[0].id : null);
        }
        set({ accounts, selectedAccountId: newSelectedId });
        return true;
      } else {
        set({ error: result.error || '删除失败' });
        return false;
      }
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },

  // 刷新账号
  refreshAccount: async (id: string) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.accounts.refresh(id);
      if (result.success) {
        const accounts = get().accounts.map((a) =>
          a.id === id ? { ...a, status: 'idle' as AccountStatus, updatedAt: new Date().toISOString() } : a
        );
        set({ accounts });
        return true;
      }
      set({ error: result.error || '清除登录失败' });
      return false;
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : '清除登录失败' });
      return false;
    }
  },

  // 选中账号
  selectAccount: (id: string | null) => {
    set({ selectedAccountId: id });
  },

  // 更新账号状态
  updateAccountStatus: async (id: string, status: AccountStatus) => {
    const result = await window.electronAPI.accounts.setStatus(id, status);
    if (!result.success) {
      set({ error: '账号状态保存失败' });
      return;
    }
    const accounts = get().accounts.map((a) =>
      a.id === id ? { ...a, status } : a
    );
    set({ accounts });
  },

  // 切换置顶状态
  togglePinned: async (id: string) => {
    const account = get().accounts.find(a => a.id === id);
    if (!account) return;
    const newPinned = !account.pinned;
    const result = await window.electronAPI.accounts.setPinned(id, newPinned);
    if (!result.success) {
      set({ error: '账号置顶状态保存失败' });
      return;
    }
    const accounts = get().accounts.map((a) =>
      a.id === id ? { ...a, pinned: newPinned, updatedAt: new Date().toISOString() } : a
    );
    set({ accounts });
  },

  recordSeedanceUsage: async (id: string, units: number) => {
    const result = await window.electronAPI.accounts.updateSeedanceQuota(id, 'consume', units);
    if (result.success && result.account) {
      set({ accounts: get().accounts.map((account) => account.id === id ? result.account! : account) });
    }
  },

  markSeedanceExhausted: async (id: string) => {
    const result = await window.electronAPI.accounts.updateSeedanceQuota(id, 'exhausted');
    if (result.success && result.account) {
      set({ accounts: get().accounts.map((account) => account.id === id ? result.account! : account) });
    }
  },

  releaseSeedanceQuota: async (id: string) => {
    try {
      const result = await window.electronAPI.accounts.updateSeedanceQuota(id, 'reset');
      if (!result.success || !result.account) {
        set({ error: result.error || '释放本地额度失败' });
        return false;
      }
      set({
        accounts: get().accounts.map((account) => account.id === id ? result.account! : account),
        error: null,
      });
      return true;
    } catch (caught: unknown) {
      set({ error: caught instanceof Error ? caught.message : '释放本地额度失败' });
      return false;
    }
  },

  setVideoQuotaConfig: async (id, totalUnits, costPerVideoUnits) => {
    try {
      const result = await window.electronAPI.accounts.setVideoQuotaConfig(id, totalUnits, costPerVideoUnits);
      const updatedAccount = result.account;
      if (!result.success || !updatedAccount) {
        set({ error: result.error || '视频额度配置保存失败' });
        return false;
      }
      set({
        accounts: get().accounts.map((account) => account.id === id ? updatedAccount : account),
        error: null,
      });
      return true;
    } catch (caught: unknown) {
      set({ error: caught instanceof Error ? caught.message : '视频额度配置保存失败' });
      return false;
    }
  },

  recordAccountOutcome: async (id, action, errorCode) => {
    const result = await window.electronAPI.accounts.updateHealth(id, action, errorCode);
    if (result.success && result.account) {
      set({ accounts: get().accounts.map((account) => account.id === id ? result.account! : account) });
    }
  },

  setAccountAvailability: async (id, availability) => {
    const result = await window.electronAPI.accounts.setAvailability(id, availability);
    if (!result.success || !result.account) {
      set({ error: result.error || '账号可用性状态保存失败' });
      return false;
    }
    set({ accounts: get().accounts.map((account) => account.id === id ? result.account! : account) });
    return true;
  },

  setAvailabilityChecking: (id, checking) => set({
    availabilityChecking: { ...get().availabilityChecking, [id]: checking },
  }),

  requestAvailabilityCheck: (id) => set({
    availabilityCheckRequests: {
      ...get().availabilityCheckRequests,
      [id]: (get().availabilityCheckRequests[id] || 0) + 1,
    },
  }),

  requestAvailabilityCheckAll: () => {
    const accountIds = get().accounts.map((account) => account.id);
    const availabilityCheckRequests = { ...get().availabilityCheckRequests };
    const requestIds: Record<string, number> = {};
    for (const accountId of accountIds) {
      const requestId = (availabilityCheckRequests[accountId] || 0) + 1;
      availabilityCheckRequests[accountId] = requestId;
      requestIds[accountId] = requestId;
    }
    set({
      availabilityCheckRequests,
      availabilityBatchCheck: {
        runId: get().availabilityBatchCheck.runId + 1,
        running: accountIds.length > 0,
        requestIds,
        completedAccountIds: [],
        attentionAccountIds: [],
      },
    });
  },

  completeAvailabilityBatchCheck: (id, requestId, needsAttention) => set((state) => {
    const batch = state.availabilityBatchCheck;
    if (
      !batch.running ||
      requestId < batch.requestIds[id] ||
      batch.completedAccountIds.includes(id)
    ) return {};

    const completedAccountIds = [...batch.completedAccountIds, id];
    const attentionAccountIds = needsAttention && !batch.attentionAccountIds.includes(id)
      ? [...batch.attentionAccountIds, id]
      : batch.attentionAccountIds;
    return {
      availabilityBatchCheck: {
        ...batch,
        running: completedAccountIds.length < Object.keys(batch.requestIds).length,
        completedAccountIds,
        attentionAccountIds,
      },
    };
  }),

  updateScheduling: async (id, updates) => {
    const result = await window.electronAPI.accounts.updateScheduling(id, updates);
    if (result.success && result.account) set({ accounts: get().accounts.map((account) => account.id === id ? result.account! : account) });
  },

  // 清除错误
  clearError: () => set({ error: null }),
}));

// getAccountSchedulingScore 已抽取到 src/utils/schedulingScore.ts
export { getAccountSchedulingScore } from '../utils/schedulingScore';
