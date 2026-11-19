/**
 * main/ipc/accounts.ts
 * 账号管理 IPC 处理器
 * 负责：账号 CRUD、Session 分区管理、Cookie/Storage 隔离
 */

import { app, net, safeStorage, session, webContents } from 'electron';
import { ipcMain } from '../security/trustedIpc';
import * as fs from 'fs';
import * as path from 'path';
import { readJSON, writeJSON } from '../utils/store';
import { normalizeAccounts } from '../utils/persistenceNormalization';
import { v4 as uuidv4 } from 'uuid';
import { replaceIpcHandlers } from './lifecycle';
import { applyVideoQuotaAction, localDateKey, releaseQuotaExhaustionHealth, VIDEO_DAILY_UNITS } from '../utils/videoQuota';
import type {
  Account,
  AccountAddParams,
  AccountUpdateParams,
  AccountIdParams,
  AccountSetStatusParams,
  AccountSetPinnedParams,
  AccountUpdateSeedanceQuotaParams,
  AccountSetVideoQuotaConfigParams,
  AccountDailyQuotaRefreshResult,
  AccountUpdateHealthParams,
  AccountSetAvailabilityParams,
  AccountUpdateSchedulingParams,
  AccountPlatform,
  AccountProxyInput,
  AccountProxyConfig,
  AccountTestProxyResult,
  DolaProxyResult,
} from '@doubao-studio/contracts';
import { normalizeProxyInput, proxyRules } from '../utils/accountProxy';
import { getBoundProxyCredentials, resolveAccountSessionRoute, resolveAccountSessionRouteAsync } from '../utils/sessionProxyRouter';

import { readPlatformNetworkConfig } from '../utils/platformNetworkConfig';
import {
  DOLA_LOCALE_COOKIE_DOMAINS,
  DOLA_LOCALE_COOKIE_MAX_AGE_SECONDS,
  DOLA_LOCALE_COOKIE_NAMES,
  DOLA_LOCALE_COOKIE_VALUE,
  dolaLocaleCookieUrl,
  isDolaLocaleCookie,
} from '../utils/dolaLocalePreload';

// ==================== 类型定义 ====================

// 枚举/联合类型、领域模型接口和 IPC DTO 已迁移至 @doubao-studio/contracts。
// 此处通过 import type 引用，不产生运行时依赖。

export type { Account };

// ==================== 数据持久化 ====================

const STORE_FILE = 'accounts.json';
const PROXY_SECRET_FILE = 'proxy-secrets.json';

const DOLA_LEGACY_EXTENSION_DIR = path.join('extensions', 'dola30-legacy');
const DOLA_LEGACY_EXTENSION_NAME = '豆包 Dola 15秒去水印助手';
const DOLA_PROXY_SECRET_KEY = '__dola_global__';

const DEFAULT_SEEDANCE_DAILY_UNITS = VIDEO_DAILY_UNITS;

interface ProxySecret {
  username: string;
  password: string;
}

type ProxySecretStore = Record<string, { username: string; password: string }>;

function loadProxySecrets(): ProxySecretStore {
  return readJSON<ProxySecretStore>(PROXY_SECRET_FILE, {});
}

function saveProxySecrets(secrets: ProxySecretStore): boolean {
  return writeJSON(PROXY_SECRET_FILE, secrets);
}

function loadDolaProxyConfig(): AccountProxyConfig | undefined { return undefined; }

function encryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统暂不可用安全存储，请稍后重试');
  }
  return safeStorage.encryptString(value).toString('base64');
}

function decryptSecret(value: string): string {
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return '';
  }
}

function readProxySecret(accountId: string): ProxySecret | null {
  if (accountId === DOLA_PROXY_SECRET_KEY) return null;
  const stored = loadProxySecrets()[accountId];
  if (!stored || typeof stored.username !== 'string' || typeof stored.password !== 'string') return null;
  const username = decryptSecret(stored.username);
  const password = decryptSecret(stored.password);
  return username && password ? { username, password } : null;
}

function proxyMetadata(account: Account): Account {
  // 代理改为 Dola 全局配置，不再把代理字段暴露在账号对象中。
  delete account.proxy;
  return account;
}

function removeProxySecret(accountId: string): boolean {
  const secrets = loadProxySecrets();
  if (!(accountId in secrets)) return true;
  delete secrets[accountId];
  return saveProxySecrets(secrets);
}

const configuredProxyKeys = new Map<string, string>();
let networkBusyAccounts = new Set<string>();
const sessionAccountIds = new Map<Electron.Session, string>();
const sessionAccountPlatforms = new Map<Electron.Session, AccountPlatform>();

function accountPlatform(account: Pick<Account, 'platform'>): AccountPlatform {
  return account.platform === 'dola' ? 'dola' : 'doubao';
}

function sessionPartition(platform: AccountPlatform, partition: string): string {
  return `persist:${platform}_${partition}`;
}

// GenerationMode 已迁移至 @doubao-studio/contracts

function normalizeQuota(account: Account): void {
  const today = localDateKey();
  const currentTotal = account.seedanceQuota?.estimatedTotalUnits;
  const totalUnits = typeof currentTotal === 'number' && Number.isFinite(currentTotal) && currentTotal > 0
    ? Math.max(1, Math.round(currentTotal))
    : DEFAULT_SEEDANCE_DAILY_UNITS;
  const currentCost = account.seedanceQuota?.costPerVideoUnits;
  const costPerVideoUnits = typeof currentCost === 'number' && Number.isFinite(currentCost) && currentCost > 0
    ? Math.max(1, Math.round(currentCost))
    : undefined;
  if (!account.seedanceQuota || account.seedanceQuota.date !== today) {
    account.seedanceQuota = {
      date: today,
      usedUnits: 0,
      estimatedTotalUnits: totalUnits,
      ...(costPerVideoUnits ? { costPerVideoUnits } : {}),
      exhausted: false,
      updatedAt: new Date().toISOString(),
    };
  } else {
    account.seedanceQuota.estimatedTotalUnits = totalUnits;
    account.seedanceQuota.costPerVideoUnits = costPerVideoUnits;
    account.seedanceQuota.exhausted = account.seedanceQuota.exhausted || account.seedanceQuota.usedUnits >= totalUnits;
  }
}

