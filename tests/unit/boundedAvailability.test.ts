import { describe, expect, it, vi } from 'vitest';
import { DOLA_TASK_AVAILABILITY_CHECK_MS, runBoundedAvailabilityCheck } from '../../src/utils/boundedAvailability';

function readyWebview(): { getURL: () => string; executeJavaScript: (script: string) => Promise<unknown> } {
  return {
    getURL: () => 'https://www.doubao.com/chat/',
    executeJavaScript: async () => ({
      bodyText: '欢迎使用',
      visibleLayerText: '',
      iframeSources: [],
      hasUsableEditor: true,
      hasAuthenticatedControl: true,
      documentReady: true,
    }),
  };
}

describe('有界账号可用性检查', () => {
  it('Dola 任务判活预算大于通用检查，覆盖后台 WebView 挂载窗口', () => {
    expect(DOLA_TASK_AVAILABILITY_CHECK_MS).toBe(60_000);
  });

  it('正常探测与状态写回返回 ready', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const result = await runBoundedAvailabilityCheck({
      webview: readyWebview(),
      platform: 'doubao',
      source: 'manual',
      persist,
    });

    expect(result).toMatchObject({ persisted: true, timedOut: false });
    expect(result.availability.state).toBe('ready');
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ state: 'ready' }));
  });

  it('状态写回超时返回 fail-closed 结果，不继续放行旧 ready', async () => {
    vi.useFakeTimers();
    try {
      const persist = vi.fn().mockImplementation(() => new Promise<boolean>(() => undefined));
      const pending = runBoundedAvailabilityCheck({
        webview: readyWebview(),
        platform: 'doubao',
        source: 'pre_task',
        persist,
      });

      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;
      expect(result.timedOut).toBe(true);
      expect(result.persisted).toBe(false);
      expect(result.availability).toMatchObject({ state: 'unknown', reason: 'availability_check_timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('Dola 任务判活等待加载壳稳定，只写入最终 ready 结果', async () => {
    vi.useFakeTimers();
    try {
      let probeCount = 0;
      const persist = vi.fn().mockResolvedValue(true);
      const webview = {
        getURL: () => 'https://www.dola.com/chat',
        executeJavaScript: vi.fn(async () => {
          probeCount += 1;
          if (probeCount < 3) {
            return {
              bodyText: '登录',
              hasLoginControl: true,
              hasUsableEditor: false,
              documentReady: true,
            };
          }
          return {
            bodyText: '欢迎使用',
            hasLoginControl: false,
            hasUsableEditor: true,
            documentReady: true,
          };
        }),
      };

      const pending = runBoundedAvailabilityCheck({
        webview,
        platform: 'dola',
        source: 'pre_task',
        persist,
      });
      await vi.advanceTimersByTimeAsync(6_000);
      const result = await pending;

      expect(webview.executeJavaScript).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ persisted: true, timedOut: false });
      expect(result.availability).toMatchObject({ state: 'ready', reason: 'ready' });
      expect(persist).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({ state: 'ready' }));
    } finally {
      vi.useRealTimers();
    }
  });
});
