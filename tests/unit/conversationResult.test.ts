import { describe, expect, it } from 'vitest';
import {
  extractConversationReply,
  selectLatestAssistantReply,
} from '../../src/utils/conversationResult';

describe('selectLatestAssistantReply', () => {
  it('只返回当前会话最后一条助手消息，排除导航、用户消息和推荐问题', () => {
    expect(selectLatestAssistantReply([
      { role: 'unknown', text: '豆包\n历史会话\n设置', index: 0 },
      { role: 'user', text: '你好', index: 1, messageId: 'user-1' },
      { role: 'assistant', text: '你好呀！有什么我可以帮你的吗？', index: 2, messageId: 'assistant-1' },
      { role: 'unknown', text: '你能做些什么？\n你是被谁创造出来的？', index: 3 },
    ])).toBe('你好呀！有什么我可以帮你的吗？');
  });

  it('多轮对话只选择 DOM 顺序最后的助手消息', () => {
    expect(selectLatestAssistantReply([
      { role: 'assistant', text: '第一轮回复', index: 2, messageId: 'assistant-1' },
      { role: 'user', text: '第二个问题', index: 3, messageId: 'user-2' },
      { role: 'assistant', text: '第二轮回复', index: 4, messageId: 'assistant-2' },
    ])).toBe('第二轮回复');
  });

  it('助手候选为空或角色不明确时返回空字符串，不猜测页面文字', () => {
    expect(selectLatestAssistantReply([
      { role: 'user', text: '用户消息', index: 1 },
      { role: 'unknown', text: '推荐问题', index: 2 },
    ])).toBe('');
  });

  it('流式助手候选使用当前已经渲染的正文', () => {
    expect(selectLatestAssistantReply([
      { role: 'assistant', text: '你好呀！有什么我可以帮你的吗？', index: 8, messageId: 'streaming-1' },
    ])).toBe('你好呀！有什么我可以帮你的吗？');
  });

  it('忽略空白助手候选并保留正文两端之外的内容', () => {
    expect(selectLatestAssistantReply([
      { role: 'assistant', text: '   ', index: 1 },
      { role: 'assistant', text: '  正文内容  ', index: 2 },
    ])).toBe('正文内容');
  });
});

describe('extractConversationReply', () => {
  it('returns only text appended after the submitted conversation baseline', () => {
    expect(extractConversationReply('用户：你好', '用户：你好\n助手：你好，我可以帮你处理。'))
      .toBe('助手：你好，我可以帮你处理。');
  });

  it('falls back to the current snapshot when the page rewrites the text container', () => {
    expect(extractConversationReply('旧快照', '助手：新的回复')).toBe('助手：新的回复');
  });

  it('returns an empty string for an empty snapshot', () => {
    expect(extractConversationReply('基线', '  ')).toBe('');
  });
});
