import { create } from 'zustand';
import type {
  LalorAuthSnapshot,
  LalorCashPurchaseInput,
  LalorCatalog,
  LalorOrderPage,
  LalorPurchasePointsInput,
  LalorPurchaseResult,
  LalorSaveDeliveryResult,
  LalorImportDeliveryResult,
} from '@doubao-studio/contracts';

interface LalorAuthState {
  ready: boolean;
  loading: boolean;
  error: string | null;
  snapshot: LalorAuthSnapshot;
  catalog: LalorCatalog | null;
  orders: LalorOrderPage | null;
  ordersLoading: boolean;
  loadStatus: () => Promise<boolean>;
  pair: (code: string) => Promise<boolean>;
  logout: () => Promise<boolean>;
  loadCatalog: () => Promise<LalorCatalog | null>;
  loadOrders: (page?: number, limit?: number) => Promise<LalorOrderPage | null>;
  clearOrders: () => Promise<number | null>;
  redownloadOrder: (orderId: string) => Promise<LalorSaveDeliveryResult | null>;
  purchaseByPoints: (input: LalorPurchasePointsInput) => Promise<LalorPurchaseResult | null>;
  createCashPurchase: (input: LalorCashPurchaseInput) => Promise<LalorPurchaseResult | null>;
  getCashOrder: (paymentOrderId: string) => Promise<LalorPurchaseResult | null>;
  saveDelivery: (deliveryRef: string) => Promise<LalorSaveDeliveryResult | null>;
  importDelivery: (deliveryRef: string) => Promise<LalorImportDeliveryResult | null>;
  clearError: () => void;
}

const EMPTY_SNAPSHOT: LalorAuthSnapshot = { authenticated: false };

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'Lalor 操作失败';
}

export const useLalorAuthStore = create<LalorAuthState>((set) => ({
  ready: false,
  loading: false,
  error: null,
  snapshot: EMPTY_SNAPSHOT,
  catalog: null,
  orders: null,
  ordersLoading: false,

  loadStatus: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.lalorAuth.status();
      if (!result.success || !result.data) throw new Error(result.error || '无法确认屿砚账号');
      set({
        ready: true,
        loading: false,
        snapshot: result.data,
        error: result.data.error || null,
        ...(result.data.authenticated ? {} : { catalog: null, orders: null, ordersLoading: false }),
      });
      return result.data.authenticated;
    } catch (error: unknown) {
      const current = useLalorAuthStore.getState().snapshot;
      const message = messageFrom(error);
      if (current.authenticated) {
        set({ ready: true, loading: false, error: message });
        return true;
      }
      set({ ready: true, loading: false, snapshot: EMPTY_SNAPSHOT, error: message });
      return false;
    }
  },

  pair: async (code) => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.lalorAuth.pair(code);
      if (!result.success || !result.data) throw new Error(result.error || '无法连接屿砚账号');
      set({ ready: true, loading: false, snapshot: result.data, error: null, catalog: null, orders: null });
      return result.data.authenticated;
    } catch (error: unknown) {
      set({ loading: false, error: messageFrom(error) });
      return false;
    }
  },

  logout: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.lalorAuth.logout();
      if (!result.success) throw new Error(result.error || '退出屿砚账号失败');
      set({ loading: false, ready: true, snapshot: EMPTY_SNAPSHOT, catalog: null, orders: null, ordersLoading: false, error: null });
      return true;
    } catch (error: unknown) {
      set({ loading: false, error: messageFrom(error) });
      return false;
    }
  },

  loadCatalog: async () => {
    try {
      const result = await window.electronAPI.lalorAuth.catalog();
      if (!result.success || !result.data) throw new Error(result.error || '账号商品读取失败');
      set({ catalog: result.data, snapshot: { ...useLalorAuthStore.getState().snapshot, ...(result.data ? { authenticated: true } : {}) }, error: null });
      return result.data;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return null;
    }
  },

  loadOrders: async (page = 1, limit = 20) => {
    set({ ordersLoading: true });
    try {
      const result = await window.electronAPI.lalorAuth.orders(page, limit);
      if (!result.success || !result.data) throw new Error(result.error || '购买历史读取失败');
      set({ orders: result.data, ordersLoading: false, error: null });
      return result.data;
    } catch (error: unknown) {
      set({ ordersLoading: false, error: messageFrom(error) });
      return null;
    }
  },

  clearOrders: async () => {
    set({ ordersLoading: true, error: null });
    try {
      const result = await window.electronAPI.lalorAuth.clearOrders();
      if (!result.success || !result.data) throw new Error(result.error || '购买记录清空失败');
      set({ orders: { orders: [], total: 0, page: 1, limit: useLalorAuthStore.getState().orders?.limit || 20 }, ordersLoading: false, error: null });
      return result.data.hidden;
    } catch (error: unknown) {
      set({ ordersLoading: false, error: messageFrom(error) });
      return null;
    }
  },

  redownloadOrder: async (orderId) => {
    try {
      const result = await window.electronAPI.lalorAuth.redownloadOrder(orderId);
      if (!result.success || !result.data) throw new Error(result.error || '原始交付文件下载失败');
      set({ error: null });
      return result.data;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return null;
    }
  },

  purchaseByPoints: async (input) => {
    try {
      const result = await window.electronAPI.lalorAuth.purchaseByPoints(input);
      if (!result.success || !result.data) throw new Error(result.error || '积分购买失败');
      set({ snapshot: { ...useLalorAuthStore.getState().snapshot, profile: result.data.profile }, error: null });
      void useLalorAuthStore.getState().loadOrders();
      return result.data;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return null;
    }
  },

  createCashPurchase: async (input) => {
    try {
      const result = await window.electronAPI.lalorAuth.createCashPurchase(input);
      if (!result.success || !result.data) throw new Error(result.error || '现金订单创建失败');
      set({ snapshot: { ...useLalorAuthStore.getState().snapshot, profile: result.data.profile }, error: null });
      void useLalorAuthStore.getState().loadOrders();
      return result.data;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return null;
    }
  },

  getCashOrder: async (paymentOrderId) => {
    try {
      const result = await window.electronAPI.lalorAuth.getCashOrder(paymentOrderId);
      if (!result.success || !result.data) throw new Error(result.error || '支付订单查询失败');
      set({ snapshot: { ...useLalorAuthStore.getState().snapshot, profile: result.data.profile }, error: null });
      void useLalorAuthStore.getState().loadOrders();
      return result.data;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return null;
    }
  },

  saveDelivery: async (deliveryRef) => {
    try {
      const result = await window.electronAPI.lalorAuth.saveDelivery(deliveryRef);
      if (!result.success || !result.data) throw new Error(result.error || '保存 CK 失败');
      set({ error: null });
      return result.data;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return null;
    }
  },

  importDelivery: async (deliveryRef) => {
    try {
      const result = await window.electronAPI.lalorAuth.importDelivery(deliveryRef);
      if (!result.success || !result.data) throw new Error(result.error || '导入 CK 失败');
      set({ error: null });
      return result.data;
    } catch (error: unknown) {
      set({ error: messageFrom(error) });
      return null;
    }
  },

  clearError: () => set({ error: null }),
}));



