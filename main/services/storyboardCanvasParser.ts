import { app, type WebContents } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { canvasParserCanvasProbeScript, canvasParserSnapshotScript } from './canvasParserSnapshot';
import {
  extractDoubaoFallbackApis, extractDoubaoMediaVid, fetchDoubaoFallbackJson,
  resolveDoubaoFallbackVideoItems, shouldCaptureDoubaoCanvasResponse,
} from '../utils/dolaExtensionNetwork';

interface ParserResult { url: string; size: number; expires: number; error?: string }
interface CanvasSnapshot { canvasId: string; items: unknown[] }
const CHANNEL = 'storyboard-parser:message';
const installedContents = new WeakSet<WebContents>();

export function isParserApiUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && url.port === ''
      && ['doubao.com', 'snssdk.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

export function isDoubaoParserPage(raw: string): boolean {
  if (!isParserApiUrl(raw)) return false;
  const host = new URL(raw).hostname;
  return host === 'doubao.com' || host.endsWith('.doubao.com');
}

/** 缓存候选必须匹配当前画布节点的 vid，不能把前一个画布的片子混入面板。 */
export function parserApisForItems(items: unknown[], captured: ReadonlyMap<string, string>): string[] {
  const result = new Map<string, string>();
  for (const item of items) {
    const raw = JSON.stringify(item);
    for (const api of extractDoubaoFallbackApis(item, raw)) {
      if (isParserApiUrl(api)) result.set(extractDoubaoMediaVid({ fallback_api: api }) || api, api);
    }
    const vid = extractDoubaoMediaVid(item, raw);
    const api = vid && captured.get(vid);
    if (vid && api && isParserApiUrl(api)) result.set(vid, api);
  }
  return [...result.values()];
}

function parserUiSource(): string {
  const roots = [path.join(process.resourcesPath, 'extensions', 'doubao-canvas-parser'), path.join(app.getAppPath(), 'extensions', 'doubao-canvas-parser')];
  const root = roots.find(candidate => fs.existsSync(path.join(candidate, 'content.js')));
  if (!root) throw new Error('未找到豆包画布视频解析器 1.0.1 文件，请重新安装工作台');
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'panel.css'), 'utf8');
  return `(() => {
    if (window.__doubaoCanvasParser && document.getElementById('dcp-fab') && document.getElementById('dcp-toast')) return true;
    ${parserUiCleanupSource()};
    const transport = globalThis.__lalorCanvasParserTransport;
    if (!transport) throw Error('画布解析器桌面连接未加载，请重开画布窗口');
    const chrome = { runtime: { sendMessage: transport.send, onMessage: { addListener: transport.listen, removeListener: transport.unlisten } } };
    const style = document.createElement('style'); style.id = 'dcp-style'; style.textContent = ${JSON.stringify(css)}; document.documentElement.appendChild(style);
    ${content}
    const button = document.getElementById('dcp-fab');
    button.setAttribute('role', 'button'); button.tabIndex = 0;
    button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.click(); } });
    return Boolean(button && document.getElementById('dcp-toast'));
  })()`;
}

function parserUiCleanupSource(): string {
  return `(() => {
    try { window.__doubaoCanvasParserCleanup?.(); } catch {}
    document.getElementById('dcp-fab')?.remove();
    document.getElementById('dcp-toast')?.remove();
    document.getElementById('dcp-panel')?.remove();
    document.getElementById('dcp-load-error')?.remove();
    document.getElementById('dcp-style')?.remove();
    window.__doubaoCanvasParser = false;
    delete window.__doubaoCanvasParserCleanup;
    return true;
  })()`;
}

