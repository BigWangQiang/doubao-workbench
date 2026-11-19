import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import type { WebContents } from 'electron';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', (): unknown => ({ app: { getAppPath: (): string => process.cwd() } }));
import { installStoryboardCanvasParser, isDoubaoParserPage, isParserApiUrl, parserApisForItems } from '../../main/services/storyboardCanvasParser';
import { canvasParserCanvasProbeScript, canvasParserSnapshotScript } from '../../main/services/canvasParserSnapshot';
import * as fallback from '../../main/utils/dolaExtensionNetwork';

describe('画布扩展解析范围', (): void => {
  it('仅允许受信任的 HTTPS 解析接口', (): void => {
    expect(isParserApiUrl('https://www.doubao.com/api/play')).toBe(true);
    expect(isParserApiUrl('https://api.snssdk.com/video')).toBe(true);
    for (const url of ['http://www.doubao.com/api', 'https://www.doubao.com.attacker.example/api', 'https://127.0.0.1/api', 'https://name:secret@www.doubao.com/api', 'https://www.doubao.com:8443/api']) expect(isParserApiUrl(url)).toBe(false);
  });
  it('只匹配当前画布节点，不返回缓存中其他画布的视频', (): void => {
    const current = 'https://www.doubao.com/video?vid=current123';
    const other = 'https://www.doubao.com/video?vid=other123';
    const cached = new Map([['current123', current], ['other123', other]]);
    expect(parserApisForItems([{ video_id: 'current123' }], cached)).toEqual([current]);
    expect(parserApisForItems([], cached)).toEqual([]);
  });
  it('读取文档原始 fallback_api 并按视频去重，拒绝外部接口', (): void => {
    const api = 'https://www.doubao.com/video?vid=current123';
    expect(parserApisForItems([{ fallback_api: api }, { fallback_api: api }, { fallback_api: 'https://attacker.example/video?vid=other123' }], new Map())).toEqual([api]);
  });
  it('仅允许豆包页面安装桥接，不向解析 API 或 Dola 安装', (): void => {
    expect(isDoubaoParserPage('https://www.doubao.com/chat/')).toBe(true);
    for (const url of ['https://api.snssdk.com/play', 'https://www.dola.com/chat', 'file:///index.html', 'https://doubao.com.attacker.example']) {
      expect(isDoubaoParserPage(url)).toBe(false);
    }
  });
});

interface CanvasButton {
  isConnected: boolean;
  visibility: string;
  getClientRects: () => unknown[];
  __reactFiberTest: unknown;
}

function canvasButton(canvasId: string, items: unknown, visible = true): CanvasButton {
  return {
    isConnected: true, visibility: 'visible', getClientRects: (): unknown[] => visible ? [{}] : [],
    __reactFiberTest: { memoizedProps: {}, return: { memoizedProps: { value: {
      runtime: { key: { canvasId } }, binding: { getProjectionState: (): unknown => ({ document: { itemsById: items } }) },
    } } } },
  };
}

function readSnapshot(buttons: CanvasButton[], expected?: string): unknown {
  return runInNewContext(canvasParserSnapshotScript(expected), {
    document: { querySelectorAll: (): CanvasButton[] => buttons },
    getComputedStyle: (button: CanvasButton): { visibility: string } => ({ visibility: button.visibility }),
  });
}

describe('当前可见画布只读快照', (): void => {
  it('从可见按钮对应的 React runtime 读取节点，忽略后台画布', (): void => {
    const item = Object.freeze({ id: 'video-1', kind: 'video' });
    const button = canvasButton('current', Object.freeze({ a: item }));
    const before = JSON.stringify(button);
    expect(readSnapshot([canvasButton('old', {}, false), button])).toEqual({ canvasId: 'current', items: [item] });
    expect(JSON.stringify(button)).toBe(before);
  });

  it('同一画布的多个按钮去重，同时出现不同画布则拒绝猜测', (): void => {
    expect(readSnapshot([canvasButton('a', {}), canvasButton('a', {})])).toEqual({ canvasId: 'a', items: [] });
    expect(() => readSnapshot([canvasButton('a', {}), canvasButton('b', {})])).toThrow('多个画布');
  });

  it('没有画布、数据未就绪或独立批次窗口画布已切换时明确失败', (): void => {
    expect(() => readSnapshot([])).toThrow('请先打开');
    expect(() => readSnapshot([canvasButton('a', undefined)])).toThrow('尚未加载完成');
    expect(() => readSnapshot([canvasButton('a', {})], 'b')).toThrow('本批次原画布');
    const hidden = canvasButton('a', {}); hidden.visibility = 'hidden';
    expect(() => readSnapshot([hidden])).toThrow('请先打开');
  });
});

