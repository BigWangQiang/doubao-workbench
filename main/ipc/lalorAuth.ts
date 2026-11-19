import { app, BrowserWindow, dialog } from 'electron';
import { ipcMain } from '../security/trustedIpc';
import { resolveDesktopApiBase, secureDesktopFetch, verifyDesktopGrant, type SignedDesktopGrant } from '../security/desktopSecurity';
import { clearPlatformNetworkConfig } from '../utils/platformNetworkConfig';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  LalorAuthResult,
  LalorAuthSnapshot,
  LalorCashPurchaseInput,
  LalorCatalog,
  LalorDeliveryMetadata,
  LalorImportDeliveryResult,
  LalorOrderHistoryClearResult,
  LalorOrderPage,
  LalorPairingCode,
  LalorPaymentOrder,
  LalorProfile,
  LalorPurchasePointsInput,
  LalorPurchaseResult,
  LalorSaveDeliveryResult,
  ProxyPoolInput,
} from '@doubao-studio/contracts';
import { replaceIpcHandlers } from './lifecycle';
import { importAndCheckDolaCkText, importAndCheckDoubaoCkText, importAndCheckProxyInput } from './localManager';
import { listLocalManager } from '../utils/localManagerStore';
import {
  clearLalorSession,
  loadLalorSession,
  saveLalorSession,
  type LalorStoredSession,
} from '../utils/lalorAuthStore';
import {
  hasActiveLalorMembership,
  LALOR_MEMBERSHIP_EXPIRED_MESSAGE,
  lalorMembershipExpiresAtMs,
} from '../utils/lalorMembership';
import { readJSON, writeJSON } from '../utils/store';

export const LALOR_API_BASE_URL = resolveDesktopApiBase(app.isPackaged, process.env.LALOR_API_BASE_URL);
const REQUEST_TIMEOUT_MS = 20_000;
const DELIVERY_TTL_MS = 15 * 60 * 1000;
const MAX_MEMBERSHIP_EXPIRY_TIMER_MS = 24 * 60 * 60 * 1000;
const LALOR_PUBLIC_ORIGIN = LALOR_API_BASE_URL.replace(/\/api(?:\/.*)?$/i, '');

/**
 * 桌面渲染层从 file:// 页面加载，服务端返回的相对头像地址不能直接解析。
 * 在主进程统一补全为可信 Lalor 来源，避免把令牌拼进头像 URL。
 */
function normalizeAvatarUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('resource:') || /^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('/')) return `${LALOR_PUBLIC_ORIGIN}${raw}`;
  return raw;
}

function normalizeProfile(profile: LalorProfile): LalorProfile {
  return { ...profile, avatarUrl: normalizeAvatarUrl(profile.avatarUrl) };
}

const LALOR_AUTH_CHANNELS = [
  'lalorAuth:status',
  'lalorAuth:pair',
  'lalorAuth:logout',
  'lalorAuth:catalog',
  'lalorAuth:orders',
  'lalorAuth:clearOrders',
  'lalorAuth:redownloadOrder',
  'lalorAuth:purchaseByPoints',
  'lalorAuth:createCashPurchase',
  'lalorAuth:getCashOrder',
  'lalorAuth:saveDelivery',
  'lalorAuth:importDelivery',
] as const;

interface RemoteEnvelope<T> {
  code?: number;
  data?: T | null;
  msg?: string;
}

interface RemoteSession {
  entitlement: SignedDesktopGrant;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  profile: LalorProfile;
}

interface RemoteDelivery {
  id: string;
  productId: string;
  productName: string;
  productType: string;
  purchaseMethod: string;
  contentType: string;
  content: string;
  fileName?: string;
  mimeType?: string;
  deliveredAt: string;
}

interface RemotePurchase {
  order?: LalorPaymentOrder;
  delivery?: RemoteDelivery;
  profile: LalorProfile;
}

interface CachedDelivery {
  delivery: RemoteDelivery;
  createdAt: number;
}

export class LalorRemoteError extends Error {
  readonly status: number;
  readonly code?: number;

  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = 'LalorRemoteError';
    this.status = status;
    this.code = code;
  }
}

const deliveryCache = new Map<string, CachedDelivery>();
let membershipExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let sessionInvalidationError: string | undefined;
let sessionRefreshInFlight: Promise<LalorStoredSession> | null = null;

