import { net, session } from 'electron';
import { ipcMain } from '../security/trustedIpc';
import { randomUUID } from 'crypto';
import type {
  DolaCkImportItem,
  DolaEmailImportItem,
  DolaPoolEntry,
  DoubaoCkImportItem,
  DoubaoPoolEntry,
  LocalManagerSnapshot,
  LocalRoutingMode,
  ProxySubscriptionInput,
  ProxyPoolEntry,
  ProxyPoolInput,
} from '@doubao-studio/contracts';
import { replaceIpcHandlers } from './lifecycle';
import {
  addProxy,
  addSubscription,
  bindSession,
  clearDolaEntries,
  clearDoubaoEntries,
  deleteDoubaoEntry,
  deleteDolaEntry,
  deleteProxy,
  deleteSubscription,
  getDolaSecret,
  getDoubaoSecret,
  getConcurrency,
  getDolaRelayConfig,
  getDolaRelayCredentials,
  getProxyEntry,
  getProxySecret,
  getSubscriptionEntry,
  getSubscriptionUrl,
  importDolaCk,
  importDolaCkText,
  importDolaEmail,
  importDoubaoCk,
  importDoubaoCkText,
  linkDoubaoAccount,
  linkDolaAccount,
  listLocalManager,
  randomAssign,
  replaceSubscriptionProxies,
  setConcurrency,
  setProxyEnabled,
  setRoutingMode,
  unbindSession,
  updateDolaCheck,
  updateDoubaoCheck,
  updateProxyCheck,
  updateSubscription,
} from '../utils/localManagerStore';
import { cookieExpiryIsUsable } from '../utils/dolaCkJson';
import { readJSON } from '../utils/store';
import { listLocalAssets } from '../utils/localAssetStore';
import { refreshAccountSessionProxy } from './accounts';
import { getSessionProxyCoreConfig } from '../utils/sessionProxyRouter';
import { fetchProxySubscription, isCoreManagedProxyProtocol } from '../utils/proxySubscription';
import { stopAirportProxyCore, withTemporaryAirportProxy } from '../utils/airportProxyCore';

const LOCAL_MANAGER_CHANNELS = [
  'localManager:snapshot',
  'localManager:dola:importCk',
  'localManager:doubao:importCk',
  'localManager:dola:importEmail',
  'localManager:dola:loadToAccount',
  'localManager:dola:relogin',
  'localManager:dola:delete',
  'localManager:dola:clear',
  'localManager:dola:retest',
  'localManager:doubao:loadToAccount',
  'localManager:doubao:relogin',
  'localManager:doubao:delete',
  'localManager:doubao:clear',
  'localManager:doubao:retest',
  'localManager:dola:setConcurrency',
  'localManager:proxy:add',
  'localManager:proxy:setEnabled',
  'localManager:proxy:delete',
  'localManager:proxy:retest',
  'localManager:subscription:add',
  'localManager:subscription:refresh',
  'localManager:subscription:delete',
  'localManager:binding:bind',
  'localManager:binding:unbind',
  'localManager:binding:randomAssign',
  'localManager:routing:setMode',
  'localManager:assets:list',
] as const;

// 只验证代理链路和出口连通性。Dola 首页会在部分代理链上长时间等待，
// 不能作为代理可用性的判据；CK 有效性仍由单独的 Dola 会话探测负责。
const PROBE_URL = 'https://api.ipify.org?format=text';
const DOUBAO_PROBE_URL = 'https://www.doubao.com/chat/';
const PROBE_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

interface ProbeResult {
  success: boolean;
  statusCode?: number;
  latencyMs: number;
  error?: string;
}

export interface DolaSessionRestoreSummary {
  attempted: number;
  restored: number;
  skipped: number;
  failed: number;
}

interface StoredAccount {
  id?: unknown;
  platform?: unknown;
}

function accountPlatformMap(): Record<string, 'doubao' | 'dola'> {
  const accounts = readJSON<unknown>('accounts.json', []);
  const result: Record<string, 'doubao' | 'dola'> = {};
  if (!Array.isArray(accounts)) return result;
  for (const raw of accounts) {
    const account = raw as StoredAccount;
    if (typeof account.id !== 'string') continue;
    result[account.id] = account.platform === 'dola' ? 'dola' : 'doubao';
  }
  return result;
}

