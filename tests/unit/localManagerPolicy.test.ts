import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ files: new Map<string, unknown>() }));

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\test-user-data' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

vi.mock('../../main/utils/store', () => ({
  readJSON: <T>(filename: string, fallback: T): T => {
    const value = memory.files.get(filename);
    return value === undefined ? structuredClone(fallback) : structuredClone(value) as T;
  },
  writeJSON: <T>(filename: string, value: T): boolean => {
    memory.files.set(filename, structuredClone(value));
    return true;
  },
}));

import {
  addProxy,
  addSubscription,
  bindSession,
  deleteProxy,
  deleteSubscription,
  getSubscriptionUrl,
  getProxyCoreConfig,
  listLocalManager,
  randomAssign,
  initializeLocalManagerDefaults,
  replaceSubscriptionProxies,
  setProxyEnabled,
  setRoutingMode,
  unbindSession,
  updateProxyCheck,
} from '../../main/utils/localManagerStore';
import { getBoundProxyCredentials, getSessionProxyCoreConfig, resolveAccountSessionRoute } from '../../main/utils/sessionProxyRouter';


function addUsableProxy(label: string): string {
  const proxy = addProxy({
    label,
    protocol: 'https',
    host: `${label}.example.com`,
    port: 443,
  });
  updateProxyCheck(proxy.id, { state: 'valid' });
  return proxy.id;
}

