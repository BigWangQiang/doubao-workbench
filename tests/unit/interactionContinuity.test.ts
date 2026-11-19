import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canSelectAccount, findInteractiveAccountId } from '../../src/utils/interactiveAccount';
import {
  classifyMaterialAuthorizationSnapshot,
  decideMaterialAuthorizationProgress,
} from '../../src/utils/materialAuthorization';
import {
  calculateSidebarMaxWidth,
  calculateSidebarSplitRatio,
  clampSidebarWidth,
  MIN_BROWSER_PANE_WIDTH,
  FIXED_WORKSPACE_SHELL_WIDTH,
  shouldOverlaySidebar,
} from '../../src/utils/resizeMath';

describe('视频任务执行连续性', () => {
  it('legacy interaction helper remains deterministic even though scheduling no longer uses a global lease', () => {
    expect(findInteractiveAccountId({ a: 'generating', b: 'injecting' })).toBe('b');
    expect(findInteractiveAccountId({ a: 'generating', b: 'completed' })).toBeNull();
    expect(canSelectAccount('b', 'b')).toBe(true);
    expect(canSelectAccount('a', 'b')).toBe(false);
  });

  it.each([
    [{ title: '', body: '', actions: [] }, 'absent'],
    [{ title: '', body: '普通业务确认', actions: ['拒绝', '确认'] }, 'absent'],
    [{ title: '安全确认', body: '上传、使用的素材均已充分授权', actions: ['拒绝', '确认'] }, 'present'],
    [{ title: '安全确认', body: '上传、使用的素材', actions: ['确认'] }, 'blocked'],
  ] as const)('素材授权弹窗严格分类 %#', (snapshot, expected) => {
    expect(classifyMaterialAuthorizationSnapshot(snapshot)).toBe(expected);
  });

  it('人工确认后只回读同一次提交；弹窗消失但无提交证据时保持不确定', () => {
    expect(decideMaterialAuthorizationProgress({
      dialogState: 'present', submissionConfirmed: false, elapsedMs: 1000, timeoutMs: 60_000,
    })).toBe('waiting');
    expect(decideMaterialAuthorizationProgress({
      dialogState: 'absent', submissionConfirmed: true, elapsedMs: 2000, timeoutMs: 60_000,
    })).toBe('confirmed');
    expect(decideMaterialAuthorizationProgress({
      dialogState: 'absent', submissionConfirmed: false, elapsedMs: 2000, timeoutMs: 60_000,
    })).toBe('uncertain');
  });

  it('分隔条计算有界，拖动期间只移动预览线且不重排真实面板', () => {
    expect(clampSidebarWidth(100)).toBe(220);
    expect(clampSidebarWidth(900)).toBe(500);
    expect(calculateSidebarSplitRatio(50, 0, 1000)).toBe(0.2);
    expect(calculateSidebarSplitRatio(900, 0, 1000)).toBe(0.7);
    expect(calculateSidebarMaxWidth(1200)).toBe(220);
    expect(calculateSidebarMaxWidth(1260)).toBe(220);
    expect(calculateSidebarMaxWidth(1600)).toBe(362);
    expect(calculateSidebarMaxWidth(2000)).toBe(500);
    expect(calculateSidebarMaxWidth(1000)).toBe(220);

    const appSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'App.tsx'), 'utf8');
    const mainSource = readFileSync(resolve(__dirname, '..', '..', 'main', 'main.ts'), 'utf8');
    const globalStyles = readFileSync(resolve(__dirname, '..', '..', 'src', 'styles', 'global.css'), 'utf8');
    const sidebarSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'components', 'Sidebar.tsx'), 'utf8');
    expect(appSource).toContain('requestAnimationFrame');
    expect(sidebarSource).toContain('requestAnimationFrame');
    expect(appSource).toContain('resizerRef.current.style.transform');
    expect(sidebarSource).toContain('splitResizerRef.current.style.transform');
    expect(appSource).toContain('resize-capture-overlay-col');
    expect(appSource).toContain('getCurrentSidebarMaxWidth()');
    expect(appSource).toContain("window.addEventListener('resize', handleWindowResize)");
    expect(mainSource).toContain('resizable: false');
    expect(mainSource).toContain('minimizable: true');
    expect(mainSource).toContain('maximizable: true');
    expect(globalStyles).toContain('var(--browser-pane-min-width, 1120px)');
    expect(sidebarSource).toContain('resize-capture-overlay-row');
    expect(appSource).not.toContain('sidebarRef.current.style.width = `${current.pendingWidth}px`');
    expect(sidebarSource).not.toContain('accountPaneRef.current.style.height = `${current.pendingRatio * 100}%`');
  });

  it.each([1260, 1280, 1366, 1440, 1457, 1458, 1600, 1707, 1920])(
    '视口 %ipx：拖动到最大列表宽度后，浏览器仍保留完整控件空间',
    (viewportWidth) => {
      const overlay = shouldOverlaySidebar(viewportWidth);
      const sidebarWidth = overlay ? 0 : calculateSidebarMaxWidth(viewportWidth);
      const browserWidth = viewportWidth - FIXED_WORKSPACE_SHELL_WIDTH - sidebarWidth;
      expect(browserWidth).toBeGreaterThanOrEqual(MIN_BROWSER_PANE_WIDTH);
      expect(overlay).toBe(viewportWidth < 1458);
    },
  );

  it('account navigation and scheduling do not share a global foreground lease', () => {
    const accountListSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'components', 'AccountList.tsx'), 'utf8');
    const taskConsoleSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'components', 'TaskConsole.tsx'), 'utf8');
    const taskStoreSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'store', 'useTaskStore.ts'), 'utf8');
    const browserPanelSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'components', 'BrowserPanel.tsx'), 'utf8');
    const routeStart = browserPanelSource.indexOf('console.log(`[BrowserPanel] 路由任务');
    const routeEnd = browserPanelSource.indexOf('executeAutomation(', routeStart);
    expect(accountListSource).not.toContain('canSelectAccount(accountId, interactiveAccountId)');
    expect(taskConsoleSource).not.toContain('canSelectAccount(task.assignedAccountId, interactiveAccountId)');
    expect(taskStoreSource).not.toContain('findInteractiveAccountId(');
    expect(browserPanelSource.slice(routeStart, routeEnd)).not.toContain('selectAccount(accountId)');
  });
});
