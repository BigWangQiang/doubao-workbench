/**
 * Lalor desktop membership and account-shop contracts.
 *
 * Access/refresh tokens and delivered CK content intentionally never cross the
 * preload boundary. The main process keeps those values private and exposes
 * only this redacted projection plus a short-lived delivery reference.
 */

import type { LocalCheckState, LocalManagerResult, LocalManagerSnapshot } from './localManager';

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

export interface LalorAuthSnapshot {
  authenticated: boolean;
  profile?: LalorProfile;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  error?: string;
}

export interface LalorAuthResult<T = undefined> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface LalorPairingCode {
  code: string;
  expiresAt: string;
}

export interface LalorCatalogProduct {
  id: string;
  name: string;
  description: string;
  productType: string;
  icon: string;
  cashAmountFen: number;
  points: number;
  stock: number;
  soldCount: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LalorCatalog {
  products: LalorCatalogProduct[];
  availablePoints: number;
  /** 当前服务端要求的用户协议版本；现金购买必须回传该值。 */
  agreementVersion?: string;
}

export interface LalorPaymentOrder {
  id: string;
  provider: string;
  orderType: string;
  cardProductId?: string;
  cardProductName?: string;
  cardProductQuantity?: number;
  status: string;
  amountFen: number;
  qrCodeUrl?: string;
  paymentUrl?: string;
  expiresAt?: string;
  paidAt?: string;
  createdAt: string;
}

export interface LalorDeliveryMetadata {
  deliveryRef: string;
  id: string;
  productId: string;
  productName: string;
  productType: string;
  purchaseMethod: string;
  contentType: string;
  fileName?: string;
  mimeType?: string;
  deliveredAt: string;
}

export interface LalorPurchaseResult {
  /** 旧版 lalor IPC 返回的摘要字段；商城交付接口使用 order/delivery。 */
  productId?: string;
  productName?: string;
  importedCount?: number;
  alreadyImported?: boolean;
  order?: LalorPaymentOrder;
  delivery?: LalorDeliveryMetadata;
  profile: LalorProfile;
}

/** 购物中心订单历史的脱敏条目，不包含 CK 内容。 */
export interface LalorOrder {
  id: string;
  productId: string;
  productName: string;
  paymentMethod: string;
  paymentOrderId?: string;
  amountFen: number;
  points: number;
  status: string;
  deliveredAt?: string;
  createdAt: string;
}

export interface LalorOrderPage {
  orders: LalorOrder[];
  total: number;
  page: number;
  limit: number;
}

export interface LalorOrderHistoryClearResult {
  hidden: number;
}

export interface LalorPurchasePointsInput {
  productId: string;
  idempotencyKey: string;
}

export interface LalorCashPurchaseInput {
  productId: string;
  provider: 'wechat' | 'alipay';
  idempotencyKey: string;
  agreementAccepted: boolean;
  agreementVersion: string;
}

export interface LalorSaveDeliveryResult {
  saved: boolean;
  canceled?: boolean;
  filePath?: string;
}

export interface LalorImportDeliveryResult {
  imported: boolean;
  deliveryKind?: 'dola_ck' | 'doubao_ck' | 'residential_proxy';
  importedCount?: number;
  /** 本次交付导入产生的 CK 条目，用于只处理本批次的检测与窗口关联。 */
  importedEntryIds?: string[];
  proxyId?: string;
  proxyState?: LocalCheckState;
  proxyError?: string;
  localManager?: LocalManagerResult<LocalManagerSnapshot>;
}


