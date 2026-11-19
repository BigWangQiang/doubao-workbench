/**
 * Dola 扩展的 Electron 原生网络桥接。
 *
 * Electron 33 可以加载扩展内容脚本，但不提供扩展侧 chrome.debugger 权限。
 * 这里使用 webContents.debugger 在主进程接管同一 webview 的 Fetch 域，
 * 让扩展原本的 skill-pack/action-bar 配置补丁继续适用于内置浏览器。
 */

import { app, type WebContents } from 'electron';
import { createDecipheriv, createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DOLA_LOCALE_PRELOAD_SCRIPT } from './dolaLocalePreload';

const EXTENSION_DIR = path.join('extensions', 'dola30');
const DEBUGGER_VERSION = '1.3';
const ACTION_BAR_CONF_URL_PART = '.com/alice/slot/action_bar_v3/get_item_conf';
const DOUBAO_SKILL_PACK_URL_PART = 'doubao.com/samantha/skill/pack';
const DOLA_SKILL_PACK_URL_PART = 'dola.com/samantha/skill/pack';
const DOUBAO_CHAIN_SINGLE_URL_PART = 'doubao.com/im/chain/single';
const DOUBAO_CANVAS_WORKSPACE_URL_PART = 'canvas_workspace';
const DOLA_CHAIN_SINGLE_URL_PART = 'dola.com/im/chain/single';
const DOUBAO_COMPLETION_URL_PART = 'doubao.com/';
const DOLA_COMPLETION_URL_PART = 'dola.com/';
// 与内置扩展 service-worker.js 保持一致，用于解码 Dola 的 qAAB 资源令牌。
const QAAB_SALT_HEX = '4dd4c2e6b83162090e52b3c7a6733ba4'
  + '1cb2462b829ab58a196b39db57177524'
  + 'f49baf7f08e8d68d26a72e37c1a95a2f'
  + '1f05a51892aef2949732b62a38aadd58';

const FETCH_PATTERNS = [
  // skill-pack 必须在响应阶段增量补时长能力；请求阶段整体替换会丢失
  // 平台实时返回的模型（尤其是 Dola 2.5 / 2.0 Fast）。
  { urlPattern: `*${DOUBAO_SKILL_PACK_URL_PART}*`, requestStage: 'Response' },
  { urlPattern: `*${DOLA_SKILL_PACK_URL_PART}*`, requestStage: 'Response' },
  { urlPattern: `*${ACTION_BAR_CONF_URL_PART}*`, requestStage: 'Response' },
  { urlPattern: `*${DOUBAO_CHAIN_SINGLE_URL_PART}*`, requestStage: 'Response' },
  // 图像生成结果在部分版本从 /chat/completion（或 /samantha/chat/completion）返回。
  { urlPattern: '*doubao.com/*chat/completion*', requestStage: 'Response' },
  // 新版图像创作页可能从独立 image/creation 响应返回原始字段。
  { urlPattern: '*doubao.com/*/image/generate*', requestStage: 'Response' },
  { urlPattern: '*doubao.com/*/image/create*', requestStage: 'Response' },
  { urlPattern: '*doubao.com/*/image/completion*', requestStage: 'Response' },
  { urlPattern: '*doubao.com/*/creation/generate*', requestStage: 'Response' },
  { urlPattern: '*doubao.com/*/creation/create*', requestStage: 'Response' },
  { urlPattern: '*doubao.com/*/creation/completion*', requestStage: 'Response' },
];

type ResponseHeader = { name?: string; value?: string };
type PausedRequest = {
  requestId: string;
  request?: { url?: string; method?: string; postData?: string };
  responseStatusCode?: number;
  responseStatusText?: string;
  responseErrorReason?: string;
  responseHeaders?: ResponseHeader[];
};

type PausedRequestStage = 'request' | 'response';

/**
 * Fetch.requestPaused 在 Request/Response 两个阶段会复用同一个 requestId。
 * 失败响应没有 statusCode，但会带 responseErrorReason，因此不能只看状态码。
 */
export function getDolaPausedRequestStage(
  paused: Pick<PausedRequest, 'responseStatusCode' | 'responseErrorReason' | 'responseHeaders'>,
): PausedRequestStage {
  return paused.responseStatusCode !== undefined
    || paused.responseErrorReason !== undefined
    || paused.responseHeaders !== undefined
    ? 'response'
    : 'request';
}

/** 只有同一请求从 Request 进入 Response 时才允许排队交接。 */
export function shouldQueueDolaResponse(
  existingStage: PausedRequestStage,
  incomingStage: PausedRequestStage,
): boolean {
  return existingStage === 'request' && incomingStage === 'response';
}

const attachedContents = new WeakSet<WebContents>();
const attachingContents = new WeakMap<WebContents, Promise<void>>();
const debuggerListeners = new WeakMap<WebContents, {
  message: (event: Electron.Event, method: string, params: unknown) => void;
  detach: (event: Electron.Event, reason: string) => void;
  destroyed: () => void;
}>();
const trackedContents = new Set<WebContents>();
// 文档前脚本会覆盖后续导航；当前文档的补注入只允许尝试一次，避免
// dom-ready/导航事件反复执行语言初始化并扰动 Dola 页面生命周期。
const localeGuardInjectionAttempted = new WeakSet<WebContents>();
type RequestState = {
  cancelled: boolean;
  settled: boolean;
  stage: PausedRequestStage;
  releasePromise?: Promise<void>;
  pendingResponse?: PausedRequest;
};
const inFlightRequests = new WeakMap<WebContents, Map<string, RequestState>>();
type DolaNetworkResponse = {
  requestId: string;
  url: string;
  responseStatusCode?: number;
  responseStatusText?: string;
  responseHeaders?: ResponseHeader[];
};
const dolaNetworkResponses = new WeakMap<WebContents, Map<string, DolaNetworkResponse>>();
const loadedBodies = new Map<string, string>();

function getDolaNetworkResponseMap(contents: WebContents): Map<string, DolaNetworkResponse> {
  const existing = dolaNetworkResponses.get(contents);
  if (existing) return existing;
  const created = new Map<string, DolaNetworkResponse>();
  dolaNetworkResponses.set(contents, created);
  return created;
}

function getNetworkRequestId(params: unknown): string {
  if (!params || typeof params !== 'object') return '';
  const requestId = (params as Record<string, unknown>).requestId;
  return typeof requestId === 'string' ? requestId : '';
}

function observeDolaNetworkResponse(contents: WebContents, params: unknown): void {
  if (!params || typeof params !== 'object') return;
  const record = params as Record<string, unknown>;
  const requestId = getNetworkRequestId(params);
  const response = record.response;
  if (!requestId || !response || typeof response !== 'object') return;
  const responseRecord = response as Record<string, unknown>;
  const url = typeof responseRecord.url === 'string' ? responseRecord.url : '';
  if (!url || (!shouldCaptureDolaNetworkResponse(url) && !shouldCaptureDoubaoCanvasResponse(url))) return;

  const status = typeof responseRecord.status === 'number' && Number.isFinite(responseRecord.status)
    ? responseRecord.status
    : undefined;
  const statusText = typeof responseRecord.statusText === 'string' ? responseRecord.statusText : undefined;
  getDolaNetworkResponseMap(contents).set(requestId, {
    requestId,
    url,
    ...(status !== undefined ? { responseStatusCode: status } : {}),
    ...(statusText ? { responseStatusText: statusText } : {}),
  });
}

function finishDolaNetworkResponse(contents: WebContents, params: unknown): void {
  const requestId = getNetworkRequestId(params);
  if (!requestId) return;
  const responses = dolaNetworkResponses.get(contents);
  const response = responses?.get(requestId);
  if (!response) return;
  responses?.delete(requestId);
  const capture = shouldCaptureDoubaoCanvasResponse(response.url)
    ? captureDoubaoCanvasNetworkResponse(contents, response)
    : captureDolaNetworkResponse(contents, response);
  void capture.catch((error: unknown) => {
    console.warn(
      `[DolaBridge] Dola Network 后台捕获失败: webview=${contents.id}, request=${requestId}, ` +
        `${error instanceof Error ? error.message : error}`,
    );
  });
}

function failDolaNetworkResponse(contents: WebContents, params: unknown): void {
  const requestId = getNetworkRequestId(params);
  if (!requestId) return;
  const responses = dolaNetworkResponses.get(contents);
  if (!responses?.has(requestId)) return;
  responses.delete(requestId);
  console.warn(`[DolaBridge] Dola Network 响应失败，跳过后台解析: webview=${contents.id}, request=${requestId}`);
}

/**
 * 读取已完成的画布响应，按 fallback_api 单独请求原片。
 * 使用 Network 域而不是 Fetch 暂停，避免画布同步/提交被高清解析阻塞。
 */
