/**
 * Local manager DTOs.
 *
 * Secrets (CK JSON, passwords and proxy credentials) are intentionally absent
 * from public response types. They are accepted only as short-lived IPC input
 * and are encrypted by the main process before persistence.
 */

import type { AccountPlatform, GenerationMode } from '../enums';
import type { AccountProxyProtocol } from '../domain';

/** 代理池可展示的协议；非 Electron 原生协议由内置网络核心转换成本机 HTTP 代理。 */
export type ProxyPoolProtocol = AccountProxyProtocol
  | 'ss'
  | 'vmess'
  | 'vless'
  | 'trojan'
  | 'hysteria'
  | 'hysteria2'
  | 'tuic'
  | 'anytls';

export type LocalCheckState = 'unknown' | 'checking' | 'valid' | 'invalid' | 'manual_required';

export type LocalRoutingMode = 'legacy_global' | 'bound_only';

export type ProxySubscriptionState = 'not_configured' | 'idle' | 'refreshing' | 'ready' | 'error';

export interface DolaCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

export interface DolaPoolEntry {
  id: string;
  label: string;
  emailMasked?: string;
  source: 'ck_json' | 'ck_txt' | 'email';
  accountId?: string;
  state: LocalCheckState;
  lastCheckedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DolaCkImportItem {
  label?: string;
  email?: string;
  accountId?: string;
  /** 文件入口显式标记来源；旧调用方省略时仍按内容自动识别。 */
  source?: 'ck_json' | 'ck_txt';
  ckJson: unknown;
}

/** 豆包 CK 池条目；结构与 Dola CK 对齐，但单独存放并使用豆包 Session。 */
export type DoubaoPoolEntry = Omit<DolaPoolEntry, 'source'> & {
  source: 'ck_json' | 'ck_txt';
};

export interface DoubaoCkImportItem {
  label?: string;
  email?: string;
  accountId?: string;
  /** 文件入口显式标记来源；旧调用方省略时仍按内容自动识别。 */
  source?: 'ck_json' | 'ck_txt';
  ckJson: unknown;
}

export interface DolaEmailImportItem {
  label?: string;
  email: string;
  /** 密码只作为短时 IPC 输入，主进程会加密保存，永不回传。 */
  password: string;
  accountId?: string;
}

export interface ProxyPoolEntry {
  id: string;
  label: string;
  /** 禁用后保留配置和绑定，但不得参与新绑定、随机分配或 Session 路由。 */
  enabled: boolean;
  /** 平台预置条目标记；预置代理只读且不可删除。 */
  isBuiltin?: boolean;
  /** 由订阅刷新生成的节点；删除订阅时会一并删除。 */
  subscriptionId?: string;
  /** 订阅节点直连，不再套用已验收的平台固定中转。 */
  routeThroughRelay?: boolean;
  protocol: ProxyPoolProtocol;
  /** true 时节点由主进程内置网络核心托管，完整配置永不返回渲染进程。 */
  managedByCore?: boolean;
  host: string;
  port: number;
  username?: string;
  credentialsConfigured: boolean;
  state: LocalCheckState;
  latencyMs?: number;
  lastCheckedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** Password is accepted only in an IPC request and never returned. */
export interface ProxyPoolInput {
  label?: string;
  protocol: AccountProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  clearCredentials?: boolean;
}

/** 订阅 URL 只作为 IPC 短时输入，主进程会加密保存；公开快照只返回脱敏元数据。 */
export interface ProxySubscriptionInput {
  label?: string;
  url: string;
}

export interface ProxySubscriptionEntry {
  id: string;
  label: string;
  scope: 'platform' | 'personal';
  isBuiltin?: boolean;
  urlHost?: string;
  state: ProxySubscriptionState;
  nodeCount: number;
  supportedNodeCount: number;
  unsupportedNodeCount: number;
  lastRefreshedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionBinding {
  accountId: string;
  platform: AccountPlatform;
  proxyId: string | null;
  boundAt: string;
}

export interface LocalManagerSnapshot {
  dola: DolaPoolEntry[];
  doubao: DoubaoPoolEntry[];
  proxies: ProxyPoolEntry[];
  subscriptions: ProxySubscriptionEntry[];
  bindings: SessionBinding[];
  concurrency: number;
  routingMode: LocalRoutingMode;
}

export interface LocalManagerResult<T = undefined> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface LocalAssetMetadata {
  assetId: string;
  /** 归档来源的正式本地任务号；缺失表示历史手动资产，禁止自动猜测绑定。 */
  taskId?: string;
  kind: 'image' | 'video' | 'file';
  localFilePath: string;
  remoteUrl?: string;
  generatedAt: string;
  accountId?: string;
  proxyId?: string;
  taskStatus: 'queued' | 'generating' | 'success' | 'failed';
  tags: string[];
}

export interface DolaCapabilityPolicy {
  platform: AccountPlatform;
  allowedModes: readonly GenerationMode[];
}
