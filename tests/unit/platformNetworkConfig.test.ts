import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ files: new Map<string, unknown>(), encryption: true, writable: true }));
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => memory.encryption,
  encryptString: (value: string) => Buffer.from('sealed:' + value),
  decryptString: (value: Buffer) => { const text = value.toString(); if (!text.startsWith('sealed:')) throw new Error('corrupt'); return text.slice(7); },
} }));
vi.mock('../../main/utils/store', () => ({
  readJSON: <T>(file: string, fallback: T): T => structuredClone(memory.files.get(file) ?? fallback) as T,
  writeJSON: (file: string, value: unknown): boolean => { if (!memory.writable) return false; memory.files.set(file, structuredClone(value)); return true; },
}));
import { readPlatformNetworkConfig, savePlatformNetworkConfig } from '../../main/utils/platformNetworkConfig';

const config = { version: 2, sharedProxy: { protocol: 'socks5', host: 'proxy.example.com', port: 1080 }, relay: { protocol: 'https', host: 'relay.example.com', port: 18081, username: 'relay-user', password: 'private-test-secret' } };
describe('managed platform network', () => {
  beforeEach(() => { memory.files.clear(); memory.encryption = true; memory.writable = true; });
  it('persists encrypted configuration and restores it after a new read', () => {
    const withSubscription = {
      ...config,
      sharedSubscription: { label: 'platform-airport', url: 'https://sub.example.com/list?token=private' },
    };
    expect(savePlatformNetworkConfig(withSubscription)).toBe(true);
    expect(JSON.stringify(memory.files.get('platform-network.json'))).not.toContain('private-test-secret');
    expect(JSON.stringify(memory.files.get('platform-network.json'))).not.toContain('token=private');
    expect(readPlatformNetworkConfig()).toEqual(withSubscription);
  });
  it('ignores stale responses but accepts a rollback published as a new version', () => {
    savePlatformNetworkConfig(config);
    expect(savePlatformNetworkConfig({ ...config, version: 1 })).toBe(false);
    expect(savePlatformNetworkConfig({ ...config, version: 3, sharedProxy: { ...config.sharedProxy, host: 'previous.example.com' } })).toBe(true);
    expect(readPlatformNetworkConfig()?.sharedProxy.host).toBe('previous.example.com');
  });
  it('treats a null shared subscription from the server as an explicit clear', () => {
    const withSubscription = { ...config, sharedSubscription: { label: 'platform-airport', url: 'https://sub.example.com/list?token=private' } };
    savePlatformNetworkConfig(withSubscription);
    expect(savePlatformNetworkConfig({ ...config, version: 3, sharedSubscription: null })).toBe(true);
    expect(readPlatformNetworkConfig()?.sharedSubscription).toBeUndefined();
  });
  it('preserves the last working config when invalid or unsafe data arrives', () => {
    savePlatformNetworkConfig(config);
    expect(() => savePlatformNetworkConfig({ ...config, version: 3, relay: { ...config.relay, protocol: 'http' } })).toThrow('HTTPS');
    expect(readPlatformNetworkConfig()?.version).toBe(2);
    memory.writable = false;
    expect(() => savePlatformNetworkConfig({ ...config, version: 3 })).toThrow('保存失败');
    expect(readPlatformNetworkConfig()?.version).toBe(2);
  });
  it('never writes plaintext when the OS keystore is unavailable', () => {
    memory.encryption = false;
    expect(() => savePlatformNetworkConfig(config)).toThrow('安全存储不可用');
    expect(memory.files.size).toBe(0);
    expect(readPlatformNetworkConfig()).toBeNull();
  });
});
