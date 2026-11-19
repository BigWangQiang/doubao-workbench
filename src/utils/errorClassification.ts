/**
 * src/utils/errorClassification.ts
 * 任务错误分类纯函数 — 不依赖 DOM/React/Electron 运行时
 */

import type { TaskErrorCode, TaskErrorInfo } from '../types';

/**
 * 页面/控件尚未完成挂载时的瞬态错误码。
 *
 * 这些错误只表示当前 WebView 还没稳定，不表示账号失效；调用方应暂停
 * 当前任务并在原账号上恢复，不能因为错误对象丢失 code 就盲目切号。
 */
export const TRANSIENT_AUTOMATION_ERROR_CODES: readonly string[] = [
  'page_loading',
  'page_unrecognized',
  'page_not_ready',
  'editor_not_found',
  'editor_not_focusable',
  'authentication_unconfirmed',
  'availability_check_timeout',
  'availability_check_error',
  'startup_recheck_required',
  'dola_video_duration',
  'dola_video_model',
  'dola_video_ratio',
  'dola_video_ratio_menu',
  'dola_video_more',
  'dola_video_control',
  'video_mode_entry_not_ready',
  'video_model_control_not_ready',
  'video_composite_control_not_ready',
  'video_stable_readback_not_ready',
  'video_final_readback_not_ready',
];

const TRANSIENT_AUTOMATION_ERROR_CODE_SET = new Set(TRANSIENT_AUTOMATION_ERROR_CODES);

/** 判断结构化错误码是否属于可在原账号恢复的瞬态状态。 */
export function isTransientAutomationErrorCode(errorCode: string | undefined): boolean {
  if (!errorCode) return false;
  return TRANSIENT_AUTOMATION_ERROR_CODE_SET.has(errorCode)
    || errorCode.startsWith('dola_video_')
    || /^video_(?:mode_entry|model_control|composite_control|stable_readback|final_readback)_not_ready$/.test(errorCode);
}

/**
 * 从没有结构化 code 的异常文本中恢复瞬态错误码。
 * 匹配保持窄范围，明确的登录失效/额度耗尽/平台拒绝不会被归为瞬态。
 */
export function classifyTransientAutomationError(message: string): string | undefined {
  if (typeof message !== 'string' || message.trim().length === 0) return undefined;
  const normalized = message.normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const explicitCode = normalized.match(/\b(?:page_loading|page_unrecognized|page_not_ready|editor_not_found|editor_not_focusable|authentication_unconfirmed|availability_check_timeout|availability_check_error|startup_recheck_required|dola_video_(?:duration|model|ratio|ratio_menu|more|control)|video_(?:mode_entry|model_control|composite_control|stable_readback|final_readback)_not_ready)\b/i)?.[0];
  if (explicitCode) return explicitCode.toLowerCase();

  if (/dola[\s_-]*(?:视频)?[\s_-]*(?:时长|duration).*(?:不可见|未(?:挂载|展开|就绪|稳定)|未找到|无法激活|仍在加载|选项.*(?:不可见|未挂载))/i.test(normalized)) {
    return 'dola_video_duration';
  }
  if (/dola[\s_-]*(?:视频)?[\s_-]*(?:模型|model).*(?:不可见|未(?:挂载|展开|就绪|稳定)|未找到|无法激活|仍在加载|选项.*(?:不可见|未挂载))/i.test(normalized)) {
    return 'dola_video_model';
  }
  if (/dola[\s_-]*(?:视频)?[\s_-]*(?:比例|ratio|更多|more).*(?:不可见|未(?:挂载|展开|就绪|稳定)|未找到|无法激活|仍在加载|选项.*(?:不可见|未挂载))/i.test(normalized)) {
    return /(?:更多|more)/i.test(normalized) ? 'dola_video_more' : 'dola_video_ratio';
  }
  if (/(?:视频)?模式入口|mode[_ -]?entry/i.test(normalized) && /(?:未(?:就绪|挂载|找到)|不可见|not\s+ready|未在有界等待)/i.test(normalized)) {
    return 'video_mode_entry_not_ready';
  }
  if (/(?:视频)?(?:模型控件|组合控件|稳定回读|最终回读)|(?:model|composite|stable|final)[_ -]?readback?/i.test(normalized)
      && /(?:未(?:就绪|挂载|找到|稳定)|不可见|not\s+ready|未在有界等待)/i.test(normalized)) {
    if (/(?:模型控件|model[_ -]?control)/i.test(normalized)) return 'video_model_control_not_ready';
    if (/(?:组合控件|composite[_ -]?control)/i.test(normalized)) return 'video_composite_control_not_ready';
    if (/(?:最终回读|final[_ -]?readback)/i.test(normalized)) return 'video_final_readback_not_ready';
    return 'video_stable_readback_not_ready';
  }
  if (/编辑器.*(?:未(?:挂载|找到|就绪)|不可见|无法聚焦|not\s+ready)/i.test(normalized)) {
    return 'editor_not_found';
  }
  if (/(?:页面|文档|创作栏).*(?:仍在加载|未(?:就绪|稳定|识别)|就绪检测超时|loading|not\s+ready)/i.test(normalized)) {
    return 'page_not_ready';
  }
  if (/可用性检测(?:超时|异常)|availability[_ -]?check.*(?:timeout|error)/i.test(normalized)) {
    return /异常|error/i.test(normalized) ? 'availability_check_error' : 'availability_check_timeout';
  }
  return undefined;
}

