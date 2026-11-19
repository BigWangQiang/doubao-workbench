import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decodeDolaMediaUrl,
  buildDoubaoUnwatermarkedFallbackUrl,
  extractDolaMediaItems,
  extractDolaMediaVid,
  extractDolaSubmissionConfig,
  extractDoubaoFallbackApis,
  filterDoubaoFallbackApisForVid,
  extractDoubaoMediaItems,
  extractDoubaoMediaVid,
  getDolaPausedRequestStage,
  patchActionBarDuration,
  patchSkillPackDuration,
  resolveDoubaoFallbackVideoItems,
  fetchDoubaoFallbackJson,
  shouldQueueDolaResponse,
  shouldCaptureDolaNetworkResponse,
  shouldCaptureDoubaoCanvasResponse,
  MANUAL_VIDEO_CAPTURE_PRELOAD_SCRIPT,
  MANUAL_VIDEO_CAPTURE_STORAGE_KEY,
} from '../../main/utils/dolaExtensionNetwork';
import {
  DOLA_VIDEO_CONTROL_READINESS_TIMEOUT_MS,
  DOLA_VIDEO_DURATION_SELECTION_MAX_ATTEMPTS,
  matchesDolaDurationLabel,
  normalizeDolaDurationLabel,
  normalizeDolaModelLabel,
} from '../../src/utils/doubaoBridge';
import type { WebContents } from 'electron';

