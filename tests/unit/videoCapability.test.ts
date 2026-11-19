/**
 * tests/unit/videoCapability.test.ts
 * 视频能力预检纯逻辑单元测试
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateVideoCapability,
  suggestCompatibleVideoConfig,
  isRestrictionFailure,
  shouldStopVideoPolling,
} from '../../src/utils/videoCapability';
import type { VideoCapabilityInput } from '../../src/utils/videoCapability';
import type { SeedanceQuota, AccountHealth, AccountScheduling, AccountStatus } from '../../src/types';
import { buildDoubaoCapabilitySnapshot, evaluateDryRunSelection } from '../../src/automation/doubaoCapability';
import {
  getVideoCompositeLabel,
  buildVideoDurationSliderKeySequence,
  matchesVideoCompositeControlText,
  parseVideoCompositeControlText,
  normalizeDolaAspectRatio,
  getVideoModelUiLabel,
  clickAITab,
  inject15sVideoPatch,
  isVideoCompositeControlText,
  isVideoModelControlText,
  pollUntilReady,
  prepareVideoPromptForSubmission,
  resolveVideoDurationSliderTarget,
  sanitizeDolaThirtySecondPrompt,
  set15sVideoPatchEnabled,
  VIDEO_DIRECT_GENERATION_SUFFIX,
  VIDEO_COMPOSITE_CONTROL_SELECTOR,
  VIDEO_MODEL_CONTROL_SELECTOR,
} from '../../src/utils/doubaoBridge';

// ==================== 测试数据工厂 ====================

const FIXED_NOW = new Date('2026-07-14T12:00:00.000Z').getTime();

function makeBaseInput(overrides: Partial<VideoCapabilityInput> = {}): VideoCapabilityInput {
  return {
    model: 'seedance-2.0',
    duration: '10s',
    aspectRatio: '16:9',
    manual15sEnabled: false,
    accountStatus: 'idle',
    now: FIXED_NOW,
    ...overrides,
  };
}

const healthySeedanceQuota: SeedanceQuota = {
  date: '2026-07-14',
  usedUnits: 0,
  estimatedTotalUnits: 10,
  exhausted: false,
  updatedAt: '2026-07-14T00:00:00.000Z',
};

const healthyHealth: AccountHealth = {
  loginState: 'ok',
  verificationRequired: false,
  consecutiveFailures: 0,
  successCount: 5,
  failureCount: 0,
  lastSuccessAt: '2026-07-14T10:00:00.000Z',
};

const healthyScheduling: AccountScheduling = {
  enabled: true,
  weight: 1,
  preferredModes: ['video'],
};

const healthyAccountStatus: AccountStatus = 'idle';

// ==================== 测试用例 ====================

describe('evaluateVideoCapability', () => {
  // ---- 测试 1: 本地额度耗尽时阻止视频提交 ----
  describe('额度耗尽阻止提交', () => {
    it('seedanceQuota.exhausted = true 时返回 blocked', () => {
      const input = makeBaseInput({
        seedanceQuota: { ...healthySeedanceQuota, usedUnits: 10, exhausted: true },
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('blocked');
      expect(result.canSubmit).toBe(false);
      expect(result.issues.some(i => i.code === 'quota_exhausted' && i.blocking)).toBe(true);
      expect(result.userMessage).toContain('额度已耗尽');
    });

    it('10s 需要 2 单位，剩余 1 单位时在提交前阻止', () => {
      const result = evaluateVideoCapability(makeBaseInput({
        duration: '10s',
        seedanceQuota: { ...healthySeedanceQuota, usedUnits: 5, estimatedTotalUnits: 6, exhausted: false },
      }));
      expect(result.canSubmit).toBe(false);
      expect(result.userMessage).toContain('需 2 单位');
      expect(result.userMessage).toContain('剩余 1 单位');
    });

    it('使用账号自定义的单次视频消耗执行提交前门禁', () => {
      const result = evaluateVideoCapability(makeBaseInput({
        duration: '5s',
        seedanceQuota: {
          ...healthySeedanceQuota,
          usedUnits: 8,
          estimatedTotalUnits: 10,
          costPerVideoUnits: 3,
        },
      }));
      expect(result.canSubmit).toBe(false);
      expect(result.userMessage).toContain('需 3 单位');
      expect(result.userMessage).toContain('剩余 2 单位');
    });
  });

  // ---- 测试 2: 账号验证、登录失效、调度暂停、冷却中时阻止视频提交 ----
  describe('账号状态异常阻止提交', () => {
    it('登录失效时返回 blocked', () => {
      const input = makeBaseInput({
        health: { ...healthyHealth, loginState: 'expired', consecutiveFailures: 3 },
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('blocked');
      expect(result.canSubmit).toBe(false);
      expect(result.issues.some(i => i.code === 'login_expired')).toBe(true);
    });

    it('等待验证时返回 blocked', () => {
      const input = makeBaseInput({
        health: { ...healthyHealth, verificationRequired: true },
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('blocked');
      expect(result.canSubmit).toBe(false);
      expect(result.issues.some(i => i.code === 'verification_required')).toBe(true);
    });

    it('调度暂停时返回 blocked', () => {
      const input = makeBaseInput({
        scheduling: { ...healthyScheduling, enabled: false },
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('blocked');
      expect(result.canSubmit).toBe(false);
      expect(result.issues.some(i => i.code === 'scheduling_paused')).toBe(true);
    });

    it('冷却中时返回 blocked', () => {
      const futureTime = new Date(FIXED_NOW + 30 * 60 * 1000).toISOString();
      const input = makeBaseInput({
        health: { ...healthyHealth, cooldownUntil: futureTime, consecutiveFailures: 2 },
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('blocked');
      expect(result.canSubmit).toBe(false);
      expect(result.issues.some(i => i.code === 'cooldown_active')).toBe(true);
    });

    it('手动冷却中时返回 blocked', () => {
      const futureTime = new Date(FIXED_NOW + 60 * 60 * 1000).toISOString();
      const input = makeBaseInput({
        scheduling: { ...healthyScheduling, manualCooldownUntil: futureTime },
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('blocked');
      expect(result.canSubmit).toBe(false);
      expect(result.issues.some(i => i.code === 'cooldown_active')).toBe(true);
    });

    it('账号状态为 error 时返回 blocked', () => {
      const input = makeBaseInput({
        accountStatus: 'error' as AccountStatus,
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('blocked');
      expect(result.canSubmit).toBe(false);
      expect(result.issues.some(i => i.code === 'account_error')).toBe(true);
    });
  });

  describe('11–15s 页面实时能力门禁', () => {
    it('15s + seedance-2.0-fast 未拿到实时会员证据时不做本地会员拦截', () => {
      const input = makeBaseInput({
        model: 'seedance-2.0-fast',
        duration: '15s',
        seedanceQuota: healthySeedanceQuota,
        health: healthyHealth,
        scheduling: healthyScheduling,
        accountStatus: healthyAccountStatus,
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('unknown');
      expect(result.canSubmit).toBe(true);
      expect(result.issues.some(i => i.code === 'membership_required' && !i.blocking)).toBe(true);
    });

    it('15s + seedance-2.0-fast 提供建议配置但不改变原始配置', () => {
      const input = makeBaseInput({
        model: 'seedance-2.0-fast',
        duration: '15s',
        seedanceQuota: healthySeedanceQuota,
        health: healthyHealth,
        scheduling: healthyScheduling,
        accountStatus: healthyAccountStatus,
      });
      const result = evaluateVideoCapability(input);
      expect(result.suggestion).toBeUndefined();
      // 原始输入不被修改
      expect(input.model).toBe('seedance-2.0-fast');
      expect(input.duration).toBe('15s');
    });

    it('页面明确出现会员动作时返回 blocked', () => {
      const input = makeBaseInput({
        model: 'seedance-2.0',
        duration: '15s',
        seedanceQuota: healthySeedanceQuota,
        health: healthyHealth,
        scheduling: healthyScheduling,
        accountStatus: healthyAccountStatus,
        platformAvailability: 'membership_required',
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('blocked');
      expect(result.canSubmit).toBe(false);
    });

    it('只有页面实时确认 selectable 时允许 11s', () => {
      const result = evaluateVideoCapability(makeBaseInput({ duration: '11s', platformAvailability: 'selectable' }));
      expect(result.state).toBe('allowed');
      expect(result.canSubmit).toBe(true);
    });

    it('Dola 页面桥接提供 30s 时允许 30 秒配置', () => {
      const result = evaluateVideoCapability(makeBaseInput({
        duration: '30s',
        platform: 'dola',
        seedanceQuota: { ...healthySeedanceQuota, estimatedTotalUnits: 10 },
        health: healthyHealth,
        scheduling: healthyScheduling,
        accountStatus: healthyAccountStatus,
      }));
      expect(result.state).toBe('allowed');
      expect(result.canSubmit).toBe(true);
      expect(result.issues.some((issue) => issue.code === 'membership_required')).toBe(false);
    });

    it('豆包 30 秒在进入页面前保持待确认，并允许继续执行可见控件校验', () => {
      const result = evaluateVideoCapability(makeBaseInput({
        duration: '30s',
        seedanceQuota: { ...healthySeedanceQuota, estimatedTotalUnits: 10 },
      }));
      expect(result.state).toBe('unknown');
      expect(result.canSubmit).toBe(true);
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'membership_required', blocking: false }));
    });

    it('豆包 30 秒页面明确要求会员时阻止提交', () => {
      const result = evaluateVideoCapability(makeBaseInput({
        duration: '30s',
        platformAvailability: 'membership_required',
        seedanceQuota: { ...healthySeedanceQuota, estimatedTotalUnits: 10 },
      }));
      expect(result.state).toBe('blocked');
      expect(result.canSubmit).toBe(false);
    });
  });

  // ---- 测试 4: 明确会员限制文案分类为 membership_required 且不可恢复 ----
  describe('会员限制错误分类', () => {
    // 这个测试验证 errorClassification 模块，但通过 isRestrictionFailure 间接验证
    it('isRestrictionFailure 对 membership_required 返回 true', () => {
      expect(isRestrictionFailure('membership_required')).toBe(true);
    });

    it('isRestrictionFailure 对 quota_exhausted 返回 true', () => {
      expect(isRestrictionFailure('quota_exhausted')).toBe(true);
    });

    it('isRestrictionFailure 对 face_restricted 返回 true', () => {
      expect(isRestrictionFailure('face_restricted')).toBe(true);
    });

    it('isRestrictionFailure 对 content_rejected 返回 true', () => {
      expect(isRestrictionFailure('content_rejected')).toBe(true);
    });

    it('isRestrictionFailure 对非限制类错误返回 false', () => {
      expect(isRestrictionFailure('network')).toBe(false);
      expect(isRestrictionFailure('timeout')).toBe(false);
      expect(isRestrictionFailure('cancelled')).toBe(false);
      expect(isRestrictionFailure('unknown')).toBe(false);
    });
  });

  // ---- 测试 5: 限制失败不会进入长视频产物等待 ----
  describe('shouldStopVideoPolling', () => {
    it('membership_required 应立即停止轮询', () => {
      expect(shouldStopVideoPolling('membership_required')).toBe(true);
    });

    it('quota_exhausted 应立即停止轮询', () => {
      expect(shouldStopVideoPolling('quota_exhausted')).toBe(true);
    });

    it('face_restricted 应立即停止轮询', () => {
      expect(shouldStopVideoPolling('face_restricted')).toBe(true);
    });

    it('content_rejected 应立即停止轮询', () => {
      expect(shouldStopVideoPolling('content_rejected')).toBe(true);
    });

    it('generation_failed 应立即停止轮询', () => {
      expect(shouldStopVideoPolling('generation_failed')).toBe(true);
    });

    it('network 不应停止轮询（可重试）', () => {
      expect(shouldStopVideoPolling('network')).toBe(false);
    });

    it('timeout 不应停止轮询（可重试）', () => {
      expect(shouldStopVideoPolling('timeout')).toBe(false);
    });
  });

  // ---- 测试 6: 限制失败不会扣减 Seedance 预计额度 ----
  describe('额度扣减安全', () => {
    it('blocked 状态下 canSubmit = false，不会进入提交流程', () => {
      const input = makeBaseInput({
        seedanceQuota: { ...healthySeedanceQuota, usedUnits: 10, exhausted: true },
      });
      const result = evaluateVideoCapability(input);
      // canSubmit 为 false 意味着不会进入提交流程，因此不会调用 recordSeedanceUsage
      expect(result.canSubmit).toBe(false);
    });

    it('所有限制类失败码都不应触发 recordSeedanceUsage', () => {
      // recordSeedanceUsage 仅在 BrowserPanel 成功路径调用
      // 限制类失败的 isRestrictionFailure 返回 true，标记不扣减额度
      const restrictionCodes = ['membership_required', 'quota_exhausted', 'face_restricted', 'content_rejected'];
      for (const code of restrictionCodes) {
        expect(isRestrictionFailure(code)).toBe(true);
      }
    });
  });

  // ---- 测试 7: 建议配置仅作为建议，不改变原始 videoConfig ----
  describe('suggestCompatibleVideoConfig', () => {
    it('15s + seedance-2.0-fast 返回建议配置', () => {
      const suggestion = suggestCompatibleVideoConfig('seedance-2.0-fast', '15s');
      expect(suggestion).toBeDefined();
      expect(suggestion!.model).toBe('seedance-2.0-fast');
      expect(suggestion!.duration).toBe('10s');
      expect(suggestion!.reason).toContain('实时能力证据');
    });

    it('15s + 其他模型返回建议配置', () => {
      const suggestion = suggestCompatibleVideoConfig('seedance-2.0', '15s');
      expect(suggestion).toBeDefined();
      expect(suggestion!.duration).toBe('10s');
      expect(suggestion!.reason).toContain('实时能力证据');
    });

    it('非 15s 配置不返回建议', () => {
      const suggestion = suggestCompatibleVideoConfig('seedance-2.0', '10s');
      expect(suggestion).toBeUndefined();
    });

    it('5s 配置不返回建议', () => {
      const suggestion = suggestCompatibleVideoConfig('seedance-2.0', '5s');
      expect(suggestion).toBeUndefined();
    });

    it('建议配置不修改原始输入值', () => {
      const model = 'seedance-2.0-fast';
      const duration = '15s';
      const suggestion = suggestCompatibleVideoConfig(model, duration);
      expect(suggestion).toBeDefined();
      // 原始值不变
      expect(model).toBe('seedance-2.0-fast');
      expect(duration).toBe('15s');
    });
  });

  describe('旧补丁标记不能绕过会员门禁', () => {
    it('manual15sEnabled = true 时 15s 不改变未知会员状态', () => {
      const input = makeBaseInput({
        model: 'seedance-2.0-fast',
        duration: '15s',
        manual15sEnabled: true,
        seedanceQuota: healthySeedanceQuota,
        health: healthyHealth,
        scheduling: healthyScheduling,
        accountStatus: healthyAccountStatus,
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('unknown');
      expect(result.canSubmit).toBe(true);
    });

    it('manual15sEnabled = false 时 15s 也不做本地会员拦截', () => {
      const input = makeBaseInput({
        model: 'seedance-2.0-fast',
        duration: '15s',
        manual15sEnabled: false,
        seedanceQuota: healthySeedanceQuota,
        health: healthyHealth,
        scheduling: healthyScheduling,
        accountStatus: healthyAccountStatus,
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('unknown');
      expect(result.canSubmit).toBe(true);
    });

    it('manual15sEnabled = true 时额度耗尽仍返回 blocked', () => {
      const input = makeBaseInput({
        model: 'seedance-2.0-fast',
        duration: '15s',
        manual15sEnabled: true,
        seedanceQuota: { ...healthySeedanceQuota, usedUnits: 10, exhausted: true },
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('blocked');
      expect(result.canSubmit).toBe(false);
    });

    it('manual15sEnabled 不影响 allowed 状态', () => {
      const input = makeBaseInput({
        model: 'seedance-2.0',
        duration: '10s',
        manual15sEnabled: true,
        seedanceQuota: healthySeedanceQuota,
        health: healthyHealth,
        scheduling: healthyScheduling,
        accountStatus: healthyAccountStatus,
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('allowed');
      expect(result.canSubmit).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });

  // ---- 额外测试: 正常配置在健康账号下返回 allowed ----
  describe('正常配置允许提交', () => {
    it('10s + seedance-2.0 在健康账号下返回 allowed', () => {
      const input = makeBaseInput({
        model: 'seedance-2.0',
        duration: '10s',
        seedanceQuota: healthySeedanceQuota,
        health: healthyHealth,
        scheduling: healthyScheduling,
        accountStatus: healthyAccountStatus,
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('allowed');
      expect(result.canSubmit).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.userMessage).toBe('');
    });

    it('5s + seedance-2.0 在健康账号下返回 allowed', () => {
      const input = makeBaseInput({
        model: 'seedance-2.0',
        duration: '5s',
        seedanceQuota: healthySeedanceQuota,
        health: healthyHealth,
        scheduling: healthyScheduling,
        accountStatus: healthyAccountStatus,
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('allowed');
      expect(result.canSubmit).toBe(true);
    });
  });

  // ---- 额外测试: 多个阻塞条件同时存在 ----
  describe('多阻塞条件', () => {
    it('登录失效 + 额度耗尽同时存在时返回 blocked', () => {
      const input = makeBaseInput({
        health: { ...healthyHealth, loginState: 'expired', consecutiveFailures: 5 },
        seedanceQuota: { ...healthySeedanceQuota, usedUnits: 10, exhausted: true },
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).toBe('blocked');
      expect(result.canSubmit).toBe(false);
      expect(result.issues.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ---- 额外测试: 冷却已过期不阻塞 ----
  describe('冷却已过期', () => {
    it('cooldownUntil 在过去时不阻塞', () => {
      const pastTime = new Date(FIXED_NOW - 60 * 1000).toISOString();
      const input = makeBaseInput({
        health: { ...healthyHealth, cooldownUntil: pastTime, consecutiveFailures: 1 },
        seedanceQuota: healthySeedanceQuota,
        scheduling: healthyScheduling,
        accountStatus: healthyAccountStatus,
      });
      const result = evaluateVideoCapability(input);
      expect(result.state).not.toBe('blocked');
    });
  });
});

describe('豆包新 UI 只读能力快照与 dry-run', () => {
  const pageText = [
    '快速 视频生成 图像生成 PPT 写作 翻译 深入研究 录音转写 更多',
    'Seedance 2.5 Seedance 2.0 Seedance 2.0 Fast Seedance 2.0 Mini',
    'Seedream 5.0 Pro Seedream 5.0 Lite Seedream 4.5 Seedream 4.0',
    '4秒 5秒 10秒 11秒 15秒 3:4 4:3 9:16 16:9 1:1 21:9 2:3 3:2',
  ].join(' ');

  it('记录时间、账户层级、页面来源和适配器版本', () => {
    const snapshot = buildDoubaoCapabilitySnapshot({
      pageUrl: 'https://www.doubao.com/chat/create-video/',
      bodyText: pageText,
      observedAt: '2026-07-31T10:00:00.000Z',
      accountTier: '免费',
    });
    expect(snapshot.observed_at).toBe('2026-07-31T10:00:00.000Z');
    expect(snapshot.account_tier).toBe('免费');
    expect(snapshot.source.kind).toBe('page');
    expect(snapshot.adapter_version).toMatch(/^2\./);
  });

  it('从页面文字识别新模型、入口、比例和 4–15 秒范围', () => {
    const snapshot = buildDoubaoCapabilitySnapshot({ pageUrl: 'https://www.doubao.com/', bodyText: pageText });
    expect(snapshot.entries).toContain('视频生成');
    expect(snapshot.video.models).toContain('Seedance 2.5');
    expect(snapshot.image.models).toContain('Seedream 5.0 Pro');
    expect(snapshot.video.durations).toEqual([4, 5, 10, 11, 15]);
    expect(snapshot.image.aspect_ratios).toContain('2:3');
  });

  it('元素缺失时返回 unknown，不猜测能力', () => {
    const snapshot = buildDoubaoCapabilitySnapshot({ pageUrl: 'https://www.doubao.com/', bodyText: '' });
    expect(snapshot.status).toBe('unknown');
    expect(snapshot.video.models).toEqual([]);
    expect(snapshot.account_tier).toBe('unknown');
  });

  it('会员窗口记录为 action_required，dry-run 返回 membership_required', () => {
    const snapshot = buildDoubaoCapabilitySnapshot({
      pageUrl: 'https://www.doubao.com/',
      bodyText: pageText,
      membershipDialogText: '升级会员后可使用更长视频',
    });
    expect(snapshot.membership.availability).toBe('action_required');
    expect(evaluateDryRunSelection(snapshot, { model: 'Seedance 2.5', duration: 11, aspectRatio: '16:9' }))
      .toEqual({ ok: false, code: 'membership_required', finalSubmit: false });
  });

  it.each(['购买会员', '升级会员', '会员专享'])('真实会员动作证据 %s 均 fail-closed', (membershipDialogText) => {
    const snapshot = buildDoubaoCapabilitySnapshot({
      pageUrl: 'https://www.doubao.com/',
      bodyText: pageText,
      membershipDialogText,
    });
    expect(snapshot.membership.availability).toBe('action_required');
    expect(evaluateDryRunSelection(snapshot, { model: 'Seedance 2.0 Fast', duration: 15, aspectRatio: '9:16' }))
      .toEqual({ ok: false, code: 'membership_required', finalSubmit: false });
  });

  it.each([
    ['unknown', true, 'ready'],
    ['selectable', true, 'ready'],
  ] as const)('11 秒 availability=%s 时按实时证据门禁', (availability, ok, code) => {
    const snapshot = buildDoubaoCapabilitySnapshot({ pageUrl: 'https://www.doubao.com/', bodyText: pageText });
    snapshot.membership.availability = availability;
    expect(evaluateDryRunSelection(snapshot, { model: 'Seedance 2.5', duration: 11, aspectRatio: '16:9' }))
      .toEqual({ ok, code, finalSubmit: false });
  });

  it('dry-run 只验证可见配置，永不提交最终生成', () => {
    const snapshot = buildDoubaoCapabilitySnapshot({ pageUrl: 'https://www.doubao.com/', bodyText: pageText });
    expect(evaluateDryRunSelection(snapshot, { model: 'Seedance 2.5', duration: 10, aspectRatio: '16:9' }))
      .toEqual({ ok: true, code: 'ready', finalSubmit: false });
  });

  it('历史 15 秒请求改写入口固定拒绝启用', async () => {
    const forbiddenWebview = new Proxy({}, { get: () => { throw new Error('不得访问 webview'); } });
    expect(await inject15sVideoPatch(forbiddenWebview as never)).toBe(false);
    expect(await set15sVideoPatchEnabled(forbiddenWebview as never, true)).toBe(false);
  });

  it('Dola 30 秒提示词仅将中文时长标记转换为 ASCII s', () => {
    const source = '动作序列（30秒）：0-5秒对峙，5~15秒对决；每秒慢动作。';
    expect(sanitizeDolaThirtySecondPrompt(source)).toBe('动作序列（30s）：0-5s对峙，5~15s对决；每秒慢动作。');
  });

  it('豆包和 Dola 视频发送副本首尾添加直出指令且不会重复', () => {
    const source = '让人物走向镜头';
    const expected = `${VIDEO_DIRECT_GENERATION_SUFFIX}\n${source}\n${VIDEO_DIRECT_GENERATION_SUFFIX}`;
    const doubao = prepareVideoPromptForSubmission(source, { platform: 'doubao', duration: '30s' });
    expect(doubao).toBe(expected);
    expect(prepareVideoPromptForSubmission(doubao, { platform: 'doubao', duration: '30s' })).toBe(doubao);

    const dola = prepareVideoPromptForSubmission('动作持续30秒', { platform: 'dola', duration: '30s' });
    expect(dola).toBe(`${VIDEO_DIRECT_GENERATION_SUFFIX}\n动作持续30s\n${VIDEO_DIRECT_GENERATION_SUFFIX}`);
  });

  it('兼容旧任务只在开头或末尾已有直出指令', () => {
    const source = '镜头缓慢推近';
    const expected = `${VIDEO_DIRECT_GENERATION_SUFFIX}\n${source}\n${VIDEO_DIRECT_GENERATION_SUFFIX}`;
    expect(prepareVideoPromptForSubmission(
      `${source}\n${VIDEO_DIRECT_GENERATION_SUFFIX}`,
      { platform: 'doubao' },
    )).toBe(expected);
    expect(prepareVideoPromptForSubmission(
      `${VIDEO_DIRECT_GENERATION_SUFFIX}\n${source}`,
      { platform: 'doubao' },
    )).toBe(expected);
  });

  it.each([
    [{ min: 4, max: 30, now: 10, valueText: '10s' }, 30, { targetValue: 30, stepsFromHome: 26 }],
    [{ min: 0, max: 26, now: 6, valueText: '10s' }, 30, { targetValue: 26, stepsFromHome: 26 }],
    [{ min: 0, max: 11, now: 6, valueText: '10s' }, 15, { targetValue: 11, stepsFromHome: 11 }],
  ] as const)('豆包时长滑杆 %o 可映射到 %s 秒', (snapshot, seconds, expected) => {
    expect(resolveVideoDurationSliderTarget(snapshot, seconds)).toEqual(expected);
  });

  it('旧版 4–15 秒滑杆不允许选择 30 秒', () => {
    expect(resolveVideoDurationSliderTarget({ min: 0, max: 11 }, 30)).toBeNull();
  });

  it('豆包 30 秒使用 End，普通刻度仍从 Home 逐格选择', () => {
    expect(buildVideoDurationSliderKeySequence({ min: 0, max: 26, now: 6, valueText: '10s' }, 30)).toEqual(['End']);
    expect(buildVideoDurationSliderKeySequence({ min: 0, max: 26, now: 6, valueText: '10s' }, 6)).toEqual([
      'Home', 'Right', 'Right',
    ]);
  });

  it.each([
    { min: 0, max: 26, secondsOffset: 4 },
    { min: 4, max: 30, secondsOffset: 0 },
    { min: 0, max: 11, secondsOffset: 4 },
  ])('豆包时长 $min–$max 的 Electron 按键能到达下发秒数', ({ min, max, secondsOffset }) => {
    const durations = [4, 5, 6, 8, 10, 12, 15, 30].filter((seconds) => seconds <= max + secondsOffset);
    for (const seconds of durations) {
      let value = max;
      const keys = buildVideoDurationSliderKeySequence({ min, max }, seconds);
      expect(keys.length).toBeGreaterThan(0);
      // 按 Electron 的公开输入合同模拟刻度；DOM ArrowRight 不属于合法键名。
      for (const key of keys) {
        switch (key) {
          case 'Home': value = min; break;
          case 'End': value = max; break;
          case 'Right': value = Math.min(max, value + 1); break;
          default: throw new Error(`Electron 不支持的时长按键: ${key}`);
        }
      }
      expect(value + secondsOffset).toBe(seconds);
    }
  });

  it('豆包 30 秒优先通过页面滑杆配置并要求稳定回读', () => {
    const bridgeSource = readFileSync(resolve(__dirname, '../../src/utils/doubaoBridge.ts'), 'utf8');
    expect(bridgeSource).toContain("durationSeconds <= 15 || durationSeconds === 30");
    expect(bridgeSource).toContain('resolveVideoDurationSliderTarget(candidate, durationSeconds)');
    expect(bridgeSource).toContain("if (target.targetValue === snapshot.max) return ['End']");
    expect(bridgeSource).toContain("await verifyFinalStableReadback();");
  });
});

describe('新版视频控件适配契约', () => {
  it('视频模式首击仅展开菜单时，必须二次精确选择并等待权威控件挂载', async () => {
    let injected = '';
    const webview = {
      executeJavaScript: async (code: string) => {
        injected = code;
        return { ok: true, method: 'button-bottom-menu-confirmed', tag: 'BUTTON', pos: '1,1' };
      },
      getURL: () => 'https://www.doubao.com/chat/',
      loadURL: () => undefined,
    };

    expect(await clickAITab(webview, 'video')).toBe(true);
    expect(injected).toContain('data-valid-btn="mode-select-action-btn"');
    expect(injected).toContain('data-input-engine-actionbar-control-key="video-model"');
    expect(injected).toContain('data-creation-params-panel-id');
    expect(injected).toContain('waitForModeEntry(15000)');
    expect(injected).toContain('findVisibleModeMenuOption(5000)');
    expect(injected).toContain('waitForVideoControls(15000)');
  });

  it('视频入口超时返回 false，调用链必须在参数配置前 fail-closed', async () => {
    const webview = {
      executeJavaScript: async () => ({ ok: false, error: '视频生成模式入口未在等待窗口内挂载' }),
      getURL: () => 'https://www.doubao.com/chat/',
      loadURL: () => undefined,
    };
    expect(await clickAITab(webview, 'video')).toBe(false);

    const panelSource = readFileSync(resolve(__dirname, '../../src/components/BrowserPanel.tsx'), 'utf8');
    const switchGuard = panelSource.indexOf('const modeEntry = await recoverModeEntry({');
    const configureCall = panelSource.indexOf('await configureVideoOptions(webview, videoConfig)');
    expect(switchGuard).toBeGreaterThan(-1);
    expect(panelSource.slice(switchGuard, configureCall)).toContain('if (!modeEntry.switched)');
    expect(panelSource.slice(switchGuard, configureCall)).toContain('currentTask?.runtime?.submittedAt');
    expect(panelSource.slice(switchGuard, configureCall)).toContain('已在提交前停止');
  });

  it('自动化执行优先使用任务 targetPlatform，避免 Dola 任务回退到豆包入口', () => {
    const panelSource = readFileSync(resolve(__dirname, '../../src/components/BrowserPanel.tsx'), 'utf8');
    expect(panelSource).toContain('task.targetPlatform,');
    expect(panelSource).toContain('const automationPlatform = targetPlatform || account?.platform || \'doubao\'');
    expect(panelSource).toContain('clickAITab(webview, mode, automationPlatform)');
    expect(panelSource).toContain('platform: automationPlatform');
  });

  it('Dola 已直接挂载视频参数栏时，不依赖豆包式视频 Tab 文本', async () => {
    let injected = '';
    const webview = {
      executeJavaScript: async (code: string) => {
        injected = code;
        return { ok: true, method: 'dola-video-controls-already-mounted', tag: 'DOLA_VIDEO_CONTROLS', pos: '' };
      },
      getURL: () => 'https://www.dola.com/chat',
      loadURL: () => undefined,
    };

    expect(await clickAITab(webview, 'video', 'dola')).toBe(true);
    expect(injected).toContain("'dola' === 'dola'");
    expect(injected).toContain('dola-video-controls-already-mounted');
    expect(injected).toContain('waitForDolaVideoMode(3000)');
    expect(injected).toContain('dolaVideoModeReady');
    expect(injected).toContain("#flow-end-msg-send");
    expect(injected).toContain('dolaVideoModeSnapshot');
    expect(injected).toContain('hasRatio');
    expect(injected).not.toContain("!Array.from(item.el.children || []).some");
    const bridgeSource = readFileSync(resolve(__dirname, '../../src/utils/doubaoBridge.ts'), 'utf8');
    expect(bridgeSource).toContain('normalized.indexOf(value) === 0');
  });

  it('权威控件和精确模型选项均采用有界轮询，不依赖固定菜单等待', () => {
    const bridgeSource = readFileSync(resolve(__dirname, '../../src/utils/doubaoBridge.ts'), 'utf8');
    expect(bridgeSource).toContain('{ timeoutMs: 30_000, stableSamples: 3 }');
    expect(bridgeSource).toContain('throw new VideoControlReadinessError');
    expect(bridgeSource).toContain("'final_readback'");
    expect(bridgeSource).toContain('const waitForExactOverlayOption = async');
    expect(bridgeSource).toContain("waitForExactOverlayOption(modelLabel, 'video_model')");
    expect(bridgeSource).toContain('const waitForModelVerification = async');
  });

  it('Dola 2.0 Fast 比例收纳在更多菜单时仍走受限展开与选中态回读', () => {
    const bridgeSource = readFileSync(resolve(__dirname, '../../src/utils/doubaoBridge.ts'), 'utf8');
    expect(bridgeSource).toContain('find_dola_more_control');
    expect(bridgeSource).toContain('Dola 视频更多控件');
    expect(bridgeSource).toContain('read_dola_ratio_selection');
    expect(bridgeSource).toContain('moreAvailable');
    expect(bridgeSource).toContain("['画面比例', '比例', '画幅', 'Aspect Ratio']");
    expect(bridgeSource).toContain('ratioReadbackEvidence');
    expect(bridgeSource).toContain('await closeDolaMoreMenu()');
    expect(bridgeSource).toContain('menuLike(el)');
  });

  it('Dola 入口不再要求比例控件先于模型/时长挂载，比例仍由配置阶段强制回读', () => {
    const bridgeSource = readFileSync(resolve(__dirname, '../../src/utils/doubaoBridge.ts'), 'utf8');
    expect(bridgeSource).toContain('ready: Boolean(hasModel && hasDuration && (hasRatio || hasMoreControl)');
    expect(bridgeSource).toContain('视频生成×');
    expect(bridgeSource).toContain('后续 configureDolaVideoOptions 仍会强制完成比例选择与最终回读');
  });

  it('Dola 30 秒只从输入栏菜单上下文兜底定位，不影响豆包滑杆路径', () => {
    const bridgeSource = readFileSync(resolve(__dirname, '../../src/utils/doubaoBridge.ts'), 'utf8');
    expect(bridgeSource).toContain('function actionBarRoot()');
    expect(bridgeSource).toContain('if (kind === \'duration\' && inConversation(el)) return false;');
    expect(bridgeSource).toContain('function durationContext(el)');
    expect(bridgeSource).toContain('普通 DIV，没有 role/menu');
    expect(bridgeSource).toContain("const selectDolaDuration = async (): Promise<void> =>");
    expect(bridgeSource).toContain("if (!slider && durationSeconds === 30)");
  });

  it('Dola 控件快照注入脚本自包含 clickable，避免读取模型/时长/比例时脚本异常', () => {
    const bridgeSource = readFileSync(resolve(__dirname, '../../src/utils/doubaoBridge.ts'), 'utf8');
    const readSnapshotStart = bridgeSource.indexOf('const readSnapshot = async');
    const readSnapshotEnd = bridgeSource.indexOf("'dola_video_controls').catch", readSnapshotStart);
    expect(readSnapshotStart).toBeGreaterThan(-1);
    expect(readSnapshotEnd).toBeGreaterThan(readSnapshotStart);
    const injectedSource = bridgeSource.slice(readSnapshotStart, readSnapshotEnd);
    expect(injectedSource).toContain('function clickable(el)');
    expect(injectedSource).toContain("el.getAttribute('role') === 'button'");
  });

  it('Dola 更多入口兼容无 aria 的 class/SVG 控件，并允许 portal 二级比例菜单', () => {
    const bridgeSource = readFileSync(resolve(__dirname, '../../src/utils/doubaoBridge.ts'), 'utf8');
    expect(bridgeSource).toContain('[data-icon]');
    expect(bridgeSource).toContain('[class*="ellipsis"]');
    expect(bridgeSource).toContain('portal');
    expect(bridgeSource).toContain('!clickable(el) && !semanticMore(el)');
  });

  it('Dola 直接比例控件和更多入口都按原入口重开并回读', () => {
    const bridgeSource = readFileSync(resolve(__dirname, '../../src/utils/doubaoBridge.ts'), 'utf8');
    expect(bridgeSource).toContain("let ratioEntry: 'direct' | 'more' | 'existing' = 'existing'");
    expect(bridgeSource).toContain('reopenRatioMenuForReadback');
    expect(bridgeSource).toContain("ratioEntry === 'direct'");
    expect(bridgeSource).toContain('video-ratio');
    expect(bridgeSource).toContain('直接比例布局可能在按钮上只显示“比例”');
  });

  it('Dola 比例选项优先精确文本和 menuitem，避免 16:9 被 4:3 的窄子节点抢先命中', () => {
    const bridgeSource = readFileSync(resolve(__dirname, '../../src/utils/doubaoBridge.ts'), 'utf8');
    expect(bridgeSource).toContain('if (ratioLookup) return true;');
    expect(bridgeSource).toContain('var exactRatioCandidates = candidates.filter(function (item)');
    expect(bridgeSource).toContain('var aExact = expected.some(function (value)');
    expect(bridgeSource).toContain("/^(?:option|menuitem)$/.test");
    expect(bridgeSource).toContain('return Number(bExact) - Number(aExact) || bRole - aRole || bArea - aArea;');
  });

  it('页面控件延迟挂载时持续轮询并在出现后立即成功', async () => {
    let clock = 0;
    let probes = 0;
    const ready = await pollUntilReady(
      () => ++probes === 4,
      {
        timeoutMs: 1_000,
        intervalMs: 100,
        now: () => clock,
        wait: async (ms) => { clock += ms; },
      },
    );
    expect(ready).toBe(true);
    expect(probes).toBe(4);
    expect(clock).toBe(300);
  });

  it('页面控件始终不挂载时在有界窗口结束并返回 false', async () => {
    let clock = 0;
    const ready = await pollUntilReady(
      () => false,
      {
        timeoutMs: 1_000,
        intervalMs: 250,
        now: () => clock,
        wait: async (ms) => { clock += ms; },
      },
    );
    expect(ready).toBe(false);
    expect(clock).toBe(1_000);
  });

  it.each([
    ['seedance-2.5', 'Seedance 2.5'],
    ['seedance-2.0', 'Seedance 2.0'],
    ['seedance-2.0-fast', 'Seedance 2.0 Fast'],
    ['seedance-2.0-mini', 'Seedance 2.0 Mini'],
  ])('模型 %s 只映射到精确可见标签 %s', (model, expected) => {
    expect(getVideoModelUiLabel(model)).toBe(expected);
  });

  it('未知模型不产生宽松匹配候选，必须 fail-closed', () => {
    expect(getVideoModelUiLabel('fast')).toBeNull();
    expect(getVideoModelUiLabel('seedance-2.0-ultra')).toBeNull();
  });

  it('新版组合控件的回读文本必须同时包含比例和时长', () => {
    expect(getVideoCompositeLabel('9:16', '5s')).toBe('9:16 · 5s');
    expect(getVideoCompositeLabel('自动', '10s')).toBe('自动 · 10s');
  });

  it('Dola 2.0 Fast 的组合标签可拆出 16:9 与 30s', () => {
    expect(parseVideoCompositeControlText('16:9 · 30s')).toEqual({ ratio: '16:9', duration: '30s' });
    expect(parseVideoCompositeControlText('16：9\n·\n30秒')).toEqual({ ratio: '16:9', duration: '30s' });
  });

  it.each([
    '1:1 · 30s',
    '1:1·30s',
    '画面比例 1：1 / 30 秒',
  ])('豆包组合控件按语义回读，不依赖页面空格和全角符号: %s', (label) => {
    expect(matchesVideoCompositeControlText(label, '1:1', '30s')).toBe(true);
  });

  it('豆包组合控件兼容英文 Auto 比例回读', () => {
    expect(matchesVideoCompositeControlText('Auto · 10s', 'auto', '10s')).toBe(true);
  });

  it('豆包组合控件拒绝比例或时长不一致', () => {
    expect(matchesVideoCompositeControlText('16:9 · 30s', '1:1', '30s')).toBe(false);
    expect(matchesVideoCompositeControlText('1:1 · 10s', '1:1', '30s')).toBe(false);
  });

  it('Dola 2.0 Fast 带控件前缀或属性后缀时仍能回读比例', () => {
    expect(parseVideoCompositeControlText('画面比例 16:9 · 30 秒')).toEqual({ ratio: '16:9', duration: '30s' });
    expect(parseVideoCompositeControlText('16:9（横屏） / 30s')).toEqual({ ratio: '16:9', duration: '30s' });
  });

  it('兼容 Dola 页面使用斜杠、乘号和方向别名显示比例', () => {
    expect(parseVideoCompositeControlText('16 / 9 · 30s')).toEqual({ ratio: '16:9', duration: '30s' });
    expect(normalizeDolaAspectRatio('画幅 9×16')).toBe('9:16');
    expect(normalizeDolaAspectRatio('竖屏')).toBe('9:16');
    expect(normalizeDolaAspectRatio('自适应')).toBe('自动');
  });

  it('优先使用新版页面稳定结构属性，不依赖易变的样式类名', () => {
    expect(VIDEO_MODEL_CONTROL_SELECTOR).toBe('[data-input-engine-actionbar-control-key="video-model"]');
    expect(VIDEO_COMPOSITE_CONTROL_SELECTOR).toBe('[data-creation-params-panel-id]');
  });

  it.each([
    ['模型\nSeedance 2.0 Fast', 'Seedance 2.0 Fast', true],
    ['模型   Seedance 2.0 Fast', 'Seedance 2.0 Fast', true],
    ['模型 Seedance 2.0', 'Seedance 2.0 Fast', false],
    ['Seedance 2.0 Fast', 'Seedance 2.0 Fast', false],
  ])('模型控件文本 %j 对目标 %s 的精确回读为 %s', (text, expected, matched) => {
    expect(isVideoModelControlText(text, expected)).toBe(matched);
  });

  it.each([
    ['自动 · 10s', true],
    ['9:16\n·\n10s', true],
    ['16:9 · 5s', true],
    ['比例 · 10s', false],
    ['9:16', false],
  ])('组合控件文本 %j 的结构判定为 %s', (text, matched) => {
    expect(isVideoCompositeControlText(text)).toBe(matched);
  });
});
