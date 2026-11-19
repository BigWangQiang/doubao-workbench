import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createConnection, createServer } from 'node:net';
import yaml from 'js-yaml';
import type { AccountProxyConfig } from '@doubao-studio/contracts';

/** 本机入口只允许 loopback；远程机场配置永远不会交给 Electron。 */
export interface AirportProxyEndpoint extends AccountProxyConfig {
  protocol: 'http';
  host: '127.0.0.1';
}

interface CoreInstance {
  key: string;
  endpoint: AirportProxyEndpoint;
  process: ChildProcess;
  runtimeDir: string;
  configPath: string;
  configSignature: string;
  stopping: boolean;
}

const CORE_BINARY_NAME = process.platform === 'win32' ? 'network-core.exe' : 'network-core';
const CORE_START_TIMEOUT_MS = 12_000;
const CORE_POLL_INTERVAL_MS = 100;
const runtimeInstances = new Map<string, CoreInstance>();
const pendingStarts = new Map<string, Promise<CoreInstance>>();
const activeInstances = new Set<CoreInstance>();
let shutdownRequested = false;

function getTempRoot(): string {
  try {
    return path.join(app.getPath('temp'), 'lalor-network-core');
  } catch {
    return path.resolve(process.cwd(), '.tmp', 'lalor-network-core');
  }
}

export function resolveAirportProxyCorePath(): string {
  const candidates = typeof app !== 'undefined' && app.isPackaged
    ? [path.join(process.resourcesPath, 'network-core', CORE_BINARY_NAME)]
    : [
      path.resolve(process.cwd(), 'vendor', 'network-core', CORE_BINARY_NAME),
      path.resolve(__dirname, '..', '..', '..', 'vendor', 'network-core', CORE_BINARY_NAME),
      path.resolve(__dirname, '..', '..', 'vendor', 'network-core', CORE_BINARY_NAME),
    ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  return resolved || candidates[0];
}

export function isAirportProxyCoreAvailable(): boolean {
  return fs.existsSync(resolveAirportProxyCorePath());
}

function configSignature(config: Record<string, unknown>): string {
  return JSON.stringify(config);
}

function endpointForPort(port: number): AirportProxyEndpoint {
  return {
    enabled: true,
    protocol: 'http',
    host: '127.0.0.1',
    port,
    credentialsConfigured: false,
  };
}

/** 生成最小、无远程监听的 Mihomo 配置。 */
export function buildAirportProxyCoreConfig(
  rawProxyConfig: Record<string, unknown>,
  port: number,
): Record<string, unknown> {
  const proxyName = 'lalor-airport-node';
  const proxy = {
    ...rawProxyConfig,
    name: proxyName,
  };
  return {
    'mixed-port': port,
    'socks-port': 0,
    'redir-port': 0,
    'tproxy-port': 0,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': 'silent',
    ipv6: false,
    'unified-delay': true,
    'tcp-concurrent': true,
    'find-process-mode': 'off',
    profile: { 'store-selected': false, 'store-fake-ip': false },
    proxies: [proxy],
    'proxy-groups': [{ name: 'lalor-airport', type: 'select', proxies: [proxyName] }],
    rules: ['MATCH,lalor-airport'],
  };
}

function safeRuntimeDirectory(directory: string): boolean {
  const root = path.resolve(getTempRoot()).toLowerCase();
  const target = path.resolve(directory).toLowerCase();
  return target.startsWith(`${root}${path.sep}`) && target !== root;
}

function removeRuntimeDirectory(directory: string): void {
  if (!safeRuntimeDirectory(directory)) return;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不应阻断应用退出；下次启动会使用新目录。
  }
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('无法分配本机代理端口'));
        else resolve(port);
      });
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(400, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForPort(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
  getSpawnError?: () => Error | null,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (getSpawnError?.()) throw new Error('机场网络核心启动失败');
    if (child.exitCode !== null || child.killed) throw new Error('机场网络核心启动失败');
    if (await canConnect(port)) return;
    await sleep(CORE_POLL_INTERVAL_MS);
  }
  throw new Error('机场网络核心启动超时');
}

