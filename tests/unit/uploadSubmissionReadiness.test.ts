import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findSendButtonTarget, uploadReferenceImages, waitForSubmissionControlsStable } from '../../src/utils/doubaoBridge';
import { buildUploadPendingProbe, getObservedUploadCount, isUploadSnapshotReady } from '../../src/utils/uploadReadiness';

afterEach(() => vi.useRealTimers());

function evaluateProgress(text: string, hasThumbnail: boolean, inEditor = false): boolean {
  const root = {
    querySelectorAll: (): unknown[] => [percent],
  };
  const tile = {
    getBoundingClientRect: (): { width: number; height: number } => ({ width: 60, height: 60 }),
    querySelector: (): object | null => hasThumbnail ? {} : null,
    parentElement: root,
  };
  const percent = {
    offsetParent: {}, children: [], textContent: text, parentElement: tile,
    getBoundingClientRect: (): { width: number; height: number } => ({ width: 36, height: 20 }),
    getAttribute: (): null => null,
    closest: (): object | null => inEditor ? {} : null,
  };
  return runInNewContext(buildUploadPendingProbe('root'), {
    root, window: { getComputedStyle: (): object => ({ display: 'block', visibility: 'visible' }) },
  }) as boolean;
}

describe('多张参考图上传及发送前等待', () => {
  it.each(['0%', '50%', '99%', '99.9%'])('缩略图 %s 仍在处理，不能提前提交', (text) => {
    expect(evaluateProgress(text, true)).toBe(true);
  });

  it('缩略图 100% 已完成；提示词和普通百分比不能阻断上传', () => {
    expect(evaluateProgress('100%', true)).toBe(false);
    expect(evaluateProgress('99%', false)).toBe(false);
    expect(evaluateProgress('99%', true, true)).toBe(false);
  });

  it('只选入 5 个文件但未渲染 5 张缩略图时不能认定上传完成', () => {
    const snapshot = { inputFileCount: 5, matchingFileNameCount: 5, visibleAttachmentCount: 4, renderedAttachmentCount: 4, pending: false };
    expect(getObservedUploadCount(snapshot, 0)).toBe(4);
    expect(isUploadSnapshotReady(snapshot, 5, 0)).toBe(false);
    expect(isUploadSnapshotReady({ ...snapshot, renderedAttachmentCount: 5 }, 5, 0)).toBe(true);
  });

  it('5 张图停在 99% 超过 20 秒后仍等待，全部完成后才通过', async () => {
    vi.useFakeTimers();
    let injected = false;
    let uploadStartedAt = 0;
    const snapshots: boolean[] = [];
    const webview = {
      loadURL: vi.fn(), getURL: (): string => 'https://www.dola.com/chat',
      executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
        if (code.includes('new DataTransfer')) {
          injected = true;
          uploadStartedAt = Date.now();
          return { ok: true, count: 5 };
        }
        const pending = injected && Date.now() - uploadStartedAt < 35_000;
        if (injected) snapshots.push(pending);
        return { inputFileCount: injected ? 5 : 0, visibleAttachmentCount: injected ? 5 : 0,
          renderedAttachmentCount: injected ? 5 : 0, matchingFileNameCount: 0, pending };
      }),
    };
    let complete = false;
    const result = uploadReferenceImages(webview, Array.from({ length: 5 }, (_, i) => ({ name: `${i}.png`, mime: 'image/png', base64: 'AA==' })))
      .then((value) => { complete = true; return value; });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(result).resolves.toBe(true);
    expect(snapshots.filter(Boolean).length).toBeGreaterThan(3);
    expect(snapshots.slice(-3)).toEqual([false, false, false]);
    expect(webview.executeJavaScript.mock.calls.filter(([code]) => code.includes('new DataTransfer'))).toHaveLength(1);
  });

  it('上传等待可以取消，不继续注入或发送', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const webview = { loadURL: vi.fn(), getURL: (): string => 'https://www.dola.com/chat',
      executeJavaScript: vi.fn(async (code: string): Promise<unknown> => code.includes('new DataTransfer')
        ? { ok: true, count: 1 }
        : { inputFileCount: 1, visibleAttachmentCount: 1, renderedAttachmentCount: 1, matchingFileNameCount: 1, pending: true }),
    };
    const result = uploadReferenceImages(webview, [{ name: '1.png', mime: 'image/png', base64: 'AA==' }], { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(2000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toBe(false);
    expect(webview.executeJavaScript.mock.calls.filter(([code]) => code.includes('new DataTransfer'))).toHaveLength(1);
  });

  it('上传状态持续不稳定时达到上限退出，禁止绕过门禁', async () => {
    vi.useFakeTimers();
    const webview = { loadURL: vi.fn(), getURL: (): string => 'https://www.dola.com/chat',
      executeJavaScript: vi.fn(async (code: string): Promise<unknown> => code.includes('var finish') ? { ok: true } : true),
    };
    const result = waitForSubmissionControlsStable(webview, 20_000);
    await vi.advanceTimersByTimeAsync(26_000);
    await expect(result).resolves.toBe(false);
  });
});

describe('新版无文字蓝色发送按钮', () => {
  it.each([false, true])('使用实际注入脚本定位，禁用状态为 %s', async (disabled) => {
    const style = { display: 'block', visibility: 'visible', pointerEvents: 'auto', opacity: '1', backgroundColor: 'rgb(0, 102, 255)' };
    const button = { disabled, offsetParent: {}, id: '', innerText: '',
      getAttribute: (): null => null,
      getBoundingClientRect: (): object => ({ left: 970, top: 700, right: 1006, bottom: 736, width: 36, height: 36 }),
    };
    const editor = { offsetParent: {}, parentElement: { querySelectorAll: (): unknown[] => [button], parentElement: null },
      getBoundingClientRect: (): object => ({ left: 300, top: 400, right: 1000, bottom: 680, width: 700, height: 280 }),
    };
    const webview = { loadURL: vi.fn(), getURL: (): string => 'https://www.dola.com/chat',
      executeJavaScript: async (code: string): Promise<unknown> => runInNewContext(code, {
        document: { querySelector: (): null => null, querySelectorAll: (): unknown[] => [editor] },
        window: { getComputedStyle: (): object => style },
      }),
    };
    const target = await findSendButtonTarget(webview);
    expect(target.ok).toBe(!disabled);
    if (!disabled) expect(target).toMatchObject({ position: '988,718', method: 'composer-accent' });
  });
});
