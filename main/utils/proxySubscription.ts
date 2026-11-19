import yaml from 'js-yaml';
import type { ProxyPoolProtocol } from '@doubao-studio/contracts';

export const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;
export const MAX_SUBSCRIPTION_NODES = 500;

const URI_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//i;

export interface ProxySubscriptionNode {
  label: string;
  protocol: ProxyPoolProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  managedByCore: boolean;
  /** 只允许进入主进程加密存储，禁止放入 LocalManagerSnapshot。 */
  rawConfig?: Record<string, unknown>;
}

export interface ProxySubscriptionParseResult {
  nodes: ProxySubscriptionNode[];
  unsupportedProtocols: string[];
  format: 'clash' | 'json' | 'base64' | 'uri' | 'unknown';
}

export interface ProxySubscriptionResponse {
  text: string;
  contentType?: string;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function assertHost(host: string): boolean {
  return Boolean(host) && host.length <= 253 && !/[\s/@?#\\]/.test(host);
}

const CORE_PROTOCOLS = new Set<ProxyPoolProtocol>([
  'ss', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls',
]);

export function isCoreManagedProxyProtocol(protocol: ProxyPoolProtocol): boolean {
  return CORE_PROTOCOLS.has(protocol);
}

function normalizeProtocol(value: unknown, tls = false): ProxyPoolProtocol | null {
  const protocol = cleanString(value).toLowerCase();
  if (protocol === 'socks5' || protocol === 'socks5h') return 'socks5';
  if (protocol === 'http') return tls ? 'https' : 'http';
  if (protocol === 'https') return 'https';
  if (protocol === 'hy2') return 'hysteria2';
  if (protocol === 'shadowsocks') return 'ss';
  if (CORE_PROTOCOLS.has(protocol as ProxyPoolProtocol)) return protocol as ProxyPoolProtocol;
  return null;
}

function normalizePort(value: unknown): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function nodeKey(node: ProxySubscriptionNode): string {
  return [
    node.protocol,
    node.host.toLowerCase(),
    node.port,
    node.username || '',
    node.rawConfig ? JSON.stringify(node.rawConfig) : '',
  ].join('|');
}

function cloneCoreConfig(
  raw: Record<string, unknown>,
  protocol: ProxyPoolProtocol,
  label: string,
  host: string,
  port: number,
): Record<string, unknown> | null {
  try {
    const serialized = JSON.stringify(raw);
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > 64 * 1024) return null;
    const cloned = JSON.parse(serialized) as Record<string, unknown>;
    cloned.name = label;
    cloned.type = protocol;
    cloned.server = host;
    cloned.port = port;
    return cloned;
  } catch {
    return null;
  }
}

function nodeFromObject(value: unknown, index: number, unsupported: Set<string>): ProxySubscriptionNode | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const rawProtocol = cleanString(raw.type || raw.protocol).toLowerCase();
  if (!rawProtocol) return null;
  const protocol = normalizeProtocol(rawProtocol, raw.tls === true);
  if (!protocol) {
    unsupported.add(rawProtocol);
    return null;
  }
  const host = cleanString(raw.server || raw.host || raw.address);
  const port = normalizePort(raw.port);
  if (!assertHost(host) || port === null) return null;
  const username = cleanString(raw.username || raw.user) || undefined;
  const password = typeof raw.password === 'string' ? raw.password : undefined;
  const label = cleanString(raw.name || raw.label) || `${protocol.toUpperCase()} ${host}:${port} #${index + 1}`;
  const managedByCore = isCoreManagedProxyProtocol(protocol);
  const rawConfig = managedByCore ? cloneCoreConfig(raw, protocol, label, host, port) : undefined;
  if (managedByCore && !rawConfig) return null;
  return {
    label,
    protocol,
    host,
    port,
    managedByCore,
    ...(managedByCore ? {} : { ...(username ? { username } : {}), ...(password ? { password } : {}) }),
    ...(rawConfig ? { rawConfig } : {}),
  };
}

function decodedBase64(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    return decoded && !/\uFFFD/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function queryBoolean(params: URLSearchParams, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = params.get(key);
    if (value === null) continue;
    return /^(?:1|true|yes)$/i.test(value);
  }
  return undefined;
}

function assignQuery(raw: Record<string, unknown>, params: URLSearchParams, output: string, ...keys: string[]): void {
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null && value !== '') {
      raw[output] = value;
      return;
    }
  }
}