async function startInstance(key: string, rawProxyConfig: Record<string, unknown>): Promise<CoreInstance> {
  if (shutdownRequested) throw new Error('机场网络核心正在退出');
  const binary = resolveAirportProxyCorePath();
  if (!fs.existsSync(binary)) throw new Error('内置机场网络核心缺失，请重新安装工作台');
  const port = await allocatePort();
  const runtimeDir = path.join(getTempRoot(), `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${randomUUID()}`);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const configPath = path.join(runtimeDir, 'config.yaml');
  const config = buildAirportProxyCoreConfig(rawProxyConfig, port);
  fs.writeFileSync(configPath, yaml.dump(config, { noRefs: true, lineWidth: 120 }), { encoding: 'utf8', mode: 0o600 });

  const child = spawn(binary, ['-d', runtimeDir, '-f', configPath], {
    cwd: runtimeDir,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.resume();
  let spawnError: Error | null = null;
  child.once('error', (error) => { spawnError = error; });
  const instance: CoreInstance = {
    key,
    endpoint: endpointForPort(port),
    process: child,
    runtimeDir,
    configPath,
    configSignature: configSignature(rawProxyConfig),
    stopping: false,
  };
  activeInstances.add(instance);
  child.once('exit', () => {
    if (runtimeInstances.get(key)?.process === child) runtimeInstances.delete(key);
    activeInstances.delete(instance);
    removeRuntimeDirectory(runtimeDir);
  });
  try {
    if (spawnError) throw new Error('机场网络核心启动失败');
    await waitForPort(child, port, CORE_START_TIMEOUT_MS, () => spawnError);
    // Mihomo 已经加载配置后不再需要明文文件；只保留内存中的受保护配置。
    try { fs.rmSync(configPath, { force: true }); } catch { /* 退出时再次清理 */ }
    return instance;
  } catch (error: unknown) {
    instance.stopping = true;
    activeInstances.delete(instance);
    child.kill();
    removeRuntimeDirectory(runtimeDir);
    throw error;
  }
}

async function stopInstance(instance: CoreInstance): Promise<void> {
  instance.stopping = true;
  activeInstances.delete(instance);
  if (!instance.process.killed && instance.process.exitCode === null) {
    try { instance.process.kill(); } catch { /* 进程可能已经退出 */ }
  }
  removeRuntimeDirectory(instance.runtimeDir);
}

/** 为绑定的 Dola 窗口启动或复用一个机场核心入口。 */
export async function ensureAirportProxyCore(
  proxyId: string,
  rawProxyConfig: Record<string, unknown>,
): Promise<AirportProxyEndpoint> {
  if (shutdownRequested) throw new Error('机场网络核心正在退出');
  const signature = configSignature(rawProxyConfig);
  const existing = runtimeInstances.get(proxyId);
  if (existing && existing.configSignature === signature && existing.process.exitCode === null) return existing.endpoint;
  if (existing) {
    await stopInstance(existing);
    runtimeInstances.delete(proxyId);
  }
  const pending = pendingStarts.get(proxyId);
  if (pending) return (await pending).endpoint;
  const start = startInstance(proxyId, rawProxyConfig).then((instance) => {
    runtimeInstances.set(proxyId, instance);
    return instance;
  });
  pendingStarts.set(proxyId, start);
  try {
    return (await start).endpoint;
  } finally {
    if (pendingStarts.get(proxyId) === start) pendingStarts.delete(proxyId);
  }
}

/** 节点检测使用临时核心，检测结束后立即释放进程和临时目录。 */
export async function withTemporaryAirportProxy<T>(
  rawProxyConfig: Record<string, unknown>,
  callback: (endpoint: AirportProxyEndpoint) => Promise<T>,
): Promise<T> {
  const key = `probe-${randomUUID()}`;
  const instance = await startInstance(key, rawProxyConfig);
  try {
    return await callback(instance.endpoint);
  } finally {
    await stopInstance(instance);
  }
}

export async function stopAirportProxyCore(proxyId: string): Promise<void> {
  const instance = runtimeInstances.get(proxyId);
  if (!instance) return;
  runtimeInstances.delete(proxyId);
  await stopInstance(instance);
}

/** 应用退出时同步触发所有核心停止；子进程不会在工作台关闭后遗留。 */
export function stopAllAirportProxyCores(): void {
  shutdownRequested = true;
  for (const instance of activeInstances) {
    if (runtimeInstances.get(instance.key)?.process === instance.process) runtimeInstances.delete(instance.key);
    activeInstances.delete(instance);
    instance.stopping = true;
    try {
      if (!instance.process.killed && instance.process.exitCode === null) instance.process.kill();
    } catch {
      // 退出阶段忽略已消失的进程。
    }
    removeRuntimeDirectory(instance.runtimeDir);
  }
}
