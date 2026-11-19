import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { STORYBOARD_PAGE_SCRIPT } from '../../main/services/storyboardPage';

interface PageAPI {
  submit: (input: { canvasId: string; nodeId: string }) => Promise<{ clicked: boolean; message?: string }>;
  confirmUnsentDraft: (input: { canvasId: string; nodeId: string }) => Promise<{ draft: boolean }>;
}

function fixture(): { api: PageAPI; request: () => Promise<Response>; entity: { status: string; editor: boolean; asset: { uri: string; status: string } } } {
  const entity = { status: 'ready', editor: true, asset: { uri: '', status: 'init' } };
  const canvas = {
    runtime: { key: { canvasId: 'canvas' }, itemCreation: { create: (): void => {} } },
    binding: { getProjectionState: (): unknown => ({ document: { itemsById: { node: entity } } }), setViewport: (): void => {} },
  };
  const carrier = { __reactFiberTest: { memoizedProps: canvas } };
  class XHR { open(): void {} send(): void {} addEventListener(): void {} }
  const window: { fetch: typeof fetch; __lalorStoryboardV1?: PageAPI } = {
    fetch: async (): Promise<Response> => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
  };
  runInNewContext(STORYBOARD_PAGE_SCRIPT, {
    window, XMLHttpRequest: XHR, URL, Request, setTimeout, clearTimeout,
    location: { origin: 'https://www.doubao.com', href: 'https://www.doubao.com/chat/test' },
    CSS: { escape: (value: string): string => value },
    document: { addEventListener: (): void => {}, querySelector: (selector: string): unknown => selector === 'button[aria-label="视频生成"]' ? carrier : null },
  });
  return {
    api: window.__lalorStoryboardV1!, entity,
    request: (): Promise<Response> => window.fetch('/creativity/canvas_workspace/tool/exec', { body: JSON.stringify({ req: { binding_item: { id: 'node' } } }) }),
  };
}

describe('分镜发送前后证据边界', (): void => {
  it('没有复核票据时明确返回未点击，不伪装为发送结果不明', async (): Promise<void> => {
    const { api } = fixture();
    await expect(api.submit({ canvasId: 'canvas', nodeId: 'node' })).resolves.toMatchObject({ clicked: false, message: expect.stringContaining('复核已失效') });
  });
  it('原节点已有生成状态时禁止人工恢复草稿', async (): Promise<void> => {
    const { api, entity } = fixture(); entity.asset.status = 'generating';
    await expect(api.confirmUnsentDraft({ canvasId: 'canvas', nodeId: 'node' })).rejects.toThrow('不是未生成草稿');
  });
  it('即便投影仍显示草稿，观察到请求后也禁止清除意图', async (): Promise<void> => {
    const { api, request } = fixture();
    await expect(api.confirmUnsentDraft({ canvasId: 'canvas', nodeId: 'node' })).resolves.toEqual({ draft: true });
    await request();
    await expect(api.confirmUnsentDraft({ canvasId: 'canvas', nodeId: 'node' })).rejects.toThrow('存在发送或生成记录');
  });
});
