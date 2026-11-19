import { safeStorage } from 'electron';
import type { AccountProxyProtocol } from '@doubao-studio/contracts';
import { deleteJSON, readJSON, writeJSON } from './store';
import { loadLalorSession } from './lalorAuthStore';
import { verifyDesktopGrant } from '../security/desktopSecurity';
import { normalizeSubscriptionUrl } from './proxySubscription';

const FILE = 'platform-network.json';
export interface PlatformNetworkConfig {
  version: number;
  sharedProxy: { protocol: AccountProxyProtocol; host: string; port: number };
  relay: { protocol: AccountProxyProtocol; host: string; port: number; username?: string; password?: string; expiresAt?: string };
  /** 管理员可选配置；URL 永远只存在于加密 platform-network.json 中。 */
  sharedSubscription?: { label?: string; url: string };
}

export function validatePlatformNetwork(value: unknown): PlatformNetworkConfig {
  if (!value || typeof value !== 'object') throw new Error('平台网络配置无效');
  const config = value as PlatformNetworkConfig;
  if (!Number.isSafeInteger(config.version) || config.version < 1) throw new Error('平台网络版本无效');
  for (const endpoint of [config.sharedProxy, config.relay]) {
    if (!endpoint || !['http', 'https', 'socks5'].includes(endpoint.protocol)
      || typeof endpoint.host !== 'string' || !endpoint.host || endpoint.host.length > 253
      || /[\s/@?#\\]/.test(endpoint.host) || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
      throw new Error('平台网络端点无效');
    }
  }
  if (config.relay.protocol !== 'https') throw new Error('平台中转必须使用 HTTPS');
  if (typeof config.relay.username !== 'string' || !config.relay.username
    || typeof config.relay.password !== 'string' || !config.relay.password) throw new Error('平台中转认证缺失');
  const parts = config.relay.password.split('.');
  const session = loadLalorSession();
  if (!session || parts.length !== 2) throw new Error('中转需要重新确认会员身份');
  const grant = verifyDesktopGrant({ payload: parts[0], signature: parts[1] }, session.profile.userId, 'desktop-relay');
  if (grant.sessionId !== config.relay.username || Date.parse(config.relay.expiresAt || '') !== grant.expiresAt * 1000) {
    throw new Error('中转授权与当前设备不匹配');
  }
  let sharedSubscription: PlatformNetworkConfig['sharedSubscription'];
  const rawSubscription = (value as Record<string, unknown>).sharedSubscription;
  if (rawSubscription !== undefined && rawSubscription !== null) {
    if (typeof rawSubscription !== 'object') throw new Error('平台共享订阅配置无效');
    const subscription = rawSubscription as { label?: unknown; url?: unknown };
    if (typeof subscription.url !== 'string') throw new Error('平台共享订阅配置无效');
    sharedSubscription = {
      label: typeof subscription.label === 'string' && subscription.label.trim()
        ? subscription.label.trim().slice(0, 80)
        : undefined,
      url: normalizeSubscriptionUrl(subscription.url),
    };
  }
  return {
    version: config.version,
    sharedProxy: { protocol: config.sharedProxy.protocol, host: config.sharedProxy.host, port: config.sharedProxy.port },
    relay: { ...config.relay },
    ...(sharedSubscription ? { sharedSubscription } : {}),
  };
}

/** 整体加密缓存，仅主进程读取；管理员保存的上游代理密码不会下发到桌面。 */
export function readPlatformNetworkConfig(): PlatformNetworkConfig | null {
  const stored = readJSON<{ ciphertext?: string } | null>(FILE, null);
  if (!stored?.ciphertext || !safeStorage.isEncryptionAvailable()) return null;
  try { return validatePlatformNetwork(JSON.parse(safeStorage.decryptString(Buffer.from(stored.ciphertext, 'base64')))); }
  catch { return null; }
}

export function savePlatformNetworkConfig(value: unknown): boolean {
  const config = validatePlatformNetwork(value);
  const current = readPlatformNetworkConfig();
  if (current && config.version < current.version) return false;
  if (current && config.version === current.version && config.relay.password === current.relay.password) return false;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，保留原平台网络配置');
  const ciphertext = safeStorage.encryptString(JSON.stringify(config)).toString('base64');
  if (!writeJSON(FILE, { ciphertext })) throw new Error('平台网络配置保存失败');
  return true;
}

export function clearPlatformNetworkConfig(): void { deleteJSON(FILE); }