function accountPartition(accountId: string, platform: 'doubao' | 'dola' = 'dola'): string | null {
  const accounts = readJSON<unknown>('accounts.json', []);
  if (!Array.isArray(accounts)) return null;
  const account = accounts.find((raw) => {
    const value = raw as StoredAccount & { partition?: unknown };
    return value.id === accountId && value.platform === platform && typeof value.partition === 'string';
  }) as (StoredAccount & { partition?: string }) | undefined;
  return account?.partition || null;
}

/**
 * 在首个 Dola WebView 创建前恢复已关联 CK。
 *
 * CK JSON 已经以加密形式保存在本地管理器中；这里重新写入对应的持久
 * partition，使导出工具产生的会话 Cookie（包括 session Cookie）在应用
 * 重启后仍能恢复。代理配置仍由 accounts:list 在 WebView 首次导航前应用。
 * 单条 CK 恢复失败只记录诊断，不阻断整个应用启动。
 */
export async function restoreLinkedDolaSessions(): Promise<DolaSessionRestoreSummary> {
  const entries: DolaPoolEntry[] = listLocalManager().dola.filter(
    (entry) => entry.source !== 'email' && Boolean(entry.accountId?.trim()),
  );
  const summary: DolaSessionRestoreSummary = {
    attempted: entries.length,
    restored: 0,
    skipped: 0,
    failed: 0,
  };

  for (const entry of entries) {
    const accountId = entry.accountId?.trim();
    const secret = getDolaSecret(entry.id);
    const partition = accountId ? accountPartition(accountId) : null;
    if (!accountId || !partition || !secret?.cookies?.length) {
      summary.skipped += 1;
      console.warn(
        `[LocalManager] 启动恢复 Dola CK 已跳过: entry=${entry.id}, ` +
          `reason=${!accountId ? 'missing_account' : !partition ? 'account_missing' : 'secret_missing'}`,
      );
      continue;
    }

    try {
      const target = session.fromPartition(`persist:dola_${partition}`);
      await resetDolaSessionForCkRestore(target);
      await applyCookies(target, secret.cookies);
      summary.restored += 1;
    } catch (error: unknown) {
      summary.failed += 1;
      console.warn(
        `[LocalManager] 启动恢复 Dola CK 失败: entry=${entry.id}, ` +
          `error=${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  return summary;
}

/** 在首个豆包 WebView 创建前恢复已关联的豆包 CK。 */
export async function restoreLinkedDoubaoSessions(): Promise<DolaSessionRestoreSummary> {
  const entries: DoubaoPoolEntry[] = listLocalManager().doubao.filter(
    (entry) => Boolean(entry.accountId?.trim()),
  );
  const summary: DolaSessionRestoreSummary = { attempted: entries.length, restored: 0, skipped: 0, failed: 0 };

  for (const entry of entries) {
    const accountId = entry.accountId?.trim();
    const secret = getDoubaoSecret(entry.id);
    const partition = accountId ? accountPartition(accountId, 'doubao') : null;
    if (!accountId || !partition || !secret?.cookies?.length) {
      summary.skipped += 1;
      console.warn(
        `[LocalManager] 启动恢复豆包 CK 已跳过: entry=${entry.id}, ` +
          `reason=${!accountId ? 'missing_account' : !partition ? 'account_missing' : 'secret_missing'}`,
      );
      continue;
    }
    try {
      const target = session.fromPartition(`persist:doubao_${partition}`);
      await resetDolaSessionForCkRestore(target);
      await applyCookies(target, secret.cookies);
      summary.restored += 1;
    } catch (error: unknown) {
      summary.failed += 1;
      console.warn(
        `[LocalManager] 启动恢复豆包 CK 失败: entry=${entry.id}, ` +
          `error=${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
  return summary;
}

function cookieUrl(domain: string, cookiePath = '/'): string {
  return `https://${domain.replace(/^\./, '')}${cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`}`;
}

async function applyCookies(sess: Electron.Session, cookies: NonNullable<ReturnType<typeof getDolaSecret>>['cookies']): Promise<void> {
  if (!cookies || cookies.length === 0) throw new Error('CK JSON 没有可用 Cookie');
  let usable = 0;
  for (const cookie of cookies) {
    if (!cookieExpiryIsUsable(cookie)) continue;
    await sess.cookies.set({
      url: cookieUrl(cookie.domain, cookie.path),
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: cookie.httpOnly === true,
      ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}),
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    });
    usable += 1;
  }
  if (usable === 0) throw new Error('CK JSON 中的 Cookie 已全部过期');
}

/**
 * 重登 CK 前清理旧的 Dola 会话状态。
 * Dola 的语言/区域状态损坏时可能在中英文之间循环导航；手动点击
 * “清除登录并刷新”后再写回 CK 可以恢复。仅用于 Dola CK 恢复流程。
 */
async function resetDolaSessionForCkRestore(sess: Electron.Session): Promise<void> {
  // 先断开旧连接，避免清理后旧页面/网络连接继续复用失效登录态。
  await sess.closeAllConnections().catch(() => undefined);
  await sess.clearStorageData();
  await sess.clearCache().catch(() => undefined);
}

function probeSession(
  sess: Electron.Session,
  credentials?: { username: string; password: string },
  url = PROBE_URL,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let received = 0;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = net.request({ method: 'GET', url, session: sess });
    request.on('login', (authInfo, callback) => {
      if (!authInfo.isProxy || !credentials) return;
      callback(credentials.username, credentials.password);
    });
    const timer = setTimeout(() => {
      request.abort();
      finish({ success: false, latencyMs: Date.now() - startedAt, error: '检测超时' });
    }, PROBE_TIMEOUT_MS);
    request.on('response', (response) => {
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) request.abort();
      });
      response.on('end', () => {
        clearTimeout(timer);
        const statusCode = response.statusCode;
        finish({
          success: typeof statusCode === 'number' && statusCode >= 200 && statusCode < 400,
          statusCode,
          latencyMs: Date.now() - startedAt,
          error: typeof statusCode === 'number' && statusCode >= 200 && statusCode < 400
            ? undefined
            : `目标站点返回 HTTP ${statusCode ?? '未知状态'}`,
        });
      });
      response.on('error', (error) => {
        clearTimeout(timer);
        finish({ success: false, latencyMs: Date.now() - startedAt, error: error.message });
      });
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      finish({ success: false, latencyMs: Date.now() - startedAt, error: error.message });
    });
    request.end();
  });
}

async function checkDolaEntry(entryId: string): Promise<void> {
  const secret = getDolaSecret(entryId);
  const checkedAt = new Date().toISOString();
  updateDolaCheck(entryId, { state: 'checking', lastCheckedAt: checkedAt, error: undefined });
  if (!secret?.cookies) {
    updateDolaCheck(entryId, { state: 'manual_required', lastCheckedAt: checkedAt, error: '邮箱账号需要在 Dola 页面手动完成登录' });
    return;
  }
  const partition = `dola-local-check-${randomUUID()}`;
  const sess = session.fromPartition(partition);
  try {
    await applyCookies(sess, secret.cookies);
    // CK 有效性探测必须复用已配置的香港中转，否则本地网络会把有效 CK
    // 误判成失效。没有 relay 配置时才退回本地直连探测。
    const relay = getDolaRelayConfig();
    if (relay) {
      await sess.setProxy({ proxyRules: `${relay.protocol}://${relay.host}:${relay.port}`, proxyBypassRules: '<local>' });
      await sess.closeAllConnections().catch(() => undefined);
    }
    const probe = await probeSession(sess, relay ? (getDolaRelayCredentials() || undefined) : undefined);
    updateDolaCheck(entryId, {
      state: probe.success ? 'valid' : 'invalid',
      lastCheckedAt: checkedAt,
      error: probe.error,
    });
  } catch (error: unknown) {
    updateDolaCheck(entryId, {
      state: 'invalid',
      lastCheckedAt: checkedAt,
      error: error instanceof Error ? error.message : 'CK 检测失败',
    });
  } finally {
    await sess.clearStorageData().catch(() => undefined);
    await sess.closeAllConnections().catch(() => undefined);
  }
}

async function checkDoubaoEntry(entryId: string): Promise<void> {
  const secret = getDoubaoSecret(entryId);
  const checkedAt = new Date().toISOString();
  updateDoubaoCheck(entryId, { state: 'checking', lastCheckedAt: checkedAt, error: undefined });
  if (!secret?.cookies) {
    updateDoubaoCheck(entryId, { state: 'invalid', lastCheckedAt: checkedAt, error: '豆包 CK 内容为空' });
    return;
  }
  const partition = `doubao-local-check-${randomUUID()}`;
  const sess = session.fromPartition(partition);
  try {
    await applyCookies(sess, secret.cookies);
    const probe = await probeSession(sess, undefined, DOUBAO_PROBE_URL);
    updateDoubaoCheck(entryId, {
      state: probe.success ? 'valid' : 'invalid',
      lastCheckedAt: checkedAt,
      error: probe.error,
    });
  } catch (error: unknown) {
    updateDoubaoCheck(entryId, {
      state: 'invalid',
      lastCheckedAt: checkedAt,
      error: error instanceof Error ? error.message : '豆包 CK 检测失败',
    });
  } finally {
    await sess.clearStorageData().catch(() => undefined);
    await sess.closeAllConnections().catch(() => undefined);
  }
}

async function checkProxyEntry(proxyId: string): Promise<void> {
  const entry = getProxyEntry(proxyId);
  if (!entry || entry.enabled === false) return;
  const secret = getProxySecret(proxyId);
  const relayConfig = getDolaRelayConfig();
  const relaySecret = relayConfig ? getDolaRelayCredentials() : null;
  const partition = `proxy-local-check-${randomUUID()}`;
  const sess = session.fromPartition(partition);
  const checkedAt = new Date().toISOString();
  updateProxyCheck(proxyId, { state: 'checking', lastCheckedAt: checkedAt, error: undefined });
  try {
    let probe: ProbeResult;
    if (entry.managedByCore || isCoreManagedProxyProtocol(entry.protocol)
      || (entry.protocol === 'socks5' && entry.credentialsConfigured)) {
      const coreConfig = getSessionProxyCoreConfig(proxyId);
      if (!coreConfig) throw new Error('机场节点配置缺失，请刷新订阅后重试');
      probe = await withTemporaryAirportProxy(coreConfig, async (endpoint) => {
        await sess.setProxy({
          proxyRules: `${endpoint.protocol}://${endpoint.host}:${endpoint.port}`,
          proxyBypassRules: '<local>',
        });
        await sess.closeAllConnections().catch(() => undefined);
        return probeSession(sess);
      });
    } else {
      // 平台共享 IP 的连通性以固定中转出口为准；用户自定义代理仍直接
      // 检测其自身地址，避免固定中转的状态覆盖代理池里的自定义条目。
      const probeConfig = entry.isBuiltin && relayConfig ? relayConfig : {
        enabled: true,
        protocol: entry.protocol,
        host: entry.host,
        port: entry.port,
      };
      await sess.setProxy({
        proxyRules: `${probeConfig.protocol}://${probeConfig.host}:${probeConfig.port}`,
        proxyBypassRules: '<local>',
      });
      const probeSecret = entry.isBuiltin && relaySecret ? relaySecret : (secret?.username && secret.password
        ? { username: secret.username, password: secret.password }
        : undefined);
      probe = await probeSession(sess, probeSecret);
    }
    updateProxyCheck(proxyId, {
      state: probe.success ? 'valid' : 'invalid',
      lastCheckedAt: checkedAt,
      latencyMs: probe.latencyMs,
      error: probe.error,
    });
  } catch (error: unknown) {
    updateProxyCheck(proxyId, {
      state: 'invalid',
      lastCheckedAt: checkedAt,
      error: error instanceof Error ? error.message : '代理检测失败',
    });
  } finally {
    await sess.closeAllConnections().catch(() => undefined);
  }
}

async function checkAllDola(): Promise<void> {
  const entries = listLocalManager().dola.filter((entry) => entry.source !== 'email');
  await runWithConcurrency(entries, getConcurrency(), async (entry) => checkDolaEntry(entry.id));
}

async function checkAllDoubao(): Promise<void> {
  const entries = listLocalManager().doubao;
  await runWithConcurrency(entries, getConcurrency(), async (entry) => checkDoubaoEntry(entry.id));
}

async function checkAllProxies(): Promise<void> {
  const entries = listLocalManager().proxies.filter((entry) => entry.enabled !== false);
  await runWithConcurrency(entries, getConcurrency(), async (entry) => checkProxyEntry(entry.id));
}

/** 拉取并刷新一个订阅；订阅节点不经过固定 Dola 中转。 */
export async function refreshProxySubscription(subscriptionId: string): Promise<LocalManagerSnapshot> {
  const subscription = getSubscriptionEntry(subscriptionId);
  if (!subscription) throw new Error('订阅不存在');
  const url = getSubscriptionUrl(subscriptionId);
  if (!url) {
    updateSubscription(subscriptionId, {
      state: 'not_configured',
      error: subscription.isBuiltin ? '平台共享订阅尚未配置，请联系管理员' : '订阅地址不存在，请重新添加',
    });
    throw new Error(subscription.isBuiltin ? '平台共享订阅尚未配置，请联系管理员' : '订阅地址不存在，请重新添加');
  }

  const before = listLocalManager();
  updateSubscription(subscriptionId, { state: 'refreshing', error: undefined });
  try {
    const parsed = await fetchProxySubscription(url);
    if (parsed.nodes.length === 0) {
      throw new Error(`未找到可用的机场节点${parsed.unsupportedProtocols.length ? `，检测到无法识别的协议：${parsed.unsupportedProtocols.join('、')}` : ''}`);
    }
    const oldProxyIds = new Set(before.proxies.filter((proxy) => proxy.subscriptionId === subscriptionId).map((proxy) => proxy.id));
    await Promise.all([...oldProxyIds].map((proxyId) => stopAirportProxyCore(proxyId)));
    const entries = replaceSubscriptionProxies(subscriptionId, parsed.nodes);
    // 所有订阅节点都必须进入检测队列；限制并发而不是截断列表，避免分页后
    // 的节点永久停留在“未检测”。
    await runWithConcurrency(entries, Math.max(2, Math.min(4, getConcurrency())), async (entry) => checkProxyEntry(entry.id));
    const warnings: string[] = [];
    if (parsed.unsupportedProtocols.length > 0) {
      warnings.push(`已忽略不支持的节点协议：${parsed.unsupportedProtocols.join('、')}`);
    }
    const warning = warnings.length > 0 ? warnings.join('；') : undefined;
    updateSubscription(subscriptionId, {
      state: 'ready',
      nodeCount: parsed.nodes.length,
      supportedNodeCount: parsed.nodes.length,
      unsupportedNodeCount: parsed.unsupportedProtocols.length,
      lastRefreshedAt: new Date().toISOString(),
      error: warning,
    });
    const affectedAccounts = before.bindings
      .filter((binding) => oldProxyIds.has(binding.proxyId || ''))
      .map((binding) => binding.accountId);
    await runWithConcurrency(affectedAccounts, 2, async (accountId) => refreshAccountSessionProxy(accountId));
    return listLocalManager();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '订阅刷新失败';
    updateSubscription(subscriptionId, { state: 'error', error: message });
    throw new Error(message);
  }
}

async function runWithConcurrency<T>(items: readonly T[], requested: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const limit = Math.max(1, Math.min(requested, items.length));
  const run = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => run()));
}

