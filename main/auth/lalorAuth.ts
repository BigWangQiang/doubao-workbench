import { app, safeStorage } from 'electron';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { resolveDesktopApiBase, secureDesktopFetch, verifyDesktopGrant, type SignedDesktopGrant } from '../security/desktopSecurity';
import type {
  LalorCatalog,
  LalorConnectionStatus,
  LalorProfile,
} from '@doubao-studio/contracts';

const SESSION_FILE = 'lalor-session.json';
const PURCHASE_STATE_FILE = 'lalor-purchase-state.json';
const ACCESS_SKEW_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_AVATAR_PATH = '/avatars/lalor-default-avatar.png';
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

interface BackendEnvelope<T> {
  code?: unknown;
  data?: T;
  msg?: unknown;
}

interface BackendSession {
  entitlement: SignedDesktopGrant;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  profile: LalorProfile;
}

export interface LalorPurchasePayload {
  delivery: {
    id: string;
    productId: string;
    productName: string;
    productType?: string;
    contentType: string;
    content: string;
    fileName?: string;
    mimeType?: string;
    deliveredAt: string;
  };
  profile: LalorProfile;
}

interface PersistedSession {
  version: 1;
  refreshTokenCipher: string;
  refreshExpiresAt: string;
}

interface PersistedPurchaseState {
  version: 1;
  importedDeliveryIds: string[];
}

export class LalorAuthError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LalorAuthError';
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function avatarOrigin(): string {
  return new URL(configuredApiBase()).origin;
}

function defaultAvatarUrl(): string {
  return `${avatarOrigin()}${DEFAULT_AVATAR_PATH}`;
}

function normalizeAvatarUrl(value: unknown): string {
  const raw = nonEmptyString(value);
  if (!raw || raw.startsWith('resource:')) return defaultAvatarUrl();
  if (raw.startsWith('data:image/')) return raw;
  try {
    const parsed = new URL(raw, `${avatarOrigin()}/`);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch {
    // 非法头像地址统一回退到服务端默认头像。
  }
  return defaultAvatarUrl();
}

function normalizeProfileAvatar(profile: LalorProfile): LalorProfile {
  const raw = nonEmptyString(profile.avatarUrl);
  // 保留资源标识，供令牌就绪后 hydrateProfileAvatar 通过授权接口读取。
  if (raw?.startsWith('resource:')) return { ...profile, avatarUrl: raw };
  return { ...profile, avatarUrl: normalizeAvatarUrl(raw) };
}

function dataDirectory(): string {
  return path.join(app.getPath('userData'), 'DoubaoStudioData');
}

function sessionPath(): string {
  return path.join(dataDirectory(), SESSION_FILE);
}

function purchaseStatePath(): string {
  return path.join(dataDirectory(), PURCHASE_STATE_FILE);
}

function ensureDataDirectory(): void {
  fs.mkdirSync(dataDirectory(), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDirectory(), 0o700);
  } catch {
    // Windows may not support chmod semantics; the OS user-data ACL remains authoritative.
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  ensureDataDirectory();
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(temporaryPath, 0o600);
  } catch {
    // Best effort on platforms without POSIX mode bits.
  }
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch {
    fs.copyFileSync(temporaryPath, filePath);
    fs.unlinkSync(temporaryPath);
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms without POSIX mode bits.
  }
}

function configuredApiBase(): string {
  return resolveDesktopApiBase(app.isPackaged, process.env.LALOR_API_BASE_URL);
}

function responseMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  const message = nonEmptyString(record?.msg);
  return message ? message.slice(0, 500) : fallback;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new LalorAuthError('Lalor 返回内容过大，已拒绝处理', response.status);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LalorAuthError(`Lalor 返回数据格式无效（HTTP ${response.status}）`, response.status);
  }
}

