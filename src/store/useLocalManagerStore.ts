import { create } from 'zustand';
import type {
  Account,
  DolaCkImportItem,
  DolaEmailImportItem,
  DoubaoCkImportItem,
  LocalManagerSnapshot,
  LocalRoutingMode,
  ProxyPoolInput,
  ProxySubscriptionInput,
} from '@doubao-studio/contracts';

export interface DolaProvisionResult {
  requestedCount: number;
  validCount: number;
  linkedCount: number;
  alreadyLinkedCount: number;
  createdCount: number;
  unavailableCount: number;
  failedCount: number;
}

export type DoubaoProvisionResult = DolaProvisionResult;

interface LocalManagerState {
  snapshot: LocalManagerSnapshot;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  importDolaCk: (item: DolaCkImportItem) => Promise<boolean>;
  importDoubaoCk: (item: DoubaoCkImportItem) => Promise<boolean>;
  importDolaEmail: (item: DolaEmailImportItem) => Promise<boolean>;
  loadDolaCkToAccount: (entryId: string, accountId: string) => Promise<boolean>;
  reloginDolaCk: (entryId: string) => Promise<boolean>;
  deleteDola: (id: string) => Promise<boolean>;
  clearDola: () => Promise<boolean>;
  retestDola: () => Promise<boolean>;
  loadDoubaoCkToAccount: (entryId: string, accountId: string) => Promise<boolean>;
  reloginDoubaoCk: (entryId: string) => Promise<boolean>;
  deleteDoubao: (id: string) => Promise<boolean>;
  clearDoubao: () => Promise<boolean>;
  retestDoubao: () => Promise<boolean>;
  provisionAvailableDolaCk: (entryIds?: string[]) => Promise<DolaProvisionResult>;
  provisionAvailableDoubaoCk: (entryIds?: string[]) => Promise<DoubaoProvisionResult>;
  setConcurrency: (value: number) => Promise<boolean>;
  addProxy: (input: ProxyPoolInput) => Promise<boolean>;
  setProxyEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  deleteProxy: (id: string) => Promise<boolean>;
  retestProxy: () => Promise<boolean>;
  addSubscription: (input: ProxySubscriptionInput) => Promise<boolean>;
  refreshSubscription: (id: string) => Promise<boolean>;
  deleteSubscription: (id: string) => Promise<boolean>;
  bind: (accountId: string, proxyId: string | null) => Promise<boolean>;
  unbind: (accountId: string) => Promise<boolean>;
  randomAssign: (accountIds: string[], perProxyLimit: number) => Promise<boolean>;
  setRoutingMode: (mode: LocalRoutingMode) => Promise<boolean>;
  clearError: () => void;
}

const EMPTY_SNAPSHOT: LocalManagerSnapshot = {
  dola: [],
  doubao: [],
  proxies: [],
  subscriptions: [],
  bindings: [],
  concurrency: 1,
  routingMode: 'legacy_global',
};

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : '本地管理器操作失败';
}

function nextDolaAccountName(accounts: readonly Account[]): string {
  const names = new Set(
    accounts
      .filter((account) => account.platform === 'dola')
      .map((account) => account.name),
  );
  let index = 1;
  while (names.has(`Dola ${index}`)) index += 1;
  return `Dola ${index}`;
}

function nextDoubaoAccountName(accounts: readonly Account[]): string {
  const names = new Set(
    accounts
      .filter((account) => (account.platform || 'doubao') === 'doubao')
      .map((account) => account.name),
  );
  let index = 1;
  while (names.has(`豆包 ${index}`)) index += 1;
  return `豆包 ${index}`;
}

