import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_RELEASE_NOTES, SoftwareUpdater, UPDATE_USER_INSTRUCTIONS, describeUpdateTaskBlocker, type UpdateDriver } from '../../main/services/softwareUpdater';

class Driver extends EventEmitter implements UpdateDriver {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  allowPrerelease = true;
  checkForUpdates = vi.fn(async (): Promise<void> => { this.emit('update-available', { version: '2.4.5' }); });
  downloadUpdate = vi.fn(async (): Promise<void> => {
    this.emit('download-progress', { percent: 49.9 });
    this.emit('update-downloaded', { version: '2.4.5' });
  });
  quitAndInstall = vi.fn();
}

function setup(blocker: () => string | null = (): null => null): { driver: Driver; service: SoftwareUpdater; prepare: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> } {
  const driver = new Driver();
  const prepare = vi.fn();
  const notify = vi.fn();
  const service = new SoftwareUpdater({ driver, currentVersion: '2.4.0', supported: true, notify, prepareInstall: prepare, getInstallBlocker: blocker, checkTimeoutMs: 100 });
  return { driver, service, prepare, notify };
}

afterEach((): void => { vi.useRealTimers(); });
describe('更新前跨项目任务提示', (): void => {
  it('当前项目为空时仍保护其他项目排队，并指出可以操作的项目', (): void => {
    const message = describeUpdateTaskBlocker([{ status: 'queued', projectId: 'project-123' }], [{ id: 'project-123', name: '123' }]);
    expect(message).toContain('123：1 个');
    expect(message).toContain('切换到对应项目');
  });
  it('历史排队暂停后允许安装，已结束的任务不会阻拦', (): void => {
    expect(describeUpdateTaskBlocker([{ status: 'paused' }, { status: 'done' }, { status: 'fail' }, { status: 'cancelled' }], [])).toBeNull();
  });
  it('继续保护等待核验的任务，并兼容无项目的旧记录', (): void => {
    expect(describeUpdateTaskBlocker([{ status: 'waiting_verification' }, { status: 'generating' }], [])).toContain('默认项目：2 个');
  });
});
describe('工作台在线更新', (): void => {
  it('下载并校验成功后仅提示，不自行安装或退出', async (): Promise<void> => {
    const { service, driver, notify } = setup();
    expect((await service.check()).success).toBe(true);
    expect(service.getState()).toMatchObject({
      phase: 'ready', progress: 100, latestVersion: '2.4.5',
      releaseNotes: CURRENT_RELEASE_NOTES,
      userInstructions: UPDATE_USER_INSTRUCTIONS,
    });
    expect(notify.mock.calls.some(([state]) => state.phase === 'downloading' && state.progress === 50)).toBe(true);
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    expect(driver.autoInstallOnAppQuit).toBe(false);
    expect(driver.allowDowngrade).toBe(false);
    expect(driver.allowPrerelease).toBe(false);
    service.dispose();
  });
  it('运行中阻止安装，任务结束后再次检查并允许安装', async (): Promise<void> => {
    let busy = true;
    const { service, driver, prepare } = setup((): string | null => busy ? '有任务执行中' : null);
    await service.check();
    expect(service.install()).toMatchObject({ success: false, error: '有任务执行中' });
    expect(prepare).not.toHaveBeenCalled();
    busy = false;
    expect(service.install().success).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(driver.quitAndInstall).toHaveBeenCalledWith(false, true);
    service.dispose();
  });
  it('文件校验错误时不显示安装成功，可以重试', async (): Promise<void> => {
    const { service, driver } = setup();
    driver.downloadUpdate.mockRejectedValueOnce(new Error('sha512 mismatch'));
    expect((await service.check()).success).toBe(false);
    expect(service.getState().phase).toBe('error');
    expect(service.install().success).toBe(false);
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    expect((await service.check()).success).toBe(true);
    service.dispose();
  });
  it('重复点击合并为一次检查和一次下载', async (): Promise<void> => {
    const { service, driver } = setup();
    await Promise.all([service.check(), service.check(), service.download()]);
    expect(driver.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(driver.downloadUpdate).toHaveBeenCalledTimes(1);
    service.dispose();
  });
  it('网络检查超时可结束并显示重试，而不是永久转圈', async (): Promise<void> => {
    vi.useFakeTimers();
    const { service, driver } = setup();
    driver.checkForUpdates.mockImplementationOnce((): Promise<void> => new Promise((): void => undefined));
    const pending = service.check();
    await vi.advanceTimersByTimeAsync(101);
    expect((await pending).success).toBe(false);
    expect(service.getState().message).not.toContain('Error');
    service.dispose();
  });
  it('当前版本不下载，定时器随退出清理', async (): Promise<void> => {
    vi.useFakeTimers();
    const { service, driver } = setup();
    driver.checkForUpdates.mockImplementation(async (): Promise<void> => { driver.emit('update-not-available'); });
    service.start();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(service.getState().phase).toBe('latest');
    expect(driver.downloadUpdate).not.toHaveBeenCalled();
    service.dispose();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(driver.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(driver.listenerCount('update-downloaded')).toBe(0);
  });
});
