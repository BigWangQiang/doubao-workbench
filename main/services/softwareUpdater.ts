import type { SoftwareUpdateState, SoftwareUpdateResult, Task, Project } from '@doubao-studio/contracts';
import type { AppUpdaterEvents as UpdateEvents } from 'electron-updater/out/AppUpdater';

// 更新地址只由发行配置决定，网页、账号和 IPC 参数不能切换安装来源。
export const UPDATE_FEED_URL = 'https://yuyan-ai.site/desktop-updates/win-x64/';
export const WORKBENCH_DOWNLOAD_URL = 'https://yuyan-ai.site/connections/desktop';
export const UPDATE_USER_INSTRUCTIONS = '更新会保留账号、登录信息、任务记录和产物。请先完成或暂停正在执行的任务，下载完成后点击“重启并安装”；安装过程中不要强制结束工作台。';
export const CURRENT_RELEASE_NOTES = '后台最小化后仍可继续任务执行、控件轮询和产物回传；账号绑定显示窗口名称，便于区分 Dola 1 等窗口；豆包会话变化后支持人工回复确认并继续等待视频生成。提交任务未产生平台发送副作用时，自动切换到同平台可用账号并重新排队；发送按钮未就绪与点击结果不确定分开处理，避免无效任务卡死，同时保留不确定提交的人工核对保护；视频等待产物上限 60 分钟，Dola 会话加载与已验收的无水印提取路径保持不变。';

/** electron-updater 可能返回纯文本，也可能返回按版本拆分的 releaseNotes 数组。 */
export function normalizeReleaseNotes(value: unknown): string {
  if (typeof value === 'string') return value.trim().slice(0, 4000);
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      return typeof record.note === 'string' ? record.note.trim() : '';
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}

export function releaseNotesForVersion(version: string): string {
  return version === '2.4.9' || version === '2.4.8' || version === '2.4.7' || version === '2.4.5' ? CURRENT_RELEASE_NOTES : '';
}

