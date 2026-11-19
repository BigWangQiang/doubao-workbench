import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  app: { isPackaged: false, getAppPath: vi.fn(), getPath: vi.fn(), getVersion: () => '3.0.1' },
  save: vi.fn(), reveal: vi.fn(),
}));
vi.mock('electron', () => ({ app: mocks.app, BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showSaveDialog: mocks.save }, shell: { showItemInFolder: mocks.reveal } }));
vi.mock('../../main/security/trustedIpc', () => ({ ipcMain: {
  handle: (channel: string, handler: (...args: any[]) => unknown): void => { mocks.handlers.set(channel, handler); },
  removeHandler: (channel: string): void => { mocks.handlers.delete(channel); },
} }));
import { registerZiziPluginIPC } from '../../main/ipc/ziziPlugin';

describe('字字动画内置插件包', () => {
  let root: string;
  let dispose: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'lalor-zizi-test-'));
    mocks.app.getAppPath.mockReturnValue(root);
    mocks.app.getPath.mockReturnValue(root);
    const dir = join(root, 'integrations/zizi-workbench');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Lalor-Zizi-Plugins-2.1.1.zip'), 'reviewed-plugin-bytes');
    dispose = registerZiziPluginIPC(() => 'ready');
  });
  afterEach(() => { dispose(); rmSync(root, { recursive: true, force: true }); });

  it('返回脱敏服务状态，不暴露令牌或内部路径', async () => {
    const result = await mocks.handlers.get('ziziPlugin:status')!();
    expect(result).toEqual({ appVersion: '3.0.1', pluginVersion: '2.1.1', connection: 'ready', packageAvailable: true });
  });
  it('只将内置插件保存到用户确认的位置', async () => {
    const destination = join(root, 'selected.zip');
    mocks.save.mockResolvedValue({ canceled: false, filePath: destination });
    const result = await mocks.handlers.get('ziziPlugin:savePackage')!({ sender: {} }, 'untrusted-path');
    expect(result).toEqual({ saved: true, filePath: destination });
    expect(readFileSync(destination, 'utf8')).toBe('reviewed-plugin-bytes');
    expect(mocks.reveal).toHaveBeenCalledWith(destination);
  });
  it('用户取消时不报保存成功', async () => {
    mocks.save.mockResolvedValue({ canceled: true });
    expect(await mocks.handlers.get('ziziPlugin:savePackage')!({ sender: {} })).toEqual({ saved: false });
    expect(mocks.reveal).not.toHaveBeenCalled();
  });
  it('缺失插件包时明确失败，不让用户保存空包', async () => {
    rmSync(join(root, 'integrations'), { recursive: true });
    expect(await mocks.handlers.get('ziziPlugin:savePackage')!({ sender: {} })).toMatchObject({ saved: false, error: expect.any(String) });
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
