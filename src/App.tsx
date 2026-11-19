/**
 * src/App.tsx
 * 主布局组件 — 三栏式 + V2 自动化任务流
 *
 * 左侧：Sidebar（账号列表 + 任务控制台）
 * 右侧：BrowserPanel（内嵌 webview + 自动化执行）
 * 拖拽分隔线可调整左右宽度
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Alert, Button } from 'antd';
import { PairingGatePage } from './components/PairingGatePage';
import { Sidebar } from './components/Sidebar';
import BrowserPanel from './components/BrowserPanel';
import { Toolbar } from './components/Toolbar';
import { WorkspaceRail } from './components/WorkspaceRail';
import type { WorkspacePane } from './components/WorkspaceRail';
import { WorkspaceDashboard } from './components/WorkspaceDashboard';
import { StoryboardBatchPage } from './components/StoryboardBatchPage';
import { StartupSplash } from './components/StartupSplash';
import { ArtifactCenterModal } from './components/ArtifactCenterModal';
import { LocalManagerModal } from './components/LocalManagerModal';
import { LogCenterModal } from './components/LogCenterModal';
import { SettingsModal } from './components/SettingsModal';
import { EmbeddedResourcePage } from './components/TutorialPage';
import { YuyanAccountPage } from './components/YuyanAccountPage';
import { ZiziPluginPage } from './components/ZiziPluginPage';
import { WorkbenchCanvas } from './components/NativeWorkbenchCanvas';
import { useAccountStore } from './store/useAccountStore';
import { useTaskStore } from './store/useTaskStore';
import { useProjectStore } from './store/useProjectStore';
import { useLalorAuthStore } from './store/useLalorAuthStore';
import {
  calculateSidebarMaxWidth,
  clampSidebarWidth,
  FIXED_WORKSPACE_SHELL_WIDTH,
  MIN_BROWSER_PANE_WIDTH,
  shouldOverlaySidebar,
} from './utils/resizeMath';
import { hasLocalDateChanged, localDateKey, millisecondsUntilNextLocalMidnight } from './utils/dailyReset';
import { handleControlCommand } from './control/handleControlCommand';
import './styles/global.css';

// ==================== 常量 ====================

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_SIDEBAR_WIDTH = 340;
const MIN_STARTUP_SPLASH_MS = 3800;
const STARTUP_SPLASH_FADE_MS = 220;
const MAX_STARTUP_SPLASH_MS = 5000 - STARTUP_SPLASH_FADE_MS;
const LALOR_MEMBERSHIP_STATUS_POLL_MS = 30_000;
const MAX_BROWSER_TIMER_MS = 24 * 60 * 60 * 1000;

function getCurrentSidebarMaxWidth(): number {
  const viewportWidth = typeof window === 'undefined' ? 1600 : window.innerWidth;
  if (shouldOverlaySidebar(viewportWidth)) return DEFAULT_SIDEBAR_WIDTH;
  return calculateSidebarMaxWidth(
    viewportWidth,
    MIN_BROWSER_PANE_WIDTH,
    FIXED_WORKSPACE_SHELL_WIDTH,
    MIN_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
  );
}

// ==================== 组件 ====================

const App: React.FC = () => {
  const [localViewAllowed, setLocalViewAllowed] = useState(false);
  /** 左侧面板宽度 */
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebarWidth(
    DEFAULT_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    getCurrentSidebarMaxWidth(),
  ));
  /** 是否折叠左侧面板 */
  const [collapsed, setCollapsed] = useState(false);
  const [overlaySidebar, setOverlaySidebar] = useState(() => shouldOverlaySidebar(window.innerWidth));
  const localBootstrapStartedRef = useRef(false);
  /** 拖动期间覆盖 webview，防止其吞掉 mouseup。 */
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  /** 导航轨当前聚焦的工作区。 */
  const [activeWorkspacePane, setActiveWorkspacePane] = useState<WorkspacePane>('workspace');
  /** 首次进入后保留 iframe，切换工作区不丢失项目、编辑草稿和运行中的任务。 */
  const [canvasOpened, setCanvasOpened] = useState(false);
  const [storyboardOpened, setStoryboardOpened] = useState(false);
  /** 启动过渡页状态；只覆盖渲染层，不阻塞业务初始化。 */
  const [startupVisible, setStartupVisible] = useState(true);
  const [startupPhase, setStartupPhase] = useState('正在准备本地工作区');
  /** 远程任务必须等本地恢复完成后才能唤醒，避免新任务被启动恢复逻辑误暂停。 */
  const [workspaceReady, setWorkspaceReady] = useState(false);

  /** 分隔线拖拽状态 */
  const sidebarRef = useRef<HTMLDivElement>(null);
  const resizerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    pendingWidth: number;
    frameId: number | null;
  } | null>(null);

  // Store
  const activeAccountId = useAccountStore((s) => s.selectedAccountId);
  const previousAccountIdRef = useRef(activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const refreshDailyQuota = useAccountStore((s) => s.refreshDailyQuota);
  const loadTasks = useTaskStore((s) => s.loadTasks);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const authReady = useLalorAuthStore((s) => s.ready);
  const authSnapshot = useLalorAuthStore((s) => s.snapshot);
  const loadLalorStatus = useLalorAuthStore((s) => s.loadStatus);

  useEffect((): void => {
    if (authSnapshot.authenticated) {
      // 到期仅停止新生成，不卸载当前画布和正在回收产物的浏览器。
      setLocalViewAllowed(true);
      useTaskStore.getState().processQueue();
    }
  }, [authSnapshot.authenticated]);

  /** 当前活跃账号对象 */
  const activeAccount = accounts.find((a) => a.id === activeAccountId) || null;
  // ---- 初始化加载 ----

  useEffect(() => {
    setStartupPhase('正在准备本地工作台');
    void loadLalorStatus();
  }, [loadLalorStatus]);

  useEffect(() => {
    if (!authReady || !authSnapshot.authenticated) return undefined;
    let disposed = false;
    let statusCheckInFlight = false;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;

    const checkMembership = async (): Promise<void> => {
      if (disposed || statusCheckInFlight) return;
      statusCheckInFlight = true;
      try {
        await loadLalorStatus();
      } finally {
        statusCheckInFlight = false;
      }
    };

    const scheduleExpiryCheck = (): void => {
      if (disposed) return;
      const expiresAtMs = Date.parse(authSnapshot.profile?.membership?.expiresAt || '');
      if (!Number.isFinite(expiresAtMs)) {
        void checkMembership();
        return;
      }
      const remainingMs = expiresAtMs - Date.now();
      const delayMs = remainingMs <= 0
        ? 0
        : Math.min(remainingMs + 25, MAX_BROWSER_TIMER_MS);
      expiryTimer = setTimeout(() => {
        if (remainingMs > MAX_BROWSER_TIMER_MS) scheduleExpiryCheck();
        else void checkMembership();
      }, delayMs);
    };

    const pollTimer = setInterval(() => void checkMembership(), LALOR_MEMBERSHIP_STATUS_POLL_MS);
    const handleResume = (): void => {
      if (document.visibilityState === 'hidden') return;
      void checkMembership();
    };
    scheduleExpiryCheck();
    document.addEventListener('visibilitychange', handleResume);
    window.addEventListener('focus', handleResume);

    return () => {
      disposed = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', handleResume);
      window.removeEventListener('focus', handleResume);
    };
  }, [authReady, authSnapshot.authenticated, authSnapshot.profile?.membership?.expiresAt, loadLalorStatus]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let splashTimer: ReturnType<typeof setTimeout> | undefined;
    let mounted = true;
    let midnightRefreshInFlight = false;
    let observedQuotaDateKey = localDateKey();
    const bootstrapStartedAt = performance.now();
    splashTimer = setTimeout(() => {
      if (mounted) setStartupVisible(false);
    }, MAX_STARTUP_SPLASH_MS);
    const refreshForCurrentDay = async (force: boolean): Promise<boolean> => {
      if (!mounted || midnightRefreshInFlight) return false;
      if (!force && !hasLocalDateChanged(observedQuotaDateKey)) return true;
      midnightRefreshInFlight = true;
      const currentDateKey = localDateKey();
      try {
        // 主进程只归一化额度并写盘；不会因为跨日刷新重建代理、扩展或 WebView。
        const refreshed = await refreshDailyQuota();
        if (refreshed) {
          observedQuotaDateKey = currentDateKey;
          if (mounted) useTaskStore.getState().processQueue();
        }
        return refreshed;
      } finally {
        midnightRefreshInFlight = false;
      }
    };
    const scheduleMidnightRefresh = () => {
      if (!mounted) return;
      timer = setTimeout(() => {
        void refreshForCurrentDay(true).finally(() => {
          if (mounted) scheduleMidnightRefresh();
        });
      }, millisecondsUntilNextLocalMidnight() + 250);
    };
    const handleResume = () => {
      if (!mounted || !hasLocalDateChanged(observedQuotaDateKey)) return;
      void refreshForCurrentDay(false);
    };

    const bootstrap = async () => {
      if (localBootstrapStartedRef.current) return;
      localBootstrapStartedRef.current = true;
      setWorkspaceReady(false);
      setStartupPhase('正在载入账号与项目');
      const results = await Promise.allSettled([
        loadAccounts({ recheckAvailability: true }),
        loadProjects(),
        loadTasks(true),
      ]);
      if (!mounted) return;
      // 启动加载可能跨过本机 00:00；用旧日期标记做一次补偿检查，避免额度要等到下一次午夜才刷新。
      const refreshedDuringBootstrap = await refreshForCurrentDay(false);
      if (refreshedDuringBootstrap || !hasLocalDateChanged(observedQuotaDateKey)) {
        observedQuotaDateKey = localDateKey();
      }
      setWorkspaceReady(true);
      setStartupPhase(results.some((result) => result.status === 'rejected') ? '工作区已打开，部分数据待重试' : '正在连接本地会话');
      scheduleMidnightRefresh();
      const elapsed = performance.now() - bootstrapStartedAt;
      const remaining = Math.max(0, MIN_STARTUP_SPLASH_MS - elapsed);
      if (splashTimer) clearTimeout(splashTimer);
      splashTimer = setTimeout(() => {
        if (mounted) setStartupVisible(false);
      }, remaining);
    };
    document.addEventListener('visibilitychange', handleResume);
    window.addEventListener('focus', handleResume);
    void bootstrap();

    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
      if (splashTimer) clearTimeout(splashTimer);
      document.removeEventListener('visibilitychange', handleResume);
      window.removeEventListener('focus', handleResume);
    };
  }, [loadAccounts, loadProjects, loadTasks, refreshDailyQuota]);

  // 本机控制面只通过稳定 ID 调用现有调度边界；不暴露 DOM/webview/页面会话。
  useEffect(() => {
    const unsubscribe = window.electronAPI.control.onCommand(async (command) => {
      const response = await handleControlCommand(command, {
        readTasks: () => window.electronAPI.tasks.list(),
        start: (taskId) => useTaskStore.getState().startAutomation(taskId),
        retry: (taskId) => useTaskStore.getState().retryTask(taskId),
        getLastError: () => useTaskStore.getState().error,
        updateStatus: (taskId, status, result) => useTaskStore.getState().updateTaskStatus(taskId, status, result),
        abortActive: (taskId, targetStatus) => window.dispatchEvent(new CustomEvent('cancel-task-automation', {
          detail: { taskId, targetStatus },
        })),
      });
      try {
        await window.electronAPI.logs.append({
          level: response.ok ? 'info' : 'warn',
          scope: 'local_control',
          message: `${command.action}:${response.code}:project=${command.projectId}:batch=${command.batchId}:request=${command.requestId}`,
          taskId: command.taskId,
        });
      } catch {
        // 审计不可用不得吞掉已执行命令的确定结果；调用方仍可按 taskId 回读。
      }
      window.electronAPI.control.complete(response);
    });
    window.electronAPI.control.ready();
    return unsubscribe;
  }, []);

  // Lalor 只通知稳定的本地任务 ID；任务与账号详情仍从既有 IPC 读取。
  useEffect(() => {
    // preload 会在订阅前缓存事件；等待启动恢复完成后再订阅，防止 queued
    // 任务先进入 executing、随后又被 loadTasks(true) 当成中断任务暂停。
    if (!workspaceReady) return undefined;
    const refreshTaskSnapshot = async (): Promise<void> => {
      const latest = await window.electronAPI.tasks.list();
      useTaskStore.setState({ tasks: latest });
    };
    const unsubscribeAvailable = window.electronAPI.lalorTasks.onTaskAvailable((taskId) => {
      void refreshTaskSnapshot().then(async () => {
        let task = useTaskStore.getState().tasks.find((item) => item.id === taskId);
        const safelyPausedByReload = task?.status === 'paused'
          && !task.runtime?.submittedAt
          && task.result === '应用界面重新载入，任务已安全暂停';
        if (safelyPausedByReload) {
          const resumed = await window.electronAPI.tasks.retry(taskId);
          if (!resumed.success || !resumed.task) {
            throw new Error(resumed.error || 'Lalor 本地任务恢复失败');
          }
          useTaskStore.setState((state) => ({
            tasks: state.tasks.map((item) => item.id === taskId ? resumed.task! : item),
          }));
          task = resumed.task;
        }
        if (task?.status === 'queued' && task.assignedAccountId) {
          const accountState = useAccountStore.getState();
          const assignedAccount = accountState.accounts.find((item) => item.id === task!.assignedAccountId);
          // 先尝试调度；只要指派账号尚未 ready，就主动挂载对应 WebView 并
          // 请求一次有界检测，防止旧的非就绪结论让远程任务只能靠手动刷新唤醒。
          useTaskStore.getState().processQueue();
          if (!assignedAccount || !assignedAccount.health?.availability
            || assignedAccount.health.availability.state !== 'ready') {
            accountState.selectAccount(task.assignedAccountId);
            if (!accountState.availabilityChecking[task.assignedAccountId]) {
              accountState.requestAvailabilityCheck(task.assignedAccountId);
            }
            void loadAccounts({ recheckAvailability: false }).then(() => {
              useTaskStore.getState().processQueue();
            }).catch((error: unknown) => {
              console.error('[LalorTasks] 刷新远程任务账号失败:', error);
            });
          }
        }
      }).catch((error: unknown) => {
        console.error('[LalorTasks] 载入远程任务失败:', error);
      });
    });
    const unsubscribeCancelled = window.electronAPI.lalorTasks.onTaskCancelled((taskId) => {
      window.dispatchEvent(new CustomEvent('cancel-task-automation', {
        detail: { taskId, targetStatus: 'cancelled' },
      }));
      void refreshTaskSnapshot().catch((error: unknown) => {
        console.error('[LalorTasks] 同步远程取消状态失败:', error);
      });
    });
    return () => {
      unsubscribeAvailable();
      unsubscribeCancelled();
    };
  }, [loadAccounts, workspaceReady]);


  // ---- 面板折叠 ----

  const handleToggleCollapse = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  const handleSelectWorkspacePane = useCallback((pane: WorkspacePane) => {
    if (pane === 'canvas') setCanvasOpened(true);
    if (pane === 'storyboard-batch') setStoryboardOpened(true);
    setActiveWorkspacePane(pane);
    setCollapsed(false);
  }, []);

  const renderWorkspacePage = () => {
    if (activeWorkspacePane === 'zizi-plugin') {
      return <ZiziPluginPage onNavigate={handleSelectWorkspacePane} />;
    }
    if (activeWorkspacePane === 'workspace') {
      return <WorkspaceDashboard onNavigate={handleSelectWorkspacePane} />;
    }
    if (activeWorkspacePane === 'dola-login') {
      return <LocalManagerModal embedded view="dola" open onClose={() => handleSelectWorkspacePane('workspace')} />;
    }
    if (activeWorkspacePane === 'doubao-login') {
      return <LocalManagerModal embedded view="doubao" open onClose={() => handleSelectWorkspacePane('workspace')} />;
    }
    if (activeWorkspacePane === 'local-manager') {
      return <LocalManagerModal embedded view="routing" open onClose={() => handleSelectWorkspacePane('workspace')} />;
    }
    if (activeWorkspacePane === 'artifacts') {
      return <ArtifactCenterModal embedded open onClose={() => handleSelectWorkspacePane('workspace')} />;
    }
    if (activeWorkspacePane === 'logs') {
      return <LogCenterModal embedded open onClose={() => handleSelectWorkspacePane('workspace')} />;
    }
    if (activeWorkspacePane === 'tutorial') {
      return <EmbeddedResourcePage onClose={() => handleSelectWorkspacePane('workspace')} />;
    }
    if (activeWorkspacePane === 'personal-center') {
      return authSnapshot.authenticated ? <YuyanAccountPage /> : <PairingGatePage initialError={authSnapshot.error} />;
    }
    if (activeWorkspacePane === 'account-purchase') {
      return authSnapshot.authenticated ? <YuyanAccountPage /> : <PairingGatePage initialError={authSnapshot.error} />;
    }
    if (activeWorkspacePane === 'settings') {
      return <SettingsModal embedded open onClose={() => handleSelectWorkspacePane('workspace')} />;
    }
    return null;
  };

  const isListPane = activeWorkspacePane === 'accounts' || activeWorkspacePane === 'tasks';
  const isFullPagePane = !isListPane;
  const shouldShowBrowser = isListPane;
  const sidebarView = activeWorkspacePane === 'tasks' ? 'tasks' : 'accounts';

  useEffect(() => {
    const accountChanged = previousAccountIdRef.current !== activeAccountId;
    previousAccountIdRef.current = activeAccountId;
    if (overlaySidebar && accountChanged) setCollapsed(true);
  }, [activeAccountId, overlaySidebar]);

  useEffect(() => {
    const handleWindowResize = (): void => {
      setOverlaySidebar(shouldOverlaySidebar(window.innerWidth));
      setSidebarWidth((currentWidth) => clampSidebarWidth(
        currentWidth,
        MIN_SIDEBAR_WIDTH,
        getCurrentSidebarMaxWidth(),
      ));
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  // ---- 分隔线拖拽 ----

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (shouldOverlaySidebar(window.innerWidth)) return;
    e.preventDefault();
    setIsSidebarResizing(true);
    dragRef.current = { startX: e.clientX, startWidth: sidebarWidth, pendingWidth: sidebarWidth, frameId: null };

    const handleMouseMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.pendingWidth = clampSidebarWidth(
        drag.startWidth + ev.clientX - drag.startX,
        MIN_SIDEBAR_WIDTH,
        getCurrentSidebarMaxWidth(),
      );
      if (drag.frameId !== null) return;
      drag.frameId = requestAnimationFrame(() => {
        const current = dragRef.current;
        if (!current) return;
        current.frameId = null;
        // 拖动中只移动轻量预览线，避免每帧重排右侧所有常驻 webview。
        if (resizerRef.current) {
          resizerRef.current.style.transform = `translate3d(${current.pendingWidth - current.startWidth}px, 0, 0)`;
        }
      });
    };

    const handleMouseUp = () => {
      const drag = dragRef.current;
      if (drag?.frameId !== null && drag?.frameId !== undefined) cancelAnimationFrame(drag.frameId);
      if (drag) {
        const finalWidth = clampSidebarWidth(drag.pendingWidth, MIN_SIDEBAR_WIDTH, getCurrentSidebarMaxWidth());
        if (sidebarRef.current) sidebarRef.current.style.width = `${finalWidth}px`;
        if (resizerRef.current) resizerRef.current.style.transform = '';
        setSidebarWidth(finalWidth);
      }
      dragRef.current = null;
      setIsSidebarResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [sidebarWidth]);

  // ==================== 渲染 ====================

  if (!authReady) return <StartupSplash visible phase="正在验证屿砚会员" />;
  if (!authSnapshot.authenticated && !localViewAllowed) {
    return <div className="app-root studio-ui"><PairingGatePage initialError={authSnapshot.error} onViewLocal={() => setLocalViewAllowed(true)} /></div>;
  }

  return (
    <div className="app-root studio-ui">
      {!authSnapshot.authenticated && <Alert banner type="warning" showIcon role="status"
        message="当前仅可查看本地作品，生成需要有效的屿砚会员"
        action={<Button size="small" onClick={() => handleSelectWorkspacePane('personal-center')}>登录 / 续费</Button>} />}
      {/* 顶部工具栏 */}
      <Toolbar
        onToggleSidebar={handleToggleCollapse}
        sidebarCollapsed={collapsed}
        onOpenWorkspacePane={handleSelectWorkspacePane}
      />

      {/* 主体区域 */}
      <div
        className={`app-body${overlaySidebar && isListPane ? ' has-overlay-sidebar' : ''}`}
        style={{ '--browser-pane-min-width': `${MIN_BROWSER_PANE_WIDTH}px` } as React.CSSProperties}
      >
        {isSidebarResizing && <div className="resize-capture-overlay resize-capture-overlay-col" />}
        <WorkspaceRail activePane={activeWorkspacePane} onSelectPane={handleSelectWorkspacePane} profile={authSnapshot.profile} />
        {/* 左侧面板 */}
        <div
          ref={sidebarRef}
          className={`app-sidebar ${collapsed || isFullPagePane ? 'collapsed' : ''}`}
          aria-hidden={isFullPagePane}
          style={{ width: collapsed || isFullPagePane ? 0 : sidebarWidth }}
        >
          {!collapsed && !isFullPagePane && <Sidebar view={sidebarView} />}
        </div>

        {/* 分隔线 */}
        {!collapsed && !isFullPagePane && !overlaySidebar && (
          <div
            ref={resizerRef}
            className="app-resizer"
            onMouseDown={handleMouseDown}
          >
            <div className="resizer-handle" />
          </div>
        )}

        {/* 右侧浏览器 */}
        <main className={`app-browser workspace-content-stack route-${activeWorkspacePane} ${isFullPagePane ? 'is-full-page' : 'is-list-page'}`}>
          {canvasOpened ? <div
            className={`workspace-page-layer ${activeWorkspacePane === 'canvas' ? 'is-visible' : 'is-hidden'}`}
            aria-hidden={activeWorkspacePane !== 'canvas'}
            ref={(element): void => { if (element) element.inert = activeWorkspacePane !== 'canvas'; }}
          >
            <WorkbenchCanvas />
          </div> : null}
          {storyboardOpened ? <div
            className={`workspace-page-layer ${activeWorkspacePane === 'storyboard-batch' ? 'is-visible' : 'is-hidden'}`}
            aria-hidden={activeWorkspacePane !== 'storyboard-batch'}
            ref={(element): void => { if (element) element.inert = activeWorkspacePane !== 'storyboard-batch'; }}
          ><StoryboardBatchPage active={activeWorkspacePane === 'storyboard-batch'} onNavigate={handleSelectWorkspacePane} /></div> : null}
          <div className={`workspace-page-layer ${!isListPane && activeWorkspacePane !== 'canvas' && activeWorkspacePane !== 'storyboard-batch' ? 'is-visible' : 'is-hidden'}`}>
            {renderWorkspacePage()}
          </div>
          <div
            className={`persistent-browser-layer ${shouldShowBrowser ? 'is-visible' : 'is-hidden'}`}
            aria-hidden={!shouldShowBrowser}
          >
            <BrowserPanel
              accounts={accounts}
              activeAccount={activeAccount}
              refreshKey={0}
            />
          </div>
        </main>
      </div>
      <StartupSplash visible={startupVisible} phase={startupPhase} />
    </div>
  );
};

export default App;
