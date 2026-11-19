/**
 * src/utils/doubaoBridge.ts
 * 豆包 webview DOM 操作工具函数
 *
 * 所有函数通过 webview.executeJavaScript() 注入 JS 到豆包页面 DOM 中执行。
 * 豆包 chat 页面结构（https://www.doubao.com/chat/）：
 * - 输入框：textarea 或 contenteditable div
 * - 发送按钮：输入框附近，aria-label 含"发送"或 SVG 图标
 * - 生成中指示器：Stop 按钮可见 / loading 动画存在
 * - 结果区域：对话消息列表容器
 *
 * 关键原则：
 * 1. 所有注入的 JS 代码必须是纯 JavaScript，不能有任何 TypeScript 语法
 * 2. 选择器尽量宽泛，兼容豆包页面 DOM 变化
 * 3. 每个 executeJavaScript 调用都有 10s 超时保护
 */

import { classifyMaterialAuthorizationSnapshot, decideMaterialAuthorizationAutoConfirm } from './materialAuthorization';
import type { MaterialAuthorizationState } from './materialAuthorization';
import {
  MAX_REFERENCE_IMAGE_COUNT,
  buildComposerRootProbe,
  buildImageUploadSnapshotProbe,
  buildUploadPendingProbe,
  classifyUploadReadinessFailure,
  getObservedUploadCount,
  nextStableUploadCount,
} from './uploadReadiness';
import { REFERENCE_VIDEO_LIMIT, REFERENCE_AUDIO_LIMIT } from './referenceMaterialLimits';
import type { UploadReadinessDiagnostic, UploadReadinessSnapshot } from './uploadReadiness';
import { classifyGenerationConfirmationText } from './generationConfirmation';
import type { GenerationConfirmationEvidence } from './generationConfirmation';
import { VideoControlReadinessError, waitForVideoControlReadiness } from './videoControlReadiness';
import type { VideoControlReadinessResult } from './videoControlReadiness';
import { buildDoubaoCompositeControlProbe, parseVideoCompositeControlText } from './doubaoCompositeControl';
import type { DoubaoCompositeControlSnapshot } from './doubaoCompositeControl';
export { parseVideoCompositeControlText } from './doubaoCompositeControl';
import type { AccountPlatform } from '@doubao-studio/contracts';
import { selectLatestAssistantReply } from './conversationResult';
import type { ConversationMessageCandidate } from './conversationResult';

// ==================== 类型 ====================

/** webview 最小接口（Electron 渲染进程 webview 元素） */
export interface WebviewHandle {
  executeJavaScript(code: string): Promise<any>;
  loadURL(url: string): void;
  getURL(): string;
  sendInputEvent?(event: ElectronInputEvent): void;
}

/** Dola 动态控件尚未挂载；这是可恢复的提交前状态，不是账号掉线。 */
export class DolaVideoControlReadinessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DolaVideoControlReadinessError';
    this.code = code;
  }
}

/** Electron webview sendInputEvent 的键盘事件类型 */
interface ElectronKeyboardEvent {
  type: 'keyDown' | 'keyUp' | 'char';
  keyCode?: string;
  code?: string;
  key?: string;
  text?: string;
  modifiers?: string[];
}

/** Electron webview sendInputEvent 的鼠标事件类型 */
interface ElectronMouseEvent {
  type: 'mouseDown' | 'mouseUp' | 'mouseMove';
  x: number;
  y: number;
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
}

type ElectronInputEvent = ElectronKeyboardEvent | ElectronMouseEvent;

// ==================== 工具函数 ====================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 带超时的 executeJavaScript */
async function safeExecuteJS<T>(
webview: WebviewHandle,
code: string,
timeoutMs: number = 10000,
label: string = 'executeJS'
): Promise<T> {
return Promise.race([
webview.executeJavaScript(code),
new Promise<never>((_, reject) =>
setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs)
),
]);
}

/**
 * 将 Promise 与 AbortSignal 竞争：signal abort 时立即返回 fallback 值。
 * 原始 Promise 在后台继续执行（页内 AbortController 会自行收尾），
 * 调用方无需等待请求自身的超时。
 */
function raceWithAbort<T>(
promise: Promise<T>,
signal: AbortSignal | undefined,
fallback: T,
): Promise<T> {
if (!signal) return promise;
if (signal.aborted) return Promise.resolve(fallback);
return new Promise<T>((resolve) => {
let settled = false;
const onAbort = () => {
if (!settled) { settled = true; resolve(fallback); }
};
signal.addEventListener('abort', onAbort, { once: true });
promise.then(
(val) => {
if (!settled) {
settled = true;
signal.removeEventListener('abort', onAbort);
resolve(val);
}
},
() => {
if (!settled) {
settled = true;
signal.removeEventListener('abort', onAbort);
resolve(fallback);
}
},
);
});
}

/** 从未知类型的错误中提取消息 */
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * 豆包编辑器会把换行折叠为空格，并可能插入 NBSP/零宽字符。
 * 只规范这些无语义差异；标点、引号、英文台词和字符顺序必须完整保留。
 */
export function normalizePromptForComposer(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tiptap/ProseMirror 需要真实的块级节点才能保留换行；仅写入 textContent
 * 会让浏览器把画布中的多行提示词渲染并提交成一段连续正文。
 */
export function buildContentEditablePromptHtml(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const escaped = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      return `<p>${escaped || '<br>'}</p>`;
    })
    .join('');
}

/**
 * Dola 30 秒新对话的兼容处理。
 *
 * Dola 会把提示词中的“30秒”“0-5秒”等中文时长标记误判为普通对话，
 * 然后返回“目前支持 4 到 15 秒”的说明，即使创作栏已经选中 30s。
 * 仅在发送给 Dola 的副本中把数字时长改成 ASCII `s`；任务原文和历史记录
 * 保持不变，其他平台/时长也不经过此处理。
 */
export function sanitizeDolaThirtySecondPrompt(value: string): string {
  return value.replace(/(\d+(?:\s*[-~～–—到至]\s*\d+)?)\s*秒/g, '$1s');
}

export const VIDEO_DIRECT_GENERATION_SUFFIX = '【不要提问我任何问题，帮我按照提示词全部内容直接生成一条视频】';

/** 只修改实际发送副本；任务原文、编辑记录和历史提示词保持不变。 */
export function prepareVideoPromptForSubmission(
  value: string,
  options: { platform: AccountPlatform; duration?: string },
): string {
  let withInstruction = value.trimEnd();
  if (!withInstruction.startsWith(VIDEO_DIRECT_GENERATION_SUFFIX)) {
    withInstruction = `${VIDEO_DIRECT_GENERATION_SUFFIX}\n${withInstruction}`;
  }
  if (!withInstruction.endsWith(VIDEO_DIRECT_GENERATION_SUFFIX)) {
    withInstruction = `${withInstruction}\n${VIDEO_DIRECT_GENERATION_SUFFIX}`;
  }
  return options.platform === 'dola' && options.duration === '30s'
    ? sanitizeDolaThirtySecondPrompt(withInstruction)
    : withInstruction;
}

export interface VideoDurationSliderSnapshot {
  min: number;
  max: number;
  now?: number | null;
  valueText?: string | null;
}

export interface VideoDurationSliderTarget {
  targetValue: number;
  stepsFromHome: number;
}

/** 把页面滑杆刻度转换为实际秒数，兼容新旧豆包创作栏的三种刻度。 */
export function resolveVideoDurationSliderTarget(
  snapshot: VideoDurationSliderSnapshot,
  targetSeconds: number,
): VideoDurationSliderTarget | null {
  const { min, max } = snapshot;
  if (![min, max, targetSeconds].every(Number.isInteger) || min >= max) return null;

  const valueTextSeconds = String(snapshot.valueText || '').match(/(?:^|[^0-9])([0-9]{1,2})\s*(?:s|秒)(?:$|[^0-9])/i);
  const now = snapshot.now == null ? Number.NaN : Number(snapshot.now);
  let secondsOffset: number | null = null;
  if (valueTextSeconds && Number.isInteger(now)) {
    secondsOffset = Number(valueTextSeconds[1]) - now;
  } else if (min === 4 && max === 30) {
    secondsOffset = 0;
  } else if (min === 0 && (max === 11 || max === 26)) {
    secondsOffset = 4;
  }
  if (secondsOffset === null) return null;

  const minimumSeconds = min + secondsOffset;
  const maximumSeconds = max + secondsOffset;
  if (minimumSeconds !== 4 || (maximumSeconds !== 15 && maximumSeconds !== 30)) return null;
  if (targetSeconds < minimumSeconds || targetSeconds > maximumSeconds) return null;

  const targetValue = targetSeconds - secondsOffset;
  return {
    targetValue,
    stepsFromHome: targetValue - min,
  };
}

/**
 * 最大时长直接使用 End，避免豆包页面合并连续的方向键事件；其余刻度仍从
 * Home 开始逐格选择，保持对 4-15 秒旧滑杆的兼容。
 * sendInputEvent 使用 Electron Accelerator 键名 Right，不能传 DOM 的 ArrowRight。
 */
export function buildVideoDurationSliderKeySequence(
  snapshot: VideoDurationSliderSnapshot,
  targetSeconds: number,
): string[] {
  const target = resolveVideoDurationSliderTarget(snapshot, targetSeconds);
  if (!target) return [];
  if (target.targetValue === snapshot.max) return ['End'];
  return ['Home', ...Array.from({ length: target.stepsFromHome }, () => 'Right')];
}

/** 发送前的权威条件：编辑器内容必须与任务提示词全文等值。 */
export function isExactPromptInComposer(expected: string, actual: string): boolean {
  return normalizePromptForComposer(expected) === normalizePromptForComposer(actual);
}

/**
 * Electron 逐字符键盘只用于单行 ASCII；中文、弯引号及多行文本走整段编辑器输入，
 * 避免 keyCode 不支持时在英文台词前静默截断。
 */
export function canUseNativePerCharacterInput(prompt: string): boolean {
  return prompt.length <= 500 && /^[\x20-\x7e]*$/.test(prompt);
}

// ==================== 注入提示词 ====================

/**
 * 注入提示词到豆包输入框（多策略 + 重试 + 诊断）
 *
 * 策略A：遍历所有 textarea，找第一个可见且未 disabled 的
 * 策略B：遍历所有 contenteditable 元素
 * 策略C：输出诊断信息
 *
 * 最多重试 3 次，每次间隔 2 秒
 */
export async function injectPrompt(
  webview: WebviewHandle,
  prompt: string,
  maxRetries: number = 3
): Promise<boolean> {
  console.log(`[doubaoBridge] injectPrompt 原始提示词长度=${prompt.length}, 前30字="${prompt.substring(0, 30)}..."`);

  // 注入前先检查按钮初始状态
  const initialBtnReady = await checkSendButtonReady(webview);
  // 视频模式守护：如果当前在视频生成页面，确保不被切走
  const videoModeGuard = async () => {
    const checkCode = `
      (function() {
        try {
          // 检查 URL 或页面元素判断是否在视频模式
          var url = window.location.href;
          var inVideo = url.indexOf('video') >= 0 || url.indexOf('doubao.com/chat') >= 0;
          
          // 检查页面上是否有视频生成相关按钮/标识
          var videoBtns = document.querySelectorAll('button, [role="button"]');
          var hasVideoTab = false;
          for (var i = 0; i < videoBtns.length; i++) {
            var txt = (videoBtns[i].innerText || '').trim();
            if (txt === '视频生成' || txt.indexOf('视频生成') >= 0 && txt.length < 10) {
              hasVideoTab = true;
              break;
            }
          }
          return { inVideo: hasVideoTab };
        } catch(e) { return { inVideo: false }; }
      })()
    `;
    try {
      const r = await safeExecuteJS<{ inVideo: boolean }>(webview, checkCode, 2000, 'video_guard');
      return r.inVideo;
    } catch {
      return false;
    }
  };
  const wasVideoMode = await videoModeGuard();
  console.log(`[doubaoBridge] 注入前按钮状态: ${initialBtnReady ? '已激活' : '未激活'}`);

  // 普通对话的 contenteditable 是 React 受控节点。先用真实键盘写入，避免
  // DOM 注入只改变可见文字、却没有更新 React 提交状态，造成“按钮清空但未发送”。
  let charByCharTried = false;
  if (typeof webview.sendInputEvent === 'function' && prompt.length <= 500) {
    charByCharTried = true;
    const nativeResult = await injectCharByChar(webview, prompt);
    if (nativeResult) {
      console.log('[doubaoBridge] 优先真实键盘注入成功');
      return true;
    }
    console.warn('[doubaoBridge] 优先真实键盘注入失败，回退兼容注入');
  }

  // 如果按钮本来就激活（如视频模式有图就激活），按钮状态不能作为验证标准
  // 直接走逐字输入（模拟真实按键，React 100% 捕获）
  if (initialBtnReady && !charByCharTried) {
    console.log('[doubaoBridge] 按钮初始已激活，直接使用逐字输入确保 React 状态同步');
    const charResult = await injectCharByChar(webview, prompt);
    if (charResult) {
      console.log('[doubaoBridge] 逐字输入成功');
      return true;
    }
    console.warn('[doubaoBridge] 逐字输入失败，尝试常规注入 + DOM 验证');
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[doubaoBridge] injectPrompt 第 ${attempt}/${maxRetries} 次尝试`);

    const result = await tryInjectOnce(webview, prompt);
    if (result.ok) {
      console.log(`[doubaoBridge] injectPrompt 成功 method=${result.method} tag=${result.tag} actualLen=${result.actualLen} expectedLen=${prompt.length} preview="${result.preview || ''}"`);

      // 关键验证：检查发送按钮是否变为可用状态（React 状态同步的金标准）
      const btnReady = await checkSendButtonReady(webview);
      if (btnReady) {
        console.log('[doubaoBridge] 发送按钮已激活，注入确认成功');
        return true;
      }

      console.warn('[doubaoBridge] DOM 有文字但发送按钮仍禁用，React 未同步');

      // 如果还没试过逐字输入，直接走逐字输入兜底（比重复 execCommand 有效得多）
      if (!charByCharTried) {
        console.log('[doubaoBridge] 切换到逐字输入兜底策略...');
        charByCharTried = true;
        const charResult = await injectCharByChar(webview, prompt);
        if (charResult) {
          console.log('[doubaoBridge] 逐字输入成功，发送按钮已激活');
          return true;
        }
        console.warn('[doubaoBridge] 逐字输入也失败，继续重试...');
      }

      // 继续下一轮
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    console.warn(`[doubaoBridge] injectPrompt 第 ${attempt} 次失败:`, result.error, `actualLen=${result.actualLen}`);

    if (attempt < maxRetries) {
      console.log('[doubaoBridge] 等待 2s 后重试...');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.error('[doubaoBridge] injectPrompt 全部重试失败');
  return false;
}

/**
 * 发送前独立回读当前可见编辑器。任何截断、丢失台词或标点变化都返回 false，
 * 调用方必须在产生外部副作用前停止。
 */
export async function verifyPromptReadyForSubmission(
  webview: WebviewHandle,
  prompt: string,
): Promise<boolean> {
  const expectedNormalized = JSON.stringify(normalizePromptForComposer(prompt));
  const code = `
    (function() {
      try {
        var expected = ${expectedNormalized};
        var normalize = function(value) {
          return String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[\u200b-\u200d\ufeff]/g, '')
            .replace(/\\s+/g, ' ')
            .trim();
        };
        var editors = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');
        for (var i = 0; i < editors.length; i++) {
          var editor = editors[i];
          if (editor.offsetParent === null) continue;
          if (editor.disabled || editor.getAttribute('aria-disabled') === 'true') continue;
          var rect = editor.getBoundingClientRect();
          if (rect.width < 50 || rect.height < 20 || rect.top < 0 || rect.top > window.innerHeight) continue;
          var actual = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT'
            ? editor.value
            : (editor.innerText || editor.textContent || '');
          if (normalize(actual) === expected) return true;
        }
        return false;
      } catch(e) {
        return false;
      }
    })()
  `;
  try {
    return await safeExecuteJS<boolean>(webview, code, 5000, 'verifyPromptReadyForSubmission');
  } catch {
    return false;
  }
}

/** 逐字输入兜底（单独函数，确保 React 状态 100% 同步） */
async function injectCharByChar(webview: WebviewHandle, promptText: string): Promise<boolean> {
  // ========== 第一步：找到输入框并 focus + 清空 ==========
  const prepareCode = `
    (function() {
      try {
        var placeholderKeywords = ['描述你想要的视频', '描述你想要的图片', '描述你想要的图像', '输入消息', '请输入', '说点什么', '发消息', '输入内容'];
        var viewportH = window.innerHeight;
        var input = null;
        var inputType = null;

        // ---- placeholder 匹配（最准） ----
        var allTextareas = document.querySelectorAll('textarea');
        for (var pi = 0; pi < allTextareas.length; pi++) {
          var pta = allTextareas[pi];
          if (pta.disabled) continue;
          var pPlaceholder = pta.placeholder || '';
          var pRect = pta.getBoundingClientRect();
          if (pRect.width < 50 || pRect.height < 20) continue;
          if (pRect.top < 0 || pRect.top > viewportH) continue;
          for (var pki = 0; pki < placeholderKeywords.length; pki++) {
            if (pPlaceholder.indexOf(placeholderKeywords[pki]) >= 0) {
              input = pta;
              inputType = 'textarea';
              break;
            }
          }
          if (input) break;
        }
        if (!input) {
           var allEditables = document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');
          for (var pei = 0; pei < allEditables.length; pei++) {
            var ped = allEditables[pei];
            var pAria = ped.getAttribute ? (ped.getAttribute('aria-label') || ped.getAttribute('data-placeholder') || ped.getAttribute('placeholder') || '') : '';
            var pRect2 = ped.getBoundingClientRect();
            if (pRect2.width < 50 || pRect2.height < 20) continue;
            if (pRect2.top < 0 || pRect2.top > viewportH) continue;
            var innerText = (ped.textContent || '').trim();
            var hasPlaceholderText = false;
            for (var pki2 = 0; pki2 < placeholderKeywords.length; pki2++) {
              if (pAria.indexOf(placeholderKeywords[pki2]) >= 0 || (innerText.length < 30 && innerText.indexOf(placeholderKeywords[pki2]) >= 0)) {
                hasPlaceholderText = true;
                break;
              }
            }
            if (hasPlaceholderText) {
              input = ped;
              inputType = 'contenteditable';
              break;
            }
          }
        }

        // ---- 面积打分兜底 ----
        if (!input) {
          var candidates = [];
          for (var ti = 0; ti < allTextareas.length; ti++) {
            var ta = allTextareas[ti];
            if (ta.disabled) continue;
            var rect = ta.getBoundingClientRect();
            if (rect.width < 30 || rect.height < 20) continue;
            if (rect.top < 0 || rect.left < 0) continue;
            var area = rect.width * rect.height;
            var bottomScore = rect.top > viewportH * 0.4 ? 1 : 0;
            candidates.push({ el: ta, type: 'textarea', score: area + bottomScore * 100000 });
          }
           var editables2 = document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');
          for (var ei = 0; ei < editables2.length; ei++) {
            var ed = editables2[ei];
            if (ed.offsetParent === null) continue;
            var rect2 = ed.getBoundingClientRect();
            if (rect2.width < 30 || rect2.height < 20) continue;
            if (rect2.top < 0 || rect2.left < 0 || rect2.top > viewportH) continue;
            var area2 = rect2.width * rect2.height;
            if (area2 < 2000 && rect2.height < 40) continue;
            var bottomScore2 = rect2.top > viewportH * 0.4 ? 1 : 0;
            candidates.push({ el: ed, type: 'contenteditable', score: area2 + bottomScore2 * 100000 });
          }
          if (candidates.length > 0) {
            candidates.sort(function(a, b) { return b.score - a.score; });
            input = candidates[0].el;
            inputType = candidates[0].type;
          }
        }

        if (!input) return { ok: false, error: '未找到输入框' };

        // focus + 滚动到可视区域
        input.focus();
        if (typeof input.scrollIntoView === 'function') {
          input.scrollIntoView({ block: 'center', inline: 'center' });
        }

        // 清空内容
        if (inputType === 'textarea') {
          input.value = '';
        } else {
          input.innerHTML = '<br>';
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        return { ok: true, inputType: inputType, tag: input.tagName };
      } catch(e) {
        return { ok: false, error: e.message };
      }
    })()
  `;

  const prepareResult = await safeExecuteJS<{ ok: boolean; inputType?: string; tag?: string; error?: string }>(
    webview, prepareCode, 8000, 'prepareInputForChar'
  );

  if (!prepareResult.ok) {
    console.warn('[doubaoBridge] injectCharByChar 准备输入框失败:', prepareResult.error);
    return false;
  }
  console.log(`[doubaoBridge] 输入框已就绪: type=${prepareResult.inputType}, tag=${prepareResult.tag}`);

  // ========== 第二步：优先使用真实键盘事件（sendInputEvent）==========
  // 短文本用真实键盘更可靠，长文本直接走 JS 批量注入更快（避免数千事件卡死页面）
  const wv = webview as any;
  const useRealKeyboard = typeof wv.sendInputEvent === 'function' && canUseNativePerCharacterInput(promptText);
  if (useRealKeyboard) {
    try {
      console.log('[doubaoBridge] 使用真实键盘事件输入 (sendInputEvent)');
      // 裸 Enter 在豆包 composer 中等价于“发送”。输入阶段必须把换行规范为
      // 空格，绝不能用 Enter/回车模拟多行文本，否则会把一条提示词拆成多次提交。
      const nativePromptText = promptText.replace(/\r\n?|\n/g, ' ');
      const chars = nativePromptText.split('');
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === '\b') {
          wv.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
          wv.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
        } else {
          wv.sendInputEvent({ type: 'keyDown', keyCode: ch, key: ch });
          wv.sendInputEvent({ type: 'char', keyCode: ch, key: ch });
          wv.sendInputEvent({ type: 'keyUp', keyCode: ch, key: ch });
        }
        // 每50个字符稍作停顿
        if (i > 0 && i % 50 === 0) {
          await sleep(15);
        }
      }
      // 等待 React 状态完全同步
      await sleep(300);

      // 验证：读取 DOM 内容长度
      const expectedNormalized = JSON.stringify(normalizePromptForComposer(nativePromptText));
      const verifyCode = `
        (function() {
          try {
            var inputType = '${prepareResult.inputType}';
            var expectedLen = ${nativePromptText.length};
            var expectedNormalized = ${expectedNormalized};
            var normalize = function(value) {
              return String(value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/[\u200b-\u200d\ufeff]/g, '')
                .replace(/\\s+/g, ' ')
                .trim();
            };
            var input = null;

            var placeholderKeywords = ['描述你想要的视频', '描述你想要的图片', '描述你想要的图像', '输入消息', '请输入', '说点什么', '发消息', '输入内容'];
             var allEls = inputType === 'textarea'
              ? document.querySelectorAll('textarea')
              : document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');

            for (var i = 0; i < allEls.length; i++) {
              var el = allEls[i];
              if (inputType === 'textarea' && el.disabled) continue;
              if (inputType !== 'textarea' && el.offsetParent === null) continue;
              var ph = inputType === 'textarea'
                ? el.placeholder || ''
                : (el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '');
              var rect = el.getBoundingClientRect();
              if (rect.width < 50 || rect.height < 20) continue;
              for (var k = 0; k < placeholderKeywords.length; k++) {
                if (ph.indexOf(placeholderKeywords[k]) >= 0) {
                  input = el;
                  break;
                }
              }
              if (input) break;
            }

            // 兜底：innerText 最长的那个
            if (!input) {
              var maxLen = 0;
              for (var j = 0; j < allEls.length; j++) {
                var el2 = allEls[j];
                if (inputType !== 'textarea' && el2.offsetParent === null) continue;
                var len = inputType === 'textarea' ? el2.value.length : (el2.textContent || '').length;
                if (len > maxLen) { maxLen = len; input = el2; }
              }
            }

            if (!input) return { ok: false, error: '验证时找不到输入框' };

            var actualText = inputType === 'textarea' ? input.value : (input.innerText || '');
            var actualLen = actualText.length;

            // 检查 Fiber 节点是否存在（确认 React 接管）
            var hasFiber = false;
            try {
              var targetEl = input;
              for (var d = 0; d < 15 && targetEl; d++) {
                var keys = Object.keys(targetEl);
                for (var ki = 0; ki < keys.length; ki++) {
                  if (keys[ki].startsWith('__reactFiber') || keys[ki].startsWith('__reactProps')) {
                    hasFiber = true;
                    break;
                  }
                }
                if (hasFiber) break;
                targetEl = targetEl.parentElement;
              }
            } catch(e) {}

            return {
              ok: normalize(actualText) === expectedNormalized,
              actualLen: actualLen,
              expectedLen: expectedLen,
              hasFiber: hasFiber,
              preview: actualText.substring(0, 60)
            };
          } catch(e) {
            return { ok: false, error: e.message };
          }
        })()
      `;

      const verifyResult = await safeExecuteJS<{
        ok: boolean; actualLen: number; expectedLen: number; hasFiber: boolean; preview?: string; error?: string;
      }>(webview, verifyCode, 2000, 'verifyRealKeyboardInput');

      if (verifyResult.ok) {
        console.log(`[doubaoBridge] 真实键盘输入成功, len=${verifyResult.actualLen}/${verifyResult.expectedLen}, hasFiber=${verifyResult.hasFiber}, preview="${verifyResult.preview}..."`);
        return true;
      }
      console.warn(`[doubaoBridge] 真实键盘输入验证失败: actualLen=${verifyResult.actualLen}, expected=${promptText.length}, error=${verifyResult.error || '内容长度不足'}`);
      // 失败回退到 JS 模拟模式
    } catch (e: unknown) {
      console.warn('[doubaoBridge] sendInputEvent 模式异常，回退到JS模拟:', getErrorMessage(e));
    }
  }

  // ========== 第三步：回退 - JS 模拟逐字输入 + React Fiber 强制同步 ==========
  console.log('[doubaoBridge] 使用 JS 模拟逐字输入');
  const safePrompt = JSON.stringify(promptText);
  const fallbackExpectedNormalized = JSON.stringify(normalizePromptForComposer(promptText));
  const fallbackContentEditableHtml = JSON.stringify(buildContentEditablePromptHtml(promptText));
  const fallbackCode = `
    (function() {
      try {
        var targetPrompt = ${safePrompt};
        var expectedNormalized = ${fallbackExpectedNormalized};
        var contentEditableHtml = ${fallbackContentEditableHtml};
        var normalize = function(value) {
          return String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[\u200b-\u200d\ufeff]/g, '')
            .replace(/\\s+/g, ' ')
            .trim();
        };
        var placeholderKeywords = ['描述你想要的视频', '描述你想要的图片', '描述你想要的图像', '输入消息', '请输入', '说点什么', '发消息', '输入内容'];
        var viewportH = window.innerHeight;
        var input = null;
        var inputType = null;

        var allTextareas = document.querySelectorAll('textarea');
        // placeholder 匹配
        for (var pi = 0; pi < allTextareas.length; pi++) {
          var pta = allTextareas[pi];
          if (pta.disabled) continue;
          var pPlaceholder = pta.placeholder || '';
          var pRect = pta.getBoundingClientRect();
          if (pRect.width < 50 || pRect.height < 20) continue;
          if (pRect.top < 0 || pRect.top > viewportH) continue;
          for (var pki = 0; pki < placeholderKeywords.length; pki++) {
            if (pPlaceholder.indexOf(placeholderKeywords[pki]) >= 0) {
              input = pta;
              inputType = 'textarea';
              break;
            }
          }
          if (input) break;
        }
        if (!input) {
           var allEditables = document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');
          for (var pei = 0; pei < allEditables.length; pei++) {
            var ped = allEditables[pei];
            var pAria = ped.getAttribute ? (ped.getAttribute('aria-label') || ped.getAttribute('data-placeholder') || ped.getAttribute('placeholder') || '') : '';
            var pRect2 = ped.getBoundingClientRect();
            if (pRect2.width < 50 || pRect2.height < 20) continue;
            if (pRect2.top < 0 || pRect2.top > viewportH) continue;
            var innerText = (ped.textContent || '').trim();
            for (var pki2 = 0; pki2 < placeholderKeywords.length; pki2++) {
              if (pAria.indexOf(placeholderKeywords[pki2]) >= 0 || (innerText.length < 30 && innerText.indexOf(placeholderKeywords[pki2]) >= 0)) {
                input = ped;
                inputType = 'contenteditable';
                break;
              }
            }
          }
        }

        // 面积打分兜底
        if (!input) {
          var candidates = [];
          for (var ti = 0; ti < allTextareas.length; ti++) {
            var ta = allTextareas[ti];
            if (ta.disabled) continue;
            var rect = ta.getBoundingClientRect();
            if (rect.width < 30 || rect.height < 20) continue;
            if (rect.top < 0 || rect.left < 0) continue;
            var area = rect.width * rect.height;
            var bottomScore = rect.top > viewportH * 0.4 ? 1 : 0;
            candidates.push({ el: ta, type: 'textarea', score: area + bottomScore * 100000 });
          }
           var editables2 = document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');
          for (var ei = 0; ei < editables2.length; ei++) {
            var ed = editables2[ei];
            if (ed.offsetParent === null) continue;
            var rect2 = ed.getBoundingClientRect();
            if (rect2.width < 30 || rect2.height < 20) continue;
            if (rect2.top < 0 || rect2.left < 0 || rect2.top > viewportH) continue;
            var area2 = rect2.width * rect2.height;
            if (area2 < 2000 && rect2.height < 40) continue;
            var bottomScore2 = rect2.top > viewportH * 0.4 ? 1 : 0;
            candidates.push({ el: ed, type: 'contenteditable', score: area2 + bottomScore2 * 100000 });
          }
          if (candidates.length > 0) {
            candidates.sort(function(a, b) { return b.score - a.score; });
            input = candidates[0].el;
            inputType = candidates[0].type;
          }
        }

        if (!input) return { ok: false, error: '未找到输入框' };
        input.focus();

        // 清空
        if (inputType === 'textarea') {
          var ns = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (ns) ns.call(input, '');
          else input.value = '';
        } else {
          input.innerHTML = '<br>';
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));

        // ===== 注入辅助函数 =====
        function setInputContent(text) {
          if (inputType === 'textarea') {
            var ns2 = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (ns2) ns2.call(input, text);
            else input.value = text;
          } else {
            // Tiptap/ProseMirror 依靠段落节点表达换行。完整提示词必须写入
            // 结构化 HTML；批量兜底的中间态可以先保持纯文本，最后一批再恢复结构。
            if (text === targetPrompt) input.innerHTML = contentEditableHtml;
            else input.textContent = text;
            // 移动光标到末尾
            var range = document.createRange();
            range.selectNodeContents(input);
            range.collapse(false);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
        }

        // ===== 方案A：一次性全量注入 + React 状态同步（最快，优先尝试） =====
        setInputContent(targetPrompt);

        try {
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: targetPrompt }));
        } catch(e) {
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // 多层级 ReactFiber 同步（从 input 向上找到 onInput/onChange）
        (function syncReactFiberOneShot() {
          try {
            // 方式1: __reactProps 路径
            var fiberKey = null;
            var targetEl = input;
            var depth = 0;
            while (targetEl && depth < 15) {
              var keys = Object.keys(targetEl);
              for (var ki = 0; ki < keys.length; ki++) {
                if (keys[ki].startsWith('__reactProps')) {
                  fiberKey = keys[ki];
                  break;
                }
              }
              if (fiberKey) break;
              targetEl = targetEl.parentElement;
              depth++;
            }
            if (fiberKey) {
              var rprops = targetEl[fiberKey];
              var targetVal = inputType === 'textarea' ? input.value : (input.innerText || '');
              var fakeTarget = { value: targetVal, innerText: targetVal, textContent: targetVal };
              var fakeEvent = {
                target: fakeTarget, currentTarget: fakeTarget,
                bubbles: true, cancelable: true, defaultPrevented: false,
                preventDefault: function() { this.defaultPrevented = true; },
                stopPropagation: function() {}, persist: function() {},
                isTrusted: true, type: 'input', inputType: 'insertText', data: targetVal,
                nativeEvent: { data: targetVal, inputType: 'insertText' }
              };
              if (typeof rprops.onInput === 'function') rprops.onInput(fakeEvent);
              else if (typeof rprops.onChange === 'function') rprops.onChange(fakeEvent);
            }

            // 方式2: __reactFiber 路径（向上遍历 memoizedProps）
            var fiberKey2 = null;
            var targetEl2 = input;
            var depth2 = 0;
            while (targetEl2 && depth2 < 15) {
              var keys2 = Object.keys(targetEl2);
              for (var ki2 = 0; ki2 < keys2.length; ki2++) {
                if (keys2[ki2].startsWith('__reactFiber')) {
                  fiberKey2 = keys2[ki2];
                  break;
                }
              }
              if (fiberKey2) break;
              targetEl2 = targetEl2.parentElement;
              depth2++;
            }
            if (fiberKey2) {
              var fiber = targetEl2[fiberKey2];
              var current = fiber;
              var fdepth = 0;
              var targetVal2 = inputType === 'textarea' ? input.value : (input.innerText || '');
              var fakeTarget2 = { value: targetVal2, innerText: targetVal2, textContent: targetVal2 };
              var fakeEvent2 = {
                target: fakeTarget2, currentTarget: fakeTarget2,
                bubbles: true, cancelable: true, defaultPrevented: false,
                preventDefault: function() { this.defaultPrevented = true; },
                stopPropagation: function() {}, persist: function() {},
                isTrusted: true, type: 'input', inputType: 'insertText', data: targetVal2,
                nativeEvent: { data: targetVal2, inputType: 'insertText' }
              };
              while (current && fdepth < 30) {
                var fprops = current.memoizedProps || current.pendingProps;
                if (fprops) {
                  if (typeof fprops.onInput === 'function') {
                    try { fprops.onInput(fakeEvent2); break; } catch(e) {}
                  }
                  if (typeof fprops.onChange === 'function') {
                    try { fprops.onChange(fakeEvent2); break; } catch(e) {}
                  }
                }
                current = current.return;
                fdepth++;
              }
            }
          } catch(e) {}
        })();

        // 验证一次性注入是否成功
        var actualLenA = inputType === 'textarea' ? input.value.length : (input.innerText || '').length;
        var oneShotOk = actualLenA >= targetPrompt.length * 0.8;

        // ===== 方案B：大批量注入兜底（每200字一批，约24批/4800字） =====
        if (!oneShotOk) {
          var BATCH_SIZE = 200;
          var totalLen = targetPrompt.length;
          var batches = Math.ceil(totalLen / BATCH_SIZE);

          for (var bi = 0; bi < batches; bi++) {
            var endIdx = Math.min((bi + 1) * BATCH_SIZE, totalLen);
            var batchText = targetPrompt.substring(0, endIdx);

            setInputContent(batchText);

            try {
              input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: batchText }));
            } catch(e) {
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // 快速同步
            try {
              var fk = null;
              var te = input;
              var d = 0;
              while (te && d < 10) {
                var ks = Object.keys(te);
                for (var k = 0; k < ks.length; k++) {
                  if (ks[k].startsWith('__reactProps')) { fk = ks[k]; break; }
                }
                if (fk) break;
                te = te.parentElement;
                d++;
              }
              if (fk) {
                var rp = te[fk];
                var tv = inputType === 'textarea' ? input.value : (input.innerText || '');
                var ft = { value: tv, innerText: tv, textContent: tv };
                var fe = {
                  target: ft, currentTarget: ft,
                  bubbles: true, cancelable: true,
                  preventDefault: function() {}, stopPropagation: function() {},
                  isTrusted: true, type: 'input', inputType: 'insertText', data: tv,
                  nativeEvent: { data: tv, inputType: 'insertText' }
                };
                if (typeof rp.onInput === 'function') rp.onInput(fe);
                else if (typeof rp.onChange === 'function') rp.onChange(fe);
              }
            } catch(e) {}
          }
        }

        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: targetPrompt }));

        // ========== React Fiber 强制同步（增强版：向上遍历父元素）==========
        (function syncReactFiber() {
          try {
            var fiberKey = null;
            var targetEl = input;
            var searchDepth = 0;
            while (targetEl && searchDepth < 15) {
              var keys = Object.keys(targetEl);
              for (var ki = 0; ki < keys.length; ki++) {
                if (keys[ki].startsWith('__reactFiber') || keys[ki].startsWith('__reactProps')) {
                  fiberKey = keys[ki];
                  break;
                }
              }
              if (fiberKey) break;
              targetEl = targetEl.parentElement;
              searchDepth++;
            }
            if (!fiberKey) return false;

            var targetValue = inputType === 'textarea' ? input.value : (input.innerText || '');
            var fakeTarget = { value: targetValue, innerText: targetValue, textContent: targetValue };
            var fakeEvent = {
              target: fakeTarget, currentTarget: fakeTarget,
              bubbles: true, cancelable: true, defaultPrevented: false,
              preventDefault: function() { this.defaultPrevented = true; },
              stopPropagation: function() {}, persist: function() {},
              isTrusted: true, type: 'input', inputType: 'insertText', data: targetValue,
              nativeEvent: { data: targetValue, inputType: 'insertText' }
            };

            if (fiberKey.startsWith('__reactProps')) {
              var rprops = targetEl[fiberKey];
              if (rprops && typeof rprops.onInput === 'function') {
                rprops.onInput(fakeEvent);
                console.log('[reactSync] __reactProps.onInput 同步成功');
                return true;
              }
              if (rprops && typeof rprops.onChange === 'function') {
                rprops.onChange(fakeEvent);
                console.log('[reactSync] __reactProps.onChange 同步成功');
                return true;
              }
              return false;
            }

            var fiber = targetEl[fiberKey];
            var current = fiber;
            var depth = 0;
            while (current && depth < 30) {
              var fprops = current.memoizedProps || current.pendingProps;
              if (fprops) {
                if (typeof fprops.onInput === 'function') {
                  try { fprops.onInput(fakeEvent); console.log('[reactSync] fiber.onInput 同步成功 depth=' + depth); return true; } catch(e) {}
                }
                if (typeof fprops.onChange === 'function') {
                  try { fprops.onChange(fakeEvent); console.log('[reactSync] fiber.onChange 同步成功 depth=' + depth); return true; } catch(e) {}
                }
              }
              current = current.return;
              depth++;
            }
            return false;
          } catch(e) { return false; }
        })();

        var actualText = inputType === 'textarea' ? input.value : input.innerText;
        var actualLen = actualText.length;
        var ok = normalize(actualText) === expectedNormalized;
        return { ok: ok, actualLen: actualLen, method: 'char-by-char-js' };
      } catch(e) {
        return { ok: false, error: e.message };
      }
    })()
  `;

  try {
    const result = await safeExecuteJS<{ ok: boolean; actualLen: number; method: string }>(
      webview, fallbackCode, 15000, 'injectCharByCharFallback'
    );
    if (result.ok) {
      console.log(`[doubaoBridge] JS模拟逐字输入成功, len=${result.actualLen}, method=${result.method}`);
      return true;
    }
    console.warn('[doubaoBridge] JS模拟逐字输入失败, actualLen=' + result.actualLen);
    return false;
  } catch (e: any) {
    console.warn('[doubaoBridge] injectCharByChar 异常:', e.message);
    return false;
  }
}


export interface SendButtonTarget {
  ok: boolean;
  position?: string;
  method?: string;
}

/**
 * 注入前检查与最终点击共用同一定位器，避免“检查放行、点击找不到”的矛盾。
 * 除旧版权威 ID 外，只接受当前可见编辑器所属 composer 内，具备发送语义或
 * 明确主色背景的右侧方形控件；语音、更多、下拉菜单均被排除。
 */
export async function findSendButtonTarget(webview: WebviewHandle): Promise<SendButtonTarget> {
  const code = `
    (function() {
      try {
        var visible = function(el) {
          if (!el || el.offsetParent === null) return false;
          var style = window.getComputedStyle(el);
          var rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' &&
            style.pointerEvents !== 'none' && parseFloat(style.opacity || '1') >= 0.5 &&
            rect.width > 0 && rect.height > 0;
        };
        var enabled = function(el) {
          return visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
            el.getAttribute('data-disabled') !== 'true';
        };
        var finish = function(button, method) {
          if (!enabled(button)) return { ok: false };
          var rect = button.getBoundingClientRect();
          return { ok: true, method: method,
            position: Math.round(rect.left + rect.width / 2) + ',' + Math.round(rect.top + rect.height / 2) };
        };

        var exact = document.querySelector('#flow-end-msg-send');
        if (enabled(exact)) return finish(exact, 'exact-id');

        var editors = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');
        var editor = null;
        for (var i = 0; i < editors.length; i++) {
          if (visible(editors[i])) { editor = editors[i]; break; }
        }
        if (!editor) return { ok: false };
        var editorRect = editor.getBoundingClientRect();
        var root = editor.parentElement;
        for (var depth = 0; depth < 12 && root; depth++, root = root.parentElement) {
          var controls = root.querySelectorAll('button, [role="button"], [data-testid], [aria-label], [title]');
          var matches = [];
          for (var j = 0; j < controls.length; j++) {
            var control = controls[j];
            if (!enabled(control)) continue;
            if (control.getAttribute('aria-haspopup')) continue;
            var descriptor = [control.id, control.getAttribute('aria-label'), control.getAttribute('title'),
              control.getAttribute('data-testid'), control.getAttribute('data-action'), control.innerText]
              .filter(Boolean).join(' ').toLowerCase();
            if (/麦克风|语音|voice|microphone|audio|更多|more/.test(descriptor)) continue;
            var rect = control.getBoundingClientRect();
            var nearRight = rect.left >= editorRect.right - 180 && rect.left <= editorRect.right + 120;
            var nearVertical = rect.top <= editorRect.bottom + 80 && rect.bottom >= editorRect.top - 40;
            var square = rect.width >= 24 && rect.width <= 64 && rect.height >= 24 && rect.height <= 64;
            var semantic = /发送|提交|生成|send|submit|generate/.test(descriptor);
            var rgb = (window.getComputedStyle(control).backgroundColor || '').match(/\\d+/g);
            var accent = !!(rgb && rgb.length >= 3 && Number(rgb[2]) > Number(rgb[0]) && Number(rgb[2]) > Number(rgb[1]) && Number(rgb[2]) > 120);
            if (nearRight && nearVertical && square && (semantic || accent)) {
              matches.push({ el: control, semantic: semantic, accent: accent });
            }
          }
          if (matches.length === 1) return finish(matches[0].el, matches[0].semantic ? 'composer-semantic' : 'composer-accent');
        }
        return { ok: false };
      } catch(e) {
        return { ok: false };
      }
    })();
  `;
  try {
    return await safeExecuteJS<SendButtonTarget>(webview, code, 5000, 'findSendButtonTarget');
  } catch {
    return { ok: false };
  }
}

/** 提交前要求发送控件可用且页面上传状态连续三次稳定，禁止固定 sleep 猜测。 */
export async function waitForSubmissionControlsStable(
  webview: WebviewHandle,
  timeoutMs: number = 20000,
  options: { signal?: AbortSignal; onProgress?: (pending: boolean, sendReady: boolean) => void | Promise<void> } = {},
): Promise<boolean> {
  const startedAt = Date.now();
  let stable = 0;
  while (Date.now() - startedAt < timeoutMs) {
    if (options.signal?.aborted) return false;
    const target = await findSendButtonTarget(webview);
    let uploadPending = true;
    try {
      uploadPending = await safeExecuteJS<boolean>(
        webview,
        buildUploadPendingProbe(buildComposerRootProbe()),
        5000,
        'submissionUploadPending',
      );
    } catch {
      uploadPending = true;
    }
    if (options.signal?.aborted) return false;
    stable = target.ok && !uploadPending ? stable + 1 : 0;
    if (stable >= 3) return true;
    await options.onProgress?.(uploadPending, target.ok);
    await sleep(400);
  }
  return false;
}

async function checkSendButtonReady(webview: WebviewHandle): Promise<boolean> {
  return (await findSendButtonTarget(webview)).ok;
}

/** 单次注入尝试 */
async function tryInjectOnce(
  webview: WebviewHandle,
  prompt: string
): Promise<{ ok: boolean; error?: string; method?: string; tag?: string; actualLen?: number; preview?: string }> {
  // 安全的 JSON 序列化（处理特殊字符）
  const safePrompt = JSON.stringify(prompt);
  const expectedNormalized = JSON.stringify(normalizePromptForComposer(prompt));
  const safeContentEditableHtml = JSON.stringify(buildContentEditablePromptHtml(prompt));

  const code = `
    (function() {
      try {
        var viewportH = window.innerHeight;
        var viewportW = window.innerWidth;

        // ========== 找到最佳输入元素（placeholder匹配优先 > 发送按钮反向 > 面积打分兜底） ==========
        var candidates = [];
        var foundByButton = null;
        var foundByPlaceholder = null;

        // ---- 策略0：通过 placeholder/提示文本直接定位输入框（最准，视频页面专用） ----
        var placeholderKeywords = ['描述你想要的视频', '描述你想要的图片', '描述你想要的图像', '输入消息', '请输入', '说点什么', '发消息', '输入内容'];
        var allTextareas = document.querySelectorAll('textarea');
        for (var pi = 0; pi < allTextareas.length; pi++) {
          var pta = allTextareas[pi];
          if (pta.disabled) continue;
          var pPlaceholder = pta.getAttribute ? (pta.getAttribute('placeholder') || '') : '';
          var pRect = pta.getBoundingClientRect();
          if (pRect.width < 50 || pRect.height < 20) continue;
          if (pRect.top < 0 || pRect.top > viewportH) continue;
          for (var pki = 0; pki < placeholderKeywords.length; pki++) {
            if (pPlaceholder.indexOf(placeholderKeywords[pki]) >= 0) {
              foundByPlaceholder = { el: pta, type: 'textarea', placeholder: pPlaceholder };
              break;
            }
          }
          if (foundByPlaceholder) break;
        }
        // 也检查 contenteditable 的 placeholder（aria-label / data-placeholder）
        if (!foundByPlaceholder) {
         var allEditables = document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');
          for (var pei = 0; pei < allEditables.length; pei++) {
            var ped = allEditables[pei];
            var pAria = ped.getAttribute ? (ped.getAttribute('aria-label') || ped.getAttribute('data-placeholder') || ped.getAttribute('placeholder') || '') : '';
            var pRect2 = ped.getBoundingClientRect();
            if (pRect2.width < 50 || pRect2.height < 20) continue;
            if (pRect2.top < 0 || pRect2.top > viewportH) continue;
            for (var pki2 = 0; pki2 < placeholderKeywords.length; pki2++) {
              if (pAria.indexOf(placeholderKeywords[pki2]) >= 0) {
                foundByPlaceholder = { el: ped, type: 'contenteditable', placeholder: pAria };
                break;
              }
            }
            if (foundByPlaceholder) break;
          }
        }
        // 再兜底：contenteditable 内部的空提示文本
        if (!foundByPlaceholder) {
           var allEditables2 = document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');
          for (var pe2 = 0; pe2 < allEditables2.length; pe2++) {
            var ped2 = allEditables2[pe2];
            var pRect3 = ped2.getBoundingClientRect();
            if (pRect3.width < 100 || pRect3.height < 30) continue;
            if (pRect3.top < 0 || pRect3.top > viewportH) continue;
            // 检查内部是否有提示文本元素
            var innerText = (ped2.textContent || '').trim();
            if (innerText.length > 20) continue;
            for (var pki3 = 0; pki3 < placeholderKeywords.length; pki3++) {
              if (innerText.indexOf(placeholderKeywords[pki3]) >= 0) {
                foundByPlaceholder = { el: ped2, type: 'contenteditable', placeholder: innerText };
                break;
              }
            }
            if (foundByPlaceholder) break;
          }
        }

        if (foundByPlaceholder) {
          console.log('[doubaoBridge] 通过placeholder定位输入框 type=' + foundByPlaceholder.type + ' placeholder=' + foundByPlaceholder.placeholder);
          candidates.push({ el: foundByPlaceholder.el, type: foundByPlaceholder.type, score: Infinity, area: 999999 });
        }

        // ---- 策略A：通过发送/生成按钮反向查找输入框 ----
        var buttonKeywords = ['发送', 'send', 'Send', 'SEND', '发送消息', '提交'];
        var excludeTexts = ['视频生成', '图像生成', '图片生成', '模型', 'Seedance', '时长', '比例', '尺寸', '风格'];
        var allButtons = document.querySelectorAll('button, [role="button"], div[class*="btn"], div[class*="button"], span[class*="btn"]');
        var buttonCandidates = [];
        
        for (var bi = 0; bi < allButtons.length; bi++) {
          var btn = allButtons[bi];
          var btnRect = btn.getBoundingClientRect();
          // 按钮必须在视口内且有一定大小
          if (btnRect.width < 20 || btnRect.height < 20) continue;
          if (btnRect.top < 0 || btnRect.top > viewportH) continue;
          if (btn.disabled) continue;
          
          var btnText = (btn.textContent || '').trim();
          var btnAriaLabel = btn.getAttribute ? (btn.getAttribute('aria-label') || '') : '';
          var btnTitle = btn.getAttribute ? (btn.getAttribute('title') || '') : '';
          var combinedText = btnText + ' ' + btnAriaLabel + ' ' + btnTitle;
          
          // 排除明显是 Tab / 模式切换 / 选项的按钮
          var isExcluded = false;
          for (var ei = 0; ei < excludeTexts.length; ei++) {
            if (btnText.indexOf(excludeTexts[ei]) >= 0 && btnText.length < 15) {
              isExcluded = true;
              break;
            }
          }
          if (isExcluded) continue;
          
          var btnScore = 0;
          
          // 关键词匹配加分
          for (var ki = 0; ki < buttonKeywords.length; ki++) {
            if (combinedText.indexOf(buttonKeywords[ki]) >= 0) {
              btnScore += 1000;
              break;
            }
          }
          
          // 含 SVG 图标（发送按钮通常是图标按钮）
          var svgEl = btn.querySelector('svg');
          if (svgEl) {
            btnScore += 200;
            var svgHtml = svgEl.outerHTML || '';
            if (svgHtml.indexOf('arrow') >= 0 || svgHtml.indexOf('Arrow') >= 0 || 
                svgHtml.indexOf('send') >= 0 || svgHtml.indexOf('Send') >= 0 ||
                svgHtml.indexOf('paper-plane') >= 0 || svgHtml.indexOf('plane') >= 0) {
              btnScore += 500; // 箭头/飞机图标 = 发送按钮
            }
          }
          
          // 位置：越靠下越可能是发送按钮
          if (btnRect.top > viewportH * 0.6) btnScore += 300;
          if (btnRect.top > viewportH * 0.8) btnScore += 200;
          
          // 位置：越靠右越可能是发送按钮
          if (btnRect.left > viewportW * 0.6) btnScore += 200;
          if (btnRect.left > viewportW * 0.8) btnScore += 200;
          
          // 圆形按钮（宽高接近且不大）
          var ratio = btnRect.width / btnRect.height;
          if (ratio > 0.7 && ratio < 1.4 && btnRect.width < 80) {
            btnScore += 200;
          }
          
          if (btnScore > 0) {
            buttonCandidates.push({ btn: btn, score: btnScore, text: btnText || btnAriaLabel });
          }
        }

        // 按分数排序，取最高分的按钮
        buttonCandidates.sort(function(a, b) { return b.score - a.score; });
        
        if (buttonCandidates.length > 0) {
          var topBtn = buttonCandidates[0];
          // 从按钮往上找包含输入框的父容器
          var parent = topBtn.btn.parentElement;
          for (var depth = 0; depth < 10 && parent; depth++) {
            var textareasInContainer = parent.querySelectorAll('textarea');
         var editablesInContainer = parent.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');
            
            var foundEl = null;
            var foundType = null;
            
            // 优先找 textarea
            for (var ti = 0; ti < textareasInContainer.length; ti++) {
              var ta = textareasInContainer[ti];
              if (ta.disabled) continue;
              var taRect = ta.getBoundingClientRect();
              if (taRect.width > 100 && taRect.height > 20) {
                foundEl = ta;
                foundType = 'textarea';
                break;
              }
            }
            
            // 再找 contenteditable
            if (!foundEl) {
              for (var ei = 0; ei < editablesInContainer.length; ei++) {
                var ed = editablesInContainer[ei];
                var edRect = ed.getBoundingClientRect();
                if (edRect.width > 100 && edRect.height > 20) {
                  foundEl = ed;
                  foundType = 'contenteditable';
                  break;
                }
              }
            }
            
            if (foundEl) {
              foundByButton = { el: foundEl, type: foundType, btnText: topBtn.text, btnScore: topBtn.score };
              break;
            }
            
            parent = parent.parentElement;
          }
        }

        if (foundByButton) {
          console.log('[doubaoBridge] 通过发送按钮定位输入框 type=' + foundByButton.type + ' 按钮文本=' + foundByButton.btnText + ' 按钮分数=' + foundByButton.btnScore + ' 候选按钮数=' + buttonCandidates.length);
          candidates.push({ el: foundByButton.el, type: foundByButton.type, score: Infinity, area: 999999 });
        } else {
          // 诊断：输出前5个高分按钮
          var topBtnsDiag = buttonCandidates.slice(0, 5).map(function(b) {
            return b.text + '(' + b.score + ')';
          }).join('; ');
          console.log('[doubaoBridge] 发送按钮定位失败，候选前5: ' + topBtnsDiag + ' 总数=' + buttonCandidates.length);
        }

        // ---- 策略B：面积打分（兜底） ----
        if (candidates.length === 0) {
          // 收集所有 textarea
          var textareas = document.querySelectorAll('textarea');
          for (var i = 0; i < textareas.length; i++) {
            var ta = textareas[i];
            if (ta.disabled) continue;
            var rect = ta.getBoundingClientRect();
            if (rect.width < 30 || rect.height < 20) continue;
            if (rect.top < 0 || rect.left < 0) continue;
            var area = rect.width * rect.height;
            var bottomScore = rect.top > viewportH * 0.4 ? 1 : 0;
            var widthScore = rect.width > viewportW * 0.5 ? 1 : 0;
            var score = area + bottomScore * 100000 + widthScore * 50000;
            candidates.push({ el: ta, type: 'textarea', rect: rect, score: score, area: area });
          }

          // 收集所有 contenteditable 元素
           var editables = document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');
          for (var j = 0; j < editables.length; j++) {
            var ed = editables[j];
            var rect2 = ed.getBoundingClientRect();
            if (rect2.width < 30 || rect2.height < 20) continue;
            if (rect2.top < 0 || rect2.left < 0) continue;
            if (rect2.top > viewportH) continue;
            var area2 = rect2.width * rect2.height;
            var bottomScore2 = rect2.top > viewportH * 0.4 ? 1 : 0;
            var widthScore2 = rect2.width > viewportW * 0.5 ? 1 : 0;
            if (area2 < 2000 && rect2.height < 40) continue;
            var score2 = area2 + bottomScore2 * 100000 + widthScore2 * 50000;
            candidates.push({ el: ed, type: 'contenteditable', rect: rect2, score: score2, area: area2 });
          }
        }

        if (candidates.length === 0) {
          // 诊断
          var allInputs = document.querySelectorAll('input[type="text"], input:not([type]), textarea, [contenteditable="true"]');
          var diag = [];
          for (var k = 0; k < allInputs.length; k++) {
            var el2 = allInputs[k];
            var r2 = el2.getBoundingClientRect();
            diag.push({
              tag: el2.tagName,
              w: Math.round(r2.width),
              h: Math.round(r2.height),
              top: Math.round(r2.top),
              left: Math.round(r2.left),
              visible: el2.offsetParent !== null,
              placeholder: el2.getAttribute ? (el2.getAttribute('placeholder') || '').substring(0, 30) : ''
            });
          }
          return { ok: false, error: '未找到输入框，候选诊断: ' + JSON.stringify(diag.slice(0, 8)), actualLen: 0 };
        }

        // 按分数排序，取最高的
        candidates.sort(function(a, b) { return b.score - a.score; });
        var best = candidates[0];
        var input = best.el;
        var inputRect = input.getBoundingClientRect();

        console.log('[doubaoBridge] 找到最佳输入框 type=' + best.type + ' size=' + Math.round(inputRect.width) + 'x' + Math.round(inputRect.height) + ' pos=' + Math.round(inputRect.left) + ',' + Math.round(inputRect.top) + ' 候选数=' + candidates.length);

        // ========== 注入提示词 ==========
        var promptText = ${safePrompt};
        var expectedNormalized = ${expectedNormalized};
        var contentEditableHtml = ${safeContentEditableHtml};

        function verifyValue() {
          var val = '';
          if (best.type === 'textarea') {
            val = input.value;
          } else {
            val = input.innerText || input.textContent || '';
          }
          var normalize = function(value) {
            return String(value || '')
              .replace(/\u00a0/g, ' ')
              .replace(/[\u200b-\u200d\ufeff]/g, '')
              .replace(/\\s+/g, ' ')
              .trim();
          };
          var actualLen = val.length;
          var pass = normalize(val) === expectedNormalized;
          return { pass: pass, actual: val, ratio: pass ? 1 : 0, actualLen: actualLen, preview: val.substring(0, 50) };
        }

        // 清空输入框（移除 placeholder 等 contenteditable=false 的元素）
        function clearInput() {
          if (best.type === 'textarea') {
            input.value = '';
          } else {
            // 移除所有子节点，彻底清掉 placeholder 等元素
            while (input.firstChild) {
              input.removeChild(input.firstChild);
            }
            // 确保至少有一个空行（contenteditable 常规要求）
            var emptyP = document.createElement('p');
            var emptyBr = document.createElement('br');
            emptyP.appendChild(emptyBr);
            input.appendChild(emptyP);
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // 多行富文本优先按 ProseMirror 段落结构一次性写入。不能用裸 Enter
        // 模拟换行，因为 Dola composer 会把 Enter 当作发送动作。
        if (best.type === 'contenteditable' && /[\\r\\n]/.test(promptText)) {
          try {
            input.focus();
            input.innerHTML = contentEditableHtml;
            try {
              input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText }));
            } catch(e) {
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: promptText }));
            input.dispatchEvent(new Event('change', { bubbles: true }));

            var multilineRange = document.createRange();
            multilineRange.selectNodeContents(input);
            multilineRange.collapse(false);
            var multilineSelection = window.getSelection();
            multilineSelection.removeAllRanges();
            multilineSelection.addRange(multilineRange);

            var expectedParagraphs = promptText.replace(/\\r\\n?/g, '\\n').split('\\n').length;
            var actualParagraphs = input.querySelectorAll('p').length;
            var multilineValue = verifyValue();
            if (multilineValue.pass && actualParagraphs >= expectedParagraphs) {
              return { ok: true, tag: input.tagName, method: 'prosemirror-paragraphs', actualLen: multilineValue.actualLen, preview: multilineValue.preview };
            }
          } catch(e) {
            console.log('[doubaoBridge] ProseMirror 多行注入异常:', e.message);
          }
        }

        // 策略1：聚焦 + 全选 + execCommand insertText（走编辑器原生流程，React 最容易捕获）
        try {
          input.focus();
          // 全选原有内容（不清空 DOM，避免破坏 React 引用）
          var range1 = document.createRange();
          range1.selectNodeContents(input);
          var sel1 = window.getSelection();
          sel1.removeAllRanges();
          sel1.addRange(range1);

          var ok1 = document.execCommand('insertText', false, promptText);
          if (ok1) {
            // 用 InputEvent 触发（带 data/inputType，React 合成事件更易捕获）
            try {
              input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: promptText }));
            } catch(e) {}
            try {
              input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText }));
            } catch(e) {
              // 降级用普通 Event
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            // composition 序列（模拟中文输入完成，覆盖更多 React 富文本库）
            input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: promptText }));
            input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: promptText }));
            setTimeout(function() {
              try {
                input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText }));
              } catch(e) {
                input.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }, 30);
            setTimeout(function() { input.dispatchEvent(new Event('change', { bubbles: true })); }, 80);
            var v1 = verifyValue();
            if (v1.pass) {
              console.log('[doubaoBridge] execCommand 注入成功, len=' + v1.actualLen + ', preview=' + v1.preview);
              return { ok: true, tag: input.tagName, method: 'execCommand', actualLen: v1.actualLen, preview: v1.preview };
            }
            console.log('[doubaoBridge] execCommand 验证失败, ratio=' + v1.ratio.toFixed(2));
          }
        } catch(e) {
          console.log('[doubaoBridge] execCommand 异常:', e.message);
        }

        // 策略2：Clipboard paste 模拟粘贴
        try {
          input.focus();
          document.execCommand('selectAll', false, null);
          // 创建 paste 事件
          var clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', promptText);
          var pasteEvt = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboardData
          });
          var pasteOk = input.dispatchEvent(pasteEvt);
          if (pasteOk) {
            input.dispatchEvent(new Event('input', { bubbles: true }));
            var v2 = verifyValue();
            if (v2.pass) {
              console.log('[doubaoBridge] paste 注入成功, len=' + v2.actualLen);
              return { ok: true, tag: input.tagName, method: 'paste', actualLen: v2.actualLen, preview: v2.preview };
            }
          }
        } catch(e) {
          console.log('[doubaoBridge] paste 异常:', e.message);
        }

        // 策略3：原生 setter 赋值（textarea/input）
        if (best.type === 'textarea') {
          var nativeSetter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype, 'value'
          ) || Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype, 'value'
          );
          if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(input, promptText);
          } else {
            input.value = promptText;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: promptText }));
          input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: promptText }));
          setTimeout(function() {
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }, 100);
          input.focus();
          var v3 = verifyValue();
          if (v3.pass) {
            return { ok: true, tag: input.tagName, method: 'native-setter', actualLen: v3.actualLen, preview: v3.preview };
          }
        }

        // 策略4：直接设置 textContent + 完整事件序列（contenteditable 兜底）
        if (best.type === 'contenteditable') {
          input.innerHTML = contentEditableHtml;
          // 模拟完整输入事件序列
          try { input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: promptText })); } catch(e) {}
          try { input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText })); } catch(e) { input.dispatchEvent(new Event('input', { bubbles: true })); }
          input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: promptText }));
          input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: promptText }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.focus();
          var v4 = verifyValue();
          if (v4.pass) {
            return { ok: true, tag: input.tagName, method: 'textContent', actualLen: v4.actualLen, preview: v4.preview };
          }
        }

        // 策略5：逐字符模拟真实键盘输入（最慢但最可靠，确保 React 100% 捕获）
        try {
          // 先清空
          if (best.type === 'textarea') {
            input.value = '';
          } else {
            // 全选后删除
            input.focus();
            var selRange = document.createRange();
            selRange.selectNodeContents(input);
            var curSel = window.getSelection();
            curSel.removeAllRanges();
            curSel.addRange(selRange);
            document.execCommand('delete', false, null);
          }

          var chars = promptText.split('');
          var currentVal = '';
          for (var ci = 0; ci < chars.length; ci++) {
            var ch = chars[ci];
            var keyCode = ch.charCodeAt(0);

            // keydown
            input.dispatchEvent(new KeyboardEvent('keydown', {
              key: ch, code: 'Key' + ch.toUpperCase(), keyCode: keyCode, which: keyCode,
              bubbles: true, cancelable: true
            }));

            // keypress
            input.dispatchEvent(new KeyboardEvent('keypress', {
              key: ch, code: 'Key' + ch.toUpperCase(), keyCode: keyCode, which: keyCode,
              bubbles: true, cancelable: true
            }));

            // 更新值
            currentVal += ch;
            if (best.type === 'textarea') {
              var nativeSetter5 = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
              if (nativeSetter5) {
                nativeSetter5.call(input, currentVal);
              } else {
                input.value = currentVal;
              }
            } else {
              // contenteditable: 在光标处插入字符
              document.execCommand('insertText', false, ch);
            }

            // input 事件
            try {
              input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
            } catch(e) {
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // keyup
            input.dispatchEvent(new KeyboardEvent('keyup', {
              key: ch, code: 'Key' + ch.toUpperCase(), keyCode: keyCode, which: keyCode,
              bubbles: true, cancelable: true
            }));
          }

          // 输入完成后触发 change
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: promptText }));

          var v5 = verifyValue();
          if (v5.pass) {
            console.log('[doubaoBridge] 逐字输入成功, len=' + v5.actualLen);
            return { ok: true, tag: input.tagName, method: 'type-char-by-char', actualLen: v5.actualLen, preview: v5.preview };
          }
        } catch(e) {
          console.log('[doubaoBridge] 逐字输入异常:', e.message);
        }

        // 全部失败
        var vFinal = verifyValue();
        return { ok: false, error: '所有注入策略失败, 实际值长度=' + vFinal.actualLen + ', 期望=' + promptText.length + ', 元素类型=' + best.type, actualLen: vFinal.actualLen, method: 'none' };
      } catch (e) {
        return { ok: false, error: e.message || '未知错误', actualLen: 0 };
      }
    })();
  `;

  try {
    const result = await safeExecuteJS<{ ok: boolean; error?: string; tag?: string; method?: string; actualLen?: number; preview?: string }>(
      webview, code, 10000, 'injectPrompt'
    );
    return result;
  } catch (err: any) {
    return { ok: false, error: err.message, actualLen: 0 };
  }
}

// ==================== 点击发送按钮 ====================

/**
 * 点击豆包发送按钮（多策略回退）
 *
 * 策略A：找 aria-label 含"发送"/"send"的 button
 * 策略B：找 textarea 父容器中最后一个非 disabled button
 * 策略C：在 textarea 上触发 Enter 键
 * 策略D：找蓝色圆形发送按钮（AI创作页面）
 * 策略E：找包含发送图标的可点击元素
 */
export async function submitPrompt(webview: WebviewHandle): Promise<boolean> {
  const code = `
    (function() {
      try {
        var sendBtn = null;

        // 豆包当前对话页的权威发送按钮。不能从整页任意按钮中猜测，
        // 否则可能点到模式、菜单等控件并把“点击”误报为“已发送”。
        var exactSendButton = document.querySelector('#flow-end-msg-send');
        if (exactSendButton && exactSendButton.offsetParent !== null &&
            !exactSendButton.disabled && exactSendButton.getAttribute('aria-disabled') !== 'true' &&
            exactSendButton.getAttribute('data-disabled') !== 'true') {
          sendBtn = exactSendButton;
        }

        // ========== 策略A：aria-label 匹配 ==========
        var ariaSelectors = [
          'button[aria-label*="发送"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="send"]',
          'button[aria-label*="提交"]',
        ];
        for (var s = 0; !sendBtn && s < ariaSelectors.length; s++) {
          try {
            var btn = document.querySelector(ariaSelectors[s]);
            if (btn && !btn.disabled && btn.offsetParent !== null) {
              sendBtn = btn;
              break;
            }
          } catch (e) {}
        }

        // ========== 策略B：textarea 父容器中最后一个 button ==========
        if (!sendBtn) {
          var textareas = document.querySelectorAll('textarea');
          var foundTa = null;
          for (var i = 0; i < textareas.length; i++) {
            if (textareas[i].offsetParent !== null) { foundTa = textareas[i]; break; }
          }
          if (foundTa) {
            var container = foundTa.parentElement;
            for (var level = 0; level < 8 && container; level++) {
              var buttons = container.querySelectorAll('button');
              if (buttons.length > 0) {
                for (var b = buttons.length - 1; b >= 0; b--) {
                  if (!buttons[b].disabled && buttons[b].offsetParent !== null) {
                    sendBtn = buttons[b];
                    break;
                  }
                }
                if (sendBtn) break;
              }
              container = container.parentElement;
            }
          }
        }

        // ========== 策略D：AI创作页面的蓝色圆形发送按钮 ==========
        // 在 textarea 右下方，通常是蓝色圆形带箭头图标
        if (!sendBtn && foundTa) {
          var taRect = foundTa.getBoundingClientRect();
          var searchArea = document.elementsFromPoint(
            taRect.right - 40,
            taRect.bottom - 20
          );
          for (var i = 0; i < searchArea.length; i++) {
            var el = searchArea[i];
            if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' ||
                (el.click && window.getComputedStyle(el).cursor === 'pointer')) {
              // 排除 tag/label 类元素（如"图像生成 x"）
              var cls = (el.className || '').toLowerCase();
              var text = (el.textContent || '').trim();
              if (text.length < 30 && !cls.includes('tag') && !text.includes('x') && !text.includes('×')) {
                sendBtn = el;
                break;
              }
            }
          }
        }

        // ========== 策略E：通过 SVG 箭头图标找发送按钮 ==========
        if (!sendBtn) {
          var allSvg = document.querySelectorAll('svg');
          for (var i = 0; i < allSvg.length; i++) {
            var svg = allSvg[i];
            // 找向上箭头 SVG（发送图标通常是 arrow-up）
            var svgHtml = svg.outerHTML || '';
            if (svgHtml.includes('arrow') || svgHtml.includes('Arrow') || svgHtml.includes('send')) {
              var parent = svg.parentElement;
              while (parent && parent !== document.body) {
                if (parent.click && parent.offsetParent !== null) {
                  var style = window.getComputedStyle(parent);
                  if (style.cursor === 'pointer' || parent.tagName === 'BUTTON' || parent.getAttribute('role') === 'button') {
                    sendBtn = parent;
                    break;
                  }
                }
                parent = parent.parentElement;
              }
              if (sendBtn) break;
            }
          }
        }

        // ========== 策略F：textarea 附近右下角的可点击元素 ==========
        if (!sendBtn && foundTa) {
          var taRect2 = foundTa.getBoundingClientRect();
          // 在 textarea 右下角区域搜索
          var nearbyEls = document.querySelectorAll('button, [role="button"], [onclick]');
          for (var i = 0; i < nearbyEls.length; i++) {
            var el = nearbyEls[i];
            var rect = el.getBoundingClientRect();
            // 在 textarea 右侧或下方 60px 范围内
            if (rect.left > taRect2.right - 80 && rect.top > taRect2.bottom - 60 &&
                rect.top < taRect2.bottom + 20 && !el.disabled) {
              var text2 = (el.textContent || '').trim();
              if (text2.length < 20) {
                sendBtn = el;
                break;
              }
            }
          }
        }

        // ========== 策略C：按 Enter 键提交（兜底，支持 textarea 和 contenteditable） ==========
        if (!sendBtn) {
          // 尝试找 textarea
          var ta = document.querySelector('textarea');
          if (ta && ta.offsetParent !== null) {
            console.log('[doubaoBridge] 未找到发送按钮，尝试按 Enter 提交(textarea)');
            ta.focus();
            var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            if (nativeSetter) {
              nativeSetter.call(ta, ta.value);
            }
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
            }));
            ta.dispatchEvent(new KeyboardEvent('keypress', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
            }));
            ta.dispatchEvent(new KeyboardEvent('keyup', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
            }));
            return { ok: true, method: 'enter-textarea' };
          }

          // 尝试找 contenteditable
          var editable = null;
          var allEds = document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]');
          for (var e = 0; e < allEds.length; e++) {
            if (allEds[e].offsetParent !== null) {
              var eRect = allEds[e].getBoundingClientRect();
              if (eRect.width > 100 && eRect.height > 20) {
                editable = allEds[e];
                break;
              }
            }
          }
          if (editable) {
            console.log('[doubaoBridge] 未找到发送按钮，尝试按 Enter 提交(contenteditable)');
            editable.focus();
            // 将光标移到末尾
            var range = document.createRange();
            range.selectNodeContents(editable);
            range.collapse(false);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);

            editable.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
            }));
            editable.dispatchEvent(new KeyboardEvent('keypress', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
            }));
            // 某些编辑器通过 beforeinput 处理 Enter
            try {
              editable.dispatchEvent(new InputEvent('beforeinput', {
                bubbles: true, cancelable: true, inputType: 'insertParagraph', data: null
              }));
            } catch(e) {}
            editable.dispatchEvent(new KeyboardEvent('keyup', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
            }));
            return { ok: true, method: 'enter-editable' };
          }

          return { ok: false, error: '未找到发送按钮且无输入框可按 Enter' };
        }

        console.log('[doubaoBridge] 找到发送按钮 tag=' + sendBtn.tagName + ' class=' + (sendBtn.className || '').substring(0, 60));

        // 先检测按钮是否可用（disabled/aria-disabled/低透明度 都算不可用）
        var btnStyle = window.getComputedStyle(sendBtn);
        var isDisabled = sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true' ||
                        parseFloat(btnStyle.opacity) < 0.5 || btnStyle.pointerEvents === 'none';
        if (isDisabled) {
          console.log('[doubaoBridge] 发送按钮处于禁用状态，点击无效');
          return { ok: false, error: '发送按钮被禁用，提示词可能未被 React 捕获' };
        }

        sendBtn.click();
        return { ok: true, method: 'click' };
      } catch (e) {
        return { ok: false, error: e.message || '未知错误', actualLen: 0 };
      }
    })();
  `;

  try {
    const result = await safeExecuteJS<{ ok: boolean; error?: string; method?: string }>(
      webview, code, 10000, 'submitPrompt'
    );
    if (!result.ok) {
      console.error('[doubaoBridge] submitPrompt 失败:', result.error);
      return false;
    }
    console.log('[doubaoBridge] submitPrompt 成功, 方法:', result.method);
    return true;
  } catch (err: any) {
    console.error('[doubaoBridge] submitPrompt 异常:', err.message);
    return false;
  }
}

/**
 * 视频模式：点击「生成视频」按钮（素材图区域的，不是顶部Tab）
 * 视频模式下必须点这个按钮才会用完整提示词生成，点普通发送按钮会走聊天流程导致提示词被曲解
 */
export async function submitVideoGeneration(webview: WebviewHandle): Promise<boolean> {
  const code = `
    (function() {
      try {
        var viewportH = window.innerHeight;
        var viewportW = window.innerWidth;
        var candidates = [];

        // 策略1：遍历所有元素，找文本精确为"生成视频"的可点击元素
        var allElements = document.querySelectorAll('div, span, button, a, p, li');
        for (var i = 0; i < allElements.length; i++) {
          var el = allElements[i];
          // 只检查直接文本（避免父元素被子元素文本污染）
          var directText = '';
          for (var n = 0; n < el.childNodes.length; n++) {
            if (el.childNodes[n].nodeType === 3) {
              directText += el.childNodes[n].textContent;
            }
          }
          directText = directText.trim();
          if (directText !== '生成视频') continue;
          
          var rect = el.getBoundingClientRect();
          if (rect.width < 20 || rect.height < 20) continue;
          if (rect.top < 0 || rect.top > viewportH) continue;
          if (rect.left < 0 || rect.left > viewportW) continue;
          
          // 排除顶部 Tab 区域（top < 200）
          if (rect.top < 200) continue;
          
          // 排除底部输入框区域的"视频生成"Tab（底部工具栏的）
          if (rect.top > viewportH * 0.85) continue;
          
          // 判断是否可点击
          var style = window.getComputedStyle(el);
          var isClickable = (el.tagName === 'BUTTON' || el.tagName === 'A' || 
                            style.cursor === 'pointer' || el.onclick ||
                            el.getAttribute('role') === 'button');
          
          // 如果本身不可点击，往上找3层看有没有可点击的父元素
          var clickTarget = el;
          if (!isClickable) {
            var parent = el.parentElement;
            for (var d = 0; d < 5 && parent; d++) {
              var pStyle = window.getComputedStyle(parent);
              if (parent.tagName === 'BUTTON' || parent.tagName === 'A' ||
                  pStyle.cursor === 'pointer' || parent.onclick ||
                  parent.getAttribute('role') === 'button') {
                clickTarget = parent;
                isClickable = true;
                // 更新 rect 为父元素的
                var pRect = parent.getBoundingClientRect();
                rect = pRect;
                break;
              }
              parent = parent.parentElement;
            }
          }
          
          if (!isClickable) continue;
          
          var score = 0;
          // 位置在页面中上部（素材图区域，通常在 30%-70% 高度之间）
          if (rect.top > viewportH * 0.25 && rect.top < viewportH * 0.7) score += 100;
          // 有一定大小的按钮加分
          if (rect.width > 60 && rect.height > 30) score += 50;
          if (rect.width > 100) score += 30;
          // 背景色不是透明的（有按钮样式）加分
          if (style.backgroundColor && style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
            score += 40;
          }
          // 有圆角（按钮样式）加分
          if (style.borderRadius && parseInt(style.borderRadius) > 0) {
            score += 20;
          }
          
          candidates.push({ 
            el: clickTarget, 
            score: score, 
            text: directText,
            top: Math.round(rect.top), 
            w: Math.round(rect.width), 
            h: Math.round(rect.height),
            tag: clickTarget.tagName
          });
        }

        // 策略2：如果没找到，用更模糊的匹配（包含"生成视频"的元素）
        if (candidates.length === 0) {
          var allDivs = document.querySelectorAll('div');
          for (var k = 0; k < allDivs.length; k++) {
            var div = allDivs[k];
            var text = (div.textContent || '').trim();
            if (text.indexOf('生成视频') < 0) continue;
            if (text.length > 20) continue; // 太长的不是按钮
            
            var rect3 = div.getBoundingClientRect();
            if (rect3.width < 40 || rect3.height < 25) continue;
            if (rect3.top < 200 || rect3.top > viewportH * 0.85) continue;
            
            var style3 = window.getComputedStyle(div);
            if (style3.cursor !== 'pointer' && div.tagName !== 'BUTTON') continue;
            
            candidates.push({
              el: div,
              score: 50,
              text: text,
              top: Math.round(rect3.top),
              w: Math.round(rect3.width),
              h: Math.round(rect3.height),
              tag: 'DIV'
            });
          }
        }

        if (candidates.length === 0) {
          return { ok: false, error: '未找到生成视频按钮（0候选）' };
        }

        // 按分数排序
        candidates.sort(function(a, b) { return b.score - a.score; });
        
        var best = candidates[0];
        console.log('[doubaoBridge] 视频生成按钮候选前3: ' + candidates.slice(0, 3).map(function(c) { 
          return c.text + '(top=' + c.top + ',size=' + c.w + 'x' + c.h + ',score=' + c.score + ',tag=' + c.tag + ')'; 
        }).join('; '));
        
        best.el.click();
        return { ok: true, method: 'click-video-generate', text: best.text, top: best.top };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })()
  `;

  try {
    const result = await safeExecuteJS<{ ok: boolean; method?: string; text?: string; error?: string }>(
      webview, code, 10000, 'submitVideoGeneration'
    );
    if (!result.ok) {
      console.warn('[doubaoBridge] submitVideoGeneration 失败:', result.error, '，回退到普通 submitPrompt');
      // 回退到普通发送
      return false;
    }
    console.log('[doubaoBridge] submitVideoGeneration 成功, 按钮文本:', result.text);
    return true;
  } catch (err: any) {
    console.error('[doubaoBridge] submitVideoGeneration 异常:', err.message);
    return false;
  }
}

// ==================== 生成状态网络监控（后台 webview 可用） ====================

/**
 * 注入生成状态监听器（基于 fetch/XHR 拦截，不依赖 DOM）
 * 监听 /chat/completion 的 SSE 流开始和结束，写入 window.__genState
 * 后台 webview DOM 被节流时，网络层仍然正常工作
 */
export async function injectGenerationMonitor(webview: WebviewHandle): Promise<boolean> {
  const injectCode = `
    (function() {
      if (window.__genMonitorInstalled) return;
      window.__genMonitorInstalled = true;
      window.__genState = { generating: false, startTime: 0, endTime: 0, lastUpdate: 0, sseDataCount: 0 };
      // 内置扩展由主进程通过同页 postMessage 转发 chain 响应。
      // 把扩展确认的媒体地址放入统一缓存，供任务产物解析器读取，避免
      // 只在扩展面板显示而自动化任务继续等待/回退到普通播放地址。
      window.__doubaoVideoCache = window.__doubaoVideoCache || {};
      window.__doubaoImageCache = window.__doubaoImageCache || { urls: [] };

      // 某些新版图片响应不会经过扩展的 chain 捕获，或原始字段会嵌在
      // completion 的 SSE 字符串里。这里仅读取明确的 raw/original 字段，
      // 不把普通 DOM 展示图写入缓存，保持无水印链路 fail-closed。
      function isHttpMediaUrl(value) {
        return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
      }
      function normalizeRawImageKey(value) {
        return String(value || '')
          .replace(/([a-z])([A-Z])/g, '$1_$2')
          .toLowerCase()
          .replace(/[\s-]+/g, '_');
      }
      function isExplicitRawImageKey(value) {
        var key = normalizeRawImageKey(value);
        return key === 'image_ori_raw' || key === 'image_raw' ||
          key === 'image_ori_raw_url' || key === 'image_raw_url' ||
          key === 'original_image' || key === 'original_image_url' ||
          key === 'origin_image' || key === 'origin_image_url' ||
          key.indexOf('image_ori_raw_') === 0 || key.indexOf('image_raw_') === 0;
      }
      function isExplicitRawImageUrl(value) {
        return /(?:image[_-]?raw|raw[_-]?image|original[_-]?image)/i.test(String(value || ''));
      }
      function isWatermarkedImageUrl(value) {
        return /(?:ds[_-]?wm|i[_-]?pre[_-]?wm|watermarked?|watermark)(?:[._/?-]|$)/i.test(String(value || ''));
      }
      function parseJsonValue(value) {
        if (typeof value !== 'string') return null;
        var text = value.trim();
        if (!text || (text.charAt(0) !== '{' && text.charAt(0) !== '[')) return null;
        try { return JSON.parse(text); } catch (_) { return null; }
      }
      function findRawImageUrl(value, depth) {
        if (depth === undefined) depth = 0;
        if (depth > 10 || value == null) return '';
        if (isHttpMediaUrl(value)) return value.trim();
        if (typeof value === 'string') {
          var parsed = parseJsonValue(value);
          return parsed == null ? '' : findRawImageUrl(parsed, depth + 1);
        }
        if (Array.isArray(value)) {
          for (var ai = 0; ai < value.length; ai++) {
            var arrayUrl = findRawImageUrl(value[ai], depth + 1);
            if (arrayUrl) return arrayUrl;
          }
          return '';
        }
        if (typeof value !== 'object') return '';
        // url_list/urlList 是新版图片对象最常见的原图字段，优先于展示 url。
        var preferredKeys = ['url_list', 'urlList', 'urls', 'download_url_list', 'url', 'uri', 'raw_url', 'origin_url', 'download_url'];
        for (var pk = 0; pk < preferredKeys.length; pk++) {
          var preferredUrl = findRawImageUrl(value[preferredKeys[pk]], depth + 1);
          if (preferredUrl) return preferredUrl;
        }
        var nestedKeys = ['image_raw', 'image_ori_raw', 'image_ori', 'image', 'format_urls', 'formats'];
        for (var nk = 0; nk < nestedKeys.length; nk++) {
          var nestedUrl = findRawImageUrl(value[nestedKeys[nk]], depth + 1);
          if (nestedUrl) return nestedUrl;
        }
        return '';
      }
      function rememberRawImage(url, sourceKey) {
        if (!isHttpMediaUrl(url) || isWatermarkedImageUrl(url)) return;
        var imageCache = window.__doubaoImageCache || { urls: [] };
        imageCache.urls = Array.isArray(imageCache.urls) ? imageCache.urls : [];
        var normalized = url.trim();
        if (imageCache.urls.indexOf(normalized) === -1) imageCache.urls.push(normalized);
        imageCache.lastFieldSource = 'doubao_page_capture';
        imageCache.lastSourceKey = String(sourceKey || 'page');
        imageCache.lastCapturedAt = Date.now();
        window.__doubaoImageCache = imageCache;
      }
      function collectRawImages(value, inheritedRaw, seen, depth) {
        if (depth === undefined) depth = 0;
        if (depth > 12 || value == null) return;
        if (typeof value === 'string') {
          if (inheritedRaw && isHttpMediaUrl(value) && !isWatermarkedImageUrl(value)) {
            rememberRawImage(value, 'page-raw-field');
            return;
          }
          var parsed = parseJsonValue(value);
          if (parsed != null) collectRawImages(parsed, inheritedRaw, seen, depth + 1);
          return;
        }
        if (typeof value !== 'object') return;
        if (!seen) seen = [];
        if (seen.indexOf(value) >= 0) return;
        seen.push(value);
        if (Array.isArray(value)) {
          for (var index = 0; index < value.length; index++) collectRawImages(value[index], inheritedRaw, seen, depth + 1);
          return;
        }
        for (var key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          var rawField = inheritedRaw || isExplicitRawImageKey(key);
          var candidate = findRawImageUrl(value[key], depth + 1);
          if (candidate && rawField && (isExplicitRawImageKey(key) || isExplicitRawImageUrl(candidate) || !isWatermarkedImageUrl(candidate))) {
            rememberRawImage(candidate, key);
          }
          collectRawImages(value[key], rawField, seen, depth + 1);
        }
      }
      function captureRawImagesFromText(rawText) {
        if (typeof rawText !== 'string' || !rawText) return;
        var text = rawText.trim();
        var foundDataLine = false;
        var lines = text.split(/\r?\n/);
        for (var li = 0; li < lines.length; li++) {
          var line = lines[li].replace(/^\s+/, '');
          if (line.indexOf('data:') !== 0) continue;
          var payloadText = line.slice(5).trim();
          if (!payloadText || payloadText === '[DONE]') continue;
          foundDataLine = true;
          var payload = parseJsonValue(payloadText);
          if (payload != null) collectRawImages(payload, false, [], 0);
        }
        if (!foundDataLine) {
          var direct = parseJsonValue(text);
          if (direct != null) collectRawImages(direct, false, [], 0);
        }
      }
      window.addEventListener('message', function(event) {
        try {
          var message = event && event.data;
          if (!message || message.__dolaExtensionBridge !== true || message.type !== 'MEDIA_FOUND' || !Array.isArray(message.items)) return;
          var images = message.items.filter(function(item) {
            return item && item.type === 'image' && typeof item.url === 'string' && /^https?:\\/\\//i.test(item.url);
          });
          if (images.length && (message.source === 'doubao_extension' || message.source === 'dola_extension')) {
            var imageCache = window.__doubaoImageCache || { urls: [] };
            imageCache.urls = Array.isArray(imageCache.urls) ? imageCache.urls : [];
            images.forEach(function(item) {
              if (imageCache.urls.indexOf(item.url) === -1) imageCache.urls.push(item.url);
            });
            imageCache.lastFieldSource = message.source;
            imageCache.lastSourceKey = typeof message.sourceKey === 'string' ? message.sourceKey : '';
            imageCache.lastCapturedAt = Date.now();
            window.__doubaoImageCache = imageCache;
            console.log('[GenMonitor] 扩展原始图片已写入产物缓存:', imageCache.urls.length);
          }
          var videos = message.items.filter(function(item) {
            return item && item.type === 'video' && typeof item.url === 'string' && /^https?:\\/\\//i.test(item.url);
          });
          if (!videos.length) return;
          // 只有带真实 vid 的扩展地址才能进入自动产物链路；普通 chain
          // 媒体仍保留为 dola_chain_media，解析器会 fail-closed。
          var vid = typeof message.vid === 'string' ? message.vid.trim() : '';
          if (!vid) {
            console.warn('[GenMonitor] 扩展媒体缺少真实 vid，跳过自动产物绑定');
            return;
          }
          var cache = window.__doubaoVideoCache || {};
          var messageToken = typeof message.captureToken === 'string' ? message.captureToken : '';
          var messageResetAt = Number(message.captureResetAt || 0);
          var messageCapturedAt = Number(message.capturedAt || 0);
          var proof = typeof message.watermarkFreeProof === 'string' ? message.watermarkFreeProof : '';
          var proofValid = (message.source === 'doubao_extension' && proof === 'doubao_fallback_unwatermarked_v1')
            || (message.source === 'dola_extension' && proof === 'dola_extension_decoded_v1');
          var pageSource = /(^|\.)doubao\.com$/i.test(location.hostname) ? 'doubao_extension'
            : /(^|\.)dola\.com$/i.test(location.hostname) ? 'dola_extension' : '';
          var expectedVid = typeof cache.manualExpectedVid === 'string' ? cache.manualExpectedVid.trim() : '';
          var normalizedUrl = String(videos[0].url || '').toLowerCase();
          try { normalizedUrl = decodeURIComponent(normalizedUrl); } catch (_) {}
          normalizedUrl = normalizedUrl.replace(/(?:no|without)[_-]?watermark|unwatermarked/g, '');
          var explicitlyWatermarked = /(?:video[_-]?gen[_-]?watermark[_-]?dyn|ds[_-]?wm|i[_-]?pre[_-]?wm|watermarked?|watermark)/i.test(normalizedUrl);
          if (!proofValid || message.source !== pageSource || explicitlyWatermarked || !messageToken || messageToken !== cache.captureToken
              || messageResetAt <= 0 || messageResetAt !== Number(cache.resetAt || 0)
              || Number.isFinite(messageCapturedAt) && messageCapturedAt > 0 && messageCapturedAt <= messageResetAt
              || expectedVid && expectedVid !== vid) {
            console.warn('[GenMonitor] 扩展媒体未通过本次任务无水印证明校验，跳过自动产物绑定');
            return;
          }
          cache.lastVid = vid;
          cache[vid] = videos[0].url;
          cache.lastVideoUrl = videos[0].url;
          cache.lastSourceKey = typeof message.sourceKey === 'string' ? message.sourceKey : '';
          cache.lastCapturedAt = Number.isFinite(messageCapturedAt) && messageCapturedAt > 0 ? messageCapturedAt : Date.now();
          cache.lastCaptureToken = messageToken;
          cache.watermarkFreeProof = proof;
          cache.lastFieldSource = message.source;
          cache.trustedExtensionVideo = {
            vid: vid,
            videoUrl: videos[0].url,
            fieldSource: message.source,
            sourceKey: cache.lastSourceKey,
            capturedAt: cache.lastCapturedAt,
            captureToken: messageToken,
            resetAt: messageResetAt,
            watermarkFreeProof: proof
          };
          window.__doubaoVideoCache = cache;
          console.log('[GenMonitor] 本次任务扩展无水印媒体已写入缓存:', vid, cache.lastFieldSource);
        } catch (_) {}
      });

      function markStart() {
        window.__genState.generating = true;
        window.__genState.startTime = Date.now();
        window.__genState.lastUpdate = Date.now();
        window.__genState.endTime = 0;
        window.__genState.sseDataCount = 0;
        console.log('[GenMonitor] 生成开始');
      }

      function markEnd() {
        if (window.__genState.generating) {
          window.__genState.generating = false;
          window.__genState.endTime = Date.now();
          window.__genState.lastUpdate = Date.now();
          console.log('[GenMonitor] 生成结束, 共收到 SSE 数据帧:', window.__genState.sseDataCount);
        }
      }

      function countSSEData(chunk) {
        var lines = chunk.split('\\n');
        var count = 0;
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].indexOf('data:') === 0 && lines[i].length > 6) {
            count++;
          }
        }
        if (count > 0) {
          window.__genState.sseDataCount += count;
          window.__genState.lastUpdate = Date.now();
        }
        captureRawImagesFromText(chunk);
      }

      // ---- 拦截 fetch ----
      var originalFetch = window.fetch;
      window.fetch = function patchedFetch(input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var isCompletion = url.indexOf('/chat/completion') >= 0 || url.indexOf('chain/single') >= 0;
        var isImageGeneration = /\/chat\/completion|chain\/single|\/(?:image|creation)\/(?:generate|create|completion)|\/samantha\/(?:image|creation)/i.test(String(url));

        var promise = originalFetch.apply(this, [input, init]);

        if (isImageGeneration) {
          markStart();
          return promise.then(function(resp) {
            var ct = resp.headers.get('content-type') || '';
            if (ct.indexOf('text/event-stream') >= 0 && resp.body) {
              var teed = resp.body.tee();
              var reader = teed[1].getReader();
              var decoder = new TextDecoder();
              var buffer = '';
              function pump() {
                return reader.read().then(function(result) {
                  if (result.done) {
                    if (buffer.length > 0) countSSEData(buffer);
                    markEnd();
                    return;
                  }
                  var text = decoder.decode(result.value, { stream: true });
                  buffer += text;
                  var idx = buffer.lastIndexOf('\\n');
                  if (idx >= 0) {
                    countSSEData(buffer.substring(0, idx + 1));
                    buffer = buffer.substring(idx + 1);
                  }
                  return pump();
                });
              }
              pump().catch(function() { markEnd(); });
              return new Response(teed[0], {
                status: resp.status,
                statusText: resp.statusText,
                headers: resp.headers,
              });
            } else {
              // 非流式响应，直接结束
              try {
                resp.clone().text().then(function(text) { captureRawImagesFromText(text); }).catch(function() {});
              } catch (_) {}
              markEnd();
            }
            return resp;
          }).catch(function(e) {
            markEnd();
            throw e;
          });
        }

        return promise;
      };

      // ---- 拦截 XHR ----
      var originalXHROpen = XMLHttpRequest.prototype.open;
      var originalXHRSend = XMLHttpRequest.prototype.send;
      var xhrUrlMap = new WeakMap();

      XMLHttpRequest.prototype.open = function(method, url) {
        xhrUrlMap.set(this, url);
        return originalXHROpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function(body) {
        var url = xhrUrlMap.get(this) || '';
        var isCompletion = url.indexOf('/chat/completion') >= 0 || url.indexOf('chain/single') >= 0;
        var isImageGeneration = /\/chat\/completion|chain\/single|\/(?:image|creation)\/(?:generate|create|completion)|\/samantha\/(?:image|creation)/i.test(String(url));

        if (isImageGeneration) {
          markStart();
          this.addEventListener('load', function() {
            try { captureRawImagesFromText(this.responseText || ''); } catch (_) {}
          });
          this.addEventListener('loadend', function() {
            markEnd();
          });
        }

        return originalXHRSend.call(this, body);
      };

      console.log('[GenMonitor] 生成状态监听器已安装');
    })();
  `;

  try {
    await safeExecuteJS(webview, injectCode, 5000, 'injectGenerationMonitor');
    return true;
  } catch (err: any) {
    console.warn('[doubaoBridge] 注入生成状态监听器失败:', err.message);
    return false;
  }
}

/** 原生发送点击的结果；只有 not_attempted 才能证明没有产生页面副作用。 */
export type NativeSubmitClickResult =
  | { status: 'submitted'; method: 'native-click' }
  | { status: 'not_attempted'; reason: 'input_unavailable' | 'send_button_not_ready' | 'invalid_position' }
  | { status: 'uncertain'; reason: string };

/**
 * 以 Electron 原生鼠标事件点击当前豆包页的发送按钮。
 * 豆包的 React 控件在部分账号页会忽略脚本 click()，因此任务自动化优先使用
 * 与人工点击等价的 webview 输入事件。定位失败发生在任何原生事件之前，可以
 * 安全改派；事件已经开始发送后统一按不确定处理，禁止重复发送。
 */
export async function submitPromptWithNativeClick(webview: WebviewHandle): Promise<NativeSubmitClickResult> {
  if (typeof webview.sendInputEvent !== 'function') return { status: 'not_attempted', reason: 'input_unavailable' };
  try {
    const target = await findSendButtonTarget(webview);
    // 只认当前页面的权威发送按钮。找不到时 fail-closed，不猜测其它控件。
    if (!target.ok || !target.position) return { status: 'not_attempted', reason: 'send_button_not_ready' };
    const [x, y] = target.position.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { status: 'not_attempted', reason: 'invalid_position' };
    webview.sendInputEvent({ type: 'mouseMove', x, y });
    webview.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(35);
    webview.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    console.log('[doubaoBridge] submitPrompt 成功, 方法: native-click');
    return { status: 'submitted', method: 'native-click' };
  } catch (error: unknown) {
    // 原生事件可能已经部分送达；此处回退会形成第二次外部副作用。
    console.warn('[doubaoBridge] 原生发送点击失败，禁止自动回退:', getErrorMessage(error));
    return { status: 'uncertain', reason: getErrorMessage(error) };
  }
}

/**
 * 原生 Enter 作为发送按钮点击没有获得页面回执时的单次兜底。
 * 只在调用方已经回读确认“点击未发送”后使用，避免把成功发送的任务重复提交。
 */
export async function submitPromptWithNativeEnter(webview: WebviewHandle): Promise<boolean> {
  if (typeof webview.sendInputEvent !== 'function') return false;
  try {
    const focused = await safeExecuteJS<boolean>(
      webview,
      `
        (function() {
          var editor = document.querySelector('[contenteditable="true"]:not([contenteditable="false"]), textarea:not([disabled])');
          if (!editor || editor.offsetParent === null) return false;
          editor.focus();
          return document.activeElement === editor || editor.contains(document.activeElement);
        })();
      `,
      5000,
      'focusEditorForNativeEnter',
    );
    if (!focused) return false;
    webview.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', code: 'Enter' });
    webview.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', code: 'Enter' });
    console.log('[doubaoBridge] 已发送原生 Enter 提交事件');
    return true;
  } catch (error: unknown) {
    console.warn('[doubaoBridge] 原生 Enter 提交失败:', getErrorMessage(error));
    return false;
  }
}

export interface SubmissionEvidence {
  generationStarted: boolean;
  inputCleared: boolean;
  messageCount: number;
  promptPublished: boolean;
  /** 图片任务页面已出现本次生成的可见图片；仅用于确认已提交，不作为归档地址。 */
  imageOutput?: boolean;
}

/**
 * 豆包视频对话中的后续“确认”消息入口。
 * 与首次任务提交分开命名，调用方仍必须保证每轮只调用一次并自行回读消息证据。
 */
export async function submitGenerationConfirmationWithNativeClick(
  webview: WebviewHandle,
): Promise<boolean> {
  const result = await submitPromptWithNativeClick(webview);
  return result.status === 'submitted';
}

/**
 * 豆包免费额度耗尽后的付费额度确认按钮。
 *
 * 调用方必须先确认最新助手回复确实是付费额度请求；这里再同时校验页面正文与
 * 按钮文字，并使用原生鼠标事件点击一次，避免脚本 click 被 React 忽略。
 */
export async function confirmDoubaoPaidQuotaUsage(webview: WebviewHandle): Promise<boolean> {
  if (typeof webview.sendInputEvent !== 'function') return false;
  try {
    const target = await safeExecuteJS<{ ok: boolean; position?: string }>(
      webview,
      `
        (function() {
          var normalize = function(value) {
            return String(value || '')
              .normalize('NFKC')
              .replace(/\\u00a0/g, ' ')
              .replace(/[\\u200b-\\u200d\\ufeff]/g, '')
              .replace(/\\s+/g, ' ')
              .trim();
          };
          var visible = function(element) {
            if (!element) return false;
            var style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || style.pointerEvents === 'none') return false;
            var rect = element.getBoundingClientRect();
            return rect.width >= 12 && rect.height >= 12
              && rect.bottom > 0 && rect.right > 0
              && rect.top < window.innerHeight && rect.left < window.innerWidth;
          };
          var pageText = normalize(document.body && document.body.innerText);
          var hasPaidRequest = /免费[^。！？\\n]{0,32}(?:额度|次数)[^。！？\\n]{0,20}(?:已)?(?:用完|用尽|耗尽|达到上限)/i.test(pageText)
            && /(?:使用|消耗|扣除)[^。！？\\n]{0,16}付费额度|付费额度[^。！？\\n]{0,16}(?:继续|生成)/i.test(pageText)
            && /是否[^。！？\\n]{0,12}(?:继续|确认)|(?:继续|确认)[^。！？\\n]{0,12}(?:生成|使用)/i.test(pageText);
          if (!hasPaidRequest) return { ok: false };

          var exactLabels = ['确认生成', '继续生成', '确认并生成', '使用付费额度', '确认使用付费额度', '继续使用'];
          var roots = [document];
          var allElements = [];
          for (var rootIndex = 0; rootIndex < roots.length && rootIndex < 64; rootIndex++) {
            var root = roots[rootIndex];
            var elements = Array.from(root.querySelectorAll('*'));
            allElements = allElements.concat(elements);
            for (var shadowIndex = 0; shadowIndex < elements.length; shadowIndex++) {
              if (elements[shadowIndex].shadowRoot) roots.push(elements[shadowIndex].shadowRoot);
            }
          }
          var best = null;
          for (var i = 0; i < allElements.length; i++) {
            var labelNode = allElements[i];
            if (!visible(labelNode)) continue;
            var text = normalize(labelNode.value || labelNode.innerText || labelNode.textContent || labelNode.getAttribute('aria-label') || labelNode.getAttribute('title'));
            var actionText = text.replace(/\\s*[→›>]+\\s*$/, '');
            var exactIndex = exactLabels.indexOf(actionText);
            var genericContinue = actionText === '继续' || actionText === '确认';
            if (exactIndex < 0 && !genericContinue) continue;

            var contextNode = labelNode;
            var contextText = '';
            for (var depth = 0; depth < 7 && contextNode; depth++) {
              contextText = normalize(contextNode.innerText || contextNode.textContent);
              if (/付费额度/.test(contextText) && /免费[^。！？\\n]{0,40}(?:用完|用尽|耗尽|达到上限)/.test(contextText)) break;
              contextNode = contextNode.parentElement || (contextNode.getRootNode && contextNode.getRootNode().host) || null;
            }
            if (genericContinue && !(/付费额度/.test(contextText) && /免费[^。！？\\n]{0,40}(?:用完|用尽|耗尽|达到上限)/.test(contextText))) continue;

            var clickable = labelNode.closest && labelNode.closest('button, [role="button"], a, [tabindex], input[type="button"], input[type="submit"]');
            if (!clickable || !visible(clickable)) clickable = labelNode;
            if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true') continue;
            var rect = clickable.getBoundingClientRect();
            var centerX = Math.round(rect.left + rect.width / 2);
            var centerY = Math.round(rect.top + rect.height / 2);
            var hitRoot = clickable.getRootNode && clickable.getRootNode();
            var hit = hitRoot && typeof hitRoot.elementFromPoint === 'function'
              ? hitRoot.elementFromPoint(centerX, centerY)
              : document.elementFromPoint(centerX, centerY);
            if (!hit || (!clickable.contains(hit) && !hit.contains(clickable))) continue;
            var tag = String(clickable.tagName || '').toLowerCase();
            var interactiveScore = tag === 'button' || tag === 'input'
              ? 30
              : clickable.getAttribute('role') === 'button'
                ? 25
                : window.getComputedStyle(clickable).cursor === 'pointer'
                  ? 20
                  : 0;
            var score = (exactIndex >= 0 ? 100 - exactIndex : 10) + interactiveScore;
            if (!best || score > best.score) {
              best = {
                score: score,
                position: String(centerX) + ',' + String(centerY)
              };
            }
          }
          return best ? { ok: true, position: best.position } : { ok: false };
        })();
      `,
      5000,
      'findDoubaoPaidQuotaButton',
    );
    if (!target.ok || !target.position) return false;
    const [x, y] = target.position.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    webview.sendInputEvent({ type: 'mouseMove', x, y });
    webview.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(35);
    webview.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    console.log('[doubaoBridge] 已原生点击豆包付费额度继续按钮');
    return true;
  } catch (error: unknown) {
    console.warn('[doubaoBridge] 豆包付费额度按钮点击失败:', getErrorMessage(error));
    return false;
  }
}

/**
 * 提交后的 fail-closed 回读：只有输入框不再保留本次提示词，且已观察到
 * 同一提示词进入会话区（或页面给出生成回执），才能认为任务真正离开
 * “仅注入”阶段。Dola 会把长提示词重新排版、加上“生成视频：”前缀，
 * 因此这里同时使用规范化前缀匹配，不能依赖全文字面相等。
 */
export async function getSubmissionEvidence(
  webview: WebviewHandle,
  prompt: string,
  startTimeBeforeSubmit: number,
  messageCountBeforeSubmit: number,
  mode?: string,
): Promise<SubmissionEvidence> {
  const promptText = JSON.stringify(prompt.replace(/\s+/g, ' ').trim());
  const code = `
    (function() {
      var normalize = function(value) {
        return String(value || '')
          .replace(/\\u00a0/g, ' ')
          .replace(/[\\u200b-\\u200d\\ufeff]/g, '')
          .replace(/\\s+/g, ' ')
          .trim();
      };
      var canonical = function(value) {
        return normalize(value).normalize('NFKC').toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '');
      };
      var expected = ${promptText};
      var expectedNormalized = normalize(expected);
      var expectedKey = canonical(expected).slice(0, 36);
      // 短提示词同样可以作为已发布证据。匹配发生在移除编辑器后的会话
      // 克隆文档/消息节点上，不会把仍停留在输入框里的文字当成回执。
      var matchesExpectedPrompt = function(value) {
        var normalizedValue = normalize(value);
        var valueKey = canonical(value);
        if (expectedNormalized.length < 2 || expectedKey.length < 2) return false;
        return normalizedValue.indexOf(expectedNormalized) !== -1
          || valueKey.indexOf(expectedKey) !== -1;
      };
      var editorValues = [];
      var editors = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]');
      for (var i = 0; i < editors.length; i++) {
        var editor = editors[i];
        if (editor.offsetParent === null) continue;
        var candidate = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT'
          ? editor.value
          : editor.innerText;
        editorValues.push(String(candidate || ''));
      }
      var editorContainsPrompt = editorValues.some(function(candidate) {
        return matchesExpectedPrompt(candidate);
      });
      var state = window.__genState || {};
      var messageCount = document.querySelectorAll('[data-message-id]').length;
      // 当前 Dola 页面并非所有元素都带 data-message-id。先读取消息节点，
      // 再把编辑器从克隆文档移除；这样既能处理长提示词折叠，也能避免
      // 把输入框自身的文字当成已发布消息。
      var messageTexts = [];
      var messageNodes = document.querySelectorAll('[data-message-id], [data-testid*="message"], [class*="message"]');
      for (var m = 0; m < messageNodes.length; m++) {
        var messageText = normalize(messageNodes[m].innerText || messageNodes[m].textContent || '');
        if (messageText) messageTexts.push(messageText);
      }
      var clone = document.body.cloneNode(true);
      var cloneEditors = clone.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]');
      for (var j = 0; j < cloneEditors.length; j++) cloneEditors[j].remove();
      var conversationText = normalize(clone.innerText || '');
      var conversationKey = canonical(conversationText);
      var promptPublished = false;
      for (var n = 0; n < messageTexts.length; n++) {
        if (matchesExpectedPrompt(messageTexts[n])) {
          promptPublished = true;
          break;
        }
      }
      if (!promptPublished) {
        promptPublished = matchesExpectedPrompt(conversationText);
      }
      var hasReceipt = /视频生成已提交|正在为您生成|我将为您生成|正在生成|生成中|你的视频生成好了/.test(conversationText);
      // 豆包图片页可能不产生稳定的 SSE/消息标识，但生成完成后会先把
      // 图片渲染到会话区。该信号只用于确认“发送已生效”，不把 DOM 地址
      // 写入产物缓存；无水印归档仍必须依赖扩展捕获的原始地址。
      var imageOutput = false;
      if (${mode === 'image' ? 'true' : 'false'}) {
        var images = document.querySelectorAll('img');
        for (var imageIndex = 0; imageIndex < images.length; imageIndex++) {
          var image = images[imageIndex];
          if (!image || image.offsetParent === null) continue;
          var imageRect = image.getBoundingClientRect();
          var imageSource = String(image.currentSrc || image.src || '');
          if (imageRect.width < 120 || imageRect.height < 120 || !imageSource) continue;
          if (/avatar|logo|icon|emoji|favicon/i.test(imageSource)) continue;
          var imageAncestor = image.closest && image.closest('[data-message-id],[data-testid*="message"],[class*="message"],[class*="bubble"],article');
          if (imageAncestor && /(^|[-_ ])(?:user|human|question)(?:$|[-_ ])/i.test(String(imageAncestor.className || '') + ' ' + String(imageAncestor.getAttribute('data-role') || ''))) continue;
          imageOutput = true;
          break;
        }
      }
      // 图片页可能尚未把展示图挂到 DOM，但扩展已经捕获到本次任务的
      // 原始地址；捕获时间晚于本次发送基线时，可作为“已发送”证据，
      // 不会把地址直接当作归档地址。
      var imageCache = window.__doubaoImageCache || {};
      var imageCaptureAfterSubmit = ${mode === 'image' ? 'true' : 'false'}
        && Number(imageCache.lastCapturedAt || 0) > ${startTimeBeforeSubmit};
      return {
        // 部分普通对话不产生可观察的 SSE data 帧；同一提示词进入会话区，
        // 或在基线后出现带生成语义的新消息，均可作为页面回执。
        generationStarted: Number(state.startTime || 0) > ${startTimeBeforeSubmit}
          || promptPublished
          || imageOutput
          || imageCaptureAfterSubmit
          || (messageCount > ${messageCountBeforeSubmit} && hasReceipt),
        inputCleared: !editorContainsPrompt,
        messageCount: messageCount,
        promptPublished: promptPublished,
        imageOutput: imageOutput || imageCaptureAfterSubmit,
      };
    })();
  `;
  try {
    return await safeExecuteJS<SubmissionEvidence>(webview, code, 8000, 'getSubmissionEvidence');
  } catch {
    return { generationStarted: false, inputCleared: false, messageCount: 0, promptPublished: false, imageOutput: false };
  }
}

export async function getGenerationStartTime(webview: WebviewHandle): Promise<number> {
  try {
    return await safeExecuteJS<number>(
      webview,
      '(function() { return Number((window.__genState && window.__genState.startTime) || 0); })();',
      5000,
      'getGenerationStartTime',
    );
  } catch {
    return 0;
  }
}

/** 与提交回读使用同一选择器的消息基线，不能复用综合生成检测的异构计数。 */
export async function getSubmissionMessageCount(webview: WebviewHandle): Promise<number> {
  try {
    return await safeExecuteJS<number>(
      webview,
      "(function() { return document.querySelectorAll('[data-message-id]').length; })();",
      5000,
      'getSubmissionMessageCount',
    );
  } catch {
    return 0;
  }
}

/** 返回不含输入框的会话可见文本，用于新版页面没有稳定消息属性时的终态回读。 */
export async function getConversationText(webview: WebviewHandle): Promise<string> {
  try {
    return await safeExecuteJS<string>(
      webview,
      `
        (function() {
          var clone = document.body.cloneNode(true);
          var editors = clone.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]');
          for (var i = 0; i < editors.length; i++) editors[i].remove();
          return String(clone.innerText || '').replace(/\\s+/g, ' ').trim();
        })();
      `,
      5000,
      'getConversationText',
    );
  } catch {
    return '';
  }
}

/**
 * 读取当前会话最后一条助手消息的正文。
 *
 * 豆包的用户气泡和助手消息都使用 message_text_content，因此这里不再
 * 读取 document.body，而是按消息节点角色收集候选；找不到明确的助手
 * 节点时返回空字符串，宁可让调用方看到空结果，也不把整页导航文案写入任务。
 */
export async function getLatestAssistantReply(webview: WebviewHandle): Promise<string> {
  try {
    const candidates = await safeExecuteJS<ConversationMessageCandidate[]>(
      webview,
      `
        (function() {
          try {
            var normalize = function(value) {
              return String(value || '')
                .replace(/\\u00a0/g, ' ')
                .replace(/[\\u200b-\\u200d\\ufeff]/g, '')
                .replace(/\\s+/g, ' ')
                .trim();
            };
            var isVisible = function(element) {
              if (!element || element.nodeType !== 1) return false;
              var style = window.getComputedStyle(element);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
              var rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            };
            var valueOf = function(element, attribute) {
              try { return element.getAttribute(attribute) || ''; } catch (e) { return ''; }
            };
            var classOf = function(element) {
              try {
                return typeof element.className === 'string' ? element.className : String(element.className && element.className.baseVal || '');
              } catch (e) { return ''; }
            };
            var roleFromMarkers = function(element) {
              var assistantScore = 0;
              var userScore = 0;
              var current = element;
              var depth = 0;
              while (current && depth < 6) {
                var className = classOf(current).toLowerCase();
                var roleText = [
                  valueOf(current, 'data-role'),
                  valueOf(current, 'data-message-role'),
                  valueOf(current, 'data-sender-role'),
                  valueOf(current, 'data-sender'),
                  valueOf(current, 'data-user-type'),
                  valueOf(current, 'aria-label'),
                  valueOf(current, 'id'),
                  className,
                ].join(' ').toLowerCase();
                var userType = valueOf(current, 'data-user-type');
                if (userType === '2') assistantScore += 14;
                if (userType === '1') userScore += 14;
                if (className.indexOf('text-s-color-text-secondary') >= 0) assistantScore += 12;
                if (className.indexOf('text-g-send-msg-bubble-text') >= 0) userScore += 12;
                if (/(^|[\\s:_\\-.])(assistant|aibot|bot|receive|received|response|reply|answer|output|助手|豆包|接收)(?=$|[\\s:_\\-.])/.test(roleText)) {
                  assistantScore += depth === 0 ? 8 : 3;
                }
                if (/(^|[\\s:_\\-.])(user|human|sender|send|question|prompt|用户|人类|提问|发送)(?=$|[\\s:_\\-.])/.test(roleText)) {
                  userScore += depth === 0 ? 8 : 3;
                }
                current = current.parentElement;
                depth += 1;
              }
              if (assistantScore > userScore && assistantScore > 0) return 'assistant';
              if (userScore > assistantScore && userScore > 0) return 'user';
              return 'unknown';
            };
            var shouldRemove = function(element) {
              var tagName = String(element.tagName || '').toLowerCase();
              if (tagName === 'button' || tagName === 'a' || tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;
              var role = valueOf(element, 'role').toLowerCase();
              if (role === 'button' || role === 'menuitem' || role === 'toolbar') return true;
              if (valueOf(element, 'aria-hidden') === 'true') return true;
              var marker = [
                classOf(element),
                valueOf(element, 'data-testid'),
                valueOf(element, 'data-foundation-type'),
                valueOf(element, 'data-slot'),
              ].join(' ').toLowerCase();
              return /(^|[-_\\s])(action|actions|actionbar|suggest|suggestion|recommend|recommendation|quick-reply|quick_reply|toolbar|feedback|operate|operation|follow-up|followup)([-_\\s]|$)/.test(marker);
            };
            var readText = function(element) {
              if (!element) return '';
              var clone = element.cloneNode(true);
              var descendants = clone.querySelectorAll ? clone.querySelectorAll('*') : [];
              for (var di = descendants.length - 1; di >= 0; di--) {
                if (shouldRemove(descendants[di])) descendants[di].remove();
              }
              return normalize(clone.innerText || clone.textContent || '');
            };
            var directMessageRoot = function(element) {
              if (!element) return null;
              if (element.matches && element.matches('[data-message-id]')) return element;
              if (element.closest) return element.closest('[data-message-id]');
              return null;
            };
            var candidates = [];
            var roots = document.querySelectorAll('[data-message-id]');
            for (var ri = 0; ri < roots.length; ri++) {
              var root = roots[ri];
              if (!isVisible(root)) continue;
              var textNodes = root.querySelectorAll('[data-testid="message_text_content"]');
              var parts = [];
              var resolvedRole = roleFromMarkers(root);
              for (var ti = 0; ti < textNodes.length; ti++) {
                var textNode = textNodes[ti];
                if (directMessageRoot(textNode) !== root) continue;
                var nodeRole = roleFromMarkers(textNode);
                if (nodeRole !== 'unknown') resolvedRole = nodeRole;
                var part = readText(textNode);
                if (part && parts.indexOf(part) < 0) parts.push(part);
              }
              if (parts.length === 0) {
                var rootText = readText(root);
                if (rootText) parts.push(rootText);
              }
              var messageText = normalize(parts.join(' '));
              if (!messageText || resolvedRole === 'unknown') continue;
              candidates.push({
                role: resolvedRole,
                text: messageText,
                index: ri,
                messageId: valueOf(root, 'data-message-id') || undefined,
              });
            }
            if (candidates.length === 0) {
              var fallbackNodes = document.querySelectorAll('[data-testid="message_text_content"]');
              for (var fi = 0; fi < fallbackNodes.length; fi++) {
                var fallbackNode = fallbackNodes[fi];
                if (!isVisible(fallbackNode) || directMessageRoot(fallbackNode)) continue;
                var fallbackRole = roleFromMarkers(fallbackNode);
                var fallbackText = readText(fallbackNode);
                if (!fallbackText || fallbackRole === 'unknown') continue;
                candidates.push({ role: fallbackRole, text: fallbackText, index: fi });
              }
            }
            return candidates;
          } catch (e) {
            return [];
          }
        })();
      `,
      5000,
      'getLatestAssistantReply',
    );
    return selectLatestAssistantReply(Array.isArray(candidates) ? candidates : []);
  } catch {
    return '';
  }
}

/**
 * 检查豆包页面当前是否正在生成回复
 * 返回 generating=true 表示确定在生成，false 表示确定已完成，unknown 表示无法确定
 */
export async function checkGenerating(webview: WebviewHandle): Promise<boolean> {
  const result = await checkGeneratingDetailed(webview);
  if (result.status === 'unknown') {
    // 无法确定时保守返回 true（继续等待），避免提前结束
    return true;
  }
  return result.generating;
}

interface GeneratingResult {
  generating: boolean;
  status: 'detected' | 'unknown';
  reason?: string;
  messageCount?: number;
  lastMessageHasImage?: boolean;
}

/**
 * 详细版生成检测：多维度综合判断
 * 1. 停止按钮/loading 指示器（最可靠）
 * 2. 对话消息数量变化
 * 3. 最新消息是否包含产物图片
 */
export async function checkGeneratingDetailed(webview: WebviewHandle): Promise<GeneratingResult> {
  const code = `
    (function() {
      try {
        // ========== 维度0：网络层监控（最可靠，后台 webview 也能用） ==========
        if (window.__genState && window.__genMonitorInstalled) {
          var gs = window.__genState;
          // 正在生成中
          if (gs.generating && gs.startTime > 0) {
            return { generating: true, status: 'detected', reason: 'network-monitor', sseDataCount: gs.sseDataCount, lastUpdate: gs.lastUpdate };
          }
          // 已完成（有明确的开始和结束时间）
          if (!gs.generating && gs.endTime > 0 && gs.startTime > 0 && gs.sseDataCount > 0) {
            return { generating: false, status: 'detected', reason: 'network-monitor', sseDataCount: gs.sseDataCount, endTime: gs.endTime };
          }
          if (!gs.generating && gs.endTime > 0 && gs.startTime > 0) {
            return { generating: false, status: 'unknown', reason: 'network-empty', sseDataCount: gs.sseDataCount, endTime: gs.endTime };
          }
          // 状态未初始化（还没发过请求），继续走 DOM 检测
        }

        // ========== 维度1：停止按钮 / 生成中指示器 ==========
        var stopSelectors = [
          'button[aria-label*="停止"]',
          'button[aria-label*="stop"]',
          'button[aria-label*="Stop"]',
          '[class*="stop-generat"]',
          '[class*="StopGenerat"]',
          'button svg[class*="stop"]',
        ];
        for (var i = 0; i < stopSelectors.length; i++) {
          try {
            var el = document.querySelector(stopSelectors[i]);
            if (el && el.offsetParent !== null) {
              return { generating: true, status: 'detected', reason: 'stop-button' };
            }
          } catch (e) {}
        }

        var loadingSelectors = [
          '[class*="loading"]',
          '[class*="typing"]',
          '[class*="streaming"]',
          '[class*="thinking"]',
          '.animate-pulse',
          '[role="status"]',
        ];
        for (var j = 0; j < loadingSelectors.length; j++) {
          try {
            var els = document.querySelectorAll(loadingSelectors[j]);
            for (var k = 0; k < els.length; k++) {
              if (els[k].offsetParent !== null) {
                return { generating: true, status: 'detected', reason: 'loading-indicator' };
              }
            }
          } catch (e) {}
        }

        // ========== 维度2：对话消息检测 ==========
        // 豆包聊天消息通常在特定容器中，统计消息数量
        var msgSelectors = [
          '[data-message-id]',
          '[class*="message-item"]',
          '[class*="messageItem"]',
          '[class*="chat-message"]',
          '[class*="chatMessage"]',
          '[data-testid*="message"]',
          'article',
        ];
        var msgCount = 0;
        var lastMsgHasImage = false;
        for (var m = 0; m < msgSelectors.length; m++) {
          try {
            var msgs = document.querySelectorAll(msgSelectors[m]);
            if (msgs.length > msgCount) {
              msgCount = msgs.length;
              // 检查最后一条消息是否有图片
              if (msgs.length > 0) {
                var lastMsg = msgs[msgs.length - 1];
                var imgs = lastMsg.querySelectorAll('img');
                var videos = lastMsg.querySelectorAll('video');
                lastMsgHasImage = imgs.length > 0 || videos.length > 0;
                // 如果最后一条消息有下载按钮，也认为有产物
                var downloadBtns = lastMsg.querySelectorAll('button[aria-label*="下载"], [class*="download"]');
                if (downloadBtns.length > 0) lastMsgHasImage = true;
              }
            }
          } catch (e) {}
        }

        // 维度3：检查输入框是否可用（生成完成后输入框会恢复）
        var textarea = document.querySelector('textarea');
        var inputDisabled = textarea ? textarea.disabled : true;

        // 综合判断：没有停止按钮 + 没有loading指示器 + (有产物图片 或 输入框可用)
        if (lastMsgHasImage || !inputDisabled) {
          return { generating: false, status: 'detected', reason: lastMsgHasImage ? 'has-output' : 'input-ready', messageCount: msgCount, lastMessageHasImage: lastMsgHasImage };
        }

        // 无法确定（可能刚开始生成还没出现停止按钮，也可能页面结构变了）
        return { generating: false, status: 'unknown', reason: 'indeterminate', messageCount: msgCount, lastMessageHasImage: lastMsgHasImage };
      } catch (e) {
        return { generating: false, status: 'unknown', reason: 'error:' + e.message };
      }
    })();
  `;

  try {
    const result = await safeExecuteJS<GeneratingResult>(
      webview, code, 8000, 'checkGenerating'
    );
    return result;
  } catch {
    return { generating: false, status: 'unknown', reason: 'execute-error' };
  }
}

// ==================== 获取结果图片 URL ====================

/**
 * 从豆包生成结果页面提取图片 URL
 * 只提取 AI 生成的产物图片，排除用户上传的参考图
 * 返回 JSON 数组字符串，包含所有产物图片的直链
 */
export async function getResultUrl(
  webview: WebviewHandle,
  timeoutMs: number = 10000,
  mode: 'image' | 'video' = 'image',
): Promise<string> {
  try {
    const code = `
      (function() {
        var urls = [];
        var imageMode = ${JSON.stringify(mode)} === 'image';

        // ========== 消息选择器（与 checkGenerating 保持一致） ==========
        var msgSelectors = [
          '[class*="message-item"]',
          '[class*="messageItem"]',
          '[class*="chat-message"]',
          '[class*="chatMessage"]',
          '[data-testid*="message"]',
          'article',
        ];

        // 找到最多消息的选择器
        var bestMsgs = [];
        var bestSelector = '';
        for (var m = 0; m < msgSelectors.length; m++) {
          try {
            var msgs = document.querySelectorAll(msgSelectors[m]);
            if (msgs.length > bestMsgs.length) {
              bestMsgs = msgs;
              bestSelector = msgSelectors[m];
            }
          } catch(e) {}
        }

        // ========== 辅助函数：判断元素是否在视口左侧（AI消息） ==========
        function isLeftSide(el) {
          var rect = el.getBoundingClientRect();
          return rect.left < window.innerWidth * 0.4;
        }

        // ========== 辅助函数：从元素中提取有效图片 ==========
        function extractImages(container) {
          var result = [];
          if (!container) return result;
          var imgs = container.querySelectorAll('img');
          for (var i = 0; i < imgs.length; i++) {
            var src = imgs[i].currentSrc || imgs[i].src || '';
            if (!src && imgs[i].srcset) src = String(imgs[i].srcset).split(',')[0].trim().split(/\s+/)[0];
            if (!src || src.indexOf('data:') === 0) continue;
            if (src.indexOf('icon') >= 0 || src.indexOf('avatar') >= 0 ||
                src.indexOf('emoji') >= 0 || src.indexOf('logo') >= 0 ||
                src.indexOf('badge') >= 0 || src.indexOf('status') >= 0) continue;
            if (src.indexOf('http') < 0) continue;
            // 必须是内容图（CDN域名或图片扩展名）
            var isContentImg = src.indexOf('image') >= 0 || src.indexOf('img') >= 0 ||
                               src.indexOf('cdn') >= 0 || src.indexOf('.png') >= 0 ||
                               src.indexOf('.jpg') >= 0 || src.indexOf('.webp') >= 0 ||
                               src.indexOf('tos-') >= 0 || src.indexOf('bytecdn') >= 0 ||
                               src.indexOf('byteimg') >= 0 || src.indexOf('doubao') >= 0;
            if (!isContentImg && !imageMode) continue;
            // 跳过太小的图（图标、缩略图等，生成产物一般 > 200px）
            var w = imgs[i].naturalWidth || imgs[i].width || 0;
            var h = imgs[i].naturalHeight || imgs[i].height || 0;
            if (w > 0 && h > 0 && (w < 100 || h < 100)) continue;
            if (imageMode && w === 0 && h === 0) {
              var rect = imgs[i].getBoundingClientRect();
              if (rect.width < 150 || rect.height < 150) continue;
            }
            if (result.indexOf(src) === -1) {
              result.push(src);
            }
          }
          // 只提取视频源；poster 是封面图片，不能作为视频产物地址返回
          var videos = container.querySelectorAll('video');
          for (var j = 0; j < videos.length; j++) {
            var vsrc = videos[j].src || '';
            if (vsrc && vsrc.indexOf('http') === 0 && result.indexOf(vsrc) === -1) {
              // 视频地址去水印
              vsrc = vsrc.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
              result.push(vsrc);
            }
            // source 子元素
            var srcs = videos[j].querySelectorAll('source');
            for (var k2 = 0; k2 < srcs.length; k2++) {
              var ssrc = srcs[k2].src || '';
              if (ssrc && ssrc.indexOf('http') === 0 && result.indexOf(ssrc) === -1) {
                ssrc = ssrc.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
                result.push(ssrc);
              }
            }
          }
          return result;
        }

        // ========== 方法1：找到包含下载/保存按钮的消息（AI产物才有下载按钮） ==========
        var downloadBtnSelectors = [
          'button[aria-label*="下载"]',
          'button[aria-label*="保存"]',
          'button[aria-label*="download"]',
          'button[aria-label*="save"]',
          '[class*="download"]',
          '[class*="Download"]',
          '[class*="save-btn"]',
          '[title*="下载"]',
          '[title*="保存"]',
          '[data-testid*="download"]',
          '[data-testid*="save"]',
        ];

        var aiContainers = [];
        if (bestMsgs.length > 0) {
          for (var i = 0; i < bestMsgs.length; i++) {
            var msg = bestMsgs[i];
            // 检查消息里有没有下载/保存按钮
            var hasDownloadBtn = false;
            for (var d = 0; d < downloadBtnSelectors.length; d++) {
              try {
                var btns = msg.querySelectorAll(downloadBtnSelectors[d]);
                if (btns.length > 0) {
                  hasDownloadBtn = true;
                  break;
                }
              } catch(e) {}
            }
            if (hasDownloadBtn) {
              aiContainers.push(msg);
            }
          }
        }

        // ========== 方法2：如果方法1没找到，用"左侧消息+有图片/视频+非上传区"判断 AI 消息 ==========
        if (aiContainers.length === 0 && bestMsgs.length > 0) {
          var viewportH = window.innerHeight;
          for (var k = 0; k < bestMsgs.length; k++) {
            var msg2 = bestMsgs[k];
            var msgRect = msg2.getBoundingClientRect();

            // 排除底部输入区域的元素（上传的参考图、输入框预览等）
            if (msgRect.top > viewportH * 0.75) continue;
            // 排除太窄的元素（可能不是完整消息）
            if (msgRect.width < 100) continue;
            // 必须在左侧（AI 消息区）
            if (!isLeftSide(msg2)) continue;

            var imgs2 = msg2.querySelectorAll('img');
            var videos2 = msg2.querySelectorAll('video');
            if (imgs2.length === 0 && videos2.length === 0) continue;

            // 检查是否有足够大的内容图（排除头像、图标、小缩略图）
            var hasLargeContent = false;
            for (var p = 0; p < imgs2.length; p++) {
              var s = imgs2[p].src || '';
              if (s.indexOf('http') < 0) continue;
              if (s.indexOf('icon') >= 0 || s.indexOf('avatar') >= 0 || s.indexOf('emoji') >= 0 || s.indexOf('logo') >= 0) continue;
              var iw = imgs2[p].naturalWidth || imgs2[p].width || 0;
              var ih = imgs2[p].naturalHeight || imgs2[p].height || 0;
              if (iw >= 150 && ih >= 150) {
                hasLargeContent = true;
                break;
              }
            }
            // 有视频元素也算
            if (!hasLargeContent && videos2.length > 0) hasLargeContent = true;

            if (hasLargeContent) {
              // 额外检查：消息中不包含上传/输入相关元素
              var hasUploadEl = msg2.querySelector('[class*="upload"], [class*="input"], [contenteditable="true"], textarea');
              if (!hasUploadEl) {
                aiContainers.push(msg2);
              }
            }
          }
        }

        // ========== 从 AI 容器中提取图片 ==========
        for (var c = 0; c < aiContainers.length; c++) {
          var imgs = extractImages(aiContainers[c]);
          for (var u = 0; u < imgs.length; u++) {
            if (urls.indexOf(imgs[u]) === -1) {
              urls.push(imgs[u]);
            }
          }
        }

        // ========== 兜底：仅提取视频元素（图片兜底已移除，避免误把上传图当产物） ==========
        if (urls.length === 0) {
          // 图片模式需要覆盖新版没有 download button / message class 的结构；
          // 只接受可见的大图并排除底部上传区，避免把参考图登记为产物。
          if (imageMode) {
            var allImages = document.querySelectorAll('img');
            for (var im = 0; im < allImages.length; im++) {
              var image = allImages[im];
              var imageSrc = image.currentSrc || image.src || '';
              if (!imageSrc || imageSrc.indexOf('http') !== 0) continue;
              var imageRect = image.getBoundingClientRect();
              if (imageRect.top > window.innerHeight * 0.8 || imageRect.width < 150 || imageRect.height < 150) continue;
              var imageClass = String(image.className || '').toLowerCase();
              var imageAlt = String(image.alt || '').toLowerCase();
              if (/icon|avatar|emoji|logo|badge|status|upload|preview/.test(imageClass + ' ' + imageAlt)) continue;
              if (image.closest('[class*="upload"], [class*="input"], [contenteditable="true"], textarea')) continue;
              if (urls.indexOf(imageSrc) === -1) urls.push(imageSrc);
            }
          }
          // 视频兜底：只提取视频元素（图片兜底已由上面的 imageMode 分支负责）。
          var allVideos = document.querySelectorAll('video');
          for (var v = 0; v < allVideos.length; v++) {
            var vSrc = allVideos[v].src || '';
            if (vSrc && vSrc.indexOf('http') === 0 && urls.indexOf(vSrc) === -1) {
              // 视频地址去水印
              vSrc = vSrc.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
              urls.push(vSrc);
            }
            // 检查 source 子元素
            var sources = allVideos[v].querySelectorAll('source');
            for (var s = 0; s < sources.length; s++) {
              var sSrc = sources[s].src || '';
              if (sSrc && sSrc.indexOf('http') === 0 && urls.indexOf(sSrc) === -1) {
                sSrc = sSrc.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
                urls.push(sSrc);
              }
            }
          }
        }

        return JSON.stringify(urls);
      })();
    `;
    const result = await safeExecuteJS<string>(webview, code, timeoutMs, 'getResultUrl');
    return result || '[]';
  } catch {
    return '[]';
  }
}

// ==================== 导航到豆包聊天页 ====================

function getPlatformChatRoot(webview: WebviewHandle): string | null {
  const currentUrl = webview.getURL();
  if (/^https?:\/\/([^/]+\.)?dola\.com\//i.test(currentUrl)) return 'https://www.dola.com/chat';
  if (/^https?:\/\/([^/]+\.)?doubao\.com\//i.test(currentUrl)) return 'https://www.doubao.com/chat/';
  return null;
}

/**
 * 确保 webview 在豆包聊天页面
 */
export function navigateToChat(webview: WebviewHandle): void {
  const currentUrl = webview.getURL();
  const chatRoot = getPlatformChatRoot(webview);
  if (chatRoot && !currentUrl.includes('/chat')) {
    webview.loadURL(chatRoot);
  }
}

// ==================== 等待页面就绪 ====================

/**
 * 等待豆包聊天页面 DOM 完全加载（输入框可见）
 * 轮询检查 textarea 或 contenteditable 元素是否可见
 */
export async function waitForChatReady(
  webview: WebviewHandle,
  timeoutMs: number = 15000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const code = `
      (function() {
        // 与 injectPrompt 保持一致的选择器逻辑
        var textareas = document.querySelectorAll('textarea');
        for (var i = 0; i < textareas.length; i++) {
          if (textareas[i].offsetParent !== null && !textareas[i].disabled) {
            return true;
          }
        }
        var editables = document.querySelectorAll('[contenteditable="true"]');
        for (var j = 0; j < editables.length; j++) {
          if (editables[j].offsetParent !== null) {
            return true;
          }
        }
        return false;
      })();
    `;

    try {
      const ready = await safeExecuteJS<boolean>(webview, code, 5000, 'waitForChatReady');
      if (ready) return true;
    } catch {
      // 页面可能还在加载，继续等待
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

// ==================== 模式切换 ====================

/** 生成模式对应的 URL 映射 */
/**
 * 切换豆包生成模式
 *
 * 对于 image/video 模式：导航到统一的 chat 页面，然后通过 DOM 点击底部 Tab 切换
 * 对于 chat/music 模式：直接导航到对应 URL
 */
export function switchMode(webview: WebviewHandle, mode: string): void {
  const currentUrl = webview.getURL();
  const chatRoot = getPlatformChatRoot(webview);
  if (!chatRoot) {
    console.warn('[doubaoBridge] 平台域名无法确认，拒绝跨平台导航');
    return;
  }
  const isDola = chatRoot.includes('dola.com');
  const targetUrl = mode === 'music' && !isDola
    ? 'https://www.doubao.com/chat/create-music/'
    : chatRoot;

  // 对于 image/video，统一导航到 /chat/ 页面（Tab 切换在 DOM 中完成）
  if (mode === 'image' || mode === 'video') {
    // 豆包使用 /chat/，Dola 的实际地址通常是 /chat（没有尾斜杠）。
    // 统一按平台判断，避免已经在 Dola 创作页时重复 reload，导致底部控件
    // 在 clickAITab 的有界等待期间被卸载又重新挂载。
    const alreadyOnChatPage = isDola
      ? currentUrl.includes('/chat')
      : currentUrl.includes('/chat/');
    if (alreadyOnChatPage) {
      console.log(`[doubaoBridge] 已在 chat 页面，通过 Tab 切换到 ${mode} 模式`);
      // 不导航，由 clickAITab 处理
      return;
    }
    console.log(`[doubaoBridge] 导航到 chat 页面 → ${targetUrl}`);
    webview.loadURL(targetUrl);
    return;
  }

  // chat/music 模式：直接 URL 导航
  if (currentUrl.includes(mode === 'chat' ? '/chat/' : `/create-${mode}/`)) {
    console.log(`[doubaoBridge] 已在 ${mode} 模式，跳过切换`);
    return;
  }

  console.log(`[doubaoBridge] 切换到 ${mode} 模式 → ${targetUrl}`);
  webview.loadURL(targetUrl);
}

/**
 * 在 AI 创作页面点击 Tab 切换模式（图像/视频）
 * 豆包统一页面底部输入框下方有「图像」「视频」Tab
 * 注意：必须排除左侧边栏菜单中的同名元素
 */
export async function clickAITab(
  webview: WebviewHandle,
  mode: 'image' | 'video',
  platform: AccountPlatform = 'doubao',
): Promise<boolean> {
  const tabLabel = mode === 'image' ? '图像生成' : '视频生成';
  const code = `
    (async function() {
      try {
        function sleep(ms) {
          return new Promise(function(resolve) { setTimeout(resolve, ms); });
        }
        function activate(el) {
          if (!el) return false;
          var r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          var x = Math.round(r.left + r.width / 2);
          var y = Math.round(r.top + r.height / 2);
          var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
          try { el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts))); } catch (_) {}
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          try { el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts))); } catch (_) {}
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
          return true;
        }
        function videoControlsReady() {
          var model = document.querySelector('[data-input-engine-actionbar-control-key="video-model"]');
          var composite = document.querySelector('[data-creation-params-panel-id]');
          return Boolean(model && composite && model.getBoundingClientRect().width > 20 &&
            composite.getBoundingClientRect().width > 20);
        }
        function dolaVideoModeSnapshot() {
          function visible(el) {
            if (!el) return false;
            var r = el.getBoundingClientRect();
            var style = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight &&
              style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          }
          function textOf(el) {
            var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
            var attrs = ['aria-label', 'title', 'data-testid', 'data-action', 'data-name', 'data-value', 'data-ratio', 'data-option-key', 'id', 'class'].map(function (name) {
              try { return el.getAttribute(name) || ''; } catch (_) { return ''; }
            }).filter(Boolean);
            return [text].concat(attrs).join(' ').replace(/\\s+/g, ' ').trim();
          }
          function normalized(value) {
            return String(value || '').normalize('NFKC').replace(/秒/g, 's').replace(/[：／/×xX＊*]/g, ':').replace(/\\s+/g, ' ').trim();
          }
          function hasModelLabel(value) {
            var text = normalized(value);
            return /(?:^|\\s)(?:(?:模型|model)\\s*:?\\s*)?(?:(?:dreamina\\s+)?seedance\\s*)?2\\.(?:5|0)(?:\\s*(?:fast|mini))?(?=$|\\s|[·|/()（）])/i.test(text);
          }
          function hasDurationLabel(value) {
            return /(?:^|[^0-9])(?:30|1[0-5]|[4-9])\\s*s(?:$|[^0-9])/i.test(normalized(value));
          }
          function hasRatioLabel(value) {
            var text = normalized(value).replace(/\\s+/g, '');
            return /(?:画面比例|比例|画幅|宽高比|aspect:?ratio|自动|自适应|auto|[0-9]+:[0-9]+)/i.test(text);
          }
          var editor = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')).find(visible);
          var sendButton = document.querySelector('#flow-end-msg-send');
          var editorRect = editor ? editor.getBoundingClientRect() : null;
          var sendRect = visible(sendButton) ? sendButton.getBoundingClientRect() : null;
          // Dola 会调整控件的嵌套层级。以输入框/发送按钮为锚点读取同一底栏，
          // 同时保留父控件文本，避免“模型 2.5”被拆成两个节点后误判未就绪。
          var anchorTop = editorRect
            ? Math.max(0, editorRect.top - 160)
            : sendRect
              ? Math.max(0, sendRect.top - 160)
              : window.innerHeight * 0.45;
          var controls = Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],[role="option"],div,span'))
            .filter(visible)
            .map(function (el) { return { el: el, rect: el.getBoundingClientRect(), text: textOf(el) }; })
            .filter(function (item) {
              return item.rect.bottom >= anchorTop && item.rect.top < window.innerHeight &&
                item.text.length > 0 && item.text.length < 120;
            });
          var labels = controls.map(function (item) { return item.text; });
          var stableModelControl = document.querySelector('[data-input-engine-actionbar-control-key="video-model"]');
          var stableDurationControl = document.querySelector('[data-input-engine-actionbar-control-key="video-duration"]');
          var stableRatioControl = document.querySelector('[data-input-engine-actionbar-control-key="video-ratio"]');
          var stableVisible = function (element) {
            return Boolean(element && visible(element));
          };
          var editorText = editor
            ? [editor.getAttribute('placeholder') || '', editor.getAttribute('aria-label') || '', textOf(editor)].join(' ')
            : '';
          // Dola 当前激活态会在“视频生成”后附带一个关闭图标（例如
          // “视频生成×”）。旧的全等匹配会把已经显示的创作栏误判成
          // 未进入视频模式，随后在 20 秒后报 mode_entry_not_ready。
          var hasVideoMode = labels.some(function (value) {
            var compact = String(value || '').replace(/\\s+/g, '');
            return /^(?:视频生成|生成视频)(?:[×✕✖xX关闭收起])?$/i.test(compact)
              || /video\\s*generation/i.test(value);
          });
          var hasModel = stableVisible(stableModelControl) || labels.some(hasModelLabel);
          var hasDuration = stableVisible(stableDurationControl) || labels.some(hasDurationLabel);
          var hasRatio = stableVisible(stableRatioControl) || labels.some(hasRatioLabel);
          var hasMoreControl = labels.some(function (value) {
            var normalized = String(value || '').replace(/\\s+/g, '').toLowerCase();
            return /^(?:更多(?:选项|设置)?|more(?:options?)?|\\.{3}|…|⋯|•••|⋮)$/i.test(normalized) ||
              /(?:overflow|ellipsis|action-more)/i.test(normalized);
          });
          var hasVideoEditor = /描述你想要的视频|describe.*video/i.test(editorText);
          var uniqueLabels = labels.filter(function (value, index) { return labels.indexOf(value) === index; }).slice(0, 16);
          var hasComposerAnchor = Boolean(editor || sendRect) || labels.some(function (value) {
            var compact = String(value || '').replace(/\\s+/g, '');
            return /(?:视频生成|生成视频|模型|比例|画面比例|时长|[0-9]+s)/i.test(compact);
          });
          return {
            // 比例控件可能在模型/时长之后异步挂载，不能把它作为入口阶段
            // 的硬门槛；只要视频编辑器、模型和时长已经出现，就进入配置阶段，
            // 后续 configureDolaVideoOptions 仍会强制完成比例选择与最终回读。
            // 部分 Dola 版本的可编辑层是自绘节点，无法稳定暴露为
            // textarea/contenteditable；只要底部创作栏已经同时显示模型、
            // 时长和比例/更多入口，就视为入口已就绪，具体值仍由后续
            // configureDolaVideoOptions 的点击与最终回读负责确认。
            ready: Boolean(hasModel && hasDuration && (hasRatio || hasMoreControl) &&
              (hasVideoMode || hasVideoEditor || hasComposerAnchor)),
            url: location.href,
            editor: Boolean(editor),
            sendButton: Boolean(sendRect),
            videoMode: hasVideoMode,
            model: hasModel,
            duration: hasDuration,
            ratio: hasRatio,
            more: hasMoreControl,
            labels: uniqueLabels
          };
        }
        function dolaVideoModeReady() {
          return dolaVideoModeSnapshot().ready;
        }
        async function waitForVideoControls(timeoutMs) {
          var deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (videoControlsReady()) return true;
            await sleep(250);
          }
          return videoControlsReady();
        }
        async function waitForDolaVideoMode(timeoutMs) {
          var deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (videoControlsReady() || dolaVideoModeReady()) return true;
            await sleep(250);
          }
          return videoControlsReady() || dolaVideoModeReady();
        }
        async function findDolaVideoEntry(timeoutMs) {
          var deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            var all = Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],a,div,span'));
            var candidates = all.filter(function (el) {
              var r = el.getBoundingClientRect();
              var style = window.getComputedStyle(el);
              var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
              var compactText = text.replace(/\\s+/g, '');
              var isVideoEntry = /^(?:视频生成|生成视频|视频)$/i.test(compactText) ||
                /^(?:视频生成|生成视频)[^\\u4e00-\\u9fa5a-zA-Z0-9]{0,2}$/i.test(compactText);
              // 激活态 chip 的尾部“×”是关闭按钮，不是入口；避免在
              // 识别失败的短窗口里误点它把视频模式关闭。
              var looksLikeCloseChip = /[×✕✖xX]$/.test(compactText);
              return r.width > 10 && r.height > 10 && r.top > window.innerHeight * 0.5 && r.bottom > 0 &&
                r.left > 200 && r.top < window.innerHeight && isVideoEntry && !looksLikeCloseChip &&
                style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
                !Array.from(el.children || []).some(function (child) {
                  return ((child.innerText || child.textContent || '').replace(/\\s+/g, ' ').trim()) === text;
                });
            });
            candidates.sort(function (a, b) {
              var ar = a.getBoundingClientRect(); var br = b.getBoundingClientRect();
              return ar.width * ar.height - br.width * br.height || br.top - ar.top;
            });
            if (candidates.length > 0) return candidates[0];
            await sleep(250);
          }
          return null;
        }
        async function waitForModeEntry(timeoutMs) {
          var deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            var textarea = document.querySelector('textarea');
            var textareaRect = textarea ? textarea.getBoundingClientRect() : null;
            var entries = Array.from(document.querySelectorAll('button, [role="tab"], div, span, a'));
            var ready = entries.some(function(el) {
              var r = el.getBoundingClientRect();
              var text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
              var visible = r.width > 0 && r.height > 0 && r.top >= 0 && r.left > 200;
              var nearEditor = textareaRect && r.top > textareaRect.bottom - 10 && r.top < window.innerHeight;
              return visible && text.length < 20 && text.indexOf('${tabLabel}') >= 0 &&
                (nearEditor || r.top > window.innerHeight * 0.5);
            });
            if (ready) return true;
            await sleep(250);
          }
          return false;
        }
        async function findVisibleModeMenuOption(timeoutMs) {
          var deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            var options = Array.from(document.querySelectorAll('#input-engine-container button')).filter(function(el) {
              var r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && (el.innerText || '').replace(/\\s+/g, ' ').trim() === '视频生成';
            });
            if (options.length > 0) return options[options.length - 1];
            await sleep(250);
          }
          return null;
        }
        async function finishVideoModeSelection(initialMethod, initialTag, initialRect) {
          if ('${mode}' !== 'video') {
            return { ok: true, method: initialMethod, tag: initialTag, pos: Math.round(initialRect.left) + ',' + Math.round(initialRect.top) };
          }
          // Dola 的视频入口不是豆包的 data-valid-btn 菜单结构。点击菜单项后，
          // 只等待 Dola 页面实际回显“视频生成 + 模型 + 时长”，不再尝试豆包二次菜单。
          if ('${platform}' === 'dola' && await waitForDolaVideoMode(15000)) {
            return { ok: true, method: initialMethod + '-dola-verified', tag: initialTag, pos: Math.round(initialRect.left) + ',' + Math.round(initialRect.top) };
          }
          if (await waitForVideoControls(1500)) {
            return { ok: true, method: initialMethod + '-verified', tag: initialTag, pos: Math.round(initialRect.left) + ',' + Math.round(initialRect.top) };
          }

          // 2026-08 新版首击只展开“模式”菜单，并不会真正选中视频模式。
          // 必须从当前模式触发器再次打开菜单，再点击菜单内的精确“视频生成”，
          // 并以模型/组合控件实际挂载作为唯一成功证据。
          var modeTrigger = document.querySelector('[data-valid-btn="mode-select-action-btn"]');
          if (modeTrigger && modeTrigger.getBoundingClientRect().width > 0) {
            activate(modeTrigger);
          }
          var option = await findVisibleModeMenuOption(5000);
          if (!activate(option)) {
            return { ok: false, error: '视频模式菜单选项不可见' };
          }
          if (!await waitForVideoControls(15000)) {
            return { ok: false, error: '视频模式已点击但参数控件未挂载' };
          }
          var optionRect = option.getBoundingClientRect();
          return { ok: true, method: initialMethod + '-menu-confirmed', tag: option.tagName, pos: Math.round(optionRect.left) + ',' + Math.round(optionRect.top) };
        }
        // Dola 的 /chat 页面新对话默认是普通聊天，底部“视频生成”是一个
        // 入口按钮而不是已选中的 Tab。先确认当前是否已经挂载视频参数栏；
        // 若没有，点击 Dola 自己的入口，再等待模型/时长控件出现。
        if ('${platform}' === 'dola' && '${mode}' === 'video') {
          if (await waitForDolaVideoMode(3000)) {
            return { ok: true, method: 'dola-video-controls-already-mounted', tag: 'DOLA_VIDEO_CONTROLS', pos: '' };
          }
          var dolaEntry = await findDolaVideoEntry(10000);
          if (!activate(dolaEntry)) {
            return { ok: false, error: 'Dola 视频生成入口不可见', diagnostic: dolaVideoModeSnapshot() };
          }
          if (!await waitForDolaVideoMode(20000)) {
            return { ok: false, error: 'Dola 视频生成入口已点击但参数控件未挂载', diagnostic: dolaVideoModeSnapshot() };
          }
          var dolaEntryRect = dolaEntry.getBoundingClientRect();
          return { ok: true, method: 'dola-video-entry-confirmed', tag: dolaEntry.tagName, pos: Math.round(dolaEntryRect.left) + ',' + Math.round(dolaEntryRect.top) };
        }
        if (!await waitForModeEntry(15000)) {
          return { ok: false, error: '${tabLabel}模式入口未在等待窗口内挂载' };
        }
        var allEls = document.querySelectorAll('button, [role="tab"], div, span, a');

        // 先找到 textarea 输入框的位置
        var textarea = document.querySelector('textarea');
        var textareaRect = textarea ? textarea.getBoundingClientRect() : null;
        var viewportHeight = window.innerHeight;

        // 收集所有文本匹配的元素（宽松匹配：innerText 包含目标文本）
        var candidates = [];
        for (var i = 0; i < allEls.length; i++) {
          var el = allEls[i];
          var innerText = (el.innerText || '').trim();
          var directText = '';
          for (var j = 0; j < el.childNodes.length; j++) {
            if (el.childNodes[j].nodeType === 3) directText += el.childNodes[j].textContent || '';
          }
          directText = directText.trim();

          // 匹配条件：直接文本等于目标 或 innerText 等于目标 或短文本 includes 匹配
          // includes 匹配限制 innerText 长度 < 20，避免匹配到包含目标文本的大容器
          var exactMatch = directText === '${tabLabel}' || innerText === '${tabLabel}';
          var includesMatch = !exactMatch && innerText.length < 20 && innerText.indexOf('${tabLabel}') >= 0;
          if (!exactMatch && !includesMatch) continue;
          if (el.offsetParent === null) continue;

          var rect = el.getBoundingClientRect();
          if (rect.top < 0 || rect.left < 0) continue;
          if (rect.width === 0 || rect.height === 0) continue;

          candidates.push({
            el: el,
            rect: rect,
            tag: el.tagName,
            isButton: el.tagName === 'BUTTON' || el.getAttribute('role') === 'tab',
            nearTextarea: textareaRect && rect.top > textareaRect.bottom - 10 && rect.top < viewportHeight,
            inBottomHalf: rect.top > viewportHeight * 0.5,
            notInSidebar: rect.left > 200,
            isSmall: rect.width < 150 && rect.height < 60,
            directTextMatch: directText === '${tabLabel}',
          });
        }

        // 优先：button/tab role + textarea 附近 + 不在侧边栏
        for (var i = 0; i < candidates.length; i++) {
          var c = candidates[i];
          if (c.isButton && c.nearTextarea && c.notInSidebar) {
            activate(c.el);
            return await finishVideoModeSelection('button-near-textarea', c.tag, c.rect);
          }
        }

        // 次优先：button/tab role + 页面下半 + 不在侧边栏
        for (var i = 0; i < candidates.length; i++) {
          var c = candidates[i];
          if (c.isButton && c.inBottomHalf && c.notInSidebar) {
            activate(c.el);
            return await finishVideoModeSelection('button-bottom', c.tag, c.rect);
          }
        }

        // 兜底1：任何匹配 + textarea 附近 + 不在侧边栏 + 小元素
        for (var i = 0; i < candidates.length; i++) {
          var c = candidates[i];
          if (c.nearTextarea && c.notInSidebar && c.isSmall) {
            activate(c.el);
            return await finishVideoModeSelection('near-textarea', c.tag, c.rect);
          }
        }

        // 兜底2：任何匹配 + 不在侧边栏
        for (var i = 0; i < candidates.length; i++) {
          var c = candidates[i];
          if (c.notInSidebar) {
            activate(c.el);
            return await finishVideoModeSelection('not-sidebar', c.tag, c.rect);
          }
        }

        // 全部失败，输出诊断信息
        var diag = [];
        for (var i = 0; i < allEls.length; i++) {
          var el = allEls[i];
          var t = (el.innerText || '').trim();
          if (t.indexOf('${tabLabel}') >= 0 && t.length < 50) {
            var r = el.getBoundingClientRect();
            diag.push(el.tagName + '|' + t.substring(0,20) + '|' + Math.round(r.left) + ',' + Math.round(r.top) + '|' + Math.round(r.width) + 'x' + Math.round(r.height));
          }
        }
        return { ok: false, error: '未找到${tabLabel}Tab, candidates=' + candidates.length + ', diag=' + diag.join('; ') };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
  `;

  try {
    const result = await safeExecuteJS<{
      ok: boolean;
      error?: string;
      method?: string;
      tag?: string;
      pos?: string;
      diagnostic?: Record<string, unknown>;
    }>(
      webview, code, 40000, 'clickAITab'
    );
    if (result.ok) {
      console.log(`[doubaoBridge] 已点击${tabLabel}Tab, 方法: ${result.method}, tag: ${result.tag}, pos: ${result.pos}`);
    } else {
      console.warn(`[doubaoBridge] 点击${tabLabel}Tab 失败:`, result.error, result.diagnostic || '无页面诊断');
    }
    return result.ok;
  } catch (err: any) {
    console.error('[doubaoBridge] clickAITab 异常:', err.message);
    return false;
  }
}

/**
 * 等待模式切换完成（页面重新加载 + DOM 就绪）
 */
export async function waitForModeReady(
  webview: WebviewHandle,
  mode: string,
  timeoutMs: number = 20000
): Promise<boolean> {
  const startTime = Date.now();

  // 对于 image/video，等待 chat 页面就绪
  const urlMatch = mode === 'chat' ? '/chat/' : mode === 'music' ? '/create-music' : '/chat/';

  while (Date.now() - startTime < timeoutMs) {
    try {
      const currentUrl = webview.getURL();
      if (currentUrl.includes(urlMatch)) {
        const ready = await waitForChatReady(webview, timeoutMs - (Date.now() - startTime));
        if (ready) {
          console.log(`[doubaoBridge] ${mode} 模式已就绪`);
          return true;
        }
      }
    } catch {
      // 页面可能还在加载
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.warn(`[doubaoBridge] ${mode} 模式切换超时`);
  return false;
}

/**
 * 检测当前豆包页面处于哪种模式
 */
export async function detectCurrentMode(webview: WebviewHandle): Promise<string> {
  try {
    const currentUrl = webview.getURL();
    if (currentUrl.includes('/create-image')) return 'image';
    if (currentUrl.includes('/create-video')) return 'video';
    if (currentUrl.includes('/create-music')) return 'music';
    if (currentUrl.includes('/chat/')) return 'chat';
    return 'chat';
  } catch {
    return 'chat';
  }
}

/**
 * 配置视频生成选项（模型、时长、比例）
 * 在豆包视频生成页面，通过文本匹配点击对应选项
 */
export async function configureVideoOptions(
  webview: WebviewHandle,
  config: { model: string; duration: string; aspectRatio: string },
  options?: {
    platform?: 'doubao' | 'dola';
    onReadiness?: (result: VideoControlReadinessResult) => void | Promise<void>;
  },
): Promise<void> {
  if (options?.platform === 'dola') {
    return configureDolaVideoOptions(webview, config, options);
  }
  // 2026-08 新版创作页把“比例 + 时长”收敛为同一个弹层；旧版三个
  // 独立下拉的兜底会在未回读时误报成功。统一走新版可见控件并逐项回读。
  return configureVideoOptionsV2(webview, config, options);

  /* istanbul ignore next -- 保留旧版适配作为历史参考，V2 失败一律抛错而不回退。 */
  // 模型名称映射（豆包页面显示的文本）
  const modelLabels: Record<string, string[]> = {
    'seedance-2.5': ['Seedance 2.5', '2.5'],
    'seedance-2.0': ['Seedance 2.0', '2.0', '2.0 标准版', '标准', 'Standard'],
    'seedance-2.0-fast': ['Seedance 2.0 Fast', '2.0 Fast', 'Fast', '2.0 极速', '极速', '极速版', '2.0 Fast 极速'],
    'seedance-2.0-mini': ['Seedance 2.0 Mini', '2.0 Mini', 'Mini', '2.0 轻量', '轻量', '轻量版'],
  };

  const modelTexts = modelLabels[config.model] || [config.model];
  const durationSec = config.duration.replace('s', '');
  const durationTexts = [durationSec + ' 秒', durationSec + '秒', config.duration];

  /**
   * 当前豆包视频时长使用 Radix slider：aria-valuemin=0 对应 4 秒，
   * aria-valuemax=11 对应 15 秒。必须使用真实键盘事件操作控件，不能改写请求。
   */
  const selectDurationSlider = async (): Promise<'selected' | 'membership_required' | 'not_found'> => {
    if (typeof webview.sendInputEvent !== 'function') return 'not_found';
    const targetSeconds = Number(durationSec);
    if (!Number.isInteger(targetSeconds) || targetSeconds < 4 || targetSeconds > 15) return 'not_found';

    const findSlider = async (): Promise<{ ok: boolean; clickPos?: string; triggerClickPos?: string }> => safeExecuteJS<{
      ok: boolean;
      clickPos?: string;
      triggerClickPos?: string;
    }>(webview, `
        (function() {
          var sliders = Array.from(document.querySelectorAll('[role="slider"]'));
          var slider = sliders.find(function(el) {
            var r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0
              && el.getAttribute('aria-valuemin') === '0'
              && el.getAttribute('aria-valuemax') === '11';
          });
          if (!slider) {
            var trigger = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find(function(el) {
              var r = el.getBoundingClientRect();
              var text = (el.innerText || '').trim();
              return r.width > 0 && r.height > 0 && /(?:自动|[0-9]+:[0-9]+)[ ]*·[ ]*[0-9]+s/.test(text);
            });
            if (!trigger) return { ok: false };
            var tr = trigger.getBoundingClientRect();
            return {
              ok: false,
              triggerClickPos: Math.round(tr.left + tr.width / 2) + ',' + Math.round(tr.top + tr.height / 2)
            };
          }
          var r = slider.getBoundingClientRect();
          slider.focus();
          return {
            ok: true,
            clickPos: Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2)
          };
        })()
      `,
      3000,
      'find_video_duration_slider',
    ).catch((): { ok: boolean } => ({ ok: false }));

    let slider = await findSlider();
    if (!slider.ok && slider.triggerClickPos) {
      const [triggerX, triggerY] = slider.triggerClickPos.split(',').map(Number);
      if (Number.isFinite(triggerX) && Number.isFinite(triggerY)) {
        webview.sendInputEvent({ type: 'mouseMove', x: triggerX, y: triggerY });
        webview.sendInputEvent({ type: 'mouseDown', x: triggerX, y: triggerY, button: 'left', clickCount: 1 });
        webview.sendInputEvent({ type: 'mouseUp', x: triggerX, y: triggerY, button: 'left', clickCount: 1 });
        await sleep(350);
        slider = await findSlider();
      }
    }
    if (!slider.ok || !slider.clickPos) return 'not_found';

    const [x, y] = slider.clickPos.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'not_found';
    webview.sendInputEvent({ type: 'mouseMove', x, y });
    webview.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    webview.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    webview.sendInputEvent({ type: 'keyDown', keyCode: 'Home' });
    webview.sendInputEvent({ type: 'keyUp', keyCode: 'Home' });
    for (let step = 0; step < targetSeconds - 4; step += 1) {
      webview.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
      webview.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    }
    await sleep(500);

    const result = await safeExecuteJS<{ selected: boolean; membershipRequired: boolean }>(
      webview,
      `
        (function() {
          var expected = ${JSON.stringify(targetSeconds - 4)};
          var slider = Array.from(document.querySelectorAll('[role="slider"]')).find(function(el) {
            return el.getAttribute('aria-valuemin') === '0' && el.getAttribute('aria-valuemax') === '11';
          });
          var subscription = Array.from(document.querySelectorAll('iframe')).some(function(frame) {
            var title = (frame.getAttribute('title') || '').trim();
            var src = frame.getAttribute('src') || '';
            return title.indexOf('订阅') >= 0 || /subscribe|subscription|membership|upgrade/i.test(src);
          });
          return {
            selected: !!slider && Number(slider.getAttribute('aria-valuenow')) === expected,
            membershipRequired: subscription
          };
        })()
      `,
      3000,
      'verify_video_duration_slider',
    );

    if (result.membershipRequired) {
      // 关闭本次参数探测触发的订阅窗口，确保失败后不遗留购买界面。
      webview.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      webview.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      return 'membership_required';
    }
    return result.selected ? 'selected' : 'not_found';
  };

  /**
   * 点击下拉选项：先点击触发按钮展开下拉，再选择目标选项
   * triggerTexts: 触发按钮的文本关键词（用于找到并点击展开）
   * optionTexts: 下拉选项的文本
   */
  // ========== 辅助：确保视频配置栏可见 ==========
  const ensureVideoConfigBar = async (): Promise<boolean> => {
    const code = `
      (function() {
        try {
          // 先找输入框并聚焦
          var ta = document.querySelector('textarea');
          var ce = document.querySelector('[contenteditable="true"]');
          var input = ta || ce;
          if (input) input.focus();

          // 检查是否有模型/比例/时长相关配置按钮
          var viewportH = window.innerHeight;
          var all = document.querySelectorAll('button, [role="button"], div, span');
          var hasModel = false, hasRatio = false, hasDuration = false;
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.offsetParent === null) continue;
            var rect = el.getBoundingClientRect();
            if (rect.width < 20 || rect.height < 20) continue;
            if (rect.top < viewportH * 0.5) continue;
            var text = (el.innerText || '').trim();
            if (!text || text.length > 30) continue;
            if (text.indexOf('模型') >= 0 && text.length < 20) hasModel = true;
            if (text.indexOf('比例') >= 0 && text.length < 10) hasRatio = true;
            if ((text.indexOf('秒') >= 0 || text.indexOf('s ') >= 0 || /\\d+s$/.test(text)) && text.length < 10) hasDuration = true;
          }
          return { ok: hasModel || hasRatio, hasModel: hasModel, hasRatio: hasRatio, hasDuration: hasDuration };
        } catch(e) {
          return { ok: false, error: e.message };
        }
      })()
    `;
    try {
      const r = await safeExecuteJS<{ ok: boolean; hasModel: boolean; hasRatio: boolean; hasDuration: boolean }>(
        webview, code, 3000, 'ensure_config_bar'
      );
      return r.ok;
    } catch {
      return false;
    }
  };

  // 先确保配置栏可见
  await ensureVideoConfigBar();
  await sleep(300);
  await ensureVideoConfigBar(); // 二次确认

  // ========== 下拉选择函数 ==========
  const selectDropdownOption = async (
    triggerTexts: string[],
    optionTexts: string[],
    label: string
  ): Promise<boolean> => {
    const canNativeClick = typeof webview.sendInputEvent === 'function';
    const requireExactText = label === '视频时长' || label === '视频比例';
    const nativeClick = async (clickPos?: string): Promise<boolean> => {
      if (!canNativeClick || !clickPos) return false;
      const parts = clickPos.split(',').map((n) => Number(n));
      if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return false;
      const [x, y] = parts;
      webview.sendInputEvent!({ type: 'mouseMove', x, y });
      webview.sendInputEvent!({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await sleep(35);
      webview.sendInputEvent!({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      return true;
    };

    // 操作前确保配置栏可见
    await ensureVideoConfigBar();
    await sleep(200);

    // ---- 第一步：找到并点击触发按钮（点击右边缘 = 下拉箭头区域） ----
    const triggerCode = `
      (function() {
        try {
          var triggerTexts = ${JSON.stringify(triggerTexts)};
          var triggerLabel = ${JSON.stringify(label)};
          var useNativeClick = ${JSON.stringify(canNativeClick)};
          var viewportH = window.innerHeight;
          var candidates = [];

          // 视频配置控件位于编辑器底部，优先只接受真实按钮，避免把聊天正文中
          // 包含“比”“s”等字符的文本误判为下拉触发器。
          var allClickable = document.querySelectorAll('button, [role="button"]');
          for (var i = 0; i < allClickable.length; i++) {
            var el = allClickable[i];
            if (el.offsetParent === null) continue;
            var rect = el.getBoundingClientRect();
            if (rect.width < 20 || rect.height < 20) continue;
            if (rect.top < viewportH * 0.55 || rect.left < window.innerWidth * 0.2) continue;
            var text = (el.innerText || '').trim();
            if (!text || text.length > 30) continue;

            var matched = false;
            for (var t = 0; t < triggerTexts.length; t++) {
              var trigger = triggerTexts[t];
              if (${JSON.stringify(requireExactText)}
                ? text.replace(/\\s+/g, '') === trigger.replace(/\\s+/g, '')
                : text.indexOf(trigger) >= 0) {
                matched = true;
                break;
              }
            }
            if (!matched) continue;

            if (el.tagName === 'TEXTAREA' || el.contentEditable === 'true') continue;
            if (rect.width > 300) continue;

            var bottomScore = rect.top > viewportH * 0.7 ? 100 : 0;
            var sizeScore = rect.width * rect.height < 10000 ? 50 : 0;
            var exactScore = triggerTexts.some(function(trigger) {
              return text.replace(/\\s+/g, '') === trigger.replace(/\\s+/g, '');
            }) ? 300 : 0;
            candidates.push({ el: el, text: text, score: 1000 + exactScore + bottomScore + sizeScore, rect: rect });
          }

          if (candidates.length === 0) return { ok: false, error: '未找到触发按钮' };

          candidates.sort(function(a, b) { return b.score - a.score; });
          var best = candidates[0];
          var r = best.rect;

          // 点击右边缘（下拉箭头通常在按钮右侧）
          var isModelTrigger = triggerLabel.indexOf('模型') >= 0 || triggerLabel.toLowerCase().indexOf('model') >= 0;
          var clickX = isModelTrigger ? (r.left + r.width / 2) : (r.right - 8);
          var clickY = r.top + r.height / 2;

          // 用 MouseEvent 模拟精确位置点击
          if (!useNativeClick) {
            var evt1 = new MouseEvent('mousedown', {
              bubbles: true, cancelable: true, view: window,
              clientX: clickX, clientY: clickY, button: 0
            });
            var evt2 = new MouseEvent('mouseup', {
              bubbles: true, cancelable: true, view: window,
              clientX: clickX, clientY: clickY, button: 0
            });
            var evt3 = new MouseEvent('click', {
              bubbles: true, cancelable: true, view: window,
              clientX: clickX, clientY: clickY, button: 0
            });
            best.el.dispatchEvent(evt1);
            best.el.dispatchEvent(evt2);
            best.el.dispatchEvent(evt3);
          }

          return {
            ok: true, text: best.text,
            pos: Math.round(r.left) + ',' + Math.round(r.top),
            clickPos: Math.round(clickX) + ',' + Math.round(clickY)
          };
        } catch(e) {
          return { ok: false, error: e.message };
        }
      })()
    `;

    // 先拍点击前快照（所有包含选项关键词的可见元素）
    const snapshotBefore = await safeExecuteJS<string[]>(
      webview,
      `(function(){
        try {
          var optTexts = ${JSON.stringify(optionTexts)};
          var result = [];
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var r = el.getBoundingClientRect();
            if (r.width < 10 || r.height < 10) continue;
            var text = (el.innerText || '').trim();
            if (!text || text.length > 60 || text.length < 2) continue;
            for (var j = 0; j < optTexts.length; j++) {
              if (text.indexOf(optTexts[j]) >= 0 || optTexts[j].indexOf(text) >= 0) {
                result.push(text.substring(0, 40));
                break;
              }
            }
          }
          return result.slice(0, 50);
        } catch(e) { return []; }
      })()`,
      3000,
      `snapshot_before_${label}`
    ).catch(() => []);

    const triggerResult = await safeExecuteJS<{ ok: boolean; text?: string; pos?: string; clickPos?: string; error?: string }>(
      webview, triggerCode, 3000, `trigger_${label}`
    );

    if (!triggerResult.ok) {
      console.warn(`[doubaoBridge] ${label} 触发按钮未找到:`, triggerResult.error, triggerTexts);
    } else {
      console.log(`[doubaoBridge] 已点击${label}触发按钮: "${triggerResult.text}", pos: ${triggerResult.pos}, clickPos: ${triggerResult.clickPos}`);
      if (await nativeClick(triggerResult.clickPos)) {
        console.log(`[doubaoBridge] ${label} 已发送真实鼠标点击: ${triggerResult.clickPos}`);
      }
      await sleep(1500); // 等待下拉/面板展开
    }

    // ---- 第二步：查找并点击选项 ----
    const optionCode = `
      (function() {
        try {
          var optionTexts = ${JSON.stringify(optionTexts)};
          var requireExactText = ${JSON.stringify(requireExactText)};
          var snapBefore = ${JSON.stringify(snapshotBefore)};
          var useNativeClick = ${JSON.stringify(canNativeClick)};
          var snapMap = {};
          for (var sb = 0; sb < snapBefore.length; sb++) {
            snapMap[snapBefore[sb]] = true;
          }

          var optLow = [];
          for (var k = 0; k < optionTexts.length; k++) {
            optLow.push(optionTexts[k].toLowerCase());
          }

          function textMatch(text) {
            var t = (text || '').trim();
            if (!t) return false;
            if (requireExactText) {
              var normalized = t.replace(/\\s+/g, '');
              for (var exactIndex = 0; exactIndex < optionTexts.length; exactIndex++) {
                if (normalized === optionTexts[exactIndex].replace(/\\s+/g, '')) return true;
              }
              return false;
            }
            var tl = t.toLowerCase();
            for (var m = 0; m < optionTexts.length; m++) {
              if (t === optionTexts[m] || tl === optLow[m]) return true;
              if (t.indexOf(optionTexts[m]) >= 0 || tl.indexOf(optLow[m]) >= 0) return true;
            }
            return false;
          }

          function isVisible(el) {
            if (!el) return false;
            var r = el.getBoundingClientRect();
            if (r.width < 10 || r.height < 10) return false;
            if (r.top > window.innerHeight + 200 || r.bottom < -200) return false;
            if (r.left > window.innerWidth + 100 || r.right < -100) return false;
            return true;
          }

          function tryClick(el, text) {
            if (!el || !isVisible(el)) return false;
            var rect = el.getBoundingClientRect();
            if (!useNativeClick) el.click();
            return {
              ok: true,
              text: (text || el.innerText || '').trim().substring(0, 50),
              tag: el.tagName,
              pos: Math.round(rect.left) + ',' + Math.round(rect.top),
              clickPos: Math.round(rect.left + rect.width / 2) + ',' + Math.round(rect.top + rect.height / 2)
            };
          }

          // ---- 策略A：点击后新出现的元素（最可能是下拉选项） ----
          var newCandidates = [];
          var allElems = document.querySelectorAll('*');
          for (var i = 0; i < allElems.length; i++) {
            var el = allElems[i];
            if (!isVisible(el)) continue;
            var childCount = el.children ? el.children.length : 0;
            if (childCount > 10) continue; // 跳过容器
            var text = (el.innerText || '').trim();
            if (!text || text.length > 60 || text.length < 2) continue;
            if (!textMatch(text)) continue;
            var shortText = text.substring(0, 40);
            // 点击前不存在的元素 = 新出现的
            if (!snapMap[shortText]) {
              var r = el.getBoundingClientRect();
              newCandidates.push({ el: el, text: text, rect: r, area: r.width * r.height });
            }
          }
          if (newCandidates.length > 0) {
            // 选面积最小的（选项通常比容器小），排除按钮本身
            newCandidates.sort(function(a, b) { return a.area - b.area; });
            for (var nc = 0; nc < newCandidates.length; nc++) {
              var res = tryClick(newCandidates[nc].el, newCandidates[nc].text);
              if (res && res.ok) return res;
            }
          }

          // ---- 策略B：标准选项选择器 ----
          var sels1 = '[role="option"], [role="menuitem"], div[class*="option"], div[class*="item"], li[class*="option"], li[class*="item"], [class*="popover"] button, [class*="dropdown"] *';
          var all1 = document.querySelectorAll(sels1);
          for (var i1 = 0; i1 < all1.length; i1++) {
            var el1 = all1[i1];
            if (!isVisible(el1)) continue;
            var text1 = (el1.innerText || '').trim();
            if (!text1 || text1.length > 60) continue;
            if (textMatch(text1)) {
              var r1 = tryClick(el1, text1);
              if (r1) return r1;
            }
          }

          // ---- 策略C：TreeWalker 全文匹配 ----
          var candidates = [];
          var tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
            acceptNode: function(node) {
              var tag = node.tagName;
              if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
              var childCount = node.children ? node.children.length : 0;
              if (childCount > 5) return NodeFilter.FILTER_SKIP;
              var txt = (node.innerText || '').trim();
              if (!txt || txt.length > 60 || txt.length < 2) return NodeFilter.FILTER_SKIP;
              if (!textMatch(txt)) return NodeFilter.FILTER_SKIP;
              if (!isVisible(node)) return NodeFilter.FILTER_SKIP;
              return NodeFilter.FILTER_ACCEPT;
            }
          });
          var node;
          while ((node = tw.nextNode())) {
            candidates.push(node);
            if (candidates.length > 30) break;
          }

          if (candidates.length > 0) {
            var viewportH = window.innerHeight;
            var scored = candidates.map(function(el) {
              var r = el.getBoundingClientRect();
              var area = r.width * r.height;
              var sizeScore = area > 200 && area < 50000 ? 100 : 0;
              var posScore = r.top > viewportH * 0.2 && r.top < viewportH * 0.95 ? 50 : 0;
              return { el: el, score: sizeScore + posScore, area: area, rect: r };
            });
            scored.sort(function(a, b) { return b.score - a.score || a.area - b.area; });
            var best = scored[0];
            return tryClick(best.el, (best.el.innerText || '').trim());
          }

          // ---- 诊断：收集视口中下部所有可见文本元素 ----
          var diag = [];
          var diagTw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
            acceptNode: function(node) {
              var tag = node.tagName;
              if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
              var childCount = node.children ? node.children.length : 0;
              if (childCount > 3) return NodeFilter.FILTER_SKIP;
              var txt = (node.innerText || '').trim();
              if (!txt || txt.length > 30 || txt.length < 1) return NodeFilter.FILTER_SKIP;
              var r = node.getBoundingClientRect();
              if (r.width < 10 || r.height < 10) return NodeFilter.FILTER_SKIP;
              if (r.top < 100 || r.top > window.innerHeight + 100) return NodeFilter.FILTER_SKIP;
              if (r.left < 50 || r.left > window.innerWidth - 50) return NodeFilter.FILTER_SKIP;
              return NodeFilter.FILTER_ACCEPT;
            }
          });
          var dnode;
          var dcount = 0;
          while ((dnode = diagTw.nextNode()) && dcount < 40) {
            var dr = dnode.getBoundingClientRect();
            diag.push(dnode.tagName + '|' + (dnode.innerText || '').trim().substring(0, 25) + '|' + Math.round(dr.left) + ',' + Math.round(dr.top));
            dcount++;
          }
          return { ok: false, diag: diag.join('; ') };
        } catch(e) {
          return { ok: false, error: e.message };
        }
      })()
    `;

    const optionResult = await safeExecuteJS<{ ok: boolean; text?: string; tag?: string; pos?: string; clickPos?: string; error?: string; diag?: string }>(
      webview, optionCode, 6000, `select_${label}`
    );

    if (optionResult.ok) {
      console.log(`[doubaoBridge] 已选择${label}: "${optionResult.text}", tag: ${optionResult.tag}, pos: ${optionResult.pos}`);
      if (await nativeClick(optionResult.clickPos)) {
        console.log(`[doubaoBridge] ${label} 选项已发送真实鼠标点击: ${optionResult.clickPos}`);
      }
      await sleep(300);
      // 选择后重新确保配置栏可见
      await ensureVideoConfigBar();
      return true;
    }

    const isModelLabel = label.indexOf('模型') >= 0 || label.toLowerCase().indexOf('model') >= 0;
    if (isModelLabel && triggerResult.ok) {
      const targetIndex = optionTexts.some((t) => /fast/i.test(t)) ? 1 : optionTexts.some((t) => /mini/i.test(t)) ? 2 : 0;
      type ModelFallbackResult = { ok: boolean; clickPos?: string; optionPos?: string; triggerText?: string; error?: string };
      const fallbackOpen: ModelFallbackResult = await safeExecuteJS<ModelFallbackResult>(
        webview,
        `
          (function() {
            try {
              var targetIndex = ${JSON.stringify(targetIndex)};
              function visible(el) {
                if (!el) return false;
                var r = el.getBoundingClientRect();
                return r.width > 20 && r.height > 20 && r.top > window.innerHeight * 0.45 && r.bottom < window.innerHeight + 20;
              }
              function fire(el, x, y) {
                var target = document.elementFromPoint(x, y) || el;
                var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
                try { el.focus && el.focus(); } catch(e) {}
                try { target.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts))); } catch(e) {}
                try { target.dispatchEvent(new MouseEvent('mousedown', opts)); } catch(e) {}
                try { target.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts))); } catch(e) {}
                try { target.dispatchEvent(new MouseEvent('mouseup', opts)); } catch(e) {}
                try { target.dispatchEvent(new MouseEvent('click', opts)); } catch(e) {}
              }
              var all = Array.from(document.querySelectorAll('button, [role="button"], div'));
              var candidates = [];
              for (var i = 0; i < all.length; i++) {
                var el = all[i];
                if (!visible(el)) continue;
                var text = (el.innerText || '').trim();
                if (!text || text.length > 35) continue;
                if (text.indexOf('模型') < 0) continue;
                var r = el.getBoundingClientRect();
                if (r.width > 260) continue;
                var score = (el.tagName === 'BUTTON' ? 100 : 0) + (text.indexOf('Mini') >= 0 || text.indexOf('Fast') >= 0 || text.indexOf('2.0') >= 0 ? 60 : 0) + (r.top > window.innerHeight * 0.7 ? 40 : 0);
                candidates.push({ el: el, rect: r, text: text, score: score });
              }
              if (!candidates.length) return { ok: false, error: 'model trigger not found' };
              candidates.sort(function(a, b) { return b.score - a.score; });
              var best = candidates[0];
              var r = best.rect;

              var points = [
                [r.right - 12, r.top + r.height / 2],
                [r.left + r.width / 2, r.top + r.height / 2],
                [r.left + 24, r.top + r.height / 2]
              ];
              for (var p = 0; p < points.length; p++) {
                fire(best.el, points[p][0], points[p][1]);
              }

              var optionX = Math.round(r.left + Math.min(Math.max(r.width * 0.75, 100), 170));
              var rowCentersFromTriggerTop = [-190, -120, -50];
              var optionY = Math.round(r.top + rowCentersFromTriggerTop[targetIndex]);
              optionY = Math.max(80, Math.min(window.innerHeight - 40, optionY));
              return {
                ok: true,
                triggerText: best.text,
                clickPos: Math.round(r.right - 12) + ',' + Math.round(r.top + r.height / 2),
                optionPos: optionX + ',' + optionY
              };
            } catch(e) {
              return { ok: false, error: e.message };
            }
          })()
        `,
        4000,
        `model_fallback_open_${label}`
      ).catch((err) => ({ ok: false, error: err.message }));

      if (fallbackOpen.ok) {
        console.log(`[doubaoBridge] ${label} 模型专用兜底已触发: "${fallbackOpen.triggerText}", optionPos=${fallbackOpen.optionPos}`);
        await sleep(900);

        const retryResult = await safeExecuteJS<{ ok: boolean; text?: string; tag?: string; pos?: string; clickPos?: string; error?: string; diag?: string }>(
          webview, optionCode, 6000, `select_${label}_fallback`
        );
        if (retryResult.ok) {
          console.log(`[doubaoBridge] 兜底已选择${label}: "${retryResult.text}", tag: ${retryResult.tag}, pos: ${retryResult.pos}`);
          if (await nativeClick(retryResult.clickPos)) {
            console.log(`[doubaoBridge] ${label} 兜底选项已发送真实鼠标点击: ${retryResult.clickPos}`);
          }
          await sleep(300);
          await ensureVideoConfigBar();
          return true;
        }

        if (await nativeClick(fallbackOpen.optionPos)) {
          console.log(`[doubaoBridge] ${label} 按截图结构点击模型选项坐标: ${fallbackOpen.optionPos}`);
          await sleep(500);
          await ensureVideoConfigBar();
          return true;
        }
      } else {
        console.warn(`[doubaoBridge] ${label} 模型专用兜底失败:`, fallbackOpen.error);
      }
    }

    if (optionResult.diag) {
      console.warn(`[doubaoBridge] ${label} 下拉诊断(可见元素):`, optionResult.diag);
    }
    console.warn(`[doubaoBridge] ${label} DOM查找失败, 候选文本:`, optionTexts);
    return false;
  };

  // 1. 选择模型
  console.log(`[doubaoBridge] 配置视频模型: ${config.model}`);
  const modelTriggers = ['模型', 'Mini', 'Fast', '2.5', '2.0'];
  if (!await selectDropdownOption(modelTriggers, modelTexts, '视频模型')) {
    throw new Error(`视频模型配置失败: ${config.model}`);
  }
  await sleep(400);

  // 2. 选择时长
  console.log(`[doubaoBridge] 配置视频时长: ${config.duration}（仅使用页面可见控件）`);
  const sliderResult = await selectDurationSlider();
  if (sliderResult === 'membership_required') {
    throw new Error(`membership_required: ${config.duration} 需要会员操作，已停止提交`);
  }
  if (sliderResult === 'not_found') {
    // 兼容尚未切换到滑杆 UI 的旧页面；仍只允许页面可见控件。
    const durationTriggers = ['4s', '5s', '10s', '15s', '30s', '时长'];
    if (!await selectDropdownOption(durationTriggers, durationTexts, '视频时长')) {
      throw new Error(`视频时长配置失败: ${config.duration}`);
    }
  }
  await sleep(300);

  // 3. 选择比例
  console.log(`[doubaoBridge] 配置视频比例: ${config.aspectRatio}`);
  if (!await selectDropdownOption(['比例'], [config.aspectRatio], '视频比例')) {
    throw new Error(`视频比例配置失败: ${config.aspectRatio}`);
  }
  await sleep(400);

  // 最后确保在视频模式且配置栏正常
  await ensureVideoConfigBar();
}

/** 新版页面显示名的唯一权威映射；禁止以 Fast/Mini 之类片段做宽松匹配。 */
export const VIDEO_MODEL_UI_LABELS: Readonly<Record<string, string>> = {
  'seedance-2.5': 'Seedance 2.5',
  'seedance-2.0': 'Seedance 2.0',
  'seedance-2.0-fast': 'Seedance 2.0 Fast',
  'seedance-2.0-mini': 'Seedance 2.0 Mini',
};

export function getVideoModelUiLabel(model: string): string | null {
  return VIDEO_MODEL_UI_LABELS[model] ?? null;
}

export function getVideoCompositeLabel(aspectRatio: string, duration: string): string {
  return `${aspectRatio} · ${duration}`;
}

/** 页面可能省略空格或使用全角符号，最终门禁按比例和时长语义比较。 */
export function matchesVideoCompositeControlText(
  text: string,
  aspectRatio: string,
  duration: string,
): boolean {
  const actual = parseVideoCompositeControlText(text);
  const expected = parseVideoCompositeControlText(getVideoCompositeLabel(aspectRatio, duration));
  return Boolean(actual && expected && actual.ratio === expected.ratio && actual.duration === expected.duration);
}

/** 将 Dola 页面上的比例别名统一为任务契约使用的 n:n 形式。 */
export function normalizeDolaAspectRatio(value: string): string {
  const compact = String(value || '')
    .normalize('NFKC')
    .replace(/[：／/×xX＊*]/g, ':')
    .replace(/\s+/g, '')
    .toLowerCase();
  const numeric = compact.match(/[0-9]+:[0-9]+/)?.[0];
  if (numeric) return numeric;
  if (/(?:横屏|landscape|宽屏|wide)/i.test(compact)) return '16:9';
  if (/(?:竖屏|portrait|窄屏|vertical)/i.test(compact)) return '9:16';
  if (/(?:方形|正方形|square)/i.test(compact)) return '1:1';
  if (/(?:自动|自适应|auto)/i.test(compact)) return '自动';
  return '';
}

/** 从 Dola 控件的标题、副标题或语义属性中提取唯一模型标签。 */
export function normalizeDolaModelLabel(value: string): string {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/^(?:模型|model)\s*[:：]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = normalized.match(/(?:dreamina\s+)?seedance\s*2\.(5|0)(?:\s*(fast|mini))?/i)
    || normalized.match(/(?:^|[^0-9])2\.(5|0)(?:\s*(fast|mini))?(?:$|[^0-9])/i);
  if (!match) return '';
  const variant = match[2] ? ` ${match[2][0].toUpperCase()}${match[2].slice(1).toLowerCase()}` : '';
  return `Seedance 2.${match[1]}${variant}`;
}

/** 从“时长 30 秒（已选）”等组合文本中提取标准 30s/10s 标签。 */
export function normalizeDolaDurationLabel(value: string): string {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/秒/g, 's')
    .replace(/\s+/g, ' ');
  return normalized.match(/(?:^|[^0-9])((?:[4-9]|1[0-5]|30)\s*s)(?:$|[^0-9])/i)?.[1]
    .replace(/\s+/g, '')
    .toLowerCase() || '';
}

/** Dola 控件异步挂载的专用硬上限；豆包及其它平台仍使用原有预算。 */
export const DOLA_VIDEO_CONTROL_READINESS_TIMEOUT_MS = 60_000;
export const DOLA_VIDEO_DURATION_SELECTION_MAX_ATTEMPTS = 3;
export const DOLA_VIDEO_DURATION_OPTION_TIMEOUT_MS = 8_000;

/** 比较 Dola 时长时忽略“视频时长/已选”等展示前后缀。 */
export function matchesDolaDurationLabel(actual: string, desired: string): boolean {
  const actualLabel = normalizeDolaDurationLabel(actual);
  const desiredLabel = normalizeDolaDurationLabel(desired);
  return Boolean(actualLabel && desiredLabel && actualLabel === desiredLabel);
}

export type KnownPopupDismissResult = 'none' | 'dismissed' | 'failed';

/**
 * 白名单清理豆包“下载电脑版”推广弹窗。
 * 只有同一容器同时包含固定标题和副标题时才允许点击，绝不关闭素材授权、验证或额度弹窗。
 */
export async function dismissKnownDesktopDownloadPromotion(
  webview: WebviewHandle,
): Promise<KnownPopupDismissResult> {
  const inspect = async (): Promise<{ present: boolean; position?: string; method?: string }> => safeExecuteJS(
    webview,
    `
      (function() {
        var normalize = function(value) { return String(value || '').replace(/\\s+/g, ' ').trim(); };
        var visible = function(el) {
          if (!el || el.offsetParent === null) return false;
          var style = window.getComputedStyle(el);
          var rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        var title = Array.from(document.querySelectorAll('h1,h2,h3,div,span')).find(function(el) {
          return visible(el) && normalize(el.innerText || el.textContent) === '下载电脑版';
        });
        if (!title) return { present: false };
        var root = title;
        for (var depth = 0; depth < 10 && root; depth += 1) {
          var text = normalize(root.innerText || root.textContent);
          if (text.indexOf('下载电脑版') >= 0 && text.indexOf('使用完整功能') >= 0) break;
          root = root.parentElement;
        }
        if (!root) return { present: false };
        var rootText = normalize(root.innerText || root.textContent);
        if (rootText.indexOf('下载电脑版') < 0 || rootText.indexOf('使用完整功能') < 0) return { present: false };
        var controls = Array.from(root.querySelectorAll('button,[role="button"],a,[aria-label],[title],div,span')).filter(visible);
        var target = controls.find(function(el) { return normalize(el.innerText || el.textContent) === '下次提醒我'; });
        var method = 'snooze';
        if (!target) {
          target = controls.find(function(el) {
            var label = normalize([el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '));
            return label === '关闭' || label === '关闭弹窗';
          });
          method = 'close';
        }
        if (!target) {
          var rootRect = root.getBoundingClientRect();
          target = controls.find(function(el) {
            var rect = el.getBoundingClientRect();
            var square = rect.width >= 24 && rect.width <= 56 && rect.height >= 24 && rect.height <= 56;
            return square && rect.right >= rootRect.right - 70 && rect.top <= rootRect.top + 70;
          });
          method = 'close-corner';
        }
        if (!target) return { present: true };
        var rect = target.getBoundingClientRect();
        return { present: true, method: method,
          position: Math.round(rect.left + rect.width / 2) + ',' + Math.round(rect.top + rect.height / 2) };
      })()
    `,
    5000,
    'inspectDesktopDownloadPromotion',
  );

  let target: { present: boolean; position?: string; method?: string };
  try {
    target = await inspect();
  } catch {
    return 'failed';
  }
  if (!target.present) return 'none';
  if (!target.position || typeof webview.sendInputEvent !== 'function') return 'failed';
  const [x, y] = target.position.split(',').map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'failed';
  try {
    webview.sendInputEvent({ type: 'mouseMove', x, y });
    webview.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(35);
    webview.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await sleep(250);
      if (!(await inspect()).present) {
        console.log(`[doubaoBridge] 已关闭下载电脑版推广弹窗: ${target.method}`);
        return 'dismissed';
      }
    }
    return 'failed';
  } catch (error: unknown) {
    console.warn('[doubaoBridge] 推广弹窗关闭失败:', getErrorMessage(error));
    return 'failed';
  }
}

/**
 * 只读检查素材授权弹窗。平台当前在用户确认后可能直接提交生成，因此这里永久
 * 禁止代点“确认”；调用方必须等待用户操作并继续回读同一个 run。
 */
export async function inspectMaterialAuthorization(
  webview: WebviewHandle,
): Promise<MaterialAuthorizationState> {
  return (await inspectMaterialAuthorizationTarget(webview)).state;
}

interface MaterialAuthorizationTarget {
  state: MaterialAuthorizationState;
  confirmPosition?: string;
  visibleAttachmentCount: number;
  pending: boolean;
}

async function inspectMaterialAuthorizationTarget(webview: WebviewHandle): Promise<MaterialAuthorizationTarget> {
  try {
    const snapshot = await safeExecuteJS<{
      title: string; body: string; actions: string[]; confirmPosition?: string;
      visibleAttachmentCount: number; pending: boolean;
    }>(webview, `
      (function () {
        var visible = function (el) {
          var r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 20 && el.offsetParent !== null;
        };
        var buttons = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible);
        var actionButtons = buttons.filter(function (el) {
          var text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
          return text === '确认' || text === '拒绝';
        });
        var root = actionButtons[0] || null;
        var matched = null;
        for (var depth = 0; root && depth < 10; depth++, root = root.parentElement) {
          var text = (root.innerText || '').replace(/\\s+/g, ' ').trim();
          if (text.indexOf('安全确认') !== -1 && text.length < 1200) {
            matched = root;
            break;
          }
        }
        var pageText = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
        var attachments = Array.from(document.querySelectorAll('img,[class*="thumb"],[class*="preview"],[class*="attachment"],[class*="upload-item"]')).filter(visible);
        var pending = ${buildUploadPendingProbe(buildComposerRootProbe())};
        if (!matched && pageText.indexOf('安全确认') === -1 &&
            pageText.indexOf('上传、使用的素材') === -1) {
          return { title: '', body: '', actions: [], visibleAttachmentCount: attachments.length, pending: pending };
        }
        var body = matched ? (matched.innerText || '') : pageText;
        var scopedButtons = actionButtons
          .filter(function (el) { return !matched || matched.contains(el); })
        var actions = scopedButtons.map(function (el) { return (el.innerText || '').replace(/\\s+/g, ' ').trim(); });
        var confirm = scopedButtons.find(function (el) { return (el.innerText || '').replace(/\\s+/g, ' ').trim() === '确认'; });
        var rect = confirm ? confirm.getBoundingClientRect() : null;
        return {
          title: body.indexOf('安全确认') !== -1 ? '安全确认' : '',
          body: body,
          actions: actions,
          confirmPosition: rect ? (Math.round(rect.left + rect.width / 2) + ',' + Math.round(rect.top + rect.height / 2)) : undefined,
          visibleAttachmentCount: attachments.length,
          pending: pending,
        };
      })()
    `, 5000, 'inspect_material_authorization');
    return {
      state: classifyMaterialAuthorizationSnapshot(snapshot),
      confirmPosition: snapshot.confirmPosition,
      visibleAttachmentCount: snapshot.visibleAttachmentCount,
      pending: snapshot.pending,
    };
  } catch {
    return { state: 'blocked', visibleAttachmentCount: 0, pending: true };
  }
}

export interface MaterialAuthorizationConfirmResult {
  status: 'confirmed' | 'not_allowed' | 'uncertain';
  reason?: string;
  fingerprint?: 'doubao-material-authorization-v1';
  detectedAt: string;
  clickedAt?: string;
  verifiedAt?: string;
}

/** 精确白名单的单次原生点击；点击后只回读，不做任何提交补偿。 */
export async function confirmMaterialAuthorizationIfAllowed(
  webview: WebviewHandle,
  input: { enabled: boolean; expectedConversationUrl: string; assetsValidated: boolean },
): Promise<MaterialAuthorizationConfirmResult> {
  const detectedAt = new Date().toISOString();
  const before = await inspectMaterialAuthorizationTarget(webview);
  const decision = decideMaterialAuthorizationAutoConfirm({
    enabled: input.enabled,
    state: before.state,
    currentUrl: webview.getURL(),
    expectedConversationUrl: input.expectedConversationUrl,
    assetsValidated: input.assetsValidated,
    confirmPosition: before.confirmPosition,
  });
  if (!decision.allowed) return { status: 'not_allowed', reason: decision.reason, detectedAt };
  if (typeof webview.sendInputEvent !== 'function') {
    return { status: 'not_allowed', reason: 'native_input_unavailable', detectedAt, fingerprint: decision.fingerprint };
  }
  const [x, y] = before.confirmPosition!.split(',').map(Number);
  const clickedAt = new Date().toISOString();
  webview.sendInputEvent({ type: 'mouseMove', x, y });
  webview.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await sleep(35);
  webview.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(250);
    const after = await inspectMaterialAuthorizationTarget(webview);
    if (after.state === 'absent') {
      const sameConversation = webview.getURL() === input.expectedConversationUrl;
      const attachmentStable = after.visibleAttachmentCount === before.visibleAttachmentCount;
      return {
        status: sameConversation && attachmentStable ? 'confirmed' : 'uncertain',
        reason: sameConversation ? (attachmentStable ? undefined : 'attachment_count_changed') : 'conversation_changed',
        fingerprint: decision.fingerprint,
        detectedAt,
        clickedAt,
        verifiedAt: new Date().toISOString(),
      };
    }
  }
  return { status: 'uncertain', reason: 'dialog_still_present', fingerprint: decision.fingerprint, detectedAt, clickedAt };
}

/**
 * 只读识别平台的“视频生成参数确认”回复。返回结构化摘要，不返回完整会话文本，
 * 更不会点击或回复“确认”。
 */
export async function inspectGenerationConfirmation(
  webview: WebviewHandle,
): Promise<GenerationConfirmationEvidence> {
  try {
    const text = await safeExecuteJS<string>(webview, `
      (function () {
        function visible(el) {
          var r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 12 && el.offsetParent !== null;
        }
        var selectors = '[data-message-id],[data-testid*="message"],[class*="message"],[class*="bubble"]';
        var candidates = Array.from(document.querySelectorAll(selectors)).filter(visible).map(function (node) {
          return (node.innerText || '').replace(/\\s+/g, ' ').trim();
        }).filter(function (value) {
          return value.length > 0 && value.length < 3000 &&
            (/视频生成参数确认/.test(value) || /确认后.{0,16}(?:开始|进行|为你)?生成视频/.test(value) || /回复[“"']?确认[”"']?.{0,16}生成/.test(value));
        });
        return candidates.length ? candidates[candidates.length - 1] : '';
      })()
    `, 5000, 'inspect_generation_confirmation');
    return classifyGenerationConfirmationText(text);
  } catch {
    return { state: 'unknown', detectedAt: new Date().toISOString() };
  }
}

/** 豆包 2026-08 创作栏稳定结构属性；文本定位仅作为受限回退。 */
export const VIDEO_MODEL_CONTROL_SELECTOR = '[data-input-engine-actionbar-control-key="video-model"]';
export const VIDEO_COMPOSITE_CONTROL_SELECTOR = '[data-creation-params-panel-id]';

export async function pollUntilReady(
  check: () => boolean | Promise<boolean>,
  options: {
    timeoutMs: number;
    intervalMs?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = now() + options.timeoutMs;
  do {
    if (await check()) return true;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await wait(Math.min(intervalMs, remaining));
  } while (now() <= deadline);
  return false;
}

export function isVideoModelControlText(text: string, expectedModel: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.startsWith('模型 ') && normalized.slice(3).trim() === expectedModel;
}

export function isVideoCompositeControlText(text: string): boolean {
  return parseVideoCompositeControlText(text) !== null;
}

/**
 * Dola 创作栏适配器。
 *
 * Dola 与豆包使用不同的 DOM 属性：它的控件通常只显示为“模型 2.5 / 10s /
 * 比例”，没有豆包的 data-input-engine-actionbar-control-key 和
 * data-creation-params-panel-id。这里仍然只查找、点击和回读页面上可见的
 * 控件，不改写请求，也不直接提交生成。
 */
async function configureDolaVideoOptions(
  webview: WebviewHandle,
  config: { model: string; duration: string; aspectRatio: string },
  options?: {
    onReadiness?: (result: VideoControlReadinessResult) => void | Promise<void>;
  },
): Promise<void> {
  const durationSeconds = Number.parseInt(config.duration.replace(/s$/i, ''), 10);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 4 || durationSeconds > 30 ||
      !/^(?:auto|[0-9]+:[0-9]+)$/i.test(config.aspectRatio)) {
    throw new Error('Dola 视频配置无效，已在提交前停止');
  }

  const modelAliases: string[] = {
    'seedance-2.5': ['Dreamina Seedance 2.5', '2.5', 'Seedance 2.5', 'Seedance2.5'],
    'seedance-2.0': ['Dreamina Seedance 2.0', '2.0', 'Seedance 2.0', 'Seedance2.0'],
    'seedance-2.0-fast': ['Dreamina Seedance 2.0 Fast', '2.0 Fast', 'Seedance 2.0 Fast', 'Seedance2.0Fast', 'Fast'],
    'seedance-2.0-mini': ['Dreamina Seedance 2.0 Mini', '2.0 Mini', 'Seedance 2.0 Mini', 'Seedance2.0Mini', 'Mini'],
  }[config.model] || [config.model];
  const desiredDuration = `${durationSeconds}s`;
  const desiredRatio = config.aspectRatio.toLowerCase() === 'auto' ? '自动' : config.aspectRatio;
  const page = async <T>(code: string, label: string): Promise<T> =>
    safeExecuteJS<T>(webview, code, 5000, label);

  const readSnapshot = async (): Promise<{
    model: string;
    duration: string;
    ratio: string;
    moreAvailable: boolean;
    controlText: string;
    composerText: string;
    modelReady: boolean;
    compositeReady: boolean;
  }> => page<{
    model: string;
    duration: string;
    ratio: string;
    moreAvailable: boolean;
    controlText: string;
    composerText: string;
    modelReady: boolean;
    compositeReady: boolean;
  }>(`
    (function () {
      function visible(el) {
        if (!el) return false;
        var r = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight &&
          style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }
      // 该函数运行在页面注入脚本的独立作用域中，不能依赖外层
      // findMoreControl() 的同名实现；否则 readSnapshot 会直接抛异常。
      function clickable(el) {
        return el && (
          el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' ||
          el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded') ||
          (typeof el.tabIndex === 'number' && el.tabIndex >= 0)
        );
      }
      function textOf(el) {
        var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        // Dola 2.0 Fast 在部分布局把当前比例放在 aria-label/title，
        // 可见文本只显示“画面比例”；回读时合并这些稳定语义属性。
        var attrs = ['aria-label', 'title', 'data-testid', 'data-action', 'data-value', 'data-ratio'].map(function (name) {
          try { return el.getAttribute(name) || ''; } catch (_) { return ''; }
        }).filter(Boolean);
        try {
          var descendants = Array.from(el.querySelectorAll ? el.querySelectorAll('[data-ratio],[data-value],[aria-label],[title]') : []);
          descendants.slice(0, 8).forEach(function (child) {
            ['data-ratio', 'data-value', 'aria-label', 'title'].forEach(function (name) {
              var value = child.getAttribute && child.getAttribute(name);
              if (value) attrs.push(value);
            });
          });
        } catch (_) {}
        return [text].concat(attrs).join(' ').replace(/\\s+/g, ' ').trim();
      }
      function cleanLabel(value) {
        return String(value || '').normalize('NFKC').replace(/：/g, ':').replace(/[﹒•⋅]/g, '·').replace(/秒/g, 's').replace(/\\s+/g, ' ').trim();
      }
      function compactLabel(value) { return cleanLabel(value).replace(/\\s+/g, ''); }
      function modelFromLabel(value) {
        var normalized = cleanLabel(value).replace(/^(?:模型|model)\\s*[:：]?\\s*/i, '');
        var match = normalized.match(/(?:dreamina\\s+)?seedance\\s*2\\.(5|0)(?:\\s*(fast|mini))?/i)
          || normalized.match(/(?:^|[^0-9])2\\.(5|0)(?:\\s*(fast|mini))?(?:$|[^0-9])/i);
        if (!match) return '';
        var variant = match[2] ? ' ' + match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase() : '';
        return 'Seedance 2.' + match[1] + variant;
      }
      function ratioFromLabel(value) {
        var compact = compactLabel(value).replace(/[／/×xX＊*]/g, ':');
        var match = compact.match(/(?:自动|自适应|auto|[0-9]+:[0-9]+)/i);
        if (match) {
          var token = match[1] || match[0];
          if (/(?:横屏|landscape|宽屏|wide)/i.test(compact)) return '16:9';
          if (/(?:竖屏|portrait|窄屏|vertical)/i.test(compact)) return '9:16';
          if (/(?:方形|正方形|square)/i.test(compact)) return '1:1';
          return /^(?:自适应|auto)$/i.test(token) ? '自动' : token;
        }
        if (/(?:横屏|landscape|宽屏|wide)/i.test(compact)) return '16:9';
        if (/(?:竖屏|portrait|窄屏|vertical)/i.test(compact)) return '9:16';
        if (/(?:方形|正方形|square)/i.test(compact)) return '1:1';
        return '';
      }
      function durationFromLabel(value) {
        var compact = compactLabel(value);
        var match = compact.match(/(?:^|[^0-9])((?:[4-9]|1[0-5]|30)s)(?:$|[^0-9])/i);
        return match ? match[1].toLowerCase() : '';
      }
      function popupLike(el) {
        var node = el;
        for (var depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
          var role = (node.getAttribute('role') || '').toLowerCase();
          var marker = [node.id || '', node.className || '', node.getAttribute('data-testid') || '', node.getAttribute('data-state') || '']
            .join(' ').toLowerCase();
          if (role === 'menu' || role === 'listbox' || role === 'option' || role === 'menuitem' ||
              /(?:dropdown|popover|popup|menu|listbox|option-list|select-panel)/i.test(marker)) return true;
        }
        return false;
      }
      function selected(el) {
        var node = el;
        for (var depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
          var explicit = [
            node.getAttribute('aria-selected'), node.getAttribute('aria-checked'),
            node.getAttribute('data-selected'), node.getAttribute('data-checked'),
            node.getAttribute('data-state'), node.getAttribute('aria-current'),
            node.getAttribute('aria-pressed'), node.getAttribute('data-active'),
            node.getAttribute('data-current')
          ].filter(Boolean).map(function (value) { return String(value).toLowerCase(); });
          if (explicit.some(function (value) { return /^(?:true|selected|checked|active|current|on)$/.test(value); })) return true;
          var className = typeof node.className === 'string' ? node.className : '';
          var tokens = className.toLowerCase().split(/[\\s_-]+/).filter(Boolean);
          if (tokens.some(function (token) { return /^(?:selected|checked|active|current|on)$/.test(token); }) &&
              !/(?:not|unselected|unchecked|inactive)/i.test(className)) return true;
        }
        return false;
      }
      function isLeafLabel(el, text) {
        return !Array.from(el.children || []).some(function (child) { return textOf(child) === text; });
      }
      function stableControl(key) {
        var selector = '[data-input-engine-actionbar-control-key="' + key + '"]';
        return Array.from(document.querySelectorAll(selector)).find(function (el) { return visible(el); }) || null;
      }
      // Dola 的模型/时长/比例按钮和编辑器通常是同级节点，不能只从
      // contenteditable 的某一个祖先容器读取；该容器有时只包含占位符。
      // 以页面底部可见控件为候选，并优先读取最小的叶子标签，避免把整页
      // 文本误当成“模型控件”。
      var controls = Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],[role="option"],li,[data-ratio],[data-value],div,span,svg'))
        .filter(visible)
        .map(function (el) { return { el: el, rect: el.getBoundingClientRect(), text: textOf(el) }; })
        .filter(function (item) {
          return item.rect.top > window.innerHeight * 0.35 && item.text.length > 0 && item.text.length < 100 && isLeafLabel(item.el, item.text);
        });
      var labels = controls.map(function (item) { return cleanLabel(item.text); });
      // Dola 两种布局共用稳定 action-bar 键；优先读取真实控件，
      // 文本扫描只作为旧版/实验布局的兼容回退。
      var stableModelControl = stableControl('video-model');
      var stableDurationControl = stableControl('video-duration');
      var stableRatioControl = stableControl('video-ratio');
      var model = stableModelControl
        ? modelFromLabel(textOf(stableModelControl))
        : labels.map(modelFromLabel).find(Boolean) || '';
      var duration = stableDurationControl ? durationFromLabel(textOf(stableDurationControl)) : '';
      var ratio = '';
      if (!duration) {
        labels.some(function (value) {
          if (!duration) duration = durationFromLabel(value);
          return Boolean(duration);
        });
      }
      var ratioItems = controls.filter(function (item) { return Boolean(ratioFromLabel(item.text)); });
      // 弹层展开时不能把第一个选项（通常是 1:1）误当成当前比例。
      // 优先读取弹层里带明确 selected/checked/active 标记的选项；
      // 弹层关闭后再读取输入栏自身的比例触发器。
      var selectedRatioItem = ratioItems.find(function (item) {
        return popupLike(item.el) && selected(item.el);
      });
      // 只把输入栏 action-bar 中的比例触发器当作“当前比例”。页面底部
      // 的历史卡片、说明文字也可能包含 16:9，不能仅凭“非弹层”放行。
      var directRatioItem = stableRatioControl
        ? { el: stableRatioControl, rect: stableRatioControl.getBoundingClientRect(), text: textOf(stableRatioControl) }
        : ratioItems.find(function (item) {
          return !popupLike(item.el) && item.rect.top > window.innerHeight * 0.5;
        });
      ratio = selectedRatioItem
        ? ratioFromLabel(selectedRatioItem.text)
        : directRatioItem
          ? ratioFromLabel(directRatioItem.text)
          : '';
      var hasRatioControl = labels.some(function (value) {
        return /^(?:画面比例|比例|画幅|宽高比|aspect ratio)$/i.test(value) || Boolean(ratioFromLabel(value));
      }) || Boolean(stableRatioControl);
      var editors = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"],input')).filter(visible);
      var editorRect = editors.length ? editors[0].getBoundingClientRect() : null;
      var sendNode = document.querySelector('#flow-end-msg-send');
      var sendRect = sendNode && visible(sendNode) ? sendNode.getBoundingClientRect() : null;
      var durationNodes = controls.filter(function (item) {
        return Boolean(durationFromLabel(item.text));
      });
      var durationRect = durationNodes.length
        ? durationNodes[durationNodes.length - 1].rect
        : null;
      function descriptor(el) {
        var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        var attrs = ['aria-label', 'title', 'data-testid', 'data-action', 'data-name', 'data-value', 'data-ratio', 'id', 'class'].map(function (name) {
          try { return el.getAttribute(name) || ''; } catch (_) { return ''; }
        }).filter(Boolean);
        return [text].concat(attrs).join(' ').replace(/\\s+/g, ' ').trim();
      }
      function isMoreDescriptor(value) {
        var normalized = String(value || '').normalize('NFKC').replace(/\\s+/g, '').toLowerCase();
        return /^(?:更多(?:选项|设置)?|more(?:options?)?|\\.{3}|…|⋯|•••|⋮)$/i.test(normalized) ||
          /(?:overflow|ellipsis|action-more|more-menu)/i.test(normalized);
      }
      function visibleLabel(el) {
        return String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, '').trim();
      }
      function hasIconOnly(el) {
        if (!el || visibleLabel(el)) return false;
        var tagName = String(el.tagName || '').toLowerCase();
        var className = typeof el.className === 'string' ? el.className : '';
        return tagName === 'svg' || el.hasAttribute('data-icon') || /(?:^|[\\s_-])icon(?:[\\s_-]|$)/i.test(className) ||
          Boolean(el.querySelector && el.querySelector('svg,[data-icon],i,[class*="icon"]'));
      }
      function isActionBarLike(el) {
        if (!el) return false;
        var rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.5 || rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
        if (editorRect && rect.top < editorRect.top - 180) return false;
        var node = el;
        for (var depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
          var marker = [node.id || '', node.className || '', node.getAttribute('data-testid') || '',
            node.getAttribute('data-action') || '', node.getAttribute('role') || ''].join(' ').toLowerCase();
          if (/(?:action.?bar|composer|creation.?bar|input.?bar|toolbar|footer)/i.test(marker)) return true;
        }
        // 某些 Dola 版本没有稳定的容器标记；底部同一横向带仍是安全的
        // 几何边界，后续还会要求它位于时长右侧、发送按钮左侧。
        return true;
      }
      // 2.0 Fast 的“…”按钮有些版本只有 SVG，没有 innerText/aria-label。
      // 仅在底部输入栏、时长控件右侧且发送按钮左侧接受这种无文字弹出入口，
      // 避免把侧栏或消息卡片里的省略号误判为比例入口。
      var moreCandidates = Array.from(document.querySelectorAll('button,[role="button"],[aria-haspopup],[aria-expanded],[tabindex],[data-action],[data-testid],[title],[data-icon],[class*="more"],[class*="More"],[class*="ellipsis"],[class*="overflow"]'))
        .filter(visible);
      var actionButtons = moreCandidates.filter(function (el) {
        return isActionBarLike(el) && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button');
      });
      var inferredSendRect = sendRect;
      if (!inferredSendRect) {
        var rightmostButton = actionButtons.slice().sort(function (a, b) {
          return b.getBoundingClientRect().right - a.getBoundingClientRect().right;
        })[0];
        inferredSendRect = rightmostButton ? rightmostButton.getBoundingClientRect() : null;
      }
      var moreAvailable = moreCandidates.some(function (el) {
        var rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.5 || (editorRect && rect.top < editorRect.top - 180)) return false;
        var value = descriptor(el);
        var normalized = value.normalize('NFKC').replace(/\\s+/g, '').toLowerCase();
        var isSend = el.id === 'flow-end-msg-send' || /(?:发送|send|submit)/i.test(normalized);
        if (isSend) return false;
        var semanticValues = [el.innerText || '', el.textContent || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.getAttribute('data-testid') || '', el.getAttribute('data-action') || '', el.getAttribute('data-name') || '', el.getAttribute('id') || '', el.getAttribute('class') || ''];
        var semantic = semanticValues.some(function (item) { return isMoreDescriptor(item); });
        var popupTrigger = el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('aria-expanded') !== null;
        var square = rect.width >= 20 && rect.width <= 72 && rect.height >= 20 && rect.height <= 72 && Math.abs(rect.width - rect.height) < 24;
        var rightOfDuration = !durationRect || rect.left > durationRect.right - 4;
        var leftOfSend = !inferredSendRect || rect.right < inferredSendRect.left - 4;
        var iconOnly = hasIconOnly(el) || /^\\.{3}$|^…$|^⋯$|^•••$|^⋮$/.test(visibleLabel(el));
        // 无文字 SVG 入口必须有右侧的提交按钮（或明确的弹出语义），
        // 这样不会把唯一的发送图标误判成“更多”。
        var hasRightAction = actionButtons.some(function (other) {
          if (other === el) return false;
          var otherRect = other.getBoundingClientRect();
          return otherRect.left > rect.right + 2 &&
            otherRect.top < rect.bottom + 12 && otherRect.bottom > rect.top - 12;
        });
        var semanticSized = rect.width <= 180 && rect.height <= 72;
        return (semantic && semanticSized && rightOfDuration && leftOfSend && (clickable(el) || iconOnly)) ||
          (popupTrigger && square && rightOfDuration && leftOfSend) ||
          (iconOnly && square && rightOfDuration && leftOfSend && hasRightAction);
      });
      var editorText = editors.map(textOf).filter(Boolean).join(' ');
      var controlText = labels.join(' ').replace(/\\s+/g, ' ').trim();
      var composerText = [editorText].concat(labels).join(' ').replace(/\\s+/g, ' ').trim();
      return {
        model: model,
        duration: duration,
        ratio: ratio,
        moreAvailable: moreAvailable,
        controlText: controlText,
        composerText: composerText,
        modelReady: Boolean(model),
        // 比例可能只在“更多”弹层中出现；先确认入口可见，后续仍需
        // 实际展开、选择并回读选中态，不把按钮存在当成已配置。
        compositeReady: Boolean(duration && (ratio || hasRatioControl || moreAvailable)),
      };
    })()
  `, 'dola_video_controls').catch(() => ({
    model: '', duration: '', ratio: '', moreAvailable: false, controlText: '', composerText: '', modelReady: false, compositeReady: false,
  }));

  const readiness = await waitForVideoControlReadiness(async () => {
    const snapshot = await readSnapshot();
    return { modelReady: snapshot.modelReady, compositeReady: snapshot.compositeReady };
  }, { timeoutMs: DOLA_VIDEO_CONTROL_READINESS_TIMEOUT_MS, stableSamples: 3 });
  await options?.onReadiness?.(readiness);
  if (!readiness.ready) {
    throw new VideoControlReadinessError(readiness.failureStage || 'stable_readback', readiness);
  }

  const dolaControlErrorCode = (label: string): string => {
    if (label.includes('时长')) return 'dola_video_duration';
    if (label.includes('模型')) return 'dola_video_model';
    if (label.includes('比例')) return 'dola_video_ratio';
    if (label.includes('更多')) return 'dola_video_more';
    return 'dola_video_control';
  };

  const clickPosition = async (position: string | undefined, label: string): Promise<void> => {
    if (!position) {
      throw new DolaVideoControlReadinessError(
        dolaControlErrorCode(label),
        `${label}不可见，页面仍在加载，已暂停本次提交并等待重试`,
      );
    }
    const [x, y] = position.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new DolaVideoControlReadinessError(
        dolaControlErrorCode(label),
        `${label}坐标无效，已暂停本次提交并等待重试`,
      );
    }
    // Dola 的控件由 React 受控；仅 dispatchEvent 会产生 isTrusted=false 的
    // 合成事件，菜单看似切换但提交状态仍可能保持默认值。Electron webview
    // 有真实输入通道时优先使用它，让页面按正常鼠标路径更新内部状态。
    if (typeof webview.sendInputEvent === 'function') {
      const hittable = await page<boolean>(`
        (function () {
          var target = document.elementFromPoint(${x}, ${y});
          if (!target) return false;
          var rect = target.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })()
      `, `verify_dola_${label}`);
      if (!hittable) {
        throw new DolaVideoControlReadinessError(
          dolaControlErrorCode(label),
          `${label}暂时无法激活，已暂停本次提交并等待重试`,
        );
      }
      webview.sendInputEvent({ type: 'mouseMove', x, y });
      webview.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      webview.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await sleep(180);
      return;
    }
    const activated = await page<boolean>(`
      (function () {
        var x = ${x}; var y = ${y};
        var target = document.elementFromPoint(x, y);
        if (!target) return false;
        var rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
        try { target.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts))); } catch (_) {}
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        try { target.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts))); } catch (_) {}
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));
        return true;
      })()
    `, `activate_dola_${label}`);
    if (!activated) {
      throw new DolaVideoControlReadinessError(
        dolaControlErrorCode(label),
        `${label}暂时无法激活，已暂停本次提交并等待重试`,
      );
    }
    await sleep(120);
  };

  const findControl = async (kind: 'model' | 'duration' | 'ratio'): Promise<string | undefined> => {
    const result = await page<{ position?: string }>(`
      (function () {
        function visible(el) {
          if (!el) return false;
          var r = el.getBoundingClientRect();
          var style = window.getComputedStyle(el);
          return r.width > 10 && r.height > 10 && r.top > window.innerHeight * 0.4 && r.bottom > 0 &&
            r.top < window.innerHeight && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }
        function textOf(el) {
          var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
          var attrs = ['aria-label', 'title', 'data-testid', 'data-action', 'data-name', 'id', 'class', 'data-value', 'data-ratio'].map(function (name) {
            try { return el.getAttribute(name) || ''; } catch (_) { return ''; }
          }).filter(Boolean);
          return [text].concat(attrs).join(' ').replace(/\\s+/g, ' ').trim();
        }
        var kind = ${JSON.stringify(kind)};
        var stableKey = kind === 'model'
          ? 'video-model'
          : kind === 'duration'
            ? 'video-duration'
            : 'video-ratio';
        var stableControl = document.querySelector('[data-input-engine-actionbar-control-key="' + stableKey + '"]');
        if (stableControl && visible(stableControl)) {
          var stableRect = stableControl.getBoundingClientRect();
          return { position: Math.round(stableRect.left + stableRect.width / 2) + ',' + Math.round(stableRect.top + stableRect.height / 2) };
        }
        function clickable(el) {
          if (!el) return false;
          var tag = String(el.tagName || '').toLowerCase();
          var role = (el.getAttribute('role') || '').toLowerCase();
          var style = window.getComputedStyle(el);
          return tag === 'button' || role === 'button' || role === 'tab' ||
            el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded') ||
            el.hasAttribute('data-value') || el.hasAttribute('data-ratio') ||
            (typeof el.tabIndex === 'number' && el.tabIndex >= 0) || style.cursor === 'pointer';
        }
        function actionBarRoot() {
          var root = document.querySelector('#input-engine-container');
          if (root && visible(root)) return root;
          var editor = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"],input')).find(visible);
          return editor && editor.closest ? (editor.closest('[class*="input"],form') || editor.parentElement) : null;
        }
        function inConversation(el) {
          return Boolean(el && el.closest && el.closest('[data-message-id],[data-testid*="message"],[class*="message"],[class*="conversation"],article'));
        }
        function clickableTarget(el) {
          var node = el;
          for (var depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
            if (clickable(node)) return node;
          }
          return el;
        }
        var all = Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],li,label,a,[data-ratio],[data-value],[data-testid],[data-action],[aria-label],[title],div,span,svg'));
        var actionRoot = kind === 'duration' ? actionBarRoot() : null;
        // Dola 的时长控件没有稳定 data 属性时，优先限制在输入栏，避免
        // 历史消息或提示词中的“30s”被当成时长按钮。
        if (actionRoot) {
          var scoped = all.filter(function (el) { return actionRoot.contains(el); });
          if (scoped.length) all = scoped;
        }
        var candidates = all.filter(function (el) {
          if (!visible(el)) return false;
          if (kind === 'duration' && inConversation(el)) return false;
          var text = textOf(el);
          var compact = text.normalize('NFKC').replace(/[：／/×xX＊*]/g, ':').replace(/\\s+/g, '').replace(/秒/g, 's');
          if (text.length < 1 || text.length > 80) return false;
          if (kind === 'model') return /(?:^|\\s)(?:(?:模型|model)\\s*:?\\s*)?(?:(?:dreamina\\s+)?seedance\\s*)?2\\.(?:5|0)(?:\\s*(?:fast|mini))?(?=$|\\s|[·|/()（）])/i.test(text);
          if (kind === 'duration') return /(?:^|[^0-9])(?:[4-9]|1[0-5]|30)\\s*s(?:$|[^0-9])/i.test(compact) || /^(?:时长|duration)$/i.test(text) || /(?:自动|[0-9]+:[0-9]+)[·|/](?:[4-9]|1[0-5]|30)s$/i.test(compact);
          return /^(?:画面比例|比例|画幅|宽高比|aspect ratio)$/i.test(text)
            || /(?:自动|自适应|[0-9]+:[0-9]+|横屏|竖屏|方形|landscape|portrait|square)/i.test(compact)
            || (/(?:画面比例|比例|画幅|宽高比|aspect.?ratio|video[-_ ]?ratio)/i.test(text) && /(?:自动|自适应|[0-9]+:[0-9]+|横屏|竖屏|方形)/i.test(compact))
            || /(?:自动|[0-9]+:[0-9]+)[·|/](?:[4-9]|1[0-5]|30)s$/i.test(compact);
        }).filter(function (el) {
          var text = textOf(el);
          return !Array.from(el.children || []).some(function (child) { return textOf(child) === text; });
        });
        candidates.sort(function (a, b) {
          var ar = a.getBoundingClientRect(); var br = b.getBoundingClientRect();
          if (kind === 'duration') {
            var aInteractive = clickable(a) ? 1 : 0;
            var bInteractive = clickable(b) ? 1 : 0;
            var aRoot = actionRoot && actionRoot.contains(a) ? 1 : 0;
            var bRoot = actionRoot && actionRoot.contains(b) ? 1 : 0;
            return bRoot - aRoot || bInteractive - aInteractive || ar.width * ar.height - br.width * br.height || br.top - ar.top;
          }
          return ar.width * ar.height - br.width * br.height || br.top - ar.top;
        });
        var el = candidates[0];
        if (!el) return {};
        var target = kind === 'duration' ? clickableTarget(el) : el;
        var r = target.getBoundingClientRect();
        return { position: Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2) };
      })()
    `, `find_dola_${kind}_control`);
    return result.position;
  };

  /**
   * Dola 新版窄布局把比例入口折叠到输入栏右侧的“更多/…”按钮。
   * 只在底部可见区域查找，并优先使用语义属性；没有 aria-label 的版本
   * 再以时长控件右侧、发送按钮左侧的方形图标作为受限回退，避免误点页面
   * 其它“更多”菜单或发送按钮。
   */
  const findMoreControl = async (): Promise<string | undefined> => {
    const result = await page<{ position?: string }>(`
      (function () {
        function visible(el) {
          if (!el) return false;
          var r = el.getBoundingClientRect();
          var style = window.getComputedStyle(el);
          return r.width > 10 && r.height > 10 && r.top > window.innerHeight * 0.5 &&
            r.bottom > 0 && r.top < window.innerHeight &&
            style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }
        function descriptor(el) {
          var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
          var attrs = ['aria-label', 'title', 'data-testid', 'data-action', 'data-name', 'data-value', 'aria-controls', 'id', 'class'].map(function (name) {
            try { return el.getAttribute(name) || ''; } catch (_) { return ''; }
          }).filter(Boolean);
          return [text].concat(attrs).join(' ').replace(/\\s+/g, ' ').trim();
        }
        function normalized(value) {
          return String(value || '').normalize('NFKC').replace(/\\s+/g, '').toLowerCase();
        }
        function visibleLabel(el) {
          return String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, '').trim();
        }
         function hasIconOnly(el) {
           if (!el || visibleLabel(el)) return false;
           var tagName = String(el.tagName || '').toLowerCase();
           var className = typeof el.className === 'string' ? el.className : '';
           return tagName === 'svg' || el.hasAttribute('data-icon') || /(?:^|[\\s_-])icon(?:[\\s_-]|$)/i.test(className) ||
             Boolean(el.querySelector && el.querySelector('svg,[data-icon],i,[class*="icon"]'));
         }
        function clickable(el) {
          return el && (
            el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' ||
            el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded') ||
            (typeof el.tabIndex === 'number' && el.tabIndex >= 0)
          );
        }
        function semanticMore(el) {
          var values = [el.innerText || '', el.textContent || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || '',
            el.getAttribute('data-testid') || '', el.getAttribute('data-action') || '', el.getAttribute('data-name') || '',
            el.getAttribute('id') || '', el.getAttribute('class') || ''];
          return values.some(function (item) {
            var value = normalized(item);
            return /^(?:更多(?:选项|设置)?|more(?:options?)?|\\.{3}|…|⋯|•••|⋮)$/i.test(value) ||
              /(?:overflow|ellipsis|action-more|more-menu)/i.test(value);
          });
        }
         var all = Array.from(document.querySelectorAll('button,[role="button"],[aria-haspopup],[aria-expanded],[tabindex],[aria-label],[title],[data-action],[data-testid],[data-icon],[class*="more"],[class*="More"],[class*="ellipsis"],[class*="overflow"]'));
        var editor = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"],input')).find(visible);
        var editorRect = editor ? editor.getBoundingClientRect() : null;
        var send = document.querySelector('#flow-end-msg-send');
        var sendRect = send && visible(send) ? send.getBoundingClientRect() : null;
        function inActionBar(el) {
          var r = el.getBoundingClientRect();
          if (r.top < window.innerHeight * 0.5 || (editorRect && r.top < editorRect.top - 180)) return false;
          if (sendRect && r.left >= sendRect.left + 2) return false;
          return true;
        }
        function isSend(el) {
          var value = normalized(descriptor(el));
          return el.id === 'flow-end-msg-send' || el.getAttribute('type') === 'submit' ||
            /(?:发送|send|submit|停止|stop)/i.test(value);
        }
        var actionButtons = all.filter(function (el) {
          return visible(el) && clickable(el) && inActionBar(el);
        });
        var inferredSendRect = sendRect;
         if (!inferredSendRect) {
          // 新版发送按钮有时只有 SVG，没有稳定 id/aria-label。把 action-bar
          // 最右侧可点击按钮作为几何锚点，候选入口必须位于其左侧。
          var rightmostButton = actionButtons.slice().sort(function (a, b) {
            return b.getBoundingClientRect().right - a.getBoundingClientRect().right;
          })[0];
           inferredSendRect = rightmostButton ? rightmostButton.getBoundingClientRect() : null;
         }
         var durationNodes = all.filter(function (el) {
           if (!visible(el)) return false;
           var text = normalized(descriptor(el)).replace(/秒/g, 's');
           return /^(?:[4-9]|1[0-5]|30)s$/.test(text);
         });
         var durationRect = durationNodes.length
           ? durationNodes[durationNodes.length - 1].getBoundingClientRect()
           : null;
         var semantic = all.filter(function (el) {
           if (!visible(el) || !clickable(el) || !inActionBar(el) || isSend(el)) return false;
           var r = el.getBoundingClientRect();
           var rightOfDuration = !durationRect || r.left > durationRect.right - 4;
           var leftOfSend = !inferredSendRect || r.right < inferredSendRect.left - 4;
           return semanticMore(el) && r.width <= 180 && r.height <= 100 && rightOfDuration && leftOfSend;
         });
        semantic.sort(function (a, b) {
          var ar = a.getBoundingClientRect(); var br = b.getBoundingClientRect();
          var aButton = /^(?:BUTTON)$/.test(a.tagName) || a.getAttribute('role') === 'button' ? 1 : 0;
          var bButton = /^(?:BUTTON)$/.test(b.tagName) || b.getAttribute('role') === 'button' ? 1 : 0;
          return bButton - aButton || ar.width * ar.height - br.width * br.height || br.left - ar.left;
        });
        var target = semantic[0];
        if (!target) {
           var send = document.querySelector('#flow-end-msg-send');
          var sendRect = send && visible(send) ? send.getBoundingClientRect() : inferredSendRect;
          var fallback = all.filter(function (el) {
             if (!visible(el) || (!clickable(el) && !semanticMore(el)) || !inActionBar(el) || isSend(el)) return false;
            var r = el.getBoundingClientRect();
            var text = normalized(descriptor(el));
            var label = normalized(visibleLabel(el));
            var square = r.width >= 20 && r.width <= 64 && r.height >= 20 && r.height <= 64 && Math.abs(r.width - r.height) < 20;
            var rightOfDuration = !durationRect || r.left > durationRect.right - 4;
            var leftOfSend = !sendRect || r.right < sendRect.left - 4;
            var unlabeledGlyph = hasIconOnly(el) || !label || /^(?:\\.{3}|…|⋯|•••|⋮)$/.test(label);
            var popupTrigger = el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('aria-expanded') !== null;
            var hasRightAction = actionButtons.some(function (other) {
              if (other === el) return false;
              var otherRect = other.getBoundingClientRect();
              return otherRect.left > r.right + 2 &&
                otherRect.top < r.bottom + 12 && otherRect.bottom > r.top - 12;
            });
            return square && rightOfDuration && leftOfSend &&
              (popupTrigger || (unlabeledGlyph && hasRightAction));
          });
          fallback.sort(function (a, b) { return b.getBoundingClientRect().left - a.getBoundingClientRect().left; });
          target = fallback[0];
        }
        if (!target) return {};
        var rect = target.getBoundingClientRect();
        // 记住本次展开入口的弹层锚点；后续比例查找只在该弹层内取值，
        // 避免页面其它可见菜单或历史消息中的同名比例被误选。
        try {
          window.__dolaMoreControlState = {
            ariaControls: target.getAttribute('aria-controls') || '',
            triggerId: target.id || '',
            openedAt: Date.now()
          };
        } catch (_) {}
        return { position: Math.round(rect.left + rect.width / 2) + ',' + Math.round(rect.top + rect.height / 2) };
      })()
    `, 'find_dola_more_control');
    return result.position;
  };

  const normalizeOption = (value: string): string => value
    .normalize('NFKC')
    .replace(/秒/g, 's')
    .replace(/[﹒•⋅]/g, '·')
    .replace(/\s+/g, '')
    .toLowerCase();
  const findOption = async (expected: string[], label: string): Promise<string | undefined> => {
    const result = await page<{ position?: string }>(`
      (function () {
        function visible(el) {
          if (!el) return false;
          var r = el.getBoundingClientRect();
          var style = window.getComputedStyle(el);
          return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < window.innerHeight &&
            style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }
        function textOf(el) {
          var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
          var attrs = ['aria-label', 'title', 'data-testid', 'data-action', 'data-name', 'id', 'class', 'data-value', 'data-ratio', 'data-option-key'].map(function (name) {
            try { return el.getAttribute(name) || ''; } catch (_) { return ''; }
          }).filter(Boolean);
          return [text].concat(attrs).join(' ').replace(/\\s+/g, ' ').trim();
        }
        function menuLike(el) {
          var node = el;
          for (var depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
            var role = (node.getAttribute('role') || '').toLowerCase();
            var marker = [node.id || '', node.className || '', node.getAttribute('data-testid') || '', node.getAttribute('data-state') || '']
              .join(' ').toLowerCase();
            if (role === 'menu' || role === 'listbox' || role === 'option' || role === 'menuitem' ||
                /(?:dropdown|popover|popup|menu|listbox|option-list|select-panel)/i.test(marker)) return true;
            var style = window.getComputedStyle(node);
            var rect = node.getBoundingClientRect();
            if ((style.position === 'fixed' || style.position === 'absolute') &&
                rect.width > 40 && rect.height > 24 && rect.bottom > 0 && rect.top < window.innerHeight) return true;
          }
          return false;
        }
        function menuRoot(el) {
          var node = el;
          for (var depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
            var role = (node.getAttribute('role') || '').toLowerCase();
            var marker = [node.id || '', node.className || '', node.getAttribute('data-testid') || '', node.getAttribute('data-state') || '']
              .join(' ').toLowerCase();
            var style = window.getComputedStyle(node);
            var rect = node.getBoundingClientRect();
            if (role === 'menu' || role === 'listbox' || role === 'option' || role === 'menuitem' ||
                /(?:dropdown|popover|popup|menu|listbox|option-list|select-panel)/i.test(marker) ||
                ((style.position === 'fixed' || style.position === 'absolute') && rect.width > 40 && rect.height > 24)) {
              return node;
            }
          }
          return null;
        }
        function plainTextOf(el) {
          return String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
        }
        function clickable(el) {
          if (!el) return false;
          var tag = String(el.tagName || '').toLowerCase();
          var role = (el.getAttribute('role') || '').toLowerCase();
          var style = window.getComputedStyle(el);
          return tag === 'button' || role === 'button' || role === 'option' || role === 'menuitem' ||
            el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded') ||
            el.hasAttribute('data-value') || el.hasAttribute('data-option-key') ||
            (typeof el.tabIndex === 'number' && el.tabIndex >= 0) || style.cursor === 'pointer';
        }
        function clickableTarget(el) {
          var node = el;
          for (var depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
            if (clickable(node)) return node;
          }
          return el;
        }
        function inConversation(el) {
          return Boolean(el && el.closest && el.closest('[data-message-id],[data-testid*="message"],[class*="message"],[class*="conversation"],article,[contenteditable="true"]'));
        }
        function durationContext(el) {
          var node = el;
          for (var depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
            var text = plainTextOf(node).normalize('NFKC').replace(/秒/g, 's').replace(/\\s+/g, '').toLowerCase();
            var labels = text.match(/(?:[4-9]|1[0-5]|30)s/g) || [];
            var unique = [];
            labels.forEach(function (label) { if (unique.indexOf(label) < 0) unique.push(label); });
            var role = (node.getAttribute('role') || '').toLowerCase();
            var marker = [node.id || '', node.className || '', node.getAttribute('data-testid') || '', node.getAttribute('data-state') || ''].join(' ').toLowerCase();
            var style = window.getComputedStyle(node);
            var rect = node.getBoundingClientRect();
            var semantic = role === 'menu' || role === 'listbox' || role === 'option' || role === 'menuitem' ||
              /(?:dropdown|popover|popup|menu|listbox|option-list|select-panel)/i.test(marker);
            var overlay = (style.position === 'fixed' || style.position === 'absolute') && rect.width > 40 && rect.height > 24;
            // 某些 Dola 版本的菜单是普通相对 DIV；同一容器内出现多个
            // 离散时长标签即可证明它是当前时长菜单，而不是历史文本。
            if (unique.length >= 2 && (semantic || overlay || node.children.length >= 2)) return node;
          }
          return null;
        }
        function canonicalDuration(value) {
          var compact = String(value || '').normalize('NFKC').replace(/秒/g, 's').replace(/\\s+/g, '').toLowerCase();
          var match = compact.match(/(?:^|[^0-9])((?:[4-9]|1[0-5]|30)s)(?:$|[^0-9])/i);
          return match ? match[1].toLowerCase() : '';
        }
        function canonicalRatio(value) {
          var compact = String(value || '').normalize('NFKC').replace(/[：／/×xX＊*]/g, ':').replace(/秒/g, 's').replace(/\\s+/g, '').toLowerCase();
          var match = compact.match(/[0-9]+:[0-9]+/);
          if (match) return match[0];
          if (/(?:横屏|landscape|宽屏|wide)/i.test(compact)) return '16:9';
          if (/(?:竖屏|portrait|窄屏|vertical)/i.test(compact)) return '9:16';
          if (/(?:方形|正方形|square)/i.test(compact)) return '1:1';
          if (/(?:自动|自适应|auto)/i.test(compact)) return '自动';
          return compact;
        }
        var durationLookup = /duration|时长/i.test(${JSON.stringify(label)});
        var expected = ${JSON.stringify(expected)}.map(function (value) {
          return durationLookup ? canonicalDuration(value) : canonicalRatio(value);
        });
        var all = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],button,[role="button"],li,label,a,[data-ratio],[data-value],[data-option-key],[data-testid],[data-action],[aria-label],[title],div,span,svg'));
        var ratioLookup = /ratio|比例|画幅/i.test(${JSON.stringify(label)});
        var bridgeState = ratioLookup && window.__dolaMoreControlState ? window.__dolaMoreControlState : null;
        var preferredRoot = null;
        if (bridgeState && bridgeState.ariaControls) {
          try { preferredRoot = document.getElementById(bridgeState.ariaControls); } catch (_) { preferredRoot = null; }
        }
        var candidates = all.map(function (el) {
          return { el: el, root: menuRoot(el) };
        }).filter(function (item) {
          var el = item.el;
          if (!visible(el)) return false;
          var text = textOf(el);
          if (!text || text.length > 80) return false;
          var normalized = text.normalize('NFKC').replace(/[：／/×xX＊*]/g, ':').replace(/秒/g, 's').replace(/\\s+/g, '').toLowerCase();
          var ratioNormalized = durationLookup ? canonicalDuration(normalized) : canonicalRatio(normalized);
          var role = (el.getAttribute('role') || '').toLowerCase();
          var explicitOption = role === 'option' || role === 'menuitem' || el.tagName === 'OPTION';
          // 选项必须位于弹层/菜单，或自身明确标注为 option/menuitem；
          // 这样不会把历史消息、提示词里的“16:9”当成可点击选项。
          if (!menuLike(el) && !explicitOption) return false;
           // aria-controls 通常指向第一级菜单；比例子菜单可能由 portal
           // 渲染到另一个可见 menu root，不能在这里把它误过滤掉。候选仍须
           // 通过 menuLike/explicitOption 和下方的活动弹层筛选。
          // Dola 模型菜单项通常还附带“旗舰视频标杆 · 5 倍消耗”等副标题，
          // 因此不能要求整个容器文本完全相等；只接受标题本身相等或位于
          // 容器文本开头，避免把其它模型的描述误当成目标选项。
          return expected.some(function (value) {
            return ratioNormalized === value || normalized === value || normalized.indexOf(value) === 0 ||
              (ratioLookup && value.indexOf(':') > 0 && normalized.indexOf(value) >= 0);
          });
        }).filter(function (item) {
          // 比例菜单的 role=menuitem 外层节点才是页面真正的可点击项；
          // 不在这里直接按最小文字节点筛选，否则 4:3/16:9 等不同宽度
          // 的子节点会被面积排序误判，出现“要求 16:9 却点击 4:3”。
          if (ratioLookup) return true;
          var text = textOf(item.el);
          return !Array.from(item.el.children || []).some(function (child) { return textOf(child) === text; });
        });
        // Dola 的部分版本把离散时长菜单渲染为普通 DIV，没有 role/menu
        // 或 popup class。只有在同一可见容器同时出现多个时长项、且目标
        // 位于当前菜单上下文时才启用兜底，避免误点会话正文中的数字。
        if (durationLookup) {
          var durationFallback = all.map(function (el) {
            var text = textOf(el);
            var plain = plainTextOf(el).normalize('NFKC').replace(/秒/g, 's').replace(/\\s+/g, '').toLowerCase();
            var normalized = text.normalize('NFKC').replace(/秒/g, 's').replace(/\\s+/g, '').toLowerCase();
            var plainLabels = plain.match(/(?:[4-9]|1[0-5]|30)s/g) || [];
            var uniquePlainLabels = [];
            plainLabels.forEach(function (label) { if (uniquePlainLabels.indexOf(label) < 0) uniquePlainLabels.push(label); });
            var exact = expected.some(function (value) {
              return normalized === value || plain === value ||
                (uniquePlainLabels.length === 1 && plain.indexOf(value) === 0 && plain.length <= 32);
            });
            if (!visible(el) || inConversation(el) || !exact) return null;
            var context = durationContext(el);
            if (!context) return null;
            var target = clickableTarget(el);
            var rect = target.getBoundingClientRect();
            return { el: target, root: context, fallback: true, score: (clickable(target) ? 20 : 0) + rect.width * rect.height };
          }).filter(Boolean);
          if (durationFallback.length) candidates = durationFallback;
          candidates.sort(function (a, b) { return b.score - a.score; });
        }
        // 菜单根节点会同时包含 1:1、4:3、16:9 等全部选项；
        // 先保留文本规范化后精确等于目标比例的候选，再做弹层根节点
        // 过滤。否则根节点的中心坐标可能落到相邻的 4:3 项上。
        if (ratioLookup) {
          var exactRatioCandidates = candidates.filter(function (item) {
            var normalized = textOf(item.el).normalize('NFKC').replace(/[：／/×xX＊*]/g, ':').replace(/秒/g, 's').replace(/\\s+/g, '').toLowerCase();
            var ratioNormalized = canonicalRatio(normalized);
            return expected.some(function (value) {
              return ratioNormalized === value || normalized === value;
            });
          });
          if (exactRatioCandidates.length) candidates = exactRatioCandidates;
        }
        // 没有 aria-controls 的页面仍可能同时存在多个弹层；比例查询优先
        // 选择最靠近输入栏底部、且当前可见的弹层，历史菜单不会参与。
        if (ratioLookup && !preferredRoot) {
          var roots = [];
          candidates.forEach(function (item) {
            if (item.root && roots.indexOf(item.root) < 0) roots.push(item.root);
          });
          if (roots.length > 1) {
            roots.sort(function (a, b) {
              var ar = a.getBoundingClientRect(); var br = b.getBoundingClientRect();
              return (br.top + br.height) - (ar.top + ar.height);
            });
            var activeRoot = roots[0];
            candidates = candidates.filter(function (item) { return item.root === activeRoot || !item.root; });
          }
        }
        candidates.sort(function (a, b) {
          if (ratioLookup) {
            var aText = textOf(a.el).normalize('NFKC').replace(/[：／/×xX＊*]/g, ':').replace(/秒/g, 's').replace(/\\s+/g, '').toLowerCase();
            var bText = textOf(b.el).normalize('NFKC').replace(/[：／/×xX＊*]/g, ':').replace(/秒/g, 's').replace(/\\s+/g, '').toLowerCase();
            var aExact = expected.some(function (value) { return canonicalRatio(aText) === value || aText === value; });
            var bExact = expected.some(function (value) { return canonicalRatio(bText) === value || bText === value; });
            var aRole = /^(?:option|menuitem)$/.test((a.el.getAttribute('role') || '').toLowerCase()) ? 1 : 0;
            var bRole = /^(?:option|menuitem)$/.test((b.el.getAttribute('role') || '').toLowerCase()) ? 1 : 0;
            var aArea = a.el.getBoundingClientRect().width * a.el.getBoundingClientRect().height;
            var bArea = b.el.getBoundingClientRect().width * b.el.getBoundingClientRect().height;
            return Number(bExact) - Number(aExact) || bRole - aRole || bArea - aArea;
          }
          var ar = a.el.getBoundingClientRect(); var br = b.el.getBoundingClientRect();
          return ar.width * ar.height - br.width * br.height || br.top - ar.top;
        });
        var el = candidates[0] && candidates[0].el;
        if (!el) return {};
        var r = el.getBoundingClientRect();
        return { position: Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2) };
      })()
    `, `find_dola_${label}`);
    return result.position;
  };

  const waitForOption = async (expected: string[], label: string, timeoutMs: number = 12_000): Promise<string> => {
    let position: string | undefined;
    await pollUntilReady(async () => {
      position = await findOption(expected, label).catch(() => undefined);
      return Boolean(position);
    }, { timeoutMs });
    if (!position) {
      throw new DolaVideoControlReadinessError(
        label,
        `${label}选项尚未挂载，已暂停本次提交并等待重试`,
      );
    }
    return position;
  };

  /** 读取更多菜单中真正处于选中态的比例，供隐藏控件的回读门禁使用。 */
  const readDolaRatioSelection = async (): Promise<{ ratio: string; menuOpen: boolean }> => {
    return page<{ ratio: string; menuOpen: boolean }>(`
      (function () {
        function visible(el) {
          if (!el) return false;
          var r = el.getBoundingClientRect();
          var style = window.getComputedStyle(el);
          return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < window.innerHeight &&
            style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }
        function descriptor(el) {
          var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
          var attrs = ['aria-label', 'title', 'data-testid', 'data-action', 'data-name', 'id', 'class', 'data-value', 'data-ratio'].map(function (name) {
            try { return el.getAttribute(name) || ''; } catch (_) { return ''; }
          }).filter(Boolean);
          return [text].concat(attrs).join(' ').replace(/\\s+/g, ' ').trim();
        }
        function ratioOf(value) {
          var compact = String(value || '').normalize('NFKC').replace(/[：／/×xX＊*]/g, ':').replace(/\\s+/g, '');
          var match = compact.match(/(?:自动|自适应|auto|[0-9]+:[0-9]+)/i);
          if (match) return /^(?:自适应|auto)$/i.test(match[0]) ? '自动' : match[0];
          if (/(?:横屏|landscape|宽屏|wide)/i.test(compact)) return '16:9';
          if (/(?:竖屏|portrait|窄屏|vertical)/i.test(compact)) return '9:16';
          if (/(?:方形|正方形|square)/i.test(compact)) return '1:1';
          if (/(?:自适应|auto)/i.test(compact)) return '自动';
          return '';
        }
        function menuLike(el) {
          var node = el;
          for (var depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
            var role = (node.getAttribute('role') || '').toLowerCase();
            var marker = [node.id || '', node.className || '', node.getAttribute('data-testid') || '', node.getAttribute('data-state') || '']
              .join(' ').toLowerCase();
            if (role === 'menu' || role === 'listbox' || role === 'option' || role === 'menuitem' ||
                /(?:dropdown|popover|popup|menu|listbox|option-list|select-panel)/i.test(marker)) return true;
            var style = window.getComputedStyle(node);
            var rect = node.getBoundingClientRect();
            if ((style.position === 'fixed' || style.position === 'absolute') &&
                rect.width > 40 && rect.height > 24 && rect.bottom > 0 && rect.top < window.innerHeight) return true;
          }
          return false;
        }
        function menuRoot(el) {
          var node = el;
          for (var depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
            var role = (node.getAttribute('role') || '').toLowerCase();
            var marker = [node.id || '', node.className || '', node.getAttribute('data-testid') || '', node.getAttribute('data-state') || '']
              .join(' ').toLowerCase();
            var style = window.getComputedStyle(node);
            var rect = node.getBoundingClientRect();
            if (role === 'menu' || role === 'listbox' ||
                /(?:dropdown|popover|popup|menu|listbox|option-list|select-panel)/i.test(marker) ||
                ((style.position === 'fixed' || style.position === 'absolute') && rect.width > 40 && rect.height > 24)) {
              return node;
            }
          }
          return null;
        }
        function isOpenMenu(el) {
          if (!visible(el)) return false;
          if (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('data-state') === 'closed') return false;
          var role = (el.getAttribute('role') || '').toLowerCase();
          var marker = [el.id || '', el.className || '', el.getAttribute('data-testid') || '', el.getAttribute('data-state') || '']
            .join(' ').toLowerCase();
          var style = window.getComputedStyle(el);
          var rect = el.getBoundingClientRect();
          var semantic = role === 'menu' || role === 'listbox' ||
            /(?:dropdown|popover|popup|menu|listbox|option-list|select-panel)/i.test(marker);
          var overlay = (style.position === 'fixed' || style.position === 'absolute') &&
            rect.width > 40 && rect.height > 24;
          return rect.bottom > 0 && rect.top < window.innerHeight && (semantic || overlay);
        }
        function selected(el) {
          var node = el;
          for (var depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
            var explicit = [
              node.getAttribute('aria-selected'), node.getAttribute('aria-checked'),
              node.getAttribute('data-selected'), node.getAttribute('data-checked'),
              node.getAttribute('data-state'), node.getAttribute('aria-current'),
              node.getAttribute('aria-pressed'), node.getAttribute('data-active'),
              node.getAttribute('data-current')
            ].filter(Boolean).map(function (value) { return String(value).toLowerCase(); });
            if (explicit.some(function (value) { return /^(?:true|selected|checked|active|current|on)$/.test(value); })) return true;
            var className = typeof node.className === 'string' ? node.className : '';
            var tokens = className.toLowerCase().split(/[\\s_-]+/).filter(Boolean);
            if (tokens.some(function (token) { return /^(?:selected|checked|active|current|on)$/.test(token); }) &&
                !/(?:not|unselected|unchecked|inactive)/i.test(className)) return true;
            if (node.matches && node.matches('input[type="checkbox"]:checked,input[type="radio"]:checked,option:checked')) return true;
          }
          return false;
        }
        var all = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],button,[role="button"],li,label,a,[data-ratio],[data-value],[data-testid],[data-action],[aria-label],[title],div,span,svg'));
        var bridgeState = window.__dolaMoreControlState || null;
        var preferredRoot = null;
        if (bridgeState && bridgeState.ariaControls) {
          try { preferredRoot = document.getElementById(bridgeState.ariaControls); } catch (_) { preferredRoot = null; }
        }
        var ratioNodes = all.filter(visible).map(function (el) {
          return { el: el, ratio: ratioOf(descriptor(el)), root: menuRoot(el) };
        }).filter(function (item) {
          return Boolean(item.ratio) && item.el.getBoundingClientRect().bottom > 0 && item.el.getBoundingClientRect().top < window.innerHeight &&
            (menuLike(item.el) || selected(item.el)) &&
             true;
        });
        var selectedRatio = '';
        ratioNodes.forEach(function (item) {
          if (!selectedRatio && selected(item.el)) selectedRatio = item.ratio;
        });
        // 直接比例布局可能在按钮上只显示“比例”，但把实际值放在
        // data-value/data-ratio/aria-label 中；若存在则作为同等回读证据。
        var directRatioControl = document.querySelector('[data-input-engine-actionbar-control-key="video-ratio"]');
        if (!selectedRatio && directRatioControl && visible(directRatioControl)) {
          selectedRatio = ratioOf(descriptor(directRatioControl));
        }
        var menus = Array.from(document.querySelectorAll('[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[data-popper-placement],[class*="dropdown"],[class*="popover"],[class*="popup"],[class*="menu"]'));
        var menuOpen = menus.some(isOpenMenu) ||
          Array.from(document.querySelectorAll('[aria-expanded="true"]')).some(function (el) {
            return visible(el) && el.getBoundingClientRect().top > window.innerHeight * 0.45;
          });
        return { ratio: selectedRatio, menuOpen: menuOpen };
      })()
    `, 'read_dola_ratio_selection');
  };

  const waitForMoreControl = async (timeoutMs: number = 5_000): Promise<string> => {
    let position: string | undefined;
    await pollUntilReady(async () => {
      position = await findMoreControl().catch(() => undefined);
      return Boolean(position);
    }, { timeoutMs, intervalMs: 180 });
    if (!position) {
      throw new DolaVideoControlReadinessError(
        'dola_video_more',
        'Dola 视频更多控件尚未挂载，已暂停本次提交并等待重试',
      );
    }
    return position;
  };

  /** 收起当前 Dola 动态弹层；仅用于提交前重新定位控件。 */
  const dismissDolaOverlay = async (): Promise<void> => {
    try {
      if (typeof webview.sendInputEvent === 'function') {
        webview.sendInputEvent({ type: 'keyDown', keyCode: 'Escape', code: 'Escape', key: 'Escape' });
        webview.sendInputEvent({ type: 'keyUp', keyCode: 'Escape', code: 'Escape', key: 'Escape' });
      } else {
        await page<boolean>(`
          (function () {
            var event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
            document.dispatchEvent(event);
            return true;
          })()
        `, 'dismiss_dola_overlay');
      }
    } catch {
      // 关闭失败不代表账号异常；下一轮会重新定位并等待控件。
    }
    await sleep(180);
  };

  /** 比例选中后收起弹层，避免弹层遮住输入框或发送按钮。 */
  const closeDolaMoreMenu = async (): Promise<void> => {
    const state = await readDolaRatioSelection().catch(() => ({ ratio: '', menuOpen: false }));
    if (!state.menuOpen) return;
    try {
      if (typeof webview.sendInputEvent === 'function') {
        webview.sendInputEvent({ type: 'keyDown', keyCode: 'Escape', code: 'Escape', key: 'Escape' });
        webview.sendInputEvent({ type: 'keyUp', keyCode: 'Escape', code: 'Escape', key: 'Escape' });
      } else {
        await page<boolean>(`
          (function () {
            var event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
            document.dispatchEvent(event);
            return true;
          })()
        `, 'close_dola_more_menu');
      }
    } catch {
      // 关闭是提交前的清理动作；若页面拒绝键盘事件，不能因此改写或重试任务。
    }
    await pollUntilReady(async () => {
      const next = await readDolaRatioSelection().catch(() => ({ ratio: '', menuOpen: true }));
      return !next.menuOpen;
    }, { timeoutMs: 2_000, intervalMs: 120 });
  };

  const currentMatchesModel = (value: string): boolean => {
    const current = normalizeDolaModelLabel(value);
    return Boolean(current) && modelAliases.some((alias) => current === normalizeDolaModelLabel(alias));
  };

  let snapshot = await readSnapshot();
  if (!currentMatchesModel(snapshot.model)) {
    const modelOptions = modelAliases.flatMap((alias) => [alias, `模型 ${alias}`]);
    let modelSelected = false;
    let lastModelError: Error | undefined;

    // Dola 的模型菜单由异步 action bar 渲染，偶尔会出现“控件已可见但
    // 菜单项尚未挂载”的短窗口。每次重试都重新定位并展开控件，避免
    // 使用已经失效的旧坐标；整个流程仍在提交前且有明确上限。
    for (let attempt = 0; attempt < 3 && !modelSelected; attempt += 1) {
      try {
        snapshot = await readSnapshot();
        if (currentMatchesModel(snapshot.model)) {
          modelSelected = true;
          break;
        }
        const modelControl = await findControl('model');
        if (!modelControl) {
          await sleep(350);
          continue;
        }
        await clickPosition(modelControl, 'Dola 视频模型控件');
        const optionPosition = await waitForOption(modelOptions, 'dola_video_model', 3500);
        await clickPosition(optionPosition, 'Dola 视频模型选项');
        modelSelected = await pollUntilReady(async () => {
          snapshot = await readSnapshot();
          return currentMatchesModel(snapshot.model);
        }, { timeoutMs: 3500, intervalMs: 180 });
      } catch (error) {
        lastModelError = error instanceof Error ? error : new Error(String(error));
        // 菜单可能仍处于关闭动画；给页面一个短暂稳定窗口后重新读取。
        await sleep(450);
      }
    }
    if (!modelSelected && lastModelError) throw lastModelError;
    if (!currentMatchesModel(snapshot.model)) throw new Error(`Dola 视频模型配置回读失败: ${config.model}`);
  }

  const matchesOption = (actual: string, desired: string): boolean => normalizeOption(actual) === normalizeOption(desired);
  const matchesDurationOption = (actual: string, desired: string): boolean => matchesDolaDurationLabel(actual, desired);

  /**
   * Dola 时长菜单由 action bar 异步挂载。点击控件后不能假设菜单立即存在；
   * 每轮都重新定位控件、重新展开菜单，并在点击后回读选中值，避免把动画窗口
   * 误报成“dola_video_duration 选项不可见”。
   */
  const selectDolaDuration = async (): Promise<void> => {
    const expected = [desiredDuration, `${durationSeconds} 秒`, `${durationSeconds}秒`, `视频时长 ${durationSeconds} 秒`, `视频时长${durationSeconds}秒`];
    let lastError: unknown;

    for (let attempt = 0; attempt < DOLA_VIDEO_DURATION_SELECTION_MAX_ATTEMPTS; attempt += 1) {
      try {
        let durationControl: string | undefined;
        await pollUntilReady(async () => {
          durationControl = await findControl('duration').catch(() => undefined);
          return Boolean(durationControl);
        }, { timeoutMs: 5_000, intervalMs: 180 });
        await clickPosition(durationControl, 'Dola 视频时长控件');
        // 菜单的 portal/动画通常在真实鼠标事件后才挂载。
        await sleep(250 + attempt * 150);
        const option = await waitForOption(
          expected,
          'dola_video_duration',
          DOLA_VIDEO_DURATION_OPTION_TIMEOUT_MS + attempt * 1_000,
        );
        await clickPosition(option, 'Dola 视频时长选项');
        const confirmed = await pollUntilReady(async () => {
          snapshot = await readSnapshot();
          return matchesDurationOption(snapshot.duration, desiredDuration);
        }, { timeoutMs: 6_000, intervalMs: 180 });
        if (confirmed) return;
        lastError = new DolaVideoControlReadinessError(
          'dola_video_duration',
          `Dola 视频时长 ${config.duration} 点击后未完成回读，页面仍在更新`,
        );
      } catch (error: unknown) {
        lastError = error;
      }

      await dismissDolaOverlay();
      await sleep(300 + attempt * 250);
    }

    if (lastError instanceof DolaVideoControlReadinessError) throw lastError;
    throw new DolaVideoControlReadinessError(
      'dola_video_duration',
      `Dola 视频时长 ${config.duration} 尚未稳定，已暂停本次提交并等待重试`,
    );
  };

  snapshot = await readSnapshot();
  if (!matchesDurationOption(snapshot.duration, desiredDuration)) {
    await selectDolaDuration();
  }

  snapshot = await readSnapshot();
  let ratioReadbackEvidence = matchesOption(snapshot.ratio, desiredRatio) ? desiredRatio : '';
  if (!matchesOption(snapshot.ratio, desiredRatio)) {
    let ratioOptionPosition: string | undefined;
    let ratioEntry: 'direct' | 'more' | 'existing' = 'existing';
    const menuState = await readDolaRatioSelection().catch(() => ({ ratio: '', menuOpen: false }));

    // 如果上一步留下的弹层已经展开，先直接寻找目标；否则优先点击独立比例
    // 触发器，窄布局没有该触发器时才点击“…”更多入口。
    if (menuState.menuOpen) {
      ratioOptionPosition = await findOption([desiredRatio, config.aspectRatio], 'dola_video_ratio').catch(() => undefined);
    }
    if (!ratioOptionPosition) {
      const directRatioControl = await findControl('ratio').catch(() => undefined);
      if (directRatioControl) {
        ratioEntry = 'direct';
        await clickPosition(directRatioControl, 'Dola 视频比例控件');
      } else {
        ratioEntry = 'more';
        await clickPosition(await waitForMoreControl(), 'Dola 视频更多控件');
      }

      ratioOptionPosition = await waitForOption(
        [desiredRatio, config.aspectRatio],
        'dola_video_ratio',
        3_500,
      ).catch(() => undefined);

      // 部分 Dola 布局的更多菜单先展示“画面比例”二级入口；只有目标比例
      // 尚未出现时才进入子菜单，避免重复点击已经可见的比例选项。
      if (!ratioOptionPosition) {
        const ratioMenuPosition = await waitForOption(
          ['画面比例', '比例', '画幅', 'Aspect Ratio'],
          'dola_video_ratio_menu',
          3_500,
        );
        await clickPosition(ratioMenuPosition, 'Dola 视频比例菜单');
        ratioOptionPosition = await waitForOption(
          [desiredRatio, config.aspectRatio],
          'dola_video_ratio',
          7_000,
        );
      }
    }

    await clickPosition(ratioOptionPosition, 'Dola 视频比例选项');
    let ratioConfirmed = await pollUntilReady(async () => {
      const selection = await readDolaRatioSelection().catch(() => ({ ratio: '', menuOpen: false }));
      snapshot = await readSnapshot();
      return matchesOption(selection.ratio, desiredRatio) || matchesOption(snapshot.ratio, desiredRatio);
    }, { timeoutMs: 4_000, intervalMs: 180 });

    // 选择后弹层可能立即关闭，导致第一次轮询错过 selected 标记。此时仅
    // 重新打开同一个入口读取选中态，不重复选择、不触发提交。
    const reopenRatioMenuForReadback = async (): Promise<void> => {
      const tryDirect = async (): Promise<boolean> => {
        const position = await findControl('ratio').catch(() => undefined);
        if (!position) return false;
        await clickPosition(position, 'Dola 视频比例控件');
        ratioEntry = 'direct';
        return true;
      };
      const tryMore = async (): Promise<boolean> => {
        const position = await waitForMoreControl(3_000).catch(() => undefined);
        if (!position) return false;
        await clickPosition(position, 'Dola 视频更多控件');
        ratioEntry = 'more';
        return true;
      };
      if ((ratioEntry === 'direct' || ratioEntry === 'existing') && await tryDirect()) return;
      if ((ratioEntry === 'more' || ratioEntry === 'existing') && await tryMore()) return;
      // 响应式布局可能在菜单关闭期间切换入口，允许一次跨布局回退。
      if (ratioEntry !== 'direct' && await tryDirect()) return;
      if (ratioEntry !== 'more' && await tryMore()) return;
      throw new Error('Dola 视频比例入口不可见，已在提交前停止');
    };
    for (let attempt = 0; attempt < 2 && !ratioConfirmed; attempt += 1) {
      const current = await readDolaRatioSelection().catch(() => ({ ratio: '', menuOpen: false }));
      if (!current.menuOpen) {
        await reopenRatioMenuForReadback();
      }
      ratioConfirmed = await pollUntilReady(async () => {
        const selection = await readDolaRatioSelection().catch(() => ({ ratio: '', menuOpen: false }));
        snapshot = await readSnapshot();
        return matchesOption(selection.ratio, desiredRatio) || matchesOption(snapshot.ratio, desiredRatio);
      }, { timeoutMs: 2_500, intervalMs: 180 });
      if (!ratioConfirmed) await closeDolaMoreMenu();
    }

    if (!ratioConfirmed) {
      throw new Error(`Dola 视频比例配置回读失败: ${config.aspectRatio}`);
    }
    ratioReadbackEvidence = desiredRatio;
    await closeDolaMoreMenu();
  }

  const finalReadiness = await waitForVideoControlReadiness(async () => {
    snapshot = await readSnapshot();
    const liveRatioMatches = matchesOption(snapshot.ratio, desiredRatio);
    const liveRatioConflicts = Boolean(snapshot.ratio) && !liveRatioMatches;
    return {
      modelReady: currentMatchesModel(snapshot.model),
      compositeReady: matchesOption(snapshot.duration, desiredDuration) &&
        (liveRatioMatches || (!liveRatioConflicts && matchesOption(ratioReadbackEvidence, desiredRatio))),
    };
  }, { timeoutMs: 10_000, stableSamples: 3 });
  const reported = finalReadiness.ready ? finalReadiness : { ...finalReadiness, failureStage: 'final_readback' as const };
  await options?.onReadiness?.(reported);
  if (!finalReadiness.ready) throw new VideoControlReadinessError('final_readback', reported);
}

/**
 * 豆包 2026-08 创作页适配器。
 * 只点击用户已经看得见的页面控件；每次点击后的页面回读都是提交前置条件。
 */
async function configureVideoOptionsV2(
  webview: WebviewHandle,
  config: { model: string; duration: string; aspectRatio: string },
  options?: {
    platform?: 'doubao' | 'dola';
    onReadiness?: (result: VideoControlReadinessResult) => void | Promise<void>;
  },
): Promise<void> {
  const modelLabel = getVideoModelUiLabel(config.model);
  const durationSeconds = Number.parseInt(config.duration.replace(/s$/i, ''), 10);
  const durationAllowed = durationSeconds >= 4 && (durationSeconds <= 15 || durationSeconds === 30);
  if (!modelLabel || !Number.isInteger(durationSeconds) || !durationAllowed ||
      !/^(?:auto|[0-9]+:[0-9]+)$/i.test(config.aspectRatio)) {
    throw new Error('视频配置无效，已在提交前停止');
  }

  const click = async (position: string | undefined, label: string): Promise<void> => {
    if (!position) throw new Error(`${label}不可见，已在提交前停止`);
    const [x, y] = position.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${label}坐标无效，已在提交前停止`);
    // webview.sendInputEvent 的坐标在新版嵌套页面会落到宿主视口而非创作页。
    // 这里按页面内命中元素派发完整指针/鼠标序列，仍只触发用户可见控件。
    const activated = await safeExecuteJS<boolean>(webview, `
      (function () {
        var x = ${x}; var y = ${y};
        var target = document.elementFromPoint(x, y);
        if (!target) return false;
        var r = target.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
        try { target.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts))); } catch (_) {}
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        try { target.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts))); } catch (_) {}
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));
        return true;
      })()
    `, 5000, `activate_${label}`);
    if (!activated) throw new Error(`${label}无法激活，已在提交前停止`);
    await sleep(80);
  };

  const page = async <T>(code: string, label: string): Promise<T> =>
    safeExecuteJS<T>(webview, code, 5000, label);

  const membershipBlocked = async (): Promise<boolean> => page<boolean>(`
    (function () {
      var nodes = Array.from(document.querySelectorAll('[role="dialog"], [role="alert"], [class*="modal"], [class*="toast"], [class*="popover"]'));
      var visiblePrompt = nodes.some(function (node) {
        var r = node.getBoundingClientRect();
        var text = (node.innerText || '').replace(/\\s+/g, '');
        return r.width > 0 && r.height > 0 && /升级会员|开通会员|会员专享|权益不足|购买会员/.test(text);
      });
      if (visiblePrompt) return true;
      // 2026-08 页面把升级面板放进跨源 iframe，父文档无法读取 innerText；
      // 只能依据可见 iframe 自身的 title/name/src 做安全判定，不能把它误报成模型回读失败。
      return Array.from(document.querySelectorAll('iframe')).some(function (frame) {
        var r = frame.getBoundingClientRect();
        var descriptor = [frame.title, frame.name, frame.getAttribute('aria-label'), frame.src].filter(Boolean).join(' ');
        return r.width > 0 && r.height > 0 && /订阅|会员|升级|subscribe|membership|upgrade/i.test(descriptor);
      });
    })()
  `, 'video_membership_probe').catch(() => false);

  const readCompositeControl = async (): Promise<DoubaoCompositeControlSnapshot> =>
    page<DoubaoCompositeControlSnapshot>(buildDoubaoCompositeControlProbe('read'), 'read_video_composite');

  // 模式切换后 React 会先显示创作栏、再挂载参数控件。必须等两个权威控件
  // 都实际可用后才继续；30 秒后仍未挂载则 fail-closed，不猜测、更不提交。
  const waitForAuthoritativeControls = async (): Promise<VideoControlReadinessResult> => {
    return waitForVideoControlReadiness(async () => {
      const modelReady = await page<boolean>(`
        (function () {
          function usable(el) {
            if (!el) return false;
            var r = el.getBoundingClientRect();
            return r.width > 20 && r.height > 20 && r.top > window.innerHeight * 0.5 &&
              r.bottom <= window.innerHeight + 1 && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
          }
          return Array.from(document.querySelectorAll(${JSON.stringify(VIDEO_MODEL_CONTROL_SELECTOR)})).some(usable);
        })()
      `, 'wait_video_controls').catch(() => false);
      const composite = await readCompositeControl();
      return {
        modelReady,
        compositeReady: isVideoCompositeControlText(composite.text),
      };
    }, { timeoutMs: 30_000, stableSamples: 3 });
  };

  const readiness = await waitForAuthoritativeControls();
  await options?.onReadiness?.(readiness);
  if (!readiness.ready) {
    throw new VideoControlReadinessError(readiness.failureStage || 'stable_readback', readiness);
  }

  const findModelTrigger = async (): Promise<string | undefined> => {
    const result = await page<{ position?: string }>(`
      (function () {
        function usable(el) {
          if (!el) return false;
          var r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 20 && r.top > window.innerHeight * 0.5 &&
            r.bottom <= window.innerHeight + 1 && r.width < 320 && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
        }
        var authoritative = document.querySelector(${JSON.stringify(VIDEO_MODEL_CONTROL_SELECTOR)});
        if (usable(authoritative)) {
          var authoritativeRect = authoritative.getBoundingClientRect();
          return { position: Math.round(authoritativeRect.left + authoritativeRect.width / 2) + ',' + Math.round(authoritativeRect.top + authoritativeRect.height / 2) };
        }
        var candidates = Array.from(document.querySelectorAll('button,[role="button"],div')).filter(function (el) {
          var r = el.getBoundingClientRect();
          var text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
          return usable(el) && /^模型(?:\\s|$)/.test(text);
        });
        candidates.sort(function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });
        var el = candidates[candidates.length - 1];
        if (!el) return {};
        var r = el.getBoundingClientRect();
        return { position: Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2) };
      })()
    `, 'find_video_model_trigger');
    return result.position;
  };

  const selectExactOverlayOption = async (expected: string | readonly string[], label: string): Promise<string | undefined> => {
    const expectedValues = typeof expected === 'string' ? [expected] : [...expected];
    const result = await page<{ position?: string }>(`
      (function () {
        var expected = ${JSON.stringify(expectedValues)};
        // 新版比例面板的选项不是扁平 button：文字经常嵌在多层 div/span 中。
        // 选择“精确文本的最内层可见节点”，不能再以 children.length 猜测结构。
        var leaves = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],button,[role="button"],li,div,span')).filter(function (el) {
          var r = el.getBoundingClientRect();
          var text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
          if (r.width <= 8 || r.height <= 8 || expected.indexOf(text) < 0) return false;
          return !Array.from(el.children).some(function (child) {
            return expected.indexOf((child.innerText || '').replace(/\\s+/g, ' ').trim()) >= 0;
          });
        });
        leaves.sort(function (a, b) { return a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height; });
        var el = leaves[0];
        if (!el) return {};
        var r = el.getBoundingClientRect();
        return { position: Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2) };
      })()
    `, `select_${label}`);
    return result.position;
  };

  const waitForExactOverlayOption = async (expected: string | readonly string[], label: string): Promise<string | undefined> => {
    let found: string | undefined;
    await pollUntilReady(async () => {
      const position = await selectExactOverlayOption(expected, label).catch(() => undefined);
      if (position) {
        found = position;
        return true;
      }
      if (await membershipBlocked()) {
        throw new Error('membership_required: 视频参数需要会员操作，已停止提交');
      }
      return false;
    }, { timeoutMs: 10_000 });
    return found;
  };

  const verifyModel = async (): Promise<boolean> => page<boolean>(`
    (function () {
      function matches(el) {
        if (!el) return false;
        var r = el.getBoundingClientRect();
        var text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        return r.width > 20 && r.height > 20 && r.top > window.innerHeight * 0.5 &&
          text.indexOf('模型 ') === 0 && text.slice(3).trim() === ${JSON.stringify(modelLabel)};
      }
      var authoritative = document.querySelector(${JSON.stringify(VIDEO_MODEL_CONTROL_SELECTOR)});
      if (matches(authoritative)) return true;
      return Array.from(document.querySelectorAll('button,[role="button"],div')).some(function (el) {
        return matches(el);
      });
    })()
  `, 'verify_video_model');

  const waitForModelVerification = async (): Promise<boolean> => {
    return pollUntilReady(() => verifyModel().catch(() => false), { timeoutMs: 10_000 });
  };

  const openComposite = async (): Promise<void> => {
    // 模型切换会卸载参数入口。只在点击前等待，成功派发一次后立即停止，
    // 不重复切换弹层；超时沿用现有提交前恢复状态，而不是直接记任务失败。
    const result = await waitForVideoControlReadiness(async () => {
      if (await membershipBlocked()) throw new Error('membership_required: 视频参数需要会员操作，已停止提交');
      const control = await page<DoubaoCompositeControlSnapshot>(
        buildDoubaoCompositeControlProbe('open'), 'open_video_composite',
      );
      return { modelReady: true, compositeReady: control.activated };
    }, { timeoutMs: 10_000, stableSamples: 1 });
    if (!result.ready) {
      await options?.onReadiness?.(result);
      throw new VideoControlReadinessError('composite_control', result);
    }
  };

  // 模型：已与目标一致时绝不重开菜单。新版页面会在触发器文本中直接回显
  // 当前模型，重复选择反而会因菜单动画而制造“选项不可见”的假失败。
  if (!await verifyModel()) {
    await click(await findModelTrigger(), '视频模型控件');
    if (await membershipBlocked()) throw new Error('membership_required: 视频模型需要会员操作，已停止提交');
    await click(await waitForExactOverlayOption(modelLabel, 'video_model'), '视频模型选项');
    if (!await waitForModelVerification()) throw new Error(`视频模型配置回读失败: ${config.model}`);
  }

  const readCompositeLabels = async (): Promise<string[]> => {
    const control = await readCompositeControl();
    return control.text ? [control.text] : [];
  };

  const currentCompositeLabel = async (): Promise<string | undefined> => {
    const labels = await readCompositeLabels();
    return labels.find((label) => isVideoCompositeControlText(label));
  };

  // 比例已经正确时不要再次点击同一选项。豆包弹层会保持打开，随后再次点击
  // 组合触发器等价于把弹层关掉，旧代码因此误报“视频时长控件不可见”。
  const beforeComposite = await currentCompositeLabel();
  const currentRatio = parseVideoCompositeControlText(beforeComposite || '')?.ratio;
  const desiredRatio = parseVideoCompositeControlText(getVideoCompositeLabel(config.aspectRatio, config.duration))?.ratio;
  if (currentRatio !== desiredRatio) {
    await openComposite();
    if (await membershipBlocked()) throw new Error('membership_required: 视频参数需要会员操作，已停止提交');
    await click(await waitForExactOverlayOption(config.aspectRatio, 'video_ratio'), '视频比例选项');
    await sleep(250);
  }
  // 比例切换后，豆包会保留当前时长。截图已证明 10s 会直接回显为
  // “9:16 · 10s”；此时新版面板的滑条没有 role=slider，也不应把
  // 已满足的配置误判为失败。
  const expectedComposite = getVideoCompositeLabel(config.aspectRatio, config.duration);
  const isCompositeAlreadyConfigured = async (): Promise<boolean> => {
    const labels = await readCompositeLabels();
    return labels.some((label) => matchesVideoCompositeControlText(label, config.aspectRatio, config.duration));
  };
  const verifyFinalStableReadback = async (): Promise<void> => {
    const finalResult = await waitForVideoControlReadiness(async () => ({
      modelReady: await verifyModel().catch(() => false),
      compositeReady: await isCompositeAlreadyConfigured().catch(() => false),
    }), { timeoutMs: 10_000, stableSamples: 3 });
    const reported = finalResult.ready ? finalResult : { ...finalResult, failureStage: 'final_readback' as const };
    await options?.onReadiness?.(reported);
    if (!finalResult.ready) throw new VideoControlReadinessError('final_readback', reported);
  };
  if (await membershipBlocked()) throw new Error('membership_required: 视频参数需要会员操作，已停止提交');
  if (await isCompositeAlreadyConfigured()) {
    await verifyFinalStableReadback();
    return;
  }

  type DurationSliderCandidate = VideoDurationSliderSnapshot & { position: string };
  const readDurationSliders = async (): Promise<DurationSliderCandidate[]> => page<DurationSliderCandidate[]>(`
    (function () {
      function numberAttribute(node, ariaName, nativeName) {
        var raw = node.getAttribute(ariaName);
        if ((raw === null || raw === '') && nativeName) raw = node.getAttribute(nativeName);
        if ((raw === null || raw === '') && nativeName && nativeName in node) raw = String(node[nativeName]);
        if (raw === null || raw === '') return null;
        var value = Number(raw);
        return Number.isFinite(value) ? value : null;
      }
      return Array.from(document.querySelectorAll('[role="slider"],input[type="range"],[aria-valuemin][aria-valuemax]')).map(function (node) {
        var r = node.getBoundingClientRect();
        return {
          position: Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2),
          min: numberAttribute(node, 'aria-valuemin', 'min'),
          max: numberAttribute(node, 'aria-valuemax', 'max'),
          now: numberAttribute(node, 'aria-valuenow', 'value'),
          valueText: node.getAttribute('aria-valuetext') || node.getAttribute('aria-label') || '',
          visible: r.width > 0 && r.height > 0
        };
      }).filter(function (item) {
        return item.visible && item.min !== null && item.max !== null;
      }).map(function (item) {
        return { position: item.position, min: item.min, max: item.max, now: item.now, valueText: item.valueText };
      });
    })()
  `, 'find_video_duration_slider');

  const pickDurationSlider = async (): Promise<{ candidate: DurationSliderCandidate; target: VideoDurationSliderTarget } | null> => {
    const candidates = await readDurationSliders();
    for (const candidate of candidates) {
      const target = resolveVideoDurationSliderTarget(candidate, durationSeconds);
      if (target) return { candidate, target };
    }
    return null;
  };

  let slider = await pickDurationSlider();
  if (!slider) {
    await openComposite();
    // 弹层动画与滑杆挂载并非同步，不用固定延迟后的一次查询判定缺失。
    await pollUntilReady(async () => {
      if (await membershipBlocked()) throw new Error('membership_required: 视频参数需要会员操作，已停止提交');
      slider = await pickDurationSlider();
      return slider !== null;
    }, { timeoutMs: 10_000 });
  }

  // 兼容仍把 30 秒展示成离散选项的旧页面；新版优先使用 4–30 秒滑杆。
  if (!slider && durationSeconds === 30) {
    const durationLabels = ['30s', '30 秒', '30秒'] as const;
    const durationPosition = await waitForExactOverlayOption(durationLabels, 'video_duration_30');
    await click(durationPosition, '30 秒视频时长选项');
    await sleep(350);
    if (await membershipBlocked()) throw new Error('membership_required: 30 秒视频需要会员操作，已停止提交');
    await verifyFinalStableReadback();
    return;
  }

  if (!slider) throw new Error(`视频时长控件不可见或刻度不受支持: ${config.duration}`);
  if (typeof webview.sendInputEvent !== 'function') {
    throw new Error(`视频时长控件无法接收原生键盘输入: ${config.duration}`);
  }

  const [sliderX, sliderY] = slider.candidate.position.split(',').map(Number);
  if (!Number.isFinite(sliderX) || !Number.isFinite(sliderY)) {
    throw new Error(`视频时长控件坐标无效: ${config.duration}`);
  }
  // 前台交互租约已锁定账号；在页内聚焦刚读取的滑块，避免嵌套视口坐标偏差
  // 把 Home/Right 发给编辑器或页面。焦点未确认时禁止继续配置和提交。
  const sliderFocused = await page<boolean>(`
    (function () {
      var candidates = Array.from(document.querySelectorAll('[role="slider"],input[type="range"],[aria-valuemin][aria-valuemax]'));
      var node = candidates.find(function (candidate) {
        var r = candidate.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !candidate.disabled &&
          candidate.getAttribute('aria-disabled') !== 'true' &&
          Math.round(r.left + r.width / 2) === ${sliderX} &&
          Math.round(r.top + r.height / 2) === ${sliderY};
      });
      if (!node) return false;
      node.focus({ preventScroll: true });
      return document.activeElement === node;
    })()
  `, 'focus_video_duration_slider');
  if (!sliderFocused) {
    throw new Error(`视频时长控件未获得焦点，已在提交前停止: ${config.duration}`);
  }
  const keySequence = buildVideoDurationSliderKeySequence(slider.candidate, durationSeconds);
  for (const keyCode of keySequence) {
    webview.sendInputEvent({ type: 'keyDown', keyCode });
    webview.sendInputEvent({ type: 'keyUp', keyCode });
    // Home 也需留出状态更新窗口，避免紧接的方向键读取复位前的旧值。
    await sleep(40);
  }

  let configured = { slider: false, composite: false, actual: '' };
  await pollUntilReady(async () => {
    const state = await page<{ sliders: VideoDurationSliderSnapshot[] }>(`
      (function () {
        function numberAttribute(node, ariaName, nativeName) {
          var raw = node.getAttribute(ariaName);
          if ((raw === null || raw === '') && nativeName) raw = node.getAttribute(nativeName);
          if ((raw === null || raw === '') && nativeName && nativeName in node) raw = String(node[nativeName]);
          if (raw === null || raw === '') return null;
          var value = Number(raw);
          return Number.isFinite(value) ? value : null;
        }
        var sliders = Array.from(document.querySelectorAll('[role="slider"],input[type="range"],[aria-valuemin][aria-valuemax]')).map(function (node) {
          var r = node.getBoundingClientRect();
          return {
            min: numberAttribute(node, 'aria-valuemin', 'min'),
            max: numberAttribute(node, 'aria-valuemax', 'max'),
            now: numberAttribute(node, 'aria-valuenow', 'value'),
            valueText: node.getAttribute('aria-valuetext') || node.getAttribute('aria-label') || '',
            visible: r.width > 0 && r.height > 0
          };
        }).filter(function (item) {
          return item.visible && item.min !== null && item.max !== null;
        }).map(function (item) {
          return { min: item.min, max: item.max, now: item.now, valueText: item.valueText };
        });
        return { sliders: sliders };
      })()
    `, 'verify_video_composite');
    const labels = await readCompositeLabels();
    const actual = labels.find((label) => isVideoCompositeControlText(label)) || '';
    const composite = labels.some((label) => matchesVideoCompositeControlText(label, config.aspectRatio, config.duration));
    const compatibleSliders = state.sliders.filter((candidate) => Boolean(resolveVideoDurationSliderTarget(candidate, durationSeconds)));
    configured = {
      slider: compatibleSliders.some((candidate) => {
        const target = resolveVideoDurationSliderTarget(candidate, durationSeconds);
        return Boolean(target && candidate.now === target.targetValue);
      }) || (compatibleSliders.length === 0 && composite),
      composite,
      actual,
    };
    return configured.slider && configured.composite;
  }, { timeoutMs: 3_000, intervalMs: 200 });
  if (await membershipBlocked()) throw new Error('membership_required: 视频参数需要会员操作，已停止提交');
  if (!configured.slider || !configured.composite) {
    throw new Error(`视频比例或时长配置回读失败: 目标 ${expectedComposite}，实际 ${configured.actual || '未读取'}`);
  }
  await verifyFinalStableReadback();
}


/**
 * 上传参考图片
 * 通过 webview 的文件输入元素上传本地图片
 * 注意：此函数会先尝试找到文件输入元素并注入文件
 */
export async function uploadReferenceImages(
  webview: WebviewHandle,
  fileDataList: Array<{ name: string; base64: string; mime: string }>,
  options: { timeoutMs?: number; stableSamples?: number; signal?: AbortSignal; onProgress?: (diagnostic: UploadReadinessDiagnostic) => void | Promise<void> } = {},
): Promise<boolean> {
  if (!fileDataList || fileDataList.length === 0) return true;
  if (fileDataList.length > MAX_REFERENCE_IMAGE_COUNT) {
    console.warn(`[doubaoBridge] 参考图片超过上限: ${fileDataList.length}/${MAX_REFERENCE_IMAGE_COUNT}`);
    return false;
  }

  console.log(`[doubaoBridge] 上传参考图片: ${fileDataList.length} 张`);

  const fileNames = fileDataList.map((file) => file.name);
  const snapshotCode = buildImageUploadSnapshotProbe(fileNames);

  let baselineAttachmentCount = 0;
  try {
    const baseline = await safeExecuteJS<UploadReadinessSnapshot>(
      webview, snapshotCode, 5000, 'imageUploadBaseline',
    );
    baselineAttachmentCount = baseline.visibleAttachmentCount;
  } catch {
    return false;
  }

  // 构造 JS 代码，通过 DataTransfer 注入文件
  const filesJson = JSON.stringify(fileDataList);
  if (options.signal?.aborted) return false;
  const injectCode = `
    (function() {
      try {
        var fileDataList = ${filesJson};
        var root = ${buildComposerRootProbe()};
        var inputs = root ? root.querySelectorAll('input[type="file"]') : [];
        if (inputs.length === 0) {
          return { ok: false, error: '未找到 file input 元素' };
        }
        
        var inp = Array.from(inputs).find(function(input) {
          return /image|\\.(?:jpg|jpeg|png|webp)/i.test(input.accept || '');
        }) || inputs[0];
        var dataTransfer = new DataTransfer();
        
        for (var i = 0; i < fileDataList.length; i++) {
          var fd = fileDataList[i];
          // base64 解码为 ArrayBuffer
          var binary = atob(fd.base64);
          var bytes = new Uint8Array(binary.length);
          for (var j = 0; j < binary.length; j++) {
            bytes[j] = binary.charCodeAt(j);
          }
          var file = new File([bytes], fd.name, { type: fd.mime });
          dataTransfer.items.add(file);
        }
        
        inp.files = dataTransfer.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        
        return { ok: true, count: fileDataList.length };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })()
  `;

  const result = await safeExecuteJS<{ ok: boolean; count?: number; error?: string }>(
    webview,
    injectCode,
    5000,
    'injectFiles'
  );

  if (result?.ok) {
    console.log(`[doubaoBridge] 文件注入成功: ${result.count} 张，等待上传完成...`);
  } else {
    console.warn('[doubaoBridge] 文件注入失败:', result?.error);
    return false;
  }

  const startedAt = Date.now();
  const timeoutMs = Math.max(30_000, Math.min(options.timeoutMs || 180_000, 300_000));
  const stableSamples = Math.max(3, options.stableSamples || 3);
  let stableCount = 0;
  let attempt = 0;
  let lastDiagnostic: UploadReadinessDiagnostic = {
    attempts: 0, elapsedMs: 0, expectedCount: fileDataList.length,
    observedCount: 0, pending: true, stableSamples: 0, failure: 'pending',
  };
  while (Date.now() - startedAt < timeoutMs) {
    if (options.signal?.aborted) return false;
    attempt += 1;
    await sleep(Math.min(2500, 500 + attempt * 100));
    try {
      const snapshot = await safeExecuteJS<UploadReadinessSnapshot>(
        webview, snapshotCode, 5000, 'imageUploadReadiness',
      );
      if (options.signal?.aborted) return false;
      stableCount = nextStableUploadCount(stableCount, snapshot, fileDataList.length, baselineAttachmentCount);
      lastDiagnostic = {
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
        expectedCount: fileDataList.length,
        observedCount: getObservedUploadCount(snapshot, baselineAttachmentCount),
        pending: snapshot.pending,
        stableSamples: stableCount,
        failure: stableCount >= stableSamples ? undefined : classifyUploadReadinessFailure(snapshot, fileDataList.length, baselineAttachmentCount) || 'unstable',
      };
      await options.onProgress?.(lastDiagnostic);
      if (stableCount >= stableSamples) {
        console.log(`[doubaoBridge] 图片上传已连续稳定: ${fileDataList.length} 张`);
        return true;
      }
    } catch {
      stableCount = 0;
    }
  }
  await options.onProgress?.({ ...lastDiagnostic, elapsedMs: Date.now() - startedAt, failure: lastDiagnostic.failure || 'unstable' });
  console.warn(`[doubaoBridge] 图片未在 ${timeoutMs}ms 内达到数量完整且稳定状态`);
  return false;
}

/**
 * 上传参考音频文件（视频生成配音用）
 * 策略：先尝试找音频专属上传入口，找不到则尝试通用文件上传
 */
export async function uploadReferenceAudio(
  webview: WebviewHandle,
  fileData: { name: string; base64: string; mime: string }
): Promise<boolean> {
  console.log(`[doubaoBridge] 上传参考音频: ${fileData.name}`);

  const fileJson = JSON.stringify(fileData);
  const injectCode = `
    (function() {
      try {
        var fd = ${fileJson};
        
        // 策略1：找 accept 包含 audio 的 file input
        var audioInputs = document.querySelectorAll('input[type="file"]');
        var targetInput = null;
        
        for (var i = 0; i < audioInputs.length; i++) {
          var inp = audioInputs[i];
          var accept = (inp.accept || '').toLowerCase();
          if (accept.indexOf('audio') >= 0 || accept.indexOf('mp3') >= 0 || accept.indexOf('wav') >= 0) {
            targetInput = inp;
            break;
          }
        }
        
        // 策略2：找"音频"/"配音"/"音乐"/"BGM"相关按钮附近的 file input
        if (!targetInput) {
          var keywords = ['音频', '配音', '音乐', 'BGM', 'bgm', '语音', 'sound', 'audio', 'voice', 'music'];
          var allButtons = document.querySelectorAll('button, [role="button"], div[class*="btn"], div[class*="button"]');
          
          for (var i = 0; i < allButtons.length; i++) {
            var btn = allButtons[i];
            var text = (btn.textContent || '').trim();
            var matched = false;
            for (var k = 0; k < keywords.length; k++) {
              if (text.indexOf(keywords[k]) >= 0 && text.length < 20) {
                matched = true;
                break;
              }
            }
            if (matched) {
              // 在按钮附近找 file input
              var parent = btn.parentElement;
              for (var d = 0; d < 5 && parent; d++) {
                var nearbyInputs = parent.querySelectorAll('input[type="file"]');
                if (nearbyInputs.length > 0) {
                  targetInput = nearbyInputs[0];
                  break;
                }
                parent = parent.parentElement;
              }
              if (targetInput) break;
            }
          }
        }
        
        // 策略3：点击"添加音频"类按钮触发后再找 input（有些是动态出现的）
        if (!targetInput) {
          var clickKeywords = ['添加音频', '上传音频', '选择音频', '添加配音', '上传配音', '选择配音', '添加音乐', '上传音乐', '选择BGM', '添加BGM'];
          var allElements = document.querySelectorAll('button, span, div, a');
          for (var i = 0; i < allElements.length; i++) {
            var el = allElements[i];
            var text = (el.textContent || '').trim();
            for (var k = 0; k < clickKeywords.length; k++) {
              if (text === clickKeywords[k] || text.indexOf(clickKeywords[k]) >= 0 && text.length < 15) {
                try {
                  el.click();
                } catch(e) {}
                // 等待一下再搜索
                break;
              }
            }
          }
          // 重新搜索 audio input
          var allInputs2 = document.querySelectorAll('input[type="file"]');
          for (var i = 0; i < allInputs2.length; i++) {
            var inp2 = allInputs2[i];
            var accept2 = (inp2.accept || '').toLowerCase();
            if (accept2.indexOf('audio') >= 0 || accept2.indexOf('mp3') >= 0) {
              targetInput = inp2;
              break;
            }
          }
        }
        
        if (!targetInput) {
          return { ok: false, error: '未找到音频上传入口' };
        }
        
        // 构造 File 并注入
        var binary = atob(fd.base64);
        var bytes = new Uint8Array(binary.length);
        for (var j = 0; j < binary.length; j++) {
          bytes[j] = binary.charCodeAt(j);
        }
        var file = new File([bytes], fd.name, { type: fd.mime });
        
        var dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        targetInput.files = dataTransfer.files;
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        
        return { ok: true, method: targetInput.accept || 'default' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })()
  `;

  const result = await safeExecuteJS<{ ok: boolean; method?: string; error?: string }>(
    webview,
    injectCode,
    8000,
    'injectAudio'
  );

  if (result?.ok) {
    console.log(`[doubaoBridge] 音频上传成功, 方法: ${result.method}`);
  } else {
    console.warn('[doubaoBridge] 音频上传失败:', result?.error);
  }

  return result?.ok || false;
}

/**
 * 批量上传参考视频或音频。页面可能把两类素材挂在同一个 file input，
 * 因此必须一次性使用 DataTransfer 注入完整列表，不能逐个覆盖前一个文件。
 */
export async function uploadReferenceFiles(
  webview: WebviewHandle,
  fileDataList: Array<{ name: string; base64: string; mime: string }>,
  kind: 'video' | 'audio',
): Promise<boolean> {
  if (fileDataList.length === 0) return true;
  const limit = kind === 'video' ? REFERENCE_VIDEO_LIMIT : REFERENCE_AUDIO_LIMIT;
  if (fileDataList.length > limit) {
    console.warn(`[doubaoBridge] 参考${kind === 'video' ? '视频' : '音频'}超过上限: ${fileDataList.length}/${limit}`);
    return false;
  }
  const payload = JSON.stringify(fileDataList);
  const labels = kind === 'video'
    ? ['视频', 'video', 'mp4', 'mov', 'webm']
    : ['音频', '配音', '音乐', 'bgm', 'audio', 'voice', 'mp3', 'wav'];
  const uploadToken = `lalor-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const snapshotCode = `
    (function() {
      var root = document.body;
      var target = document.querySelector('input[data-lalor-upload-token="${uploadToken}"]');
      var visible = function(el) {
        if (!el || el.offsetParent === null) return false;
        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        return rect.width > 12 && rect.height > 12 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      var attachments = Array.from(root.querySelectorAll('img,video,audio,[class*="thumb"],[class*="preview"],[class*="attachment"],[class*="upload-item"]')).filter(visible);
      return {
        inputFileCount: target && target.files ? target.files.length : 0,
        visibleAttachmentCount: attachments.length,
        matchingFileNameCount: 0,
        pending: ${buildUploadPendingProbe(buildComposerRootProbe())}
      };
    })()
  `;
  let baselineAttachmentCount = 0;
  try {
    const baseline = await safeExecuteJS<UploadReadinessSnapshot>(webview, snapshotCode, 5000, `${kind}UploadBaseline`);
    baselineAttachmentCount = baseline.visibleAttachmentCount;
  } catch {
    return false;
  }
  const injectCode = `
    (function() {
      try {
        var files = ${payload};
        var labels = ${JSON.stringify(labels)};
        var visible = function(el) {
          if (!el || el.offsetParent === null) return false;
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        var matchesAccept = function(input) {
          var accept = (input.accept || '').toLowerCase();
          return labels.some(function(label) { return accept.indexOf(label) >= 0; });
        };
        var inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        // file input 通常被 CSS 隐藏，不能用可见性过滤。
        var target = inputs.find(matchesAccept);
        if (!target) {
          var buttons = Array.from(document.querySelectorAll('button,[role="button"],label,[class*="button"],[class*="btn"]'));
          var button = buttons.find(function(el) {
            if (!visible(el)) return false;
            var text = (el.textContent || '').trim().toLowerCase();
            return text.length < 30 && labels.some(function(label) { return text.indexOf(label) >= 0; });
          });
          if (button) {
            var parent = button;
            for (var depth = 0; depth < 5 && parent && !target; depth++, parent = parent.parentElement) {
              target = Array.from(parent.querySelectorAll('input[type="file"]')).find(matchesAccept)
                || parent.querySelector('input[type="file"]');
            }
            try { button.click(); } catch (e) {}
          }
          inputs = Array.from(document.querySelectorAll('input[type="file"]'));
          target = target || inputs.find(matchesAccept);
          if (!target) {
            target = inputs.find(function(input) {
              var accept = (input.accept || '').toLowerCase();
              return !accept || accept.indexOf('image') < 0;
            });
          }
        }
        if (!target) return { ok: false, error: '未找到参考素材上传入口' };
        target.setAttribute('data-lalor-upload-token', '${uploadToken}');
        var transfer = new DataTransfer();
        files.forEach(function(item) {
          var binary = atob(item.base64);
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          transfer.items.add(new File([bytes], item.name, { type: item.mime }));
        });
        target.files = transfer.files;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, count: target.files ? target.files.length : files.length };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    })()
  `;
  const result = await safeExecuteJS<{ ok: boolean; count?: number; error?: string }>(
    webview,
    injectCode,
    10_000,
    `injectReference${kind}`,
  );
  if (!result?.ok || result.count !== fileDataList.length) {
    console.warn(`[doubaoBridge] 参考${kind === 'video' ? '视频' : '音频'}上传失败:`, result?.error || `数量 ${result?.count || 0}/${fileDataList.length}`);
    return false;
  }
  const startedAt = Date.now();
  let stableCount = 0;
  let attempt = 0;
  while (Date.now() - startedAt < 180_000) {
    attempt += 1;
    await sleep(Math.min(2500, 500 + attempt * 100));
    try {
      const snapshot = await safeExecuteJS<UploadReadinessSnapshot>(webview, snapshotCode, 5000, `${kind}UploadReadiness`);
      stableCount = nextStableUploadCount(stableCount, snapshot, fileDataList.length, baselineAttachmentCount);
      if (stableCount >= 3) return true;
    } catch {
      stableCount = 0;
    }
  }
  console.warn(`[doubaoBridge] 参考${kind === 'video' ? '视频' : '音频'}未在 180000ms 内达到数量完整且稳定状态`);
  return false;
}

export function uploadReferenceVideos(
  webview: WebviewHandle,
  fileDataList: Array<{ name: string; base64: string; mime: string }>,
): Promise<boolean> {
  return uploadReferenceFiles(webview, fileDataList, 'video');
}

export function uploadReferenceAudios(
  webview: WebviewHandle,
  fileDataList: Array<{ name: string; base64: string; mime: string }>,
): Promise<boolean> {
  return uploadReferenceFiles(webview, fileDataList, 'audio');
}

// ==================== 15秒视频生成注入 ====================

/**
 * 注入 15 秒视频生成补丁到豆包页面
 * 通过 monkey-patch fetch 和 XMLHttpRequest 拦截 /chat/completion 请求
 * 强制视频生成使用 15秒时长
 * 同时拦截 SSE 响应，提取 vid 和无水印视频地址存入 window.__doubaoVideoCache
 */
export async function inject15sVideoPatch(webview: WebviewHandle): Promise<boolean> {
  void webview;
  console.warn('[doubaoBridge] 15 秒请求改写能力已永久禁用；必须使用页面实时控件');
  return false;
  /* istanbul ignore next -- 历史实现不可达，待独立清理包删除。 */
  const injectCode = `
    (function() {
      if (window.__doubao15sPatched) return;
      window.__doubao15sPatched = true;
      window.__doubao15sPatchEnabled = false;
      window.__doubaoVideoCache = window.__doubaoVideoCache || {};

      function findVid(obj, depth) {
        if (depth === undefined) depth = 0;
        if (depth > 12 || !obj) return null;
        if (Array.isArray(obj)) {
          for (var i = 0; i < obj.length; i++) {
            var f = findVid(obj[i], depth + 1);
            if (f) return f;
          }
        } else if (typeof obj === 'object') {
          var vid = obj.vid || obj.video_id || obj.videoId || obj.key;
          if (vid && typeof vid === 'string' && vid.length >= 10) return vid;
          for (var key in obj) {
            if (obj.hasOwnProperty(key)) {
              var f = findVid(obj[key], depth + 1);
              if (f) return f;
            }
          }
        }
        return null;
      }

      function findAllPlayInfos(obj, results, depth) {
        if (depth === undefined) depth = 0;
        if (!results) results = [];
        if (depth > 10 || !obj) return results;
        if (Array.isArray(obj)) {
          for (var i = 0; i < obj.length; i++) {
            findAllPlayInfos(obj[i], results, depth + 1);
          }
        } else if (typeof obj === 'object') {
          if (obj.play_info) results.push(obj.play_info);
          for (var key in obj) {
            if (obj.hasOwnProperty(key) && key !== 'play_info') {
              findAllPlayInfos(obj[key], results, depth + 1);
            }
          }
        }
        return results;
      }

      function removeWatermark(url) {
        if (!url || typeof url !== 'string') return url;
        return url.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
      }

      function processVideoData(data) {
        try {
          var vid = findVid(data);
          if (vid) {
            window.__doubaoVideoCache.lastVid = vid;
            // 1. 优先查找 original_media_info（平台明确返回的原始产物）
            var om = findAllKey(data, 'original_media_info');
            for (var oi = 0; oi < om.length; oi++) {
              var omUrl = om[oi].main_url || om[oi].main || om[oi].url || om[oi].download_url;
              if (omUrl && typeof omUrl === 'string') {
                window.__doubaoVideoCache[vid] = omUrl;
                window.__doubaoVideoCache.lastVideoUrl = omUrl;
                window.__doubaoVideoCache.lastFieldSource = 'original_media_info';
                console.log('[15sPatch] 找到原始视频:', vid, omUrl.substring(0, 80) + '...');
                return;
              }
            }
            // 2. 查找 download_url（明确下载地址）
            var dlUrl = findFieldValue(data, 'download_url');
            if (dlUrl) {
              window.__doubaoVideoCache[vid] = dlUrl;
              window.__doubaoVideoCache.lastVideoUrl = dlUrl;
              window.__doubaoVideoCache.lastFieldSource = 'download_url';
              console.log('[15sPatch] 找到下载地址:', vid, dlUrl.substring(0, 80) + '...');
              return;
            }
            // 3. 回退到 play_info（普通播放地址，非原始产物）
            var playInfos = findAllPlayInfos(data);
            for (var i = 0; i < playInfos.length; i++) {
              var pi = playInfos[i];
              var mainUrl = pi.main || pi.main_url;
              if (mainUrl && typeof mainUrl === 'string') {
                window.__doubaoVideoCache[vid] = mainUrl;
                window.__doubaoVideoCache.lastVideoUrl = mainUrl;
                window.__doubaoVideoCache.lastFieldSource = 'play_info';
                console.log('[15sPatch] 找到视频:', vid, mainUrl.substring(0, 80) + '...');
                break;
              }
            }
          }
        } catch(e) {}
      }

      function findAllKey(obj, keyName, results, depth) {
        if (depth === undefined) depth = 0;
        if (!results) results = [];
        if (depth > 10 || !obj) return results;
        if (Array.isArray(obj)) {
          for (var i = 0; i < obj.length; i++) findAllKey(obj[i], keyName, results, depth + 1);
        } else if (typeof obj === 'object') {
          if (obj[keyName] && typeof obj[keyName] === 'object') results.push(obj[keyName]);
          for (var k in obj) {
            if (obj.hasOwnProperty(k) && k !== keyName) findAllKey(obj[k], keyName, results, depth + 1);
          }
        }
        return results;
      }

      function findFieldValue(obj, fieldName, depth) {
        if (depth === undefined) depth = 0;
        if (depth > 10 || !obj) return null;
        if (Array.isArray(obj)) {
          for (var i = 0; i < obj.length; i++) {
            var v = findFieldValue(obj[i], fieldName, depth + 1);
            if (v) return v;
          }
        } else if (typeof obj === 'object') {
          if (obj[fieldName] && typeof obj[fieldName] === 'string') return obj[fieldName];
          for (var k in obj) {
            if (obj.hasOwnProperty(k) && k !== fieldName) {
              var v2 = findFieldValue(obj[k], fieldName, depth + 1);
              if (v2) return v2;
            }
          }
        }
        return null;
      }

      function patchBody(rawBody) {
        try {
          if (!window.__doubao15sPatchEnabled) {
            return { changed: false, body: rawBody };
          }
          var payload = JSON.parse(rawBody);
          var ability = payload.chat_ability;
          if (!ability || Number(ability.ability_type) !== 17) {
            return { changed: false, body: rawBody };
          }
          var param;
          try { param = JSON.parse(ability.ability_param); } catch(e) { param = {}; }
          param.duration = 15;
          ability.ability_param = JSON.stringify(param);
          console.log('[15sPatch] 已注入 15s 参数，保留页面当前模型');
          return { changed: true, body: JSON.stringify(payload) };
        } catch(e) {
          return { changed: false, body: rawBody };
        }
      }

      function readSSEStream(reader) {
        var decoder = new TextDecoder();
        var buffer = '';
        function pump() {
          return reader.read().then(function(result) {
            if (result.done) return;
            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i];
              if (line.indexOf('data:') === 0) {
                var jsonStr = line.substring(5).trim();
                if (jsonStr) {
                  try {
                    var data = JSON.parse(jsonStr);
                    processVideoData(data);
                  } catch(e) {}
                }
              }
            }
            return pump();
          });
        }
        pump().catch(function() {});
      }

      var originalFetch = window.fetch;
      window.fetch = function patchedFetch(input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var isCompletion = url.indexOf('/chat/completion') >= 0;
        // 仅拦截明确的视频相关 API，避免误伤其他请求导致页面异常
        var isVideoApi = isCompletion ||
                         url.indexOf('get_play_info') >= 0 ||
                         url.indexOf('play_info') >= 0 ||
                         url.indexOf('/video/') >= 0;

        if (isCompletion && init && init.body) {
          try {
            var patched = patchBody(init.body);
            if (patched.changed) {
              init = Object.assign({}, init, { body: patched.body });
            }
          } catch(e) {}
        }

        return originalFetch.apply(this, [input, init]).then(function(resp) {
          if (isVideoApi && resp.body) {
            try {
              var ct = resp.headers.get('content-type') || '';
              if (ct.indexOf('text/event-stream') >= 0) {
                var teed = resp.body.tee();
                readSSEStream(teed[1].getReader());
                return new Response(teed[0], {
                  status: resp.status,
                  statusText: resp.statusText,
                  headers: resp.headers,
                });
              } else if (ct.indexOf('application/json') >= 0) {
                // 普通 JSON 响应（如 get_play_info），克隆一份解析
                return resp.clone().json().then(function(data) {
                  processVideoData(data);
                  return resp;
                }).catch(function() { return resp; });
              }
            } catch(e) {
              // 任何异常都不影响原始响应
              return resp;
            }
          }
          return resp;
        }).catch(function(err) {
          throw err; // 透传原始错误
        });
      };

      var originalXHROpen = XMLHttpRequest.prototype.open;
      var originalXHRSend = XMLHttpRequest.prototype.send;
      var xhrUrlMap = new WeakMap();

      XMLHttpRequest.prototype.open = function(method, url) {
        xhrUrlMap.set(this, url);
        return originalXHROpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function(body) {
        var url = xhrUrlMap.get(this) || '';
        var isCompletion = url.indexOf('/chat/completion') >= 0;

        if (isCompletion && body) {
          var patched = patchBody(body);
          if (patched.changed) { body = patched.body; }
        }

        this.addEventListener('load', function() {
          var xhrUrl = xhrUrlMap.get(this) || '';
          if (xhrUrl.indexOf('chain/single') >= 0 ||
              xhrUrl.indexOf('/chat/completion') >= 0 ||
              xhrUrl.indexOf('get_play_info') >= 0 ||
              xhrUrl.indexOf('play_info') >= 0 ||
              xhrUrl.indexOf('media/') >= 0) {
            try {
              var resp = JSON.parse(this.responseText);
              processVideoData(resp);
            } catch(e) {}
          }
        });

        return originalXHRSend.call(this, body);
      };

      console.log('[15sPatch] 15s 视频生成补丁已注入');
    })();
  `;

  try {
    await safeExecuteJS(webview, injectCode, 5000, 'inject15sPatch');
    return true;
  } catch (err: any) {
    console.warn('[doubaoBridge] 注入15s补丁失败:', err.message);
    return false;
  }
}

/**
 * 每个自动化任务开始前创建独立新对话，避免产物和缓存串到上一条会话。
 */
/**
 * 新对话就绪状态机结果。
 * ok=false 时必须携带脱敏、可定位的 reason，禁止把失败当作可继续发送。
 */
export interface NewConversationResult {
  ok: boolean;
  /** 脱敏失败原因（如 PAGE_NOT_READY / EDITOR_NOT_FOUND / SESSION_NOT_EMPTY），不含页面内部 ID */
  reason?: string;
}

/**
 * 创建新对话（P0-1 状态机）。
 *
 * 以真实页面状态为依据，不猜测按钮、不点击任意页面控件：
 * 1. 导航到豆包官方新会话入口（/chat/ 根路径即新会话）；
 * 2. 等待聊天输入框可用（textarea 或 contenteditable 可见）；
 * 3. 校验输入框可聚焦（可写入）；
 * 4. 校验当前会话没有历史用户内容（新会话语义），避免把旧会话当新会话继续。
 *
 * 任一状态不满足 → ok=false + 脱敏 reason（fail-closed）。
 */
export async function startNewConversation(webview: WebviewHandle, readinessTimeoutMs: number = 20000): Promise<NewConversationResult> {
  try {
    const chatRoot = getPlatformChatRoot(webview);
    if (!chatRoot) return { ok: false, reason: 'PLATFORM_UNRECOGNIZED' };
    webview.loadURL(chatRoot);
    const ready = await waitForChatReady(webview, readinessTimeoutMs);
    if (!ready) {
      return { ok: false, reason: 'PAGE_NOT_READY' };
    }

    const code = `
      (function() {
        var editor = null;
        var textareas = document.querySelectorAll('textarea');
        for (var i = 0; i < textareas.length; i++) {
          if (textareas[i].offsetParent !== null && !textareas[i].disabled) { editor = textareas[i]; break; }
        }
        if (!editor) {
          var editables = document.querySelectorAll('[contenteditable="true"], [contenteditable=""]');
          for (var j = 0; j < editables.length; j++) {
            if (editables[j].offsetParent !== null) { editor = editables[j]; break; }
          }
        }
        if (!editor) return { ok: false, reason: 'EDITOR_NOT_FOUND' };
        editor.focus();
        var focusable = document.activeElement === editor || editor.contains(document.activeElement);
        if (!focusable) return { ok: false, reason: 'EDITOR_NOT_FOCUSABLE' };
        // 新会话语义校验：会话区不应已存在用户气泡（推荐/欢迎内容不计）。
        var userBubbles = document.querySelectorAll('[class*="user"], [class*="User"], [data-role="user"]');
        var hasUserContent = false;
        for (var u = 0; u < userBubbles.length; u++) {
          var b = userBubbles[u];
          if (b.offsetParent === null) continue;
          var r = b.getBoundingClientRect();
          if (r.width < 40 || r.height < 20) continue;
          var bt = String(b.innerText || '').replace(/\\s+/g, ' ').trim();
          if (bt.length > 2) { hasUserContent = true; break; }
        }
        return { ok: true, reason: hasUserContent ? 'SESSION_NOT_EMPTY' : 'READY', focusable: focusable };
      })();
    `;
    const result = await safeExecuteJS<{ ok: boolean; reason: string }>(webview, code, 8000, 'startNewConversation');
    if (!result || result.ok !== true) {
      const reason = (result && result.reason) || 'PAGE_UNKNOWN';
      console.warn('[doubaoBridge] 新对话未就绪:', reason);
      return { ok: false, reason };
    }
    if (result.reason === 'SESSION_NOT_EMPTY') {
      // 导航后页面恢复了旧会话：不点击任何按钮，按失败处理并提示。
      console.warn('[doubaoBridge] 新对话页面包含已有用户内容，拒绝继续');
      return { ok: false, reason: 'SESSION_NOT_EMPTY' };
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    console.log('[doubaoBridge] 新对话已就绪（页面状态机验证通过）');
    return { ok: true };
  } catch (err: any) {
    console.warn('[doubaoBridge] 创建新对话失败:', err.message);
    return { ok: false, reason: 'EXECUTION_FAILED' };
  }
}

export interface PostSubmitGenerationInspection {
  verificationVisible: boolean;
  generationReceipt: boolean;
  generationActive: boolean;
  videoOutput: boolean;
  evidence?: 'receipt' | 'active' | 'video';
}

export interface PostSubmitGenerationInspectionOptions {
  /** 只接受该时间点之后由本次提交产生的网络监控状态。 */
  generationStartAfter?: number;
}

/**
 * 读取提交后的验证层与生成证据。
 *
 * 页面验证完成后可能只移除交互状态，保留原 iframe/class 节点；因此不能
 * 看到验证节点就立即暂停。这里同时读取可见的助手消息、生成控件、网络
 * 监控和视频元素，返回脱敏布尔证据，不点击页面、不提交表单、不处理验证码。
 */
export async function inspectPostSubmitGenerationState(
  webview: WebviewHandle,
  options: PostSubmitGenerationInspectionOptions = {},
): Promise<PostSubmitGenerationInspection> {
  const generationStartAfter = Number.isFinite(options.generationStartAfter)
    ? Math.max(0, Math.floor(options.generationStartAfter || 0))
    : 0;
  const code = `
    (function() {
      function visible(el) {
        if (!el) return false;
        try {
          var current = el;
          while (current && current !== document.documentElement) {
            var style = window.getComputedStyle(current);
            if (style.display === 'none' || style.visibility === 'hidden' ||
                Number(style.opacity) === 0 || current.getAttribute('aria-hidden') === 'true') return false;
            current = current.parentElement;
          }
          var rect = el.getBoundingClientRect();
          return rect.width > 2 && rect.height > 2 && rect.right > 0 && rect.bottom > 0 &&
            rect.left < window.innerWidth && rect.top < window.innerHeight;
        } catch (_) { return false; }
      }
      function textOf(el) {
        return String((el && (el.innerText || el.textContent)) || '')
          .replace(/\\s+/g, ' ').trim();
      }
      function containsAny(value, list) {
        var lower = String(value || '').toLowerCase();
        for (var i = 0; i < list.length; i++) {
          if (lower.indexOf(list[i]) >= 0) return true;
        }
        return false;
      }
      function isTopmost(el) {
        try {
          var rect = el.getBoundingClientRect();
          var x = Math.max(1, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
          var y = Math.max(1, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
          var top = document.elementFromPoint(x, y);
          return top === el || (top && el.contains(top));
        } catch (_) { return true; }
      }
      function isUserMessage(el) {
        var marker = [
          el.getAttribute && el.getAttribute('data-role'),
          el.getAttribute && el.getAttribute('data-message-role'),
          el.className && String(el.className),
        ].join(' ').toLowerCase();
        return /(^|[-_ ])(?:user|human|question)(?:$|[-_ ])/i.test(marker);
      }

      var verificationVisible = false;
      var frames = document.querySelectorAll('iframe');
      for (var f = 0; f < frames.length; f++) {
        if (!visible(frames[f])) continue;
        var frameRect = frames[f].getBoundingClientRect();
        if (frameRect.width < 100 || frameRect.height < 80 || !isTopmost(frames[f])) continue;
        var frameSrc = String(frames[f].src || '').toLowerCase();
        if (frameSrc.indexOf('captcha') >= 0 || frameSrc.indexOf('verify') >= 0 ||
            frameSrc.indexOf('challenge') >= 0 || frameSrc.indexOf('secsdk') >= 0) {
          verificationVisible = true;
          break;
        }
      }
      if (!verificationVisible) {
        var verificationNodes = document.querySelectorAll(
          '[role="dialog"],[role="alert"],[class*="captcha"],[class*="verify"],[class*="Verify"],[class*="challenge"],[class*="Challenge"]'
        );
        var verificationPhrases = ['请完成验证', '安全验证', '机器人验证', '拖动滑块', '点击进行验证', '验证后继续', '人机验证', 'verify to continue', 'security verification'];
        for (var v = 0; v < verificationNodes.length; v++) {
          if (visible(verificationNodes[v]) && isTopmost(verificationNodes[v]) && containsAny(textOf(verificationNodes[v]), verificationPhrases)) {
            verificationVisible = true;
            break;
          }
        }
      }

      var generationReceipt = false;
      var generationActive = false;
      var videoOutput = false;
      var messageSelectors = '[data-message-id],[data-testid*="message"],[class*="message"],[class*="bubble"],[role="status"],[aria-live="polite"]';
      var receiptPhrases = [
        '视频生成已提交', '视频生成任务已提交', '生成任务已提交',
        '视频生成完成', '视频生成好了', '你的视频生成好了', '您的视频生成好了',
        '视频已生成', 'video generation complete', 'video is ready', 'generation submitted'
      ];
      var activePhrases = [
        '正在为您生成', '正在生成视频', '视频生成中', '生成任务排队',
        'generating video', 'queued for generation'
      ];
      var messages = document.querySelectorAll(messageSelectors);
      for (var m = 0; m < messages.length; m++) {
        if (!visible(messages[m]) || isUserMessage(messages[m])) continue;
        var messageText = textOf(messages[m]);
        if (containsAny(messageText, receiptPhrases)) generationReceipt = true;
        if (containsAny(messageText, activePhrases)) generationActive = true;
      }

      // 停止按钮是生成中的强证据；只接受可见控件。
      var stopSelectors = [
        'button[aria-label*="停止"]', 'button[aria-label*="stop"]',
        'button[aria-label*="Stop"]', '[class*="stop-generat"]', '[class*="StopGenerat"]'
      ];
      for (var s = 0; s < stopSelectors.length && !generationActive; s++) {
        var stopNodes = document.querySelectorAll(stopSelectors[s]);
        for (var q = 0; q < stopNodes.length; q++) {
          if (visible(stopNodes[q])) { generationActive = true; break; }
        }
      }

      var state = window.__genState || {};
      var monitorStart = Number(state.startTime || 0);
      var monitorEnd = Number(state.endTime || 0);
      var monitorBaseline = ${generationStartAfter};
      if (state.generating && monitorStart > 0 &&
          (monitorStart > monitorBaseline || (monitorBaseline === 0 && Number(state.lastUpdate || 0) > 0))) {
        generationActive = true;
      }
      if (!state.generating && monitorEnd > 0 && monitorStart > 0 &&
          monitorStart > monitorBaseline && Number(state.sseDataCount || 0) > 0) {
        generationReceipt = true;
      }

      var videos = document.querySelectorAll('video');
      for (var x = 0; x < videos.length; x++) {
        if (!visible(videos[x])) continue;
        var messageAncestor = videos[x].closest && videos[x].closest(
          '[data-message-id],[data-testid*="message"],[class*="message"],[class*="bubble"],article'
        );
        // 优先要求视频位于会话消息中；部分 Dola 版本没有稳定消息属性，
        // 此时保留尺寸足够大的媒体作为证据，避免残留验证层再次误暂停。
        if (messageAncestor && isUserMessage(messageAncestor)) continue;
        var videoRect = videos[x].getBoundingClientRect();
        if (!messageAncestor && (videoRect.width < 200 || videoRect.height < 100)) continue;
        var source = String(videos[x].currentSrc || videos[x].src || '');
        if (!source) {
          var sourceNodes = videos[x].querySelectorAll('source');
          for (var y = 0; y < sourceNodes.length; y++) {
            source = String(sourceNodes[y].src || '');
            if (source) break;
          }
        }
        if (/^(?:https?:|blob:)/i.test(source)) { videoOutput = true; break; }
      }
      var cache = window.__doubaoVideoCache || {};
      if (typeof cache.lastVideoUrl === 'string' && cache.lastVideoUrl.trim()) videoOutput = true;

      var evidence = videoOutput ? 'video' : generationActive ? 'active' : generationReceipt ? 'receipt' : undefined;
      return { verificationVisible: verificationVisible, generationReceipt: generationReceipt,
        generationActive: generationActive, videoOutput: videoOutput, evidence: evidence };
    })();
  `;
  try {
    const result = await safeExecuteJS<PostSubmitGenerationInspection>(
      webview, code, 5000, 'inspectPostSubmitGenerationState',
    );
    return {
      verificationVisible: result?.verificationVisible === true,
      generationReceipt: result?.generationReceipt === true,
      generationActive: result?.generationActive === true,
      videoOutput: result?.videoOutput === true,
      evidence: result?.evidence,
    };
  } catch {
    return {
      verificationVisible: false,
      generationReceipt: false,
      generationActive: false,
      videoOutput: false,
    };
  }
}

/** 检测提交后出现的机器人/安全验证界面。 */
export async function detectRobotVerification(webview: WebviewHandle): Promise<boolean> {
  const inspection = await inspectPostSubmitGenerationState(webview);
  return inspection.verificationVisible;
}

/** 启用或关闭已经注入的 15 秒请求补丁。 */
export async function set15sVideoPatchEnabled(webview: WebviewHandle, enabled: boolean): Promise<boolean> {
  void webview;
  void enabled;
  return false;
  /* istanbul ignore next -- 历史实现不可达。 */
  try {
    const result = await safeExecuteJS<boolean>(
      webview,
      `(function() {
        window.__doubao15sPatchEnabled = ${enabled ? 'true' : 'false'};
        console.log('[15sPatch] 手动开关:', window.__doubao15sPatchEnabled ? '开启' : '关闭');
        return window.__doubao15sPatchEnabled;
      })();`,
      5000,
      'set15sPatchEnabled'
    );
    return result === enabled;
  } catch (err: any) {
    console.warn('[doubaoBridge] 设置15s补丁开关失败:', err.message);
    return false;
  }
}

/** 每次自动视频任务提交前清空上一条视频缓存，避免把旧产物绑定到新任务。 */
export async function resetVideoCaptureCache(webview: WebviewHandle, captureToken: string): Promise<void> {
  if (!captureToken.trim()) throw new Error('视频捕获令牌不能为空');
  try {
    await safeExecuteJS(
      webview,
      `(function() {
        window.__doubaoVideoCache = {
          captureToken: ${JSON.stringify(captureToken)},
          resetAt: Date.now(),
          lastVid: '',
          lastVideoUrl: '',
          lastFieldSource: '',
          lastSourceKey: '',
          lastCapturedAt: 0,
          lastCaptureToken: '',
          watermarkFreeProof: '',
          trustedExtensionVideo: null
        };
        // 每个新视频任务都从干净的网络监控基线开始。监听器本身继续保留，
        // 但旧任务的 start/end 时间不能成为本次提交后的“生成证据”。
        if (window.__genState) {
          window.__genState.generating = false;
          window.__genState.startTime = 0;
          window.__genState.endTime = 0;
          window.__genState.lastUpdate = 0;
          window.__genState.sseDataCount = 0;
        }
        window.__doubaoVideoBlockerBaselineLength = document.body ? (document.body.innerText || '').length : 0;
        return true;
      })();`,
      5000,
      'resetVideoCaptureCache'
    );
  } catch (err: any) {
    console.warn('[doubaoBridge] 清空视频缓存失败:', err.message);
  }
}

/** 每次自动图片任务提交前清空上一条扩展原始图片缓存。 */
export async function resetImageCaptureCache(webview: WebviewHandle): Promise<void> {
  try {
    await safeExecuteJS(
      webview,
      `(function() {
        window.__doubaoImageCache = { urls: [], lastFieldSource: '', lastSourceKey: '', lastCapturedAt: 0 };
        return true;
      })();`,
      5000,
      'resetImageCaptureCache'
    );
  } catch (err: any) {
    console.warn('[doubaoBridge] 清空图片缓存失败:', err.message);
  }
}

/**
 * 在成功提交提示词后刷新阻断检测基线。
 *
 * resetVideoCaptureCache 在注入提示词前设置基线，此时用户消息尚未渲染。
 * 提交成功后，用户消息已写入页面，需要重新设置基线，否则
 * detectVideoGenerationBlocker 的增量文本会包含用户提示词内容，
 * 导致提示词中含"生成失败""会员专享"等词时被误判为平台限制。
 *
 * 此函数不清空视频缓存，仅更新基线长度。
 */
export async function refreshBlockerBaseline(webview: WebviewHandle): Promise<void> {
  try {
    await safeExecuteJS(
      webview,
      `(function() {
        window.__doubaoVideoBlockerBaselineLength = document.body ? (document.body.innerText || '').length : 0;
        return true;
      })();`,
      5000,
      'refreshBlockerBaseline'
    );
  } catch (err: any) {
    console.warn('[doubaoBridge] 刷新阻断基线失败:', err.message);
  }
}

/**
 * 视频生成阻断短语列表。
 *
 * 设计原则：
 * - 不使用孤立的泛化词（如"暂不支持""违规""无法生成"），防止用户提示词或页面说明被误判
 * - 会员/权益类短语必须带"会员"或"权益"上下文
 * - 真人脸类短语必须带"真人脸""人脸""肖像"上下文
 *
 * 导出以便单元测试验证不含泛化词。
 */
export const VIDEO_BLOCKER_PHRASES: readonly string[] = [
  // 额度耗尽
  '今日视频生成免费次数用完了', '今日视频生成免费次数已用完',
  '次数已用完', '次数不足', '余额不足',
  // 会员/权益限制（不使用孤立的"暂不支持"，防止误判）
  '当前模型仅限会员', '会员专享', '仅限会员', '仅会员可用',
  '开通会员', '升级会员', '权益不足',
  // 真人脸限制（带上下文的组合短语）
  '暂不支持上传真人脸素材', '不支持真人脸', '人脸素材无法作为参考', '肖像保护',
  // 内容审核（不使用孤立的"违规""无法生成"）
  '内容未通过', '审核未通过', '版权限制',
  // 生成失败
  '视频生成失败', '生成视频失败', '生成失败', '生成异常',
  '豆包已停止生成',
];

/**
 * 视频生成阻断检测的 DOM 选择器。
 *
 * 设计原则：
 * - 只扫描可见的弹出提示层（dialog/alert/toast/notice/error）
 * - 不扫描聊天消息容器 [class*="message"]，防止历史消息误判
 *
 * 导出以便单元测试验证不含消息容器选择器。
 */
export const VIDEO_BLOCKER_SELECTORS: readonly string[] = [
  '[role="dialog"]', '[role="alert"]',
  '[class*="toast"]', '[class*="Toast"]',
  '[class*="notice"]', '[class*="Notice"]',
  '[class*="error"]', '[class*="Error"]',
];

/**
 * 识别豆包页面已经明确给出的失败、权限或安全限制提示。
 *
 * 覆盖的信号类别：
 * - 额度耗尽：免费次数用完、次数不足、余额不足
 * - 会员/权益限制：会员专享、仅限会员、开通会员、升级会员、权益不足、仅会员可用
 * - 真人脸限制：暂不支持上传真人脸素材、不支持真人脸、肖像保护
 * - 内容审核：内容未通过、审核未通过
 * - 生成失败：生成失败、生成异常、豆包已停止生成
 *
 * 检测策略：
 * - 只扫描可见的弹出提示层（dialog/alert/toast/notice/error），不扫描聊天消息容器
 * - 增量文本仅检查 baseline 之后新增的内容，避免历史消息误判
 * - 不使用孤立的泛化词（如"暂不支持""违规""无法生成"），防止用户提示词或页面说明被误判
 *
 * 一旦检测到明确限制，调用方应立即结束视频等待与产物轮询，
 * 不继续等到长超时，且不得扣减 Seedance 额度。
 */
/**
 * 纯函数：在给定文本中匹配阻断短语。
 *
 * 按短语列表顺序检查，返回第一个命中的短语；未命中返回 null。
 * 导出以便单元测试覆盖时序场景（基线设置 → 注入提示词 → 刷新基线 → 检测）。
 *
 * @param text 要检查的文本（通常是可见提示层文本 + 增量页面文本）
 * @returns 匹配到的阻断短语，或 null
 */
export function matchBlockerPhrase(text: string): string | null {
  for (const phrase of VIDEO_BLOCKER_PHRASES) {
    if (text.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * 纯函数：模拟 detectVideoGenerationBlocker 的文本匹配逻辑。
 *
 * 给定可见提示层文本列表和增量页面文本，拼接后检查是否包含阻断短语。
 * 用于单元测试验证时序场景下不会误判用户提示词。
 *
 * @param visibleLayerTexts 可见提示层的文本列表（dialog/alert/toast 等）
 * @param incrementalBodyText baseline 之后的增量页面文本
 * @returns 匹配到的阻断短语，或 null
 */
export function matchBlockerFromLayers(
  visibleLayerTexts: string[],
  incrementalBodyText: string,
): string | null {
  const allText = [...visibleLayerTexts, incrementalBodyText].join('\n');
  return matchBlockerPhrase(allText);
}

export async function detectVideoGenerationBlocker(webview: WebviewHandle): Promise<string | null> {
  const code = `
    (function() {
      var phrases = ${JSON.stringify(VIDEO_BLOCKER_PHRASES)};
      var parts = [];
      var selectors = ${JSON.stringify(VIDEO_BLOCKER_SELECTORS)};
      for (var i = 0; i < selectors.length; i++) {
        var nodes = document.querySelectorAll(selectors[i]);
        for (var j = 0; j < nodes.length; j++) {
          var rect = nodes[j].getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) parts.push(nodes[j].innerText || '');
        }
      }
      // 增量文本：只检查 baseline 之后新增的内容
      var bodyText = document.body ? (document.body.innerText || '') : '';
      var baseline = Number(window.__doubaoVideoBlockerBaselineLength || 0);
      parts.push(bodyText.length >= baseline ? bodyText.slice(baseline) : bodyText.slice(-2000));
      var text = parts.join('\\n');
      for (var k = 0; k < phrases.length; k++) {
        if (text.indexOf(phrases[k]) >= 0) return phrases[k];
      }
      return '';
    })();
  `;
  try {
    const result = await safeExecuteJS<string>(webview, code, 5000, 'detectVideoGenerationBlocker');
    return result || null;
  } catch {
    return null;
  }
}

/**
 * 从页面全局变量获取最新的视频 URL。
 * 同时返回 fieldSource；调用方仍需根据平台授权响应判定是否可作为无水印产物。
 */
export interface CachedVideoUrl {
  vid: string;
  videoUrl: string;
  fieldSource?: string;
  captureToken?: string;
  resetAt?: number;
  capturedAt?: number;
  watermarkFreeProof?: string;
}

export async function getCachedVideoUrl(webview: WebviewHandle): Promise<CachedVideoUrl | null> {
  const code = `
    (function() {
      var cache = window.__doubaoVideoCache;
      if (!cache) return { found: false };
      var trusted = cache.trustedExtensionVideo;
      if (trusted && trusted.vid) {
        return {
          found: true,
          vid: trusted.vid,
          videoUrl: trusted.videoUrl || '',
          fieldSource: trusted.fieldSource || '',
          captureToken: trusted.captureToken || '',
          resetAt: Number(trusted.resetAt || 0),
          capturedAt: Number(trusted.capturedAt || 0),
          watermarkFreeProof: trusted.watermarkFreeProof || ''
        };
      }
      if (cache.lastVid) {
        return {
          found: true,
          vid: cache.lastVid,
          videoUrl: cache.lastVideoUrl || '',
          fieldSource: cache.lastFieldSource || '',
          captureToken: cache.lastCaptureToken || cache.captureToken || '',
          resetAt: Number(cache.resetAt || 0),
          capturedAt: Number(cache.lastCapturedAt || 0),
          watermarkFreeProof: cache.watermarkFreeProof || ''
        };
      }
      return { found: false };
    })();
  `;

  try {
    const result = await safeExecuteJS<{
      found: boolean; vid?: string; videoUrl?: string; fieldSource?: string;
      captureToken?: string; resetAt?: number; capturedAt?: number; watermarkFreeProof?: string;
    }>(
      webview, code, 5000, 'getCachedVideoUrl'
    );
    if (result.found && result.vid) {
      return {
        vid: result.vid,
        videoUrl: result.videoUrl || '',
        fieldSource: result.fieldSource || undefined,
        captureToken: result.captureToken || undefined,
        resetAt: Number(result.resetAt || 0),
        capturedAt: Number(result.capturedAt || 0),
        watermarkFreeProof: result.watermarkFreeProof || undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 读取内置扩展确认的原始图片地址。
 * 只有 `image_ori_raw`/`image_raw` 经主进程标记为扩展来源后才会进入这里；
 * 页面 DOM 图片不写入该缓存，因此调用方可以安全地优先使用它。
 */
export async function getCachedImageUrls(webview: WebviewHandle): Promise<{ imageUrls: string[]; fieldSource?: string } | null> {
  const code = `
    (function() {
      var cache = window.__doubaoImageCache;
      if (!cache || !Array.isArray(cache.urls) ||
          (cache.lastFieldSource !== 'doubao_extension' && cache.lastFieldSource !== 'dola_extension' && cache.lastFieldSource !== 'doubao_page_capture')) {
        return { found: false };
      }
      var urls = cache.urls.filter(function(url) {
        return typeof url === 'string' && /^https?:\\/\\//i.test(url);
      });
      return {
        found: urls.length > 0,
        imageUrls: urls,
        fieldSource: typeof cache.lastFieldSource === 'string' ? cache.lastFieldSource : ''
      };
    })();
  `;

  try {
    const result = await safeExecuteJS<{ found: boolean; imageUrls?: string[]; fieldSource?: string }>(
      webview, code, 5000, 'getCachedImageUrls'
    );
    if (!result.found || !Array.isArray(result.imageUrls)) return null;
    const imageUrls = result.imageUrls.filter((url): url is string => /^https?:\/\//i.test(url));
    return imageUrls.length > 0
      ? { imageUrls, fieldSource: result.fieldSource || undefined }
      : null;
  } catch {
    return null;
  }
}

/**
 * 通过 vid 获取视频播放地址（备用方案，在 webview 页面上下文调用豆包 API）
 */
export async function getVideoPlayUrl(webview: WebviewHandle, vid: string): Promise<string | null> {
  const code = `
    (function() {
      var vid = '${vid}';
      function findVideoUrl(obj, depth) {
        if (!obj || depth > 12) return '';
        if (Array.isArray(obj)) {
          for (var i = 0; i < obj.length; i++) {
            var arrayUrl = findVideoUrl(obj[i], depth + 1);
            if (arrayUrl) return arrayUrl;
          }
          return '';
        }
        if (typeof obj !== 'object') return '';
        var preferredKeys = ['no_watermark_url', 'download_url', 'main_url', 'main', 'play_url', 'url'];
        for (var p = 0; p < preferredKeys.length; p++) {
          var value = obj[preferredKeys[p]];
          if (typeof value === 'string' &&
              (value.indexOf('http://') === 0 || value.indexOf('https://') === 0) &&
              (value.indexOf('video') >= 0 || value.indexOf('vod') >= 0 ||
               value.indexOf('.mp4') >= 0 || value.indexOf('tos-') >= 0)) {
            return value;
          }
        }
        var preferredContainers = ['original_media_info', 'original', 'source', 'play_info', 'play_infos', 'media_info'];
        for (var c = 0; c < preferredContainers.length; c++) {
          if (obj[preferredContainers[c]]) {
            var preferredUrl = findVideoUrl(obj[preferredContainers[c]], depth + 1);
            if (preferredUrl) return preferredUrl;
          }
        }
        for (var key in obj) {
          if (obj.hasOwnProperty(key) && preferredContainers.indexOf(key) < 0) {
            var nestedUrl = findVideoUrl(obj[key], depth + 1);
            if (nestedUrl) return nestedUrl;
          }
        }
        return '';
      }
      var uuid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString();
      var deviceId = (function() {
        var stored = sessionStorage.getItem('__ds_device_id');
        if (stored) return stored;
        var id = String(Date.now()) + String(Math.floor(Math.random() * 1000000));
        sessionStorage.setItem('__ds_device_id', id);
        return id;
      })();
      var params = 'version_code=20800&language=zh&device_platform=web&aid=497858&real_aid=497858&pkg_type=release_version&device_id=' + deviceId + '&pc_version=3.20.2&web_id=&tea_uuid=&region=CN&sys_region=CN&samantha_web=1&web_platform=browser&use-olympus-account=1&web_tab_id=' + uuid;
      var url = '/samantha/media/get_play_info?' + params;
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'agw-js-conv': 'str',
          'origin': location.origin,
          'referer': location.href,
        },
        credentials: 'include',
        body: JSON.stringify({ key: vid, type: 'video' }),
      }).then(function(r) { return r.json(); })
        .then(function(data) {
          if (data && data.data) {
            var mainUrl = '';
            if (data.data.original_media_info && data.data.original_media_info.main_url) {
              mainUrl = data.data.original_media_info.main_url;
            } else if (data.data.original_media_info && data.data.original_media_info.main) {
              mainUrl = data.data.original_media_info.main;
            } else if (data.data.download_url) {
              mainUrl = data.data.download_url;
            } else if (data.data.no_watermark_url) {
              mainUrl = data.data.no_watermark_url;
            } else if (data.data.play_info && data.data.play_info.main) {
              mainUrl = data.data.play_info.main;
            } else if (data.data.play_infos && data.data.play_infos.length > 0) {
              mainUrl = data.data.play_infos[0].main;
            }
            if (!mainUrl) mainUrl = findVideoUrl(data.data, 0);
            if (mainUrl) {
              // 新接口优先使用明确返回的原始媒体地址；旧接口继续兼容 lr 清晰度参数。
              if (!data.data.original_media_info && !data.data.download_url && !data.data.no_watermark_url) {
                mainUrl = mainUrl.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
              }
              return { success: true, url: mainUrl };
            }
          }
          return { success: false, error: '无播放地址' };
        })
        .catch(function(e) {
          return { success: false, error: e.message };
        });
    })();
  `;

  try {
    const result = await webview.executeJavaScript(code);
    if (result && result.success && result.url) {
      return result.url;
    }
    return null;
  } catch (err: unknown) {
    console.warn('[doubaoBridge] 获取视频播放地址失败:', getErrorMessage(err));
    return null;
  }
}

// ==================== 结构化视频产物解析 ====================

import type{
  VideoArtifactResolution,
  ArtifactAttempt,
  VideoCandidate,
  VideoArtifactSource,
  CandidateFilterContext,
  ConversationScanResult,
} from './videoArtifactResolver';
import {
  parsePlayInfoResponse,
  parseConversationScanData,
  sortCandidatesByTrust,
  filterCandidatesByContext,
  classifyVideoResolutionError,
  isExplicitlyWatermarkedVideoUrl,
  isValidExtensionWatermarkProof,
  isValidVideoUrl,
  createResolvedResolution,
  createFailedResolution,
} from './videoArtifactResolver';
import { tryExperimentalDirectExtract } from './experimentalNoWatermark';

/**
 * resolveVideoArtifact 的上下文参数。
 */
export interface ResolveVideoArtifactContext {
  /** 任务自身的对话 URL，用于会话匹配 */
  conversationUrl?: string;
  /** 任务运行 ID，用于候选过滤 */
  runId?: string;
  /** 已知的 vid（如从缓存或之前步骤获取） */
  knownVid?: string;
  /** 本次自动任务在清空缓存时签发的捕获令牌 */
  captureToken?: string;
  /** 单次解析超时（毫秒），默认 12000 */
  timeoutMs?: number;
  /** 是否为手动提取（影响重试次数和日志） */
  isManual?: boolean;
  /** 仅接受豆包官方明确确认的无水印下载地址 */
  requireWithoutWatermark?: boolean;
  /** 实验开关：官方授权失败后尝试直接提取源文件（用户显式授权；默认关闭，候选标注 experimental） */
  experimentalNoWatermark?: boolean;
  /** 可选的中断信号，取消后立即停止解析 */
  signal?: AbortSignal;
}

/**
 * 结构化视频产物解析。
 *
 * 按以下优先级尝试：
 * 1. 已捕获的 SSE 响应中的原始媒体地址（captured_response）
 * 2. 以 vid 调用 get_play_info 提取 original_media_info / download_url（play_info）
 * 3. 创作空间下载信息接口（platform_download_info）
 * 4. 对话页面结构化数据扫描（conversation_scan）
 * 5. 普通 DOM 结果 URL（page_fallback，非原始）
 *
 * 每层独立捕获错误，失败不影响下一层。
 */
export async function resolveVideoArtifact(
  webview: WebviewHandle,
  ctx: ResolveVideoArtifactContext = {},
): Promise<VideoArtifactResolution> {
  const totalBudgetMs = ctx.timeoutMs ?? 12000;
  const deadline = Date.now() + totalBudgetMs;
  const attempts: ArtifactAttempt[] = [];
  const candidates: VideoCandidate[] = [];
  let resolvedVid: string | undefined = ctx.knownVid;
  /** API 策略（play_info / platform_download_info）是否已成功获取到候选 */
  let apiStrategySucceeded = false;

  /** 检查是否已取消或已超过全局 deadline */
  const isAborted = () => ctx.signal?.aborted === true || Date.now() >= deadline;
  /** 获取剩余时间预算，最少 1 秒以保证请求能发出 */
  const remainingMs = () => Math.max(1000, deadline - Date.now());

  // ---- 策略 1: 已捕获的 SSE 响应缓存 ----
  const cacheResult = await tryCapturedResponseStrategy(webview, ctx);
  if (cacheResult.vid) resolvedVid = resolvedVid || cacheResult.vid;
  if (cacheResult.candidate) candidates.push(cacheResult.candidate);
  attempts.push(cacheResult.attempt);

  // ---- 策略 2: get_play_info 接口 ----
  if (!isAborted() && resolvedVid) {
    const piResult = await executePlayInfoStrategy(webview, resolvedVid, remainingMs(), ctx.signal);
    if (piResult.candidate) candidates.push(piResult.candidate);
    attempts.push(piResult.attempt);
    if (piResult.succeeded) apiStrategySucceeded = true;
  } else {
    attempts.push({ strategy: 'play_info', result: 'skip', reason: isAborted() ? '已取消或超时' : '无 vid' });
  }

  // ---- 策略 3: 创作空间下载信息接口 ----
  if (!isAborted() && resolvedVid) {
    const dlResult = await executeDownloadInfoStrategy(webview, resolvedVid, remainingMs(), ctx.signal);
    if (dlResult.candidate) candidates.push(dlResult.candidate);
    attempts.push(dlResult.attempt);
    if (dlResult.succeeded) apiStrategySucceeded = true;
  } else {
    attempts.push({ strategy: 'platform_download_info', result: 'skip', reason: isAborted() ? '已取消或超时' : '无 vid' });
  }

  // ---- 策略 4: 对话页面扫描（DOM + 结构化数据） ----
  /** 扫描前已知的 vid，用于判断扫描是否发现了新 vid */
  const vidBeforeScan = resolvedVid;
  if (!isAborted()) {
    const scanResult = await executeConversationScanStrategy(webview, remainingMs, isAborted);
    if (scanResult.vid) resolvedVid = resolvedVid || scanResult.vid;
    for (const candidate of scanResult.candidates) candidates.push(candidate);
    attempts.push(scanResult.attempt);
  }

  // ---- 策略 4b: 扫描发现新 vid 后回补 API 策略 ----
  // 如果扫描发现了此前未知的新 vid，且 API 策略此前未成功，则以剩余 deadline 重新执行
  if (!isAborted() && resolvedVid && resolvedVid !== vidBeforeScan && !apiStrategySucceeded) {
    const retryResult = await retryApiStrategiesAfterScan(
      webview, resolvedVid, remainingMs, ctx.signal, isAborted,
    );
    candidates.push(...retryResult.candidates);
    attempts.push(...retryResult.attempts);
    if (retryResult.succeeded) apiStrategySucceeded = true;
  }

  // ---- 策略 5: 普通 DOM 结果 URL 回退 ----
  if (!isAborted()) {
    const fallbackResult = await tryPageFallbackStrategy(webview, remainingMs());
    if (fallbackResult.candidate) candidates.push(fallbackResult.candidate);
    attempts.push(fallbackResult.attempt);
  }

  // ---- 策略 6（实验，默认关闭）：官方失败后直接提取源文件 ----
  if (!isAborted() && ctx.experimentalNoWatermark) {
    const expResult = await tryExperimentalStrategy(webview, resolvedVid, remainingMs());
    candidates.push(...expResult.candidates);
    attempts.push(expResult.attempt);
  }

  // ---- 候选过滤、排序与选择 ----
  return selectBestCandidate(candidates, resolvedVid, ctx, attempts);
}

/**
 * 策略 6（实验，默认关闭）：官方授权失败后直接提取源文件候选。
 * 仅当 ctx.experimentalNoWatermark 且已有 vid 时执行；候选 source='experimental'，
 * 标注未经官方授权（可能仍含水印/触发风控），由 selectBestCandidate 作为最后手段使用。
 */
async function tryExperimentalStrategy(
  webview: WebviewHandle,
  vid: string | undefined,
  timeoutMs: number,
): Promise<{ candidates: VideoCandidate[]; attempt: ArtifactAttempt }> {
  if (!vid) {
    return { candidates: [], attempt: { strategy: 'experimental', result: 'skip', reason: '无 vid' } };
  }
  try {
    const candidates = await tryExperimentalDirectExtract(webview, vid, timeoutMs);
    if (candidates.length === 0) {
      return { candidates, attempt: { strategy: 'experimental', result: 'fail', reason: '未发现可用源文件地址' } };
    }
    return { candidates, attempt: { strategy: 'experimental', result: 'success', reason: `${candidates.length} 个实验候选（未经官方授权）` } };
  } catch (err: unknown) {
    return { candidates: [], attempt: { strategy: 'experimental', result: 'fail', reason: getErrorMessage(err) } };
  }
}

/**
 * 策略 4: 对话页面扫描（结构化数据 + DOM）。
 * 返回发现的 vid、候选地址列表和尝试结果。
 */
async function executeConversationScanStrategy(
  webview: WebviewHandle,
  remainingMs: () => number,
  isAborted: () => boolean,
): Promise<{ vid?: string; candidates: VideoCandidate[]; attempt: ArtifactAttempt }> {
  try {
    // 4a: 结构化数据扫描（提取 vid 和平台明确返回的媒体地址）
    const scanResult = await scanConversationStructured(webview, remainingMs());
    const candidates: VideoCandidate[] = [...scanResult.candidates];

    // 4b: DOM 扫描（video 标签、下载链接）
    if (!isAborted()) {
      const pageUrls = await scanConversationForVideoUrls(webview, remainingMs());
      for (const url of pageUrls) {
        if (isValidVideoUrl(url)) {
          candidates.push({ url, source: 'conversation_scan', isOriginal: false });
        }
      }
    }

    if (candidates.length > 0) {
      return {
        vid: scanResult.vid,
        candidates,
        attempt: { strategy: 'conversation_scan', result: 'success', reason: `${candidates.length} 个候选` },
      };
    }
    return {
      vid: scanResult.vid,
      candidates,
      attempt: { strategy: 'conversation_scan', result: 'fail', reason: '未找到视频地址' },
    };
  } catch (err: unknown) {
    return {
      candidates: [],
      attempt: { strategy: 'conversation_scan', result: 'fail', reason: getErrorMessage(err) },
    };
  }
}

/**
 * 策略 2: 执行 get_play_info 并返回候选和尝试结果。
 */
async function executePlayInfoStrategy(
  webview: WebviewHandle,
  vid: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ candidate?: VideoCandidate; attempt: ArtifactAttempt; succeeded: boolean }> {
  try {
    const playInfoResult = await fetchPlayInfoRaw(webview, vid, timeoutMs, signal);
    if (playInfoResult) {
      const candidate = parsePlayInfoResponse(playInfoResult.data);
      if (candidate) {
        return {
          candidate: { ...candidate, vid },
          attempt: { strategy: 'play_info', result: 'success' },
          succeeded: true,
        };
      }
      const status = classifyVideoResolutionError(playInfoResult.status, playInfoResult.data);
      return {
        attempt: { strategy: 'play_info', result: 'fail', reason: `status=${playInfoResult.status}, classified=${status}` },
        succeeded: false,
      };
    }
    return {
      attempt: { strategy: 'play_info', result: 'fail', reason: '请求失败或超时' },
      succeeded: false,
    };
  } catch (err: unknown) {
    return {
      attempt: { strategy: 'play_info', result: 'fail', reason: getErrorMessage(err) },
      succeeded: false,
    };
  }
}

/**
 * 策略 3: 执行创作空间下载信息接口并返回候选和尝试结果。
 */
async function executeDownloadInfoStrategy(
  webview: WebviewHandle,
  vid: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ candidate?: VideoCandidate; attempt: ArtifactAttempt; succeeded: boolean }> {
  try {
    const downloadResult = await fetchWithoutWatermarkInfo(webview, vid, timeoutMs, signal);
    if (downloadResult) {
      const response = downloadResult.data as {
        code?: unknown;
        data?: {
          without_watermark?: unknown;
          download_video?: Record<string, { download_url?: unknown }>;
        };
      } | null;
      const downloadUrl = response?.data?.download_video?.[vid]?.download_url;
      if (isValidVideoUrl(downloadUrl) && isExplicitlyWatermarkedVideoUrl(downloadUrl)) {
        return {
          attempt: {
            strategy: 'platform_download_info',
            result: 'fail',
            reason: '平台下载地址包含明确水印标记，已拒绝归档',
          },
          succeeded: false,
        };
      }
      if (
        downloadResult.status === 200
        && response?.code === 0
        && response?.data?.without_watermark === true
        && isValidVideoUrl(downloadUrl)
      ) {
        return {
          candidate: {
            url: downloadUrl,
            source: 'platform_download_info',
            isOriginal: true,
            vid,
          },
          attempt: { strategy: 'platform_download_info', result: 'success' },
          succeeded: true,
        };
      }
      if (downloadResult.status === 200 && response?.code === 0 && response?.data?.without_watermark === false) {
        return {
          attempt: {
            strategy: 'platform_download_info',
            result: 'fail',
            reason: '豆包官方未向当前账号或该视频开放无水印下载（without_watermark=false）',
          },
          succeeded: false,
        };
      }
      const status = classifyVideoResolutionError(downloadResult.status, downloadResult.data);
      return {
        attempt: { strategy: 'platform_download_info', result: 'fail', reason: `status=${downloadResult.status}, classified=${status}` },
        succeeded: false,
      };
    }
    return {
      attempt: { strategy: 'platform_download_info', result: 'fail', reason: '请求失败或超时' },
      succeeded: false,
    };
  } catch (err: unknown) {
    return {
      attempt: { strategy: 'platform_download_info', result: 'fail', reason: getErrorMessage(err) },
      succeeded: false,
    };
  }
}

/**
 * 策略 4b: 扫描发现新 vid 后回补 API 策略。
 * 以剩余 deadline 重新执行 play_info → platform_download_info，
 * 每步均通过 raceWithAbort 与 AbortSignal 竞争。
 */
async function retryApiStrategiesAfterScan(
  webview: WebviewHandle,
  vid: string,
  remainingMs: () => number,
  signal: AbortSignal | undefined,
  isAborted: () => boolean,
): Promise<{ candidates: VideoCandidate[]; attempts: ArtifactAttempt[]; succeeded: boolean }> {
  const candidates: VideoCandidate[] = [];
  const attempts: ArtifactAttempt[] = [];
  let succeeded = false;

  // 4b-1: 重试 get_play_info
  const piResult = await executePlayInfoStrategy(webview, vid, remainingMs(), signal);
  if (piResult.candidate) candidates.push(piResult.candidate);
  attempts.push(piResult.attempt);
  if (piResult.succeeded) succeeded = true;

  // 4b-2: 无论普通播放地址是否存在，都必须查询官方无水印能力。
  if (!isAborted()) {
    const dlResult = await executeDownloadInfoStrategy(webview, vid, remainingMs(), signal);
    if (dlResult.candidate) candidates.push(dlResult.candidate);
    attempts.push(dlResult.attempt);
    if (dlResult.succeeded) succeeded = true;
  }

  return { candidates, attempts, succeeded };
}

/**
 * 策略 5: 普通 DOM 结果 URL 回退。
 */
async function tryPageFallbackStrategy(
  webview: WebviewHandle,
  timeoutMs: number = 10000,
): Promise<{ candidate?: VideoCandidate; attempt: ArtifactAttempt }> {
  try {
    const rawResult = await getResultUrl(webview, timeoutMs);
    let urls: string[] = [];
    try {
      const parsed = JSON.parse(rawResult);
      urls = Array.isArray(parsed) ? parsed : [];
    } catch {
      urls = rawResult ? [rawResult] : [];
    }
    // getResultUrl 为兼容图片模式会返回混合候选；这里只能从中选择明确的
    // 视频 URL，不能让首个 poster/图片候选阻断后续真实视频源。
    const videoUrl = urls.find((url) => isValidVideoUrl(url) && !isLikelyImageUrl(url));
    if (videoUrl) {
      return {
        candidate: { url: videoUrl, source: 'page_fallback', isOriginal: false },
        attempt: { strategy: 'page_fallback', result: 'success' },
      };
    }
    return { attempt: { strategy: 'page_fallback', result: 'fail', reason: '无有效 URL' } };
  } catch (err: unknown) {
    return { attempt: { strategy: 'page_fallback', result: 'fail', reason: getErrorMessage(err) } };
  }
}

/** 回退扫描中排除明显的图片候选（尤其是视频 poster）。 */
function isLikelyImageUrl(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0].toLowerCase();
  return /\.(?:apng|avif|bmp|gif|heic|jpe?g|png|svg|webp)$/.test(path);
}

/**
 * 策略 1: 从已拦截的 SSE 响应缓存中提取视频地址。
 * 根据 fieldSource 判定是否为原始地址：
 * 缓存来自普通播放/SSE 链，不能证明平台已开放无水印下载。
 */
async function tryCapturedResponseStrategy(
  webview: WebviewHandle,
  ctx: ResolveVideoArtifactContext,
): Promise<{ vid?: string; candidate?: VideoCandidate; attempt: ArtifactAttempt }> {
  try {
    const cache = await getCachedVideoUrl(webview);
    if (!cache) {
      return { attempt: { strategy: 'captured_response', result: 'skip', reason: '无缓存' } };
    }
    if (cache.videoUrl && isValidVideoUrl(cache.videoUrl)) {
      const extensionSource: VideoArtifactSource | undefined = cache.fieldSource === 'dola_extension'
        || cache.fieldSource === 'dola_extension_media'
        ? 'dola_extension'
        : cache.fieldSource === 'doubao_extension'
          ? 'doubao_extension'
          : undefined;
      const tokenMatches = !ctx.captureToken || cache.captureToken === ctx.captureToken;
      const capturedAt = Number(cache.capturedAt || 0);
      const resetAt = Number(cache.resetAt || 0);
      const freshForCapture = resetAt > 0 && capturedAt >= resetAt;
      const proofValid = extensionSource
        ? isValidExtensionWatermarkProof(extensionSource, cache.watermarkFreeProof)
        : false;
      const extensionTrusted = Boolean(
        extensionSource
        && tokenMatches
        && freshForCapture
        && proofValid
        && !isExplicitlyWatermarkedVideoUrl(cache.videoUrl),
      );
      return {
        vid: cache.vid,
        // 仅接受内置扩展明确解码并标记的资源；普通 chain 播放地址
        // 仍然标记为 captured_response，requireWithoutWatermark 时会被拒绝。
        candidate: {
          url: cache.videoUrl,
          source: extensionSource || 'captured_response',
          vid: cache.vid,
          isOriginal: extensionTrusted,
          watermarkFreeProof: extensionTrusted ? cache.watermarkFreeProof : undefined,
        },
        attempt: {
          strategy: 'captured_response',
          result: 'success',
          reason: `fieldSource=${cache.fieldSource || 'unknown'},proof=${proofValid ? 'valid' : 'missing'},token=${tokenMatches ? 'match' : 'mismatch'},fresh=${freshForCapture}`,
        },
      };
    }
    return { vid: cache.vid, attempt: { strategy: 'captured_response', result: 'fail', reason: '缓存中无有效 URL' } };
  } catch (err: unknown) {
    return { attempt: { strategy: 'captured_response', result: 'fail', reason: getErrorMessage(err) } };
  }
}

/**
 * 从候选列表中选择最佳候选，返回最终解析结果。
 */
function selectBestCandidate(
  candidates: VideoCandidate[],
  resolvedVid: string | undefined,
  ctx: ResolveVideoArtifactContext,
  attempts: ArtifactAttempt[],
): VideoArtifactResolution {
  const filterCtx: CandidateFilterContext = {
    vid: resolvedVid,
    conversationUrl: ctx.conversationUrl,
    runId: ctx.runId,
  };
  const contextMatched = filterCandidatesByContext(candidates, filterCtx);
  const officialFiltered = ctx.requireWithoutWatermark
    ? contextMatched.filter((candidate) => (
      (candidate.source === 'doubao_extension' || candidate.source === 'dola_extension')
      && candidate.isOriginal
      && isValidExtensionWatermarkProof(candidate.source, candidate.watermarkFreeProof)
      && !isExplicitlyWatermarkedVideoUrl(candidate.url)
    ))
    : contextMatched;
  // 实验通道（默认关闭）：官方授权候选为空且显式开启时，把 experimental 候选作为最后手段参与选择。
  // experimental 候选未经官方授权（可能仍含水印/触发风控），UI 必须明示来源。
  let filtered = officialFiltered;
  if (filtered.length === 0 && ctx.experimentalNoWatermark) {
    filtered = contextMatched.filter((candidate) => candidate.source === 'experimental');
  }
  const sorted = sortCandidatesByTrust(filtered);

  // 如果有多个原始地址候选且无法唯一匹配，标记需要人工选择
  const originalCandidates = sorted.filter((c) => c.isOriginal);
  if (originalCandidates.length > 1 && !resolvedVid) {
    return createFailedResolution(
      'needs_manual_selection',
      '发现多个原始地址候选，无法自动唯一匹配',
      attempts,
    );
  }

  const best = sorted[0];
  if (best) {
    return createResolvedResolution(best.url, best.source, best.vid ?? resolvedVid, attempts);
  }

  // 过滤后有候选被排除且提供了 conversationUrl → 无法可靠归属
  if (!ctx.requireWithoutWatermark && candidates.length > 0 && filtered.length === 0 && ctx.conversationUrl) {
    return createFailedResolution(
      'needs_manual_selection',
      '存在候选但无法可靠匹配到当前会话，需人工确认',
      attempts,
      resolvedVid,
    );
  }

  // ---- 判断最终失败原因 ----
  const officialWatermarkError = ctx.requireWithoutWatermark
    ? attempts.find((attempt) => (
      attempt.strategy === 'platform_download_info'
      && attempt.result === 'fail'
      && attempt.reason?.includes('without_watermark=false')
    ))
    : undefined;
  const experimentalError = ctx.experimentalNoWatermark
    ? attempts.find((attempt) => attempt.strategy === 'experimental' && attempt.result === 'fail')
    : undefined;
  const lastError = officialWatermarkError ?? experimentalError ?? attempts.filter((a) => a.result === 'fail').pop();
  const reason = experimentalError
    ? `${lastError?.reason || '官方未开放无水印'}；实验直取未获得可验证源文件（实验模式，可能仍含水印）`
    : (lastError?.reason || '所有策略均未获取到视频地址');
  return createFailedResolution('unavailable', reason, attempts, resolvedVid);
}

/** get_play_info 接口的原始返回 */
interface PlayInfoRawResult {
  status: number;
  data: unknown;
}

/**
 * 调用 get_play_info 并返回原始响应和状态码。
 * 在 webview 页面上下文执行，使用当前登录态。
 * 外层通过 raceWithAbort 与 AbortSignal 竞争，取消时立即返回 null；
 * 页内 fetch 由自身的 AbortController 收尾。
 */
async function fetchPlayInfoRaw(
  webview: WebviewHandle,
  vid: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PlayInfoRawResult | null> {
  const code = `
    (function() {
      var vid = ${JSON.stringify(vid)};
      var timeoutMs = ${timeoutMs};
      var uuid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString();
      var deviceId = (function() {
        var stored = sessionStorage.getItem('__ds_device_id');
        if (stored) return stored;
        var id = String(Date.now()) + String(Math.floor(Math.random() * 1000000));
        sessionStorage.setItem('__ds_device_id', id);
        return id;
      })();
      var params = 'version_code=20800&language=zh&device_platform=web&aid=497858&real_aid=497858&pkg_type=release_version&device_id=' + deviceId + '&pc_version=3.20.2&web_id=&tea_uuid=&region=CN&sys_region=CN&samantha_web=1&web_platform=browser&use-olympus-account=1&web_tab_id=' + uuid;
      var url = '/samantha/media/get_play_info?' + params;
      var controller = new AbortController();
      var timeoutId = setTimeout(function() { controller.abort(); }, timeoutMs);
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'agw-js-conv': 'str',
          'origin': location.origin,
          'referer': location.href,
        },
        credentials: 'include',
        body: JSON.stringify({ key: vid, type: 'video' }),
        signal: controller.signal,
      }).then(function(r) {
        return r.text().then(function(text) {
          var data = null;
          try { data = JSON.parse(text); } catch(e) {}
          return { status: r.status, data: data };
        });
      }).catch(function(e) {
        return { status: 0, data: null, error: e.message };
      }).finally(function() {
        clearTimeout(timeoutId);
      });
    })();
  `;

  try {
    const result = await raceWithAbort(
      safeExecuteJS<{ status: number; data: unknown; error?: string }>(
        webview, code, timeoutMs, 'fetchPlayInfoRaw'
      ),
      signal,
      null,
    );
    if (result && result.status > 0) {
      return { status: result.status, data: result.data };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 调用豆包网页当前使用的官方无水印能力接口。
 * 上层仅在响应明确给出 without_watermark=true 时接受下载地址。
 */
async function fetchWithoutWatermarkInfo(
  webview: WebviewHandle,
  vid: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PlayInfoRawResult | null> {
  if (signal?.aborted) return null;
  const code = `
    (function() {
      var vid = ${JSON.stringify(vid)};
      var timeoutMs = ${timeoutMs};
      var controller = new AbortController();
      var timeoutId = setTimeout(function() { controller.abort(); }, timeoutMs);
      return fetch('/creativity/resource/get_without_watermark', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'origin': location.origin,
          'referer': location.href,
        },
        credentials: 'include',
        body: JSON.stringify({ vid: [vid] }),
        signal: controller.signal,
      }).then(function(r) {
        return r.text().then(function(text) {
          var data = null;
          try { data = JSON.parse(text); } catch(e) {}
          return { status: r.status, data: data };
        });
      }).catch(function(e) {
        return { status: 0, data: null, error: e.message };
      }).finally(function() {
        clearTimeout(timeoutId);
      });
    })();
  `;

  try {
    const result = await raceWithAbort(
      safeExecuteJS<{ status: number; data: unknown; error?: string }>(
        webview, code, timeoutMs, 'fetchWithoutWatermarkInfo'
      ),
      signal,
      null,
    );
    return result && result.status > 0
      ? { status: result.status, data: result.data }
      : null;
  } catch {
    return null;
  }

}

/**
 * 从对话页面 DOM 中扫描视频 URL。
 * 查找 video 标签的 src 属性和 a 标签的 href。
 */
async function scanConversationForVideoUrls(
  webview: WebviewHandle,
  timeoutMs: number,
): Promise<string[]> {
  const code = `
    (function() {
      var urls = [];
      var seen = {};
      // video 标签
      var videos = document.querySelectorAll('video');
      for (var i = 0; i < videos.length; i++) {
        var src = videos[i].src || (videos[i].querySelector('source') && videos[i].querySelector('source').src);
        if (src && !seen[src]) { seen[src] = true; urls.push(src); }
      }
      // a 标签中的下载链接
      var links = document.querySelectorAll('a[href]');
      for (var j = 0; j < links.length; j++) {
        var href = links[j].href;
        if (href && (href.indexOf('.mp4') >= 0 || href.indexOf('video') >= 0 || href.indexOf('vod') >= 0) && !seen[href]) {
          seen[href] = true; urls.push(href);
        }
      }
      return urls;
    })();
  `;

  try {
    const result = await safeExecuteJS<string[]>(webview, code, timeoutMs, 'scanConversationForVideoUrls');
    return result || [];
  } catch {
    return [];
  }
}

/**
 * 从对话页面的结构化数据中提取 vid 和媒体地址。
 * 查找 __NEXT_DATA__、全局缓存变量等，不依赖特定 DOM 结构。
 * 所有数据均通过纯函数 parseConversationScanData 解析。
 */
async function scanConversationStructured(
  webview: WebviewHandle,
  timeoutMs: number,
): Promise<ConversationScanResult> {
  const code = `
    (function() {
      var results = [];
      // 1. __NEXT_DATA__ (Next.js 页面数据)
      var nextData = document.getElementById('__NEXT_DATA__');
      if (nextData && nextData.textContent) {
        try { results.push(JSON.parse(nextData.textContent)); } catch(e) {}
      }
      // 2. 全局缓存变量（豆包页面可能使用的各种缓存）
      var globals = ['__doubaoVideoCache', '__INITIAL_STATE__', '__PRELOADED_STATE__'];
      for (var g = 0; g < globals.length; g++) {
        try {
          var val = window[globals[g]];
          if (val) results.push(JSON.parse(JSON.stringify(val)));
        } catch(e) {}
      }
      // 3. 页面中的 script[type="application/json"]
      var scripts = document.querySelectorAll('script[type="application/json"]');
      for (var s = 0; s < scripts.length && s < 5; s++) {
        try {
          if (scripts[s].textContent) results.push(JSON.parse(scripts[s].textContent));
        } catch(e) {}
      }
      // 4. 当前豆包播放器不再渲染 <video>，而是把 vid 保存在
      // React 组件的 video props 中。这里只读取当前已挂载的视频卡片，
      // 不读取 Cookie/Token，也不直接使用带水印封面 URL。
      var videoBlocks = document.querySelectorAll('[class*="block-video"]');
      for (var v = 0; v < videoBlocks.length && v < 20; v++) {
        try {
          var node = videoBlocks[v];
          var videoData = null;
          // 新版卡片把 video 放在父级 DOM 的 __reactProps$ children 中，而不是
          // block-video 自身 fiber.pendingProps。受限递归只提取公开媒体标识，
          // 不序列化组件树、Cookie 或账号状态。
          var visited = new WeakSet();
          var inspected = 0;
          var findVideoInProps = function(value, depth) {
            if (!value || typeof value !== 'object' || depth > 10 || inspected++ > 800) return null;
            if (visited.has(value)) return null;
            visited.add(value);
            if (typeof value.vid === 'string' && value.vid.trim()) return value;
            var keys = Array.isArray(value) ? Object.keys(value) : Object.keys(value);
            for (var k = 0; k < keys.length; k++) {
              if (keys[k] === '_owner' || keys[k] === 'stateNode' || keys[k] === 'return' || keys[k] === 'alternate') continue;
              var found = findVideoInProps(value[keys[k]], depth + 1);
              if (found) return found;
            }
            return null;
          };
          var ancestor = node;
          for (var ancestorDepth = 0; ancestor && ancestorDepth < 8 && !videoData; ancestorDepth++, ancestor = ancestor.parentElement) {
            var ancestorNames = Object.getOwnPropertyNames(ancestor);
            for (var an = 0; an < ancestorNames.length; an++) {
              if (ancestorNames[an].indexOf('__reactProps$') !== 0) continue;
              var propsVideo = findVideoInProps(ancestor[ancestorNames[an]], 0);
              if (propsVideo) {
                videoData = {
                  vid: propsVideo.vid.trim(),
                  creation_task_id: typeof propsVideo.creation_task_id === 'string' ? propsVideo.creation_task_id : undefined,
                  message_id: typeof propsVideo.messageId === 'string' ? propsVideo.messageId : undefined
                };
                break;
              }
            }
          }

          var propertyNames = Object.getOwnPropertyNames(node);
          var fiberKey = '';
          for (var p = 0; p < propertyNames.length; p++) {
            if (propertyNames[p].indexOf('__reactFiber$') === 0) {
              fiberKey = propertyNames[p];
              break;
            }
          }
          if (fiberKey && !videoData) {
            var fiber = node[fiberKey];
            for (var depth = 0; fiber && depth < 12; depth++) {
              var pendingVideo = fiber.pendingProps && fiber.pendingProps.video;
              var memoizedVideo = fiber.memoizedProps && fiber.memoizedProps.video;
              var candidateVideo = pendingVideo || memoizedVideo;
              if (candidateVideo && typeof candidateVideo.vid === 'string' && candidateVideo.vid.trim()) {
                videoData = {
                  vid: candidateVideo.vid.trim(),
                  creation_task_id: typeof candidateVideo.creation_task_id === 'string'
                    ? candidateVideo.creation_task_id
                    : undefined,
                  message_id: typeof candidateVideo.messageId === 'string'
                    ? candidateVideo.messageId
                    : undefined
                };
                break;
              }
              fiber = fiber.return;
            }
          }
          if (videoData) results.push({ video: videoData });
        } catch(e) {}
      }
      return results;
    })();
  `;
  try {
    const rawResults = await safeExecuteJS<unknown[]>(webview, code, timeoutMs, 'scanConversationStructured');
    if (!rawResults || rawResults.length === 0) return { candidates: [] };
    // 合并所有结构化数据源的解析结果
    let vid: string | undefined;
    const allCandidates: VideoCandidate[] = [];
    for (const raw of rawResults) {
      const parsed = parseConversationScanData(raw);
      if (parsed.vid && !vid) vid = parsed.vid;
      allCandidates.push(...parsed.candidates);
    }
    return { vid, candidates: allCandidates };
  } catch {
    return { candidates: [] };
  }
}

/**
 * 手动提取视频产物。
 * 使用全局 deadline（默认 15 秒），单次调用 resolveVideoArtifact，
 * 每个策略消费剩余时间预算，取消时立即停止后续策略。
 */
export async function manualResolveVideoArtifact(
  webview: WebviewHandle,
  ctx: ResolveVideoArtifactContext = {},
): Promise<VideoArtifactResolution> {
  if (ctx.signal?.aborted) {
    return createFailedResolution('unavailable', '手动提取已取消', []);
  }
  const timeoutMs = ctx.timeoutMs ?? 15000;
  const startedAt = Date.now();
  const firstAttempt = await resolveVideoArtifact(webview, {
    ...ctx,
    isManual: true,
    requireWithoutWatermark: true,
    timeoutMs: Math.min(timeoutMs, 8_000),
  });
  if (firstAttempt.status === 'resolved' || ctx.signal?.aborted) return firstAttempt;

  const conversationUrl = ctx.conversationUrl || webview.getURL();
  let conversationPlatform: 'doubao' | 'dola' | undefined;
  try {
    const hostname = new URL(conversationUrl).hostname.toLowerCase().replace(/\.$/, '');
    if (hostname === 'doubao.com' || hostname.endsWith('.doubao.com')) conversationPlatform = 'doubao';
    if (hostname === 'dola.com' || hostname.endsWith('.dola.com')) conversationPlatform = 'dola';
  } catch {
    return firstAttempt;
  }
  // 历史会话需要给页面重载和扩展 fallback 解析留出完整窗口；短超时调用
  // 保持原解析结果，避免用新的超时提示覆盖已有的明确失败证据。
  if (!conversationPlatform || !firstAttempt.vid || timeoutMs < 10_000) return firstAttempt;

  const remainingBeforeReload = timeoutMs - (Date.now() - startedAt);
  if (remainingBeforeReload < 3_000) return firstAttempt;
  const captureToken = `manual:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
  const resetAt = Date.now();
  const captureContext = {
    captureToken,
    resetAt,
    expiresAt: resetAt + Math.max(30_000, timeoutMs + 5_000),
    conversationUrl,
    expectedVid: firstAttempt.vid,
  };
  const storageKey = '__lalorManualVideoCaptureV1';
  const expectedProof = conversationPlatform === 'dola'
    ? 'dola_extension_decoded_v1'
    : 'doubao_fallback_unwatermarked_v1';
  const platformLabel = conversationPlatform === 'dola' ? 'Dola' : '豆包';

  try {
    const prepared = await safeExecuteJS<boolean>(webview, `
      (function () {
        try {
          var context = ${JSON.stringify(captureContext)};
          sessionStorage.setItem(${JSON.stringify(storageKey)}, JSON.stringify(context));
          window.__doubaoVideoCache = {
            captureToken: context.captureToken,
            resetAt: context.resetAt,
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
          return true;
        } catch (_) { return false; }
      })();
    `, 5_000, `prepareManual${platformLabel}VideoCapture`);
    if (!prepared) return firstAttempt;

    // 仅重载当前会话以重放其 chain 响应；不会发送提示词或创建新任务。
    webview.loadURL(conversationUrl);
    const pollDeadline = startedAt + timeoutMs - 2_000;
    while (!ctx.signal?.aborted && Date.now() < pollDeadline) {
      await sleep(450);
      const cached = await getCachedVideoUrl(webview);
      if (
        cached?.vid === firstAttempt.vid
        && cached.captureToken === captureToken
        && cached.watermarkFreeProof === expectedProof
        && cached.videoUrl
        && !isExplicitlyWatermarkedVideoUrl(cached.videoUrl)
      ) {
        const remaining = Math.max(1_000, startedAt + timeoutMs - Date.now());
        return resolveVideoArtifact(webview, {
          ...ctx,
          knownVid: firstAttempt.vid,
          captureToken,
          isManual: true,
          requireWithoutWatermark: true,
          timeoutMs: remaining,
        });
      }
    }
    return createFailedResolution(
      'unavailable',
      `${platformLabel}扩展已重载当前会话，但未在限定时间内捕获到该视频的无水印资源`,
      firstAttempt.attempts,
      firstAttempt.vid,
    );
  } finally {
    void safeExecuteJS(webview, `
      (function () {
        try {
          var raw = sessionStorage.getItem(${JSON.stringify(storageKey)});
          var context = raw ? JSON.parse(raw) : null;
          if (!context || context.captureToken === ${JSON.stringify(captureToken)}) {
            sessionStorage.removeItem(${JSON.stringify(storageKey)});
          }
        } catch (_) {}
        return true;
      })();
    `, 3_000, `cleanupManual${platformLabel}VideoCapture`).catch(() => undefined);
  }
}