async function captureDoubaoCanvasNetworkResponse(
  contents: WebContents,
  response: DolaNetworkResponse,
): Promise<void> {
  if (isContentsDestroyed(contents) || response.responseStatusCode !== 200) return;
  let body: { body?: string; base64Encoded?: boolean };
  try {
    body = await sendCommand(contents, 'Network.getResponseBody', {
      requestId: response.requestId,
    }) as { body?: string; base64Encoded?: boolean };
  } catch {
    return;
  }
  const rawBody = body.base64Encoded ? fromBase64Utf8(body.body || '') : (body.body || '');
  const fallbackApis = extractDoubaoFallbackApis(rawBody, rawBody);
  if (!fallbackApis.length || isContentsDestroyed(contents)) return;
  const captureContext = await readPageVideoCaptureContext(contents);
  const expectedVid = captureContext?.expectedVid?.trim() || '';
  for (const fallbackApi of fallbackApis.slice(0, 16)) {
    if (isContentsDestroyed(contents)) return;
    const apiVid = extractDoubaoMediaVid({ fallback_api: fallbackApi, raw: fallbackApi }) || '';
    const vid = apiVid || (expectedVid && fallbackApis.length === 1 ? expectedVid : '');
    if (!vid || (expectedVid && vid !== expectedVid)) continue;
    try {
      const items = await resolveDoubaoFallbackVideoItems(
        [fallbackApi],
        (url) => fetchDoubaoFallbackJson(contents, url),
      );
      if (!items.length) continue;
      await sendPageMessage(contents, {
        __dolaExtensionBridge: true,
        type: 'MEDIA_FOUND',
        sourceKey: `doubao-canvas:${Date.now()}`,
        source: 'doubao_extension',
        items,
        vid,
        ...(captureContext ? {
          captureToken: captureContext.captureToken,
          captureResetAt: captureContext.resetAt,
        } : {}),
        watermarkFreeProof: 'doubao_fallback_unwatermarked_v1',
      });
    } catch (error: unknown) {
      console.warn('[DolaBridge] 豆包画布原片解析失败:', error instanceof Error ? error.message : error);
    }
  }
}

const DEBUGGER_COMMAND_TIMEOUT_MS = 10_000;
const PAUSED_REQUEST_TIMEOUT_MS = 20_000;

/** Dola 的流式生成响应只观察，不在 Fetch 响应阶段暂停页面。 */
export function shouldCaptureDolaNetworkResponse(url: string): boolean {
  if (!isDolaNetworkHost(url)) return false;
  return url.includes(DOLA_CHAIN_SINGLE_URL_PART) || isCompletionUrl(url, DOLA_COMPLETION_URL_PART);
}

/** 画布提交/同步接口仅观察已完成响应，不暂停豆包页面请求。 */
export function shouldCaptureDoubaoCanvasResponse(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return parsed.protocol === 'https:' && (hostname === 'doubao.com' || hostname.endsWith('.doubao.com'))
      && parsed.pathname.includes(DOUBAO_CANVAS_WORKSPACE_URL_PART);
  } catch {
    return false;
  }
}

function isDolaNetworkHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'dola.com' || hostname.endsWith('.dola.com');
  } catch {
    return false;
  }
}

export const MANUAL_VIDEO_CAPTURE_STORAGE_KEY = '__lalorManualVideoCaptureV1';

/**
 * 手动提取历史豆包会话时，页面重载会销毁 window 缓存。这里在新文档脚本
 * 执行前从同一 tab 的 sessionStorage 恢复一次性捕获上下文，确保扩展随后
 * 拦截到的 fallback_api 仍能绑定到用户当前看到的会话和真实 vid。
 */
export const MANUAL_VIDEO_CAPTURE_PRELOAD_SCRIPT = `
  (function () {
    try {
      var storageKey = ${JSON.stringify(MANUAL_VIDEO_CAPTURE_STORAGE_KEY)};
      var raw = sessionStorage.getItem(storageKey);
      if (!raw) return;
      var context = JSON.parse(raw);
      var now = Date.now();
      if (!context || typeof context.captureToken !== 'string' || !context.captureToken ||
          !Number.isFinite(Number(context.resetAt)) || Number(context.resetAt) <= 0 ||
          !Number.isFinite(Number(context.expiresAt)) || Number(context.expiresAt) < now ||
          typeof context.expectedVid !== 'string' || !context.expectedVid) {
        sessionStorage.removeItem(storageKey);
        return;
      }
      var expectedUrl = new URL(String(context.conversationUrl || ''), location.origin);
      if (expectedUrl.origin !== location.origin || expectedUrl.pathname !== location.pathname ||
          expectedUrl.search !== location.search) return;
      window.__doubaoVideoCache = {
        captureToken: context.captureToken,
        resetAt: Number(context.resetAt),
        manualExpectedVid: context.expectedVid,
        lastVid: '',
        lastVideoUrl: '',
        lastFieldSource: '',
        lastSourceKey: '',
        lastCapturedAt: 0,
        lastCaptureToken: '',
        watermarkFreeProof: '',
        trustedExtensionVideo: null
      };
    } catch (_) {}
  })();
`;

function isContentsDestroyed(contents: WebContents): boolean {
  return typeof contents.isDestroyed === 'function' && contents.isDestroyed();
}

