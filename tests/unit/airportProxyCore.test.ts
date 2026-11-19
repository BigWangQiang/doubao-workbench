import { describe, expect, it } from 'vitest';
import { buildAirportProxyCoreConfig } from '../../main/utils/airportProxyCore';

describe('airport proxy core configuration', () => {
  it('builds a loopback-only mixed port with a single selected node', () => {
    const config = buildAirportProxyCoreConfig({
      name: 'secret-node',
      type: 'trojan',
      server: 'node.example.com',
      port: 443,
      password: 'private-secret',
      sni: 'node.example.com',
    }, 19080);
    expect(config).toMatchObject({
      'mixed-port': 19080,
      'allow-lan': false,
      'bind-address': '127.0.0.1',
      rules: ['MATCH,lalor-airport'],
    });
    expect(config.proxies).toEqual([expect.objectContaining({ name: 'lalor-airport-node', type: 'trojan' })]);
    expect(JSON.stringify(config)).toContain('private-secret');
  });
});
