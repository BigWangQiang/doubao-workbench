import { describe, expect, it } from 'vitest';
import { normalizeProxyInput, proxyRules } from '../../main/utils/accountProxy';

describe('account proxy configuration', () => {
  it('normalizes an enabled authenticated proxy without embedding credentials in rules', () => {
    const result = normalizeProxyInput({
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
      username: 'user',
      password: 'secret',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config).toMatchObject({ enabled: true, host: '127.0.0.1', port: 7890 });
      expect(proxyRules(result.value.config!)).toBe('http://127.0.0.1:7890');
      expect(result.value.username).toBe('user');
      expect(result.value.password).toBe('secret');
    }
  });

  it.each(['http', 'https', 'socks5'] as const)('accepts %s in the shared proxy normalizer', (protocol) => {
    const result = normalizeProxyInput({ enabled: true, protocol, host: 'proxy.example.com', port: 443 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(proxyRules(result.value.config!)).toBe(`${protocol}://proxy.example.com:443`);
  });

  it.each([
    ['invalid protocol', { protocol: 'ftp' }],
    ['empty host', { host: '' }],
    ['host with path', { host: '127.0.0.1/path' }],
    ['invalid port', { port: 70000 }],
  ])('rejects %s', (_label, overrides) => {
    const result = normalizeProxyInput({
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
      ...overrides,
    } as never);
    expect(result.ok).toBe(false);
  });

  it('turns disabled proxy into a direct-session instruction', () => {
    const result = normalizeProxyInput({ enabled: false, protocol: 'http', host: '', port: 0 });
    expect(result).toEqual({ ok: true, value: { clearCredentials: true } });
  });
});
