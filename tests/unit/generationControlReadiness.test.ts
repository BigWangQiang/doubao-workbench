import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyGenerationConfirmationText,
  canFollowDoubaoInitialConversation,
  decideManualDoubaoConfirmationAction,
  decideDoubaoVideoReplyAction,
  getDoubaoGenerationWaitMessage,
  hasDoubaoConfirmationReadback,
  isDoubaoVideoCompletedReply,
  isDoubaoVideoWaitingReply,
  isGenerationConfirmationTask,
} from '../../src/utils/generationConfirmation';
import { VideoControlReadinessError, waitForVideoControlReadiness } from '../../src/utils/videoControlReadiness';
import { matchesSubmissionConversation, requiresSubmissionReconciliation } from '../../src/utils/realSendStateMachine';

describe('视频生成参数确认独立状态', () => {
  it.each([
    ['视频生成参数确认：模型 Seedance 2.0 Fast，时长 5s，比例 9:16。确认后我再开始生成视频', 'parameter_confirmation'],
    ['请回复“确认”，我将开始生成视频', 'confirm_before_generation'],
  ])('识别平台确认语义并仅返回结构化摘要', (text, marker) => {
    const result = classifyGenerationConfirmationText(text, '2026-08-27T23:00:00.000Z');
    expect(result).toMatchObject({ state: 'present', marker });
    expect(result).not.toHaveProperty('text');
  });

  it('提取模型、时长、比例但不保存完整页面文本', () => {
    expect(classifyGenerationConfirmationText('视频生成参数确认 模型：Seedance 2.0 Fast 时长：5秒 比例：9:16 确认后开始生成视频')).toMatchObject({
      state: 'present', model: 'Seedance 2.0 Fast', duration: '5秒', aspectRatio: '9:16',
    });
  });

  it('普通提示或普通回复不会误判确认页', () => {
    expect(classifyGenerationConfirmationText('请生成一个商品视频，不需要再次询问').state).toBe('absent');
  });

  it('等待确认任务即使缺 submittedAt 也永久禁止重试发送', () => {
    const task = { status: 'waiting_generation_confirmation', errorInfo: { code: 'generation_confirmation_required' } };
    expect(isGenerationConfirmationTask(task)).toBe(true);
    expect(requiresSubmissionReconciliation(task)).toBe(true);
  });

  it('原会话匹配允许确认页作为平台回执，仍要求提示词稳定前缀', () => {
    const prompt = 'TikTok 商品视频开场，唯一成年女性数字人向镜头介绍猫抓板。';
    expect(matchesSubmissionConversation(prompt, `${prompt} 视频生成参数确认，确认后我再开始生成视频`)).toBe(true);
    expect(matchesSubmissionConversation(prompt, '另一任务 视频生成参数确认，确认后我再开始生成视频')).toBe(false);
  });
});