function isDolaDocument(contents: WebContents): boolean {
  try {
    const hostname = new URL(contents.getURL()).hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'dola.com' || hostname.endsWith('.dola.com');
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 (${timeoutMs}ms)`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function getRequestState(contents: WebContents, requestId: string): RequestState | undefined {
  return inFlightRequests.get(contents)?.get(requestId);
}

function requestIsActive(contents: WebContents, requestId: string, state?: RequestState): boolean {
  const current = getRequestState(contents, requestId);
  return !!current && current === state && !current.cancelled && !current.settled && !isContentsDestroyed(contents);
}

function resolveExtensionPath(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, EXTENSION_DIR), path.join(app.getAppPath(), EXTENSION_DIR)]
    : [path.join(app.getAppPath(), EXTENSION_DIR), path.join(__dirname, '..', '..', EXTENSION_DIR)];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}

function readExtensionBody(fileName: string): string {
  const cached = loadedBodies.get(fileName);
  if (cached !== undefined) return cached;
  const extensionPath = resolveExtensionPath();
  if (!extensionPath) throw new Error('未找到内置 Dola 扩展目录');
  const body = fs.readFileSync(path.join(extensionPath, fileName), 'utf8');
  loadedBodies.set(fileName, body);
  return body;
}

function toBase64Utf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function fromBase64Utf8(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function contentTypeHeaders(body: string): ResponseHeader[] {
  return [
    { name: 'access-control-allow-origin', value: '*' },
    { name: 'access-control-allow-credentials', value: 'true' },
    { name: 'access-control-allow-methods', value: 'GET, POST, OPTIONS' },
    { name: 'access-control-allow-headers', value: '*' },
    { name: 'content-type', value: 'application/json; charset=utf-8' },
    { name: 'content-length', value: String(Buffer.byteLength(body, 'utf8')) },
  ];
}

function responseHeadersForTextBody(headers: ResponseHeader[] = [], body: string): ResponseHeader[] {
  const contentLength = String(Buffer.byteLength(body, 'utf8'));
  const nextHeaders: ResponseHeader[] = [];
  let hasContentType = false;
  let hasContentLength = false;

  for (const header of headers) {
    const name = header.name || '';
    const lowerName = name.toLowerCase();
    if (lowerName === 'content-encoding') continue;
    if (lowerName === 'content-type') {
      hasContentType = true;
      nextHeaders.push({ name, value: 'application/json; charset=utf-8' });
      continue;
    }
    if (lowerName === 'content-length') {
      hasContentLength = true;
      nextHeaders.push({ name, value: contentLength });
      continue;
    }
    nextHeaders.push(header);
  }

  if (!hasContentType) nextHeaders.push({ name: 'content-type', value: 'application/json; charset=utf-8' });
  if (!hasContentLength) nextHeaders.push({ name: 'content-length', value: contentLength });
  return nextHeaders;
}

/** 回放 chain/completion 响应时保留原始 Content-Type，尤其不能把 SSE 改成 JSON。 */
function responseHeadersForCapturedBody(headers: ResponseHeader[] = [], body: string): ResponseHeader[] {
  const contentLength = String(Buffer.byteLength(body, 'utf8'));
  const nextHeaders: ResponseHeader[] = [];
  let hasContentType = false;
  let hasContentLength = false;

  for (const header of headers) {
    const name = header.name || '';
    const lowerName = name.toLowerCase();
    if (lowerName === 'content-encoding') continue;
    if (lowerName === 'content-type') {
      hasContentType = true;
      nextHeaders.push(header);
      continue;
    }
    if (lowerName === 'content-length') {
      hasContentLength = true;
      nextHeaders.push({ name, value: contentLength });
      continue;
    }
    nextHeaders.push(header);
  }

  if (!hasContentType) nextHeaders.push({ name: 'content-type', value: 'application/json; charset=utf-8' });
  if (!hasContentLength) nextHeaders.push({ name: 'content-length', value: contentLength });
  return nextHeaders;
}

function isHttpUrl(value: unknown): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function isCompletionUrl(url: string, hostPart: string): boolean {
  return url.includes(hostPart) && /\/chat\/completion(?:[/?]|$)/i.test(url);
}

function isDoubaoImageResponseUrl(url: string): boolean {
  return url.includes(DOUBAO_COMPLETION_URL_PART)
    && /\/(?:samantha\/)?(?:image|creation)(?:\/|[?_-])/i.test(url);
}

function walkJsonAndStrings(value: unknown, visitor: (node: Record<string, unknown>) => void, seen = new Set<object>()): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // chain 接口在部分版本返回 SSE；逐条解析 data 事件，忽略 [DONE]。
    if (/^(?:data\s*:)/im.test(trimmed)) {
      const dataLines = trimmed
        .split(/\r?\n/)
        .filter((line) => /^\s*data\s*:/i.test(line))
        .map((line) => line.replace(/^\s*data\s*:\s?/i, '').trim())
        .filter((line) => line && line !== '[DONE]');
      for (const line of dataLines) {
        try { walkJsonAndStrings(JSON.parse(line) as unknown, visitor, seen); } catch { /* 非 JSON 事件 */ }
      }
      return;
    }
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
    try { walkJsonAndStrings(JSON.parse(trimmed), visitor, seen); } catch { /* 普通字符串 */ }
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJsonAndStrings(item, visitor, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  visitor(record);
  for (const child of Object.values(record)) walkJsonAndStrings(child, visitor, seen);
}

function findValuesByKey(value: unknown, targetKey: string): unknown[] {
  const values: unknown[] = [];
  walkJsonAndStrings(value, (node) => {
    if (Object.prototype.hasOwnProperty.call(node, targetKey)) values.push(node[targetKey]);
  });
  return values;
}

/**
 * 从 Dola chain 响应中提取真实视频 ID。
 *
 * chain 返回的 man_url/main_url 只能说明页面拿到了播放地址，不能用
 * 时间戳伪造 vid。只有真实 vid 才能继续调用平台的无水印授权接口。
 */
export function extractDolaMediaVid(json: unknown): string | undefined {
  for (const key of ['vid', 'video_id', 'videoId']) {
    for (const value of findValuesByKey(json, key)) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed.length >= 6 && trimmed.length <= 256 && !/^https?:\/\//i.test(trimmed)) {
        return trimmed;
      }
    }
  }
  return undefined;
}

/** 豆包响应优先读取真实媒体 ID；缺失时再从平台返回的 fallback_api 查询参数回补。 */
export function extractDoubaoMediaVid(json: unknown, rawBody = ''): string | undefined {
  const direct = extractDolaMediaVid(json);
  if (direct) return direct;
  for (const fallbackApi of extractDoubaoFallbackApis(json, rawBody)) {
    try {
      const parsed = new URL(fallbackApi);
      for (const key of ['vid', 'video_id', 'videoId', 'key']) {
        const candidate = parsed.searchParams.get(key)?.trim() || '';
        if (candidate.length >= 6 && candidate.length <= 256 && !/^https?:\/\//i.test(candidate)) {
          return candidate;
        }
      }
    } catch {
      // 忽略损坏的 fallback_api，继续尝试下一个。
    }
  }
  return undefined;
}

/**
 * 从 Dola 提交请求中提取能力字段证据。
 * 只返回 duration/model/ratio/aspect 这类字段，不保留提示词、Cookie 或令牌。
 */
export function extractDolaSubmissionConfig(postData: string): Record<string, string[]> {
  if (!postData.trim()) return {};
  let payload: unknown;
  try {
    payload = JSON.parse(postData);
  } catch {
    payload = Object.fromEntries(new URLSearchParams(postData).entries());
  }

  const evidence = new Map<string, Set<string>>();
  walkJsonAndStrings(payload, (node) => {
    for (const [key, value] of Object.entries(node)) {
      if (!/(?:duration|model|ratio|aspect)/i.test(key)) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
      const text = String(value).trim();
      if (!text || text.length > 120) continue;
      const values = evidence.get(key) || new Set<string>();
      values.add(text);
      evidence.set(key, values);
    }
  });
  return Object.fromEntries([...evidence.entries()].map(([key, values]) => [key, [...values]]));
}

/**
 * 解码扩展传回的 Dola 播放地址。
 *
 * Dola 的 chain 响应有两种常见令牌：普通 URL-safe Base64，以及以
 * qAAB 开头、由 key_seed 派生 AES-CBC 密钥加密的令牌。这里使用 Node
 * crypto 实现与扩展 service-worker.js 相同的算法，保证主进程自动下载
 * 路径和扩展面板使用同一套地址解析规则。
 */
export function decodeDolaMediaUrl(value: unknown, keySeed = ''): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const token = value.trim();
  if (isHttpUrl(token)) return token;

  const plainUrl = tryDecodeBase64Url(token);
  if (plainUrl) return plainUrl;

  if (token.startsWith('qAAB') && keySeed.trim()) {
    return decodeQaabToken(token, keySeed.trim());
  }
  return '';
}

function tryDecodeBase64Url(token: string): string {
  const bytes = base64DecodeLoose(token);
  if (!bytes) return '';
  const text = asciiUrlFromBytes(bytes);
  return isHttpUrl(text) ? text : '';
}

/**
 * 兼容扩展使用的三种 Base64 字母表：标准、URL-safe，以及 $@# 变体。
 * Node 的 Buffer.from 对非法字符会静默忽略，因此先做字符/填充校验，
 * 避免把损坏令牌误判成可下载地址。
 */
function base64DecodeLoose(text: string): Uint8Array | null {
  const input = String(text || '').trim();
  const variants = [
    input,
    input.replace(/[$@#]/g, (char) => ({ $: '_', '@': '/', '#': '.' })[char] || char),
    input.replace(/[$@#]/g, (char) => ({ $: '+', '@': '/', '#': '=' })[char] || char),
  ];
  const seen = new Set<string>();

  for (const candidate of variants) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const normalized = padBase64(candidate).replace(/-/g, '+').replace(/_/g, '/');
    if (!isValidBase64(normalized)) continue;
    try {
      const bytes = Buffer.from(normalized, 'base64');
      if (!bytes.length && normalized.replace(/=/g, '')) continue;
      return new Uint8Array(bytes);
    } catch {
      // 尝试下一个字母表变体。
    }
  }
  return null;
}

function padBase64(text: string): string {
  return text + '='.repeat((4 - (text.length % 4)) % 4);
}

function isValidBase64(text: string): boolean {
  if (!text || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return false;
  const paddingIndex = text.indexOf('=');
  return paddingIndex < 0 || paddingIndex >= text.length - 2;
}

function asciiUrlFromBytes(bytes: Uint8Array): string {
  if (!bytes.length) return '';
  for (const byte of bytes) {
    if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) return '';
  }
  return Buffer.from(bytes).toString('utf8');
}

function findKeySeedDeep(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (depth > 10 || value == null) return '';
  if (typeof value === 'string') {
    const queryMatch = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i);
    if (queryMatch) return decodeURIComponentSafe(queryMatch[1]);
    const jsonMatch = value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
    return jsonMatch ? decodeURIComponentSafe(jsonMatch[1]) : '';
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (typeof record.key_seed === 'string' && record.key_seed.trim()) return record.key_seed.trim();
  for (const child of Object.values(record)) {
    const hit = findKeySeedDeep(child, depth + 1, seen);
    if (hit) return hit;
  }
  return '';
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeQaabToken(token: string, keySeed: string): string {
  const data = base64DecodeLoose(token);
  const seed = base64DecodeLoose(keySeed);
  if (!data || !seed) return '';

  const digest1 = createHash('sha512').update(Buffer.from(seed.slice(0, 32))).digest();
  const salt = hexToBytes(QAAB_SALT_HEX);
  const digest2 = createHash('sha512').update(Buffer.concat([digest1, Buffer.from(salt)])).digest();
  const key = new Uint8Array(digest2.subarray(0, 16));
  const iv = new Uint8Array(digest2.subarray(16, 32));
  const attempts: Array<{ payload: Uint8Array; key: Uint8Array; iv: Uint8Array }> = [];

  if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00) {
    attempts.push({ payload: data.slice(4), key, iv });
    attempts.push({ payload: data.slice(4), key: iv, iv: key });
    if (data.length > 36) {
      attempts.push({ payload: data.slice(36), key, iv: data.slice(20, 36) });
      attempts.push({ payload: data.slice(36), key, iv });
    }
  } else {
    attempts.push({ payload: data, key, iv });
  }

  for (const attempt of attempts) {
    const url = decryptAesCbcUrl(attempt.payload, attempt.key, attempt.iv);
    if (url) return url;
  }
  return '';
}

function decryptAesCbcUrl(payload: Uint8Array, keyBytes: Uint8Array, ivBytes: Uint8Array): string {
  if (!payload.length || payload.length % 16 !== 0 || keyBytes.length !== 16 || ivBytes.length !== 16) return '';
  try {
    const decipher = createDecipheriv('aes-128-cbc', Buffer.from(keyBytes), Buffer.from(ivBytes));
    const plain = Buffer.concat([decipher.update(Buffer.from(payload)), decipher.final()]);
    const direct = asciiUrlFromBytes(plain);
    if (isHttpUrl(direct)) return direct;
    const stripped = stripPkcs7(plain);
    const url = asciiUrlFromBytes(stripped);
    return isHttpUrl(url) ? url : '';
  } catch {
    return '';
  }
}

function stripPkcs7(bytes: Uint8Array): Uint8Array {
  if (!bytes.length) return new Uint8Array();
  const pad = bytes[bytes.length - 1];
  if (pad < 1 || pad > 16 || pad > bytes.length) return bytes;
  for (let index = bytes.length - pad; index < bytes.length; index += 1) {
    if (bytes[index] !== pad) return bytes;
  }
  return bytes.slice(0, bytes.length - pad);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function extractDolaMediaItems(json: unknown): Array<{ type: 'image' | 'video'; url: string }> {
  const items: Array<{ type: 'image' | 'video'; url: string }> = [];
  const seenUrls = new Set<string>();
  const add = (type: 'image' | 'video', url: string): void => {
    if (!isHttpUrl(url) || seenUrls.has(url)) return;
    seenUrls.add(url);
    items.push({ type, url });
  };
  for (const image of extractTrustedRawImageItems(json)) add('image', image.url);
  const keySeed = findKeySeedDeep(json);
  for (const key of ['man_url', 'main_url']) {
    for (const value of findValuesByKey(json, key)) add('video', decodeDolaMediaUrl(value, keySeed));
  }
  return items;
}

/**
 * 从豆包 chain 响应提取插件确认的原始图片地址。
 *
 * `image_ori_raw`/`image_raw` 是扩展去水印链路返回的字段；页面 DOM 中的
 * `<img>` 地址只是展示地址，不能替代这些字段。递归遍历同时兼容
 * 响应里嵌套的 JSON 字符串和 SSE，并对同一地址去重。
 */
export function extractDoubaoMediaItems(json: unknown): Array<{ type: 'image'; url: string }> {
  return extractTrustedRawImageItems(json);
}

/** 从豆包 chain/SSE 响应中提取平台签发的 fallback_api。 */
export function extractDoubaoFallbackApis(json: unknown, rawBody = ''): string[] {
  const apis = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || !value.trim()) return;
    const decoded = decodeJsonEscapedFragment(value.trim());
    try {
      const parsed = new URL(decoded);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') apis.add(parsed.toString());
    } catch {
      // 只接受完整 HTTP(S) 地址。
    }
  };

  for (const value of findValuesByKey(json, 'fallback_api')) add(value);
  for (const pattern of [/fallback_api\\":\\"(.*?)\\"/g, /"fallback_api"\s*:\s*"([^"]+)"/g]) {
    let match = pattern.exec(rawBody);
    while (match) {
      add(match[1]);
      match = pattern.exec(rawBody);
    }
  }
  return [...apis];
}

function decodeJsonEscapedFragment(value: string): string {
  let text = value;
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = JSON.parse(`"${text.replace(/"/g, '\\"')}"`) as string;
      if (decoded === text) break;
      text = decoded;
    } catch {
      break;
    }
  }
  return text.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
}

