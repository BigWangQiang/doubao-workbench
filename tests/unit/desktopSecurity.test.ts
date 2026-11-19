import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
const mock = vi.hoisted(() => ({ stored: null as unknown, trust: '', window: null as unknown }));
vi.mock('electron', () => ({ app: { isPackaged: true, getAppPath: () => '/app' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('../../main/utils/store', () => ({ readJSON: () => mock.stored, writeJSON: (_name: string, data: unknown) => { mock.stored = data; return true; } }));
vi.mock('fs', () => ({ readFileSync: () => mock.trust }));
import { deviceKeyHash, resolveDesktopApiBase, secureDesktopFetch, verifyDesktopGrant } from '../../main/security/desktopSecurity';
import { assertTrustedIpc, trustWorkbenchWindow } from '../../main/security/trustedIpc';

afterEach(() => vi.unstubAllGlobals());
describe('desktop security boundaries', () => {
  it('pins packaged authorization and rejects insecure development targets', () => {
    expect(resolveDesktopApiBase(true, 'https://attacker.invalid/api')).toBe('https://yuyan-ai.site/api');
    expect(() => resolveDesktopApiBase(false, 'http://attacker.invalid/api')).toThrow();
    expect(resolveDesktopApiBase(false, 'http://127.0.0.1:8080/api')).toBe('http://127.0.0.1:8080/api');
  });
  it('binds grants to the signature, user, device, purpose and expiry', () => {
    const key = generateKeyPairSync('ed25519');
    mock.trust = JSON.stringify({ publicKeys: [key.publicKey.export({ type: 'spki', format: 'pem' })] });
    const now = Math.floor(Date.now() / 1000);
    const base = { audience: 'lalor-workbench', purpose: 'desktop-license', userId: 'member', sessionId: 'session',
      deviceKeyHash: deviceKeyHash(), issuedAt: now, expiresAt: now + 120, permissions: ['generate'] };
    const grant = (changes = {}): { payload: string; signature: string } => {
      const payload = Buffer.from(JSON.stringify({ ...base, ...changes })).toString('base64url');
      return { payload, signature: sign(null, Buffer.from('LALOR-DESKTOP-GRANT-V1\n' + payload), key.privateKey).toString('base64url') };
    };
    expect(verifyDesktopGrant(grant(), 'member').sessionId).toBe('session');
    expect(() => verifyDesktopGrant(grant(), 'other')).toThrow();
    for (const changes of [{ deviceKeyHash: 'copied' }, { expiresAt: now - 1 }, { permissions: [] }, { purpose: 'desktop-relay' }]) {
      expect(() => verifyDesktopGrant(grant(changes), 'member')).toThrow();
    }
    expect(() => verifyDesktopGrant({ ...grant(), signature: 'invalid' }, 'member')).toThrow();
  });
  it('signs the exact encoded multipart request and rejects redirect/foreign destinations', async () => {
    const fetcher = vi.fn(async (request: Request) => {
      const { createHash } = await import('crypto');
      const proof = JSON.parse(Buffer.from(request.headers.get('X-Lalor-Device-Proof')!.split('.')[0], 'base64url').toString());
      expect(proof.bodyHash).toBe(createHash('sha256').update(Buffer.from(await request.arrayBuffer())).digest('hex'));
      expect(request.redirect).toBe('error');
      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetcher);
    const form = new FormData(); form.set('file', new Blob(['test bytes']), 'test.txt');
    await secureDesktopFetch('https://yuyan-ai.site/api/desktop/tasks/test/artifacts', { method: 'POST', body: form });
    await expect(secureDesktopFetch('https://attacker.invalid/api/desktop/profile')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects external webviews, subframes and changed main-window origins', () => {
    const frame = { url: 'file:///D:/doubao-studio-phase1/dist/renderer/index.html' };
    const sender = { mainFrame: frame };
    trustWorkbenchWindow({ isDestroyed: () => false, webContents: sender } as never);
    expect(() => assertTrustedIpc({ sender: {}, senderFrame: frame } as never)).toThrow();
    expect(() => assertTrustedIpc({ sender, senderFrame: {} } as never)).toThrow();
    frame.url = 'https://www.doubao.com/chat/';
    expect(() => assertTrustedIpc({ sender, senderFrame: frame } as never)).toThrow();
  });
});
