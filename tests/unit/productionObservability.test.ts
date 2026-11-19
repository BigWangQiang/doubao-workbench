import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyMaterialAuthorizationSnapshot,
  decideMaterialAuthorizationAutoConfirm,
} from '../../src/utils/materialAuthorization';
import { InitializationGate } from '../../src/utils/initializationGate';
import {
  MAX_REFERENCE_IMAGE_COUNT,
  buildUploadPendingProbe,
  classifyUploadReadinessFailure,
  isUploadSnapshotReady,
} from '../../src/utils/uploadReadiness';
import { REFERENCE_AUDIO_LIMIT, REFERENCE_VIDEO_LIMIT } from '../../src/utils/referenceMaterialLimits';
import {
  confirmDoubaoPaidQuotaUsage,
  confirmMaterialAuthorizationIfAllowed,
} from '../../src/utils/doubaoBridge';

describe('P0-1 素材授权精确白名单', () => {
  it.each([
    ['精确素材授权', { title: '安全确认', body: '上传、使用的素材均已充分授权', actions: ['拒绝', '确认'] }, 'present'],
    ['视频生成确认', { title: '安全确认', body: '视频生成参数确认，确认后开始生成视频', actions: ['拒绝', '确认'] }, 'blocked'],
    ['登录确认', { title: '安全确认', body: '请登录并确认上传、使用的素材均已充分授权', actions: ['拒绝', '确认'] }, 'blocked'],
    ['支付确认', { title: '安全确认', body: '确认支付额度，上传、使用的素材均已充分授权', actions: ['拒绝', '确认'] }, 'blocked'],
    ['按钮不全', { title: '安全确认', body: '上传、使用的素材均已充分授权', actions: ['确认'] }, 'blocked'],
  ] as const)('$0 → $2', (_name, snapshot, expected) => {
    expect(classifyMaterialAuthorizationSnapshot(snapshot)).toBe(expected);
  });

  it.each([
    [{ enabled: false }, 'disabled'],
    [{ state: 'blocked' as const }, 'not_whitelisted'],
    [{ currentUrl: 'https://www.doubao.com/chat/other' }, 'conversation_mismatch'],
    [{ assetsValidated: false }, 'assets_unverified'],
    [{ confirmPosition: undefined }, 'target_missing'],
  ])('任一门禁缺失均拒绝自动确认 %#', (override, reason) => {
    expect(decideMaterialAuthorizationAutoConfirm({
      enabled: true,
      state: 'present',
      currentUrl: 'https://www.doubao.com/chat/a',
      expectedConversationUrl: 'https://www.doubao.com/chat/a',
      assetsValidated: true,
      confirmPosition: '100,200',
      ...override,
    })).toEqual({ allowed: false, reason });
  });

  it('精确匹配时只执行一次原生点击并回读弹窗消失', async () => {
    const sendInputEvent = vi.fn();
    const snapshots = [
      { title: '安全确认', body: '上传、使用的素材均已充分授权', actions: ['拒绝', '确认'], confirmPosition: '100,200', visibleAttachmentCount: 1, pending: false },
      { title: '', body: '', actions: [], visibleAttachmentCount: 1, pending: false },
    ];
    const webview = {
      executeJavaScript: vi.fn(async () => snapshots.shift() || snapshots[1]),
      loadURL: vi.fn(),
      getURL: () => 'https://www.doubao.com/chat/a',
      sendInputEvent,
    };
    const result = await confirmMaterialAuthorizationIfAllowed(webview, {
      enabled: true, expectedConversationUrl: 'https://www.doubao.com/chat/a', assetsValidated: true,
    });
    expect(result.status).toBe('confirmed');
    expect(sendInputEvent).toHaveBeenCalledTimes(3);
  });
});

describe('P0-2 初始化闸门与慢上传', () => {
  it('初始化并发 1 时第二任务等待，首任务释放后获得租约', async () => {
    const gate = new InitializationGate();
    const first = await gate.acquire('a', { limit: 1 });
    let secondAcquired = false;
    const secondPromise = gate.acquire('b', { limit: 1 }).then((lease) => { secondAcquired = true; return lease; });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    second.release();
  });

  it('上传中、数量不足和额外素材分别给出机器码，只有精确数量放行', () => {
    expect(classifyUploadReadinessFailure({ inputFileCount: 1, visibleAttachmentCount: 1, matchingFileNameCount: 1, pending: true }, 1, 0)).toBe('pending');
    expect(classifyUploadReadinessFailure({ inputFileCount: 0, visibleAttachmentCount: 1, matchingFileNameCount: 0, pending: false }, 2, 0)).toBe('count_incomplete');
    expect(classifyUploadReadinessFailure({ inputFileCount: 3, visibleAttachmentCount: 3, matchingFileNameCount: 3, pending: false }, 2, 0)).toBe('count_mismatch');
    expect(isUploadSnapshotReady({ inputFileCount: 2, visibleAttachmentCount: 2, matchingFileNameCount: 2, pending: false }, 2, 0)).toBe(true);
  });

  it('参考素材上限固定为 30/10/10，上传探针不再匹配任意 progress/loading 类名', () => {
    const probe = buildUploadPendingProbe('document');
    expect(MAX_REFERENCE_IMAGE_COUNT).toBe(30);
    expect(REFERENCE_VIDEO_LIMIT).toBe(10);
    expect(REFERENCE_AUDIO_LIMIT).toBe(10);
    expect(probe).toContain('[role="progressbar"]');
    expect(probe).toContain("rawNow === null || rawNow === ''");
    expect(probe).not.toContain('[class*="progress"]');
    expect(probe).not.toContain('[class*="loading"]');
  });
});

