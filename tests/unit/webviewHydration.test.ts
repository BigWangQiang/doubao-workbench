import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyWebviewActivationStyle,
  decideWebviewLoadRecovery,
  forceWebviewLayoutRepaint,
  getIdleWebviewEvictionIds,
  getPendingAvailabilityProbeAccountIds,
  getSupersededLoadingAccountIds,
  getTaskWebviewRetentionIds,
  getWebviewHydrationAccountIds,
  isWebviewDocumentReady,
  recoverModeEntry,
  shouldReleaseBackgroundWebview,
  shouldReloadAfterProxyUpdate,
  shouldScheduleAutomaticAvailabilityCheck,
  shouldWarmupAccount,
} from '../../src/utils/webviewHydration';

const accounts = [{ id: 'account-a' }, { id: 'account-b' }, { id: 'account-c' }];

describe('manual availability probe scheduling', () => {
  it('uses two slots and preserves later requests', () => {
    const requests = { a: 1, b: 3, c: 2, d: 1 };
    expect(getPendingAvailabilityProbeAccountIds(
      requests,
      { a: 1, b: 2 },
      new Set(['c']),
      2,
    )).toEqual(['b']);

    expect(getPendingAvailabilityProbeAccountIds(
      requests,
      { a: 1, b: 2 },
      new Set<string>(),
      2,
    )).toEqual(['b', 'c']);
  });
});

