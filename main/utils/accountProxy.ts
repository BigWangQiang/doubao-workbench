import type {
  AccountProxyConfig,
  AccountProxyInput,
  AccountProxyProtocol,
} from '@doubao-studio/contracts';

const VALID_PROTOCOLS: readonly AccountProxyProtocol[] = ['http', 'https', 'socks5'];

export interface NormalizedProxyInput {
  config?: AccountProxyConfig;
  username?: string;
  password?: string;
  clearCredentials: boolean;
}

/** 代理配置校验结果，拒绝凭据、路径和端口注入。 */
export function normalizeProxyInput(input: AccountProxyInput):
  | { ok: true; value: NormalizedProxyInput }
  | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: '代理配置无效' };
  const clearCredentials = input.clearCredentials === true;
  if (!input.enabled) {
    return { ok: true, value: { clearCredentials: true } };
  }

  const protocol = input.protocol;
  if (!VALID_PROTOCOLS.includes(protocol)) return { ok: false, error: '代理协议必须是 HTTP、HTTPS 或 SOCKS5' };

  const host = typeof input.host === 'string' ? input.host.trim() : '';
  if (!host || host.length > 253 || /[\s/@?#\\]/.test(host)) {
    return { ok: false, error: '代理地址无效，只能填写主机名或 IP 地址' };
  }

  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: '代理端口必须是 1-65535 的整数' };
  }

  const username = typeof input.username === 'string' ? input.username : undefined;
  const password = typeof input.password === 'string' ? input.password : undefined;
  return {
    ok: true,
    value: {
      config: {
        enabled: true,
        protocol,
        host,
        port,
        credentialsConfigured: false,
      },
      username: username || undefined,
      password: password || undefined,
      clearCredentials,
    },
  };
}

/** 生成 Electron session.setProxy 所需的规则，不携带认证信息。 */
export function proxyRules(config: AccountProxyConfig): string {
  return `${config.protocol}://${config.host}:${config.port}`;
}
