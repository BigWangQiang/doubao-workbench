import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { STORYBOARD_PAGE_SCRIPT } from '../../main/services/storyboardPage';

interface Input { canvasId: string; nodeId: string; attemptId: string }
interface PageAPI {
  regenerate: (input: Input) => Promise<{ clicked: boolean; message?: string }>;
  observe: (input: Input) => Promise<{ state: string; retryReceipt?: { status: string } }>;
  stop: () => void;
}

function fixture(): {
  api: PageAPI; input: Input; clicks: ReturnType<typeof vi.fn>[];
  entities: Record<string, { status: string; asset: { status: string }; transform: { x: number; y: number; width: number; height: number } }>;
  copies: Record<string, { textContent: string }>;
  request: (nodeId: string, code?: number) => void;
  duplicate: () => void;
} {
  const clicks = [vi.fn(), vi.fn()];
  const input = { canvasId: 'canvas', nodeId: 'node', attemptId: 'retry' };
  const entities = Object.fromEntries(['node', 'other'].map(id => [id, { status: 'ready', asset: { status: 'failed' }, transform: { x: 0, y: 0, width: 100, height: 100 } }]));
  const copies = { node: { textContent: '视频生成失败 重新生成' }, other: { textContent: '审核不通过' } };
  let selected: string[] = [], duplicated = false;
  const buttons = clicks.map(click => ({
    click, textContent: '重新生成', isConnected: true, dataset: {},
    getClientRects: (): number[] => [1], getAttribute: (): null => null,
  }));
  const nodes = Object.fromEntries(['node', 'other'].map((id, index) => [id, {
    classList: { contains: (): boolean => selected.includes(id) },
    querySelector: (): null => null,
    querySelectorAll: (): unknown[] => duplicated && id === 'node' ? [buttons[0], { ...buttons[0] }] : [buttons[index]],
    cloneNode: (): unknown => ({ ...copies[id as keyof typeof copies], querySelectorAll: (): unknown[] => [] }),
  }]));
  const canvas = {
    runtime: {
      key: { canvasId: 'canvas' }, itemCreation: { create: (): void => {} },
      tools: { handleBoundary: (): void => {}, activate: (): void => {}, get: (): unknown => ({ effectiveTool: 'select' }) },
      selection: { set: (ids: string[]): void => { selected = ids; }, get: (): unknown => ({ ids: selected }) },
    },
    binding: {
      getProjectionState: (): unknown => ({ document: { itemsById: entities } }),
      getViewportSize: (): unknown => ({ width: 1000, height: 800 }), setViewport: (): void => {},
    },
  };
  const carrier = { __reactFiberFixture: { memoizedProps: canvas } };
  class XHR {
    status = 200; responseText = '{"code":0}'; responseType = '';
    listener?: () => void;
    open(_method: string, _url: string): void {}
    send(_body: string): void { this.listener?.(); }
    addEventListener(_event: string, listener: () => void): void { this.listener = listener; }
  }
  const window: { fetch: typeof fetch; __lalorStoryboardV1?: PageAPI } = { fetch: vi.fn() as unknown as typeof fetch };
  runInNewContext(STORYBOARD_PAGE_SCRIPT, {
    window, XMLHttpRequest: XHR, URL, Request, setTimeout, clearTimeout,
    location: { origin: 'https://www.doubao.com', href: 'https://www.doubao.com/chat/fixture' },
    CSS: { escape: (id: string): string => id },
    getComputedStyle: (): unknown => ({ display: 'block', visibility: 'visible' }),
    document: {
      addEventListener: (): void => {}, querySelectorAll: (): unknown[] => [],
      querySelector: (selector: string): unknown => selector === 'button[aria-label="视频生成"]' ? carrier : nodes[selector.match(/data-id="([^"]+)"/)?.[1] || ''] || null,
    },
  });
  return {
    api: window.__lalorStoryboardV1!, input, clicks, entities, copies,
    duplicate: (): void => { duplicated = true; },
    request: (nodeId: string, code = 0): void => {
      const xhr = new XHR(); xhr.responseText = JSON.stringify({ code });
      xhr.open('POST', '/creativity/canvas_workspace/tool/exec');
      xhr.send(JSON.stringify({ req: { binding_item: { id: nodeId } } }));
    },
  };
}

describe('重新生成页面节点与回执边界', (): void => {
  it('只点击当前失败节点，不受其他节点审核文案干扰，同一意图不重复点击', async (): Promise<void> => {
    const { api, input, clicks } = fixture();
    await expect(api.regenerate(input)).resolves.toEqual({ clicked: true });
    await expect(api.regenerate(input)).resolves.toMatchObject({ clicked: false });
    expect(clicks[0]).toHaveBeenCalledTimes(1); expect(clicks[1]).not.toHaveBeenCalled();
  });

  it('已有请求回执和其他节点回执不能确认本次重新生成', async (): Promise<void> => {
    const { api, input, request } = fixture();
    request('node');
    await api.regenerate(input);
    request('other');
    await expect(api.observe(input)).resolves.toMatchObject({ retryReceipt: { status: 'waiting' } });
    request('node');
    await expect(api.observe(input)).resolves.toMatchObject({ retryReceipt: { status: 'settled' } });
  });

  it('本次回执拒绝不能当作受理成功', async (): Promise<void> => {
    const { api, input, request } = fixture();
    await api.regenerate(input); request('node', 403);
    await expect(api.observe(input)).resolves.toMatchObject({ retryReceipt: { status: 'blocked' } });
  });

  it.each(['generating', '审核不通过', 'duplicate', 'stop', 'other-canvas'])('%s 时不点击', async (reason): Promise<void> => {
    const { api, input, entities, copies, clicks, duplicate } = fixture();
    if (reason === 'generating') entities.node.asset.status = 'generating';
    if (reason === '审核不通过') copies.node.textContent = reason;
    if (reason === 'duplicate') duplicate();
    if (reason === 'stop') api.stop();
    if (reason === 'other-canvas') input.canvasId = reason;
    await expect(api.regenerate(input)).resolves.toMatchObject({ clicked: false });
    expect(clicks[0]).not.toHaveBeenCalled(); expect(clicks[1]).not.toHaveBeenCalled();
  });
});