/**
 * 统一代理配置的导入与即时检测边界，供 Lalor 商城交付复用。
 * 返回检测后的条目，避免调用方读取到尚未更新的旧快照。
 */
export async function importAndCheckProxyInput(input: ProxyPoolInput): Promise<{ entry: ProxyPoolEntry; snapshot: LocalManagerSnapshot }> {
  const created = addProxy(input);
  await checkProxyEntry(created.id);
  const snapshot = listLocalManager();
  const entry = snapshot.proxies.find((item) => item.id === created.id);
  if (!entry) throw new Error('代理导入后未找到对应记录');
  return { entry, snapshot };
}

/**
 * 统一 CK JSON 文本的导入与即时检测边界，供文件导入和商城交付复用。
 */
export async function importAndCheckDolaCkText(
  label: string | undefined,
  email: string | undefined,
  ckText: string,
  accountId?: string,
  source?: 'ck_json' | 'ck_txt',
): Promise<DolaPoolEntry[]> {
  const imported = importDolaCkText(label, email, ckText, accountId, source);
  await runWithConcurrency(imported, getConcurrency(), async (entry) => checkDolaEntry(entry.id));
  const checkedById = new Map(listLocalManager().dola.map((entry) => [entry.id, entry]));
  return imported.map((entry) => checkedById.get(entry.id) || entry);
}