/** 强制 fallback_api 请求无水印版本，不改写最终播放地址。 */
export function buildDoubaoUnwatermarkedFallbackUrl(fallbackApi: string): string | undefined {
  try {
    const parsed = new URL(fallbackApi);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    parsed.searchParams.set('channel', 'no');
    parsed.searchParams.set('codec_type', '8');
    parsed.searchParams.set('logo_type', 'unwatermarked');
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** 只保留明确属于当前视频 vid 的 fallback_api，禁止把历史会话其他视频误绑。 */
export function filterDoubaoFallbackApisForVid(fallbackApis: string[], expectedVid: string): string[] {
  const normalizedVid = expectedVid.trim();
  if (!normalizedVid) return [];
  return fallbackApis.filter((fallbackApi) => {
    try {
      const parsed = new URL(fallbackApi);
      return ['vid', 'video_id', 'videoId', 'key']
        .some((key) => (parsed.searchParams.get(key) || '').trim() === normalizedVid);
    } catch {
      return false;
    }
  });
}

function getDoubaoVideoData(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const root = payload as Record<string, unknown>;
  const videoInfo = root.video_info && typeof root.video_info === 'object'
    ? root.video_info as Record<string, unknown>
    : root.data && typeof root.data === 'object'
      && (root.data as Record<string, unknown>).video_info
      && typeof (root.data as Record<string, unknown>).video_info === 'object'
      ? (root.data as Record<string, unknown>).video_info as Record<string, unknown>
      : root;
  return videoInfo.data && typeof videoInfo.data === 'object'
    ? videoInfo.data as Record<string, unknown>
    : videoInfo;
}

function pickDoubaoMainUrlToken(payload: unknown): string {
  const data = getDoubaoVideoData(payload);
  const videoList = data.video_list && typeof data.video_list === 'object'
    ? data.video_list as Record<string, unknown>
    : undefined;
  const entries = videoList && Object.keys(videoList).length > 0 ? Object.values(videoList) : [data];
  let best: { token: string; score: number } | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const token = typeof record.main_url === 'string'
      ? record.main_url.trim()
      : typeof record.play_url === 'string'
        ? record.play_url.trim()
        : '';
    if (!token) continue;
    const bitrate = Number(record.bitrate || record.real_bitrate || 0);
    const pixels = Number(record.vwidth || record.width || 0) * Number(record.vheight || record.height || 0);
    const score = (Number.isFinite(bitrate) ? bitrate : 0) + (Number.isFinite(pixels) ? pixels : 0);
    if (!best || score > best.score) best = { token, score };
  }
  return best?.token || '';
}

function isExplicitlyWatermarkedVideoUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const markers = ['lr', 'logo_type', 'watermark']
      .map((key) => (parsed.searchParams.get(key) || '').toLowerCase())
      .filter(Boolean);
    const positiveMarkers = markers.filter((marker) => (
      !marker.includes('no_watermark')
      && !marker.includes('without_watermark')
      && !marker.includes('unwatermarked')
    ));
    return positiveMarkers.some((marker) => marker.includes('watermark') || marker.includes('i_pre_wm') || marker.includes('ds_wm'))
      || /(?:^|[-_/])watermarked?(?:[-_/.]|$)/i.test(parsed.pathname);
  } catch {
    return true;
  }
}

/** 解析 fallback_api 返回值，只产出插件明确请求并验证过的无水印视频地址。 */
export async function resolveDoubaoFallbackVideoItems(
  fallbackApis: string[],
  fetchJson: (url: string) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<Array<{ type: 'video'; url: string }>> {
  const items: Array<{ type: 'video'; url: string }> = [];
  const seen = new Set<string>();
  for (const fallbackApi of fallbackApis.slice(0, 4)) {
    signal?.throwIfAborted();
    const requestUrl = buildDoubaoUnwatermarkedFallbackUrl(fallbackApi);
    if (!requestUrl) continue;
    try {
      const payload = await fetchJson(requestUrl);
      signal?.throwIfAborted();
      const token = pickDoubaoMainUrlToken(payload);
      // 画布接口常把解码种子放在签发 URL 中，响应体不一定重复返回。
      const keySeed = findKeySeedDeep(payload) || new URL(requestUrl).searchParams.get('key_seed') || '';
      const videoUrl = decodeDolaMediaUrl(token, keySeed);
      if (!isHttpUrl(videoUrl) || isExplicitlyWatermarkedVideoUrl(videoUrl) || seen.has(videoUrl)) continue;
      seen.add(videoUrl);
      items.push({ type: 'video', url: videoUrl });
    } catch {
      signal?.throwIfAborted();
      // 单个 fallback_api 失败不影响同一响应中的其他候选。
    }
  }
  return items;
}

function extractTrustedRawImageItems(json: unknown): Array<{ type: 'image'; url: string }> {
  const items: Array<{ type: 'image'; url: string }> = [];
  const seenUrls = new Set<string>();
  walkJsonAndStrings(json, (node) => {
    for (const [key, value] of Object.entries(node)) {
      const normalizedKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_');
      const explicitRawField = normalizedKey === 'image_ori_raw'
        || normalizedKey === 'image_raw'
        || normalizedKey === 'image_ori_raw_url'
        || normalizedKey === 'image_raw_url'
        || normalizedKey === 'original_image'
        || normalizedKey === 'original_image_url'
        || normalizedKey === 'origin_image'
        || normalizedKey === 'origin_image_url'
        || normalizedKey.startsWith('image_ori_raw_')
        || normalizedKey.startsWith('image_raw_');
      const candidates = imageUrlsFromValue(value);
      const trustedCandidates = candidates.filter((candidate) => isTrustedRawImageUrl(candidate, explicitRawField));
      // url_list 可能先放带水印展示图，再放 image_raw 原图；不能因首项不可信而丢弃整组。
      const url = trustedCandidates.find((candidate) => isExplicitRawImageUrl(candidate))
        || trustedCandidates[0]
        || '';
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      items.push({ type: 'image', url });
    }
  });
  return items;
}

/** 从原始图片字段读取 URL，不遍历普通 DOM/展示图片对象。 */
function imageUrlsFromValue(value: unknown, depth = 0): string[] {
  if (depth > 10) return [];
  const urls: string[] = [];
  const add = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (isHttpUrl(trimmed) && !urls.includes(trimmed)) urls.push(trimmed);
  };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (isHttpUrl(trimmed)) return [trimmed];
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return imageUrlsFromValue(JSON.parse(trimmed) as unknown, depth + 1); } catch { return []; }
    }
    return [];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      for (const url of imageUrlsFromValue(item, depth + 1)) add(url);
    }
    return urls;
  }
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['url_list', 'urlList', 'urls', 'download_url_list', 'url', 'uri', 'raw_url', 'origin_url', 'download_url']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && isHttpUrl(candidate.trim())) add(candidate);
    else if (Array.isArray(candidate) || (candidate && typeof candidate === 'object')) {
      for (const url of imageUrlsFromValue(candidate, depth + 1)) add(url);
    }
  }
  // Some responses wrap the URL one level deeper under image/image_ori/format_urls.
  for (const key of ['image_raw', 'image_ori_raw', 'image_ori', 'image', 'format_urls', 'formats', 'original', 'source']) {
    for (const url of imageUrlsFromValue(record[key], depth + 1)) add(url);
  }
  // 最后兼容未知包装层，但仍由上层字段判断是否属于原始图片。
  for (const [key, child] of Object.entries(record)) {
    if (['url_list', 'urlList', 'urls', 'download_url_list', 'url', 'uri', 'raw_url', 'origin_url', 'download_url', 'image_raw', 'image_ori_raw', 'image_ori', 'image', 'format_urls', 'formats', 'original', 'source'].includes(key)) continue;
    for (const url of imageUrlsFromValue(child, depth + 1)) add(url);
  }
  return urls;
}

function isWatermarkedImageUrl(url: string): boolean {
  const normalized = url.toLowerCase();
  return /(?:ds[_-]?wm|i[_-]?pre[_-]?wm|watermarked?|watermark)(?:[._/?-]|$)/i.test(normalized);
}

function isExplicitRawImageUrl(url: string): boolean {
  return /(?:image[_-]?raw|raw[_-]?image)/i.test(url);
}

function isTrustedRawImageUrl(url: string, explicitRawField: boolean): boolean {
  if (!isHttpUrl(url) || isWatermarkedImageUrl(url)) return false;
  // A raw field is trusted only because it came from the captured chain
  // response; generic image_ori/origin_url values need an explicit raw marker.
  return explicitRawField || isExplicitRawImageUrl(url);
}

interface PageVideoCaptureContext {
  captureToken: string;
  resetAt: number;
  expectedVid?: string;
}

