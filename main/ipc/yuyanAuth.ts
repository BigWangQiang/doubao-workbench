import { app, safeStorage } from 'electron';
import type { LalorAuthResult, LalorAuthSnapshot, LalorProfile } from '@doubao-studio/contracts';
import { resolveDesktopApiBase, secureDesktopFetch, verifyDesktopGrant, type SignedDesktopGrant } from '../security/desktopSecurity';
import { deleteJSON, readJSON, writeJSON } from '../utils/store';

const credentialFile = 'yuyan-workbench-key.json';
let currentLicense: { profile: LalorProfile; entitlement: SignedDesktopGrant } | undefined;
let credentialRevision = 0;

export function readYuyanKey(): string {
    const encrypted = readJSON<string | null>(credentialFile, null);
    if (!encrypted) throw new Error('请先连接屿砚账号');
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
}

export function hasYuyanKey(): boolean {
    return readJSON<string | null>(credentialFile, null) !== null;
}

async function exchangePairing(code: string): Promise<string> {
    const base = resolveDesktopApiBase(app.isPackaged, process.env.LALOR_API_BASE_URL);
    const response = await secureDesktopFetch(`${base}/desktop/exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error(`屿砚网站未返回配对结果（HTTP ${response.status}）`);
    const result: { code: number; data?: { credential: string }; msg: string } = await response.json();
    if (!response.ok || result.code !== 0 || !result.data) throw new Error(result.msg || `屿砚配对失败（HTTP ${response.status}）`);
    return result.data.credential;
}

async function licenseFor(key: string): Promise<{ profile: LalorProfile; entitlement: SignedDesktopGrant }> {
    const base = resolveDesktopApiBase(app.isPackaged, process.env.LALOR_API_BASE_URL);
    const response = await secureDesktopFetch(`${base}/v1/desktop/license`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error(`屿砚网站未返回桌面授权（HTTP ${response.status}）`);
    const result: { code: number; data?: { profile: LalorProfile; entitlement: SignedDesktopGrant }; msg: string } = await response.json();
    if (!response.ok || result.code !== 0 || !result.data) throw new Error(result.msg || `屿砚授权失败（HTTP ${response.status}）`);
    verifyDesktopGrant(result.data.entitlement, result.data.profile.userId);
    return result.data;
}

export async function requireYuyanGenerationAccess(key = readYuyanKey()): Promise<LalorProfile> {
    const revision = credentialRevision;
    const license = await licenseFor(key);
    if (revision !== credentialRevision || key !== readYuyanKey()) throw new Error('屿砚登录已改变，请重新操作');
    currentLicense = license;
    return license.profile;
}

export function yuyanGenerationAccessError(): string | undefined {
    if (!currentLicense) return '生成需要有效的屿砚会员，请先连接账号。';
    try { verifyDesktopGrant(currentLicense.entitlement, currentLicense.profile.userId); return undefined; }
    catch { return '设备授权已失效，请重新确认屿砚会员身份。'; }
}

export const yuyanAuthHandlers = {
    status: async (): Promise<LalorAuthResult<LalorAuthSnapshot>> => {
        if (!hasYuyanKey()) return { success: true, data: { authenticated: false } };
        const revision = credentialRevision;
        try { return { success: true, data: { authenticated: true, profile: await requireYuyanGenerationAccess() } }; }
        catch (error) {
            if (revision === credentialRevision) currentLicense = undefined;
            return { success: true, data: { authenticated: false, error: error instanceof Error ? error.message : String(error) } };
        }
    },
    connect: async (value: string): Promise<LalorAuthResult<LalorAuthSnapshot>> => {
        const revision = ++credentialRevision;
        try {
            const input = value.trim();
            const key = input.startsWith('yc_pair_') ? await exchangePairing(input) : input;
            const license = await licenseFor(key);
            if (revision !== credentialRevision) throw new Error('屿砚登录已改变，请重新操作');
            const cipher = safeStorage.encryptString(key).toString('base64');
            if (!writeJSON(credentialFile, cipher)) throw new Error('屿砚凭据保存失败');
            currentLicense = license;
            return { success: true, data: { authenticated: true, profile: license.profile } };
        } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    logout: (): LalorAuthResult<{ ok: boolean }> => {
        credentialRevision++;
        currentLicense = undefined;
        if (!deleteJSON(`${credentialFile}.bak`) || !deleteJSON(credentialFile)) return { success: false, error: '屿砚凭据清除失败' };
        return { success: true, data: { ok: true } };
    },
};