/** 统一豆包 CK 文本导入与即时检测边界，供文件和商城交付复用。 */
export async function importAndCheckDoubaoCkText(
  label: string | undefined,
  email: string | undefined,
  ckText: string,
  accountId?: string,
  source?: 'ck_json' | 'ck_txt',
): Promise<DoubaoPoolEntry[]> {
  const imported = importDoubaoCkText(label, email, ckText, accountId, source);
  await runWithConcurrency(imported, getConcurrency(), async (entry) => checkDoubaoEntry(entry.id));
  const checkedById = new Map(listLocalManager().doubao.map((entry) => [entry.id, entry]));
  return imported.map((entry) => checkedById.get(entry.id) || entry);
}

export function registerLocalManagerIPC(): () => void {
  const dispose = replaceIpcHandlers(ipcMain, LOCAL_MANAGER_CHANNELS);

  ipcMain.handle('localManager:snapshot', async () => ({ success: true, data: listLocalManager() }));

  ipcMain.handle('localManager:dola:importCk', async (_event, params: DolaCkImportItem) => {
    try {
      if (typeof params.ckJson === 'string') {
        await importAndCheckDolaCkText(params.label, params.email, params.ckJson, params.accountId, params.source);
      } else {
        const entry = importDolaCk(params.label, params.email, params.ckJson, params.accountId);
        await checkDolaEntry(entry.id);
      }
      return { success: true, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'CK 导入失败' };
    }
  });

  ipcMain.handle('localManager:doubao:importCk', async (_event, params: DoubaoCkImportItem) => {
    try {
      if (typeof params.ckJson === 'string') {
        await importAndCheckDoubaoCkText(params.label, params.email, params.ckJson, params.accountId, params.source);
      } else {
        const entry = importDoubaoCk(params.label, params.email, params.ckJson, params.accountId);
        await checkDoubaoEntry(entry.id);
      }
      return { success: true, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '豆包 CK 导入失败' };
    }
  });

  ipcMain.handle('localManager:dola:importEmail', async (_event, params: DolaEmailImportItem) => {
    try {
      importDolaEmail(params);
      return { success: true, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '邮箱导入失败' };
    }
  });

  ipcMain.handle('localManager:dola:loadToAccount', async (_event, params: { entryId: string; accountId: string }) => {
    try {
      const secret = getDolaSecret(params.entryId);
      const partition = accountPartition(params.accountId);
      if (!secret?.cookies) return { success: false, error: '该条目没有可加载的 CK JSON' };
      if (!partition) return { success: false, error: '目标账号不存在或不是 Dola 账号' };
      const sess = session.fromPartition(`persist:dola_${partition}`);
      await resetDolaSessionForCkRestore(sess);
      await applyCookies(sess, secret.cookies);
      linkDolaAccount(params.entryId, params.accountId);
      updateDolaCheck(params.entryId, { state: 'valid', lastCheckedAt: new Date().toISOString(), error: undefined });
      return { success: true, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'CK 加载失败' };
    }
  });

  ipcMain.handle('localManager:dola:relogin', async (_event, params: { entryId: string }) => {
    try {
      const entry = listLocalManager().dola.find((item) => item.id === params.entryId);
      if (!entry) return { success: false, error: 'CK 条目不存在' };
      if (entry.source === 'email') return { success: false, error: '只有 CK 条目支持重登' };
      if (!entry.accountId) return { success: false, error: '该 CK 尚未关联 Dola 账号，请先加载' };

      const secret = getDolaSecret(entry.id);
      const partition = accountPartition(entry.accountId);
      if (!secret?.cookies) return { success: false, error: '该条目没有可用的 CK JSON' };
      if (!partition) return { success: false, error: '关联的 Dola 账号不存在' };

      const sess = session.fromPartition(`persist:dola_${partition}`);
      await resetDolaSessionForCkRestore(sess);
      await applyCookies(sess, secret.cookies);
      await refreshAccountSessionProxy(entry.accountId);
      updateDolaCheck(entry.id, { state: 'valid', lastCheckedAt: new Date().toISOString(), error: undefined });
      return { success: true, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'CK 重登失败' };
    }
  });

  ipcMain.handle('localManager:dola:delete', async (_event, params: { id: string }) => {
    try {
      return { success: deleteDolaEntry(params.id), data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '删除失败' };
    }
  });

  ipcMain.handle('localManager:dola:clear', async () => {
    try {
      clearDolaEntries();
      return { success: true, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '清空失败' };
    }
  });

  ipcMain.handle('localManager:dola:retest', async () => {
    await checkAllDola();
    return { success: true, data: listLocalManager() };
  });

  ipcMain.handle('localManager:doubao:loadToAccount', async (_event, params: { entryId: string; accountId: string }) => {
    try {
      const secret = getDoubaoSecret(params.entryId);
      const partition = accountPartition(params.accountId, 'doubao');
      if (!secret?.cookies) return { success: false, error: '该条目没有可加载的豆包 CK JSON' };
      if (!partition) return { success: false, error: '目标账号不存在或不是豆包账号' };
      const sess = session.fromPartition(`persist:doubao_${partition}`);
      await resetDolaSessionForCkRestore(sess);
      await applyCookies(sess, secret.cookies);
      linkDoubaoAccount(params.entryId, params.accountId);
      updateDoubaoCheck(params.entryId, { state: 'valid', lastCheckedAt: new Date().toISOString(), error: undefined });
      return { success: true, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '豆包 CK 加载失败' };
    }
  });

  ipcMain.handle('localManager:doubao:relogin', async (_event, params: { entryId: string }) => {
    try {
      const entry = listLocalManager().doubao.find((item) => item.id === params.entryId);
      if (!entry) return { success: false, error: '豆包 CK 条目不存在' };
      if (!entry.accountId) return { success: false, error: '该豆包 CK 尚未关联账号，请先加载' };
      const secret = getDoubaoSecret(entry.id);
      const partition = accountPartition(entry.accountId, 'doubao');
      if (!secret?.cookies) return { success: false, error: '该条目没有可用的豆包 CK JSON' };
      if (!partition) return { success: false, error: '关联的豆包账号不存在' };
      const sess = session.fromPartition(`persist:doubao_${partition}`);
      await resetDolaSessionForCkRestore(sess);
      await applyCookies(sess, secret.cookies);
      updateDoubaoCheck(entry.id, { state: 'valid', lastCheckedAt: new Date().toISOString(), error: undefined });
      return { success: true, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '豆包 CK 重登失败' };
    }
  });

  ipcMain.handle('localManager:doubao:delete', async (_event, params: { id: string }) => {
    try {
      return { success: deleteDoubaoEntry(params.id), data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '豆包 CK 删除失败' };
    }
  });

  ipcMain.handle('localManager:doubao:clear', async () => {
    try {
      clearDoubaoEntries();
      return { success: true, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '豆包 CK 清空失败' };
    }
  });

  ipcMain.handle('localManager:doubao:retest', async () => {
    await checkAllDoubao();
    return { success: true, data: listLocalManager() };
  });

  ipcMain.handle('localManager:dola:setConcurrency', async (_event, params: { value: number }) => {
    try {
      return { success: true, data: { concurrency: setConcurrency(params.value) } };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '并发数设置失败' };
    }
  });

  ipcMain.handle('localManager:proxy:add', async (_event, params: ProxyPoolInput) => {
    try {
      const entry = addProxy(params);
      await checkProxyEntry(entry.id);
      const snapshot = listLocalManager();
      const updated = snapshot.proxies.find((item) => item.id === entry.id);
      return updated?.state === 'valid'
        ? { success: true, data: snapshot }
        : { success: false, data: snapshot, error: updated?.error || '代理检测未通过' };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '代理保存失败' };
    }
  });

  ipcMain.handle('localManager:proxy:setEnabled', async (_event, params: { id: string; enabled: boolean }) => {
    try {
      if (typeof params.enabled !== 'boolean') throw new Error('代理启停参数无效');
      const before = listLocalManager();
      const target = before.proxies.find((proxy) => proxy.id === params.id);
      if (!target) throw new Error('代理不存在');
      const affectedAccounts = before.bindings
        .filter((binding) => binding.proxyId === params.id)
        .map((binding) => binding.accountId);
      setProxyEnabled(params.id, params.enabled);
      if (!params.enabled) await stopAirportProxyCore(params.id);
      await runWithConcurrency(affectedAccounts, 2, async (accountId) => {
        await refreshAccountSessionProxy(accountId);
      });
      return { success: true, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, data: listLocalManager(), error: error instanceof Error ? error.message : '代理启停设置失败' };
    }
  });

  ipcMain.handle('localManager:proxy:delete', async (_event, params: { id: string }) => {
    try {
      const affectedAccounts = listLocalManager().bindings
        .filter((binding) => binding.proxyId === params.id)
        .map((binding) => binding.accountId);
      await stopAirportProxyCore(params.id);
      const success = deleteProxy(params.id);
      await runWithConcurrency(affectedAccounts, 2, async (accountId) => refreshAccountSessionProxy(accountId));
      return { success, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '代理删除失败' };
    }
  });

  ipcMain.handle('localManager:proxy:retest', async () => {
    await checkAllProxies();
    return { success: true, data: listLocalManager() };
  });

  ipcMain.handle('localManager:subscription:add', async (_event, params: ProxySubscriptionInput) => {
    try {
      const entry = addSubscription(params);
      try {
        const snapshot = await refreshProxySubscription(entry.id);
        return { success: true, data: snapshot };
      } catch (error: unknown) {
        // 新增订阅必须以首次刷新成功为提交条件；失败时清掉刚写入的
        // 条目和节点，避免用户重复点击后留下多个不可用订阅。
        const failedProxyIds = listLocalManager().proxies
          .filter((proxy) => proxy.subscriptionId === entry.id)
          .map((proxy) => proxy.id);
        await Promise.all(failedProxyIds.map((proxyId) => stopAirportProxyCore(proxyId)));
        deleteSubscription(entry.id);
        return { success: false, data: listLocalManager(), error: error instanceof Error ? error.message : '订阅刷新失败' };
      }
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '订阅添加失败' };
    }
  });

  ipcMain.handle('localManager:subscription:refresh', async (_event, params: { id: string }) => {
    try {
      return { success: true, data: await refreshProxySubscription(params.id) };
    } catch (error: unknown) {
      return { success: false, data: listLocalManager(), error: error instanceof Error ? error.message : '订阅刷新失败' };
    }
  });

  ipcMain.handle('localManager:subscription:delete', async (_event, params: { id: string }) => {
    try {
      const before = listLocalManager();
      const affectedAccounts = before.bindings
        .filter((binding) => before.proxies.some((proxy) => proxy.id === binding.proxyId && proxy.subscriptionId === params.id))
        .map((binding) => binding.accountId);
      const proxyIds = before.proxies.filter((proxy) => proxy.subscriptionId === params.id).map((proxy) => proxy.id);
      await Promise.all(proxyIds.map((proxyId) => stopAirportProxyCore(proxyId)));
      const success = deleteSubscription(params.id);
      await runWithConcurrency(affectedAccounts, 2, async (accountId) => refreshAccountSessionProxy(accountId));
      return { success, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, data: listLocalManager(), error: error instanceof Error ? error.message : '订阅删除失败' };
    }
  });

  ipcMain.handle('localManager:binding:bind', async (_event, params: { accountId: string; proxyId: string | null }) => {
    try {
      const platform = accountPlatformMap()[params.accountId];
      if (!platform) throw new Error('窗口账号不存在');
      const binding = bindSession(params.accountId, platform, params.proxyId);
      await refreshAccountSessionProxy(params.accountId);
      return { success: true, data: binding };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '绑定失败' };
    }
  });

  ipcMain.handle('localManager:binding:unbind', async (_event, params: { accountId: string }) => {
    try {
      if (!accountPlatformMap()[params.accountId]) throw new Error('窗口账号不存在');
      unbindSession(params.accountId);
      await refreshAccountSessionProxy(params.accountId);
      return { success: true, data: listLocalManager() };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '解绑失败' };
    }
  });

  ipcMain.handle('localManager:binding:randomAssign', async (_event, params: { accountIds: string[]; perProxyLimit: number }) => {
    try {
      const bindings = randomAssign(params.accountIds, accountPlatformMap(), params.perProxyLimit);
      await runWithConcurrency(bindings, 2, async (binding) => {
        await refreshAccountSessionProxy(binding.accountId);
      });
      return { success: true, data: bindings };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '随机分配失败' };
    }
  });

  ipcMain.handle('localManager:routing:setMode', async (_event, params: { mode: LocalRoutingMode }) => {
    try {
      return { success: true, data: setRoutingMode(params.mode) };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : '路由模式设置失败' };
    }
  });

  ipcMain.handle('localManager:assets:list', async () => ({ success: true, data: listLocalAssets() }));

  return dispose;
}