function clearMembershipExpiryTimer(): void {
  if (!membershipExpiryTimer) return;
  clearTimeout(membershipExpiryTimer);
  membershipExpiryTimer = null;
}

function invalidateLalorSession(error?: string): void {
  clearMembershipExpiryTimer();
  clearLalorSession();
  clearPlatformNetworkConfig();
  sessionInvalidationError = error;
}

function assertActiveMembership(profile: LalorProfile): void {
  if (hasActiveLalorMembership(profile)) return;
  invalidateLalorSession(LALOR_MEMBERSHIP_EXPIRED_MESSAGE);
  throw new LalorRemoteError(LALOR_MEMBERSHIP_EXPIRED_MESSAGE, 403);
}

function scheduleMembershipExpiry(session: LalorStoredSession | null): void {
  clearMembershipExpiryTimer();
  if (!session) return;
  if (!hasActiveLalorMembership(session.profile)) {
    invalidateLalorSession(LALOR_MEMBERSHIP_EXPIRED_MESSAGE);
    return;
  }
  sessionInvalidationError = undefined;

  const expiresAtMs = lalorMembershipExpiresAtMs(session.profile);
  if (expiresAtMs === null) {
    invalidateLalorSession(LALOR_MEMBERSHIP_EXPIRED_MESSAGE);
    return;
  }
  const remainingMs = expiresAtMs - Date.now();
  const delayMs = Math.min(remainingMs + 25, MAX_MEMBERSHIP_EXPIRY_TIMER_MS);
  membershipExpiryTimer = setTimeout(() => {
    membershipExpiryTimer = null;
    const current = loadLalorSession();
    if (!current) return;
    if (!hasActiveLalorMembership(current.profile)) {
      invalidateLalorSession(LALOR_MEMBERSHIP_EXPIRED_MESSAGE);
      return;
    }
    scheduleMembershipExpiry(current);
  }, delayMs);
  membershipExpiryTimer.unref?.();
}

function saveActiveLalorSession(session: LalorStoredSession): void {
  assertActiveMembership(session.profile);
  saveLalorSession(session);
  sessionInvalidationError = undefined;
  scheduleMembershipExpiry(session);
}

function isAuthoritativeAuthFailure(error: unknown): boolean {
  return error instanceof LalorRemoteError && (error.status === 401 || error.status === 403);
}

function invalidateLalorSessionIfCurrent(refreshToken: string, error?: string): boolean {
  const current = loadLalorSession();
  if (!current || current.refreshToken !== refreshToken) return false;
  invalidateLalorSession(error);
  return true;
}

export interface LalorDeviceMetadata {
  deviceId: string;
  deviceName: string;
  appVersion: string;
  platform: string;
  currentTaskId: string;
}

interface StoredLalorDeviceIdentity {
  deviceId: string;
  deviceName: string;
}

const LALOR_DEVICE_FILE = 'lalor-device.json';

/** 配对与心跳复用同一稳定设备标识，避免每次启动被后台识别为新设备。 */
export function getLalorDeviceMetadata(currentTaskId = ''): LalorDeviceMetadata {
  const stored = readJSON<Partial<StoredLalorDeviceIdentity>>(LALOR_DEVICE_FILE, {});
  const existingId = typeof stored.deviceId === 'string' ? stored.deviceId.trim() : '';
  const existingName = typeof stored.deviceName === 'string' ? stored.deviceName.trim() : '';
  const identity: StoredLalorDeviceIdentity = {
    deviceId: existingId || `desktop-${randomUUID()}`,
    deviceName: existingName || os.hostname().trim() || 'Lalor 工作台',
  };
  if (identity.deviceId !== existingId || identity.deviceName !== existingName) {
    if (!writeJSON(LALOR_DEVICE_FILE, identity)) throw new Error('无法保存 Lalor 设备标识');
  }
  return {
    ...identity,
    appVersion: app.getVersion(),
    platform: process.platform,
    currentTaskId,
  };
}

