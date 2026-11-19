/**
 * main/main.ts
 * Electron 主进程入口
 *
 * 职责：
 * 1. 创建应用窗口
 * 2. 注册 IPC 通信模块
 * 3. 管理 webview 标签（多账号隔离浏览器）
 * 4. 窗口生命周期管理
 */

import { app, BrowserWindow, screen, session, shell, protocol } from 'electron';
import { ipcMain, isTrustedRendererUrl, trustWorkbenchWindow } from './security/trustedIpc';
import { verifyPinnedUpdate } from './security/updateSignature';
import { registerWorkbenchCanvasIPC } from './ipc/workbenchCanvas';
import { registerStoryboardBatchIPC } from './ipc/storyboardBatch';
import { autoUpdater, NsisUpdater } from 'electron-updater';
import type { IpcMainEvent } from 'electron';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Account } from '@doubao-studio/contracts';
import { registerAccountIPC } from './ipc/accounts';
import {
  createTasksForLocalPlugin,
  getTaskForLalor,
  isLocalMediaFileForPlugin,
  listTaskArtifactFilesForLalor,
  listTasksForLocalControl,
  registerTaskIPC,
} from './ipc/tasks';
import { loadProjects, registerProjectIPC } from './ipc/projects';
import { registerSystemIPC } from './ipc/system';
import { registerZiziPluginIPC } from './ipc/ziziPlugin';
import { registerLocalManagerIPC, restoreLinkedDolaSessions, restoreLinkedDoubaoSessions } from './ipc/localManager';
import { initializeLocalManagerDefaults } from './utils/localManagerStore';
import { stopAllAirportProxyCores } from './utils/airportProxyCore';

import { yuyanAuthHandlers, requireYuyanGenerationAccess } from './ipc/yuyanAuth';
import { registerLalorAuthIPC } from './ipc/lalorAuth';
import { writeCrashLog } from './utils/logger';
import { replaceIpcHandlers } from './ipc/lifecycle';
import { buildDevelopmentLaunchHelpUrl, resolveRendererStartupTarget } from './utils/rendererStartup';
import { ControlCommandBroker } from './control/ControlCommandBroker';
import { LocalControlServer } from './control/LocalControlServer';
import type { ControlCommandResult } from './control/controlTypes';
import { resolveLocalCdpConfig } from './utils/localCdp';
import { resolveLoopbackProxy } from './utils/localProxy';
import {
  archiveRegenerableCacheDirectories,
  getRecoverablePartitions,
  recoverWebviewNetworkCaches,
  WEBVIEW_NETWORK_RECOVERY_VERSION,
} from './utils/webviewNetworkRecovery';
import { getDataDir, readJSON } from './utils/store';
import { registerDolaExtensionNetworkBridge } from './utils/dolaExtensionNetwork';
import { SoftwareUpdater, describeUpdateTaskBlocker, UPDATE_FEED_URL, WORKBENCH_DOWNLOAD_URL } from './services/softwareUpdater';
import { resolveUserDataLocation } from './utils/userDataLocation';
import { publishLocalControlDiscovery } from './utils/localControlDiscovery';
import { registerAccountCanvasParser } from './services/accountCanvasParser';

// ==================== 常量 ====================

