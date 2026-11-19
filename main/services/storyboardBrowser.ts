import { BrowserWindow, session } from 'electron';
import type { Account, StoryboardBatch } from '@doubao-studio/contracts';
import { readJSON } from '../utils/store';
import { STORYBOARD_PAGE_SCRIPT } from './storyboardPage';
import * as path from 'path';
import { installStoryboardCanvasParser } from './storyboardCanvasParser';

/** 只用于页面调用发出前的拒绝；执行中断不能据此认定未点击。 */
export class StoryboardCommandNotStartedError extends Error {}
export type StoryboardSubmitResult = { clicked: true } | { clicked: false; message: string };

export class StoryboardBrowser {
  private windows = new Map<string, BrowserWindow>();
  private pending = new Map<BrowserWindow, Set<(error: Error) => void>>();
  constructor(private readonly onPageLost: (id: string) => void = (): void => {}) {}

  /** executeJavaScript 在页面销毁时可能永不结算，必须由宿主窗口生命周期兜底。 */
  private wait<T>(window: BrowserWindow, action: (signal: AbortSignal) => Promise<T>, timeoutMs: number, navigationAllowed = false): Promise<T> {
    return new Promise<T>((resolve, reject): void => {
      const controller = new AbortController();
      const contents = window.webContents;
      const callbacks = this.pending.get(window) || new Set<(error: Error) => void>();
      this.pending.set(window, callbacks);
      let settled = false;
      const finish = (error?: Error, value?: T): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); callbacks.delete(cancel);
        if (!callbacks.size) this.pending.delete(window);
        window.removeListener('closed', closed);
        contents.removeListener('destroyed', closed);
        contents.removeListener('render-process-gone', crashed);
        contents.removeListener('did-start-navigation', navigated);
        if (error) { controller.abort(); reject(error); } else resolve(value as T);
      };
      const cancel = (error: Error): void => finish(error);
      const closed = (): void => finish(new Error('豆包画布已关闭，操作已暂停；重新打开后可继续，已发送节点不会重发'));
      const crashed = (): void => finish(new Error('豆包页面异常退出，操作已暂停，请重新打开画布'));
      const navigated = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean): void => {
        if (!navigationAllowed && mainFrame && !inPlace) finish(new Error('豆包页面已刷新或跳转，操作已暂停，请重新核对节点'));
      };
      const timer = setTimeout((): void => {
        // 先销毁超时执行环境，确保旧脚本不会在解锁后迟到点击。
        if (!window.isDestroyed()) window.destroy();
        finish(new Error('豆包页面长时间无响应，已关闭操作窗口并暂停，可重新打开继续'));
      }, timeoutMs);
      callbacks.add(cancel);
      window.once('closed', closed); contents.once('destroyed', closed);
      contents.once('render-process-gone', crashed); contents.on('did-start-navigation', navigated);
      if (window.isDestroyed() || contents.isDestroyed()) { closed(); return; }
      Promise.resolve().then(() => action(controller.signal)).then(value => finish(undefined, value), (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }
  async open(batch: StoryboardBatch): Promise<BrowserWindow> {
    const existing = this.windows.get(batch.id);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return existing; }
    const account = readJSON<Account[]>('accounts.json', []).find((item) => item.id === batch.accountId);
    if (!account || account.platform === 'dola') throw new Error('所选豆包账号不存在');
    const window = new BrowserWindow({
      width: 1280, height: 880, minWidth: 900, minHeight: 640, title: `Lalor 并发 · ${batch.title}`,
      autoHideMenuBar: true, show: true,
      webPreferences: { preload: path.join(__dirname, 'storyboardParserPreload.js'), session: session.fromPartition(`persist:doubao_${account.partition}`), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!this.allowed(url)) event.preventDefault(); });
    window.on('closed', (): void => { this.windows.delete(batch.id); this.onPageLost(batch.id); });
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame): void => {
      if (mainFrame && !inPlace) this.onPageLost(batch.id);
    });
    this.windows.set(batch.id, window);
    try { await installStoryboardCanvasParser(window.webContents, () => batch.canvasId); }
    catch { window.destroy(); throw new Error('画布解析器加载失败，请检查内置扩展文件后重开窗口'); }
    const url = batch.canvasUrl || 'https://www.doubao.com/chat/';
    if (!this.allowed(url)) throw new Error('批次画布地址无效');
    await this.wait(window, () => window.loadURL(url), 60000, true);
    return window;
  }
  private allowed(url: string): boolean {
    try { const parsed = new URL(url); return parsed.protocol === 'https:' && (parsed.hostname === 'doubao.com' || parsed.hostname.endsWith('.doubao.com')); } catch { return false; }
  }
  async command<T>(batch: StoryboardBatch, method: string, input: unknown = {}, interactive = true): Promise<T> {
    const window = this.windows.get(batch.id);
    if (!window || window.isDestroyed()) throw new StoryboardCommandNotStartedError('豆包画布窗口已关闭，请重新打开后继续');
    if (!this.allowed(window.webContents.getURL())) throw new StoryboardCommandNotStartedError('当前页面不属于豆包，已停止操作');
    if (interactive && (!window.isVisible() || window.isMinimized() || !window.isFocused())) throw new StoryboardCommandNotStartedError('请保持豆包画布窗口在前台，再继续本批次');
    return this.wait(window, async (signal): Promise<T> => {
      signal.throwIfAborted();
      await window.webContents.executeJavaScript(STORYBOARD_PAGE_SCRIPT);
      signal.throwIfAborted();
      return window.webContents.executeJavaScript(`window.__lalorStoryboardV1[${JSON.stringify(method)}](${JSON.stringify(input)})`, true) as Promise<T>;
    }, method === 'upload' ? 110000 : 60000);
  }
  async ensureCanvas(batch: StoryboardBatch): Promise<{ canvasId: string; url: string }> {
    await this.open(batch);
    await this.command(batch, 'reset');
    if (batch.canvasId) {
      return this.command(batch, 'reopen', { canvasId: batch.canvasId });
    }
    return this.command(batch, 'enter');
  }
  stop(batch: StoryboardBatch): void {
    const window = this.windows.get(batch.id);
    if (!window || window.isDestroyed()) return;
    // 等旧脚本确认停止后才能解锁。不能直接拒绝 Promise，让旧脚本在下一轮 reset 后继续跑。
    void this.wait(window, () => window.webContents.executeJavaScript('window.__lalorStoryboardV1?.stop()'), 1500)
      .then(async (): Promise<void> => {
        const end = Date.now() + 1500;
        while (this.pending.get(window)?.size && !window.isDestroyed() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
        if (this.pending.get(window)?.size && !window.isDestroyed()) window.destroy();
      })
      .catch((): void => { if (!window.isDestroyed()) window.destroy(); });
  }
  close(id: string): void {
    const window = this.windows.get(id);
    if (window && !window.isDestroyed()) window.close();
    this.windows.delete(id);
  }
  dispose(): void { for (const window of this.windows.values()) if (!window.isDestroyed()) window.destroy(); this.windows.clear(); }
}
