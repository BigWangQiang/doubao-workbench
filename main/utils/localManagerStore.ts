import { app, safeStorage } from 'electron';
import { randomInt, randomUUID } from 'crypto';
import type {
  DolaCookie,
  DolaEmailImportItem,
  DolaPoolEntry,
  DoubaoPoolEntry,
  AccountProxyProtocol,
  ProxyPoolProtocol,
  AccountProxyConfig,
  LocalCheckState,
  LocalManagerSnapshot,
  LocalRoutingMode,
  ProxySubscriptionEntry,
  ProxySubscriptionInput,
  ProxySubscriptionState,
  ProxyPoolEntry,
  ProxyPoolInput,
  SessionBinding,
} from '@doubao-studio/contracts';
import { readJSON, writeJSON } from './store';
import { maskDolaEmail, normalizeDolaCkJson, parseDolaCkTextEntries } from './dolaCkJson';
import { parseDoubaoCkTextEntries } from './doubaoCkJson';
import { readPlatformNetworkConfig } from './platformNetworkConfig';
import { isCoreManagedProxyProtocol, maskSubscriptionUrl, normalizeSubscriptionUrl, type ProxySubscriptionNode } from './proxySubscription';

const STATE_FILE = 'local-manager.json';
const SECRET_FILE = 'local-manager-secrets.json';
const DOLA_RELAY_CONFIG_FILE = 'dola-proxy.json';
const SHARED_PROXY_SECRET_FILE = 'proxy-secrets.json';
const PLATFORM_SHARED_PROXY_ID = 'proxy-platform-shared';
const PLATFORM_SHARED_SUBSCRIPTION_ID = 'subscription-platform-shared';
const MAX_BINDINGS_PER_PROXY = 10;
const MAX_CONCURRENCY = 20;
const VALID_PROXY_PROTOCOLS: readonly AccountProxyProtocol[] = ['http', 'https', 'socks5'];
const VALID_PROXY_POOL_PROTOCOLS: readonly ProxyPoolProtocol[] = [
  'http', 'https', 'socks5', 'ss', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls',
];

interface PersistedState {
  version: 1;
  dola: DolaPoolEntry[];
  doubao: DoubaoPoolEntry[];
  proxies: ProxyPoolEntry[];
  subscriptions: ProxySubscriptionEntry[];
  bindings: SessionBinding[];
  concurrency: number;
  routingMode: LocalRoutingMode;
}

interface SecretRecord {
  ckJson?: string;
  email?: string;
  password?: string;
  username?: string;
  subscriptionUrl?: string;
  /** Mihomo 节点完整配置，永不进入普通状态文件或 renderer 快照。 */
  proxyConfigJson?: string;
}

type SecretStore = Record<string, SecretRecord>;

export interface DolaSecret {
  cookies?: DolaCookie[];
  email?: string;
  password?: string;
}

export interface ProxySecret {
  username?: string;
  password?: string;
}

export type ProxyCoreConfig = Record<string, unknown>;

export interface ProxySubscriptionSecret {
  subscriptionUrl: string;
}

/** 平台中转已停用，账号按用户自己的代理绑定连接。 */
export function getDolaRelayConfig(): AccountProxyConfig | null { return null; }
export function getDolaRelayCredentials(): { username: string; password: string } | null { return null; }
export function initializeLocalManagerDefaults(): void {
  if (!writeJSON(DOLA_RELAY_CONFIG_FILE, { enabled: false })) throw new Error('停用旧中转配置失败');
  loadState();
}

export interface CheckPatch {
  state: LocalCheckState;
  lastCheckedAt?: string;
  error?: string;
  latencyMs?: number;
}

function now(): string {
  return new Date().toISOString();
}

function emptyState(): PersistedState {
  return {
    version: 1,
    dola: [],
    doubao: [],
    proxies: [],
    subscriptions: [],
    bindings: [],
    concurrency: 1,
    routingMode: 'legacy_global',
  };
}