const PRELOAD_PATH = path.join(__dirname, 'preload.js');
protocol.registerSchemesAsPrivileged([{ scheme: 'lalor-canvas', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

/** 豆包网页地址 */
const DOUBAO_URL = 'https://www.doubao.com';

// Windows 数据位置必须在 ready/单实例锁之前确定；此时直接使用系统 APPDATA。
if (process.platform === 'win32' && process.env.APPDATA) {
  app.setPath('userData', resolveUserDataLocation(
    process.env.APPDATA,
    app.commandLine.getSwitchValue('user-data-dir') || undefined,
    'D:\\doubao-studio-data\\doubao-studio-desktop',
  ));
}

// 必须在 app ready 前设置 Chromium 开关。默认关闭；地址固定为 IPv4 loopback，
// 不接受远端地址参数。该入口仅用于短时人工验收，用后随应用进程退出。
const localCdp = resolveLocalCdpConfig(app.isPackaged ? [] : process.argv.slice(1));
if (app.isPackaged) {
  for (const flag of ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'inspect', 'inspect-brk']) {
    app.commandLine.removeSwitch(flag);
  }
}
if (localCdp.enabled) {
  app.commandLine.appendSwitch('remote-debugging-address', localCdp.address);
  app.commandLine.appendSwitch('remote-debugging-port', String(localCdp.port));
}

// Windows 上 Chromium 未必继承 shell 代理。仅自动采用无凭据的 loopback
// 代理；若用户显式给出 Chromium 参数，则不覆盖。
const hasExplicitProxy = process.argv.some((arg) => arg.startsWith('--proxy-server='));
const loopbackProxy = hasExplicitProxy ? null : resolveLoopbackProxy(process.env);
if (loopbackProxy) app.commandLine.appendSwitch('proxy-server', loopbackProxy);

// ==================== 全局状态 ====================

let mainWindow: BrowserWindow | null = null;
/** 应用是否正在退出，防止退出过程中创建新窗口或重新调度任务 */
let isQuitting = false;
let unregisterIPC: (() => void) | null = null;
let localControlServer: LocalControlServer | null = null;
let controlBroker: ControlCommandBroker | null = null;
let clearLocalControlDiscovery: (() => void) | null = null;
let unregisterDolaExtensionNetworkBridge: (() => void) | null = null;
let softwareUpdater: SoftwareUpdater | null = null;
let lalorRendererReady = false;
const pendingLalorRendererEvents = new Map<string, 'lalorTasks:available' | 'lalorTasks:cancelled'>();

function notifyRenderer(channel: 'lalorTasks:available' | 'lalorTasks:cancelled', taskId: string): void {
  if (!mainWindow || mainWindow.isDestroyed() || !lalorRendererReady) {
    pendingLalorRendererEvents.set(taskId, channel);
    return;
  }
  mainWindow.webContents.send(channel, taskId);
}

function flushLalorRendererEvents(win: BrowserWindow): void {
  if (win.isDestroyed() || mainWindow !== win) return;
  lalorRendererReady = true;
  for (const [taskId, channel] of pendingLalorRendererEvents) {
    win.webContents.send(channel, taskId);
  }
  pendingLalorRendererEvents.clear();
}


function resolveLocalControlPort(argv: string[]): number | null {
  const enabled = argv.includes('--local-control') || argv.some((arg) => arg.startsWith('--local-control-port='));
  if (!enabled) return null;
  const portArg = argv.find((arg) => arg.startsWith('--local-control-port='));
  if (!portArg) return 0;
  const value = Number(portArg.slice('--local-control-port='.length));
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('本机控制端口无效');
  return value;
}

function writePrivateJson(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

async function startLocalControl(): Promise<void> {
  // 正式版保留本机插件接口，调试控制参数仅在开发环境有效。
  const argv = app.isPackaged ? [] : process.argv.slice(1);
  const requestedControlPort = resolveLocalControlPort(argv);
  // 插件 API 默认启用并只绑定 loopback；旧的 Agent 控制路由仍需显式参数。
  const requestedPort = requestedControlPort ?? 0;
  const enableTaskControls = requestedControlPort !== null;
  const token = randomBytes(32).toString('base64url');
  const startedAtMs = Date.now();
  const expiresAtMs = startedAtMs + 8 * 60 * 60 * 1000;
  const broker = new ControlCommandBroker(() => mainWindow?.webContents || null);
  controlBroker = broker;
  localControlServer = new LocalControlServer({
    token,
    expiresAtMs,
    listProjects: loadProjects,
    listTasks: listTasksForLocalControl,
    isRendererReady: () => broker.isReady(),
    enableTaskControls,
    listPluginAccounts: () => readJSON<Account[]>('accounts.json', []),
    createPluginTasks: createTasksForLocalPlugin,
    authorizePluginTasks: async (): Promise<void> => { await requireYuyanGenerationAccess(); },
    getPluginTask: getTaskForLalor,
    listPluginArtifactFiles: listTaskArtifactFilesForLalor,
    isLocalMediaFile: isLocalMediaFileForPlugin,
    notifyPluginTaskAvailable: (taskId) => notifyRenderer('lalorTasks:available', taskId),
    dispatch: (command) => broker.dispatch(command),
  });
  const port = await localControlServer.start(requestedPort);
  clearLocalControlDiscovery = publishLocalControlDiscovery(app.getPath('userData'), app.getPath('appData'), token, {
    protocolVersion: 'v1',
    address: '127.0.0.1',
    port,
    pid: process.pid,
    tokenFile: 'control-token',
    startedAt: new Date(startedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
  console.log(`[Control] 本机受控接口已启动 127.0.0.1:${port}（认证令牌未写入日志）`);
}

async function stopLocalControl(): Promise<void> {
  controlBroker?.close();
  controlBroker = null;
  const server = localControlServer;
  localControlServer = null;
  if (server) await server.stop().catch(() => undefined);
  clearLocalControlDiscovery?.();
  clearLocalControlDiscovery = null;
}

async function runOneTimeWebviewNetworkRecovery(): Promise<void> {
  const marker = readJSON<{ version?: string }>('webview-network-recovery.json', {});
  if (marker.version === WEBVIEW_NETWORK_RECOVERY_VERSION) return;

  const accounts = readJSON<Array<{ partition?: unknown; platform?: unknown }>>('accounts.json', []);
  const partitions = getRecoverablePartitions(accounts);
  const suffix = `2.3.4-${Date.now()}`;
  let archivedCacheDirectories = 0;
  for (const partition of partitions) {
    const diskName = partition.slice('persist:'.length);
    const partitionDirectory = path.join(app.getPath('userData'), 'Partitions', diskName);
    archivedCacheDirectories += archiveRegenerableCacheDirectories(partitionDirectory, suffix).length;
  }
  const recovered = await recoverWebviewNetworkCaches(
    partitions,
    (partition) => session.fromPartition(partition),
  );
  writePrivateJson(path.join(getDataDir(), 'webview-network-recovery.json'), {
    version: WEBVIEW_NETWORK_RECOVERY_VERSION,
    recoveredPartitions: recovered,
    archivedCacheDirectories,
    completedAt: new Date().toISOString(),
  });
  console.log(`[Network] 2.3.4 Webview 网络缓存自愈完成（${recovered} 个分区，登录存储未清理）`);
}

// ==================== 窗口创建 ====================

function createMainWindow(): BrowserWindow {
  lalorRendererReady = false;
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1600, workArea.width),
    height: Math.min(900, workArea.height),
    minWidth: Math.min(1260, workArea.width),
    minHeight: Math.min(720, workArea.height),
    // 固定还原窗口的尺寸，保留最小化/最大化；禁止拖拽外框压缩平台控件。
    // 小屏由渲染层切换覆盖式账号列表，不能把浏览器挤出可视区域。
    resizable: false,
    minimizable: true,
    maximizable: true,
    title: '屿砚工作台',
    backgroundColor: '#0f0f14',
    show: false, // 等待 ready-to-show 后再显示，避免白屏闪烁
    frame: false, // 无边框窗口（自定义标题栏）
    titleBarStyle: 'hidden', // macOS 隐藏原生标题栏
    webPreferences: {
      preload: PRELOAD_PATH,
      // 开启 webview 标签支持
      webviewTag: true,
      // 任务执行依赖页面定时器、轮询和网络监听；窗口最小化时也必须保持实时。
      // 关闭窗口仍会按下方生命周期逻辑退出应用，不会把退出误当成后台运行。
      backgroundThrottling: false,
      // 安全策略
      nodeIntegration: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
      sandbox: false, // 需要 preload 访问 Node API
    },
  });

  trustWorkbenchWindow(win);
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    // 平台网页没有工作台 preload 权限，也不能自行要求 Node 集成。
    let host = '';
    try { const url = new URL(params.src); if (url.protocol === 'https:') host = url.hostname; } catch { /* 拒绝无效地址 */ }
    const platformHost = ['doubao.com', 'dola.com', 'ciciai.com'].some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (!platformHost || !/^persist:(doubao|dola)_/.test(params.partition || '')) { event.preventDefault(); return; }
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.devTools = !app.isPackaged;
  });
  registerAccountCanvasParser(win.webContents, path.join(__dirname, 'services', 'storyboardParserPreload.js'));

  // 窗口准备好后显示
  win.once('ready-to-show', () => {
    win.show();
  });
  const handleLalorRendererReady = (event: IpcMainEvent): void => {
    if (event.sender !== win.webContents) return;
    flushLalorRendererEvents(win);
  };
  ipcMain.on('lalorTasks:renderer-ready', handleLalorRendererReady);
  win.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame && mainWindow === win) lalorRendererReady = false;
  });
  win.webContents.on('did-finish-load', () => flushLalorRendererEvents(win));
  // BrowserPanel 使用 <webview> 承载每个账号的独立会话；主窗口最小化后，
  // guest WebContents 默认仍可能节流定时器。对每个 guest 显式关闭节流，
  // 让提交前控件检测、生成轮询和扩展回传在后台保持同样的时间基准。
  win.webContents.on('did-attach-webview', (_event, guestWebContents) => {
    guestWebContents.setBackgroundThrottling(false);
  });

  // 加载前端页面。源码开发版缺少 dev server 注入时显示诊断页，禁止静默黑屏。
  const rendererTarget = resolveRendererStartupTarget(app.isPackaged, process.env.VITE_DEV_SERVER_URL, __dirname);
  const rendererLoad = rendererTarget.kind === 'file'
    ? win.loadFile(rendererTarget.value)
    : win.loadURL(rendererTarget.value);
  void rendererLoad.catch((error: Error) => {
    writeCrashLog('rendererLoadFailure', error.message, error.stack);
    if (!win.isDestroyed()) void win.loadURL(buildDevelopmentLaunchHelpUrl());
  });

  // 在默认浏览器中打开外部链接
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new URL(url).protocol === 'https:') void shell.openExternal(url); } catch { /* 忽略无效外链 */ }
    return { action: 'deny' };
  });

  win.on('closed', () => {
    ipcMain.removeListener('lalorTasks:renderer-ready', handleLalorRendererReady);
    if (mainWindow === win) {
      lalorRendererReady = false;
      mainWindow = null;
    }
  });

  return win;
}

