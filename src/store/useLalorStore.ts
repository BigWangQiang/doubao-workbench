import { create } from 'zustand';
import type {
  LalorCatalog,
  LalorConnectionStatus,
  LalorProfile,
  LalorPurchaseResult,
} from '@doubao-studio/contracts';

interface LalorState {
  status: LalorConnectionStatus;
  catalog: LalorCatalog | null;
  loading: boolean;
  pairing: boolean;
  purchasing: boolean;
  error: string | null;
  load: () => Promise<void>;
  pair: (code: string) => Promise<boolean>;
  refresh: () => Promise<boolean>;
  loadProfile: () => Promise<boolean>;
  loadCatalog: () => Promise<boolean>;
  purchase: (productId: string, idempotencyKey: string) => Promise<LalorPurchaseResult | null>;
  logout: () => Promise<boolean>;
  clearError: () => void;
}

const EMPTY_STATUS: LalorConnectionStatus = { connected: false };

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function profileStatus(profile: LalorProfile, current: LalorConnectionStatus): LalorConnectionStatus {
  return {
    ...current,
    connected: true,
    profile,
    stale: false,
  };
}

export const useLalorStore = create<LalorState>((set, get) => ({
  status: EMPTY_STATUS,
  catalog: null,
  loading: false,
  pairing: false,
  purchasing: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.lalor.status();
      if (!result.success || !result.data) throw new Error(result.error || '读取 Lalor 连接状态失败');
      set({ status: result.data, loading: false, error: null, ...(result.data.connected ? {} : { catalog: null }) });
      if (result.data.connected) await get().loadCatalog();
    } catch (error: unknown) {
      set({ loading: false, error: messageFrom(error, '读取 Lalor 连接状态失败') });
    }
  },

  pair: async (code) => {
    if (!code.trim()) {
      set({ error: '请输入 Lalor 配对码' });
      return false;
    }
    set({ pairing: true, error: null });
    try {
      const result = await window.electronAPI.lalor.pair(code.trim());
      if (!result.success || !result.data) throw new Error(result.error || 'Lalor 配对失败');
      set({ status: result.data, pairing: false, error: null });
      await get().loadCatalog();
      return true;
    } catch (error: unknown) {
      set({ pairing: false, error: messageFrom(error, 'Lalor 配对失败') });
      return false;
    }
  },

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.lalor.refresh();
      if (!result.success || !result.data) throw new Error(result.error || '刷新 Lalor 会话失败');
      set({ status: result.data, loading: false, error: null });
      await get().loadCatalog();
      return true;
    } catch (error: unknown) {
      set({ loading: false, error: messageFrom(error, '刷新 Lalor 会话失败') });
      return false;
    }
  },

  loadProfile: async () => {
    try {
      const result = await window.electronAPI.lalor.profile();
      if (!result.success || !result.data) throw new Error(result.error || '读取 Lalor 会员资料失败');
      set({ status: profileStatus(result.data, get().status), error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error, '读取 Lalor 会员资料失败') });
      return false;
    }
  },

  loadCatalog: async () => {
    try {
      const result = await window.electronAPI.lalor.catalog();
      if (!result.success || !result.data) throw new Error(result.error || '读取 Dola 账号商品失败');
      const currentStatus = get().status;
      const nextStatus = currentStatus.profile
        ? { ...currentStatus, profile: { ...currentStatus.profile, availablePoints: result.data.availablePoints } }
        : currentStatus;
      set({ catalog: result.data, status: nextStatus, error: null });
      return true;
    } catch (error: unknown) {
      set({ error: messageFrom(error, '读取 Dola 账号商品失败') });
      return false;
    }
  },

  purchase: async (productId, idempotencyKey) => {
    set({ purchasing: true, error: null });
    try {
      const result = await window.electronAPI.lalor.purchase(productId, idempotencyKey);
      if (!result.success || !result.data) throw new Error(result.error || '购买 Dola 账号失败');
      set({
        status: profileStatus(result.data.profile, get().status),
        purchasing: false,
        error: null,
      });
      await get().loadCatalog();
      return result.data;
    } catch (error: unknown) {
      set({ purchasing: false, error: messageFrom(error, '购买 Dola 账号失败') });
      return null;
    }
  },

  logout: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.lalor.logout();
      if (!result.success) throw new Error(result.error || '退出 Lalor 失败');
      set({ status: EMPTY_STATUS, catalog: null, loading: false, error: null });
      return true;
    } catch (error: unknown) {
      set({ loading: false, error: messageFrom(error, '退出 Lalor 失败') });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