function normalizeHealth(account: Account): void {
  account.health = {
    loginState: account.health?.loginState || 'unknown',
    verificationRequired: account.health?.verificationRequired || false,
    consecutiveFailures: account.health?.consecutiveFailures || 0,
    successCount: account.health?.successCount || 0,
    failureCount: account.health?.failureCount || 0,
    lastSuccessAt: account.health?.lastSuccessAt,
    lastFailureAt: account.health?.lastFailureAt,
    lastErrorCode: account.health?.lastErrorCode,
    cooldownUntil: account.health?.cooldownUntil,
    availability: account.health?.availability,
  };
  if (account.health.cooldownUntil && new Date(account.health.cooldownUntil).getTime() <= Date.now()) {
    account.health.cooldownUntil = undefined;
    account.health.verificationRequired = false;
  }
}

function normalizeScheduling(account: Account): void {
  account.scheduling = {
    enabled: account.scheduling?.enabled ?? true,
    weight: Math.max(0.1, Math.min(10, account.scheduling?.weight || 1)),
    preferredModes: account.scheduling?.preferredModes || [],
    manualCooldownUntil: account.scheduling?.manualCooldownUntil,
  };
  if (account.scheduling.manualCooldownUntil && new Date(account.scheduling.manualCooldownUntil).getTime() <= Date.now()) {
    account.scheduling.manualCooldownUntil = undefined;
  }
}

/** 读取所有账号（含运行时归一化） */
function loadAccounts(): Account[] {
  const raw = readJSON<unknown>(STORE_FILE, []);
  const result = normalizeAccounts(raw);
  // 仅在归一化确实改变数据时写回磁盘，避免每次读取产生无意义磁盘 IO
  if (result.changed) {
    saveAccounts(result.data);
  }
  if (result.warnings.length > 0) {
    console.warn('[Accounts] 数据归一化告警:', result.warnings);
  }

  return result.data.map((account) => proxyMetadata(account));
}

/** 保存所有账号 */
function saveAccounts(accounts: Account[]): boolean {
  return writeJSON(STORE_FILE, accounts);
}

// ==================== Session 管理 ====================

/** 活跃的 session 分区集合（用于清理） */
const activePartitions = new Set<string>();

const DOLA_EXTENSION_DIR = path.join('extensions', 'dola30');
const DOLA_EXTENSION_NAME = '苏生阁AI · 30秒无水印助手';
const DOLA_LOCALE_URL = 'https://www.dola.com/';
const loadedExtensionSessions = new WeakSet<Electron.Session>();
const loadingExtensionSessions = new WeakMap<Electron.Session, Promise<void>>();
const loadedDolaLegacySessions = new WeakSet<Electron.Session>();
const loadingDolaLegacySessions = new WeakMap<Electron.Session, Promise<void>>();
const initializedDolaLocaleSessions = new WeakSet<Electron.Session>();
const initializingDolaLocaleSessions = new WeakMap<Electron.Session, Promise<void>>();
const dolaLocaleCookieListeners = new WeakMap<Electron.Session, DolaLocaleCookieChangedListener>();
const dolaLocaleNormalizationPromises = new WeakMap<Electron.Session, Promise<void>>();
const dolaLocaleNormalizationPending = new WeakSet<Electron.Session>();

type DolaLocaleCookieChangedListener = (
  event: Electron.Event,
  cookie: Electron.Cookie,
  cause: 'explicit' | 'overwrite' | 'expired' | 'evicted' | 'expired-overwrite',
  removed: boolean,
) => void;

function isChineseLocale(value: string | undefined): boolean {
  return /^(?:zh|zh-cn|zh_cn)(?:[-_].*)?$/i.test(String(value || '').trim());
}

/**
 * 清理 Dola 语言 Cookie 的历史域名/路径变体，再写入统一值。
 * 只处理四个语言键，不触碰 CK、登录态或其他站点 Cookie。
 */