describe('local manager binding policy', () => {
  beforeEach(() => {
    memory.files.clear();
  });

  it('allows a Doubao window to bind and unbind its own proxy', () => {
    const proxyId = addUsableProxy('proxy-a');
    expect(bindSession('doubao-1', 'doubao', proxyId)).toMatchObject({ platform: 'doubao', proxyId });
    expect(resolveAccountSessionRoute('doubao-1', 'doubao')).toMatchObject({ mode: 'proxy', proxyId });
    expect(resolveAccountSessionRoute('doubao-1', 'dola')).toEqual({ mode: 'direct' });
    unbindSession('doubao-1');
    expect(resolveAccountSessionRoute('doubao-1', 'doubao')).toEqual({ mode: 'direct' });
    expect(listLocalManager().bindings).toEqual([]);
  });

  it('persists all supported proxy protocols', () => {
    for (const protocol of ['http', 'https', 'socks5'] as const) {
      const proxy = addProxy({ label: protocol, protocol, host: `${protocol}.example.com`, port: 443 });
      expect(listLocalManager().proxies.find((item) => item.id === proxy.id)?.protocol).toBe(protocol);
    }
  });

  it('defaults new and legacy proxies to enabled', () => {
    const created = addProxy({ label: 'new', protocol: 'https', host: 'new.example.com', port: 443 });
    expect(created.enabled).toBe(true);

    memory.files.set('local-manager.json', {
      version: 1,
      dola: [],
      doubao: [],
      proxies: [{
        id: 'legacy-proxy', label: 'legacy', protocol: 'https', host: 'legacy.example.com', port: 443,
        credentialsConfigured: false, state: 'valid', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      }],
      subscriptions: [],
      bindings: [],
      concurrency: 1,
      routingMode: 'bound_only',
    });
    expect(listLocalManager().proxies.find((proxy) => proxy.id === 'legacy-proxy')?.enabled).toBe(true);
  });

  it('keeps bindings but excludes a disabled proxy from routing, binding and random assignment', () => {
    const disabledProxyId = addUsableProxy('disabled');
    addUsableProxy('enabled');
    bindSession('dola-bound', 'dola', disabledProxyId);

    setProxyEnabled(disabledProxyId, false);

    expect(listLocalManager().bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'dola-bound', proxyId: disabledProxyId }),
    ]));
    expect(resolveAccountSessionRoute('dola-bound', 'dola')).toEqual({ mode: 'direct' });
    expect(() => bindSession('dola-new', 'dola', disabledProxyId)).toThrow('代理已禁用');
    const assignments = randomAssign(['dola-random'], { 'dola-random': 'dola' }, 10);
    expect(assignments[0]?.proxyId).not.toBe(disabledProxyId);

    setProxyEnabled(disabledProxyId, true);
    expect(resolveAccountSessionRoute('dola-bound', 'dola')).toMatchObject({ proxyId: disabledProxyId });
  });

  it('allows ten Dola windows on one proxy and rejects the eleventh', () => {
    const proxyId = addUsableProxy('proxy-a');
    for (let index = 0; index < 10; index += 1) {
      bindSession(`dola-${index}`, 'dola', proxyId);
    }
    expect(() => bindSession('dola-10', 'dola', proxyId)).toThrow('单个代理最多绑定 10 个窗口');
    expect(listLocalManager().bindings).toHaveLength(10);
  });

  it('random assignment stays within the selected per-proxy limit', () => {
    addUsableProxy('proxy-a');
    addUsableProxy('proxy-b');
    const accountIds = Array.from({ length: 8 }, (_, index) => `dola-${index}`);
    const platforms = Object.fromEntries(accountIds.map((id) => [id, 'dola'])) as Record<string, 'dola'>;

    const bindings = randomAssign(accountIds, platforms, 4);
    const counts = new Map<string, number>();
    for (const binding of bindings) {
      expect(binding.platform).toBe('dola');
      expect(binding.proxyId).not.toBeNull();
      if (!binding.proxyId) throw new Error('Dola 随机分配未返回代理 ID');
      counts.set(binding.proxyId, (counts.get(binding.proxyId) || 0) + 1);
    }
    expect(bindings).toHaveLength(8);
    expect([...counts.values()].every((count) => count <= 4)).toBe(true);
  });

  it('shares proxy capacity across platforms and assigns only selected windows', () => {
    const proxyId = addUsableProxy('shared');
    for (let index = 0; index < 9; index += 1) bindSession(`dola-${index}`, 'dola', proxyId);
    bindSession('doubao-bound', 'doubao', proxyId);
    expect(() => bindSession('doubao-overflow', 'doubao', proxyId)).toThrow('单个代理最多绑定 10 个窗口');
    const before = listLocalManager().bindings.filter((binding) => binding.platform === 'dola');
    addUsableProxy('additional-personal');
    const assigned = randomAssign(['doubao-new'], { 'doubao-new': 'doubao' }, 10);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ accountId: 'doubao-new', platform: 'doubao' });
    expect(assigned[0].proxyId).not.toBe(proxyId);
    expect(listLocalManager().bindings.filter((binding) => binding.platform === 'dola')).toEqual(before);
    expect(() => randomAssign(['missing'], {}, 10)).toThrow('窗口不存在');
  });

  it('does not partially persist assignments when proxy capacity is insufficient', () => {
    addUsableProxy('proxy-a');
    // 初始化后还会有一条平台共享 IP；用 5 个账号验证两条代理各 2
    // 个容量确实不足，避免测试样例依赖代理池条目数量。
    const accountIds = Array.from({ length: 5 }, (_, index) => `dola-${index}`);
    const platforms = Object.fromEntries(accountIds.map((id) => [id, 'dola'])) as Record<string, 'dola'>;

    expect(() => randomAssign(accountIds, platforms, 2)).toThrow('代理容量不足');
    expect(listLocalManager().bindings).toEqual([]);
  });

  it('初始化不再创建平台中转，保留用户代理', () => {
    const proxyId = addUsableProxy('personal');
    initializeLocalManagerDefaults();
    expect(memory.files.get('dola-proxy.json')).toEqual({ enabled: false });
    expect(listLocalManager().proxies.map((proxy) => proxy.id)).toEqual([proxyId]);
    expect(listLocalManager().subscriptions).toEqual([]);
  });

  it('移除旧平台中转及其绑定，保留个人代理和账号', () => {
    const personal = addUsableProxy('personal');
    bindSession('personal-account', 'dola', personal);
    const state = memory.files.get('local-manager.json') as any;
    state.proxies.push({ id: 'proxy-platform-shared', host: 'api.lalun.cn', port: 18081 });
    state.bindings.push({ accountId: 'old', platform: 'dola', proxyId: 'proxy-platform-shared' });
    memory.files.set('local-manager.json', state);
    initializeLocalManagerDefaults();
    expect(listLocalManager().proxies.map((proxy) => proxy.id)).toEqual([personal]);
    expect(resolveAccountSessionRoute('old', 'dola')).toEqual({ mode: 'direct' });
    expect(resolveAccountSessionRoute('personal-account', 'dola')).toMatchObject({ mode: 'proxy', proxyId: personal });
  });

  it('重启时会把中断中的订阅刷新恢复为待刷新', () => {
    memory.files.set('local-manager.json', {
      version: 1,
      dola: [],
      doubao: [],
      proxies: [],
      subscriptions: [{
        id: 'subscription-personal', label: '个人机场', scope: 'personal', state: 'refreshing',
        nodeCount: 4, supportedNodeCount: 4, unsupportedNodeCount: 0,
        createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
      }],
      bindings: [],
      concurrency: 1,
      routingMode: 'legacy_global',
    });
    expect(listLocalManager().subscriptions.find((entry) => entry.id === 'subscription-personal')?.state).toBe('idle');
  });

  it('个人订阅 URL 加密保存且订阅节点不走固定中转', () => {
    const subscription = addSubscription({ label: '个人机场', url: 'https://sub.example.com/list?token=private' });
    expect(getSubscriptionUrl(subscription.id)).toBe('https://sub.example.com/list?token=private');
    const snapshotText = JSON.stringify(listLocalManager());
    expect(snapshotText).not.toContain('private');
    const [proxy] = replaceSubscriptionProxies(subscription.id, [{
      label: 'airport-node', protocol: 'https', host: 'node.example.com', port: 443, managedByCore: false,
      username: 'user', password: 'pass',
    }]);
    updateProxyCheck(proxy.id, { state: 'valid' });
    bindSession('dola-airport', 'dola', proxy.id);

    expect(resolveAccountSessionRoute('dola-airport', 'dola')).toMatchObject({ mode: 'proxy', proxyId: proxy.id, config: { host: 'node.example.com', port: 443 } });
  });

  it('加密保存核心节点配置且绑定路由不暴露远程凭据', () => {
    const subscription = addSubscription({ label: '核心机场', url: 'https://sub.example.com/core?token=private' });
    const [proxy] = replaceSubscriptionProxies(subscription.id, [{
      label: 'trojan-node', protocol: 'trojan', host: 'node.example.com', port: 443,
      managedByCore: true,
      rawConfig: { name: 'trojan-node', type: 'trojan', server: 'node.example.com', port: 443, password: 'node-secret' },
    }]);
    updateProxyCheck(proxy.id, { state: 'valid' });
    bindSession('dola-core', 'dola', proxy.id);
    expect(getProxyCoreConfig(proxy.id)).toMatchObject({ type: 'trojan', password: 'node-secret' });
    expect(JSON.stringify(listLocalManager())).not.toContain('node-secret');
    expect(resolveAccountSessionRoute('dola-core', 'dola')).toMatchObject({ mode: 'airport_core', proxyId: proxy.id });
  });

  it('keeps unbound Doubao direct and routes a valid bound Dola session through its proxy', () => {
    const proxyId = addUsableProxy('proxy-a');
    bindSession('dola-1', 'dola', proxyId);

    expect(resolveAccountSessionRoute('doubao-1', 'doubao')).toEqual({ mode: 'direct' });
    expect(resolveAccountSessionRoute('dola-1', 'dola')).toMatchObject({ mode: 'proxy', proxyId });
  });

  it('旧中转配置不会覆盖个人 Dola 代理', () => {
    memory.files.set('dola-proxy.json', { enabled: true, protocol: 'https', host: 'api.lalun.cn', port: 18081 });
    const proxyId = addUsableProxy('personal');
    bindSession('dola', 'dola', proxyId);
    expect(resolveAccountSessionRoute('dola', 'dola')).toMatchObject({ mode: 'proxy', config: { host: 'personal.example.com' } });
  });

  it('keeps unbound Dola direct regardless of the legacy routing preference', () => {
    setRoutingMode('bound_only');
    expect(resolveAccountSessionRoute('dola-unbound', 'dola')).toEqual({ mode: 'direct' });
    setRoutingMode('legacy_global');
    expect(resolveAccountSessionRoute('dola-unbound', 'dola')).toEqual({ mode: 'direct' });
  });

  it('uses the selected personal Doubao IP even when the Dola relay is configured', () => {
    initializeLocalManagerDefaults();
    const proxy = addProxy({ label: 'personal', protocol: 'http', host: 'personal.example.com', port: 8080, username: 'user', password: 'private-secret' });
    bindSession('doubao-personal', 'doubao', proxy.id);
    expect(resolveAccountSessionRoute('doubao-personal', 'doubao')).toMatchObject({
      mode: 'proxy', proxyId: proxy.id, config: { host: 'personal.example.com', port: 8080 },
    });
    expect(getBoundProxyCredentials('doubao-personal')).toEqual({ username: 'user', password: 'private-secret' });
    expect(JSON.stringify(listLocalManager())).not.toContain('private-secret');

    setProxyEnabled(proxy.id, false);
    expect(resolveAccountSessionRoute('doubao-personal', 'doubao')).toEqual({ mode: 'direct' });
    expect(getBoundProxyCredentials('doubao-personal')).toBeNull();
  });

  it('uses the local core for authenticated SOCKS5 without exposing credentials to the renderer', () => {
    const proxy = addProxy({ label: 'socks', protocol: 'socks5', host: 'socks.example.com', port: 1080, username: 'user', password: 'socks-secret' });
    bindSession('doubao-socks', 'doubao', proxy.id);
    expect(resolveAccountSessionRoute('doubao-socks', 'doubao')).toEqual({ mode: 'airport_core', proxyId: proxy.id });
    expect(getSessionProxyCoreConfig(proxy.id)).toEqual({ type: 'socks5', server: 'socks.example.com', port: 1080, username: 'user', password: 'socks-secret' });
    expect(JSON.stringify(listLocalManager())).not.toContain('socks-secret');
  });
});