describe('画布 UI 探测', (): void => {
  it('对话页没有画布 runtime 时不判定为画布', (): void => {
    const button: CanvasButton = {
      isConnected: true, visibility: 'visible', getClientRects: (): unknown[] => [{}], __reactFiberTest: { memoizedProps: {}, return: null },
    };
    const result = runInNewContext(canvasParserCanvasProbeScript(), {
      document: { querySelectorAll: (): CanvasButton[] => [button] },
      getComputedStyle: (): { visibility: string } => ({ visibility: 'visible' }),
    }) as { isCanvas: boolean };
    expect(result).toEqual({ isCanvas: false, canvasId: undefined });
  });

  it('指定批次画布 ID 不匹配时拒绝显示解析器', (): void => {
    const button = canvasButton('other-canvas', {});
    const result = runInNewContext(canvasParserCanvasProbeScript('expected-canvas'), {
      document: { querySelectorAll: (): CanvasButton[] => [button] },
      getComputedStyle: (): { visibility: string } => ({ visibility: 'visible' }),
    }) as { isCanvas: boolean };
    expect(result.isCanvas).toBe(false);
  });

  it('视频按钮尚未挂载时，画布容器的 runtime 可同时用于探测和解析', (): void => {
    const canvas = canvasButton('expanded-canvas', { video: { id: 'v1' } });
    const context = {
      document: { querySelectorAll: (selector: string): CanvasButton[] => selector.split(',').includes('.react-flow') ? [canvas] : [] },
      getComputedStyle: (): { visibility: string } => ({ visibility: 'visible' }),
    };
    expect(runInNewContext(canvasParserCanvasProbeScript(), context)).toEqual({ isCanvas: true, canvasId: 'expanded-canvas' });
    expect(runInNewContext(canvasParserSnapshotScript(), context)).toEqual({ canvasId: 'expanded-canvas', items: [{ id: 'v1' }] });
    canvas.getClientRects = (): unknown[] => [];
    expect(runInNewContext(canvasParserCanvasProbeScript(), context).isCanvas).toBe(false);
  });
});

const ORIGINAL_URL = 'https://video.example/original.mp4';
const API_URL = 'https://www.doubao.com/video?vid=current123';
class ParserContents extends EventEmitter {
  url = 'https://www.doubao.com/chat/';
  canvasVisible = true;
  destroyed = false;
  mainFrame = {};
  snapshot = { canvasId: 'a', items: [{ fallback_api: API_URL }] };
  session = Object.assign(new EventEmitter(), {
    fetch: vi.fn(async (): Promise<unknown> => ({ ok: true, headers: new Headers({ 'content-length': '50000000' }) })),
  });
  debugger = Object.assign(new EventEmitter(), {
    isAttached: vi.fn((): boolean => false), attach: vi.fn(), detach: vi.fn(),
    sendCommand: vi.fn(async (): Promise<unknown> => ({})),
  });
  getURL = (): string => this.url;
  isDestroyed = (): boolean => this.destroyed;
  isLoadingMainFrame = (): boolean => false;
  executeJavaScript = vi.fn(async (code?: string): Promise<unknown> => {
    if (code?.includes('return { isCanvas:')) return { isCanvas: this.canvasVisible, canvasId: this.canvasVisible ? this.snapshot.canvasId : undefined };
    if (!this.canvasVisible) throw new Error('请先打开要提取视频的豆包画布');
    return this.snapshot;
  });
  executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, _scripts: Array<{ code: string }>): Promise<boolean> => true);
  uiInstallCount = (): number => this.executeJavaScriptInIsolatedWorld.mock.calls.filter(([, scripts]) => scripts[0]?.code.includes('const transport =')).length;
  uiCleanupCount = (): number => this.executeJavaScriptInIsolatedWorld.mock.calls.filter(([, scripts]) => !scripts[0]?.code.includes('const transport =')).length;
  send = vi.fn();
  downloadURL = vi.fn();
  action(type: string, url?: string, senderFrame: object = this.mainFrame): void {
    this.emit('ipc-message', { senderFrame }, 'storyboard-parser:action', { type, url });
  }
  destroy(): void { this.destroyed = true; this.emit('destroyed'); }
}