function publicError(error: unknown): string {
  if (error instanceof LalorRemoteError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Lalor 服务暂时不可用，请稍后重试';
}

function success<T>(data: T): LalorAuthResult<T> {
  return { success: true, data };
}

function failure(error: unknown): LalorAuthResult<never> {
  return { success: false, error: publicError(error) };
}

function sessionSnapshot(session: LalorStoredSession | null, error?: string): LalorAuthSnapshot {
  if (!session) return { authenticated: false, ...(error ? { error } : {}) };
  return {
    authenticated: true,
    profile: normalizeProfile(session.profile),
    accessExpiresAt: session.accessExpiresAt,
    refreshExpiresAt: session.refreshExpiresAt,
    ...(error ? { error } : {}),
  };
}

function sessionFromRemote(value: RemoteSession): LalorStoredSession {
  if (!value.accessToken || !value.refreshToken || !value.profile) throw new Error('Lalor 登录响应不完整');
  verifyDesktopGrant(value.entitlement, value.profile.userId);
  return {
    entitlement: value.entitlement,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    accessExpiresAt: value.accessExpiresAt,
    refreshExpiresAt: value.refreshExpiresAt,
    profile: normalizeProfile(value.profile),
  };
}

function validExpiry(value: string, minimumMs = 0): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now() + minimumMs;
}