function coreNodeFromStandardUri(value: string, protocol: ProxyPoolProtocol, index: number): ProxySubscriptionNode | null {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname;
    const port = normalizePort(parsed.port);
    if (!assertHost(host) || port === null) return null;
    const label = decodeURIComponent(parsed.hash.replace(/^#/, '')) || `${protocol.toUpperCase()} ${host}:${port} #${index + 1}`;
    const firstCredential = parsed.username ? decodeURIComponent(parsed.username) : '';
    const secondCredential = parsed.password ? decodeURIComponent(parsed.password) : '';
    const raw: Record<string, unknown> = { name: label, type: protocol, server: host, port };

    if (protocol === 'vless') raw.uuid = firstCredential;
    else if (protocol === 'tuic') {
      raw.uuid = firstCredential;
      raw.password = secondCredential;
    } else if (protocol === 'hysteria') raw['auth-str'] = firstCredential || secondCredential;
    else raw.password = firstCredential || secondCredential;

    assignQuery(raw, parsed.searchParams, 'sni', 'sni', 'peer', 'serverName');
    assignQuery(raw, parsed.searchParams, 'servername', 'servername');
    assignQuery(raw, parsed.searchParams, 'network', 'type', 'network');
    assignQuery(raw, parsed.searchParams, 'flow', 'flow');
    assignQuery(raw, parsed.searchParams, 'client-fingerprint', 'fp', 'fingerprint');
    assignQuery(raw, parsed.searchParams, 'obfs', 'obfs');
    assignQuery(raw, parsed.searchParams, 'obfs-password', 'obfs-password', 'obfsParam');
    assignQuery(raw, parsed.searchParams, 'up', 'up', 'upmbps');
    assignQuery(raw, parsed.searchParams, 'down', 'down', 'downmbps');
    assignQuery(raw, parsed.searchParams, 'congestion-controller', 'congestion_control', 'congestion-controller');
    assignQuery(raw, parsed.searchParams, 'udp-relay-mode', 'udp_relay_mode', 'udp-relay-mode');
    const insecure = queryBoolean(parsed.searchParams, 'insecure', 'allowInsecure', 'skip-cert-verify');
    if (insecure !== undefined) raw['skip-cert-verify'] = insecure;
    const security = parsed.searchParams.get('security');
    if (security === 'tls' || security === 'reality') raw.tls = true;
    if (security === 'reality') {
      const reality: Record<string, unknown> = {};
      assignQuery(reality, parsed.searchParams, 'public-key', 'pbk', 'public-key');
      assignQuery(reality, parsed.searchParams, 'short-id', 'sid', 'short-id');
      if (Object.keys(reality).length > 0) raw['reality-opts'] = reality;
    }
    const path = parsed.searchParams.get('path');
    const wsHost = parsed.searchParams.get('host');
    if (raw.network === 'ws' && (path || wsHost)) {
      raw['ws-opts'] = {
        ...(path ? { path } : {}),
        ...(wsHost ? { headers: { Host: wsHost } } : {}),
      };
    }
    const rawConfig = cloneCoreConfig(raw, protocol, label, host, port);
    return rawConfig ? { label, protocol, host, port, managedByCore: true, rawConfig } : null;
  } catch {
    return null;
  }
}

function shadowsocksNodeFromUri(value: string, index: number): ProxySubscriptionNode | null {
  try {
    const withoutScheme = value.slice('ss://'.length);
    const hashIndex = withoutScheme.indexOf('#');
    const label = hashIndex >= 0 ? decodeURIComponent(withoutScheme.slice(hashIndex + 1)) : '';
    const beforeHash = (hashIndex >= 0 ? withoutScheme.slice(0, hashIndex) : withoutScheme).split('?')[0];
    let credentials = '';
    let endpoint = '';
    const atIndex = beforeHash.lastIndexOf('@');
    if (atIndex >= 0) {
      credentials = decodedBase64(beforeHash.slice(0, atIndex)) || decodeURIComponent(beforeHash.slice(0, atIndex));
      endpoint = beforeHash.slice(atIndex + 1);
    } else {
      const decoded = decodedBase64(beforeHash);
      if (!decoded) return null;
      const decodedAt = decoded.lastIndexOf('@');
      if (decodedAt < 0) return null;
      credentials = decoded.slice(0, decodedAt);
      endpoint = decoded.slice(decodedAt + 1);
    }
    const separator = credentials.indexOf(':');
    if (separator <= 0) return null;
    const method = credentials.slice(0, separator);
    const password = credentials.slice(separator + 1);
    const parsedEndpoint = new URL(`http://${endpoint}`);
    const host = parsedEndpoint.hostname;
    const port = normalizePort(parsedEndpoint.port);
    if (!assertHost(host) || port === null || !method || !password) return null;
    const resolvedLabel = label || `SS ${host}:${port} #${index + 1}`;
    const rawConfig = cloneCoreConfig({ cipher: method, password, udp: true }, 'ss', resolvedLabel, host, port);
    return rawConfig ? { label: resolvedLabel, protocol: 'ss', host, port, managedByCore: true, rawConfig } : null;
  } catch {
    return null;
  }
}

function vmessNodeFromUri(value: string, index: number): ProxySubscriptionNode | null {
  const payload = value.slice('vmess://'.length).split('#')[0].trim();
  const decoded = decodedBase64(payload);
  if (!decoded) return null;
  try {
    const source = JSON.parse(decoded) as Record<string, unknown>;
    const host = cleanString(source.add || source.server);
    const port = normalizePort(source.port);
    if (!assertHost(host) || port === null) return null;
    const label = cleanString(source.ps || source.name) || `VMESS ${host}:${port} #${index + 1}`;
    const raw: Record<string, unknown> = {
      uuid: cleanString(source.id),
      alterId: Number(source.aid || 0),
      cipher: cleanString(source.scy) || 'auto',
      udp: true,
    };
    const network = cleanString(source.net);
    if (network) raw.network = network;
    if (cleanString(source.tls)) raw.tls = true;
    const servername = cleanString(source.sni);
    if (servername) raw.servername = servername;
    const wsPath = cleanString(source.path);
    const wsHost = cleanString(source.host);
    if (network === 'ws' && (wsPath || wsHost)) {
      raw['ws-opts'] = {
        ...(wsPath ? { path: wsPath } : {}),
        ...(wsHost ? { headers: { Host: wsHost } } : {}),
      };
    }
    const rawConfig = cloneCoreConfig(raw, 'vmess', label, host, port);
    return rawConfig ? { label, protocol: 'vmess', host, port, managedByCore: true, rawConfig } : null;
  } catch {
    return null;
  }
}

function nodeFromUri(value: string, index: number, unsupported: Set<string>): ProxySubscriptionNode | null {
  const match = value.match(URI_SCHEME_PATTERN);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const protocol = normalizeProtocol(scheme);
  if (!protocol) {
    unsupported.add(scheme);
    return null;
  }
  if (protocol === 'ss') return shadowsocksNodeFromUri(value, index);
  if (protocol === 'vmess') return vmessNodeFromUri(value, index);
  if (isCoreManagedProxyProtocol(protocol)) return coreNodeFromStandardUri(value, protocol, index);
  try {
    const parsed = new URL(value);
    const host = parsed.hostname;
    const port = normalizePort(parsed.port || (protocol === 'socks5' ? 1080 : protocol === 'https' ? 443 : 80));
    if (!assertHost(host) || port === null) return null;
    const label = decodeURIComponent(parsed.hash.replace(/^#/, '')) || `${protocol.toUpperCase()} ${host}:${port} #${index + 1}`;
    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    return { label, protocol, host, port, managedByCore: false, ...(username ? { username } : {}), ...(password ? { password } : {}) };
  } catch {
    return null;
  }
}

function decodeBase64(value: string): string | null {
  const compact = value.replace(/\s+/g, '');
  if (compact.length < 16 || !/^[A-Za-z0-9+/_=-]+$/.test(compact)) return null;
  try {
    const normalized = compact.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(compact.length / 4) * 4, '=');
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    if (!decoded || /\uFFFD/.test(decoded) || !/[\r\n]|:\/\//.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function parseDocument(value: unknown, unsupported: Set<string>): ProxySubscriptionNode[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => nodeFromObject(item, index, unsupported)).filter((item): item is ProxySubscriptionNode => Boolean(item));
  }
  if (!value || typeof value !== 'object') return [];
  const raw = value as Record<string, unknown>;
  const proxies = raw.proxies;
  return Array.isArray(proxies)
    ? proxies.map((item, index) => nodeFromObject(item, index, unsupported)).filter((item): item is ProxySubscriptionNode => Boolean(item))
    : [];
}

function parseUriLines(text: string, unsupported: Set<string>): ProxySubscriptionNode[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line, index) => nodeFromUri(line, index, unsupported))
    .filter((item): item is ProxySubscriptionNode => Boolean(item));
}

function deduplicate(nodes: ProxySubscriptionNode[]): ProxySubscriptionNode[] {
  const seen = new Set<string>();
  const result: ProxySubscriptionNode[] = [];
  for (const node of nodes) {
    const key = nodeKey(node);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(node);
    if (result.length >= MAX_SUBSCRIPTION_NODES) break;
  }
  return result;
}

/** Validate a subscription endpoint without exposing or storing its query token. */
export function normalizeSubscriptionUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('订阅地址必须是文本');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) throw new Error('订阅地址不能为空且不能超过 2048 个字符');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('订阅地址格式无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('订阅地址必须使用 HTTP 或 HTTPS');
  }
  if (parsed.username || parsed.password) throw new Error('订阅地址不能内嵌用户名密码');
  return parsed.toString();
}