// ==================== IPC 注册 ====================

function registerIPC(): void {
  unregisterIPC?.();
  // 注册业务模块 IPC
  const disposers = [
    registerAccountIPC(),
    registerProjectIPC(),
    registerTaskIPC(),
    registerWorkbenchCanvasIPC(),
    registerStoryboardBatchIPC(),
    registerSystemIPC(),
    registerZiziPluginIPC(() => clearLocalControlDiscovery ? localControlServer?.getPluginConnectionState() || 'unavailable' : 'unavailable'),
    registerLocalManagerIPC(),
    registerLalorAuthIPC(yuyanAuthHandlers),
  ];

  disposers.push(replaceIpcHandlers(ipcMain, ['system:getVersion', 'system:checkUpdate', 'softwareUpdate:status', 'softwareUpdate:check', 'softwareUpdate:download', 'softwareUpdate:install']));

  const requireUpdater = (event: Electron.IpcMainInvokeEvent): SoftwareUpdater => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !softwareUpdater) {
      throw new Error('更新入口只允许工作台主窗口使用');
    }
    return softwareUpdater;
  };
  ipcMain.handle('softwareUpdate:status', (event) => requireUpdater(event).getState());
  ipcMain.handle('softwareUpdate:check', (event) => requireUpdater(event).check());
  ipcMain.handle('softwareUpdate:download', (event) => requireUpdater(event).download());
  ipcMain.handle('softwareUpdate:install', (event) => requireUpdater(event).install());
  ipcMain.handle('system:checkUpdate', async (event) => {
    const result = await requireUpdater(event).check();
    return { success: result.success, currentVersion: result.state.currentVersion, latestVersion: result.state.latestVersion,
      hasUpdate: ['available', 'downloading', 'ready'].includes(result.state.phase), url: WORKBENCH_DOWNLOAD_URL, name: result.state.message, error: result.error };
  });

  // ---- 系统级 IPC ----

  // 获取应用版本
  ipcMain.handle('system:getVersion', () => {
    return app.getVersion();
  });

  // 窗口控制
  const minimizeWindow = (): void => {
    mainWindow?.minimize();
  };

  const toggleMaximizeWindow = (): void => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  };

  const closeWindow = (): void => {
    mainWindow?.close();
  };

  ipcMain.on('window:minimize', minimizeWindow);
  ipcMain.on('window:toggleMaximize', toggleMaximizeWindow);
  ipcMain.on('window:close', closeWindow);

  const completeControlCommand = (event: Electron.IpcMainEvent, result: ControlCommandResult): void => {
    controlBroker?.complete(event.sender, result);
  };
  const markControlReady = (event: Electron.IpcMainEvent): void => {
    controlBroker?.markReady(event.sender);
  };
  ipcMain.on('control:result', completeControlCommand);
  ipcMain.on('control:ready', markControlReady);

  unregisterIPC = () => {
    for (const dispose of disposers.reverse()) dispose();
    ipcMain.removeListener('window:minimize', minimizeWindow);
    ipcMain.removeListener('window:toggleMaximize', toggleMaximizeWindow);
    ipcMain.removeListener('window:close', closeWindow);
    ipcMain.removeListener('control:result', completeControlCommand);
    ipcMain.removeListener('control:ready', markControlReady);
    unregisterIPC = null;
  };

  console.log('[Main] IPC 模块全部注册完成');
}