describe('内嵌解析器生命周期与下载边界', (): void => {
  const contents: ParserContents[] = [];
  const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  beforeAll((): void => { Object.defineProperty(process, 'resourcesPath', { configurable: true, value: process.cwd() }); });
  beforeEach((): void => {
    vi.spyOn(fallback, 'resolveDoubaoFallbackVideoItems').mockResolvedValue([{ type: 'video', url: ORIGINAL_URL }]);
  });
  afterEach((): void => { contents.splice(0).forEach((item): void => item.destroy()); vi.restoreAllMocks(); vi.useRealTimers(); });
  afterAll((): void => {
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
    else Reflect.deleteProperty(process, 'resourcesPath');
  });
  async function install(url?: string, getCanvasId?: () => string | undefined, canvasVisible = true): Promise<ParserContents> {
    const item = new ParserContents(); if (url) item.url = url;
    item.canvasVisible = canvasVisible;
    contents.push(item);
    await installStoryboardCanvasParser(item as unknown as WebContents, getCanvasId);
    return item;
  }
  async function parse(item: ParserContents): Promise<void> {
    item.action('PARSE');
    await vi.waitFor((): void => expect(item.send).toHaveBeenCalledWith('storyboard-parser:message', expect.objectContaining({ type: 'PARSE_RESULT' })));
  }

  it('已加载的豆包页面立即补入口，重复安装不重复监听且不分离已有 debugger', async (): Promise<void> => {
    const item = await install();
    await installStoryboardCanvasParser(item as unknown as WebContents);
    expect(item.uiInstallCount()).toBe(1);
    expect(item.listenerCount('ipc-message')).toBe(1);
    expect(item.session.listenerCount('will-download')).toBe(1);
    item.destroy();
    expect(item.session.listenerCount('will-download')).toBe(0);
    expect(item.debugger.listenerCount('message')).toBe(0);
    expect(item.debugger.detach).not.toHaveBeenCalled();
  });

  it('刷新完成重新注入，非豆包页面和 iframe 不能发起解析', async (): Promise<void> => {
    const item = await install('https://www.dola.com/chat');
    item.action('PARSE');
    expect(item.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(item.executeJavaScript).not.toHaveBeenCalled();
    item.url = 'https://www.doubao.com/chat/';
    item.emit('dom-ready');
    await vi.waitFor((): void => expect(item.uiInstallCount()).toBe(1));
    item.executeJavaScript.mockClear();
    item.action('PARSE', undefined, {});
    expect(item.executeJavaScript).not.toHaveBeenCalled();
  });

  it('普通豆包对话页不显示解析器，进入画布后显示，返回对话页后清理', async (): Promise<void> => {
    const item = await install('https://www.doubao.com/chat/', undefined, false);
    expect(item.uiInstallCount()).toBe(0);
    expect(item.uiCleanupCount()).toBe(1);
    item.url = 'https://www.doubao.com/canvas/test';
    item.canvasVisible = true;
    item.emit('did-navigate-in-page', {}, item.url, true);
    await vi.waitFor((): void => expect(item.uiInstallCount()).toBe(1));
    const cleanups = item.uiCleanupCount();
    item.url = 'https://www.doubao.com/chat/';
    item.canvasVisible = false;
    item.emit('did-navigate-in-page', {}, item.url, true);
    await vi.waitFor((): void => expect(item.uiCleanupCount()).toBe(cleanups + 1));
    expect(item.uiInstallCount()).toBe(1);
  });

  it('同一个 URL 异步展开、关闭及再次打开画布，自动同步按钮且只挂载一次', async (): Promise<void> => {
    vi.useFakeTimers();
    const item = await install(undefined, undefined, false);
    const url = item.url;
    expect(item.uiInstallCount()).toBe(0);
    item.canvasVisible = true;
    await vi.advanceTimersByTimeAsync(650);
    expect(item.uiInstallCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1950);
    expect(item.uiInstallCount()).toBe(1);
    const cleanups = item.uiCleanupCount();
    item.canvasVisible = false;
    await vi.advanceTimersByTimeAsync(650);
    expect(item.uiCleanupCount()).toBe(cleanups + 1);
    item.canvasVisible = true;
    await vi.advanceTimersByTimeAsync(650);
    expect(item.uiInstallCount()).toBe(2);
    expect(item.url).toBe(url);
    item.destroy();
    item.executeJavaScript.mockClear();
    await vi.advanceTimersByTimeAsync(1950);
    expect(item.executeJavaScript).not.toHaveBeenCalled();
  });

  it('同页关闭再打开原画布也撤销旧解析下载授权', async (): Promise<void> => {
    vi.useFakeTimers();
    const item = await install();
    await parse(item);
    item.canvasVisible = false;
    await vi.advanceTimersByTimeAsync(650);
    item.canvasVisible = true;
    await vi.advanceTimersByTimeAsync(650);
    item.action('DOWNLOAD', ORIGINAL_URL);
    expect(item.downloadURL).not.toHaveBeenCalled();
    expect(item.send).toHaveBeenCalledWith('storyboard-parser:message', { type: 'STATUS', text: '此下载地址已失效，请重新解析当前画布' });
  });

  it('导航时旧探测迟到不会把按钮注入新的对话页', async (): Promise<void> => {
    const item = await install(undefined, undefined, false);
    let finish!: (value: unknown) => void;
    item.executeJavaScript.mockImplementationOnce(() => new Promise((resolve): void => { finish = resolve; }));
    item.emit('did-navigate-in-page', {}, item.url, true);
    item.emit('did-start-navigation', {}, 'https://www.doubao.com/chat/other', true, true);
    finish({ isCanvas: true, canvasId: 'a' });
    await new Promise((resolve): void => { setImmediate(resolve); });
    expect(item.uiInstallCount()).toBe(0);
  });

  it('原生 WebContents 销毁后 debugger 属性已不可读，清理仍能完成', async (): Promise<void> => {
    const item = new ParserContents(); contents.push(item);
    const debuggerRef = item.debugger;
    Object.defineProperty(item, 'debugger', { get: (): typeof debuggerRef => {
      if (item.destroyed) throw new Error('Object has been destroyed');
      return debuggerRef;
    } });
    await installStoryboardCanvasParser(item as unknown as WebContents);
    expect(() => item.destroy()).not.toThrow();
    expect(debuggerRef.listenerCount('message')).toBe(0);
    expect(item.session.listenerCount('will-download')).toBe(0);
  });

  it('下载仅接受当前画布已解析原片，切换画布后拒绝旧结果', async (): Promise<void> => {
    const item = await install(); await parse(item);
    item.action('DOWNLOAD', 'https://attacker.example/file');
    expect(item.downloadURL).not.toHaveBeenCalled();
    item.action('DOWNLOAD', ORIGINAL_URL);
    await vi.waitFor((): void => expect(item.downloadURL).toHaveBeenCalledExactlyOnceWith(ORIGINAL_URL));
    item.downloadURL.mockClear();
    item.snapshot = { canvasId: 'b', items: [] };
    item.action('DOWNLOAD', ORIGINAL_URL);
    await vi.waitFor((): void => expect(item.send).toHaveBeenCalledWith('storyboard-parser:message', expect.objectContaining({ text: '画布已切换，请重新解析当前画布' })));
    expect(item.downloadURL).not.toHaveBeenCalled();
  });

  it('SPA 导航丢弃迟到的解析结果并清除旧下载授权', async (): Promise<void> => {
    const item = await install(); await parse(item);
    item.send.mockClear();
    let finish!: (value: Array<{ type: 'video'; url: string }>) => void;
    vi.mocked(fallback.resolveDoubaoFallbackVideoItems).mockImplementationOnce(() => new Promise((resolve): void => { finish = resolve; }));
    item.action('PARSE');
    await vi.waitFor((): void => expect(finish).toBeTypeOf('function'));
    item.emit('did-start-navigation', {}, 'https://www.doubao.com/chat/next', true, true);
    finish([{ type: 'video', url: ORIGINAL_URL }]);
    await new Promise((resolve): void => { setImmediate(resolve); });
    expect(item.send).not.toHaveBeenCalledWith('storyboard-parser:message', expect.objectContaining({ type: 'PARSE_RESULT' }));
    item.action('DOWNLOAD', ORIGINAL_URL);
    expect(item.downloadURL).not.toHaveBeenCalled();
  });

  it('独立批次窗口仍要求已有批次画布 ID', async (): Promise<void> => {
    const item = await install(undefined, (): undefined => undefined);
    item.action('PARSE');
    await vi.waitFor((): void => expect(item.send).toHaveBeenCalledWith('storyboard-parser:message', { type: 'STATUS', text: '请先打开本批次原画布' }));
    expect(fallback.resolveDoubaoFallbackVideoItems).not.toHaveBeenCalled();
  });
});
