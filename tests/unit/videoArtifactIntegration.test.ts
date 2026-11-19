/**
 * tests/unit/videoArtifactIntegration.test.ts
 *
 * 集成级 mock 测试：使用模拟 WebviewHandle 测试 resolveVideoArtifact 的
 * 全局 deadline、取消中止、旧候选拒绝绑定、带 vid 候选成功绑定。
 *
 * 这些测试验证策略编排层的时序与过滤行为，不依赖真实豆包页面。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveVideoArtifact,
  manualResolveVideoArtifact,
} from '../../src/utils/doubaoBridge';
import type { WebviewHandle } from '../../src/utils/doubaoBridge';

// ==================== Mock WebviewHandle ====================

/**
 * 创建一个模拟 WebviewHandle，按注入代码中的特征字符串返回预设值。
 * executeJavaScript 接收一段代码字符串，根据其中包含的关键词返回不同的 mock 响应。
 */
function createMockWebview(responses: {
  cache?: {
    found: boolean;
    vid?: string;
    videoUrl?: string;
    fieldSource?: string;
    captureToken?: string;
    resetAt?: number;
    capturedAt?: number;
    watermarkFreeProof?: string;
  } | null;
  playInfo?: { status: number; data: unknown } | null;
  withoutWatermark?: { status: number; data: unknown } | null;
  creationList?: { found: boolean; resourceId: string | null; status: number } | null;
  downloadInfo?: { status: number; data: unknown } | null;
  structuredData?: unknown[] | null;
  domUrls?: string[];
  resultUrl?: string;
}): WebviewHandle {
  const mock: WebviewHandle = {
    executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
      // 模拟网络延迟
      await new Promise((r) => setTimeout(r, 10));

      // scanConversationStructured — 必须在 __doubaoVideoCache 之前检测
      // （因为 scanConversationStructured 的代码中也包含 '__doubaoVideoCache' 字符串）
      if (code.includes('__NEXT_DATA__') || code.includes('__PRELOADED_STATE__')) {
        return responses.structuredData ?? [];
      }

      // getCachedVideoUrl — 检测 window.__doubaoVideoCache（精确匹配，避免误匹配 globals 数组）
      if (code.includes('window.__doubaoVideoCache')) {
        return responses.cache ?? { found: false };
      }

      // fetchPlayInfoRaw — 检测 get_play_info
      if (code.includes('get_play_info')) {
        if (responses.playInfo === null) return { status: 0, data: null, error: 'timeout' };
        return responses.playInfo;
      }

      if (code.includes('get_without_watermark')) {
        if (responses.withoutWatermark === null) return { status: 0, data: null, error: 'timeout' };
        return responses.withoutWatermark;
      }

      // fetchCreationDownloadInfo step 1 — 检测 get_creation_list
      if (code.includes('get_creation_list')) {
        if (responses.creationList === null) return { found: false, resourceId: null, status: 0, error: 'timeout' };
        return responses.creationList;
      }

      // fetchCreationDownloadInfo step 2 — 检测 aispace/get_download_info
      if (code.includes('aispace/get_download_info')) {
        if (responses.downloadInfo === null) return { status: 0, data: null, error: 'timeout' };
        return responses.downloadInfo;
      }

      // scanConversationForVideoUrls — 检测 querySelectorAll('video')
      if (code.includes("querySelectorAll('video')")) {
        return responses.domUrls ?? [];
      }

      // getResultUrl — 检测 JSON.stringify(urls)
      if (code.includes('JSON.stringify(urls)')) {
        return responses.resultUrl ?? '[]';
      }

      return null;
    }),
    loadURL: vi.fn(),
    getURL: vi.fn(() => 'https://www.doubao.com/chat/'),
  };
  return mock;
}

// ==================== 测试 ====================