describe('豆包付费额度确认按钮', () => {
  it('精确定位“确认生成”按钮后只发送一次原生点击序列', async () => {
    const sendInputEvent = vi.fn();
    const executeJavaScript = vi.fn(async (code: string) => ({
      ok: code.includes('确认生成') && code.includes('付费额度'),
      position: '320,240',
    }));
    const webview = {
      executeJavaScript,
      loadURL: vi.fn(),
      getURL: () => 'https://www.doubao.com/chat/paid-quota',
      sendInputEvent,
    };

    await expect(confirmDoubaoPaidQuotaUsage(webview)).resolves.toBe(true);
    expect(sendInputEvent).toHaveBeenCalledTimes(3);
    expect(sendInputEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'mouseDown', x: 320, y: 240,
    }));
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain('确认生成');
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain('付费额度');
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain("root.querySelectorAll('*')");
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain('shadowRoot');
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain('elementFromPoint');
  });

  it('没有精确按钮时不点击任何控件', async () => {
    const sendInputEvent = vi.fn();
    const webview = {
      executeJavaScript: vi.fn(async () => ({ ok: false })),
      loadURL: vi.fn(),
      getURL: () => 'https://www.doubao.com/chat/paid-quota',
      sendInputEvent,
    };

    await expect(confirmDoubaoPaidQuotaUsage(webview)).resolves.toBe(false);
    expect(sendInputEvent).not.toHaveBeenCalled();
  });
});

describe('P0-3 人工提交只读观察边界', () => {
  const panel = readFileSync(resolve(__dirname, '../../src/components/BrowserPanel.tsx'), 'utf8');

  it('人工声明入口只接受具体豆包会话并进入独立状态', () => {
    expect(panel).toContain("status: 'manual_submission_observing'");
    expect(panel).toContain("stage: 'manual_submission_observing'");
    expect(panel).toContain('userConfirmedCurrentUrl');
    expect(panel).toContain('www\\.doubao\\.com\\/chat\\/');
  });

  it('只读核对函数不包含注入、发送或新建对话调用', () => {
    const start = panel.indexOf('const handleSubmissionReconcile');
    const end = panel.indexOf("window.addEventListener('mark-manual-submission'", start);
    const body = panel.slice(start, end);
    expect(body).not.toContain('injectPrompt(');
    expect(body).not.toContain('submitPromptWithNativeClick(');
    expect(body).not.toContain('startNewConversation(');
    expect(body).toContain('matchesSubmissionConversation');
    expect(body).toContain('resolveVideoArtifact');
  });

  it('已出现视频时优先解析产物，不被历史确认消息阻断', () => {
    const start = panel.indexOf('const handleSubmissionReconcile');
    const end = panel.indexOf("window.addEventListener('mark-manual-submission'", start);
    const body = panel.slice(start, end);
    const preResolution = body.indexOf('const preResolvedArtifact');
    const generationInspection = body.indexOf('inspectPostSubmitGenerationState(webview)');
    const confirmationInspection = body.indexOf('inspectGenerationConfirmation(webview)');
    const fallbackResolution = body.indexOf('resolveVideoArtifact(webview', confirmationInspection);

    expect(preResolution).toBeGreaterThanOrEqual(0);
    expect(generationInspection).toBeGreaterThanOrEqual(0);
    expect(preResolution).toBeLessThan(generationInspection);
    expect(confirmationInspection).toBeGreaterThan(generationInspection);
    expect(fallbackResolution).toBeGreaterThan(confirmationInspection);
    expect(body).toContain("(reconciliationPlatform || 'doubao') === 'doubao'");
    expect(body).toContain('preResolvedOutputs.length > 0');
    expect(body).toContain('hasPostSubmitGenerationEvidence(generationState)');
    expect(body).toContain('isDoubaoVideoCompletedReply(latestAssistantReply)');
    expect(body).toContain('const outputs = preResolvedOutputs.length > 0');
    expect(body).toContain("confirmation?.state === 'present'");
  });

  it('观察超时进入 manual_review，不计入账号失败或自动冷却', () => {
    expect(panel).toContain("code: isManualObservation ? 'manual_review_required' : 'submission_uncertain'");
    const reconcileStart = panel.indexOf('const handleSubmissionReconcile');
    const reconcileEnd = panel.indexOf("window.addEventListener('mark-manual-submission'", reconcileStart);
    const reconcileBody = panel.slice(reconcileStart, reconcileEnd);
    expect(reconcileBody).not.toContain('recordAccountOutcome(accountId, \'failure\'');
    expect(reconcileBody).not.toContain('cooldownUntil');
  });

  it('豆包和 Dola 的最终视频地址统一拒绝明确水印标记', () => {
    const helperStart = panel.indexOf('const normalizeResolvedVideoOutput');
    const helperEnd = panel.indexOf('const extractVideoOutputs', helperStart);
    const helperBody = panel.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperBody).toContain('return normalizeVideoUrls([result.url.trim()]);');
    expect(helperBody).not.toContain("result.source === 'platform_download_info'");
    expect(helperBody).not.toContain("platform === 'dola'");
    expect(helperBody).not.toContain('injectPrompt(');
    expect(helperBody).not.toContain('submitPromptWithNativeClick(');
    expect(panel.match(/extractVideoOutputs\(webview, taskConversationUrl, controller\.signal, videoCaptureToken, automationPlatform\)/g)).toHaveLength(2);
    expect(panel).toContain('normalizeResolvedVideoOutput(result, activeAccount.platform)');
    expect(panel).toContain('normalizeResolvedVideoOutput(resolution, reconciliationPlatform)');
  });
});