describe('Dola 内置扩展网络桥接', () => {
  it('只监听豆包域名下的画布响应，不匹配伪造主机或查询参数', () => {
    expect(shouldCaptureDoubaoCanvasResponse('https://www.doubao.com/creativity/canvas_workspace/get')).toBe(true);
    expect(shouldCaptureDoubaoCanvasResponse('https://www.doubao.com/creativity/canvas_workspace/tool/exec')).toBe(true);
    expect(shouldCaptureDoubaoCanvasResponse('https://www.doubao.com/assets/app.js?x=canvas_workspace')).toBe(false);
    expect(shouldCaptureDoubaoCanvasResponse('https://example.com/doubao.com/canvas_workspace')).toBe(false);
    expect(shouldCaptureDoubaoCanvasResponse('https://doubao.com.example.com/canvas_workspace')).toBe(false);
  });
  it('只观察 Dola 的 chain/completion 响应，不拦截豆包或普通资源', () => {
    expect(shouldCaptureDolaNetworkResponse('https://www.dola.com/im/chain/single')).toBe(true);
    expect(shouldCaptureDolaNetworkResponse('https://www.dola.com/samantha/chat/completion')).toBe(true);
    expect(shouldCaptureDolaNetworkResponse('https://www.dola.com/assets/app.js')).toBe(false);
    expect(shouldCaptureDolaNetworkResponse('https://www.doubao.com/im/chain/single')).toBe(false);
    expect(shouldCaptureDolaNetworkResponse('https://api.example.com/dola.com/chat/completion')).toBe(false);
  });

  it('Dola 长连接通过 Network 完成事件后台捕获，不进入 Fetch 暂停列表', () => {
    const source = readFileSync(resolve(process.cwd(), 'main/utils/dolaExtensionNetwork.ts'), 'utf8');
    expect(source).toContain("method === 'Network.responseReceived'");
    expect(source).toContain("method === 'Network.loadingFinished'");
    expect(source).toContain("method === 'Network.loadingFailed'");
    expect(source).toContain("sendCommand(contents, 'Network.enable')");
    expect(source).toContain('dolaNetworkResponses.delete(contents)');
    expect(source).not.toContain('`*${DOLA_CHAIN_SINGLE_URL_PART}*`, requestStage: \'Request\'');
    expect(source).not.toContain('`*${DOLA_CHAIN_SINGLE_URL_PART}*`, requestStage: \'Response\'');
    expect(source).not.toContain('`*dola.com/*chat/completion*`, requestStage: \'Response\'');
  });

  it('区分同一 requestId 的 Request/Response 阶段并排队交接', () => {
    expect(getDolaPausedRequestStage({})).toBe('request');
    expect(getDolaPausedRequestStage({ responseStatusCode: 200 })).toBe('response');
    expect(getDolaPausedRequestStage({ responseErrorReason: 'Failed' })).toBe('response');
    expect(getDolaPausedRequestStage({ responseHeaders: [] })).toBe('response');
    expect(shouldQueueDolaResponse('request', 'response')).toBe(true);
    expect(shouldQueueDolaResponse('request', 'request')).toBe(false);
    expect(shouldQueueDolaResponse('response', 'response')).toBe(false);
  });

  it('非 Dola skill-pack 只补 30s，不误加 Dola Fast 的 15s', () => {
    const source = JSON.stringify({ data: { video_generation: { meta: {
      option_list: [{ value: 'duration', options: [{ show_name: '10s', value: '10' }] }, {
        value: 'model', options: [
          { show_name: 'Seedance 2.5', value: 'seedance_v2.5' },
          { show_name: 'Seedance 2.0 Fast', value: 'seedance_v2.0_fast' },
        ],
      }],
    } } } });
    const result = JSON.parse(patchSkillPackDuration(source)) as {
      data: { video_generation: { meta: { option_list: Array<{ value: string; options?: Array<{ value: string }> }> } } };
    };
    const options = result.data.video_generation.meta.option_list;
    const duration = options.find((option) => option.value === 'duration');
    const model = options.find((option) => option.value === 'model');
    expect(duration?.options?.some((option) => option.value === '30')).toBe(true);
    expect(duration?.options?.some((option) => option.value === '15')).toBe(false);
    expect(model?.options?.map((option) => option.value)).toEqual(['seedance_v2.5', 'seedance_v2.0_fast']);
  });

  it('实时 Dola skill-pack 为 2.0 Fast 补 15s，且不扩散到其它模型', () => {
    const source = JSON.stringify({ data: { video_generation: { meta: {
      option_list: [{ value: 'duration', options: [{ show_name: '10s', value: '10' }] }, {
        value: 'model', options: [
          { show_name: 'Seedance2.0Fast', value: 'seedance_v2.0' },
        ],
      }],
      model_capability: {
        'seedance_v2.0': { supported_durations: ['5', '10', '30'] },
        'seedance_v2.0_fast': { supported_durations: ['5', '10', '30'] },
        'seedance_v2.5': { supported_durations: ['5', '10', '30'] },
        ic_mini: { supported_durations: ['5', '10', '30'] },
      },
    } } } });
    const result = JSON.parse(patchSkillPackDuration(source, '', true)) as {
      data: { video_generation: { meta: {
        option_list: Array<{ value: string; options?: Array<{ value: string }> }>;
        model_capability: Record<string, { supported_durations?: string[] }>;
      } } };
    };
    const options = result.data.video_generation.meta.option_list;
    const model = options.find((option) => option.value === 'model');
    expect(model?.options?.map((option) => option.value)).toEqual(['seedance_v2.5', 'seedance_v2.0']);
    expect(result.data.video_generation.meta.model_capability['seedance_v2.5']).toBeDefined();
    expect(options.find((option) => option.value === 'duration')?.options?.map((option) => option.value)).toEqual(['10', '15', '30']);
    expect(result.data.video_generation.meta.model_capability['seedance_v2.0'].supported_durations).toEqual(['5', '10', '15', '30']);
    expect(result.data.video_generation.meta.model_capability['seedance_v2.0_fast'].supported_durations).toEqual(['5', '10', '15', '30']);
    expect(result.data.video_generation.meta.model_capability['seedance_v2.5'].supported_durations).toEqual(['5', '10', '30']);
    expect(result.data.video_generation.meta.model_capability.ic_mini.supported_durations).toEqual(['5', '10', '30']);
  });

  it('实时响应不可解析时，Dola 静态兜底也补齐 2.5、15s 与 30s', () => {
    const fallback = JSON.stringify({ data: { video_generation: { meta: {
      option_list: [
        { value: 'duration', options: [{ show_name: '10s', value: '10' }] },
        { value: 'model', options: [{ show_name: 'Seedance2.0Fast', value: 'seedance_v2.0' }] },
      ],
    } } } });
    const result = JSON.parse(patchSkillPackDuration('not-json', fallback, true)) as {
      data: { video_generation: { meta: { option_list: Array<{ value: string; options?: Array<{ value: string }> }> } } };
    };
    const options = result.data.video_generation.meta.option_list;
    expect(options.find((option) => option.value === 'duration')?.options?.some((option) => option.value === '15')).toBe(true);
    expect(options.find((option) => option.value === 'duration')?.options?.some((option) => option.value === '30')).toBe(true);
    expect(options.find((option) => option.value === 'model')?.options?.some((option) => option.value === 'seedance_v2.5')).toBe(true);
  });

  it('模型和时长组合文本可从带前缀/后缀的控件回读', () => {
    expect(normalizeDolaModelLabel('模型：Dreamina Seedance2.5（推荐）')).toBe('Seedance 2.5');
    expect(normalizeDolaModelLabel('Seedance 2.0 Fast · 极速')).toBe('Seedance 2.0 Fast');
    expect(normalizeDolaDurationLabel('视频时长 30 秒（已选）')).toBe('30s');
    expect(matchesDolaDurationLabel('30s', '30 秒')).toBe(true);
    expect(matchesDolaDurationLabel('视频时长：30秒（已选）', '30s')).toBe(true);
  });

  it('Dola 控件等待和时长菜单重试都有明确上限', () => {
    expect(DOLA_VIDEO_CONTROL_READINESS_TIMEOUT_MS).toBe(60_000);
    expect(DOLA_VIDEO_DURATION_SELECTION_MAX_ATTEMPTS).toBe(3);
    const bridge = readFileSync(resolve(process.cwd(), 'src/utils/doubaoBridge.ts'), 'utf8');
    expect(bridge).toContain('重新定位控件');
    expect(bridge).toContain('DOLA_VIDEO_DURATION_SELECTION_MAX_ATTEMPTS');
  });

  it('新版 action_bar 只在 Dola 增加 15s，并保持顺序和幂等', () => {
    const source = JSON.stringify({
      data: { option_list: [{ value: 'duration', options: [
        { show_name: '5s', value: '5' },
        { show_name: '10s', value: '10' },
      ] }] },
    });
    const doubao = JSON.parse(patchActionBarDuration(source)) as { data: { option_list: Array<{ value: string; options: Array<{ value: string }> }> } };
    const dola = JSON.parse(patchActionBarDuration(source, true)) as typeof doubao;
    const repeated = JSON.parse(patchActionBarDuration(JSON.stringify(dola), true)) as typeof doubao;
    expect(doubao.data.option_list[0].options.map((option) => option.value)).toEqual(['5', '10', '30']);
    expect(dola.data.option_list[0].options.map((option) => option.value)).toEqual(['5', '10', '15', '30']);
    expect(repeated.data.option_list[0].options.filter((option) => option.value === '15')).toHaveLength(1);
  });

  it('新版 action_bar 的 valueKey/selections 结构会补出 Dola 2.5', () => {
    const source = JSON.stringify({ data: {
      selections: [
        { valueKey: 'video-model', option: { value: 'seedance_v2.0', show_name: 'Seedance2.0Fast' } },
        { valueKey: 'video-model', option: { value: 'ic_mini', show_name: 'Seedance1.0' } },
      ],
    } });
    const result = JSON.parse(patchActionBarDuration(source, true)) as {
      data: { selections: Array<{ option?: { value?: string; display_text?: string } }> };
    };
    expect(result.data.selections.map((item) => item.option?.value)).toContain('seedance_v2.5');
    expect(result.data.selections.find((item) => item.option?.value === 'seedance_v2.5')?.option?.display_text)
      .toBe('Dreamina Seedance 2.5');
    const repeated = JSON.parse(patchActionBarDuration(JSON.stringify(result), true)) as typeof result;
    expect(repeated.data.selections.filter((item) => item.option?.value === 'seedance_v2.5')).toHaveLength(1);
  });

  it('修补旧版 label/option_list 时长格式且不会重复添加', () => {
    const source = JSON.stringify({ label: '时长', option_list: [
      { id: 1, option_key: '10', display_text: '10s' },
    ] });
    const once = JSON.parse(patchActionBarDuration(source, true)) as { option_list: Array<{ option_key: string }> };
    const twice = JSON.parse(patchActionBarDuration(JSON.stringify(once), true)) as typeof once;
    expect(once.option_list.map((option) => option.option_key)).toEqual(['10', '15', '30']);
    expect(twice.option_list.filter((option) => option.option_key === '15')).toHaveLength(1);
    expect(once.option_list.filter((option) => option.option_key === '30')).toHaveLength(1);
    expect(twice.option_list.filter((option) => option.option_key === '30')).toHaveLength(1);
  });

  it('从 Dola chain 响应提取可播放视频地址和原始图片地址', () => {
    const videoUrl = 'https://vod.example.com/video/no-watermark.mp4';
    const encoded = Buffer.from(videoUrl, 'utf8').toString('base64url');
    const items = extractDolaMediaItems({ data: {
      video: { main_url: encoded },
      image: { image_ori_raw: { url: 'https://img.example.com/source.png' } },
    } });
    expect(items).toEqual([
      { type: 'image', url: 'https://img.example.com/source.png' },
      { type: 'video', url: videoUrl },
    ]);
  });

  it('从豆包 chain 响应提取嵌套的 image_ori_raw 原始地址并去重', () => {
    const originalUrl = 'https://img.example.com/original.png';
    expect(extractDoubaoMediaItems({
      data: [
        { image: { image_ori_raw: { url: originalUrl } } },
        JSON.stringify({ nested: { image_ori_raw: { url: originalUrl } } }),
        { image: { image_ori_raw: { url: 'https://img.example.com/other.webp' } } },
      ],
    })).toEqual([
      { type: 'image', url: originalUrl },
      { type: 'image', url: 'https://img.example.com/other.webp' },
    ]);
  });

  it('兼容新版 image_raw 对象和字符串字段', () => {
    const objectUrl = 'https://p3-flow-imagex-sign.byteimg.com/a~tplv-a9rns2rl98-image_raw.png';
    const stringUrl = 'https://p3-flow-imagex-sign.byteimg.com/b~tplv-a9rns2rl98-image_raw.webp';
    expect(extractDoubaoMediaItems({
      result: {
        image_raw: { url: objectUrl },
        nested: JSON.stringify({ image_raw: stringUrl }),
      },
    })).toEqual([
      { type: 'image', url: objectUrl },
      { type: 'image', url: stringUrl },
    ]);
  });

  it('兼容 image_raw 数组和一层嵌套对象', () => {
    const arrayUrl = 'https://img.example.com/array-image_raw.png';
    const nestedUrl = 'https://img.example.com/nested.png';
    expect(extractDoubaoMediaItems({
      image_raw: [{ url: arrayUrl }],
      image_raw_url: JSON.stringify({ image: { url: nestedUrl } }),
    })).toEqual([
      { type: 'image', url: arrayUrl },
      { type: 'image', url: nestedUrl },
    ]);
  });

  it('兼容新版原始图片对象中的 url_list/urlList 数组', () => {
    const snakeUrl = 'https://img.example.com/snake.png';
    const camelUrl = 'https://img.example.com/camel.webp';
    expect(extractDoubaoMediaItems({
      image_ori_raw: { url_list: [snakeUrl] },
      image_raw: { urlList: [camelUrl] },
    })).toEqual([
      { type: 'image', url: snakeUrl },
      { type: 'image', url: camelUrl },
    ]);
  });

  it('url_list 首项为水印地址时继续寻找后续原始地址', () => {
    const watermarkedUrl = 'https://img.example.com/result_ds_wm.png';
    const originalUrl = 'https://img.example.com/result-image_raw.png';
    expect(extractDoubaoMediaItems({
      image_ori_raw: { url_list: [watermarkedUrl, originalUrl] },
    })).toEqual([{ type: 'image', url: originalUrl }]);
  });

  it('兼容 chain SSE data 包装并只取原始图片字段', () => {
    const url = 'https://img.example.com/generated-image_raw.png';
    const sse = `event: message\ndata: ${JSON.stringify({ data: { image_raw: { url } } })}\n\ndata: [DONE]\n`;
    expect(extractDoubaoMediaItems(sse)).toEqual([{ type: 'image', url }]);
  });

  it('从 chat/completion 的 SSE 响应提取图像生成原始地址', () => {
    const url = 'https://img.example.com/completion-image_ori_raw.png';
    const sse = [
      `data: ${JSON.stringify({ content: { creation_block: { creations: [{ image: { image_ori_raw: { url } } }] } } })}`,
      'data: [DONE]',
    ].join('\n');
    expect(extractDoubaoMediaItems(sse)).toEqual([{ type: 'image', url }]);
  });

  it('拒绝 ds_wm/i_pre_wm 和普通展示图地址', () => {
    expect(extractDoubaoMediaItems({
      image_raw: { url: 'https://img.example.com/result_ds_wm.png' },
      image_ori_raw: { url: 'https://img.example.com/result_i_pre_wm.jpg' },
      image_thumb: { url: 'https://img.example.com/result.png' },
      image_ori: { url: 'https://img.example.com/result.jpg' },
    })).toEqual([]);
  });

  it('仅当 image_ori URL 明确带 image_raw 标记时才接受', () => {
    const url = 'https://img.example.com/result~tplv-image_raw.png';
    expect(extractDoubaoMediaItems({ image_ori: { url } })).toEqual([{ type: 'image', url }]);
    expect(extractDoubaoMediaItems({ image_ori: { url: 'https://img.example.com/result.png' } })).toEqual([]);
  });

  it('兼容扩展的 $@# 自定义 Base64 字母表', () => {
    // 使用 # 替换标准 Base64 的 = 填充，避免 $ 同时可映射为 _ 或 + 时的歧义。
    const customToken = Buffer.from('https://x.example.com/a', 'utf8').toString('base64').replace(/=/g, '#');
    expect(decodeDolaMediaUrl(customToken)).toBe('https://x.example.com/a');
  });

  it('解码 qAAB/AES-CBC 令牌并从 chain 提取视频地址', () => {
    // 该夹具按 service-worker.js 的 SHA-512 派生规则生成，令牌同时使用 $@# 变体。
    const keySeed = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
    const token = 'qAABAA5u2gderdDMilhcWiLrCHzYw2$TL3tHSB57DdG29IBldC0UILEUM0FQLLJ7rcHxezqaAe1r$vSFzsAC9wGOh2g#';
    const expected = 'https://cdn.example.com/video/qAAB-no-watermark.mp4';
    expect(decodeDolaMediaUrl(token, keySeed)).toBe(expected);
    expect(extractDolaMediaItems({ data: { key_seed: keySeed, video: { main_url: token } } })).toEqual([
      { type: 'video', url: expected },
    ]);
  });

  it('只透传 Dola chain 中的真实 vid，不为播放地址伪造 vid', () => {
    expect(extractDolaMediaVid({ data: {
      video: { vid: 'vid-dola-real-001', main_url: 'encoded' },
    } })).toBe('vid-dola-real-001');
    expect(extractDolaMediaVid({ data: {
      video: { main_url: 'encoded' },
    } })).toBeUndefined();
  });

  it('从豆包 fallback_api 提取真实 vid，并把请求固定为无水印参数', () => {
    const fallbackApi = 'https://www.doubao.com/video/fallback?vid=vid-doubao-real-001&logo_type=watermarked';
    const rawBody = JSON.stringify({ fallback_api: fallbackApi });
    expect(extractDoubaoFallbackApis(rawBody, rawBody)).toContain(fallbackApi);
    expect(extractDoubaoMediaVid(rawBody, rawBody)).toBe('vid-doubao-real-001');
    const requestUrl = new URL(buildDoubaoUnwatermarkedFallbackUrl(fallbackApi) || '');
    expect(requestUrl.searchParams.get('channel')).toBe('no');
    expect(requestUrl.searchParams.get('codec_type')).toBe('8');
    expect(requestUrl.searchParams.get('logo_type')).toBe('unwatermarked');
  });

  it('手动历史会话只保留当前 vid 的 fallback_api，并在新文档恢复一次性捕获上下文', () => {
    const expected = 'vid-doubao-current-001';
    const matching = `https://www.doubao.com/video/fallback?vid=${expected}`;
    const other = 'https://www.doubao.com/video/fallback?vid=vid-doubao-old-002';
    expect(filterDoubaoFallbackApisForVid([other, matching], expected)).toEqual([matching]);
    expect(filterDoubaoFallbackApisForVid([other], expected)).toEqual([]);
    expect(MANUAL_VIDEO_CAPTURE_STORAGE_KEY).toBe('__lalorManualVideoCaptureV1');
    expect(MANUAL_VIDEO_CAPTURE_PRELOAD_SCRIPT).toContain('sessionStorage.getItem');
    expect(MANUAL_VIDEO_CAPTURE_PRELOAD_SCRIPT).toContain('manualExpectedVid');
    expect(MANUAL_VIDEO_CAPTURE_PRELOAD_SCRIPT).toContain('trustedExtensionVideo: null');
  });

  it('仅接收 fallback_api 返回的无水印视频，并拒绝显式水印播放流', async () => {
    const requested: string[] = [];
    const items = await resolveDoubaoFallbackVideoItems(
      ['https://www.doubao.com/video/fallback?vid=vid-doubao-real-002&logo_type=watermarked'],
      async (url) => {
        requested.push(url);
        return { video_info: { data: { main_url: 'https://vod.example.com/video/result.mp4?logo_type=unwatermarked' } } };
      },
    );
    expect(new URL(requested[0]).searchParams.get('logo_type')).toBe('unwatermarked');
    expect(items).toEqual([{ type: 'video', url: 'https://vod.example.com/video/result.mp4?logo_type=unwatermarked' }]);

    const rejected = await resolveDoubaoFallbackVideoItems(
      ['https://www.doubao.com/video/fallback?vid=vid-doubao-real-003'],
      async () => ({ video_info: { data: { main_url: 'https://vod.example.com/video/result.mp4?lr=video_gen_watermark_dyn' } } }),
    );
    expect(rejected).toEqual([]);

    const conflictingMarkers = await resolveDoubaoFallbackVideoItems(
      ['https://www.doubao.com/video/fallback?vid=vid-doubao-real-004'],
      async () => ({
        video_info: {
          data: {
            main_url: 'https://vod.example.com/video/result.mp4?logo_type=unwatermarked&lr=video_gen_watermark_dyn',
          },
        },
      }),
    );
    expect(conflictingMarkers).toEqual([]);
  });

  it('画布 qAAB 响应缺少种子时使用 fallback_api 的 key_seed，并选择最高质量码流', async () => {
    const keySeed = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
    const token = 'qAABAA5u2gderdDMilhcWiLrCHzYw2$TL3tHSB57DdG29IBldC0UILEUM0FQLLJ7rcHxezqaAe1r$vSFzsAC9wGOh2g#';
    const items = await resolveDoubaoFallbackVideoItems(
      [`https://www.doubao.com/video/fallback?vid=video-current&key_seed=${encodeURIComponent(keySeed)}`],
      async () => ({ video_info: { data: { video_list: {
        preview: { main_url: 'https://vod.example.com/preview.mp4', bitrate: 100000, width: 640, height: 360 },
        original: { main_url: token, bitrate: 8000000, vwidth: 1920, vheight: 1080 },
      } } } }),
    );
    expect(items).toEqual([{ type: 'video', url: 'https://cdn.example.com/video/qAAB-no-watermark.mp4' }]);
  });

  it('用当前 WebContents 的账号会话请求原片接口并保留 Cookie', async () => {
    let options: RequestInit | undefined;
    const contents = { session: { fetch: async (_url: string, init: RequestInit): Promise<Response> => {
      options = init;
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    } } } as unknown as WebContents;
    await expect(fetchDoubaoFallbackJson(contents, 'https://www.doubao.com/video/fallback'))
      .resolves.toEqual({ code: 0 });
    expect(options?.credentials).toBe('include');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('取消后不会继续尝试另一个高清接口', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(resolveDoubaoFallbackVideoItems([
      'https://www.doubao.com/video/fallback?vid=video-current',
      'https://www.doubao.com/video/fallback?vid=video-other',
    ], async (): Promise<unknown> => {
      calls += 1;
      controller.abort(new Error('已取消提取'));
      throw new Error('网络请求中断');
    }, controller.signal)).rejects.toThrow('已取消提取');
    expect(calls).toBe(1);
  });

  it('只提取 Dola 提交请求中的能力字段用于诊断', () => {
    const evidence = extractDolaSubmissionConfig(JSON.stringify({
      video: { duration: 30, model: 'seedance_v2.0', aspect_ratio: '16:9' },
      prompt: '不应出现在诊断日志里的提示词',
    }));
    expect(evidence).toEqual({ duration: ['30'], model: ['seedance_v2.0'], aspect_ratio: ['16:9'] });
  });
});
