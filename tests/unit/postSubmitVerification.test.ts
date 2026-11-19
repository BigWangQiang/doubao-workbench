import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decideStartupRecovery,
  decideVerificationRecovery,
  decidePostSubmitVerification,
  hasPostSubmitGenerationEvidence,
  MAX_TRANSIENT_PRE_SUBMIT_ATTEMPTS,
  MAX_VIDEO_CONTROL_RECOVERY_ATTEMPTS,
} from '../../src/utils/postSubmitVerification';
import { classifySubmissionReadback } from '../../src/utils/realSendStateMachine';
import { inspectPostSubmitGenerationState } from '../../src/utils/doubaoBridge';

describe('提交后人工验证判定', () => {
  it('图片已渲染且输入框已清空时视为提交已确认', () => {
    expect(classifySubmissionReadback({
      generationStarted: false,
      inputCleared: true,
      messageCount: 0,
      promptPublished: false,
      imageOutput: true,
    })).toBe('confirmed');
  });

  it('验证节点残留但已有生成回执时继续等待产物', () => {
    expect(decidePostSubmitVerification({
      verificationVisible: true,
      generationReceipt: true,
      generationActive: false,
      videoOutput: false,
    })).toBe('continue_generation');
  });

  it('验证节点残留但生成仍在进行时继续等待', () => {
    expect(decidePostSubmitVerification({
      verificationVisible: true,
      generationReceipt: false,
      generationActive: true,
      videoOutput: false,
    })).toBe('continue_generation');
  });

  it('验证节点残留且已经出现视频时继续提取', () => {
    expect(decidePostSubmitVerification({
      verificationVisible: true,
      generationReceipt: false,
      generationActive: false,
      videoOutput: true,
    })).toBe('continue_generation');
  });

  it('只有验证层、没有任何生成证据时才暂停', () => {
    expect(decidePostSubmitVerification({
      verificationVisible: true,
      generationReceipt: false,
      generationActive: false,
      videoOutput: false,
    })).toBe('pause_for_verification');
  });

  it('没有验证层时正常继续', () => {
    expect(decidePostSubmitVerification({
      verificationVisible: false,
      generationReceipt: false,
      generationActive: false,
      videoOutput: false,
    })).toBe('continue_generation');
  });

  it('生成证据聚合函数只依赖三类明确证据', () => {
    expect(hasPostSubmitGenerationEvidence({
      verificationVisible: true, generationReceipt: false, generationActive: false, videoOutput: false,
    })).toBe(false);
    expect(hasPostSubmitGenerationEvidence({
      verificationVisible: true, generationReceipt: false, generationActive: true, videoOutput: false,
    })).toBe(true);
  });

  it('人工验证后未提交任务自动重新入队', () => {
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'human_verification',
    })).toBe('retry_unsubmitted');
  });

  it('人工验证后已有提交意图只能只读核对，不能重试发送', () => {
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'human_verification',
      submittedAt: '2026-09-09T00:00:00.000Z',
  })).toBe('reconcile_submitted');
  });

  it('人工验证后尚未确认提交时只允许同账号自动重试一次', () => {
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'human_verification',
      submissionIntentAt: '2026-09-09T00:00:00.000Z',
      humanVerificationRetryCount: 0,
    })).toBe('retry_unsubmitted');
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'human_verification',
      submissionIntentAt: '2026-09-09T00:00:00.000Z',
      humanVerificationRetryCount: 1,
    })).toBe('none');
  });

  it('提交回执已确认时即使仍显示人机验证也只能只读核对', () => {
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'human_verification',
      submissionConfirmedAt: '2026-09-09T00:00:00.000Z',
      humanVerificationRetryCount: 0,
    })).toBe('reconcile_submitted');
  });

  it('提交前页面仍在加载时，页面恢复后允许安全重新入队', () => {
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'page_loading',
    })).toBe('retry_unsubmitted');
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'availability_check_timeout',
    })).toBe('retry_unsubmitted');
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'editor_not_focusable',
      attempt: MAX_TRANSIENT_PRE_SUBMIT_ATTEMPTS - 1,
    })).toBe('retry_unsubmitted');
  });

  it('视频控件与 Dola 动态时长菜单未就绪时也只在原账号恢复', () => {
    for (const errorCode of [
      'video_mode_entry_not_ready',
      'video_model_control_not_ready',
      'video_final_readback_not_ready',
      'dola_video_duration',
    ]) {
      expect(decideVerificationRecovery({
        status: 'waiting_verification',
        errorCode,
      })).toBe('retry_unsubmitted');
    }
  });

  it('视频控件瞬态错误最多在原账号恢复 8 次', () => {
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'dola_video_duration',
      attempt: MAX_VIDEO_CONTROL_RECOVERY_ATTEMPTS - 1,
    })).toBe('retry_unsubmitted');
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'dola_video_duration',
      attempt: MAX_VIDEO_CONTROL_RECOVERY_ATTEMPTS,
    })).toBe('none');
  });

  it('瞬时页面错误最多自动恢复三次，之后等待人工处理', () => {
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'page_not_ready',
      attempt: MAX_TRANSIENT_PRE_SUBMIT_ATTEMPTS,
    })).toBe('none');
  });

  it('瞬时页面错误已有提交意图时禁止自动重试', () => {
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'page_loading',
      submittedAt: '2026-09-09T00:00:00.000Z',
    })).toBe('none');
  });

  it('素材授权等其它人工等待态不走人机验证自动恢复', () => {
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'material_authorization_required',
    })).toBe('none');
    expect(decideVerificationRecovery({
      status: 'paused',
      errorCode: 'human_verification',
    })).toBe('none');
  });

  it('重启后已提交且有原会话的视频只读续查，未提交任务安全暂停', () => {
    expect(decideStartupRecovery({
      status: 'generating',
      mode: 'video',
      submittedAt: '2026-09-17T00:00:00.000Z',
      conversationUrl: 'https://www.dola.com/chat/1',
    })).toBe('reconcile_submitted_video');
    expect(decideStartupRecovery({ status: 'executing', mode: 'video' })).toBe('pause_interrupted');
    expect(decideStartupRecovery({ status: 'waiting_verification', mode: 'video' })).toBe('preserve_waiting');
  });

  it('重启续查标记只能进入已提交的只读核对', () => {
    expect(decideVerificationRecovery({
      status: 'waiting_verification',
      errorCode: 'startup_reconcile_required',
      submittedAt: '2026-09-17T00:00:00.000Z',
    })).toBe('reconcile_submitted');
  });
});