describe('豆包视频逐轮自动确认', () => {
  const base = {
    platform: 'doubao',
    mode: 'video',
    latestAssistantReply: '请确认是否按以上参数开始生成',
    assistantReplyBeforeSubmit: '',
    currentMessageCount: 3,
    initialMessageCount: 1,
    replyStable: true,
  };

  it.each([
    '视频生成中，请稍候',
    '正在为你生成视频',
    '预计等待 15 分钟，生成后主动发送给你',
  ])('识别等待回复并停止继续确认：%s', (reply) => {
    expect(isDoubaoVideoWaitingReply(reply)).toBe(true);
    expect(decideDoubaoVideoReplyAction({ ...base, latestAssistantReply: reply })).toBe('wait_for_video');
  });

  it('识别视频生成等待后展示准确状态，不再回退为等待回复', () => {
    expect(getDoubaoGenerationWaitMessage(false, 57)).toBe('等待回复... (57s)');
    expect(getDoubaoGenerationWaitMessage(true, 57)).toBe('等待视频生成中... (57s)');
  });

  it.each([
    '你的视频生成好了，请查收',
    '视频已生成完成',
  ])('识别完成回复并立即进入采集：%s', (reply) => {
    expect(isDoubaoVideoCompletedReply(reply)).toBe(true);
    expect(decideDoubaoVideoReplyAction({ ...base, latestAssistantReply: reply })).toBe('collect_video');
  });

  it('新回复既不是等待也不是完成时发送确认', () => {
    expect(decideDoubaoVideoReplyAction(base)).toBe('send_confirmation');
  });

  it.each([
    '视频生成参数确认：时长 15 秒，预计需要 3 分钟，确认后开始生成视频。',
    '请回复“确认生成视频”，预计等待 3 分钟，生成后会发送给你。',
    '确认后我将为你生成视频，预计 2 分钟。',
    '请确认是否按照以上方案生成，视频生成完成后主动发送给你。',
  ])('确认请求优先于同条回复中的预计耗时：%s', (reply) => {
    expect(decideDoubaoVideoReplyAction({ ...base, latestAssistantReply: reply })).toBe('send_confirmation');
    expect(decideDoubaoVideoReplyAction({ ...base, latestAssistantReply: reply, replyStable: false })).toBe('wait_for_reply');
    expect(decideDoubaoVideoReplyAction({
      ...base, latestAssistantReply: reply, lastConfirmedAssistantReply: reply,
      waitForAssistantAfterMessageCount: base.currentMessageCount,
    })).toBe('wait_for_reply');
  });

  it('明确无需再次确认的生成中回复不重复发送', () => {
    expect(decideDoubaoVideoReplyAction({
      ...base, latestAssistantReply: '视频正在生成，无需再回复“确认”，请稍候。',
    })).toBe('wait_for_video');
  });

  it('完成后的“请确认效果”只回收视频，不再次发送确认', () => {
    expect(decideDoubaoVideoReplyAction({
      ...base, latestAssistantReply: '视频已生成完成，请确认效果。',
    })).toBe('collect_video');
    expect(isDoubaoVideoCompletedReply('视频生成完成后主动发送给你')).toBe(false);
  });

  it('确认后未出现新助手消息时禁止盲目重复发送', () => {
    expect(decideDoubaoVideoReplyAction({
      ...base,
      currentMessageCount: 4,
      waitForAssistantAfterMessageCount: 4,
      lastConfirmedAssistantReply: base.latestAssistantReply,
    })).toBe('wait_for_reply');
  });

  it('下一条助手回复即使正文相同，只要消息计数增加仍再次确认', () => {
    expect(decideDoubaoVideoReplyAction({
      ...base,
      currentMessageCount: 5,
      waitForAssistantAfterMessageCount: 4,
      lastConfirmedAssistantReply: base.latestAssistantReply,
    })).toBe('send_confirmation');
  });

  it('助手快速返回不同内容时，即使计数基线已追平也识别为新回复', () => {
    expect(decideDoubaoVideoReplyAction({
      ...base,
      latestAssistantReply: '还需要你再次确认',
      currentMessageCount: 5,
      waitForAssistantAfterMessageCount: 5,
      lastConfirmedAssistantReply: base.latestAssistantReply,
    })).toBe('send_confirmation');
  });

  it('回复仍在流式变化时等待稳定，不提前发送确认', () => {
    expect(decideDoubaoVideoReplyAction({ ...base, replyStable: false })).toBe('wait_for_reply');
  });

  it('Dola 视频和非视频任务不进入豆包确认循环', () => {
    expect(decideDoubaoVideoReplyAction({ ...base, platform: 'dola' })).toBe('wait_for_reply');
    expect(decideDoubaoVideoReplyAction({ ...base, mode: 'image' })).toBe('wait_for_reply');
  });

  it('新版页面消息计数不变但助手已回复时确认回执成立', () => {
    expect(hasDoubaoConfirmationReadback({
      beforeMessageCount: 0,
      currentMessageCount: 0,
      confirmationStillInComposer: false,
      assistantReplyBeforeConfirmation: '确认后我再开始生成视频。',
      latestAssistantReply: '收到，已确认全部设定，直接启动视频生成。',
      conversationTextBeforeConfirmation: '确认后我再开始生成视频。',
      currentConversationText: '确认后我再开始生成视频。 确认 收到，已确认全部设定，直接启动视频生成。',
    })).toBe(true);
  });

  it('相同助手回复但会话正文新增确认气泡时确认回执成立', () => {
    expect(hasDoubaoConfirmationReadback({
      beforeMessageCount: 0,
      currentMessageCount: 0,
      confirmationStillInComposer: false,
      assistantReplyBeforeConfirmation: '请确认',
      latestAssistantReply: '请确认',
      conversationTextBeforeConfirmation: '参数如下，请确认',
      currentConversationText: '参数如下，请确认 确认',
    })).toBe(true);
  });

  it('输入框仍保留确认或页面没有新增证据时不得误判回执', () => {
    const evidence = {
      beforeMessageCount: 1,
      currentMessageCount: 2,
      confirmationStillInComposer: true,
      assistantReplyBeforeConfirmation: '请确认',
      latestAssistantReply: '收到',
      conversationTextBeforeConfirmation: '请确认',
      currentConversationText: '请确认 确认 收到',
    };
    expect(hasDoubaoConfirmationReadback(evidence)).toBe(false);
    expect(hasDoubaoConfirmationReadback({
      ...evidence,
      currentMessageCount: 1,
      confirmationStillInComposer: false,
      latestAssistantReply: '请确认',
      currentConversationText: '请确认',
    })).toBe(false);
  });
});