async function normalizeDolaLocaleCookies(sess: Electron.Session): Promise<void> {
  const cookies = await sess.cookies.get({});
  const localeCookies = cookies.filter((cookie) => isDolaLocaleCookie(cookie));
  await Promise.all(localeCookies.map(async (cookie) => {
    try {
      await sess.cookies.remove(dolaLocaleCookieUrl(cookie), cookie.name);
    } catch (error: unknown) {
      console.warn(
        `[Accounts] 清理 Dola 语言 Cookie 失败: name=${cookie.name}, domain=${cookie.domain || 'www.dola.com'}, ` +
          `path=${cookie.path || '/'}, ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }));

  const expirationDate = Math.floor(Date.now() / 1000) + DOLA_LOCALE_COOKIE_MAX_AGE_SECONDS;
  for (const domain of DOLA_LOCALE_COOKIE_DOMAINS) {
    for (const name of DOLA_LOCALE_COOKIE_NAMES) {
      await sess.cookies.set({
        url: DOLA_LOCALE_URL,
        ...(domain ? { domain } : {}),
        path: '/',
        name,
        value: DOLA_LOCALE_COOKIE_VALUE,
        secure: true,
        sameSite: 'lax',
        expirationDate,
      });
    }
  }
}

/** 串行化 Cookie 规范化，避免站点连续写入语言值时产生并发清理。 */
function scheduleDolaLocaleNormalization(sess: Electron.Session, reason: string): Promise<void> {
  const existing = dolaLocaleNormalizationPromises.get(sess);
  if (existing) {
    dolaLocaleNormalizationPending.add(sess);
    return existing;
  }

  const promise = (async (): Promise<void> => {
    try {
      await normalizeDolaLocaleCookies(sess);
      console.log(`[Accounts] Dola 语言 Cookie 已规范化: reason=${reason}`);
    } finally {
      dolaLocaleNormalizationPromises.delete(sess);
      if (dolaLocaleNormalizationPending.delete(sess)) {
        void scheduleDolaLocaleNormalization(sess, 'Cookie 变更排队').catch((error: unknown) => {
          console.warn('[Accounts] 排队的 Dola 语言 Cookie 规范化失败:', error instanceof Error ? error.message : error);
        });
      }
    }
  })();
  dolaLocaleNormalizationPromises.set(sess, promise);
  return promise;
}

/** 监听 Dola 后续写入的非中文语言值，只纠正 Cookie，不触发页面刷新。 */
function installDolaLocaleCookieGuard(sess: Electron.Session): void {
  if (dolaLocaleCookieListeners.has(sess)) return;
  const listener: DolaLocaleCookieChangedListener = (_event, cookie, _cause, removed): void => {
    if (removed || !isDolaLocaleCookie(cookie) || isChineseLocale(cookie.value)) return;
    void scheduleDolaLocaleNormalization(sess, `检测到非中文 Cookie: ${cookie.name}`).catch((error: unknown) => {
      console.warn('[Accounts] Dola 非中文语言 Cookie 自动纠正失败:', error instanceof Error ? error.message : error);
    });
  };
  sess.cookies.on('changed', listener);
  dolaLocaleCookieListeners.set(sess, listener);
}

/** 在 Dola 页面首次导航前固定简体中文，避免站点回退到浏览器语言。 */
async function ensureDolaSimplifiedChineseLocale(sess: Electron.Session): Promise<void> {
  installDolaLocaleCookieGuard(sess);
  if (initializedDolaLocaleSessions.has(sess)) return;
  const existing = initializingDolaLocaleSessions.get(sess);
  if (existing) return existing;

  const promise = (async (): Promise<void> => {
    try {
      await scheduleDolaLocaleNormalization(sess, 'Session 初始化');
      initializedDolaLocaleSessions.add(sess);
    } catch (error: unknown) {
      // Cookie 读写失败不应阻断账号加载；document_start 扩展仍会再次固定语言。
      console.warn('[Accounts] Dola 语言 Cookie 初始化失败:', error instanceof Error ? error.message : error);
    } finally {
      initializingDolaLocaleSessions.delete(sess);
    }
  })();
  initializingDolaLocaleSessions.set(sess, promise);
  await promise;
}

/** 找到随应用发布的未打包扩展目录。生产包使用 resources，开发模式使用项目根目录。 */
function resolveDolaExtensionPath(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, DOLA_EXTENSION_DIR), path.join(app.getAppPath(), DOLA_EXTENSION_DIR)]
    : [path.join(app.getAppPath(), DOLA_EXTENSION_DIR), path.join(__dirname, '..', '..', DOLA_EXTENSION_DIR)];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}

function resolveDolaLegacyExtensionPath(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, DOLA_LEGACY_EXTENSION_DIR), path.join(app.getAppPath(), DOLA_LEGACY_EXTENSION_DIR)]
    : [path.join(app.getAppPath(), DOLA_LEGACY_EXTENSION_DIR), path.join(__dirname, '..', '..', DOLA_LEGACY_EXTENSION_DIR)];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}

/** 将本地 Dola/豆包扩展加载到当前账号 Session；同一 Session 只加载一次。 */
async function ensureDolaExtensionLoaded(sess: Electron.Session): Promise<void> {
  if (loadedExtensionSessions.has(sess)) return;
  const existing = loadingExtensionSessions.get(sess);
  if (existing) return existing;

  const promise = (async () => {
    const extensionPath = resolveDolaExtensionPath();
    if (!extensionPath) {
      console.warn('[Accounts] 未找到内置 Dola 扩展目录，将在下次 Session 配置时重试');
      return;
    }
    const normalizedExtensionPath = path.resolve(extensionPath);
    // 只认当前发布目录。更新后 Session 可能保留旧版本同名扩展，
    // 不能因为名称相同就跳过当前包，否则新扩展代码永远不会加载。
    const alreadyLoaded = sess.getAllExtensions().some((extension) =>
      path.resolve(extension.path) === normalizedExtensionPath,
    );
    if (alreadyLoaded) {
      loadedExtensionSessions.add(sess);
      return;
    }
    try {
      const extension = await sess.loadExtension(extensionPath, { allowFileAccess: false });
      loadedExtensionSessions.add(sess);
      console.log(
        `[Accounts] 已加载内置浏览器扩展: ${extension.name || DOLA_EXTENSION_NAME}, ` +
          `path=${normalizedExtensionPath}`,
      );
    } catch (error: unknown) {
      console.warn(
        `[Accounts] 内置 Dola 扩展加载失败，将允许后续重试: path=${normalizedExtensionPath}, ` +
          `${error instanceof Error ? error.message : error}`,
      );
    }
  })();
  loadingExtensionSessions.set(sess, promise);
  try {
    await promise;
  } finally {
    // 失败不能永久占住 WeakMap；代理/Session 重配或后续账号列表刷新时
    // 应重新尝试加载，避免更新后的瞬态错误让无水印链路永久失效。
    loadingExtensionSessions.delete(sess);
  }
}

async function ensureDolaLegacyExtensionLoaded(sess: Electron.Session): Promise<void> {
  if (loadedDolaLegacySessions.has(sess)) return;
  const existing = loadingDolaLegacySessions.get(sess);
  if (existing) return existing;

  const promise = (async () => {
    const extensionPath = resolveDolaLegacyExtensionPath();
    if (!extensionPath) {
      console.warn('[Accounts] 未找到内置 Dola 旧扩展目录，将在下次 Session 配置时重试');
      return;
    }
    const normalizedExtensionPath = path.resolve(extensionPath);
    const alreadyLoaded = sess.getAllExtensions().some((extension) =>
      path.resolve(extension.path) === normalizedExtensionPath,
    );
    if (alreadyLoaded) {
      loadedDolaLegacySessions.add(sess);
      return;
    }
    try {
      const extension = await sess.loadExtension(extensionPath, { allowFileAccess: false });
      loadedDolaLegacySessions.add(sess);
      console.log(
        `[Accounts] 已加载 Dola 旧扩展: ${extension.name || DOLA_LEGACY_EXTENSION_NAME}, ` +
          `path=${normalizedExtensionPath}`,
      );
    } catch (error: unknown) {
      console.warn(
        `[Accounts] Dola 旧扩展加载失败，将允许后续重试: path=${normalizedExtensionPath}, ` +
          `${error instanceof Error ? error.message : error}`,
      );
    }
  })();
  loadingDolaLegacySessions.set(sess, promise);
  try {
    await promise;
  } finally {
    loadingDolaLegacySessions.delete(sess);
  }
}

/**
 * 为指定账号创建独立的 Electron Session
 * 通过 partition 实现 Cookie/Storage 完全隔离
 */
function getSessionForAccount(accountId: string, partition: string, platform: AccountPlatform): Electron.Session {
  const sess = session.fromPartition(sessionPartition(platform, partition));
  activePartitions.add(partition);

  // 配置 User-Agent（模拟 Chrome 浏览器）
  sess.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform === 'dola' ? 'zh-CN,zh;q=0.9,en;q=0.1' : 'zh-CN',
  );

  sessionAccountIds.set(sess, accountId);
  sessionAccountPlatforms.set(sess, platform);

  return sess;
}

/** 在账号 webview 首次导航前应用代理，避免不同账号共享网络出口。 */
async function configureSessionProxy(account: Account): Promise<void> {
  const sess = getSessionForAccount(account.id, account.partition, accountPlatform(account));
  if (accountPlatform(account) === 'dola') await ensureDolaSimplifiedChineseLocale(sess);
  await ensureDolaExtensionLoaded(sess);
  await ensureDolaLegacyExtensionLoaded(sess);
  const resolvedRoute = await resolveAccountSessionRouteAsync(account.id, accountPlatform(account));
  const route = resolvedRoute.route;
  const config = resolvedRoute.config || (route.mode === 'proxy' || route.mode === 'relay'
    ? route.config
    : route.mode === 'legacy_global' && accountPlatform(account) === 'dola'
      ? loadDolaProxyConfig()
      : undefined);
  const configWithMetadata = config
    ? {
      ...config,
      credentialsConfigured: route.mode === 'proxy'
        ? Boolean(getBoundProxyCredentials(account.id))
        : !!readProxySecret(DOLA_PROXY_SECRET_KEY),
    }
    : undefined;
  const key = configWithMetadata
    ? `${route.mode}|${route.proxyId || 'global'}|${configWithMetadata.protocol}|${configWithMetadata.host}|${configWithMetadata.port}|${configWithMetadata.credentialsConfigured ? 'auth' : 'noauth'}|network:${readPlatformNetworkConfig()?.version || 0}`
    : `${route.mode}|direct`;
  const partition = sessionPartition(accountPlatform(account), account.partition);
  if (configuredProxyKeys.get(partition) === key) return;
  if (networkBusyAccounts.has(account.id) && configuredProxyKeys.has(partition)) return;
  await sess.setProxy(configWithMetadata
    ? { proxyRules: proxyRules(configWithMetadata), proxyBypassRules: '<local>' }
    : { mode: 'direct' });
  await sess.closeAllConnections().catch(() => undefined);
  configuredProxyKeys.set(partition, key);
}

/** 后台版本变化只重配空闲账号的网络；不刷新页面，不打断生成/上传。 */
export async function synchronizeIdleAccountNetwork(busyAccountIds: Set<string>): Promise<void> {
  networkBusyAccounts = busyAccountIds;
  if (!readPlatformNetworkConfig()) return;
  for (const account of loadAccounts()) {
    if (busyAccountIds.has(account.id)) continue;
    const partition = sessionPartition(accountPlatform(account), account.partition);
    if (configuredProxyKeys.has(partition)) await configureSessionProxy(account);
  }
}

/**
 * Re-apply the effective route after a Session binding changes.
 *
 * Account pages are intentionally kept alive in the renderer, so changing the
 * JSON binding alone is insufficient: an already-created WebView keeps its
 * previous NetworkService route until the session is reconfigured and its
 * existing connections are closed. Reload only the bound account's WebViews.
 */
export async function refreshAccountSessionProxy(accountId: string): Promise<void> {
  const account = loadAccounts().find((item) => item.id === accountId);
  if (!account) throw new Error('窗口账号不存在');
  const platform = accountPlatform(account);

  const partition = sessionPartition(platform, account.partition);
  configuredProxyKeys.delete(partition);
  await configureSessionProxy(account);

  const sess = session.fromPartition(partition);
  const route = resolveAccountSessionRoute(account.id, platform);
  console.log(
    `[Accounts] ${platform} 窗口路由已应用: account=${account.id}, mode=${route.mode}, ` +
      `proxy=${route.config ? `${route.config.protocol}://${route.config.host}:${route.config.port}` : 'direct'}`,
  );

  reloadSessionWebviews(sess, account.id, '代理或 CK 会话更新');
}

/**
 * 让已经挂载的 guest WebView 重新读取刚更新的持久化 Session。
 * 清除 Cookie/Storage 后，旧页面不会因为 Session 内容变化而自动导航；
 * 不显式刷新就会继续显示清除前的登录态，导致“清除登录/重登 CK”看起来无效。
 */
function reloadSessionWebviews(sess: Electron.Session, accountId: string, reason: string): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed() || contents.getType() !== 'webview' || contents.session !== sess) continue;
    try {
      contents.reload();
      console.log(`[Accounts] 已刷新账号 WebView: account=${accountId}, reason=${reason}, webContents=${contents.id}`);
    } catch (error: unknown) {
      console.warn(
        `[Accounts] 刷新账号 WebView 失败: account=${accountId}, reason=${reason}, webContents=${contents.id}, ` +
          `${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}

function accountProxyInputFromConfig(input: AccountProxyInput): AccountProxyInput {
  return {
    enabled: input.enabled === true,
    protocol: input.protocol,
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password,
    clearCredentials: input.clearCredentials === true,
  };
}

async function testProxyInput(input: AccountProxyInput): Promise<AccountTestProxyResult> {
  const normalized = normalizeProxyInput(accountProxyInputFromConfig(input));
  if (!normalized.ok || !normalized.value.config) {
    return { success: false, error: normalized.ok ? '代理未启用' : normalized.error };
  }
  const config = normalized.value.config;
  const storedSecret = readProxySecret(DOLA_PROXY_SECRET_KEY);
  const username = normalized.value.username || storedSecret?.username || '';
  const password = normalized.value.password || storedSecret?.password || '';
  if ((username && !password) || (!username && password)) {
    return { success: false, error: '测试代理时用户名和密码需要同时填写' };
  }
  const testPartition = `proxy-test-${uuidv4()}`;
  const testSession = session.fromPartition(testPartition);
  const loginHandler = (
    authInfo: Electron.AuthInfo,
    callback: (login?: string, secret?: string) => void,
  ): void => {
    if (!authInfo.isProxy || !username || !password) return;
    callback(username, password);
  };
  const startedAt = Date.now();

  try {
    await testSession.setProxy({ proxyRules: proxyRules(config), proxyBypassRules: '<local>' });
    const result = await new Promise<{ statusCode?: number }>((resolve, reject) => {
      const request = net.request({
        method: 'GET',
        url: 'https://dola.com/',
        session: testSession,
      });
      request.on('login', loginHandler);
      const timer = setTimeout(() => {
        request.abort();
        reject(new Error('代理测试超时'));
      }, 20_000);
      request.on('response', (response) => {
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > 256 * 1024) request.abort();
        });
        response.on('end', () => {
          clearTimeout(timer);
          resolve({ statusCode: response.statusCode });
        });
        response.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      request.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      request.end();
    });
    const statusCode = result.statusCode;
    return {
      success: typeof statusCode === 'number' && statusCode >= 200 && statusCode < 400,
      statusCode,
      latencyMs: Date.now() - startedAt,
      error: typeof statusCode === 'number' && statusCode >= 200 && statusCode < 400 ? undefined : `目标站点返回 HTTP ${statusCode ?? '未知状态'}`,
    };
  } catch (error: unknown) {
    return {
      success: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : '代理连接失败',
    };
  } finally {
    await testSession.closeAllConnections().catch(() => undefined);
  }
}

function readDolaProxyPublic(): DolaProxyResult {
  const config = loadDolaProxyConfig();
  if (!config) return { success: true };
  const secret = readProxySecret(DOLA_PROXY_SECRET_KEY);
  return {
    success: true,
    proxy: { ...config, credentialsConfigured: !!secret },
    username: secret?.username,
  };
}

/** 保存 Dola 全局代理，并刷新所有 Dola 隔离 Session。 */
async function setDolaProxyConfig(_input: AccountProxyInput): Promise<DolaProxyResult> {
  return { success: false, error: '平台中转已停用，请在代理与窗口绑定中配置自己的代理' };
}

/**
 * 清除指定账号的 Session 数据（Cookie/Storage）
 */
async function clearAccountSession(partition: string, platform: AccountPlatform): Promise<void> {
  const sess = session.fromPartition(sessionPartition(platform, partition));
  try {
    // 先断开旧连接，避免 Chromium 继续复用清理前的页面/网络连接。
    await sess.closeAllConnections().catch(() => undefined);
    await sess.clearStorageData();
    await sess.clearCache().catch(() => undefined);
    sessionAccountIds.delete(sess);
    sessionAccountPlatforms.delete(sess);
    configuredProxyKeys.delete(sessionPartition(platform, partition));
    if (platform === 'dola') initializedDolaLocaleSessions.delete(sess);
    if (platform === 'dola') initializingDolaLocaleSessions.delete(sess);
    activePartitions.delete(partition);
  } catch (err) {
    console.error(`[Accounts] 清除 Session 失败 (partition=${partition}):`, err);
    throw err instanceof Error ? err : new Error('清除 Session 失败');
  }
}

// ==================== IPC 处理器注册 ====================

const ACCOUNT_IPC_CHANNELS = [
  'accounts:list', 'accounts:add', 'accounts:update', 'accounts:delete',
  'accounts:refresh', 'accounts:setStatus', 'accounts:setPinned',
  'accounts:updateScheduling', 'accounts:updateHealth', 'accounts:setAvailability',
  'accounts:updateSeedanceQuota', 'accounts:setVideoQuotaConfig', 'accounts:refreshDailyQuota', 'accounts:getPartition', 'accounts:getDolaProxy',
  'accounts:setDolaProxy', 'accounts:testProxy',
] as const;

export function registerAccountIPC(): () => void {
  const dispose = replaceIpcHandlers(ipcMain, ACCOUNT_IPC_CHANNELS);
  const proxyLoginHandler = (
    event: Electron.Event,
    webContents: Electron.WebContents,
    _details: Electron.AuthenticationResponseDetails,
    authInfo: Electron.AuthInfo,
    callback: (username?: string, password?: string) => void,
  ): void => {
    if (!authInfo.isProxy) return;
    const platform = sessionAccountPlatforms.get(webContents.session);
    if (!platform) return;
    const accountId = sessionAccountIds.get(webContents.session);
    if (!accountId) return;
    const route = resolveAccountSessionRoute(accountId, platform);
    if (route.mode !== 'proxy' && route.mode !== 'relay') return;
    const secret = route.mode === 'proxy' && accountId
      ? getBoundProxyCredentials(accountId)
      : readProxySecret(DOLA_PROXY_SECRET_KEY);
    if (!secret) return;
    event.preventDefault();
    callback(secret.username, secret.password);
  };
  app.on('login', proxyLoginHandler);
  // ---- 获取所有账号 ----
  ipcMain.handle('accounts:list', async (): Promise<Account[]> => {
    // loadAccounts 已内置运行时归一化（额度日期重置、健康/调度补全、重复 ID 去重）
    const accounts = loadAccounts();
    // 首次创建 webview 前完成代理配置，避免页面先直连再切换出口。
    for (const account of accounts) {
      await configureSessionProxy(account);
    }
    return accounts;
  });

  // ---- 仅刷新每日额度（不创建/重配 Session） ----
  ipcMain.handle('accounts:refreshDailyQuota', async (): Promise<AccountDailyQuotaRefreshResult> => {
    try {
      // loadAccounts 内部以本机自然日归一化 Dola 与豆包账号的额度；
      // 与 accounts:list 分开，避免零点刷新触发代理、扩展或 WebView 重配置。
      const accounts = loadAccounts();
      return { success: true, accounts, refreshedAt: new Date().toISOString() };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '每日额度刷新失败',
      };
    }
  });

  // ---- 添加账号 ----
  ipcMain.handle(
    'accounts:add',
    async (_event, params: AccountAddParams): Promise<{ success: boolean; account?: Account; error?: string }> => {
      try {
        const trimmedName = params.name?.trim();
        if (!trimmedName) {
          return { success: false, error: '账号名称不能为空' };
        }

        const accounts = loadAccounts();

        // 检查同名账号
        const platform: AccountPlatform = params.platform === 'dola' ? 'dola' : 'doubao';
        if (accounts.some((a) => a.name === trimmedName && accountPlatform(a) === platform)) {
          return { success: false, error: `账号「${trimmedName}」已存在` };
        }

        const newAccount: Account = {
          id: uuidv4(),
          name: trimmedName,
          platform,
          avatar: '', // 后续从豆包页面抓取
          partition: `account_${uuidv4().slice(0, 8)}`,
          status: 'idle',
          pinned: false,
          seedanceQuota: {
            date: localDateKey(),
            usedUnits: 0,
            estimatedTotalUnits: DEFAULT_SEEDANCE_DAILY_UNITS,
            exhausted: false,
            updatedAt: new Date().toISOString(),
          },
          health: {
            loginState: 'unknown',
            verificationRequired: false,
            consecutiveFailures: 0,
            successCount: 0,
            failureCount: 0,
          },
          scheduling: { enabled: true, weight: 1, preferredModes: [] },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        // 预创建独立 Session
        await configureSessionProxy(newAccount);

        accounts.push(newAccount);
        if (!saveAccounts(accounts)) {
          return { success: false, error: '账号数据写入失败，请检查磁盘空间和数据目录权限' };
        }

        return { success: true, account: newAccount };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  );

  // ---- 持久化网页真实可用性探测（不修改历史成功/失败计数） ----
  ipcMain.handle(
    'accounts:setAvailability',
    async (_event, params: AccountSetAvailabilityParams): Promise<{ success: boolean; account?: Account; error?: string }> => {
      const accounts = loadAccounts();
      const account = accounts.find((item) => item.id === params.id);
      if (!account) return { success: false, error: '账号不存在' };
      normalizeHealth(account);
      const health = account.health;
      if (!health) return { success: false, error: '账号健康状态初始化失败' };
      const allowedStates = new Set(['unknown', 'ready', 'action_required', 'login_required', 'unavailable']);
      const allowedSources = new Set(['startup', 'navigation', 'pre_task', 'pre_submit', 'manual']);
      const availability = params.availability;
      if (
        !availability || !allowedStates.has(availability.state) || !allowedSources.has(availability.source) ||
        typeof availability.reason !== 'string' || typeof availability.message !== 'string' ||
        !Number.isFinite(new Date(availability.checkedAt).getTime())
      ) {
        return { success: false, error: '账号可用性检测结果无效' };
      }

      const previousErrorCode = health.lastErrorCode;
      health.availability = {
        ...availability,
        reason: availability.reason.slice(0, 100),
        message: availability.message.slice(0, 300),
      };
      if (availability.state === 'ready') {
        health.loginState = 'ok';
        health.verificationRequired = false;
        if (['verification', 'human_verification', 'login_required'].includes(previousErrorCode || '')) {
          health.lastErrorCode = undefined;
          health.cooldownUntil = undefined;
        }
      } else if (availability.state === 'action_required') {
        health.verificationRequired = true;
        health.lastErrorCode = availability.reason;
      } else if (availability.state === 'login_required') {
        health.loginState = 'expired';
        health.verificationRequired = false;
        health.lastErrorCode = availability.reason;
      } else if (availability.state === 'unavailable') {
        health.lastErrorCode = availability.reason;
      }
      account.updatedAt = new Date().toISOString();
      if (!saveAccounts(accounts)) {
        return { success: false, error: '账号可用性写入失败，请检查磁盘空间和数据目录权限' };
      }
      return { success: true, account };
    },
  );

  // ---- 编辑账号名称 ----
  ipcMain.handle(
    'accounts:update',
    async (_event, params: AccountUpdateParams): Promise<{ success: boolean; error?: string }> => {
      const trimmedName = params.name?.trim();
      if (!trimmedName) {
        return { success: false, error: '账号名称不能为空' };
      }

      const accounts = loadAccounts();
      const account = accounts.find((a) => a.id === params.id);
      if (!account) {
        return { success: false, error: '账号不存在' };
      }

      // 排除自身后查重
      if (accounts.some((a) => a.id !== params.id && a.name === trimmedName && accountPlatform(a) === accountPlatform(account))) {
        return { success: false, error: `账号「${trimmedName}」已存在` };
      }

      account.name = trimmedName;
      account.updatedAt = new Date().toISOString();
      if (!saveAccounts(accounts)) {
        return { success: false, error: '账号数据写入失败，请检查磁盘空间和数据目录权限' };
      }

      return { success: true };
    }
  );

  // ---- 删除账号 ----
  ipcMain.handle(
    'accounts:delete',
    async (_event, params: AccountIdParams): Promise<{ success: boolean; error?: string }> => {
      const accounts = loadAccounts();
      const idx = accounts.findIndex((a) => a.id === params.id);
      if (idx === -1) {
        return { success: false, error: '账号不存在' };
      }

      // 引用完整性：仅运行中/排队任务必须保留账号；终态任务不再阻止账号清理。
      // 未知或缺失状态按活动任务处理，避免产生孤儿任务引用。
      const activeTaskStatuses = new Set([
        'queued',
        'executing',
        'generating',
        'waiting_verification',
        'waiting_generation_confirmation',
        'manual_submission_observing',
      ]);
      const tasks = readJSON<Array<{ assignedAccountId?: string | null; status?: string | null }>>('tasks.json', []);
      const linkedActiveTaskCount = tasks.filter((task) => {
        if (task.assignedAccountId !== params.id) return false;
        return !task.status || activeTaskStatuses.has(task.status);
      }).length;
      if (linkedActiveTaskCount > 0) {
        return { success: false, error: `仍有 ${linkedActiveTaskCount} 个排队或运行中的任务指派到此账号，请先暂停或迁移这些任务` };
      }

      const removed = accounts.splice(idx, 1)[0];
      if (!saveAccounts(accounts)) {
        return { success: false, error: '账号数据写入失败，请检查磁盘空间和数据目录权限' };
      }

      // 先持久化删除，再清理不可回滚的登录数据，避免写盘失败却把现有账号登出。
      await clearAccountSession(removed.partition, accountPlatform(removed));
      if (!removeProxySecret(removed.id)) {
        console.warn(`[Accounts] 清理账号 ${removed.id} 的代理凭据失败`);
      }
      return { success: true };
    }
  );

  // ---- 刷新账号（清除 Session 后重新加载） ----
  ipcMain.handle(
    'accounts:refresh',
    async (_event, params: AccountIdParams): Promise<{ success: boolean; error?: string }> => {
      const accounts = loadAccounts();
      const account = accounts.find((a) => a.id === params.id);
      if (!account) {
        return { success: false, error: '账号不存在' };
      }

      try {
        await clearAccountSession(account.partition, accountPlatform(account));
        // 重新创建 Session
        configuredProxyKeys.delete(sessionPartition(accountPlatform(account), account.partition));
        await configureSessionProxy(account);
        account.status = 'idle';
        account.updatedAt = new Date().toISOString();
        if (!saveAccounts(accounts)) {
          return { success: false, error: '账号数据写入失败，请检查磁盘空间和数据目录权限' };
        }

        // 清理成功后刷新同一分区的页面；否则旧 WebView 仍会显示清理前的登录态。
        reloadSessionWebviews(
          session.fromPartition(sessionPartition(accountPlatform(account), account.partition)),
          account.id,
          '清除登录并刷新',
        );
        return { success: true };
      } catch (error: unknown) {
        return { success: false, error: error instanceof Error ? error.message : '清除登录失败' };
      }
    }
  );

  // ---- 更新账号状态 ----
  ipcMain.handle(
    'accounts:setStatus',
    async (_event, params: AccountSetStatusParams): Promise<{ success: boolean }> => {
      const accounts = loadAccounts();
      const account = accounts.find((a) => a.id === params.id);
      if (!account) return { success: false };
      account.status = params.status;
      account.updatedAt = new Date().toISOString();
      if (!saveAccounts(accounts)) {
        return { success: false };
      }
      return { success: true };
    }
  );

  // ---- 切换置顶状态 ----
  ipcMain.handle(
    'accounts:setPinned',
    async (_event, params: AccountSetPinnedParams): Promise<{ success: boolean }> => {
      const accounts = loadAccounts();
      const account = accounts.find((a) => a.id === params.id);
      if (!account) return { success: false };
      account.pinned = params.pinned;
      account.updatedAt = new Date().toISOString();
      if (!saveAccounts(accounts)) {
        return { success: false };
      }
      return { success: true };
    }
  );

  ipcMain.handle('accounts:updateScheduling', async (_event, params: AccountUpdateSchedulingParams) => {
    const accounts = loadAccounts();
    const account = accounts.find((item) => item.id === params.id);
    if (!account) return { success: false };
    normalizeScheduling(account);
    account.scheduling = { ...account.scheduling!, ...params.updates };
    normalizeScheduling(account);
    account.updatedAt = new Date().toISOString();
    if (!saveAccounts(accounts)) {
      return { success: false, error: '账号数据写入失败，请检查磁盘空间和数据目录权限' };
    }
    return { success: true, account };
  });

  ipcMain.handle(
    'accounts:updateHealth',
    async (_event, params: AccountUpdateHealthParams): Promise<{ success: boolean; account?: Account; error?: string }> => {
      const accounts = loadAccounts();
      const account = accounts.find((item) => item.id === params.id);
      if (!account) return { success: false };
      normalizeHealth(account);
      const health = account.health!;
      const now = new Date();

      if (params.action === 'success') {
        health.loginState = 'ok';
        health.verificationRequired = false;
        health.consecutiveFailures = 0;
        health.successCount++;
        health.lastSuccessAt = now.toISOString();
        health.lastErrorCode = undefined;
        health.cooldownUntil = undefined;
      } else if (params.action === 'failure') {
        health.consecutiveFailures++;
        health.failureCount++;
        health.lastFailureAt = now.toISOString();
        health.lastErrorCode = params.errorCode;
        if (health.consecutiveFailures >= 3) {
          health.cooldownUntil = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
        }
      } else if (params.action === 'verification') {
        health.verificationRequired = true;
        health.lastErrorCode = 'verification';
        health.cooldownUntil = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
      } else if (params.action === 'login_expired') {
        health.loginState = 'expired';
        health.lastErrorCode = 'page_changed';
      } else {
        account.health = {
          loginState: 'unknown', verificationRequired: false, consecutiveFailures: 0,
          successCount: health.successCount, failureCount: health.failureCount,
        };
      }
      account.updatedAt = now.toISOString();
      if (!saveAccounts(accounts)) {
        return { success: false, error: '账号数据写入失败，请检查磁盘空间和数据目录权限' };
      }
      return { success: true, account };
    }
  );

  // ---- 更新 Seedance 每日额度预测 ----
  ipcMain.handle(
    'accounts:updateSeedanceQuota',
    async (_event, params: AccountUpdateSeedanceQuotaParams): Promise<{ success: boolean; account?: Account; error?: string }> => {
      const accounts = loadAccounts();
      const account = accounts.find((item) => item.id === params.id);
      if (!account) return { success: false, error: '账号不存在' };
      if (params.action === 'reset' && account.status === 'busy') {
        return { success: false, error: '账号正在运行任务，请等待任务完成后再释放本地额度' };
      }
      normalizeQuota(account);
      const updatedAt = new Date().toISOString();
      account.seedanceQuota = applyVideoQuotaAction(account.seedanceQuota!, params.action, params.units, updatedAt);
      if (params.action === 'reset') {
        normalizeHealth(account);
        account.health = releaseQuotaExhaustionHealth(account.health!);
      }
      account.updatedAt = updatedAt;
      if (!saveAccounts(accounts)) {
        return { success: false, error: '账号数据写入失败，请检查磁盘空间和数据目录权限' };
      }
      return { success: true, account };
    }
  );

  // ---- 设置账号视频额度规则（豆包与 Dola 共用） ----
  ipcMain.handle(
    'accounts:setVideoQuotaConfig',
    async (_event, params: AccountSetVideoQuotaConfigParams): Promise<{ success: boolean; account?: Account; error?: string }> => {
      if (!Number.isSafeInteger(params.totalUnits) || params.totalUnits <= 0) {
        return { success: false, error: '每日总额度必须是正整数' };
      }
      if (!Number.isSafeInteger(params.costPerVideoUnits) || params.costPerVideoUnits <= 0) {
        return { success: false, error: '单次视频消耗必须是正整数' };
      }
      const accounts = loadAccounts();
      const account = accounts.find((item) => item.id === params.id);
      if (!account) return { success: false, error: '账号不存在' };
      if (account.status === 'busy') return { success: false, error: '账号正在运行任务，请等待任务完成后再修改额度' };

      normalizeQuota(account);
      const quota = account.seedanceQuota;
      if (!quota) return { success: false, error: '账号额度状态初始化失败' };
      const updatedAt = new Date().toISOString();
      account.seedanceQuota = {
        ...quota,
        estimatedTotalUnits: params.totalUnits,
        costPerVideoUnits: params.costPerVideoUnits,
        exhausted: quota.usedUnits >= params.totalUnits,
        updatedAt,
      };
      account.updatedAt = updatedAt;
      if (!saveAccounts(accounts)) {
        return { success: false, error: '账号额度配置写入失败，请检查磁盘空间和数据目录权限' };
      }
      return { success: true, account };
    },
  );

  // ---- 读取 Dola 全局代理公开配置（不返回密码） ----
  ipcMain.handle(
    'accounts:getDolaProxy',
    async (): Promise<DolaProxyResult> => readDolaProxyPublic(),
  );

  // ---- 保存 Dola 全局代理并立即刷新所有 Dola Session ----
  ipcMain.handle(
    'accounts:setDolaProxy',
    async (_event, params: { proxy: AccountProxyInput }): Promise<DolaProxyResult> => setDolaProxyConfig(params.proxy),
  );

  // ---- 通过 Electron NetworkService 测试代理，不创建页面或上传凭据 ----
  ipcMain.handle(
    'accounts:testProxy',
    async (_event, params: { proxy: AccountProxyInput }): Promise<AccountTestProxyResult> => testProxyInput(params.proxy),
  );

  // ---- 获取账号 Session 信息 ----
  ipcMain.handle(
    'accounts:getPartition',
    async (_event, params: AccountIdParams): Promise<string | null> => {
      const accounts = loadAccounts();
      const account = accounts.find((a) => a.id === params.id);
      return account ? account.partition : null;
    }
  );

  console.log('[IPC] 账号管理模块已注册');
  return () => {
    app.removeListener('login', proxyLoginHandler);
    dispose();
  };
}
