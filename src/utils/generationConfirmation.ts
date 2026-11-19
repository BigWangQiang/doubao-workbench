export interface GenerationConfirmationEvidence {
  state: 'present' | 'absent' | 'unknown';
  detectedAt: string;
  marker?: 'parameter_confirmation' | 'confirm_before_generation';
  model?: string;
  duration?: string;
  aspectRatio?: string;
}

export type DoubaoVideoReplyAction =
  | 'wait_for_reply'
  | 'send_confirmation'
  | 'wait_for_video'
  | 'collect_video';

export interface DoubaoVideoReplyDecisionInput {
  platform: string | undefined;
  mode: string | undefined;
  latestAssistantReply: string;
  assistantReplyBeforeSubmit: string;
  currentMessageCount: number;
  initialMessageCount: number;
  waitForAssistantAfterMessageCount?: number;
  lastConfirmedAssistantReply?: string;
  replyStable: boolean;
}

export type ManualDoubaoConfirmationAction = 'wait_for_user' | 'wait_for_video' | 'collect_video';

export interface ManualDoubaoConfirmationDecisionInput {
  latestAssistantReply: string;
  currentMessageCount: number;
  baselineMessageCount: number;
  baselineConversationText: string;
  currentConversationText: string;
}

export interface DoubaoConfirmationReadbackInput {
  beforeMessageCount: number;
  currentMessageCount: number;
  confirmationStillInComposer: boolean;
  assistantReplyBeforeConfirmation: string;
  latestAssistantReply: string;
  conversationTextBeforeConfirmation: string;
  currentConversationText: string;
}