async function fetchJson(pathname: string, init: RequestInit, token?: string): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  try {
    const response = await secureDesktopFetch(`${configuredApiBase()}${pathname}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    return { status: response.status, body: await parseResponse(response) };
  } catch (error: unknown) {
    if (error instanceof LalorAuthError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new LalorAuthError('连接 Lalor 服务超时');
    throw new LalorAuthError('无法连接 Lalor 服务，请检查网络或服务地址');
  } finally {
    clearTimeout(timeout);
  }
}

function unwrap<T>(result: { status: number; body: unknown }): T {
  const record = asRecord(result.body) as BackendEnvelope<T> | null;
  if (result.status < 200 || result.status >= 300) {
    throw new LalorAuthError(responseMessage(result.body, `Lalor 请求失败（HTTP ${result.status}）`), result.status);
  }
  if (!record || Number(record.code) !== 0) {
    throw new LalorAuthError(responseMessage(result.body, 'Lalor 请求失败'), result.status);
  }
  return record.data as T;
}

function readPersistedSession(): PersistedSession | null {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath(), 'utf8')) as unknown;
    const record = asRecord(raw);
    if (record?.version !== 1) return null;
    const cipher = nonEmptyString(record.refreshTokenCipher);
    const expires = nonEmptyString(record.refreshExpiresAt);
    if (!cipher || !expires || !safeStorage.isEncryptionAvailable()) return null;
    return { version: 1, refreshTokenCipher: cipher, refreshExpiresAt: expires };
  } catch {
    return null;
  }
}

function readPurchaseState(): PersistedPurchaseState {
  try {
    const raw = JSON.parse(fs.readFileSync(purchaseStatePath(), 'utf8')) as unknown;
    const record = asRecord(raw);
    const ids = Array.isArray(record?.importedDeliveryIds)
      ? record.importedDeliveryIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    return { version: 1, importedDeliveryIds: [...new Set(ids)].slice(-5000) };
  } catch {
    return { version: 1, importedDeliveryIds: [] };
  }
}

export class LalorAuth {
  private persistedLoaded = false;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private accessExpiresAt: string | null = null;
  private refreshExpiresAt: string | null = null;
  private profileValue: LalorProfile | null = null;
  private refreshInFlight: Promise<LalorProfile> | null = null;

  private ensurePersistedLoaded(): void {
    if (this.persistedLoaded) return;
    this.persistedLoaded = true;
    const persisted = readPersistedSession();
    if (!persisted) return;
    try {
      this.refreshToken = safeStorage.decryptString(Buffer.from(persisted.refreshTokenCipher, 'base64'));
      this.refreshExpiresAt = persisted.refreshExpiresAt;
    } catch {
      this.refreshToken = null;
      this.refreshExpiresAt = null;
    }
  }

  private persistRefreshToken(refreshToken: string, refreshExpiresAt: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new LalorAuthError('系统安全存储不可用，无法保存 Lalor 登录状态');
    const refreshTokenCipher = safeStorage.encryptString(refreshToken).toString('base64');
    writePrivateJson(sessionPath(), { version: 1, refreshTokenCipher, refreshExpiresAt });
  }

  private clearSessionState(): void {
    this.accessToken = null;
    this.refreshToken = null;
    this.accessExpiresAt = null;
    this.refreshExpiresAt = null;
    this.profileValue = null;
    this.persistedLoaded = true;
    try {
      fs.unlinkSync(sessionPath());
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') throw new LalorAuthError('清理 Lalor 登录状态失败');
    }
  }

  private setSession(session: BackendSession): void {
    verifyDesktopGrant(session.entitlement, session.profile?.userId);
    const accessToken = nonEmptyString(session.accessToken);
    const refreshToken = nonEmptyString(session.refreshToken);
    const accessExpiresAt = nonEmptyString(session.accessExpiresAt);
    const refreshExpiresAt = nonEmptyString(session.refreshExpiresAt);
    if (!accessToken || !refreshToken || !accessExpiresAt || !refreshExpiresAt || !session.profile) {
      throw new LalorAuthError('Lalor 登录响应不完整');
    }
    this.persistRefreshToken(refreshToken, refreshExpiresAt);
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.accessExpiresAt = accessExpiresAt;
    this.refreshExpiresAt = refreshExpiresAt;
    // 先把根相对地址变成可被 file:// 渲染页加载的绝对地址；resource:<id>
    // 会在令牌就绪后由 hydrateProfileAvatar 读取并转换为 data URL。
    this.profileValue = normalizeProfileAvatar(session.profile);
    this.persistedLoaded = true;
  }

  private async resolveResourceAvatar(resourceId: string): Promise<string | null> {
    const token = this.accessToken;
    if (!token || !RESOURCE_ID_PATTERN.test(resourceId)) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${configuredApiBase()}/resources/${encodeURIComponent(resourceId)}/file`, {
        redirect: 'error',
        method: 'GET',
        headers: {
          Accept: 'image/*',
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (!contentType.startsWith('image/')) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return null;
      return `data:${contentType};base64,${bytes.toString('base64')}`;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async hydrateProfileAvatar(profile: LalorProfile): Promise<LalorProfile> {
    const raw = nonEmptyString(profile.avatarUrl);
    if (!raw?.startsWith('resource:')) return normalizeProfileAvatar(profile);
    const resourceId = raw.slice('resource:'.length).trim();
    const resolved = await this.resolveResourceAvatar(resourceId);
    return {
      ...profile,
      avatarUrl: resolved || defaultAvatarUrl(),
    };
  }

  private accessIsUsable(): boolean {
    if (!this.accessToken || !this.accessExpiresAt) return false;
    const expiresAt = Date.parse(this.accessExpiresAt);
    return Number.isFinite(expiresAt) && expiresAt > Date.now() + ACCESS_SKEW_MS;
  }

  private async refreshSession(force: boolean): Promise<LalorProfile> {
    this.ensurePersistedLoaded();
    if (!force && this.accessIsUsable() && this.profileValue) return this.profileValue;
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!this.refreshToken) throw new LalorAuthError('尚未连接 Lalor，请先输入配对码');
    this.refreshInFlight = (async () => {
      const result = await fetchJson('/desktop/token/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });
      const session = unwrap<BackendSession>(result);
      this.setSession(session);
      const profile = this.profileValue;
      if (!profile) throw new LalorAuthError('Lalor 资料缺失');
      this.profileValue = await this.hydrateProfileAvatar(profile);
      return this.profileValue;
    })().catch((error: unknown) => {
      if (error instanceof LalorAuthError && (error.status === 401 || error.status === 403)) {
        this.clearSessionState();
      }
      throw error;
    }).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async ensureAccessToken(): Promise<string> {
    this.ensurePersistedLoaded();
    if (!this.accessIsUsable()) await this.refreshSession(false);
    if (!this.accessToken) throw new LalorAuthError('Lalor 登录已失效，请重新配对');
    return this.accessToken;
  }

  private async authorized<T>(pathname: string, init: RequestInit): Promise<T> {
    let token = await this.ensureAccessToken();
    try {
      return unwrap<T>(await fetchJson(pathname, init, token));
    } catch (error: unknown) {
      if (!(error instanceof LalorAuthError) || error.status !== 401) throw error;
      await this.refreshSession(true);
      token = await this.ensureAccessToken();
      return unwrap<T>(await fetchJson(pathname, init, token));
    }
  }

  async pair(code: string): Promise<LalorConnectionStatus> {
    const normalizedCode = code.trim();
    if (!normalizedCode || normalizedCode.length > 64) throw new LalorAuthError('Lalor 配对码格式无效');
    const result = await fetchJson('/desktop/pair', {
      method: 'POST',
      body: JSON.stringify({ code: normalizedCode }),
    });
    const session = unwrap<BackendSession>(result);
    this.setSession(session);
    const profile = this.profileValue;
    if (!profile) throw new LalorAuthError('Lalor 资料缺失');
    this.profileValue = await this.hydrateProfileAvatar(profile);
    return this.statusFromMemory();
  }

  async status(): Promise<LalorConnectionStatus> {
    this.ensurePersistedLoaded();
    if (!this.refreshToken && !this.accessToken) return { connected: false };
    try {
      await this.refreshSession(false);
      return this.statusFromMemory();
    } catch (error: unknown) {
      if (error instanceof LalorAuthError && (error.status === 401 || error.status === 403)) {
        return { connected: false };
      }
      if (this.profileValue) return { ...this.statusFromMemory(), stale: true };
      throw error;
    }
  }

  async refresh(): Promise<LalorConnectionStatus> {
    await this.refreshSession(true);
    return this.statusFromMemory();
  }

  async profile(): Promise<LalorProfile> {
    const profile = await this.authorized<LalorProfile>('/desktop/profile', { method: 'GET' });
    this.profileValue = await this.hydrateProfileAvatar(profile);
    return this.profileValue;
  }

  async catalog(): Promise<LalorCatalog> {
    const catalog = await this.authorized<LalorCatalog>('/desktop/catalog', { method: 'GET' });
    this.profileValue = this.profileValue ? { ...this.profileValue, availablePoints: catalog.availablePoints } : this.profileValue;
    return catalog;
  }

  async purchase(productId: string, idempotencyKey: string): Promise<LalorPurchasePayload> {
    const normalizedProductId = productId.trim();
    const normalizedIdempotencyKey = idempotencyKey.trim();
    if (!normalizedProductId || normalizedProductId.length > 128) throw new LalorAuthError('请选择要购买的账号商品');
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 160) throw new LalorAuthError('购买请求幂等键无效');
    // 已知的非会员状态直接 fail-closed；服务端仍是最终权限校验，避免渲染层或旧目录绕过 UI 门禁。
    if (this.profileValue?.membership && !this.profileValue.membership.active) {
      throw new LalorAuthError('仅限有效 Lalor 会员购买账号');
    }
    const payload = await this.authorized<LalorPurchasePayload>('/desktop/purchases/points', {
      method: 'POST',
      body: JSON.stringify({ productId: normalizedProductId, idempotencyKey: normalizedIdempotencyKey }),
    });
    if (!payload?.delivery || typeof payload.delivery.content !== 'string') {
      throw new LalorAuthError('Lalor 订单交付内容无效');
    }
    this.profileValue = await this.hydrateProfileAvatar(payload.profile);
    return { ...payload, profile: this.profileValue };
  }

  async logout(): Promise<{ serverRevoked: boolean }> {
    this.ensurePersistedLoaded();
    let serverRevoked = false;
    try {
      if (this.accessToken) {
        unwrap(await fetchJson('/desktop/logout', { method: 'POST', body: JSON.stringify({ refreshToken: this.refreshToken }) }, this.accessToken));
        serverRevoked = true;
      } else if (this.refreshToken) {
        await this.refreshSession(true);
        if (this.accessToken) {
          unwrap(await fetchJson('/desktop/logout', { method: 'POST' }, this.accessToken));
          serverRevoked = true;
        }
      }
    } catch {
      // 本地退出仍然必须完成；调用方会看到 serverRevoked=false 并给出明确提示。
    } finally {
      this.clearSessionState();
    }
    return { serverRevoked };
  }

  private statusFromMemory(): LalorConnectionStatus {
    if (!this.profileValue) return { connected: false };
    return {
      connected: true,
      profile: this.profileValue,
      ...(this.accessExpiresAt ? { accessExpiresAt: this.accessExpiresAt } : {}),
      ...(this.refreshExpiresAt ? { refreshExpiresAt: this.refreshExpiresAt } : {}),
    };
  }
}

export function hasImportedDelivery(deliveryId: string): boolean {
  return readPurchaseState().importedDeliveryIds.includes(deliveryId);
}

export function markImportedDelivery(deliveryId: string): void {
  const state = readPurchaseState();
  if (state.importedDeliveryIds.includes(deliveryId)) return;
  state.importedDeliveryIds = [...state.importedDeliveryIds, deliveryId].slice(-5000);
  writePrivateJson(purchaseStatePath(), state);
}

export const lalorAuth = new LalorAuth();