export function describeUpdateTaskBlocker(
  tasks: ReadonlyArray<Pick<Task, 'status' | 'projectId'>>,
  projects: ReadonlyArray<Pick<Project, 'id' | 'name'>>,
): string | null {
  const pending = tasks.filter((task) => !['paused', 'done', 'fail', 'cancelled'].includes(task.status));
  if (!pending.length) return null;
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const counts = new Map<string, number>();
  for (const task of pending) {
    const id = task.projectId || 'default-project';
    const name = names.get(id) || (id === 'default-project' ? '默认项目' : `历史项目 ${id}`);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const detail = [...counts].map(([name, count]) => `${name}：${count} 个`).join('；');
  return `还有 ${pending.length} 个排队或执行中的任务（${detail}）。请在左上角切换到对应项目，在任务队列中完成或暂停后再安装。`;
}

export interface UpdateDriver {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  on<E extends keyof UpdateEvents>(event: E, listener: UpdateEvents[E]): unknown;
  removeListener<E extends keyof UpdateEvents>(event: E, listener: UpdateEvents[E]): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface SoftwareUpdaterOptions {
  driver: UpdateDriver;
  currentVersion: string;
  supported: boolean;
  notify: (state: SoftwareUpdateState) => void;
  // 主进程读取真实任务和回传状态，不能依赖渲染进程传来的 busy 布尔值。
  getInstallBlocker: () => string | null;
  prepareInstall: () => void;
  resumeAfterInstallFailure?: () => void;
  checkTimeoutMs?: number;
}

export class SoftwareUpdater {
  private state: SoftwareUpdateState;
  private operation: Promise<SoftwareUpdateResult> | null = null;
  private startTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private removeListeners: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly options: SoftwareUpdaterOptions) {
    this.state = {
      phase: options.supported ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
      progress: 0,
      message: options.supported ? '启动后自动检查更新，也可以手动检查。' : '开发模式不安装更新，请使用正式安装版。',
      userInstructions: UPDATE_USER_INSTRUCTIONS,
    };
    const driver = options.driver;
    driver.autoDownload = false;
    // 下载完成和正常关闭软件都不能擅自安装，必须显式点击“重启并安装”。
    driver.autoInstallOnAppQuit = false;
    driver.allowDowngrade = false;
    driver.allowPrerelease = false;
    this.listen('update-available', (info: { version: string; releaseNotes?: unknown }): void => {
      const releaseNotes = normalizeReleaseNotes(info.releaseNotes) || releaseNotesForVersion(info.version);
      this.set({ phase: 'available', latestVersion: info.version, progress: 0, message: `发现新版本 ${info.version}`, releaseNotes });
    });
    this.listen('update-not-available', (): void => {
      this.set({ phase: 'latest', latestVersion: undefined, progress: 0, message: '当前已是最新版本。', releaseNotes: undefined });
    });
    this.listen('download-progress', (info: { percent: number }): void => {
      this.set({ phase: 'downloading', progress: Math.max(0, Math.min(100, Math.round(info.percent))), message: '正在后台下载更新，可以继续使用工作台。' });
    });
    this.listen('update-downloaded', (info: { version: string; releaseNotes?: unknown }): void => {
      const releaseNotes = normalizeReleaseNotes(info.releaseNotes) || this.state.releaseNotes || releaseNotesForVersion(info.version);
      this.set({ phase: 'ready', latestVersion: info.version, progress: 100, message: '更新已下载，任务结束后可重启安装。', releaseNotes });
    });
    this.listen('error', (): void => {
      if (this.state.phase === 'installing') this.options.resumeAfterInstallFailure?.();
      this.fail();
    });
  }

  private listen<E extends keyof UpdateEvents>(event: E, listener: UpdateEvents[E]): void {
    this.options.driver.on(event, listener);
    this.removeListeners.push((): void => { this.options.driver.removeListener(event, listener); });
  }

  private set(patch: Partial<SoftwareUpdateState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.options.notify(this.getState());
  }

  private fail(): void {
    this.set({ phase: 'error', progress: 0, message: '更新连接或文件校验失败，请检查网络后重试。当前版本可以继续使用。' });
  }

  getState(): SoftwareUpdateState { return { ...this.state }; }

  start(): void {
    if (!this.options.supported || this.startTimer || this.pollTimer) return;
    this.startTimer = setTimeout((): void => { void this.check(); }, 10_000);
    this.pollTimer = setInterval((): void => { void this.check(); }, 6 * 60 * 60 * 1000);
    this.startTimer.unref();
    this.pollTimer.unref();
  }

  check(): Promise<SoftwareUpdateResult> {
    if (this.operation) return this.operation;
    if (['unsupported', 'ready', 'installing'].includes(this.state.phase)) return Promise.resolve(this.result());
    this.operation = this.performCheck().finally((): void => { this.operation = null; });
    return this.operation;
  }

  private async performCheck(): Promise<SoftwareUpdateResult> {
    this.set({ phase: 'checking', message: '正在检查更新…', checkedAt: new Date().toISOString() });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.options.driver.checkForUpdates(),
        new Promise<never>((_resolve, reject): void => {
          timer = setTimeout((): void => reject(new Error('update_check_timeout')), this.options.checkTimeoutMs ?? 30_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (this.state.phase === 'available') return await this.performDownload();
      // 官方更新器在无安装配置时可能返回 null；不能一直停留在 checking。
      if (this.state.phase === 'checking') this.fail();
    } catch { this.fail(); }
    finally { if (timer) clearTimeout(timer); }
    return this.result();
  }

  download(): Promise<SoftwareUpdateResult> {
    if (this.operation) return this.operation;
    if (!this.state.latestVersion || this.state.phase === 'latest') return this.check();
    if (['unsupported', 'ready', 'installing'].includes(this.state.phase)) return Promise.resolve(this.result());
    this.operation = this.performDownload().finally((): void => { this.operation = null; });
    return this.operation;
  }

  private async performDownload(): Promise<SoftwareUpdateResult> {
    this.set({ phase: 'downloading', progress: 0, message: '正在后台下载更新，可以继续使用工作台。' });
    try {
      await this.options.driver.downloadUpdate();
      if (this.state.phase === 'downloading') this.fail();
    } catch { this.fail(); }
    return this.result();
  }

  install(): SoftwareUpdateResult {
    if (this.state.phase !== 'ready') return { success: false, state: this.getState(), error: '请等待更新下载并校验完成。' };
    try {
      const blocker = this.options.getInstallBlocker();
      if (blocker) return { success: false, state: this.getState(), error: blocker };
      // 同一主进程事件循环内停止领取新任务，再退出，避免检查后又领到任务。
      this.options.prepareInstall();
      this.set({ phase: 'installing', message: '正在重启并安装更新…' });
      this.options.driver.quitAndInstall(false, true);
      return this.result();
    } catch {
      this.options.resumeAfterInstallFailure?.();
      this.set({ phase: 'ready', message: '未能启动安装，请重试或下载正式安装包。' });
      return { success: false, state: this.getState(), error: this.state.message };
    }
  }

  private result(): SoftwareUpdateResult {
    const success = !['error', 'unsupported'].includes(this.state.phase);
    return { success, state: this.getState(), ...(success ? {} : { error: this.state.message }) };
  }

  dispose(): void {
    this.disposed = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const remove of this.removeListeners) remove();
    this.removeListeners = [];
  }
}