/** 保留用户扩展原 UI；Electron 原生桥接替代不支持的 chrome.debugger/downloads。 */
export async function installStoryboardCanvasParser(contents: WebContents, getCanvasId?: () => string | undefined): Promise<void> {
  if (installedContents.has(contents)) return;
  const source = parserUiSource();
  const captured = new Map<string, string>();
  const pending = new Set<string>();
  const downloads = new Map<string, string>();
  const downloadSession = contents.session;
  // destroyed 事件里不能再次读取 contents.debugger，原生对象此时已释放。
  const networkDebugger = contents.debugger;
  let downloadCanvasId: string | undefined;
  let epoch = 0, parsing = false;
  let visibleCanvasId: string | undefined;
  let uiMounted = false, uiNeedsReset = true, syncingUi = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = (message: unknown): void => { if (!contents.isDestroyed()) contents.send(CHANNEL, message); };
  const status = (text: string): void => notify({ type: 'STATUS', text });
  const canvasProbe = async (): Promise<string | undefined> => {
    if (contents.isDestroyed() || !isDoubaoParserPage(contents.getURL())) return undefined;
    try {
      const result: unknown = await contents.executeJavaScript(canvasParserCanvasProbeScript(getCanvasId?.()));
      if (!result || typeof result !== 'object') return undefined;
      const probe = result as { isCanvas?: unknown; canvasId?: unknown };
      return probe.isCanvas === true && typeof probe.canvasId === 'string' && probe.canvasId ? probe.canvasId : undefined;
    } catch { return undefined; }
  };
  const cleanup = async (): Promise<void> => {
    if (contents.isDestroyed()) return;
    await contents.executeJavaScriptInIsolatedWorld(999, [{ code: parserUiCleanupSource() }]).catch((): void => {});
  };
  const snapshot = async (): Promise<CanvasSnapshot> => {
    const canvasId = getCanvasId?.();
    if (!isDoubaoParserPage(contents.getURL())) throw new Error('请先打开豆包画布');
    if (getCanvasId && !canvasId) throw new Error('请先打开本批次原画布');
    return contents.executeJavaScript(canvasParserSnapshotScript(canvasId)) as Promise<CanvasSnapshot>;
  };
  const inject = async (): Promise<void> => {
    if (syncingUi || contents.isDestroyed() || !isDoubaoParserPage(contents.getURL())) return;
    syncingUi = true;
    let currentEpoch = epoch;
    try {
      const canvasId = await canvasProbe();
      if (contents.isDestroyed() || currentEpoch !== epoch) return;
      if (canvasId !== visibleCanvasId) {
        // 同页展开、收起和切换画布也要撤销旧下载授权，不能只依赖导航事件。
        visibleCanvasId = canvasId;
        currentEpoch = ++epoch;
        downloads.clear(); downloadCanvasId = undefined;
        uiNeedsReset = true;
      }
      if (uiNeedsReset) {
        await cleanup();
        if (contents.isDestroyed() || currentEpoch !== epoch) return;
        uiNeedsReset = false; uiMounted = false;
      }
      if (!canvasId || uiMounted) return;
      const loaded = await contents.executeJavaScriptInIsolatedWorld(999, [{ code: source }]);
      if (contents.isDestroyed() || currentEpoch !== epoch) return;
      if (loaded !== true) throw new Error('解析器按钮未挂载');
      uiMounted = true;
    } catch {
      // 不静默留一个无效入口；加载失败在窗口内显示可操作的反馈。
      if (!contents.isDestroyed() && currentEpoch === epoch && visibleCanvasId) await contents.executeJavaScript(`(() => { let el = document.getElementById('dcp-load-error'); if (!el) { el = document.createElement('div'); el.id = 'dcp-load-error'; el.style.cssText = 'position:fixed;right:24px;bottom:88px;z-index:2147483600;background:white;color:#b42318;padding:12px;border:1px solid #b42318;border-radius:8px'; document.documentElement.appendChild(el); } el.textContent = '画布解析器加载失败，请关闭并重新打开本画布窗口'; })()`).catch((): void => {});
    } finally { syncingUi = false; }
  };
  // 豆包同页展开画布、异步挂载 runtime 都不会触发 dom-ready；轻量轮询只读可见控件。
  const scheduleRefresh = (): void => {
    if (contents.isDestroyed()) return;
    refreshTimer = setTimeout((): void => { void inject().finally(scheduleRefresh); }, 650);
    refreshTimer.unref();
  };
  const captureBody = async (requestId: string, currentEpoch: number): Promise<void> => {
    try {
      const response = await networkDebugger.sendCommand('Network.getResponseBody', { requestId }) as { body?: string; base64Encoded?: boolean };
      if (epoch !== currentEpoch || !response.body || response.body.length > 20_000_000) return;
      const raw = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
      let payload: unknown = raw; try { payload = JSON.parse(raw); } catch { /* 嵌套文档仍由既有字段解析器处理。 */ }
      for (const api of extractDoubaoFallbackApis(payload, raw)) {
        const vid = extractDoubaoMediaVid({ fallback_api: api });
        if (vid && isParserApiUrl(api)) captured.set(vid, api);
      }
      while (captured.size > 300) captured.delete(captured.keys().next().value!);
    } catch { /* 网络缓存已回收时从实时画布文档读取，不重放任何写请求。 */ }
  };
  const onNetwork = (_event: Electron.Event, method: string, params: Record<string, unknown>): void => {
    if (contents.isDestroyed() || !isDoubaoParserPage(contents.getURL())) return;
    const requestId = typeof params.requestId === 'string' ? params.requestId : '';
    if (!requestId) return;
    if (method === 'Network.responseReceived') {
      const response = params.response as { url?: string; status?: number } | undefined;
      if (response?.status === 200 && response.url && shouldCaptureDoubaoCanvasResponse(response.url)) pending.add(requestId);
    } else if (method === 'Network.loadingFinished' && pending.delete(requestId)) void captureBody(requestId, epoch);
    else if (method === 'Network.loadingFailed') pending.delete(requestId);
  };
  const parse = async (): Promise<void> => {
    if (parsing) { status('正在解析当前画布，请稍候'); return; }
    parsing = true;
    downloads.clear(); downloadCanvasId = undefined;
    const currentEpoch = epoch;
    try {
      const document = await snapshot();
      const apis = parserApisForItems(document.items, captured);
      if (!apis.length) { status('当前画布尚无可解析原片，请等视频完成；已有成片时重新打开画布后再解析'); return; }
      const results: ParserResult[] = [];
      for (const [index, api] of apis.entries()) {
        if (contents.isDestroyed() || epoch !== currentEpoch) return;
        status(`解析视频 ${index + 1}/${apis.length}…`);
        const resolved = await resolveDoubaoFallbackVideoItems([api], url => fetchDoubaoFallbackJson(contents, url));
        const url = resolved[0]?.url || '';
        let size = 0;
        if (url) {
          try {
            const response = await contents.session.fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
            if (response.ok) size = Number(response.headers.get('content-length')) || 0;
          } catch { /* 长度查询失败不妨碍交付已解析地址。 */ }
        }
        results.push({ url, size, expires: url ? Number(new URL(url).searchParams.get('x-expires')) || 0 : 0, ...(!url ? { error: '原片地址暂不可用，请稍后重新解析' } : {}) });
      }
      if (epoch !== currentEpoch || contents.isDestroyed()) return;
      if ((await snapshot()).canvasId !== document.canvasId) throw new Error('画布已切换，请重新解析');
      if (epoch !== currentEpoch || contents.isDestroyed()) return;
      downloadCanvasId = document.canvasId;
      results.forEach((result, index): void => { if (result.url) downloads.set(result.url, `doubao-video-${index + 1}.mp4`); });
      notify({ type: 'PARSE_RESULT', results });
    } catch (error: unknown) {
      status(error instanceof Error && !/https?:|token|cookie|key_seed/i.test(error.message) ? error.message : '画布解析失败，请重新打开原画布后再试');
    } finally { parsing = false; }
  };
  const download = async (url: string | undefined): Promise<void> => {
    if (!url || !downloads.has(url)) { status('此下载地址已失效，请重新解析当前画布'); return; }
    const currentEpoch = epoch, canvasId = downloadCanvasId;
    try {
      const current = await snapshot();
      if (contents.isDestroyed()) return;
      if (epoch !== currentEpoch || current.canvasId !== canvasId || !downloads.has(url)) {
        status('画布已切换，请重新解析当前画布'); return;
      }
      status('正在准备下载视频…');
      contents.downloadURL(url);
    } catch { status('无法开始下载，请打开对应画布并重新解析'); }
  };
  const onAction = (event: Electron.IpcMainEvent, channel: string, raw: unknown): void => {
    if (channel !== 'storyboard-parser:action' || event.senderFrame !== contents.mainFrame || !isDoubaoParserPage(contents.getURL()) || !raw || typeof raw !== 'object') return;
    const action = raw as { type?: string; url?: string };
    if (action.type === 'PARSE') void parse();
    if (action.type === 'DOWNLOAD') {
      // 不接受页面提供的文件名和任意 URL，只允许下载本窗口刚解析出的结果。
      void download(action.url);
    }
  };
  const onDownload = (_event: Electron.Event, item: Electron.DownloadItem, owner: WebContents): void => {
    if (owner !== contents) return;
    const name = item.getURLChain().map(url => downloads.get(url)).find(Boolean);
    if (!name) return;
    try {
      // 每次下载回读偏好设置，用户保存新目录后无需重新打开画布。
      let folder = path.join(app.getPath('downloads'), '豆包工作室产物');
      const settingsFile = path.join(app.getPath('userData'), 'settings.json');
      if (fs.existsSync(settingsFile)) {
        const settings: unknown = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('下载目录设置无效');
        const configured = (settings as { downloadDir?: unknown }).downloadDir;
        if (configured !== undefined && typeof configured !== 'string') throw new Error('下载目录设置无效');
        if (typeof configured === 'string' && configured.trim()) folder = configured.trim();
      }
      if (!path.isAbsolute(folder)) throw new Error('下载目录必须是完整路径');
      fs.mkdirSync(folder, { recursive: true });
      const target = path.join(folder, `${path.parse(name).name}-${Date.now()}.mp4`);
      item.setSavePath(target);
      status(`正在下载，保存目录：${folder}`);
      item.once('done', (_done, state): void => status(state === 'completed' ? `视频已保存：${target}` : `视频下载失败或已取消，请检查保存目录后重试：${folder}`));
    } catch {
      // 设置损坏或目录不可用时取消，避免 Electron 落回系统下载目录。
      _event.preventDefault();
      status('无法保存视频，请检查偏好设置中的“产物下载目录”，确认路径完整且有写入权限后重试');
    }
  };
  const onNavigate = (_event: Electron.Event, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame) {
      epoch += 1; captured.clear(); pending.clear(); downloads.clear(); downloadCanvasId = undefined;
      visibleCanvasId = undefined; uiNeedsReset = true; uiMounted = false;
    }
  };
  const onInPageNavigate = (_event: Electron.Event, _url: string, isMainFrame: boolean): void => {
    if (!isMainFrame || contents.isDestroyed()) return;
    void inject();
  };
  if (!networkDebugger.isAttached()) networkDebugger.attach('1.3');
  installedContents.add(contents);
  networkDebugger.on('message', onNetwork);
  contents.on('ipc-message', onAction);
  contents.on('dom-ready', inject);
  contents.on('did-navigate-in-page', onInPageNavigate);
  contents.on('did-start-navigation', onNavigate);
  downloadSession.on('will-download', onDownload);
  contents.once('destroyed', (): void => {
    epoch += 1; captured.clear(); pending.clear(); downloads.clear(); installedContents.delete(contents);
    if (refreshTimer) clearTimeout(refreshTimer);
    downloadSession.removeListener('will-download', onDownload);
    networkDebugger.removeListener('message', onNetwork);
    contents.removeListener('ipc-message', onAction);
    contents.removeListener('dom-ready', inject);
    contents.removeListener('did-navigate-in-page', onInPageNavigate);
    contents.removeListener('did-start-navigation', onNavigate);
  });
  // 新窗口首次导航前 CDP 命令可能等待 renderer 初始化；不能阻塞调用方 loadURL。
  void networkDebugger.sendCommand('Network.enable').catch((): void => status('画布网络缓存未启用，将只读取当前画布文档；未找到原片时请重开窗口'));
  // 已完成首次加载的内嵌页也要立即补入口，不能只等下一次 dom-ready。
  if (contents.getURL() && !contents.isLoadingMainFrame()) await inject();
  scheduleRefresh();
}
