import { EventEmitter } from 'node:events';
import type { WebContents, WebPreferences } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, object>(),
  install: vi.fn(async (): Promise<void> => {}),
}));
vi.mock('electron', (): unknown => ({
  session: {
    fromPartition: (partition: string): object => {
      if (!mocks.sessions.has(partition)) mocks.sessions.set(partition, {});
      return mocks.sessions.get(partition)!;
    },
  },
}));
vi.mock('../../main/services/storyboardCanvasParser', async (importOriginal): Promise<unknown> => ({
  ...await importOriginal<typeof import('../../main/services/storyboardCanvasParser')>(),
  installStoryboardCanvasParser: mocks.install,
}));
import { registerAccountCanvasParser } from '../../main/services/accountCanvasParser';

function hostWindow(): EventEmitter & WebContents {
  return new EventEmitter() as EventEmitter & WebContents;
}

describe('账号池豆包画布解析器接入', (): void => {
  beforeEach((): void => { mocks.install.mockClear(); mocks.sessions.clear(); });

  it('仅为豆包持久会话装专用 preload，初次空 URL 也能接入', (): void => {
    const host = hostWindow();
    registerAccountCanvasParser(host, '/parser-preload.js');
    const preferences: WebPreferences = { nodeIntegration: true, contextIsolation: false, sandbox: false };
    host.emit('will-attach-webview', {}, preferences, { src: 'https://www.doubao.com/chat/', partition: 'persist:doubao_a' });
    expect(preferences).toMatchObject({ preload: '/parser-preload.js', nodeIntegration: false, contextIsolation: true, sandbox: true });
    const guest = { session: mocks.sessions.get('persist:doubao_a'), getURL: (): string => '' };
    host.emit('did-attach-webview', {}, guest);
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith(guest);
  });

  it.each([
    ['https://www.dola.com/chat', 'persist:dola_a', false],
    ['https://www.doubao.com.attacker.example', 'persist:doubao_a', false],
    ['http://www.doubao.com/chat', 'persist:doubao_a', false],
    ['https://www.doubao.com/chat', 'persist:dola_a', false],
    ['https://www.doubao.com/chat', 'persist:doubao_', false],
    ['https://www.doubao.com/chat', 'doubao_a', false],
    ['https://www.doubao.com/chat', 'persist:doubao_a', true],
  ])('拒绝不匹配或被宿主拒绝的会话 %s / %s', (src: string, partition: string, defaultPrevented: boolean): void => {
    const host = hostWindow();
    registerAccountCanvasParser(host, '/parser-preload.js');
    const preferences: WebPreferences = {};
    host.emit('will-attach-webview', { defaultPrevented }, preferences, { src, partition });
    host.emit('did-attach-webview', {}, { session: {} });
    expect(preferences.preload).toBeUndefined();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('同一宿主注册一次，多个账号按各自 Session 接入并在销毁时清理', (): void => {
    const host = hostWindow();
    registerAccountCanvasParser(host, '/parser-preload.js');
    registerAccountCanvasParser(host, '/parser-preload.js');
    expect(host.listenerCount('will-attach-webview')).toBe(1);
    for (const id of ['a', 'b']) {
      host.emit('will-attach-webview', {}, {}, { src: 'https://www.doubao.com/chat/', partition: `persist:doubao_${id}` });
      host.emit('did-attach-webview', {}, { session: mocks.sessions.get(`persist:doubao_${id}`) });
    }
    host.emit('did-attach-webview', {}, { session: {} });
    expect(mocks.install).toHaveBeenCalledTimes(2);
    host.emit('destroyed');
    expect(host.listenerCount('will-attach-webview')).toBe(0);
    expect(host.listenerCount('did-attach-webview')).toBe(0);
  });
});