describe('豆包首次会话地址分配', () => {
  it('本任务首次从入口跳到正式会话时允许继续软件确认', () => {
    expect(canFollowDoubaoInitialConversation({
      previousUrl: 'https://www.doubao.com/chat/',
      currentUrl: 'https://www.doubao.com/chat/task-conversation-1',
      matchesTask: true,
    })).toBe(true);
  });

  it.each([
    ['https://www.doubao.com/chat/old', 'https://www.doubao.com/chat/new', true],
    ['https://www.doubao.com/chat/', 'https://www.doubao.com/chat/new', false],
    ['https://www.doubao.com/chat/', 'https://www.dola.com/chat/new', true],
    ['https://www.doubao.com/chat/', 'https://example.com/chat/new', true],
    ['https://www.doubao.com/chat/', 'https://www.doubao.com/chat/', true],
    ['', 'https://www.doubao.com/chat/new', true],
  ])('其他会话变化保持人工核对边界：%s -> %s', (previousUrl, currentUrl, matchesTask) => {
    expect(canFollowDoubaoInitialConversation({ previousUrl, currentUrl, matchesTask })).toBe(false);
  });
});

describe('豆包会话变化后的人工确认', () => {
  const baseline = {
    latestAssistantReply: '请回复确认后开始生成视频',
    baselineMessageCount: 4,
    baselineConversationText: '用户提示词 请回复确认后开始生成视频',
  };

  it('人工回复前继续等待，不把旧确认消息当成已确认', () => {
    expect(decideManualDoubaoConfirmationAction({
      ...baseline,
      currentMessageCount: 4,
      currentConversationText: baseline.baselineConversationText,
    })).toBe('wait_for_user');
  });

  it('检测到人工新消息后进入等待视频生成，禁止自动补发确认', () => {
    expect(decideManualDoubaoConfirmationAction({
      ...baseline,
      currentMessageCount: 5,
      currentConversationText: `${baseline.baselineConversationText} 确认`,
    })).toBe('wait_for_video');
  });

  it('人工回复后平台直接报告完成时进入产物采集', () => {
    expect(decideManualDoubaoConfirmationAction({
      ...baseline,
      latestAssistantReply: '你的视频已经生成好了',
      currentMessageCount: 5,
      currentConversationText: `${baseline.baselineConversationText} 确认 视频已经生成好了`,
    })).toBe('collect_video');
  });
});