async function readPageVideoCaptureContext(contents: WebContents): Promise<PageVideoCaptureContext | undefined> {
  if (isContentsDestroyed(contents)) return undefined;
  try {
    const context = await withTimeout(contents.executeJavaScript(`
      (function () {
        var cache = window.__doubaoVideoCache || {};
        return {
          captureToken: typeof cache.captureToken === 'string' ? cache.captureToken : '',
          resetAt: Number(cache.resetAt || 0),
          expectedVid: typeof cache.manualExpectedVid === 'string' ? cache.manualExpectedVid : ''
        };
      })()
    `, true), DEBUGGER_COMMAND_TIMEOUT_MS, '读取视频捕获令牌') as PageVideoCaptureContext;
    if (!context.captureToken || !Number.isFinite(context.resetAt) || context.resetAt <= 0) return undefined;
    return context;
  } catch {
    return undefined;
  }
}

async function sendPageMessage(contents: WebContents, message: Record<string, unknown>): Promise<void> {
  const serialized = JSON.stringify(message);
  await withTimeout(contents.executeJavaScript(`
    (function (message) {
      try {
        if (message && message.type === 'MEDIA_FOUND' && Array.isArray(message.items)) {
          var images = message.items.filter(function (item) {
            return item && item.type === 'image' && typeof item.url === 'string' && /^https?:\\/\\//i.test(item.url);
          });
          if (images.length && (message.source === 'doubao_extension' || message.source === 'dola_extension')) {
            var imageCache = window.__doubaoImageCache || { urls: [] };
            imageCache.urls = Array.isArray(imageCache.urls) ? imageCache.urls : [];
            images.forEach(function (item) {
              if (imageCache.urls.indexOf(item.url) === -1) imageCache.urls.push(item.url);
            });
            imageCache.lastFieldSource = message.source;
            imageCache.lastSourceKey = typeof message.sourceKey === 'string' ? message.sourceKey : '';
            imageCache.lastCapturedAt = Date.now();
            window.__doubaoImageCache = imageCache;
          }
        }
        if (message && message.type === 'MEDIA_FOUND'
            && (message.source === 'dola_extension' || message.source === 'doubao_extension')
            && Array.isArray(message.items)) {
          var video = message.items.find(function (item) {
            return item && item.type === 'video' && typeof item.url === 'string' && /^https?:\\/\\//i.test(item.url);
          });
          var vid = typeof message.vid === 'string' ? message.vid.trim() : '';
          var cache = window.__doubaoVideoCache || {};
          var messageToken = typeof message.captureToken === 'string' ? message.captureToken : '';
          var messageResetAt = Number(message.captureResetAt || 0);
          var proof = typeof message.watermarkFreeProof === 'string' ? message.watermarkFreeProof : '';
          var proofValid = (message.source === 'doubao_extension' && proof === 'doubao_fallback_unwatermarked_v1')
            || (message.source === 'dola_extension' && proof === 'dola_extension_decoded_v1');
          if (video && vid && proofValid && messageToken && messageToken === cache.captureToken
              && messageResetAt > 0 && messageResetAt === Number(cache.resetAt || 0)) {
            cache.lastVid = vid;
            cache[vid] = video.url;
            cache.lastVideoUrl = video.url;
            cache.lastFieldSource = message.source;
            cache.lastSourceKey = typeof message.sourceKey === 'string' ? message.sourceKey : '';
            cache.lastCapturedAt = Date.now();
            cache.lastCaptureToken = messageToken;
            cache.watermarkFreeProof = proof;
            cache.trustedExtensionVideo = {
              vid: vid,
              videoUrl: video.url,
              fieldSource: message.source,
              sourceKey: cache.lastSourceKey,
              capturedAt: cache.lastCapturedAt,
              captureToken: messageToken,
              resetAt: messageResetAt,
              watermarkFreeProof: proof
            };
            window.__doubaoVideoCache = cache;
          }
        }
      } catch (_) {}
      window.postMessage(message, '*');
    })(${serialized})
  `, true), DEBUGGER_COMMAND_TIMEOUT_MS, '页面消息注入').catch(() => undefined);
}

export async function fetchDoubaoFallbackJson(contents: WebContents, url: string, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await contents.session.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json,text/plain,*/*' },
      // 必须使用所选账号的独立 Session，不能丢失登录态或借用其它账号 Cookie。
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`fallback_api status=${response.status}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function captureChainResponse(
  contents: WebContents,
  paused: PausedRequest,
  source: 'doubao' | 'dola',
  state?: RequestState,
): Promise<void> {
  if (state && !requestIsActive(contents, paused.requestId, state)) return;
  const response = await sendCommand(contents, 'Fetch.getResponseBody', { requestId: paused.requestId }) as { body?: string; base64Encoded?: boolean };
  if (state && !requestIsActive(contents, paused.requestId, state)) return;
  const rawBody = response.base64Encoded ? fromBase64Utf8(response.body || '') : (response.body || '');
  let items: Array<{ type: 'image' | 'video'; url: string }> = [];
  let vid: string | undefined;
  let doubaoFallbackApis: string[] = [];
  const captureContext = await readPageVideoCaptureContext(contents);
  try {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      // SSE chain responses are still parsed by the field-aware extractors;
      // never fall back to arbitrary page image URLs.
      payload = rawBody;
    }
    if (source === 'dola') {
      items = extractDolaMediaItems(payload);
      vid = extractDolaMediaVid(payload);
      const expectedVid = captureContext?.expectedVid?.trim();
      if (expectedVid) {
        if (vid && vid !== expectedVid) {
          // 重放历史会话时只允许绑定用户当前选中的视频，拒绝同一页面上
          // 其他历史 chain 响应，避免把旧产物写入当前捕获缓存。
          items = [];
          vid = undefined;
        } else {
          // 某些 Dola chain 响应只带媒体字段、不重复返回 vid；该 vid
          // 已由首次只读解析从同一会话得到，可以安全用于本次重放绑定。
          vid = expectedVid;
        }
      }
    } else {
      items = extractDoubaoMediaItems(payload);
      vid = extractDoubaoMediaVid(payload, rawBody);
      doubaoFallbackApis = extractDoubaoFallbackApis(payload, rawBody);
      const expectedVid = captureContext?.expectedVid?.trim();
      if (expectedVid) {
        const matchingFallbackApis = filterDoubaoFallbackApisForVid(doubaoFallbackApis, expectedVid);
        if (matchingFallbackApis.length > 0) {
          doubaoFallbackApis = matchingFallbackApis;
          vid = expectedVid;
        } else if (vid !== expectedVid) {
          // 当前响应无法证明属于手动选中的视频，拒绝把其他历史产物写入缓存。
          doubaoFallbackApis = [];
        }
      }
    }
  } catch {
    console.warn(`[DolaBridge] ${source} chain 响应不是 JSON: webview=${contents.id}`);
  }
  const sourceKey = `${source}:${Date.now()}`;
  await sendPageMessage(contents, items.length > 0
    ? {
      __dolaExtensionBridge: true,
      type: 'MEDIA_FOUND',
      sourceKey,
      items,
      // 只有扩展解析出的原始字段才进入自动产物缓存；页面展示地址不会被标记为原始资源。
      source: source === 'dola' ? 'dola_extension' : 'doubao_extension',
      ...(vid ? { vid } : {}),
      ...(captureContext ? {
        captureToken: captureContext.captureToken,
        captureResetAt: captureContext.resetAt,
      } : {}),
      ...(source === 'dola' && items.some((item) => item.type === 'video')
        ? { watermarkFreeProof: 'dola_extension_decoded_v1' }
        : {}),
    }
    : { __dolaExtensionBridge: true, type: 'MEDIA_STATUS', sourceKey, text: '未提取到资源' });
  if (state && !requestIsActive(contents, paused.requestId, state)) return;
  console.log(`[DolaBridge] ${source} chain 捕获素材: ${items.length} 个, vid=${vid || 'unknown'}, webview=${contents.id}`);
  if (state) state.settled = true;
  await sendCommand(contents, 'Fetch.fulfillRequest', {
    requestId: paused.requestId,
    responseCode: paused.responseStatusCode || 200,
    responsePhrase: paused.responseStatusText || 'OK',
    responseHeaders: responseHeadersForCapturedBody(paused.responseHeaders, rawBody),
    body: toBase64Utf8(rawBody),
  });
  // 原响应已经放行；无水印地址的额外请求在后台完成，避免阻塞豆包页面渲染。
  if (source === 'doubao' && vid && doubaoFallbackApis.length > 0 && !isContentsDestroyed(contents)) {
    void resolveDoubaoFallbackVideoItems(
      doubaoFallbackApis,
      (url) => fetchDoubaoFallbackJson(contents, url),
    ).then(async (videoItems) => {
      if (videoItems.length === 0 || isContentsDestroyed(contents)) return;
      await sendPageMessage(contents, {
        __dolaExtensionBridge: true,
        type: 'MEDIA_FOUND',
        sourceKey,
        items: videoItems,
        source: 'doubao_extension',
        vid,
        ...(captureContext ? {
          captureToken: captureContext.captureToken,
          captureResetAt: captureContext.resetAt,
        } : {}),
        watermarkFreeProof: 'doubao_fallback_unwatermarked_v1',
      });
      console.log(`[DolaBridge] 豆包插件无水印视频已写入缓存: vid=${vid}, webview=${contents.id}`);
    }).catch((error: unknown) => {
      console.warn('[DolaBridge] 豆包 fallback_api 无水印解析失败:', error instanceof Error ? error.message : error);
    });
  }
}

/**
 * 从 Network 域读取已经完成的 Dola 响应。
 *
 * Dola 的 chain/completion 通常是长连接 SSE。Fetch Response 阶段会在响应头
 * 到达时暂停它，页面因此要等整条流结束才能继续渲染。Network 域只观察已完成
 * 的请求，不会阻塞页面；无水印解析仍使用同一套提取器和缓存消息。
 */
async function captureDolaNetworkResponse(
  contents: WebContents,
  response: DolaNetworkResponse,
): Promise<void> {
  if (isContentsDestroyed(contents)) return;
  let body: { body?: string; base64Encoded?: boolean };
  try {
    body = await sendCommand(contents, 'Network.getResponseBody', {
      requestId: response.requestId,
    }) as { body?: string; base64Encoded?: boolean };
  } catch (error: unknown) {
    console.warn(
      `[DolaBridge] Network 响应体读取失败: webview=${contents.id}, request=${response.requestId}, ` +
        `${error instanceof Error ? error.message : 'unknown'}`,
    );
    return;
  }

  const rawBody = body.base64Encoded ? fromBase64Utf8(body.body || '') : (body.body || '');
  let items: Array<{ type: 'image' | 'video'; url: string }> = [];
  let vid: string | undefined;
  const captureContext = await readPageVideoCaptureContext(contents);
  try {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = rawBody;
    }
    items = extractDolaMediaItems(payload);
    vid = extractDolaMediaVid(payload);
    const expectedVid = captureContext?.expectedVid?.trim();
    if (expectedVid) {
      if (vid && vid !== expectedVid) {
        items = [];
        vid = undefined;
      } else {
        vid = expectedVid;
      }
    }
  } catch {
    console.warn(`[DolaBridge] Dola Network 响应不是可解析媒体: webview=${contents.id}`);
  }

  const sourceKey = `dola:${response.requestId}`;
  await sendPageMessage(contents, items.length > 0
    ? {
      __dolaExtensionBridge: true,
      type: 'MEDIA_FOUND',
      sourceKey,
      items,
      source: 'dola_extension',
      ...(vid ? { vid } : {}),
      ...(captureContext ? {
        captureToken: captureContext.captureToken,
        captureResetAt: captureContext.resetAt,
      } : {}),
      ...(items.some((item) => item.type === 'video')
        ? { watermarkFreeProof: 'dola_extension_decoded_v1' }
        : {}),
    }
    : { __dolaExtensionBridge: true, type: 'MEDIA_STATUS', sourceKey, text: '未提取到资源' });
  console.log(
    `[DolaBridge] Dola Network 后台捕获素材: ${items.length} 个, ` +
      `vid=${vid || 'unknown'}, webview=${contents.id}`,
  );
}

