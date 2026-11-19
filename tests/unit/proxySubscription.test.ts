import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  fetchProxySubscription,
  maskSubscriptionUrl,
  normalizeSubscriptionUrl,
  parseProxySubscriptionText,
} from '../../main/utils/proxySubscription';

describe('proxy subscription parser', () => {
  it('parses native and core-managed Clash nodes', () => {
    const result = parseProxySubscriptionText(`proxies:\n  - name: office\n    type: http\n    server: proxy.example.com\n    port: 8080\n    username: alice\n    password: secret\n  - name: secure\n    type: socks5\n    server: socks.example.com\n    port: 1080\n  - name: legacy\n    type: vmess\n    server: vmess.example.com\n    port: 443`);
    expect(result.format).toBe('clash');
    expect(result.nodes).toEqual([
      expect.objectContaining({ label: 'office', protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'alice', password: 'secret' }),
      expect.objectContaining({ label: 'secure', protocol: 'socks5', host: 'socks.example.com', port: 1080 }),
      expect.objectContaining({ label: 'legacy', protocol: 'vmess', managedByCore: true, rawConfig: expect.objectContaining({ type: 'vmess' }) }),
    ]);
    expect(result.unsupportedProtocols).toEqual([]);
  });

  it('parses URI and base64 subscriptions, de-duplicating nodes', () => {
    const uri = 'http://user:pass@proxy.example.com:8080#main\nsocks5://socks.example.com:1080#backup\nhttp://user:pass@proxy.example.com:8080#duplicate';
    const encoded = Buffer.from(uri, 'utf8').toString('base64');
    const result = parseProxySubscriptionText(encoded);
    expect(result.format).toBe('base64');
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toMatchObject({ protocol: 'http', username: 'user', password: 'pass' });
  });

  it('accepts airport core protocols from Clash YAML', () => {
    const result = parseProxySubscriptionText(`proxies:\n  - name: anytls\n    type: anytls\n    server: anytls.example.com\n    port: 443\n    password: secret-a\n  - name: hy2\n    type: hysteria2\n    server: hy2.example.com\n    port: 443\n    password: secret-b\n  - name: shadowsocks\n    type: ss\n    server: ss.example.com\n    port: 8388\n    cipher: aes-128-gcm\n    password: secret-c\n  - name: trojan\n    type: trojan\n    server: trojan.example.com\n    port: 443\n    password: secret-d`);
    expect(result.nodes.map((node) => node.protocol)).toEqual(['anytls', 'hysteria2', 'ss', 'trojan']);
    expect(result.nodes.every((node) => node.managedByCore && node.rawConfig)).toBe(true);
    expect(result.unsupportedProtocols).toEqual([]);
  });

  it('rejects non-http subscription endpoints and masks tokens', () => {
    expect(() => normalizeSubscriptionUrl('ss://secret@example.com/abc')).toThrow('HTTP 或 HTTPS');
    const normalized = normalizeSubscriptionUrl('https://sub.example.com/list?token=private');
    expect(maskSubscriptionUrl(normalized)).toBe('https://sub.example.com');
  });

  it('rejects oversized subscription content', () => {
    expect(() => parseProxySubscriptionText('x'.repeat(2 * 1024 * 1024 + 1))).toThrow('2 MB');
  });

  it('uses a Clash client header and retries content-negotiation failures', async () => {
    const calls: Array<Record<string, string>> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(Object.fromEntries(new Headers(init?.headers).entries()));
      if (calls.length === 1) return new Response('not acceptable', { status: 406 });
      return new Response('http://proxy.example.com:8080#main', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }) as typeof fetch;

    const result = await fetchProxySubscription('https://sub.example.com/private?token=redacted', { fetchImpl });
    expect(result.nodes).toHaveLength(1);
    expect(calls[0]['user-agent']).toBe('ClashMeta/1.19.0');
    expect(calls[0].accept).toContain('application/yaml');
    expect(calls[1]['user-agent']).toBe('clash-verge-rev/1.7.7');
  });

  it('refreshes every subscription node instead of probing only the first page', () => {
    const source = readFileSync(resolve(__dirname, '..', '..', 'main', 'ipc', 'localManager.ts'), 'utf8');
    const refreshStart = source.indexOf('export async function refreshProxySubscription');
    const refreshEnd = source.indexOf('async function runWithConcurrency', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);

    expect(refreshBody).toContain('runWithConcurrency(entries,');
    expect(refreshBody).not.toContain('MAX_SUBSCRIPTION_AUTO_PROBES');
    expect(refreshBody).not.toContain('entries.slice(');
  });
});
