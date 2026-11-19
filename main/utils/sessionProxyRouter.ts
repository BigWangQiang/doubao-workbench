import type { AccountPlatform, AccountProxyConfig } from '@doubao-studio/contracts';
import {
  getBinding,
  getDolaRelayConfig,
  getProxyEntry,
  getProxySecret,
  getRoutingMode,
  getProxyCoreConfig,
} from './localManagerStore';
import { ensureAirportProxyCore } from './airportProxyCore';
import { isCoreManagedProxyProtocol } from './proxySubscription';

export interface SessionRoute {
  mode: 'direct' | 'proxy' | 'relay' | 'airport_core' | 'legacy_global';
  proxyId?: string;
  config?: AccountProxyConfig;
}

export function resolveAccountSessionRoute(accountId: string, platform: AccountPlatform): SessionRoute {
  const binding = getBinding(accountId);
  if (binding?.proxyId && binding.platform === platform) {
    const proxy = getProxyEntry(binding.proxyId);
    if (proxy && proxy.enabled !== false && proxy.state !== 'invalid') {
      const relay = getDolaRelayConfig();
      // 豆包个人 IP 必须使用所选代理；只有平台共享 IP 需要服务端保管的中转认证。
      if (relay && proxy.routeThroughRelay !== false && (platform === 'dola' || proxy.isBuiltin)) {
        return {
          mode: 'relay',
          proxyId: proxy.id,
          config: relay,
        };
      }
      if (proxy.managedByCore || isCoreManagedProxyProtocol(proxy.protocol)
        || (proxy.protocol === 'socks5' && proxy.credentialsConfigured)) {
        return { mode: 'airport_core', proxyId: proxy.id };
      }
      return {
        mode: 'proxy',
        proxyId: proxy.id,
        config: {
          enabled: true,
          protocol: proxy.protocol as AccountProxyConfig['protocol'],
          host: proxy.host,
          port: proxy.port,
          credentialsConfigured: proxy.credentialsConfigured,
        },
      };
    }
  }
  // 两个平台未绑定时均直连；旧 routingMode 不改变窗口级绑定行为。
  void getRoutingMode();
  return { mode: 'direct' };
}

/** 将同步路由决策物化为 Electron 可用的本机入口。 */
export async function resolveAccountSessionRouteAsync(
  accountId: string,
  platform: AccountPlatform,
): Promise<{ route: SessionRoute; config?: AccountProxyConfig }> {
  const route = resolveAccountSessionRoute(accountId, platform);
  if (route.mode !== 'airport_core' || !route.proxyId) return { route, config: route.config };
  const coreConfig = getSessionProxyCoreConfig(route.proxyId);
  if (!coreConfig) throw new Error('机场节点配置缺失或已失效，请刷新订阅后重试');
  const config = await ensureAirportProxyCore(route.proxyId, coreConfig);
  return { route, config };
}

/** Chromium 不支持 SOCKS5 用户密码认证，交给现有本机网络核心处理。 */
export function getSessionProxyCoreConfig(proxyId: string): Record<string, unknown> | null {
  const storedConfig = getProxyCoreConfig(proxyId);
  if (storedConfig) return storedConfig;
  const proxy = getProxyEntry(proxyId);
  const secret = getProxySecret(proxyId);
  if (proxy?.protocol !== 'socks5' || !secret?.username || !secret.password) return null;
  return { type: 'socks5', server: proxy.host, port: proxy.port, username: secret.username, password: secret.password };
}

export function getBoundProxyCredentials(accountId: string): { username: string; password: string } | null {
  const binding = getBinding(accountId);
  if (!binding?.proxyId) return null;
  const proxy = getProxyEntry(binding.proxyId);
  if (!proxy || proxy.enabled === false || proxy.state === 'invalid') return null;
  const secret = getProxySecret(binding.proxyId);
  if (!secret?.username || !secret.password) return null;
  return { username: secret.username, password: secret.password };
}