describe('视频参数控件有界分段等待', () => {
  it('模型与组合控件连续三次稳定后才通过', async () => {
    let now = 0;
    let attempt = 0;
    const snapshots = [
      { modelReady: false, compositeReady: false },
      { modelReady: true, compositeReady: false },
      { modelReady: true, compositeReady: true },
      { modelReady: true, compositeReady: true },
      { modelReady: true, compositeReady: true },
    ];
    const result = await waitForVideoControlReadiness(
      () => snapshots[Math.min(attempt++, snapshots.length - 1)],
      { timeoutMs: 10_000, now: () => now, wait: async (ms) => { now += ms; } },
    );
    expect(result).toMatchObject({ ready: true, attempts: 5 });
    expect(result.modelVisibleAtMs).toBeDefined();
    expect(result.compositeVisibleAtMs).toBeDefined();
    expect(result.stableAtMs).toBe(result.elapsedMs);
  });

  it('中途抖动会重置连续稳定计数', async () => {
    let now = 0;
    let attempt = 0;
    const snapshots = [true, true, false, true, true, true].map((ready) => ({ modelReady: ready, compositeReady: ready }));
    const result = await waitForVideoControlReadiness(
      () => snapshots[Math.min(attempt++, snapshots.length - 1)],
      { timeoutMs: 20_000, now: () => now, wait: async (ms) => { now += ms; } },
    );
    expect(result.ready).toBe(true);
    expect(result.attempts).toBe(6);
  });

  it.each([
    [{ modelReady: false, compositeReady: true }, 'model_control'],
    [{ modelReady: true, compositeReady: false }, 'composite_control'],
  ] as const)('缺失权威控件时输出具体失败阶段', async (snapshot, failureStage) => {
    let now = 0;
    const result = await waitForVideoControlReadiness(() => snapshot, {
      timeoutMs: 1_000, now: () => now, wait: async (ms) => { now += ms; },
    });
    expect(result).toMatchObject({ ready: false, failureStage });
  });

  it('指数退避有上限且总等待受 timeout 约束', async () => {
    let now = 0;
    const delays: number[] = [];
    const result = await waitForVideoControlReadiness(
      () => ({ modelReady: false, compositeReady: false }),
      { timeoutMs: 5_000, now: () => now, wait: async (ms) => { delays.push(ms); now += ms; } },
    );
    expect(result.ready).toBe(false);
    expect(Math.max(...delays)).toBeLessThanOrEqual(2_000);
    expect(delays.reduce((sum, value) => sum + value, 0)).toBe(5_000);
  });

  it.each(['mode_entry', 'model_control', 'composite_control', 'stable_readback', 'final_readback'] as const)(
    '错误 %s 为机器可读阶段码且明确提交前停止', (stage) => {
      const error = new VideoControlReadinessError(stage, { ready: false, failureStage: stage, attempts: 3, elapsedMs: 1000 });
      expect(error.code).toBe(`video_${stage}_not_ready`);
      expect(error.message).toContain('已在提交前停止');
    },
  );
});