describe('提交后 DOM 检测边界', () => {
  const bridge = readFileSync(resolve(__dirname, '../../src/utils/doubaoBridge.ts'), 'utf8');
  const panel = readFileSync(resolve(__dirname, '../../src/components/BrowserPanel.tsx'), 'utf8');

  it('检测函数过滤隐藏/不可见验证节点，并只读扫描生成证据', () => {
    const start = bridge.indexOf('export async function inspectPostSubmitGenerationState');
    const end = bridge.indexOf('/** 检测提交后出现的机器人/安全验证界面。 */', start);
    const body = bridge.slice(start, end);
    expect(body).toContain("style.display === 'none'");
    expect(body).toContain("style.visibility === 'hidden'");
    expect(body).toContain("getAttribute('aria-hidden') === 'true'");
    expect(body).toContain('isTopmost');
    expect(body).toContain('frameRect.width < 100');
    expect(body).toContain('generationReceipt');
    expect(body).toContain('videoOutput');
    expect(body).not.toContain('.click()');
    expect(body).not.toContain('sendInputEvent');
  });

  it('提交后先判断生成证据，再决定是否进入人工验证暂停', () => {
    const start = panel.indexOf('let verificationDetected = false;');
    const end = panel.indexOf("setAccountAutomationState(accountId, 'generating', '等待豆包生成回复...", start);
    const body = panel.slice(start, end);
    expect(body).toContain('inspectPostSubmitGenerationState');
    expect(body).toContain('decidePostSubmitVerification');
    expect(body).toContain('pause_for_verification');
    expect(body).toContain('generationStartAfter');
  });

  it('平台回执确认后立即进入 generating，慢速复检不再被 submitting watchdog 误中断', () => {
    const confirmed = panel.indexOf('if (!submissionConfirmed)');
    const promoted = panel.indexOf("status: 'generating'", confirmed);
    const postSubmitInspection = panel.indexOf('inspectPostSubmitGenerationState', confirmed);
    expect(confirmed).toBeGreaterThanOrEqual(0);
    expect(promoted).toBeGreaterThan(confirmed);
    expect(promoted).toBeLessThan(postSubmitInspection);
    expect(panel.slice(confirmed, postSubmitInspection)).toContain("automationEngine.heartbeat(taskId, 'generating')");
  });

  it('验证恢复分流只允许未提交重排队或已提交只读核对', () => {
    expect(panel).toContain('recoverWaitingVerificationTasks');
    expect(panel).toContain('retry_unsubmitted');
    expect(panel).toContain("reconcile-task-submission");
    expect(panel).toContain('verificationReadyStreakRef');
    const recoveryStart = panel.indexOf('const recoverWaitingVerificationTasks');
    const recoveryEnd = panel.indexOf('/** 真实读取指定账号当前页面', recoveryStart);
    const recoveryBody = panel.slice(recoveryStart, recoveryEnd);
    const retryBranch = recoveryBody.indexOf("decision === 'retry_unsubmitted'");
    const reconcileBranch = recoveryBody.indexOf('正在只读核对原会话');
    expect(retryBranch).toBeGreaterThanOrEqual(0);
    expect(recoveryBody.slice(retryBranch)).toContain('latest?.assignedAccountId !== accountId');
    expect(recoveryBody.slice(retryBranch)).toContain('retryTask(task.id)');
    expect(reconcileBranch).toBeGreaterThanOrEqual(0);
    expect(recoveryBody.slice(reconcileBranch)).not.toContain('retryTask(task.id)');
  });

  it('验证码专用复检使用自身互斥锁，不会被普通检测标记永久阻断', () => {
    const probeStart = panel.indexOf('// waiting_verification 任务需要在用户完成验证后自动恢复');
    const probeEnd = panel.indexOf('// 代理配置变更后刷新对应账号页面', probeStart);
    const probeBody = panel.slice(probeStart, probeEnd);
    expect(probeBody).toContain('verificationProbeRef.current.has(accountId)');
    expect(probeBody).toContain('state.accountBusy[accountId]');
    expect(probeBody).not.toContain('accountState.availabilityChecking[accountId]');
    expect(probeBody).toContain("performAvailabilityCheck(accountId, webview, 'navigation')");
  });

  it('人工验证或重启恢复的只读核对使用长等待窗口，避免慢生成被 45 秒误判', () => {
    expect(panel).toContain('const isSubmittedVerificationRecovery =');
    expect(panel).toContain('isSubmittedVerificationRecovery || task.status === \'waiting_generation_confirmation\' || isManualObservation');
    expect(panel).toContain('? 15 * 60_000');
  });

  it('检测结果按显式布尔证据消费，并传递本次提交的监控基线', async () => {
    let injected = '';
    const result = await inspectPostSubmitGenerationState({
      executeJavaScript: async (code) => {
        injected = code;
        // 注入脚本在真实 Chromium 中执行；这里至少先做一次语法解析，
        // 防止模板字符串改动把运行时检测变成静默失败。
        new Function(code);
        return {
          verificationVisible: true,
          generationReceipt: false,
          generationActive: false,
          videoOutput: false,
        };
      },
      loadURL: () => undefined,
      getURL: () => 'https://www.dola.com/chat',
    }, { generationStartAfter: 1234 });
    expect(result).toMatchObject({ verificationVisible: true, generationReceipt: false, generationActive: false, videoOutput: false });
    expect(injected).toContain('monitorBaseline = 1234');
  });
});