describe('resolveVideoArtifact 集成测试', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- 1. 带 vid 的候选成功绑定 ----

  it('缓存命中 vid + original_media_info 时成功绑定原始地址', async () => {
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_test_001',
        videoUrl: 'https://vod.example.com/video/original.mp4',
        fieldSource: 'original_media_info',
      },
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/?conversation_id=conv1',
      timeoutMs: 5000,
    });

    expect(result.status).toBe('resolved');
    expect(result.url).toBe('https://vod.example.com/video/original.mp4');
    expect(result.vid).toBe('vid_test_001');
  });

  it('缓存命中 vid + play_info（非原始）时成功绑定但标记为非原始', async () => {
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_test_002',
        videoUrl: 'https://vod.example.com/video/play_info.mp4',
        fieldSource: 'play_info',
      },
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/?conversation_id=conv1',
      timeoutMs: 5000,
    });

    expect(result.status).toBe('resolved');
    expect(result.url).toBe('https://vod.example.com/video/play_info.mp4');
  });

  // ---- 2. 单个旧候选拒绝绑定 ----

  it('无 vid 且有 conversationUrl 时拒绝单个无 vid 的 page_fallback 候选', async () => {
    const webview = createMockWebview({
      cache: { found: false },
      // 无 play_info/download_info（无 vid 无法调用）
      structuredData: [],
      domUrls: ['https://vod.example.com/video/stale_old_video.mp4'],
      resultUrl: '["https://vod.example.com/video/stale_result.mp4"]',
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/?conversation_id=conv_stale',
      timeoutMs: 5000,
    });

    // 有候选但无法证明归属 → needs_manual_selection
    expect(result.status).toBe('needs_manual_selection');
    expect(result.url).toBeUndefined();
  });

  it('无 vid 且有 conversationUrl 时拒绝单个无 vid 的 conversation_scan 候选', async () => {
    const webview = createMockWebview({
      cache: { found: false },
      structuredData: [
        {
          messages: [
            {
              // 无 vid，仅有 play_info URL（无法证明属于当前会话）
              play_info: {
                main: 'https://vod.example.com/video/scan_no_vid.mp4',
              },
            },
          ],
        },
      ],
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/?conversation_id=conv_scan',
      timeoutMs: 5000,
    });

    expect(result.status).toBe('needs_manual_selection');
    expect(result.url).toBeUndefined();
  });

  // ---- 3. 带 vid 的候选成功绑定（从 conversation_scan 发现 vid） ----

  it('conversation_scan 发现 vid + original_media_info 时成功绑定', async () => {
    const webview = createMockWebview({
      cache: { found: false },
      structuredData: [
        {
          props: {
            pageProps: {
              video: {
                vid: 'vid_from_scan_123',
                original_media_info: {
                  main_url: 'https://vod.example.com/video/scan_orig.mp4',
                },
              },
            },
          },
        },
      ],
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/?conversation_id=conv_scan_ok',
      timeoutMs: 5000,
    });

    expect(result.status).toBe('resolved');
    expect(result.url).toBe('https://vod.example.com/video/scan_orig.mp4');
    expect(result.vid).toBe('vid_from_scan_123');
  });

  // ---- 4. 取消中止 ----

  it('AbortSignal 在策略 1 后取消时停止后续策略', async () => {
    const controller = new AbortController();
    const executeCalls: string[] = [];

    const webview: WebviewHandle = {
      executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
        // 记录调用顺序
        if (code.includes('__doubaoVideoCache')) executeCalls.push('cache');
        else if (code.includes('get_play_info')) executeCalls.push('play_info');
        else if (code.includes('get_creation_list')) executeCalls.push('creation_list');
        else if (code.includes('get_download_info')) executeCalls.push('download_info');
        else if (code.includes('__NEXT_DATA__')) executeCalls.push('structured');
        else if (code.includes("querySelectorAll('video')")) executeCalls.push('dom_urls');
        else if (code.includes('JSON.stringify(urls)')) executeCalls.push('result_url');
        else executeCalls.push('other');

        await new Promise((r) => setTimeout(r, 10));

        if (code.includes('__doubaoVideoCache')) {
          // 返回有 vid 的缓存，触发后续策略
          return {
            found: true,
            vid: 'vid_cancel_test',
            videoUrl: 'https://vod.example.com/video/cancel.mp4',
            fieldSource: 'original_media_info',
          };
        }
        return null;
      }),
      loadURL: vi.fn(),
      getURL: vi.fn(() => 'https://www.doubao.com/chat/'),
    };

    // 在策略 1 返回后立即取消
    const originalExecute = webview.executeJavaScript;
    webview.executeJavaScript = vi.fn(async (code: string) => {
      const result = await originalExecute(code);
      if (code.includes('__doubaoVideoCache')) {
        // 策略 1 完成后取消
        controller.abort();
      }
      return result;
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/?conversation_id=conv_cancel',
      timeoutMs: 10000,
      signal: controller.signal,
    });

    // 策略 1 应该执行了
    expect(executeCalls).toContain('cache');
    // 后续策略不应执行（因为已取消）
    expect(executeCalls).not.toContain('play_info');
    expect(executeCalls).not.toContain('creation_list');

    // 虽然取消了，但策略 1 已拿到候选，应返回 resolved
    expect(result.status).toBe('resolved');
    expect(result.url).toBe('https://vod.example.com/video/cancel.mp4');
  });

  // ---- 5. 全局 deadline ----

  it('timeoutMs 过短时所有策略在预算内完成或跳过', async () => {
    // 使用极短超时，确保 deadline 机制生效
    const webview = createMockWebview({
      cache: { found: false },
      structuredData: [],
      domUrls: [],
      resultUrl: '[]',
    });

    const start = Date.now();
    const result = await resolveVideoArtifact(webview, {
      timeoutMs: 2000,
    });
    const elapsed = Date.now() - start;

    // 所有策略应在合理时间内完成（即使每步最少 1 秒）
    // 关键是不超过 timeoutMs 的 2 倍（容忍 safeExecuteJS 的 race 开销）
    expect(elapsed).toBeLessThan(5000);
    expect(result.status).toBe('unavailable');
  });
});

  // ---- 6. manualResolveVideoArtifact 取消 ----

  it('manualResolveVideoArtifact 传入已取消的 signal 时立即返回', async () => {
    const controller = new AbortController();
    controller.abort();

    const webview = createMockWebview({});

    const result = await manualResolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/?conversation_id=conv_aborted',
      timeoutMs: 15000,
      signal: controller.signal,
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('取消');
    // 不应执行任何 webview 调用
    expect(webview.executeJavaScript).not.toHaveBeenCalled();
  });

  // ---- 7. 官方无水印能力解析 ----

  it('官方无水印接口明确开放时返回对应 vid 的下载地址', async () => {
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_aispace_001',
        videoUrl: '', // 缓存无 URL，触发后续策略
        fieldSource: '',
      },
      playInfo: { status: 200, data: { data: {} } }, // play_info 无有效 URL
      withoutWatermark: {
        status: 200,
        data: {
          code: 0,
          data: {
            without_watermark: true,
            download_video: {
              vid_aispace_001: { download_url: 'https://vod.example.com/video/aispace_no_wm.mp4' },
            },
          },
        },
      },
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/?conversation_id=conv_aispace',
      timeoutMs: 10000,
    });

    expect(result.status).toBe('resolved');
    expect(result.url).toBe('https://vod.example.com/video/aispace_no_wm.mp4');
    expect(result.source).toBe('platform_download_info');
  });

  it('创作空间第一步未找到 vid 时返回 null 不影响后续策略', async () => {
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_not_in_list',
        videoUrl: '',
        fieldSource: '',
      },
      playInfo: {
        status: 200,
        data: {
          data: {
            original_media_info: {
              main_url: 'https://vod.example.com/video/from_play_info.mp4',
            },
          },
        },
      },
      creationList: { found: false, resourceId: null, status: 200 },
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/?conversation_id=conv_fallback',
      timeoutMs: 10000,
    });

    // 创作空间失败，但 play_info 成功 → 仍应 resolved
    expect(result.status).toBe('resolved');
    expect(result.url).toBe('https://vod.example.com/video/from_play_info.mp4');
    expect(result.source).toBe('play_info');
  });

  // ---- 8. 扫描仅得到 vid 后回补 API 策略 ----

  it('扫描仅得到 vid（无 URL）后回补 play_info 成功解析', async () => {
    const webview = createMockWebview({
      cache: { found: false },
      playInfo: {
        status: 200,
        data: {
          data: {
            original_media_info: {
              main_url: 'https://vod.example.com/video/scan_vid_retry.mp4',
            },
          },
        },
      },
      structuredData: [
        {
          props: {
            pageProps: {
              video: {
                // 只有 vid，没有 original_media_info / play_info 等 URL 字段
                vid: 'vid_scan_only_001',
              },
            },
          },
        },
      ],
      domUrls: [],
      resultUrl: '[]',
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/?conversation_id=conv_vid_only',
      timeoutMs: 10000,
    });

    expect(result.status).toBe('resolved');
    expect(result.url).toBe('https://vod.example.com/video/scan_vid_retry.mp4');
    expect(result.source).toBe('play_info');
    expect(result.vid).toBe('vid_scan_only_001');

    // play_info 必须被调用过（仅在回补阶段，因为初始无 vid 时被跳过）
    const playInfoCalls = (webview.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('get_play_info'),
    );
    expect(playInfoCalls.length).toBeGreaterThan(0);
  });

  it('新播放器 React video props 中的 vid 会回补接口，但无扩展证明时拒绝归档', async () => {
    const executeJavaScript = vi.fn(async (code: string): Promise<unknown> => {
      if (code.includes('window.__doubaoVideoCache')) return { found: false };
      if (code.includes('__reactFiber$')) {
        return [{ video: { vid: 'vid_react_player_001', creation_task_id: 'task_001' } }];
      }
      if (code.includes('get_play_info')) {
        return {
          status: 200,
          data: {
            data: {
              original_media_info: {
                main_url: 'https://vod.example.com/video/react_player_original.mp4',
              },
            },
          },
        };
      }
      if (code.includes('get_without_watermark')) {
        return {
          status: 200,
          data: {
            code: 0,
            data: {
              without_watermark: true,
              download_video: {
                vid_react_player_001: {
                  download_url: 'https://vod.example.com/video/react_player_without_watermark.mp4',
                },
              },
            },
          },
        };
      }
      if (code.includes("querySelectorAll('video')")) return [];
      if (code.includes('JSON.stringify(urls)')) return '[]';
      return null;
    });
    const webview: WebviewHandle = {
      executeJavaScript,
      loadURL: vi.fn(),
      getURL: vi.fn(() => 'https://www.doubao.com/chat/38437390431449858'),
    };

    const result = await manualResolveVideoArtifact(webview, {
      conversationUrl: webview.getURL(),
      timeoutMs: 5000,
    });

    expect(result.status).toBe('unavailable');
    expect(result.vid).toBe('vid_react_player_001');
    expect(result.url).toBeUndefined();
    expect(result.attempts).toContainEqual(expect.objectContaining({
      strategy: 'platform_download_info',
      result: 'success',
    }));
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('__reactFiber$'),
    );
    const structuredProbe = (executeJavaScript as ReturnType<typeof vi.fn>).mock.calls
      .map((args: unknown[]) => args[0])
      .find((code: unknown) => typeof code === 'string' && code.includes('__reactFiber$')) as string;
    expect(structuredProbe).toContain('__reactProps$');
    expect(structuredProbe).toContain('findVideoInProps');
  });

  it('官方明确无水印不可用时手动入口不回退普通源媒体', async () => {
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_watermark_denied_001',
        videoUrl: 'https://vod.example.com/video/captured_original.mp4',
        fieldSource: 'original_media_info',
      },
      playInfo: {
        status: 200,
        data: {
          data: {
            original_media_info: {
              main_url: 'https://vod.example.com/video/play_info_original.mp4',
            },
          },
        },
      },
      withoutWatermark: {
        status: 200,
        data: { code: 0, data: { without_watermark: false } },
      },
      structuredData: [],
      domUrls: [],
      resultUrl: '[]',
    });

    const result = await manualResolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/denied',
      timeoutMs: 5000,
    });

    expect(result.status).toBe('unavailable');
    expect(result.url).toBeUndefined();
    expect(result.reason).toContain('without_watermark=false');
    expect(result.attempts).toContainEqual(expect.objectContaining({
      strategy: 'platform_download_info',
      result: 'fail',
    }));
  });

  it('Dola chain 播放地址不被当作无水印候选', async () => {
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_dola_chain_001',
        videoUrl: 'https://vod.example.com/video/dola_chain_playback.mp4',
        fieldSource: 'dola_chain_media',
      },
      playInfo: {
        status: 200,
        data: { data: { original_media_info: { main_url: 'https://vod.example.com/video/dola_playback.mp4' } } },
      },
      withoutWatermark: {
        status: 200,
        data: { code: 0, data: { without_watermark: false } },
      },
      structuredData: [],
      domUrls: [],
      resultUrl: '[]',
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.dola.com/chat/dola_chain_001',
      timeoutMs: 5000,
      requireWithoutWatermark: true,
    });

    expect(result.status).toBe('unavailable');
    expect(result.url).toBeUndefined();
    expect(result.reason).toContain('without_watermark=false');
  });

  it('Dola 内置扩展解码地址可作为无水印候选', async () => {
    const url = 'https://vod.example.com/video/dola_extension_source.mp4';
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_dola_extension_001',
        videoUrl: url,
        fieldSource: 'dola_extension',
        captureToken: 'capture-dola-current',
        resetAt: 1000,
        capturedAt: 1001,
        watermarkFreeProof: 'dola_extension_decoded_v1',
      },
      playInfo: { status: 200, data: { data: {} } },
      withoutWatermark: {
        status: 200,
        data: { code: 0, data: { without_watermark: false } },
      },
      structuredData: [],
      domUrls: [],
      resultUrl: '[]',
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.dola.com/chat/dola_extension_001',
      timeoutMs: 5000,
      requireWithoutWatermark: true,
    });

    expect(result.status).toBe('resolved');
    expect(result.url).toBe(url);
    expect(result.source).toBe('dola_extension');
  });

  it('豆包扩展无水印 fallback 地址可作为强制无水印候选', async () => {
    const url = 'https://vod.example.com/video/doubao-unwatermarked.mp4?logo_type=unwatermarked';
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_doubao_extension_001',
        videoUrl: url,
        fieldSource: 'doubao_extension',
        captureToken: 'capture-doubao-current',
        resetAt: 2000,
        capturedAt: 2001,
        watermarkFreeProof: 'doubao_fallback_unwatermarked_v1',
      },
      playInfo: { status: 200, data: { data: {} } },
      withoutWatermark: {
        status: 200,
        data: { code: 0, data: { without_watermark: false } },
      },
      structuredData: [],
      domUrls: [],
      resultUrl: '[]',
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/doubao_extension_001',
      timeoutMs: 5000,
      requireWithoutWatermark: true,
    });

    expect(result.status).toBe('resolved');
    expect(result.url).toBe(url);
    expect(result.source).toBe('doubao_extension');
  });

  it('平台误报无水印但 URL 明确带水印时，必须使用豆包扩展候选', async () => {
    const extensionUrl = 'https://vod.example.com/video/doubao-clean.mp4?lr=unwatermarked';
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_doubao_platform_mismatch_001',
        videoUrl: extensionUrl,
        fieldSource: 'doubao_extension',
        captureToken: 'capture-platform-mismatch',
        resetAt: 2500,
        capturedAt: 2501,
        watermarkFreeProof: 'doubao_fallback_unwatermarked_v1',
      },
      playInfo: { status: 200, data: { data: {} } },
      withoutWatermark: {
        status: 200,
        data: {
          code: 0,
          data: {
            without_watermark: true,
            download_video: {
              vid_doubao_platform_mismatch_001: {
                download_url: 'https://vod.example.com/video/platform.mp4?lr=video_gen_watermark_dyn',
              },
            },
          },
        },
      },
      structuredData: [],
      domUrls: [],
      resultUrl: '[]',
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/platform_mismatch_001',
      timeoutMs: 5000,
      requireWithoutWatermark: true,
      captureToken: 'capture-platform-mismatch',
    });

    expect(result.status).toBe('resolved');
    expect(result.url).toBe(extensionUrl);
    expect(result.source).toBe('doubao_extension');
    expect(result.attempts).toContainEqual(expect.objectContaining({
      strategy: 'platform_download_info',
      result: 'fail',
    }));
  });

  it('豆包扩展缺少无水印证明时 fail-closed', async () => {
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_doubao_no_proof_001',
        videoUrl: 'https://vod.example.com/video/no-proof.mp4',
        fieldSource: 'doubao_extension',
        captureToken: 'capture-no-proof',
        resetAt: 3000,
        capturedAt: 3001,
      },
      playInfo: { status: 200, data: { data: {} } },
      withoutWatermark: { status: 200, data: { code: 0, data: { without_watermark: false } } },
      structuredData: [], domUrls: [], resultUrl: '[]',
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/no_proof_001',
      timeoutMs: 5000,
      requireWithoutWatermark: true,
      captureToken: 'capture-no-proof',
    });

    expect(result.status).toBe('unavailable');
    expect(result.url).toBeUndefined();
  });

  it('旧任务捕获令牌不能绑定到当前豆包视频任务', async () => {
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_doubao_old_capture_001',
        videoUrl: 'https://vod.example.com/video/old-capture.mp4?logo_type=unwatermarked',
        fieldSource: 'doubao_extension',
        captureToken: 'capture-old',
        resetAt: 4000,
        capturedAt: 4001,
        watermarkFreeProof: 'doubao_fallback_unwatermarked_v1',
      },
      playInfo: { status: 200, data: { data: {} } },
      withoutWatermark: { status: 200, data: { code: 0, data: { without_watermark: false } } },
      structuredData: [], domUrls: [], resultUrl: '[]',
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/old_capture_001',
      timeoutMs: 5000,
      requireWithoutWatermark: true,
      captureToken: 'capture-current',
    });

    expect(result.status).toBe('unavailable');
    expect(result.url).toBeUndefined();
    expect(result.attempts[0].reason).toContain('token=mismatch');
  });

  it('扩展证明有效也拒绝明确带 video_gen_watermark_dyn 的地址', async () => {
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_doubao_watermarked_001',
        videoUrl: 'https://vod.example.com/video/result.mp4?logo_type=unwatermarked&lr=video_gen_watermark_dyn',
        fieldSource: 'doubao_extension',
        captureToken: 'capture-watermark',
        resetAt: 5000,
        capturedAt: 5001,
        watermarkFreeProof: 'doubao_fallback_unwatermarked_v1',
      },
      playInfo: { status: 200, data: { data: {} } },
      withoutWatermark: { status: 200, data: { code: 0, data: { without_watermark: false } } },
      structuredData: [], domUrls: [], resultUrl: '[]',
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/watermarked_001',
      timeoutMs: 5000,
      requireWithoutWatermark: true,
      captureToken: 'capture-watermark',
    });

    expect(result.status).toBe('unavailable');
    expect(result.url).toBeUndefined();
  });

  it('豆包普通捕获播放流在强制无水印模式下仍被拒绝', async () => {
    const webview = createMockWebview({
      cache: {
        found: true,
        vid: 'vid_doubao_captured_001',
        videoUrl: 'https://vod.example.com/video/result.mp4?lr=video_gen_watermark_dyn',
        fieldSource: 'play_info',
      },
      playInfo: { status: 200, data: { data: {} } },
      withoutWatermark: {
        status: 200,
        data: { code: 0, data: { without_watermark: false } },
      },
      structuredData: [],
      domUrls: [],
      resultUrl: '[]',
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/doubao_captured_001',
      timeoutMs: 5000,
      requireWithoutWatermark: true,
    });

    expect(result.status).toBe('unavailable');
    expect(result.url).toBeUndefined();
  });

  it('手动提取历史豆包会话会重载当前会话，并接收同 vid 的扩展无水印结果', async () => {
    const conversationUrl = 'https://www.doubao.com/chat/manual-history-001';
    const vid = 'vid_manual_history_001';
    const cleanUrl = 'https://vod.example.com/video/manual-clean.mp4?logo_type=unwatermarked';
    let reloaded = false;
    let captureToken = '';
    const loadURL = vi.fn(() => { reloaded = true; });
    const webview: WebviewHandle = {
      getURL: () => conversationUrl,
      loadURL,
      executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
        if (code.includes("sessionStorage.setItem('__lalorManualVideoCaptureV1'") ||
            code.includes('sessionStorage.setItem("__lalorManualVideoCaptureV1"')) {
          const tokenMatch = code.match(/manual:[0-9]+:[a-z0-9]+/i);
          captureToken = tokenMatch?.[0] || '';
          return true;
        }
        if (code.includes('window.__doubaoVideoCache')) {
          return reloaded && captureToken
            ? {
              found: true,
              vid,
              videoUrl: cleanUrl,
              fieldSource: 'doubao_extension',
              captureToken,
              resetAt: 1000,
              capturedAt: 1001,
              watermarkFreeProof: 'doubao_fallback_unwatermarked_v1',
            }
            : { found: false };
        }
        if (code.includes('__NEXT_DATA__') || code.includes('__PRELOADED_STATE__')) {
          return [{ video: { vid } }];
        }
        if (code.includes('get_play_info')) return { status: 200, data: { data: {} } };
        if (code.includes('get_without_watermark')) {
          return { status: 200, data: { code: 0, data: { without_watermark: false } } };
        }
        if (code.includes("querySelectorAll('video')")) return [];
        if (code.includes('JSON.stringify(urls)')) return '[]';
        return true;
      }),
    };

    const result = await manualResolveVideoArtifact(webview, {
      conversationUrl,
      timeoutMs: 12_000,
      isManual: true,
    });

    expect(loadURL).toHaveBeenCalledWith(conversationUrl);
    expect(result.status).toBe('resolved');
    expect(result.url).toBe(cleanUrl);
    expect(result.source).toBe('doubao_extension');
    expect(result.vid).toBe(vid);
  });

  it('手动提取历史 Dola 会话会重载当前会话，并接收同 vid 的扩展无水印结果', async () => {
    const conversationUrl = 'https://www.dola.com/chat/manual-history-001';
    const vid = 'vid_dola_manual_history_001';
    const cleanUrl = 'https://vod.example.com/video/dola-manual-clean.mp4';
    let reloaded = false;
    let captureToken = '';
    const loadURL = vi.fn(() => { reloaded = true; });
    const webview: WebviewHandle = {
      getURL: () => conversationUrl,
      loadURL,
      executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
        if (code.includes("sessionStorage.setItem('__lalorManualVideoCaptureV1'") ||
            code.includes('sessionStorage.setItem("__lalorManualVideoCaptureV1"')) {
          const tokenMatch = code.match(/manual:[0-9]+:[a-z0-9]+/i);
          captureToken = tokenMatch?.[0] || '';
          return true;
        }
        if (code.includes('window.__doubaoVideoCache')) {
          return reloaded && captureToken
            ? {
              found: true,
              vid,
              videoUrl: cleanUrl,
              fieldSource: 'dola_extension',
              captureToken,
              resetAt: 1000,
              capturedAt: 1001,
              watermarkFreeProof: 'dola_extension_decoded_v1',
            }
            : { found: false };
        }
        if (code.includes('__NEXT_DATA__') || code.includes('__PRELOADED_STATE__')) {
          return [{ video: { vid } }];
        }
        if (code.includes('get_play_info')) return { status: 200, data: { data: {} } };
        if (code.includes('get_without_watermark')) {
          return { status: 200, data: { code: 0, data: { without_watermark: false } } };
        }
        if (code.includes("querySelectorAll('video')")) return [];
        if (code.includes('JSON.stringify(urls)')) return '[]';
        return true;
      }),
    };

    const result = await manualResolveVideoArtifact(webview, {
      conversationUrl,
      timeoutMs: 12_000,
      isManual: true,
    });

    expect(loadURL).toHaveBeenCalledWith(conversationUrl);
    expect(result.status).toBe('resolved');
    expect(result.url).toBe(cleanUrl);
    expect(result.source).toBe('dola_extension');
    expect(result.vid).toBe(vid);
  });

  it('扫描仅得到 vid 后回补 platform_download_info 成功解析', async () => {
    const webview = createMockWebview({
      cache: { found: false },
      // play_info 回补时返回空数据（无有效 URL）
      playInfo: { status: 200, data: { data: {} } },
      withoutWatermark: {
        status: 200,
        data: {
          code: 0,
          data: {
            without_watermark: true,
            download_video: {
              vid_scan_only_002: { download_url: 'https://vod.example.com/video/scan_vid_retry_dl.mp4' },
            },
          },
        },
      },
      structuredData: [
        {
          props: {
            pageProps: {
              video: {
                vid: 'vid_scan_only_002',
              },
            },
          },
        },
      ],
      domUrls: [],
      resultUrl: '[]',
    });

    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/?conversation_id=conv_vid_only_002',
      timeoutMs: 10000,
    });

    expect(result.status).toBe('resolved');
    expect(result.url).toBe('https://vod.example.com/video/scan_vid_retry_dl.mp4');
    expect(result.source).toBe('platform_download_info');
    expect(result.vid).toBe('vid_scan_only_002');
  });

  // ---- 9. fetch 进行中取消时立即返回 ----

  it('fetch 请求进行中 signal.abort() 时立即返回，不等待自身超时', async () => {
    const controller = new AbortController();

    const webview: WebviewHandle = {
      executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
        // 缓存返回 vid 但无 URL，触发 play_info 策略
        if (code.includes('__doubaoVideoCache')) {
          return {
            found: true,
            vid: 'vid_abort_inflight_001',
            videoUrl: '',
            fieldSource: '',
          };
        }
        // play_info 模拟长时间网络请求（5 秒后才返回）
        if (code.includes('get_play_info')) {
          await new Promise((r) => setTimeout(r, 5000));
          return { status: 200, data: { data: {} } };
        }
        return null;
      }),
      loadURL: vi.fn(),
      getURL: vi.fn(() => 'https://www.doubao.com/chat/'),
    };

    // 100ms 后取消（模拟用户在请求等待期间点击取消）
    setTimeout(() => controller.abort(), 100);

    const start = Date.now();
    const result = await resolveVideoArtifact(webview, {
      conversationUrl: 'https://www.doubao.com/chat/?conversation_id=conv_abort_inflight',
      timeoutMs: 15000,
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;

    // 应在取消后很快返回（~100ms + 开销），绝不应等待 play_info 的 5 秒
    expect(elapsed).toBeLessThan(2000);
    // 未获取到有效候选
    expect(result.status).toBe('unavailable');
  });
