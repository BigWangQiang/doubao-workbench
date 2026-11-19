import { app, BrowserWindow, dialog, shell } from 'electron';
import { copyFile, stat } from 'fs/promises';
import * as path from 'path';
import type { ZiziConnectionState, ZiziPluginSaveResult, ZiziPluginStatus } from '@doubao-studio/contracts';
import { ipcMain } from '../security/trustedIpc';
import { replaceIpcHandlers } from './lifecycle';

const PLUGIN_VERSION = '2.1.1';
const PACKAGE_NAME = `Lalor-Zizi-Plugins-${PLUGIN_VERSION}.zip`;

function packagePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'plugins', PACKAGE_NAME)
    : path.join(app.getAppPath(), 'integrations', 'zizi-workbench', PACKAGE_NAME);
}

async function packageAvailable(): Promise<boolean> {
  try {
    const info = await stat(packagePath());
    return info.isFile() && info.size > 0;
  } catch { return false; }
}

export function registerZiziPluginIPC(connection: () => ZiziConnectionState): () => void {
  const dispose = replaceIpcHandlers(ipcMain, ['ziziPlugin:status', 'ziziPlugin:savePackage']);
  ipcMain.handle('ziziPlugin:status', async (): Promise<ZiziPluginStatus> => ({
    appVersion: app.getVersion(), pluginVersion: PLUGIN_VERSION,
    connection: connection(), packageAvailable: await packageAvailable(),
  }));
  ipcMain.handle('ziziPlugin:savePackage', async (event): Promise<ZiziPluginSaveResult> => {
    if (!await packageAvailable()) return { saved: false, error: '内置插件包缺失，请重新安装最新版工作台。' };
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return { saved: false, error: '请从工作台主窗口保存插件。' };
    const selected = await dialog.showSaveDialog(owner, {
      title: '保存字字动画插件包',
      defaultPath: path.join(app.getPath('downloads'), PACKAGE_NAME),
      filters: [{ name: 'ZIP 插件包', extensions: ['zip'] }],
    });
    if (selected.canceled || !selected.filePath) return { saved: false };
    try {
      // 来源固定为随软件发布的插件，不接受网页传入文件路径或远程下载地址。
      await copyFile(packagePath(), selected.filePath);
      shell.showItemInFolder(selected.filePath);
      return { saved: true, filePath: selected.filePath };
    } catch { return { saved: false, error: '插件包保存失败，请检查目录权限和磁盘空间后重试。' }; }
  });
  return dispose;
}
