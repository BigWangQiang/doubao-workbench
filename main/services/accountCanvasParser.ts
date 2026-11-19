import { session, type Session, type WebContents, type WebPreferences } from 'electron';
import { installStoryboardCanvasParser, isDoubaoParserPage } from './storyboardCanvasParser';

const registeredHosts = new WeakSet<WebContents>();

/** 账号池 webview 与并发独立窗口分别创建，必须在宿主绑定专用隔离桥接。 */
export function registerAccountCanvasParser(host: WebContents, preloadPath: string): void {
  if (registeredHosts.has(host)) return;
  registeredHosts.add(host);
  const preparedSessions = new WeakSet<Session>();
  const prepare = (event: Electron.Event, preferences: WebPreferences, params: { src?: string; partition?: string }): void => {
    // 先尊重主窗口已有的来源校验，只允许豆包账号会话使用这份内置 preload。
    if (event.defaultPrevented || !isDoubaoParserPage(params.src || '') || !/^persist:doubao_.+$/.test(params.partition || '')) return;
    preferences.preload = preloadPath;
    preferences.nodeIntegration = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preparedSessions.add(session.fromPartition(params.partition!));
  };
  const attached = (_event: Electron.Event, guest: WebContents): void => {
    // 初次附着时 URL 可能为空；按已装入专用 preload 的 Session 判断，
    // 不把豆包解析器和网络监听装到 Dola 或其他内嵌页面上。
    if (!preparedSessions.has(guest.session)) return;
    void installStoryboardCanvasParser(guest).catch((): void => {
      // 不记录页面地址或账号信息；文件缺失不能被误认为解析成功。
      console.error('[CanvasParser] 账号画布解析器初始化失败，请检查内置扩展并重新打开账号');
    });
  };
  host.on('will-attach-webview', prepare);
  host.on('did-attach-webview', attached);
  host.once('destroyed', (): void => {
    registeredHosts.delete(host);
    host.removeListener('will-attach-webview', prepare);
    host.removeListener('did-attach-webview', attached);
  });
}
