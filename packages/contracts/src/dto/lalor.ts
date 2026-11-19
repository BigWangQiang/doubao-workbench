/**
 * Lalor 会员与桌面工作台对接契约。
 *
 * 这些类型只描述公开的会员资料、目录和操作结果；访问令牌、刷新令牌
 * 以及 Dola CK 内容始终留在主进程，不通过 preload 暴露。
 */

export interface LalorMembership {
  tier: string;
  tierLabel: string;
  planId?: string;
  planName?: string;
  source: string;
  active: boolean;
  startsAt: string;
  expiresAt: string;
}

export interface LalorProfile {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  membership: LalorMembership | null;
  availablePoints: number;
}

export interface LalorCatalogProduct {
  id: string;
  name: string;
  description: string;
  productType: string;
  icon: string;
  points: number;
  stock: number;
  soldCount: number;
  enabled: boolean;
  sortWeight?: number;
  createdAt: string;
  updatedAt: string;
}

export interface LalorCatalog {
  products: LalorCatalogProduct[];
  availablePoints: number;
}

export interface LalorConnectionStatus {
  connected: boolean;
  profile?: LalorProfile;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  /** 网络暂不可用但内存中的资料仍可展示时为 true。 */
  stale?: boolean;
}

export interface LalorPurchaseResult {
  productId: string;
  productName: string;
  importedCount: number;
  alreadyImported: boolean;
  profile: LalorProfile;
}

export interface LalorOperationResult<T = undefined> {
  success: boolean;
  data?: T;
  error?: string;
}