export const useLocalManagerStore = create<LocalManagerState>((set, get) => ({
  snapshot: EMPTY_SNAPSHOT,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.localManager.snapshot();
      if (!result.success || !result.data) throw new Error(result.error || '读取本地管理器数据失败');
      set({ snapshot: result.data, loading: false });
    } catch (error: unknown) {
      set({ loading: false, error: messageFrom(error) });
    }
  },

  importDolaCk: async (item) => {
    try {
      const result = await window.electronAPI.localManager.importDolaCk(item);
      if (!result.success || !result.data) throw new Error(result.error || 'CK 导入失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  importDoubaoCk: async (item) => {
    try {
      const result = await window.electronAPI.localManager.importDoubaoCk(item);
      if (!result.success || !result.data) throw new Error(result.error || '豆包 CK 导入失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  importDolaEmail: async (item) => {
    try {
      const result = await window.electronAPI.localManager.importDolaEmail(item);
      if (!result.success || !result.data) throw new Error(result.error || '邮箱导入失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  loadDolaCkToAccount: async (entryId, accountId) => {
    try {
      const result = await window.electronAPI.localManager.loadDolaCkToAccount(entryId, accountId);
      if (!result.success || !result.data) throw new Error(result.error || 'CK 加载失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  reloginDolaCk: async (entryId) => {
    try {
      const result = await window.electronAPI.localManager.reloginDolaCk(entryId);
      if (!result.success || !result.data) throw new Error(result.error || 'CK 重登失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  deleteDola: async (id) => {
    try {
      const result = await window.electronAPI.localManager.deleteDola(id);
      if (!result.success || !result.data) throw new Error(result.error || '删除失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  clearDola: async () => {
    try {
      const result = await window.electronAPI.localManager.clearDola();
      if (!result.success || !result.data) throw new Error(result.error || '清空失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  retestDola: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.localManager.retestDola();
      if (!result.success || !result.data) throw new Error(result.error || 'CK 重测失败');
      set({ snapshot: result.data, loading: false, error: null });
      return true;
    } catch (error: unknown) {
      set({ loading: false, error: messageFrom(error) });
      return false;
    }
  },

  loadDoubaoCkToAccount: async (entryId, accountId) => {
    try {
      const result = await window.electronAPI.localManager.loadDoubaoCkToAccount(entryId, accountId);
      if (!result.success || !result.data) throw new Error(result.error || '豆包 CK 加载失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  reloginDoubaoCk: async (entryId) => {
    try {
      const result = await window.electronAPI.localManager.reloginDoubaoCk(entryId);
      if (!result.success || !result.data) throw new Error(result.error || '豆包 CK 重登失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  deleteDoubao: async (id) => {
    try {
      const result = await window.electronAPI.localManager.deleteDoubao(id);
      if (!result.success || !result.data) throw new Error(result.error || '豆包 CK 删除失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  clearDoubao: async () => {
    try {
      const result = await window.electronAPI.localManager.clearDoubao();
      if (!result.success || !result.data) throw new Error(result.error || '豆包 CK 清空失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  retestDoubao: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.localManager.retestDoubao();
      if (!result.success || !result.data) throw new Error(result.error || '豆包 CK 重测失败');
      set({ snapshot: result.data, loading: false, error: null });
      return true;
    } catch (error: unknown) {
      set({ loading: false, error: messageFrom(error) });
      return false;
    }
  },

  provisionAvailableDolaCk: async (entryIds?: string[]) => {
    const emptyResult: DolaProvisionResult = {
      requestedCount: 0,
      validCount: 0,
      linkedCount: 0,
      alreadyLinkedCount: 0,
      createdCount: 0,
      unavailableCount: 0,
      failedCount: 0,
    };
    try {
      const snapshotResult = await window.electronAPI.localManager.snapshot();
      if (!snapshotResult.success || !snapshotResult.data) {
        throw new Error(snapshotResult.error || '读取 CK 检测结果失败');
      }
      const requestedIds = entryIds?.length ? new Set(entryIds) : null;
      const requested = snapshotResult.data.dola.filter(
        (entry) => entry.source !== 'email' && (!requestedIds || requestedIds.has(entry.id)),
      );
      const candidates = requested.filter((entry) => entry.state === 'valid' && !entry.accountId);
      const result: DolaProvisionResult = {
        ...emptyResult,
        requestedCount: requested.length,
        validCount: requested.filter((entry) => entry.state === 'valid').length,
        alreadyLinkedCount: requested.filter((entry) => Boolean(entry.accountId)).length,
        unavailableCount: requested.filter((entry) => entry.state !== 'valid').length,
      };

      if (candidates.length > 0) {
        let accounts = await window.electronAPI.accounts.list();
        const linkedAccountIds = new Set(
          snapshotResult.data.dola
            .map((entry) => entry.accountId)
            .filter((accountId): accountId is string => Boolean(accountId)),
        );
        // An explicit import must always get a fresh Session. Reusing an unlinked
        // window can overwrite a manually logged-in account that is not yet in
        // the local-manager binding table. Startup recovery may still reuse a
        // genuinely empty placeholder when no entry IDs were supplied.
        const availableAccounts = entryIds !== undefined
          ? []
          : accounts.filter(
              (account) => account.platform === 'dola' && !linkedAccountIds.has(account.id),
            );
        for (const entry of candidates) {
          let account = availableAccounts.shift();
          let createdAccountId: string | null = null;
          if (!account) {
            const created = await window.electronAPI.accounts.add(nextDolaAccountName(accounts), 'dola');
            if (!created.success || !created.account) {
              result.failedCount += 1;
              continue;
            }
            account = created.account;
            createdAccountId = account.id;
            accounts = [...accounts, account];
            result.createdCount += 1;
          }
          const linked = await window.electronAPI.localManager.loadDolaCkToAccount(entry.id, account.id);
          if (!linked.success) {
            if (createdAccountId) {
              const removed = await window.electronAPI.accounts.delete(createdAccountId);
              if (removed.success) {
                accounts = accounts.filter((item) => item.id !== createdAccountId);
                result.createdCount -= 1;
              }
            }
            result.failedCount += 1;
            continue;
          }
          linkedAccountIds.add(account.id);
          result.linkedCount += 1;
        }
      }

      void window.electronAPI.localManager.snapshot().then((latest) => {
        if (latest.success && latest.data) set({ snapshot: latest.data, error: null });
      }).catch(() => undefined);
      return result;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return { ...emptyResult, failedCount: 1 };
    }
  },

  provisionAvailableDoubaoCk: async (entryIds?: string[]) => {
    const emptyResult: DoubaoProvisionResult = {
      requestedCount: 0,
      validCount: 0,
      linkedCount: 0,
      alreadyLinkedCount: 0,
      createdCount: 0,
      unavailableCount: 0,
      failedCount: 0,
    };
    try {
      const snapshotResult = await window.electronAPI.localManager.snapshot();
      if (!snapshotResult.success || !snapshotResult.data) throw new Error(snapshotResult.error || '读取豆包 CK 检测结果失败');
      const requestedIds = entryIds ? new Set(entryIds) : null;
      const requested = snapshotResult.data.doubao.filter((entry) => !requestedIds || requestedIds.has(entry.id));
      // 豆包导出的 CK 在临时探测 Session 中可能被站点风控误判为失效。
      // 先把本次未关联条目加载到独立持久 Session，再以加载结果更新状态，
      // 避免“只有预检可用才建窗”造成永远无法自动绑定的循环依赖。
      const candidates = requested.filter((entry) => !entry.accountId);
      const result: DoubaoProvisionResult = {
        ...emptyResult,
        requestedCount: requested.length,
        validCount: requested.filter((entry) => entry.state === 'valid').length,
        alreadyLinkedCount: requested.filter((entry) => Boolean(entry.accountId)).length,
        unavailableCount: requested.filter((entry) => entry.state !== 'valid').length,
      };
      if (candidates.length > 0) {
        let accounts = await window.electronAPI.accounts.list();
        const linkedAccountIds = new Set(snapshotResult.data.doubao.map((entry) => entry.accountId).filter((id): id is string => Boolean(id)));
        // 本次导入返回了明确条目 ID 时，每条 CK 都必须获得新 Session；复用旧的
        // 未关联窗口会覆盖用户已经登录的豆包会话。无 ID 的启动恢复流程仍可复用
        // 真正空闲的历史占位窗口，避免每次启动重复建窗。
        const availableAccounts = entryIds !== undefined
          ? []
          : accounts.filter((account) => (account.platform || 'doubao') === 'doubao' && !linkedAccountIds.has(account.id));
        for (const entry of candidates) {
          let account = availableAccounts.shift();
          if (!account) {
            const created = await window.electronAPI.accounts.add(nextDoubaoAccountName(accounts), 'doubao');
            if (!created.success || !created.account) { result.failedCount += 1; continue; }
            account = created.account;
            accounts = [...accounts, account];
            result.createdCount += 1;
          }
          const linked = await window.electronAPI.localManager.loadDoubaoCkToAccount(entry.id, account.id);
          if (!linked.success) { result.failedCount += 1; continue; }
          linkedAccountIds.add(account.id);
          result.linkedCount += 1;
        }
      }
      const latest = await window.electronAPI.localManager.snapshot();
      if (latest.success && latest.data) {
        set({ snapshot: latest.data, error: null });
        const latestRequested = latest.data.doubao.filter((entry) => !requestedIds || requestedIds.has(entry.id));
        result.validCount = latestRequested.filter((entry) => entry.state === 'valid').length;
        result.unavailableCount = latestRequested.filter((entry) => entry.state !== 'valid').length;
      }
      return result;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return { ...emptyResult, failedCount: 1 };
    }
  },

  setConcurrency: async (value) => {
    try {
      const result = await window.electronAPI.localManager.setConcurrency(value);
      if (!result.success) throw new Error(result.error || '并发数设置失败');
      set({ snapshot: { ...get().snapshot, concurrency: result.data?.concurrency || value }, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  addProxy: async (input) => {
    try {
      const result = await window.electronAPI.localManager.addProxy(input);
      if (!result.data) throw new Error(result.error || '代理保存失败');
      set({ snapshot: result.data, error: result.success ? null : result.error || '代理检测未通过' });
      return result.success;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  setProxyEnabled: async (id, enabled) => {
    try {
      const result = await window.electronAPI.localManager.setProxyEnabled(id, enabled);
      if (!result.success || !result.data) throw new Error(result.error || '代理启停设置失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  deleteProxy: async (id) => {
    try {
      const result = await window.electronAPI.localManager.deleteProxy(id);
      if (!result.success || !result.data) throw new Error(result.error || '代理删除失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  retestProxy: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.localManager.retestProxy();
      if (!result.success || !result.data) throw new Error(result.error || '代理重测失败');
      set({ snapshot: result.data, loading: false, error: null });
      return true;
    } catch (error: unknown) {
      set({ loading: false, error: messageFrom(error) });
      return false;
    }
  },

  addSubscription: async (input) => {
    try {
      const result = await window.electronAPI.localManager.addSubscription(input);
      if (!result.data) throw new Error(result.error || '订阅添加失败');
      set({ snapshot: result.data, error: result.success ? null : result.error || '订阅刷新失败' });
      return result.success;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  refreshSubscription: async (id) => {
    try {
      const result = await window.electronAPI.localManager.refreshSubscription(id);
      if (!result.data) throw new Error(result.error || '订阅刷新失败');
      set({ snapshot: result.data, error: result.success ? null : result.error || '订阅刷新失败' });
      return result.success;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  deleteSubscription: async (id) => {
    try {
      const result = await window.electronAPI.localManager.deleteSubscription(id);
      if (!result.success || !result.data) throw new Error(result.error || '订阅删除失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  bind: async (accountId, proxyId) => {
    try {
      const result = await window.electronAPI.localManager.bind(accountId, proxyId);
      if (!result.success) throw new Error(result.error || '绑定失败');
      await get().load();
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  unbind: async (accountId) => {
    try {
      const result = await window.electronAPI.localManager.unbind(accountId);
      if (!result.success || !result.data) throw new Error(result.error || '解绑失败');
      set({ snapshot: result.data, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  randomAssign: async (accountIds, perProxyLimit) => {
    try {
      const result = await window.electronAPI.localManager.randomAssign(accountIds, perProxyLimit);
      if (!result.success) throw new Error(result.error || '随机分配失败');
      await get().load();
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  setRoutingMode: async (mode) => {
    try {
      const result = await window.electronAPI.localManager.setRoutingMode(mode);
      if (!result.success) throw new Error(result.error || '路由模式设置失败');
      set({ snapshot: { ...get().snapshot, routingMode: mode }, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
