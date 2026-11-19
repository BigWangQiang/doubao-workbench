/**
 * tests/unit/errorClassification.test.ts
 * 任务错误分类回归测试
 */

import { describe, it, expect } from 'vitest';
import {
  classifyTaskError,
  classifyTransientAutomationError,
  isPaidQuotaConfirmationMessage,
  isPaidQuotaGenerationStartedMessage,
  isQuotaExhaustedMessage,
} from '../../src/utils/errorClassification';

describe('classifyTaskError', () => {
  const FIXED_TIME = '2025-01-01T00:00:00.000Z';

  it('匹配 cancelled — 取消/中止', () => {
    const result = classifyTaskError('任务已取消', FIXED_TIME);
    expect(result.code).toBe('cancelled');
    expect(result.recoverable).toBe(true);
    expect(result.detectedAt).toBe(FIXED_TIME);
  });

  it('匹配 cancelled — abort', () => {
    const result = classifyTaskError('Request was aborted by user', FIXED_TIME);
    expect(result.code).toBe('cancelled');
  });

  it('匹配 quota_exhausted — 次数用完（不可恢复）', () => {
    const result = classifyTaskError('免费次数已用完', FIXED_TIME);
    expect(result.code).toBe('quota_exhausted');
    expect(result.recoverable).toBe(false);
  });

  it('匹配 quota_exhausted — 余额不足', () => {
    const result = classifyTaskError('账户余额不足', FIXED_TIME);
    expect(result.code).toBe('quota_exhausted');
    expect(result.recoverable).toBe(false);
  });

  it.each([
    '额度不足，请更换账号',
    '视频生成额度不足',
    '额度已达到上限',
    '额度达到上限',
    '额度已耗尽',
    '生成次数达到上限',
    '今日视频生成次数已达到上限',
    '今天视频生成额度已用完',
    '当日视频额度不足',
    '剩余额度为 0',
    'quota exhausted',
    'generation quota limit reached',
    'no credits left',
  ])('严格识别额度耗尽消息：%s', (message) => {
    expect(isQuotaExhaustedMessage(message)).toBe(true);
    expect(classifyTaskError(message, FIXED_TIME).code).toBe('quota_exhausted');
  });

  it('把可继续使用付费额度的豆包提示识别为确认请求，而不是额度拒绝', () => {
    const message = '今日视频生成免费额度已用完，本次将消耗付费额度。是否继续生成？';
    expect(isPaidQuotaConfirmationMessage(message)).toBe(true);
    expect(isQuotaExhaustedMessage(message)).toBe(false);
    expect(classifyTaskError(message, FIXED_TIME).code).not.toBe('quota_exhausted');
  });

  it('把已经进入付费通道的视频回复识别为生成中，而不是额度耗尽', () => {
    const message = '本次使用 Seedance 2.5 生成，预计等待 5 分钟。视频生成好后，我会主动发送给你。今日视频生成免费额度已用完，本次将消耗付费额度，并使用优先生成通道。';
    expect(isPaidQuotaConfirmationMessage(message)).toBe(false);
    expect(isPaidQuotaGenerationStartedMessage(message)).toBe(true);
    expect(isQuotaExhaustedMessage(message)).toBe(false);
    expect(classifyTaskError(message, FIXED_TIME).code).not.toBe('quota_exhausted');
  });

  it('只有付费额度说明、没有开始生成证据时不能掩盖真实额度耗尽', () => {
    const message = '今日视频生成免费额度已用完，本次可使用付费额度，请稍后重试';
    expect(isPaidQuotaGenerationStartedMessage(message)).toBe(false);
    expect(isQuotaExhaustedMessage(message)).toBe(true);
  });

  it('没有付费继续选项的额度耗尽仍然触发换号', () => {
    const message = '今日视频生成免费额度已用完，请明天再试';
    expect(isPaidQuotaConfirmationMessage(message)).toBe(false);
    expect(isQuotaExhaustedMessage(message)).toBe(true);
    expect(classifyTaskError(message, FIXED_TIME).code).toBe('quota_exhausted');
  });

  it.each([
    '额度',
    '今日视频生成说明',
    '账号额度设置为 100',
    '请生成一段额度不足的宣传文案',
    '请生成一段账号额度不足的宣传文案',
    '请生成一段额度已耗尽的宣传文案',
    '用户提示词：视频生成额度不足的场景',
    '会员额度不足，请升级会员',
    '会员免费次数已用完，请升级会员',
  ])('不把普通文本或用户提示词识别为额度耗尽：%s', (message) => {
    expect(isQuotaExhaustedMessage(message)).toBe(false);
  });

  it('匹配 membership_required（不可恢复）', () => {
    const result = classifyTaskError('此功能仅限会员', FIXED_TIME);
    expect(result.code).toBe('membership_required');
    expect(result.recoverable).toBe(false);
  });

  it('匹配 membership_required — 权益不足（回归：不能误判为 quota_exhausted）', () => {
    const result = classifyTaskError('权益不足，请开通会员', FIXED_TIME);
    expect(result.code).toBe('membership_required');
    expect(result.recoverable).toBe(false);
  });

  it('匹配 membership_required — 仅会员可用', () => {
    const result = classifyTaskError('仅会员可用', FIXED_TIME);
    expect(result.code).toBe('membership_required');
    expect(result.recoverable).toBe(false);
  });

  it('匹配 membership_required — 开通会员', () => {
    const result = classifyTaskError('请开通会员后使用', FIXED_TIME);
    expect(result.code).toBe('membership_required');
    expect(result.recoverable).toBe(false);
  });

  it('匹配 membership_required — 会员额度不足（回归：不能误判为 quota_exhausted）', () => {
    const result = classifyTaskError('会员额度不足，请升级会员', FIXED_TIME);
    expect(result.code).toBe('membership_required');
    expect(result.recoverable).toBe(false);
  });

  it('匹配 membership_required — 会员免费次数已用完', () => {
    const result = classifyTaskError('会员免费次数已用完，请升级会员', FIXED_TIME);
    expect(result.code).toBe('membership_required');
    expect(result.recoverable).toBe(false);
  });

  it('回归：权益不足不匹配 quota_exhausted', () => {
    const result = classifyTaskError('权益不足', FIXED_TIME);
    expect(result.code).not.toBe('quota_exhausted');
    expect(result.code).toBe('membership_required');
  });

  it('匹配 face_restricted', () => {
    const result = classifyTaskError('检测到真人脸，肖像保护', FIXED_TIME);
    expect(result.code).toBe('face_restricted');
    expect(result.recoverable).toBe(false);
  });

  it('匹配人脸风险并禁止自动重发', () => {
    const result = classifyTaskError('检测到人脸风险，无法继续生成', FIXED_TIME);
    expect(result.code).toBe('face_restricted');
    expect(result.recoverable).toBe(false);
  });

  it('匹配 content_rejected', () => {
    const result = classifyTaskError('内容未通过审核', FIXED_TIME);
    expect(result.code).toBe('content_rejected');
    expect(result.recoverable).toBe(false);
  });

  it.each([
    '侵权风险，无法生成',
    '色情内容不支持生成',
    '版权风险',
    '生成的音频可能涉及版权限制，请更换输入内容后重试',
  ])('匹配内容安全拒绝：%s', (message) => {
    const result = classifyTaskError(message, FIXED_TIME);
    expect(result.code).toBe('content_rejected');
    expect(result.recoverable).toBe(false);
  });

  it('匹配 verification', () => {
    const result = classifyTaskError('请完成机器人验证', FIXED_TIME);
    expect(result.code).toBe('verification');
  });

  it('匹配 output_missing', () => {
    const result = classifyTaskError('产物下载地址超时', FIXED_TIME);
    expect(result.code).toBe('output_missing');
  });

  it('匹配 submission_failed', () => {
    const result = classifyTaskError('提交失败，请重试', FIXED_TIME);
    expect(result.code).toBe('submission_failed');
  });

  it('匹配 page_changed', () => {
    const result = classifyTaskError('未找到输入框，注入失败', FIXED_TIME);
    expect(result.code).toBe('page_changed');
  });

  it('页面/控件瞬态文本没有 code 时也归入可恢复状态', () => {
    expect(classifyTransientAutomationError('dola_video_duration 选项不可见，已在提交前停止')).toBe('dola_video_duration');
    expect(classifyTaskError('页面就绪检测超时（20000ms）', FIXED_TIME)).toMatchObject({
      code: 'page_not_ready',
      recoverable: true,
    });
    expect(classifyTaskError('编辑器尚未挂载，页面仍在加载', FIXED_TIME)).toMatchObject({
      code: 'editor_not_found',
      recoverable: true,
    });
  });

  it('登录失效不会被瞬态页面规则吞掉', () => {
    expect(classifyTransientAutomationError('账号已掉线，请重新登录')).toBeUndefined();
    expect(classifyTaskError('账号已掉线，请重新登录', FIXED_TIME).code).not.toBe('page_not_ready');
  });

  it('匹配 network', () => {
    const result = classifyTaskError('network error', FIXED_TIME);
    expect(result.code).toBe('network');
  });

  it('匹配 timeout', () => {
    const result = classifyTaskError('请求超时', FIXED_TIME);
    expect(result.code).toBe('timeout');
  });

  it('匹配 generation_failed', () => {
    const result = classifyTaskError('生成失败，请重试', FIXED_TIME);
    expect(result.code).toBe('generation_failed');
  });

  it('未匹配时返回 unknown，默认可恢复', () => {
    const result = classifyTaskError('一个完全无法识别的错误消息', FIXED_TIME);
    expect(result.code).toBe('unknown');
    expect(result.recoverable).toBe(true);
    expect(result.message).toBe('一个完全无法识别的错误消息');
  });

  it('保留原始消息', () => {
    const msg = '免费次数已用完，请明天再来';
    const result = classifyTaskError(msg, FIXED_TIME);
    expect(result.message).toBe(msg);
  });

  it('detectedAt 默认使用当前时间', () => {
    const before = new Date().toISOString();
    const result = classifyTaskError('timeout');
    const after = new Date().toISOString();
    expect(result.detectedAt >= before).toBe(true);
    expect(result.detectedAt <= after).toBe(true);
  });
});
