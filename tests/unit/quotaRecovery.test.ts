import { describe, expect, it } from 'vitest';
import type { Account, Task } from '../../src/types';
import {
  canAutoSwitchBeforeSubmission,
  selectPreSubmitFallbackAccount,
} from '../../src/utils/quotaRecovery';

function account(id: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    name: id,
    avatar: '',
    partition: id,
    platform: 'dola',
    status: 'idle',
    pinned: false,
    seedanceQuota: {
      date: '2026-09-23',
      usedUnits: 0,
      estimatedTotalUnits: 6,
      exhausted: false,
      updatedAt: '2026-09-23T00:00:00.000Z',
    },
    health: {
      loginState: 'ok',
      verificationRequired: false,
      consecutiveFailures: 0,
      successCount: 0,
      failureCount: 0,
      availability: {
        state: 'ready',
        reason: 'ready',
        message: '可用',
        checkedAt: '2026-09-23T00:00:00.000Z',
        source: 'manual',
      },
    },
    scheduling: {
      enabled: true,
      weight: 1,
      preferredModes: ['video'],
    },
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  };
}

function task(): Task {
  return {
    id: 'task-1',
    prompt: '视频',
    targetPlatform: 'dola',
    assignedAccountId: 'failed',
    status: 'executing',
    mode: 'video',
    videoConfig: { model: 'seedance-2.5', duration: '10s', aspectRatio: '16:9' },
    result: null,
    outputs: [],
    artifacts: [],
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  };
}

describe('提交前账号故障恢复', () => {
  it('只有账号级提交前故障自动切号，页面与控件瞬态错误留在原账号恢复', () => {
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'login_required' })).toBe(true);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'page_not_ready' })).toBe(false);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'video_model_control_not_ready' })).toBe(false);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'dola_video_duration' })).toBe(false);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'submission_failed' })).toBe(false);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'membership_required' })).toBe(true);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'quota_exhausted' })).toBe(true);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'face_restricted' })).toBe(true);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'content_rejected' })).toBe(true);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'login_required', submittedAt: 'now' })).toBe(false);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'human_verification' })).toBe(false);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'material_authorization_required' })).toBe(false);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'submission_uncertain' })).toBe(false);
    expect(canAutoSwitchBeforeSubmission({ errorCode: 'network', userInitiatedAbort: true })).toBe(false);
  });

  it('候选账号只选择同平台且已确认可用的账号', () => {
    const current = task();
    const selected = selectPreSubmitFallbackAccount(
      current,
      [current],
      [
        account('failed'),
        account('ready'),
        account('unknown', { health: { ...account('unknown').health!, availability: { ...account('unknown').health!.availability!, state: 'unknown', reason: 'page_loading' } } }),
        account('dola-login', { health: { ...account('dola-login').health!, availability: { ...account('dola-login').health!.availability!, state: 'login_required', reason: 'login_required' } } }),
        account('doubao', { platform: 'doubao' }),
      ],
      'failed',
    );
    expect(selected).toBe('ready');
  });
});