/**
 * 只接受平台明确表达“额度/次数已不足或耗尽”的短语。
 *
 * 这里不使用孤立的“额度”或“次数”匹配，避免把用户提示词、页面说明
 * 或普通额度配置文本当成平台拒绝。每个模式都至少包含耗尽、上限、不足、
 * 用完等结果性上下文。
 */
const QUOTA_EXHAUSTED_PATTERNS: readonly RegExp[] = [
  /免费(?:生成)?次数[^。！？\n]{0,24}(?:用完|用尽|耗尽|达到上限)/i,
  /(?:今日|今天|当日|每日)[^。！？\n]{0,24}(?:免费)?(?:视频)?(?:生成)?(?:次数|额度)[^。！？\n]{0,12}(?:不足|达到上限|用完|用尽|耗尽|为\s*0)/i,
  /(?:剩余|当前|可用|账户|账号|视频生成|生成视频|生成|当日视频|视频)?额度\s*(?:不足|不够|(?:已|已经)?达到上限|(?:已|已经)?耗尽|(?:已|已经)?用完|(?:已|已经)?用尽|为\s*0)/i,
  /(?:视频生成|生成视频|生成|免费)?次数\s*(?:不足|不够|(?:已|已经)?达到上限|(?:已|已经)?用完|(?:已|已经)?用尽|(?:已|已经)?耗尽)/i,
  /(?:账户|账号)?余额\s*不足/i,
  /(?:每日|今日|当日)?配额\s*(?:不足|不够|(?:已|已经)?达到上限|(?:已|已经)?耗尽|(?:已|已经)?用完|(?:已|已经)?用尽)/i,
  /\b(?:(?:daily|today(?:'s)?|generation|video\s+generation)\s+)?(?:quota|credits?)\b[\s\S]{0,20}\b(?:exhausted|depleted|insufficient|empty|used\s*up|limit(?:\s+has\s+been)?\s+reached|reached\s+(?:its\s+)?limit|exceeded)\b/i,
  /\b(?:insufficient\s+(?:quota|credits?)|no\s+credits?\s+left)\b/i,
];

const MEMBERSHIP_CONTEXT_PATTERN = /会员|权益|订阅|membership|premium/i;
const USER_PROMPT_CONTEXT_PATTERN = /提示词|prompt|用户(?:输入|指令|要求)|(?:请|帮我)\s*(?:生成|创作|写)|生成(?:一段|一个|一张|一条)[^。！？\n]{0,24}(?:文案|提示词|内容)/i;
const PLATFORM_ERROR_CONTEXT_PATTERN = /无法|不能|不可|失败|错误|请更换(?:账号|账户)?|请充值|充值后|重试|系统(?:提示|错误)|平台(?:提示|错误)/i;

function normalizeQuotaMessage(message: string): string {
  return message.normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
}

function hasFreeQuotaExhausted(message: string): boolean {
  return /免费[^。！？\n]{0,32}(?:额度|次数)[^。！？\n]{0,20}(?:已)?(?:用完|用尽|耗尽|达到上限)/i.test(message)
    || /(?:额度|次数)[^。！？\n]{0,20}(?:已)?(?:用完|用尽|耗尽|达到上限)[^。！？\n]{0,20}免费/i.test(message);
}

/**
 * 豆包免费额度耗尽后可能允许用户明确改用付费额度继续当前任务。
 * 这类消息是一次付费确认请求，不是需要自动换号的额度拒绝。
 */
export function isPaidQuotaConfirmationMessage(message: string): boolean {
  if (typeof message !== 'string' || message.trim().length === 0) return false;
  const normalized = normalizeQuotaMessage(message);
  const freeQuotaUsed = hasFreeQuotaExhausted(normalized);
  const paidQuotaOffered = /(?:使用|消耗|扣除)[^。！？\n]{0,16}付费额度|付费额度[^。！？\n]{0,16}(?:继续|生成)/i.test(normalized);
  const confirmationRequested = /是否[^。！？\n]{0,12}(?:继续|确认)|(?:继续|确认)[^。！？\n]{0,12}(?:生成|使用)/i.test(normalized);
  return freeQuotaUsed && paidQuotaOffered && confirmationRequested;
}

/**
 * 免费额度提示后，平台可能已经直接切入付费生成，不再展示确认按钮。
 * 必须同时看到“本次将消耗付费额度”和明确的生成等待证据，才视为当前
 * 账号已经开始生成；单纯展示可使用付费额度仍按真实额度耗尽处理。
 */
export function isPaidQuotaGenerationStartedMessage(message: string): boolean {
  if (typeof message !== 'string' || message.trim().length === 0) return false;
  const normalized = normalizeQuotaMessage(message);
  const paidQuotaCommitted = /(?:本次|当前任务)[^。！？\n]{0,16}(?:将|会|已)?(?:使用|消耗|扣除)[^。！？\n]{0,12}付费额度/i.test(normalized);
  const generationStarted = /预计[^。！？\n]{0,24}(?:等待|需时|需要)[^。！？\n]{0,12}(?:分钟|秒)|视频生成(?:好|完成)后[^。！？\n]{0,24}(?:主动)?(?:发送|通知)|(?:使用|进入)[^。！？\n]{0,12}优先生成通道/i.test(normalized);
  return hasFreeQuotaExhausted(normalized) && paidQuotaCommitted && generationStarted;
}

/**
 * 判断错误文本是否明确表示平台额度已不足或耗尽。
 *
 * 调用方应传入平台错误/阻断提示，而不是用户原始提示词。对明显的
 * 用户提示词上下文做一次保护，避免“请生成一段额度不足的文案”等文本
 * 触发自动换号。
 */
export function isQuotaExhaustedMessage(message: string): boolean {
  if (typeof message !== 'string' || message.trim().length === 0) return false;
  const normalized = normalizeQuotaMessage(message);

  if (
    isPaidQuotaConfirmationMessage(normalized)
    || isPaidQuotaGenerationStartedMessage(normalized)
  ) return false;

  // 会员/权益限制应由 membership_required 处理，不属于额度耗尽。
  if (MEMBERSHIP_CONTEXT_PATTERN.test(normalized)) return false;
  if (!QUOTA_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(normalized))) return false;

  // 只有在没有明确平台错误上下文时，才拦截明显的用户提示词文本。
  return !USER_PROMPT_CONTEXT_PATTERN.test(normalized) || PLATFORM_ERROR_CONTEXT_PATTERN.test(normalized);
}

const ERROR_RULES: Array<{ code: TaskErrorCode; recoverable: boolean; pattern: RegExp }> = [
  { code: 'cancelled', recoverable: true, pattern: /取消|中止|abort/i },
  // 会员限制必须先于额度耗尽检查："权益不足"属于会员/权益限制，不是额度耗尽。
  // 同一账号同一配置重试仍会被拒绝，需更换配置或升级会员。
  { code: 'membership_required', recoverable: false, pattern: /会员专享|仅限会员|仅会员可用|开通会员|升级会员|当前模型仅限会员|权益不足|会员权益不足|会员(?:免费)?(?:额度|次数|配额)(?:不足|不够|(?:已|已经)?达到上限|(?:已|已经)?耗尽|(?:已|已经)?用完|(?:已|已经)?用尽)/ },
  { code: 'quota_exhausted', recoverable: false, pattern: /免费次数.*用完|次数已用完|次数不足|余额不足/ },
  // 同一批真人脸素材再次提交通常仍会被平台拦截，需修改素材或提示词后再重新运行。
  { code: 'face_restricted', recoverable: false, pattern: /真人脸|人脸素材|人脸风险|肖像保护|人物面部|面部识别/ },
  // 内容安全/版权拒绝必须停在当前任务，不能靠换账号绕过平台审核。
  { code: 'content_rejected', recoverable: false, pattern: /侵权|版权(?:风险|限制)|色情内容|色情|内容未通过|审核未通过|违规|无法生成|安全策略拒绝/ },
  { code: 'verification', recoverable: true, pattern: /机器人验证|安全验证|验证码|滑块/ },
  { code: 'output_missing', recoverable: true, pattern: /产物.*超时|下载地址|可下载地址|产物尚未/ },
  { code: 'submission_failed', recoverable: true, pattern: /提交失败|提交超时|发送失败/ },
  { code: 'page_changed', recoverable: true, pattern: /未找到|配置.*失败|注入失败|切换.*失败|创建新对话失败/ },
  { code: 'network', recoverable: true, pattern: /network|fetch|连接|网络|ERR_/i },
  { code: 'timeout', recoverable: true, pattern: /超时|timeout/i },
  { code: 'generation_failed', recoverable: true, pattern: /生成失败|生成异常|豆包已停止生成/ },
];

/**
 * 根据错误消息分类任务错误类型。
 * @param message 错误消息原文
 * @param now 当前时间 ISO 字符串，默认 new Date().toISOString()，测试时可注入
 */
export function classifyTaskError(message: string, now: string = new Date().toISOString()): TaskErrorInfo {
  const transientCode = classifyTransientAutomationError(message);
  if (transientCode) {
    return {
      code: transientCode,
      message,
      recoverable: true,
      detectedAt: now,
    };
  }
  const matched = ERROR_RULES.find((rule) => (
    rule.code === 'quota_exhausted'
      ? isQuotaExhaustedMessage(message)
      : rule.pattern.test(message)
  ));
  return {
    code: matched?.code || 'unknown',
    message,
    recoverable: matched?.recoverable ?? true,
    detectedAt: now,
  };
}