async function requestRemote<T>(
  endpoint: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; accessToken?: string } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
    const response = await secureDesktopFetch(`${LALOR_API_BASE_URL}${endpoint}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    let envelope: RemoteEnvelope<T>;
    try {
      envelope = await response.json() as RemoteEnvelope<T>;
    } catch {
      throw new LalorRemoteError(`Lalor 服务返回了无效响应（HTTP ${response.status}）`, response.status);
    }
    if (!response.ok || envelope.code !== 0 || envelope.data === null || envelope.data === undefined) {
      throw new LalorRemoteError(envelope.msg || `Lalor 请求失败（HTTP ${response.status}）`, response.status, envelope.code);
    }
    return envelope.data;
  } catch (error: unknown) {
    if (error instanceof LalorRemoteError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Lalor 请求超时，请检查网络后重试');
    throw new Error('无法连接 Lalor 服务，请检查网络后重试');
  } finally {
    clearTimeout(timeout);
  }
}

async function performSessionRefresh(requestedSession: LalorStoredSession): Promise<LalorStoredSession> {
  const latestSession = loadLalorSession();
  if (!latestSession) throw new LalorRemoteError('尚未连接 Lalor，请先完成会员配对', 401);
  assertActiveMembership(latestSession.profile);

  // 等待期间其他调用方或进程可能已经完成令牌轮换，直接复用最新会话。
  if (
    latestSession.refreshToken !== requestedSession.refreshToken
    && validExpiry(latestSession.accessExpiresAt, 60_000)
  ) {
    return latestSession;
  }

  const session = latestSession;
  const attemptedRefreshToken = session.refreshToken;
  if (!validExpiry(session.refreshExpiresAt)) {
    invalidateLalorSessionIfCurrent(attemptedRefreshToken, 'Lalor 登录已过期，请重新生成配对码');
    throw new LalorRemoteError('Lalor 登录已过期，请重新生成配对码', 401);
  }
  let remote: RemoteSession;
  try {
    remote = await requestRemote<RemoteSession>('/desktop/token/refresh', {
      method: 'POST',
      body: { refreshToken: session.refreshToken },
    });
  } catch (error: unknown) {
    const current = loadLalorSession();
    if (current && current.refreshToken !== attemptedRefreshToken) {
      assertActiveMembership(current.profile);
      return current;
    }
    if (isAuthoritativeAuthFailure(error)) {
      invalidateLalorSessionIfCurrent(attemptedRefreshToken, publicError(error));
    }
    throw error;
  }
  const refreshed = sessionFromRemote(remote);
  const current = loadLalorSession();
  if (!current) throw new LalorRemoteError('尚未连接 Lalor，请先完成会员配对', 401);
  if (current.refreshToken !== attemptedRefreshToken) {
    assertActiveMembership(current.profile);
    return current;
  }
  saveActiveLalorSession(refreshed);
  return refreshed;
}

async function refreshSession(session: LalorStoredSession): Promise<LalorStoredSession> {
  if (sessionRefreshInFlight) return sessionRefreshInFlight;
  const refresh = performSessionRefresh(session);
  sessionRefreshInFlight = refresh;
  try {
    return await refresh;
  } finally {
    if (sessionRefreshInFlight === refresh) sessionRefreshInFlight = null;
  }
}

async function validSession(): Promise<LalorStoredSession> {
  const session = loadLalorSession();
  if (!session) throw new LalorRemoteError('尚未连接 Lalor，请先完成会员配对', 401);
  assertActiveMembership(session.profile);
  if (validExpiry(session.accessExpiresAt, 60_000)) return session;
  return refreshSession(session);
}

async function withSession<T>(callback: (session: LalorStoredSession) => Promise<T>): Promise<T> {
  let session = await validSession();
  try {
    return await callback(session);
  } catch (error: unknown) {
    if (!(error instanceof LalorRemoteError) || (error.status !== 401 && error.status !== 403)) throw error;
    // Access tokens can expire between the local clock check and the request.
    // Retry once with a rotated refresh token; never retry a business write.
    if (error.status === 403) throw error;
    session = await refreshSession(session);
    return callback(session);
  }
}

/**
 * 主进程内部复用的授权边界。令牌只作为回调参数存在，不通过 IPC 暴露给
 * 渲染进程；远程任务桥借此复用现有的到期刷新和撤销处理。
 */
export async function withLalorSession<T>(callback: (session: LalorStoredSession) => Promise<T>): Promise<T> {
  return withSession(async (session): Promise<T> => {
    let needsLicense = false;
    try { needsLicense = verifyDesktopGrant(session.entitlement, session.profile.userId).expiresAt < Date.now() / 1000 + 30; }
    catch { needsLicense = true; }
    if (needsLicense) {
      const result = await requestRemote<{ profile: LalorProfile; entitlement: SignedDesktopGrant }>('/desktop/license', { accessToken: session.accessToken });
      verifyDesktopGrant(result.entitlement, session.profile.userId);
      const current = loadLalorSession();
      if (!current || current.refreshToken !== session.refreshToken) throw new LalorRemoteError('登录状态已变化', 401);
      session = updateProfile({ ...current, entitlement: result.entitlement }, result.profile);
    }
    return callback(session);
  });
}

/** 新生成必须在线确认会员；只重试读取资料，不能把生成调用放进令牌重试回调。 */
export async function requireLalorGenerationAccess(): Promise<void> {
  await withSession(async (session): Promise<void> => {
    const result = await requestRemote<{ profile: LalorProfile; entitlement: SignedDesktopGrant }>('/desktop/license', { accessToken: session.accessToken });
    verifyDesktopGrant(result.entitlement, session.profile.userId);
    const current = loadLalorSession();
    if (!current || current.refreshToken !== session.refreshToken) throw new LalorRemoteError('登录状态已变化，请重新确认会员身份', 401);
    updateProfile({ ...current, entitlement: result.entitlement }, result.profile);
  });
}

function updateProfile(session: LalorStoredSession, profile: LalorProfile): LalorStoredSession {
  const updated = { ...session, profile: normalizeProfile(profile) };
  saveActiveLalorSession(updated);
  return updated;
}

function cleanupDeliveryCache(): void {
  const cutoff = Date.now() - DELIVERY_TTL_MS;
  for (const [key, value] of deliveryCache) {
    if (value.createdAt < cutoff) deliveryCache.delete(key);
  }
}

function mapDelivery(delivery: RemoteDelivery): LalorDeliveryMetadata {
  cleanupDeliveryCache();
  const deliveryRef = randomUUID();
  deliveryCache.set(deliveryRef, { delivery, createdAt: Date.now() });
  return {
    deliveryRef,
    id: delivery.id,
    productId: delivery.productId,
    productName: delivery.productName,
    productType: delivery.productType || 'dola_account',
    purchaseMethod: delivery.purchaseMethod,
    contentType: delivery.contentType,
    ...(delivery.fileName ? { fileName: delivery.fileName } : {}),
    ...(delivery.mimeType ? { mimeType: delivery.mimeType } : {}),
    deliveredAt: delivery.deliveredAt,
  };
}

function mapPurchase(value: RemotePurchase): LalorPurchaseResult {
  return {
    order: value.order,
    ...(value.delivery ? { delivery: mapDelivery(value.delivery) } : {}),
    profile: normalizeProfile(value.profile),
  };
}

function deliveryFormat(value: string | undefined): 'json' | 'txt' | null {
  const normalized = String(value || '').toLowerCase().trim().split(';', 1)[0];
  if (normalized === 'json' || normalized === 'application/json' || normalized.endsWith('+json')) return 'json';
  if (normalized === 'txt' || normalized === 'text' || normalized === 'text/plain') return 'txt';
  return null;
}

function deliveryExtension(delivery: Pick<RemoteDelivery, 'contentType'>): 'json' | 'txt' {
  return deliveryFormat(delivery.contentType) || 'json';
}

function safeFileName(name: string | undefined, extension: 'json' | 'txt', fallbackBase: string): string {
  const normalized = (name || fallbackBase).trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  const withoutKnownExtension = normalized.replace(/\.(json|txt)$/i, '');
  return `${withoutKnownExtension || fallbackBase}.${extension}`;
}

function boundedPage(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(10000, parsed)) : fallback;
}

function boundedLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(100, parsed)) : fallback;
}

async function saveDelivery(deliveryRef: string): Promise<LalorSaveDeliveryResult> {
  cleanupDeliveryCache();
  const cached = deliveryCache.get(deliveryRef);
  if (!cached) throw new Error('交付内容已过期，请重新查询订单');
  const productType = cached.delivery.productType || 'dola_account';
  const isResidentialProxy = productType === 'residential_proxy';
  const isDoubao = productType === 'doubao_account';
  const extension = deliveryExtension(cached.delivery);
  const fallbackBase = isResidentialProxy ? 'residential-proxy' : isDoubao ? 'doubao-account' : 'dola-account';
  const options = {
    title: isResidentialProxy ? '保存静态住宅 IP JSON' : isDoubao ? `保存豆包 CK ${extension.toUpperCase()}` : '保存 Dola CK JSON',
    defaultPath: path.join(app.getPath('downloads'), safeFileName(cached.delivery.fileName, extension, fallbackBase)),
    filters: [{ name: extension === 'txt' ? 'TXT 文件' : 'JSON 文件', extensions: [extension] }],
  };
  const owner = BrowserWindow.getFocusedWindow();
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false, canceled: true };
  fs.writeFileSync(result.filePath, cached.delivery.content, { encoding: 'utf8', flag: 'w' });
  return { saved: true, filePath: result.filePath };
}

async function importDelivery(deliveryRef: string): Promise<LalorImportDeliveryResult> {
  cleanupDeliveryCache();
  const cached = deliveryCache.get(deliveryRef);
  if (!cached) throw new Error('交付内容已过期，请重新查询订单');
  if (typeof cached.delivery.content !== 'string') {
    throw new Error('交付内容为空，已阻止导入');
  }
  const productType = cached.delivery.productType || 'dola_account';
  if (productType === 'residential_proxy') {
    const proxy = parseResidentialProxyDelivery(cached.delivery);
    const checked = await importAndCheckProxyInput(proxy);
    return {
      imported: true,
      deliveryKind: 'residential_proxy',
      importedCount: 1,
      proxyId: checked.entry.id,
      proxyState: checked.entry.state,
      ...(checked.entry.error ? { proxyError: checked.entry.error } : {}),
      localManager: { success: checked.entry.state === 'valid', data: checked.snapshot, ...(checked.entry.error ? { error: checked.entry.error } : {}) },
    };
  }
  const contentType = deliveryFormat(cached.delivery.contentType);
  if (productType === 'doubao_account') {
    if (!contentType) {
      throw new Error('豆包交付内容不是 JSON 或 TXT 文本，已阻止导入');
    }
    const imported = await importAndCheckDoubaoCkText(
      `豆包 · ${cached.delivery.productName}`,
      undefined,
      cached.delivery.content,
      undefined,
      contentType === 'txt' ? 'ck_txt' : 'ck_json',
    );
    return {
      imported: imported.length > 0,
      deliveryKind: 'doubao_ck',
      importedCount: imported.length,
      importedEntryIds: imported.map((entry) => entry.id),
      localManager: { success: true, data: listLocalManager() },
    };
  }
  if (contentType !== 'json') {
    throw new Error('Dola 交付内容不是 JSON 文本，已阻止导入');
  }
  const imported = await importAndCheckDolaCkText(
    `Dola · ${cached.delivery.productName}`,
    undefined,
    cached.delivery.content,
  );
  return {
    imported: imported.length > 0,
    deliveryKind: 'dola_ck',
    importedCount: imported.length,
    importedEntryIds: imported.map((entry) => entry.id),
    localManager: { success: true, data: listLocalManager() },
  };
}

function parseResidentialProxyDelivery(delivery: RemoteDelivery): ProxyPoolInput {
  let value: unknown;
  try {
    value = JSON.parse(delivery.content);
  } catch {
    throw new Error('静态住宅 IP 交付 JSON 无效，请联系管理员');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('静态住宅 IP 交付结构无效，请联系管理员');
  }
  const record = value as Record<string, unknown>;
  const type = String(record.type || '').trim().toLowerCase();
  const protocol = String(record.protocol || '').trim().toLowerCase();
  const host = String(record.host || '').trim();
  const port = Number(record.port);
  const username = String(record.username || '').trim();
  const password = typeof record.password === 'string' ? record.password : '';
  if (type !== 'residential_proxy' || !['http', 'https', 'socks5'].includes(protocol) || !host || !Number.isInteger(port)) {
    throw new Error('静态住宅 IP 交付字段无效，请联系管理员');
  }
  if ((username && !password) || (!username && password)) {
    throw new Error('静态住宅 IP 账号和密码不完整，请联系管理员');
  }
  return {
    label: String(record.label || delivery.productName || `${host}:${port}`).trim(),
    protocol: protocol as ProxyPoolInput['protocol'],
    host,
    port,
    ...(username ? { username, password } : {}),
  };
}

export function registerLalorAuthIPC(handlers?: typeof import('./yuyanAuth').yuyanAuthHandlers): () => void {
  const dispose = replaceIpcHandlers(ipcMain, LALOR_AUTH_CHANNELS);
  if (!handlers) scheduleMembershipExpiry(loadLalorSession());

  ipcMain.handle('lalorAuth:status', async (): Promise<LalorAuthResult<LalorAuthSnapshot>> => {
    if (handlers) return handlers.status();
    const cached = loadLalorSession();
    if (!cached) return success(sessionSnapshot(null, sessionInvalidationError));
    if (!hasActiveLalorMembership(cached.profile)) {
      invalidateLalorSession(LALOR_MEMBERSHIP_EXPIRED_MESSAGE);
      return success(sessionSnapshot(null, LALOR_MEMBERSHIP_EXPIRED_MESSAGE));
    }
    try {
      const session = await withSession(async (current) => {
        const profile = await requestRemote<LalorProfile>('/desktop/profile', { accessToken: current.accessToken });
        return updateProfile(current, profile);
      });
      return success(sessionSnapshot(session));
    } catch (error: unknown) {
      const fallback = loadLalorSession();
      if (isAuthoritativeAuthFailure(error) || !fallback || !hasActiveLalorMembership(fallback.profile)) {
        invalidateLalorSession(publicError(error));
        return success(sessionSnapshot(null, publicError(error)));
      }
      // 网络波动不能把仍在有效期内的本地会员误踢下线；下次轮询或窗口恢复时继续复检。
      scheduleMembershipExpiry(fallback);
      return success(sessionSnapshot(fallback, publicError(error)));
    }
  });

  ipcMain.handle('lalorAuth:pair', async (_event, code: string): Promise<LalorAuthResult<LalorAuthSnapshot>> => {
    if (handlers) return handlers.connect(code);
    try {
      const normalized = String(code || '').trim();
      if (!normalized) throw new Error('请输入 Lalor 配对码');
      const remote = await requestRemote<RemoteSession>('/desktop/pair', {
        method: 'POST',
        body: { code: normalized, ...getLalorDeviceMetadata() },
      });
      const session = sessionFromRemote(remote);
      saveActiveLalorSession(session);
      return success(sessionSnapshot(session));
    } catch (error: unknown) {
      return failure(error);
    }
  });

  ipcMain.handle('lalorAuth:logout', async (): Promise<LalorAuthResult<{ ok: boolean }>> => {
    if (handlers) return handlers.logout();
    const session = loadLalorSession();
    let revocationError: unknown;
    if (session) {
      try { await requestRemote('/desktop/logout', { method: 'POST', accessToken: session.accessToken, body: { refreshToken: session.refreshToken } }); }
      catch (error: unknown) { revocationError = error; }
    }
    invalidateLalorSession();
    deliveryCache.clear();
    if (revocationError) return failure(new Error('已退出本机，但服务端撤销未确认；请到网站解绑设备后再登录。'));
    return success({ ok: true });
  });

  // 屿砚只注册账号连接所需的入口，不从客户端访问原平台商城。
  if (handlers) return dispose;
  ipcMain.handle('lalorAuth:catalog', async (): Promise<LalorAuthResult<LalorCatalog>> => {
    try {
      return success(await withSession((session) => requestRemote<LalorCatalog>('/desktop/catalog', { accessToken: session.accessToken })));
    } catch (error: unknown) {
      return failure(error);
    }
  });

  ipcMain.handle('lalorAuth:orders', async (_event, input: { page?: number; limit?: number }): Promise<LalorAuthResult<LalorOrderPage>> => {
    try {
      const page = boundedPage(input?.page, 1);
      const limit = boundedLimit(input?.limit, 20);
      const endpoint = `/desktop/orders?page=${page}&limit=${limit}`;
      return success(await withSession((session) => requestRemote<LalorOrderPage>(endpoint, { accessToken: session.accessToken })));
    } catch (error: unknown) {
      return failure(error);
    }
  });

  ipcMain.handle('lalorAuth:clearOrders', async (): Promise<LalorAuthResult<LalorOrderHistoryClearResult>> => {
    try {
      return success(await withSession((session) => requestRemote<LalorOrderHistoryClearResult>('/desktop/orders', { method: 'DELETE', accessToken: session.accessToken })));
    } catch (error: unknown) {
      return failure(error);
    }
  });

  ipcMain.handle('lalorAuth:redownloadOrder', async (_event, orderId: string): Promise<LalorAuthResult<LalorSaveDeliveryResult>> => {
    try {
      const id = String(orderId || '').trim();
      if (!id) throw new Error('订单号为空');
      const result = await withSession((session) => requestRemote<RemotePurchase>(`/desktop/orders/${encodeURIComponent(id)}/delivery`, { accessToken: session.accessToken }));
      if (!result.delivery) throw new Error('该订单没有可下载的交付文件');
      const session = loadLalorSession();
      if (session && result.profile) updateProfile(session, result.profile);
      const delivery = mapDelivery(result.delivery);
      return success(await saveDelivery(delivery.deliveryRef));
    } catch (error: unknown) {
      return failure(error);
    }
  });

  ipcMain.handle('lalorAuth:purchaseByPoints', async (_event, input: LalorPurchasePointsInput): Promise<LalorAuthResult<LalorPurchaseResult>> => {
    try {
      const result = await withSession((session) => requestRemote<RemotePurchase>('/desktop/purchases/points', { method: 'POST', accessToken: session.accessToken, body: input }));
      const session = loadLalorSession();
      if (session && result.profile) updateProfile(session, result.profile);
      return success(mapPurchase(result));
    } catch (error: unknown) {
      return failure(error);
    }
  });

  ipcMain.handle('lalorAuth:createCashPurchase', async (_event, input: LalorCashPurchaseInput): Promise<LalorAuthResult<LalorPurchaseResult>> => {
    try {
      const result = await withSession((session) => requestRemote<RemotePurchase>('/desktop/purchases/cash', { method: 'POST', accessToken: session.accessToken, body: input }));
      const session = loadLalorSession();
      if (session && result.profile) updateProfile(session, result.profile);
      return success(mapPurchase(result));
    } catch (error: unknown) {
      return failure(error);
    }
  });

  ipcMain.handle('lalorAuth:getCashOrder', async (_event, paymentOrderId: string): Promise<LalorAuthResult<LalorPurchaseResult>> => {
    try {
      const id = String(paymentOrderId || '').trim();
      if (!id) throw new Error('支付订单号为空');
      const result = await withSession((session) => requestRemote<RemotePurchase>(`/desktop/purchases/cash/${encodeURIComponent(id)}`, { accessToken: session.accessToken }));
      const session = loadLalorSession();
      if (session && result.profile) updateProfile(session, result.profile);
      return success(mapPurchase(result));
    } catch (error: unknown) {
      return failure(error);
    }
  });

  ipcMain.handle('lalorAuth:saveDelivery', async (_event, deliveryRef: string): Promise<LalorAuthResult<LalorSaveDeliveryResult>> => {
    try {
      return success(await saveDelivery(String(deliveryRef || '').trim()));
    } catch (error: unknown) {
      return failure(error);
    }
  });

  ipcMain.handle('lalorAuth:importDelivery', async (_event, deliveryRef: string): Promise<LalorAuthResult<LalorImportDeliveryResult>> => {
    try {
      return success(await importDelivery(String(deliveryRef || '').trim()));
    } catch (error: unknown) {
      return failure(error);
    }
  });

  return () => {
    clearMembershipExpiryTimer();
    deliveryCache.clear();
    dispose();
  };
}