/** 仅移除已退役的平台中转条目；保留账号、个人代理、订阅及其绑定。 */
function ensurePlatformDefaults(state: PersistedState): PersistedState {
  const retiredIds = new Set(state.proxies.filter((proxy) =>
    proxy.id === PLATFORM_SHARED_PROXY_ID
    || (proxy.host === 'api.lalun.cn' && proxy.port === 18081)
  ).map((proxy) => proxy.id));
  const next = {
    ...state,
    proxies: state.proxies.filter((proxy) => !retiredIds.has(proxy.id)),
    bindings: state.bindings.map((binding) => retiredIds.has(binding.proxyId || '')
      ? { ...binding, proxyId: null } : binding),
    subscriptions: state.subscriptions.filter((entry) =>
      entry.id !== PLATFORM_SHARED_SUBSCRIPTION_ID || entry.nodeCount > 0
    ).map((entry) => ({ ...entry, state: entry.state === 'refreshing' ? 'idle' as const : entry.state })),
  };
  if (JSON.stringify(next) !== JSON.stringify(state)) saveState(next);
  return next;
}

function normalizeState(raw: unknown): PersistedState {
  if (!raw || typeof raw !== 'object') return emptyState();
  const value = raw as Partial<PersistedState>;
  const concurrency = Number.isInteger(value.concurrency)
    ? Math.max(1, Math.min(MAX_CONCURRENCY, Number(value.concurrency)))
    : 1;
  const routingMode = value.routingMode === 'bound_only' ? 'bound_only' : 'legacy_global';
  return {
    version: 1,
    dola: Array.isArray(value.dola) ? value.dola : [],
    doubao: Array.isArray(value.doubao) ? value.doubao : [],
    proxies: Array.isArray(value.proxies)
      ? value.proxies.map((rawProxy) => {
        if (!rawProxy || typeof rawProxy !== 'object') return rawProxy as ProxyPoolEntry;
        const proxy = rawProxy as ProxyPoolEntry;
        return {
          ...proxy,
          enabled: proxy.enabled !== false,
          // 旧版本只保存 HTTPS，缺省值按旧语义兼容。
          protocol: VALID_PROXY_POOL_PROTOCOLS.includes(proxy.protocol) ? proxy.protocol : 'https',
        };
      })
      : [],
    subscriptions: Array.isArray(value.subscriptions) ? value.subscriptions : [],
    bindings: Array.isArray(value.bindings) ? value.bindings : [],
    concurrency,
    routingMode,
  };
}

function loadState(): PersistedState {
  return ensurePlatformDefaults(normalizeState(readJSON<unknown>(STATE_FILE, emptyState())));
}

function saveState(state: PersistedState): void {
  if (!writeJSON(STATE_FILE, state)) throw new Error('本地管理器数据写入失败');
}

function loadSecrets(): SecretStore {
  const raw = readJSON<unknown>(SECRET_FILE, {});
  return raw && typeof raw === 'object' ? raw as SecretStore : {};
}

function saveSecrets(secrets: SecretStore): void {
  if (!writeJSON(SECRET_FILE, secrets)) throw new Error('本地管理器凭据写入失败');
}

function ensureEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 CK 或代理凭据');
}

function encryptSecret(value: string): string {
  ensureEncryption();
  return safeStorage.encryptString(value).toString('base64');
}

function decryptSecret(value: string | undefined): string | undefined {
  if (!value || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return undefined;
  }
}

function saveSecret(id: string, secret: DolaSecret | ProxySecret | ProxySubscriptionSecret | { proxyConfig: ProxyCoreConfig }): void {
  const secrets = loadSecrets();
  const next: SecretRecord = {};
  if ('cookies' in secret && secret.cookies) next.ckJson = encryptSecret(JSON.stringify(secret.cookies));
  if ('email' in secret && secret.email) next.email = encryptSecret(secret.email);
  if ('password' in secret && secret.password) next.password = encryptSecret(secret.password);
  if ('username' in secret && secret.username) next.username = encryptSecret(secret.username);
  if ('subscriptionUrl' in secret && secret.subscriptionUrl) next.subscriptionUrl = encryptSecret(secret.subscriptionUrl);
  if ('proxyConfig' in secret && secret.proxyConfig) next.proxyConfigJson = encryptSecret(JSON.stringify(secret.proxyConfig));
  secrets[id] = next;
  saveSecrets(secrets);
}

