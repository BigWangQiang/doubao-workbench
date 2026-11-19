import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceKeyHash } from '../../main/security/desktopSecurity';
import { readYuyanKey, yuyanAuthHandlers, yuyanGenerationAccessError } from '../../main/ipc/yuyanAuth';

const mock = vi.hoisted(() => ({ files: new Map<string, unknown>(), trust: '' }));
vi.mock('electron', () => ({
    app: { isPackaged: true, getAppPath: (): string => '/app' },
    safeStorage: { isEncryptionAvailable: (): boolean => true, encryptString: (value: string): Buffer => Buffer.from(value), decryptString: (value: Buffer): string => value.toString() },
}));
vi.mock('fs', () => ({ readFileSync: (): string => mock.trust }));
vi.mock('../../main/utils/store', () => ({
    readJSON: (name: string, fallback: unknown): unknown => mock.files.get(name) ?? fallback,
    writeJSON: (name: string, value: unknown): boolean => { mock.files.set(name, value); return true; },
    deleteJSON: (name: string): boolean => { mock.files.delete(name); return true; },
}));

describe('屿砚账号桌面授权', (): void => {
    beforeEach((): void => {
        yuyanAuthHandlers.logout();
        mock.files.clear();
        mock.files.set('lalor-desktop-session.json', 'legacy-session');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test forbids network')));
    });
    afterEach((): void => { vi.unstubAllGlobals(); });

    it('uses a signed read-only grant to connect and keeps the legacy session isolated', async (): Promise<void> => {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        mock.trust = JSON.stringify({ publicKeys: [publicKey.export({ type: 'spki', format: 'pem' })] });
        const now = Math.floor(Date.now() / 1000);
        const payload = Buffer.from(JSON.stringify({ audience: 'lalor-workbench', purpose: 'desktop-license',
            userId: 'member', sessionId: 'test', deviceKeyHash: deviceKeyHash(), issuedAt: now, expiresAt: now + 60, permissions: ['generate'] })).toString('base64url');
        const signature = sign(null, Buffer.from('LALOR-DESKTOP-GRANT-V1\n' + payload), privateKey).toString('base64url');
        vi.mocked(fetch).mockImplementation(async (request): Promise<Response> => {
            expect(request).toBeInstanceOf(Request);
            const signed = request as Request;
            expect(signed.url).toBe('https://yuyan-ai.site/api/v1/desktop/license');
            expect(signed.method).toBe('GET');
            expect(signed.headers.get('Authorization')).toBe('Bearer synthetic-key');
            expect(signed.headers.has('X-Lalor-Device-Proof')).toBe(true);
            return Response.json({ code: 0, data: { profile: { userId: 'member' }, entitlement: { payload, signature } } });
        });
        expect(await yuyanAuthHandlers.status()).toMatchObject({ data: { authenticated: false } });
        expect(fetch).not.toHaveBeenCalled();
        expect(await yuyanAuthHandlers.connect('synthetic-key')).toMatchObject({ data: { authenticated: true, profile: { userId: 'member' } } });
        expect(yuyanGenerationAccessError()).toBeUndefined();
        expect(readYuyanKey()).toBe('synthetic-key');
        expect(yuyanAuthHandlers.logout().success).toBe(true);
        expect(() => readYuyanKey()).toThrow();
        expect(mock.files.get('lalor-desktop-session.json')).toBe('legacy-session');
    });
});
