import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoryboardBatch } from '@doubao-studio/contracts';

vi.mock('../../main/services/storyboardCanvasParser', (): unknown => ({ installStoryboardCanvasParser: async (): Promise<void> => {} }));

vi.mock('electron', async (): Promise<unknown> => {
  const { EventEmitter: Emitter } = await import('node:events');
  class Window extends Emitter {
    destroyed = false;
    rejectCommand?: (error: Error) => void;
    webContents = Object.assign(new Emitter(), {
      isDestroyed: (): boolean => this.destroyed,
      getURL: (): string => 'https://www.doubao.com/chat/1',
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async (script: string): Promise<unknown> => {
        if (script.includes('?.stop()')) { this.rejectCommand?.(new Error('已暂停后续操作')); return true; }
        if (script.startsWith('(() =>')) return true;
        return new Promise((_resolve, reject): void => { this.rejectCommand = reject; });
      }),
    });
    loadURL = vi.fn(async (): Promise<void> => {});
    isDestroyed = (): boolean => this.destroyed;
    isVisible = (): boolean => true;
    isMinimized = (): boolean => false;
    isFocused = (): boolean => true;
    show = (): void => {};
    focus = (): void => {};
    destroy = (): void => { this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed'); };
    close = (): void => this.destroy();
  }
  return { BrowserWindow: Window, session: { fromPartition: vi.fn() } };
});
vi.mock('../../main/utils/store', (): unknown => ({ readJSON: (): unknown => [{ id: 'account', partition: 'test' }] }));
import { StoryboardBrowser } from '../../main/services/storyboardBrowser';

describe('分镜页面等待生命周期', (): void => {
  const batch = { id: 'batch', accountId: 'account', title: '测试' } as StoryboardBatch;
  afterEach((): void => vi.useRealTimers());
  it('关闭窗口立即拒绝挂起调用并移除监听', async (): Promise<void> => {
    const lost = vi.fn(); const browser = new StoryboardBrowser(lost);
    const window = await browser.open(batch);
    const pending = browser.command(batch, 'verify');
    const result = expect(pending).rejects.toThrow('画布已关闭');
    window.close(); await result;
    expect(lost).toHaveBeenCalledWith(batch.id);
    expect((window.webContents as unknown as EventEmitter).listenerCount('render-process-gone')).toBe(0);
  });
  it('暂停会终结旧调用且不销毁有响应的页面', async (): Promise<void> => {
    const browser = new StoryboardBrowser(); const window = await browser.open(batch);
    const pending = browser.command(batch, 'verify');
    const result = expect(pending).rejects.toThrow('已暂停后续操作');
    await vi.waitFor((): void => expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(2));
    browser.stop(batch); await result;
    expect(window.isDestroyed()).toBe(false); browser.dispose();
  });
  it('页面失去响应先销毁执行环境再解锁', async (): Promise<void> => {
    vi.useFakeTimers();
    const browser = new StoryboardBrowser(); const window = await browser.open(batch);
    const pending = browser.command(batch, 'submit');
    const result = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60001); await result;
    expect(window.isDestroyed()).toBe(true);
  });
  it('刷新页面中断等待，画布内部地址变化不误取消', async (): Promise<void> => {
    const browser = new StoryboardBrowser(); const window = await browser.open(batch);
    const pending = browser.command(batch, 'verify');
    const result = expect(pending).rejects.toThrow('刷新或跳转');
    const events = window.webContents as unknown as EventEmitter;
    events.emit('did-start-navigation', {}, 'https://www.doubao.com/chat/1', true, true);
    events.emit('did-start-navigation', {}, 'https://www.doubao.com/chat/1', false, true);
    await result; browser.dispose();
  });
});