function normalizeReplyText(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/** 确认请求可同时带预计耗时；不能仅凭“预计几分钟”就认定任务已经开始。 */
export function isDoubaoVideoConfirmationRequest(text: string): boolean {
  const normalized = normalizeReplyText(text)
    .replace(/(?:无需|不必|不用|不需要)[^。！？!?]{0,24}(?:确认|回复)[^。！？!?]*/g, '');
  return /视频生成参数确认|请(?:你|您)?[^。！？!?]{0,12}确认|需要(?:你|您)[^。！？!?]{0,8}确认/.test(normalized)
    || /确认后[^。！？!?]{0,24}(?:生成|制作)视频/.test(normalized)
    || /(?:回复|输入|发送)\s*[“"'「『]\s*确认(?:生成视频)?\s*[”"'」』]/.test(normalized);
}

/** 仅放行本任务首次从新对话入口获得正式地址，其余换会话仍需人工核对。 */
export function canFollowDoubaoInitialConversation(input: {
  previousUrl: string | undefined;
  currentUrl: string;
  matchesTask: boolean;
}): boolean {
  if (!input.matchesTask || !input.previousUrl) return false;
  try {
    const previous = new URL(input.previousUrl);
    const current = new URL(input.currentUrl);
    const isDoubao = (url: URL): boolean => url.protocol === 'https:'
      && url.hostname.replace(/^www\./, '') === 'doubao.com' && !url.port
      && !url.username && !url.password;
    return isDoubao(previous) && isDoubao(current)
      && /^\/chat\/?$/.test(previous.pathname)
      && /^\/chat\/[A-Za-z0-9_-]+\/?$/.test(current.pathname);
  } catch {
    return false;
  }
}

/**
 * 豆包新版页面不一定提供 data-message-id。确认文字已离开输入框后，消息计数、
 * 新助手回复或会话正文增长任一成立，都可证明单次原生点击已经发布。
 */
export function hasDoubaoConfirmationReadback(
  input: DoubaoConfirmationReadbackInput,
): boolean {
  if (input.confirmationStillInComposer) return false;
  if (input.currentMessageCount > input.beforeMessageCount) return true;

  const previousReply = normalizeReplyText(input.assistantReplyBeforeConfirmation);
  const latestReply = normalizeReplyText(input.latestAssistantReply);
  if (latestReply && latestReply !== previousReply) return true;

  const previousConversation = normalizeReplyText(input.conversationTextBeforeConfirmation);
  const currentConversation = normalizeReplyText(input.currentConversationText);
  return !!previousConversation
    && currentConversation.length > previousConversation.length
    && currentConversation !== previousConversation;
}

/** 豆包确认进入长耗时视频生成后，UI 不再回退显示“等待回复”。 */
export function getDoubaoGenerationWaitMessage(
  waitingForVideo: boolean,
  elapsedSeconds: number,
): string {
  const seconds = Math.max(0, Math.round(elapsedSeconds));
  return waitingForVideo
    ? `等待视频生成中... (${seconds}s)`
    : `等待回复... (${seconds}s)`;
}

/** 豆包明确进入长耗时生成后，停止继续回复“确认”。 */
export function isDoubaoVideoWaitingReply(text: string): boolean {
  const normalized = normalizeReplyText(text);
  if (!normalized) return false;
  return /视频(?:正在生成|生成中)|正在(?:为你)?生成(?:视频)?|预计(?:需|需要)?等待|预计.{0,24}(?:分钟|秒)|生成(?:完成|好)后.{0,24}(?:主动)?(?:发送|通知)/.test(normalized);
}

/** 豆包明确报告视频已完成后，直接进入产物采集。 */
export function isDoubaoVideoCompletedReply(text: string): boolean {
  const normalized = normalizeReplyText(text);
  if (!normalized) return false;
  return /你的视频(?:已经|已)?生成好了|视频(?:已经|已)?生成(?:完成|成功)(?!后|时)/.test(normalized);
}

/**
 * 豆包视频确认轮次判定。
 *
 * 每次确认后必须先看到一条新的助手消息；消息正文即使与上一轮完全相同，
 * 只要消息计数确实越过确认后的基线，也视为新一轮回复。
 */
export function decideDoubaoVideoReplyAction(
  input: DoubaoVideoReplyDecisionInput,
): DoubaoVideoReplyAction {
  if (input.platform !== 'doubao' || input.mode !== 'video') return 'wait_for_reply';

  const reply = normalizeReplyText(input.latestAssistantReply);
  if (!reply) return 'wait_for_reply';
  const hasNewAssistantReply = input.waitForAssistantAfterMessageCount !== undefined
    ? input.currentMessageCount > input.waitForAssistantAfterMessageCount
      || reply !== normalizeReplyText(input.lastConfirmedAssistantReply || '')
    : reply !== normalizeReplyText(input.assistantReplyBeforeSubmit)
      || input.currentMessageCount > input.initialMessageCount;
  const confirmationRequested = isDoubaoVideoConfirmationRequest(reply);
  // 已完成的“请确认效果”不能再次触发生成；“生成完成后发你”则不是完成回执。
  if (isDoubaoVideoCompletedReply(reply)) return 'collect_video';
  if (confirmationRequested) {
    return hasNewAssistantReply && input.replyStable ? 'send_confirmation' : 'wait_for_reply';
  }
  if (isDoubaoVideoWaitingReply(reply)) return 'wait_for_video';

  if (!hasNewAssistantReply || !input.replyStable) return 'wait_for_reply';
  return 'send_confirmation';
}

/**
 * 会话地址变化后，等待用户在当前会话人工回复确认。
 *
 * 在看到人工新消息前，不能把旧的“请确认”回复当成已确认；一旦消息基线
 * 发生变化，就进入只读的“等待视频生成”阶段，后续不再自动发送确认。
 */
export function decideManualDoubaoConfirmationAction(
  input: ManualDoubaoConfirmationDecisionInput,
): ManualDoubaoConfirmationAction {
  const baseline = normalizeReplyText(input.baselineConversationText);
  const current = normalizeReplyText(input.currentConversationText);
  const conversationAdvanced = current.length > baseline.length && current !== baseline;
  const messageAdvanced = input.currentMessageCount > input.baselineMessageCount;
  if (!conversationAdvanced && !messageAdvanced) return 'wait_for_user';

  const reply = normalizeReplyText(input.latestAssistantReply);
  if (isDoubaoVideoCompletedReply(reply)) return 'collect_video';
  return 'wait_for_video';
}

export function classifyGenerationConfirmationText(text: string, detectedAt = new Date().toISOString()): GenerationConfirmationEvidence {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  const parameterMarker = /视频生成参数确认/.test(normalized);
  const confirmMarker = /确认后.{0,16}(?:开始|进行|为你)?生成视频/.test(normalized) || /回复[“"']?确认[”"']?.{0,16}生成/.test(normalized);
  if (!parameterMarker && !confirmMarker) return { state: 'absent', detectedAt };
  const model = normalized.match(/Seedance\s*[0-9.]+(?:\s*Fast|\s*Mini)?/i)?.[0];
  const duration = normalized.match(/(?:时长|视频时长)[:：]?\s*(\d{1,2}\s*s|\d{1,2}\s*秒)/i)?.[1]?.replace(/\s+/g, '');
  const aspectRatio = normalized.match(/(?:比例|画面比例)[:：]?\s*(\d{1,2}:\d{1,2})/)?.[1];
  return {
    state: 'present',
    detectedAt,
    marker: parameterMarker ? 'parameter_confirmation' : 'confirm_before_generation',
    model,
    duration,
    aspectRatio,
  };
}

export function isGenerationConfirmationTask(task: {
  status?: string;
  errorInfo?: { code?: string };
} | undefined): boolean {
  return task?.status === 'waiting_generation_confirmation' || task?.errorInfo?.code === 'generation_confirmation_required';
}