async function inspectDolaSubmissionRequest(contents: WebContents, paused: PausedRequest, state?: RequestState): Promise<void> {
  if (state && !requestIsActive(contents, paused.requestId, state)) return;
  const postData = paused.request?.postData || '';
  const evidence = extractDolaSubmissionConfig(postData);
  console.log(
    `[DolaBridge] Dola 提交参数证据: webview=${contents.id} bodyBytes=${Buffer.byteLength(postData, 'utf8')} config=${JSON.stringify(evidence)}`,
  );
  await continueRequest(contents, paused.requestId, state);
  if (state) {
    const pendingResponse = releaseRequestState(contents, paused.requestId, state);
    if (pendingResponse) void handlePausedRequest(contents, pendingResponse);
  }
}

export function patchActionBarDuration(body: string, includeDolaFastFifteen = false): string {
  try {
    const json: unknown = JSON.parse(body);
    // action_bar 接口通常返回普通 JSON 对象，而不是嵌套 JSON 字符串。
    // 直接走时长选择器递归，否则旧实现只会检查字符串字段，实际不会改响应。
    const changed = patchDurationSelector(json);
    const dolaFastChanged = includeDolaFastFifteen && patchDolaFastDuration(json);
    const dolaModelChanged = includeDolaFastFifteen && patchDola25Model(json);
    return changed || dolaFastChanged || dolaModelChanged ? JSON.stringify(json) : body;
  } catch {
    return body;
  }
}

/**
 * 在保留平台实时 skill-pack 的前提下补充通用 30s 与 Dola Fast 15s。
 * 只有实时响应无法解析时才回退到内置夹具；不会用夹具覆盖实时模型列表。
 */
export function patchSkillPackDuration(body: string, fallbackBody = '', ensureDola25 = false): string {
  if (body) {
    try {
      const json: unknown = JSON.parse(body);
      patchDurationSelector(json);
      // 实时 Dola skill-pack 可能暂时没有返回 2.5；只在 Dola 响应中
      // 增量补齐该模型和能力，不覆盖平台已经返回的模型列表。
      if (ensureDola25) {
        patchDolaFastDuration(json);
        patchDola25Model(json);
      }
      return JSON.stringify(json);
    } catch {
      // 继续尝试静态兜底。
    }
  }
  if (fallbackBody) {
    try {
      const json: unknown = JSON.parse(fallbackBody);
      patchDurationSelector(json);
      if (ensureDola25) {
        patchDolaFastDuration(json);
        patchDola25Model(json);
      }
      return JSON.stringify(json);
    } catch {
      // 保留原始 body，交给页面按原协议处理。
    }
  }
  return body || fallbackBody;
}

function normalizedModelKey(value: unknown): string {
  return String(value || '').replace(/_/g, '-').toLowerCase();
}

function modelControlKey(record: Record<string, unknown>): string {
  for (const key of ['key', 'value', 'param_key', 'valueKey', 'value_key', 'submitKey']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return normalizedModelKey(value);
  }
  return '';
}

function modelOptionValue(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  for (const key of ['option_key', 'value', 'model', 'model_key', 'modelKey']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return modelOptionValue(record.option);
}

function isDolaModelOption(value: unknown): boolean {
  return ['seedance_v2.0', 'seedance_v2.0_std', 'seedance_v2.0_mini', 'ic_mini', 'seedance_v2.5']
    .includes(modelOptionValue(value));
}

function modelOptionTemplate(options: unknown[]): Record<string, unknown> {
  const template = options.find((option) => option && typeof option === 'object') as Record<string, unknown> | undefined;
  const inner = template?.option;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return {
      ...template,
      option: {
        ...(inner as Record<string, unknown>),
        value: 'seedance_v2.5',
        show_name: 'Seedance2.5',
        display_text: 'Dreamina Seedance 2.5',
        sub_display: 'Dreamina Seedance 2.5',
        is_default: false,
      },
    };
  }
  const actionShape = Boolean(template && (
    Object.hasOwn(template, 'option_key') || Object.hasOwn(template, 'display_text')
  ));
  return actionShape
    ? {
      ...template,
      id: Math.max(0, ...options.map((option) => Number((option as Record<string, unknown>)?.id) || 0)) + 1,
      option_key: 'seedance_v2.5',
      display_text: 'Dreamina Seedance 2.5',
      message_text: '',
    }
    : {
      ...template,
      show_name: 'Seedance2.5',
      display_text: 'Dreamina Seedance 2.5',
      value: 'seedance_v2.5',
      is_default: false,
      sub_display: 'Dreamina Seedance 2.5',
      subscription_tag: 'none',
    };
}

function patchDolaModelOptions(options: unknown[]): boolean {
  if (!Array.isArray(options) || !options.some(isDolaModelOption) || options.some((option) => modelOptionValue(option) === 'seedance_v2.5')) {
    return false;
  }
  options.unshift(modelOptionTemplate(options));
  return true;
}

function patchDola25Model(value: unknown, seen = new Set<object>(), parent?: Record<string, unknown> | unknown[], parentKey?: string | number): boolean {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('[')) || !/seedance|video-model|valueKey/i.test(trimmed)) return false;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const changed = patchDola25Model(parsed, new Set<object>());
      if (changed && parent != null && parentKey != null) {
        if (Array.isArray(parent) && typeof parentKey === 'number') parent[parentKey] = JSON.stringify(parsed);
        if (!Array.isArray(parent) && typeof parentKey === 'string') parent[parentKey] = JSON.stringify(parsed);
      }
      return changed;
    } catch {
      return false;
    }
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  let changed = false;
  if (Array.isArray(value)) {
    changed = patchDolaModelOptions(value);
    for (let index = 0; index < value.length; index += 1) {
      changed = patchDola25Model(value[index], seen, value, index) || changed;
    }
    return changed;
  }
  const record = value as Record<string, unknown>;
  const key = modelControlKey(record);
  if (key === 'model' || key === 'video-model') {
    for (const field of ['option_list', 'options', 'selections', 'items']) {
      if (Array.isArray(record[field])) changed = patchDolaModelOptions(record[field] as unknown[]) || changed;
    }
  }
  if (record.model_capability && typeof record.model_capability === 'object' && !Array.isArray(record.model_capability)) {
    const capabilities = record.model_capability as Record<string, unknown>;
    if (!capabilities['seedance_v2.5']) {
      capabilities['seedance_v2.5'] = {
        supported_durations: ['5', '10', '30'],
        supported_resolutions: ['720p'],
        support_video_ref: true,
      };
      changed = true;
    }
  }
  for (const [childKey, child] of Object.entries(record)) {
    if (Array.isArray(child) && ['options', 'option_list', 'selections', 'items'].includes(childKey)) {
      changed = patchDolaModelOptions(child) || changed;
    }
    changed = patchDola25Model(child, seen, record, childKey) || changed;
  }
  return changed;
}

function patchDolaFastDuration(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) changed = patchDolaFastDuration(item, seen) || changed;
    return changed;
  }

  const record = value as Record<string, unknown>;
  changed = patchDolaFifteenLegacySelector(record) || changed;
  changed = patchDolaFifteenModernSelector(record) || changed;
  changed = patchDolaFastDurationCapabilities(record) || changed;

  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string') {
      const patched = patchDolaFastDurationString(child);
      if (patched !== child) {
        record[key] = patched;
        changed = true;
      }
    } else {
      changed = patchDolaFastDuration(child, seen) || changed;
    }
  }
  return changed;
}