describe('webview 按需挂载策略', () => {
  it('启动后台预热只允许豆包，Dola 由按需挂载保持稳定 Session', () => {
    expect(shouldWarmupAccount({ platform: 'doubao' })).toBe(true);
    expect(shouldWarmupAccount({ platform: 'dola' })).toBe(false);
    expect(shouldWarmupAccount({})).toBe(true);
  });

  it('Dola 普通导航不触发自动可用性探测，但保留启动和门禁来源', () => {
    expect(shouldScheduleAutomaticAvailabilityCheck('dola', 'navigation')).toBe(false);
    expect(shouldScheduleAutomaticAvailabilityCheck('dola', 'startup')).toBe(true);
    expect(shouldScheduleAutomaticAvailabilityCheck('dola', 'pre_task')).toBe(true);
    expect(shouldScheduleAutomaticAvailabilityCheck('dola', 'pre_submit')).toBe(true);
    expect(shouldScheduleAutomaticAvailabilityCheck('dola', 'manual')).toBe(true);
    expect(shouldScheduleAutomaticAvailabilityCheck('doubao', 'navigation')).toBe(true);
    expect(shouldScheduleAutomaticAvailabilityCheck(undefined, 'navigation')).toBe(true);
  });

  it('主进程已刷新代理 Session 时不再触发渲染层重复 reload', () => {
    expect(shouldReloadAfterProxyUpdate({ reloadHandledByMain: true })).toBe(false);
    expect(shouldReloadAfterProxyUpdate({ reloadHandledByMain: false })).toBe(true);
    expect(shouldReloadAfterProxyUpdate(undefined)).toBe(true);
  });

  it('启动时只挂载当前账号，避免全部账号并发加载', () => {
    expect(getWebviewHydrationAccountIds(accounts, 'account-a', {})).toEqual(['account-a']);
  });

  it('等待验证或只读观察任务的账号仍会驻留页面', () => {
    const retained = getTaskWebviewRetentionIds([
      { assignedAccountId: 'account-b', status: 'waiting_verification' },
      { assignedAccountId: 'account-c', status: 'manual_submission_observing' },
      { assignedAccountId: 'account-a', status: 'paused' },
    ]);
    expect(getWebviewHydrationAccountIds(accounts, null, {}, retained)).toEqual([
      'account-b', 'account-c',
    ]);
  });

  it('切换账号时返回新的当前账号', () => {
    expect(getWebviewHydrationAccountIds(accounts, 'account-b', {})).toEqual(['account-b']);
  });

  it('并行任务账号即使在后台也会被挂载', () => {
    expect(getWebviewHydrationAccountIds(accounts, 'account-a', {
      'account-b': 'task-b',
      'account-c': 'task-c',
    })).toEqual(['account-a', 'account-b', 'account-c']);
  });

  it('忽略已删除账号与空执行记录', () => {
    expect(getWebviewHydrationAccountIds(accounts, null, {
      'account-a': '',
      missing: 'task-x',
    })).toEqual([]);
  });

  it('后台账号移出可视区，避免 Electron guest surface 串画面', () => {
    const style = { opacity: '', pointerEvents: '', transform: '', zIndex: '', visibility: '' };
    applyWebviewActivationStyle(style, false);
    expect(style).toEqual({
      opacity: '1', pointerEvents: 'none', transform: 'translate3d(0, 0, 0)',
      zIndex: '-1', visibility: 'visible',
    });

    applyWebviewActivationStyle(style, true);
    expect(style).toEqual({
      opacity: '1', pointerEvents: 'auto', transform: 'translate3d(0, 0, 0)',
      zIndex: '1', visibility: 'visible',
    });
  });

  it('当前账号创建时可立即进入可绘制状态', () => {
    const style = {
      opacity: '0', pointerEvents: 'none', transform: 'translate3d(-200vw, 0, 0)',
      zIndex: '0', visibility: 'visible',
    };
    applyWebviewActivationStyle(style, true);
    expect(style.opacity).toBe('1');
    expect(style.pointerEvents).toBe('auto');
    expect(style.zIndex).toBe('1');
    expect(style.transform).toBe('translate3d(0, 0, 0)');
  });

  it('快速切换只回收无执行任务的旧加载页', () => {
    expect(getSupersededLoadingAccountIds(
      ['account-a', 'account-b', 'account-c'],
      new Set(['account-a', 'account-b', 'account-c']),
      'account-c',
      { 'account-b': 'task-b' },
    )).toEqual(['account-a']);
  });

  it('快速切换不会回收等待人工处理的旧加载页', () => {
    expect(getSupersededLoadingAccountIds(
      ['account-a', 'account-b', 'account-c'],
      new Set(['account-a', 'account-b', 'account-c']),
      'account-c',
      {},
      new Set(['account-b']),
    )).toEqual(['account-a']);
  });

  it('后台预热完成后只释放非当前且无执行任务的页面', () => {
    expect(shouldReleaseBackgroundWebview('account-a', 'account-b', {}, true)).toBe(true);
    expect(shouldReleaseBackgroundWebview('account-a', 'account-a', {}, true)).toBe(false);
    expect(shouldReleaseBackgroundWebview('account-a', 'account-b', { 'account-a': 'task-a' }, true)).toBe(false);
    expect(shouldReleaseBackgroundWebview('account-a', 'account-b', {}, false)).toBe(false);
    expect(shouldReleaseBackgroundWebview('account-a', 'account-b', {}, true, new Set(['account-a']))).toBe(false);
  });

  it('连续加载失败在窗口内只允许一次自动恢复', () => {
    const first = decideWebviewLoadRecovery({ windowStartedAt: 0, attempts: 0 }, 1_000);
    expect(first.allowed).toBe(true);
    expect(first.nextState).toEqual({ windowStartedAt: 1_000, attempts: 1 });

    const second = decideWebviewLoadRecovery(first.nextState, 2_000);
    expect(second.allowed).toBe(false);
    expect(second.nextState).toEqual(first.nextState);

    const afterWindow = decideWebviewLoadRecovery(first.nextState, 31_001);
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.nextState).toEqual({ windowStartedAt: 31_001, attempts: 1 });
  });

  it('无限恢复窗口不会因等待时间变长而再次武装刷新', () => {
    const first = decideWebviewLoadRecovery(
      { windowStartedAt: 0, attempts: 0 },
      1_000,
      1,
      Number.POSITIVE_INFINITY,
    );
    const later = decideWebviewLoadRecovery(
      first.nextState,
      10 * 60 * 1000,
      1,
      Number.POSITIVE_INFINITY,
    );
    expect(first.allowed).toBe(true);
    expect(later.allowed).toBe(false);
    expect(later.nextState).toEqual(first.nextState);
  });

  it('Dola 页面失败时由 CK 重登流程恢复，不允许渲染层自动 reload', () => {
    const panelSource = readFileSync(resolve(__dirname, '../../src/components/BrowserPanel.tsx'), 'utf8');
    expect(panelSource).toContain("if (account.platform === 'dola')");
    expect(panelSource).toContain('已禁止自动重载');
    expect(panelSource).toContain('Dola 页面加载失败，请清除登录后重登 CK');
  });

  it('时钟回拨或非法参数不会放大重载次数', () => {
    const decision = decideWebviewLoadRecovery(
      { windowStartedAt: 10_000, attempts: 99 },
      9_000,
      1,
      30_000,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.nextState).toEqual({ windowStartedAt: 10_000, attempts: 99 });
  });

  it('驻留页面超限时只回收最久未使用的闲置账号', () => {
    expect(getIdleWebviewEvictionIds(
      ['a', 'b', 'c', 'd', 'e'],
      'e',
      { c: 'task-c' },
      { a: 1, b: 2, c: 3, d: 4, e: 5 },
      3,
    )).toEqual(['a', 'b']);
  });

  it('当前账号、执行中账号和后台探测账号不会被回收', () => {
    expect(getIdleWebviewEvictionIds(
      ['a', 'b', 'c', 'd'],
      'a',
      { b: 'task-b' },
      { a: 1, b: 2, c: 3, d: 4 },
      1,
      new Set(['c']),
    )).toEqual(['d']);
  });

  it('等待验证账号不会被闲置回收', () => {
    expect(getIdleWebviewEvictionIds(
      ['a', 'b', 'c', 'd'],
      'a',
      {},
      { a: 1, b: 2, c: 3, d: 4 },
      1,
      new Set(['b']),
    )).toEqual(['c', 'd']);
  });

  it('真实平台标题与 URL 可作为不读取账号数据的就绪证据', () => {
    expect(isWebviewDocumentReady(
      'https://www.doubao.com/chat/',
      '豆包 - 字节跳动旗下 AI 智能助手',
      'doubao.com',
    )).toBe(true);
    expect(isWebviewDocumentReady('https://www.doubao.com/chat/', '', 'doubao.com')).toBe(false);
    expect(isWebviewDocumentReady('https://example.com/', '豆包', 'doubao.com')).toBe(false);
  });

  it('已加载 guest 可通过一次 1px 布局变化触发首帧重绘并恢复宽度', async () => {
    const target = { style: { width: '100%' }, offsetWidth: 800 };
    const frames: Array<() => void> = [];
    const repaint = forceWebviewLayoutRepaint(target, (callback) => frames.push(callback));
    expect(target.style.width).toBe('calc(100% - 1px)');
    expect(frames).toHaveLength(1);
    frames[0]();
    await repaint;
    expect(target.style.width).toBe('100%');
  });

  it('recovers mode entry through warmup, repaint, then one safe reload', async () => {
    const calls: string[] = [];
    let now = 100;
    const result = await recoverModeEntry({
      warmup: async () => { calls.push('warmup'); now += 5; },
      attempt: async (attempt) => {
        calls.push(`attempt-${attempt}`);
        now += 5;
        return attempt === 3;
      },
      forceLayout: async () => { calls.push('repaint'); now += 5; },
      safeReload: async () => { calls.push('reload'); now += 5; return true; },
      now: () => now,
    });

    expect(calls).toEqual(['warmup', 'attempt-1', 'repaint', 'attempt-2', 'reload', 'attempt-3']);
    expect(result).toEqual({ switched: true, attempts: 3, elapsedMs: 30, reloadAttempted: true });
  });

  it('does not run the third attempt when a post-submit reload is rejected', async () => {
    const attempts: number[] = [];
    const result = await recoverModeEntry({
      warmup: async () => undefined,
      attempt: async (attempt) => { attempts.push(attempt); return false; },
      forceLayout: async () => undefined,
      safeReload: async () => false,
    });

    expect(attempts).toEqual([1, 2]);
    expect(result.reloadAttempted).toBe(false);
    expect(result.switched).toBe(false);
  });
});
