import { createHash, createPublicKey, verify } from 'crypto';
import { createReadStream } from 'fs';
import { desktopTrust } from './desktopSecurity';

const URL = 'https://yuyan-ai.site/desktop-updates/win-x64/latest.security.json';
const DOMAIN = 'LALOR-DESKTOP-UPDATE-V1\n';
export async function verifyPinnedUpdate(_publishers: string[], installer: string): Promise<string | null> {
  try {
    const response = await fetch(URL, { redirect: 'error', signal: AbortSignal.timeout(20_000), cache: 'no-store' });
    if (!response.ok) throw new Error('更新签名不可用');
    const body = await response.text();
    if (body.length > 8192) throw new Error('更新签名过大');
    const grant = JSON.parse(body) as { payload: string; signature: string };
    const keys = desktopTrust().updatePublicKeys;
    if (!keys?.some((key) => verify(null, Buffer.from(DOMAIN + grant.payload), createPublicKey(key), Buffer.from(grant.signature, 'base64url')))) {
      throw new Error('更新签名无效');
    }
    const claims = JSON.parse(Buffer.from(grant.payload, 'base64url').toString('utf8')) as { audience: string; sha512: string; size: number };
    if (claims.audience !== 'lalor-workbench-update' || !Number.isSafeInteger(claims.size) || claims.size <= 0) throw new Error('更新声明无效');
    const digest = createHash('sha512');
    let size = 0;
    for await (const chunk of createReadStream(installer)) { digest.update(chunk); size += chunk.length; }
    if (size !== claims.size || digest.digest('base64') !== claims.sha512) throw new Error('安装文件与签名不一致');
    return null;
  } catch { return '更新文件签名校验失败，已阻止安装；当前版本可以继续使用。'; }
}