function patchDolaFifteenLegacySelector(record: Record<string, unknown>): boolean {
  const optionList = record.option_list;
  if ((record.label !== '时长' && record.label !== '鏃堕暱') || !Array.isArray(optionList)) return false;
  const hasFifteen = optionList.some((option) => (
    option && typeof option === 'object' && String((option as Record<string, unknown>).option_key || '') === '15'
  ));
  if (hasFifteen) return false;
  const tenIndex = optionList.findIndex((option) => (
    option && typeof option === 'object' && String((option as Record<string, unknown>).option_key || '') === '10'
  ));
  optionList.splice(tenIndex >= 0 ? tenIndex + 1 : optionList.length, 0, createFifteenSecondOption(optionList));
  return true;
}

function patchDolaFifteenModernSelector(record: Record<string, unknown>): boolean {
  if (record.value !== 'duration' || !Array.isArray(record.options)) return false;
  const options = record.options as unknown[];
  const hasFifteen = options.some((option) => (
    option && typeof option === 'object' && (
      String((option as Record<string, unknown>).value || '') === '15' ||
      String((option as Record<string, unknown>).show_name || '').replace(/\s+/g, '').toLowerCase() === '15s'
    )
  ));
  if (hasFifteen) return false;
  const tenIndex = options.findIndex((option) => (
    option && typeof option === 'object' && String((option as Record<string, unknown>).value || '') === '10'
  ));
  options.splice(tenIndex >= 0 ? tenIndex + 1 : options.length, 0, {
    show_name: '15s', value: '15', is_default: false, sub_display: '',
  });
  return true;
}

function patchDolaFastDurationCapabilities(record: Record<string, unknown>): boolean {
  const capabilityMap = record.model_capability;
  if (!capabilityMap || typeof capabilityMap !== 'object' || Array.isArray(capabilityMap)) return false;
  const capabilities = capabilityMap as Record<string, unknown>;
  let changed = false;
  for (const modelKey of ['seedance_v2.0', 'seedance_v2.0_fast']) {
    const capability = capabilities[modelKey];
    if (!capability || typeof capability !== 'object' || Array.isArray(capability)) continue;
    const durations = (capability as Record<string, unknown>).supported_durations;
    if (!Array.isArray(durations) || durations.some((duration) => String(duration) === '15')) continue;
    const tenIndex = durations.findIndex((duration) => String(duration) === '10');
    durations.splice(tenIndex >= 0 ? tenIndex + 1 : durations.length, 0, '15');
    changed = true;
  }
  return changed;
}

function patchDolaFastDurationString(text: string): string {
  if (!text.includes('duration') && !text.includes('时长') && !text.includes('鏃堕暱')) return text;
  try {
    const nested: unknown = JSON.parse(text);
    return patchDolaFastDuration(nested) ? JSON.stringify(nested) : text;
  } catch {
    return text;
  }
}

function patchJsonStringDuration(text: string): string {
  if (!text || (!text.includes('时长') && !text.includes('鏃堕暱') && !text.includes('duration'))) return text;
  try {
    const json: unknown = JSON.parse(text);
    return patchDurationSelector(json) ? JSON.stringify(json) : text;
  } catch {
    return text;
  }
}

function patchDurationSelector(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  let changed = false;

  if (Array.isArray(value)) {
    for (const item of value) changed = patchDurationSelector(item, seen) || changed;
    return changed;
  }

  const record = value as Record<string, unknown>;
  const label = record.label;
  const optionList = record.option_list;
  if ((label === '时长' || label === '鏃堕暱') && Array.isArray(optionList)) {
    const hasThirty = optionList.some((option) => (
      option && typeof option === 'object' && (option as Record<string, unknown>).option_key === '30'
    ));
    if (!hasThirty) {
      const tenIndex = optionList.findIndex((option) => (
        option && typeof option === 'object' && (option as Record<string, unknown>).option_key === '10'
      ));
      const insertIndex = tenIndex >= 0 ? tenIndex + 1 : optionList.length;
      optionList.splice(insertIndex, 0, createThirtySecondOption(optionList));
      changed = true;
    }
  }

  // Dola 新版 action_bar 使用 value/options/display_text/value 字段。
  // 两种格式都保留原有顺序，并只在确实缺少 30s 时插入一个非默认选项。
  if (record.value === 'duration' && Array.isArray(record.options)) {
    const options = record.options as unknown[];
    const hasThirty = options.some((option) => (
      option && typeof option === 'object' && (
        String((option as Record<string, unknown>).value || '') === '30' ||
        String((option as Record<string, unknown>).show_name || '').replace(/\s+/g, '').toLowerCase() === '30s'
      )
    ));
    if (!hasThirty) {
      const tenIndex = options.findIndex((option) => (
        option && typeof option === 'object' && String((option as Record<string, unknown>).value || '') === '10'
      ));
      const insertIndex = tenIndex >= 0 ? tenIndex + 1 : options.length;
      options.splice(insertIndex, 0, { show_name: '30s', value: '30', is_default: false, sub_display: '' });
      changed = true;
    }
  }

  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string') {
      const patched = patchJsonStringDuration(child);
      if (patched !== child) {
        record[key] = patched;
        changed = true;
      }
    } else {
      changed = patchDurationSelector(child, seen) || changed;
    }
  }
  return changed;
}

function createThirtySecondOption(optionList: unknown[]): Record<string, unknown> {
  const maxId = optionList.reduce<number>((max, option) => {
    const id = option && typeof option === 'object' ? Number((option as Record<string, unknown>).id) : NaN;
    return Number.isFinite(id) ? Math.max(max, id) : max;
  }, 0);
  return { id: maxId + 1, display_text: '30s', message_text: '', option_key: '30' };
}

function createFifteenSecondOption(optionList: unknown[]): Record<string, unknown> {
  const maxId = optionList.reduce<number>((max, option) => {
    const id = option && typeof option === 'object' ? Number((option as Record<string, unknown>).id) : NaN;
    return Number.isFinite(id) ? Math.max(max, id) : max;
  }, 0);
  return { id: maxId + 1, display_text: '15s', message_text: '', option_key: '15' };
}

async function sendCommand(contents: WebContents, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return withTimeout(contents.debugger.sendCommand(method, params), DEBUGGER_COMMAND_TIMEOUT_MS, `调试器命令 ${method}`);
}

/**
 * 对已经存在的文档补一次主世界守卫。新文档仍由
 * Page.addScriptToEvaluateOnNewDocument 提前注入；这里只覆盖扩展加载晚于
 * 页面导航、或 Chromium 漏发 document_start 的 Dola 会话。
 */