// ==================== 单实例锁 ====================

/**
 * 防止两个实例同时写数据。
 * requestSingleInstanceLock 返回 false 时说明已有实例在运行，当前进程应立即退出。
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例运行，直接退出当前进程
  app.quit();
} else {
  // 第二实例启动时，聚焦并恢复已有主窗口
  app.on('second-instance', () => {
    if (isQuitting) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 窗口最小化时恢复
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
    }
  });

  // ==================== 全局异常兜底 ====================

  /**
   * 未捕获的同步异常。
   * 记录日志后退出，避免进程处于不确定状态。
   * 不吞掉致命错误——记录后以非零码退出。
   */
  process.on('uncaughtException', (err: Error) => {
    writeCrashLog('uncaughtException', err.message, err.stack);
    // 给日志写入一点时间后退出
    setImmediate(() => {
      process.exit(1);
    });
  });

  /**
   * 未处理的 Promise 拒绝。
   * 记录日志但不自动退出，因为某些拒绝可能是非致命的（如网络超时）。
   * 开发者可通过日志定位并决定是否需要修复。
   */
  process.on('unhandledRejection', (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    writeCrashLog('unhandledRejection', message, stack);
  });

  // ==================== 应用生命周期 ====================

  app.whenReady().then(async () => {
    if (localCdp.enabled) {
      console.log(`[CDP] 本机验收入口已开启 ${localCdp.address}:${localCdp.port}`);
    }
    await runOneTimeWebviewNetworkRecovery();
    // 停用已退役的共享中转配置；个人代理、账号和任务保持原数据。
    initializeLocalManagerDefaults();
    // 注册 IPC
    registerIPC();

    // Electron 扩展侧不提供 chrome.debugger，改由主进程接管内置 webview 的 Fetch 域。
    unregisterDolaExtensionNetworkBridge = registerDolaExtensionNetworkBridge();

    // 在创建首个 WebView 前恢复已关联的 Dola CK；失败项只保留诊断，
    // 不阻断应用启动，后续仍可在本地管理器中手动重登。
    const dolaRestore = await restoreLinkedDolaSessions();
    if (dolaRestore.attempted > 0) {
      console.log(
        `[Startup] Dola CK 会话恢复完成: attempted=${dolaRestore.attempted}, ` +
          `restored=${dolaRestore.restored}, skipped=${dolaRestore.skipped}, failed=${dolaRestore.failed}`,
      );
    }
    const doubaoRestore = await restoreLinkedDoubaoSessions();
    if (doubaoRestore.attempted > 0) {
      console.log(
        `[Startup] 豆包 CK 会话恢复完成: attempted=${doubaoRestore.attempted}, ` +
          `restored=${doubaoRestore.restored}, skipped=${doubaoRestore.skipped}, failed=${doubaoRestore.failed}`,
      );
    }

    // 创建主窗口
    mainWindow = createMainWindow();
    autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URL, useMultipleRangeRequest: false });
    autoUpdater.requestHeaders = { 'Cache-Control': 'no-cache' };
    autoUpdater.disableWebInstaller = true;
    // 无 Windows 证书时仍校验独立发布私钥签发的安装包摘要。
    if (autoUpdater instanceof NsisUpdater) autoUpdater.verifyUpdateCodeSignature = verifyPinnedUpdate;
    softwareUpdater = new SoftwareUpdater({
      driver: autoUpdater,
      currentVersion: app.getVersion(),
      prepareInstall: (): void => {},
      supported: app.isPackaged && process.platform === 'win32',
      notify: (state): void => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('softwareUpdate:state', state);
      },
      getInstallBlocker: (): string | null => {
        const taskBlocker = describeUpdateTaskBlocker(listTasksForLocalControl(), loadProjects());
        if (taskBlocker) return taskBlocker;
        const downloads = readJSON<Array<{ status: string }>>('downloads.json', []);
        if (downloads.some((job) => ['queued', 'downloading'].includes(job.status))) return '产物正在下载，请等待完成后再安装。';
        return null;
      },
    });
    softwareUpdater.start();
    mainWindow.webContents.on('did-start-loading', () => controlBroker?.markUnavailable());
    mainWindow.webContents.on('render-process-gone', () => controlBroker?.markUnavailable());
    await startLocalControl();

    // macOS: 点击 Dock 图标时重新创建窗口
    // 退出过程中不创建新窗口
    app.on('activate', () => {
      if (isQuitting) return;
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  }).catch((reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    writeCrashLog('startupFailure', error.message, error.stack);
    app.exit(1);
  });

  // 所有窗口关闭时退出应用（macOS 除外）
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // 应用退出前清理：标记退出状态，防止退出过程中创建新窗口
  app.on('before-quit', () => {
    isQuitting = true;
    stopAllAirportProxyCores();
    softwareUpdater?.dispose();
    unregisterIPC?.();
    unregisterDolaExtensionNetworkBridge?.();
    unregisterDolaExtensionNetworkBridge = null;
    pendingLalorRendererEvents.clear();
    lalorRendererReady = false;
    void stopLocalControl();
    mainWindow = null;
  });
}
