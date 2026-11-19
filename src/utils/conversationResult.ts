export type ConversationMessageRole = 'assistant' | 'user' | 'unknown';

/** 页面消息候选；index 使用 DOM 顺序，越大表示越靠后。 */
export interface ConversationMessageCandidate {
  role: ConversationMessageRole;
  text: string;
  index: number;
  messageId?: string;
}

/**
 * 从页面消息候选中选择当前会话最后一条助手回复。
 *
 * 角色未能明确识别时不猜测，避免把用户消息、推荐问题或页面文案当成回复。
 */
export function selectLatestAssistantReply(
  candidates: readonly ConversationMessageCandidate[],
): string {
  let latest: ConversationMessageCandidate | undefined;
  for (const candidate of candidates) {
    const text = candidate.text.trim();
    if (candidate.role !== 'assistant' || !text) continue;
    if (!latest || candidate.index >= latest.index) {
      latest = { ...candidate, text };
    }
  }
  return latest?.text || '';
}

/**
 * Extract the assistant's newly rendered text from a conversation snapshot.
 * The snapshot before submission is used as a stable prefix whenever the page
 * keeps historical messages in the same text container.
 */
export function extractConversationReply(baseline: string, current: string): string {
  const currentText = current.trim();
  if (!currentText) return '';

  const baselineText = baseline.trim();
  if (baselineText && currentText.startsWith(baselineText)) {
    return currentText.slice(baselineText.length).trim();
  }

  return currentText;
}