async function injectDolaLocaleGuard(contents: WebContents, reason: string): Promise<void> {
  if (isContentsDestroyed(contents) || !isDolaDocument(contents)) return;
  if (localeGuardInjectionAttempted.has(contents)) return;
  localeGuardInjectionAttempted.add(contents);
  try {
    await withTimeout(
      contents.executeJavaScript(DOLA_LOCALE_PRELOAD_SCRIPT, true),
      5_000,
      `Dola 语言守卫注入(${reason})`,
    );
    console.log(`[DolaBridge] 已补注入 Dola 语言守卫: webview=${contents.id}, reason=${reason}`);
  } catch (error: unknown) {
    // 补注入失败不能影响既有 Fetch bridge；文档前脚本和扩展脚本仍可生效。
    console.warn(
      `[DolaBridge] Dola 语言守卫补注入失败: webview=${contents.id}, reason=${reason}, ` +
        `${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

async function continueRequest(contents: WebContents, requestId: string, state?: RequestState): Promise<void> {
  if (state) {
    if (state.releasePromise) return state.releasePromise;
    state.settled = true;
  }
  const release: Promise<void> = sendCommand(contents, 'Fetch.continueRequest', { requestId })
    .then(() => undefined)
    .catch(() => undefined);
  if (state) state.releasePromise = release;
  await release;
}

/**
 * Request 阶段放行后立即释放占位，避免 Response 阶段复用 requestId 时被旧状态吞掉。
 * 返回已排队的响应事件，由调用方在放行完成后顺序处理。
 */
function releaseRequestState(
  contents: WebContents,
  requestId: string,
  state: RequestState,
): PausedRequest | undefined {
  const requests = inFlightRequests.get(contents);
  if (!requests || requests.get(requestId) !== state) return undefined;
  const pendingResponse = state.pendingResponse;
  requests.delete(requestId);
  if (requests.size === 0 && inFlightRequests.get(contents) === requests) {
    inFlightRequests.delete(contents);
  }
  return pendingResponse;
}

async function rewriteSkillPack(contents: WebContents, paused: PausedRequest, fileName: string, state?: RequestState): Promise<void> {
  if (state && !requestIsActive(contents, paused.requestId, state)) return;
  const method = (paused.request?.method || '').toUpperCase();
  if (method === 'OPTIONS') {
    if (state) state.settled = true;
    await sendCommand(contents, 'Fetch.fulfillRequest', {
      requestId: paused.requestId,
      responseCode: 204,
      responsePhrase: 'No Content',
      responseHeaders: contentTypeHeaders(''),
    });
    return;
  }
  let liveBody = '';
  try {
    const response = await sendCommand(contents, 'Fetch.getResponseBody', { requestId: paused.requestId }) as {
      body?: string;
      base64Encoded?: boolean;
    };
    liveBody = response.base64Encoded ? fromBase64Utf8(response.body || '') : (response.body || '');
  } catch {
    // 某些旧版响应在暂停时没有可读 body；此时才使用静态兜底，避免把
    // 一个空响应直接回放给页面。
  }
  const fallbackBody = readExtensionBody(fileName);
  const body = patchSkillPackDuration(liveBody, fallbackBody, fileName === 'dola-skill-pack-response.json');
  if (state && !requestIsActive(contents, paused.requestId, state)) return;
  console.log(`[DolaBridge] 已增量修补 ${fileName} 配置响应（保留实时模型与增量时长能力）: webview=${contents.id}`);
  if (state) state.settled = true;
  await sendCommand(contents, 'Fetch.fulfillRequest', {
    requestId: paused.requestId,
    responseCode: 200,
    responsePhrase: 'OK',
    responseHeaders: contentTypeHeaders(body),
    body: toBase64Utf8(body),
  });
}

async function rewriteActionBar(contents: WebContents, paused: PausedRequest, state?: RequestState): Promise<void> {
  if (state && !requestIsActive(contents, paused.requestId, state)) return;
  const response = await sendCommand(contents, 'Fetch.getResponseBody', { requestId: paused.requestId }) as {
    body?: string;
    base64Encoded?: boolean;
  };
  if (state && !requestIsActive(contents, paused.requestId, state)) return;
  const rawBody = response.base64Encoded ? Buffer.from(response.body || '', 'base64').toString('utf8') : (response.body || '');
  const body = patchActionBarDuration(rawBody, isDolaNetworkHost(paused.request?.url || ''));
  if (state) state.settled = true;
  await sendCommand(contents, 'Fetch.fulfillRequest', {
    requestId: paused.requestId,
    responseCode: paused.responseStatusCode || 200,
    responsePhrase: paused.responseStatusText || 'OK',
    responseHeaders: responseHeadersForTextBody(paused.responseHeaders, body),
    body: toBase64Utf8(body),
  });
}

async function processPausedRequest(contents: WebContents, paused: PausedRequest, state: RequestState): Promise<void> {
  if (!requestIsActive(contents, paused.requestId, state)) return;
  const url = paused.request?.url || '';
  if (url.includes(DOUBAO_SKILL_PACK_URL_PART)) {
    await rewriteSkillPack(contents, paused, 'doubao-skill-pack-response.json', state);
    return;
  }
  if (url.includes(DOLA_SKILL_PACK_URL_PART)) {
    await rewriteSkillPack(contents, paused, 'dola-skill-pack-response.json', state);
    return;
  }
  if (url.includes(ACTION_BAR_CONF_URL_PART)) {
    console.log(`[DolaBridge] 命中 action bar 配置响应: webview=${contents.id}`);
    await rewriteActionBar(contents, paused, state);
    return;
  }
  if (url.includes(DOLA_CHAIN_SINGLE_URL_PART) && getDolaPausedRequestStage(paused) === 'request') {
    await inspectDolaSubmissionRequest(contents, paused, state);
    return;
  }
  if (url.includes(DOLA_CHAIN_SINGLE_URL_PART)) {
    await captureChainResponse(contents, paused, 'dola', state);
    return;
  }
  if (url.includes(DOUBAO_CHAIN_SINGLE_URL_PART)) {
    await captureChainResponse(contents, paused, 'doubao', state);
    return;
  }
  if (isCompletionUrl(url, DOLA_COMPLETION_URL_PART)) {
    await captureChainResponse(contents, paused, 'dola', state);
    return;
  }
  if (isCompletionUrl(url, DOUBAO_COMPLETION_URL_PART)) {
    await captureChainResponse(contents, paused, 'doubao', state);
    return;
  }
  if (isDoubaoImageResponseUrl(url)) {
    await captureChainResponse(contents, paused, 'doubao', state);
    return;
  }
  await continueRequest(contents, paused.requestId, state);
}

async function handlePausedRequest(contents: WebContents, paused: PausedRequest): Promise<void> {
  if (!paused.requestId) return;
  const requests = inFlightRequests.get(contents) || new Map<string, RequestState>();
  const stage = getDolaPausedRequestStage(paused);
  const existing = requests.get(paused.requestId);
  if (existing) {
    // Request/Response 阶段会复用 requestId；等 Request 放行后再处理响应，
    // 同阶段的重复事件仍然直接忽略，避免重复 fulfill/continue。
    if (shouldQueueDolaResponse(existing.stage, stage) && !existing.pendingResponse) {
      existing.pendingResponse = paused;
    }
    return;
  }
  const state: RequestState = { cancelled: false, settled: false, stage };
  requests.set(paused.requestId, state);
  inFlightRequests.set(contents, requests);
  const processing = processPausedRequest(contents, paused, state);
  try {
    await withTimeout(
      processing,
      PAUSED_REQUEST_TIMEOUT_MS,
      `暂停请求 ${paused.requestId}`,
    );
  } catch (error: unknown) {
    state.cancelled = true;
    console.warn('[DolaBridge] 处理暂停请求失败，继续原请求:', error instanceof Error ? error.message : error);
    // A timed-out debugger operation must never leave Fetch.requestPaused
    // hanging; the bounded command either releases it or fails harmlessly.
    await continueRequest(contents, paused.requestId, state).catch(() => undefined);
  } finally {
    // Keep a timed-out request in the map until its underlying work settles;
    // a late CDP response must not start a second handler for the same ID.
    const cleanup = (): void => {
      if (requests.get(paused.requestId) === state) requests.delete(paused.requestId);
      if (requests.size === 0 && inFlightRequests.get(contents) === requests) inFlightRequests.delete(contents);
    };
    if (state.cancelled) {
      void processing.then(cleanup, cleanup);
    } else {
      cleanup();
    }
  }
}

function cleanupContents(contents: WebContents): void {
  const listeners = debuggerListeners.get(contents);
  if (listeners) {
    contents.debugger.removeListener('message', listeners.message);
    contents.debugger.removeListener('detach', listeners.detach);
    contents.removeListener('destroyed', listeners.destroyed);
    debuggerListeners.delete(contents);
  }
  attachedContents.delete(contents);
  attachingContents.delete(contents);
  inFlightRequests.delete(contents);
  dolaNetworkResponses.delete(contents);
  trackedContents.delete(contents);
}

async function attachToContents(contents: WebContents): Promise<void> {
  if (attachedContents.has(contents)) return;
  const existing = attachingContents.get(contents);
  if (existing) return existing;

  const promise = (async () => {
    try {
      if (!contents.debugger.isAttached()) contents.debugger.attach(DEBUGGER_VERSION);
      const message = (_event: Electron.Event, method: string, params: unknown): void => {
        if (method === 'Network.responseReceived') {
          observeDolaNetworkResponse(contents, params);
          return;
        }
        if (method === 'Network.loadingFinished') {
          finishDolaNetworkResponse(contents, params);
          return;
        }
        if (method === 'Network.loadingFailed') {
          failDolaNetworkResponse(contents, params);
          return;
        }
        if (method !== 'Fetch.requestPaused' || !params || typeof params !== 'object') return;
        void handlePausedRequest(contents, params as PausedRequest);
      };
      const detach = (_event: Electron.Event, reason: string): void => {
        attachedContents.delete(contents);
        attachingContents.delete(contents);
        console.warn(`[DolaBridge] webview 调试器已分离: ${reason || 'unknown'}`);
        cleanupContents(contents);
      };
      const destroyed = (): void => cleanupContents(contents);
      contents.debugger.on('message', message);
      contents.debugger.on('detach', detach);
      contents.on('destroyed', destroyed);
      debuggerListeners.set(contents, { message, detach, destroyed });
      trackedContents.add(contents);
      // Register the guard before normal page scripts in the main world. This
      // is best-effort: a failure must not disable the existing Fetch bridge.
      try {
        await sendCommand(contents, 'Page.enable');
        await sendCommand(contents, 'Page.addScriptToEvaluateOnNewDocument', {
          source: DOLA_LOCALE_PRELOAD_SCRIPT,
        });
        await sendCommand(contents, 'Page.addScriptToEvaluateOnNewDocument', {
          source: MANUAL_VIDEO_CAPTURE_PRELOAD_SCRIPT,
        });
        console.log(`[DolaBridge] 已注册 Dola 文档前语言守卫: webview=${contents.id}`);
        void injectDolaLocaleGuard(contents, 'attach');
      } catch (error: unknown) {
        console.warn(
          `[DolaBridge] 文档前语言守卫注册失败，继续使用扩展守卫: webview=${contents.id}, ` +
            `${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      // Dola 的长连接只通过 Network 域观察完成事件，失败不能影响既有
      // Fetch bridge；启用失败时仍继续注册后续拦截规则。
      try {
        await sendCommand(contents, 'Network.enable');
      } catch (error: unknown) {
        console.warn(
          `[DolaBridge] Network 观察域启用失败，继续使用 Fetch bridge: webview=${contents.id}, ` +
            `${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      await sendCommand(contents, 'Fetch.enable', { patterns: FETCH_PATTERNS });
      // detach/destroy 可能与 Fetch.enable 并发发生；不要在旧 Promise 完成后
      // 把已经清理的 WebContents 重新标记为 attached，避免后续请求无人处理。
      if (isContentsDestroyed(contents) || !debuggerListeners.has(contents) || !contents.debugger.isAttached()) {
        cleanupContents(contents);
        return;
      }
      attachedContents.add(contents);
      console.log(`[DolaBridge] 已启用 webview 网络拦截: ${contents.id}`);
    } catch (error: unknown) {
      cleanupContents(contents);
      console.warn('[DolaBridge] webview 网络拦截启用失败:', error instanceof Error ? error.message : error);
    }
  })();
  attachingContents.set(contents, promise);
  await promise;
  if (!attachedContents.has(contents)) attachingContents.delete(contents);
}

/** 注册后续 webview 的原生网络拦截；主窗口自身不参与。 */
export function registerDolaExtensionNetworkBridge(): () => void {
  const onWebContentsCreated = (_event: Electron.Event, contents: WebContents): void => {
    if (contents.getType() !== 'webview') return;
    void attachToContents(contents);
  };
  app.on('web-contents-created', onWebContentsCreated);
  return () => {
    app.removeListener('web-contents-created', onWebContentsCreated);
    for (const contents of [...trackedContents]) cleanupContents(contents);
  };
}