/** Return only a safe host preview; query tokens and paths are never returned. */
export function maskSubscriptionUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '地址已隐藏';
  }
}

export function parseProxySubscriptionText(text: string): ProxySubscriptionParseResult {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_SUBSCRIPTION_BYTES) {
    throw new Error(`订阅内容超过 ${Math.floor(MAX_SUBSCRIPTION_BYTES / 1024 / 1024)} MB 限制`);
  }
  const source = text.replace(/^\uFEFF/, '').trim();
  if (!source) throw new Error('订阅内容为空');
  const unsupported = new Set<string>();
  let nodes: ProxySubscriptionNode[] = [];
  let format: ProxySubscriptionParseResult['format'] = 'unknown';

  try {
    const document = yaml.load(source);
    nodes = parseDocument(document, unsupported);
    if (nodes.length > 0 || (document && typeof document === 'object' && Array.isArray((document as Record<string, unknown>).proxies))) {
      format = source.startsWith('{') || source.startsWith('[') ? 'json' : 'clash';
    }
  } catch {
    // URI and Base64 subscriptions are parsed below.
  }

  if (nodes.length === 0) {
    nodes = parseUriLines(source, unsupported);
    if (nodes.length > 0) format = 'uri';
  }
  if (nodes.length === 0) {
    const decoded = decodeBase64(source);
    if (decoded) {
      const nested = parseProxySubscriptionText(decoded);
      nodes = nested.nodes;
      for (const protocol of nested.unsupportedProtocols) unsupported.add(protocol);
      format = 'base64';
    }
  }
  if (nodes.length === 0 && unsupported.size === 0) throw new Error('未识别到可用代理节点');
  return { nodes: deduplicate(nodes), unsupportedProtocols: [...unsupported].sort(), format };
}