function deleteSecret(id: string): void {
  const secrets = loadSecrets();
  if (!(id in secrets)) return;
  delete secrets[id];
  saveSecrets(secrets);
}

function secretFor(id: string): SecretRecord | undefined {
  return loadSecrets()[id];
}

function maskUsername(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length <= 2 ? `${value.slice(0, 1)}***` : `${value.slice(0, 2)}***`;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function assertProxyInput(input: ProxyPoolInput): void {
  if (!input || !VALID_PROXY_PROTOCOLS.includes(input.protocol)) throw new Error('代理协议必须是 HTTP、HTTPS 或 SOCKS5');
  const host = input.host.trim();
  if (!host || host.length > 253 || /[\s/@?#\\]/.test(host)) throw new Error('代理地址无效');
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口必须是 1-65535 的整数');
  if ((input.username && !input.password) || (!input.username && input.password)) {
    throw new Error('代理用户名和密码必须同时填写');
  }
}

export function listLocalManager(): LocalManagerSnapshot {
  const state = loadState();
  return {
    dola: state.dola.map((entry) => ({ ...entry })),
    doubao: state.doubao.map((entry) => ({ ...entry })),
    proxies: state.proxies.map((entry) => ({ ...entry })),
    subscriptions: state.subscriptions.map((entry) => ({ ...entry })),
    bindings: state.bindings.map((entry) => ({ ...entry })),
    concurrency: state.concurrency,
    routingMode: state.routingMode,
  };
}

function importDolaCkWithSource(
  label: string | undefined,
  email: string | undefined,
  ckJson: unknown,
  accountId: string | undefined,
  source: 'ck_json' | 'ck_txt',
): DolaPoolEntry {
  const parsed = normalizeDolaCkJson(ckJson);
  const id = `dola-${randomUUID()}`;
  const timestamp = now();
  const entry: DolaPoolEntry = {
    id,
    label: label?.trim() || `Dola ${id.slice(-6)}`,
    emailMasked: maskDolaEmail(email),
    source,
    ...(accountId?.trim() ? { accountId: accountId.trim() } : {}),
    state: 'unknown',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  saveSecret(id, { cookies: parsed.cookies, ...(email?.trim() ? { email: email.trim() } : {}) });
  const state = loadState();
  state.dola.push(entry);
  saveState(state);
  return { ...entry };
}

export function importDolaCk(label: string | undefined, email: string | undefined, ckJson: unknown, accountId?: string): DolaPoolEntry {
  return importDolaCkWithSource(label, email, ckJson, accountId, 'ck_json');
}

/**
 * 导入原始 CK JSON/TXT 文本；多账号文本会拆分为独立条目，沿用现有加密存储。
 */
export function importDolaCkText(
  label: string | undefined,
  email: string | undefined,
  ckText: string,
  accountId?: string,
  source?: 'ck_json' | 'ck_txt',
): DolaPoolEntry[] {
  const entries = parseDolaCkTextEntries(ckText);
  if (accountId?.trim() && entries.length > 1) {
    throw new Error('多账号 CK 文本不能绑定到单个 Dola 账号');
  }
  const baseLabel = label?.trim() || 'Dola CK';
  const normalizedText = ckText.replace(/^\uFEFF/, '').trim();
  const resolvedSource = source ?? (normalizedText.startsWith('{') || normalizedText.startsWith('[') ? 'ck_json' : 'ck_txt');
  return entries.map((entry, index) => importDolaCkWithSource(
    entries.length === 1 ? baseLabel : `${baseLabel} · ${entry.label || `CK ${index + 1}`}`,
    email,
    entry.cookies,
    accountId,
    resolvedSource,
  ));
}

function importDoubaoCkWithSource(
  label: string | undefined,
  email: string | undefined,
  ckJson: unknown,
  accountId: string | undefined,
  source: 'ck_json' | 'ck_txt',
): DoubaoPoolEntry {
  const parsed = normalizeDolaCkJson(ckJson);
  const id = `doubao-${randomUUID()}`;
  const timestamp = now();
  const entry: DoubaoPoolEntry = {
    id,
    label: label?.trim() || `豆包 ${id.slice(-6)}`,
    emailMasked: maskDolaEmail(email),
    source,
    ...(accountId?.trim() ? { accountId: accountId.trim() } : {}),
    state: 'unknown',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  saveSecret(id, { cookies: parsed.cookies, ...(email?.trim() ? { email: email.trim() } : {}) });
  const state = loadState();
  state.doubao.push(entry);
  saveState(state);
  return { ...entry };
}

export function importDoubaoCk(
  label: string | undefined,
  email: string | undefined,
  ckJson: unknown,
  accountId?: string,
): DoubaoPoolEntry {
  return importDoubaoCkWithSource(label, email, ckJson, accountId, 'ck_json');
}

/** 导入豆包 CK JSON/TXT 文本；对象键和多行 TXT 都会拆成独立条目。 */
export function importDoubaoCkText(
  label: string | undefined,
  email: string | undefined,
  ckText: string,
  accountId?: string,
  source?: 'ck_json' | 'ck_txt',
): DoubaoPoolEntry[] {
  const entries = parseDoubaoCkTextEntries(ckText);
  if (accountId?.trim() && entries.length > 1) {
    throw new Error('多账号豆包 CK 文本不能绑定到单个账号');
  }
  const baseLabel = label?.trim() || '豆包 CK';
  const normalizedText = ckText.replace(/^\uFEFF/, '').trim();
  const resolvedSource = source ?? (normalizedText.startsWith('{') || normalizedText.startsWith('[') ? 'ck_json' : 'ck_txt');
  return entries.map((entry, index) => importDoubaoCkWithSource(
    entries.length === 1 ? baseLabel : `${baseLabel} · ${entry.label || `CK ${index + 1}`}`,
    email,
    entry.cookies,
    accountId,
    resolvedSource,
  ));
}

export function importDolaEmail(item: DolaEmailImportItem): DolaPoolEntry {
  const email = item.email.trim();
  if (!validEmail(email)) throw new Error('邮箱格式无效');
  const password = item.password.trim();
  if (!password) throw new Error('邮箱密码不能为空');
  const id = `dola-${randomUUID()}`;
  const timestamp = now();
  const entry: DolaPoolEntry = {
    id,
    label: item.label?.trim() || email,
    emailMasked: maskDolaEmail(email),
    source: 'email',
    ...(item.accountId?.trim() ? { accountId: item.accountId.trim() } : {}),
    state: 'manual_required',
    error: '需要在 Dola 会话中手动完成登录或验证码',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  saveSecret(id, { email, password });
  const state = loadState();
  state.dola.push(entry);
  saveState(state);
  return { ...entry };
}

export function deleteDolaEntry(id: string): boolean {
  const state = loadState();
  const before = state.dola.length;
  state.dola = state.dola.filter((entry) => entry.id !== id);
  if (state.dola.length === before) return false;
  deleteSecret(id);
  saveState(state);
  return true;
}

export function clearDolaEntries(): void {
  const state = loadState();
  for (const entry of state.dola) deleteSecret(entry.id);
  state.dola = [];
  saveState(state);
}

export function getDolaSecret(id: string): DolaSecret | null {
  const secret = secretFor(id);
  if (!secret) return null;
  const ckText = decryptSecret(secret.ckJson);
  const email = decryptSecret(secret.email);
  const password = decryptSecret(secret.password);
  let cookies: DolaCookie[] | undefined;
  if (ckText) {
    try {
      const parsed = JSON.parse(ckText) as unknown;
      if (Array.isArray(parsed)) cookies = parsed as DolaCookie[];
    } catch {
      cookies = undefined;
    }
  }
  return cookies || email || password ? { cookies, email, password } : null;
}

/** 读取豆包 CK；返回形状与 Dola 相同，但条目 ID 和 Session 分区独立。 */
export function getDoubaoSecret(id: string): DolaSecret | null {
  const secret = secretFor(id);
  if (!secret) return null;
  const ckText = decryptSecret(secret.ckJson);
  const email = decryptSecret(secret.email);
  const password = decryptSecret(secret.password);
  let cookies: DolaCookie[] | undefined;
  if (ckText) {
    try {
      const parsed = JSON.parse(ckText) as unknown;
      if (Array.isArray(parsed)) cookies = parsed as DolaCookie[];
    } catch {
      cookies = undefined;
    }
  }
  return cookies || email || password ? { cookies, email, password } : null;
}

export function updateDolaCheck(id: string, patch: CheckPatch): DolaPoolEntry | null {
  const state = loadState();
  const entry = state.dola.find((item) => item.id === id);
  if (!entry) return null;
  entry.state = patch.state;
  entry.lastCheckedAt = patch.lastCheckedAt || now();
  entry.error = patch.error;
  entry.updatedAt = now();
  saveState(state);
  return { ...entry };
}

export function linkDolaAccount(id: string, accountId: string): DolaPoolEntry | null {
  const state = loadState();
  const entry = state.dola.find((item) => item.id === id);
  if (!entry || !accountId.trim()) return null;
  entry.accountId = accountId.trim();
  entry.updatedAt = now();
  saveState(state);
  return { ...entry };
}

export function updateDoubaoCheck(id: string, patch: CheckPatch): DoubaoPoolEntry | null {
  const state = loadState();
  const entry = state.doubao.find((item) => item.id === id);
  if (!entry) return null;
  entry.state = patch.state;
  entry.lastCheckedAt = patch.lastCheckedAt || now();
  entry.error = patch.error;
  entry.updatedAt = now();
  saveState(state);
  return { ...entry };
}

export function linkDoubaoAccount(id: string, accountId: string): DoubaoPoolEntry | null {
  const state = loadState();
  const entry = state.doubao.find((item) => item.id === id);
  if (!entry || !accountId.trim()) return null;
  entry.accountId = accountId.trim();
  entry.updatedAt = now();
  saveState(state);
  return { ...entry };
}

export function deleteDoubaoEntry(id: string): boolean {
  const state = loadState();
  const before = state.doubao.length;
  state.doubao = state.doubao.filter((entry) => entry.id !== id);
  if (state.doubao.length === before) return false;
  deleteSecret(id);
  saveState(state);
  return true;
}

export function clearDoubaoEntries(): void {
  const state = loadState();
  for (const entry of state.doubao) deleteSecret(entry.id);
  state.doubao = [];
  saveState(state);
}

export function addProxy(input: ProxyPoolInput): ProxyPoolEntry {
  assertProxyInput(input);
  const id = `proxy-${randomUUID()}`;
  const timestamp = now();
  const username = input.username?.trim() || undefined;
  const password = input.password || undefined;
  const entry: ProxyPoolEntry = {
    id,
    label: input.label?.trim() || `${input.host}:${input.port}`,
    enabled: true,
    routeThroughRelay: false,
    protocol: input.protocol,
    host: input.host.trim(),
    port: Number(input.port),
    username: maskUsername(username),
    credentialsConfigured: Boolean(username && password),
    state: 'unknown',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (username && password) saveSecret(id, { username, password });
  const state = loadState();
  state.proxies.push(entry);
  saveState(state);
  return { ...entry };
}

export interface ProxySubscriptionPatch {
  state?: ProxySubscriptionState;
  nodeCount?: number;
  supportedNodeCount?: number;
  unsupportedNodeCount?: number;
  lastRefreshedAt?: string;
  error?: string;
}

export function getSubscriptionEntry(id: string): ProxySubscriptionEntry | null {
  return loadState().subscriptions.find((entry) => entry.id === id) || null;
}

/** URL 只在主进程内部读取；渲染进程仅能看到订阅主机脱敏值。 */
export function getSubscriptionUrl(id: string): string | null {
  const entry = getSubscriptionEntry(id);
  if (!entry) return null;
  if (entry.isBuiltin) return readPlatformNetworkConfig()?.sharedSubscription?.url || null;
  return decryptSecret(secretFor(id)?.subscriptionUrl) || null;
}

export function addSubscription(input: ProxySubscriptionInput): ProxySubscriptionEntry {
  const url = normalizeSubscriptionUrl(input.url);
  const id = `subscription-${randomUUID()}`;
  const timestamp = now();
  const entry: ProxySubscriptionEntry = {
    id,
    label: input.label?.trim().slice(0, 80) || `机场订阅 ${id.slice(-6)}`,
    scope: 'personal',
    urlHost: maskSubscriptionUrl(url),
    state: 'idle',
    nodeCount: 0,
    supportedNodeCount: 0,
    unsupportedNodeCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  saveSecret(id, { subscriptionUrl: url });
  const state = loadState();
  state.subscriptions.push(entry);
  saveState(state);
  return { ...entry };
}

export function updateSubscription(id: string, patch: ProxySubscriptionPatch): ProxySubscriptionEntry | null {
  const state = loadState();
  const entry = state.subscriptions.find((item) => item.id === id);
  if (!entry) return null;
  if (patch.state !== undefined) entry.state = patch.state;
  if (patch.nodeCount !== undefined) entry.nodeCount = Math.max(0, Math.floor(patch.nodeCount));
  if (patch.supportedNodeCount !== undefined) entry.supportedNodeCount = Math.max(0, Math.floor(patch.supportedNodeCount));
  if (patch.unsupportedNodeCount !== undefined) entry.unsupportedNodeCount = Math.max(0, Math.floor(patch.unsupportedNodeCount));
  if (patch.lastRefreshedAt !== undefined) entry.lastRefreshedAt = patch.lastRefreshedAt;
  entry.error = patch.error;
  entry.updatedAt = now();
  saveState(state);
  return { ...entry };
}

/** Replace only nodes owned by one subscription; existing unrelated proxies remain untouched. */
export function replaceSubscriptionProxies(subscriptionId: string, nodes: readonly ProxySubscriptionNode[]): ProxyPoolEntry[] {
  const state = loadState();
  const subscription = state.subscriptions.find((entry) => entry.id === subscriptionId);
  if (!subscription) throw new Error('订阅不存在');
  const oldProxies = state.proxies.filter((proxy) => proxy.subscriptionId === subscriptionId);
  const oldIds = new Set(oldProxies.map((proxy) => proxy.id));
  const previousEnabledByIdentity = new Map(oldProxies.map((proxy) => [
    `${proxy.protocol}|${proxy.host}|${proxy.port}|${proxy.label}`,
    proxy.enabled !== false,
  ]));
  state.proxies = state.proxies.filter((proxy) => !oldIds.has(proxy.id));
  state.bindings = state.bindings.map((binding) => oldIds.has(binding.proxyId || '') ? { ...binding, proxyId: null } : binding);
  const secrets = loadSecrets();
  for (const id of oldIds) delete secrets[id];
  const entries: ProxyPoolEntry[] = [];
  for (const node of nodes.slice(0, 500)) {
    const id = `proxy-${randomUUID()}`;
    const timestamp = now();
    const managedByCore = node.managedByCore === true || isCoreManagedProxyProtocol(node.protocol);
    if (managedByCore && !node.rawConfig) throw new Error('机场核心节点配置缺失，请重新刷新订阅');
    const username = !managedByCore && node.username?.trim() && node.password ? node.username.trim() : undefined;
    const password = !managedByCore && username ? node.password : undefined;
    const entry: ProxyPoolEntry = {
      id,
      label: node.label.trim().slice(0, 120) || `${node.host}:${node.port}`,
      enabled: previousEnabledByIdentity.get(`${node.protocol}|${node.host.trim()}|${node.port}|${node.label.trim().slice(0, 120) || `${node.host}:${node.port}`}`) !== false,
      subscriptionId,
      routeThroughRelay: false,
      protocol: node.protocol,
      ...(managedByCore ? { managedByCore: true } : {}),
      host: node.host.trim(),
      port: node.port,
      username: maskUsername(username),
      credentialsConfigured: managedByCore ? true : Boolean(username && password),
      state: 'unknown',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (username && password) {
      secrets[id] = {
        username: encryptSecret(username),
        password: encryptSecret(password),
      };
    }
    if (managedByCore && node.rawConfig) {
      secrets[id] = {
        proxyConfigJson: encryptSecret(JSON.stringify(node.rawConfig)),
      };
    }
    entries.push(entry);
  }
  state.proxies.push(...entries);
  saveSecrets(secrets);
  saveState(state);
  return entries.map((entry) => ({ ...entry }));
}

export function deleteSubscription(id: string): boolean {
  const state = loadState();
  const target = state.subscriptions.find((entry) => entry.id === id);
  if (!target) return false;
  if (target.isBuiltin) throw new Error('平台共享订阅为系统预置，不能删除');
  const proxyIds = new Set(state.proxies.filter((proxy) => proxy.subscriptionId === id).map((proxy) => proxy.id));
  state.subscriptions = state.subscriptions.filter((entry) => entry.id !== id);
  state.proxies = state.proxies.filter((proxy) => !proxyIds.has(proxy.id));
  state.bindings = state.bindings.map((binding) => proxyIds.has(binding.proxyId || '') ? { ...binding, proxyId: null } : binding);
  const secrets = loadSecrets();
  delete secrets[id];
  for (const proxyId of proxyIds) delete secrets[proxyId];
  saveSecrets(secrets);
  saveState(state);
  return true;
}

export function deleteProxy(id: string): boolean {
  const state = loadState();
  const target = state.proxies.find((entry) => entry.id === id);
  if (target?.isBuiltin) throw new Error('平台共享IP为系统预置，不能删除');
  const before = state.proxies.length;
  state.proxies = state.proxies.filter((entry) => entry.id !== id);
  if (state.proxies.length === before) return false;
  state.bindings = state.bindings.map((binding) => binding.proxyId === id ? { ...binding, proxyId: null } : binding);
  deleteSecret(id);
  saveState(state);
  return true;
}

export function getProxySecret(id: string): ProxySecret | null {
  const secret = secretFor(id);
  if (!secret) return null;
  const username = decryptSecret(secret.username);
  const password = decryptSecret(secret.password);
  return username || password ? { username, password } : null;
}

/** 读取机场核心节点的完整配置；调用方只能在主进程内部使用。 */
export function getProxyCoreConfig(id: string): ProxyCoreConfig | null {
  const serialized = decryptSecret(secretFor(id)?.proxyConfigJson);
  if (!serialized) return null;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ProxyCoreConfig
      : null;
  } catch {
    return null;
  }
}

export function updateProxyCheck(id: string, patch: CheckPatch): ProxyPoolEntry | null {
  const state = loadState();
  const entry = state.proxies.find((item) => item.id === id);
  if (!entry) return null;
  entry.state = patch.state;
  entry.lastCheckedAt = patch.lastCheckedAt || now();
  entry.latencyMs = patch.latencyMs;
  entry.error = patch.error;
  entry.updatedAt = now();
  saveState(state);
  return { ...entry };
}

export function setProxyEnabled(id: string, enabled: boolean): ProxyPoolEntry {
  const state = loadState();
  const entry = state.proxies.find((item) => item.id === id);
  if (!entry) throw new Error('代理不存在');
  entry.enabled = enabled;
  entry.updatedAt = now();
  saveState(state);
  return { ...entry };
}

export function getProxyEntry(id: string): ProxyPoolEntry | null {
  return loadState().proxies.find((entry) => entry.id === id) || null;
}

export function getBinding(accountId: string): SessionBinding | null {
  return loadState().bindings.find((binding) => binding.accountId === accountId) || null;
}

export function bindSession(accountId: string, platform: 'doubao' | 'dola', proxyId: string | null): SessionBinding {
  if (!accountId.trim()) throw new Error('账号 ID 不能为空');
  if (platform !== 'doubao' && platform !== 'dola') throw new Error('账号平台无效');
  const state = loadState();
  const proxy = proxyId ? state.proxies.find((entry) => entry.id === proxyId) : undefined;
  if (proxyId && !proxy) throw new Error('代理不存在');
  if (proxy?.enabled === false) throw new Error('代理已禁用，不能绑定');
  if (proxy?.state === 'invalid') throw new Error('代理检测未通过，不能绑定');
  const current = state.bindings.find((binding) => binding.accountId === accountId);
  const used = state.bindings.filter((binding) => binding.proxyId === proxyId && binding.accountId !== accountId).length;
  if (proxyId && used >= MAX_BINDINGS_PER_PROXY) throw new Error('单个代理最多绑定 10 个窗口');
  const binding: SessionBinding = { accountId, platform, proxyId, boundAt: now() };
  state.bindings = current
    ? state.bindings.map((item) => item.accountId === accountId ? binding : item)
    : [...state.bindings, binding];
  saveState(state);
  return { ...binding };
}

export function unbindSession(accountId: string): void {
  const state = loadState();
  state.bindings = state.bindings.filter((binding) => binding.accountId !== accountId);
  saveState(state);
}

export function randomAssign(accountIds: string[], platformByAccount: Record<string, 'doubao' | 'dola'>, perProxyLimit: number): SessionBinding[] {
  if (!Number.isInteger(perProxyLimit) || perProxyLimit < 1 || perProxyLimit > MAX_BINDINGS_PER_PROXY) {
    throw new Error('单个代理绑定窗口数必须是 1-10');
  }
  const state = loadState();
  const proxies = state.proxies.filter((proxy) => proxy.enabled !== false && proxy.state !== 'invalid');
  if (proxies.length === 0) throw new Error('没有可分配的代理');
  const uniqueAccountIds = [...new Set(accountIds.filter((accountId) => accountId.trim()))];
  if (uniqueAccountIds.some((accountId) => !['doubao', 'dola'].includes(platformByAccount[accountId]))) {
    throw new Error('窗口不存在或账号平台无效');
  }
  const targetIds = new Set(uniqueAccountIds);
  const counts = new Map(proxies.map((proxy) => [
    proxy.id,
    state.bindings.filter((binding) => binding.proxyId === proxy.id && !targetIds.has(binding.accountId)).length,
  ]));
  const shuffled = [...proxies].sort(() => randomInt(0, 2) - 1);
  const result: SessionBinding[] = [];
  for (const accountId of uniqueAccountIds) {
    const candidates = shuffled.filter((proxy) => (counts.get(proxy.id) || 0) < perProxyLimit);
    if (candidates.length === 0) throw new Error('代理容量不足，无法完成随机分配');
    const selected = candidates[randomInt(0, candidates.length)];
    counts.set(selected.id, (counts.get(selected.id) || 0) + 1);
    result.push({ accountId, platform: platformByAccount[accountId], proxyId: selected.id, boundAt: now() });
  }
  state.bindings = [
    ...state.bindings.filter((binding) => !targetIds.has(binding.accountId)),
    ...result,
  ];
  saveState(state);
  return result;
}

export function setConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) throw new Error(`并发数必须是 1-${MAX_CONCURRENCY}`);
  const state = loadState();
  state.concurrency = value;
  saveState(state);
  return value;
}

export function getConcurrency(): number {
  return loadState().concurrency;
}

export function setRoutingMode(mode: LocalRoutingMode): LocalRoutingMode {
  if (mode !== 'legacy_global' && mode !== 'bound_only') throw new Error('路由模式无效');
  const state = loadState();
  state.routingMode = mode;
  saveState(state);
  return mode;
}

export function getRoutingMode(): LocalRoutingMode {
  return loadState().routingMode;
}

export function getMaxBindingsPerProxy(): number {
  return MAX_BINDINGS_PER_PROXY;
}

export function getDataDirectory(): string {
  return app.getPath('userData');
}