describe('源码安全边界', () => {
  const bridge = readFileSync(resolve(__dirname, '../../src/utils/doubaoBridge.ts'), 'utf8');
  const panel = readFileSync(resolve(__dirname, '../../src/components/BrowserPanel.tsx'), 'utf8');
  const taskConsole = readFileSync(resolve(__dirname, '../../src/components/TaskConsole.tsx'), 'utf8');
  const taskDetail = readFileSync(resolve(__dirname, '../../src/components/TaskDetailModal.tsx'), 'utf8');

  it('确认检测函数保持只读，自动确认由受控执行器逐轮处理', () => {
    const start = bridge.indexOf('export async function inspectGenerationConfirmation');
    const end = bridge.indexOf('export const VIDEO_MODEL_CONTROL_SELECTOR', start);
    expect(bridge.slice(start, end)).not.toMatch(/\.click\(|sendInputEvent|type_text|回复确认/);
    expect(panel).toContain("const DOUBAO_VIDEO_CONFIRM_TEXT = '确认生成视频'");
    expect(panel).toContain('waitForAssistantAfterMessageCount');
    expect(panel).toContain("automationPlatform === 'doubao'");
    expect(panel).toContain('submitGenerationConfirmationWithNativeClick(webview)');
    expect(panel).toContain('taskConversationUrl = submissionConversationUrl');
    expect(panel).toContain('persistedConversationUrl || taskConversationUrl');
  });

  it('豆包进入视频生成阶段后使用专用等待文案', () => {
    expect(panel).toContain('getDoubaoGenerationWaitMessage(doubaoWaitingStatePersisted, elapsedSec)');
  });

  it('豆包和 Dola 自动回收都强制使用扩展确认的无水印产物', () => {
    expect(panel).toContain("doubao_extension: '豆包扩展无水印资源'");
    expect(panel).toContain("dola_extension: 'Dola 扩展无水印资源'");
    expect(panel).toContain('requireWithoutWatermark: true');
    expect(panel).not.toContain("requireWithoutWatermark: platform === 'dola'");
    expect(panel).not.toContain("requireWithoutWatermark: task.targetPlatform === 'dola'");
    expect(panel).toContain('isExplicitlyWatermarkedVideoUrl(trimmed)');
    expect(panel).toContain('只检测到豆包带水印播放流');
  });

  it('豆包付费额度确认不会进入换号分支，并且只点击页面确认按钮', () => {
    const start = panel.indexOf('const hasNewAssistantReply');
    const end = panel.indexOf('imageUrls = await extractVideoOutputs', start);
    const body = panel.slice(start, end);
    expect(body).toContain('isPaidQuotaConfirmationMessage(latestAssistantReply)');
    expect(body).toContain('confirmDoubaoPaidQuotaUsage(webview)');
    expect(body).toContain('已确认使用付费额度，等待视频生成中');
    expect(body.indexOf('paidQuotaConfirmationRequested')).toBeLessThan(body.indexOf('isQuotaExhaustedMessage(latestAssistantReply)'));
  });

  it('等待确认任务即使已释放执行控制器也能直接持久化暂停', () => {
    const start = panel.indexOf('const handleCancelAutomation');
    const end = panel.indexOf("window.addEventListener('cancel-task-automation'", start);
    const body = panel.slice(start, end);
    expect(body).toContain("'waiting_generation_confirmation'");
    expect(body).toContain('useTaskStore.getState().pauseAutomation(');
    expect(body).toContain("message.success(requestedCancellationStatus === 'cancelled' ? '任务已取消' : '任务已暂停')");
  });

  it('只读恢复必须持有原会话 URL，且不得调用注入或提交函数', () => {
    const start = panel.indexOf('const handleSubmissionReconcile');
    const end = panel.indexOf("window.addEventListener('reconcile-task-submission'", start);
    const body = panel.slice(start, end);
    expect(body).toContain('storedConversationUrl');
    expect(body).toContain('const conversationUrl = storedConversationUrl');
    expect(body).not.toContain('currentIsConcreteChat');
    expect(body).not.toContain('injectPrompt(');
    expect(body).not.toContain('submitPromptWithNativeClick(');
    expect(body).not.toContain('startNewConversation(');
  });

  it('任务级视频回收先释放运行锁，再复用原会话只读完成与回传链路', () => {
    const start = panel.indexOf('const handleManualArtifactRecovery');
    const end = panel.indexOf("window.addEventListener('mark-manual-submission'", start);
    const body = panel.slice(start, end);
    expect(body).toContain('task.runtime?.submittedAt');
    expect(body).toContain('task.runtime?.conversationUrl');
    expect(body).toContain('automationEngine.abort(taskId, reason)');
    expect(body).toContain('!automationEngine.isReserved(taskId)');
    expect(body).toContain("new CustomEvent('reconcile-task-submission'");
    expect(body).not.toContain('injectPrompt(');
    expect(body).not.toContain('submitPromptWithNativeClick(');

    const reconcileStart = panel.indexOf('const handleSubmissionReconcile');
    const reconcileEnd = panel.indexOf('const handleManualArtifactRecovery', reconcileStart);
    expect(panel.slice(reconcileStart, reconcileEnd)).toContain('completeAutomation(taskId, accountId, outputs[0], outputs)');
    expect(taskConsole).toContain("new CustomEvent('recover-task-video-artifact'");
    expect(taskDetail).toContain("new CustomEvent('recover-task-video-artifact'");
  });
});