export async function fetchProxySubscription(
  url: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProxySubscriptionParseResult> {
  const normalizedUrl = normalizeSubscriptionUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const fetchImpl = options.fetchImpl || fetch;
    const request = (headers: Record<string, string>): Promise<Response> => fetchImpl(normalizedUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers,
    });
    // A number of subscription providers reject generic fetch clients with 406.
    // Identify as a supported Clash client while keeping the URL out of logs/errors.
    let response = await request({
      accept: 'application/yaml, text/yaml, text/plain, application/json, */*',
      'user-agent': 'ClashMeta/1.19.0',
    });
    if (response.status === 406 || response.status === 415) {
      // Some providers key off the legacy client name; retry only for content
      // negotiation failures and reuse the same timeout/abort signal.
      await response.body?.cancel().catch(() => undefined);
      response = await request({
        accept: 'application/yaml, text/yaml, text/plain, */*',
        'user-agent': 'clash-verge-rev/1.7.7',
      });
    }
    if (!response.ok) throw new Error(`订阅服务器返回 HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_SUBSCRIPTION_BYTES) throw new Error('订阅响应超过 2 MB 限制');
    const text = await readBoundedResponseText(response);
    return parseProxySubscriptionText(text);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('订阅请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > MAX_SUBSCRIPTION_BYTES) {
        await reader.cancel();
        throw new Error('订阅响应超过 2 MB 限制');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
