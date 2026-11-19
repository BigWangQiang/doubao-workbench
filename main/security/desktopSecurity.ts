import { app, safeStorage } from 'electron';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { readJSON, writeJSON } from '../utils/store';
import { YUYAN_API } from '../config/yuyanPlatform';

export const PRODUCTION_LALOR_API = YUYAN_API;
const DEVICE_KEY_FILE = 'yuyan-device-key.json';
const PROOF_DOMAIN = 'LALOR-DESKTOP-PROOF-V1\n';
const GRANT_DOMAIN = 'LALOR-DESKTOP-GRANT-V1\n';

export interface SignedDesktopGrant { payload: string; signature: string }
export interface DesktopGrantClaims {
  audience: 'lalor-workbench';
  purpose: 'desktop-license' | 'desktop-relay';
  userId: string;
  sessionId: string;
  deviceKeyHash: string;
  issuedAt: number;
  expiresAt: number;
  permissions: string[];
}
export interface DesktopTrust { publicKeys: string[]; updatePublicKeys: string[] }

export function resolveDesktopApiBase(packaged: boolean, configured?: string): string {
  if (packaged) return PRODUCTION_LALOR_API;
  const url = new URL(configured?.trim() || PRODUCTION_LALOR_API);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('授权服务必须使用 HTTPS，本机开发仅允许回环地址');
  }
  if (url.pathname.replace(/\/+$/, '') !== '/api') throw new Error('授权服务地址必须以 /api 结尾');
  return url.toString().replace(/\/+$/, '');
}

export function desktopTrust(): DesktopTrust {
  // 正式版信任根属于签名 ASAR，不接受用户数据目录或环境变量替换。
  const file = !app.isPackaged && process.env.LALOR_DESKTOP_TRUST_FILE
    ? process.env.LALOR_DESKTOP_TRUST_FILE : path.join(app.getAppPath(), 'security', 'desktop-trust.json');
  let value: DesktopTrust;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) as DesktopTrust; }
  catch { throw new Error('缺少工作台授权公钥配置，请联系管理员更新安装包'); }
  if (!Array.isArray(value.publicKeys) || !value.publicKeys.length
    || value.publicKeys.some((key) => typeof key !== 'string' || createPublicKey(key).asymmetricKeyType !== 'ed25519')) {
    throw new Error('工作台授权公钥配置无效');
  }
  return value;
}

let devicePrivateKey: KeyObject | undefined;
function deviceKey(): KeyObject {
  if (devicePrivateKey) return devicePrivateKey;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法使用设备授权');
  const stored = readJSON<{ encrypted?: string } | null>(DEVICE_KEY_FILE, null);
  if (stored) {
    // 损坏时禁止静默生成新身份，避免旧会话与新设备混用。
    if (!stored.encrypted) throw new Error('设备密钥已损坏，请解绑后重新配置');
    devicePrivateKey = createPrivateKey(safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64')));
  } else {
    const key = generateKeyPairSync('ed25519').privateKey;
    const pem = key.export({ format: 'pem', type: 'pkcs8' }).toString();
    const encrypted = safeStorage.encryptString(pem).toString('base64');
    if (!writeJSON(DEVICE_KEY_FILE, { encrypted })) throw new Error('设备密钥保存失败');
    devicePrivateKey = key;
  }
  if (devicePrivateKey.asymmetricKeyType !== 'ed25519') throw new Error('设备密钥类型无效');
  return devicePrivateKey;
}

function devicePublicKey(): string {
  const key = createPublicKey(deviceKey().export({ type: 'pkcs8', format: 'pem' })).export({ format: 'jwk' });
  if (!key.x) throw new Error('设备公钥无效');
  return key.x;
}
export function deviceKeyHash(): string {
  return createHash('sha256').update(Buffer.from(devicePublicKey(), 'base64url')).digest('hex');
}

/** 此通道只处理桌面授权；普通客户 /api/v1 合同保持独立。 */
export async function secureDesktopFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  if (input instanceof Request) throw new Error('桌面授权请求必须显式提供 URL 和请求体');
  const url = new URL(input.toString());
  const base = new URL(resolveDesktopApiBase(app.isPackaged, process.env.LALOR_API_BASE_URL));
  if (url.origin !== base.origin || (!url.pathname.startsWith('/api/desktop/') && url.pathname !== '/api/v1/desktop/license')) throw new Error('拒绝向非授权地址发送桌面凭据');
  const headers = new Headers(init.headers);
  const authorization = headers.get('Authorization') || '';
  const request = new Request(url, { ...init, headers, redirect: 'error' });
  const digest = createHash('sha256');
  // 同一份 multipart 编码用于签名和发送，不能重新生成 boundary。
  const reader = request.clone().body?.getReader();
  if (reader) {
    try { for (;;) { const part = await reader.read(); if (part.done) break; digest.update(part.value); } }
    finally { reader.releaseLock(); }
  }
  const claims = {
    audience: 'lalor-desktop-request', publicKey: devicePublicKey(),
    method: (init.method || 'GET').toUpperCase(), target: url.pathname + url.search,
    issuedAt: Math.floor(Date.now() / 1000), nonce: randomBytes(24).toString('base64url'),
    tokenHash: createHash('sha256').update(authorization).digest('hex'),
    bodyHash: digest.digest('hex'),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign(null, Buffer.from(PROOF_DOMAIN + payload), deviceKey()).toString('base64url');
  request.headers.set('X-Lalor-Device-Proof', `${payload}.${signature}`);
  // 禁止 307/308 把配对码、刷新令牌或带权限的请求带到另一地址。
  return globalThis.fetch(request);
}

export function verifyDesktopGrant(
  grant: SignedDesktopGrant | undefined, userId: string,
  purpose: DesktopGrantClaims['purpose'] = 'desktop-license',
): DesktopGrantClaims {
  if (!grant || typeof grant.payload !== 'string' || typeof grant.signature !== 'string'
    || grant.payload.length > 4096 || grant.signature.length > 128) throw new Error('服务端未返回有效的设备授权，请更新或重新配对');
  const valid = desktopTrust().publicKeys.some((key) => verify(null,
    Buffer.from(GRANT_DOMAIN + grant.payload), createPublicKey(key), Buffer.from(grant.signature, 'base64url')));
  if (!valid) throw new Error('设备授权签名校验失败');
  const claims = JSON.parse(Buffer.from(grant.payload, 'base64url').toString('utf8')) as DesktopGrantClaims;
  const now = Math.floor(Date.now() / 1000);
  if (claims.audience !== 'lalor-workbench' || claims.purpose !== purpose || claims.userId !== userId
    || !userId || !claims.sessionId || claims.deviceKeyHash !== deviceKeyHash()
    || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
    || claims.issuedAt > now + 30 || claims.expiresAt <= now || claims.expiresAt - claims.issuedAt > 300
    || !Array.isArray(claims.permissions) || !claims.permissions.includes(purpose === 'desktop-license' ? 'generate' : 'relay')) {
    throw new Error('设备授权已过期或与当前用户不匹配，请重新确认会员身份');
  }
  return claims;
}
